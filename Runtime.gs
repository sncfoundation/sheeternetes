/**
 * Script pods — a serverless pod runtime for Sheeternetes.
 *
 * A Deployment with `runtime: script` runs as JavaScript inside this very Apps
 * Script project: no Docker host, no kubelet.sh. The project registers itself as
 * the node `apps-script` (label and NoSchedule taint `runtime=script`), so the
 * ordinary reconcile loop and the formula scheduler place script pods on it like
 * any other pod. This file is that node's kubelet:
 *
 *   runtimeTick()      every minute: renew the node lease, reconcile when needed,
 *                      move pods through their phases, fire due `schedule` slots;
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
const RUNTIME_LEASE_MS = 5 * 60 * 1000;        // the node's heartbeat is stamped this far ahead...
const RUNTIME_RENEW_MS = 3 * 60 * 1000;        // ...and renewed when less than this is left
const RUNTIME_RECONCILE_EVERY_MS = 5 * 60 * 1000;
const RUNTIME_CATCHUP_MS = 15 * 60 * 1000;     // a late tick still fires slots this old
const RUNTIME_BACKOFF_MAX_MS = 60 * 60 * 1000;
const RUNTIME_RUN_PAUSE_MS = 6 * 60 * 1000;    // a one-off run's pause marker expires (Apps Script's execution limit)
const RUNTIME_WEBHOOK_ATTEMPTS = 3;
const RUNTIME_ONCE_KEEP = 1000;
const RUNTIME_STATE_PATH = 'state.json';
const RUNTIME_IMAGE = /^sheetstor:\/\/([a-z0-9-]+)\/(.+)$/;
const RUNTIME_PROP = { secret: 'sk.secret.', webhook: 'sk.webhook.', pod: 'sk.pod.', cron: 'sk.cron.', run: 'sk.run.', attempts: 'sk.attempts.',
                       sleep: 'sk.sleep.', quota: 'sk.quota.', flushed: 'sk.quota-flushed', reconciled: 'sk.reconciled' };
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

function runtimeMasker() {
  const values = [];
  const all = runtimeProps().getProperties();
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
  const fresh = n && Date.parse(String(n.last_heartbeat)) - now > RUNTIME_RENEW_MS && n.status === 'Ready';
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
// An idle tick reads Nodes, Deployments and Pods once and Script Properties once,
// and touches no volume: a converged cluster with sleeping pods costs well under a
// second of the daily trigger budget.
function runtimeTick() {
  const now = Date.now();
  let out;
  const first = skTryLocked(() => {
    const props = runtimeProps().getProperties();
    const nodes = readTab('Nodes');
    runtimeHeartbeat_(now, nodes);
    const deps = readTab('Deployments');
    if (deps.map(runtimeDefaults).some(Boolean)) writeTab('Deployments', deps);
    const pods = readTab('Pods');
    if (runtimeNeedsReconcile_(deps, pods, nodes, now, props)) return { reconcile: true };
    return { fired: runtimeFireSchedules_(now, deps, runtimeSyncPods_(now, pods), props) };
  });
  if (!first.locked) {
    out = { skipped: 'busy' };
  } else if (!first.value.reconcile) {
    out = { fired: first.value.fired, reconciled: false };
  } else {
    reconcile();
    runtimeProps().setProperty(RUNTIME_PROP.reconciled, String(now));
    const second = skTryLocked(() => runtimeFireSchedules_(now, readTab('Deployments'), runtimeSyncPods_(now, readTab('Pods')), runtimeProps().getProperties()));
    out = second.locked ? { fired: second.value, reconciled: true } : { skipped: 'busy' };
  }
  runtimeQuota_(now);
  return out;
}

// Trigger time per day, in Script Properties on every tick and in the Runtime tab
// every few minutes: date, ticks, trigger_ms, max_tick_ms, budget_ms, used_percent.
// (Apps Script also counts the start-up of each execution, which a script cannot see.)
function runtimeQuota_(started) {
  const p = runtimeProps();
  const day = new Date(started).toISOString().slice(0, 10);
  const q = runtimePropJSON(RUNTIME_PROP.quota + day, { ticks: 0, ms: 0, max: 0 });
  const took = Date.now() - started;
  q.ticks += 1; q.ms += took; q.max = Math.max(q.max, took);
  p.setProperty(RUNTIME_PROP.quota + day, JSON.stringify(q));
  if (started - Number(p.getProperty(RUNTIME_PROP.flushed) || 0) < RUNTIME_QUOTA_FLUSH_MS) return q;
  p.setProperty(RUNTIME_PROP.flushed, String(started));
  let sh = ss().getSheetByName(RUNTIME_QUOTA_TAB);
  const header = ['date', 'ticks', 'trigger_ms', 'max_tick_ms', 'budget_ms', 'used_percent'];
  if (!sh) { sh = ss().insertSheet(RUNTIME_QUOTA_TAB); sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold'); }
  const label = day + ' UTC';     // not a date to Sheets, so it stays text
  const days = sh.getDataRange().getValues().map(r => String(r[0]));
  let row = days.indexOf(label) + 1;
  if (row <= 1) row = Math.max(2, sh.getLastRow() + 1);
  sh.getRange(row, 1, 1, header.length).setValues([[label, q.ticks, q.ms, q.max, RUNTIME_QUOTA_MS, Math.round(q.ms / RUNTIME_QUOTA_MS * 1000) / 10]]);
  // old days are dropped from Script Properties once they are in the tab
  p.getKeys().filter(k => k.indexOf(RUNTIME_PROP.quota) === 0 && k < RUNTIME_PROP.quota + day).forEach(k => p.deleteProperty(k));
  return q;
}

// The control loop is skipped while everything is converged: Apps Script grants a
// consumer account 90 minutes of trigger time a day.
function runtimeNeedsReconcile_(deps, pods, nodes, now, props) {
  const last = Number((props || {})[RUNTIME_PROP.reconciled] || 0);
  if (now - last >= RUNTIME_RECONCILE_EVERY_MS) return true;
  if (readTab('Autoscale').length) return true;          // the HPA wants a pass every minute
  if (nodes.some(n => n.status === 'Ready' && now - Date.parse(String(n.last_heartbeat)) >= HEARTBEAT_TIMEOUT_MS)) return true;
  // a Terminating pod without a node waits for nobody: it does not make the loop run
  if (pods.some(p => p.phase === 'Pending' || p.phase === 'Scheduled' || p.phase === 'Deleted' ||
                     (p.phase === 'Terminating' && p.node))) return true;
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
    if (sheetstorVolumes().some(v => v.name === vol) && sheetstorList_(vol).some(f => f.path === RUNTIME_STATE_PATH)) {
      text = Utilities.newBlob(sheetstorRead_(vol, RUNTIME_STATE_PATH).bytes).getDataAsString();
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
      sheetstorWrite_(vol, RUNTIME_STATE_PATH, text);
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
// The source is cached per volume generation: one registry read when nothing changed.
function runtimeCode_(dep) {
  const m = RUNTIME_IMAGE.exec(String(dep.image || ''));
  if (!m) throw new Error('image must be sheetstor://<volume>/<path>, got "' + dep.image + '"');
  const vol = sheetstorVolume_(m[1]);
  const key = 'sk.code.' + vol.name + '.' + vol.generation + '.' + m[2];
  const cache = CacheService.getScriptCache();
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  const f = sheetstorRead_(m[1], m[2]);
  const code = { source: Utilities.newBlob(f.bytes).getDataAsString(), sha256: f.sha256 };
  const text = JSON.stringify(code);
  if (text.length < 90000) cache.put(key, text, 21600);
  return code;
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
    rows: () => {
      const g = sh.getDataRange().getValues();
      const h = g.shift() || [];
      return g.filter(r => r[0] !== '').map(r => { const o = {}; h.forEach((k, i) => { o[k] = dec(r[i]); }); return o; });
    },
  };
}

function runtimeEnv_(dep, pod, st, logger, mask) {
  let vars = {};
  if (String(dep.env || '').trim()) {
    try { vars = JSON.parse(String(dep.env)); } catch (e) { throw new Error('env column must be a JSON object: ' + e.message); }
  }
  const secrets = {};
  kvList(dep.secrets).forEach(name => {
    const v = runtimeProps().getProperty(RUNTIME_PROP.secret + name);
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
    sleepUntil: (ms) => runtimeProps().setProperty(RUNTIME_PROP.sleep + dep.name, String(Number(ms) || 0)),
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
  const mask = runtimeMasker();
  const logger = runtimeLogger_(mask);
  const st = runtimeState_(dep.name);
  const status = runtimePropJSON(RUNTIME_PROP.pod + dep.name, {});
  try {
    if (opts.slot && (st.doc().cron[ev.schedule] || 0) >= opts.slot) return { ok: true, skipped: true };   // fired before
    const code = opts.code || runtimeCode_(dep);
    const mod = { exports: {} };
    new Function('exports', 'module', 'console', code.source)(mod.exports, mod, logger.console);
    const fn = (ev.type === 'run' && ev.fn && typeof mod.exports[ev.fn] === 'function') ? mod.exports[ev.fn] : mod.exports.handle;
    if (typeof fn !== 'function') throw new Error('the module exports no handle(event, env)');
    const result = fn(ev, runtimeEnv_(dep, pod, st, logger, mask));
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

// Called by setup(): the node, the Volumes tab, and one trigger that replaces the
// plain reconcile timer (runtimeTick reconciles whenever something is not converged).
function setupRuntime() {
  sheetstorEnsure();
  skLocked(() => runtimeHeartbeat_(Date.now()));
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'runtimeTick' || t.getHandlerFunction() === 'reconcile') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runtimeTick').timeBased().everyMinutes(1).create();
}
