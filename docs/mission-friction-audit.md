# Mission resume and review friction audit

## Operational observations (2026-09-26)

The PR #68 continuation test exposed several different failure modes:

1. The root session had moved from the original worktree to the routing-fix worktree. Mission state is project-local, but the native Coordinator retained its original location. Status returned `absent`, a second mission was created, and attempting to resume the original Coordinator was rejected by the second mission's ownership check.
2. The diagnostic Worker wrote `_testenv/limited-resume-post-review.json`. It was explicitly in the unit's write scope but gitignored. The review builder used `git ls-files --exclude-standard` and sent no excerpt of that output. The Reviewer repeatedly requested evidence that already existed on disk. Those bytes were also missing from the review staleness fingerprint.
3. The Worker could not call `operator_status`: its native tool filter and generated asset hid the tool, and the handler allowed only Operator/Coordinator. Runtime identity and budget therefore had to be transcribed by the Coordinator, weakening provenance and causing an extra evidence unit.
4. `review_mission` could reset a recorded result to pending on identical input, and status still said to obtain review after review already permitted submission. The status field `accepted` did not distinguish a PASS from the evidence-gap limit.
5. The original Coordinator did start another native generation after the root returned to the correct location. Its final native record is `finish=error`, `error.type=aborted`, `Step interrupted`, and `outcome=interrupted`. That is not another observed authorization rejection. It must not be counted as successful completion either.
6. Global init appended the unversioned `sortie-dogs` plugin entry even when the automatically discovered local V2 wrapper already loaded the fixed package. Each previous global apply needed a manual config correction. Init now recognizes that wrapper and existing version-pinned package entries.

## Changes

### Autonomy

- `operator_status` and ordinary `start_mission` discover this root's unfinished Coordinators in other native locations and return the precise project path and same session identity. Operator can use the host's `session_move` and continue without reconstructing control files or asking for routine approval.
- Discovery follows native parent/role/location metadata and reads the corresponding mission. It does not scan unrelated worktrees or move a mission's files. A missing optional native list capability is reported and does not become a new blocker to fresh work.
- `start_mission(intent: "new")` supports intentionally separate work in the current location. Other missions and cumulative spend are retained. This is a choice made from the user's request, not a new approval gate.
- Submitted blocked/needs-decision missions expose their exact Coordinator continuation task after the prior dispatch has ended. Mismatched-location and still-active errors explain the next action.

### Efficiency

- Explicitly scoped gitignored artifacts now contribute to review excerpts and the full byte fingerprint. Committed candidates with an empty diff still provide current source excerpts.
- Review content remains bounded; large files are hashed as streams, and omitted sections are identified. A read-only unit does not accidentally collect the whole repository merely because its write list is empty.
- Repeating an identical review request returns its recorded result instead of scheduling another model call. New source or materially different traces can still be reviewed. Status directs reviewed candidates to submission rather than another review loop.
- Reinitializing a known local V2 wrapper or version-pinned package does not add a second unversioned loader. User configuration bytes remain unchanged when the depth is already sufficient.

### Visibility

- Workers can directly observe their own mission's public status, runtime identity and budget. The operation does not admit tasks, change plans or accept a mission.
- Packets identify `project_root` and Coordinator dispatch state. Review packets retain the compatibility field `accepted` and additionally expose `passed` and `permits_submission`; evidence-gap exhaustion is not labeled PASS.

## Other boundaries inspected

- **Investigation and scope extension:** the mission path already allows read/search and unregistered read-only diagnostics. Coordinator can use `expand_unit` / `plan_units` for in-request corrections without root approval. The old proposal/read-count lane is not the normal mission path.
- **Worker write scopes and validation:** these bind actual edits/checks to the assigned work and cumulative ledger. They are not a substitute for host permissions. This audit found missing observation access and evidence projection, not evidence that removing all scopes or accepting prose as test results would fix the observed failures.
- **Cancellation and role changes:** cancellation preserves unfinished requirements and spend. An interrupted model response, a native terminal outcome, and a review verdict have different meanings and must remain separately visible.
- **Acceptance scope:** the old campaign includes Anko work, while the later diagnostic request forbids Anko execution. Keeping those obligations visible is correct; asking every small diagnostic to prove the entire campaign is not. A bounded diagnostic reports its own measured outcome and the campaign's outstanding work separately. `intent:new` is for genuinely separate location work, not permission to erase an active mission's criteria.
- **Permissions and non-Sortie agents:** native Build/other agents retain ordinary tools. Mission-only control authority remains local to its owned sessions; this change does not add a global security layer.

## Verification boundaries

Regression tests exercise wrong-location discovery, native ownership, blocked-submission continuation, fresh-work fallback when discovery is unavailable, direct Worker observation, ignored/committed/large artifacts, changed-byte staleness, identical-review reuse and evidence-gap status semantics. Native plugin-context probes complement mocked API fixtures. A context probe without model inference is not a real Worker completion, and passing these tests does not mark the old campaign accepted.

## v0.12.9 follow-up: completion and constraint audit

The subsequent real-session test reached Worker success, independent review and submission, but
`complete_mission` returned `awaiting-evidence` without a receipt. The unit's read scope included
`.sortie-dogs-v010/missions`. Review/submission updated that live record after validation, changing the
protected source digest even though the candidate digest stayed identical. The old status still told
Operator to call completion again. This was an orchestration consistency check invalidating its own
work, not an unimplemented user requirement.

### Removed friction

- **Autonomy:** new host snapshots exclude root-level `.sortie-dogs`, `.sortie-dogs-v010` and `.git`
  bookkeeping from source freshness. Those paths remain readable. The exact manifest and all explicit
  candidate outputs are still pinned; normal source and ignored diagnostic artifacts remain inputs.
- **Efficiency:** completion and status share one readiness calculation. Criteria with the same
  snapshot recipe share its filesystem read. Completion no longer repeats the independent review
  freshness check twice. The end-to-end regression reaches final acceptance after review, submission
  and reload with exactly one validation admission and one consumed Worker unit.
- **Visibility:** failed completion returns criterion, reason, source/candidate scopes, expected/current
  digests where available, and the next operation. Status reports the same blocker rather than inviting
  an unchanged completion retry. A completed mission directs the caller to reporting, not more dispatch.
- **Observation restrictions:** the legacy validation-only repair lane hid status despite exposing it
  in the Worker tool list. Owned Workers can now read their run status in that lane too; existing
  generator/edit restrictions do not block observation.
- **Review loops:** a Reviewer cannot observe its own future native outcome or final Operator acceptance.
  Generated review instructions now assign those observations to the Operator after review, instead of
  suggesting a further review to prove the previous review. Available historical/source evidence must
  still be evaluated. Completion wording distinguishes passing validation from accepted evidence gaps.

### Other paths checked

- Mission investigation and in-request scope expansion already bypass proposal approval and user
  round trips. Coordinator's read-only diagnostics and Worker exploration do not require registration
  as formal validation. These are the intended execution-first paths, not new permission checkpoints.
- Normal Worker status access, native model selection, location recovery and identical-review reuse
  from #68/#69 are present in the v0.12.9 baseline. The uncovered validation-only exception is fixed here.
- Write-scope extensions still require a returned Worker and a new host-generated contract. This can
  cost an extra dispatch when an initial plan is too narrow; no additional approval layer was added.
  Runtime-generated IDs/digests remain host-owned rather than making the model hand-edit state.
- The read-only shell classifier and foreground Task accounting remain potential limitations for
  unusual commands/background workflows. This investigation did not establish them as the cause of
  this completion failure. The user-facing fallback must name the unsupported operation, not pretend
  that successful work disappeared. Broader native-host/benchmark coverage remains separate work.

### Historical evidence and verification boundaries

`source_policy: "project-files-v1"` identifies newly recorded evidence. Missing policy retains the old
snapshot recipe; old evidence is not silently rehashed or accepted under a different policy. Status
identifies legacy control-bound evidence and explains that fresh evidence under the new runtime is
needed while retaining mission requirements and cumulative spend. Existing campaign records are not
edited by this repair.

The regression uses production plugin hooks and an actual validator process with fixture native
sessions. It proves the lifecycle and unchanged validation count, not real-model inference or acceptance
of the old Anko campaign. Its negative path changes the validator after review and verifies both
completion rejection and the identical actionable status. Snapshot tests separately cover real input,
candidate and manifest changes, ignored evidence, control-like explicit outputs and legacy recipes.
## Preventive follow-up: local corrections without destructive replanning

The v0.12.9 audit exposed three additional reproducible obstacles:

- `plan_units` cancelled the current run before checking remaining budget or validating/persisting replacement controls. A refused correction could therefore destroy the dispatchable state; a state-write failure could also leave an archive that blocked the next attempt. Budget checks now precede replacement. Preparation keeps the predecessor intact until the new controls and its sequence-qualified checkpoint are written and the operator-state file is atomically replaced. Failed preparation removes only its newly created files; a subsequent corrected call can proceed. Original acceptance, settled evidence anchors and cumulative spend remain attached to the same mission.
- The plan parser required a nonempty write list even for inspection/verification. The manifest and write gate already support an empty list. Such units can now use `write: []`, with their read inputs included in the generated source header, instead of requesting unnecessary write access or inventing an output. Formal checks still record the actual process result.
- Status could advertise a prior run's PASS as permission to submit the replacement, although submission itself rejected it. Review packets now expose the reviewed `run_id` and `current_run`; acceptance flags and next-action guidance apply only to the matching run. The original Reviewer identity/verdict is retained for verification lineage.

Regression coverage includes budget, generated-schema and both control/state-storage failures; correction after failure; active-worker and stale/concurrent replacement checks; checkpoints left before a state switch; and a read-only Worker hook lifecycle with a real `node check.mjs` process, recorded validation, review skip, submission and completion. These deterministic host fixtures establish the corrected paths, not an inference-driven Desktop mission or benchmark score. This follow-up does not claim a cross-file transaction spanning the operator state, goal ledger and mission state; registration and mission linkage still follow the operator-state switch.

## Global installation follow-up: one authority per operation

### Real-session observations

The v0.12.10/v0.12.11 installation requests exposed boundaries that a fresh, repository-local
single-unit test did not exercise. Native V2 exports of Coordinators
`ses_f23697be8ffezVqrce6zUxOS7g` and `ses_f231ca35cffeCSHfoSAo4IQyPC` show:

- `expand_unit` could not express the requested `O:` / `M:` installation destinations because the
  planner required repository-relative paths. The low-level manifest and write gate already supported
  explicit absolute destinations. This was a disagreement between layers, not an OS permission denial.
- After cancellation, the new Coordinator's generated Worker Tasks were refused with
  `acceptance_parent_continuity_mismatch`. Three attempts did not reach a Worker. The native
  Coordinators were different sessions; the profile intentionally maps both to the same Operator root
  for accounting, where the legacy acceptance cache was keyed only by root session.
- These refusals were observed on host PID 35084, loaded at `2026-09-26T06:20:29.547Z`, before the
  installed updates were activated. They are not evidence that the v0.12.11 implementation was loaded.
  Inspection of v0.12.11 nevertheless confirmed both incompatible paths remained in that baseline.

### Corrections by design principle

- **Autonomy:** an admitted mission Task uses the durable mission/run's existing identity, generated
  control hashes and ordered acceptance. It does not also have to satisfy the legacy root-session
  acceptance chain. This removes a duplicate authority, including automatic parent-link rewrites and
  restore attempts that could conflict with a newer run. Legacy non-mission dispatch keeps its contract.
- **Autonomy:** execution read/write scopes support native absolute paths throughout planning and
  expansion. Existing host permissions remain authoritative; no new approval or security switch is
  introduced. Absolute spellings of repository-local paths behave consistently, and runtime-owned
  control paths remain excluded from implementation outputs.
- **Efficiency:** external outputs participate in validation and review directly. They are not passed
  to Git as out-of-repository pathspecs. Byte hashing is streamed, review excerpts are bounded, and
  normal package-internal executable links are supported. An external-only operations unit does not
  require a Git checkout or synthetic source edits merely to obtain review.
- **Efficiency:** a cold reload between units uses the already-admitted mission contract instead of
  trying to reconstruct an equal-fingerprint legacy parent. Replanning after a refused native Task
  keeps the generated handoff bytes unchanged.
- **Visibility:** new evidence with external paths uses `source_policy: "declared-paths-v1"`. It binds
  real external bytes and detects subsequent changes; old evidence retains its original recipe.
  `dispatch_denial` retains the actual admission refusal in unit status, with guidance against repeating
  unchanged Task calls or replanning to repair a host-state mismatch.
- **Visibility:** V2 status captures `runtime_asset_version` and the load-time hashes of named
  implementation modules alongside the adapter identity. Replacing files on disk does not change the
  old process's reported snapshot. These named hashes do not claim to identify every transitive module.
- **Accounting:** cancellation before validation must not refund an admitted Worker when the next real
  request starts a replacement mission. The cancelled mission now keeps its goal ledger continuation;
  deciding whether criteria carry forward remains the planner's responsibility.

### Other constraints inspected

- Unit acceptance, native Task termination, review verdict and final receipt are distinct outcomes.
  Their separation remains useful; none is used as a substitute for the others.
- Native file permissions and declared task outputs serve different purposes. Scope declarations now
  describe the requested external work rather than prohibit it. Arbitrary script side effects cannot
  be proven by a shell string classifier; that classifier is not a security sandbox.
- The read-only shell classifier still has syntax limitations, particularly for compound PowerShell
  commands. The v0.12.11 archive/curl correction paths remain in place. This change does not claim to
  classify every shell program or rerun those already-successful checks as a release gate.
- Extending a running Worker's scope still requires returning to its Coordinator. This is a remaining
  source of dispatch overhead when initial scopes are too narrow; it is not a user approval step.
- Installation receipts must distinguish canonical destinations: a `C:` config alias and its `O:`
  target can be the same installation. Counting both does not prove the separate npm-global prefix was
  updated. Canonical installation identity belongs in the application observation, not an inferred
  claim based on two path strings.

### Verification boundary

Production-hook regression covers an admitted Worker interrupted before validation, a new mission on
the same root, a different Coordinator, two external outputs, a cold reload between units, real
validator processes, independent-review hook settlement and final acceptance. It asserts cumulative
spend, rejects stale Task references and edited controls, and detects an actual post-validation external
change. Another regression performs an offline npm pack/install into a fresh external prefix and
checks executable output, snapshot freshness and review content without a Git repository. V2 adapter
tests replace both adapter and implementation files after load and verify the old snapshot is retained.

These fixtures do not establish a real-model continuation of the interrupted Desktop installation,
global application of this PR, or an Anko/SWE-bench result. Operational databases and mission/evidence
records are not edited by this repair.
