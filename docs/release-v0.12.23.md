# v0.12.23 — Mission budget and interrupted Worker recovery

- Allow the root Operator to extend the exact active Mission's cumulative Worker-unit limit after user approval. The original Mission and Coordinator continue; spent/reserved units and other budgets remain intact. Repeating the same limit does not add another revision.
- When an interrupted Coordinator still has a running Worker, return an explicit root-only cancellation and replacement route instead of asking the Coordinator to use an inaccessible tool. Keep the wait-if-live distinction and existing child-stop, ownership and cumulative-spend checks; do not cancel automatically or claim the replacement is the old Mission.

The regressions and release Worker-start probe do not establish recovery of a paused real Mission. No benchmark inference or official grading is part of this release gate.

Runtime marker: `0.12.23-mission-budget-recovery-v1`.
