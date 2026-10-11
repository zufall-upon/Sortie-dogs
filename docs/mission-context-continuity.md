# Mission context continuity

## Observed failure

The v0.13.12 global-apply handoff retained the original request and requirements, but omitted the public conversation already saved for the Coordinator. Its launch conditions and completed-work fields were empty. A Worker therefore received only the environment, decisions and earlier results manually repeated in its objective. The 2,000-character objective target was not the underlying transport limit.

## Change

- `start_mission` retains available public parent history. `plan_units` refreshes root and declaring Coordinator history before generating the handoff, including replans.
- `handoff.ext["sortie-dogs/mission-context"].continuity` supplies recent conversation and completed/error tool observations, current Mission progress, attempts and operation observations.
- Optional `handoff_context` on `start_mission` and `plan_units` records current intent, rationale, known environment, completed setup/checks, failed approaches and remaining work. Notes retain their author/session and timestamp. Updating one author's notes does not erase another author's notes.
- Exact public text, tool inputs and text outputs are retained in content-addressed JSON snapshots under the Mission directory. Private reasoning and synthetic instructions are excluded. Previously captured messages remain available after partial history responses or restart.
- The inline view is limited to eight public text entries (4,000 characters each) and eight useful terminal tool observations (1,000 characters per input/output/error). Omitted counts, truncation flags, snapshot path/hash and message/call IDs make the remainder discoverable. Original requests are already supplied verbatim and are not repeated in the inline conversation.
- A host public paginated-history reader is preferred. Bounded history remains a fallback; unavailable history or a missing optional snapshot does not require approval or prevent planning. Availability is visible in the context metadata.
- Legacy Missions without snapshots continue to supply their saved public conversation. Reviewer-correction handoffs use the same shared-context projection.

## Autonomy, efficiency and visibility

- No new approval, permission, scope restriction, mandatory form, dispatch or model call.
- Reuse established environment, paths, decisions and unchanged setup. Recheck facts when mutable, conflicting or necessary for the task; explain meaningful repeats with their actual reason.
- Read snapshot JSON entries by message/call IDs only to fill a relevant gap; do not routinely print the entire archive. Snapshots are observations at planning time, not a live shared conversation.
- Existing direct execution (`executor: "self"`) remains available when the current author already has useful context.
- Current original requests and requirements govern. Historical success does not turn into fresh formal validation, current execution, independent review or acceptance.
- Retry/Rescue Tasks retain their existing contract and failed-validation continuation mechanism; this change does not rewrite already admitted contracts.

## Verification

`test/mission-context.test.ts` covers root and Coordinator handoff generation, the native read projection, fresh parent tool results, paginated-history fallback, long/older exact content, cold/partial history, missing optional snapshots and historical results remaining separate from acceptance. Existing Fast-first, direct-execution and Mission tests cover dispatch and validation compatibility.

For a real-session probe, record candidate hash, actual Operator/Worker models, Worker time to first useful action, repeated known-information reads/setup, result and required checks, terminal status, elapsed time and priced/unpriced usage. A single successful probe demonstrates transport and behavior on that task; it does not establish a general speedup over a single agent.
