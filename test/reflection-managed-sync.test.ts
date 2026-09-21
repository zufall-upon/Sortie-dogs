import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { syncProjectReflectionBlock } from "../dist/reflection/managed-sync.js";
import { REFLECTION_MANAGED_BLOCK_MAX_BYTES, REFLECTION_MANAGED_BLOCK_START, REFLECTION_MANAGED_BLOCK_END,
  V010_REFLECTION_MANAGED_BLOCK_START, V010_REFLECTION_MANAGED_BLOCK_END, renderManagedReflectionBlock } from "../dist/reflection/managed-block.js";
import { SortieDogsPlugin } from "../dist/plugin/index.js";
import type { ReflectionEntry } from "../dist/reflection/store.js";

const root = fileURLToPath(new URL(`../_testenv/reflection-sync-${process.platform}-${process.pid}/`, import.meta.url));
const digest = (bytes: Buffer): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const entry = (scope = "safe", hits = 2): ReflectionEntry => ({ id: `id-${scope}`, scope, hits,
  trigger: "private-trigger", cause: "private-cause", prevention: `Check ${scope} before proceeding.`,
  evidence: "repeated-process-failure", evidenceRef: "private-ref", firstSeen: "2026-09-06T00:00:00Z",
  lastSeen: "2026-09-06T00:00:00Z", status: "promotable" });
const control = (directory: string) => join(directory, ".sortie-dogs", "reflection-maintenance");
async function fixture(name: string) { return mkdtemp(join(root, `${name}-`)); }
test.before(async () => { await mkdir(root, { recursive: true }); });
test.after(async () => { await rm(root, { recursive: true, force: true }); });

test("synchronizes only qualifying prevention text with scope dedupe, entry/byte bounds and exact outside bytes", async () => {
  const projectRoot = await fixture("selection");
  const agents = join(projectRoot, "AGENTS.md");
  const outside = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf, 0xff]), Buffer.from("User rules\r\n")]);
  await writeFile(agents, outside);
  const entries = [entry("duplicate", 9), entry("duplicate", 8),
    ...Array.from({ length: 7 }, (_, i) => entry(`scope-${i}`)),
    { ...entry("unqualified", 1), status: "active" as const }];
  assert.deepEqual(await syncProjectReflectionBlock({ projectRoot, entries, activeBatch: false }), { kind: "updated", entries: 5 });
  const first = await readFile(agents);
  assert.ok(first.subarray(0, outside.length).equals(outside));
  const managed = first.subarray(outside.length);
  assert.ok(managed.length <= REFLECTION_MANAGED_BLOCK_MAX_BYTES);
  assert.equal(managed.toString().split("\n").filter((line) => line.startsWith("- ")).length, 5);
  for (const forbidden of ["private-trigger", "private-cause", "private-ref", "id-duplicate", "unqualified"]) {
    assert.equal(managed.includes(forbidden), false);
  }
  const suffix = Buffer.from("\r\nUser suffix\r\n\0");
  await writeFile(agents, Buffer.concat([first, suffix]));
  assert.equal((await syncProjectReflectionBlock({ projectRoot, entries: [...entries].reverse(), activeBatch: false })).kind, "unchanged");
  assert.ok((await readFile(agents)).equals(Buffer.concat([first, suffix])));
  const manifest = JSON.parse(await readFile(join(control(projectRoot), "operation-manifest.json"), "utf8"));
  assert.deepEqual(manifest.write, ["AGENTS.md", ".sortie-dogs/reflection-maintenance"]);
  assert.ok(renderManagedReflectionBlock(["x".repeat(5000)]).length <= REFLECTION_MANAGED_BLOCK_MAX_BYTES);
});

test("active batches and opt-out never modify instructions; explicit scope exclusion and forget remove entries", async () => {
  const projectRoot = await fixture("controls");
  const agents = join(projectRoot, "AGENTS.md");
  const original = Buffer.from("User content\r\n");
  await writeFile(agents, original);
  const input = { projectRoot, entries: [entry()], activeBatch: true };
  assert.deepEqual(await syncProjectReflectionBlock(input), { kind: "deferred", reason: "active-batch" });
  assert.deepEqual(await syncProjectReflectionBlock({ ...input, profile: "v010" }), { kind: "deferred", reason: "active-batch" });
  assert.ok((await readFile(agents)).equals(original));
  await assert.rejects(readFile(join(projectRoot, ".sortie-dogs-v010/reflection-maintenance/operation-manifest.json")), { code: "ENOENT" });
  assert.deepEqual(await syncProjectReflectionBlock({ ...input, activeBatch: false, syncEnabled: false }),
    { kind: "deferred", reason: "sync-stopped" });
  assert.equal((await syncProjectReflectionBlock({ ...input, activeBatch: false })).kind, "updated");
  await writeFile(join(control(projectRoot), "options.json"), JSON.stringify({ excludedScopes: ["safe"] }));
  assert.deepEqual(await syncProjectReflectionBlock({ ...input, activeBatch: false }), { kind: "updated", entries: 0 });
  assert.equal((await readFile(agents, "utf8")).includes("Check safe"), false);
  await writeFile(join(control(projectRoot), "options.json"), "{}");
  await syncProjectReflectionBlock({ ...input, activeBatch: false });
  assert.deepEqual(await syncProjectReflectionBlock({ ...input, activeBatch: false, entries: [] }), { kind: "updated", entries: 0 });
  assert.ok((await readFile(agents)).subarray(0, original.length).equals(original));
  assert.equal((await syncProjectReflectionBlock({ ...input, activeBatch: false, entries: [] })).kind, "unchanged");
});

test("manual drift, unknown blocks, malformed markers, unapproved manifests, and lock contention produce proposals", async () => {
  for (const scenario of ["drift", "unrecorded", "markers", "manifest", "locked"]) {
    const projectRoot = await fixture(scenario);
    const agents = join(projectRoot, "AGENTS.md");
    const input = { projectRoot, entries: [entry()], activeBatch: false };
    await syncProjectReflectionBlock(input);
    if (scenario === "drift") await writeFile(agents, (await readFile(agents, "utf8")).replace("Check safe", "User change"));
    if (scenario === "unrecorded") await rm(join(control(projectRoot), "state.json"));
    if (scenario === "markers") await writeFile(agents, `${REFLECTION_MANAGED_BLOCK_START}\n${REFLECTION_MANAGED_BLOCK_START}\n${REFLECTION_MANAGED_BLOCK_END}`);
    if (scenario === "manifest") await writeFile(join(control(projectRoot), "operation-manifest.json"), JSON.stringify({ write: [] }));
    if (scenario === "locked") await writeFile(join(control(projectRoot), "sync.lock"), "other owner");
    const before = await readFile(agents);
    assert.equal((await syncProjectReflectionBlock(input)).kind, "proposal", scenario);
    assert.ok((await readFile(agents)).equals(before), scenario);
    assert.equal(JSON.parse(await readFile(join(control(projectRoot), "proposal.json"), "utf8")).kind, "proposal");
  }
});

test("concurrent sync and restart recover atomic-write response loss without rewriting user regions", async () => {
  const projectRoot = await fixture("restart");
  const agents = join(projectRoot, "AGENTS.md");
  const original = Buffer.from("Original\r\n");
  await writeFile(agents, original);
  const input = { projectRoot, entries: [entry()], activeBatch: false };
  const results = await Promise.all([syncProjectReflectionBlock(input), syncProjectReflectionBlock(input)]);
  assert.equal(results.filter(({ kind }) => kind === "updated").length, 1);
  assert.ok(results.every(({ kind }) => ["updated", "unchanged", "proposal"].includes(kind)));
  const after = await readFile(agents);
  const statePath = join(control(projectRoot), "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  await writeFile(statePath, JSON.stringify({ blockHash: null,
    pending: { before: digest(original), after: digest(after), blockHash: state.blockHash } }));
  assert.equal((await syncProjectReflectionBlock(input)).kind, "unchanged");
  assert.ok((await readFile(agents)).equals(after));
  // A manual rollback is drift, not authorization to restore generated instructions.
  await writeFile(agents, original);
  assert.equal((await syncProjectReflectionBlock(input)).kind, "proposal");
  assert.ok((await readFile(agents)).equals(original));
});

test("maintenance refuses a control directory redirected outside its approved project", async () => {
  const projectRoot = await fixture("symlink-project");
  const outside = await fixture("symlink-outside");
  await symlink(outside, join(projectRoot, ".sortie-dogs"), process.platform === "win32" ? "junction" : "dir");
  const result = await syncProjectReflectionBlock({ projectRoot, entries: [entry()], activeBatch: false });
  assert.equal(result.kind, "proposal");
  assert.deepEqual(await readdir(outside), []);
});

test("stable and v0.10 managed blocks coexist with isolated controls and escaped cross-profile markers", async () => {
  const projectRoot = await fixture("profile-isolation");
  const agents = join(projectRoot, "AGENTS.md");
  const stableEntry = { ...entry("stable-profile"),
    prevention: `Keep stable text away from ${V010_REFLECTION_MANAGED_BLOCK_START} and ${V010_REFLECTION_MANAGED_BLOCK_END}.` };
  const previewEntry = { ...entry("v010-profile"),
    prevention: `Keep preview text away from ${REFLECTION_MANAGED_BLOCK_START} and ${REFLECTION_MANAGED_BLOCK_END}.` };

  assert.equal((await syncProjectReflectionBlock({ projectRoot, entries: [stableEntry], activeBatch: false })).kind, "updated");
  assert.equal((await syncProjectReflectionBlock({ projectRoot, entries: [previewEntry], activeBatch: false, profile: "v010" })).kind, "updated");
  const first = await readFile(agents, "utf8");
  assert.equal(first.split(REFLECTION_MANAGED_BLOCK_START).length - 1, 1);
  assert.equal(first.split(REFLECTION_MANAGED_BLOCK_END).length - 1, 1);
  assert.equal(first.split(V010_REFLECTION_MANAGED_BLOCK_START).length - 1, 1);
  assert.equal(first.split(V010_REFLECTION_MANAGED_BLOCK_END).length - 1, 1);
  assert.ok(first.includes("&lt;!-- sortie-dogs-v010:reflection-managed:start -->"));
  assert.ok(first.includes("&lt;!-- sortie-dogs:reflection-managed:start -->"));

  assert.equal((await syncProjectReflectionBlock({ projectRoot, entries: [stableEntry], activeBatch: false })).kind, "unchanged");
  assert.equal((await syncProjectReflectionBlock({ projectRoot, entries: [previewEntry], activeBatch: false, profile: "v010" })).kind, "unchanged");
  assert.equal(await readFile(agents, "utf8"), first);
  const stableManifest = JSON.parse(await readFile(join(projectRoot, ".sortie-dogs/reflection-maintenance/operation-manifest.json"), "utf8"));
  const previewManifest = JSON.parse(await readFile(join(projectRoot, ".sortie-dogs-v010/reflection-maintenance/operation-manifest.json"), "utf8"));
  assert.deepEqual(stableManifest.write, ["AGENTS.md", ".sortie-dogs/reflection-maintenance"]);
  assert.deepEqual(previewManifest.write, ["AGENTS.md", ".sortie-dogs-v010/reflection-maintenance"]);
});

test("coordinator terminal checkpoint auto-syncs project reflections without a sync tool or an ON action", async () => {
  const projectRoot = await fixture("plugin");
  const xdg = await fixture("xdg");
  const saved = { xdg: process.env.XDG_CONFIG_HOME, config: process.env.SORTIE_DOGS_CONFIG, reflection: process.env.SORTIE_REFLECTION };
  process.env.XDG_CONFIG_HOME = xdg;
  delete process.env.SORTIE_DOGS_CONFIG;
  delete process.env.SORTIE_REFLECTION;
  const client = { session: { get: async () => ({ data: { agent: "dog-coordinator" } }) } } as never;
  try {
    const hooks = await SortieDogsPlugin({ directory: projectRoot, client }, { reflection: { enabled: true, layers: { global: true } } });
    await hooks["chat.message"]!({ sessionID: "root", agent: "dog-coordinator" }, { message: { model: {} }, parts: [{ type: "text", text: "work" }] });
    const record = hooks.tool!.sortie_reflection.execute;
    const args = { action: "record", layer: "project", scope: "project-check", trigger: "trigger", cause: "cause",
      prevention: "Check the accepted base before editing.", evidence: "user-correction", evidenceRef: "fixture" };
    const accepted = JSON.parse(await record(args, { sessionID: "root", agent: "dog-coordinator" }));
    await record({ ...args, layer: "run", scope: "run-only", prevention: "Do not export run data." }, { sessionID: "root", agent: "dog-coordinator" });
    await record({ ...args, layer: "global", scope: "global-only", prevention: "Do not export global data." }, { sessionID: "root", agent: "dog-coordinator" });
    await record({ ...args, scope: "not-ready", evidence: "repeated-process-failure", prevention: "Single observation only." }, { sessionID: "root", agent: "dog-coordinator" });
    const terminal = { text: "\u2705 **DONE** `fixture`\n\n**Next:** none" };
    const taskArgs = { subagent_type: "dog-worker", description: "fixture only", prompt: [
      "task_id: worker-fixture", "role: implementation", `project_root: ${projectRoot}`,
      "source_manifest: [\"AGENTS.md\"]", "acceptance: Read the fixture only.",
      "validation: read-only", "operation_manifest: none",
    ].join("\n") };
    await hooks["tool.execute.before"]!({ sessionID: "root", tool: "task", callID: "fixture-task" }, { args: taskArgs });
    await hooks["experimental.text.complete"]!({ sessionID: "root" }, { text: terminal.text });
    await assert.rejects(readFile(join(projectRoot, "AGENTS.md")), { code: "ENOENT" });
    await hooks["tool.execute.after"]!({ sessionID: "root", tool: "task", callID: "fixture-task", args: taskArgs }, { output: "fixture complete" });
    await hooks["experimental.text.complete"]!({ sessionID: "root" }, terminal);
    const agents = join(projectRoot, "AGENTS.md");
    const first = await readFile(agents, "utf8");
    assert.ok(first.includes(args.prevention));
    assert.equal(first.includes("Do not export run data."), false);
    assert.equal(first.includes("Do not export global data."), false);
    assert.equal(first.includes("Single observation only."), false);
    const next = await SortieDogsPlugin({ directory: projectRoot, client }, { reflection: { enabled: true } });
    await next["chat.message"]!({ sessionID: "next", agent: "dog-coordinator" }, { message: { model: {} }, parts: [{ type: "text", text: "work" }] });
    await next["experimental.text.complete"]!({ sessionID: "next" }, { text: terminal.text });
    assert.equal(await readFile(agents, "utf8"), first);
    await next.tool!.sortie_reflection.execute({ action: "forget", layer: "project", id: accepted.id }, { sessionID: "next", agent: "dog-coordinator" });
    await next["experimental.text.complete"]!({ sessionID: "next" }, { text: terminal.text });
    assert.equal((await readFile(agents, "utf8")).includes(args.prevention), false);
  } finally {
    for (const [key, value] of [["XDG_CONFIG_HOME", saved.xdg], ["SORTIE_DOGS_CONFIG", saved.config], ["SORTIE_REFLECTION", saved.reflection]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  }
});
