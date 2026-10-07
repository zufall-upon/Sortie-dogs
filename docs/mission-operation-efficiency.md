# Routine operation outcome and binding recovery

## Failure addressed

The v0.12.15 anko retry declared preparation-only work while retaining requirements
to run inference and grading. A successful archive comparison was subsequently
accepted as mission completion, although neither requested operation had started.
The preceding selected-version context was also absent from the first delegation.

Two orchestration defects were reproduced independently of the model:

- A foreground Worker that outlived the 30-minute active-session cache could lose
  its binding lineage. A fresh exact handoff read must remain usable while its
  parent Task is still in flight. The pre-fix timed fixture returns `session-expired`;
  this establishes the cache defect, not the precise cause of every historical
  `handoff-uninspected` response.
- A returned recoverable Worker retained its write reservation. Running the new
  serial-recovery tests against the installed v0.12.15 code returns
  `manifest-overlap` for both a successor writer and a read-only successor.

## Changes

- Preserve bounded recent public conversation text in the Coordinator brief.
  Original requirements remain separate from contextual results and model-selected
  procedures. Routine setup, execution and collection stay in one useful Worker.
- `start_mission(kind: "operation")` and `plan_units.execution` identify the actual
  operation commands and working directory. Native shell before/after hooks retain
  call/session identity, start/end, exit, and terminal outcome. There is no new
  model-authored proof artifact. Replanning retains earlier attempts.
- Command terminal JSON summaries distinguish `NO_START`/zero attempts from an
  executed operation. Reward/score zero is result data. Plain commands retain their
  native exit semantics. This is not a universal parser for arbitrary nested runner
  logs: declare the actual execution commands, not a successful preflight wrapper.
- Ready submission and completion require a terminal result for every declared
  operation command. A terminal failure is reportable for a run-once/result-collection
  request; it is not successful execution. `NO_START`, missing commands and active
  commands remain incomplete. A bounded `EVIDENCE_GAPS` review disposition cannot
  satisfy this condition. Mission acceptance displays
  passed declared checks and explicit Operator acceptance, not a computed count of
  supposedly verified natural-language requirements.
- `start_mission` accepts `execution` alongside a known single `unit`, avoiding an
  otherwise unnecessary Coordinator round trip. The same native observations,
  formal validation, Review and root acceptance apply. Status, acceptance summary
  and completion expose `operation.status`, `terminal_complete`, `process_succeeded`
  and the retained command exits. A failed operation remains visible in the return
  report even when its collected result is accepted. Successful execution requirements
  still belong in meaningful formal validation and the original-request comparison,
  not a new success-policy switch or approval layer. See the
  [2026-10-07 autonomy audit](benchmarks/operation-result-autonomy-20261007.md).
- Multiple requirements need explicit related `requirement_ids`; omission only
  infers an unambiguous single requirement. Scheduling coverage is not semantic proof.
- Keep foreground Worker/root lineage alive across cache expiry. Release a returned
  recoverable mission Worker's reservation while retaining recovery identity. Live
  overlapping writers still conflict, with owner/session/path/access diagnostics.
- Treat declared operation outputs as expected mutations during the native command.
  Compare the other inputs across execution, then pin all post-operation input/output
  bytes for acceptance. The first corrected Desktop probe exposed this extra defect:
  writing `result.json` invalidated the check and caused an unnecessary successor
  Worker even though the operation had succeeded. The final candidate completes with
  one Worker; subsequent source/output edits still invalidate completion evidence.
- Review can request focused line ranges from original declared inputs or outputs,
  including read-only results beyond the first 24 KB. Full file bytes participate
  in staleness checks; no evidence-copying Worker is needed.
- The anko runner's `v2` profile selects the API generation. Candidate identity and
  CLI version/hash are manifest pins. The historical `v0127` profile remains usable.
- WSL test snapshots receive their own Git commit so runner-provenance tests have a
  real HEAD. The original checkout commit and source SHA remain in Windows test logs.

## Reproduction

Model-free regressions:

```sh
npm run test:full
npm run test:windows
```

Desktop probes connect to an already-running native Desktop service and verify its
parent is `OpenCode.exe`. They install a fixed tarball into a generated fixture,
disable only the global Sortie plugin in that fixture, and load the candidate under
a unique fixture plugin ID. They wait for active registration before any model call.
This avoids accepting a successful operation performed by a different loaded plugin.

```sh
node scripts/mission-desktop-probe.mjs <fixed.tgz> <fresh-output-dir> executed
node scripts/mission-desktop-probe.mjs <fixed.tgz> <fresh-output-dir> NO_START
node scripts/mission-desktop-probe.mjs <fixed.tgz> <fresh-output-dir> compaction
```

The compaction probe queues one native Worker compaction before execution, replaces
only its summary with a minimal diagnostic checkpoint, and requires the real Worker
to recover its durable handoff, bind and execute once. The observer does not perform
the operation or edit mission results. Raw history, package and hashes remain under
`_testenv/desktop-efficiency/`; only summarized results belong in Git.

## Validation record

The 2026-09-27 probes use OpenCode V2 Desktop 2.0.18, its native server PID 14784,
and parent `OpenCode.exe` PID 23724. Actual Operator/Coordinator model:
`openai/gpt-6-sol#xhigh`; actual Worker model: `openai/gpt-6-luna-fast#max`.
The final fixed candidate SHA-256 is
`780e501e3cf125dff4b4e6edcace9a431601c73ec7cec0189227123fc3c65936`, package version
`0.12.15`, runtime marker `0.12.15-operation-efficiency-v1`.

- Executed/reward-zero: root `ses_f1f0f6e02ffeW1ZXgZMLs1oMa2`, one Worker, one plan,
  one native `node run.mjs`, exit 0, attempts 1, reward 0, completed/succeeded.
  Selected target survived the short follow-up. First run 36.148 seconds after goal
  creation; probe elapsed 98.359 seconds. Estimated full-history cost $0.142854,
  no unpriced requests.
- NO_START/exit-zero: root `ses_f1f0f6e01ffe6RfDZ5ny4HrLXp`, one Worker and one
  native command, exit 0, attempts 0, outcome `not-started`. The actual
  `complete_mission` call returned `not-ready`; no success receipt. Operator's final
  response explicitly reported non-execution and did not retry. Elapsed 155.125
  seconds, estimated cost $0.115839, no unpriced requests.
- Native compaction: root `ses_f1f0f6e02ffdLO2E33xz4nbFSK`, one Coordinator and
  one Worker. Completed compaction `msg_0e0f1dc03001uDJgVViHui4Ta4` occurs after
  the initial handoff read; the same Worker rereads the exact path, binds successfully,
  executes once and completes with reward 0. Elapsed 189.782 seconds, estimated
  **full exported history** cost $0.177675, no unpriced requests. Active context alone
  omits pre-compaction requests; the probe now exports the complete history.
- `npm run test:full`: 1,268 passed, zero failed/skipped, 78 test files, WSL exit 0.
  Snapshot SHA-256 `b1ce1fce8d75e0e522e9463e2f0f03812af210d0495b7013be12d6b502a927f5`.
- `npm run test:windows`: six passed, zero failed/skipped, after the full suite.

Final-candidate probes total an estimated $0.436368. All priced probe history,
including the initial wrong-plugin run and intermediate candidate, totals $0.797670
plus 18 unpriced requests from that initial run. These are usage-price estimates,
not provider billing. Setup-only registration retries made no model calls.

The first probe is excluded from candidate validation: duplicate plugin registration
left the old global plugin active, and its Operator used an unintended model. The
corrected fixture verifies active candidate registration and actual model messages.
The intermediate candidate completed but required a second evidence-only Worker;
that observation drove the output-mutation correction above.

Generated fixture `.opencode/` installations were removed after native active-session
checks. Fixed tarballs, hashes, full exported histories, cost records, mission state
and cleanup observations remain in `_testenv/desktop-efficiency/`.

These are short native orchestration regressions. They do not establish full anko
benchmark performance or a Luna/SOL quality comparison. The historical exact
`handoff-uninspected` cause remains unproven; cache expiry and serial overlap have
independent pre-fix reproductions.
