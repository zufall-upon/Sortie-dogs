# Coordinator direct execution and avoidable round trips

Follow-up: [continuous nightly loop](nightly-quality-loop-20261002.md) records
the later direct-v2 score-0 result, **direct-v3 original Anko score 1 (F2P 9/9,
P2P 94/94)**, and successful real-V2 two-unit same-Coordinator direct execution.
The passing Anko run took 2039.581 s, priced $1.80364484 plus one unknown-usage
transport failure. The fixed results below retain their original candidate identities;
subsequent test-oracle changes and complete retained evidence are tracked there.

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

## Fixed candidate and original Anko launch

- Product commit: `f5c758c5d4e1165dccd066ee2157d439386f5402`.
- Fixed package SHA-256:
  `5239eae736031916e0bc38da8bc8d938f423f87adb5e070f02daff39536f9a55`.
- Runtime marker: `0.13.3-coordinator-direct-v1`. Installed 204 dist files and
  8 assets matched the archive. Isolated preflight exit 0, 5.615 s; baseline
  `go test ./...` exit 0, 5.547 s. These are preparation checks, not task completion.
- New private native DB began with zero sessions. Only the authorized provider
  credential was provisioned from the retained pinned empty schema.
- Actual Operator: `openai/gpt-6.1-sol#xhigh`, root
  `ses_f0391a3c8ffeMohjTiQbMSpCrw`.
- Actual Worker: `openai/gpt-6-luna-fast#max`, child
  `ses_f03913660ffetRfvfjmmNAC6Sb`, started 27.656 s after inference launch;
  observed `2026-10-02T11:45:17.447Z`. Startup proof is not completion.
- Original task/base/environment/review conditions retained; no time/cost cutoff.
  Run command: `node _testenv/anko-coordinator-direct-20261002/container-command.mjs run`.
- Evidence: `_testenv/anko-coordinator-direct-20261002/actual-worker-start.json`,
  `candidate.json`, `installed-build-match.json`, `run-1/`.
- Product PR: <https://github.com/zufall-upon/Sortie-dogs/pull/152>.

## Original Anko result: faster workflow, failed quality score

The fixed candidate completed the workflow in **1374.420 s (22m 54.420s)**,
**$1.14969540**, unknown usage **0**. Measurement starts at inference launch
`2026-10-02T11:44:46.808Z` and ends at the last native completion observation
`2026-10-02T12:07:41.228Z`; preparation and grading are excluded. No time or cost
stop occurred. Usage-based prices exclude parent development and subscriptions.

- Final Anko commit: `59fa8d902db71183de8241464ae6cf553464ba2e`, new branch
  `typed-bindings`, clean. Initial Worker commit:
  `1e0d9cd2a629228cd336e88d0f0b1ae4c391c33e`.
- Actual model requests: 70 (Operator 14, Luna Worker 38, initial Review 7,
  same-native-Reviewer correction 11). All models/variants match the fixed policy.
- Three native sessions ended successfully. Mission receipt has `status=succeeded`,
  `stop_reason=completed`; host Git observation records the final branch/HEAD/clean.
- Worker corrected an initial `go test ./...` failure, then passed the same check.
  Reviewer correction also ran the actual project-root `go test ./...`, exit 0.
- Initial Review found three Medium defects: channel OK-target assignment errors
  were suppressed, Go pointer-writeback errors were overwritten, and unknown
  qualified declarations used the wrong error contract. The same Reviewer fixed,
  validated, committed and returned `SELF_RECHECKED`. No reported unresolved
  findings or residual Major; no second Reviewer. This is author self-recheck,
  not independent final PASS.

Post-completion local replay of the unchanged pinned official verifier returned
**binary reward 0, F2P 5/9, P2P 94/94**. Command:
`node _testenv/coordinator-direct/score-anko.mjs`; verifier exit 0, 15.931 s,
no timeout. Exit 0 means grading completed; auxiliary partial 0.9611650485436893
does not mean the candidate passed. Protocol/image/verifier hashes are the same
as the [prior comparison](anko-three-route-investigation-20261002.md).
The candidate remained clean at the same commit after grading; no candidate
edits or additional model inference followed it.

### Observed comparison

- Prior mixed: 2194.002 s / $1.77609408 / reward 1. Current delta:
  **−819.582 s (−37.36%), −$0.62639868 (−35.27%)**, reward **1 → 0**.
- Prior single SOL: 1372.413 s / $0.78903480 / reward 1. Current delta:
  **+2.007 s (+0.15%), +$0.36066060 (+45.71%)**, reward **1 → 0**.
- Current stage windows: Worker **626.875 s / $0.15326380**;
  initial Review **194.665 s / $0.23648720**;
  correction **436.257 s / $0.42745800**;
  other elapsed **116.623 s**. Operator total **$0.33248640** overlaps those
  windows and must not be added as another time stage.
- Against prior mixed, stage reductions are Worker 44.293 s, Review 138.118 s,
  correction 576.166 s and other 61.005 s. Most observed time saving is in the
  correction window, with different patches and three rather than five findings.
  One later sample does not causally attribute those savings to product changes.

Original task SHA-256, normalized common prompt, review policy and pricing-module
hash match both comparison baselines. This run does not establish quality
improvement or successful Anko acceptance against the official tests.

### Which workflow changes were actually exercised

- Combined `start_mission(unit=...)` used; root invoked 10 tools in total, with no
  separate `plan_units`, source reread or root Git shell call.
- Both generated handoff reads received the exact full-contract projection.
  This run used default Read ranges, so explicit-limit behavior remains covered
  by tests rather than this particular native trace.
- Initial Review used read/search without searching for an unavailable shell.
  Its only recorded tool error was a nonexistent `vm/vmChan_test.go` search path.
- Formal correction and inline self-recheck stayed in the original Reviewer;
  host-recorded Git delivery facts reached acceptance and the completion card.
- **Direct execution and a child Coordinator were not used.** Root/Coordinator
  direct execution, cold resume and cancellation have fixture coverage, but this
  Anko sample does not supply real-model coverage for those paths or multiple units.
- No combined formatter/Git command occurred; its fix has regression coverage,
  not a demonstrated native invocation in this run.
- The saved final response still includes the full return card. The completion
  result explicitly told the model not to transcribe it, but the saved rendered
  message alone does not distinguish transcription from presentation processing.
  Final request: **28.771 s / $0.07317000**. Elimination of final-card cost is
  therefore not established. Card figures are pre-final-response estimates;
  use the measured whole-run cost above for comparison.

### Remaining semantic defect

All four failed F2P groups concern a stale return value on typed assignment error:
`TestTypedBindingsDeclarations`, `TestTypedBindingsAdditionalRepresentativeFlows`,
`TestTypedBindingsErrorReturnValue`, and `TestTypedBindingsScopeAndControlFlow`.

In `vm/vmLetExpr.go:16-19`, `SetValueWithTypeCheck` returns an error and the
identifier branch sets `runInfo.err` without clearing `runInfo.rv`.
`vm/vmStmt.go:49` then returns the stale RHS alongside the error. For example,
`var x: int64 = 10; x = "hello"` returns `"hello"` where the verifier expects nil.
This path is unchanged between the initial Worker commit and final correction.

Candidate tests at `vm/vm_typed_bindings_test.go:83-100` check the error and
preserved binding but discard the public return value. Review explicitly had
instructions to consider return value, error and post-failure state together;
the relevant source was available, yet the gap survived. This is the same missed
error-return family as prior all-SOL, now in assignment rather than declaration.
No corrected candidate, overlay experiment or regrade is claimed for this run.

Next quality-improvement target: make existing public failure-result behavior
part of concrete regression evidence, without weakening review or encoding hidden
Anko cases. A separate real-V2 direct-execution probe is still needed to establish
that restored controller path in practice; this result must not be relabeled as it.

## Evidence and handoff

Run/comparison records: `_testenv/anko-coordinator-direct-20261002/`, especially
`comparison-summary.json`, `run-1/final-result.json`, `run-1/observation.json`,
`run-1/session-history.json`, `run-1/mission.json`, and `run-1/cleanup.json`.
Scoring protocol, fixed patch, result and test logs:
`_testenv/anko-coordinator-direct-scoring-20261002/`.

Persistent archive:
`/home/user/Sortie-dogs/_testenv/anko-pr149-ubuntu-20261001/coordinator-direct-20261002/`.
It retains source/Git, native history, fixed package, commands, test snapshots,
cost records and grading evidence. The private native DB stays at its original
local path. Only generated plugin/cache directories are removed after confirming
shutdown and archiving. Product code remains at the evaluated candidate; later
commits record results only. Main merge/release remain separate.

Archive completed `2026-10-02T12:21:29.177Z`:

- `attempt-evidence.tar` SHA-256:
  `a806d9b8d21f83616dce708826fbed24c934ab6e8303bd4911f954d8d381fc28`.
- `product-checks-and-scoring.tar` SHA-256:
  `5c7c324ef23ff95451c682cafa376edb1d61781867a576f69682a1ef0bf61bff`.
- Fixed package hash matched after copying; archived native root identity matched.
- No owned server/container or process using the Anko project remained. Removed
  generated `anko/.opencode` and isolated npm cache. Source/Git and private DB retained.
- Final updates are documentation-only, so the passing fixed-candidate full suite
  remains the relevant verification; no redundant full-suite rerun was performed.
