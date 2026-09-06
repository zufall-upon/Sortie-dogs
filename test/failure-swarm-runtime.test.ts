import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { FailureSwarmRuntime, type FailureSwarmRequest } from "../dist/core/failure-swarm-runtime.js";
import { EvidenceCapsuleStore, type EvidenceCapsule } from "../dist/core/evidence-capsule.js";
import { RunFlightLedger, RunFlightLedgerError, diagnosisContractHash, type FlightObservation, type RunFlightEvent } from "../dist/core/run-flight-ledger.js";
import { compileAcceptanceCoverage } from "../dist/core/acceptance-compiler.js";
import { createExecutionPlan, executionPlanManifestFingerprint } from "../dist/core/execution-plan.js";
import { SortieDogsPlugin } from "../dist/plugin/index.js";
import { commit, fabricContract, fabricUnit, fixture, run } from "./helpers/worktree-dispatch-fixture.ts";

const roots: string[] = [];
const at = () => new Date().toISOString();
const blob = (value: Buffer | string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const observation = (): FlightObservation => ({ stage: "recovery", duration_ms: 1,
  usage: { input_tokens: null, cache_read_tokens: null, output_tokens: null, provenance: "unknown" },
  estimated_cost: { usd: null, provenance: "unknown" } });
const repairCharge = { kind: "normal_remediation", recovery_actions: 1, probe_iterations: 0, model_attempts: 1 } as const;
const validatorArgs = ["-e", "process.exit(require('node:fs').readFileSync('a.txt','utf8').trim()==='repair-a'?0:1)"];
async function validate(directory: string): Promise<number> {
  return new Promise((resolve) => execFile(process.execPath, validatorArgs, { cwd: directory }, (error) => resolve(error === null ? 0 : Number(error.code))));
}
test.after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

async function setup(name: string, recoveryLimit = 10, resources = false) {
  const value = await fixture(name); roots.push(value.root);
  await writeFile(join(value.repository, ".gitignore"), ".sortie-dogs/\n.opencode/\n");
  await run(value.repository, "add", ".gitignore"); await commit(value.repository, "-qm", "fixture controls");
  const base = (await run(value.repository, "rev-parse", "HEAD")).trim();
  const fingerprint = diagnosisContractHash([process.execPath, ...validatorArgs]);
  const store = new EvidenceCapsuleStore(join(value.repository, ".sortie-dogs", "evidence-capsules"));
  const capsule = async (unit: string): Promise<EvidenceCapsule> => ({ schema_version: "0.1", extractor_version: "fixture",
    sources: [{ path: `${unit}.txt`, blob_hash: blob(await readFile(join(value.repository, `${unit}.txt`))) }],
    acceptance_links: [{ acceptance_id: `own-${unit}` }], risks: [],
    validations: [{ command: [process.execPath, ...validatorArgs].join(" "), fingerprint }],
    provenance: { producer: "fixture", revision: base, scope_fingerprint: diagnosisContractHash({ read: [`${unit}.txt`] }) } });
  const initial = await store.put(await capsule("a"), ["a.txt"]);
  const other = await store.put(await capsule("b"), ["b.txt"]);
  const fabric = fabricContract(base, [fabricUnit("a", 0, { acceptance_items: ["own-a"], validation: { level: "targeted", command: [process.execPath, ...validatorArgs] } }),
    fabricUnit("b", 1, { acceptance_items: ["own-b"] })]);
  const compiled = compileAcceptanceCoverage({ version: "0.1",
    provenance: { producer: "dog-coordinator", acceptance_fingerprint: `sha256:${"b".repeat(64)}`, capsule_inputs_exclude_secrets: true },
    unit_ids: ["a", "b"], declared_capsule_ids: [initial.capsule_id, other.capsule_id],
    acceptance_items: ["a", "b"].map((id) => ({ acceptance_id: `own-${id}`, observable_criterion: `Repair ${id}.` })),
    validations: [initial, other].map((saved, index) => ({ validation_id: `v${index}`, unit_id: index === 0 ? "a" : "b",
      command_fingerprint: fingerprint, references: { capsule_ids: [saved.capsule_id], artifact_ids: [] } })),
    coverage: ["a", "b"].map((id, index) => ({ acceptance_id: `own-${id}`, unit_id: id, validation_ids: [`v${index}`] })) });
  assert.equal(compiled.status, "accepted");
  const plan = createExecutionPlan(compiled, fabric, executionPlanManifestFingerprint({ read: ["base.txt"], write: ["a.txt", "b.txt"] }));
  const ledgerPath = join(value.repository, ".sortie-dogs", "flight.json");
  const access = { store, declared_capsule_ids: [initial.capsule_id, other.capsule_id], authorized_source_paths: ["base.txt", "a.txt", "b.txt"] };
  let ledger = await RunFlightLedger.open(ledgerPath, access);
  await ledger.append({ kind: "run.planned", at: at(), run_id: "run", initial_candidate_id: base,
    budget_limits: { recovery_actions: recoveryLimit, probe_iterations: 10, model_attempts: 10 },
    ...(resources ? { resource_budget_limits: { time_ms: 100, cost_usd: 1 } } : {}) });
  await ledger.appendCompileResult(compiled, at());
  await ledger.append({ kind: "route.selected", at: at(), route_id: "route", candidate_id: base, role: "implementation", model: "fixture", variant: null, reason: "implementation" });
  await ledger.append({ kind: "wave.opened", at: at(), wave_id: "wave", wave_index: 1, candidate_id: base });
  await ledger.append({ kind: "unit.opened", at: at(), unit_id: "a", wave_id: "wave", candidate_id: base, references: { capsule_ids: [initial.capsule_id], artifact_ids: [] } });
  const start = (id: string, predecessor: string | null, contractID?: string): RunFlightEvent => ({ kind: "attempt.started", at: at(),
    attempt_id: id, predecessor_attempt_id: predecessor, unit_id: "a", candidate_id: base, route_id: "route", role: "implementation",
    selected_model: "fixture", selected_variant: null, child_id: null, call_id: `call-${id}`,
    budget_charge: id === "initial" ? { kind: "implementation", recovery_actions: 0, probe_iterations: 0, model_attempts: 1 } : repairCharge,
    ...(resources ? { resource_budget_request: { time_ms: 10, cost_usd: 0.125 } } : {}),
    ...(contractID === undefined ? {} : { remediation_contract_id: contractID }) });
  const finish = (id: string, code: number): RunFlightEvent => ({ kind: "attempt.finished", at: at(), attempt_id: id,
    observed_model: null, observed_variant: null, failure: code === 0 ? null : { category: "implementation", code: "fixture-validation-failed" },
    disposition: code === 0 ? "succeeded" : "continue", observation: resources ? { ...observation(), estimated_cost: { usd: 0.125, provenance: "calculated" } } : observation(), references: { capsule_ids: [], artifact_ids: [] } });
  await ledger.append(start("initial", null));
  assert.equal(await validate(value.repository), 1); await ledger.append(finish("initial", 1));
  await ledger.append(start("normal", "initial"));
  await writeFile(join(value.repository, "a.txt"), "still-broken\n");
  assert.equal(await validate(value.repository), 1); await ledger.append(finish("normal", 1));
  await ledger.append({ kind: "validation.recorded", at: at(), validation_id: "canonical-failure", unit_id: "a",
    command_fingerprint: fingerprint, result: "failed", artifact_id: null });
  const failure = await store.put(await capsule("a"), ["a.txt"]);
  ledger = await RunFlightLedger.open(ledgerPath, { ...access, declared_capsule_ids: [...access.declared_capsule_ids, failure.capsule_id] });
  const currentSources = async (paths: readonly string[]) => Promise.all(paths.map(async (path) => ({ path, blob_hash: blob(await readFile(join(value.repository, path))) })));
  const runtime = new FailureSwarmRuntime(ledger, store, plan, fabric, currentSources, "root");
  const request: FailureSwarmRequest = { run_id: "run", unit_id: "a", attempt_id: "normal", cause: "unknown",
    source_capsule_id: failure.capsule_id, causal_classes: ["configuration", "dependency"], max_lanes: 2,
    per_lane_budget_charge: { kind: "read_only_diagnosis", recovery_actions: 1, probe_iterations: 0, model_attempts: 1 }, timeout_ms: 60000,
    ...(resources ? { per_lane_resource_budget: { time_ms: 10, cost_usd: 0.125 } } : {}) };
  await mkdir(join(value.repository, ".opencode"), { recursive: true });
  await writeFile(join(value.repository, ".opencode", "sortie-dogs-execution-plan.json"), JSON.stringify(plan));
  await writeFile(join(value.repository, ".opencode", "sortie-dogs-luna-fabric.json"), JSON.stringify(fabric));
  await writeFile(join(value.repository, ".opencode", "sortie-dogs-failure-swarm.json"), JSON.stringify({ ...request, ledger_path: ".sortie-dogs/flight.json" }));
  return { ...value, base, ledger, store, runtime, request, fingerprint, currentSources, plan, fabric, start, finish };
}

test("read-only Luna diagnostics produce distinct capsules and one bounded repair without mutation or voting", async () => {
  const value = await setup("swarm");
  const beforeSource = await readFile(join(value.repository, "a.txt"));
  const planPath = join(value.repository, ".opencode", "sortie-dogs-execution-plan.json");
  const beforePlan = await readFile(planPath);
  const prompts = new Map<string, string>();
  const replies = new Map<string, string>();
  const client = { session: {
    get: async ({ path }: { path: { id: string } }) => ({ data: path.id === "root" ? { agent: "dog-coordinator" }
      : { agent: "dog-luna-worker", parentID: "root" } }),
    messages: async ({ path }: { path: { id: string } }) => ({ data: [
      { info: { role: "user" }, parts: [{ type: "text", text: prompts.get(path.id) ?? "" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: replies.get(path.id) ?? "" }] },
    ] }),
  } } as never;
  const hooks = await SortieDogsPlugin({ directory: value.repository, client });
  await hooks["chat.message"]!({ sessionID: "root", agent: "dog-coordinator" }, { message: { model: {} }, parts: [{ type: "text", text: "diagnose fixture" }] });
  const prepare = hooks.tool!.sortie_prepare_failure_swarm.execute;
  assert.equal(JSON.parse(await prepare({}, { sessionID: "foreign" })).status, "denied");
  const prepared = JSON.parse(await prepare({}, { sessionID: "root" }));
  assert.equal(prepared.status, "prepared"); assert.equal(prepared.ready.length, 2);
  assert.deepEqual(new Set(prepared.ready.map((entry: { causal_class: string }) => entry.causal_class)), new Set(["configuration", "dependency"]));
  assert.equal(JSON.parse(await prepare({}, { sessionID: "root" })).replay, true);
  await assert.rejects(hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "forged" },
    { args: { subagent_type: "dog-luna-worker", prompt: "role: implementation", readonlyDiagnosisAuthorized: true } }));
  const args = prepared.ready.map((descriptor: unknown) => ({ subagent_type: "dog-luna-worker", prompt: `failure_swarm_descriptor: ${JSON.stringify(descriptor)}` }));
  for (const [index, descriptor] of prepared.ready.entries()) {
    const child = `diagnosis-${index}`;
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: `diagnose-${index}` }, { args: args[index] });
    prompts.set(child, args[index].prompt);
    await hooks.event!({ event: { type: "session.created", properties: { info: { id: child, parentID: "root" } } } });
    await hooks["chat.message"]!({ sessionID: child, agent: "dog-luna-worker", parentID: "root" } as never,
      { message: { agent: "dog-luna-worker", model: {} }, parts: [{ type: "text", text: args[index].prompt }] });
    const read = { filePath: "a.txt" };
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: child, callID: `read-${index}` }, { args: read });
    assert.ok((await readFile(read.filePath)).equals(beforeSource));
    await hooks["tool.execute.after"]!({ tool: "read", sessionID: child, callID: `read-${index}`, args: read }, { output: "bounded source read" });
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: child, callID: `failed-read-${index}` }, { args: { filePath: "a.txt" } });
    await hooks.event!({ event: { type: "message.part.updated", properties: { part: { type: "tool", sessionID: child,
      callID: `failed-read-${index}`, state: { status: "error" } } } } });
    for (const tool of ["edit", "write", "apply_patch", "bash", "task", "glob", "grep", "webfetch", "external_api_update", "sortie_bind_write_gate"]) {
      await assert.rejects(hooks["tool.execute.before"]!({ tool, sessionID: child, callID: `deny-${tool}-${index}` },
        { args: { filePath: planPath, command: "git update-ref refs/heads/main bad" } }), /diagnosis-read-only/);
    }
    await assert.rejects(hooks["tool.execute.before"]!({ tool: "read", sessionID: child, callID: `outside-${index}` },
      { args: { filePath: planPath } }), /diagnosis-source-scope-invalid/);
    assert.deepEqual(JSON.parse(await hooks.tool!.sortie_bind_write_gate.execute({ project_root: value.repository,
      manifest_path: "operation-manifest.json" }, { sessionID: child })), { status: "denied", reason: "diagnosis-read-only" });
    assert.equal(JSON.parse(await hooks.tool!.sortie_select_failure_diagnosis.execute({ swarm_id: prepared.swarm_id, selection_json: "{}" }, { sessionID: child })).status, "denied");
    replies.set(child, JSON.stringify({ causal_class: descriptor.causal_class,
      verdict: descriptor.causal_class === "configuration" ? "supported" : "excluded", validation_fingerprints: [value.fingerprint] }));
  }
  for (let index = 0; index < args.length; index += 1) {
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: `diagnose-${index}`, args: args[index] },
      { output: replies.get(`diagnosis-${index}`), metadata: { sessionId: `diagnosis-${index}` } });
  }
  const until = Date.now() + 10000;
  let state = await value.runtime.get(prepared.swarm_id);
  while (Object.keys(state.findings).length !== 2 && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 20)); state = await value.runtime.get(prepared.swarm_id);
  }
  assert.equal(Object.keys(state.findings).length, 2);
  const report = JSON.parse(await prepare({}, { sessionID: "root" }));
  assert.equal(report.findings.filter((finding: { capsule_id: string | null }) => finding.capsule_id !== null).length, 2);
  assert.deepEqual(report.ready, []);
  assert.equal(new Set(Object.values(state.findings).map(({ capsule_id }) => capsule_id)).size, 2);
  assert.ok((await readFile(join(value.repository, "a.txt"))).equals(beforeSource));
  assert.ok((await readFile(planPath)).equals(beforePlan));
  assert.equal((await run(value.repository, "rev-parse", "main")).trim(), value.base);
  assert.deepEqual((await value.ledger.read()).state.budget_consumed, { recovery_actions: 3, probe_iterations: 0, model_attempts: 4 });
  await assert.rejects(value.ledger.append(value.start("unauthorized", "normal")), (error: unknown) => error instanceof RunFlightLedgerError && error.code === "transition");
  const supported = state.lanes.find((lane) => lane.causal_class === "configuration")!;
  const selection = { diagnosis_id: supported.diagnosis_id, capsule_id: state.findings[supported.lane_id].capsule_id,
    recovery_kind: "normal_remediation", proposal: "Repair the configured value inside the accepted unit scope.", budget_request: repairCharge };
  const selected = JSON.parse(await hooks.tool!.sortie_select_failure_diagnosis.execute({ swarm_id: state.swarm_id, selection_json: JSON.stringify(selection) }, { sessionID: "root" }));
  assert.equal(selected.status, "selected");
  assert.deepEqual(selected.contract.scope_write, ["a.txt"]);
  assert.deepEqual(selected.contract.validation.command, [process.execPath, ...validatorArgs]);
  assert.equal(JSON.parse(await hooks.tool!.sortie_select_failure_diagnosis.execute({ swarm_id: state.swarm_id, selection_json: JSON.stringify(selection) }, { sessionID: "root" })).replay, true);
  const other = state.lanes.find((lane) => lane !== supported)!;
  const changed = { ...selection, diagnosis_id: other.diagnosis_id, capsule_id: state.findings[other.lane_id].capsule_id };
  assert.equal(JSON.parse(await hooks.tool!.sortie_select_failure_diagnosis.execute({ swarm_id: state.swarm_id, selection_json: JSON.stringify(changed) }, { sessionID: "root" })).status, "denied");
  await value.ledger.append(value.start("repair", "normal", selected.selection.contract_id));
  await writeFile(join(value.repository, "a.txt"), "repair-a\n");
  assert.equal(await validate(value.repository), 0); await value.ledger.append(value.finish("repair", 0));
  await assert.rejects(value.ledger.append(value.start("duplicate-repair", "repair", selected.selection.contract_id)), /Remediation contract/);
  const history = await value.ledger.read();
  assert.equal(history.records.filter(({ event }) => event.kind === "diagnosis.selected").length, 1);
  assert.equal(history.state.diagnoses[0].executed_attempt_id, "repair");
  assert.deepEqual(history.state.budget_consumed, { recovery_actions: 4, probe_iterations: 0, model_attempts: 5 });
  assert.equal((await run(value.repository, "rev-parse", "main")).trim(), value.base);
});

test("known faults can use direct bounded repair, while diagnosis shares the existing recovery ceiling", async (t) => {
  const direct = await setup("direct");
  const source = blob(await readFile(join(direct.repository, "a.txt")));
  const lanes = [{ lane_id: "one", access: "read_only" as const, available: true }, { lane_id: "two", access: "read_only" as const, available: true }];
  assert.deepEqual(await direct.runtime.prepare({ ...direct.request, cause: "known" }, lanes), { status: "not_planned", reason: "cause_already_known" });
  assert.equal((await direct.ledger.read()).state.diagnoses.length, 0);
  await direct.ledger.append(direct.start("direct-repair", "normal"));
  assert.deepEqual((await direct.ledger.read()).state.budget_consumed, { recovery_actions: 2, probe_iterations: 0, model_attempts: 3 });
  const limited = await setup("limited", 2);
  assert.equal(blob(await readFile(join(limited.repository, "a.txt"))), source);
  const before = await limited.ledger.read();
  const refused = await limited.runtime.prepare(limited.request, lanes);
  assert.equal(refused.status, "rejected");
  assert.deepEqual((await limited.ledger.read()).records, before.records);
  t.diagnostic("Matched fault/source/validator fixture: known cause uses zero diagnosis calls; uncertain cause requests two additional model slots. This is not a live-model cost or quality benchmark.");
});

test("duplicate, foreign, changed, and stale diagnosis requests cannot launch replacement lanes", async () => {
  const value = await setup("replay");
  const lanes = [{ lane_id: "one", access: "read_only" as const, available: true }];
  const result = await value.runtime.prepare(value.request, lanes);
  assert.equal(result.status, "prepared"); if (result.status !== "prepared") return;
  const before = (await value.ledger.read()).records;
  assert.equal((await value.runtime.prepare(value.request, lanes)).status, "prepared");
  assert.deepEqual((await value.ledger.read()).records, before);
  await assert.rejects(value.runtime.prepare({ ...value.request, causal_classes: ["changed"] }, lanes), /request-drift/);
  const foreign = new FailureSwarmRuntime(value.ledger, value.store, value.plan, value.fabric, value.currentSources, "foreign");
  await assert.rejects(foreign.get(result.swarm.swarm_id), /binding-mismatch/);
  await value.runtime.claim(result.swarm.swarm_id, "one", "call-one");
  await assert.rejects(value.runtime.claim(result.swarm.swarm_id, "one", "call-replacement"), /conflicts/);
  await writeFile(join(value.repository, "a.txt"), "changed after diagnosis preparation\n");
  await assert.rejects(value.runtime.claim(result.swarm.swarm_id, "one", "call-one"), { code: "stale" });
  assert.equal((await value.ledger.read()).records.filter(({ event }) => event.kind === "diagnosis.dispatched").length, 1);
});

test("untrusted findings cannot store arbitrary data and concurrent selectors accept one immutable contract", async () => {
  const value = await setup("selection");
  const lanes = ["one", "two"].map((lane_id) => ({ lane_id, access: "read_only" as const, available: true }));
  const prepared = await value.runtime.prepare(value.request, lanes);
  assert.equal(prepared.status, "prepared"); if (prepared.status !== "prepared") return;
  for (const [index, lane] of prepared.swarm.lanes.entries()) {
    const descriptor = await value.runtime.claim(prepared.swarm.swarm_id, lane.lane_id, `call-${index}`);
    const identity = { run_id: descriptor.run_id, unit_id: descriptor.unit_id, attempt_id: descriptor.diagnosis_id,
      predecessor_attempt_id: descriptor.failed_attempt_id, candidate_id: descriptor.candidate_id,
      route_id: "read_only_diagnosis", child_id: `child-${index}`, call_id: `call-${index}` };
    const child = await value.runtime.bindChild(descriptor, `call-${index}`, `child-${index}`, {
      observe: async () => ({ observation: { identity, disposition: "succeeded" }, evidence: { terminal: "satisfied",
        tools_quiescent: "satisfied", artifact_window_closed: "satisfied", writer_released: "satisfied",
        gate_released: "satisfied", lease_released: "satisfied", worktree_released: "satisfied" } }),
      stop: async () => {}, release: async () => {}, terminal: async () => {},
    });
    assert.equal((await child.check()).status, "terminal");
    const finding = { causal_class: lane.causal_class, verdict: "supported", validation_fingerprints: [value.fingerprint] };
    const before = (await value.ledger.read()).records;
    await assert.rejects(value.runtime.finish(prepared.swarm.swarm_id, lane.lane_id, { ...finding, confidence: 1, raw_log: "not allowed" }, observation()), /finding-invalid/);
    await assert.rejects(value.runtime.finish(prepared.swarm.swarm_id, lane.lane_id, { ...finding, validation_fingerprints: [blob("unapproved")] }, observation()), /evidence-invalid/);
    assert.deepEqual((await value.ledger.read()).records, before);
    await value.runtime.finish(prepared.swarm.swarm_id, lane.lane_id, finding, observation());
    const finished = (await value.ledger.read()).records;
    await value.runtime.finish(prepared.swarm.swarm_id, lane.lane_id, finding, { ...observation(), duration_ms: 99 });
    assert.deepEqual((await value.ledger.read()).records, finished);
  }
  const state = await value.runtime.get(prepared.swarm.swarm_id);
  const selections = state.lanes.map((lane) => ({ diagnosis_id: lane.diagnosis_id, capsule_id: state.findings[lane.lane_id].capsule_id!,
    recovery_kind: "normal_remediation" as const, proposal: "Repair within the accepted unit.", budget_request: repairCharge }));
  await assert.rejects(value.runtime.select(state.swarm_id, { ...selections[0], scope_write: ["elsewhere"] } as never), /selection-invalid/);
  const attempts = await Promise.allSettled(selections.map((selection) => value.runtime.select(state.swarm_id, selection)));
  assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(attempts.filter(({ status }) => status === "rejected").length, 1);
  const winner = attempts.find(({ status }) => status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<FailureSwarmRuntime["select"]>>>;
  assert.ok(Object.isFrozen(winner.value.contract));
  assert.ok(Object.isFrozen(winner.value.contract.scope_write));
  assert.deepEqual(winner.value.contract.scope_write, ["a.txt"]);
  assert.equal((await value.ledger.read()).records.filter(({ event }) => event.kind === "diagnosis.selected").length, 1);
});

test("diagnosis reservations share finite time and cost limits without partial budget consumption", async () => {
  const value = await setup("resource-budget", 10, true);
  const before = await value.ledger.read();
  const lanes = ["one", "two"].map((lane_id) => ({ lane_id, access: "read_only" as const, available: true }));
  await assert.rejects(value.runtime.prepare({ ...value.request, per_lane_resource_budget: { time_ms: 10, cost_usd: 0.5 } }, lanes),
    (error: unknown) => error instanceof RunFlightLedgerError && error.code === "budget");
  assert.deepEqual((await value.ledger.read()).records, before.records);
  await assert.rejects(value.runtime.prepare({ ...value.request, per_lane_resource_budget: { time_ms: 60, cost_usd: 0.125 } }, lanes),
    (error: unknown) => error instanceof RunFlightLedgerError && error.code === "budget");
  assert.deepEqual((await value.ledger.read()).state.budget_consumed, before.state.budget_consumed);
});

test("closed inconclusive diagnosis does not force another swarm before independently authorized rescue", async () => {
  const value = await setup("inconclusive");
  const prepared = await value.runtime.prepare(value.request, [{ lane_id: "one", access: "read_only", available: true }]);
  assert.equal(prepared.status, "prepared"); if (prepared.status !== "prepared") return;
  const descriptor = await value.runtime.claim(prepared.swarm.swarm_id, "one", "diagnosis-call");
  const identity = { run_id: descriptor.run_id, unit_id: descriptor.unit_id, attempt_id: descriptor.diagnosis_id,
    predecessor_attempt_id: descriptor.failed_attempt_id, candidate_id: descriptor.candidate_id,
    route_id: "read_only_diagnosis", child_id: "child", call_id: "diagnosis-call" };
  const child = await value.runtime.bindChild(descriptor, "diagnosis-call", "child", {
    observe: async () => ({ observation: { identity, disposition: "failed" }, evidence: { terminal: "satisfied", tools_quiescent: "satisfied",
      artifact_window_closed: "satisfied", writer_released: "satisfied", gate_released: "satisfied", lease_released: "satisfied", worktree_released: "satisfied" } }),
    stop: async () => {}, release: async () => {}, terminal: async () => {},
  });
  assert.equal((await child.check()).status, "terminal");
  await value.runtime.finish(prepared.swarm.swarm_id, "one", null, observation());
  await assert.rejects(value.ledger.append(value.start("unselected-repair", "normal")), /single authorized/);
  await value.ledger.append({ ...value.start("direct-rescue", "normal"), role: "rescue",
    budget_charge: { ...repairCharge, kind: "model_rescue" } } as RunFlightEvent);
  const state = await value.ledger.read();
  assert.equal(state.records.filter(({ event }) => event.kind === "diagnosis.selected").length, 0);
  assert.deepEqual(state.state.budget_consumed, { recovery_actions: 3, probe_iterations: 0, model_attempts: 4 });
});
