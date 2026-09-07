import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RunFlightLedger } from "../../../dist/core/run-flight-ledger.js";
import { EvidenceCapsuleStore } from "../../../dist/core/evidence-capsule.js";
import { ScopeLeaseRegistry } from "../../../dist/core/scope-lease-registry.js";
import { acceptanceContinuityFingerprint } from "../../../dist/core/acceptance-continuity.js";
import { CHILD_TERMINAL_EVIDENCE_FIELDS } from "../../../dist/core/child-terminal-reconciliation.js";
import { validateHandoffSchema } from "../../../dist/core/validate-schema.js";
import { validateManifest } from "../../../dist/core/validate-manifest.js";

const repo = resolve(import.meta.dirname, "../../..");
const root = join(repo, "_testenv", "terminal-rescue-rpt-v14");
const project = join(root, "project"), control = join(project, ".opencode");
const env = { ...process.env, OPENCODE_CONFIG: undefined, OPENCODE_CONFIG_CONTENT: undefined,
  OPENCODE_CONFIG_DIR: join(root, "opencode-config"), XDG_CONFIG_HOME: join(root, "xdg-config"),
  OPENCODE_SERVER_PASSWORD: undefined, OPENCODE_SERVER_USERNAME: undefined };
function resolveOpenCode(environment) {
  return typeof environment.OPENCODE_BIN === "string" && environment.OPENCODE_BIN.trim() !== ""
    ? environment.OPENCODE_BIN.trim() : "opencode";
}
const OPENCODE = resolveOpenCode(process.env);
const digest = (text) => createHash("sha256").update(text).digest("hex");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const write = async (path, text) => { await mkdir(resolve(path, ".."), { recursive: true }); await writeFile(path, text); };
async function command(exe, args, cwd = project) {
  return new Promise((resolve) => execFile(exe, args, { cwd, env, timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
    (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout: String(stdout), stderrFingerprint: digest(String(stderr)) })));
}
async function checked(exe, args, cwd = project) {
  const result = await command(exe, args, cwd);
  assert.equal(result.code, 0, JSON.stringify({ exe, code: result.code, stderrFingerprint: result.stderrFingerprint }));
  return result.stdout.trim();
}
let server;
let url;
const summary = { schema: "terminal-rescue-rpt-v1", status: "running", fixtureFaultInjection: "harness replaces Sol output after each prompt, before canonical validation", sessions: [], stages: [] };
async function api(path, method = "GET", body) {
  const response = await fetch(`${url}${path}${path.includes("?") ? "&" : "?"}directory=${encodeURIComponent(project)}`,
    { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(180000) });
  assert.ok(response.ok, `HTTP ${response.status} ${path}`);
  return response.json();
}
const source = ["AGENTS.md", "package.json", "validate.mjs", "output/result.mjs"];
const criteria = ["output/result.mjs exports value equal to ready"];
async function handoff(id) {
  const manifest = join(project, ".sortie-dogs", "contracts", `operation-manifest.${id}.json`);
  const path = join(project, ".sortie-dogs", "contracts", `handoff.${id}.json`);
  await write(manifest, JSON.stringify({ version: "0.1.0", task_id: id, read: source, write: ["output/result.mjs"], validation: ["node validate.mjs"] }));
  await write(path, JSON.stringify({ version: "0.1.0", profile: "full", id, created_at: new Date().toISOString(),
    task: { title: id, objective: criteria[0] }, scope: { paths: source }, sources: source.map((path) => ({ path, rev: "fixture" })), state: { done: [], next: [criteria[0]], blocked: [] }, risks: [],
    verification: [{ check: "node validate.mjs", status: "not_run", exit_code: null, summary: "fixture validation" }],
    ext: { "sortie-dogs/write-gate": { project_root: project, operation_manifest: `.sortie-dogs/contracts/operation-manifest.${id}.json` },
      "sortie-dogs/acceptance-continuity": { schema_version: "0.1", authority: "dispatch", task_id: id, criteria,
        fingerprint: acceptanceContinuityFingerprint(criteria), parent_fingerprint: "none" } } }));
  const validation = validateHandoffSchema(await json(path));
  assert.ok(validation.ok, JSON.stringify(validation.diagnostics));
  const diagnostics = validateManifest(validation.value, await json(manifest), undefined, false, { requirePassedValidation: false });
  assert.ok(!diagnostics.some((entry) => entry.severity === "error"), JSON.stringify(diagnostics));
  return ["/sortie", `task_id: ${id}`, "role: implementation", `project_root: ${project}`, `handoff_path: ${path}`,
    `operation_manifest: ${manifest}`, `source_manifest: ${JSON.stringify(source)}`, "acceptance:", `  - ${criteria[0]}`,
    "validation: node validate.mjs", "Read the handoff, bind the write gate, implement the one output, validate, release the gate and return. No Task, commit, control edits or promotion."].join("\n");
}
try {
  assert.equal(process.platform, "linux");
  assert.equal(await stat(root).catch(() => null), null, "Preserve prior fixtures; do not repeat this run");
  await mkdir(control, { recursive: true });
  const version = (await json(join(repo, "package.json"))).version;
  await checked("npm", ["pack", "--ignore-scripts", "--pack-destination", root], repo);
  const tgz = `sortie-dogs-${version}.tgz`;
  summary.packageVersion = version;
  summary.packageSha256 = digest(await readFile(join(root, tgz)));
  await write(join(control, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: { "sortie-dogs": `file:../../${tgz}` } }));
  await checked("npm", ["install", "--force"], control);
  assert.equal((await json(join(control, "package.json"))).dependencies["sortie-dogs"], `file:../../${tgz}`);
  const installed = join(control, "node_modules/sortie-dogs");
  assert.equal((await json(join(control, "package-lock.json"))).packages["node_modules/sortie-dogs"].link, undefined);
  await checked(process.execPath, [join(installed, "dist/cli/main.js"), "init", project]);
  const plugin = pathToFileURL(join(installed, "dist/plugin/opencode.js")).href;
  await write(join(control, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: [plugin] }));
  for (const path of [join(env.OPENCODE_CONFIG_DIR, "opencode.json"), join(env.XDG_CONFIG_HOME, "opencode/opencode.json")]) {
    await write(path, JSON.stringify({ $schema: "https://opencode.ai/config.json" }));
  }
  summary.runtimeMarker = (await readFile(join(control, "sortie-dogs.version"), "utf8")).trim();
  await write(join(project, ".gitignore"), ".opencode/\n.sortie-dogs/\n");
  await write(join(project, "AGENTS.md"), "# Rescue fixture\nImplement only the assigned output. Do not change validation or controls.\n");
  await write(join(project, "package.json"), '{"private":true,"type":"module"}\n');
  await write(join(project, "output/result.mjs"), "export const value = null;\n");
  await write(join(project, "validate.mjs"), 'import assert from "node:assert/strict"; import {value} from "./output/result.mjs"; assert.equal(value,"ready");\n');
  await checked("git", ["init", "-q", "-b", "rescue-rpt-target"]);
  await checked("git", ["add", "AGENTS.md", ".gitignore", "package.json", "validate.mjs", "output/result.mjs"]);
  await checked("git", ["-c", "user.name=Sortie Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "rescue fixture baseline"]);
  const base = await checked("git", ["rev-parse", "HEAD"]);
  await checked("git", ["checkout", "--detach", "-q", base]);
  summary.base = base;
  const seedPrompts = [await handoff("sol-1"), await handoff("sol-2")];
  server = spawn(OPENCODE, ["serve", "--hostname", "127.0.0.1", "--port", "0"],
    { cwd: project, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  server.stderr.on("data", () => {});
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server-start-timeout")), 30000);
    server.stdout.on("data", (chunk) => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/u);
      if (match) { url = match[0]; clearTimeout(timer); resolve(); } });
    server.once("error", reject);
  });
  summary.stages.push("host-ready");
  const rootSession = await api("/session", "POST", { title: "Terminal rescue RPT owner" });
  await api(`/session/${rootSession.id}/message`, "POST", { agent: "dog-coordinator", noReply: true,
    parts: [{ type: "text", text: "Register this isolated fixture coordinator. No implementation or model response is requested yet." }] });
  const ledgerPath = ".sortie-dogs/rescue-flight.json";
  const ledger = await RunFlightLedger.open(join(project, ledgerPath), { store: new EvidenceCapsuleStore(join(project, ".sortie-dogs/evidence-capsules")),
    declared_capsule_ids: [], authorized_source_paths: source });
  const at = () => new Date().toISOString();
  await ledger.append({ kind: "run.planned", at: at(), run_id: "rescue-rpt", initial_candidate_id: base,
    budget_limits: { recovery_actions: 3, probe_iterations: 0, model_attempts: 3 }, resource_budget_limits: { time_ms: 480000, cost_usd: 10 } });
  await ledger.append({ kind: "route.selected", at: at(), route_id: "serial", candidate_id: base, role: "implementation", model: "openai/gpt-5.6-sol", variant: "medium", reason: "implementation" });
  await ledger.append({ kind: "wave.opened", at: at(), wave_id: "wave", wave_index: 1, candidate_id: base });
  await ledger.append({ kind: "unit.opened", at: at(), unit_id: "result", wave_id: "wave", candidate_id: base, references: { capsule_ids: [], artifact_ids: [] } });
  const registry = new ScopeLeaseRegistry(join(project, ".git/sortie-dogs/scope-leases"));
  for (let index = 0; index < 2; index++) {
    const id = `sol-${index + 1}`, prior = index === 0 ? null : "sol-1";
    const seedOwner = await api("/session", "POST", { title: `${id}-owner` });
    const workerPrompt = seedPrompts[index];
    const started = Date.now();
    await api(`/session/${seedOwner.id}/message`, "POST", { agent: "dog-coordinator", parts: [{ type: "text", text:
      `Isolated fixture seeding only. Execute exactly one native Task with these arguments: ${JSON.stringify({ description: id, subagent_type: "dog-worker", prompt: workerPrompt })}. The contract is already fixed. Do not plan, scout, consult, review, commit, promote, or create another worker. Only for a typed handoff-uninspected process defect, follow its exact-read and same-child-resume remedy once with the same full contract; this is not an implementation retry. Then return the result and stop; the harness owns the subsequent validation-fault test.` }] });
    const children = await api(`/session/${seedOwner.id}/children`);
    let session, result;
    for (const child of children) {
      const messages = await api(`/session/${child.id}/message`);
      const last = messages.filter((message) => message.info.role === "assistant" && message.info.agent === "dog-worker").at(-1);
      if (last) { assert.equal(session, undefined, "more than one implementation child"); session = child; result = last; }
    }
    assert.ok(session && result, "native Sol Task did not create an implementation child");
    const identity = { run_id: "rescue-rpt", unit_id: "result", attempt_id: id, predecessor_attempt_id: prior, candidate_id: base,
      route_id: "serial", child_id: session.id, call_id: id };
    await ledger.append({ kind: "attempt.started", at: at(), attempt_id: id, predecessor_attempt_id: prior, unit_id: "result", candidate_id: base,
      route_id: "serial", role: "implementation", selected_model: "openai/gpt-5.6-sol", selected_variant: "medium", child_id: session.id, call_id: id,
      budget_charge: { kind: index === 0 ? "implementation" : "normal_remediation", recovery_actions: index, probe_iterations: 0, model_attempts: 1 },
      resource_budget_request: { time_ms: 120000, cost_usd: 2 } });
    assert.equal(result.info.modelID, "gpt-5.6-sol");
    assert.equal(result.info.error, undefined);
    assert.equal(await registry.hasConflictingLease({ read: [], write: ["output/result.mjs"] }), false);
    await checked(process.execPath, ["validate.mjs"]);
    // Controlled implementation fault, not a claim that this simple task defeats Sol.
    await write(join(project, "output/result.mjs"), "export const value = null;\n");
    const failed = await command(process.execPath, ["validate.mjs"]);
    assert.equal(failed.code, 1);
    await ledger.append({ kind: "attempt.finished", at: at(), attempt_id: id, observed_model: `${result.info.providerID}/${result.info.modelID}`,
      observed_variant: result.info.variant ?? null, disposition: index === 0 ? "continue" : "failed", failure: { category: "implementation", code: "fixture-injected-assertion" },
      observation: { stage: "recovery", duration_ms: Date.now() - started,
        usage: { input_tokens: null, cache_read_tokens: null, output_tokens: null, provenance: "unknown" },
        estimated_cost: { usd: result.info.cost, provenance: "provider_estimate" } }, references: { capsule_ids: [], artifact_ids: [] } });
    await ledger.append({ kind: "child.registered", at: at(), identity, deadline_ms: Date.now() });
    await ledger.append({ kind: "child.terminal", at: at(), identity, disposition: "failed",
      evidence: Object.fromEntries(CHILD_TERMINAL_EVIDENCE_FIELDS.map((name) => [name, "satisfied"])) });
    summary.sessions.push({ id: session.id, observedModel: `${result.info.providerID}/${result.info.modelID}`, validationExit: failed.code });
    summary.stages.push(id);
  }
  await ledger.append({ kind: "validation.recorded", at: at(), validation_id: "canonical-failure", unit_id: "result",
    command_fingerprint: `sha256:${digest("node validate.mjs")}`, result: "failed", artifact_id: null });
  await write(join(control, "sortie-dogs-terminal-rescue.json"), JSON.stringify({ ledger_path: ledgerPath, scope_read: source, capsule_ids: [],
    validation: { executable: "node", args: ["validate.mjs"] }, request: { unit_id: "result", failed_attempt_id: "sol-2", explicit_override: false,
      accepted_base: { candidate_id: base, contract_id: "rescue-rpt-contract", scope: ["output/result.mjs"], acceptance: criteria, validation: ["node validate.mjs"] },
      budget_request: { counters: { recovery_actions: 1, probe_iterations: 0, model_attempts: 1 }, resources: { time_ms: 120000, cost_usd: 2 } } } }));
  await api(`/session/${rootSession.id}/message`, "POST", { agent: "dog-coordinator", parts: [{ type: "text", text:
    "This is a fixed isolated operational test, not planning or implementation. Your first and only tool call is sortie_execute_terminal_rescue with no arguments. The exact request and measured predecessor ledger already exist. Return the tool's typed result, then stop. Do not dispatch Task, inspect files, retry, compact or promote anything." }] });
  const state = await ledger.read();
  const rescue = state.records.map(({ event }) => event).find((event) => event.kind === "attempt.started" && event.role === "rescue");
  assert.ok(rescue, "rescue was not reserved");
  const finished = state.records.map(({ event }) => event).find((event) => event.kind === "attempt.finished" && event.attempt_id === rescue.attempt_id);
  assert.equal(finished?.disposition, "succeeded");
  assert.equal(finished.observed_model, "openai/gpt-6-astra");
  summary.rescue = { attempt: rescue.attempt_id, selected: rescue.selected_model, observed: finished.observed_model };
  const receipt = await json(join(project, ".sortie-dogs/rescue-artifacts", `${rescue.attempt_id}.json`));
  const candidate = receipt.artifact.commit_sha;
  const validationRoot = join(root, "final-validation");
  await mkdir(validationRoot);
  await checked("git", ["archive", "--format=tar", `--output=${join(root, "candidate.tar")}`, candidate]);
  await checked("tar", ["-xf", join(root, "candidate.tar"), "-C", validationRoot]);
  await checked(process.execPath, ["validate.mjs"], validationRoot);
  const diff = await checked("git", ["diff", base, candidate, "--", "output/result.mjs"]);
  const reviewSession = await api("/session", "POST", { parentID: rootSession.id, title: "rescue candidate review" });
  const review = await api(`/session/${reviewSession.id}/message`, "POST", { agent: "dog-reviewer", parts: [{ type: "text", text:
    `Read-only independent review of this immutable candidate. No tools. Acceptance: ${criteria[0]}. Actual final node validate.mjs passed at candidate ${candidate}. Diff:\n${diff}\nReturn only PASS if correct, otherwise FAIL plus the defect.` }] });
  assert.equal(review.parts.filter((part) => part.type === "text").map((part) => part.text).join("").trim(), "PASS");
  assert.equal(await checked("git", ["rev-parse", "refs/heads/rescue-rpt-target"]), base);
  await checked("git", ["update-ref", "refs/heads/rescue-rpt-target", candidate, base]);
  await checked("git", ["update-ref", "-d", receipt.candidate_ref, candidate]);
  assert.equal(await checked("git", ["rev-parse", "refs/heads/rescue-rpt-target"]), candidate);
  assert.equal((await checked("git", ["worktree", "list", "--porcelain"])).split("\n").filter((line) => line.startsWith("worktree ")).length, 1);
  await rm(validationRoot, { recursive: true });
  await rm(join(root, "candidate.tar"));
  Object.assign(summary, { status: "pass", candidate, review: "pass", promoted: true, cleanup: "complete" });
} catch (error) {
  summary.status = "fail";
  summary.reason = String(error?.message ?? error).slice(0, 600);
  process.exitCode = 1;
} finally {
  if (server?.pid) { try { process.kill(-server.pid, "SIGTERM"); } catch {} }
  await write(join(root, "result-summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
}
