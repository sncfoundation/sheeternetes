/**
 * Script pods — a serverless pod runtime for Sheeternetes.
 *
 * A Deployment with `runtime: script` runs as JavaScript inside this very Apps
 * Script project: no Docker host, no kubelet.sh. The project registers itself as
 * the node `apps-script` (label and NoSchedule taint `runtime=script`), so the
 * ordinary reconcile loop and the formula scheduler place script pods on it like
 * any other pod. This file is that node's kubelet:
 *
 *   runtimeTick()      renew the node lease, reconcile when needed, move pods
 *                      through their phases, fire due `schedule` slots (every
 *                      minute while something is due, every 30 minutes otherwise);
 *   runtimeWebhook(e)  doPost ?pod=<deployment>&key=<key>: delivers the request body;
 *   runtimeOp(body)    skctl run / secret / webhook.
 *
 * The pod's image is its source on a Sheetstor volume, `sheetstor://<volume>/<path>`.
 * The source is a CommonJS-style module whose synchronous
 * `exports.handle(event, env)` gets every event (Apps Script forbids async
 * functions here). See docs/script-runtime.md.
 *
 * Exactly one invocation runs at a time: every invocation holds the script lock.
 * An invocation is a transaction on the pod's state (`env.state`, kept on the
 * volume `<deployment>-state`): it commits when the handler returns and rolls
 * back when it throws. Schedule slots are recorded in the same commit, so a slot
 * fires exactly once even when triggers jitter or overlap.
 *
 * Secrets live in Script Properties, never in cells, Events or logs; everything
 * the runtime writes is masked.
 */
const RUNTIME_NODE = 'apps-script';
const RUNTIME_LABEL = 'runtime=script';
const RUNTIME_FIELDS = ['runtime', 'schedule', 'env', 'secrets', 'volumes'];
const RUNTIME_SLOW_MINUTES = 30;              // the trigger that is always installed
const RUNTIME_SLOW_MS = RUNTIME_SLOW_MINUTES * 60 * 1000;
const RUNTIME_FAST_LINGER_MS = 15 * 60 * 1000; // the 1-minute trigger stays this long after the last due work
const RUNTIME_TRIGGERS = 'v2';                 // the trigger layout; a tick of an older layout installs this one
const RUNTIME_LEASE_MS = 90 * 60 * 1000;       // the node's heartbeat is stamped this far ahead...
const RUNTIME_RENEW_MS = 60 * 60 * 1000;       // ...and renewed once no more than this is left (every slow tick)
const RUNTIME_RECONCILE_EVERY_MS = RUNTIME_SLOW_MS;   // the backstop compares a fingerprint this often
const RUNTIME_CATCHUP_MS = 15 * 60 * 1000;     // a late tick still fires slots this old
const RUNTIME_BACKOFF_MAX_MS = 60 * 60 * 1000;
const RUNTIME_RUN_PAUSE_MS = 6 * 60 * 1000;    // a one-off run's pause marker expires (Apps Script's execution limit)
const RUNTIME_WEBHOOK_ATTEMPTS = 3;
const RUNTIME_ONCE_KEEP = 1000;
const RUNTIME_STATE_PATH = 'state.json';
const RUNTIME_IMAGE = /^sheetstor:\/\/([a-z0-9-]+)\/(.+)$/;
const RUNTIME_PROP = { secret: 'sk.secret.', webhook: 'sk.webhook.', pod: 'sk.pod.', cron: 'sk.cron.', run: 'sk.run.', attempts: 'sk.attempts.',
                       sleep: 'sk.sleep.', quota: 'sk.quota.', flushed: 'sk.quota-flushed', reconciled: 'sk.reconciled',
                       next: 'sk.tick-next', precise: 'sk.tick-precise', fast: 'sk.tick-fast', triggers: 'sk.triggers',
                       fingerprint: 'sk.fingerprint' };
const RUNTIME_QUOTA_TAB = 'Runtime';
const RUNTIME_QUOTA_MS = 90 * 60 * 1000;       // consumer accounts: triggers total runtime per day
const RUNTIME_QUOTA_FLUSH_MS = 10 * 60 * 1000;
const RUNTIME_WEBHOOK_LOCK_MS = 20000;

function isScriptDeployment(d) { return String(d && d.runtime || '').trim() === 'script'; }

// skctl apply: a script Deployment always selects and tolerates the apps-script node.
function runtimeDefaults(d) {
  if (!isScriptDeployment(d)) return false;
  let changed = false;
  ['node_selector', 'tolerations'].forEach(k => {
    const list = kvList(d[k]);
    if (list.indexOf(RUNTIME_LABEL) < 0) { list.push(RUNTIME_LABEL); d[k] = list.join(','); changed = true; }
  });
  return changed;
}

function runtimeProps() { return PropertiesService.getScriptProperties(); }
function runtimePropJSON(key, fallback) {
  const v = runtimeProps().getProperty(key);
  if (!v) return fallback;
  try { return JSON.parse(v); } catch (e) { return fallback; }
}

// ---------- secrets & masking ----------
function runtimeSecretNames() {
  return runtimeProps().getKeys().filter(k => k.indexOf(RUNTIME_PROP.secret) === 0).map(k => k.slice(RUNTIME_PROP.secret.length)).sort();
}

function runtimeMasker(all) {
  const values = [];
  all = all || runtimeProps().getProperties();
  Object.keys(all).forEach(k => {
    if (k.indexOf(RUNTIME_PROP.secret) === 0) {
      const data = JSON.parse(all[k] || '{}');
      Object.keys(data).forEach(n => values.push(String(data[n])));
    } else if (k.indexOf(RUNTIME_PROP.webhook) === 0) {
      values.push(all[k]);
    }
  });
  const needles = [];
  values.filter(v => v.length >= 4).forEach(v => { needles.push(v); const enc = encodeURIComponent(v); if (enc !== v) needles.push(enc); });
  needles.sort((a, b) => b.length - a.length);
  return (s) => {
    let out = String(s === undefined ? '' : s);
    needles.forEach(n => { out = out.split(n).join('***'); });
    return out;
  };
}

function runtimeSecretSet(name, data) {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(String(name || ''))) throw new Error('bad secret name "' + name + '"');
  if (!data || typeof data !== 'object') throw new Error('secret data must be an object of KEY: value');
  return skLocked(() => {
    const key = RUNTIME_PROP.secret + name;
    const cur = runtimePropJSON(key, {});
    Object.keys(data).forEach(k => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error('bad secret key "' + k + '"');
      if (data[k] === null) delete cur[k]; else cur[k] = String(data[k]);
    });
    runtimeProps().setProperty(key, JSON.stringify(cur));
    event('Secret', name, 'set keys ' + Object.keys(data).join(', '));
    return { name: name, keys: Object.keys(cur).sort() };
  });
}

// ---------- the apps-script node (heartbeat lease) ----------
function runtimeHeartbeat_(now, nodes) {
  nodes = nodes || readTab('Nodes');
  let n = nodes.find(x => x.name === RUNTIME_NODE);
  const fresh = n && Date.parse(String(n.last_heartbeat)) - now > RUNTIME_RENEW_MS + 60000 && n.status === 'Ready';   // a pass at the renewal mark renews
  if (fresh) return false;
  if (!n) {
    n = { name: RUNTIME_NODE, ip: 'script.google.com', cpu_total: 100000, mem_total: 100000, cpu_used: 0, mem_used: 0,
          schedulable: true, labels: RUNTIME_LABEL, taints: RUNTIME_LABEL + ':NoSchedule' };
    nodes.push(n);
    event('Node', RUNTIME_NODE, 'registered (script pods run in this Apps Script project)');
  }
  n.status = 'Ready';
  n.last_heartbeat = new Date(now + RUNTIME_LEASE_MS).toISOString();   // a lease: a late trigger does not evict
  writeTab('Nodes', nodes);
  return true;
}

// ---------- the tick ----------
// The budget. Apps Script counts every execution of a trigger from its start-up
// (about a second before the first line runs), so the cheapest tick is the one
// that does not happen: a 1-minute trigger exists only while something is due
// within the next half hour (an awake pod, a pod waking up soon, the autoscaler,
// work the reconcile loop has not finished), and a 30-minute trigger stays
// installed for the lease and the backstop. Any API call, an edit of the Sheet by
// hand and env.sleepUntil install the fast trigger again (runtimeWake).
//
// Within a tick: an idle tick reads Script Properties once and returns. After every
// full pass the tick records when there is work again; a full pass reads Nodes,
// Deployments and Pods once, runs the reconcile loop only when something is not
// converged or the tabs differ from what the last pass left (a fingerprint), and
// touches no volume unless a slot is due.
function runtimeTick() {
  const now = Date.now();
  let props0 = runtimeProps().getProperties();
  if (props0[RUNTIME_PROP.triggers] !== RUNTIME_TRIGGERS) { runtimeInstallTriggers_(now); props0 = runtimeProps().getProperties(); }
  if (now < Number(props0[RUNTIME_PROP.next] || 0)) {
    runtimeTriggers_(now, props0);
    runtimeQuota_(now, props0, 'idle');
    return { skipped: 'idle' };
  }
  let out;
  const first = skTryLocked(() => {
    const props = runtimeProps().getProperties();
    const nodes = readTab('Nodes');
    runtimeHeartbeat_(now, nodes);
    const deps = readTab('Deployments');
    if (deps.map(runtimeDefaults).some(Boolean)) writeTab('Deployments', deps);
    const pods = readTab('Pods');
    if (runtimeNeedsReconcile_(deps, pods, nodes, now, props)) return { reconcile: true };
    const fired = runtimeFireSchedules_(now, deps, runtimeSyncPods_(now, pods), props);
    if (!fired.length) runtimeIdleUntil_(now, deps, pods, nodes);
    return { fired: fired };
  });
  let kind = 'pass';
  if (!first.locked) {
    out = { skipped: 'busy' };
  } else if (!first.value.reconcile) {
    out = { fired: first.value.fired, reconciled: false };
  } else {
    kind = 'reconcile';
    reconcile();
    runtimeProps().setProperty(RUNTIME_PROP.reconciled, String(now));
    const second = skTryLocked(() => {
      const deps = readTab('Deployments');
      const pods = runtimeSyncPods_(now, readTab('Pods'));
      const fired = runtimeFireSchedules_(now, deps, pods, runtimeProps().getProperties());
      if (!fired.length) runtimeIdleUntil_(now, deps, pods, readTab('Nodes'));
      return fired;
    });
    out = second.locked ? { fired: second.value, reconciled: true } : { skipped: 'busy' };
  }
  const props = runtimeProps().getProperties();
  runtimeTriggers_(now, props);
  runtimeQuota_(now, props, kind);
  return out;
}

// Something may have work for the tick: forget the idle mark and make sure the
// 1-minute trigger runs. Cheap when it already does (one property read).
function runtimeWake() {
  const p = runtimeProps();
  p.deleteProperty(RUNTIME_PROP.next);
  if (!Number(p.getProperty(RUNTIME_PROP.fast) || 0)) runtimeFastTrigger_(true, Date.now());
}

// An installable on-edit trigger: a change typed into the Sheet wakes the loop at once.
function runtimeOnEdit() { runtimeWake(); }

// When the next full pass is needed if nothing calls runtimeWake() before. Two marks:
// `next` for any work, `precise` for work that must not wait for the slow trigger
// (the lease and the backstop can).
function runtimeIdleUntil_(now, deps, pods, nodes) {
  const props = runtimeProps().getProperties();
  const node = nodes.find(n => n.name === RUNTIME_NODE);
  // The lease is renewed by the first pass at or after its mark; a slow tick that lands
  // just before the mark idles, and the lease still has half an hour left at the next one.
  // The backstop is due a few minutes early, and its check (runtimeNeedsReconcile_)
  // accepts that, so a slow tick never waits another half hour for it.
  const routine = [
    node ? Date.parse(String(node.last_heartbeat)) - RUNTIME_RENEW_MS : now,
    Number(props[RUNTIME_PROP.reconciled] || 0) + RUNTIME_RECONCILE_EVERY_MS - 3 * 60000,
  ];
  const precise = [];
  if (readTab('Autoscale').length) precise.push(now);
  deps.filter(d => isScriptDeployment(d) && String(d.schedule || '').trim() && runtimeLeader_(d.name, pods)).forEach(d => {
    let t = Number(props[RUNTIME_PROP.sleep + d.name] || 0);
    try { const st = JSON.parse(props[RUNTIME_PROP.pod + d.name] || '{}'); if (st.backoff_until) t = Math.max(t, Date.parse(st.backoff_until)); }
    catch (e) { t = now; }
    precise.push(t);
  });
  const soonest = precise.length ? Math.min.apply(null, precise) : now + 365 * 86400000;
  const next = Math.min.apply(null, routine.concat([soonest]));
  const marks = { [RUNTIME_PROP.precise]: String(soonest - 30000) };
  if (next > now + 30000) marks[RUNTIME_PROP.next] = String(next - 30000);
  runtimeProps().setProperties(marks);
  return next;
}

// Installs or removes the 1-minute trigger when the due work says so. `fast` holds
// when that trigger was last needed (0: not installed).
function runtimeTriggers_(now, props) {
  const fast = Number(props[RUNTIME_PROP.fast] || 0);
  const soon = Number(props[RUNTIME_PROP.precise] || 0) - now < RUNTIME_SLOW_MS + 60000;   // routine work waits for the slow trigger
  if (soon && (!fast || now - fast > 5 * 60000)) runtimeFastTrigger_(true, now);
  else if (!soon && fast && now - fast > RUNTIME_FAST_LINGER_MS) runtimeFastTrigger_(false, now);
}

function runtimeFastTrigger_(on, now) {
  const p = runtimeProps();
  const mine = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'runtimeTick');
  if (on) {
    if (!mine.length) ScriptApp.newTrigger('runtimeTick').timeBased().everyMinutes(1).create();
    p.setProperty(RUNTIME_PROP.fast, String(now));
  } else {
    mine.forEach(t => ScriptApp.deleteTrigger(t));
    p.setProperty(RUNTIME_PROP.fast, '0');
  }
}

// The whole layout: the slow trigger, the on-edit trigger, and the fast one to begin
// with. Replaces the triggers of older versions (one runtimeTick every minute, or the
// plain reconcile timer).
function runtimeInstallTriggers_(now) {
  const ours = ['runtimeTick', 'runtimeTickSlow', 'runtimeOnEdit', 'reconcile'];
  ScriptApp.getProjectTriggers().forEach(t => { if (ours.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runtimeTickSlow').timeBased().everyMinutes(RUNTIME_SLOW_MINUTES).create();
  ScriptApp.newTrigger('runtimeOnEdit').forSpreadsheet(ss()).onEdit().create();
  ScriptApp.newTrigger('runtimeTick').timeBased().everyMinutes(1).create();
  runtimeProps().setProperties({ [RUNTIME_PROP.fast]: String(now), [RUNTIME_PROP.triggers]: RUNTIME_TRIGGERS });
}

function runtimeTickSlow() { return runtimeTick(); }

// What the tabs look like after a reconcile pass (reconcile() records it). The
// backstop runs the loop again only when the tabs no longer match, e.g. after an
// edit by hand. Heartbeat times are left out: the lease renews them on its own.
function runtimeFingerprint_(deps, pods, nodes) {
  const cell = v => (v instanceof Date ? v.toISOString() : String(v === undefined || v === null ? '' : v));
  const rows = (list, cols) => list.map(o => cols.map(c => cell(o[c])));
  const nodeCols = TABS.Nodes.filter(c => c !== 'last_heartbeat');
  return skSha256(skBytes(JSON.stringify([rows(deps, TABS.Deployments), rows(pods, TABS.Pods), rows(nodes, nodeCols)])));
}

function runtimeReconciled_(deps, pods, nodes) {
  if (ss.override) return;      // a pass over a selftest's scratch sheet
  runtimeProps().setProperty(RUNTIME_PROP.fingerprint, runtimeFingerprint_(deps, pods, nodes));
}

// Trigger time per day, in Script Properties on every tick and in the Runtime tab
// every few minutes: date, ticks, trigger_ms, max_tick_ms, budget_ms, used_percent,
// and what the ticks did (idle, full passes, reconcile passes).
// (Apps Script also counts the start-up of each execution, which a script cannot
// see: about a second per tick on the Executions page.)
const RUNTIME_QUOTA_HEADER = ['date', 'ticks', 'trigger_ms', 'max_tick_ms', 'budget_ms', 'used_percent', 'idle', 'passes', 'reconciles'];
function runtimeQuota_(started, props, kind) {
  const p = runtimeProps();
  props = props || p.getProperties();
  const day = new Date(started).toISOString().slice(0, 10);
  let q;
  try { q = JSON.parse(props[RUNTIME_PROP.quota + day] || ''); } catch (e) { q = { ticks: 0, ms: 0, max: 0 }; }
  const took = Date.now() - started;
  q.ticks += 1; q.ms += took; q.max = Math.max(q.max, took);
  const k = { idle: 'idle', pass: 'passes', reconcile: 'reconciles' }[kind];
  if (k) q[k] = (q[k] || 0) + 1;
  p.setProperty(RUNTIME_PROP.quota + day, JSON.stringify(q));
  if (started - Number(props[RUNTIME_PROP.flushed] || 0) < RUNTIME_QUOTA_FLUSH_MS) return q;
  p.setProperty(RUNTIME_PROP.flushed, String(started));
  let sh = ss().getSheetByName(RUNTIME_QUOTA_TAB);
  const header = RUNTIME_QUOTA_HEADER;
  if (!sh) sh = ss().insertSheet(RUNTIME_QUOTA_TAB);
  const grid = sh.getDataRange().getValues();
  if (grid[0].length < header.length || header.some((h, i) => grid[0][i] !== h)) sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  const label = day + ' UTC';     // not a date to Sheets, so it stays text
  const days = grid.map(r => String(r[0]));
  let row = days.indexOf(label) + 1;
  if (row <= 1) row = Math.max(2, grid.length + 1);
  sh.getRange(row, 1, 1, header.length).setValues([[label, q.ticks, q.ms, q.max, RUNTIME_QUOTA_MS, Math.round(q.ms / RUNTIME_QUOTA_MS * 1000) / 10,
                                                     q.idle || 0, q.passes || 0, q.reconciles || 0]]);
  // old days are dropped from Script Properties once they are in the tab
  p.getKeys().filter(k => k.indexOf(RUNTIME_PROP.quota) === 0 && k < RUNTIME_PROP.quota + day).forEach(k => p.deleteProperty(k));
  return q;
}

// The control loop is skipped while everything is converged: Apps Script grants a
// consumer account 90 minutes of trigger time a day. The backstop (every 30 minutes)
// runs it when the tabs differ from what the last reconcile pass left.
function runtimeNeedsReconcile_(deps, pods, nodes, now, props) {
  props = props || {};
  const last = Number(props[RUNTIME_PROP.reconciled] || 0);
  if (now - last >= RUNTIME_RECONCILE_EVERY_MS - 4 * 60000) {
    if (runtimeFingerprint_(deps, pods, nodes) !== props[RUNTIME_PROP.fingerprint]) return true;
    runtimeProps().setProperty(RUNTIME_PROP.reconciled, String(now));   // checked: still converged
  }
  if (readTab('Autoscale').length) return true;          // the HPA wants a pass every minute
  if (nodes.some(n => n.status === 'Ready' && now - Date.parse(String(n.last_heartbeat)) >= HEARTBEAT_TIMEOUT_MS)) return true;
  // a Terminating pod waits for its kubelet; one without a (known) node is collected by the loop
  const known = {}, ready = {};
  nodes.forEach(n => { known[n.name] = true; if (n.status === 'Ready') ready[n.name] = true; });
  // (an Unschedulable pod waits for a change: a node, an edit, an API call)
  if (pods.some(p => (p.phase === 'Pending' && p.message !== UNSCHEDULABLE) || p.phase === 'Scheduled' || p.phase === 'Deleted' ||
                     (p.phase === 'Terminating' && (!known[p.node] || ready[p.node])))) return true;
  const live = p => p.phase !== 'Terminating' && p.phase !== 'Deleted';
  return deps.some(d => pods.filter(p => p.deployment === d.name && live(p)).length !== (Number(d.replicas) || 0));
}

// Kubelet duties: Scheduled -> Running, Terminating -> Deleted.
function runtimeSyncPods_(now, pods) {
  pods = pods || readTab('Pods');
  let changed = false;
  pods.forEach(p => {
    if (p.node !== RUNTIME_NODE) return;
    if (p.phase === 'Scheduled') {
      p.phase = 'Running'; p.started_at = new Date(now).toISOString(); p.container_id = 'script'; changed = true;
      event('Pod', p.name, 'started on ' + RUNTIME_NODE);
    } else if (p.phase === 'Terminating') {
      p.phase = 'Deleted'; changed = true;
      event('Pod', p.name, 'stopped on ' + RUNTIME_NODE);
    }
  });
  if (changed) writeTab('Pods', pods);
  return pods;
}

// The one pod of a script Deployment that runs (the oldest Running one).
function runtimeLeader_(depName, pods) {
  return pods.filter(p => p.deployment === depName && p.node === RUNTIME_NODE && p.phase === 'Running')
    .sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)) || String(a.name).localeCompare(String(b.name)))[0] || null;
}

// ---------- cron ----------
// "m h dom mon dow", optionally prefixed by CRON_TZ=<zone>; or @hourly/@daily/@weekly.
// The `schedule` column holds one expression or a JSON object {"name": "expression"}.
function runtimeSchedules(dep) {
  const raw = String(dep.schedule || '').trim();
  if (!raw) return {};
  if (raw.charAt(0) === '{') return JSON.parse(raw);
  return { default: raw };
}

function runtimeCron(expr) {
  let tz = Session.getScriptTimeZone();
  let s = String(expr).trim();
  const m = /^CRON_TZ=(\S+)\s+(.*)$/.exec(s);
  if (m) { tz = m[1]; s = m[2]; }
  s = ({ '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@weekly': '0 0 * * 0' })[s] || s;
  const parts = s.split(/\s+/);
  if (parts.length !== 5) throw new Error('bad cron "' + expr + '": need 5 fields');
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  const sets = parts.map((f, i) => {
    const out = {};
    f.split(',').forEach(term => {
      const t = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(term);
      if (!t) throw new Error('bad cron field "' + term + '" in "' + expr + '"');
      let lo = ranges[i][0], hi = ranges[i][1];
      if (t[1] !== '*') { const ab = t[1].split('-').map(Number); lo = ab[0]; hi = ab.length > 1 ? ab[1] : (t[2] ? ranges[i][1] : ab[0]); }
      if (lo < ranges[i][0] || hi > ranges[i][1] || lo > hi) throw new Error('cron field out of range "' + term + '" in "' + expr + '"');
      for (let v = lo; v <= hi; v += Number(t[2] || 1)) out[i === 4 ? v % 7 : v] = true;
    });
    return { set: out, star: f === '*' };
  });
  return { tz: tz, sets: sets };
}

function runtimeCronMatches(cron, ms) {
  const f = Utilities.formatDate(new Date(ms), cron.tz, 'm H d M u').split(' ').map(Number);
  const s = cron.sets;
  if (!s[0].set[f[0]] || !s[1].set[f[1]] || !s[3].set[f[3]]) return false;
  const dom = s[2].set[f[2]], dow = s[4].set[f[4] % 7];
  if (s[2].star || s[4].star) return (s[2].star || dom) && (s[4].star || dow);
  return dom || dow;      // both restricted: either matches (classic cron)
}

// The newest slot in (after, now] within the catch-up window, or 0.
function runtimeDueSlot(cron, after, now) {
  const minute = 60000;
  for (let t = Math.floor(now / minute) * minute; t > after && t > now - RUNTIME_CATCHUP_MS; t -= minute) {
    if (runtimeCronMatches(cron, t)) return t;
  }
  return 0;
}

function runtimeFireSchedules_(now, deps, pods, props) {
  props = props || runtimeProps().getProperties();
  const prop = (k, fallback) => { try { return props[k] ? JSON.parse(props[k]) : fallback; } catch (e) { return fallback; } };
  const fired = [];
  deps.filter(isScriptDeployment).forEach(dep => {
    if (!String(dep.schedule || '').trim()) return;
    const leader = runtimeLeader_(dep.name, pods);
    if (!leader) return;
    if (now - Number(props[RUNTIME_PROP.run + dep.name] || 0) < RUNTIME_RUN_PAUSE_MS) return;   // a one-off run owns the pod
    if (now < Number(props[RUNTIME_PROP.sleep + dep.name] || 0)) return;                     // env.sleepUntil()
    const status = prop(RUNTIME_PROP.pod + dep.name, {});
    if (status.backoff_until && now < Date.parse(status.backoff_until)) return;
    let schedules;
    try { schedules = runtimeSchedules(dep); } catch (err) { runtimeFail_(dep, leader, 'bad schedule: ' + err.message, now, true); return; }
    const mirror = prop(RUNTIME_PROP.cron + dep.name, {});
    let mirrorChanged = false;
    Object.keys(schedules).forEach(name => {
      if (mirror[name] === undefined) { mirror[name] = Math.floor(now / 60000) * 60000 - 60000; mirrorChanged = true; }
      let cron;
      try { cron = runtimeCron(schedules[name]); } catch (err) { runtimeFail_(dep, leader, err.message, now, true); return; }
      const slot = runtimeDueSlot(cron, mirror[name], now);
      if (!slot) return;
      const res = runtimeInvoke_(dep, leader, { type: 'schedule', schedule: name, slot: new Date(slot).toISOString() }, { slot: slot, now: now });
      if (res.ok) { mirror[name] = slot; mirrorChanged = true; if (!res.skipped) fired.push(dep.name + '/' + name + '@' + new Date(slot).toISOString()); }
    });
    if (mirrorChanged) runtimeProps().setProperty(RUNTIME_PROP.cron + dep.name, JSON.stringify(mirror));
  });
  return fired;
}

// ---------- state: a JSON document on the volume <deployment>-state ----------
function runtimeStateVolume(depName) { return depName + '-state'; }

function runtimeState_(depName) {
  const vol = runtimeStateVolume(depName);
  let doc = null, original = null;
  const load = () => {
    if (doc) return doc;
    let text = '';
    if (sheetstorVolumes().some(v => v.name === vol)) {
      try { text = sheetstorReadText_(vol, RUNTIME_STATE_PATH).text; }
      catch (e) { if (!/^no such file/.test(e.message)) throw e; }
    }
    doc = text ? JSON.parse(text) : {};
    doc.data = doc.data === undefined ? {} : doc.data;
    doc.once = doc.once || [];
    doc.cron = doc.cron || {};
    original = text || JSON.stringify(doc);
    return doc;
  };
  const st = {
    doc: load,
    get: () => load().data,
    set: (v) => { load().data = v; return v; },
    update: (fn) => st.set(fn(st.get())),
    save: () => {
      if (!doc) return false;
      const text = JSON.stringify(doc);
      if (text === original) return false;
      if (!sheetstorVolumes().some(v => v.name === vol)) sheetstorCreate_(vol, { ifMissing: true });
      const res = sheetstorWrite_(vol, RUNTIME_STATE_PATH, text);
      sheetstorCacheText_(vol, res.manifest, RUNTIME_STATE_PATH, { text: text, sha256: res.sha256 });   // the next invocation reads no cell
      original = text;
      return true;
    },
    once: (key, fn) => {
      key = String(key);
      const d = load();
      if (d.once.indexOf(key) >= 0) return undefined;
      const out = fn();
      d.once.push(key);
      if (d.once.length > RUNTIME_ONCE_KEEP) d.once.splice(0, d.once.length - RUNTIME_ONCE_KEEP);
      return out;
    },
  };
  return st;
}

// ---------- invoking a pod ----------
// The source comes through the text cache: one registry read when nothing changed.
function runtimeCode_(dep) {
  const m = RUNTIME_IMAGE.exec(String(dep.image || ''));
  if (!m) throw new Error('image must be sheetstor://<volume>/<path>, got "' + dep.image + '"');
  const f = sheetstorReadText_(m[1], m[2]);
  return { source: f.text, sha256: f.sha256 };
}

// env.table(name, columns): an append-only log in the hidden tab table-<deployment>-<name>.
// append() is one appendRow, so it is cheap enough for every webhook. Strings are
// stored JSON-quoted (a name like "=1+1" must not become a formula) and masked.
function runtimeTable_(depName, name, columns, mask) {
  if (!/^[a-z0-9-]+$/.test(String(name))) throw new Error('bad table name "' + name + '"');
  const tab = 'table-' + depName + '-' + name;
  let sh = ss().getSheetByName(tab);
  const header = ['ts'].concat(columns);
  if (!sh) {
    sh = ss().insertSheet(tab);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    if (typeof sh.hideSheet === 'function') sh.hideSheet();
  }
  const enc = v => (v === undefined || v === null ? '' : typeof v === 'number' || typeof v === 'boolean' ? v : JSON.stringify((mask || String)(String(v))));
  const dec = v => (typeof v === 'string' && v.charAt(0) === '"' ? JSON.parse(v) : v);
  return {
    append: (obj) => { sh.appendRow([new Date().toISOString()].concat(columns.map(c => enc(obj[c])))); },
    count: () => Math.max(0, sh.getLastRow() - 1),   // rows only grow: a cheap version for caches
    rows: () => {
      const g = sh.getDataRange().getValues();
      const h = g.shift() || [];
      return g.filter(r => r[0] !== '').map(r => { const o = {}; h.forEach((k, i) => { o[k] = dec(r[i]); }); return o; });
    },
  };
}

function runtimeEnv_(dep, pod, st, logger, mask, props) {
  let vars = {};
  if (String(dep.env || '').trim()) {
    try { vars = JSON.parse(String(dep.env)); } catch (e) { throw new Error('env column must be a JSON object: ' + e.message); }
  }
  const secrets = {};
  kvList(dep.secrets).forEach(name => {
    const v = props ? props[RUNTIME_PROP.secret + name] : runtimeProps().getProperty(RUNTIME_PROP.secret + name);
    if (v === null || v === undefined) throw new Error('secret ' + name + ' not found');
    Object.assign(secrets, JSON.parse(v));
  });
  const volumes = {};
  kvList(dep.volumes).forEach(spec => {
    const parts = spec.split(':');
    volumes[parts[0]] = sheetstorHandle_(parts[0], parts[1] === 'ro');
  });
  return {
    deployment: dep.name, pod: pod.name, vars: vars, secrets: Object.freeze(secrets), volumes: volumes,
    state: { get: st.get, set: st.set, update: st.update, save: st.save },
    once: st.once,
    log: logger.log,
    table: (name, columns) => runtimeTable_(dep.name, name, columns, mask),
    event: (message) => event('Pod', pod.name, mask(message).slice(0, 1000)),
    // no schedule slot fires before this time (ms); a run or a webhook still does
    sleepUntil: (ms) => { runtimeProps().setProperty(RUNTIME_PROP.sleep + dep.name, String(Number(ms) || 0)); runtimeWake(); },
  };
}

function runtimeLogger_(mask) {
  const lines = [];
  const fmt = (args) => Array.prototype.map.call(args, a => (typeof a === 'string' ? a : (a instanceof Error ? (a.stack || a.message) : JSON.stringify(a)))).join(' ');
  const log = function () { lines.push(mask(fmt(arguments))); };
  return { lines: lines, log: log, console: { log: log, info: log, warn: log, error: log } };
}

// The caller holds the script lock. Returns {ok, result} or {ok:false, error}; never throws.
function runtimeInvoke_(dep, pod, ev, opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  const props = runtimeProps().getProperties();     // one read for the masker and the pod's status
  const mask = runtimeMasker(props);
  const logger = runtimeLogger_(mask);
  const st = runtimeState_(dep.name);
  let status;
  try { status = JSON.parse(props[RUNTIME_PROP.pod + dep.name] || '{}'); } catch (e) { status = {}; }
  try {
    if (opts.slot && (st.doc().cron[ev.schedule] || 0) >= opts.slot) return { ok: true, skipped: true };   // fired before
    const code = opts.code || runtimeCode_(dep);
    const mod = { exports: {} };
    new Function('exports', 'module', 'console', code.source)(mod.exports, mod, logger.console);
    const fn = (ev.type === 'run' && ev.fn && typeof mod.exports[ev.fn] === 'function') ? mod.exports[ev.fn] : mod.exports.handle;
    if (typeof fn !== 'function') throw new Error('the module exports no handle(event, env)');
    const result = fn(ev, runtimeEnv_(dep, pod, st, logger, mask, props));
    if (result && typeof result.then === 'function') throw new Error('handlers must be synchronous: Apps Script cannot run async functions');
    if (opts.slot) st.doc().cron[ev.schedule] = opts.slot;
    st.save();
    if (status.code !== code.sha256 && status.code) event('Pod', pod.name, 'code updated to ' + code.sha256.slice(0, 19));
    const wasFailing = status.failures > 0;
    Object.assign(status, { failures: 0, backoff_until: '', last_run: new Date(now).toISOString(), last_event: ev.type, code: code.sha256 });
    runtimeProps().setProperty(RUNTIME_PROP.pod + dep.name, JSON.stringify(status));
    if (logger.lines.length) runtimeLog_(pod, runtimeLogHeader_(ev, now) + logger.lines.join('\n'), false);
    if (wasFailing) runtimeSetMessage_(pod.name, '');
    return { ok: true, result: result === undefined ? null : JSON.parse(mask(JSON.stringify(result))), logs: logger.lines };
  } catch (err) {
    logger.log(err);
    runtimeLog_(pod, runtimeLogHeader_(ev, now) + logger.lines.join('\n'), true);
    const msg = runtimeFail_(dep, pod, mask(err && err.message || err), now, ev.type === 'schedule', mask);
    return { ok: false, error: msg, logs: logger.lines };
  }
}

function runtimeLogHeader_(ev, now) {
  return '--- ' + new Date(now).toISOString() + ' ' + ev.type + (ev.schedule ? ' ' + ev.schedule : '') + (ev.fn ? ' ' + ev.fn : '') + '\n';
}

// Records a crash: restart count, last error, exponential backoff for schedule ticks.
function runtimeFail_(dep, pod, message, now, backoff, mask) {
  message = (mask || runtimeMasker())(message);
  const status = runtimePropJSON(RUNTIME_PROP.pod + dep.name, {});
  status.restarts = (status.restarts || 0) + 1;
  status.failures = (status.failures || 0) + 1;
  status.last_error = message.slice(0, 500);
  status.last_failure = new Date(now).toISOString();
  let text = 'Error: ' + message;
  if (backoff) {
    const wait = Math.min(RUNTIME_BACKOFF_MAX_MS, 60000 * Math.pow(2, status.failures - 1));
    status.backoff_until = new Date(now + wait).toISOString();
    text = 'CrashLoopBackOff (restarts ' + status.restarts + ', next try ' + status.backoff_until + '): ' + message;
  }
  runtimeProps().setProperty(RUNTIME_PROP.pod + dep.name, JSON.stringify(status));
  runtimeSetMessage_(pod.name, text.slice(0, 1000));
  event('Pod', pod.name, text.slice(0, 1000));
  return message;
}

function runtimeSetMessage_(podName, message) {
  const sh = ss().getSheetByName('Pods');
  const grid = sh.getDataRange().getValues();
  const col = grid[0].indexOf('message');
  for (let r = 1; r < grid.length; r++) {
    if (String(grid[r][0]) === String(podName)) { sh.getRange(r + 1, col + 1, 1, 1).setValues([[message]]); return; }
  }
}

// Logs tab: `tail` is the current instance, `previous` the instance before the last crash.
function runtimeLog_(pod, text, crashed) {
  const sh = ss().getSheetByName('Logs');
  const grid = sh.getDataRange().getValues();
  const header = grid[0];
  let row = -1;
  for (let r = 1; r < grid.length; r++) if (String(grid[r][0]) === String(pod.name)) row = r;
  const cur = row > 0 ? { tail: String(grid[row][header.indexOf('tail')] || ''), previous: String(grid[row][header.indexOf('previous')] || '') } : { tail: '', previous: '' };
  const tail = (cur.tail + text + '\n').slice(-LOG_TAIL_MAX_CHARS);
  const out = { name: pod.name, node: RUNTIME_NODE, updated_at: new Date().toISOString(),
                tail: crashed ? '' : tail, previous: crashed ? tail : cur.previous };
  const values = [TABS.Logs.map(h => out[h] === undefined ? '' : out[h])];
  const at = row > 0 ? row + 1 : Math.max(2, sh.getLastRow() + 1);
  sh.getRange(at, 1, 1, TABS.Logs.length).setValues(values);
}

// ---------- webhooks ----------
// POST <exec url>?pod=<deployment>&key=<webhook key>. The body goes to the pod as
// event.body (and event.json if it parses). The answer is HTTP 200 from
// HtmlService: ContentService answers with a 302, which senders such as Telegram
// treat as a failure and redeliver. The runtime uses exactly that on purpose when
// the update must come again: while paused, while the lock is busy, and after a
// crash (up to RUNTIME_WEBHOOK_ATTEMPTS deliveries of the same body).
function runtimeWebhook(e) {
  const p = e.parameter || {};
  const ok = (text) => HtmlService.createHtmlOutput(text || 'ok');
  const redeliver = (text) => ContentService.createTextOutput(text);
  const want = runtimeProps().getProperty(RUNTIME_PROP.webhook + p.pod);
  if (!want || String(p.key || '') !== want) return ok('forbidden');
  const body = (e.postData && e.postData.contents) || '';
  // everything that only reads happens before the lock: the lock is held for the handler alone
  const dep = readTab('Deployments').find(d => d.name === p.pod && isScriptDeployment(d));
  if (!dep) return ok('gone');
  let code;
  try { code = runtimeCode_(dep); } catch (err) { code = null; }   // retried under the lock
  let json = null;
  try { json = JSON.parse(body); } catch (err) { json = null; }
  const parameter = {};
  Object.keys(p).filter(k => k !== 'key' && k !== 'pod').forEach(k => { parameter[k] = p[k]; });
  const res = skTryLocked(() => {
    let leader = runtimeLeader_(dep.name, readTab('Pods'));
    if (!leader) leader = runtimeLeader_(dep.name, runtimeSyncPods_(Date.now()));
    if (!leader) return 'paused';
    const out = runtimeInvoke_(dep, leader, { type: 'webhook', body: body, json: json, parameter: parameter }, { code: code });
    if (out.ok) return 'ok';
    const id = skSha256(skBytes(body)).slice(7, 23);
    const attempts = runtimePropJSON(RUNTIME_PROP.attempts + dep.name, {});
    attempts[id] = (attempts[id] || 0) + 1;
    const keys = Object.keys(attempts);
    if (keys.length > 50) keys.slice(0, keys.length - 50).forEach(k => delete attempts[k]);
    if (attempts[id] >= RUNTIME_WEBHOOK_ATTEMPTS) {
      // never answer 200 without keeping the body: it goes to the dead-letter table
      runtimeTable_(dep.name, 'deadletter', ['body', 'error']).append({ body: body, error: out.error });
      delete attempts[id];
      runtimeProps().setProperty(RUNTIME_PROP.attempts + dep.name, JSON.stringify(attempts));
      event('Pod', leader.name, 'webhook delivery failed ' + RUNTIME_WEBHOOK_ATTEMPTS + ' times; kept in table-' + dep.name + '-deadletter');
      return 'dropped';
    }
    runtimeProps().setProperty(RUNTIME_PROP.attempts + dep.name, JSON.stringify(attempts));
    return 'retry';
  }, RUNTIME_WEBHOOK_LOCK_MS);
  if (!res.locked) return redeliver('busy');
  if (res.value === 'paused' || res.value === 'retry') return redeliver(res.value);
  return ok(res.value);
}

// ---------- API ----------
function runtimeOp(body) {
  const ops = {
    run: () => runtimeRun(body.name, body.args || []),
    secretSet: () => runtimeSecretSet(body.name, body.data),
    secretDelete: () => skLocked(() => {
      if (!runtimeProps().getProperty(RUNTIME_PROP.secret + body.name)) throw new Error('no such secret ' + body.name);
      runtimeProps().deleteProperty(RUNTIME_PROP.secret + body.name);
      event('Secret', body.name, 'deleted');
      return { deleted: body.name };
    }),
    webhook: () => skLocked(() => {
      const dep = readTab('Deployments').find(d => d.name === body.name && isScriptDeployment(d));
      if (!dep) throw new Error('no script deployment ' + body.name);
      const k = RUNTIME_PROP.webhook + dep.name;
      if (body.rotate || !runtimeProps().getProperty(k)) runtimeProps().setProperty(k, Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''));
      return { query: '?pod=' + encodeURIComponent(dep.name) + '&key=' + runtimeProps().getProperty(k) };
    }),
  };
  if (!ops[body.action]) return null;
  try { return Object.assign({ ok: true }, ops[body.action]()); }
  catch (err) { return { error: runtimeMasker()(String(err.message || err)) }; }
}

// skctl run <deployment> -- <fn> <args...>: the schedule of that pod is paused for
// the run, and the run holds the same lock as every other invocation.
function runtimeRun(name, args) {
  return skLocked(() => {
    const dep = readTab('Deployments').find(d => d.name === name && isScriptDeployment(d));
    if (!dep) throw new Error('no script deployment ' + name);
    const leader = runtimeLeader_(dep.name, runtimeSyncPods_(Date.now()));
    if (!leader) throw new Error(name + ' has no running pod (scaled to 0?)');
    runtimeProps().setProperty(RUNTIME_PROP.run + name, String(Date.now()));
    try {
      const out = runtimeInvoke_(dep, leader, { type: 'run', fn: args[0] || '', args: args.slice(1) });
      if (!out.ok) return { pod: leader.name, error: out.error, logs: out.logs };
      return { pod: leader.name, result: out.result, logs: out.logs };
    } finally {
      runtimeProps().deleteProperty(RUNTIME_PROP.run + name);
    }
  }, 60000);
}

function runtimeGet(p) {
  if (p.kind === 'secrets') {
    return { items: runtimeSecretNames().map(n => ({ name: n, keys: Object.keys(runtimePropJSON(RUNTIME_PROP.secret + n, {})).sort() })) };
  }
  if (p.kind === 'budget') {
    const today = runtimePropJSON(RUNTIME_PROP.quota + new Date().toISOString().slice(0, 10), null);
    return { items: readTab(RUNTIME_QUOTA_TAB), today: today, budget_ms: RUNTIME_QUOTA_MS };
  }
  if (p.kind === 'scripts') {
    const pods = readTab('Pods');
    const mask = runtimeMasker();
    const items = readTab('Deployments').filter(isScriptDeployment).map(d => {
      const s = runtimePropJSON(RUNTIME_PROP.pod + d.name, {});
      const leader = runtimeLeader_(d.name, pods);
      return { name: d.name, pod: leader ? leader.name : '', replicas: d.replicas, schedule: d.schedule || '',
               webhook: !!runtimeProps().getProperty(RUNTIME_PROP.webhook + d.name), restarts: s.restarts || 0,
               last_run: s.last_run || '', last_event: s.last_event || '', backoff_until: s.backoff_until || '',
               last_error: mask(s.last_error || ''), code: s.code || '' };
    });
    return { items: p.name ? items.filter(i => i.name === p.name) : items };
  }
  return null;
}

// Called by setup(): the node, the Volumes tab, and the triggers that replace the
// plain reconcile timer (runtimeTick reconciles whenever something is not converged).
function setupRuntime() {
  sheetstorEnsure();
  skLocked(() => runtimeHeartbeat_(Date.now()));
  runtimeInstallTriggers_(Date.now());
}
