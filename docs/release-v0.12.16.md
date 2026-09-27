# v0.12.16 — Mission execution and focused review

- Preserve recent public request context in mission handoffs; record actual operation outcomes separately from setup, checks, and review. Preparation-only `NO_START` does not count as completion, while an executed operation with reward zero can complete.
- Recover foreground Worker lineage across cache expiry and release recoverable serial reservations. Accept focused, fresh original-file evidence instead of requiring generic coverage inventories or copied historical logs.
- Repair Advisor trigger admission and make model-route and named-release checks visible before a one-shot case-study attempt. Add a version-independent V2 fixture profile without changing the pinned v0.12.7 comparison.

This release does not rerun or officially score the existing benchmark campaign. The isolated real-V2 observations and their limits are recorded in the merged PRs and `docs/mission-operation-efficiency.md`; they do not establish full-task benchmark correctness.
