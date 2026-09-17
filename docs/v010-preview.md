# v0.10 preview: strategic coordination and bounded operations

## Limited dogfooding checkpoint

The preview now incorporates the committed v0.9.12 attachment and continuation
recovery baseline (9a59753668010fd8352753fe80be25cbb74828bf). The integrated
runtime marker is `0.10.0-v0912-language4-cost-rpt10-compaction-ref1-proposal1-review-remediation1-surface3-proposal-recovery2-quality1`; earlier smoke receipts describe their
recorded pre-merge package and are not relabeled as integrated runtime tests.

The renamed two-unit serial path has completed a packaged real-model smoke:
`dog-operator` explicitly selected Astra/high, `dogs-coordinator` used Terra/high,
and both workers used Sol/medium. Both original content oracles and unchanged
verification scripts passed; the root terminal was `succeeded` and the queue
was `completed`, with no reported tool errors. This supports trying small,
low-risk serial tasks in a dedicated preview configuration, not replacing the
stable installation or claiming performance superiority.

The primary default remains Sol/low. Explicit UI/CLI model and variant selection
is authoritative; an Astra/low selection and its retention on the next turn are
covered by a regression test. Plain prose alone does not change the host model.
The earlier focused profile/install tests, packed loader and normal `npm test`
passed. Interruption, resume, compaction, Desktop-specific operation,
and representative performance comparison remain outstanding validation gates.

## Implementation checkpoint

The contract RPT now reproduces the long-input preparation failures against the
previous installed package, then runs the repaired three-unit path through the
real WSL CLI: primary Sol/low, delegate Terra/high, three Sol/medium workers.
Objectives of 1,672 characters and exact validation commands of 437 characters
remain intact. A bad mapping is corrected with one field replacement instead of
regenerating the plan. Three fixed oracles pass and the explicit completion tool
returns a succeeded receipt without another user turn or a special final phrase.
This validates that path; it does not certify the original application's GUI or
claim general release readiness or a measured cost advantage.

### Deterministic preparation, repair and completion

- Preparation validates all handoffs and manifests before creating any controls.
  Handoff and manifest command limits use the same 1,000-character constant;
  the full objective remains in `task.objective`, while `state.next` uses its title.
- Invalid preparation returns bounded diagnostic codes and pointers, not input
  values. The invalid draft is root/profile-bound and does not grant dispatch.
- `sortie_v010_repair_operator_plan` accepts that `draft_id` plus `patches_json`:
  an array of `replace` operations on `/units/<index>/validation`,
  `acceptance_indices`, `title`, or `objective`. Acceptance, number of units and
  write scope cannot be changed through this repair operation. A stale draft is
  rejected and a successful repair consumes it.
  An empty array revalidates the saved draft after a runtime update; it does not
  resend the large plan. `operator_status` exposes a pending invalid draft instead
  of reporting it absent. A criterion's `goal_validation_command` (or its alias)
  can also be added/replaced, but only with an exact command already declared by
  a unit assigned to that criterion in the pre-repair snapshot. The operation
  cannot introduce a new command by first mutating a unit in the same patch batch.
- `sortie_v010_complete_operator` accepts `run_id` and the ordered acceptance
  fingerprint. The root remains responsible for requested scope and required
  review. The host then resolves the separate immutable goal identity and applies
  the existing proof, reservation and protected-candidate freshness checks.
  Missing evidence cannot be converted into success by a prose claim. Successful
  completion stops continuation timers without aborting the current session.
- An `awaiting-acceptance` packet gives the root an explicit independent-review
  disposition. Review PASS (or an allowed low-risk skip) permits explicit
  completion. Blocking findings inside the unchanged acceptance, approved write
  union, and remaining cumulative budget require autonomous cancellation with
  `reason=review-blocking` and a same-goal replacement from the committed head;
  they do not require another user approval. Acceptance, scope, or budget growth
  still stops for the user. The replacement targets the findings, retains accepted
  criteria lineage and spent budget, then repeats canonical validation and review.

The new tools are normal typed host operations, not additional model agents or
translation passes. A failed check should be repaired using its exact diagnostic;
it is not a reason to collapse a multi-unit plan or remove user requirements.

Shared goal fields may be written at the declaration root or inside `defaults`;
the precedence is root, explicit defaults, then individual criterion. The parser
and host declaration expansion use the same normalization, preserving exact
commands. A shared final-test command is not automatically treated as proof for
an earlier unit using different tests; that relationship still requires an
explicit valid binding.

The user-facing `dog-operator` explicitly permits the host `question` tool.
OpenCode's custom-agent defaults can deny it even when the prompt requests its
use; instructions alone do not grant tool access. Delegate/worker permissions
and the normal Build agent are unchanged. SourceReview calls use the shared phase
and risk-tag enums; `SourceReview` itself is not a valid `review_phase` value.

### Shared test commands and existing-run recovery

Different criteria can legitimately use the same test command while having
different targets or oracles. Their host observation is now projected into
separate, identity-preserving evidence records instead of dropping the whole
execution. The real CLI fixture exercises three units and nine such criteria.

For an old, finished `process-defect` unit, the root may call
`sortie_v010_resume_operator` with its existing run ID and acceptance fingerprint.
Recovery verifies native parent/role and finished-session state, immutable
controls, matching validation admission/settlement records, and the current
protected source digest. It appends an evidence reconciliation record rather
than rewriting historical failure or rerunning the worker. Stale source or
missing host proof remains an explicit refusal. Budget/time/cost already spent
are retained. Only remaining units are delegated under the next generation.

Root `operator_next` is read-only status or returns a ready delegate Task for a
multi-unit run; it never bypasses that delegate with a direct worker Task. An
application's human approval or GUI acceptance is still separate from passing
automated checks. Do not promote a recovered unit into overall application DONE.

Review `candidate_id` identifies the logical review lineage, not a changing diff
hash. Preserve it across source fixes and put the revision in validation/source
evidence. After restart, completed native reviewer Task history can restore that
lineage within the same root and accepted goal; unrelated or never-started reviews
cannot authorize verification. Older preview versions may not understand the new
reconciliation event: rollback does not rewrite run ledgers; continue a recovered
run with this or a compatible newer runtime.

### Restarted admission and canonical return reports

Before dispatching the next unit after a host restart, the preview restores the
last proved unit's acceptance continuity from its hash-pinned handoff and the
same goal's durable accepted evidence. It does not invent a new parent or weaken
the next handoff. A rejected pre-admission attempt can be reopened only when the
native Task error matches the exact unit, no child was created, and the goal
ledger has no reservation for that call. Completed work and attempt accounting
are retained; actual execution budgets remain enforced by the goal engine.

The canonical v0.9 game-style guidance and return-report renderer are retained.
After explicit host acceptance, a final reply without a `DONE` heading still
receives the verified 🐾 return report, MISSION, COST/PACK and PACK RECORD panels.
Normal text completion is the primary path; a receipt-bound native completed-part
update is a bounded compatibility fallback. It uses the supplied authenticated
host client and never changes another agent's or another goal's message. Missing
metrics remain unavailable; no scores, medals, or success are fabricated.
First progress headings retain their icons without modifying code blocks or
contract tokens. Stable predecessor career records are read only for display;
execution state and ownership remain profile-separated.

The COST/PACK amount is a request-level prediction labeled `※予測概算`, not a
bill or the host-reported amount. The static pricing snapshot was checked on
2026-09-14 against the official OpenAI pricing/model pages and Anthropic pricing
page recorded in `src/plugin/model-cost.ts`. OpenAI uses Standard prices; input,
cache read, and 5-minute-style cache write are counted separately, and requests
whose uncached input plus cache read/write exceeds 272,000 tokens apply 2× to all
input/cache prices and 1.5× to output plus reasoning. Each request selects its
band before costs are summed. Anthropic uses Standard and the 5-minute cache-write
price. Fast, Batch, Flex, regional, tool, subscription, and actual-billing effects
are not claimed. Unknown exact models or non-Standard service tiers remain
`未換算`; mixed known/unknown usage is `一部未換算`, and missing usage is
`計測不可` rather than zero. `variant` does not substitute for `serviceTier`.

Cancelled replacement runs now retain a host-owned lineage to proved predecessor
units. Preparation registers the replacement goal declaration before exposing a
ready Task, preserving the same goal ledger's consumed unit/time/cost counters.
After restart, legacy replacement state without the new lineage field may recover
only from a hash-pinned current replacement contract plus an accepted predecessor
record in that same root goal ledger; it never searches unrelated historical
contracts. Identity drift, changed controls, a different acceptance fingerprint,
or an unproved predecessor remains denied. A failed registration leaves the same
prepared run and control IDs available for explicit retry instead of returning a
worker Task or resetting budget.

This is an initial beta implementation, not a validated production release.
Earlier LH check records retain their historical failures; standalone remediation
subsequently passed normal tests and the serial smoke described above. Those
historical records have not been rewritten. Broader runtime gates remain pending.

This development line starts at v0.9.10. The existing logical coordinator remains
the strategic authority but is exposed by the preview as `dog-operator`. The
existing logical operator is exposed as `dogs-coordinator` and executes a finite
approved serial queue. The profile mapping is bijective; these external names do
not merge or reverse their internal responsibilities.

## Preview topology

- `dog-coordinator`: the stable installation.
- `dog-operator`: the v0.10 primary (Sol/low), with user conversation,
  specification interpretation, architecture, immutable acceptance, review and
  final decision authority.
- `dogs-coordinator`: the hidden v0.10 operations delegate (Terra/xhigh), limited
  to bounded approved dispatch, progress and evidence collection.

The preview defaults `dog-operator` to `openai/gpt-5.6-sol` with variant `low`
and `dogs-coordinator` to Terra/xhigh. Preview workers use Sol/low and scouts use
Luna/xhigh. Explicit host agent/model/variant choices, including Astra, remain
authoritative; consultation and all other roles retain their independent routes.
Only `dog-operator` is a preview primary choice; every preview child agent,
including `dogs-coordinator`, is hidden.

Preview worker and consultation agents end in `-v010`; tools begin with `sortie_v010_`; the installed
marker is `sortie-dogs-v010.version`; project configuration is
`.opencode/sortie-dogs-v010.json`; controls are under `.sortie-dogs-v010/`.
Goal ledgers in a shared Git control directory use `run-flight-v010`. File-scope
leases remain shared deliberately so two runtimes cannot write the same path.

The default package plugin entry owns the preview namespace. The explicit
`sortie-dogs/plugin/stable` entry preserves the canonical compatibility runtime.
Do not register both versions under the same package installation path. Use a
separate tarball installation and an explicit file URL for its plugin entry when
testing two installed versions in one OpenCode configuration.

## Installation and measurement isolation

### Start limited dogfooding without changing global configuration

Use the prepared package to create an independent scratch project. Preparation
installs assets and checks configuration only; it does not execute an LLM task:

```powershell
node scripts/dogfood-preview.mjs prepare ./_testenv/routing-rpt/sortie-dogs-0.10.1.tgz ./_testenv/dogfood-preview
node scripts/dogfood-preview.mjs inspect ./_testenv/dogfood-preview/smoke-1/dogfood.json
node scripts/dogfood-preview.mjs start ./_testenv/dogfood-preview/smoke-1/dogfood.json
```

Use the receipt path returned by preparation; subsequent preparations allocate a
new directory instead of overwriting previous work. On Windows the launcher uses
a WSL login shell. `start` opens the interactive CLI in the scratch project with
`dog-operator`, Sol/low by default. Model selection in the UI remains available.
Only this process receives the dedicated configuration and depth 2 setting.
The launcher does not register a normal global plugin or change the stable
checkout. Exit the preview process to leave that environment.

Begin with a small low-risk task in this scratch project. This is not the beta
source worktree or the stable project. The earlier full serial smoke used an
explicit Astra/high override; preparation does not claim a new Sol/low RPT.

The beta package's CLI defaults to preview assets with marker
`0.10.0-v0912-language4-cost-rpt10-compaction-ref1-proposal1-review-remediation1-surface3-proposal-recovery2-quality1`:

```text
sortie-dogs init <project>
sortie-dogs init <project> --profile stable
sortie-dogs init --global --profile v010
```

Global init only installs that profile's agents/command/marker; it does not
register the plugin, change the default agent, or overwrite stable agent files.
During development, use a dedicated OpenCode test configuration and package
installation under `_testenv/`. Do not apply the preview to a stable benchmark's
global configuration. Pin each test's package digest, asset marker, model and
fixture revisions. Run heavy measurements in separate time windows or hosts.

Use a dedicated preview config and process rather than adding preview depth to a
normal shared host. For example, point `OPENCODE_CONFIG` and
`OPENCODE_CONFIG_DIR` at an isolated directory under `_testenv/`, configure the
packed preview plugin there, set `subagent_depth: 2`, restart OpenCode, and select
`dog-operator`. Do not overwrite normal global assets or deploy this configuration
into the v0.9 worktree or stable benchmark environment.

OpenCode's published configuration schema defines top-level `subagent_depth` as
a non-negative integer and defaults it to `1`, which prevents a subagent from
launching another subagent. The preview's `dog-operator` -> `dogs-coordinator` ->
worker path
therefore requires `subagent_depth: 2`. The packaged smoke runner writes that
setting only into its isolated v0.10 fixture configuration. It does not modify a
normal global configuration or stable fixture. Because OpenCode merges config
for the whole host process, enabling depth 2 in a shared host also permits that
depth for other agents in that host; use a separate preview host/configuration
when that coexistence is not acceptable, and restart OpenCode after changing
configuration.

WSL CLI execution must use a login shell and explicit project directory. Install
fixture dependencies inside WSL, verify the tarball is not a working-tree link,
and observe the actual package, role and model selected by the host.

## Approved plan and authority

Nontrivial requests can start with a durable proposal phase. The root freezes the
original request as ordered stable IDs (requirements, negative constraints, and
quality conditions), authoritative references, allowed read prefixes, and finite
read/submission budgets. The existing hidden `dogs-coordinator` investigates only
those prefixes and submits mappings, uncovered items, negative handling, exact
read/write/unit/GoalDeclaration plans, and budget estimates. Before approval it
cannot edit, run shell, dispatch any child, bind a write gate, or count its reads as
acceptance evidence. A changed intent cannot reset the active proposal budget.

The user-facing root compares the packet directly with the original request and
approves the exact proposal ID, revision, content hash, and ordered requirement IDs
with an explicit rationale. Hash equality proves packet identity, not semantic
quality. Uncovered requirements and stale/root-mismatched proposals fail closed.
Only then is the plan passed into the existing preparation, goal registration, and
serial execution lane. Routine work remains with `dogs-coordinator`; scope, quality,
budget, user-only decisions, review, and final acceptance remain root-owned. The
simple complete-contract worker fast path remains available.

`sortie_v010_prepare_operator` is coordinator-only and accepts `plan_json`:

```json
{
  "schema_version": "0.1",
  "acceptance": ["The exact accepted criterion, including its constraints."],
  "acceptance_proof": [["AC1"]],
  "source_refs": ["The original request or specification revision."],
  "goal_declaration": {
    "delivery_intent": "implementation",
    "delivery_mode": "mvp-first",
    "usable_path_established": false,
    "controlled_change": false,
    "defaults": {
      "target": "The actual requested behavior",
      "entrypoint": "The actual entrypoint",
      "workload": "The requested workload",
      "oracle_coverage": ["The actual behavioral oracle"],
      "build_boundary": "not-applicable",
      "source": "working source",
      "candidate": "working candidate",
      "source_binding": "current-protected",
      "candidate_binding": "current-protected",
      "fixture": "The actual fixture identity",
      "proof_scope": "requested-full",
      "expected_outcome": "pass"
    },
    "criteria": [{"criterion_id": "AC1", "validation_command": "The exact validation command"}]
  },
  "units": [{
    "id": "unit-1",
    "title": "A bounded implementation unit",
    "objective": "The approved implementation outcome",
    "read": ["src/example.ts", "test/example.test.ts"],
    "write": ["src/example.ts"],
    "validation": ["The exact validation command"],
    "acceptance_indices": [0]
  }]
}
```

Replace the example values with real approved scope and proof. The host generates
the existing minimal handoff, operation manifest, acceptance continuity ledger and
goal declaration. It validates every generated contract in memory before writing
any of them or granting execution. The exact original criteria remain in every
handoff; unit completion does not mean global acceptance.

Objectives remain verbatim in `task.objective`; `state.next` uses the bounded unit
title. Handoff checks and manifest validation commands share a 1000-character
limit. Invalid plans report bounded `document`, JSON `pointer`, `code`, `rule`,
length/limit when applicable, and `repair_kind` metadata without echoing source
values. Repair only that field or explicit proof mapping; do not regenerate the
whole plan or collapse units. A control write failure removes every new control
before returning and does not grant execution.

A single unit returns a worker Task directly. Multiple units return an operator
Task. The coordinator must copy that Task verbatim. The operator calls
`sortie_v010_operator_next` and passes each returned worker Task verbatim. It may
read approved paths but cannot edit source, issue shell commands, change criteria,
add units, invoke other roles, accept a candidate, or publish.

The existing core admits delegated worker calls as root-owned calls. The host
adapter maps the verified operator ancestry to that root only for the existing
MkII enforcement boundary. Native session identities and the real parent chain
remain available in the OpenCode database. Goal reservations, validation evidence
and terminal acceptance still belong to the canonical core.

## Results and failures

The operator's durable state is scoped by profile and root. Control content is
fingerprinted; duplicate concurrent admission and changed controls are rejected.
Successful unit evidence comes from the existing core's host-observed validation,
not a child saying PASS. Packets include unsuccessful/unproven units and immutable
evidence references. Packet overflow fails explicitly rather than truncating
required evidence.

An operator returns `awaiting-acceptance`, not DONE. Required SourceReview remains
coordinator-owned and uses the original accepted criteria, exact manifest,
candidate-bound changed-logic summaries and validation evidence. Low-risk review
remains optional under the existing policy. Final acceptance is still validated
by the core goal engine. A blocking review is not a human approval gate when its
repair stays inside the already accepted contract, write union, and remaining
budget; the root uses the committed candidate as the bounded replacement base.

Agent changes revoke the old profile's grant and stop only its owned children.
Compaction preserves root/run/generation/contract references instead of rebuilding
criteria from summaries. A partial or unverifiable return becomes a decision
packet; it is not silently retried or treated as success. A native Task error
after admission settles the admitted unit and root reservation as
failed/process-defect, retains spent retry accounting and root ownership, and
adds no child or acceptance evidence when no child was created.

Pending worker Tasks are returned as bounded `SORTIE_OPERATOR_TASK_REF` handles
bound to the root, run, generation, unit, plan and immutable full-Task hash. The
host expands only an exact current reference inside the same serialized admission
transition, then passes the registered full handoff to the existing worker gate.
Edited, stale-generation, foreign-root and expired references are rejected; the
legacy exact full prompt remains compatible. `operator_status` exposes current
state/reference after restart, while compaction receives a bounded durable
checkpoint and directs the root back to `operator_status`/`operator_next` rather
than using rollover prose as acceptance or Task authority. Completed or running
units are not exposed as pending references.

## Initial scope

This preview implements the serial path. Luna fabric, parallel integration and
reflection writes are not exposed in the preview profile; they remain available
in the separately installed stable runtime. Extending those paths requires their
own profile-aware ownership and recovery work.

## Independent releases

The release manifest accepts `releaseProfile`:

- `stable`: `main`, stable version, npm `latest`, normal GitHub Latest behavior.
- `beta-v010`: `beta/v0.10`, `0.10.x-beta.N`, npm `beta`, GitHub prerelease/non-Latest.
- `independent-v010`: `release/v0.10`, stable `0.10.x`, npm `next`, GitHub non-Latest.

The preview profiles require the install target inside that worktree's `_testenv`
and can publish an initially absent remote branch. They never require merging
into `main`. Version/tag/Release reuse is refused. npm publication remains manual;
the generated command includes the selected dist-tag. Release preparation, push,
tags and publication require the user's explicit release instruction.

## Evaluation

Compare the same tasks and worker/validation conditions across Terra coordination,
Astra coordination, and Astra plus Terra operator. Treat the original specification
as the quality oracle. Count all parent/operator/worker tokens, steps, children,
cache behavior, duration, rework and estimated cost with pricing coverage. Reduced
coordinator context alone is not an efficiency result.
