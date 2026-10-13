# Low-cost whole-request workload progress

Display: `全体作業量 47/100（概算）`. This is estimated completed workload divided
by estimated total workload of the current user request, not elapsed time,
token/cost consumption, budget occupancy, completed execution units, a fixed
stage percentage, or completion of a larger product outside the request.

## Work, execution and completion

The Mission owns a persistent `workQuantity` breakdown. Work identity is separate
from execution-unit identity: one unit can cover multiple jobs; multiple units
can share an artifact or validation job. Coalescing units with the same final
suite does not erase the pre-coalescence work breakdown. Shared paths and
commands count once. Replans retain omitted work and cumulative observations;
cancelled same-requirement continuations retain the request scope. Explicit
replacement or new work starts another scope and archives the predecessor.

Ordinary plans derive relative quantities from concrete outputs, declared
validation, required operations and unallocated requirements. Broad permissions
are not expanded or scanned. Constraints are not treated as additional
implementation outputs. Required existing Review, result submission and final
acceptance remain in the estimate. Requested manual acceptance is separately
visible and closed by existing whole-request acceptance, not by a new approval
tool. New requirements add coarse residual work even when they affect an
existing file. Plan omission does not silently remove old remaining work.

The fallback relative quantities are artifacts 8, unexpanded implementation 12,
unallocated requirement/operation 8, validation/manual acceptance 3, Review 4,
submission 2 and existing final acceptance 1. They are rough workload estimates,
not claims that file count measures effort, or fixed shares of every request.
Numbers adapt to the concrete work breakdown. A plain single-unit plan still
has intermediate progress without optional estimates or another planning turn.

`start_mission` and `plan_units` accept optional `work_quantities` in their
ordinary invocation, outside the execution contract:

```json
[
  {
    "id": "feature",
    "kind": "artifact",
    "relative_weight": 90,
    "bindings": { "paths": ["src/a.ts", "src/b.ts"] },
    "checkpoints": [
      { "id": "a", "paths": ["src/a.ts"], "relative_weight": 2 },
      { "id": "b", "paths": ["src/b.ts"], "relative_weight": 1 }
    ]
  }
]
```

Bindings can use existing paths, commands or requirement IDs. Checkpoint IDs
can also reuse existing completed native todos. Children divide the parent's
weight; parent and children never both enter the sum. Optional malformed,
unmatched or duplicate estimates fall back or are ignored; they cannot reject
dispatch, invent write permission, add validation or revise the host budget.
Omitting optional metadata in a later plan retains the declared breakdown.

## Observations, not new certification

Existing native target reads, successful edits, command outcomes and completed
todos provide partial estimated credit. Target read defaults to 0.08, observed
change to 0.55, a completed todo to 0.8 and an observed successful check to 0.9.
Broad scopes divide change credit among estimated targets (at least four);
distinct observed targets move the estimate, repeated edits do not accumulate
credit. No activity means no fabricated advancement. A saved successful unit
settlement supplies full credit for its bound work, not Mission acceptance.

Native success is not a fresh-source certificate. Later edits or concrete Review
findings can reduce the estimate. Terminal operation failure can complete
run-once result collection without proving a success requirement. Scope/work
estimate changes expose an estimate revision (`見積更新`); the value is allowed
to decrease. There is no `max(previous, current)` smoothing.

`100/100` requires the existing formal full-request completion record. It closes
remaining estimates even when display bindings were incomplete; optional
metadata cannot add a completion gate. The display never invokes completion, grants acceptance or
changes execution/Review decisions. Saved checks retain their existing
freshness/evidence semantics; this feature does not recheck them.

## Runtime cost and transports

- `projectWorkQuantity()` uses stored scalars and a bounded list of remaining
  kinds. It does not scan the work list or history during rendering.
- Event reduction/plan extraction is local CPU work over the known breakdown.
  No model query, progress-only turn, status request, archive search, source
  scan/hash, subprocess, network request or repeated validation is introduced.
- Native observations are bounded and coalesced in memory. Existing Mission/run
  writes persist them; no progress-specific state write is added. Unsaved
  observation-only credit can be lost on process failure; saved credit survives.
- The existing Coordinator local-state observer is reused unchanged in cadence.
  Worker/Reviewer Tasks reuse cached progress and live sinks, without another
  polling loop or state read. Multiple enclosing/nested Tasks can share a sink.
- Native direct/Worker tool results carry the same projection. Native mutation
  acknowledgements show one short caption per changed estimate; this adds a small
  amount of output text, not a dedicated model request. Task metadata and
  status/control outputs also retain the projection. Codex Mission CLI progress
  reuses workload already present in its native tool receipts. Actual file-read
  contents and command stdout stay unchanged in every transport.
- Dynamic progress is excluded from system/continuation prompts, task references,
  plan hashes, handoff/control files and admission contracts. Optional tool-schema
  documentation is static. Existing execution/model overrides remain unchanged.

This is not literally zero CPU or output bytes. It removes paid inference and
extra verification from *calculating* progress. Development consultation and
tests are separate costs, not runtime progress work.

## Development and validation

Design consultation: `openai/gpt-6-astra`, native general-agent session
`ses_ecc02bedcffeF1rZpx9pG2hvDf`, read-only. The previous fixed global stage-weight
proposal was rejected as a reduction of the request. Implementation and tests:
GPT-6.1 Sol in `feat/work-quantity-progress-20261013`. Astra consultation cost was
not returned by the agent tool and is not claimed to be zero.

Regression coverage includes ordinary single-unit intermediate values, broad
scopes, coalescence/deduplication, optional weights/subdivision/fallback,
scope expansion/replans/continuation, findings/invalidation, terminal operation
failure, formal100, native Direct/Worker/V2/Codex transports, independent live
sinks, output truncation and unchanged execution-plan/reference/control bytes.
The pure-render test rejects filesystem/hash/process/network access, rejects
work-list/history access and records the time for 10,000 scalar projections.
Native V2 fixtures assert no synthetic model turns.

Validation commands, exit codes, source SHA-256 and timings are retained by the
existing `_testenv/wsl-*/` controller. No product Mission, global installation,
active candidate override, paid product session or release operation is modified.
