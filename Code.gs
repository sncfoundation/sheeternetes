/**
 * Sheeternetes — a container orchestrator whose control plane is a Google Sheet.
 *
 * This Apps Script IS the kube-apiserver + scheduler + controllers.
 * The Google Sheet IS etcd. kubelet.sh agents on real Docker hosts are the kubelets.
 *
 * Deploy: Extensions -> Apps Script, paste this file, then
 *   1) Run setup() once (creates headers, sample deployment, installs the timer trigger).
 *   2) Deploy -> New deployment -> Web app -> Execute as: Me, Access: Anyone.
 *   3) Copy the Web App URL into kubelet.sh (WEBAPP_URL) and skctl.
 *
 * Protocol (kubelet <-> apiserver), single sync call per heartbeat:
 *   POST body: { token, node, ip, cpu_total, mem_total, pods:[{name,phase,container_id}] }
 *   Response:  { pods:[{name,image,command,cpu_req,mem_req,desired:"Running"|"Terminating"}] }
 */

const TOKEN = 'CHANGE_ME_super_secret';   // must match kubelet.sh / skctl
const HEARTBEAT_TIMEOUT_MS = 90 * 1000;   // node considered NotReady after this

// Who places pods on nodes:
//   'formula' (default) — a Google Sheets formula in the Pods tab's `chosen` column
//                         does the scheduling; Apps Script only reads the result.
//   'script'            — the same algorithm in Apps Script (scheduleScript below).
// If the formula column ever returns an error (#NAME?, #REF!, …) the loop falls back
// to 'script' for that pass and records an Event.
const SCHEDULER = 'formula';

const TABS = {
  Deployments: ['name', 'image', 'replicas', 'cpu_req', 'mem_req', 'command', 'node_selector', 'tolerations'],
  Nodes:       ['name', 'ip', 'cpu_total', 'mem_total', 'cpu_used', 'mem_used', 'status', 'last_heartbeat', 'schedulable', 'labels', 'taints'],
  Pods:        ['name', 'deployment', 'node', 'phase', 'container_id', 'image', 'cpu_req', 'mem_req', 'command', 'node_ip', 'started_at', 'message', 'node_selector', 'tolerations'],
  Events:      ['ts', 'kind', 'object', 'message'],
  Logs:        ['name', 'node', 'updated_at', 'tail'],
};
// A cell holds at most 50,000 characters; keep log tails well below that.
const LOG_TAIL_MAX_CHARS = 20000;
// The scheduler formula lives in the column right after the Pods data columns.
// writeTab() never writes it, so the formulas survive every reconcile.
const CHOSEN_HEADER = 'chosen';
const CHOSEN_COL = TABS.Pods.length + 1;
const DEPLOYMENT_SPEC = ['image', 'replicas', 'cpu_req', 'mem_req', 'command', 'node_selector', 'tolerations'];
const POD_SPEC = ['image', 'command', 'cpu_req', 'mem_req', 'node_selector', 'tolerations'];

// ---------- generic sheet <-> objects ----------
function ss() { return SpreadsheetApp.getActiveSpreadsheet(); }

function readTab(name) {
  const sh = ss().getSheetByName(name);
  if (!sh) return [];                       // a tab added in a newer version; ensureTabs() creates it
  const rng = sh.getDataRange().getValues();
  const header = rng.shift();
  return rng
    .filter(r => String(r[0]).trim() !== '')
    .map(row => {
      const o = {};
      header.forEach((h, i) => { o[h] = row[i]; });
      return o;
    });
}

function writeTab(name, objects) {
  if (!ss().getSheetByName(name)) ensureTabs();
  const sh = ss().getSheetByName(name);
  const header = TABS[name];
  const rows = objects.map(o => header.map(h => (o[h] === undefined || o[h] === null) ? '' : o[h]));
  // clear old body, write new
  const lastRow = sh.getLastRow();
  if (lastRow > 1) sh.getRange(2, 1, lastRow - 1, header.length).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, header.length).setValues(rows);
  if (name === 'Pods') syncChosenColumn(sh, rows.length, lastRow);
}

function event(kind, object, message) {
  const sh = ss().getSheetByName('Events');
  sh.appendRow([new Date().toISOString(), kind, object, message]);
  // keep last ~200 events
  const n = sh.getLastRow();
  if (n > 220) sh.deleteRows(2, n - 200);
}

function shortId() { return Utilities.getUuid().replace(/-/g, '').substring(0, 10); }

// ---------- the scheduler ----------
// One algorithm, two implementations that must agree (hack/test-formula-scheduler.js):
// a Google Sheets formula (schedulerFormula) and plain Apps Script (scheduleScript).
//
// Rows are visited top to bottom. For each live pod:
//   * sticky: it stays on its current node if that node is Ready, still matches its
//     node_selector / tolerations and still has room after the rows above it
//     (a cordoned node keeps its pods — cordon only blocks newcomers);
//   * otherwise it goes to the Ready, schedulable, matching node with the most free
//     CPU that fits both CPU and memory (first node wins a tie);
//   * otherwise it is Unschedulable ('').
// node_selector 'k=v,k2=v2' must be a subset of the node's labels; a node taint
// 'k=v:NoSchedule' (or bare 'k=v') must be tolerated by 'k=v' or 'k' in tolerations.
const UNSCHEDULABLE = 'Unschedulable: no Ready node with enough CPU and memory that matches node_selector/tolerations';

function isLivePod(p) { return p.phase !== 'Terminating' && p.phase !== 'Deleted' && String(p.phase || '') !== ''; }

// placed pods first (they keep their seats), then Pending, then Terminating
function orderForScheduling(pods) {
  const rank = p => (!isLivePod(p) ? 2 : (p.node ? 0 : 1));
  return pods.map((p, i) => [p, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(x => x[0]);
}

function kvList(s) { return String(s === undefined || s === null ? '' : s).split(',').map(x => x.trim()).filter(Boolean); }

function nodeMatches(node, pod) {
  const labels = kvList(node.labels);
  if (!kvList(pod.node_selector).every(sel => labels.indexOf(sel) >= 0)) return false;
  const tol = kvList(pod.tolerations);
  return kvList(node.taints).every(t => {
    const effect = t.indexOf(':') >= 0 ? t.slice(t.indexOf(':') + 1) : 'NoSchedule';
    if (effect !== 'NoSchedule') return true;
    const kv = t.split(':')[0];
    return tol.indexOf(kv) >= 0 || tol.indexOf(kv.split('=')[0]) >= 0;
  });
}

function isSchedulable(node) {
  return ['FALSE', '0', 'NO'].indexOf(String(node.schedulable === undefined ? '' : node.schedulable).toUpperCase()) < 0;
}

// Plain Apps Script implementation. Returns the node per pod row ('' = none).
function scheduleScript(pods, nodes) {
  const ready = nodes.filter(n => String(n.name || '') !== '' && n.status === 'Ready');
  const free = {};
  ready.forEach(n => { free[n.name] = { cpu: Number(n.cpu_total) || 0, mem: Number(n.mem_total) || 0 }; });
  const fits = (n, p) => nodeMatches(n, p) &&
    free[n.name].cpu >= (Number(p.cpu_req) || 0) && free[n.name].mem >= (Number(p.mem_req) || 0);
  const out = pods.map(p => {
    if (!isLivePod(p)) return '';
    let target = '';
    const prev = ready.find(n => n.name === p.node);
    if (prev && fits(prev, p)) {
      target = prev.name;
    } else {
      let bestFree = -1;
      ready.forEach(n => {
        if (isSchedulable(n) && fits(n, p) && free[n.name].cpu > bestFree) { target = n.name; bestFree = free[n.name].cpu; }
      });
    }
    if (target) { free[target].cpu -= Number(p.cpu_req) || 0; free[target].mem -= Number(p.mem_req) || 0; }
    return target;
  });
  out.by = 'script';
  return out;
}

// Formula implementation: write Nodes + Pods, let the Sheet recalculate the
// `chosen` column, read it back. Returns null if any cell is an error.
function formulaSchedule(pods, nodes) {
  writeTab('Nodes', nodes);
  writeTab('Pods', pods);
  SpreadsheetApp.flush();
  const sh = ss().getSheetByName('Pods');
  if (!pods.length) return [];
  const vals = sh.getRange(2, CHOSEN_COL, pods.length, 1).getValues();
  const out = [];
  for (let i = 0; i < pods.length; i++) {
    const v = String(vals[i][0] === undefined || vals[i][0] === null ? '' : vals[i][0]);
    if (v.charAt(0) === '#') return null;          // #NAME?, #REF!, #ERROR!, #N/A …
    if (v && !nodes.some(n => n.name === v)) return null;
    out.push(isLivePod(pods[i]) ? v : '');
  }
  out.by = 'formula';
  return out;
}

// Keep exactly one formula per data row in the `chosen` column.
function syncChosenColumn(sh, rowCount, previousLastRow) {
  if (SCHEDULER === 'formula' && rowCount > 0) {
    sh.getRange(2, CHOSEN_COL, rowCount, 1).setFormula(schedulerFormula());
  }
  const from = (SCHEDULER === 'formula' ? rowCount : 0) + 2;
  if (previousLastRow >= from) sh.getRange(from, CHOSEN_COL, previousLastRow - from + 1, 1).clearContent();
}

function colLetter(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

// The scheduler as ONE spreadsheet formula, identical in every row of the Pods tab
// (row-independent: it finds "its" row with ROW()). Gotchas it avoids:
//   * no spilling arrays — every cell returns a scalar, so nothing can collide;
//   * no array-array arithmetic (Sheets may collapse it) — per-node values are
//     computed inside MAP(LAMBDA) with XLOOKUP;
//   * "rows above" is the growing range $X$2:INDEX($X:$X,ROW()-1), so pasting the
//     same text into every row works without relative-reference adjustment.
function schedulerFormula(nodesSheet) {
  const N = (nodesSheet || 'Nodes') + '!';
  const nc = c => colLetter(TABS.Nodes.indexOf(c) + 1);
  const pc = c => colLetter(TABS.Pods.indexOf(c) + 1);
  const O = colLetter(CHOSEN_COL);
  const nodeCol = c => `FILTER(${N}$${nc(c)}$2:$${nc(c)},${N}$A$2:$A<>"")`;
  const here = c => `INDEX($${pc(c)}:$${pc(c)},ROW())`;
  const usedAbove = c => `IF(ROW()=2,0,SUMIFS($${pc(c)}$2:INDEX($${pc(c)}:$${pc(c)},ROW()-1),$${O}$2:INDEX($${O}:$${O},ROW()-1),q))`;
  return '=IF(COUNTA(' + N + '$A$2:$A)=0,"",LET(' + [
    `nm,${nodeCol('name')}`,
    `ct,${nodeCol('cpu_total')}`,
    `mt,${nodeCol('mem_total')}`,
    `st,${nodeCol('status')}`,
    `sc,${nodeCol('schedulable')}`,
    `lb,${nodeCol('labels')}`,
    `tn,${nodeCol('taints')}`,
    `ph,${here('phase')}`,
    `creq,N(${here('cpu_req')})`,
    `mreq,N(${here('mem_req')})`,
    `sel,SUBSTITUTE(${here('node_selector')}," ","")`,
    `tol,SUBSTITUTE(${here('tolerations')}," ","")`,
    `prev,${here('node')}`,
    `ucpu,LAMBDA(q,${usedAbove('cpu_req')})`,
    `umem,LAMBDA(q,${usedAbove('mem_req')})`,
    // node_selector pairs all present in the node's labels
    'selok,LAMBDA(q,LET(l,SUBSTITUTE(XLOOKUP(q,nm,lb)," ",""),IF(sel="",TRUE,' +
      'SUMPRODUCT(--ISNUMBER(FIND(","&SPLIT(sel,",")&",",","&l&",")))=COUNTA(SPLIT(sel,",")))))',
    // every NoSchedule taint tolerated by "k=v" or "k"
    'tainok,LAMBDA(q,LET(t,SUBSTITUTE(XLOOKUP(q,nm,tn)," ",""),IF(t="",TRUE,' +
      'SUMPRODUCT(ARRAYFORMULA(((1-REGEXMATCH(SPLIT(t,","),":"))+REGEXMATCH(SPLIT(t,","),":NoSchedule$"))' +
      '*ISERROR(FIND(","&REGEXREPLACE(SPLIT(t,","),":.*$","")&",",","&tol&","))' +
      '*ISERROR(FIND(","&REGEXREPLACE(SPLIT(t,","),"[=:].*$","")&",",","&tol&","))))=0)))',
    'fits,LAMBDA(q,AND(XLOOKUP(q,nm,st)="Ready",selok(q),tainok(q),XLOOKUP(q,nm,ct)-ucpu(q)>=creq,XLOOKUP(q,nm,mt)-umem(q)>=mreq))',
    'score,MAP(nm,LAMBDA(q,IF(AND(fits(q),ISERROR(MATCH(UPPER(""&XLOOKUP(q,nm,sc)),{"FALSE";"0";"NO"},0))),XLOOKUP(q,nm,ct)-ucpu(q),-1)))',
    'best,IF(MAX(score)<0,"",XLOOKUP(MAX(score),score,nm))',
    'pok,IF(prev="",FALSE,IF(ISNA(MATCH(prev,nm,0)),FALSE,fits(prev)))',
    'IF(OR(ph="",ph="Terminating",ph="Deleted"),"",IF(pok,prev,best))',
  ].join(',') + '))';
}

// ---------- the control loop ----------
function reconcile() {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const now = Date.now();
    const deployments = readTab('Deployments');
    let nodes = readTab('Nodes');
    let pods = readTab('Pods');

    // 1) node readiness from heartbeat
    nodes.forEach(n => {
      // String() guard: a real Sheet may coerce the ISO cell to a Date value
      const hb = n.last_heartbeat ? Date.parse(String(n.last_heartbeat)) : 0;
      const ready = hb && (now - hb) < HEARTBEAT_TIMEOUT_MS;
      const wasReady = n.status === 'Ready';
      n.status = ready ? 'Ready' : 'NotReady';
      if (wasReady && !ready) event('Node', n.name, 'NotReady (missed heartbeat)');
    });
    const readyNodes = nodes.filter(n => n.status === 'Ready');
    const readySet = {};
    readyNodes.forEach(n => { readySet[n.name] = n; });

    // 2) evict pods off dead nodes -> back to Pending for rescheduling
    pods.forEach(p => {
      if (p.node && !readySet[p.node] && p.phase !== 'Terminating') {
        event('Pod', p.name, 'evicted from ' + p.node + ' (node NotReady)');
        p.node = ''; p.node_ip = ''; p.container_id = ''; p.phase = 'Pending';
      }
    });

    // 3) drop terminated/failed rows the agents have confirmed gone
    pods = pods.filter(p => p.phase !== 'Deleted');

    // 4) reconcile replicas per deployment
    deployments.forEach(dep => {
      const want = Number(dep.replicas) || 0;
      let mine = pods.filter(p => p.deployment === dep.name && p.phase !== 'Terminating');
      // scale up
      while (mine.length < want) {
        const pod = {
          name: dep.name + '-' + shortId(),
          deployment: dep.name,
          node: '', phase: 'Pending', container_id: '',
          image: dep.image, cpu_req: dep.cpu_req, mem_req: dep.mem_req,
          command: dep.command, node_ip: '', started_at: '', message: '',
          node_selector: dep.node_selector || '', tolerations: dep.tolerations || '',
        };
        pods.push(pod); mine.push(pod);
        event('Pod', pod.name, 'created for deployment ' + dep.name);
      }
      // scale down (kill youngest first)
      if (mine.length > want) {
        const extra = mine.slice(want);
        extra.forEach(p => {
          if (p.phase !== 'Terminating') { p.phase = 'Terminating'; event('Pod', p.name, 'marked Terminating (scale down)'); }
        });
      }
    });

    // 5) drop pods whose deployment no longer exists
    const depNames = {};
    deployments.forEach(d => { depNames[d.name] = true; });
    pods.forEach(p => {
      if (!depNames[p.deployment] && p.phase !== 'Terminating') {
        p.phase = 'Terminating'; event('Pod', p.name, 'deployment removed -> Terminating');
      }
    });

    // 5b) rolling update: if a pod's spec drifts from its deployment, retire ONE
    // stale pod per deployment per pass (the replica loop recreates a fresh one
    // with the new spec on the next reconcile) -> gradual, maxUnavailable=1.
    deployments.forEach(dep => {
      const live = pods.filter(p => p.deployment === dep.name && p.phase !== 'Terminating');
      const drift = (p) => POD_SPEC.some(k => String(p[k] === undefined ? '' : p[k]) !==
                                              String(dep[k] === undefined ? '' : dep[k]));
      const stale = live.find(drift);
      const rolling = live.some(p => p.phase === 'Pending' || p.phase === 'Scheduled');
      // only roll when at desired count and nothing is mid-roll, to avoid churn
      if (stale && !rolling && live.length >= (Number(dep.replicas) || 0)) {
        stale.phase = 'Terminating';
        event('Pod', stale.name, 'rolling update -> Terminating (spec changed)');
      }
    });

    // 6) scheduler. Rows are ordered placed-first, so a single top-to-bottom pass
    //    keeps running pods where they are (sticky) before newcomers are placed —
    //    the same two-phase behaviour as the on-prem schedule(). The pass itself is
    //    done either by the formula in the Pods tab or by scheduleScript().
    pods = orderForScheduling(pods);
    let chosen = null;
    if (SCHEDULER === 'formula') {
      chosen = formulaSchedule(pods, nodes);
      if (!chosen) event('System', 'scheduler', 'formula column returned an error -> script fallback for this pass');
    }
    if (!chosen) chosen = scheduleScript(pods, nodes);
    const nodeByName = {};
    nodes.forEach(n => { nodeByName[n.name] = n; });
    pods.forEach((p, i) => {
      if (p.phase === 'Terminating' || p.phase === 'Deleted') return;
      const c = chosen[i] || '';
      if (c === (p.node || '')) {
        if (!c) p.message = UNSCHEDULABLE;
        return;
      }
      if (!c) {
        event('Pod', p.name, 'no longer fits ' + p.node + ' -> Pending');
        p.node = ''; p.node_ip = ''; p.container_id = ''; p.phase = 'Pending'; p.message = UNSCHEDULABLE;
        return;
      }
      if (p.node) event('Pod', p.name, 'moved from ' + p.node + ' to ' + c + ' (no longer fits or matches)');
      else event('Pod', p.name, 'scheduled on ' + c + ' (' + (chosen.by || SCHEDULER) + ')');
      p.node = c; p.node_ip = nodeByName[c].ip; p.phase = 'Scheduled'; p.container_id = ''; p.message = '';
    });

    // 7) recompute node usage
    nodes.forEach(n => {
      let cpu = 0, mem = 0;
      pods.forEach(p => {
        if (p.node === n.name && p.phase !== 'Terminating') {
          cpu += Number(p.cpu_req) || 0; mem += Number(p.mem_req) || 0;
        }
      });
      n.cpu_used = cpu; n.mem_used = mem;
    });

    writeTab('Pods', pods);
    writeTab('Nodes', nodes);
    return { pods: pods, nodes: nodes };
  } finally {
    lock.releaseLock();
  }
}

// ---------- Web App: the apiserver endpoint ----------
// doGet: read-only kubectl-style queries.  ?token=..&kind=pods|nodes|deployments
function doGet(e) {
  const p = e.parameter || {};
  if (p.token !== TOKEN) return json({ error: 'unauthorized' });
  const kind = (p.kind || 'pods').toLowerCase();
  const map = { pods: 'Pods', nodes: 'Nodes', deployments: 'Deployments', events: 'Events', logs: 'Logs' };
  const tab = map[kind];
  if (!tab) return json({ error: 'unknown kind ' + kind });
  let items = readTab(tab);
  if (p.name) items = items.filter(o => String(o.name) === String(p.name));
  return json({ items: items });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return json({ error: 'bad json' }); }
  if (body.token !== TOKEN) return json({ error: 'unauthorized' });

  // kubectl-style control operations (from skctl / the lab)
  if (body.action && body.action !== 'heartbeat') return controlOp(body);

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    // upsert node + apply agent's pod status reports
    let nodes = readTab('Nodes');
    let node = nodes.find(n => n.name === body.node);
    if (!node) {
      node = { name: body.node, ip: body.ip, cpu_total: body.cpu_total, mem_total: body.mem_total,
               cpu_used: 0, mem_used: 0, status: 'Ready', last_heartbeat: '' };
      nodes.push(node);
      event('Node', body.node, 'registered (' + body.ip + ', cpu=' + body.cpu_total + 'm)');
    }
    node.ip = body.ip;
    if (body.labels) node.labels = body.labels;      // empty = keep what is in the Sheet
    if (body.taints) node.taints = body.taints;
    if (body.cpu_total) node.cpu_total = body.cpu_total;
    if (body.mem_total) node.mem_total = body.mem_total;
    node.last_heartbeat = new Date().toISOString();
    node.status = 'Ready';
    writeTab('Nodes', nodes);

    // apply pod status the agent reported (it reports only its RUNNING containers)
    {
      let pods = readTab('Pods');
      const report = {};
      (body.pods || []).forEach(r => { report[r.name] = r; });
      pods.forEach(p => {
        if (p.node !== body.node) return;
        const r = report[p.name];
        if (r) {
          if (r.container_id) p.container_id = r.container_id;
          if (p.phase === 'Scheduled') {
            p.phase = 'Running';
            if (!p.started_at) p.started_at = new Date().toISOString();
          }
        } else if (p.phase === 'Terminating') {
          // agent no longer runs it -> it's gone
          p.phase = 'Deleted';
          event('Pod', p.name, 'deleted from ' + body.node);
        } else if (p.phase === 'Running') {
          // container vanished on a still-Ready node -> it crashed; restart in place
          p.phase = 'Scheduled'; p.container_id = '';
          event('Pod', p.name, 'container exited on ' + body.node + ' -> restarting');
        }
      });
      writeTab('Pods', pods);
    }

    // log tails the agent shipped (the `kubectl logs` of a spreadsheet)
    const tails = (body.pods || []).filter(r => typeof r.logs === 'string');
    if (tails.length) {
      const logs = readTab('Logs');
      const live = {};
      readTab('Pods').forEach(p => { live[p.name] = true; });
      const byName = {};
      logs.filter(l => live[l.name]).forEach(l => { byName[l.name] = l; });
      tails.forEach(r => {
        byName[r.name] = { name: r.name, node: body.node, updated_at: new Date().toISOString(),
                           tail: r.logs.slice(-LOG_TAIL_MAX_CHARS) };
      });
      writeTab('Logs', Object.keys(byName).map(k => byName[k]));
    }
  } finally {
    lock.releaseLock();
  }

  // run the control loop, then answer with this node's desired state
  const state = reconcile();
  const desired = [];
  state.pods.forEach(p => {
    if (p.node !== body.node) return;
    if (p.phase === 'Scheduled' || p.phase === 'Running') {
      desired.push({ name: p.name, deployment: p.deployment, image: p.image, command: p.command,
                     cpu_req: p.cpu_req, mem_req: p.mem_req, desired: 'Running' });
    } else if (p.phase === 'Terminating') {
      desired.push({ name: p.name, desired: 'Terminating' });
    }
  });
  return json({ pods: desired });
}

// apply / scale / delete against the Deployments tab, then kick a reconcile
function controlOp(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    let deps = readTab('Deployments');
    const byName = {};
    deps.forEach(d => { byName[d.name] = d; });

    if (body.action === 'apply') {
      (body.deployments || []).forEach(spec => {
        const d = byName[spec.name];
        if (d) {
          DEPLOYMENT_SPEC.forEach(k => {
            if (spec[k] !== undefined) d[k] = spec[k];
          });
          event('Deployment', spec.name, 'configured');
        } else {
          const nd = { name: spec.name, image: spec.image, replicas: spec.replicas,
                       cpu_req: spec.cpu_req || 100, mem_req: spec.mem_req || 64,
                       command: spec.command || '',
                       node_selector: spec.node_selector || '', tolerations: spec.tolerations || '' };
          deps.push(nd); byName[spec.name] = nd;
          event('Deployment', spec.name, 'created');
        }
      });
    } else if (body.action === 'scale') {
      const d = byName[body.name];
      if (!d) return json({ error: 'no such deployment ' + body.name });
      d.replicas = body.replicas;
      event('Deployment', body.name, 'scaled to ' + body.replicas);
    } else if (body.action === 'delete') {
      deps = deps.filter(d => d.name !== body.name);
      event('Deployment', body.name, 'deleted');
    } else if (body.action === 'cordon' || body.action === 'uncordon') {
      const nodes = readTab('Nodes');
      const n = nodes.find(x => x.name === body.name);
      if (!n) return json({ error: 'no such node ' + body.name });
      n.schedulable = body.action === 'uncordon';
      writeTab('Nodes', nodes);
      event('Node', body.name, body.action === 'cordon' ? 'cordoned (SchedulingDisabled)' : 'uncordoned');
    } else {
      return json({ error: 'unknown action ' + body.action });
    }
    writeTab('Deployments', deps);
  } finally {
    lock.releaseLock();
  }
  reconcile();
  return json({ ok: true });
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- one-time setup ----------
// Creates the tabs and header rows (idempotent; also upgrades an older sheet by
// appending the new columns) and installs the scheduler formula column.
function ensureTabs() {
  Object.keys(TABS).forEach(name => {
    let sh = ss().getSheetByName(name) || ss().insertSheet(name);
    sh.getRange(1, 1, 1, TABS[name].length).setValues([TABS[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  const pods = ss().getSheetByName('Pods');
  pods.getRange(1, CHOSEN_COL, 1, 1).setValues([[CHOSEN_HEADER]]).setFontWeight('bold')
    .setNote('Computed by a Google Sheets formula: the node the scheduler picks for this pod. ' +
             'Do not edit. Set SCHEDULER = \'script\' in Code.gs to schedule in Apps Script instead.');
  syncChosenColumn(pods, Math.max(0, pods.getLastRow() - 1), pods.getLastRow());
}

function setup() {
  ensureTabs();
  // sample deployment (nginx x3)
  const dep = ss().getSheetByName('Deployments');
  if (dep.getLastRow() < 2) {
    dep.appendRow(['nginx', 'nginx:alpine', 3, 100, 64, '']);
    dep.appendRow(['redis', 'redis:alpine', 1, 150, 128, '']);
  }
  // reconcile every minute (backstop; heartbeats also drive it)
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'reconcile') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('reconcile').timeBased().everyMinutes(1).create();
  event('System', 'setup', 'Sheeternetes initialized');
}

// ---------- demo helpers (for a browser/video proof without real Docker hosts) ----------
// Registers 3 fake nodes, schedules the current Deployments, and drives pods to Running.
// This runs the REAL reconcile()/scheduler; only the kubelet is faked.
function simulate(nodeNames) {
  const names = nodeNames || ['node-a', 'node-b', 'node-c'];
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    let nodes = readTab('Nodes');
    names.forEach((name, i) => {
      let n = nodes.find(x => x.name === name);
      if (!n) { n = { name: name }; nodes.push(n); }
      n.ip = '10.0.0.' + (i + 1);
      n.cpu_total = 4000; n.mem_total = 8192;
      n.status = 'Ready';
      n.last_heartbeat = new Date().toISOString();
    });
    writeTab('Nodes', nodes);
  } finally { lock.releaseLock(); }

  reconcile();  // schedule Pending -> Scheduled

  // fake the kubelet: Scheduled -> Running with a fake container id
  const lock2 = LockService.getScriptLock();
  lock2.waitLock(20000);
  try {
    let pods = readTab('Pods');
    pods.forEach(p => {
      if (p.phase === 'Scheduled') {
        p.phase = 'Running';
        p.container_id = 'fake' + Utilities.getUuid().replace(/-/g, '').substring(0, 8);
        if (!p.started_at) p.started_at = new Date().toISOString();
      }
    });
    writeTab('Pods', pods);
  } finally { lock2.releaseLock(); }
  event('System', 'simulate', 'faked ' + names.length + ' node(s) and drove pods to Running');
}

// Ages node-c past the heartbeat timeout so the next reconcile evicts and reschedules its pods.
function simulateNodeFailure() {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    let nodes = readTab('Nodes');
    const c = nodes.find(n => n.name === 'node-c');
    if (c) { c.last_heartbeat = new Date(Date.now() - 5 * 60 * 1000).toISOString(); }
    writeTab('Nodes', nodes);
  } finally { lock.releaseLock(); }
  reconcile();
  // re-run the fake kubelet on SURVIVORS only (don't resurrect node-c) so the
  // rescheduled pods show Running again while node-c stays NotReady.
  simulate(['node-a', 'node-b']);
  event('System', 'simulateNodeFailure', 'node-c failed; pods rescheduled');
}
