# Mission context continuity

## Observed failure

The v0.13.12 global-apply handoff retained the original request and requirements, but omitted the public conversation already saved for the Coordinator. Its launch conditions and completed-work fields were empty. A Worker therefore received only the environment, decisions and earlier results manually repeated in its objective. The 2,000-character objective target was not the underlying transport limit.

## Change

- `start_mission` retains available public parent history. `plan_units` refreshes root and declaring Coordinator history before generating the handoff, including replans.
- Proposed context is staged with the plan and published to Mission metadata only after successful preparation. Rejected replans preserve the current run, context and budget.
- `handoff.ext["sortie-dogs/mission-context"].continuity` supplies recent conversation and completed/error tool observations, current Mission progress, attempts and operation observations.
- Optional `handoff_context` on `start_mission` and `plan_units` records current intent, rationale, known environment, completed setup/checks, failed approaches and remaining work. Notes retain their author/session and timestamp. Updating one author's notes does not erase another author's notes.
- Exact public text, tool inputs and text outputs are retained in content-addressed JSON snapshots under the Mission directory. Private reasoning and synthetic instructions are excluded. Previously captured messages remain available after partial history responses or restart.
- The inline view is limited to eight public text entries (4,000 characters each) and eight useful terminal tool observations (1,000 characters per input/output/error). Omitted counts, truncation flags, snapshot path/hash and message/call IDs make the remainder discoverable. Original requests are already supplied verbatim and are not repeated in the inline conversation.
- A host public paginated-history reader is preferred. Bounded history remains a fallback; unavailable history or a missing optional snapshot does not require approval or prevent planning. Availability is visible in the context metadata.
- Legacy Missions without snapshots continue to supply their saved public conversation. Reviewer-correction handoffs use the same shared-context projection.

## Autonomy, efficiency and visibility

- No new approval, permission, scope restriction, mandatory form, dispatch or model call.
- Reuse established environment, paths, decisions and unchanged setup. Recheck facts when mutable, conflicting or necessary for the task; explain meaningful repeats with their actual reason.
- Parent objectives describe the remaining action. Reference paths are available for relevant gaps, not a mandatory reread checklist; avoid guessed instruction-file paths and routine reconfirmation of already supplied facts.
- Read snapshot JSON entries by message/call IDs only to fill a relevant gap; do not routinely print the entire archive. Snapshots are observations at planning time, not a live shared conversation.
- Existing direct execution (`executor: "self"`) remains available when the current author already has useful context.
- Current original requests and requirements govern. Historical success does not turn into fresh formal validation, current execution, independent review or acceptance.
- Retry/Rescue Tasks retain their existing contract and failed-validation continuation mechanism; this change does not rewrite already admitted contracts.

## Verification

`test/mission-context.test.ts` covers root and Coordinator handoff generation, the native read projection, fresh parent tool results, paginated-history fallback, long/older exact content, cold/partial history, missing optional snapshots and historical results remaining separate from acceptance. Existing Fast-first, direct-execution and Mission tests cover dispatch and validation compatibility.

For a real-session probe, record candidate hash, actual Operator/Worker models, Worker time to first useful action, repeated known-information reads/setup, result and required checks, terminal status, elapsed time and priced/unpriced usage. A single successful probe demonstrates transport and behavior on that task; it does not establish a general speedup over a single agent.

### V2 probe, 2026-10-11

Two fresh isolated installations ran the same two-turn task and selected value: first retain an already prepared environment/output/check in public conversation, then request its implementation without repeating that value in the new user turn. Formal check: `node check.mjs`; expected output: the selected value plus newline in `result.txt`.

- Actual models in both runs: Operator `openai/gpt-6.1-sol#xhigh`, Worker `openai/gpt-6-luna-fast#max`.
- Initial PR candidate `b9c7530`, package SHA-256 `76e9ab283e3d8d20d5026a68940157aad58d3c5497d1bac282e614ad42019e2c`: first source write 24.722 seconds after Worker session creation; Mission 91.451 seconds; estimated $0.08261408. One missing-AGENTS.md read error and one known-information file lookup. The parent explicitly requested those references.
- Final implementation candidate `31e0050`, package SHA-256 `cfa913d1cfe022f25f2f388a26c075a92aa1eab54a55671c96f78a6fb4eec105`: first source write 11.750 seconds; Mission 64.801 seconds; estimated $0.07997736; zero tool errors. The parent made the saved reference conditional and omitted the guessed AGENTS.md path. One known-information file lookup and one instruction-file glob remained.
- Both supplied the selected value in the native handoff continuity view, produced the expected output, passed the formal check and reached `mission_phase=completed`, `receipt_status=succeeded`. The low-risk initial review was recorded as skipped; no separate Reviewer model was dispatched.
- Total estimated usage cost: $0.16259144; unpriced requests: 0. Elapsed Mission time includes native completion/acceptance, excludes fixture installation and the seed turn. Neither run repeated environment setup.

These are two PR candidates with one run each, not a released-version or single-agent baseline. The parent also included the value in requirements, so this confirms delivery and completion without isolating the performance contribution of automatic history. The remaining file lookup is visible; the runtime does not impose a new prohibition on useful rechecks.

Raw observations, prompts, tools, package receipts and cleanup records are retained outside Git at `M:/_work/_Sortie-dogs-artifacts/records/mission-context-continuity-20261011/`. The parameterized local runner is `M:/_work/_Sortie-dogs-artifacts/scripts/mission-context-probe.mjs <checkout> <fixed-tgz> <record-directory>`; `selection.json` pins the same task value across candidates.
