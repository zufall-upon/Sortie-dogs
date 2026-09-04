import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  cleanRepresentativeRuntime,
  fixtureSourceSha256,
  prepareRepresentativeRuntime,
} from "./fixtures/representative-medium/run-representative-rpt.mjs";

const repositoryRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const fixtureRoot = join(repositoryRoot, "test", "fixtures", "representative-medium");
const runtimeRoot = join(repositoryRoot, "_testenv", "representative-benchmark-test");
const packagePath = join(repositoryRoot, "package.json");

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function run(executable: string, args: readonly string[], cwd = repositoryRoot): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    execFile(executable, args, { cwd, encoding: "utf8", shell: false, windowsHide: true },
      (error, stdout, stderr) => error === null ? resolvePromise(stdout) : reject(new Error(stderr || error.message)));
  });
}

async function trackedText(): Promise<string> {
  const paths: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) paths.push(path);
    }
  }
  await visit(fixtureRoot);
  return (await Promise.all(paths.map(async (path) =>
    `${relative(fixtureRoot, path).split(sep).join("/")}\0${await readFile(path, "utf8")}`))).join("\0");
}

test("recreates the representative benchmark from tracked source", { timeout: 30_000 }, async () => {
  await cleanRepresentativeRuntime(runtimeRoot);
  const sourceBefore = await fixtureSourceSha256();
  const trackedBefore = await trackedText();
  const first = await prepareRepresentativeRuntime({ runtimeRoot, packagePath });
  try {
    assert.equal(first.units.length, 5);
    assert.equal(first.routes["sol-serial"].implementation_child_count, 1);
    assert.equal(first.routes["luna-fabric"].implementation_child_count, 5);
    assert.equal(first.routes["luna-fabric"].width, 5);
    assert.deepEqual(first.timeouts_ms, { route: 300000, host_margin: 60000, host_task_cap: 360000 });
    assert.match(first.target_sha, /^[a-f0-9]{40}$/u);
    assert.equal(first.fixture_source_sha256, sourceBefore);
    assert.equal(first.opencode_config_dir, join(runtimeRoot, "opencode-config"));
    assert.equal(first.xdg_config_home, join(runtimeRoot, "xdg-config"));
    assert.deepEqual(JSON.parse(await readFile(join(first.opencode_config_dir, "opencode.json"), "utf8")), {
      $schema: "https://opencode.ai/config.json",
      mcp: {},
      compaction: { auto: true, prune: true },
    });
    assert.deepEqual(JSON.parse(await readFile(join(first.xdg_config_home, "opencode", "package.json"), "utf8")), {
      dependencies: { "@opencode-ai/plugin": "1.18.11" },
    });
    assert.equal(await readFile(join(first.project_root, ".opencode", "plugins", "sortie-dogs.ts"), "utf8"),
      'export { SortieDogsPlugin } from "sortie-dogs/plugin";\n');
    assert.deepEqual(JSON.parse(await readFile(join(first.project_root, ".opencode", "package.json"), "utf8")), {
      private: true,
      type: "module",
      dependencies: {
        "@opencode-ai/plugin": "1.18.11",
        "sortie-dogs": "file:../../package.json",
      },
    });
    assert.equal(createHash("sha256").update(await readFile(join(runtimeRoot, "package.json"))).digest("hex"),
      first.package.sha256);
    assert.equal(first.package.sha256, createHash("sha256").update(await readFile(packagePath)).digest("hex"));
    assert.equal(new Set(first.expected_writes).size, 5);
    assert.deepEqual(first.result_contract, {
      exact_keys: [
        "accepted_candidate_sha", "accepted_cas_violations", "cleanup", "expected_outputs", "fixture_id",
        "fixture_source_sha256", "implementation_child_count", "package_sha256", "route", "scope_corruption",
        "sol_demotion_count", "target_integrity", "target_sha_after", "target_sha_before",
        "validation_candidate_sha",
      ],
      cleanup: { status: "complete", remaining_paths: [] },
      expected_outputs: first.expected_writes.map((path) => ({ path, exists: true })),
    });

    const contract = JSON.parse(await readFile(join(runtimeRoot, "luna-fabric.json"), "utf8"));
    assert.deepEqual(Object.keys(contract).sort(),
      ["acceptance_items", "effects", "provenance", "shared_paths", "units", "version"].sort());
    assert.equal(contract.provenance.target_sha, first.target_sha);
    assert.equal(contract.provenance.target_branch, "benchmark-medium");
    assert.equal(contract.units.length, 5);
    assert.equal(new Set(contract.units.flatMap((unit: { acceptance_items: string[] }) => unit.acceptance_items)).size, 5);
    assert.deepEqual(contract.units.map((unit: { scope_write: string[] }) => unit.scope_write[0]), first.expected_writes);
    assert.ok(contract.units.every((unit: { depends_on: string[] }) => unit.depends_on.length === 0));
    assert.deepEqual(JSON.parse(await readFile(
      join(runtimeRoot, "project", ".opencode", "sortie-dogs-luna-fabric.json"), "utf8",
    )), contract);
    assert.equal(await run("git", ["branch", "--show-current"], first.project_root), "");
    assert.equal((await run("git", ["rev-parse", "refs/heads/benchmark-medium"], first.project_root)).trim(),
      first.target_sha);

    const syntaxFiles = [
      join(fixtureRoot, "run-representative-rpt.mjs"),
      join(runtimeRoot, "project", "validate.mjs"),
      ...Array.from({ length: 5 }, (_, index) =>
        join(runtimeRoot, "project", "test", `unit-${index + 1}.test.mjs`)),
    ];
    for (const path of syntaxFiles) await run(process.execPath, ["--check", path]);
    const runner = join(fixtureRoot, "run-representative-rpt.mjs");
    const configPath = join(runtimeRoot, "representative-config.json");
    assert.match(await run(process.execPath, [runner, "--self-test-result-identity", "--config", configPath]),
      /"status":"pass"/u);
    assert.match(await run(process.execPath, [runner, "--self-test-clean-workspace", "--config", configPath]),
      /"status":"pass"/u);
    assert.deepEqual(await readdir(join(runtimeRoot, "project", "output")), [".gitkeep"]);
    assert.equal(await fixtureSourceSha256(), sourceBefore);
    assert.equal(await trackedText(), trackedBefore);
    assert.doesNotMatch(trackedBefore, new RegExp(first.target_sha, "u"));
    assert.doesNotMatch(trackedBefore, new RegExp(first.package.sha256, "u"));

    await cleanRepresentativeRuntime(runtimeRoot);
    assert.equal(await exists(runtimeRoot), false);
    const second = await prepareRepresentativeRuntime({ runtimeRoot, packagePath });
    assert.equal(second.target_sha, first.target_sha);
    assert.equal(second.package.sha256, first.package.sha256);
    assert.equal(second.fixture_source_sha256, first.fixture_source_sha256);
    assert.equal(await fixtureSourceSha256(), sourceBefore);
  } finally {
    await cleanRepresentativeRuntime(runtimeRoot);
  }
  assert.equal(await exists(runtimeRoot), false);
});
