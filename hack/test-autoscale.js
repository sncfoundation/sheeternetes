#!/usr/bin/env node
// HPA via a formula and conditional formatting (#11), on the real Code.gs.
// The Autoscale tab's formula columns are evaluated by hack/formula-port.js
// (the same arithmetic as autoscaleFormulas(); the real-Sheet results for the
// fixture below were checked in Google Sheets).
//
//   node hack/test-autoscale.js
'use strict';
const { loadControlPlane } = require('./sheet-mock');
const { autoscaleRow } = require('./formula-port');

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, '->', JSON.stringify(d)); } };
const TOKEN = 'CHANGE_ME_super_secret';

console.log('\n== formula arithmetic (rows verified in a real Google Sheet, 2026-11-08) ==');
const pods = [];
const add = (dep, n, req, usage, phase) => { for (let i = 0; i < n; i++) pods.push({ deployment: dep, phase: phase || 'Running', cpu_req: req, cpu_usage: usage }); };
add('web', 2, 100, 150); add('web', 1, 100, '', 'Pending'); add('web', 1, 100, 999, 'Terminating');
add('api', 2, 200, 300); add('idle', 4, 100, 10); add('calm', 2, 100, 52); add('nometrics', 1, 100, ''); add('mixed', 1, 300, '');
const SHEET = [   // deployment, target, min, max -> current, cpu%, desired, status  (as computed by Google Sheets)
  ['web', 50, 1, 10, 2, 150, 6, 'ScalingUp'], ['api', 50, 1, 3, 2, 150, 3, 'LimitedByMax'],
  ['idle', 80, 2, 5, 4, 10, 2, 'ScalingDown'], ['calm', 50, 1, 5, 2, 52, 2, 'Stable'],
  ['nometrics', 50, 1, 5, 1, '', 1, 'NoMetrics'], ['new', 50, 2, 4, 0, '', 2, 'NoMetrics'], ['mixed', 50, 1, 5, 1, '', 1, 'NoMetrics'],
];
SHEET.forEach(([d, t, mn, mx, cur, u, want, st]) => {
  const got = autoscaleRow({ deployment: d, target_cpu: t, min_replicas: mn, max_replicas: mx }, pods);
  check(`${d}: ${st}`, got.current_replicas === cur && got.cpu_percent === u && got.desired_replicas === want && got.status === st, got);
});

console.log('\n== the control loop follows desired_replicas ==');
const api = loadControlPlane({ exports: ['autoscaleFormulas', 'AUTOSCALE_COLORS'] });
api.ensureTabs();
const hb = (node, usage) => {
  const mine = api.readTab('Pods').filter(p => p.node === node && (p.phase === 'Scheduled' || p.phase === 'Running'));
  return JSON.parse(api.doPost({ postData: { contents: JSON.stringify({ token: TOKEN, node, ip: '10.0.0.1', cpu_total: 8000, mem_total: 8192,
    pods: mine.map(p => ({ name: p.name, phase: 'Running', container_id: 'c-' + p.name, cpu_usage: usage(p), mem_usage: 20 })) }) } })._t);
};
const ctl = (b) => JSON.parse(api.controlOp(Object.assign({ token: TOKEN }, b))._t);
const replicas = () => Number(api.readTab('Deployments').find(d => d.name === 'burner').replicas);
const hpa = () => api.readTab('Autoscale').find(r => r.deployment === 'burner');

hb('node-a', () => 0);
ctl({ action: 'apply', deployments: [{ name: 'burner', image: 'busybox', replicas: 1, cpu_req: 200, mem_req: 32, command: 'while true; do :; done' }] });
check('autoscale needs a positive target', /target_cpu/.test(ctl({ action: 'autoscale', deployment: 'burner', target_cpu: 0 }).error), null);
check('autoscale needs an existing deployment', /no such deployment/.test(ctl({ action: 'autoscale', deployment: 'nope', target_cpu: 50 }).error), null);
ctl({ action: 'autoscale', deployment: 'burner', target_cpu: 50, min_replicas: 1, max_replicas: 4 });
const header = api._store.Autoscale[0];
check('Autoscale tab: inputs, four formula columns, last_scale', header.join(',') ===
  'deployment,target_cpu,min_replicas,max_replicas,current_replicas,cpu_percent,desired_replicas,status,last_scale', header);
check('formulas live in the header row (E1:H1) and spill down', ['1,5', '1,6', '1,7', '1,8'].every(k => /^=\{"/.test(api._formulas.Autoscale[k] || '')), api._formulas.Autoscale);
check('five conditional-format rules colour the rows by status', (api._cf.Autoscale || []).length === 5 &&
  api._cf.Autoscale.some(r => r._spec.formula === '=$H2="LimitedByMax"' && r._spec.background === '#f4c7c3'), api._cf.Autoscale);

hb('node-a', () => 0);  // Scheduled -> Running, usage not burning yet
check('an idle pod (0% cpu) is Stable at min replicas', hpa().status === 'Stable' && Number(hpa().desired_replicas) === 1, hpa());
// burn: each pod uses its full 200m request = 100% of request, target 50%
for (let i = 0; i < 6; i++) { hb('node-a', () => 200); api.reconcile(); }
check('scaled up to max (4) under load', replicas() === 4, replicas());
check('status LimitedByMax when it would want more than max', hpa().status === 'LimitedByMax', hpa());
check('an Autoscale event explains each change', api.readTab('Events').some(e => e.kind === 'Autoscale' && /-> replicas 1 -> 2/.test(e.message)), api.readTab('Events').filter(e => e.kind === 'Autoscale'));

// load drops to 10% of request
hb('node-a', () => 20); api.reconcile();
check('no scale-down inside the stabilization window', replicas() === 4 && hpa().status === 'ScalingDown', [replicas(), hpa()]);
const ag = api._store.Autoscale; const lsCol = ag[0].indexOf('last_scale');
for (let r = 1; r < ag.length; r++) if (ag[r][0] === 'burner') ag[r][lsCol] = new Date(Date.now() - 10 * 60 * 1000).toISOString();
api.reconcile();
check('scales down to min once the window has passed', replicas() === 1, replicas());

console.log('\n== kubelet usage lands in the Pods tab ==');
const p = api.readTab('Pods').find(x => x.phase === 'Running');
check('cpu_usage and mem_usage columns are filled from heartbeats', p && Number(p.cpu_usage) === 20 && Number(p.mem_usage) === 20, p);
const got = JSON.parse(api.doGet({ parameter: { token: TOKEN, kind: 'hpa' } })._t);
check('GET ?kind=hpa returns the Autoscale tab with computed columns', got.items[0].desired_replicas !== undefined && got.items[0].status, got);

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
