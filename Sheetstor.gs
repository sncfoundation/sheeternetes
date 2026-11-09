/**
 * Sheetstor on cells — volumes whose blocks are spreadsheet cells.
 *
 * The `Volumes` tab is the registry (the LINSTOR controller's database): one row
 * per volume with its mode, the generation that is currently visible, and the
 * file count, size and digest of that generation. Every volume keeps its files in
 * a hidden tab `sheetstor-<name>`, one row per chunk:
 *
 *   generation | path | chunk | chunks | size | sha256 | data
 *
 * `data` is up to SHEETSTOR_CHUNK base64 characters behind a `~` marker (a cell
 * holds 50,000 characters; the marker keeps Sheets from reading a chunk as a
 * number or a formula). A file is the group of rows of one (generation, path).
 *
 * Writes are copy-on-write. A write appends a complete new group under a fresh
 * generation number, and only then flips the registry pointer to it. Readers see,
 * for every path, the newest group whose generation is at or below the pointer,
 * so a crash before the flip leaves the previous generation intact; the orphaned
 * rows are collected by the next write. A delete is a tombstone group (chunks = 0).
 *
 * Every write and read runs under the script lock: one writer at a time, and
 * garbage collection never races a reader. Functions ending in `_` expect the
 * caller to hold the lock already (script pods do: the runtime holds it for the
 * whole invocation); the others take it themselves.
 */
const SHEETSTOR_REGISTRY = 'Volumes';
const SHEETSTOR_COLUMNS = ['name', 'mode', 'generation', 'files', 'size', 'sha256', 'updated_at'];
const SHEETSTOR_BLOB_COLUMNS = ['generation', 'path', 'chunk', 'chunks', 'size', 'sha256', 'data'];
const SHEETSTOR_META = 6;          // the columns read without touching the data
const SHEETSTOR_CHUNK = 49000;     // base64 characters per cell
const SHEETSTOR_TAB_PREFIX = 'sheetstor-';
const SHEETSTOR_NAME = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
const SHEETSTOR_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const SHEETSTOR_LOCK_MS = 30000;

// ---------- the script lock ----------
// Taking the lock forgets what was read before it: another execution may have
// written in between.
function skLocked(fn, waitMs) {
  const lock = LockService.getScriptLock();
  lock.waitLock(waitMs || SHEETSTOR_LOCK_MS);
  sheetstorForget_();
  try { return fn(); } finally { lock.releaseLock(); }
}

// Like skLocked, but gives up instead of throwing. Returns {locked:false} or {locked:true, value}.
function skTryLocked(fn, waitMs) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(waitMs || SHEETSTOR_LOCK_MS)) return { locked: false };
  sheetstorForget_();
  try { return { locked: true, value: fn() }; } finally { lock.releaseLock(); }
}

// ---------- bytes ----------
// Apps Script represents bytes as arrays of signed integers (-128..127).
function skBytes(data) {
  if (data === null || data === undefined) return [];
  if (typeof data === 'string') return Utilities.newBlob(data).getBytes();
  if (typeof data.getBytes === 'function') return data.getBytes();
  if (Array.isArray(data)) return data;
  if (typeof data.length === 'number') return Array.prototype.map.call(data, b => (b > 127 ? b - 256 : b));
  throw new Error('cannot store a value of type ' + typeof data + ' (use a string, a Blob or bytes)');
}

function skSha256(bytes) {
  return 'sha256:' + Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)
    .map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('');
}

const SHEETSTOR_TYPES = { json: 'application/json', txt: 'text/plain', js: 'application/javascript', html: 'text/html',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', ogg: 'audio/ogg', pdf: 'application/pdf' };

function skContentType(path) {
  const ext = String(path).split('.').pop().toLowerCase();
  return SHEETSTOR_TYPES[ext] || 'application/octet-stream';
}

// ---------- registry ----------
function sheetstorEnsure() {
  let sh = ss().getSheetByName(SHEETSTOR_REGISTRY);
  if (!sh) sh = ss().insertSheet(SHEETSTOR_REGISTRY);
  sh.getRange(1, 1, 1, SHEETSTOR_COLUMNS.length).setValues([SHEETSTOR_COLUMNS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  return sh;
}

// The registry is read once per lock: every lookup of an invocation (code, state,
// mounted volumes) shares that read, and every registry write forgets it.
function sheetstorVolumes() {
  if (!sheetstorVolumes.memo) {
    sheetstorVolumes.memo = readTab(SHEETSTOR_REGISTRY).map(v => ({
      name: String(v.name), mode: String(v.mode || 'rw'), generation: Number(v.generation) || 0,
      files: Number(v.files) || 0, size: Number(v.size) || 0, sha256: String(v.sha256 || ''), updated_at: v.updated_at,
    }));
  }
  return sheetstorVolumes.memo.map(v => Object.assign({}, v));
}

function sheetstorForget_() { sheetstorVolumes.memo = null; }

function sheetstorVolume_(name) {
  const v = sheetstorVolumes().find(x => x.name === String(name));
  if (!v) throw new Error('no such volume ' + name);
  return v;
}

function sheetstorTab_(name) {
  const sh = ss().getSheetByName(SHEETSTOR_TAB_PREFIX + name);
  if (!sh) throw new Error('volume ' + name + ' has no data tab ' + SHEETSTOR_TAB_PREFIX + name);
  return sh;
}

function sheetstorSetRegistry_(vol) {
  const sh = sheetstorEnsure();
  const names = sh.getDataRange().getValues().map(r => String(r[0]));
  let row = names.indexOf(vol.name) + 1;
  if (row <= 0) row = Math.max(2, sh.getLastRow() + 1);
  sh.getRange(row, 1, 1, SHEETSTOR_COLUMNS.length).setValues([SHEETSTOR_COLUMNS.map(c => vol[c] === undefined ? '' : vol[c])]);
  sheetstorForget_();
}

function sheetstorCreate(name, opts) {
  return skLocked(() => sheetstorCreate_(name, opts));
}

function sheetstorCreate_(name, opts) {
  opts = opts || {};
  name = String(name || '');
  if (!SHEETSTOR_NAME.test(name)) throw new Error('bad volume name "' + name + '": lowercase letters, digits and dashes, at most 40');
  const mode = opts.mode === 'ro' ? 'ro' : 'rw';
  sheetstorEnsure();
  const existing = sheetstorVolumes().find(v => v.name === name);
  if (existing) {
    if (opts.ifMissing) return existing;
    throw new Error('volume ' + name + ' already exists');
  }
  let sh = ss().getSheetByName(SHEETSTOR_TAB_PREFIX + name);
  if (!sh) sh = ss().insertSheet(SHEETSTOR_TAB_PREFIX + name);
  sh.getRange(1, 1, 1, SHEETSTOR_BLOB_COLUMNS.length).setValues([SHEETSTOR_BLOB_COLUMNS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  if (typeof sh.hideSheet === 'function') sh.hideSheet();
  const vol = { name: name, mode: mode, generation: 0, files: 0, size: 0, sha256: skSha256([]), updated_at: new Date().toISOString() };
  sheetstorSetRegistry_(vol);
  event('Volume', name, 'created (' + mode + ')');
  return vol;
}

// Removes the volume and its data tab. The data is gone afterwards (version history aside).
function sheetstorDeleteVolume(name) {
  return skLocked(() => {
    sheetstorVolume_(name);
    const reg = sheetstorEnsure();
    const names = reg.getDataRange().getValues().map(r => String(r[0]));
    reg.deleteRows(names.indexOf(String(name)) + 1, 1);
    sheetstorForget_();
    const sh = ss().getSheetByName(SHEETSTOR_TAB_PREFIX + name);
    if (sh) ss().deleteSheet(sh);
    event('Volume', name, 'deleted');
    return { deleted: name };
  });
}

// ---------- chunk rows ----------
function sheetstorRows_(sh) {
  const n = sh.getLastRow() - 1;
  if (n <= 0) return [];
  return sh.getRange(2, 1, n, SHEETSTOR_META).getValues().map((r, i) => ({
    row: i + 2, generation: Number(r[0]) || 0, path: String(r[1]), chunk: Number(r[2]) || 0,
    chunks: Number(r[3]) || 0, size: Number(r[4]) || 0, sha256: String(r[5]),
  })).filter(r => r.path !== '');
}

// path -> chunk rows of the newest group at or below `generation` (tombstones dropped)
function sheetstorView_(rows, generation) {
  const newest = {};
  rows.forEach(r => {
    if (r.generation <= generation && !(newest[r.path] >= r.generation)) newest[r.path] = r.generation;
  });
  const files = {};
  rows.forEach(r => { if (newest[r.path] === r.generation) (files[r.path] = files[r.path] || []).push(r); });
  Object.keys(files).forEach(p => {
    files[p].sort((a, b) => a.chunk - b.chunk);
    if (files[p][0].chunks === 0) delete files[p];
  });
  return files;
}

function sheetstorSummary_(files) {
  const paths = Object.keys(files).sort();
  const manifest = paths.map(p => p + ' ' + files[p][0].sha256).join('\n');
  return { files: paths.length, size: paths.reduce((s, p) => s + files[p][0].size, 0), sha256: skSha256(skBytes(manifest)) };
}

// Deletes rows bottom-up in contiguous runs, so row numbers above stay valid.
function sheetstorDeleteRows_(sh, rowNumbers) {
  const rows = rowNumbers.slice().sort((a, b) => b - a);
  let i = 0;
  while (i < rows.length) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1] === rows[j] - 1) j++;
    sh.deleteRows(rows[j], j - i + 1);
    i = j + 1;
  }
}

// Garbage collection: orphans above the pointer (crashed writes) and every group
// that is no longer the newest for its path. Tombstones go in a second pass, once
// nothing older is left for them to hide.
function sheetstorGc_(sh, generation) {
  const rows = sheetstorRows_(sh);
  const live = sheetstorNewest_(rows, generation);
  const garbage = rows.filter(r => r.generation > generation || live[r.path] !== r.generation).map(r => r.row);
  if (garbage.length) sheetstorDeleteRows_(sh, garbage);
  const left = sheetstorRows_(sh);
  const tombstones = left.filter(r => r.chunks === 0 && !left.some(o => o.path === r.path && o.generation < r.generation)).map(r => r.row);
  if (tombstones.length) sheetstorDeleteRows_(sh, tombstones);
  return garbage.length + tombstones.length;
}

function sheetstorNewest_(rows, generation) {
  const newest = {};
  rows.forEach(r => { if (r.generation <= generation && !(newest[r.path] >= r.generation)) newest[r.path] = r.generation; });
  return newest;
}

// ---------- file operations ----------
function sheetstorCheckPath_(path) {
  path = String(path || '').replace(/^\/+/, '');
  if (!SHEETSTOR_PATH.test(path) || path.split('/').some(s => s === '.' || s === '..')) throw new Error('bad path "' + path + '"');
  return path;
}

// Appends a group, flips the pointer, collects garbage. `opts.admin` may write a ro volume.
function sheetstorWrite_(name, path, data, opts) {
  opts = opts || {};
  path = sheetstorCheckPath_(path);
  const vol = sheetstorVolume_(name);
  if (vol.mode === 'ro' && !opts.admin) throw new Error('volume ' + name + ' is read-only');
  const sh = sheetstorTab_(name);
  const rows = sheetstorRows_(sh);
  const generation = rows.reduce((m, r) => Math.max(m, r.generation), vol.generation) + 1;
  let group;
  if (opts.tombstone) {
    if (!sheetstorView_(rows, vol.generation)[path]) throw new Error('no such file ' + name + ':/' + path);
    group = [[generation, path, 0, 0, '', '', '~']];
  } else {
    const bytes = skBytes(data);
    const sha = skSha256(bytes);
    const b64 = Utilities.base64Encode(bytes);
    const chunks = [];
    for (let i = 0; i < b64.length; i += SHEETSTOR_CHUNK) chunks.push(b64.slice(i, i + SHEETSTOR_CHUNK));
    if (!chunks.length) chunks.push('');
    group = chunks.map((c, i) => [generation, path, i, chunks.length, bytes.length, sha, '~' + c]);
  }
  const first = sh.getLastRow() + 1;
  sh.getRange(first, 1, group.length, SHEETSTOR_BLOB_COLUMNS.length).setValues(group);
  SpreadsheetApp.flush();   // the group is durable before the pointer moves

  const after = rows.concat(group.map((g, i) => ({ row: first + i, generation: g[0], path: g[1], chunk: g[2], chunks: g[3], size: Number(g[4]) || 0, sha256: g[5] })));
  const summary = sheetstorSummary_(sheetstorView_(after, generation));
  const flipped = Object.assign({}, vol, summary, { generation: generation, updated_at: new Date().toISOString() });
  sheetstorSetRegistry_(flipped);
  SpreadsheetApp.flush();
  sheetstorGc_(sh, generation);
  return opts.tombstone ? { volume: name, path: path, generation: generation, manifest: summary.sha256, deleted: true }
    : { volume: name, path: path, generation: generation, manifest: summary.sha256, size: group[0][4], sha256: group[0][5] };
}

// -> { bytes, size, sha256, generation, contentType }
function sheetstorRead_(name, path) {
  path = sheetstorCheckPath_(path);
  const vol = sheetstorVolume_(name);
  const sh = sheetstorTab_(name);
  const group = sheetstorView_(sheetstorRows_(sh), vol.generation)[path];
  if (!group) throw new Error('no such file ' + name + ':/' + path);
  const n = group[0].chunks;
  const intact = group.length === n && group.every((r, i) => r.chunk === i && r.row === group[0].row + i);
  if (!intact) throw new Error('corrupt file ' + name + ':/' + path + ': chunks missing or out of order');
  const cells = sh.getRange(group[0].row, SHEETSTOR_BLOB_COLUMNS.length, n, 1).getValues();
  const b64 = cells.map(c => String(c[0]).slice(1)).join('');
  const bytes = b64 ? Utilities.base64Decode(b64) : [];
  const sha = skSha256(bytes);
  if (sha !== group[0].sha256 || bytes.length !== group[0].size) {
    throw new Error('corrupt file ' + name + ':/' + path + ': checksum mismatch');
  }
  return { bytes: bytes, size: bytes.length, sha256: sha, generation: group[0].generation, contentType: skContentType(path) };
}

// A text file through CacheService. The key carries the volume's manifest digest
// (every path with its sha256), so any write to the volume, or a volume deleted and
// created again under the same name, misses the old entry. One registry read on a hit.
const SHEETSTOR_TEXT_CACHE_MAX = 90000;     // CacheService keeps values up to 100 KB
const SHEETSTOR_TEXT_CACHE_S = 6 * 60 * 60;

function sheetstorTextKey_(name, manifest, path) { return 'sk.file.' + String(manifest).slice(7, 39) + '.' + name + '/' + path; }

function sheetstorReadText_(name, path) {
  path = sheetstorCheckPath_(path);
  const vol = sheetstorVolume_(name);
  const cache = CacheService.getScriptCache();
  const key = sheetstorTextKey_(name, vol.sha256, path);
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  const f = sheetstorRead_(name, path);
  const out = { text: Utilities.newBlob(f.bytes).getDataAsString(), sha256: f.sha256 };
  sheetstorCacheText_(name, vol.sha256, path, out);
  return out;
}

function sheetstorCacheText_(name, manifest, path, file) {
  const value = JSON.stringify(file);
  if (value.length < SHEETSTOR_TEXT_CACHE_MAX) CacheService.getScriptCache().put(sheetstorTextKey_(name, manifest, path), value, SHEETSTOR_TEXT_CACHE_S);
}

function sheetstorList_(name) {
  const vol = sheetstorVolume_(name);
  const files = sheetstorView_(sheetstorRows_(sheetstorTab_(name)), vol.generation);
  return Object.keys(files).sort().map(p => ({ path: p, size: files[p][0].size, sha256: files[p][0].sha256, generation: files[p][0].generation }));
}

function sheetstorWrite(name, path, data, opts) { return skLocked(() => sheetstorWrite_(name, path, data, opts)); }
function sheetstorRead(name, path) { return skLocked(() => sheetstorRead_(name, path)); }
function sheetstorList(name) { return skLocked(() => sheetstorList_(name)); }
function sheetstorRemove(name, path, opts) { return skLocked(() => sheetstorWrite_(name, path, null, Object.assign({}, opts, { tombstone: true }))); }

// What a pod sees as env.volumes.<name>. The caller holds the lock.
function sheetstorHandle_(name, readOnly) {
  const vol = sheetstorVolume_(name);
  const ro = readOnly || vol.mode === 'ro';
  const guard = () => { if (ro) throw new Error('volume ' + name + ' is mounted read-only'); };
  const h = {
    name: name,
    readOnly: ro,
    read: (path) => {
      const f = sheetstorRead_(name, path);
      return Utilities.newBlob(f.bytes, f.contentType, String(path).split('/').pop());
    },
    readText: (path) => sheetstorReadText_(name, path).text,
    readJSON: (path) => JSON.parse(h.readText(path)),
    exists: (path) => sheetstorList_(name).some(f => f.path === sheetstorCheckPath_(path)),
    list: () => sheetstorList_(name),
    write: (path, data) => { guard(); return sheetstorWrite_(name, path, data); },
    writeJSON: (path, obj) => h.write(path, JSON.stringify(obj)),
    remove: (path) => { guard(); return sheetstorWrite_(name, path, null, { tombstone: true }); },
  };
  return h;
}

// ---------- API (skctl volume ...) ----------
// POST actions; returns null for actions that are not ours.
function sheetstorOp(body) {
  const ops = {
    volumeCreate: () => sheetstorCreate(body.name, { mode: body.mode }),
    volumeDelete: () => sheetstorDeleteVolume(body.name),
    volumePut: () => {
      const res = sheetstorWrite(body.name, body.path, Utilities.base64Decode(String(body.data || '')), { admin: true });
      if (body.sha256 && body.sha256 !== res.sha256) throw new Error('upload damaged: got ' + res.sha256 + ', expected ' + body.sha256);
      event('Volume', body.name, 'wrote /' + res.path + ' (' + res.size + ' bytes, generation ' + res.generation + ')');
      return res;
    },
    volumeGet: () => {
      const f = sheetstorRead(body.name, body.path);
      return { volume: body.name, path: body.path, size: f.size, sha256: f.sha256, generation: f.generation, data: Utilities.base64Encode(f.bytes) };
    },
    volumeRm: () => {
      const res = sheetstorRemove(body.name, body.path, { admin: true });
      event('Volume', body.name, 'removed /' + res.path);
      return res;
    },
  };
  if (!ops[body.action]) return null;
  try { return Object.assign({ ok: true }, ops[body.action]()); }
  catch (err) { return { error: String(err.message || err) }; }
}

// GET kinds; returns null for kinds that are not ours.
function sheetstorGet(p) {
  if (p.kind === 'volumes') {
    if (!ss().getSheetByName(SHEETSTOR_REGISTRY)) return { items: [] };
    const items = sheetstorVolumes();
    return { items: p.name ? items.filter(v => v.name === p.name) : items };
  }
  if (p.kind === 'files') {
    try { return { items: sheetstorList(p.name) }; } catch (err) { return { error: String(err.message || err) }; }
  }
  return null;
}
