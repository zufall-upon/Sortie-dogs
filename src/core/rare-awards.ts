/** Presentation telemetry only. Never an execution, review, or acceptance input. */
export type ConditionState = "true" | "false" | "unknown";
export type RareStatus = "earned" | "not-earned" | "unknown";
export interface RareEvaluation {
  readonly id: string;
  readonly rule_version: number;
  readonly status: RareStatus;
  readonly evidence: readonly string[];
}
export interface RareAwards {
  readonly definition: string;
  readonly evaluations: readonly RareEvaluation[];
}
export const RARE_RULES = [
  { id: "rare.clean-sweep", rule_version: 1 },
  { id: "rare.recovery-coordination", rule_version: 1 },
] as const;

/** False dominates unknown for an AND; absence of a positive trait is not a negative proof. */
export function evaluateRareAwards(succeeded: boolean, clean: ConditionState, recovery: ConditionState,
  coordination: ConditionState): RareAwards {
  const status = (conditions: readonly ConditionState[]): RareStatus => !succeeded || conditions.includes("false")
    ? "not-earned" : conditions.includes("unknown") ? "unknown" : "earned";
  return { definition: "rare-awards/v1", evaluations: [
    { id: RARE_RULES[0].id, rule_version: 1, status: status([clean]),
      evidence: [succeeded ? "receipt.succeeded" : "receipt.not-succeeded", `clean-sweep.${clean}`] },
    { id: RARE_RULES[1].id, rule_version: 1, status: status([recovery, coordination]),
      evidence: [succeeded ? "receipt.succeeded" : "receipt.not-succeeded", `recovery.${recovery}`, `coordination.${coordination}`] },
  ] };
}

/** Bounded forward-compatible envelope: unknown definitions/rules remain telemetry, never awards. */
export function validRareAwards(value: unknown): value is RareAwards {
  if (value === null || typeof value !== "object") return false;
  const rare = value as RareAwards;
  const code = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9./_-]{0,95}$/u.test(v);
  return Object.keys(rare).every(key => ["definition", "evaluations"].includes(key)) && code(rare.definition) &&
    Array.isArray(rare.evaluations) && rare.evaluations.length <= 16 &&
    new Set(rare.evaluations.map(e => e && `${e.id}/${e.rule_version}`)).size === rare.evaluations.length &&
    rare.evaluations.every(e => e !== null && typeof e === "object" &&
      Object.keys(e).every(key => ["id", "rule_version", "status", "evidence"].includes(key)) && code(e.id) &&
      Number.isSafeInteger(e.rule_version) && e.rule_version > 0 && ["earned", "not-earned", "unknown"].includes(e.status) &&
      Array.isArray(e.evidence) && e.evidence.length <= 8 && new Set(e.evidence).size === e.evidence.length && e.evidence.every(code));
}

/** Recognize only this version and its host evidence contract, not a future rule's success string. */
export function rareEvaluation(rare: RareAwards | undefined, id: string): RareEvaluation | undefined {
  if (rare?.definition !== "rare-awards/v1") return undefined;
  const rule = RARE_RULES.find(rule => rule.id === id);
  const evaluation = rare.evaluations.find(e => e.id === id && e.rule_version === rule?.rule_version);
  if (evaluation === undefined) return undefined;
  const codes = evaluation.evidence;
  const state = (prefix: string): ConditionState | undefined => {
    const values = (["true", "false", "unknown"] as const).filter(s => codes.includes(`${prefix}.${s}`));
    return values.length === 1 ? values[0] : undefined;
  };
  const succeeded = codes.includes("receipt.succeeded");
  if (succeeded === codes.includes("receipt.not-succeeded")) return undefined;
  const clean = state("clean-sweep"), recovery = state("recovery"), coordination = state("coordination");
  if (id === RARE_RULES[0].id ? clean === undefined : recovery === undefined || coordination === undefined) return undefined;
  const expected = evaluateRareAwards(succeeded, clean ?? "unknown", recovery ?? "unknown", coordination ?? "unknown")
    .evaluations.find(e => e.id === id)!;
  return expected.status === evaluation.status && expected.evidence.length === codes.length &&
    expected.evidence.every(code => codes.includes(code)) ? evaluation : undefined;
}
