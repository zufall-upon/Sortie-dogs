# Codex Coordinator cold resume: Anko, 2026-10-16

## Failure and minimal correction

Released v0.14.1 (`cc7481e`) stopped during native Git execution: Codex's sandbox
denied `.git/index.lock` creation. The native RPC error reported Git exit 128, not a
completed Mission command receipt. The interrupted histories omitted the pending
command and parent Task items. The existing
Mission had already claimed its Coordinator and admitted a direct unit.

The user-authorized parent-host executor could run the command, but cold resume
restored children only from parent Task result metadata. The retained Coordinator
therefore remained absent from the SDK session map, while its durable dispatch
remained open. Same-Task continuation was rejected; root execution was correctly
rejected because the original Coordinator still owned the unit.

The failed resume also exposed a protocol mismatch: current Codex records explicit
negative tool receipts as `status=failed`. A completed parent turn containing these
receipts was treated as an unresolved execution on the next resume.

The correction:

- Restore the existing Mission-bound Coordinator and nested child receipts from native
  history before replacing the previous owner generation. Reconcile only its exact admitted dispatch.
- Accept terminal failed tool receipts in completed parent turns, as already done
  for completed negative receipts. Interrupted negative receipts remain unresolved.
- Return the existing Coordinator Task and its exact `task_id` instead of advising
  background waiting when its dispatch ended but the retained unit still needs work.
- Show restored Mission, Coordinator and dispatch identities in CLI progress.

No replacement Mission, ledger reset, owner bypass, fabricated Task result,
validation PASS, or automatic command replay is introduced. Active/unknown native
execution still blocks resending. The SDK uses the existing Mission ledger and
recovery lease; there is no additional state store or approval mechanism.

## Three-principle review

- Autonomous: continue the original Coordinator and unit; no new user decision,
  mandatory Worker handoff or replacement plan.
- Efficient: reuse native context, Mission/run/unit identities, reservation and
  cumulative spend; recovery itself executes no commands or validation.
- Visible: expose the restored identities and the concrete same-Task next action;
  distinguish native terminal, unit validation and whole-Mission acceptance.

Existing writer ownership and unknown-execution handling are retained because they
prevent duplicate execution, not as a new security layer. Permission profiles,
authentication, role models and review/acceptance requirements are unchanged.
This remains post-execution verification, not an equivalent pre-execution guard.

## Verification

Two red/green reproductions cover the missing parent Task and the subsequent
completed failed receipt. The recovery regression additionally checks live owners,
active/unknown native turns, unknown commands and interrupted negative receipts:
no new model turn, command, settlement or dispatch release in those cases.
The success case uses the status-returned Task, retains the original Mission/run/unit,
executes one actual check, settles one reservation and does not fabricate Mission
acceptance.

- Common full suite: 125 files, exit 0, WSL Ubuntu/Node 22.14.0; 385,602 ms
  including setup/build. Snapshot SHA-256:
  `efea370db56912a67d14ee00b4391bdb24f7d30c547527821505813282740f30`.
  Record: `_testenv/wsl-1792130950041-11748/` (ignored).
- Related targeted checks: 110 tests passed (recovery/session/progress/shared Mission),
  plus the earlier 87-test recovery/session/app-server check. These overlap; do not sum them.
- Windows-only supplemental check: 19 tests, exit 0; native Node 22.14.0;
  build 10,699 ms and tests 4,344 ms, after the common full suite passed.

## Retained live Anko Mission

### PR #268 review follow-up

Both P1 findings were reproduced and corrected before integration:

- `4291580444`: owner replacement preceded nested Worker recovery. Restore completed
  or explicitly unstarted child proof with the predecessor generation first, then
  claim the new owner. The retained Worker reservation settles once without replay.
- `4291580454`: an earlier terminal Coordinator turn could close a newer dispatch.
  Persist the exact current Task/child/client-message/owner binding before each
  Coordinator request, including same-Task continuations. Missing current-turn proof
  leaves that dispatch unresolved; existing terminal parent receipts retain the shared
  reconciliation path without requiring a new binding.

The pre-fix targeted run reproduced all three added failures (completed nested Worker,
unstarted nested Worker and stale-turn settlement). Final targeted recovery/session/
settlement/progress/app-server checks: **120 passed**, exit 0, build 7.151 s and tests
8.147 s. Initial and resumed dispatches, absent current turns, legacy parent receipts,
live owners and unknown execution are covered. No live Anko rerun or scoring replay
was added; the runtime and measurements below remain those of the original run.

### Original live run

- Original task SHA-256: `96c0c7ad98237d6176034c8893d8bff164ec5fda45889e51780a65cf599ffcfe`.
- Anko base: `3f269a72ff69398b1250c584171f32d12c0d8085`.
- Root: `01a14334-ab42-77e1-aff8-2b9660251499`.
- Coordinator: `01a14334-fc3f-7110-b85e-e5d94eff5b6a`.
- Mission: `mission-d411a2bc-d254-4426-a233-4f9fd9a709c3`.
- Run: `operator-35d20506-8360-4edf-b2e3-e19e44d039bd`, unit `unit-1`.
- Recovery runtime: `1132db18b338a02a0f9cb92bb014b320dc4bd87a`.
- Frozen package SHA-256: `5837bc8df38f9784d724310057d3a5c16929cad7bc3d896ad6f66a5553e592a0`.
- Later commit `9479f27` changes only the continuation hint/progress projection and
  its tests; the running package is not modified or replaced during the session.
- Operator, Coordinator and Reviewer: native `gpt-6.1-sol`, effort `xhigh`, packaged
  defaults; no all-role override. No Worker was needed; this does not measure Luna Fast.
- Commands: previously authorized parent-host executor, no native permission override.
- Existing ChatGPT subscription authentication only; no API-key fallback or new tools.
- Common tests and Anko's existing Go validation run in WSL; Windows-only tests run
  natively. The stale Go helper was repaired before this recovery, with no inference
  running and no tool installation. That setup repair is not a product fix.

- Accepted: `true`; native terminal: `completed`; Mission phase: `completed`;
  recovery owner closed normally. Original Mission/Coordinator retained.
- Original direct unit/run retained through recovery. Ordinary review correction
  subsequently created run `operator-081ecd29-cb45-4f84-aa45-01b6525c529f`; this is
  actual correction work, not a recovery replacement or budget reset.
- Independent Reviewer found four Medium issues, reproduced them, corrected them
  and completed native author self-recheck. This is not a second independent PASS.
- Candidate: `117aeee35236d9031e29fd26eb3e8fb43e0caff4`, branch `feat/typed-bindings`,
  local commit only. No implementation diff remains; only local harness metadata
  `.sortie-dogs-v010/` is untracked.
- Successful resume: **17 min 34.790 s**; four new native turns; 141/141 command
  receipts terminal, 28 writes, no unresolved command, no control-tool refusals and
  no remaining write payload. Five nonzero commands include parser/regression
  reproductions and the corrected initial full-check failure; they are not hidden.
- Formal validation: initial exit 1, then exit 0 after implementation correction,
  then exit 0 after review correction. Passed unchanged checks were not replayed
  merely to recover the Coordinator or produce the final report.
- Latest native cumulative observations across the three retained threads:
  **11,369,797 tokens**. Includes retained history/native cumulative accounting;
  not a dollar amount or a claim of newly billed tokens. USD unknown; no metered API.
- Previous released-runtime failures remain recorded separately: native attempt
  70.555 s, failed host resume 82.637 s. A preliminary fixed-package restore failed
  before any model turn; the failed-receipt regression above covers that finding.
- Official scoring logic replay: **reward 1, F2P 9/9, P2P 94/94**, verifier exit 0;
  43,559 ms. Candidate patch SHA-256:
  `3500e99b3a0966af6f0b0bad5e87c4582f5bd21bf3a048d4b50891eb0a8118da`.
  Scoring uses a separate copy; the accepted source HEAD/status/patch were unchanged.
  Hidden tests are not fed back into inference. This is WSL Go 1.27.1 with dependency
  networking disabled, not Docker-equivalent or a hosted leaderboard submission.

Raw logs and frozen packages remain outside Git under the existing local
`_Sortie-dogs-artifacts` records/candidates directories, specifically
`records/anko-codex/coordinator-resume-1132db1/20261016/` for this recovery.
