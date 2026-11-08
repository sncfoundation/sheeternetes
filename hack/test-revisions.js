#!/usr/bin/env node
// Disaster recovery from Google Sheets version history (#12), on the real Code.gs.
// hack/sheet-mock.js emulates the Drive advanced service: revisions.list/get,
// the .xlsx export link, conversion into a temporary spreadsheet, and trashing it.
//
//   node hack/test-revisions.js
'use strict';
const { loadControlPlane } = require('./sheet-mock');

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, '->', JSON.stringify(d)); } };
const TOKEN = 'CHANGE_ME_super_secret';

let now = Date.parse('2026-11-08T10:00:00Z');
const api = loadControlPlane({ clock: () => new Date(now) });
api.ensureTabs();
const post = (b) => { const out = JSON.parse(api.doPost({ postData: { contents: JSON.stringify(Object.assign({ token: TOKEN }, b)) } })._t); api._saveRevision(); now += 60000; return out; };
const get = (kind) => JSON.parse(api.doGet({ parameter: { token: TOKEN, kind } })._t);
const deps = () => api.readTab('Deployments').map(d => `${d.name}:${d.image}:${d.replicas}`).sort().join(' ');

console.log('\n== build some history ==');
post({ node: 'node-a', ip: '10.0.0.1', cpu_total: 4000, mem_total: 8192, pods: [] });
post({ action: 'apply', deployments: [{ name: 'web', image: 'nginx:1.27', replicas: 3 }, { name: 'db', image: 'postgres:17', replicas: 1 }] });
const goodTime = new Date(now - 30000).toISOString();         // just after the good state was saved
const good = deps();
post({ action: 'apply', deployments: [{ name: 'web', image: 'nginx:oops', replicas: 30 }] });
post({ action: 'delete', name: 'db' });
post({ action: 'apply', deployments: [{ name: 'crypto-miner', image: 'definitely-legit', replicas: 9 }] });
const revs = get('revisions').items;
check('revisions are listed oldest first with ids and times', revs.length >= 5 && revs.every(r => r.id && r.modifiedTime), revs);
check('the cluster is now broken', deps() !== good, deps());

console.log('\n== dry run ==');
const dry = post({ action: 'restore', at: goodTime, dryRun: true });
check('dry run shows the old Deployments without touching them', dry.ok && dry.dryRun && dry.state.Deployments.length === 2 && deps() !== good, dry);

console.log('\n== restore --at ==');
const res = post({ action: 'restore', at: goodTime });
check('restore picks the last revision at or before the time', res.ok && res.revision && Date.parse(res.revision.modifiedTime) <= Date.parse(goodTime), res);
check('Deployments tab is back to the good state', deps() === good, deps());
const live = api.readTab('Pods').filter(p => p.phase !== 'Terminating');
check('reconcile converged pods to the restored spec', live.filter(p => p.deployment === 'web').length === 3 &&
  live.filter(p => p.deployment === 'db').length === 1 && !live.some(p => p.deployment === 'crypto-miner'), live.map(p => p.deployment));
check('no pod runs the bad image', !live.some(p => p.image === 'nginx:oops'), live.map(p => p.image));
check('the temporary converted file was trashed', api._trashed.length === 2, api._trashed);
check('an Event records the restore', api.readTab('Events').some(e => /restored Deployments from revision/.test(e.message)), null);
check('observed state (Nodes) was not rolled back', api.readTab('Nodes').length === 1, api.readTab('Nodes'));

console.log('\n== restore --revision ==');
const first = revs[0].id;  // before any deployment existed
const r2 = post({ action: 'restore', revision: first });
check('restore by revision id', r2.ok && r2.revision.id === first && deps() === '', deps());

console.log('\n== errors ==');
check('unknown revision', /no such revision/.test(post({ action: 'restore', revision: '999' }).error), null);
check('time before history began', /no such revision/.test(post({ action: 'restore', at: '1999-01-01T00:00:00Z' }).error), null);
check('unknown tab', /unknown tab/.test(post({ action: 'restore', revision: first, tabs: ['Secrets'] }).error), null);
const noDrive = loadControlPlane({ noDrive: true });
noDrive.ensureTabs();
const e = JSON.parse(noDrive.doGet({ parameter: { token: TOKEN, kind: 'revisions' } })._t);
check('without the Drive advanced service the error says how to enable it', /enable the Drive advanced service/.test(e.error), e);

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
