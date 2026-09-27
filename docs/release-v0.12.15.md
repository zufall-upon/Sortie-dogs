# v0.12.15 — Reviewer recovery and model usage gauges

- Restore model-usage gauges in return reports when some host history or usage is missing. Recover recorded nested Task sessions and label measured-token shares as partial rather than erasing them or treating them as complete totals.
- Recover an independent mission Reviewer's completed initial review from paginated OpenCode V2 history when it falls outside the bounded context. Persist proven initial lineage; if unavailable, request an initial review rather than issuing a verification Task that the gate rejects. Previous findings are not a PASS for current work.
- Forward the supervisor timeout to the child runner and cover direct timeout/resume behavior (merged since v0.12.14).

This release does not complete or officially score the existing 23-instance campaign. Its stored two-batch result and unresolved pydicom single-instance score are unchanged; no benchmark is rerun as part of this release.
