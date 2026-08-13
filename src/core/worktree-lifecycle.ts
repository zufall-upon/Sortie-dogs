import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { ScopeLeaseError, ScopeLeaseRegistry, type ScopeLease } from "./scope-lease-registry.js";
import type { WorktreeParallelTask } from "./types.js";
import { normalizeWorktreeScope } from "./worktree-scope.js";

const INVENTORY_VERSION = 3;
const MAX_WORKTREES = 3;
const MAX_INVENTORY_RECORDS = MAX_WORKTREES;
const MAX_INVENTORY_BYTES = 1024 * 1024;
const MAX_TEXT = 256;
const MAX_PATH = 4096;
const MAX_SETUP_HOOKS = 16;
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 1024 * 1024;
const PROCESS_EXIT_GRACE_MS = 500;
const PROCESS_KILL_WAIT_MS = 2_000;
const INVENTORY_SCOPE = Object.freeze({ read: [] as string[], write: ["sortie-dogs/worktree-inventory"] });
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DEVICE_ID = /^[1-9][0-9]*$/u;
const MAX_SAFE_FILE_ID = BigInt(Number.MAX_SAFE_INTEGER);
const ACTIVE_PATH = /^wt-([0-9a-f]{16})-([0-9a-f]{32})$/u;
const QUARANTINE_PATH = /^rm-([0-9a-f]{16})-([0-9a-f]{32})$/u;
const PHASES = new Set(["creating", "setting-up", "ready", "removing", "orphaned"]);

export type WorktreeLifecyclePhase = "creating" | "setting-up" | "ready" | "removing" | "orphaned";

export interface WorktreeLifecycleOptions {
  readonly repositoryRoot: string;
  readonly worktreeRoot?: string;
  readonly gitPath?: string;
}

export interface WorktreeBasePin {
  readonly repositoryRoot: string;
  readonly sha: string;
}

export interface WorktreeSetupHook {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
}

export interface WorktreeCreateRequest {
  readonly pin: WorktreeBasePin;
  readonly tasks: readonly WorktreeParallelTask[];
  readonly setupHooks?: readonly WorktreeSetupHook[];
}

export interface ManagedWorktree {
  readonly identity: string;
  readonly path: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly phase: WorktreeLifecyclePhase;
}

export type WorktreeLifecycleErrorCode =
  | "invalid-request"
  | "invalid-repository"
  | "dirty-tree"
  | "stale-base"
  | "git-failed"
  | "setup-failed"
  | "unsafe-cleanup"
  | "inventory-locked"
  | "corrupt-inventory";

export class WorktreeLifecycleError extends Error {
  readonly code: WorktreeLifecycleErrorCode;

  constructor(code: WorktreeLifecycleErrorCode, message: string) {
    super(message);
    this.name = "WorktreeLifecycleError";
    this.code = code;
  }
}

type InventoryRecord = {
  identity: string;
  path: string;
  pathNonce: string;
  branch: string;
  baseSha: string;
  expectedSha: string;
  lockReason: string;
  ownershipNonce: string;
  branchOwned: boolean;
  targetDev: string | null;
  targetIno: string | null;
  phase: WorktreeLifecyclePhase;
};

type Inventory = { version: 3; records: InventoryRecord[] };

type RootIdentity = {
  readonly dev: string;
  readonly ino: string;
  readonly statDev: string;
  readonly statIno: string;
};

type GitWorktree = {
  path: string;
  head?: string;
  branch?: string;
  locked?: string;
  bare: boolean;
  detached: boolean;
  prunable: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function identity(value: string): string {
  return createHash("sha256").update(value.toLowerCase()).digest("hex");
}

function pathIdentity(value: string): string {
  const normalized = resolve(value).split(sep).join("/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathWithin(path: string, parent: string): boolean {
  const childID = pathIdentity(path);
  const parentID = pathIdentity(parent).replace(/\/$/u, "");
  return childID === parentID || childID.startsWith(`${parentID}/`);
}

function safeStoredFileID(value: unknown): value is string {
  return typeof value === "string" && DEVICE_ID.test(value) && BigInt(value) <= MAX_SAFE_FILE_ID;
}

function fileID(path: string, value: bigint, kind: "device" | "inode"): string | undefined {
  const native = value > 0n && value <= MAX_SAFE_FILE_ID ? value.toString() : undefined;
  if (native !== undefined) return native;
  if (process.platform !== "win32" || (kind === "inode" && value === 0n)) return undefined;
  const volume = pathIdentity(parse(resolve(path)).root);
  const derived = BigInt(`0x${createHash("sha256").update(`${kind}\0${volume}\0${value}`).digest("hex").slice(0, 13)}`) + 1n;
  return derived.toString();
}

function validText(value: unknown, max = MAX_TEXT): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}

function cleanGitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "TMP", "TEMP", "TMPDIR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  env.LC_ALL = "C";
  return env;
}

function parseWorktreeList(source: string): GitWorktree[] {
  const result: GitWorktree[] = [];
  let current: GitWorktree | undefined;
  for (const field of source.split("\0")) {
    if (field === "") {
      if (current !== undefined) result.push(current);
      current = undefined;
      continue;
    }
    const separator = field.indexOf(" ");
    const key = separator < 0 ? field : field.slice(0, separator);
    const value = separator < 0 ? "" : field.slice(separator + 1);
    if (key === "worktree") {
      if (current !== undefined) result.push(current);
      current = { path: value, bare: false, detached: false, prunable: false };
    } else if (current !== undefined && key === "HEAD") current.head = value;
    else if (current !== undefined && key === "branch") current.branch = value;
    else if (current !== undefined && key === "locked") current.locked = value;
    else if (current !== undefined && key === "bare") current.bare = true;
    else if (current !== undefined && key === "detached") current.detached = true;
    else if (current !== undefined && key === "prunable") current.prunable = true;
  }
  if (current !== undefined) result.push(current);
  return result;
}

export class WorktreeLifecycle {
  private readonly inventoryRoot: string;
  private readonly inventoryPath: string;
  private readonly leaseRegistry: ScopeLeaseRegistry;
  private readonly gitEnv = cleanGitEnvironment();
  private inventory: Inventory = { version: 3, records: [] };
  private readonly inFlight = new Set<string>();
  private writeQueue = Promise.resolve();
  private transactionQueue = Promise.resolve();
  private transactionLease: ScopeLease | undefined;

  private constructor(
    private readonly repositoryRoot: string,
    private readonly worktreeRoot: string,
    private readonly gitPath: string,
    private readonly commonGitDir: string,
    private readonly rootIdentity: RootIdentity,
  ) {
    this.inventoryRoot = join(commonGitDir, "sortie-dogs", "worktrees-v1");
    this.inventoryPath = join(this.inventoryRoot, "inventory.json");
    this.leaseRegistry = new ScopeLeaseRegistry(join(this.inventoryRoot, "authority"));
  }

  static async open(options: WorktreeLifecycleOptions): Promise<WorktreeLifecycle> {
    if (!isRecord(options) || !hasExactKeys(options, ["repositoryRoot",
      ...(options.worktreeRoot === undefined ? [] : ["worktreeRoot"]),
      ...(options.gitPath === undefined ? [] : ["gitPath"])]) ||
      !validText(options.repositoryRoot, MAX_PATH) ||
      (options.worktreeRoot !== undefined && !validText(options.worktreeRoot, MAX_PATH)) ||
      (options.gitPath !== undefined && !validText(options.gitPath, MAX_PATH))) {
      throw new WorktreeLifecycleError("invalid-request", "Lifecycle options are invalid.");
    }
    const gitPath = options.gitPath ?? "git";
    const repositoryRoot = await realpath(options.repositoryRoot).catch(() => undefined);
    if (repositoryRoot === undefined) throw new WorktreeLifecycleError("invalid-repository", "Repository root does not exist.");
    const bootstrap = async (args: readonly string[]): Promise<string> => new Promise((resolvePromise, reject) => {
      execFile(gitPath, args, {
        cwd: repositoryRoot,
        env: cleanGitEnvironment(),
        shell: false,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
        encoding: "utf8",
      }, (error, stdout) => error === null ? resolvePromise(stdout) : reject(error));
    });
    let top: string;
    let commonText: string;
    let gitDirText: string;
    try {
      [top, commonText, gitDirText] = await Promise.all([
        bootstrap(["rev-parse", "--show-toplevel"]),
        bootstrap(["rev-parse", "--git-common-dir"]),
        bootstrap(["rev-parse", "--git-dir"]),
      ]);
      if ((await bootstrap(["rev-parse", "--is-inside-work-tree"])).trim() !== "true" ||
        (await bootstrap(["rev-parse", "--is-bare-repository"])).trim() !== "false") throw new Error("not checkout");
    } catch {
      throw new WorktreeLifecycleError("invalid-repository", "Repository root is not a primary Git checkout.");
    }
    const topPath = await realpath(resolve(repositoryRoot, top.trim())).catch(() => undefined);
    const commonGitDir = await realpath(resolve(repositoryRoot, commonText.trim())).catch(() => undefined);
    const gitDir = await realpath(resolve(repositoryRoot, gitDirText.trim())).catch(() => undefined);
    if (topPath === undefined || commonGitDir === undefined || gitDir === undefined ||
      pathIdentity(topPath) !== pathIdentity(repositoryRoot) || pathIdentity(gitDir) !== pathIdentity(commonGitDir)) {
      throw new WorktreeLifecycleError("invalid-repository", "Repository root is not the primary checkout.");
    }

    const lifecycleRoot = join(commonGitDir, "sortie-dogs");
    const requestedRoot = join(lifecycleRoot, "managed-worktrees-v1");
    if (options.worktreeRoot !== undefined && pathIdentity(resolve(options.worktreeRoot)) !== pathIdentity(requestedRoot)) {
      throw new WorktreeLifecycleError("invalid-request", "Worktree root must be the repository's managed lifecycle root.");
    }
    await mkdir(lifecycleRoot, { recursive: true, mode: 0o700 });
    await chmod(lifecycleRoot, 0o700).catch(() => undefined);
    await mkdir(requestedRoot, { recursive: false, mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    await chmod(requestedRoot, 0o700).catch(() => undefined);
    const worktreeRoot = await realpath(requestedRoot).catch(() => undefined);
    const rootLinkInfo = worktreeRoot === undefined ? undefined : await lstat(requestedRoot, { bigint: true }).catch(() => undefined);
    const rootInfo = worktreeRoot === undefined ? undefined : await stat(worktreeRoot, { bigint: true }).catch(() => undefined);
    if (worktreeRoot === undefined || rootLinkInfo === undefined || rootInfo === undefined ||
      !rootLinkInfo.isDirectory() || rootLinkInfo.isSymbolicLink() || !rootInfo.isDirectory() ||
      pathIdentity(worktreeRoot) !== pathIdentity(requestedRoot) || !pathWithin(worktreeRoot, commonGitDir)) {
      throw new WorktreeLifecycleError("invalid-request", "Managed worktree root identity is invalid.");
    }
    const rootDev = fileID(worktreeRoot, rootLinkInfo.dev, "device");
    const rootIno = fileID(worktreeRoot, rootLinkInfo.ino, "inode");
    const rootStatDev = fileID(worktreeRoot, rootInfo.dev, "device");
    const rootStatIno = fileID(worktreeRoot, rootInfo.ino, "inode");
    if (rootDev === undefined || rootIno === undefined || rootStatDev === undefined || rootStatIno === undefined) {
      throw new WorktreeLifecycleError("invalid-request", "Managed worktree root has no safe filesystem identity.");
    }
    const lifecycle = new WorktreeLifecycle(repositoryRoot, worktreeRoot, gitPath, commonGitDir, {
      dev: rootDev,
      ino: rootIno,
      statDev: rootStatDev,
      statIno: rootStatIno,
    });
    await lifecycle.reconcile();
    return lifecycle;
  }

  pathPrefixFor(worktreeId: string): string {
    if (!validText(worktreeId)) throw new WorktreeLifecycleError("invalid-request", "Worktree ID is invalid.");
    return join(this.worktreeRoot, `wt-${identity(worktreeId).slice(0, 16)}-`);
  }

  async pinCleanBase(): Promise<WorktreeBasePin> {
    const sha = (await this.git(["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    if (!SHA.test(sha)) throw new WorktreeLifecycleError("invalid-repository", "Primary HEAD is not a commit.");
    await this.assertClean(this.repositoryRoot, "dirty-tree");
    return Object.freeze({ repositoryRoot: this.repositoryRoot, sha });
  }

  async createMany(request: WorktreeCreateRequest): Promise<readonly ManagedWorktree[]> {
    if (!isRecord(request) || !hasExactKeys(request, request.setupHooks === undefined
      ? ["pin", "tasks"]
      : ["pin", "setupHooks", "tasks"]) || !isRecord(request.pin) ||
      !hasExactKeys(request.pin, ["repositoryRoot", "sha"]) || !Array.isArray(request.tasks) ||
      request.tasks.length < 2 || request.tasks.length > MAX_WORKTREES ||
      (request.setupHooks !== undefined && !Array.isArray(request.setupHooks))) {
      throw new WorktreeLifecycleError("invalid-request", "Create request is invalid.");
    }
    if (pathIdentity(request.pin.repositoryRoot as string) !== pathIdentity(this.repositoryRoot) ||
      typeof request.pin.sha !== "string" || !SHA.test(request.pin.sha)) {
      throw new WorktreeLifecycleError("invalid-request", "Base pin is invalid.");
    }
    if ((request.setupHooks?.length ?? 0) > MAX_SETUP_HOOKS) {
      throw new WorktreeLifecycleError("invalid-request", "Create request has too many setup hooks.");
    }
    const hooks = (request.setupHooks ?? []).map((hook) => this.validateHook(hook));
    const seenIdentity = new Set<string>();
    const seenBranch = new Set<string>();
    const seenTask = new Set<string>();
    const records: InventoryRecord[] = [];
    for (const task of request.tasks) {
      this.validateTask(task, request.pin.sha);
      const id = identity(task.worktree);
      const branchID = task.branch.toLowerCase();
      const taskID = task.task_id.toLowerCase();
      if (seenTask.has(taskID) || seenIdentity.has(id) || seenBranch.has(branchID)) {
        throw new WorktreeLifecycleError("invalid-request", "Task, worktree, or branch identity is duplicated.");
      }
      const ownershipNonce = randomUUID();
      const path = `${this.pathPrefixFor(task.worktree)}${ownershipNonce.replaceAll("-", "")}`;
      if (records.some((entry) => pathIdentity(entry.path) === pathIdentity(path))) {
        throw new WorktreeLifecycleError("invalid-request", "Worktree path identity collides.");
      }
      const lockReason = `sortie-dogs:${id.slice(0, 16)}:${ownershipNonce}`;
      records.push({ identity: id, path, pathNonce: ownershipNonce, branch: task.branch, baseSha: request.pin.sha,
        expectedSha: request.pin.sha, lockReason, ownershipNonce, branchOwned: false,
        targetDev: null, targetIno: null, phase: "creating" });
      seenIdentity.add(id);
      seenBranch.add(branchID);
      seenTask.add(taskID);
    }
    try {
      await Promise.all(records.map((record) => this.git(["check-ref-format", "--branch", record.branch])));
    } catch {
      throw new WorktreeLifecycleError("invalid-request", "Task branch name is invalid.");
    }
    try {
      await this.withInventoryTransaction(async () => {
        if (this.inventory.records.length + records.length > MAX_WORKTREES) {
          throw new WorktreeLifecycleError("invalid-request", "Managed worktree inventory cannot exceed three records.");
        }
        if (records.some((record) => this.inventory.records.some((entry) =>
          entry.identity === record.identity || entry.branch.toLowerCase() === record.branch.toLowerCase()))) {
          throw new WorktreeLifecycleError("invalid-request", "Task, worktree, or branch identity is duplicated.");
        }
        if ((await Promise.all(records.map((record) => this.branchExists(record.branch)))).some(Boolean)) {
          throw new WorktreeLifecycleError("invalid-request", "A requested branch already exists.");
        }
        const current = (await this.git(["rev-parse", "--verify", "HEAD^{commit}"])).trim();
        if (current !== request.pin.sha) {
          throw new WorktreeLifecycleError("stale-base", "Primary HEAD no longer matches the base pin.");
        }
        await this.assertClean(this.repositoryRoot, "dirty-tree");
        this.inventory.records.push(...records);
        await this.saveInventory();
        for (const record of records) {
          await this.createAndLock(record);
        }
      });
    } catch (error) {
      if (error instanceof WorktreeLifecycleError &&
        (error.code === "invalid-request" || error.code === "stale-base" || error.code === "dirty-tree")) throw error;
      await this.orphanOwnedRecords(records);
      throw new WorktreeLifecycleError("git-failed", "One or more worktrees could not be created; artifacts were retained.");
    }

    const setup = await Promise.allSettled(records.map(async (record) => {
      this.inFlight.add(record.identity);
      try {
        for (const hook of hooks) {
          await this.runSetupHook(hook.executable, hook.args, record.path, hook.timeoutMs);
          await this.assertCreationIdentity(request.pin.sha, [record]);
        }
      } finally {
        this.inFlight.delete(record.identity);
      }
    }));
    try {
      if (setup.some((result) => result.status === "rejected")) throw new Error("setup");
      await this.assertCreationIdentity(request.pin.sha, records);
      return await this.withInventoryTransaction(async () => {
        const currentRecords = records.map((record) => this.requireOwnedRecord(record, "setting-up"));
        for (const record of currentRecords) record.phase = "ready";
        await this.saveInventory();
        return currentRecords.map((record) => this.publicRecord(record));
      });
    } catch {
      await this.orphanOwnedRecords(records);
      throw new WorktreeLifecycleError("setup-failed", "Worktree setup failed or changed managed Git identity; artifacts were retained.");
    }
  }

  async cleanup(worktreeId: string): Promise<void> {
    if (!validText(worktreeId)) throw new WorktreeLifecycleError("invalid-request", "Worktree ID is invalid.");
    const id = identity(worktreeId);
    if (this.inFlight.has(id)) throw new WorktreeLifecycleError("unsafe-cleanup", "Worktree setup is still in flight.");
    await this.assertRootIdentity();
    await this.withInventoryTransaction(async () => {
      const record = this.inventory.records.find((entry) => entry.identity === id);
      if (record === undefined || record.phase !== "ready") {
        throw new WorktreeLifecycleError("unsafe-cleanup", "Worktree ownership is absent or ambiguous.");
      }
      if (!record.branchOwned || await this.exactEntry(record) === undefined) {
        await this.orphan(record);
        throw new WorktreeLifecycleError("unsafe-cleanup", "Worktree ownership, path, HEAD, or branch does not match inventory.");
      }
      await this.assertClean(record.path, "unsafe-cleanup");
      record.phase = "removing";
      await this.saveInventory();
      const originalPath = record.path;
      const quarantineNonce = randomUUID();
      const quarantinePath = join(this.worktreeRoot,
        `rm-${record.identity.slice(0, 16)}-${quarantineNonce.replaceAll("-", "")}`);
      try {
        await this.assertRootIdentity();
        if (await lstat(quarantinePath).catch(() => undefined) !== undefined ||
          await this.exactEntry(record) === undefined || !(await this.isClean(record.path))) throw new Error("identity");
        try {
          await this.git(["worktree", "move", originalPath, quarantinePath]);
        } catch {
          if (await this.exactEntry(record) === undefined || !(await this.isClean(record.path))) throw new Error("identity");
          await this.git(["worktree", "unlock", originalPath]);
          await this.assertRootIdentity();
          if (await this.exactEntry(record, undefined, false) === undefined || !(await this.isClean(record.path))) {
            if (await this.targetMatches(record)) {
              await this.git(["worktree", "lock", "--reason", record.lockReason, originalPath]).catch(() => undefined);
            }
            throw new Error("identity");
          }
          try {
            await this.git(["worktree", "move", originalPath, quarantinePath]);
          } catch {
            if (await this.exactEntry(record, undefined, false) !== undefined && await this.targetMatches(record)) {
              await this.git(["worktree", "lock", "--reason", record.lockReason, originalPath]).catch(() => undefined);
            }
            throw new Error("move");
          }
          record.path = quarantinePath;
          record.pathNonce = quarantineNonce;
          await this.git(["worktree", "lock", "--reason", record.lockReason, quarantinePath]);
        }
        record.path = quarantinePath;
        record.pathNonce = quarantineNonce;
        if (await this.exactEntry(record) === undefined ||
          !(await this.isClean(quarantinePath))) throw new Error("quarantine");
        await this.saveInventory();
        await this.git(["worktree", "unlock", quarantinePath]);
        await this.assertRootIdentity();
        if (await this.exactEntry(record, undefined, false) === undefined || !(await this.isClean(quarantinePath))) {
          if (await this.targetMatches(record)) {
            await this.git(["worktree", "lock", "--reason", record.lockReason, quarantinePath]).catch(() => undefined);
          }
          throw new Error("identity");
        }
        await this.git(["worktree", "remove", quarantinePath]);
        await this.git(["update-ref", "-d", `refs/heads/${record.branch}`, record.expectedSha]);
      } catch {
        if (await this.exactEntry(record, undefined, false) !== undefined && await this.targetMatches(record)) {
          await this.git(["worktree", "lock", "--reason", record.lockReason, record.path]).catch(() => undefined);
        }
        record.phase = "orphaned";
        await this.saveInventory();
        throw new WorktreeLifecycleError("unsafe-cleanup", "Non-destructive worktree or branch removal was refused; artifacts were retained.");
      }
      this.inventory.records = this.inventory.records.filter((entryRecord) => entryRecord !== record);
      await this.saveInventory();
    });
  }

  async reconcile(): Promise<readonly ManagedWorktree[]> {
    await this.assertRootIdentity();
    return this.withInventoryTransaction(async () => {
      const listed = await this.listWorktrees();
      let changed = false;
      const retained: InventoryRecord[] = [];
      for (const record of this.inventory.records) {
        if (record.phase === "creating" || record.phase === "setting-up" || record.phase === "removing" ||
          record.phase === "orphaned") {
          retained.push(record);
          continue;
        }
        const entry = listed.find((candidate) => pathIdentity(candidate.path) === pathIdentity(record.path));
        const pathInfo = await stat(record.path).catch(() => undefined);
        if (entry === undefined && pathInfo === undefined) {
          const ref = await this.refSha(record.branch);
          if (ref === undefined) {
            changed = true;
            continue;
          }
          if (record.branchOwned && ref === record.expectedSha) {
            try {
              await this.git(["update-ref", "-d", `refs/heads/${record.branch}`, record.expectedSha]);
              changed = true;
              continue;
            } catch {
              // Preserve a ref that changed during compare-and-delete.
            }
          }
          record.phase = "orphaned";
          changed = true;
          retained.push(record);
          continue;
        }
        if (entry === undefined || await this.exactEntry(record, entry) === undefined || !(await this.isClean(record.path))) {
          record.phase = "orphaned";
          changed = true;
        }
        retained.push(record);
      }
      this.inventory.records = retained;
      if (changed) await this.saveInventory();
      return retained.map((record) => this.publicRecord(record));
    });
  }

  private validateHook(value: unknown): Required<WorktreeSetupHook> {
    if (!isRecord(value) || !hasExactKeys(value, ["executable", ...(value.args === undefined ? [] : ["args"]),
      ...(value.timeoutMs === undefined ? [] : ["timeoutMs"])]) || !validText(value.executable, MAX_PATH) ||
      !isAbsolute(value.executable) || (value.args !== undefined && (!Array.isArray(value.args) || value.args.length > 128 ||
        !value.args.every((arg) => validText(arg, MAX_PATH)))) ||
      (value.timeoutMs !== undefined && (!Number.isInteger(value.timeoutMs) || (value.timeoutMs as number) < 1 ||
        (value.timeoutMs as number) > 10 * 60_000))) {
      throw new WorktreeLifecycleError("invalid-request", "Setup hook is invalid.");
    }
    return { executable: value.executable, args: (value.args as string[] | undefined) ?? [],
      timeoutMs: (value.timeoutMs as number | undefined) ?? GIT_TIMEOUT_MS };
  }

  private validateTask(task: unknown, sha: string): asserts task is WorktreeParallelTask {
    if (!isRecord(task) || !hasExactKeys(task, ["base_sha", "branch", "depends_on", "scope", "task_id", "worktree"]) ||
      !validText(task.task_id) || !validText(task.worktree) || !validText(task.branch) || task.base_sha !== sha ||
      !Array.isArray(task.depends_on) || task.depends_on.length > MAX_INVENTORY_RECORDS ||
      !task.depends_on.every((dependency) => validText(dependency)) || !isRecord(task.scope) ||
      !hasExactKeys(task.scope, ["read", "write"]) || !Array.isArray(task.scope.read) || !Array.isArray(task.scope.write) ||
      ![...task.scope.read, ...task.scope.write].every((path) => validText(path, MAX_PATH)) ||
      task.branch.startsWith("refs/") || task.branch.startsWith("-")) {
      throw new WorktreeLifecycleError("invalid-request", "Task contract is invalid or does not match the base pin.");
    }
    const scope = task.scope as { read: string[]; write: string[] };
    try {
      const normalized = normalizeWorktreeScope(scope);
      if (normalized.read.length !== scope.read.length || normalized.write.length !== scope.write.length ||
        !normalized.read.every((path, index) => path === scope.read[index]) ||
        !normalized.write.every((path, index) => path === scope.write[index])) throw new Error();
    } catch {
      throw new WorktreeLifecycleError("invalid-request", "Task scope is not canonical.");
    }
  }

  private publicRecord(record: InventoryRecord): ManagedWorktree {
    return Object.freeze({ identity: record.identity.slice(0, 16), path: record.path, branch: record.branch,
      baseSha: record.baseSha, phase: record.phase });
  }

  private async git(args: readonly string[], cwd = this.repositoryRoot): Promise<string> {
    return this.runExecutable(this.gitPath, args, cwd, GIT_TIMEOUT_MS, "git-failed");
  }

  private async runSetupHook(
    executable: string,
    args: readonly string[],
    cwd: string,
    timeoutMs: number,
  ): Promise<void> {
    const child = spawn(executable, args, {
      cwd,
      env: this.gitEnv,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let outputBytes = 0;
    let outputExceeded = false;
    let timedOut = false;
    const countOutput = (chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > GIT_MAX_BUFFER) outputExceeded = true;
    };
    child.stdout.on("data", countOutput);
    child.stderr.on("data", countOutput);
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolvePromise({ code, signal }));
    });
    let closedSettled = false;
    void closed.then(() => { closedSettled = true; }, () => { closedSettled = true; });
    const timer = setTimeout(() => { timedOut = true; }, timeoutMs);
    timer.unref();
    try {
      while (!closedSettled && !timedOut && !outputExceeded) {
        await Promise.race([closed, new Promise((resolvePromise) => setTimeout(resolvePromise, 10))]);
      }
      if (timedOut || outputExceeded) await this.terminateProcessTree(child, closed);
      const result = await closed;
      if (timedOut || outputExceeded || result.code !== 0) {
        throw new WorktreeLifecycleError("setup-failed", "Setup executable failed or exceeded its resource bound.");
      }
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) await this.terminateProcessTree(child, closed).catch(() => undefined);
      if (error instanceof WorktreeLifecycleError) throw error;
      throw new WorktreeLifecycleError("setup-failed", "Setup executable failed.");
    } finally {
      clearTimeout(timer);
    }
  }

  private async terminateProcessTree(
    child: ChildProcess,
    closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  ): Promise<void> {
    if (child.pid === undefined) return;
    if (process.platform === "win32") {
      const taskkill = join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "taskkill.exe");
      const killer = spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
        env: this.gitEnv,
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      const killerClosed = new Promise<void>((resolvePromise) => {
        killer.once("error", () => resolvePromise());
        killer.once("close", () => resolvePromise());
      });
      if (!(await this.waitForClose(killerClosed, PROCESS_KILL_WAIT_MS))) {
        killer.kill();
        throw new WorktreeLifecycleError("setup-failed", "Setup process tree killer did not terminate.");
      }
    } else {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* The process group may already be gone. */ }
      if (!(await this.waitForClose(closed, PROCESS_EXIT_GRACE_MS))) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* The process group may already be gone. */ }
      }
    }
    if (!(await this.waitForClose(closed, PROCESS_KILL_WAIT_MS))) {
      throw new WorktreeLifecycleError("setup-failed", "Setup process tree termination could not be confirmed.");
    }
  }

  private async waitForClose(closed: Promise<unknown>, timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        closed.then(() => true, () => true),
        new Promise<boolean>((resolvePromise) => { timer = setTimeout(() => resolvePromise(false), timeoutMs); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async runExecutable(
    executable: string,
    args: readonly string[],
    cwd: string,
    timeoutMs: number,
    code: WorktreeLifecycleErrorCode = "setup-failed",
  ): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      execFile(executable, args, {
        cwd,
        env: this.gitEnv,
        shell: false,
        timeout: timeoutMs,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
        encoding: "utf8",
      }, (error, stdout) => {
        if (error === null) resolvePromise(stdout);
        else reject(new WorktreeLifecycleError(code, code === "git-failed" ? "Git command failed." : "Setup executable failed."));
      });
    });
  }

  private async assertClean(path: string, code: WorktreeLifecycleErrorCode): Promise<void> {
    if (!(await this.isClean(path))) throw new WorktreeLifecycleError(code, "Git checkout contains visible changes.");
  }

  private async isClean(path: string): Promise<boolean> {
    const status = await this.git([
      "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none",
    ], path);
    return status.length === 0;
  }

  private async listWorktrees(): Promise<GitWorktree[]> {
    return parseWorktreeList(await this.git(["worktree", "list", "--porcelain", "-z"]));
  }

  private async refSha(branch: string): Promise<string | undefined> {
    try {
      const value = (await this.git(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`])).trim();
      return SHA.test(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private async branchExists(branch: string): Promise<boolean> {
    try {
      await this.git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  private async exactEntry(
    record: InventoryRecord,
    known?: GitWorktree,
    requireLock = true,
  ): Promise<GitWorktree | undefined> {
    const entry = known ?? (await this.listWorktrees()).find((candidate) =>
      pathIdentity(candidate.path) === pathIdentity(record.path));
    if (entry === undefined || entry.bare || entry.detached || entry.prunable || entry.head !== record.expectedSha ||
      entry.branch !== `refs/heads/${record.branch}` || (requireLock && entry.locked !== record.lockReason) ||
      (await this.refSha(record.branch)) !== record.expectedSha) return undefined;
    const actualPath = await realpath(record.path).catch(() => undefined);
    const listedPath = await realpath(entry.path).catch(() => undefined);
    if (actualPath === undefined || pathIdentity(actualPath) !== pathIdentity(record.path) ||
      listedPath === undefined || pathIdentity(listedPath) !== pathIdentity(actualPath) ||
      !this.isDirectManagedRecord(record) || !(await this.targetMatches(record))) return undefined;
    return entry;
  }

  private async createAndLock(record: InventoryRecord): Promise<void> {
    await this.assertRootIdentity();
    if (!this.isDirectManagedRecord(record) || await lstat(record.path).catch(() => undefined) !== undefined ||
      await this.branchExists(record.branch)) throw new Error("identity");
    await this.git(["worktree", "add", "-b", record.branch, record.path, record.baseSha]);
    await this.assertRootIdentity();
    const info = await this.targetInfo(record.path);
    if (info === undefined) throw new Error("identity");
    record.targetDev = info.dev;
    record.targetIno = info.ino;
    const entry = (await this.listWorktrees()).find((candidate) => pathIdentity(candidate.path) === pathIdentity(record.path));
    if (entry === undefined || entry.bare || entry.detached || entry.prunable || entry.head !== record.expectedSha ||
      entry.branch !== `refs/heads/${record.branch}` || await this.refSha(record.branch) !== record.expectedSha) {
      throw new Error("identity");
    }
    record.branchOwned = true;
    await this.saveInventory();
    await this.git(["worktree", "lock", "--reason", record.lockReason, record.path]);
    if (await this.exactEntry(record) === undefined) throw new Error("identity");
    record.phase = "setting-up";
    await this.saveInventory();
  }

  private requireOwnedRecord(record: InventoryRecord, phase: WorktreeLifecyclePhase): InventoryRecord {
    const current = this.inventory.records.find((candidate) => candidate.identity === record.identity);
    if (current === undefined || current.ownershipNonce !== record.ownershipNonce || current.path !== record.path ||
      current.branch !== record.branch || current.phase !== phase) throw new Error("inventory ownership changed");
    return current;
  }

  private isDirectManagedPath(path: string): boolean {
    const name = path.slice(dirname(path).length + 1);
    return pathIdentity(dirname(path)) === pathIdentity(this.worktreeRoot) &&
      (ACTIVE_PATH.test(name) || QUARANTINE_PATH.test(name));
  }

  private isDirectManagedRecord(record: InventoryRecord): boolean {
    const name = record.path.slice(dirname(record.path).length + 1);
    const match = ACTIVE_PATH.exec(name) ??
      (record.phase === "removing" || record.phase === "orphaned" ? QUARANTINE_PATH.exec(name) : null);
    return pathIdentity(dirname(record.path)) === pathIdentity(this.worktreeRoot) && match?.[1] === record.identity.slice(0, 16) &&
      match[2] === record.pathNonce.replaceAll("-", "");
  }

  private async targetInfo(path: string): Promise<{ dev: string; ino: string } | undefined> {
    if (!this.isDirectManagedPath(path)) return undefined;
    const link = await lstat(path, { bigint: true }).catch(() => undefined);
    const actual = await realpath(path).catch(() => undefined);
    if (link === undefined || actual === undefined || !link.isDirectory() || link.isSymbolicLink() ||
      pathIdentity(actual) !== pathIdentity(path)) return undefined;
    const dev = fileID(path, link.dev, "device");
    const ino = fileID(path, link.ino, "inode");
    return dev === undefined || ino === undefined ? undefined : { dev, ino };
  }

  private async targetMatches(record: InventoryRecord): Promise<boolean> {
    if (record.targetDev === null || record.targetIno === null) return false;
    const info = await this.targetInfo(record.path);
    return info !== undefined && info.dev === record.targetDev && info.ino === record.targetIno;
  }

  private async assertCreationIdentity(primarySha: string, records: readonly InventoryRecord[]): Promise<void> {
    await this.assertRootIdentity();
    const primaryHead = (await this.git(["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    if (primaryHead !== primarySha || !(await this.isClean(this.repositoryRoot))) {
      throw new WorktreeLifecycleError("setup-failed", "Primary checkout changed during setup.");
    }
    for (const record of records) {
      if (await this.exactEntry(record) === undefined || !(await this.isClean(record.path))) {
        throw new WorktreeLifecycleError("setup-failed", "Managed worktree identity changed during setup.");
      }
    }
  }

  private async assertRootIdentity(): Promise<void> {
    const linkInfo = await lstat(this.worktreeRoot, { bigint: true }).catch(() => undefined);
    const info = await stat(this.worktreeRoot, { bigint: true }).catch(() => undefined);
    const actual = await realpath(this.worktreeRoot).catch(() => undefined);
    if (linkInfo === undefined || info === undefined || actual === undefined || !linkInfo.isDirectory() ||
      linkInfo.isSymbolicLink() || !info.isDirectory() || pathIdentity(actual) !== pathIdentity(this.worktreeRoot) ||
      fileID(this.worktreeRoot, linkInfo.dev, "device") !== this.rootIdentity.dev ||
      fileID(this.worktreeRoot, linkInfo.ino, "inode") !== this.rootIdentity.ino ||
      fileID(this.worktreeRoot, info.dev, "device") !== this.rootIdentity.statDev ||
      fileID(this.worktreeRoot, info.ino, "inode") !== this.rootIdentity.statIno ||
      !pathWithin(actual, this.commonGitDir)) {
      throw new WorktreeLifecycleError("invalid-request", "Worktree root identity changed or crossed a managed boundary.");
    }
  }

  private async orphanOwnedRecords(records: readonly InventoryRecord[]): Promise<void> {
    await this.withInventoryTransaction(async () => {
      let changed = false;
      for (const record of records) {
        const current = this.inventory.records.find((candidate) => candidate.identity === record.identity);
        if (current !== undefined && current.ownershipNonce === record.ownershipNonce && current.phase !== "orphaned") {
          current.phase = "orphaned";
          changed = true;
        }
      }
      if (changed) await this.saveInventory();
    });
  }

  private async orphan(record: InventoryRecord): Promise<void> {
    record.phase = "orphaned";
    await this.saveInventory();
  }

  private async withInventoryTransaction<T>(operation: (lease: ScopeLease) => Promise<T>): Promise<T> {
    const queued = this.transactionQueue.then(async () => {
      const lease = await this.acquireInventoryLease();
      let result: T | undefined;
      let failure: unknown;
      try {
        this.transactionLease = lease;
        await this.assertRootIdentity();
        this.inventory = await this.loadInventory();
        result = await operation(lease);
      } catch (error) {
        failure = error;
      } finally {
        this.transactionLease = undefined;
      }
      try {
        await lease.release();
      } catch {
        lease.close();
        if (failure === undefined) {
          throw new WorktreeLifecycleError("inventory-locked", "Worktree inventory authority release could not be confirmed.");
        }
      }
      if (failure !== undefined) throw failure;
      return result as T;
    });
    this.transactionQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private async acquireInventoryLease(): Promise<ScopeLease> {
    const deadline = Date.now() + GIT_TIMEOUT_MS;
    while (true) {
      try {
        return await this.leaseRegistry.acquire({
          ownerId: `worktree-lifecycle:${process.pid}:${randomUUID()}`,
          scope: INVENTORY_SCOPE,
          ttlMs: 10 * 60_000,
        });
      } catch (error) {
        if (!(error instanceof ScopeLeaseError) || error.code !== "scope-conflict" || Date.now() >= deadline) {
          throw new WorktreeLifecycleError("inventory-locked", "Worktree inventory authority could not be acquired.");
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }
    }
  }

  private async loadInventory(): Promise<Inventory> {
    let source: Buffer;
    try {
      source = await readFile(this.inventoryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 3, records: [] };
      throw new WorktreeLifecycleError("corrupt-inventory", "Worktree inventory cannot be read.");
    }
    if (source.byteLength > MAX_INVENTORY_BYTES) throw new WorktreeLifecycleError("corrupt-inventory", "Worktree inventory is oversized.");
    try {
      const raw = JSON.parse(source.toString("utf8")) as unknown;
      if (!isRecord(raw) || !hasExactKeys(raw, ["records", "version"]) || raw.version !== INVENTORY_VERSION ||
        !Array.isArray(raw.records) || raw.records.length > MAX_WORKTREES) throw new Error();
      const records: InventoryRecord[] = [];
      const identities = new Set<string>();
      const branches = new Set<string>();
      for (const value of raw.records) {
        if (!isRecord(value) || !hasExactKeys(value, [
          "baseSha", "branch", "branchOwned", "expectedSha", "identity", "lockReason", "ownershipNonce",
          "path", "pathNonce", "phase", "targetDev", "targetIno",
        ]) || typeof value.identity !== "string" || !HASH.test(value.identity) || identities.has(value.identity) ||
          !validText(value.path, MAX_PATH) || !isAbsolute(value.path) ||
          typeof value.pathNonce !== "string" || !UUID.test(value.pathNonce) ||
          !validText(value.branch) || branches.has(value.branch.toLowerCase()) || typeof value.baseSha !== "string" ||
          !SHA.test(value.baseSha) || typeof value.expectedSha !== "string" || !SHA.test(value.expectedSha) ||
          value.expectedSha !== value.baseSha || typeof value.ownershipNonce !== "string" || !UUID.test(value.ownershipNonce) ||
          value.lockReason !== `sortie-dogs:${value.identity.slice(0, 16)}:${value.ownershipNonce}` ||
          typeof value.branchOwned !== "boolean" ||
          !(value.targetDev === null || safeStoredFileID(value.targetDev)) ||
          !(value.targetIno === null || safeStoredFileID(value.targetIno)) ||
          ((value.targetDev === null) !== (value.targetIno === null)) ||
          typeof value.phase !== "string" || !PHASES.has(value.phase)) throw new Error();
        const typed = value as InventoryRecord;
        if (!this.isDirectManagedRecord(typed) ||
          ((typed.phase === "setting-up" || typed.phase === "ready" || typed.phase === "removing") &&
            typed.targetDev === null)) throw new Error();
        identities.add(value.identity);
        branches.add(value.branch.toLowerCase());
        records.push(value as InventoryRecord);
      }
      return { version: 3, records };
    } catch {
      throw new WorktreeLifecycleError("corrupt-inventory", "Worktree inventory is corrupt or unsupported.");
    }
  }

  private async saveInventory(): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      const lease = this.transactionLease;
      if (lease === undefined) {
        throw new WorktreeLifecycleError("inventory-locked", "Inventory mutation requires durable authority.");
      }
      try {
        await lease.assertHeld();
      } catch {
        throw new WorktreeLifecycleError("inventory-locked", "Worktree inventory authority was lost.");
      }
      const source = JSON.stringify(this.inventory);
      if (Buffer.byteLength(source, "utf8") > MAX_INVENTORY_BYTES) {
        throw new WorktreeLifecycleError("corrupt-inventory", "Worktree inventory capacity is exhausted.");
      }
      await mkdir(this.inventoryRoot, { recursive: true, mode: 0o700 });
      await chmod(this.inventoryRoot, 0o700).catch(() => undefined);
      const temporary = join(this.inventoryRoot, `.inventory.${randomUUID()}.tmp`);
      let moved = false;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(source);
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await lease.assertHeld();
        } catch {
          throw new WorktreeLifecycleError("inventory-locked", "Worktree inventory authority was lost.");
        }
        await rename(temporary, this.inventoryPath);
        moved = true;
        await chmod(this.inventoryPath, 0o600).catch(() => undefined);
        const directory = await open(this.inventoryRoot, "r").catch(() => undefined);
        try {
          await directory?.sync().catch(() => undefined);
        } finally {
          await directory?.close().catch(() => undefined);
        }
      } finally {
        if (!moved) await rm(temporary, { force: true }).catch(() => undefined);
      }
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
  }
}
