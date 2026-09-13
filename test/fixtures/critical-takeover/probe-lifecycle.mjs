import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const SOURCE_ROOT = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SOURCE_ROOT, "../../..");
const RUNTIME_ROOT = join(REPOSITORY_ROOT, "_testenv", "critical-takeover-rpt");
const PROJECT_ROOT = join(RUNTIME_ROOT, "project");
const STATE_PATH = join(PROJECT_ROOT, ".git", "sortie-dogs", "parallel-dispatch-v5", "state.json");
const INSTALLED_ROOT = join(PROJECT_ROOT, ".opencode", "node_modules", "sortie-dogs");
const LIFECYCLE_PATH = join(INSTALLED_ROOT, "dist", "core", "worktree-lifecycle.js");
const SCOPE_PATH = join(INSTALLED_ROOT, "dist", "core", "worktree-scope.js");
const TARGET_REF = "refs/heads/critical-rpt-target";
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;

function invariant(condition, gate, message) {
  if (!condition) throw Object.assign(new Error(message), { gate });
}

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function git(args) {
  const result = await execFileAsync("git", args, {
    cwd: PROJECT_ROOT,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" },
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}

function oneLine(value) {
  return typeof value === "string" ? value.split(/\r?\n/u, 1)[0].slice(0, 256) : null;
}

function boundedError(operation, error) {
  return {
    operation,
    name: typeof error?.name === "string" ? error.name.slice(0, 128) : null,
    code: typeof error?.code === "string" ? error.code.slice(0, 128) : null,
    message: oneLine(error?.message),
    errno: typeof error?.errno === "number" || typeof error?.errno === "string" ? error.errno : null,
    syscall: typeof error?.syscall === "string" ? error.syscall.slice(0, 128) : null,
    childExit: typeof error?.exitCode === "number" ? error.exitCode : typeof error?.status === "number" ? error.status : null,
  };
}

function classify(error, scopeDifferences) {
  if (error?.code === "invalid-request" && scopeDifferences.length > 0) {
    return {
      kind: "harness",
      cause: "archived task scope order is non-canonical",
      nextFixPath: "test/fixtures/critical-takeover/run-critical-takeover-rpt.mjs",
    };
  }
  if (error?.code === "invalid-request") {
    return { kind: "harness", cause: "archived create request violates installed API validation", nextFixPath: "test/fixtures/critical-takeover/run-critical-takeover-rpt.mjs" };
  }
  if (error?.code === "git-failed" || error?.code === "setup-failed") {
    return { kind: "env", cause: "installed lifecycle failed during managed Git worktree operation", nextFixPath: "src/core/worktree-lifecycle.ts" };
  }
  return { kind: "source", cause: "installed lifecycle returned an unclassified typed failure", nextFixPath: "src/core/worktree-parallel-dispatch.ts" };
}

async function main() {
  const stateBeforeText = await readFile(STATE_PATH, "utf8");
  const archiveFingerprintBefore = createHash("sha256").update(stateBeforeText).digest("hex");
  const state = JSON.parse(stateBeforeText);
  const failures = state.archived?.filter((entry) => entry?.kind === "preparation" && entry?.terminal_reason === "failed" && entry?.preparation?.create_attempted === true) ?? [];
  invariant(failures.length === 1, "archive-selection", "Expected one archived failed preparation.");
  const preparation = failures[0].preparation;
  const targetBefore = await git(["rev-parse", "--verify", `${TARGET_REF}^{commit}`]);
  invariant(SHA.test(targetBefore) && targetBefore === preparation.fabric?.authority_sha, "target-before", "Fixture target differs from archived authority.");

  const [{ WorktreeLifecycle }, { normalizeWorktreeScope }] = await Promise.all([
    import(pathToFileURL(LIFECYCLE_PATH).href),
    import(pathToFileURL(SCOPE_PATH).href),
  ]);
  invariant(await realpath(INSTALLED_ROOT) === INSTALLED_ROOT && (await stat(LIFECYCLE_PATH)).isFile(), "installed-identity", "Installed lifecycle path is not the staged fixture package.");

  const tasks = preparation.tasks.map((task) => ({
    task_id: task.task_id,
    worktree: task.worktree_id,
    branch: task.branch,
    base_sha: task.base_sha,
    depends_on: [...task.depends_on],
    scope: { read: [...task.scope_read], write: [...task.scope_write] },
  }));
  const scopeDifferences = tasks.flatMap((task) => {
    const normalized = normalizeWorktreeScope(task.scope);
    return JSON.stringify(normalized) === JSON.stringify(task.scope) ? [] : [{
      taskId: task.task_id,
      declared: task.scope,
      normalized,
    }];
  });

  const lifecycle = await WorktreeLifecycle.open({ repositoryRoot: PROJECT_ROOT });
  const operationFailures = [];
  const originalCreateAndLock = lifecycle.createAndLock.bind(lifecycle);
  lifecycle.createAndLock = async (record) => {
    try {
      return await originalCreateAndLock(record);
    } catch (error) {
      operationFailures.push(boundedError("createAndLock", error));
      throw error;
    }
  };

  let created = [];
  let createError = null;
  try {
    created = await lifecycle.createManyAtBase({
      authority: { repositoryRoot: PROJECT_ROOT, sha: preparation.fabric.authority_sha },
      baseSha: preparation.tasks[0].base_sha,
      tasks,
    });
  } catch (error) {
    createError = error;
  }

  let cleanupCount = 0;
  for (const task of tasks) {
    if (await lifecycle.hasManagedWorktree(task.worktree).catch(() => false)) {
      await lifecycle.cleanup(task.worktree);
      cleanupCount += 1;
    }
  }

  const remaining = await lifecycle.reconcile();
  const targetAfter = await git(["rev-parse", "--verify", `${TARGET_REF}^{commit}`]);
  const archiveFingerprintAfter = createHash("sha256").update(await readFile(STATE_PATH, "utf8")).digest("hex");
  const error = createError === null ? null : boundedError("createManyAtBase", createError);
  const classification = createError === null
    ? { kind: "harness", cause: "archived request unexpectedly succeeded", nextFixPath: "test/fixtures/critical-takeover/run-critical-takeover-rpt.mjs" }
    : classify(createError, scopeDifferences);
  const residual = remaining.filter((entry) => tasks.some((task) => entry.identity === createHash("sha256").update(task.worktree.toLowerCase()).digest("hex").slice(0, 16)));
  const passed = createError !== null && targetAfter === targetBefore && archiveFingerprintAfter === archiveFingerprintBefore && residual.length === 0;
  const evidence = {
    schemaVersion: "critical-lifecycle-probe-v1",
    status: passed ? "pass" : "fail",
    invocationCount: { open: 1, createManyAtBase: 1 },
    installed: { root: INSTALLED_ROOT.split(sep).join("/"), lifecycle: LIFECYCLE_PATH.split(sep).join("/") },
    archive: { runId: preparation.run_id, preserved: archiveFingerprintAfter === archiveFingerprintBefore },
    request: {
      authoritySha: preparation.fabric.authority_sha,
      baseSha: preparation.tasks[0].base_sha,
      taskCount: tasks.length,
      descriptors: preparation.tasks.map((task) => ({
        taskId: task.task_id,
        worktreeId: task.worktree_id,
        lifecycleIdentity: task.lifecycle_identity,
        descriptorManagedPath: null,
        generatedPathPrefix: lifecycle.pathPrefixFor(task.worktree_id).split(sep).join("/"),
      })),
      pathDifference: "preparation descriptors have no managed_path; WorktreeLifecycle derives a nonce-suffixed path from worktree_id under its managed root",
      scopeDifferences,
    },
    result: { createdCount: created.length, cleanupCount, residualCount: residual.length, error, operationFailures, classification },
    target: { before: targetBefore, after: targetAfter, unchanged: targetAfter === targetBefore },
  };
  evidence.fingerprint = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
  if (!passed) process.exitCode = 1;
}

await main().catch((error) => {
  const result = { schemaVersion: "critical-lifecycle-probe-v1", status: "fail", gate: error?.gate ?? "unexpected", error: boundedError("probe", error) };
  result.fingerprint = createHash("sha256").update(JSON.stringify(result)).digest("hex");
  process.stderr.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 1;
});
