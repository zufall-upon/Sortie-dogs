import { normalizeWorktreeScopePath, worktreeScopesOverlap } from "./worktree-scope.js";
import type {
  WorktreeParallelContract,
  WorktreeParallelContractIssue,
  WorktreeParallelContractValidationResult,
  WorktreeParallelTask,
} from "./types.js";

const MESSAGES = {
  duplicate: "Task, worktree, branch, and artifact identities must be unique.",
  unknownDependency: "Dependency must name another task in this contract.",
  cycle: "Dependency graph must be acyclic.",
  mode: "Mode, worker bound, and task count are inconsistent.",
  path: "Scope and changed paths must be normalized repository-relative paths.",
  overlap: "Parallel tasks must not have write/write or read/write scope overlap.",
  artifact: "Commit artifact must match its task, base, and declared write scope.",
  failure: "Failure task and fallback must satisfy the fixed failure policy.",
} as const;

function issue(
  code: WorktreeParallelContractIssue["code"],
  pointer: string,
  message: string,
): WorktreeParallelContractIssue {
  return { code, pointer, message };
}

function normalizeScope(path: string): string | undefined {
  try {
    return normalizeWorktreeScopePath(path);
  } catch {
    return undefined;
  }
}

function pathWithinWrites(path: string, writes: readonly string[]): boolean {
  return writes.some((write) => path === write || path.startsWith(`${write}/`));
}

function taskScopes(task: WorktreeParallelTask): { read: string[]; write: string[] } | undefined {
  const read = task.scope.read.map(normalizeScope);
  const write = task.scope.write.map(normalizeScope);
  return [...read, ...write].some((path) => path === undefined)
    ? undefined
    : { read: read as string[], write: write as string[] };
}

export function validateWorktreeParallelContract(
  contract: WorktreeParallelContract,
): WorktreeParallelContractValidationResult {
  const diagnostics: WorktreeParallelContractIssue[] = [];
  const tasks = new Map<string, { task: WorktreeParallelTask; index: number; scopes?: { read: string[]; write: string[] } }>();
  const identities = [new Set<string>(), new Set<string>(), new Set<string>()];

  contract.tasks.forEach((task, index) => {
    for (const [value, pointer, seen] of [
      [task.task_id, `/tasks/${index}/task_id`, identities[0]],
      [task.worktree.toLowerCase(), `/tasks/${index}/worktree`, identities[1]],
      [task.branch.toLowerCase(), `/tasks/${index}/branch`, identities[2]],
    ] as const) {
      if (seen.has(value)) diagnostics.push(issue("WTP001_DUPLICATE_IDENTITY", pointer, MESSAGES.duplicate));
      seen.add(value);
    }
    const scopes = taskScopes(task);
    if (scopes === undefined) diagnostics.push(issue("WTP005_PATH_INVALID", `/tasks/${index}/scope`, MESSAGES.path));
    tasks.set(task.task_id, { task, index, ...(scopes === undefined ? {} : { scopes }) });
  });

  if (
    !Number.isInteger(contract.max_workers) || contract.max_workers < 1 || contract.max_workers > 3 ||
    (contract.mode === "single-worker" && contract.max_workers !== 1) ||
    (contract.mode === "parallel" && (contract.max_workers < 2 || contract.tasks.length < 2))
  ) diagnostics.push(issue("WTP004_MODE_WORKER_MISMATCH", "/max_workers", MESSAGES.mode));

  for (const { task, index } of tasks.values()) {
    task.depends_on.forEach((dependency, dependencyIndex) => {
      if (dependency === task.task_id || !tasks.has(dependency)) {
        diagnostics.push(issue(
          "WTP002_DEPENDENCY_UNKNOWN",
          `/tasks/${index}/depends_on/${dependencyIndex}`,
          MESSAGES.unknownDependency,
        ));
      }
    });
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskID: string): boolean => {
    if (visiting.has(taskID)) return true;
    if (visited.has(taskID)) return false;
    visiting.add(taskID);
    const cyclic = tasks.get(taskID)?.task.depends_on.some((dependency) => tasks.has(dependency) && visit(dependency)) ?? false;
    visiting.delete(taskID);
    visited.add(taskID);
    return cyclic;
  };
  for (const [taskID, entry] of tasks) {
    if (visit(taskID)) diagnostics.push(issue("WTP003_DEPENDENCY_CYCLE", `/tasks/${entry.index}/depends_on`, MESSAGES.cycle));
  }

  if (contract.mode === "parallel") {
    const entries = [...tasks.values()];
    for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
      const left = entries[leftIndex]!;
      if (left.scopes === undefined) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
        const right = entries[rightIndex]!;
        if (right.scopes === undefined) continue;
        const overlaps = left.scopes.write.some((path) =>
          [...right.scopes!.write, ...right.scopes!.read].some((other) => worktreeScopesOverlap(path, other))) ||
          right.scopes.write.some((path) => left.scopes!.read.some((other) => worktreeScopesOverlap(path, other)));
        if (overlaps) diagnostics.push(issue("WTP006_SCOPE_OVERLAP", `/tasks/${right.index}/scope`, MESSAGES.overlap));
      }
    }
  }

  const artifactTasks = new Set<string>();
  contract.artifacts.forEach((artifact, index) => {
    const entry = tasks.get(artifact.task_id);
    const changedPaths = artifact.changed_paths.map(normalizeScope);
    const invalidPath = changedPaths.some((path) => path === undefined);
    if (invalidPath) diagnostics.push(issue("WTP005_PATH_INVALID", `/artifacts/${index}/changed_paths`, MESSAGES.path));
    if (
      artifactTasks.has(artifact.task_id) || entry === undefined || artifact.base_sha !== entry.task.base_sha ||
      (!invalidPath && changedPaths.some((path) => !pathWithinWrites(path!, entry.scopes?.write ?? [])))
    ) diagnostics.push(issue("WTP007_ARTIFACT_MISMATCH", `/artifacts/${index}`, MESSAGES.artifact));
    artifactTasks.add(artifact.task_id);
  });

  if (contract.failure !== null) {
    const fallback = contract.failure.code === "scope-overlap" ? "single-worker" : "stop";
    if (!tasks.has(contract.failure.task_id) || contract.failure.fallback !== fallback) {
      diagnostics.push(issue("WTP008_FAILURE_POLICY", "/failure", MESSAGES.failure));
    }
  }

  diagnostics.sort((left, right) => left.pointer.localeCompare(right.pointer) || left.code.localeCompare(right.code));
  return { ok: diagnostics.length === 0, diagnostics };
}
