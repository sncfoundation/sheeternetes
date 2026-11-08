# Script pods and Sheetstor on cells

Sheeternetes has always needed somebody else's computer: a Docker host running
`kubelet.sh`. Script pods remove that last piece of infrastructure. A Deployment
with `runtime: script` is a JavaScript module stored in the spreadsheet and executed
by the cluster's own Apps Script project. The control plane is a Sheet, the storage
is a Sheet, and now the compute is the Sheet's script. Serverless, in the most
literal sense available.

## How it fits the model

Nothing in the control loop knows that script pods exist. `setup()` registers the
Apps Script project as an ordinary node:

| Node field | Value |
| --- | --- |
| `name` | `apps-script` |
| `labels` | `runtime=script` |
| `taints` | `runtime=script:NoSchedule` |
| `last_heartbeat` | a lease, stamped five minutes ahead and renewed every few minutes |

`skctl apply` gives every `runtime: script` Deployment the node selector and the
toleration `runtime=script`, so the formula scheduler places its pod on
`apps-script` and never places a Docker pod there. Replicas, rolling updates,
Events and `scale` work as for any Deployment.

`Runtime.gs` is the kubelet of that node. One time trigger, `runtimeTick`, replaces
the plain reconcile timer and runs about once a minute:

1. renews the node lease;
2. runs `reconcile()` when something is not converged (a pod that is Pending or
   Scheduled, a replica count that differs, a stale node, a non-empty Autoscale tab)
   and in any case every five minutes;
3. moves pods on `apps-script` from Scheduled to Running and from Terminating to
   Deleted;
4. fires the schedule slots that are due, unless the pod asked to sleep.

A consumer Google account gets 90 minutes of trigger time a day, about 3.7 seconds
per minute. An idle tick reads Nodes, Deployments and Pods once and Script
Properties once, and touches no volume. Every tick adds its duration to a per-day
counter, and the `Runtime` tab shows ticks, trigger milliseconds, the slowest tick
and the share of the budget used (Apps Script also counts each execution's
start-up, which a script cannot measure, so keep a margin). `skctl get budget` prints it.

A script Deployment runs **one** pod: if `replicas` is above 1, only the oldest
Running pod receives events. `replicas: 0` pauses it, `replicas: 1` resumes it.

## Deployment columns

| Column | Example | Meaning |
| --- | --- | --- |
| `runtime` | `script` | marks a script pod |
| `image` | `sheetstor://code/bot.js` | the module's source: a file on a Sheetstor volume |
| `schedule` | `*/5 * * * *` or `{"ticket": "CRON_TZ=Europe/Moscow 20 19 * * *", "review": "0 13 * * *"}` | one cron expression, or named ones as JSON |
| `env` | `{"MODE": "test", "LIST": "a,b,c"}` | plain configuration as a JSON object (values may contain commas) |
| `secrets` | `tg,smtp` | Secrets whose keys are merged into `env.secrets` |
| `volumes` | `media:ro,data` | volumes mounted as `env.volumes.<name>`; `:ro` mounts read-only |

Cron expressions have five fields (`minute hour day-of-month month day-of-week`)
with `*`, lists, ranges and steps, `@hourly`, `@daily` and `@weekly`, and an
optional `CRON_TZ=<zone>` prefix; without it the script's time zone
(`appsscript.json`, `Etc/UTC`) applies.

## The module

```js
exports.handle = function (event, env) {
  const s = env.state.get();
  if (event.type === 'webhook') {
    env.once('update:' + event.json.update_id, () => { s.votes = (s.votes || 0) + 1; });
  }
  return { votes: s.votes };
};

exports.announce = function (event, env) { /* skctl run bot -- announce now */ };
```

The source is evaluated with `new Function('exports', 'module', 'console', source)`.
It sees the Apps Script services (`UrlFetchApp`, `Utilities`, …) as globals.
Handlers must be **synchronous**: Apps Script refuses to construct async functions
from a string, and a handler that returns a promise is reported as a crash.

### Events

| `event.type` | Fields | Source |
| --- | --- | --- |
| `schedule` | `schedule` (its name, `default` for a single expression), `slot` (ISO minute) | `runtimeTick` |
| `webhook` | `body` (raw), `json` (parsed or `null`), `parameter` (query without `pod`/`key`) | `POST <exec URL>?pod=<deployment>&key=<key>` |
| `run` | `fn`, `args` | `skctl run <deployment> -- <fn> <args…>`; calls `exports[fn]` if it exists, else `handle` |

### `env`

| Field | |
| --- | --- |
| `env.vars` | the `env` column |
| `env.secrets` | read-only merge of the Secrets in the `secrets` column |
| `env.volumes.<name>` | `read(path)` → Blob (sha256-verified), `readText`, `readJSON`, `list()`, `exists`, `write(path, string \| Blob \| bytes)`, `writeJSON`, `remove` |
| `env.state` | `get()`, `set(value)`, `update(fn)`, `save()` |
| `env.once(key, fn)` | runs `fn` only if `key` was never seen (the last 1,000 keys are kept) |
| `env.log(...)` / `console.log(...)` | goes to the Logs tab, masked |
| `env.table(name, columns)` | an append-only log in the hidden tab `table-<deployment>-<name>`: `append(object)` is a single `appendRow`, `rows()` reads it back; strings are stored JSON-quoted, so `=1+1` stays text |
| `env.event(message)` | an Event for the pod |
| `env.sleepUntil(ms)` | no schedule slot fires before this time; webhooks and runs still do. Not part of the transaction |

`env.state` is a whole document rewritten on every commit; use it for data that
changes a few times a day. Data that arrives in bursts — votes, messages, clicks —
belongs in `env.table`: one row per event, no rewrite, and a handler that holds the
lock for a single append. Derive the current picture from the rows (for example,
the newest row per key wins and a redelivered event is the same row twice).

A pod that knows when it next has work calls `env.sleepUntil` at the end of each
scheduled run; with a `* * * * *` schedule it then wakes within a minute of the due
time and costs nothing in between.

## Exactly once

Every invocation — a slot, a webhook, a run — holds the script lock, so at most one
runs at a time in the whole project.

An invocation is a **transaction** on the pod's state document (`state.json` on the
volume `<deployment>-state`, created on first use): changes commit when the handler
returns and are discarded when it throws. `env.state.save()` commits early; use it
right after an external side effect (a sent message) so a later crash cannot make
you repeat it.

Schedule slots are recorded in the same commit as the state. A tick looks for the
newest matching minute within the last 15 minutes that has not fired yet, so a
jittery trigger, two overlapping triggers, or a trigger that came late all end in
one invocation per slot. Older missed slots are skipped, not replayed. The
`env.once` keys live in the same document, which is why a redelivered webhook is a
no-op even if the first delivery crashed after its side effects were committed.

External effects (an HTTP call) are at-least-once when the execution dies between
the call and the commit; save state right after them.

## Webhooks

`skctl webhook <deployment>` prints the address: the web app URL with
`?pod=<deployment>&key=<key>`. The key is random, stored in Script Properties and
rotated with `--rotate`. The address belongs to the Deployment, so it survives pod
restarts and rolling updates.

The answer matters to senders that retry. Apps Script's `ContentService` answers
with an HTTP 302, which Telegram, for instance, counts as a failure and redelivers;
`HtmlService` answers 200. The runtime uses both on purpose:

| Situation | Answer | Sender |
| --- | --- | --- |
| handled | `HtmlService` 200 `ok` | done |
| the handler threw (1st and 2nd time for the same body) | `ContentService` 302 | redelivers |
| the same body failed 3 times | 200 `dropped` after the body is stored in `table-<deployment>-deadletter`, plus an Event | gives up |
| paused (`replicas: 0`) or the lock is busy | 302 | redelivers later |
| wrong key | 200 `forbidden` | gives up |

Before taking the lock a webhook reads the Deployment and the pod's code (the
source is cached per volume generation in the script cache); the lock covers the
handler only. Set a sender's concurrency low — for Telegram, `max_connections` of
a few — to stay well under Apps Script's 30 simultaneous executions.

## One-off runs

`skctl run <deployment> -- <fn> <args…>` invokes `exports[fn]` under the same lock,
marks the Deployment's schedule as paused for the duration (a trigger that gets the
lock in the meantime skips it), and prints the result and the run's log lines.

## Failures

A crash (exception, compile error, missing secret, bad cron expression) increments
the restart count, records the masked error, writes an Event, moves the log to
`previous`, and sets the pod's `message`. Schedule ticks back off exponentially —
1, 2, 4 … 60 minutes — and the pod shows `CrashLoopBackOff` until a run succeeds.
`skctl get scripts` shows restarts, the last run and the last error;
`skctl logs <pod|deployment> [--previous]` shows the logs.

## Secrets

Secrets live in Script Properties (`sk.secret.<name>`), never in a cell, so they are
not in the version history either. `skctl secret set <name> KEY=VALUE…` writes them
through the token-authenticated API; `KEY=-` reads the value from stdin so it does
not appear in the shell history or the process list. `skctl get secrets` lists key
names only. Everything the runtime writes — logs, Events, the pod's message, run
results and errors — has every secret value and webhook key replaced by `***`,
including their URL-encoded forms.

## Sheetstor on cells

The `Volumes` tab is the registry:

| `name` | `mode` | `generation` | `files` | `size` | `sha256` | `updated_at` |
| --- | --- | --- | --- | --- | --- | --- |

Each volume keeps its files in a hidden tab `sheetstor-<name>`, one row per chunk:

| `generation` | `path` | `chunk` | `chunks` | `size` | `sha256` | `data` |
| --- | --- | --- | --- | --- | --- | --- |

`data` is up to 49,000 base64 characters behind a `~` marker. A cell holds 50,000
characters, and the Sheets API returns longer strings as an error; the marker keeps
Sheets from turning a chunk into a number or a formula.

A write appends the whole file as a new generation, flushes, and only then moves the
registry's `generation` pointer, under the script lock. A reader takes, for each
path, the newest group at or below the pointer and checks its sha256. A crash before
the flip therefore leaves the previous version readable; the next write collects the
orphaned rows and every superseded group. A delete writes a tombstone group that is
collected once nothing older is left.

`ro` volumes can only be filled by `skctl volume put`; pods can read them. Use them
for media: a few files of 1–5 MB each, tens of MB in total, is comfortable. State
documents of a few MB work too; every commit rewrites the whole document.

Code lives on a volume as well (`image: sheetstor://code/bot.js`). Uploading new
code is an atomic generation flip, the next event runs it, an Event records the new
sha256, and the state volume is never touched.

## Setting up a cluster

1. Create a Google Sheet, open *Extensions → Apps Script*, and add `Code.gs`,
   `Sheetstor.gs`, `Runtime.gs` and `appsscript.json` (or `clasp push` them).
   Set `TOKEN` in `Code.gs`.
2. **Run `setup()` once from the editor and grant the permissions.** The project
   declares its OAuth scopes in `appsscript.json` (code inside a string declares
   none, so Apps Script cannot infer them): Sheets, Drive, external requests and
   triggers. Until the owner has granted them, the web app answers *Access Denied*.
   Adding a scope later revokes that consent, so they are all declared up front.
3. *Deploy → New deployment → Web app*, execute as *Me*, access *Anyone*. Google
   Workspace domains may forbid anonymous web apps; a personal Google account does
   not.

Then:

```bash
skctl volume create code
skctl volume put code hello.js lab/script-pods/hello.js
skctl volume create media --ro
skctl volume put media pixel.gif lab/script-pods/pixel.gif
skctl apply lab/script-pods/hello.json
skctl get scripts
skctl run hello -- pixel
curl -sL -X POST "$(skctl webhook hello)" -d '{"id": 1}'
skctl logs hello
```

## Limits worth knowing

- One invocation at a time per project; an Apps Script execution stops after six
  minutes.
- Triggers fire about once a minute with jitter, so schedules have minute
  resolution at best.
- Consumer accounts: 90 minutes of trigger runtime and 20,000 `UrlFetchApp` calls a
  day.
- A webhook caller waits for the handler; keep handlers short.
