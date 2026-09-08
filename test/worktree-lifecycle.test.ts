import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import nodeTest, { type TestContext } from "node:test";
import ts from "typescript";

import {
  WorktreeLifecycle,
  WorktreeLifecycleError,
  type WorktreeBasePin,
} from "../dist/core/worktree-lifecycle.js";
import type { WorktreeParallelTask } from "../src/core/types.ts";

type RegisteredTest = {
  name: string;
  body: (context: TestContext) => unknown;
};

const registeredTests: RegisteredTest[] = [];
const fixtureRoot = join(resolve("."), "_testenv", "worktree-lifecycle");

function test(name: string, body: (context: TestContext) => unknown): void {
  registeredTests.push({ name, body });
}

function run(executable: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(executable, args, { cwd, shell: false, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error === null) resolvePromise(stdout);
      else reject(new Error(`${executable} failed: ${stderr}`));
    });
  });
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return run("git", args, cwd);
}

type Fixture = { root: string; repository: string; worktrees: string; lifecycle: WorktreeLifecycle };

async function fixture(name: string): Promise<Fixture> {
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(join(fixtureRoot, `sortie-worktree-${name}-`));
  const repository = join(root, "repository");
  await mkdir(repository);
  await writeFile(join(repository, ".gitignore"), "node_modules/\n");
  await writeFile(join(repository, "shared.txt"), "base\n");
  await git(repository, "init", "-q");
  await git(repository, "config", "user.name", "Sortie Test");
  await git(repository, "config", "user.email", "sortie@example.invalid");
  await git(repository, "add", ".gitignore", "shared.txt");
  await git(repository, "commit", "-q", "-m", "base");
  const lifecycle = await WorktreeLifecycle.open({ repositoryRoot: repository });
  const worktrees = resolve(repository, (await git(repository, "rev-parse", "--git-common-dir")).trim(),
    "sortie-dogs", "managed-worktrees-v1");
  return { root, repository, worktrees, lifecycle };
}

function tasks(pin: WorktreeBasePin, ids: readonly string[]): WorktreeParallelTask[] {
  return ids.map((id, index) => ({
    task_id: `task-${index}`,
    worktree: id,
    branch: `sortie/test-${index}-${id.replace(/[^a-z0-9-]/giu, "x")}`,
    base_sha: pin.sha,
    depends_on: [],
    scope: { read: [], write: [`file-${index}.txt`] },
  }));
}

async function errorCode(operation: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(operation, (error: unknown) => error instanceof WorktreeLifecycleError && error.code === code);
}

async function cleanupFixture(value: Fixture): Promise<void> {
  await rm(value.root, { recursive: true, force: true });
}

async function waitForEntries(path: string, count: number): Promise<void> {
  const { watch } = await import("node:fs");
  if ((await readdir(path).catch(() => [])).length >= count) return;
  await new Promise<void>((resolvePromise, reject) => {
    let settled = false;
    const complete = (): void => {
      if (settled) return;
      settled = true;
      watcher.close();
      resolvePromise();
    };
    const watcher = watch(path, async () => {
      if ((await readdir(path).catch(() => [])).length >= count) complete();
    });
    watcher.on("error", reject);
    void readdir(path).then((names) => { if (names.length >= count) complete(); }, reject);
  });
}

function inventoryPath(value: Fixture): string {
  return join(value.repository, ".git", "sortie-dogs", "worktrees-v1", "inventory.json");
}

test("pinCleanBase rejects tracked and untracked dirt while ignored files are allowed", async () => {
  const value = await fixture("pin");
  try {
    await writeFile(join(value.repository, "shared.txt"), "dirty\n");
    await errorCode(value.lifecycle.pinCleanBase(), "dirty-tree");
    await writeFile(join(value.repository, "shared.txt"), "base\n");
    await writeFile(join(value.repository, "untracked.txt"), "dirty\n");
    await errorCode(value.lifecycle.pinCleanBase(), "dirty-tree");
    await rm(join(value.repository, "untracked.txt"));
    await mkdir(join(value.repository, "node_modules"));
    await writeFile(join(value.repository, "node_modules", "dependency.txt"), "ignored\n");
    assert.match((await value.lifecycle.pinCleanBase()).sha, /^[0-9a-f]{40}$/u);
  } finally {
    await cleanupFixture(value);
  }
});

test("five worktrees share one exact base, isolate edits, hash reserved IDs, and clean ignored dependencies", async () => {
  const value = await fixture("parallel");
  try {
    const pin = await value.lifecycle.pinCleanBase();
    type PrivateLifecycle = {
      inventory: { records: Array<{ branch: string; phase: string }> };
      createAndLock(record: unknown): Promise<unknown>;
      saveInventory(): Promise<void>;
    };
    const lifecycle = value.lifecycle as unknown as PrivateLifecycle;
    const originalCreateAndLock = lifecycle.createAndLock.bind(value.lifecycle);
    const originalSave = lifecycle.saveInventory.bind(value.lifecycle);
    let addEntrants = 0;
    let activePrepares = 0;
    let maximumActivePrepares = 0;
    let activeSaves = 0;
    let maximumActiveSaves = 0;
    const savedPhases: string[][] = [];
    lifecycle.saveInventory = async () => {
      activeSaves += 1;
      maximumActiveSaves = Math.max(maximumActiveSaves, activeSaves);
      try {
        await originalSave();
        savedPhases.push(lifecycle.inventory.records.map(({ phase }) => phase));
      } finally {
        activeSaves -= 1;
      }
    };
    lifecycle.createAndLock = async (record) => {
      addEntrants += 1;
      activePrepares += 1;
      maximumActivePrepares = Math.max(maximumActivePrepares, activePrepares);
      try {
        return await originalCreateAndLock(record);
      } finally {
        activePrepares -= 1;
      }
    };

    const ids = ["CON", "aux", "safe-worker", "lane-four", "lane-five"];
    const expectedPrefixes = ids.map((id) => value.lifecycle.pathPrefixFor(id));
    assert.deepEqual(expectedPrefixes, ids.map((id) => value.lifecycle.pathPrefixFor(id)));
    for (const path of expectedPrefixes) assert.match(basename(path), /^wt-[0-9a-f]{16}-$/u);

    const created = await value.lifecycle.createMany({ pin, tasks: tasks(pin, ids) });
    assert.equal(addEntrants, 5);
    assert.equal(maximumActivePrepares, 5);
    assert.equal(maximumActiveSaves, 1);
    assert.deepEqual(savedPhases.slice(0, 6), [
      ["creating", "creating", "creating", "creating", "creating"],
      ["setting-up", "creating", "creating", "creating", "creating"],
      ["setting-up", "setting-up", "creating", "creating", "creating"],
      ["setting-up", "setting-up", "setting-up", "creating", "creating"],
      ["setting-up", "setting-up", "setting-up", "setting-up", "creating"],
      ["setting-up", "setting-up", "setting-up", "setting-up", "setting-up"],
    ]);
    assert.deepEqual(savedPhases.at(-1), Array(5).fill("ready"));
    assert.equal(created.length, 5);
    for (const [index, entry] of created.entries()) {
      assert.equal(entry.path.startsWith(expectedPrefixes[index]!), true);
      assert.match(basename(entry.path), /^wt-[0-9a-f]{16}-[0-9a-f]{32}$/u);
    }
    const inventory = JSON.parse(await readFile(inventoryPath(value), "utf8")) as {
      records: Array<{ targetDev: string; targetIno: string }>;
    };
    for (const record of inventory.records) {
      assert.equal(BigInt(record.targetDev) > 0n && BigInt(record.targetDev) <= (1n << 64n) - 1n, true);
      assert.equal(BigInt(record.targetIno) > 0n && BigInt(record.targetIno) <= (1n << 64n) - 1n, true);
    }
    assert.deepEqual(new Set(created.map(({ baseSha }) => baseSha)), new Set([pin.sha]));
    await Promise.all(created.map(async (entry, index) => {
      await writeFile(join(entry.path, "shared.txt"), `worker-${index}\n`);
    }));
    assert.equal(await readFile(join(value.repository, "shared.txt"), "utf8"), "base\n");
    assert.deepEqual(await Promise.all(created.map((entry) => readFile(join(entry.path, "shared.txt"), "utf8"))),
      ["worker-0\n", "worker-1\n", "worker-2\n", "worker-3\n", "worker-4\n"]);
    await Promise.all(created.map(async (entry) => {
      await writeFile(join(entry.path, "shared.txt"), "base\n");
      await mkdir(join(entry.path, "node_modules"));
      await writeFile(join(entry.path, "node_modules", "dependency.txt"), "ignored\n");
    }));
    for (const id of ids) await value.lifecycle.cleanup(id);
    for (const path of created.map(({ path }) => path)) assert.equal(await stat(path).catch(() => undefined), undefined);
  } finally {
    await cleanupFixture(value);
  }
});

test("candidate base worktree leaves the authority checkout unchanged and supports one-unit acceptance", async () => {
  const value = await fixture("candidate-base");
  try {
    const authority = await value.lifecycle.pinCleanBase();
    const targetBranch = (await git(value.repository, "symbolic-ref", "--short", "HEAD")).trim();
    const targetBefore = (await git(value.repository, "rev-parse", `refs/heads/${targetBranch}`)).trim();
    const tree = (await git(value.repository, "rev-parse", "HEAD^{tree}")).trim();
    const baseSha = (await git(value.repository, "commit-tree", tree, "-p", authority.sha, "-m", "candidate")).trim();
    const requested = tasks({ repositoryRoot: authority.repositoryRoot, sha: baseSha }, ["candidate"]);
    const [created] = await value.lifecycle.createManyAtBase({ authority, baseSha, tasks: requested });
    assert.equal(created?.baseSha, baseSha);
    assert.equal((await git(value.repository, "rev-parse", "HEAD")).trim(), authority.sha);
    assert.equal((await git(value.repository, "rev-parse", `refs/heads/${targetBranch}`)).trim(), targetBefore);
    await writeFile(join(created!.path, "candidate.txt"), "candidate\n");
    await git(created!.path, "add", "candidate.txt");
    await git(created!.path, "commit", "-q", "-m", "accepted");
    const commitSha = (await git(created!.path, "rev-parse", "HEAD")).trim();
    await value.lifecycle.acceptCommit("candidate", created!.path, baseSha, commitSha, created!.branch);
    const prototype = WorktreeLifecycle.prototype as unknown as {
      git(args: readonly string[], cwd?: string): Promise<string>;
    };
    const originalGit = prototype.git;
    let restartParentChecks = 0;
    prototype.git = async function (args, cwd) {
      if (args.join(" ") === `rev-list --parents -n 1 ${commitSha}`) restartParentChecks += 1;
      return originalGit.call(this, args, cwd);
    };
    let restarted: WorktreeLifecycle;
    try {
      restarted = await WorktreeLifecycle.open({ repositoryRoot: value.repository });
    } finally {
      prototype.git = originalGit;
    }
    assert.equal(restartParentChecks, 1, "a new lifecycle open revalidates persisted parentage");
    assert.deepEqual((await restarted.reconcile()).map(({ phase }) => phase), ["ready"]);
    await restarted.cleanup("candidate");
    await assert.rejects(git(value.repository, "rev-parse", "--verify", `refs/heads/${created!.branch}`));
    assert.equal(await stat(created!.path).catch(() => undefined), undefined);
  } finally {
    await cleanupFixture(value);
  }
});

test("direct-parent attestations are positive-only, instance-scoped, fully bound, and capped", async () => {
  const value = await fixture("parent-attestations");
  try {
    type PrivateLifecycle = {
      git(args: readonly string[], cwd?: string): Promise<string>;
      attestDirectParent(expectedSha: string, baseSha: string, cwd?: string): Promise<boolean>;
    };
    const lifecycle = value.lifecycle as unknown as PrivateLifecycle;
    const originalGit = lifecycle.git.bind(value.lifecycle);
    const expected = "a".repeat(40);
    const base = "b".repeat(40);
    const otherBase = "c".repeat(40);
    let calls = 0;
    let fail = false;
    lifecycle.git = async (args, cwd) => {
      if (args[0] !== "rev-list") return originalGit(args, cwd);
      calls += 1;
      if (fail) throw new WorktreeLifecycleError("git-failed", "injected");
      const requested = args[4]!;
      const parent = requested === expected ? (calls === 2 ? otherBase : base) : requested.replace(/^./u, "f");
      return `${requested} ${parent}\n`;
    };

    assert.equal(await lifecycle.attestDirectParent(expected, base), true);
    assert.equal(await lifecycle.attestDirectParent(expected, base), true);
    assert.equal(calls, 1, "same instance and exact pair reuses a positive attestation");
    assert.equal(await lifecycle.attestDirectParent(expected, otherBase), true);
    assert.equal(calls, 2, "a different base is a cache miss");

    const failedExpected = "d".repeat(40);
    fail = true;
    await assert.rejects(lifecycle.attestDirectParent(failedExpected, base));
    fail = false;
    assert.equal(await lifecycle.attestDirectParent(failedExpected, base), false);
    assert.equal(await lifecycle.attestDirectParent(failedExpected, base), false);
    assert.equal(calls, 5, "Git failures and non-parent results are not cached");

    for (let index = 0; index < 32; index += 1) {
      const sha = index.toString(16).padStart(40, "0");
      lifecycle.git = async (args) => {
        calls += 1;
        return `${args[4]} ${base}\n`;
      };
      assert.equal(await lifecycle.attestDirectParent(sha, base), true);
    }
    lifecycle.git = async (args) => {
      calls += 1;
      return `${args[4]} ${base}\n`;
    };
    const beforeEvictedLookup = calls;
    assert.equal(await lifecycle.attestDirectParent(expected, base), true);
    assert.equal(calls, beforeEvictedLookup + 1, "the least-recent positive entry is evicted above 32");

    const prototype = WorktreeLifecycle.prototype as unknown as PrivateLifecycle;
    const prototypeGit = prototype.git;
    let reopenedCalls = 0;
    prototype.git = async function (args, cwd) {
      if (args[0] === "rev-list") reopenedCalls += 1;
      return prototypeGit.call(this, args, cwd);
    };
    try {
      const reopened = await WorktreeLifecycle.open({ repositoryRoot: value.repository });
      const reopenedPrivate = reopened as unknown as PrivateLifecycle;
      reopenedPrivate.git = async (args) => {
        reopenedCalls += 1;
        return `${args[4]} ${base}\n`;
      };
      assert.equal(await reopenedPrivate.attestDirectParent(expected, base), true);
      assert.equal(reopenedCalls, 1, "a new lifecycle instance revalidates the same pair");
    } finally {
      prototype.git = prototypeGit;
    }
  } finally {
    await cleanupFixture(value);
  }
});

test("candidate base rejects unrelated commits and a moved or dirty authority", async () => {
  const value = await fixture("candidate-rejections");
  try {
    const authority = await value.lifecycle.pinCleanBase();
    const tree = (await git(value.repository, "rev-parse", "HEAD^{tree}")).trim();
    const unrelated = (await git(value.repository, "commit-tree", tree, "-m", "unrelated")).trim();
    await errorCode(value.lifecycle.createManyAtBase({ authority, baseSha: unrelated, tasks: tasks({ repositoryRoot: authority.repositoryRoot, sha: unrelated }, ["unrelated"]) }), "stale-base");
    await writeFile(join(value.repository, "moved.txt"), "moved\n");
    await git(value.repository, "add", "moved.txt");
    await git(value.repository, "commit", "-q", "-m", "moved");
    await errorCode(value.lifecycle.createManyAtBase({ authority, baseSha: authority.sha, tasks: tasks(authority, ["moved"]) }), "stale-base");
    const movedAuthority = await value.lifecycle.pinCleanBase();
    await writeFile(join(value.repository, "dirty.txt"), "dirty\n");
    await errorCode(value.lifecycle.createManyAtBase({ authority: movedAuthority, baseSha: movedAuthority.sha, tasks: tasks(movedAuthority, ["dirty"]) }), "dirty-tree");
  } finally {
    await cleanupFixture(value);
  }
});

test("authority validation keeps fresh HEAD and status checks without revalidating an identical base", async () => {
  const value = await fixture("authority-validation");
  try {
    const authority = await value.lifecycle.pinCleanBase();
    const privateLifecycle = value.lifecycle as unknown as {
      git(args: readonly string[], cwd?: string): Promise<string>;
    };
    const originalGit = privateLifecycle.git.bind(value.lifecycle);
    const calls: string[][] = [];
    privateLifecycle.git = async (args, cwd) => {
      calls.push([...args]);
      return originalGit(args, cwd);
    };

    await value.lifecycle.createManyAtBase({
      authority,
      baseSha: authority.sha,
      tasks: tasks(authority, ["same-base"]),
    });

    assert.equal(calls.some((args) => args.join(" ") === "rev-parse --verify HEAD^{commit}"), true);
    assert.equal(calls.some((args) => args[0] === "status" && args[1] === "--porcelain=v1"), true);
    assert.equal(calls.some((args) => args.join(" ") === `rev-parse --verify ${authority.sha}^{commit}`), false);
    assert.equal(calls.some((args) => args[0] === "merge-base" && args[1] === "--is-ancestor"), false);
    await value.lifecycle.cleanup("same-base");
  } finally {
    await cleanupFixture(value);
  }
});

test("bootstrap validates the combined checkout and bare repository booleans", async () => {
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(join(fixtureRoot, "sortie-worktree-bootstrap-"));
  const repository = join(root, "bare.git");
  try {
    await git(root, "init", "--bare", "-q", repository);
    await errorCode(WorktreeLifecycle.open({ repositoryRoot: repository }), "invalid-repository");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("cleanup moves restored worktrees once and retains changes introduced after unlock", async () => {
  const value = await fixture("dirty-cleanup");
  try {
    const pin = await value.lifecycle.pinCleanBase();
    const created = await value.lifecycle.createMany({ pin, tasks: tasks(pin, ["tracked", "untracked"]) });
    await writeFile(join(created[0]!.path, "shared.txt"), "dirty\n");
    await writeFile(join(created[1]!.path, "new.txt"), "dirty\n");
    await errorCode(value.lifecycle.cleanup("tracked"), "unsafe-cleanup");
    await errorCode(value.lifecycle.cleanup("untracked"), "unsafe-cleanup");
    assert.equal((await stat(created[0]!.path)).isDirectory(), true);
    assert.equal((await stat(created[1]!.path)).isDirectory(), true);
    await writeFile(join(created[0]!.path, "shared.txt"), "base\n");
    await rm(join(created[1]!.path, "new.txt"));
    const privateLifecycle = value.lifecycle as unknown as {
      git(args: readonly string[], cwd?: string): Promise<string>;
    };
    const originalGit = privateLifecycle.git.bind(value.lifecycle);
    const operations: string[] = [];
    privateLifecycle.git = async (args, cwd) => {
      if (args[0] === "worktree" && (args[1] === "unlock" || args[1] === "move")) operations.push(args[1]);
      return originalGit(args, cwd);
    };
    await value.lifecycle.cleanup("untracked");
    assert.deepEqual(operations, ["unlock", "move", "unlock"]);

    let changedAfterUnlock = false;
    let moveCalls = 0;
    privateLifecycle.git = async (args, cwd) => {
      const result = await originalGit(args, cwd);
      if (args[0] === "worktree" && args[1] === "move") moveCalls += 1;
      if (!changedAfterUnlock && args[0] === "worktree" && args[1] === "unlock" && args[2] === created[0]!.path) {
        changedAfterUnlock = true;
        await writeFile(join(created[0]!.path, "shared.txt"), "changed after unlock\n");
      }
      return result;
    };
    await errorCode(value.lifecycle.cleanup("tracked"), "unsafe-cleanup");
    assert.equal(changedAfterUnlock, true);
    assert.equal(moveCalls, 0);
    assert.equal((await stat(created[0]!.path)).isDirectory(), true);
    assert.equal(await readFile(join(created[0]!.path, "shared.txt"), "utf8"), "changed after unlock\n");
    const inventory = JSON.parse(await readFile(inventoryPath(value), "utf8")) as {
      records: Array<{ branch: string; phase: string }>;
    };
    assert.equal(inventory.records.find(({ branch }) => branch === created[0]!.branch)?.phase, "orphaned");
  } finally {
    await cleanupFixture(value);
  }
});

test("cancelled cleanup discards only quiescent dirt inside the owned scope", async () => {
  const value = await fixture("cancelled-dirty");
  try {
    const pin = await value.lifecycle.pinCleanBase();
    const primaryHead = (await git(value.repository, "rev-parse", "HEAD")).trim();
    const created = await value.lifecycle.createMany({ pin, tasks: tasks(pin, ["owned", "foreign"]) });
    await writeFile(join(created[0]!.path, "shared.txt"), "owned tracked dirt\n");
    await writeFile(join(created[0]!.path, "file-0.txt"), "owned addition\n");
    await errorCode(value.lifecycle.discardOwnedChanges("owned", created[0]!.path, pin.sha,
      `${created[0]!.branch}-wrong`, ["shared.txt", "file-0.txt"]), "unsafe-cleanup");
    assert.equal(await readFile(join(created[0]!.path, "shared.txt"), "utf8"), "owned tracked dirt\n");
    assert.equal(await readFile(join(created[0]!.path, "file-0.txt"), "utf8"), "owned addition\n");
    await value.lifecycle.discardOwnedChanges("owned", created[0]!.path, pin.sha, created[0]!.branch,
      ["shared.txt", "file-0.txt"]);
    assert.equal(await readFile(join(created[0]!.path, "shared.txt"), "utf8"), "base\n");
    assert.equal(await stat(join(created[0]!.path, "file-0.txt")).catch(() => undefined), undefined);

    await writeFile(join(created[1]!.path, "shared.txt"), "foreign dirt\n");
    await errorCode(value.lifecycle.discardOwnedChanges("foreign", created[1]!.path, pin.sha,
      created[1]!.branch, ["file-1.txt"]), "unsafe-cleanup");
    assert.equal(await readFile(join(created[1]!.path, "shared.txt"), "utf8"), "foreign dirt\n");
    await writeFile(join(created[1]!.path, "shared.txt"), "base\n");
    await value.lifecycle.cleanup("owned");
    await value.lifecycle.cleanup("foreign");
    assert.equal((await git(value.repository, "rev-parse", "HEAD")).trim(), primaryHead);
    assert.equal(await readFile(join(value.repository, "shared.txt"), "utf8"), "base\n");
  } finally {
    await cleanupFixture(value);
  }
});

test("cleanup refuses while direct setup executables are in flight without timing sleeps", async () => {
  const value = await fixture("inflight");
  try {
    const pin = await value.lifecycle.pinCleanBase();
    const signals = join(value.root, "signals");
    const release = join(value.root, "release");
    const script = join(value.root, "blocking-setup.mjs");
    await mkdir(signals);
    await writeFile(script, [
      'import { access, writeFile } from "node:fs/promises";',
      'import { basename, join } from "node:path";',
      'const [signals, release] = process.argv.slice(2);',
      'await writeFile(join(signals, basename(process.cwd())), "started");',
      'while (!(await access(release).then(() => true, () => false))) {',
      '  await new Promise((done) => setTimeout(done, 10));',
      '}',
    ].join("\n"));
    const creation = value.lifecycle.createMany({
      pin,
      tasks: tasks(pin, ["blocked-a", "blocked-b"]),
      setupHooks: [{ executable: process.execPath, args: [script, signals, release], timeoutMs: 10_000 }],
    });
    await waitForEntries(signals, 2);
    await errorCode(value.lifecycle.cleanup("blocked-a"), "unsafe-cleanup");
    await writeFile(release, "release\n");
    await creation;
    await value.lifecycle.cleanup("blocked-a");
    await value.lifecycle.cleanup("blocked-b");
  } finally {
    await cleanupFixture(value);
  }
});

test("setup-visible mutation fails closed and retains orphaned worktrees", async () => {
  const value = await fixture("setup-mutation");
  try {
    const pin = await value.lifecycle.pinCleanBase();
    const script = join(value.root, "mutating-setup.mjs");
    await writeFile(script, 'import { writeFile } from "node:fs/promises"; await writeFile("generated.txt", "visible\\n");\n');
    await errorCode(value.lifecycle.createMany({
      pin,
      tasks: tasks(pin, ["mutated-a", "mutated-b"]),
      setupHooks: [{ executable: process.execPath, args: [script] }],
    }), "setup-failed");
    const records = await value.lifecycle.reconcile();
    assert.deepEqual(records.map(({ phase }) => phase), ["orphaned", "orphaned"]);
    for (const record of records) {
      assert.equal((await stat(record.path)).isDirectory(), true);
    }
    for (const id of ["mutated-a", "mutated-b"]) {
      await errorCode(value.lifecycle.cleanup(id), "unsafe-cleanup");
    }
  } finally {
    await cleanupFixture(value);
  }
});

test("sequential and concurrent lifecycle instances enforce the global five-record bound", async () => {
  const value = await fixture("global-bound");
  try {
    const pin = await value.lifecycle.pinCleanBase();
    const second = await WorktreeLifecycle.open({ repositoryRoot: value.repository });
    const attempts = await Promise.allSettled([
      value.lifecycle.createMany({ pin, tasks: tasks(pin, ["race-a", "race-b", "race-c"]) }),
      second.createMany({ pin, tasks: tasks(pin, ["race-d", "race-e", "race-f"]) }),
    ]);
    assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
    const rejected = attempts.find(({ status }) => status === "rejected") as PromiseRejectedResult;
    assert.equal(rejected.reason instanceof WorktreeLifecycleError && rejected.reason.code === "invalid-request", true);
    const records = await value.lifecycle.reconcile();
    assert.equal(records.length, 3);
    await value.lifecycle.createMany({ pin, tasks: tasks(pin, ["fill-a", "fill-b"]) });
    await errorCode(value.lifecycle.createMany({ pin, tasks: tasks(pin, ["overflow-a", "overflow-b"]) }), "invalid-request");
    assert.equal((await value.lifecycle.reconcile()).length, 5);
  } finally {
    await cleanupFixture(value);
  }
});

test("a long setup releases inventory authority so another instance can reconcile without adopting it", async () => {
  const value = await fixture("setup-concurrency");
  try {
    const pin = await value.lifecycle.pinCleanBase();
    const signals = join(value.root, "signals");
    const release = join(value.root, "release");
    const script = join(value.root, "blocking-setup.mjs");
    await mkdir(signals);
    await writeFile(script, [
      'import { access, writeFile } from "node:fs/promises";',
      'import { basename, join } from "node:path";',
      'const [signals, release] = process.argv.slice(2);',
      'await writeFile(join(signals, basename(process.cwd())), "started");',
      'while (!(await access(release).then(() => true, () => false))) await new Promise((done) => setTimeout(done, 10));',
    ].join("\n"));
    const creation = value.lifecycle.createMany({
      pin,
      tasks: tasks(pin, ["long-a", "long-b"]),
      setupHooks: [{ executable: process.execPath, args: [script, signals, release], timeoutMs: 10_000 }],
    });
    await waitForEntries(signals, 2);
    const second = await WorktreeLifecycle.open({ repositoryRoot: value.repository });
    assert.deepEqual((await second.reconcile()).map(({ phase }) => phase), ["setting-up", "setting-up"]);
    await errorCode(second.cleanup("long-a"), "unsafe-cleanup");
    await writeFile(release, "release\n");
    await creation;
    await value.lifecycle.cleanup("long-a");
    await value.lifecycle.cleanup("long-b");
  } finally {
    await cleanupFixture(value);
  }
});

test("setup hook count is capped at sixteen", async () => {
  const value = await fixture("hook-cap");
  try {
    const pin = await value.lifecycle.pinCleanBase();
    const hook = { executable: process.execPath, args: ["--version"] };
    await errorCode(value.lifecycle.createMany({
      pin,
      tasks: tasks(pin, ["cap-a", "cap-b"]),
      setupHooks: Array.from({ length: 17 }, () => hook),
    }), "invalid-request");
    assert.equal((await value.lifecycle.reconcile()).length, 0);
  } finally {
    await cleanupFixture(value);
  }
});

for (const action of ["commit", "detach", "unlock"] as const) {
  test(`setup hook ${action} mutation fails closed and retains exact artifacts`, async () => {
    const value = await fixture(`hook-${action}`);
    try {
      const pin = await value.lifecycle.pinCleanBase();
      const script = join(value.root, "git-mutating-setup.mjs");
      await writeFile(script, [
        'import { execFileSync } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'const action = process.argv[2];',
        'if (action === "commit") {',
        '  writeFileSync("shared.txt", "hook commit\\n");',
        '  execFileSync("git", ["add", "shared.txt"]);',
        '  execFileSync("git", ["commit", "-q", "-m", "hook mutation"]);',
        '} else if (action === "detach") {',
        '  execFileSync("git", ["checkout", "--detach", "-q"]);',
        '} else {',
        '  execFileSync("git", ["worktree", "unlock", process.cwd()]);',
        '}',
      ].join("\n"));
      await errorCode(value.lifecycle.createMany({
        pin,
        tasks: tasks(pin, [`${action}-a`, `${action}-b`]),
        setupHooks: [{ executable: process.execPath, args: [script, action] }],
      }), "setup-failed");
      const records = await value.lifecycle.reconcile();
      assert.deepEqual(records.map(({ phase }) => phase), ["orphaned", "orphaned"]);
      for (const record of records) assert.equal((await stat(record.path)).isDirectory(), true);
      for (const id of [`${action}-a`, `${action}-b`]) {
        await errorCode(value.lifecycle.cleanup(id), "unsafe-cleanup");
      }
    } finally {
      await cleanupFixture(value);
    }
  });
}

test("setup timeout kills child and grandchild writers before artifacts become orphaned", async () => {
  const value = await fixture("timeout-tree");
  try {
    const pin = await value.lifecycle.pinCleanBase();
    const markers = join(value.root, "markers");
    const script = join(value.root, "process-tree.mjs");
    await mkdir(markers);
    await writeFile(script, [
      'import { spawn } from "node:child_process";',
      'import { appendFileSync } from "node:fs";',
      'import { basename, join } from "node:path";',
      'const [script, markers, role = "parent"] = process.argv.slice(1);',
      'const marker = join(markers, `${basename(process.cwd())}.txt`);',
      'if (role !== "grandchild") spawn(process.execPath, [script, markers, role === "parent" ? "child" : "grandchild"], { stdio: "ignore" });',
      'setInterval(() => appendFileSync(marker, `${role}\\n`), 15);',
    ].join("\n"));
    await errorCode(value.lifecycle.createMany({
      pin,
      tasks: tasks(pin, ["timeout-a", "timeout-b"]),
      setupHooks: [{ executable: process.execPath, args: [script, markers], timeoutMs: 180 }],
    }), "setup-failed");
    const paths = await readdir(markers);
    assert.equal(paths.length, 2);
    const sizes = await Promise.all(paths.map(async (name) => (await stat(join(markers, name))).size));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 350));
    assert.deepEqual(await Promise.all(paths.map(async (name) => (await stat(join(markers, name))).size)), sizes);
    assert.deepEqual((await value.lifecycle.reconcile()).map(({ phase }) => phase), ["orphaned", "orphaned"]);
  } finally {
    await cleanupFixture(value);
  }
});

test("restart adopts exact inventory and safely reconciles a missing clean artifact", async () => {
  const value = await fixture("restart");
  try {
    const pin = await value.lifecycle.pinCleanBase();
    const created = await value.lifecycle.createMany({ pin, tasks: tasks(pin, ["adopted", "missing"]) });
    let restarted = await WorktreeLifecycle.open({ repositoryRoot: value.repository });
    assert.deepEqual((await restarted.reconcile()).map(({ phase }) => phase), ["ready", "ready"]);

    await git(value.repository, "worktree", "unlock", created[1]!.path);
    await git(value.repository, "worktree", "remove", created[1]!.path);
    restarted = await WorktreeLifecycle.open({ repositoryRoot: value.repository });
    const records = await restarted.reconcile();
    assert.deepEqual(records.map(({ branch }) => branch), [created[0]!.branch]);
    await assert.rejects(git(value.repository, "rev-parse", "--verify", `refs/heads/${created[1]!.branch}`));
    await restarted.cleanup("adopted");
  } finally {
    await cleanupFixture(value);
  }
});

test("restart preserves dirty, diverged, and missing-diverged artifacts as orphaned", async () => {
  const value = await fixture("orphan");
  try {
    const pin = await value.lifecycle.pinCleanBase();
    const created = await value.lifecycle.createMany({ pin, tasks: tasks(pin, ["dirty-diverged", "missing-diverged"]) });
    await writeFile(join(created[0]!.path, "shared.txt"), "committed divergence\n");
    await git(created[0]!.path, "add", "shared.txt");
    await git(created[0]!.path, "commit", "-q", "-m", "diverge");

    await git(value.repository, "worktree", "unlock", created[1]!.path);
    await git(value.repository, "worktree", "remove", created[1]!.path);
    const tree = (await git(value.repository, "rev-parse", "HEAD^{tree}")).trim();
    const alternate = (await git(value.repository, "commit-tree", tree, "-p", pin.sha, "-m", "alternate")).trim();
    await git(value.repository, "update-ref", `refs/heads/${created[1]!.branch}`, alternate, pin.sha);

    const restarted = await WorktreeLifecycle.open({ repositoryRoot: value.repository });
    const records = await restarted.reconcile();
    assert.deepEqual(records.map(({ phase }) => phase), ["orphaned", "orphaned"]);
    assert.equal((await stat(created[0]!.path)).isDirectory(), true);
    assert.equal((await git(value.repository, "rev-parse", `refs/heads/${created[1]!.branch}`)).trim(), alternate);
  } finally {
    await cleanupFixture(value);
  }
});

test("preexisting same-SHA branches are rejected before inventory and are never deleted", async () => {
  const value = await fixture("preexisting-branch");
  try {
    const pin = await value.lifecycle.pinCleanBase();
    const requested = tasks(pin, ["existing", "control"]);
    await git(value.repository, "branch", requested[0]!.branch, pin.sha);
    await errorCode(value.lifecycle.createMany({ pin, tasks: requested }), "invalid-request");
    assert.equal((await git(value.repository, "rev-parse", `refs/heads/${requested[0]!.branch}`)).trim(), pin.sha);
    assert.equal((await value.lifecycle.reconcile()).length, 0);
  } finally {
    await cleanupFixture(value);
  }
});

test("a same-SHA branch raced immediately before add remains externally owned", async () => {
  const value = await fixture("branch-add-race");
  try {
    const pin = await value.lifecycle.pinCleanBase();
    const requested = tasks(pin, ["raced", "control"]);
    const privateLifecycle = value.lifecycle as unknown as {
      git(args: readonly string[], cwd?: string): Promise<string>;
    };
    const originalGit = privateLifecycle.git.bind(value.lifecycle);
    let injectedBranch: string | undefined;
    privateLifecycle.git = async (args, cwd) => {
      if (injectedBranch === undefined && args[0] === "worktree" && args[1] === "add" && args[2] === "-b") {
        injectedBranch = args[3]!;
        await git(value.repository, "branch", args[3]!, pin.sha);
      }
      return originalGit(args, cwd);
    };
    await errorCode(value.lifecycle.createMany({ pin, tasks: requested }), "git-failed");
    const inventory = JSON.parse(await readFile(inventoryPath(value), "utf8")) as {
      records: Array<{ branch: string; branchOwned: boolean; phase: string }>;
    };
    const raced = inventory.records.find(({ branch }) => branch === injectedBranch);
    assert.equal(raced?.branch, injectedBranch);
    assert.equal(raced?.branchOwned, false);
    assert.equal(raced?.phase, "orphaned");
    await value.lifecycle.reconcile();
    assert.equal((await git(value.repository, "rev-parse", `refs/heads/${injectedBranch}`)).trim(), pin.sha);
  } finally {
    await cleanupFixture(value);
  }
});

for (const phase of ["creating", "setting-up"] as const) {
  test(`restart preserves ${phase} crash inventory and its branch without cleanup`, async () => {
    const value = await fixture(`crash-${phase}`);
    try {
      const pin = await value.lifecycle.pinCleanBase();
      const created = await value.lifecycle.createMany({ pin, tasks: tasks(pin, [`${phase}-a`, `${phase}-b`]) });
      const inventory = JSON.parse(await readFile(inventoryPath(value), "utf8")) as {
        records: Array<{ phase: string; branchOwned: boolean }>;
      };
      inventory.records[0]!.phase = phase;
      if (phase === "creating") inventory.records[0]!.branchOwned = false;
      await writeFile(inventoryPath(value), JSON.stringify(inventory));
      const restarted = await WorktreeLifecycle.open({ repositoryRoot: value.repository });
      const records = await restarted.reconcile();
      assert.equal(records[0]!.phase, phase);
      assert.equal((await git(value.repository, "rev-parse", `refs/heads/${created[0]!.branch}`)).trim(), pin.sha);
      assert.equal((await stat(created[0]!.path)).isDirectory(), true);
    } finally {
      await cleanupFixture(value);
    }
  });
}

test("worktree root is lifecycle-derived and rejects every caller-selected external root", async () => {
  const value = await fixture("boundaries");
  try {
    await errorCode(WorktreeLifecycle.open({
      repositoryRoot: value.repository,
      worktreeRoot: join(value.root, "external"),
    }), "invalid-request");
    const exact = await WorktreeLifecycle.open({ repositoryRoot: value.repository, worktreeRoot: value.worktrees });
    assert.equal(exact.pathPrefixFor("same"), value.lifecycle.pathPrefixFor("same"));
  } finally {
    await cleanupFixture(value);
  }
});

test("branch cleanup uses compare-and-delete and preserves a concurrently changed ref", async () => {
  const value = await fixture("compare-delete");
  try {
    const pin = await value.lifecycle.pinCleanBase();
    const created = await value.lifecycle.createMany({ pin, tasks: tasks(pin, ["raced", "control"]) });
    const tree = (await git(value.repository, "rev-parse", "HEAD^{tree}")).trim();
    const alternate = (await git(value.repository, "commit-tree", tree, "-p", pin.sha, "-m", "alternate")).trim();
    const privateLifecycle = value.lifecycle as unknown as {
      git(args: readonly string[], cwd?: string): Promise<string>;
    };
    const originalGit = privateLifecycle.git.bind(value.lifecycle);
    let changed = false;
    privateLifecycle.git = async (args, cwd) => {
      const result = await originalGit(args, cwd);
      if (!changed && args[0] === "worktree" && args[1] === "remove") {
        changed = true;
        await git(value.repository, "update-ref", `refs/heads/${created[0]!.branch}`, alternate, pin.sha);
      }
      return result;
    };
    await errorCode(value.lifecycle.cleanup("raced"), "unsafe-cleanup");
    assert.equal((await git(value.repository, "rev-parse", `refs/heads/${created[0]!.branch}`)).trim(), alternate);
    assert.equal((await value.lifecycle.reconcile()).find(({ branch }) => branch === created[0]!.branch)?.phase, "orphaned");
    await value.lifecycle.cleanup("control");
  } finally {
    await cleanupFixture(value);
  }
});

test("base and branch requests fail closed and destructive Git is confined to owned cancellation", async () => {
  const value = await fixture("validation");
  try {
    const pin = await value.lifecycle.pinCleanBase();
    const invalid = tasks(pin, ["invalid-a", "invalid-b"]);
    invalid[0]!.branch = "-unsafe";
    await errorCode(value.lifecycle.createMany({ pin, tasks: invalid }), "invalid-request");

    await writeFile(join(value.repository, "next.txt"), "next\n");
    await git(value.repository, "add", "next.txt");
    await git(value.repository, "commit", "-q", "-m", "next");
    await errorCode(value.lifecycle.createMany({ pin, tasks: tasks(pin, ["stale-a", "stale-b"]) }), "stale-base");

    const source = await readFile(resolve("src/core/worktree-lifecycle.ts"), "utf8");
    const sourceFile = ts.createSourceFile("worktree-lifecycle.ts", source, ts.ScriptTarget.Latest, true,
      ts.ScriptKind.TS);
    const commands: Array<{ method: string | undefined; args: readonly ts.Expression[] }> = [];
    function visit(node: ts.Node, method?: string): void {
      const enclosingMethod = ts.isMethodDeclaration(node) && node.name !== undefined
        ? node.name.getText(sourceFile) : method;
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.kind === ts.SyntaxKind.ThisKeyword && node.expression.name.text === "git" &&
        node.arguments[0] !== undefined && ts.isArrayLiteralExpression(node.arguments[0])) {
        commands.push({ method: enclosingMethod, args: node.arguments[0].elements });
      }
      ts.forEachChild(node, (child) => visit(child, enclosingMethod));
    }
    visit(sourceFile);
    const text = (expression: ts.Expression | undefined): string | undefined => expression?.getText(sourceFile);
    const destructive = commands.filter(({ args }) => {
      const command = text(args[0]);
      return command === '"reset"' || command === '"clean"' || command === '"stash"' ||
        (command === '"worktree"' && ["\"prune\"", "\"remove\"", "\"add\""].includes(text(args[1]) ?? "") &&
          args.some((argument) => text(argument) === '"--force"')) ||
        (command === '"branch"' && text(args[1]) === '"-D"');
    });
    assert.deepEqual(destructive.map(({ method, args }) => [method, ...args.map((argument) => text(argument))]), [
      ["discardOwnedChanges", '"reset"', '"--hard"', "baseSha"],
      ["discardOwnedChanges", '"clean"', '"-fd"', '"--"', "...paths"],
    ]);
  } finally {
    await cleanupFixture(value);
  }
});

const exclusiveTestNames = new Set([
  "candidate base worktree leaves the authority checkout unchanged and supports one-unit acceptance",
  "direct-parent attestations are positive-only, instance-scoped, fully bound, and capped",
]);

nodeTest("worktree lifecycle registered tests", { concurrency: 4 }, async (context) => {
  assert.equal(registeredTests.length, 27);
  assert.equal(new Set(registeredTests.map(({ name }) => name)).size, 27);
  await mkdir(fixtureRoot, { recursive: true });
  const initialFixtureRoots = new Set(
    (await readdir(fixtureRoot)).filter((name) => name.startsWith("sortie-worktree-")),
  );

  const safeTests = registeredTests.filter(({ name }) => !exclusiveTestNames.has(name));
  const exclusiveTests = registeredTests.filter(({ name }) => exclusiveTestNames.has(name));
  assert.equal(safeTests.length, 25);
  assert.equal(exclusiveTests.length, 2);

  let activeSafe = 0;
  let maximumActiveSafe = 0;
  let exclusiveActive = false;
  let exclusiveOverlap = false;

  await Promise.all(safeTests.map(({ name, body }) => context.test(name, async (testContext) => {
    activeSafe += 1;
    maximumActiveSafe = Math.max(maximumActiveSafe, activeSafe);
    exclusiveOverlap ||= exclusiveActive;
    assert.equal(activeSafe <= 4, true);
    assert.equal(exclusiveActive, false);
    try {
      await body(testContext);
    } finally {
      activeSafe -= 1;
    }
  })));

  for (const { name, body } of exclusiveTests) {
    await context.test(name, async (testContext) => {
      exclusiveOverlap ||= activeSafe !== 0 || exclusiveActive;
      assert.equal(activeSafe, 0);
      assert.equal(exclusiveActive, false);
      exclusiveActive = true;
      try {
        await body(testContext);
      } finally {
        exclusiveActive = false;
      }
    });
  }

  const fixtureResiduals = (await readdir(fixtureRoot))
    .filter((name) => name.startsWith("sortie-worktree-") && !initialFixtureRoots.has(name));
  assert.equal(activeSafe, 0);
  assert.equal(maximumActiveSafe <= 4, true);
  assert.equal(exclusiveOverlap, false);
  assert.deepEqual(fixtureResiduals, []);
  context.diagnostic(
    `leafTests=26 maximumActiveSafe=${maximumActiveSafe} exclusiveOverlap=${exclusiveOverlap} fixtureResiduals=${fixtureResiduals.length}`,
  );
});
