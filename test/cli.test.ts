import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const TEST_ROOT = join(process.cwd(), "_testenv");
const ENTRY = join(process.cwd(), "src", "cli", "main.ts");
const INVALID_SCHEMA = join(process.cwd(), "test", "fixtures", "invalid-schema");
const INVALID_SEMANTIC = join(process.cwd(), "test", "fixtures", "invalid-semantic");
const USAGE = `Usage: sortie-dogs lint <handoff.json> [<handoff.json> ...]
  [--manifest <operation-manifest.json>]
  [--changed-paths-from <file|->]
  [--changed-path <path> ...]
  [--format text|json] [--quiet] [--strict]\n`;

interface CliResult {
  exit: number | null;
  stdout: string;
  stderr: string;
}

interface JsonDiagnostic {
  code: string;
  severity: "error" | "warning";
  pointer: string;
}

function diagnostics(result: CliResult): JsonDiagnostic[] {
  return JSON.parse(result.stdout) as JsonDiagnostic[];
}

async function fixtureDirectory(): Promise<string> {
  await mkdir(TEST_ROOT, { recursive: true });
  return mkdtemp(join(TEST_ROOT, "cli-"));
}

async function runCli(args: readonly string[], stdin: string = ""): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", ENTRY, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (exit) => resolve({ exit, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

function handoff(id: string): object {
  return {
    version: "0.1.0",
    profile: "minimal",
    id,
    created_at: "2026-08-02T00:00:00Z",
    task: { title: "CLI test", objective: "Validate CLI input behavior" },
    state: { done: [], next: ["Continue"], blocked: [] },
    risks: [],
    verification: [],
  };
}

function handoffWithWarning(): object {
  return {
    ...handoff("output-warning"),
    verification: [
      { check: "cli-output", status: "pass", exit_code: 1, summary: "Intentional mismatch." },
    ],
  };
}

async function clean(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
  await rm(TEST_ROOT).catch(() => undefined);
}

test("renders warning diagnostics as text without failing by default", async () => {
  const directory = await fixtureDirectory();
  try {
    const input = join(directory, "warning.json");
    await writeFile(input, JSON.stringify(handoffWithWarning()));

    const result = await runCli(["lint", input]);
    assert.deepEqual(result, {
      exit: 0,
      stdout: "handoff[0] /verification/0/exit_code H006 warning " +
        "exit_code is inconsistent with verification status pass\n",
      stderr: "",
    });
  } finally {
    await clean(directory);
  }
});

test("renders diagnostics as JSON", async () => {
  const directory = await fixtureDirectory();
  try {
    const input = join(directory, "warning.json");
    await writeFile(input, JSON.stringify(handoffWithWarning()));

    const result = await runCli(["lint", input, "--format", "json"]);
    assert.deepEqual(result, {
      exit: 0,
      stdout: JSON.stringify([{
        file: "handoff[0]",
        code: "H006",
        severity: "warning",
        pointer: "/verification/0/exit_code",
        message: "exit_code is inconsistent with verification status pass",
      }]) + "\n",
      stderr: "",
    });
  } finally {
    await clean(directory);
  }
});

test("quiet suppresses diagnostics without changing warning exit semantics", async () => {
  const directory = await fixtureDirectory();
  try {
    const input = join(directory, "warning.json");
    await writeFile(input, JSON.stringify(handoffWithWarning()));

    assert.deepEqual(await runCli(["lint", input, "--quiet"]), {
      exit: 0,
      stdout: "",
      stderr: "",
    });
  } finally {
    await clean(directory);
  }
});

test("strict promotes warning diagnostics to exit 1", async () => {
  const directory = await fixtureDirectory();
  try {
    const input = join(directory, "warning.json");
    await writeFile(input, JSON.stringify(handoffWithWarning()));

    const result = await runCli(["lint", input, "--strict"]);
    assert.equal(result.exit, 1);
    assert.match(result.stdout, / H006 warning /);
    assert.equal(result.stderr, "");
  } finally {
    await clean(directory);
  }
});

test("error diagnostics return exit 1", async () => {
  const directory = await fixtureDirectory();
  try {
    const input = join(directory, "error.json");
    await writeFile(input, JSON.stringify({
      ...handoff("output-error"),
      state: { done: [], next: [], blocked: [] },
    }));

    const result = await runCli(["lint", input]);
    assert.deepEqual(result, {
      exit: 1,
      stdout: "handoff[0] /state/next H004 error " +
        "State has neither a next action nor completion evidence.\n",
      stderr: "",
    });
  } finally {
    await clean(directory);
  }
});

test("input and usage failures return exit 2 on stderr", async () => {
  const directory = await fixtureDirectory();
  try {
    assert.deepEqual(await runCli(["lint", join(directory, "missing.json")]), {
      exit: 2,
      stdout: "",
      stderr: "Handoff input could not be read.\n",
    });
    assert.deepEqual(await runCli(["lint", "input.json", "--format", "xml"]), {
      exit: 2,
      stdout: "",
      stderr: USAGE,
    });
  } finally {
    await clean(directory);
  }
});

test("help returns exit 0 on stdout", async () => {
  assert.deepEqual(await runCli(["--help"]), {
    exit: 0,
    stdout: USAGE,
    stderr: "",
  });
});

test("package metadata exposes the sortie-dogs bin and agrees with the lockfile", async () => {
  const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
  const packageLock = JSON.parse(await readFile(join(process.cwd(), "package-lock.json"), "utf8"));

  assert.deepEqual(packageJson.bin, {
    "sortie-dogs": "dist/cli/main.js",
  });
  assert.deepEqual(packageLock.packages[""].bin, packageJson.bin);
  assert.equal(packageLock.name, packageJson.name);
  assert.equal(packageLock.packages[""].name, packageJson.name);
  assert.equal(packageLock.packages[""].engines.node, packageJson.engines.node);

  const distPath = join(process.cwd(), "dist");
  const dist = await stat(distPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (dist === undefined) return;

  assert.ok(dist.isDirectory(), "dist must be a directory when present");
  const binSource = await readFile(join(process.cwd(), packageJson.bin["sortie-dogs"]), "utf8");
  assert.match(binSource, /^#!\/usr\/bin\/env node\r?\n/);
});

test("accepts multiple handoffs, an optional manifest, and the changed-path union", async () => {
  const directory = await fixtureDirectory();
  try {
    const first = join(directory, "first.json");
    const second = join(directory, "second.json");
    const manifest = join(directory, "manifest.json");
    const changed = join(directory, "changed.txt");
    await Promise.all([
      writeFile(first, JSON.stringify(handoff("first"))),
      writeFile(second, JSON.stringify(handoff("second"))),
      writeFile(manifest, JSON.stringify({
        version: "0.1.0",
        task_id: "cli-test",
        read: [],
        write: ["src/a.ts", "src/b.ts"],
        validation: [],
      })),
      writeFile(changed, "src\\a.ts\nsrc/a.ts\n"),
    ]);

    const result = await runCli([
      "lint", first, second,
      "--manifest", manifest,
      "--changed-paths-from", changed,
      "--changed-path", "src/b.ts",
    ]);
    assert.deepEqual(result, { exit: 0, stdout: "", stderr: "" });
  } finally {
    await clean(directory);
  }
});

test("reads only newline-separated changed paths from stdin", async () => {
  const directory = await fixtureDirectory();
  try {
    const input = join(directory, "handoff.json");
    await writeFile(input, JSON.stringify(handoff("stdin-paths")));
    const result = await runCli(["lint", input, "--changed-paths-from", "-"], "src/a.ts\r\n");
    assert.equal(result.exit, 0);
    assert.equal(result.stderr, "");

    const noHandoff = await runCli(["lint", "--changed-paths-from", "-"], JSON.stringify(handoff("stdin-json")));
    assert.equal(noHandoff.exit, 2);
    assert.match(noHandoff.stderr, /^Usage:/);
  } finally {
    await clean(directory);
  }
});

test("returns exit 2 for unknown options, missing option values, and no handoff", async () => {
  for (const args of [
    ["lint", "input.json", "--unknown"],
    ["lint", "input.json", "--manifest"],
    ["lint"],
  ]) {
    const result = await runCli(args);
    assert.equal(result.exit, 2);
    assert.match(result.stderr, /^Usage:/);
  }
});

test("recognizes help only in option position, never as an option value", async () => {
  const help = await runCli(["--help"]);
  assert.equal(help.exit, 0);
  assert.match(help.stdout, /^Usage:/);

  for (const args of [
    ["lint", "input.json", "--manifest", "--help"],
    ["lint", "input.json", "--changed-paths-from", "--help"],
    ["lint", "input.json", "--changed-path", "--help"],
    ["lint", "input.json", "--format", "--help"],
  ]) {
    const result = await runCli(args);
    assert.equal(result.exit, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Usage:/);
  }
});

test("classifies read and parse failures without disclosing input", async () => {
  const directory = await fixtureDirectory();
  try {
    const invalid = join(directory, "invalid.json");
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    await writeFile(invalid, `{\"token\":\"${secret}\"`);
    const result = await runCli(["lint", invalid, join(directory, "missing.json")]);
    assert.equal(result.exit, 2);
    assert.equal(result.stderr, "Handoff input is not valid JSON.\nHandoff input could not be read.\n");
    assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
  } finally {
    await clean(directory);
  }
});

test("enforces handoff size, JSON depth, and array count limits", async () => {
  const directory = await fixtureDirectory();
  try {
    const oversized = join(directory, "oversized.json");
    const deep = join(directory, "deep.json");
    const wide = join(directory, "wide.json");
    let nested: unknown = "leaf";
    for (let index = 0; index < 33; index += 1) nested = [nested];
    await Promise.all([
      writeFile(oversized, Buffer.alloc(2 * 1024 * 1024 + 1, 0x20)),
      writeFile(deep, JSON.stringify(nested)),
      writeFile(wide, JSON.stringify({ ext: { values: Array(10_001).fill(null) } })),
    ]);

    const sizeResult = await runCli(["lint", oversized]);
    assert.equal(sizeResult.exit, 2);
    assert.equal(sizeResult.stderr, "Handoff input exceeds the size limit.\n");

    const depthResult = await runCli(["lint", deep]);
    assert.equal(depthResult.exit, 2);
    assert.equal(depthResult.stderr, "JSON input exceeds the nesting depth limit.\n");

    const countResult = await runCli(["lint", wide]);
    assert.equal(countResult.exit, 2);
    assert.equal(countResult.stderr, "JSON input exceeds the array item limit.\n");
  } finally {
    await clean(directory);
  }
});

test("enforces changed-path size, path, and normalized count limits", async () => {
  const directory = await fixtureDirectory();
  try {
    const input = join(directory, "handoff.json");
    const oversized = join(directory, "oversized.txt");
    const tooMany = join(directory, "many.txt");
    await Promise.all([
      writeFile(input, JSON.stringify(handoff("changed-limits"))),
      writeFile(oversized, Buffer.alloc(1024 * 1024 + 1, 0x61)),
      writeFile(tooMany, Array.from({ length: 10_001 }, (_, index) => `src/${index}.ts`).join("\n")),
    ]);

    assert.equal((await runCli(["lint", input, "--changed-paths-from", oversized])).exit, 2);
    assert.equal((await runCli(["lint", input, "--changed-path", "../secret"])).stderr,
      "Changed paths input is invalid.\n");
    assert.equal((await runCli(["lint", input, "--changed-paths-from", tooMany])).stderr,
      "Changed paths input exceeds the count limit.\n");
  } finally {
    await clean(directory);
  }
});

test("skips manifest validation when changed-path resolution fails", async () => {
  const directory = await fixtureDirectory();
  try {
    const input = join(directory, "handoff.json");
    const manifest = join(directory, "manifest.json");
    await writeFile(input, JSON.stringify({
      ...handoff("changed-resolution"),
      scope: { paths: ["src/not-declared.ts"] },
    }));
    await writeFile(manifest, JSON.stringify({
      version: "0.1.0",
      task_id: "changed-resolution",
      read: [],
      write: [],
      validation: [],
    }));

    const missingFile = await runCli([
      "lint", input, "--manifest", manifest,
      "--changed-paths-from", join(directory, "missing.txt"),
    ]);
    assert.deepEqual(missingFile, {
      exit: 2,
      stdout: "",
      stderr: "Changed paths input could not be read.\n",
    });

    const oversizedStdin = await runCli(
      ["lint", input, "--manifest", manifest, "--changed-paths-from", "-"],
      "a".repeat(1024 * 1024 + 1),
    );
    assert.deepEqual(oversizedStdin, {
      exit: 2,
      stdout: "",
      stderr: "Changed paths input exceeds the size limit.\n",
    });
  } finally {
    await clean(directory);
  }
});

test("help is successful and manifest parse failures are inspection failures", async () => {
  const help = await runCli(["--help"]);
  assert.equal(help.exit, 0);
  assert.match(help.stdout, /^Usage:/);

  const directory = await fixtureDirectory();
  try {
    const input = join(directory, "handoff.json");
    const manifest = join(directory, "manifest.json");
    await writeFile(input, JSON.stringify(handoff("manifest-parse")));
    await writeFile(manifest, "not-json");
    const result = await runCli(["lint", input, "--manifest", manifest]);
    assert.equal(result.exit, 2);
    assert.equal(result.stderr, "Manifest input is not valid JSON.\n");
  } finally {
    await clean(directory);
  }
});

test("invalid fixture matrix fixes H001-H010 codes and error exits", async () => {
  const cases = [
    ["invalid-h001.json", "H001"],
    ["invalid-h002.json", "H002"],
    ["invalid-h003.json", "H003"],
    ["invalid-h004.json", "H004"],
    ["invalid-h005.json", "H005"],
    ["invalid-h006.json", "H006"],
    ["invalid-h007.json", "H007"],
    ["invalid-h008-date.json", "schema_format"],
    ["invalid-h008-offset.json", "schema_format"],
    ["invalid-h010.json", "H010"],
  ] as const;

  for (const [fixture, expectedCode] of cases) {
    const result = await runCli(["lint", join(INVALID_SEMANTIC, fixture), "--format", "json"]);
    assert.equal(result.exit, 1, fixture);
    assert.deepEqual(diagnostics(result).map(({ code }) => code), [expectedCode], fixture);
    assert.equal(result.stderr, "", fixture);
  }
});

test("profile-specific null exits and H009 warning exits are stable", async () => {
  const fullNull = join(INVALID_SEMANTIC, "invalid-h006-full-null.json");
  const minimalNull = join(INVALID_SEMANTIC, "invalid-h006-minimal-null.json");
  const secretLike = join(INVALID_SEMANTIC, "invalid-h009.json");

  const fullResult = await runCli(["lint", fullNull, "--format", "json"]);
  assert.equal(fullResult.exit, 1);
  assert.deepEqual(diagnostics(fullResult).map(({ code, severity }) => [code, severity]), [["H006", "error"]]);

  for (const fixture of [minimalNull, secretLike]) {
    const normal = await runCli(["lint", fixture, "--format", "json"]);
    assert.equal(normal.exit, 0);
    assert.equal(diagnostics(normal)[0]?.severity, "warning");
    const strict = await runCli(["lint", fixture, "--format", "json", "--strict"]);
    assert.equal(strict.exit, 1);
    assert.deepEqual(diagnostics(strict), diagnostics(normal));
  }
  assert.deepEqual(diagnostics(await runCli(["lint", secretLike, "--format", "json"]))
    .map(({ code }) => code), ["H009"]);
});

test("invalid schema and malformed fixture exits are stable", async () => {
  for (const [fixture, code] of [
    ["missing-version.json", "schema_required"],
    ["unknown-property.json", "schema_additionalProperties"],
  ] as const) {
    const result = await runCli(["lint", join(INVALID_SCHEMA, fixture), "--format", "json"]);
    assert.equal(result.exit, 1);
    assert.deepEqual(diagnostics(result).map((diagnostic) => diagnostic.code), [code]);
  }

  const malformed = await runCli(["lint", join(INVALID_SCHEMA, "malformed.json")]);
  assert.deepEqual(malformed, {
    exit: 2,
    stdout: "",
    stderr: "Handoff input is not valid JSON.\n",
  });
});

test("manifest matrix fixes H011 and M002-M005/M007 exit semantics", async () => {
  const directory = await fixtureDirectory();
  const input = join(directory, "handoff.json");
  const manifestPath = join(directory, "manifest.json");
  const baseHandoff = {
    ...handoff("manifest-matrix"),
    profile: "full",
    scope: { paths: ["src"] },
    sources: [{ path: "src/index.ts", rev: "main" }],
  };
  const baseManifest = {
    version: "0.1.0",
    task_id: "manifest-matrix",
    read: ["src", "src/index.ts"],
    write: ["src", "src/index.ts"],
    validation: [],
  };

  async function manifestCase(
    handoffValue: object,
    manifestValue: object,
    changed: readonly string[] = ["src/index.ts"],
    strict: boolean = false,
  ): Promise<CliResult> {
    await Promise.all([
      writeFile(input, JSON.stringify(handoffValue)),
      writeFile(manifestPath, JSON.stringify(manifestValue)),
    ]);
    const args = ["lint", input, "--manifest", manifestPath, "--format", "json"];
    for (const path of changed) args.push("--changed-path", path);
    if (strict) args.push("--strict");
    return runCli(args);
  }

  try {
    const cases = [
      [{ ...baseHandoff, scope: { paths: ["src", "outside"] } }, baseManifest, "M002_SCOPE_NOT_ALLOWED"],
      [{ ...baseHandoff, sources: [{ path: "src/missing.ts", rev: "main" }] }, baseManifest, "M003_SOURCE_NOT_DECLARED"],
      [{ ...baseHandoff, verification: [{ check: "other-check", status: "pass", exit_code: 0, summary: "Passed." }] }, baseManifest, "M004_VERIFICATION_NOT_DECLARED"],
    ] as const;
    for (const [handoffValue, manifestValue, code] of cases) {
      const result = await manifestCase(handoffValue, manifestValue);
      assert.equal(result.exit, 1, code);
      assert.deepEqual(diagnostics(result).map((diagnostic) => diagnostic.code), [code], code);
    }

    const h011 = await manifestCase(
      JSON.parse(await readFile(join(INVALID_SEMANTIC, "invalid-h011.json"), "utf8")) as object,
      { ...baseManifest, validation: ["completed-check", "missing-check"] },
    );
    assert.equal(h011.exit, 1);
    assert.deepEqual(diagnostics(h011).map(({ code }) => code), ["H011_VALIDATION_MISSING"]);

    const m005 = await manifestCase(baseHandoff, baseManifest, ["outside.ts"]);
    assert.equal(m005.exit, 1);
    assert.deepEqual(diagnostics(m005).map(({ code }) => code), ["M005_CHANGED_PATH_NOT_WRITABLE"]);

    const m007 = await manifestCase(baseHandoff, baseManifest, []);
    assert.equal(m007.exit, 0);
    assert.deepEqual(diagnostics(m007).map(({ code, severity }) => [code, severity]),
      [["M007_CHANGED_PATHS_MISSING", "warning"]]);
    const m007Strict = await manifestCase(baseHandoff, baseManifest, [], true);
    assert.equal(m007Strict.exit, 1);
    assert.deepEqual(diagnostics(m007Strict), diagnostics(m007));
  } finally {
    await clean(directory);
  }
});

test("diagnostic JSON order is pointer then code and never includes secret-like values", async () => {
  const directory = await fixtureDirectory();
  try {
    const input = join(directory, "sorted.json");
    const secretLike = "aB3dE5fG7hJ9kL2m";
    await writeFile(input, JSON.stringify({
      ...handoff("sorted-diagnostics"),
      state: { done: [], next: [], blocked: [] },
      verification: [{ check: "sorted-check", status: "pass", exit_code: 1, summary: "Mismatch." }],
      ext: { token: secretLike },
    }));
    const result = await runCli(["lint", input, "--format", "json"]);
    assert.equal(result.exit, 1);
    assert.deepEqual(diagnostics(result).map(({ pointer, code }) => [pointer, code]), [
      ["/ext/token", "H009"],
      ["/state/next", "H004"],
      ["/verification/0/exit_code", "H006"],
    ]);
    assert.equal(`${result.stdout}${result.stderr}`.includes(secretLike), false);
  } finally {
    await clean(directory);
  }
});

test("path checks are lexical: traversal fails while symlink resolution stays out of scope", async () => {
  const traversal = await runCli(["lint", join(INVALID_SEMANTIC, "invalid-h001.json"), "--format", "json"]);
  assert.equal(traversal.exit, 1);
  assert.deepEqual(diagnostics(traversal).map(({ code }) => code), ["H001"]);

  const directory = await fixtureDirectory();
  try {
    const input = join(directory, "lexical-only.json");
    await writeFile(input, JSON.stringify({ ...handoff("lexical-only"), scope: { paths: ["links/source.ts"] } }));
    assert.deepEqual(await runCli(["lint", input, "--format", "json"]), {
      exit: 0,
      stdout: "[]\n",
      stderr: "",
    });
  } finally {
    await clean(directory);
  }
});
