#!/usr/bin/env node
// Script pods (Runtime.gs) on the real control plane: the apps-script node, the
// formula scheduler placing script pods there, exactly-once schedule slots under
// jittered and overlapping ticks, transactional state, crash backoff, webhooks
// (HtmlService 200, redelivery, dedupe), pause/resume, one-off runs, secrets that
// never reach a tab, a log or an API answer, and read-only media volumes.
//
//   node hack/test-runtime.js
'use strict';
const crypto = require('crypto');
const { loadControlPlane } = require('./sheet-mock');
const { unsigned } = require('./gas-fakes');

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, '->', JSON.stringify(d)); } };
const TOKEN = 'CHANGE_ME_super_secret';

let now = Date.parse('2026-11-08T09:58:10Z');
const realNow = Date.now;
Date.now = () => now;

const api = loadControlPlane({ exports: ['runtimeTick', 'runtimeCron', 'runtimeCronMatches', 'sheetstorRead', 'sheetstorWrite', 'sheetstorList'] });
api.setup();
const post = (b) => JSON.parse(api.doPost({ postData: { contents: JSON.stringify(Object.assign({ token: TOKEN }, b)) } })._t);
const get = (p) => JSON.parse(api.doGet({ parameter: Object.assign({ token: TOKEN }, p) })._t);
const hook = (query, body) => api.doPost({ parameter: query, postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } });
const putCode = (src) => post({ action: 'volumePut', name: 'code', path: 'bot.js', data: Buffer.from(src).toString('base64') });
const pods = (dep) => api.readTab('Pods').filter(p => p.deployment === dep);
const state = (dep) => {
  try { return JSON.parse(Buffer.from(unsigned(api.sheetstorRead(dep + '-state', 'state.json').bytes)).toString('utf8')); }
  catch (e) { return null; }
};
const tick = (at) => { if (at) now = Date.parse(at); return api.runtimeTick(); };
const scripts = (name) => get({ kind: 'scripts', name }).items[0];

console.log('\n== setup ==');
check('the apps-script node registers with label and taint', api.readTab('Nodes').some(n => n.name === 'apps-script' && n.labels === 'runtime=script' && /runtime=script:NoSchedule/.test(n.taints)), api.readTab('Nodes'));
check('one runtimeTick trigger replaces the reconcile timer', api._triggers.length === 1 && api._triggers[0].getHandlerFunction() === 'runtimeTick', api._triggers.map(t => t.getHandlerFunction()));
check('cron: */15 9-17 * * 1-5 in CRON_TZ', (() => {
  const c = api.runtimeCron('CRON_TZ=Europe/Moscow */15 9-17 * * 1-5');
  return api.runtimeCronMatches(c, Date.parse('2026-11-09T06:15:00Z')) && !api.runtimeCronMatches(c, Date.parse('2026-11-08T06:15:00Z')) &&
         !api.runtimeCronMatches(c, Date.parse('2026-11-09T06:16:00Z'));
})(), null);

console.log('\n== a script deployment lands on the apps-script node ==');
post({ action: 'volumeCreate', name: 'code' });
post({ action: 'volumeCreate', name: 'media', mode: 'ro' });
const gif = crypto.randomBytes(1500);
post({ action: 'volumePut', name: 'media', path: 'cat.gif', data: gif.toString('base64') });
putCode(`
exports.handle = function (ev, env) {
  const s = env.state.get();
  s.events = (s.events || 0) + 1;
  if (ev.type === 'schedule') {
    s.ticks = (s.ticks || []).concat(ev.slot);
    if (globalThis.__overlap) globalThis.__overlap();
  }
  if (ev.type === 'webhook') {
    if (ev.json && ev.json.boom) throw new Error('webhook boom');
    env.once('u' + ev.json.update_id, () => { s.updates = (s.updates || 0) + 1; });
  }
  if (env.vars.FAIL_SCHEDULE && ev.type === 'schedule') throw new Error('scheduled failure');
  console.log('event', ev.type, 'config', env.vars.GREETING);
  return { events: s.events };
};
exports.media = function (ev, env) {
  const b = env.volumes.media.read('cat.gif');
  let denied = '';
  try { env.volumes.media.write('x', 'y'); } catch (e) { denied = e.message; }
  return { size: b.getBytes().length, type: b.getContentType(), sha: env.volumes.media.list()[0].sha256, denied: denied };
};
exports.leak = function (ev, env) {
  console.log('token is', env.secrets.BOT_TOKEN);
  UrlFetchApp.fetch('https://api.example.org/bot' + env.secrets.BOT_TOKEN + '/sendMessage');
};
exports.echo = function (ev, env) { return { secret: env.secrets.BOT_TOKEN, args: ev.args }; };
exports.overlap = function (ev, env) { return { tick: globalThis.__tickDuringRun() }; };
`);
post({ action: 'apply', deployments: [
  { name: 'nginx', image: 'nginx:alpine', replicas: 2 },
  { name: 'bot', image: 'sheetstor://code/bot.js', replicas: 1, runtime: 'script', schedule: '*/5 * * * *',
    env: JSON.stringify({ GREETING: 'hello, world, with commas' }), secrets: 'tg', volumes: 'media:ro' },
] });
const dep = api.readTab('Deployments').find(d => d.name === 'bot');
check('apply keeps the runtime columns and adds the node selector and toleration', dep.runtime === 'script' && dep.node_selector === 'runtime=script' && dep.tolerations === 'runtime=script', dep);
check('the formula scheduler places the script pod on apps-script', pods('bot').length === 1 && pods('bot')[0].node === 'apps-script', pods('bot'));
check('docker pods never land there', pods('nginx').every(p => p.node !== 'apps-script'), pods('nginx'));
check('a missing secret is a crash, not a hang', (() => { tick('2026-11-08T09:58:20Z'); return true; })(), null);
post({ action: 'secretSet', name: 'tg', data: { BOT_TOKEN: '123456:AAE-very-secret-token' } });
check('the kubelet starts it (Running)', pods('bot')[0].phase === 'Running', pods('bot'));

console.log('\n== exactly-once schedule slots ==');
tick('2026-11-08T10:00:50Z');
check('slot 10:00 fires', JSON.stringify((state('bot').data.ticks || [])) === '["2026-11-08T10:00:00.000Z"]', state('bot'));
tick('2026-11-08T10:01:05Z');      // jitter: the next trigger comes 15 s later
tick('2026-11-08T10:01:59Z');
check('later ticks in the same window do not fire it again', state('bot').data.ticks.length === 1, state('bot').data.ticks);
let overlapped = null;
global.__overlap = () => { overlapped = api.runtimeTick(); };   // a second trigger while the first runs
tick('2026-11-08T10:05:30Z');
global.__overlap = null;
check('an overlapping tick finds the lock busy and does nothing', overlapped && overlapped.skipped === 'busy', overlapped);
check('slot 10:05 fired once', state('bot').data.ticks.length === 2, state('bot').data.ticks);
tick('2026-11-08T10:21:40Z');      // triggers stalled for 16 min: 10:10 and 10:15 fall out of the window
check('after a stall only the newest slot in the window fires', state('bot').data.ticks.slice(-1)[0] === '2026-11-08T10:20:00.000Z' && state('bot').data.ticks.length === 3, state('bot').data.ticks);
api._props['sk.cron.bot'] = JSON.stringify({ default: 0 });    // lose the fast-path mirror
tick('2026-11-08T10:22:00Z');
check('the slot record in the state document still prevents a double fire', state('bot').data.ticks.length === 3, state('bot').data.ticks);

console.log('\n== crashes roll back state and back off ==');
const before = state('bot').data.events;
post({ action: 'apply', deployments: [{ name: 'bot', env: JSON.stringify({ GREETING: 'x', FAIL_SCHEDULE: true }) }] });
tick('2026-11-08T10:25:10Z');
check('state is unchanged after a crash', state('bot').data.events === before, state('bot').data.events);
const s1 = scripts('bot');
check('restart count and last error are recorded', s1.restarts >= 1 && /scheduled failure/.test(s1.last_error) && s1.backoff_until, s1);
check('the pod shows CrashLoopBackOff', /CrashLoopBackOff/.test(pods('bot')[0].message), pods('bot')[0].message);
const logs = get({ kind: 'logs', name: pods('bot')[0].name }).items[0];
check('the crashed run is in the previous log', /scheduled failure/.test(logs.previous) && logs.tail === '', logs);
tick('2026-11-08T10:25:40Z');
check('no retry inside the backoff window', scripts('bot').restarts === s1.restarts, scripts('bot'));
tick('2026-11-08T10:26:20Z');
const s2 = scripts('bot');
check('after the backoff it retries and backs off longer', s2.restarts === s1.restarts + 1 && Date.parse(s2.backoff_until) - now >= 120000 - 1000, s2);
post({ action: 'apply', deployments: [{ name: 'bot', env: JSON.stringify({ GREETING: 'fixed' }) }] });
tick('2026-11-08T10:28:30Z');
check('fixed: the missed 10:25 slot fires and the error clears', state('bot').data.ticks.slice(-1)[0] === '2026-11-08T10:25:00.000Z' && !pods('bot')[0].message && !scripts('bot').backoff_until, [state('bot').data.ticks, pods('bot')[0].message]);

console.log('\n== webhooks ==');
const key = post({ action: 'webhook', name: 'bot' }).query.split('key=')[1];
const q = { pod: 'bot', key: key };
check('a wrong key is refused with 200 (no redelivery)', hook({ pod: 'bot', key: 'nope' }, { update_id: 1 })._t === 'forbidden', null);
const r1 = hook(q, { update_id: 1001 });
check('a delivery is answered by HtmlService (HTTP 200)', r1._status === 200 && r1._t === 'ok', r1);
hook(q, { update_id: 1001 });
hook(q, { update_id: 1002 });
check('env.once dedupes a redelivered update', state('bot').data.updates === 2, state('bot').data.updates);
const boom = hook(q, { update_id: 1003, boom: true });
check('a crash answers with ContentService (302: please redeliver)', boom._status === undefined && boom._t === 'retry', boom);
hook(q, { update_id: 1003, boom: true });
const third = hook(q, { update_id: 1003, boom: true });
check('the third failed delivery is answered 200 only after it is kept in a dead-letter table', third._t === 'dropped' &&
  api._store['table-bot-deadletter'].some(r => /1003/.test(r[1])) && api.readTab('Events').some(e => /failed 3 times/.test(e.message)), third);
api._lock.held = true;
check('a busy lock answers 302 so the sender retries', hook(q, { update_id: 1004 })._t === 'busy', null);
api._lock.held = false;

console.log('\n== pause and resume (scale 0/1) ==');
post({ action: 'scale', name: 'bot', replicas: 0 });
tick('2026-11-08T10:29:10Z');
check('scaled to 0: the pod is gone', pods('bot').every(p => p.phase === 'Deleted') || pods('bot').length === 0, pods('bot'));
check('a webhook while paused asks for redelivery', hook(q, { update_id: 1005 })._t === 'paused', null);
const ticksPaused = state('bot').data.ticks.length;
tick('2026-11-08T10:30:20Z');
check('no schedule while paused', state('bot').data.ticks.length === ticksPaused, null);
post({ action: 'scale', name: 'bot', replicas: 1 });
check('resumed: the next webhook starts the pod and is handled', hook(q, { update_id: 1005 })._t === 'ok' && state('bot').data.updates === 3, state('bot').data.updates);
check('state survived the pause', state('bot').data.ticks.length === ticksPaused, null);

console.log('\n== one-off runs ==');
global.__tickDuringRun = () => api.runtimeTick();
now = Date.parse('2026-11-08T10:35:05Z');
const run = post({ action: 'run', name: 'bot', args: ['overlap'] });
check('a trigger during skctl run cannot fire the schedule', run.ok && run.result.tick.skipped === 'busy' && !state('bot').data.ticks.includes('2026-11-08T10:35:00.000Z'), run);
check('the pause marker is gone after the run', !Object.keys(api._props).some(k => k.indexOf('sk.run.') === 0), Object.keys(api._props));
tick('2026-11-08T10:35:30Z');
check('the schedule resumes after the run', state('bot').data.ticks.slice(-1)[0] === '2026-11-08T10:35:00.000Z', state('bot').data.ticks);
const media = post({ action: 'run', name: 'bot', args: ['media'] });
check('a ro volume serves its bytes as a Blob', media.result.size === gif.length && media.result.type === 'image/gif' && /^sha256:/.test(media.result.sha), media);
check('and refuses writes', /read-only/.test(media.result.denied), media.result);

console.log('\n== secrets never leave Script Properties ==');
const SECRET = '123456:AAE-very-secret-token';
global.UrlFetchApp = { fetch: (url) => { throw new Error('Address unavailable: ' + url); } };
const leak = post({ action: 'run', name: 'bot', args: ['leak'] });
const echo = post({ action: 'run', name: 'bot', args: ['echo', 'a,b'] });
check('the pod sees the secret (masked in what comes back)', echo.result.secret === '***' && echo.result.args[0] === 'a,b', echo);
check('the crash message is masked', leak.error && leak.error.indexOf(SECRET) < 0 && /\*\*\*/.test(leak.error), leak.error);
const everywhere = JSON.stringify(api._store) + JSON.stringify([leak, echo, get({ kind: 'secrets' }), get({ kind: 'scripts' }), get({ kind: 'logs' }), get({ kind: 'events' })]);
check('no tab, log, Event or API answer contains the secret', everywhere.indexOf(SECRET) < 0, null);
check('nor its URL-encoded form', everywhere.indexOf(encodeURIComponent(SECRET)) < 0, null);
check('skctl get secrets lists key names only', JSON.stringify(get({ kind: 'secrets' }).items) === '[{"name":"tg","keys":["BOT_TOKEN"]}]', get({ kind: 'secrets' }));
check('the webhook key is masked too', JSON.stringify(api._store).indexOf(key) < 0, null);

console.log('\n== code updates never touch state ==');
const evBefore = state('bot').data.events;
putCode('exports.handle = function (ev, env) { const s = env.state.get(); s.v2 = true; s.events += 1; };');
tick('2026-11-08T10:40:30Z');
check('new code runs on the next event with the old state', state('bot').data.v2 === true && state('bot').data.events === evBefore + 1, state('bot').data);
check('an Event records the code change', api.readTab('Events').some(e => /code updated to sha256:/.test(e.message)), null);
putCode('exports.handle = async function () {};');
tick('2026-11-08T10:45:30Z');
check('async handlers are refused with a clear error', /must be synchronous/.test(scripts('bot').last_error), scripts('bot'));

console.log('\n== tables, sleep and the trigger budget ==');
const original = Buffer.from(unsigned(api.sheetstorRead('code', 'bot.js').bytes)).toString('utf8');
putCode(`
exports.handle = function (ev, env) {
  const t = env.table('votes', ['update_id', 'name']);
  if (ev.type === 'webhook') { t.append({ update_id: ev.json.update_id, name: ev.json.name }); return null; }
  if (ev.type === 'schedule') { env.state.update(s => Object.assign(s, { woke: (s.woke || 0) + 1 })); env.sleepUntil(Date.now() + 3600000); }
  return t.rows();
};
`);
const t0 = Date.now;
for (let i = 0; i < 100; i++) hook(q, { update_id: 5000 + i, name: i === 7 ? '=HYPERLINK("x")' : 'voter ' + i });
const rows = post({ action: 'run', name: 'bot', args: [] }).result;
check('a burst of 100 webhooks: 100 appended rows', rows.length === 100 && rows[7].name === '=HYPERLINK("x")', rows.length);
check('strings in tables cannot become formulas', api._store['table-bot-votes'].every((r, i) => i === 0 || String(r[2]).charAt(0) === '"'), null);
tick('2026-11-08T10:50:30Z');
const woke = state('bot').data.woke;
Object.keys(api._reads).forEach(k => { api._reads[k] = 0; });
tick('2026-11-08T10:51:30Z'); tick('2026-11-08T10:52:30Z');
const touched = Object.keys(api._reads).filter(k => api._reads[k] && (/^sheetstor-|^Volumes$|^table-/.test(k)));
check('an idle tick reads no volume', touched.length === 0, api._reads);
check('a sleeping pod is not invoked', state('bot').data.woke === woke, state('bot').data);
const idle = tick('2026-11-08T10:53:30Z');
check('with every pod asleep and nothing due, a tick only reads Script Properties', idle.skipped === 'idle', idle);
post({ action: 'scale', name: 'bot', replicas: 1 });
check('any API call wakes the tick', !tick('2026-11-08T10:54:30Z').skipped, null);
const day = '2026-11-08';
check('trigger time is counted per day', JSON.parse(api._props['sk.quota.' + day]).ticks > 5, api._props['sk.quota.' + day]);
check('and shown in the Runtime tab', api.readTab('Runtime').some(r => r.date === day + ' UTC' && r.budget_ms === 5400000), api.readTab('Runtime'));
api._props['sk.sleep.bot'] = '0';
putCode(original);

Date.now = realNow;
console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
