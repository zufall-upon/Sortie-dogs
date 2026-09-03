# Five-Lane Luna Execution Fabric v0.8

Status: proposed architecture

## Decision

Sortie-dogs v0.8 will add an automatic five-lane Luna execution fabric without removing the stable
Terra-to-Sol implementation route:

```text
Terra coordinator
        |
        v
decompose accepted work into an exact dependency DAG
        |
        +-- no useful safe parallel width --> Sol x1 serial worker
        |
        +-- parallel width >= 2 -----------> Luna fabric, capacity 5
                                                   |
                                                   v
                                      ready units run concurrently
```

The product objective is critical-path wall-clock reduction. Five lanes are execution capacity, not a
quota and not five copies of one task. The normal Luna path assigns different ready units to different
lanes. It never launches five duplicates and waits for all of them.

Terra chooses the route automatically. Users do not select a model, mode, or lane count.

## Performance invariant

The Luna fabric exists only to convert safe task-level parallelism into lower wall-clock time:

```text
serial time  ~= sum(all unit durations)
fabric time  ~= sum(max unit duration in each dependency wave) + integration tail
```

The implementation must protect this invariant:

- Dispatch every ready independent unit in one coordinator turn, up to five active lanes.
- Do not spend useful lanes on duplicate candidates while required independent work is ready.
- Do not add a full-run barrier when a wave barrier is sufficient.
- Do not run canonical validation once per unit.
- Do not update the target once per unit or wave.
- Do not claim race-to-first until the host exposes a proven bounded asynchronous child primitive.

If the accepted job has no useful parallel width, it routes to Sol instead of manufacturing parallelism.

## Baseline prerequisite

The v0.8 product decision is:

- `dog-worker` is the stable Sol serial implementation role.
- `dog-luna-worker` is available only through an admitted Luna fabric descriptor.
- `dog-worker` and the existing dedicated implementation roles default to `openai/gpt-5.6-sol`
  `medium`; `dedicatedWorkerModel` may relocate only this serial route.
- `dog-luna-worker` is a separate fixed `openai/gpt-5.6-luna` `max` route; direct `modelRouting`
  cannot replace either fixed route.
- Role identity and the durable dispatch record identify the selected route without session inference.
- A serial override naming the Luna fabric model is invalid rather than silently collapsing the stable
  and fabric roles into an unauditable route.

The shipped 0.7.0 source currently defaults the dedicated `dog-worker` target to
`openai/gpt-5.6-luna` `max`; Sol is available through `dedicatedWorkerModel` and as the stronger
escalation target. v0.8 must specify its new precedence explicitly while preserving the historical
0.7.0 record.

This routing correction is required before live fabric dispatch, but it does not define or delay the
execution architecture.

## Goals

- Reduce elapsed implementation time through up to five concurrent, distinct Luna units.
- Preserve the existing single Sol worker as the automatic route for unsuitable jobs and failed units.
- Keep one bounded implementation unit per worker Task.
- Reuse exact-base worktrees, write gates, scope leases, commit artifacts, validation, review, and target
  compare-and-swap.
- Keep the target unchanged until the complete candidate passes final validation and review.
- Accumulate successful waves into a hidden candidate so dependent work can continue without exposing
  partial acceptance.
- Make route, schedule, artifacts, fallback, restart, and final promotion deterministic and auditable.

## Non-goals

- Five same-task candidates are not the normal execution mode.
- Luna does not decompose work, broaden scope, perform release operations, or decide target promotion.
- v0.8.0 does not implement hedging, straggler preemption, or mid-wave refill.
- Parallel target writes, partial target acceptance, automatic rebase after a target race, and
  multi-candidate merge are forbidden.
- Users do not tune the scheduler during normal operation.

## Control plane

### Roles

- `dog-coordinator`: Terra. Fixes acceptance, gathers missing manifest evidence, decomposes work, creates
  the DAG, selects the automatic route, schedules waves, and owns final validation and promotion.
- `dog-worker`: Sol. Runs the existing serial path and accepts unit-level demotion from the fabric.
- `dog-luna-worker`: Luna. Executes exactly one admitted unit in one isolated worktree.
- `dog-reviewer`: Reviews only the final combined candidate when the existing risk policy requires it.

The Sol and Luna worker assets should be generated from one shared worker body plus small role-specific
deltas. Existing one-unit handoff, immutable manifest, write-gate, and validation behavior stays aligned.

### Automatic route

Routing is based primarily on parallelizability and effect safety, not a numeric difficulty score.
Terra emits a typed DAG contract; runtime validation applies a short disqualifier policy.

The whole job routes to Sol before fan-out when any condition holds:

- Decomposition produces fewer than two required units.
- The DAG has no concurrent ready width after path ownership is assigned.
- Any required scope cannot be expressed as exact repository-relative manifest paths.
- A dependency is unknown, cyclic, or cannot be assigned safely.
- Concurrent units require the same environment-exclusive resource, such as the single `_testenv`, a
  fixed port, or a global installation target.
- The request performs release, publish, tag, version, remote-state, credential, or irreversible
  external operations.
- The coordinator cannot determine which unit owns a shared write path.

Everything else may enter the fabric. Shared repository files such as `package.json`, lockfiles,
schemas, generated indexes, and configuration are not automatic whole-job disqualifiers. Every unit
touching one shared path is pinned to the same logical lane and runs serially there. Other disjoint lanes
continue concurrently.

Malformed contracts and unknown classifications route to Sol. There is no weighted admission score,
perfect-validation prerequisite, shadow-only product mode, or user-facing opt-in.

## DAG contract

Each unit declares:

- Stable unit ID.
- Acceptance items owned by the unit.
- Exact read and write manifests.
- Dependency unit IDs.
- Validation command and level.
- Shared-path ownership keys.
- Required exclusive resources.
- Stable scheduler order for ties.

The runtime validates exact paths, known dependencies, acyclicity, acceptance ownership, and resource
ownership before creating a worktree. Terra may use bounded Scout evidence to close a manifest gap, but
Luna never discovers or changes the DAG.

The current `ParallelDispatch` invariants remain valid for its manual independent-task contract. The
automatic fabric adds a coordinator-generated provenance value and a run-level DAG contract. It reuses
the existing lifecycle and artifact primitives without interpreting overlapping concurrent scopes as
safe.

## Barrier-aware scheduler

### Ready queue

A unit is ready when all predecessors exist in the current hidden candidate snapshot. Ready units are
ordered by descending remaining DAG depth, then stable unit ID. Historical duration evidence may refine
the order when it is available for the same validation class; absence of history falls back to DAG depth.

The scheduler assigns ready units to at most five logical lanes:

- Units with the same shared-path ownership key remain on one lane.
- Concurrent lanes must have disjoint write-related scopes and exclusive resources.
- Long remaining dependency paths receive lanes first.
- Every required ready unit is preferred over speculative or duplicate work.
- A job uses only its useful width. Two ready units use two lanes; seven ready units use five now and two
  in the next wave.

### Waves

v0.8.0 uses the host's synchronous Task barrier honestly:

```text
candidate snapshot N
        |
        +-- Luna unit A
        +-- Luna unit B
        +-- Luna unit C      one concurrent Task turn, capacity 5
        +-- Luna unit D
        +-- Luna unit E
        |
        v
wave barrier -> verify artifacts -> candidate snapshot N+1
```

One Task owns one bounded unit. A logical lane is a scheduling and ownership identity, not a worker that
silently executes an unbounded chain.

Each active unit receives a worktree from the exact current candidate snapshot. After the wave, the
coordinator verifies and consumes its artifact, then releases that unit worktree. The next wave receives
fresh exact-base worktrees from the new immutable candidate snapshot. This avoids rebasing or resetting a
lane worktree after sibling changes.

Units assigned to one logical lane may overlap paths across waves because they are serial and each new
wave starts from the accepted predecessor snapshot. Units active in the same wave may not overlap their
write-related scope or exclusive resources.

This is barrier-aware level scheduling, not fully work-conserving refill. A lane that finishes early waits
for the current wave's slowest required lane. Real speed still comes from replacing the serial sum inside
each wave with its maximum duration.

### Termination

The fabric terminates when every required unit is present in the hidden candidate, no lane is active, and
final validation and review have completed. It stops without target mutation when a required unit cannot
complete, the candidate state becomes invalid, or the observed target head changes before promotion.

## Hidden candidate lifecycle

The run starts with one exact target SHA and a durable hidden candidate ref at that SHA.

After each wave:

1. Verify every returned artifact against its unit, wave base, branch, scope, and validation evidence.
2. Apply passing artifacts to a temporary candidate in stable dependency and unit order.
3. Reject conflicts or outside-scope changes before advancing the durable candidate ref.
4. Optionally run one declared cheap wave-level integration check, never the full canonical suite per
   unit.
5. Persist one immutable wave snapshot and advance the hidden candidate ref atomically.
6. Build the next ready queue from that snapshot.

The target branch remains unchanged throughout all waves. Dependent units branch from the latest hidden
snapshot, not from partially updated target state.

After every required unit is present:

1. Run canonical validation once on the final candidate.
2. Apply the existing risk-based review policy to that combined candidate.
3. Verify the target still equals the run's observed target SHA.
4. Perform exactly one compare-and-swap from that target SHA to the final candidate head.
5. Clean exact owned worktrees and hidden refs.

A lost target CAS is fail-closed. The fabric does not rebase, retry onto the changed target, or report
partial success.

## Unit failure and Sol demotion

A Luna unit failure does not immediately discard independent progress:

- One bounded remediation remains inside the unit's immutable manifests.
- A second typed implementation or validation failure demotes that unit to Sol.
- Sol receives the same unit contract in a fresh worktree from the last good candidate snapshot.
- A successful Sol artifact enters the hidden candidate through the same verification path.
- Dependents remain blocked until the demoted unit reaches the candidate.

If Sol cannot complete a required unit, the run stops and the target remains unchanged. Completed
independent artifacts may remain only as bounded diagnostic evidence; they are not partially promoted.

Infrastructure failures retain their existing typed recovery rules. Restart reads the durable run,
candidate snapshot, active-wave descriptors, and accepted artifacts. It must not redispatch an unproven
running call, advance the candidate twice, or perform a second target CAS.

## Why this is fast

For five independent units of similar duration:

```text
Sol serial path:  T1 + T2 + T3 + T4 + T5
Luna fabric:      max(T1, T2, T3, T4, T5) + one integration tail
```

For a mixed DAG, elapsed work is the sum of wave maxima. Critical-path-first ordering and shared-path
lane affinity minimize avoidable waves. One combined final validation and one target CAS keep serial
integration from scaling with unit count.

Remaining v0.8.0 limits:

- One straggler controls each wave.
- An early-finished lane cannot refill mid-wave.
- Deep dependency chains remain serial by definition.
- Final validation and review form one serial tail.

These limits are visible metrics, not reasons to replace distinct-unit parallelism with duplicate work.

## Later async capability

The only planned primitive for same-task speculation is a bounded, cancellable child invocation with a
wall-clock deadline. It must be demonstrated on a real host before use.

Once proven, it enables:

- Mid-wave lane refill.
- Straggler deadlines and Sol takeover.
- A hedge only when a lane would otherwise remain idle.
- First-valid candidate selection without waiting for a useless duplicate.

Hedging must never delay required work or extend a wave barrier. It is an optional v0.8.x optimization,
not the source of v0.8.0 speed.

## Observability

Record bounded evidence per run:

- Automatic route and disqualifier reason.
- DAG width, depth, unit count, and shared-path ownership.
- Wave count, ready-queue order, lane assignment, utilization, and per-unit duration.
- Luna success, remediation, Sol demotion, and terminal failure.
- Artifact verification, candidate snapshot, final validation, review, CAS, restart, and cleanup results.
- Total, coordinator, and delegated tokens, model steps, children, cache ratio, and estimated API cost.

Do not use children, steps, or total tokens as standalone success gates. They explain speed and cost but
do not override wall-clock outcome or target safety.

## Pre-implementation value proof

Before production routing, DAG, and durable recovery implementation, run one test-only vertical slice in
`_testenv`. The slice must exercise the economic and host assumptions that justify the architecture:

- One fixed fixture split into five distinct, independent implementation units.
- One matched Sol worker executing those five units serially.
- Five Luna children executing the same units concurrently through one synchronous Task turn.
- Isolated worktrees and exact unit scopes.
- Candidate combination equivalent to the planned hidden-candidate integration tail.
- One final validation after combination.
- No production target update, route change, or public runtime claim.

This is not a model-only microbenchmark. Elapsed time includes dispatch, the slowest Luna child, artifact
handling, candidate combination, and final validation. Record the same duration and cost fields for both
routes.

Continue production implementation only when the slice demonstrates at least 35 percent lower wall-clock
duration, estimated API cost no greater than 1.5 times Sol, five-child host capacity, and zero target or
scope corruption. A no-go result stops the production cards before scheduler and state-machine cost is
incurred. The fixture and raw measurement conditions remain unchanged for later RPT comparison.

## Practical acceptance gate

Use one fixed decomposable fixture containing at least four independent units and one dependency chain.
Run the unchanged fixture through the Sol serial route and the Luna fabric under the same validation and
cache conditions.

v0.8.0 live acceptance requires:

- At least 35 percent lower wall-clock duration than the matched Sol run.
- Estimated API cost no greater than 1.5 times the matched Sol run.
- Zero target corruption.
- Zero accepted compare-and-swap violation.
- Every failure reaches Sol demotion or a typed terminal result without a stuck run.

No-go conditions:

- The fabric is slower than Sol on the decomposable fixture.
- A partial candidate reaches the target.
- A stale target is overwritten or treated as success.
- A concurrent scope or exclusive-resource conflict escapes runtime validation.

Existing mixed audit windows remain context only. Public speed claims require the matched fixture result.

## Delivery sequence

The first live release has five-lane capacity. Value proof precedes production implementation, then work
proceeds in dependency order:

1. Prove the five-lane vertical slice in `_testenv`; stop on a no-go result. Done.
2. Define v0.8 Sol and Luna role precedence and preserve 0.7.0 history. Done.
3. Add the Luna-only worker role from the shared worker contract. Done.
4. Add coordinator-generated DAG provenance, exact unit contracts, and automatic disqualifier routing. Done.
5. Extend durable dispatch to a run-level DAG with at most five active, disjoint Luna units. Done: the
   durable run records its `sol-serial` or `luna-fabric` route, `sortie_prepare_luna_fabric` maps one
   admitted contract onto exact-base worktrees, and role binding follows that route instead of the
   session. Units whose write-related scopes overlap still route to Sol until wave scheduling supplies
   fresh per-wave worktrees.
6. Add barrier-aware ready-queue scheduling, shared-path lane affinity, and fresh worktrees per wave. Done:
   the durable v5 state retains the complete admitted DAG while materializing only the active wave,
   orders ready units by remaining depth then ID, prevents mid-wave refill, and advances only from a
   candidate containing every completed wave artifact. Prior wave worktrees are cleaned before fresh
   exact-candidate-base worktrees are created; the target authority remains unchanged.
7. Add hidden candidate snapshots, dependency-ordered wave integration, final validation, and one target
   CAS. Done: the runtime applies accepted artifacts in stable unit order through a temporary index,
   advances only its owned hidden ref, validates the final detached candidate once, binds review evidence,
   and updates an unchanged non-checked-out target through one CAS.
8. Add bounded Luna remediation, unit-level Sol demotion, restart recovery, and exact cleanup. Done: a
   terminal attempt-1 Luna failure waits for the wave barrier, pins completed sibling artifacts, cleans
   their exact worktrees, and emits one fresh attempt-2 descriptor at the same candidate base and scope.
   Attempt 2 binds only `dog-worker`; durable cleanup/create intent permits restart adoption. Successful
   promotion or review rejection removes owned candidate and source refs without force cleanup.
9. Add matched speed and cost metrics, WSL CLI RPT, and Windows Desktop RPT; enable the live route when
   the practical acceptance gate passes.

Worktree, concurrency, schema, routing, and write-gate changes require focused tests,
`npm run test:full`, and both runtime acceptance paths before release.

## v0.8 evidence runtime

The five-lane fabric is the execution foundation for the
[v0.8 evidence-driven runtime roadmap](v0.8-evidence-runtime-roadmap.md): content-addressed evidence,
typed run replay, compiled acceptance coverage, Failure Swarm, critical-path Sol escalation, and
experience-driven automatic routing. That work stays inside v0.8.x and starts only after the vertical
slice and production RPT pass their go gates. v0.9 remains unallocated reserve.
