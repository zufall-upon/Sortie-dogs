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
Completed themes: public failure-result coverage, fresh original Anko evaluations,
real-V2 direct controller/multiple-unit execution, retained host-card projection,
and inherited compiler-cache freshness. The current efficiency investigation is
first-draft omissions and expensive correction/test generation, not test execution
time. Diagnose concrete failures rather than repeat unchanged failed runs or weaken
acceptance.

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
The fixed v4 original-task attempt **did not complete the Mission**. All five native
sessions reached succeeded transport outcomes, but Operator explicitly returned
`TRUE_INTERRUPTION: internal:` at `2026-10-02T23:33:54.629Z`; receipt is absent.
Native launch→final terminal: **2601.378 seconds / $2.42897368**, 146 requests,
unknown usage 0. The same Reviewer repaired three Medium findings (Go pointer
writeback, channel-status assignment, oversized channel constructor) and returned
honest author `SELF_RECHECKED` twice. The first correction used a composite shell
command that the host did not recognize as the declared formal command; recovery
then ran standalone `go test ./...` with exit 0, but broad read inputs still included
inherited compiler-cache updates, leaving process-defect and no formal evidence.
No second Reviewer, source clean at `f0c2e0715de6bcf460726f77d1a7601355d5ef9b` on
`feature/typed-bindings`. No source/prompt/package change by the observer, no Anko
push/PR/publication, no resumed inference, **no semantic scoring performed**.

The original observer did not recognize native succeeded transport plus explicit
internal interruption while Mission phase remained submitted. It kept an idle
owned server after all inference had stopped. Read-only history and all 204
installed package hashes were retained/checked before stopping only that owned
server at `23:42:32Z`. The raw driver records `owned-server-exited`, 3120.205
seconds and exit 1; this includes **518.827 seconds of post-terminal observation**
and is not the native task latency. Both timestamps remain retained in
`native-interruption.json` and the raw result; no time/cost cutoff. No completion
tool/card exists in this original-task failure, so its projection result is
**not exercised**, not a PASS borrowed from the separate v4 direct probe.

Completed-attempt inference subtotal is now **$6.73286784 plus one prior
unknown-usage transport failure**. The v3 semantic score remains attached only to
its fixed product/package; the v4 semantic score is null/unscored, not zero or one.

## Cycle 4: inherited compiler-cache output falsely invalidates formal proof

While v4 continues under its unchanged fixed package, a read-only native snapshot
identified a concrete extra loop. The first Worker actually ran literal
`go test ./...` with host exit 0, call `call_HMIY0qclo3q95gNLoz3qnijh`. Its saved
native background owner record nevertheless contains `fresh:false`, empty
`scratch_paths`, and a whole-project read input. `GOCACHE` was explicitly set in
the inherited environment to the project's `.gocache`; 37 surviving cache files
have modification times inside that formal check's recorded interval. Source was
committed at `c980fc6`, native Worker succeeded, but the unit became process-defect
and Review was rejected as `mission-review-awaits-unit-validation`.

Operator then launched Coordinator, which replanned narrower inputs and sent
another Worker. That Worker made **no source edit and no new commit**; it inspected
the same implementation and reran focused/formal checks before Review could start.
The trace also retains the empty-replan-reason and copied-Task-hash errors; these
are not attributed to the cache mechanism. Live unknown-usage entries in the
snapshot are pending tool/model requests, not established transport failures or
completed-run costs. The v4 run, original source and prompts were not altered.

Separate offline reproduction uses a real Go test assertion, freshly empty
configured inherited caches, identical source/test bytes and model requests 0.
Broad project read: exit 0 but stale input digest. Focused source read: exit 0 and
fresh digest. After the next-candidate fix, both retain freshness with actual
compiler output, no synthetic cache writes and no source/test change. Native old
`fresh:false` evidence is kept unchanged; exhaustive native per-file before/after
hashes were not recorded, so the reproduction proves the mechanism rather than
claiming a complete retrospective source diff.

The fix captures configured inherited `TMPDIR`, `GOCACHE`, `GOMODCACHE` and Go
module-cache paths, respecting command overrides and pinning that environment.
A whole-project input no longer implicitly turns those compiler outputs into real
source. Explicit cache inputs, tracked files, exact deliverables and changed
source/configuration still invalidate proof. No filename/ignored/untracked heuristic,
new permission gate, approval, check weakening or retroactive old-proof exclusion.
Older recipes compare only their already-bound environment fields and keep their
original protected/scratch paths.

First focused verification: **68/68 PASS**; integrated focused verification:
**81/81 PASS**, exit 0, including same-original-Worker→Review without replacement,
unchanged evidence after cache cleanup, stale real-source rejection and v5 asset
coverage. `npm run test:full`: **1603/1603 PASS**, 101 files, exit 0,
**199.284 seconds**, no skipped/missing/duplicate files. Full source snapshot:
`ce1094145de7af3e373171395a6885fd7508bb0ea70bc50d730a78004dd860b2`;
subsequent updates are documentation only. The fixed native candidate was prepared
next; its original Anko result and semantic score are recorded below.
Tests and the separate Go replay
ran on the same host during v4 inference, a further limitation on timing comparisons;
the active arm's installed package is unchanged. The v5 change is not part of v4's
future semantic score or its projection measurement.

Evidence: `cache-freshness-reproduction-v2.json`, `cache-freshness-fixed-replay.json`,
`night-v4-cache-reproduction-2.*`, `night-v5-cache-focused.*` and
`night-v5-cache-focused-2.*`, `night-v5-cache-full.*`, and `night-v5-cache-replay.*`;
the initial compile-only reproduction remains retained
as superseded evidence, not substituted for the real assertion run.

### Cycle 4 fixed v5 package and next original-task run

- Product commit `9dd53119207671d42b00afcba4af71a609e880c1`, runtime marker
  `0.13.3-coordinator-direct-v5`; package SHA-256
  `dc8a08bac481dddf5752747a22c948cb443ecc7f0d8533c8d19e34eebc429ea2`.
- Fresh original 1825-byte task/base, private DB initially empty, 204 package files
  and eight assets match. Candidate preflight/baseline `go test ./...` PASS.
  Same model/review/common prompt conditions, no time/cost cutoff.
- Before inference, the observing-only driver was corrected to recognize an
  explicit native internal interruption only when every native session is
  terminal. Actual v4 history replay plus seven boundary checks PASS, model
  requests 0, no product/package/source/prompt change and no success promotion.
  The old raw driver result is retained, not rewritten. Driver/protocol hashes are
  fixed in `interruption-observer-proof.json` and the new launch record.
- Fresh v5 original-task inference launched with the fixed package; actual
  Luna-fast/max Worker and SOL/xhigh Operator verified at
  `2026-10-02T23:47:11.233Z`, private DB initially zero sessions. Root
  `ses_f00fcb9eeffeCfEnmhT29cpWVm`; Worker startup 29.120 seconds.
  Command: `node _testenv/nightly-20261002/run-cycle.mjs anko-nightly-cache-v5-package-20261003 anko-nightly-cache-v5-scoring-20261003`.
   It never repairs or rescores the frozen failed v4 source. At launch, native
   completion, same-Reviewer behavior, original semantic quality and any reduction
   in handoffs remained unproven for v5.

### Cycle 4 v5 result: completed original task and official score 1

The fixed `9dd5311` product/package above completed in **2036.360 s / $1.75883928**,
86 requests, unknown usage 0. Actual Luna-fast/max Worker and SOL/xhigh
Operator/Reviewer; all three native sessions succeeded. A genuine Mission succeeded
receipt was retained. Anko is clean at
`fcdb51d25763ea389061722d63b4902b85b7c32a`, branch `feature/typed-variable-bindings`.
These results belong to the fixed package, not a subsequent documentation-only head.

Pinned official local verifier: exit 0, **15.850 s**, **binary score 1, F2P 9/9,
P2P 94/94**. Source/commit remained clean and unchanged after scoring; no post-score
candidate edit, model request or verifier rerun. The failed v4 remains unscored.

Initial independent Reviewer found five Medium defects in Worker draft `8624a39`:
module-member assignment bypass, channel-status error suppression, Go pointer
writeback error suppression, declaration-time function option capture, and qualified
unknown-type diagnostics. The same native Reviewer reproduced all five with public
regressions, corrected them (including converted Go callbacks), ran formal
`go test ./...`, committed and returned `SELF_RECHECKED`. No second Reviewer and no
unresolved Medium. This is author self-recheck, not independent final approval.

Worker and correction Reviewer each ran the full formal command once. No replacement
Worker, extra Coordinator or product-tool rejection. The native read inputs were
narrow, so this run does **not** by itself establish the inherited broad-input cache
fix; the real-Go reproduction and regression above establish that mechanism.

Native completion history keeps the full **1222-character** host card in its
2421-character packet. Actual outgoing V2 context contains the 1350-character
projection without the card body; receipt hash and run/acceptance identities are
retained. Final assistant: 453 characters, no card transcription; final request
19.789 s / $0.074644. Rendered desktop/terminal card appearance was not inspected.

Compared with old mixed: -157.642 s (-7.19%), -$0.01725480 (-0.97%), both score 1.
Compared with Bare SOL: **+663.947 s (+48.38%), +$0.96980448, cost 2.2291x**, both
score 1. One sample per route, different implementations and findings; no causal
efficiency estimate. Completed-attempt priced subtotal **$8.49170712 plus one prior
unknown-usage request**. No active inference remains.

Evidence: the v5 arm's `comparison-summary.json`, `review-trace.md`,
`completion-projection-summary.json` and the scoring arm's `result.json`.

### Why the correction/self-recheck activity lasted 15 minutes

Calling the whole **937.896 s (15m 37.896s)** activity window "self-recheck" is
inaccurate. It includes fixing five defects, writing a new 229-line regression file,
extending boundary coverage, preserving public error compatibility and delivery.
The native correction made 19 SOL/xhigh requests, 14976 reasoning tokens and 9664
output tokens, cost $0.843328. Sequential observed phases:

- Contract rereads, design and initial regression generation: **405.957 s**.
- Initial red check, production correction and first green check: **132.225 s**.
- Expanded boundary regressions and public Error compatibility: **211.461 s**.
- Final focused/formal checks, interpretation and commit: **104.613 s**.
- Last author `SELF_RECHECKED` response: **83.640 s**.

Four test-bearing shell commands: one intentional red reproduction, two focused
green runs around source/test changes, and one full formal check. Native actual
execution intervals total **3.507 s**, including formatting/Git where composed.
Standalone final `go test ./...`: **0.593 s**. All tools' actual execution union:
3.974 s. Reducing test execution cannot recover minutes from this sample.

The remaining time includes model reasoning/argument output, provider latency and
host orchestration, not pure inference alone. In particular, tool `created`→`ran`
includes streamed patch argument generation and is not evidence of a host queue or
permission wait. Earlier self-review is embedded in correction; the last response's
83.640 s is not an exhaustive measurement of all self-review.

Avoid lowering effort or accepting unresolved Mediums. Next useful targets are
preventing first-draft omissions and eliminating redundant rereads/fragmented
correction work, with small distinguishing public regressions before the final full
check. Additional boundary coverage has a generation cost; its marginal value is
not established just because all tests pass. Timing evidence and command timestamps:
v5 `correction-timing-summary.json`, generated by
`node _testenv/nightly-20261002/analyze-correction-timing.mjs` (exit 0, no new models).

### Bare versus reviewed v5: concrete additional review value

`node _testenv/nightly-20261002/compare-bare-review-value.mjs`: exit 0. Same public-API
probe and Go toolchain on frozen Bare `8834b2c` and reviewed v5 `fcdb51d`; execution
2.279 s and 0.386 s respectively. These timings describe the diagnostic only, not
model performance. Both commits, clean status and tracked-byte SHA-256 remained
identical before/after. Model requests 0, official verifier reruns 0.

- Bare passes **7/9** selected cases; reviewed v5 passes **9/9**.
- Bare already handles four finding families: module assignment, channel-status
  failure, Go writeback failure and qualified unknown-type diagnostics.
- Bare fails two cases in the remaining family: define a function while enforcement
  is disabled, then invoke it with enforcement enabled, directly or through a Go
  callback. Both incorrectly accept the string and replace the declared integer.
  Reviewed v5 returns a positioned type error, nil result and unchanged binding.
- Bare passes the opposite enabled→disabled direction for both call paths.

Thus Review repaired five omissions in the mixed draft, but only one defect family
is an observed quality advantage over this Bare sample. The official score does not
cover every public behavior. These selected cases came from v5 findings, not an
independent exhaustive quality sample; they neither prove broader superiority nor
justify the observed +11m 3.947s / 2.2291x price by themselves. No scored candidate
was altered or re-inferred. Full observations and limits:
`_testenv/nightly-20261002/bare-review-value-comparison.json`.

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

Failed original-task v4 attempt archived at `2026-10-02T23:46:39.366Z` under the
same parent. True native-interruption record and raw delayed observer result both
retained, source/Git/private DB/package preserved, generated plugin/cache removed
only after owned-server/container/process inactivity checks.

- `anko-nightly-card-v4-package-20261003/attempt-evidence.tar`:
  `9387f5168a629992068814205dca41309805a662588e7f601814f687f97bfd68`.
- Its `product-checks-and-analysis.tar`:
  `398fc3e7e8ac4be2e82aa0d982a7c4e3421424e74c0c1e1a137ad72fa23a863b`.

Completed original-task v5 archived at `2026-10-03T00:35:37.352Z` under the same
parent. Retained result/root/package identities checked; owned server, containers
and project processes inactive before removing only generated `.opencode/` and
the arm cache. Source/Git/private DB/fixed package remain locally. The analysis
archive includes official scoring, public Bare comparison and correction timing.

- `anko-nightly-cache-v5-package-20261003/attempt-evidence.tar`:
  `1a88d9515bd182944d0a82a62ff61d9d2616c96336284c19d9184189865c05df`.
- Its `product-checks-and-analysis.tar`:
  `0b7fd675ea652a73bff131928b76d331bdf49fecab81944ca2f57a0c8e45fa4e`.

## Continuous Reviewer candidate v6: remove routine termination/re-dispatch

The user requested all known process defects be repaired and resubmitted continuously.
The v5 trace established a structural detour: initial Review ended with findings,
Operator issued a correction Task, and the same author reloaded a large Mission
projection even though its original reasoning and findings were already available.
The v5 timing analysis above does not establish a five-minute saving by itself.

Candidate marker `0.13.3-reviewer-continuous-v6` changes the first independent
source Review into one continuous native Task:

- Independently investigate Major **and** Medium material defects while read-only.
- Call `repair_review(findings)` to retain the actual pre-edit findings. The host
  binds the inherited scope, original requirements, ordered formal checks and
  requested Git delivery to a direct unit in this same native session. No new
  user prompt, Worker, interim findings terminal or Operator dispatch is needed.
- Correct, reproduce and validate there. `finish_direct_unit` proves only the
  current formal validation/delivery boundary, not Review or Mission acceptance.
- Explicitly compare the original contract, all findings and relevant impact,
  then return `SELF_RECHECKED` in the original native Task. Only that actual
  successful terminal and exact call/prompt/source/check identities record author
  self-recheck. It is never independent final PASS; unresolved Medium cannot pass.
- Retain Operator final comparison/acceptance and the residual-concrete-Major-only
  different-Reviewer route. Operations/read-only/second Review remain unchanged.

The correction handoff now includes `correction_context.findings` directly.
`retained_findings_ref` remains lineage only, not an instruction to print the
whole Mission, `corrections[]` or old prompt. During continuous correction a
stable context prefix retains the assignment through actual terminal, without
changing phase/counters or requiring another handoff read. Native SOL/xhigh and
Luna-fast/max selections and review effort are unchanged.

Lifecycle regressions cover no extra user prompt, automatic binding, actual
initial native call/prompt ownership, cold native Job reload before/after direct
validation, source freshness, failed checks, unresolved findings, read-only final
comparison, original-author continuation after incomplete correction and single
unit settlement. The new incomplete-terminal tests exposed incorrect direct
reservation release; settlement now records the actual author/cost rather than
pretending the direct call was a rejected child Task. Cancellation reproduction
also showed the still-running initial native Review was not stopped; both active
correction and cold post-validation self-recheck now stop the actual native child.
Current successful formal evidence is reused if only the final native self-recheck
is missing/failed; the fallback resumes the same author read-only, not a second
Reviewer or a validation-only unit.

Verification records are under `_testenv/coordinator-direct/`:

- `night-v6-inline-focused-5`: **155/155 PASS**; direct-settlement/recovery fix.
- First `night-v6-inline-full`: exit **1** after two outdated asset-text assertions;
  fail-fast run did not execute all 101 files and is not full-suite proof.
- `night-v6-inline-cancel-repro`: exit **1**, both actual native cancellation
  cases reproduced before correction.
- `night-v6-inline-focused-6`: **277/277 PASS** after native cancellation fix and
  compatibility-assertion updates; includes controller direct-work/generation
  and existing Reviewer/runtime routes.
- `night-v6-inline-focused-7`: **151/151 PASS**, final-native-only recovery.
- `night-v6-inline-full-2`: **1,614/1,614 PASS**, all **101** files, exit **0**,
  **202.163 s** including build; test phase 195.239 s. Source SHA-256
  `b0ca1054af727b13ab45ecdfe48f577b79695562d629fd00717de2ee85e0c4a7`
  matched before packaging. These unit fixtures do not complete Anko or establish
  a time saving.

Fixed product **`7f94d24eb3b7a919ef04f674c694236d48b2e34f`**, pushed to PR #152.
Fixed `.tgz` SHA-256:
`91a2837ad17c9da0dc02093561ddfd6ef41f034ece128cbc7fec40d52444ee0a`.
Installed **204** package files and **8** generated assets match; preflight and
unchanged-base `go test ./...` PASS. Fresh private DB has **0** initial sessions.
Arm `_testenv/anko-nightly-continuous-v6-package-20261003/` launched the original
1,825-byte request from the same pinned Anko base. At
`2026-10-03T01:33:52.038Z`, native Worker
`ses_f009aa1c7ffeoY8BjTVjEH47u5` actually started as
`openai/gpt-6-luna-fast#max`, with root Operator
`ses_f009b1d2affetCsDqT33QUc3PU` actually using `openai/gpt-6.1-sol#xhigh`.
This is start/model proof only; no completion, official score or saving claimed
yet. The owned driver queues post-completion scoring after native/source freeze.

The read-only observer supports actual continuous Review/direct-unit lineage.
Six observer-parser checks replay real v5 history and synthetic continuous-shape
fixtures; they use zero model requests and leave prior scored source unchanged.
Those fixtures are **not** native continuous-execution evidence. Fresh v6 private
DB/source/package will supply that evidence. Official hidden grading remains
post-completion only, after source is fixed, with no subsequent source edits or
re-inference. Whole-task target remains at most **1,736.360 s** against v5's
**2,036.360 s**, with score 1 and genuine receipt. No reviewer-only/overlapping
windows or time transferred to Worker count as whole-task saving. Release/global
apply/main merge and Anko upstream publication remain outside this session.
