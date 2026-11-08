#!/usr/bin/env node
// A kubelet without Docker, for tests: heartbeats like kubelet.sh and reports
// every pod the apiserver wants on this node as Running, with a fake log line.
//
//   WEBAPP_URL=http://127.0.0.1:8787/exec NODE_NAME=node-a node hack/fake-kubelet.js
'use strict';
const url = process.env.WEBAPP_URL || 'http://127.0.0.1:8787/exec';
const node = process.env.NODE_NAME || 'fake-node';
const interval = Number(process.env.INTERVAL || 1) * 1000;
const token = process.env.TOKEN || 'CHANGE_ME_super_secret';
let running = [];
async function beat() {
  const body = { token, node, ip: process.env.NODE_IP || '127.0.0.1',
    cpu_total: Number(process.env.CPU_TOTAL || 4000), mem_total: Number(process.env.MEM_TOTAL || 8192),
    labels: process.env.NODE_LABELS || '', taints: process.env.NODE_TAINTS || '',
    pods: running.map(name => ({ name, phase: 'Running', container_id: 'fake-' + name,
      logs: `hello from ${name} on ${node}\n` })) };
  try {
    const res = await fetch(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
    const out = await res.json();
    running = (out.pods || []).filter(p => p.desired === 'Running').map(p => p.name);
  } catch (e) { console.error('[fake-kubelet]', e.message); }
}
setInterval(beat, interval);
beat();
