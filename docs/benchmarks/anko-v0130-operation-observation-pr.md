# Anko v0.13.0: background operation observation repair

## Incident and self-review

- The one authorized Anko run did finish: the isolated V2 root `ses_f134dc123ffeszy8IVgVV46bcN` recorded `succeeded/completed`, 48.02 minutes, estimated model cost $2.28924120 and final Review `EVIDENCE_GAPS`. The outer mission nevertheless classified its launch as `execution-failed` after roughly 35 ms and did not record the unit's declared validation. The later replacement runner stopped before inference on a marker-path error; it did not repair the first run's observation.
- I should have checked the first Worker's native shell result and live process before handing off another runner. The original Worker's `shell` input was the declared command with `background: true, timeout: 0`. V2 completed the *launch tool* with `metadata: { status: "running", shellID: "sh_0ecb21c6e001Y8FEEJFsdQvWYS" }` and no `exit`. The child process remained active. The outer plugin wrote `completedAt`, then treated the missing exit as failure. The subsequent `process-defect` and generic replan instruction made a duplicate setup likely despite the one-run limit.
- The Anko candidate and native session were not blocked by this bug. The failure was in the outer operation lifecycle and its visibility. Do not interpret the existing native result as a formal outer-mission acceptance or rerun Anko to manufacture one.

## PR proposal and boundary

1. Before side effects, reject `background: true` **only for an exact declared operation shell command**. Return the correction to the same Worker: use foreground with a timeout covering the stated bound. Leave background diagnostics and unrelated shell work alone. No extra approval, model probe, isolation mechanism or additional Worker.
2. If an already-launched V2 shell reports `metadata.status = running`, retain its shell ID and pending observation; do not write a terminal timestamp, success or failure. Expose a clear `do not start another Worker or run` action and report an unobservable terminal result as a blocker rather than inferring success from a receipt or dispatching a replacement run.
3. Tell Operator, Coordinator and Worker the precise foreground requirement in the shared operation guide. Keep the existing native-exit, declared-validation and independent-review requirements. This is lifecycle accounting, not a new security gate.

## Reproduction and verification

- The regression fixture uses the captured V2 metadata shape. Before the fix, the exact background command was admitted and the `running` launch was persisted with `completedAt` as an execution failure: two targeted tests failed.
- With the fix, the same Worker receives an actionable prelaunch correction; a legacy running launch remains pending across a cold state read. The existing foreground completion and `NO_START` cases still distinguish completion from setup. No new paid Anko inference, hidden/official grading or second score is part of this PR.
- Targeted test: `node --experimental-strip-types --import ./test/setup.ts --test test/mission-completion.test.ts` after `npm run build`.
- `npm ci` and targeted Windows build/tests succeeded. The first WSL full run found one existing guide-text assertion after the wording change; the wording was corrected without changing the runtime logic. Targeted `operator-mission` and `mission-completion` tests then passed 34/34.
- `npm run test:full` passed on a WSL Linux-filesystem snapshot (exit 0, source SHA-256 `01575498599cceaa9160167bd2846ff60669d7fdb410b4741cf83df2f89f3c10`). Afterward `npm run test:windows` passed 7/7. No extra paid CLI/Anko inference was used to validate this change.

## Follow-up, separate from this PR

The Anko comparison remains a single-run, non-causal observation; both versions ended with Reviewer `EVIDENCE_GAPS`. Focused original-file inputs/results for dynamic reassignment and nil handling, plus the exact parser generation command, are review-evidence candidates. They do not justify a new authorization step or a second benchmark run in this repair.
