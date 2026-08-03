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

test("fresh init installs every runtime asset and preserves project settings", async () => {
  const project = await fixtureDirectory();
  try {
    const config = join(project, ".opencode", "sortie-dogs.json");
    await mkdir(join(project, ".opencode"));
    await writeFile(config, "{\"userSetting\":true}\n");

    const result = await initializeProject(project);

    assert.equal(result.status, "installed");
    assert.equal(result.version, "0.2.0-card02");
    for (const asset of runtimeAssets) {
      assert.equal(await readFile(join(project, ".opencode", asset.installPath), "utf8"), asset.content);
    }
    assert.equal(await readFile(join(project, MARKER), "utf8"), "0.2.0-card02\n");
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
    await mkdir(join(project, ".opencode", "agents"), { recursive: true });
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

test("symlinked install paths fail before writing runtime files", async (context) => {
  const project = await fixtureDirectory();
  const outside = await fixtureDirectory();
  try {
    await mkdir(join(project, ".opencode"));
    try {
      await symlink(outside, join(project, ".opencode", "agents"), "dir");
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
    assert.deepEqual(await rm(join(outside, "coordinator-mk2a2.md")).then(() => true, () => false), false);
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
      stdout: "Initialized Sortie-dogs 0.2.0-card02.\n",
      stderr: "",
    });
    assert.deepEqual(await runCli(["init", project]), {
      exit: 0,
      stdout: "Sortie-dogs 0.2.0-card02 is already initialized.\n",
      stderr: "",
    });
  } finally {
    await clean(project);
  }
});
