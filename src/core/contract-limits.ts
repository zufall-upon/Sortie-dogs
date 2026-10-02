/** Common text bounds shared by handoff, manifest and goal evidence validation. */
export const CONTRACT_TEXT_LIMITS = Object.freeze({ title: 160, objective: 32768, statement: 1000, command: 8192, path: 512 });
/** New Mission task generation only; persisted/legacy contracts retain their original bounds.
 * Only target is authoring guidance. maximum is internal headroom, never a new target. */
export const MISSION_OBJECTIVE_LIMITS = Object.freeze({ target: 2000, maximum: 3000 });
