# Worktree Parallel Contract v0.1

This document fixes the contract for the `0.5.x` isolated implementation loop. Card 01 defines the
data and policy envelope. Card 03 now owns isolated linked-worktree and branch lifecycle; commits,
dispatch, and integration remain outside this contract.

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
- Card 03: completed. `WorktreeLifecycle` pins a clean primary checkout, creates two or three locked
  linked worktrees from the exact pin, caps all managed inventory phases at three records globally,
  persists restart-safe inventory under a durable cross-process authority in the Git common directory,
  and only removes an unchanged, exactly owned worktree and branch through non-force Git operations.
  Its worktree root is fixed at `sortie-dogs/managed-worktrees-v1` beneath that common directory;
  caller-selected external roots are rejected. Each actual checkout is an unpredictable direct child
  named from its deterministic identity prefix plus a full random ownership nonce. `pathPrefixFor()`
  exposes only the deterministic prefix; callers obtain an existing exact path from create or inventory
  results. Creation does not precreate the target: under inventory authority, Git adds directly into the
  nonexistent nonce path, then the lifecycle verifies its real path, nonzero safe filesystem identity,
  Git list entry, ref, HEAD, and lock before readiness.
- Cleanup rechecks exact cleanliness and ownership, then moves the checkout to a new unpredictable
  direct-child quarantine path with `git worktree move`. The lifecycle verifies that Git now lists the
  quarantine path with the same filesystem identity, HEAD, ref, and lock ownership, persists the
  removing path, unlocks, rechecks, and invokes non-force removal only on that quarantine path. Move or
  verification failure marks the artifact orphaned without deleting unknown content. Durable nonces,
  explicit branch ownership, and compare-and-delete refs retain branch protections.
- Native filesystem device and inode identities must be available and nonzero. Values persisted in
  inventory are bounded safe integers. Windows reports device zero and may expose inode values outside
  JavaScript's safe integer range, so the lifecycle deterministically normalizes those native bigint
  identities with a volume-bound SHA-256 token; a zero Windows inode still fails closed. Setup process
  trees and hook count are bounded, hooks run without holding global inventory authority, and timeout
  terminates the process tree. Setup failure, Git identity mutation, divergence, foreign ownership, root
  replacement, or an ambiguous restart phase preserves the artifact for manual recovery.
- The nonce prevents an untrusted writer from preparing a predictable target before the command or
  replacing a predictable removal path after verification. Principals able to read and modify the Git
  common directory during an operation remain trusted: they can discover nonce paths and already can
  rewrite repository Git metadata. The lifecycle does not claim protection against that privilege.
- Card 04: dependency-aware dispatch.
- Card 05: commit artifact production.
- Card 06: serial integration and stale rejection.
- Card 07: conflict remediation and combined validation.
- Card 08: Windows/WSL RPT and efficiency audit.
