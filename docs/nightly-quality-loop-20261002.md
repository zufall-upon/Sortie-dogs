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
inherited compiler-cache freshness, and continuous Reviewer correction. The fixed
v6 original-task sample below observes a 644.715-second saving with official score 1,
but later unchanged public probes pass only **5/9** (v5 **9/9**). The time saving
is real on that sample; preserving known public quality remains **unmet**. This
is a single-sample result, not established merely by product unit checks.
Diagnose concrete failures rather than repeat unchanged failed runs or weaken
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
This observation is start/model proof only. Completion and post-freeze official
scoring from the owned driver are recorded below.

The read-only observer supports actual continuous Review/direct-unit lineage.
Six observer-parser checks replay real v5 history and synthetic continuous-shape
fixtures; they use zero model requests and leave prior scored source unchanged.
Those fixtures are **not** native continuous-execution evidence. Fresh v6 private
DB/source/package supplied that evidence below. Official hidden grading remains
post-completion only, after source is fixed, with no subsequent source edits or
re-inference. Whole-task target remains at most **1,736.360 s** against v5's
**2,036.360 s**, with score 1 and genuine receipt. No reviewer-only/overlapping
windows or time transferred to Worker count as whole-task saving. Release/global
apply/main merge and Anko upstream publication remain outside this session.

### v6 original-task result: 644.715-second whole-task saving observed

Fixed product `7f94d24`, package SHA-256
`91a2837ad17c9da0dc02093561ddfd6ef41f034ece128cbc7fec40d52444ee0a`:

- Whole native workflow **1,391.645 s** / **$1.26273448**, **82** requests,
  usage unknown **0**. Original request/common prompt/pricing matched v5.
- Versus fixed v5: **644.715 s (31.66%) faster**, **$0.49610480 (28.21%) lower**.
  The 300-second timing goal and unchanged official score are observed on this
  original-task sample, not by adding overlapping actor windows or shifting work.
  Later public probes below show known quality is not preserved, so the combined
  quality-and-saving objective remains unmet.
- Final Anko **`1abf91ab1dee0ba124fbf4334f2f42ddc4f53e07`**, new branch
  **`feature/typed-bindings`**, clean. Worker/Reviewer/root each have their actual
  native `succeeded` terminal, with a genuine Mission succeeded receipt.
- **Official local score 1, F2P 9/9, P2P 94/94**. Fixed verifier exit **0**,
  **15.589 s**, post-completion only. Source/commit/clean remained unchanged;
  no post-score candidate edits or model requests. Score belongs to this fixed
  v6 package, not the subsequent docs commit or any v7 follow-up.

Actual continuous Reviewer `ses_f0090094effeYWZhEQdqpC0dPZ` had **one** native
user prompt. Its initial Task call `call_A7j5JIuD7GQ4qyCNDY6XW1m0` and prompt
`msg_0ff6ff6b8002zlaxq5e0raxNM4` also own the real final `SELF_RECHECKED` message
`msg_0ff78f83c001pBd8UL7Gyjt2U3`. Direct correction has a distinct direct-unit
settlement, not an invented native child terminal. No correction re-dispatch,
handoff/Mission reread, second Reviewer, extra Coordinator or validation Worker.
No product-tool refusal in the Reviewer. Worker and Reviewer each ran formal
`go test ./...` once. Expected focused regression failures preceded actual fixes.

Independent Reviewer retained four concrete Medium findings: reflected interface
initializers, channel receive-ok assignment error suppression, Go pointer writeback
error suppression, and qualified unknown-type diagnostics. During correction it
also independently reproduced named-vs-unnamed reflected type acceptance, fixed
it, and explicitly self-rechecked all five. No unresolved Major/Medium or concrete
residual Major. This is author self-recheck, **not independent final PASS**.

Measured activity windows, **not additive/causal components**:

- Whole Reviewer investigation/correction: v5 **1,221.142 s** → v6 **619.164 s**,
  difference **601.978 s**.
- Correction activity: v5 **937.896 s** → v6 **448.592 s**. v6 has 18 responses,
  6,381 reasoning / 5,289 output tokens; five test-containing commands execute
  in 4.687 s total, all actual tools union 5.023 s. Final author response 29.137 s.
- Worker: v5 **711.912 s** → v6 **668.036 s**, difference **43.876 s**.
  The whole-run saving therefore is not explained by a faster Worker alone;
  actor windows still include model/provider/host gaps and can overlap.

Different first drafts, finding sets and provider timing remain confounders. One
sample per candidate does not establish a reproducible or isolated causal effect.
Compared with Bare's fixed official-score-1 sample, v6 is still **19.232 s
(1.40%) slower** and **$0.47369968 (60.04%) more expensive**. Native continuous
execution and lack of handoff rereads are directly observed mechanisms, not a
claim that all elapsed-time difference came from those mechanisms.

Completion projection also exercised: full 1,226-character card retained in
native tool history; actual outgoing result 1,350 characters without card body,
with identical receipt identity. Final assistant 453 characters, no card
transcription. Final request 11.880 s / $0.087674, not a card-only cost measure.
Desktop/terminal card appearance remains uninspected.

Evidence: `continuous-review-analysis.json`, `correction-timing-summary.json`,
`comparison-summary.json`, `completion-projection-summary.json`, raw native
history/private DB and scoring `result.json`. `finish-analysis-audited.json`
corrects an old analyzer's unconditional unpriced-request caveat: v6 has **0**
unknown requests; fixed-table usage estimate is not a billing invoice. Raw
native/grade evidence remains untouched.

The same native trace exposed the next narrow product defect: a second
`repair_review(findings)` call during running correction returns the original
findings and does not append the newly submitted Medium finding to the retained
correction list. Its full text is still in the native tool input and its fix is
in the scored Anko source, so v6 completion/score remain genuine; nevertheless
continuity/compaction should retain the full known finding set. Fix only product
finding accumulation in the next candidate, preserving this scored source,
single Task, existing scope/checks/budget and terminal acceptance semantics.

Completed v6 archived at `2026-10-03T02:07:12.912Z` under the same retained
`nightly-quality-20261002/` archive parent. Actual owned server/container/project
processes inactive, package/result identities checked before removing generated
`.opencode/` and arm cache only. Source/Git/private DB/fixed package remain local;
source/Git/native history and scoring/check/analysis artifacts also archived.

- `anko-nightly-continuous-v6-package-20261003/attempt-evidence.tar`:
  `0cb2b8971a35ac2fffb8f7e1dafea83c6840bdc3fdf35387066105304d972313`.
- Its `product-checks-and-analysis.tar`:
  `e94ee87c58fb33d006c68afc4cccefdf1d1e4691fe07b43fdaf021c37595e268`.

### Post-score public-probe addendum: known v5 quality not preserved in v6

`compare-bare-review-value.mjs anko-nightly-continuous-v6-package-20261003
bare-review-value-v6-comparison` replays the **unchanged** public API probe used
for v5 (`b45d25b39fb462688334fa174b2008743dba57405c9993fa53fed73ba0935e53`).
It adds **0** model requests, official verifier runs or candidate edits; both
scored source trees/commits/clean states remain byte-identical before and after.
Probe process exits 0 because it reports outcomes; that does **not** mean all
cases pass.

- v6 **5/9**, prior v5 **9/9**, Bare **7/9** on these selected public cases.
- All four v6 caller-option cases fail. A function created with enforcement
  enabled incorrectly retains enforcement when called with it disabled; a
  function created with enforcement disabled incorrectly remains dynamic when
  called with it enabled. Direct Anko calls and Go callback calls both reproduce.
- Concrete source cause: the retained function in `vm/vmExprFunction.go` builds
  its call execution with creation-time `runInfo.options`, instead of the
  current public invocation's setting. The original request explicitly makes
  enforcement optional and otherwise assignments dynamic in any scope. This
  is a concrete public contract defect, not an exhaustive hypothetical matrix.

The official score **1**, genuine receipt and **644.715 s** saving remain genuine
observations for immutable v6. They do **not** establish original-task completion
quality across already known public behavior. The stronger five-minute goal with
that known quality remains **unmet**. Preserve the frozen source rather than
repair it after scoring. Before sending the next candidate, add general
implementation/Reviewer guidance to trace a per-call setting across retained
object/closure creation and use when the actual changed source carries that
setting; test the concrete boundary through the established public harness.
Do not inject these Anko-specific inputs/expected values or hidden grading into
the next run, add a separate Reviewer, reduce effort or require a large matrix.
`bare-review-value-v6-comparison.json` is a later retained addendum, not contained
in the earlier immutable v6 archive hashes listed above.
Separate retained `public-probes-addendum.tar` SHA-256:
`0cf4233f82e022354f443e0135ca66d4cf3065390d4cb2a769535a583ab68c55`.

## v7: retain additional findings in the running continuous correction

The actual second v6 `repair_review` tool input exposed a retained-findings bug.
`night-v7-findings-repro` reproduces it against fixed v6 runtime: exit **1**,
**1.408 s**, all three live/cold/native-failure-continuation cases lose the new
concrete finding. No model requests or changes to the scored v6 source.

Candidate marker `0.13.3-reviewer-continuous-v7` appends genuinely new supplied
findings to the current exact author's durable correction and returns the entire
retained set immediately. Identical body/header-only retries do not duplicate
findings. Existing serialized native dispatch, actor/call/prompt/run identity,
unit, reservation, scope, initial independent report/identity and immutable
handoff/check contract remain unchanged. A later failure continuation receives
the full cumulative set in its correction context, not a Mission reread.
Outgoing continuous context reconstructs all currently known findings, including
after cold reload. Only new actual findings change that content; routine phase,
budget counters and validation settlement still do not. This is not a synthetic
independent Review and does not relax fresh formal checks or final acceptance.

- `night-v7-findings-focused`: **161/161 PASS**, existing correction/generation/
  marker regressions plus live, cold reload and failed-native continuation.
- `night-v7-findings-focused-2`: **3/4 PASS**, exit 1. New concurrency assertion
  wrongly required Promise input order rather than actual native-hook arrival
  order. Product retained both findings correctly; production unchanged.
- `night-v7-findings-focused-3`: **4/4 PASS**, concurrency assertion corrected;
  verifies serialized exact full submissions, owner/generation binding and
  harmless empty/header-only retries. No added approval or independent Reviewer.
- Integrated full verification of the accumulation change was already running
  when the public defect above was reproduced. Fold the related generic
  lifecycle guidance into the final candidate and verify that integrated source
  before a **new** fixed-package original-task run. Prior v6 official score/saving
  are never attributed to this unscored
  candidate. A fresh native run must explicitly report whether additional
  `repair_review` calls occur; unit fixtures alone are not native coverage.

The accumulation-only full run `night-v7-findings-full` completed **1,618/1,618
PASS**, all **101** files, exit 0, **202.399 s**. Its snapshot predates the
newly reproduced lifecycle guidance, so it is not the final integrated package
proof. Worker now has a compact, general current-vs-captured-setting cue;
Reviewer shared behavior guidance asks for the concrete public creation/use
boundary only where actual changed source and the requested contract make it
relevant and existing tests do not cover it. It explicitly excludes a lifecycle
matrix and includes disabled behavior. No Anko syntax/type/expected value,
hidden grader, model effort change, extra approval or Reviewer is added.
Compact equivalent Worker prose offsets the cue while retaining the existing
3,000-character asset and 2,400-character common-prose bounds. Capability,
scope/check order, Git delivery and final acceptance are unchanged.
First `night-v7-lifecycle-focused`: **304/306 PASS**, exit 1; compacted opaque-path
wording no longer matched an existing asset assertion, and common Worker prose
was 2,413 characters. Restore the original opaque-path sentence and shorten only
the new setting cue, retaining the **2,400** bound rather than moving it.
The owned next-run driver now queues the same read-only public probes after
source freeze/official scoring, so official score and selected public quality
are reported separately without new model input or candidate edits.
`night-v7-lifecycle-focused-2`: **122/122 PASS**, exit 0; installed Worker
**2,881** characters, common body **2,459**, prose **2,395**. The original bounds
and opaque-path guidance now pass. Final integrated full verification follows
before source/package freeze and original-task resubmission.

`origin/main` was re-fetched before this cycle and remains
`b9b1246fd04eb4c18142ac8861e94a809394280d`; no main integration/release/global
apply performed here.

### Final v7 integrated verification, fixed package and original-task launch

`night-v7-integrated-full` / `npm run test:full`: **1,619/1,619 PASS**, all
**101** files, exit **0**, **203.145 s**. Full source SHA-256:
`1db4631fb3a72b37039014e54dd8a5be8c82c5252d43d35c717c1c19a61ee4b6`.
All source-file hashes matched at pack time before any later docs-only edit.

- Product **`16bc9b18da989126dbf977dad61c07aafafae421`**, pushed on the existing
  PR branch; marker **`0.13.3-reviewer-continuous-v7`**.
- Fixed package SHA-256
  **`244846386c9eff58e01fc130165b509fc35a518e3bb419343aa09e9ddba39327`**.
  All **204** installed files and **eight** runtime assets match this package.
- New isolated original Anko clone/private DB; exact 1,825-byte original request
  and base `3f269a72ff69398b1250c584171f32d12c0d8085` unchanged. Private DB
  initially **0** sessions, shared DB/service untouched. Preflight/base formal
  `go test ./...` exit **0**, no inference during preparation.

Original-task launch command, without `tee`/redirection or new cutoff:

```sh
node _testenv/nightly-20261002/run-cycle.mjs anko-nightly-continuous-v7-package-20261003 anko-nightly-continuous-v7-scoring-20261003
```

Started **2026-10-03T02:27:57.414Z**. Read-only actual startup proof at
**02:29:21.094Z** records root `ses_f00691126ffekgdGuIye6sp6Ma` using
**`openai/gpt-6.1-sol#xhigh`** and real native Worker
`ses_f0068ad1fffeG69CC4jvsSHN0c` using **`openai/gpt-6-luna-fast#max`**.
Worker starts **25.299 s** after the measured launch; no model mismatch.
This is startup proof only: no completion, score, public-quality or new saving
claim. Snapshot pricing/unknown counts are provisional while requests run.
Owned driver continues through native terminal/source freeze, then unchanged
official local scoring and the separate read-only public probes. Active package,
prompt, source conditions and effort stay fixed; 25 minutes remains observation
only. Evidence under `anko-nightly-continuous-v7-package-20261003/` includes
`candidate.json`, preparation/build-match/private-DB proofs and
`actual-native-start.json`. Release/global apply/main merge/Anko publication
remain outside this session.

### v7 result: public probes recovered, official VM tests did not build

Immutable product `16bc9b1`, package
`244846386c9eff58e01fc130165b509fc35a518e3bb419343aa09e9ddba39327`:

- Native workflow **2,025.980 s / $1.71414528**, **117** requests, unknown **0**.
  Actual Worker Luna-fast/max, Operator/Reviewer SOL/xhigh; all three actual
  native sessions succeeded, genuine Mission succeeded receipt.
- Final Anko **`8fc43546802cbdf12dc8226b2488169c17d08808`** on
  **`feature/typed-bindings`**, clean. Source/request/base/pricing conditions
  matched; scored source remains fixed and unchanged after public probes.
- Official local **score 0, F2P 1/9, P2P 94/94**, verifier exit **0**,
  **14.413 s**, no timeout. Eight VM F2P entries are **missing/unexecuted**,
  not eight observed behavioral assertion failures: VM package build failed.
  Exit 0 means scoring completed, not benchmark success.
- Same unchanged selected public probe **9/9** (v6 **5/9**, v5 **9/9**, Bare
  **7/9**). All four caller-mode cases now pass. No model requests, official
  verifier reruns or candidate edits from these probes; this is not an exhaustive
  public quality claim and does not replace the failed official result.
- v5 whole-run difference **10.380 s (0.51%) faster**, **$0.04469400 (2.54%)
  lower**. Versus v6 **634.335 s slower**, **$0.45141080 more**. Quality-preserved
  five-minute objective remains **unmet**, not rescued by public probes or receipt.

Original Reviewer `ses_f00596717ffePd4YJ6WFXaFHLn` has **one** native user prompt;
initial call `call_4urOaEuPAxm2jduBArVcb8xW` / prompt
`msg_0ffa698f0001KdzB6NT6GfbgyC` also owns final self-recheck
`msg_0ffb4419700191DjgZYYxQnRak`. Actual continuous correction/direct settlement,
no correction redispatch/Mission or handoff reread/different Reviewer/validation
Worker. Initial three Medium findings: caller-mode propagation, channel receive
error propagation and Go pointer writeback errors. Reviewer corrected/rechecked
those and investigated callback/generated-assignment failure paths during repair.
No unresolved finding was reported at terminal; later build-composition failure
is nevertheless real. This remains author self-recheck, not independent PASS.
Only **one** `repair_review(findings)` call occurred: v7's additional-findings
accumulation fix is verified by fixtures but **not exercised natively here**.

Activity windows, not additive/causal timing components:

- Worker **978.494 s**, v5 **711.912 s**: **266.582 s slower**.
- Complete Reviewer **960.297 s**, v5 **1,221.142 s**: **260.845 s shorter**.
  Correction **784.462 s**, 26 responses / 9,482 reasoning / 9,976 output
  tokens; nine test-containing commands execute in **8.509 s**, all tool
  execution union **9.036 s**. Final author self-recheck response **65.326 s**.
- Worker formal `go test ./...` **twice**: a concrete original-requirement
  unknown-type diagnostic omission was found/edited after the first successful
  formal run. Second run was required fresh evidence, not an unchanged gratuitous
  rerun. Reviewer formal test once. Move requirement reconciliation before final
  formal checks; do not waive necessary fresh checks after later edits.
- Final assistant **461** characters, saved card **1,228**, no card transcription;
  final request **13.912 s / $0.073376**, not a card-only cost measurement.

Build-composition diagnosis uses a **declaration-name intersection only**, not
private test bodies or expected values. The candidate itself declares generic
package-level `TestTypedBindingsDeclarations`; a same-package evaluation entry
collides. The original scorer filters Go `build-*` JSON events, so its retained
log shows build failure but not the compiler explanation. Public-only reproduction
in a separate archived-source fixture proves the package mechanism:

- Candidate public tests alone, `go test ./vm -run '^$'`: exit **0**.
- Add an empty public test with that existing candidate entry name: exit **1**,
  actual compiler **redeclared** diagnostic.
- Give only that empty fixture entry a distinctive name: exit **0**.

No repaired official result is inferred and the original grader is not rerun.
Native candidate source/Git/clean hashes unchanged. The reproduction helper first
failed on its default `git archive` buffer and an incorrectly equal project/TMPDIR
root; corrected only its fixture setup before the passing collision reproduction.
Private bodies/expected values, exact evaluator test entry names and Anko-specific
oracles are not supplied to future inference. Next product guidance favors existing
suites/subtests or distinctive new entry names for same-package composition,
without new gates, test matrices or validation Workers. A new concrete defect
found while correcting should be retained via the existing same-Task route,
not silently left only in the conversational trace.

Evidence: `continuous-review-analysis.json`, `correction-timing-summary.json`,
`worker-efficiency-diagnosis.json`, `finish-analysis.json`,
`build-collision-diagnosis.json`, `public-test-collision-reproduction.json`,
`anko-nightly-continuous-v7-package-20261003-public-probes.json`, fixed official
`result.json` and raw native history/private DB. Completed-attempt priced subtotal
**$11.46858688 plus one historical unknown-usage request**; v7 unknown 0.

v7 archive completed **2026-10-03T03:09:16.166Z** after inactive owned server,
Docker and project-process checks. Removed only generated arm `.opencode/` and
cache; fixed package, scored source/Git, private DB and native evidence remain.
Same retained archive parent as v6:

- `anko-nightly-continuous-v7-package-20261003/attempt-evidence.tar`:
  `39059f54d2cfa02e9296c78f16db7ec707dbf2a29ee6efc7528548dae6d95215`.
- `product-checks-and-analysis.tar`:
  `a89fef1e7ac6fc2cdef35aacdbe4d417d7cca3b3ae469593f230055bde0ba60a`.

## v8: general regression composition and final-check preparation

The next product candidate retains all v7 runtime behavior, caller-mode review
guidance and model effort. Marker `0.13.3-reviewer-continuous-v8` changes guidance
only around the actual v7 defects/detours:

- Prefer existing suites/subtests, or distinctive regression test entry/helper
  names that compose with other same-package files. No evaluator identifiers,
  private bodies, expected values, build tags or test deletion/renaming recipe
  are inserted into assets, Mission prompt or original task.
- Reconcile the original requirements and diff before focused/final formal
  checks. This addresses the actual late Worker unknown-type fix; fresh affected
  and required broad checks after later edits remain mandatory when the contract
  or host freshness requires. No old evidence is accepted after new source.
- If the same continuous Reviewer discovers another concrete Major/Medium while
  correcting, retain it via existing `repair_review` before fixing it, in that
  same native Task. No new handoff, scope, contract, independent Reviewer or test
  Worker; no extra call when no new concrete finding exists.

Equivalent Worker wording is compacted without changing the original prose
bounds or removing the original-request/scope/opaque-path/reproduction/Git/
cumulative-budget boundaries. Source-level common body **2,462**, prose **2,398**;
installed-asset checks follow. This is general process guidance, not proof that
another original-task sample will pass or be five minutes faster.

Main re-fetched before this cycle, still `b9b1246`; scored v7 source/package
remain frozen. Related targeted checks, one final integrated full verification,
then a new fixed-package fresh-clone/private-DB original-task resubmission follow.
Official result and unchanged selected public probes remain separate, post-freeze
only; no grader modifications or scored-candidate re-inference.

`night-v8-guidance-focused`: **125/126 PASS**, exit 1. The unchanged reproduction
boundary was compacted to `Keep reproduction entrypoint/input/layout`; one older
asset assertion accepted only its verbose wording. Keep the product guidance
unchanged and accept either exact equivalent preservation form in that assertion.
New naming/requirements/additional-findings tests passed; installed Worker
**2,884** characters, common body **2,462**, prose **2,398**, original bounds
unchanged. Recheck the affected assertion/guidance before final integrated full.
`night-v8-guidance-focused-2`: **4/5 PASS**, exit 1, **0.274 s** recorded:
the same installed-asset case also requires the original `Missing tooling` phrase.
Restore that phrase in the product (common prose remains **2,400**, not a raised
limit), then verify the complete related file set before the single final full.
`night-v8-guidance-focused-3`: **126/126 PASS**, exit 0. Installed Worker
**2,886**, common body **2,464**, prose **2,400**; original limits pass.
No product code/check/scope/model-effort change beyond the recorded guidance.
Final integrated full verification follows before candidate/package freeze.

`night-v8-guidance-full`: exit **1**, **199.317 s**, snapshot SHA-256
`aa810e99bc2c1db387fc86ae408c5d4cdc9f8e5ec6a8d012473be33472b3ee7d`.
The fail-fast run reports **1,231/1,235** partial passing tests with **four**
failures in `operator-mission.test.ts`; only 50/101 files started, so this is not
complete-suite evidence. Three failures match verbose `Parent handles` or
`Read/search use` wording rather than the equivalent compact forms. Update those
assertions to accept either exact preserved semantic form. The reproduction
assertion also caught omission of explicit **why** when reporting an unverified
case: restore `report why unverified` and assert it in the guidance test. Compact
`in this Task via` to `here via` in the already same-Task scope section to retain
the original prose bound; no check/effort/scope/permission change. Verify all
four related test files before the corrected final full.

`night-v8-guidance-focused-4`: **154/155 PASS**, exit 1. All four previously
failed Mission tests now pass; the new `here via` compact form hits one more
old literal assertion. Assert the same Task explicitly and accept either
`in this Task via` or `here via` **with the exact existing expand_unit tool**;
do not change product text or bounds again. Current installed asset **2,882**,
common body **2,460**, prose **2,396**. Reuse the just-built current production
for complete affected-file testing, then full rebuild/integration verification.

`night-v8-guidance-focused-5`: **155/155 PASS**, exit **0**, **10.815 s**;
all four affected files, installed Worker **2,882**, common prose **2,396**.
Source/runtime matches the preceding build; only the boundary assertion changed.
`night-v8-guidance-full-2` now verifies the corrected integrated candidate before
any package freeze or fresh original-task inference. Failed/partial full evidence
does not authorize package preparation.

### Corrected v8 full verification and immutable original-task resubmission

`night-v8-guidance-full-2` / `npm run test:full`: **1,620/1,620 PASS**, all
**101** files completed, scheduler valid, exit **0**, **203.192 s**. Fixed
verification source SHA-256:
`265135dc83ddedf2c495bee707981d98af322f8e5045d8700ea964ac46df7320`.
Every verified file hash matched before packing; this supersedes the failed,
partial first v8 full run, not its history.

- Product **`0bf74557b35366af7f3a7f7ee5580a7cf5b858ad`**, pushed on the existing
  PR branch. Marker **`0.13.3-reviewer-continuous-v8`**.
- Immutable package SHA-256
  **`a72234f0b3f3252c575eefda01b52baa4f10bf11904c036b368c60083cb25c44`**;
  all **204** installed files / **eight** runtime assets match.
- New original-task clone, same 1,825-byte Anko request and base
  `3f269a72ff69398b1250c584171f32d12c0d8085`; fresh private DB initially **0**
  sessions, host DB/shared service untouched. Preflight and base
  `go test ./...` exit **0**, preparation has no inference. Model/effort and
  original continuous review/self-recheck/receipt/Git acceptance conditions
  unchanged; no time/cost cutoff, 25 minutes observation only.

Launched unchanged owned driver command, without `tee`/redirection:

```sh
node _testenv/nightly-20261002/run-cycle.mjs anko-nightly-continuous-v8-package-20261003 anko-nightly-continuous-v8-scoring-20261003
```

Driver freezes completed source before unchanged official local scoring, then
the separate read-only public 9-case probes. No native completion/official score/
public quality/new savings claim at launch. Actual native model startup is
observed separately; configured routing alone is not startup evidence. No
release/global apply/main merge or Anko push/PR/publication here. v7 scored
source/package/history stay frozen; no official regrade or repaired score claim.

Actual v8 launch **2026-10-03T03:29:45.414Z**. One read-only startup snapshot at
**03:30:29.356Z** confirms root `ses_f00307cc4ffe3ibOKjD6UzTiK2` on
**`openai/gpt-6.1-sol#xhigh`** and real Worker
`ses_f00300b74ffeTtVdCNq5N0XQrS` on **`openai/gpt-6-luna-fast#max`**,
starting **28.710 s** after measured launch; no model mismatch. Startup-only
pricing **$0.08750872**, unknown **1** while a request is active: provisional,
not final settled usage or a completed-attempt subtotal. Evidence:
`anko-nightly-continuous-v8-package-20261003/actual-native-start.json`, fixed
`candidate.json`, file/asset installation and private DB/preflight proofs.
Final outcomes will be measured only at actual native terminal/source freeze.

### Read-only findings accounting during the fixed v8 run

The active v8 package, source, request, driver and acceptance conditions remain
unchanged. Post-run analysis previously treated every later nonempty
`repair_review(findings)` call as new native accumulation, including a duplicate
or failed call. The analysis-only helper now classifies actual same-author,
successful `correction-running` / `same-native-task` return packets: initial,
distinct new findings, repeated body, header-only, or rejected/unproven. It then
checks distinct successful findings against final durable correction text.
Duplicates, empty bodies and failed/malformed returns do not prove accumulation.
This changes reporting only, not runtime acceptance or a verification gate.

`night-v8-readonly-findings-audit`: **4/4 PASS**, exit **0**, **0.063 s**; synthetic
success/missing retention/duplicate/header-only/foreign-author/error/malformed
receipt cases. A separate read-only check against frozen v7 raw history confirms
one successful initial retained report and **no native additional-finding
exercise**, consistent with the published v7 result. Existing raw evidence and
prior analysis not overwritten; new model requests/candidate edits/official
verifier runs **0**. Evidence: ignored helper `findings-audit.mjs`, its test,
command record and `nightly-20261002/v7-readonly-findings-audit.json`.

Last one-shot v8 status observed **2026-10-03T03:34:08.571Z**: implementation
running at **263.157 s**, actual Luna-fast/max Worker/SOL-xhigh Operator, no
receipt/review yet. Provisional priced **$0.12774320**, one active unpriced
request; neither final failure nor final cost is inferred from it. Owned driver
continues without repeat launch or candidate mutation; completion notification,
not repeated polling, advances scoring/probes and result analysis.

### v8 result: selected quality preserved and whole-task five-minute target exceeded

All results below belong only to product
**`0bf74557b35366af7f3a7f7ee5580a7cf5b858ad`** / package SHA-256
**`a72234f0b3f3252c575eefda01b52baa4f10bf11904c036b368c60083cb25c44`**.
Later docs/helper edits do not change that product candidate.

- Original-task native completion **1,609.436 s (26 min 49.436 s)** /
  **$1.47908048**, **89** requests, unknown **0**. Actual Worker Luna-fast/max
  and Operator/Reviewer SOL/xhigh unchanged, all three native sessions succeeded,
  genuine Mission succeeded receipt. 25-minute checkpoint continued normally,
  no cutoff or intervention.
- Final Anko **`8a66a6bebf5c1ef621a0b5d66348847a62452ef7`**, branch
  **`typed-variable-bindings`**, clean. Exact original request/base/common prompt
  and fixed pricing matched. Source/commit/clean unchanged after scoring/probes.
- Official local **score 1, F2P 9/9, P2P 94/94**, verifier exit **0**,
  **15.589 s**, no timeout. No scorer patch/regrade or post-score candidate edit/
  model request. Formal workflow completion is still a separate observation.
- Same unchanged selected public probe **9/9**, SHA-256
  `b45d25b39fb462688334fa174b2008743dba57405c9993fa53fed73ba0935e53`.
  All four direct/callback caller-option cases pass. v6 was 5/9; v5 9/9;
  Bare 7/9. This preserves the **known selected public quality**, not exhaustive
  correctness or an independent quality sample.
- Versus quality-passing v5: **426.924 s (7 min 6.924 s, 20.97%) faster**,
  **$0.27975880 (15.91%) lower**. The requested at-least-five-minute reduction
  with official score 1 and selected public quality is **observed in this sample**.
  Versus v7 **416.544 s faster**, $0.23506480 lower. Versus Bare **237.023 s
  slower**, $0.69004568 more (87.45%); versus v6 **217.791 s slower**, but v6
  did not preserve the known selected public quality.

Actual initial Reviewer `ses_f0023e853ffePv6uKab1zHi8yM` uses **one** native user
prompt; original call `call_ItKFnavXSpkzIENqJQ84l5NA` / prompt
`msg_0ffdc17b4002L1B5bSvi6zlTs7` also binds terminal self-recheck
`msg_0ffe68f920011gvSgBSFm6uXSB`. Independent pre-edit investigation reports
**four Mediums**: retained caller-mode propagation, channel receive status error
propagation, Go pointer writeback errors and qualified unknown-type diagnostics.
During correction, **one additional Medium** reproduces caller-mode loss in Go
callback conversion. Actual second `repair_review` call
`call_wBFMCAO4uoQf0X17DDXGh5TP` successfully returns in the **same native Task**
and its distinct finding remains in final durable correction text. v7 accumulation
code and v8 retention cue are now exercised **natively**, not only by fixtures.
No rejected/duplicate/header-only findings call is counted as this evidence.

The same Reviewer corrects/rechecks all five findings, runs formal
`go test ./...` once and returns actual `SELF_RECHECKED`, unresolved findings
empty, residual Major null, **independent=false**. No correction redispatch,
Mission/handoff reread, different Reviewer or validation-only Worker. Actual
direct-unit settlement does not masquerade as a second native Task terminal or
an independent PASS; Operator final acceptance/receipt follows.

Activity windows are not additive or causal timing attribution:

- Worker **765.031 s**, v5 **711.912 s**: **53.119 s longer**, 55 requests /
  $0.15632408. Still two formal runs: actual source edits after the first test
  repair disabled module assignments and binding metadata/locking; the second
  is fresh required evidence, not an unchanged gratuitous rerun.
- Complete Reviewer **748.391 s**, v5 **1,221.142 s**: **472.751 s shorter**,
  24 requests / $1.01196800. Initial investigation **190.584 s**;
  correction/self-recheck **557.639 s**, 15 requests, 8,873 reasoning and
  5,912 output tokens. Three test-containing commands execute in **2.471 s**,
  all actual tool execution union **3.094 s**. Final self-recheck response
  **62.517 s**. Time outside tools includes model/provider/host, not proven
  pure reasoning. Initial added regressions fail before the repair, pass after.
- Final assistant **413** characters; saved host card **1,225**, not transcribed.
  Final response **14.730 s / $0.06370000**, not a card-only cost measurement.

Remaining observed detours are retained, not hidden by the successful result:
five guessed missing-file reads; one shell scratch-variable scope denial; and a
subsequent diagnostic script exits 127 before a shell-only parser-generation
comparison succeeds. The rejected command creates its scratch directory with
`mktemp -d parser/.review-grammar-XXXXXX` inside existing `parser/**` write scope,
but the diagnostic names literal `$scratch/baseline.y` and suggests scope
expansion. Reviewer instead uses literal in-scope scratch paths, without new
grant/Task, then completes. Investigate this host path-resolution/repair-message
detour separately before changing policy; no measured five-minute saving is
attributed to it. The reproducible next priorities are initial implementation
completeness and actual rework/model-response/context costs, not adding review
gates or weakening effort.

Evidence: `continuous-review-analysis.json` with native findings audit,
`correction-timing-summary.json`, `finish-analysis.json`,
`comparison-summary-v8.json`, `remaining-detour-analysis.json`, raw history/DB,
unchanged public probe record and fixed official `result.json`. Completed-attempt
priced subtotal **$12.94766736 plus one historical unknown-usage request**;
v8 unknown **0**. One sample per changed candidate, source/findings/provider
timing differ: this is an observed joint quality/time result, **not causal
proof or demonstrated repeatability**. No release/global apply/main merge or
Anko publication performed.

v8 archive completed **2026-10-03T04:00:03.296Z**, owned server stopped and
Docker/project-process inactivity checked. Removed only generated arm
`.opencode/` and cache; source/Git, private DB, fixed package and native history
remain. Same retained archive parent as earlier arms:

- `anko-nightly-continuous-v8-package-20261003/attempt-evidence.tar` SHA-256:
  `6f6955029a59f8e96ed4acbee014ca65461b64d5c310bada02e142fe318b2e82`.
- `product-checks-and-analysis.tar` SHA-256:
  `a825b5c196d750921a15fa5822fde3dfbb91721b1887e0879a895a8639c06b4b`.

Read-only post-archive public reproduction isolates the scratch detour in a new
synthetic project with existing `parser/**` write authority. The variable command
is rejected as `manifest-scope` for literal `$scratch/baseline.y`, although its
extraction already records `active-expansion` with a literal-command remedy.
Actual Bash execution writes only beneath the authorized parser directory and
exits **0**. Its literal-path equivalent passes the existing gate and also exits
**0**, without widening scope. Thus the first necessary improvement is accurate
unresolved-shell-path diagnostics, **not a new grant** or indiscriminate variable
permission. No shell parser/permission/runtime policy changed in this diagnosis,
no model request or official regrade. Synthetic fixture/source and proof retained
in `nightly-20261002/v8-shell-scratch-detour-reproduction.json`; scored v8 source
and previously hashed archives remain unchanged. The addendum is separate from
the already fixed archive, not claimed to be inside its original hash.

### Identical v8 replication for release assessment: launched, outcome pending

The user requested **one more run of the same candidate, then a release
judgment**. This run does not include a product repair, third automatic attempt,
release/global apply/main merge or Anko publication. Shell-diagnostic changes
are deferred; the successful first v8 source and archives remain frozen.

- Same product **`0bf74557b35366af7f3a7f7ee5580a7cf5b858ad`** and exact copied
  `.tgz`, SHA-256
  **`a72234f0b3f3252c575eefda01b52baa4f10bf11904c036b368c60083cb25c44`**.
  No repack/build or new product full test: the fixed package's **1620/1620**
  PASS evidence is retained. All **204** installed files / **8** assets match.
- New arm **`anko-nightly-continuous-v8-repeat-package-20261003`**, base-only
  clone, original 1,825-byte request, new private native DB initially **0**
  sessions. Prior Anko solution/history not copied or mounted; host DB/shared
  service unchanged. Container preflight exit **0**, **5.704 s**; fresh base
  `go test ./...` exit **0**, **5.632 s**. Preparation made no model requests.
- Runner, acceptance, history observer and pricing helper copied byte-for-byte
  from the first v8; wrapper changes only the owned container name. Same pinned
  Node/OpenCode/Go/container, model/effort, review and completion conditions;
  normalized common-task prompt and driver SHA-256 match the first v8.
  No inference time/cost cutoff; 25 minutes remains an observation checkpoint.

Launched **2026-10-03T05:34:49.900Z**, unchanged command form without
`tee`/redirection:

```sh
node _testenv/nightly-20261002/run-cycle.mjs anko-nightly-continuous-v8-repeat-package-20261003 anko-nightly-continuous-v8-repeat-scoring-20261003
```

One read-only startup observation at **05:35:19.460Z** confirms actual Operator
`ses_effbdfa66ffe0EENGvFIxmpB2U` on **`openai/gpt-6.1-sol#xhigh`**, real Worker
`ses_effbd8fccffem05AQsxPWqpnTZ` on **`openai/gpt-6-luna-fast#max`** starting
**26.977 s** after launch. Startup-only priced **$0.06177400**, unknown **1**
while a request is active, not final usage or an attempt failure. Evidence:
`replication-provenance.json`, DB/file/asset/preflight proof and
`actual-native-start.json` in the new arm. No completion/score/quality claim yet.

After genuine native terminal and source freeze, the driver performs the same
fixed official local verifier and unchanged read-only public nine cases once.
Assess native receipt/Git/formal checks, all Major/Medium resolution and honest
same-author self-recheck separately from score **1** and public **9/9**; compare
whole-task time/cost to the first v8 and v5. Existing five-minute observation
target is **1736.360 s** (v5 **2036.360 s**); no new runtime check/gate or cost
cutoff introduced. Two repetitions can corroborate the observed result but do
not establish general reliability or causal latency attribution. Final release
recommendation is **pending this replication**, not authorization to publish;
the separate release lane still owns main integration and release gates.
