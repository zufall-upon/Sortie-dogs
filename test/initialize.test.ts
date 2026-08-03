import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  initializeProject,
  ProjectInitializationError,
} from "../src/core/initialize.ts";
import { runtimeAssets } from "../src/runtime-assets.ts";

const TEST_ROOT = join(process.cwd(), "_testenv");
const ENTRY = join(process.cwd(), "src", "cli", "main.ts");
const MARKER = join(".opencode", "sortie-dogs.version");
const LEGACY_WORKER_PATH = join(".opencode", "agent", "sol-worker-mk2a2.md");
const LEGACY_WORKER_CONTENT = `---
description: Dedicated Sol worker for the canonical Mk2A2 coordinator
mode: subagent
---
# sol-worker-mk2a2

You are the dedicated Sol worker for coordinator-mk2a2.

Execute the supplied manifest within its acceptance criteria, run the requested
validation, and return concise change and validation evidence to coordinator-mk2a2.
Do not act as the user-facing coordinator.
`;

async function fixtureDirectory(): Promise<string> {
  await mkdir(TEST_ROOT, { recursive: true });
  return mkdtemp(join(TEST_ROOT, "initialize-"));
}

async function clean(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
  await rm(TEST_ROOT).catch(() => undefined);
}

async function snapshot(paths: readonly string[]): Promise<Array<{ content: string; mtimeMs: number }>> {
  return Promise.all(paths.map(async (path) => ({
    content: await readFile(path, "utf8"),
    mtimeMs: (await stat(path)).mtimeMs,
  })));
}

async function snapshotDirectories(paths: readonly string[]): Promise<Array<{ mtimeMs: number }>> {
  return Promise.all(paths.map(async (path) => ({ mtimeMs: (await stat(path)).mtimeMs })));
}

test("fresh init installs every runtime asset and preserves project settings", async () => {
  const project = await fixtureDirectory();
  try {
    const config = join(project, ".opencode", "sortie-dogs.json");
    await mkdir(join(project, ".opencode"));
    await writeFile(config, "{\"userSetting\":true}\n");

    const result = await initializeProject(project);

    assert.equal(result.status, "installed");
    assert.equal(result.version, "0.2.0-card05");
    for (const asset of runtimeAssets) {
      assert.equal(await readFile(join(project, ".opencode", asset.installPath), "utf8"), asset.content);
    }
    assert.equal(await readFile(join(project, MARKER), "utf8"), "0.2.0-card05\n");
    assert.equal(await readFile(config, "utf8"), "{\"userSetting\":true}\n");
  } finally {
    await clean(project);
  }
});

test("second init is a no-op without rewrites", async () => {
  const project = await fixtureDirectory();
  try {
    await initializeProject(project);
    const paths = [
      ...runtimeAssets.map(({ installPath }) => join(project, ".opencode", installPath)),
      join(project, MARKER),
    ];
    const before = await snapshot(paths);
    const result = await initializeProject(project);

    assert.equal(result.status, "unchanged");
    assert.deepEqual(await snapshot(paths), before);
  } finally {
    await clean(project);
  }
});

test("conflicts fail closed and leave existing content untouched", async () => {
  const project = await fixtureDirectory();
  try {
    const conflict = join(project, ".opencode", runtimeAssets[0].installPath);
    await mkdir(join(project, ".opencode", "agent"), { recursive: true });
    await writeFile(conflict, "user-owned\n");

    await assert.rejects(initializeProject(project), (error: unknown) => {
      assert.ok(error instanceof ProjectInitializationError);
      assert.equal(error.code, "conflict");
      return true;
    });
    assert.equal(await readFile(conflict, "utf8"), "user-owned\n");
    assert.equal(await lstat(join(project, MARKER)).then(() => true, () => false), false);
    assert.equal(await lstat(join(project, ".opencode", runtimeAssets[1].installPath)).then(() => true, () => false), false);
  } finally {
    await clean(project);
  }
});

test("compatible update replaces owned drift, preserves user files, then becomes unchanged", async () => {
  const project = await fixtureDirectory();
  try {
    await initializeProject(project);
    const marker = join(project, MARKER);
    const ownedAsset = join(project, ".opencode", runtimeAssets[0].installPath);
    const userFile = join(project, ".opencode", "sortie-dogs.json");
    await writeFile(marker, (await readFile(marker, "utf8")).replace("0.2.0-card05", "0.2.0-card03"));
    await writeFile(ownedAsset, "old RPT-owned content\n");
    await writeFile(userFile, "{\"userOwned\":true}\n");

    const updated = await initializeProject(project);

    assert.equal(updated.status, "installed");
    assert.equal(await readFile(ownedAsset, "utf8"), runtimeAssets[0].content);
    assert.equal(await readFile(userFile, "utf8"), "{\"userOwned\":true}\n");
    const paths = [
      ...runtimeAssets.map(({ installPath }) => join(project, ".opencode", installPath)),
      marker,
      userFile,
    ];
    const afterUpdate = await snapshot(paths);
    assert.equal((await initializeProject(project)).status, "unchanged");
    assert.deepEqual(await snapshot(paths), afterUpdate);
  } finally {
    await clean(project);
  }
});

test("rename migration removes a byte-matched owned legacy file", async () => {
  const project = await fixtureDirectory();
  try {
    const legacyWorker = join(project, LEGACY_WORKER_PATH);
    await mkdir(join(project, ".opencode", "agent"), { recursive: true });
    await writeFile(join(project, MARKER), "0.2.0-card04\n");
    await writeFile(legacyWorker, LEGACY_WORKER_CONTENT);

    const result = await initializeProject(project);

    assert.equal(result.status, "installed");
    assert.deepEqual(result.preservedLegacyPaths, []);
    assert.equal(await lstat(legacyWorker).then(() => true, () => false), false);
    assert.equal(await readFile(join(project, MARKER), "utf8"), "0.2.0-card05\n");
  } finally {
    await clean(project);
  }
});

test("rename migration preserves and reports a user-edited legacy file", async () => {
  const project = await fixtureDirectory();
  try {
    const legacyWorker = join(project, LEGACY_WORKER_PATH);
    const edited = `${LEGACY_WORKER_CONTENT}\nUser edit.\n`;
    await mkdir(join(project, ".opencode", "agent"), { recursive: true });
    await writeFile(join(project, MARKER), "0.2.0-card04\n");
    await writeFile(legacyWorker, edited);

    const result = await initializeProject(project);

    assert.deepEqual(result.preservedLegacyPaths, [".opencode/agent/sol-worker-mk2a2.md"]);
    assert.equal(await readFile(legacyWorker, "utf8"), edited);
  } finally {
    await clean(project);
  }
});

test("a recognized current-version marker repairs a partial install and then becomes unchanged", async () => {
  const project = await fixtureDirectory();
  try {
    const firstAsset = runtimeAssets[0];
    await mkdir(join(project, ".opencode", "agent"), { recursive: true });
    await writeFile(join(project, MARKER), "0.2.0-card05\n");
    await writeFile(join(project, ".opencode", firstAsset.installPath), firstAsset.content);

    const repaired = await initializeProject(project);

    assert.equal(repaired.status, "installed");
    for (const asset of runtimeAssets) {
      assert.equal(await readFile(join(project, ".opencode", asset.installPath), "utf8"), asset.content);
    }
    assert.equal((await initializeProject(project)).status, "unchanged");
  } finally {
    await clean(project);
  }
});

test("an out-of-line update is rejected before any mutation", async () => {
  const project = await fixtureDirectory();
  try {
    const openCode = join(project, ".opencode");
    await mkdir(openCode);
    const marker = join(project, MARKER);
    const userFile = join(openCode, "sortie-dogs.json");
    await writeFile(marker, "0.3.0\n");
    await writeFile(userFile, "{\"future\":true}\n");
    const filesBefore = await snapshot([marker, userFile]);
    const directoriesBefore = await snapshotDirectories([project, openCode]);

    await assert.rejects(initializeProject(project), (error: unknown) => {
      assert.ok(error instanceof ProjectInitializationError);
      assert.equal(error.code, "incompatible-version");
      return true;
    });
    assert.deepEqual(await snapshot([marker, userFile]), filesBefore);
    assert.deepEqual(await snapshotDirectories([project, openCode]), directoriesBefore);
    for (const asset of runtimeAssets) {
      assert.equal(await lstat(join(openCode, asset.installPath)).then(() => true, () => false), false);
    }
  } finally {
    await clean(project);
  }
});

test("a future version in the recognized compatibility line is rejected", async () => {
  const project = await fixtureDirectory();
  try {
    await mkdir(join(project, ".opencode"));
    await writeFile(join(project, MARKER), "0.2.0-card99\n");

    await assert.rejects(initializeProject(project), (error: unknown) => {
      assert.ok(error instanceof ProjectInitializationError);
      assert.equal(error.code, "incompatible-version");
      return true;
    });
  } finally {
    await clean(project);
  }
});

test("an invalid marker keeps unknown-ownership conflict behavior", async () => {
  const project = await fixtureDirectory();
  try {
    await initializeProject(project);
    const marker = join(project, MARKER);
    const unknownAsset = join(project, ".opencode", runtimeAssets[0].installPath);
    await writeFile(marker, "not-a-version\n");
    await writeFile(unknownAsset, "unknown owner\n");

    await assert.rejects(initializeProject(project), (error: unknown) => {
      assert.ok(error instanceof ProjectInitializationError);
      assert.equal(error.code, "conflict");
      return true;
    });
    assert.equal(await readFile(unknownAsset, "utf8"), "unknown owner\n");
    assert.equal(await readFile(marker, "utf8"), "not-a-version\n");
  } finally {
    await clean(project);
  }
});

test("symlinked install paths fail before writing runtime files", async (context) => {
  const project = await fixtureDirectory();
  const outside = await fixtureDirectory();
  try {
    await mkdir(join(project, ".opencode"));
    try {
      await symlink(outside, join(project, ".opencode", "agent"), "dir");
    } catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip("Directory symlinks are unavailable in this environment.");
        return;
      }
      throw error;
    }

    await assert.rejects(initializeProject(project), (error: unknown) => {
      assert.ok(error instanceof ProjectInitializationError);
      assert.equal(error.code, "unsafe-path");
      return true;
    });
    assert.deepEqual(await rm(join(outside, "dog-coordinator.md")).then(() => true, () => false), false);
  } finally {
    await clean(project);
    await clean(outside);
  }
});

test("owned drift cannot overwrite through a file symlink", async (context) => {
  const project = await fixtureDirectory();
  const outside = await fixtureDirectory();
  try {
    await initializeProject(project);
    const asset = join(project, ".opencode", runtimeAssets[0].installPath);
    const outsideFile = join(outside, "user-owned.txt");
    await writeFile(outsideFile, "outside remains unchanged\n");
    await rm(asset);
    try {
      await symlink(outsideFile, asset, "file");
    } catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip("File symlinks are unavailable in this environment.");
        return;
      }
      throw error;
    }

    await assert.rejects(initializeProject(project), (error: unknown) => {
      assert.ok(error instanceof ProjectInitializationError);
      assert.equal(error.code, "unsafe-path");
      return true;
    });
    assert.equal(await readFile(outsideFile, "utf8"), "outside remains unchanged\n");
  } finally {
    await clean(project);
    await clean(outside);
  }
});

interface CliResult { exit: number | null; stdout: string; stderr: string }

async function runCli(args: readonly string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", ENTRY, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (exit) => resolve({ exit, stdout, stderr }));
  });
}

test("CLI init supports an explicit project root, repeated init, and help", async () => {
  const project = await fixtureDirectory();
  try {
    assert.deepEqual(await runCli(["init", "--help"]), {
      exit: 0,
      stdout: "Usage: sortie-dogs init [project-root]\n",
      stderr: "",
    });
    assert.deepEqual(await runCli(["init", project]), {
      exit: 0,
      stdout: "Initialized Sortie-dogs 0.2.0-card05.\n",
      stderr: "",
    });
    assert.deepEqual(await runCli(["init", project]), {
      exit: 0,
      stdout: "Sortie-dogs 0.2.0-card05 is already initialized.\n",
      stderr: "",
    });
  } finally {
    await clean(project);
  }
});
