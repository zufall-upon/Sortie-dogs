# v0.14.7 — Visible same-Mission recovery

- Keep `operator_status`, `plan_units`, `cancel_operator` and `submit_mission` reachable when a direct unit's writer activation fails with `manifest-overlap` (#300). Management no longer depends on acquiring the conflicting artifact writer; actual artifact operations and successful completion retain their existing binding and validation checks.
- Hand off only the owner's quiescent direct unit while retaining its Mission, run, unit, reservation, checks and work. In-flight tools/binding prevent handoff, denied releases remain errors, and a live or unproven other owner is not evicted (#300).
- Explain the observed stop, retained results and next action in ordinary conversation. A normal affirmative response can continue authorized recovery without a hidden command, new Mission, budget reset or additional approval gate. Ordinary autonomous recovery still needs no new approval (#300).
- Prepare repository GitHub Sponsors metadata and a README support link; account approval/publication remains separate, not a claim that sponsorships are already active (#299).

## Retained evidence and boundaries

Before #300 integration, the PR body, ordinary comments, review bodies and inline comments were collected. Two automatic review failure/usage-limit notices are deferred external review with no concrete code findings, not independent PASS. Retain the separately reported final-head independent Reviewer PASS/no unresolved Major or Medium, the candidate targeted/full/Windows results and the isolated real-model recovery conversation without repeating inference. Final-head Linux/Windows CI was successful; CI is not finding resolution.

The reported real-model probe used Sol/xhigh and continued the same Mission/run/unit after an ordinary affirmative response, with an actual successful check and Mission receipt. It does not identify the original report's conflicting owner or establish recovery/completion of that original product task. Its estimated $0.2331232 (0 unpriced requests) is separate from the original implementation Mission's unknown cumulative cost.

## Release verification

Freeze one integrated `main` commit and tarball/SHA-256 before isolated candidate preflight and one mandatory `npm run test:full`. Verify exact-commit Windows CI and actual native Terra/max Worker startup. Reuse the retained recovery-specific conversation rather than replaying it merely for release. Startup smoke is not Mission completion, independent acceptance or official task scoring.

Apply the same archive to both existing npm global prefixes and the OpenCode config-local package, compare package files/runtime assets and preserve explicit user settings. Publish the fixed tag, GitHub Release and npm `latest` once; record command/exit/timing, costs and review dispositions under `_testenv/releases/0.14.7/`.

Mission marker: `0.14.7-visible-recovery-v1`. Codex skill marker remains `0.14.6-codex-skill-v1`; its files are unchanged. Attachment handling, ordinary Terra Standard/max defaults, other roles and explicit overrides are unchanged. No original Mission ledger edits, new benchmark or shared-host restart. Complete OpenCode restart remains manual to confirm the already-running host loaded the installed version.
