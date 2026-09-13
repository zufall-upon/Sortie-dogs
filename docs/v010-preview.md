# v0.10 preview: strategic coordination and bounded operations

## Limited dogfooding checkpoint

The preview now incorporates the committed v0.9.12 attachment and continuation
recovery baseline (9a59753668010fd8352753fe80be25cbb74828bf). The integrated
runtime marker is `0.10.0-beta.1-v0912`; earlier smoke receipts describe their
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
The latest focused profile/install tests, packed loader and normal `npm test`
(286 tests) passed. Interruption, resume, compaction, Desktop-specific operation,
and representative performance comparison remain outstanding validation gates.

## Implementation checkpoint

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
- `dogs-coordinator`: the hidden v0.10 operations delegate (Terra/high), limited
  to bounded approved dispatch, progress and evidence collection.

The preview defaults `dog-operator` to `openai/gpt-5.6-sol` with variant `low`
and `dogs-coordinator` to Terra/high. Explicit host agent/model/variant choices,
including Astra, remain authoritative. The existing worker route remains
Sol/medium, and consultation retains its independent route.
Only `dog-operator` is a preview primary choice; every preview child agent,
including `dogs-coordinator`, is hidden. Workers retain Sol/medium routing.

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
node scripts/dogfood-preview.mjs prepare ./_testenv/routing-rpt/sortie-dogs-0.10.0-beta.1.tgz ./_testenv/dogfood-preview
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
`0.10.0-beta.1-role-names`:

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
goal declaration. It validates them before returning a Task. The exact original
criteria remain in every handoff; unit completion does not mean global acceptance.

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
by the core goal engine.

Agent changes revoke the old profile's grant and stop only its owned children.
Compaction preserves root/run/generation/contract references instead of rebuilding
criteria from summaries. A partial or unverifiable return becomes a decision
packet; it is not silently retried or treated as success. A native Task error
after admission settles the admitted unit and root reservation as
failed/process-defect, retains spent retry accounting and root ownership, and
adds no child or acceptance evidence when no child was created.

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
