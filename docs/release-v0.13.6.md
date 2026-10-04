# v0.13.6 — Reuse recorded acceptance evidence

- Integrate PR #156. Acceptance summaries reference recorded `formal_validation` evidence when a successful unit's PASS proof covers every declared command, rather than fetching and duplicating native history merely for display. Failed/incomplete units retain the native-history diagnostic path. Historical proof remains historical; the projection establishes neither current freshness nor acceptance.
- Share identical external artifact inventories between source/candidate hashing within one `refreshProtectedSnapshot` call. Discard the memo on return; later calls still observe edits/deletion. Different external path sets, logical paths, digest recipes and review/completion guards remain unchanged. No persistent freshness cache is added.
- Replace two existing Operator instruction lines with a direct acceptance path when current evidence covers the request and no concrete gap remains. Preserve existing validation freshness, Review and final acceptance requirements; no new role, review stage or per-turn instruction section.
- Synchronize package/lockfile, English/Japanese/Chinese guides and Mission marker to `0.13.6-acceptance-reuse-v1`. Existing `v010` profile/command names remain compatible.

## Scope and limits

The Windows v0.13.5 audit observed file verification followed by two failed unsupported `--version` checks, then a valid Coordinator verifier and an Operator artifact reread. This was not three repetitions of the same successful verifier. This release removes redundant acceptance-history retrieval and a narrow duplicate inventory traversal, not the earlier CLI-check mistake.

Provider/model selection and cache-prefix machinery are unchanged. The normalized instruction-source size decreased by four UTF-8 bytes in the PR; live tokens/cache-hit rates and end-to-end speedup were not measured. No general speed, quality or provider-cache claim is made. Historical benchmark results remain attributed to their fixed candidates, not v0.13.6. A post-integration dev23 evaluation is separate from this release gate; it is not performed here.

## Release verification scope

Fix the integrated main commit and one tarball before candidate preflight and `npm run test:full`. Verify that commit's Windows CI and real native Worker startup/model identity. Use the same fixed tarball for all global/config-local installs, GitHub Release and npm publication. Receipts, hashes, timings and costs remain under `_testenv/releases/0.13.6/`. Startup is not task completion. Installed bytes/asset marker do not prove an already-running OpenCode process loaded them; complete OpenCode restart remains required.
