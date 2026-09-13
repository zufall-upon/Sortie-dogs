# Provisional benchmark reference

## Current status

Benchmark execution is paused. The 2026-09-12 qualification attempt using
`0.9.11-bench.2` ended with `IN_PROGRESS` rather than `DONE` after 36.1 minutes.
Its expected-operation check failed (`delivery-not-complete`), and no official
verifier ran. Its task-check completion is **unknown**, not zero or a pass.
The following repeated trial was cancelled, and the third did not start.

Diagnosis found that successful revalidation of an already-satisfied criterion
was incorrectly recorded as a failed unit because it added no new criterion.
The resulting no-progress counter prevented completion. The correction separates
validation success from new coverage. Native validation evidence is still required;
missing evidence is a process defect rather than an inferred acceptance failure.

The corrected path was checked using the same real OpenCode CLI session and goal:
three revisions changed from `succeeded / failed / failed` to three successful
settlements, followed by a successful terminal receipt and persisted return report.
This regression check is **not** a benchmark quality result for the fixed release.

## Which historical observations are shown?

The README shows the latest archived **complete measured pair**, not the best result
selected from unfinished attempts. That pair ran on 2026-09-10 with Sortie v0.9.5.
It is retained as a reference while a fresh paired benchmark is frozen. It is not
an aggregate over three tasks and does not describe current-release performance.

- Task: `datacurve/anko-typed-variable-bindings` (DeepSWE).
- Task source commit: `435ee89ec2f2e2289f33b0da4f992f0b7b7266b9`.
- Candidate base: `3f269a72ff69398b1250c584171f32d12c0d8085`.
- OpenCode CLI: `1.18.29`, WSL; host Git, pinned Go toolchain.
- Bare: normal OpenCode, Sol/high, no Sortie plugin or assets in effective config.
- Sortie: v0.9.5, Terra/high coordinator with normal routing; observed premium model: Sol.
- One trial per arm, Bare then Sortie, separate fresh workspaces, 90-minute wall limit.
- Official task instruction and verifier artifacts were pinned. Local verifier path
  adaptations were used; Docker and Runta were not used.
- Both expected-operation checks passed and both one-shot official verifiers returned
  reward **0**. Sortie passed 8/9 new-feature checks but only 93/94 retained checks.

This compares two product configurations, including their model choices. It does not
isolate orchestration from model quality, establish a population success rate, or
control provider-side cache and time-of-day effects. The single observation per arm
is also its reported median.

Later standalone observations are retained rather than hidden by that pair:

- 2026-09-12 v0.9.9 recovery candidate: expected-operation PASS, verifier reward 0,
  F2P **5/9**, P2P **94/94**, 15.6-minute agent wall, $2.15 API-equivalent total cost.
  It had no fresh paired Bare control and is not pooled with the 2026-09-10 pair.
- The subsequent `0.9.11-bench.2` qualification failed to complete, as described above.

These observations do not demonstrate steadily improving quality across versions.

## Metric definitions

- **Verified PASS:** official verifier reward 1, after a valid completed operation.
  Partial checks do not count as a verified task pass.
- **Task-check completion:** passed F2P (fail-to-pass, task-specific new-feature)
  checks divided by all F2P checks. Existing P2P checks are shown separately, so the
  94 retained checks cannot mask missing task behavior.
- **Estimated API-equivalent total cost:** coordinator plus child-session usage,
  priced per model. It is not a subscription invoice or an attributable cash charge.
- **Agent wall:** timed agent run through process termination, excluding setup and
  official verifier execution. It is not the audit script's message-window duration.
- **Premium-model token share:** Sol tokens divided by all observed model tokens;
  tokens include input, cache read/write, output, and reasoning. This is not cost share.

The API-equivalent estimates use the audit tool's frozen 2026-07-30 standard
short-context rate schedule, per million tokens:

| Model | Input | Cached input | Cache write | Output / reasoning |
| --- | ---: | ---: | ---: | ---: |
| Terra | $2.00 | $0.20 | $2.50 | $12.00 |
| Sol | $5.00 | $0.50 | $6.25 | $30.00 |

Formula: sum each model's token category multiplied by its corresponding rate,
divided by 1,000,000. Reasoning is priced as output under this convention. Pricing
coverage is 100% for this pair. The model/token categories and unrounded estimates
are retained in the [reference data](benchmarks/provisional-reference.json).

## Reading the quality–cost plot

The vertical axis is task-check completion, not Verified PASS or a general quality
score. The horizontal axis is estimated API-equivalent cost. Both plotted points
are historical, single-task observations with **0/1 Verified PASS**.

Bare vs Sortie is the primary local comparison. Codex, Pi, and Oh My OpenCode are
listed in a muted reference panel, without invented coordinates. Published results
from different task sets, models, harnesses, or cost definitions cannot be placed on
the same quantitative axes as if they were directly comparable. These observations
are not FrontierHarness leaderboard submissions (`methodology_comparable: false`).
