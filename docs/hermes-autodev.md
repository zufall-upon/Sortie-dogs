# Hermes + OpenCode continuous development

One control-plane runner, two project configurations:

- `scripts/autodev-runner.mjs`
- `scripts/autodev/sortie-dogs.json`: SWE-bench Lite dev23 improvement campaign, approved cumulative API-equivalent limit **$300**.
- `scripts/autodev/vibe-dev-mate.json`: existing GitHub Project outcome cards, sequentially.

Principles: **autonomous, efficient, visible**. Hermes owns scheduling and notification;
the existing authenticated OpenCode V2 service owns the implementation session and its
native tools/permissions. The initial integration uses Hermes **no-agent cron** jobs:
idle polling does not spend a second model turn, and there is no redundant Hermes
judge/review around the existing development harness. No Hermes Kanban mirror is created.

## Commands

From the runner checkout, with Node 22.6+ and its existing dependencies:

```sh
node scripts/autodev-runner.mjs plan --config scripts/autodev/sortie-dogs.json
node scripts/autodev-runner.mjs tick --config scripts/autodev/sortie-dogs.json
node scripts/autodev-runner.mjs tick --config scripts/autodev/sortie-dogs.json --execute
node scripts/autodev-runner.mjs status --config scripts/autodev/sortie-dogs.json
```

`plan`, `status`, and a tick without `--execute` never submit model work. A live tick
discovers the existing service with `Service.discover()` and its native authentication;
it does not start/restart a server, change models, grant permissions, or alter plugins.
The project agent/model inherit the host unless explicitly configured.

The session ID is retained under the configured `_testenv/autodev/` state root. A tick
reads the root, owned descendants, all message/session pages, inboxes, questions and
permissions before considering another prompt. Active work is not re-prompted. A lost
admission response is reconciled from the unique dispatch metadata; an unconfirmed
request is never automatically resent. New concrete file evidence is required between
automatic continuations. Native failure, unchanged evidence or a missing handoff records
a blocker rather than an endless "continue" loop.

The final worker message contains:

```text
<autodev>{"status":"continue","summary":"actual result","next_action":"next useful operation","evidence":["/absolute/result.json"],"wait_for":[]}</autodev>
```

For detached inference use `status: "wait"` and
`wait_for: [{"kind":"supervisor","path":"/absolute/supervisor-state.json"}]`.
While the supervisor runs, no continuation is sent even as its heartbeat changes.
`complete` ends the development campaign, not an intermediate unit/card.
The handoff controls scheduling; its prose is **not proof of benchmark resolution or
product acceptance**.

## Budget and retained evidence

Before an independently billed operation, reserve its complete maximum exposure:

```sh
node scripts/autodev-runner.mjs reserve --config scripts/autodev/sortie-dogs.json \
  --id cycle-001-dev23 --kind supervisor \
  --path /absolute/cycle-001/supervisor-state.json --usd 46
```

Use `--kind probe` for the actual CLI check's `observation.json`, and a separate ID/path
for every declared single-case attempt. The native supervisor/probe must also retain its
own cost/time limits. A reservation is idempotent; it does **not** authorize launching
the same attempt twice. No runner reset, session replacement or budget-file deletion is
part of resume. Missing outputs retain the entire reservation. Running evaluations keep
the remaining reservation; terminal unknown usage keeps a hold instead of becoming zero.
Implementation-session usage is estimated from the actual root/descendant model and tokens.

The $300 limit is cumulative **API-equivalent admission exposure**, not a subscription
invoice or an exact cap on delayed/in-flight usage. Native usage is checked on each tick;
reported exhaustion stops owned active sessions and prevents new admissions. Do not
claim that a finite reservation itself constrains an unbounded provider request.

Keep `state.json`, `events.jsonl`, frozen packages/manifests/predictions, native observations,
actual task/check logs and official score reports outside Git. State and events expose the
current action, actual session/models, cumulative priced/held exposure and next operation.
`--quiet` produces empty stdout for running/waiting/paused work and repeated unchanged
host blockers, so Hermes no-agent cron suppresses idle delivery. `last-output.json` records
printed output, **not confirmed delivery**; Hermes' delivery/execution ledger remains the
authority if a notification fails.

## Sortie-dogs workflow

Read existing official results → pick one failing case/theme → analyze its native history
→ improve on a short-lived branch → targeted validation + matching real CLI task
→ existing PR/confirmation/main integration → freeze the main candidate → 23-case
pass@1 inference → sequential official scoring → compare both score and usability → repeat.

Reuse `docs/swebench-lite-benchmark.md` and its existing tools. For the established dev23
comparison reserve $46 for 23 × $2, eight slots, `official-image-testbed`, 2400-second hard
maximum, native 20-minute progress checkpoint / 5-minute recent activity / 3-minute read stall.
Do not run a new 23-case matrix for every local edit, retry interrupted inference, change
the active candidate, or rerun an already matching observation solely for documentation.

The practical CLI check must use the **same package**, a **real repository and original
code-development task**, native validation and a completed Mission/succeeded receipt.
Use the existing `mission-cli-probe.mjs` programmatic `probe(..., {mode:"complete", instance,
prompt, capUSD, ...})` surface; do not substitute its default seed-file fixture or READY probe.
Routing observation and practical task acceptance are distinct evidence. Success applies
to that observed task/candidate, not all future work.

`verify-cycle --receipt /absolute/receipt.json` checks matching package hashes, 23 pass@1
dev rows, complete official Boolean results, frozen prediction/patch hashes, completed
practical CLI evidence/log hashes and Git ancestry into the recorded main commit. The receipt
includes `package`, `package_sha256`, `manifest`, `manifest_sha256`, `predictions`,
`predictions_sha256`, `supervisor`, `scoring`, `source_repo`, `commit`, `main_commit`,
`runner_commit`, `runner_root`, `runner_sha256` (runner/supervisor/grader/model-cost/release-cli scripts),
`runtime_marker`, `main_integrated: true`, and
`practical: {observation,task,repo,base_commit,verification:[{command,exit,log,log_sha256}]}`.
`task` is the immutable original prompt file; its bytes must match the actual CLI observation's
`task_sha256`, and the observation must identify that real repository/base commit. A fixture
observation without a repository cannot pass this check.
This gate does not publish or replace a global installation. Official environment failures
and the image ceiling remain separate from model/runtime defects and supplemental tests.

## Vibe-Dev-Mate workflow and host

Use the existing Project URL ending in `projects/12`, the current docs and full card contract.
Resume the one In progress card, otherwise the smallest dependency-resolved Ready card.
Finish its canonical checks, necessary review and existing user acceptance before Done;
only then promote the next card. No duplicate board or unit-as-card expansion.

The current Vibe `AGENTS.md` requires Windows tools at exact paths. On 2026-10-09 the user
explicitly authorized `/home/user/.local/bin/gh` for this Ubuntu controller's Kanban operations.
The config records that narrow override and checks the exact approved executable before
dispatch. Each gh child must remove token environment variables and use saved authentication.
Other tool/validation conditions remain unchanged: reuse separately approved Linux commands
from the current card and `docs/LINUX_TASK_PORT.md`, but do not claim they are Windows passes.
Only actually required Windows operations wait for that host. Do not weaken the card's
product Task/fee/acceptance boundaries or treat this controller as authority to replay a
stopped product attempt. The initial live board has one In progress card, MK2-05-03;
the controller reconciles it before implementation. A migration to another host must retain
the previous ledger as evidence and explicitly bind the new local path/session; do not
silently rewrite an existing campaign identity with `--directory`.

## Hermes scheduling and operator controls

Use a tiny script under the existing `HERMES_HOME/scripts` per project that calls the same
runner with its config, `--execute --quiet`. Register it through the installed Hermes CLI/API
as a no-agent cron job, not by editing `cron/jobs.json` under a running gateway. Keep current
jobs/configuration unchanged; test one invocation before enabling recurring runs. A 2-minute
tick bounds idle monitoring without a second model call; results can go to the already
configured development notification channel. Verify the gateway/cron execution and delivery
ledgers; an alive PID or created job is not proof that it ran.

```sh
node scripts/autodev-runner.mjs pause --config scripts/autodev/sortie-dogs.json
node scripts/autodev-runner.mjs resume --config scripts/autodev/sortie-dogs.json \
  --instruction /absolute/new-owner-instruction.txt
```

Pause stops future dispatch, not current work. Resume is an explicit new owner instruction;
it keeps the session, history, original limits, previous attempts, unknown holds and spend.
Native host questions/permissions are answered through the existing host, not auto-approved
by the runner. Resolve a known blocker before asking for another execution.
