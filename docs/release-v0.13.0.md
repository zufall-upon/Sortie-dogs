# v0.13.0 — Fast-first Mission and evidence continuity

- Route eligible single-unit Missions directly from Operator to Worker and, when warranted, to an independent Reviewer. Recover direct Worker validation failures and Reviewer findings within the same Mission; keep Coordinator dispatch available when actual coordination is needed.
- Preserve Reviewer lineage across cold turns, reject stale Review tasks, expose clipped source evidence before Reviewer dispatch, and focus findings on material defects. Accept grouped requirement-range traces without a formatting-only retry.
- Recover aborted Worker reservations, link replacements to the current cancelled run, and include project-internal dependency directory links in protected validation evidence while rejecting external links and cycles.
- Update the compatible `fast-uri` dependency lockfile entry and add Windows-only CI coverage.

The historical v0.12.24 Lite-300 campaign uses its own fixed package and is not a v0.13.0 result. Existing real-V2 trials and individual official scores do not establish a general speed or quality gain. The release CLI probe checks Worker startup and the observed models, not task completion or Reviewer PASS.

Runtime marker: `0.13.0-fast-first-v1`.
