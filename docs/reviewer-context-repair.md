# Reviewer corrections in the same context

## Purpose

Allow the Reviewer that discovered a defect to correct it in its existing native session, run the necessary declared validation and make the requested commit. Avoid copying findings through Operator into a new Worker that has to rediscover the same code and failure.

This follow-up starts from PR #148, commit `9a32238c89d71b0cc473abf6417d797ccd6a24a5`. It is a separate change; background Operator execution alone does not implement Reviewer-authored correction.

## Required behavior

- Keep the original request and acceptance conditions. Correction does not create a replacement user task or expand authorized outputs.
- Reuse the actual Reviewer's native session/context, not just its model or a copied summary in a fresh session.
- Reuse existing scoped write authorization, validation evidence, budget and lifecycle accounting. Review completion or a correction author's self-assessment is not acceptance.
- Preserve the correction author in durable lineage so a restart cannot make that author appear independent.
- A different Reviewer independently checks the correction, previous findings and relevant impact. Keep mission-wide acceptance and current source freshness; do not require unchanged checks or a full rediscovery solely because the role changed.
- Keep foreground/background paths and explicit failure/cancellation recovery consistent with PR #148.
- Ordinary read-only Review and non-implementation Missions must not acquire a routine writer or an unnecessary corrective run.

## Verification and handoff

The implementation exposes `sortie_v010_repair_review` to Operator and Coordinator, including their shipped tool settings. After a completed independent Review reports findings, that operation prepares a correction unit and returns a Task whose native `sessionID` is the original Reviewer child. The caller dispatches that exact Task; it does not have to transcribe findings or create a fresh implementation Worker.

For OpenCode **2.0.18**, the adapter uses the supported `agent.transform` and `session.switchAgent` APIs to temporarily switch that same session into a dedicated correction profile. Its preceding context, model/variant and author identity remain unchanged; its native agent identifier changes during correction and returns to the Reviewer profile on terminal/cancellation paths. The implementation no longer depends on the nonexistent 2.0.18 `permission.rules` API. This is not a new Worker session or a global grant to all Reviewers.

The correction inherits the original acceptance/proof/declaration, authorized write union, declared commands, Git boundary and cumulative budget. Explicit project/global/session denies remain in force. The full correction handoff activates the existing write gate. Correction shell access follows only the inherited declared commands and existing Git boundary, not the normal investigative-shell bypass. Current-admission native results must show all inherited declared checks in order, with successful exits and fresh source identity; an earlier Review's checks or only the canonical check cannot certify the correction. Custom Reviewer configurations whose role-level block cannot be identified remain an explicit compatibility limitation, not silently overridden permission.

Correction completion records `CORRECTION_READY` and its author, not a Review PASS. Final Review creates a different child even for otherwise low-risk changes. Its verification prompt points to prior findings and shows the changes from the correction baseline; the original mission-wide source fingerprint remains part of acceptance. An author returning PASS for its own changes cannot satisfy independent acceptance.

Focused verification:

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

Ubuntu should fix the fetched candidate commit and package SHA-256 before any live run, verify the actual reused session and models, and keep candidate conditions unchanged during execution. A correction in the original Reviewer session followed by independent acceptance must be observed; setting a resume ID or passing unit tests alone does not prove deployed native behavior or an approximately 20-minute Anko completion.

## Ubuntu continuation checklist

1. Treat this as a follow-up stacked on PR #148, not as a feature already present in `9a32238`. Integrate through the existing PR-to-main workflow; do not merge the Windows branch directly into a benchmark branch or update a running campaign.
2. In an isolated native fixture, observe an initial Reviewer finding, call `repair_review`, and check that the actual correction child has the same session ID, model/variant and preceding context. Observe its temporary correction profile and restoration to the Reviewer profile.
3. Confirm real native permission evaluation/tool visibility allows the declared edit, shell validation and requested commit only during correction, and restores the prior session rules on success, failure and cancellation.
4. Confirm a separate Reviewer checks the correction and impact; the correction author is not accepted as independent after reload. Retain formal checks, fresh evidence, successful receipt and commit/clean conditions.
5. Record stage timings, actual models, consumed/reserved budget, observed cost and unresolved usage. Then run the original Anko task under the existing approximately 20-minute, zero-intervention quality-completion conditions. Do not replace original Anko with this small integration fixture or infer speedup from the mock regressions.
