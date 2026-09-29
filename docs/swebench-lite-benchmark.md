# SWE-bench Lite benchmark runbook

This runbook is the Git-tracked handoff for running the Sortie-dogs SWE-bench Lite adapter from Ubuntu/WSL.
Keep credentials, raw logs, package archives, and benchmark outputs outside Git.

## Scope and safety

- Dataset: `princeton-nlp/SWE-bench_Lite` at revision `6ec7bb89b9342f664a54a6e0a6ea6501d3437cc2`.
- Host inference and official Docker scoring are separate phases.
- Use one immutable package archive and SHA-256 for the entire run.
- `--workers 4` enables four inference slots; the default remains one.
- Inference is pass@1: one attempt and no inference retry.
- Official scoring is intentionally sequential: `split=dev`, `max_workers=1`.
- Never commit `_testenv/`, `/tmp` run roots, credentials, raw logs, predictions, or replay artifacts.
- Never start a second supervisor against the same run root.
- A per-case `--timeout-seconds` is the **hard maximum**, not a promise to run each case that long.
  The built-in progress checkpoint and early stop policy in §5 also apply.

### Next 300-case Lite test campaign

The [v0.12.24 test-300 report](benchmarks/swebench-lite-v01224-test300-2026-09-29.md)
records the capacity pause, pricing gap, one-to-two-heavy-image handoff and final
submission. Before starting or resuming a new 300-case campaign, run the **read-only**
`scripts/swebench-lite-campaign-check.mjs --manifest <frozen-manifest> --plan <frozen-plan> --campaign <campaign-dir>`.
It verifies the package and prior predictions, then separates `infer`, `score_only`,
`needs_attention` and already-scored IDs. Never re-infer `score_only` or
`needs_attention` IDs; finish scoring frozen predictions first. Import
`admission`/`nextAdmission` from that script in a new controller and recheck free
space at each serialized image pull. The 22/20-GiB heavy-image thresholds are
observations for the old host, **not** universal defaults for another machine.
At completion, preserve the single 300-case report and original trajectories;
use a separate current upstream submit CLI for packaging and verification, not
the evaluation environment's CLI 5.0.2. The historical audit script in
`scripts/swebench-lite-submission-audit.py` is pinned to v0.12.24; update its
candidate identity and evidence paths for a new run rather than treating its
old hardcoded hashes as new-run evidence.

## Prerequisites

- Node.js 22.6 or newer.
- Ubuntu/WSL OpenCode CLI available from a login shell.
- A Python environment containing `datasets` for manifest generation.
- The official SWE-bench harness and Docker only for the scoring phase.
- A clean, unused run root. Preflight and supervisor reject conflicting ownership.

Run OpenCode-related commands through a login shell:

```powershell
wsl.exe --cd /mnt/m/_work/_Sortie-dogs -e bash -ic '<command>'
```

## 1. Select the runner and candidate

Start each improvement cycle from current `main`. Preserve an active branch's edits and run evidence;
use a separate worktree when it is busy. A new runner does not require rebuilding a published package.

```bash
git fetch origin
git worktree add --detach /tmp/opencode/swebench-current-main origin/main
```

Run the following scripts from that worktree. Before repairing an infrastructure failure, compare its
runner with current main; reuse an integrated fix instead of reimplementing it on an old bench branch.

### Published release

Use the archive next to its release receipt. Do not search by `sortie-dogs-<version>.tgz`: development
candidates can have the same name/version and different bytes. Reuse the public dataset rows from a
fixed manifest and select the package directly from the receipt:

```bash
node scripts/swebench-release-manifest.mjs \
  /path/to/manifest-dev-23.json \
  /path/to/releases/<version>/release-receipt.json \
  /path/to/new-campaign/manifest.json
```

This writes a new manifest and provenance sidecar with the receipt/package hashes, release commit,
runner checkout/commit and hashes of the actual runner scripts. Existing manifests are never overwritten.
The package's commit and runner's commit are separate identities. Keep both with the campaign evidence.
This already generates the manifest; continue at §3.

### Development candidate

From the repository root on Windows:

```powershell
npm test
npm run build
$version = (Get-Content -LiteralPath .\package.json -Raw | ConvertFrom-Json).version
$artifact = ".\_testenv\swebench-lite-dev23"
New-Item -ItemType Directory -Force -Path $artifact | Out-Null
npm pack --pack-destination $artifact
Get-FileHash -Algorithm SHA256 "$artifact\sortie-dogs-$version.tgz"
```

Record the version, runtime marker, and lowercase SHA-256 before generating the manifest.
Do not rebuild or replace the archive after the manifest is generated.

## 2. Generate a fixed manifest

Generate all 23 `dev` rows with the Python environment that provides `datasets`:

```bash
_testenv/swebench-venv/bin/python scripts/generate-swebench-lite-manifest.py \
  --split dev \
  --package-tgz sortie-dogs-<version>.tgz \
  --sha256 <lowercase-sha256> \
  --version <version> \
  --runtime-marker <runtime-marker> \
  --output _testenv/swebench-lite-dev23/manifest-dev-23.json
```

The archive must be in the same directory as the manifest because `package_tgz` is resolved relative to the manifest.
Use repeated `--instance-id <id>` options only for a declared subset or smoke run.

## 3. Run candidate preflight

Use a fresh temporary root:

```bash
node --experimental-strip-types scripts/swebench-candidate-preflight.mjs \
  /mnt/m/_work/_Sortie-dogs/_testenv/swebench-lite-dev23/manifest-dev-23.json \
  /tmp/sortie-dogs-swebench-dev23-preflight
```

Expected result includes `config_verified:true` and `provider_requests_started:false`.
Preflight removes only the fresh root it owns.

This checks setup only. Before a new multi-instance campaign, observe a real Worker session and its
actual model in the exact isolated benchmark environment (reuse an existing matching observation).
For zero-request model/credential failures, report infrastructure failure, not a benchmark score;
fix the route before launching more instances. Retain the failed run and its budget record.

Benchmark permissions allow URL strings in local test data and explicit registry URLs for
repository-declared dependencies. Web tools and the existing remote Git/download command rules
remain denied; the public-only prompt forbids solution retrieval. Shell string rules describe
these operation restrictions, not complete network isolation. Preflight verifies the operation
rules for each resolved agent rather than requiring a blanket URL-string denial.

## 4. Start four-slot inference

Choose an explicit global budget before starting.
The supervisor derives and reserves a per-instance share before spawning a child and never permits `spent_usd + reserved_usd` to exceed the global limit.

```bash
node --experimental-strip-types scripts/swebench-lite-supervisor.mjs \
  --start \
  --manifest /mnt/m/_work/_Sortie-dogs/_testenv/swebench-lite-dev23/manifest-dev-23.json \
  --run-root /tmp/sortie-dogs-swebench-dev23 \
  --output /tmp/sortie-dogs-swebench-dev23/predictions.jsonl \
  --cost-limit-usd <global-limit> \
  --workers 4
```

`--start` detaches the supervisor and prints its run ID and process identity.
Predictions are written in manifest order even when children finish out of order.

### 8-slot dev23 / staged timeout (v0.12.21-style comparison)

For a one-attempt comparison with the v0.12.19 corrected run and v0.12.20, pin the
same 23 public instance IDs, dataset revision, official images, `official-image-testbed`,
eight slots, effective **$2 per instance**, and the **20-minute progress checkpoint
with a 40-minute hard maximum**. Do not call this a fixed 40-minute-per-case timeout.
The checkpoint is built into `scripts/swebench-lite-runner.mjs`; there is no extra
supervisor flag for it. The optional longest-first scheduling in §4 is a different
condition and should not be silently enabled for a matched comparison.

Before starting, fix the release commit, downloaded `.tgz` SHA-256, runtime marker,
manifest hash, runner commit, and campaign exposure. Verify the public artifact hash,
preflight (`config_verified:true`, `provider_requests_started:false`), and that
`prior_conservative_exposure + 23 × $2 <= campaign_cap`. Use a fresh run root; do
not overwrite any prior run or start a second supervisor to correct an observation.
Here `RUN` is a new absolute directory, `MANIFEST` is its frozen manifest, and
`SUPERVISOR` is the script in the frozen runner checkout:

```bash
node "$SUPERVISOR" --start \
  --manifest "$MANIFEST" --run-root "$RUN" --output "$RUN/predictions.jsonl" \
  --cost-limit-usd 46 --per-instance-usd 2 --workers 8 \
  --timeout-seconds 2400 --prepared-environment official-image-testbed
```

Run the **exact native command**, not `... | tee launch.json`, a redirection, or a
chained command: the mission host records the declared shell input, and a pipeline
is a different input with different exit semantics. Preserve the returned tool
output as a separate record if needed. A detached start is not a completed run.
Read `$RUN/supervisor-state.json` **after** start and check `limits` (46, 2, 8,
2400, prepared environment), `policy` (one attempt, zero retries), actual
reservations (at most $2) and the heartbeat. A pre-start preview is not live
state. In the isolated candidate runtime observe a *real* `dog-worker-v010`
session's model `openai/gpt-6-luna-fast#max`; the configured agent alone is
not an actual model observation. Do not wait for an entire small probe to be
solved just to confirm routing. If zero requests or the route is wrong, record
the infrastructure failure and preserve its cost/state rather than claim a score.
Keep the active candidate and runner unchanged until this run finishes.

### Optional: longest-observed-first launch order

For a **future** run over the same instances, add `--duration-history /path/to/previous/run/supervisor-state.json`
to the `--start` command (and select `--workers 8` if the campaign calls for eight slots). The previous
supervisor run must be completed and have a positive `result.elapsed_ms` for each instance. The supervisor
launches the longest observed cases first, breaking ties by manifest position; freed slots take the next
case. It leaves the manifest and final predictions in their original order. `supervisor-state.json` records
the history path, SHA-256 and planned launch order; resume requires the same file and contents. Keep the
history snapshot available until the run is finished.

This is an inference wall-time optimization, **not** a score improvement or a reason to change an active
run. With the v0.12.17 dev23 durations, an eight-slot list-scheduling simulation changes ~39.8 minutes
in manifest order to ~35.2 minutes longest-first. Actual duration and result can change with concurrency;
record the scheduling policy as a changed comparison condition. The official scorer is separate.

### Optional: prepared official environment

Add `--prepared-environment official-image-testbed` to give agents the same Python environment the official
harness scores in, instead of letting them build one on the host.

Before each instance starts, the runner does the following:

- copies `/opt/miniconda3/envs/testbed` from the local `swebench/sweb.eval.x86_64.<instance>` image into the
  workspace's `.sortie-env/`;
- copies the editable-install `*.egg-info` directories from the image's `/testbed`, but never the image's
  repository, which keeps unreachable history;
- rewrites `/testbed` paths and script shebangs to the new location;
- puts `.sortie-env/bin` first on `PATH` and tells the agent in the prompt.

The directory is git-excluded and never part of the patch. The option is a different benchmark condition. It is
recorded in `execution.prepared_environment`, and each result's `prepared_environment` records the image ID and
Python version. Do not compare runs with and without it as the same condition. The images must already be present
locally. Each environment uses 0.2–1.4 GB inside the workspace until the instance ends.

The images are also the scoring environment, so their drift limits the reachable score. On 2026-09-25 the gold
patches resolved 15 of the 23 `dev` instances locally:

- all five pvlib instances fail: numpy 2 removed `np.Inf`;
- pydicom-1139 and pydicom-1413 fail: pytest 8 dropped nose-style `setup`;
- pyvista-4315 fails: `libGL.so.1` is missing.

Report scores together with this ceiling. Re-check it with
`swebench eval SWE-bench/SWE-bench_Lite --gold -s dev` after updating the harness or images.

## 5. Monitor progress

The durable source of truth is:

```text
/tmp/sortie-dogs-swebench-dev23/supervisor-state.json
```

Display `n/max`, current instances, status counts, and cost without modifying the run:

```bash
node --input-type=module --eval '
import fs from "node:fs";
const state = JSON.parse(fs.readFileSync("/tmp/sortie-dogs-swebench-dev23/supervisor-state.json", "utf8"));
const entries = state.instances ?? [];
const active = entries.filter(entry => entry.status === "running");
const completed = entries.filter(entry => !["pending", "running"].includes(entry.status)).length;
const n = Math.min(entries.length, completed + (active.length ? 1 : 0));
console.log(`${n}/${entries.length}`, JSON.stringify({
  status: state.status,
  current_instances: active.map(entry => entry.instance_id),
  spent_usd: state.spent_usd,
  reserved_usd: state.reserved_usd,
}));
'
```

The watchdog report records heartbeat, active runner identities, `n/max`, and runner loss events.
Treat stale heartbeat, runner loss, malformed state, or budget exhaustion as fail-closed conditions.

For the staged dev23 condition above, the runner checks progress at **20 minutes**
and stops at that checkpoint if there is no qualifying progress. An uncommitted candidate working-tree change
(excluding generated control files and the prepared environment) or priced model activity
in the preceding five minutes permits the run to continue only up to its configured hard
 timeout (**40 minutes** with `--timeout-seconds 2400`; 30 minutes by default if omitted).
Otherwise it stops with `no-progress-at-checkpoint`. A native `read` still running after
three minutes stops with `read-stalled`; an observed location-shutdown event or loss of the
private OpenCode server stops immediately. The watchdog and result metadata retain these
distinct reasons and the progress decision. A location-shutdown error emitted *only after*
the hard stop cannot be detected earlier from that error alone. These are inference-runtime
policies, not changes to the official grader or proof of a recovered score.

Observe `progress_decision` (`not-reached`, `extended`, `no-progress`) and the
watchdog/result stop reason for each case. `extended` means only that this
single attempt may continue to the hard maximum; it does not create a new
attempt, restart the clock, or establish an official resolution. When the
supervisor is terminal, verify exactly 23 attempts, the immutable predictions,
actual cost plus unknown-usage holds against the precommitted campaign cap
($285 for the v0.12.19–v0.12.21 campaign), and the
official image IDs. Then score the frozen predictions **once** with the
official SWE-bench harness (one scoring worker, `split=dev`), retain its report
and SHA-256, and compare *official resolved IDs* rather than patch presence.
If host observation was missed after an otherwise completed run, preserve the
run and report the observation defect; do not rerun inference to repair it.

After process cleanup, the runner freezes the working-tree patch even for a stopped attempt
(including `timeout` and `cost-limit`) before removing its workspace. Metadata records
`patch_capture: after-process-cleanup-including-interrupted`. The original execution status,
usage completeness and spend remain independent of patch availability. Nonempty interrupted
patches are submitted for official scoring as the same single attempt, without a retry.
An unchanged tree remains empty; a capture failure records `patch-capture-failed` evidence.
Unconfirmed process cleanup still prevents capture and prediction publication. Supervisor-level
termination that prevents the runner from finishing cannot guarantee patch capture.

## 6. Stop safely without rerunning completed work

Stop through the supervisor CLI, not by deleting state or output files:

```bash
node --experimental-strip-types scripts/swebench-lite-supervisor.mjs \
  --stop \
  --state-path /tmp/sortie-dogs-swebench-dev23/supervisor-state.json
```

The stop path terminates active process groups, preserves completed child output, marks active attempts interrupted, and writes terminal state.
Interrupted attempts are not silently retried.
Keep the entire run root if diagnosis or replay is required.

## 7. Run incremental official scoring

Run the grader only after the official harness is installed and its Docker environment is ready:

```bash
node --experimental-strip-types scripts/swebench-lite-grader.mjs \
  --grade \
  --state /tmp/sortie-dogs-swebench-dev23/supervisor-state.json \
  --run-root /tmp/sortie-dogs-swebench-dev23/scoring \
  --harness-executable /path/to/swebench-python \
  --split dev \
  --max-workers 1
```

The grader:

- includes terminal attempts only and never inserts pending/running rows;
- preserves failed or empty-patch attempts as completed results;
- binds each prediction to an immutable patch SHA-256;
- allows at most one grader process and coalesces new completions into the next batch;
- skips already graded immutable patches through durable scoring state;
- writes `scoring-state.json`, grader logs, snapshots, requests, and `live-results.json` atomically;
- does not stop inference when scoring infrastructure fails.

Do not publish or compare a score until the official harness report covers the intended immutable set.

### Post-score stage diagnosis (no regrade)

Once the official report and predictions are frozen, analyze the candidate's official log
directory separately, without re-running inference or the harness:

```bash
node scripts/swebench-score-diagnosis.mjs \
  --candidate-root /path/to/official/logs/run_evaluation/<run-id>/<model-name> \
  --predictions /path/to/frozen/predictions.jsonl \
  --output /path/to/new/diagnosis.json
```

The tool records input SHA-256 values, observed candidate application versus the *report*
`patch_successfully_applied` flag, test-patch collisions, collection/import errors, actual
test IDs and inner `Test Exit Code`. A report flag of `false` alone does **not** establish
a candidate-patch application failure; `infra_failure: false` does not establish that tests
collected. Stages are diagnostic, not a replacement for official `resolved` or a claim
about the root cause of an import failure. Missing logs remain unconfirmed.

The optional `--supplemental /path/to/frozen/test-reset/results.json` attaches **separate**
results from [`swebench-test-reset.py`](swebench-test-reset-diagnostics.md) after verifying
candidate patch and evaluator hashes. Each supplemental entry includes image ID, helper and
output hashes, the actual test IDs, container exit **and inner test exit**. No supplemental
PASS is counted as officially resolved. Keep the output in a new file outside Git; an
existing diagnostic file will not be overwritten. Never copy evaluator patches or test
expectations into the inference workspace.

Model-free verification against the frozen v0.12.17 dev23 evidence (2026-09-27):
6 official resolved, 6 collection/import, 2 test-injection collisions, 8 observed
assertion/test failures and 1 empty prediction. The original official 6/23 is unchanged.
With the two previously recorded supplemental reset checks, `sqlfluff-2419` has
inner test exit 0 and `pydicom-901` has inner test exit 1; neither is promoted
to an official resolution. The separate local diagnostic JSON has SHA-256
`5a9b570f3dc846e5c412237ff0549c5b6f3e62c35fdd8daed9a729dc9c3e0673`.

## 8. Artifacts to retain outside Git

Retain these together for reproducibility:

- candidate `.tgz`, version, runtime marker, and SHA-256;
- fixed manifest;
- supervisor state and watchdog report;
- ordered predictions and metadata;
- per-instance replay artifacts;
- scoring snapshots, requests, state, logs, live results, and official harness report;
- exact command lines, exits, and environment/tool versions without credentials.

## Release boundary

Benchmark execution does not authorize release or npm publication.
After results are accepted, follow the repository release routine separately.
The agent may prepare the package, Git commit, tag, GitHub Release, digest, and manual npm command, but npm publication remains a user action.
