#!/usr/bin/env node
// skctl selftest's checks (Selftest.gs) on the mock Sheet, in the locale of
// SHEET_LOCALE: the same checks run against real scratch spreadsheets in Google.
//
//   node hack/test-selftest.js
'use strict';
const { loadControlPlane } = require('./sheet-mock');

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, '->', JSON.stringify(d)); } };

const api = loadControlPlane({ exports: ['selftestOn', 'selftestOp'] });
const checks = api.selftestOn(SpreadsheetApp.getActiveSpreadsheet());
checks.forEach(c => check(c.name, c.ok, c.detail));
check('every check ran', checks.length === 7, checks.map(c => c.name));
check('the cluster\'s Script Properties are untouched', !Object.keys(api._props).some(k => /^sk\./.test(k)), Object.keys(api._props));
check('an unknown action is not ours', api.selftestOp({ action: 'apply' }) === null, null);

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
