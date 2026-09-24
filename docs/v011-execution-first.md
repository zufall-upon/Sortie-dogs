# Execution-first repair: requirements and qualification

## Current release scope — usable base, then dogfooding

The user has explicitly changed the immediate objective: ship a compact usable
v0.11.2 base first, then improve it through dogfooding. The 30-run baseline/candidate
comparison was stopped after candidate-15's sixth native qualification finished;
no matched run was launched. A new 23-case campaign is also deferred until after
the base release. Neither comparison nor benchmark score is a release claim or
gate for this scope. Their earlier criteria and receipts below remain historical
development records, not completed qualifications.

The base retains immediate native execution, same-child continuation/recovery,
required-check obligations, independently configured support routes, durable usage
and the five-field TUI overview. Release verification covers the current behavioral
suite, frozen package preflight, installed native execution and actual TUI rendering.
Desktop-browser rendering remains unverified because the browser is disconnected.

The final base correction fixes a real recovery failure from candidate-15:
after a child yielded and its native call settled, the operator's required check
was incorrectly rejected as `work-check-not-owned`. That pushed validation through
an ordinary command, after which its failed broader suite was treated as exploratory.
The operator can now run durable checks directly from the settled yielded state.
Outstanding child execution and explicit user stops remain protected; failed checks
continue to block acceptance. A regression reproduced the old rejection, then
verified failure retention, same-work continuation and final behavioral acceptance.

## User objective (not a proxy metric)

An ordinary request must reach useful execution promptly and continue to its full
verified result without the user having to hurry the operator, repeat known
information, or design the execution path. This includes normal bug fixes and
feature work, not only the benchmark incident. Preserve complete scope, negative
constraints, quality, required checks, costs, same-child recovery, and Sortie's
game-like presentation. Activity, a timeout, a stopped child, and a launch are not
proof that this objective was met.

Implementation owner: Astra. Three further bounded Dog-Advisor consultations in
session `ses_f2fa11ef4ffe7OpGyvzqxoqlQV` refined the same architecture before edits.
The default advisor actually ran `openai/gpt-6-astra#max`.

## Decisions after consultation

1. An optional immediate command in `start_work` reaches the native shell executor
   in that call, before any implementer inference. Original instructions still
   bind it. Persist launch intent first; ambiguous recovery must inspect the same
   native operation, not relaunch it. This is command input, not a mandatory plan.
2. Retain receipt-time and cumulative activity across dispatch, interruptions and
   restarts. Start a host deadline before the first operator tool. Native process
   protection does not establish task progress or reset these measurements.
3. Planning stalls yield internally for correction, not terminal success/blocked.
   Preserve unresolved interventions until the operator relates fresh observed
   execution/check/diff/controller evidence to the request. A check is not required
   solely to clear a stall. Arbitrary shell, patch, check and redispatch do not
   automatically clear it. No per-step parent approval or generic semantic judge.
4. Use native interruption and serialize old execution settlement before resuming
   the same root/child. Durable, deduplicated host steering is exceptional recovery,
   not a new user request or an unbounded continuation loop. User stop wins.
5. Adapt the existing supervisor's runner interface to v0.11. One controller owns
   locks/processes/parallelism/reservations/recovery. Pin inputs and limits; retain
   unknown cost conservatively. Never duplicate a running campaign.
6. Restore departure, live progress, return, mission/proof, cost/pack and retained
   career using host records and existing presentation assets. No presentation
   inference, fabricated score or silent unknown cost. Verify actual rendering.

## Frozen qualification criteria (before implementation)

Clock starts at the parent's request receipt, including operator thought and all
external waits. Also retain client-submission wall time. For these small fixed
fixtures (not a universal task deadline):

| Fixture | Absolute acceptance condition |
| --- | --- |
| Known runner with supplied inputs | Actual target body starts <=60s; first operator tool launches it; zero child launch-planning requests |
| Ordinary bug fix and feature addition | Actual target reproduction/test starts <=120s; <=6 parent+child tool calls including launch |
| Subsequent work in these fixtures | Target result to next target action, or acceptance when finished, <=90s |
| Bug fix and feature addition completion | Request to operator acceptance of all requirements and checks <=600s |
| Noisy discovery, including unrelated checks | Host intervenes and same child reaches target action without user prompting; noise does not clear intervention |
| Long job and interruption/restart | Same job/child, no duplicate launch, immutable inputs, retained costs and failed check obligations |
| Presentation | Departure/live/return and all panels visible and match records, including replay; zero display-only model calls |

Use baseline v0.11.1 archive SHA-256
`0446144712fe4a9503e7324c076b7375ea331801728781efd5e5752d51ca4692`.
Baseline and candidate get three runs of each normal live fixture from identical
initial state. Retain every run. Candidate must pass all applicable absolute
conditions in all three runs and improve pre-execution waiting in both known and
ordinary paths relative to baseline. An empty test, collection failure, unrelated
smoke, adapter launch, patch for appearances or early child return is not success.
Independent fixture oracles decide target relevance; model labels do not.

Early intervention defaults are 30s before the first operator tool and 60s for
unreviewed child planning. These are recovery triggers, not relaxed acceptance
limits. Required investigation and behavior checks must not be sacrificed to
achieve a time bound. No unsolicited user intervention in any passing fixture.

Keep all source/behavior/native recovery tests. Preserve failed attempts and
verification obligations. A failed qualification must be corrected, not excluded
or replaced by syntax tests. Unit count and advisor agreement are not proof of
pain resolution. Release and global apply follow only verified qualification.

## Status

Design reviewed; implementation and empirical qualification in progress. No pain
resolution or new benchmark result has been established by this document.

The user's subsequent full-v0.11.0 result is examined in
[the dev23 retrospective](v011-full-dev23-retrospective.md). It adds explicit
qualification obligations for a representative ordinary repository and a complete
run → diagnosis → improvement → verification chain. The small tag/chunk fixtures
alone must not certify the original pain resolved; the frozen numerical limits
and all historical failures remain unchanged.

The extended fixtures are a multi-module CSV library/CLI repair (`repository`,
with no supplied execution command) and the same application requested as
run → diagnose → fix → add strict mode → verify → report (`chain`, with a supplied
first runner). Freeze before their first execution: repository first useful call
<=120s and <=6 tools; chain first runner <=60s in the first operator tool; both
continuity gaps <=90s and complete accepted scope <=600s, three runs per candidate
and baseline. They exercise separate API/CLI behavior, compatible legacy behavior,
physical error line numbers, and preserved independent tests. They are structured
fixtures, not evidence of a universal success rate on arbitrary repositories.

The pacing observer also now checks the interval after an edit through the next
target execution/acceptance. Earlier instrumentation only measured target-result
to next edit/run, which could miss prolonged planning after an early edit. Repeated
outer subagent returns no longer count the same source change again. This closes
an oracle loophole without changing the 90-second bound; earlier receipts remain
development evidence and the strengthened driver is rerun on both packages.

The first baseline driver (`780cf54ed646807e1f387b79316bfdd85a535b1a642e4cf89c6935c30a683138`)
said “preserve existing tests” but checked byte identity, so additions were treated
as violations despite that ambiguous instruction. It also allowed a same-timestamp
earlier event to satisfy a next-action gap. Those receipts are retained as driver
diagnostics, not selected comparisons. The corrected driver explicitly forbids
editing existing test files (new test files remain allowed), searches only later
events, and reruns both baseline and candidate. All numeric limits are unchanged.

## Subsequent review corrections and retained evidence

- Candidate-2's matched small-fixture run completed all 18 attempts: all nine
  candidate attempts met that driver; baseline missed direct launch in all three
  known-runner attempts and exceeded the six-tool target budget in one bug attempt.
  This is older-source development evidence, not final qualification.
- Candidate-4 extended pilot: repository baseline/candidate completion
  300609/248962ms, first target 14235/6155ms; chain completion 299652/251991ms,
  first target 13188/6056ms. Candidate met the frozen limits in these two pilot
  attempts. Baseline chain missed direct launch and the 90s continuity bound.
  These are one attempt each, not the required three matched final-source runs.
- Full-test-2 read a newly added controller-launch regression after its build had
  finished, so the new test ran against the previous build and failed waiting/ready.
  Rebuilt targeted checks and full-test-3 passed (1179/1179); full-test-4 passed
  (1184/1184) on candidate-8 runtime source. Later changes still need a full rerun.
- Actual TUI qualification found the native child renderer ignored the progress
  metadata's description. The v0.11 companion TUI asset now renders that same
  native metadata above the composer, without a prompt or extra model call.
  Candidate-5 captured the actual live slot. Candidate-5/6's missing cost capture
  was caused by pyte crashing on an orphan wide-character cell during redraw.
  Corrected buffer rendering preserves the actual terminal cells. Candidate-7
  passed every panel; candidate-8 also reopened the same TUI session, displayed
  the retained report with zero additional model requests, and verified all ten
  native assistant receipts including the final response in durable accounting.
- The six-dispatch setting now bounds a no-progress continuation window rather
  than the total scope of productive work. At a boundary, the operator's fresh
  inspected evidence and correction assessment authorise a recorded bounded
  extension. Lifetime attempts, failed checks, same-child identity and costs never
  reset. Repeating old evidence or ungrounded redispatch cannot extend it.
- Direct launches persist the real native shell ID at its progress callback.
  Native lifecycle events retain its terminal status/output independently of the
  awaiting wrapper. The installed 2.0.14 plugin exposes shell hooks, not the HTTP
  client's shell.get/output methods. Truly missing terminal evidence remains
  unverified; output text alone cannot certify that a process ended.
  An explicit retry links to a confirmed-terminal earlier command; ordinary replay
  stays idempotent and ambiguous/live commands cannot silently relaunch.
- Metering now retains support-role requests and post-final completed usage. The
  canonical return report remains its labelled pre-final snapshot; later metering
  updates the durable ledger/career rather than repricing or duplicating that report.

## Candidate-7/8 findings (development evidence, not final qualification)

- Candidate-7's three-scenario/five-scenario matched driver retained 15 complete
  measurements (seven candidate, eight baseline). All seven completed candidate
  measurements met the fixed limits. EDQUOT then interrupted the remaining
  measurements, including a truncated JSON receipt. These are not three complete
  matched repetitions and cannot establish the final acceptance claim. Inactive
  fixture dependency trees were removed; archives, source, locks and all available
  histories/partial receipts remain. Numeric limits are unchanged.
- Candidate-8's deliberate seven-interruption/eight-module qualification completed
  in eight dispatches, with one original request, one child, a retained extension
  at six dispatches, actual individual behavior checks and the independent final
  full oracle. This demonstrates the real continuation boundary; it is not a
  natural-pacing benchmark or evidence of arbitrary-repository success.
- Candidate-8 passed operator pretool intervention, detached controller restart,
  native two-task/compaction, ambiguous native command recovery and interrupted
  required-check recovery. The noisy-child test failed because the operator did
  the remaining edit in an inline command rather than resuming the implementer;
  the attempt counter itself was not reset. Runtime guidance now explicitly keeps
  that implementation in the same cheap child, and the same test remains required.
- The untuned public pydicom-1256 runs exposed native permission and lifecycle
  defects. Candidate-7 repeatedly cut transmitted reasoning; candidate-8 yields
  at the next native request boundary where possible, with only a fixed 10s maximum
  in-flight grace beyond the cumulative deadline. Neither activity nor a new
  request resets the original clock or clears an unresolved intervention.
- Candidate-8 completed the pydicom fix and real focused/nested/waveform behavior
  checks, but acceptance was blocked by a direct prelaunch error with no exit.
  A zero-inference native RPC diagnostic established that 2.0.14 static permission
  denials occur before permission.evaluate and carry Tool.Error with nested
  Permission.BlockedError. Only that typed native denial (or a real observed deny)
  identifies a non-launched command; unknown errors remain ambiguous. A linked
  permitted corrected command must still really execute and be verified.
- Ordinary review corrections now acknowledge fresh inspected evidence and receive
  a bounded next-invocation interval, avoiding an immediate second yield before
  the child can accept its corrected task. Counters and failed checks remain intact.
- Further accounting review found native title/generate requests missing from
  assistant-history totals. Native HTTP/SSE and WebSocket usage is now observed
  without another model call. Missing usage remains explicitly unpriced; late
  completed receipts update their owning archived task, never a later task or the
  immutable pre-final return panel. This source still needs native qualification.

Official v0.11.0 predictions and **8/23** remain unchanged. Internal acceptance,
native recovery, independent official scoring and product pacing are separate
obligations. There is no v0.11.2 release/global application at this stage.

## Five-field visibility and subsequent findings

The user's autonomy/efficiency/visibility criterion also requires one readable view
of **current work / confirmed results / unresolved issues / cost / returned artifacts**.
The native TUI now reads these fields through a read-only RPC backed by host state.
The same overview precedes the immutable return panels. It distinguishes a passing
check on the last observed source from accepted whole-task completion, marks stale
checks for re-verification, retains pending/interrupted/failed obligations, and shows
known estimated cost plus unknown usage. The next request cannot display the prior
task as its own completion. UI refresh/replay never prompts a model or hashes the
repository; source and cost observations carry timestamps.

- Candidate-9 passed all six native child/operator/controller/compaction/command/check
  recovery qualifications and the eight-dispatch continuation test. Its full suite
  passed **1187/1187**. Later source requires new qualification.
- Candidate-9 presentation's initial ledger mismatch was an observer-pagination bug.
  The corrected observer then reached a genuine accounting failure: native automatic
  title HTTP streams can omit Content-Type. Framing is now detected from the body,
  including split/multiline SSE, without consuming native delivery. Overlapping
  auxiliary requests are correlated to their native request/response; ambiguous
  correlations remain unpriced.
- Candidate-10 TUI qualified all panels and the five-field live/returned/replayed
  overview, with zero replay model calls. All **13 receipts** (12 native assistant
  requests, one automatic title) were durably retained, including the final answer.
  Saved estimated cost was **$0.11175732**. The stronger capture driver now waits
  for complete cost/artifact text, avoiding a partial-redraw screenshot as proof.
- Candidate-10's full suite exposed a source-mode CLI initialization import failure.
  The RPC contract now has a dependency-free shared module so source-mode asset
  generation does not load compiled-only behavior modules. The original initialization
  behavior suite passes again; full-test-6's failure remains retained.
- Through candidate-10, public pydicom-1256 was an unsuccessful end-to-end qualification. Candidate-9
  reached focused/full JSON passes but omitted the link resolving a denied native
  command. Recovery packets/errors now identify the exact command obligation and
  required permitted linked retry. Candidate-10 reached 27 passing JSON tests,
  including the waveform, but its operator was cut during substantive review by the
  first-action 30s trigger. The unpriced interrupted Sol request conservatively
  exhausted its $1.50 boundary budget. The short trigger now applies before first
  action; post-result review uses the ordinary 60s planning interval plus at most
  the fixed 10s grace. The external 60/120/90/600s qualification limits are unchanged.
  Typed prelaunch denial is also explained in failed check output, preserving the
  obligation while directing ordinary recovery to a permitted repository runner.
- Read-only accounting audit `_testenv/v011-execution-first/cost-audit/smoke-2/`
  found a recorded lower-bound estimate of **$15.38655572** across 99 qualification
  jobs, with 39 explicitly unknown requests and six jobs with unquantified coverage.
  This deduplicates saved work IDs/prices; it does not reprice history. It excludes
  Astra's development/Advisor sessions and the independent official dev23 campaign,
  and pre-final snapshots omit later usage. It is **not total development spend**.

Candidate-9's unchanged pydicom prediction was separately scored after inference
writers stopped: official Docker scoring **resolved=true**, patch applied, no
infrastructure failure. This used the supported explicit process adapter with the
recorded prediction path/cwd; it does not integrate or certify PR #34's default
argv/cwd repair. The native workflow still failed and official **8/23** is unchanged.

The v0.11 supervisor adapter's actual single-case qualification also requires the
inference driver to accept a pinned public-manifest subset. Its former hardcoded
23-row assertion rejected valid single-case controller inputs before inference;
dataset/instance validation and full-campaign counts remain the caller's frozen
conditions. This boundary must be exercised with the real installed native runner.

Final-source matched comparisons, public-repository accepted completion/scoring,
runner/grader integration and release acceptance remain outstanding. Desktop-browser
verification is still unavailable because no desktop browser is connected.

## Candidate-12 through candidate-14 qualification

- Candidate-12 and candidate-13 contain byte-identical runtime packages
  (`eebdbf6768a113e287faa006ba7566ecd903fbb4fdbf572abc5e24223e7585f5`).
  Full-test-7, -8 and -9 each passed **1193/1193**. Their source identity differs:
  candidate-13 includes the runner/grader patch-hash handoff correction.
- Candidate-12's pydicom-1256 run completed and was independently accepted in
  **402173ms**, preserving its single child, linked denied-command correction,
  failed required checks and equivalent passing replacements. Its final JSON suite
  passed 25 tests, including the nested handler and real waveform roundtrip. The
  frozen patch `9eac8ad4d46e1302d2b136d811bfb3a75b67d68c57c9d6f34ef6280b2a90c752`
  then passed independent official Docker scoring. The direct supervisor→grader
  observation still failed because that older adapter omitted the patch hash;
  manually passing the unchanged prediction to an explicit process adapter is a
  separate scoring observation, not a retroactive integration pass.
- Candidate-13's pydicom-1413 run reached internal acceptance in **384923ms** and
  the actual supervisor→runner→native inference→frozen prediction→official grader
  handoff worked. The official patch result was **unresolved**. It fixed the example
  type but missed two other members of the same shared binary conversion family.
  Internal acceptance did not establish adequate semantic coverage.
- The official image also had two preexisting public-test setup failures with
  pytest **8.3.5**. A clean-image diagnostic reran those exact original tests before
  and after installing **7.4.4**; both passed after that dependency-only repair and
  `git diff` stayed empty. A separate explicitly labelled official-harness run of
  candidate-13's unchanged prediction with pytest 7.4.4 removed those setup failures
  but retained the two genuine missing-family failures. Neither the original
  report nor official **8/23** was changed.
- The portable review guidance now checks a changed shared dispatch/membership rule
  against its locally declared supported family. It does not contain benchmark
  instance names, type names, hidden assertions or a suggested benchmark patch.
  Candidate-14 reruns the same public request from its original source; official
  test data remains outside inference. The selected process-adapter environment
  correction is recorded separately from the original official conditions.
- Further source review fixed a visibility bug: reading status after acceptance
  could relabel later workspace edits as returned artifacts. The accepted source
  view is now immutable; current workspace identity is still reported separately.
  Return session counts include support roles. A setup failure in the supervisor
  adapter now retains an honestly empty, hashed prediction and unknown cost so it
  cannot block incremental grading of other completed cases.
- Candidate-14 source snapshot is `5855799f4032722b3879d3fe1c79788149464cb4`, package
  `4fb3f652c5cf6e73dd76aa9f770a4dbe17b2423976f384763995454371da769a`, with all 196
  compiled files matched byte-for-byte. Full-test-10 passed **1194/1194** and native
  candidate preflight passed without provider requests. TUI live/return/replay and
  all panels passed; all 12 native/auxiliary receipts including the final answer
  were retained. Known estimated usage was **$0.09578504 plus one unknown request**,
  not a complete $0.09578504 total. The 100×40 viewport was separately verified on
  candidate-12 with zero new model calls.
- Cost audit smoke-3 found **$16.69054832** of saved known qualification estimates,
  43 unknown requests and six jobs with unquantified coverage, across 104 jobs at
  that snapshot. A separate read-only audit reached the Astra development and
  Advisor sessions, but only their active post-compaction contexts were available;
  native cost fields were zero despite positive token usage. Those zeros are not
  evidence of free development. Exact development-wide spend remains unavailable;
  historical pricing and all qualification/official ledgers remain unmodified.

Candidate-13 passed all eight native qualifications, including noisy-child recovery
and the eight-dispatch continuation. Its obsolete matched phase was stopped before
fixture model execution; completed observations and failures are retained in
`candidate-13/matched-withheld.json`. Candidate-14 has a fresh batch
for all eight native qualifications and all 30 fixed matched measurements. Results
are pending; successful preflight, unit tests, UI or individual patches do not yet
establish the whole original request complete. No v0.11.2 integration, release,
publication or global application has occurred.

Candidate-14's public pydicom-1413 task subsequently reached native acceptance in
**526805ms**. It retained the same child and repaired its own pytest compatibility
problem, rerunning all **215** cases in the two affected public test modules.
The unchanged frozen patch
`e80099e7e21f0405191f8f4011ee9cb48ee0b81a6404a2f589b5cf9b35f8211a`
passed the independent official harness under the explicitly recorded pytest 7.4.4
conditions. The original official run still failed its two preexisting setup cases;
that report is retained, not relabelled. All target FAIL_TO_PASS cases passed in
both environments.

Timing review found another unmet requirement: the first target Python probe began
**32879ms** after receipt, but was the **12th** parent/child tool call. Fast wall time
does not excuse exceeding the six-call criterion. The implementer now makes at most
three narrow inspections before executing a probe of the actual requested path,
counting a parallel batch as separate tools; necessary broader investigation follows
the result. This changes action ordering, not requested scope, later testing or the
frozen numeric limits. Candidate-14's matched phase is therefore withheld and the
next candidate must repeat the full final qualification. Its successful semantic
fix and independent scoring remain useful development evidence, not final acceptance.

## Candidate-15 (qualification in progress)

The current frozen source is `ec6f0e253aabf3a81d67247ffa56ad0442703358`, package
`c72ec35350f457bab060f1c9931c3656700e06c87ea4a0e855a06b83a7d4709f`.
Inventory and bytes for all 196 compiled files were verified. Preflight passed,
and full-test-11 passed **1194/1194**, with no failures, cancellations or skips.
Native TUI live/return/replay passed with all 12 request receipts retained,
including title generation and the final answer: **117945 tokens**, saved estimate
**$0.09891008** for that fixture. Replaying the panels made no model requests.

The first supervisor qualification failed during module import because the
concurrent full-suite prebuild temporarily removed `dist/plugin/model-cost.js`.
The runner never reached fixture/server/session creation. This was an orchestration
setup failure, not an unsuccessful model attempt or a task to resume. Its failed
state, empty prediction, conservative unknown reservation and scoring observation
remain in `candidate-15/supervised/`. After the build finished, the identical
source/package, public manifest and $1.50 per-case limit were launched in
`candidate-15/candidate-15-setup-retry-1/`, linked by
`candidate-15/setup-failure-reconciliation.json`. No earlier native session exists
to replace; the retry does not alter the failed receipt or spend ledger.

The eight native qualifications and 30 matched measurements use the original
fixed criteria under `matched-15`. Public completion, final comparison and release
acceptance remain pending. The desktop browser connection was checked again and
still reports `browser.disconnected`; native TUI verification does not cover it.

Read-only cost audit smoke-4 retained **$23.23630232** of known qualification
estimates across **122 jobs** and **1834 known-usage requests**, with **52 unknown
requests** and **six jobs with unquantified coverage**. This excludes Astra
development/Advisor sessions and the official dev23 campaign, and older pre-final
snapshots can omit later usage. It is a dated partial recorded estimate, not a
development-wide total; there was no historical repricing or audit model call.
