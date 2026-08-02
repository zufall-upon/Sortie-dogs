import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const testEnvironment = fileURLToPath(new URL("../_testenv/", import.meta.url));
const bridgeUrl = new URL("../.opencode/plugins/sortie-dogs.ts", import.meta.url);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const execFileAsync = promisify(execFile);

test("project-local bridge resolves sortie-dogs from .opencode node_modules", async () => {
  const bridgeSource = await readFile(bridgeUrl, "utf8");
  assert.equal(bridgeSource.trim(), 'export { SortieDogsPlugin } from "sortie-dogs/plugin";');

  const config = JSON.parse(
    await readFile(new URL("../opencode.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(config.plugin, undefined);

  await mkdir(testEnvironment, { recursive: true });
  const fixture = await mkdtemp(join(testEnvironment, "plugin-loader-"));
  try {
    const pluginDirectory = join(fixture, ".opencode", "plugins");
    const packageDirectory = join(fixture, ".opencode", "node_modules", "sortie-dogs");
    await mkdir(pluginDirectory, { recursive: true });
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(
      join(fixture, ".opencode", "package.json"),
      JSON.stringify({ name: "plugin-loader-fixture", private: true, type: "module" }),
    );
    await writeFile(join(pluginDirectory, "sortie-dogs.ts"), bridgeSource);
    await writeFile(
      join(packageDirectory, "package.json"),
      JSON.stringify({
        name: "sortie-dogs",
        type: "module",
        exports: { "./plugin": "./plugin.js" },
      }),
    );
    await writeFile(
      join(packageDirectory, "plugin.js"),
      "export const SortieDogsPlugin = () => 'project-local';\n",
    );

    const bridgeHref = pathToFileURL(join(pluginDirectory, "sortie-dogs.ts")).href;
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        `import(${JSON.stringify(bridgeHref)}).then(async ({ SortieDogsPlugin }) => process.stdout.write(await SortieDogsPlugin()))`,
      ],
      { cwd: fixture },
    );
    assert.equal(stdout, "project-local");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("packed package exposes sortie-dogs/plugin", async () => {
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
        "import('sortie-dogs/plugin').then(({ SortieDogsPlugin }) => process.stdout.write(typeof SortieDogsPlugin))",
      ],
      { cwd: consumer },
    );
    assert.equal(stdout, "function");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
