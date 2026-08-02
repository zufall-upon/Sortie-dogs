# RPT v0.2 Mk2A2 parity contract and acceptance matrix

## Contract boundary

RPT v0.2 packages OpenCode's existing `coordinator-mk2a2` workflow. The installed behavior MUST remain behaviorally equivalent to that canonical source except for explicit Mk2A2 packaging and portability deltas. This is not a new orchestration design.

Allowed runtime artifacts are standard OpenCode agents, commands, and plugins. RPT MUST NOT add a Project helper, capsule, controller, finite-state machine (FSM), routing ledger, dedicated harness, or any other independent orchestrator. The coordinator remains the sole user-facing workflow authority.

Internal Project URLs, item identifiers, item metadata, credentials, secrets, and raw logs MUST NOT appear in distributable files, packages, test fixtures, or public-repository evidence. Project tests use redacted synthetic data.

## Status and validation rules

- `provided`: the repository already distributes the complete row contract and has canonical validation for it.
- `partial`: a reusable primitive exists, but the end-to-end row contract or canonical validation is incomplete.
- `missing`: no distributable end-to-end implementation exists.
- Status describes the repository baseline at the creation of this matrix, not capability available only in a developer's local OpenCode configuration.
- Every implementation card MUST add its row-specific oracle to the normal `npm test` suite. `npm test` is the canonical local regression command; a row is not `provided` until that command exercises its oracle.
- Environment validation MUST install and run only under `_testenv` (`.\_testenv` on Windows). Card 10 additionally runs the WSL and Windows Desktop scenarios specified below.
- A passing lower-level primitive does not upgrade an end-to-end row from `partial` or `missing`.

## Card sequence

- **Card 02 — portable initialization:** package/install assets and repeatable project initialization.
- **Card 03 — command bootstrap:** `/sortie` entry, preflight, and primary-coordinator bootstrap.
- **Card 04 — canonical agents:** canonical coordinator/agent distribution.
- **Card 05 — Sol routing:** implementation, remediation, and blocker-resolution worker routing only.
- **Card 06 — handoff contract:** inline handoff plus source/operation manifest enforcement.
- **Card 07 — validation, review, and commit:** canonical validation, review thinning, `SourceReview`, and coordinator-only commit eligibility.
- **Card 08 — bounded batch and interruption recovery:** three-attempt continuation/compaction, question handling, blocker classification, and Sol takeover.
- **Card 09 — version and Project continuity:** version/update, checkpoint, and restart behavior.
- **Card 10 — release E2E:** clean WSL CLI and Windows Desktop installation/workflow validation.

Cards are ordered by dependency. A later card may refine an earlier card's tests but MUST NOT introduce an alternate coordinator or workflow state machine.

## Acceptance matrix

| ID | Parity contract / acceptance | Providing owner | Runtime artifact | Baseline | Implementation card | Canonical validation |
|---|---|---|---|---|---|---|
| P01 | A clean project can initialize RPT repeatedly without modifying global OpenCode state; generated project-local files are stable and upgrades preserve user-owned content. | Plugin installer | Standard plugin install/init path and project-local OpenCode files | missing | Card 02 | `npm test` with a clean `_testenv` init fixture, second-run idempotence assertion, and out-of-scope write assertion |
| P02 | `/sortie` performs real workflow bootstrap: validates initialization, gathers the task entry context, and transfers control to the primary coordinator. It MUST NOT remain a template that merely invokes `build`. | `/sortie` command | Standard OpenCode command | partial — current command is a `build` template only | Card 03 | `npm test` with command invocation asserting preflight and exactly one primary-coordinator handoff |
| P03 | `coordinator-mk2a2` is the primary, user-facing coordinator for the whole run. Workers never become the user interface and never invoke coordinators other than `coordinator-mk2a2`. | `coordinator-mk2a2` | Standard OpenCode agent | missing — canonical source exists locally but is not distributed by RPT | Card 03 | `npm test` with bootstrap/return routing assertions and a fixture rejecting worker-to-user or alternate-coordinator routing |
| P04 | Dedicated Sol runtime is assigned only to implementation, remediation, and blocker-resolution workers. Coordinator, planning, review, and other roles retain the canonical MkII model policy. | Coordinator model router | Standard agent model declarations plus existing plugin routing | partial — model-routing primitives exist; canonical agents and workflow do not | Card 05 | `npm test` with a complete role/model matrix, positive Sol cases, and negative non-implementation cases |
| P05 | The package distributes the canonical coordinator and required standard agents/commands as installable assets. Canonical text is delivered inline at each handoff; no worker depends on an external capsule or hidden session state. | Package installer and coordinator | Standard OpenCode agents/commands; inline messages | missing | Card 04 | `npm test` with clean-install asset inventory and handoff-content assertions; reject capsule/helper references |
| P06 | Every worker dispatch carries a bounded inline context digest containing acceptance, role, validation level, known facts, relevant constraints, and resume delta. Same-task resume preserves prior context and sends only stale-path/new-finding deltas. | `coordinator-mk2a2` | Inline handoff message | partial — handoff inspection exists, but no distributed coordinator emits the complete contract | Card 06 | `npm test` with initial and resumed handoff fixtures, required-field assertions, and no-redundant-context oracle |
| P07 | Source-changing work declares `source_manifest`; operational work declares `operation_manifest`. Workers may inspect, edit, validate, remediate, and self-check only within the declared contract. Manifest-external source, dependency, public API, storage, package, or build changes require an explicit handoff. | Coordinator and workers | Inline manifest fields enforced by plugin gates | partial — manifest inspection and write gating exist; workflow emission and end-to-end enforcement are incomplete | Card 06 | `npm test` with allowed source/operation fixtures and rejection of undeclared writes or mutations |
| P08 | Each unit has one named canonical validation. A worker runs targeted or full validation as handed off, preserves the immediate exit, applies only scoped remediation, and obeys same-command retry limits. Completion evidence records command, exit, and concise fingerprint. | Worker; coordinator verifies evidence | Standard test/build commands and inline evidence | partial — write gates exist, but canonical validation lifecycle is not distributed | Card 07 | `npm test` with PASS, first-failure/remediation, repeated-phase failure, exit-preservation, and evidence-shape fixtures |
| P09 | Review follows the canonical Mk2A2 thinning policy rather than reviewing every transition. When source review is required, `SourceReview` receives the bounded manifest diff/evidence and returns a verdict; skipped review remains an explicit coordinator decision. Policy thresholds and exceptions are inherited from canonical `coordinator-mk2a2`, not redefined by RPT. | Coordinator and `SourceReview` | Standard reviewer agent and inline review handoff | missing | Card 07 | `npm test` with canonical review-required, review-skipped, and adverse-verdict scenarios |
| P10 | Only the coordinator may determine commit eligibility and perform a commit after required validation/review. Workers, reviewers, and plugins MUST NOT stage, commit, amend, branch, or push. RPT never auto-publishes. | `coordinator-mk2a2` | Coordinator completion path plus plugin write gate | partial — gate primitives exist; coordinator completion path is absent | Card 07 | `npm test` with actor/operation permission matrix and coordinator eligibility precondition scenarios |
| P11 | Mk2A2 uses `batchTarget=3`. Every terminal unit outcome increments `Attempted`; only a successful coordinator commit increments `Done`. While `Attempted<3`, the coordinator queues `compact_and_continue` at an idle boundary only when an independent next unit exists. At the third attempt it stops and reports; it never dispatches a fourth unit within the batch. Compaction preserves task identity, accepted facts, manifests, validation history, counters, and next action. | `coordinator-mk2a2` | Standard coordinator continuation and platform compaction | missing | Card 08 | `npm test` with exactly three terminal attempts, continuation after a blocked attempt while `Attempted<3`, correct `Attempted`/`Done` counts, and no fourth dispatch |
| P12 | Ordinary implementation choices are resolved autonomously. A user question is emitted only for the canonical decision classes (destructive/irreversible action, unapproved credential or publication, acceptance change, or genuinely ambiguous product choice), and only the coordinator asks it. Resume consumes the answer without reinitializing the task. | `coordinator-mk2a2` | Standard question path and inline resume handoff | missing | Card 08 | `npm test` with autonomous-choice negatives, each allowed question class, coordinator-only emission, and answer-resume assertions |
| P13 | Blockers are classified as source defect, desired-state gap, local command/handoff defect, or true external blocker. The first three are sent to the dedicated Sol worker for autonomous takeover and resolution. Only proven credential, connection, permission, service, or product failures may end as true external blockers. | Coordinator and dedicated Sol worker | Standard blocker-resolution agent handoff | missing | Card 08 | `npm test` with all four classes, takeover resolution evidence, incomplete-inventory recovery, and true-blocker proof assertions |
| P14 | Project checkpointing occurs only at canonical workflow boundaries, uses the approved project-local bridge, and is non-authoritative: API failure cannot corrupt source/workflow state. Checkpoints expose no internal URL, item ID, metadata, credential, or raw response in package/public evidence. | Coordinator and project-local bridge | Existing plugin bridge plus inline redacted checkpoint result | partial — project-local bridge exists; canonical checkpoint lifecycle is absent | Card 09 | `npm test` with success, redaction, API-failure continuation, and no-public-metadata fixtures |
| P15 | Restart reconstructs the run from project-local durable artifacts and the latest bounded handoff/checkpoint, preserving manifests and validation history. Update replaces RPT-owned assets, preserves user-owned files, reports compatibility failure before mutation, and resumes through the primary coordinator. | Installer and `coordinator-mk2a2` | Standard plugin update/init assets and project-local state | missing | Card 09 | `npm test` with interrupted-run restart, compatible update, incompatible update rollback/no-mutation, and resume-routing scenarios |
| P16 | The packed release passes a clean WSL OpenCode CLI workflow and a clean Windows 11 OpenCode Desktop workflow: install/init, `/sortie`, at least one implementation Sol handoff, validation/review decision, coordinator completion, restart, and update. Tests operate only in `_testenv`, clean installed test artifacts, and retain no credential or raw log. | Release validation | Packed plugin plus standard OpenCode CLI/Desktop | missing | Card 10 | `npm test`, then WSL CLI E2E using `/home/rozen/.opencode/bin/opencode`, then approved Hyper-V Windows Desktop E2E; all three must exit `0` and satisfy the same scenario oracle |

## Cross-card release gates

RPT v0.2 is releasable only when:

1. P01–P16 are `provided`; `partial` cannot be waived as parity.
2. Cards 02–10 each have tests reachable from `npm test`.
3. The packed artifact contains only the standard agent, command, and plugin implementation needed by the matrix.
4. A package-content scan finds no Project URL/item metadata, credential, secret, raw log, Project helper, capsule, controller, FSM, routing ledger, dedicated harness, or alternate orchestrator.
5. WSL and Desktop E2E use the packed artifact from `_testenv`, not repository source or a developer-global fallback.
6. Validation evidence identifies commands, exits, and concise fingerprints without embedding raw logs.

## Baseline conclusion

The repository currently supplies useful manifest/handoff inspection, write-gate, model-routing, and project-local bridge primitives. It does not yet supply initialization, canonical agent distribution, or the workflow loop. Therefore no end-to-end parity row is classified `provided`; Cards 02–10 close the listed gaps without replacing `coordinator-mk2a2` with a new orchestrator.
