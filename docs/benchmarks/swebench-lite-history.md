# SWE-bench Lite result history

[README](../../README.md#swe-bench-evaluation) · [Measurement contract](../benchmark-completion-contract.md)

These scores belong to their fixed candidates, not the current release. SWE-bench is an optional
measurement, not a mandatory release gate. Inference completion, Mission acceptance and official
resolution are separate outcomes; official local scoring is not leaderboard registration/acceptance.

## Lite test300

Fixed **v0.12.24** resolved **170/300 (56.67%)** in one pass@1 campaign, with nine empty patches,
zero official evaluation errors and frozen predictions/trajectories for all 300 instances.
Workers used `openai/gpt-6-luna-fast#max`; Operator, Coordinator and Review used
`openai/gpt-6-sol#xhigh`. This is a system result, not a Luna-only comparison or Verified/full score.

- [Technical report and per-repository results](swebench-lite-v01224-test300-2026-09-29.md).
- [Public predictions, logs and trajectories](https://github.com/zufall-upon/sortie-dogs-swebench-lite-20260929).
- Confirmed inference expense **$162.99**; separate unknown-pricing budget hold **$34.60**, not known expense.
  Report and predictions are hash-bound in the technical report.

## Lite dev23

Official results on the same 23 public instances:

| Candidate / benchmark adapter | Resolved | Empty patches | Run conditions | Details |
| --- | ---: | ---: | --- | --- |
| v0.10.6 candidate (`859c396`) | 4/23 (17.4%) | 5 | Four inference slots | [Handoff](../swebench-handoff-2026-09-21.md) |
| Frozen v0.10.14 build | 6/23 (26.1%) | — | Four slots; $1.50/task | [Per-task results](../benchmark-v0.10.14-dev23.md) |
| v0.12.8 (`e0f8cef` adapter) | 5/23 (21.7%) | 9 | Four slots; budget amended across two batches; 30-minute timeout | [Campaign](../swebench-v0128-dev23-2026-09-26.md) |
| v0.12.8 (`84ccdf1` main adapter) | 6/23 (26.1%) | 2 | Fresh run; four slots; 30-minute timeout | [Main-integrated run](../swebench-main-84ccdf1-dev23-2026-09-26.md) |
| v0.12.15 (`0c9690d`) | 5/23 (21.7%) | 3 | Fresh ext4 retry; four slots; 40-minute timeout | [Campaign](../swebench-v01215-dev23-2026-09-27.md) |
| v0.12.16 (`9b05a34` release; `b1a6c0e` runner) | 4/23 (17.4%) | 5 | Eight slots; 40-minute timeout | [Campaign](../swebench-v01216-dev23-2026-09-27.md) |
| v0.12.19 (`24f5386` release; matched rerun) | 8/23 (34.8%) | 0 | Eight slots; effective $2/instance; 40-minute timeout; one inference timeout | [Provenance](swebench-v01220-operation-observability-2026-09-28.md) |
| v0.12.20 (`628eb81` release) | 7/23 (30.4%) | 0 | Eight slots; effective $2/instance; 40-minute timeout | [Result and caveat](swebench-v01220-operation-observability-2026-09-28.md) |
| v0.12.25 (`49eb1e4` release) | 7/23 (30.4%) | 0 | Eight slots; $2/instance; $30 total; 20-minute progress check / 40-minute maximum | [Comparison baseline](#v0131-dev23-2026-09-30) |
| v0.13.1 (`d19e8be` release) | 8/23 (34.8%) | 0 | Eight slots; $2/instance; $46 total; staged timeout; GPT-6.1 Sol + Luna Fast | [Run summary](#v0131-dev23-2026-09-30) |

Every row submitted 23 predictions; an empty patch counts against the score, not as a missing
evaluation. The v0.10.14 report does not separately summarize empty patches; its estimated cost was
$15.75 and median runtime 15.2 minutes. v0.12.15 is the separately approved fresh run after an
initial `/tmp` quota failure, not a second score for that failed attempt. Five v0.12.16 runners timed
out. The v0.12.19 row is the corrected effective-cap run; an earlier 7/23 run lacked that cap and
is not a same-condition comparison. v0.12.20 lost `sqlfluff__sqlfluff-2419` relative to the corrected
run; that single difference does not establish causation.

Budgets, versions, adapters and conditions changed. This is observed history, not controlled
head-to-head comparison or a general success-rate/model-quality claim.
[Earlier qualification references](../benchmark-reference.md) remain separate.

## v0.13.1 dev23 (2026-09-30)

One fresh pass@1 run and one official harness evaluation resolved **8/23**, versus **7/23** for
v0.12.25. New resolution: `pylint-dev__astroid-1333`; all seven prior resolved IDs were retained.
By repository: marshmallow 2/2, pvlib 0/5, pydicom 2/5, astroid 3/5, pyvista 0/1, sqlfluff 1/5.

- This was the requested fresh run after a host restart. The interrupted initial run is excluded;
  the scored run made one attempt per instance without inference retry.
- Dataset revision `6ec7bb89b9342f664a54a6e0a6ea6501d3437cc2`, public rows and all 23 official image
  IDs matched v0.12.25. Both used `official-image-testbed` and sequential official scoring.
- Operator/Coordinator/Reviewer/Advisor used `openai/gpt-6.1-sol#xhigh`; Workers used
  `openai/gpt-6-luna-fast#max` across all instances. Harness and total budget changed too, so the
  extra resolution cannot be attributed to the model change alone.
- Inference: 20 normal completions, timeouts for `pvlib__pvlib-python-1154` and
  `sqlfluff__sqlfluff-1763`, one agent failure for `pvlib__pvlib-python-1854`.
  All patches were scored: 23 evaluations, zero empty patches, evaluation errors or infrastructure failures.
- Eight slots; $2/instance; $46 campaign cap. The timeout used a 20-minute progress check and
  40-minute hard maximum, not 40 minutes guaranteed per instance.
- Known estimated inference cost **$17.73**; unknown-usage hold **$1.98** is separate. Inference wall
  time about 81 minutes, official scoring 7.2 minutes.
- Release commit `d19e8be0d21180cc23ad2ae4b853d846a18e77bc`;
  package SHA-256 `99300ceec0c3eee4fa1f984fed50d15d58b2ff4455df0041850ecd63514b0a51`.
  OpenCode 2.0.20; official harness 5.0.2.
- Local evidence: `_testenv/swebench-v0131-dev23-20260930-r2/result-summary.json`.
  Generated predictions, databases and raw logs are not committed.
