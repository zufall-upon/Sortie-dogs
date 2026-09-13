#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const DEEPSWE_COMMIT = "435ee89ec2f2e2289f33b0da4f992f0b7b7266b9";
const ANKO_BASE = "3f269a72ff69398b1250c584171f32d12c0d8085";
const TASK_ID = "datacurve/anko-typed-variable-bindings";
const ARMS = ["bare", "sortie"];
// Agent and harness control state is never part of a graded coding candidate.
const CONTROL_PATHS = [".git/", ".opencode/", ".sortie-dogs/"];
const BENCHMARK_GIT_IDENTITY = { "user.name": "zufall-upon", "user.email": "zufall@s151.xrea.com" };
const OFFICIAL_FILES = [
  "instruction.md", "task.toml", "tests/test.patch", "tests/config.json", "tests/grader.py", "tests/test.sh",
];
const OFFICIAL_REWARD_FIELDS = [
  "f2p_total", "f2p_passed", "p2p_total", "p2p_passed", "f2p", "p2p", "partial", "apply_failed",
];
const TOOL_NAMES = ["git", "node", "go", "goyacc", "go_ctrf_json_reporter", "python", "npm", "bash", "script"];
const STATE_FILE = "frontierharness-state.json";
const REPORT_FILE = "sanitized-summary.json";
const OUTPUT_LIMIT = 64 * 1024 * 1024;
const DEFAULT_WALL_SECONDS = 5400;
const DEFAULT_STARTUP_SECONDS = 5400;
const DEFAULT_ACTIVITY_SECONDS = 5400;
const DEFAULT_PROGRESS_SECONDS = 5400;
const HEARTBEAT_SECONDS = 120;

class HarnessFailure extends Error {
  constructor(gate, message) {
    super(message);
    this.name = "HarnessFailure";
    this.gate = gate;
  }
}

function invariant(condition, gate, message) {
  if (!condition) throw new HarnessFailure(gate, message);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function string(value) {
  return typeof value === "string" && value.length > 0;
}

function safeWslPath(value) {
  return typeof value === "string" && /^\/[A-Za-z0-9._/-]+$/u.test(value) && !value.includes("//");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path) {
  return sha256Bytes(await readFile(path));
}

function portableRelative(parent, child) {
  return relative(resolve(parent), resolve(child)).split(sep).join("/");
}

export function isInside(parent, child) {
  const value = relative(resolve(parent), resolve(child));
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function requireSafeRelative(value, gate) {
  invariant(string(value) && !isAbsolute(value) && !value.split(/[\\/]/u).includes(".."), gate,
    "A manifest-relative path is invalid.");
}

function validateCommand(value, gate) {
  invariant(record(value) && string(value.executable) && ["host", "wsl"].includes(value.environment) &&
    Array.isArray(value.args) && value.args.every((item) => typeof item === "string") &&
    Array.isArray(value.probe_args) && value.probe_args.every((item) => typeof item === "string") &&
    Number.isInteger(value.probe_exit), gate, "A command specification is invalid.");
}

function exactKeys(value, keys, gate) {
  invariant(record(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"), gate,
    "Manifest object keys differ from the schema.");
}

export function validateManifest(value, manifestPath, repositoryRoot = process.cwd()) {
  invariant(record(value), "manifest-shape", "Manifest must be one JSON object.");
  exactKeys(value, ["schema_version", "methodology_comparable", "leaderboard", "task_id", "pins", "paths",
    "official_sha256", "package", "source", "opencode", "tools", "verifier", "protocol",
    ...(value.expected_operation === undefined ? [] : ["expected_operation"]),
    ...(value.qualification_only === undefined ? [] : ["qualification_only"])], "manifest-keys");
  invariant(value.qualification_only === undefined || value.qualification_only === true,
    "qualification-mode", "qualification_only may only explicitly enable treatment qualification.");
  if (value.expected_operation !== undefined) {
    exactKeys(value.expected_operation, ARMS, "expected-operation-arms");
    for (const arm of ARMS) {
      const expected = value.expected_operation[arm];
      exactKeys(expected, ["min_patch_bytes", "min_implementation_children", "terminal_outcome"], "expected-operation-fields");
      invariant(Number.isSafeInteger(expected.min_patch_bytes) && expected.min_patch_bytes >= 1 &&
        Number.isSafeInteger(expected.min_implementation_children) && expected.min_implementation_children >= 0 &&
        (expected.terminal_outcome === null || expected.terminal_outcome === "DONE"),
      "expected-operation-values", "Expected operation thresholds are invalid.");
    }
  }
  invariant(value.schema_version === 1 && value.methodology_comparable === false && value.leaderboard === false,
    "protocol-identity", "Manifest must identify an unofficial, non-leaderboard, methodology-incomparable run.");
  invariant(value.task_id === TASK_ID, "task-identity", "Manifest task id differs from the approved task.");
  invariant(record(value.pins) && value.pins.deepswe_commit === DEEPSWE_COMMIT && value.pins.anko_base === ANKO_BASE,
    "pin-mismatch", "Manifest commit pins differ from the approved pins.");
  exactKeys(value.pins, ["deepswe_commit", "anko_base"], "pin-keys");
  invariant(record(value.paths) && string(value.paths.runtime_root) && string(value.paths.official_root) &&
    string(value.paths.package_tgz), "manifest-paths", "Manifest paths are incomplete.");
  exactKeys(value.paths, ["runtime_root", "official_root", "package_tgz"], "path-keys");
  const manifestDirectory = dirname(resolve(manifestPath));
  const runtimeRoot = resolve(manifestDirectory, value.paths.runtime_root);
  const approvedRuntimeParent = resolve(repositoryRoot, "_testenv");
  invariant(runtimeRoot !== approvedRuntimeParent && isInside(approvedRuntimeParent, runtimeRoot), "runtime-root",
    "runtime_root must be a child of repository _testenv.");
  const officialRoot = resolve(manifestDirectory, value.paths.official_root);
  const packagePath = resolve(manifestDirectory, value.paths.package_tgz);
  invariant(record(value.official_sha256) && Object.keys(value.official_sha256).length === OFFICIAL_FILES.length &&
    OFFICIAL_FILES.every((path) => /^[a-f0-9]{64}$/u.test(value.official_sha256[path] ?? "")),
  "official-hashes", "All six official SHA-256 values are required.");
  exactKeys(value.official_sha256, OFFICIAL_FILES, "official-hash-keys");
  invariant(record(value.package) && /^[a-f0-9]{64}$/u.test(value.package.sha256 ?? "") &&
    string(value.package.version) && string(value.package.runtime_marker) &&
    Array.isArray(value.package.required_assets) && value.package.required_assets.length > 0,
  "package-identity", "Package hash, version, marker, and assets are required.");
  exactKeys(value.package, ["sha256", "version", "runtime_marker", "required_assets"], "package-keys");
  for (const asset of value.package.required_assets) requireSafeRelative(asset, "package-assets");
  invariant(record(value.source) && string(value.source.repository) && value.source.base === ANKO_BASE,
    "source", "Source repository and approved base are required.");
  exactKeys(value.source, ["repository", "base"], "source-keys");
  invariant(record(value.opencode) && string(value.opencode.wsl_executable) && string(value.opencode.executable) &&
    string(value.opencode.version) && string(value.opencode.auth_file),
  "opencode", "Pinned WSL OpenCode and auth presence path are required.");
  const legacyModel = value.opencode.arm_models === undefined;
  exactKeys(value.opencode, legacyModel
    ? ["wsl_executable", "executable", "version", "auth_file", "model", "variant"]
    : ["wsl_executable", "executable", "version", "auth_file", "arm_models"], "opencode-keys");
  if (legacyModel) invariant(value.opencode.model === "openai/gpt-5.6-sol" && value.opencode.variant === "high",
    "opencode", "Legacy runs require the pinned Sol/high model.");
  else {
    exactKeys(value.opencode.arm_models, ARMS, "opencode-arm-models");
    for (const arm of ARMS) exactKeys(value.opencode.arm_models[arm], ["model", "variant"], `opencode-${arm}-model`);
    invariant(value.opencode.arm_models.bare.model === "openai/gpt-5.6-sol" &&
      value.opencode.arm_models.bare.variant === "high" &&
      value.opencode.arm_models.sortie.model === "openai/gpt-5.6-terra" &&
      value.opencode.arm_models.sortie.variant === "high", "opencode-arm-models",
    "Product comparison requires Bare Sol/high and Sortie Terra/high.");
  }
  invariant(record(value.tools), "tools", "Tool commands are required.");
  exactKeys(value.tools, TOOL_NAMES, "tool-keys");
  for (const name of TOOL_NAMES) {
    exactKeys(value.tools[name], ["environment", "executable", "args", "probe_args", "probe_exit"],
      `tool-${name}-keys`);
    validateCommand(value.tools[name], `tool-${name}`);
  }
  invariant(value.tools.git.environment === "host" && TOOL_NAMES.filter((name) => name !== "git")
    .every((name) => value.tools[name].environment === "wsl"), "tool-environments",
  "Git must run on the host and all package/verifier tools must run in WSL.");
  invariant(value.tools.git.args.length === 0, "git-command",
    "Git invariant args must be empty so model.patch uses the exact approved command arguments.");
  invariant(TOOL_NAMES.filter((name) => name !== "git").every((name) => safeWslPath(value.tools[name].executable)) &&
    value.tools.bash.executable === "/usr/bin/bash" && value.tools.script.executable === "/usr/bin/script",
  "wsl-tool-paths", "WSL tools require safe absolute paths and pinned bash/script executables.");
  invariant(value.tools.bash.args.length === 0 && value.tools.script.args.length === 0,
    "wsl-wrapper-tools", "Pinned bash and script invariant args must be empty.");
  invariant(record(value.verifier) && value.verifier.environment === "wsl" &&
    record(value.verifier.result) && string(value.verifier.result.reward_file) && string(value.verifier.result.reward_field) &&
    Array.isArray(value.verifier.result.count_fields), "verifier", "WSL verifier result selectors are required.");
  requireSafeRelative(value.verifier.result.reward_file, "reward-file");
  exactKeys(value.verifier, ["environment", "result"], "verifier-keys");
  exactKeys(value.verifier.result, ["reward_file", "reward_field", "count_fields"], "verifier-result-keys");
  invariant(value.verifier.result.count_fields.every((item) => string(item)), "count-fields",
    "Verifier count fields must be non-empty strings.");
  invariant(value.verifier.result.reward_file === "verifier/reward.json" &&
    value.verifier.result.reward_field === "reward" &&
    value.verifier.result.count_fields.join("\0") === OFFICIAL_REWARD_FIELDS.join("\0"), "reward-selectors",
  "Verifier selectors must match the official reward schema.");
  invariant(record(value.protocol) && value.protocol.wall_seconds === DEFAULT_WALL_SECONDS &&
    value.protocol.startup_seconds === DEFAULT_STARTUP_SECONDS &&
    value.protocol.activity_seconds === DEFAULT_ACTIVITY_SECONDS &&
    value.protocol.progress_seconds === DEFAULT_PROGRESS_SECONDS &&
    value.protocol.retry_count === 0 && value.protocol.attempts_per_arm === 1 &&
    value.protocol.arm_order?.join(",") === "bare,sortie", "protocol",
  "Protocol must be Bare then Sortie with fixed watchdogs, one attempt, and retry zero.");
  exactKeys(value.protocol, ["wall_seconds", "startup_seconds", "activity_seconds", "progress_seconds",
    "retry_count", "attempts_per_arm", "arm_order"], "protocol-keys");
  return { manifest: value, manifestPath: resolve(manifestPath), repositoryRoot: resolve(repositoryRoot),
    runtimeRoot, officialRoot, packagePath };
}

function armModel(manifest, arm) {
  return manifest.opencode.arm_models?.[arm] ?? { model: manifest.opencode.model, variant: manifest.opencode.variant };
}

export async function verifyPinnedFiles(context) {
  const observations = {};
  for (const path of OFFICIAL_FILES) {
    const absolute = resolve(context.officialRoot, path);
    invariant(isInside(context.officialRoot, absolute), "official-path", "Official path escaped its root.");
    const actual = await sha256File(absolute).catch(() => null);
    invariant(actual === context.manifest.official_sha256[path], "official-hash-mismatch",
      "An official task file is absent or differs from its pinned hash.");
    observations[path] = actual;
  }
  const packageHash = await sha256File(context.packagePath).catch(() => null);
  invariant(packageHash === context.manifest.package.sha256, "package-hash-mismatch",
    "The supplied Sortie package differs from its pinned hash.");
  return { official_sha256: observations, package_sha256: packageHash };
}

export function buildSpawnSpec(executable, args, options = {}) {
  invariant(string(executable) && Array.isArray(args) && args.every((arg) => typeof arg === "string"),
    "spawn-spec", "Unsafe process specification.");
  return { executable, args: [...args], options: { cwd: options.cwd, env: options.env, shell: false,
    windowsHide: true, detached: process.platform !== "win32" } };
}

export function watchdogReason(now, state, limits) {
  if (now - state.started_at >= limits.wall_ms) return "hard-wall";
  if (state.first_output_at === null && now - state.started_at >= limits.startup_ms) return "startup";
  if (state.first_output_at !== null && now - state.last_activity_at >= limits.activity_ms) return "activity";
  if (now - state.last_progress_at >= limits.progress_ms) return "progress";
  return null;
}

async function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    await new Promise((done) => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true, shell: false });
      killer.once("error", () => done());
      killer.once("close", () => done());
    });
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    await new Promise((done) => setTimeout(done, 500));
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
}

export async function execute(executable, args, options = {}) {
  const spec = buildSpawnSpec(executable, args, options);
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(spec.executable, spec.args, {
      ...spec.options, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    const spawnEvidence = Promise.resolve(options.onSpawn?.(child.pid));
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let operationFailure = null;
    let eventBuffer = "";
    let stopOperation;
    const stop = () => stopOperation ??= (async () => {
      try { await options.stopTree?.(); }
      catch { operationFailure = "process-cleanup-unconfirmed"; }
      await killTree(child);
    })();
    const startedAt = Date.now();
    const watchState = { started_at: startedAt, first_output_at: null, last_activity_at: startedAt,
      last_progress_at: startedAt };
    let progressValue = options.initialProgressValue;
    let progressChanges = 0;
    let progressProbeRunning = false;
    let lastProgressProbe = startedAt;
    const append = (current, chunk) => {
      const next = Buffer.concat([current, chunk]);
      if (next.length > (options.outputLimit ?? OUTPUT_LIMIT)) {
        void stop();
        throw new HarnessFailure("bounded-output", "A child process exceeded bounded output.");
      }
      return next;
    };
    const activity = () => {
      const now = Date.now();
      watchState.first_output_at ??= now;
      watchState.last_activity_at = now;
    };
    child.stdout.on("data", (chunk) => { try {
      activity(); stdout = append(stdout, chunk);
      if (options.eventGate !== undefined && operationFailure === null) {
        eventBuffer += chunk.toString("utf8");
        const lines = eventBuffer.split(/\r?\n/u);
        eventBuffer = lines.pop();
        for (const line of lines) {
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          operationFailure = options.eventGate(event);
          if (operationFailure !== null) { void stop(); break; }
        }
      }
    } catch (error) { reject(error); } });
    child.stderr.on("data", (chunk) => { try { activity(); stderr = append(stderr, chunk); } catch (error) { reject(error); } });
    const finishTimeout = async (reason) => {
      if (settled) return;
      settled = true;
      await spawnEvidence.catch(() => undefined);
      await stop();
      resolvePromise({ code: 124, signal: reason, stdout, stderr, timedOut: true, watchdog: reason, pid: child.pid });
    };
    const timer = setTimeout(() => void finishTimeout("hard-wall"), options.timeoutMs ?? 120_000);
    const watchdog = options.watchdog === undefined ? undefined : setInterval(async () => {
      if (settled) return;
      const now = Date.now();
      if (options.progressProbe !== undefined && !progressProbeRunning && now - lastProgressProbe >= 30_000) {
        progressProbeRunning = true;
        lastProgressProbe = now;
        try {
          const observed = await options.progressProbe();
          if (observed !== progressValue) {
            progressValue = observed;
            progressChanges += 1;
            watchState.last_progress_at = Date.now();
          }
        } catch { await finishTimeout("progress-probe"); }
        finally { progressProbeRunning = false; }
      }
      const reason = watchdogReason(Date.now(), watchState, options.watchdog);
      if (reason !== null) await finishTimeout(reason);
    }, 1000);
    const heartbeat = options.heartbeat === undefined ? undefined : setInterval(() => {
      if (settled) return;
      const now = Date.now();
      const evidence = { phase: options.heartbeat, pid: child.pid ?? null,
        elapsed_seconds: Math.floor((now - startedAt) / 1000),
        last_activity_seconds: watchState.first_output_at === null ? null :
          Math.floor((now - watchState.last_activity_at) / 1000),
        last_progress_seconds: options.progressProbe === undefined ? null :
          Math.floor((now - watchState.last_progress_at) / 1000),
        progress_changes: options.progressProbe === undefined ? null : progressChanges,
        stdout_bytes: stdout.length, stderr_bytes: stderr.length };
      process.stderr.write(`[frontierharness] ${JSON.stringify(evidence)}\n`);
    }, HEARTBEAT_SECONDS * 1000);
    child.once("error", async (error) => {
      clearTimeout(timer);
      if (watchdog !== undefined) clearInterval(watchdog);
      if (heartbeat !== undefined) clearInterval(heartbeat);
      await spawnEvidence.catch(() => undefined);
      if (!settled) reject(error);
      settled = true;
    });
    child.once("close", async (code, signal) => {
      clearTimeout(timer);
      if (watchdog !== undefined) clearInterval(watchdog);
      if (heartbeat !== undefined) clearInterval(heartbeat);
      if (settled) return;
      settled = true;
      try { await spawnEvidence; } catch (error) { reject(error); return; }
      if (stopOperation) await stopOperation;
      resolvePromise({ code: code ?? 1, signal, stdout, stderr, timedOut: false, watchdog: null,
        operationFailure, pid: child.pid });
    });
  });
}

async function checked(executable, args, options = {}, gate = "command") {
  const result = await execute(executable, args, options);
  invariant(result.code === 0, gate, `A prerequisite command failed (exit ${result.code}, stderr ${sha256Bytes(result.stderr)}).`);
  return result;
}

function commandArgs(command, extra = []) {
  return [...command.args, ...extra];
}

async function runTool(command, extra = [], options = {}, gate = "tool") {
  return checked(command.executable, commandArgs(command, extra), options, gate);
}

function wslSpec(manifest, cwd, executable, args, environment = {}) {
  const assignments = Object.entries(environment).map(([key, value]) => `${key}=${value}`);
  const shellArgs = ["-ic", 'exec "$@"', "frontierharness", "/usr/bin/env",
    "-u", "OPENCODE_CONFIG", "-u", "OPENCODE_CONFIG_CONTENT", "-u", "SORTIE_DOGS_CONFIG",
    "-u", "SORTIE_REFLECTION", ...assignments, executable, ...args];
  if (process.platform !== "win32") return { executable: "bash", args: shellArgs, cwd };
  return {
    executable: manifest.opencode.wsl_executable,
    args: ["--cd", cwd, "-e", "bash", ...shellArgs],
  };
}

async function runWsl(manifest, cwd, executable, args, environment = {}, options = {}, gate = "wsl-command") {
  const spec = wslSpec(manifest, cwd, executable, args, environment);
  return checked(spec.executable, spec.args, { ...options, cwd: spec.cwd ?? options.cwd }, gate);
}

async function toWslPath(manifest, path) {
  if (process.platform !== "win32") return resolve(path).split(sep).join("/");
  const spec = wslSpec(manifest, "/", "/usr/bin/wslpath", ["-a", resolve(path)]);
  const result = await checked(spec.executable, spec.args, { cwd: spec.cwd }, "wsl-path");
  return result.stdout.toString("utf8").trim();
}

function pinnedGoEnvironment(manifest) {
  const goBin = posix.dirname(manifest.tools.go.executable);
  const goyaccBin = posix.dirname(manifest.tools.goyacc.executable);
  const reporterBin = posix.dirname(manifest.tools.go_ctrf_json_reporter.executable);
  const nodeBin = posix.dirname(manifest.tools.node.executable);
  const npmBin = posix.dirname(manifest.tools.npm.executable);
  invariant(goyaccBin === reporterBin, "go-tool-layout",
    "Pinned goyacc and go-ctrf-json-reporter must share one GOPATH bin directory.");
  return { PATH: [...new Set([goBin, goyaccBin, nodeBin, npmBin, "/usr/bin", "/bin"])].join(":"),
    GOPATH: posix.dirname(goyaccBin) };
}

export function buildVerifierEnvironment(manifest, paths) {
  invariant(record(paths) && ["tests", "verifier", "app", "artifacts", "gocache", "gopath"].every((key) => safeWslPath(paths[key])),
    "verifier-environment", "Verifier paths are incomplete.");
  const pinned = pinnedGoEnvironment(manifest);
  return { ...pinned, PATH: `${paths.gopath}/bin:${pinned.PATH}`, GOPATH: paths.gopath,
    TESTS_DIR: paths.tests, VERIFIER_DIR: paths.verifier,
    APP_DIR: paths.app, ARTIFACTS_DIR: paths.artifacts, GOCACHE: paths.gocache };
}

function completeJson(text) {
  const start = text.indexOf("{");
  invariant(start >= 0, "resolved-config-json", "OpenCode did not emit a resolved JSON configuration.");
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return text.slice(start, index + 1);
  }
  throw new HarnessFailure("resolved-config-json", "OpenCode resolved configuration was truncated.");
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function readState(runtimeRoot) {
  try { return JSON.parse(await readFile(join(runtimeRoot, STATE_FILE), "utf8")); }
  catch { return { schema_version: 1, arms: {} }; }
}

async function saveState(runtimeRoot, state) {
  await atomicJson(join(runtimeRoot, STATE_FILE), state);
}

export function assertRunArmAllowed(state, arm, qualificationOnly = false) {
  invariant(!state.stopped, "expected-operation", "Benchmark stopped; diagnose before a new matched pair.");
  invariant(ARMS.includes(arm), "arm", "Arm must be bare or sortie.");
  invariant(state.preflight?.status === "pass" && state.prepared?.status === "pass", "phase-order",
    "Preflight and prepare must pass before an arm starts.");
  invariant(!state.arms?.[arm]?.attempted, "attempt-once", "This arm already consumed its only attempt.");
  if (qualificationOnly) invariant(arm === "sortie", "qualification-arm", "Qualification permits only Sortie.");
  if (arm === "sortie") invariant(qualificationOnly || state.arms?.bare?.run?.status === "complete", "arm-order",
    "Bare must complete before Sortie starts.");
}

export function assertVerifyAllowed(state, arm, qualificationOnly = false) {
  invariant(!state.stopped, "expected-operation", "Benchmark stopped; verification is not permitted.");
  invariant(ARMS.includes(arm), "arm", "Arm must be bare or sortie.");
  invariant(state.arms?.[arm]?.run?.status === "complete", "verify-order", "Arm run must complete before verification.");
  if (qualificationOnly) invariant(arm === "sortie", "qualification-arm", "Qualification permits only Sortie.");
  invariant(!state.arms?.[arm]?.verification?.attempted, "verify-once", "Verifier already consumed its one run.");
}

export function assertSnapshotVerifyAllowed(state, arm, confirmed) {
  invariant(confirmed === true, "snapshot-confirm", "Snapshot verification requires --confirm.");
  invariant(ARMS.includes(arm), "arm", "Arm must be bare or sortie.");
  const candidate = state.arms?.[arm];
  const recovered = candidate?.run?.status === "snapshot-only" && candidate.run.exit === null &&
    candidate.run.recovery?.writers_stopped === true && candidate.run.recovery?.controller_exit_unavailable === true;
  invariant(candidate?.active_pid == null && (recovered || (candidate?.run?.status === "complete" &&
    candidate.run.exit === 0 && !candidate.run.timed_out && !candidate.run.operation_failure)),
  "snapshot-incomplete", "Snapshot requires an exited, non-interrupted agent run.");
  invariant(!candidate.verification?.attempted, "verify-once", "Verifier already consumed its one run.");
}

function forbiddenText(value) {
  return /sortie-dogs|dog-coordinator|dog-worker|sortie_/iu.test(value);
}

async function walkFiles(root) {
  const output = [];
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push(path);
    }
  }
  if (await stat(root).catch(() => null)) await visit(root);
  return output;
}

export async function assertBareIsolation({ projectRoot, configRoots, resolvedConfig }) {
  const controlPaths = [join(projectRoot, ".opencode"), join(projectRoot, ".sortie-dogs"), ...configRoots];
  for (const root of controlPaths) {
    for (const path of await walkFiles(root)) {
      invariant(!forbiddenText(portableRelative(root, path)), "bare-filesystem-contamination",
        "Bare contains a forbidden Sortie control path.");
      const info = await stat(path);
      if (info.size <= 1024 * 1024) invariant(!forbiddenText(await readFile(path, "utf8")),
        "bare-filesystem-contamination", "Bare contains forbidden Sortie control content.");
    }
  }
  invariant(!forbiddenText(JSON.stringify(resolvedConfig)), "bare-config-contamination",
    "Bare resolved configuration contains Sortie configuration.");
  const plugins = Array.isArray(resolvedConfig?.plugin) ? resolvedConfig.plugin : [];
  invariant(plugins.length === 0, "bare-plugin-contamination", "Bare resolved configuration contains a plugin.");
  return { plugin_count: 0, filesystem: "clean", resolved_config: "clean" };
}

function safeConfig() {
  return { $schema: "https://opencode.ai/config.json", mcp: {}, plugin: [] };
}

async function createConfigRoots(runtimeRoot, arm) {
  const opencode = join(runtimeRoot, "configs", arm, "opencode");
  const xdg = join(runtimeRoot, "configs", arm, "xdg");
  await mkdir(join(xdg, "opencode"), { recursive: true });
  await mkdir(opencode, { recursive: true });
  await atomicJson(join(opencode, "opencode.json"), safeConfig());
  await atomicJson(join(xdg, "opencode", "opencode.json"), safeConfig());
  return { opencode, xdg };
}

async function cloneAtBase(context, destination) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(dirname(destination), { recursive: true });
  await runTool(context.manifest.tools.git,
    ["clone", "--no-checkout", "--no-tags", context.manifest.source.repository, destination], {}, "clone");
  await runTool(context.manifest.tools.git, ["config", "core.autocrlf", "false"],
    { cwd: destination }, "checkout-line-endings");
  await runTool(context.manifest.tools.git, ["config", "core.eol", "lf"],
    { cwd: destination }, "checkout-line-endings");
  await runTool(context.manifest.tools.git, ["checkout", "--detach", ANKO_BASE], { cwd: destination }, "checkout-base");
  await runTool(context.manifest.tools.git, ["remote", "remove", "origin"], { cwd: destination }, "remove-remote");
  const refsResult = await runTool(context.manifest.tools.git, ["for-each-ref", "--format=%(refname)"],
    { cwd: destination }, "list-refs");
  for (const ref of refsResult.stdout.toString("utf8").split(/\r?\n/u).filter(Boolean))
    await runTool(context.manifest.tools.git, ["update-ref", "-d", ref], { cwd: destination }, "delete-ref");
  await runTool(context.manifest.tools.git, ["reflog", "expire", "--expire=now", "--all"],
    { cwd: destination }, "expire-reflog");
  await runTool(context.manifest.tools.git, ["gc", "--prune=now"], { cwd: destination }, "prune-future-objects");
  const hooks = join(destination, ".git", "frontierharness-empty-hooks");
  await mkdir(hooks, { recursive: true });
  await runTool(context.manifest.tools.git, ["config", "core.hooksPath", ".git/frontierharness-empty-hooks"],
    { cwd: destination }, "disable-hooks");
  // Both arms receive one identical committer identity so Git bookkeeping cannot decide correctness.
  for (const [key, value] of Object.entries(BENCHMARK_GIT_IDENTITY)) {
    await runTool(context.manifest.tools.git, ["config", key, value], { cwd: destination }, "commit-identity");
  }
  const head = (await runTool(context.manifest.tools.git, ["rev-parse", "HEAD"], { cwd: destination }, "head-pin"))
    .stdout.toString("utf8").trim();
  invariant(head === ANKO_BASE, "base-mismatch", "Fresh workspace HEAD differs from the approved Anko base.");
}

async function copyOfficial(context) {
  const destination = join(context.runtimeRoot, "official");
  await rm(destination, { recursive: true, force: true });
  for (const path of OFFICIAL_FILES) {
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(context.officialRoot, path), target, { force: false, errorOnExist: true });
    invariant(await sha256File(target) === context.manifest.official_sha256[path], "official-copy",
      "An official file changed while copied.");
  }
  return destination;
}

async function inspectResolvedConfig(context, arm, workspace, roots) {
  const cwd = await toWslPath(context.manifest, workspace);
  const environment = {
    ...pinnedGoEnvironment(context.manifest),
    OPENCODE_CONFIG_DIR: await toWslPath(context.manifest, roots.opencode),
    XDG_CONFIG_HOME: await toWslPath(context.manifest, roots.xdg),
    OPENCODE_EXE: context.manifest.opencode.executable,
  };
  const script = context.manifest.tools.script;
  const result = await runWsl(context.manifest, cwd, script.executable,
    [...script.args, "-q", "-e", "-c", 'exec "$OPENCODE_EXE" debug config', "/dev/null"],
    environment, { timeoutMs: 300_000 }, "resolved-config");
  let config;
  try { config = JSON.parse(completeJson(result.stdout.toString("utf8"))); }
  catch { throw new HarnessFailure("resolved-config-json", "OpenCode did not emit one resolved JSON configuration."); }
  const isolation = arm === "bare" ? await assertBareIsolation({ projectRoot: workspace,
    configRoots: [roots.opencode, roots.xdg], resolvedConfig: config }) : null;
  return { config, environment, isolation, stderr_sha256: sha256Bytes(result.stderr) };
}

async function installSortie(context, workspace, roots) {
  const control = join(workspace, ".opencode");
  await writeFile(join(workspace, ".git", "info", "exclude"), ".opencode/\n.sortie-dogs/\n", { flag: "a" });
  await mkdir(control, { recursive: true });
  const tgz = await toWslPath(context.manifest, context.packagePath);
  await atomicJson(join(control, "package.json"), { private: true, type: "module",
    dependencies: { "sortie-dogs": `file:${tgz}` } });
  const controlWsl = await toWslPath(context.manifest, control);
  await runWsl(context.manifest, controlWsl, context.manifest.tools.npm.executable,
    [...context.manifest.tools.npm.args, "install", "--force"], {}, { timeoutMs: 300_000 }, "sortie-install");
  const installed = join(control, "node_modules", "sortie-dogs");
  const installedInfo = await lstat(installed);
  invariant(!installedInfo.isSymbolicLink(), "sortie-link", "Installed Sortie package must not be a link.");
  const installedPackage = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  const markerText = await readFile(join(installed, "dist", "asset-version.js"), "utf8");
  const marker = markerText.match(/RUNTIME_ASSET_VERSION\s*=\s*["']([^"']+)/u)?.[1];
  invariant(installedPackage.version === context.manifest.package.version &&
    marker === context.manifest.package.runtime_marker, "sortie-identity",
  "Installed package version or runtime marker differs from the manifest.");
  const workspaceWsl = await toWslPath(context.manifest, workspace);
  await runWsl(context.manifest, workspaceWsl, context.manifest.tools.node.executable,
    [...context.manifest.tools.node.args, await toWslPath(context.manifest, join(installed, "dist", "cli", "main.js")),
      "init", workspaceWsl], {}, { timeoutMs: 120_000 }, "sortie-init");
  const plugin = `file://${await toWslPath(context.manifest, join(installed, "dist", "plugin", "opencode.js"))}`;
  await atomicJson(join(control, "opencode.json"), { $schema: "https://opencode.ai/config.json", plugin: [plugin] });
  const neutral = { $schema: "https://opencode.ai/config.json", mcp: {} };
  await atomicJson(join(roots.opencode, "opencode.json"), neutral);
  await atomicJson(join(roots.xdg, "opencode", "opencode.json"), neutral);
  const runtimeModule = await import(`${pathToFileURL(join(installed, "dist", "runtime-assets.js")).href}` +
    `?frontierharness=${context.manifest.package.sha256}`);
  invariant(Array.isArray(runtimeModule.runtimeAssets) && runtimeModule.runtimeAssets.length > 0,
    "asset-export", "Installed package does not export canonical runtime assets.");
  const assets = {};
  for (const asset of runtimeModule.runtimeAssets) {
    invariant(record(asset) && string(asset.installPath) && typeof asset.content === "string" &&
      asset.version === context.manifest.package.runtime_marker, "asset-export",
    "Canonical runtime asset metadata differs from the pinned marker.");
    const target = resolve(control, asset.installPath);
    invariant(isInside(control, target), "asset-path", "Runtime asset escaped project control root.");
    const installedContent = await readFile(target, "utf8").catch(() => null);
    invariant(installedContent === asset.content, "asset-content", "Generated runtime asset differs from the package export.");
    assets[asset.installPath] = sha256Bytes(installedContent);
  }
  for (const path of context.manifest.package.required_assets) {
    const target = resolve(control, path);
    invariant(isInside(control, target), "asset-path", "Runtime asset escaped project control root.");
    invariant(await sha256File(target).catch(() => null) !== null, "asset-missing", "A required runtime asset is absent.");
  }
  return { version: installedPackage.version, marker, package_sha256: context.manifest.package.sha256,
    asset_count: Object.keys(assets).length, assets_sha256: sha256Bytes(JSON.stringify(assets)) };
}

export function eventMetadata(stdout) {
  let rootSessionId = null;
  const metricReferences = new Set();
  const usage = new Map();
  let eventErrors = 0;
  let toolErrors = 0;
  const implementationChildren = new Set();
  let terminalOutcome = null;
  for (const line of stdout.toString("utf8").split(/\r?\n/u)) {
    let value;
    try { value = JSON.parse(line); } catch { continue; }
    if (!record(value)) continue;
    if (expectedOperationEvent(value) !== null) eventErrors += 1;
    if (record(value.part) && value.part.type === "tool" && value.part.state?.status === "error") toolErrors += 1;
    const session = value.sessionID ?? value.part?.sessionID;
    if (rootSessionId === null && typeof session === "string" && /^ses_[A-Za-z0-9_-]+$/u.test(session)) rootSessionId = session;
    const part = value.part;
    if (record(part) && part.type === "tool" && part.tool === "task" && part.state?.status === "completed" &&
      ["dog-worker", "dog-luna-worker"].includes(part.state.input?.subagent_type)) {
      const child = part.state.metadata?.sessionId ?? part.state.metadata?.sessionID ??
        /<task\s+id="(ses_[A-Za-z0-9_-]+)"/u.exec(part.state.output ?? "")?.[1];
      if (session === rootSessionId && typeof child === "string" && /^ses_[A-Za-z0-9_-]+$/u.test(child) &&
        child !== rootSessionId) implementationChildren.add(child);
    }
    if (session === rootSessionId && record(part) && part.type === "text" && typeof part.text === "string") {
      const match = /^(?:[^\p{L}\p{N}\n]*)(?:status:\s*)?(DONE|INTERRUPTED|BLOCKED|NEED_DECISION|IN_PROGRESS)\b/u.exec(part.text.trim());
      if (match) terminalOutcome = match[1];
    }
    if (!record(part) || part.type !== "step-finish" || typeof part.id !== "string" || typeof session !== "string") continue;
    usage.set(`${session}:${part.id}`, part);
    if (record(part.tokens)) metricReferences.add("$.part.tokens");
    if (typeof part.cost === "number") metricReferences.add("$.part.cost");
  }
  const numeric = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const totals = { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 };
  let tokensAvailable = usage.size > 0, costAvailable = usage.size > 0, cost = 0;
  for (const part of usage.values()) {
    const values = { input: part.tokens?.input, output: part.tokens?.output, reasoning: part.tokens?.reasoning,
      cache_read: part.tokens?.cache?.read, cache_write: part.tokens?.cache?.write };
    for (const [key, value] of Object.entries(values)) {
      if (numeric(value)) totals[key] += value;
      else tokensAvailable = false;
    }
    if (numeric(part.cost)) cost += part.cost;
    else costAvailable = false;
  }
  return { root_session_id: rootSessionId, token_metric_references: [...metricReferences].sort().slice(0, 64),
    cost: costAvailable ? cost : null, event_errors: eventErrors, tool_errors: toolErrors,
    implementation_children: [...implementationChildren], terminal_outcome: terminalOutcome,
    usage: { coverage: "cli-stream-only", steps: usage.size, tokens: tokensAvailable ? totals : null,
      cost_provenance: costAvailable ? "host-reported-not-invoice" : "unavailable" },
    stdout_sha256: sha256Bytes(stdout) };
}

/** Freeze the stopped candidate in a copy so untracked source is graded without touching the original. */
async function freezeCandidate(context, arm, workspace) {
  const candidate = join(context.runtimeRoot, "candidates", arm);
  await rm(candidate, { recursive: true, force: true });
  await cp(workspace, candidate, { recursive: true });
  const untracked = (await runTool(context.manifest.tools.git, ["ls-files", "--others", "--exclude-standard"],
    { cwd: candidate }, "candidate-untracked")).stdout.toString("utf8").split(/\r?\n/u).filter(Boolean);
  const source = untracked.filter((path) => !CONTROL_PATHS.some((prefix) => path.startsWith(prefix)));
  if (source.length > 0) {
    await runTool(context.manifest.tools.git, ["add", "--intent-to-add", "--", ...source],
      { cwd: candidate }, "candidate-untracked-source");
  }
  return { candidate, untracked_source: source.sort(),
    excluded_control_paths: untracked.filter((path) => !source.includes(path)).sort() };
}

export async function collectPatch(context, arm, workspace) {
  const frozen = await freezeCandidate(context, arm, workspace);
  const patchResult = await runTool(context.manifest.tools.git,
    ["diff", "--binary", ANKO_BASE], { cwd: frozen.candidate }, "model-patch");
  const evidence = join(context.runtimeRoot, "evidence", arm);
  await mkdir(evidence, { recursive: true });
  const patchPath = join(evidence, "model.patch");
  await writeFile(patchPath, patchResult.stdout, { mode: 0o600 });
  const changedResult = await runTool(context.manifest.tools.git,
    ["diff", "--name-only", ANKO_BASE], { cwd: frozen.candidate }, "changed-paths");
  const changedPaths = changedResult.stdout.toString("utf8").split(/\r?\n/u).filter(Boolean).sort();
  const statusResult = await execute(context.manifest.tools.git.executable,
    commandArgs(context.manifest.tools.git, ["status", "--porcelain=v1"]), { cwd: workspace });
  invariant(statusResult.code === 0, "worktree-status", "Unable to classify post-run worktree status.");
  return { patchPath, patch_sha256: sha256Bytes(patchResult.stdout), patch_bytes: patchResult.stdout.length,
    changed_paths: changedPaths, uncommitted_present: statusResult.stdout.length > 0,
    untracked_source: frozen.untracked_source, excluded_control_paths: frozen.excluded_control_paths,
    status_sha256: sha256Bytes(statusResult.stdout) };
}

function reportSecrets(manifest) {
  return [manifest.opencode.auth_file, manifest.paths.package_tgz, manifest.paths.official_root]
    .filter(string);
}

export function sanitizeForReport(value, secrets = []) {
  const forbiddenKey = /(?:auth|credential|secret|prompt|provider_url|raw(?:_|$)|patch_(?:path|body)|workspace|config_dir)/iu;
  function visit(item) {
    if (Array.isArray(item)) return item.map(visit).filter((entry) => entry !== undefined);
    if (record(item)) return Object.fromEntries(Object.entries(item)
      .filter(([key]) => key === "token_metric_references" || (!forbiddenKey.test(key) && !/(?:^|_)token(?:_|$)/iu.test(key)))
      .map(([key, child]) => [key, visit(child)]));
    if (typeof item === "string" && secrets.some((secret) => secret && item.includes(secret))) return "[excluded]";
    return item;
  }
  return visit(value);
}

function getPath(value, dotted) {
  return dotted.split(".").reduce((current, key) => record(current) ? current[key] : undefined, value);
}

function rewardEvidence(resultJson, selectors) {
  const reward = Number(getPath(resultJson, selectors.reward_field ?? "reward"));
  const counts = {};
  for (const field of selectors.count_fields) {
    const value = getPath(resultJson, field);
    counts[field] = (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean" ? value : null;
  }
  return { reward: Number.isFinite(reward) ? reward : null, counts };
}

export function computeSummary(arms) {
  const bare = arms?.bare;
  const sortie = arms?.sortie;
  const reason = bare?.reward !== 1 || sortie?.reward !== 1 ? "reward_not_one" :
    !(typeof bare?.duration_ms === "number" && bare.duration_ms > 0 &&
      typeof sortie?.duration_ms === "number" && sortie.duration_ms > 0) ? "metric_missing" : null;
  if (reason !== null) return { comparison_eligible: false, speed_ratio: null, cost_ratio: null, refusal: reason };
  return { comparison_eligible: true, speed_ratio: bare.duration_ms / sortie.duration_ms,
    cost_ratio: typeof bare.cost === "number" && Number.isFinite(bare.cost) && bare.cost >= 0 &&
      typeof sortie.cost === "number" && Number.isFinite(sortie.cost) && sortie.cost > 0 ? bare.cost / sortie.cost : null,
    refusal: null };
}

export function deliveryResult(run, verification) {
  const reason = run.exit !== 0 || run.timed_out ? "agent-process-failed" :
    run.event_errors > 0 ? "agent-event-error" : run.patch_bytes === 0 ? "no-delivered-patch" :
      verification.exit !== 0 || verification.reward === null ? "verifier-unavailable" :
        verification.reward !== 1 ? "acceptance-failed" : null;
  return { outcome: reason === null ? "succeeded" : "failed", reason };
}

// Completion is agent stop plus a frozen candidate. Terminal delivery is graded separately and is
// only gated when a manifest declares it explicitly, as in qualification mode.
export function expectedOperation(run, arm, expected = {
  min_patch_bytes: 1, min_implementation_children: arm === "sortie" ? 1 : 0, terminal_outcome: null,
}) {
  const reason = run.operation_failure ?? (run.exit !== 0 || run.timed_out ? "agent-process-failed" :
    run.event_errors > 0 ? "agent-event-error" :
    !run.root_session_id ? "session-identity-missing" :
    !(run.patch_bytes >= expected.min_patch_bytes) ? "no-delivered-patch" :
    (run.implementation_children?.length ?? 0) < expected.min_implementation_children ? "implementation-child-missing" :
    expected.terminal_outcome !== null && run.terminal_outcome !== expected.terminal_outcome ? "delivery-not-complete" : null);
  return { status: reason === null ? "pass" : "fail", reason };
}

// Only transport/CLI failures invalidate a measured run. A failed tool call is ordinary recoverable
// agent behavior, is counted as tool_errors, and never stops the benchmark on its own.
export function expectedOperationEvent(event) {
  return event?.type === "error" ? "agent-event-error" : null;
}

export function recordPreAgentFailure(state, arm, at = new Date().toISOString(), gate = "pre-agent-failure") {
  const run = { status: "complete", phase: "pre-agent", exit: 1, signal: null, timed_out: false,
    operation_failure: "pre-agent-failure", pre_agent_gate: gate };
  run.expected_operation = expectedOperation(run, arm);
  state.arms[arm].active_pid = null;
  state.arms[arm].run = run;
  state.stopped = { arm, reason: "pre-agent-failure", at };
  return run;
}

async function preflight(context) {
  invariant(!(await stat(context.runtimeRoot).catch(() => null)), "runtime-exists",
    "runtime_root already exists; use a new run directory or explicit cleanup.");
  const pinned = await verifyPinnedFiles(context);
  const officialTestScript = await readFile(join(context.officialRoot, "tests", "test.sh"));
  invariant(!officialTestScript.includes(13), "official-line-endings", "Official test.sh must retain LF line endings.");
  const syntaxProbePath = `${context.runtimeRoot}.test-script-probe-${process.pid}.sh`;
  try {
    await writeFile(syntaxProbePath, createPathOnlyWrapper(officialTestScript, {
      "/app": "/tmp/frontierharness-app", "/tests": "/tmp/frontierharness-tests", "/logs": "/tmp/frontierharness-logs",
    }), { mode: 0o700 });
    const syntaxProbeWsl = await toWslPath(context.manifest, syntaxProbePath);
    await runWsl(context.manifest, "/", context.manifest.tools.bash.executable,
      [...context.manifest.tools.bash.args, "-n", syntaxProbeWsl], pinnedGoEnvironment(context.manifest),
      { timeoutMs: 30_000 }, "official-test-script-syntax");
  } finally { await rm(syntaxProbePath, { force: true }); }
  const deepSweHead = (await runTool(context.manifest.tools.git,
    ["-C", context.officialRoot, "rev-parse", "HEAD"], {}, "preflight-deepswe-pin"))
    .stdout.toString("utf8").trim();
  invariant(deepSweHead === DEEPSWE_COMMIT, "deepswe-pin-mismatch",
    "Official task root is not from the approved DeepSWE commit.");
  const versions = {};
  const goEnvironment = pinnedGoEnvironment(context.manifest);
  for (const name of TOOL_NAMES) {
    const tool = context.manifest.tools[name];
    const result = tool.environment === "wsl"
      ? await execute(...(() => { const spec = wslSpec(context.manifest, "/", tool.executable,
        [...tool.args, ...tool.probe_args], goEnvironment);
        return [spec.executable, spec.args, { timeoutMs: 120_000, cwd: spec.cwd }]; })())
      : await execute(tool.executable, [...tool.args, ...tool.probe_args], { timeoutMs: 120_000 });
    invariant(result.code === tool.probe_exit, `preflight-${name}`,
      `A prerequisite tool probe failed (exit ${result.code}, stderr ${sha256Bytes(result.stderr)}).`);
    versions[name] = { exit: result.code, stdout_sha256: sha256Bytes(result.stdout), stderr_sha256: sha256Bytes(result.stderr) };
  }
  for (const [toolName, commandName] of [["go", "go"], ["goyacc", "goyacc"],
    ["go_ctrf_json_reporter", "go-ctrf-json-reporter"], ["bash", "bash"]]) {
    const discovered = (await runWsl(context.manifest, "/", "/usr/bin/which", [commandName], goEnvironment,
      { timeoutMs: 30_000 }, `preflight-${toolName}-path`)).stdout.toString("utf8").trim();
    const discoveredReal = (await runWsl(context.manifest, "/", "/usr/bin/readlink", ["-f", discovered], goEnvironment,
      { timeoutMs: 30_000 }, `preflight-${toolName}-realpath`)).stdout.toString("utf8").trim();
    const declaredReal = (await runWsl(context.manifest, "/", "/usr/bin/readlink",
      ["-f", context.manifest.tools[toolName].executable], goEnvironment, { timeoutMs: 30_000 },
      `preflight-${toolName}-declared`)).stdout.toString("utf8").trim();
    invariant(discoveredReal === declaredReal, `preflight-${toolName}-identity`,
      "Official grader command resolution differs from the pinned tool executable.");
    versions[toolName].command_resolution_sha256 = sha256Bytes(discoveredReal);
  }
  const openCode = await runWsl(context.manifest, "/", context.manifest.opencode.executable, ["--version"], {},
    { timeoutMs: 120_000 }, "preflight-opencode");
  invariant(openCode.stdout.toString("utf8").includes(context.manifest.opencode.version), "opencode-version",
    "WSL OpenCode version differs from the manifest.");
  await runWsl(context.manifest, "/", "/usr/bin/test", ["-f", context.manifest.opencode.auth_file], {},
    { timeoutMs: 30_000 }, "auth-presence");
  await runWsl(context.manifest, "/", "/usr/bin/test", ["-x", "/usr/bin/setsid"], {},
    { timeoutMs: 30_000 }, "process-group-support");
  await mkdir(context.runtimeRoot, { recursive: false });
  const state = { schema_version: 1, protocol: { task_id: TASK_ID, methodology_comparable: false,
    leaderboard: false, docker: "intentionally_unused", runta: "intentionally_unused",
    wall_seconds: DEFAULT_WALL_SECONDS, startup_seconds: DEFAULT_STARTUP_SECONDS,
    activity_seconds: DEFAULT_ACTIVITY_SECONDS, progress_seconds: DEFAULT_PROGRESS_SECONDS,
    retries: 0, arm_order: context.manifest.qualification_only ? ["sortie"] : ARMS,
    qualification_only: context.manifest.qualification_only === true },
  preflight: { status: "pass", official_sha256: pinned.official_sha256,
    package_sha256: pinned.package_sha256, deepswe_commit: deepSweHead,
    versions, opencode_version: context.manifest.opencode.version }, arms: {} };
  await saveState(context.runtimeRoot, state);
  return state.preflight;
}

async function prepare(context) {
  const state = await readState(context.runtimeRoot);
  invariant(state.preflight?.status === "pass" && state.prepared === undefined, "prepare-order",
    "Prepare requires one successful preflight and cannot be repeated.");
  await verifyPinnedFiles(context);
  const goEnvironment = pinnedGoEnvironment(context.manifest);
  await runWsl(context.manifest, "/", "/usr/bin/mkdir", ["-p", `${goEnvironment.GOPATH}/bin`], {},
    { timeoutMs: 30_000 }, "prepare-gopath-bin");
  // Publish pinned tools where `go env GOPATH`/bin resolves them, so neither arm must search the host.
  for (const tool of ["goyacc", "go_ctrf_json_reporter"]) {
    const executable = context.manifest.tools[tool].executable;
    await runWsl(context.manifest, "/", "/usr/bin/cp",
      [executable, `${goEnvironment.GOPATH}/bin/${posix.basename(executable)}`], {},
      { timeoutMs: 30_000 }, "prepare-gopath-tool");
  }
  const official = await copyOfficial(context);
  const officialWsl = await toWslPath(context.manifest, official);
  const workspaces = {};
  const configs = {};
  for (const arm of context.manifest.qualification_only ? ["sortie"] : ARMS) {
    workspaces[arm] = join(context.runtimeRoot, "workspaces", arm);
    await cloneAtBase(context, workspaces[arm]);
    await runWsl(context.manifest, await toWslPath(context.manifest, workspaces[arm]),
      context.manifest.tools.go.executable, ["mod", "download"], goEnvironment,
      { timeoutMs: 600_000 }, "prepare-go-mod-download");
    const preparedStatus = await runTool(context.manifest.tools.git, ["status", "--porcelain=v1"],
      { cwd: workspaces[arm] }, "prepare-cleanliness");
    invariant(preparedStatus.stdout.length === 0, "prepare-dirty", "Dependency preparation changed the arm workspace.");
    configs[arm] = await createConfigRoots(context.runtimeRoot, arm);
  }
  const count = context.manifest.qualification_only ? 1 : 2;
  state.prepared = { status: "pass", base: ANKO_BASE, official_sha256: state.preflight.official_sha256,
    official_wsl_sha256: sha256Bytes(officialWsl), workspace_count: count, isolated_config_count: count };
  await saveState(context.runtimeRoot, state);
  return state.prepared;
}

export async function stopWslGroup(manifest, groupFile) {
  const pid = (await readFile(groupFile, "utf8")).trim();
  invariant(/^[1-9][0-9]*$/u.test(pid), "process-group", "Owned WSL process group identity is invalid.");
  await runWsl(manifest, "/", "/usr/bin/bash", ["-c",
    'kill -TERM -- "-$1" 2>/dev/null || true; sleep 0.5; kill -KILL -- "-$1" 2>/dev/null || true; sleep 0.2; ! kill -0 -- "-$1" 2>/dev/null',
    "frontier-stop", pid], {}, { timeoutMs: 30_000 }, "process-group-stop");
}

export function ownedWslSpec(manifest, cwd, executable, args, environment, groupFileWsl) {
  // A Windows taskkill of wsl.exe alone does not prove its Linux descendants stopped.
  return wslSpec(manifest, cwd, "/usr/bin/setsid", ["--wait", "/usr/bin/bash", "-c",
    'printf "%s\\n" "$$" > "$1"; shift; exec "$@"', "frontier-group", groupFileWsl,
    executable, ...args], environment);
}

async function runArm(context, arm) {
  const state = await readState(context.runtimeRoot);
  assertRunArmAllowed(state, arm, context.manifest.qualification_only === true);
  state.arms[arm] = { attempted: true, started_at: new Date().toISOString(), active_pid: null };
  await saveState(context.runtimeRoot, state);
  const workspace = join(context.runtimeRoot, "workspaces", arm);
  const roots = { opencode: join(context.runtimeRoot, "configs", arm, "opencode"),
    xdg: join(context.runtimeRoot, "configs", arm, "xdg") };
  let packageEvidence = null;
  let inspected;
  let preRunStatus;
  let cwd;
  let selectedModel;
  let args;
  let groupFile;
  let groupFileWsl;
  let spec;
  try {
    if (arm === "sortie") packageEvidence = await installSortie(context, workspace, roots);
    inspected = await inspectResolvedConfig(context, arm, workspace, roots);
    if (arm === "sortie") invariant(Array.isArray(inspected.config.plugin) &&
      inspected.config.plugin.length === 1 && typeof inspected.config.plugin[0] === "string" &&
      forbiddenText(inspected.config.plugin[0]),
    "sortie-plugin-config", "Sortie resolved config is not the exact project-local plugin.");
    const instruction = await readFile(join(context.runtimeRoot, "official", "instruction.md"), "utf8");
    preRunStatus = await runTool(context.manifest.tools.git, ["status", "--porcelain=v1"],
      { cwd: workspace }, "pre-run-cleanliness");
    invariant(preRunStatus.stdout.length === 0, "pre-run-dirty", "Arm workspace is dirty before the timed run.");
    cwd = await toWslPath(context.manifest, workspace);
    selectedModel = armModel(context.manifest, arm);
    args = ["run", "--dir", cwd, "--format", "json", "--model", selectedModel.model,
      "--variant", selectedModel.variant, "--agent", arm === "sortie" ? "dog-coordinator" : "build", instruction];
    groupFile = join(context.runtimeRoot, `${arm}-process-group.pid`);
    groupFileWsl = await toWslPath(context.manifest, groupFile);
    spec = ownedWslSpec(context.manifest, cwd, context.manifest.opencode.executable, args,
      inspected.environment, groupFileWsl);
  } catch (error) {
    recordPreAgentFailure(state, arm, new Date().toISOString(),
      error instanceof HarnessFailure ? error.gate : "internal");
    await saveState(context.runtimeRoot, state);
    throw new HarnessFailure("pre-agent-failure", "Arm failed before agent start; sanitized terminal state saved.");
  }
  const started = Date.now();
  const stopGroup = () => stopWslGroup(context.manifest, groupFile);
  const result = await execute(spec.executable, spec.args, { timeoutMs: DEFAULT_WALL_SECONDS * 1000,
    cwd: spec.cwd,
    heartbeat: `run-arm:${arm}`,
    eventGate: expectedOperationEvent,
    stopTree: stopGroup,
    initialProgressValue: sha256Bytes(preRunStatus.stdout),
    progressProbe: async () => sha256Bytes((await runTool(context.manifest.tools.git,
      ["status", "--porcelain=v1"], { cwd: workspace }, "watchdog-progress")).stdout),
    watchdog: { wall_ms: context.manifest.protocol.wall_seconds * 1000,
      startup_ms: context.manifest.protocol.startup_seconds * 1000,
      activity_ms: context.manifest.protocol.activity_seconds * 1000,
      progress_ms: context.manifest.protocol.progress_seconds * 1000 },
    onSpawn: async (pid) => { state.arms[arm].active_pid = pid ?? null; await saveState(context.runtimeRoot, state); } });
  try { await stopGroup(); }
  catch { result.operationFailure = "process-cleanup-unconfirmed"; }
  state.arms[arm].active_pid = null;
  const patch = await collectPatch(context, arm, workspace).catch(() => {
    result.operationFailure ??= "patch-capture-unavailable";
    return { patch_sha256: null, patch_bytes: null, changed_paths: null, uncommitted_present: null, status_sha256: null };
  });
  const metadata = eventMetadata(result.stdout);
  state.arms[arm].run = { status: "complete", exit: result.code, signal: result.signal, timed_out: result.timedOut,
    watchdog: result.watchdog,
    operation_failure: result.operationFailure ?? null,
    event_errors: metadata.event_errors, usage: metadata.usage,
    implementation_children: metadata.implementation_children, terminal_outcome: metadata.terminal_outcome,
    duration_ms: Date.now() - started, root_session_id: metadata.root_session_id,
    token_metric_references: metadata.token_metric_references, cost: metadata.cost, stdout_sha256: metadata.stdout_sha256,
    stderr_sha256: sha256Bytes(result.stderr), model: selectedModel.model,
    variant: selectedModel.variant, package: packageEvidence,
    isolation: inspected.isolation, resolved_config_sha256: sha256Bytes(JSON.stringify(inspected.config)),
    patch_sha256: patch.patch_sha256,
    patch_bytes: patch.patch_bytes, changed_paths: patch.changed_paths, uncommitted_present: patch.uncommitted_present,
    status_sha256: patch.status_sha256 };
  const gate = expectedOperation(state.arms[arm].run, arm, context.manifest.expected_operation?.[arm]);
  state.arms[arm].run.expected_operation = gate;
  if (gate.status === "fail") state.stopped = { arm, reason: gate.reason, at: new Date().toISOString() };
  await saveState(context.runtimeRoot, state);
  if (state.stopped) {
    await summarize(context);
    // Keep candidate workspaces for diagnosis; cleanup remains an explicit operation.
    throw new HarnessFailure("expected-operation", "Normal operation failed; partial summary saved. Stop and diagnose.");
  }
  return sanitizeForReport(state.arms[arm].run, reportSecrets(context.manifest));
}

async function recaptureArm(context, arm) {
  const state = await readState(context.runtimeRoot);
  invariant(state.arms?.[arm]?.run?.status === "complete" && state.arms[arm].verification === undefined,
    "recapture-order", "Recapture requires one completed, unverified arm.");
  const run = state.arms[arm].run;
  const patch = await collectPatch(context, arm, join(context.runtimeRoot, "workspaces", arm));
  state.arms[arm].capture_correction = { reason: "working-tree-omitted-by-infrastructure",
    previous_patch_sha256: run.patch_sha256, previous_patch_bytes: run.patch_bytes,
    corrected_at: new Date().toISOString() };
  Object.assign(run, { patch_sha256: patch.patch_sha256, patch_bytes: patch.patch_bytes,
    changed_paths: patch.changed_paths, uncommitted_present: patch.uncommitted_present,
    status_sha256: patch.status_sha256 });
  await saveState(context.runtimeRoot, state);
  return { status: "complete", ...state.arms[arm].capture_correction,
    patch_sha256: run.patch_sha256, patch_bytes: run.patch_bytes, changed_paths: run.changed_paths };
}

async function replaceInfrastructureArm(context, arm, gate, confirmed) {
  invariant(confirmed && string(gate), "replacement-confirmation",
    "Infrastructure replacement requires --confirm and --gate.");
  const state = await readState(context.runtimeRoot);
  const attempted = state.arms?.[arm];
  invariant(attempted?.attempted === true && attempted.active_pid === null &&
    (attempted.run === undefined || attempted.run?.phase === "pre-agent"),
    "replacement-order", "Only a stopped pre-agent infrastructure attempt can be replaced.");
  state.infrastructure_invalid ??= [];
  state.infrastructure_invalid.push({ arm, gate, started_at: attempted.started_at,
    recorded_at: new Date().toISOString(), agent_started: false });
  delete state.arms[arm];
  await saveState(context.runtimeRoot, state);
  return state.infrastructure_invalid.at(-1);
}

async function replaceInfrastructureVerifier(context, arm, gate, confirmed) {
  invariant(confirmed && string(gate), "replacement-confirmation",
    "Infrastructure verifier replacement requires --confirm and --gate.");
  const state = await readState(context.runtimeRoot);
  const verification = state.arms?.[arm]?.verification;
  invariant(verification?.attempted === true && verification.active_pid === null &&
    (verification.status === undefined || (verification.status === "complete" && verification.reward === null)),
    "replacement-order", "Only a stopped verifier without a reward can be replaced.");
  state.infrastructure_invalid ??= [];
  state.infrastructure_invalid.push({ arm, gate, started_at: verification.started_at,
    recorded_at: new Date().toISOString(), verifier: true });
  for (const path of ["verifiers", "verifier-support", "verifier-logs", "verifier-artifacts",
    "verifier-gocache", "verifier-gopath"])
    await rm(join(context.runtimeRoot, path, arm), { recursive: true, force: true });
  delete state.arms[arm].verification;
  await saveState(context.runtimeRoot, state);
  return state.infrastructure_invalid.at(-1);
}

async function recoverStoppedSnapshot(context, arm, confirmed) {
  invariant(confirmed === true, "snapshot-recovery-confirm", "Stopped snapshot recovery requires --confirm.");
  const state = await readState(context.runtimeRoot);
  const attempted = state.arms?.[arm];
  invariant(attempted?.attempted === true && attempted.run === undefined,
    "snapshot-recovery-order", "Recovery requires one attempted arm without a finalized run.");
  await stopWslGroup(context.manifest, join(context.runtimeRoot, `${arm}-process-group.pid`));
  const workspace = join(context.runtimeRoot, "workspaces", arm);
  const patch = await collectPatch(context, arm, workspace);
  attempted.active_pid = null;
  attempted.run = { status: "snapshot-only", exit: null, signal: null, timed_out: null,
    operation_failure: "controller-exit-unavailable", event_errors: null, tool_errors: null,
    usage: { coverage: "unavailable", steps: null, tokens: null, cost_provenance: "unavailable" },
    implementation_children: null, terminal_outcome: null,
    duration_ms: null, root_session_id: null, token_metric_references: [], cost: null,
    model: armModel(context.manifest, arm).model, variant: armModel(context.manifest, arm).variant,
    patch_sha256: patch.patch_sha256, patch_bytes: patch.patch_bytes, changed_paths: patch.changed_paths,
    uncommitted_present: patch.uncommitted_present, untracked_source: patch.untracked_source,
    excluded_control_paths: patch.excluded_control_paths, status_sha256: patch.status_sha256,
    recovery: { writers_stopped: true, controller_exit_unavailable: true, recovered_at: new Date().toISOString() } };
  state.stopped = { arm, reason: "controller-exit-unavailable", at: new Date().toISOString() };
  await saveState(context.runtimeRoot, state);
  return sanitizeForReport(attempted.run, reportSecrets(context.manifest));
}

async function inspectArm(context, arm) {
  const workspace = join(context.runtimeRoot, "workspaces", arm);
  const roots = { opencode: join(context.runtimeRoot, "configs", arm, "opencode"),
    xdg: join(context.runtimeRoot, "configs", arm, "xdg") };
  const inspected = await inspectResolvedConfig(context, arm, workspace, roots);
  const plugins = inspected.config.plugin;
  return { plugin_is_array: Array.isArray(plugins), plugin_count: Array.isArray(plugins) ? plugins.length : null,
    plugin_fingerprints: Array.isArray(plugins) ? plugins.map((value) => sha256Bytes(JSON.stringify(value))) : [],
    config_has_sortie: forbiddenText(JSON.stringify(inspected.config)) };
}

export function createPathOnlyWrapper(source, replacements) {
  const text = source.toString("utf8");
  invariant(Buffer.from(text, "utf8").equals(source), "test-script-encoding", "Official test.sh is not UTF-8 text.");
  let output = text;
  invariant(Object.keys(replacements).sort().join("\0") === ["/app", "/logs", "/tests"].join("\0") &&
    Object.values(replacements).every(safeWslPath), "test-script-replacements",
  "test.sh replacement paths must be exact safe WSL absolute paths.");
  const placeholders = { "/app": "__FRONTIERHARNESS_APP__", "/tests": "__FRONTIERHARNESS_TESTS__",
    "/logs": "__FRONTIERHARNESS_LOGS__" };
  for (const [from, placeholder] of Object.entries(placeholders)) {
    const pattern = new RegExp(`${from}(?=/|[^A-Za-z0-9._-]|$)`, "gu");
    invariant(pattern.test(output), "test-script-path", "Official test.sh lacks an approved Docker absolute path.");
    pattern.lastIndex = 0;
    invariant(!output.includes(placeholder), "test-script-path", "Official test.sh contains a reserved wrapper marker.");
    output = output.replace(pattern, placeholder);
  }
  for (const [from, placeholder] of Object.entries(placeholders)) output = output.split(placeholder).join(replacements[from]);
  return Buffer.from(output, "utf8");
}

export function createLocalVerifierConfig(source, logsPath) {
  invariant(safeWslPath(logsPath), "verifier-config-path", "Verifier logs path is not a safe WSL path.");
  const config = JSON.parse(source.toString("utf8"));
  invariant(Array.isArray(config?.grade?.reports) && config.grade.reports.length > 0 &&
    config.grade.reports.every((path) => typeof path === "string" && path.startsWith("/logs/")),
  "verifier-config-reports", "Official verifier config lacks absolute /logs report paths.");
  config.grade.reports = config.grade.reports.map((path) => `${logsPath}${path.slice("/logs".length)}`);
  return Buffer.from(`${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function verifyArm(context, arm, snapshot = false, confirmed = false) {
  const state = await readState(context.runtimeRoot);
  if (snapshot) {
    assertSnapshotVerifyAllowed(state, arm, confirmed);
    const workspace = join(context.runtimeRoot,
      state.arms[arm].run.status === "snapshot-only" ? "candidates" : "workspaces", arm);
    const patch = await runTool(context.manifest.tools.git, ["diff", "--binary", ANKO_BASE],
      { cwd: workspace }, "snapshot-diff");
    const untracked = await runTool(context.manifest.tools.git, ["ls-files", "--others", "--exclude-standard"],
      { cwd: workspace }, "snapshot-untracked");
    invariant(untracked.stdout.toString("utf8").trim() === "", "snapshot-untracked",
      "Untracked source is not represented by the retained patch.");
    invariant(sha256Bytes(patch.stdout) === state.arms[arm].run.patch_sha256,
      "snapshot-drift", "Workspace no longer matches its recorded terminal patch.");
  } else assertVerifyAllowed(state, arm, context.manifest.qualification_only === true);
  state.arms[arm].verification = { attempted: true, started_at: new Date().toISOString(), active_pid: null,
    mode: snapshot ? "diagnostic-snapshot" : "measured", frozen_patch_sha256: state.arms[arm].run.patch_sha256 };
  await saveState(context.runtimeRoot, state);
  const verifier = join(context.runtimeRoot, "verifiers", arm);
  await cloneAtBase(context, verifier);
  const official = join(context.runtimeRoot, "official");
  for (const path of OFFICIAL_FILES) invariant(await sha256File(join(official, path)) ===
    context.manifest.official_sha256[path], "official-verifier-input",
  "A retained official verifier input differs from its byte pin.");
  const support = join(context.runtimeRoot, "verifier-support", arm);
  const logs = join(context.runtimeRoot, "verifier-logs", arm);
  const verifierOutput = join(logs, "verifier");
  const artifacts = join(context.runtimeRoot, "verifier-artifacts", arm);
  const goCache = join(context.runtimeRoot, "verifier-gocache", arm);
  const goPath = join(context.runtimeRoot, "verifier-gopath", arm);
  await mkdir(support, { recursive: true });
  await mkdir(verifierOutput, { recursive: true });
  await mkdir(artifacts, { recursive: true });
  await mkdir(goCache, { recursive: true });
  await mkdir(join(goPath, "bin"), { recursive: true });
  const privatePatch = join(context.runtimeRoot, "evidence", arm, "model.patch");
  const artifactPatch = join(artifacts, "model.patch");
  await cp(privatePatch, artifactPatch, { force: false, errorOnExist: true });
  invariant(await sha256File(artifactPatch) === state.arms[arm].run.patch_sha256, "artifact-patch",
    "Private model.patch changed while copied into verifier artifacts.");
  const verifierWsl = await toWslPath(context.manifest, verifier);
  const logsWsl = await toWslPath(context.manifest, logs);
  const originalScript = await readFile(join(official, "tests", "test.sh"));
  const localTests = join(support, "tests");
  await cp(join(official, "tests"), localTests, { recursive: true, force: false, errorOnExist: true });
  await writeFile(join(localTests, "config.json"), createLocalVerifierConfig(
    await readFile(join(official, "tests", "config.json")), logsWsl));
  const localTestsWsl = await toWslPath(context.manifest, localTests);
  const wrappedScript = createPathOnlyWrapper(originalScript, {
    "/app": verifierWsl, "/tests": localTestsWsl, "/logs": logsWsl,
  });
  const scriptPath = join(support, "test.sh");
  await writeFile(scriptPath, wrappedScript, { mode: 0o700 });
  const scriptWsl = await toWslPath(context.manifest, scriptPath);
  const goPathWsl = await toWslPath(context.manifest, goPath);
  await runWsl(context.manifest, verifierWsl, "/usr/bin/cp",
    [context.manifest.tools.goyacc.executable, `${goPathWsl}/bin/goyacc`], {}, { timeoutMs: 30_000 },
    "verifier-goyacc");
  await runWsl(context.manifest, verifierWsl, "/usr/bin/cp",
    [context.manifest.tools.go_ctrf_json_reporter.executable, `${goPathWsl}/bin/go-ctrf-json-reporter`], {},
    { timeoutMs: 30_000 }, "verifier-reporter");
  const environment = buildVerifierEnvironment(context.manifest, {
    tests: localTestsWsl,
    verifier: await toWslPath(context.manifest, verifierOutput),
    app: verifierWsl,
    artifacts: await toWslPath(context.manifest, artifacts),
    gocache: await toWslPath(context.manifest, goCache),
    gopath: goPathWsl,
  });
  const started = Date.now();
  const bash = context.manifest.tools.bash;
  const spec = wslSpec(context.manifest, verifierWsl, bash.executable, [...bash.args, scriptWsl], environment);
  const result = await execute(spec.executable, spec.args, { timeoutMs: DEFAULT_WALL_SECONDS * 1000,
    cwd: spec.cwd,
    heartbeat: `verify-arm:${arm}`,
    onSpawn: async (pid) => { state.arms[arm].verification.active_pid = pid ?? null;
      await saveState(context.runtimeRoot, state); } });
  state.arms[arm].verification.active_pid = null;
  const rewardPath = resolve(logs, "verifier", "reward.json");
  invariant(isInside(logs, rewardPath), "reward-path", "Reward file escaped verifier logs.");
  let resultJson = {};
  try { resultJson = JSON.parse(await readFile(rewardPath, "utf8")); } catch {}
  const reward = rewardEvidence(resultJson, context.manifest.verifier.result);
  await rm(logs, { recursive: true, force: true });
  state.arms[arm].verification = { ...state.arms[arm].verification, status: "complete", exit: result.code,
    signal: result.signal, timed_out: result.timedOut, duration_ms: Date.now() - started,
    stdout_sha256: sha256Bytes(result.stdout), stderr_sha256: sha256Bytes(result.stderr),
    reward: reward.reward, counts: reward.counts, environment_deviation:
      "Docker and Runta intentionally unused; official test.sh and config report paths were localized without changing verifier logic." };
  await saveState(context.runtimeRoot, state);
  return sanitizeForReport(state.arms[arm].verification, reportSecrets(context.manifest));
}

export async function summarize(context) {
  const state = await readState(context.runtimeRoot);
  if (state.stopped) {
    const report = sanitizeForReport({ schema_version: 1, task_id: TASK_ID, unofficial: true,
      methodology_comparable: false, leaderboard: false, public_publish: false,
      stopped: state.stopped, arms: Object.fromEntries(ARMS.map((arm) => {
        const candidate = state.arms?.[arm];
        const verification = candidate?.verification;
        return [arm, { ...(candidate?.run ?? { status: "not-run" }),
          task_correctness: verification?.status === "complete" && verification.exit === 0 &&
            !verification.timed_out && [0, 1].includes(verification.reward)
            ? verification.reward === 1 ? "PASS" : "FAIL" : "UNKNOWN",
          verification: verification ?? null }];
      })),
      comparison: { comparison_eligible: false, speed_ratio: null, cost_ratio: null, refusal: "expected-operation" } },
    reportSecrets(context.manifest));
    await atomicJson(join(context.runtimeRoot, REPORT_FILE), report);
    return report;
  }
  const reportArms = context.manifest.qualification_only ? ["sortie"] : ARMS;
  invariant(reportArms.every((arm) => state.arms?.[arm]?.verification?.status === "complete"), "summary-order",
    "Both one-shot verifiers must complete before summary.");
  const armSummary = Object.fromEntries(reportArms.map((arm) => [arm, {
    ...deliveryResult(state.arms[arm].run, state.arms[arm].verification),
    usage: state.arms[arm].run.usage ?? null,
    exit: state.arms[arm].run.exit, status: state.arms[arm].run.status,
    duration_ms: state.arms[arm].run.duration_ms, root_session_id: state.arms[arm].run.root_session_id,
    model: state.arms[arm].run.model, variant: state.arms[arm].run.variant,
    package: state.arms[arm].run.package, isolation: state.arms[arm].run.isolation,
    resolved_config_sha256: state.arms[arm].run.resolved_config_sha256,
    patch_sha256: state.arms[arm].run.patch_sha256,
    patch_bytes: state.arms[arm].run.patch_bytes, changed_paths: state.arms[arm].run.changed_paths,
    uncommitted_present: state.arms[arm].run.uncommitted_present,
    token_metric_references: state.arms[arm].run.token_metric_references, cost: state.arms[arm].run.cost,
    verifier_exit: state.arms[arm].verification.exit, reward: state.arms[arm].verification.reward,
    counts: state.arms[arm].verification.counts,
    verifier_duration_ms: state.arms[arm].verification.duration_ms,
  }]));
  const comparisonInput = Object.fromEntries(reportArms.map((arm) => [arm, {
    reward: armSummary[arm].outcome === "succeeded" ? armSummary[arm].reward : null, duration_ms: armSummary[arm].duration_ms,
    cost: state.arms[arm].run.cost,
  }]));
  const report = sanitizeForReport({ schema_version: 1, task_id: TASK_ID, unofficial: true,
    methodology_comparable: false, leaderboard: false, public_publish: false,
    docker: "intentionally_unused", runta: "intentionally_unused",
    qualification_only: context.manifest.qualification_only === true, arms: armSummary,
    comparison: context.manifest.qualification_only
      ? { comparison_eligible: false, speed_ratio: null, cost_ratio: null, refusal: "qualification-only" }
      : computeSummary(comparisonInput) }, reportSecrets(context.manifest));
  await atomicJson(join(context.runtimeRoot, REPORT_FILE), report);
  return report;
}

async function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function cleanup(context, confirmed) {
  invariant(confirmed, "cleanup-confirmation", "Cleanup requires --confirm after evidence collection.");
  const state = await readState(context.runtimeRoot);
  invariant(!ARMS.some((arm) => state.arms?.[arm]?.run?.operation_failure === "process-cleanup-unconfirmed"),
    "cleanup-process", "Linux process cleanup is unconfirmed; preserve the process group and diagnosis evidence.");
  invariant(await stat(join(context.runtimeRoot, REPORT_FILE)).catch(() => null), "cleanup-evidence",
    "Sanitized summary must exist before cleanup.");
  const pids = ARMS.flatMap((arm) => [state.arms?.[arm]?.active_pid,
    state.arms?.[arm]?.verification?.active_pid]).filter(Number.isInteger);
  for (const pid of pids) {
    if (await processExists(pid)) {
      const child = { pid, exitCode: null };
      await killTree(child);
    }
    invariant(!(await processExists(pid)), "cleanup-process", "An agent process remains after cleanup.");
  }
  for (const path of ["configs", "workspaces", "verifiers", "verifier-support", "verifier-artifacts", "verifier-gocache", "verifier-gopath"])
    await rm(join(context.runtimeRoot, path), { recursive: true, force: true });
  state.cleanup = { status: "complete", remaining_agent_processes: 0,
    removed: ["temporary OpenCode configs", "arm workspaces", "verifier workspaces", "test.sh wrapper copies",
      "verifier artifact copies", "verifier Go caches"],
    host_auth: "untouched" };
  await saveState(context.runtimeRoot, state);
  return state.cleanup;
}

function parseCli(argv) {
  const command = argv[0];
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--confirm") { options.confirm = true; continue; }
    invariant(key === "--manifest" || key === "--arm" || key === "--gate", "usage", "Unknown CLI option.");
    invariant(argv[index + 1] !== undefined, "usage", "CLI option value is missing.");
    options[key.slice(2)] = argv[++index];
  }
  invariant(["preflight", "prepare", "run-arm", "recapture-arm", "recover-stopped-snapshot", "replace-infrastructure-arm",
    "replace-infrastructure-verifier", "inspect-arm",
    "verify-arm", "verify-snapshot", "summarize", "cleanup"].includes(command) &&
    string(options.manifest), "usage", "Command and --manifest are required.");
  if (["run-arm", "recapture-arm", "recover-stopped-snapshot", "replace-infrastructure-arm", "replace-infrastructure-verifier",
    "inspect-arm", "verify-arm", "verify-snapshot"].includes(command)) invariant(ARMS.includes(options.arm), "usage",
    "--arm bare|sortie is required.");
  return { command, options };
}

export async function loadContext(manifestPath) {
  const absolute = resolve(manifestPath);
  const manifest = JSON.parse(await readFile(absolute, "utf8"));
  return validateManifest(manifest, absolute, process.cwd());
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseCli(argv);
  const context = await loadContext(options.manifest);
  let output;
  if (command === "preflight") output = await preflight(context);
  else if (command === "prepare") output = await prepare(context);
  else if (command === "run-arm") output = await runArm(context, options.arm);
  else if (command === "recapture-arm") output = await recaptureArm(context, options.arm);
  else if (command === "recover-stopped-snapshot") output = await recoverStoppedSnapshot(context, options.arm,
    options.confirm === true);
  else if (command === "replace-infrastructure-arm") output = await replaceInfrastructureArm(context,
    options.arm, options.gate, options.confirm === true);
  else if (command === "replace-infrastructure-verifier") output = await replaceInfrastructureVerifier(context,
    options.arm, options.gate, options.confirm === true);
  else if (command === "inspect-arm") output = await inspectArm(context, options.arm);
  else if (command === "verify-arm") output = await verifyArm(context, options.arm);
  else if (command === "verify-snapshot") output = await verifyArm(context, options.arm, true, options.confirm);
  else if (command === "summarize") output = await summarize(context);
  else output = await cleanup(context, options.confirm === true);
  process.stdout.write(`${JSON.stringify(sanitizeForReport({ status: "pass", phase: command, evidence: output },
    reportSecrets(context.manifest)))}\n`);
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/u,
  (match) => match.slice(1)));
if (invoked) main().catch((error) => {
  const gate = error instanceof HarnessFailure ? error.gate : "internal";
  process.stderr.write(`${JSON.stringify({ status: "fail", gate })}\n`);
  process.exitCode = 1;
});
