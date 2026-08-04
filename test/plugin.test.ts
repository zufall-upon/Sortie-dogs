import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runtimeAssets } from "../dist/runtime-assets.js";
import { ModelRoutingDeniedError, SortieDogsPlugin } from "../dist/plugin/index.js";
import {
  resolvePluginConfiguration,
  resolvePluginConfigurationSources,
} from "../dist/plugin/config.js";
import {
  DEDICATED_SOL_MODEL,
  DEDICATED_SOL_VARIANT,
  DEDICATED_SOL_ROLES,
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
    { modelRouting: project, modelCatalog: { global: [{ model: "provider/primary" }] } },
    { modelRouting: host },
  );
  assert.equal(parsed.kind, "configured");
  if (parsed.kind === "configured") {
    assert.deepEqual(parsed.modelRouting, {
      "dog-coordinator": { preferred: { model: "openai/gpt-5.6-luna", variant: "xhigh" } },
      "dog-scout": { preferred: { model: "openai/gpt-5.6-luna", variant: "xhigh" } },
      ...project,
      ...host,
    });
  }
  assert.equal(parseModelRoutingConfig({ reviewer: { preferred: { model: "x", extra: true } } }), undefined);
  assert.deepEqual(resolvePluginConfiguration({ unknown: true }), { kind: "invalid" });
  assert.deepEqual(resolvePluginConfiguration({
    modelRouting: host,
    modelCatalog: { global: [{ model: "" }] },
  }), { kind: "invalid" });
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

test("recommended Luna routes cover exact installed roles and remain below project routing", () => {
  const defaults = resolvePluginConfigurationSources(undefined, undefined, {
    modelCatalog: { global: [
      { model: "openai/gpt-5.6-luna", variants: ["xhigh"] },
      { model: "provider/custom" },
    ] },
  });
  assert.equal(defaults.kind, "configured");
  if (defaults.kind !== "configured") return;
  assert.deepEqual(defaults.modelCatalog.global, [
    { model: DEDICATED_SOL_MODEL, variants: [DEDICATED_SOL_VARIANT] },
    { model: "openai/gpt-5.6-luna", variants: ["xhigh"] },
    { model: "provider/custom" },
  ]);
  assert.deepEqual(["dog-coordinator", "dog-scout"].map((role) => ({
    configured: defaults.modelRouting[role],
    resolved: resolveModelRoute({
      role,
      local: defaults.localModelRouting,
      global: defaults.globalModelRouting,
      catalog: defaults.modelCatalog,
    }),
  })), ["dog-coordinator", "dog-scout"].map((role) => ({
    configured: { preferred: { model: "openai/gpt-5.6-luna", variant: "xhigh" } },
    resolved: {
      ok: true,
      role,
      source: "global",
      catalog: "global",
      model: "openai/gpt-5.6-luna",
      variant: "xhigh",
    },
  })));

  const projectModel = "provider/project-coordinator";
  const overridden = resolvePluginConfigurationSources({
    modelRouting: { "dog-coordinator": { preferred: { model: projectModel } } },
    modelCatalog: { project: [{ model: projectModel }] },
  }, undefined, undefined);
  assert.equal(overridden.kind, "configured");
  if (overridden.kind !== "configured") return;
  assert.deepEqual(resolveModelRoute({
    role: "dog-coordinator",
    local: overridden.localModelRouting,
    global: overridden.globalModelRouting,
    catalog: overridden.modelCatalog,
  }), {
    ok: true,
    role: "dog-coordinator",
    source: "local",
    catalog: "project",
    model: projectModel,
  });
});

test("Mk2A2 routes only dedicated worker roles to Sol with stable fail-closed resolution", () => {
  const canonicalModel = "provider/canonical";
  const configured = resolvePluginConfigurationSources(
    { modelRouting: {
      implementation: { preferred: { model: canonicalModel } },
      "dog-worker": { preferred: { model: canonicalModel } },
    } },
    { modelRouting: {
      remediation: { preferred: { model: canonicalModel } },
      "dog-worker": { preferred: { model: canonicalModel } },
    } },
    {
      modelRouting: {
        "blocker-resolution": { preferred: { model: canonicalModel } },
        "dog-worker": { preferred: { model: canonicalModel } },
      },
      modelCatalog: { global: [{ model: canonicalModel }] },
    },
  );
  assert.equal(configured.kind, "configured");
  if (configured.kind !== "configured") return;

  assert.deepEqual([...DEDICATED_SOL_ROLES], [
    "implementation",
    "remediation",
    "blocker-resolution",
    "sol-worker-mk2a2",
    "dog-worker",
    "dog-advisor",
  ]);

  const resolveRole = (role: string) => resolveModelRoute({
    role,
    local: configured.localModelRouting,
    global: configured.globalModelRouting,
    catalog: configured.modelCatalog,
  });
  for (const role of DEDICATED_SOL_ROLES) {
    const expected = {
      ok: true,
      role,
      source: "local",
      catalog: "global",
      model: DEDICATED_SOL_MODEL,
      variant: DEDICATED_SOL_VARIANT,
    };
    assert.deepEqual(configured.modelRouting[role], {
      preferred: { model: DEDICATED_SOL_MODEL, variant: DEDICATED_SOL_VARIANT },
    }, `${role} public route must remain authoritative`);
    assert.deepEqual(resolveRole(role), expected);
    assert.deepEqual(resolveModelRoute({
      role,
      local: { ...configured.localModelRouting },
      global: { ...configured.globalModelRouting },
      catalog: {
        project: configured.modelCatalog.project === undefined
          ? undefined
          : [...configured.modelCatalog.project],
        global: configured.modelCatalog.global === undefined
          ? undefined
          : [...configured.modelCatalog.global],
      },
    }), expected, `${role} resume route must remain stable for equivalent fresh input`);
  }
  for (const role of ["coordinator", "planning", "reviewer", "scout", "unknown"]) {
    assert.deepEqual(resolveRole(role), {
      ok: false,
      role,
      reason: "unresolved-role",
      attempts: [],
    });
  }

  const missingSol = {
    ...configured,
    modelCatalog: { global: [{ model: canonicalModel }] },
  };
  for (const role of DEDICATED_SOL_ROLES) {
    assert.deepEqual(resolveModelRoute({
      role,
      local: missingSol.localModelRouting,
      global: missingSol.globalModelRouting,
      catalog: missingSol.modelCatalog,
    }), {
      ok: false,
      role,
      reason: "unresolved-role",
      attempts: [{
        source: "local",
        target: { model: DEDICATED_SOL_MODEL, variant: DEDICATED_SOL_VARIANT },
        reason: "model-unavailable",
      }],
    });
  }
});

test("generated dog-worker runtime asset selects the dedicated Sol model explicitly", () => {
  const dogWorker = runtimeAssets.find((asset) => asset.name === "dog-worker");
  assert.ok(dogWorker);
  assert.ok(dogWorker.content.startsWith(`---
description: Dedicated Sol worker for the canonical Mk2A2 coordinator
mode: subagent
model: ${DEDICATED_SOL_MODEL}
variant: ${DEDICATED_SOL_VARIANT}
---
`));
});

test("generated dog-advisor runtime asset selects Sol xhigh explicitly", () => {
  const dogAdvisor = runtimeAssets.find((asset) => asset.name === "dog-advisor");
  assert.ok(dogAdvisor);
  assert.ok(dogAdvisor.content.startsWith(`---
description: Focused technical advisor for dog-coordinator
mode: subagent
model: ${DEDICATED_SOL_MODEL}
variant: ${DEDICATED_SOL_VARIANT}
---
`));
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

async function activate(
  hooks: Awaited<ReturnType<typeof SortieDogsPlugin>>,
  sessionID = "plugin-session",
): Promise<void> {
  const chat = hooks["chat.message"];
  assert.ok(chat);
  await chat(
    { sessionID },
    { message: { model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: "/sortie task" }] },
  );
}

async function invokeWrite(
  hooks: Awaited<ReturnType<typeof SortieDogsPlugin>>,
  target: string,
): Promise<void> {
  await activate(hooks);
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

test("chat message hook applies explicit catalog routing and fails closed with ordered attempts", async () => {
  await withProject("model-routing-hook", async (directory) => {
    await mkdir(join(directory, ".opencode"));
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    await writeFile(join(directory, ".opencode", "sortie-dogs.json"), JSON.stringify({
      modelRouting: {
        implementer: { preferred: { model: "provider/local-primary", variant: "thinking" } },
        reviewer: {
          preferred: { model: "provider/local-missing" },
          fallback: [{ model: "provider/variant", variant: "missing" }],
        },
      },
    }));
    const hooks = await SortieDogsPlugin({ directory }, {
      modelRouting: {
        implementer: { preferred: { model: "provider/global-primary", variant: "thinking" } },
        reviewer: {
          preferred: { model: "provider/global-missing" },
          fallback: [{ model: "provider/variant", variant: "also-missing" }],
        },
      },
      modelCatalog: { global: [
        { model: "openai/gpt-5.6-luna", variants: ["xhigh"] },
        { model: "provider/local-primary", variants: ["thinking"] },
        { model: "provider/global-primary", variants: ["thinking"] },
        { model: "provider/variant", variants: ["valid"] },
      ] },
    });
    const chat = hooks["chat.message"];
    assert.ok(chat);
    const output = {
      message: { agent: "implementer", model: { providerID: "old", modelID: "old", variant: "old" } },
      parts: [{ type: "text", text: "/sortie route" }],
    };
    await chat({ sessionID: "routing", agent: "implementer" }, output);
    assert.deepEqual(output.message.model, { providerID: "provider", modelID: "local-primary", variant: "thinking" });
    const unclassified = { message: { model: { providerID: "host", modelID: "preserved" } }, parts: [] };
    await chat({ sessionID: "routing" }, unclassified);
    assert.deepEqual(unclassified.message.model, { providerID: "host", modelID: "preserved" });
    const unconfigured = {
      message: { agent: "planning", model: { providerID: "host", modelID: "session-fallback" } },
      parts: [],
    };
    await chat({ sessionID: "routing", agent: "planning" }, unconfigured);
    assert.deepEqual(unconfigured.message.model, { providerID: "host", modelID: "session-fallback" });
    const recommended = {
      message: { agent: "dog-scout", model: { providerID: "host", modelID: "selected" } },
      parts: [],
    };
    await chat({ sessionID: "routing", agent: "dog-scout" }, recommended);
    assert.deepEqual(recommended.message.model, {
      providerID: "openai",
      modelID: "gpt-5.6-luna",
      variant: "xhigh",
    });
    await assert.rejects(
      () => chat({ sessionID: "routing", agent: "reviewer" }, output),
      (error: unknown) => {
        assert.ok(error instanceof ModelRoutingDeniedError);
        assert.equal(error.reason, "unresolved-role");
        assert.deepEqual(error.attempts, [
          { source: "local", target: { model: "provider/local-missing" }, reason: "model-unavailable" },
          { source: "local", target: { model: "provider/variant", variant: "missing" }, reason: "variant-unavailable" },
          { source: "global", target: { model: "provider/global-missing" }, reason: "model-unavailable" },
          { source: "global", target: { model: "provider/variant", variant: "also-missing" }, reason: "variant-unavailable" },
        ]);
        return true;
      },
    );
  });
});

test("session policy is passive until an exact trigger and deactivates on idle or end", async () => {
  await withProject("session-activation", async (directory) => {
    const hooks = await SortieDogsPlugin({ directory });
    const before = hooks["tool.execute.before"];
    const chat = hooks["chat.message"];
    const event = hooks.event;
    assert.ok(before);
    assert.ok(chat);
    assert.ok(event);
    const write = (sessionID: string) => before(
      { tool: "write", sessionID, callID: "activation" },
      { args: { file: "outside.txt", content: "not-written" } },
    );
    const message = (sessionID: string, text: string, agent?: string) => chat(
      { sessionID, agent },
      { message: { agent, model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text }] },
    );

    await write("passive");
    await message("passive", "/sortie-other");
    await write("passive");
    await message("passive", "/sortie task");
    await message("passive", "/sortie task");
    const isolatedHooks = await SortieDogsPlugin({ directory });
    const isolatedBefore = isolatedHooks["tool.execute.before"];
    assert.ok(isolatedBefore);
    await isolatedBefore(
      { tool: "write", sessionID: "passive", callID: "isolated" },
      { args: { file: "outside.txt", content: "not-written" } },
    );
    await expectMessage(() => write("passive"), 'Write denied for "<unknown>": operation manifest unavailable.', "manifest-unavailable");
    await assert.rejects(event({ event: { type: "session.idle", properties: { sessionID: "passive" } } }));
    await expectMessage(() => write("passive"), 'Write denied for "<unknown>": operation manifest unavailable.', "manifest-unavailable");
    await event({ event: { type: "session.deleted", properties: { sessionID: "passive" } } });
    await write("passive");

    await message("coordinator", "ordinary text", "dog-coordinator");
    await expectMessage(() => write("coordinator"), 'Write denied for "<unknown>": operation manifest unavailable.', "manifest-unavailable");
    await event({ event: { type: "session.deleted", properties: { sessionID: "coordinator" } } });
    await write("coordinator");
    await message("malformed", "/sortie task");
    await event({ event: { type: "session.deleted", properties: {} } });
  });
});

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

test("plugin gate allows directory descendants without allowing prefixed siblings", async () => {
  await withProject("directory-write-scope", async (directory) => {
    await mkdir(join(directory, "_testenv"));
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify({
      ...fixture.manifest,
      write: ["_testenv", "_future"],
    }));
    const hooks = await SortieDogsPlugin({ directory });

    await invokeWrite(hooks, "_testenv/result.json");
    await expectMessage(
      () => invokeWrite(hooks, "undeclared/result.json"),
      'Write denied for "undeclared/result.json": operation manifest write scope.',
      "manifest-scope",
    );
    await expectMessage(
      () => invokeWrite(hooks, "_testenv-sibling/result.json"),
      'Write denied for "_testenv-sibling/result.json": operation manifest write scope.',
      "manifest-scope",
    );
    await expectMessage(
      () => invokeWrite(hooks, "_future/result.json"),
      'Write denied for "_future/result.json": operation manifest write scope.',
      "manifest-scope",
    );
  });
});

test("plugin gate denies directory-scope writes routed through an escaping symlink", async () => {
  await withProject("directory-write-scope-symlink", async (directory) => {
    const scope = join(directory, "_testenv");
    const outsideScope = join(directory, "other");
    await mkdir(scope);
    await mkdir(outsideScope);
    await symlink(outsideScope, join(scope, "link"), process.platform === "win32" ? "junction" : "dir");
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify({
      ...fixture.manifest,
      write: ["_testenv"],
    }));
    const hooks = await SortieDogsPlugin({ directory });

    await expectMessage(
      () => invokeWrite(hooks, "_testenv/link/result.json"),
      'Write denied for "_testenv/link/result.json": operation manifest write scope.',
      "manifest-scope",
    );
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
      { permission: "edit", patterns: [join("u3-rpt", "allowed.txt")], sessionID: "plugin-session" },
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
    await expectMessage(
      () => permission(
        { permission: "edit", patterns: [join("u3-rpt", "denied.txt")], sessionID: "plugin-session" },
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
    await activate(hooks, "shell");
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
    await invoke('env -u GITHUB_TOKEN "/approved/gh.exe" project item-list 1 --owner example');
    await invoke('env -u GITHUB_TOKEN "/approved/gh.exe" project item-edit --id ITEM --field-id FIELD --single-select-option-id OPTION');
    await invoke('env -u GITHUB_TOKEN "/approved/gh.exe" api graphql -f query="query { viewer { login } }"');
    await invoke('env -u GITHUB_TOKEN "/approved/gh.exe" api graphql -f query="mutation { placeholder }"');
    await invoke("git branch --show-current");
    await expectMessage(
      () => invoke("env -u GITHUB_TOKEN node -e write"),
      'Write denied for "<unknown>": write path must be explicit.',
      "path-required",
    );
    await expectMessage(
      () => invoke("git branch feature"),
      'Write denied for "<unknown>": write path must be explicit.',
      "path-required",
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
    const before = hooks["tool.execute.before"];
    assert.ok(event);
    assert.ok(before);
    await activate(hooks, "one");
    const edited = { event: { type: "file.edited", properties: { file: "handoff.json", sessionID: "one" } } };

    // Missing changed-path evidence produces only M007; the plugin rejects errors, not warnings.
    await event(edited);
    await event({ event: { type: "session.idle", properties: { sessionID: "one" } } });
    await before(
      { tool: "write", sessionID: "one", callID: "idle-cleanup" },
      { args: { file: "outside.txt", content: "not-written" } },
    );
    await activate(hooks, "one");
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
