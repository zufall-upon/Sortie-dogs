import { worktreeScopesOverlap } from "./worktree-scope.js";
import type { LunaFabricContract, LunaFabricUnit } from "./luna-fabric-contract.js";

export const LUNA_FABRIC_MAX_ACTIVE = 5;

export interface LunaFabricWave {
  readonly number: number;
  readonly base_sha: string;
  readonly unit_ids: readonly string[];
  readonly lanes: Readonly<Record<string, number>>;
}

export interface LunaFabricSchedulerState {
  readonly wave: number;
  readonly base_sha: string;
  readonly pending: readonly string[];
  readonly completed: readonly string[];
  readonly active: LunaFabricWave | null;
  readonly lane_affinity: Readonly<Record<string, number>>;
}

export interface LunaFabricAdvance {
  readonly candidate_base: string;
  readonly completed_unit_ids: readonly string[];
}

function overlap(left: LunaFabricUnit, right: LunaFabricUnit): boolean {
  return left.scope_write.some((path) => [...right.scope_write, ...right.scope_read]
    .some((other) => worktreeScopesOverlap(path, other))) ||
    right.scope_write.some((path) => left.scope_read.some((other) => worktreeScopesOverlap(path, other)));
}

function shared(left: LunaFabricUnit, right: LunaFabricUnit): boolean {
  return left.shared_path_keys.some((key) => right.shared_path_keys.includes(key));
}

function resourceConflict(left: LunaFabricUnit, right: LunaFabricUnit): boolean {
  return left.exclusive_resources.some((resource) => right.exclusive_resources.includes(resource));
}

function remainingDepth(units: readonly LunaFabricUnit[], completed: ReadonlySet<string>): Map<string, number> {
  const byID = new Map(units.map((unit) => [unit.unit_id, unit]));
  const children = new Map<string, string[]>();
  for (const unit of units) for (const dependency of unit.depends_on) {
    const list = children.get(dependency) ?? [];
    list.push(unit.unit_id);
    children.set(dependency, list);
  }
  const cache = new Map<string, number>();
  const depth = (id: string): number => {
    const known = cache.get(id);
    if (known !== undefined) return known;
    const unit = byID.get(id);
    if (unit === undefined || completed.has(id)) return 0;
    const value = 1 + Math.max(0, ...(children.get(id) ?? []).map((child) => depth(child)));
    cache.set(id, value);
    return value;
  };
  for (const unit of units) depth(unit.unit_id);
  return cache;
}

function initialState(base_sha: string): LunaFabricSchedulerState {
  return { wave: 0, base_sha, pending: [], completed: [], active: null, lane_affinity: {} };
}

export class LunaFabricScheduler {
  private readonly byID: ReadonlyMap<string, LunaFabricUnit>;

  constructor(private readonly contract: LunaFabricContract, base_sha: string, state?: LunaFabricSchedulerState) {
    this.byID = new Map(contract.units.map((unit) => [unit.unit_id, unit]));
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(base_sha)) throw new Error("invalid fabric base");
    this.state = state === undefined ? { ...initialState(base_sha), pending: contract.units.map(({ unit_id }) => unit_id) } : state;
    this.validateState();
  }

  private state: LunaFabricSchedulerState;

  snapshot(): LunaFabricSchedulerState { return structuredClone(this.state); }

  nextWave(): LunaFabricWave | null {
    if (this.state.active !== null) return this.state.active;
    const completed = new Set(this.state.completed);
    const depths = remainingDepth(this.contract.units, completed);
    const ready = this.state.pending.map((id) => this.byID.get(id)!).filter((unit) =>
      unit.depends_on.every((dependency) => completed.has(dependency)));
    ready.sort((left, right) => (depths.get(right.unit_id)! - depths.get(left.unit_id)!) ||
      left.unit_id.localeCompare(right.unit_id));
    const selected: LunaFabricUnit[] = [];
    const affinity = { ...this.state.lane_affinity };
    const lanes: Record<string, number> = {};
    const usedLanes = new Set<number>();
    for (const unit of ready) {
      if (selected.some((other) => overlap(unit, other) || resourceConflict(unit, other) || shared(unit, other))) continue;
      const existing = [...new Set(unit.shared_path_keys.map((key) => affinity[key])
        .filter((lane): lane is number => lane !== undefined))];
      if (existing.length > 1 || (existing.length === 1 && usedLanes.has(existing[0]!))) continue;
      const lane = existing[0] ?? [0, 1, 2, 3, 4].find((candidate) => !usedLanes.has(candidate));
      if (lane === undefined) break;
      selected.push(unit);
      lanes[unit.unit_id] = lane;
      usedLanes.add(lane);
      for (const key of unit.shared_path_keys) affinity[key] = lane;
      if (selected.length === LUNA_FABRIC_MAX_ACTIVE) break;
    }
    if (selected.length === 0) return null;
    const wave: LunaFabricWave = Object.freeze({ number: this.state.wave + 1, base_sha: this.state.base_sha,
      unit_ids: Object.freeze(selected.map(({ unit_id }) => unit_id)), lanes: Object.freeze(lanes) });
    this.state = { ...this.state, wave: wave.number, active: wave, lane_affinity: affinity };
    return wave;
  }

  advance(advancement: LunaFabricAdvance): LunaFabricSchedulerState {
    if (this.state.active === null || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(advancement.candidate_base) ||
      advancement.candidate_base === this.state.base_sha ||
      advancement.completed_unit_ids.length !== this.state.active.unit_ids.length ||
      new Set(advancement.completed_unit_ids).size !== advancement.completed_unit_ids.length ||
      advancement.completed_unit_ids.some((id) => !this.state.active!.unit_ids.includes(id))) {
      throw new Error("invalid fabric wave advancement");
    }
    const completed = [...this.state.completed, ...advancement.completed_unit_ids];
    const done = new Set(advancement.completed_unit_ids);
    this.state = { ...this.state, base_sha: advancement.candidate_base, completed,
      pending: this.state.pending.filter((id) => !done.has(id)), active: null };
    return this.snapshot();
  }

  private validateState(): void {
    const ids = new Set(this.contract.units.map(({ unit_id }) => unit_id));
    const allStateIDs = [...this.state.pending, ...this.state.completed];
    const knownKeys = new Set(this.contract.shared_paths.map(({ key }) => key));
    if (!Number.isInteger(this.state.wave) || this.state.wave < 0 ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(this.state.base_sha) ||
      allStateIDs.length !== ids.size || new Set(allStateIDs).size !== ids.size ||
      Object.entries(this.state.lane_affinity).some(([key, lane]) => !knownKeys.has(key) ||
        !Number.isInteger(lane) || lane < 0 || lane >= LUNA_FABRIC_MAX_ACTIVE) ||
      this.contract.units.some((unit) => new Set(unit.shared_path_keys.map((key) => this.state.lane_affinity[key])
        .filter((lane) => lane !== undefined)).size > 1)) throw new Error("invalid fabric state");
    if (this.state.active !== null && (this.state.active.base_sha !== this.state.base_sha ||
      this.state.active.number !== this.state.wave || this.state.active.unit_ids.length === 0 ||
      this.state.active.unit_ids.length > LUNA_FABRIC_MAX_ACTIVE ||
      new Set(this.state.active.unit_ids).size !== this.state.active.unit_ids.length ||
      this.state.active.unit_ids.some((id) => !this.state.pending.includes(id)) ||
      this.state.active.unit_ids.some((id) => this.byID.get(id)!.depends_on.some((dependency) =>
        !this.state.completed.includes(dependency))) ||
      Object.keys(this.state.active.lanes).length !== this.state.active.unit_ids.length ||
      this.state.active.unit_ids.some((id) => !Number.isInteger(this.state.active!.lanes[id]) ||
        this.state.active!.lanes[id]! < 0 || this.state.active!.lanes[id]! >= LUNA_FABRIC_MAX_ACTIVE) ||
      new Set(Object.values(this.state.active.lanes)).size !== this.state.active.unit_ids.length ||
      this.state.active.unit_ids.some((id) => this.byID.get(id)!.shared_path_keys.some((key) =>
        this.state.lane_affinity[key] !== this.state.active!.lanes[id])))) {
      throw new Error("invalid fabric state");
    }
    if ([...this.state.pending, ...this.state.completed].some((id) => !ids.has(id)) ||
      this.state.completed.some((id) => this.state.pending.includes(id))) throw new Error("invalid fabric state");
  }
}

export function createLunaFabricScheduler(contract: LunaFabricContract, base_sha: string, state?: LunaFabricSchedulerState): LunaFabricScheduler {
  return new LunaFabricScheduler(contract, base_sha, state);
}
