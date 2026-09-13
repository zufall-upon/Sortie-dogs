# Worker dispatch constraints: history and simplification boundary

Investigation date: 2026-09-11. This document records historical evidence and proposed boundaries;
it does not remove gates or authorize new scope. Commit dates below use Japan time.

## Evidence and limits

The sources are Git introduction diffs, tests added with those changes, and observed host Task/Read/
bind records. A test establishes intended behavior, not that the guarded failure occurred in a real
run. Release commit subjects alone do not establish which production incident motivated each line.
Performance impact has not been quantified by a matched historical experiment.

## Timeline

### 2026-08-04: explicit write-gate authorization

- `a920b86` — `fix: close write gate audit gaps`.
- Introduced the `handoff-uninspected` path and strengthened explicit binding against accidental or
  stale authorization. File edits or session idle were not to imply permission to write.
- This mechanism predates v0.9.0; it is already present in the ancestry of v0.1.11.
- `d914333`, later that day — `Fix recoverable write-gate handoff flow`.
- Explicitly classified local handoff defects as recoverable, not terminal tasks or user questions.
  The specified recovery was exact-path inspection, same-worker resume, then bind. Unchanged bindings
  were intended to be idempotent; changing the underlying manifest was a different operation.

**Purpose worth retaining:** writes use the intended current manifest, and a local handshake problem
does not abandon the user's task. Requiring an additional model round trip is an implementation
choice, not the purpose itself.

### 2026-08-13: preserve-only same-task resume

- `7d7497c` — v0.4.8, `Release v0.4.8`.
- Added dispatch preflight and `resume_contract_redefinition` rejection.
- Changed the resume template to task identity plus `resume_delta`, retaining the earlier effective
  digest rather than resending acceptance, role, validation counts, or scout history.
- Tests reject changed facts/history, duplicate modes, malformed deltas, and repeated contract fields.

**Purpose worth retaining:** resumption should not silently replace the accepted task or reset retry/
validation history. The original resume design was itself intended to reduce retransmission.
Current recovery guidance must agree with that design: a worker-generated suggestion to add
`role: blocker-resolution` is not evidence that the preserve-only protocol accepts that field.

### 2026-09-09 08:43: v0.9.0 goal-bound delivery

- `1369e4b` — `Release v0.9.0 goal-bound delivery`.
- Added the goal ledger, cumulative budgets, continuation tickets, criterion-level evidence, and
  detailed planner declarations in the runtime assets.
- Intended distinctions include unit completion versus whole-goal completion, requested runtime
  proof versus proxy/document evidence, and actual host execution versus model-reported execution.
- Added tests for stale revision evidence, proxy evidence, expected-negative/document outcomes,
  cumulative spend across renames/resumes, and terminal invalidation of continuation authority.

**Purpose worth retaining:** a small passing fixture or changed document does not prove a requested
MVP; task renaming does not reset spend; completed checks belong to the candidate actually checked.
That does not require a model to repeat common source/candidate/fixture fields for every criterion.

### 2026-09-09 15:17: v0.9.1 declaration rejection before launch

- `f287e4f` — `Release v0.9.1 goal control reporting`.
- Replaced silent `null`/unchanged-state paths for absent or invalid goal declarations with concrete
  field defects and `HandoffDeniedError` before routing/reservation.
- Removed the earlier fallback from a missing explicit goal fingerprint to the handoff acceptance
  fingerprint, preserving the distinction between root-goal and unit-continuity identities.
- Required a complete initial declaration and complete typed declarations when declaration fields
  were present. Tests explicitly exercise missing/invalid declaration rejection before dispatch.

**Important regression boundary:** detailed fields were described in v0.9.0, but v0.9.1 made missing
fields a hard startup rejection. Returning to the old silent-null path without redesign can reintroduce
unprovable or incorrectly classified completion; it is not a complete operational repair.

### 2026-09-10: formatting guidance

- `ca5506a` — v0.9.3, `Release v0.9.3 dispatch continuity and review evidence`.
- Added the flat `key: value` repair guidance. This explains why current errors tell the coordinator
  to expand long criterion blocks. More detailed error instructions do not demonstrate that the
  underlying duplication is necessary.

## Current failure mechanisms confirmed in host records

1. **Initial declaration rejection:** a Task with ordinary acceptance/validation/context but no goal
   declaration was rejected as designed by the v0.9.1 startup gate. This is an interface burden, not a
   source implementation failure.
2. **Read/bind overlap:** in an observed child, Read started at relative 0 ms, bind at +2 ms, bind
   returned denial at +18 ms, and Read completed at +25 ms. Read did happen; bind was attempted before
   inspection completed. This supports an ordering/coordination defect, not removing manifest scope.
3. **Resume mismatch:** after that denial, the worker suggested blocker-resolution and the parent
   sent `role: blocker-resolution` beside a preserve-only resume. The existing protocol rejected it.
   Recovery guidance, Task construction, and dispatch validation are not interoperating correctly.

These observations explain the specific failed starts. They do not establish that every v0.9.x
failure or all runtime overhead has the same cause.

## Boundary for the next implementation

Retain:
- the accepted change scope and canonical validation;
- actual execution outcomes and their association with the checked candidate;
- the distinction between unit progress and complete user-goal delivery;
- cumulative accounting and explicit user budget decisions;
- the existing task and history across same-task resume.

Simplify or repair:
- keep shared declaration data once and reference it, instead of repeatedly transcribing it;
- separate the evidence needed to claim completion from boilerplate demanded before work can start;
- coordinate in-flight Read/inspection and bind inside the host;
- make recoverable-denial guidance construct a resume the dispatcher accepts;
- compare retained semantic identity when appropriate instead of equating repeated text with change.

Before adopting each simplification, retain the original regression cases and add the observed valid
path: short initial dispatch, overlapping Read/bind, and unchanged same-child recovery. Required scope
changes and genuine stale evidence must still be distinguished from formatting or scheduling details.
The operational acceptance criterion is fewer failed starts and user interventions, alongside correct
candidate validation and completion—not merely a more permissive parser or more rejection tests.
