# Reviewer corrections in the same context

## Purpose

Allow the Reviewer that discovered a defect to correct it in its existing native session, run the necessary declared validation and make the requested commit. Avoid copying findings through Operator into a new Worker that has to rediscover the same code and failure.

This follow-up starts from PR #148, commit `9a32238c89d71b0cc473abf6417d797ccd6a24a5`. It is a separate change; background Operator execution alone does not implement Reviewer-authored correction.

## Required behavior

- Keep the original request and acceptance conditions. Correction does not create a replacement user task or expand authorized outputs.
- Reuse the actual Reviewer's native session/context, not just its model or a copied summary in a fresh session.
- Reuse existing scoped write authorization, validation evidence, budget and lifecycle accounting. Review completion, `CORRECTION_READY` or unit success alone is not acceptance.
- Preserve the correction author in durable lineage so a restart cannot make that author appear independent.
- Initial independent Review detects both Major and Medium defects. The same native Reviewer corrects all known defects, runs the inherited formal checks and requested commit/clean boundary, then explicitly self-rechecks the original requirements, retained findings and relevant impact in its same read-only context.
- A different Reviewer is conditional: only a concrete reachable Major risk remaining after self-recheck, with a short affected-path and serious-consequence reason. Medium severity, hashes, public-api/public-logic tags, uncertainty, `EVIDENCE_GAPS` and missing prose alone do not trigger another Reviewer. Known unresolved Major or Medium defects cannot be accepted.
- Record author self-recheck honestly as `self-rechecked`, `independent=false`, never independent `PASS`. Root still compares the current validated candidate with the verbatim original request before the existing successful completion receipt.
- Keep foreground/background paths and explicit failure/cancellation recovery consistent with PR #148.
- Ordinary read-only Review and non-implementation Missions must not acquire a routine writer or an unnecessary corrective run.

## Verification and handoff

The implementation exposes `sortie_v010_repair_review` to Operator and Coordinator, including their shipped tool settings. After a completed independent Review reports findings, that operation prepares a correction unit and returns a Task whose native `sessionID` is the original Reviewer child. The caller dispatches that exact Task; it does not have to transcribe findings or create a fresh implementation Worker.

For OpenCode **2.0.18**, the adapter uses the supported `agent.transform` and `session.switchAgent` APIs to temporarily switch that same session into a dedicated correction profile. Its preceding context, model/variant and author identity remain unchanged; its native agent identifier changes during correction and returns to the Reviewer profile on terminal/cancellation paths. The implementation no longer depends on the nonexistent 2.0.18 `permission.rules` API. This is not a new Worker session or a global grant to all Reviewers.

The correction inherits the original acceptance/proof/declaration, authorized write union, declared commands, Git boundary and cumulative budget. Explicit project/global/session denies remain in force. The full correction handoff activates the existing write gate. Correction shell access follows only the inherited declared commands and existing Git boundary, not the normal investigative-shell bypass. Current-admission native results must show all inherited declared checks in order, with successful exits and fresh source identity; an earlier Review's checks or only the canonical check cannot certify the correction. Custom Reviewer configurations whose role-level block cannot be identified remain an explicit compatibility limitation, not silently overridden permission.

Correction completion records `CORRECTION_READY` and its author, not a Review PASS. `review_mission` then returns `status: self-recheck-required` and a Task resuming that same author. It is read-only, does not reopen a writer, and retains the native model/variant. The host supplies the complete `mission.requests[].text` verbatim outside source-excerpt limits, baseline/candidate/diff, declared native check observations and actual request tool availability. Optional root traces or routine diff rereads are not gates; relevant Reviewer search may widen normally.

The native self-recheck terminal format is:

```text
SELF_RECHECKED
self_recheck: {"candidate":"<supplied sourceFingerprint>","unresolved_findings":[],"residual_major":null}
<actual comparison of original requirements, findings, correction and relevant impact>
```

Put known unresolved Major/Medium defects in `unresolved_findings`; these require correction by the original author. A concrete residual Major risk uses `residual_major: {"reachable_path":"<reachable input/path>","consequence":"<serious consequence>"}`. Only that risk triggers a different Reviewer, supplied with correction, retained findings, author self-recheck and relevant impact. New second-side findings return to the original correction owner in a new finding generation, not a fresh Worker or the already-settled correction Task.

Durable fields: `review.mode = "self-recheck"`, `review.verdict = "self-rechecked"`, `review.selfRecheck` and the matching `corrections[].selfRecheck`. The saved report contains `runID`, `source`, `author`, `callID`, `promptID`, `messageID`, `nativeOutcome`, `result`, `unresolvedFindings` and optional `residualMajor`. Acceptance requires the actual successful native terminal after the exact admitted prompt, same author/owner/current run and candidate, fresh phase-1 saved validation bindings, no known unresolved findings and no residual Major risk. Plain author `PASS`, missing/nonterminal/stale self-recheck and `CORRECTION_READY` alone are refused. Summary/packet/report render author self-recheck separately from independent approval.

While an owned background child runs, short launch acknowledgement and root idle are nonterminal: no interruption label or Mission receipt. The real native terminal/wakeup settles existing ownership and spend once. A reused child's old idle/report does not settle a newer correction or self-recheck prompt.

Historical verification of the earlier unconditional-independent-review implementation (not verification of the revised policy below):

- Broad targeted regression: **223/223 PASS**, exit **0**, **26.508 s**, `_testenv/wsl-1790846825686-32632/`.
- Final targeted command: `npm run test:targeted -- test/reviewer-correction.test.ts test/mission-review-generation.test.ts test/v2-plugin.test.ts test/mission-review.test.ts test/mission-review-replan.test.ts test/mission-review-excerpt-limit.test.ts`; **92/92 PASS**, exit **0**, **19.082 s**, `_testenv/wsl-1790847219027-30084/`, source SHA-256 `7cb460301986b5b4e9170cf39ad27f18d97f783f46e7c9757581fe6fb8f7cd1e`.
- Regressions exercise scoped edits, declared validation and requested commits in the retained Reviewer session, successful receipt after a different Review child, rejected self-approval, unchanged requirements, one correction reservation/settlement, review-history cost exclusion, reload, cancellation, native failure, permission restoration, read-only/operation exclusions, and retained Git/proof/declaration boundaries.
- Initial `npm run test:full`: exit **1**, **161.466 s**, `_testenv/wsl-1790847372956-40204/`. One old asset-prose assertion required the former unconditional verdict instruction. The assertion now checks review verdicts and the separate correction-ready condition. Related `v010-runtime` and Reviewer-correction tests: **135/135 PASS**, exit **0**, test phase **11.680 s**, `_testenv/wsl-1790847587593-30604/`.
- Final `npm run test:full`: **1,453/1,453 PASS**, exit **0**, **171.896 s**, `_testenv/wsl-1790847623707-31832/`, source SHA-256 `521988d84c06d6732873d8bca4789ece6a49924f1072533d6b4ce310aa62f441`. Subsequent `npm run test:windows`: **12/12 PASS**, exit **0**, build **8.295 s**, test **3.914 s**.

These tests mock the native host API. They do not establish the real permission evaluator, tool snapshot or model behavior; the focused core Git-boundary test uses synthetic bridge evidence. Full and Windows verification passed for the initial implementation, but the first independent SourceReview returned **FINDINGS**:

1. Installed OpenCode client/plugin **2.0.18 does not expose `permission.rules`**. The initial permission mock did not represent that version, so the correction operation cannot run there as implemented.
2. Shipped Operator/Coordinator tool settings omit the new `repair_review` allow entry.
3. The broad correction shell grant and investigative bypass can allow writes beyond the retained output union.
4. A skipped or failed declared non-canonical required check can be hidden by successful canonical evidence.

The four findings have implementation fixes and additional regressions: a contract fixture grounded in the 2.0.18 APIs, shipped-tool visibility through legacy permission conversion/native snapshot/context filtering, outside-union shell-write rejection and explicit-deny preservation, and missing/failed/stale/non-canonical check rejection. Latest targeted command:

`npm run test:targeted -- test/reviewer-correction.test.ts test/v2-plugin.test.ts test/v010-runtime.test.ts test/mission-review-generation.test.ts test/mission-review.test.ts test/mission-review-replan.test.ts test/mission-review-excerpt-limit.test.ts test/mission-background.test.ts test/operator-mission.test.ts test/mission-binding-recovery.test.ts test/model-cost.test.ts test/gate.test.ts`

Result: **261/261 PASS**, exit **0**, total **28.332 s**, build **10.749 s**, test **13.029 s**, `_testenv/wsl-1790850601200-30348/`, source SHA-256 `26b84d07095b0aa982b062155742c2a621c40b4863c0489e3a7fe1e54446e7dc`.

Integration verification of these fixes: `npm run test:full` **1,465/1,465 PASS**, exit **0**, **173.201 s**, `_testenv/wsl-1790850745256-33976/`, the same source SHA-256. Subsequent `npm run test:windows`: **12/12 PASS**, exit **0**, build **9.682 s**, test **3.914 s**. Independent re-review is still in progress at this update. Actual deployed native behavior remains unverified; the contract fixture is not a live session result.

Original Anko live runs and performance tuning remain with the Ubuntu lane. Windows does not run another Anko campaign or merge, release or globally apply this change. Implementation/SourceReview session costs are not yet aggregated; no new paid native probe or Anko model session is launched here.

Ubuntu should fix the fetched candidate commit and package SHA-256 before any live run, verify the actual reused session and models, and keep candidate conditions unchanged during execution. A correction and explicit self-recheck in the original Reviewer session followed by root acceptance must be observed; a second Reviewer is conditional on concrete residual Major risk. Setting a resume ID or passing unit tests alone does not prove deployed native behavior or an approximately 20-minute Anko completion.

## PR149 remediation status (2026-10-01)

Phase 1 commit `bdd79bfc6755fb62fb7c5891b97069fc6aea040d` fixes the latest four review findings: native caller-context alias permissions; restoration after transient lookup/switch failures; every repeated declared validation occurrence with required-execution budget identities; and freshness from saved actual check snapshots, including generators and commit hooks. Grouped targeted build/tests: **286/286 PASS**, exit **0**, **22.543 s**. Records: `_testenv/pr149-remediation/phase1-verification.json` and `.md`. This is fixture/package-based coverage of native **2.0.18**, not live runtime/Anko verification.

Phase 2 implements the revised conditional-second-review policy and background/prompt fixes above. Grouped targeted build/tests: **457/457 PASS**, exit **0**, **28.197 s**, including the phase-1 permission, recovery, repeated-check and saved-snapshot regressions. Separate command/exit/timing records: `_testenv/pr149-remediation/phase2-verification.json` and `.md`; final log: `phase2-targeted-final.log`. These fixtures do not establish deployed native/model or Anko completion. Full-suite validation, independent review, installed/native probes and original Anko execution remain with the parent session. No release, tag, publish, global apply, merge or push occurs in this implementation phase; the user handles release in a separate chat.

## Ubuntu continuation checklist

1. Treat this as a follow-up stacked on PR #148, not as a feature already present in `9a32238`. Integrate through the existing PR-to-main workflow; do not merge the Windows branch directly into a benchmark branch or update a running campaign.
2. In an isolated native fixture, observe an initial Reviewer finding, call `repair_review`, and check that the actual correction child has the same session ID, model/variant and preceding context. Observe its temporary correction profile and restoration to the Reviewer profile.
3. Confirm real native permission evaluation/tool visibility allows the declared edit, shell validation and requested commit only during correction, and restores the prior session rules on success, failure and cancellation.
4. Confirm the original Reviewer self-rechecks the current correction and impact after formal checks/commit. Three Medium defects corrected and self-rechecked require no second Reviewer; concrete reachable residual Major risk alone requires a different child. The author remains non-independent after reload. Retain fresh evidence, successful root receipt and commit/clean conditions.
5. Record stage timings, actual models, consumed/reserved budget, observed cost and unresolved usage. Then run the original Anko task under the existing approximately 20-minute, zero-intervention quality-completion conditions. Do not replace original Anko with this small integration fixture or infer speedup from the mock regressions.
