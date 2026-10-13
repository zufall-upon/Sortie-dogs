# Cycle049: compatible setup repair on v0.13.17

## Change and validation

The benchmark runner no longer treats every installed dependency version as immutable
or interprets a brief setup attempt as a one-command limit. A demonstrated missing or
incompatible repository-declared dependency can be repaired, including its necessary
prerequisites, in the existing environment and within the original budget and deadline.
Unchanged failed installs, unrelated upgrades and extra environments remain discouraged.
Explicit user restrictions, public-only inputs, stop conditions and acceptance are unchanged.

- Runner commits: `88b061b`, `85f3174`, based on main `0479446`.
- `npm run test:targeted -- test/swebench-lite-runner.test.ts`: exit 0,
  66 passed, 0 failed, 0 skipped; 33.691 seconds. Reuse this unchanged-source evidence.
- Runtime archive remains published v0.13.17, marker
  `0.13.17-handoff-continuity-v1`; no plugin/runtime change or release operation.
- Package SHA-256: `a385b3aee318ec56f5ece2012c103bd2dceed1114a8d600e3d4155921e71d5ed`.

## Independent outcomes

- `sqlfluff__sqlfluff-1763`, pass@1, one slot, $2 reservation,
  `official-image-testbed`, 2400-second hard maximum with the native staged stop policy.
  Inference stopped at the cost limit after 2037.114 seconds, with a frozen 4187-byte patch.
  Priced API-equivalent usage was $2.01971964; pending usage remained marked unknown.
  The cap is an admission estimate, not an exact charge guarantee.
- One official execution, `split=dev`, `max_workers=1`, `retry_count=0`:
  **0/1 resolved**, resolved IDs `[]`; patch applied, three new-behavior test failures,
  66 passing tests and no reported infrastructure failure. This is not a score improvement.
- An actual `dog-worker-v010` used `openai/gpt-6-luna-fast#max` in the frozen
  single-case environment. Operator, Coordinator and Reviewer used
  `openai/gpt-6.1-sol#xhigh`; the Coordinator also performed corrections.
- The separate original complete-mode practical task used the same archive and repository
  base. The Coordinator executed directly, with Sol also used by Operator and Reviewer;
  no Worker ran in that task. Matching Worker observation is separate execution evidence,
  not proof of practical correctness.
- Practical dependency repair followed an observed Jinja/MarkupSafe import failure, then
  successfully exercised the real dbt/PostgreSQL-templater public command with confirmation.
  Before the source fix, 523 bytes were truncated to zero; afterward all 523 bytes were
  preserved and the expected failure notice appeared. Final native validation exited 0:
  145 passed, 1 skipped. The dependency check still reported unrelated development-tool
  compatibility warnings; this is not a claim that every installed package is compatible.
- Practical native Mission completed with a succeeded receipt in 1337.720 seconds;
  priced API-equivalent usage was $1.73306680. Observation recovered after host restart
  without restarting inference, altering the task or repeating setup. Original CLI exit
  remains unknown, `accepted=false`: native completion is **not strict probe acceptance**.

## Integration and next measurement

Integrate the verified runner-only setup clarification, not a claimed benchmark success.
Retain the prior full23 score of 9/23 and Cycle048's interrupted 0/1 separately.
Do not widen this result into another full23 run: the official comparison failed and
strict original probe acceptance is unavailable. No completed-main-cycle verification is
claimed. Diagnose the saved native validation/confirmation detour before a changed-candidate
single-case comparison; do not replay either consumed attempt or target hidden test details.

Durable artifacts are outside Git under
`/home/user/Sortie-dogs/_testenv/autodev/sortie-dogs-dev23/cycle-049/`:
`frozen-candidate.json`, `single-case/supervisor-state.json`,
`single-official-scoring/scoring-state.json`, `official-stage-diagnosis.json`,
`single-native-history.json`, `practical/smoke-1/observation.json`,
`practical/recovered-supervision/task-evidence.json`, and `terminal-accounting.json`.
