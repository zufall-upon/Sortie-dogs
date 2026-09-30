# Anko lifecycle / contract recovery — offline candidate

## Scope and status

Branch: `fix/anko-lifecycle-contract-recovery`, based on
`d19e8be0d21180cc23ad2ae4b853d846a18e77bc` (`origin/main`).
Runtime/test candidate: `09487c0` (`fix: recover Anko mission lifecycle and in-task contracts`).
PR: https://github.com/zufall-upon/Sortie-dogs/pull/146 (base: `main`).
Subsequent user-authorized real-session findings and repairs are recorded in
[`anko-recovery-live.md`](anko-recovery-live.md); the status below describes the
original offline candidate, not the later live follow-up.
Live follow-up: actual V2 same-Task scope recovery and a deliberately missed native
Task after-hook both completed with independent Dog-Reviewer **PASS** and
**succeeded** receipts. Runtime follow-up `be1dd37`, launcher correction `2a6d265`;
integrated offline checks **1394/1394 PASS**. These bounded fixture results do not
establish canonical Anko completion or its official score.
This is an offline runtime fix, not a release or an Anko completion report.
The original working tree, existing campaigns and historical Anko artifacts were
not modified. No paid Worker/model campaign, publish or global apply was run.

## Changes

- Review/replan recovers the exact native Task's reservation and writer from the
  existing Mission attempt, goal ledger and authorization. Saved sufficient
  terminal records are reusable; absent/conflicting records and active descendants
  remain actionable diagnostics. The generic legacy recovery route cannot bypass
  rejected current-Mission proof. An old dispatch cannot release another binding.
- Failed/interrupted native completion settles lifecycle accounting but never
  promotes observed validation into successful unit evidence. Orphan interruption
  requires the exact aborted parent Task and child, not inferred ownership.
  Escalating Fast-lane work to a Coordinator retains the prior Task's actual parent.
- Concrete native write paths correct estimated Mission scope in the same Task,
  unit, child and reservation. Workers can use `expand_unit` for shell outputs.
  Explicit user prohibitions, writer conflicts and host permissions remain in
  effect. Storage failure restores the old manifest/handoff/binding; scope conflict
  retains both original writers. No approval or repair-only Worker is added.
- New validation fixes its scratch recipe and relevant host environment at
  validation time. Explicit TMPDIR/Go cache scratch does not invalidate proof on
  generation/cleanup; declared reads, tracked files and exact deliverables remain
  protected. Input/check/environment changes and newly materialized real outputs
  invalidate proof. Scope-only additions do not rewrite old PASS. Legacy evidence
  retains its original recipe: no retroactive scratch classification.
- Objective text remains verbatim up to 32768 characters in reader/schema/generated
  handoff. Handoffs retain original requests, acceptance/negative constraints and
  confirmed runner/input/time/cost/attempt/grading facts with provenance.
- Launch caps are not remaining budget. Worker units, benchmark attempts,
  Worker-only cost and unknown campaign remainder are separately labelled.
  Review terminal checks do not repeatedly fetch pricing history.
- Worker/Coordinator guidance does not delegate inaccessible external artifacts to
  Scout, and identifies supported source-scope Git operations without requiring a
  direct `.git/**` write grant. Actual host refusals are distinct from speculation.

## Regression assertions

`test/anko-recovery.test.ts` contains 18 offline lifecycle/scope/freshness/context
cases using production hooks and real local validation commands, not real model
sessions. Related existing tests cover cold recovery, Rescue, review lineage,
lease replacement, schema boundaries and legacy evidence.

Red → green assertions:

- Missing after-hook completion: running unit / stale reservation becomes settled
  once during Review; repeated reconciliation neither consumes another unit nor
  reruns checks. Native completion alone is not acceptance evidence.
- Wrong child / active descendant: the legacy fallback previously consumed the
  reservation after stricter proof rejected it; now reservation=1, consumed=0 and
  unit=running, without cancel or redispatch.
- Failed/interrupted terminal: evidence remains empty, reservation=0 and
  consumed=1; actual continuation retains cumulative accounting.
- Scope repair: same run/call/child/unit/budget, no replacement Task. Injected save
  failure and overlapping writer preserve original controls and ownership.
- Scratch generation/cleanup preserves fixed proof and Review; actual output,
  `.tmp` input, tracked/exact scratch-path files, check or environment changes do
  not. Legacy PASS is not rescued by later exclusions.
- Objectives of 2337/2022/2007 characters and negative acceptance survive exactly;
  a partial later conditions record does not erase the earlier fixed facts.
- First full run exposed Fast-first history-read count `3 != 1` and failed
  Coordinator correction dispatch. Both are fixed without weakening those existing
  assertions: one Review history read and the same-mission corrective Task.

## Verification record

All commands were run with `bash -lc 'time <command>'` on Ubuntu/Node 22.22.1.
Available raw logs and result metadata stay outside Git in `_testenv/anko-recovery-pr-evidence/`.
The tool-reported raw path for the 210-test run was not retained; its transcript
result is recorded rather than substituting a different run's log.

| Command / selection | Exit | Wall time | Result / reason |
| --- | --- | --- | --- |
| Initial targeted red reproduction | 1 | 7.260 s | `terminal_not_reconciled` before recovery changes |
| Targeted: anko-recovery, v010-runtime, mission-fast-recovery, mission-binding-recovery, mission-operation-lifecycle, mission-rescue, protected-snapshot, scope-lease-registry, schema, mission-review | 0 | 17.168 s | 210/210 PASS; remaining six failures resolved |
| `npm run test:full` (first integrated candidate) | 1 | 124.300 s | Stops on two existing Fast-first regressions; not a completed full-suite pass |
| Targeted: anko-recovery, mission-fast-first, mission-fast-recovery, mission-operation-lifecycle, mission-rescue, mission-validation-retry, mission-review-replan, operation-recovery, operator-mission, v010-runtime | 0 | 16.735 s | 184/184 PASS; ownership/duplicate pricing fixes and exact orphan checks |
| `npm run test:full` (second integrated candidate) | 1 | 164.611 s | V2 fixture lacks descendant listing (2 cases); Worker tool-list expectation lacks intended `expand_unit` (1 case) |
| `npm run test:targeted -- test/v2-plugin.test.ts test/anko-recovery.test.ts` | 0 | 9.360 s | 55/55 PASS after the V2 fixture/expectation updates; runtime code unchanged |
| `npm run test:full` (third integrated candidate) | 1 | 164.713 s | Stops on an existing Worker guidance assertion; restore the no-user/no-delegation instruction for in-request repair |
| `npm run test:targeted -- test/validation-workflow.test.ts test/wave-boundary-replay.test.ts test/swebench-lite-runner.test.ts` | 0 | 30.406 s | 66/66 PASS; guidance assertion and remaining tests from the fail-fast full run |
| `npm run test:full` (final integrated candidate `09487c0`) | 0 | 166.978 s | 1392/1392 PASS across 90 files; scheduler valid, no missing/duplicate files, max 2 lanes |

Every targeted selection above used `npm run test:targeted --` and explicit
`test/<name>.test.ts` files. Build is included by the repository test router.
`git diff --check` passed. Windows-specific tests were not run on this Linux host.
The follow-up documentation commit records these results without changing the
runtime/test candidate; no extra full run is needed for that record-only change.
Runtime/test/scripts/config source digest (per-file SHA-256 map in `source.json`):
`9de2dbc0c6a26039f591f71368f980d07bbfea352bed0aefafc8c54ef4a5d3e4`.
The source map was unchanged at completion of the final full run.

## Still unverified / next actions

1. The canonical Anko `run-once.mjs` runner source was not found in the repository,
   `/home/user` or retained Anko output. Obtain the original Windows runner and
   preserve its exact inputs/flags before running Anko. Saved launch conditions
   are implemented; canonical runner persistence is **not** complete. No old
   fixture/probe was substituted for it.
2. No real V2 session recovery has been exercised for this candidate. With valid
   existing execution authorization and remaining budget, verify actual sessions,
   Worker models, lifecycle/expense records and the original Anko acceptance.
   Current evidence does not establish independent Anko Review, commit,
   acceptance or official score.
3. Freshness retains the established declared input/output scopes, not a whole
   project fingerprint that would invalidate prior units on later-unit output.
   The saved environment covers host runtime/platform, common toolchain variables
   and variables referenced by declared commands; it is not a complete native
   login-shell/toolchain-image capture. Actual Windows `.tmp`/`parser/y.output`
   contribution to the historical stop remains unconfirmed.
4. Integrate through a main-targeting PR/confirmation only. No merge, release,
   publish, global apply, model comparison or additional paid campaign is included.
