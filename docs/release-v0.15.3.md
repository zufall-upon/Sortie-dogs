# v0.15.3 — Outward-link metadata in Review preparation

- Integrate #314's Review-only outward-link reporting. Retained external artifact scope can contain links outside declared physical roots without stopping before Reviewer Task creation. Record link identity, link text, canonical target and the reason its target was not inspected; never read or recursively traverse the out-of-scope target through those links.
- Keep an explicit uninspected-target count and representative paths outside the 24,000-byte source preview budget, so a full excerpt cannot hide that coverage limit. Link changes affect the Review fingerprint; uninspected target content is not claimed as reviewed or fingerprinted. An explicitly scoped target remains eligible for ordinary collection.
- Preserve strict default `declaredArtifacts`, formal validation snapshots and manifest/write gates. Actual writes through links outside declared write scope still fail. Existing internal, dangling and cyclic-link handling is retained.
- Align package/lock version, Mission marker and 15 current install pins across five guides. Preserve #311's tactical/bilingual reporting and prior release/test/migration evidence. Prior v0.15.2 npm version/latest/integrity/SHA-1 propagation is confirmed without repeating its accepted upload.

## Review and evidence boundaries

Before integration, collect the PR body, ordinary comments, review bodies and inline comments. The earlier independent Medium finding (uninspected coverage notice lost when the excerpt filled) is valid and already corrected with a retained regression. Final `SELF_RECHECKED` is author self-check, not independent PASS. Codex failed/usage-limit notices are unavailable external review, with no concrete returned code finding or independent PASS.

Reuse the final 43-pass focused Review check, two supplementary write-boundary checks and all four successful exact-head Linux/Windows CI checks. The artificial old broad scope plus new narrow proof fixture demonstrates public Reviewer Task creation, not recovery of the real KF1/Proton environment. The originally rejected link remains unidentified; a `z: -> /` analogue establishes the route, not that exact incident's link name. [Diagnosis and retained limits](review-external-link-fix-2026-10-30.md).

## Fixed release routine

Freeze one integrated main commit and tarball/SHA-256, then isolated candidate preflight, one mandatory full suite, exact-commit Linux/Windows CI and actual Terra/max Worker startup. Startup proves actual Worker/model identity only, not Mission completion or official scoring. Do not replay unchanged original Missions or restart stopped benchmarks.

Apply the identical archive to both existing npm global prefixes and the OpenCode config-local plugin dependency. Compare all regular package files and eight runtime assets, preserve explicit settings, then fixed tag, GitHub Release and `npm publish <tgz> --access public --tag latest`. Accepted publication is recorded once; registry propagation is checked separately without republish on a temporary 404. Retain logs, costs, review dispositions and identities in `_testenv/releases/0.15.3/`.

Mission marker: `0.15.3-external-review-links-v1`. Codex skill marker remains `0.14.6-codex-skill-v1`. Existing Mission state, cumulative consumption and unknown costs remain intact. No game/Steam/Proton/prefix/OS/driver/torch/ROCm/model environment changes, raw history edits or automatic shared-host restart. Manual OpenCode reload and actual saved-result Reviewer Task recovery remain separate, pending steps; disk installation alone does not prove the running host loaded this fix.
