import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  initializeGlobal,
  initializeProject,
  ProjectInitializationError,
  resolveGlobalConfigRoot,
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
    assert.equal(result.version, "0.3.33-readable-terminal-report-v1");
    for (const asset of runtimeAssets) {
      assert.equal(await readFile(join(project, ".opencode", asset.installPath), "utf8"), asset.content);
    }
    assert.equal(await readFile(join(project, MARKER), "utf8"), "0.3.33-readable-terminal-report-v1\n");
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
    await writeFile(marker, (await readFile(marker, "utf8")).replace("0.3.33-readable-terminal-report-v1", "0.2.19-card20"));
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
    assert.equal(await readFile(join(project, MARKER), "utf8"), "0.3.33-readable-terminal-report-v1\n");
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
    await writeFile(join(project, MARKER), "0.3.33-readable-terminal-report-v1\n");
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
    await writeFile(marker, "0.4.0\n");
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

test("package 0.3.3 runtime card26 migrates to package 0.3.19 runtime card41", async () => {
  const project = await fixtureDirectory();
  try {
    await initializeProject(project);
    const marker = join(project, MARKER);
    const ownedAsset = join(project, ".opencode", runtimeAssets[0].installPath);
    await writeFile(marker, "0.3.3-card26\n");
    await writeFile(ownedAsset, "card26 content\n");
    const updated = await initializeProject(project);
    assert.equal(updated.status, "installed");
    assert.equal(await readFile(marker, "utf8"), "0.3.33-readable-terminal-report-v1\n");
    assert.equal(await readFile(ownedAsset, "utf8"), runtimeAssets[0].content);
  } finally {
    await clean(project);
  }
});

test("a skipped pre-1.0 minor transition remains incompatible", async () => {
  const project = await fixtureDirectory();
  try {
    await mkdir(join(project, ".opencode"));
    const marker = join(project, MARKER);
    await writeFile(marker, "0.1.19-card20\n");
    await assert.rejects(initializeProject(project), (error: unknown) => {
      assert.ok(error instanceof ProjectInitializationError);
      assert.equal(error.code, "incompatible-version");
      return true;
    });
    assert.equal(await readFile(marker, "utf8"), "0.1.19-card20\n");
  } finally {
    await clean(project);
  }
});

test("a future version in the recognized compatibility line is rejected", async () => {
  const project = await fixtureDirectory();
  try {
    await mkdir(join(project, ".opencode"));
    await writeFile(join(project, MARKER), "0.3.34-card99\n");

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

async function runCli(args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", ENTRY, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_NO_WARNINGS: "1", ...env },
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
      stdout: "Usage: sortie-dogs init [project-root]\n       sortie-dogs init --global\n",
      stderr: "",
    });
    assert.deepEqual(await runCli(["init", project]), {
      exit: 0,
      stdout: "Initialized Sortie-dogs 0.3.33-readable-terminal-report-v1.\n",
      stderr: "",
    });
    assert.deepEqual(await runCli(["init", project]), {
      exit: 0,
      stdout: "Sortie-dogs 0.3.33-readable-terminal-report-v1 is already initialized.\n",
      stderr: "",
    });
  } finally {
    await clean(project);
  }
});

test("global root resolver honors OpenCode and XDG precedence", async () => {
  const fixture = await fixtureDirectory();
  try {
    const configDirectory = join(fixture, "configured-directory");
    await mkdir(configDirectory);
    assert.equal(await resolveGlobalConfigRoot({
      OPENCODE_CONFIG_DIR: join(fixture, "explicit"),
      OPENCODE_CONFIG: join(fixture, "opencode.json"),
      XDG_CONFIG_HOME: join(fixture, "xdg"),
    }, join(fixture, "home")), join(fixture, "explicit"));
    assert.equal(await resolveGlobalConfigRoot({ OPENCODE_CONFIG: configDirectory }, fixture), configDirectory);
    assert.equal(
      await resolveGlobalConfigRoot({ OPENCODE_CONFIG: join(fixture, "settings.json") }, fixture),
      fixture,
    );
    assert.equal(
      await resolveGlobalConfigRoot({ XDG_CONFIG_HOME: join(fixture, "xdg") }, join(fixture, "home")),
      join(fixture, "xdg", "opencode"),
    );
    assert.equal(await resolveGlobalConfigRoot({}, join(fixture, "home")), join(fixture, "home", ".config", "opencode"));
  } finally {
    await clean(fixture);
  }
});

test("symlinked global config directories resolve and install at the real target", async (context) => {
  const fixture = await fixtureDirectory();
  try {
    const actual = join(fixture, "actual-config");
    const linked = join(fixture, "linked-config");
    await mkdir(actual);
    try {
      await symlink(actual, linked, "dir");
    } catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip("Directory symlinks are unavailable in this environment.");
        return;
      }
      throw error;
    }

    assert.equal(await resolveGlobalConfigRoot({ OPENCODE_CONFIG: linked }, fixture), await realpath(actual));
    assert.equal((await initializeGlobal(linked)).status, "installed");
    for (const asset of runtimeAssets) {
      assert.equal(await readFile(join(actual, asset.installPath), "utf8"), asset.content);
    }
    assert.equal(await lstat(join(fixture, "sortie-dogs.version")).then(() => true, () => false), false);
  } finally {
    await clean(fixture);
  }
});

test("project init retains its invalid-root error contract", async () => {
  const fixture = await fixtureDirectory();
  try {
    await assert.rejects(initializeProject(join(fixture, "missing")), (error: unknown) => {
      assert.ok(error instanceof ProjectInitializationError);
      assert.equal(error.code, "invalid-project");
      assert.equal(error.message, "Project root must be an existing non-symlink directory.");
      return true;
    });
  } finally {
    await clean(fixture);
  }
});

test("global init installs directly in the config root and is idempotent", async () => {
  const fixture = await fixtureDirectory();
  const globalRoot = join(fixture, "global", "opencode");
  try {
    const installed = await initializeGlobal(globalRoot);
    assert.equal(installed.status, "installed");
    for (const asset of runtimeAssets) {
      assert.equal(await readFile(join(globalRoot, asset.installPath), "utf8"), asset.content);
    }
    const paths = [
      ...runtimeAssets.map(({ installPath }) => join(globalRoot, installPath)),
      join(globalRoot, "sortie-dogs.version"),
    ];
    const before = await snapshot(paths);
    assert.equal((await initializeGlobal(globalRoot)).status, "unchanged");
    assert.deepEqual(await snapshot(paths), before);
    assert.equal(await lstat(join(globalRoot, ".opencode")).then(() => true, () => false), false);
  } finally {
    await clean(fixture);
  }
});

test("global init preserves and reports legacy runtime files", async () => {
  const globalRoot = await fixtureDirectory();
  try {
    const legacyCoordinator = join(globalRoot, "agent", "coordinator-mk2a2.md");
    const legacyWorker = join(globalRoot, "agent", "sol-worker-mk2a2.md");
    await mkdir(join(globalRoot, "agent"));
    await writeFile(legacyCoordinator, "user coordinator\n");
    await writeFile(legacyWorker, LEGACY_WORKER_CONTENT);

    const result = await initializeGlobal(globalRoot);
    assert.deepEqual(result.preservedLegacyPaths, [
      "agent/coordinator-mk2a2.md",
      "agent/sol-worker-mk2a2.md",
    ]);
    assert.equal(await readFile(legacyCoordinator, "utf8"), "user coordinator\n");
    assert.equal(await readFile(legacyWorker, "utf8"), LEGACY_WORKER_CONTENT);
    assert.deepEqual((await initializeGlobal(globalRoot)).preservedLegacyPaths, result.preservedLegacyPaths);
  } finally {
    await clean(globalRoot);
  }
});

test("CLI global init reports its target, legacy preservation, and invalid combinations", async () => {
  const fixture = await fixtureDirectory();
  const globalRoot = join(fixture, "config");
  try {
    await mkdir(join(globalRoot, "agent"), { recursive: true });
    await writeFile(join(globalRoot, "agent", "coordinator-mk2a2.md"), "legacy\n");
    const env = { OPENCODE_CONFIG_DIR: globalRoot };
    assert.deepEqual(await runCli(["init", "--global"], env), {
      exit: 0,
      stdout: `Initialized Sortie-dogs 0.3.33-readable-terminal-report-v1 globally at ${globalRoot}.\n` +
        "Preserved legacy runtime files: agent/coordinator-mk2a2.md.\n",
      stderr: "",
    });
    assert.deepEqual(await runCli(["init", "--global"], env), {
      exit: 0,
      stdout: `Sortie-dogs 0.3.33-readable-terminal-report-v1 is already initialized globally at ${globalRoot}.\n` +
        "Preserved legacy runtime files: agent/coordinator-mk2a2.md.\n",
      stderr: "",
    });
    for (const args of [["init", "--global", fixture], ["init", fixture, "--global"]]) {
      const result = await runCli(args, env);
      assert.equal(result.exit, 2);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "Usage: sortie-dogs init [project-root]\n       sortie-dogs init --global\n");
    }
  } finally {
    await clean(fixture);
  }
});

test("failed global init unwinds every config-root directory it created", async () => {
  const fixture = await fixtureDirectory();
  const parent = join(fixture, "rollback-root");
  const globalRoot = join(parent, "nested", "opencode");
  const mutableAssets = runtimeAssets as unknown as Array<{
    installPath: string;
    content: string;
    version: string;
  }>;
  mutableAssets.push({
    installPath: "agent",
    content: "forced test conflict\n",
    version: runtimeAssets[0].version,
  });
  try {
    await assert.rejects(initializeGlobal(globalRoot), (error: unknown) => {
      assert.ok(error instanceof ProjectInitializationError);
      assert.equal(error.code, "conflict");
      return true;
    });
    assert.equal(await lstat(parent).then(() => true, () => false), false);
  } finally {
    mutableAssets.pop();
    await clean(fixture);
  }
});
