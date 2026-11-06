# Advisor Strategy scope: request, not session lifetime

## Observed failure

A read-only saved OpenCode V2 Advisor history contains two distinct `material-uncertainty` inputs in the same child session. The first concerned a failed preparation build. The second supplied an explicit parent correction and new first-runtime observations, requesting a different technical judgment. The actual Advisor model was `openai/gpt-6-astra#xhigh`, an existing user override, not the generated Sol default.

The host delivered the second input and the model replied, but its text refused because the earlier Strategy request had supposedly consumed the session's consultation slot. It recommended another consultation session rather than evaluating the new observations. Native `outcome: succeeded` therefore did not mean the requested advice was delivered. No native quota/tool denial appears in that Advisor exchange.

The six-message snapshot is retained privately under `_testenv/investigations/20261106-advisor-session-quota/`; private requests, paths and artifacts are not included in this document or uploaded to ChatGPT. The original task, session, GPU work, ledger, budget and model configuration are not modified or resumed by this investigation.

## Source diagnosis

- `src/runtime-assets.ts` said: “Accept only one bounded Strategy request … for one candidate and one focused question.” It did not distinguish a single request from the lifetime of a reused Advisor session. `src/runtime-assets-v010.ts` renders that same Advisor body into the Mission profile.
- `src/plugin/fast-lane.ts` admits a new normalized prompt basis with a valid `strategy_trigger`. An identical basis remains subject to the existing host-authorized fallback retry and final retry limit. Those controls are not a session-wide one-call counter; no host admission code changes are needed.
- Public `shouldConsultStrategy` and the `consultation.strategy.maxCallsPerCandidate` configuration retain their existing candidate-level semantics. The helper is not called by the observed runtime dispatch path. Changing these compatibility APIs would not repair a model's already-delivered textual refusal.
- No parent instruction imposing a session-lifetime Advisor quota was found. Existing parent contracts already ask focused questions and retain practical continuation authority.

The history establishes the model's explicit refusal reason, not that one sentence was its sole cause. The exact historical assembled provider request was not captured; previous answers and other supplied context can also affect interpretation.

## Requested ChatGPT consultation and decision

Consultation: <https://chatgpt.com/c/6aebf164-79b0-83ee-88d9-ea63c7792ccf>, 2026-11-06. The authenticated browser received only public source excerpts and anonymized observations. UI model label: `6 高`; exact API model identity and browser billing are unmeasured. The local `consultation.json` and formatting-normalized `chatgpt-response-extract.txt` retain the decision and its limitations.

ChatGPT recommended the narrow Advisor wording change, with no new host state, IDs, counters, disposable sessions or helper/config changes. Adopted:

1. Each host-admitted request is one bounded question about one candidate, not a session-lifetime allowance.
2. A later admitted request evaluates its current question, new evidence and explicit corrections. Earlier advice is context, not authority over current constraints.
3. Earlier replies alone do not justify refusing the new question or requiring another Advisor session.
4. Existing host admission, duplicate/retry controls and explicit budgets remain authoritative. Advice grants no execution, retry, scope or budget authority and is not validation or acceptance.

The tool-free, no-implementation and no-SourceReview role remains unchanged. No model, permission, API, configuration, Mission state, budget, package version or runtime marker changes. A wording change cannot authorize another run of the original operation.

## Verification boundary

- Before the implementation, the new contract/profile expectations fail: 152 pass / 2 fail. The new host dispatch test already passes, demonstrating that host admission is not what needs relaxing.
- After the wording change, targeted `fast-lane`, packed `plugin-loader`, `v010-runtime` and `mission-completion` suites pass: **204/204**, exit 0, 23.143 seconds.
- Regression coverage checks canonical and generated Mission Advisor bodies; a new question with the same trigger/candidate/child is admitted while exact duplicate, unauthorized fallback, exhausted fallback and invalid-trigger denials remain unchanged. Packed asset loading is exercised, not only source strings.
- Native behavior verification uses the exact rendered before/after Advisor bodies in isolated **primary-mode** profiles on the historical actual model. Each profile receives the same two synthetic questions in one retained session. It does not delegate subagents, touch the original project or execute a GPU operation. This is deliberately not claimed as native Coordinator/Advisor Task integration, original-task recovery or an official benchmark.
- The matched rendering probe reproduced the old body's second-question refusal (“このセッションで受け付けるStrategy依頼は1件のみ”). With the new body, the same actual `openai/gpt-6-astra#xhigh` returned two concrete explanations and a recommendation about `threads=0` versus the checker, while retaining `not_attempted` performance. Four replies across two retained primary sessions; no tools or children. **139.622 seconds / $0.180396 / zero unpriced requests**. Session/role IDs necessarily differ between arms; this is one controlled observation, not universal causal proof for the original history.
- Feature full completed successfully: **2,547 PASS / 4 skip**, 134 files, exit 0, **421.935 seconds**. It started before the release request expanded scope and before the version/marker update; the final release identity receives its own mandatory gate, not a replay of the model comparison. Release-profile checks after the identity update: **4/4 PASS**, 8.401 seconds.
- Final full-suite and rendered-probe results, exact commands/exits/times, body hashes, native model observations and priced/unpriced usage are retained in the local evidence directory. No speed, cost-reduction or universal model-compliance claim follows from one fixture.

The original deliverable was a PR only. The user subsequently requested the release routine: integrate the reviewed change, fix a final main commit/archive, pass the release gates, and apply/publish the same archive. That later instruction does not authorize original-task replay, ledger/budget changes or an automatic shared-host restart. Release evidence is retained separately under `_testenv/releases/0.16.11/`.
