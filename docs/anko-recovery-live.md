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

## Integrated offline result and launcher credential correction

- Candidate `be1dd37`: `bash -lc 'time npm run test:full'`, exit 0,
  166.409 s, **1394/1394 PASS**, all 90 files completed, valid scheduler.
  A server-restart notification incorrectly labelled the tool cancelled; the
  original process continued and its saved native terminal was recovered.
  This successful execution was not repeated.
- The next live launch saved native exit 1 after 333 ms, **before any session or
  model request**, cost $0. `--service` generates its own credential, so the
  launcher's requested environment password was rejected. This is not a failed
  Worker or a runtime solution result.
- The launcher now passes the credential from its own isolated native service
  registration to clients. A no-model authenticated `/api/info` request proved
  this route on V2 `2.0.20`. No credential value is included in evidence or Git.
  Product/package bytes and the successful offline candidate are unchanged;
  the launcher-only correction is checked through the actual startup path.

## Completed real V2 reruns

Runtime candidate: `be1dd37c3f191bc0a2ff828d87bfb43ece870417`, fixed package
SHA-256 `e3673065cedd6a4942ed5bd5e357333eb56a8980a0e494da1cee9af5020036fa`.
Launcher-only credential correction: `2a6d265`. Both ran sequentially with the
same pinned package, original prompt, fixed input hashes and actual model routes;
the second deliberately omitted only the Worker's Task after-hook. The original
unregistered launcher was corrected between failed and successful runs, so this
is not a claim that launcher conditions were identical throughout.

| Scenario | Actual root / Worker / Reviewer | Native + assertion exit / runtime | Priced USD | Result |
| --- | --- | --- | --- | --- |
| Same-Task native/shell scope repair | `ses_f0e856c47ffeEzOfbe5chSej7T` / `ses_f0e840b34ffe5PunEZJsAvi6fq` / `ses_f0e80e311ffemHEmqvqYOM08Gv` | 0 / 0, 583.925 s | 0.48394276 | independent Reviewer **PASS**, receipt **succeeded**, fixture commit `6be339c8594e45097a3d9bc2c5a9dbc146bad0ee` |
| Controlled missed native Task after-hook | `ses_f0e7c677affexfaGr2WOAEJ230` / `ses_f0e7b3737ffeleGtx5JOqNhkbx` / `ses_f0e790191ffeV56KMxJZVabXYz` | 0 / 0, 524.668 s | 0.45063056 | independent Reviewer **PASS**, receipt **succeeded**, fixture commit `7cc6463fd31b19d21558d444b99261d1005ef875` |

The command for both is `node
_testenv/anko-recovery-pr-evidence/live-probe.mjs <fixed-tgz> <isolated-output>
_testenv/anko-recovery-pr-evidence/live-budget.json`; the controlled case also sets
`SORTIE_LIVE_DROP_WORKER_AFTER=1`. Retained runner SHA-256:
`a9af73704cf031482d2706764813c2008fc02137409f39309f84de9652c3a81d`.
The launcher was detached only to survive host restarts; its native 600-second
watchdog, USD cap, saved exits and stop conditions remained active. Cancellation
notifications affected the waiting commands, not these completed executions.

Both assertions verify one Worker, one unit/attempt, one formal validation
admission, actual Worker `expand_unit`, unchanged fixed inputs, requested Git
commit, independent Reviewer and the succeeded receipt. The Worker's initial
read of the not-yet-created `extra.txt` returned file-not-found in both runs;
this harmless discovery error did not require retry, permission or another unit.

The missed-after wrapper records a real durable `running` unit, a dispatched
attempt and no saved terminal while the native Task has already returned. The
subsequent Review recovers the same attempt/run/unit/Task/call/child/fingerprint,
then records exactly one successful settlement with existing observed command
proof. No probe code repairs a Mission or ledger. Final ledgers contain one
reservation and one matching settlement, no outstanding reservation, and no
durable writer leases. Process-local authorization release is not separately
exposed; do not claim that its internal memory was independently inspected.
The supplied fixture checks and these lifecycle assertions are independent of
the Anko benchmark's quality and official scoring.

Worker-only settled estimates are $0.01636236 and $0.01083216, distinct from the
total per-probe estimates in the table. Successful probes have zero unpriced
messages. Through these completions, the lane measured $1.81168364 in priced
usage, but retained the full $1.50 reservation for each of the two earlier
interrupted/unpriced probes: accounted total **$3.97172612**, conservative
remaining **$2.02827388** of $6. The reported priced sum is not the known total.

No additional runtime change or repeat full suite was needed for these green
observations. Raw lifecycle assertions are in
`_testenv/anko-recovery-pr-evidence/live-green-assertions.json`; raw sessions,
native CLI logs, hashes and before/after ledgers are retained in their fixture
directories.

Next: one bounded actual V2 check of the still-offline-only fixed scratch cleanup
and confirmed-condition handoff, using this same package. Canonical Anko runner
source remains unavailable; Anko completion, independent Anko Review and official
score are still unverified. This repair lane does not substitute a probe for that
runner, merge the PR, publish a release or apply globally.
