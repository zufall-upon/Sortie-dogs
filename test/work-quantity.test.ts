import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { performance } from "node:perf_hooks";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import childProcess from "node:child_process";
import Ajv from "ajv";
import { formatWorkQuantity, observeWorkQuantity, planWorkQuantity, projectWorkQuantity, syncWorkQuantity } from "../dist/core/work-quantity.js";
import { applyPendingWork, cachedWorkProgress, observeActorWork, rememberWorkMission, rememberWorkRun,
  rememberedWorkRun, workRootForActor, forgetWorkDirectory, forgetWorkSession } from "../dist/core/work-quantity-observations.js";
import { OperatorMissionRuntime, missionPacket, missionPlan, type OperatorMission } from "../dist/core/operator-mission.js";
import { OperatorRuntime, type OperatorState } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { bindMissionProgress, missionProgressReader, publishMissionProgress } from "../dist/plugin/mission-progress.js";
import { serializeOperatorStatus } from "../dist/plugin/operator-status-output.js";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";
import { toolSchema } from "../dist/plugin/tool-schema.js";

function mission(requirements = ["Implement result"]): OperatorMission {
  return { version: "0.12", id: "mission-one", root: "root", requests: [{ id: "user", text: requirements.join("; ") }],
    requirements: requirements.map((text, index) => ({ id: `R${index + 1}`, text })), kind: "implementation", phase: "running",
    coordinator: "coordinator", callID: "coordinator-call", dispatchOpen: true, runID: "run-one", plans: 1, progress: [], submission: null };
}
const work = (write = ["src/a.ts", "src/b.ts"], validation = ["npm test"]) => ({ title: "Result", objective: "Implement result", read: [], write, validation });
function run(units = [work()], id = "run-one"): OperatorState {
  return { runID: id, rootSessionID: "root", phase: "running", units: units.map((unit, index) => ({ unit: { ...unit, id: `unit-${index + 1}` },
    callID: `call-${index + 1}`, childSessionID: "worker", status: "running", evidence: [] })) } as unknown as OperatorState;
}

test("ordinary single unit exposes weighted whole-request intermediate values, not budget or elapsed time", () => {
  const m = mission(), r = run(), state = planWorkQuantity(m, [work()], r);
  const n = () => projectWorkQuantity(state).n;
  assert.equal(n(), 0);
  observeWorkQuantity(state, { kind: "read", paths: ["src/a.ts"] }); const read = n();
  observeWorkQuantity(state, { kind: "change", paths: ["src/a.ts"], unit: "run-one/unit-1" }); const a = n();
  for (let i = 0; i < 100; i++) observeWorkQuantity(state, { kind: "change", paths: ["src/a.ts"], unit: "run-one/unit-1" });
  assert.equal(n(), a, "repeated edits cannot accumulate completed work");
  observeWorkQuantity(state, { kind: "change", paths: ["src/b.ts"], unit: "run-one/unit-1" }); const b = n();
  observeWorkQuantity(state, { kind: "command-end", command: "npm test", exit: 0, callID: "check" }); const checked = n();
  assert.ok(0 < read && read < a && a < b && b < checked && checked < 100);
  assert.deepEqual(projectWorkQuantity(state).remaining_kinds, ["artifact", "validation", "review", "delivery", "acceptance"]);
  assert.match(formatWorkQuantity(projectWorkQuantity(state)), /全体作業量 \d+\/100（概算）/);
});

test("broad permission scopes are not scanned; distinct native targets move the same estimate", () => {
  const m = mission(), unit = work(["src/**"]), state = planWorkQuantity(m, [unit], run([unit]));
  const total = state.estimatedTotal, values: number[] = [];
  for (const path of ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]) {
    observeWorkQuantity(state, { kind: "change", paths: [path] }); values.push(projectWorkQuantity(state).n);
    assert.equal(state.estimatedTotal, total);
  }
  assert.ok(values.every((n, index) => !index || n > values[index - 1]!));
  observeWorkQuantity(state, { kind: "change", paths: [".sortie-dogs-v010/state.json", ".git/index"] });
  assert.equal(projectWorkQuantity(state).n, values.at(-1));
});

test("absolute root and native concrete path bindings normalize locally without filesystem lookup", () => {
  const m = mission(), unit = work(["/repo/**"]), r = run([unit]);
  const state = planWorkQuantity(m, [unit], r, undefined, undefined, "/repo");
  observeWorkQuantity(state, { kind: "change", paths: ["src/a.ts"] });
  assert.ok(projectWorkQuantity(state).n > 0);
});

test("shared artifacts/suites and coalesced scheduling count each concrete job once", () => {
  const m = mission(), raw = [work(["src/a.ts"]), work(["src/a.ts", "src/b.ts"])];
  const plan = missionPlan(m, raw), r = run(plan.units);
  assert.equal(plan.units.length, 1);
  const state = planWorkQuantity(m, raw, r);
  assert.equal(state.items.filter(item => item.kind === "artifact").length, 2);
  assert.equal(state.items.filter(item => item.kind === "validation").length, 1);
  assert.ok(state.items.filter(item => item.kind === "artifact").every(item => item.units.length === 1));
});

test("relative weights and checkpoint subdivisions preserve the parent quantity", () => {
  const m = mission(), raw = [work()], r = run(raw);
  const declared = [{ id: "feature", kind: "artifact", relative_weight: 90, bindings: { paths: ["src/a.ts", "src/b.ts"] },
    checkpoints: [{ id: "a", paths: ["src/a.ts"], relative_weight: 2 }, { id: "b", paths: ["src/b.ts"], relative_weight: 1 }] }];
  const state = planWorkQuantity(m, raw, r, undefined, declared);
  assert.equal(state.items.filter(item => item.parentID).reduce((sum, item) => sum + item.weight, 0), 90);
  assert.equal(state.estimatedTotal, 100);
  observeWorkQuantity(state, { kind: "checkpoint", checkpoints: ["a"] });
  assert.equal(projectWorkQuantity(state).n, 48);
  const replanned = planWorkQuantity(m, [...raw].reverse(), r, state);
  assert.equal(replanned.estimatedTotal, state.estimatedTotal);
  assert.equal(projectWorkQuantity(replanned).n, 48);
  assert.equal(replanned.revision, state.revision, "omitting optional metadata does not reset the estimate");
});

test("review follow-up: new checkpoints retain only their matching path observations", () => {
  for (const changed of ["src/a.ts", "src/b.ts"]) for (const declareBeforeChange of [false, true]) {
    const m = mission(), raw = [work()], r = run(raw);
    const declared = { id: "feature", kind: "artifact", bindings: { paths: ["src/a.ts", "src/b.ts"] }, relative_weight: 16 };
    const prior = planWorkQuantity(m, raw, r, undefined, declareBeforeChange ? [declared] : undefined);
    observeWorkQuantity(prior, { kind: "change", paths: [changed] });
    const next = planWorkQuantity(m, raw, r, prior, [{ ...declared,
      checkpoints: [{ id: "a", paths: ["src/a.ts"] }, { id: "b", paths: ["src/b.ts"] }] }]);
    for (const name of ["a", "b"]) assert.equal(next.items.find(item => item.id === `declared:feature/checkpoint:${name}`)?.fraction,
      changed === `src/${name}.ts` ? 0.55 : 0, `${changed}, declared before change: ${declareBeforeChange}`);
    assert.equal(next.estimatedTotal, prior.estimatedTotal);
  }
});

test("review follow-up: new validation checkpoints retain only their matching command outcomes", () => {
  const m = mission(), unit = work([], ["node a.mjs", "node b.mjs"]), r = run([unit]);
  const declared = { id: "checks", kind: "validation", bindings: { commands: unit.validation }, relative_weight: 6 };
  const prior = planWorkQuantity(m, [unit], r, undefined, [declared]);
  observeWorkQuantity(prior, { kind: "command-end", command: "node b.mjs", exit: 0, callID: "b-check" });
  const next = planWorkQuantity(m, [unit], r, prior, [{ ...declared,
    checkpoints: [{ id: "a", commands: ["node a.mjs"] }, { id: "b", commands: ["node b.mjs"] }] }]);
  assert.equal(next.items.find(item => item.id.endsWith("/checkpoint:a"))?.fraction, 0);
  assert.equal(next.items.find(item => item.id.endsWith("/checkpoint:b"))?.fraction, 0.9);
  assert.equal(next.items.find(item => item.id.endsWith("/checkpoint:b"))?.observation.callID, "b-check");
});

test("review follow-up: broad aliases do not credit untouched concrete checkpoints", () => {
  const m = mission(), unit = work(["src/**"]), r = run([unit]);
  const declared = { id: "feature", kind: "implementation", bindings: { paths: ["src/**"] }, relative_weight: 16 };
  const prior = planWorkQuantity(m, [unit], r, undefined, [declared]);
  observeWorkQuantity(prior, { kind: "read", paths: ["src/a.ts"] });
  observeWorkQuantity(prior, { kind: "change", paths: ["src/a.ts"] });
  const next = planWorkQuantity(m, [unit], r, prior, [{ ...declared,
    checkpoints: [{ id: "a", paths: ["src/a.ts"] }, { id: "b", paths: ["src/b.ts"] }] }]);
  assert.equal(next.items.find(item => item.id.endsWith("/checkpoint:a"))?.fraction, 0.55);
  assert.equal(next.items.find(item => item.id.endsWith("/checkpoint:b"))?.fraction, 0);
});

test("PR249 follow-up: broad checkpoints retain concrete alias observations in either order", () => {
  for (const changed of ["src/a.ts", "src/b.ts"]) {
    const m = mission(), raw = [work()], r = run(raw);
    const declared = { id: "feature", kind: "artifact", bindings: { paths: raw[0]!.write }, relative_weight: 16 };
    const prior = planWorkQuantity(m, raw, r, undefined, [declared]);
    observeWorkQuantity(prior, { kind: "change", paths: [changed] });
    const next = planWorkQuantity(m, raw, r, prior, [{ ...declared, checkpoints: [{ id: "all", paths: ["src/**"] }] }]);
    const checkpoint = next.items.find(item => item.id.endsWith("/checkpoint:all"))!;
    assert.equal(checkpoint.fraction, 0.55 / 2);
    assert.deepEqual(checkpoint.observation.changedTargets, [changed]);
    assert.equal(next.estimatedTotal, prior.estimatedTotal);
    observeWorkQuantity(next, { kind: "change", paths: [changed === "src/a.ts" ? "src/b.ts" : "src/a.ts"] });
    assert.equal(checkpoint.fraction, 0.55);
  }
});

test("PR249 follow-up: deleted child owners stay deleted across repeated Mission and run reads", () => {
  const directory = "fixture:deleted-child-cache", m = mission(), r = run();
  m.attempts = [{ childSessionID: "worker" }] as never;
  m.review = { child: "reviewer" } as never;
  m.workQuantity = planWorkQuantity(m, [work()], r);
  try {
    rememberWorkMission(directory, m); rememberWorkRun(directory, r);
    for (const actor of ["worker", "reviewer"]) {
      forgetWorkSession(directory, actor);
      rememberWorkMission(directory, m); rememberWorkRun(directory, r);
      assert.equal(workRootForActor(directory, actor), undefined);
      assert.equal(observeActorWork(directory, actor, { kind: "change", paths: ["src/a.ts"] }), undefined);
      assert.equal(workRootForActor(directory, "coordinator"), "root");
    }
  } finally { forgetWorkDirectory(directory); }
});

test("malformed optional estimates cannot reject execution or duplicate aliases", () => {
  const m = mission(), raw = [work()], r = run(raw), fallback = planWorkQuantity(m, raw, r);
  for (const invalid of [null, {}, "bad", [null, { id: "x", bindings: { paths: ["unknown"] } }]]) {
    assert.deepEqual(planWorkQuantity(m, raw, r, undefined, invalid), fallback);
  }
  const state = planWorkQuantity(m, raw, r, undefined, [
    { id: "x", bindings: { paths: ["src/a.ts"] }, relative_weight: -1 },
    { id: "x", bindings: { paths: ["src/b.ts"] }, relative_weight: 99 },
    { id: "alias", bindings: { paths: ["src/a.ts"] }, relative_weight: 999 },
  ]);
  assert.equal(state.estimatedTotal, fallback.estimatedTotal);
});

test("native tool schemas accept malformed display metadata so the host fallback can preserve execution", async () => {
  const hooks = await SortieDogsV010Plugin({ directory: resolve("_testenv/schema-work-quantity") } as never);
  for (const name of ["sortie_v010_start_mission", "sortie_v010_plan_units"]) {
    const schema = toolSchema(hooks.tool![name]!.args).properties.work_quantities;
    const validate = new Ajv({ strict: false }).compile(schema);
    for (const value of [null, "bad", 3, false, {}, [null, { relative_weight: "bad" }]]) assert.equal(validate(value), true);
  }
});

test("display state survives a JSON roundtrip without undefined fields leaking into failed-save comparisons", () => {
  const m = mission(), r = run(), state = planWorkQuantity(m, [work()], r);
  syncWorkQuantity(state, {}, r);
  observeWorkQuantity(state, { kind: "command-end", command: "npm test", exit: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
});

test("replan retains omitted work, adjusts scope downward in n, and does not count repeated attempts twice", () => {
  const m = mission(), r = run(), initial = syncWorkQuantity(planWorkQuantity(m, [work()], r), m,
    { ...r, units: r.units.map(unit => ({ ...unit, status: "succeeded" })) });
  const before = projectWorkQuantity(initial).n;
  m.requirements.push({ id: "R2", text: "Deliver additional behavior" });
  const updated = planWorkQuantity(m, [], undefined, initial);
  assert.ok(projectWorkQuantity(updated).n < before);
  assert.ok(updated.items.some(item => item.id === "artifact:src/b.ts" && !item.removed));
  assert.equal(updated.scopeID, initial.scopeID);
  assert.ok(updated.revision > initial.revision);
  assert.match(formatWorkQuantity(projectWorkQuantity(updated)), /見積更新/);
  const next = run([work(["src/a.ts"])], "run-two"); m.runID = next.runID;
  const again = planWorkQuantity(m, [work(["src/a.ts"])], next, updated);
  const settled = syncWorkQuantity(again, m, { ...next, units: next.units.map(unit => ({ ...unit, status: "succeeded" })) });
  assert.equal(settled.items.filter(item => item.id === "artifact:src/a.ts").length, 1);
});

test("PASS observations and submission never imply100; only the existing formal request completion does", () => {
  const m = mission(), r = run(), state = planWorkQuantity(m, [work()], r);
  r.units.forEach(unit => unit.status = "succeeded");
  m.review = { runID: r.runID, risk: [], source: "source", task: null, verdict: "PASS" };
  m.submission = { status: "ready", summary: "Delivered" };
  syncWorkQuantity(state, m, r);
  assert.ok(projectWorkQuantity(state).n < 100);
  m.phase = "completed"; syncWorkQuantity(state, m, r);
  assert.equal(projectWorkQuantity(state, true).n, 100);
});

test("existing formal request acceptance closes missing display bindings without another completion or verification step", () => {
  const state = planWorkQuantity(mission(), [work()], run());
  assert.equal(projectWorkQuantity(state).n, 0);
  const accepted = projectWorkQuantity(state, true);
  assert.equal(accepted.n, 100);
  assert.equal(accepted.estimated_done, accepted.estimated_total);
  assert.deepEqual(accepted.remaining_kinds, []);
  assert.ok(projectWorkQuantity(state, true, true).n < 100, "explicit cancellation is never completion");
});

test("review findings and later mutation reduce the estimate without rescanning or recertifying checks", () => {
  const m = mission(), r = run(), state = planWorkQuantity(m, [work()], r);
  r.units.forEach(unit => unit.status = "succeeded"); syncWorkQuantity(state, m, r);
  const n = projectWorkQuantity(state).n;
  m.review = { runID: r.runID, risk: [], source: "one", task: null, verdict: "findings" };
  syncWorkQuantity(state, m, r);
  assert.ok(projectWorkQuantity(state).n < n);
  const revision = state.revision;
  syncWorkQuantity(state, m, r); assert.equal(state.revision, revision);
  observeWorkQuantity(state, { kind: "change", paths: ["src/a.ts"], unit: "run-one/unit-1" });
  syncWorkQuantity(state, m, r); assert.ok(projectWorkQuantity(state).n < n);
});

test("terminal operation failure can finish result collection but not formal acceptance", () => {
  const m = mission(["Run once and collect its result"]), r = run(), state = planWorkQuantity({ ...m,
    kind: "operation", execution: { commands: ["run benchmark"], directory: ".", observations: [] } }, [work()], r);
  m.execution = { commands: ["run benchmark"], directory: ".", observations: [{ command: "run benchmark", directory: ".", callID: "operation",
    sessionID: "worker", startedAt: "start", completedAt: "end", outcome: "execution-failed", status: "error", exit: 1 }] };
  syncWorkQuantity(state, m, r);
  assert.equal(state.items.find(item => item.kind === "operation")?.fraction, 1);
  assert.equal(projectWorkQuantity(state).completed, false);
  m.phase = "cancelled";
  assert.equal(projectWorkQuantity(state, false, true).cancelled, true);
  assert.ok(projectWorkQuantity(state, false, true).n < 100);
});

test("negative constraints are not separate implementation work; explicit manual acceptance remains visible", () => {
  const state = planWorkQuantity(mission(["Implement feature", "Never modify product", "Manual acceptance by user"]));
  assert.equal(state.items.filter(item => item.kind === "requirement").length, 2);
  assert.ok(projectWorkQuantity(state).remaining_kinds.includes("user-acceptance"));
});

test("requested PR/push/publication remain work after submission; observed delivery does not grant completion", () => {
  const m = mission(["Implement feature", "Create PR", "Push changes", "npm publish package"]), r = run();
  const state = planWorkQuantity(m, [work()], r);
  m.submission = { status: "ready", summary: "Feature ready" };
  syncWorkQuantity(state, m, r);
  const delivery = state.items.filter(item => item.id.startsWith("delivery-requirement:"));
  assert.equal(delivery.length, 3); assert.ok(delivery.every(item => item.fraction === 0));
  observeWorkQuantity(state, { kind: "command-end", command: "gh pr create --title Feature", exit: 0 });
  assert.equal(delivery.find(item => item.commandPattern === "pr")?.fraction, 0.9);
  assert.equal(delivery.find(item => item.commandPattern === "publish")?.fraction, 0);
  assert.ok(projectWorkQuantity(state).n < 100);
});

test("new requirements affecting existing outputs add workload without erasing prior completed quantity", () => {
  const m = mission(), r = run();
  r.units.forEach(unit => unit.status = "succeeded");
  const prior = syncWorkQuantity(planWorkQuantity(m, [work()], r), m, r), done = prior.estimatedDone;
  m.requirements.push({ id: "R2", text: "Add behavior in the same files" });
  const next = run([work()], "run-two"); m.runID = next.runID;
  const state = planWorkQuantity(m, [work()], next, prior);
  assert.ok(state.estimatedTotal > prior.estimatedTotal);
  assert.equal(state.estimatedDone, done);
  assert.ok(projectWorkQuantity(state).n < projectWorkQuantity(prior).n);
});

test("retained declared checkpoint bindings follow a new run when metadata is omitted", () => {
  const m = mission(), unit = work(), initialRun = run(), first = planWorkQuantity(m, [unit], initialRun, undefined, [{
    id: "feature", kind: "artifact", bindings: { paths: ["src/a.ts", "src/b.ts"] }, relative_weight: 16,
    checkpoints: [{ id: "a", paths: ["src/a.ts"] }, { id: "b", paths: ["src/b.ts"] }],
  }]);
  const next = run([unit], "run-two"); m.runID = next.runID;
  const state = planWorkQuantity(m, [unit], next, first);
  assert.ok(state.items.filter(item => item.parentID && !item.removed).every(item => item.units[0] === "run-two/unit-1"));
  next.units.forEach(unit => unit.status = "succeeded"); syncWorkQuantity(state, m, next);
  assert.ok(state.items.filter(item => item.parentID && !item.removed).every(item => item.fraction === 1));
  assert.equal(state.estimatedTotal, first.estimatedTotal);
});

test("already-admitted native scope expansion discovers additional targets without resetting request work", () => {
  const m = mission(), raw = [work(["src/a.ts"])], r = run(raw), state = planWorkQuantity(m, raw, r);
  const total = state.estimatedTotal;
  observeWorkQuantity(state, { kind: "change", paths: ["src/b.ts"], unit: "run-one/unit-1" });
  assert.ok(state.estimatedTotal > total);
  assert.equal(state.items.find(item => item.id === "artifact:src/b.ts")?.fraction, 0.55);
  assert.equal(state.scopeID, m.id);
  const revised = state.estimatedTotal;
  observeWorkQuantity(state, { kind: "change", paths: ["src/b.ts"], unit: "run-one/unit-1" });
  assert.equal(state.estimatedTotal, revised);
});

test("legacy root runs retain review work and reach100 only through recorded root completion", () => {
  const m = mission(), r = run(); m.id = "operator:run-one";
  const state = planWorkQuantity(m, [work()], r);
  r.units.forEach(unit => unit.status = "succeeded"); syncWorkQuantity(state, {}, r);
  assert.ok(projectWorkQuantity(state).remaining_kinds.includes("review"));
  r.phase = "completed"; syncWorkQuantity(state, {}, r);
  assert.equal(projectWorkQuantity(state, true).n, 100);
});

test("native Worker/direct observation cache is bounded, idempotent, and merged into existing saves", () => {
  const directory = "fixture:cache", m = mission(), r = run();
  m.workQuantity = planWorkQuantity(m, [work()], r);
  m.workQuantity.observationSequence = 800;
  rememberWorkMission(directory, m); rememberWorkRun(directory, r);
  assert.equal(observeActorWork(directory, "foreign", { kind: "change", paths: ["src/a.ts"] }), undefined);
  observeActorWork(directory, "worker", { kind: "change", paths: ["src/a.ts"] });
  const first = cachedWorkProgress(directory, "root")!;
  assert.ok(first.n > 0);
  for (let i = 0; i < 600; i++) observeActorWork(directory, "worker", { kind: "change", paths: ["src/a.ts"], callID: `edit-${i}` });
  assert.equal(cachedWorkProgress(directory, "worker")?.n, first.n);
  applyPendingWork(directory, "root", m.workQuantity);
  const saved = JSON.stringify(m.workQuantity); applyPendingWork(directory, "root", m.workQuantity);
  assert.equal(JSON.stringify(m.workQuantity), saved);
  assert.ok(m.workQuantity.observationSequence > 800, "restart sequence cannot hide all new events");
});

test("review follow-up: terminal Missions release heavy cached objects and child ownership", () => {
  for (const phase of ["completed", "cancelled"] as const) {
    const directory = `fixture:terminal-cache:${phase}`, m = mission(), r = run();
    m.workQuantity = planWorkQuantity(m, [work()], r);
    rememberWorkMission(directory, m); rememberWorkRun(directory, r);
    observeActorWork(directory, "worker", { kind: "change", paths: ["src/a.ts"] });
    m.phase = phase; rememberWorkMission(directory, m);
    assert.equal(rememberedWorkRun(directory, "root"), undefined);
    assert.equal(workRootForActor(directory, "worker"), undefined);
    assert.equal(observeActorWork(directory, "worker", { kind: "change", paths: ["src/b.ts"] }), undefined);
    assert.equal(cachedWorkProgress(directory, "root")?.completed, phase === "completed");
    assert.equal(cachedWorkProgress(directory, "root")?.cancelled, phase === "cancelled");
  }
});

test("review follow-up: terminal snapshots are bounded and deletion is scoped to session and directory", () => {
  const directory = "fixture:cache-cleanup", other = `${directory}-other`;
  for (let i = 0; i < 140; i++) {
    const m = { ...mission(), root: `root-${i}`, coordinator: `coordinator-${i}`, phase: "completed" as const };
    m.workQuantity = planWorkQuantity(m, [work()]); rememberWorkMission(directory, m);
  }
  assert.equal(cachedWorkProgress(directory, "root-0"), undefined);
  assert.equal(cachedWorkProgress(directory, "root-139")?.n, 100);
  forgetWorkSession(directory, "root-139");
  assert.equal(cachedWorkProgress(directory, "root-139"), undefined);
  const m = mission(), r = run(); m.workQuantity = planWorkQuantity(m, [work()], r);
  rememberWorkMission(directory, m); rememberWorkRun(directory, r);
  rememberWorkMission(other, m); rememberWorkRun(other, r);
  forgetWorkSession(directory, "worker");
  assert.equal(workRootForActor(directory, "worker"), undefined);
  assert.equal(workRootForActor(directory, "coordinator"), "root");
  assert.ok(rememberedWorkRun(directory, "root"), "deleting a child must not discard a live root");
  forgetWorkDirectory(directory);
  assert.equal(cachedWorkProgress(directory, "root"), undefined);
  assert.equal(cachedWorkProgress(directory, "root-138"), undefined);
  assert.equal(workRootForActor(directory, "coordinator"), undefined);
  assert.ok(cachedWorkProgress(other, "root"));
  forgetWorkDirectory(other);
});

test("review follow-up: profiled continuation checkpoints exclude dynamic workload", async () => {
  const source = await readFile(new URL("../src/plugin/profiled.ts", import.meta.url), "utf8");
  const route = source.slice(source.indexOf("continuationCheckpoint: async root =>"), source.indexOf("completedReviewPrompts: async"));
  assert.match(route, /missionPacket\(mission, run, false\)/u);
  const m = mission(), r = run(); m.workQuantity = planWorkQuantity(m, [work()], r);
  const before = JSON.stringify(missionPacket(m, r, false));
  observeWorkQuantity(m.workQuantity, { kind: "change", paths: ["src/a.ts"] });
  assert.equal(JSON.stringify(missionPacket(m, r, false)), before);
  assert.ok(Object.hasOwn(missionPacket(m, r), "work_quantity"), "ordinary status still includes progress");
});

test("pure rendering is constant-cost and cannot read even a huge irrelevant history", t => {
  const state = planWorkQuantity(mission(), [work()], run());
  const calls: string[] = [];
  const forbidden = (name: string) => () => { calls.push(name); throw new Error(`progress called ${name}`); };
  for (const name of ["readFile", "writeFile", "readdir", "stat"] as const) t.mock.method(fs, name, forbidden(name));
  t.mock.method(crypto, "createHash", forbidden("hash"));
  t.mock.method(childProcess, "spawn", forbidden("spawn"));
  t.mock.method(childProcess, "execFile", forbidden("execFile"));
  t.mock.method(globalThis, "fetch", forbidden("network"));
  observeWorkQuantity(state, { kind: "read", paths: ["foreign.txt"] });
  Object.defineProperty(state, "history", { get() { throw new Error("history accessed"); } });
  Object.defineProperty(state, "items", { get() { throw new Error("render rescanned workload"); } });
  const start = performance.now();
  for (let i = 0; i < 10000; i++) assert.equal(projectWorkQuantity(state).n, 0);
  const ms = performance.now() - start;
  assert.deepEqual(calls, []);
  console.log(`WORK_QUANTITY_RENDER ${JSON.stringify({ projections: 10000, ms, externalCalls: calls.length })}`);
});

test("multiple live Task transports share progress without overwriting the enclosing Coordinator sink", async () => {
  const received: string[] = [], unbindA = bindMissionProgress("fixture:sinks", async () => { received.push("coordinator"); });
  const unbindB = bindMissionProgress("fixture:sinks", async () => { received.push("worker"); });
  try { await publishMissionProgress("fixture:sinks", {}); unbindB(); await publishMissionProgress("fixture:sinks", {});
    assert.deepEqual(received, ["coordinator", "worker", "coordinator"]);
  } finally { unbindA(); unbindB(); }
});

test("a failed display sink never interrupts the actual native tool or other progress consumers", async () => {
  let updates = 0;
  const broken = bindMissionProgress("fixture:broken-sink", () => { throw new Error("display unavailable"); });
  const working = bindMissionProgress("fixture:broken-sink", async () => { updates++; });
  try { await publishMissionProgress("fixture:broken-sink", { description: "progress" }); assert.equal(updates, 1); }
  finally { broken(); working(); }
});

test("native status truncation keeps workload before bulky evidence", () => {
  const state = planWorkQuantity(mission(), [work()], run());
  const output = serializeOperatorStatus({ units: "x".repeat(40000), work_quantity: projectWorkQuantity(state), next_action: "continue" });
  assert.ok(output.indexOf('"work_quantity"') < output.indexOf('"units"'));
});

test("real durable Mission resumes without resetting quantity or altering execution plan/reference bytes", async () => {
  const directory = await mkdtemp(resolve("_testenv/work-quantity-"));
  try {
    const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE), operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
    await missions.capture("root", { id: "u1", text: "Implement result" });
    const m = await missions.start("root", ["Implement result"]), raw = [work(["result.txt"], ["node check.mjs"])];
    const planBefore = JSON.stringify(missionPlan(m, raw));
    const r = await operators.prepareMission("root", JSON.parse(planBefore));
    await missions.update("root", state => { state.runID = r.runID; state.callID = "call"; });
    const prompt = r.units[0]!.task.prompt, handoff = await readFile(r.units[0]!.handoffPath, "utf8"), hashes = [...r.units[0]!.hashes];
    observeActorWork(directory, "root", { kind: "change", paths: ["result.txt"], unit: `${r.runID}/unit-1` });
    await missions.update("root", state => { state.sourceAuthors = ["root"]; });
    const cold = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
    assert.ok(cold.workQuantity!.estimatedDone > 0);
    assert.equal(JSON.stringify(missionPlan(cold, raw)), planBefore);
    assert.equal((await operators.required("root")).units[0]!.task.prompt, prompt);
    assert.deepEqual((await operators.required("root")).units[0]!.hashes, hashes);
    assert.equal(await readFile(r.units[0]!.handoffPath, "utf8"), handoff);
    const progress = await missionProgressReader(directory, "root", "call")();
    assert.match(String(progress?.description), /全体作業量 \d+\/100/);
    await missions.update("root", state => { state.phase = "cancelled"; });
    await missions.capture("root", { id: "u2", text: "Continue same request" });
    const continued = await missions.start("root", ["Implement result"]);
    assert.equal(continued.workQuantity?.scopeID, cold.workQuantity?.scopeID);
    assert.equal(continued.workQuantity?.estimatedDone, cold.workQuantity?.estimatedDone);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
