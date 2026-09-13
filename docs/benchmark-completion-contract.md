# Coding benchmark completion and correctness

This is the contract for future runs. Historical runs retain their original outcomes and protocol.

## Independent outcomes

- **Benchmark completion:** agent and child writers stop, then the workspace is frozen. Record stop
  reason, timestamp, base revision, candidate digest, and represented source files.
- **Task correctness:** one independent, pinned official verifier execution per frozen candidate.
  PASS requires its success reward. Agent claims, review PASS, and exit zero alone are insufficient.
- **Harness terminal:** record DONE, NEED_DECISION, failure, or interruption and its reason separately.
  Git staging/commit completion is an operational metric, not a prerequisite for grading a candidate.

For example: `task_correctness: PASS`, `harness_terminal: NEED_DECISION`,
`reason: git identity missing`. Sortie-dogs' own commit and delivery contract remains unchanged.

## Snapshot and verifier

Freeze committed, staged, unstaged, and relevant untracked source after confirming all writers have
stopped. Reject snapshots that omit relevant files. Grade a separate restored copy; never repair or
restart the original candidate. Preserve the original terminal outcome and consumed verifier attempt,
including failures. Use identical verifier inputs and environment for both arms; record environment
deviations, reward, new-behavior counts, and regression counts. Distinguish infrastructure failure
from a scored FAIL. Partial test fractions are descriptive and do not replace the reward rule.

## Comparable measurements

- Predeclare identical task inputs, model configuration, tools, budgets, and stop/freeze endpoint.
- Record agent-to-freeze and verifier durations separately. End-to-end comparison requires identical
  endpoints. Historical mismatched endpoints support descriptive timing only, not faster-completion claims.
- Do not rename elapsed time to time-to-validation/review without actual milestone timestamps.
- Total token/cost comparison requires deduplicated root and descendant usage. Missing coverage stays
  unknown; CLI stream counts are not total treatment cost. Avoid double counting reasoning tokens
  included in output. Host zero cost is not a billed-cost observation.
- A one-task partial result is not a general quality ranking or leaderboard-comparable result.

## Current runner boundary

The measured `run-arm` path retains its old expected-operation gate and must be updated and tested
against this contract before the next matched run. The explicit `verify-snapshot --confirm` command
supports retrospective one-shot grading of an unchanged, stopped candidate without converting its
harness failure into a matched success. Its current patch format rejects untracked source; broader
snapshot support is required before applying the new definition to arbitrary future candidates.
