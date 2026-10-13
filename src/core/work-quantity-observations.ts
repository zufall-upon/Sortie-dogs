/** Bounded display observations from already delivered native events. No I/O or authority. */
import type { OperatorMission } from "./operator-mission.js";
import type { OperatorState } from "./operator-runtime.js";
import { observeWorkQuantity, planWorkQuantity, projectWorkQuantity, syncWorkQuantity,
  type WorkQuantityEvent, type WorkQuantityState, type WorkQuantityProgress } from "./work-quantity.js";

interface View { mission?: OperatorMission; run?: OperatorState; sequence: number;
  events: Map<string, { sequence: number; event: WorkQuantityEvent }>; progress?: WorkQuantityProgress }
const views = new Map<string, View>();
const owners = new Map<string, string>();
const identity = (directory: string, root: string) => `${directory.replaceAll("\\", "/").replace(/\/$/u, "")}\0${root}`;
function view(directory: string, root: string): View {
  const id = identity(directory, root);
  let value = views.get(id);
  if (!value) { value = { sequence: 0, events: new Map() }; views.set(id, value); }
  owners.set(id, root);
  return value;
}
export function rememberWorkMission(directory: string, mission: OperatorMission): void {
  const value = view(directory, mission.root);
  if (value.mission?.id !== mission.id && value.mission?.workQuantity?.scopeID !== mission.workQuantity?.scopeID) value.events.clear();
  value.mission = mission;
  value.sequence = Math.max(value.sequence, mission.workQuantity?.observationSequence ?? 0); delete value.progress;
  if (mission.coordinator) owners.set(identity(directory, mission.coordinator), mission.root);
  if (mission.review?.child) owners.set(identity(directory, mission.review.child), mission.root);
  for (const attempt of mission.attempts ?? []) if (attempt.childSessionID) owners.set(identity(directory, attempt.childSessionID), mission.root);
}
export function rememberWorkRun(directory: string, run: OperatorState): void {
  const value = view(directory, run.rootSessionID);
  value.run = run;
  value.sequence = Math.max(value.sequence, run.workQuantity?.observationSequence ?? 0); delete value.progress;
  if (run.operatorSessionID) owners.set(identity(directory, run.operatorSessionID), run.rootSessionID);
  for (const unit of run.units) if (unit.childSessionID) owners.set(identity(directory, unit.childSessionID), run.rootSessionID);
}
export function rememberedWorkRun(directory: string, root: string): OperatorState | undefined {
  return views.get(identity(directory, root))?.run;
}
export function workRootForActor(directory: string, actor: string): string | undefined { return owners.get(identity(directory, actor)); }
/** Every event is folded at most once per saved projection; repeated edits are not completed work. */
export function observeActorWork(directory: string, actor: string, event: WorkQuantityEvent): string | undefined {
  const root = owners.get(identity(directory, actor));
  if (!root) return undefined;
  const value = view(directory, root);
  if (value.mission && ["completed", "cancelled"].includes(value.mission.phase) || !value.mission &&
      value.run && ["completed", "cancelled"].includes(value.run.phase)) return undefined;
  const run = value.run;
  const unit = run?.units.find(unit => unit.status === "running" && unit.childSessionID === actor);
  const observed = { ...event, ...(unit ? { unit: `${run!.runID}/${unit.unit.id}` } : {}) };
  const id = JSON.stringify([event.kind, event.paths, event.command, event.commands, event.checkpoints, observed.unit]);
  value.events.delete(id);
  value.events.set(id, { sequence: ++value.sequence, event: observed });
  delete value.progress;
  if (value.events.size > 512) value.events.delete(value.events.keys().next().value!);
  return root;
}
export function applyPendingWork(directory: string, root: string, state: WorkQuantityState): WorkQuantityState {
  const value = views.get(identity(directory, root));
  if (!value) return state;
  for (const entry of value.events.values()) if (entry.sequence > (state.observationSequence ?? 0)) observeWorkQuantity(state, entry.event);
  state.observationSequence = value.sequence;
  return state;
}
export function missionWorkState(directory: string, mission: OperatorMission, run?: OperatorState): WorkQuantityState {
  const state = mission.workQuantity ?? planWorkQuantity(mission, run?.runID === mission.runID ? run.units.map(unit => unit.unit) : [], run, undefined, undefined, directory);
  return syncWorkQuantity(applyPendingWork(directory, mission.root, structuredClone(state)), mission, run);
}
export function cachedWorkProgress(directory: string, actor: string) {
  const root = owners.get(identity(directory, actor));
  const value = root && views.get(identity(directory, root));
  if (!value) return undefined;
  if (value.progress) return value.progress;
  if (value.mission) return value.progress = projectWorkQuantity(missionWorkState(directory, value.mission, value.run),
    value.mission.phase === "completed", value.mission.phase === "cancelled");
  if (value.run?.workQuantity) return value.progress = projectWorkQuantity(syncWorkQuantity(applyPendingWork(directory, root!,
    structuredClone(value.run.workQuantity)), {}, value.run), value.run.phase === "completed", value.run.phase === "cancelled");
  return undefined;
}
