# v0.12.20 operation observability: retrospective and PR scope

## Observed result

The public v0.12.20 package at commit `628eb8129fa11bd0de6f68524275aa307764ca68`
(SHA-256 `1ec65ce140ce3faab88b10769edc5f966e4a9fce6cd993d188be30125af90522`)
ran the 23 pinned SWE-bench Lite dev cases once. The official SWE-bench 5.0.2 report
resolved **7/23**, with zero infrastructure, empty-patch or scoring errors. The
v0.12.19 run with the effective $2 per-instance limit resolved **8/23**;
`sqlfluff__sqlfluff-2419` was the only lost resolution. These scores describe
different inference runs, not a causal measurement of one change. The v0.12.19
run without the effective per-instance cap also resolved 7/23, but it is not a
strict same-condition comparison.

The corrected v0.12.19 run used release/runner commit
`24f5386ee0d0d73a08ed5942020e4665603d7994` and public package SHA-256
`37f7938f5fb8af81ca0f407d5f097f3038f63ad0b13002361858390e659a484d`.
It pinned the SWE-bench Lite `dev` revision
`6ec7bb89b9342f664a54a6e0a6ea6501d3437cc2`, eight inference slots,
the effective $2 per-instance cap, a 40-minute per-instance timeout, one
attempt per case and official-image testbeds. Inference produced 23 nonempty
patches (22 succeeded, `sqlfluff__sqlfluff-1763` timed out); official scoring
completed all 23 predictions with **8 resolved, 15 unresolved and zero empty
patches or scoring errors**. Predictions SHA-256:
`62da5f1a75c03ea87acd4a4912d8ea28b39a6d947bab383682529632900187df`;
official report SHA-256:
`61e9eccbc72384871bc2cffc2dedb58c689f32849eb17caf69a17230f11d1347`.
Run spend was $12.55950188 plus $0.21700352 held for unknown usage. The
original result, manifest and official report remain under
`_testenv/swebench-v01219-dev23-matched-20260927/` in the benchmark checkout.

The v0.12.20 run spent $11.95648556 with no unknown usage. Conservative campaign
exposure reached $222.90097688/$285 (remaining $62.09902312). Per-instance
reservations were capped at $2. Predictions SHA-256:
`130116d51e4b00379955e2d8e024c5335ef728d09665701a480bb25a452fd894`;
official report SHA-256:
`fe54a089f84c00daf41e4f8111468308dc1aa9d00e57d0f407c4aff9ca59f867`.
Raw evidence remains under `_testenv/swebench-v01220-dev23-20260928/` in the
benchmark checkout. Do not commit the dataset, DB, predictions or live logs.

## Self-critique and concrete failure

- I translated a sensible prelaunch **CLI/configuration check** into an
  impossible acceptance criterion: observing the **actual live** supervisor
  state before launch. At 23:53:20 UTC the Worker inspected a preview;
  the first live state observation was at 23:53:52, after launch. The
  independent Reviewer correctly returned `FINDINGS`; the actual limit was
  enforced, but the self-imposed timing condition was not met. A preview is
  not evidence of the real run.
- I did not verify how the mission host recognizes an operation command before
  spending on inference. The declared launch was invoked as
  `node scripts/swebench-lite-supervisor.mjs --start ... | tee .../supervisor-start.json`.
  V2 shell call `call_a8oXJHYLPCzx5TVphQJbYuzO` started at 23:53:36 UTC;
  the host only records shell inputs that match the declared command after
  whitespace normalization (`src/plugin/profiled.ts`). The pipeline was not
  recorded, so `missionExecutionStatus` remained `not-started` despite the
  completed supervisor, 23 predictions and official scoring. The launch
  pipeline's exit 0 alone would not prove that the `node` process succeeded;
  the independent run state and score do prove the run happened.
- I spent review turns requesting excerpts of already retained runtime/model,
  provenance and budget data. The third review exposed the real chronological
  defect. A source-review round should not be triggered solely because an
  unchanged published package is being evaluated; a native execution record,
  result and hashes are the appropriate evidence for that operation.
- The parent Task's progress reader reports unit transitions, not per-case
  supervisor progress. One 23-case unit therefore stayed visibly `running`
  while individual cases completed. The supervisor already retains per-case
  progress in its state file; this PR does not add another polling service or
  interrupt the Worker to force a status message. A native, opt-in progress
  bridge is a separate improvement if a repeat run demonstrates the need.
- The Mission's cumulative Worker-unit allowance was exhausted at 32. That
  was not the cause of the scoring result and increasing it would not supply
  the missing prelaunch observation. Evidence-only review and artifact reads
  do not require a new Worker, so no budget reset or new approval is proposed.

## Change and boundaries

1. For a declared operation that the same Worker tries to append with a shell
   pipeline, redirection or chained command, give an actionable diagnostic
   **before execution**. The Worker can issue the exact declared command in
   the same unit, then save output separately. Unrelated exploratory shell
   work and exact declared commands remain unchanged. No new approval,
   permission or scope boundary is introduced.
2. Tell Operator/Coordinator/Worker the viable sequence: check supported flags
   and budget with preflight before launch; observe the **live** limits after
   launch; collect the original run's terminal state and official result.
   Neither a preview nor a successful detached launch is a completed score.
3. Use the already-supported low-risk review skip only when evaluating an
   unchanged published artifact **and no material operational risk remains**.
   A `release` label alone does not justify a source review, but this run's
   prelaunch chronology was a real operational defect: the independent review
   was useful and must not be suppressed by an automatic package-based skip.

This PR **does not** retrospectively alter the v0.12.20 mission's host record,
convert its independent `FINDINGS` to PASS, or rerun the 23 cases. It also does
not loosen exact-command matching: accepting arbitrary pipelines as equivalent
would hide changed exit semantics and risk attributing a different process's
result to the declared run. A later host-native, non-destructive reconciliation
API may be considered separately if repeated V2 histories establish the need.
