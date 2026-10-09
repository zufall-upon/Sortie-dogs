import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  accounting, initialState, loadProject, main, nativeCost, nextAction,
  observe, parseHandoff, readState, reserveSource, sourceCost, tick, verifyCycle, workPrompt,
} from "../scripts/autodev-runner.mjs";
import { writeAtomicJson } from "../scripts/swebench-lite-supervisor.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "autodev-test-"));
  const path = join(root, "project.json");
  await writeFile(path, JSON.stringify({ schema_version: 1, id: "test", workflow: "swebench", directory: root,
    state_root: join(root, "state"), objective: "Complete a real development task", budget: { limit_usd: 300, turn_reserve_usd: 5 } }));
  return { root, path, config: await loadProject(path) };
}

function fakeClient(config: any, failPrompt = false) {
  const calls: any[] = [];
  const data: any = { id: "", messages: [], active: {}, inbox: [], outcome: "succeeded", permissions: [], forms: [] };
  const client = {
    session: {
      create: async (input: any) => { calls.push(["create", input]); data.id = input.id; return { id: input.id }; },
      get: async () => ({ id: data.id, projectID: "project", location: { directory: config.directory }, outcome: data.outcome }),
      list: async () => ({ data: [{ id: data.id }], cursor: {} }),
      active: async () => data.active,
      inbox: { list: async () => data.inbox },
      form: { list: async () => data.forms },
      interrupt: async (input: any) => { calls.push(["interrupt", input]); },
      prompt: async (input: any) => {
        calls.push(["prompt", input]);
        if (failPrompt) throw Error("ambiguous transport failure");
        data.messages.push({ id: "user", type: "user", text: input.text, metadata: input.metadata });
        data.active[data.id] = { type: "running" };
        return { id: "inbox" };
      },
    },
    message: { list: async () => ({ data: data.messages, cursor: {} }) },
    permission: { list: async () => data.permissions },
  };
  const finish = (handoff: any) => {
    data.active = {};
    data.messages.push({ id: `assistant-${data.messages.length}`, type: "assistant", agent: "build",
      model: { providerID: "openai", id: "gpt-6.1-sol" }, time: { completed: Date.now() }, finish: "stop",
      tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      content: [{ type: "text", text: `<autodev>${JSON.stringify(handoff)}</autodev>` }] });
  };
  return { client, calls, data, finish };
}

test("two project configs retain one shared runner and the real project contracts", async () => {
  const sortie = await loadProject("scripts/autodev/sortie-dogs.json");
  const vibe = await loadProject("scripts/autodev/vibe-dev-mate.json");
  assert.equal(sortie.directory, process.cwd());
  assert.equal(sortie.budget.limit_usd, 300);
  assert.match(sortie.instructions.join("\n"), /20-minute progress checkpoint/);
  assert.match(sortie.instructions.join("\n"), /mode=complete/);
  assert.match(sortie.instructions.join("\n"), /seed-file fixture/);
  assert.match(vibe.instructions.join("\n"), /exactly one In progress/);
  assert.match(vibe.instructions.join("\n"), /Project.*projects\/12/);
  assert.equal(vibe.directory, resolve(process.cwd(), "../Vibe-Dev-Mate"));
  assert.deepEqual(vibe.required_commands, ["/home/user/.local/bin/gh"]);
  assert.match(vibe.instructions.join("\n"), /overriding only AGENTS.md's Windows gh path/);
});

test("active work, input requests, failed native turns and ambiguous admissions never get blind continuation", () => {
  const state = { ...initialState({ id: "test", directory: "/repo", workflow: "swebench" }), session_id: "ses", pending: { id: "dispatch" } };
  const base = { needs_input: false, busy: false, acknowledged: true, settled: true, text: "no handoff" };
  assert.equal(nextAction(state, { ...base, busy: true }).action, "running");
  assert.equal(nextAction(state, { ...base, needs_input: true }).action, "needs-input");
  assert.equal(nextAction(state, { ...base, acknowledged: false }).action, "blocked");
  assert.equal(nextAction(state, { ...base, settled: false }).action, "blocked");
  assert.match(nextAction(state, base).reason, /missing-structured-handoff/);
  assert.equal(nextAction({ ...state, paused: true }, base).action, "paused");
});

test("only changed concrete evidence permits continuation; a plan or changing prose does not", () => {
  const state = { session_id: "ses", pending: { id: "dispatch" }, last_progress: "same" };
  const handoff = { status: "continue", summary: "new words", next_action: "fix the actual defect", evidence: ["/repo/result.json"] };
  const observation = { settled: true, acknowledged: true, text: `<autodev>${JSON.stringify(handoff)}</autodev>` };
  assert.equal(nextAction(state, observation, { fingerprint: "same" }).action, "blocked");
  assert.equal(nextAction(state, observation, { fingerprint: null }).action, "blocked");
  assert.equal(nextAction(state, observation, { fingerprint: "changed" }).action, "dispatch");
  assert.equal(nextAction(state, observation, { fingerprint: "changed", waiting: true }).action, "waiting");
  assert.throws(() => parseHandoff('<autodev>{"status":"continue","summary":"x","evidence":["relative"]}</autodev>'), /absolute/);
});

test("native observed model usage is priced; missing usage remains explicitly unknown", () => {
  const message = { id: "one", type: "assistant", time: { completed: 1 }, model: { providerID: "openai", id: "gpt-6.1-sol" },
    tokens: { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
  assert.equal(nativeCost([message]).priced, 4);
  assert.deepEqual(nativeCost([{ ...message, id: "missing", tokens: undefined }]).unknown, ["missing"]);
});

test("first dispatch is durable and an active subsequent tick does not create or prompt again", async () => {
  const { root, config } = await fixture();
  const fake = fakeClient(config);
  try {
    assert.equal((await tick(config, { execute: true, client: fake.client })).action, "dispatched");
    const state = await readState(config);
    assert.equal(state.pending.status, "accepted");
    assert.equal(state.native_reservation_usd, 5);
    assert.equal((await tick(config, { execute: true, client: fake.client })).action, "running");
    assert.deepEqual(fake.calls.map(item => item[0]), ["create", "prompt"]);
    assert.equal((await readState(config)).session_id, state.session_id);
    assert.equal(fake.calls[0][1].permissions, undefined, "existing host permissions are not overridden");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native message pagination passes cursor alone, preserving admission and actual usage", async () => {
  const { root, config } = await fixture();
  const fake = fakeClient(config);
  try {
    await tick(config, { execute: true, client: fake.client });
    fake.finish({ status: "blocked", summary: "review complete", evidence: [] });
    const calls: any[] = [];
    fake.client.message.list = async (input: any) => {
      calls.push(input);
      if (input.cursor) {
        assert.equal(input.order, undefined);
        assert.equal(input.limit, undefined);
        return { data: [fake.data.messages[1]], cursor: {} };
      }
      return { data: [fake.data.messages[0]], cursor: { next: "native-cursor" } };
    };
    const observation = await observe(fake.client, await readState(config));
    assert.equal(observation.acknowledged, true);
    assert.equal(observation.settled, true);
    assert.equal(observation.cost.priced > 0, true);
    assert.equal(calls.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a transport error keeps the reservation and never automatically resends", async () => {
  const { root, config } = await fixture();
  const fake = fakeClient(config, true);
  try {
    await assert.rejects(tick(config, { execute: true, client: fake.client }), /ambiguous transport/);
    assert.equal((await readState(config)).pending.status, "unknown");
    assert.equal((await tick(config, { execute: true, client: fake.client })).action, "blocked");
    assert.equal(fake.calls.filter(item => item[0] === "prompt").length, 1);
    assert.equal((await accounting(await readState(config))).held_usd, 5);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("useful completion settles known usage and continues the same session once per evidence change", async () => {
  const { root, config } = await fixture();
  const fake = fakeClient(config);
  const evidence = join(root, "result.json");
  try {
    await writeFile(evidence, "actual result one");
    await tick(config, { execute: true, client: fake.client });
    fake.finish({ status: "continue", summary: "first fix verified", evidence: [evidence] });
    assert.equal((await tick(config, { execute: true, client: fake.client })).action, "dispatched");
    assert.equal(fake.calls.filter(item => item[0] === "create").length, 1);
    fake.finish({ status: "continue", summary: "same result again", evidence: [evidence] });
    const result = await tick(config, { execute: true, client: fake.client });
    assert.equal(result.action, "blocked");
    assert.match(result.reason, /no-new-work-evidence/);
    assert.equal((await readState(config)).native_reservation_usd, 0);
    assert.equal(fake.calls.filter(item => item[0] === "prompt").length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unknown usage is held once and cumulative budgets survive restarting the runner", async () => {
  const { root, config } = await fixture();
  const fake = fakeClient(config);
  try {
    await tick(config, { execute: true, client: fake.client });
    fake.finish({ status: "blocked", summary: "missing provider usage", evidence: [] });
    delete fake.data.messages.at(-1).tokens;
    await tick(config, { execute: true, client: fake.client });
    await tick(config, { execute: true, client: fake.client });
    assert.equal((await readState(config)).native_held_usd, 5);
    const source = { id: "cycle-1", kind: "supervisor", path: join(root, "supervisor.json"), reservation_usd: 46 };
    await reserveSource(config, source);
    assert.equal((await accounting(await readState(config))).exposure_usd, 51);
    assert.equal((await reserveSource(config, source)).action, "already-reserved");
    await assert.rejects(reserveSource(config, { ...source, id: "duplicate" }), /already-accounted/);
    await assert.rejects(reserveSource(config, { ...source, id: "too-much", path: join(root, "other.json"), reservation_usd: 250 }), /remaining/);
    await assert.rejects(readState({ ...config, budget: { ...config.budget, limit_usd: 600 } }), /identity-changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("running and absent cost sources keep their exposure; terminal unknown usage is not zero", () => {
  const source = { kind: "supervisor", reservation_usd: 46 };
  assert.equal(sourceCost(source, null).held, 46);
  assert.deepEqual(sourceCost(source, { status: "running", spent_usd: 10, held_unknown_usd: 0, reserved_usd: 16 }),
    { priced: 10, held: 36, unknown: 0, active: true });
  assert.deepEqual(sourceCost(source, { status: "completed", spent_usd: 10, held_unknown_usd: 2, reserved_usd: 0 }),
    { priced: 10, held: 2, unknown: 2, active: false });
  assert.equal(sourceCost({ kind: "probe", reservation_usd: 2 }, { priced_usd: 0.5, unpriced_requests: 1 }).held, 1.5);
  assert.throws(() => sourceCost(source, { status: "completed", spent_usd: null, reserved_usd: 0 }), /invalid-supervisor/);
});

test("exactly filling the budget with an admitted reservation does not interrupt active work", async () => {
  const { root, config } = await fixture();
  const fake = fakeClient(config);
  try {
    await writeAtomicJson(join(config.state_root, "state.json"), { ...initialState(config), native_priced_usd: 295 });
    assert.equal((await tick(config, { execute: true, client: fake.client })).action, "dispatched");
    const result = await tick(config, { execute: true, client: fake.client });
    assert.equal(result.action, "running");
    assert.equal(result.budget.exposure_usd, 300);
    assert.equal(result.budget.spent_or_unknown_usd, 295);
    assert.equal(fake.calls.some(item => item[0] === "interrupt"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("read-only planning does not create sessions, state or cost reservations", async () => {
  const { root, config, path } = await fixture();
  try {
    assert.equal((await tick(config)).action, "dispatch");
    assert.equal((await main(["plan", "--config", path])).budget.limit_usd, 300);
    await assert.rejects(readFile(join(config.state_root, "state.json")), /ENOENT/);
    assert.match(workPrompt(config, initialState(config), {}, { exposure_usd: 0 }), /existing host authority/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing canonical host commands report a free, deduplicated needs-host result", async () => {
  const { root, path } = await fixture();
  try {
    const config = await loadProject(path, { required_commands: [join(root, "missing-gh.exe")] });
    await writeFile(path, JSON.stringify(config));
    const args = ["tick", "--config", path, "--execute", "--quiet"];
    assert.equal((await main([...args])).action, "needs-host");
    assert.equal(await main([...args]), null);
    assert.equal((await readState(config)).session_id, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pause/resume preserves session and spend, and resume requires a new owner instruction", async () => {
  const { root, path, config } = await fixture();
  try {
    const state = { ...initialState(config), session_id: "existing", native_priced_usd: 25 };
    await writeAtomicJson(join(config.state_root, "state.json"), state);
    await main(["pause", "--config", path]);
    await assert.rejects(main(["resume", "--config", path]), /owner/);
    const instruction = join(root, "instruction.txt");
    await writeFile(instruction, "The reported blocker is now resolved; continue the same work.");
    await main(["resume", "--config", path, "--instruction", instruction]);
    const resumed = await readState(config);
    assert.equal(resumed.session_id, "existing");
    assert.equal(resumed.native_priced_usd, 25);
    assert.equal(resumed.paused, false);
    assert.match(resumed.next_instruction, /same work/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a practical response-only probe cannot verify a dev23 cycle", async () => {
  const { root } = await fixture();
  try {
    const receipt = join(root, "receipt.json");
    const file = join(root, "empty.json");
    await writeFile(file, JSON.stringify({ candidate: { sha256: "not-the-actual-package" } }));
    await writeFile(receipt, JSON.stringify({ manifest: file, supervisor: file, scoring: file,
      practical: { observation: file }, package: file, package_sha256: "not-the-actual-package" }));
    await assert.rejects(verifyCycle(receipt), /cycle-candidate-mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cycle verification binds official predictions, a real original CLI task, and Git main ancestry", async () => {
  const { root } = await fixture();
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git(["init", "-q", "-b", "main"]);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "initial"]);
    const commit = git(["rev-parse", "HEAD"]);
    git(["update-ref", "refs/remotes/origin/main", commit]);
    const packagePath = join(root, "candidate.tgz");
    await writeFile(packagePath, "candidate package bytes");
    const packageHash = digest("candidate package bytes");
    const manifestPath = join(root, "manifest.json"), supervisorPath = join(root, "supervisor.json");
    const scoringPath = join(root, "scoring.json"), practicalPath = join(root, "observation.json");
    const predictionPath = join(root, "predictions.jsonl"), taskPath = join(root, "original-task.txt"), log = join(root, "validation.log");
    const publicLock = JSON.parse(await readFile("scripts/swebench-lite-public-lock.json", "utf8"));
    const ids = Object.keys(publicLock.splits.dev.rows);
    const manifest = { dataset: { id: "princeton-nlp/SWE-bench_Lite", revision: "6ec7bb89b9342f664a54a6e0a6ea6501d3437cc2", split: "dev" },
      candidate: { sha256: packageHash, runtime_marker: "fixed-marker", version: "fixed-version" }, instances: ids.map(instance_id => ({ instance_id })) };
    const supervisor = { manifest: manifestPath, input_sha256: digest(JSON.stringify(manifest)), status: "completed",
      policy: { attempts_per_instance: 1, retry_count: 0 }, instances: ids.map(instance_id => ({ instance_id, attempt: 1 })),
      limits: { workers: 8, per_instance_usd: 2, cost_limit_usd: 46, timeout_seconds: 2400, prepared_environment: "official-image-testbed" } };
    const predictions = ids.map(instance_id => ({ instance_id, model_patch: "a frozen actual patch\n" }));
    const scoring = { status: "completed", split: "dev", max_workers: 1, retry_count: 0, supervisor_state: supervisorPath, last_harness: { exit_code: 0 },
      graded: Object.fromEntries(ids.map(id => [id, { patch_sha256: digest("a frozen actual patch\n"), result: { resolved: id === ids[0] } }])) };
    const practical = { candidate_sha256: packageHash, mode: "complete", accepted: true, mission_phase: "completed", receipt_status: "succeeded",
      code: 0, stopped: false, root: "practical-root", instance: { repo: "real/repo", base_commit: commit }, task_sha256: digest("original development task"),
      runtime_marker: "fixed-marker", package_version: "fixed-version",
      models: [{ agent: "dog-worker-v010", model: { providerID: "openai", id: "gpt-6-luna-fast", variant: "max" } }] };
    await Promise.all([writeAtomicJson(manifestPath, manifest), writeAtomicJson(supervisorPath, supervisor),
      writeAtomicJson(scoringPath, scoring), writeAtomicJson(practicalPath, practical),
      writeFile(predictionPath, predictions.map(item => JSON.stringify(item)).join("\n") + "\n"),
      writeFile(taskPath, "original development task"), writeFile(log, "canonical check passed")]);
    const runnerScripts = ["scripts/swebench-lite-runner.mjs", "scripts/swebench-lite-supervisor.mjs", "scripts/swebench-lite-grader.mjs",
      "scripts/swebench-model-cost.mjs", "scripts/release-cli.mjs"];
    for (const script of runnerScripts) await writeAtomicJson(join(root, script), { fixture: script });
    const runnerHashes = Object.fromEntries(await Promise.all(runnerScripts.map(async script =>
      [script, digest(await readFile(join(root, script), "utf8"))])));
    const receipt = { manifest: manifestPath, supervisor: supervisorPath, scoring: scoringPath, package: packagePath, package_sha256: packageHash,
      runtime_marker: "fixed-marker", runner_root: root, runner_sha256: runnerHashes,
      manifest_sha256: digest(await readFile(manifestPath, "utf8")), predictions: predictionPath, predictions_sha256: digest(await readFile(predictionPath, "utf8")),
      source_repo: root, commit, main_commit: commit, runner_commit: commit, main_integrated: true,
      practical: { observation: practicalPath, task: taskPath, repo: "real/repo", base_commit: commit,
        verification: [{ command: "canonical test", exit: 0, log, log_sha256: digest("canonical check passed") }] } };
    const receiptPath = join(root, "cycle.json");
    await writeAtomicJson(receiptPath, receipt);
    assert.equal((await verifyCycle(receiptPath)).total, 23);
    await writeAtomicJson(practicalPath, { ...practical, mode: "start" });
    await assert.rejects(verifyCycle(receiptPath), /practical-session-not-accepted/);
    await writeAtomicJson(practicalPath, { ...practical, instance: null });
    await assert.rejects(verifyCycle(receiptPath), /original-task-required/);
    await writeAtomicJson(practicalPath, practical);
    await writeFile(taskPath, "substituted seed-file task");
    await assert.rejects(verifyCycle(receiptPath), /original-task-required/);
    await writeFile(taskPath, "original development task");
    await writeAtomicJson(scoringPath, { ...scoring, max_workers: 2 });
    await assert.rejects(verifyCycle(receiptPath), /comparison-conditions/);
    await writeAtomicJson(scoringPath, scoring);
    await writeAtomicJson(practicalPath, { ...practical, models: [{ agent: "dog-worker-v010", model: { ...practical.models[0].model, providerID: "other" } }] });
    await assert.rejects(verifyCycle(receiptPath), /practical-session-not-accepted/);
    await writeAtomicJson(practicalPath, practical);
    await writeAtomicJson(receiptPath, { ...receipt, runner_commit: "not-the-actual-commit" });
    await assert.rejects(verifyCycle(receiptPath), /runner-commit/);
    await writeAtomicJson(receiptPath, receipt);
    await writeFile(predictionPath, "changed after scoring");
    await assert.rejects(verifyCycle(receiptPath), /frozen-artifacts/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
