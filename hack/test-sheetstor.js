#!/usr/bin/env node
// Sheetstor on cells (Sheetstor.gs) on the real code: chunking under the 50,000
// character cell limit, sha256 verification, copy-on-write generations with an
// atomic pointer flip (crashes injected into the mock Sheet), garbage collection,
// tombstones and read-only volumes.
//
//   node hack/test-sheetstor.js
'use strict';
const crypto = require('crypto');
const { loadControlPlane } = require('./sheet-mock');
const { signed, unsigned } = require('./gas-fakes');

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, '->', JSON.stringify(d)); } };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(String(e.message || e)); } };
const TOKEN = 'CHANGE_ME_super_secret';

const api = loadControlPlane({ exports: ['sheetstorCreate', 'sheetstorWrite', 'sheetstorRead', 'sheetstorList', 'sheetstorRemove',
  'sheetstorDeleteVolume', 'sheetstorVolumes', 'sheetstorHandle_', 'sheetstorRows_', 'skLocked', 'SHEETSTOR_CHUNK'] });
api.setup();
const post = (b) => JSON.parse(api.doPost({ postData: { contents: JSON.stringify(Object.assign({ token: TOKEN }, b)) } })._t);
const get = (p) => JSON.parse(api.doGet({ parameter: Object.assign({ token: TOKEN }, p) })._t);
const tab = (v) => api._store['sheetstor-' + v];
const sha = (buf) => 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
const vol = (n) => api.sheetstorVolumes().find(v => v.name === n);

console.log('\n== create ==');
check('setup() creates the Volumes registry', !!api._store.Volumes, Object.keys(api._store));
check('skctl volume create', post({ action: 'volumeCreate', name: 'data' }).ok, null);
check('a volume gets a data tab', !!tab('data'), Object.keys(api._store));
check('bad names are refused', /bad volume name/.test(post({ action: 'volumeCreate', name: 'Bad_Name' }).error), null);
check('duplicates are refused', /already exists/.test(post({ action: 'volumeCreate', name: 'data' }).error), null);

console.log('\n== a binary file larger than a cell ==');
const big = crypto.randomBytes(200 * 1024);
const put = post({ action: 'volumePut', name: 'data', path: 'blobs/big.bin', data: big.toString('base64'), sha256: sha(big) });
check('upload accepted with matching sha256', put.ok && put.sha256 === sha(big) && put.size === big.length, put);
const rows = tab('data').slice(1).filter(r => r[1] === 'blobs/big.bin');
check('split into ceil(base64 / chunk) cells', rows.length === Math.ceil(big.toString('base64').length / api.SHEETSTOR_CHUNK), rows.length);
check('every data cell is under 50,000 characters and marked', rows.every(r => r[6].length <= 50000 && r[6][0] === '~'), rows.map(r => r[6].length));
const back = post({ action: 'volumeGet', name: 'data', path: 'blobs/big.bin' });
check('download returns the same bytes', Buffer.from(back.data, 'base64').equals(big), back.size);
check('registry has generation, files, size, sha256', vol('data').generation === 1 && vol('data').files === 1 && vol('data').size === big.length && /^sha256:/.test(vol('data').sha256), vol('data'));
check('files listing', get({ kind: 'files', name: 'data' }).items[0].path === 'blobs/big.bin', get({ kind: 'files', name: 'data' }));
check('volumes listing', get({ kind: 'volumes' }).items.some(v => v.name === 'data'), get({ kind: 'volumes' }));
const empty = post({ action: 'volumePut', name: 'data', path: 'empty', data: '' });
check('an empty file round-trips', empty.ok && post({ action: 'volumeGet', name: 'data', path: 'empty' }).data === '', empty);
check('a damaged upload is reported', /upload damaged/.test(post({ action: 'volumePut', name: 'data', path: 'x', data: 'aGk=', sha256: 'sha256:00' }).error), null);
check('paths cannot escape', /bad path/.test(post({ action: 'volumePut', name: 'data', path: '../x', data: '' }).error), null);

console.log('\n== copy-on-write: a crash before the pointer flip ==');
api.sheetstorWrite('data', 'state.json', '{"v":1}');
const genBefore = vol('data').generation;
api._faults.push((name) => { if (name === 'Volumes') throw new Error('injected crash: execution killed before the flip'); });
check('the write fails', throws(() => api.sheetstorWrite('data', 'state.json', '{"v":2}'), /injected crash/), null);
api._faults.length = 0;
check('the lock was released by the crash', api._lock.held === false, api._lock);
check('the pointer did not move', vol('data').generation === genBefore, vol('data'));
const text = (n, p) => Buffer.from(unsigned(api.sheetstorRead(n, p).bytes)).toString('utf8');
check('readers still see the previous generation', text('data', 'state.json') === '{"v":1}', text('data', 'state.json'));
check('the orphaned rows are there (above the pointer)', tab('data').slice(1).some(r => r[1] === 'state.json' && r[0] > genBefore), null);
api.sheetstorWrite('data', 'state.json', '{"v":3}');
check('the next write wins', text('data', 'state.json') === '{"v":3}', null);
const stateRows = tab('data').slice(1).filter(r => r[1] === 'state.json');
check('garbage collection removed the orphan and the old generation', stateRows.length === 1 && stateRows[0][0] === vol('data').generation, stateRows.map(r => r[0]));

console.log('\n== a crash while writing the data ==');
api._faults.push((name) => { if (name === 'sheetstor-data') throw new Error('injected crash: quota exceeded'); });
check('the write fails', throws(() => api.sheetstorWrite('data', 'state.json', '{"v":4}'), /injected crash/), null);
api._faults.length = 0;
check('the previous content is intact', text('data', 'state.json') === '{"v":3}', null);

console.log('\n== corruption is detected ==');
const r0 = tab('data').findIndex(r => r[1] === 'state.json');
const saved = tab('data')[r0][6];
tab('data')[r0][6] = '~' + Buffer.from('{"v":666}').toString('base64');
check('a tampered cell fails the sha256 check', throws(() => api.sheetstorRead('data', 'state.json'), /checksum mismatch/), null);
tab('data')[r0][6] = saved;

console.log('\n== tombstones ==');
check('remove', post({ action: 'volumeRm', name: 'data', path: 'empty' }).ok, null);
check('a removed file is gone', !api.sheetstorList('data').some(f => f.path === 'empty'), api.sheetstorList('data'));
check('no rows are left behind for it, tombstone included', !tab('data').slice(1).some(r => r[1] === 'empty'), null);
check('removing twice is an error', /no such file/.test(post({ action: 'volumeRm', name: 'data', path: 'empty' }).error), null);

console.log('\n== read-only volumes ==');
post({ action: 'volumeCreate', name: 'media', mode: 'ro' });
const png = crypto.randomBytes(3000);
check('the owner can fill a ro volume through skctl', post({ action: 'volumePut', name: 'media', path: 'cat.png', data: png.toString('base64') }).ok, null);
const ro = api.skLocked(() => api.sheetstorHandle_('media', false));
check('a pod cannot write it', throws(() => api.skLocked(() => ro.write('x.txt', 'no')), /read-only/), null);
const blob = api.skLocked(() => ro.read('cat.png'));
check('a pod reads a Blob with bytes and a content type', Buffer.from(unsigned(blob.getBytes())).equals(png) && blob.getContentType() === 'image/png' && blob.getName() === 'cat.png', blob.getContentType());
const rwAsRo = api.skLocked(() => api.sheetstorHandle_('data', true));
check('a rw volume mounted :ro cannot be written either', throws(() => api.skLocked(() => rwAsRo.write('x', 'no')), /read-only/), null);

console.log('\n== many writes keep the tab small ==');
for (let i = 0; i < 20; i++) api.sheetstorWrite('data', 'counter', String(i));
check('only the live generation of each file stays', tab('data').slice(1).filter(r => r[1] === 'counter').length === 1, null);
check('20 writes later the value is the last one', text('data', 'counter') === '19', null);

console.log('\n== delete a volume ==');
check('volumeDelete', post({ action: 'volumeDelete', name: 'media' }).ok && !api._store['sheetstor-media'] && !vol('media'), null);

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
