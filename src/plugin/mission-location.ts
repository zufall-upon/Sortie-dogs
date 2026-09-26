import { isAbsolute, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { OperatorMissionRuntime, type OperatorMission } from "../core/operator-mission.js";
import { canonicalAgent, type RuntimeProfile } from "../core/runtime-profile.js";

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Discover only this root's native Coordinators; never scan unrelated projects or move their state. */
export async function missionLocations(root: string, directory: string, profile: RuntimeProfile,
  children: () => Promise<unknown>, childID?: string): Promise<{ directory: string; mission: OperatorMission }[]> {
  const value = await children();
  if (!Array.isArray(value)) return [];
  const current = await realpath(directory), found: { directory: string; mission: OperatorMission }[] = [];
  for (const child of value) {
    if (!record(child) || typeof child.id !== "string" || child.parentID !== root ||
        (childID !== undefined && child.id !== childID) || canonicalAgent(profile, child.agent as string) !== "dog-operator") continue;
    const path = record(child.location) ? child.location.directory : child.directory;
    if (typeof path !== "string" || !isAbsolute(path)) continue;
    const target = await realpath(path).catch(() => undefined);
    if (!target || resolve(target) === resolve(current)) continue;
    const mission = await new OperatorMissionRuntime(target, profile).read(root);
    if (!mission || mission.coordinator !== child.id || ["cancelled", "completed"].includes(mission.phase)) continue;
    if (!found.some(item => item.directory === target && item.mission.id === mission.id)) found.push({ directory: target, mission });
  }
  return found;
}

export function missionLocationPacket(current: string, found: { directory: string; mission: OperatorMission }[]) {
  return { status: "mission-location-required", project_root: current,
    missions: found.map(({ directory, mission }) => ({ project_root: directory, mission_id: mission.id,
      coordinator_session_id: mission.coordinator, phase: mission.phase, submission_status: mission.submission?.status ?? null })),
    ...(found.length === 1 ? { resume_location: { directory: found[0]!.directory, sessionID: found[0]!.mission.root } } : {}),
    next_action: found.length === 1
      ? "The existing mission is in another native session location. Move this root session to resume_location.directory using the host session_move operation, then read operator_status and resume the same Coordinator. Preserve the existing requirements and cumulative spend; no new mission is needed."
      : "This root has unfinished missions in multiple native locations. Select the one matching the user's request, move this root session to its project_root, then read operator_status. Do not create a substitute mission or dispatch a Coordinator from the wrong location." };
}
