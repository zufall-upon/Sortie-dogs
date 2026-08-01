import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { lint } from "../src/core/diagnostics.ts";

const SECRET = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
const SHORT_SECRET = "aB3dE5fG7hJ9kL2m";

function handoff(profile: string = "minimal"): Parameters<typeof lint>[0] {
  return {
    profile,
    created_at: "2026-08-01T00:00:00Z",
    task: { title: "Security test", objective: "Verify secret diagnostics" },
    state: { done: [], next: ["Continue"], blocked: [] },
    risks: [],
    verification: [],
    ext: {
      nested: [{ "token/with~escaped-pointer": SECRET }],
      ignoredByOtherRules: { title: "   ", path: "../not-a-scope-path" },
    },
  } as Parameters<typeof lint>[0];
}

test("H009 reports only the pointer and defaults to warning", () => {
  const result = lint(handoff());
  const diagnostic = result.diagnostics.find(({ code }) => code === "H009");

  assert.deepEqual(diagnostic, {
    code: "H009",
    severity: "warning",
    pointer: "/ext/nested/0/token~1with~0escaped-pointer",
    message: "Value resembles a credential or high-entropy token.",
  });
  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.length, 1, "ext values must not be processed by other semantic rules");
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(JSON.stringify(result).includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ"), false);
});

test("H009 is an error through the supported severity option", () => {
  const result = lint(handoff(), { severity: { H009: "error" } });

  assert.equal(result.diagnostics.find(({ code }) => code === "H009")?.severity, "error");
  assert.equal(result.ok, false);
  assert.equal(result.counts.error, 1);
});

test("H009 detects short, embedded, and late secret-like tokens", () => {
  const input = handoff();
  input.ext = {
    short: SHORT_SECRET,
    embedded: `prefix:${SHORT_SECRET}:suffix`,
    late: `${"ordinary text ".repeat(400)}${SHORT_SECRET}`,
  };

  const result = lint(input);
  const pointers = result.diagnostics.filter(({ code }) => code === "H009").map(({ pointer }) => pointer);
  assert.deepEqual(pointers, ["/ext/embedded", "/ext/late", "/ext/short"]);
});

test("H009 positionalizes secret-like object keys", () => {
  const input = handoff();
  input.ext = { container: { [SECRET]: "ordinary" } };

  const result = lint(input);
  const serialized = JSON.stringify(result);
  assert.equal(result.diagnostics.find(({ code }) => code === "H009")?.pointer, "/ext/container/@0/key");
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ"), false);
});

test("H009 checks shared references at every path and terminates cycles", () => {
  const shared = { token: SHORT_SECRET };
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  cyclic[SECRET] = "ordinary";
  const input = handoff();
  input.ext = { first: shared, second: shared, cyclic };

  const result = lint(input);
  assert.deepEqual(result.diagnostics.map(({ pointer }) => pointer), [
    "/ext/cyclic/@1/key",
    "/ext/first/token",
    "/ext/second/token",
  ]);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test("H001 rejects lexical traversal without attempting symlink resolution", () => {
  const traversal = handoff();
  traversal.ext = {};
  traversal.scope = { paths: ["../private-value"] };
  const rejected = lint(traversal);
  assert.deepEqual(rejected.diagnostics.map(({ code, pointer }) => [code, pointer]),
    [["H001", "/scope/paths/0"]]);
  assert.equal(JSON.stringify(rejected).includes("private-value"), false);

  const lexicalOnly = handoff();
  lexicalOnly.ext = {};
  lexicalOnly.scope = { paths: ["links/source.ts"] };
  assert.equal(lint(lexicalOnly).diagnostics.some(({ code }) => code === "H001"), false,
    "symlink resolution is intentionally unsupported");
});

test("CLI rejects oversized input without exposing its contents", async () => {
  const root = join(process.cwd(), "_testenv");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "security-oversized-"));
  try {
    const input = join(directory, "oversized.json");
    await writeFile(input, Buffer.concat([Buffer.alloc(2 * 1024 * 1024 + 1, 0x20), Buffer.from(SECRET)]));
    const output = await new Promise<{ exit: number | null; text: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [
        "--experimental-strip-types",
        join(process.cwd(), "src", "cli", "main.ts"),
        "lint",
        input,
      ], {
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let text = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => { text += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { text += chunk; });
      child.once("error", reject);
      child.once("close", (exit) => resolve({ exit, text }));
    });

    assert.equal(output.exit, 2);
    assert.equal(output.text, "Handoff input exceeds the size limit.\n");
    assert.equal(output.text.includes(SECRET), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(root).catch(() => undefined);
  }
});

test("CLI schema and parse output never discloses secret input", async () => {
  const root = join(process.cwd(), "_testenv");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "security-cli-"));
  try {
    const schemaInput = join(directory, "schema.json");
    const parseInput = join(directory, "parse.json");
    await writeFile(schemaInput, JSON.stringify({
      version: "0.1.0",
      profile: "minimal",
      id: "security-cli",
      created_at: "2026-08-02T00:00:00Z",
      task: { title: "Security CLI", objective: "Check output redaction" },
      state: { done: [], next: ["Continue"], blocked: [] },
      risks: [],
      verification: [],
      [SECRET]: SHORT_SECRET,
    }));
    await writeFile(parseInput, `{\"secret\":\"${SECRET}\"`);

    const output = await new Promise<{ exit: number | null; text: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [
        "--experimental-strip-types",
        join(process.cwd(), "src", "cli", "main.ts"),
        "lint",
        schemaInput,
        parseInput,
      ], {
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let text = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => { text += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { text += chunk; });
      child.once("error", reject);
      child.once("close", (exit) => resolve({ exit, text }));
    });

    assert.equal(output.exit, 2);
    assert.match(output.text, /schema_additionalProperties/);
    assert.match(output.text, /\/@unknown/);
    assert.equal(output.text.includes(SECRET), false);
    assert.equal(output.text.includes(SHORT_SECRET), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(root).catch(() => undefined);
  }
});

test("CLI text neutralizes controls while JSON preserves diagnostic data", async () => {
  const root = join(process.cwd(), "_testenv");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "security-controls-"));
  try {
    const input = join(directory, "handoff.json");
    const controlledKey = "line\r\n\u0000\u001b[31m\u007f\u0085";
    const value = {
      ...handoff(),
      version: "0.1.0" as const,
      id: "security-controls",
    };
    value.ext = { [controlledKey]: SECRET };
    await writeFile(input, JSON.stringify(value));

    const invoke = (format: "text" | "json") => new Promise<{ exit: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [
        "--experimental-strip-types",
        join(process.cwd(), "src", "cli", "main.ts"),
        "lint",
        input,
        "--format",
        format,
      ], {
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
        stdio: ["ignore", "pipe", "ignore"],
      });
      let stdout = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.once("error", reject);
      child.once("close", (exit) => resolve({ exit, stdout }));
    });

    const text = await invoke("text");
    assert.equal(text.exit, 0);
    assert.equal(text.stdout,
      "handoff[0] /ext/line\\r\\n\\u0000\\u001b[31m\\u007f\\u0085 H009 warning Value resembles a credential or high-entropy token.\n");
    assert.equal(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text.stdout), false);

    const json = await invoke("json");
    assert.equal(json.exit, 0);
    const parsed = JSON.parse(json.stdout) as Array<{ pointer: string }>;
    assert.equal(parsed[0]?.pointer, `/ext/${controlledKey}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(root).catch(() => undefined);
  }
});
