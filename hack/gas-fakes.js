// Fakes for the Apps Script services the script runtime and Sheetstor use:
// PropertiesService, HtmlService, a contended LockService, stateful ScriptApp
// triggers, Session, and the byte helpers of Utilities (signed bytes, like
// Apps Script). hack/sheet-mock.js merges them into its globals.
'use strict';
const crypto = require('crypto');

const signed = (buf) => Array.from(buf, b => (b > 127 ? b - 256 : b));
const unsigned = (bytes) => Buffer.from(bytes.map(b => (b + 256) % 256));

function blob(bytes, contentType, name) {
  const b = {
    _bytes: bytes,
    getBytes: () => bytes.slice(),
    getDataAsString: () => unsigned(bytes).toString('utf8'),
    getContentType: () => contentType || null,
    setContentType(t) { contentType = t; return b; },
    getName: () => name || null,
    setName(n) { name = n; return b; },
  };
  return b;
}

// The pattern letters yyyy MM dd HH mm and m H d M u (u = ISO day of week, 1 = Monday).
function formatDate(date, tz, pattern) {
  const parts = {};
  new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', weekday: 'short' }).formatToParts(date).forEach(p => { parts[p.type] = p.value; });
  const dow = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday];
  const two = (n) => ('0' + n).slice(-2);
  const map = { m: Number(parts.minute), H: Number(parts.hour) % 24, d: Number(parts.day), M: Number(parts.month), u: dow };
  Object.assign(map, { yyyy: parts.year, MM: two(map.M), dd: two(map.d), HH: two(map.H), mm: two(map.m) });
  return pattern.replace(/yyyy|MM|dd|HH|mm|[mHdMu]/g, c => String(map[c]));
}

function makeFakes(opts) {
  opts = opts || {};
  const props = {};
  const Properties = {
    getProperty: (k) => (k in props ? props[k] : null),
    setProperty: (k, v) => { props[k] = String(v); return Properties; },
    setProperties: (o, deleteAllOthers) => {
      if (deleteAllOthers) Object.keys(props).forEach(k => delete props[k]);
      Object.keys(o).forEach(k => { props[k] = String(o[k]); });
      return Properties;
    },
    deleteProperty: (k) => { delete props[k]; return Properties; },
    getProperties: () => Object.assign({}, props),
    getKeys: () => Object.keys(props),
  };
  const PropertiesService = { getScriptProperties: () => Properties };

  const HtmlService = { createHtmlOutput: (t) => ({ _t: String(t), _status: 200, getContent: () => String(t) }) };

  // One lock for the whole project, like LockService.getScriptLock(). A second
  // holder fails at once (the harness is single-threaded, so waiting is pointless).
  const lockState = { held: false };
  const LockService = {
    getScriptLock: () => {
      let mine = false;
      const l = {
        tryLock: () => { if (lockState.held) return false; lockState.held = mine = true; return true; },
        waitLock: () => { if (!l.tryLock()) throw new Error('Lock timeout: another process was holding the lock for too long.'); },
        releaseLock: () => { if (mine) { lockState.held = mine = false; } },
        hasLock: () => mine,
      };
      return l;
    },
  };

  const triggers = [];
  const ScriptApp = {
    getProjectTriggers: () => triggers.slice(),
    deleteTrigger: (t) => { const i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); },
    getOAuthToken: () => 'mock-token',
    newTrigger: (fn) => {
      const make = (extra) => ({ create: () => { const t = Object.assign({ getHandlerFunction: () => fn }, extra); triggers.push(t); return t; } });
      return {
        timeBased: () => ({ everyMinutes: (n) => make({ minutes: n }) }),
        forSpreadsheet: () => ({ onEdit: () => make({ onEdit: true }) }),
      };
    },
  };

  const cache = {};
  const CacheService = { getScriptCache: () => ({
    get: (k) => (k in cache ? cache[k] : null),
    put: (k, v) => { cache[k] = String(v); },
    remove: (k) => { delete cache[k]; },
  }) };

  const Session = { getScriptTimeZone: () => opts.timeZone || 'Etc/UTC' };

  const Utilities = {
    DigestAlgorithm: { SHA_256: 'sha256' },
    computeDigest: (alg, bytes) => signed(crypto.createHash(alg).update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : unsigned(bytes)).digest()),
    base64Encode: (bytes) => (typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : unsigned(bytes)).toString('base64'),
    base64Decode: (s) => {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error('Could not decode string.');
      return signed(Buffer.from(s, 'base64'));
    },
    newBlob: (data, contentType, name) => blob(typeof data === 'string' ? signed(Buffer.from(data, 'utf8')) : data.slice(), contentType, name),
    formatDate: formatDate,
    sleep: () => {},
  };

  return { PropertiesService, HtmlService, LockService, ScriptApp, Session, Utilities, CacheService,
           _props: props, _triggers: triggers, _lock: lockState };
}

module.exports = { makeFakes, signed, unsigned };
