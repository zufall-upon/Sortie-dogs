# Anko recovery: live V2 follow-up

This is the user-authorized real-session repair lane for
[PR #146](https://github.com/zufall-upon/Sortie-dogs/pull/146), not a release,
global apply, Anko benchmark result or official score. Historical campaigns and
the shared OpenCode service remain unchanged.

## Fixed conditions

- OpenCode V2 `2.0.20`; Operator `openai/gpt-6.1-sol#xhigh`, Worker
  `openai/gpt-6-luna-fast#max`, Reviewer `openai/gpt-6.1-sol#xhigh`.
- Initial lane ceiling: $6 estimated model usage, $1.50 per Mission probe,
  600 seconds per probe. This is separate from historical campaign budgets.
- One implementation unit: native `extra.txt` output and shell-generated
  `generated/out.txt` deliberately omitted from initial `write: [result.txt]`,
  but explicitly requested, not prohibited. Same-Task repair, fixed
  `node check.mjs`, unchanged inputs, ordinary Git add/commit, real independent
  Reviewer and succeeded Mission receipt are required.
- Raw logs, prompts, fixed input hashes, package bytes, sessions and cumulative
  costs remain outside Git under `_testenv/anko-recovery-live/` and
  `_testenv/anko-recovery-pr-evidence/`. Interrupted messages with unpriced usage
  retain their full reservation; observed priced cost is not known total cost.

## First real results: both probes failed

| Candidate | Root | Exit / elapsed | Measured priced USD | Outcome |
| --- | --- | --- | --- | --- |
| `b71bb75`, package `78a047ab49f4a9b5e9d240daf62b8c61dd095412a901ec60d6879f0fa324994e` | `ses_f0ea0e880ffetemlewrE7OYiIG` | runner 1, native 130 / 600.170 s | 0.29774552 + 1 unpriced request | native scope correction works; Worker cannot see `expand_unit`; Review refuses unavailable descendant records; timeout, no receipt |
| `origin/main` `d19e8be`, package `99300ceec0c3eee4fa1f984fed50d15d58b2ff4455df0041850ecd63514b0a51` | `ses_f0e9cbe66ffeBIuwY2qSkl7G2D` | runner 1, native 130 / 600.245 s | 0.542212 + 1 unpriced request | native `extra.txt` patch denied by scope; Coordinator detour; timeout, no receipt |

Both were launched with `PATH=/home/user/.opencode/bin:$PATH node
_testenv/anko-recovery-pr-evidence/live-probe.mjs <fixed-tgz> <isolated-output>
_testenv/anko-recovery-pr-evidence/live-budget.json`. Actual Worker models were
observed, not inferred from configuration. Same prompt/model does not eliminate
stochastic differences between the two executions.

## Findings and smallest corrections

1. The V2 context filter allowed `expand_unit`, but generated Worker and Luna
   assets still hid it with `tools: sortie_*: false`. Add its explicit permission
   and tool entry to both assets; do not expose Coordinator controls.
2. V2 required an optional object on the wire but advertised a string omission
   sentinel it did not admit. Add an object/string sentinel union; decode a blank
   optional object as omission. Retain meaningful invalid inputs for validation
   and do not erase existing confirmed launch conditions.
3. The private CLI launcher did not register its server. Native plugin context
   lacks `session.list`; its read-only fallback correctly refused the shared
   service's foreign PID. Start the owned server with `--service` and an isolated
   `XDG_STATE_HOME`; do not weaken terminal proof or change shared registration.
   This repairs the probe launcher, not the unregistered standalone limitation.

## Reviewer consultation and checks

Actual Reviewer root `ses_f0e92dde9ffe2NojOOPubTPvWp` ran on Sol/xhigh and
returned **EVIDENCE_GAPS**, exit 0, 93.894 s, priced $0.03715280, no unpriced
requests. Its standalone profile reads were refused as
`runtime-profile-session-inactive`, so its advice was based on the supplied
observations, not independent source inspection. It recommended the three
targeted boundaries above. This is not a Review PASS; proper Mission-child
Review is still required in the rerun.

- `bash -lc 'time npm run test:targeted -- test/v2-plugin.test.ts test/anko-recovery.test.ts test/release-profiles.test.ts'`:
  exit 0, 9.471 s, **60/60 PASS** after these corrections.
- No-model native launcher check: isolated registration URL matched the actual
  private listener and owned PID. Shared service registration was not replaced.
- `git diff --check`: exit 0.

Next: package the corrected commit once, rerun the exact prompt and fixed input
checks, require actual same-Worker shell scope repair and Mission-child Review,
then exercise a deliberately missed Task after-hook with real native history.
No real-session success, Anko completion or official score is claimed yet.
