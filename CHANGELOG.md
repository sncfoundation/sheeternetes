# Changelog

All notable changes to Sheeternetes are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning is based on
however many zeroes we feel like, because the spreadsheet is eternal.

## [Unreleased]

### Added
- **CI** (`.github/workflows/ci.yml`): runs every `hack/test*.js` control-plane test,
  `bash -n` and `shellcheck` on all shell scripts, and `jq empty` on the lab and GitOps
  manifests on every push and pull request.

### Fixed
- README certification and verification links now point at the foundation site
  (`certification.html`, `verify.html`) instead of the retired `/sheeternetes/` paths.
- `local-cluster.sh stop` no longer word-splits the container list (shellcheck SC2046).

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
