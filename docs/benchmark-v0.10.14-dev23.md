# SWE-bench v0.10.14 evaluation

## Summary

A frozen Sortie-dogs v0.10.14 candidate was evaluated on 23 fixed `dev` tasks.

- Official verifier PASS: 6 / 23
- Scored FAIL: 17 / 23
- Infrastructure blocked: 0 / 23
- Total estimated model cost: $15.754279
- Median agent runtime: 15.2 min

`PASS` means the official SWE-bench result reported `resolved: true`.
`FAIL` means the official scorer returned a result with `resolved: false`.
`INFRA` is reserved for a task without an official scored result; none occurred in this run.
Harness-side timeouts and patch-index failures remain visible in the table notes even when the official scorer recorded an empty patch as a scored failure.

## Frozen conditions

- Candidate: `sortie-dogs-0.10.14.tgz`
- Candidate SHA-256: `f2caf67268a5f69b67a252a0d84bfc5ad09db82684aa8c1e0f5c49f8d2986993`
- Runtime profile: `v010`
- Root agent: `dog-operator`
- Dataset: `princeton-nlp/SWE-bench_Lite`
- Dataset revision: `6ec7bb89b9342f664a54a6e0a6ea6501d3437cc2`
- Split: `dev`
- Attempts per task: 1
- Parallel inference slots: 4
- Per-task budget: $1.50
- Official scoring workers: 1

The candidate, task input, model routes, budgets, tools, and verification procedure remained fixed across all 23 tasks.
Inference and official scoring were separate phases. The official scoring state covered all 23 tasks and reported exit code 0.

## Per-task results

| Task | Result | Cost | Time | Note |
| --- | --- | ---: | ---: | --- |
| `marshmallow-code__marshmallow-1343` | PASS | $0.55 | 13.8 min | — |
| `marshmallow-code__marshmallow-1359` | PASS | $0.46 | 20.8 min | — |
| `pvlib__pvlib-python-1072` | FAIL | $0.41 | 14.7 min | patch not applied |
| `pvlib__pvlib-python-1154` | FAIL | $0.54 | 13.4 min | patch not applied |
| `pvlib__pvlib-python-1606` | FAIL | $0.29 | 11.7 min | patch not applied |
| `pvlib__pvlib-python-1707` | FAIL | $0.45 | 15.2 min | patch not applied |
| `pvlib__pvlib-python-1854` | FAIL | $0.72 | 21.9 min | patch not applied |
| `pydicom__pydicom-1139` | FAIL | $0.74 | 21.4 min | — |
| `pydicom__pydicom-1256` | PASS | $0.58 | 17.1 min | — |
| `pydicom__pydicom-1413` | FAIL | $0.87 | 16.9 min | — |
| `pydicom__pydicom-1694` | PASS | $0.34 | 14.0 min | — |
| `pydicom__pydicom-901` | FAIL | $0.89 | 30.0 min | agent timeout; empty patch scored |
| `pylint-dev__astroid-1196` | FAIL | $1.35 | 30.0 min | agent timeout; empty patch scored |
| `pylint-dev__astroid-1268` | FAIL | $0.59 | 12.5 min | — |
| `pylint-dev__astroid-1333` | PASS | $0.98 | 20.4 min | — |
| `pylint-dev__astroid-1866` | FAIL | $0.34 | 10.3 min | — |
| `pylint-dev__astroid-1978` | FAIL | $0.36 | 9.6 min | — |
| `pyvista__pyvista-4315` | FAIL | $0.52 | 13.1 min | patch not applied |
| `sqlfluff__sqlfluff-1517` | FAIL | $0.81 | 15.2 min | patch index failure; empty patch scored |
| `sqlfluff__sqlfluff-1625` | FAIL | $0.98 | 30.0 min | agent timeout; empty patch scored |
| `sqlfluff__sqlfluff-1733` | PASS | $1.18 | 18.1 min | — |
| `sqlfluff__sqlfluff-1763` | FAIL | $1.24 | 23.1 min | — |
| `sqlfluff__sqlfluff-2419` | FAIL | $0.59 | 14.4 min | — |

## Reading the table

The cost column is the estimated model cost recorded for each task, not an invoice.
Time is agent runtime through the task terminal state; official verifier time is excluded.
Patch application failures, timeouts, and patch-index failures are retained as notes rather than relabeled as official infrastructure failures because the official scorer still produced a scored result for every task.

The full runbook and future-run contract are in [SWE-bench Lite benchmark](swebench-lite-benchmark.md) and [benchmark completion and correctness](benchmark-completion-contract.md).
