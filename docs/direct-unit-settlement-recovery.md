# Direct unit finish settlement and registration recovery

## Observed defect

Sortie-dogs v0.13.17 passes the reusable direct actor as `metadata.sessionId` into the shared dispatch settlement. That path reads `session.get(actor).outcome` as though the actor were a terminal child Task. A historical `interrupted`/`cancelled`/`failed` conversation outcome can therefore discard already-selected direct validation evidence. The outer `finish_direct_unit` then reports that the direct unit is validated even when its saved disposition is cancelled.

The user's extracted-function reproduction establishes this conditional mechanism, not an OpenCode integration reproduction or the reason the original conversation acquired that outcome. The incident-time `session.get` payload was not retained. The original session currently reports `succeeded`; that later observation does not explain or disprove the earlier mis-settlement.

## Repair

- Distinguish a direct finish by the presence of its host-owned direct evidence argument, including an empty argument for incomplete/failed direct work. Do not read that reusable conversation's native outcome as this unit's terminal. Preserve explicit error/cancel metadata and all ordinary Worker/Reviewer terminal handling.
- Return the actual `SerialDispatchSettlement` and compare it with the saved Operator projection. Report validated only when both contain a succeeded disposition and formal evidence. A failed/cancelled receipt returns its actual state and a diagnosis/recovery action.
- Extend the existing `resume_operator` and `unit.evidence-reconciled` paths for an identified direct finish-registration defect. Do not expose a tool for supplying success evidence or allowing arbitrary cancelled units.
- Verify the same run, unit, direct call, actor, controls, reservation and exact historical finish receipt. The original completed native finish tool must bracket the receipt timestamp. Explicit cancellation, stopped/completed/superseded runs, failed/missing/latest-failed/stale checks remain non-recoverable.
- Reuse the ordered native-check verifier and each saved snapshot recipe against current inputs. Preserve native command occurrence, cwd, registration and direct admission. For commands proving acceptance, match the original `validation.admission` and successful `validation.settled` by their exact native call, reservation and evidence key. Supporting build/parse checks need their saved native observations, not invented acceptance admissions.
- The admission key is retained, not recalculated from a later narrower post-check recipe. The native call, durable host check and current freshness comparison bind that observation; no historical recipe is upgraded with current exclusions.
- Append reconciliation evidence to the original receipt without reserve/admit/settle or new validation execution. Keep the erroneous receipt, all saved checks, actual authorship, prior attempt status/failure and original progress. Consumption, reservations, time, cost and validation counters remain unchanged.
- Persist a recovery marker in the same Operator save. Cold replay repairs only the corresponding Mission projection, including multi-unit runs with pending or normally succeeded units. It does not repeat resume, increase generation, manufacture a Task, erase a Git boundary decision, Review finding or product acceptance requirement.

## Consultation and regressions

The requested Astra consultation proposed retaining the existing ledger/runtime paths and identified three concrete issues in the first implementation: failed/acceptance entry refusal, operator-save/Mission-save crash recovery limited to a sole direct unit, and zero-pending boundary decisions falling through to Task generation. All three have targeted regression coverage. Consultation is not product Review or acceptance.

Regressions cover parent outcomes unset/completed/interrupted/cancelled/failed, truthful cancelled finish results, direct recovery after an initial failed check and later successful validation, explicit cancellation, missing native finish, current staleness, latest validation failure, ledger-append/operator-save and operator-save/Mission-save crash boundaries, cold idempotence, pending/normal-succeeded neighboring units, retained boundary holds and accounting invariance at an exhausted implementation budget. Existing Worker terminal and cwd recovery tests remain applicable.

## Original unit verification boundary

The original affected root is `ses_f38b05f66ffdLGfLtbhHm5n7TA`, Mission `mission-61a415a2-9dee-4351-8e2c-9cbfdcc2b325`, run `operator-cbcecb1d-f780-4855-ab24-7c068be082eb`, direct call `direct-d2821ea3-a705-46d6-84fd-e11c857b93b7`. Its cumulative implementation budget is max40/consumed40/reserved0/remaining0. The saved final build, Godot check-only and focused CTest checks use source `sha256:7512db140339b2a8a981419685e1f0c77a32d820366b4eb91287028206afc673` and candidate `sha256:9b1337da878d65c470bf664eea0aa2e02bee4278924e539765bb123634ae96f7`.

Saved `fresh:true` is not current freshness. Actual recovery must compare those original recipes with current files in the original owning OpenCode host. A temporary Location-only candidate may use a thin RPC adapter to call the already-registered `resume_operator` handler in that same host and session context without model inference. It must not construct a substitute session, directly edit the product ledger, execute product checks, create a unit/package, or dispatch a Review.

Local `_testenv/direct-settlement/` retains the original state/native history, exact development package/hash, native load and recovery receipts, preservation comparisons and consultation accounting. Private product source, transcripts, card bodies and raw logs are not committed. Latest-change Review and individual product acceptance remain separate; registration recovery is not Start, Go, acceptance, publication or Done. This corrects the identified lifecycle defect, not every restriction introduced since v0.9.
