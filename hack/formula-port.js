// A line-by-line JavaScript port of the scheduler formula that Code.gs installs into
// the Pods tab (see schedulerFormula() in Code.gs). It exists for two reasons:
//
//  1. hack/sheet-mock.js uses it as the "recalculation engine" for the `chosen`
//     column, so the default `formula` scheduler also runs in Node.
//  2. hack/test-formula-scheduler.js checks that this port and the Apps Script
//     scheduler (scheduleScript) agree on the reference scheduler cases.
//
// Each name below mirrors a LET() binding of the formula, in the same order. It is
// deliberately written the way the Sheet evaluates it — row by row, every row
// looking only at the `chosen` values of the rows above it (the growing SUMIFS) —
// not the way a programmer would write a scheduler.
'use strict';

const S = (v) => (v === undefined || v === null ? '' : String(v));
const N = (v) => { const n = Number(v); return isFinite(n) && S(v) !== '' ? n : 0; };   // N()
const nospace = (v) => S(v).replace(/ /g, '');                                           // SUBSTITUTE(x," ","")
const find = (needle, hay) => hay.indexOf(needle) >= 0;                                  // ISNUMBER(FIND())

// SUMPRODUCT(--ISNUMBER(FIND(","&SPLIT(sel,",")&",", ","&lb&","))) = COUNTA(SPLIT(sel,","))
function selectorOk(sel, labels) {
  if (sel === '') return true;
  const parts = sel.split(',').filter(x => x !== '');                                   // SPLIT drops empties
  const hits = parts.filter(p => find(',' + p + ',', ',' + labels + ',')).length;
  return hits === parts.length;
}

// SUMPRODUCT(eff * notFound(k=v) * notFound(k)) = 0
function taintsOk(taints, tol) {
  if (taints === '') return true;
  const raw = taints.split(',').filter(x => x !== '');
  let untolerated = 0;
  raw.forEach(t => {
    const kv = t.replace(/:.*$/, '');                                                   // REGEXREPLACE(t,":.*$","")
    const key = kv.replace(/=.*$/, '');                                                 // REGEXREPLACE(kv,"=.*$","")
    const eff = (/:/.test(t) ? 0 : 1) + (/:NoSchedule$/.test(t) ? 1 : 0);               // no effect, or NoSchedule
    const nf1 = find(',' + kv + ',', ',' + tol + ',') ? 0 : 1;
    const nf2 = find(',' + key + ',', ',' + tol + ',') ? 0 : 1;
    untolerated += eff * nf1 * nf2;
  });
  return untolerated === 0;
}

const schedulableCell = (v) => ['FALSE', '0', 'NO'].indexOf(S(v).toUpperCase()) < 0;

/**
 * pods:  [{node, phase, cpu_req, mem_req, node_selector, tolerations}] in row order
 * nodes: [{name, cpu_total, mem_total, status, schedulable, labels, taints}] in row order
 * returns the `chosen` column, one value per pod row ('' = Unschedulable / not scheduled).
 */
function formulaChosen(pods, nodes) {
  const live = nodes.filter(n => S(n.name) !== '');                                     // FILTER(..., A<>"")
  if (!live.length) return pods.map(() => '');                                          // IF(COUNTA(...)=0,"",...)
  const nm = live.map(n => S(n.name));
  const xl = (q, field) => S(live[nm.indexOf(q)][field]);                                // XLOOKUP(q,nm,col)
  const chosen = [];
  pods.forEach((row, r) => {
    const ph = S(row.phase);
    const creq = N(row.cpu_req), mreq = N(row.mem_req);
    const sel = nospace(row.node_selector), tol = nospace(row.tolerations);
    const prev = S(row.node);
    const above = chosen.slice(0, r);                                                   // $O$2:INDEX($O:$O,ROW()-1)
    const ucpu = (q) => above.reduce((s, c, i) => s + (c === q ? N(pods[i].cpu_req) : 0), 0);
    const umem = (q) => above.reduce((s, c, i) => s + (c === q ? N(pods[i].mem_req) : 0), 0);
    const fits = (q) => xl(q, 'status') === 'Ready' &&
      selectorOk(sel, nospace(xl(q, 'labels'))) &&
      taintsOk(nospace(xl(q, 'taints')), tol) &&
      N(xl(q, 'cpu_total')) - ucpu(q) >= creq &&
      N(xl(q, 'mem_total')) - umem(q) >= mreq;
    const score = nm.map(q => (fits(q) && schedulableCell(xl(q, 'schedulable')) ? N(xl(q, 'cpu_total')) - ucpu(q) : -1));
    const max = Math.max(...score);
    const best = max < 0 ? '' : nm[score.indexOf(max)];                                 // XLOOKUP(MAX(score),score,nm)
    const pok = prev !== '' && nm.indexOf(prev) >= 0 && fits(prev);                     // sticky: cordon does not evict
    let out;
    if (ph === '' || ph === 'Terminating' || ph === 'Deleted') out = '';
    else out = pok ? prev : best;
    chosen.push(out);
  });
  return chosen;
}

// Recalc hook for hack/sheet-mock.js: fill every formula cell of the Pods tab's
// `chosen` column from the current grids, as Google Sheets would.
function recalcPods(store, podFormulas) {
  const objs = (g) => { const h = g[0]; return g.slice(1).map(r => { const o = {}; h.forEach((k, i) => { o[k] = r[i]; }); return o; }); };
  const pg = store.Pods, ng = store.Nodes;
  if (!pg || !ng) return;
  const col = pg[0].indexOf('chosen');
  if (col < 0) return;
  const rows = objs(pg);
  const vals = formulaChosen(rows, objs(ng));
  rows.forEach((_, i) => {
    if (podFormulas[(i + 2) + ',' + (col + 1)]) { pg[i + 1] = pg[i + 1] || []; pg[i + 1][col] = vals[i]; }
  });
}

// ---- the Autoscale tab (autoscaleFormulas() in Code.gs), row by row --------------
const TOLERANCE = 0.1;
function autoscaleRow(row, pods) {
  const d = S(row.deployment);
  if (d === '') return null;
  const running = pods.filter(p => S(p.deployment) === d && S(p.phase) === 'Running');
  const cur = running.length;                                                              // COUNTIFS
  const rq = running.filter(p => S(p.cpu_usage) !== '').reduce((a, p) => a + N(p.cpu_req), 0);
  const u = rq === 0 ? '' : Math.round(running.reduce((a, p) => a + N(p.cpu_usage), 0) / rq * 100);
  const t = N(row.target_cpu);
  const lo = Math.max(1, N(row.min_replicas));
  const hi = Math.max(lo, S(row.max_replicas) === '' ? lo : N(row.max_replicas));
  const raw = (u === '' || t <= 0 || cur === 0) ? cur : (Math.abs(u / t - 1) <= TOLERANCE ? cur : Math.ceil(cur * u / t));
  const want = Math.min(hi, Math.max(lo, raw));
  const status = u === '' ? 'NoMetrics' : raw > hi ? 'LimitedByMax' : want > cur ? 'ScalingUp' : want < cur ? 'ScalingDown' : 'Stable';
  return { current_replicas: cur, cpu_percent: u, desired_replicas: want, status };
}

// Recalc hook: fill the spilled columns E:H (and their header cells) of the Autoscale tab.
function recalcAutoscale(store, formulas) {
  const ag = store.Autoscale, pg = store.Pods;
  if (!ag || !pg) return;
  const ph = pg[0];
  const pods = pg.slice(1).map(r => { const o = {}; ph.forEach((k, i) => { o[k] = r[i]; }); return o; });
  const cols = ['current_replicas', 'cpu_percent', 'desired_replicas', 'status'];
  const user = ['deployment', 'target_cpu', 'min_replicas', 'max_replicas'];
  cols.forEach((c, i) => { if (formulas['1,' + (5 + i)]) ag[0][4 + i] = c; });
  for (let r = 1; r < ag.length; r++) {
    const row = {}; user.forEach((k, i) => { row[k] = (ag[r] || [])[i]; });
    const out = autoscaleRow(row, pods);
    cols.forEach((c, i) => { if (formulas['1,' + (5 + i)]) ag[r][4 + i] = out ? out[c] : ''; });
  }
}

module.exports = { formulaChosen, recalcPods, recalcAutoscale, autoscaleRow, selectorOk, taintsOk };
