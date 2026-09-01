# Sheeternetes Roadmap

> Sheeternetes is an enterprise-grade joke that reconciles. The roadmap is also a
> joke, but — like the control plane — it is a joke you can actually run. Items ship
> when they ship. Time has no meaning in the spreadsheet.

Every item below has a **tracking issue**. Most are tagged
[`good first issue`](https://github.com/sncfoundation/sheeternetes/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).
Pick one, open a PR, and earn a place in the [SNCF Landscape](https://sncfoundation.github.io/sheeternetes/landscape.html).
Contributions reconcile.

Status legend: 🟢 shipped · 🟡 in progress · ⚪ planned · 💭 idea

## Flagship

### ⚪ Cozystack managed application · [#7](https://github.com/sncfoundation/sheeternetes/issues/7)
Package Sheeternetes as a Helm/FluxCD `HelmRelease` installable from the Cozystack
marketplace into any tenant. A spreadsheet-native control plane, deployed like Postgres.

## Certification

### ⚪ CSFE Professional / Expert tiers · [#8](https://github.com/sncfoundation/sheeternetes/issues/8)
Harder exams, re-certification, a version-gated syllabus. Same registry, richer serials.

### ⚪ Verification badge · [#9](https://github.com/sncfoundation/sheeternetes/issues/9)
A shields.io-style SVG badge (`CSFE · SFE000001`) for READMEs and LinkedIn.

## Runtime

### ⚪ skctl ↔ kubectl parity · [#10](https://github.com/sncfoundation/sheeternetes/issues/10)
Grow `skctl` toward `get` / `describe` / `logs` / `apply -f` / `-o yaml`.

### 💭 Sheetmesh · [#6](https://github.com/sncfoundation/sheeternetes/issues/6)
Federate several spreadsheets into one mesh — services discoverable across workbooks.

### 💭 HPA = conditional formatting · [#11](https://github.com/sncfoundation/sheeternetes/issues/11)
Autoscaling driven by a cell formula; conditional formatting for over-quota.

### 💭 DR from Sheets revision history · [#12](https://github.com/sncfoundation/sheeternetes/issues/12)
Restore a "cluster" from Google Sheets' version history. RPO measured in Ctrl+Z.

## Storage

### 💭 Sheetstor — distributed block storage (LINSTOR analog) · [#30](https://github.com/sncfoundation/sheeternetes/issues/30)
Replicated PersistentVolumes tracked in a `Volumes` tab; a CSI-ish kubelet shim provisions
host paths and the loop keeps replicas satisfied (DRBD/LINSTOR-style resync). Closes the
biggest gap in the stack — storage.

## AI

### 💭 Sheetelligence — prompt-native orchestration · [#22](https://github.com/sncfoundation/sheeternetes/issues/22)
Describe a workload in plain English in a cell; an LLM fills in the manifest rows.

### 💭 SheetAIOps — anomaly detection · [#23](https://github.com/sncfoundation/sheeternetes/issues/23)
Watch the Events tab; predict failures with total confidence and no accountability.

## WebAssembly

### 💭 SheetAssembly — schedule WASI/WASM workloads · [#24](https://github.com/sncfoundation/sheeternetes/issues/24)
A "pod" can be a WASM module; kubelet runs it via wasmtime instead of `docker run`.

### 💭 skctl-wasm — the CLI in the browser · [#25](https://github.com/sncfoundation/sheeternetes/issues/25)
Compile skctl to WebAssembly and run it client-side against the apiserver.

## Operating system

### 💭 SheetOS — Talos for spreadsheets · [#26](https://github.com/sncfoundation/sheeternetes/issues/26)
A minimal, API-only, declarative node OS whose single job is to bootstrap and run
Sheeternetes. Distributable across many sheets that self-assemble into a cluster.

## Developer platform

### 🟢 SheetHub — a GitLab-style forge on a spreadsheet · [#35](https://github.com/sncfoundation/sheeternetes/issues/35)
An all-in-one DevOps forge whose data plane is a Sheet: repos, issues, merge requests,
releases, and CI in one workbook. The forge maps cleanly to tabs; real git transport is a
read-only stretch goal. Implemented in [`sncfoundation/sheethub`](https://github.com/sncfoundation/sheethub). Meta-win: SheetHub hosts the manifests Sheeternetes deploys via
Sheetlux CD — the whole stack self-hosts on spreadsheets.

## Clients &amp; language bindings (community)

### ⚪ PowerShell IaC · [#27](https://github.com/sncfoundation/sheeternetes/issues/27)
Declarative cmdlets / DSC for the cluster. _Proposed by the community._

### ⚪ Lisp client · [#29](https://github.com/sncfoundation/sheeternetes/issues/29)
Homoiconic orchestration from the REPL. _Proposed by the community._

### ⚪ Brainfuck client · [#28](https://github.com/sncfoundation/sheeternetes/issues/28)
If it reconciles from here, it reconciles anywhere. _Proposed by the community._

## Cloud connectors

### ⚪ Cloud connectors · [#15](https://github.com/sncfoundation/sheeternetes/issues/15)
Run containers on managed backends, not only local Docker. The Sheet stays the source of
truth ("Sheet-Ops" across clouds).

- 🟢 easy MVPs: [DigitalOcean](https://github.com/sncfoundation/sheeternetes/issues/16) ·
  [GCP Cloud Run](https://github.com/sncfoundation/sheeternetes/issues/17) ·
  [Yandex Serverless Containers](https://github.com/sncfoundation/sheeternetes/issues/18)
- 🟡 medium: [Azure Container Instances](https://github.com/sncfoundation/sheeternetes/issues/19)
- 🔴 hard (SigV4): [AWS ECS/Fargate](https://github.com/sncfoundation/sheeternetes/issues/20)

## Foundation &amp; structure

### ⚪ Establish the SNCF org &amp; split into components · [#33](https://github.com/sncfoundation/sheeternetes/issues/33)
Stand up the Sheet-Native Computing Foundation as a GitHub org and break the monorepo into
per-project repos (with redirects from the old locations).

### ⚪ Extract Sheetlium (Cilium analog) · [#31](https://github.com/sncfoundation/sheeternetes/issues/31)
Networking as its own component.

### ⚪ Extract Sheetlux CD (Argo CD analog) · [#32](https://github.com/sncfoundation/sheeternetes/issues/32)
GitOps delivery as its own component.

## How to influence the roadmap
Browse the [open proposals](https://github.com/sncfoundation/sheeternetes/issues) and open a PR
against one, or open a new issue tagged [`sncf`](https://github.com/sncfoundation/sheeternetes/issues?q=is%3Aissue+label%3Asncf).
Everything starts as an Unsaved Draft. It reconciles from there.
