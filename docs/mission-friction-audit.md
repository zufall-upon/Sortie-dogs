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
