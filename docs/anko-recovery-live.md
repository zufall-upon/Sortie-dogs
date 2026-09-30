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

## Actual scratch / condition check: partial, not Mission success

The same fixed package ran one separate scratch/condition fixture:
`node _testenv/anko-recovery-pr-evidence/freshness-probe.mjs <fixed-tgz>
_testenv/anko-recovery-live/freshness-conditions-1
_testenv/anko-recovery-pr-evidence/live-budget.json`.
Runner SHA-256: `379bc537c326ade51bbeae30bdb22aef01c1160aede5df49960de08632c786d4`.

- Root `ses_f0e6b94e9ffeZxkTtO8I9P1wjQ`, actual Luna Fast/max Worker
  `ses_f0e6a1c30ffexigNGQ0n726Khb`, actual Sol/xhigh Reviewer
  `ses_f0e66ccc3ffe6BzgeCAB5QFLaZ`.
- The only formal command, `TMPDIR=scratch-tmp GOCACHE=.gocache node check.mjs`,
  passed once, native exit 0, host-observed 25 ms. `node cleanup.mjs` then removed
  exactly the two generated cache files in the same Worker Task. No formal rerun,
  extra Worker, source/check/input change, commit, push or release occurred.
- The saved validation recipe excludes only `.gocache` and `scratch-tmp`. The
  real `.tmp/actual-input.txt` remains explicitly protected. Fixed input hashes,
  one validation admission and successful settlement match the real native history.
  Post-cleanup `review_mission` and the real Reviewer dispatch both passed the
  host's current-validation checks.
- Fixed conditions (600 seconds, $1.50, one probe attempt, grading `none`, exact
  entrypoint/input and explicit applicability) were recorded by `start_mission`
  and retained in the handoff and the Worker's status response. The status call
  passed `confirmed_conditions: ""`, did not erase them and retained one active
  Worker reservation before native return. Worker units and Worker-only cost
  were not presented as external attempt/campaign limits.
- The Reviewer continued read-only source/API-history inspection until the
  declared deadline. No tool refusal or freshness invalidation was observed,
  but no final verdict or receipt was produced. **Native exit 130, runner exit 1,
  timeout 600.286 s; Review pending/interrupted, Mission not accepted.** Do not
  turn the successful Worker/check into an independent Review PASS or completion.
- Priced usage $0.50254664 plus one unpriced interrupted request; Worker-only
  settlement $0.01319584. The full $1.50 reservation remains accounted.

Saved partial assertions are in the fixture's `partial-assertions.json` and
`freshness-partial-assertions.json`. Through this failed whole-Mission probe, known
priced usage is $2.31423028, conservative accounted usage is **$5.47172612**,
and admissible remaining is **$0.52827388**. No new runtime defect is inferred
solely from the Review timeout; no speculative code patch or repeat full suite
was made.

## Final read-only Dog-Reviewer consultation

Actual root `ses_f0e5af075ffepa70WebvDi2ToK`, `openai/gpt-6.1-sol#xhigh`:
**PASS**, native/assertion exit 0, 185.951 s, priced $0.22617080, zero unpriced
requests or tool errors. This separate consultation was bounded to $0.50 / 240
seconds and used the exact generated Dog-Reviewer asset. Its full reply and native
reads are saved under `reviewer-freshness-consult-1/smoke-1/`.

It independently read faithful pretty-printed copies of existing native Worker
history, ledger, state, fixed source and the relevant loaded implementation. It
confirmed one formal PASS, cache-only cleanup, actual input protection, fixed
conditions in handoff/status and successful current-validation gating through the
original Reviewer dispatch. It found no major/medium defect or further repair
needed within that consultation's scope.

The root-only consultation did not load the Mission routing plugin, avoiding the
earlier standalone profile read refusal. It did not create another implementation
attempt, rerun any check, modify source or repair saved state. All original
source/state hashes in its provenance remain unchanged after the consultation.
Its PASS explicitly **does not replace the original Mission's missing succeeded
receipt**; that Mission remains timeout / Review pending / not accepted.

## Lane outcome and remaining work

- **2 completed actual V2 Missions**, both independent Reviewer PASS and succeeded
  receipts: same-Task scope recovery and controlled missed-Task-after recovery.
- **1 partial actual V2 Mission**: scratch cleanup and condition inheritance are
  host-observed and independently confirmed, but original Review timed out.
- Integrated offline candidate: **1394/1394 PASS**; no runtime patch was required
  after those checks or inferred from the third probe's time bound.
- Final measured priced usage **$2.54040108**, plus **3 unpriced interrupted
  requests**. Retaining their full reservations gives accounted usage
  **$5.69789692 / $6**, conservative remaining **$0.30210308**, no active reservations.
  Worker-only estimates are not the total lane cost. No additional paid probe was
  launched after this consultation; raw results are in `final-lane-result.json`.
- Generated isolated `.opencode` installations are removed only after terminal
  observations/provenance are saved and no live process uses each fixture. Native
  records, source, fixed packages/hashes, Mission/flight ledgers and cost records
  are retained. No original working tree, database or historical campaign is deleted.

Canonical Anko runner source remains unavailable (including Git history). Obtain
the original Windows `run-once.mjs` and its exact input/flags before any Anko
inference. Anko completion, independent Anko Review and official score remain
unverified. Unregistered private standalone history, Windows-only tests and an
independent inspection of process-local authorization release are also not proved
by this Linux lane. Do not repeat these successful fixtures as a substitute for
the missing runner or silently raise the budget; do not merge, release, publish
or apply globally under this request.
