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
