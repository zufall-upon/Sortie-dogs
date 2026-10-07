import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { CODEX_SKILL_ASSET_VERSION } from "../src/asset-version.ts";
import { codexSkillAssets } from "../src/codex/skill-assets.ts";
import { initializeCodexSkill, ProjectInitializationError } from "../src/core/initialize.ts";

const TEST_ROOT = join(process.cwd(), "_testenv");
const ENTRY = join(process.cwd(), "src", "cli", "main.ts");
const SKILL_ROOT = join(".agents", "skills", "sortie-dogs");
const execFileAsync = promisify(execFile);

async function fixtureDirectory(): Promise<string> {
  await mkdir(TEST_ROOT, { recursive: true });
  return mkdtemp(join(TEST_ROOT, "codex-skill-"));
}

async function clean(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
  await rm(TEST_ROOT).catch(() => undefined);
}

test("Codex skill init is isolated from OpenCode and idempotent", async () => {
  const project = await fixtureDirectory();
  try {
    const openCodeConfig = join(project, ".opencode", "opencode.json");
    await mkdir(join(project, ".opencode"));
    await writeFile(openCodeConfig, "{\"userSetting\":true}\n");
    const openCodeBefore = await stat(openCodeConfig);

    const installed = await initializeCodexSkill(project);

    assert.equal(installed.status, "installed");
    assert.equal(installed.version, CODEX_SKILL_ASSET_VERSION);
    for (const asset of codexSkillAssets) {
      assert.equal(await readFile(join(project, SKILL_ROOT, asset.installPath), "utf8"), asset.content);
    }
    assert.equal(
      await readFile(join(project, SKILL_ROOT, "sortie-dogs.version"), "utf8"),
      `${CODEX_SKILL_ASSET_VERSION}\n`,
    );
    assert.equal(await readFile(openCodeConfig, "utf8"), "{\"userSetting\":true}\n");
    assert.equal((await stat(openCodeConfig)).mtimeMs, openCodeBefore.mtimeMs);
    assert.equal(await lstat(join(project, ".opencode", ".gitignore")).then(() => true, () => false), false);

    const paths = [
      ...codexSkillAssets.map(({ installPath }) => join(project, SKILL_ROOT, installPath)),
      join(project, SKILL_ROOT, "sortie-dogs.version"),
    ];
    const before = await Promise.all(paths.map(async path => ({
      content: await readFile(path, "utf8"),
      mtimeMs: (await stat(path)).mtimeMs,
    })));
    assert.equal((await initializeCodexSkill(project)).status, "unchanged");
    assert.deepEqual(await Promise.all(paths.map(async path => ({
      content: await readFile(path, "utf8"),
      mtimeMs: (await stat(path)).mtimeMs,
    }))), before);
  } finally {
    await clean(project);
  }
});

test("Codex skill init refuses files with unknown ownership", async () => {
  const project = await fixtureDirectory();
  const skillFile = join(project, SKILL_ROOT, "SKILL.md");
  try {
    await mkdir(join(project, SKILL_ROOT), { recursive: true });
    await writeFile(skillFile, "user-owned skill\n");

    await assert.rejects(initializeCodexSkill(project), (error: unknown) => {
      assert.ok(error instanceof ProjectInitializationError);
      assert.equal(error.code, "conflict");
      return true;
    });
    assert.equal(await readFile(skillFile, "utf8"), "user-owned skill\n");
    assert.equal(
      await lstat(join(project, SKILL_ROOT, "sortie-dogs.version")).then(() => true, () => false),
      false,
    );
  } finally {
    await clean(project);
  }
});

test("Codex skill CLI installs explicitly and validates arguments", async () => {
  const project = await fixtureDirectory();
  try {
    const run = async (args: readonly string[]) => execFileAsync(
      process.execPath,
      // Node 22.6-22.17 warns for type stripping; test CLI output, not the host's feature banner.
      ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", ENTRY, ...args],
      { cwd: process.cwd() },
    );

    const help = await run(["codex", "init", "--help"]);
    assert.equal(help.stderr, "");
    assert.match(help.stdout, /^Usage: sortie-dogs codex init \[project-root\]/u);

    const first = await run(["codex", "init", project]);
    assert.equal(first.stderr, "");
    assert.equal(first.stdout, `Installed the $sortie-dogs Codex skill (${CODEX_SKILL_ASSET_VERSION}).\n`);
    const second = await run(["codex", "init", project]);
    assert.equal(second.stderr, "");
    assert.equal(second.stdout, `The $sortie-dogs Codex skill (${CODEX_SKILL_ASSET_VERSION}) is already installed.\n`);

    await assert.rejects(run(["codex", "init", "--unknown"]), (error: unknown) => {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      assert.equal(failure.code, 2);
      assert.equal(failure.stdout, "");
      assert.match(failure.stderr ?? "", /^Usage: sortie-dogs codex init/u);
      return true;
    });
  } finally {
    await clean(project);
  }
});
