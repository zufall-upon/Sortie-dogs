# Codex large writes and active-Mission observations

## Scope and design review

This PR addresses two observed v0.13.10 Windows Codex SDK problems without adding a permission framework, another ledger, or new model routing.

- Autonomy: a Mission `write` previously placed its entire file contents in argv. A 74,580-character parser write failed synchronously with `spawn ENAMETOOLONG`. The new transport stages a temporary UTF-8 payload; the same configured native/delegated executor performs the project write after the existing before hook. There is no file-size rejection gate or new approval step.
- Efficiency: keep one command per write and compatibility with existing argv-only executors. No stdin capability negotiation, chunk orchestration, dependency, or metered API is added. Payload cleanup does not replace the real command result. The benchmark exposes an already available offline goyacc rather than installing or reimplementing it.
- Visibility: `operator_status` without condition registration is no longer queued behind a long-running Task. Existing omitted/empty optional sentinels are normalized consistently. Condition registration and other modifying calls stay serialized, and close drains outstanding observations. Existing status reconciliation and acceptance rules remain unchanged.

The benchmark executor also records synchronous `spawn` exceptions as `not-started` when no child was created. Transport loss after dispatch still means unknown execution; this PR does not relax that rule or replay such commands.

Mission validation remains post-execution evidence and formal checks, not an equivalent of a pre-execution enforcement guard.

## Fixed candidate and real-session conditions

- Release base: `9deccd9ef63bb4c0f9ebe61fcfc5b26b20ad1cfd` (v0.13.10).
- Tested implementation commit: `b7006e24a46b44c7ba5ff283092dd6d176f467bd`. Subsequent documentation-only commits do not change the tested runtime.
- Development package version: 0.13.10; this is not a new published release.
- Frozen package SHA-256: `74ba9e95f73c4c8a5fdceefbb566a421e09c634afc77049cfb9c8a14387186d6`.
- Anko base: `3f269a72ff69398b1250c584171f32d12c0d8085`, fetched by exact SHA into a fresh repository without earlier implementation refs.
- Original task: 1,825 bytes; SHA-256 `96c0c7ad98237d6176034c8893d8bff164ec5fda45889e51780a65cf599ffcfe`.
- Operator/Reviewer: native `gpt-6.1-sol` / `xhigh`. Worker: native `gpt-6-luna` / `max` / `priority` (Fast). No model override.
- Existing ChatGPT authentication and explicitly authorized parent-host SDK executor. Native permission profiles and OpenCode configuration are unchanged; the known Windows sandbox startup failure is not repaired by this PR.
- Existing offline WSL Go 1.27.1. Formal check remains exactly `& ".benchmark/validate.ps1"`.
- Declared setup difference: expose the existing pinned goyacc through `.benchmark/goyacc.ps1` and document it in the fixture AGENTS.md. This is a benchmark setup change, not a product speedup measurement.
- Preserve the previous interrupted run and its uncommitted snapshot. Do not retry its unknown write or alter its ledger. The new candidate has its own fresh Anko fixture and one Mission ledger.

## Product validation

- WSL targeted: 53/53 tests passed. Covers native/delegated large literal UTF-8/CRLF/NUL writes, payload cleanup, nonexecution/unknown receipts, active-Task status observations and queued condition registration.
- WSL full suite: 115 files, exit 0. Build 10,817 ms; tests 282,703 ms. Source snapshot SHA-256 `917a8ef838d5c9adad7b8c7761670f3ebe48d8b1215b77802c708d9e218e1d1b`.
- Windows-only supplement: 18/18 tests passed. Includes a real Windows spawn with a >74K-character payload, literal encoding checks and cleanup.

Common npm tests ran only in WSL. Native Windows tests are the dedicated supplement, not a native rerun of the common suite.

## Real Mission observations

- Root: `01a115a5-ae07-75a0-8fc9-57005552bdd7`.
- Worker: `01a115a6-8d51-75e3-b8f2-015eecbaff89`.
- Independent Reviewer: `01a115b4-22da-7162-b98d-4e487872f311`.
- Actual generated-parser `write` calls with 71,996 and 73,918 characters completed successfully through the delegated executor.
- Actual `operator_status` (`view=progress`, empty condition sentinel) started at `2026-10-07T09:30:52.873Z`, completed at `09:30:52.889Z`: 16 ms while the parent Task was not terminal. This is an observed response, not inferred progress from model prose.
- Worker corrected an existing `TestChan` regression, passed the formal check and made local Anko commit `f4a9b7836e4815b7b50d3a2586b7a0e51a487c66`.
- The independent Reviewer retained six Medium findings, reproduced the defects, corrected them in the same native Task, passed inherited formal validation and completed explicit author self-recheck. No new Worker or second Reviewer was created. Author self-recheck is not independent approval of the corrections; the Operator checked the terminal/delivery evidence and accepted the Mission.
- Final Anko commit: `8a8ccc29acf6105c76a4344d6ef8e29662055820` on `codex/typed-bindings`. Tracked files are clean; `.sortie-dogs-v010/` remains untracked host metadata. No Anko push.
- SDK exit 0; native root turn `completed`; accepted `true`; shared Mission `mission-8879fd91-1168-4bfd-ae7e-0b92c7e5b969` phase `completed`, owner closed. Three native turns, 190/190 terminal command receipts, 32 writes, no unresolved command. Eight nonzero command exits were recorded during diagnostics/regression correction, not hidden.
- Elapsed 1,808,739 ms (30m08.739s), including adapter cleanup. Formal checks passed twice: Worker at `2026-10-07T09:29:55.971Z` and Reviewer after correction at `09:43:27.337Z`.

## Scoring

The completed final commit was graded once in a separate copy using the pinned official tests, grader and existing path-only WSL replay helpers. Source HEAD/status/patch stayed unchanged.

- Reward: **1**.
- Fail-to-pass (new functionality): **9/9**.
- Pass-to-pass (existing behavior, including the parser-codegen gate): **94/94**.
- Official-verifier command exit 0; elapsed 46,149 ms; no missing/failed scored tests.
- Model patch SHA-256: `6736777fc23073a32ecce6b539cde579793d97d3344b0ba89c51a1ac1b6cdcd1`.
- Corpus commit: `435ee89ec2f2e2289f33b0da4f992f0b7b7266b9`. Official input/tool/localization hashes are preserved in grading `conditions.json`.

This is a local replay of official scoring logic, not the pinned Docker environment or a hosted leaderboard submission. It uses WSL Go 1.27.1, without Docker CPU/memory/network-namespace limits; Go dependency network access is disabled. The verifier regenerates the parser only in its grading copy.

The prior interrupted published-v0.13.10 snapshot's reference reward 0 is preserved as a different candidate. Neither these outcomes nor the runtime duration establish an isolated speedup, since setup conditions and model-generated implementations differ.

## Evidence and remaining boundary

Raw data, packages, Anko source, and caches stay outside tracked Git content. Local records:

- `M:/_work/_Sortie-dogs-artifacts/records/anko-codex/v0.13.10/20261007/`: original failed session, preserved snapshot and reference reward 0.
- `M:/_work/_Sortie-dogs-artifacts/records/anko-codex/write-status-fix-20261007/attempt-1/`: fixed conditions, runner snapshot/hash, native routes/events, host command journal, live state and audit.
- `M:/_work/_Sortie-dogs-artifacts/records/anko-codex/write-status-fix-20261007/grading/`: pinned scoring conditions, official inputs, separate app copy, raw logs, reward and summary.
- `M:/_work/_Sortie-dogs/_testenv/wsl-1791364395668-46348/`: successful targeted test source/exit/logs.
- `M:/_work/_Sortie-dogs/_testenv/wsl-1791364466213-38736/`: successful full-suite source/exit/logs.

No global install, native sandbox setup, authentication switch, metered API, release, package publication or Anko push was performed. ChatGPT subscription monetary cost is unavailable, not zero. Native token observations are recorded separately from cost.
