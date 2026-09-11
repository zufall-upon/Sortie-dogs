# Same-goal budget recovery

After a budget stop, obtain explicit user approval for the new cumulative limit. For example,
three additional units after three consumed units means `goal_budget_units: 6`, not `3`.

The coordinator submits the complete accepted goal declaration in its next worker Task, retaining
the acceptance fingerprint, criteria, manifests, and validation commands while declaring the approved
`goal_budget_units`, `goal_budget_time_ms`, and/or `goal_budget_cost_usd` changes.

A real user message or completed host question opens one declaration-authority window. A question
answer itself neither grants numeric budget nor resumes a stopped goal. The coordinator must interpret
the user's decision faithfully and submit the corresponding typed declaration; refusal or a hold
instruction does not authorize additional work. The normal admission gate remains authoritative.

An unchanged acceptance contract no longer suppresses an authorized budget-only revision. Revision
preserves consumed units/time/cost and evidence deduplication. Newly accepted revisions explicitly
start a fresh no-progress/replan cycle; ordinary continuation does not. Revision synchronizes the
validation limit and clears the prior stopped receipt. Successful terminal goals
cannot be reopened through this path. A smaller limit cannot erase consumed validation budget.

Do not edit the ledger, invent another goal to evade a limit, or assume that saying "fixed" changes
the numeric allowance. Restart OpenCode after installing the updated plugin. A currently paused
session remains paused until the user authorizes its next action.

`goal_budget_units` is the cumulative goal limit across all revisions, not a per-task allowance.
If six units have already been consumed, a limit of six leaves no available dispatch; three more
units require an explicitly approved limit of nine. Process-defect attempts still consume units,
but host-observed write denials do not increment acceptance no-progress unless a real acceptance
execution also failed.

## Shared goal declarations

A first goal may use `goal_declaration_path: .sortie-dogs/contracts/goal.json` in its Task,
or an inline `ext["sortie-dogs/goal-declaration"]` object in the registered handoff. JSON contains
delivery/budget fields, `defaults`, and `criteria`. Defaults are shared, not copied by the coordinator
into every criterion. Criterion entries may use short keys (`target`, `oracle_coverage`, etc.) or
the corresponding legacy `goal_*` keys. Explicit criterion values override shared defaults.
Stable criterion IDs and the goal fingerprint are generated if omitted. Acceptance, oracle coverage,
delivery, and canonical commands are not guessed. Existing flat declarations remain compatible.

The host expands this definition privately for the existing validation/evidence machinery. The worker
receives the short original Task, not an expanded copy of bookkeeping fields. Budget fields supplied
on Task override the referenced budget, under the existing real-user approval rule.

Read admission publishes the host inspection before bind checks its result, so scheduling both tools
in one round does not require a second worker solely for `handoff-uninspected`. The exact registered
handoff and manifest are still checked. Preserve-only same-task resumes may include
`role: blocker-resolution` as a recovery action without replacing their existing scope or history.

### Budget-only continuation

Once a goal has an accepted criterion contract, a subsequent Task can retain it and send only
the changed budget fields alongside its ordinary handoff, manifest, acceptance, and validation:

```text
goal_budget_units: 16
```

This inherits the accepted goal fingerprint, delivery mode, and criterion contract from the durable
ledger. It does not require their repetition in every Task, including after restart. The existing
user-approval requirement for a budget change remains; inheritance neither grants additional budget
nor creates a new goal. Explicit acceptance changes still use the full goal declaration. An initial
Task without an accepted contract still supplies that declaration.

`sortie_check_contract` accepts optional `task_prompt` to check the goal declaration with the same
resolver used by dispatch. Its response includes accepted/proposed unit limits, consumed/reserved
units, accepted/proposed remaining units, and whether budget approval is still needed. This is a
read-only preview: it consumes no approval, reserves no unit, and does not authorize a worker.
Dispatch rechecks current state and reconciles matching completed host Tasks before testing capacity.

The intended normal path is approval → budget-only Task → worker, rather than approval → missing
goal fields → contract reconstruction → repeated dispatch. No new required field is introduced.

## Persisted history compatibility

New `goal.revised` events record `reset_no_progress: true`. Historical events without that field
retain their original semantics. For the interim runtime that reset the cycle without recording
the flag, a persisted dispatch in a later revision provides the reset evidence. Ledger events and
their hashes are not rewritten.

## Nested project paths

Native file tools resolve relative paths from OpenCode's instance directory. A manifest rooted in
its `child/` subdirectory may declare `result.txt`, while the patch destination is `child/result.txt`.
The write gate checks that actual destination against the manifest scope; it does not change the
worker CWD or broaden the allowlist. Read the registered handoff to completion before binding.
