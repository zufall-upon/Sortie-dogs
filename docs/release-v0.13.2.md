# v0.13.2 — Mission lifecycle and contract recovery

- Integrate #146: reconcile missed native Task completion against the existing Mission, exact child and reservation; preserve cumulative accounting without promoting failed execution into successful acceptance evidence.
- Repair concrete write scope in the same Task, unit and child. Preserve host permissions, explicit user prohibitions, active writer ownership and rollback on storage failure; no extra approval or replacement Worker is introduced.
- Retain validation-time scratch/environment recipes, protect newly materialized deliverables and avoid retroactively weakening legacy evidence. Preserve objectives, original requests, negative constraints and confirmed runner/budget/grading facts in handoffs while reducing duplicate prompt context.
- Repair Worker tool exposure and isolated V2 CLI service credentials. Synchronize the Mission asset marker to `0.13.2-anko-recovery-v1`.
- Commit the requested chat-only tone guidance and `/genshijin` command, and retain the independently scored v0.13.1 dev23 result in the README. That historical 8/23 result is not a v0.13.2 benchmark claim.

The release gate fixes the main commit and one tarball before candidate preflight and full tests, checks Windows CI for the fixed commit, and observes real Worker startup and actual model identity. Startup is not task completion or Reviewer PASS. The canonical historical Anko runner remains unavailable; the bounded recovery fixtures do not establish its completion or official score. No new SWE-bench campaign or general quality/speedup claim is part of this release.
