# v0.12.25 — Mission continuity and usage diagnostics

- Relink same-turn Mission replacement to the latest cancelled run. When a saved replacement points to an older run, expose the mismatch and the in-place `start_mission intent=replace` repair route without repeating Worker dispatch or losing cumulative spend.
- Observe root-owned V2 Worker attempts separately from outer benchmark attempts, and avoid redispatching an unchanged process defect without diagnosing its proof route. Do not mistake custom-container output for native formal validation.
- Prepare explicitly declared, absolute project-local `TMPDIR` directories before dispatching a newly planned Worker; report unavailable setup without rejecting the plan.
- Persist bounded, structured diagnostics for V2 usage records that cannot be priced. Unknown spend remains unknown; cost limits and stop behavior are unchanged.

These changes do not establish successful completion of the historical Anko attempt or change the frozen v0.12.24 SWE-bench score. Release CLI validation confirms only actual Worker startup and observed model unless a separate result proves more.

Runtime marker: `0.12.25-mission-continuity-v1`.
