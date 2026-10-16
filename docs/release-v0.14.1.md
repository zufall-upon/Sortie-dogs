# v0.14.1 — retained Mission continuation

- Recover initial-review lineage across verification findings, cold reload and legacy overwritten receipts. An unused inline correction grant no longer makes a non-writing Reviewer an author; actual or uncertain writes retain self-recheck handling (#266).
- Return the existing Coordinator's authorized continuation with the proposed correction, reconcile terminal native Tasks, and preserve pending-Reviewer wait guidance without starting a concurrent writer (#263).
- Accept a refreshed, unique final validation check without replaying an unchanged successful prefix; preserve source freshness, exit and binding checks (#265).
- Restore public schema/registry/caller guidance for related type families in Coordinator and Reviewer assets (#264).
- Record the released v0.14.0 dev23 result: official resolution **10/23 (43.48%)**, Mission completion **22/23** (#262). These historical results do not measure v0.14.1.

## Release verification

Fix the integrated `main` commit and one tarball before candidate preflight and `npm run test:full`. Check Windows CI for that commit and observe real native Worker startup/model identity. Apply the same fixed tarball to both npm global prefixes and the OpenCode config-local package, then use it for GitHub Release and npm publication. Retain hashes, command/exit/timing receipts and inference costs under `_testenv/releases/0.14.1/`.

The Mission runtime marker is `0.14.1-review-continuation-v1`; the unchanged Codex skill marker is `0.13.11-codex-skill-v2`. Existing Mission findings, validation evidence and cumulative spend remain intact. Installed bytes do not prove an already-running OpenCode process loaded the fix: restart OpenCode, verify the loaded runtime, then resume the retained Mission review. Worker startup is not Mission completion or an official benchmark score.
