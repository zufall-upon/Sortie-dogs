import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { admitLunaFabric } from "../../../dist/core/luna-fabric-contract.js";
import { requestJson, sanitizedHttpFailure } from "./http-json.mjs";

const REPO = resolve(import.meta.dirname, "../../..");
function resolveOpenCode(environment) {
  return typeof environment.OPENCODE_BIN === "string" && environment.OPENCODE_BIN.trim() !== ""
    ? environment.OPENCODE_BIN.trim() : "opencode";
}
const OPENCODE = resolveOpenCode(process.env);
const DEADLINE_MS = 180_000;
const HOLD_MS = 420_000;
const REQUEST_TIMEOUT_MS = 1_200_000;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SOL_CRITICAL_BRANCH = /\/w\d+-sol-critical$/u;
const CONTRACT_DIRECTORY = join(".sortie-dogs", "contracts");
function parallelControlPaths(descriptor) {
  return {
    handoff_path: join(descriptor.managed_path, CONTRACT_DIRECTORY, `handoff.${descriptor.task_id}.json`),
    operation_manifest: join(descriptor.managed_path, CONTRACT_DIRECTORY, `${descriptor.task_id}.operation-manifest.json`),
  };
}
const frozen = Object.freeze({
  schemaVersion: "evidence-runtime-rpt-self-test-v1", status: "pass", laneCount: 5,
  deadlineMs: DEADLINE_MS, intentionalHoldMs: HOLD_MS, expectedTrigger: "live_deadline_exceeded",
  controlPaths: [".sortie-dogs/contracts/handoff.critical.json", ".sortie-dogs/contracts/critical.operation-manifest.json"],
  branchIdentity: {
    lunaCritical: SOL_CRITICAL_BRANCH.test("sortie-dogs/luna-fabric/0123456789abcdef/w1-l1-critical"),
    solCritical: SOL_CRITICAL_BRANCH.test("sortie-dogs/luna-fabric/0123456789abcdef/w1-sol-critical"),
  },
  cliResolution: { default: resolveOpenCode({}), override: resolveOpenCode({ OPENCODE_BIN: "/fixture/opencode" }) },
  expectedTakeovers: 1, phases: ["prepare", "waves-through-review", "pre-cas-check", "single-cas", "replay-and-cleanup"],
});
if (process.argv[2] === "--self-test") {
  assert.equal(process.argv.length, 3);
  assert.ok(HOLD_MS >= DEADLINE_MS * 2);
  assert.deepEqual(frozen.branchIdentity, { lunaCritical: false, solCritical: true });
  assert.deepEqual(frozen.cliResolution, { default: "opencode", override: "/fixture/opencode" });
  const managedPath = join("fixture", "managed");
  const controls = parallelControlPaths({ managed_path: managedPath, task_id: "critical" });
  assert.deepEqual(Object.values(controls).map((path) => relative(managedPath, path).replaceAll("\\", "/")), frozen.controlPaths);
  process.stdout.write(`${JSON.stringify(frozen)}\n`);
  process.exit(0);
}
assert.equal(process.argv.length, 2, "expected no arguments or --self-test");
assert.equal(process.platform, "linux", "live evidence requires WSL");

const runLabel = `${new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
const ROOT = join(REPO, "_testenv", `evidence-runtime-critical-${runLabel}`);
const PROJECT = join(ROOT, "project");
const CONTROL = join(PROJECT, ".opencode");
const RESULT = join(ROOT, "result-summary.json");
const env = { ...process.env, OPENCODE_CONFIG: undefined, OPENCODE_CONFIG_CONTENT: undefined,
  OPENCODE_CONFIG_DIR: join(ROOT, "opencode-config"), XDG_CONFIG_HOME: join(ROOT, "xdg-config"),
  OPENCODE_SERVER_PASSWORD: undefined, OPENCODE_SERVER_USERNAME: undefined,
  SORTIE_CHILD_DEADLINE_MS: String(DEADLINE_MS) };
const digest = (value) => createHash("sha256").update(value).digest("hex");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const write = async (path, text) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); };
async function command(executable, args, cwd = PROJECT, timeout = 180_000) {
  return await new Promise((resolvePromise) => execFile(executable, args, { cwd, env, timeout, maxBuffer: 8 * 1024 * 1024 },
    (error, stdout, stderr) => resolvePromise({ code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
      stdout: String(stdout), stderrFingerprint: digest(String(stderr)) })));
}
async function checked(executable, args, cwd = PROJECT, timeout = 180_000) {
  const result = await command(executable, args, cwd, timeout);
  assert.equal(result.code, 0, JSON.stringify({ executable: basename(executable), args, code: result.code,
    stderrFingerprint: result.stderrFingerprint }));
  return result.stdout.trim();
}
function canonical(paths) { return [...new Set(paths.map((path) => path.toLowerCase()))].sort(); }
function unit(id, order, dependsOn = []) {
  return { unit_id: id, acceptance_items: [`${id} exports its declared value`],
    scope_read: canonical([`input/${id}.md`, `test/${id}.test.mjs`, ...(id === "critical" ? ["input/critical-validation.mjs"] : [])]),
    scope_write: canonical([`output/${id}.mjs`]), depends_on: dependsOn,
    validation: { level: "targeted", command: id === "critical" ? ["node", "input/critical-validation.mjs"] : ["node", "--test", `test/${id}.test.mjs`] },
    shared_path_keys: [], exclusive_resources: [], scheduler_order: order };
}
async function setupProject() {
  await mkdir(CONTROL, { recursive: true });
  await write(join(PROJECT, ".gitignore"), ".opencode/\n.sortie-dogs/\n");
  await write(join(PROJECT, "AGENTS.md"), `# Evidence runtime fixture\n\n- Change only the assigned output. Keep acceptance, scope, and validation unchanged.\n- critical uses one unchanged validation. Its declared route-isolated first-attempt hold proves host deadline cancellation; the Sol takeover runs the same validation without that injected Luna hold.\n- Never bypass tests, alter controls, delegate, commit, or promote.\n`);
  await write(join(PROJECT, "package.json"), '{"private":true,"type":"module"}\n');
  const values = { seed: "seed", auxiliary: "auxiliary", critical: "critical", sibling: "sibling", final: "final" };
  for (const [id, value] of Object.entries(values)) {
    await write(join(PROJECT, "input", `${id}.md`), `Create output/${id}.mjs exporting value = ${JSON.stringify(value)}.\n`);
    await write(join(PROJECT, "output", `${id}.mjs`), "export const value = null;\n");
    await write(join(PROJECT, "test", `${id}.test.mjs`), `import assert from "node:assert/strict"; import test from "node:test"; import {value} from "../output/${id}.mjs"; test(${JSON.stringify(id)},()=>assert.equal(value,${JSON.stringify(value)}));\n`);
  }
  await write(join(PROJECT, "input", "critical-validation.mjs"), `import {spawnSync} from "node:child_process"; const root=new URL("..",import.meta.url); const identity=spawnSync("git",["symbolic-ref","--quiet","--short","HEAD"],{cwd:root,encoding:"utf8"}); if(identity.status!==0) throw new Error("critical validation requires a managed branch identity"); const branch=identity.stdout.trim().replaceAll("\\\\","/"); const sol=${SOL_CRITICAL_BRANCH}.test(branch); if(!sol) await new Promise(r=>setTimeout(r,${HOLD_MS})); const r=spawnSync(process.execPath,["--test","test/critical.test.mjs"],{cwd:root,stdio:"inherit"}); process.exitCode=r.status??1;\n`);
  await write(join(PROJECT, "validate.mjs"), `import {spawnSync} from "node:child_process"; const r=spawnSync(process.execPath,["--test",${Object.keys(values).map((id) => JSON.stringify(`test/${id}.test.mjs`)).join(",")}],{stdio:"inherit"}); process.exitCode=r.status??1;\n`);
  await checked("git", ["init", "-q", "-b", "evidence-runtime-target"]);
  await checked("git", ["add", "AGENTS.md", ".gitignore", "package.json", "input", "output", "test", "validate.mjs"]);
  await checked("git", ["-c", "user.name=Sortie Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "evidence runtime baseline"]);
  const base = await checked("git", ["rev-parse", "HEAD"]);
  await checked("git", ["checkout", "--detach", "-q", base]);
  const acceptance = Object.keys(values).map((id) => `${id} exports its declared value`);
  // Four independent first-wave lanes keep ordinary variance non-critical while the declared hold
  // remains active. The join becomes blocked by critical only after every unrelated lane succeeds.
  const units = [unit("seed", 0), unit("auxiliary", 1), unit("critical", 2), unit("sibling", 3),
    unit("final", 4, ["seed", "auxiliary", "critical", "sibling"])];
  const contract = { version: "0.8.0", provenance: { source: "dog-coordinator",
    acceptance_fingerprint: digest(JSON.stringify(acceptance)), target_branch: "evidence-runtime-target", target_sha: base },
    acceptance_items: acceptance, effects: [], shared_paths: [], units };
  const admission = admitLunaFabric(contract);
  assert.equal(admission.route, "luna-fabric", JSON.stringify(admission));
  assert.equal(admission.width, 4);
  assert.equal(admission.depth, 2);
  await write(join(CONTROL, "sortie-dogs-luna-fabric.json"), `${JSON.stringify(contract, null, 2)}\n`);
  return { base, contractFingerprint: admission.contract_fingerprint };
}
async function installPackage() {
  const packageValue = await json(join(REPO, "package.json"));
  await checked("npm", ["pack", "--ignore-scripts", "--pack-destination", ROOT], REPO);
  const tgz = `sortie-dogs-${packageValue.version}.tgz`;
  const archive = join(ROOT, tgz);
  await write(join(CONTROL, "package.json"), JSON.stringify({ private: true, type: "module",
    dependencies: { "sortie-dogs": `file:../../${tgz}` } }));
  await checked("npm", ["install", "--force"], CONTROL);
  const dependency = (await json(join(CONTROL, "package.json"))).dependencies["sortie-dogs"];
  assert.equal(dependency, `file:../../${tgz}`);
  const installed = join(CONTROL, "node_modules", "sortie-dogs");
  assert.equal((await lstat(installed)).isSymbolicLink(), false);
  assert.equal((await json(join(CONTROL, "package-lock.json"))).packages["node_modules/sortie-dogs"].link, undefined);
  assert.ok((await realpath(installed)).startsWith(`${await realpath(ROOT)}${sep}`));
  await checked(process.execPath, [join(installed, "dist", "cli", "main.js"), "init", PROJECT]);
  const marker = (await readFile(join(CONTROL, "sortie-dogs.version"), "utf8")).trim();
  const plugin = pathToFileURL(join(installed, "dist", "plugin", "opencode.js")).href;
  await write(join(CONTROL, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: [plugin] }));
  for (const path of [join(env.OPENCODE_CONFIG_DIR, "opencode.json"), join(env.XDG_CONFIG_HOME, "opencode", "opencode.json")]) {
    await write(path, JSON.stringify({ $schema: "https://opencode.ai/config.json" }));
  }
  const routing = await import(pathToFileURL(join(installed, "dist", "plugin", "model-routing.js")).href);
  return { version: packageValue.version, archiveSha256: digest(await readFile(archive)), marker,
    selected: { luna: routing.LUNA_FABRIC_WORKER_MODEL, sol: routing.DEDICATED_WORKER_MODEL } };
}

let server;
let url;
let root;
let currentPhase = "startup";
async function api(path, method = "GET", body, timeout = REQUEST_TIMEOUT_MS) {
  return requestJson(url, `${path}${path.includes("?") ? "&" : "?"}directory=${encodeURIComponent(PROJECT)}`,
    { method, body, timeoutMs: timeout });
}
async function startServer() {
  server = spawn(OPENCODE, ["serve", "--hostname", "127.0.0.1", "--port", "0"],
    { cwd: PROJECT, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  server.stderr.on("data", () => {});
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("server-start-timeout")), 30_000);
    server.stdout.on("data", (chunk) => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/u);
      if (match) { url = match[0]; clearTimeout(timer); resolvePromise(); } });
    server.once("error", reject);
  });
}
async function stopServer() {
  if (!server?.pid) return;
  const closed = new Promise((resolvePromise) => server.once("close", resolvePromise));
  try { process.kill(-server.pid, "SIGTERM"); } catch {}
  await Promise.race([closed, new Promise((resolvePromise) => setTimeout(resolvePromise, 10_000))]);
  if (server.exitCode === null && server.signalCode === null) { try { process.kill(-server.pid, "SIGKILL"); } catch {} }
}
async function observedModels(rootID) {
  const children = await api(`/session/${rootID}/children`);
  const result = [];
  for (const child of children) {
    const messages = await api(`/session/${child.id}/message`);
    const assistant = messages.filter((message) => message.info?.role === "assistant" && typeof message.info?.modelID === "string").at(-1);
    if (assistant) result.push({ agent: assistant.info.agent, model: `${assistant.info.providerID}/${assistant.info.modelID}`,
      error: assistant.info.error === undefined ? null : "present" });
  }
  return result;
}
async function durable() { return json(join(PROJECT, ".git", "sortie-dogs", "parallel-dispatch-v5", "state.json")); }
const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
async function waitFor(label, predicate, timeout = 360_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate().catch(() => undefined);
    if (value !== undefined && value !== false) return value;
    await sleep(1_000);
  }
  throw new Error(`${label}-timeout`);
}
async function childTerminal(dispatchID) {
  const ledger = await json(join(PROJECT, ".git", "sortie-dogs", "parallel-dispatch-v5", "children", `${dispatchID}.json`));
  return ledger.events.some((record) => record.event.kind === "child.terminal");
}
function oneRun(state) {
  const runs = [state.run, ...state.archived.filter((entry) => entry.kind === "run").map((entry) => entry.run)].filter(Boolean);
  assert.equal(runs.length, 1);
  return runs[0];
}
function verifyFunctional(run, base, requirePromoted, sourceDescriptor) {
  const fabric = run.fabric;
  assert.equal(fabric.demotions.length, 1);
  const demotion = fabric.demotions[0];
  assert.equal(demotion.unit_id, "critical");
  assert.equal(demotion.trigger, "live_deadline_exceeded");
  assert.equal(sourceDescriptor.dispatch_id, demotion.luna_dispatch_id);
  assert.equal(run.tasks.some((task) => task.descriptor.dispatch_id === demotion.luna_dispatch_id), false,
    "cancelled source descriptor must be replaced rather than retained as an acceptable task");
  const sol = run.tasks.find((task) => task.descriptor.dispatch_id === demotion.sol_dispatch_id);
  assert.equal(sourceDescriptor.attempt, 1);
  assert.equal(sol.descriptor.attempt, 2);
  assert.equal(sol.descriptor.predecessor_attempt_id, undefined);
  assert.equal(sol.descriptor.base_sha, sourceDescriptor.base_sha);
  assert.ok(sol.descriptor.base_sha === fabric.authority_sha || fabric.wave_heads.includes(sol.descriptor.base_sha),
    "takeover base must be an accepted candidate in the same fabric");
  assert.deepEqual(sol.descriptor.scope_read, sourceDescriptor.scope_read);
  assert.deepEqual(sol.descriptor.scope_write, sourceDescriptor.scope_write);
  for (const id of ["seed", "auxiliary", "critical", "sibling", "final"]) {
    const accepted = run.tasks.filter((task) => task.descriptor.task_id === id && task.artifact_accepted);
    assert.equal(accepted.length, 1, `${id} must have one accepted artifact`);
    assert.equal(accepted[0].phase, "completed");
  }
  assert.equal(new Set(run.tasks.filter((task) => task.artifact_accepted).map((task) => task.artifact.commit_sha)).size, 5);
  assert.equal(fabric.validation.status, "pass");
  assert.match(fabric.validation.fingerprint, SHA256);
  assert.equal(fabric.promoted, requirePromoted);
  return { demotion, source: { descriptor: sourceDescriptor }, sol, fabric };
}

const summary = { schemaVersion: "evidence-runtime-rpt-v1", status: "running", runtimeRoot: ROOT,
  configured: frozen, processesStopped: false };
try {
  assert.equal(await stat(ROOT).catch(() => null), null);
  await mkdir(ROOT, { recursive: true });
  const project = await setupProject();
  const packageIdentity = await installPackage();
  assert.match(packageIdentity.archiveSha256, SHA256);
  summary.package = packageIdentity;
  summary.project = project;
  currentPhase = "server-start";
  await startServer();
  currentPhase = "session-create";
  root = await api("/session", "POST", { title: "Evidence runtime critical path owner" });
  const validationExecutable = process.execPath;
  const contractPath = join(CONTROL, "sortie-dogs-luna-fabric.json");
  currentPhase = "prepare";
  await api(`/session/${root.id}/message`, "POST", { agent: "dog-coordinator", parts: [{ type: "text", text:
    `Preparation phase only. Call sortie_admit_luna_fabric with contract_path ${contractPath}, then sortie_prepare_luna_fabric with the same path. Return the typed prepared result and stop. Do not dispatch Task, advance, validate, review, accept, inspect source, retry, plan, or ask a question.` }] });
  const installedRoot = join(CONTROL, "node_modules", "sortie-dogs", "dist");
  const coordinatorModule = await import(pathToFileURL(join(installedRoot, "core", "worktree-parallel-dispatch.js")).href);
  const schemaModule = await import(pathToFileURL(join(installedRoot, "core", "validate-schema.js")).href);
  const manifestModule = await import(pathToFileURL(join(installedRoot, "core", "validate-manifest.js")).href);
  const hostCoordinator = await coordinatorModule.ParallelDispatchCoordinator.open({ repositoryRoot: PROJECT });
  const prepared = await hostCoordinator.snapshot(root.id);
  assert.ok(prepared && !prepared.archived && prepared.ready.length === 4, "prepared four-lane wave is absent");
  const firstAttemptDispatchIDs = prepared.ready.map((descriptor) => descriptor.dispatch_id);
  const criticalSourceDescriptor = prepared.ready.find((descriptor) => descriptor.task_id === "critical");
  assert.ok(criticalSourceDescriptor, "critical source descriptor is absent");
  for (const descriptor of prepared.ready) {
    const controls = parallelControlPaths(descriptor);
    const handoff = schemaModule.validateHandoffSchema(await json(controls.handoff_path));
    assert.ok(handoff.ok, `invalid generated handoff for ${descriptor.task_id}`);
    const manifest = await json(controls.operation_manifest);
    const diagnostics = manifestModule.validateManifest(handoff.value, manifest, undefined, false, { requirePassedValidation: false });
    assert.ok(!diagnostics.some((entry) => entry.severity === "error"), `invalid generated manifest for ${descriptor.task_id}`);
    assert.equal(manifest.task_id, descriptor.task_id);
    assert.deepEqual(manifest.read, descriptor.scope_read);
    assert.deepEqual(manifest.write, descriptor.scope_write);
    const relativeManifest = relative(descriptor.managed_path, controls.operation_manifest).replaceAll("\\", "/");
    assert.equal(handoff.value.ext["sortie-dogs/write-gate"].operation_manifest, relativeManifest);
    for (const criterion of prepared.fabric.unit_acceptance[descriptor.task_id]) {
      assert.ok(handoff.value.ext["sortie-dogs/acceptance-continuity"].criteria.includes(criterion));
    }
  }
  currentPhase = "wave-one-deadline-takeover";
  await api(`/session/${root.id}/message`, "POST", { agent: "dog-coordinator", parts: [{ type: "text", text:
    `Execute the initial four-lane wave of already-prepared run ${prepared.run_id}. Call sortie_parallel_dispatch_status once and dispatch every returned ready descriptor with its exact native Task contract. In critical attempt 1's generated native Task instructions, require its one canonical validation to be owned exclusively by sortie_create_parallel_commit_artifact with validation_executable ${JSON.stringify(validationExecutable)}, validation_args_json ["input/critical-validation.mjs"], timeout_ms 600000. Explicitly forbid a preliminary bash or other direct validation run, but do not bypass artifact validation or alter its acceptance. STOP after all four native Task calls are accepted; the host lifecycle remains live after your response and will enforce critical attempt 1's declared deadline. Do not poll, wait, advance, dispatch a takeover or final, manually demote, use terminal rescue, validate, review, accept, retry, cancel, change acceptance, or ask a question.` }] });
  const initialRun = await waitFor("initial-native-registrations", async () => {
    const run = oneRun(await durable());
    const registered = run.tasks.filter((task) => firstAttemptDispatchIDs.includes(task.descriptor.dispatch_id) &&
      task.child_session_id !== null);
    return registered.length === 4 ? run : undefined;
  }, 30_000);
  const initialTasks = initialRun.tasks.filter((task) => firstAttemptDispatchIDs.includes(task.descriptor.dispatch_id));
  assert.equal(initialTasks.length, 4, "initial native Task calls were not all registered");
  assert.deepEqual(initialTasks.map((task) => task.descriptor.task_id).sort(), ["auxiliary", "critical", "seed", "sibling"]);
  assert.ok(initialTasks.every((task) => task.descriptor.attempt === 1 && task.child_session_id !== null),
    "initial native Task attempts lack child registrations");
  assert.equal(new Set(initialTasks.map((task) => task.child_session_id)).size, 4,
    "initial native Task child registrations are not unique");
  const directChildren = new Set((await api(`/session/${root.id}/children`)).map((child) => child.id));
  assert.ok(initialTasks.every((task) => directChildren.has(task.child_session_id)),
    "initial native Task child lineage does not belong to the owner session");
  currentPhase = "automatic-deadline-reconciliation";
  await waitFor("automatic-deadline-takeover", async () => {
    const run = oneRun(await durable());
    const demotion = run.fabric.demotions.find((entry) => entry.unit_id === "critical");
    const sol = run.tasks.find((task) => task.descriptor.dispatch_id === demotion?.sol_dispatch_id);
    return demotion?.trigger === "live_deadline_exceeded" && sol?.descriptor.attempt === 2 &&
      ["pending", "reserved"].includes(sol.phase) ? run : undefined;
  });
  assert.ok((await Promise.all(firstAttemptDispatchIDs.map(childTerminal))).every(Boolean),
    "first-attempt child lifecycle did not reach terminal state");
  const sourceLifecycle = await json(join(PROJECT, ".git", "sortie-dogs", "parallel-dispatch-v5", "children",
    `${oneRun(await durable()).fabric.demotions[0].luna_dispatch_id}.json`));
  const sourceLifecycleEvents = sourceLifecycle.events.map((record) => record.event);
  assert.deepEqual(sourceLifecycleEvents.map((event) => event.kind),
    ["child.registered", "child.stop-requested", "child.terminal"]);
  assert.equal(sourceLifecycleEvents[1].trigger, "deadline_expired");
  assert.ok(Date.parse(sourceLifecycleEvents[1].at) >= sourceLifecycleEvents[0].deadline_ms);
  assert.equal(sourceLifecycleEvents[2].disposition, "cancelled",
    "deadline-expired critical source completed instead of being cancelled");
  currentPhase = "sol-takeover-dispatch";
  await api(`/session/${root.id}/message`, "POST", { agent: "dog-coordinator", parts: [{ type: "text", text:
    `Resume fixed run ${prepared.run_id}. Its automatic host lifecycle has already produced exactly one live_deadline_exceeded critical attempt 2. Call sortie_parallel_dispatch_status once, verify the sole ready descriptor is critical attempt 2 with the selected Sol role, and dispatch that exact native Task contract. In its generated native Task instructions, require the one canonical validation to be owned exclusively by sortie_create_parallel_commit_artifact with validation_executable ${JSON.stringify(validationExecutable)}, validation_args_json ["input/critical-validation.mjs"], timeout_ms 600000. Explicitly forbid a preliminary bash or other direct validation run, but do not bypass artifact validation or alter acceptance. STOP immediately after its Task call is accepted. Never manually demote, use terminal rescue, advance, dispatch final, validate, review, accept, retry, cancel, edit, or ask a question.` }] });
  const solDispatchID = oneRun(await durable()).fabric.demotions[0]?.sol_dispatch_id;
  assert.ok(solDispatchID, "Sol takeover descriptor is absent");
  await waitFor("sol-takeover-artifact", async () => {
    const task = oneRun(await durable()).tasks.find((entry) => entry.descriptor.dispatch_id === solDispatchID);
    return task?.phase === "completed" && task.artifact_accepted ? task : undefined;
  });
  currentPhase = "wave-one-advance";
  await api(`/session/${root.id}/message`, "POST", { agent: "dog-coordinator", parts: [{ type: "text", text:
    `Resume fixed run ${prepared.run_id}. All initial wave child lifecycles, including the sole selected Sol takeover, are terminal. Call sortie_parallel_dispatch_status once, then sortie_advance_luna_fabric_wave once without final validation arguments. STOP when it returns final as the sole ready unit. Do not dispatch final, validate, review, accept, retry, cancel, edit, or ask a question.` }] });
  const waveState = await durable();
  const waveRun = oneRun(waveState);
  assert.equal(waveRun.fabric.demotions.length, 1);
  assert.equal(waveRun.fabric.demotions[0].unit_id, "critical");
  assert.equal(waveRun.fabric.demotions[0].trigger, "live_deadline_exceeded");
  assert.equal(waveRun.tasks.find((task) => task.descriptor.task_id === "final")?.phase, "reserved");
  currentPhase = "final-validation-review";
  await api(`/session/${root.id}/message`, "POST", { agent: "dog-coordinator", parts: [{ type: "text", text:
    `Finish already-prepared run ${prepared.run_id} through review, but not CAS. Dispatch the sole ready final descriptor with its exact native Task contract. Advance once with validation_executable ${JSON.stringify(validationExecutable)}, validation_args_json ["validate.mjs"], timeout_ms 120000; do not run that canonical validation again. Obtain exactly one fresh dog-reviewer SourceReview PASS. Its review prompt must index all five output/*.mjs manifest entries, give a per-entry changedLogicSummary, and map every "<unit> exports its declared value" acceptance item to its changed path and passing test; include the immutable candidate head and canonical validation result/fingerprint. A vague short diff is insufficient. STOP after reporting candidate_head and the SHA-256 review fingerprint. Do not call sortie_accept_luna_fabric_candidate, dispatch any other Task, retry, cancel, edit, or ask a question.` }] });
  const beforeState = await durable();
  assert.ok(beforeState.run, "run archived before the authorized CAS boundary");
  const beforeRun = oneRun(beforeState);
  const before = verifyFunctional(beforeRun, project.base, false, criticalSourceDescriptor);
  assert.equal(before.fabric.review.status, "pending");
  assert.equal(await checked("git", ["rev-parse", "refs/heads/evidence-runtime-target"]), project.base);
  assert.equal(before.demotion.luna_dispatch_id, sourceLifecycleEvents[0].identity.attempt_id);
  currentPhase = "model-evidence";
  const models = await observedModels(root.id);
  assert.ok(models.some((entry) => entry.agent === "dog-worker" && entry.model === packageIdentity.selected.sol && entry.error === null),
    `Sol model mismatch: ${JSON.stringify(models)}`);
  assert.ok(models.some((entry) => entry.agent === "dog-luna-worker" && entry.model === packageIdentity.selected.luna),
    `Luna model missing: ${JSON.stringify(models)}`);
  const phaseTwo = `Resume the same fixed run ${beforeRun.run_id}. Use the exact candidate and fresh PASS review from your immediately preceding phase. Call sortie_accept_luna_fabric_candidate exactly once with that run_id, candidate_head, review=pass and its SHA-256 review_fingerprint. Do not validate, review, dispatch, edit, or use any other tool. Return the typed terminal result.`;
  currentPhase = "single-cas";
  await api(`/session/${root.id}/message`, "POST", { agent: "dog-coordinator", parts: [{ type: "text", text: phaseTwo }] });
  const afterState = await durable();
  assert.equal(afterState.run, null);
  const afterRun = oneRun(afterState);
  const after = verifyFunctional(afterRun, project.base, true, criticalSourceDescriptor);
  assert.equal(after.fabric.review.status, "pass");
  assert.match(after.fabric.review.fingerprint, SHA256);
  assert.equal(await checked("git", ["rev-parse", "refs/heads/evidence-runtime-target"]), after.fabric.candidate_head);
  assert.match(after.fabric.candidate_head, SHA);
  currentPhase = "replay-and-cleanup";
  const replayCoordinator = await coordinatorModule.ParallelDispatchCoordinator.open({ repositoryRoot: PROJECT });
  const replay = await replayCoordinator.acceptFabricCandidate(afterRun.owner_root, afterRun.run_id, after.fabric.candidate_head,
    "pass", after.fabric.review.fingerprint);
  assert.equal(replay.terminal_reason, "completed");
  await assert.rejects(replayCoordinator.acceptFabricCandidate(afterRun.owner_root, afterRun.run_id, after.fabric.candidate_head,
    "pass", "0".repeat(64)), (error) => error?.code === "outcome-conflict");
  assert.equal((await checked("git", ["worktree", "list", "--porcelain"])).split("\n").filter((line) => line.startsWith("worktree ")).length, 1);
  assert.equal((await checked("git", ["for-each-ref", "--format=%(refname)", "refs/sortie-dogs"])).trim(), "");
  const leases = await json(join(PROJECT, ".git", "sortie-dogs", "scope-leases", "scope-leases.json")).catch(() => ({ leases: [] }));
  assert.equal(leases.leases.length, 0);
  Object.assign(summary, { status: "pass", models, takeover: { unit: "critical", trigger: after.demotion.trigger,
    sourceDeadlineMs: sourceLifecycleEvents[0].deadline_ms, stopAt: sourceLifecycleEvents[1].at,
    sourceDisposition: sourceLifecycleEvents[2].disposition,
    sourceBase: after.source.descriptor.base_sha, solBase: after.sol.descriptor.base_sha },
    candidate: { authority: after.fabric.authority_sha, head: after.fabric.candidate_head,
      validation: after.fabric.validation.status, review: after.fabric.review.status, promoted: true, casCount: 1 },
    lanes: { initialConcurrent: 4, totalUnits: 5 },
    artifacts: { acceptedUnits: 5, acceptedByUnit: ["seed", "auxiliary", "critical", "sibling", "final"],
      duplicateReplay: "idempotent", conflictingReplay: "rejected" },
    cleanup: { worktrees: 1, runtimeRefs: 0, leases: 0 } });
} catch (error) {
  summary.status = "fail";
  if (root?.id) summary.models = await observedModels(root.id).catch(() => []);
  summary.failure = { name: error?.name ?? "Error", message: String(error?.message ?? error).slice(0, 800),
    currentPhase, transport: sanitizedHttpFailure(error), serverBeforeCleanup: {
      exitCode: server?.exitCode ?? null, signal: server?.signalCode ?? null } };
  process.exitCode = 1;
} finally {
  await stopServer();
  summary.processesStopped = true;
  await write(RESULT, `${JSON.stringify(summary, null, 2)}\n`).catch(() => undefined);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}
