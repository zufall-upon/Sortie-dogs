import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const TEST_ROOT = join(process.cwd(), "_testenv");
const ENTRY = join(process.cwd(), "src", "cli", "main.ts");
const USAGE = `Usage: agent-contract-guard lint <handoff.json> [<handoff.json> ...]
  [--manifest <operation-manifest.json>]
  [--changed-paths-from <file|->]
  [--changed-path <path> ...]
  [--format text|json] [--quiet] [--strict]\n`;

interface CliResult {
  exit: number | null;
  stdout: string;
  stderr: string;
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
      stdout: "handoff[0] /verification/0/exit_code verification_exit_code_mismatch warning " +
        "Verification exit code does not match its status.\n",
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
        code: "verification_exit_code_mismatch",
        severity: "warning",
        pointer: "/verification/0/exit_code",
        message: "Verification exit code does not match its status.",
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
    assert.match(result.stdout, / verification_exit_code_mismatch warning /);
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
        "State does not provide an actionable next step.\n",
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
