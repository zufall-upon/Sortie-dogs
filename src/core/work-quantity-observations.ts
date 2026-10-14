/** Bounded display observations from already delivered native events. No I/O or authority. */
import type { OperatorMission } from "./operator-mission.js";
import type { OperatorState } from "./operator-runtime.js";
import { observeWorkQuantity, planWorkQuantity, projectWorkQuantity, syncWorkQuantity,
  type WorkQuantityEvent, type WorkQuantityState, type WorkQuantityProgress } from "./work-quantity.js";

interface View { mission?: OperatorMission; run?: OperatorState; sequence: number;
  events: Map<string, { sequence: number; event: WorkQuantityEvent }>; deleted: Set<string>; progress?: WorkQuantityProgress }
const views = new Map<string, View>();
const owners = new Map<string, string>();
const instances = new Map<string, number>();
// Terminal UI snapshots contain no Mission/run/events and cannot grow with history.
const terminals = new Map<string, { progress: WorkQuantityProgress; runID?: string }>();
const identity = (directory: string, root: string) => `${directory.replaceAll("\\", "/").replace(/\/$/u, "")}\0${root}`;
function forgetRoot(directory: string, root: string): void {
  const id = identity(directory, root), prefix = identity(directory, "");
  views.delete(id); terminals.delete(id);
  for (const [actor, owner] of owners) if (actor.startsWith(prefix) && owner === root) owners.delete(actor);
}
export function forgetWorkSession(directory: string, actor: string): void {
  const id = identity(directory, actor);
  if (views.has(id) || terminals.has(id) || owners.get(id) === actor) forgetRoot(directory, actor);
  else {
    const root = owners.get(id);
    if (root) views.get(identity(directory, root))?.deleted.add(actor);
    owners.delete(id);
  }
}
export function forgetWorkDirectory(directory: string): void {
  const prefix = identity(directory, "");
  for (const cache of [views, owners, terminals]) for (const id of cache.keys()) if (id.startsWith(prefix)) cache.delete(id);
}
/** Module-global observations remain live until the last overlapping Location setup unloads. */
export function retainWorkDirectory(directory: string): () => void {
  const id = identity(directory, "");
  instances.set(id, (instances.get(id) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (instances.get(id) ?? 1) - 1;
    if (remaining) instances.set(id, remaining);
    else { instances.delete(id); forgetWorkDirectory(directory); }
  };
}
function own(directory: string, root: string, actor: string, value: View): void {
  if (!value.deleted.has(actor)) owners.set(identity(directory, actor), root);
}
function finishView(directory: string, root: string, value: View): void {
  const mission = value.mission, run = value.run;
  const progress = mission ? projectWorkQuantity(missionWorkState(directory, mission, run),
    mission.phase === "completed", mission.phase === "cancelled")
    : run?.workQuantity ? projectWorkQuantity(syncWorkQuantity(applyPendingWork(directory, root,
      structuredClone(run.workQuantity)), {}, run), run.phase === "completed", run.phase === "cancelled") : undefined;
  forgetRoot(directory, root);
  if (progress) terminals.set(identity(directory, root), { progress, runID: mission?.runID ?? run?.runID });
  if (terminals.size > 128) terminals.delete(terminals.keys().next().value!);
}
function view(directory: string, root: string): View {
  const id = identity(directory, root);
  terminals.delete(id);
  let value = views.get(id);
  if (!value) { value = { sequence: 0, events: new Map(), deleted: new Set() }; views.set(id, value); }
  owners.set(id, root);
  return value;
}
export function rememberWorkMission(directory: string, mission: OperatorMission): void {
  const value = view(directory, mission.root);
  if (value.mission?.id !== mission.id && value.mission?.workQuantity?.scopeID !== mission.workQuantity?.scopeID) value.events.clear();
  value.mission = mission;
  value.sequence = Math.max(value.sequence, mission.workQuantity?.observationSequence ?? 0); delete value.progress;
  if (mission.coordinator) own(directory, mission.root, mission.coordinator, value);
  if (mission.review?.child) own(directory, mission.root, mission.review.child, value);
  for (const attempt of mission.attempts ?? []) if (attempt.childSessionID) own(directory, mission.root, attempt.childSessionID, value);
  if (["completed", "cancelled"].includes(mission.phase)) finishView(directory, mission.root, value);
}
export function rememberWorkRun(directory: string, run: OperatorState): void {
  const terminal = terminals.get(identity(directory, run.rootSessionID));
  if (terminal && terminal.runID === run.runID) return;
  const value = view(directory, run.rootSessionID);
  value.run = run;
  value.sequence = Math.max(value.sequence, run.workQuantity?.observationSequence ?? 0); delete value.progress;
  if (run.operatorSessionID) own(directory, run.rootSessionID, run.operatorSessionID, value);
  for (const unit of run.units) if (unit.childSessionID) own(directory, run.rootSessionID, unit.childSessionID, value);
  if (!value.mission && ["completed", "cancelled"].includes(run.phase)) finishView(directory, run.rootSessionID, value);
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
  const terminal = terminals.get(identity(directory, actor));
  if (terminal) return terminal.progress;
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
