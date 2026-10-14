# PR proposal: recover observed Mission operations without replay

## Summary

Reconnect an operation command to its declared Mission operation when the native shell input is the same command with the recorded PowerShell error-action prefix or an absolute Node/script/input path spelling. If the exact current Mission unit already has a terminal native shell call, recover its call ID, owner session, working directory, native times, exit and outcome through the existing Mission API. Do not rerun the command or turn execution recovery into validation or acceptance.

## Self-review: responsibility and cause

The v0.13.20 global-apply Worker declared `git pull --ff-only origin main` and a relative `node` invocation. The native shell calls were `$ErrorActionPreference='Stop'; git pull --ff-only origin main` and an absolute `node.exe`, helper and plan invocation, both in the declared operation directory. Both native calls completed with exit 0. The package application and its recorded 3-placement/246-file/16-asset comparison succeeded; the active process still loaded v0.13.19 pending a manual restart.

The Worker was responsible for declaring the intended operation without accounting for the actual native envelope and executable/path representation. The host implementation was responsible for treating normalized string equality as operation identity and for having no continuation that reconciled an exact already-completed native call. The persisted Mission therefore retained `observations: []` and reported `not-started`; the old completion path rejected the request despite successful native calls. This was a Sortie-dogs observation/recovery defect, not a failed package application. The user was not responsible for the native representation mismatch.

The avoidable handoff/status round trips followed from that missing observation link. Replaying either `git pull` or the package apply would have been unnecessary and could have changed external state. This proposal retains the actual recorded outcome and addresses the broken link rather than retrying the operation.

## Minimal design

- Match the same native operation type only: strip the exact PowerShell `$ErrorActionPreference='Stop';` prefix; for Node script invocations, compare the Node executable form, the script resolved from the declared operation cwd, and each path argument resolved from that same cwd. Return a match only when it is unique. Do not use substring, basename-only script matching, or task-name analogy.
- Use that identity at the existing shell admission/observation point so the call's canonical declared command keeps its actual native call ID and session owner.
- On existing status, submission and completion APIs, inspect only the native session admitted to the current Mission run/unit. Require exact session ownership, shell call ID, command identity, cwd and native terminal metadata. Record only native timestamps and outcomes. A still-running call remains running; a failed call remains failed; missing exit/time, conflicting input, ambiguous declaration, wrong cwd or unavailable history remains unclassified and cannot become success.
- Persist recovered observations through `OperatorMissionRuntime.update`, idempotently by `(sessionID, callID)`. Do not modify the operator/run-flight ledger, spend, validation evidence, Review or requirements.
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

## Explicitly out of scope

No package reinstallation, operation replay, extra validation, budget reset, native-proof fabrication, direct old-ledger edit, global/config change, source-Mission change, Location override change, release, publish, push-side publication changes, or automatic OpenCode restart.
