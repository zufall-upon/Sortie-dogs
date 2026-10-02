# Continuous quality and native-execution loop (2026-10-02)

## Authority and fixed conditions

The user requested continuous reproduction, fixes, validation and incremental PR
updates without routine confirmation between iterations. Continue within the
existing product task, retain each candidate's source/package and observed costs,
and move to the next concrete failure after collecting a run. Main was checked at
cycle start: `b9b1246`; PR #152 is still open and already based on that main.

Worker remains Luna-fast/max; control/review remains SOL/xhigh. Major and Medium
review, same-native-author correction, independent initial Review and conditional
residual-Major-only second Review remain unchanged. Preserve original Anko task,
base and comparison conditions in fresh clones/private databases. The 25-minute
point remains observation only. Already-scored candidates remain frozen; subsequent
runs use new candidates. Release/main merge/global installation belong to the
separate release session.

The durable work queue and commands live under `_testenv/nightly-20261002/`.
Pending themes: public failure-result coverage, a fresh original Anko evaluation,
then real-V2 direct controller/multiple-unit execution. Diagnose subsequent concrete
failures rather than repeat unchanged failed runs or weaken acceptance.

## Cycle 1: public failure-result coverage

The previous native trace already showed the missed defect after initial Review
and same-author correction. A zero-model-request public-API reproduction against
frozen Anko `59fa8d902db71183de8241464ae6cf553464ba2e` confirms it independently:

- `node _testenv/nightly-20261002/reproduce-return.mjs`: exit 0, 2.578 s.
- Two ordinary/scoped assignments reject an incompatible value; error is present
  and the original binding remains 7, but the public return is the rejected string.
- Source was mounted read-only and remains clean at the scored commit. No overlay,
  candidate edit or regrading. Probe and command hashes/output are retained in
  `public-return-reproduction.json`.

Product change: lead behavioral Review with inspection of the public entrypoint's
existing tests and shared assertion helpers, then trace a rejected input back to
all caller-visible results. Make correction regressions distinguish old/new
behavior using actual assertions. Worker guidance also names the return/result
alongside errors and post-failure state. This is general test-oracle guidance,
not an Anko-specific expected value, new evidence format, second review or gate.
Keep Worker guidance within its existing size limits.

Effectiveness remains unproven until the next fixed-candidate native evaluation.

Validation progression:

- `npm run test:targeted -- test/validation-workflow.test.ts test/mission-review-replan.test.ts test/release-profiles.test.ts test/reviewer-correction.test.ts`:
  146/146 PASS, test phase 55.449 s. Generated Worker 2876 characters, common prose
  2391 characters: existing size limits retained.
- First `npm run test:full`: exit 1, 162.565 s including build. The asset-coexistence
  test still expected the previous Worker sentence; a repository search found the
  same obsolete assertion in `operator-mission.test.ts`. Updated both expectations;
  no production changes after that attempt. Logs/command/reason/source hash are in
  `_testenv/coordinator-direct/night-full-1.*`.
- Corrected-assertion focused run: 148/148 PASS, 10.981 s test duration.
- Second `npm run test:full`: **1597/1597 PASS**, all 101 files, no skipped,
  missing or duplicate files; exit 0, 198.960 s including build. Source snapshot
  SHA-256 `2162e50f4fce6f2178c7d39fb1276424bcc1937eb266434fff95c6d31edcce44`.
  Command/reason/output: `_testenv/coordinator-direct/night-full-2.*`.
