import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { completedMissionReviewPrompts, initialMissionReviewPrompt, missionReviewBaseline, missionReviewSource,
  observedMissionValidation } from "../dist/plugin/mission-review.js";
import { MISSION_REVIEW_REFERENCE, type OperatorMission } from "../dist/core/operator-mission.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { FastLaneController } from "../dist/plugin/fast-lane.js";
import { declaredArtifacts } from "../dist/plugin/declared-artifacts.js";

const git = promisify(execFile);

test("native validation history reports only the current Worker's exact commands and real exits", () => {
  const part = (command: string, exit?: number, started = 100) => ({ type: "tool", tool: "shell", state: {
    status: "completed", input: { command }, metadata: exit === undefined ? {} : { exit } },
    time: { ran: started, completed: started + 20 } });
  const history = [
    { info: { role: "assistant", sessionID: "previous-worker" }, parts: [part("node build.mjs", 0)] },
    { info: { role: "user", sessionID: "worker" }, parts: [part("node build.mjs", 0)] },
    { info: { role: "assistant", sessionID: "worker" }, parts: [{ type: "text", text: "node build.mjs PASS" },
      part("node build.mjs"), part("node check.mjs", 1, 200), part("node check.mjs", 0, 300), part("node other.mjs", 0)] },
  ];
  const result = observedMissionValidation(["node build.mjs", "node check.mjs"], "worker", history);
  assert.deepEqual(result, { attempts: [
    { command: "node build.mjs", exit_code: null, started_ms: 100, completed_ms: 120 },
    { command: "node check.mjs", exit_code: 1, started_ms: 200, completed_ms: 220 },
    { command: "node check.mjs", exit_code: 0, started_ms: 300, completed_ms: 320 },
  ], not_observed: [], omitted_attempts: 0 });
  assert.deepEqual(observedMissionValidation(["node build.mjs", "node check.mjs"], "new-worker", history), {
    attempts: [], not_observed: ["node build.mjs", "node check.mjs"], omitted_attempts: 0 });
});

function reviewHistoryFixture() {
  const initial = "candidate_id: mission-current\nreview_phase: initial\ncanonical_validation_exit: 0\nrisk_tags: [public-logic]\nrevision: first";
  const verification = initial.replace("initial", "verification").replace("first", "fixed");
  const mission: OperatorMission = { version: "0.12", id: "mission-current", root: "root", phase: "running",
    requests: [], requirements: [], coordinator: "coordinator", callID: "coordinator-call", dispatchOpen: true,
    runID: "corrected-run", plans: 2, progress: [], submission: null,
    review: { runID: "corrected-run", risk: ["public-logic"], source: "fixed", verdict: "pending", child: "reviewer",
      task: { subagent_type: "dog-reviewer-v010", description: "Verify", prompt: verification } } };
  const identities: Record<string, { agent: string; parentID: string }> = {
    coordinator: { agent: "dogs-coordinator", parentID: "root" },
    reviewer: { agent: "dog-reviewer-v010", parentID: "coordinator" },
  };
  const completion = { type: "tool", tool: "task", state: { status: "completed",
    input: { subagent_type: "dog-reviewer-v010", prompt: initial, task_id: "" }, metadata: { sessionId: "reviewer" } } };
  const message = { info: { role: "assistant", sessionID: "coordinator" }, parts: [completion] };
  const childMessage = { info: { role: "user", sessionID: "reviewer" }, parts: [{ type: "text", text: initial, synthetic: false }] };
  const history: Record<string, Record<string, unknown>[]> = { coordinator: [message], reviewer: [childMessage] };
  const host = { get: async (id: string) => identities[id], messages: async (id: string) => history[id] ?? [] };
  return { initial, verification, mission, identities, completion, message, childMessage, history, host };
}

test("nested review recovery restores completed initial and verification prompts without resetting duplicate limits", async () => {
  const f = reviewHistoryFixture();
  f.history.coordinator!.push({ ...f.message, parts: [{ ...f.completion,
    state: { ...f.completion.state, input: { ...f.completion.state.input, prompt: f.verification } } }] });
  const prompts = await completedMissionReviewPrompts(f.mission, V010_RUNTIME_PROFILE, "root", f.verification, f.host);
  assert.deepEqual(prompts, [f.initial, f.verification]);
  const lane = new FastLaneController();
  lane.beginTurn("root", false);
  lane.restoreReviewLineage("root", f.verification, prompts);
  assert.throws(() => lane.beforeTool("root", "task", { subagent_type: "dog-reviewer", prompt: f.verification }), /CONSULTATION_RETRY_INVALID/);
  assert.doesNotThrow(() => lane.beforeTool("root", "task", { subagent_type: "dog-reviewer", prompt: `${f.verification}\nrevision: follow-up` }));
});

test("a previous child is not initial lineage when native history is unavailable", async () => {
  const f = reviewHistoryFixture();
  f.history.coordinator = [];
  assert.deepEqual(await completedMissionReviewPrompts(f.mission, V010_RUNTIME_PROFILE, "root", f.verification, f.host), []);
  assert.equal(initialMissionReviewPrompt(f.mission, []), undefined);
  f.mission.review!.initialPrompt = f.initial.replace("mission-current", "other-mission");
  assert.equal(initialMissionReviewPrompt(f.mission, []), undefined, "a different candidate is not review proof");
  f.mission.review!.initialPrompt = f.initial;
  assert.equal(initialMissionReviewPrompt(f.mission, []), f.initial);
  const unavailable = { ...f.host, messages: async () => { throw new Error("V2 history unavailable"); } };
  assert.deepEqual(await completedMissionReviewPrompts(f.mission, V010_RUNTIME_PROFILE, "root", f.verification, unavailable),
    [f.initial], "a completed initial receipt survives a cold turn without another history lookup");
  assert.deepEqual(await completedMissionReviewPrompts(f.mission, V010_RUNTIME_PROFILE, "other-root", f.verification, unavailable), []);
  assert.deepEqual(await completedMissionReviewPrompts(f.mission, V010_RUNTIME_PROFILE, "root", "foreign-request", unavailable), []);
  const lane = new FastLaneController();
  lane.beginTurn("root", false);
  lane.restoreReviewLineage("root", f.verification, [f.initial]);
  assert.doesNotThrow(() => lane.beforeTool("root", "task", { subagent_type: "dog-reviewer", prompt: f.verification }));
});

test("opaque historical review references require the exact hash-bound native child prompt", async () => {
  const f = reviewHistoryFixture();
  const ref = { r: "root", m: f.mission.id, n: "initial-run", h: createHash("sha256").update(f.initial).digest("hex") };
  f.completion.state.input.prompt = MISSION_REVIEW_REFERENCE + JSON.stringify(ref);
  f.childMessage.parts[0]!.text = `You are a subagent spawned by another session.\n${f.initial}`;
  const recover = () => completedMissionReviewPrompts(f.mission, V010_RUNTIME_PROFILE, "root", f.verification, f.host);
  assert.deepEqual(await recover(), [f.initial]);
  f.childMessage.parts[0]!.text += " altered";
  assert.deepEqual(await recover(), []);
  f.childMessage.parts[0]!.text = f.initial;
  for (const invalid of [{ ...ref, r: "foreign-root" }, { ...ref, m: "old-mission" }, { ...ref, h: "0".repeat(64) }]) {
    f.completion.state.input.prompt = MISSION_REVIEW_REFERENCE + JSON.stringify(invalid);
    assert.deepEqual(await recover(), []);
  }
});

test("review recovery rejects incomplete, foreign, stale and unbound history", async () => {
  const cases: [string, (f: ReturnType<typeof reviewHistoryFixture>) => void][] = [
    ["no completed history", f => { f.history.coordinator = []; }],
    ["running", f => { f.completion.state.status = "running"; }],
    ["failed", f => { f.completion.state.status = "error"; }],
    ["wrong message owner", f => { f.message.info.sessionID = "foreign"; }],
    ["user-authored", f => { f.message.info.role = "user"; }],
    ["wrong Coordinator parent", f => { f.identities.coordinator!.parentID = "foreign"; }],
    ["wrong Coordinator role", f => { f.identities.coordinator!.agent = "dog-worker-v010"; }],
    ["wrong Reviewer parent", f => { f.identities.reviewer!.parentID = "root"; }],
    ["wrong Reviewer role", f => { f.identities.reviewer!.agent = "dog-worker-v010"; }],
    ["missing child", f => { f.completion.state.metadata.sessionId = "missing"; }],
    ["resumed child", f => { f.completion.state.input.task_id = "reviewer"; }],
    ["foreign profile", f => { f.completion.state.input.subagent_type = "dog-reviewer"; }],
    ["wrong candidate", f => { f.completion.state.input.prompt = f.initial.replace("mission-current", "mission-old"); }],
    ["ambiguous candidate", f => { f.completion.state.input.prompt += "\ncandidate_id: mission-current"; }],
    ["cancelled mission", f => { f.mission.phase = "cancelled"; }],
    ["completed mission", f => { f.mission.phase = "completed"; }],
    ["wrong root", f => { f.mission.root = "foreign"; }],
    ["unbound request", f => { f.mission.review!.task!.prompt += " changed"; }],
  ];
  for (const [name, mutate] of cases) {
    const f = reviewHistoryFixture(); mutate(f);
    assert.deepEqual(await completedMissionReviewPrompts(f.mission, V010_RUNTIME_PROFILE, "root", f.verification, f.host), [], name);
  }
});

test("mission review source ignores the shared tool environment", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(join(resolve("_testenv"), "mission-review-"));
  try {
    await git("git", ["init", "--quiet"], { cwd: root });
    await git("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    await git("git", ["config", "user.name", "test"], { cwd: root });
    await writeFile(join(root, "product.py"), "base\n");
    await git("git", ["add", "product.py"], { cwd: root });
    await git("git", ["commit", "--quiet", "-m", "base"], { cwd: root });
    await writeFile(join(root, "product.py"), "fixed\n");
    await writeFile(join(root, "added_test.py"), "assert True\n");
    const run = { units: [{ unit: { write: ["."] }, hashes: ["h"] }] } as never;
    const before = await missionReviewSource(root, run);
    await mkdir(join(root, ".sortie-env", "bin"), { recursive: true });
    await writeFile(join(root, ".sortie-env", "bin", "python"), "tool environment\n");
    const after = await missionReviewSource(root, run);
    assert.equal(after.fingerprint, before.fingerprint);
    assert.match(after.excerpt, /new file: added_test\.py/u);
    assert.doesNotMatch(after.excerpt, /\.sortie-env/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("declared ignored evidence is excerpted and invalidates a review when its bytes change", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(join(resolve("_testenv"), "mission-artifacts-"));
  try {
    await git("git", ["init", "--quiet"], { cwd: root });
    await writeFile(join(root, ".gitignore"), "_testenv/\n");
    await mkdir(join(root, "_testenv"));
    await writeFile(join(root, "_testenv", "result.json"), '{"runtime":{"pid":22636},"review":"FINDINGS"}\n');
    await writeFile(join(root, "_testenv", "unrelated.json"), "not part of this candidate");
    const run = { units: [{ unit: { write: ["_testenv/result.json"] }, hashes: [] }] } as never;
    const first = await missionReviewSource(root, run);
    assert.match(first.excerpt, /"pid":22636/);
    assert.doesNotMatch(first.excerpt, /unrelated/);
    await writeFile(join(root, "_testenv", "result.json"), '{"runtime":{"pid":42},"review":"FINDINGS"}\n');
    const changed = await missionReviewSource(root, run);
    assert.notEqual(changed.fingerprint, first.fingerprint);
    assert.match(changed.excerpt, /"pid":42/);
    await rm(join(root, "_testenv", "result.json"));
    assert.notEqual((await missionReviewSource(root, run)).fingerprint, changed.fingerprint);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an ignored build cache in the write scope cannot displace review source or invalidate its proof", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(join(resolve("_testenv"), "mission-review-cache-"));
  try {
    await git("git", ["init", "--quiet"], { cwd: root });
    await git("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    await git("git", ["config", "user.name", "test"], { cwd: root });
    await writeFile(join(root, ".gitignore"), ".gocache/\n_testenv/\n");
    await writeFile(join(root, "source.js"), "export const answer = 0;\n");
    await git("git", ["add", ".gitignore", "source.js"], { cwd: root });
    await git("git", ["commit", "--quiet", "-m", "base"], { cwd: root });
    const baseline = await missionReviewBaseline(root);
    await writeFile(join(root, "source.js"), "export const answer = 42;\n");
    await git("git", ["add", "source.js"], { cwd: root });
    await git("git", ["commit", "--quiet", "-m", "candidate"], { cwd: root });
    await mkdir(join(root, ".gocache"));
    await mkdir(join(root, "_testenv"));
    await writeFile(join(root, ".gocache", "cache"), "cache content ".repeat(5_000));
    await writeFile(join(root, "_testenv", "result.json"), '{"result":"observed"}\n');
    const run = { units: [{ unit: { write: ["source.js", ".gocache/**", "_testenv/**"] }, hashes: [] }] } as never;
    const first = await missionReviewSource(root, run, [], baseline);
    assert.match(first.excerpt, /export const answer = 42/u);
    assert.match(first.excerpt, /"result":"observed"/u, "ignored output directories remain visible");
    assert.doesNotMatch(first.excerpt, /\.gocache|cache content/u);
    await writeFile(join(root, ".gocache", "cache"), "different cache content");
    assert.equal((await missionReviewSource(root, run, [], baseline)).fingerprint, first.fingerprint,
      "tool cache activity cannot stale a review of unchanged candidate source");
    const cacheEvidence = [{ path: ".gocache/cache", offset: 1, limit: 1 }];
    const pinnedCache = await missionReviewSource(root, run, cacheEvidence, baseline);
    assert.match(pinnedCache.excerpt, /1: different cache content/u);
    await writeFile(join(root, ".gocache", "cache"), "explicit cache evidence changed");
    assert.notEqual((await missionReviewSource(root, run, cacheEvidence, baseline)).fingerprint, pinnedCache.fingerprint,
      "an explicit reference still pins ignored bytes");
    await writeFile(join(root, "_testenv", "result.json"), '{"result":"changed"}\n');
    assert.notEqual((await missionReviewSource(root, run, [], baseline)).fingerprint, first.fingerprint,
      "the ignored output directory still invalidates stale review proof");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("committed candidates still supply current source and large artifacts expose truncation", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(join(resolve("_testenv"), "mission-committed-"));
  try {
    await git("git", ["init", "--quiet"], { cwd: root });
    await git("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    await git("git", ["config", "user.name", "test"], { cwd: root });
    await writeFile(join(root, "source.js"), 'export const result = "validated";\n');
    await git("git", ["add", "source.js"], { cwd: root });
    await git("git", ["commit", "--quiet", "-m", "candidate"], { cwd: root });
    const source = await missionReviewSource(root, { units: [{ unit: { write: ["source.js"] }, hashes: [] }] } as never);
    assert.match(source.excerpt, /current file: source.js/);
    assert.match(source.excerpt, /validated/);
    await writeFile(join(root, "large.txt"), "a".repeat(100_000));
    const run = { units: [{ unit: { write: ["large.txt"] }, hashes: [] }] } as never;
    const first = await missionReviewSource(root, run);
    assert.ok(Buffer.byteLength(first.excerpt) < 25_000);
    assert.match(first.excerpt, /EXCERPT TRUNCATED: large.txt/);
    await writeFile(join(root, "large.txt"), "a".repeat(99_999) + "b");
    assert.notEqual((await missionReviewSource(root, run)).fingerprint, first.fingerprint, "unshown tail bytes are still fingerprinted");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("mission baseline exposes committed changes across replans without a generated file swallowing later changes", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(join(resolve("_testenv"), "mission-review-baseline-"));
  try {
    await git("git", ["init", "--quiet"], { cwd: root });
    await git("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    await git("git", ["config", "user.name", "test"], { cwd: root });
    for (const [name, content] of [["a.js", "export const value = 0;\n"], ["generated.js", "// generated\n"],
      ["z_test.js", "assert.equal(value, 0);\n"], ["outside.js", "untouched\n"]]) {
      await writeFile(join(root, name), content);
    }
    await git("git", ["add", "--all"], { cwd: root });
    await git("git", ["commit", "--quiet", "-m", "base"], { cwd: root });
    const baseline = await missionReviewBaseline(root);
    assert.match(baseline!, /^[a-f0-9]{40,64}$/u);
    await writeFile(join(root, "a.js"), "export const value = 42;\n");
    await writeFile(join(root, "generated.js"), "// generated\n" + "long-generated-line\n".repeat(10_000));
    await writeFile(join(root, "z_test.js"), "assert.equal(value, 42);\n");
    await writeFile(join(root, "outside.js"), "unrelated change\n");
    await git("git", ["add", "--all"], { cwd: root });
    await git("git", ["commit", "--quiet", "-m", "candidate"], { cwd: root });
    const run = { units: [{ unit: { write: ["a.js", "generated.js", "z_test.js"] }, hashes: [] }] } as never;
    const source = await missionReviewSource(root, run, [], baseline);
    assert.match(source.excerpt, /Changed since mission baseline/u);
    assert.match(source.excerpt, /export const value = 42/u);
    assert.match(source.excerpt, /assert\.equal\(value, 42\)/u);
    assert.doesNotMatch(source.excerpt, /unrelated change/u);
    assert.ok(Buffer.byteLength(source.excerpt) < 25_000);
    assert.match(source.excerpt, /EXCERPT TRUNCATED: generated\.js/u);
    await writeFile(join(root, "z_test.js"), "assert.equal(value, 43);\n");
    assert.notEqual((await missionReviewSource(root, run, [], baseline)).fingerprint, source.fingerprint);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("focused review shares unused reference space and keeps changed-file inventory visible", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(join(resolve("_testenv"), "mission-review-focused-"));
  try {
    await git("git", ["init", "--quiet"], { cwd: root });
    await git("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    await git("git", ["config", "user.name", "test"], { cwd: root });
    const paths = ["impl0.go", "impl1.go", "impl2.go", "impl3.go", "shortA.go", "shortB.go", "generated.go"];
    for (const path of paths) await writeFile(join(root, path), "base\n");
    await git("git", ["add", "--all"], { cwd: root });
    await git("git", ["commit", "--quiet", "-m", "base"], { cwd: root });
    const baseline = await missionReviewBaseline(root);
    for (let index = 0; index < 4; index++) {
      const count = index === 0 ? 120 : 40;
      await writeFile(join(root, paths[index]!), Array.from({ length: count }, (_, line) =>
        `branch_${index}_${line + 1} = "${"x".repeat(65)}"\n`).join(""));
    }
    await writeFile(join(root, "shortA.go"), "short_acceptance_A\n");
    await writeFile(join(root, "shortB.go"), "short_acceptance_B\n");
    await writeFile(join(root, "generated.go"), "// generated\n" + "generated\n".repeat(10_000));
    await git("git", ["add", "--all"], { cwd: root });
    await git("git", ["commit", "--quiet", "-m", "candidate"], { cwd: root });
    const evidence = paths.slice(0, 6).map((path, index) => ({ path, offset: 1, limit: index === 0 ? 120 : 40 }));
    const run = { units: [{ unit: { write: ["."] }, hashes: [] }] } as never;
    const source = await missionReviewSource(root, run, evidence, baseline);
    for (let index = 1; index < 4; index++) {
      assert.match(source.excerpt, new RegExp(`40: branch_${index}_40 =`), "a long, acceptance-relevant tail remains visible");
      assert.doesNotMatch(source.excerpt, new RegExp(`FOCUSED EXCERPT TRUNCATED: impl${index}\\.go`));
    }
    assert.match(source.excerpt, /short_acceptance_A/u);
    assert.match(source.excerpt, /short_acceptance_B/u);
    assert.match(source.excerpt, /FOCUSED EXCERPT TRUNCATED: impl0\.go:1/u);
    assert.match(source.excerpt, /--- changed: generated\.go ---/u);
    assert.ok(Buffer.byteLength(source.excerpt) < 25_000);
    await appendFile(join(root, "impl2.go"), "changed outside original selection\n");
    assert.notEqual((await missionReviewSource(root, run, evidence, baseline)).fingerprint, source.fingerprint);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("read-only units do not accidentally collect an entire repository and ignored tooling", async () => {
  const packet = await missionReviewSource("nonexistent-directory", { units: [{ unit: { write: [], read: ["src"] }, hashes: [] }] } as never);
  assert.match(packet.excerpt, /Read-only units: no declared output files/);
});

test("read-only and test-only replans retain earlier source, deletion and stale-review coverage", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(join(resolve("_testenv"), "mission-replan-source-"));
  try {
    await git("git", ["init", "--quiet"], { cwd: root });
    await git("git", ["config", "user.name", "test"], { cwd: root });
    await git("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    await writeFile(join(root, "source.js"), "return oldValue;\n");
    await writeFile(join(root, "deleted.js"), "old path\n");
    await writeFile(join(root, "outside.js"), "unrelated\n");
    await git("git", ["add", "--all"], { cwd: root });
    await git("git", ["commit", "--quiet", "-m", "base"], { cwd: root });
    const baseline = await missionReviewBaseline(root);
    await writeFile(join(root, "source.js"), "return nilValue;\n");
    await rm(join(root, "deleted.js"));
    await writeFile(join(root, "outside.js"), "must not appear\n");
    await git("git", ["add", "--all"], { cwd: root });
    await git("git", ["commit", "--quiet", "-m", "implementation before replan"], { cwd: root });
    const scope = { read: [], write: ["source.js", "deleted.js"] };
    for (const write of [[], ["test.js"]]) {
      const run = { units: [{ unit: { read: [], write }, hashes: [] }] } as never;
      const source = await missionReviewSource(root, run, [{ path: "source.js", offset: 1, limit: 1 }], baseline, scope);
      assert.match(source.excerpt, /changed: source\.js/);
      assert.match(source.excerpt, /changed: deleted\.js/);
      assert.match(source.excerpt, /return nilValue/);
      assert.doesNotMatch(source.excerpt, /must not appear|Read-only units/);
      const automatic = await missionReviewSource(root, run, [], baseline, scope);
      await writeFile(join(root, "source.js"), "return broken;\n");
      assert.notEqual((await missionReviewSource(root, run, [], baseline, scope)).fingerprint, automatic.fingerprint);
      const changed = await missionReviewSource(root, run, [{ path: "source.js", offset: 1, limit: 1 }], baseline, scope);
      assert.notEqual(changed.fingerprint, source.fingerprint, "earlier implementation changes invalidate the review");
      await writeFile(join(root, "source.js"), "return nilValue;\n");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("large focused tests do not starve a later requested error branch", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(join(resolve("_testenv"), "mission-focused-budget-"));
  try {
    await writeFile(join(root, "large_test.js"), ("test fixture ".repeat(20) + "\n").repeat(200));
    await writeFile(join(root, "source.js"), "if (error) return [null, error];\n");
    const run = { units: [{ unit: { read: ["large_test.js", "source.js"], write: [] }, hashes: [] }] } as never;
    const packet = await missionReviewSource(root, run, [
      { path: "large_test.js", offset: 1, limit: 200 }, { path: "source.js", offset: 1, limit: 1 },
    ]);
    assert.match(packet.excerpt, /FOCUSED EXCERPT TRUNCATED: large_test\.js/);
    assert.deepEqual(packet.truncatedEvidence, ["large_test.js:1"], "the Coordinator can narrow this reference before paying for a Reviewer");
    assert.match(packet.excerpt, /1: if \(error\) return \[null, error\]/);
    assert.ok(Buffer.byteLength(packet.excerpt) < 12_000);
    const narrowed = await missionReviewSource(root, run, [
      { path: "large_test.js", offset: 1, limit: 5 }, { path: "source.js", offset: 1, limit: 1 },
    ]);
    assert.deepEqual(narrowed.truncatedEvidence, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("six single-line references fitting the read-only budget are not displaced by unused notices", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(join(resolve("_testenv"), "mission-focused-lines-"));
  try {
    const paths = ["a.log", "b.log", "c.log", "d.log", "e.log", "f.log"];
    for (const path of paths) await writeFile(join(root, path), "x".repeat(1_796) + "\n");
    const run = { units: [{ unit: { read: paths, write: [] }, hashes: [] }] } as never;
    const packet = await missionReviewSource(root, run, paths.map(path => ({ path, offset: 1, limit: 1 })));
    for (const path of paths) {
      assert.match(packet.excerpt, new RegExp(`--- evidence: ${path.replace(".", "\\.")}:1 ---\\n1: x{1796}\\n`));
      assert.doesNotMatch(packet.excerpt, new RegExp(`FOCUSED EXCERPT TRUNCATED: ${path.replace(".", "\\.")}`));
    }
    assert.ok(Buffer.byteLength(packet.excerpt) < 12_000);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("focused read-only review consumes the original result tail and pins unshown bytes", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(join(resolve("_testenv"), "mission-result-tail-"));
  try {
    const prefix = "setup\n".repeat(6000);
    await writeFile(join(root, "result.log"), prefix + '{"attempts":1,"reward":0}\n');
    const run = { units: [{ unit: { read: ["result.log"], write: [] }, hashes: [] }] } as never;
    const selection = [{ path: "result.log", offset: 6001, limit: 1 }];
    const first = await missionReviewSource(root, run, selection);
    assert.match(first.excerpt, /6001:.*"reward":0/);
    assert.doesNotMatch(first.excerpt, /setup/);
    await writeFile(join(root, "result.log"), prefix.replace("setup", "other") + '{"attempts":1,"reward":0}\n');
    assert.notEqual((await missionReviewSource(root, run, selection)).fingerprint, first.fingerprint);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("review references can use adjacent project sources without changing the validated unit", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(join(resolve("_testenv"), "mission-reference-"));
  try {
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "contract.md"), "public entrypoint\nimplementation detail\n");
    const run = { units: [{ unit: { read: ["check.mjs"], write: [] }, hashes: ["validated-source"] }] } as never;
    const saved = structuredClone(run);
    const selection = [{ path: "docs/contract.md", offset: 1, limit: 1 }];
    const source = await missionReviewSource(root, run, selection);
    assert.match(source.excerpt, /evidence: docs\/contract.md:1/u);
    assert.match(source.excerpt, /1: public entrypoint/u);
    assert.doesNotMatch(source.excerpt, /implementation detail/u);
    await writeFile(join(root, "docs", "contract.md"), "public entrypoint\nchanged detail\n");
    assert.notEqual((await missionReviewSource(root, run, selection)).fingerprint, source.fingerprint,
      "even unshown reference bytes invalidate the review");
    assert.deepEqual(run, saved, "review references never expand the validated unit");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("review references retain declared external inputs and report actionable path errors", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(join(resolve("_testenv"), "mission-external-reference-"));
  try {
    const project = join(root, "project"), external = join(root, "report.log");
    await mkdir(project);
    await writeFile(external, "observed result\n");
    await writeFile(join(project, "source.py"), "public source\n");
    const run = { units: [{ unit: { read: [external], write: [] }, hashes: [] }] } as never;
    const source = await missionReviewSource(project, run, [{ path: external, offset: 1, limit: 1 }]);
    assert.match(source.excerpt, /observed result/u);
    for (const [entry, reason] of [
      [{ path: "missing.py", offset: 1, limit: 1 }, /missing.py: ENOENT/u],
      [{ path: ".", offset: 1, limit: 1 }, /\.: select a regular file/u],
      [{ path: "source.py", offset: 2, limit: 1 }, /source.py: offset 2 exceeds 1 lines/u],
      [{ path: "source.py", offset: 1, limit: 201 }, /source.py: use a positive line offset/u],
      [{ path: "../undeclared.log", offset: 1, limit: 1 }, /undeclared.log: outside the project/u],
    ] as const) {
      await assert.rejects(missionReviewSource(project, run, [entry]), reason);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("narrow replans retain earlier declared external review references", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(join(resolve("_testenv"), "mission-external-replan-"));
  try {
    const project = join(root, "project"), external = join(root, "report.log");
    await mkdir(project);
    await writeFile(external, "prior observation\n");
    const run = { units: [{ unit: { read: ["test.js"], write: [] }, hashes: [] }] } as never;
    const source = await missionReviewSource(project, run, [{ path: external, offset: 1, limit: 1 }], undefined,
      { read: [external], write: [] });
    assert.match(source.excerpt, /prior observation/u);
    await writeFile(external, "updated observation\n");
    assert.notEqual((await missionReviewSource(project, run, [{ path: external, offset: 1, limit: 1 }], undefined,
      { read: [external], write: [] })).fingerprint, source.fingerprint);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("review reports an unreadable external runtime directory without hiding readable results", async t => {
  if (process.platform === "win32") return t.skip("POSIX directory permissions required");
  await mkdir(resolve("_testenv"), { recursive: true });
  const area = await mkdtemp(join(resolve("_testenv"), "mission-unreadable-review-"));
  const project = join(area, "project"), runtime = join(area, "runtime"), output = join(area, "output.json");
  try {
    await mkdir(project);
    await mkdir(runtime);
    await writeFile(join(runtime, "private.txt"), "host managed\n");
    await writeFile(output, '{"resolved":7}\n');
    await chmod(runtime, 0o111);
    try { await readdir(runtime); return t.skip("directory is readable by this process"); }
    catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "EACCES"); }
    const run = { units: [{ unit: { write: [runtime + "/**", output], read: [output] }, hashes: [] }] } as never;
    const evidence = [{ path: output, offset: 1, limit: 1 }];
    const first = await missionReviewSource(project, run, evidence);
    assert.match(first.excerpt, /not inspected: permission denied/u);
    assert.match(first.excerpt, /"resolved":7/u);
    assert.match(first.excerpt, /UNINSPECTED EXTERNAL DIRECTORIES:/u);
    assert.doesNotMatch(first.excerpt, /EXCERPT TRUNCATED:/u);
    assert.equal(first.fingerprint, (await missionReviewSource(project, run, evidence)).fingerprint);
    await writeFile(output, '{"resolved":8}\n');
    assert.notEqual((await missionReviewSource(project, run, evidence)).fingerprint, first.fingerprint);
    await assert.rejects(declaredArtifacts([runtime]), /EACCES/u,
      "protected output snapshots do not silently accept an unreadable directory");
  } finally {
    await chmod(runtime, 0o700);
    await rm(area, { recursive: true, force: true });
  }
});
