<p align="center">
  <img src="https://sncfoundation.github.io/logos/sheeternetes.svg" alt="Sheeternetes logo" width="110">
</p>
<p align="center">
  <img src="https://sncfoundation.github.io/social-card.png" alt="Sheeternetes — a container orchestrator whose control plane is a Google Sheet" width="680">
</p>

# Sheeternetes

*(a.k.a. shiternetes — because your orchestrator is now a spreadsheet)*

*Our mission is to democratize container orchestration by meeting operators where they already are: in a spreadsheet, at 2 a.m., changing a number in a cell.*

> ## ✨ The age of complexity is over ✨
>
> For a decade, the industry accepted a lie: that orchestrating containers
> required a distributed consensus database, sixty-three resource types, a
> dedicated platform team, and a war chest for your etcd therapist. **That era
> ends today.**
>
> Sheeternetes — also known as **Shiternetes** — is the world's first
> Spreadsheet-Native Orchestration Platform™, delivering enterprise-grade
> container lifecycle management on the only runtime that has already achieved
> planetary-scale adoption: the humble Google Sheet. No clusters to provision.
> No control plane to operate. Just Infinite Power, one row at a time. Zero YAML
> (we use JSON, which is merely YAML that has compiled).
>
> The post-Kubernetes era begins in **cell A1**.
>
> Ascend to certification: **[become Sheeternetes Fundamentals certified](https://sncfoundation.github.io/sheeternetes/#certify)** 💩
> Every credential gets a sequential serial (`SFE000001`, …) and is recorded in the
> **[public registry](https://sncfoundation.github.io/registry/)** — [verify any holder](https://sncfoundation.github.io/sheeternetes/verify.html).

> "Had we known about this superior product three years ago, Cozystack would have
> been built around Sheeternetes from day one — not classic Kubernetes."
> — **Timur Tukaev**, Cozystack maintainer · Co-founder & COO, Aenix

**A container orchestrator whose control plane is a Google Sheet.**

Real Docker containers, on real hosts, scheduled and self-healed by a control
loop written in Google Apps Script — with a spreadsheet as the datastore.

It started as a bar-bet-grade joke ("can you build a container orchestrator in
Excel?") and turned out to be a surprisingly faithful teaching model, because
Kubernetes and a spreadsheet are the same kind of thing underneath: a
**declarative, desired-state engine that reconciles reality toward what you
declared.**

```
  You edit the "Deployments" tab   ──►  desired state (like etcd)
  Apps Script reconcile loop       ──►  scheduler + controllers (like kube-controller-manager)
  Apps Script Web App endpoint     ──►  apiserver
  kubelet.sh on each Docker host   ──►  kubelet
  Docker containers                ──►  pods
```

> This is an educational toy. Do not run production on a spreadsheet. (If you do,
> please film it.)

## How it maps to Kubernetes

Sheeternetes did not reinvent the control plane. It merely relocated it to a
substrate your finance department already trusts. Every primitive Kubernetes
charges you a platform team to operate has a direct, load-bearing equivalent below.

| Kubernetes | Sheeternetes |
| --- | --- |
| etcd (desired + observed state) | tabs in the Google Sheet |
| kube-apiserver | Apps Script Web App (`doGet`/`doPost`) |
| scheduler (bin-packing) | `reconcile()` picks the Ready node with most free CPU |
| controllers / reconcile loop | `reconcile()` on every heartbeat + a 1-minute timer |
| kubelet | `kubelet.sh` polling loop on each host |
| kubectl | `skctl` |
| pod | a labeled Docker container (`sk_<pod>`) |

The control loop is **heartbeat-driven**: each kubelet reports the containers it
runs, the apiserver runs a reconcile, and answers with the exact set of pods
that node should be running. The node converges. That's the whole system.

## The Sheet (four tabs)

- **Deployments** — *you edit this.* `name, image, replicas, cpu_req (millicores), mem_req (MiB), command`
- **Nodes** — written by kubelets: capacity, usage, `status`, `last_heartbeat`
- **Pods** — written by the control loop: `phase` (Pending → Scheduled → Running → Terminating → Deleted), which node, container id
- **Events** — an audit log of scheduling / scaling / eviction decisions

## Prerequisites

You do not need Kubernetes, etcd, a cluster, or a platform team. You need:

- **A Google account** — for the Sheet and Apps Script. This *is* the entire
  control plane; there is no server to run or database to host.
- **One or more Docker hosts** to run pods on. Each needs `bash`, `curl`, `jq`,
  and `docker`. Linux or macOS both work; a single laptop is enough
  (`local-cluster.sh` fakes 3 nodes on one Docker daemon).
- **Node.js** — *optional*, only to run the test harness / `hack/local-apiserver.js`
  and try the whole thing without Google at all.

There is **no schema to import and no template to copy**: running `setup()` once
turns a blank spreadsheet into the full Sheeternetes structure (the four tabs,
their headers, a sample workload, and the reconcile timer).

## Quickstart

### 1. Control plane (Apps Script)

1. Create a **blank** Google Sheet.
2. **Extensions → Apps Script**, paste [`Code.gs`](Code.gs).
3. Set `TOKEN` at the top to something secret.
4. Run `setup()` once (grant permissions when prompted — it's your own script,
   so on the "Google hasn't verified this app" screen choose *Advanced → Go to …*).
   This turns the blank sheet into the full structure: the four tabs with headers,
   two sample deployments, and the 1-minute reconcile trigger.
5. **Deploy → New deployment → Web app**, *Execute as: Me*, *Who has access:
   Anyone*. Copy the `/exec` URL (it ends in `/exec`, not `/dev`).

### 2. CLI

```bash
cat > .skctl.env <<EOF
WEBAPP_URL=https://script.google.com/macros/s/XXXX/exec
TOKEN=your-secret
EOF
chmod +x skctl kubelet.sh local-cluster.sh lab/tour.sh
```

### 3. Nodes

On any Docker host (needs `bash curl jq docker`):

```bash
WEBAPP_URL=... TOKEN=... NODE_NAME=node-a CPU_TOTAL=4000 MEM_TOTAL=8192 ./kubelet.sh
```

Or fake a 3-node cluster on one machine:

```bash
./local-cluster.sh          # starts node-a/b/c as background kubelets
./skctl get nodes
```

### 4. Drive it

```bash
./skctl get nodes
./skctl apply lab/hello-web.json
./skctl get pods
./skctl scale whoami 6
./skctl get events
```

## The lab

Pre-baked things to deploy and watch (open the Sheet side-by-side):

| File | What it shows |
| --- | --- |
| `lab/hello-web.json` | 3× `traefik/whoami` spread across nodes — the basics |
| `lab/clock.json` | custom `command` flowing Sheet → kubelet → `docker run` |
| `lab/microservices.json` | a small service "city" filling nodes by free CPU (bin-packing) |
| `lab/overcommit.json` | asks for more CPU than exists — watch pods stay **Unschedulable** |

Guided demo (deploy → scale → self-heal → clean up):

```bash
./skctl tour
```

To see **self-healing**: with the tour running, stop one kubelet
(`./local-cluster.sh stop` or Ctrl-C a single node). After ~90s its node goes
`NotReady`, and the control loop reschedules its pods onto the survivors — just
like the real thing.

## Testing

You don't need Google to test the orchestration path.

**Control-plane unit test** — runs the real `Code.gs` scheduler/reconcile in Node
with a mocked Sheet:

```bash
node hack/test.js     # asserts scheduling, scale, overcommit, node-failure eviction
```

**Full end-to-end with real containers, no Google** — `hack/local-apiserver.js`
serves the exact `Code.gs` control plane backed by an in-memory store, so real
kubelets run real Docker containers against it:

```bash
node hack/local-apiserver.js &
printf 'WEBAPP_URL=http://localhost:8787/exec\nTOKEN=CHANGE_ME_super_secret\n' > .skctl.env
./local-cluster.sh                 # 3 kubelets + real containers
./skctl get pods                   # watch them go Running
./skctl scale nginx 6              # watch bin-packing spread across nodes
```

Simulate a node failure and watch pods reschedule:

```bash
kill "$(lsof -t .run/node-c.log)"
docker rm -f $(docker ps -q --filter label=sheeternetes.node=node-c)
# ~90s later its pods reappear on the surviving nodes
```

The kubelets are byte-for-byte identical against the local shim and against a
real Sheet — only `WEBAPP_URL` changes.

**Visual proof in the Sheet** — with `Code.gs` deployed, run `simulate()` from the
Apps Script editor: it registers three fake nodes, runs the real scheduler, and
drives pods to Running so the Sheet fills live. `simulateNodeFailure()` ages a
node past its heartbeat so you can watch the reschedule. Ideal for a screen
recording.

## Command reference

**`skctl`** (the CLI)

| Command | Does |
| --- | --- |
| `skctl get pods\|nodes\|deployments\|events` | read state |
| `skctl apply <file.json>` | create/update deployments (our `kubectl apply -f`) |
| `skctl scale <deployment> <n>` | change replicas |
| `skctl delete <deployment>` | remove a deployment |
| `skctl tour` | guided demo |

**apiserver** (Apps Script Web App, HTTP)

- `GET  ?token=&kind=pods|nodes|deployments|events` — read state
- `POST {action:"heartbeat", node, ip, cpu_total, pods:[…]}` — kubelet sync
- `POST {action:"apply|scale|delete", …}` — control ops

**Apps Script functions** (run from the editor): `setup()`, `reconcile()`,
`simulate()`, `simulateNodeFailure()`.

**On the host, a kubelet issues plain Docker:** `docker ps`, `docker run -d`,
`docker rm -f`, joining every pod to the shared `sheeternetes` network with its
deployment name as a DNS alias (Sheetlium). A pod's `command` runs as
`sh -c "<command>"` inside the container.

**Sheetlux CD** (GitOps): `./sheetlux <dir>` watches a directory of manifests and
applies them on change — Git is the source of truth. Reach any deployment from
another pod at `http://<deployment-name>/` thanks to Sheetlium.

## The ecosystem

A platform is only as credible as the portfolio that surrounds it. Sheeternetes
anchors a rapidly maturing suite of best-of-breed, spreadsheet-first solutions —
each a category leader in a category of exactly one:

| Component | Kubernetes analog | What it does | Status |
| --- | --- | --- | --- |
| **Sheeternetes** | Kubernetes | the orchestrator itself | ✅ works |
| **Sheetlium** | Cilium | shared Docker network + deployment-name DNS aliases = **Services** with round-robin load balancing | ✅ works (single-host) |
| **Sheetlux CD** | Flux / Argo CD | GitOps: `./sheetlux <dir>` continuously syncs a directory of manifests into the cluster | ✅ works |
| **SheetHub** | GitLab / GitHub | DevOps forge on a spreadsheet (repos, issues, MRs with spec diffs, releases, manifests) | ✅ works ([`sheethub`](https://github.com/sncfoundation/sheethub)) |
| **SheetVirt** | KubeVirt | run VMs as pods | 🔭 vision (VMs are the hard 95%) |

## Status — what works, what's missing, and the road to dethroning Kubernetes

We believe in radical transparency with our stakeholders. The following is a
candid, forward-looking assessment of our platform's journey from category
disruptor to eventual industry standard.

**Works today (all demonstrated end-to-end with real containers):** declarative
deployments, a CPU- and memory-aware bin-packing scheduler, replica management, scale up/down, node
heartbeats and readiness, **self-healing on node failure**, **restart-on-crash**
(a vanished container is revived in place), **rolling updates** (spec change rolls
pods one at a time, maxUnavailable=1), **Services + DNS + load balancing**
(Sheetlium), **GitOps** (Sheetlux CD), overcommit protection (Unschedulable), an
audit log of decisions, a real Docker runtime, and a kubectl-style CLI.

**Missing — i.e. roughly all of the rest of Kubernetes.** The reconcile loop is
the easy 5%; multi-host networking, storage, and a consistent datastore are the
hard 95%.

*Cheap wins still on the table:*

- **Rollback** — keep the previous image and revert a bad roll.
- **ConfigMap / Secret** — env and config injection.
- **Hard limits & rebalancing** — placement now honors CPU *and* memory requests,
  but we don't enforce limits beyond Docker's `--cpus`/`--memory`, and a pod placed
  early never moves until its node dies.
- **Horizontal autoscaling** on a simple metric.

*The hard 95% (here be dragons):*

- **Multi-host networking** — Sheetlium gives Services + DNS on a single Docker
  daemon; spanning real hosts needs an overlay network we don't have yet.
- **Storage** — no volumes, PV/PVC, stateful data.
- **Ingress** — no external traffic routing.
- **Multi-tenancy** — no namespaces, no RBAC (a single shared token).
- **Consistency** — Google Sheets is not a quorum store: API quotas, no
  watch/streaming (we poll), no leader election, races under concurrency.
- **Extensibility** — no CRDs, operators, or admission control.

Honest verdict: Sheeternetes faithfully reproduces the *shape* of Kubernetes —
declarative desired state converged by a control loop — and almost none of its
*substance*. That's the joke, and also the lesson.

## Prior art

[`xlskubectl`](https://github.com/learnk8s/xlskubectl) (learnk8s) drives a **real**
Kubernetes cluster from a spreadsheet — the Sheet is a remote control over a live
cluster. Sheeternetes is the inverse: there is no Kubernetes underneath, the
spreadsheet **is** the orchestrator. xlskubectl is a frontend; Sheeternetes is
the engine.

## Compliance

Sheeternetes is SOC 2, ISO 27001, and FedRAMP **aspirational** — meaning we
aspire to them, deeply, and have taken no further action.

## License

[Apache License 2.0](LICENSE).
