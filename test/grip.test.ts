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
    assert.match(q.input.questions[0]!.question, /^🎯【元の目的・原文抜粋】「作業を速く・安く・楽に完了する。」 ┃ ❓【今回の判断】方式AかBか？ ┃ 💡【なぜ今】次のUXが変わるため。$/u);
    assert.deepEqual(q.input.questions[0]!.options.map(q => q.label), ["A", "B", "目的に戻って外部相談"]);
    assert.ok(q.input.questions[0]!.question.length + q.input.questions[0]!.options.map(q => q.label + q.description).join("").length < 300);
    const before = await f.missions.required("root");
    await f.controller.after(answer(q, "A"));
    assert.equal(await f.controller.pending("root"), undefined);
    assert.deepEqual((await f.missions.required("root")).requests, before.requests);
    assert.deepEqual((await f.missions.required("root")).requirements, before.requirements);
  } finally { await f.dispose(); }
});

test("Grip sections remain distinct after native whitespace collapse without changing authorization conditions", async () => {
  const f = await fixture();
  try {
    const q = question("inline-sections");
    q.input.questions[0]!.question = "今回の判断：固定5件取得・既存キー限定供給・Private一時保存を許可する？\r\n\r\nなぜ今：実packageへ進むため。\n条件：本人がキー設定、保存1日、追加課金を確認できなければ保存しない。";
    const options = structuredClone(q.input.questions[0]!.options);
    await f.controller.before(q);
    const formatted = q.input.questions[0]!.question;
    assert.doesNotMatch(formatted, /[\r\n]/u);
    assert.match(formatted.replace(/\s+/gu, " "), /🎯【元の目的・原文抜粋】.+ ┃ ❓【今回の判断】固定5件取得・既存キー限定供給・Private一時保存を許可する？ ┃ 💡【なぜ今】実packageへ進むため。 ┃ 条件：本人がキー設定、保存1日、追加課金を確認できなければ保存しない。/u);
    assert.deepEqual(q.input.questions[0]!.options.slice(0, -1), options);
    const saved = structuredClone(q);
    await f.controller.before(q);
    assert.deepEqual(q, saved);
    assert.equal(formatted.split("🎯【元の目的・原文抜粋】").length, 2);
  } finally { await f.dispose(); }
});

test("Grip formats explicit English headings and already decorated sections without duplicate decision labels", async () => {
  const f = await fixture();
  try {
    await f.missions.update("root", m => { m.requests[0]!.text = "Keep the release reproducible and affordable."; });
    for (const [index, raw] of [
      "Decision: Allow download only?\r\nWhy now: The fixed inputs are missing.",
      "❓[Decision] Allow download only? ┃ 💡[Why now] The fixed inputs are missing.",
      "Allow download only?\nKeep publication and key supply excluded.",
    ].entries()) {
      const q = question(`english-${index}`);
      q.input.questions[0]!.question = raw;
      await f.controller.before(q);
      const text = q.input.questions[0]!.question;
      assert.match(text, /^🎯\[Original goal excerpt\] "Keep the release reproducible and affordable\." ┃ ❓\[Decision\]/u);
      assert.equal(text.split("❓[Decision]").length, 2);
      assert.doesNotMatch(text, /[\r\n]/u);
      if (index < 2) assert.match(text, / ┃ 💡\[Why now\] The fixed inputs are missing\./u);
      else assert.ok(text.endsWith("Keep publication and key supply excluded."));
      await f.controller.after(answer(q, "A"));
    }
  } finally { await f.dispose(); }
});

test("saved legacy Grip offers retain their exact text and answer identity across new-format retries", async () => {
  const f = await fixture();
  try {
    const q = question("legacy-question"), raw = structuredClone(q);
    const legacy = { callID: q.id, sessionID: "root", header: "Grip",
      question: "元の目的（原文抜粋）: 作業を速く・安く・楽に完了する。\n\n" + q.input.questions[0]!.question.replace(/\r?\n+/gu, "\n\n"),
      consultationLabel: "目的に戻って外部相談",
      options: [...q.input.questions[0]!.options, { label: "目的に戻って外部相談", description: "この方針を保留し、元の目的から考え直す" }] };
    await f.missions.update("root", m => { m.grip = { questions: [legacy], pending: { callID: q.id,
      sessionID: "root", consultationRequested: false, resumeHeader: "Grip:legacy" } }; });
    await f.controller.before(q);
    assert.equal(q.input.questions[0]!.question, legacy.question);
    assert.deepEqual(q.input.questions[0]!.options, legacy.options);
    await f.controller.before(raw);
    assert.equal(raw.input.questions[0]!.question, legacy.question);
    const pending = await f.controller.after(answer(q, legacy.consultationLabel));
    assert.equal(pending!.consultation_requested, true);
    const resume = question("new-format-revision", String(pending!.resume_header));
    await f.controller.before(resume);
    assert.match(resume.input.questions[0]!.question, /^🎯【元の目的・原文抜粋】/u);
    await f.controller.after(answer(resume, "A"));
    assert.equal(await f.controller.pending("root"), undefined);
    assert.equal((await f.missions.required("root")).grip!.questions[0]!.question, legacy.question);
  } finally { await f.dispose(); }
});

test("Grip preserves long decision text and negated conditions instead of enforcing a display-length cutoff", async () => {
  const f = await fixture();
  try {
    const q = question("long-decision");
    const decision = "対象・操作の具体的な条件。".repeat(40) + "追加課金が不明なら保存しない。";
    q.input.questions[0]!.question = decision;
    await f.controller.before(q);
    assert.ok(q.input.questions[0]!.question.endsWith(decision));
    assert.match(q.input.questions[0]!.question, / ┃ ❓【今回の判断】/u);
    assert.deepEqual((await f.missions.required("root")).requests[0]!.text, "作業を速く・安く・楽に完了する。\n  原文の空白も保持。");
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
  assert.match(GRIP_POLICY, /Native Form descriptions collapse newlines and blank lines/);
  assert.match(GRIP_POLICY, /❓【今回の判断】.+ ┃ 💡【なぜ今】/u);
  assert.match(GRIP_POLICY, /never hide them to meet that target/);
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

test("a stale native before hook cannot attach the previous decision to a successor Mission", async () => {
  const f = await fixture();
  try {
    const update = f.controller.missions.update.bind(f.controller.missions);
    f.controller.missions.update = async (root, mutation) => {
      await update(root, m => { m.id = "mission-successor"; m.requests = [{ id: "new-user", text: "New user direction" }]; });
      return update(root, mutation);
    };
    await assert.rejects(f.controller.before(question("stale-before")), /mission-grip-owner-changed/);
    const successor = await f.missions.required("root");
    assert.equal(successor.id, "mission-successor");
    assert.equal(successor.grip, undefined);
    assert.deepEqual(successor.requests, [{ id: "new-user", text: "New user direction" }]);
  } finally { await f.dispose(); }
});

test("distinct concurrent initial questions serialize admission before either native form opens", async () => {
  const f = await fixture();
  try {
    const calls = [question("concurrent-a"), question("concurrent-b")];
    const results = await Promise.allSettled(calls.map(q => f.controller.before(q)));
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(results.filter(r => r.status === "rejected").length, 1);
    const admitted = calls[results.findIndex(r => r.status === "fulfilled")]!;
    const state = await f.missions.required("root");
    assert.equal(state.grip!.questions.length, 1);
    assert.equal(state.grip!.pending!.callID, admitted.id);
    await f.controller.after(answer(admitted, "目的に戻って外部相談"));
    await assert.rejects(f.controller.before({ tool: "edit", sessionID: "root", input: {} }), /mission-grip-needs-user-direction/);
  } finally { await f.dispose(); }
});

test("a reused outer call ID rejects a revised Grip form instead of replaying an answered offer", async () => {
  const f = await fixture();
  try {
    const original = question("outer-call"); await f.controller.before(original);
    const pending = await f.controller.after(answer(original, "目的に戻って外部相談"));
    await assert.rejects(f.controller.before(question("outer-call", String(pending!.resume_header))), /mission-grip-question-call-reused/);
    assert.ok(await f.controller.pending("root"));
    const fresh = question("fresh-native-call", String(pending!.resume_header)); await f.controller.before(fresh);
    await f.controller.after(answer(fresh, "A")); assert.equal(await f.controller.pending("root"), undefined);
  } finally { await f.dispose(); }
});

test("history failure reports unavailable recovery while observations, consultation and context state remain usable", async () => {
  const f = await fixture();
  try {
    await f.controller.before(question("lost-answer-hook"));
    const cold = new MissionGripController(f.missions.projectRoot, async () => ({ agent: "dog-operator" }),
      async () => { throw new Error("native history offline"); });
    for (const tool of ["read", "sortie_v010_operator_status", "sortie_v010_cancel_operator"])
      await cold.before({ tool, sessionID: "root", input: {} });
    await cold.before({ tool: "subagent", sessionID: "root", input: { agent: "dog-advisor-v010" } });
    const pending = await cold.pending("root");
    assert.equal((pending!.recovery as { status: string }).status, "unavailable");
    await assert.rejects(cold.before({ tool: "edit", sessionID: "root", input: {} }), /mission-grip-needs-user-direction/);
  } finally { await f.dispose(); }
});

test("competing revised questions cannot leave a late consultation answer untracked", async () => {
  const f = await fixture();
  try {
    const original = question("original-held"); await f.controller.before(original);
    const pending = await f.controller.after(answer(original, "目的に戻って外部相談"));
    const revisions = [question("revision-a", String(pending!.resume_header)), question("revision-b", String(pending!.resume_header))];
    const results = await Promise.allSettled(revisions.map(q => f.controller.before(q)));
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(results.filter(r => r.status === "rejected").length, 1);
    const admitted = revisions[results.findIndex(r => r.status === "fulfilled")]!;
    const rejected = revisions[results.findIndex(r => r.status === "rejected")]!;
    assert.equal((await f.missions.required("root")).grip!.questions.some(q => q.callID === rejected.id), false,
      "the competing form never opens, rather than ignoring a user choice later");
    await f.controller.after(answer(admitted, "A"));
    assert.equal(await f.controller.pending("root"), undefined);
    await f.controller.before({ tool: "edit", sessionID: "root", input: {} });
  } finally { await f.dispose(); }
});
