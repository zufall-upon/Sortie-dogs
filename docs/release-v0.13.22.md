# v0.13.22 — preserve owned Tasks and actionable benchmark stops

Integrates PR #255 with the already-merged, unreleased PRs #256–#258. Source commits, frozen benchmark candidates and existing ledgers are retained.

- Keep a successfully completed Codex native turn alive until its existing host tools and child Tasks settle. Deliver only their actual delayed results to the same thread and Mission; do not resend the original request or redispatch completed Tasks. Internal continuation preserves the existing Worker admission, owner, model, effort, service tier and cumulative budget without granting new user-turn authority.
- Preserve explicit close, transport loss and failed/interrupted native turn behavior. Report native root completion, owned-task settlement and Mission acceptance separately; native response completion alone is not accepted work.
- Continue bounded owned-process teardown after a transient `pgrep` timeout while preserving explicit SIGINT/SIGTERM cancellation. Retain unresolved candidate runtime/server registration and expose the original preparation error, cleanup context and next operation at both CLI entrypoints.
- Subscribe to owned benchmark CLI terminal events before asynchronous watchdog persistence. Retain missing usage/pricing coverage and a concrete next operation across execution, metadata and replay results; unknown usage is not zero and original reservation holds remain.
- Persist candidate preparation failures through child, supervisor and aggregate outputs before rethrowing the primary exception. Distinguish pre-task failure from verified startup, task execution and Mission completion. Receipt-persistence errors remain separate diagnostics, not replacement causes.

## Existing review disposition

Existing PR bodies, ordinary comments, review bodies and inline comments were collected before integration. PR #255's independent review found one valid Worker-admission continuation defect, already corrected in source head `1bc749695ca419ee46ae8bc6b91a8b0d00243b2d`; delayed command exit0/exit7 regressions retain the same Task through correction, validation, commit and root acceptance. The reviewer made that repair and the author self-rechecked: this is not an independent final PASS. GitHub's automatic review returned a usage-limit notice, not a clean review.

Both PR #256 findings are valid and already fixed in `0f0c0da945a751f975b7428554ebf217bd3b7650`: retain unresolved server registration through outer cleanup, and distinguish cancellation from selector timeout. Final source checks and retained fault-injection evidence cover both. Existing automatic reviews for #257 and #258 completed without code findings. No extra review requested or new approval wait.

## Verification boundaries

Freeze one integrated `main` commit and one tarball before candidate preflight, mandatory Linux full, native Windows CI and one actual Worker startup/model check. Apply that same archive to both existing npm global prefixes and the OpenCode config-local package, attach it to GitHub Release and publish once. Reuse completed source checks; no SWE-bench/Anko replay or candidate substitution is part of this release.

The retained Windows Anko arm accepted its fixed earlier candidate; live continuation was not triggered, and a later source repair was not part of that arm. Do not claim the new release received a live Anko correctness grade or that this single arm proves a speed or causal improvement. See [the retained lifecycle evidence](benchmarks/anko-owned-task-lifecycle-20261014.md).

Mission marker: `0.13.22-owned-task-lifecycle-v1`; unchanged Codex skill marker: `0.13.11-codex-skill-v2`. Installed bytes and isolated startup do not prove that an already-running OpenCode loaded the release. Complete restart remains manual; original Location-only recovery override retirement, saved configuration, authentication, conversations and product/campaign ledgers remain separate and preserved.
