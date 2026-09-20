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

## 1. Build, test, and package the candidate

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
