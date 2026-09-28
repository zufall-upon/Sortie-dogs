# v0.12.21 — Validation evidence and mission recovery

- Preserve successful validation evidence when a command changes only declared write-only outputs. Continue detecting changes to declared read inputs and binding the evidence to the complete resulting source and candidate.
- Diagnose shell pipelines, redirects and chained suffixes on declared operation launches before execution so the Worker can use the exact observable command. Clarify prelaunch checks versus postlaunch state checks and preserve independent review when operational risk remains.
- Reconcile an aborted V2 parent and its orphaned Worker reservation from native history before replanning a cancelled predecessor. Unproven lineage still blocks; acceptance and cumulative budget remain intact.
- Record the already-scored v0.12.19 and v0.12.20 SWE-bench runs with their fixed conditions. Those historical scores are not a v0.12.21 result; this release does not rerun inference or official grading.

The changed tests do not establish end-to-end recovery of an existing live Mission or a new benchmark score.

Runtime marker: `0.12.21-validation-recovery-v1`.
