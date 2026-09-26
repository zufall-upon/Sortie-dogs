import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { completedMissionReviewPrompts, missionReviewSource } from "../dist/plugin/mission-review.js";
import { MISSION_REVIEW_REFERENCE, type OperatorMission } from "../dist/core/operator-mission.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { FastLaneController } from "../dist/plugin/fast-lane.js";

const git = promisify(execFile);

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
