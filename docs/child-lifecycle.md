# Cancellable Child Lifecycle

Verified child-session binding registers an immutable lifecycle descriptor in the
run flight ledger: run, unit, attempt, predecessor, candidate, route, child, call,
and wall-clock deadline. The default deadline is ten minutes. A host may set
`SORTIE_CHILD_DEADLINE_MS` to a positive integer up to 2147483647 milliseconds.
Restart preserves the recorded deadline rather than allocating a new allowance.

One lifecycle implementation is shared by implementation, diagnosis, and
escalation adapters. It does not launch a second recovery executor or bypass the
normal validation, review, writer-exclusion, or candidate-CAS gates.

On expiry or explicit cancellation, the plugin records stop intent, asks the host
to abort the child, and waits for terminal/tool evidence. Artifact production is
non-interruptible: an open or unknown artifact window defers the stop. No new
worker tools are admitted once cancellation starts, except write-gate release.

The lifecycle checks gate and durable lease release and uses the existing managed
worktree cleanup. Accepted artifact commits are retained by private Git refs
before their worktrees are removed. Unstarted suppressed worktrees can be cleaned
without pretending that a child ran. Target and accepted hidden snapshots are
not advanced by cancellation.

Only seven satisfied reconciliation conditions permit one `child.terminal`
record. Stop intent and terminal records are idempotent across retry and restart;
conflicting or late identities are rejected. A local lease-handle close is not
proof of durable lease release. Unknown host state, missing abort support, dirty
worktrees, or failed cleanup remain unconfirmed rather than fabricating success.

A slow host returns `runtime-pending` after a bounded wait without starting a
second overlapping stop operation. The cancellation tool returns `cancelling`
while child/resource reconciliation is pending and `cancelled` only after it is
confirmed. An archived scheduling snapshot alone is not a resource-release proof.

Tests exercise real parent/child processes, Git worktrees, host callback adapters,
artifact-window deferral, accepted siblings, lease release, late results, and
durable replay. They do not claim containment against hostile kernels or detached
processes outside the host's normal process-tree ownership.
