# Operation result collection: autonomy audit, 2026-10-07

## Reflection and scope

The user requested one v0.13.10 Anko run, with subsequent action decided after
seeing its result. The outer operation's completion was incorrectly coupled to
the benchmark's success. Result recovery and reporting became more orchestration
work instead of returning a terminal failure promptly. This also obscured the
difference between actual benchmark completion, checks and the outer Mission.

This change addresses that demonstrated mismatch. It does not diagnose or fix
the separate internal Luna reasoning silence, change provider transport, add
permissions or approvals, or launch another paid benchmark.

## Real V2 observations

Evidence remains outside Git under the original checkout, `/home/user/Sortie-dogs`:

- First v0.13.10 attempt: `v01310-once-20261007`, trial
  `20261007T081455095Z-358e972d`; benchmark unaccepted, shell exit 1,
  `session-no-progress-timeout`, execution 650,972 ms.
- Second requested attempt: `v01310-once-20261007-02`, trial
  `20261007T084532161Z-639507fd`; actually launched once, not cancelled before
  launch. Native shell ran 881,495 ms and exited 1; benchmark execution took
  859,784 ms. Fixed package SHA-256:
  `f92adb8a0bee4180490f13eb5df53cc49744c77ef61926d9d6ba90f370321bee`.
- Second root: `ses_eea75e63fffeoqsLScxCDxVGDA`, observed
  `openai/gpt-6.1-sol#xhigh`. Worker:
  `ses_eea754010ffe5my1IMfk88up1t`, observed
  `openai/gpt-6-luna-fast#max`. Loaded marker:
  `0.13.10-codex-windows-v1`, OpenCode V2 2.0.18.
- Second stop: `session-no-progress-timeout`, 181,027 ms without progress;
  last progress source `session.reasoning.started`, no active native tools,
  no pending permission and no stream error recorded. The precise silence
  cause remains unknown; these observations do not prove a permission/gate stall.
- Second candidate committed once at
  `70e78efed1e70963c04f20a6d6df40945bf1c21d`, `bench/anko-v01310`, clean tracked
  tree. Native DB records show successful parser and VM tests and one corrected
  targeted-test failure. The required formal `go test ./...`, Worker return,
  independent Review and native benchmark acceptance were not reached. No official
  grading was performed. Tests or a commit alone are not benchmark success.
- The outer Mission retained its exact native operation command, start/end and
  exit 1 as `outcome: execution-failed`. Its requirement R1 explicitly said run
  once and stop after result collection; R5 prohibited automatic reruns and fixes.
  Its later cancelled state did not undo the consumed attempt or native result.
  The released completion/submission checks admitted only `status === executed`,
  preventing acceptance of a faithfully collected failure even after result checks.
  This establishes the completion-policy mismatch, not the cause of the benchmark's
  internal silence or every later Coordinator cancellation.

Primary records:

- `_testenv/anko-reusable/v0.13.10/attempts/v01310-once-20261007-02/last-attempt.json`
- `_testenv/anko-reusable/v0.13.10/attempts/v01310-once-20261007-02/verification.json`
- `_testenv/anko-records/v0.13.10/20261007T084532161Z-639507fd/`:
  `no-progress-stop.json`, `receipt.json`, `settlement.json`, retained DB and Git.
- Original outer Mission root `ses_eeb6297a0ffeItq1FUdfh1vaeL`, retained in
  `.sortie-dogs-v010/missions/` in the original checkout.

Native settlement observed both owned sessions interrupted and the owned service
stopped. Verification reports `record-integrity-verified`, not benchmark acceptance.
Existing results, locks, source, Git, DB, package pins and accounting are not rewritten
or retroactively accepted by this PR.

## Cost scope

- Second attempt known-price subtotal: **$0.23844552**, two unresolved usage messages;
  complete estimated cost and actual billing unknown.
- Inherited known subtotal after the first v0.13.10 attempt: **$3.14439396**, eight
  unresolved messages. Combined known subtotal: **$3.38283948**, ten unresolved
  messages. Remaining known-price allowance from $15: **$11.61716052**.
- This arithmetic carries forward retained receipts; it does not modify a fixed
  running arm or reclassify the original v0.13.9 campaign ledger. The separate original
  trial's $0.0715642 remains excluded and incomplete. Outer orchestration/chat costs
  are also separate, not included in these benchmark-session subtotals.
- No new benchmark, diagnosis-model call or paid CLI probe was launched for this PR.
  Model-free tests do not establish a new live Anko success or a provider fix.

## Implementation against the three principles

- **Autonomy:** complete result collection from a terminal failure without an
  implicit repair loop. Success requested by the user remains in the formal check
  and Operator's comparison against the original request. No new policy flag,
  model-authored proof file, approval step or blanket permission allowance.
- **Efficiency:** share the existing `execution` schema with `start_mission` so
  a known operation plus meaningful result validator dispatches one Worker directly.
  Unknown operations can still use Coordinator. Already registered execution is
  retained when the unit is declared later. Failed result collection never alone
  triggers a replacement Worker or Coordinator at the acceptance boundary.
- **Visibility:** preserve `execution-failed` and native exits in status,
  acceptance summary and completion receipt; expose terminal completeness separately
  from process success. Host-authored return prose explicitly distinguishes an
  accepted result from a failed operation. These are projections, not new checks.

`NO_START`/zero attempts, missing declared commands, another cwd's command and active
operations remain incomplete. Every declared command needs its own native terminal
outcome. Formal validation failures, stale inputs/outputs, required Review and root
acceptance remain unchanged. Partial failure cannot conceal an unstarted command.

## Validation

The regression uses real local commands: an operation writes its result and exits 1,
then a separate result validator exits 0. The existing native hook lifecycle admits
one Worker, records the failure, validates collected evidence, reviews and accepts
the outer result. Both Coordinator and direct paths are covered, including cold
reload. The failed operation is never rerun, its exit/outcome is never changed, and
one formal validation admission suffices. A failing result validator still cannot
complete the Mission; a user requirement for successful execution is exercised by
a validator requiring the collected operation exit to be zero.

Before the fix, targeted tests reproduced the failure-only completion guard and
the partial-command classification defect: 41 passed, two failed, exit 1; build
10,250 ms and tests 1,522 ms. Subsequent fixture/renderer failures were diagnosed
before the full-suite run. Command, reason, exit, elapsed time, source SHA-256 and
full logs are retained in this worktree under
`_testenv/operation-result-autonomy-20261007/` using one parameterized validator.

Final commands:

```sh
npm run test:targeted -- test/mission-completion.test.ts test/operator-mission.test.ts test/v010-runtime.test.ts
npm run test:full
```

- Targeted candidate: **165 passed**, zero failed/skipped, exit 0;
  **22,527 ms** including build (10,274 ms) and tests (12,146 ms).
- Full candidate: **115 files, 1,796 passed, two skipped, zero failed**, exit 0;
  **242,606 ms** including build (10,208 ms) and tests (232,279 ms).
  The skips are opt-in paid Codex live tests, not passing live results.
- Both validation receipts pin source SHA-256
  `e6765b2d4d857397cc153c5e22657d66b6689318aac509db7e34330be8047564`.
  Subsequent edits only clarify this audit and record validation results; runtime
  and tests are unchanged, so the full suite is not repeated for documentation.
- Read-only native-observation replay: original outer Mission bytes unchanged,
  terminal completeness true, process success false, native exit 1. This does not
  reopen or accept the cancelled Mission or its failed benchmark.

Linux validation only; Windows-specific tests and a new live benchmark are not
claimed. The PR does not merge, release, publish or globally install this change.
