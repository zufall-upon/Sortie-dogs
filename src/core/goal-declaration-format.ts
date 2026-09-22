import { goalFingerprint } from "./goal-bound.ts";

/** Shared planner guidance and admission enums; no inferred acceptance or dispatch authority. */
export const GOAL_DELIVERY_INTENTS = ["design", "registration", "implementation", "repair", "controlled-change"] as const;
export const GOAL_DELIVERY_MODES = ["planning-only", "mvp-first", "repair-first", "controlled-change"] as const;
export const GOAL_CRITERION_ENUMS = {
  build_boundary: ["included", "excluded", "not-applicable"],
  proof_scope: ["requested-full", "document-deliverable", "expected-negative"],
  expected_outcome: ["pass", "fail"],
  source_binding: ["declared", "current-protected"],
  candidate_binding: ["declared", "current-protected"],
} as const;

const CRITERION_FIELDS = ["criterion_id", "target", "entrypoint", "workload", "oracle_coverage", "build_boundary", "source",
  "candidate", "source_binding", "candidate_binding", "fixture", "proof_scope", "expected_outcome", "validation_command"] as const;
export function hasGoalCommandAliasConflict(values: Record<string, unknown>): boolean {
  return Object.hasOwn(values, "goal_validation_command") && Object.hasOwn(values, "validation_command") &&
    values.goal_validation_command !== values.validation_command;
}
function normalizedCriterionFields(values: Record<string, unknown>): Record<string, unknown> {
  if (hasGoalCommandAliasConflict(values)) throw new Error("goal-validation-command-alias-conflict");
  return Object.fromEntries(CRITERION_FIELDS.flatMap(field => {
    const found = values[`goal_${field}`] ?? values[field];
    return found === undefined ? [] : [[`goal_${field}`, found]];
  }));
}

/** Shared root fields are defaults too. Explicit defaults and then per-criterion
 * fields take precedence; no commands, identifiers or criteria are rewritten. */
export function goalDeclarationDefaults(object: Record<string, unknown>): Record<string, unknown> {
  const defaults = object.defaults !== null && typeof object.defaults === "object" && !Array.isArray(object.defaults)
    ? object.defaults as Record<string, unknown> : {};
  return { ...normalizedCriterionFields(object), ...normalizedCriterionFields(defaults) };
}

export interface GoalDeclarationFieldDiagnostic {
  readonly pointer: string;
  readonly expected: string;
}

/** Validate structured planner fields before immutable controls exist; expansion itself remains lossless. */
export function goalDeclarationFieldDiagnostics(object: Record<string, unknown>): readonly GoalDeclarationFieldDiagnostic[] {
  const defects = new Map<string, GoalDeclarationFieldDiagnostic>();
  const add = (pointer: string, expected: string): void => { defects.set(pointer, { pointer, expected }); };
  const scalar = (value: unknown): string | undefined => typeof value === "string" ? value.trim()
    : typeof value === "boolean" || typeof value === "number" ? String(value) : undefined;
  const singleLine = (value: unknown): boolean => {
    const text = scalar(value);
    return text !== undefined && text.length > 0 && !/[\r\n]/u.test(String(value));
  };
  for (const [field, allowed, required] of [
    ["delivery_intent", GOAL_DELIVERY_INTENTS, true], ["delivery_mode", GOAL_DELIVERY_MODES, false],
    ["usable_path_established", ["true", "false"], true], ["controlled_change", ["true", "false"], true],
  ] as const) {
    if ((required || object[field] !== undefined) && (!singleLine(object[field]) || !allowed.some(item => item === scalar(object[field])))) {
      add(`/goal_declaration/${field}`, allowed.join(" | "));
    }
  }
  if (object.goal_acceptance_fingerprint !== undefined &&
      !/^sha256:[a-f0-9]{64}$/u.test(String(object.goal_acceptance_fingerprint))) {
    add("/goal_declaration/goal_acceptance_fingerprint", "sha256: followed by 64 lowercase hexadecimal characters");
  }
  const defaults = object.defaults !== null && typeof object.defaults === "object" && !Array.isArray(object.defaults)
    ? object.defaults as Record<string, unknown> : undefined;
  const criteria = Array.isArray(object.criteria) ? object.criteria : [];
  for (const [index, raw] of criteria.entries()) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const criterion = raw as Record<string, unknown>;
    const fieldValue = (field: string): { value: unknown; pointer: string } => {
      for (const [owner, prefix] of [[criterion, `/goal_declaration/criteria/${index}`],
        [defaults, "/goal_declaration/defaults"], [object, "/goal_declaration"]] as const) {
        if (!owner) continue;
        for (const key of [`goal_${field}`, field]) if (owner[key] !== undefined && owner[key] !== null) {
          return { value: owner[key], pointer: `${prefix}/${key}` };
        }
      }
      return { value: undefined, pointer: `/goal_declaration/${defaults ? "defaults/" : ""}${field}` };
    };
    for (const field of ["target", "entrypoint", "workload", "source", "candidate", "fixture"]) {
      const { value, pointer } = fieldValue(field);
      if (!singleLine(value)) add(pointer, "nonblank single-line scalar");
    }
    for (const [field, allowed] of Object.entries(GOAL_CRITERION_ENUMS)) {
      const { value, pointer } = fieldValue(field);
      if (value === undefined && (field === "source_binding" || field === "candidate_binding")) continue;
      if (!singleLine(value) || !allowed.some(item => item === scalar(value))) add(pointer, allowed.join(" | "));
    }
    const oracle = fieldValue("oracle_coverage");
    if (!Array.isArray(oracle.value) || oracle.value.length === 0 ||
        !oracle.value.every(item => typeof item === "string" && item.length > 0 && item.length <= 512) ||
        new Set(oracle.value).size !== oracle.value.length) add(oracle.pointer, "nonempty unique string array; each string has 1..512 characters");
  }
  return [...defects.values()];
}

export const GOAL_DECLARATION_FORMAT = `Declare a goal once, then reference it with goal_declaration_path in the Task prompt.
The referenced JSON may contain shared defaults and a criteria array; the host expands them privately.
An inline ext["sortie-dogs/goal-declaration"] in the registered handoff is also supported.
Existing accepted goals need no repeated declaration; budget-only revisions retain their criteria.
Legacy flat goal_* fields remain supported. No need to rewrite unrelated files or repeat common fields for each criterion.
delivery_intent must be exactly one of: ${GOAL_DELIVERY_INTENTS.join(" | ")}. Never use prose or a boolean.
delivery_mode is a separate optional enum: ${GOAL_DELIVERY_MODES.join(" | ")}.
Use flat key: value lines. Each criterion begins with its own goal_criterion_id: line.
For legacy flat input each criterion has a goal_criterion_id line. Prefer shared JSON defaults for multiple criteria.
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

/** Normalize a shared declaration without guessing acceptance, coverage, delivery, or validation. */
export function expandGoalDeclaration(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("goal declaration must be an object");
  const object = value as Record<string, unknown>;
  if (!Array.isArray(object.criteria) || object.criteria.length === 0) throw new Error("goal declaration requires criteria");
  const defaults = goalDeclarationDefaults(object);
  const fields = CRITERION_FIELDS;
  const scalar = (value: unknown): string => {
    if (Array.isArray(value)) return JSON.stringify(value);
    if (typeof value === "string" && !/[\r\n]/u.test(value)) return value;
    if (typeof value === "boolean" || typeof value === "number") return String(value);
    throw new Error("goal declaration field must be a single-line scalar or array");
  };
  const criteria = object.criteria.map(raw => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("goal criterion must be an object");
    return { ...defaults, ...normalizedCriterionFields(raw as Record<string, unknown>) };
  });
  const identity = { criteria, delivery_intent: object.delivery_intent, delivery_mode: object.delivery_mode,
    usable_path_established: object.usable_path_established, controlled_change: object.controlled_change };
  const lines = [`goal_acceptance_fingerprint: ${scalar(object.goal_acceptance_fingerprint ?? goalFingerprint(identity))}`];
  for (const field of ["delivery_intent", "delivery_mode", "usable_path_established", "controlled_change",
    "goal_budget_units", "goal_budget_time_ms", "goal_budget_cost_usd"]) {
    if (object[field] !== undefined) lines.push(`${field}: ${scalar(object[field])}`);
  }
  for (const criterion of criteria) {
    criterion.goal_criterion_id ??= `criterion-${goalFingerprint(criterion).slice(7, 31)}`;
    for (const field of fields) if (criterion[`goal_${field}`] !== undefined) lines.push(`goal_${field}: ${scalar(criterion[`goal_${field}`])}`);
  }
  return lines.join("\n");
}
