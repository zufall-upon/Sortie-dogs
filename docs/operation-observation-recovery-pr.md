# PR proposal: recover observed Mission operations without replay

## Summary

Reconnect an operation command to its declared Mission operation when the native shell input is the same command with the recorded PowerShell error-action prefix or an absolute Node/script/input path spelling. If the exact current Mission unit already has a terminal native shell call, recover its call ID, owner session, working directory, native times, exit and outcome through the existing Mission API. Do not rerun the command or turn execution recovery into validation or acceptance.

## Self-review: responsibility and cause

The Operator declared `git pull --ff-only origin main` and a relative `node` invocation for the v0.13.20 global apply. The Worker used native shell calls with `$ErrorActionPreference='Stop'; git pull --ff-only origin main` and an absolute `node.exe`, helper and plan invocation, both in the declared operation directory. Both native calls completed with exit 0. The package application and its recorded 3-placement/246-file/16-asset comparison succeeded. After the subsequent manual restart, the root process was observed loading `0.13.20-review-followup-v1`; this PR does not apply or reload its candidate.

The Operator was responsible for the declared recipe, its alignment with the Worker's actual native representation, accurate result reporting and avoidable rescue round trips. The Worker changed the shell envelope and executable/path representation when issuing the commands; it did not author the original `start_mission.execution` declaration. The host implementation was responsible for treating normalized string equality as operation identity and for having no continuation that reconciled an exact already-completed native call. The persisted Mission therefore retained `observations: []` and reported `not-started`; the old completion path rejected the request despite successful native calls. This was a Sortie-dogs observation/recovery defect, not a failed package application. The user was not responsible for the native representation mismatch.

The avoidable handoff/status round trips followed from that missing observation link. Replaying either `git pull` or the package apply would have been unnecessary and could have changed external state. This proposal retains the actual recorded outcome and addresses the broken link rather than retrying the operation.

## Minimal design

- Match the same native operation type only: strip the exact PowerShell `$ErrorActionPreference='Stop';` prefix; for Node script invocations, compare the Node executable form, the script resolved from the declared operation cwd, and each path argument resolved from that same cwd. Return a match only when it is unique. Do not use substring, basename-only script matching, or task-name analogy.
- Use that identity at the existing shell admission/observation point so the call's canonical declared command keeps its actual native call ID and session owner.
- On existing status, submission and completion APIs, inspect only the native session admitted to the current Mission run/unit. Require exact session ownership, shell call ID, command identity, cwd and native terminal metadata. Record only native timestamps and outcomes. A still-running call remains running; a failed call remains failed; missing exit/time, conflicting input, ambiguous declaration, wrong cwd or unavailable history remains unclassified and cannot become success.
- Persist recovered observations through `OperatorMissionRuntime.update`, idempotently by `(sessionID, callID)`. Do not modify the operator/run-flight ledger, spend, validation evidence, Review or requirements.
- Apply the current unit's native start cutoff to each tool, not just its boundary-page fetch. Retained direct actors keep all their current-run admission windows, and reusable correction actors use their correction admission rather than conversation creation.
- Bound a completed delegated correction by its existing unit-settlement record before inspecting call conflicts, so a later turn in the same session cannot replace the unit's result or poison its recorded inputs.
- Select the latest operation by its actual start time, not the order in which recovery discovered it. Keep incomplete exits unclassified, allow normal running-to-terminal and missing-to-known metadata updates, and retain a `conflicting` marker when the same native call has contradictory terminal records. That marker is observation data, not a fabricated process failure or a new authorization layer.
- Keep URL, option and opaque values literal. Only the supported relative-to-absolute positional path substitution may change an argument; two differing relative values (or two differing absolute-looking route values) cannot collapse via path normalization. Script and Windows cwd identities retain the same case/separator rules.
- Preserve pinned executable identity: a declared Node path must match the native executable path; a bare `node` declaration can retain its resolved native path spelling. `node.exe` aliases and case-folding apply only to the Windows operation context.
- Recheck terminal Mission phase inside the serialized recovery update, after awaiting history. A delayed reader cannot append results after cancellation or completion.
- Apply the existing decorated-operation refusal to the recognized base command after its permitted native wrapper/path spelling. Reuse the existing quote-aware shell scanner, so quoted suffix characters remain input data. This fixes the existing observation/preflight boundary, not another permission layer.
- Keep the existing protected-snapshot blocker independent. Recovered operation completion is not a `PASS` and cannot bypass current source/candidate freshness.

## Three-principle review

- **Autonomous:** continue with the already-recorded native result through existing Mission tools; no new approval, scope gate, dispatch or user repair loop.
- **Efficient:** no operation replay, new unit, duplicate check or unrelated session/archive scan. Read only the admitted session for the current run; keep its native call as the evidence source.
- **Visible:** preserve call/session/cwd/timestamps/exit/outcome in `operation.observations`; status distinguishes a collected execution from a successful formal check or accepted Mission.

## Saved-case observations and boundaries

- Mission `mission-fa80cf2d-ba9b-4bfa-9de5-7f306eb42e0f`, run `operator-314dd894-6ab5-47b0-9eb1-5bca412e7988`, unit `unit-1`: succeeded; consumed 1, reserved 0, remaining 31. Worker `ses_ec823140dffeGYr1ZirFUyDC6Z`; observed model `openai/gpt-6-luna-fast#max`; elapsed 472.004 seconds; cost `$0.06044392`.
- Persisted operation commands were `git pull --ff-only origin main` and `node '_testenv/global-apply-v0.13.16/apply.mjs' '../work-quantity-progress-20261013/_testenv/global-apply-v0.13.20/plan.json'`; persisted `observations` were empty.
- Native calls `call_7c9218e8ae644cec9bfd4125081d2d16` and `call_c2320cce5c63457eae3553a5ab6d1f1c` completed with exit 0. The fixed-package receipt records all 3 placements, 246 payload files, 16 assets, unchanged settings, and an apply duration of 10.799 seconds. Neither operation was replayed for this change.
- The old Mission also has a `snapshot-unavailable` blocker with broad external global/config scopes. The exact top-level declared paths still exist and the receipt proves its finite package-application checks. No recursive content hash or whole-tree rehash was performed; those observations cannot establish whether an individual descendant changed or became unreadable. This PR does not clear or relabel that blocker.
- The original external Mission ledger and global installation were not modified. Regression coverage uses the saved command/call identities and exercises the normal Mission API against a disposable fixture; this is not claimed as a live rewrite of the original external ledger.

## Validation

The PR description records the final registered checks with their exact commands, exits and elapsed times, plus any diagnostic rerun and its reason. Keeping those native results in the PR description avoids copying stale evidence into this design proposal.

## Initial independent review and same-Task correction

The Reviewer (`openai/gpt-6.1-sol`) reproduced five Medium defects through the existing public Mission harness before source correction: pre-admission calls counted as current execution; missing exits classified as failure; contradictory same-call terminals selected by last-write order; old recovered success replacing a newer failure/running result; and URL/option arguments compared with Windows path case rules. These are corrected in the same native Task, with regressions derived from the existing operation/result separation contract. This correction's own recheck is not independent approval of its edits.

The pre-fix focused diagnostic used the candidate's existing `dist` and the added public regressions: seven requirement assertions failed as expected (the direct-enabled control additionally exposed a fixture-only tail owner mismatch, corrected without changing its oracle). Disposable diagnostic fixtures were removed. Final integrated checks use the normal router/build boundary and remain separate from recovery of the old external operation.

PR #250's body, review submissions and regular/line comments were retrieved. At the initial read only the bot's running notification existed. Its later review on `167a7e0` supplied seven concrete comments, all classified **valid**, none false-positive or deferred:

- `4266226012`: admission timestamp; covered by the existing pre-admission regression and per-tool cutoff.
- `4266226023`: chronological selection; covered by newer-failed/running preservation regressions.
- `4266226031`: tool error without a process exit; extend the missing-exit correction to error envelopes too. The native error stays visible, but does not fabricate process execution/failure.
- `4266226043`: Windows cwd case; additional Medium finding, fixed at native admission and recovery with a real Windows public-API regression.
- `4266226055`: terminal-phase race; additional Medium finding, fixed with in-update phase reconciliation. Regressions use public cancellation during the history read and a completed-phase fault injection; the latter is not a claim of real Mission acceptance.
- `4266226063`: decorated native wrappers; additional Medium finding, fixed at the existing refusal point with prefixed and absolute-Node regression inputs. No operation is launched by these refusal tests.
- `4266226070`: opaque slash-bearing arguments; extend the argument-identity correction to reject relative-value/route normalization, while retaining the saved relative/absolute helper and plan substitution.

The additional pre-fix diagnostics failed on the concrete error-envelope, phase-race, wrapper/suffix and Windows-case requirements. The Windows fixture initially lacked its standard model field; supplying that field exposed the expected case-identity failure without changing the oracle. All diagnostics used disposable fixtures; no old operation, package or external ledger was modified. Final check/delivery observations are recorded on the PR. CI success is not treated as resolution of a code finding, and no new review/approval wait is required for this correction's explicit author self-recheck.

## Operator direct follow-up

The next existing review on `a30c885` supplied three additional comments, all classified **valid**, none false-positive or deferred:

- `4266390062` (Major): previously unseen input/status conflicts were deleted, permitting an older success to win. Retain an admitted matching observation with its conflict marker even when it was never observed live; classify the latest conflicting call as unclassified before considering running or successful outcomes. Regressions cover differing terminals, both input-record orders and contradictory status envelopes.
- `4266390069` (Medium): a completed delegated correction could collect a subsequent turn from its reusable session. Reuse its persisted unit-settlement timestamp as the upper boundary, and apply both time bounds before conflict comparisons. The public-API fixture verifies that later same-command calls and later changed inputs cannot replace or poison the original result.
- `4266390074` (Medium): basename-only Node matching recognized unrelated pinned binaries and POSIX `node.exe`. Compare declared executable paths, preserve bare declaration to resolved native spelling, and apply Windows aliases only in the Windows operation context.

The Operator implemented this follow-up directly in the same Mission and budget, without a routine new Worker handoff. A pre-fix diagnostic using the existing `dist` exited 1 with four failed assertions in 1.666 seconds: unseen input conflict, unseen status conflict, post-settlement call and pinned executable identity. The differing-terminal control already passed. After the batch correction, the two-file router check exited 0 with 35 passed in 21.173 seconds. Final declared checks and delivery are recorded on the PR. Fixture-only state injection models legacy gaps; it does not modify the external Mission or claim live candidate loading. The responsibility description above also corrects the earlier mistaken attribution of the original declaration to the Worker.

## Explicitly out of scope

No package reinstallation, operation replay, extra validation, budget reset, native-proof fabrication, direct old-ledger edit, global/config change, source-Mission change, Location override change, release, publish, push-side publication changes, or automatic OpenCode restart.
