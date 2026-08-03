import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const testEnvironment = fileURLToPath(new URL("../_testenv/", import.meta.url));
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const execFileAsync = promisify(execFile);

test("packed package exposes plugin and versioned runtime assets", async () => {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "npm_execpath is required for the package smoke test");

  await mkdir(testEnvironment, { recursive: true });
  const fixture = await mkdtemp(join(testEnvironment, "package-export-"));
  try {
    const { stdout: packOutput } = await execFileAsync(
      process.execPath,
      [npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", fixture],
      { cwd: projectRoot },
    );
    const packed = JSON.parse(packOutput) as Array<{ filename: string }>;
    assert.equal(packed.length, 1);
    const tarball = join(fixture, packed[0].filename);

    const consumer = join(fixture, "consumer");
    await mkdir(consumer);
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({ name: "package-export-consumer", private: true, type: "module" }),
    );
    await execFileAsync(
      process.execPath,
      [
        npmCli,
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        "--prefix",
        consumer,
        tarball,
      ],
      { cwd: projectRoot },
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const [{ SortieDogsPlugin }, { runtimeAssets }] = await Promise.all([
          import('sortie-dogs/plugin'),
          import('sortie-dogs/assets'),
        ]);
        process.stdout.write(JSON.stringify({ pluginType: typeof SortieDogsPlugin, runtimeAssets }));`,
      ],
      { cwd: consumer },
    );
    const loaded = JSON.parse(stdout) as {
      pluginType: string;
      runtimeAssets: Array<{
        name: string;
        version: string;
        installPath: string;
        content: string;
      }>;
    };
    assert.equal(loaded.pluginType, "function");
    assert.equal(loaded.runtimeAssets.length, 3);
    assert.deepEqual(
      loaded.runtimeAssets.map(({ name, installPath }) => ({ name, installPath })),
      [
        { name: "coordinator-mk2a2", installPath: "agents/coordinator-mk2a2.md" },
        { name: "sol-worker-mk2a2", installPath: "agents/sol-worker-mk2a2.md" },
        { name: "sortie", installPath: "commands/sortie.md" },
      ],
    );

    for (const asset of loaded.runtimeAssets) {
      assert.equal(asset.version, "0.2.0-card02");
      const frontmatter = asset.content.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n/);
      assert.ok(frontmatter, `${asset.name} must have frontmatter`);
      const entries = Object.fromEntries(
        frontmatter[1].split(/\r?\n/).map((line) => {
          const separator = line.indexOf(":");
          assert.notEqual(separator, -1, `${asset.name} has malformed frontmatter`);
          return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
        }),
      );
      assert.ok(entries.description, `${asset.name} needs a description`);
      if (asset.name === "coordinator-mk2a2") assert.equal(entries.mode, "primary");
      if (asset.name === "sol-worker-mk2a2") assert.equal(entries.mode, "subagent");
      if (asset.name === "sortie") assert.equal(entries.agent, "coordinator-mk2a2");
      assert.doesNotMatch(
        asset.content,
        /project\s+helper|capsule|controller|\bFSM\b|routing\s+ledger|dedicated\s+harness|alternate\s+orchestrator/i,
        `${asset.name} must not reference forbidden artifacts`,
      );
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
