# Provisional benchmark reference

## Current status

The README shows a completion-filtered local case study, run on 2026-09-14, followed by a
separate v0.10.1 RC qualification reference. Bare OpenCode and Sortie-dogs v0.9.12 each
contributed three completed runs on the same frozen task. Bare needed three attempts; Sortie
needed five because two attempts returned `INTERRUPTED`. They were executed as separate serial
batches rather than interleaved matched pairs. No run in that historical batch achieved official
verifier reward 1. A later single v0.10.5 Luna/max qualification success is documented separately
below and is not aggregated with the historical batch.

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

## v0.10.1 RC qualification

The 2026-09-17 v0.10.1 RC reference is one standalone, qualification-only run. The RC label
identifies an unreleased working-tree candidate; the benchmark tarball's package metadata remained
`0.10.0`.
The package SHA-256 was `67582ee023c3bd57813262e292c067a3f90f30d61c01d8caf6f91f09ae78f61d`.
It reached terminal `DONE`, then the localized Docker-free official verifier returned reward **0**,
F2P **8/9**, and P2P **94/94**. Agent wall was **1,391,159 ms** (23.2 min), the CLI stream
recorded 41 model steps, and the operation created three implementation child sessions.

The exact API-equivalent estimate is **$4.478613**. A read-only audit walked the root and all
seven descendants, pricing 84 assistant requests and 4,215,698 tokens with 100% coverage; no
message was unpriced, pending, or outside the tree. It attributes $2.057850 to Sol/high,
$1.169238 to Sol/low, and $1.251526 to Terra/xhigh. The one-microdollar rounding difference
between these displayed model buckets and the total comes from rounding only after per-request
pricing.

The audit used the product's 2026-09-14 Standard pricing snapshot and applied rates per request,
including cached input, reasoning as output, and the OpenAI long-context band above 272,000 input
and cache tokens. It is an API-equivalent estimate, not an invoice or subscription usage.

| Model assumption · per million tokens · v0.10.1 RC | Input | Cached input | Output / reasoning |
| --- | ---: | ---: | ---: |
| Terra | $2.00 | $0.20 | $12.00 |
| Sol | $4.00 | $0.40 | $20.00 |

An earlier delivery-incomplete run was a different packed source snapshot
(`32dea0a3c33bb658633b6c4edf15a109e347fd362f2c9ab9e6d235cf51fc1852`). Its full-tree audit
found 90 priced assistant requests, 3,704,649 tokens, 100% pricing coverage, and **$4.276578**;
it reached neither a terminal outcome nor the verifier. It is excluded from this RC's acquisition
cost. Observed spend across both distinct snapshots was **$8.755191**, but that is development spend,
not the cost to acquire this fixed RC result. This RC has one attempt and one completed run, so its
same-snapshot additional interruption cost is **$0**. It has no fresh Bare control and is neither a
matched comparison nor a FrontierHarness leaderboard result.

This compares two product configurations, including different model routes. It does
not isolate orchestration from model quality, establish a population success rate,
control provider-side cache and time-of-day effects, or support a matched-pair test.
The observed host cost field was zero and is not treated as attributable cost evidence. API-equivalent
costs are instead estimated from exported root and child session tokens, attributed to each message's
recorded model. Bare used Sol. Sortie root messages used Terra and implementation child messages used
Sol. All exported root token totals match the corresponding CLI-stream records.

## v0.10.5 Luna/max qualification

The 2026-09-18 v0.10.5 candidate reference is one standalone, qualification-only success on the
same pinned task and localized Docker-free verifier. It uses Terra/xhigh for the root and Luna/max for
the v0.10 implementation worker. It reached `DONE`; the verifier returned reward **1**, F2P **9/9**,
and P2P **94/94**. Agent wall was **2,583,374 ms** (43.1 min), the CLI stream recorded 25 model
steps, and the operation created three implementation child sessions.

The candidate package SHA-256 was
`8c8f17dc8b60891307cb6862db246b213102419207f0ef4273e3250cb41502b6`. Its package metadata reported
`0.10.4` because the version bump followed qualification; it is a source-snapshot reference for the
v0.10.5 release, not a released-package measurement.

The full root-plus-five-descendant audit priced 106 assistant requests and 8,830,131 tokens at
**$1.719999** API-equivalent cost: **$1.436725** for Terra/xhigh and **$0.283274** for Luna/max.
Pricing coverage was 100%, with no unpriced or pending request. This is one verified-success
reference only. It does not estimate a success rate, reliability, or same-snapshot acquisition cost.

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
  tokens priced per request. Reasoning is priced as output. It is neither an invoice nor
  subscription usage. Historical and RC rate schedules are retained separately below.

The historical 2026-09-14 Bare and v0.9.12 case study retains the frozen 2026-07-30
standard short-context schedule used when those values were collected:

| Model assumption · per million tokens | Input | Cached input | Output / reasoning |
| --- | ---: | ---: | ---: |
| Terra | $2.00 | $0.20 | $12.00 |
| Sol | $5.00 | $0.50 | $30.00 |

Bare's median completed-run estimate is **$3.53**, totaling **$10.69** across three runs.
Sortie's completed runs estimate to **$4.11**, **$2.85**, and **$2.79**: median **$2.85**,
total **$9.74**. Its two interrupted attempts add **$6.20**, making total acquisition cost
for three completed Sortie runs **$15.94**. Completed-run cost and acquisition cost answer
different questions and are both reported. These historical cost values are not same-rate
comparisons with the v0.10.1 RC estimate.

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
