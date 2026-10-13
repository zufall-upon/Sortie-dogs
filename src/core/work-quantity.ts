/** Display-only request workload. No filesystem, hashing, model, process or network access. */
import type { OperatorMission } from "./operator-mission.js";
import type { OperatorState } from "./operator-runtime.js";

export type WorkKind = "requirement" | "implementation" | "artifact" | "validation" | "operation" | "review" | "delivery" | "acceptance" | "user-acceptance";
export interface WorkObservation {
  read?: boolean; changed?: boolean; started?: boolean; passed?: boolean; failed?: boolean;
  reported?: boolean; settled?: string; invalidated?: boolean; callID?: string;
  changedTargets?: string[];
}
export interface WorkQuantityItem {
  id: string; label: string; kind: WorkKind; requirementIDs: string[]; weight: number;
  basis: "declared" | "derived" | "fallback"; parentID?: string;
  paths: string[]; commands: string[]; units: string[]; observation: WorkObservation;
  fraction: number; removed?: boolean; children?: string[];
  targetEstimate?: number;
  aliases?: string[];
  commandPattern?: "pr" | "push" | "publish" | "deploy" | "install";
}
export interface WorkQuantityState {
  version: 1; scopeID: string; revision: number; revisionReason?: string;
  items: WorkQuantityItem[]; estimatedTotal: number; estimatedDone: number;
  basis: "declared" | "derived" | "fallback" | "mixed";
  pendingCount: number; remainingKinds: WorkKind[]; lastReview?: string;
  observationSequence?: number;
  planRunID?: string;
}
export interface WorkQuantityProgress {
  n: number; denominator: 100; scope_id: string; scope: "whole-request"; estimated: true;
  basis: WorkQuantityState["basis"]; estimated_done: number; estimated_total: number;
  estimate_revision: number; revision_reason?: string; completed: boolean; cancelled: boolean;
  remaining_kinds: WorkKind[];
}
export interface WorkQuantityEvent {
  kind: "read" | "change" | "command-start" | "command-end" | "checkpoint" | "user-acceptance";
  paths?: readonly string[]; command?: string; commands?: readonly string[]; unit?: string;
  callID?: string; exit?: number | null; successful?: boolean; checkpoints?: readonly string[];
}
type WorkUnit = { id?: string; title?: string; objective?: string; read?: readonly string[]; write?: readonly string[];
  validation?: readonly string[]; requirement_ids?: readonly string[]; acceptance_indices?: readonly number[] };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item.trim()) : [];
const unique = (values: readonly string[]) => [...new Set(values)].sort();
const key = (value: string) => value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
const commandKey = (value: string) => value.trim().replace(/^&\s+/u, "").replace(/\s+/gu, " ");
const weight: Record<WorkKind, number> = { requirement: 8, implementation: 12, artifact: 8, validation: 3,
  operation: 8, review: 4, delivery: 2, acceptance: 1, "user-acceptance": 3 };
const kinds = Object.keys(weight) as WorkKind[];
function deliveryPattern(text: string): WorkQuantityItem["commandPattern"] {
  if (/(?:PR(?:作成|実施|提出)|pull request|create\b.*\bPR\b)/iu.test(text)) return "pr";
  if (/(?:\bpush\b|プッシュ)/iu.test(text)) return "push";
  if (/(?:npm\s+publish|publish\b|パッケージ公開)/iu.test(text)) return "publish";
  if (/(?:deploy\b|デプロイ)/iu.test(text)) return "deploy";
  if (/(?:global\b.*(?:install|apply|反映)|グローバル.*(?:反映|インストール))/iu.test(text)) return "install";
  return undefined;
}
const isConstraint = (text: string) => /^\s*(?:do not\b|don't\b|never\b|no\s+(?:new|actual|paid|additional)\b|禁止[：:]|禁止事項[：:])/iu.test(text) ||
  /(?:禁止|しない)(?:こと)?[。.]?$/u.test(text);
const broad = (path: string) => /[*?]/u.test(path) || /[\\/]$/u.test(path) || [".", "./", ".\\"].includes(path);
const incidental = (path: string) => /(?:^|\/)(?:\.git|\.opencode|\.sortie-dogs(?:-v010)?)(?:\/|$)/u.test(key(path));
function pathMatches(actual: string, binding: string): boolean {
  const a = key(actual), b = key(binding).replace(/\/\*\*$/u, "");
  return a === b || broad(binding) && ([".", "**"].includes(b) || a.startsWith(`${b}/`));
}
function fraction(item: WorkQuantityItem): number {
  const o = item.observation;
  if (item.removed) return 0;
  if (o.settled && !o.invalidated) return 1;
  if (o.failed) return o.changed ? 0.35 : o.started ? 0.1 : o.read ? 0.08 : 0;
  if (o.passed) return 0.9;
  if (o.reported) return 0.8;
  if (o.changed) return item.targetEstimate ? Math.min(0.55, 0.55 * (o.changedTargets?.length ?? 1) / item.targetEstimate) : 0.55;
  if (o.started) return 0.15;
  return o.read ? 0.08 : 0;
}
function summarize(state: WorkQuantityState): WorkQuantityState {
  let total = 0, done = 0;
  const bases = new Set<string>(), remaining = new Set<WorkKind>();
  state.pendingCount = 0;
  for (const item of state.items) {
    item.fraction = fraction(item);
    if (item.removed || item.children?.length) continue;
    total += item.weight; done += item.weight * item.fraction; bases.add(item.basis);
    if (item.fraction < 1) { state.pendingCount++; remaining.add(item.kind); }
  }
  state.estimatedTotal = total; state.estimatedDone = done;
  state.basis = bases.size === 1 ? [...bases][0] as WorkQuantityState["basis"] : "mixed";
  state.remainingKinds = [...remaining];
  return state;
}
function item(id: string, kind: WorkKind, label: string, requirements: string[], paths: string[] = [], commands: string[] = [], units: string[] = []): WorkQuantityItem {
  return { id, kind, label, requirementIDs: unique(requirements), weight: weight[kind], basis: "derived",
    paths: unique(paths.map(key)), commands: unique(commands.map(commandKey)), units: unique(units), observation: {}, fraction: 0 };
}
/** Concrete work before scheduling/coalescence; broad scopes remain unexpanded estimates. */
export function planWorkQuantity(mission: Pick<OperatorMission, "id" | "requirements" | "kind" | "execution" | "review" | "submission" | "phase">,
  rawUnits: readonly WorkUnit[] = [], run?: OperatorState, previous?: WorkQuantityState, declared?: unknown, directory?: string): WorkQuantityState {
  const pathKey = (path: string) => {
    const p = key(path), root = directory && key(directory);
    return root && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p;
  };
  const state: WorkQuantityState = previous ? structuredClone(previous) : { version: 1, scopeID: mission.id, revision: 1,
    items: [], estimatedTotal: 0, estimatedDone: 0, basis: "fallback", pendingCount: 0, remainingKinds: [] };
  const signature = (value: WorkQuantityState) => JSON.stringify(value.items.map(({ id, kind, weight, parentID, children, removed, targetEstimate }) =>
    ({ id, kind, weight, parentID, children: children ?? [], removed: !!removed, targetEstimate })).sort((a, b) => a.id.localeCompare(b.id)));
  const oldShape = signature(state);
  const generated = new Map<string, WorkQuantityItem>(), covered = new Set<string>();
  for (const entry of previous?.items ?? []) if (!entry.removed && entry.kind !== "requirement" &&
      ["artifact", "implementation", "validation", "operation"].includes(entry.kind)) entry.requirementIDs.forEach(id => covered.add(id));
  const add = (entry: WorkQuantityItem) => {
    const existing = generated.get(entry.id);
    if (existing) {
      existing.requirementIDs = unique([...existing.requirementIDs, ...entry.requirementIDs]);
      existing.units = unique([...existing.units, ...entry.units]);
    } else generated.set(entry.id, entry);
  };
  const required = mission.requirements.filter(requirement => !isConstraint(requirement.text));
  const addedRequirements = new Set(previous ? required.filter(requirement =>
    !previous.items.some(entry => entry.requirementIDs.includes(requirement.id))).map(requirement => requirement.id) : []);
  for (const [index, unit] of rawUnits.entries()) {
    const ids = strings(unit.requirement_ids).length ? strings(unit.requirement_ids)
      : unit.acceptance_indices ? unit.acceptance_indices.map(i => mission.requirements[i]?.id).filter((id): id is string => !!id)
      : rawUnits.length === 1 || mission.requirements.length === 1 ? mission.requirements.map(requirement => requirement.id) : [];
    ids.forEach(id => covered.add(id));
    const scheduled = run?.units.filter(candidate => !!unit.validation?.length && candidate.unit.validation.at(-1) === unit.validation.at(-1) ||
      !!unit.id && candidate.unit.id === unit.id || !!unit.objective && candidate.unit.objective === unit.objective) ?? [];
    const units = scheduled.map(candidate => `${run!.runID}/${candidate.unit.id}`);
    const outputs = strings(unit.write).map(pathKey).filter(path => !incidental(path));
    const concrete = outputs.filter(path => !broad(path));
    for (const path of concrete) add(item(`artifact:${key(path)}`, "artifact", path, ids, [path], [], units));
    if (!concrete.length || outputs.some(broad)) {
      const anchor = unique(ids)[0] ?? "request";
      const binding = unique(outputs.filter(broad).map(key)).join(",") || unique(strings(unit.read).map(pathKey)).join(",");
      const entry = item(`implementation:${binding || anchor}`, "implementation", unit.title ?? unit.objective ?? "Implementation", ids,
        outputs.length ? outputs : strings(unit.read).map(pathKey), [], units);
      if (outputs.some(broad)) entry.targetEstimate = Math.max(4, strings(unit.read).filter(path => !broad(path) && !incidental(path)).length);
      add(entry);
    }
    for (const command of strings(unit.validation)) add(item(`validation:${commandKey(command)}`, "validation", command, ids, [], [command], units));
  }
  for (const requirement of required) if (!covered.has(requirement.id)) {
    const id = addedRequirements.has(requirement.id) ? `scope-addition:${requirement.id}` : `requirement:${requirement.id}`;
    if (state.items.some(entry => entry.id === `scope-addition:${requirement.id}`)) continue;
    const entry = item(id, "requirement", requirement.text, [requirement.id]);
    entry.basis = "fallback"; add(entry);
  }
  for (const requirement of required) if (addedRequirements.has(requirement.id) && covered.has(requirement.id)) {
    const entry = item(`scope-addition:${requirement.id}`, "requirement", requirement.text, [requirement.id]); entry.basis = "fallback"; add(entry);
  }
  if (!required.length && !generated.size) {
    const entry = item("request-work", "requirement", "Requested work and constraints", mission.requirements.map(r => r.id));
    entry.basis = "fallback"; add(entry);
  }
  for (const command of mission.execution?.commands ?? []) add(item(`operation:${commandKey(command)}`, "operation", command,
    required.map(r => r.id), [], [command]));
  for (const requirement of required) {
    const pattern = deliveryPattern(requirement.text);
    if (pattern) {
      const entry = item(`delivery-requirement:${requirement.id}`, "delivery", requirement.text, [requirement.id]);
      entry.weight = weight.requirement; entry.basis = "fallback"; entry.commandPattern = pattern; add(entry);
    }
  }
  // Existing Mission completion uses Review/submission/root acceptance. These
  // are remaining work, not new permissions or newly required workflow stages.
  add(item("mission-review", "review", "Existing review assessment", required.map(r => r.id)));
  add(item("mission-delivery", "delivery", "Requested result delivery", required.map(r => r.id)));
  add(item("mission-acceptance", "acceptance", "Existing final acceptance", required.map(r => r.id)));
  if (mission.requirements.some(r => /(?:個別受入|実機受入|利用者.*受入|user acceptance|manual acceptance)/iu.test(r.text))) {
    add(item("user-acceptance", "user-acceptance", "Requested user acceptance", required.map(r => r.id)));
  }
  for (const next of generated.values()) {
    let existing = state.items.find(entry => entry.id === next.id);
    if (existing) {
      existing.removed = false;
      if (next.units.length && JSON.stringify(existing.units) !== JSON.stringify(next.units)) {
        existing.units = next.units;
      }
      existing.requirementIDs = unique([...existing.requirementIDs, ...next.requirementIDs]);
      if (next.targetEstimate) existing.targetEstimate = next.targetEstimate;
    } else { existing = next; state.items.push(existing); }
    if (run && previous?.planRunID && run.runID !== previous.planRunID && ["review", "delivery", "acceptance"].includes(existing.kind)) {
      existing.observation.invalidated = true;
    }
  }
  // A concrete allocation replaces, rather than adds to, its unallocated estimate.
  for (const entry of state.items) if (entry.kind === "requirement" && entry.id.startsWith("requirement:") && entry.requirementIDs.every(id => covered.has(id))) entry.removed = true;
  for (const entry of state.items.filter(entry => entry.id.startsWith("scope-addition:"))) {
    const allocated = [...generated.values()].filter(work => ["artifact", "implementation"].includes(work.kind) &&
      work.requirementIDs.some(id => entry.requirementIDs.includes(id))).flatMap(work => work.units);
    if (allocated.length) entry.units = unique(allocated);
  }
  applyDeclaredWork(state, declared, generated, pathKey);
  // A later plan may omit optional estimates without revoking the retained
  // breakdown or adding its derived aliases a second time.
  for (const declared of state.items.filter(entry => entry.basis === "declared" && !entry.removed && !entry.parentID)) {
    const aliases = [...generated.values()].filter(entry => declared.aliases?.includes(entry.id));
    const units = unique(aliases.flatMap(entry => entry.units));
    if (units.length) declared.units = units;
    for (const child of state.items.filter(entry => entry.parentID === declared.id && !entry.removed)) {
      const matched = aliases.filter(entry => !child.paths.length && !child.commands.length || entry.paths.some(path => child.paths.includes(path)) ||
        entry.commands.some(command => child.commands.includes(command)));
      const units = unique(matched.flatMap(entry => entry.units));
      if (units.length) child.units = units;
    }
    for (const generated of state.items.filter(entry => entry.basis !== "declared")) {
      if (declared.aliases?.includes(generated.id)) { generated.removed = true; continue; }
      if (generated.kind !== declared.kind) continue;
      if (generated.paths.some(path => declared.paths.includes(path)) || generated.commands.some(command => declared.commands.includes(command)) ||
          !generated.paths.length && !generated.commands.length && generated.kind === declared.kind) generated.removed = true;
    }
  }
  summarize(state);
  if (run) state.planRunID = run.runID;
  const changed = previous && signature(state) !== oldShape;
  if (changed) { state.revision++; state.revisionReason = "work breakdown or scope estimate updated"; }
  return state;
}
/** Optional estimates never enter execution contracts or turn bad metadata into an admission failure. */
function applyDeclaredWork(state: WorkQuantityState, raw: unknown, generated: Map<string, WorkQuantityItem>, pathKey: (path: string) => string): void {
  if (!Array.isArray(raw)) return;
  const seen = new Set<string>();
  for (const value of raw) {
    if (!record(value) || typeof value.id !== "string" || !value.id.trim() || seen.has(value.id)) continue;
    seen.add(value.id);
    const binding = record(value.bindings) ? value.bindings : value;
    const paths = strings(binding.paths).map(pathKey), commands = strings(binding.commands ?? binding.validation).map(commandKey);
    const requirements = strings(binding.requirement_ids ?? value.requirement_ids);
    const kind = kinds.includes(value.kind as WorkKind) ? value.kind as WorkKind : paths.length ? "artifact" : commands.length ? "validation" : "implementation";
    const matches = [...generated.values()].filter(entry => (entry.kind === kind || kind === "implementation" && entry.kind === "artifact") &&
      (paths.some(path => entry.paths.includes(path)) || commands.some(command => entry.commands.includes(command)) ||
        requirements.length > 0 && requirements.some(id => entry.requirementIDs.includes(id)) ||
        !paths.length && !commands.length && ["review", "delivery", "acceptance", "user-acceptance"].includes(kind)));
    if (!matches.length || matches.some(entry => state.items.find(item => item.id === entry.id)?.removed)) continue;
    const existing = state.items.find(entry => entry.id === `declared:${value.id}`);
    const amount = typeof value.relative_weight === "number" && Number.isFinite(value.relative_weight) && value.relative_weight > 0 && value.relative_weight <= Number.MAX_SAFE_INTEGER
      ? value.relative_weight : matches.reduce((sum, entry) => sum + entry.weight, 0);
    const parent = existing ?? item(`declared:${value.id}`, kind, typeof value.label === "string" ? value.label : matches[0]!.label,
      matches.flatMap(entry => entry.requirementIDs), matches.flatMap(entry => entry.paths), matches.flatMap(entry => entry.commands), matches.flatMap(entry => entry.units));
    parent.weight = amount; parent.basis = "declared"; parent.removed = false;
    if (!existing) parent.observation = { ...state.items.find(entry => entry.id === matches[0]!.id)?.observation };
    parent.units = unique(matches.flatMap(entry => entry.units));
    parent.paths = unique(matches.flatMap(entry => entry.paths)); parent.commands = unique(matches.flatMap(entry => entry.commands));
    parent.aliases = matches.map(entry => entry.id);
    if (!existing) state.items.push(parent);
    for (const matched of matches) { const entry = state.items.find(item => item.id === matched.id)!; entry.removed = true; }
    if (Array.isArray(value.checkpoints)) {
      const points = value.checkpoints.filter(record).filter(point => typeof point.id === "string" && point.id);
      const ids = new Set<string>();
      const usable = points.filter(point => { if (ids.has(point.id as string)) return false; ids.add(point.id as string); return true; });
      const quantities = usable.map(point => typeof point.relative_weight === "number" && Number.isFinite(point.relative_weight) &&
        point.relative_weight > 0 && point.relative_weight <= Number.MAX_SAFE_INTEGER ? point.relative_weight : 1);
      const sum = quantities.reduce((a, b) => a + b, 0);
      if (sum > 0) {
        const next = usable.map(point => `${parent.id}/checkpoint:${point.id}`);
        for (const child of state.items.filter(entry => entry.parentID === parent.id && !next.includes(entry.id))) child.removed = true;
        parent.children = next;
        usable.forEach((point, index) => {
          const id = parent.children![index]!, child = state.items.find(entry => entry.id === id) ?? item(id, kind,
            typeof point.label === "string" ? point.label : String(point.id), parent.requirementIDs,
            strings(point.paths), strings(point.commands), parent.units);
          child.units = parent.units; child.paths = strings(point.paths).map(pathKey); child.commands = strings(point.commands).map(commandKey);
          if (!state.items.includes(child)) child.observation = { ...parent.observation };
          child.parentID = parent.id; child.weight = amount * quantities[index]! / sum; child.basis = "declared"; child.removed = false;
          if (!state.items.includes(child)) state.items.push(child);
        });
      }
    }
  }
}
export function observeWorkQuantity(state: WorkQuantityState, event: WorkQuantityEvent): WorkQuantityState {
  const paths = (event.paths ?? []).filter(path => !incidental(path));
  const commands = [...(event.commands ?? []), ...(event.command ? [event.command] : [])].map(commandKey);
  if (event.kind === "change" && event.unit) {
    const related = state.items.filter(entry => !entry.removed && ["artifact", "implementation"].includes(entry.kind) && entry.units.includes(event.unit!));
    for (const path of unique(paths.map(key))) if (related.length &&
        !related.some(entry => entry.paths.some(binding => pathMatches(path, binding))) &&
        !state.items.some(entry => entry.id === `artifact:${path}`)) {
      state.items.push(item(`artifact:${path}`, "artifact", path, related.flatMap(entry => entry.requirementIDs), [path], [], [event.unit]));
      state.revision++; state.revisionReason = "native work revealed an additional target";
    }
  }
  for (const entry of state.items) {
    if (entry.removed || entry.children?.length) continue;
    const pathMatch = paths.some(path => entry.paths.some(binding => pathMatches(path, binding)));
    const unitMatch = event.unit !== undefined && entry.units.includes(event.unit);
    const commandMatch = commands.some(command => entry.commands.includes(command));
    const deliveryCommand = entry.commandPattern && commands.some(command => {
      switch (entry.commandPattern) {
        case "pr": return /(?:^|\s)gh\s+pr\s+create(?:\s|$)/u.test(command);
        case "push": return /(?:^|\s)git\s+push(?:\s|$)/u.test(command);
        case "publish": return /(?:^|\s)npm\s+publish(?:\s|$)/u.test(command);
        case "deploy": return /(?:^|\s)(?:vercel|netlify|wrangler)\s+deploy(?:\s|$)/u.test(command);
        case "install": return /(?:^|\s)npm\s+(?:install|i)\b.*(?:--global|-g)\b/u.test(command);
      }
    });
    const unallocated = entry.kind === "requirement" && !entry.paths.length;
    if (event.kind === "read" && (pathMatch || unallocated && paths.length)) entry.observation.read = true;
    if (event.kind === "change") {
      if (pathMatch && (entry.kind === "artifact" || entry.kind === "implementation")) {
        entry.observation.changed = true;
        if (entry.targetEstimate) entry.observation.changedTargets = unique([...(entry.observation.changedTargets ?? []),
          ...paths.filter(path => entry.paths.some(binding => pathMatches(path, binding))).map(key)]).slice(0, 64);
      }
      if ((unitMatch || pathMatch) && ["artifact", "implementation", "validation"].includes(entry.kind) || entry.kind === "review" && paths.length > 0) {
        entry.observation.invalidated = true; entry.observation.passed = false; entry.observation.reported = false;
      }
    }
    if (event.kind === "command-start" && (commandMatch || deliveryCommand)) entry.observation.started = true;
    if (event.kind === "command-end" && (commandMatch || deliveryCommand)) {
      entry.observation.started = true; entry.observation.passed = event.exit === 0 && event.successful !== false;
      entry.observation.failed = !entry.observation.passed;
      if (event.callID !== undefined) entry.observation.callID = event.callID;
      else delete entry.observation.callID;
      entry.observation.invalidated = true;
    }
    if (event.kind === "checkpoint" && event.checkpoints?.some(id => entry.id.endsWith(`/checkpoint:${id}`))) entry.observation.reported = true;
    if (event.kind === "user-acceptance" && entry.kind === "user-acceptance") entry.observation.settled = event.callID ?? "existing-user-acceptance";
  }
  return summarize(state);
}
/** Existing recorded outcomes only. No freshness checks, history reads, Git inspection or acceptance actions. */
export function syncWorkQuantity(state: WorkQuantityState, mission: Partial<OperatorMission>, run?: OperatorState): WorkQuantityState {
  const current = run && (mission.runID === undefined || mission.runID === run.runID) ? run : undefined;
  const review = mission.review;
  const reviewRef = review && `${review.runID}:${review.promptID ?? review.callID ?? review.source}:${review.verdict}`;
  const newFinding = review && review.runID === (current?.runID ?? mission.runID) && review.verdict === "findings" && state.lastReview !== reviewRef;
  if (newFinding) {
    state.revision++; state.revisionReason = "review identified remaining corrective work";
  }
  if (reviewRef !== undefined) state.lastReview = reviewRef;
  else delete state.lastReview;
  for (const entry of state.items) {
    if (entry.removed || entry.children?.length) continue;
    const units = current?.units.filter(unit => entry.units.includes(`${current.runID}/${unit.unit.id}`)) ?? [];
    if (["artifact", "implementation", "validation", "requirement"].includes(entry.kind) && units.length && units.every(unit => unit.status === "succeeded")) {
      const ref = `${current!.runID}:${units.map(unit => unit.callID).join(",")}`;
      if (entry.observation.settled !== ref) { entry.observation.settled = ref; entry.observation.invalidated = false; entry.observation.failed = false; }
    }
    if (entry.kind === "validation") {
      const checks = units.flatMap(unit => unit.directExecution?.checks ?? unit.reviewerCorrection?.checks ?? [])
        .filter(check => check.command.some(command => entry.commands.includes(commandKey(command))));
      const latest = checks.at(-1);
      if (latest && latest.callID !== entry.observation.callID) {
        entry.observation.callID = latest.callID; entry.observation.started = true;
        entry.observation.passed = latest.exitCode === 0 && latest.fresh;
        entry.observation.failed = latest.exitCode !== 0;
        entry.observation.invalidated = entry.observation.failed || !units.every(unit => unit.status === "succeeded");
      }
    }
    if (entry.kind === "operation") {
      const observation = [...(mission.execution?.observations ?? [])].reverse().find(value => entry.commands.includes(commandKey(value.command)));
      if (observation) {
        entry.observation.started = true;
        if (observation.completedAt && ["executed", "execution-failed"].includes(observation.outcome ?? "")) entry.observation.settled = observation.callID;
      }
    }
    if (entry.kind === "review" && mission.review && mission.review.runID === (current?.runID ?? mission.runID) && mission.review.verdict !== "pending") {
      const ref = `${mission.review.runID}:${mission.review.promptID ?? mission.review.callID ?? mission.review.source}:${mission.review.verdict}`;
      if (["PASS", "skipped-low-risk", "self-rechecked", "evidence-gaps"].includes(mission.review.verdict)) {
        if (entry.observation.settled !== ref) { entry.observation.settled = ref; entry.observation.invalidated = false; entry.observation.failed = false; }
      } else { entry.observation.failed = true; entry.observation.invalidated = true; }
      if (mission.review.verdict === "skipped-low-risk") entry.removed = true;
    }
    if (entry.kind === "delivery" && !entry.id.startsWith("delivery-requirement:") && mission.submission?.status === "ready") {
      entry.observation.settled = `submission:${mission.runID}`; entry.observation.invalidated = false;
    }
    if (entry.kind === "acceptance" && (mission.phase === "completed" || mission.phase === undefined && current?.phase === "completed")) {
      entry.observation.settled = "existing-final-acceptance"; entry.observation.invalidated = false;
    }
    if ((entry.kind === "requirement" || entry.kind === "delivery") &&
        (mission.phase === "completed" || mission.phase === undefined && current?.phase === "completed")) {
      entry.observation.settled = "existing-request-completion"; entry.observation.invalidated = false;
    }
    if (entry.kind === "user-acceptance" && mission.phase === "completed") entry.observation.settled = "existing-whole-request-acceptance";
    if (entry.kind === "review" && mission.phase === undefined && current?.phase === "completed") {
      entry.observation.settled = "existing-root-review-acceptance"; entry.observation.invalidated = false;
    }
  }
  if (newFinding) for (const entry of state.items.filter(entry => ["artifact", "implementation", "validation"].includes(entry.kind))) {
    entry.observation.invalidated = true; entry.observation.passed = false;
  }
  return summarize(state);
}
export function projectWorkQuantity(state: WorkQuantityState, completed = false, cancelled = false): WorkQuantityProgress {
  // The host's existing full-request completion closes even an incompletely
  // observed estimate. Optional display bindings must never become a new gate.
  const accepted = completed && !cancelled;
  const n = accepted ? 100 : Math.min(99, Math.max(0, Math.floor(state.estimatedTotal > 0 ? 100 * state.estimatedDone / state.estimatedTotal : 0)));
  return { n, denominator: 100, scope_id: state.scopeID, scope: "whole-request", estimated: true, basis: state.basis,
    estimated_done: accepted ? state.estimatedTotal : state.estimatedDone, estimated_total: state.estimatedTotal, estimate_revision: state.revision,
    ...(state.revisionReason ? { revision_reason: state.revisionReason } : {}), completed: accepted, cancelled,
    remaining_kinds: accepted ? [] : state.remainingKinds };
}
export function formatWorkQuantity(progress: WorkQuantityProgress): string {
  return `全体作業量 ${progress.n}/100（概算）${progress.estimate_revision > 1 ? " · 見積更新" : ""}`;
}
