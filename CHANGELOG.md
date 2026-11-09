# Changelog

All notable changes to Sheeternetes are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning is based on
however many zeroes we feel like, because the spreadsheet is eternal.

## [Unreleased]

## [v0.0.0.0.0.6] — "On change and every hour" — 2026-11-10

The cluster learned to do nothing cheaply. Apps Script counts every trigger execution
from its start-up, and the Executions page showed that the idle KUBER KOMBAT cluster spent
about 143 s an hour, almost two thirds of the 90-minute daily budget. Now an idle cluster
runs two executions an hour (a lease-and-fingerprint pass and an idle tick, about 2 s an
hour by the runtime's own counter, under 3% of the budget with start-up), reacts to edits
and API calls at once, cleans up pods that never got a node, answers webhooks faster, and
`skctl selftest` checks the formulas against real Google Sheets in any locale.

### Added
- **`skctl selftest`** (`Selftest.gs`): the control plane against real Google Sheets. The
  cluster's web app creates a scratch spreadsheet per locale (en_US and ru_RU by default,
  `--locale` for others) in the owner's Drive, runs the tab setup, a reconcile pass with
  the formula scheduler and the autoscaler's formulas, checks the computed cells (syntax
  detected, every pod placed by the formula, formula and Apps Script scheduler agree,
  selectors and taints, HPA columns) and moves the file to the trash (`--keep` keeps it).
  It needs nothing but the cluster's URL and token, so no Google credential lives in CI;
  `hack/test-selftest.js` runs the same checks on the mock.
- `skctl get budget` shows idle ticks, full passes and reconcile passes per day.
- `env.table(...).count()`: the row count of an append-only table, for caches.

### Changed
- **An idle cluster runs two executions an hour.** Apps Script counts every trigger
  execution from its start-up (about a second the script never sees), so a 1-minute tick
  that only read one property still cost 0.6–1.5 s, and an idle cluster spent more than
  half of the 90-minute daily budget. The runtime now keeps a 30-minute trigger
  (`runtimeTickSlow`) for the node lease (two and a half hours, renewed hourly) and the
  hourly backstop, and installs the 1-minute trigger only while something is due within half an
  hour; API calls, `env.sleepUntil` and an edit by hand (an installable on-edit trigger)
  bring it back at once. A cluster of an older version switches on its next tick.
- The backstop runs hourly instead of every ten minutes and no longer reconciles by default: it compares a fingerprint of
  Deployments, Pods and Nodes with what the last reconcile pass left and runs the loop
  only when they differ (e.g. after an edit by hand). An Unschedulable pod no longer makes
  every full pass reconcile.
- Script pods read less per event: the volume registry is read once per lock, volumes
  mounted into a pod are looked up on first use, one Script Properties read serves the
  masker, the pod's status and its secrets, and code, state and text files on volumes come
  through CacheService keyed by the volume's manifest digest. On the live cluster a
  `/score` answer of the KUBER KOMBAT pod went from 6.1–7.9 s to 2.5–4.1 s.

### Fixed
- **Terminating pods that never got a node** (a Deployment deleted while its pods were
  Unschedulable, e.g. in a cluster without Docker nodes) stayed in the Pods tab forever.
  The reconcile loop now deletes Terminating pods that have no node to stop them on, or
  whose node is gone from the Nodes tab, with an Event.
- **Formula scheduler in non-English spreadsheets.** `setFormula()` parses formula text
  in the spreadsheet's locale, and in decimal-comma locales (ru_RU, de_DE, fr_FR, …)
  arguments are separated by `;`, so the en_US text of the `chosen` column (and of the
  Autoscale tab) was a "Formula parse error" and every reconcile pass fell back to the
  Apps Script scheduler. Formulas are now written in the spreadsheet's own syntax,
  detected once per locale with a probe formula (`=SUM(1,2)`) and cached.
- A sheet set up by an older version is upgraded on the first write: a stale header row
  (e.g. Pods without `cpu_usage`/`mem_usage`, `chosen` where a data column now lives) is
  rewritten by `ensureTabs()` instead of silently shifting columns.

### Tests
- `hack/sheet-mock.js` emulates the locale (`SHEET_LOCALE`, default en_US): formula text
  the locale cannot parse becomes `#ERROR!`, as in Google Sheets. CI runs the whole
  control-plane suite in ru_RU too, and `hack/test-formula-scheduler.js` checks the exact
  formula string written into every `chosen` cell for en_US, en_GB, ru_RU and de_DE.

## [v0.0.0.0.0.5] — "Extensions → Apps Script" — 2026-11-09

Pods stopped needing a computer: a Deployment with `runtime: script` runs inside the
spreadsheet's own Apps Script project, with volumes on cells and secrets in Script
Properties. Its first production workload was the KUBER KOMBAT Telegram bot, run as a
script pod in a live Telegram test.

### Added
- **Script pods** (`Runtime.gs`, `docs/script-runtime.md`): a Deployment with
  `runtime: script` runs as a synchronous JavaScript module inside the cluster's own
  Apps Script project. `setup()` registers the project as the node `apps-script`
  (label and `NoSchedule` taint `runtime=script`), so the reconcile loop and the formula
  scheduler place these pods unchanged. Cron `schedule` slots fire exactly once (slots
  commit with the pod's state); webhooks at `?pod=<deployment>&key=…` answer HTTP 200
  through `HtmlService`, or a redirect when the sender should redeliver, and keep
  repeatedly failing bodies in a dead-letter table; `skctl run` invokes a function with
  the schedule paused. Every invocation holds the script lock and is a transaction on
  the pod's state; crashes count restarts and back off exponentially. Pods get
  `env.vars`, `env.secrets`, `env.volumes`, `env.state`, `env.once`, `env.table`
  (append-only tabs), `env.event` and `env.sleepUntil`. A `runtimeTick` trigger
  replaces the plain reconcile timer, reconciles only when something is not converged,
  and records trigger time per day in the `Runtime` tab.
- **Sheetstor on cells** (`Sheetstor.gs`, #30): a `Volumes` registry tab and a hidden
  tab per volume with files as base64 chunks under the 50,000-character cell limit,
  sha256-verified, written copy-on-write with an atomic generation flip; `rw`/`ro`
  volumes; `skctl volume create|ls|put|get|rm|delete`.
- **Secrets** (#46) in Script Properties, never in cells: `skctl secret set|ls|rm`,
  masked in logs, Events and API answers.
- `skctl get scripts|volumes|secrets`, `skctl run`, `skctl logs [--previous]`,
  `skctl webhook`; `lab/script-pods/hello.*`.
- `hack/test-sheetstor.js`, `hack/test-runtime.js`; the test harness loads every `.gs`
  file and fakes PropertiesService, CacheService, HtmlService, a contended lock and
  triggers.

### Changed
- `appsscript.json` declares its OAuth scopes (Sheets, Drive, external requests,
  triggers): code inside a string declares none, so they can no longer be inferred.
  Existing clusters re-run `setup()` once to grant them.
- `skctl` no longer forces `POST` on the redirect Apps Script answers with, which the
  real web app refused with HTTP 405.

### Known limitations
- On a real Google Sheet the formula scheduler's `chosen` column returns an error, so
  every reconcile pass falls back to the Apps Script scheduler (Events: `formula
  column returned an error -> script fallback`). Pods are still placed, by the
  script scheduler.
- Script pods run synchronously under the script lock and within Apps Script's quotas
  (execution time per invocation, triggers per day); `runtimeTick` records the trigger
  time spent per day in the `Runtime` tab.

## [v0.0.0.0.0.4] — "Version History" — 2026-11-08

The spreadsheet stopped imitating a cluster and started joining them: it schedules
with a formula, autoscales with conditional formatting, shows up as a Node in real
Kubernetes, answers `kubectl`, and rolls back through its own version history.

### Added
- **The scheduler is a spreadsheet formula.** `setup()` installs a formula into a new
  `chosen` column of the Pods tab; the reconcile loop lets Google Sheets place every
  pod and only reads the result. It does most-free-CPU bin-packing on CPU and memory,
  sticky placement, cordon, `node_selector` affinity and `NoSchedule`
  taints/tolerations. `SCHEDULER = 'script'` keeps the Apps Script implementation,
  which is also the automatic fallback if the formula column returns an error.
- `node_selector` / `tolerations` on Deployments and Pods, `schedulable` / `labels` /
  `taints` on Nodes; `NODE_LABELS` / `NODE_TAINTS` for `kubelet.sh`;
  `skctl cordon|uncordon`; `skctl get nodes` shows labels, taints and
  `SchedulingDisabled`.
- `hack/test-formula-scheduler.js`: the formula (via a line-by-line port) and the
  script scheduler match the on-prem `schedule()` on its reference cases, each other on
  2,000 random clusters, and two scenarios computed by a real Google Sheet.
- **Sheeternetes Virtual Kubelet** (`virtual-kubelet/`): a Go provider built on the
  `virtual-kubelet` node libraries that registers a spreadsheet as the Node `sheet` in
  any Kubernetes cluster (Cozystack tenant clusters included). Pods that select it
  become one-replica Deployments rows; status, IP and `kubectl logs` are read back.
  Ships with a Dockerfile, a manifest (`deploy/sheeternetes-vk.yaml`) and an example
  pod; CI runs it end to end on kind against the local apiserver and a real
  `kubelet.sh`.
- **Kubernetes API facade** (`kube-facade/`): serves discovery, core/v1 Pods (with
  `log`), Nodes, Events, Namespaces and apps/v1 Deployments (with `scale`) on top of a
  Sheet, with server-side Tables, selectors, patches, protobuf bodies and polling
  watches, so real `kubectl` can get, describe, create, scale, log, watch, cordon and
  delete. Tested in CI with a real `kubectl` and with client-go.
- **HPA via a formula and conditional formatting** (#11): an Autoscale tab whose
  formula columns compute `current_replicas`, `cpu_percent`, `desired_replicas`
  (Kubernetes HPA rule with 10% tolerance, clamped to min/max) and `status`;
  conditional formatting colours each row (red = wants more than max). The reconcile
  loop applies `desired_replicas` with a 2-minute scale-down stabilization window.
  `skctl autoscale` / `skctl get hpa`, `lab/autoscale.json`.
- `kubelet.sh` reports `docker stats` per pod; new Pods columns `cpu_usage`
  (millicores) and `mem_usage` (MiB).
- **Disaster recovery from Google Sheets version history** (#12): `skctl revisions`
  and `skctl restore --revision <id> | --at <time> [--tabs …] [--dry-run]`. Code.gs
  exports the revision through the Drive advanced service, converts it into a
  temporary spreadsheet, rewrites the Deployments tab (or the tabs you name) and
  reconciles. `appsscript.json` enables the service.
- The Kubernetes API facade takes its `resourceVersion` from the revision history
  (`revision id × 1000 + changes seen since`), with a change counter as fallback.
- `hack/test-revisions.js` and a Drive emulation in `hack/sheet-mock.js`; the local
  apiserver records a revision after every write.
- `deletePod` control op: `kubectl delete pod` marks the row Terminating and the
  Deployment replaces it.
- **Logs** tab: `kubelet.sh` ships the last `LOG_TAIL` lines of each pod on every
  heartbeat (capped at 20,000 characters per pod); `GET ?kind=logs&name=<pod>`.
- `internal/sheetapi`: a Go client for the Sheet apiserver.
- `.github/workflows/image.yml`: publishes `ghcr.io/sncfoundation/sheeternetes-vk` on tags.
- `hack/sheet-mock.js`: one Apps Script mock shared by every harness, with formula
  cells and recalculation.
- **CI** (`.github/workflows/ci.yml`): runs every `hack/test*.js` control-plane test,
  `bash -n` and `shellcheck` on all shell scripts, and `jq empty` on the lab and GitOps
  manifests on every push and pull request.

### Changed
- `skctl`: `WEBAPP_URL` / `TOKEN` from the environment now win over `.skctl.env`.

### Fixed
- README certification and verification links now point at the foundation site
  (`certification.html`, `verify.html`) instead of the retired `/sheeternetes/` paths.
- `local-cluster.sh stop` no longer word-splits the container list (shellcheck SC2046).

### Known limitations
- Verified against Google Sheets itself: the scheduler and Autoscale formulas (and
  the conditional-format formula), evaluated in a real spreadsheet. Verified only
  through the Node.js emulation of Apps Script: the Apps Script glue around them
  (`setFormula`, `flush`, conditional-format rules), and every Drive call of the
  revision restore. The Virtual Kubelet and the API facade were tested on kind and
  with kubectl against the local apiserver, not against a deployed Web App.

## [v0.0.0.0.0.3] — "Save As…" — 2026-11-08

The project moved out of a personal account into its own foundation, and the repo
became product-only. Same spreadsheet, new file name.

### Added
- **SheetHub** — a GitLab-style DevOps forge whose data plane is a spreadsheet, linked from
  the README ecosystem table and the roadmap. It lives in
  [`sncfoundation/sheethub`](https://github.com/sncfoundation/sheethub) and hosts the
  manifests Sheetlux CD deploys, so the stack self-hosts on spreadsheets (#35, #55).
- Project logo in the README header.
- Roadmap **Recently shipped** section, with statuses flipped for delivered items
  (SNCF org split, per-project repos, SheetHub, skctl-wasm, Sheetlium/Sheetlux
  extraction, language clients).
- Expanded roadmap: AI, WebAssembly, storage, OS, clients, components, and SheetHub.

### Changed
- The repository moved to the **Sheet-Native Computing Foundation** org: all URLs now
  point at `github.com/sncfoundation/sheeternetes` and `sncfoundation.github.io`.
- The repo is now **product-only** (`Code.gs`, `kubelet.sh`, `skctl`, the lab, GitOps).
  The website, the CSFE registry, and the certification workflow moved to
  [`sncfoundation.github.io`](https://github.com/sncfoundation/sncfoundation.github.io);
  `docs/` is a redirect stub to the foundation site.

### Fixed
- Broken social-card image in the README after the site move.
- Broken landscape link in the roadmap.

### Removed
- `docs/` site pages, `docs/registry/`, and the certification issue form and Action
  (now maintained in the foundation site repo).

## [v0.0.0.0.0.2] — "The Registry" — 2026-08-31

### Added
- Public, verifiable **CSFE credential registry** under `docs/registry/` — browsable
  on GitHub and served on Pages. Every credential gets a **sequential serial**
  (`SFE000001`, `SFE000002`, …) assigned by an automated workflow.
- **`verify.html`** — look up any holder by serial or GitHub username, render the
  certificate, and download it as SVG. For HR, hiring managers, and sceptics.
- **Issuance pipeline**: an Issue Form (`certify.yml`) plus a GitHub Action that
  assigns the serial, writes the registry (race-free via a concurrency group),
  comments the verification link, and closes the request. One credential per account.
- **Public roadmap** (`ROADMAP.md`): flagship is Sheeternetes as a Cozystack managed
  application, plus certification tiers, a verification badge, skctl/kubectl parity, and
  assorted spreadsheet-native runtime bits — each with a `good first issue` tracking issue.

### Changed
- Exam answers are now **shuffled** — the correct option is no longer always first.
- Certificates are issued to the **GitHub account that files the request**, replacing
  the free-text username field (no more certifying `@octocat`).

### Removed
- Client-only certificate generation and the placeholder `verify.sheeternetes.dev`
  link, both superseded by the real registry.

## [v0.0.0.0.0.1] — "Cell A1" — 2026-08-30

### Added
- Initial public release: spreadsheet-native container orchestrator, the lab, and the
  Certified Sheeternetes Fundamentals Engineer (CSFE) exam.
