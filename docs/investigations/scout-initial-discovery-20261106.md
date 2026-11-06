# Restore useful early Scout discovery

## Observed problem

The old three-role Scout fan-out (manifest, validation, owner/risk) was replaced by normal Scout 0 and an exceptional missing-evidence reader in v0.4.0 (`4543036`). Later removal of per-turn count/after-Worker denials did not restore early parallel discovery. In the bounded recent native snapshot, only one of 200 sessions was a Scout; one other project's 45 returned sessions contained none. These are observations, not an all-time census or a performance comparison.

The saved actual Scout used Luna Fast max, completed four Reads and returned after 52.931 seconds, but explicitly could not establish the public caller connection from supplied excerpts. Successful execution was not useful question resolution. The old four-known-path, 120-line, one-read-per-path and 800-character instructions, with Glob/Grep disabled, made it a snippet reader rather than a discovery role. No historical task, private source, session, DB, ledger, model or budget was changed or replayed.

## Requested ChatGPT consultation

The user requested consultation and a PR. The root used the existing authenticated [ChatGPT browser conversation](https://chatgpt.com/c/6aebf164-79b0-83ee-88d9-ea63c7792ccf), sent an anonymized Goal/Constraints/Observed facts/Question and collected the completed answer. Only public implementation details and aggregate observations were supplied, not credentials, private project code, DBs, original requests or screenshots. The UI displayed `6 高`; its API model identifier and billing were not measured. The full current exchange, completion observation and SHA-256 are retained in ignored `_testenv/investigations/20261106-scout-discovery/`.

Selected exact advice:

> 今回の核心はScoutを3匹呼べるようにすることではなく、親が逐次調査を始める前に、安価なScoutへ独立した調査を分散できるようにすることです。

> 4パスは初期探索のseedとして残し、探索可能なパスの上限にはしないことを推奨します。

> Scoutの返答を保存するだけでは改善になりません。

> 親が結果を統合し、Workerのobjective/handoff_contextへ実際に渡すことを今回のPRの必須要件とします。

> Scoutの価値は呼出回数ではなく、親とWorkerが調査に費やす手間を減らせたかで評価するべきです。

Adopted: concrete early questions, useful 0/1/2/3 selection rather than mandatory three; native foreground parallel calls in the same round; Read/Glob/Grep and relevant caller/test follow-up; source-line/fact/unresolved reuse; existing codes, four JSON keys, eight steps, models, Worker budgets, Review and formal acceptance. No new scheduler, capability, approval, path gate, total-read quota or state schema.

Source-specific adjustments: the FastLane guard already admits early valid codes, so preserve its validation and only clarify the repair text. Existing consultation persistence retains up to 4,000 result characters; it is unchanged. The legacy Coordinator generator is a byte-matched migration identity, not the effective Mission prompt; preserve it unchanged rather than rewriting historical generated hashes.

## Minimal implementation

- Share one early-discovery policy across the effective Fast-first Operator, Mission Coordinator and canonical routing assets. Use 2–3 Scouts in one parallel foreground round for that many independent useful questions; use one for one, zero for known evidence, cheap local inspection or sufficient direct Worker investigation. Start the Mission normally, but do not manufacture a preparation unit/Coordinator just for discovery. Later concrete questions remain valid; no new per-turn Scout ceiling.
- Keep `missing_evidence_code: manifest | validation | owner-risk` as the question classifier. A proven blocking gap is no longer an instruction prerequisite. Keep one concrete question per Scout, not an unfocused repository survey.
- Enable native Glob/Grep alongside Read. Known paths are seeds/search areas; follow relevant callers/tests and decisive lines beyond initial excerpts under the actual project and existing host permissions. Keep shell, web, edits, question, child dispatch and arbitrary session/artifact investigation out of this role. There is no new mechanical path checker.
- Keep the four existing JSON keys, with useful source path:line pointers and explicit uncertainty rather than an 800-character truncation instruction. Eight steps and Luna Fast max remain unchanged. The parent integrates useful results in the next Worker objective/handoff context and resolves real gaps without automatically retrying siblings or asking Advisor to repeat discovery. Required author source inspection and validation freshness remain legitimate.
- Public-hook reproduction also found that early root Scouts were admitted but bypassed the existing Mission consultation recording branch. Extend the existing direct-root consultation selection to Scout even before a run exists. Reuse the same admission, serialized Mission record, native model/outcome settlement and reload path as Coordinator Scouts. Reviewer still requires a prepared run and its generated task; Advisor routing, permissions, execution grants and acceptance are unchanged.

## Verification boundary

Existing public-hook fixtures cover concurrent three-question admission from root and Coordinator before any Worker, unchanged requirements/ownership/lifecycle/Goal/Worker budget, exact native model/results/uncertainty in status, cold reload without redispatch, and explicit inheritance into the generated Worker handoff. Existing single-Scout/header-repair, no-Scout Fast-first completion, V2 model defaults, loader permissions and legacy byte-hash migration checks are reused. These fixtures contain no real model execution.

The first new fixture omitted its native model, then cold reload omitted its native agent identity; those test-setup errors are retained separately. Once corrected, the pre-fix root reproduction showed absent consultation records. A historical asset hash failure correctly prevented rewriting the legacy generator; it was restored unchanged. Related tests then passed 285/285 (exit 0, 23.365 seconds); the focused canonical contract passed (exit 0, 0.283 seconds).

One fixed-candidate native CLI pilot is planned to check actual Scout/model concurrency, discovery beyond seed snippets, useful results passed to Worker, requested behavior/formal validation/Review/receipt, time and priced/unknown usage. It uses a synthetic isolated repository, not a replay of private user work; no official benchmark or causal speed claim. The CLI prompt explicitly requests the three independent discovery questions, so successful use would demonstrate an available route, not autonomous utilization frequency. Command, candidate hash, budget, full-suite and pilot results are recorded separately before PR delivery. No release, global apply, npm publish or automatic shared restart is included.
