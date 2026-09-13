# FrontierHarness local matched case

Reusable, Docker-free runner for the single pinned task `datacurve/anko-typed-variable-bindings`.
This is an unofficial local case study: `methodology_comparable:false`, non-leaderboard, no public
publishing. Docker and Runta are intentionally unused.

## Inputs

Copy `manifest.template.json` into `_testenv/`, fill every `REPLACE_...` value, and keep `runtime_root`
under this repository's `_testenv/`. `official_root` must be the task directory inside a Git checkout
whose `HEAD` is the pinned DeepSWE commit. The runner copies only these six files and verifies each byte hash:

- `instruction.md`
- `task.toml`
- `tests/test.patch`
- `tests/config.json`
- `tests/grader.py`
- `tests/test.sh`

No solution file is copied. The host OpenCode auth file is checked with `test -f`; it is never opened,
copied, moved, printed, or placed under an isolated config root. `XDG_DATA_HOME` is never set. Every
process uses an executable plus argument array; manifest values are never interpolated into shell text.

Each tool declares `environment`, exact `executable`, invariant `args`, one-shot `probe_args`, and the
probe's expected exit. `host` is reserved for Git workspace operations; WSL package/verifier tools use
`wsl`. Set exact Linux executable paths and do not use aliases.

## Exact phase sequence

Future completion semantics are specified in
[Coding benchmark completion and correctness](../../../docs/benchmark-completion-contract.md).
The measured commands below still use the original fail-fast protocol.

For explicitly approved retrospective correctness checks, use `verify-snapshot --arm bare|sortie
--confirm --manifest <manifest>`. It requires a stopped, exit-zero agent, no untracked source, and an
exact match between the retained patch hash and current workspace diff. It grades a separate copy
with the same verifier and shares the one-shot attempt guard with `verify-arm`. It does not restart
an agent, repair source, clear the historical stopped state, or enable speed/cost ratios. `summarize`
includes diagnostic correctness and verifier evidence alongside the original terminal outcome.

From repository root, with a completed manifest at `_testenv/frontierharness-manifest.json`:

```powershell
$runner = 'test/fixtures/frontierharness-local/run-local-case-study.mjs'
$manifest = '_testenv/frontierharness-manifest.json'
node $runner preflight --manifest $manifest
node $runner prepare --manifest $manifest
node $runner run-arm --arm bare --manifest $manifest
node $runner run-arm --arm sortie --manifest $manifest
node $runner verify-arm --arm bare --manifest $manifest
node $runner verify-arm --arm sortie --manifest $manifest
node $runner summarize --manifest $manifest
node $runner cleanup --confirm --manifest $manifest
```

For a long arm that must survive an OpenCode/Desktop restart, launch the same one-shot `run-arm` through
the detached controller and then exit the initiating chat:

```powershell
node test/fixtures/frontierharness-local/launch-detached-arm.mjs --arm bare --manifest $manifest
```

The detached controller owns the OpenCode stdout pipe and watchdog independently of the initiating
OpenCode process. It writes only the runner's sanitized final JSON and heartbeat/error text beside the
durable state; raw agent output remains in memory and is never redirected. The per-arm launch marker is
created with exclusive-create semantics before spawning, so another chat cannot launch the arm again.
After restart, inspect `frontierharness-state.json` and the recorded controller PID. Continue with the
normal verifier or next arm only after `arms.<arm>.run.status` is `complete` and `active_pid` is null.
An OS reboot is not recoverable: stop the recorded WSL process group, preserve the candidate, and mark
the run infrastructure-invalid rather than relaunching the consumed arm.

### Scheduled Sortie qualification with visible feedback

For a `qualification_only:true` manifest whose `preflight` and `prepare` phases passed, use the reusable
Task Scheduler launcher. The hidden scheduled controller remains independent of OpenCode and the visible
monitor. The default launch opens a separate PowerShell monitor window:

```powershell
$manifest = '_testenv/frontierharness-qualification.json'
pwsh -NoProfile -File test/fixtures/frontierharness-local/launch-scheduled-arm.ps1 -Manifest $manifest
```

Use `-NoMonitor` when launching noninteractively. Open or reopen an observer at any time from the manifest's
`runtime_root`; a one-shot check also works without a window:

```powershell
pwsh -NoProfile -File test/fixtures/frontierharness-local/monitor-scheduled-arm.ps1 `
  -RuntimeRoot _testenv/frontierharness-qualification -Arm sortie
pwsh -NoProfile -NonInteractive -File test/fixtures/frontierharness-local/monitor-scheduled-arm.ps1 `
  -RuntimeRoot _testenv/frontierharness-qualification -Arm sortie -Once
```

The launcher exclusively creates `sortie-controller-launch.json` before registration and rejects an
existing marker, scheduled task, attempted arm, or non-qualification manifest. Task Scheduler uses
`MultipleInstances=IgnoreNew`; the runner's durable attempt guard remains authoritative. Closing the
monitor or restarting OpenCode cannot stop, signal, restart, or duplicate the scheduled controller or its
owned WSL process group. Reopening the monitor reads current durable state.

The monitor emits only allowlisted fields from `frontierharness-state.json`, parsed
`[frontierharness]` heartbeat JSON, and the controller's bounded completion record. It never prints the
controller streams, raw agent events, prompts, auth data, credential paths, or arbitrary error lines.
After recording the terminal result, remove the completed task explicitly with
`Unregister-ScheduledTask -TaskName SortieDogs-Frontier-Sortie -Confirm:$false`; do not remove the launch
marker or reuse that runtime root.

Do not skip or repeat phases. Durable state consumes each arm attempt before OpenCode starts and each
verifier attempt before the grader starts. Bare must complete before Sortie. Both use the same WSL
OpenCode executable and official instruction bytes. Legacy manifests use Sol/high for both arms. Product
comparison manifests pin Bare to `openai/gpt-5.6-sol`/`high` and the Sortie coordinator to
`openai/gpt-5.6-terra`/`high`; Sortie's installed default routing selects its child models. A
120-second startup watchdog and 5400-second activity/workspace-progress watchdogs stop stalled process
trees at the official agent timeout. The hard safety wall is also 5400 seconds. Retry count is zero.

Inspect each `run-arm` result before continuing. When the benchmark objective assumes normal delivery,
stop immediately if a required-source-change task produces `patch_bytes: 0`, Sortie dispatches no
implementation child, a successful terminal claim has incomplete delivery, or required parent/child session
identity is absent. Do not start the next arm or either verifier and do not calculate a performance comparison.
Preserve sanitized state for diagnosis and terminate any recorded process tree. After fixing the product, use a
new runtime root and rerun the complete matched pair only after a focused reproduction passes.

The runner stops the process tree on the first CLI error or failed tool event, returns nonzero, and saves
a partial `sanitized-summary.json`. Post-run delivery checks likewise stop the pair before any next phase.
Exploratory exceptions are `read` errors beginning with `File not found: ` or reporting an offset
outside the file's line count; neither stops
the run nor increments `event_errors`. Permission failures and other tool errors still stop the run.
WSL runs use an owned Linux process group; stopping Windows `wsl.exe` alone is not accepted as cleanup proof.
`summarize` and `cleanup --confirm` accept this stopped state without running missing arms or verifiers.
Keep the workspace until diagnosis evidence is collected, then run cleanup. The shell sequence above is
conditional: never paste it as an unconditional batch.

Optional manifest `expected_operation` freezes thresholds before execution:
```json
{
  "bare": { "min_patch_bytes": 1, "min_implementation_children": 0, "terminal_outcome": null },
  "sortie": { "min_patch_bytes": 1, "min_implementation_children": 1, "terminal_outcome": "DONE" }
}
```
These are also the defaults for existing manifests. Root session identity is always required. Child
identity comes from completed implementation Task results; an attempted or rejected dispatch is not a child.

Before release, a treatment qualification may set `qualification_only: true`. Its only legal measured
sequence is `preflight`, `prepare`, `run-arm --arm sortie`, `verify-arm --arm sortie`, `summarize`, and
`cleanup --confirm`. The report always refuses comparison as `qualification-only`; it cannot be reused as
one side of a later matched pair. A release benchmark requires a fresh runtime root and normal Bare-first order.

Model-free WSL stop check: `node test/fixtures/frontierharness-local/run-stop-rpt.mjs` inside a WSL login shell.

## What phases do

- `preflight`: fail-closed pin/hash/schema checks; Git, Node, Go, goyacc, go-ctrf-json-reporter,
  Python, npm, `/usr/bin/bash`, `/usr/bin/script`, WSL login-shell OpenCode path/version, auth-file
  presence, package hash. Controlled `PATH` identity checks prove the official script resolves the
  pinned Go tools rather than ambient alternatives. It records that Docker and Runta are intentionally unused.
- `prepare`: copies only official inputs byte-identically; creates independent detached base clones;
  removes upstream remote, refs, and reflogs; redirects hooks to an empty directory; creates per-arm
  `OPENCODE_CONFIG_DIR` and `XDG_CONFIG_HOME`. Creates the pinned `$GOPATH/bin` directory before
  execution because the upstream interactive tests write their log there.
- `run-arm`: resolves OpenCode config before launch. Bare rejects any Sortie package/plugin/agent/prompt/
  config evidence. Sortie installs the exact tgz with WSL npm, initializes project-local canonical
  assets, checks package version/hash/runtime marker/assets, and selects `dog-coordinator` explicitly.
  Resolved config capture uses pinned `script -q -e -c` with a fixed command and executable supplied
  through a quoted environment variable, preventing pipe truncation and shell interpolation. The
  config body is parsed in memory and never retained. The official instruction is one final argv item.
  No prompt or raw agent output is persisted.
  While an arm is running, the harness writes a sanitized heartbeat to stderr every 120 seconds with
  elapsed time, PID, activity/progress ages, workspace-change count, and captured byte counts.
- `verify-arm`: makes a separate fresh base clone without applying either patch in the Node runner,
  copies private `model.patch` into local artifacts, and invokes one wrapper copy of official
  `tests/test.sh` once with pinned `/usr/bin/bash`. The wrapper changes only literal absolute `/app`,
  `/tests`, and `/logs` prefixes; a local `config.json` copy changes only matching `/logs` report paths.
  It preserves command options/order and invokes the original
  byte-identical `grader.py` `prepare` and `grade` phases plus official `test.patch`. `TESTS_DIR`,
  `VERIFIER_DIR`, `APP_DIR`, `ARTIFACTS_DIR`, and `GOCACHE` point only to local runtime paths.
  `PATH` and `GOPATH` derive from pinned Go/goyacc/go-ctrf executables plus `/usr/bin:/bin`; ambient
  alternatives are excluded. Official reward calculation remains authoritative.
  Verifier runs emit the same 120-second heartbeat without exposing verifier output.
- `summarize`: writes `_testenv/.../sanitized-summary.json`. Speed/cost ratios are refused unless both
  deliveries succeeded and rewards equal `1`. Duration and cost availability are evaluated separately:
  unavailable cost does not suppress a valid speed ratio. A zero cost denominator has no cost ratio.
  Each arm has an explicit outcome/reason; exit zero alone cannot turn an empty patch or a CLI error
  event into success. Usage aggregates identified `step-finish` events once, with `cli-stream-only`
  coverage. Host-reported zero cost is preserved, not treated as proof of free service or invoice cost.
- `cleanup --confirm`: after complete or stopped partial summary, kills recorded process trees, confirms no remaining agent
  process, and removes temporary OpenCode configs/workspaces/wrapper copies, verifier artifact copies,
  and Go caches. It leaves private canonical patch
  evidence, durable state, and sanitized summary under `_testenv`; raw verifier logs are deleted as soon
  as reward/count evidence is extracted, and host auth remains untouched.

`model.patch` is collected by `git diff --binary <ANKO_BASE>` without staging or changing the candidate.
Tracked committed, staged, and unstaged work is retained; untracked work is reported but excluded. Reports contain only timings, exits/status, root session id,
hashes, package/version/marker/model, reward counts, changed paths, and token metric field references.
They exclude prompts, raw logs, provider URLs, credentials/auth JSON, source, and patch bodies.
