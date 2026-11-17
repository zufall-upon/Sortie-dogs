import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { OperatorMissionRuntime, missionAcceptanceSummary, missionPacket, missionPlan, missionReviewAccepted, missionReviewTask,
  missionCommandOutcome, missionConversationContext, missionExecutionStatus, missionReviewTraces, missionReviewVerdict } from "../dist/core/operator-mission.js";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { missionCoordinatorContent, missionOperatorContent, missionWorkerContent } from "../dist/runtime-mission-assets.js";
import { SortieDogsV010Plugin, terminalCancelledMissionChildren } from "../dist/plugin/profiled.js";
import { createSortieDogsV2Plugin } from "../dist/plugin/v2.js";
import { SortieDogsPlugin as CorePlugin } from "../dist/plugin/index.js";
import { RunFlightLedger, RunFlightLedgerError } from "../dist/core/run-flight-ledger.js";
import { NativeBackgroundLifecycle } from "../dist/plugin/native-background.js";
import { goalFingerprint } from "../dist/core/goal-bound.js";
import { evidenceFromObservedExecution } from "../dist/core/observed-goal-evidence.js";
import { runCodexMission } from "../dist/codex/run-mission.js";
import { V010_RUNTIME_ASSET_VERSION } from "../dist/asset-version.js";
import type { RuntimeBridge } from "../dist/plugin/runtime-bridge.js";
import { purposeDecisionView, purposeRequirementsFingerprint } from "../dist/core/mission-purpose.js";
import { observedMissionValidationSummary } from "../dist/plugin/mission-review.js";
import { closeTestDebtInventory, inspectTestDebt, inspectTestDebtPage } from "../dist/core/test-debt-audit.js";
import { createProjectPaths, createWriteGate } from "../dist/plugin/gate.js";

test("purpose decisions survive cold resume without becoming requirements, evidence or host actions", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "u1", text: "Deliver working result, verify it, and explicitly roll back the probe" });
  const original = await missions.start("root", ["Working result", "Verify and roll back probe"]);
  const decision = { decision: "STOP_METHOD", requirement_ids: ["R1"], observed_outcome: "The unchanged helper still fails",
    unmet_work: ["Deliver result using another method", "Required verification and rollback"], reason: "Same input and failure; no new hypothesis",
    evidence_refs: ["call:failed-helper"], affected_method: "retry unchanged helper", next_action: "Inspect alternative and finish verification/rollback" };
  await missions.recordPurposeDecision("root", decision);
  await missions.recordPurposeDecision("root", decision);
  const cold = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const resumed = await cold.required("root");
  assert.equal(resumed.purposeDecisions!.length, 1);
  assert.deepEqual(resumed.requirements, original.requirements);
  assert.equal(resumed.phase, "open");
  assert.equal(resumed.plans, 0);
  assert.deepEqual(resumed.attempts, original.attempts);
  assert.deepEqual(resumed.review, original.review);
  assert.deepEqual(resumed.submission, null);
  const packet = missionPacket(resumed);
  assert.equal(packet.next_action, missionPacket(original).next_action);
  assert.match(JSON.stringify(await cold.handoffContext(resumed)), /retry unchanged helper/);
  assert.match(cold.brief(resumed), /Required verification and rollback/);
  assert.equal(purposeDecisionView(resumed).current.length, 1);
  for (const bad of [{ ...decision, decision: "PASS" }, { ...decision, requirement_ids: ["R99"] },
    { ...decision, affected_method: undefined }, { ...decision, authorization: "all" }]) {
    await assert.rejects(cold.recordPurposeDecision("root", bad), /mission-purpose-decision-invalid/);
  }
  await cold.capture("root", { id: "u2", text: "Also preserve metadata" });
  const changed = await cold.start("root", [...resumed.requirements.map(item => item.text), "Preserve metadata"]);
  assert.equal(changed.id, original.id);
  assert.notEqual(purposeRequirementsFingerprint(changed), purposeRequirementsFingerprint(original));
  assert.equal(purposeDecisionView(changed).current.length, 0);
  assert.equal(purposeDecisionView(changed).historical.length, 1);
  for (let i = 0; i < 10; i++) await cold.recordPurposeDecision("root", { ...decision, reason: `Changed hypothesis ${i}` });
  assert.equal((await cold.required("root")).purposeDecisions!.length, 8);
  const broken = { ...changed, purposeDecisions: [null, { decision: "REUSE" }] } as never;
  assert.deepEqual(purposeDecisionView(broken).current, []);
  assert.equal(missionPacket(broken).next_action, missionPacket(original).next_action);
}));

async function fixture(run: (directory: string) => Promise<void>) {
  const area = resolve("_testenv");
  await mkdir(area, { recursive: true });
  const directory = await mkdtemp(join(area, "mission-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
const unit = { title: "Fix result", objective: "Implement the requested result without changing the oracle", read: ["check.mjs"],
  write: ["src"], validation: ["node check.mjs"] };
const independentReviewAcceptance = "After implementation and formal validation, the Coordinator must dispatch an independent Dog-Reviewer with review_mission and risk_tags [public-logic] to examine root cause and public logic, then reflect all FINDINGS; this SourceReview is post-validation and must not block Worker dispatch.";

for (const storage of ["0.1", "0.2"] as const) test(`Operator status and continuation recover at the goal event capacity (${storage})`, async t => fixture(async directory => {
  await promisify(execFile)("git", ["init", "--quiet"], { cwd: directory });
  const history: any[] = [];
  const create = () => SortieDogsV010Plugin({ directory, client: { session: {
    get: async ({ path }: any) => ({ data: { id: path.id, agent: "dog-operator", outcome: "running" } }),
    messages: async ({ path }: any) => ({ data: path.id === "root" ? history : [] }),
    children: async () => ({ data: [] }),
  } } } as never);
  let hooks = await create();
  const chat = (id: string) => hooks["chat.message"]!({ sessionID: "root", messageID: id, agent: "dog-operator" }, {
    message: { id, agent: "dog-operator", model: { providerID: "fixture", modelID: "fixture" } },
    parts: [{ type: "text", text: "Continue the same goal" }],
  });
  await chat("original");
  await hooks.tool!.sortie_v010_start_mission.execute({ requirements: ["Preserve the result"] }, { sessionID: "root" });
  const file = join(directory, ".git", "sortie-dogs", V010_RUNTIME_PROFILE.flightDirectory,
    `${createHash("sha256").update("v010\u0000root").digest("hex")}.json`);
  const ledger = await RunFlightLedger.openGoal(file), initial = (await ledger.readGoal()).state, goal = initial.goal_id!;
  const at = "2026-09-08T00:00:00.000Z";
  const command = "node verify.mjs";
  await ledger.appendGoal({ kind: "goal.revised", at, goal_id: goal, revision: 2, scope_epoch: 2,
    acceptance_fingerprint: initial.acceptance_fingerprint!, origin_user_message_id: "original", session_id: "root",
    selected_agent: initial.selected_agent!, delivery: initial.delivery!, budget: initial.budget!,
    acceptance_contract: { criteria: [{ criterion_id: "proof", target: "result", entrypoint: "verify", workload: "fixture",
      oracle_coverage: ["result"], build_boundary: "not-applicable", source: "source", candidate: "candidate",
      source_binding: "current-protected", candidate_binding: "current-protected", fixture: "fixture", proof_scope: "requested-full",
      expected_outcome: "pass", validation_command: command }] } });
  const proofState = await ledger.appendGoal({ kind: "dispatch.reserved", at, goal_id: goal, unit_id: "proved",
    reservation_id: "proved", session_id: "root", ticket_id: null });
  const proofPaths = Array.from({ length: 500 }, (_, index) => `test/fixtures/${"component/".repeat(15)}${index}.txt`);
  const proof = evidenceFromObservedExecution({ owner: "coordinator", immutableRef: goalFingerprint("proof"), command: [command],
    startedAt: at, endedAt: at, exitCode: 0, outcome: "pass", fresh: true, source: goalFingerprint("source"),
    candidate: goalFingerprint("candidate"), binding: { manifest_hash: goalFingerprint("manifest"), project_root: directory,
      manifest_path: "manifest.json", source_paths: proofPaths, candidate_paths: proofPaths } }, proofState, "proved");
  assert.equal(proof.length, 1);
  await ledger.appendGoal({ kind: "unit.settled", at, goal_id: goal, unit_id: "proved", reservation_id: "proved", receipt_id: "proof-receipt",
    disposition: "succeeded", result_class: "acceptance", progress_fingerprint: goalFingerprint(proof), evidence: proof, elapsed_ms: 4, cost_usd: 0.25 });
  await ledger.appendGoal({ kind: "dispatch.reserved", at, goal_id: goal, unit_id: "failed", reservation_id: "failed", session_id: "root", ticket_id: null });
  await ledger.appendGoal({ kind: "unit.settled", at, goal_id: goal, unit_id: "failed", reservation_id: "failed", receipt_id: "failure",
    disposition: "failed", result_class: "acceptance", progress_fingerprint: null, evidence: [], elapsed_ms: 5, cost_usd: null,
    native_session_id: "unpriced-child" });
  await ledger.appendGoal({ kind: "validation.admission", at, goal_id: goal, reservation_id: "unresolved-validation",
    operation_id: "unresolved-request", evidence_key: goalFingerprint("unresolved"), scope: "canonical", decision: "ALLOW",
    reason: "fixture", consumed: 1, limit: 4 });
  const reservations = ["live", "terminal"].map(unit_id => ({ unit_id, call: `${unit_id}-call`,
    reservation_id: goalFingerprint({ goal_id: goal, unit_id, call_id: `${unit_id}-call` }) }));
  for (const reservation of reservations) await ledger.appendGoal({ kind: "dispatch.reserved", at, goal_id: goal,
    unit_id: reservation.unit_id, reservation_id: reservation.reservation_id, session_id: "root", ticket_id: null });
  const doc = JSON.parse(await readFile(file, "utf8"));
  while (doc.goal_events.length < 2048) {
    const sequence = doc.goal_events.length + 1, previous_hash = doc.goal_events.at(-1).event_hash;
    const event = { kind: "goal.user-continued", at, goal_id: goal, origin_user_message_id: `past-${sequence}`,
      session_id: "root", selected_agent: "dog-operator" };
    doc.goal_events.push({ sequence, previous_hash, event_hash: goalFingerprint({ sequence, previous_hash, event }), event });
  }
  if (storage === "0.2") {
    const first = doc.goal_events[0], bytes = Buffer.from(JSON.stringify(first.event));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await mkdir(`${file}.blobs`, { recursive: true }); await writeFile(join(`${file}.blobs`, sha256), bytes);
    const { event: _event, ...record } = first;
    doc.goal_events[0] = { ...record, event_blob: { bytes: bytes.length, chunks: [{ sha256, bytes: bytes.length }] } };
    doc.schema_version = storage;
  }
  await writeFile(file, JSON.stringify(doc));
  const original = await readFile(file), prior = await ledger.readGoal();
  const status = () => hooks.tool!.sortie_v010_operator_status.execute({ view: "full" }, { sessionID: "root" });
  const observed = JSON.parse(await status());
  assert.equal(observed.budget.reserved_units, 2);
  assert.equal(observed.budget.consumed_units, 2);
  assert.equal(observed.budget.settled_cost_usd, null);
  assert.deepEqual(await readFile(file), original, "status alone neither spends nor appends");
  assert.deepEqual(await ledger.readGoal(), prior);
  history.push({ info: { role: "assistant", sessionID: "root" }, parts: [{ type: "tool", tool: "task", callID: "terminal-call",
    state: { status: "completed", input: { subagent_type: "dog-worker-v010", prompt: "task_id: terminal" }, time: { start: 1, end: 2 } } }] });
  if (storage === "0.1") {
    const originalLink = fs.link;
    const link = t.mock.method(fs, "link", async (...args: Parameters<typeof fs.link>) => {
      if (String(args[1]).startsWith(`${file}.blobs`)) throw new Error("page publication failure");
      return Reflect.apply(originalLink, fs, args);
    });
    syncBuiltinESMExports();
    try { await assert.rejects(status(), /page publication failure/); }
    finally { link.mock.restore(); syncBuiltinESMExports(); }
    assert.deepEqual(await readFile(file), original);
    assert.deepEqual(await ledger.readGoal(), prior, "failed publication retains history, reservations and unknown spend");
    hooks = await create();
    const originalRename = fs.rename;
    const rename = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
      if (String(args[1]) === file) throw new Error("page index rename failure");
      return Reflect.apply(originalRename, fs, args);
    });
    syncBuiltinESMExports();
    try { await assert.rejects(status(), /page index rename failure/); }
    finally { rename.mock.restore(); syncBuiltinESMExports(); }
    assert.deepEqual(await readFile(file), original);
    assert.deepEqual(await ledger.readGoal(), prior);
    hooks = await create();
  }
  const recovered = JSON.parse(await status()), after = await ledger.readGoal();
  assert.deepEqual(after.records.slice(0, prior.records.length), prior.records, "every old event, sequence and hash survives");
  assert.equal(after.records.length, 2049);
  assert.equal(recovered.budget.consumed_units, 3);
  assert.equal(recovered.budget.reserved_units, 1);
  assert.equal(recovered.budget.settled_cost_usd, null);
  assert.deepEqual(after.state.outstanding_reservations.map(item => item.unit_id), ["live"], "another live owner is not released");
  assert.deepEqual(after.state.validation_budget, prior.state.validation_budget, "unresolved validation remains unresolved");
  assert.deepEqual(after.state.evidence_refs, prior.state.evidence_refs);
  assert.deepEqual(after.state.satisfied_criteria, ["proof"]);
  assert.deepEqual(after.records.find(record => record.event.kind === "unit.settled" && record.event.unit_id === "proved")!.event,
    prior.records.find(record => record.event.kind === "unit.settled" && record.event.unit_id === "proved")!.event);
  const settlement = after.records.at(-1)!.event;
  assert.equal(settlement.kind, "unit.settled");
  if (settlement.kind !== "unit.settled") throw new Error("expected recovered settlement");
  assert.equal(settlement.disposition, "failed"); assert.equal(settlement.result_class, "process-defect");
  assert.deepEqual(settlement.evidence, []); assert.equal(settlement.cost_usd, null);
  hooks = await create();
  await status(); assert.deepEqual(await ledger.readGoal(), after, "cold status never repeats recovery or charges");
  const oversizedOld = join(directory, `invalid-${storage}.json`);
  const invalidOldBody = JSON.stringify({ ...doc, goal_events: [...doc.goal_events, after.records.at(-1)] });
  await writeFile(oversizedOld, invalidOldBody);
  await assert.rejects(RunFlightLedger.readGoalFile(oversizedOld), /closed schema/, "old formats still reject more than 2048 records");
  assert.equal(await readFile(oversizedOld, "utf8"), invalidOldBody);
  const chunksBeforeContinuation = (await fs.readdir(`${file}.blobs`)).sort();
  await chat("continued-after-capacity");
  assert.deepEqual((await fs.readdir(`${file}.blobs`)).sort(), chunksBeforeContinuation,
    "a small tail append does not leave another unreachable page blob");
  const continued = await ledger.readGoal();
  assert.deepEqual(continued.records.slice(0, after.records.length), after.records);
  assert.equal(continued.records.at(-1)!.event.kind, "goal.user-continued");
  assert.equal(continued.state.consumed_units, after.state.consumed_units);
  assert.deepEqual(continued.state.outstanding_reservations, after.state.outstanding_reservations);
  const body = await readFile(file, "utf8"), paged = JSON.parse(body);
  assert.equal(paged.schema_version, "0.3");
  assert.ok(paged.goal_events.length > 1 && paged.goal_events.every((page: any) => page.count <= 128));
  assert.ok(Array.isArray(paged.goal_events.at(-1).records), "the incomplete tail stays inline");
  const chunk = join(`${file}.blobs`, paged.goal_events[0].records_blob.chunks[0].sha256);
  const chunkBytes = await readFile(chunk);
  const proofSequence = prior.records.find(record => record.event.kind === "unit.settled" && record.event.unit_id === "proved")!.sequence;
  const proofRecord = JSON.parse(chunkBytes.toString("utf8")).find((record: any) => record.sequence === proofSequence);
  assert.ok(proofRecord.event_blob, "large original evidence is still a separately verified event blob inside its page");
  const proofChunk = join(`${file}.blobs`, proofRecord.event_blob.chunks[0].sha256), proofBytes = await readFile(proofChunk);
  await rm(proofChunk);
  await assert.rejects(status(), /blob chunk is missing/);
  assert.equal(await readFile(file, "utf8"), body);
  await writeFile(proofChunk, proofBytes);
  await rm(chunk);
  await assert.rejects(status(), /blob chunk is missing/);
  assert.equal(await readFile(file, "utf8"), body);
  await writeFile(chunk, chunkBytes);
  const corrupted = Buffer.from(chunkBytes); corrupted[0] = corrupted[0]! ^ 1;
  await writeFile(chunk, corrupted);
  await assert.rejects(status(), /blob chunk hash mismatch/);
  assert.equal(await readFile(file, "utf8"), body);
  await writeFile(chunk, chunkBytes);
  const invalid = JSON.parse(body); invalid.goal_events[0].first_sequence = 2;
  await writeFile(file, JSON.stringify(invalid));
  await assert.rejects(status(), /pages are malformed/);
  const invalidReference = JSON.parse(body); invalidReference.goal_events[0].records_blob.chunks[0].sha256 = "../outside";
  await writeFile(file, JSON.stringify(invalidReference));
  await assert.rejects(status(), /blob chunk reference is malformed/);
  const alteredPage = JSON.parse(chunkBytes.toString("utf8"));
  alteredPage.at(-1).event.origin_user_message_id = "tampered";
  const alteredBytes = Buffer.from(JSON.stringify(alteredPage)), alteredHash = createHash("sha256").update(alteredBytes).digest("hex");
  await writeFile(join(`${file}.blobs`, alteredHash), alteredBytes);
  const invalidChain = JSON.parse(body);
  invalidChain.goal_events[0].records_blob = { bytes: alteredBytes.length, chunks: [{ sha256: alteredHash, bytes: alteredBytes.length }] };
  await writeFile(file, JSON.stringify(invalidChain));
  await assert.rejects(status(), /hash chain is malformed/, "valid blob hash does not excuse a changed historical event");
  await writeFile(file, body);
  assert.deepEqual(await ledger.readGoal(), continued);
  if (storage === "0.1") {
    await ledger.appendGoal({ kind: "goal.user-continued", at, goal_id: goal, origin_user_message_id: "codex-unknown",
      session_id: "root", selected_agent: "codex" });
    const manifest = join(directory, ".git", "codex-capacity-inventory.json");
    await writeFile(manifest, JSON.stringify({ version: "0.1.0", task_id: "codex-test", read: ["check.mjs"],
      write: ["result.txt"], validation: ["node check.mjs"] }));
    await assert.rejects(runCodexMission({ projectRoot: directory, manifestPath: manifest, prompt: "Do not resend", executable: "must-not-start" }),
      /codex-mission-outcome-unknown:no-resend/, "paged goal remains visible to the existing Codex inventory caller");
  }
}));

test("Operator status and continuation recover at the goal event capacity (paged limit diagnostic)", async t => fixture(async directory => {
  await promisify(execFile)("git", ["init", "--quiet"], { cwd: directory });
  const history: any[] = [];
  let priceAvailable = false;
  const session = {
    get: async ({ path }: any) => ({ data: { id: path.id, agent: "dog-operator", outcome: "running" } }),
    messages: async ({ path }: any) => ({ data: path.id === "root" ? history : path.id === "unpriced-child" && priceAvailable
      ? [{ info: { id: "priced-request", role: "assistant", providerID: "openai", modelID: "gpt-6-luna-fast",
        time: { created: 2000, completed: 3000 }, tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } } } }]
      : [] }),
    children: async () => ({ data: [] }),
  };
  const hooks = await SortieDogsV010Plugin({ directory, client: { session } } as never);
  const chat = (id: string) => hooks["chat.message"]!({ sessionID: "root", messageID: id, agent: "dog-operator" }, {
    message: { id, agent: "dog-operator", model: { providerID: "fixture", modelID: "fixture" } },
    parts: [{ type: "text", text: "Continue the same goal" }],
  });
  await chat("original");
  await hooks.tool!.sortie_v010_start_mission.execute({ requirements: ["Preserve the result"] }, { sessionID: "root" });
  const file = join(directory, ".git", "sortie-dogs", V010_RUNTIME_PROFILE.flightDirectory,
    `${createHash("sha256").update("v010\u0000root").digest("hex")}.json`);
  const ledger = await RunFlightLedger.openGoal(file), initial = (await ledger.readGoal()).state, goal = initial.goal_id!;
  const at = "2026-09-08T00:00:00.000Z";
  await ledger.appendGoal({ kind: "dispatch.reserved", at, goal_id: goal, unit_id: "failed", reservation_id: "failed", session_id: "root", ticket_id: null });
  await ledger.appendGoal({ kind: "unit.settled", at, goal_id: goal, unit_id: "failed", reservation_id: "failed", receipt_id: "failure",
    disposition: "failed", result_class: "acceptance", progress_fingerprint: null, evidence: [], elapsed_ms: 5, cost_usd: null,
    native_session_id: "unpriced-child" });
  await ledger.appendGoal({ kind: "validation.admission", at, goal_id: goal, reservation_id: "unresolved-validation",
    operation_id: "unresolved-request", evidence_key: goalFingerprint("unresolved"), scope: "canonical", decision: "ALLOW",
    reason: "fixture", consumed: 1, limit: 4 });
  const pendingUnits = ["live", "terminal", ...Array.from({ length: 9 }, (_, index) => `extra-${index}-${"x".repeat(460)}`)];
  for (const unit_id of pendingUnits) await ledger.appendGoal({ kind: "dispatch.reserved", at, goal_id: goal, unit_id,
    reservation_id: goalFingerprint({ goal_id: goal, unit_id, call_id: `${unit_id}-call` }), session_id: "root", ticket_id: null });
  const records: any[] = [...(await ledger.readGoal()).records];
  while (records.length < 32768) {
    const sequence = records.length + 1, previous_hash = records.at(-1).event_hash;
    const event = { kind: "goal.user-continued", at, goal_id: goal, origin_user_message_id: `past-${sequence}`,
      session_id: "root", selected_agent: "dog-operator" };
    records.push({ sequence, previous_hash, event_hash: goalFingerprint({ sequence, previous_hash, event }), event });
  }
  await mkdir(`${file}.blobs`, { recursive: true });
  const pages = [];
  for (let start = 0; start < records.length; start += 128) {
    const bytes = Buffer.from(JSON.stringify(records.slice(start, start + 128)));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(`${file}.blobs`, sha256), bytes);
    pages.push({ first_sequence: start + 1, count: 128, records_blob: { bytes: bytes.length, chunks: [{ sha256, bytes: bytes.length }] } });
  }
  await writeFile(file, JSON.stringify({ schema_version: "0.3", goal_events: pages }));
  const before = await ledger.readGoal(), original = await readFile(file), blobs = (await fs.readdir(`${file}.blobs`)).sort();
  const rawStatus = (view: string) => hooks.tool!.sortie_v010_operator_status.execute({ view }, { sessionID: "root" });
  const status = async (view: string) => JSON.parse(await rawStatus(view));
  const beforeTerminal = await status("full");
  assert.equal(beforeTerminal.budget.reserved_units, pendingUnits.length);
  assert.equal(beforeTerminal.budget.settled_cost_usd, null);
  const retainedConditions = { entrypoint: "existing-runner", source: "user:original", applies_to: "retained invocation" };
  await hooks.tool!.sortie_v010_operator_status.execute({ confirmed_conditions: retainedConditions }, { sessionID: "root" });
  history.push({ info: { role: "assistant", sessionID: "root" }, parts: [{ type: "tool", tool: "task", callID: "terminal-call",
    state: { status: "completed", input: { subagent_type: "dog-worker-v010", prompt: "task_id: terminal" }, time: { start: 1, end: 2 } } }] });
  const originalOpen = fs.open;
  let lockFailure: Error = new Error("unrelated recovery I/O failure");
  const open = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === `${file}.lock`) throw lockFailure;
    return Reflect.apply(originalOpen, fs, args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(status("full"), /unrelated recovery I\/O failure/);
    lockFailure = new RunFlightLedgerError("capacity", "Ledger byte capacity exceeded.");
    await assert.rejects(status("full"), /Ledger byte capacity exceeded/, "ordinary Run ledger capacity is not a Goal diagnostic");
  }
  finally { open.mock.restore(); syncBuiltinESMExports(); }
  for (const view of ["full", "progress"]) {
    const raw = await rawStatus(view), diagnostic = JSON.parse(raw);
    assert.equal(view === "progress" ? diagnostic.stage : diagnostic.status, "goal-ledger-capacity");
    assert.equal(diagnostic.ledger_diagnostic.mode, "read-only");
    assert.equal(diagnostic.ledger_diagnostic.reconciliation, "incomplete");
    assert.match(diagnostic.next_action, /Do not dispatch/);
    assert.ok(Buffer.byteLength(raw.slice(0, raw.indexOf('"next_action"'))) < 51200, "native output keeps the diagnostic action visible");
    assert.equal(diagnostic.task, undefined);
    assert.equal(diagnostic.budget.consumed_units, 1);
    assert.equal(diagnostic.budget.reserved_units, pendingUnits.length);
    assert.equal(diagnostic.budget.settled_cost_usd, null);
    assert.equal(diagnostic.budget.cost_status, "unknown-usage");
    const shown = diagnostic.budget.ledger_diagnostic.outstanding_reservations;
    assert.deepEqual(shown.slice(0, 2).map((item: any) => item.unit_id), ["live", "terminal"]);
    assert.equal(diagnostic.budget.ledger_diagnostic.outstanding_reservations_omitted, pendingUnits.length - shown.length);
    assert.ok(diagnostic.budget.ledger_diagnostic.outstanding_reservations_omitted > 0, "bounded output points back to retained records");
    assert.equal(diagnostic.budget.ledger_diagnostic.validation_reservations[0].reservation_id, "unresolved-validation");
    assert.equal(diagnostic.budget.ledger_diagnostic.validation_reservations_omitted, 0);
    assert.deepEqual(diagnostic.budget.ledger_diagnostic.recent_failed_settlements,
      [{ goal_id: goal, unit_id: "failed", disposition: "failed", result_class: "acceptance", recorded_cost_usd: null }]);
    if (view === "full") assert.equal(diagnostic.coordinator_dispatch, "blocked-capacity");
  }
  await assert.rejects(chat("cannot-continue-at-capacity"), /Goal ledger capacity exceeded/);
  // V2 retains a failed native background settlement instead of throwing it from
  // reconcile(). Its pending dispatch must not hide the capacity diagnostic.
  history.length = 0;
  const backgroundStorage = new Map<string, unknown>(), childHistory: any[] = [];
  let backgroundHooks: Awaited<ReturnType<typeof SortieDogsV010Plugin>>;
  const background = new NativeBackgroundLifecycle({
    storage: { get: async (key: string) => structuredClone(backgroundStorage.get(key)),
      set: async (key: string, value: unknown) => { backgroundStorage.set(key, structuredClone(value)); } },
    session: { get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID }),
      context: async () => childHistory },
  } as never, async (dispatch, text) => {
    await backgroundHooks["tool.execute.after"]!({ tool: "task", sessionID: dispatch.parent, callID: dispatch.callID,
      args: { subagent_type: dispatch.agent, prompt: dispatch.input.prompt } },
    { status: "completed", output: text, metadata: { sessionID: dispatch.child, status: dispatch.terminal } });
  });
  backgroundHooks = await SortieDogsV010Plugin({ directory, client: { session }, nativeBackground: background } as never);
  backgroundHooks.backgroundOwner!("terminal-call", { core: { reservation: { root: "root", unitID: "terminal",
    reservationID: goalFingerprint({ goal_id: goal, unit_id: "terminal", call_id: "terminal-call" }), started: 1 }, executions: [] } });
  await background.admit("root", "terminal-call", { agent: "dog-worker-v010", prompt: "Preserve native result", sessionID: "native-terminal" });
  await background.launched("root", "terminal-call", "native-terminal", true);
  childHistory.push({ id: "native-result", type: "assistant", finish: "stop", content: [{ type: "text", text: "Retained result" }] });
  await background.reconcile("root");
  assert.match(background.reconciliationNotice("root")!, /Goal ledger capacity exceeded/);
  assert.equal(await background.awaiting("root"), true);
  for (const view of ["full", "progress", ""]) {
    const diagnostic = JSON.parse(await backgroundHooks.tool!.sortie_v010_operator_status.execute({ view }, { sessionID: "root" }));
    assert.equal(view === "progress" ? diagnostic.stage : diagnostic.status, "goal-ledger-capacity",
      "a retained native background failure reaches the public status diagnostic");
    assert.equal(diagnostic.ledger_diagnostic.reconciliation, "incomplete");
    assert.equal(diagnostic.task, undefined);
    assert.match(diagnostic.next_action, /Do not dispatch/);
    assert.equal(diagnostic.budget.consumed_units, 1);
    assert.equal(diagnostic.budget.reserved_units, pendingUnits.length);
    assert.equal(diagnostic.budget.settled_cost_usd, null);
  }
  const nativeDispatch = (await backgroundStorage.get("v2-background-dispatches:root") as any[])[0];
  assert.equal(nativeDispatch.terminal, "succeeded");
  assert.notEqual(nativeDispatch.settled, true, "diagnosis never fabricates native accounting settlement");
  const addedConditions = { inputs: ["existing-input"], source: "runner metadata", applies_to: retainedConditions.applies_to };
  await backgroundHooks.tool!.sortie_v010_operator_status.execute({ confirmed_conditions: addedConditions }, { sessionID: "root" });
  const launchConditions = (await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root")).launchConditions!;
  assert.deepEqual(launchConditions.map(({ recordedAt: _at, ...conditions }) => conditions), [retainedConditions, addedConditions],
    "capacity diagnostics preserve the explicit status opt-in and existing client-owned conditions");
  // Pricing can independently need an append even when no terminal reservation is recoverable.
  history.length = 0; priceAvailable = true;
  const pricingDiagnostic = await status("full");
  assert.equal(pricingDiagnostic.status, "goal-ledger-capacity");
  assert.equal(pricingDiagnostic.budget.settled_cost_usd, null);
  assert.equal(pricingDiagnostic.budget.reserved_units, pendingUnits.length);
  assert.deepEqual(await readFile(file), original);
  assert.deepEqual((await fs.readdir(`${file}.blobs`)).sort(), blobs);
  assert.deepEqual(await ledger.readGoal(), before, "no history, failed outcome, reservation or unknown cost is rewritten");
}));

test("Operator recovers a registered native check in a linked worktree within a broad Location", async () => fixture(async root => {
  const exec = promisify(execFile), repository = join(root, "repository"), checkout = join(root, "checkout"), other = join(root, "other"),
    component = join(root, "component-source");
  await mkdir(repository); await mkdir(component);
  await exec("git", ["init", "--quiet"], { cwd: component });
  await writeFile(join(component, "payload.txt"), "component expected\n");
  await exec("git", ["add", "."], { cwd: component });
  await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "base"], { cwd: component });
  await exec("git", ["init", "--quiet"], { cwd: repository });
  await writeFile(join(repository, "input.txt"), "expected\n");
  await writeFile(join(repository, "check.mjs"), 'import assert from "node:assert/strict";import {readFileSync} from "node:fs";assert.equal(readFileSync("input.txt","utf8"),"expected\\n");assert.equal(readFileSync("component/payload.txt","utf8"),"component expected\\n");console.log("USEFUL_CHECK_PASSED");\n');
  await exec("git", ["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", component, "component"], { cwd: repository });
  await exec("git", ["add", "."], { cwd: repository });
  await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "base"], { cwd: repository });
  await exec("git", ["worktree", "add", "--detach", checkout], { cwd: repository });
  await exec("git", ["worktree", "add", "--detach", other], { cwd: repository });
  await exec("git", ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--quiet"], { cwd: checkout });
  const marker = join(checkout, ".git"), savedMarker = await readFile(marker);
  const history: unknown[] = [];
  const hooks = await SortieDogsV010Plugin({ directory: root, client: { session: {
    get: async () => ({ data: { id: "root", agent: "dog-operator" } }),
    children: async () => ({ data: [] }), messages: async () => ({ data: history }),
  } } } as never);
  const tool = async (name: string, args = {}) => JSON.parse(await hooks.tool![`sortie_v010_${name}`]!.execute(args, { sessionID: "root" }));
  const chat = async (id: string) => hooks["chat.message"]!({ sessionID: "root", messageID: id, agent: "dog-operator" }, {
    message: { id, agent: "dog-operator", model: { providerID: "openai", modelID: "fixture" } },
    parts: [{ type: "text", text: "Check the linked checkout" }],
  });
  const command = "node check.mjs", plan = { executor: "self", units: [{ title: "Check", objective: "Check input",
    read: ["checkout/check.mjs", "checkout/input.txt", "checkout/component/payload.txt"], write: ["checkout/**"], validation: [command], validation_cwd: { [command]: checkout } }] };
  const call = (callID: string) => ({ tool: "shell", sessionID: "root", callID });
  const args = { command, workdir: checkout };
  await chat("request"); await tool("start_mission", { requirements: ["Check the linked checkout"] });
  assert.equal((await tool("plan_units", plan)).status, "direct-unit-running");

  // Real validation start rejects a marker impersonating the other checkout.
  await writeFile(marker, await readFile(join(other, ".git")));
  await assert.rejects(hooks["tool.execute.before"]!(call("bad-check"), { args }), error => {
    assert.match(String(error), /mission-validation-snapshot-unavailable:.*untrusted-nested-git-metadata/);
    assert.doesNotMatch(String(error), /repository|checkout|other/);
    return true;
  });
  const before = await tool("operator_status");
  assert.equal((await tool("cancel_operator", { reason: "plain" })).status, "cancelled");
  const cancelled = await tool("operator_status");
  assert.ok(cancelled.budget.consumed_units >= before.budget.consumed_units);
  await writeFile(marker, savedMarker);
  await chat("resume"); await tool("start_mission", { intent: "new", requirements: ["Check the linked checkout"] });
  assert.equal((await tool("plan_units", plan)).status, "direct-unit-running");
  const resumed = await tool("operator_status");
  assert.ok(resumed.budget.consumed_units >= cancelled.budget.consumed_units, "recovery does not reset cumulative consumption");

  const input = call("recovered-check"), started = Date.now();
  await hooks["tool.execute.before"]!(input, { args });
  const checked = await exec(process.execPath, ["check.mjs"], { cwd: checkout });
  assert.match(checked.stdout, /USEFUL_CHECK_PASSED/);
  await hooks["tool.execute.after"]!({ ...input, args }, { output: checked.stdout, metadata: { exit: 0, status: "completed" } });
  history.push({ info: { role: "assistant", sessionID: "root" }, parts: [{ type: "tool", tool: "shell", callID: input.callID,
    state: { status: "completed", input: args, metadata: { exit: 0 }, time: { start: started, end: Date.now() } } }] });
  const run = await new OperatorRuntime(root, V010_RUNTIME_PROFILE).required("root");
  assert.ok(run.units[0]!.directExecution!.checks.some(check => check.callID === input.callID && check.exitCode === 0 && check.fresh));
  assert.notEqual((await tool("finish_direct_unit")).status, "direct-unit-awaits-validation");
}));

test("ordinary direct Mission schedules test debt before validation and retains it for the existing Reviewer", async () => fixture(async root => {
  const exec = promisify(execFile), history: unknown[] = [];
  await mkdir(join(root, "test"));
  const source = join(root, "value.mjs"), check = join(root, "test", "value.test.mjs");
  const originalSource = "export const double = n => n * 2;\n";
  const originalTest = 'import assert from "node:assert/strict";\nimport { double } from "../value.mjs";\nassert.strictEqual(double(0), 0);\nassert.strictEqual(double(0), 0);\nconst value = double(21);\nassert.strictEqual(value, 42);\nassert.strictEqual(value, 42);\n';
  await writeFile(source, originalSource); await writeFile(check, originalTest);
  await writeFile(join(root, "check.mjs"), 'import "./test/value.test.mjs";\n');
  const outsideTest = join(root, "outside.test.mjs");
  await writeFile(outsideTest, "assert.equal(1, 1);\nassert.equal(1, 1);\n");
  await mkdir(join(root, "test", "node_modules"));
  await writeFile(join(root, "test", "node_modules", "dependency.test.mjs"), "assert.equal(2, 2);\nassert.equal(2, 2);\n");
  await mkdir(join(root, "test", ".opencode"));
  await writeFile(join(root, "test", ".opencode", "private.test.mjs"), "assert.equal(3, 3);\nassert.equal(3, 3);\n");
  await writeFile(join(root, "test", ".state.test.mjs"), "assert.equal(4, 4);\nassert.equal(4, 4);\n");
  const foreign = join(root, "other-task.txt");
  await writeFile(foreign, "baseline\n");
  for (const args of [["init", "--quiet"], ["config", "user.name", "test"], ["config", "user.email", "test@example.invalid"],
    ["add", "--all"], ["commit", "--quiet", "-m", "base"]]) await exec("git", args, { cwd: root });
  await writeFile(foreign, "pre-existing other task change\n");
  const command = "node check.mjs";
  const probe = async (good: string, broken: string) => {
    await exec(process.execPath, ["test/value.test.mjs"], { cwd: root });
    await writeFile(source, broken);
    await assert.rejects(exec(process.execPath, ["test/value.test.mjs"], { cwd: root }), /41 !== 42/);
    await writeFile(source, good);
  };
  // The pre-change oracle really rejects the same wrong 21 result; it is not a new expected value.
  await probe(originalSource, "export const double = n => n === 21 ? 41 : n * 2;\n");
  const hooks = await SortieDogsV010Plugin({ directory: root, client: { session: {
    get: async () => ({ data: { id: "root", agent: "dog-operator" } }),
    children: async () => ({ data: [] }), messages: async () => ({ data: history }),
  } } } as never);
  const tool = async (name: string, args = {}) => JSON.parse(await hooks.tool![`sortie_v010_${name}`]!.execute(args, { sessionID: "root" }));
  await hooks["chat.message"]!({ sessionID: "root", messageID: "request", agent: "dog-operator" }, {
    message: { id: "request", agent: "dog-operator", model: { providerID: "openai", modelID: "fixture" } },
    parts: [{ type: "text", text: "Update the calculation while retaining its behavior." }],
  });
  await tool("start_mission", { requirements: ["Update the calculation while retaining its behavior"], prohibited_write: ["outside.test.mjs"] });
  const started = await tool("plan_units", { executor: "self", units: [{ title: "Update calculation", objective: "Preserve the calculation",
    read: ["value.mjs", "check.mjs"], write: ["value.mjs", "test/**"], validation: [command] }] });
  assert.equal(started.status, "direct-unit-running");
  assert.deepEqual(started.test_debt_audit.signals.map((signal: { path: string }) => signal.path), ["test/value.test.mjs"],
    "the glob discovers the in-scope test without inspecting dependency or hidden entries");
  assert.deepEqual(started.test_debt_audit.signals[0].repeated_assertions, [[3, 4], [6, 7]]);
  assert.match(started.test_debt_audit.instruction, /similar lines or size alone do not establish redundancy/);
  const run = await new OperatorRuntime(root, V010_RUNTIME_PROFILE).required("root");
  const handoff = JSON.parse(await readFile(run.units[0]!.handoffPath, "utf8"));
  assert.equal(handoff.ext["sortie-dogs/mission-context"].test_debt_audit.signals[0].path, "test/value.test.mjs");
  const gate = await createWriteGate(await createProjectPaths(root), JSON.parse(await readFile(run.units[0]!.manifestPath, "utf8")));
  await gate.checkPath(check);
  await assert.rejects(gate.checkPath(outsideTest), (error: { reason?: string }) => error.reason === "manifest-scope");
  const edit = async (path: string, oldString: string, newString: string, callID: string) => {
    const args = { filePath: path, oldString, newString }, request = { tool: "edit", sessionID: "root", callID };
    await hooks["tool.execute.before"]!(request, { args });
    await writeFile(path, (await readFile(path, "utf8")).replace(oldString, newString));
    const output = { output: "edited" };
    await hooks["tool.execute.after"]!({ ...request, args }, output);
    return output.output;
  };
  const updatedSource = "export const double = n => n + n;\n";
  await edit(source, originalSource, updatedSource, "source-edit");
  await assert.rejects(hooks["tool.execute.before"]!({ tool: "edit", sessionID: "root", callID: "outside-edit" },
    { args: { filePath: outsideTest, oldString: "1", newString: "3" } }), /mission-explicit-write-prohibition/);
  assert.equal(await readFile(outsideTest, "utf8"), "assert.equal(1, 1);\nassert.equal(1, 1);\n");
  // Simulate the existing author applying a source-backed consolidation; the host does not edit files.
  const response = await edit(check, "assert.strictEqual(value, 42);\nassert.strictEqual(value, 42);", "assert.strictEqual(value, 42);", "audit-edit");
  assert.doesNotMatch(response, /SORTIE_TEST_DEBT_AUDIT/, "the audit's own change must not schedule itself again");
  assert.deepEqual((await inspectTestDebt(root, { read: [check], write: [], validation: [] }))[0]!.repeated_assertions, [[3, 4]],
    "suppression applies even when the edited file still has a scheduling signal");
  assert.match(await readFile(check, "utf8"), /assert\.strictEqual\(double\(0\), 0\)/);
  assert.equal(await readFile(foreign, "utf8"), "pre-existing other task change\n");
  await probe(updatedSource, "export const double = n => n === 21 ? 41 : n + n;\n");
  const input = { tool: "shell", sessionID: "root", callID: "validation" }, args = { command, workdir: root }, start = Date.now();
  await hooks["tool.execute.before"]!(input, { args });
  const checked = await exec(process.execPath, ["check.mjs"], { cwd: root });
  await hooks["tool.execute.after"]!({ ...input, args }, { output: checked.stdout, metadata: { exit: 0, status: "completed" } });
  history.push({ info: { role: "assistant", sessionID: "root" }, parts: [{ type: "tool", tool: "shell", callID: input.callID,
    state: { status: "completed", input: args, metadata: { exit: 0 }, time: { start, end: Date.now() } } }] });
  assert.notEqual((await tool("finish_direct_unit")).status, "direct-unit-awaits-validation");
  const review = await tool("review_mission", { risk_tags: ["public-logic"] });
  assert.equal(review.status, "review-required");
  const reviewPrompt = (await new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE).required("root")).review!.task!.prompt;
  assert.match(reviewPrompt, /test_debt_scheduling_signals/);
  assert.match(reviewPrompt, /not proof of duplication, cleanup, detection equivalence or review/);
}));

test("ordinary Mission inventory advances past unchanged large tests at later planning milestones", async () => fixture(async root => {
  await mkdir(join(root, "test"));
  const text = `${"// retained specification\n".repeat(500)}assert.equal(1, 1);\n`;
  for (let index = 0; index < 40; index++) {
    await writeFile(join(root, "test", `${String(index).padStart(2, "0")}.test.mjs`), text);
  }
  await writeFile(join(root, "test", "priority.test.mjs"), text);
  await writeFile(join(root, "check.mjs"), "console.log('check');\n");
  const hooks = await SortieDogsV010Plugin({ directory: root, client: { session: {
    get: async () => ({ data: { id: "root", agent: "dog-operator" } }),
    children: async () => ({ data: [] }), messages: async () => ({ data: [] }),
  } } } as never);
  const tool = async (name: string, args = {}) => JSON.parse(await hooks.tool![`sortie_v010_${name}`]!.execute(args, { sessionID: "root" }));
  await hooks["chat.message"]!({ sessionID: "root", messageID: "request", agent: "dog-operator" }, {
    message: { id: "request", agent: "dog-operator", model: { providerID: "openai", modelID: "fixture" } },
    parts: [{ type: "text", text: "Maintain the test suite while implementing the change." }],
  });
  await tool("start_mission", { requirements: ["Maintain the test suite while implementing the change"] });
  const declaration = (title: string) => ({ executor: "self", units: [{ title, objective: "Maintain the test suite",
    read: ["check.mjs", "test/priority.test.mjs"], write: ["test/**"], validation: ["node check.mjs"] }] });
  const first = await tool("plan_units", declaration("First milestone"));
  const firstPaths = first.test_debt_audit.signals.map((signal: { path: string }) => signal.path);
  assert.equal(firstPaths.length, 16);
  assert.equal(firstPaths[0], "test/priority.test.mjs", "explicit files precede automatically discovered files");
  const missions = new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE);
  const saved = (await missions.required("root")).testDebtInventory;
  const firstRun = await new OperatorRuntime(root, V010_RUNTIME_PROFILE).required("root");
  const firstHandoff = await readFile(firstRun.units[0]!.handoffPath, "utf8");
  await tool("plan_units", declaration("First milestone"));
  assert.deepEqual((await missions.required("root")).testDebtInventory, saved, "a retry cannot consume another page");
  assert.equal(await readFile(firstRun.units[0]!.handoffPath, "utf8"), firstHandoff);
  const second = await tool("plan_units", { ...declaration("Second milestone"), reason: "Continue the same work" });
  const secondPaths = second.test_debt_audit.signals.map((signal: { path: string }) => signal.path);
  assert.ok(secondPaths.some((path: string) => !firstPaths.includes(path)),
    "unchanged size signals in the first batch must not permanently hide later tests");
  assert.equal(new Set([...firstPaths, ...secondPaths]).size, 31);
  await writeFile(join(root, "test", "new.test.mjs"), text);
  await tool("cancel_operator", { reason: "Interrupt this work before continuing" });
  await hooks["chat.message"]!({ sessionID: "root", messageID: "resume", agent: "dog-operator" }, {
    message: { id: "resume", agent: "dog-operator", model: { providerID: "openai", modelID: "fixture" } },
    parts: [{ type: "text", text: "Continue maintaining the same test suite." }],
  });
  await tool("start_mission", { intent: "continue", requirements: ["Maintain the test suite while implementing the change"] });
  const laterPaths = new Set<string>([...firstPaths, ...secondPaths]);
  for (let index = 0; index < 4; index++) {
    const next = await tool("plan_units", { ...declaration(`Continued milestone ${index}`), ...(index ? { reason: "Continue the same work" } : {}) });
    for (const signal of next.test_debt_audit?.signals ?? []) laterPaths.add(signal.path);
  }
  for (let index = 0; index < 40; index++) assert.ok(laterPaths.has(`test/${String(index).padStart(2, "0")}.test.mjs`));
  assert.ok(laterPaths.has("test/new.test.mjs"), "a newly added test is reached after at most another traversal");
  await tool("cancel_operator", { reason: "End this isolated fixture" });
}));

test("ordinary Mission resumes bounded inventory after entry and directory limits", async () => fixture(async root => {
  const flat = join(root, "flat"), nested = join(root, "nested", "test");
  await mkdir(flat, { recursive: true }); await mkdir(nested, { recursive: true });
  for (let index = 0; index < 5000; index++) await writeFile(join(flat, `input-${index}.txt`), "x");
  for (let index = 0; index < 140; index++) await mkdir(join(nested, `dir-${String(index).padStart(3, "0")}`));
  await writeFile(join(root, "check.mjs"), "console.log('check');\n");
  const hooks = await SortieDogsV010Plugin({ directory: root, client: { session: {
    get: async () => ({ data: { id: "root", agent: "dog-operator" } }),
    children: async () => ({ data: [] }), messages: async () => ({ data: [] }),
  } } } as never);
  const tool = async (name: string, args = {}) => JSON.parse(await hooks.tool![`sortie_v010_${name}`]!.execute(args, { sessionID: "root" }));
  await hooks["chat.message"]!({ sessionID: "root", messageID: "request", agent: "dog-operator" }, {
    message: { id: "request", agent: "dog-operator", model: { providerID: "openai", modelID: "fixture" } },
    parts: [{ type: "text", text: "Maintain both test trees." }],
  });
  await tool("start_mission", { requirements: ["Maintain both test trees"] });
  const plan = (scope: string, index: number) => ({ executor: "self", units: [{ title: `${scope} ${index}`, objective: "Maintain the test tree",
    read: ["check.mjs"], write: [`${scope}/**`], validation: ["node check.mjs"] }], ...(index ? { reason: "Continue inventory" } : {}) });
  await tool("plan_units", plan("flat", 0));
  const mission = new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE);
  const firstCursor = Object.values((await mission.required("root")).testDebtInventory!.cursors)[0]!;
  assert.ok(firstCursor.frames.length && firstCursor.frames[0]!.after, "the entry cap retains a continuation, not a completed inventory");
  await tool("plan_units", plan("flat", 1));
  await closeTestDebtInventory(`${root}\0root`); // Model a cold host reopening the saved cursor.
  const pressure = Array.from({ length: 65 }, (_, index) => `cache-${index}`);
  for (const scope of pressure) {
    await mkdir(join(root, scope));
    for (let index = 0; index < 16; index++) await writeFile(join(root, scope, `${index}.test.mjs`), "");
  }
  const text = "assert.equal(1, 1);\nassert.equal(1, 1);\n";
  await writeFile(join(flat, "later.test.mjs"), text);
  let foundFlat = false;
  for (let index = 2; index <= 9; index++) {
    await tool("cancel_operator", { reason: "Interrupt before continuing the same work" });
    await hooks["chat.message"]!({ sessionID: "root", messageID: `resume-${index}`, agent: "dog-operator" }, {
      message: { id: `resume-${index}`, agent: "dog-operator", model: { providerID: "openai", modelID: "fixture" } },
      parts: [{ type: "text", text: "Continue maintaining both test trees." }],
    });
    await tool("start_mission", { intent: "continue", requirements: ["Maintain both test trees"] });
    // Other scoped inventories are fixture-only; they exercise the bounded stream cache.
    for (const scope of pressure) await inspectTestDebtPage(root, { read: [], write: [`${scope}/**`], validation: [] }, [], { cacheKey: scope });
    const result = await tool("plan_units", plan("flat", index));
    foundFlat ||= (result.test_debt_audit?.signals ?? []).some((signal: { path: string }) => signal.path === "flat/later.test.mjs");
  }
  assert.ok(foundFlat, "a test beyond a 2048-entry page is eventually scheduled despite cancellation and stream-cache pressure");
  for (const scope of pressure) await closeTestDebtInventory(scope);
  await tool("plan_units", plan("nested", 10));
  const cursors = Object.values((await mission.required("root")).testDebtInventory!.cursors);
  assert.ok(cursors.some(cursor => cursor.frames.some(frame => frame.path.startsWith("nested"))),
    "the directory cap also retains a continuation");
  await writeFile(join(nested, "dir-139", "later.test.mjs"), text);
  let foundNested = false;
  for (let index = 11; index <= 15; index++) {
    const result = await tool("plan_units", plan("nested", index));
    foundNested ||= (result.test_debt_audit?.signals ?? []).some((signal: { path: string }) => signal.path === "nested/test/dir-139/later.test.mjs");
  }
  assert.ok(foundNested, "a test after the 128-directory page is eventually scheduled");
  await tool("cancel_operator", { reason: "End this isolated fixture" });
}));

test("prepared Mission retains the original inventory page across registration and replan failures", async t => fixture(async root => {
  await mkdir(join(root, "test"));
  const text = "assert.equal(1, 1);\nassert.equal(1, 1);\n";
  for (let index = 0; index < 24; index++) await writeFile(join(root, "test", `${index}.test.mjs`), text);
  await writeFile(join(root, "check.mjs"), "console.log('check');\n");
  const create = () => SortieDogsV010Plugin({ directory: root, client: { session: {
    get: async () => ({ data: { id: "root", agent: "dog-operator" } }),
    children: async () => ({ data: [] }), messages: async () => ({ data: [] }),
  } } } as never);
  let hooks = await create();
  const tool = async (name: string, args = {}) => JSON.parse(await hooks.tool![`sortie_v010_${name}`]!.execute(args, { sessionID: "root" }));
  await hooks["chat.message"]!({ sessionID: "root", messageID: "request", agent: "dog-operator" }, {
    message: { id: "request", agent: "dog-operator", model: { providerID: "openai", modelID: "fixture" } },
    parts: [{ type: "text", text: "Maintain the test suite." }],
  });
  await tool("start_mission", { requirements: ["Maintain the test suite"] });
  const plan = { units: [{ title: "Maintain tests", objective: "Maintain tests", read: ["check.mjs"],
    write: ["test/**"], validation: ["node check.mjs"] }] };
  const update = OperatorMissionRuntime.prototype.update;
  let injected = false;
  t.mock.method(OperatorMissionRuntime.prototype, "update", function (this: OperatorMissionRuntime, id: string, change: Parameters<typeof update>[1]) {
    return update.call(this, id, state => {
      const before = state.runID;
      change(state);
      if (!injected && before !== state.runID) { injected = true; throw new Error("injected inventory binding failure"); }
    });
  });
  await assert.rejects(tool("plan_units", plan), /injected inventory binding failure/);
  t.mock.restoreAll();
  const operators = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const prepared = await operators.required("root");
  const handoff = JSON.parse(await readFile(prepared.units[0]!.handoffPath, "utf8"));
  const expected = handoff.ext["sortie-dogs/mission-context"].test_debt_audit.signals;
  assert.equal(expected.length, 16);
  t.mock.method(OperatorRuntime.prototype, "replanMission", async () => { throw new Error("injected replan failure"); });
  await assert.rejects(tool("plan_units", { ...plan, units: [{ ...plan.units[0], title: "Other proposal" }], reason: "Try a correction" }), /injected replan failure/);
  t.mock.restoreAll();
  hooks = await create();
  await tool("plan_units", plan);
  const mission = await new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE).required("root");
  const registered = mission.testDebtSignals!.filter(signal => signal.run_id === prepared.runID);
  assert.deepEqual(registered.map(({ run_id: _run, ...signal }) => signal), expected,
    "the exact original handoff, not the failed proposal's page, is registered");
  assert.equal((await operators.required("root")).runID, prepared.runID);
  assert.equal(mission.testDebtInventory!.pending, undefined);
}));

test("a newly edited test can schedule audit once without treating repeated assertions as proof", async () => fixture(async root => {
  await mkdir(join(root, "test"));
  const history: unknown[] = [], check = join(root, "test", "new.test.mjs");
  const shellCheck = join(root, "test", "shell.test.mjs");
  const text = 'import assert from "node:assert/strict";\nassert.equal(1, 1);\nassert.equal(1, 1);\n';
  await writeFile(join(root, "seed.mjs"), text);
  const identities: Record<string, { agent: string; parentID?: string }> = { root: { agent: "dog-operator" } };
  const hooks = await SortieDogsV010Plugin({ directory: root, client: { session: {
    get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...identities[path.id] } }),
    children: async ({ path }: { path: { id: string } }) => ({ data: Object.entries(identities)
      .filter(([, identity]) => identity.parentID === path.id).map(([id, identity]) => ({ id, ...identity })) }),
    messages: async () => ({ data: history }),
  } } } as never);
  const tool = async (name: string, args = {}) => JSON.parse(await hooks.tool![`sortie_v010_${name}`]!.execute(args, { sessionID: "root" }));
  await hooks["chat.message"]!({ sessionID: "root", messageID: "request", agent: "dog-operator" }, {
    message: { id: "request", agent: "dog-operator", model: { providerID: "openai", modelID: "fixture" } },
    parts: [{ type: "text", text: "Add a check" }],
  });
  await tool("start_mission", { requirements: ["Add a check"] });
  const started = await tool("plan_units", { executor: "self", units: [{ title: "Add check", objective: "Add the check",
    read: ["seed.mjs"], write: ["test/new.test.mjs", "test/shell.test.mjs", "test/failing-shell.test.mjs", "test/errored-shell.test.mjs", "test/no-output-shell.test.mjs"], validation: ["node test/new.test.mjs"] }] });
  assert.equal(started.test_debt_audit, undefined);
  const initialUnit = (await new OperatorRuntime(root, V010_RUNTIME_PROFILE).required("root")).units[0]!;
  const initialHandoff = await readFile(initialUnit.handoffPath, "utf8");
  const args = { filePath: check, content: text }, request = { tool: "write", sessionID: "root", callID: "write-check" };
  await hooks["tool.execute.before"]!(request, { args });
  await writeFile(check, text);
  const output = { output: "written" };
  await hooks["tool.execute.after"]!({ ...request, args }, output);
  assert.match(output.output, /SORTIE_TEST_DEBT_AUDIT/);
  assert.match(output.output, /similar lines or size alone do not establish redundancy/);
  assert.equal(await readFile(check, "utf8"), text, "inventory must not edit or delete the author's test");
  const cold = new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE);
  assert.equal((await cold.required("root")).testDebtSignals?.[0]?.trigger, "observed-change");
  const again = { output: "written" };
  await hooks["tool.execute.after"]!({ ...request, args }, again);
  assert.doesNotMatch(again.output, /SORTIE_TEST_DEBT_AUDIT/);
  const shellArgs = { command: "cp seed.mjs test/shell.test.mjs", workdir: root };
  const shellRequest = { tool: "shell", sessionID: "root", callID: "shell-check" };
  await hooks["tool.execute.before"]!(shellRequest, { args: shellArgs });
  await promisify(execFile)("cp", ["seed.mjs", "test/shell.test.mjs"], { cwd: root });
  const shellOutput = { output: "", metadata: { exit: 0, status: "completed" } };
  await hooks["tool.execute.after"]!({ ...shellRequest, args: shellArgs }, shellOutput);
  assert.match(shellOutput.output, /SORTIE_TEST_DEBT_AUDIT/);
  assert.equal(await readFile(shellCheck, "utf8"), text, "inventory never changes a shell-written test");
  assert.ok((await cold.required("root")).testDebtSignals?.some(signal => signal.path === "test/shell.test.mjs"));
  const failedArgs = { command: "cp seed.mjs test/failing-shell.test.mjs && false", workdir: root };
  const failedRequest = { tool: "shell", sessionID: "root", callID: "failed-shell-check" };
  await hooks["tool.execute.before"]!(failedRequest, { args: failedArgs });
  await assert.rejects(promisify(execFile)("sh", ["-c", failedArgs.command], { cwd: root }));
  const failedOutput = { output: "", metadata: { exit: 1, status: "completed" } };
  await hooks["tool.execute.after"]!({ ...failedRequest, args: failedArgs }, failedOutput);
  assert.match(failedOutput.output, /SORTIE_TEST_DEBT_AUDIT/, "a failed shell can still leave a changed test");
  assert.ok((await cold.required("root")).testDebtSignals?.some(signal => signal.path === "test/failing-shell.test.mjs"));
  const erroredArgs = { command: "cp seed.mjs test/errored-shell.test.mjs && false", workdir: root };
  const erroredRequest = { tool: "shell", sessionID: "root", callID: "errored-shell-check" };
  await hooks["tool.execute.before"]!(erroredRequest, { args: erroredArgs });
  await assert.rejects(promisify(execFile)("sh", ["-c", erroredArgs.command], { cwd: root }));
  const noExit = { status: "error", output: "execution interrupted", metadata: {} };
  await hooks["tool.execute.after"]!({ ...erroredRequest, args: erroredArgs }, noExit);
  assert.doesNotMatch(noExit.output, /SORTIE_TEST_DEBT_AUDIT/, "an error without terminal exit is not a completed shell");
  const pending = { status: "error", output: "execution pending", metadata: { exit: 1, status: "pending" } };
  await hooks["tool.execute.after"]!({ ...erroredRequest, args: erroredArgs }, pending);
  assert.doesNotMatch(pending.output, /SORTIE_TEST_DEBT_AUDIT/, "a pending result is not a terminal shell");
  const erroredOutput = { status: "error", output: "command failed", metadata: { exit: 1, status: "completed" } };
  await hooks["tool.execute.after"]!({ ...erroredRequest, args: erroredArgs }, erroredOutput);
  assert.match(erroredOutput.output, /SORTIE_TEST_DEBT_AUDIT/, "native error status does not erase a terminal shell's changes");
  assert.equal(erroredOutput.status, "error", "audit notification must not turn the failure into success");
  assert.equal(erroredOutput.metadata.exit, 1);
  assert.equal(await readFile(join(root, "test", "errored-shell.test.mjs"), "utf8"), text);
  assert.ok((await cold.required("root")).testDebtSignals?.some(signal => signal.path === "test/errored-shell.test.mjs"));
  const noOutputArgs = { command: "cp seed.mjs test/no-output-shell.test.mjs && false", workdir: root };
  const noOutputRequest = { tool: "shell", sessionID: "root", callID: "no-output-shell-check" };
  await hooks["tool.execute.before"]!(noOutputRequest, { args: noOutputArgs });
  await assert.rejects(promisify(execFile)("sh", ["-c", noOutputArgs.command], { cwd: root }));
  const noOutput = { status: "error", metadata: { exit: 1, status: "completed" } };
  await hooks["tool.execute.after"]!({ ...noOutputRequest, args: noOutputArgs }, noOutput);
  assert.ok((await cold.required("root")).testDebtSignals?.some(signal => signal.path === "test/no-output-shell.test.mjs"),
    "a terminal error without a text result still retains the scheduling signal");
  assert.equal(noOutput.status, "error");
  assert.equal(noOutput.metadata.exit, 1);
  assert.equal("output" in noOutput, false, "recording must not fabricate a native result");
  const yielded = await tool("plan_units", { executor: "worker", handoff_context: "Continue the same requested check." });
  assert.ok(yielded.task, JSON.stringify(yielded));
  const continued = (await new OperatorRuntime(root, V010_RUNTIME_PROFILE).required("root")).units[0]!;
  assert.equal(await readFile(continued.handoffPath, "utf8"), initialHandoff, "the frozen controls are byte-for-byte unchanged");
  const frozen = JSON.parse(initialHandoff);
  assert.equal(frozen.ext["sortie-dogs/mission-context"].test_debt_audit, undefined, "the original controls stay immutable");
  identities.worker = { agent: "dog-worker-v010", parentID: "root" };
  const dispatched = { args: structuredClone(yielded.task) };
  await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "worker-task" }, dispatched);
  const workerChat = { message: { id: "worker-request", agent: "dog-worker-v010", model: { providerID: "openai", modelID: "fixture" } },
    parts: [{ type: "text", text: dispatched.args.prompt }] };
  await hooks["chat.message"]!({ sessionID: "worker", messageID: "worker-request", agent: "dog-worker-v010" }, workerChat);
  const continuation = JSON.parse(/^direct_handoff: (.+)$/mu.exec(workerChat.parts[0]!.text)![1]!);
  assert.ok(continuation.test_debt_audit.signals.some((signal: { path: string }) => signal.path === "test/errored-shell.test.mjs"),
    "the admitted Worker's continuation receives a signal discovered after planning");
  assert.ok(continuation.test_debt_audit.signals.some((signal: { path: string }) => signal.path === "test/no-output-shell.test.mjs"));
  assert.ok(continuation.test_debt_audit.signals.every((signal: { unit_id: string }) => signal.unit_id === continued.unit.id));
  assert.match(continuation.test_debt_audit.instruction, /not established as complete/);
  assert.match(continuation.test_debt_audit.instruction, /already.*(?:assessed|handled)/i);
  assert.equal(continuation.unit_id, continued.unit.id);
  const large = join(root, "test", "large.test.mjs");
  await writeFile(large, "x".repeat(512 * 1024 + 1));
  const largeSignals = await inspectTestDebt(root, { read: [large], write: [], validation: [] });
  assert.deepEqual(largeSignals[0]!.reasons, ["large-test-file"]);
  assert.equal(largeSignals[0]!.lines, null, "large files are signaled without claiming a full inventory");
  assert.equal(largeSignals[0]!.sha256, null);
  const other = join(root, "other");
  await mkdir(join(other, "test"), { recursive: true });
  await writeFile(join(other, "test", "new.test.mjs"), text);
  const unit = { read: [], write: [], validation: ["node   test/new.test.mjs"],
    validation_cwd: { "node test/new.test.mjs": other } };
  assert.equal((await inspectTestDebt(root, unit))[0]!.path, "other/test/new.test.mjs");
  assert.equal((await inspectTestDebt(root, { ...unit, validation_cwd: { "node test/new.test.mjs": root } }))[0]!.path,
    "test/new.test.mjs", "each inspection uses the current registered cwd, not an earlier setting");
  await mkdir(join(root, "test", "nested"));
  await writeFile(join(root, "test", "nested", "nested.test.mjs"), text);
  await mkdir(join(root, "test", "node_modules"));
  await writeFile(join(root, "test", "node_modules", "dependency.test.mjs"), text);
  const hiddenDirectory = join(root, "test", ".opencode"), hiddenTest = join(hiddenDirectory, "private.test.mjs");
  await mkdir(hiddenDirectory);
  await writeFile(hiddenTest, text);
  await writeFile(join(root, "test", ".state.test.mjs"), text);
  await symlink(other, join(root, "test", "link"), process.platform === "win32" ? "junction" : "dir");
  await symlink(join(root, ".."), join(root, "test", "linked-outside"), process.platform === "win32" ? "junction" : "dir");
  const globbed = await inspectTestDebt(root, { read: [], write: ["test/**"], validation: [] });
  assert.deepEqual(globbed.map(signal => signal.path).sort(), ["test/errored-shell.test.mjs", "test/failing-shell.test.mjs", "test/large.test.mjs", "test/nested/nested.test.mjs", "test/new.test.mjs", "test/no-output-shell.test.mjs", "test/shell.test.mjs"]);
  assert.deepEqual(await inspectTestDebt(root, { read: [], write: ["test/link/**"], validation: [] }), [],
    "a scope starting through a link must not traverse even an in-project target");
  assert.deepEqual(await inspectTestDebt(root, { read: [], write: ["test/.opencode/**"], validation: [] }), [],
    "an automatic inventory must not start inside a hidden directory");
  assert.deepEqual((await inspectTestDebt(root, { read: [hiddenTest], write: [], validation: [] })).map(signal => signal.path),
    ["test/.opencode/private.test.mjs"], "an explicit file input retains the pre-existing opt-in behavior");
  assert.deepEqual(await inspectTestDebt(root, { read: [], write: ["test/*.test.mjs"], validation: [] }), [],
    "unsupported shell patterns do not become wider host write scopes");
  assert.deepEqual(await inspectTestDebt(root, { read: [], write: [], validation: ["npm test"] }), [],
    "a script name alone does not implicitly expand the test directory");
  const scoped = await inspectTestDebt(root, { read: [], write: [join(root, "other", "test", "**")], validation: [] });
  assert.deepEqual(scoped.map(signal => signal.path), ["other/test/new.test.mjs"]);
  const globCwd = { read: [], write: [], validation: ["node test/**"], validation_cwd: { "node test/**": other } };
  assert.deepEqual((await inspectTestDebt(root, globCwd)).map(signal => signal.path), ["other/test/new.test.mjs"]);
  assert.deepEqual((await inspectTestDebt(root, { ...globCwd, validation_cwd: { "node test/**": root } })).map(signal => signal.path).sort(),
    globbed.map(signal => signal.path).sort(), "glob inventory uses the current validation cwd");
  for (let index = 0; index < 20; index++) await writeFile(join(root, "test", `bounded-${index}.test.mjs`), text);
  assert.ok((await inspectTestDebt(root, { read: [], write: ["test/**"], validation: [] })).length <= 16);
}));

test("Worker acceptance observations use each saved admission and cwd, including historical units", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE), operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  const commands = ["node first.mjs", "node /fixture/second.mjs"], oldCwd = resolve(directory, "../old-checkout"), currentCwd = resolve(directory, "../current-checkout");
  const queries: any[] = [];
  let native: any[] = [];
  const createHooks = () => SortieDogsV010Plugin({ directory, client: { session: {
    get: async ({ path }: any) => ({ data: { id: path.id, agent: path.id === "root" ? "dog-operator" : "dogs-coordinator",
      ...(path.id === "root" ? {} : { parentID: "root" }) } }),
    reviewMessages: async ({ query }: any) => { queries.push(query); return { data: native }; },
    children: async () => ({ data: [] }),
  } } } as never);
  const hooks = await createHooks();
  await hooks["chat.message"]!({ sessionID: "root", messageID: "request", agent: "dog-operator" }, {
    message: { id: "request", agent: "dog-operator", model: { providerID: "openai", modelID: "fixture" } },
    parts: [{ type: "text", text: "Run both checks in their registered checkout" }],
  });
  await hooks.tool!.sortie_v010_start_mission.execute({ requirements: ["Run both checks"] }, { sessionID: "root" });
  const mission = await missions.required("root");
  const old = await operators.prepareMission("root", missionPlan(mission, [{ title: "Verify", objective: "Run both checks",
    read: [], write: [], validation: commands, validation_cwd: Object.fromEntries(commands.map(command => [command, oldCwd])) }], directory));
  const oldUnit = old.units[0]!;
  oldUnit.status = "succeeded"; oldUnit.childSessionID = "worker"; oldUnit.evidence = [];
  oldUnit.validationRegistration = { validation: commands, cwd: Object.fromEntries(commands.map(command => [command, oldCwd])),
    startedAt: new Date(1000).toISOString(), registeredAt: {}, checks: [] };
  const archive = join(directory, V010_RUNTIME_PROFILE.stateDirectory, "operators",
    `${createHash("sha256").update("root").digest("hex")}.json.${old.runID}.${old.sequence}.archive`);
  await writeFile(archive, JSON.stringify(old));
  const taskID = oldUnit.task.prompt.match(/^task_id: (.+)$/m)![1]!;
  const current = { ...old, runID: "current-run", parentRunID: old.runID,
    priorAcceptedUnits: [{ taskID, handoffPath: oldUnit.handoffPath, handoffHash: oldUnit.hashes[0]! }],
    units: [{ ...oldUnit, status: "failed" as const, validationRegistration: { validation: commands,
      cwd: Object.fromEntries(commands.map(command => [command, currentCwd])), startedAt: new Date(3000).toISOString(), registeredAt: {}, checks: [] } }] };
  mission.runID = current.runID; mission.attempts = [{ runID: old.runID } as never, { runID: current.runID } as never];
  const part = (command: string, workdir: string, ran: number, exit: number) => ({ type: "tool", tool: "shell",
    time: { ran, completed: ran + 5 }, state: { status: "completed", input: { command, workdir }, metadata: { exit } } });
  native = [{ info: { role: "assistant", sessionID: "worker" }, parts: [
    part(commands[0]!, currentCwd, 900, 0), part(commands[0]!, oldCwd, 1100, 0), part(commands[1]!, directory, 1110, 0),
    part(commands[0]!, currentCwd, 3100, 0), part(commands[1]!, directory, 3110, 0), part(commands[1]!, currentCwd, 3120, 1),
  ] }];
  const contexts: unknown[] = [];
  const summary = await missionAcceptanceSummary(mission, current, operators, async (validation, child, notBefore, root, cwd) => {
    contexts.push({ child, notBefore, root, cwd });
    return observedMissionValidationSummary(validation, child!, async () => ({ data: native }), notBefore, root, cwd);
  });
  assert.deepEqual(contexts, [
    { child: "worker", notBefore: 3000, root: directory, cwd: current.units[0]!.validationRegistration.cwd },
    { child: "worker", notBefore: 1000, root: directory, cwd: oldUnit.validationRegistration.cwd },
  ], "the old unit must not borrow the active owner's registration");
  const observations = summary.native_declared_validation as any[];
  assert.deepEqual(observations[0].observations.commands.map((item: any) => [item.command, item.exit_code, item.directory]),
    [[commands[0], 0, currentCwd], [commands[1], 1, currentCwd]], "wrong cwd and old admission cannot hide the actual failure");
  assert.deepEqual(observations[1].observations.commands.map((item: any) => [item.command, item.exit_code, item.directory]),
    [[commands[0], 0, oldCwd]], "a registered external cwd is valid in its own historical unit");
  assert.deepEqual(observations[1].observations.not_observed, [commands[1]]);
  assert.deepEqual(summary.formal_validation, [], "native outcomes do not create or rewrite formal evidence");

  const unstarted = { ...current, units: [{ ...current.units[0]!, childSessionID: null, status: "pending" as const }] };
  const pending = await missionAcceptanceSummary(mission, unstarted, operators, async () => { throw new Error("must not read"); });
  assert.equal((pending.native_declared_validation as any[])[0].status, "unavailable");
  const legacy = { ...current, units: [{ ...current.units[0]!, validationRegistration: { ...current.units[0]!.validationRegistration, startedAt: undefined } }] };
  const legacySummary = await missionAcceptanceSummary(mission, legacy, operators, async (validation, child, notBefore, root, cwd) => {
    if (cwd?.[commands[0]!] === currentCwd) assert.equal(notBefore, undefined, "an absent legacy admission is not invented");
    return observedMissionValidationSummary(validation, child!, async () => ({ data: native }), notBefore, root, cwd);
  });
  const legacyCurrent = (legacySummary.native_declared_validation as any[])[0].observations;
  assert(legacyCurrent.commands.every((item: any) => item.directory === currentCwd), "cwd is enforced even without an admission timestamp");
  for (const execution of [
    { directExecution: { actor: "worker", startedAt: new Date(3000).toISOString(), checks: [] } },
    { reviewerCorrection: { author: "worker", reviewIdentity: "review", writeUnion: [], admittedAt: new Date(3000).toISOString() } },
  ]) {
    const run = { ...current, units: [{ ...current.units[0]!, ...execution }] };
    const result = await missionAcceptanceSummary(mission, run, operators, async (validation, child, notBefore, root, cwd) =>
      observedMissionValidationSummary(validation, child!, async () => ({ data: native }), notBefore, root, cwd));
    assert.deepEqual((result.native_declared_validation as any[])[0].observations, observations[0].observations,
      "direct and Reviewer correction preserve the same registered cwd and admission semantics");
  }

  // Exercise the real status caller as well as the core projection; the two runs
  // intentionally share a native session so an active-owner lookup is incorrect.
  await writeFile(operators.statePath("root"), JSON.stringify(current));
  await missions.update("root", item => { item.runID = current.runID; item.attempts = mission.attempts; item.coordinator = "coordinator"; item.phase = "running"; });
  queries.length = 0;
  const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({ view: "full" }, { sessionID: "coordinator" }));
  assert.deepEqual(status.acceptance_summary.native_declared_validation.map((item: any) => item.observations),
    observations.map(item => item.observations), "status must carry each stored unit's actual binding to the native reader");
  assert.deepEqual(queries.map(query => query.notBefore), [new Date(3000).toISOString(), new Date(1000).toISOString()]);

  const dockerCommand = "node /app/verify.mjs";
  const dockerRun = { ...current, parentRunID: undefined, priorAcceptedUnits: [], units: [{ ...current.units[0]!,
    unit: { ...current.units[0]!.unit, validation: [dockerCommand] }, validationRegistration: {
      validation: [dockerCommand], cwd: { [dockerCommand]: "/app" }, startedAt: new Date(3000).toISOString(), registeredAt: {}, checks: [] } }] };
  const docker = (tool: string, exit: number | null, ran: number) => ({ type: "tool", tool, time: { ran, completed: ran + 5 }, state: {
    status: "completed", input: tool === "execute" ? { code: "return await tools.fh.docker_exec(...)" } : { command: dockerCommand },
    output: `exit_code=${exit ?? "unknown"}\nresult\n`, metadata: tool === "execute"
      ? { toolCalls: [{ tool: "fh.docker_exec", status: "completed", input: { command: dockerCommand } }] } : {} } });
  native = [{ info: { role: "assistant", sessionID: "worker" }, parts: [
    docker("execute", 7, 2900), part(dockerCommand, directory, 3100, 0), part(dockerCommand, "/app", 3110, 1),
    ...["fh_docker_exec", "fh.docker_exec", "execute"].flatMap((tool, index) => [0, 7, null].map((exit, member) =>
      docker(tool, exit, 3120 + (index * 3 + member) * 10))),
  ] }];
  await writeFile(operators.statePath("root"), JSON.stringify(dockerRun));
  const dockerHooks = await createHooks();
  await dockerHooks["chat.message"]!({ sessionID: "root", messageID: "resume", agent: "dog-operator" }, {
    message: { id: "resume", agent: "dog-operator", model: { providerID: "openai", modelID: "fixture" } },
    parts: [{ type: "text", text: "Inspect the existing native Docker outcomes without rerunning them" }],
  });
  const dockerStatus = JSON.parse(await dockerHooks.tool!.sortie_v010_operator_status.execute({ view: "full" }, { sessionID: "coordinator" }));
  const diagnostics = dockerStatus.acceptance_summary.native_declared_validation[0].observations;
  assert.deepEqual(diagnostics.commands.map((item: any) => [item.exit_code, item.directory, item.directory_status, item.observed_attempts]), [
    [1, "/app", undefined, 1], [0, undefined, "unobserved", 3], [7, undefined, "unobserved", 3], [null, undefined, "unobserved", 3],
  ], "status preserves unknown-cwd Docker exits, but excludes wrong known cwd and pre-admission calls");
  assert.deepEqual(diagnostics.not_observed, []);
  assert.deepEqual(dockerStatus.acceptance_summary.formal_validation, [], "unbound Docker diagnostics never create formal proof");
  for (const execution of [
    { directExecution: { actor: "worker", startedAt: new Date(3000).toISOString(), checks: [] } },
    { reviewerCorrection: { author: "worker", reviewIdentity: "review", writeUnion: [], admittedAt: new Date(3000).toISOString() } },
  ]) {
    const boundRun = { ...dockerRun, units: [{ ...dockerRun.units[0]!, ...execution }] };
    const bound = await missionAcceptanceSummary(mission, boundRun, operators, async (validation, child, notBefore, root, cwd, includeUnobserved) =>
      observedMissionValidationSummary(validation, child!, async () => ({ data: native }), notBefore, root, cwd, includeUnobserved));
    assert.deepEqual((bound.native_declared_validation as any[])[0].observations.commands.map((item: any) => [item.exit_code, item.directory]),
      [[1, "/app"]], "direct and Reviewer diagnostics retain their existing explicit-cwd contract");
  }
}));

test("compaction model views retain captured mission evidence references without copying snapshot paths", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  const operators = new OperatorRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "original-with-attachment", text: "Fix the result; preserve the original attachment and unmet requirements." });
  const started = await missions.start("root", ["Fix the result", "Preserve the original attachment and unmet requirements"]);
  const run = await operators.prepareMission("root", missionPlan(started, [unit]));
  const paths = Array.from({ length: 10_000 }, (_, index) => `generated/protected/${index}/${"x".repeat(90)}.txt`);
  const evidence = { evidence_id: "proof-1", identity: { source: "source-hash", candidate: "candidate-hash", fixture: "fixture" },
    execution: { command: ["node check.mjs"], exit_code: 1, outcome: "fail", started_at: "start", ended_at: "end", units: ["unit-1"] },
    proof_scope: "requested-full", protected_binding: { manifest_path: "fixture-manifest.json", manifest_hash: "manifest-hash",
      source_policy: "declared-paths-v1", source_paths: paths, candidate_paths: [],
      freshness: { protected_paths: paths, scratch_paths: [], environment: { NODE: "fixture" } } } };
  run.units[0]!.evidence = [evidence as never];
  const check = { callID: "check", dispatchCallID: "dispatch", childSessionID: "worker", command: ["node check.mjs"],
    startedAt: "start", endedAt: "end", exitCode: 1, source: "source-hash", candidate: "candidate-hash", fresh: false,
    binding: evidence.protected_binding };
  run.units[0]!.directExecution = { actor: "coordinator", startedAt: "start", checks: [check as never] };
  run.units[0]!.reviewerCorrection = { author: "worker", reviewIdentity: "review", writeUnion: ["src"], checks: [check as never] };
  run.units[0]!.validationRegistration = { validation: ["node check.mjs"], cwd: {}, registeredAt: {}, checks: [check as never] };
  run.units[0]!.directHandoffs = [{ actor: "coordinator", startedAt: "start", callID: "handoff", handedOffAt: "end", checks: [check as never] }];
  run.units[0]!.status = "failed";
  run.units[0]!.childSessionID = "worker";
  run.phase = "awaiting-decision";
  await writeFile(operators.statePath("root"), JSON.stringify(run));
  const mission = await missions.update("root", item => { item.runID = run.runID; item.coordinator = "coordinator"; item.phase = "running"; });
  const before = await readFile(operators.statePath("root"), "utf8");
  assert.ok(Buffer.byteLength(before) > 1024 * 1024, "the cold persisted execution exceeds the former size limit");
  const hooks = await SortieDogsV010Plugin({ directory, client: { session: {
    get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id,
      agent: path.id === "root" ? "dog-operator" : "dogs-coordinator", ...(path.id === "root" ? {} : { parentID: "root" }) } }),
    messages: async () => ({ data: [] }), children: async () => ({ data: [] }),
  } } } as never);
  const raw = missionPacket(mission, run, false) as any;
  for (const [sessionID, prefix, suffix] of [
    ["root", "Durable registered operator checkpoint: ", ". This reference, not summary prose, selects current work."],
    ["coordinator", "Mission continuation: ", ". Continue in this same Coordinator."],
  ]) {
    const output: { context?: string[]; prompt?: string } = {};
    await hooks["experimental.session.compacting"]!({ sessionID }, output);
    const text = output.context!.find(item => item.startsWith(prefix))!;
    assert.ok(text, `missing ${sessionID} checkpoint`);
    const projected = JSON.parse(text.slice(prefix.length, text.indexOf(suffix, prefix.length)));
    assert.ok(text.length < JSON.stringify(raw).length / 10, `${sessionID}: the snapshot recipe is not model context`);
    assert.deepEqual(projected.requirements, raw.requirements);
    assert.deepEqual(projected.original_request_refs, ["user:original-with-attachment"]);
    assert.equal(projected.next_action, raw.next_action);
    assert.equal(projected.units[0].status, "failed");
    assert.equal(projected.units[0].child_session_id, "worker");
    const { protected_binding: _binding, ...measured } = evidence;
    assert.deepEqual(projected.units[0].evidence[0], { ...measured,
      protected_binding_ref: { manifest_path: "fixture-manifest.json", manifest_hash: "manifest-hash", source_policy: "declared-paths-v1" } },
      "command, failure, proof identity and coverage remain exactly as measured");
    assert.equal(projected.units[0].evidence_details_ref.path, operators.statePath("root"));
    assert.equal(projected.units[0].evidence_details_ref.run_id, run.runID);
    assert.equal(projected.units[0].evidence_details_ref.unit_id, "unit-1");
  }
  const v2Hooks = new Map<string, (event: any) => Promise<void>>(), storage = new Map<string, unknown>();
  const v2 = { location: { directory }, options: {}, app: { version: "2.2.5" },
    storage: { get: async (key: string) => structuredClone(storage.get(key)),
      set: async (key: string, value: unknown) => { storage.set(key, structuredClone(value)); } },
    event: { subscribe: async function* () {} },
    tool: { transform: async () => ({ dispose() {} }), hook: async () => ({ dispose() {} }) },
    permission: { hook: async () => ({ dispose() {} }) },
    session: { get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID,
      agent: sessionID === "root" ? "dog-operator" : "dogs-coordinator", ...(sessionID === "root" ? {} : { parentID: "root" }) }),
      context: async () => [],
      hook: async (name: string, callback: (event: any) => Promise<void>) => { v2Hooks.set(name, callback); return { dispose() {} }; } },
  } as never;
  const cleanup = await createSortieDogsV2Plugin(SortieDogsV010Plugin).setup(v2);
  try {
    const event = { sessionID: "root", agent: "dog-operator", messages: [], system: [] as any[], tools: {} };
    await v2Hooks.get("compaction")!(event);
    const text = event.system.find(item => item.text.startsWith("Durable registered operator checkpoint: "))?.text as string;
    assert.ok(text && text.length < JSON.stringify(raw).length / 10, "the public V2 compaction hook receives the compact checkpoint");
    assert.match(text, /proof-1/);
    assert.doesNotMatch(text, /generated\/protected\/0\//);
  } finally { cleanup?.(); }
  assert.equal(await readFile(operators.statePath("root"), "utf8"), before, "compaction must not rewrite evidence or freshness");
  const loaded = await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root");
  assert.deepEqual(loaded.units[0]!.evidence, [evidence], "cold recovery retains the complete freshness recipe");
  assert.deepEqual(loaded.units[0]!.directExecution!.checks, [check]);
  assert.deepEqual(loaded.units[0]!.reviewerCorrection!.checks, [check]);
  assert.deepEqual(loaded.units[0]!.validationRegistration!.checks, [check]);
  assert.deepEqual(loaded.units[0]!.directHandoffs![0]!.checks, [check]);
  const invalid = { ...run, decision: "x".repeat(1024 * 1024 + 1) };
  await writeFile(operators.statePath("root"), JSON.stringify(invalid));
  await assert.rejects(new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root"), /operator-state-too-large/,
    "oversized non-snapshot execution fields still receive the existing error");
}));

test("Operator strategy distinguishes failed methods from required outcomes without adding an approval ritual", () => {
  const policy = missionOperatorContent(V010_RUNTIME_PROFILE, "test");
  assert.match(policy, /Own strategy, not just the relay of a stopped author's reply/u);
  assert.match(policy, /Continue planned useful work without\s+intervention; suppress unnecessary expansion/u);
  assert.match(policy, /Separate a required outcome\/check from an AI-selected method/u);
  assert.match(policy, /already registered as\s+formal validation still needs lawful recipe correction or replanning/u);
  assert.match(policy, /give the existing author the concrete alternative, rationale and\s+retained obligations/u);
  assert.match(policy, /plan_units with proposed\s+units, reason and handoff_context/u);
  assert.match(policy, /Do not restart a release, cancel live work or take over implementation/u);
  assert.match(policy, /Ordinary implementation decisions remain with the author; no per-Task approval/u);
});

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
  assert.match(worker, /Pre-change oracles, not new tests/u);
  assert.match(worker, /check result\/error\/state/u);
  assert.match(worker, /No exhaustive matrix/u);
  assert.match(worker, /no tee\/redirect\/wrapper/u);
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
  const task = (await operators.next("root", "root") as { task: { prompt: string; subagent_type: string } }).task;
  assert.equal(task.subagent_type, "dog-worker-v010");
  assert.match(worker, /Compare existing tests: inputs, boundaries, assertions, failures; reuse if enough; retain coverage/u,
    "the ordinary implementation Worker receives the test-value guidance");
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
  await operators.admitWorker("root", "coordinator", "worker-call", { ...next.task, description: "Fix the result" });
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

function terminalHistory(reviewerCorrection = false, rootDispatched = false) {
  const correction = { author: "worker", reviewIdentity: "prior-review", writeUnion: ["src/**"] };
  const previous = { operatorSessionID: rootDispatched ? null : "coordinator", units: [{ childSessionID: "worker",
    ...(reviewerCorrection ? { reviewerCorrection: correction } : {}) }] } as never;
  const sessions: Record<string, { id: string; agent: string; parentID: string; outcome?: string }> = {
    coordinator: { id: "coordinator", agent: "dogs-coordinator", parentID: "root", outcome: "succeeded" },
    worker: { id: "worker", agent: reviewerCorrection ? "dog-reviewer-v010" : "dog-worker-v010",
      parentID: rootDispatched ? "root" : "coordinator", outcome: "succeeded" },
    prior: { id: "prior", agent: "dog-worker-v010", parentID: "coordinator", outcome: "failed" },
    reviewer: { id: "reviewer", agent: "dog-reviewer-v010", parentID: "coordinator", outcome: "succeeded" },
    scout: { id: "scout", agent: "dog-scout-v010", parentID: "coordinator", outcome: "interrupted" },
  };
  const children: Record<string, { id: string }[]> = { coordinator: ["worker", "prior", "reviewer", "scout"].map(id => ({ id })) };
  return { previous, correction, sessions, children, host: { get: async (id: string) => sessions[id], children: async (id: string) => children[id] ?? [] } };
}

test("terminal mission proof accepts completed workers and settled prior consultations", async () => {
  const f = terminalHistory();
  assert.deepEqual(await terminalCancelledMissionChildren(V010_RUNTIME_PROFILE, "root", f.previous, { reserved_units: 0 }, f.host), ["worker"]);
});

test("terminal mission proof accepts a recorded Reviewer correction without inventing a successful outcome", async () => {
  const f = terminalHistory(true);
  for (const outcome of ["succeeded", "failed", "interrupted"]) {
    f.sessions.worker!.outcome = outcome;
    assert.deepEqual(await terminalCancelledMissionChildren(V010_RUNTIME_PROFILE, "root", f.previous, { reserved_units: 0 }, f.host), ["worker"]);
    assert.equal(f.sessions.worker!.outcome, outcome);
  }
  delete f.sessions.worker!.outcome;
  assert.deepEqual(await terminalCancelledMissionChildren(V010_RUNTIME_PROFILE, "root", f.previous, { reserved_units: 0 },
    { ...f.host, stopped: async id => id === "worker" }), ["worker"]);
  assert.equal(f.sessions.worker!.outcome, undefined);
  f.sessions.worker!.outcome = "running";
  await assert.rejects(terminalCancelledMissionChildren(V010_RUNTIME_PROFILE, "root", f.previous, { reserved_units: 0 },
    { ...f.host, stopped: async () => true }), /worker-not-terminal/);
});

test("terminal mission proof keeps Worker and Reviewer correction roles bound to their recorded author", async () => {
  const worker = terminalHistory();
  worker.sessions.worker!.agent = "dog-reviewer-v010";
  await assert.rejects(terminalCancelledMissionChildren(V010_RUNTIME_PROFILE, "root", worker.previous, { reserved_units: 0 }, worker.host), /worker-not-terminal/);
  const correction = terminalHistory(true);
  for (const agent of ["dog-worker-v010", "dog-luna-worker-v010", "dog-scout-v010", "dog-advisor-v010"]) {
    correction.sessions.worker!.agent = agent;
    await assert.rejects(terminalCancelledMissionChildren(V010_RUNTIME_PROFILE, "root", correction.previous, { reserved_units: 0 }, correction.host), /worker-not-terminal/, agent);
  }
  correction.sessions.worker!.agent = "dog-reviewer-v010";
  correction.correction.author = "foreign";
  await assert.rejects(terminalCancelledMissionChildren(V010_RUNTIME_PROFILE, "root", correction.previous, { reserved_units: 0 }, correction.host), /worker-not-terminal/);
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

test("operation completion requires every declared command's terminal result, not successful exits", async () => fixture(async directory => {
  const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "run", text: "Run both commands once and report their results; do not fix or retry." });
  const mission = await missions.start("root", ["Run once and collect both results"], false, { kind: "operation" });
  mission.runID = "run";
  mission.review = { runID: "run", risk: [], source: "source", task: null, verdict: "skipped-low-risk" };
  const observation = { command: "node one.mjs", directory, callID: "one", sessionID: "worker",
    startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), exit: 1, status: "completed" as const,
    ...missionCommandOutcome('{"status":"execution-failed","attempts":1}', 1, "completed") };
  mission.execution = { commands: ["node one.mjs", "node two.mjs"], directory, observations: [observation] };
  assert.equal(missionExecutionStatus(mission), "not-started", "one failure cannot hide an unstarted second command");
  const second = { ...observation, command: "node two.mjs", callID: "two" };
  mission.execution.observations.push({ ...second, completedAt: undefined });
  assert.equal(missionExecutionStatus(mission), "running");
  assert.equal((missionPacket(mission).review as { permits_submission: boolean }).permits_submission, false);
  mission.execution.observations[1] = second;
  assert.equal(missionExecutionStatus(mission), "execution-failed");
  const packet = missionPacket(mission);
  assert.equal((packet.review as { permits_submission: boolean }).permits_submission, true);
  assert.doesNotMatch(String(packet.next_action), /Continue the actual operation/u);
  mission.execution.observations[1] = { ...second, exit: 0, ...missionCommandOutcome('{"attempts":1,"reward":0}', 0, "completed") };
  assert.equal(missionExecutionStatus(mission), "execution-failed", "mixed exits keep the failure visible while both commands are terminal");
  mission.execution.observations[1] = { ...second, outcome: undefined };
  assert.equal(missionExecutionStatus(mission), "recovery-blocked", "observed unclassified legacy metadata is not never-started or a collected result");
  assert.equal((missionPacket(mission).review as { permits_submission: boolean }).permits_submission, false);
  mission.execution.observations[1] = { ...second, directory: join(directory, "other") };
  assert.equal(missionExecutionStatus(mission), "not-started", "a terminal command in another cwd is not the declared operation");
  mission.execution.observations[1] = second;
  mission.execution.observations.push({ ...second, callID: "no-start", ...missionCommandOutcome("NO_START", 0, "completed") });
  assert.equal(missionExecutionStatus(mission), "not-started");
  assert.equal((missionPacket(mission).review as { permits_submission: boolean }).permits_submission, false);
  mission.execution.commands = [];
  assert.equal(missionExecutionStatus(mission), "not-started", "empty declarations cannot vacuously count as complete");
}));

test("terminal proof for root-dispatched work does not claim unrelated root sessions", async () => {
  for (const reviewerCorrection of [false, true]) {
    const f = terminalHistory(reviewerCorrection, true);
    delete f.sessions.coordinator!.outcome;
    assert.deepEqual(await terminalCancelledMissionChildren(V010_RUNTIME_PROFILE, "root", f.previous, { reserved_units: 0 }, f.host), ["worker"]);
  }
});

test("terminal mission proof rejects active, missing and foreign native lineage", async () => {
  const changes: [string, (f: ReturnType<typeof terminalHistory>) => void][] = [
    ["active Coordinator", f => { delete f.sessions.coordinator!.outcome; }],
    ["active Worker", f => { delete f.sessions.worker!.outcome; }],
    ["active old Worker", f => { delete f.sessions.prior!.outcome; }],
    ["active Reviewer", f => { delete f.sessions.reviewer!.outcome; }],
    ["unknown outcome", f => { f.sessions.worker!.outcome = "idle"; }],
    ["foreign Coordinator", f => { f.sessions.coordinator!.parentID = "foreign"; }],
    ["foreign unit child", f => { f.sessions.worker!.parentID = "foreign"; }],
    ["foreign child", f => { f.sessions.reviewer!.parentID = "foreign"; }],
    ["foreign role", f => { f.sessions.reviewer!.agent = "build"; }],
    ["wrong child identity", f => { f.sessions.worker!.id = "other"; }],
    ["missing child", f => { delete f.sessions.worker; }],
    ["missing listing", f => { f.children.coordinator = [{ id: "reviewer" }]; }],
    ["duplicate listing", f => { f.children.coordinator!.push({ id: "worker" }); }],
    ["unproven descendant", f => { f.children.reviewer = [{ id: "nested" }]; }],
    ["unproven unit descendant", f => { f.children.worker = [{ id: "nested" }]; }],
  ];
  for (const reviewerCorrection of [false, true]) {
    for (const [name, change] of changes) {
      const f = terminalHistory(reviewerCorrection); change(f);
      await assert.rejects(terminalCancelledMissionChildren(V010_RUNTIME_PROFILE, "root", f.previous, { reserved_units: 0 }, f.host), /mission-superseded-/, name);
    }
    const f = terminalHistory(reviewerCorrection);
    await assert.rejects(terminalCancelledMissionChildren(V010_RUNTIME_PROFILE, "root", f.previous, { reserved_units: 1 }, f.host), /reservations-pending/);
  }
});
