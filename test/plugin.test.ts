import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SortieDogsPlugin } from "../dist/plugin/index.js";
import { resolvePluginConfiguration } from "../dist/plugin/config.js";
import {
  parseModelRoutingConfig,
  resolveModelRoute,
} from "../dist/plugin/model-routing.js";

interface PluginCase {
  name: string;
  target?: string;
  error?: string;
}

interface PluginFixture {
  manifest: Record<string, unknown>;
  handoffs: {
    valid: Record<string, unknown>;
    invalid: Record<string, unknown>;
  };
  invalidManifestJson: string;
  shell: {
    readOnly: string[];
    unknownWrites: string[];
  };
  cases: PluginCase[];
}

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/plugin-cases.json", import.meta.url), "utf8"),
) as PluginFixture;
const cases = new Map(fixture.cases.map((candidate) => [candidate.name, candidate]));
const testEnvironment = fileURLToPath(new URL("../_testenv/", import.meta.url));

test("model routing configuration is strict and merges roles by layer", () => {
  const project = {
    reviewer: { preferred: { model: "fable/opus", variant: "thinking" } },
  };
  const host = {
    implementer: {
      preferred: { model: "provider/primary" },
      fallback: [{ model: "provider/free" }],
    },
  };
  const parsed = resolvePluginConfiguration(
    { modelRouting: project },
    { modelRouting: host },
  );
  assert.equal(parsed.kind, "configured");
  if (parsed.kind === "configured") {
    assert.deepEqual(parsed.modelRouting, { ...project, ...host });
  }
  assert.equal(parseModelRoutingConfig({ reviewer: { preferred: { model: "x", extra: true } } }), undefined);
  assert.deepEqual(resolvePluginConfiguration({ unknown: true }), { kind: "invalid" });
});

test("model routing rejects prototype-sensitive JSON role names", () => {
  const routing = JSON.parse('{"__proto__":{"preferred":{"model":"provider/model"}}}') as unknown;
  assert.equal(parseModelRoutingConfig(routing), undefined);
});

test("model resolver preserves valid variants and prioritizes preferred, local, and project catalog", () => {
  const resolution = resolveModelRoute({
    role: "reviewer",
    local: {
      reviewer: {
        preferred: { model: "fable/opus", variant: "thinking" },
        fallback: [{ model: "provider/free" }],
      },
    },
    global: { reviewer: { preferred: { model: "provider/global" } } },
    catalog: {
      project: [{ model: "fable/opus", variants: ["thinking"] }],
      global: [
        { model: "fable/opus", variants: ["thinking"] },
        { model: "provider/free" },
        { model: "provider/global" },
      ],
    },
  });
  assert.deepEqual(resolution, {
    ok: true,
    role: "reviewer",
    source: "local",
    catalog: "project",
    model: "fable/opus",
    variant: "thinking",
  });
});

test("model resolver falls back in order and returns structured unresolved failures", () => {
  const route = {
    reviewer: {
      preferred: { model: "fable/opus", variant: "missing" },
      fallback: [{ model: "provider/free" }],
    },
  };
  assert.deepEqual(resolveModelRoute({
    role: "reviewer",
    local: route,
    catalog: { global: [{ model: "fable/opus", variants: ["valid"] }, { model: "provider/free" }] },
  }), {
    ok: true,
    role: "reviewer",
    source: "local",
    catalog: "global",
    model: "provider/free",
  });

  assert.deepEqual(resolveModelRoute({
    role: "unknown",
    local: route,
    catalog: { global: [{ model: "provider/free" }] },
  }), {
    ok: false,
    role: "unknown",
    reason: "unresolved-role",
    attempts: [],
  });

  for (const role of ["constructor", "toString", "valueOf"]) {
    assert.deepEqual(resolveModelRoute({ role, local: {}, global: {}, catalog: {} }), {
      ok: false,
      role,
      reason: "unresolved-role",
      attempts: [],
    });
  }
});

assert.deepEqual([...cases.keys()], [
  "allow-write",
  "deny-write",
  "deny-traversal",
  "missing-manifest",
  "invalid-manifest-json",
  "strict-warning",
]);

function fixtureCase(name: string): PluginCase {
  const candidate = cases.get(name);
  assert.ok(candidate, `missing fixture case ${name}`);
  return candidate;
}

async function withProject(
  name: string,
  run: (directory: string) => Promise<void>,
): Promise<void> {
  await mkdir(testEnvironment, { recursive: true });
  const directory = await mkdtemp(join(testEnvironment, `plugin-${name}-`));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function configuredHooks(directory: string) {
  await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
  return await SortieDogsPlugin({ directory });
}

async function invokeWrite(
  hooks: Awaited<ReturnType<typeof SortieDogsPlugin>>,
  target: string,
): Promise<void> {
  const before = hooks["tool.execute.before"];
  assert.ok(before);
  await before(
    { tool: "write", sessionID: "plugin-session", callID: "plugin-call" },
    { args: { file: target, content: "PRIVATE_WRITE_CONTENT" } },
  );
}

async function expectMessage(
  action: () => Promise<void>,
  expected: string,
  reason?: string,
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, expected);
    assert.equal(error.message.includes("PRIVATE_"), false);
    if (reason !== undefined) {
      assert.equal(error.name.endsWith("DeniedError"), true);
      assert.equal((error as Error & { reason?: string }).reason, reason);
    }
    return true;
  });
}

test("plugin fixture allows a manifest-scoped write", async () => {
  const candidate = fixtureCase("allow-write");
  await withProject(candidate.name, async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    const nested = join(directory, "nested");
    await mkdir(nested);
    await writeFile(join(nested, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    await invokeWrite(await SortieDogsPlugin({ directory: nested, worktree: directory }), candidate.target!);
    await invokeWrite(await SortieDogsPlugin({ directory }, {}), candidate.target!);
  });
});

test("plugin gate uses the execution directory when worktree differs", async () => {
  await withProject("directory-worktree-divergence", async (worktree) => {
    const directory = join(worktree, "u3-rpt");
    await mkdir(directory);
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    await writeFile(join(worktree, "operation-manifest.json"), JSON.stringify({
      ...fixture.manifest,
      write: ["denied.txt"],
    }));

    const hooks = await SortieDogsPlugin({ directory, worktree });
    await invokeWrite(hooks, "allowed.txt");
    const before = hooks["tool.execute.before"];
    const permission = hooks["permission.ask"];
    assert.ok(before);
    assert.ok(permission);
    await expectMessage(
      () => before(
        { tool: "apply_patch", sessionID: "plugin-session", callID: "patch-call" },
        { args: { patchText: `*** Begin Patch\n*** Add File: ${join(directory, "denied.txt")}\n+blocked\n*** End Patch` } },
      ),
      'Write denied for "denied.txt": operation manifest write scope.',
      "manifest-scope",
    );
    await permission(
      { permission: "edit", patterns: [join("u3-rpt", "allowed.txt")] },
      { status: "allow" },
    );
    await expectMessage(
      () => permission(
        { permission: "edit", patterns: [join("u3-rpt", "denied.txt")] },
        { status: "allow" },
      ),
      'Write denied for "denied.txt": operation manifest write scope.',
      "manifest-scope",
    );
    await assert.rejects(stat(join(directory, "denied.txt")), { code: "ENOENT" });
  });
});

test("plugin fixture denies an out-of-manifest write with target and reason", async () => {
  const candidate = fixtureCase("deny-write");
  await withProject(candidate.name, async (directory) => {
    const hooks = await configuredHooks(directory);
    await expectMessage(() => invokeWrite(hooks, candidate.target!), candidate.error!, "manifest-scope");
  });
});

test("plugin fixture denies traversal before write-scope comparison", async () => {
  const candidate = fixtureCase("deny-traversal");
  await withProject(candidate.name, async (directory) => {
    const hooks = await configuredHooks(directory);
    await expectMessage(() => invokeWrite(hooks, candidate.target!), candidate.error!, "project-boundary");
  });
});

test("plugin fixture fails closed for a missing manifest while reads remain no-op", async () => {
  const candidate = fixtureCase("missing-manifest");
  await withProject(candidate.name, async (directory) => {
    const hooks = await SortieDogsPlugin({ directory });
    await expectMessage(() => invokeWrite(hooks, "allowed.txt"), candidate.error!, "manifest-unavailable");

    const before = hooks["tool.execute.before"];
    assert.ok(before);
    await before(
      { tool: "read", sessionID: "plugin-session", callID: "read-call" },
      { args: { file: "unrestricted-read.txt" } },
    );
  });
});

test("plugin fixture fails closed for invalid manifest JSON without exposing input", async () => {
  const candidate = fixtureCase("invalid-manifest-json");
  await withProject(candidate.name, async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), fixture.invalidManifestJson);
    const hooks = await SortieDogsPlugin({ directory });
    await expectMessage(() => invokeWrite(hooks, "allowed.txt"), candidate.error!, "manifest-unavailable");
  });
});

test("plugin fixture loads project and environment configuration with host override precedence", async () => {
  await withProject("configuration", async (directory) => {
    await mkdir(join(directory, ".opencode"));
    await writeFile(join(directory, "project-manifest.json"), JSON.stringify(fixture.manifest));
    await writeFile(join(directory, "environment-manifest.json"), JSON.stringify(fixture.manifest));
    await writeFile(join(directory, "override-manifest.json"), JSON.stringify(fixture.manifest));
    await writeFile(join(directory, ".opencode", "sortie-dogs.json"), JSON.stringify({
      operationManifestPath: "project-manifest.json",
      handoffPaths: [],
    }));

    const previous = process.env.SORTIE_DOGS_CONFIG;
    process.env.SORTIE_DOGS_CONFIG = JSON.stringify({
      operationManifestPath: "environment-manifest.json",
    });
    try {
      const fromEnvironment = await SortieDogsPlugin({ directory });
      await invokeWrite(fromEnvironment, "allowed.txt");
      const overridden = await SortieDogsPlugin(
        { directory },
        { operationManifestPath: "override-manifest.json" },
      );
      await invokeWrite(overridden, "allowed.txt");
    } finally {
      if (previous === undefined) delete process.env.SORTIE_DOGS_CONFIG;
      else process.env.SORTIE_DOGS_CONFIG = previous;
    }
  });
});

test("plugin ignores the old project config path when the new config is absent", async () => {
  await withProject("old-configuration", async (directory) => {
    await mkdir(join(directory, ".opencode"));
    await writeFile(join(directory, "legacy-manifest.json"), JSON.stringify(fixture.manifest));
    await writeFile(join(directory, ".opencode", "agent-contract-guard.json"), JSON.stringify({
      operationManifestPath: "legacy-manifest.json",
    }));

    const hooks = await SortieDogsPlugin({ directory });
    await expectMessage(
      () => invokeWrite(hooks, "allowed.txt"),
      'Write denied for "<unknown>": operation manifest unavailable.',
      "manifest-unavailable",
    );
  });
});

test("plugin shell gate allows explicit reads and denies unknown executables", async () => {
  await withProject("shell", async (directory) => {
    const hooks = await configuredHooks(directory);
    const before = hooks["tool.execute.before"];
    assert.ok(before);
    const invoke = (command: string) => before(
      { tool: "bash", sessionID: "shell", callID: command },
      { args: { command } },
    );
    for (const command of fixture.shell.readOnly) await invoke(command);
    await invoke("echo safe > allowed.txt");
    await expectMessage(
      () => invoke("echo blocked > blocked.txt"),
      'Write denied for "blocked.txt": operation manifest write scope.',
      "manifest-scope",
    );
    for (const command of fixture.shell.unknownWrites) {
      await expectMessage(
        () => invoke(command),
        'Write denied for "<unknown>": write path must be explicit.',
        "path-required",
      );
    }
  });
});

test("plugin fixture accepts warning-only handoff state and dedupes per session", async () => {
  const candidate = fixtureCase("strict-warning");
  await withProject(candidate.name, async (directory) => {
    const handoffPath = join(directory, "handoff.json");
    const valid = JSON.stringify(fixture.handoffs.valid);
    const invalidValue = JSON.stringify(fixture.handoffs.invalid);
    assert.ok(Buffer.byteLength(invalidValue) < Buffer.byteLength(valid));
    const invalid = invalidValue.padEnd(Buffer.byteLength(valid), " ");
    await writeFile(handoffPath, valid);
    const fixtureTime = new Date("2035-01-02T03:04:05.000Z");
    await utimes(handoffPath, fixtureTime, fixtureTime);

    const hooks = await configuredHooks(directory);
    const event = hooks.event;
    assert.ok(event);
    const edited = { event: { type: "file.edited", properties: { file: "handoff.json", sessionID: "one" } } };

    // Missing changed-path evidence produces only M007; the plugin rejects errors, not warnings.
    await event(edited);
    await event({ event: { type: "session.idle", properties: { sessionID: "one" } } });
    await event({ event: { type: "file.edited", properties: { file: "ordinary.txt", sessionID: "one" } } });
    await event({ event: { type: "unrelated.event", properties: { sessionID: "one" } } });

    const original = await stat(handoffPath);
    await writeFile(handoffPath, invalid);
    await utimes(handoffPath, original.atime, original.mtime);
    const replaced = await stat(handoffPath);
    assert.deepEqual(
      [replaced.size, replaced.mtimeMs],
      [original.size, original.mtimeMs],
      "content change fixture must retain the filesystem metadata",
    );

    await expectMessage(
      () => event(edited),
      candidate.error!,
      "schema-invalid",
    );
  });
});
