import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SOURCE_ROOT = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SOURCE_ROOT, "../../..");
const RUNTIME_ROOT = join(REPOSITORY_ROOT, "_testenv", "critical-takeover-rpt-evidence");
const STAGE_ROOT = join(RUNTIME_ROOT, "stage");
const PACKAGE_ROOT = join(RUNTIME_ROOT, "package");
const PROJECT_ROOT = join(RUNTIME_ROOT, "project");
const CONTROL_ROOT = join(PROJECT_ROOT, ".opencode");
const OPENCODE_CONFIG_ROOT = join(RUNTIME_ROOT, "opencode-config");
const XDG_CONFIG_HOME = join(RUNTIME_ROOT, "xdg-config");
const XDG_OPENCODE_ROOT = join(XDG_CONFIG_HOME, "opencode");
const RESULT_PATH = join(RUNTIME_ROOT, "result-summary.json");
function resolveOpenCode(environment) {
  return typeof environment.OPENCODE_BIN === "string" && environment.OPENCODE_BIN.trim() !== ""
    ? environment.OPENCODE_BIN.trim() : "opencode";
}
const OPENCODE = resolveOpenCode(process.env);
const CHILD_DEADLINE_MS = 180_000;
const INTENTIONAL_DELAY_MS = 360_000;
const CLI_TIMEOUT_MS = 1_200_000;
const CONFIGURED_TIMING = Object.freeze({
  childDeadlineMs: CHILD_DEADLINE_MS,
  intentionalDelayMs: INTENTIONAL_DELAY_MS,
  cliTimeoutMs: CLI_TIMEOUT_MS,
});
const OUTPUT_LIMIT = 8 * 1024 * 1024;
const STATE_RUN_LIMIT = 4;
const STATE_TASK_LIMIT = 16;
const STATE_DEMOTION_LIMIT = 4;
const STATE_STRING_LIMIT = 128;
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const BOUNDED_ID = /^[a-z0-9_.:@/-]{1,128}$/iu;
const TASK_PHASES = new Set(["prepared", "dispatched", "running", "completed", "failed", "cancelled", "blocked"]);
const TAKEOVER_TRIGGERS = new Set(["live_deadline_exceeded", "repeated_failure", "terminal_quality_rescue"]);

function invariant(condition, gate, detail) {
  if (!condition) {
    const error = new Error(detail);
    error.gate = gate;
    throw error;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTiming(timing) {
  for (const [name, value] of Object.entries(timing)) {
    invariant(Number.isSafeInteger(value) && value > 0, "timing-value", `${name} must be a positive safe integer.`);
  }
  invariant(timing.intentionalDelayMs >= 2 * timing.childDeadlineMs,
    "timing-delay-budget", "intentionalDelayMs must be at least twice childDeadlineMs.");
  invariant(timing.cliTimeoutMs >= 4 * timing.childDeadlineMs + 120_000,
    "timing-cli-budget", "cliTimeoutMs does not cover four child deadlines plus finalization.");
  return timing;
}

function parseMode(argumentsList) {
  if (argumentsList.length === 0) return "live";
  invariant(argumentsList.length === 1 && ["--preflight-only", "--self-test"].includes(argumentsList[0]),
    "arguments", "Expected no arguments, --preflight-only, or --self-test.");
  return argumentsList[0] === "--self-test" ? "self-test" : "preflight-only";
}

function boundedId(value) {
  return typeof value === "string" && value.length <= STATE_STRING_LIMIT && BOUNDED_ID.test(value) ? value : undefined;
}

function summarizeTask(task) {
  if (!isRecord(task) || !isRecord(task.descriptor)) return undefined;
  const phase = typeof task.phase === "string" && TASK_PHASES.has(task.phase) ? task.phase : undefined;
  const attempt = Number.isSafeInteger(task.descriptor.attempt) && task.descriptor.attempt > 0 ? task.descriptor.attempt : undefined;
  const summary = {
    taskId: boundedId(task.descriptor.task_id),
    dispatchId: boundedId(task.descriptor.dispatch_id),
    attempt,
    phase,
    artifactAccepted: typeof task.artifact_accepted === "boolean" ? task.artifact_accepted : undefined,
  };
  return Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== undefined));
}

function summarizeDemotion(demotion) {
  if (!isRecord(demotion)) return undefined;
  const trigger = typeof demotion.trigger === "string" && TAKEOVER_TRIGGERS.has(demotion.trigger) ? demotion.trigger : undefined;
  const summary = {
    unitId: boundedId(demotion.unit_id),
    trigger,
    sourceDispatchId: boundedId(demotion.luna_dispatch_id),
    takeoverDispatchId: boundedId(demotion.sol_dispatch_id),
  };
  return Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== undefined));
}

function summarizeRun(run) {
  if (!isRecord(run) || !isRecord(run.fabric) || !Array.isArray(run.tasks) || !Array.isArray(run.fabric.demotions)) return undefined;
  const fabric = run.fabric;
  const validation = isRecord(fabric.validation) ? {
    status: boundedId(fabric.validation.status),
    candidateSha: SHA.test(fabric.validation.candidate_sha) ? fabric.validation.candidate_sha : undefined,
    fingerprint: SHA256.test(fabric.validation.fingerprint) ? fabric.validation.fingerprint : undefined,
  } : undefined;
  const review = isRecord(fabric.review) ? {
    status: boundedId(fabric.review.status),
    fingerprint: SHA256.test(fabric.review.fingerprint) ? fabric.review.fingerprint : undefined,
  } : undefined;
  return {
    runId: boundedId(run.run_id),
    ownerRoot: boundedId(run.owner_root),
    cancelled: typeof run.cancelled === "boolean" ? run.cancelled : undefined,
    tasks: run.tasks.slice(0, STATE_TASK_LIMIT).map(summarizeTask).filter(Boolean),
    demotions: fabric.demotions.slice(0, STATE_DEMOTION_LIMIT).map(summarizeDemotion).filter(Boolean),
    authoritySha: SHA.test(fabric.authority_sha) ? fabric.authority_sha : undefined,
    candidateSha: SHA.test(fabric.candidate_head) ? fabric.candidate_head : undefined,
    validation: validation === undefined ? undefined : Object.fromEntries(Object.entries(validation).filter(([, value]) => value !== undefined)),
    review: review === undefined ? undefined : Object.fromEntries(Object.entries(review).filter(([, value]) => value !== undefined)),
    promoted: typeof fabric.promoted === "boolean" ? fabric.promoted : undefined,
  };
}

function sameAttemptIdentity(identity, attemptId) {
  return isRecord(identity) && identity.attempt_id === attemptId;
}

function deadlineStopEvidence(child, attemptId) {
  invariant(isRecord(child) && child.schema_version === "0.1" && Array.isArray(child.events),
    "deadline-events-schema", "Child event envelope is invalid.");
  const expectedKinds = ["child.registered", "child.stop-requested", "child.terminal"];
  const transitions = child.events.map((record) => record?.event);
  invariant(transitions.every((event) => isRecord(event) && expectedKinds.includes(event.kind)),
    "deadline-events-unknown", "Child events contain an unknown transition.");
  invariant(transitions.every((event) => sameAttemptIdentity(event.identity, attemptId)),
    "deadline-events-identity", "Child events do not share the expected attempt identity.");
  invariant(transitions.length === expectedKinds.length && transitions.every((event, index) => event.kind === expectedKinds[index]),
    "deadline-events-order", "Child deadline transitions are missing, duplicated, or reordered.");
  const [registered, stopRequested, terminal] = transitions;
  invariant(Number.isSafeInteger(registered.deadline_ms) && registered.deadline_ms > 0,
    "deadline-events-deadline", "Registered child deadline is invalid.");
  const registeredAt = Date.parse(registered.at);
  const stopAt = Date.parse(stopRequested.at);
  const terminalAt = Date.parse(terminal.at);
  invariant(Number.isFinite(registeredAt) && Number.isFinite(stopAt) && Number.isFinite(terminalAt) &&
    registeredAt <= registered.deadline_ms && stopAt >= registered.deadline_ms && terminalAt >= stopAt,
  "deadline-events-time", "Child deadline transition times conflict.");
  invariant(stopRequested.trigger === "deadline_expired", "deadline-events-trigger", "Child stop trigger is not deadline_expired.");
  invariant(terminal.disposition === "cancelled", "deadline-events-terminal", "Child terminal disposition is not cancelled.");
  return { deadlineMs: registered.deadline_ms, stopTrigger: stopRequested.trigger, disposition: terminal.disposition };
}

async function runUnitAValidation(outputValue, callbacks) {
  if (outputValue === null) await callbacks.delay();
  return await callbacks.runTest();
}

function unitAValidationScript() {
  return `import { spawnSync } from "node:child_process";
import { value } from "../output/unit-a.mjs";
if (value === null) await new Promise((resolve) => setTimeout(resolve, ${INTENTIONAL_DELAY_MS}));
const result = spawnSync(process.execPath, ["--test", "test/unit-a.test.mjs"], { cwd: new URL("..", import.meta.url), stdio: "inherit" });
process.exitCode = result.status ?? 1;
`;
}

function summarizeDurableState(state) {
  if (!isRecord(state) || state.version !== 5 || !Array.isArray(state.archived) || !(state.run === null || isRecord(state.run))) return undefined;
  const runs = [];
  if (state.run !== null) runs.push(state.run);
  for (const entry of state.archived) {
    if (runs.length >= STATE_RUN_LIMIT) break;
    if (isRecord(entry) && entry.kind === "run") runs.push(entry.run);
  }
  return { version: 5, runs: runs.map(summarizeRun).filter(Boolean).slice(0, STATE_RUN_LIMIT) };
}

function expectGate(callback, gate) {
  try { callback(); } catch (error) {
    invariant(error?.gate === gate, "self-test-wrong-gate", `Expected ${gate}.`);
    return;
  }
  invariant(false, "self-test-missing-gate", `Expected ${gate} rejection.`);
}

async function runSelfTest() {
  validateTiming(CONFIGURED_TIMING);
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    expectGate(() => validateTiming({ ...CONFIGURED_TIMING, childDeadlineMs: value }), "timing-value");
  }
  expectGate(() => validateTiming({ ...CONFIGURED_TIMING, intentionalDelayMs: CHILD_DEADLINE_MS }), "timing-delay-budget");
  expectGate(() => validateTiming({ ...CONFIGURED_TIMING, cliTimeoutMs: 4 * CHILD_DEADLINE_MS + 119_999 }), "timing-cli-budget");
  expectGate(() => parseMode(["--unknown"]), "arguments");
  invariant(summarizeDurableState(null) === undefined && summarizeDurableState({ version: 5, run: null }) === undefined,
    "self-test-invalid-state", "Invalid durable state was summarized.");
  const secret = "SECRET_PROMPT_DO_NOT_RETAIN";
  const tasks = Array.from({ length: STATE_TASK_LIMIT + 3 }, (_, index) => ({
    descriptor: { task_id: `unit-${index}`, dispatch_id: `dispatch-${index}`, attempt: index + 1, prompt: secret },
    phase: "completed", artifact_accepted: true, log: secret,
  }));
  const demotions = Array.from({ length: STATE_DEMOTION_LIMIT + 2 }, (_, index) => ({
    unit_id: `unit-${index}`, trigger: "live_deadline_exceeded", luna_dispatch_id: `luna-${index}`,
    sol_dispatch_id: `sol-${index}`, reason: secret,
  }));
  const stateSummary = summarizeDurableState({ version: 5, run: { run_id: "run-1", cancelled: false,
    tasks, fabric: { demotions }, raw: secret }, archived: [] });
  const serialized = JSON.stringify(stateSummary);
  invariant(stateSummary.runs.length === 1 && stateSummary.runs[0].tasks.length === STATE_TASK_LIMIT &&
    stateSummary.runs[0].demotions.length === STATE_DEMOTION_LIMIT, "self-test-state-limits", "Durable state limits were not enforced.");
  invariant(!serialized.includes(secret) && !serialized.includes("prompt") && !serialized.includes("log") && !serialized.includes("reason"),
    "self-test-secret-retention", "Unapproved durable state text was retained.");
  const attemptId = "dispatch-a-1";
  const identity = { attempt_id: attemptId };
  const validEvents = { schema_version: "0.1", events: [
    { event: { kind: "child.registered", identity, at: "2026-09-07T00:59:05.258Z", deadline_ms: 1788742925257 } },
    { event: { kind: "child.stop-requested", identity, at: "2026-09-07T01:02:05.257Z", trigger: "deadline_expired" } },
    { event: { kind: "child.terminal", identity, at: "2026-09-07T01:02:06.258Z", disposition: "cancelled" } },
  ] };
  invariant(deadlineStopEvidence(validEvents, attemptId).stopTrigger === "deadline_expired",
    "self-test-events-valid", "Valid deadline events were rejected.");
  const alteredEvents = (mutate) => { const copy = structuredClone(validEvents); mutate(copy.events); return copy; };
  expectGate(() => deadlineStopEvidence(alteredEvents((events) => events.splice(1, 1)), attemptId), "deadline-events-order");
  expectGate(() => deadlineStopEvidence(alteredEvents((events) => events.push(structuredClone(events[1]))), attemptId), "deadline-events-order");
  expectGate(() => deadlineStopEvidence(alteredEvents((events) => events.reverse()), attemptId), "deadline-events-order");
  expectGate(() => deadlineStopEvidence(alteredEvents((events) => { events[1].event.identity = { attempt_id: "other" }; }), attemptId), "deadline-events-identity");
  expectGate(() => deadlineStopEvidence(alteredEvents((events) => { events[1].event.kind = "child.unknown"; }), attemptId), "deadline-events-unknown");
  expectGate(() => deadlineStopEvidence(alteredEvents((events) => { events[1].event.trigger = "explicit_cancellation"; }), attemptId), "deadline-events-trigger");
  expectGate(() => deadlineStopEvidence(alteredEvents((events) => { events[2].event.disposition = "failed"; }), attemptId), "deadline-events-terminal");
  expectGate(() => deadlineStopEvidence(alteredEvents((events) => { events[1].event.at = "2026-09-07T00:59:06.258Z"; }), attemptId), "deadline-events-time");
  const cliSecret = "SECRET_CLI_REASON";
  const cliEvidence = boundedCliEvidence(`${JSON.stringify({ type: "tool", sessionID: "session-1", tool: "sortie_tool",
    result: { status: "failed", code: "typed-code", route: "automatic", reason: cliSecret }, text: "terminal failure" })}\n`, cliSecret);
  const cliSerialized = JSON.stringify(cliEvidence);
  invariant(cliEvidence.sessionId === "session-1" && cliEvidence.typedResults[0]?.status === "failed" &&
    cliEvidence.typedResults[0]?.code === "typed-code" && cliEvidence.typedResults[0]?.route === "automatic" &&
    cliEvidence.toolCounts.sortie_tool === 1 && !cliSerialized.includes(cliSecret) && !cliSerialized.includes("reason"),
  "self-test-cli-evidence", "CLI allowlist evidence was not bounded correctly.");
  const calls = [];
  await runUnitAValidation(null, { delay: async () => calls.push("delay"), runTest: async () => calls.push("test") });
  await runUnitAValidation("alpha", { delay: async () => calls.push("unexpected-delay"), runTest: async () => calls.push("test") });
  await runUnitAValidation("wrong", { delay: async () => calls.push("unexpected-delay"), runTest: async () => { calls.push("invalid-test"); throw Object.assign(new Error("rejected"), { gate: "fixture-test" }); } })
    .then(() => invariant(false, "self-test-invalid-output", "Invalid output passed."), (error) => invariant(error.gate === "fixture-test", "self-test-invalid-output-gate", "Invalid output used wrong gate."));
  invariant(JSON.stringify(calls) === JSON.stringify(["delay", "test", "test", "invalid-test"]),
    "self-test-validation-paths", "Unit-a validation did not run test on every path.");
  const validationScript = unitAValidationScript();
  invariant(validationScript.includes(String(INTENTIONAL_DELAY_MS)) && validationScript.includes("--test") && validationScript.includes("test/unit-a.test.mjs"),
    "self-test-validation-script", "Generated unit-a validation does not contain delay and test paths.");
  return {
    schemaVersion: "critical-takeover-rpt-self-test-v1",
    status: "pass",
    configuredTiming: CONFIGURED_TIMING,
    assertions: [
      "valid finite timing accepted",
      "NaN, Infinity, and negative timing rejected",
      "delay below twice the child deadline rejected",
      "CLI budget below four child deadlines plus 120000ms rejected",
      "invalid argument rejected before mutation",
      "missing and malformed durable state omitted without replacing the original gate",
      `durable state capped at ${STATE_RUN_LIMIT} runs, ${STATE_TASK_LIMIT} tasks, ${STATE_DEMOTION_LIMIT} demotions, and ${STATE_STRING_LIMIT}-character identifiers`,
      "prompt, log, reason, raw state, and secret text excluded",
      "registered, deadline_expired stop-requested, and cancelled terminal accepted only once in order for one attempt identity and valid deadline times",
      "missing, duplicate, reordered, unknown, mismatched identity, wrong trigger, wrong terminal, and premature stop events rejected",
      "CLI failure retains session, typed status/code/route, tool counts, and fingerprints while excluding reason and secret text",
      "unit-a null output delays then tests; implemented output tests without delay; invalid output still invokes and fails its test",
      "generated unit-a validation contains the configured delay and declared unit test",
    ],
  };
}

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function files(root, directory = root) {
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(root, path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

async function treeSha256(root) {
  const hash = createHash("sha256");
  for (const path of await files(root)) {
    hash.update(relative(root, path).split(sep).join("/"));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function execute(executable, args, cwd, environment = {}, timeoutMs = 120_000) {
  return await new Promise((resolvePromise, reject) => {
    const childEnvironment = { ...process.env };
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined || value === null) delete childEnvironment[key];
      else childEnvironment[key] = String(value);
    }
    const child = spawn(executable, args, {
      cwd,
      env: childEnvironment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGTERM"); } catch {}
      setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); } catch {}
      }, 5_000).unref();
    };
    const timer = setTimeout(() => {
      stop();
      if (!settled) reject(Object.assign(new Error(`${basename(executable)} timed out.`), { gate: "process-timeout" }));
      settled = true;
    }, timeoutMs);
    const append = (target, chunk) => {
      const next = target + chunk.toString("utf8");
      if (next.length > OUTPUT_LIMIT) {
        stop();
        throw Object.assign(new Error(`${basename(executable)} exceeded bounded output.`), { gate: "bounded-output" });
      }
      return next;
    };
    child.stdout.on("data", (chunk) => { try { stdout = append(stdout, chunk); } catch (error) { if (!settled) reject(error); settled = true; } });
    child.stderr.on("data", (chunk) => { try { stderr = append(stderr, chunk); } catch (error) { if (!settled) reject(error); settled = true; } });
    child.once("error", (error) => { clearTimeout(timer); if (!settled) reject(error); settled = true; });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolvePromise({ code: code ?? 1, signal, stdout, stderr });
    });
  });
}

async function checked(executable, args, cwd, environment = {}, timeoutMs = 120_000) {
  const result = await execute(executable, args, cwd, environment, timeoutMs);
  invariant(result.code === 0, "setup-command", `${basename(executable)} failed with exit ${result.code}.`);
  return result.stdout.trim();
}

async function write(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

function isolatedOpenCodeEnvironment(extra = {}) {
  return {
    OPENCODE_CONFIG: undefined,
    OPENCODE_CONFIG_CONTENT: undefined,
    OPENCODE_CONFIG_DIR: OPENCODE_CONFIG_ROOT,
    XDG_CONFIG_HOME,
    ...extra,
  };
}

async function createIsolatedConfigRoots() {
  const config = `${JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2)}\n`;
  await write(join(OPENCODE_CONFIG_ROOT, "opencode.json"), config);
  await write(join(XDG_OPENCODE_ROOT, "opencode.json"), config);
  return { opencodeConfigRoot: OPENCODE_CONFIG_ROOT, xdgConfigHome: XDG_CONFIG_HOME };
}

async function createPackage() {
  const repositoryPackage = await json(join(REPOSITORY_ROOT, "package.json"));
  const markerSource = await readFile(join(REPOSITORY_ROOT, "dist", "asset-version.js"), "utf8");
  const marker = markerSource.match(/RUNTIME_ASSET_VERSION\s*=\s*"([^"]+)"/u)?.[1];
  invariant(typeof marker === "string" && marker.length > 0, "stage-marker", "Built runtime asset marker is absent.");
  await mkdir(STAGE_ROOT, { recursive: true });
  await cp(join(REPOSITORY_ROOT, "dist"), join(STAGE_ROOT, "dist"), { recursive: true });
  await cp(join(REPOSITORY_ROOT, "package.json"), join(STAGE_ROOT, "package.json"));
  for (const name of ["README.md", "LICENSE"]) {
    const source = join(REPOSITORY_ROOT, name);
    if (await stat(source).catch(() => undefined)) await cp(source, join(STAGE_ROOT, name));
  }
  const stageIdentity = await treeSha256(STAGE_ROOT);
  await mkdir(PACKAGE_ROOT, { recursive: true });
  await checked("npm", ["pack", "--ignore-scripts", "--pack-destination", PACKAGE_ROOT], STAGE_ROOT);
  const packages = (await readdir(PACKAGE_ROOT)).filter((name) => name.endsWith(".tgz"));
  invariant(packages.length === 1, "package-count", "Staged npm pack did not produce exactly one archive.");
  const packagePath = join(PACKAGE_ROOT, packages[0]);
  const members = (await checked("tar", ["-tzf", packagePath], RUNTIME_ROOT)).split(/\r?\n/u).filter(Boolean);
  invariant(members.includes("package/package.json") && members.includes("package/dist/plugin/opencode.js") &&
    members.includes("package/dist/asset-version.js") && members.every((name) => name.startsWith("package/")),
  "package-members", "Packed archive members do not match the staged runtime package.");
  return { packagePath, packageSha256: await sha256File(packagePath), stageIdentity,
    pluginEntrypointSha256: await sha256File(join(STAGE_ROOT, "dist", "plugin", "opencode.js")),
    packageVersion: repositoryPackage.version, runtimeMarker: marker, memberCount: members.length };
}

function canonicalScope(paths) {
  return [...new Set(paths.map((path) => path.toLowerCase()))].sort();
}

function unit(id, order, dependsOn = []) {
  return {
    unit_id: id,
    acceptance_items: [`${id} writes its exact bounded output`],
    scope_read: canonicalScope([`input/${id}.md`, `test/${id}.test.mjs`, ...(id === "unit-a" ? ["input/unit-a-delay.mjs"] : [])]),
    scope_write: canonicalScope([`output/${id}.mjs`]),
    depends_on: dependsOn,
    validation: { level: "targeted", command: id === "unit-a" ? ["node", "input/unit-a-delay.mjs"] : ["node", "--test", `test/${id}.test.mjs`] },
    shared_path_keys: [],
    exclusive_resources: [],
    scheduler_order: order,
  };
}

async function createProject(packageInfo) {
  await mkdir(PROJECT_ROOT, { recursive: true });
  await write(join(PROJECT_ROOT, ".gitignore"), ".opencode/\n.sortie-dogs/\n");
  await write(join(PROJECT_ROOT, "AGENTS.md"), `# Critical takeover RPT fixture

- Implement only the assigned unit output and run only its declared validation.
- For unit-a attempt 1, before writing output/unit-a.mjs, run the declared validation node input/unit-a-delay.mjs with a finite tool timeout longer than ${INTENTIONAL_DELAY_MS}ms and wait for it to finish.
- For unit-a attempt 2, implement first, then run the same declared validation; it skips delay only because output is no longer null. The injected descriptor attempt is authoritative.
- The declared validation always runs test/unit-a.test.mjs; never bypass the test or treat an invalid output as success.
- Never edit input, test, control, or configuration files.
`);
  const values = { "unit-a": "alpha", "unit-b": "bravo", "unit-c": "charlie" };
  for (const [id, value] of Object.entries(values)) {
    await write(join(PROJECT_ROOT, "input", `${id}.md`), `# ${id}\n\nCreate output/${id}.mjs exporting value = ${JSON.stringify(value)}.\n`);
    await write(join(PROJECT_ROOT, "test", `${id}.test.mjs`), `import assert from "node:assert/strict";
import test from "node:test";
import { value } from "../output/${id}.mjs";
test(${JSON.stringify(id)}, () => assert.equal(value, ${JSON.stringify(value)}));
`);
    await write(join(PROJECT_ROOT, "output", `${id}.mjs`), "export const value = null;\n");
  }
  await write(join(PROJECT_ROOT, "input", "unit-a-delay.mjs"), unitAValidationScript());
  await write(join(PROJECT_ROOT, "validate.mjs"), `import { spawnSync } from "node:child_process";
const result = spawnSync(process.execPath, ["--test", "test/unit-a.test.mjs", "test/unit-b.test.mjs", "test/unit-c.test.mjs"], { stdio: "inherit" });
process.exitCode = result.status ?? 1;
`);
  await checked("git", ["init", "-q", "-b", "critical-rpt-target"], PROJECT_ROOT);
  await checked("git", ["config", "user.name", "Sortie Critical RPT"], PROJECT_ROOT);
  await checked("git", ["config", "user.email", "critical-rpt@example.invalid"], PROJECT_ROOT);
  await checked("git", ["config", "core.autocrlf", "false"], PROJECT_ROOT);
  await checked("git", ["config", "commit.gpgsign", "false"], PROJECT_ROOT);
  await checked("git", ["add", "AGENTS.md", ".gitignore", "input", "output", "test", "validate.mjs"], PROJECT_ROOT);
  await checked("git", ["commit", "-q", "-m", "critical takeover fixture baseline"], PROJECT_ROOT, {
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  });
  const targetSha = await checked("git", ["rev-parse", "HEAD"], PROJECT_ROOT);
  invariant(SHA.test(targetSha), "target-identity", "Fixture target SHA is invalid.");
  await checked("git", ["checkout", "-q", "--detach", targetSha], PROJECT_ROOT);
  const probePath = join(PROJECT_ROOT, ".git", "critical-rpt-worktree-probe");
  await checked("git", ["worktree", "add", "-q", "-b", "critical-rpt-probe", probePath, targetSha], PROJECT_ROOT);
  await checked("git", ["worktree", "lock", "--reason", "critical-rpt-probe", probePath], PROJECT_ROOT);
  await checked("git", ["worktree", "unlock", probePath], PROJECT_ROOT);
  await checked("git", ["worktree", "remove", "--force", probePath], PROJECT_ROOT);
  await checked("git", ["update-ref", "-d", "refs/heads/critical-rpt-probe", targetSha], PROJECT_ROOT);
  const acceptanceItems = ["unit-a writes its exact bounded output", "unit-b writes its exact bounded output",
    "unit-c writes its exact bounded output"];
  const contract = {
    version: "0.8.0",
    provenance: { source: "dog-coordinator",
      acceptance_fingerprint: createHash("sha256").update(JSON.stringify(acceptanceItems)).digest("hex"),
      target_branch: "critical-rpt-target", target_sha: targetSha },
    acceptance_items: acceptanceItems,
    effects: [],
    shared_paths: [],
    units: [unit("unit-a", 0), unit("unit-b", 1, ["unit-a"]), unit("unit-c", 2)],
  };
  await write(join(CONTROL_ROOT, "sortie-dogs-luna-fabric.json"), `${JSON.stringify(contract, null, 2)}\n`);
  await write(join(CONTROL_ROOT, "package.json"), `${JSON.stringify({ private: true, type: "module",
    dependencies: { "@opencode-ai/plugin": "1.18.11", "sortie-dogs": `file:${relative(CONTROL_ROOT, packageInfo.packagePath).split(sep).join("/")}` } }, null, 2)}\n`);
  await checked("npm", ["install", "--force"], CONTROL_ROOT, {}, 180_000);
  await checked("node", [join(CONTROL_ROOT, "node_modules", "sortie-dogs", "dist", "cli", "main.js"), "init", PROJECT_ROOT], PROJECT_ROOT);
  const dependency = (await json(join(CONTROL_ROOT, "package.json"))).dependencies["sortie-dogs"];
  invariant(dependency === `file:${relative(CONTROL_ROOT, packageInfo.packagePath).split(sep).join("/")}`,
    "package-reference", "npm install rewrote the tarball dependency.");
  const installedRoot = join(CONTROL_ROOT, "node_modules", "sortie-dogs");
  invariant(!(await lstat(installedRoot)).isSymbolicLink(), "package-link", "Installed package is a symbolic link.");
  const installedReal = await realpath(installedRoot);
  invariant(!installedReal.startsWith(`${await realpath(REPOSITORY_ROOT)}${sep}`) || installedReal.startsWith(`${await realpath(RUNTIME_ROOT)}${sep}`),
    "package-self-link", "Installed package resolves to repository source.");
  const installedPackage = await json(join(installedRoot, "package.json"));
  const installedEntrypoint = join(installedRoot, "dist", "plugin", "opencode.js");
  const installedEntrypointReal = await realpath(installedEntrypoint);
  const installedEntrypointSha256 = await sha256File(installedEntrypoint);
  const installedMarkerSource = await readFile(join(installedRoot, "dist", "asset-version.js"), "utf8");
  const installedMarker = installedMarkerSource.match(/RUNTIME_ASSET_VERSION\s*=\s*"([^"]+)"/u)?.[1];
  invariant(installedPackage.version === packageInfo.packageVersion && installedMarker === packageInfo.runtimeMarker,
    "installed-identity", "Installed package version or runtime marker differs from the staged package.");
  invariant(installedEntrypointReal.startsWith(`${installedReal}${sep}`) &&
    installedEntrypointSha256 === packageInfo.pluginEntrypointSha256,
  "plugin-entrypoint-identity", "Installed plugin entrypoint is outside the package or differs from the staged entrypoint.");
  const plugin = pathToFileURL(installedEntrypointReal).href;
  await write(join(CONTROL_ROOT, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugin: [plugin],
  }, null, 2)}\n`);
  return { targetSha, installedRoot, installedReal, installedVersion: installedPackage.version, installedMarker,
    plugin, installedEntrypoint: installedEntrypointReal, installedEntrypointSha256 };
}

async function inspectResolvedConfig(project) {
  const result = await execute(OPENCODE, ["debug", "config"], PROJECT_ROOT, isolatedOpenCodeEnvironment());
  const stderrFingerprint = createHash("sha256").update(result.stderr).digest("hex");
  invariant(result.code === 0, "debug-config-exit", `OpenCode debug config exited ${result.code} (${stderrFingerprint}).`);
  let config;
  try { config = JSON.parse(result.stdout); } catch {
    throw Object.assign(new Error("OpenCode debug config did not emit one JSON configuration."), { gate: "debug-config-json" });
  }
  invariant(isRecord(config) && Array.isArray(config.plugin) && config.plugin.length === 1 &&
    config.plugin[0] === project.plugin,
  "plugin-config-isolation", "Resolved plugin configuration is not the exact fixture-local entrypoint.");
  return {
    pluginCount: config.plugin.length,
    plugin: project.plugin,
    entrypoint: project.installedEntrypoint,
    entrypointSha256: project.installedEntrypointSha256,
    packageVersion: project.installedVersion,
    runtimeMarker: project.installedMarker,
    stderrFingerprint,
  };
}

function boundedCliEvidence(stdout, stderr) {
  const eventTypes = new Map();
  const toolCounts = new Map();
  const typedResults = [];
  let sessionId = null;
  let textEvents = 0;
  let terminalTextFingerprint = null;
  const terminalClasses = new Set();
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim().startsWith("{")) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!isRecord(event)) continue;
    if (typeof event.type === "string") eventTypes.set(event.type, (eventTypes.get(event.type) ?? 0) + 1);
    const candidateSession = event.sessionID ?? event.session_id ?? event.sessionId ?? event.part?.sessionID;
    if (typeof candidateSession === "string" && candidateSession.length <= 256) sessionId ??= candidateSession;
    const text = typeof event.text === "string" ? event.text : typeof event.part?.text === "string" ? event.part.text : null;
    if (text !== null) {
      textEvents += 1;
      terminalTextFingerprint = createHash("sha256").update(text).digest("hex");
      if (/tool|capabilit/iu.test(text)) terminalClasses.add("tool-reference");
      if (/error|fail|cannot|unable|unavailable|拒否|失敗|でき/u.test(text)) terminalClasses.add("failure-language");
      if (/complete|done|pass|成功|完了/u.test(text)) terminalClasses.add("completion-language");
    }
    const visit = (value, depth = 0) => {
      if (depth > 5 || !isRecord(value)) return;
      const name = typeof value.tool === "string" ? value.tool : typeof value.toolName === "string" ? value.toolName : null;
      if (name !== null && /^[a-z0-9_.-]{1,128}$/iu.test(name)) toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
      if (typeof value.status === "string" && /^[a-z0-9_.-]{1,128}$/iu.test(value.status)) {
        const bounded = { status: value.status };
        for (const key of ["route", "code"]) {
          if (typeof value[key] === "string" && value[key].length <= 256) bounded[key] = value[key];
        }
        if (!typedResults.some((entry) => JSON.stringify(entry) === JSON.stringify(bounded))) typedResults.push(bounded);
      }
      for (const candidate of Object.values(value)) {
        if (typeof candidate !== "string" || candidate.length > 4096 || !candidate.trim().startsWith("{")) continue;
        try { visit(JSON.parse(candidate), depth + 1); } catch {}
      }
      for (const child of Object.values(value)) {
        if (isRecord(child)) visit(child, depth + 1);
        else if (Array.isArray(child)) for (const item of child) if (isRecord(item)) visit(item, depth + 1);
      }
    };
    visit(event);
  }
  return { sessionId, textEvents, terminalTextFingerprint,
    eventTypes: Object.fromEntries([...eventTypes].sort(([a], [b]) => a.localeCompare(b))),
    toolCounts: Object.fromEntries([...toolCounts].sort(([a], [b]) => a.localeCompare(b))),
    typedResults: typedResults.slice(0, 32),
    terminalClasses: [...terminalClasses].sort(),
    stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
    stderrFingerprint: createHash("sha256").update(stderr).digest("hex") };
}

async function runCli() {
  const contractPath = join(CONTROL_ROOT, "sortie-dogs-luna-fabric.json");
  const validationExecutable = process.execPath;
  const prompt = `This is an already-fixed operational acceptance contract, not a request to plan, scout, inspect source, or create another handoff.
Your first tool call must be sortie_admit_luna_fabric with contract_path ${contractPath}. If admitted, immediately call sortie_prepare_luna_fabric with the same path and execute that returned run to completion.
Use native Task dispatch with every returned ready descriptor and the exact runtime-required prompt shape. Unit-a attempt 1 intentionally blocks in its declared validation until the host deadline; allow automatic live takeover, then dispatch its returned attempt 2 with the runtime-selected role. Keep independent unit-c and accepted artifacts intact. Advance every wave with sortie_advance_luna_fabric_wave. On the final wave pass validation_executable ${JSON.stringify(validationExecutable)}, validation_args_json ["validate.mjs"], and timeout_ms 120000. If final advance returns an unvalidated candidate, call sortie_validate_luna_fabric_candidate exactly once with those same validation arguments. Obtain the required fresh dog-reviewer review only after validation, then call sortie_accept_luna_fabric_candidate for the exact validated and reviewed candidate through one CAS. Do not validate twice, use bash, create a second contract, simulate any result, edit the target directly, skip validation/review, cancel the run, ask a question, or use a diagnostic override. Continue until the accepted terminal result.`;
  const result = await execute(OPENCODE,
    ["run", "--dir", PROJECT_ROOT, "--format", "json", "--print-logs", "--agent", "dog-coordinator", prompt], PROJECT_ROOT,
    isolatedOpenCodeEnvironment({ SORTIE_CHILD_DEADLINE_MS: String(CHILD_DEADLINE_MS) }), CLI_TIMEOUT_MS);
  const evidence = boundedCliEvidence(result.stdout, result.stderr);
  return { exit: result.code, signal: result.signal, ...evidence };
}

async function inspectOutcome(project, cli) {
  const statePath = join(PROJECT_ROOT, ".git", "sortie-dogs", "parallel-dispatch-v5", "state.json");
  invariant(await stat(statePath).catch(() => undefined), "durable-state-absent",
    `Fabric state was not created; bounded CLI evidence: ${JSON.stringify(cli)}.`);
  const state = await json(statePath);
  invariant(state.version === 5 && state.run === null && Array.isArray(state.archived), "durable-state", "Fabric run is not durably archived.");
  const candidates = state.archived.filter((entry) => entry?.kind === "run" && entry?.run?.fabric?.contract?.provenance?.target_sha === project.targetSha);
  const preparationEvidence = state.archived.filter((entry) => entry?.kind === "preparation").map((entry) => ({
    terminalReason: entry.terminal_reason,
    runId: entry.preparation?.run_id,
    createAttempted: entry.preparation?.create_attempted,
    inventory: Array.isArray(entry.inventory) ? entry.inventory.map((item) => ({ taskId: item.task_id,
      phase: item.phase, managedPathPresent: typeof item.managed_path === "string" })) : [],
  }));
  invariant(candidates.length === 1, "run-identity",
    `Expected exactly one archived fixture run; preparation evidence: ${JSON.stringify(preparationEvidence)}; CLI typed results: ${JSON.stringify(cli.typedResults)}.`);
  const archive = candidates[0];
  const run = archive.run;
  const fabric = run.fabric;
  invariant(archive.terminal_reason === "completed" && run.cancelled === false, "terminal-state", "Fabric did not complete successfully.");
  invariant(fabric.contract.units.length === 3 && fabric.demotions.length === 1 && fabric.demotion_transition === null,
    "takeover-count", "Fabric did not retain exactly one completed takeover.");
  const demotion = fabric.demotions[0];
  invariant(demotion.unit_id === "unit-a" && demotion.trigger === "live_deadline_exceeded",
    "takeover-trigger", "Observed takeover is not the expected live deadline trigger.");
  const attempt2 = run.tasks.find((entry) => entry.descriptor?.dispatch_id === demotion.sol_dispatch_id);
  const independent = run.tasks.find((entry) => entry.descriptor?.task_id === "unit-c");
  const dependent = run.tasks.find((entry) => entry.descriptor?.task_id === "unit-b");
  invariant(attempt2?.descriptor?.attempt === 2 && attempt2.descriptor.base_sha === fabric.authority_sha &&
    attempt2.phase === "completed" && attempt2.artifact_accepted === true,
  "attempt-2", "Takeover attempt 2 identity or completion is invalid.");
  invariant(independent?.descriptor?.attempt === 1 && independent.phase === "completed" && independent.artifact_accepted === true &&
    dependent?.descriptor?.attempt === 1 && dependent.phase === "completed" && dependent.artifact_accepted === true,
  "lane-preservation", "Independent or dependent lane evidence is incomplete.");
  invariant(fabric.validation?.status === "pass" && SHA256.test(fabric.validation.fingerprint) &&
    fabric.validation.candidate_sha === fabric.candidate_head, "final-validation", "Final candidate validation is absent or stale.");
  invariant(fabric.review?.status === "pass" && SHA256.test(fabric.review.fingerprint),
    "final-review", "Fresh candidate review did not pass.");
  invariant(fabric.promoted === true && SHA.test(fabric.candidate_head) && fabric.candidate_head !== fabric.authority_sha,
    "candidate-promotion", "Candidate was not promoted.");
  const targetAfter = await checked("git", ["rev-parse", "refs/heads/critical-rpt-target"], PROJECT_ROOT);
  invariant(targetAfter === fabric.candidate_head && fabric.authority_sha === project.targetSha,
    "target-cas", "Target does not identify the accepted candidate from its admitted authority.");
  const outputs = {};
  for (const id of ["unit-a", "unit-b", "unit-c"]) {
    const path = join(PROJECT_ROOT, "output", `${id}.mjs`);
    outputs[id] = { exists: (await stat(path).catch(() => undefined))?.isFile() === true, sha256: await sha256File(path) };
    invariant(outputs[id].exists, "accepted-output", `Accepted output is missing: ${id}.`);
  }
  const childPath = join(PROJECT_ROOT, ".git", "sortie-dogs", "parallel-dispatch-v5", "children", `${demotion.luna_dispatch_id}.json`);
  const child = await json(childPath);
  const source = deadlineStopEvidence(child, demotion.luna_dispatch_id);
  const worktrees = await checked("git", ["worktree", "list", "--porcelain"], PROJECT_ROOT);
  invariant((worktrees.match(/^worktree /gmu) ?? []).length === 1, "worktree-cleanup", "Managed worktrees remain after acceptance.");
  const refs = await checked("git", ["for-each-ref", "--format=%(refname)", "refs/sortie-dogs"], PROJECT_ROOT);
  invariant(refs.trim() === "", "ref-cleanup", "Runtime-owned candidate or source refs remain.");
  const leasePath = join(PROJECT_ROOT, ".git", "sortie-dogs", "scope-leases", "scope-leases.json");
  const leases = await json(leasePath).catch(() => ({ leases: [] }));
  invariant(Array.isArray(leases.leases) && leases.leases.length === 0, "lease-cleanup", "Child scope leases remain.");
  invariant(cli.sessionId === null || typeof run.owner_root === "string", "run-owner", "CLI session and durable owner identity are absent.");
  return {
    runId: run.run_id,
    ownerRoot: run.owner_root,
    authoritySha: fabric.authority_sha,
    candidateSha: fabric.candidate_head,
    targetAfter,
    takeover: { unitId: demotion.unit_id, trigger: demotion.trigger, sourceDispatchId: demotion.luna_dispatch_id,
      attempt2DispatchId: demotion.sol_dispatch_id, attempt2: attempt2.descriptor.attempt, sourceStopTrigger: source.stopTrigger,
      sourceDisposition: source.disposition, sourceDeadlineMs: source.deadlineMs },
    lanes: { independent: { unitId: "unit-c", attempt: independent.descriptor.attempt, phase: independent.phase },
      dependent: { unitId: "unit-b", attempt: dependent.descriptor.attempt, phase: dependent.phase } },
    validation: { status: fabric.validation.status, candidateSha: fabric.validation.candidate_sha,
      fingerprint: fabric.validation.fingerprint },
    review: { status: fabric.review.status, fingerprint: fabric.review.fingerprint },
    promotion: { promoted: fabric.promoted, terminalReason: archive.terminal_reason, casCount: 1 },
    cleanup: { worktreeCount: 1, runtimeRefCount: 0, activeLeaseCount: 0 },
    outputs,
  };
}

async function save(summary) {
  await writeFile(RESULT_PATH, `${JSON.stringify(summary, null, 2)}\n`);
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  validateTiming(CONFIGURED_TIMING);
  if (mode === "self-test") {
    process.stdout.write(`${JSON.stringify(await runSelfTest())}\n`);
    return;
  }
  const startedAt = new Date().toISOString();
  const evidence = {};
  await rm(RUNTIME_ROOT, { recursive: true, force: true });
  await mkdir(RUNTIME_ROOT, { recursive: true });
  try {
    const preflightOnly = mode === "preflight-only";
    const configRoots = await createIsolatedConfigRoots();
    evidence.configRoots = configRoots;
    const packageInfo = await createPackage();
    evidence.package = packageInfo;
    invariant(SHA256.test(packageInfo.packageSha256) && SHA256.test(packageInfo.stageIdentity),
      "package-digest", "Package provenance digest is invalid.");
    const project = await createProject(packageInfo);
    evidence.project = project;
    const preflight = await inspectResolvedConfig(project);
    evidence.preflight = preflight;
    if (preflightOnly) {
      const summary = {
        schemaVersion: "critical-takeover-rpt-v1",
         status: "pass",
         mode: "preflight-only",
         startedAt,
         finishedAt: new Date().toISOString(),
         configuredTiming: CONFIGURED_TIMING,
         pluginIdentity: preflight,
        generatedPaths: { runtimeRoot: RUNTIME_ROOT, stageRoot: STAGE_ROOT, packageRoot: PACKAGE_ROOT,
          projectRoot: PROJECT_ROOT, opencodeConfigRoot: OPENCODE_CONFIG_ROOT, xdgConfigHome: XDG_CONFIG_HOME,
          result: RESULT_PATH },
        cumulativeAcceptanceGate: { status: "not-run", reason: "live-run-not-executed-by-preflight-only" },
      };
      await save(summary);
      process.stdout.write(`${JSON.stringify(summary)}\n`);
      return;
    }
    const cli = await runCli();
    evidence.cli = cli;
    invariant(cli.exit === 0, "cli-exit", `OpenCode CLI exited ${cli.exit} (${cli.stderrFingerprint}).`);
    invariant(cli.textEvents > 0 && cli.terminalTextFingerprint !== null, "cli-terminal", "OpenCode CLI emitted no terminal text event.");
    const outcome = await inspectOutcome(project, cli);
    const summary = {
      schemaVersion: "critical-takeover-rpt-v1",
       status: "pass",
       startedAt,
       finishedAt: new Date().toISOString(),
       configuredTiming: CONFIGURED_TIMING,
      package: { stageIdentity: packageInfo.stageIdentity, archivePath: packageInfo.packagePath,
        archiveSha256: packageInfo.packageSha256, memberCount: packageInfo.memberCount, version: packageInfo.packageVersion,
        runtimeMarker: packageInfo.runtimeMarker, installedRoot: project.installedRoot,
        installedRealPath: project.installedReal, installedVersion: project.installedVersion,
        installedRuntimeMarker: project.installedMarker, pluginEntrypoint: project.installedEntrypoint,
        pluginEntrypointSha256: project.installedEntrypointSha256 },
      preflight,
      cli: { executable: OPENCODE, invocation: "opencode run --dir <fixture> --format json --print-logs --agent dog-coordinator <bounded-prompt>",
        ...cli },
      outcome,
      generatedPaths: { runtimeRoot: RUNTIME_ROOT, stageRoot: STAGE_ROOT, packageRoot: PACKAGE_ROOT,
        projectRoot: PROJECT_ROOT, opencodeConfigRoot: OPENCODE_CONFIG_ROOT, xdgConfigHome: XDG_CONFIG_HOME,
        result: RESULT_PATH },
    };
    await save(summary);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    const statePath = join(PROJECT_ROOT, ".git", "sortie-dogs", "parallel-dispatch-v5", "state.json");
    const durableState = await json(statePath).then(summarizeDurableState).catch(() => undefined);
    const summary = { schemaVersion: "critical-takeover-rpt-v1", status: "fail", startedAt,
      finishedAt: new Date().toISOString(), gate: boundedId(error?.gate) ?? "unexpected",
      configuredTiming: CONFIGURED_TIMING,
      ...(evidence.cli === undefined ? {} : { cli: evidence.cli }),
      ...(durableState === undefined ? {} : { durableState }),
       generatedPaths: { runtimeRoot: RUNTIME_ROOT, result: RESULT_PATH } };
    await save(summary).catch(() => undefined);
    process.stderr.write(`${JSON.stringify(summary)}\n`);
    process.exitCode = 1;
  }
}

await main();
