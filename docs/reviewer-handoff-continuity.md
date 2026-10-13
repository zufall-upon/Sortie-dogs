# Correction history without permanent actor ownership

## Observed failure and scope

The released v0.13.16 workflow rejected the original conversation's next authorized
implementation unit with `correction-owner-continuation-required`. The retained
correction run was already successful, its native author self-recheck was recorded,
and the host reported no unresolved findings. `repair_review` returned
`correction-ready` without a Task. This was a control-flow dead end, not an
implementation failure, missing user approval, or exhausted remaining unit.

The previous repair demonstrated original-Reviewer correction and subsequent result
reporting. It did not demonstrate admission or execution of the remaining development.
This repair addresses correction-history continuation and legitimate actor handoff;
it does not claim to resolve every constraint introduced since v0.9.

## Astra consultation and design decision

Requested consultation used `openai/gpt-6-astra`, read-only. Its recommendation was
to separate retained history from actual active ownership across planning,
correction, review and handoff. A successful-correction exception alone leaves the
same failure after interrupted work, unresolved findings, or an unavailable author.

- Remove the duplicate history-only refusals in `declareMissionUnits` and
  `OperatorRuntime.prepareOnce`. Retained Git lifecycle metadata is not itself an
  active writer either.
- Retain default context reuse. `repair_review.author_session_id` can select another
  existing available Reviewer; ordinary `plan_units` already supports Worker or
  controller/direct correction and remaining implementation.
- Permit useful independent review through `review_mission.mode` and
  `reviewer_session_id`, without making another review mandatory because an actor,
  excerpt or tag changed.
- Preserve findings, native self-recheck, actual source authors, prior checks and
  their original bindings in normal handoffs and review input. New planning or actor
  selection is not findings resolution, acceptance, or independent PASS.
- Recovered Reviewer Tasks can use their instructed `finish_direct_unit` advisory
  result. Their native terminal still owns settlement; that call does not fabricate
  a terminal, spend another unit, or accept the Mission.
- Treat an empty optional operation string on an implementation plan as omitted,
  matching the observed native input. Actual operation commands remain required.

## Autonomy, efficiency and visibility

- **Autonomy:** existing authorization admits legitimate next work and actor choice.
  No handoff approval, new Mission, forced conversation, acceptance-before-work, or
  actor-identity security layer was introduced.
- **Efficiency:** reuse useful context, supplied findings and existing observations.
  Actor changes alone do not request rediscovery or repeated unchanged checks.
  Changed candidate/input checks still require real validation. An existing active
  execution is joined or completed, not redundantly dispatched.
- **Visibility:** terminal correction status explains next implementation/review
  choices instead of redirecting to a Task that cannot exist. Original author,
  findings, native call/prompt/check identity and cumulative accounting remain
observable. Self-recheck remains distinct from independent approval.

Astra's final read-only check identified a detail-reference bug: projecting the
prior run against the mutable current-state path would lose access to its check
snapshots after replan. The handoff now points at the existing sequence-qualified
run archive, with a regression checking the referenced run identity. No extra
verification or approval protocol was added to address it.

Actual native execution reconciliation, conflicting-writer protection, host
permissions and explicit user restrictions remain. These existing mechanisms are
not replaced by another consent protocol. The retained single-run engine is not a
new parallel scheduler; unrelated reads should not be described as conflicting
writers.

Retained validation in a new implementation handoff is provenance/context, not
another executor's freshly executed proof. Optional read-only review reuses the
existing actual check observations without a new implementation unit. General
cross-author adoption of successful checks into a new implementation admission is
still a separate validation-audit theme; this change does not claim to solve it.

## Required verification

Regressions cover successful, failed and unresolved terminal correction history
followed by Worker/direct implementation; durable cold restart; another existing
Reviewer correcting failed work; optional independent review without repeat checks;
and original findings/authorship/evidence/budget preservation. Existing native
terminal, active-owner, model and source-freshness regressions remain relevant.

The original affected conversation must additionally admit its remaining approved
unit and perform useful development. A fixture, copied conversation, startup-only
probe, another self-recheck, or reporting an existing result cannot establish that
outcome. Preserve its cumulative 38-unit authorization and all prior consumption,
original dirty work and completed evidence. No actual product Start, product paid
request, product Session, package launch, acceptance, Go or publication is authorized
by this verification.

Validation commands, source/package hashes, actual models, timing, cumulative cost,
observed development and any residual blocker are recorded with the verification
result. Private source, conversations and generated evidence stay outside Git.

## Integrated validation and fixed candidate

- `npm run test:full`: exit 0; 1,933 PASS, 2 skipped, no failures across 120
  files. WSL controller duration 317.148 seconds (build 12.354 seconds;
  common-suite runner 301.250 seconds). Snapshot SHA-256
  `7d630769feec6aa7dcc7208c044653cfbb4eae8c51baee4e406fd82677bafb58`.
- Sequential `npm run test:windows`: exit 0; 18 PASS. Native build 9.033
  seconds; platform tests 4.105 seconds.
- The tested native dist was packed without another build using
  `npm pack --ignore-scripts --pack-destination _testenv/reviewer-handoff`.
  Fixed development archive SHA-256
  `e4f9b4395118d58927deff758b5b86420379cf62318639482f2063c34e5cab1e`.
  This is not the released v0.13.16 archive, a release, or global application.
- Original Location loaded that fixed candidate in native OpenCode 2.0.27,
  runtime v26.3.0. Its setup observation confirmed unchanged original review
  source and successful-check source/candidate bindings after administrative
  loading. Parent and retained Reviewer remain Sol/xhigh; original Mission,
  fourteen dirty paths and max38/consumed37/reserved0/remaining1 were preserved.
- Original parent admitted the previously rejected remaining-development unit
  and began direct execution in the same conversation. Admission is evidence
  that the history lock is removed, not by itself evidence of implementation,
  validation or completed delivery. Those observed results are recorded separately.

Preceding integration failures were diagnosed, not hidden: the optional-schema
spread initially failed compilation; obsolete forced-author/model/ordering
assertions and a missing existing-session fixture context were corrected; one
remaining asset-text assertion required the removed mandatory-original-Reviewer
instruction. The full runner aborted on that assertion and was rerun after its
repair. Attempt logs, commands, exits, timings and source hashes remain in
`_testenv/reviewer-handoff/validation-receipt.json` and `_testenv/wsl-*/`.

## Original-conversation continuation observed

The single accepted continuation prompt stayed in the original parent and Mission.
`plan_units` returned `direct-unit-running` for the previously refused remaining
development, run `operator-beb1dde4-cb32-4a2b-835c-29a302824857`. The parent actually
performed five successful native patch calls across six existing backend source
files, adding the summary execution/context and owner/consumer connection. This is
new requested development, not another self-recheck or an existing-result report.
Necessary extra validation-consumer paths were added through the existing
`expand_unit` in the same admission, with no approval or redispatch.

At the 2026-10-13 00:58:35 UTC evidence snapshot:

- Actual parent model: `openai/gpt-6.1-sol`, `xhigh`; 19 observed requests.
- Same original Mission, parent and retained Reviewer. Original fourteen dirty
  paths remain present; three additional backend paths became dirty through the
  requested work. No patch targeted the explicitly prohibited paths.
- Budget remains cumulative38: consumed37, reserved1, remaining0. The remaining
  authorized unit is doing implementation, not an administrative recovery loop.
- No `repair_review`, replacement Session, Reviewer request, acceptance, commit,
  push, product Start or product package launch was observed in this window.
  One ordinary search named a nonexistent test file; this was a search error,
  not a Sortie continuation refusal or implementation validation failure.
- Limited formal checks and the development terminal are still pending. The
  observed source work proves useful continuation, not completed B delivery,
  canonical product CLI success, independent approval or Mission acceptance.
- API-rate estimate for observed parent requests: USD1.639058. The two requested
  Astra consultation turns used `openai/gpt-6-astra`, native variant `default`,
  14 observed requests, estimate USD1.917962. This snapshot subtotal is
  USD3.557020, with no unpriced observed requests. These are observed-message
  estimates, not final billing; ongoing requests may add cost. Primary coding
  chat and historical product execution are excluded. Adding the earlier bounded
  observation subtotal USD25.740644 gives USD29.297664, not an all-history
  product/Mission cost.

The candidate remains loaded only in the original Location while its execution is
active; npm-global and both config-local released packages are unchanged. Do not
reload or retire an active original execution merely to finalize the PR. Its
remaining result and any actual blocker can be collected without resending the
accepted prompt, resetting budget or repeating passed checks. Release/global
application and subsequent audit themes remain separate.
