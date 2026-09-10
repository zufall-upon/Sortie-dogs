/** Shared planner guidance and admission enums; no inferred acceptance or dispatch authority. */
export const GOAL_DELIVERY_INTENTS = ["design", "registration", "implementation", "repair", "controlled-change"] as const;
export const GOAL_DELIVERY_MODES = ["planning-only", "mvp-first", "repair-first", "controlled-change"] as const;

export const GOAL_DECLARATION_FORMAT = `Goal declaration belongs in the Task prompt, not in the handoff JSON or operation manifest.
delivery_intent must be exactly one of: ${GOAL_DELIVERY_INTENTS.join(" | ")}. Never use prose or a boolean.
delivery_mode is a separate optional enum: ${GOAL_DELIVERY_MODES.join(" | ")}.
Use flat key: value lines. Each criterion begins with its own goal_criterion_id: line.
Repeat the entire flat criterion block for multiple criteria. Do not use goal_criteria, goal_acceptance.criteria,
YAML object/list wrappers, inline { goal_criterion_id: ... }, or JSON objects for these blocks.
Replace every placeholder with the accepted task's actual value; preserve its acceptance and validation:
goal_acceptance_fingerprint: <sha256: followed by exactly 64 lowercase hexadecimal characters>
delivery_intent: implementation
delivery_mode: mvp-first
usable_path_established: false
controlled_change: false
goal_budget_units: <accepted positive integer>
goal_criterion_id: <stable criterion id>
goal_target: <requested behavior>
goal_entrypoint: <real entrypoint>
goal_workload: <requested workload>
goal_oracle_coverage: ["<actual oracle>"]
goal_build_boundary: <included | excluded | not-applicable>
goal_source: <fixed source label>
goal_candidate: <fixed candidate label>
goal_source_binding: current-protected
goal_candidate_binding: current-protected
goal_fixture: <actual fixture identity>
goal_proof_scope: requested-full
goal_expected_outcome: pass
goal_validation_command: <exact operation manifest validation command>
The example's implementation/mvp-first selections apply only to an implementation without its usable path;
select other enum values only from the accepted request. A declaration rejection launches no child.
Repair the Task prompt's named fields, not unrelated files; retry only with the corrected declaration.`;
