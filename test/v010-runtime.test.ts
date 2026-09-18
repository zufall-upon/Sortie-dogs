import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { OperatorContractError, OperatorRuntime, operatorGitPathAuthorized, parseOperatorPlan, type OperatorTask } from "../dist/core/operator-runtime.js";
import { OperatorProposalRuntime } from "../dist/core/operator-proposal.js";
import { V010_RUNTIME_PROFILE, STABLE_RUNTIME_PROFILE, canonicalAgent, profileAgent, profileTool } from "../dist/core/runtime-profile.js";
import { initializeProject } from "../dist/core/initialize.js";
import { runtimeAssets as stableAssets } from "../dist/runtime-assets.js";
import { runtimeAssets as previewAssets, COMMUNICATION_LANGUAGE_POLICY, PREVIEW_PRESENTATION_POLICY,
  PREVIEW_TERMINAL_REPORT_POLICY } from "../dist/runtime-assets-v010.js";
import { RUNTIME_ASSET_VERSION, V010_RUNTIME_ASSET_VERSION } from "../dist/asset-version.js";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";
import { fixtureOpenCodeConfig } from "../scripts/release-cli.mjs";
import { boundedToolErrors } from "../scripts/operator-smoke.mjs";
import { expandGoalDeclaration } from "../dist/core/goal-declaration-format.js";
import { SortieDogsPlugin as CorePlugin } from "../dist/plugin/index.js";
import { normalizeCommand } from "../dist/plugin/gate.js";
import { RunFlightLedger } from "../dist/core/run-flight-ledger.js";
import { goalFingerprint } from "../dist/core/goal-bound.js";
import type { RuntimeBridge } from "../dist/plugin/runtime-bridge.js";
import { decoratePreviewHeadings, receiptBoundTerminalText } from "../dist/plugin/receipt-presentation.js";
import { inspectAcceptanceContinuity, MAX_ACCEPTANCE_CONTINUITY_BYTES,
  MAX_ACCEPTANCE_CRITERIA } from "../dist/core/acceptance-continuity.js";

async function fixture(run: (root: string) => Promise<void>) {
  const area = resolve("_testenv");
  await mkdir(area, { recursive: true });
  const root = await mkdtemp(join(area, "v010-"));
  const previousConfig = process.env.OPENCODE_CONFIG_DIR;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(root, "isolated-global-config");
  process.env.OPENCODE_CONFIG_DIR = join(root, "isolated-global-config", "opencode");
  try { await run(root); } finally {
    if (previousConfig === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previousConfig;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    await rm(root, { recursive: true, force: true });
  }
}
function plan() {
  return { schema_version: "0.1", acceptance: ["Preserve all accepted behavior", "Do not modify the oracle"], acceptance_proof: [["first", "second"], ["first", "second"]],
    source_refs: ["fixture:original-request"], goal_declaration: {
      delivery_intent: "implementation", delivery_mode: "mvp-first", usable_path_established: false, controlled_change: false,
      defaults: { target: "accepted behavior", entrypoint: "check.mjs", workload: "fixture", oracle_coverage: ["content"],
        build_boundary: "not-applicable", source: "source", candidate: "candidate", fixture: "fixture",
        source_binding: "current-protected", candidate_binding: "current-protected", proof_scope: "requested-full", expected_outcome: "pass" },
      criteria: ["first", "second"].map(id => ({ criterion_id: id, validation_command: `node check-${id}.mjs` })),
    }, units: ["first", "second"].map(id => ({ id, title: `Implement ${id}`, objective: `Complete ${id} without reducing acceptance`,
      read: [`check-${id}.mjs`], write: [`${id}.txt`], validation: [`node check-${id}.mjs`], acceptance_indices: [0, 1] })) };
}
async function git(root: string, args: readonly string[]): Promise<string> {
  return (await promisify(execFile)("git", [...args], { cwd: root, encoding: "utf8" })).stdout.trim();
}
async function gitRepository(root: string, options: { branch?: string; ignoreRuntime?: boolean } = {}): Promise<string> {
  const branch = options.branch ?? "base";
  await git(root, ["init", `--initial-branch=${branch}`]);
  await git(root, ["config", "user.name", "Fixture User"]);
  await git(root, ["config", "user.email", "fixture@example.invalid"]);
  if (options.ignoreRuntime !== false) await writeFile(join(root, ".gitignore"), ".sortie-dogs/\n.sortie-dogs-v010/\n");
  await writeFile(join(root, "seed.txt"), "base\n");
  await git(root, ["add", "--", ...(options.ignoreRuntime === false ? [] : [".gitignore"]), "seed.txt"]);
  await git(root, ["commit", "-m", "fixture base"]);
  return git(root, ["rev-parse", "HEAD"]);
}
function lifecyclePlan(branch = "feature/bounded", start_ref = "refs/heads/base") {
  const value = plan();
  value.units = [{ id: "complete", title: "Complete approved writes", objective: "Complete all approved writes before post-commit validation.",
    read: ["check-first.mjs", "check-second.mjs"], write: ["first.txt", "second.txt"],
    validation: ["node check-first.mjs", "node check-second.mjs"], acceptance_indices: [0, 1] }];
  return { ...value, git_lifecycle: { branch_create: { branch, start_ref }, commit: { message: "Apply approved operator writes" },
    post_commit_validation: ["node check-second.mjs"] } };
}
function pluginLifecyclePlan(startRef = "refs/heads/base") {
  const value = lifecyclePlan("feature/plugin-api", startRef);
  value.acceptance = ["Committed candidate is clean and has the approved commit message"];
  value.acceptance_proof = [["pre-commit", "post-commit"]];
  value.goal_declaration.criteria = [
    { criterion_id: "pre-commit", validation_command: "node check-pre.mjs" },
    { criterion_id: "post-commit", validation_command: "node check-post.mjs" },
  ];
  value.units = [{ id: "implementation", title: "Implement and commit result", objective: "Write result, then cross the declared post-commit validation boundary.",
    read: ["check-pre.mjs", "check-post.mjs"], write: ["result.txt"],
    validation: ["node check-pre.mjs", "node check-post.mjs"], acceptance_indices: [0] }];
  value.git_lifecycle.post_commit_validation = ["node   check-post.mjs"];
  return value;
}
function generatedOutputLifecyclePlan(branch: string, declareScratch: boolean, includeCleanup: boolean) {
  const validator = "node scripts/validate-generated.mjs";
  return { schema_version: "0.1", acceptance: ["The committed generated output passes the clean native validator"],
    acceptance_proof: [["generated-clean"]], source_refs: ["fixture:observed-generator"], goal_declaration: {
      delivery_intent: "implementation", delivery_mode: "mvp-first", usable_path_established: false, controlled_change: false, goal_budget_units: 2,
      defaults: { target: "generated output", entrypoint: "scripts/validate-generated.mjs", workload: "one harmless generator",
        oracle_coverage: ["committed output and clean repository"], build_boundary: "not-applicable", source: "fixture scripts",
        candidate: "generated/main.txt", fixture: "generic-generator-output", source_binding: "current-protected",
        candidate_binding: "current-protected", proof_scope: "requested-full", expected_outcome: "pass" },
      criteria: [{ criterion_id: "generated-clean", validation_command: validator }],
    }, units: [{ id: "generate", title: "Generate the bounded output", objective: "Run the observed generator and declared cleanup before validation.",
      read: ["scripts/generate.mjs", "scripts/cleanup.mjs", "scripts/validate-generated.mjs"],
      write: ["generated/main.txt", ...(declareScratch ? ["generated/scratch.tmp"] : [])],
      validation: ["node scripts/generate.mjs", ...(includeCleanup ? ["node scripts/cleanup.mjs"] : []), validator], acceptance_indices: [0] }],
    git_lifecycle: { branch_create: { branch, start_ref: "refs/heads/main" }, commit: { message: "Commit generated main output" },
      post_commit_validation: [validator] } };
}
async function generatedOutputRepository(root: string): Promise<string> {
  await gitRepository(root, { branch: "main", ignoreRuntime: false });
  await mkdir(join(root, "scripts"));
  await writeFile(join(root, "scripts", "generate.mjs"), [
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'mkdirSync("generated", { recursive: true });',
    'writeFileSync("generated/main.txt", "generated\\n");',
    'writeFileSync("generated/scratch.tmp", "scratch\\n");',
    "",
  ].join("\n"));
  await writeFile(join(root, "scripts", "cleanup.mjs"), [
    'import { rmSync } from "node:fs";',
    'rmSync("generated/scratch.tmp");',
    "",
  ].join("\n"));
  await writeFile(join(root, "scripts", "validate-generated.mjs"), [
    'import { execFileSync } from "node:child_process";',
    'import { existsSync, readFileSync } from "node:fs";',
    'const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();',
    'if (git("status", "--porcelain=v1") !== "") process.exit(11);',
    'if (readFileSync("generated/main.txt", "utf8") !== "generated\\n") process.exit(12);',
    'if (existsSync("generated/scratch.tmp")) process.exit(13);',
    'if (git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD") !== "generated/main.txt") process.exit(14);',
    "",
  ].join("\n"));
  await git(root, ["add", "--", "scripts/generate.mjs", "scripts/cleanup.mjs", "scripts/validate-generated.mjs"]);
  await git(root, ["commit", "-m", "add generic generator fixture"]);
  return git(root, ["rev-parse", "HEAD"]);
}
type V010Hooks = Awaited<ReturnType<typeof SortieDogsV010Plugin>>;
async function startGeneratedOutputWorker(root: string, proposedPlan: ReturnType<typeof generatedOutputLifecyclePlan>) {
  const identities: Record<string, { agent: string; parentID?: string }> = {
    root: { agent: "dog-operator" }, worker: { agent: "dog-worker-v010", parentID: "root" },
    foreign: { agent: "dog-worker-v010", parentID: "root" },
  };
  const hostMessages: Record<string, Record<string, unknown>[]> = {};
  const hooks = await SortieDogsV010Plugin({ directory: root, client: { session: {
    get: async ({ path }: { path: { id: string } }) => ({ data: identities[path.id] }),
    messages: async ({ path }: { path: { id: string } }) => ({ data: hostMessages[path.id] ?? [] }),
    abort: async () => ({ data: true }),
  } } } as never);
  await hooks["chat.message"]!({ sessionID: "root", messageID: "root-user", agent: "dog-operator" }, {
    message: { agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text: "Generate, clean, commit, and validate the bounded output." }],
  });
  const prepared = JSON.parse(await hooks.tool!.sortie_v010_prepare_operator.execute(
    { plan_json: JSON.stringify(proposedPlan) }, { sessionID: "root" }));
  const taskInput = { args: structuredClone(prepared.task) };
  await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "worker-call" }, taskInput);
  const workerMessage = { message: { agent: "dog-worker-v010", model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text: taskInput.args.prompt }] };
  await hooks["chat.message"]!({ sessionID: "worker", messageID: "worker-user", agent: "dog-worker-v010" }, workerMessage);
  const manifestPath = /^operation_manifest: (.+)$/m.exec(workerMessage.parts[0]!.text)?.[1];
  const handoffPath = /^handoff_path: (.+)$/m.exec(workerMessage.parts[0]!.text)?.[1];
  assert.ok(manifestPath && handoffPath);
  const manifest = JSON.parse(await readFile(resolve(root, manifestPath), "utf8"));
  await hooks["tool.execute.before"]!({ tool: "read", sessionID: "worker", callID: "handoff-read" }, { args: { filePath: handoffPath } });
  await readFile(handoffPath);
  await hooks["tool.execute.after"]!({ tool: "read", sessionID: "worker", callID: "handoff-read", args: { filePath: handoffPath } },
    { output: "inspected" });
  assert.equal(JSON.parse(await hooks.tool!.sortie_v010_bind_write_gate.execute(
    { project_root: root, manifest_path: manifestPath }, { sessionID: "worker" })).status, "bound");
  return { hooks, prepared, manifest, hostMessages };
}
async function executeGeneratedCommand(hooks: V010Hooks, root: string, callID: string, command: string, script: string): Promise<void> {
  const input = { args: { command } };
  await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID }, input);
  const result = await promisify(execFile)(process.execPath, [script], { cwd: root, encoding: "utf8" });
  await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "worker", callID },
    { output: result.stdout, metadata: { exit: 0, status: "completed" } });
}
async function armLifecycleBoundary(runtime: OperatorRuntime, rootID: string): Promise<{ child: string; command: string }> {
  const next = await runtime.next(rootID, rootID) as { task: OperatorTask };
  await runtime.admitWorker(rootID, rootID, "worker-call", next.task);
  const child = `${rootID}-child`;
  await runtime.claimAdmittedWorkerPrompt(rootID, rootID, child, next.task.prompt);
  return { child, command: "node check-second.mjs" };
}
function representativeLongPlan() {
  const commands = [0, 1, 2].map(index => `node verify-${index}.mjs ${`--oracle-${index}=bounded `.repeat(18)}`.trim());
  const objective = `Implement the approved representative workflow without changing its acceptance or unit split. ${"Preserve the complete objective text. ".repeat(45)}`.slice(0, 1672);
  return { schema_version: "0.1", acceptance: ["First fixed oracle passes", "Second fixed oracle passes", "Third fixed oracle passes"],
    acceptance_proof: [["proof-1"], ["proof-2"], ["proof-3"]], source_refs: ["fixture:anonymous-representative-request"],
    goal_declaration: { delivery_intent: "implementation", delivery_mode: "mvp-first", usable_path_established: false, controlled_change: false,
      defaults: { target: "representative workflow", entrypoint: "verify.mjs", workload: "three bounded units", oracle_coverage: ["fixed oracles"],
        build_boundary: "not-applicable", source: "anonymous source", candidate: "anonymous candidate", fixture: "contract-rpt",
        source_binding: "current-protected", candidate_binding: "current-protected", proof_scope: "requested-full", expected_outcome: "pass" },
      criteria: commands.map((validation_command, index) => ({ criterion_id: `proof-${index + 1}`, validation_command })) },
    units: commands.map((validation, index) => ({ id: `unit-${index + 1}`, title: `Representative unit ${index + 1}`, objective,
      read: [`verify-${index}.mjs`], write: [`result-${index}.txt`], validation: [validation], acceptance_indices: [index] })) };
}

test("preview assets coexist with stable assets and markers", async () => fixture(async root => {
  await initializeProject(root);
  const before = await Promise.all(stableAssets.map(asset => readFile(join(root, ".opencode", asset.installPath), "utf8")));
  const installed = await initializeProject(root, "v010");
  assert.equal(installed.version, V010_RUNTIME_ASSET_VERSION);
  assert.equal(previewAssets.length, stableAssets.length + 1);
  assert.equal(new Set(previewAssets.map(asset => asset.installPath)).size, previewAssets.length);
  assert.equal(await readFile(join(root, ".opencode/sortie-dogs.version"), "utf8"), `${RUNTIME_ASSET_VERSION}\n`);
  assert.equal(await readFile(join(root, ".opencode/sortie-dogs-v010.version"), "utf8"), `${V010_RUNTIME_ASSET_VERSION}\n`);
  for (const [index, asset] of stableAssets.entries()) assert.equal(await readFile(join(root, ".opencode", asset.installPath), "utf8"), before[index]);
  for (const asset of previewAssets) {
    assert.equal(asset.version, V010_RUNTIME_ASSET_VERSION);
    assert.equal(await readFile(join(root, ".opencode", asset.installPath), "utf8"), asset.content);
    assert.match(asset.content, new RegExp(V010_RUNTIME_ASSET_VERSION.replaceAll(".", "\\.")));
    if (asset.installPath.startsWith("agent/") && asset.name !== profileAgent(V010_RUNTIME_PROFILE, "dog-coordinator")) assert.match(asset.content, /^hidden: true$/m);
  }
  assert.deepEqual(previewAssets.map(asset => asset.name), [
    "dog-operator", "dog-worker-v010", "dog-luna-worker-v010", "dog-scout-v010",
    "dog-reviewer-v010", "dog-advisor-v010", "sortie-v010", "dogs-coordinator",
  ]);
  const primary = previewAssets.find(asset => asset.name === "dog-operator")!.content;
  assert.match(primary, /^model: openai\/gpt-5\.6-sol$/m);
  assert.match(primary, /^variant: low$/m);
  assert.match(primary, /^  compact_and_continue: false$/m);
  assert.match(primary, /^  "sortie_v010_\*": true$/m);
  assert.match(previewAssets.find(asset => asset.name === "sortie-v010")!.content, /^agent: dog-operator$/m);
  assert.equal((await initializeProject(root, "v010")).status, "unchanged");
}));

test("language follow-up marker upgrades the installed language1 preview", async () => fixture(async root => {
  await initializeProject(root, "v010");
  await writeFile(join(root, ".opencode/sortie-dogs-v010.version"), "0.10.0-beta.1-v0912-language1\n");
  assert.equal((await initializeProject(root, "v010")).version, V010_RUNTIME_ASSET_VERSION);
}));

test("preview role names are a bijection over separate logical authority identities", () => {
  assert.equal(profileAgent(V010_RUNTIME_PROFILE, "dog-coordinator"), "dog-operator");
  assert.equal(profileAgent(V010_RUNTIME_PROFILE, "dog-operator"), "dogs-coordinator");
  assert.equal(canonicalAgent(V010_RUNTIME_PROFILE, "dog-operator"), "dog-coordinator");
  assert.equal(canonicalAgent(V010_RUNTIME_PROFILE, "dogs-coordinator"), "dog-operator");
  assert.equal(new Set(Object.values(V010_RUNTIME_PROFILE.agentNames)).size, Object.values(V010_RUNTIME_PROFILE.agentNames).length);
});

test("operations defaults do not overwrite an explicit native model variant", async () => fixture(async root => {
  const hooks = await SortieDogsV010Plugin({ directory: root }) as Awaited<ReturnType<typeof SortieDogsV010Plugin>> & { config(value: Record<string, unknown>): Promise<void> };
  const uninstalled = { agent: {} };
  await hooks.config(uninstalled);
  assert.deepEqual(uninstalled.agent, {}, "do not synthesize a permissionless agent when its asset is absent");
  const defaults = { agent: { "dogs-coordinator": { mode: "subagent" } } };
  await hooks.config(defaults);
  assert.deepEqual(defaults.agent["dogs-coordinator"], { mode: "subagent", model: "openai/gpt-5.6-terra", variant: "xhigh" });
  const chosen = { agent: { "dogs-coordinator": { mode: "subagent", model: "openai/gpt-5.6-terra", variant: "max" } } };
  await hooks.config(chosen);
  assert.equal(chosen.agent["dogs-coordinator"].variant, "max");
  const asset = previewAssets.find(item => item.name === "dogs-coordinator")!.content;
  assert.doesNotMatch(asset, /^model:|^variant:/m, "markdown must not overwrite the user's native JSON setting");
}));

test("every preview role carries the same user-language contract without translating protocol keys", () => {
  for (const asset of previewAssets) {
    assert.equal(asset.content.split(COMMUNICATION_LANGUAGE_POLICY).length, 2, asset.name);
  }
  assert.match(COMMUNICATION_LANGUAGE_POLICY, /delegated questions, handoff prose, findings and final replies/);
  assert.match(COMMUNICATION_LANGUAGE_POLICY, /Japanese instructions require Japanese/);
  assert.match(COMMUNICATION_LANGUAGE_POLICY, /English instructions require English/);
  assert.match(COMMUNICATION_LANGUAGE_POLICY, /strategy_trigger/);
  assert.match(COMMUNICATION_LANGUAGE_POLICY, /Do not add a separate translation pass or model call/);
});

test("preview keeps canonical game-style guidance and does not decorate unproved text as success", () => {
  const primary = previewAssets.find(asset => asset.name === "dog-operator")!.content;
  assert.ok(primary.includes(PREVIEW_PRESENTATION_POLICY));
  for (const icon of ["🎯", "📊", "🔍", "➡️", "🐾"]) assert.ok(primary.includes(icon));
  const unfinished = "## 確認結果\n検証は未完。";
  assert.equal(receiptBoundTerminalText(unfinished, undefined), unfinished);
  assert.equal(decoratePreviewHeadings(unfinished), "## 🔍 確認結果\n検証は未完。");
  assert.equal(decoratePreviewHeadings("```md\n## Changes\n```"), "```md\n## Changes\n```");
  assert.equal(decoratePreviewHeadings("    ## Changes\ncode"), "    ## Changes\ncode");
});

test("preview primary closes every task turn with one machine terminal checkpoint", () => {
  const primary = previewAssets.find(asset => asset.name === "dog-operator")!.content;
  assert.ok(primary.includes(PREVIEW_TERMINAL_REPORT_POLICY));
  const stable = stableAssets.find(asset => asset.name === "dog-coordinator")!.content;
  for (const marker of ["TERMINAL_STATUS_SEMANTICS_FIXTURE", "TERMINAL_OUTPUT_TEMPLATE"]) {
    const start = stable.indexOf(`${marker}\n`);
    const fixtureText = stable.slice(start, stable.indexOf(`END_${marker}`, start) + `END_${marker}`.length);
    assert.ok(start >= 0 && primary.includes(fixtureText), `${marker} must reuse the canonical body`);
  }
  assert.match(primary, /first non-empty line must be one\nmachine checkpoint: exactly one of DONE, INTERRUPTED, BLOCKED, or NEED_DECISION/);
  assert.match(primary, /Never close a task turn with bare prose/);
  assert.match(primary, /DONE requires a succeeded sortie_v010_complete_operator receipt/);
  assert.match(primary, /TRUE_INTERRUPTION: user: <condition>/);
  assert.match(primary, /TRUE_INTERRUPTION: internal: <condition>/);
  assert.match(primary, /an active contract returns sortie_v010_operator_status and the existing next Task/);
  assert.match(primary, /unavailable contract-repair validation resume returns the preserved run state/);
  assert.match(primary, /stop retrying and return one INTERRUPTED checkpoint naming that refusal/);
  for (const icon of ["✅", "⚠️", "⛔", "❓"]) assert.ok(primary.includes(icon), icon);
});

test("preview primary continues approved sequential scope and uses interactive questions", () => {
  const primary = previewAssets.find(asset => asset.name === "dog-operator")!.content;
  assert.match(primary, /accepted finite scope without asking for confirmation after each unit/);
  assert.match(primary, /use the built-in question tool in the same turn/);
  assert.match(primary, /Never end with a prose-only\nquestion/);
  assert.match(primary, /Respect required user Visual Go/);
  assert.match(primary, /After the answer, resume the same work/);
  assert.match(primary, /question is unavailable/);
  assert.match(primary, /decision=operator-acceptance-remediation-required/);
  assert.match(primary, /cancel the current run, then\nprepare one approved replacement plan for the same goal and byte-exact ordered acceptance/);
  assert.match(primary, /failed committed run with no accepted predecessor/);
  assert.match(primary, /awaiting-acceptance[\s\S]+blocking findings[\s\S]+autonomous\nroot authority/);
  assert.match(primary, /reason=review-blocking/);
  assert.match(primary, /do not complete, ask the user for approval/);
  assert.match(primary, /Ask the\nuser only when acceptance, write scope, or budget must increase/);
  assert.match(primary, /worker's success or canonical validation PASS never auto-accepts/);
  assert.match(primary, /Do not refresh the same inventory after every child return/);
  assert.match(primary, /missing_evidence_code: <one of manifest \| validation \| owner-risk>/);
  assert.match(primary, /at most four known_paths/);
});

test("operator control packet preserves Japanese user prose as language context", async () => fixture(async root => {
  const request = plan();
  request.acceptance = ["表示窓を確認する", "既存の検証を変更しない"];
  request.units[0]!.title = "表示経路を確認";
  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const state = await runtime.prepare("language-root", request);
  const task = runtime.operatorTask(state);
  assert.match(task.prompt, /communication_context: .*表示経路を確認/);
  assert.match(task.prompt, /表示窓を確認する/);
  assert.deepEqual(state.acceptance, request.acceptance);
  assert.match(task.prompt, /^operator_contract: /m);
}));

test("preview default Sol low resolves without an injected catalog", async () => fixture(async root => {
  const hooks = await SortieDogsV010Plugin({ directory: root, client: { config: { providers: async () => ({ data: {
    providers: [{ id: "openai", models: { "gpt-5.6-sol": { id: "gpt-5.6-sol" } } }],
  } }) } } } as never);
  const output = { message: { agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-5.6-sol", variant: undefined as string | undefined } }, parts: [] };
  await hooks["chat.message"]!({ sessionID: "default", agent: "dog-operator", messageID: "user" }, output);
  assert.equal(output.message.model.modelID, "gpt-5.6-sol");
  assert.equal(output.message.model.variant, "low");
}));

test("preview preserves the user's Astra Low selection across subsequent turns", async () => fixture(async root => {
  const hooks = await SortieDogsV010Plugin({ directory: root });
  const selected = { providerID: "openai", modelID: "gpt-6-astra", variant: "low" };
  const first = { message: { agent: "dog-operator", model: { ...selected } }, parts: [] };
  await hooks["chat.message"]!({ sessionID: "chosen", agent: "dog-operator", messageID: "u1", model: selected }, first);
  assert.deepEqual(first.message.model, selected);
  const next = { message: { agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-5.6-sol" } }, parts: [] };
  await hooks["chat.message"]!({ sessionID: "chosen", agent: "dog-operator", messageID: "u2" }, next);
  assert.deepEqual(next.message.model, selected);
}));

test("preview external routing is converted before merging and rejects aliases", async () => fixture(async root => {
  const client = { config: { providers: async () => ({ data: { providers: [{ id: "openai", models: {
    "gpt-6-astra": { id: "gpt-6-astra" }, "gpt-5.6-sol": { id: "gpt-5.6-sol" },
  } }] } }) } };
  const hooks = await SortieDogsV010Plugin({ directory: root, client } as never, {
    modelRouting: { "dog-operator": { preferred: { model: "openai/gpt-6-astra", variant: "high" } },
      "dogs-coordinator": { preferred: { model: "openai/gpt-5.6-sol", variant: "medium" } } },
    modelCatalog: { global: [{ model: "openai/gpt-6-astra", variants: ["high"] }, { model: "openai/gpt-5.6-sol", variants: ["low", "medium"] }] },
  });
  const output = { message: { agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-5.6-sol" } }, parts: [] };
  await hooks["chat.message"]!({ sessionID: "configured", agent: "dog-operator", messageID: "user" }, output);
  assert.equal(output.message.model.modelID, "gpt-6-astra");
  await assert.rejects(SortieDogsV010Plugin({ directory: root }, { modelRouting: {
    "dog-operator": { preferred: { model: "openai/gpt-5.6-sol", variant: "low" } },
    "dog-coordinator": { preferred: { model: "openai/gpt-6-astra", variant: "high" } },
  } }), /route-collision/);
}));

test("rename migration rejects unowned new-name targets before modifying any file", async () => fixture(async root => {
  const agents = join(root, ".opencode", "agent");
  await mkdir(agents, { recursive: true });
  const marker = join(root, ".opencode", "sortie-dogs-v010.version");
  await writeFile(marker, "0.10.0-beta.1\n");
  await writeFile(join(agents, "dog-operator.md"), "my unrelated primary\n");
  await writeFile(join(agents, "dog-coordinator-v010.md"), "my edited old primary\n");
  await assert.rejects(initializeProject(root, "v010"), /unknown ownership/);
  assert.equal(await readFile(marker, "utf8"), "0.10.0-beta.1\n");
  assert.equal(await readFile(join(agents, "dog-operator.md"), "utf8"), "my unrelated primary\n");
  assert.equal(await readFile(join(agents, "dog-coordinator-v010.md"), "utf8"), "my edited old primary\n");
  await assert.rejects(lstat(join(agents, "dogs-coordinator.md")), { code: "ENOENT" });
}));

function oldRoleAsset(name: "dog-operator" | "dogs-coordinator"): string {
  let content = previewAssets.find(asset => asset.name === name)!.content;
  if (name === "dogs-coordinator") content = content.replace("hidden: true\n", "hidden: true\nmodel: openai/gpt-5.6-terra\nvariant: high\n");
  const oldDescription = name === "dog-operator"
    ? "description: Sortie-dogs v0.10 preview — strategic coordinator with an optional bounded operator."
    : "description: Sortie-dogs v0.10 bounded operations delegate; no source or acceptance authority.";
  return content
    .replace(/For a nontrivial request whose source facts,[\s\S]*?whose complete contract is already known\.\n\n/u, "")
    .replace(/^  sortie_v010_submit_operator_proposal: true\n/m, "")
    .replace(/When the prompt starts SORTIE_OPERATOR_PROPOSAL[\s\S]*?For an admitted execution queue, call\n/u, "Call ")
    .replace(PREVIEW_TERMINAL_REPORT_POLICY, "")
    .replace(PREVIEW_PRESENTATION_POLICY + "\n", "")
    .replace(/## Existing-run evidence reconciliation[\s\S]*?bypasses the delegate\.\n\n/u, "")
    .replace(/When operator_status returns decision=operator-acceptance-remediation-required,[\s\S]*?A reviewer finding alone is not such an increase\.\n\n/u, "")
    .replace(/Keep candidate_id stable for the logical review lineage[\s\S]*?it does not invent it\.\n/u, "")
    .replace(/^  question: allow\n/m, "")
    .replace(/^  compact_and_continue: false\n/m, "")
    .replace(/review remains skipped and recorded\. review_phase must be one of[\s\S]*?Supply canonical_validation_exit: 0, recognized risk_tags, candidate_id,/u,
      "review remains skipped and recorded. Supply review_phase, canonical_validation_exit: 0, recognized risk_tags, candidate_id,")
    .replace(/Invalid plans return a root-owned draft_id[\s\S]*?Diagnostics never echo user values\.\n\n/u, "")
    .replace(/After every original requirement is evidenced[\s\S]*?npm publication remains manual\./u,
      "Only emit DONE after every original requirement is evidenced and required review is satisfied. The canonical goal engine\nremains the terminal authority. Preserve existing commit/release/publish authorization; npm publication remains manual.")
    .replace(/## Bounded scout contract[\s\S]*?Do not guess alternate header names\.\n\n/u, "")
    .replace(/## Sequential work and interactive decisions[\s\S]*?do not pretend the tool was used\.\n\n/u, "")
    .replace(COMMUNICATION_LANGUAGE_POLICY, "")
    .replace(/Do not manually reconstruct,[\s\S]*?to work around an admission error\.\n/u, "")
    .replace(/Copy the returned Task's subagent_type, description, and prompt verbatim into Task\. Worker prompts may be a short\nSORTIE_OPERATOR_TASK_REF[\s\S]*?reference\. A one-unit request returns/u,
      "Copy the returned Task's subagent_type, description, and prompt verbatim into Task. A one-unit request returns")
    .replace(/After compaction in the proposal phase, preserve the\n[\s\S]*?reconstructing criteria from a summary\./u,
      "After compaction, call next to read authoritative state\nrather than reconstructing criteria from a summary.")
    .replace(/Cancellation does not close[\s\S]*?unrelated historical contracts\.\n/u, "")
    .replace(/Use sortie_v010_cancel_operator to stop an active grant before changing its scope, following an explicit\noperator-acceptance-remediation-required replacement action, or performing the bounded awaiting-acceptance\nreason=review-blocking replacement above\./u,
      "Use sortie_v010_cancel_operator to stop an active grant before changing its scope.")
    .replace(/Every advisor Task must include exactly one standalone line:[\s\S]*?just to repair this header\.\n\n/u, "")
    .replace(/^description: .*$/m, oldDescription)
    .replace(/^model: openai\/gpt-5\.6-sol$/m, "model: openai/gpt-6-astra")
    .replace(/^variant: low$/m, "variant: high")
    .replaceAll(V010_RUNTIME_ASSET_VERSION, "0.10.0-beta.1")
    .replaceAll("dogs-coordinator", "__OLD_OPERATIONS__")
    .replaceAll("dog-operator", "dog-coordinator-v010")
    .replaceAll("__OLD_OPERATIONS__", "dog-operator-v010");
}

test("preview reinitialization removes only byte-matched generated old role names", async () => fixture(async root => {
  const agents = join(root, ".opencode", "agent");
  await mkdir(agents, { recursive: true });
  await writeFile(join(root, ".opencode", "sortie-dogs-v010.version"), "0.10.0-beta.1\n");
  const oldPrimary = oldRoleAsset("dog-operator");
  const oldDelegate = oldRoleAsset("dogs-coordinator");
  assert.equal(createHash("sha256").update(oldPrimary).digest("hex"), "50eb6392bdd98865b28ba3620781d1d27ab197c7211290745c6db39a0ed8db90");
  assert.equal(createHash("sha256").update(oldDelegate).digest("hex"), "6f2fc1b4ae2bdadcd61b0984636930b60dc84218187107e39c8e1c32c33260cf");
  await writeFile(join(agents, "dog-coordinator-v010.md"), oldPrimary);
  await writeFile(join(agents, "dog-operator-v010.md"), oldDelegate);

  const result = await initializeProject(root, "v010");
  assert.deepEqual(result.preservedLegacyPaths, []);
  await assert.rejects(lstat(join(agents, "dog-coordinator-v010.md")), { code: "ENOENT" });
  await assert.rejects(lstat(join(agents, "dog-operator-v010.md")), { code: "ENOENT" });
  assert.match(await readFile(join(agents, "dog-operator.md"), "utf8"), /^mode: primary$/m);
  assert.match(await readFile(join(agents, "dogs-coordinator.md"), "utf8"), /^mode: subagent$/m);
}));

test("preview reinitialization preserves and reports an edited old role asset", async () => fixture(async root => {
  const oldPath = join(root, ".opencode", "agent", "dog-coordinator-v010.md");
  await mkdir(join(root, ".opencode", "agent"), { recursive: true });
  await writeFile(join(root, ".opencode", "sortie-dogs-v010.version"), "0.10.0-beta.1\n");
  await writeFile(oldPath, `${oldRoleAsset("dog-operator")}\nUser edit.\n`);
  const result = await initializeProject(root, "v010");
  assert.deepEqual(result.preservedLegacyPaths, [".opencode/agent/dog-coordinator-v010.md"]);
  assert.match(await readFile(oldPath, "utf8"), /User edit/);
}));

test("only the isolated preview fixture enables two-level native subagents", () => {
  assert.equal(fixtureOpenCodeConfig("/tmp/preview.js", V010_RUNTIME_PROFILE).subagent_depth, 2);
  assert.equal("subagent_depth" in fixtureOpenCodeConfig("/tmp/stable.js", STABLE_RUNTIME_PROFILE), false);
});

test("operator smoke retains only bounded typed tool errors", () => {
  const detail = "Subagent depth limit reached (1).\nraw host log must not persist";
  assert.deepEqual(boundedToolErrors([
    { type: "log", message: "authentication details" },
    { type: "tool_use", part: { tool: "task", state: { status: "error", error: detail } } },
    { type: "tool_use", part: { tool: "read", state: { status: "completed", output: "raw output" } } },
  ]), [{ tool: "task", status: "error", error: "Subagent depth limit reached (1)." }]);
  assert.equal(boundedToolErrors([{ type: "tool_use", part: { tool: "task", state: {
    status: "error", error: "x".repeat(2048),
  } } }])[0].error.length, 1024);
});

test("preview host adapter pins the native worker route and forwards terminal text through goal verification", async () => fixture(async root => {
  const client = { config: { providers: async () => ({ data: { providers: [{ id: "openai", models: {
    "gpt-6-astra": { id: "gpt-6-astra" }, "gpt-5.6-terra": { id: "gpt-5.6-terra" },
    "gpt-5.6-sol": { id: "gpt-5.6-sol" }, "gpt-5.6-luna": { id: "gpt-5.6-luna" },
  } }] } }) } };
  const hooks = await SortieDogsV010Plugin({ directory: root, client } as never, { modelCatalog: { global: [
    { model: "openai/gpt-6-astra", variants: ["high"] },
    { model: "openai/gpt-5.6-terra", variants: ["high", "xhigh"] },
    { model: "openai/gpt-5.6-sol", variants: ["low", "medium"] },
    { model: "openai/gpt-5.6-luna", variants: ["max", "high", "xhigh"] },
  ] } });
  const config = { agent: {
    "dog-operator": { mode: "primary", model: "user/selected", variant: "custom" },
    "dog-worker-v010": { mode: "subagent" },
  } };
  await (hooks as typeof hooks & { config(value: Record<string, unknown>): Promise<void> }).config(config);
  assert.deepEqual(config.agent["dog-worker-v010"], {
    mode: "subagent", model: "openai/gpt-5.6-luna", variant: "max",
  });
  assert.deepEqual(config.agent["dog-operator"], { mode: "primary", model: "user/selected", variant: "custom" });
  const explicit = { agent: { "dog-worker-v010": { mode: "subagent", model: "openai/gpt-6-astra", variant: "low" } } };
  await (hooks as typeof hooks & { config(value: Record<string, unknown>): Promise<void> }).config(explicit);
  assert.deepEqual(explicit.agent["dog-worker-v010"], { mode: "subagent", model: "openai/gpt-6-astra", variant: "low" });
  const workerMessage = { message: { agent: "dog-worker-v010", model: { providerID: "openai", modelID: "gpt-5.6-sol" } }, parts: [] };
  await hooks["chat.message"]!({ sessionID: "explicit-worker", messageID: "worker-user", agent: "dog-worker-v010" }, workerMessage);
  assert.deepEqual(workerMessage.message.model, { providerID: "openai", modelID: "gpt-6-astra", variant: "low" });

  const explicitAstra = {
    message: { id: "root-user", agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-6-astra", variant: "high" } },
    parts: [{ type: "text", text: "Implement the accepted goal." }],
  };
  await hooks["chat.message"]!({ sessionID: "root", messageID: "root-user", agent: "dog-operator",
    model: { providerID: "openai", modelID: "gpt-6-astra" } }, explicitAstra);
  assert.deepEqual(explicitAstra.message.model, { providerID: "openai", modelID: "gpt-6-astra", variant: "high" });
  const premature = { text: "DONE — accepted without evidence" };
  await hooks["experimental.text.complete"]!({ sessionID: "root", messageID: "root-assistant" }, premature);
  assert.equal(premature.text, "status: INTERRUPTED — accepted criteria remain unproved\nTRUE_INTERRUPTION: internal: accepted criteria remain unproved");
}));

function wideAcceptancePlan(count: number, criterion = (index: number) => `Criterion ${index + 1} holds`) {
  const ids = Array.from({ length: count }, (_value, index) => `c${index + 1}`);
  const value = plan();
  value.acceptance = ids.map((_id, index) => criterion(index));
  value.acceptance_proof = ids.map(id => [id]);
  value.goal_declaration.criteria = ids.map(id => ({ criterion_id: id, validation_command: "node check-first.mjs" }));
  value.units = [{ id: "first", title: "Implement every accepted criterion", objective: "Complete all accepted criteria in one unit.",
    read: ["check-first.mjs"], write: ["first.txt"], validation: ["node check-first.mjs"],
    acceptance_indices: ids.map((_id, index) => index) }];
  return value;
}

test("a wide accepted scope reaches the worker with an exact readable continuity ledger", async () => fixture(async root => {
  for (const count of [1, 25, 27, MAX_ACCEPTANCE_CRITERIA]) {
    const request = wideAcceptancePlan(count);
    const state = await new OperatorRuntime(join(root, `wide-${count}`), V010_RUNTIME_PROFILE).prepare("root", request);
    const handoff = JSON.parse(await readFile(state.units[0]!.handoffPath, "utf8"));
    const inspected = inspectAcceptanceContinuity(handoff);
    assert.equal(inspected.error, undefined, `${count} accepted criteria must dispatch a readable ledger`);
    assert.deepEqual(inspected.ledger?.criteria, request.acceptance, `${count} accepted criteria must keep exact order`);
    assert.deepEqual(state.acceptance, request.acceptance);
  }
}));

test("an unreadable acceptance ledger is refused at preparation instead of at worker inspection", async () => fixture(async root => {
  const excessive = join(root, "excessive");
  await assert.rejects(new OperatorRuntime(excessive, V010_RUNTIME_PROFILE).prepare("root", wideAcceptancePlan(MAX_ACCEPTANCE_CRITERIA + 1)),
    (error: unknown) => {
      assert.ok(error instanceof OperatorContractError);
      assert.deepEqual(error.diagnostics, [{ document: "plan", pointer: "/acceptance", code: "operator-plan-acceptance-too-many",
        rule: "bounded-accepted-criteria", repair_kind: "repair-field", length: MAX_ACCEPTANCE_CRITERIA + 1, limit: MAX_ACCEPTANCE_CRITERIA }]);
      return true;
    });
  await assert.rejects(lstat(join(excessive, V010_RUNTIME_PROFILE.stateDirectory, "contracts")), { code: "ENOENT" });

  const oversize = join(root, "oversize");
  await assert.rejects(new OperatorRuntime(oversize, V010_RUNTIME_PROFILE).prepare("root",
    wideAcceptancePlan(30, index => `Criterion ${index + 1} holds `.padEnd(1500, "x"))),
  (error: unknown) => {
    assert.ok(error instanceof OperatorContractError);
    const [diagnostic] = error.diagnostics;
    assert.equal(diagnostic?.document, "handoff");
    assert.equal(diagnostic?.pointer, "/ext/acceptance-continuity");
    assert.equal(diagnostic?.code, "operator-acceptance-continuity-oversize");
    assert.equal(diagnostic?.rule, "worker-readable-acceptance-ledger");
    assert.equal(diagnostic?.limit, MAX_ACCEPTANCE_CONTINUITY_BYTES);
    assert.ok((diagnostic?.length ?? 0) > MAX_ACCEPTANCE_CONTINUITY_BYTES);
    return true;
  });
  await assert.rejects(lstat(join(oversize, V010_RUNTIME_PROFILE.stateDirectory, "contracts")), { code: "ENOENT" });
}));

test("operator plan validates explicit scope and keeps criteria immutable", async () => fixture(async root => {
  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const original = plan();
  const state = await runtime.prepare("root", original);
  assert.deepEqual(state.acceptance, original.acceptance);
  for (const unit of state.units) {
    const handoff = JSON.parse(await readFile(unit.handoffPath, "utf8"));
    assert.deepEqual(handoff.ext["sortie-dogs/acceptance-continuity"].criteria, original.acceptance);
    assert.match(unit.task.subagent_type, /-v010$/);
  }
  assert.equal(runtime.operatorTask(state).subagent_type, "dogs-coordinator");
  assert.match(runtime.operatorTask(state).prompt, /all observed persistent and transient generator outputs are in unit\.write/u);
  assert.match(runtime.operatorTask(state).prompt, /Missing capability, output, or cleanup requires contract repair, not resume evidence/u);
  assert.equal((await runtime.prepare("root", original)).runID, state.runID);
  await assert.rejects(runtime.prepare("root", { ...original, acceptance: ["Weaker objective", original.acceptance[1]] }), /immutable/);
  assert.throws(() => parseOperatorPlan({ ...original, extra: true }), /invalid/);
  assert.throws(() => parseOperatorPlan({ ...original, units: [{ ...original.units[0], write: ["../outside"] }] }));
}));

test("Git lifecycle uses the existing canonical command identity and requires an ordered contiguous final suffix", () => {
  const spaced = lifecyclePlan();
  spaced.git_lifecycle.post_commit_validation = ["node   check-second.mjs"];
  assert.doesNotThrow(() => parseOperatorPlan(spaced));

  const nonSuffix = lifecyclePlan();
  nonSuffix.git_lifecycle.post_commit_validation = ["node check-first.mjs"];
  assert.throws(() => parseOperatorPlan(nonSuffix), (error: unknown) => error instanceof OperatorContractError &&
    error.diagnostics[0]?.code === "operator-git-post-commit-validation-invalid");
  const reversed = lifecyclePlan();
  reversed.git_lifecycle.post_commit_validation = ["node check-second.mjs", "node check-first.mjs"];
  assert.throws(() => parseOperatorPlan(reversed), /operator-git-post-commit-validation-invalid/);

  const quoted = '& "C:\\Tools\\PowerShell\\pwsh.exe" -File check.ps1';
  const canonical = "C:\\Tools\\PowerShell\\pwsh.exe -File check.ps1";
  assert.equal(normalizeCommand(quoted), canonical);
  const windows = lifecyclePlan();
  windows.goal_declaration.criteria[1]!.validation_command = canonical;
  windows.units[0]!.validation[1] = canonical;
  windows.git_lifecycle.post_commit_validation = [quoted];
  assert.doesNotThrow(() => parseOperatorPlan(windows));
});

test("typed Git lifecycle creates a general branch at the pinned start and commits only the approved write union", async () => fixture(async root => {
  const base = await gitRepository(root);
  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const state = await runtime.prepare("git-root", lifecyclePlan());
  assert.equal(await git(root, ["symbolic-ref", "--short", "HEAD"]), "feature/bounded");
  assert.equal(await git(root, ["rev-parse", "HEAD"]), base, "branch creation must not synthesize a commit");
  assert.equal(state.gitLifecycle?.startOID, base);
  assert.deepEqual(state.gitLifecycle?.postCommitValidation, ["node check-second.mjs"]);
  await writeFile(join(root, "first.txt"), "first\n");
  await writeFile(join(root, "second.txt"), "second\n");
  const boundary = await armLifecycleBoundary(runtime, "git-root");
  await runtime.beforePostCommitValidation("git-root", boundary.child, boundary.command);
  const completed = await runtime.required("git-root");
  assert.equal(completed.phase, "running", "acceptance still requires native post-commit validation evidence");
  assert.match(completed.gitLifecycle?.committedHead ?? "", /^[a-f0-9]{40,64}$/u);
  assert.notEqual(completed.gitLifecycle?.committedHead, base);
  assert.deepEqual((await git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])).split(/\r?\n/u).sort(),
    ["first.txt", "second.txt"]);
  assert.equal(await git(root, ["status", "--porcelain=v1"]), "");
}));

test("host-owned Git lifecycle commit uses fixed identity without repository or global Git identity", async () => fixture(async root => {
  await gitRepository(root);
  await git(root, ["config", "--unset-all", "user.name"]);
  await git(root, ["config", "--unset-all", "user.email"]);
  const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
  const previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  process.env.GIT_CONFIG_GLOBAL = join(root, "isolated-global.gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  try {
    const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
    await runtime.prepare("fixed-identity-root", lifecyclePlan("feature/fixed-identity"));
    await writeFile(join(root, "first.txt"), "approved\n");
    const boundary = await armLifecycleBoundary(runtime, "fixed-identity-root");
    await runtime.beforePostCommitValidation("fixed-identity-root", boundary.child, boundary.command);
    assert.deepEqual((await git(root, ["show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce", "HEAD"])).split("\0"),
      ["Sortie Dogs", "sortie-dogs@localhost", "Sortie Dogs", "sortie-dogs@localhost"]);
    assert.equal(await git(root, ["config", "--local", "--get", "user.name"]).then(() => "present", () => "absent"), "absent");
    assert.equal(await git(root, ["config", "--local", "--get", "user.email"]).then(() => "present", () => "absent"), "absent");
    assert.deepEqual((await git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])).split(/\r?\n/u),
      ["first.txt"]);
    assert.equal(await git(root, ["status", "--porcelain=v1"]), "");
  } finally {
    if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    if (previousNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = previousNoSystem;
  }
}));

test("actual plugin reports an undeclared transient generator output before commit without changing HEAD or index", async () => fixture(async root => {
  const base = await generatedOutputRepository(root);
  const proposedPlan = generatedOutputLifecyclePlan("feature/generator-gap", false, false);
  const { hooks, manifest } = await startGeneratedOutputWorker(root, proposedPlan);
  assert.deepEqual(manifest.write, ["generated/main.txt"]);
  assert.deepEqual(manifest.validation, ["node scripts/generate.mjs", "node scripts/validate-generated.mjs"]);
  await executeGeneratedCommand(hooks, root, "generate", "node scripts/generate.mjs", "scripts/generate.mjs");
  const headBeforeBoundary = await git(root, ["rev-parse", "HEAD"]);
  const indexBeforeBoundary = await git(root, ["diff", "--cached", "--name-only"]);
  await assert.rejects(hooks["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID: "validate" },
    { args: { command: "node scripts/validate-generated.mjs" } }), (error: unknown) => {
    assert.ok(error instanceof OperatorContractError);
    assert.equal(error.message, "operator-git-change-outside-write-union");
    assert.equal(error.diagnostics_truncated, false);
    assert.deepEqual(error.diagnostics, [{ document: "plan", pointer: "/units/0/write", unit_index: 0,
      code: "operator-git-change-outside-write-union",
      rule: "all-persistent-and-transient-outputs-declared-or-explicitly-cleaned-before-validation", repair_kind: "repair-field",
      repair_paths: ["generated/scratch.tmp"], expected: "untracked" }]);
    return true;
  });
  assert.equal(await git(root, ["rev-parse", "HEAD"]), headBeforeBoundary);
  assert.equal(headBeforeBoundary, base);
  assert.equal(await git(root, ["diff", "--cached", "--name-only"]), indexBeforeBoundary);
  assert.equal(indexBeforeBoundary, "");
  assert.deepEqual((await git(root, ["ls-files", "--others", "--exclude-standard"])).split(/\r?\n/u).sort(),
    ["generated/main.txt", "generated/scratch.tmp"]);
  const expectedDiagnostic = { code: "operator-git-change-outside-write-union", unit_id: "generate", diagnostics: [{ document: "plan",
    pointer: "/units/0/write", unit_index: 0, code: "operator-git-change-outside-write-union",
    rule: "all-persistent-and-transient-outputs-declared-or-explicitly-cleaned-before-validation", repair_kind: "repair-field",
    repair_paths: ["generated/scratch.tmp"], expected: "untracked" }], diagnostics_truncated: false };
  const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.equal(status.status, "awaiting-decision");
  assert.equal(status.decision, "operator-contract-repair-required");
  assert.equal(status.resume_requires_host_reconciliation, false);
  assert.match(status.next_action, /repair the approved contract.*do not use resume evidence or redispatch/u);
  assert.deepEqual({ code: status.contract_repair.code, unit_id: status.contract_repair.unit_id,
    diagnostics: status.contract_repair.diagnostics, diagnostics_truncated: status.contract_repair.diagnostics_truncated }, expectedDiagnostic);
  assert.equal(status.contract_repair.repair_generation, 0);
  assert.equal(status.contract_repair.mode, "discard-transient");
  assert.match(status.contract_repair.repair_fingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(status.contract_repair.files, [{ path: "generated/scratch.tmp", size: 8,
    sha256: createHash("sha256").update("scratch\n").digest("hex") }]);
  assert.equal(status.units[0].status, "failed");
  assert.equal(status.units[0].result_class, "contract-repair");
  assert.deepEqual(status.units[0].evidence, []);
  const next = JSON.parse(await hooks.tool!.sortie_v010_operator_next.execute({}, { sessionID: "root" }));
  assert.deepEqual(next.contract_repair, status.contract_repair);
  assert.equal(next.next_task_ref, null);
  const cold = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const durable = await cold.required("root");
  assert.deepEqual((cold.packet(durable) as { contract_repair: unknown }).contract_repair, status.contract_repair);
  await assert.rejects(cold.resume("root", status.run_id, new Map()), /operator-resume-contract-repair-required/);
  const ledgerPath = join(root, ".git", "sortie-dogs", "run-flight-v010",
    `${createHash("sha256").update("v010\0root").digest("hex")}.json`);
  const goal = await (await RunFlightLedger.openGoal(ledgerPath)).readGoal();
  assert.equal(goal.state.validation_budget.consumed, 0);
  assert.deepEqual(goal.state.satisfied_criteria, []);
  const rawLedger = JSON.parse(await readFile(ledgerPath, "utf8"));
  assert.equal(rawLedger.goal_events.filter(({ event }: { event: { kind: string } }) => event.kind === "unit.settled").length, 0);
}));

test("root discards one exact diagnosed transient and resumes only remaining validation in the same worker", async () => fixture(async root => {
  const base = await generatedOutputRepository(root);
  const { hooks, prepared, hostMessages } = await startGeneratedOutputWorker(root,
    generatedOutputLifecyclePlan("feature/active-contract-repair", false, false));
  const generator = "node scripts/generate.mjs", validator = "node scripts/validate-generated.mjs";
  await executeGeneratedCommand(hooks, root, "generate", generator, "scripts/generate.mjs");
  await assert.rejects(hooks["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID: "blocked-validator" },
    { args: { command: validator } }), /operator-git-change-outside-write-union/);
  await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "worker-call" },
    { output: "<task_result>contract repair required</task_result>", metadata: { sessionId: "worker" } });
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "worker" } } });

  const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  const repair = status.contract_repair;
  const request = { run_id: status.run_id, unit_id: "generate", repair_fingerprint: repair.repair_fingerprint,
    decision: "discard-transient", paths: ["generated/scratch.tmp"] };
  await assert.rejects(hooks.tool!.sortie_v010_resolve_operator_contract_repair.execute(request, { sessionID: "worker" }), /root-required/);
  await assert.rejects(hooks.tool!.sortie_v010_resolve_operator_contract_repair.execute(
    { ...request, repair_fingerprint: `sha256:${"0".repeat(64)}` }, { sessionID: "root" }), /identity-mismatch/);
  await assert.rejects(hooks.tool!.sortie_v010_resolve_operator_contract_repair.execute({ ...request, paths: [] }, { sessionID: "root" }), /path-set-mismatch/);
  assert.equal(await readFile(join(root, "generated", "scratch.tmp"), "utf8"), "scratch\n");

  await writeFile(join(root, "generated", "scratch.tmp"), "mutated\n");
  await assert.rejects(hooks.tool!.sortie_v010_resolve_operator_contract_repair.execute(request, { sessionID: "root" }), /file-identity-mismatch/);
  await writeFile(join(root, "generated", "scratch.tmp"), "scratch\n");
  await git(root, ["add", "--", "generated/scratch.tmp"]);
  await assert.rejects(hooks.tool!.sortie_v010_resolve_operator_contract_repair.execute(request, { sessionID: "root" }), /file-state-changed/);
  await git(root, ["restore", "--staged", "--", "generated/scratch.tmp"]);

  const applied = JSON.parse(await hooks.tool!.sortie_v010_resolve_operator_contract_repair.execute(request, { sessionID: "root" }));
  assert.equal(applied.status, "repair-applied");
  assert.equal(applied.repair_generation, 1);
  assert.equal(applied.task.task_id, "worker");
  assert.match(applied.task.prompt, /mode: same-task-resume/u);
  assert.match(applied.task.prompt, /remaining_validation_json: \["node scripts\/validate-generated\.mjs"\]/u);
  assert.doesNotMatch(applied.task.prompt, /^.*remaining_validation_json:.*generate\.mjs/mu);
  await assert.rejects(lstat(join(root, "generated", "scratch.tmp")), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT");

  const repairTaskInput = { args: structuredClone(applied.task) };
  await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "repair-validation-call" }, repairTaskInput);
  const resumedMessage = { message: { agent: "dog-worker-v010", model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text: repairTaskInput.args.prompt }] };
  await hooks["chat.message"]!({ sessionID: "worker", messageID: "repair-worker-user", agent: "dog-worker-v010" }, resumedMessage);
  assert.match(resumedMessage.parts[0]!.text, /validation-only/u);
  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const repairedState = await runtime.required("root");
  const handoffPath = repairedState.units[0]!.handoffPath, manifestPath = repairedState.units[0]!.manifestPath;
  await hooks["tool.execute.before"]!({ tool: "read", sessionID: "worker", callID: "repair-handoff-read" }, { args: { filePath: handoffPath } });
  await readFile(handoffPath);
  await hooks["tool.execute.after"]!({ tool: "read", sessionID: "worker", callID: "repair-handoff-read", args: { filePath: handoffPath } }, { output: "inspected" });
  assert.equal(JSON.parse(await hooks.tool!.sortie_v010_bind_write_gate.execute(
    { project_root: root, manifest_path: manifestPath }, { sessionID: "worker" })).status, "bound");
  await assert.rejects(hooks["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID: "generator-repeat" },
    { args: { command: generator } }), /validation-only/);
  await assert.rejects(hooks["tool.execute.before"]!({ tool: "edit", sessionID: "worker", callID: "repair-edit" },
    { args: { filePath: join(root, "generated", "main.txt"), oldString: "generated", newString: "changed" } }), /validation-only/);

  const validationInput = { args: { command: validator } };
  await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID: "repair-validator" }, validationInput);
  assert.notEqual(await git(root, ["rev-parse", "HEAD"]), base);
  assert.deepEqual((await git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])).split(/\r?\n/u),
    ["generated/main.txt"]);
  const result = await promisify(execFile)(process.execPath, ["scripts/validate-generated.mjs"], { cwd: root, encoding: "utf8" });
  const now = Date.now();
  const validationPart = { id: "repair-validation-part", messageID: "repair-validation-message", sessionID: "worker",
    type: "tool", tool: "bash", callID: "repair-validator", state: { status: "completed", input: { command: validator },
      output: result.stdout, metadata: { exit: 0 }, time: { start: now - 5, end: now } } };
  hostMessages.worker = [{ info: { role: "assistant", sessionID: "worker" }, parts: [validationPart] }];
  await hooks.event!({ event: { type: "message.part.updated", properties: { part: validationPart } } });
  await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "worker", callID: "repair-validator" },
    { output: result.stdout, metadata: { exit: 0, status: "completed" } });
  await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "repair-validation-call" },
    { output: "<task_result>remaining validation passed</task_result>", metadata: { sessionId: "worker" } });

  const accepted = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.equal(accepted.status, "awaiting-acceptance", JSON.stringify(accepted));
  assert.equal(accepted.contract_repair, null);
  assert.deepEqual(accepted.units[0].evidence.map((item: { command: string[] }) => item.command), [[validator]]);
  const ledgerPath = join(root, ".git", "sortie-dogs", "run-flight-v010",
    `${createHash("sha256").update("v010\0root").digest("hex")}.json`);
  const goal = await (await RunFlightLedger.openGoal(ledgerPath)).readGoal();
  assert.equal(goal.state.consumed_units, 1, "validation-only continuation must not reserve a second implementation unit");
  assert.equal(goal.state.validation_budget.consumed, 1);
  await assert.rejects(hooks.tool!.sortie_v010_resolve_operator_contract_repair.execute(request, { sessionID: "root" }), /identity-mismatch/);
  const complete = JSON.parse(await hooks.tool!.sortie_v010_complete_operator.execute({ run_id: prepared.run_id,
    acceptance_fingerprint: prepared.acceptance_fingerprint }, { sessionID: "root" }));
  assert.equal(complete.status, "succeeded");
  assert.equal(await git(root, ["status", "--porcelain=v1"]), "");
}));

test("a cold root applies an active contract repair from durable evidence without live dispatch accounting", async () => fixture(async root => {
  await generatedOutputRepository(root);
  const { hooks, hostMessages } = await startGeneratedOutputWorker(root,
    generatedOutputLifecyclePlan("feature/cold-contract-repair", false, false));
  const generator = "node scripts/generate.mjs", validator = "node scripts/validate-generated.mjs";
  await executeGeneratedCommand(hooks, root, "generate", generator, "scripts/generate.mjs");
  await assert.rejects(hooks["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID: "blocked-validator" },
    { args: { command: validator } }), /operator-git-change-outside-write-union/);
  await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "worker-call" },
    { output: "<task_result>contract repair required</task_result>", metadata: { sessionId: "worker" } });
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "worker" } } });
  const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.equal(status.contract_repair.mode, "discard-transient");

  const now = Date.now();
  hostMessages.root = [{ info: { role: "assistant", sessionID: "root", finish: "stop", time: { created: now, completed: now + 1 } },
    parts: [{ type: "tool", tool: "task", callID: "worker-call", state: { status: "completed",
      input: { subagent_type: "dog-worker-v010", prompt: `task_id: generate\n` }, output: "contract repair required",
      metadata: { sessionId: "worker" }, time: { start: now, end: now + 1 } } }] }];
  const identities: Record<string, { agent: string; parentID?: string }> = {
    root: { agent: "dog-operator" }, worker: { agent: "dog-worker-v010", parentID: "root" },
  };
  const cold = await SortieDogsV010Plugin({ directory: root, client: { session: {
    get: async ({ path }: { path: { id: string } }) => ({ data: identities[path.id] }),
    messages: async ({ path }: { path: { id: string } }) => ({ data: hostMessages[path.id] ?? [] }),
    status: async () => ({ data: { worker: { type: "idle" } } }), abort: async () => ({ data: true }),
  } } } as never);
  await cold["chat.message"]!({ sessionID: "root", messageID: "cold-repair-root-user", agent: "dog-operator" }, {
    message: { agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text: "Resume the exact active operator run." }],
  });
  const request = { run_id: status.run_id, unit_id: "generate", repair_fingerprint: status.contract_repair.repair_fingerprint,
    decision: "discard-transient", paths: ["generated/scratch.tmp"] };
  const applied = JSON.parse(await cold.tool!.sortie_v010_resolve_operator_contract_repair.execute(request, { sessionID: "root" }));
  assert.equal(applied.status, "repair-applied", JSON.stringify(applied));
  assert.equal(applied.repair_generation, 1);
  assert.equal(applied.task.task_id, "worker");
  assert.match(applied.task.prompt, /mode: same-task-resume/u);
  await assert.rejects(lstat(join(root, "generated", "scratch.tmp")), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT");
  const repaired = JSON.parse(await cold.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.equal(repaired.contract_repair, null);
  assert.equal(repaired.units[0].status, "pending");
}));

test("discard-transient repair preserves files and state when validation budget is unavailable", async () => fixture(async root => {
  await generatedOutputRepository(root);
  const proposed = generatedOutputLifecyclePlan("feature/repair-budget", false, false);
  proposed.goal_declaration.goal_budget_units = 1;
  const { hooks } = await startGeneratedOutputWorker(root, proposed);
  await executeGeneratedCommand(hooks, root, "generate", "node scripts/generate.mjs", "scripts/generate.mjs");
  await assert.rejects(hooks["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID: "blocked-validator" },
    { args: { command: "node scripts/validate-generated.mjs" } }), /operator-git-change-outside-write-union/);
  await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "worker-call" },
    { output: "<task_result>contract repair required</task_result>", metadata: { sessionId: "worker" } });
  const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  const ledgerPath = join(root, ".git", "sortie-dogs", "run-flight-v010",
    `${createHash("sha256").update("v010\0root").digest("hex")}.json`);
  const ledger = await RunFlightLedger.openGoal(ledgerPath), goal = (await ledger.readGoal()).state;
  const budgetRequest = { run_id: goal.goal_id!, operation_id: "consume-repair-budget", source_snapshot: "sha256:source",
    candidate: "sha256:candidate", command: ["node budget-check.mjs"], scope: "targeted" as const,
    expected_evidence: ["budget-check"], reason: "acceptance" as const };
  const reservation = await ledger.reserveValidation(budgetRequest, 1);
  assert.equal(reservation.decision, "ALLOW");
  await ledger.settleValidation(reservation.reservation_id!, budgetRequest, "passed", 0);
  const request = { run_id: status.run_id, unit_id: "generate", repair_fingerprint: status.contract_repair.repair_fingerprint,
    decision: "discard-transient", paths: ["generated/scratch.tmp"] };
  await assert.rejects(hooks.tool!.sortie_v010_resolve_operator_contract_repair.execute(request, { sessionID: "root" }),
    /validation-budget-unavailable/);
  assert.equal(await readFile(join(root, "generated", "scratch.tmp"), "utf8"), "scratch\n");
  const unchanged = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.equal(unchanged.contract_repair.repair_fingerprint, status.contract_repair.repair_fingerprint);
  assert.equal(unchanged.units[0].status, "failed");
}));

for (const exhaustBudget of [false, true]) test(`failed repair validation exposes host budget and ${exhaustBudget ? "stops replacement when fully reserved" : "replacement passes from the committed candidate"}`, async () => fixture(async root => {
  await generatedOutputRepository(root);
  const firstPlan = generatedOutputLifecyclePlan("feature/repair-validation-fail", false, false);
  const { hooks } = await startGeneratedOutputWorker(root, firstPlan);
  const budgetLedger = await RunFlightLedger.openGoal(join(root, ".git", "sortie-dogs", "run-flight-v010",
    `${createHash("sha256").update("v010\0root").digest("hex")}.json`));
  const inFlight = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  const initialGoal = (await budgetLedger.readGoal()).state;
  assert.deepEqual(inFlight.budget, { max_units: initialGoal.budget!.max_units,
    consumed_units: initialGoal.consumed_units, reserved_units: 1,
    remaining_units: initialGoal.budget!.max_units - initialGoal.consumed_units - 1 });
  const validator = "node scripts/validate-generated.mjs";
  await executeGeneratedCommand(hooks, root, "generate", "node scripts/generate.mjs", "scripts/generate.mjs");
  await writeFile(join(root, "generated", "main.txt"), "wrong\n");
  await assert.rejects(hooks["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID: "blocked-validator" },
    { args: { command: validator } }), /operator-git-change-outside-write-union/);
  await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "worker-call" },
    { output: "<task_result>contract repair required</task_result>", metadata: { sessionId: "worker" } });
  const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  const request = { run_id: status.run_id, unit_id: "generate", repair_fingerprint: status.contract_repair.repair_fingerprint,
    decision: "discard-transient", paths: ["generated/scratch.tmp"] };
  const applied = JSON.parse(await hooks.tool!.sortie_v010_resolve_operator_contract_repair.execute(request, { sessionID: "root" }));
  const taskInput = { args: structuredClone(applied.task) };
  await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "failed-repair-call" }, taskInput);
  const resumed = { message: { agent: "dog-worker-v010", model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text: taskInput.args.prompt }] };
  await hooks["chat.message"]!({ sessionID: "worker", messageID: "failed-repair-user", agent: "dog-worker-v010" }, resumed);
  const validationInput = { args: { command: validator } };
  await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID: "failed-repair-validator" }, validationInput);
  const committedFailureHead = await git(root, ["rev-parse", "HEAD"]);
  let failureExit = 0;
  try { await promisify(execFile)(process.execPath, ["scripts/validate-generated.mjs"], { cwd: root, encoding: "utf8" }); }
  catch (error) { failureExit = Number((error as NodeJS.ErrnoException).code); }
  assert.equal(failureExit, 12);
  const now = Date.now(), part = { id: "failed-repair-part", messageID: "failed-repair-message", sessionID: "worker", type: "tool",
    tool: "bash", callID: "failed-repair-validator", state: { status: "completed", input: { command: validator }, output: "bounded failure",
      metadata: { exit: failureExit }, time: { start: now - 5, end: now } } };
  await hooks.event!({ event: { type: "message.part.updated", properties: { part } } });
  await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "worker", callID: "failed-repair-validator" },
    { output: "bounded failure", metadata: { exit: failureExit, status: "completed" } });
  await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "failed-repair-call" },
    { output: "<task_result>validation failed</task_result>", metadata: { sessionId: "worker" } });
  const terminal = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.equal(terminal.status, "awaiting-decision");
  assert.equal(terminal.decision, "operator-acceptance-remediation-required");
  assert.equal(terminal.resume_requires_host_reconciliation, false);
  assert.equal(terminal.repair_generation, 1);
  assert.equal(terminal.git_lifecycle.committed_head, committedFailureHead);
  assert.equal(terminal.contract_repair, null);
  assert.equal(terminal.units[0].repair_validation, null);
  assert.equal(terminal.units[0].result_class, "acceptance");
  assert.deepEqual(terminal.acceptance_remediation.failed_evidence,
    { command: [validator], outcome: "fail", exit_code: 12 });
  assert.match(terminal.next_action, /cancel_operator[\s\S]+prepare_operator/u);
  const settledGoal = (await budgetLedger.readGoal()).state;
  assert.deepEqual(terminal.budget, { max_units: settledGoal.budget!.max_units,
    consumed_units: settledGoal.consumed_units, reserved_units: 0,
    remaining_units: settledGoal.budget!.max_units - settledGoal.consumed_units });
  assert.ok(terminal.budget.remaining_units > 0);
  assert.ok(terminal.next_action.includes(`remaining_units=${terminal.budget.remaining_units}`));
  assert.match(terminal.next_action, /not the model-authored goal_budget_units/u);
  await assert.rejects(hooks.tool!.sortie_v010_resume_operator.execute({ run_id: terminal.run_id,
    acceptance_fingerprint: terminal.acceptance_fingerprint }, { sessionID: "root" }), /operator-resume-unit-not-recoverable/);
  await assert.rejects(hooks.tool!.sortie_v010_resolve_operator_contract_repair.execute(request, { sessionID: "root" }), /identity-mismatch/);
  await assert.rejects(lstat(join(root, "generated", "scratch.tmp")), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT");

  const cancelled = JSON.parse(await hooks.tool!.sortie_v010_cancel_operator.execute(
    { reason: "acceptance-remediation" }, { sessionID: "root" }));
  assert.equal(cancelled.decision, "operator-acceptance-remediation-required");
  assert.deepEqual(cancelled.budget, terminal.budget);
  const identities: Record<string, { agent: string; parentID?: string }> = {
    root: { agent: "dog-operator" }, "replacement-worker": { agent: "dog-worker-v010", parentID: "root" },
  };
  const replacementHooks = await SortieDogsV010Plugin({ directory: root, client: { session: {
    get: async ({ path }: { path: { id: string } }) => ({ data: identities[path.id] }),
    messages: async () => ({ data: [] }), abort: async () => ({ data: true }),
  } } } as never);
  await replacementHooks["chat.message"]!({ sessionID: "root", messageID: "replacement-root-user", agent: "dog-operator" }, {
    message: { agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text: "Apply the exact acceptance remediation replacement." }],
  });
  const coldStatus = JSON.parse(await replacementHooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.deepEqual(coldStatus.budget, terminal.budget, "cold status reads the retained host allowance and spend");
  if (exhaustBudget) {
    for (let index = 0; index < coldStatus.budget.remaining_units; index++) {
      await budgetLedger.appendGoal({ kind: "dispatch.reserved", at: new Date().toISOString(),
        reservation_id: `budget-reservation-${index}`, goal_id: settledGoal.goal_id!, unit_id: `budget-unit-${index}`,
        session_id: "root", ticket_id: null });
    }
    const before = await budgetLedger.readGoal();
    const exhausted = JSON.parse(await replacementHooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
    assert.equal(exhausted.budget.remaining_units, 0);
    assert.equal(exhausted.budget.consumed_units, terminal.budget.consumed_units);
    assert.equal(exhausted.budget.reserved_units, terminal.budget.remaining_units);
    assert.match(exhausted.next_action, /remaining_units=0[\s\S]+Do not dispatch a replacement/u);
    assert.doesNotMatch(exhausted.next_action, /call sortie_v010_prepare_operator/u);
    assert.deepEqual(await budgetLedger.readGoal(), before, "status must not grant or settle budget");
    return;
  }
  const replacementPlan = generatedOutputLifecyclePlan("feature/repair-validation-remediation", false, false);
  replacementPlan.goal_declaration.goal_budget_units = coldStatus.budget.remaining_units;
  replacementPlan.git_lifecycle.branch_create.start_ref = committedFailureHead;
  replacementPlan.units[0]!.objective = "Correct the committed generated output and run its canonical validator.";
  replacementPlan.units[0]!.validation = [validator];
  const replacement = JSON.parse(await replacementHooks.tool!.sortie_v010_prepare_operator.execute(
    { plan_json: JSON.stringify(replacementPlan) }, { sessionID: "root" }));
  const replacementStatus = JSON.parse(await replacementHooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.deepEqual(replacementStatus.budget, terminal.budget, "replacement cannot multiply the observed remaining allowance");
  const replacementInput = { args: structuredClone(replacement.task) };
  await replacementHooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "replacement-call" }, replacementInput);
  const replacementMessage = { message: { agent: "dog-worker-v010", model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text: replacementInput.args.prompt }] };
  await replacementHooks["chat.message"]!({ sessionID: "replacement-worker", messageID: "replacement-worker-user",
    agent: "dog-worker-v010" }, replacementMessage);
  const replacementManifest = /^operation_manifest: (.+)$/m.exec(replacementMessage.parts[0]!.text)?.[1];
  const replacementHandoff = /^handoff_path: (.+)$/m.exec(replacementMessage.parts[0]!.text)?.[1];
  assert.ok(replacementManifest && replacementHandoff);
  await replacementHooks["tool.execute.before"]!({ tool: "read", sessionID: "replacement-worker", callID: "replacement-handoff" },
    { args: { filePath: replacementHandoff } });
  await readFile(replacementHandoff);
  await replacementHooks["tool.execute.after"]!({ tool: "read", sessionID: "replacement-worker", callID: "replacement-handoff",
    args: { filePath: replacementHandoff } }, { output: "inspected" });
  assert.equal(JSON.parse(await replacementHooks.tool!.sortie_v010_bind_write_gate.execute(
    { project_root: root, manifest_path: replacementManifest }, { sessionID: "replacement-worker" })).status, "bound");
  await writeFile(join(root, "generated", "main.txt"), "generated\n");
  await replacementHooks["tool.execute.before"]!({ tool: "bash", sessionID: "replacement-worker", callID: "replacement-validator" },
    { args: { command: validator } });
  const passed = await promisify(execFile)(process.execPath, ["scripts/validate-generated.mjs"], { cwd: root, encoding: "utf8" });
  const passedPart = { id: "replacement-part", messageID: "replacement-message", sessionID: "replacement-worker", type: "tool",
    tool: "bash", callID: "replacement-validator", state: { status: "completed", input: { command: validator }, output: passed.stdout,
      metadata: { exit: 0 }, time: { start: Date.now() - 5, end: Date.now() } } };
  await replacementHooks.event!({ event: { type: "message.part.updated", properties: { part: passedPart } } });
  await replacementHooks["tool.execute.after"]!({ tool: "bash", sessionID: "replacement-worker", callID: "replacement-validator" },
    { output: passed.stdout, metadata: { exit: 0, status: "completed" } });
  await replacementHooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "replacement-call" },
    { output: "<task_result>replacement validation passed</task_result>", metadata: { sessionId: "replacement-worker" } });
  const ready = JSON.parse(await replacementHooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.equal(ready.status, "awaiting-acceptance", JSON.stringify(ready));
  const complete = JSON.parse(await replacementHooks.tool!.sortie_v010_complete_operator.execute({ run_id: ready.run_id,
    acceptance_fingerprint: ready.acceptance_fingerprint }, { sessionID: "root" }));
  assert.equal(complete.status, "succeeded");
}));

test("fresh repair validation reopens one interrupted admission once without implementation spend", async () => fixture(async root => {
  await generatedOutputRepository(root);
  const proposed = generatedOutputLifecyclePlan("feature/repair-validation-resume", false, false);
  const { hooks, hostMessages } = await startGeneratedOutputWorker(root, proposed);
  const generator = "node scripts/generate.mjs", validator = "node scripts/validate-generated.mjs";
  await executeGeneratedCommand(hooks, root, "generate", generator, "scripts/generate.mjs");
  await assert.rejects(hooks["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID: "blocked-validator" },
    { args: { command: validator } }), /operator-git-change-outside-write-union/);
  await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "worker-call" },
    { output: "<task_result>contract repair required</task_result>", metadata: { sessionId: "worker" } });
  const diagnosed = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  const applied = JSON.parse(await hooks.tool!.sortie_v010_resolve_operator_contract_repair.execute({ run_id: diagnosed.run_id,
    unit_id: "generate", repair_fingerprint: diagnosed.contract_repair.repair_fingerprint,
    decision: "discard-transient", paths: ["generated/scratch.tmp"] }, { sessionID: "root" }));
  const firstInput = { args: structuredClone(applied.task) };
  await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "repair-validation-first" }, firstInput);
  const firstMessage = { message: { agent: "dog-worker-v010", model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text: firstInput.args.prompt }] };
  await hooks["chat.message"]!({ sessionID: "worker", messageID: "repair-first-user", agent: "dog-worker-v010" }, firstMessage);

  const hook = join(root, ".git", "hooks", "pre-commit");
  await writeFile(hook, "#!/bin/sh\nexit 73\n");
  await chmod(hook, 0o755);
  await assert.rejects(hooks["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID: "host-commit-defect" },
    { args: { command: validator } }), /operator-git-command-failed:commit/);
  await rm(hook, { force: true });
  const ledgerPath = join(root, ".git", "sortie-dogs", "run-flight-v010",
    `${createHash("sha256").update("v010\0root").digest("hex")}.json`);
  const interruptedLedger = await RunFlightLedger.openGoal(ledgerPath);
  const interruptedSnapshot = await interruptedLedger.readGoal();
  const interruptedReservation = interruptedSnapshot.state.validation_budget.reservations[0]!;
  await interruptedLedger.appendGoal({ kind: "validation.settled", at: new Date().toISOString(),
    goal_id: interruptedSnapshot.state.goal_id!, reservation_id: interruptedReservation.reservation_id,
    operation_id: interruptedReservation.operation_id, evidence_key: interruptedReservation.evidence_key,
    outcome: "interrupted", exit_code: 128 });
  await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "repair-validation-first" },
    { output: "<task_result>host commit process defect before command</task_result>", metadata: { sessionId: "worker" } });
  const failed = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.equal(failed.decision, "operator-contract-repair-validation-incomplete:operator-recovery-proof-unavailable-or-stale");
  assert.equal(failed.repair_validation_retry_available, true);
  assert.equal(failed.units[0].repair_validation_attempts, 1);
  assert.notEqual(failed.acceptance_fingerprint, interruptedSnapshot.state.acceptance_fingerprint,
    "operator acceptance and declaration/goal acceptance are separate fingerprint domains");

  const now = Date.now();
  hostMessages.worker = [{ info: { role: "assistant", sessionID: "worker", finish: "stop", time: { created: now, completed: now + 1 } },
    parts: [{ type: "tool", tool: "bash", callID: "host-commit-defect", state: { status: "error",
      input: { command: validator }, output: "operator-git-command-failed:commit:73" } },
    { type: "text", text: "host process defect" }] }];
  hostMessages.root = [{ info: { role: "assistant", sessionID: "root", finish: "stop", time: { created: now, completed: now + 1 } },
    parts: [{ type: "tool", tool: "task", callID: "repair-validation-first", state: { status: "completed",
      input: {}, output: "process defect", metadata: { sessionId: "worker" } } }] }];
  const identities: Record<string, { agent: string; parentID?: string }> = {
    root: { agent: "dog-operator" }, worker: { agent: "dog-worker-v010", parentID: "root" },
  };
  const cold = await SortieDogsV010Plugin({ directory: root, client: { session: {
    get: async ({ path }: { path: { id: string } }) => ({ data: identities[path.id] }),
    messages: async ({ path }: { path: { id: string } }) => ({ data: hostMessages[path.id] ?? [] }),
    status: async () => ({ data: { worker: { type: "idle" } } }), abort: async () => ({ data: true }),
  } } } as never);
  await cold["chat.message"]!({ sessionID: "root", messageID: "resume-root-user", agent: "dog-operator" }, {
    message: { agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text: "Resume the exact active operator run." }],
  });
  await assert.rejects(cold.tool!.sortie_v010_resume_operator.execute({ run_id: "wrong-run",
    acceptance_fingerprint: failed.acceptance_fingerprint }, { sessionID: "root" }), /resume-identity-mismatch/);
  await assert.rejects(cold.tool!.sortie_v010_resume_operator.execute({ run_id: failed.run_id,
    acceptance_fingerprint: `sha256:${"0".repeat(64)}` }, { sessionID: "root" }), /resume-identity-mismatch/);
  const resumed = JSON.parse(await cold.tool!.sortie_v010_resume_operator.execute({ run_id: failed.run_id,
    acceptance_fingerprint: failed.acceptance_fingerprint }, { sessionID: "root" }));
  assert.equal(resumed.mode, "repair-validation-only");
  assert.equal(resumed.repair_validation_attempt, 2);
  assert.equal(resumed.task.task_id, "worker");
  assert.match(resumed.task.prompt, /validation_continuation_attempt: 2/u);
  const retryInput = { args: structuredClone(resumed.task) };
  await cold["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "repair-validation-second" }, retryInput);
  const wrongUnitReference = { message: { agent: "dog-worker-v010", model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text: retryInput.args.prompt.replace(/^task_id: .+$/mu, "task_id: wrong-unit") }] };
  await assert.rejects(cold["chat.message"]!({ sessionID: "worker", messageID: "wrong-unit-retry-user", agent: "dog-worker-v010" },
    wrongUnitReference), /task-reference-mismatch/);
  const wrongFingerprintReference = { message: { agent: "dog-worker-v010", model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text: retryInput.args.prompt.replace(/repair_fingerprint: sha256:[a-f0-9]{64}/u,
      `repair_fingerprint: sha256:${"0".repeat(64)}`) }] };
  await assert.rejects(cold["chat.message"]!({ sessionID: "worker", messageID: "wrong-fingerprint-retry-user", agent: "dog-worker-v010" },
    wrongFingerprintReference), /task-reference-mismatch/);
  const changedReference = { message: { agent: "dog-worker-v010", model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text: `${retryInput.args.prompt}\nchanged: true` }] };
  await assert.rejects(cold["chat.message"]!({ sessionID: "worker", messageID: "changed-retry-user", agent: "dog-worker-v010" },
    changedReference), /task-reference-mismatch/);
  assert.equal(JSON.parse(await cold.tool!.sortie_v010_bind_write_gate.execute(
    { project_root: root, manifest_path: "unreached.json" }, { sessionID: "worker" })).reason, "session-inactive");
  await assert.rejects(new OperatorRuntime(root, V010_RUNTIME_PROFILE).claimAdmittedWorkerPrompt(
    "root", "root", "foreign", retryInput.args.prompt), /worker-child-mismatch/);
  await assert.rejects(cold.tool!.sortie_v010_bind_write_gate.execute(
    { project_root: root, manifest_path: "unreached.json" }, { sessionID: "foreign" }), /session-inactive/);
  const retryMessage = { message: { agent: "dog-worker-v010", model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text: retryInput.args.prompt }] };
  await cold["chat.message"]!({ sessionID: "worker", messageID: "repair-second-user", agent: "dog-worker-v010" }, retryMessage);
  const retryState = await new OperatorRuntime(root, V010_RUNTIME_PROFILE).required("root");
  const handoffPath = retryState.units[0]!.handoffPath, manifestPath = retryState.units[0]!.manifestPath;
  await cold["tool.execute.before"]!({ tool: "read", sessionID: "worker", callID: "retry-handoff" }, { args: { filePath: handoffPath } });
  await readFile(handoffPath);
  await cold["tool.execute.after"]!({ tool: "read", sessionID: "worker", callID: "retry-handoff", args: { filePath: handoffPath } }, { output: "inspected" });
  const rebound = JSON.parse(await cold.tool!.sortie_v010_bind_write_gate.execute(
    { project_root: root, manifest_path: manifestPath }, { sessionID: "worker" }));
  assert.equal(rebound.status, "bound", JSON.stringify(rebound));
  await assert.rejects(cold["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID: "retry-generator" },
    { args: { command: generator } }), /validation-only/);
  await assert.rejects(cold["tool.execute.before"]!({ tool: "edit", sessionID: "worker", callID: "retry-edit" },
    { args: { filePath: join(root, "generated", "main.txt"), oldString: "generated", newString: "changed" } }), /validation-only/);
  const validationInput = { args: { command: validator } };
  await cold["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID: "retry-validator" }, validationInput);
  const result = await promisify(execFile)(process.execPath, ["scripts/validate-generated.mjs"], { cwd: root, encoding: "utf8" });
  const validationPart = { id: "retry-validation-part", messageID: "retry-validation-message", sessionID: "worker", type: "tool",
    tool: "bash", callID: "retry-validator", state: { status: "completed", input: { command: validator }, output: result.stdout,
      metadata: { exit: 0 }, time: { start: now + 2, end: now + 3 } } };
  hostMessages.worker = [{ info: { role: "assistant", sessionID: "worker" }, parts: [validationPart] }];
  await cold.event!({ event: { type: "message.part.updated", properties: { part: validationPart } } });
  await cold["tool.execute.after"]!({ tool: "bash", sessionID: "worker", callID: "retry-validator" },
    { output: result.stdout, metadata: { exit: 0, status: "completed" } });
  await cold["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "repair-validation-second" },
    { output: "<task_result>validation passed</task_result>", metadata: { sessionId: "worker" } });
  const accepted = JSON.parse(await cold.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.equal(accepted.status, "awaiting-acceptance", JSON.stringify(accepted));
  assert.equal(accepted.units[0].repair_validation_attempts, 2);
  const goal = await (await RunFlightLedger.openGoal(ledgerPath)).readGoal();
  assert.equal(goal.state.consumed_units, 1);
  assert.equal(goal.state.validation_budget.consumed, 2);
  assert.equal(goal.state.validation_budget.evidence_keys.length, 1);
  assert.equal(goal.records.filter(({ event }) => event.kind === "validation.admission" &&
    event.decision === "ALLOW" && event.evidence_key === interruptedReservation.evidence_key).length, 2);
  await assert.rejects(cold.tool!.sortie_v010_resume_operator.execute({ run_id: failed.run_id,
    acceptance_fingerprint: failed.acceptance_fingerprint }, { sessionID: "root" }),
  /resume-identity-mismatch|resume-not-ready|unit-not-recoverable/);
  assert.equal(JSON.parse(await cold.tool!.sortie_v010_bind_write_gate.execute(
    { project_root: root, manifest_path: manifestPath }, { sessionID: "worker" })).reason, "session-inactive");
}));

test("cancelling an active repair names its residual transients and reopens replacement only after they are removed", async () => fixture(async root => {
  await generatedOutputRepository(root);
  const proposed = generatedOutputLifecyclePlan("feature/repair-cancel", false, false);
  const { hooks } = await startGeneratedOutputWorker(root, proposed);
  await executeGeneratedCommand(hooks, root, "generate", "node scripts/generate.mjs", "scripts/generate.mjs");
  await assert.rejects(hooks["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID: "blocked-validator" },
    { args: { command: "node scripts/validate-generated.mjs" } }), /operator-git-change-outside-write-union/);
  const cancelled = JSON.parse(await hooks.tool!.sortie_v010_cancel_operator.execute({}, { sessionID: "root" }));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.contract_repair, null);
  assert.equal(cancelled.decision, "operator-contract-repair-unavailable-after-cancel");
  assert.equal(await readFile(join(root, "generated", "scratch.tmp"), "utf8"), "scratch\n");
  assert.equal(await readFile(join(root, "generated", "main.txt"), "utf8"), "generated\n");
  assert.deepEqual(cancelled.repair_residual_paths, ["generated/scratch.tmp"]);
  assert.match(cancelled.next_action, /delete exactly the repair_residual_paths/u);
  const replacement = JSON.parse(await hooks.tool!.sortie_v010_prepare_operator.execute(
    { plan_json: JSON.stringify(proposed) }, { sessionID: "root" }));
  assert.equal(replacement.status, "invalid-plan");
  assert.equal(replacement.diagnostics[0].code, "operator-contract-repair-required");
  assert.deepEqual(replacement.diagnostics[0].repair_paths, ["generated/scratch.tmp"]);
  assert.doesNotMatch(JSON.stringify(replacement), /continuity-accepted-unit-missing/u);

  // Removing exactly the named residual transients ends the repair refusal; ordinary worktree
  // requirements then apply instead of a permanent terminal state.
  await rm(join(root, "generated", "scratch.tmp"));
  const afterCleanup = JSON.parse(await hooks.tool!.sortie_v010_prepare_operator.execute(
    { plan_json: JSON.stringify(generatedOutputLifecyclePlan("feature/repair-cancel-replacement", false, false)) },
    { sessionID: "root" }));
  assert.equal(afterCleanup.status, "invalid-plan");
  assert.equal(afterCleanup.diagnostics[0].code, "operator-git-dirty-worktree");
  await rm(join(root, "generated", "main.txt"));
  const reopened = JSON.parse(await hooks.tool!.sortie_v010_prepare_operator.execute(
    { plan_json: JSON.stringify(generatedOutputLifecyclePlan("feature/repair-cancel-replacement", false, false)) },
    { sessionID: "root" }));
  assert.notEqual(reopened.run_id, cancelled.run_id);
  assert.equal(reopened.acceptance_fingerprint, cancelled.acceptance_fingerprint);
  assert.ok(reopened.task, JSON.stringify(reopened));
  const reopenedStatus = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.equal(reopenedStatus.status, "prepared");
  assert.equal(reopenedStatus.repair_generation, 0);
  assert.equal(reopenedStatus.repair_residual_paths, undefined);
}));

test("actual plugin accepts declared persistent and transient outputs after exact cleanup and commits only the persistent output", async () => fixture(async root => {
  const base = await generatedOutputRepository(root);
  const proposedPlan = generatedOutputLifecyclePlan("feature/generator-cleanup", true, true);
  const { hooks, prepared, manifest } = await startGeneratedOutputWorker(root, proposedPlan);
  const validator = "node scripts/validate-generated.mjs";
  assert.deepEqual(manifest.write, ["generated/main.txt", "generated/scratch.tmp"]);
  assert.deepEqual(manifest.validation, ["node scripts/generate.mjs", "node scripts/cleanup.mjs", validator]);
  assert.deepEqual(proposedPlan.goal_declaration.criteria.map(item => item.validation_command), [validator],
    "generator and cleanup remain execution steps, not goal criteria");
  await executeGeneratedCommand(hooks, root, "generate", "node scripts/generate.mjs", "scripts/generate.mjs");
  await executeGeneratedCommand(hooks, root, "cleanup", "node scripts/cleanup.mjs", "scripts/cleanup.mjs");
  await assert.rejects(lstat(join(root, "generated", "scratch.tmp")), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT");

  const validationInput = { args: { command: validator } };
  await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID: "validate" }, validationInput);
  assert.notEqual(await git(root, ["rev-parse", "HEAD"]), base);
  assert.equal(await git(root, ["status", "--porcelain=v1"]), "");
  assert.deepEqual((await git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])).split(/\r?\n/u),
    ["generated/main.txt"]);
  const result = await promisify(execFile)(process.execPath, ["scripts/validate-generated.mjs"], { cwd: root, encoding: "utf8" });
  const now = Date.now();
  await hooks.event!({ event: { type: "message.part.updated", properties: { part: { id: "validate-part", messageID: "validate-message",
    sessionID: "worker", type: "tool", tool: "bash", callID: "validate", state: { status: "completed",
      input: { command: validationInput.args.command }, output: result.stdout, metadata: { exit: 0 },
      time: { start: now - 5, end: now } } } } } });
  await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "worker", callID: "validate" },
    { output: result.stdout, metadata: { exit: 0, status: "completed" } });
  await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "worker-call" },
    { output: "<task_result>generated, cleaned, committed, and validated</task_result>", metadata: { sessionId: "worker" } });
  const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.equal(status.status, "awaiting-acceptance", JSON.stringify(status));
  assert.deepEqual(status.units[0].evidence.map((item: { command: string[] }) => item.command), [[validator]]);
  assert.equal(status.run_id, prepared.run_id);
}));

test("Git lifecycle rejects missing starts, existing destinations, dirty roots, and option-shaped refs before worker spend", async () => fixture(async root => {
  await gitRepository(root);
  const invalidOrder = lifecyclePlan("feature/invalid-order");
  invalidOrder.git_lifecycle.post_commit_validation = ["node check-first.mjs"];
  const invalidRuntime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  await assert.rejects(invalidRuntime.prepare("invalid-order", invalidOrder), (error: unknown) =>
    error instanceof OperatorContractError && error.diagnostics[0]?.code === "operator-git-post-commit-validation-invalid");
  assert.equal(await invalidRuntime.read("invalid-order"), undefined);
  assert.equal(await git(root, ["show-ref", "--verify", "--quiet", "refs/heads/feature/invalid-order"]).then(() => true, () => false), false);
  const missing = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  await assert.rejects(missing.prepare("missing", lifecyclePlan("feature/missing", "refs/heads/main")), (error: unknown) =>
    error instanceof OperatorContractError && error.diagnostics[0]?.code === "operator-git-start-ref-missing");
  assert.equal(await missing.read("missing"), undefined);
  assert.equal(await git(root, ["show-ref", "--verify", "--quiet", "refs/heads/feature/missing"]).then(() => true, () => false), false);

  await git(root, ["branch", "feature/existing"]);
  await assert.rejects(new OperatorRuntime(root, V010_RUNTIME_PROFILE).prepare("existing", lifecyclePlan("feature/existing")),
    (error: unknown) => error instanceof OperatorContractError && error.diagnostics[0]?.code === "operator-git-destination-exists");
  await writeFile(join(root, "dirty.txt"), "dirty\n");
  await assert.rejects(new OperatorRuntime(root, V010_RUNTIME_PROFILE).prepare("dirty", lifecyclePlan("feature/dirty")),
    (error: unknown) => error instanceof OperatorContractError && error.diagnostics[0]?.code === "operator-git-dirty-worktree");
  assert.throws(() => parseOperatorPlan(lifecyclePlan("-force", "refs/heads/base")), /operator-git-lifecycle-invalid/);
  assert.throws(() => parseOperatorPlan(lifecyclePlan("feature/safe", "--all")), /operator-git-lifecycle-invalid/);
}));

test("final Git lifecycle fails closed on foreign or pre-staged paths and never emits an empty commit", async () => fixture(async root => {
  const base = await gitRepository(root);
  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const state = await runtime.prepare("foreign-root", lifecyclePlan("feature/foreign"));
  await writeFile(join(root, "first.txt"), "approved\n");
  await writeFile(join(root, "foreign.txt"), "foreign\n");
  await git(root, ["add", "--", "foreign.txt"]);
  const boundary = await armLifecycleBoundary(runtime, "foreign-root");
  await assert.rejects(runtime.beforePostCommitValidation("foreign-root", boundary.child, boundary.command), (error: unknown) => {
    assert.ok(error instanceof OperatorContractError);
    assert.equal(error.message, "operator-git-change-outside-write-union");
    assert.deepEqual(error.diagnostics, [{ document: "plan", pointer: "/units/0/write", unit_index: 0,
      code: "operator-git-change-outside-write-union",
      rule: "all-persistent-and-transient-outputs-declared-or-explicitly-cleaned-before-validation", repair_kind: "repair-field",
      repair_paths: ["foreign.txt"], expected: "staged" }]);
    return true;
  });
  assert.equal(await git(root, ["rev-parse", "HEAD"]), base);
  assert.equal(await git(root, ["diff", "--cached", "--name-only"]), "foreign.txt", "foreign staged state is not rewritten");

  const emptyRoot = join(root, "empty-case");
  await mkdir(emptyRoot);
  const emptyBase = await gitRepository(emptyRoot);
  const emptyRuntime = new OperatorRuntime(emptyRoot, V010_RUNTIME_PROFILE);
  const emptyState = await emptyRuntime.prepare("empty-root", lifecyclePlan("feature/empty"));
  assert.equal(emptyState.gitLifecycle?.committedHead, null);
  const emptyBoundary = await armLifecycleBoundary(emptyRuntime, "empty-root");
  await assert.rejects(emptyRuntime.beforePostCommitValidation("empty-root", emptyBoundary.child, emptyBoundary.command),
    /operator-git-empty-commit-refused/);
  assert.equal(await git(emptyRoot, ["rev-parse", "HEAD"]), emptyBase);
}));

test("Git lifecycle rejects reverted foreign history, non-descendant tips, and Linux case-only scope mismatches", async () => fixture(async root => {
  const revertedRoot = join(root, "reverted"); await mkdir(revertedRoot); await gitRepository(revertedRoot);
  const reverted = new OperatorRuntime(revertedRoot, V010_RUNTIME_PROFILE);
  await reverted.prepare("reverted-root", lifecyclePlan("feature/reverted"));
  const revertedBoundary = await armLifecycleBoundary(reverted, "reverted-root");
  await writeFile(join(revertedRoot, "foreign.txt"), "foreign\n");
  await git(revertedRoot, ["add", "--", "foreign.txt"]); await git(revertedRoot, ["commit", "-m", "foreign"]);
  await git(revertedRoot, ["revert", "--no-edit", "HEAD"]);
  await writeFile(join(revertedRoot, "first.txt"), "approved\n");
  await assert.rejects(reverted.beforePostCommitValidation("reverted-root", revertedBoundary.child, revertedBoundary.command),
    /operator-git-history-outside-write-union/);

  const unrelatedRoot = join(root, "unrelated"); await mkdir(unrelatedRoot); await gitRepository(unrelatedRoot);
  const unrelated = new OperatorRuntime(unrelatedRoot, V010_RUNTIME_PROFILE);
  await unrelated.prepare("unrelated-root", lifecyclePlan("feature/unrelated"));
  const unrelatedBoundary = await armLifecycleBoundary(unrelated, "unrelated-root");
  await git(unrelatedRoot, ["switch", "--orphan", "temporary-unrelated"]);
  await writeFile(join(unrelatedRoot, "first.txt"), "unrelated\n");
  await git(unrelatedRoot, ["add", "--", "first.txt"]); await git(unrelatedRoot, ["commit", "-m", "unrelated root"]);
  const unrelatedOID = await git(unrelatedRoot, ["rev-parse", "HEAD"]);
  await git(unrelatedRoot, ["switch", "feature/unrelated"]); await git(unrelatedRoot, ["reset", "--hard", unrelatedOID]);
  await assert.rejects(unrelated.beforePostCommitValidation("unrelated-root", unrelatedBoundary.child, unrelatedBoundary.command),
    /operator-git-history-not-descendant/);

  assert.equal(operatorGitPathAuthorized("A.ts", ["a.ts"], "linux"), false);
  assert.equal(operatorGitPathAuthorized("A.ts", ["a.ts"], "win32"), true);
}));

test("failed post-checkout hook rolls back only the newly created clean branch", async () => fixture(async root => {
  const base = await gitRepository(root);
  await writeFile(join(root, ".git", "hooks", "post-checkout"), "#!/bin/sh\nexit 17\n", { mode: 0o755 });
  await assert.rejects(new OperatorRuntime(root, V010_RUNTIME_PROFILE).prepare("hook-root", lifecyclePlan("feature/hook-failure")),
    /operator-git-command-failed:switch/);
  assert.equal(await git(root, ["symbolic-ref", "--short", "HEAD"]), "base");
  assert.equal(await git(root, ["rev-parse", "HEAD"]), base);
  assert.equal(await git(root, ["show-ref", "--verify", "--quiet", "refs/heads/feature/hook-failure"]).then(() => true, () => false), false);
}));

test("representative three-unit contracts preserve long objectives and commands", async () => fixture(async root => {
  const request = representativeLongPlan();
  assert.ok(request.units[0]!.objective.length > 1000 && request.units[0]!.objective.length <= 2000);
  assert.ok(request.units[0]!.validation[0]!.length > 256 && request.units[0]!.validation[0]!.length <= 1000);
  const state = await new OperatorRuntime(root, V010_RUNTIME_PROFILE).prepare("representative-root", request);
  assert.equal(state.units.length, 3);
  for (const [index, unit] of state.units.entries()) {
    const handoff = JSON.parse(await readFile(unit.handoffPath, "utf8"));
    const manifest = JSON.parse(await readFile(unit.manifestPath, "utf8"));
    assert.equal(handoff.task.objective, request.units[index]!.objective);
    assert.deepEqual(handoff.state.next, [request.units[index]!.title]);
    assert.equal(handoff.verification[0].check, request.units[index]!.validation[0]);
    assert.deepEqual(manifest.validation, request.units[index]!.validation);
    assert.deepEqual(unit.unit.acceptance_indices, [index]);
  }
}));

test("operator diagnostics identify one invalid proof mapping without echoing values", () => {
  const request = representativeLongPlan();
  request.units[1]!.validation = [request.units[0]!.validation[0]!];
  assert.throws(() => parseOperatorPlan(request), (error: unknown) => {
    assert.ok(error instanceof OperatorContractError);
    assert.deepEqual(error.diagnostics, [{ document: "plan", pointer: "/units/1/acceptance_indices/0",
      code: "operator-unit-coverage-invalid", rule: "assigned-criterion-requires-exact-proof-command", repair_kind: "repair-proof-mapping",
      repair_paths: ["/units/1/validation", "/units/1/acceptance_indices", "/goal_declaration/criteria/1/validation_command"] }]);
    assert.doesNotMatch(JSON.stringify(error.diagnostics), /--oracle-/);
    return true;
  });
});

test("all independent unit mapping errors are returned in one bounded diagnostic batch", () => {
  const request = representativeLongPlan();
  request.units[0]!.validation = ["wrong command one"];
  request.units[1]!.validation = ["wrong command two"];
  assert.throws(() => parseOperatorPlan(request), error => {
    assert.ok(error instanceof OperatorContractError);
    assert.deepEqual(error.diagnostics.map(item => item.pointer), ["/units/0/acceptance_indices/0", "/units/1/acceptance_indices/0"]);
    assert.equal(error.diagnostics_truncated, false);
    assert.doesNotMatch(JSON.stringify(error.diagnostics), /wrong command/);
    return true;
  });
});

test("root-level shared goal fields have the same meaning as nested defaults", () => {
  const request = plan();
  const flat = JSON.parse(JSON.stringify(request));
  for (const [key, value] of Object.entries(flat.goal_declaration.defaults)) flat.goal_declaration[`goal_${key}`] = value;
  delete flat.goal_declaration.defaults;
  flat.goal_declaration.goal_validation_command = flat.goal_declaration.criteria[0].validation_command;
  delete flat.goal_declaration.criteria[0].validation_command;
  assert.doesNotThrow(() => parseOperatorPlan(flat));
  assert.equal(expandGoalDeclaration(flat.goal_declaration), expandGoalDeclaration(request.goal_declaration));
});

test("shared final-proof drafts can bind already-declared per-unit commands without changing scope", async () => fixture(async root => {
  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const request = JSON.parse(JSON.stringify(representativeLongPlan()));
  for (const [key, value] of Object.entries(request.goal_declaration.defaults)) request.goal_declaration[`goal_${key}`] = value;
  delete request.goal_declaration.defaults;
  request.goal_declaration.goal_validation_command = request.units[2].validation[0];
  for (const criterion of request.goal_declaration.criteria) delete criterion.validation_command;
  const before = structuredClone(request);
  const invalid = await runtime.propose("shared-draft", request);
  assert.equal(invalid.status, "invalid-plan");
  if (invalid.status !== "invalid-plan") throw Error("Expected invalid mapping");
  assert.equal(invalid.diagnostics[0]!.code, "operator-unit-coverage-invalid", "root command must not be reported missing");
  assert.ok(invalid.diagnostics[0]!.repair_paths?.includes("/goal_declaration/criteria/0/goal_validation_command"));
  const status = await runtime.draftStatus("shared-draft") as { draft_id: string };
  assert.equal(status.draft_id, invalid.draft_id);
  const rechecked = await runtime.repair("shared-draft", invalid.draft_id, []);
  assert.equal(rechecked.status, "invalid-plan");
  if (rechecked.status !== "invalid-plan") throw Error("Expected unchanged draft");
  assert.equal(rechecked.draft_id, invalid.draft_id);
  await assert.rejects(runtime.repair("shared-draft", invalid.draft_id, [
    { op: "replace", path: "/units/0/validation", value: ["undeclared command"] },
    { op: "add", path: "/goal_declaration/criteria/0/goal_validation_command", value: "undeclared command" },
  ]), /not-declared-for-criterion/);
  const accepted = await runtime.repair("shared-draft", invalid.draft_id, [0, 1].map(index => ({
    op: "add", path: `/goal_declaration/criteria/${index}/goal_validation_command`, value: request.units[index].validation[0],
  })));
  assert.equal(accepted.status, "prepared");
  if (accepted.status !== "prepared") throw Error("Expected repaired plan");
  assert.deepEqual(accepted.state.acceptance, before.acceptance);
  assert.equal(accepted.state.units.length, 3);
  assert.deepEqual(accepted.state.units.map(unit => unit.unit.write), before.units.map((unit: { write: string[] }) => unit.write));
  assert.equal(await runtime.draftStatus("shared-draft"), undefined);
}));

test("question permission is granted only to the user-facing preview primary", () => {
  assert.match(previewAssets.find(asset => asset.name === "dog-operator")!.content, /^  question: allow$/m);
  for (const asset of previewAssets.filter(asset => asset.name !== "dog-operator")) assert.doesNotMatch(asset.content, /^  question: allow$/m);
});

test("conflicting command aliases are rejected and repaired only to an approved command", async () => fixture(async root => {
  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const request = JSON.parse(JSON.stringify(plan()));
  request.goal_declaration.criteria[0].goal_validation_command = "different command";
  assert.throws(() => expandGoalDeclaration(request.goal_declaration), /alias-conflict/);
  const invalid = await runtime.propose("alias-root", request);
  assert.equal(invalid.status, "invalid-plan");
  if (invalid.status !== "invalid-plan") throw Error("Expected conflict");
  assert.equal(invalid.diagnostics[0]!.code, "operator-goal-command-alias-conflict");
  const repaired = await runtime.repair("alias-root", invalid.draft_id, [{
    op: "replace", path: "/goal_declaration/criteria/0/goal_validation_command", value: request.units[0].validation[0],
  }]);
  assert.equal(repaired.status, "prepared");
}));

test("status includes a pending draft alongside a cancelled run", async () => fixture(async root => {
  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const old = await runtime.prepare("root", plan());
  await runtime.interrupted("root", "user-replan");
  const invalid = plan(); invalid.units[0]!.validation = ["different command"];
  const draft = await runtime.propose("root", invalid);
  assert.equal(draft.status, "invalid-plan");
  if (draft.status !== "invalid-plan") throw Error("Expected invalid draft");
  const hooks = await SortieDogsV010Plugin({ directory: root });
  await hooks["chat.message"]!({ sessionID: "root", messageID: "user", agent: "dog-operator" }, {
    message: { agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-5.6-sol" } }, parts: [{ type: "text", text: "Continue approved work." }],
  });
  const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.equal(status.status, "cancelled");
  assert.equal(status.run_id, old.runID);
  assert.equal(status.pending_draft.draft_id, draft.draft_id);
  assert.equal(status.pending_draft.diagnostics[0].code, "operator-unit-coverage-invalid");
}));

test("re-registering a plan on an active contract returns the existing run status and next action", async () => fixture(async root => {
  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const active = await runtime.prepare("root", plan());
  const hooks = await SortieDogsV010Plugin({ directory: root });
  await hooks["chat.message"]!({ sessionID: "root", messageID: "user", agent: "dog-operator" }, {
    message: { agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text: "Continue approved work." }],
  });
  const different = plan();
  different.acceptance = ["Weaker objective", plan().acceptance[1]!];
  const refused = JSON.parse(await hooks.tool!.sortie_v010_prepare_operator.execute(
    { plan_json: JSON.stringify(different) }, { sessionID: "root" }));
  assert.equal(refused.status, "active-contract-immutable");
  assert.equal(refused.code, "operator-active-contract-immutable");
  assert.equal(refused.packet.run_id, active.runID);
  assert.equal(refused.packet.status, "prepared");
  assert.deepEqual(refused.packet.acceptance, active.acceptance);
  assert.ok(refused.packet.next_task_ref, "the existing next Task reference stays available");
  assert.match(refused.next_action, /sortie_v010_operator_status/);
  assert.match(refused.next_action, /Do not resend a plan or cancel an unchanged contract/);
  const unchanged = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.equal(unchanged.run_id, active.runID);
  assert.deepEqual(unchanged.acceptance, active.acceptance);
}));

test("generated contract validation and storage failure leave no partial controls", async () => fixture(async root => {
  const invalid = representativeLongPlan();
  invalid.units[0]!.objective = "o".repeat(2001);
  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  await assert.rejects(runtime.prepare("invalid-root", invalid), (error: unknown) => {
    assert.ok(error instanceof OperatorContractError);
    assert.deepEqual(error.diagnostics[0], { document: "handoff", pointer: "/task/objective", unit_index: 0, code: "schema_maxLength",
      rule: "maxLength", repair_kind: "repair-field", length: 2001, limit: 2000 });
    return true;
  });
  await assert.rejects(lstat(join(root, V010_RUNTIME_PROFILE.stateDirectory, "contracts")), { code: "ENOENT" });

  const controls = join(root, V010_RUNTIME_PROFILE.stateDirectory, "contracts");
  await mkdir(join(root, V010_RUNTIME_PROFILE.stateDirectory), { recursive: true });
  await writeFile(controls, "existing control sentinel\n");
  await assert.rejects(runtime.prepare("storage-root", representativeLongPlan()), (error: unknown) => {
    assert.ok(error instanceof OperatorContractError);
    assert.deepEqual(error.diagnostics, [{ document: "controls", pointer: "/controls", code: "operator-control-write-failed",
      rule: "all-controls-persist-or-none", repair_kind: "retry-storage-after-cleanup" }]);
    return true;
  });
  assert.equal(await readFile(controls, "utf8"), "existing control sentinel\n");
}));

test("invalid draft repairs only named unit fields without changing acceptance or scope", async () => fixture(async root => {
  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const request = representativeLongPlan();
  const exact = request.units[1]!.validation;
  request.units[1]!.validation = request.units[0]!.validation;
  const original = structuredClone(request);
  const failed = await runtime.propose("draft-root", request);
  assert.equal(failed.status, "invalid-plan");
  if (failed.status !== "invalid-plan") throw Error("Expected invalid draft");
  for (const field of ["/acceptance", "/units", "/units/1/write", "/__proto__/polluted"]) {
    await assert.rejects(runtime.repair("draft-root", failed.draft_id, [{ op: "replace", path: field, value: [] }]), /path-forbidden/);
  }
  await assert.rejects(runtime.repair("draft-root", "stale-id", [{ op: "replace", path: "/units/1/validation", value: exact }]), /stale/);
  const repaired = await runtime.repair("draft-root", failed.draft_id, [{ op: "replace", path: "/units/1/validation", value: exact }]);
  assert.equal(repaired.status, "prepared");
  if (repaired.status !== "prepared") throw Error("Expected prepared draft");
  assert.equal(repaired.state.units.length, 3);
  assert.deepEqual(repaired.state.acceptance, original.acceptance);
  assert.deepEqual(repaired.state.units.map(unit => unit.unit.write), original.units.map(unit => unit.write));
  assert.deepEqual(request, original, "caller input is not mutated");
  await assert.rejects(runtime.repair("draft-root", failed.draft_id, [{ op: "replace", path: "/units/1/validation", value: exact }]), { code: "ENOENT" });
}));

test("all generated controls are rolled back when final state persistence fails", async () => fixture(async root => {
  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const area = join(root, V010_RUNTIME_PROFILE.stateDirectory, "contracts");
  await mkdir(area, { recursive: true });
  await writeFile(join(area, "existing.json"), "existing-owner\n");
  Object.defineProperty(runtime, "save", { value: async () => { throw Error("injected-persistence-failure"); } });
  await assert.rejects(runtime.prepare("failed-save", representativeLongPlan()), /operator-control-write-failed/);
  assert.deepEqual((await readdir(area)).sort(), ["existing.json"]);
  assert.equal(await readFile(join(area, "existing.json"), "utf8"), "existing-owner\n");
  assert.equal(await runtime.read("failed-save"), undefined);
}));

test("failed operator state save cannot publish dispatch or phase changes in memory", async () => fixture(async root => {
  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const state = await runtime.prepare("save-root", representativeLongPlan());
  const before = await runtime.required("save-root");
  const originalSave = (runtime as unknown as { save(state: unknown): Promise<void> }).save.bind(runtime);
  Object.defineProperty(runtime, "save", { configurable: true, value: async () => { throw Error("injected-persistence-failure"); } });
  await assert.rejects(runtime.admitOperator("save-root", "op", runtime.operatorTask(state)), /injected/);
  assert.deepEqual(await runtime.required("save-root"), before);
  assert.deepEqual(await new OperatorRuntime(root, V010_RUNTIME_PROFILE).required("save-root"), before);
  Object.defineProperty(runtime, "save", { configurable: true, value: originalSave });
  await runtime.admitOperator("save-root", "op", runtime.operatorTask(state));
  await runtime.bindOperator("save-root", "operator", runtime.operatorTask(state).prompt);
  const ready = await runtime.next("save-root", "operator") as { task: object };
  const beforeWorker = await runtime.required("save-root");
  Object.defineProperty(runtime, "save", { configurable: true, value: async () => { throw Error("injected-persistence-failure"); } });
  await assert.rejects(runtime.admitWorker("save-root", "operator", "worker", ready.task), /injected/);
  assert.deepEqual(await runtime.required("save-root"), beforeWorker);
  assert.deepEqual(await new OperatorRuntime(root, V010_RUNTIME_PROFILE).required("save-root"), beforeWorker);
  Object.defineProperty(runtime, "save", { configurable: true, value: originalSave });
  await runtime.admitWorker("save-root", "operator", "worker", ready.task);
  assert.equal((await runtime.required("save-root")).dispatched, 1);
}));

test("completion uses the immutable goal identity rather than the criteria-list hash", async () => fixture(async root => {
  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const state = await runtime.prepare("identity-root", representativeLongPlan());
  const fingerprint = await runtime.completionGoalFingerprint(state);
  assert.match(fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(fingerprint, state.acceptanceFingerprint);
  const reference = /^goal_declaration_path: (.+)$/m.exec(state.units[0]!.task.prompt)![1]!;
  await writeFile(reference, "{}");
  await assert.rejects(runtime.completionGoalFingerprint(state), /operator-contract-changed/);
}));

test("operator grants reject identity drift, duplicate admission, source writes and stale controls", async () => fixture(async root => {
  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const state = await runtime.prepare("root", plan());
  const task = runtime.operatorTask(state);
  await runtime.admitOperator("root", "operator-call", task);
  await runtime.bindOperator("root", "operator-child", task.prompt);
  const ready = await runtime.next("root", "operator-child") as { task: { prompt: string } };
  await assert.rejects(runtime.next("root", "foreign"), /owner/);
  await assert.rejects(runtime.admitWorker("root", "operator-child", "bad", { ...ready.task, prompt: `${ready.task.prompt}\nweaken scope` }), /not-authorized/);
  const outcomes = await Promise.allSettled([
    runtime.admitWorker("root", "operator-child", "one", ready.task),
    runtime.admitWorker("root", "operator-child", "two", ready.task),
  ]);
  assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
  assert.equal((await runtime.required("root")).dispatched, 1);
  await runtime.interrupted("root", "agent-changed");
  await assert.rejects(runtime.admitWorker("root", "operator-child", "three", ready.task), /revoked/);
  const restored = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  assert.equal((await restored.required("root")).dispatched, 1);
  assert.equal((await restored.required("root")).phase, "cancelled");
  const other = await restored.prepare("fresh-root", plan());
  await writeFile(other.units[0].manifestPath, "{}");
  await assert.rejects(restored.admitOperator("fresh-root", "op", { ...restored.operatorTask(other), prompt: "forged" }), /authorized/);
  await restored.admitOperator("fresh-root", "op", restored.operatorTask(other));
  await restored.bindOperator("fresh-root", "child", restored.operatorTask(other).prompt);
  await assert.rejects(restored.next("fresh-root", "child"), /changed/);
}));

test("delegate and worker references expand only for the exact live root generation and retain exact legacy prompts", async () => fixture(async root => {
  const preparedBy = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const state = await preparedBy.prepare("reference-root", plan());
  const cold = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const restored = await cold.required("reference-root");
  const delegate = cold.dispatchTask(restored);
  assert.match(delegate.prompt, /^SORTIE_OPERATOR_DELEGATE_REF /);
  assert.ok(delegate.prompt.length < cold.operatorTask(restored).prompt.length);
  const rootNext = await cold.next("reference-root", "reference-root") as { task: OperatorTask };
  assert.deepEqual(rootNext.task, delegate);
  const preparedPacket = cold.packet(restored) as { next_task_ref: string };
  assert.equal(preparedPacket.next_task_ref, delegate.prompt);
  const delegateReference = JSON.parse(delegate.prompt.slice("SORTIE_OPERATOR_DELEGATE_REF ".length));
  const invalidDelegates = [
    { ...delegateReference, r: "foreign-root" },
    { ...delegateReference, n: "foreign-run" },
    { ...delegateReference, g: delegateReference.g + 1 },
    { ...delegateReference, h: "0".repeat(64) },
    { ...delegateReference, u: "worker-shaped-extra" },
  ];
  for (const [index, changed] of invalidDelegates.entries()) await assert.rejects(cold.admitOperator("reference-root", `bad-delegate-${index}`,
    { ...delegate, prompt: `SORTIE_OPERATOR_DELEGATE_REF ${JSON.stringify(changed)}` }), /not-authorized/);
  await assert.rejects(cold.admitOperator("reference-root", "worker-ref-in-operator-lane",
    { ...delegate, prompt: cold.nextWorkerTask(restored).prompt }), /not-authorized/);
  await assert.rejects(cold.admitOperator("reference-root", "legacy-near-miss",
    { ...cold.operatorTask(restored), prompt: `${cold.operatorTask(restored).prompt} ` }), /not-authorized/);
  assert.equal((await cold.required("reference-root")).phase, "prepared", "invalid references must not spend or grant execution");
  await cold.admitOperator("reference-root", "operator-call", delegate);
  await assert.rejects(cold.claimAdmittedOperatorPrompt("reference-root", "foreign-parent", "delegate", delegate.prompt), /parent-mismatch/);
  const delegateClaims = await Promise.allSettled([
    cold.claimAdmittedOperatorPrompt("reference-root", "reference-root", "delegate-a", delegate.prompt),
    cold.claimAdmittedOperatorPrompt("reference-root", "reference-root", "delegate-b", delegate.prompt),
  ]);
  assert.equal(delegateClaims.filter(result => result.status === "fulfilled").length, 1);
  const delegateID = delegateClaims[0]!.status === "fulfilled" ? "delegate-a" : "delegate-b";
  const foreignDelegateID = delegateID === "delegate-a" ? "delegate-b" : "delegate-a";
  assert.equal(await cold.claimAdmittedOperatorPrompt("reference-root", "reference-root", delegateID, delegate.prompt),
    cold.operatorTask(restored).prompt, "the same native child claim is idempotent");
  await assert.rejects(cold.claimAdmittedOperatorPrompt("reference-root", "reference-root", foreignDelegateID, delegate.prompt), /child-mismatch/);
  assert.equal((cold.packet(await cold.required("reference-root")) as { next_task_ref: string | null }).next_task_ref, null,
    "root status must not expose a worker reference after the delegate is bound");
  const ready = await cold.next("reference-root", delegateID) as { task: OperatorTask };
  assert.match(ready.task.prompt, /^SORTIE_OPERATOR_TASK_REF /);
  assert.ok(ready.task.prompt.length < restored.units[0]!.task.prompt.length / 2);
  const packet = cold.packet(await cold.required("reference-root")) as { next_task_ref: string; units: Array<{ task_ref: string }> };
  assert.equal(packet.next_task_ref, null);
  assert.equal(packet.units[0]!.task_ref, ready.task.prompt);
  const parsed = JSON.parse(ready.task.prompt.slice("SORTIE_OPERATOR_TASK_REF ".length));
  for (const changed of [
    { ...parsed, r: "foreign-root" },
    { ...parsed, g: parsed.g + 1 },
    { ...parsed, u: "second" },
    { ...parsed, p: "0".repeat(64) },
  ]) await assert.rejects(cold.admitWorker("reference-root", delegateID, `bad-${changed.u}-${changed.g}`,
    { ...ready.task, prompt: `SORTIE_OPERATOR_TASK_REF ${JSON.stringify(changed)}` }), /not-authorized/);
  const expanded = await cold.admitWorker("reference-root", delegateID, "worker-call", ready.task);
  assert.equal(expanded.prompt, restored.units[0]!.task.prompt);
  assert.match(expanded.prompt, /^role: implementation/m);

  const legacy = await preparedBy.prepare("legacy-root", plan());
  await preparedBy.admitOperator("legacy-root", "legacy-op", preparedBy.operatorTask(legacy));
  await preparedBy.bindOperator("legacy-root", "legacy-delegate", preparedBy.operatorTask(legacy).prompt);
  const legacyExpanded = await preparedBy.admitWorker("legacy-root", "legacy-delegate", "legacy-call", legacy.units[0]!.task);
  assert.deepEqual(legacyExpanded, legacy.units[0]!.task);
}));

test("each unit in a three-unit queue returns only its immutable reference and dispatch instruction", async () => fixture(async root => {
  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const state = await runtime.prepare("three-root", representativeLongPlan());
  await runtime.admitOperator("three-root", "operator-call", runtime.operatorTask(state));
  await runtime.bindOperator("three-root", "delegate", runtime.operatorTask(state).prompt);
  const seen = new Set<string>();
  for (let index = 0; index < 3; index++) {
    const next = await runtime.next("three-root", "delegate") as {
      task: OperatorTask; dispatch_instruction: string;
    };
    assert.match(next.task.prompt, /^SORTIE_OPERATOR_TASK_REF /);
    assert.match(next.dispatch_instruction, /sole exact SORTIE_OPERATOR_TASK_REF/);
    assert.equal(JSON.stringify(next).includes("role: implementation"), false);
    assert.equal(seen.has(next.task.prompt), false);
    seen.add(next.task.prompt);
    const callID = `worker-${index + 1}`;
    await runtime.admitWorker("three-root", "delegate", callID, next.task);
    await runtime.settled({ rootSessionID: "three-root", callID, unitID: `unit-${index + 1}`,
      childSessionID: `child-${index + 1}`, disposition: "succeeded", resultClass: "acceptance",
      evidence: [] });
  }
  const terminal = await runtime.next("three-root", "delegate") as { status: string; next_task_ref: string | null };
  assert.equal(terminal.status, "awaiting-acceptance");
  assert.equal(terminal.next_task_ref, null);
}));

test("worker prompt claim is serialized, parent-bound, and first-child immutable", async () => fixture(async root => {
  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const state = await runtime.prepare("claim-root", plan());
  const operator = runtime.operatorTask(state);
  await runtime.admitOperator("claim-root", "operator-call", operator);
  await runtime.bindOperator("claim-root", "delegate", operator.prompt);
  const next = await runtime.next("claim-root", "delegate") as { task: OperatorTask };
  await runtime.admitWorker("claim-root", "delegate", "worker-call", next.task);
  await assert.rejects(runtime.claimAdmittedWorkerPrompt("claim-root", "claim-root", "nested", next.task.prompt), /parent-mismatch/);
  assert.equal((await runtime.required("claim-root")).units[0]!.childSessionID, null);
  const claims = await Promise.allSettled([
    runtime.claimAdmittedWorkerPrompt("claim-root", "delegate", "child-a", next.task.prompt),
    runtime.claimAdmittedWorkerPrompt("claim-root", "delegate", "child-b", next.task.prompt),
  ]);
  assert.equal(claims.filter(result => result.status === "fulfilled").length, 1);
  const winner = claims[0]!.status === "fulfilled" ? "child-a" : "child-b";
  const loser = winner === "child-a" ? "child-b" : "child-a";
  assert.equal((await runtime.required("claim-root")).units[0]!.childSessionID, winner);
  await runtime.claimAdmittedWorkerPrompt("claim-root", "delegate", winner, next.task.prompt);
  await runtime.observeChild("claim-root", "worker-call", winner);
  await assert.rejects(runtime.observeChild("claim-root", "worker-call", loser), /child-mismatch/);
  assert.equal((await runtime.required("claim-root")).units[0]!.childSessionID, winner);
}));

test("single unit keeps the direct fast path and incomplete operator return is not acceptance", async () => fixture(async root => {
  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const one = plan(); one.units = one.units.slice(0, 1);
  one.goal_declaration.criteria = one.goal_declaration.criteria.slice(0, 1);
  one.acceptance_proof = [["first"], ["first"]];
  const state = await runtime.prepare("root", one);
  await assert.rejects(runtime.admitOperator("root", "op", runtime.operatorTask(state)), /authorized/);
  const task = await runtime.next("root", "root") as { task: object };
  await runtime.admitWorker("root", "root", "worker", task.task);
  const ended = await runtime.operatorReturned("root");
  assert.equal(ended.phase, "awaiting-decision");
  assert.equal((runtime.packet(ended) as { final_acceptance: string }).final_acceptance, "coordinator-required");
}));

test("cancelled repair plans retain acceptance and the parent fingerprint", async () => fixture(async root => {
  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const original = plan();
  const before = await runtime.prepare("repair-root", original);
  const first = await runtime.next("repair-root", "repair-root") as { task: object };
  await assert.rejects(runtime.admitWorker("repair-root", "repair-root", "first-call", first.task), /owner-mismatch/);
  const single = { ...original, units: original.units.slice(0, 1), goal_declaration: { ...original.goal_declaration,
    criteria: original.goal_declaration.criteria.slice(0, 1) }, acceptance_proof: [["first"], ["first"]] };
  const acceptedRuntime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const acceptedBefore = await acceptedRuntime.prepare("accepted-repair-root", single);
  const acceptedTask = await acceptedRuntime.next("accepted-repair-root", "accepted-repair-root") as { task: object };
  await acceptedRuntime.admitWorker("accepted-repair-root", "accepted-repair-root", "accepted-call", acceptedTask.task);
  await acceptedRuntime.settled({ rootSessionID: "accepted-repair-root", callID: "accepted-call", unitID: "first",
    childSessionID: "accepted-child", disposition: "succeeded", evidence: [], resultClass: "acceptance" });
  await acceptedRuntime.interrupted("accepted-repair-root", "repair-needed");
  const acceptedRepair = await acceptedRuntime.prepare("accepted-repair-root", single);
  assert.equal(acceptedRepair.parentRunID, acceptedBefore.runID);
  assert.deepEqual(acceptedRepair.priorAcceptedUnits, [{ taskID: `${acceptedBefore.runID}-1`,
    handoffPath: acceptedBefore.units[0]!.handoffPath, handoffHash: acceptedBefore.units[0]!.hashes[0] }]);
  await runtime.interrupted("repair-root", "repair-needed");
  await assert.rejects(runtime.prepare("repair-root", { ...original, acceptance: ["Narrower repair", original.acceptance[1]] }), /carry-forward-required/);
  assert.equal((await runtime.required("repair-root")).runID, before.runID);
  const next = await runtime.prepare("repair-root", original);
  const h = JSON.parse(await readFile(next.units[0]!.handoffPath, "utf8"));
  assert.equal(h.ext["sortie-dogs/acceptance-continuity"].parent_fingerprint, before.acceptanceFingerprint);
  assert.deepEqual(h.ext["sortie-dogs/acceptance-continuity"].criteria, original.acceptance);
  await runtime.interrupted("repair-root", "append-required");
  const appended = { ...original, acceptance: [...original.acceptance, "Additional accepted condition"],
    acceptance_proof: [...original.acceptance_proof, ["second"]],
    units: original.units.map((unit, index) => index === 1 ? { ...unit, acceptance_indices: [...unit.acceptance_indices, 2] } : unit) };
  const latest = await runtime.prepare("repair-root", appended);
  const h2 = JSON.parse(await readFile(latest.units[0]!.handoffPath, "utf8"));
  assert.equal(h2.ext["sortie-dogs/acceptance-continuity"].parent_fingerprint, next.acceptanceFingerprint);
  assert.deepEqual(h2.ext["sortie-dogs/acceptance-continuity"].criteria, appended.acceptance);
}));

test("rejected dispatches fail only a still-running unit and preserve an existing settlement", async () => fixture(async root => {
  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const state = await runtime.prepare("root", plan());
  const operator = runtime.operatorTask(state);
  await runtime.admitOperator("root", "operator-call", operator);
  await runtime.bindOperator("root", "operator-child", operator.prompt);
  const next = await runtime.next("root", "operator-child") as { task: object };
  await runtime.admitWorker("root", "operator-child", "worker-call", next.task);
  await runtime.rejectDispatch("root", "worker-call");
  const rejected = await runtime.required("root");
  assert.equal(rejected.phase, "awaiting-decision");
  assert.equal(rejected.decision, "native-task-rejected");
  assert.deepEqual(rejected.units[0], { ...rejected.units[0], status: "failed", childSessionID: null,
    evidence: [], resultClass: "process-defect" });

  const successful = await runtime.prepare("successful-root", plan());
  const successfulOperator = runtime.operatorTask(successful);
  await runtime.admitOperator("successful-root", "successful-operator-call", successfulOperator);
  await runtime.bindOperator("successful-root", "successful-operator", successfulOperator.prompt);
  const successfulNext = await runtime.next("successful-root", "successful-operator") as { task: object };
  await runtime.admitWorker("successful-root", "successful-operator", "successful-call", successfulNext.task);
  await runtime.settled({ rootSessionID: "successful-root", callID: "successful-call", unitID: successful.units[0]!.unit.id,
    childSessionID: "successful-child", disposition: "succeeded", evidence: [], resultClass: "acceptance" });
  await runtime.rejectDispatch("successful-root", "successful-call");
  const retained = await runtime.required("successful-root");
  assert.equal(retained.units[0]!.status, "succeeded");
  assert.equal(retained.units[0]!.childSessionID, "successful-child");
  assert.equal(retained.units[0]!.resultClass, "acceptance");
}));

test("preview reconciles native post-admission Task errors without treating pre-admission denial as spend", async () => fixture(async root => {
  const identities: Record<string, { agent: string; parentID?: string }> = {
    root: { agent: "dog-operator" },
    operator: { agent: "dogs-coordinator", parentID: "root" },
    worker: { agent: profileAgent(V010_RUNTIME_PROFILE, "dog-worker"), parentID: "operator" },
    foreignWorker: { agent: profileAgent(V010_RUNTIME_PROFILE, "dog-worker"), parentID: "operator" },
    nestedWorker: { agent: profileAgent(V010_RUNTIME_PROFILE, "dog-worker"), parentID: "foreignWorker" },
  };
  const client = { config: { providers: async () => ({ data: { providers: [{ id: "openai", models: {
    "gpt-6-astra": { id: "gpt-6-astra" }, "gpt-5.6-terra": { id: "gpt-5.6-terra" },
    "gpt-5.6-sol": { id: "gpt-5.6-sol" },
  } }] } }) }, session: {
    get: async ({ path }: { path: { id: string } }) => ({ data: identities[path.id] }),
    messages: async () => ({ data: [] }),
  } };
  const hooks = await SortieDogsV010Plugin({ directory: root, client } as never, { modelCatalog: { global: [
    { model: "openai/gpt-6-astra", variants: ["high"] },
    { model: "openai/gpt-5.6-terra", variants: ["high", "xhigh"] },
    { model: "openai/gpt-5.6-sol", variants: ["low", "medium"] },
  ] } });
  await hooks["chat.message"]!({ sessionID: "root", messageID: "root-user", agent: "dog-operator",
    model: { providerID: "openai", modelID: "gpt-6-astra" } }, {
    message: { id: "root-user", agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-6-astra" } },
    parts: [{ type: "text", text: "Implement the exact approved operator plan." }],
  });
  const prepared = JSON.parse(await hooks.tool!.sortie_v010_prepare_operator.execute(
    { plan_json: JSON.stringify(plan()) }, { sessionID: "root" })) as { task: { prompt: string; subagent_type: string; description: string } };
  assert.match(prepared.task.prompt, /^SORTIE_OPERATOR_DELEGATE_REF /);
  const preparedStatus = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.equal(preparedStatus.next_task_ref, prepared.task.prompt);
  const preparedKey = createHash("sha256").update("v010\u0000root").digest("hex");
  const preparedLedger = JSON.parse(await readFile(join(root, ".sortie-dogs-v010", "run-flight", `${preparedKey}.json`), "utf8"));
  assert.equal(preparedLedger.goal_events.filter(({ event }: { event: { kind: string } }) => event.kind === "goal.revised").length, 1,
    "goal declaration must be registered before a ready Task is returned");
  assert.equal(preparedLedger.goal_events.some(({ event }: { event: { kind: string } }) => event.kind === "dispatch.reserved"), false);
  const admittedDelegate = { args: structuredClone(prepared.task) };
  await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "operator-call" }, admittedDelegate);
  assert.equal(admittedDelegate.args.prompt, prepared.task.prompt, "root Task history must retain the delegate reference");
  const operatorMessage = {
    message: { id: "operator-user", agent: "dogs-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
    parts: [{ type: "text", text: prepared.task.prompt }],
  };
  await hooks["chat.message"]!({ sessionID: "operator", messageID: "operator-user", agent: "dogs-coordinator" }, operatorMessage);
  assert.match(operatorMessage.parts[0]!.text, /^operator_run_id: /m);
  assert.doesNotMatch(operatorMessage.parts[0]!.text, /^SORTIE_OPERATOR_DELEGATE_REF /);
  const next = JSON.parse(await hooks.tool!.sortie_v010_operator_next.execute({}, { sessionID: "operator" })) as {
    task: { prompt: string; subagent_type: string; description: string };
  };
  await assert.rejects(hooks["tool.execute.before"]!({ tool: "task", sessionID: "operator", callID: "denied-call" },
    { args: { ...next.task, prompt: `${next.task.prompt}\nchanged` } }), /not-authorized/);

  const admitted = { args: next.task };
  await hooks["tool.execute.before"]!({ tool: "task", sessionID: "operator", callID: "worker-call" }, admitted);
  assert.equal(admitted.args.prompt, next.task.prompt, "native Task input must retain the opaque reference in operator history");
  const nestedMessage = {
    message: { id: "nested-user", agent: profileAgent(V010_RUNTIME_PROFILE, "dog-worker"),
      model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text: admitted.args.prompt }],
  };
  await assert.rejects(hooks["chat.message"]!({ sessionID: "nestedWorker", messageID: "nested-user",
    agent: profileAgent(V010_RUNTIME_PROFILE, "dog-worker") }, nestedMessage), /parent-mismatch/);
  await assert.rejects(hooks["tool.execute.before"]!({ tool: "read", sessionID: "nestedWorker", callID: "nested-read" },
    { args: { filePath: "check-first.mjs" } }), /operator-worker-owner-mismatch/);
  const workerMessage = {
    message: { id: "worker-user", agent: profileAgent(V010_RUNTIME_PROFILE, "dog-worker"),
      model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text: admitted.args.prompt }],
  };
  await hooks["chat.message"]!({ sessionID: "worker", messageID: "worker-user",
    agent: profileAgent(V010_RUNTIME_PROFILE, "dog-worker") }, workerMessage);
  assert.match(workerMessage.parts[0]!.text, /^role: implementation/m,
    "the host must expand the exact admitted reference only inside its worker session");
  assert.match(workerMessage.parts[0]!.text, /Preserve existing public API success and error return semantics/u);
  assert.doesNotMatch(workerMessage.parts[0]!.text, /^SORTIE_OPERATOR_TASK_REF /);
  const foreignMessage = {
    message: { id: "foreign-user", agent: profileAgent(V010_RUNTIME_PROFILE, "dog-worker"),
      model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text: admitted.args.prompt }],
  };
  await assert.rejects(hooks["chat.message"]!({ sessionID: "foreignWorker", messageID: "foreign-user",
    agent: profileAgent(V010_RUNTIME_PROFILE, "dog-worker") }, foreignMessage), /child-mismatch/);
  assert.equal(foreignMessage.parts[0]!.text, admitted.args.prompt, "foreign child must not receive canonical instructions");
  const key = createHash("sha256").update("v010\u0000root").digest("hex");
  const ledgerPath = join(root, ".sortie-dogs-v010", "run-flight", `${key}.json`);
  const before = JSON.parse(await readFile(ledgerPath, "utf8"));
  assert.equal(before.goal_events.filter(({ event }: { event: { kind: string } }) => event.kind === "dispatch.reserved").length, 1);
  await hooks.event!({ event: { type: "message.part.updated", properties: { part: { type: "tool", tool: "task",
    sessionID: "operator", callID: "worker-call", state: { status: "error",
      error: "Subagent depth limit reached (1). Increase subagent_depth to allow nested subagents." } } } } });

  const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.equal(status.status, "awaiting-decision");
  assert.equal(status.units[0].status, "failed");
  assert.equal(status.units[0].child_session_id, "worker");
  assert.equal(status.units[0].result_class, "process-defect");
  assert.deepEqual(status.units[0].evidence, []);
  assert.equal(status.resume_requires_host_reconciliation, true);
  assert.match(status.next_action, /resume_operator once[\s\S]+dispatch that exact Task in this turn/u);
  assert.equal(status.requirements.every(({ status }: { status: string }) => status === "unproven"), true);
  assert.equal(status.final_acceptance, "coordinator-required");
  const after = JSON.parse(await readFile(ledgerPath, "utf8"));
  const reservations = after.goal_events.filter(({ event }: { event: { kind: string } }) => event.kind === "dispatch.reserved");
  const settlements = after.goal_events.filter(({ event }: { event: { kind: string } }) => event.kind === "unit.settled");
  assert.equal(reservations.length, 1, "pre-admission denial must not reserve or spend");
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].event.disposition, "failed");
  assert.equal(settlements[0].event.result_class, "process-defect");
  assert.deepEqual(settlements[0].event.evidence, []);
}));

test("preview plugin exports only its own serial capabilities and ignores ordinary build", async () => fixture(async root => {
  const hooks = await SortieDogsV010Plugin({ directory: root });
  assert.ok(hooks.tool?.sortie_v010_prepare_operator);
  assert.ok(hooks.tool?.sortie_v010_repair_operator_plan);
  assert.ok(hooks.tool?.sortie_v010_complete_operator);
  assert.ok(hooks.tool?.sortie_v010_resolve_operator_contract_repair);
  assert.match(hooks.tool!.sortie_v010_resolve_operator_contract_repair.description, /only decision is discard-transient/u);
  assert.ok(hooks.tool?.sortie_v010_bind_write_gate);
  assert.equal(hooks.tool?.sortie_bind_write_gate, undefined);
  assert.equal(hooks.tool?.sortie_compact_and_continue, undefined);
  assert.ok(hooks.tool?.sortie_v010_compact_and_continue);
  assert.equal(hooks.tool?.sortie_v010_prepare_luna_fabric, undefined);
  const output = { message: { agent: "build", model: { providerID: "openai", modelID: "chosen" } }, parts: [{ type: "text", text: "ordinary work" }] };
  const before = structuredClone(output);
  await hooks["chat.message"]?.({ sessionID: "ordinary", agent: "build", messageID: "user" }, output);
  assert.deepEqual(output, before);
  await assert.rejects(hooks.tool!.sortie_v010_prepare_operator.execute({ plan_json: JSON.stringify(plan()) }, { sessionID: "ordinary" }), /root-required/);
  assert.notEqual(profileAgent(V010_RUNTIME_PROFILE, "dog-coordinator"), profileAgent(STABLE_RUNTIME_PROFILE, "dog-coordinator"));
  assert.equal(profileTool(V010_RUNTIME_PROFILE, "sortie_check_contract"), "sortie_v010_check_contract");
}));

test("explicit completion requires root identity, matching run and completed units", async () => fixture(async root => {
  const hooks = await SortieDogsV010Plugin({ directory: root });
  await hooks["chat.message"]!({ sessionID: "root", agent: "dog-operator", messageID: "root-user" }, {
    message: { agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text: "Implement the approved scope." }],
  });
  const prepared = JSON.parse(await hooks.tool!.sortie_v010_prepare_operator.execute({ plan_json: JSON.stringify(plan()) }, { sessionID: "root" }));
  const identity = { run_id: prepared.run_id, acceptance_fingerprint: prepared.acceptance_fingerprint };
  await assert.rejects(hooks.tool!.sortie_v010_complete_operator.execute(identity, { sessionID: "foreign" }), /root-required/);
  await assert.rejects(hooks.tool!.sortie_v010_complete_operator.execute({ ...identity, run_id: "wrong" }, { sessionID: "root" }), /identity-mismatch/);
  const early = JSON.parse(await hooks.tool!.sortie_v010_complete_operator.execute(identity, { sessionID: "root" }));
  assert.equal(early.status, "not-ready");
  assert.equal(early.packet.final_acceptance, "coordinator-required");
  assert.ok(early.packet.units.every((unit: { status: string }) => unit.status === "pending"));
}));

test("proposal preserves an observed generator before canonical evidence without counting it as validation", async () => fixture(async root => {
  await gitRepository(root);
  await mkdir(join(root, "parser"));
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "test"));
  const generator = "node scripts/generate-parser.mjs parser/grammar.txt parser/parser.js";
  const validator = "node test/check-generated.mjs parser/parser.js";
  await writeFile(join(root, "Makefile"), [
    "parser/parser.js: parser/grammar.txt scripts/generate-parser.mjs",
    `\t${generator}`,
    "test: parser/parser.js",
    `\t${validator}`,
    "",
  ].join("\n"));
  await writeFile(join(root, "parser", "grammar.txt"), "root := TOKEN\n");
  await writeFile(join(root, "scripts", "generate-parser.mjs"), [
    'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',
    'import { dirname } from "node:path";',
    "const [input, output] = process.argv.slice(2);",
    "mkdirSync(dirname(output), { recursive: true });",
    'writeFileSync(output, `export const grammar = ${JSON.stringify(readFileSync(input, "utf8"))};\\n`);',
    "",
  ].join("\n"));
  await writeFile(join(root, "test", "check-generated.mjs"), [
    'import { readFileSync } from "node:fs";',
    "const [output] = process.argv.slice(2);",
    'if (readFileSync(output, "utf8") !== \'export const grammar = "root := TOKEN\\\\n";\\n\') process.exit(9);',
    "",
  ].join("\n"));

  const identities: Record<string, { agent: string; parentID?: string }> = {
    root: { agent: "dog-operator" },
    "proposal-child": { agent: "dogs-coordinator", parentID: "root" },
    worker: { agent: "dog-worker-v010", parentID: "root" },
  };
  const hooks = await SortieDogsV010Plugin({ directory: root, client: { session: {
    get: async ({ path }: { path: { id: string } }) => ({ data: identities[path.id] }),
    messages: async () => ({ data: [] }),
  } } } as never);
  await hooks["chat.message"]!({ sessionID: "root", messageID: "root-user", agent: "dog-operator" }, {
    message: { agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text: "Generate the parser from the repository build recipe, then validate it." }],
  });
  const proposalIntent = { schema_version: "0.1", original_request: {
    text: "Generate the parser from the repository build recipe, then validate it.", source_ref: "user:root-user",
  }, requirements: [
    { id: "R1", text: "Generate the parser from the observed repository recipe", kind: "requirement" },
    { id: "N1", text: "Do not modify the grammar or generator", kind: "negative" },
    { id: "Q1", text: "The canonical generated-parser validator passes", kind: "quality" },
  ], authoritative_refs: ["user:root-user", "Makefile"],
  allow_read: ["Makefile", "parser/grammar.txt", "scripts/generate-parser.mjs", "test/check-generated.mjs"],
  proposal_budget: { max_reads: 2, max_submissions: 1 } };
  const started = JSON.parse(await hooks.tool!.sortie_v010_begin_operator_proposal.execute(
    { intent_json: JSON.stringify(proposalIntent) }, { sessionID: "root" }));
  await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "proposal-call" }, { args: started.task });
  const proposalMessage = { message: { agent: "dogs-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
    parts: [{ type: "text", text: started.task.prompt }] };
  await hooks["chat.message"]!({ sessionID: "proposal-child", messageID: "proposal-user", agent: "dogs-coordinator" }, proposalMessage);
  for (const [callID, filePath] of [["read-makefile", "Makefile"], ["read-generator", "scripts/generate-parser.mjs"]] as const) {
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: "proposal-child", callID }, { args: { filePath } });
    await readFile(join(root, filePath));
    await hooks["tool.execute.after"]!({ tool: "read", sessionID: "proposal-child", callID, args: { filePath } }, { output: "observed" });
  }
  const requirements = proposalIntent.requirements;
  const read = [...proposalIntent.allow_read];
  const write = ["parser/parser.js"];
  const proposedPlan = { schema_version: "0.1", acceptance_proof: requirements.map(() => ["generated-parser"]),
    source_refs: proposalIntent.authoritative_refs, goal_declaration: { delivery_intent: "implementation", delivery_mode: "mvp-first",
      usable_path_established: false, controlled_change: false, goal_budget_units: 2,
      defaults: { target: "generated parser", entrypoint: "test/check-generated.mjs", workload: "one generated parser fixture",
        oracle_coverage: ["generated content"], build_boundary: "included", source: "observed Makefile recipe", candidate: "parser/parser.js",
        source_binding: "current-protected", candidate_binding: "current-protected", fixture: "generic-node-generator",
        proof_scope: "requested-full", expected_outcome: "pass" },
      criteria: [{ criterion_id: "generated-parser", validation_command: validator }] },
    units: [{ id: "generate-parser", title: "Generate and validate parser", objective: "Run the observed generator before the canonical validator.",
      read, write, validation: [generator, validator], acceptance_indices: [0, 1, 2] }] };
  const submitted = JSON.parse(await hooks.tool!.sortie_v010_submit_operator_proposal.execute({ proposal_json: JSON.stringify({
    schema_version: "0.1", revision: 1,
    coverage: requirements.map(item => ({ requirement_id: item.id, approach: "Use the observed repository recipe and canonical oracle.", validation: validator })),
    existing_surface: requirements.map(item => ({ requirement_id: item.id, path: "Makefile",
      form: "observed generator recipe target that rebuilds the parser" })),
    uncovered: [], negative_handling: [{ requirement_id: "N1", handling: "Keep declared inputs read-only." }], read_scope: read,
    write_scope: write, budget_estimate: { proposal_reads: 2, execution_units: 1 }, plan: proposedPlan,
  }) }, { sessionID: "proposal-child" }));
  assert.equal(submitted.status, "submitted", JSON.stringify(submitted));
  await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "proposal-call" }, { output: "Submitted." });
  const approved = JSON.parse(await hooks.tool!.sortie_v010_approve_operator_proposal.execute({ approval_json: JSON.stringify({
    proposal_id: submitted.proposal_id, revision: submitted.revision, content_hash: submitted.content_hash,
    compared_requirement_ids: requirements.map(item => item.id), decision: "approve",
    rationale: "Compared observed recipe, preparatory command order, scopes, and canonical criterion.",
  }) }, { sessionID: "root" }));
  const taskInput = { args: structuredClone(approved.execution.task) };
  await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "worker-call" }, taskInput);
  const workerMessage = { message: { agent: "dog-worker-v010", model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text: taskInput.args.prompt }] };
  await hooks["chat.message"]!({ sessionID: "worker", messageID: "worker-user", agent: "dog-worker-v010" }, workerMessage);
  const manifestPath = /^operation_manifest: (.+)$/m.exec(workerMessage.parts[0]!.text)?.[1];
  const handoffPath = /^handoff_path: (.+)$/m.exec(workerMessage.parts[0]!.text)?.[1];
  assert.ok(manifestPath && handoffPath);
  const manifest = JSON.parse(await readFile(join(root, manifestPath), "utf8"));
  assert.deepEqual(manifest.validation, [generator, validator]);
  assert.deepEqual(manifest.read, read);
  assert.deepEqual(manifest.write, write);
  assert.match(workerMessage.parts[0]!.text, /Every persistent or transient generator output must be declared in unit\.write/u);
  assert.match(workerMessage.parts[0]!.text, /Cleanup may remove only declared unit\.write outputs.*before post-commit or canonical validation/u);
  assert.match(workerMessage.parts[0]!.text, /If any necessary command, input, output, or cleanup is missing.*contract-repair decision/u);
  await hooks["tool.execute.before"]!({ tool: "read", sessionID: "worker", callID: "handoff-read" }, { args: { filePath: handoffPath } });
  await readFile(handoffPath);
  await hooks["tool.execute.after"]!({ tool: "read", sessionID: "worker", callID: "handoff-read", args: { filePath: handoffPath } }, { output: "inspected" });
  assert.equal(JSON.parse(await hooks.tool!.sortie_v010_bind_write_gate.execute(
    { project_root: root, manifest_path: manifestPath }, { sessionID: "worker" })).status, "bound");

  const generatorInput = { args: { command: generator } };
  await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID: "generate" }, generatorInput);
  const generated = await promisify(execFile)(process.execPath, ["scripts/generate-parser.mjs", "parser/grammar.txt", "parser/parser.js"],
    { cwd: root, encoding: "utf8" });
  await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "worker", callID: "generate" },
    { output: generated.stdout, metadata: { exit: 0, status: "completed" } });
  await assert.rejects(hooks["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID: "undeclared-generate" },
    { args: { command: `${generator} --force` } }), /executable-not-allowlisted/);
  const ledgerPath = join(root, ".git", "sortie-dogs", "run-flight-v010",
    `${createHash("sha256").update("v010\0root").digest("hex")}.json`);
  let goal = (await RunFlightLedger.openGoal(ledgerPath)).readGoal();
  assert.deepEqual((await goal).state.acceptance_contract?.criteria.map(item => item.validation_command), [validator]);
  assert.equal((await goal).state.validation_budget.consumed, 0);
  assert.deepEqual((await goal).state.satisfied_criteria, []);

  const validationInput = { args: { command: validator } };
  await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID: "validate" }, validationInput);
  const validated = await promisify(execFile)(process.execPath, ["test/check-generated.mjs", "parser/parser.js"], { cwd: root, encoding: "utf8" });
  await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "worker", callID: "validate" },
    { output: validated.stdout, metadata: { exit: 0, status: "completed" } });
  goal = (await RunFlightLedger.openGoal(ledgerPath)).readGoal();
  assert.equal((await goal).state.validation_budget.consumed, 1);
  assert.deepEqual((await goal).state.satisfied_criteria, []);
  await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "worker-call" },
    { output: "<task_result>generated then validated</task_result>", metadata: { sessionId: "worker" } });
  const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.equal(status.status, "awaiting-acceptance", JSON.stringify(status));
  assert.deepEqual(status.units[0].evidence.map((item: { command: string[] }) => item.command), [[validator]]);
  const settled = await (await RunFlightLedger.openGoal(ledgerPath)).readGoal();
  assert.equal(settled.state.validation_budget.consumed, 1);
  assert.deepEqual(settled.state.satisfied_criteria, ["generated-parser"]);
}));

test("plugin API commits before final validation and accepts only fresh native post-commit evidence", async () => fixture(async root => {
  await gitRepository(root, { branch: "main", ignoreRuntime: false });
  await writeFile(join(root, "check-pre.mjs"), [
    'import { execFileSync } from "node:child_process";',
    'import { readFileSync } from "node:fs";',
    'const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();',
    'if (git("symbolic-ref", "--short", "HEAD") !== "feature/plugin-api") process.exit(7);',
    'if (git("status", "--porcelain=v1") === "") process.exit(8);',
    'if (git("log", "-1", "--pretty=%s") === "Apply approved operator writes") process.exit(9);',
    'if (readFileSync("result.txt", "utf8") !== "delivered\\n") process.exit(10);',
  ].join("\n"));
  await writeFile(join(root, "check-post.mjs"), [
    'import { execFileSync } from "node:child_process";',
    'import { readFileSync } from "node:fs";',
    'const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();',
    'if (git("symbolic-ref", "--short", "HEAD") !== "feature/plugin-api") process.exit(11);',
    'if (git("status", "--porcelain=v1") !== "") process.exit(12);',
    'if (git("log", "-1", "--pretty=%s") !== "Apply approved operator writes") process.exit(13);',
    'if (readFileSync("result.txt", "utf8") !== "delivered\\n") process.exit(14);',
  ].join("\n"));
  await git(root, ["add", "--", "check-pre.mjs", "check-post.mjs"]); await git(root, ["commit", "-m", "add lifecycle validators"]);
  const identities: Record<string, { agent: string; parentID?: string }> = {
    root: { agent: "dog-operator" }, worker: { agent: "dog-worker-v010", parentID: "root" },
  };
  const hooks = await SortieDogsV010Plugin({ directory: root, client: { session: {
    get: async ({ path }: { path: { id: string } }) => ({ data: identities[path.id] }), messages: async () => ({ data: [] }),
  } } } as never);
  await hooks["chat.message"]!({ sessionID: "root", messageID: "root-user", agent: "dog-operator" }, {
    message: { agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text: "Implement the approved Git lifecycle contract." }],
  });
  const lifecycleRequirements = [
    { id: "R1", text: "Commit the approved result", kind: "requirement" },
    { id: "N1", text: "Do not modify the validators", kind: "negative" },
    { id: "Q1", text: "Post-commit validation sees a clean worktree", kind: "quality" },
  ];
  const proposalIntent = { schema_version: "0.1", original_request: { text: "Implement the approved Git lifecycle contract.", source_ref: "user:root-user" },
    requirements: lifecycleRequirements, authoritative_refs: ["user:root-user"], allow_read: ["check-pre.mjs", "check-post.mjs"],
    proposal_budget: { max_reads: 2, max_submissions: 1 } };
  const started = JSON.parse(await hooks.tool!.sortie_v010_begin_operator_proposal.execute(
    { intent_json: JSON.stringify(proposalIntent) }, { sessionID: "root" }));
  await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "proposal-call" }, { args: started.task });
  identities["proposal-child"] = { agent: "dogs-coordinator", parentID: "root" };
  await hooks["chat.message"]!({ sessionID: "proposal-child", messageID: "proposal-user", agent: "dogs-coordinator" }, {
    message: { agent: "dogs-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
    parts: [{ type: "text", text: started.task.prompt }],
  });
  for (const [callID, filePath] of [["read-pre", "check-pre.mjs"], ["read-post", "check-post.mjs"]] as const) {
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: "proposal-child", callID }, { args: { filePath } });
  }
  const lifecycle = pluginLifecyclePlan("refs/heads/main");
  lifecycle.goal_declaration.goal_budget_units = 2;
  lifecycle.acceptance = lifecycleRequirements.map(item => item.text);
  lifecycle.acceptance_proof = lifecycleRequirements.map((_, index) => index === 0
    ? ["pre-commit", "post-commit"] : ["post-commit"]);
  lifecycle.units[0]!.acceptance_indices = lifecycleRequirements.map((_, index) => index);
  const submitted = JSON.parse(await hooks.tool!.sortie_v010_submit_operator_proposal.execute({ proposal_json: JSON.stringify({
    schema_version: "0.1", revision: 1,
    coverage: lifecycleRequirements.map(item => ({ requirement_id: item.id, approach: "Preserve the approved lifecycle.", validation: "node check-post.mjs" })),
    existing_surface: lifecycleRequirements.map(item => ({ requirement_id: item.id, path: "check-post.mjs",
      form: "observed post-commit oracle that inspects the committed worktree" })),
    uncovered: [], negative_handling: [{ requirement_id: "N1", handling: "Keep the validator read-only." }],
    read_scope: ["check-pre.mjs", "check-post.mjs"], write_scope: ["result.txt"], budget_estimate: { proposal_reads: 2, execution_units: 1 }, plan: lifecycle,
  }) }, { sessionID: "proposal-child" }));
  assert.equal(submitted.status, "submitted", JSON.stringify(submitted));
  await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "proposal-call" }, { output: "Submitted." });
  const invalid = JSON.parse(await hooks.tool!.sortie_v010_prepare_operator.execute(
    { plan_json: "{}" }, { sessionID: "root" }));
  assert.equal(invalid.status, "invalid-plan");
  const stateKey = createHash("sha256").update("root").digest("hex");
  await lstat(join(root, V010_RUNTIME_PROFILE.stateDirectory, "operator-proposals", `${stateKey}.json`));
  await lstat(join(root, V010_RUNTIME_PROFILE.stateDirectory, "operators", `${stateKey}.json.draft.json`));
  const approved = JSON.parse(await hooks.tool!.sortie_v010_approve_operator_proposal.execute({ approval_json: JSON.stringify({
    proposal_id: submitted.proposal_id, revision: submitted.revision, content_hash: submitted.content_hash,
    compared_requirement_ids: lifecycleRequirements.map(item => item.id), decision: "approve", rationale: "Compared every lifecycle requirement.",
  }) }, { sessionID: "root" }));
  const prepared = approved.execution;
  assert.equal(await git(root, ["symbolic-ref", "--short", "HEAD"]), "feature/plugin-api");
  assert.match(await readFile(join(root, ".git", "info", "exclude"), "utf8"), /^\/\.sortie-dogs-v010\/$/m);
  const taskInput = { args: structuredClone(prepared.task) };
  await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "worker-call" }, taskInput);
  const workerMessage = { message: { agent: "dog-worker-v010", model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text: taskInput.args.prompt }] };
  await hooks["chat.message"]!({ sessionID: "worker", messageID: "worker-user", agent: "dog-worker-v010" }, workerMessage);
  const manifestPath = /^operation_manifest: (.+)$/m.exec(workerMessage.parts[0]!.text)?.[1];
  const handoffPath = /^handoff_path: (.+)$/m.exec(workerMessage.parts[0]!.text)?.[1];
  assert.ok(manifestPath && handoffPath);
  await hooks["tool.execute.before"]!({ tool: "read", sessionID: "worker", callID: "handoff-read" }, { args: { filePath: handoffPath } });
  await readFile(handoffPath);
  await hooks["tool.execute.after"]!({ tool: "read", sessionID: "worker", callID: "handoff-read", args: { filePath: handoffPath } }, { output: "inspected" });
  const bound = JSON.parse(await hooks.tool!.sortie_v010_bind_write_gate.execute(
    { project_root: root, manifest_path: manifestPath }, { sessionID: "worker" }));
  assert.equal(bound.status, "bound");
  await writeFile(join(root, "result.txt"), "delivered\n");
  const pre = { args: { command: "node check-pre.mjs" } };
  await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID: "pre-validation" }, pre);
  assert.notEqual(await git(root, ["status", "--porcelain=v1"]), "", "non-post validation must run before host commit");
  const preResult = await promisify(execFile)(process.execPath, ["check-pre.mjs"], { cwd: root, encoding: "utf8" });
  await hooks.event!({ event: { type: "message.part.updated", properties: { part: { id: "pre-part", messageID: "pre-message",
    sessionID: "worker", type: "tool", tool: "bash", callID: "pre-validation", state: { status: "completed",
      input: { command: pre.args.command }, output: preResult.stdout, metadata: { exit: 0 },
      time: { start: Date.now() - 5, end: Date.now() } } } } } });
  await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "worker", callID: "pre-validation" },
    { output: preResult.stdout, metadata: { exit: 0, status: "completed" } });

  const validation = { args: { command: "node   check-post.mjs" } };
  await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID: "post-validation" }, validation);
  assert.equal(validation.args.command, "node check-post.mjs", "core canonical identity must drive the lifecycle boundary");
  assert.equal(await git(root, ["log", "-1", "--pretty=%s"]), "Apply approved operator writes");
  await assert.rejects(hooks["tool.execute.before"]!({ tool: "edit", sessionID: "worker", callID: "late-edit" },
    { args: { filePath: join(root, "result.txt"), oldString: "delivered", newString: "late" } }), /post-commit-write-denied/);
  const result = await promisify(execFile)(process.execPath, ["check-post.mjs"], { cwd: root, encoding: "utf8" });
  await hooks.event!({ event: { type: "message.part.updated", properties: { part: { id: "post-part", messageID: "post-message",
    sessionID: "worker", type: "tool", tool: "bash", callID: "post-validation", state: { status: "completed",
      input: { command: validation.args.command }, output: result.stdout, metadata: { exit: 0 },
      time: { start: Date.now() - 5, end: Date.now() } } } } } });
  await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "worker", callID: "post-validation" },
    { output: result.stdout, metadata: { exit: 0, status: "completed" } });
  const taskOutput = { output: "<task_result>native post-commit validation completed</task_result>", metadata: { sessionId: "worker" } };
  await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "worker-call" }, taskOutput);
  const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.equal(status.status, "awaiting-acceptance", JSON.stringify(status));
  assert.equal(status.units[0].evidence.length, 2);
  assert.deepEqual(status.units[0].evidence.map((item: { command: string[] }) => item.command),
    [["node check-pre.mjs"], ["node check-post.mjs"]]);
  const complete = JSON.parse(await hooks.tool!.sortie_v010_complete_operator.execute({ run_id: prepared.run_id,
    acceptance_fingerprint: prepared.acceptance_fingerprint }, { sessionID: "root" }));
  assert.equal(complete.status, "succeeded");
  assert.equal(await git(root, ["status", "--porcelain=v1"]), "");
}));

test("blocking review replaces a succeeded awaiting-acceptance run from its committed head and preserves goal spend", async () => fixture(async root => {
  await generatedOutputRepository(root);
  await writeFile(join(root, "scripts", "generate.mjs"), [
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'mkdirSync("generated", { recursive: true });',
    'writeFileSync("generated/main.txt", "generated-review-v1\\n");',
    'writeFileSync("generated/scratch.tmp", "scratch\\n");', "",
  ].join("\n"));
  await writeFile(join(root, "scripts", "validate-generated.mjs"), [
    'import { execFileSync } from "node:child_process";', 'import { existsSync, readFileSync } from "node:fs";',
    'const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();',
    'if (git("status", "--porcelain=v1") !== "") process.exit(11);',
    'if (!readFileSync("generated/main.txt", "utf8").startsWith("generated-review-")) process.exit(12);',
    'if (existsSync("generated/scratch.tmp")) process.exit(13);',
    'if (git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD") !== "generated/main.txt") process.exit(14);', "",
  ].join("\n"));
  await git(root, ["add", "--", "scripts/generate.mjs", "scripts/validate-generated.mjs"]);
  await git(root, ["commit", "-m", "allow review remediation fixture variants"]);

  const firstPlan = generatedOutputLifecyclePlan("feature/review-blocking-first", true, true);
  const { hooks, prepared } = await startGeneratedOutputWorker(root, firstPlan);
  const validator = "node scripts/validate-generated.mjs";
  await executeGeneratedCommand(hooks, root, "review-first-generate", "node scripts/generate.mjs", "scripts/generate.mjs");
  await executeGeneratedCommand(hooks, root, "review-first-cleanup", "node scripts/cleanup.mjs", "scripts/cleanup.mjs");
  const observeValidator = async (activeHooks: V010Hooks, sessionID: string, callID: string) => {
    await activeHooks["tool.execute.before"]!({ tool: "bash", sessionID, callID }, { args: { command: validator } });
    const result = await promisify(execFile)(process.execPath, ["scripts/validate-generated.mjs"], { cwd: root, encoding: "utf8" });
    const now = Date.now();
    await activeHooks.event!({ event: { type: "message.part.updated", properties: { part: {
      id: `${callID}-part`, messageID: `${callID}-message`, sessionID, type: "tool", tool: "bash", callID,
      state: { status: "completed", input: { command: validator }, output: result.stdout,
        metadata: { exit: 0 }, time: { start: now - 5, end: now } },
    } } } });
    await activeHooks["tool.execute.after"]!({ tool: "bash", sessionID, callID },
      { output: result.stdout, metadata: { exit: 0, status: "completed" } });
  };
  await observeValidator(hooks, "worker", "review-first-validator");
  await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "worker-call" },
    { output: "<task_result>canonical validation passed; independent review remains</task_result>", metadata: { sessionId: "worker" } });
  const awaiting = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.equal(awaiting.status, "awaiting-acceptance");
  assert.equal(awaiting.review_decision, "root-assess-independent-review");
  assert.deepEqual(awaiting.replacement_constraints.acceptance, firstPlan.acceptance);
  assert.equal(awaiting.replacement_constraints.copy_acceptance_verbatim, true);
  assert.match(awaiting.next_action, /review-blocking[\s\S]+same-goal replacement[\s\S]+committed_head/u);
  assert.match(awaiting.next_action, /copy this packet's acceptance array verbatim/u);
  assert.match(awaiting.next_action, /do not complete or ask for user approval/u);
  const committedHead = awaiting.git_lifecycle.committed_head;
  assert.match(committedHead, /^[a-f0-9]{40,64}$/u);
  const ledgerPath = join(root, ".git", "sortie-dogs", "run-flight-v010",
    `${createHash("sha256").update("v010\0root").digest("hex")}.json`);
  const retainedBudget = (await (await RunFlightLedger.openGoal(ledgerPath)).readGoal()).state.budget?.max_units;

  // Model the root's assessment of an independent blocking finding; no fake reviewer tool is needed.
  const cancelled = JSON.parse(await hooks.tool!.sortie_v010_cancel_operator.execute(
    { reason: "review-blocking" }, { sessionID: "root" }));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.decision, "operator-review-remediation-required");
  assert.equal(cancelled.final_acceptance, "coordinator-required");

  const identities: Record<string, { agent: string; parentID?: string }> = {
    root: { agent: "dog-operator" }, "review-remediation-worker": { agent: "dog-worker-v010", parentID: "root" },
  };
  const replacementHooks = await SortieDogsV010Plugin({ directory: root, client: { session: {
    get: async ({ path }: { path: { id: string } }) => ({ data: identities[path.id] }),
    messages: async () => ({ data: [] }), abort: async () => ({ data: true }),
  } } } as never);
  await replacementHooks["chat.message"]!({ sessionID: "root", messageID: "review-remediation-root", agent: "dog-operator" }, {
    message: { agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text: "Apply the blocking review finding within the unchanged approved contract." }],
  });
  const replacementPlan = structuredClone(firstPlan);
  replacementPlan.git_lifecycle.branch_create = { branch: "feature/review-blocking-remediation", start_ref: committedHead };
  replacementPlan.units[0] = { ...replacementPlan.units[0]!,
    objective: "Change only the review-blocking content and run the final canonical validator.",
    write: ["generated/main.txt"], validation: [validator] };
  const replacement = JSON.parse(await replacementHooks.tool!.sortie_v010_prepare_operator.execute(
    { plan_json: JSON.stringify(replacementPlan) }, { sessionID: "root" }));
  assert.notEqual(replacement.run_id, prepared.run_id);
  const replacementInput = { args: structuredClone(replacement.task) };
  await replacementHooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "review-remediation-call" }, replacementInput);
  const replacementMessage = { message: { agent: "dog-worker-v010", model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text: replacementInput.args.prompt }] };
  await replacementHooks["chat.message"]!({ sessionID: "review-remediation-worker", messageID: "review-remediation-user",
    agent: "dog-worker-v010" }, replacementMessage);
  const manifestPath = /^operation_manifest: (.+)$/m.exec(replacementMessage.parts[0]!.text)?.[1];
  const handoffPath = /^handoff_path: (.+)$/m.exec(replacementMessage.parts[0]!.text)?.[1];
  assert.ok(manifestPath && handoffPath);
  await replacementHooks["tool.execute.before"]!({ tool: "read", sessionID: "review-remediation-worker", callID: "review-remediation-handoff" },
    { args: { filePath: handoffPath } });
  await readFile(handoffPath);
  await replacementHooks["tool.execute.after"]!({ tool: "read", sessionID: "review-remediation-worker", callID: "review-remediation-handoff",
    args: { filePath: handoffPath } }, { output: "inspected" });
  assert.equal(JSON.parse(await replacementHooks.tool!.sortie_v010_bind_write_gate.execute(
    { project_root: root, manifest_path: manifestPath }, { sessionID: "review-remediation-worker" })).status, "bound");
  await writeFile(join(root, "generated", "main.txt"), "generated-review-v2\n");
  await observeValidator(replacementHooks, "review-remediation-worker", "review-remediation-validator");
  await replacementHooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "review-remediation-call" },
    { output: "<task_result>review remediation and canonical validation passed</task_result>",
      metadata: { sessionId: "review-remediation-worker" } });
  const ready = JSON.parse(await replacementHooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.equal(ready.status, "awaiting-acceptance", JSON.stringify(ready));
  assert.equal(ready.parent_run_id, prepared.run_id);
  assert.deepEqual(ready.prior_accepted_task_ids, [`${prepared.run_id}-1`]);
  assert.deepEqual(ready.remediation_parent, { task_id: `${prepared.run_id}-1`, committed_head: committedHead });
  const goal = (await RunFlightLedger.openGoal(ledgerPath)).readGoal();
  assert.equal((await goal).state.consumed_units, 2);
  assert.equal((await goal).state.budget?.max_units, retainedBudget);
  const complete = JSON.parse(await replacementHooks.tool!.sortie_v010_complete_operator.execute({ run_id: ready.run_id,
    acceptance_fingerprint: ready.acceptance_fingerprint }, { sessionID: "root" }));
  assert.equal(complete.status, "succeeded");
}));

test("failed post-commit acceptance cancels into a same-contract replacement from the committed candidate", async () => fixture(async root => {
  await generatedOutputRepository(root);
  const firstPlan = generatedOutputLifecyclePlan("feature/acceptance-failure", true, true);
  const { hooks } = await startGeneratedOutputWorker(root, firstPlan);
  const generator = "node scripts/generate.mjs", cleanup = "node scripts/cleanup.mjs";
  const validator = "node scripts/validate-generated.mjs";
  await executeGeneratedCommand(hooks, root, "first-generate", generator, "scripts/generate.mjs");
  await executeGeneratedCommand(hooks, root, "first-cleanup", cleanup, "scripts/cleanup.mjs");
  await writeFile(join(root, "generated", "main.txt"), "wrong\n");
  const validationInput = { args: { command: validator } };
  await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID: "first-validator" }, validationInput);
  const committedFailureHead = await git(root, ["rev-parse", "HEAD"]);
  let failureExit = 0;
  try { await promisify(execFile)(process.execPath, ["scripts/validate-generated.mjs"], { cwd: root, encoding: "utf8" }); }
  catch (error) { failureExit = Number((error as NodeJS.ErrnoException).code); }
  assert.equal(failureExit, 12);
  const failedPart = { id: "failed-validation-part", messageID: "failed-validation-message", sessionID: "worker",
    type: "tool", tool: "bash", callID: "first-validator", state: { status: "completed", input: { command: validator },
      output: "bounded failure", metadata: { exit: failureExit }, time: { start: Date.now() - 5, end: Date.now() } } };
  await hooks.event!({ event: { type: "message.part.updated", properties: { part: failedPart } } });
  await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "worker", callID: "first-validator" },
    { output: "bounded failure", metadata: { exit: failureExit, status: "completed" } });
  await assert.rejects(hooks["tool.execute.before"]!({ tool: "edit", sessionID: "worker", callID: "late-fix" },
    { args: { filePath: join(root, "generated", "main.txt"), oldString: "wrong", newString: "generated" } }),
  /post-commit-write-denied/);
  await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "worker-call" },
    { output: "<task_result>canonical validation failed</task_result>", metadata: { sessionId: "worker" } });

  const failed = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.equal(failed.status, "awaiting-decision");
  assert.equal(failed.decision, "operator-acceptance-remediation-required");
  assert.equal(failed.resume_requires_host_reconciliation, false);
  assert.equal(failed.git_lifecycle.committed_head, committedFailureHead);
  assert.deepEqual(failed.acceptance_remediation, { failed_unit_id: "generate",
    failed_criteria: [{ index: 0, criterion: firstPlan.acceptance[0] }],
    failed_evidence: { command: [validator], outcome: "fail", exit_code: 12 } });
  assert.match(failed.next_action, /cancel_operator[\s\S]+prepare_operator[\s\S]+same goal and exact acceptance/u);
  assert.doesNotMatch(failed.next_action, /solution|rerun the failed worker/iu);
  const ledgerPath = join(root, ".git", "sortie-dogs", "run-flight-v010",
    `${createHash("sha256").update("v010\0root").digest("hex")}.json`);
  const failedGoal = (await RunFlightLedger.openGoal(ledgerPath)).readGoal();
  const retainedBudget = (await failedGoal).state.budget?.max_units;
  assert.equal((await failedGoal).state.consumed_units, 1);
  await assert.rejects(hooks.tool!.sortie_v010_resume_operator.execute({ run_id: failed.run_id,
    acceptance_fingerprint: failed.acceptance_fingerprint }, { sessionID: "root" }),
  /operator-resume-acceptance-remediation-required/);
  const cancelled = JSON.parse(await hooks.tool!.sortie_v010_cancel_operator.execute({}, { sessionID: "root" }));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.decision, "operator-acceptance-remediation-required");
  assert.match(cancelled.next_action, /prepare_operator/);
  assert.match(cancelled.next_action, /git_lifecycle\.committed_head/);
  assert.doesNotMatch(cancelled.next_action, /cancel_operator/);

  const identities: Record<string, { agent: string; parentID?: string }> = {
    root: { agent: "dog-operator" }, "replacement-worker": { agent: "dog-worker-v010", parentID: "root" },
  };
  const replacementHooks = await SortieDogsV010Plugin({ directory: root, client: { session: {
    get: async ({ path }: { path: { id: string } }) => ({ data: identities[path.id] }),
    messages: async () => ({ data: [] }), abort: async () => ({ data: true }),
  } } } as never);
  await replacementHooks["chat.message"]!({ sessionID: "root", messageID: "replacement-root-user", agent: "dog-operator" }, {
    message: { agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text: "Follow the exact acceptance-remediation next_action for the same approved goal." }],
  });
  const widened = structuredClone(firstPlan);
  widened.git_lifecycle.branch_create = { branch: "feature/remediation-widened", start_ref: committedFailureHead };
  widened.units[0]!.write.push("outside.txt");
  const widenedResult = JSON.parse(await replacementHooks.tool!.sortie_v010_prepare_operator.execute(
    { plan_json: JSON.stringify(widened) }, { sessionID: "root" }));
  assert.equal(widenedResult.status, "invalid-plan");
  assert.equal(widenedResult.diagnostics[0].code, "operator-acceptance-remediation-write-scope-invalid");
  const wrongBase = structuredClone(firstPlan);
  wrongBase.git_lifecycle.branch_create = { branch: "feature/remediation-wrong-base", start_ref: "refs/heads/main" };
  const wrongBaseResult = JSON.parse(await replacementHooks.tool!.sortie_v010_prepare_operator.execute(
    { plan_json: JSON.stringify(wrongBase) }, { sessionID: "root" }));
  assert.equal(wrongBaseResult.status, "invalid-plan");
  assert.equal(wrongBaseResult.diagnostics[0].code, "operator-acceptance-remediation-baseline-mismatch");

  const replacementPlan = structuredClone(firstPlan);
  replacementPlan.acceptance = ["A narrower model-transcribed replacement summary"];
  replacementPlan.git_lifecycle.branch_create = { branch: "feature/acceptance-remediation", start_ref: committedFailureHead };
  const replacement = JSON.parse(await replacementHooks.tool!.sortie_v010_prepare_operator.execute(
    { plan_json: JSON.stringify(replacementPlan) }, { sessionID: "root" }));
  assert.notEqual(replacement.run_id, failed.run_id);
  const replacementStatus = JSON.parse(await replacementHooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.deepEqual(replacementStatus.acceptance, firstPlan.acceptance);
  assert.equal(replacementStatus.parent_run_id, failed.run_id);
  assert.deepEqual(replacementStatus.prior_accepted_task_ids, []);
  assert.deepEqual(replacementStatus.remediation_parent, { task_id: `${failed.run_id}-1`, committed_head: committedFailureHead });
  const replacementInput = { args: structuredClone(replacement.task) };
  await replacementHooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "replacement-call" }, replacementInput);
  const replacementMessage = { message: { agent: "dog-worker-v010", model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text: replacementInput.args.prompt }] };
  await replacementHooks["chat.message"]!({ sessionID: "replacement-worker", messageID: "replacement-worker-user",
    agent: "dog-worker-v010" }, replacementMessage);
  const replacementManifest = /^operation_manifest: (.+)$/m.exec(replacementMessage.parts[0]!.text)?.[1];
  const replacementHandoff = /^handoff_path: (.+)$/m.exec(replacementMessage.parts[0]!.text)?.[1];
  assert.ok(replacementManifest && replacementHandoff);
  await replacementHooks["tool.execute.before"]!({ tool: "read", sessionID: "replacement-worker", callID: "replacement-handoff" },
    { args: { filePath: replacementHandoff } });
  await readFile(replacementHandoff);
  await replacementHooks["tool.execute.after"]!({ tool: "read", sessionID: "replacement-worker", callID: "replacement-handoff",
    args: { filePath: replacementHandoff } }, { output: "inspected" });
  assert.equal(JSON.parse(await replacementHooks.tool!.sortie_v010_bind_write_gate.execute(
    { project_root: root, manifest_path: replacementManifest }, { sessionID: "replacement-worker" })).status, "bound");
  const runReplacementCommand = async (callID: string, command: string, script: string) => {
    await replacementHooks["tool.execute.before"]!({ tool: "bash", sessionID: "replacement-worker", callID }, { args: { command } });
    const result = await promisify(execFile)(process.execPath, [script], { cwd: root, encoding: "utf8" });
    await replacementHooks["tool.execute.after"]!({ tool: "bash", sessionID: "replacement-worker", callID },
      { output: result.stdout, metadata: { exit: 0, status: "completed" } });
  };
  await runReplacementCommand("replacement-generate", generator, "scripts/generate.mjs");
  await runReplacementCommand("replacement-cleanup", cleanup, "scripts/cleanup.mjs");
  await replacementHooks["tool.execute.before"]!({ tool: "bash", sessionID: "replacement-worker", callID: "replacement-validator" },
    { args: { command: validator } });
  const validation = await promisify(execFile)(process.execPath, ["scripts/validate-generated.mjs"], { cwd: root, encoding: "utf8" });
  const passedPart = { id: "passed-validation-part", messageID: "passed-validation-message", sessionID: "replacement-worker",
    type: "tool", tool: "bash", callID: "replacement-validator", state: { status: "completed", input: { command: validator },
      output: validation.stdout, metadata: { exit: 0 }, time: { start: Date.now() - 5, end: Date.now() } } };
  await replacementHooks.event!({ event: { type: "message.part.updated", properties: { part: passedPart } } });
  await replacementHooks["tool.execute.after"]!({ tool: "bash", sessionID: "replacement-worker", callID: "replacement-validator" },
    { output: validation.stdout, metadata: { exit: 0, status: "completed" } });
  await replacementHooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "replacement-call" },
    { output: "<task_result>replacement validation passed</task_result>", metadata: { sessionId: "replacement-worker" } });
  const ready = JSON.parse(await replacementHooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.equal(ready.status, "awaiting-acceptance", JSON.stringify(ready));
  const goal = (await RunFlightLedger.openGoal(ledgerPath)).readGoal();
  assert.equal((await goal).state.consumed_units, 2);
  assert.equal((await goal).state.budget?.max_units, retainedBudget);
  const complete = JSON.parse(await replacementHooks.tool!.sortie_v010_complete_operator.execute({ run_id: ready.run_id,
    acceptance_fingerprint: ready.acceptance_fingerprint }, { sessionID: "root" }));
  assert.equal(complete.status, "succeeded");
}));

test("same-contract replacement inherits the clean parent commit and runs native post-commit validation without an empty commit", async () => fixture(async root => {
  await generatedOutputRepository(root);
  const firstPlan = generatedOutputLifecyclePlan("feature/inherited-commit-first", true, true);
  const { hooks } = await startGeneratedOutputWorker(root, firstPlan);
  const validator = "node scripts/validate-generated.mjs";
  await executeGeneratedCommand(hooks, root, "inherit-generate", "node scripts/generate.mjs", "scripts/generate.mjs");
  await executeGeneratedCommand(hooks, root, "inherit-cleanup", "node scripts/cleanup.mjs", "scripts/cleanup.mjs");
  await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID: "inherit-first-validator" },
    { args: { command: validator } });
  const committedHead = await git(root, ["rev-parse", "HEAD"]);
  const failedPart = { id: "inherit-failed-part", messageID: "inherit-failed-message", sessionID: "worker",
    type: "tool", tool: "bash", callID: "inherit-first-validator", state: { status: "completed", input: { command: validator },
      output: "mock validator failure", metadata: { exit: 1 }, time: { start: Date.now() - 5, end: Date.now() } } };
  await hooks.event!({ event: { type: "message.part.updated", properties: { part: failedPart } } });
  await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "worker", callID: "inherit-first-validator" },
    { output: "mock validator failure", metadata: { exit: 1, status: "completed" } });
  await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "worker-call" },
    { output: "<task_result>post-commit validation failed</task_result>", metadata: { sessionId: "worker" } });
  const failed = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.equal(failed.decision, "operator-acceptance-remediation-required");
  assert.equal(failed.git_lifecycle.committed_head, committedHead);
  assert.equal(failed.git_lifecycle.inherited, false);
  await hooks.tool!.sortie_v010_cancel_operator.execute({}, { sessionID: "root" });

  const identities: Record<string, { agent: string; parentID?: string }> = {
    root: { agent: "dog-operator" }, "inherit-replacement-worker": { agent: "dog-worker-v010", parentID: "root" },
  };
  const replacementHooks = await SortieDogsV010Plugin({ directory: root, client: { session: {
    get: async ({ path }: { path: { id: string } }) => ({ data: identities[path.id] }),
    messages: async () => ({ data: [] }), abort: async () => ({ data: true }),
  } } } as never);
  await replacementHooks["chat.message"]!({ sessionID: "root", messageID: "inherit-replacement-root", agent: "dog-operator" }, {
    message: { agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text: "Validate the unchanged committed candidate under the exact replacement contract." }],
  });
  const replacementPlan = structuredClone(firstPlan);
  replacementPlan.acceptance = ["model-transcribed acceptance must not replace durable acceptance"];
  replacementPlan.source_refs = ["fixture:model-transcribed-source"];
  replacementPlan.git_lifecycle.branch_create = { branch: "feature/inherited-commit-replacement", start_ref: committedHead };
  replacementPlan.git_lifecycle.commit.message = "Validate the inherited parent commit";
  replacementPlan.units[0] = { ...replacementPlan.units[0]!, objective: "Validate the unchanged inherited candidate.",
    write: ["generated/main.txt"], validation: [validator] };
  const replacement = JSON.parse(await replacementHooks.tool!.sortie_v010_prepare_operator.execute(
    { plan_json: JSON.stringify(replacementPlan) }, { sessionID: "root" }));
  const replacementState = await new OperatorRuntime(root, V010_RUNTIME_PROFILE).required("root");
  assert.deepEqual(replacementState.acceptance, firstPlan.acceptance);
  assert.deepEqual(replacementState.sourceRefs, firstPlan.source_refs);
  const replacementInput = { args: structuredClone(replacement.task) };
  await replacementHooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "inherit-replacement-call" }, replacementInput);
  const replacementMessage = { message: { agent: "dog-worker-v010", model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text: replacementInput.args.prompt }] };
  await replacementHooks["chat.message"]!({ sessionID: "inherit-replacement-worker", messageID: "inherit-replacement-user",
    agent: "dog-worker-v010" }, replacementMessage);
  const manifestPath = /^operation_manifest: (.+)$/m.exec(replacementMessage.parts[0]!.text)?.[1];
  const handoffPath = /^handoff_path: (.+)$/m.exec(replacementMessage.parts[0]!.text)?.[1];
  assert.ok(manifestPath && handoffPath);
  await replacementHooks["tool.execute.before"]!({ tool: "read", sessionID: "inherit-replacement-worker", callID: "inherit-handoff" },
    { args: { filePath: handoffPath } });
  await readFile(handoffPath);
  await replacementHooks["tool.execute.after"]!({ tool: "read", sessionID: "inherit-replacement-worker", callID: "inherit-handoff",
    args: { filePath: handoffPath } }, { output: "inspected" });
  assert.equal(JSON.parse(await replacementHooks.tool!.sortie_v010_bind_write_gate.execute(
    { project_root: root, manifest_path: manifestPath }, { sessionID: "inherit-replacement-worker" })).status, "bound");
  await replacementHooks["tool.execute.before"]!({ tool: "bash", sessionID: "inherit-replacement-worker",
    callID: "inherit-replacement-validator" }, { args: { command: validator } });
  assert.equal(await git(root, ["rev-parse", "HEAD"]), committedHead);
  assert.equal(await git(root, ["status", "--porcelain=v1"]), "");
  const running = JSON.parse(await replacementHooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.equal(running.git_lifecycle.committed_head, committedHead);
  assert.equal(running.git_lifecycle.inherited, true);
  const passed = await promisify(execFile)(process.execPath, ["scripts/validate-generated.mjs"], { cwd: root, encoding: "utf8" });
  const passedPart = { id: "inherit-passed-part", messageID: "inherit-passed-message", sessionID: "inherit-replacement-worker",
    type: "tool", tool: "bash", callID: "inherit-replacement-validator", state: { status: "completed", input: { command: validator },
      output: passed.stdout, metadata: { exit: 0 }, time: { start: Date.now() - 5, end: Date.now() } } };
  await replacementHooks.event!({ event: { type: "message.part.updated", properties: { part: passedPart } } });
  await replacementHooks["tool.execute.after"]!({ tool: "bash", sessionID: "inherit-replacement-worker",
    callID: "inherit-replacement-validator" }, { output: passed.stdout, metadata: { exit: 0, status: "completed" } });
  await replacementHooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "inherit-replacement-call" },
    { output: "<task_result>inherited candidate validation passed</task_result>", metadata: { sessionId: "inherit-replacement-worker" } });
  const ready = JSON.parse(await replacementHooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
  assert.equal(ready.status, "awaiting-acceptance", JSON.stringify(ready));
  assert.equal(ready.git_lifecycle.inherited, true);
  const complete = JSON.parse(await replacementHooks.tool!.sortie_v010_complete_operator.execute({ run_id: ready.run_id,
    acceptance_fingerprint: ready.acceptance_fingerprint }, { sessionID: "root" }));
  assert.equal(complete.status, "succeeded");
}));

test("recorded native validation can be reconciled without rerun only for the same protected source", async () => fixture(async root => {
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, "verify.mjs"), "// immutable oracle\n");
  await writeFile(join(root, "result.txt"), "verified\n");
  const manifestPath = join(root, "manifest.json"), command = "node verify.mjs";
  const manifest = JSON.stringify({ version: "0.1.0", task_id: "unit", read: ["verify.mjs"], write: ["result.txt"], validation: [command] });
  await writeFile(manifestPath, manifest);
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const manifestHash = hash(manifest);
  const source = goalFingerprint({ manifest_hash: `sha256:${manifestHash}`, entries: [
    ["result.txt", "file", hash("verified\n")], ["verify.mjs", "file", hash("// immutable oracle\n")],
  ] });
  const candidate = goalFingerprint({ manifest_hash: `sha256:${manifestHash}`, entries: [["result.txt", "file", hash("verified\n")]] });
  let control: Parameters<NonNullable<RuntimeBridge["connected"]>>[0] | undefined;
  let aborts = 0;
  const now = Date.now();
  const nativeMessages = [{ info: { role: "assistant", sessionID: "child" }, parts: [{ type: "tool", tool: "bash", callID: "validate-call",
    state: { status: "completed", input: { command }, metadata: { exit: 0 }, time: { start: now, end: now + 1 } } }] }];
  const hooks = await CorePlugin({ directory: root, runtimeBridge: { profile: V010_RUNTIME_PROFILE,
    assetVersion: V010_RUNTIME_ASSET_VERSION, connected: value => { control = value; } }, client: { session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, parentID: path.id === "child" ? "root" : undefined,
        agent: path.id === "child" ? "dog-worker" : "dog-coordinator" } }),
      messages: async () => ({ data: nativeMessages }), abort: async () => { aborts++; return { data: true }; },
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
  const fp = goalFingerprint(criteria), at = new Date(now).toISOString();
  await ledger.appendGoal({ kind: "goal.revised", at, goal_id: initial.goal_id!, revision: 2, scope_epoch: 2,
    acceptance_fingerprint: fp, origin_user_message_id: "user-1", session_id: "root", selected_agent: "dog-coordinator", delivery: "mvp-first",
    budget: { max_units: 4, time_ms: null, cost_usd: null, source: "accepted-plan" }, acceptance_contract: { criteria } });
  await ledger.appendGoal({ kind: "dispatch.reserved", at, goal_id: initial.goal_id!, reservation_id: "dispatch", unit_id: "unit", session_id: "root", ticket_id: null });
  const validation = { run_id: initial.goal_id!, operation_id: "validate-call", source_snapshot: source, candidate, command: [command], scope: "full" as const,
    expected_evidence: [...new Set(criteria.flatMap(c => [c.criterion_id, ...c.oracle_coverage, "unit:unit", "source_snapshot", "candidate", "command", "scope", "exit_code"]))], reason: "acceptance" as const };
  const reservation = await ledger.reserveValidation(validation, 4);
  assert.equal(reservation.decision, "ALLOW");
  await ledger.settleValidation(reservation.reservation_id!, validation, "passed", 0);
  await ledger.appendGoal({ kind: "unit.settled", at, goal_id: initial.goal_id!, reservation_id: "dispatch", receipt_id: "old",
    unit_id: "unit", disposition: "failed", result_class: "process-defect", progress_fingerprint: null, evidence: [], elapsed_ms: 1, cost_usd: null });
  assert.ok(control);
  const request = { unitID: "unit", childSessionID: "child", manifestPath, manifestHash, goalFingerprint: fp };
  await writeFile(join(root, "result.txt"), "changed after validation\n");
  await assert.rejects(control!.recoverUnitEvidence("root", request), /unavailable-or-stale/);
  assert.deepEqual((await ledger.readGoal()).state.satisfied_criteria, []);
  await writeFile(join(root, "result.txt"), "verified\n");
  const evidence = await control!.recoverUnitEvidence("root", request);
  assert.equal(evidence.length, 3);
  assert.equal((await ledger.readGoal()).state.consumed_units, 1);
  assert.equal((await ledger.readGoal()).state.validation_budget.consumed, 1);
  assert.deepEqual(await control!.recoverUnitEvidence("root", request), evidence);
  assert.equal((await ledger.readGoal()).records.filter(({ event }) => event.kind === "unit.evidence-reconciled").length, 1);
  const criteriaText = criteria.map(criterion => criterion.target);
  const continuity = { schema_version: "0.1", authority: "dispatch", task_id: "unit", criteria: criteriaText,
    fingerprint: `sha256:${hash(JSON.stringify(criteriaText))}`, parent_fingerprint: "none" };
  const handoffPath = join(root, "handoff.unit.json");
  const handoffSource = JSON.stringify({ version: "0.1.0", profile: "minimal", id: "unit", created_at: at,
    task: { title: "accepted unit", objective: "same criteria" }, state: { done: [], next: ["continue"], blocked: [] }, risks: [], verification: [],
    ext: { "sortie-dogs/acceptance-continuity": continuity } });
  await writeFile(handoffPath, handoffSource);
  await assert.rejects(control!.restoreAcceptanceLineage("root", { criteria: criteriaText, fingerprint: "sha256:wrong",
    currentTaskIDs: ["replacement"] }), /lineage-invalid/);
  await control!.restoreAcceptanceLineage("root", { criteria: criteriaText, fingerprint: continuity.fingerprint,
    currentTaskIDs: ["replacement"] });
  await assert.rejects(control!.restoreAcceptedUnit("root", { taskID: "unit", handoffPath, handoffHash: "incorrect" }), /control-changed/);
  await control!.restoreAcceptedUnit("root", { taskID: "unit", handoffPath, handoffHash: hash(handoffSource) });
  const system = { system: [] as string[] };
  await hooks["experimental.chat.system.transform"]!({ sessionID: "root" }, system);
  assert.ok(system.system.some(text => text.includes('"latest_accepted_task_id":"unit"') && text.includes(continuity.fingerprint)));
  await ledger.appendGoal({ kind: "dispatch.reserved", at, goal_id: initial.goal_id!, reservation_id: "parent-dispatch",
    unit_id: "parent-unit", session_id: "root", ticket_id: null });
  await ledger.appendGoal({ kind: "unit.settled", at, goal_id: initial.goal_id!, reservation_id: "parent-dispatch", receipt_id: "parent",
    unit_id: "parent-unit", disposition: "failed", result_class: "process-defect", progress_fingerprint: null, evidence: [], elapsed_ms: 1, cost_usd: null });
  await assert.rejects(control!.restoreAcceptanceRemediationBaseline("root", { failedTaskID: "parent-unit", criteria: criteriaText,
    fingerprint: continuity.fingerprint, currentTaskIDs: ["foreign-unit"] }), /newer-state/);
  await control!.restoreAcceptanceRemediationBaseline("root", { failedTaskID: "parent-unit", criteria: criteriaText,
    fingerprint: continuity.fingerprint, currentTaskIDs: ["unit"] });
  await control!.restoreAcceptedUnit("root", { taskID: "unit", handoffPath, handoffHash: hash(handoffSource) });
  assert.equal(await control!.hasNoGoalReservation("root", "not-started-unit", "not-started-call"), true);
  assert.equal(await control!.hasNoGoalReservation("foreign", "unit", "call"), false);
  assert.equal((await control!.completeRoot("root", fp)).status, "succeeded");
  assert.equal(aborts, 0, "successful reconciliation/completion must not abort the root");
  const receipt = (await ledger.readGoal()).state.receipt!;
  const report = await control!.renderReturnReport("root", "## 変更点\naccepted change\n\n## 次\nnone", goalFingerprint(receipt));
  assert.ok(report?.includes("🐾 SORTIE DOGS — 帰還報告"));
  for (const symbol of ["⚔️ MISSION", "🪙 COST / PACK", "📜 PACK RECORD", "🟢 COMPLETED"]) assert.ok(report!.includes(symbol));
  assert.equal(await control!.renderReturnReport("root", "untrusted", goalFingerprint("wrong receipt")), undefined);

  const completed = Date.parse(receipt.ended_at) + 1;
  const info = { id: "final-message", sessionID: "root", role: "assistant", agent: "dog-operator", finish: "stop", time: { created: completed, completed } };
  let storedPart = { id: "final-part", sessionID: "root", messageID: "final-message", type: "text", text: "## 変更点\naccepted change\n\n## 次\nnone" };
  let updates = 0;
  const viewer = await SortieDogsV010Plugin({ directory: root, client: {
    _client: { patch: async (value: { url: string; path: { sessionID: string; messageID: string; partID: string }; body: typeof storedPart }) => {
      assert.equal(value.url, "/session/{sessionID}/message/{messageID}/part/{partID}");
      assert.deepEqual(value.path, { sessionID: "root", messageID: "final-message", partID: "final-part" });
      storedPart = value.body; updates++; return { data: storedPart };
    } },
    session: { get: async () => ({ data: { id: "root", agent: "dog-operator" } }), children: async () => ({ data: [] }),
      message: async () => ({ data: { info, parts: [storedPart] } }), messages: async () => ({ data: [{ info, parts: [storedPart] }] }) },
  } } as never);
  await viewer.event!({ event: { type: "message.updated", properties: { info: { ...info, finish: "tool-calls" } } } });
  assert.equal(updates, 0, "intermediate tool messages are not final reports");
  await viewer.event!({ event: { type: "message.updated", properties: { info } } });
  assert.equal(updates, 1);
  assert.ok(storedPart.text.includes("🐾 SORTIE DOGS — 帰還報告"));
  await viewer.event!({ event: { type: "message.updated", properties: { info } } });
  assert.equal(updates, 1, "native echo events must not duplicate the card");
}));

test("root resumes only remaining units after verified evidence without resetting spend", async () => fixture(async root => {
  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const state = await runtime.prepare("resume-root", plan());
  await runtime.admitOperator("resume-root", "old-call", runtime.operatorTask(state));
  await runtime.bindOperator("resume-root", "old-delegate", runtime.operatorTask(state).prompt);
  const first = await runtime.next("resume-root", "old-delegate") as { task: object };
  await runtime.admitWorker("resume-root", "old-delegate", "worker-call", first.task);
  await runtime.rejectDispatch("resume-root", "worker-call");
  const stopped = await runtime.next("resume-root", "resume-root") as { status: string; task?: unknown };
  assert.equal(stopped.status, "awaiting-decision"); assert.equal(stopped.task, undefined);
  await assert.rejects(runtime.resume("resume-root", state.runID, new Map()), /proof-incomplete/);
  const evidence = [{ measurement: { criterion_ids: ["first"] } }] as never;
  const next = await runtime.resume("resume-root", state.runID, new Map([["first", evidence]]));
  assert.equal(next.dispatched, 1); assert.equal(next.generation, 2);
  assert.equal(next.units[0]!.status, "succeeded"); assert.equal(next.units[1]!.status, "pending");
  await runtime.admitOperator("resume-root", "new-call", runtime.operatorTask(next));
  await runtime.bindOperator("resume-root", "new-delegate", runtime.operatorTask(next).prompt);
  await assert.rejects(runtime.next("resume-root", "old-delegate"), /owner-mismatch/);
  const remaining = await runtime.next("resume-root", "new-delegate") as { task: { description: string } };
  assert.match(remaining.task.description, /second/);
  assert.equal((await runtime.required("resume-root")).dispatched, 1);
}));

test("committed process defects become bounded acceptance remediation when native proof is unavailable", async () => fixture(async root => {
  await generatedOutputRepository(root);
  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const state = await runtime.prepare("proof-root", generatedOutputLifecyclePlan("feature/proof-remediation", true, true));
  const task = await runtime.next("proof-root", "proof-root") as { task: object };
  await runtime.admitWorker("proof-root", "proof-root", "proof-call", task.task);
  const current = await runtime.required("proof-root");
  await runtime.settled({ rootSessionID: "proof-root", callID: "proof-call", unitID: current.units[0]!.unit.id,
    disposition: "failed", resultClass: "process-defect", evidence: [] });
  const statePath = join(root, V010_RUNTIME_PROFILE.stateDirectory, "operators",
    `${createHash("sha256").update("proof-root").digest("hex")}.json`);
  const durable = JSON.parse(await readFile(statePath, "utf8"));
  durable.remediationParent = { taskID: `${state.runID}-parent`, committedHead: durable.gitLifecycle.startOID };
  await writeFile(statePath, JSON.stringify(durable));
  const cold = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const remediation = await cold.requireAcceptanceRemediation("proof-root", state.runID);
  const packet = cold.packet(remediation) as { decision: string; next_action: string; acceptance_remediation: { failed_criteria: unknown[] } };
  assert.equal(packet.decision, "operator-acceptance-remediation-required");
  assert.equal(remediation.gitLifecycle!.commitProvenance, "inherited-parent");
  assert.match(packet.next_action, /cancel_operator[\s\S]+prepare_operator/u);
  assert.ok(packet.acceptance_remediation.failed_criteria.length > 0);
  assert.match((await cold.continuationCheckpoint("proof-root"))!, /execute its cancel-then-replacement next_action in this turn/u);
  await cold.interrupted("proof-root", "operator-acceptance-remediation-required");
  const replacementPlan = generatedOutputLifecyclePlan("feature/proof-replacement", true, true);
  replacementPlan.git_lifecycle.branch_create.start_ref = remediation.gitLifecycle!.committedHead!;
  const replacement = await cold.prepare("proof-root", replacementPlan);
  assert.equal(replacement.remediationParent!.taskID, `${state.runID}-1`);
  assert.equal(replacement.remediationParent!.committedHead, remediation.gitLifecycle!.committedHead);
  assert.equal(replacement.acceptanceFingerprint, state.acceptanceFingerprint);
  assert.deepEqual(replacement.units[0]!.evidence, []);
}));

test("interrupted partial work is carried into the replacement instead of ending the run", async () => fixture(async root => {
  await generatedOutputRepository(root);
  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const state = await runtime.prepare("carry-root", generatedOutputLifecyclePlan("feature/carry-first", true, true));
  const task = await runtime.next("carry-root", "carry-root") as { task: object };
  await runtime.admitWorker("carry-root", "carry-root", "carry-call", task.task);
  const current = await runtime.required("carry-root");
  await mkdir(join(root, "generated"), { recursive: true });
  await writeFile(join(root, "generated", "main.txt"), "partial\n");
  await writeFile(join(root, "generated", "scratch.tmp"), "scratch\n");
  await runtime.settled({ rootSessionID: "carry-root", callID: "carry-call", unitID: current.units[0]!.unit.id,
    disposition: "failed", resultClass: "process-defect", evidence: [] });
  const statePath = join(root, V010_RUNTIME_PROFILE.stateDirectory, "operators",
    `${createHash("sha256").update("carry-root").digest("hex")}.json`);
  const durable = JSON.parse(await readFile(statePath, "utf8"));
  durable.remediationParent = { taskID: `${state.runID}-parent`, committedHead: durable.gitLifecycle.startOID };
  await writeFile(statePath, JSON.stringify(durable));
  const cold = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const remediation = await cold.requireAcceptanceRemediation("carry-root", state.runID);
  assert.equal(remediation.gitLifecycle!.commitProvenance, "inherited-parent");
  assert.deepEqual(remediation.gitLifecycle!.carriedPaths, ["generated/main.txt", "generated/scratch.tmp"]);
  const packet = cold.packet(remediation) as { next_action: string; git_lifecycle: { carried_uncommitted_paths: string[] } };
  assert.deepEqual(packet.git_lifecycle.carried_uncommitted_paths, ["generated/main.txt", "generated/scratch.tmp"]);
  assert.match(packet.next_action, /carried_uncommitted_paths/u);
  await cold.interrupted("carry-root", "operator-acceptance-remediation-required");
  const undeclared = generatedOutputLifecyclePlan("feature/carry-undeclared", false, true);
  undeclared.git_lifecycle.branch_create.start_ref = remediation.gitLifecycle!.committedHead!;
  await assert.rejects(cold.prepare("carry-root", undeclared), (error: unknown) => error instanceof OperatorContractError &&
    error.diagnostics[0]?.code === "operator-git-carried-change-undeclared" &&
    JSON.stringify(error.diagnostics[0]?.repair_paths) === JSON.stringify(["generated/scratch.tmp"]));
  const replacementPlan = generatedOutputLifecyclePlan("feature/carry-replacement", true, true);
  replacementPlan.git_lifecycle.branch_create.start_ref = remediation.gitLifecycle!.committedHead!;
  const replacement = await cold.prepare("carry-root", replacementPlan);
  assert.deepEqual(replacement.gitLifecycle!.carriedPaths, ["generated/main.txt", "generated/scratch.tmp"]);
  assert.equal(await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]), "feature/carry-replacement");
  assert.equal(await readFile(join(root, "generated", "main.txt"), "utf8"), "partial\n");
}));

test("a frozen contract requires existing-surface claims proven by real reads", async () => fixture(async root => {
  await writeFile(join(root, "grammar.txt"), "declaration: var names ':' type '=' values\n");
  await writeFile(join(root, "dispatch.txt"), "assign: single | unpacked\n");
  const proposals = new OperatorProposalRuntime(root, V010_RUNTIME_PROFILE);
  const requirements = [{ id: "R1", text: "Constrain every declared binding", kind: "requirement" as const }];
  const state = await proposals.begin("surface-root", { schema_version: "0.1",
    original_request: { text: "Constrain every declared binding.", source_ref: "user:root" }, requirements,
    authoritative_refs: ["user:root"], allow_read: ["grammar.txt", "dispatch.txt"],
    proposal_budget: { max_reads: 4, max_submissions: 6 } });
  await proposals.admit("surface-root", "proposal-call", proposals.task(state));
  await proposals.bind("surface-root", "proposal-child", proposals.task(state).prompt);
  const plan = { schema_version: "0.1", acceptance_proof: [["bound"]], source_refs: ["user:root"],
    goal_declaration: { delivery_intent: "implementation", delivery_mode: "mvp-first", usable_path_established: false,
      controlled_change: false, goal_budget_units: 2,
      defaults: { target: "declared bindings", entrypoint: "check.mjs", workload: "fixture", oracle_coverage: ["content"],
        build_boundary: "not-applicable", source: "source", candidate: "candidate", fixture: "fixture",
        source_binding: "current-protected", candidate_binding: "current-protected", proof_scope: "requested-full",
        expected_outcome: "pass" },
      criteria: [{ criterion_id: "bound", validation_command: "node check.mjs" }] },
    units: [{ id: "bind", title: "Constrain bindings", objective: "Constrain every declared binding path.",
      read: ["grammar.txt"], write: ["binding.txt"], validation: ["node check.mjs"], acceptance_indices: [0] }] };
  const packet = (surface: unknown, reads: number) => ({ schema_version: "0.1", revision: 1,
    coverage: [{ requirement_id: "R1", approach: "Intercept every declared binding form.", validation: "node check.mjs" }],
    existing_surface: surface, uncovered: [], negative_handling: [], read_scope: ["grammar.txt", "dispatch.txt"],
    write_scope: ["binding.txt"], budget_estimate: { proposal_reads: reads, execution_units: 1 }, plan });
  await assert.rejects(proposals.submit("surface-root", "proposal-child", packet([], 0)),
    /operator-proposal-existing-surface-incomplete/u);
  await assert.rejects(proposals.submit("surface-root", "proposal-child",
    packet([{ requirement_id: "R1", path: "grammar.txt", form: "multi-name declaration with a single unpacked value" }], 0)),
    /operator-proposal-existing-surface-unread/u);
  await proposals.accountRead("surface-root", "proposal-child", "grammar.txt");
  await assert.rejects(proposals.submit("surface-root", "proposal-child",
    packet([{ requirement_id: "R1", path: "grammar.txt", form: "" }], 1)),
    /operator-proposal-existing-surface-invalid/u);
  const submitted = await proposals.submit("surface-root", "proposal-child",
    packet([{ requirement_id: "R1", path: "grammar.txt", form: "multi-name declaration with a single unpacked value" }], 1));
  assert.equal(submitted.phase, "submitted");
  assert.deepEqual(submitted.proposal!.existing_surface.map(item => item.path), ["grammar.txt"]);
}));

test("an interrupted first run recovers from its own start commit", async () => fixture(async root => {
  await generatedOutputRepository(root);
  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const state = await runtime.prepare("first-root", generatedOutputLifecyclePlan("feature/first-carry", true, true));
  const task = await runtime.next("first-root", "first-root") as { task: object };
  await runtime.admitWorker("first-root", "first-root", "first-call", task.task);
  const current = await runtime.required("first-root");
  await mkdir(join(root, "generated"), { recursive: true });
  await writeFile(join(root, "generated", "main.txt"), "partial\n");
  await runtime.settled({ rootSessionID: "first-root", callID: "first-call", unitID: current.units[0]!.unit.id,
    disposition: "failed", resultClass: "process-defect", evidence: [] });
  const remediation = await runtime.requireAcceptanceRemediation("first-root", state.runID);
  assert.equal(remediation.gitLifecycle!.commitProvenance, "uncommitted-baseline");
  assert.equal(remediation.gitLifecycle!.committedHead, remediation.gitLifecycle!.startOID);
  assert.deepEqual(remediation.gitLifecycle!.carriedPaths, ["generated/main.txt"]);
  await runtime.interrupted("first-root", "operator-acceptance-remediation-required");
  const replacementPlan = generatedOutputLifecyclePlan("feature/first-replacement", true, true);
  replacementPlan.git_lifecycle.branch_create.start_ref = remediation.gitLifecycle!.committedHead!;
  const replacement = await runtime.prepare("first-root", replacementPlan);
  assert.deepEqual(replacement.gitLifecycle!.carriedPaths, ["generated/main.txt"]);
  assert.equal(await readFile(join(root, "generated", "main.txt"), "utf8"), "partial\n");
}));

test("an interrupted run keeps its own authorized commits as the remediation baseline", async () => fixture(async root => {
  await generatedOutputRepository(root);
  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const state = await runtime.prepare("history-root", generatedOutputLifecyclePlan("feature/history-carry", true, true));
  const task = await runtime.next("history-root", "history-root") as { task: object };
  await runtime.admitWorker("history-root", "history-root", "history-call", task.task);
  const current = await runtime.required("history-root");
  await mkdir(join(root, "generated"), { recursive: true });
  await writeFile(join(root, "generated", "main.txt"), "committed partial\n");
  await git(root, ["add", "--", "generated/main.txt"]);
  await git(root, ["commit", "-m", "worker partial commit"]);
  await writeFile(join(root, "generated", "scratch.tmp"), "scratch\n");
  await runtime.settled({ rootSessionID: "history-root", callID: "history-call", unitID: current.units[0]!.unit.id,
    disposition: "failed", resultClass: "process-defect", evidence: [] });
  const remediation = await runtime.requireAcceptanceRemediation("history-root", state.runID);
  assert.equal(remediation.gitLifecycle!.commitProvenance, "existing-history");
  assert.notEqual(remediation.gitLifecycle!.committedHead, remediation.gitLifecycle!.startOID);
  assert.deepEqual(remediation.gitLifecycle!.carriedPaths, ["generated/scratch.tmp"]);
}));

test("uncommitted paths outside the interrupted unit's writes keep the remediation route closed", async () => fixture(async root => {
  await generatedOutputRepository(root);
  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const state = await runtime.prepare("outside-root", generatedOutputLifecyclePlan("feature/outside-first", true, true));
  const task = await runtime.next("outside-root", "outside-root") as { task: object };
  await runtime.admitWorker("outside-root", "outside-root", "outside-call", task.task);
  const current = await runtime.required("outside-root");
  await writeFile(join(root, "seed.txt"), "mutated outside the approved writes\n");
  await runtime.settled({ rootSessionID: "outside-root", callID: "outside-call", unitID: current.units[0]!.unit.id,
    disposition: "failed", resultClass: "process-defect", evidence: [] });
  const statePath = join(root, V010_RUNTIME_PROFILE.stateDirectory, "operators",
    `${createHash("sha256").update("outside-root").digest("hex")}.json`);
  const durable = JSON.parse(await readFile(statePath, "utf8"));
  durable.remediationParent = { taskID: `${state.runID}-parent`, committedHead: durable.gitLifecycle.startOID };
  await writeFile(statePath, JSON.stringify(durable));
  const cold = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  await assert.rejects(cold.requireAcceptanceRemediation("outside-root", state.runID), /operator-process-remediation-not-ready/);
}));

test("confirmed pre-admission rejection reopens only the unstarted unit and retains attempt accounting", async () => fixture(async root => {
  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const initial = await runtime.prepare("unstarted-root", plan());
  await runtime.admitOperator("unstarted-root", "op1", runtime.operatorTask(initial));
  await runtime.bindOperator("unstarted-root", "delegate1", runtime.operatorTask(initial).prompt);
  const first = await runtime.next("unstarted-root", "delegate1") as { task: object };
  await runtime.admitWorker("unstarted-root", "delegate1", "first-call", first.task);
  await runtime.settled({ rootSessionID: "unstarted-root", callID: "first-call", unitID: "first", disposition: "succeeded",
    resultClass: "acceptance", evidence: [{ measurement: { criterion_ids: ["first"] } }] as never });
  const second = await runtime.next("unstarted-root", "delegate1") as { task: object };
  await runtime.admitWorker("unstarted-root", "delegate1", "rejected-call", second.task);
  await runtime.rejectedAdmission("unstarted-root", "rejected-call");
  const resumed = await runtime.resume("unstarted-root", initial.runID, new Map(), new Set(["second"]));
  assert.equal(resumed.dispatched, 2);
  assert.equal(resumed.units[0]!.status, "succeeded");
  assert.equal(resumed.units[1]!.status, "pending");
  assert.match(runtime.operatorTask(resumed).description, /second/);
  await runtime.admitOperator("unstarted-root", "op2", runtime.operatorTask(resumed));
  await runtime.bindOperator("unstarted-root", "delegate2", runtime.operatorTask(resumed).prompt);
  const retry = await runtime.next("unstarted-root", "delegate2") as { task: object };
  assert.equal(retry.task.description, second.task.description);
  assert.notEqual(retry.task.prompt, second.task.prompt, "the resumed reference is rebound to the new generation");
  assert.deepEqual(resumed.units[1]!.task, initial.units[1]!.task, "the registered full unit contract is unchanged");
  await runtime.admitWorker("unstarted-root", "delegate2", "actual-second-call", retry.task);
  assert.equal((await runtime.required("unstarted-root")).dispatched, 3);
}));

test("cold resume relinks legacy registered runs only from the latest same-goal approval", async () => fixture(async root => {
  const ledger = (sessionID: string) => RunFlightLedger.openGoal(join(root, ".sortie-dogs-v010", "run-flight",
    `${createHash("sha256").update(`v010\0${sessionID}`).digest("hex")}.json`));
  const userTurn = (text: string) => ({
    message: { agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    parts: [{ type: "text", text }],
  });
  const singlePlan = plan();
  singlePlan.units = singlePlan.units.slice(0, 1);
  singlePlan.goal_declaration.criteria = singlePlan.goal_declaration.criteria.slice(0, 1);
  singlePlan.acceptance_proof = [["first"], ["first"]];

  const rootSession = "legacy-root";
  const initialHooks = await SortieDogsV010Plugin({ directory: root });
  await initialHooks["chat.message"]!({ sessionID: rootSession, agent: "dog-operator", messageID: "initial-user" },
    userTurn("Implement the registered anonymous order."));
  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const failed = await runtime.prepare(rootSession, singlePlan);
  const first = await runtime.next(rootSession, rootSession) as { task: object };
  await runtime.admitWorker(rootSession, rootSession, "legacy-failed-call", first.task);
  await runtime.rejectedAdmission(rootSession, "legacy-failed-call");
  const failedTask = (await runtime.required(rootSession)).units[0]!.task;
  const now = Date.now();
  const latestParts = [{ type: "text", text: "Resume the exact registered run and controls." }];
  const rootMessages = [{ info: { id: "latest-user", role: "user", agent: "dog-operator", sessionID: rootSession }, parts: latestParts },
    { info: { id: "failed-assistant", role: "assistant", agent: "dog-operator", sessionID: rootSession,
        finish: "stop", time: { created: now, completed: now + 1 } },
      parts: [{ type: "tool", tool: "task", callID: "legacy-failed-call", state: { status: "error", input: failedTask,
        error: "anonymous pre-admission failure" } }] }];
  const coldSingle = await SortieDogsV010Plugin({ directory: root, client: { session: {
    get: async () => ({ data: { id: rootSession, agent: "dog-operator" } }),
    messages: async () => ({ data: rootMessages }), status: async () => ({ data: {} }),
  } } } as never);
  await coldSingle["chat.message"]!({ sessionID: rootSession, agent: "dog-operator", messageID: "latest-user" }, {
    message: { agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-5.6-sol" } }, parts: latestParts,
  });
  const resumedSingle = JSON.parse(await coldSingle.tool!.sortie_v010_resume_operator.execute({
    run_id: failed.runID, acceptance_fingerprint: failed.acceptanceFingerprint,
  }, { sessionID: rootSession }));
  const singleAfter = await new OperatorRuntime(root, V010_RUNTIME_PROFILE).required(rootSession);
  assert.equal(resumedSingle.run_id, failed.runID);
  assert.equal(resumedSingle.task.subagent_type, "dog-worker-v010");
  assert.equal(singleAfter.dispatched, 1);
  assert.equal(singleAfter.units[0]!.status, "pending");
  assert.equal((await (await ledger(rootSession)).readGoal()).state.consumed_units, 0);

  const pendingRoot = "legacy-pending-root";
  const pendingInitial = await SortieDogsV010Plugin({ directory: root });
  await pendingInitial["chat.message"]!({ sessionID: pendingRoot, agent: "dog-operator", messageID: "pending-initial" },
    userTurn("Implement the registered two-unit order."));
  const pendingRuntime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const pending = await pendingRuntime.prepare(pendingRoot, plan());
  await pendingRuntime.admitOperator(pendingRoot, "legacy-operator-call", pendingRuntime.operatorTask(pending));
  await pendingRuntime.bindOperator(pendingRoot, "legacy-delegate", pendingRuntime.operatorTask(pending).prompt);
  await pendingRuntime.operatorReturned(pendingRoot);
  const delegateMessages = [{ info: { id: "delegate-finished", role: "assistant", agent: "dogs-coordinator",
    sessionID: "legacy-delegate", finish: "stop", time: { created: now, completed: now + 1 } }, parts: [{ type: "text", text: "stopped" }] }];
  const pendingParts = [{ type: "text", text: "Resume the exact pending registered run." }];
  const coldPending = await SortieDogsV010Plugin({ directory: root, client: { session: {
    get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id,
      ...(path.id === "legacy-delegate" ? { parentID: pendingRoot, agent: "dogs-coordinator" } : { agent: "dog-operator" }) } }),
    messages: async ({ path }: { path: { id: string } }) => ({ data: path.id === "legacy-delegate" ? delegateMessages : [] }),
    status: async () => ({ data: { "legacy-delegate": { type: "idle" } } }),
  } } } as never);
  await coldPending["chat.message"]!({ sessionID: pendingRoot, agent: "dog-operator", messageID: "pending-latest" }, {
    message: { agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-5.6-sol" } }, parts: pendingParts,
  });
  const resumedPending = JSON.parse(await coldPending.tool!.sortie_v010_resume_operator.execute({
    run_id: pending.runID, acceptance_fingerprint: pending.acceptanceFingerprint,
  }, { sessionID: pendingRoot }));
  const pendingAfter = await new OperatorRuntime(root, V010_RUNTIME_PROFILE).required(pendingRoot);
  assert.equal(resumedPending.run_id, pending.runID);
  assert.equal(resumedPending.task.subagent_type, "dogs-coordinator");
  assert.equal(pendingAfter.dispatched, 0);
  assert.deepEqual(pendingAfter.units.map(unit => unit.status), ["pending", "pending"]);

  const wrongRoot = "legacy-wrong-root";
  const wrongInitial = await SortieDogsV010Plugin({ directory: root });
  await wrongInitial["chat.message"]!({ sessionID: wrongRoot, agent: "dog-operator", messageID: "wrong-initial" },
    userTurn("Implement the original registered order."));
  const wrongRuntime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const wrong = await wrongRuntime.prepare(wrongRoot, singlePlan);
  const wrongTask = await wrongRuntime.next(wrongRoot, wrongRoot) as { task: object };
  await wrongRuntime.admitWorker(wrongRoot, wrongRoot, "wrong-call", wrongTask.task);
  await wrongRuntime.rejectedAdmission(wrongRoot, "wrong-call");
  const wrongLedger = await ledger(wrongRoot), wrongGoal = (await wrongLedger.readGoal()).state;
  await wrongLedger.appendGoal({ kind: "goal.revised", at: new Date(Date.parse(wrong.createdAt) + 1).toISOString(), goal_id: wrongGoal.goal_id!,
    revision: wrongGoal.revision + 1, scope_epoch: wrongGoal.scope_epoch + 1, acceptance_fingerprint: goalFingerprint(["unrelated goal"]),
    origin_user_message_id: wrongGoal.latest_user_message_id!, session_id: wrongRoot, selected_agent: "dog-coordinator", delivery: "repair-first",
    budget: wrongGoal.budget!, acceptance_contract: null });
  const wrongCold = await SortieDogsV010Plugin({ directory: root });
  await wrongCold["chat.message"]!({ sessionID: wrongRoot, agent: "dog-operator", messageID: "wrong-latest" },
    userTurn("Approve the newer unrelated goal only."));
  await assert.rejects(wrongCold.tool!.sortie_v010_resume_operator.execute({ run_id: wrong.runID,
    acceptance_fingerprint: wrong.acceptanceFingerprint }, { sessionID: wrongRoot }), /registered-goal-newer-scope/);
  const wrongAfter = await new OperatorRuntime(root, V010_RUNTIME_PROFILE).required(wrongRoot);
  assert.equal(wrongAfter.runID, wrong.runID);
  assert.equal(wrongAfter.dispatched, 1);
  assert.equal((await wrongLedger.readGoal()).state.acceptance_fingerprint, goalFingerprint(["unrelated goal"]));
}));
