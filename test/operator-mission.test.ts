import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { OperatorMissionRuntime, missionPacket, missionPlan, missionReviewAccepted, missionReviewTask,
  missionCommandOutcome, missionConversationContext, missionExecutionStatus, missionReviewTraces, missionReviewVerdict } from "../dist/core/operator-mission.js";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { missionCoordinatorContent, missionOperatorContent, missionWorkerContent } from "../dist/runtime-mission-assets.js";
import { terminalCancelledMissionChildren } from "../dist/plugin/profiled.js";
import { SortieDogsPlugin as CorePlugin } from "../dist/plugin/index.js";
import { RunFlightLedger } from "../dist/core/run-flight-ledger.js";
import { goalFingerprint } from "../dist/core/goal-bound.js";
import { V010_RUNTIME_ASSET_VERSION } from "../dist/asset-version.js";
import type { RuntimeBridge } from "../dist/plugin/runtime-bridge.js";

async function fixture(run: (directory: string) => Promise<void>) {
  const area = resolve("_testenv");
  await mkdir(area, { recursive: true });
  const directory = await mkdtemp(join(area, "mission-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
const unit = { title: "Fix result", objective: "Implement the requested result without changing the oracle", read: ["check.mjs"],
  write: ["src"], validation: ["node check.mjs"] };
const independentReviewAcceptance = "After implementation and formal validation, the Coordinator must dispatch an independent Dog-Reviewer with review_mission and risk_tags [public-logic] to examine root cause and public logic, then reflect all FINDINGS; this SourceReview is post-validation and must not block Worker dispatch.";

test("cwd-registered native admissions survive cold evidence recovery without retrofitting legacy external checks", async t => {
  for (const mode of ["root-cwd", "legacy-root", "external-cwd", "legacy-external"] as const) await t.test(mode, async () => fixture(async area => {
    const root = join(area, "project"), external = join(area, "external");
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(external);
    await writeFile(join(root, "verify.mjs"), "// immutable oracle\n");
    await writeFile(join(root, "result.txt"), "verified\n");
    const manifestPath = join(root, "manifest.json"), command = "node verify.mjs";
    const manifest = JSON.stringify({ version: "0.1.0", task_id: "unit", read: ["verify.mjs"], write: ["result.txt"], validation: [command] });
    await writeFile(manifestPath, manifest);
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const manifestHash = hash(manifest);
    // Preserve the pre-existing native recovery oracle and its full legacy snapshot recipe.
    const source = goalFingerprint({ manifest_hash: `sha256:${manifestHash}`, entries: [
      ["result.txt", "file", hash("verified\n")], ["verify.mjs", "file", hash("// immutable oracle\n")],
    ] });
    const candidate = goalFingerprint({ manifest_hash: `sha256:${manifestHash}`, entries: [["result.txt", "file", hash("verified\n")]] });
    const directory = mode.includes("external") ? external : root;
    const now = Date.now();
    const input: { command: string; workdir?: string } = { command, ...(directory === root ? {} : { workdir: directory }) };
    const nativeMessages = [{ info: { role: "assistant", sessionID: "child" }, parts: [{ type: "tool", tool: "bash", callID: "validate-call",
      state: { status: "completed", input, metadata: { exit: 0 }, time: { start: now, end: now + 1 } } }] }];
    let control: Parameters<NonNullable<RuntimeBridge["connected"]>>[0] | undefined;
    const hooks = await CorePlugin({ directory: root, runtimeBridge: { profile: V010_RUNTIME_PROFILE,
      assetVersion: V010_RUNTIME_ASSET_VERSION, connected: value => { control = value; },
      missionValidationDirectoryMatches: async (_root, _task, _child, _commands, actual) => actual === directory,
    }, client: { session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, parentID: path.id === "child" ? "root" : undefined,
        agent: path.id === "child" ? "dog-worker" : "dog-coordinator" } }),
      messages: async () => ({ data: nativeMessages }),
    } } } as never);
    await hooks["chat.message"]!({ sessionID: "root", messageID: "user-1", agent: "dog-coordinator", model: { providerID: "fixture", modelID: "model" } }, {
      message: { agent: "dog-coordinator", model: { providerID: "fixture", modelID: "model" } }, parts: [{ type: "text", text: "Implement the approved unit." }],
    });
    const key = hash("v010\0root");
    const ledger = await RunFlightLedger.openGoal(join(root, ".git/sortie-dogs/run-flight-v010", `${key}.json`));
    const initial = (await ledger.readGoal()).state;
    assert.ok(initial.goal_id);
    const criteria = ["identity", "permissions", "preservation"].map(id => ({ criterion_id: id, target: id, entrypoint: "fixture", workload: "shared check",
      oracle_coverage: [`oracle-${id}`], build_boundary: "not-applicable" as const, source: "source", candidate: "candidate",
      source_binding: "current-protected" as const, candidate_binding: "current-protected" as const, validation_command: command,
      fixture: "fixture", proof_scope: "requested-full" as const, expected_outcome: "pass" as const }));
    const fp = `sha256:${hash(JSON.stringify(criteria.map(criterion => criterion.target)))}`, at = new Date(now).toISOString();
    await ledger.appendGoal({ kind: "goal.revised", at, goal_id: initial.goal_id!, revision: 2, scope_epoch: 2,
      acceptance_fingerprint: fp, origin_user_message_id: "user-1", session_id: "root", selected_agent: "dog-coordinator", delivery: "mvp-first",
      budget: { max_units: 4, time_ms: null, cost_usd: null, source: "accepted-plan" }, acceptance_contract: { criteria } });
    await ledger.appendGoal({ kind: "dispatch.reserved", at, goal_id: initial.goal_id!, reservation_id: "dispatch", unit_id: "unit", session_id: "root", ticket_id: null });
    const validation = { run_id: initial.goal_id!, operation_id: "validate-call", source_snapshot: source,
      candidate: goalFingerprint({ source, candidate }), command: [command], scope: "full" as const, owner: "coordinator" as const,
      environment: { platform: process.platform, arch: process.arch, runtime: process.version, ...(mode.startsWith("legacy") ? {} : { directory }) },
      expected_evidence: [...new Set(criteria.flatMap(c => [c.criterion_id, ...c.oracle_coverage, "unit:unit", "source_snapshot", "candidate", "command", "scope", "exit_code"]))],
      marginal_value: { unmet_criteria: criteria.map(criterion => criterion.criterion_id), risk_hypothesis: null }, reason: "acceptance" as const };
    const reservation = await ledger.reserveValidation(validation, 4);
    assert.equal(reservation.decision, "ALLOW");
    await ledger.settleValidation(reservation.reservation_id!, validation, "passed", 0);
    await ledger.appendGoal({ kind: "unit.settled", at, goal_id: initial.goal_id!, reservation_id: "dispatch", receipt_id: "old",
      unit_id: "unit", disposition: "failed", result_class: "process-defect", progress_fingerprint: null, evidence: [], elapsed_ms: 1, cost_usd: null });
    const request = { unitID: "unit", childSessionID: "child", manifestPath, manifestHash, goalFingerprint: fp };
    const refuse = async () => {
      await assert.rejects(control!.recoverUnitEvidence("root", request), /unavailable-or-stale/);
      assert.deepEqual((await ledger.readGoal()).state.satisfied_criteria, []);
      assert.equal((await ledger.readGoal()).records.filter(({ event }) => event.kind === "unit.evidence-reconciled").length, 0);
    };
    if (mode === "legacy-external") { await refuse(); return; }
    input.workdir = directory === root ? external : root;
    await refuse(); // Same command and successful exit in another cwd are not this admission.
    if (directory === root) delete input.workdir;
    else input.workdir = directory;
    await writeFile(join(root, "result.txt"), "changed after validation\n");
    await refuse();
    await writeFile(join(root, "result.txt"), "verified\n");
    const evidence = await control!.recoverUnitEvidence("root", request);
    assert.equal(evidence.length, 3);
    assert.equal((await ledger.readGoal()).state.consumed_units, 1);
    assert.equal((await ledger.readGoal()).state.validation_budget.consumed, 1);
    assert.deepEqual(await control!.recoverUnitEvidence("root", request), evidence);
    assert.equal((await ledger.readGoal()).records.filter(({ event }) => event.kind === "unit.evidence-reconciled").length, 1);
  }));
});

test("public reproduction and shared-branch checks remain in the same mission Worker handoff", async t => fixture(async directory => {
  const operator = missionOperatorContent(V010_RUNTIME_PROFILE, "0.12.17");
  const coordinator = missionCoordinatorContent(V010_RUNTIME_PROFILE, "0.12.17");
  const worker = missionWorkerContent(V010_RUNTIME_PROFILE);
  assert.match(operator, /Keep the SAME mission, original requirements, failure history\s+and cumulative budget/u);
  assert.match(operator, /Coordinator Task only for real coordination/u);
  assert.match(coordinator, /do not copy them into objective/u);
  assert.match(coordinator, /working directory or package layout/u);
  assert.match(coordinator, /not an adjacent check unless it runs\s+the changed branch/u);
  assert.match(worker, /entrypoint(?:, input and layout|\/input\/layout); rerun or\s+report why unverified/u);
  assert.match(worker, /pre-change test helpers as oracles, not new implementation\/tests/u);
  assert.match(worker, /Check\s+result\/error\/state together/u);
  assert.match(worker, /without a hypothetical exhaustive matrix/u);
  assert.match(worker, /no extra tee, redirect or wrapper/u);
  assert.match(coordinator, /a preview is not the live run/u);
  assert.match(operator, /Do not turn a chosen preflight step into a user requirement/u);
  assert.match(coordinator, /Evaluating an unchanged published package is not a release or source edit/u);
  assert.match(coordinator, /Distinguish an outer benchmark attempt from the Worker dispatches/u);
  assert.match(coordinator, /process-defect with no formal validation evidence/u);
  assert.match(coordinator, /custom container tool is not\s+native shell validation/u);
  assert.match(coordinator, /use\s+the existing ref as start_ref in a lifecycle plan/u);
  assert.match(worker, /host Git lifecycle/u);
  assert.doesNotMatch(worker, /hidden evaluator details.*as (?:proof|tests)/u);

  // Public-only synthetic case analogous to a shared exception handler. This asserts the
  // objective survives the existing mission path, not that a model now solves that bug.
  const objective = "Reproduce public format_value('{') ValueError from src/project layout; repair the formatter and check the adjacent TypeError on the same exception branch using existing source/tests.";
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "public-issue", text: "format_value('{') fails in src/project layout; preserve the working formatter" });
  const mission = await missions.start("root", ["Fix the public format failure", "Preserve working formatting"]);
  const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  const run = await operators.prepareMission("root", missionPlan(mission, [{
    title: "Repair formatter", objective, read: ["src/project/format.py"], write: ["src/project/format.py", "tests/test_format.py"],
    validation: ["python -m pytest tests/test_format.py"], requirement_ids: ["R1", "R2"],
  }]));
  const task = (await operators.next("root", "root") as { task: { prompt: string } }).task;
  await operators.admitWorker("root", "root", "worker-call", task as never);
  const expanded = await operators.claimAdmittedWorkerPrompt("root", "root", "worker", task.prompt);
  assert.match(expanded.prompt, /^contract_reference: handoff$/m);
  assert.match(expanded.prompt, /^goal: handoff\.task\.objective; original: handoff\.ext\["sortie-dogs\/mission-context"\]$/m);
  assert.doesNotMatch(expanded.prompt, /Implement task\.objective; preserve the original requests/u);
  assert.ok(expanded.prompt.length <= 1500, `navigation prompt: ${expanded.prompt.length}`);
  const currentNavigation = 'goal: handoff.task.objective; original: handoff.ext["sortie-dogs/mission-context"]\n' +
    "Read the full authoritative handoff first. Host ready => implement; denied => follow its reason/remedy. No routine manifest/goal/status/bind calls; manual bind remains the legacy/recovery fallback. Do not recopy the original request.";
  const previousNavigation = "Read handoff_path once before binding. Implement task.objective; preserve the original requests, global criteria and constraints in ext, and prove this unit's assigned indices. Run verification checks exactly in order within this Task. Use supplied paths; do not reconstruct project_root. Return actual results and limitations, not whole-Mission completion.";
  t.diagnostic(JSON.stringify({ handoff_prompt_before_chars: expanded.prompt.replace(currentNavigation, previousNavigation).length,
    handoff_prompt_after_chars: expanded.prompt.length, navigation_before_chars: previousNavigation.length,
    navigation_after_chars: currentNavigation.length }));
  const handoff = JSON.parse(await readFile(run.units[0]!.handoffPath, "utf8"));
  assert.equal(handoff.task.objective, objective, "public entrypoint, layout and adjacent failure stay verbatim in the mandatory handoff");
  assert.deepEqual(handoff.verification.map((item: { check: string }) => item.check), ["python -m pytest tests/test_format.py"]);
  assert.deepEqual(run.acceptance, ["Fix the public format failure", "Preserve working formatting"]);
  assert.equal(run.units.length, 1, "no separate setup or review Worker is required");
}));

test("Mission root scope shorthand equals the explicit project directory for reads and writes only at the host boundary", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "u1", text: "Implement the requested result in this repository" });
  const mission = await missions.start("root", ["Implement result and validate"]);
  const expected = directory.replaceAll("\\", "/") + "/**";
  for (const path of [".", "./", ".\\", "./**", ".\\**"]) {
    const plan = missionPlan(mission, [{ ...unit, read: [path], write: [path] }], directory);
    assert.deepEqual(plan.units[0]!.read, [expected]); assert.deepEqual(plan.units[0]!.write, [expected]);
  }
  const readOnly = missionPlan(mission, [{ ...unit, read: ["."], write: [] }], directory);
  assert.deepEqual(readOnly.units[0]!.write, [], "read shorthand never infers write permission");
  for (const path of ["", "../", "../**", "./../outside", "./../outside/**"])
    assert.throws(() => missionPlan(mission, [{ ...unit, write: [path] }], directory), /Path must/u);
  assert.throws(() => missionPlan(mission, [{ ...unit, write: ["."] }]), /Path must/u,
    "no ambient cwd guess when no actual project root is supplied");
  const exact = missionPlan(mission, [{ ...unit, write: ["src/**"] }], directory);
  assert.deepEqual(exact.units[0]!.write, ["src/**"], "ordinary scope is not broadened");
}));

test("mission review notes are optional and cannot turn prose formatting into a coverage gate", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "u1", text: "Fix result, test it, retain scope" });
  const mission = await missions.start("root", ["Fix result", "Test it", "Retain scope"]);
  assert.deepEqual(missionReviewTraces(mission, ["R1/R2: fix and focused test", "R3: scope retained"]),
    ["R1/R2: fix and focused test", "R3: scope retained"]);
  assert.deepEqual(missionReviewTraces(mission, ["fix", "test", "scope"]), ["fix", "test", "scope"]);
  assert.deepEqual(missionReviewTraces(mission, ["R1: fix. R2/R3: tests passed; scope retained"]),
    ["R1: fix. R2/R3: tests passed; scope retained"]);
  assert.deepEqual(missionReviewTraces(mission, ["R1: fix; R2: tests passed\nR3: scope retained"]),
    ["R1: fix; R2: tests passed\nR3: scope retained"]);
  assert.deepEqual(missionReviewTraces(mission, ["R1-R3: fix, tests and scope retained"]),
    ["R1-R3: fix, tests and scope retained"]);
  assert.deepEqual(missionReviewTraces(mission, undefined), []);
  assert.deepEqual(missionReviewTraces(mission, []), []);
  assert.deepEqual(missionReviewTraces(mission, ["R1/R2: fix and test"]), ["R1/R2: fix and test"]);
  assert.deepEqual(missionReviewTraces(mission, ["R3-R1: free-form note", "R99: note"]), ["R3-R1: free-form note", "R99: note"]);
  assert.deepEqual(mission.requirements.map(item => item.text), ["Fix result", "Test it", "Retain scope"],
    "loosening note formatting does not remove original requirements");
  assert.throws(() => missionReviewTraces(mission, [123]), /optional notes must be strings/);
  mission.review = { runID: "run", risk: ["public-logic"], source: "source", verdict: "pending",
    task: { subagent_type: "dog-reviewer-v010", description: "Review", prompt: "original evidence ".repeat(1000) } };
  const task = missionReviewTask(mission);
  assert.ok(task.prompt.length < 400);
  assert.doesNotMatch(task.prompt, /original evidence/);
  mission.review.task!.prompt += "changed";
  assert.notEqual(missionReviewTask(mission).prompt, task.prompt);
}));

test("first evidence-only review permits submission while defects and pending review still block", async () => fixture(async directory => {
  assert.equal(missionReviewVerdict("PASS"), "PASS");
  assert.equal(missionReviewVerdict("EVIDENCE_GAPS\nThe multi-value route has no trace."), "evidence-gaps");
  assert.equal(missionReviewVerdict("FINDINGS\nzero dhi remains positive"), "findings");
  assert.equal(missionReviewVerdict("I think EVIDENCE_GAPS"), "findings");
  const review = { runID: "run", risk: ["public-logic"], source: "source", task: null };
  assert.equal(missionReviewAccepted({ ...review, verdict: "evidence-gaps", evidenceGapReviews: 1 }), true);
  assert.equal(missionReviewAccepted({ ...review, verdict: "evidence-gaps" }), true, "legacy records need no retry to fill a counter");
  assert.equal(missionReviewAccepted({ ...review, verdict: "findings", evidenceGapReviews: 5 }), false);
  assert.equal(missionReviewAccepted({ ...review, verdict: "pending", evidenceGapReviews: 5 }), false);
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "u1", text: "Fix result" });
  const mission = await missions.start("root", ["Fix result"]);
  const run = await operators.prepareMission("root", missionPlan(mission, [unit]));
  const gap = { ...mission, review: { ...review, runID: run.runID, verdict: "evidence-gaps" as const, evidenceGapReviews: 1 } };
  const packet = missionPacket(gap, { ...run, phase: "awaiting-acceptance" }) as { next_action: string; review: Record<string, unknown> };
  assert.deepEqual([packet.review.evidence_gap_reviews, packet.review.accepted], [1, true]);
  assert.equal(packet.review.passed, false);
  assert.equal(packet.review.permits_submission, true);
  assert.equal(packet.review.evidence_gaps_advisory, true);
  assert.match(packet.next_action, /do not repeat passed validation or review/);
}));

test("mission captures exact original messages, generates IDs, and preserves requirements across restart", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "u1", text: " Fix this.\r\nDo not change tests.  " });
  const mission = await missions.start("root", ["Fix result", "Do not change tests"]);
  await missions.capture("root", { id: "u2", text: "Also preserve the newline." });
  const cold = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const restored = await cold.required("root");
  assert.equal(restored.id, mission.id);
  assert.deepEqual(restored.requests, [{ id: "u1", text: " Fix this.\r\nDo not change tests.  " }], "chat capture alone never adopts a requirement");
  assert.deepEqual(restored.requirements.map(item => item.id), ["R1", "R2"]);
  await assert.rejects(cold.start("root", ["Only fix a smaller part"]), /requirements-preserved/);
  const extended = await cold.start("root", ["Fix result", "Do not change tests", "Preserve newline"]);
  assert.equal(extended.id, mission.id);
  assert.deepEqual(extended.requests, [{ id: "u1", text: " Fix this.\r\nDo not change tests.  " }, { id: "u2", text: "Also preserve the newline." }]);
}));

test("mission status preserves review lineage without presenting an old run as currently accepted", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "u1", text: "Fix result" });
  const mission = await missions.start("root", ["Fix result"]);
  const run = await operators.prepareMission("root", missionPlan(mission, [unit]));
  const reviewed = { ...mission, runID: run.runID, review: { runID: "old-run", risk: ["public-logic"], source: "old-source",
    task: null, verdict: "PASS" as const, child: "old-reviewer" } };
  const packet = missionPacket(reviewed, { ...run, phase: "awaiting-acceptance" }) as { review: Record<string, unknown>; next_action: string };
  assert.equal(packet.review.verdict, "PASS", "historical review is retained for verification lineage");
  assert.equal(packet.review.accepted, false);
  assert.equal(packet.review.permits_submission, false);
  assert.equal(packet.review.current_run, false);
  assert.doesNotMatch(packet.next_action, /Submit the candidate|review permits submission/i);
  assert.match(packet.next_action, /review/);
  const current = missionPacket({ ...reviewed, review: { ...reviewed.review, runID: run.runID } }, run) as typeof packet;
  assert.equal(current.review.current_run, true);
  assert.equal(current.review.permits_submission, true);
}));

test("mission Coordinator owns a single Worker unit without a proposal or root approval", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "u1", text: "Fix result" });
  const mission = await missions.start("root", ["Fix result"]);
  const task = missions.task(mission);
  await missions.admit("root", "coordinator-call", task);
  const brief = await missions.claim("root", "coordinator", task.prompt);
  assert.match(brief, /Fix result/);
  const state = await operators.prepareMission("root", missionPlan(mission, [unit]), { sessionID: "coordinator", callID: "coordinator-call" });
  const next = await operators.next("root", "coordinator") as { task: typeof task };
  await assert.rejects(operators.admitWorker("root", "root", "forged", next.task), /owner-mismatch/);
  await operators.admitWorker("root", "coordinator", "worker-call", next.task);
  await assert.rejects(operators.claimAdmittedWorkerPrompt("root", "root", "worker", next.task.prompt), /parent-mismatch/);
  const admitted = await operators.claimAdmittedWorkerPrompt("root", "coordinator", "worker", next.task.prompt);
  assert.match(admitted.prompt, /^contract_reference: handoff$/m);
  assert.match(missionWorkerContent(V010_RUNTIME_PROFILE), /Read\/search(?: use|:) existing permissions/);
  assert.equal((await operators.required("root")).runID, state.runID);
  await assert.rejects(operators.replanMission("root", state.runID, missionPlan(mission, [{ ...unit, write: ["src", "test"] }])), /still-active/);
}));

test("mission Worker separates prior decisions from post-validation independent SourceReview", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  const acceptance = ["Fix result", independentReviewAcceptance];
  const originalRequest = `Fix result. ${independentReviewAcceptance}`;
  await missions.capture("root", { id: "u1", text: originalRequest });
  const mission = await missions.start("root", acceptance);
  assert.equal(mission.requests[0]?.text, originalRequest);
  assert.deepEqual(mission.requirements.map(item => item.text), acceptance);
  const coordinatorTask = missions.task(mission);
  await missions.admit("root", "coordinator-call", coordinatorTask);
  await missions.claim("root", "coordinator", coordinatorTask.prompt);
  const plan = missionPlan(mission, [{ ...unit, requirement_ids: ["R1", "R2"] }]);
  assert.deepEqual(plan.acceptance, acceptance);
  assert.deepEqual(plan.acceptance_proof, [["unit-1"], ["unit-1"]]);
  assert.deepEqual(plan.units.map(current => current.acceptance_indices), [[0, 1]]);
  const run = await operators.prepareMission("root", plan, { sessionID: "coordinator", callID: "coordinator-call" });
  assert.deepEqual(run.acceptance, acceptance);
  assert.deepEqual(run.acceptanceProof, plan.acceptance_proof);
  assert.deepEqual(run.units.map(current => current.unit.acceptance_indices), [[0, 1]]);
  const handoff = JSON.parse(await readFile(run.units[0]!.handoffPath, "utf8"));
  assert.deepEqual(handoff.ext["sortie-dogs/acceptance-continuity"].criteria, acceptance);
  assert.deepEqual(handoff.ext["sortie-dogs/unit-coverage"].indices, [0, 1]);
  assert.equal(handoff.ext["sortie-dogs/unit-coverage"].acceptance_fingerprint, run.acceptanceFingerprint);
  const workerTask = (await operators.next("root", "coordinator") as { task: typeof coordinatorTask }).task;
  await operators.admitWorker("root", "coordinator", "worker-call", workerTask);
  const expanded = await operators.claimAdmittedWorkerPrompt("root", "coordinator", "worker", workerTask.prompt);
  assert.match(expanded.prompt, /^contract_reference: handoff$/m);
  const instructions = missionWorkerContent(V010_RUNTIME_PROFILE);
  assert.match(instructions, /Parent(?: handles|:) independent Review after return, not before execution/u);
  assert.match(instructions, /Do not spawn nested subagents/u);
  assert.doesNotMatch(expanded.prompt, /Required consultations belong to the root before dispatch/u);
  assert.doesNotMatch(expanded.prompt, /If required consultation results or user decisions are missing/u);
  assert.equal(expanded.prompt.match(/^unit_acceptance_indices: .*$/mu)?.[0], "unit_acceptance_indices: [0,1]");
}));

test("multi-unit mission retains review sequence in each referenced handoff and Worker system", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  const acceptance = ["Fix the root cause.", independentReviewAcceptance, "Preserve compatibility."];
  await missions.capture("root", { id: "u1", text: acceptance.join(" ") });
  const mission = await missions.start("root", acceptance);
  assert.deepEqual(mission.requirements.map(item => item.text), acceptance);
  const plan = missionPlan(mission, [
    { ...unit, requirement_ids: ["R1", "R2"] },
    { ...unit, title: "Preserve compatibility", objective: "Keep the established behavior", validation: ["node verify-compatibility.mjs"],
      requirement_ids: ["R3"] },
  ]);
  assert.deepEqual(plan.acceptance, acceptance);
  assert.deepEqual(plan.acceptance_proof, [["unit-1"], ["unit-1"], ["unit-2"]]);
  assert.deepEqual(plan.units.map(current => current.acceptance_indices), [[0, 1], [2]]);
  const run = await operators.prepareMission("root", plan, { sessionID: "coordinator", callID: "coordinator-call" });
  assert.equal(run.units.length, 2);
  assert.deepEqual(run.acceptance, acceptance);
  assert.deepEqual(run.acceptanceProof, plan.acceptance_proof);
  assert.deepEqual(run.units.map(current => current.unit.acceptance_indices), [[0, 1], [2]]);
  const handoffs = await Promise.all(run.units.map(async current => JSON.parse(await readFile(current.handoffPath, "utf8"))));
  for (const [index, handoff] of handoffs.entries()) {
    assert.deepEqual(handoff.ext["sortie-dogs/acceptance-continuity"].criteria, acceptance);
    assert.deepEqual(handoff.ext["sortie-dogs/unit-coverage"].indices, index === 0 ? [0, 1] : [2]);
    assert.equal(handoff.ext["sortie-dogs/unit-coverage"].acceptance_fingerprint, run.acceptanceFingerprint);
  }

  const assertMissionWorkerPrompt = (prompt: string, indices: number[]) => {
    assert.match(prompt, /^contract_reference: handoff$/m);
    assert.match(prompt, /^acceptance: handoff\.ext\["sortie-dogs\/acceptance-continuity"\]\.criteria$/m);
    const instructions = missionWorkerContent(V010_RUNTIME_PROFILE);
    assert.match(instructions, /Parent(?: handles|:) independent Review after return, not before execution/u);
    assert.match(instructions, /Do not spawn nested subagents/u);
    assert.doesNotMatch(prompt, /Required consultations belong to the root before dispatch/u);
    assert.doesNotMatch(prompt, /If required consultation results or user decisions are missing/u);
    assert.equal(prompt.match(/^unit_acceptance_indices: .*$/mu)?.[0], `unit_acceptance_indices: ${JSON.stringify(indices)}`);
  };
  for (const [index, current] of run.units.entries()) {
    assertMissionWorkerPrompt(current.task.prompt, index === 0 ? [0, 1] : [2]);
  }
  const task = (await operators.next("root", "coordinator") as { task: typeof run.units[number]["task"] }).task;
  await operators.admitWorker("root", "coordinator", "worker-call-1", task);
  const expanded = await operators.claimAdmittedWorkerPrompt("root", "coordinator", "worker-1", task.prompt);
  assertMissionWorkerPrompt(expanded.prompt, [0, 1]);
  const expandedPrompts = [expanded.prompt];
  // Worker dispatch is serial; settle unit 1 before exercising unit 2's native admission and claim route.
  await operators.settled({ rootSessionID: "root", callID: "worker-call-1", unitID: run.units[0]!.unit.id,
    childSessionID: "worker-1", disposition: "succeeded", evidence: [], resultClass: "acceptance" });
  const secondTask = (await operators.next("root", "coordinator") as { task: typeof run.units[number]["task"] }).task;
  await operators.admitWorker("root", "coordinator", "worker-call-2", secondTask);
  const secondExpanded = await operators.claimAdmittedWorkerPrompt("root", "coordinator", "worker-2", secondTask.prompt);
  expandedPrompts.push(secondExpanded.prompt);
  assert.equal(expandedPrompts.length, run.units.length);
  assertMissionWorkerPrompt(expandedPrompts[1]!, [2]);
  assert.match(missionWorkerContent(V010_RUNTIME_PROFILE), /Review after return, not before execution/u);
  assert.equal(expanded.prompt.match(/^unit_acceptance_indices: .*$/mu)?.[0], "unit_acceptance_indices: [0,1]");
}));

test("legacy OperatorRuntime.prepare preserves the prior consultation contract", async () => fixture(async directory => {
  const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  const input = {
    schema_version: "0.1",
    acceptance: ["Preserve the legacy consultation contract"],
    acceptance_proof: [["legacy-contract"]],
    source_refs: ["fixture:legacy-request"],
    goal_declaration: {
      delivery_intent: "implementation", delivery_mode: "mvp-first", usable_path_established: false, controlled_change: false,
      defaults: { target: "legacy consultation behavior", entrypoint: "check.mjs", workload: "legacy-contract",
        oracle_coverage: ["declared legacy behavior"], build_boundary: "not-applicable", source: "source", candidate: "candidate",
        fixture: "legacy-contract", source_binding: "current-protected", candidate_binding: "current-protected",
        proof_scope: "requested-full", expected_outcome: "pass" },
      criteria: [{ criterion_id: "legacy-contract", target: "Legacy consultation contract", entrypoint: "check.mjs",
        validation_command: "node check.mjs" }],
    },
    units: [{ id: "legacy-unit", title: "Preserve legacy consultation contract", objective: "Keep prior consultation wording",
      read: ["check.mjs"], write: ["src"], validation: ["node check.mjs"], acceptance_indices: [0] }],
  };
  const run = await operators.prepare("legacy-root", input);
  assert.deepEqual(run.acceptance, input.acceptance);
  assert.deepEqual(run.units.map(current => current.unit.acceptance_indices), [[0]]);
  const prompt = run.units[0]!.task.prompt;
  assert.match(prompt, /Required consultations belong to the root before dispatch/u);
  assert.match(prompt, /If required consultation results or user decisions are missing/u);
}));

test("mission rejects foreign Coordinator claims and duplicate dispatches", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "u1", text: "Fix result" });
  const mission = await missions.start("root", ["Fix result"]);
  const task = missions.task(mission);
  await assert.rejects(missions.claim("root", "child", task.prompt), /claim-invalid/);
  await missions.admit("root", "call", task);
  await assert.rejects(missions.admit("root", "another-call", task), /not-authorized/);
  await missions.claim("root", "child", task.prompt);
  await assert.rejects(missions.claim("root", "foreign-child", task.prompt), /claim-invalid/);
}));

test("mission admits a paraphrased Coordinator label while keeping the opaque request reference", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "u1", text: "Fix the result; preserve the validation command" });
  const mission = await missions.start("root", ["Fix the result", "Preserve the validation command"]);
  const task = missions.task(mission);
  await assert.rejects(missions.admit("root", "wrong-ref", { ...task, prompt: "other request" }), /not-authorized/u);
  await missions.admit("root", "actual-call", { ...task, description: "Repair and validate the result" });
  const brief = await missions.claim("root", "coordinator", task.prompt);
  assert.match(brief, /Fix the result; preserve the validation command/u);
  assert.match(brief, /R2: Preserve the validation command/u);
}));

test("cold mission reopens only the terminal native dispatch and retains its Coordinator", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "u1", text: "Fix result" });
  const started = await missions.start("root", ["Fix result"]);
  await missions.admit("root", "first-call", missions.task(started));
  await missions.claim("root", "coordinator", missions.task(started).prompt);
  const cold = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  await assert.rejects(cold.admit("root", "second-call", cold.task(await cold.required("root"))), /not-authorized/u);
  await assert.rejects(cold.reconcileFinishedDispatch("root", started.id, "wrong-call"), /reconciliation-stale/u);
  const resumed = await cold.reconcileFinishedDispatch("root", started.id, "first-call");
  assert.equal(resumed.coordinator, "coordinator");
  assert.equal(resumed.dispatchOpen, false);
  await assert.rejects(cold.reconcileFinishedDispatch("root", started.id, "first-call"), /reconciliation-stale/u);
  const task = cold.task(resumed);
  assert.equal(task.task_id, "coordinator");
  await cold.admit("root", "second-call", task);
  assert.equal((await cold.required("root")).dispatchOpen, true);
}));

test("generated proof retains negative constraints and rejects dropped requirements or control writes", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "u1", text: "Fix result; do not change tests" });
  const mission = await missions.start("root", ["Fix result", "Do not change tests"]);
  const inferred = missionPlan(mission, [unit]);
  assert.deepEqual(inferred.acceptance, ["Fix result", "Do not change tests"]);
  assert.deepEqual(inferred.units[0]!.acceptance_indices, [0, 1]);
  const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  const run = await operators.prepareMission("root", inferred);
  const handoff = JSON.parse(await readFile(run.units[0]!.handoffPath, "utf8"));
  assert.deepEqual(handoff.ext["sortie-dogs/acceptance-continuity"].criteria, inferred.acceptance);
  assert.deepEqual(handoff.ext["sortie-dogs/unit-coverage"].indices, [0, 1]);
  assert.equal(run.phase, "prepared", "scheduling all requirements is not completion evidence");
  assert.throws(() => missionPlan(mission, [unit, { ...unit, validation: ["node other.mjs"] }]), /splitting multiple requirements/);
  const related = { ...unit, requirement_ids: ["R1", "R2"] };
  const plan = missionPlan(mission, [related]);
  assert.deepEqual(plan.acceptance, ["Fix result", "Do not change tests"]);
  assert.deepEqual(plan.units[0]!.acceptance_indices, [0, 1]);
  assert.throws(() => missionPlan(mission, [{ ...unit, requirement_ids: ["R1"] }]), /mission-uncovered: R2/);
  assert.throws(() => missionPlan(mission, [{ ...related, write: [".git"] }]), /control-write-forbidden/);
  assert.throws(() => missionPlan(mission, [{ ...unit, write: ["../escape"] }]));
}));

test("mission validation preserves repeated required occurrences and the final proof command", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "u1", text: "Fix and verify the result" });
  const mission = await missions.start("root", ["Fix the result", "Verify behavior"]);
  const plan = missionPlan(mission, [{ ...unit, validation: ["node check.mjs", "node adjacent.mjs", "node check.mjs"] }]);
  const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  const run = await operators.prepareMission("root", plan);
  const manifest = JSON.parse(await readFile(run.units[0]!.manifestPath, "utf8"));
  assert.deepEqual(manifest.validation, ["node check.mjs", "node adjacent.mjs", "node check.mjs"]);
  assert.equal((plan.goal_declaration.criteria as { validation_command: string }[])[0]!.validation_command, "node check.mjs");
  assert.deepEqual(plan.acceptance, ["Fix the result", "Verify behavior"]);
  const merged = missionPlan(mission, [
    { ...unit, requirement_ids: ["R1"], validation: ["node adjacent.mjs", "node check.mjs"] },
    { ...unit, requirement_ids: ["R2"], validation: ["node adjacent.mjs", "node check.mjs"] },
  ]);
  assert.equal(merged.units.length, 1, "coalescing a proof milestone does not create another execution unit");
  assert.deepEqual(merged.units[0]!.validation, ["node adjacent.mjs", "node check.mjs", "node adjacent.mjs", "node check.mjs"],
    "coalescing preserves each original ordered validation occurrence too");
}));

test("mission replan archives failed execution, keeps original acceptance and binds a fresh bounded scope", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "u1", text: "Fix result" });
  const mission = await missions.start("root", ["Fix result"]);
  const state = await operators.prepareMission("root", missionPlan(mission, [unit]));
  const file = join(directory, ".sortie-dogs-v010", "operators", `${createHash("sha256").update("root").digest("hex")}.json`);
  // A crash can leave the pre-switch checkpoint, after which the prior run is still allowed to advance.
  const interruptedCheckpoint = `${file}.${state.runID}.${state.sequence}.archive`;
  await writeFile(interruptedCheckpoint, JSON.stringify(state));
  const task = operators.nextWorkerTask(state);
  await operators.admitWorker("root", "root", "call", task);
  await operators.claimAdmittedWorkerPrompt("root", "root", "worker", task.prompt);
  await operators.settled({ rootSessionID: "root", callID: "call", childSessionID: "worker", unitID: "unit-1",
    disposition: "failed", resultClass: "process-defect", evidence: [], failure: { command: ["node", "check.mjs"], outcome: "fail", exitCode: 1 } });
  const failed = await readFile(file, "utf8");
  const replacement = await operators.replanMission("root", state.runID, missionPlan(mission, [{ ...unit, write: ["src", "test"] }]));
  assert.equal(replacement.parentRunID, state.runID);
  assert.deepEqual(replacement.acceptance, state.acceptance);
  assert.notEqual(replacement.runID, state.runID);
  const manifest = JSON.parse(await readFile(replacement.units[0]!.manifestPath, "utf8"));
  assert.deepEqual(manifest.write, ["src", "test"]);
  assert.equal(await readFile(interruptedCheckpoint, "utf8"), JSON.stringify(state));
  assert.equal(await readFile(`${file}.${state.runID}.${JSON.parse(failed).sequence}.archive`, "utf8"), failed);
}));

test("concurrent mission replans switch only the expected predecessor and retain acceptance", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "u1", text: "Fix result" });
  const mission = await missions.start("root", ["Fix result"]);
  const first = await operators.prepareMission("root", missionPlan(mission, [unit]));
  await assert.rejects(operators.replanMission("root", first.runID, missionPlan({ ...mission,
    requirements: [{ id: "R1", text: "Different goal" }] }, [unit])), /acceptance-carry-forward/);
  assert.deepEqual(await operators.required("root"), first);
  const results = await Promise.allSettled(["src/a", "src/b"].map(path => operators.replanMission("root", first.runID,
    missionPlan(mission, [{ ...unit, write: [path] }]))));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
  assert.match(rejected.reason.message, /mission-replan-run-mismatch/);
  const current = await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root");
  assert.equal(current.parentRunID, first.runID);
  assert.deepEqual(current.acceptance, first.acceptance);
  assert.ok(operators.nextWorkerTask(current));
}));

test("a later user turn can replace a cancelled mission without inheriting its old acceptance", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "u1", text: "Run v0.12.3" });
  const oldMission = await missions.start("root", ["Run v0.12.3", "Keep cumulative budget"]);
  const oldRun = await operators.prepareMission("root", missionPlan(oldMission, [{ ...unit, requirement_ids: ["R1", "R2"] }]));
  await operators.interrupted("root", "explicit-cancellation");
  await missions.update("root", state => { state.phase = "cancelled"; state.runID = oldRun.runID; });

  // A cancellation in the original user turn is not permission to discard that turn's acceptance.
  const sameTurn = await missions.start("root", ["Run v0.12.4", "Keep cumulative budget"]);
  assert.equal(sameTurn.supersededRunID, undefined);
  await assert.rejects(operators.prepareMission("root", missionPlan(sameTurn, [{ ...unit, requirement_ids: ["R1", "R2"] }])),
    /operator-acceptance-carry-forward-required/);
  await missions.capture("root", { id: "u2", text: "Use v0.12.4 and start a new mission" });
  await missions.start("root", sameTurn.requirements.map(item => item.text));
  await missions.update("root", state => { state.phase = "cancelled"; state.runID = oldRun.runID; });
  const replacement = await missions.start("root", ["Run v0.12.4", "Keep cumulative budget"]);
  assert.equal(replacement.supersededRunID, oldRun.runID);
  const missionFile = join(directory, ".sortie-dogs-v010", "missions", `${createHash("sha256").update("root").digest("hex")}.json`);
  // The already-blocked desktop mission was persisted by the older release without this link.
  await writeFile(missionFile, JSON.stringify({ ...replacement, supersededRunID: undefined }));
  const cold = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  assert.equal((await cold.required("root")).supersededRunID, oldRun.runID);
  assert.equal((await cold.start("root", replacement.requirements.map(item => item.text))).supersededRunID, oldRun.runID);
  const plan = missionPlan(replacement, [{ ...unit, requirement_ids: ["R1", "R2"] }]);
  await assert.rejects(operators.prepareMission("root", plan, undefined, "operator-stale"), /mission-superseded-run-mismatch/);
  const next = await operators.prepareMission("root", plan, undefined, replacement.supersededRunID);
  assert.deepEqual(next.acceptance, ["Run v0.12.4", "Keep cumulative budget"]);
  assert.equal(next.parentRunID, null);
  assert.deepEqual(next.priorAcceptedUnits, []);
  assert.equal(next.supersededRunID, oldRun.runID);
  assert.notEqual(next.runID, oldRun.runID);
  assert.equal((await operators.prepareMission("root", plan, undefined, replacement.supersededRunID)).runID, next.runID);
  const archive = JSON.parse(await readFile(join(directory, ".sortie-dogs-v010", "operators",
    `${createHash("sha256").update("root").digest("hex")}.json.${oldRun.runID}.archive`), "utf8"));
  assert.equal(archive.runID, oldRun.runID);
  assert.equal(archive.phase, "cancelled");
  assert.deepEqual(archive.acceptance, ["Run v0.12.3", "Keep cumulative budget"]);
}));

test("explicit same-turn narrowing replaces the latest cancelled run, not an older ancestor", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "old-request", text: "Run all 30 tasks" });
  const original = await missions.start("root", ["Run all 30 tasks"]);
  const oldRun = await operators.prepareMission("root", missionPlan(original, [unit]));
  await operators.interrupted("root", "explicit-cancellation");
  await missions.update("root", state => { state.phase = "cancelled"; state.runID = oldRun.runID; });

  await missions.capture("root", { id: "current-request", text: "Run v0.12.23 once, then decide" });
  const campaign = await missions.start("root", ["Run v0.12.23 once"], true);
  assert.equal(campaign.supersededRunID, oldRun.runID);
  const campaignRun = await operators.prepareMission("root", missionPlan(campaign, [unit]), undefined, campaign.supersededRunID);
  const task = operators.nextWorkerTask(campaignRun);
  await operators.admitWorker("root", "root", "call", task);
  await operators.claimAdmittedWorkerPrompt("root", "root", "worker", task.prompt);
  await operators.settled({ rootSessionID: "root", callID: "call", childSessionID: "worker", unitID: "unit-1",
    disposition: "failed", resultClass: "process-defect", evidence: [],
    failure: { command: ["node", "check.mjs"], outcome: "fail", exitCode: 1 } });
  await operators.interrupted("root", "explicit-cancellation");
  await missions.update("root", state => { state.phase = "cancelled"; state.runID = campaignRun.runID; });

  // The scope decision arrived as a question answer in the same user turn: no new message ID.
  const single = await missions.start("root", ["Run only Anko once"], true);
  assert.equal(single.supersededRunID, campaignRun.runID);
  assert.notEqual(single.supersededRunID, oldRun.runID);
  const next = await operators.prepareMission("root", missionPlan(single, [unit]), undefined,
    single.supersededRunID, ["worker"], true);
  assert.deepEqual(next.acceptance, ["Run only Anko once"]);
  assert.equal(next.supersededRunID, campaignRun.runID);
  assert.deepEqual(next.priorAcceptedUnits, []);
}));

test("cancelled no-run successor preserves the old run's supersession across another user turn and cold reload", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "old-request", text: "Assess the old package" });
  const old = await missions.start("root", ["Old package", "Old verification"]);
  const oldTask = missions.task(old);
  await missions.admit("root", "old-call", oldTask);
  await missions.claim("root", "old-coordinator", oldTask.prompt);
  const run = await operators.prepareMission("root", missionPlan(old, [{ ...unit, requirement_ids: ["R1", "R2"] }]),
    { sessionID: "old-coordinator", callID: "old-call" });
  await operators.interrupted("root", "explicit-cancellation");
  await missions.update("root", state => { state.phase = "cancelled"; state.runID = run.runID; });

  await missions.capture("root", { id: "new-request", text: "Study the new package" });
  const intermediate = await missions.start("root", ["New package"]);
  assert.equal(intermediate.supersededRunID, run.runID);
  await missions.capture("root", { id: "latest-request", text: "Continue with five failed instances" });
  await missions.start("root", intermediate.requirements.map(item => item.text));
  await missions.update("root", state => { state.phase = "cancelled"; });
  const current = await missions.start("root", ["Inspect the five failed instances"]);
  assert.equal(current.supersededRunID, run.runID);

  // Already-stuck missions from the old plugin have no persisted predecessor link.
  const file = join(directory, ".sortie-dogs-v010", "missions", `${createHash("sha256").update("root").digest("hex")}.json`);
  await writeFile(file, JSON.stringify({ ...current, supersededRunID: undefined }));
  const recovered = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
  assert.equal(recovered.supersededRunID, run.runID);
  // Another user turn may cancel the blocked mission before the corrected plugin is installed.
  await writeFile(file, JSON.stringify({ ...current, phase: "cancelled", supersededRunID: undefined }));
  const cold = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  assert.equal((await cold.required("root")).supersededRunID, run.runID);
  const resumed = await cold.start("root", ["Inspect the five failed instances"]);
  assert.equal(resumed.supersededRunID, run.runID);
  const replacement = await operators.prepareMission("root", missionPlan(resumed, [unit]), undefined, resumed.supersededRunID);
  assert.deepEqual(replacement.acceptance, ["Inspect the five failed instances"]);
  assert.equal(replacement.parentRunID, null);
  assert.equal(replacement.supersededRunID, run.runID);
}));

test("explicit replacement prefers the current cancelled run over a stale no-run ancestor", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "old-request", text: "Run the earlier version" });
  const old = await missions.start("root", ["Run the earlier version"]);
  const ancestor = await operators.prepareMission("root", missionPlan(old, [unit]));
  await operators.interrupted("root", "explicit-cancellation");
  await missions.update("root", state => { state.phase = "cancelled"; state.runID = ancestor.runID; });

  await missions.capture("root", { id: "middle-request", text: "Run the next version" });
  const middle = await missions.start("root", ["Run the next version"], true, { cancelledRunID: ancestor.runID });
  const latest = await operators.prepareMission("root", missionPlan(middle, [unit]), undefined, middle.supersededRunID, [], true);
  await operators.interrupted("root", "explicit-cancellation");
  await missions.update("root", state => { state.phase = "cancelled"; state.runID = latest.runID; });

  await missions.capture("root", { id: "current-request", text: "Run the newest version once" });
  const blocked = await missions.start("root", ["Run the newest version once"], true, { cancelledRunID: latest.runID });
  assert.equal(blocked.supersededRunID, latest.runID);
  // A pre-fix mission was stopped before plan_units and retained the ancestor instead of the latest run.
  await missions.update("root", state => { state.phase = "cancelled"; state.supersededRunID = ancestor.runID; });
  const current = await missions.start("root", ["Run the newest version once"], true, { cancelledRunID: latest.runID });
  assert.equal(current.supersededRunID, latest.runID);
  const prepared = await operators.prepareMission("root", missionPlan(current, [unit]), undefined, current.supersededRunID, [], true);
  assert.equal(prepared.supersededRunID, latest.runID);
  assert.deepEqual(prepared.acceptance, ["Run the newest version once"]);
}));

test("same-turn mission retains a cancelled run's exact acceptance before its Coordinator declares units", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "u1", text: "Continue MK2-04 under the old acceptance" });
  const first = await missions.start("root", ["Keep the old validation boundary", "Do not use the user's Go toolchain"]);
  const old = await operators.prepareMission("root", missionPlan(first, [{ ...unit, requirement_ids: ["R1", "R2"] }]),
    { sessionID: "old-coordinator", callID: "old-call" });
  await operators.interrupted("root", "explicit-cancellation");
  await missions.update("root", state => { state.phase = "cancelled"; state.runID = old.runID; });
  const next = await missions.start("root", ["Continue MK2-04"]);
  assert.equal(next.supersededRunID, undefined);
  await assert.rejects(operators.prepareMission("root", missionPlan(next, [unit])), /operator-acceptance-carry-forward-required/);
  const retained = await missions.carryForward("root", next.id, old.acceptance);
  assert.deepEqual(retained.requirements.map(item => item.text),
    ["Keep the old validation boundary", "Do not use the user's Go toolchain", "Continue MK2-04"]);
  const task = missions.task(retained);
  await missions.admit("root", "new-call", task);
  await missions.claim("root", "new-coordinator", task.prompt);
  const cold = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const recovered = await cold.carryForward("root", next.id, old.acceptance);
  assert.deepEqual(recovered.requirements, retained.requirements);
  const prepared = await operators.prepareMission("root", missionPlan(recovered, [{ ...unit, requirement_ids: ["R1", "R2", "R3"] }]),
    { sessionID: "new-coordinator", callID: "new-call" });
  assert.equal(prepared.operatorSessionID, "new-coordinator");
  assert.equal(prepared.parentRunID, old.runID);
  assert.deepEqual(prepared.acceptance, retained.requirements.map(item => item.text));
  assert.ok(operators.nextWorkerTask(prepared));
}));

test("a same-turn replacement cannot bypass terminal proof of a cancelled Worker", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "u1", text: "Continue the old request" });
  const oldMission = await missions.start("root", ["Keep old acceptance"]);
  const old = await operators.prepareMission("root", missionPlan(oldMission, [unit]),
    { sessionID: "old-coordinator", callID: "old-call" });
  const task = operators.nextWorkerTask(old);
  await operators.admitWorker("root", "old-coordinator", "worker-call", task);
  await operators.claimAdmittedWorkerPrompt("root", "old-coordinator", "old-worker", task.prompt);
  await operators.interrupted("root", "explicit-cancellation");
  await missions.update("root", state => { state.phase = "cancelled"; state.runID = old.runID; });
  const next = await missions.start("root", ["Keep old acceptance", "Continue the old request"]);
  const plan = missionPlan(next, [{ ...unit, requirement_ids: ["R1", "R2"] }]);
  await assert.rejects(operators.prepareMission("root", plan, { sessionID: "new-coordinator", callID: "new-call" }),
    /mission-cancelled-run-worker-not-terminal/);
  assert.equal((await operators.required("root")).runID, old.runID);
  const resumed = await operators.prepareMission("root", plan, { sessionID: "new-coordinator", callID: "new-call" },
    undefined, ["old-worker"]);
  assert.equal(resumed.parentRunID, old.runID);
}));

test("a new mission cannot discard an old run that reached a worker", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "u1", text: "Old goal" });
  const oldMission = await missions.start("root", ["Old goal"]);
  const oldRun = await operators.prepareMission("root", missionPlan(oldMission, [unit]));
  const task = operators.nextWorkerTask(oldRun);
  await operators.admitWorker("root", "root", "worker-call", task);
  await operators.claimAdmittedWorkerPrompt("root", "root", "worker", task.prompt);
  await missions.capture("root", { id: "u2", text: "Replace old goal" });
  await operators.interrupted("root", "explicit-cancellation");
  await missions.update("root", state => { state.phase = "cancelled"; state.runID = oldRun.runID; });
  const newMission = await missions.start("root", ["New goal"]);
  assert.equal(newMission.supersededRunID, oldRun.runID);
  await assert.rejects(operators.prepareMission("root", missionPlan(newMission, [unit]), undefined, newMission.supersededRunID),
    /mission-superseded-run-has-work/);
  assert.equal((await operators.required("root")).runID, oldRun.runID);
}));

test("a later mission replaces a cancelled worker and pending unit only after host terminal proof", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "old-user", text: "Run the old candidate" });
  const oldMission = await missions.start("root", ["Run the old candidate"]);
  const oldRun = await operators.prepareMission("root", missionPlan(oldMission, [unit,
    { ...unit, title: "Later", validation: ["node later.mjs"] }]), { sessionID: "coordinator", callID: "mission-call" });
  const task = operators.nextWorkerTask(oldRun);
  await operators.admitWorker("root", "coordinator", "old-call", task);
  await operators.claimAdmittedWorkerPrompt("root", "coordinator", "old-worker", task.prompt);
  await operators.interrupted("root", "explicit-cancellation");
  const cancelled = await operators.required("root");
  const sessions = new Map([
    ["coordinator", { id: "coordinator", agent: "dogs-coordinator", parentID: "root", outcome: "interrupted" }],
    ["old-worker", { id: "old-worker", agent: "dog-worker-v010", parentID: "coordinator", outcome: "interrupted" }],
  ]);
  const host = { get: async (id: string) => sessions.get(id),
    children: async (id: string) => id === "coordinator" ? [{ id: "old-worker" }] : [] };
  await assert.rejects(terminalCancelledMissionChildren(V010_RUNTIME_PROFILE, "root", cancelled,
    { reserved_units: 1 }, host), /reservations-pending/);
  sessions.set("old-worker", { id: "old-worker", agent: "dog-worker-v010", parentID: "coordinator", outcome: "running" });
  await assert.rejects(terminalCancelledMissionChildren(V010_RUNTIME_PROFILE, "root", cancelled,
    { reserved_units: 0 }, host), /worker-not-terminal/);
  sessions.set("old-worker", { id: "old-worker", agent: "dog-worker-v010", parentID: "coordinator", outcome: "interrupted" });
  const proof = await terminalCancelledMissionChildren(V010_RUNTIME_PROFILE, "root", cancelled, { reserved_units: 0 }, host);
  assert.deepEqual(proof, ["old-worker"]);
  await missions.update("root", state => { state.phase = "cancelled"; state.runID = oldRun.runID; });
  await missions.capture("root", { id: "new-user", text: "Run the new candidate" });
  const nextMission = await missions.start("root", ["Run the new candidate"]);
  const plan = missionPlan(nextMission, [unit]);
  await assert.rejects(operators.prepareMission("root", plan, undefined, oldRun.runID), /mission-superseded-run-has-work/);
  await assert.rejects(operators.prepareMission("root", plan, undefined, oldRun.runID, ["other-worker"]), /mission-superseded-run-has-work/);
  const next = await operators.prepareMission("root", plan, undefined, oldRun.runID, proof);
  assert.deepEqual(next.acceptance, ["Run the new candidate"]);
  assert.deepEqual(next.priorAcceptedUnits, []);
  assert.equal(next.parentRunID, null);
  assert.equal(next.supersededRunID, oldRun.runID);
  const archived = JSON.parse(await readFile(join(directory, ".sortie-dogs-v010", "operators",
    `${createHash("sha256").update("root").digest("hex")}.json.${oldRun.runID}.archive`), "utf8"));
  assert.equal(archived.units[0].childSessionID, "old-worker");
  assert.equal(archived.units[1].status, "pending");
}));

test("an explicit changed-version mission replaces a cancelled failed acceptance without laundering its work", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "old-user", text: "Run Anko with v0.12.20" });
  const oldMission = await missions.start("root", ["Run Anko with v0.12.20", "Do not score"]);
  const old = await operators.prepareMission("root", missionPlan(oldMission, [unit]),
    { sessionID: "old-coordinator", callID: "old-mission-call" });
  const task = operators.nextWorkerTask(old);
  await operators.admitWorker("root", "old-coordinator", "old-worker-call", task);
  await operators.claimAdmittedWorkerPrompt("root", "old-coordinator", "old-worker", task.prompt);
  await operators.settled({ rootSessionID: "root", callID: "old-worker-call", childSessionID: "old-worker",
    unitID: `${old.runID}-1`, disposition: "failed", resultClass: "acceptance", evidence: [],
    failure: { command: ["node check.mjs"], outcome: "fail", exitCode: 1 } });
  await operators.interrupted("root", "explicit-cancellation");
  const cancelled = await operators.required("root");
  assert.equal(cancelled.decision, "operator-acceptance-remediation-required");
  assert.equal(cancelled.gitLifecycle, null);
  await missions.update("root", state => { state.phase = "cancelled"; state.runID = old.runID; });
  await missions.capture("root", { id: "new-user", text: "Run Anko with v0.12.21 instead" });
  const nextMission = await missions.start("root", ["Run Anko with v0.12.21", "Do not score"], true);
  assert.equal(nextMission.supersededRunID, old.runID);
  assert.equal(nextMission.requirementsReplaced, true);
  const plan = missionPlan(nextMission, [unit]);
  await assert.rejects(operators.prepareMission("root", plan,
    { sessionID: "new-coordinator", callID: "new-mission-call" }, old.runID, [], true), /mission-superseded-run-has-work/);
  await assert.rejects(operators.prepareMission("root", plan,
    { sessionID: "new-coordinator", callID: "new-mission-call" }, old.runID, ["old-worker"], false), /mission-superseded-run-has-work/);
  const replacement = await operators.prepareMission("root", plan,
    { sessionID: "new-coordinator", callID: "new-mission-call" }, old.runID, ["old-worker"], true);
  assert.notEqual(replacement.runID, old.runID);
  assert.deepEqual(replacement.acceptance, ["Run Anko with v0.12.21", "Do not score"]);
  assert.deepEqual(replacement.priorAcceptedUnits, [], "failed work is not accepted into the replacement");
  assert.equal(replacement.parentRunID, null);
  assert.equal(replacement.supersededRunID, old.runID);
  const archived = JSON.parse(await readFile(join(directory, ".sortie-dogs-v010", "operators",
    `${createHash("sha256").update("root").digest("hex")}.json.${old.runID}.archive`), "utf8"));
  assert.equal(archived.units[0].status, "failed");
  assert.equal(archived.units[0].resultClass, "acceptance");
  assert.deepEqual(archived.units[0].evidence, []);
}));

function terminalHistory() {
  const previous = { operatorSessionID: "coordinator", units: [{ childSessionID: "worker" }] } as never;
  const sessions: Record<string, { id: string; agent: string; parentID: string; outcome?: string }> = {
    coordinator: { id: "coordinator", agent: "dogs-coordinator", parentID: "root", outcome: "succeeded" },
    worker: { id: "worker", agent: "dog-worker-v010", parentID: "coordinator", outcome: "succeeded" },
    prior: { id: "prior", agent: "dog-worker-v010", parentID: "coordinator", outcome: "failed" },
    reviewer: { id: "reviewer", agent: "dog-reviewer-v010", parentID: "coordinator", outcome: "succeeded" },
    scout: { id: "scout", agent: "dog-scout-v010", parentID: "coordinator", outcome: "interrupted" },
  };
  const children: Record<string, { id: string }[]> = { coordinator: ["worker", "prior", "reviewer", "scout"].map(id => ({ id })) };
  return { previous, sessions, children, host: { get: async (id: string) => sessions[id], children: async (id: string) => children[id] ?? [] } };
}

test("terminal mission proof accepts completed workers and settled prior consultations", async () => {
  const f = terminalHistory();
  assert.deepEqual(await terminalCancelledMissionChildren(V010_RUNTIME_PROFILE, "root", f.previous, { reserved_units: 0 }, f.host), ["worker"]);
});

test("cancelled child proof is separate from native outcomes and still requires exact lineage and released reservations", async () => {
  const f = terminalHistory();
  delete f.sessions.prior!.outcome;
  const host = { ...f.host, stopped: async (id: string) => id === "prior" };
  assert.deepEqual(await terminalCancelledMissionChildren(V010_RUNTIME_PROFILE, "root", f.previous, { reserved_units: 0 }, host), ["worker"]);
  assert.equal(f.sessions.prior!.outcome, undefined);
  f.sessions.prior!.outcome = "running";
  await assert.rejects(terminalCancelledMissionChildren(V010_RUNTIME_PROFILE, "root", f.previous, { reserved_units: 0 }, host), /worker-not-terminal/);
  delete f.sessions.prior!.outcome;
  f.sessions.prior!.parentID = "foreign";
  await assert.rejects(terminalCancelledMissionChildren(V010_RUNTIME_PROFILE, "root", f.previous, { reserved_units: 0 }, host), /worker-not-terminal/);
  await assert.rejects(terminalCancelledMissionChildren(V010_RUNTIME_PROFILE, "root", f.previous, { reserved_units: 1 }, host), /reservations-pending/);
});

test("short follow-up inherits recent selected target without tool logs or new requirements", async () => fixture(async directory => {
  const context = missionConversationContext([
    { info: { id: "older", role: "user" }, parts: [{ type: "text", text: "obsolete v0.12.7" }] },
    { info: { id: "apply", role: "user" }, parts: [{ type: "text", text: "Apply v0.12.15" }] },
    { info: { id: "applied", role: "assistant" }, parts: [{ type: "text", text: "Applied v0.12.15, local.tgz SHA-256 pinned" }, { type: "reasoning", text: "private" }, { type: "tool", text: "raw log" }] },
    { info: { id: "run", role: "user" }, parts: [{ type: "text", text: "Run the benchmark once" }] },
  ]);
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "run", text: "Run the benchmark once" });
  const mission = await missions.start("root", ["Run benchmark once"], false, { kind: "operation", context });
  const brief = missions.brief(mission);
  assert.match(brief, /Applied v0.12.15, local.tgz/);
  assert.doesNotMatch(brief, /obsolete|private|raw log/);
  assert.deepEqual(mission.requirements.map(item => item.text), ["Run benchmark once"]);
  assert.equal(missionExecutionStatus(mission), "not-started");
  assert.equal(missionCommandOutcome('{"status":"NO_START","attempts":0}', 0, "completed").outcome, "not-started");
  assert.deepEqual(missionCommandOutcome('{"status":"executed","attempts":1,"reward":0}', 0, "completed"),
    { outcome: "executed", result: { status: "executed", attempts: 1, reward: 0 } });
}));

test("terminal proof for a root-dispatched Worker does not claim unrelated root sessions", async () => {
  const f = terminalHistory();
  f.sessions.worker!.parentID = "root";
  delete f.sessions.coordinator!.outcome;
  const previous = { operatorSessionID: null, units: [{ childSessionID: "worker" }] } as never;
  assert.deepEqual(await terminalCancelledMissionChildren(V010_RUNTIME_PROFILE, "root", previous, { reserved_units: 0 }, f.host), ["worker"]);
});

test("terminal mission proof rejects active, missing and foreign native lineage", async () => {
  const changes: [string, (f: ReturnType<typeof terminalHistory>) => void][] = [
    ["active Coordinator", f => { delete f.sessions.coordinator!.outcome; }],
    ["active Worker", f => { delete f.sessions.worker!.outcome; }],
    ["active old Worker", f => { delete f.sessions.prior!.outcome; }],
    ["active Reviewer", f => { delete f.sessions.reviewer!.outcome; }],
    ["unknown outcome", f => { f.sessions.worker!.outcome = "idle"; }],
    ["foreign Coordinator", f => { f.sessions.coordinator!.parentID = "foreign"; }],
    ["foreign child", f => { f.sessions.reviewer!.parentID = "foreign"; }],
    ["foreign role", f => { f.sessions.reviewer!.agent = "build"; }],
    ["wrong child identity", f => { f.sessions.worker!.id = "other"; }],
    ["missing child", f => { delete f.sessions.worker; }],
    ["missing listing", f => { f.children.coordinator = [{ id: "reviewer" }]; }],
    ["duplicate listing", f => { f.children.coordinator!.push({ id: "worker" }); }],
    ["unproven descendant", f => { f.children.reviewer = [{ id: "nested" }]; }],
  ];
  for (const [name, change] of changes) {
    const f = terminalHistory(); change(f);
    await assert.rejects(terminalCancelledMissionChildren(V010_RUNTIME_PROFILE, "root", f.previous, { reserved_units: 0 }, f.host), /mission-superseded-/, name);
  }
  const f = terminalHistory();
  await assert.rejects(terminalCancelledMissionChildren(V010_RUNTIME_PROFILE, "root", f.previous, { reserved_units: 1 }, f.host), /reservations-pending/);
});
