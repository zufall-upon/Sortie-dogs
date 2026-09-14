# Provisional benchmark reference

## Current status

The README shows the latest completion-filtered local case study, run on 2026-09-14.
Bare OpenCode and Sortie-dogs v0.9.12 each contributed three completed runs on the same
frozen task. Bare needed three attempts; Sortie needed five because two attempts returned
`INTERRUPTED`. They were executed as separate serial batches rather than interleaved matched
pairs. No completed run achieved official verifier reward 1.

- Task: `datacurve/anko-typed-variable-bindings` (DeepSWE).
- Task source commit: `435ee89ec2f2e2289f33b0da4f992f0b7b7266b9`.
- Candidate base: `3f269a72ff69398b1250c584171f32d12c0d8085`.
- OpenCode CLI: `1.18.29`, WSL; host Git, pinned Go toolchain.
- Bare: normal OpenCode, Sol/high, no Sortie plugin or assets in effective config.
- Sortie: v0.9.12, Terra/high coordinator with normal routing and delegated workers.
- Three completed runs per configuration, separate fresh workspaces, 90-minute wall limit.
- Official task instruction and verifier artifacts were pinned. Local verifier path
  adaptations were used; Docker and Runta were not used.
- Bare reached its normal operation gate and official verifier in all three trials.
  Each candidate returned reward **0**, F2P **1/9**, and P2P **94/94**.
- Sortie's three completed runs returned reward **0**, with F2P **7/9**, **8/9**, and
  **8/9**; all passed P2P **94/94**.
- Two additional Sortie attempts returned `INTERRUPTED`. Their official verifiers did not
  run, so correctness is unknown. They are excluded from completed-run quality, time, and
  cost aggregates, but their count and estimated acquisition cost remain reported.

This compares two product configurations, including different model routes. It does
not isolate orchestration from model quality, establish a population success rate,
control provider-side cache and time-of-day effects, or support a matched-pair test.
The observed host cost field was zero and is not treated as attributable cost evidence. API-equivalent
costs are instead estimated from exported root and child session tokens, attributed to each message's
recorded model. Bare used Sol. Sortie root messages used Terra and implementation child messages used
Sol. All exported root token totals match the corresponding CLI-stream records.

## Metric definitions

- **Verified PASS:** official verifier reward 1, after a valid completed operation.
  Partial checks do not count as a verified task pass.
- **Task-check completion:** passed F2P (fail-to-pass, task-specific new-feature)
  checks divided by all F2P checks. Existing P2P checks are shown separately, so the
  94 retained checks cannot mask missing task behavior.
- **Agent wall:** timed agent run through process termination, excluding setup and
  official verifier execution. It is not the audit script's message-window duration.
- **Model steps and tokens:** values observed from the OpenCode CLI event stream across
  the root and child sessions. The zero host cost value is not interpreted as free use.
- **Estimated API-equivalent cost:** observed input, cached input, output, and reasoning
  tokens priced with the frozen 2026-07-30 standard short-context schedule. Reasoning is
  priced as output. It is neither an invoice nor subscription usage.

| Model assumption · per million tokens | Input | Cached input | Output / reasoning |
| --- | ---: | ---: | ---: |
| Terra | $2.00 | $0.20 | $12.00 |
| Sol | $5.00 | $0.50 | $30.00 |

Bare's median completed-run estimate is **$3.53**, totaling **$10.69** across three runs.
Sortie's completed runs estimate to **$4.11**, **$2.85**, and **$2.79**: median **$2.85**,
total **$9.74**. Its two interrupted attempts add **$6.20**, making total acquisition cost
for three completed Sortie runs **$15.94**. Completed-run cost and acquisition cost answer
different questions and are both reported.

Exact trial values are retained in the [reference data](benchmarks/provisional-reference.json).

## Reading the results

Task-check completion is not Verified PASS or a general quality score. Aggregate F2P
and P2P counts include only the three completed candidates per configuration; interrupted
Sortie candidates are unknown rather than zero. Filtering by completion answers the narrow
three-completed-run comparison, while attempts-to-completion and interruption cost expose
the reliability penalty instead of hiding it.

Bare and Sortie are the two local configurations. Codex, Pi, and Oh My OpenCode are
listed in a muted reference panel, without invented coordinates. Published results
from different task sets, models, harnesses, or cost definitions cannot be placed on
the same quantitative axes as if they were directly comparable. These observations
are not FrontierHarness leaderboard submissions (`methodology_comparable: false`).
