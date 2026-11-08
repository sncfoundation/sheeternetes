#!/usr/bin/env node
// The scheduler exists twice: as a Google Sheets formula (installed into the Pods
// tab's `chosen` column) and as Apps Script (scheduleScript). This test checks that
//
//   1. both agree with the reference schedule() of sheeternetes-onprem on every
//      scheduling case of its tests/test_scheduler.py (expected placements below
//      were produced by running that Python function);
//   2. both agree with each other on 2,000 random clusters;
//   3. the control loop really installs the formula, one per Pods row.
//
// The formula side is hack/formula-port.js, a line-by-line port of the formula.
// How to check the formula itself in a real Google Sheet: see README, "Scheduler".
//
//   node hack/test-formula-scheduler.js
'use strict';
const { loadControlPlane } = require('./sheet-mock');
const { formulaChosen } = require('./formula-port');

const api = loadControlPlane({ exports: ['orderForScheduling'] });
api.ensureTabs();

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, '->', JSON.stringify(d)); } };

const node = (name, o) => Object.assign({ name, cpu_total: 4000, mem_total: 8192, status: 'Ready', schedulable: '', labels: '', taints: '' }, o || {});
const pods = (dep, replicas, o, existing) => Array.from({ length: replicas }, (_, i) => {
  const name = `${dep}-${i + 1}`;
  const prev = (existing || {})[name] || '';
  return Object.assign({ name, deployment: dep, node: prev, phase: prev ? 'Running' : 'Pending',
    cpu_req: 100, mem_req: 64, node_selector: '', tolerations: '' }, o || {});
});

// [name, pods, nodes, expected placement from onprem schedule()]
const CASES = [
  ['spread', pods('web', 4), [node('a'), node('b')], { 'web-1': 'a', 'web-2': 'b', 'web-3': 'a', 'web-4': 'b' }],
  ['sticky', pods('web', 2, {}, { 'web-1': 'b', 'web-2': 'a' }), [node('a'), node('b')], { 'web-1': 'b', 'web-2': 'a' }],
  ['failover', pods('web', 2, {}, { 'web-1': 'a', 'web-2': 'a' }), [node('a', { status: 'NotReady' }), node('b')], { 'web-1': 'b', 'web-2': 'b' }],
  ['too-big', pods('hog', 1, { cpu_req: 9000 }), [node('a')], { 'hog-1': '' }],
  ['capacity', pods('svc', 4, { cpu_req: 2000 }), [node('a'), node('b', { cpu_total: 2000 })], { 'svc-1': 'a', 'svc-2': 'a', 'svc-3': 'b', 'svc-4': '' }],
  ['memory', pods('mem', 2, { mem_req: 6000 }), [node('a')], { 'mem-1': 'a', 'mem-2': '' }],
  ['cordon', pods('web', 2, {}, { 'web-1': 'a' }), [node('a', { schedulable: false }), node('b')], { 'web-1': 'a', 'web-2': 'b' }],
  ['all-cordoned', pods('web', 1), [node('a', { schedulable: false })], { 'web-1': '' }],
  ['selector-pins', pods('gpu-job', 2, { node_selector: 'disk=ssd' }), [node('a', { labels: 'disk=ssd' }), node('b', { labels: 'disk=hdd' })], { 'gpu-job-1': 'a', 'gpu-job-2': 'a' }],
  ['selector-no-match', pods('x', 1, { node_selector: 'zone=eu' }), [node('a', { labels: 'zone=us' })], { 'x-1': '' }],
  ['taint-repels', pods('web', 1), [node('a', { taints: 'gpu=true:NoSchedule' }), node('b')], { 'web-1': 'b' }],
  ['toleration', pods('ml', 1, { tolerations: 'gpu=true' }), [node('a', { taints: 'gpu=true:NoSchedule' })], { 'ml-1': 'a' }],
  ['affinity-beats-sticky', pods('web', 1, { node_selector: 'disk=ssd' }, { 'web-1': 'a' }), [node('a', { labels: 'disk=hdd' }), node('b', { labels: 'disk=ssd' })], { 'web-1': 'b' }],
];

const asMap = (rows, chosen) => { const m = {}; rows.forEach((p, i) => { m[p.name] = chosen[i]; }); return m; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('\n== reference cases (onprem tests/test_scheduler.py) ==');
CASES.forEach(([name, ps, ns, want]) => {
  const rows = api.orderForScheduling(ps);
  const script = asMap(rows, Array.from(api.scheduleScript(rows, ns)));
  const formula = asMap(rows, formulaChosen(rows, ns));
  check(`${name}: script == onprem schedule()`, same(script, want), { script, want });
  check(`${name}: formula == onprem schedule()`, same(formula, want), { formula, want });
});

// Two scenarios whose `chosen` column was computed by Google Sheets itself (the
// formula from schedulerFormula() pasted into a scratch spreadsheet, 2026-11-08).
// The port must reproduce what the real Sheet returned, cell for cell.
const REAL_SHEET = [
  ['rich: sticky, multi-selector, multi-taint, PreferNoSchedule, NotReady, cordon, memory, Terminating', [
    { name: 'w1', node: 'n1', phase: 'Running', cpu_req: 300, mem_req: 64 },
    { name: 'w2', node: '', phase: 'Pending', cpu_req: 300, mem_req: 64 },
    { name: 'db1', node: '', phase: 'Pending', cpu_req: 500, mem_req: 256, node_selector: 'disk=ssd, zone=eu' },
    { name: 'ml1', node: '', phase: 'Pending', cpu_req: 800, mem_req: 256, tolerations: 'gpu' },
    { name: 'ml2', node: '', phase: 'Pending', cpu_req: 800, mem_req: 256, node_selector: 'disk=ssd', tolerations: 'gpu=true,spot' },
    { name: 'b1', node: '', phase: 'Pending', cpu_req: 1200, mem_req: 128 },
    { name: 'b2', node: '', phase: 'Pending', cpu_req: 1200, mem_req: 128 },
    { name: 'b3', node: '', phase: 'Pending', cpu_req: 1200, mem_req: 128 },
    { name: 'huge', node: '', phase: 'Pending', cpu_req: 100, mem_req: 99999 },
    { name: 'old', node: 'n1', phase: 'Terminating', cpu_req: 3000, mem_req: 64 },
  ], [
    node('n1', { labels: 'disk=ssd' }),
    node('n2', { cpu_total: 2000, mem_total: 4096, labels: 'disk=hdd,zone=eu', taints: 'spot=yes:PreferNoSchedule' }),
    node('gpu', { cpu_total: 8000, mem_total: 16384, labels: 'disk=ssd,zone=eu', taints: 'gpu=true:NoSchedule,spot=yes' }),
    node('dead', { cpu_total: 9000, mem_total: 16384, status: 'NotReady' }),
    node('cord', { cpu_total: 9000, mem_total: 16384, schedulable: 'FALSE' }),
  ], ['n1', 'n1', '', 'n1', 'gpu', 'n1', 'n2', 'n1', '', '']],
  ['sticky on cordon, affinity beats sticky, failover, unknown node', [
    { name: 's1', node: 'cord', phase: 'Running', cpu_req: 600, mem_req: 1 },
    { name: 's2', node: 'hd', phase: 'Running', cpu_req: 300, mem_req: 1, node_selector: 'disk=ssd' },
    { name: 's3', node: 'dead', phase: 'Running', cpu_req: 500, mem_req: 1 },
    { name: 'p4', node: '', phase: 'Pending', cpu_req: 500, mem_req: 1 },
    { name: 'g5', node: 'ghost', phase: 'Scheduled', cpu_req: 100, mem_req: 1 },
  ], [
    node('cord', { cpu_total: 1000, mem_total: 1000, schedulable: 'FALSE' }),
    node('hd', { cpu_total: 1000, mem_total: 1000, labels: 'disk=hdd' }),
    node('ssd', { cpu_total: 1000, mem_total: 1000, labels: 'disk=ssd' }),
    node('dead', { cpu_total: 1000, mem_total: 1000, status: 'NotReady' }),
  ], ['cord', 'ssd', 'hd', 'ssd', 'hd']],
];
console.log('\n== scenarios computed by a real Google Sheet ==');
REAL_SHEET.forEach(([name, rows, ns, sheet]) => {
  check(`${name}: port == Google Sheets`, same(formulaChosen(rows, ns), sheet), formulaChosen(rows, ns));
  check(`${name}: script == Google Sheets`, same(Array.from(api.scheduleScript(rows, ns)), sheet), Array.from(api.scheduleScript(rows, ns)));
});

console.log('\n== random clusters: script and formula agree ==');
let seed = 42;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
const pick = (a) => a[rnd(a.length)];
let disagree = null, runs = 0;
for (let t = 0; t < 2000 && !disagree; t++) {
  const ns = Array.from({ length: 1 + rnd(4) }, (_, i) => node('n' + i, {
    cpu_total: pick([500, 1000, 2000, 4000]), mem_total: pick([256, 1024, 4096]),
    status: pick(['Ready', 'Ready', 'Ready', 'NotReady']), schedulable: pick(['', '', true, false, 'FALSE']),
    labels: pick(['', 'disk=ssd', 'disk=hdd', 'disk=ssd,zone=eu', 'zone=us']),
    taints: pick(['', '', 'gpu=true:NoSchedule', 'gpu=true', 'spot=yes:PreferNoSchedule', 'gpu=true:NoSchedule,spot=yes']),
  }));
  const ps = Array.from({ length: 1 + rnd(12) }, (_, i) => ({
    name: 'p' + i, node: pick(['', '', ...ns.map(n => n.name), 'ghost']),
    phase: pick(['Running', 'Pending', 'Scheduled', 'Terminating']),
    cpu_req: pick([50, 100, 300, 1000, 2500]), mem_req: pick([16, 64, 512, 2048]),
    node_selector: pick(['', '', 'disk=ssd', 'zone=eu', 'disk=ssd,zone=eu']),
    tolerations: pick(['', '', 'gpu=true', 'gpu', 'spot=yes']),
  })).map(p => (p.phase === 'Pending' ? Object.assign(p, { node: '' }) : p));
  const rows = api.orderForScheduling(ps);
  const a = Array.from(api.scheduleScript(rows, ns)), b = formulaChosen(rows, ns);
  runs++;
  if (!same(a, b)) disagree = { ns, rows, script: a, formula: b };
}
check(`script == formula on ${runs} random clusters`, !disagree, disagree);

console.log('\n== control loop installs the formula ==');
const TOKEN = 'CHANGE_ME_super_secret';
['a', 'b'].forEach(n => api.doPost({ postData: { contents: JSON.stringify({ token: TOKEN, node: 'node-' + n, ip: '10.0.0.1', cpu_total: 1000, mem_total: 1024, pods: [] }) } }));
api.controlOp({ token: TOKEN, action: 'apply', deployments: [{ name: 'web', image: 'nginx', replicas: 3, cpu_req: 200, mem_req: 64 }] });
const header = api._store.Pods[0];
const col = header.indexOf('chosen') + 1;
const rowsWithFormula = Object.keys(api._formulas.Pods).filter(k => Number(k.split(',')[1]) === col).length;
const live = api.readTab('Pods').length;
check('Pods tab has a `chosen` header after the data columns', col === api.TABS.Pods.length + 1, header);
check('one formula per Pods row', rowsWithFormula === live && live === 3, { rowsWithFormula, live });
const f = api.schedulerFormula();
check('formula reads cpu_req (G) and chosen (O) columns', f.includes('$G$2:INDEX($G:$G,ROW()-1)') && f.includes('$O$2:INDEX($O:$O,ROW()-1)'), f.slice(0, 200));
const ev = api.readTab('Events').map(e => e.message);
check('pods were placed by the formula', ev.filter(m => /\(formula\)$/.test(m)).length === 3, ev);
api.controlOp({ token: TOKEN, action: 'cordon', name: 'node-a' });
api.controlOp({ token: TOKEN, action: 'scale', name: 'web', replicas: 5 });
const placedNew = api.readTab('Pods').filter(p => p.phase !== 'Terminating');
check('cordon: new pods avoid node-a, old ones stay', placedNew.filter(p => p.node === 'node-a').length <= 2 &&
  placedNew.filter(p => p.node === 'node-b').length >= 3, placedNew.map(p => p.node));

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
