import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { OperatorState } from "./operator-runtime.js";
import { normalizeManifestScope } from "./path.js";
import { WorktreeLifecycle, type ManagedWorktree, type WorktreeBasePin } from "./worktree-lifecycle.js";
import type { ContainedValidationResult, WorktreeParallelTask } from "./types.js";

const execute = promisify(execFile);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
type Unit = OperatorState["units"][number];
export interface MissionFabricState {
  readonly pin: WorktreeBasePin;
  readonly tasks: readonly WorktreeParallelTask[];
  readonly trees: readonly ManagedWorktree[];
  phase: "prepared" | "validating" | "verified" | "applied";
  candidate?: ManagedWorktree;
  targetTree?: string;
  patchPath?: string;
  patchHash?: string;
  unitTrees?: readonly string[];
  checks: Array<{ command: string; tree: string; result: ContainedValidationResult; authority?: "native-shell-v1" }>;
  pendingValidation?: MissionFabricValidation;
  nativeCall?: { actor: string; callID: string; startedAt: number };
  cleanup?: { completed: string[]; retained: Array<{ worktree: string; reason: string }> };
}
export interface MissionFabricValidation {
  readonly runID: string;
  readonly directory: string;
  readonly tree: string;
  readonly command: string;
}

export class MissionFabricValidationRequired extends Error {
  constructor(readonly request: MissionFabricValidation) {
    super("mission-fabric-native-validation-required");
  }
}

function environment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/iu.test(key))),
    GIT_TERMINAL_PROMPT: "0", ...extra };
}
async function git(root: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return (await execute("git", args, { cwd: root, env: environment(env), timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
}
function scope(path: string): string {
  const value = normalizeManifestScope(path).path;
  if (isAbsolute(value) || value === "." || value === "" || value === "**" || /[*?\[\]]/u.test(value)) throw Error("unknown-scope");
  return value.replaceAll("\\", "/").toLowerCase();
}
const overlap = (left: string, right: string) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
const activeWorktrees = (state: OperatorState) => [...state.units.map(unit => `${state.runID}-${unit.unit.id}`), `${state.runID}-candidate`];

/** Read/write dependencies, not just simultaneous write collisions, decide independence. */
export function missionFabricScopeConflict(units: readonly Pick<Unit["unit"], "read" | "write">[]): boolean {
  try {
    const scopes = units.map(unit => ({ read: unit.read.map(scope), write: unit.write.map(scope) }));
    return scopes.some((unit, i) => scopes.some((other, j) => i !== j &&
      unit.write.some(path => [...other.read, ...other.write].some(input => overlap(path, input)))));
  } catch { return true; }
}

/** Pre-dispatch placement only. The existing Mission remains the sole unit/accounting owner. */
export async function prepareMissionFabric(project: string, directory: string, state: OperatorState,
  model: string | undefined): Promise<void> {
  if (state.fabric || state.fabricFallback) return;
  const fallback = (reason: string) => { state.fabricFallback = reason; };
  if (state.units.length !== 2 || state.dispatched || state.units.some(unit => unit.status !== "pending" ||
      unit.directExecution || unit.reviewerCorrection || unit.repairValidation) || state.gitLifecycle) return fallback("serial-plan");
  if (model && model !== "openai/gpt-6-luna-fast#max") return fallback("explicit-model-selection");
  if (state.units.some(unit => !unit.unit.read.length || !unit.unit.write.length || unit.unit.validation_cwd) ||
      missionFabricScopeConflict(state.units.map(unit => unit.unit))) return fallback("dependent-or-unknown-scope");
  let lifecycle: WorktreeLifecycle | undefined;
  let tasks: WorktreeParallelTask[] = [];
  let created = false;
  try {
    lifecycle = await WorktreeLifecycle.open({ repositoryRoot: project });
    const pin = await lifecycle.pinCleanBase();
    tasks = state.units.map(unit => ({ task_id: unit.unit.id, worktree: `${state.runID}-${unit.unit.id}`,
      branch: `sortie-fabric/${state.runID}/${unit.unit.id}`, base_sha: pin.sha, depends_on: [],
      scope: { read: [...unit.unit.read], write: [...unit.unit.write] } }));
    const retained = (await lifecycle.reconcile()).filter(tree => tasks.some(task => task.branch === tree.branch));
    if (retained.length && (retained.length !== tasks.length || retained.some(tree => tree.phase !== "ready" || tree.baseSha !== pin.sha ||
        !tree.path.startsWith(lifecycle!.pathPrefixFor(tasks.find(task => task.branch === tree.branch)!.worktree))))) throw Error("preparation-incomplete");
    const trees = retained.length ? tasks.map(task => retained.find(tree => tree.branch === task.branch)!) : await lifecycle.createMany({ pin, tasks });
    created = true;
    const units: Unit[] = [];
    for (const [i, unit] of state.units.entries()) {
      const root = trees[i]!.path, controls = join(root, directory, "contracts");
      await mkdir(controls, { recursive: true });
      const handoff = JSON.parse(await readFile(unit.handoffPath, "utf8"));
      handoff.ext["sortie-dogs/write-gate"].project_root = root;
      // Neither independent sibling inherits the other's not-yet-accepted handoff.
      handoff.ext["sortie-dogs/acceptance-continuity"].parent_fingerprint =
        JSON.parse(await readFile(state.units[0]!.handoffPath, "utf8")).ext["sortie-dogs/acceptance-continuity"].parent_fingerprint;
      const manifest = await readFile(unit.manifestPath, "utf8");
      const handoffPath = join(controls, basename(unit.handoffPath)), manifestPath = join(controls, basename(unit.manifestPath));
      const text = JSON.stringify(handoff);
      await writeFile(handoffPath, text); await writeFile(manifestPath, manifest);
      units.push({ ...unit, handoffPath, manifestPath, fabricRoot: root, hashes: [digest(text), digest(manifest), unit.hashes[2]!],
        task: { ...unit.task, model: model ?? "openai/gpt-6-luna-fast#max", prompt: unit.task.prompt
          .replace(/^project_root: .*$/mu, `project_root: ${root}`).replace(/^handoff_path: .*$/mu, `handoff_path: ${handoffPath}`) +
          `\nUse absolute file paths under project_root and shell workdir=${root}. Preserve the original checkout. Do not commit; the Mission host integrates the settled independent candidates.` } });
    }
    state.units = units;
    state.fabric = { pin, tasks, trees, phase: "prepared", checks: [] };
  } catch (error) {
    const retained: string[] = [];
    if (created) {
      // Only generated, undispatched trees can be removed here.
      for (const task of tasks) await lifecycle!.cleanup(task.worktree).catch(() => { retained.push(task.worktree); });
    }
    fallback(`preparation:${error instanceof Error ? error.message : "unavailable"}${retained.length ? `; retained=${retained.join(",")}` : ""}`);
  }
}

/** A private index captures tracked and new files without changing the user's index. */
export async function missionFabricTree(root: string): Promise<string> {
  const common = resolve(root, (await git(root, ["rev-parse", "--git-common-dir"])).trim());
  const index = join(common, `sortie-fabric-${randomUUID()}.index`), env = { GIT_INDEX_FILE: index };
  try {
    await git(root, ["read-tree", "HEAD"], env);
    await git(root, ["add", "-A", "--", "."], env);
    return (await git(root, ["write-tree"], env)).trim();
  } finally { await rm(index, { force: true }); }
}

export async function assertMissionFabricDelivered(project: string, state: OperatorState): Promise<void> {
  if (!state.fabric) return;
  if (state.fabric.phase !== "applied" || !state.fabric.targetTree ||
      (await git(project, ["rev-parse", "HEAD"])).trim() !== state.fabric.pin.sha ||
      await missionFabricTree(project) !== state.fabric.targetTree) throw Error("mission-fabric-delivery-changed");
}

/** Acceptance already proved native quiescence. Retain receipts/patch; remove only exact owned generated trees. */
export async function cleanupMissionFabric(project: string, state: OperatorState, save: () => Promise<void>): Promise<void> {
  const fabric = state.fabric;
  if (!fabric || state.phase !== "completed" || fabric.phase !== "applied" || !fabric.targetTree || !fabric.unitTrees) return;
  const lifecycle = await WorktreeLifecycle.open({ repositoryRoot: project, activeWorktrees: activeWorktrees(state) });
  const entries = fabric.trees.map((tree, i) => ({ tree, worktree: fabric.tasks[i]!.worktree,
    expected: fabric.unitTrees![i]!, write: state.units[i]!.unit.write }));
  if (fabric.candidate) entries.push({ tree: fabric.candidate, worktree: `${state.runID}-candidate`,
    expected: fabric.targetTree, write: state.units.flatMap(unit => [...unit.unit.write]) });
  const cleanup = fabric.cleanup ??= { completed: [], retained: [] };
  for (const entry of entries) {
    if (cleanup.completed.includes(entry.worktree)) continue;
    try {
      if (await lifecycle.hasManagedWorktree(entry.worktree)) {
        if (await missionFabricTree(entry.tree.path) !== entry.expected) throw Error("candidate-changed-after-acceptance");
        await lifecycle.discardOwnedChanges(entry.worktree, entry.tree.path, fabric.pin.sha, entry.tree.branch,
          entry.write.map(path => normalizeManifestScope(path).path));
        await lifecycle.cleanup(entry.worktree);
      }
      cleanup.completed.push(entry.worktree);
      cleanup.retained = cleanup.retained.filter(item => item.worktree !== entry.worktree);
    } catch (error) {
      cleanup.retained = [...cleanup.retained.filter(item => item.worktree !== entry.worktree),
        { worktree: entry.worktree, reason: error instanceof Error ? error.message : "cleanup-unavailable" }];
    }
    await save();
  }
}

/** Called only after existing native terminal, reservation settlement and Writer release checks. */
export async function integrateMissionFabric(project: string, directory: string, state: OperatorState,
  save: () => Promise<void>, validate: (request: MissionFabricValidation) => Promise<ContainedValidationResult>, signal?: AbortSignal): Promise<void> {
  const fabric = state.fabric;
  if (!fabric) return;
  signal?.throwIfAborted();
  if (fabric.phase === "applied") return assertMissionFabricDelivered(project, state);
  if (state.phase !== "awaiting-acceptance" || state.units.some(unit => unit.status !== "succeeded" || !unit.childSessionID || !unit.evidence.length)) {
    throw Error("mission-fabric-awaits-settlement");
  }
  if ((await git(project, ["rev-parse", "HEAD"])).trim() !== fabric.pin.sha) throw Error("mission-fabric-stale-base");
  const trees = await Promise.all(fabric.trees.map(tree => missionFabricTree(tree.path)));
  if (fabric.unitTrees && JSON.stringify(trees) !== JSON.stringify(fabric.unitTrees)) throw Error("mission-fabric-candidate-changed");
  const patches: string[] = [];
  for (const [i, tree] of trees.entries()) {
    const paths = (await git(project, ["diff", "--name-only", "-z", fabric.pin.sha, tree])).split("\0").filter(Boolean);
    if (paths.some(path => !state.units[i]!.unit.write.some(grant => {
      const normalized = normalizeManifestScope(grant);
      return path === normalized.path || normalized.directory && path.startsWith(`${normalized.path}/`);
    }))) throw Error("mission-fabric-change-outside-unit");
    patches.push(await git(project, ["diff", "--binary", "--src-prefix=a/", "--dst-prefix=b/", fabric.pin.sha, tree]));
  }
  const patch = patches.join("\n"), patchPath = join(project, directory, "contracts", `${state.runID}.fabric.patch`);
  if (fabric.patchHash && fabric.patchHash !== digest(patch)) throw Error("mission-fabric-patch-changed");
  await writeFile(patchPath, patch);
  fabric.unitTrees = trees; fabric.patchHash = digest(patch); fabric.patchPath = patchPath;
  if (!fabric.targetTree) {
    const common = resolve(project, (await git(project, ["rev-parse", "--git-common-dir"])).trim());
    const index = join(common, `sortie-fabric-${randomUUID()}.index`), env = { GIT_INDEX_FILE: index };
    try {
      await git(project, ["read-tree", fabric.pin.sha], env);
      if (patch.trim()) await git(project, ["apply", "--cached", patchPath], env);
      fabric.targetTree = (await git(project, ["write-tree"], env)).trim();
    } finally { await rm(index, { force: true }); }
    await save();
  }
  if (!fabric.candidate) {
    const lifecycle = await WorktreeLifecycle.open({ repositoryRoot: project, activeWorktrees: activeWorktrees(state) });
    const branch = `sortie-fabric/${state.runID}/candidate`;
    const retained = (await lifecycle.reconcile()).find(tree => tree.branch === branch);
    if (retained && (retained.phase !== "ready" || retained.baseSha !== fabric.pin.sha ||
        !retained.path.startsWith(lifecycle.pathPrefixFor(`${state.runID}-candidate`)))) throw Error("mission-fabric-candidate-ownership");
    const [candidate] = retained ? [retained] : await lifecycle.createManyAtBase({ authority: fabric.pin, baseSha: fabric.pin.sha, tasks: [{
      task_id: "candidate", worktree: `${state.runID}-candidate`, branch: `sortie-fabric/${state.runID}/candidate`,
      base_sha: fabric.pin.sha, depends_on: [], scope: { read: [], write: state.units.flatMap(unit => [...unit.unit.write]) },
    }] });
    fabric.candidate = candidate!; await save();
  }
  const baseTree = (await git(project, ["rev-parse", `${fabric.pin.sha}^{tree}`])).trim();
  const candidateTree = await missionFabricTree(fabric.candidate.path);
  if (candidateTree !== fabric.targetTree) {
    if (candidateTree !== baseTree) throw Error("mission-fabric-integration-conflict");
    if (patch.trim()) await git(fabric.candidate.path, ["apply", patchPath]);
  }
  fabric.phase = "validating"; await save();
  for (const command of [...new Set(state.units.flatMap(unit => [...unit.unit.validation]))]) {
    signal?.throwIfAborted();
    if (fabric.checks.some(check => check.command === command && check.tree === fabric.targetTree && check.result.ok &&
        check.authority === "native-shell-v1")) continue;
    fabric.pendingValidation = { runID: state.runID, directory: fabric.candidate.path, tree: fabric.targetTree, command };
    await save();
    const result = await validate(fabric.pendingValidation);
    delete fabric.pendingValidation;
    fabric.checks.push({ command, tree: fabric.targetTree, result, authority: "native-shell-v1" }); await save();
    if (!result.ok) throw Error("mission-fabric-combined-validation-failed");
  }
  if (await missionFabricTree(fabric.candidate.path) !== fabric.targetTree) throw Error("mission-fabric-validation-mutated-candidate");
  fabric.phase = "verified"; await save();
  // git apply is atomic on conflicts. On restart, recognize an already applied exact tree.
  if ((await git(project, ["rev-parse", "HEAD"])).trim() !== fabric.pin.sha) throw Error("mission-fabric-stale-base");
  const current = await missionFabricTree(project);
  signal?.throwIfAborted();
  if (current !== fabric.targetTree) {
    if (current !== baseTree) throw Error("mission-fabric-target-dirty");
    if (patch.trim()) await git(project, ["apply", patchPath]);
  }
  fabric.phase = "applied"; await save();
  await assertMissionFabricDelivered(project, state);
}
