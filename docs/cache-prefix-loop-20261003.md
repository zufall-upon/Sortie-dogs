# Cache-prefix improvement loop — 2026-10-03

## Scope and baseline

The user authorized continuous reproduce → repair → verify → fixed original-Anko run → analyze → PR-update cycles without routine confirmation. This lane starts from `main` at `8e0c035` (v0.13.4); PR #152 was merged by the separate release lane. This work does not merge main, apply globally, publish, change model effort, accept unresolved Medium findings, or modify previously scored Anko candidates.

The completed v8 histories retain their original attribution: product `0bf74557b35366af7f3a7f7ee5580a7cf5b858ad`, package SHA-256 `a72234f0b3f3252c575eefda01b52baa4f10bf11904c036b368c60083cb25c44`. Compared with the one Bare/SOL sample ($0.78903480), the two v8 runs averaged $1.51259432. Approximately $0.7050 of the $0.7236 increment was uncached-input cost; output/reasoning cost decreased. Both runs exhibited large uncached SOL requests immediately after initial `repair_review` admission and an additional-findings update, followed by recovered cache usage. Operator goal/counter updates also changed the absolute system prefix.

Evidence: `_testenv/nightly-20261002/bare-v8-detailed-cost-comparison.json` and `bare-v8-cache-boundary-analysis.json`. These are frozen-price usage estimates, not invoices or a controlled causal comparison.

## Cycle 1 — chronological live-state projection

Keep stable policy and role instructions in the absolute system prefix. Move generated live goal/counter/receipt, acceptance continuity, parallel status, Worker assignment, continuous Reviewer findings and current-tool guidance to one **request-only chronological system message after native history**. Reconstruct every current field from existing durable state; do not truncate findings or original requirements, invent a tool result/native terminal, add a user prompt, or mutate persisted history.

OpenCode v2.0.18 (`cd9a14a6b688d4021bee381dfd39d2cef9c0f862`) supports chronological `LLM.Message` system updates. Its OpenAI Responses protocol lowers these to developer input items in conversation order rather than absolute `instructions`. See the V2 [plugin hooks guide](https://opencode.ai/v2/docs/build/plugins), `packages/ai/src/schema/messages.ts`, `packages/ai/src/protocols/open-responses.ts`, and `packages/core/src/session/model-request.ts` at that pinned host commit.

Native Reviewer edit/shell and Sortie-tool visibility still change only through existing correction admission. This cycle **does not stabilize the tool catalog** or claim to eliminate that initial cache boundary. Provider cache affinity, transport, model/effort, review and formal-check policies remain unchanged. Hosts without a model-message array retain live state in the system prefix rather than silently dropping it. Compaction keeps its existing durable-state reconstruction and evidence behavior.

### Validation

- Before repair: `npm run test:targeted -- test/v2-plugin.test.ts` reproduced the absolute-prefix defect (46 PASS, one new regression FAIL; exit 1). Command/source hashes, duration and output: `_testenv/coordinator-direct/cache-tail-reproduction.*`.
- After initial repair: the five affected suites passed 273/273 (exit 0), including live/cold/failed Reviewer recovery, cumulative findings, self-recheck/independent-review distinction, permission restoration and installed prompt-size limits. Evidence: `_testenv/coordinator-direct/cache-tail-focused.*`.
- Final prefix-boundary regressions passed 202/202 in the two changed suites (exit 0): investigation → repair and additional-findings updates preserve the absolute prefix, while the current chronological system update retains all known findings, including after cold reload. Evidence: `_testenv/coordinator-direct/cache-tail-focused-final.*`.
- Final integrated full verification and original-Anko inference: pending. Unit/fixture PASS is not original-task completion or observed cache savings.

### Evaluation conditions

Freeze each product commit and package hash. Use a fresh isolated Anko clone at `3f269a72ff69398b1250c584171f32d12c0d8085` and an initially empty private OpenCode DB; retain the original 1,825-byte request. Worker `openai/gpt-6-luna-fast#max`; Reviewer/Operator `openai/gpt-6.1-sol#xhigh`. No time/cost cutoff; 25 minutes is an observation checkpoint only. Fixed driver/acceptance/pricing remain unchanged. After completion, freeze source before official scoring and the selected public probe; no fixes or inference on a scored candidate.

Compare role/model uncached input, cached input, output/reasoning cost, `repair_review` boundary requests, Operator turns, total time/cost, native success/receipt, formal `go test ./...`, requested branch/commit/clean delivery, official score and the existing selected public cases. Cache savings are hypotheses until actual provider usage is observed; quality and cost are separate results. Iterate on evidenced residual causes rather than silently weakening review or checks.

The user's additional priorities are explicit: stable **role-specific** instructions/tool definitions and ordering, volatile timestamp/run/progress/diff information behind reusable content, and append-only correction/test history rather than reassembled past messages. Do not give all agents identical privileges for caching. Never reuse stale review/test evidence for changed source. Account for cache reads **and writes**, output text/tool arguments/reasoning, requests and total dollars separately for SOL and Luna; do not declare success from hit rate alone or by enlarging history. Existing v8 histories report zero cache-write tokens, but new runs must be inspected rather than assumed to do so. Preserve the frozen common price table for comparisons, and label it as an estimator rather than current provider billing verification.
