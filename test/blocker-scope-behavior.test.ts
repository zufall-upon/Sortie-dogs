import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { OperatorMissionRuntime } from "../dist/core/operator-mission.js";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";
import { createSortieDogsV2Plugin } from "../dist/plugin/v2.js";

const exec = promisify(execFile);
const request = "Implement Linux release automation; Windows is only needed for the post-release smoke. Keep the smoke required.";
const requirements = ["Implement Linux automation", "Run post-release Windows smoke"];
const purpose = { decision: "STOP_METHOD", requirement_ids: ["R2"], observed_outcome: "Windows unavailable",
  unmet_work: ["Implement Linux automation"], reason: "Windows belongs to post-release smoke", evidence_refs: ["user:request"],
  affected_method: "Post-release Windows smoke", next_action: "Check whether Linux implementation can proceed without Windows" };
// The first sentence is synthetic task context; the Windows condition is the user's
// verbatim correction in the retained screenshot. The three-item question is verbatim
// from the handoff's transcription; the original Mission's complete plan is unknown.
const originalRequest = "Linux側のリリース自動化を実装して。Windows側は一切関係なくなってリリース後のsmokeでだけ登場する話だったはずだけど";
const originalQuestion = "次の3項目について、利用できる既存の場所・提供可否をまとめて教えてね。①指定Windows Python/toolを使える正式環境・検証機会。②prebuildのStable Build完全Manifest、branch保護・権限、正規API応答、復帰対象との対応が分かる原記録。③Voice NeutralizerのRNNoise/WORLD/WebRTCの元checkout/model/hash・対応source/license/PATENTS・実artifactの証跡。分かるものだけで大丈夫、未所持は「未所持」でOKだよ。秘密値やcredentialは送らないでね。";
const originalRequirements = ["Linux側のリリース自動化を実装する", "リリース後Windows smokeを実施する", "prebuildとOSSの条件を維持する"];
const originalUnit = { title: "Linux release automation implementation", objective: "Implement Linux release automation", read: ["check.mjs"],
  write: ["result.txt"], validation: ["node check.mjs", "node windows-smoke.mjs"] };

async function fixture(planned = false, restrictions: string[] = [], config: {
  request?: string; requirements?: string[]; unit?: typeof originalUnit; withoutStop?: boolean; decision?: typeof purpose;
} = {}) {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/blocker-scope-"));
  await exec("git", ["init", "--quiet"], { cwd: directory });
  await writeFile(join(directory, "check.mjs"), "process.exit(0);\n");
  const history: Record<string, unknown[]> = { root: [] };
  const hooks = await SortieDogsV010Plugin({ directory, client: { session: {
    get: async () => ({ data: { id: "root", agent: "dog-operator" } }),
    messages: async () => ({ data: history.root }), children: async () => ({ data: [] }),
  } } } as never);
  await hooks["chat.message"]!({ sessionID: "root", messageID: "request", agent: "dog-operator" }, {
    message: { id: "request", agent: "dog-operator", model: { providerID: "openai", modelID: "fixture" } },
    parts: [{ type: "text", text: config.request ?? request }],
  });
  await hooks.tool!.sortie_v010_start_mission.execute({ requirements: [...(config.requirements ?? requirements), ...restrictions], prohibited_write: ["forbidden.txt"] }, { sessionID: "root" });
  if (planned) {
    const plan = JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ executor: "self", ...(config.withoutStop ? {} : { purpose_decision: config.decision ?? purpose }),
      units: [config.unit ?? { title: "Linux implementation", objective: "Implement Linux automation", read: ["check.mjs"],
        write: ["result.txt"], validation: ["node check.mjs", "node windows-smoke.mjs"] }] }, { sessionID: "root" }));
    assert.equal(plan.status, "direct-unit-running");
  }
  return { directory, history, hooks, missions: new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE),
    operators: new OperatorRuntime(directory, V010_RUNTIME_PROFILE), dispose: () => rm(directory, { recursive: true, force: true }) };
}

async function nativeQuestions(directory: string, history: Record<string, unknown>[]) {
  const toolHooks = new Map<string, (event: any) => Promise<void>>();
  const context: any = { app: { version: "2.0.11" }, location: { directory }, options: {},
    agent: { transform: async () => ({ dispose() {} }) },
    event: { subscribe: async function* () {} },
    tool: { transform: async (f: any) => { f({ add() {} }); return { dispose() {} }; },
      hook: async (name: string, f: any) => { toolHooks.set(name, f); return { dispose() {} }; } },
    session: { get: async () => ({ id: "root", agent: "dog-operator" }), context: async () => history,
      hook: async () => ({ dispose() {} }), synthetic: async () => ({}), interrupt: async () => ({}) },
    permission: { hook: async () => ({ dispose() {} }) }, provider: { list: async () => ({ data: [] }) },
    model: { list: async () => ({ data: [] }) } };
  const cleanup = await createSortieDogsV2Plugin(async () => ({ "tool.execute.before": async () => {} })).setup(context);
  return { before: toolHooks.get("execute.before")!, after: toolHooks.get("execute.after")!, cleanup };
}

const originalConfig = { request: originalRequest, requirements: originalRequirements, unit: originalUnit, withoutStop: true };
const originalForm = (id: string, header = "情報") => ({ tool: "question", id, sessionID: "root", input: { questions: [{
  header, question: originalQuestion, options: [{ label: "未所持", description: "提供できるものはない" }],
}] } });

test("public no-STOP original grouped question reconsiders once while retaining the future and unrelated conditions", async () => {
  const f = await fixture(true, [], originalConfig), native = await nativeQuestions(f.directory, []);
  try {
    const before = await f.missions.required("root"), run = await f.operators.required("root");
    const budget = JSON.parse(await f.hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" })).budget;
    assert.deepEqual(before.requests, [{ id: "request", text: originalRequest }]);
    assert.deepEqual(before.purposeDecisions ?? [], []);
    const form = originalForm("original"), unchanged = structuredClone(form);
    await assert.rejects(native.before(form), (error: Error) => {
      assert.match(error.message, /mission-blocker-scope-reconsider/);
      assert.match(error.message, /other requested information|prebuild, OSS/);
      assert.match(error.message, /not completion or permission/);
      return true;
    });
    assert.deepEqual(form, unchanged);
    const retained = await f.missions.required("root");
    assert.deepEqual(retained.requirements.map(item => item.text), originalRequirements);
    assert.deepEqual(retained.prohibitedWrite, ["forbidden.txt"]);
    assert.equal(retained.submission, null);
    assert.equal(retained.blockerScopeChecks?.length, 1);
    assert.equal((await f.operators.required("root")).units[0]!.status, "running");
    assert.deepEqual(run.units[0]!.unit.validation, originalUnit.validation);
    assert.deepEqual(JSON.parse(await f.hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" })).budget, budget);
    await native.before(originalForm("retry"));
    await native.before(originalForm("retry-again"));
    assert.equal((await f.missions.required("root")).blockerScopeChecks?.length, 1);
    const args = { filePath: join(f.directory, "result.txt"), content: "Linux implementation\n" };
    await f.hooks["tool.execute.before"]!({ tool: "write", sessionID: "root", callID: "independent" }, { args });
    await writeFile(args.filePath, args.content);
    await f.hooks["tool.execute.after"]!({ tool: "write", sessionID: "root", callID: "independent", args }, { output: "written" });
    assert.equal(await readFile(args.filePath, "utf8"), args.content);
    await assert.rejects(f.hooks["tool.execute.before"]!({ tool: "write", sessionID: "root", callID: "forbidden" },
      { args: { filePath: join(f.directory, "forbidden.txt"), content: "not allowed" } }), /denied|prohibit|scope/iu);
    await assert.rejects(readFile(join(f.directory, "forbidden.txt")), { code: "ENOENT" });
  } finally { native.cleanup?.(); await f.dispose(); }
});

test("a grouped question matching both scope paths is reconsidered only once", async () => {
  const f = await fixture(true, [], { ...originalConfig, withoutStop: false, decision: { ...purpose, affected_method: "Windows" } });
  const native = await nativeQuestions(f.directory, []);
  try {
    assert.equal((await f.missions.required("root")).purposeDecisions?.at(-1)?.affected_method, "Windows");
    await assert.rejects(native.before(originalForm("overlap")), /mission-blocker-scope-reconsider/);
    await native.before(originalForm("overlap-retry"));
    await native.before(originalForm("overlap-retry-again"));
    const state = await f.missions.required("root");
    assert.equal(state.submission, null);
    assert.deepEqual(state.requirements.map(item => item.text), originalRequirements);
  } finally { native.cleanup?.(); await f.dispose(); }
});

test("public question leaves genuine smoke, user decisions and unknown or conflicting source scope on the existing path", async t => {
  for (const scenario of ["current-smoke", "user-decision", "source-missing", "source-conflict", "source-negates-only", "current-dependency", "no-run"] as const) await t.test(scenario, async () => {
    const config = { ...originalConfig };
    const restrictions = scenario === "current-dependency" ? ["現在の実装中はprebuild Manifestが必須"] : [];
    if (scenario === "current-smoke") config.unit = { ...originalUnit, objective: "Run post-release Windows smoke" };
    if (scenario === "source-missing") config.request = "Linux側のリリース自動化を実装して。Windowsの条件は未確認。";
    if (scenario === "source-conflict") config.request += " ただしWindows環境は現在の実装中も必須。";
    if (scenario === "source-negates-only") config.request = "Linux側のリリース自動化を実装して。Windows環境はリリース後のsmokeでだけではなく、Linux実装でも使う。";
    const f = await fixture(scenario !== "no-run", restrictions, config), native = await nativeQuestions(f.directory, []);
    try {
      const form = originalForm(`pass-${scenario}`, scenario === "user-decision" ? "Grip" : "情報");
      if (scenario === "user-decision") form.input.questions[0]!.question += " この作業の実行を許可するか判断してね。";
      await native.before(form);
      const mission = await f.missions.required("root");
      assert.deepEqual(mission.blockerScopeChecks ?? [], []);
      assert.deepEqual(mission.requirements.map(item => item.text), [...originalRequirements, ...restrictions]);
      assert.equal(mission.submission, null);
      if (scenario === "user-decision") assert.ok(mission.grip?.pending);
      if (scenario === "current-smoke") {
        const current = originalForm("actual-current-smoke");
        current.input.questions[0]!.question = "現在のWindows smokeを実行するため、指定Python/toolを利用できる正式環境・検証機会はある？";
        await native.before(current);
        assert.deepEqual((await f.missions.required("root")).blockerScopeChecks ?? [], []);
      }
    } finally { native.cleanup?.(); await f.dispose(); }
  });
});

test("public current validation in the same implementation unit leaves its smoke question askable", async () => {
  const f = await fixture(false, [], originalConfig);
  let native: Awaited<ReturnType<typeof nativeQuestions>> | undefined;
  try {
    await writeFile(join(f.directory, "check.mjs"),
      "import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; assert.equal(readFileSync('result.txt', 'utf8'), 'Linux implementation\\n');\n");
    await writeFile(join(f.directory, "windows-smoke.mjs"),
      "console.error('Windows Python/tool environment unavailable'); process.exit(1);\n");
    const plan = JSON.parse(await f.hooks.tool!.sortie_v010_plan_units.execute({ executor: "self", units: [originalUnit] }, { sessionID: "root" }));
    assert.equal(plan.status, "direct-unit-running");
    const args = { filePath: join(f.directory, "result.txt"), content: "Linux implementation\n" };
    await f.hooks["tool.execute.before"]!({ tool: "write", sessionID: "root", callID: "finish-linux" }, { args });
    await writeFile(args.filePath, args.content);
    await f.hooks["tool.execute.after"]!({ tool: "write", sessionID: "root", callID: "finish-linux", args }, { output: "written" });
    for (const [index, command] of originalUnit.validation.entries()) {
      const callID = `current-smoke-check-${index}`, input = { command, workdir: f.directory }, start = Date.now();
      await f.hooks["tool.execute.before"]!({ tool: "bash", sessionID: "root", callID }, { args: input });
      let exit = 0, output = "";
      try {
        const result = await exec(process.execPath, command.split(" ").slice(1), { cwd: f.directory });
        output = result.stdout + result.stderr;
      } catch (error) {
        const result = error as { code?: number; stdout?: string; stderr?: string };
        exit = Number(result.code) || 1; output = (result.stdout ?? "") + (result.stderr ?? "");
      }
      assert.equal(exit, index === 0 ? 0 : 1);
      if (index === 1) assert.match(output, /Windows Python\/tool environment unavailable/);
      f.history.root!.push({ info: { id: callID, role: "assistant", sessionID: "root" }, parts: [{ type: "tool", tool: "bash", callID,
        state: { status: "completed", input, metadata: { exit }, time: { start, end: Date.now() } } }] });
      await f.hooks["tool.execute.after"]!({ tool: "bash", sessionID: "root", callID, args: input }, { output, metadata: { exit, status: "completed" } });
    }
    const run = await f.operators.required("root"), checks = structuredClone(run.units[0]!.directExecution!.checks);
    assert.equal(run.units[0]!.unit.objective, originalUnit.objective);
    assert.equal(run.units[0]!.status, "running");
    assert.deepEqual(checks.map(check => check.exitCode), [0, 1]);
    native = await nativeQuestions(f.directory, []);
    await native.before(originalForm("current-smoke-after-validation"));
    const mission = await f.missions.required("root");
    assert.deepEqual(mission.blockerScopeChecks ?? [], []);
    assert.equal(mission.submission, null);
    assert.deepEqual(mission.requirements.map(item => item.text), originalRequirements);
    assert.deepEqual((await f.operators.required("root")).units[0]!.directExecution!.checks, checks);
  } finally { native?.cleanup?.(); await f.dispose(); }
});

test("native current validation history vetoes an implementation objective before durable check settlement", async () => {
  const f = await fixture(true, [], originalConfig);
  let native: Awaited<ReturnType<typeof nativeQuestions>> | undefined;
  try {
    const start = Date.now();
    await exec(process.execPath, ["check.mjs"], { cwd: f.directory });
    const history = [{ id: "native-current-check", type: "assistant", content: [{ type: "tool", id: "native-check", name: "shell",
      time: { ran: start, completed: Date.now() }, state: { status: "completed", input: { command: "node check.mjs", workdir: f.directory },
        content: "PASS", metadata: { exit: 0 } } }] }];
    assert.deepEqual((await f.operators.required("root")).units[0]!.directExecution!.checks, []);
    native = await nativeQuestions(f.directory, history);
    await native.before(originalForm("native-current-validation"));
    const mission = await f.missions.required("root");
    assert.deepEqual(mission.blockerScopeChecks ?? [], []);
    assert.equal(mission.submission, null);
    assert.deepEqual((await f.operators.required("root")).units[0]!.directExecution!.checks, [], "a history veto never manufactures formal check evidence");
  } finally { native?.cleanup?.(); await f.dispose(); }
});

test("current restrictions veto the new recognizer rather than being deferred by the question hook", async t => {
  for (const restriction of ["現在の取得はlicenseの確認が必要", "現在の操作は予算承認まで保留",
    "現在の操作は所有権確認まで保留", "現在の操作は禁止", "現在の操作は外部相談まで保留", "現在の依存関係は不明"]) await t.test(restriction, async () => {
    const f = await fixture(true, [restriction], originalConfig), native = await nativeQuestions(f.directory, []);
    try {
      await native.before(originalForm("restricted"));
      const mission = await f.missions.required("root");
      assert.deepEqual(mission.blockerScopeChecks ?? [], []);
      assert.equal(mission.requirements.at(-1)!.text, restriction);
      assert.deepEqual(mission.prohibitedWrite, ["forbidden.txt"]);
      assert.equal(mission.submission, null);
    } finally { native.cleanup?.(); await f.dispose(); }
  });
});

test("a later real user turn does not borrow an older run's source binding", async () => {
  const f = await fixture(true, [], originalConfig), native = await nativeQuestions(f.directory, []);
  try {
    const prior = await f.operators.required("root");
    assert.deepEqual(prior.sourceRefs, ["user:request"]);
    await f.hooks["chat.message"]!({ sessionID: "root", messageID: "later", agent: "dog-operator" }, {
      message: { id: "later", agent: "dog-operator", model: { providerID: "openai", modelID: "fixture" } },
      parts: [{ type: "text", text: "Windows環境は現在も必要かもしれない。" }],
    });
    await f.hooks.tool!.sortie_v010_start_mission.execute({ intent: "continue", requirements: originalRequirements }, { sessionID: "root" });
    const mission = await f.missions.required("root");
    assert.equal(mission.requests.at(-1)!.id, "later");
    assert.equal(mission.runID, prior.runID);
    await native.before(originalForm("old-binding"));
    assert.deepEqual((await f.missions.required("root")).blockerScopeChecks ?? [], []);
  } finally { native.cleanup?.(); await f.dispose(); }
});

test("missing or unreadable run state falls back to the unchanged native question", async () => {
  const f = await fixture(true, [], originalConfig), native = await nativeQuestions(f.directory, []);
  const path = f.operators.statePath("root"), aside = `${path}.fixture-unavailable`;
  try {
    const bytes = await readFile(path);
    await rename(path, aside);
    try { await native.before(originalForm("missing-run")); }
    finally { await rename(aside, path); }
    await writeFile(path, "not valid JSON");
    try { await native.before(originalForm("unreadable-run")); }
    finally { await writeFile(path, bytes); }
    assert.deepEqual((await f.missions.required("root")).blockerScopeChecks ?? [], []);
    assert.equal((await f.operators.required("root")).units[0]!.status, "running");
  } finally { native.cleanup?.(); await f.dispose(); }
});

test("new Grip availability can be reconsidered but its frozen offer and external hold are never changed", async () => {
  const f = await fixture(true, [], originalConfig), native = await nativeQuestions(f.directory, []);
  try {
    const form = originalForm("new-grip", "Grip"), original = structuredClone(form);
    await assert.rejects(native.before(form), /mission-blocker-scope-reconsider/);
    assert.deepEqual(form, original);
    assert.equal((await f.missions.required("root")).grip?.pending, undefined);
    await native.before(form);
    const offered = structuredClone(form), saved = structuredClone((await f.missions.required("root")).grip);
    assert.ok(saved?.pending);
    await native.before(originalForm("new-grip", "Grip"));
    assert.deepEqual((await f.missions.required("root")).grip, saved);
    const label = saved!.questions[0]!.consultationLabel;
    await native.after({ ...offered, status: "completed", result: { content: "answer", metadata: { answers: [[label]] } } });
    const held = (await f.missions.required("root")).grip!;
    assert.equal(held.pending?.consultationRequested, true);
    assert.deepEqual(held.questions[0]!.question, saved!.questions[0]!.question);
    await assert.rejects(native.before({ tool: "write", id: "held-write", sessionID: "root", input: {} }), /mission-grip-needs-user-direction/);
    assert.deepEqual((await f.missions.required("root")).grip, held);
  } finally { native.cleanup?.(); await f.dispose(); }
});

test("public blocked submission reconsiders a later smoke without settling current work or future checks", async () => {
  const f = await fixture(true);
  try {
    const before = await f.operators.required("root"), budget = JSON.parse(await f.hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" })).budget;
    const result = JSON.parse(await f.hooks.tool!.sortie_v010_submit_mission.execute({ status: "blocked", summary: "Windows unavailable", purpose_decision: purpose }, { sessionID: "root" }));
    assert.equal(result.status, "blocker-scope-reconsider");
    assert.match(result.next_action, /not proof|does not prove/);
    const mission = await f.missions.required("root"), after = await f.operators.required("root");
    assert.equal(mission.submission, null);
    assert.notEqual(mission.phase, "completed");
    assert.deepEqual(mission.requirements.map(item => item.text), requirements);
    assert.deepEqual(mission.prohibitedWrite, ["forbidden.txt"]);
    assert.equal(after.runID, before.runID);
    assert.equal(after.units[0]!.status, "running");
    assert.deepEqual(after.units[0]!.unit.validation, ["node check.mjs", "node windows-smoke.mjs"]);
    assert.equal(after.receipt, null);
    assert.deepEqual(JSON.parse(await f.hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" })).budget, budget);

    // This fixture's original user request establishes the Linux operation independently;
    // the scope response itself does not grant it.
    const args = { filePath: join(f.directory, "result.txt"), content: "Linux implementation\n" };
    await f.hooks["tool.execute.before"]!({ tool: "write", sessionID: "root", callID: "write-linux" }, { args });
    await writeFile(args.filePath, args.content);
    await f.hooks["tool.execute.after"]!({ tool: "write", sessionID: "root", callID: "write-linux", args }, { output: "written" });
    assert.equal(await readFile(args.filePath, "utf8"), args.content);
    await assert.rejects(f.hooks["tool.execute.before"]!({ tool: "write", sessionID: "root", callID: "forbidden" },
      { args: { filePath: join(f.directory, "forbidden.txt"), content: "not allowed" } }), /denied|prohibit|scope/iu);
    await assert.rejects(readFile(join(f.directory, "forbidden.txt")), { code: "ENOENT" });
  } finally { await f.dispose(); }
});

test("an unknown or genuine current dependency can still be submitted; the check never manufactures permission", async () => {
  const f = await fixture();
  try {
    const current = { ...purpose, reason: "The current operation may require the missing environment", evidence_refs: ["user:not-a-real-request"],
      next_action: "Do not operate until the current dependency is resolved" };
    const submit = () => f.hooks.tool!.sortie_v010_submit_mission.execute({ status: "blocked", summary: "Current dependency unknown", purpose_decision: current }, { sessionID: "root" });
    assert.equal(JSON.parse(await submit()).status, "blocker-scope-reconsider");
    assert.equal((await f.missions.required("root")).submission, null);
    await submit();
    const mission = await f.missions.required("root");
    assert.equal(mission.submission!.status, "blocked");
    assert.notEqual(mission.phase, "completed");
    assert.deepEqual(mission.requirements.map(item => item.text), requirements);
  } finally { await f.dispose(); }
});

test("ordinary current restrictions and decisions are not reclassified as future-only", async () => {
  for (const condition of ["explicit prohibition", "external consultation hold", "budget", "ownership",
    "license required for acquisition", "license required for use", "license required for modification", "license required for distribution"]) {
    const f = await fixture(false, [`The current operation is held for ${condition}.`]);
    try {
      await f.hooks.tool!.sortie_v010_submit_mission.execute({ status: "needs-decision", summary: condition }, { sessionID: "root" });
      const mission = await f.missions.required("root");
      assert.deepEqual(mission.submission, { status: "needs-decision", summary: condition });
      assert.notEqual(mission.phase, "completed");
      assert.deepEqual(mission.prohibitedWrite, ["forbidden.txt"]);
      assert.equal(mission.requirements.at(-1)!.text, `The current operation is held for ${condition}.`);
    } finally { await f.dispose(); }
  }
});

test("native question path reconsiders a named stopped method once without asserting independence", async () => {
  const f = await fixture(true), native = await nativeQuestions(f.directory, []);
  try {
    const input = { questions: [{ header: "Environment", question: "Post-release Windows smoke: where is the Windows machine?",
      options: [{ label: "Unavailable", description: "Not yet available" }] }] };
    const event = { tool: "question", id: "question-1", sessionID: "root", input };
    await assert.rejects(native.before(event), /mission-blocker-scope-reconsider/);
    assert.equal((await f.operators.required("root")).units[0]!.status, "running");
    assert.equal((await f.missions.required("root")).submission, null);
    // If the dependency is real or unknown, the exact question remains available.
    await native.before({ ...event, id: "question-2", input: structuredClone(input) });
    assert.equal((await f.missions.required("root")).grip?.pending, undefined);
    assert.deepEqual((await f.missions.required("root")).requirements.map(item => item.text), requirements);
  } finally { native.cleanup?.(); await f.dispose(); }
});

test("native question scopes an explicitly selected method to the admitted replan, not a predecessor or refused plan", async t => {
  for (const scenario of ["reselected", "unselected", "refused"] as const) await t.test(scenario, async () => {
    const f = await fixture(scenario === "unselected"), native = await nativeQuestions(f.directory, []);
    try {
      const plan = (path: string, decision?: typeof purpose) => f.hooks.tool!.sortie_v010_plan_units.execute({
        executor: "self", reason: "Correct the Linux output path without changing the requirements",
        ...(decision ? { purpose_decision: decision } : {}),
        units: [{ title: "Linux implementation", objective: "Implement Linux automation", read: ["check.mjs"],
          write: [path], validation: scenario === "unselected" ? ["node check.mjs", "node windows-smoke.mjs"] : ["node check.mjs"] }],
      }, { sessionID: "root" });
      if (scenario !== "unselected") assert.equal(JSON.parse(await plan("result.txt")).status, "direct-unit-running");
      const previousRun = (await f.missions.required("root")).runID;
      if (scenario === "refused") await assert.rejects(f.hooks.tool!.sortie_v010_plan_units.execute({
        executor: "self", purpose_decision: purpose, units: [],
      }, { sessionID: "root" }), /mission-units/);
      assert.equal(JSON.parse(await plan("replanned.txt", scenario === "reselected" ? purpose : undefined)).status, "direct-unit-running");
      assert.notEqual((await f.missions.required("root")).runID, previousRun);
      const question = (id: string) => ({ tool: "question", id, sessionID: "root", input: { questions: [{
        header: "Environment", question: "Post-release Windows smoke: where is the Windows machine?",
        options: [{ label: "Unavailable", description: "Not yet available" }],
      }] } });
      if (scenario === "reselected") {
        await assert.rejects(native.before(question("first-replan")), /mission-blocker-scope-reconsider/);
        await native.before(question("first-replan-retry"));
        // Reusing identical decision text in a later explicit plan is not an old-run observation.
        assert.equal(JSON.parse(await plan("reselected-again.txt", purpose)).status, "direct-unit-running");
        await assert.rejects(native.before(question("second-replan")), /mission-blocker-scope-reconsider/);
        await native.before(question("second-replan-retry"));
      } else await native.before(question("unselected-method"));
      assert.equal((await f.missions.required("root")).submission, null);
      assert.deepEqual((await f.missions.required("root")).requirements.map(item => item.text), requirements);
    } finally { native.cleanup?.(); await f.dispose(); }
  });
});

test("native question reuses only an immediately answered identical form; changed context and errors remain askable", async () => {
  const f = await fixture(), history: Record<string, any>[] = [], native = await nativeQuestions(f.directory, history);
  try {
    const input = { questions: [{ header: "Environment", question: "Where is the Windows machine?",
      options: [{ label: "Unavailable", description: "Not yet available" }] }] };
    const prior = { id: "prior", type: "assistant", content: [{ type: "tool", id: "first", name: "question",
      state: { status: "completed", input: structuredClone(input), metadata: { answers: [["Unavailable"]] } } }] };
    history.push(prior);
    const next = () => ({ tool: "question", id: "second", sessionID: "root", input: structuredClone(input) });
    await assert.rejects(native.before(next()), /mission-question-already-answered: \[\["Unavailable"\]\]/);
    assert.equal((await f.missions.required("root")).submission, null);
    history.push({ id: "new-user", type: "user", text: "Please ask again; the environment changed." });
    await native.before(next());
    history.pop(); prior.content[0]!.state.status = "error";
    await native.before(next());
    prior.content[0]!.state.status = "completed";
    history.push({ id: "new-tool", type: "assistant", content: [{ type: "tool", id: "read", name: "read", state: { status: "completed", input: {} } }] });
    await native.before(next());
    history.pop();
    const changed = next(); changed.input.questions[0]!.question += " Is it available now?";
    await native.before(changed);
    history.push({ id: "new-hypothesis", type: "assistant", content: [{ type: "text", text: "The machine may now be available." }] });
    await native.before(next());
    history.pop();
    const sameCall = next(); sameCall.id = "first";
    await native.before(sameCall);
  } finally { native.cleanup?.(); await f.dispose(); }
});

test("native Scout reuses only the immediately completed exact investigation, not failures or changed hypotheses", async () => {
  const f = await fixture(), history: Record<string, any>[] = [], native = await nativeQuestions(f.directory, history);
  try {
    const input = { agent: "dog-scout-v010", description: "Find Windows scope",
      prompt: "missing_evidence_code: manifest\nFind retained Windows smoke constraints." };
    const prior = { id: "prior", type: "assistant", content: [{ type: "tool", id: "first", name: "subagent",
      state: { status: "completed", input: structuredClone(input), content: "Windows is for later smoke only.", metadata: { status: "completed" } } }] };
    history.push(prior);
    const next = () => ({ tool: "subagent", id: "second", sessionID: "root", input: structuredClone(input) });
    await assert.rejects(native.before(next()), /mission-scout-already-investigated: "Windows is for later smoke only\."/);
    assert.equal((await f.missions.required("root")).submission, null);
    history.push({ id: "changed", type: "user", text: "The scope has changed." });
    await native.before(next());
    history.pop(); prior.content[0]!.state.metadata.status = "running";
    await native.before(next());
    prior.content[0]!.state.metadata.status = "completed";
    const changed = next(); changed.input.prompt += " Test a new hypothesis.";
    await native.before(changed);
    history.push({ id: "new-hypothesis", type: "assistant", content: [{ type: "text", text: "The previous finding might be stale." }] });
    await native.before(next());
  } finally { native.cleanup?.(); await f.dispose(); }
});
