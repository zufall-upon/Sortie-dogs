import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { MissionGripController } from "../dist/plugin/grip.js";
import { GRIP_POLICY } from "../dist/core/grip.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { OperatorMissionRuntime } from "../dist/core/operator-mission.js";
import { runtimeAssets } from "../dist/runtime-assets-v010.js";

const question = (id: string, header = "Grip", sessionID = "root") => ({ tool: "question", id, sessionID,
  input: { questions: [{ header, question: "今回の判断：方式AかBか？\nなぜ今：次のUXが変わるため。",
    options: [{ label: "A", description: "早いが機能を後回し" }, { label: "B", description: "広いが費用増" }] }] } });
const answer = (q: ReturnType<typeof question>, label: string, status = "completed") => ({ ...q, status,
  result: { content: `native question answer`, metadata: { answers: [[label]] } } });
async function fixture() {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/grip-"));
  const sessions: Record<string, unknown> = { root: { agent: "dog-operator" },
    coordinator: { agent: "dogs-coordinator", parentID: "root" }, worker: { agent: "dog-worker-v010", parentID: "root" },
    other: { agent: "build" } };
  const history: Record<string, unknown[]> = {};
  const create = () => new MissionGripController(directory, async id => sessions[id], async id => history[id] ?? []);
  const controller = create(), missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "original", text: "作業を速く・安く・楽に完了する。\n  原文の空白も保持。" });
  await missions.start("root", ["元の目的を守る"]);
  await missions.update("root", m => { m.coordinator = "coordinator"; });
  return { controller, create, missions, history, dispose: () => rm(directory, { recursive: true, force: true }) };
}

test("Grip augments only explicit active-Mission controller single choices, preserving normal labels and native inputs", async () => {
  const f = await fixture();
  try {
    for (const q of [question("path", "入力"), question("worker", "Grip", "worker"), question("other", "Grip", "other")]) {
      const original = structuredClone(q); await f.controller.before(q); assert.deepEqual(q, original);
    }
    const multiple = question("multiple"); Object.assign(multiple.input.questions[0]!, { multiple: true });
    const original = structuredClone(multiple); await f.controller.before(multiple); assert.deepEqual(multiple, original);
    const q = question("current");
    await f.controller.before(q); await f.controller.before(q);
    assert.match(q.input.questions[0]!.question, /^元の目的（原文抜粋）: 作業を速く・安く・楽に完了する。\n\n今回の判断/u);
    assert.deepEqual(q.input.questions[0]!.options.map(q => q.label), ["A", "B", "目的に戻って外部相談"]);
    assert.ok(q.input.questions[0]!.question.length + q.input.questions[0]!.options.map(q => q.label + q.description).join("").length < 300);
    const before = await f.missions.required("root");
    await f.controller.after(answer(q, "A"));
    assert.equal(await f.controller.pending("root"), undefined);
    assert.deepEqual((await f.missions.required("root")).requests, before.requests);
    assert.deepEqual((await f.missions.required("root")).requirements, before.requirements);
  } finally { await f.dispose(); }
});

test("consultation holds survive reload; only the corresponding fresh listed choice resumes, never advice or replay", async () => {
  const f = await fixture();
  try {
    const q = question("original-question", "Grip", "coordinator");
    await f.controller.before(q);
    const packet = await f.controller.after(answer(q, "目的に戻って外部相談"));
    assert.equal(packet!.external_delivery, "not-sent");
    assert.equal(packet!.consultation_requested, true);
    const cold = f.create(), pending = await cold.pending("root");
    assert.deepEqual(pending, packet);
    for (const tool of ["sortie_v010_plan_units", "sortie_v010_start_mission", "sortie_v010_operator_next", "sortie_v010_complete_mission", "edit"]) {
      await assert.rejects(cold.before({ tool, id: tool, sessionID: "root", input: {} }), /mission-grip-needs-user-direction/);
    }
    await assert.rejects(cold.before({ tool: "subagent", id: "new-worker", sessionID: "coordinator", input: { agent: "dog-worker-v010" } }), /mission-grip-needs-user-direction/);
    for (const tool of ["read", "sortie_v010_operator_status", "sortie_v010_cancel_operator", "sortie_v010_release_write_gate", "browser"]) {
      await cold.before({ tool, id: tool, sessionID: "root", input: {} });
    }
    await cold.before({ tool: "subagent", id: "consult", sessionID: "coordinator", input: { agent: "dog-advisor-v010" } });
    await cold.before({ tool: "edit", id: "existing-worker", sessionID: "worker", input: {} });
    await cold.before({ tool: "shell", id: "existing-worker-cleanup", sessionID: "worker", input: { command: "rm generated.tmp" } });
    for (const command of ["printf changed > result.txt", "node check.mjs", "rg --pre helper pattern", "git diff --output=result.txt", "git show --ext-diff"]) {
      await assert.rejects(cold.before({ tool: "shell", id: "paused-shell", sessionID: "root", input: { command } }), /mission-grip-needs-user-direction/);
    }
    await cold.before({ tool: "shell", id: "read-only", sessionID: "root", input: { command: "git status --short" } });
    await cold.after(answer(q, "A")); // stale result for the original call cannot undo the user's consultation choice
    await assert.rejects(cold.before(question("other-direction")), /mission-grip-question-already-pending/);
    const unrelated = question("unrelated", "入力"); await cold.before(unrelated); await cold.after(answer(unrelated, "B"));
    assert.ok(await cold.pending("root"));
    const resume = question("revised-question", String(pending!.resume_header)); await cold.before(resume);
    await cold.after(answer(resume, "A", "cancelled")); assert.ok(await cold.pending("root"));
    const feedback = question("feedback-question", String(pending!.resume_header)); await cold.before(feedback);
    await cold.after(answer(feedback, "どちらも違う"));
    assert.equal((await cold.pending("root"))!.user_feedback, "どちらも違う");
    await cold.after(answer(feedback, "B")); assert.ok(await cold.pending("root"), "a replay cannot reinterpret free-form steering as a listed choice");
    const chosen = question("fresh-choice", String(pending!.resume_header)); await cold.before(chosen);
    await cold.after(answer(chosen, "B")); assert.equal(await cold.pending("root"), undefined);
    await cold.before({ tool: "sortie_v010_plan_units", id: "resume", sessionID: "root", input: {} });
    await cold.after(answer(q, "目的に戻って外部相談")); assert.equal(await cold.pending("root"), undefined);
    await cold.before(q); assert.equal(await cold.pending("root"), undefined, "reprocessing an answered native call cannot reopen it");
  } finally { await f.dispose(); }
});

test("native retained question metadata repairs a missed after hook without treating quoted output as a choice", async () => {
  const f = await fixture();
  try {
    const q = question("lost-after"); await f.controller.before(q);
    f.history.root = [{ parts: [{ tool: "question", callID: q.id, state: { status: "completed",
      metadata: { answers: [["目的に戻って外部相談"]] } } }] }];
    const cold = f.create(), pending = await cold.pending("root");
    assert.equal(pending!.consultation_requested, true);
    const resume = question("after-restart", String(pending!.resume_header)); await cold.before(resume);
    const quoted = { ...resume, status: "completed", result: { content: "A / 目的に戻って外部相談" } };
    await cold.after(quoted); assert.ok(await cold.pending("root"));
    const fresh = question("fresh-native-answer", String(pending!.resume_header)); await cold.before(fresh);
    await cold.after(answer(fresh, "A")); assert.equal(await cold.pending("root"), undefined);
    assert.equal((await f.missions.handoffContext(await f.missions.required("root"))).grip, undefined);
  } finally { await f.dispose(); }
});

test("Grip policy is present on both Mission controllers, not Workers; no routine approval ritual", () => {
  for (const name of ["dog-operator", "dogs-coordinator"]) assert.ok(runtimeAssets.find(a => a.name === name)!.content.includes(GRIP_POLICY));
  assert.ok(!runtimeAssets.find(a => a.name === "dog-worker-v010")!.content.includes(GRIP_POLICY));
  assert.match(GRIP_POLICY, /Do not create questions for routine implementation/);
  assert.match(GRIP_POLICY, /Advice|advice as permission/);
});

test("a failed answer save never resumes the proposal; cancellation survives native history failure", async () => {
  const f = await fixture();
  try {
    const q = question("save-failure"); await f.controller.before(q);
    const update = f.controller.missions.update.bind(f.controller.missions);
    f.controller.missions.update = async () => { throw new Error("storage offline"); };
    await assert.rejects(f.controller.after(answer(q, "目的に戻って外部相談")), /storage offline/);
    await assert.rejects(f.controller.before({ tool: "sortie_v010_complete_mission", sessionID: "root", input: {} }), /mission-grip-needs-user-direction/);
    const cold = new MissionGripController(f.missions.projectRoot, async () => ({ agent: "dog-operator" }),
      async () => { throw new Error("history offline"); });
    await cold.before({ tool: "sortie_v010_cancel_operator", sessionID: "root", input: {} });
    f.controller.missions.update = update;
    f.history.root = [{ parts: [{ tool: "question", callID: q.id, state: { status: "completed",
      metadata: { answers: [["目的に戻って外部相談"]] } } }] }];
    assert.equal((await f.controller.pending("root"))!.consultation_requested, true);
  } finally { await f.dispose(); }
});
