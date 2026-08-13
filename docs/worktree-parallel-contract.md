# Worktree Parallel Contract v0.1

This document fixes the contract for the `0.5.x` isolated implementation loop. Card 05 completes
typed worker-only commit artifact production. Card 06 owns cleanup and serial integration.

## Envelope

- `version`: `0.1.0`.
- `mode`: `parallel` or `single-worker`.
- `max_workers`: `1` for single-worker; `2..3` for parallel.
- `tasks`: bounded DAG nodes with stable task, worktree, branch, base SHA, dependencies, and scope.
- `artifacts`: immutable worker commit evidence tied to the task, exact base SHA, and branch.
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

## Card 05 Commit Artifacts

Only the typed worker produces an artifact. Its exact fields are task ID, base SHA, direct-child
managed branch, commit SHA, canonical unique changed paths, change fingerprint, and validation
evidence. Validation evidence is an absolute executable plus up to 128 arguments, successful exit
code, and fingerprint. It never includes raw diff, logs, stdout, or stderr.

The producer re-verifies the commit object and accepts scoped A/M/D changes only. Changed paths must
stay inside that task's declared write scope. Dirty, outside-scope, staged, wrong-base, wrong-branch,
process, and lease failures reject the artifact. Ignored control and dependency files may exist but
are never committed or evidenced. Normal Git, remote, and main mutations are forbidden. Before lease
release, all subprocesses and tools must be terminal. Parallel tasks do not run canonical validation
independently; combined validation belongs to serial integration.

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
- Card 04: `ParallelDispatchCoordinator` first durably stores a normalized preparing intent under the
  Git common directory, creates all two or three worktrees from one clean base outside dispatch-state
  authority, then reloads and reconciles exact lifecycle identities before finalizing the run. Restart
  adopts only the complete exact set; partial, ambiguous, or non-ready inventory archives a failed
  preparation and never duplicates or removes lifecycle artifacts. It reserves only DAG-ready immutable descriptors,
  and binds each random dispatch ID to one host call and optional child session. Its ScopeLeaseRegistry
  authority serializes cross-process state transitions. Terminal outcomes are control-only. Failure
  suppresses transitive descendants while independent branches continue. Cancellation suppresses only
  not-yet-running work. Restart snapshots never redispatch running work; explicit reconciliation marks
  an unprovable running call abandoned. Scope overlap or ambiguous dependencies return pre-creation
  serial fallback; schema, cycle, stale base, dirty tree, corrupt state, and abandoned workers stop.
  Cancellation is coordinator-root-only and suppresses pending or reserved tasks without force-stopping
  running workers or cleaning worktrees. A run archives automatically after every task is terminal or
  suppressed and no task is reserved or running. Up to sixteen bounded archives retain task, dispatch,
  worktree, branch, path, base, call, child-session, and outcome identities for Card 05/06 artifact and
  cleanup ownership; a distinct contract may then prepare a new run. Session idle never cancels.
- Card 05: completed commit artifact production.
  The typed producer durably accepts the verified artifact before returning it to the worker. A restart
  may replay that exact running-task artifact but never creates a second commit. Parent completion only
  changes the task phase after write-gate release and process/tool quiescence are proven.
- Card 06: cleanup, serial integration, and stale rejection.
- Card 07: conflict remediation and combined validation.
- Card 08: Windows/WSL RPT and efficiency audit.
