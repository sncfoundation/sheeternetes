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

function loadControlPlane(opts) {
  opts = opts || {};
  let codeText = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
  if (opts.scheduler) {
    codeText = codeText.replace(/const SCHEDULER = '[a-z]+';/, `const SCHEDULER = '${opts.scheduler}';`);
  }
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
      setValues(v) { cells((r, c, i, j) => { g[r][c] = v[i][j]; delete f[(r + 1) + ',' + (c + 1)]; }); return o; },
      setFormula(text) { cells((r, c) => { f[(r + 1) + ',' + (c + 1)] = text; g[r][c] = ''; }); return o; },
      getValues() { evaluate(name); const out = []; cells((r, c, i, j) => { (out[i] = out[i] || [])[j] = g[r][c] === undefined ? '' : g[r][c]; }); return out; },
      getFormulas() { const out = []; cells((r, c, i, j) => { (out[i] = out[i] || [])[j] = f[(r + 1) + ',' + (c + 1)] || ''; }); return out; },
      setFontWeight() { return o; }, setNote() { return o; }, setBackground() { return o; },
      setFontColor() { return o; }, setNumberFormat() { return o; },
    };
    return o;
  }
  function sheetApi(name) {
    return {
      getName: () => name,
      getDataRange: () => ({ getValues: () => { evaluate(name); return store[name].map(r => r.slice()); } }),
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
      getConditionalFormatRules: () => (sheetApi.cf[name] || []),
      setConditionalFormatRules: (rules) => { sheetApi.cf[name] = rules; },
    };
  }
  sheetApi.cf = {};

  const SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getId: () => 'local',
      getSheetByName: (n) => (store[n] ? sheetApi(n) : null),
      insertSheet: (n) => { store[n] = store[n] || [[]]; return sheetApi(n); },
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
  const Utilities = { getUuid: () => (++uuidN).toString(36).split('').reverse().join('').padEnd(8, '0') };
  const LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
  const ContentService = { MimeType: { JSON: 'json' },
    createTextOutput: (t) => ({ _t: t, setMimeType() { return this; } }) };
  const ScriptApp = { getProjectTriggers: () => [],
    newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create() {} }) }) }) };
  const globals = { SpreadsheetApp, Utilities, LockService, ContentService, ScriptApp };
  Object.assign(globals, opts.globals || {});

  const exportsList = ['doGet', 'doPost', 'setup', 'reconcile', 'controlOp', 'readTab', 'writeTab',
    'scheduleScript', 'schedulerFormula', 'ensureTabs', 'TABS', 'SCHEDULER'].concat(opts.exports || []);
  const names = Object.keys(globals);
  const api = new Function(...names,
    codeText + '\nreturn {' + exportsList.map(n => `${n}: (typeof ${n} !== 'undefined' ? ${n} : undefined)`).join(',') + '};'
  )(...names.map(n => globals[n]));
  api._store = store;
  api._formulas = formulas;
  api._cf = sheetApi.cf;
  return api;
}

module.exports = { loadControlPlane };
