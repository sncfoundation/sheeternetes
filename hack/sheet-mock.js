// In-memory stand-in for the Apps Script services Code.gs uses (SpreadsheetApp,
// Utilities, LockService, ContentService, ScriptApp). Shared by hack/test*.js and
// hack/local-apiserver.js so every harness runs the REAL Code.gs against the same
// Sheet shape.
//
// Formula cells: Code.gs installs the scheduler formula into the Pods tab. A real
// Google Sheet recalculates it; here a recalc hook (hack/formula-port.js, a
// line-by-line port of that formula) fills in the computed values whenever the tab
// is read, so the `formula` scheduler mode works locally too.
'use strict';
const fs = require('fs');
const path = require('path');

const exposed = new Set();

function loadControlPlane(opts) {
  opts = opts || {};
  let codeText = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
  if (opts.scheduler) {
    codeText = codeText.replace(/const SCHEDULER = '[a-z]+';/, `const SCHEDULER = '${opts.scheduler}';`);
  }
  // Apps Script runs every .gs file of the project in one global scope, Code.gs first
  const root = path.join(__dirname, '..');
  fs.readdirSync(root).filter(f => f.endsWith('.gs') && f !== 'Code.gs').sort()
    .forEach(f => { codeText += '\n' + fs.readFileSync(path.join(root, f), 'utf8'); });
  const fakes = require('./gas-fakes').makeFakes(opts);
  const faults = [];
  const reads = {};    // tab -> number of reads, so tests can prove a path never touches a tab   // tests push (tab, row, col, values) => throws, to inject crashes
  const recalc = opts.recalc || require('./formula-port').recalcPods;
  const store = {};
  const formulas = {};  // tab -> { "r,c": formulaText }

  function grid(name) { return store[name]; }
  function lastNonEmpty(g, f) {
    for (let r = g.length; r >= 1; r--) {
      const row = g[r - 1] || [];
      if (row.some(c => c !== '' && c !== undefined && c !== null)) return r;
      if (f && Object.keys(f).some(k => Number(k.split(',')[0]) === r)) return r;
    }
    return 1;
  }
  function evaluate(name) {
    // a real Sheet recalculates on every edit; emulate that on read
    if (name === 'Pods' && formulas.Pods && Object.keys(formulas.Pods).length) recalc(store, formulas.Pods);
    if (name === 'Autoscale' && formulas.Autoscale) require('./formula-port').recalcAutoscale(store, formulas.Autoscale);
  }
  function rangeObj(name, row, col, nr, nc) {
    const g = store[name];
    const f = formulas[name] = formulas[name] || {};
    const cells = (fn) => {
      for (let i = 0; i < nr; i++) {
        const r = row - 1 + i; if (!g[r]) g[r] = [];
        for (let j = 0; j < nc; j++) fn(r, col - 1 + j, i, j);
      }
    };
    const o = {
      clearContent() { cells((r, c) => { g[r][c] = ''; delete f[(r + 1) + ',' + (c + 1)]; }); return o; },
      setValues(v) {
        faults.forEach(fault => fault(name, row, col, v));
        v.forEach(r => r.forEach(x => { if (typeof x === 'string' && x.length > 50000) throw new Error('Your input contains more than the maximum of 50000 characters in a single cell.'); }));
        cells((r, c, i, j) => { g[r][c] = v[i][j]; delete f[(r + 1) + ',' + (c + 1)]; }); return o;
      },
      setFormula(text) { cells((r, c) => { f[(r + 1) + ',' + (c + 1)] = text; g[r][c] = ''; }); return o; },
      getValues() { reads[name] = (reads[name] || 0) + 1; evaluate(name); const out = []; cells((r, c, i, j) => { (out[i] = out[i] || [])[j] = g[r][c] === undefined ? '' : g[r][c]; }); return out; },
      getFormulas() { const out = []; cells((r, c, i, j) => { (out[i] = out[i] || [])[j] = f[(r + 1) + ',' + (c + 1)] || ''; }); return out; },
      setFontWeight() { return o; }, setNote() { return o; }, setBackground() { return o; },
      setFontColor() { return o; }, setNumberFormat() { return o; },
    };
    return o;
  }
  function sheetApi(name) {
    return {
      getName: () => name,
      getDataRange: () => ({ getValues: () => { reads[name] = (reads[name] || 0) + 1; evaluate(name); return store[name].map(r => r.slice()); } }),
      getRange: (r, c, nr, nc) => rangeObj(name, r, c, nr || 1, nc || 1),
      getLastRow: () => lastNonEmpty(store[name], formulas[name]),
      getLastColumn: () => Math.max(1, ...store[name].map(r => r.length)),
      appendRow: (arr) => { const n = lastNonEmpty(store[name], formulas[name]); store[name][n] = arr.slice(); },
      deleteRows: (start, num) => {
        store[name].splice(start - 1, num);
        const f = formulas[name] || {}; const nf = {};
        Object.keys(f).forEach(k => { const [r, c] = k.split(',').map(Number);
          if (r < start) nf[k] = f[k]; else if (r >= start + num) nf[(r - num) + ',' + c] = f[k]; });
        formulas[name] = nf;
      },
      setFrozenRows: () => {},
      hideSheet: () => {},
      getConditionalFormatRules: () => (sheetApi.cf[name] || []),
      setConditionalFormatRules: (rules) => { sheetApi.cf[name] = rules; },
    };
  }
  sheetApi.cf = {};

  // ---- Drive revision history (Google keeps one per batch of edits; here one per
  // saveRevision() call, which local-apiserver.js makes after every write request)
  const revisions = [];   // [{id, modifiedTime, grids}]
  const tempFiles = {};   // converted exports, id -> grids
  const trashed = [];
  let clock = opts.clock || (() => new Date());
  const snapshotGrids = () => {
    evaluate('Pods');
    const g = {};
    Object.keys(store).forEach(k => { g[k] = store[k].map(r => r.slice()); });
    return g;
  };
  function saveRevision() {
    const grids = snapshotGrids();
    const last = revisions[revisions.length - 1];
    if (last && JSON.stringify(last.grids) === JSON.stringify(grids)) return last.id;
    const id = String(revisions.length + 1);
    revisions.push({ id, modifiedTime: clock().toISOString(), grids });
    return id;
  }
  function readOnlySheet(grid) {
    return { getDataRange: () => ({ getValues: () => grid.map(r => r.slice()) }), getName: () => '' };
  }
  const Drive = {
    Revisions: {
      list: () => ({ revisions: revisions.map(r => ({ id: r.id, modifiedTime: r.modifiedTime })) }),
      get: (fileId, id) => {
        if (!revisions.some(r => r.id === String(id))) throw new Error('Revision not found: ' + id);
        return { id: String(id), exportLinks: {
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'mock://export/' + id } };
      },
    },
    Files: {
      create: (resource, blob) => { const id = 'tmp-' + (Object.keys(tempFiles).length + trashed.length + 1); tempFiles[id] = blob._grids; return { id }; },
      update: (resource, id) => { if (resource.trashed) { trashed.push(id); delete tempFiles[id]; } return { id }; },
    },
  };
  const UrlFetchApp = {
    fetch: (url) => {
      const m = /^mock:\/\/export\/(.+)$/.exec(url);
      const rev = m && revisions.find(r => r.id === m[1]);
      return { getResponseCode: () => (rev ? 200 : 404),
               getBlob: () => ({ _grids: rev.grids, setContentType() { return this; } }) };
    },
  };

  const SpreadsheetApp = {
    openById: (id) => {
      const grids = tempFiles[id];
      if (!grids) throw new Error('no file ' + id);
      return { getSheetByName: (n) => (grids[n] ? readOnlySheet(grids[n]) : null) };
    },
    getActiveSpreadsheet: () => ({
      getId: () => 'local',
      getSheetByName: (n) => (store[n] ? sheetApi(n) : null),
      insertSheet: (n) => { store[n] = store[n] || [[]]; return sheetApi(n); },
      deleteSheet: (sh) => { delete store[sh.getName()]; delete formulas[sh.getName()]; },
    }),
    flush: () => {},
    newConditionalFormatRule: () => {
      const rule = { _spec: {} };
      const b = {
        whenFormulaSatisfied: (f) => { rule._spec.formula = f; return b; },
        setBackground: (c) => { rule._spec.background = c; return b; },
        setFontColor: (c) => { rule._spec.fontColor = c; return b; },
        setRanges: (r) => { rule._spec.ranges = r; return b; },
        build: () => rule,
      };
      return b;
    },
  };
  let uuidN = 0;
  // real getUuid() is random; reversing a base36 counter makes the first chars vary
  const Utilities = Object.assign({}, fakes.Utilities, { getUuid: () => (++uuidN).toString(36).split('').reverse().join('').padEnd(8, '0') });
  const LockService = fakes.LockService;
  const ContentService = { MimeType: { JSON: 'json' },
    createTextOutput: (t) => ({ _t: t, setMimeType() { return this; } }) };
  const ScriptApp = fakes.ScriptApp;
  const globals = { SpreadsheetApp, Utilities, LockService, ContentService, ScriptApp, UrlFetchApp,
                    PropertiesService: fakes.PropertiesService, HtmlService: fakes.HtmlService, Session: fakes.Session,
                    CacheService: fakes.CacheService };
  if (!opts.noDrive) globals.Drive = Drive;   // the advanced service is opt-in in Apps Script
  Object.assign(globals, opts.globals || {});

  const exportsList = ['doGet', 'doPost', 'setup', 'reconcile', 'controlOp', 'readTab', 'writeTab',
    'scheduleScript', 'schedulerFormula', 'ensureTabs', 'TABS', 'SCHEDULER'].concat(opts.exports || []);
  const names = Object.keys(globals);
  // pod source compiled with new Function() sees only real globals, as in Apps Script
  exposed.forEach(n => { if (!(n in globals)) delete globalThis[n]; });
  names.forEach(n => { globalThis[n] = globals[n]; exposed.add(n); });
  const api = new Function(...names,
    codeText + '\nreturn {' + exportsList.map(n => `${n}: (typeof ${n} !== 'undefined' ? ${n} : undefined)`).join(',') + '};'
  )(...names.map(n => globals[n]));
  api._store = store;
  api._formulas = formulas;
  api._cf = sheetApi.cf;
  api._saveRevision = saveRevision;
  api._revisions = revisions;
  api._trashed = trashed;
  api._setClock = (f) => { clock = f; };
  api._faults = faults;
  api._reads = reads;
  api._props = fakes._props;
  api._triggers = fakes._triggers;
  api._lock = fakes._lock;
  return api;
}

module.exports = { loadControlPlane };
