import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import test from "node:test";
import { OperatorMissionRuntime, missionConversationContext } from "../dist/core/operator-mission.js";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";
import { nativeContractReadView } from "../dist/plugin/native-contract-read.js";
import { retainMissionContext, missionContextView } from "../dist/core/mission-context.js";

const exec = promisify(execFile);
const text = (id: string, role: string, value: string) => ({ info: { id, role }, parts: [{ type: "text", text: value }] });
// Anonymous one-pixel image; never copy the private incident's requests or images into fixtures.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/wAAAABJRU5ErkJggg==", "base64");
const file = (id: string) => ({ type: "file", id, mime: "image/png", filename: "reference.png", url: `data:image/png;base64,${png.toString("base64")}` });
async function fixture(run: (directory: string) => Promise<void>) {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/mission-context-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("public continuity retains old/long text and tool results across cold/partial history without manufacturing validation", async () => fixture(async directory => {
  const original = "Continue the selected target";
  const long = "known environment\n".repeat(500) + "EXACT_LATE_PATH=C:/ready/package.tgz  ";
  const output = "diagnostic\n".repeat(200) + "EXACT_FAILURE: reuse configured helper";
  const history = [text("old-target", "user", "Pinned target v0.13.12"),
    ...Array.from({ length: 10 }, (_, i) => text(`turn-${i}`, i % 2 ? "assistant" : "user", `decision ${i}`)),
    { info: { id: "known", role: "assistant" }, parts: [{ type: "text", text: long },
      { type: "reasoning", text: "PRIVATE_REASONING" }, { type: "text", synthetic: true, text: "SYNTHETIC_INSTRUCTION" },
      { type: "tool", tool: "shell", callID: "setup", state: { status: "completed", input: { command: "node setup.mjs" },
        output, metadata: { exit: 1 } } }] }, text("request", "user", original)];
  let runtime = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  await runtime.capture("root", { id: "request", text: original });
  await runtime.start("root", [original], false, { context: missionConversationContext(history) });
  const captured = await runtime.retainContext("root", "root", history, "Setup exists; use configured helper, then remaining check.");
  const source = captured.continuity!.sources[0]!;
  const archive = JSON.parse(await readFile(source.path, "utf8"));
  assert.equal(archive.entries[0].text, "Pinned target v0.13.12");
  assert.equal(archive.entries.at(-2).text, long);
  assert.equal(archive.entries.at(-2).tools[0].output, output);
  assert.doesNotMatch(JSON.stringify(archive), /PRIVATE_REASONING|SYNTHETIC_INSTRUCTION/);
  runtime = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const updated = await runtime.retainContext("root", "root", [text("later", "assistant", "Only remaining edit is result.txt")]);
  const view = await runtime.handoffContext(updated) as any;
  const inline = view.continuity.sources[0];
  assert(inline.omitted_text_entries > 0);
  assert.equal(inline.conversation.find((entry: any) => entry.id === "known").truncated, true);
  assert.equal(inline.recent_tools[0].truncated, true);
  assert.equal(inline.recent_tools[0].exit, 1);
  assert.equal(view.continuity.notes[0].text, "Setup exists; use configured helper, then remaining check.");
  assert.deepEqual(view.original_requests, [{ id: "request", text: original }]);
  assert.deepEqual(view.requirements, [{ id: "R1", text: original }]);
  assert.equal(updated.phase, "open");
  assert.equal(updated.runID, null);
  assert.equal(updated.execution, undefined, "history cannot count as execution/validation");
  assert.equal(JSON.parse(await readFile(source.path, "utf8")).entries.length, history.length, "old snapshot remains exact");
  const unavailable = await runtime.retainContext("root", "root", []);
  assert.equal(unavailable.continuity!.sources[0]!.sha256, updated.continuity!.sources[0]!.sha256);
  assert.equal(unavailable.continuity!.sources[0]!.history_available, false);
  await rm(unavailable.continuity!.sources[0]!.path);
  const missing = await runtime.handoffContext(unavailable) as any;
  assert.equal(missing.continuity.sources[0].snapshot_available, false, "missing optional history is visible, not an admission blocker");
  assert(missing.conversation.length > 0, "legacy public text remains available");
  const restored = await runtime.retainContext("root", "root", [...history, text("later", "assistant", "Only remaining edit is result.txt")]);
  assert.equal(restored.continuity!.sources[0]!.sha256, updated.continuity!.sources[0]!.sha256);
  assert.equal(JSON.parse(await readFile(restored.continuity!.sources[0]!.path, "utf8")).entries.length, history.length + 1);
}));

test("original attachment bytes and message order survive file-only, compacted and cold handoffs without a history gate", async () => fixture(async directory => {
  const history = [{ info: { id: "references", role: "user" }, parts: [file("first"), file("second")] },
    text("request", "user", "Compare the reference design with the actual desktop/mobile screens.")];
  const first = await retainMissionContext(directory, "root", history);
  assert.equal(first.entries.length, 2, "attachment-only messages must not disappear");
  const refs = first.source.attachments!;
  assert.deepEqual(refs.map(ref => [ref.message_id, ref.index, ref.part_id]), [["references", 0, "first"], ["references", 1, "second"]]);
  assert.equal(refs[0]!.path, refs[1]!.path, "identical bytes share storage, not attachment identity/order");
  assert.equal(refs[0]!.sha256, createHash("sha256").update(png).digest("hex"));
  assert.deepEqual(await readFile(refs[0]!.path!), png);
  assert(!JSON.stringify(first).includes(png.toString("base64")), "handoffs carry read references, not repeated inline payloads");
  const partial = await retainMissionContext(directory, "root", [text("references", "user", "Compacted text only")], first.source);
  assert.deepEqual(partial.source.attachments, refs, "the same message without files must not erase retained originals");
  const cold = await retainMissionContext(directory, "root", [], JSON.parse(JSON.stringify(partial.source)));
  assert.equal(cold.source.history_available, false);
  assert.deepEqual(missionContextView(cold.source, cold.entries, ["request"]).attachments, refs);
  const uri = "https://example.invalid/original.pdf";
  const external = await retainMissionContext(directory, "root", [{ info: { id: "external", role: "user" },
    parts: [{ type: "file", url: uri, mime: "application/pdf" }] }]);
  assert.equal(external.source.attachments![0]!.url, uri, "retain references without fetching or adding an availability gate");
}));

for (const mode of ["root", "coordinator", "unavailable-history"]) test(`${mode} passes available context into the native Worker read without a history gate`, async () => fixture(async directory => {
  const actor = mode === "coordinator" ? "coordinator" : "root";
  await exec("git", ["init", "--quiet"], { cwd: directory });
  await writeFile(join(directory, "check.mjs"), "import {existsSync} from 'node:fs'; if (!existsSync('result.txt')) process.exit(1);\n");
  const agents: Record<string, { agent: string; parentID?: string }> = {
    root: { agent: "dog-operator" }, coordinator: { agent: "dogs-coordinator", parentID: "root" },
    worker: { agent: "dog-worker-v010", parentID: actor },
  };
  const history: Record<string, Record<string, unknown>[]> = { root: [text("decision", "assistant", "Use existing ready helper; do not reinstall."),
    { info: { id: "original-reference", role: "user" }, parts: [file("reference-file")] }] };
  const hooks = await SortieDogsV010Plugin({ directory, client: { session: {
    get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...agents[path.id] } }),
    messages: async ({ path }: { path: { id: string } }) => {
      if (mode === "unavailable-history") throw new Error("all history unavailable");
      return { data: actor === "root" ? history[path.id] ?? [] : [] };
    },
    reviewMessages: async ({ path }: { path: { id: string } }) => {
      if (actor === "root") throw new Error("paginated history unavailable");
      return { data: history[path.id] ?? [] };
    },
    children: async () => ({ data: [] }),
  } } } as never);
  const prompt = async (id: string, value: string) => hooks["chat.message"]!({ sessionID: id, messageID: `${id}-request`, agent: agents[id]!.agent }, {
    message: { id: `${id}-request`, agent: agents[id]!.agent, model: { providerID: "openai", modelID: "gpt-6.1-sol" } },
    parts: [{ type: "text", text: value }],
  });
  await prompt("root", "Create result.txt, check with node check.mjs.");
  const started = JSON.parse(await hooks.tool!.sortie_v010_start_mission.execute({ requirements: ["Create validated result"],
    handoff_context: "User intent: reuse installed package and finish result." }, { sessionID: "root" }));
  if (actor === "coordinator") {
    const task = { args: structuredClone(started.task) };
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" }, task);
    await prompt(actor, task.args.prompt);
    history.coordinator = [text("rationale", "assistant", "Only result.txt needs change; helper already checked.")];
  }
  history.root!.push({ info: { id: "fresh-tool", role: "assistant" }, parts: [{ type: "tool", tool: "shell", callID: "ready",
    state: { status: "completed", input: { command: "node helper.mjs --status" }, output: "READY_EXISTING", metadata: { exit: 0 } } }] });
  const planned = JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ handoff_context: "Remaining: write result, run check. Prior failure: wrong helper path.",
    units: [{ title: "Create result", objective: "Finish result", read: ["check.mjs"], write: ["result.txt"], validation: ["node check.mjs"] }] }, { sessionID: actor }));
  const task = { args: structuredClone(planned.task) };
  await hooks["tool.execute.before"]!({ tool: "task", sessionID: actor, callID: "worker-call" }, task);
  await prompt("worker", task.args.prompt);
  const run = await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root");
  const unit = run.units[0]!;
  const handoff = JSON.parse(await readFile(unit.handoffPath, "utf8"));
  const continuity = handoff.ext["sortie-dogs/mission-context"].continuity;
  const native = await nativeContractReadView(directory, { path: unit.handoffPath });
  if (mode !== "unavailable-history") {
    assert.match(native!, /Use existing ready helper; do not reinstall/);
    assert.match(native!, /READY_EXISTING/);
    const original = continuity.sources.find((source: any) => source.session_id === "root").attachments[0];
    assert.equal(original.message_id, "original-reference");
    assert.equal(original.index, 0);
    assert.match(native!, new RegExp(original.sha256));
    assert.deepEqual(await readFile(original.path), png, "the actual Worker handoff points at readable original image bytes");
  } else assert.equal(continuity.sources[0].history_available, false);
  assert.match(native!, /Prior failure: wrong helper path/);
  if (actor === "coordinator") {
    assert.match(native!, /Only result.txt needs change/);
    assert.match(native!, /User intent: reuse installed package/);
  }
  assert.equal(continuity.sources.length, actor === "root" ? 1 : 2);
  assert.deepEqual(unit.unit.validation, ["node check.mjs"]);
  assert.equal(run.receipt, null);
  assert.deepEqual(unit.evidence, [], "inherited tool success is not current validation");
}));
