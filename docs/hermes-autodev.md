# Hermes + OpenCode continuous development

One control-plane runner, two project configurations:

- `scripts/autodev-runner.mjs`
- `scripts/autodev/sortie-dogs.json`: SWE-bench Lite dev23 improvement campaign, approved cumulative API-equivalent limit **$600** (original $300 + owner-authorized $300 on 2026-10-11; previous spend and unknown holds retained).
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

The Vibe no-agent cron now passes the original retained f/g/h standing instructions
on every work unit through `autonomy.instruction_files`; updating the chat skill alone
cannot affect no-agent scheduling. `standing_authority` retains their exact paths/hashes.
Deferred external steps belong in `deferred`; local work uses `continue`. A blocked
handoff can also name a concrete `local_next_action`, which still needs changed evidence.
Use a stable full-card `work_id`, never a changing description or internal subunit.
`local_work_exhausted:true` means genuinely no authorized local work remains; it does
not grant acceptance, a Task start or completion. Optional `blocker_kind` distinguishes
host/input/implementation from budget/auth/permission/acceptance/no-resend stops.

An ambiguous successful blocked handoff under that delegation gets one bounded
reconsideration in the same native coordinator, not an extra Hermes judge/reviewer.
`autonomous_reconsiderations` is durable and keyed by stable card plus the recorded
authority hash. Changed prose or evidence does not replenish it; idle ticks do not
call a model. Real native failures/input, ambiguous admissions, missing authority,
actual local-work exhaustion and budget stops do not trigger reconsideration.
`pause_origin:owner` is never automatically cleared; legacy pauses require explicit
deployment reconciliation rather than silent adoption. Only runner-origin stops can
follow this configured delegation. Existing Task/model/fee/replay/acceptance limits
and final Windows validation remain intact. Sortie has no automatic reconsideration
policy; its campaign conditions remain unchanged except for explicit owner-authorized budget additions.

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

The $600 limit is cumulative **API-equivalent admission exposure**, not a subscription
invoice or an exact cap on delayed/in-flight usage. Native usage is checked on each tick;
reported exhaustion stops owned active sessions and prevents new admissions. Do not
claim that a finite reservation itself constrains an unbounded provider request.

Keep `state.json`, `events.jsonl`, frozen packages/manifests/predictions, native observations,
actual task/check logs and official score reports outside Git. State and events expose the
current action, actual session/models, cumulative priced/held exposure and next operation.
`--quiet` alone produces empty stdout for running/waiting/paused work and repeated unchanged
host blockers. The installed cron scripts now use `--notify`: readable reports on useful
handoffs, immediate native questions/blockers, one backfill of a previously paused blocker,
and a progress report at most every 30 minutes while running/waiting. Every report is a
Japanese summary of at most five short lines: project/status, outcome, blocker/question,
next operation, current API-equivalent exposure. English handoff prose, stale budget requests,
paths, hashes, Session IDs and diagnostic JSON remain in evidence, not chat. Handoffs supply
short Japanese `notification` fields; legacy English handoffs use Japanese status summaries
and observed supervisor counts, never an extra translation model. Unchanged delivered blockers
are not repeatedly sent. Idle monitoring remains no-agent and makes no model call.

The retained native Session may move into a development worktree. The runner follows that
Session ID and records `native_directory`; the canonical repository and campaign accounting
directory do not change. A worktree move is not a reason to create a new Session or stop
monitoring. Monitor exceptions also generate an immediate five-line Japanese diagnostic,
record `monitoring_error`, preserve pending operations/spend, and retain the failing exit code.
Changed useful handoffs are immediate; unchanged supervisor progress remains rate-limited.
If a user operation is required, the notification must say who acts and request that exact
operation, not merely promise that the coordinator will accept later. Delivery receipts prove
transport success, not reading or acknowledgment. An explicit report of a missing notice
permits an intentional resend with a separate receipt while retaining the original evidence.

`last-output.json` records legacy stdout, **not confirmed delivery**. The new
`notification-state.json` and `notification-events.jsonl` bind each output to the actual
Hermes execution ID by matching the live worker's PID/start time through its process ancestry.
The two jobs' automatic cron delivery is now intentionally `local`; the shared runner uses
the installed `hermes send --json` directly to `discord:1508322321738240211`. This native
script-friendly path has no LLM or English cron header/footer and leaves other jobs and the
running Gateway unchanged. Direct `delivered` requires a successful native send receipt with
a message ID, bound to the current execution in the notification ledger. Cron `suppressed`
is expected for this transport and must not overwrite a direct receipt. Legacy cron sends
still use the execution/delivery ledger. Emitted, skipped, queued and unknown are not delivery
success. An unchanged unknown delivery is not blindly resent. Manual previews cannot consume
a cron notification. Format/transport migration sends one corrected short report.

Native unknown usage is scoped to the current dispatch, not every historical assistant
message. `pending.unknown_at_start` and `native_holds` prevent a historical missing-usage
message from retaining another turn's reservation.

For an explicitly requested repair of an existing stopped ledger:

```sh
node scripts/autodev-runner.mjs reconcile --config scripts/autodev/sortie-dogs.json
node scripts/autodev-runner.mjs reconcile --config scripts/autodev/sortie-dogs.json --execute
```

The first command only plans; the second saves a receipt with the original state, before/after
accounting and exact proofs, then updates the same state under its existing lock. It neither
resumes nor submits inference. Settled dispatches retain a conservative hold for genuinely
unknown messages. Terminal image-preparation failures can release their reservation only
when the retained result has zero requests/usage/watchdog activity and the hash-verified
replay has no execution command/output/exit or patch. Original supervisor/replay artifacts
remain unchanged. The release applies only to the exact frozen supervisor snapshot; changed
evidence re-holds exposure. Other uncertain usage, attempts, priced usage and the approved cumulative limit
remain retained.

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
stopped product attempt. The initial MK2-05-03 startup snapshot is historical;
the controller reconciles the full current board before implementation. A migration to another host must retain
the previous ledger as evidence and explicitly bind the new local path/session; do not
silently rewrite an existing campaign identity with `--directory`.

## Hermes scheduling and operator controls

Use a tiny script under the existing `HERMES_HOME/scripts` per project that calls the same
runner with its config, `--execute --quiet --notify`. Register it through the installed Hermes CLI/API
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

The installed Hermes `autodev-control` skill handles owner replies of the form
`autodev <project-id>: <instruction>`. Its source is
`scripts/autodev/hermes-control.SKILL.md`. It reads the current state/evidence and forwards an
explicit authorized instruction via `resume --instruction` to the existing coordinator.
An informational reply is not new product/model/fee authority; native permissions/forms
remain in OpenCode's existing UI. The skill and runner carry the later retained f/g/h
delegation without broadening the initial implementation-0/review-1 Task allowance or
replaying consumed operations. Native product work remains separate from developer
coordination; a deferred real-input gate is not proof all source work is exhausted.
