# Anko pain recovery on v0.13.2

## Acceptance, not a unit-test substitute

This follow-up starts at `v0.13.2` (`3a2dd20feccb28dbb563ec3810b3fe572dac8306`). The npm-global installation and both OpenCode configuration installations report `0.13.2` and matching inspected runtime module hashes. The release archive is fixed at SHA-256 `926bee2e9d544b11baf795bccbde813a1e717f20b555aa977f48af14ecb844de`.

The requested outcome is an actual Anko implementation that preserves the original task, performs needed corrections autonomously, receives an independent Review PASS and a succeeded receipt, and commits the result. Record elapsed time, actual model routes, complete observed usage, user/driver interventions and unresolved costs. Shorter prompts, unit tests, an implementation commit or a small fixture alone do not establish that outcome.

The previous run's final authoritative status remains `user-stopped`, Review pending, no success receipt. Its Worker returned in 1,045,255 ms; total elapsed time at user cancellation was 2,014,676 ms. The earlier Worker took 859,622 ms but did not commit, so those Worker timings are not equivalent complete outcomes.

## Observed causes and changes

- **Requirements were stored but not fully displayed.** The native Worker handoff read returned a single JSON line clipped at 2,000 characters with `metadata.truncated=false`. The original task and its exact `type error`, `<nil>` and zero-value requirements occurred later. A V2 read-result projection now displays every JSON scalar and the original multiline strings for generated handoffs and original-request files. The persisted contracts, their hashes, Task identity and grants are unchanged. Ordinary repository reads and failed reads are unchanged. This establishes visibility, not that the model followed every requirement.
- **An excerpt-size hint rejected the entire Review request.** The previous Operator requested 220 lines and was rejected by the 200-line schema maximum. Positive larger requests now display at most 200 lines with an explicit truncation notice; the Reviewer can read the remaining source directly. All reference bytes still enter the fingerprint. The existing total excerpt budget and six-reference envelope remain unchanged.
- **Review source preparation repeatedly normalized every cache/protection path pair.** A read-only replay against the preserved real Anko project took 10,650.572, 10,347.473 and 10,497.297 ms, returning the same fingerprint on each call. The path-comparison preparation is now call-local and reusable within each snapshot/Review. Scratch classification, tracked inputs, exact deliverables, fresh validation and Review invalidation semantics are not relaxed. No process-wide freshness cache is added.
- **The external observation driver interrupted a live run after a read-only transport failure.** The new isolated driver records transient observation errors and keeps observing the same running Mission. It does not resume, reprompt or manufacture a terminal outcome. This launcher correction is separate from the package changes; the original `fetch failed` root cause is not proven.

## Autonomy, efficiency and visibility

- Autonomy: avoid an evidence-size model retry and avoid driver-created interruption. Retain same-Mission correction and independent Review.
- Efficiency: prepare lexical comparisons once per call; avoid scope widening, extra validation runs or evidence-copying Workers.
- Visibility: expose the full original requirements on the already-required read; report clipped Review context, real timestamps, model routes, usage and incomplete outcomes.
- No new approval, permission layer, security mechanism, scope restriction or completion requirement is introduced. Original requirements and quality checks are not reduced.

## Verification record

- Initial targeted regression: 68/68 PASS, exit 0; exact-read projection, native hook translation and bounded Review context.
- Integrated targeted regression after the path-comparison optimization: 81/81 PASS, exit 0; includes source/candidate freshness and comparison equivalence.
- `npm run test:full`: 1,407/1,407 PASS, exit 0, 173,203 ms including WSL snapshot/build. Source snapshot SHA-256 `d36099f9bfb6c48abefdbdeafbebf9e27b64e2b75949d32a5e856298b515bbeb`; logs `_testenv/wsl-1790772430547-22316/`. Reason: integrated candidate after all known package changes.
- `npm run test:windows`: 11/11 PASS, exit 0; build 9,385 ms, native tests 4,833 ms. Includes shared scratch-rule equivalence and full contract visibility on Windows.
- The same real Anko source replay now takes 926.418, 818.327 and 842.476 ms. Median 10,497.297 → 842.476 ms (about 92% lower). All six calls return exactly the same fingerprint, excerpt length and omitted-source paths. This is Review-preparation improvement, not a complete-Mission speed claim.
- The interrupted live Anko Mission has subsequently completed after explicit user-authorized recovery. This establishes quality completion for that Mission, not unassisted pain acceptance; see the continuation record below.

The live Windows candidate is source commit `8c3f778266a1106beb79180f24bc69868ca305a2`, package SHA-256 `2317d8dd3691df0ea3f88bdb901b90de3b08d772158e42d51ffa09d5b764b7a6`, root `ses_f0d9dfed7ffeH0wMUVYGTtZniG`. Its actual Worker `ses_f0d9a0cabffeYzM4imfeLekU6t` uses `openai/gpt-6-luna-fast#max`. A read-only native database inspection found an 8,357-character handoff tool result containing the exact complete original request, multiline task and both literal error terms. This is actual display-path evidence, not completion evidence.

An additional read-only POSIX equivalence probe found that literal backslashes in filenames differed from the previous containment rule. A subsequent source correction retains the previous `relative` predicate for those uncommon POSIX names and adds equivalence coverage. It does not change the running Windows package or the Windows fast path; the live candidate remains immutable and is not silently relabelled as the subsequent package.

- Fresh `npm run test:full` after that source correction: 1,407/1,407 PASS, exit 0, 179,410 ms. Source SHA-256 `e4db5b7bc86c1bde5a3220a784b80350770c946bc8e060e4c638da623e31c646`; logs `_testenv/wsl-1790773458184-5892/`. Reason for rerun: concrete Linux non-regression finding in the newly optimized source predicate.
- Subsequent `npm run test:windows`: 11/11 PASS, exit 0; build 9,561 ms, native tests 3,679 ms.
- The same six-path POSIX reproduction now matches the previous predicate for every path, exit 0. The predicate's fallback is confined to literal-backslash names on non-Windows hosts.

The real run uses the original Anko base `3f269a72ff69398b1250c584171f32d12c0d8085`, original instruction SHA-256 `96c0c7ad98237d6176034c8893d8bff164ec5fda45889e51780a65cf599ffcfe`, Windows OpenCode 2.0.18 and WSL Go 1.27.1. Only the isolated project path changes in the original request. No official hidden grader, official scoring, extra scoring or reward estimate is used. The Anko clone has no upstream push/PR; shared OpenCode services and global installations are not modified.

Local evidence: `_testenv/pain-v0132/`. Previous authoritative evidence: `M:/_work/_Sortie-dogs-artifacts/records/anko-pr146-c654687-20260930/` (`final-result.json`, `user-stop.json`, complete sanitized database). Raw databases, generated packages, caches and task datasets are not committed to Git.

## Interrupted run and authorized continuation

- The observation driver and its owned OpenCode 2.0.18 process disappeared during a host restart. No original `exit.json` or final observation was produced. The last durable observation was 2,637,546 ms (43m57.546s), observed priced usage $1.45518492, two pending requests, Review pending and no receipt. Do not label this a completed or continuously running attempt.
- Before that restart, the independent initial Review returned three material findings: a non-namespace value causing a type-lookup panic, a Go pointer write-back error being lost, and a channel `ok` assignment error being lost. The Operator autonomously sent those findings back to a Luna Worker in the same Mission. The Worker corrected them, fixed a real disabled-mode regression found by `go test ./...`, retested and committed `ddfc291`. This correction required no user continuation.
- On user instruction `順次続けて`, one synthetic recovery notice resumed the same root and Mission. The original package, Anko base/request, model routes and prohibitions stayed fixed. The actual recorded validation environment was restored for the owned process instead of bypassing freshness. The archived pre-resume database was stripped of its credential without rewriting its original evidence.
- The resumed Review found one further material defect: typed-nil `*env.Env` namespaces still caused a panic. Another same-Mission Luna Worker fixed both namespace positions and added public API/VM error, return-value and post-failure-state tests. A final independent Reviewer returned **PASS**, and the Operator issued a **succeeded** receipt. Mission phase is **completed**.
- Anko final source `b4750842dcad30b82b4a24c9b177bc28418aff7a`, three commits, clean project. Registered `go test ./...` passed. Final Reviewer `ses_f0b5390abffeGX2rG237a1RN1R` completed natively on `openai/gpt-6.1-sol#xhigh`; all three implementation Workers used `openai/gpt-6-luna-fast#max`.
- Observed active segments: **3,210,050 ms (53m30.050s)**, including a 572,504 ms resume segment. Full wall time from initial launch through final observation: **38,522,825 ms (10h42m02.825s)**. The offline gap is not hidden or treated as a speed improvement. The first Worker took 1,388,642 ms, versus 1,045,255 ms in the previous interrupted candidate; complete-result speed and token savings are not established by that comparison.
- Cumulative observed API-token-price estimate: **$2.90838632**, one pending request with unknown usage. This is not the complete total or subscription billing. Native rendered report was measured before final response generation, so its $2.6733 is not substituted for the final database aggregate.
- **One driver intervention and one explicit user continuation. `unassisted_completion=false`.** The resumed quality PASS is not silently promoted to unassisted pain acceptance. No official scoring, hidden grader or reward estimate was used.
- The owned service stopped, credentials were removed from its retained database, and the shared service registration was unchanged during recovery. `database-sanitization.json` records these facts.

Authoritative continuation records: `_testenv/pain-v0132/observation.json`, `exit.json`, `acceptance-analysis.json`, `resume-manifest.json`, `segment-1-host-restarted/` and the complete sanitized database. A separate uninterrupted run from the original Anko base is the remaining acceptance check. Its observed spending inherits the $5 cumulative ceiling rather than resetting the previous spend to zero; the prior interrupted request remains an explicit unknown.
