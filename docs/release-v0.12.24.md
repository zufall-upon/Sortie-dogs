# v0.12.24 — Review evidence and Worker recovery

- Keep ignored in-project Go caches out of automatic Mission review excerpts while retaining declared result outputs and explicitly focused references in the review fingerprint. Report clipped focused ranges to the Coordinator before Reviewer dispatch so it can narrow them in place.
- Mark unreadable external runtime directories as uninspected in review packets and request specific readable result evidence instead of failing the entire preview. Readable outputs remain fingerprinted; protected validation and output proof remain strict.
- Clarify the existing root-only wait-or-stop/replan route when a Coordinator Task has finished but its Worker is still running. Do not dispatch a duplicate Coordinator or cancel a live Worker automatically.

These changes do not establish Reviewer PASS or completion of a paused real Mission. Historical benchmark observations are not a v0.12.24 score; no new benchmark inference or official grading is part of this release gate.

Runtime marker: `0.12.24-review-evidence-recovery-v1`.
