# Responsive Operator

## Goal

After handing work to a Coordinator or a direct Mission Worker, the Operator should finish a short acknowledgement and remain available for the next user message while the child continues. The user's conversation should not be blocked by implementation, checks or Review.

This changes orchestration, not model effort, quality acceptance or the authority of the original request. Reviewer-authored corrections are a related follow-up: preserving an investigator's context may avoid a new Worker's rediscovery, but that author must not provide the independent final approval of its own correction.

## Native route

Use OpenCode V2's existing `subagent(background: true)` and native completion notification. Do not create another scheduler or periodically poll sessions. A launch acknowledgement with `metadata.status: "running"` is not a completed child. Keep the existing Task reservation, writer and owner until the actual terminal outcome.

Root-owned Coordinator, direct Worker and Reviewer dispatches need this distinction. Coordinator-internal foreground tasks may remain foreground: the Coordinator waiting does not block the root conversation.

The native Job sends a synthetic completion notification and wakes the parent. That notification is not a new user requirement, and Sortie should not send a duplicate completion prompt. An idle Operator with an active background child is not a stalled Mission needing an automatic continuation message.

## Conversation and control

- A normal user chat does not append requirements, replace the Mission, release a reservation or stop the child.
- The Operator adopts requested work changes through existing Mission operations, then delivers applicable steering once to the current child.
- Changes to a frozen Worker contract follow the existing repair/stop route; a chat message is not an undeclared scope update.
- Explicit Mission cancellation remains distinct from the Operator finishing or interrupting an ordinary reply.
- Durable dispatch identity must survive plugin/server reloads and reconcile completion races without double settlement.

One session generates one response at a time. The promise is that the child and Operator are separate concurrent sessions and that an idle Operator can process the next input. Input arriving during the Operator's own answer follows native steering/queue behavior; this is not simultaneous answer generation within one session.

## Verification

Native host feasibility confirmed on **OpenCode 2.0.18** with a local deterministic OpenAI-compatible stub, **zero paid model requests**. The native background child was held at its model response while the parent became idle; a second real user turn then completed before the child was released. Evidence: `_testenv/responsive-operator/native-host/{events.json,requests.json,result.json}`; root `ses_f09bd657affenj0NgvgLaPzsRk`.

That probe exercises native Subagent/Job behavior, not Sortie. Product regressions now cover launch versus completion, root idle, unrelated chat, Coordinator steering, duplicate/early events, cold recovery, failure/cancel, reservation accounting, and foreground compatibility. Final targeted verification: **214/214 PASS**, exit **0**, **25.952 s**, `_testenv/wsl-1790840944258-38384/`. Independent SourceReview initially found a stale Reviewer-generation result race; exact call and mission/run/review identity are now checked both before asynchronous lookups and inside the state update. The independent re-review passed.

An initial full run failed seven existing `v010-runtime` cases because raw `DONE` text was not normalized before the terminal-report predicate. The product ordering was repaired without weakening those assertions. Final `npm run test:full`: **1,437/1,437 PASS**, exit **0**, **166.422 s**, `_testenv/wsl-1790841083711-13868/`, source SHA-256 `a7df6d0a0176f9df788bd3cdc581dcf36c23c645eba218b4684019d5bc736165`. Subsequent `npm run test:windows`: **12/12 PASS**, exit **0**, build **9.279 s**, test **3.888 s**.

The installed Sortie native Worker probe was launched but produced no completed result before the user requested PR handoff. Its owned process was stopped and evidence retained at `_testenv/responsive-operator/native-sortie-worker/`. It is **not a PASS** and does not establish deployed Sortie responsiveness. The local package used for this attempt has SHA-256 `7a9fd9aaca3763c66febc2fd8ab21b56b2440d516e771f34a7d085d5d880bd2a`; it was built from the tested working source, not a released package. No Anko run or end-to-end speed claim follows from these results.

## Status

Responsive Operator implementation and regressions are included in Draft PR #148. The compact Review-evidence projection was previously integrated in `6edb00d`. Reviewer-authored correction remains **unimplemented**; this background-lifecycle change must not be described as implementing that separate request. No merge, release or global apply is performed.

## Ubuntu continuation

1. Fetch PR #148 into an isolated branch/clone and fix its actual HEAD before building. Record that commit and the new package SHA-256; do not update the running candidate.
2. Complete an installed Sortie native background probe, including a second ordinary user turn while the child is held. Confirm the child, requirements, reservation and writer remain intact, followed by actual terminal settlement. Keep this steering/dialogue test separate from the zero-intervention Anko timing run.
3. Run the original Anko task from its original base in an isolated clone. Restore the original request and conditions from `docs/anko-pain-v0132.md` and the transferred archive, not from an already-corrected Anko HEAD. Preserve Luna/max, formal `go test ./...`, independent Review, successful receipt and requested commit/clean state. The approximately 20-minute quality-completion target remains unproven.
4. Do not push or publish Anko, use hidden graders/official scoring, merge/release Sortie, or alter the candidate/model conditions mid-run. Record time, actual models, observed cost and unresolved usage. Transfer needed Windows-only evidence explicitly; `_testenv` and `M:` archives are not in this PR.
5. Report concrete stalls and necessary fixes back to the Windows lane rather than concurrently editing the same runtime files. Follow the repository's existing PR-to-main integration workflow for any product correction.
