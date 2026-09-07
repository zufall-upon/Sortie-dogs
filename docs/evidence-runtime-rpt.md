# v0.8.3 Runtime Acceptance

The release uses focused tests, the normal test suite, and a real WSL OpenCode runtime test. It does not
claim a completed full-suite pass or a Windows Desktop host smoke pass. Windows native Git/process
tests are distinct from Desktop-host verification.

## Integrated Functional Evidence

The isolated WSL fixture uses OpenCode 1.18.29 and the canonical runtime assets marked
`0.3.70-readonly-failure-swarm-v1`. It executes four initial Luna lanes and five total units, with an
intentional validation hold on one critical unit.

- The critical unit received a `live_deadline_exceeded` stop request approximately 3.1 seconds after its
  declared 180-second deadline and actually terminated as `cancelled`.
- An observed `openai/gpt-5.6-sol` worker took over from the same accepted base with unchanged unit
  scope and acceptance. Other lanes retained their accepted artifacts.
- Candidate validation and a fresh independent review passed before one exact-base CAS.
- All five units had one accepted artifact. Repeated acceptance was idempotent and conflicting replay
  was rejected.
- The successful fixture ended with one primary worktree, zero temporary runtime refs, zero leases,
  and a stopped test server.

This is controlled fault-injection evidence, not a model-quality or performance benchmark. It was run
on the implementation candidate before the package-version-only update to 0.8.3.

## Verification Limits

The full-suite attempts exposed a stale package-version expectation and an obsolete expectation that
a completed sibling worktree would remain allocated. Those expectations were corrected; the focused
critical integration test verifies the completed sibling's retained artifact and commit after cleanup.
The complete suite was not restarted to completion. No unresolved test result is relabeled as a pass.

Windows Desktop host verification was not executed because the test VM was unavailable. This is
unverified coverage, not a successful test or an inferred lack of model support.

Earlier failed diagnostic fixtures are separate from the successful acceptance fixture. Their retained
worktrees and records must not be counted as successful cleanup or reused as clean inputs.

## Deferred Performance Qualification

Strict matched runtime benchmarks are scheduled after v0.9.x. Synthetic router replay verifies policy
decisions only. Without sufficient matched observations, routing retains the existing heuristic.
Unknown whole-attempt token and cost values remain unknown rather than being replaced with zero or
the cost of only the final model message.

## Reproduction

Use `test/fixtures/evidence-runtime/run-evidence-runtime-rpt.mjs --self-test` for the bounded driver
contract and transport tests in `test/evidence-runtime-rpt.test.ts` for local checks. The live driver
requires an isolated WSL test environment and creates a fresh root under `_testenv`.
`OPENCODE_BIN` can override the executable; otherwise it uses `opencode` from the login-shell PATH.
The other component fixtures cover terminal rescue, adaptive remediation, and deterministic routing.
