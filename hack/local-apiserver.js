#!/usr/bin/env node
// Local drop-in for the Apps Script apiserver — runs the REAL Code.gs control
// plane (reconcile + scheduler + controllers) with an in-memory store instead
// of a Google Sheet. Lets you test the kubelet + Docker path end-to-end without
// deploying anything to Google. Point kubelets at http://localhost:8787/exec.
//
//   node hack/local-apiserver.js
//
// This is a TEST HARNESS. The real control plane is Code.gs running in Apps
// Script on top of an actual spreadsheet. Same code, different datastore.
const http = require('http');
const { loadControlPlane } = require('./sheet-mock');

// SCHEDULER=script switches to the Apps Script scheduler; default is the formula
// (evaluated locally by hack/formula-port.js, see hack/sheet-mock.js).
const api = loadControlPlane({ scheduler: process.env.SCHEDULER });
if (process.env.NO_SAMPLES) api.ensureTabs();
else api.setup();  // seed tabs + sample deployments (nginx x3, redis x1)

const PORT = process.env.PORT || 8787;
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const send = (out) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(out); };
  if (req.method === 'GET') {
    const e = { parameter: Object.fromEntries(u.searchParams) };
    send(api.doGet(e)._t);
  } else {
    let b = ''; req.on('data', c => b += c);
    req.on('end', () => { try { send(api.doPost({ postData: { contents: b } })._t); }
      catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: String(err) })); } });
  }
}).listen(PORT, () => console.log(`[local-apiserver] Code.gs control plane on http://localhost:${PORT}/exec`));
