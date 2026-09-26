/** Display-only native Task progress. Never prompts a model or changes execution ownership. */
import { OperatorMissionRuntime } from "../core/operator-mission.js";
import { OperatorRuntime } from "../core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../core/runtime-profile.js";

type Sink = (value: Record<string, unknown>) => Promise<void>;
const sinks = new Map<string, Sink>();
export function bindMissionProgress(root: string, sink: Sink): () => void {
  sinks.set(root, sink);
  return () => { if (sinks.get(root) === sink) sinks.delete(root); };
}
export async function publishMissionProgress(root: string, value: Record<string, unknown>): Promise<void> {
  await sinks.get(root)?.(value).catch(() => undefined);
}

/** Read durable transitions even when settlement ran in a different/reloaded plugin instance. */
export function missionProgressReader(directory: string, root: string, callID: string) {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  return async (): Promise<Record<string, unknown> | undefined> => {
    const mission = await missions.read(root);
    if (!mission || mission.callID !== callID) return undefined;
    // OperatorRuntime caches its own writes; a display observer must read a fresh disk snapshot.
    const run = await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).read(root);
    const units = run?.runID === mission.runID ? run.units : [];
    const running = units.find(unit => unit.status === "running");
    const last = mission.progress.at(-1);
    const status = running ? "running" : last?.status ?? mission.phase;
    const title = running?.unit.title ?? last?.title ?? mission.requirements[0]?.text ?? "Coordinator";
    return { description: `🐾 ${status}: ${title}`, sortie_progress: {
      mission_id: mission.id, phase: mission.phase, unit: running ? `${run!.runID}/${running.unit.id}` : last?.unit ?? null,
      title, status, child_session_id: running?.childSessionID ?? null,
      completed_units: units.filter(unit => unit.status === "succeeded").length,
      failed_units: units.filter(unit => unit.status === "failed").length,
      historical_failed_attempts: mission.progress.filter(unit => unit.status === "failed").length,
      accepted: mission.phase === "completed",
    } };
  };
}
