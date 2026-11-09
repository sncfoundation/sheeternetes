/**
 * skctl selftest — the control plane against real, empty Google Sheets.
 *
 * The test suite runs Code.gs against hack/sheet-mock.js, which can only emulate
 * what we already know about Google Sheets. Formula parsing in the spreadsheet's
 * locale was learned the hard way on the live cluster, so this check asks Google
 * itself: for every locale it creates a scratch spreadsheet in the owner's Drive,
 * runs the same tab setup as setup() (no triggers), the reconcile loop with the
 * formula scheduler and the autoscaler's formulas, checks what the cells computed,
 * and moves the scratch file to the Drive trash (unless `keep`).
 *
 * It runs in the web app as the cluster's owner (Drive and Sheets scopes are
 * already granted), so it needs no Google credentials anywhere else. The cluster's
 * own tabs and Script Properties are not touched; the script lock is held only
 * while a reconcile pass runs, as for any API call.
 */
const SELFTEST_LOCALES = ['en_US', 'ru_RU'];
const SELFTEST_SYNTAX = { en_US: 'comma', en_GB: 'comma', ru_RU: 'semicolon', de_DE: 'semicolon', fr_FR: 'semicolon' };

function selftestOp(body) {
  if (body.action !== 'selftest') return null;
  try {
    const locales = (body.locales && body.locales.length ? body.locales : SELFTEST_LOCALES).map(String);
    const results = locales.map(locale => selftestLocale_(locale, !!body.keep));
    return { ok: results.every(r => r.ok), results: results };
  } catch (err) {
    return { error: String(err.message || err) };
  }
}

function selftestLocale_(locale, keep) {
  const started = Date.now();
  const sheet = SpreadsheetApp.create('sheeternetes-selftest ' + locale + ' ' + new Date().toISOString());
  sheet.setSpreadsheetLocale(locale);
  let checks;
  try {
    checks = selftestOn(sheet);
  } catch (err) {
    checks = [{ name: 'the run finished', ok: false, detail: String(err.message || err) }];
  } finally {
    if (!keep) { requireDrive(); Drive.Files.update({ trashed: true }, sheet.getId()); }
  }
  return { locale: locale, ok: checks.every(c => c.ok), ms: Date.now() - started,
           spreadsheet: keep ? sheet.getUrl() : 'trashed', checks: checks };
}

// The checks, on any spreadsheet (the test suite passes the mock's).
function selftestOn(sheet) {
  const saved = { override: ss.override, checked: writeTab.checked, memo: formulaSyntax.memo };
  ss.override = sheet;
  writeTab.checked = {};
  formulaSyntax.memo = null;
  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name: name, ok: !!ok, detail: ok ? '' : JSON.stringify(detail === undefined ? null : detail).slice(0, 300) }); };
  try {
    const locale = sheet.getSpreadsheetLocale();
    CacheService.getScriptCache().remove('sheeternetes:formula-syntax:' + locale);   // probe this sheet, not the cache
    ensureTabs();
    const syntax = formulaSyntax.memo;
    check('formula syntax detected (' + syntax + ')', !SELFTEST_SYNTAX[locale] || SELFTEST_SYNTAX[locale] === syntax, { locale: locale, syntax: syntax });

    const now = new Date().toISOString();
    writeTab('Nodes', [
      { name: 'small', ip: '10.0.0.1', cpu_total: 1000, mem_total: 2048, status: 'Ready', last_heartbeat: now, schedulable: true },
      { name: 'big', ip: '10.0.0.2', cpu_total: 4000, mem_total: 8192, status: 'Ready', last_heartbeat: now, schedulable: true, labels: 'disk=ssd' },
      { name: 'gpu', ip: '10.0.0.3', cpu_total: 8000, mem_total: 16384, status: 'Ready', last_heartbeat: now, schedulable: true,
        labels: 'gpu=yes', taints: 'gpu=yes:NoSchedule' },
    ]);
    writeTab('Deployments', [
      { name: 'web', image: 'nginx:alpine', replicas: 3, cpu_req: 500, mem_req: 256 },
      { name: 'db', image: 'postgres:16', replicas: 1, cpu_req: 1000, mem_req: 1024, node_selector: 'disk=ssd' },
    ]);
    const state = reconcile();
    const events = readTab('Events').map(e => String(e.message));
    check('the formula scheduler placed every pod (no script fallback)',
      !events.some(m => /script fallback/.test(m)) && events.filter(m => /\(formula\)$/.test(m)).length === 4, events);
    const chosen = sheet.getSheetByName('Pods').getRange(2, CHOSEN_COL, state.pods.length, 1).getValues().map(r => String(r[0]));
    check('the chosen column computed node names, no errors', chosen.every(c => /^(small|big|gpu)$/.test(c)), chosen);
    const fresh = state.pods.map(p => Object.assign({}, p, { node: '' }));
    const script = scheduleScript(fresh, state.nodes);
    check('formula and Apps Script scheduler agree', state.pods.every((p, i) => p.node === script[i]), { formula: state.pods.map(p => p.node), script: script });
    check('node_selector and taints are honoured', state.pods.every(p => p.node !== 'gpu') &&
      state.pods.filter(p => p.deployment === 'db').every(p => p.node === 'big'), state.pods.map(p => p.deployment + '@' + p.node));

    // the autoscaler: 3 Running web pods at 80% of their request, target 50% -> 5 replicas
    const pods = readTab('Pods');
    pods.forEach(p => { p.phase = 'Running'; if (p.deployment === 'web') p.cpu_usage = 400; });
    writeTab('Pods', pods);
    setAutoscale({ deployment: 'web', target_cpu: 50, min_replicas: 1, max_replicas: 5 });
    SpreadsheetApp.flush();
    const hpa = readTab(AUTOSCALE).find(r => r.deployment === 'web') || {};
    check('autoscale formulas compute (cpu 80%, desired 5, ScalingUp)',
      Number(hpa.current_replicas) === 3 && Number(hpa.cpu_percent) === 80 && Number(hpa.desired_replicas) === 5 && hpa.status === 'ScalingUp', hpa);

    const hb = readTab('Nodes').find(n => n.name === 'small').last_heartbeat;
    check('timestamps survive a round trip through a cell', Math.abs(Date.parse(String(hb instanceof Date ? hb.toISOString() : hb)) - Date.parse(now)) < 1000, String(hb));
  } finally {
    ss.override = saved.override;
    writeTab.checked = saved.checked;
    formulaSyntax.memo = saved.memo;
  }
  return checks;
}
