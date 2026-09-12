# v0.10 preview: strategic coordination and bounded operations

## Implementation checkpoint

This is an initial beta implementation, not a validated production release.
Build, focused contract/install/release tests, packed-plugin loading, and the
existing normal test suite have passed. Real-model operator execution,
simultaneous stable/preview runtime coexistence, interruption/compaction recovery,
and the three-arm performance comparison remain pending. Do not interpret the
architecture described below as evidence that those runtime checks have passed.
The smoke runner is supplied for that next validation stage.

This development line starts at v0.9.10. It adds one logical role, `dog-operator`,
to the existing MkII workflow. The coordinator retains interpretation of the
original request, architecture, acceptance, scope changes, review, and final
decisions. The operator executes a finite approved serial queue.

## Two user-facing choices

- `dog-coordinator`: the stable installation.
- `dog-coordinator-v010`: the separately installed v0.10 preview.

The preview defaults to Astra/high for coordination and Terra/high for its
operator. Explicit host agent/model choices remain authoritative. The existing
worker route remains Sol/medium, and consultation retains its independent route.
Only the coordinators are primary choices; preview child agents are hidden.

Preview agents end in `-v010`; tools begin with `sortie_v010_`; the installed
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

The beta package's CLI defaults to preview assets:

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
packet; it is not silently retried or treated as success.

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
