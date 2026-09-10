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
