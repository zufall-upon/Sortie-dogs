# Coordinator direct execution and avoidable round trips

## Scope

Base: `b9b1246` (main, v0.13.3). Restore the practical implementation,
correction and formal-validation responsibilities of the pre-v0.9 Coordinator.
Operator remains the user representative. Preserve same-native-Reviewer correction,
all Major/Medium remediation and the residual-Major-only second-review condition.
After integration checks, repeat the original Anko task with the established
Luna-fast/max Worker and SOL/xhigh control/review configuration in a fresh isolated
clone and private native database. Do not stop that run at the 25-minute observation
checkpoint. Release/global installation and main merge belong to another session.

## 1. Fixed authoring target and internal transport allowance

- Objective authoring guidance stays at 2,000 characters. The existing internal
  3,000-character allowance is retained but removed from model-facing instructions,
  status guidance and tool descriptions so it does not become the next target.
- A generated handoff includes the original request and host metadata, so its total
  JSON length is independent of the objective target. Larger original requests and
  overflow instructions remain verbatim; no new authoring threshold is introduced.
- Native `read.limit` counts lines. Explicit full-file ranges (including the observed
  `limit: 2000` on a one-line JSON file) now use the internal exact-value projection,
  bypassing native per-line character clipping. True partial reads retain their
  semantics and do not supply full-contract activation evidence.
- Stored contract bytes, hashes, legacy bounds and normal repository reads remain
  intact. Tests cover long late requirements, the explicit range, actual partial
  ranges, byte identity, native V2 activation, tamper races and cold resumes.

Validation: `npm run test:targeted -- test/native-contract-read.test.ts test/mission-fast-first.test.ts test/v2-plugin.test.ts`
— exit 0; build 6.759 s, tests 2.570 s, 59/59 PASS. Reason: regression of observed
contract clipping plus native admission and fixed-target compatibility.

## 2. Direct execution and native evidence

Coordinator retains native edit/write/patch authority. `plan_units(executor="self")`
starts work in that same controller session. `start_direct_unit` also takes an
already-planned or failed-Worker retry unit; `finish_direct_unit` settles only after
the existing ordered native-check and protected-source freshness verifier succeeds.
The original Reviewer correction owner remains unchanged. Direct work consumes the
same cumulative unit budget but does not fabricate a Worker Task/native terminal or
independent Review. The same root or Coordinator resumes after reload; cancellation
does not abort the root caller or require a fictitious child termination.

Tests exercise actual failing/passing shell checks, edit-after-check rejection,
saved observations after reload, cancellation/replacement, failed Worker to parent
correction/validation, initial independent Review and final Mission acceptance.
This is fixture coverage; the original Anko task remains a separate evaluation.

## 3. Avoidable transport and presentation work

- `start_mission(unit=...)` uses the existing plan path in the same call when one
  useful unit and its formal check are already known. The returned Task retains the
  configured Worker model; the separate planning call remains available.
- Native formatter plus exact Git add/commit no longer revives an unrelated shell
  executable-allowlist ambiguity. Existing Git argument and staged-path checks remain.
- Active Worker status tells the owning Worker to continue its current Task, rather
  than instructing it to dispatch another Coordinator.
- At unit settlement and final acceptance, one read-only host Git status records
  the actual HEAD, branch, clean flag and observation time. These facts travel in
  Task/status/acceptance packets even when no host-managed Git lifecycle exists.
- Completion cards retain host-authored data in the tool result; the model is no
  longer instructed to transcribe the whole card into its final response.
- Initial read-only Reviewer instructions describe the available read/search tools
  and unavailable shell; correction keeps its restored native shell access.

## Validation progression

All commands below ran on Linux. No additional model inference during these checks.

- Direct-execution development found two actual integration gaps (activation root
  recovery and use of a process-defect-only evidence recovery path). Both were fixed
  using existing native observations. A fixture cached-state read was also corrected.
- Six-file targeted suite: build exit 0; tests 176/177 PASS,
  10.971 s, exit 1. The remaining assertion expected the removed Coordinator edit denial.
- Five-file targeted suite after delivery/cancellation changes: build 6.783 s;
  tests 153/161 PASS, 10.810 s, exit 1. Fixed absent-observation comparison and the
  cancellation fixture's use of progress rather than full budget status.
- `npm run test:targeted -- test/mission-direct-execution.test.ts test/v010-runtime.test.ts`:
  build 6.759 s; tests 123/123 PASS, 10.454 s, exit 0.
- Five-file targeted suite after combined start: build 6.681 s; tests 24/27 PASS,
  1.299 s, exit 1. Three assertions expected missing Git observation. Updated them
  to assert the actual host-observed commit/branch/clean state.
- `node --experimental-strip-types --import ./test/setup.ts --test test/mission-fast-first.test.ts`:
  10/10 PASS, 1.347 s, exit 0. Only tests changed since the preceding build.

## Full-suite verification

First full-suite attempt (`npm run test:full`): exit 1, 102.357 s, source fingerprint
`95fed5329118191af2e0e65b9fef40f4bc49391787874c86ae3561120e929c73`.
The runner stopped on two remaining old unknown-Git assertions in
`test/anko-recovery.test.ts`. Updated to assert real observed Git status and preserve
the failed-commit dirty-state check. No production change after that full attempt.

Second full-suite attempt: exit 1, 137.617 s, source fingerprint
`a42bebfa3c80bd0ecd471319f72c45c9f77fe1ed2179fd46ead37d19fa9d4821`.
The release-profile assertion retained the old asset marker. Updated that expectation
and current-marker guide text to `0.13.3-coordinator-direct-v1`. Historical release
notes retain their published marker. Remaining tests are checked before the next full run.

Remaining-file scan: 836/838 PASS, 55.507 s, exit 1. Two obsolete assertions remained:
the old separate-start wording and the assumption that every `read.limit` makes a
request partial. Updated them to cover combined start, full line-range projection,
and a genuinely partial range. Production source is still unchanged since full-1.

Final verification:

- Focused Reviewer/asset verification: **259/259 PASS**, exit 0, 54.947 s.
- `npm run test:full`: **1597/1597 PASS**, 101 files, zero skipped, exit 0,
  **199.734 s** including build (test phase 192.807 s). Scheduler reports no
  missing or duplicate files. Source snapshot SHA-256:
  `241c293d4bc4340ccb516992a8b05deb5bb2a5eb8c82ff622f7f0bcedefcf77a`.
- All source/test/config files still match that snapshot. Only documentation
  changed afterward. `git diff --check` passed.
- Logs, commands, exit, elapsed time, reasons and per-file source hashes:
  `_testenv/coordinator-direct/{full-1,full-2,remaining-1,focused-2,full-3}.*`.

## Remaining sequence

1. Fix the commit/package hash and repeat the original Anko task in a fresh clone and
   private DB with the established mixed model configuration, then grade the fixed
   completed Anko commit with the retained verifier and record the comparison.
2. Product PR and persistent evidence archive. Main merge/release remain separate.

The historical investigation and fixed prior candidates remain in
`/home/user/Sortie-dogs/_testenv/anko-pr149-ubuntu-20261001/`. No additional model run
has been launched during step 1.
