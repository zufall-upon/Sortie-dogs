import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DEFAULT_OPERATOR_PROPOSAL_BUDGET, OPERATOR_PROPOSAL_BUDGET_CAPS, OperatorProposalRuntime } from "../dist/core/operator-proposal.js";
import { OperatorContractError, OperatorRuntime, parseOperatorPlan } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { SortieDogsPlugin } from "../dist/plugin/index.js";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";
import { RunFlightLedger } from "../dist/core/run-flight-ledger.js";
import { V010_RUNTIME_ASSET_VERSION } from "../dist/asset-version.js";
import type { RuntimeBridge } from "../dist/plugin/runtime-bridge.js";

async function fixture(run: (root: string) => Promise<void>) {
  const area = resolve("_testenv"); await mkdir(area, { recursive: true }); const root = await mkdtemp(join(area, "proposal-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const requirements = [
  { id: "R1", text: "Implement the requested result", kind: "requirement" as const },
  { id: "N1", text: "Do not edit the validator", kind: "negative" as const },
  { id: "Q1", text: "The exact validator passes", kind: "quality" as const },
];
function intent() { return { schema_version: "0.1", original_request: { text: "Implement result while preserving the validator.", source_ref: "user:u1" },
  requirements, authoritative_refs: ["user:u1"], allow_read: ["src", "test"], proposal_budget: { max_reads: 2, max_submissions: 1 } }; }
function plan() { const validation = "node test/check.mjs"; return { schema_version: "0.1", acceptance: requirements.map(item => item.text),
  acceptance_proof: [["proof"], ["proof"], ["proof"]], source_refs: ["user:u1"], goal_declaration: {
    delivery_intent: "implementation", delivery_mode: "mvp-first", usable_path_established: false, controlled_change: false, goal_budget_units: 2,
    defaults: { target: "result", entrypoint: "test/check.mjs", workload: "fixture", oracle_coverage: ["result and unchanged validator"],
      build_boundary: "not-applicable", source: "source", candidate: "candidate", source_binding: "current-protected", candidate_binding: "current-protected",
      fixture: "proposal", proof_scope: "requested-full", expected_outcome: "pass" }, criteria: [{ criterion_id: "proof", validation_command: validation }] },
  units: [{ id: "implementation", title: "Implement result", objective: "Implement the complete accepted result.", read: ["src", "test"], write: ["src/result.ts"],
    validation: [validation], acceptance_indices: [0, 1, 2] }] }; }
function packet(reads = 0, uncovered: unknown[] = []) { return { schema_version: "0.1", revision: 1,
  coverage: uncovered.length ? requirements.slice(1).map(item => ({ requirement_id: item.id, approach: `Handle ${item.id}`, validation: "node test/check.mjs" }))
    : requirements.map(item => ({ requirement_id: item.id, approach: `Handle ${item.id}`, validation: "node test/check.mjs" })),
  existing_surface: (uncovered.length ? requirements.slice(1) : requirements)
    .map(item => ({ requirement_id: item.id, path: "src/input.ts", form: `Observed fixture surface for ${item.id}` })),
  uncovered, negative_handling: [{ requirement_id: "N1", handling: "Keep test/check.mjs read-only." }], read_scope: ["src", "test"], write_scope: ["src/result.ts"],
    budget_estimate: { proposal_reads: reads, execution_units: 1 }, plan: plan() }; }
const proposalRefPrefix = "SORTIE_OPERATOR_PROPOSAL_TASK_REF ";
function changedReference(prompt: string, patch: Record<string, unknown>): string {
  assert.ok(prompt.startsWith(proposalRefPrefix));
  return proposalRefPrefix + JSON.stringify({ ...JSON.parse(prompt.slice(proposalRefPrefix.length)), ...patch });
}

async function previewHooks(root: string, rootSessionID = "root") {
  await promisify(execFile)("git", ["init", "--quiet"], { cwd: root });
  return SortieDogsV010Plugin({ directory: root, client: { session: {
    get: async ({ path }: { path: { id: string } }) => ({ data: path.id === rootSessionID
      ? { agent: "dog-operator" } : { agent: "dogs-coordinator", parentID: rootSessionID } }),
    messages: async () => ({ data: [] }),
  } } } as never);
}
async function previewProposal(root: string, submissions = 1) {
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "input.ts"), "export {};\n");
  const hooks = await previewHooks(root);
  await hooks["chat.message"]!({ sessionID: "root", messageID: "user-1", agent: "dog-operator",
    model: { providerID: "openai", modelID: "gpt-5.6-sol" } }, {
    message: { agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text: "Implement the approved result.\ngoal_budget_units: 2" }],
  });
  const started = JSON.parse(await hooks.tool!.sortie_v010_begin_operator_proposal.execute(
    { intent_json: JSON.stringify({ ...intent(), proposal_budget: { ...intent().proposal_budget, max_submissions: submissions } }) }, { sessionID: "root" }));
  const key = createHash("sha256").update("v010\0root").digest("hex");
  const ledgerPath = join(root, ".git/sortie-dogs/run-flight-v010", `${key}.json`);
  return { hooks, started, ledgerPath };
}

test("begin tool exposes concrete normalized path limits and rejects malformed intent without state or spend", async () => fixture(async root => {
  const hooks = await previewHooks(root);
  const begin = hooks.tool!.sortie_v010_begin_operator_proposal;
  const arg = begin.args.intent_json as { description: string };
  for (const description of [begin.description, arg.description]) {
    for (const field of ['"schema_version":"0.1"', '"original_request"', '"source_ref"', '"requirements"',
      '"id"', '"text"', '"kind"', '"requirement" | "negative" | "quality"', '"authoritative_refs"',
      '"allow_read"', 'proposal_budget optional', '"max_reads"', '"max_submissions"', 'integer 1..192', 'integer 1..24',
      'deterministic default {"max_reads":45,"max_submissions":9}', 'explicit smaller budgets are preserved',
      'normalized, concrete repository-relative FILE or DIRECTORY prefixes', 'must already equal normalizeRelativePath(entry)',
      'existing exact path observed in authoritative evidence or prior discovery', 'do not invent a top-level basename from a nested path',
      'do not use an empty string, ".", any ".." segment/traversal', 'Unix/UNC absolute path', 'drive-qualified path',
      'Wildcards are not expanded and do not authorize repository-root reads', 'list the existing top-level files and directories explicitly',
      'all other fields required, no aliases or extra keys']) {
      assert.ok(description.includes(field), `tool and argument must expose ${field}`);
    }
  }
  assert.notEqual(hooks.tool!.sortie_v010_prepare_operator.args.plan_json, begin.args.intent_json,
    "describing intent must not mutate the shared string schema");
  const prepare = hooks.tool!.sortie_v010_prepare_operator;
  const planArgument = prepare.args.plan_json as { description: string };
  for (const description of [prepare.description, planArgument.description]) {
    assert.match(description, /git_lifecycle/);
    assert.match(description, /branch_create:\{branch:string,start_ref:string\},commit:\{message:string\},post_commit_validation:string\[\]/);
    assert.match(description, /before worker spend/);
    assert.match(description, /Omission preserves the existing no-Git-lifecycle behavior/);
    assert.match(description, /unit\.validation is an ordered execution list, not tests only/u);
    assert.match(description, /generator\/build\/format commands and exact cleanup after generation but before post-commit or canonical criterion tests/u);
    assert.match(description, /required inputs in unit\.read and every persistent or transient generated output in unit\.write/u);
    assert.match(description, /host does not infer or inject missing build dependencies/u);
  }
  await hooks["chat.message"]!({ sessionID: "root", messageID: "user-1", agent: "dog-operator",
    model: { providerID: "openai", modelID: "gpt-5.6-sol" } }, {
    message: { agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text: intent().original_request.text }],
  });
  const key = createHash("sha256").update("v010\0root").digest("hex");
  const ledger = await RunFlightLedger.openGoal(join(root, ".git/sortie-dogs/run-flight-v010", `${key}.json`));
  const before = await ledger.readGoal();
  const malformed = { schema_version: "0.1", requirements: Array.from({ length: 15 }, (_, i) => ({ id: `R${i + 1}`, text: `Requirement ${i + 1}` })),
    authoritative_references: ["user:u1"], max_read_prefixes: ["src"], proposal_read_budget: 5, proposal_submission_budget: 3,
    source_refs: ["user:u1"], negative_constraints: ["Preserve validator"], quality_thresholds: ["Validator passes"] };
  const missingOriginal = { ...intent() };
  delete (missingOriginal as Partial<typeof missingOriginal>).original_request;
  for (const value of [malformed, missingOriginal, { ...intent(), requirements: requirements.map(({ kind, ...item }) => item) },
    { ...intent(), authoritative_references: ["user:u1"] },
    ...["", ".", "./src", "src/", "src//result.ts", "src/../test", "../src", "/src", "//server/share", "C:/src"]
      .map(path => ({ ...intent(), allow_read: [path] }))]) {
    await assert.rejects(begin.execute({ intent_json: JSON.stringify(value) }, { sessionID: "root" }),
      /operator-intent-invalid|operator-intent-requirement-invalid/);
    assert.equal(await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).read("root"), undefined);
    assert.equal(await new OperatorRuntime(root, V010_RUNTIME_PROFILE).read("root"), undefined);
    assert.deepEqual((await ledger.readGoal()).records, before.records);
  }
  await mkdir(join(root, "src"));
  await writeFile(join(root, "package.json"), "{}\n");
  const validIntent = { ...intent(), allow_read: ["package.json", "src"] };
  const result = JSON.parse(await begin.execute({ intent_json: JSON.stringify(validIntent) }, { sessionID: "root" }));
  const state = await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).required("root");
  assert.equal(result.status, "investigating");
  assert.deepEqual(state.intent, validIntent);
  assert.equal(state.proposal_call_id, null);
  assert.equal(state.proposal_session_id, null);
  assert.equal(state.read_count, 0);
  assert.equal(state.submission_count, 0);
  assert.deepEqual((await ledger.readGoal()).records, before.records, "begin alone grants no execution budget");
}));

test("omitted proposal budgets use host defaults while explicit grants, caps, and exhaustion remain bounded", async () => fixture(async root => {
  const runtime = new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE);
  const omitted = { ...intent() };
  delete (omitted as Partial<typeof omitted>).proposal_budget;
  const defaulted = await runtime.begin("defaulted", omitted);
  assert.deepEqual(defaulted.intent.proposal_budget, DEFAULT_OPERATOR_PROPOSAL_BUDGET);
  assert.deepEqual(await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).begin("defaulted", omitted), defaulted,
    "cold re-entry must materialize the same intent identity without resetting spend");
  const defaultTask = runtime.task(defaulted);
  await runtime.admit("defaulted", "default-call", defaultTask);
  await runtime.bind("defaulted", "default-child", defaultTask.prompt);
  for (let index = 0; index < DEFAULT_OPERATOR_PROPOSAL_BUDGET.max_reads; index++) {
    await runtime.accountRead("defaulted", "default-child");
  }
  await assert.rejects(runtime.accountRead("defaulted", "default-child"), /read-budget-exhausted/);
  for (let index = 0; index < DEFAULT_OPERATOR_PROPOSAL_BUDGET.max_submissions; index++) {
    await assert.rejects(runtime.submit("defaulted", "default-child", {}), /operator-proposal-invalid/);
  }
  await assert.rejects(runtime.submit("defaulted", "default-child", {}), /submission-budget-exhausted/);
  const exhausted = await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).required("defaulted");
  assert.equal(exhausted.read_count, 45);
  assert.equal(exhausted.submission_count, 9);

  const explicit = await runtime.begin("explicit-smaller", intent());
  assert.deepEqual(explicit.intent.proposal_budget, { max_reads: 2, max_submissions: 1 });
  assert.deepEqual((await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).begin("explicit-smaller", intent())).intent.proposal_budget,
    { max_reads: 2, max_submissions: 1 }, "existing explicit durable grants must not be replaced by defaults");

  const atCaps = await runtime.begin("at-caps", { ...intent(), proposal_budget: { ...OPERATOR_PROPOSAL_BUDGET_CAPS } });
  assert.deepEqual(atCaps.intent.proposal_budget, { max_reads: 192, max_submissions: 24 });
  for (const [name, proposal_budget] of [
    ["zero-read", { max_reads: 0, max_submissions: 1 }],
    ["negative-submission", { max_reads: 1, max_submissions: -1 }],
    ["fractional-read", { max_reads: 1.5, max_submissions: 1 }],
    ["fractional-submission", { max_reads: 1, max_submissions: 1.5 }],
    ["over-read-cap", { max_reads: 193, max_submissions: 1 }],
    ["over-submission-cap", { max_reads: 1, max_submissions: 25 }],
  ] as const) {
    await assert.rejects(runtime.begin(name, { ...intent(), proposal_budget }), /operator-intent-invalid/);
  }
}));

test("proposal admission save failure settles its durable reservation without a published call grant", async () => fixture(async root => {
  const { hooks, started, ledgerPath } = await previewProposal(root);
  const key = createHash("sha256").update("root").digest("hex");
  const file = join(root, V010_RUNTIME_PROFILE.stateDirectory, "operator-proposals", `${key}.json`);
  const backup = `${file}.backup`;
  await rename(file, backup);
  await mkdir(file); // A real rename failure after the independent goal ledger successfully reserves.
  try {
    await assert.rejects(hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "failed-save" },
      { args: started.task }), error => ["EISDIR", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? ""));
  } finally {
    await rm(file, { recursive: true });
    await rename(backup, file);
  }
  const restored = await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).required("root");
  assert.equal(restored.proposal_call_id, null);
  let snapshot = await (await RunFlightLedger.openGoal(ledgerPath)).readGoal();
  assert.equal(snapshot.state.outstanding_reservations.length, 0);
  assert.equal(snapshot.state.consumed_units, 1);
  const settlements = snapshot.records.filter(({ event }) => event.kind === "unit.settled");
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].event.kind === "unit.settled" && settlements[0].event.disposition, "failed");
  // Storage recovery allows a fresh call; the failed attempt remains charged.
  await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "retry" }, { args: started.task });
  await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "retry" }, { output: "No proposal submitted." });
  snapshot = await (await RunFlightLedger.openGoal(ledgerPath)).readGoal();
  assert.equal(snapshot.state.outstanding_reservations.length, 0);
  assert.equal(snapshot.state.consumed_units, 2);
}));

test("proposal shape diagnostics identify every malformed scope and missing field without rewriting the packet", async () => fixture(async root => {
  const { hooks, started } = await previewProposal(root, 2);
  await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "shape-proposal" }, { args: started.task });
  await hooks["chat.message"]!({ sessionID: "child", messageID: "shape-child", agent: "dogs-coordinator" }, {
    message: { agent: "dogs-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
    parts: [{ type: "text", text: started.task.prompt }],
  });
  await hooks["tool.execute.before"]!({ tool: "read", sessionID: "child", callID: "shape-read" },
    { args: { filePath: "src/input.ts" } });
  const value = { ...packet(1), read_scope: ["src/", "test"], write_scope: ["src/result.ts", "build/", "../private"], extra: true };
  delete (value as { existing_surface?: unknown }).existing_surface;
  const original = JSON.stringify(value);
  const invalid = JSON.parse(await hooks.tool!.sortie_v010_submit_operator_proposal.execute(
    { proposal_json: original }, { sessionID: "child" }));
  assert.equal(invalid.status, "invalid-proposal");
  assert.deepEqual(new Set(invalid.diagnostics.map((d: { pointer: string }) => d.pointer)),
    new Set(["/extra", "/existing_surface", "/read_scope/0", "/write_scope/1", "/write_scope/2"]));
  assert.equal(invalid.actual_reads, 1);
  assert.equal(invalid.remaining_reads, 1);
  assert.equal(invalid.submissions, 1);
  assert.equal(JSON.stringify(value), original);
  assert.doesNotMatch(JSON.stringify(invalid.diagnostics), /private|src\/result|build\//u);
  assert.equal((await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).required("root")).proposal, null);
  const corrected = JSON.parse(await hooks.tool!.sortie_v010_submit_operator_proposal.execute(
    { proposal_json: JSON.stringify(packet(1)) }, { sessionID: "child" }));
  assert.equal(corrected.status, "submitted");
  assert.equal(corrected.submissions, 2);
  assert.equal(corrected.remaining_submissions, 0);
  assert.deepEqual(corrected.proposal.plan.acceptance, requirements.map(item => item.text));
}));

test("proposal system elements stay identical across accounted reads and report consumed budget on the read result", async () => fixture(async root => {
  const { hooks, started } = await previewProposal(root);
  await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "prefix-proposal" }, { args: started.task });
  await hooks["chat.message"]!({ sessionID: "child", messageID: "prefix-child", agent: "dogs-coordinator" }, {
    message: { agent: "dogs-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
    parts: [{ type: "text", text: started.task.prompt }],
  });
  const snapshot = async () => {
    const system = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!({ sessionID: "child" }, system);
    return system.system;
  };
  const before = await snapshot();
  assert.match(before.join("\n"), /SORTIE_PROPOSAL_PHASE investigating/u);
  assert.match(before.join("\n"), /max_reads=2; max_submissions=1\./u);
  for (const element of before) {
    assert.doesNotMatch(element, /actual_reads=|remaining_reads=|remaining_submissions=/u,
      "a system element is an absolute prompt prefix: a counter that moves on every read discards the cached prefix");
  }
  const results: string[] = [];
  for (const callID of ["prefix-read-1", "prefix-read-2"]) {
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: "child", callID }, { args: { filePath: "src/input.ts" } });
    const output = { output: "observed" };
    await hooks["tool.execute.after"]!({ tool: "read", sessionID: "child", callID, args: { filePath: "src/input.ts" } }, output);
    results.push(output.output);
    assert.deepEqual(await snapshot(), before, "an accounted read must not change the cached prompt prefix");
  }
  assert.equal(results[0], "observed\n\nSORTIE_PROPOSAL_BUDGET actual_reads=1; remaining_reads=1; submissions=0; remaining_submissions=1.");
  assert.equal(results[1], "observed\n\nSORTIE_PROPOSAL_BUDGET actual_reads=2; remaining_reads=0; submissions=0; remaining_submissions=1.");
  const foreign = { output: "observed" };
  await hooks["tool.execute.after"]!({ tool: "read", sessionID: "foreign", callID: "foreign-read", args: { filePath: "src/input.ts" } }, foreign);
  assert.equal(foreign.output, "observed", "an unclaimed child receives no proposal budget accounting");
}));

test("proposal system elements survive a successful submission so the final child turn keeps its cached prefix", async () => fixture(async root => {
  const { hooks, started } = await previewProposal(root);
  await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "submit-proposal" }, { args: started.task });
  await hooks["chat.message"]!({ sessionID: "child", messageID: "submit-child", agent: "dogs-coordinator" }, {
    message: { agent: "dogs-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
    parts: [{ type: "text", text: started.task.prompt }],
  });
  const snapshot = async (sessionID: string) => {
    const system = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!({ sessionID }, system);
    return system.system;
  };
  await hooks["tool.execute.before"]!({ tool: "read", sessionID: "child", callID: "submit-read" }, { args: { filePath: "src/input.ts" } });
  await hooks["tool.execute.after"]!({ tool: "read", sessionID: "child", callID: "submit-read", args: { filePath: "src/input.ts" } }, { output: "observed" });
  const investigating = await snapshot("child");
  assert.match(investigating.join("\n"), /SORTIE_PROPOSAL_PHASE investigating/u);

  const submitted = JSON.parse(await hooks.tool!.sortie_v010_submit_operator_proposal.execute(
    { proposal_json: JSON.stringify(packet(1)) }, { sessionID: "child" }));
  assert.equal(submitted.status, "submitted");
  assert.equal((await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).required("root")).phase, "submitted");

  // Dropping an element is the same absolute prefix change as rewriting one. Gating the profile and
  // proposal elements on `investigating` discarded them the moment a submission succeeded, so the
  // child's final turn re-sent its entire accumulated investigation uncached.
  assert.deepEqual(await snapshot("child"), investigating,
    "a successful submission must not change the cached prompt prefix of its own child");
  assert.deepEqual(await snapshot("foreign"), [], "prompt-only root resolution never claims an unrelated session");
}));

test("a submitted proposal child keeps its stable prefix without regaining any tool authority", async () => fixture(async root => {
  const { hooks, started } = await previewProposal(root);
  await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "authority-proposal" }, { args: started.task });
  await hooks["chat.message"]!({ sessionID: "child", messageID: "authority-child", agent: "dogs-coordinator" }, {
    message: { agent: "dogs-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
    parts: [{ type: "text", text: started.task.prompt }],
  });
  await hooks["tool.execute.before"]!({ tool: "read", sessionID: "child", callID: "authority-read" }, { args: { filePath: "src/input.ts" } });
  await hooks.tool!.sortie_v010_submit_operator_proposal.execute({ proposal_json: JSON.stringify(packet(1)) }, { sessionID: "child" });
  const system = { system: [] as string[] };
  await hooks["experimental.chat.system.transform"]!({ sessionID: "child" }, system);
  assert.match(system.system.join("\n"), /SORTIE_PROPOSAL_PHASE investigating/u);
  await assert.rejects(hooks["tool.execute.before"]!({ tool: "read", sessionID: "child", callID: "authority-denied" },
    { args: { filePath: "src/input.ts" } }), /runtime-profile-session-inactive|operator-proposal-read-grant-invalid/u,
    "prompt-only root resolution must not restore a spent read grant");
  await assert.rejects(hooks.tool!.sortie_v010_submit_operator_proposal.execute(
    { proposal_json: JSON.stringify(packet(1)) }, { sessionID: "child" }), /grant-invalid|budget-exhausted|inactive/u,
    "prompt-only root resolution must not restore the submit grant");
}));

test("preview root explicitly enables native auto-continuation after compaction", async () => fixture(async root => {
  const hooks = await previewHooks(root);
  await hooks["chat.message"]!({ sessionID: "root", messageID: "auto-continue-user", agent: "dog-operator",
    model: { providerID: "openai", modelID: "gpt-5.6-luna-fast" } }, {
    message: { agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-5.6-luna-fast" } },
    parts: [{ type: "text", text: "Continue the same unfinished goal after native compaction." }],
  });
  const continuation = { enabled: false };
  await hooks["experimental.compaction.autocontinue"]!({ sessionID: "root", overflow: true }, continuation);
  assert.equal(continuation.enabled, true);
}));

test("active proposal compaction preserves the claimed child and budgets without an execution run", async () => fixture(async root => {
  const { hooks, started } = await previewProposal(root);
  await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "compact-proposal" }, { args: started.task });
  await hooks["chat.message"]!({ sessionID: "child", messageID: "compact-child", agent: "dogs-coordinator" }, {
    message: { agent: "dogs-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
    parts: [{ type: "text", text: started.task.prompt }],
  });
  await hooks["tool.execute.before"]!({ tool: "read", sessionID: "child", callID: "compact-read" },
    { args: { filePath: "src/input.ts" } });
  const runtime = new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE);
  const before = await runtime.required("root");
  const summary = { context: [] as string[] };
  const cold = await previewHooks(root);
  const system = { system: [] as string[] };
  await cold["experimental.chat.system.transform"]!({ sessionID: "child" }, system);
  assert.match(system.system.join("\n"), /SORTIE_PROPOSAL_PHASE investigating/u);
  assert.match(system.system.join("\n"), /generic continuation/u);
  const foreign = { system: [] as string[] };
  await cold["experimental.chat.system.transform"]!({ sessionID: "foreign" }, foreign);
  assert.equal(foreign.system.length, 0, "unclaimed children receive no proposal context");
  await cold["experimental.session.compacting"]!({ sessionID: "child" }, summary);
  assert.match(summary.context.join("\n"), /Proposal continuation/u);
  assert.match(summary.context.join("\n"), new RegExp(before.intent_id, "u"));
  assert.match(summary.context.join("\n"), /src\/input\.ts/u);
  assert.match(summary.context.join("\n"), /remaining_reads.*1/u);
  assert.doesNotMatch(summary.context.join("\n"), /Read sortie_v010_operator_next/u);
  const continuation = { enabled: true };
  await cold["experimental.compaction.autocontinue"]!({ sessionID: "child" }, continuation);
  assert.equal(continuation.enabled, true);
  assert.deepEqual(await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).required("root"), before);
  assert.equal(await new OperatorRuntime(root, V010_RUNTIME_PROFILE).read("root"), undefined);
  const submitted = JSON.parse(await hooks.tool!.sortie_v010_submit_operator_proposal.execute(
    { proposal_json: JSON.stringify(packet(1)) }, { sessionID: "child" }));
  assert.equal(submitted.status, "submitted");
  assert.equal(submitted.reads, 1);
  assert.equal(submitted.submissions, 1);
}));

test("proposal shape diagnostics are bounded and never coerce scope paths", async () => fixture(async root => {
  const runtime = new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE);
  const state = await runtime.begin("bounded", intent());
  await runtime.admit("bounded", "shape-call", runtime.task(state));
  await runtime.bind("bounded", "shape-child", runtime.task(state).prompt);
  const value = { ...packet(), write_scope: Array.from({ length: 25 }, (_, i) => `output-${i}/`) };
  await assert.rejects(runtime.submit("bounded", "shape-child", value), error => {
    assert.ok(error instanceof OperatorContractError);
    assert.equal(error.diagnostics.length, 16);
    assert.equal(error.diagnostics_truncated, true);
    assert.equal(error.diagnostics[0].pointer, "/write_scope/0");
    assert.equal(error.diagnostics[15].pointer, "/write_scope/15");
    return true;
  });
  assert.equal(value.write_scope[0], "output-0/");
  assert.equal((await runtime.required("bounded")).submission_count, 1);
}));

test("malformed proposal JSON gets bounded diagnostics and consumes the same finite submission budget", async () => fixture(async root => {
  const { hooks, started } = await previewProposal(root, 3);
  await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "json-proposal" }, { args: started.task });
  await hooks["chat.message"]!({ sessionID: "child", messageID: "json-child", agent: "dogs-coordinator" }, {
    message: { agent: "dogs-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
    parts: [{ type: "text", text: started.task.prompt }],
  });
  await hooks["tool.execute.before"]!({ tool: "read", sessionID: "child", callID: "json-read" },
    { args: { filePath: "src/input.ts" } });
  const malformed = '{"sensitive-placeholder":';
  for (const count of [1, 2]) {
    const output = await hooks.tool!.sortie_v010_submit_operator_proposal.execute(
      { proposal_json: malformed }, { sessionID: "child" });
    const result = JSON.parse(output);
    assert.equal(result.status, "invalid-proposal");
    assert.equal(result.code, "operator-proposal-json-invalid");
    assert.equal(result.diagnostics[0].pointer, "/");
    assert.equal(result.diagnostics[0].rule, "json");
    assert.equal(result.actual_reads, 1);
    assert.equal(result.submissions, count);
    assert.equal(result.remaining_submissions, 3 - count);
    assert.doesNotMatch(output, /sensitive-placeholder|SyntaxError/);
  }
  const result = JSON.parse(await hooks.tool!.sortie_v010_submit_operator_proposal.execute(
    { proposal_json: JSON.stringify(packet(1)) }, { sessionID: "child" }));
  assert.equal(result.status, "submitted");
  assert.equal(result.submissions, 3);
  assert.match(result.next_action, /return to its parent without further tools/u);
  assert.match(result.next_action, /Do not call operator_next/u);
  assert.equal(await new OperatorRuntime(root, V010_RUNTIME_PROFILE).read("root"), undefined);
}));

test("malformed JSON cannot spend a foreign grant or bypass an exhausted submission budget", async () => fixture(async root => {
  const runtime = new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE);
  const state = await runtime.begin("json-root", intent());
  const task = runtime.task(state);
  await runtime.admit("json-root", "json-call", task);
  await runtime.bind("json-root", "json-child", task.prompt);
  await assert.rejects(runtime.submitJSON("json-root", "foreign-child", "{"), /submit-grant-invalid/u);
  assert.equal((await runtime.required("json-root")).submission_count, 0);
  await assert.rejects(runtime.submitJSON("json-root", "json-child", "{"), /operator-proposal-json-invalid/u);
  await assert.rejects(runtime.submitJSON("json-root", "json-child", "{"), /submission-budget-exhausted/u);
  assert.equal((await runtime.required("json-root")).submission_count, 1);
}));

test("worker input scopes cannot silently expand a proposal's read declaration", async () => fixture(async root => {
  const runtime = new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE);
  const state = await runtime.begin("scope-root", { ...intent(), proposal_budget: { max_reads: 2, max_submissions: 2 } });
  const task = runtime.task(state);
  await runtime.admit("scope-root", "scope-call", task);
  await runtime.bind("scope-root", "scope-child", task.prompt);
  await runtime.accountRead("scope-root", "scope-child", "src/input.ts");
  const invalid = packet(1);
  invalid.plan.units[0]!.read.push("unobserved/input");
  await assert.rejects(runtime.submit("scope-root", "scope-child", invalid), error => {
    assert.ok(error instanceof OperatorContractError);
    assert.equal(error.diagnostics[0]!.code, "operator-proposal-unit-read-scope-expanded");
    assert.equal(error.diagnostics[0]!.pointer, "/plan/units/0/read/2");
    assert.doesNotMatch(JSON.stringify(error.diagnostics), /unobserved\/input/u);
    return true;
  });
  const valid = packet(1);
  valid.plan.units[0]!.write.push("generated/cache");
  valid.write_scope.push("generated/cache");
  valid.plan.units[0]!.read.push("generated/cache/result.json");
  const submitted = await runtime.submit("scope-root", "scope-child", valid);
  assert.equal(submitted.phase, "submitted", "declared generated output may be read during execution");
  assert.equal(submitted.submission_count, 2);
}));

test("a unit cannot read a generated output declared only by a later unit", async () => fixture(async root => {
  const runtime = new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE);
  const state = await runtime.begin("ordered-scope-root", intent());
  const task = runtime.task(state);
  await runtime.admit("ordered-scope-root", "ordered-scope-call", task);
  await runtime.bind("ordered-scope-root", "ordered-scope-child", task.prompt);
  await runtime.accountRead("ordered-scope-root", "ordered-scope-child", "src/input.ts");
  const invalid = packet(1);
  invalid.plan.acceptance_proof[0] = ["later-proof"];
  invalid.plan.goal_declaration.criteria.push({ criterion_id: "later-proof", validation_command: "node test/later.mjs" });
  invalid.plan.units[0]!.acceptance_indices = [1, 2];
  invalid.plan.units.push({ ...structuredClone(invalid.plan.units[0]!), id: "u2", title: "Generate later",
    write: ["generated/later.json"], validation: ["node test/later.mjs"], acceptance_indices: [0] });
  invalid.plan.units[0]!.read.push("generated/later.json");
  invalid.write_scope.push("generated/later.json");
  invalid.budget_estimate.execution_units = 2;
  invalid.plan.goal_declaration.goal_budget_units = 3;
  await assert.rejects(runtime.submit("ordered-scope-root", "ordered-scope-child", invalid), error => {
    assert.ok(error instanceof OperatorContractError);
    assert.equal(error.diagnostics[0]!.code, "operator-proposal-unit-read-scope-expanded");
    return true;
  });
}));

test("validation annotations are rejected without inventing a command or accepting a manual gate", () => {
  for (const label of ["root-only", "manual_review", "manual review", "approval"]) {
    const value = plan();
    const command = `${label}: inspect the protected user outcome`;
    value.goal_declaration.criteria[0]!.validation_command = command;
    value.units[0]!.validation = [command];
    assert.throws(() => parseOperatorPlan(value), error => {
      assert.ok(error instanceof OperatorContractError);
      assert.equal(error.diagnostics[0]!.code, "operator-validation-annotation-invalid");
      assert.equal(error.diagnostics[0]!.pointer, "/goal_declaration/criteria/0/validation_command");
      assert.doesNotMatch(JSON.stringify(error.diagnostics), /protected user outcome/u);
      return true;
    });
    assert.equal(value.units[0]!.validation[0], command, "rejection does not strip or rewrite instructions");
  }
  const preparatory = plan();
  preparatory.units[0]!.validation.unshift("prepare: wait for approval");
  assert.throws(() => parseOperatorPlan(preparatory), error => {
    assert.ok(error instanceof OperatorContractError);
    assert.equal(error.diagnostics[0]!.pointer, "/units/0/validation/0");
    return true;
  });
  const inherited: any = plan();
  delete inherited.goal_declaration.criteria[0].validation_command;
  inherited.goal_declaration.defaults.validation_command = "manual: inspect outcome";
  inherited.units[0].validation = [inherited.goal_declaration.defaults.validation_command];
  assert.throws(() => parseOperatorPlan(inherited), error => {
    assert.ok(error instanceof OperatorContractError);
    assert.equal(error.diagnostics[0]!.pointer, "/goal_declaration/defaults/validation_command");
    return true;
  });
  for (const command of [
    'node test/check.mjs --label "manual: assertion"',
    '& "C:\\Program Files\\Validator\\check.exe" --mode verify',
    'C:\\tools\\check.exe --target all',
    '"./check:custom" --verify',
    'npm run check:all',
  ]) {
    const value = plan();
    value.goal_declaration.criteria[0]!.validation_command = command;
    value.units[0]!.validation = [command];
    assert.equal(parseOperatorPlan(value).units[0]!.validation[0], command);
  }
});

test("proposal short reference rejects near misses before spend and expands only in the claimed direct child", async () => fixture(async root => {
  const { hooks, started, ledgerPath } = await previewProposal(root);
  const begin = hooks.tool!.sortie_v010_begin_operator_proposal;
  const durable = await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).required("root");
  const canonical = new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).task(durable);
  assert.ok(started.task.prompt.startsWith(proposalRefPrefix));
  assert.ok(Buffer.byteLength(started.task.prompt) < Buffer.byteLength(canonical.prompt));
  const before = await (await RunFlightLedger.openGoal(ledgerPath)).readGoal();
  const invalid = [
    { name: "appended", task: { ...started.task, prompt: `${started.task.prompt}!` } },
    { name: "foreign-root", task: { ...started.task, prompt: changedReference(started.task.prompt, { r: "foreign" }) } },
    { name: "wrong-profile", task: { ...started.task, prompt: changedReference(started.task.prompt, { p: "stable" }) } },
    { name: "stale-phase", task: { ...started.task, prompt: changedReference(started.task.prompt, { s: "submitted" }) } },
    { name: "changed-hash", task: { ...started.task, prompt: changedReference(started.task.prompt, { h: "0".repeat(64) }) } },
    { name: "wrong-role", task: { ...started.task, subagent_type: "dog-worker-v010" } },
  ];
  for (const item of invalid) {
    await assert.rejects(hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: item.name },
      { args: item.task }), /operator-proposal-dispatch-not-authorized/);
  }
  const rejected = await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).required("root");
  assert.equal(rejected.proposal_call_id, null);
  assert.equal(rejected.proposal_session_id, null, "a denied before hook cannot publish a child grant");
  assert.equal(await new OperatorRuntime(root, V010_RUNTIME_PROFILE).read("root"), undefined,
    "a rejected proposal Task cannot enter the execution lane");
  assert.deepEqual((await (await RunFlightLedger.openGoal(ledgerPath)).readGoal()).records, before.records,
    "a byte-identity rejection must not reserve proposal or execution budget");
  assert.match(begin.description, /exact short Task reference/u);
  assert.match(begin.description, /without appending or paraphrasing/u);
  assert.deepEqual(Object.keys(started.task).sort(), ["description", "prompt", "subagent_type"]);
  assert.equal(started.dispatch_instruction,
    "Pass this short Task reference verbatim; do not append or paraphrase it.");

  const nativeArgs = structuredClone(started.task);
  await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "exact-after-reject" },
    { args: nativeArgs });
  assert.deepEqual(nativeArgs, started.task, "root Task history must retain the opaque proposal reference");
  const admitted = await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).required("root");
  assert.equal(admitted.proposal_call_id, "exact-after-reject");
  assert.equal(admitted.proposal_session_id, null);
  const reserved = await (await RunFlightLedger.openGoal(ledgerPath)).readGoal();
  assert.equal(reserved.state.outstanding_reservations.length, 1);
  const changedChild = { message: { agent: "dogs-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
    parts: [{ type: "text", text: `${nativeArgs.prompt}!` }] };
  await assert.rejects(hooks["chat.message"]!({ sessionID: "changed-child", messageID: "changed-user", agent: "dogs-coordinator" },
    changedChild), /task-reference-mismatch/);
  assert.equal(changedChild.parts[0]!.text, `${nativeArgs.prompt}!`, "a rejected child must not receive canonical proposal text");
  assert.equal((await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).required("root")).proposal_session_id, null);
  const childMessage = { message: { agent: "dogs-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
    parts: [{ type: "text", text: nativeArgs.prompt }] };
  await hooks["chat.message"]!({ sessionID: "proposal-child", messageID: "proposal-user", agent: "dogs-coordinator" }, childMessage);
  assert.equal(childMessage.parts[0]!.text, canonical.prompt, "only the claimed child receives the canonical proposal prompt");
  await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "exact-after-reject" },
    { output: "Proposal child returned without submission." });
  assert.equal((await (await RunFlightLedger.openGoal(ledgerPath)).readGoal()).state.outstanding_reservations.length, 0);
}));

test("proposal reference survives cold state and legacy exact canonical prompt remains compatible", async () => fixture(async root => {
  const state = await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).begin("cold-root", intent());
  const short = new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).referenceTask(state);
  const reopened = new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE);
  const expanded = await reopened.admit("cold-root", "cold-call", structuredClone(short));
  assert.deepEqual(expanded, reopened.task(await reopened.required("cold-root")));
  assert.equal(await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).claimAdmittedPrompt(
    "cold-root", "cold-root", "cold-child", short.prompt), expanded.prompt);
  assert.equal(await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).claimAdmittedPrompt(
    "cold-root", "cold-root", "cold-child", short.prompt), expanded.prompt, "cold same-child claim is idempotent");
  await assert.rejects(reopened.admit("cold-root", "duplicate", short), /dispatch-not-authorized/);

  const legacyState = await reopened.begin("legacy-root", intent());
  const legacy = reopened.task(legacyState);
  assert.deepEqual(await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).admit("legacy-root", "legacy-call", legacy), legacy);
  assert.equal(await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).claimAdmittedPrompt(
    "legacy-root", "legacy-root", "legacy-child", legacy.prompt), legacy.prompt);
  const changed = { ...legacy, prompt: `${legacy.prompt} ` };
  const changedState = await reopened.begin("legacy-near-miss", intent());
  await assert.rejects(reopened.admit("legacy-near-miss", "changed", { ...changed,
    prompt: `${reopened.task(changedState).prompt} ` }), /dispatch-not-authorized/);
}));

test("cold single-loader hooks admit the root's saved proposal reference without an execution run", async () => fixture(async root => {
  const { started, ledgerPath } = await previewProposal(root);
  const before = await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).required("root");
  const cold = await previewHooks(root);
  const status = JSON.parse(await cold.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.equal(status.proposal.intent_id, before.intent_id);
  assert.deepEqual(status.task, started.task, "status and begin address the same durable root grant");
  assert.equal(await new OperatorRuntime(root, V010_RUNTIME_PROFILE).read("root"), undefined);

  const args = structuredClone(started.task);
  await cold["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "cold-proposal" }, { args });
  assert.deepEqual(args, started.task, "native Task keeps the exact saved reference");
  const admitted = await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).required("root");
  assert.equal(admitted.root_session_id, before.root_session_id);
  assert.equal(admitted.intent_hash, before.intent_hash);
  assert.deepEqual(admitted.goal_binding, before.goal_binding);
  assert.equal(admitted.proposal_call_id, "cold-proposal");
  assert.equal(admitted.read_count, before.read_count);
  assert.equal(admitted.submission_count, before.submission_count);
  assert.equal(await new OperatorRuntime(root, V010_RUNTIME_PROFILE).read("root"), undefined,
    "proposal dispatch never falls through to execution admission");
  const reserved = await (await RunFlightLedger.openGoal(ledgerPath)).readGoal();
  assert.equal(reserved.state.outstanding_reservations.length, 1);

  const child = { message: { agent: "dogs-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
    parts: [{ type: "text", text: started.task.prompt }] };
  await cold["chat.message"]!({ sessionID: "cold-child", messageID: "cold-child-user", agent: "dogs-coordinator" }, child);
  assert.match(child.parts[0]!.text, /^SORTIE_OPERATOR_PROPOSAL /u);
  assert.equal((await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).required("root")).proposal_session_id, "cold-child");
  await cold["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "cold-proposal" }, { output: "End fixture." });
  const settled = await (await RunFlightLedger.openGoal(ledgerPath)).readGoal();
  assert.equal(settled.state.outstanding_reservations.length, 0);
  assert.equal(settled.state.consumed_units, 1);
}));

test("proposal child claim is serialized, direct-parent-bound, replay-safe, and first-child immutable", async () => fixture(async root => {
  const runtime = new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE);
  const state = await runtime.begin("claim-root", intent());
  const task = runtime.referenceTask(state);
  await runtime.admit("claim-root", "proposal-call", task);
  await assert.rejects(runtime.claimAdmittedPrompt("claim-root", "foreign-parent", "nested", task.prompt), /parent-mismatch/);
  await assert.rejects(runtime.claimAdmittedPrompt("claim-root", "claim-root", "changed", `${task.prompt}\nextra`), /task-reference-mismatch/);
  const foreign = await runtime.begin("foreign-root", intent());
  const foreignTask = runtime.referenceTask(foreign);
  await assert.rejects(runtime.claimAdmittedPrompt("claim-root", "claim-root", "cross-root", foreignTask.prompt), /task-reference-mismatch/);
  assert.equal((await runtime.required("claim-root")).proposal_session_id, null);
  const claims = await Promise.allSettled([
    runtime.claimAdmittedPrompt("claim-root", "claim-root", "child-a", task.prompt),
    runtime.claimAdmittedPrompt("claim-root", "claim-root", "child-b", task.prompt),
  ]);
  assert.equal(claims.filter(result => result.status === "fulfilled").length, 1);
  const winner = claims[0]!.status === "fulfilled" ? "child-a" : "child-b";
  const loser = winner === "child-a" ? "child-b" : "child-a";
  const canonical = runtime.task(await runtime.required("claim-root")).prompt;
  assert.equal(await runtime.claimAdmittedPrompt("claim-root", "claim-root", winner, task.prompt), canonical);
  await assert.rejects(runtime.claimAdmittedPrompt("claim-root", "claim-root", loser, task.prompt), /child-mismatch/);
  await assert.rejects(runtime.bind("claim-root", loser, canonical), /grant-invalid/, "legacy observer cannot overwrite the durable child binding");
  await runtime.accountRead("claim-root", winner, "src/input.ts");
  await runtime.submit("claim-root", winner, packet(1));
  await assert.rejects(new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).claimAdmittedPrompt(
    "claim-root", "claim-root", winner, task.prompt), /grant-invalid/, "submitted proposal references cannot be replayed");
}));

test("approved multi-unit execution returns one delegate reference that expands only in its claimed child", async () => fixture(async root => {
  const { hooks, started, ledgerPath } = await previewProposal(root);
  await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "proposal" }, { args: started.task });
  await hooks["chat.message"]!({ sessionID: "proposal-child", messageID: "proposal-user", agent: "dogs-coordinator" }, {
    message: { agent: "dogs-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
    parts: [{ type: "text", text: started.task.prompt }],
  });
  await hooks["tool.execute.before"]!({ tool: "read", sessionID: "proposal-child", callID: "surface-read" },
    { args: { filePath: "src/input.ts" } });
  const value = packet(1);
  const secondCommand = "node test/second.mjs";
  value.plan.goal_declaration.goal_budget_units = 3;
  value.plan.goal_declaration.criteria.push({ criterion_id: "second", validation_command: secondCommand });
  value.plan.acceptance_proof = [["proof"], ["proof"], ["second"]];
  value.plan.units[0]!.acceptance_indices = [0, 1];
  value.plan.units.push({ id: "second", title: "Finish result", objective: "Complete the second accepted milestone.",
    read: ["src", "test"], write: ["src/second.ts"], validation: [secondCommand], acceptance_indices: [2] });
  value.write_scope.push("src/second.ts");
  value.budget_estimate.execution_units = 2;
  value.coverage[2]!.validation = secondCommand;
  const submitted = JSON.parse(await hooks.tool!.sortie_v010_submit_operator_proposal.execute(
    { proposal_json: JSON.stringify(value) }, { sessionID: "proposal-child" }));
  assert.equal(submitted.status, "submitted");
  await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "proposal" }, { output: "Submitted." });
  const approval = { proposal_id: submitted.proposal_id, revision: submitted.revision, content_hash: submitted.content_hash,
    compared_requirement_ids: requirements.map(item => item.id), decision: "approve", rationale: "Compared every requirement." };
  const approved = JSON.parse(await hooks.tool!.sortie_v010_approve_operator_proposal.execute(
    { approval_json: JSON.stringify(approval) }, { sessionID: "root" }));
  const delegate = approved.execution.task;
  assert.match(delegate.prompt, /^SORTIE_OPERATOR_DELEGATE_REF /);
  const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  const next = JSON.parse(await hooks.tool!.sortie_v010_operator_next.execute({}, { sessionID: "root" }));
  assert.equal(status.next_task_ref, delegate.prompt);
  assert.deepEqual(next.task, delegate);

  // The root re-reads its whole context on every later turn, so a root-facing packet must identify the
  // approved proposal rather than restate it. Approval already froze the plan into the execution run.
  for (const [label, identity] of [["approval", approved], ["status", status.proposal]] as const) {
    assert.equal(identity.proposal, undefined, `${label} must not re-echo the submitted proposal body`);
    assert.equal(identity.content_hash, submitted.content_hash, `${label} must still identify the exact approved revision`);
  }
  assert.equal(JSON.stringify(status).includes(value.plan.units[1]!.objective), false,
    "an approved plan is frozen into the execution run and must not be restated by operator_status");
  assert.deepEqual(status.acceptance, value.plan.acceptance, "the execution packet remains the single acceptance source");
  assert.deepEqual(status.requirements.map((item: { index: number }) => item.index), value.plan.acceptance.map((_: string, index: number) => index));
  for (const requirement of status.requirements) {
    assert.equal(requirement.criterion, undefined,
      "requirements[] is index-aligned with acceptance; restating each criterion duplicated the acceptance text");
  }

  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const state = await runtime.required("root");
  const before = await (await RunFlightLedger.openGoal(ledgerPath)).readGoal();
  await assert.rejects(hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "fabricated" },
    { args: { ...delegate, prompt: runtime.nextWorkerTask(state).prompt } }), /operator-dispatch-not-authorized/);
  assert.deepEqual((await (await RunFlightLedger.openGoal(ledgerPath)).readGoal()).records, before.records,
    "a worker-shaped or fabricated delegate reference must not consume budget");
  const native = { args: structuredClone(delegate) };
  await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "delegate-call" }, native);
  assert.deepEqual(native.args, delegate);
  const childMessage = { message: { agent: "dogs-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
    parts: [{ type: "text", text: native.args.prompt }] };
  await hooks["chat.message"]!({ sessionID: "delegate-child", messageID: "delegate-user", agent: "dogs-coordinator" }, childMessage);
  assert.match(childMessage.parts[0]!.text, /^operator_run_id: /m);
  assert.doesNotMatch(childMessage.parts[0]!.text, /^SORTIE_OPERATOR_DELEGATE_REF /);
}));

test("approval tool diagnoses an extra field, preserves strict identity, and approves the corrected six-field shape", async () => fixture(async root => {
  const { hooks, started, ledgerPath } = await previewProposal(root);
  await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "proposal" }, { args: started.task });
  await hooks["chat.message"]!({ sessionID: "child", messageID: "child-user", agent: "dogs-coordinator" }, {
    message: { agent: "dogs-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
    parts: [{ type: "text", text: started.task.prompt }],
  });
  await hooks["tool.execute.before"]!({ tool: "read", sessionID: "child", callID: "surface-read" },
    { args: { filePath: "src/input.ts" } });
  const submitted = JSON.parse(await hooks.tool!.sortie_v010_submit_operator_proposal.execute(
    { proposal_json: JSON.stringify(packet(1)) }, { sessionID: "child" }));
  await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "proposal" }, { output: "Submitted." });
  const approval = { proposal_id: submitted.proposal_id, revision: submitted.revision, content_hash: submitted.content_hash,
    compared_requirement_ids: requirements.map(item => item.id), decision: "approve", rationale: "Compared every ordered requirement and proof." };
  const approve = hooks.tool!.sortie_v010_approve_operator_proposal;
  for (const description of [approve.description, (approve.args.approval_json as { description: string }).description]) {
    for (const fragment of ["exactly one six-field shape", "proposal_id:string", "revision:integer equal to the current positive proposal revision",
      '"revision":2', 'never "revision":"2"', "compared_requirement_ids:string[]", 'decision:literal "approve"',
      "rationale:nonblank single-line string", "replace rationale with comparison_rationale", "No schema_version",
      "No schema_version, metadata, nested wrapper", "type coercion", "identity mismatches remain denied",
      "observed authoritative build instructions and capability claims", "necessary generator, build, formatter, and exact cleanup command",
      "before post-commit or canonical criterion tests in unit.validation", "required input must be in unit.read", "generated output in unit.write",
      "persistent or transient generated output", "exact cleanup command", "Cleanup may remove only declared unit.write outputs",
      "never approve an arbitrary ignore rule or removal of an undeclared path",
      "root semantic checklist", "not a host claim that static contract parsing detects every build dependency"]) {
      assert.ok(description.includes(fragment), fragment);
    }
  }
  const before = await (await RunFlightLedger.openGoal(ledgerPath)).readGoal();
  const invalid = JSON.parse(await approve.execute(
    { approval_json: JSON.stringify({ schema_version: "0.1", ...approval }) }, { sessionID: "root" }));
  assert.equal(invalid.status, "invalid-approval");
  assert.equal(invalid.code, "operator-proposal-approval-field-unknown");
  assert.deepEqual(invalid.diagnostics, [{ document: "approval", pointer: "/schema_version",
    code: "operator-proposal-approval-field-unknown", rule: "unknown-field", repair_kind: "repair-field",
    repair_paths: ["/schema_version"] }]);
  assert.equal(invalid.diagnostics_truncated, false);
  assert.equal((await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).required("root")).phase, "submitted");
  assert.equal(await new OperatorRuntime(root, V010_RUNTIME_PROFILE).read("root"), undefined);
  assert.deepEqual((await (await RunFlightLedger.openGoal(ledgerPath)).readGoal()).records, before.records,
    "invalid approval shape must not prepare execution or alter budget state");

  await assert.rejects(approve.execute({ approval_json: JSON.stringify({ ...approval, content_hash: "0".repeat(64) }) },
    { sessionID: "root" }), /operator-proposal-approval-identity-mismatch/);
  assert.equal((await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).required("root")).phase, "submitted");
  assert.equal(await new OperatorRuntime(root, V010_RUNTIME_PROFILE).read("root"), undefined);
  assert.deepEqual((await (await RunFlightLedger.openGoal(ledgerPath)).readGoal()).records, before.records,
    "wrong identity must remain denied without preparation or budget effects");

  const corrected = JSON.parse(await approve.execute({ approval_json: JSON.stringify(approval) }, { sessionID: "root" }));
  assert.equal(corrected.status, "approved");
  assert.equal(corrected.proposal_id, submitted.proposal_id);
  assert.equal(corrected.revision, submitted.revision);
  assert.equal(corrected.content_hash, submitted.content_hash);
  assert.ok(corrected.execution.task);
  assert.equal((await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).required("root")).phase, "approved");
}));

test("approval runtime preserves the exact six-field legacy comparison_rationale alias", async () => fixture(async root => {
  const runtime = new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE);
  const started = await runtime.begin("legacy-rationale", intent());
  const task = runtime.task(started);
  await runtime.admit("legacy-rationale", "proposal", task);
  await runtime.bind("legacy-rationale", "child", task.prompt);
  await runtime.accountRead("legacy-rationale", "child", "src/input.ts");
  const submitted = await runtime.submit("legacy-rationale", "child", packet(1));
  const rationale = "Compared every ordered requirement through the legacy field.";
  const approved = await runtime.approve("legacy-rationale", { proposal_id: submitted.proposal_id,
    revision: submitted.proposal_revision, content_hash: submitted.proposal_hash,
    compared_requirement_ids: requirements.map(item => item.id), decision: "approve", comparison_rationale: rationale });
  assert.equal(approved.phase, "approved");
  assert.equal(approved.approval_rationale, rationale);
}));

test("proposal approval excludes a worker Task obtained from the intermediate prepared state", async t => fixture(async root => {
  const { hooks, started, ledgerPath } = await previewProposal(root);
  await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "proposal" }, { args: started.task });
  await hooks["chat.message"]!({ sessionID: "child", messageID: "child-user", agent: "dogs-coordinator" }, {
    message: { agent: "dogs-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
    parts: [{ type: "text", text: started.task.prompt }],
  });
  await hooks["tool.execute.before"]!({ tool: "read", sessionID: "child", callID: "surface-read" },
    { args: { filePath: "src/input.ts" } });
  const submitted = JSON.parse(await hooks.tool!.sortie_v010_submit_operator_proposal.execute(
    { proposal_json: JSON.stringify(packet(1)) }, { sessionID: "child" }));
  assert.equal(submitted.status, "submitted");
  await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "proposal" }, { output: "Submitted." });
  const approval = { proposal_id: submitted.proposal_id, revision: submitted.revision, content_hash: submitted.content_hash,
    compared_requirement_ids: requirements.map(item => item.id), decision: "approve", rationale: "Compared every requirement." };
  let prepared!: () => void, release!: () => void, attempted!: () => void;
  const preparedGate = new Promise<void>(resolve => { prepared = resolve; });
  const approvalGate = new Promise<void>(resolve => { release = resolve; });
  const dispatchAttempt = new Promise<void>(resolve => { attempted = resolve; });
  const order: string[] = [];
  const propose = OperatorRuntime.prototype.propose, approve = OperatorProposalRuntime.prototype.approve;
  const admitWorker = OperatorRuntime.prototype.admitWorker;
  t.mock.method(OperatorRuntime.prototype, "propose", async function (this: OperatorRuntime, ...args: Parameters<typeof propose>) {
    const result = await propose.apply(this, args);
    prepared();
    await approvalGate;
    return result;
  });
  t.mock.method(OperatorProposalRuntime.prototype, "approve", async function (this: OperatorProposalRuntime, ...args: Parameters<typeof approve>) {
    const result = await approve.apply(this, args);
    if (args[2] !== false) order.push("approved");
    return result;
  });
  t.mock.method(OperatorRuntime.prototype, "admitWorker", async function (this: OperatorRuntime, ...args: Parameters<typeof admitWorker>) {
    order.push("dispatch");
    attempted();
    return admitWorker.apply(this, args);
  });
  const approvalResult = hooks.tool!.sortie_v010_approve_operator_proposal.execute(
    { approval_json: JSON.stringify(approval) }, { sessionID: "root" });
  let dispatchResult: Promise<unknown> | undefined;
  try {
    await Promise.race([preparedGate, approvalResult.then(() => { throw new Error("approval-did-not-pause"); })]);
    const next = JSON.parse(await hooks.tool!.sortie_v010_operator_next.execute({}, { sessionID: "root" }));
    assert.ok(next.task, "operator_next can expose the newly persisted task before approval commits");
    dispatchResult = hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "worker" }, { args: next.task });
    // The old path reaches admitWorker here. The protected path remains queued.
    await Promise.race([dispatchAttempt, delay(30)]);
    release();
    const results = await Promise.allSettled([approvalResult, dispatchResult]);
    assert.deepEqual(results.map(result => result.status), ["fulfilled", "fulfilled"], JSON.stringify(results));
    assert.deepEqual(order, ["approved", "dispatch"]);
    const snapshot = await (await RunFlightLedger.openGoal(ledgerPath)).readGoal();
    assert.equal(snapshot.state.consumed_units, 1);
    assert.equal(snapshot.state.outstanding_reservations.length, 1);
    assert.equal(snapshot.state.budget?.max_units, 2);
    assert.equal((await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).required("root")).phase, "approved");
  } finally {
    release();
    await Promise.allSettled([approvalResult, dispatchResult]);
  }
}));

for (const failure of ["registration", "approval-save"] as const) for (const units of [1, 2]) {
  test(`${failure} failure denies ${units === 1 ? "worker" : "delegate"} admission before and after cold restart`, async t => fixture(async root => {
    const { hooks, started, ledgerPath } = await previewProposal(root);
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "proposal" }, { args: started.task });
    await hooks["chat.message"]!({ sessionID: "child", messageID: "child-user", agent: "dogs-coordinator" }, {
      message: { agent: "dogs-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
      parts: [{ type: "text", text: started.task.prompt }],
    });
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: "child", callID: "surface-read" },
      { args: { filePath: "src/input.ts" } });
    const value = packet(1);
    if (units === 2) {
      value.plan.units.push({ ...value.plan.units[0], id: "second", write: ["src/second.ts"], validation: ["node test/second.mjs"] });
      value.plan.goal_declaration.criteria.push({ criterion_id: "second", validation_command: "node test/second.mjs" });
      value.plan.acceptance_proof.forEach(ids => ids.push("second"));
      value.plan.goal_declaration.goal_budget_units = 3;
      value.budget_estimate.execution_units = 2;
      value.write_scope.push("src/second.ts");
    }
    const submitted = JSON.parse(await hooks.tool!.sortie_v010_submit_operator_proposal.execute(
      { proposal_json: JSON.stringify(value) }, { sessionID: "child" }));
    assert.equal(submitted.status, "submitted");
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "proposal" }, { output: "Submitted." });
    const approval = { proposal_id: submitted.proposal_id, revision: submitted.revision, content_hash: submitted.content_hash,
      compared_requirement_ids: requirements.map(item => item.id), decision: "approve", rationale: "Compared every requirement." };
    let blockedFile: string | undefined;
    if (failure === "registration") {
      const original = OperatorRuntime.prototype.propose;
      t.mock.method(OperatorRuntime.prototype, "propose", async function (this: OperatorRuntime, ...args: Parameters<typeof original>) {
        const result = await original.apply(this, args);
        assert.equal(result.status, "prepared");
        if (result.status === "prepared") {
          blockedFile = /^goal_declaration_path: (.+)$/m.exec(result.state.units[0].task.prompt)![1];
          await rename(blockedFile, `${blockedFile}.backup`);
        }
        return result;
      });
    } else {
      const original = OperatorProposalRuntime.prototype.approve;
      t.mock.method(OperatorProposalRuntime.prototype, "approve", async function (this: OperatorProposalRuntime, ...args: Parameters<typeof original>) {
        if (args[2] !== false) {
          const key = createHash("sha256").update("root").digest("hex");
          blockedFile = join(root, V010_RUNTIME_PROFILE.stateDirectory, "operator-proposals", `${key}.json`);
          await rename(blockedFile, `${blockedFile}.backup`);
          await mkdir(blockedFile);
        }
        return original.apply(this, args);
      });
    }
    try {
      await assert.rejects(hooks.tool!.sortie_v010_approve_operator_proposal.execute(
        { approval_json: JSON.stringify(approval) }, { sessionID: "root" }));
      assert.ok(blockedFile, "failure must occur after preparation, at the injected storage boundary");
    } finally {
      if (blockedFile) {
        if (failure === "approval-save") await rm(blockedFile, { recursive: true });
        await rename(`${blockedFile}.backup`, blockedFile);
      }
    }
    const before = await (await RunFlightLedger.openGoal(ledgerPath)).readGoal();
    for (const current of [hooks, await previewHooks(root)]) {
      await current.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" });
      const next = JSON.parse(await current.tool!.sortie_v010_operator_next.execute({}, { sessionID: "root" }));
      assert.ok(next.task, "prepared task remains reachable through the real next tool");
      await assert.rejects(current["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "unapproved" },
        { args: next.task }), /operator-proposal-execution-not-approved/);
      const operator = await new OperatorRuntime(root, V010_RUNTIME_PROFILE).required("root");
      assert.equal(operator.phase, "prepared");
      assert.equal(operator.dispatched, 0);
      assert.equal(operator.operatorCallID, null);
      assert.ok(operator.units.every(unit => unit.callID === null && unit.status === "pending"));
    }
    assert.deepEqual((await (await RunFlightLedger.openGoal(ledgerPath)).readGoal()).records, before.records,
      "denied admission must neither reserve budget nor start work");
    assert.equal((await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).required("root")).phase, "submitted");
  }));
}

test("concurrent proposal grants preserve read and submission limits after rejected operations and restart", async () => fixture(async root => {
  const runtime = new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE);
  const state = await runtime.begin("root", intent());
  const task = runtime.task(state);
  let reservations = 0;
  await assert.rejects(runtime.admit("root", "no-budget", task, async () => { throw new Error("budget-exhausted"); }), /budget-exhausted/);
  const admissions = await Promise.allSettled([
    runtime.admit("root", "first", task, async () => { reservations++; }),
    runtime.admit("root", "second", task, async () => { reservations++; }),
  ]);
  assert.deepEqual(admissions.map(result => result.status), ["fulfilled", "rejected"]);
  assert.equal(reservations, 1, "a denied competing admission must not reserve goal spend");
  await runtime.bind("root", "child", task.prompt);
  const reads = await Promise.allSettled(Array.from({ length: 8 }, () => runtime.accountRead("root", "child")));
  assert.equal(reads.filter(result => result.status === "fulfilled").length, 2);
  for (const result of reads) if (result.status === "rejected") assert.match(result.reason.message, /read-budget-exhausted/);
  const submissions = await Promise.allSettled([
    runtime.submit("root", "child", {}), runtime.submit("root", "child", packet(2)),
  ]);
  assert.equal(submissions[0].status, "rejected");
  assert.equal(submissions[1].status, "rejected");
  if (submissions[1].status === "rejected") assert.match(submissions[1].reason.message, /submission-budget-exhausted/);
  const restored = await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).required("root");
  assert.equal(restored.read_count, 2);
  assert.equal(restored.submission_count, 1);
  assert.equal(restored.proposal_call_id, "first");
  assert.equal(restored.phase, "investigating");
}));

test("concurrent proposal submission and approval each commit once", async () => fixture(async root => {
  const runtime = new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE);
  const state = await runtime.begin("root", intent());
  const task = runtime.task(state);
  await runtime.admit("root", "call", task);
  await runtime.bind("root", "child", task.prompt);
  await runtime.accountRead("root", "child", "src/input.ts");
  const submissions = await Promise.allSettled([
    runtime.submit("root", "child", packet(1)), runtime.submit("root", "child", packet(1)),
  ]);
  assert.deepEqual(submissions.map(result => result.status), ["fulfilled", "rejected"]);
  const submitted = await runtime.required("root");
  const approval = { proposal_id: submitted.proposal_id, revision: submitted.proposal_revision,
    content_hash: submitted.proposal_hash, compared_requirement_ids: requirements.map(item => item.id),
    decision: "approve", rationale: "Compared original requirements and exact evidence." };
  const approvals = await Promise.allSettled([runtime.approve("root", approval), runtime.approve("root", approval)]);
  assert.deepEqual(approvals.map(result => result.status), ["fulfilled", "rejected"]);
  const restored = await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).required("root");
  assert.equal(restored.phase, "approved");
  assert.equal(restored.submission_count, 1);
}));

test("proposal goal reservations and success, failure, cancellation settlements are concurrently idempotent", async () => fixture(async root => {
  await mkdir(join(root, ".git"), { recursive: true });
  let control: Parameters<NonNullable<RuntimeBridge["connected"]>>[0] | undefined;
  const hooks = await SortieDogsPlugin({ directory: root, runtimeBridge: {
    profile: V010_RUNTIME_PROFILE, assetVersion: V010_RUNTIME_ASSET_VERSION,
    connected: value => { control = value; },
  } });
  await hooks["chat.message"]!({ sessionID: "root", messageID: "user-1", agent: "dog-coordinator",
    model: { providerID: "fixture", modelID: "model" } }, {
    message: { agent: "dog-coordinator", model: { providerID: "fixture", modelID: "model" } },
    parts: [{ type: "text", text: "Implement the approved result." }],
  });
  assert.ok(control);
  const binding = await control.proposalGoalBinding("root");
  const key = createHash("sha256").update("v010\0root").digest("hex");
  const ledgerPath = join(root, ".git/sortie-dogs/run-flight-v010", `${key}.json`);
  let consumed = 0;
  for (const disposition of ["succeeded", "failed", "cancelled"] as const) {
    const intentID = `intent-${disposition}`, callID = `call-${disposition}`;
    await Promise.all(Array.from({ length: 4 }, () => control!.reserveProposalBudget("root", intentID, callID, binding)));
    let snapshot = await (await RunFlightLedger.openGoal(ledgerPath)).readGoal();
    assert.equal(snapshot.state.outstanding_reservations.length, 1);
    assert.equal(snapshot.records.filter(({ event }) => event.kind === "dispatch.reserved" && event.unit_id === `proposal:${intentID}`).length, 1);
    await Promise.all(Array.from({ length: 4 }, () => control!.settleProposalBudget("root", intentID, callID, disposition)));
    await assert.rejects(control.settleProposalBudget("root", intentID, callID,
      disposition === "succeeded" ? "failed" : "succeeded"), /settlement-conflict/);
    // Rejected conflicting notifications must not poison the queue or reset spend.
    await control.settleProposalBudget("root", intentID, callID, disposition);
    snapshot = await (await RunFlightLedger.openGoal(ledgerPath)).readGoal();
    assert.equal(snapshot.state.outstanding_reservations.length, 0);
    assert.equal(snapshot.state.consumed_units, ++consumed);
    const settlements = snapshot.records.filter(({ event }) => event.kind === "unit.settled" && event.unit_id === `proposal:${intentID}`);
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0].event.kind === "unit.settled" && settlements[0].event.disposition, disposition);
  }
}));

test("proposal preserves intent, enforces finite grants, and connects only after exact root approval", async () => fixture(async root => {
  const runtime = new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE);
  const started = await runtime.begin("root", intent());
  assert.deepEqual(started.intent.requirements, requirements);
  assert.equal((await runtime.begin("root", intent())).intent_id, started.intent_id, "same intent reuses budget and identity");
  await assert.rejects(runtime.begin("root", { ...intent(), original_request: { text: "unrelated", source_ref: "user:u2" } }), /active-intent-immutable/);
  const task = runtime.task(started);
  await runtime.admit("root", "proposal-call", task);
  await runtime.bind("root", "proposal-child", task.prompt);
  await runtime.accountRead("root", "proposal-child", "src/input.ts");
  await runtime.accountRead("root", "proposal-child");
  await assert.rejects(runtime.accountRead("root", "proposal-child"), /budget-exhausted/);
  await assert.rejects(runtime.submit("root", "foreign-child", packet(2)), /submit-grant-invalid/, "a wrong child cannot use the submit grant");
  const submitted = await runtime.submit("root", "proposal-child", packet(2));
  assert.equal(submitted.phase, "submitted");
  assert.equal(submitted.submission_count, 1);
  assert.equal(await new OperatorRuntime(root, V010_RUNTIME_PROFILE).read("root"), undefined, "submission grants no execution or source-write lane");
  await assert.rejects(runtime.submit("root", "proposal-child", packet(2)), /submit-grant-invalid/);
  await assert.rejects(runtime.approve("foreign-root", { proposal_id: submitted.proposal_id, revision: submitted.proposal_revision,
    content_hash: submitted.proposal_hash, compared_requirement_ids: requirements.map(item => item.id), decision: "approve", rationale: "Wrong root." }), /missing/);
  await assert.rejects(runtime.approve("root", { proposal_id: submitted.proposal_id, revision: 0, content_hash: submitted.proposal_hash,
    compared_requirement_ids: requirements.map(item => item.id), decision: "approve", rationale: "Compared every requirement." }), /identity-mismatch/);
  const approved = await runtime.approve("root", { proposal_id: submitted.proposal_id, revision: submitted.proposal_revision, content_hash: submitted.proposal_hash,
    compared_requirement_ids: requirements.map(item => item.id), decision: "approve", rationale: "Compared original request, negative constraint, and quality oracle directly." });
  assert.equal(approved.phase, "approved");
}));

test("proposal tool returns bounded typed proof diagnostics and accepts corrected shared proof without resetting budgets", async () => fixture(async root => {
  const syntheticRequirements = Array.from({ length: 20 }, (_, index) => ({ id: `R${index + 1}`, text: `Synthetic requirement ${index + 1}`,
    kind: index === 5 ? "negative" as const : index >= 12 && index <= 15 ? "quality" as const : "requirement" as const }));
  const syntheticIntent = { schema_version: "0.1", original_request: { text: "Implement the synthetic multi-requirement result.", source_ref: "user:synthetic" },
    requirements: syntheticRequirements, authoritative_refs: ["user:synthetic"], allow_read: ["src", "test"],
    proposal_budget: { max_reads: 3, max_submissions: 3 } };
  await mkdir(join(root, "src")); await mkdir(join(root, "test")); await writeFile(join(root, "src", "input.ts"), "export {};\n");
  const hooks = await previewHooks(root);
  await hooks["chat.message"]!({ sessionID: "root", messageID: "synthetic-user", agent: "dog-operator",
    model: { providerID: "openai", modelID: "gpt-5.6-sol" } }, {
    message: { agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text: syntheticIntent.original_request.text }],
  });
  const started = JSON.parse(await hooks.tool!.sortie_v010_begin_operator_proposal.execute(
    { intent_json: JSON.stringify(syntheticIntent) }, { sessionID: "root" }));
  const canonicalProposalTask = new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).task(
    await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).required("root"));
  for (const fragment of ["plan.acceptanceは生成・提出せず省略", "hostがdurable intent.requirements", "acceptance_ids等の代替field禁止",
    "acceptance_indicesは0-based", "acceptance_proof[index]", "文字列完全一致", "criterion IDを共有可", "各unitのacceptance_indicesはnonempty",
    'revisionは正のJSON整数。例: "revision":1', '文字列"revision":"1"は禁止', "hostは型変換しない",
    "actual_readsはhostのcanonical accounting", "read budgetをresetせず", "失敗したReadが一律に未計上とも仮定しない",
    "unit.validationはtestだけでなく実行順の完全なcommand列", "Makefile", "generator directive", "repository script",
    "canonical criterion test前", "必要inputはunit.read", "全generator outputはunit.write", "特定generator名・一時file名を推測・hardcodeせず",
    "全generator outputはunit.write", "exact cleanup command", "cleanupはunit.write宣言済みoutputだけ", "任意ignore追加やundeclared path削除は禁止",
    "hostは全build dependencyやgenerator outputを静的推定・自動注入しない", "contract repair decision", "resume evidence toolingで補完せず",
    "undeclared generator、variant、ignore、削除を許可しない"])
    assert.ok(canonicalProposalTask.prompt.includes(fragment), fragment);
  assert.match(hooks.tool!.sortie_v010_submit_operator_proposal.description, /Omit plan\.acceptance.*host derives its exact ordered text/u);
  for (const description of [hooks.tool!.sortie_v010_submit_operator_proposal.description,
    (hooks.tool!.sortie_v010_submit_operator_proposal.args.proposal_json as { description: string }).description]) {
    assert.match(description, /existing_surface array of \{requirement_id:string,path:string,form:string\}/u);
    assert.match(description, /no trailing slash/u);
    assert.match(description, /only and all IDs whose intent kind is negative/u);
    assert.match(description, /revision positive integer, for example "revision":1, never string "revision":"1"/u);
    assert.match(description, /strictly rejects invalid types without coercion/u);
    assert.match(description, /unit\.validation is the complete ordered execution list, not a tests-only list/u);
    assert.match(description, /observed authoritative Makefiles, language generator directives, or repository scripts/u);
    assert.match(description, /every persistent or transient generated output in unit\.write/u);
    assert.match(description, /Cleanup may remove only declared unit\.write outputs/u);
    assert.match(description, /host preserves declared order and authority but does not statically discover or inject every build dependency or generator output/u);
  }
  await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "synthetic-proposal" }, { args: started.task });
  await hooks["chat.message"]!({ sessionID: "child", messageID: "synthetic-child", agent: "dogs-coordinator" }, {
    message: { agent: "dogs-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
    parts: [{ type: "text", text: started.task.prompt }],
  });
  await hooks["tool.execute.before"]!({ tool: "read", sessionID: "child", callID: "synthetic-read" },
    { args: { filePath: "src/input.ts" } });
  const coverage = syntheticRequirements.map(item => ({ requirement_id: item.id, approach: `Handle ${item.id}`,
    validation: "node test/shared-proof.mjs" }));
  const defaults = { target: "synthetic", entrypoint: "test/shared-proof.mjs", workload: "fixture", oracle_coverage: ["all synthetic requirements"],
    build_boundary: "not-applicable", source: "source", candidate: "candidate", source_binding: "current-protected", candidate_binding: "current-protected",
    fixture: "synthetic", proof_scope: "requested-full", expected_outcome: "pass" };
  const malformedCommands = syntheticRequirements.map((_, index) => `node test/proof-${String(index + 1).padStart(2, "0")}.mjs`);
  const existing_surface = syntheticRequirements.map(item => ({ requirement_id: item.id, path: "src/input.ts",
    form: `Observed synthetic fixture surface for ${item.id}` }));
  const basePacket = { schema_version: "0.1", revision: 1, coverage, existing_surface, uncovered: [],
    negative_handling: [{ requirement_id: "R6", handling: "Preserve the protected negative condition." }], read_scope: ["src", "test"],
    write_scope: ["src/first.ts", "src/second.ts"], budget_estimate: { proposal_reads: 1, execution_units: 2 } };
  const malformed = { ...basePacket, plan: { schema_version: "0.1", acceptance: syntheticRequirements.map(item => item.text),
    acceptance_proof: syntheticRequirements.map((_, index) => [`C${String(index + 1).padStart(2, "0")}`]), source_refs: ["user:synthetic"],
    goal_declaration: { delivery_intent: "implementation", delivery_mode: "mvp-first", usable_path_established: false, controlled_change: false,
      goal_budget_units: 3, defaults, criteria: malformedCommands.map((validation_command, index) => ({
        criterion_id: `C${String(index + 1).padStart(2, "0")}`, validation_command })) },
    units: [
      { id: "first", title: "First milestone", objective: "Implement the first milestone.", read: ["src", "test"], write: ["src/first.ts"],
        validation: [malformedCommands[0]!, malformedCommands[18]!], acceptance_indices: Array.from({ length: 19 }, (_, index) => index) },
      { id: "second", title: "Second milestone", objective: "Implement the second milestone.", read: ["src", "test"], write: ["src/second.ts"],
        validation: [malformedCommands[19]!], acceptance_indices: [...Array.from({ length: 18 }, (_, index) => index), 19] },
    ] } };
  delete (malformed.plan as { acceptance?: string[] }).acceptance;
  const invalid = JSON.parse(await hooks.tool!.sortie_v010_submit_operator_proposal.execute(
    { proposal_json: JSON.stringify(malformed) }, { sessionID: "child" }));
  assert.equal(invalid.status, "invalid-proposal");
  assert.equal(invalid.code, "operator-unit-coverage-invalid");
  assert.equal(invalid.actual_reads, 1);
  assert.equal(invalid.submissions, 1);
  assert.equal(invalid.remaining_submissions, 2);
  assert.equal(invalid.diagnostics_truncated, true);
  assert.ok(invalid.diagnostics.length > 0 && invalid.diagnostics.length <= 16);
  assert.deepEqual(Object.keys(invalid.diagnostics[0]).sort(), ["code", "document", "pointer", "repair_kind", "repair_paths", "rule"].sort());
  assert.doesNotMatch(JSON.stringify(invalid.diagnostics), /node test\/proof-/);
  assert.equal(await new OperatorRuntime(root, V010_RUNTIME_PROFILE).read("root"), undefined);
  const proposalOnly = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.equal(proposalOnly.proposal.status, "investigating");
  assert.equal(proposalOnly.proposal.task_admitted, true);
  assert.equal(Object.hasOwn(proposalOnly, "task"), false);
  assert.equal(Object.hasOwn(proposalOnly, "dispatch_instruction"), false);
  assert.match(proposalOnly.next_action, /already admitted; do not redispatch it or call operator_next/u);
  assert.match(proposalOnly.next_action, /same active claimed child/u);
  await assert.rejects(hooks.tool!.sortie_v010_operator_next.execute({}, { sessionID: "root" }), /operator-run-missing/);

  const firstCommand = "node test/shared-first.mjs", secondCommand = "node test/shared-second.mjs";
  const corrected = { ...basePacket, revision: 2, plan: { schema_version: "0.1", acceptance: syntheticRequirements.map(item => item.text),
    acceptance_proof: syntheticRequirements.map((_, index) => [index < 10 ? "shared-first" : "shared-second"]), source_refs: ["user:synthetic"],
    goal_declaration: { delivery_intent: "implementation", delivery_mode: "mvp-first", usable_path_established: false, controlled_change: false,
      goal_budget_units: 3, defaults, criteria: [{ criterion_id: "shared-first", validation_command: firstCommand },
        { criterion_id: "shared-second", validation_command: secondCommand }] },
    units: [
      { id: "first", title: "First milestone", objective: "Implement the first milestone.", read: ["src", "test"], write: ["src/first.ts"],
        validation: [firstCommand], acceptance_indices: Array.from({ length: 10 }, (_, index) => index) },
      { id: "second", title: "Second milestone", objective: "Implement the second milestone.", read: ["src", "test"], write: ["src/second.ts"],
        validation: [secondCommand], acceptance_indices: Array.from({ length: 10 }, (_, index) => index + 10) },
    ] } };
  const submitted = JSON.parse(await hooks.tool!.sortie_v010_submit_operator_proposal.execute(
    { proposal_json: JSON.stringify(corrected) }, { sessionID: "child" }));
  assert.equal(submitted.status, "submitted");
  assert.equal(submitted.reads, 1);
  assert.equal(submitted.submissions, 2);
  assert.deepEqual(submitted.proposal.plan.acceptance, syntheticRequirements.map(item => item.text));
  assert.deepEqual(submitted.proposal.plan.acceptance_proof.slice(0, 2), [["shared-first"], ["shared-first"]]);
  assert.equal(await new OperatorRuntime(root, V010_RUNTIME_PROFILE).read("root"), undefined, "submission still creates no execution run");
  const submittedStatus = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.match(submittedStatus.next_action, /approve the exact proposal/);
}));

test("string revision gets a field diagnostic, preserves default spend, and the corrected number submits without coercion", async () => fixture(async root => {
  await mkdir(join(root, "src")); await mkdir(join(root, "test")); await writeFile(join(root, "src", "input.ts"), "export {};\n");
  const hooks = await previewHooks(root);
  const defaultIntent = { ...intent() };
  delete (defaultIntent as Partial<typeof defaultIntent>).proposal_budget;
  await hooks["chat.message"]!({ sessionID: "root", messageID: "revision-user", agent: "dog-operator",
    model: { providerID: "openai", modelID: "gpt-5.6-sol" } }, {
    message: { agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text: `${defaultIntent.original_request.text}\ngoal_budget_units: 2` }],
  });
  const started = JSON.parse(await hooks.tool!.sortie_v010_begin_operator_proposal.execute(
    { intent_json: JSON.stringify(defaultIntent) }, { sessionID: "root" }));
  assert.deepEqual((await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).required("root")).intent.proposal_budget,
    { max_reads: 45, max_submissions: 9 });
  await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "revision-proposal" }, { args: started.task });
  const ledgerPath = join(root, ".git/sortie-dogs/run-flight-v010",
    `${createHash("sha256").update("v010\0root").digest("hex")}.json`);
  const reserved = await (await RunFlightLedger.openGoal(ledgerPath)).readGoal();
  await assert.rejects(hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "revision-duplicate" },
    { args: structuredClone(started.task) }), /operator-proposal-dispatch-not-authorized/);
  assert.deepEqual((await (await RunFlightLedger.openGoal(ledgerPath)).readGoal()).records, reserved.records,
    "denied second root Task must not reserve another proposal unit");
  await hooks["chat.message"]!({ sessionID: "child", messageID: "revision-child", agent: "dogs-coordinator" }, {
    message: { agent: "dogs-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
    parts: [{ type: "text", text: started.task.prompt }],
  });
  for (let index = 0; index < 13; index++) {
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: "child", callID: `revision-read-${index}` },
      { args: { filePath: "src/input.ts" } });
  }
  for (let index = 0; index < 3; index++) {
    const prior = JSON.parse(await hooks.tool!.sortie_v010_submit_operator_proposal.execute(
      { proposal_json: "{}" }, { sessionID: "child" }));
    assert.equal(prior.status, "invalid-proposal");
    assert.equal(prior.code, "operator-proposal-invalid");
  }
  const invalidPacket = { ...packet(13), revision: "1" };
  const invalid = JSON.parse(await hooks.tool!.sortie_v010_submit_operator_proposal.execute(
    { proposal_json: JSON.stringify(invalidPacket) }, { sessionID: "child" }));
  assert.equal(invalid.status, "invalid-proposal");
  assert.equal(invalid.code, "operator-proposal-revision-invalid");
  assert.equal(invalid.actual_reads, 13);
  assert.equal(invalid.submissions, 4);
  assert.equal(invalid.remaining_submissions, 5);
  assert.equal(invalid.diagnostics_truncated, false);
  assert.deepEqual(invalid.diagnostics, [{ document: "proposal", pointer: "/revision", code: "operator-proposal-revision-invalid",
    rule: "positive-integer", repair_kind: "repair-field", repair_paths: ["/revision"], expected: "positive-integer", actual_type: "string" }]);
  assert.equal(Object.hasOwn(invalid.diagnostics[0], "actual"), false);
  assert.equal(Object.hasOwn(invalid.diagnostics[0], "value"), false);

  const corrected = { ...invalidPacket, revision: 1 };
  const submitted = JSON.parse(await hooks.tool!.sortie_v010_submit_operator_proposal.execute(
    { proposal_json: JSON.stringify(corrected) }, { sessionID: "child" }));
  assert.equal(submitted.status, "submitted");
  assert.equal(submitted.reads, 13);
  assert.equal(submitted.submissions, 5);
  assert.equal(submitted.remaining_submissions, 4);
  assert.equal(submitted.revision, 1);
  assert.equal(typeof submitted.revision, "number");
  assert.equal((await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).required("root")).proposal_revision, 1);
  await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "revision-proposal" }, { output: "Submitted." });
}));

test("an admitted proposal child that terminates unsubmitted has terminal no-redispatch root status", async () => fixture(async root => {
  await mkdir(join(root, "src")); await mkdir(join(root, "test")); await writeFile(join(root, "src", "input.ts"), "export {};\n");
  const hooks = await previewHooks(root);
  const defaultIntent = { ...intent() };
  delete (defaultIntent as Partial<typeof defaultIntent>).proposal_budget;
  await hooks["chat.message"]!({ sessionID: "root", messageID: "terminal-user", agent: "dog-operator",
    model: { providerID: "openai", modelID: "gpt-5.6-sol" } }, {
    message: { agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text: `${defaultIntent.original_request.text}\ngoal_budget_units: 2` }],
  });
  const started = JSON.parse(await hooks.tool!.sortie_v010_begin_operator_proposal.execute(
    { intent_json: JSON.stringify(defaultIntent) }, { sessionID: "root" }));
  await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "terminal-proposal" }, { args: started.task });
  await hooks["chat.message"]!({ sessionID: "child", messageID: "terminal-child", agent: "dogs-coordinator" }, {
    message: { agent: "dogs-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
    parts: [{ type: "text", text: started.task.prompt }],
  });
  await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "terminal-proposal" },
    { output: "Proposal child terminated without submission." });
  const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.equal(status.proposal.status, "investigating");
  assert.equal(status.proposal.task_admitted, true);
  assert.equal(status.proposal.remaining_submissions, 9);
  assert.equal(Object.hasOwn(status, "task"), false);
  assert.equal(Object.hasOwn(status, "dispatch_instruction"), false);
  assert.match(status.next_action, /If that child terminated without submission, report the terminal proposal failure/u);
  assert.match(status.next_action, /does not authorize a new Task, budget reset, or replacement child/u);
  const ledgerPath = join(root, ".git/sortie-dogs/run-flight-v010",
    `${createHash("sha256").update("v010\0root").digest("hex")}.json`);
  const settled = await (await RunFlightLedger.openGoal(ledgerPath)).readGoal();
  assert.equal(settled.state.consumed_units, 1);
  assert.equal(settled.state.outstanding_reservations.length, 0);
  await assert.rejects(hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "terminal-retry" },
    { args: structuredClone(started.task) }), /operator-proposal-dispatch-not-authorized/);
  assert.deepEqual((await (await RunFlightLedger.openGoal(ledgerPath)).readGoal()).records, settled.records,
    "terminal no-retry status must preserve charged spend without another reservation");
}));

test("proposal host materializes omitted acceptance while rejecting every explicitly changed legacy copy", async () => fixture(async root => {
  const boundedIntent = { ...intent(), proposal_budget: { max_reads: 2, max_submissions: 3 } };
  const runtime = new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE);
  const state = await runtime.begin("materialized", boundedIntent);
  const task = runtime.task(state);
  await runtime.admit("materialized", "proposal-call", task);
  await runtime.bind("materialized", "proposal-child", task.prompt);
  await runtime.accountRead("materialized", "proposal-child", "src/input.ts");

  const changed = packet(1);
  changed.plan.acceptance[0] = `${changed.plan.acceptance[0]}!`;
  await assert.rejects(runtime.submit("materialized", "proposal-child", changed), error => {
    assert(error instanceof OperatorContractError);
    assert.equal(error.message, "operator-proposal-acceptance-rewritten");
    assert.deepEqual(error.diagnostics, [{ document: "plan", pointer: "/acceptance", code: "operator-proposal-acceptance-rewritten",
      rule: "omit-for-host-derived-exact-ordered-intent-requirements", repair_kind: "repair-field", repair_paths: ["/acceptance"] }]);
    assert.equal(error.diagnostics_truncated, false);
    return true;
  });
  assert.equal((await runtime.required("materialized")).submission_count, 1);

  const omitted = packet(1);
  omitted.revision = 2;
  delete (omitted.plan as { acceptance?: string[] }).acceptance;
  const submitted = await runtime.submit("materialized", "proposal-child", omitted);
  assert.equal(submitted.submission_count, 2, "host materialization must not reset rejected submission spend");
  assert.deepEqual(submitted.proposal?.plan.acceptance, requirements.map(item => item.text));
  assert.equal(submitted.proposal_hash, createHash("sha256").update(JSON.stringify(submitted.proposal)).digest("hex"));
  assert.match(submitted.proposal_id ?? "", /^proposal-[a-f0-9]{24}$/u);
  const approved = await runtime.approve("materialized", { proposal_id: submitted.proposal_id, revision: submitted.proposal_revision,
    content_hash: submitted.proposal_hash, compared_requirement_ids: requirements.map(item => item.id), decision: "approve",
    rationale: "Compared the host-materialized canonical acceptance with every durable ordered requirement." });
  assert.equal(approved.phase, "approved");

  const variants: [string, (value: ReturnType<typeof packet>) => void, RegExp][] = [
    ["null", value => { (value.plan as unknown as { acceptance: null }).acceptance = null; }, /acceptance-rewritten/],
    ["subset", value => { value.plan.acceptance = value.plan.acceptance.slice(0, -1); }, /acceptance-rewritten/],
    ["reordered", value => { value.plan.acceptance = [...value.plan.acceptance].reverse(); }, /acceptance-rewritten/],
    ["whitespace", value => { value.plan.acceptance[0] = ` ${value.plan.acceptance[0]}`; }, /acceptance-rewritten/],
    ["alias", value => { const raw = value.plan as unknown as Record<string, unknown>; delete raw.acceptance; raw.acceptance_ids = requirements.map(item => item.id); }, /operator-plan-invalid/],
  ];
  for (const [name, mutate, pattern] of variants) {
    const isolated = new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE);
    const isolatedState = await isolated.begin(`changed-${name}`, intent());
    const isolatedTask = isolated.task(isolatedState);
    await isolated.admit(`changed-${name}`, `${name}-call`, isolatedTask);
    await isolated.bind(`changed-${name}`, `${name}-child`, isolatedTask.prompt);
    await isolated.accountRead(`changed-${name}`, `${name}-child`, "src/input.ts");
    const value = packet(1); mutate(value);
    await assert.rejects(isolated.submit(`changed-${name}`, `${name}-child`, value), pattern);
  }
}));

test("proposal preserves a bounded multiline original request byte-for-byte", async () => fixture(async root => {
  const original = "Implement the official request exactly.\n\n- Preserve ordering.\n- Do not summarize 日本語。";
  const value = { ...intent(), original_request: { text: original, source_ref: "user:u1" } };
  const runtime = new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE);
  const started = await runtime.begin("multiline", value);
  assert.equal(started.intent.original_request.text, original);
  assert.equal(started.intent.original_request.source_ref, "user:u1");
  assert.ok(runtime.task(started).prompt.includes(original));
  await assert.rejects(runtime.begin("oversized", { ...intent(), original_request: {
    text: "界".repeat(128 * 1024), source_ref: "user:u1" } }), /operator-intent-invalid/);
}));

test("proposal rejects uncovered approval, read expansion, acceptance rewrite, and budget-reset estimates", async () => fixture(async root => {
  for (const [name, mutate, pattern] of [
    ["scope", (value: any) => { value.read_scope = ["outside"]; }, /read-scope-expanded/],
    ["acceptance", (value: any) => { value.plan.acceptance[0] = "weaker"; }, /acceptance-rewritten/],
    ["budget", (value: any) => { value.budget_estimate.proposal_reads = 0; }, /budget-estimate-mismatch/],
    ["goal-budget", (value: any) => { value.plan.goal_declaration.goal_budget_units = 1; }, /goal-budget-insufficient/],
  ] as const) {
    const runtime = new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE); const state = await runtime.begin(name, intent()); const task = runtime.task(state);
    await runtime.admit(name, `${name}-call`, task); await runtime.bind(name, `${name}-child`, task.prompt);
    await runtime.accountRead(name, `${name}-child`, "src/input.ts");
    const value = packet(1); mutate(value); await assert.rejects(runtime.submit(name, `${name}-child`, value), pattern);
  }
  const runtime = new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE); const state = await runtime.begin("uncovered", intent()); const task = runtime.task(state);
  await runtime.admit("uncovered", "u-call", task); await runtime.bind("uncovered", "u-child", task.prompt);
  await runtime.accountRead("uncovered", "u-child", "src/input.ts");
  const submitted = await runtime.submit("uncovered", "u-child", packet(1, [{ requirement_id: "R1", reason: "Needs root scope decision." }]));
  await assert.rejects(runtime.approve("uncovered", { proposal_id: submitted.proposal_id, revision: submitted.proposal_revision, content_hash: submitted.proposal_hash,
    compared_requirement_ids: requirements.map(item => item.id), decision: "approve", rationale: "Compared." }), /not-approvable/);
}));

test("proposal goal binding survives cold restart without resetting durable read or submission spend", async () => fixture(async root => {
  const binding = { goal_id: "goal-one", revision: 2, scope_epoch: 3,
    acceptance_fingerprint: `sha256:${"a".repeat(64)}` };
  const first = new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE);
  let state = await first.begin("bound-root", intent());
  state = await first.bindGoal("bound-root", binding);
  const task = first.task(state);
  await first.admit("bound-root", "proposal-call", task);
  await first.bind("bound-root", "proposal-child", task.prompt);
  await first.accountRead("bound-root", "proposal-child", "src/input.ts");

  const reopened = new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE);
  const restored = await reopened.begin("bound-root", intent());
  assert.deepEqual(restored.goal_binding, binding);
  assert.equal(restored.read_count, 1);
  assert.equal(restored.proposal_call_id, "proposal-call");
  await assert.rejects(reopened.bindGoal("bound-root", { ...binding, revision: 3 }), /goal-binding-changed/);
  const submitted = await reopened.submit("bound-root", "proposal-child", packet(1));
  assert.equal(submitted.submission_count, 1);
  assert.deepEqual((await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).required("bound-root")).goal_binding, binding);
}));

test("cold proposal state rejects stale proposal content or identity without resetting durable spend", async () => fixture(async root => {
  const investigatingRuntime = new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE);
  const validInvestigating = await investigatingRuntime.begin("investigating", intent());
  validInvestigating.intent.requirements[0]!.text = "caller mutation";
  assert.deepEqual((await investigatingRuntime.required("investigating")).intent.requirements, requirements,
    "returned state must not mutate the durable cache");

  for (const [name, mutate] of [
    ["acceptance", (value: any) => { value.proposal.plan.acceptance[0] += "!"; }],
    ["unit", (value: any) => { value.proposal.plan.units[0].title += "!"; }],
    ["hash", (value: any) => { value.proposal_hash = "0".repeat(64); }],
    ["id", (value: any) => { value.proposal_id = `${value.proposal_id}x`; }],
  ] as const) {
    const session = `tampered-${name}`;
    const runtime = new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE);
    const started = await runtime.begin(session, intent()); const task = runtime.task(started);
    await runtime.admit(session, `${name}-call`, task); await runtime.bind(session, `${name}-child`, task.prompt);
    await runtime.accountRead(session, `${name}-child`, "src/input.ts");
    const submitted = await runtime.submit(session, `${name}-child`, packet(1));
    const statePath = join(root, V010_RUNTIME_PROFILE.stateDirectory, "operator-proposals",
      `${createHash("sha256").update(session).digest("hex")}.json`);
    const canonical = await readFile(statePath, "utf8");
    const corrupted = JSON.parse(canonical); mutate(corrupted); await writeFile(statePath, JSON.stringify(corrupted));
    const reopened = new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE);
    await assert.rejects(reopened.approve(session, { proposal_id: submitted.proposal_id, revision: submitted.proposal_revision,
      content_hash: submitted.proposal_hash, compared_requirement_ids: requirements.map(item => item.id), decision: "approve",
      rationale: "This must not run against corrupt durable state." }), /operator-proposal-state-invalid/);
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).submission_count, 1, "integrity rejection must not reset budget spend");
    await writeFile(statePath, canonical);
    assert.equal((await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).required(session)).phase, "submitted");
  }

  const approvedRuntime = new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE);
  const approvedStart = await approvedRuntime.begin("valid-approved", intent()); const approvedTask = approvedRuntime.task(approvedStart);
  await approvedRuntime.admit("valid-approved", "approved-call", approvedTask);
  await approvedRuntime.bind("valid-approved", "approved-child", approvedTask.prompt);
  await approvedRuntime.accountRead("valid-approved", "approved-child", "src/input.ts");
  const submitted = await approvedRuntime.submit("valid-approved", "approved-child", packet(1));
  await approvedRuntime.approve("valid-approved", { proposal_id: submitted.proposal_id, revision: submitted.proposal_revision,
    content_hash: submitted.proposal_hash, compared_requirement_ids: requirements.map(item => item.id), decision: "approve",
    rationale: "Persist a valid approved phase." });
  assert.equal((await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).required("valid-approved")).phase, "approved");
}));

test("the canonical investigation prompt guides bounded reading without weakening the packet contract", async () => fixture(async root => {
  const runtime = new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE);
  const prompt = runtime.task(await runtime.begin("reading-root", intent())).prompt;
  for (const fragment of [
    "authoritative_refsと既知entrypointから始める",
    "directory巡回を挟まず直接そこへ進み",
    "path未知の時だけ許可scope内のdirectoryやindexをReadして実在を確認する",
    "名前を推測しただけのReadをしない",
    "既存経路、symbol、validation oracle、build recipeを結び付ける",
    "既知location・目次・周辺範囲から必要なoffset/limitを選ぶ",
    "部分Readは探索手段であって完了条件ではない",
    "必要ならfile全体を読む",
    "読込量の少なさ自体を達成度にしない",
    "package/build scriptは後回しにせず",
    "新しい未解決点、参照先、範囲不足、source変化のいずれかを理由とする",
    "Read以外のtoolは要求しない",
    "raw sourceやlogの全文再掲",
    "初回提出で全requirementを扱えるproposalを目指し",
    "uncoveredへ正直に残す",
    "薄いproposalを出してrootへ追加調査を戻す往復を前提にしない",
  ]) assert.ok(prompt.includes(fragment), `bounded reading guidance must state: ${fragment}`);

  // The revision must not smuggle in a new capability, role, schema or a fixed read quota.
  assert.ok(prompt.includes("許可read scope外、source編集、bash、Task、worker実行は禁止"),
    "the existing read-only prohibition must stay intact");
  for (const tool of ["grep", "glob", "webfetch", "sortie_v010_operator_next",
    "dog-scout", "dog-worker", "dog-reviewer"]) {
    assert.ok(!prompt.toLowerCase().includes(tool), `the read-only investigation must not grant ${tool}`);
  }
  assert.doesNotMatch(prompt, /\d+\s*(read|Read)(以内|まで|上限)/u, "no fixed read quota may replace the host budget");
  assert.doesNotMatch(prompt, /全文読込(禁止|不可)/u, "a full read must stay available when the range is insufficient");
  for (const preserved of ["existing_surfaceは各covered requirementにつき最低1件",
    "coverageはnegative/qualityを含む全ordered requirement IDを各1回含める",
    "unit.validationはtestだけでなく実行順の完全なcommand列",
    "永続・一時を問わず全generator outputはunit.writeへ含める",
    "budget_estimate.proposal_readsは推測したfile数でなく、このTaskで完了したRead tool call数",
    "actual_readsはhostのcanonical accounting"]) {
    assert.ok(prompt.includes(preserved), `existing contract must survive: ${preserved}`);
  }
}));

test("an admitted proposal child that terminates without submission is released only by explicit cancellation", async () => fixture(async root => {
  const { hooks, started } = await previewProposal(root, 3);
  await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "stuck-proposal" }, { args: started.task });
  await hooks["chat.message"]!({ sessionID: "child", messageID: "stuck-child", agent: "dogs-coordinator" }, {
    message: { agent: "dogs-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
    parts: [{ type: "text", text: started.task.prompt }],
  });
  await hooks["tool.execute.before"]!({ tool: "read", sessionID: "child", callID: "stuck-read" }, { args: { filePath: "src/input.ts" } });
  // The native child returns without a submitted proposal, which settles its reservation as failed.
  const returned: { output: string } = { output: "" };
  await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "stuck-proposal" }, returned as never);
  assert.equal(JSON.parse(returned.output).status, "investigating");

  const stuck = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.equal(stuck.proposal.task_admitted, true);
  assert.equal(Object.hasOwn(stuck, "task"), false);
  assert.match(stuck.next_action, /cancel_operator with no reason to release this grant/u);
  const registry = new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE);
  const admitted = await registry.required("root");
  await assert.rejects(registry.admit("root", "replacement-call", registry.task(admitted)), /operator-proposal-dispatch-not-authorized/,
    "the terminated child must never be redispatched or replaced");
  await assert.rejects(registry.bind("root", "replacement-child", registry.task(admitted).prompt), /operator-proposal-grant-invalid/);
  await assert.rejects(hooks.tool!.sortie_v010_begin_operator_proposal.execute(
    { intent_json: JSON.stringify({ ...intent(), authoritative_refs: ["user:u2"] }) }, { sessionID: "root" }),
    /operator-proposal-active-intent-immutable/, "the frozen intent stays immutable while the grant is held");
  await assert.rejects(hooks.tool!.sortie_v010_cancel_operator.execute({ reason: "review-blocking" }, { sessionID: "root" }),
    /operator-cancel-reason-invalid/, "a pre-approval release takes no reason");

  const cancelled = JSON.parse(await hooks.tool!.sortie_v010_cancel_operator.execute({}, { sessionID: "root" }));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.scope, "proposal");
  assert.equal(cancelled.released_proposal.reads, 1);
  assert.equal(cancelled.released_proposal.submissions, 0);
  assert.match(cancelled.next_action, /spent reads\/submissions are not restored/u);
  assert.equal(await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).read("root"), undefined);
  await assert.rejects(hooks.tool!.sortie_v010_cancel_operator.execute({}, { sessionID: "root" }), /operator-run-missing/,
    "a released root without any grant stays absent");

  const retried = JSON.parse(await hooks.tool!.sortie_v010_begin_operator_proposal.execute(
    { intent_json: JSON.stringify({ ...intent(), authoritative_refs: ["user:u2"] }) }, { sessionID: "root" }));
  assert.equal(retried.status, "investigating");
  assert.equal(retried.reads, 1);
  assert.equal(retried.remaining_reads, 1);
  assert.notEqual(retried.intent_id, stuck.proposal.intent_id);
  await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "retry-proposal" }, { args: retried.task });
  assert.equal((await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).required("root")).proposal_call_id, "retry-proposal");
}));

test("cancellation keeps an approved proposal bound to its execution lane", async () => fixture(async root => {
  const registry = new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE);
  const started = await registry.begin("approved-root", intent()); const task = registry.task(started);
  await registry.admit("approved-root", "approved-call", task);
  await registry.bind("approved-root", "approved-child", task.prompt);
  await registry.accountRead("approved-root", "approved-child", "src/input.ts");
  const submitted = await registry.submit("approved-root", "approved-child", packet(1));
  await registry.approve("approved-root", { proposal_id: submitted.proposal_id, revision: submitted.proposal_revision,
    content_hash: submitted.proposal_hash, compared_requirement_ids: requirements.map(item => item.id), decision: "approve",
    rationale: "Approve the exact resubmitted proposal." });
  assert.equal(await registry.discardPreApproval("approved-root"), undefined);
  assert.equal((await new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE).required("approved-root")).phase, "approved");
}));
