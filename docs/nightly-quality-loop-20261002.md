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
Completed themes: public failure-result coverage, a fresh original Anko evaluation,
and real-V2 direct controller/multiple-unit execution. The next observed inefficiency
is model re-generation of the retained host completion card. Diagnose concrete
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

Fixed native candidate:

- Product commit `a0c82e57e7244c2adeec14c9a536f38fff0f6e7d`.
- Package SHA-256 `e779647bf5261c9183eec9953408117bc6221788b7d88c2cc81ea77a8c96ba62`.
- Runtime marker `0.13.3-coordinator-direct-v2`; installed 204 package files and
  eight assets match the fixed package.
- Fresh original Anko clone/private database, zero initial sessions; original
  task 1825 bytes and base `3f269a72ff69398b1250c584171f32d12c0d8085` retained.
- Preflight exit 0, 5.644 s; baseline `go test ./...` exit 0, 5.576 s.
- Started via `node _testenv/nightly-20261002/run-cycle.mjs anko-nightly-quality-v2-20261002 anko-nightly-quality-v2-scoring-20261002`.
  The wrapper launches native inference and only after successful terminal
  completion invokes the pinned offline verifier. No time/cost cutoff.
- Native startup observed at `2026-10-02T12:55:30.387Z`: root
  `ses_f0351658affelI5alHAC3o77ZW` actually used SOL/xhigh; Worker
  `ses_f0350ec4dffe3s5n5sxvBfK8Z6` actually used Luna-fast/max. Startup
  evidence is `actual-worker-start.json`; terminal results follow below.
- Prepared a separate two-unit native direct-Coordinator fixture with the same
  package and its own initially empty database. Preparation is not execution
  evidence; native launch/result will be recorded separately.

### Cycle 1 result and observed limitation

Native completion: 1881.045 s, $1.83757332, 80 requests, unknown usage 0. Worker
Luna-fast/max, Operator and the initial/correction Reviewer SOL/xhigh throughout.
Anko branch `typed-variable-bindings`, clean final commit
`4ec2864a89823a61f41ed800a86f5069ecbfe0c1`; genuine Mission succeeded receipt.
Initial Reviewer found four Medium defects: invocation-option capture, native
pointer writeback, channel-status error suppression and unknown qualified types.
The same native Reviewer added public regressions, observed failure twice, fixed
the defects, ran `go test ./...`, committed and returned `SELF_RECHECKED`.
No second Reviewer. The 25-minute checkpoint continued execution.

Pinned official local verifier: exit 0, 15.645 s; **binary score 0**, F2P 5/9,
P2P 94/94. Failed groups remain declarations, representative flows, error return
value, and scoped/control-flow assignments. Final source remains frozen/clean.
Compared with the previous direct-v1 run: +506.625 s (+36.86%) and +$0.68787792
(+59.83%), no score improvement. Compared with old mixed: -312.957 s (-14.26%)
but +$0.06147924 (+3.46%), score 1 to 0. Each is one sample, not a causal estimate.

The new evidence rules were actually followed for retained findings, but did not
validate the test oracle. Worker commit `eee284d` already asserted that rejected
ordinary assignment returns its RHS (`vm/vmTypedBindings_test.go:49-54`). Initial
Reviewer read that file and the pre-existing public helper `vm/main_test.go`, yet
retained the assertion. Correction tests at lines 279-288 and 303-308 then asserted
the rejected RHS too; the final self-recheck explicitly calls that behavior fixed.
Other correction tests correctly require a nil result for invocation/unknown types.

The unchanged public helper checks `RunOutput` even on error (`main_test.go:199-218`).
Pre-existing type-rejection examples such as `vm_test.go:197-212` use its default
nil output. This makes the next concrete improvement test-oracle independence:
distinguish pre-existing public expectations from tests added alongside the new
implementation, and compare analogous failure paths before endorsing a new result.
Adding assertions alone can encode the defect. Do not prescribe a language-specific
return value or change the scored candidate. Trace is retained in
`_testenv/anko-nightly-quality-v2-20261002/review-trace.md`; costs, comparison and
native outcomes in `comparison-summary.json`.

The separate direct-controller probe started after Anko completed. At
`2026-10-02T13:28:02.460Z`, native Coordinator `ses_f0333bf59ffeEQ36kTJrUSnB2o`
actually used SOL/xhigh and owned direct `unit-1` under root
`ses_f033431e3ffeC6OleTcsrA4X0Q`.

### Native direct-controller result

**PASS**: 278.110 s, $0.33391280, 30 requests, unknown usage 0. Same SOL/xhigh
Coordinator owned both sequential direct units. For each, the real declared check
failed before editing and passed after the fix; the second check covered both
requirements. No implementation/validation Worker. Two saved `direct_execution`
attempts have formal evidence and no fabricated child-terminal records. Initial
independent Reviewer PASS, Coordinator ready submission and Operator genuine
Mission succeeded receipt; all three native sessions succeeded.

Final clean commit `868d54174ce12a0f633807e5c7b764619ef5e84c` on
`diagnose/direct-controller-76d4f137`; all three check-file hashes unchanged.
An observer-side `node check-all.mjs` also passed after measurement. Native source,
states, checks and model/receipt records: `_testenv/nightly-direct-native-20261002/`.
This verifies the two-unit same-Coordinator direct route, not Anko quality or native
root direct/cold-resume/cancellation/failure-from-Worker paths.

## Cycle 2: independent test expectations

Public-only read-only diagnostic on frozen cycle-1 Anko: exit 0, 0.616 s,
zero model requests. Pre-existing incompatible indexed assignment returns nil
with an error; analogous new typed assignment/declaration returns the rejected
string. Commands and output: `_testenv/coordinator-direct/night-oracle-probe.*`.

Replace, rather than stack, the behavioral guidance: independently establish the
oracle from pre-change analogous public tests and shared-helper defaults; treat
tests added with the patch as claims to review. Reuse the established harness for
small distinguishing regressions, and do not make expected results agree with
current code merely to obtain green tests. No universal failure-result value,
new evidence packet, mandatory review round or runtime gate is introduced.

First focused check found an obsolete reproduction sentence assertion and Worker
prose length 2406 vs the existing 2400 limit. Restore the original reproduction
reporting sentence and shorten the new wording; preserve the existing thresholds.

Corrected focused suite: 153/153 PASS, test 10.871 s; generated Worker 2876,
common content 2455 and prose 2391 characters. Full integration (`night-v3-full`):
**1597/1597 PASS**, 101 files, no skipped/missing/duplicate files; exit 0,
199.113 s including build. Source snapshot SHA-256
`3c53658ce61b5130f1563af356d252c4a9fb30d511afd9f3ecba32f201b4c779`.
Main was fetched again before cycle 2 and remains `b9b1246`.
Nightly measured inference total after cycle 1 and direct probe: **$2.17148612**, unknown 0.

Cycle-2 fixed candidate and launch:

- Product `8b536aa4bd25bd197c1c6de4961f7c284b79af61`; marker
  `0.13.3-coordinator-direct-v3`.
- Package SHA-256 `3840ca2e5cda118bc9c4878bb99b5afc025c4815b29cb0e3e492f16b59775574`.
- Fresh original Anko clone/private DB; 204 package files/eight assets verified.
  Preflight exit 0, 5.640 s; baseline `go test ./...` exit 0, 5.571 s.
- Launched with `node _testenv/nightly-20261002/run-cycle.mjs anko-nightly-quality-v3-20261002 anko-nightly-quality-v3-scoring-20261002`.
  Same task/base/common prompt, Luna-fast/max Worker and SOL/xhigh control/review
  policy. No timeout/cost cutoff. Wrapper fixes the native terminal candidate before
  scoring and does not modify/re-prompt it after grading. Terminal results follow below.

### Cycle 2 result: original Anko passes

**Official local binary score 1, F2P 9/9, P2P 94/94.** Fixed verifier exit 0,
15.379 s; no failed tests, model requests 0, final source still clean/frozen at
`c103668da55cb958a45c13236abd8adc0231082d`, branch `feature/typed-variable-bindings`.
Native measurement `2026-10-02T13:38:52.387Z` to `14:12:51.968Z`: **2039.581 s**,
86 requests, priced **$1.80364484 plus one unknown-usage request**. All three native
sessions succeeded and the true Mission succeeded receipt was observed. Actual
Worker Luna-fast/max; Operator/initial/correction Reviewer SOL/xhigh, mismatches 0.

Worker used the pre-existing `runTests`/`Test` public harness for typed declarations
and rejected assignments (`vm/typed_bindings_test.go:59-101`). Its first implementation
commit `5f23ad3` already cleared `runInfo.rv` on incompatible assignment. Thus the
old four failing semantic groups were addressed before Review, not by a new grader
hint or post-score repair. Reviewer found three Medium defects (Go pointer copy-back,
channel status assignment and qualified unknown types), reproduced them with existing
harness assertions, corrected and formally tested them. Same-author self-recheck
then found/reproduced a concrete catch-visible error-type incompatibility in its own
fix, corrected it and reran `go test ./...` before the second correction commit.
No second Reviewer and no unresolved Medium. Self-recheck remains author verification,
not independent final PASS. The final full check was an actual native exit 0.

Measured actor windows (not pure inference, overlapping control window): Worker
660.428 s / $0.19951124; initial Review 297.778 s / $0.30125760; correction
940.603 s / $0.90585680 plus unknown usage; Operator $0.39701920. One correction
request failed `provider.transport: WebSocket closed with code 1006`, 33.250 s,
without tokens/usage. The same Reviewer continued; this duration remains in the
measurement and no zero price or complete-cost comparison is claimed.

Compared with old mixed (score 1), measured time -154.421 s (-7.04%); priced
subtotal +$0.02755076 before the missing usage. Compared with direct-v1 (score 0),
time +665.161 s (+48.40%), priced subtotal +$0.65394944. Every candidate is one
sample; these deltas do not establish prompt changes as the sole cause. Native
direct implementation was not used in this Anko route; the separate two-unit
probe above proves that route only.

Through cycle 2, completed-run priced subtotal **$3.97513096 plus one unknown-usage request**, including
both original Anko runs and the separate direct probe. Costs, request error, native
models/terminal outcomes and review/correction traces are retained in the arm's
`comparison-summary.json`, `finish-analysis.json` and `review-trace.md`.

## Cycle 3: avoid model re-generation of the host completion card

Cycle-2 final Operator request spent 35.091 s / $0.085442 and returned 1731 visible
characters, including the exact 1283-character `return_report` from complete_mission.
This is model-authored native assistant content: the V2 finalizer observes accounting
without persisting replacement output, and profiled text-complete returns early for
the Operator. The final response still copied the card despite the no-transcription
instruction. The entire final-request cost is not a card-only cost or guaranteed
saving. The card's pre-final cost $1.6915 also differs from the $1.8036 subtotal
observed at final native completion; its existing caveat is retained.

Next change: preserve the full card in native tool history/UI, but remove only its
presentation body from the outgoing V2 model context. Keep status, receipt, run and
acceptance identities, all evidence and limitations; provide a compact indication
that the full card is saved in that tool result. No synthetic message, extra model
turn, acceptance bypass or change to user/source/review messages. Confirm the real
2.0.18 request shape before implementation, then exercise a new fixed native probe.

Implementation uses the published V2 context/compaction hooks, after checking
`@opencode/plugin@2.0.18` and `@opencode/ai@2.0.18`'s `Message`/`ToolResultPart`
types. Only successful `sortie_v010_complete_mission` tool-result cards are
projected; JSON, text and text-plus-file results preserve all other data. The
request-only clone preserves the Message prototype and identifiers. Native history,
tool output and user/assistant content are untouched. The regression checks both
hooks, idempotence, files, malformed/error/blocked results, evidence and metadata.

Focused validation (`night-v4-focused`): 62/62 PASS, test phase 2.672 s;
full integration (`night-v4-full`): **1598/1598 PASS**, 101 files, exit 0,
198.021 s including build; skipped/missing/duplicate 0. Source snapshot SHA-256
`e7eb58d66fec44b414b7cd813ee4ef9f11dac1156bb485d98c33de75be76d6a3`.
Pure replay of the passing frozen arm's native completion packet: saved result
2557 to model projection 1330 characters, full native packet and receipt unchanged,
zero model requests. This replay is not live hook or measured savings evidence.
Native probe
preparation adds an observing-only plugin: retain the context draft, inspect it at
`model.request` after all context hooks, and record only card-presence, receipt hash,
identity and size. It changes neither prompts nor requests. Compare that actual
outgoing request with saved native completion-tool and terminal-assistant content.

### Cycle 3 native direct probe: observed projection and no re-transcription

Fixed product `12ec5defb9ceba3682e3e523b965eba8a89abf6f`, marker
`0.13.3-coordinator-direct-v4`, package SHA-256
`49a799dce6fbd004b8ede303c6f1cdcef68d5fb39253ddcc09fe05938b34d4d5`.
Installed 204 files / 8 assets match. Separate private native DB starts with zero
sessions; actual same Coordinator SOL/xhigh direct activation was recorded, not
inferred from configuration. Original Anko is not this diagnostic's task.

Native completion **PASS**, 255.017 s / **$0.32876320**, 33 requests, unknown 0.
Two units in the same Coordinator, each actual failed check then exit-0 check,
Worker absent, initial independent Reviewer PASS, all three native sessions
succeeded, genuine Mission succeeded receipt. Unchanged check hashes, clean source
`9cf97f820b3a1bad729005952e3156e0c86b7a0d`, branch
`diagnostic/direct-controller`; no push/publication and no product tool errors.

The final model request actually received the projected successful completion
packet (tool-result `text`), without `return_report`, with its retained marker,
identical receipt SHA-256 and unchanged run/acceptance identities. Native tool
history still stores the full **1109-character** card in its 2307-character packet.
The terminal assistant contains **267 characters**, no card heading or exact card,
and reports outcome/checks/independent Review/diagnostic limits. Final request
11.247 s / $0.046764. No extra model turn was added for presentation.

The prior direct-v2 probe used the same normalized prompt and initial file/check
hashes. Its final request 31.817 s / $0.053330 / 1422 visible characters copied the
1127-character card. Observed deltas: final request -20.570 s / -$0.006566;
whole diagnostic -23.093 s / -$0.00514960, but request count **+3**. Each is one
sample, different execution times and product guidance also changed; no causal
saving or general reliability conclusion. Preserved native tool content is proven;
rendered desktop/terminal card appearance was not directly inspected. The card is
now retained in the completion tool result, not duplicated in final assistant prose.

Completed-run priced subtotal **$4.30389416 plus one unknown-usage request**, before
the new original Anko run. `completion-projection-summary.json`,
`paired-card-probe-comparison.json`, `native-direct-summary.json` and actual
request-observer records retain projection, provenance, measurements and limits.

### Cycle 3 original Anko: same fixed package launched

Fresh original 1825-byte task/base and private native DB, same unchanged common
prompt/model/review policy, package above; preparation/baseline PASS. The additional
plugin only observes outgoing context and does not edit requests or tool results.
Its source hash is fixed in `request-observer-provenance.json`. Actual Worker
Luna-fast/max and Operator SOL/xhigh started, recorded at `2026-10-02T22:51:08.594Z`,
initial sessions 0. No timeout/cost cutoff; 25 minutes is an observation checkpoint.
Source will be fixed at native completion before the official local verifier runs.
Original Anko result and semantic score for v4 are **pending**; the v3 score is not
reused as evidence for this changed candidate.

## Retained archives

Both stopped native environments were archived on `2026-10-02T13:33:56Z` under
`/home/user/Sortie-dogs/_testenv/anko-pr149-ubuntu-20261001/nightly-quality-20261002/`.
Package SHA-256 and retained native root identity were checked before removing
only the generated `.opencode/` and cache directories. Source/Git and private DBs
remain locally; source/Git/native histories/fixed package and analysis are archived.

- `anko-nightly-quality-v2-20261002/attempt-evidence.tar`:
  `7f7371941e53b7cbc0defa7695b0e71ebb6b7942c43db8c785be20fba0988e2c`.
- Its `product-checks-and-analysis.tar`:
  `9e8357892994da44076ce82158be1908ac18a4a48bd55d777731045494967d00`.
- `nightly-direct-native-20261002/attempt-evidence.tar`:
  `07da0a61b68fac6757951522cf6d6743095371cb45d924cf147356bf2d262799`.
- Its `product-checks-and-analysis.tar`:
  `b24d440dcd36ef9860208bdae4b0f67e6c9ae634030b7944c6b8efb52543e2bd`.

These archives predate the cycle-2 full check and retain their as-of contents.

The completed cycle-2 passing arm was archived at `2026-10-02T22:35:51.083Z`
under the same parent directory, then only inactive generated plugin/cache paths
were removed. Source/Git and private DB remain locally.

- `anko-nightly-quality-v3-20261002/attempt-evidence.tar`:
  `f2499e1e5e7434e60d7cc83fb9b3b87dccebb2a97cc1ae0c508bee4fc1e91583`.
- Its `product-checks-and-analysis.tar`:
  `04e11f9f5e3c47f5277bf6d4a3c377f45ef0f9f6fd7d26c65792470ab49d10b6`.

Cycle-3 native direct probe archived at `2026-10-02T22:50:55.492Z`, verified
package/result identity and inactive owned container/processes before removing only
generated `.opencode/` and cache. Source/Git/private native DB retained.

- `nightly-card-native-v4-20261003/attempt-evidence.tar`:
  `1465f1d0314bca131a503419df78d3a4abd1ff6a1be84d2d36a39973cc4808ae`.
- Its `product-checks-and-analysis.tar`:
  `d6568d0a1146a07d4e3db9f26fac39ce0d6ca41dfdf60d851c274d954623f658`.
