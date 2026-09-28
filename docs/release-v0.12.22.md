# v0.12.22 — Explicit mission replacement after acceptance failure

- Allow an explicitly changed Mission to retain its new requirements when replacing a cancelled predecessor whose acceptance failed. Do not reapply the old remediation contract to the new Mission.
- Preserve the existing same-goal remediation path and the checks for terminal child proof, residual repairs, git lifecycle, cumulative budget, archive and goal ledger. Failed prior acceptance is not carried forward as accepted evidence.
- Document the dev23 staged timeout correctly: a 20-minute progress checkpoint and a 40-minute hard maximum, not a fixed 40-minute run per case. The documented launch and handoff use the exact observable native command and check live state only after launch.

The regression tests do not establish that a paused real Mission resumed successfully. No new benchmark inference or official scoring is part of this release gate.

Runtime marker: `0.12.22-mission-replacement-v1`.
