# v0.14.2 — exact cold resume and owned-server exit

- Restore a retained Codex Coordinator when its parent Task item is missing, accept explicit failed receipts in completed parent turns, and return the same Task instead of waiting on an ended dispatch. CLI progress shows the restored Mission, Coordinator and next action (#268).
- Resolve both #268 P1 findings: recover nested Worker receipts before replacing the predecessor owner generation, and persist/verify the current Coordinator dispatch-to-native-message binding. Earlier terminal turns cannot settle a newer missing turn; existing terminal parent receipts retain their normal reconciliation path.
- End CLI probe settlement waiting when its owned server exits. Preserve the original CLI exit, server failure, first stop cause and unresolved usage reservation; intentional teardown is not reported as server loss (#269).
- Retain the [Codex Anko recovery record](benchmarks/codex-coordinator-cold-resume-20261016.md) and [interrupted Frontier run record](frontier-clean30-20261016-recovery.md). Their fixed runtimes, original results and limits remain historical measurements, not a new v0.14.2 benchmark score.

## Release verification

Fix the integrated `main` commit and one tarball before candidate preflight and `npm run test:full`. Check fixed-commit Windows CI and real native Worker startup/model identity. Use the same tarball for both npm global prefixes, the OpenCode config-local package, GitHub Release and npm publication. Command/exit/timing receipts, review dispositions, hashes and inference costs remain under `_testenv/releases/0.14.2/`.

Mission marker: `0.14.2-cold-resume-v1`. Codex skill marker: `0.13.11-codex-skill-v2`. Existing Mission findings, checks and cumulative spend remain intact. Restart OpenCode after global apply and verify the loaded runtime before continuing a retained Mission. Worker startup is distinct from Mission completion and official scoring.
