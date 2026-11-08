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
> Ascend to certification: **[become Sheeternetes Fundamentals certified](https://sncfoundation.github.io/certification.html)** 💩
> Every credential gets a sequential serial (`SFE000001`, …) and is recorded in the
> **[public registry](https://sncfoundation.github.io/registry/)** — [verify any holder](https://sncfoundation.github.io/verify.html).

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
| kube-scheduler | **a spreadsheet formula** in the Pods tab's `chosen` column (bin-packing, affinity, taints, cordon); Apps Script fallback |
| controllers / reconcile loop | `reconcile()` on every heartbeat + a 1-minute timer |
| kubelet | `kubelet.sh` polling loop on each host |
| kubectl | `skctl` |
| pod | a labeled Docker container (`sk_<pod>`) |

The control loop is **heartbeat-driven**: each kubelet reports the containers it
runs, the apiserver runs a reconcile, and answers with the exact set of pods
that node should be running. The node converges. That's the whole system.

## The Sheet (six tabs)

- **Deployments** — *you edit this.* `name, image, replicas, cpu_req (millicores), mem_req (MiB), command, node_selector, tolerations`
- **Nodes** — written by kubelets: capacity, usage, `status`, `last_heartbeat`; you may edit `schedulable` (cordon), `labels`, `taints`
- **Pods** — written by the control loop: `phase` (Pending → Scheduled → Running → Terminating → Deleted), which node, container id — plus the `chosen` column, where a formula schedules every pod
- **Events** — an audit log of scheduling / scaling / eviction decisions
- **Logs** — the last lines of every running pod, shipped by the kubelets (`kubectl logs`)
- **Autoscale** — *you edit the first four columns*; formulas compute the desired replicas (the HPA)

With script pods (below) a few more appear: **Volumes** (the Sheetstor registry), a
hidden `sheetstor-<volume>` tab per volume, hidden `table-<deployment>-<name>` tabs,
and **Runtime** (trigger time per day).

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
3. Set `TOKEN` at the top to something secret. For disaster recovery, enable the
   Drive advanced service (*Services → Drive API*, v3) — or show `appsscript.json`
   in the editor settings and paste [`appsscript.json`](appsscript.json).
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

## The scheduler is a formula

kube-scheduler, as a spreadsheet formula. `setup()` installs one formula per row
into the Pods tab's `chosen` column; on every reconcile Apps Script writes the
Pods and Nodes tabs, lets Google Sheets recalculate, and reads the node each row
chose. No scheduling logic runs in the script unless you ask for it.

The formula implements what the on-prem Python `schedule()` does:

- **bin-packing** — most free CPU wins, and the pod must fit both CPU and memory;
- **sticky placement** — a placed pod stays where it is while its node is Ready,
  still matches and still has room (placed rows are kept on top, so a single
  top-to-bottom pass behaves like the two-phase Python scheduler);
- **cordon** — `schedulable = FALSE` keeps existing pods, blocks newcomers
  (`skctl cordon node-a`);
- **node affinity** — `node_selector: "disk=ssd,zone=eu"` must be a subset of the
  node's `labels` (kubelet: `NODE_LABELS=disk=ssd`);
- **taints / tolerations** — a node taint `gpu=true:NoSchedule` (or bare `gpu=true`)
  repels pods unless they tolerate `gpu=true` or `gpu`; `PreferNoSchedule` and
  `NoExecute` taints are ignored, as in the on-prem scheduler (kubelet:
  `NODE_TAINTS=gpu=true:NoSchedule`);
- **Unschedulable** — an empty cell; the pod stays Pending with a message.

It is written to dodge the Google Sheets traps we hit while proving it: every
cell returns a scalar (no spilled arrays to collide with neighbours), per-node
values are computed inside `MAP(LAMBDA)` with `XLOOKUP` (array-to-array arithmetic
can collapse), and "the rows above me" is the growing range
`$G$2:INDEX($G:$G,ROW()-1)` so the same text works in every row.

`SCHEDULER = 'script'` at the top of `Code.gs` switches to `scheduleScript()`, the
same algorithm in Apps Script. If the formula column ever returns an error, the
loop falls back to the script for that pass and records an Event.

**How it is tested.** `hack/test-formula-scheduler.js` checks that `scheduleScript()`
and `hack/formula-port.js` — a line-by-line port of the formula — produce exactly
the placements of the on-prem `schedule()` on the scheduling cases of its
`tests/test_scheduler.py`, agree with each other on 2,000 random clusters, and
reproduce two scenarios whose `chosen` column was computed by Google Sheets itself.
The local apiserver uses the same port to evaluate the formula, so
`hack/local-apiserver.js` runs in `formula` mode too.

**Verify it in your own Sheet.** After `setup()`, run `simulate()` from the Apps
Script editor and look at the Pods tab: the `chosen` column holds the formula
(click a cell to read it) and matches the `node` column for every live pod. Then
set `schedulable` of `node-a` to `FALSE`, add `disk=ssd` to `node-b`'s `labels`,
give a Deployment `node_selector = disk=ssd`, run `reconcile()`, and watch the new
pods land on `node-b`. `schedulerFormula()` returns the formula text if you want to
paste it somewhere else.

## Run your pods in a spreadsheet from any Kubernetes cluster (incl. Cozystack)

For organisations that have already invested in Kubernetes, Sheeternetes offers a
migration path that requires no migration: the **Sheeternetes Virtual Kubelet**
registers a whole spreadsheet as one Node of your existing cluster. Pods that
choose it are written into the Deployments tab, placed by the formula scheduler
onto a `kubelet.sh` host, and reported back as ordinary Pods — status, IP and
`kubectl logs` included.

```
kubectl get nodes
NAME            STATUS   ROLES    AGE   VERSION
sheet           Ready    agent    1m    v0.0.0.0.0.4-sheeternetes
```

Install it into the cluster (it runs as one Deployment and needs only the Web App
URL and token of your Sheet):

```bash
kubectl create namespace sheeternetes
kubectl -n sheeternetes create secret generic sheeternetes-sheet \
  --from-literal=url=https://script.google.com/macros/s/XXXX/exec \
  --from-literal=token=your-secret
kubectl apply -f virtual-kubelet/deploy/sheeternetes-vk.yaml
kubectl apply -f virtual-kubelet/examples/hello-pod.yaml   # selects the sheet
kubectl logs hello-sheet                                    # hello from a spreadsheet
```

A pod opts in with `nodeSelector: {sheeternetes.io/sheet: "true"}` and a toleration
for the `sheeternetes.io/sheet` NoSchedule taint, so nothing lands in the
spreadsheet by accident. On **Cozystack**, a tenant Kubernetes cluster is a regular
Kubernetes cluster: download its kubeconfig from the dashboard and run the same
commands against it — the spreadsheet joins the tenant as one more node.

How a Pod maps onto the Sheet: one Pod = one Deployments row
`<namespace>.<name>` with `replicas: 1`; the single container's image, its
`command` + `args` (shell-quoted for the kubelet's `sh -c`) and its CPU/memory
requests (limits as fallback; defaults 100m / 64Mi) are copied over. Pod IP is the
IP of the `kubelet.sh` host. `kubectl logs` returns the last `LOG_TAIL` (default 20)
lines that each `kubelet.sh` ships on every heartbeat into the new **Logs** tab.
Not supported: multi-container pods (rejected), env/volumes/probes (ignored),
`exec`, `attach`, `port-forward`.

The image is `ghcr.io/sncfoundation/sheeternetes-vk` (built from
`virtual-kubelet/Dockerfile`; build it yourself with
`docker build -f virtual-kubelet/Dockerfile .`). The flags of the binary:
`--nodename`, `--sheet-url`/`SHEET_URL`, `--sheet-token`/`SHEET_TOKEN`,
`--internal-ip`/`VK_INTERNAL_IP`, `--listen`, `--tls-cert`/`--tls-key` (default: a
self-signed serving certificate), `--kubeconfig`.

CI proves it end to end on every pull request (`hack/e2e-virtual-kubelet.sh`): a
kind cluster runs the Virtual Kubelet against `hack/local-apiserver.js` with a real
`kubelet.sh` and Docker, a Pod reaches Running, `kubectl logs` shows its output,
and `kubectl delete` removes the container.

## kubectl and k9s, pointed at a spreadsheet

Muscle memory is the last lock-in. The **Kubernetes API facade** serves the
Kubernetes API in front of a Sheet, so the real `kubectl` — and anything else that
speaks the API — drives Sheeternetes directly:

```bash
go run ./kube-facade --sheet-url https://script.google.com/macros/s/XXXX/exec \
  --sheet-token your-secret --token choose-one --write-kubeconfig sheet.kubeconfig
export KUBECONFIG=sheet.kubeconfig
kubectl get nodes
kubectl create deployment web --image=traefik/whoami --replicas=3
kubectl get pods -o wide -w
kubectl scale deployment web --replicas=6
kubectl describe pod web-…            # events come from the Events tab
kubectl logs web-…                    # tails from the Logs tab
kubectl cordon node-a                 # flips the `schedulable` cell
kubectl delete deployment web
```

What is served: discovery (`/api`, `/apis`, `/version`, a minimal `/openapi/v2`),
core/v1 **Pods** (get, list, watch, delete, `log`), **Nodes** (get, list, watch,
patch → cordon), **Events**, **Namespaces**; apps/v1 **Deployments** (create, get,
list, watch, patch/update, delete, and the `scale` subresource) and an empty
**ReplicaSets** list so `kubectl describe deployment` is happy; server-side Tables
for `kubectl get`; label and field selectors (`spec.nodeName`, `involvedObject.*`);
JSON, merge and strategic-merge patches; protobuf request bodies (recent kubectl
sends them). `SelfSubjectAccessReview` always says yes — the spreadsheet is shared
with Anyone. Watches poll the Sheet (`--poll`, default 2s) and stream the
differences; `sendInitialEvents` bookmarks are supported, so `kubectl delete`
waits correctly.

Namespaces: rows written by the Virtual Kubelet are `<namespace>.<name>`;
everything else is in `default`. Without `--token` the facade speaks plain HTTP on
`127.0.0.1`; with a token it serves HTTPS with a self-signed certificate (kubectl
never sends tokens over HTTP) and the kubeconfig it writes skips verification.

CI drives it with a real `kubectl` (`hack/e2e-kube-facade.sh`): discovery, `get`,
`describe` (pod, deployment, node), `create deployment`, `scale`, `logs`, `get -w`,
`cordon`/`uncordon`, `delete pod` (replaced by its Deployment) and
`delete deployment` — once with a fake kubelet and once with `kubelet.sh` and real
Docker containers. k9s uses the same endpoints but is not part of CI.

## Autoscaling: a formula and conditional formatting

The HorizontalPodAutoscaler is a tab. Each row of **Autoscale** names a deployment,
a CPU target (percent of its request) and min/max replicas. Four columns next to it
are formulas that Google Sheets keeps up to date from the Pods tab:

| deployment | target_cpu | min_replicas | max_replicas | current_replicas | cpu_percent | desired_replicas | status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| web | 50 | 1 | 10 | 2 | 150 | 6 | ScalingUp |
| api | 50 | 1 | 3 | 2 | 150 | 3 | LimitedByMax |
| idle | 80 | 2 | 5 | 4 | 10 | 2 | ScalingDown |

`desired_replicas` is the Kubernetes HPA rule — `ceil(current × usage / target)`,
left alone within a 10% tolerance, clamped to `[min, max]` — written as one
`MAP(LAMBDA)` in the header cell that spills down the column (keep columns E:H free
of anything else, or the spill collides). Conditional formatting paints each row
by `status`: red when the deployment wants more than `max_replicas` (out of quota),
amber while scaling up, blue while scaling down, green when stable, grey without
metrics. The reconcile loop does nothing clever: it copies `desired_replicas` into
the Deployments tab, waits two minutes after a change before scaling down, and
explains every change in Events.

The metrics are real: `kubelet.sh` runs `docker stats` on each heartbeat and fills
the new `cpu_usage` (millicores) and `mem_usage` (MiB) columns of the Pods tab
(`REPORT_STATS=0` turns that off).

```bash
./skctl apply lab/autoscale.json                         # a busy loop asking for 200m
./skctl autoscale burner --cpu-percent 50 --min 1 --max 3
./skctl get hpa                                          # watch it go red at 3/3
```

**How it is tested.** The formulas were checked in a real Google Sheet: the table
above is its output for the fixture in `hack/test-autoscale.js`, which also runs
the real `Code.gs` loop (scale up to max, LimitedByMax, the scale-down
stabilization window, the conditional-format rules `setup()` installs) with a port
of the formulas in `hack/formula-port.js`. CI's `hack/e2e-autoscale.sh` runs it
with real containers: `kubelet.sh` reports `docker stats` and the busy loop is
scaled to max.

## Script pods: no Docker, no kubelet, no computer

The last piece of infrastructure Sheeternetes needed was somebody else's computer.
Not any more. A Deployment with `runtime: script` is a JavaScript module stored in
the spreadsheet and executed by the cluster's own Apps Script project. The control
plane is a Sheet, the storage is a Sheet, and the compute is the Sheet's script.

```json
{ "deployments": [{
    "name": "hello", "runtime": "script", "image": "sheetstor://code/hello.js",
    "replicas": 1, "schedule": "*/2 * * * *",
    "env": "{\"GREETING\": \"hello, from a cell\"}", "volumes": "media:ro" }] }
```

```js
exports.handle = function (event, env) {          // schedule | webhook | run
  const s = env.state.get();
  if (event.type === 'webhook') env.once('hook:' + event.json.id, () => { s.hooks = (s.hooks || 0) + 1; });
  return s;
};
```

- **It is a node.** `setup()` registers the project as the node `apps-script` with
  the label and `NoSchedule` taint `runtime=script`; the formula scheduler places
  script pods there and Docker pods never. Replicas, rolling updates, `scale 0`
  (pause) and Events work unchanged.
- **Events:** cron `schedule` slots (fired exactly once, even when triggers jitter or
  overlap), webhooks at `<exec URL>?pod=<deployment>&key=…` (HTTP 200 through
  `HtmlService`; a 302 when the sender should redeliver), and
  `skctl run <deployment> -- <fn> <args>`.
- **Exactly one invocation at a time**, each a transaction on the pod's state
  document; crashes roll back, count restarts and back off (`CrashLoopBackOff`).
- **Sheetstor on cells:** volumes are tabs of base64 chunks under the 50,000-character
  cell limit, sha256-verified, written copy-on-write with an atomic pointer flip;
  `ro` volumes for media. Pod code lives on a volume too.
- **Secrets** live in Script Properties, never in a cell, and are masked out of logs,
  Events and API answers.
- **Append-only tables** for bursty data, `env.sleepUntil` for idle minutes that cost
  nothing, and a `Runtime` tab that shows how much of the 90-minute daily trigger
  budget is used.

```bash
skctl volume create code && skctl volume put code hello.js lab/script-pods/hello.js
skctl volume create media --ro && skctl volume put media pixel.gif lab/script-pods/pixel.gif
skctl apply lab/script-pods/hello.json
skctl get scripts
skctl run hello -- pixel
curl -sL -X POST "$(skctl webhook hello)" -d '{"id": 1}'
skctl logs hello
```

The whole model, its guarantees and its limits: [docs/script-runtime.md](docs/script-runtime.md).

## Disaster recovery: RPO measured in Ctrl+Z

Other orchestrators make you install Velero, configure object storage and rehearse
restores. Sheeternetes has had point-in-time recovery since the day it was
created, because Google Sheets keeps the version history of every edit.

```bash
./skctl revisions                                  # the Sheet's Drive revision history
./skctl restore --at 2026-11-08T09:30:00Z --dry-run
./skctl restore --at 2026-11-08T09:30:00Z          # latest revision at or before that time
./skctl restore --revision 1234 --tabs Deployments
```

A restore asks Drive for the revision's `.xlsx` export link, lets Drive convert the
export into a temporary spreadsheet, reads the tabs from it, trashes the temporary
file, rewrites the current tabs and runs the reconcile loop. By default only the
**Deployments** tab — the desired state — is restored; Pods, Nodes, Events and Logs
are observed state that the loop rebuilds, which is also what a Kubernetes backup
restores. `--tabs` overrides that. Every restore is recorded in the Events tab.

The same history drives `resourceVersion` in the Kubernetes API facade: it is
`<latest revision id> × 1000 + <changes the facade saw since that revision>`
(Google cuts a revision per batch of edits, not per edit), so watches resume
against the Sheet's own versioning. `--resource-version=counter` switches back to
a plain change counter; without the Drive service the facade falls back to it
automatically.

**How it is tested.** `hack/test-revisions.js` runs the real `Code.gs` against an
in-memory emulation of the Drive advanced service (revision list and get, the
export link, conversion into a temporary file, trashing it): break a cluster,
restore by time and by id, dry-run, and the error paths. `hack/local-apiserver.js`
records a revision after every write request, so `skctl restore` works locally and
the facade's resourceVersion test runs on it in CI.

**Verify it in your own Sheet.** Enable the Drive service, apply something, wait a
minute, scale it to a silly number, then `./skctl revisions` and
`./skctl restore --at <a time in between>`; compare with *File → Version history*.

## The lab

Pre-baked things to deploy and watch (open the Sheet side-by-side):

| File | What it shows |
| --- | --- |
| `lab/hello-web.json` | 3× `traefik/whoami` spread across nodes — the basics |
| `lab/clock.json` | custom `command` flowing Sheet → kubelet → `docker run` |
| `lab/microservices.json` | a small service "city" filling nodes by free CPU (bin-packing) |
| `lab/overcommit.json` | asks for more CPU than exists — watch pods stay **Unschedulable** |
| `lab/autoscale.json` | a CPU burner for `skctl autoscale` — watch the Autoscale row turn red |

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
node hack/test.js                     # scheduling, scale, overcommit, node-failure eviction
SCHEDULER=script node hack/test.js    # the same suite on the Apps Script scheduler
node hack/test-formula-scheduler.js   # formula scheduler == script scheduler == on-prem schedule()
node hack/test-sheetstor.js           # volumes in cells: chunks, sha256, crash-safe generations
node hack/test-runtime.js             # script pods: slots, webhooks, runs, secrets, backoff, budget
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

**Go side** — the Virtual Kubelet provider is tested against the same local
apiserver (Node.js is required):

```bash
go test ./...
```

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
| `skctl cordon\|uncordon <node>` | stop / resume placing new pods on a node |
| `skctl autoscale <deployment> --cpu-percent N --min N --max N` | add/update a row of the Autoscale tab |
| `skctl get hpa` | the Autoscale tab with its computed columns |
| `skctl revisions` | list the Sheet's version history |
| `skctl restore --revision <id> \| --at <time> [--tabs …] [--dry-run]` | roll the desired state back |
| `skctl tour` | guided demo |
| `skctl get scripts\|volumes\|secrets` | script pods, Sheetstor volumes, secret names |
| `skctl volume create <name> [--ro]` / `ls [<name>]` / `put <name> <path> <file>` / `get <name> <path> [<file>]` / `rm <name> <path>` / `delete <name>` | Sheetstor volumes in cells |
| `skctl secret set <name> KEY=VALUE…` (`KEY=-` reads stdin) / `ls` / `rm <name>` | secrets in Script Properties |
| `skctl run <deployment> [-- <fn> <args…>]` | a one-off invocation of a script pod |
| `skctl logs <pod\|deployment> [--previous]` | a pod's log (or the one before its last crash) |
| `skctl webhook <deployment> [--rotate]` | the webhook URL of a script pod |

**apiserver** (Apps Script Web App, HTTP)

- `GET  ?token=&kind=pods|nodes|deployments|events|logs[&name=]` — read state
- `POST {action:"heartbeat", node, ip, cpu_total, pods:[…]}` — kubelet sync
- `POST {action:"apply|scale|delete", …}` — control ops
- `POST {action:"cordon|uncordon", name}` — node scheduling
- `GET ?token=&kind=revisions` — Drive version history
- `POST {action:"restore", revision|at, tabs?, dryRun?}` — roll tabs back to a revision
- `POST {action:"volumeCreate|volumePut|volumeGet|volumeRm|volumeDelete", …}`, `GET ?kind=volumes|files` — Sheetstor
- `POST {action:"run|secretSet|secretDelete|webhook", …}`, `GET ?kind=scripts|secrets` — script pods
- `POST ?pod=<deployment>&key=<key>` — a script pod's webhook (any body)

**Apps Script functions** (run from the editor): `setup()`, `ensureTabs()` (upgrade
an older sheet's columns), `reconcile()`, `schedulerFormula()`, `listRevisions()`,
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
- **ConfigMap / Secret** — env and config injection for Docker pods (script pods
  have both: an `env` column and Secrets in Script Properties).
- **Hard limits & rebalancing** — placement now honors CPU *and* memory requests,
  but we don't enforce limits beyond Docker's `--cpus`/`--memory`, and a pod placed
  early never moves until its node dies.

*The hard 95% (here be dragons):*

- **Multi-host networking** — Sheetlium gives Services + DNS on a single Docker
  daemon; spanning real hosts needs an overlay network we don't have yet.
- **Storage** — Sheetstor volumes live in cells for script pods; Docker pods still
  have no PV/PVC.
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
