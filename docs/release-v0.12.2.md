# v0.12.2 — V2 optional-tool schema hotfix

On an explicitly configured Luna Fast/max Operator, v0.12.1 could still send
optional Sortie tool arguments using a provider-incompatible `optional` schema
annotation. The provider rejected `sortie_v010_reflection` before the model
could do any work.

- Make V2 custom-tool top-level argument schemas fully required. Previously
  optional string arguments use an empty-string omission sentinel on the wire,
  restored to absence before the legacy tool executes.
- Test the registered reflection tool and all other exposed V2 tools for this
  invariant, and verify omitted and supplied arguments reach the legacy tool
  with their original meaning.
- Exercise an isolated Luna Fast/max Operator request without running a mission;
  the existing Worker-start gate remains a separate bounded probe.

Runtime marker: `0.12.2-v2-required-tool-schema-v1`. Complete task and 23-case
benchmark scoring remain independent of this release validation.
