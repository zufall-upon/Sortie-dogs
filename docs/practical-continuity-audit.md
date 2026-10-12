# Practical continuity and parallel execution audit

## Criterion

Keep work executable in the user's real, retained session. Passing a fresh benchmark or an isolated session is not proof that a stopped shared-session workflow can resume.

Parallel correctness does not require every planning detail to remain immutable. Preserve actual user prohibitions, cumulative budgets, concurrent execution ownership and honest candidate/result accounting. Repair or update routing, estimated scopes and stale process-local metadata without requiring another approval or replacing a useful native context.

## Historical boundary

The `v0.8.3` to `v0.9.0` change, commit `1369e4b` (`Release v0.9.0 goal-bound delivery`), introduced goal-bound state and validation budgets, goal-control tickets, no-progress stop/replan policy and additional immutable continuity requirements. This is a material architectural increase in execution conditions. It is consistent with reported usability deterioration beginning around v0.9, but does not establish that every added condition is unnecessary.

The specific existing-Reviewer ban is later: `c6b15265` in PR #39 rejected any `args.task_id` on an independent Review. `fc25b03`, integrated through PR #150, added an exception for same-author self-recheck while retaining the blanket independent-Review ban. Git attribution is not proof of which AI or person authored the design, nor evidence that the user requested the restriction.

## Observed shared-session stop chain

The retained implementation workflow produced these actual native tool failures:

1. `mission-review-correction-source-stale` prevented correction against the retained binding.
2. After validation-only replanning, `mission-review-correction-unavailable` prevented recovery from the earlier run's findings.
3. `review_mission` prepared an independent Review, retained the original child, but omitted its Task ID.
4. Passing that original native Reviewer ID to `subagent` was rejected by `mission-review-task-required` before native execution.

The Reviewer still belongs to the same native parent and retains its Sol/xhigh model. Existing conversation identity is not, by itself, loss of independence. Source PR #210 verified identity recovery in isolated native sessions; it did not verify this original shared-session Review continuation.

## Current repair

- Generate an independent Review continuation in the retained owned, non-correction-author Reviewer context when available.
- Admit an existing owned independent Reviewer rather than rejecting every existing ID. Supply the generated retained ID when the caller omits it.
- Keep the actual native prompt, call, child, model and terminal result bound to the new invocation. An older terminal cannot stand in for a resumed invocation's outcome.
- Preserve ordinary Reviewer permissions, admitted correction ownership, user prohibitions, cumulative spend and current validation. Read-only Review continuation does not consume a Worker unit.
- Recover legacy pending Reviews from their retained owned child even when both the stored Task and caller omit the Task ID. A failed native start can retry the same prompt; prompt text is not an execution-permission token.
- Join an active native Reviewer instead of overwriting its call/prompt generation. Reconcile the existing native terminal before preparing another invocation. Invocation-specific response selection stops at the next real user prompt and falls back to durable native history when the live context was compacted.
- Permit correction against stale validation and earlier-run findings. Current validation remains required for completion, not for beginning repair. A source edit never promotes historical PASS.
- Correct only the changed validation command/cwd registration. Retain unchanged real checks, their native call/member identity, original snapshots and repeated-occurrence accounting. A changed script, relevant input, environment or candidate still prevents completion until affected checks actually pass.
- Record observed implementation mutations and correction authorship independently of the current agent role. Retain author context for explicit self-recheck; never label an author's PASS independent.
- Remove the implicit second no-progress failure-pair stop. Diagnose once and continue useful repair within the existing explicit unit/time/cost budget; neither spend nor user limits are reset.
- Treat exploratory readers as concurrent with writers in scope leases and the parallel-contract validator. Preserve overlapping-write exclusion and existing Git integration serialization.
- Remove the shipped Reviewer's blanket shell denial. Native observations retain the user's permissions; known candidate mutation still needs the existing correction admission. Remove only the exact shipped denial block, never user-provided rules.
- Bind new validation recipes to actual read/command inputs, not Task labels or the OpenCode transport executable/runtime. Explicit OpenCode configuration inputs remain fingerprinted; incidental host configuration is not a product output.

The original shared-parent/Reviewer continuation described below was observed successfully. This does not claim a complete restrictions audit, product completion or release readiness. Those require their own observed results.

## Validation compatibility

Saved evidence retains its capture recipe. Legacy whole-project snapshots that included `.opencode` do not retroactively acquire the new incidental-config exclusion. Explicit configuration inputs, tracked files, ignored deliverables and focused evidence remain protected. Missing legacy toolchain observations are not invented from the current machine.

New native checks capture only their actual command/cwd toolchain, including literal executable bytes, symlink targets, shebang interpreters and configured CMake compiler/build tools. The OpenCode transport is not itself a compiler; when it is the selected interpreter, its runtime remains relevant. This is capture metadata in the existing freshness binding, not another approval or execution protocol. Arbitrary internal subprocesses, shell functions/aliases and all transitive DLL dependencies are not exhaustively observed.

Unchanged executable SHA-256 reads are reused within the host after current realpath/file identity, size, nanosecond mtime/ctime and mode comparison. This avoids repeatedly streaming the same large interpreter during source/candidate/progress projections. Same-path, same-size replacement with restored mtime remains covered by the regression.

The retained production unit declares four read and fourteen write scopes, none under `.opencode`. Before local candidate loading, record the original state and compare the same source/validation bindings before and after the administrative config change. Keep npm-global and both OpenCode config-local released packages unchanged during this location-only experiment. Separate plugin storage is not copied or treated as execution authority; recover the pending Review from its existing Mission and native conversation.

## Consultation accounting

The requested Astra consultation, implementation and integration inspection used actual native `openai/gpt-6-astra#xhigh` selection. The retained consultation history contains 91 priced requests, an API-rate estimate of USD 23.044646 and zero unpriced requests. This is not an invoice or a claim of free execution, and does not include the primary coding conversation or historical product work. The original-parent/Reviewer continuation has a separate observation window and cost receipt.

## Candidate validation and loading

- Integrated `npm run test:full`: exit 0, 1,917 PASS / 2 skip, 328.955 seconds including WSL preparation/build. Source snapshot SHA-256: `2817d917aeed74e31cac33ea12ecd67e7a923cef6b246d9742910eeab20a91f1`.
- `npm run test:windows`: exit 0, 18 PASS; build 11.611 seconds, tests 4.171 seconds. No runtime/test changes followed these checks; later edits are documentation/accounting only.
- Fixed local candidate archive SHA-256: `d97d5e063327ebed4e57f7f2134a32ace02f461ec25e43fada6423979f0157f1`. It remains a development candidate based on v0.13.15, not a release or npm publication.
- Actual original Location uses an automatically discovered local wrapper and a unique candidate plugin ID while disabling the released plugin only in that Location. An initial explicit Windows file-URI entry did not load; no native model execution was attempted under that failed-loading condition.
- Native OpenCode 2.0.27 / runtime v26.3.0 confirmed the original pending Review source and its saved validation source/candidate bindings unchanged after loading. Existing fourteen dirty paths, native parent/Reviewer IDs, Sol/xhigh selections and max36/consumed35/reserved0/remaining1 were retained.
- The global released packages and role assets remain untouched. The real continuation therefore also exercises correction permission projection against the retained released Reviewer definition; a successful source fixture is not substituted for that native observation.

## Original shared-session result

The same original native parent and original Reviewer continued on Sol/xhigh. The caller omitted the Reviewer ID and the legacy stored pending Task also had no Task ID; native Task metadata confirmed dispatch to the retained child, not a copied or newly created conversation.

- Actual call: `call_QsE47VnewMW5j7JWU8MWUhPg`; admitted prompt: `msg_12fb49bb7001IJl41HHK1dNTSh`.
- The original Reviewer read the retained source, recorded the known Medium finding through `repair_review` and continued correction inside this same native Task. Its correction permission projection exposed actual native shell and patch tools against the retained released role definition.
- The established public regression failed before the smallest correction with `Completed history without input admitted an original reread`, exit 1. The Reviewer then corrected three already-dirty files and successfully ran the inherited CMake build and focused CTest: both exit 0, 2 PASS / 0 FAIL. No original-source selector/factory/export replay or product Start was used for the regression.
- Reviewer terminal: `msg_12fb8d4e00013OJlgQ750IvwFK`, `finish=stop`, explicit `SELF_RECHECKED`, empty unresolved findings and no residual Major. The host recorded `self-rechecked`, `independent=false`, correction `ready`, run `awaiting-acceptance`.
- Original parent terminal: `msg_12fc4cd3b001kpLgJahkUs7BjQ`, `finish=stop`. It observed the actual native result and stopped under the user's no-acceptance instruction. Its `INTERRUPTED` presentation denotes that requested hold, not a failed correction or external blocker.
- Same Mission, same native parent/child relation, same models and Git HEAD. All fourteen existing dirty paths remained dirty. Only the three Reviewer correction files changed; the other eleven existing dirty diffs were byte-identical. The parent did not author product source. Max36/consumed35/reserved0/remaining1 became max36/consumed36/reserved0/remaining0, with no reset/increase.
- End-to-end continuation: 1,167.101 seconds. The actual Reviewer invocation took 309.517 seconds; the parent spent another 785.904 seconds checking/reporting after the Reviewer terminal. This remains part of the excessive-constraint/result-presentation Pain under investigation, not an unrelated efficiency issue or transport wait. The analysis below identifies concrete mechanisms without attributing the entire interval to one cause.
- Original continuation window: parent 15 and Reviewer 13 priced requests, API-rate estimate USD 2.287506, zero unpriced requests. Including the requested Astra session, the measured consultation/continuation estimate is USD 25.332152; primary coding-chat and historical product costs are outside that window.

The external SDK observer's streaming/wait transport reached undici's five-minute timeouts. It did not resend the prompt, restart the execution or repeat checks. Native session activity, persisted messages, actual tool results and the host's recorded self-recheck recovered the observation; the final native wait used the same public SDK endpoint without the short observer header timeout. These observer failures are not hidden as successful stream transport.

The location-only trial intentionally kept old global assets. It proves native admitted correction tools and the retained-session continuation, not blanket migration of every old read-only role definition. New packaged role assets remove the shipped baseline shell denial; explicit user rules/custom instructions remain untouched. The candidate stays local to this Location pending normal PR integration/release. No global application, product acceptance, Go, package launch or publication was performed.

Local evidence: `_testenv/practical-shared-resume/` retains original state, fixed candidate/archive hash, loaded-native binding comparison, exact original native messages, validation logs, costs and a checked native receipt. Receipt native-source SHA-256: `a624c96fb0039923b4db955577f64f43204a72bc0100b15904497e39d42ebfa0`. Private product source/transcripts are not committed; this summary states the observed scope and remaining issues only.

## Post-Reviewer constraint and result-path investigation

This investigation uses the saved original messages, loaded role definition, fixed candidate code and cost receipt only. It does not launch paid inference, dispatch another unit or repeat successful checks.

The actual native completion notification reached the parent 0.102 seconds after the Reviewer terminal. It contained the original child ID, `SELF_RECHECKED`, the correction summary and both successful formal commands. The parent immediately acknowledged receiving the actual terminal, but then made eleven additional Sol/xhigh requests and fifteen tool calls before stopping. Those requests have a retained API-rate estimate of USD 0.7914984, with zero unpriced requests; this is a subset of the earlier continuation total, not a new charge or invoice.

Observed assistant-message durations, excluding small gaps between messages:

- Raw receipt/schema recovery: five requests, six tools, 196.814 seconds. The first broad operator-state dump included full snapshot paths/environment and was clipped to lines 921–1045 of 1045. Subsequent projections guessed `commands` instead of `command`, `after.fresh` instead of `fresh`, and `rootSessionID` instead of `root`, producing nulls despite the actual fields being available. A relative glob returned no files, followed by two directory reads and another selected-field projection.
- Source and schema reinspection: two requests, six tools, 181.960 seconds. The parent searched/read the corrected source and regression, enumerated Mission/task/baseline fields, compared author/prompt information and read the existing CTest log. A later header lookup added one request/tool and 7.364 seconds. These were reads, not formal-check reruns.
- Reflection-only tool turn: one request/tool, 186.384 seconds, ending with a process-reflection record.
- Tracker recording: one request/tool, 175.587 seconds. The parent appended the retained result while keeping the unfinished product card `In progress`; it also asserted original-prompt equality and checked the original body prefix, all other items and all statuses.
- Final report: one request, no tool, 34.130 seconds. `INTERRUPTED` / `TRUE_INTERRUPTION: user` represented the requested hold, not failed correction.

### Confirmed mechanisms and attribution limits

1. **The background result path discards the host-authored receipt.** In `src/plugin/profiled.ts`, inline Reviewer settlement produces `review-correction-recorded`, `independent=false`, an `acceptance_summary` and next-action guidance. Foreground tools forward rewritten output through `src/plugin/v2.ts`'s `execute.after` hook. Background settlement instead passes a temporary output object to that same legacy hook and ignores its rewritten output. The retained parent notification contains only the native Reviewer report, not that host packet. The parent therefore lacks the generated compact provenance at the completion wakeup and recovers call/prompt/check identities through raw state. This is a concrete adapter presentation defect, not failure to deliver the Reviewer terminal.
2. **An extra recording obligation is present in the loaded instructions.** The captured `dog-operator` system says to record the verified cause/prevention after a resolved repeated process failure when reflection is enabled. The observed reflection call matches that instruction. Its entire preceding 186.384-second request cannot be attributed exclusively to composing reflection: the private reasoning text is unavailable. Nonetheless, this separate process-recording turn is an observed instruction-related burden, not established as unrelated model latency. `src/reflection/policy.ts` already calls reflection non-blocking and forbids an extra reflection-only step; the role wording and actual behavior do not realize that intent consistently.
3. **Acceptance comparison and record-and-hold are insufficiently distinguished.** The loaded Operator role requires original-request/source/evidence comparison before final acceptance. The retained generated Review prompt also requires listing native outcome and final acceptance as deferred Operator checks; the Reviewer repeated that wording even though native completion was then delivered. These instructions can encourage additional confirmation, but they do not explicitly require routine source rereads, raw-schema discovery or acceptance preparation for this user's narrower instruction to record and stop. The parent made optional reads and assertions; saved outputs do not prove whether it chose them independently or interpreted these instructions as obligations.
4. **Some recording work is genuinely required by project instructions, not an invented adapter gate.** The original project's `AGENTS.md` requires result recording on the existing card, preservation of its body, all-page retrieval and no premature `Done`. Those requirements remain. Comparing every unrelated board item/status and requiring exact equality of two retained initial prompts before an append are additional parent-chosen checks, not named prerequisites in the inspected adapter instructions. Do not remove the real card requirement to manufacture a shorter successful run.

All fifteen tools completed; the saved window contains no tool refusal, new Review/Worker dispatch, formal-check rerun, additional user prompt or host continuation prompt after the completion notification. This excludes a repeated **observed denial/reprompt** chain in this interval, not instruction burdens or result-interface insufficiency.

Native reasoning-part timestamp spans total 634.243 seconds, with 14,614 reasoning tokens. Tool execution spans sum to 7.727 seconds and created-to-ran spans sum to 86.961 seconds; parallel spans overlap, so these are not an additive wall-clock breakdown. The tracker shell alone spent 66.588 seconds between creation and execution. No per-hook timing identifies that delay, and the reasoning text is unavailable. Neither all 785.904 seconds nor all optional checks can honestly be assigned to one mechanism or to model speed alone.

### Narrow next repair

First carry the already-generated compact host receipt into the **same** native completion context, preserving original child/call/prompt/check identities, actual author self-recheck, cumulative budget and retained evidence. Do not add a second prompt, required status call, raw-state transcript, new task or check. Distinguish an explicitly requested result-and-hold checkpoint from final acceptance; make reflection reuse that checkpoint without requiring a separate model turn. Inspect only concrete missing evidence, preserving the user's real restrictions and project recording rules. Do not impose a shorter reasoning cap or weaken the requested quality to improve timing.

These are diagnosed repair targets, not implemented or original-session-verified fixes. Existing Reviewer recovery remains observed; the parent confirmation-loop Pain is not closed. Local `audit-parent-timeline.mjs`, `parent-timeline.json` and `parent-post-review-audit.json` retain the per-message mapping, source hashes, measurements and attribution limits without committing private transcripts.

## Remaining audit themes

- **Scope:** distinguish a user's explicit prohibition from a coordinator's incomplete read/write estimate. Relevant exploration and in-request scope repair should not require approval or redispatch.
- **Validation:** invalidate a result for changed relevant source, input or execution conditions, not an unrelated conversation, whole live database, excerpt presentation or administrative update. Identify the changed inputs and affected checks before rerunning anything.
- **Operations:** record the actual native operation and its postcondition once. A harmless wrapper or observation-format mismatch must not demand repetition of an already-successful side effect.
- **Recovery:** recover from native history and actual ownership before denying continuation. Status and recovery controls must remain available when process-local metadata is missing.
- **Parallelism:** isolate overlapping writes, normally with existing worktrees, and serialize only conflicting mutations/accounting updates. Permit reads and unrelated units in parallel. Join an already-running owner instead of creating another context or returning an opaque denial.
- **Progress:** distinguish a concrete no-progress loop from useful diagnosis, coordination or recovery. A counter is not evidence that an explicitly requested continuation is futile.

Fix one observed blocking mechanism, verify the same retained workflow, then continue the audit. Do not replace these problems with another mandatory protocol, approval layer or benchmark-only completion criterion.
