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

The template is the standalone v0.10 qualification profile: `profile:"v010"` and
`qualification_only:true`. Existing manifests with no `profile` remain the stable v1 profile and retain
the paired Bare-then-Sortie behavior. Profiles are closed to `stable|v010|v0127`; v0.10 without
`qualification_only:true` is rejected before preflight so it cannot launch Bare.
Its `opencode.host_database` pins the known WSL host metadata database. The runner opens it through
the pinned Python `sqlite3` client with SQLite `mode=ro`; authentication files remain unopened.

The `v0127` profile pins the published v0.12.7 tarball and its SHA-256, runtime marker, GPT-6 Sol
operator route, and the same official task bytes. It accepts a Bare-then-Sortie pair or an explicit
`qualification_only:true` Sortie diagnostic. Set `protocol.total_wall_seconds` to shorten the shared
deadline (for example, `3600` for a 60-minute diagnostic); omitted means 5400 seconds. A diagnostic
uses `run-arm --arm sortie --debug`, not the v0.10 qualification wrapper. It is not a release gate.
The published package remains unchanged. The `v0127` profile requires OpenCode V2 `2.0.16` from an
isolated WSL install of `@opencode/cli`; set `opencode.executable` to its exact binary and
`opencode.version` to `2.0.16`. The manifest's `opencode.host_database` must equal the **new**
`runtime_root` WSL path plus `/opencode.db` (not the user's V1 or V2 database). The CLI binary's
SHA-256 is pinned to `0910f9e7c5b50eb460c9ae53b4348b781cb44220a18ff2bcce514c2427582848`.
Keep the previous 1.18.29 manifest and run evidence intact; use a fresh manifest and run root for V2.
The fixture installs `@opencode/plugin@2.0.16` under isolated `XDG_CONFIG_HOME`, adds only a project-local
V2 wrapper calling `createSortieDogsV2Plugin(SortieDogsPlugin)`, and loads the published agent
assets byte-for-byte, including `model#variant`. Its private server probe performs **no model call**:
it requires the plugin's `active` server registration and the six published child routes. V2 does
not expose the per-agent tool snapshot used by V1 `debug agent`; plugin registration is not proof
of a completed Worker or successful mission. Inference uses `run --standalone` and the pinned
`openai/gpt-6-sol#variant` CLI syntax, with the run-local database.

Each tool declares `environment`, exact `executable`, invariant `args`, one-shot `probe_args`, and the
probe's expected exit. `host` is reserved for Git workspace operations; WSL package/verifier tools use
`wsl`. Set exact Linux executable paths and do not use aliases.

## Exact phase sequence

For the v0.10 one-shot qualification, use the reliability wrapper. The base manifest remains the
explicit authority for official inputs, pins, tools, model, and protocol. The wrapper creates a new
non-overwriting `_testenv/` run, builds and directly packs current source, verifies critical packed
modules against current `dist`, then conditionally drives the existing phases and confirmed cleanup:

```powershell
node scripts/run-v010-qualification.mjs --base-manifest _testenv/frontierharness-manifest.json
```

For a state-preserving diagnostic pass, opt in explicitly:

```powershell
node scripts/run-v010-qualification.mjs --debug --base-manifest _testenv/frontierharness-manifest.json
```

Debug keeps the same prepared workspace, isolated config dependency, and root OpenCode session across
bounded continuations after a recoverable `agent-event-error`. Each continuation first requires the root
to expose `sortie_v010_operator_status`; only a public contract-repair packet or supported process-defect
resume packet permits automated continuation. The root—not the wrapper—chooses and invokes the root-only
repair/resume tool. Unknown tool errors, six total model cycles, or the original 5400-second wall pause the
run without cleanup. Resume one preserved run without rebuilding, repacking, or preparing again:

```powershell
node scripts/run-v010-qualification.mjs --resume-debug _testenv/<debug-run-id>
```

After a local source repair, explicitly refresh the candidate package before resuming the same run:

```powershell
node scripts/run-v010-qualification.mjs --resume-debug _testenv/<debug-run-id> --refresh-candidate
```

`--refresh-candidate` is valid only with `--resume-debug`. It builds and packs into a unique refresh
subdirectory, verifies the packed marker and critical `dist` hashes against that build, then asks the
runner to reinstall and initialize the package in the existing Sortie workspace. The official manifest,
workspace source and refs, isolated config, root session, attempt count, debug cycle count, and original
wall deadline remain unchanged. The debug receipt records the refreshed package and module hashes;
`quality_gate` remains false. Refresh refuses an active arm or verifier process and never runs preflight or
prepare.

Debug receipts and summaries set `debug_mode:true`, `quality_gate:false`, and
`methodology_comparable:false`; verifier reward is diagnostic only. A debug result is never a release
qualification, leaderboard result, or methodology-comparable result. After debug completion, start a
fresh clean qualification from the reviewed base manifest. Clean mode refuses a generated debug run
manifest/root.

It never starts Bare, retries, or reuses an existing package/run root. Do not use it for a paid run
until the explicit base manifest has been reviewed.
On `Ctrl+C` or `SIGTERM` during an active run/verifier, it asks the runner's confirmed `cancel` phase
to stop the recorded owned WSL process group, then summarizes and cleans. A bounded fallback stops only
the wrapper-owned host runner tree; a second signal never broadens the process scope.

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

Do not skip or repeat phases. Durable state consumes each arm attempt before OpenCode starts and each
verifier attempt before the grader starts. Bare must complete before Sortie. Both use the same WSL
OpenCode executable, one approved profile operator route, and official instruction bytes. The stable
profile pins `openai/gpt-5.6-sol` with variant `high`; the `v010` profile also accepts
`openai/gpt-5.6-terra` with variant `xhigh`. A
5400-second startup watchdog and 5400-second activity/workspace-progress watchdogs stop stalled process
trees at the official agent timeout. The hard safety wall is also 5400 seconds. Retry count is zero.

Inspect each `run-arm` result before continuing. When the benchmark objective assumes normal delivery,
stop immediately if a required-source-change task produces `patch_bytes: 0`, Sortie dispatches no
implementation child, a successful terminal claim has incomplete delivery, or required parent/child session
identity is absent. Do not start the next arm or either verifier and do not calculate a performance comparison.
The `v0127` diagnostic/matched profile may retain and independently grade a failed one-shot candidate;
its summary includes `expected_operation` and refuses comparison ratios if normal operation is unproven.
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

For v0.10 use the template's profile-required assets and run only:

```powershell
node $runner preflight --manifest $manifest
node $runner prepare --manifest $manifest
node $runner run-arm --arm sortie --manifest $manifest
node $runner verify-arm --arm sortie --manifest $manifest
node $runner summarize --manifest $manifest
node $runner cleanup --confirm --manifest $manifest
```

Do not run Bare in this sequence. The runner resolves v0.10 to `init <workspace> --profile v010`,
`dist/runtime-assets-v010.js`, `V010_RUNTIME_ASSET_VERSION`, `dog-operator`, and required
`dog-operator`/`dogs-coordinator`/`dog-worker-v010`/`sortie-v010` assets before execution. The pinned
model remains one of the approved v0.10 operator routes: `openai/gpt-5.6-sol` / `high`,
`openai/gpt-5.6-terra` / `xhigh`, or `openai/gpt-5.6-luna-fast` / `max`. An Astra configuration is a separate
manifest experiment, not this qualification.

Model-free WSL stop check: `node test/fixtures/frontierharness-local/run-stop-rpt.mjs` inside a WSL login shell.

## What phases do

- `preflight`: fail-closed pin/hash/schema checks; Git, Node, Go, goyacc, go-ctrf-json-reporter,
  Python, npm, `/usr/bin/bash`, `/usr/bin/script`, WSL login-shell OpenCode path/version, auth-file
  presence, package hash. Controlled `PATH` identity checks prove the official script resolves the
  pinned Go tools rather than ambient alternatives. It records that Docker and Runta are intentionally unused.
- `prepare`: copies only official inputs byte-identically; creates independent detached base clones and
  materializes `refs/heads/main` at the exact pinned Anko base in each arm (no `master` fallback);
  removes upstream remote, refs, and reflogs; redirects hooks to an empty directory; creates per-arm
  `OPENCODE_CONFIG_DIR` and `XDG_CONFIG_HOME`. In each isolated `XDG_CONFIG_HOME/opencode`, it writes
  `package.json`, installs `@opencode-ai/plugin` (V1) or `@opencode/plugin` (v0.12.7/V2) at the
  exact `opencode.version` manifest pin with the
  pinned WSL npm executable, and rejects a version mismatch or linked install using both package-lock
  and installed-package evidence. Install and timeout cleanup use an owned Linux process group.
  Creates the pinned `$GOPATH/bin` directory before execution because the upstream interactive tests
  write their log there.
- `run-arm`: resolves OpenCode config before launch. Bare rejects any Sortie package/plugin/agent/prompt/
  config evidence. Sortie installs the exact tgz with WSL npm, initializes project-local canonical
  assets, checks package version/hash/runtime marker/assets, and selects the profile coordinator explicitly
  (`dog-coordinator` for stable, `dog-operator` for v0.10).
  V1 resolved config capture runs `opencode debug config` through anonymous memory-backed capture;
  V2 instead queries only agent and plugin registration from a private, authenticated API server
  and stops it before inference. The config body is parsed in memory and never retained. The
  official instruction is one final argv item.
  No prompt or raw agent output is persisted. For v0.10, only completed `dog-worker-v010` Tasks with a
  native child session identity and bounded ancestry (maximum eight parents) to the root count as implementation children;
  `dog-operator`, proposal/execution `dogs-coordinator` delegates, failed Tasks, and IDs written in text do not.
  Identity evidence is limited to the exact fixture directory and bounded session/task rows; raw messages and
  database contents are neither emitted nor saved. CLI-stream token coverage remains separate from host identity coverage.
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
