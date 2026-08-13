# Worktree Parallel Contract v0.1

This document fixes the contract for the `0.5.x` isolated implementation loop. Card 01 defines data
and policy only. It does not create worktrees, branches, commits, leases, subprocesses, or Git state.

## Envelope

- `version`: `0.1.0`.
- `mode`: `parallel` or `single-worker`.
- `max_workers`: `1` for single-worker; `2..3` for parallel.
- `tasks`: bounded DAG nodes with stable task, worktree, branch, base SHA, dependencies, and scope.
- `artifacts`: worker commit evidence tied to the task and its exact base SHA.
- `failure`: one typed failure or `null`.
- `baseline_metrics`: measured values or `null` when no baseline was captured.

Task IDs, worktree IDs, and branch names are unique. `base_sha` and `commit_sha` are lowercase
40- or 64-hex Git object IDs. Scope and changed paths are repository-relative. Absolute paths,
traversal, and empty paths fail closed.

## Dependency DAG

Dependencies must name another task in the same contract. Self-dependencies, unknown dependencies,
and cycles are invalid. A dependency does not waive scope isolation: dependent tasks with overlapping
write-related scopes remain invalid and must run through a serial contract instead.

## Scope Matrix

- write/write same file: conflict.
- write/write ancestor or descendant: conflict.
- write/read or read/write same file, ancestor, or descendant: conflict.
- read/read overlap: allowed.
- segment siblings such as `src/a.ts` and `src/a.tsx`: allowed.
- disjoint scopes: allowed.
- comparisons are case-insensitive so one contract stays safe across Windows and WSL.

An artifact's `changed_paths` must stay inside that task's declared write scope. Parallel tasks do not
run canonical validation independently; combined validation belongs to the serial integration phase.

## Typed Failures

- `stale-base`: stop. Never merge or rebase automatically.
- `scope-overlap`: use an explicit `single-worker` contract after the parallel attempt ends.
- `dirty-tree`: stop. Never stash, reset, or clean automatically.
- `abandoned-worker`: stop until lease reconciliation proves ownership is stale.
- `merge-conflict`: stop for bounded conflict remediation.

Only `scope-overlap` permits `fallback: single-worker`. Every other failure requires `fallback: stop`.

## Metrics

- `wall_clock_ms`: elapsed wall-clock milliseconds.
- `total_tokens`: full-run tokens, or `null` when unavailable.
- `estimated_cost_usd`: estimated API cost, or `null` when unavailable.
- `conflict_count`: typed scope or integration conflicts.
- `validation_count`: canonical validation executions.

Never substitute zero for unavailable token or cost data. Baseline comparisons require the same task,
models, worker bound, validation conditions, and measurement window.

## Follow-on Ownership

- Card 02: durable cross-process scope leases.
- Card 03: worktree and branch lifecycle.
- Card 04: dependency-aware dispatch.
- Card 05: commit artifact production.
- Card 06: serial integration and stale rejection.
- Card 07: conflict remediation and combined validation.
- Card 08: Windows/WSL RPT and efficiency audit.
