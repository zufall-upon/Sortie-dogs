#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { typedRefusalCode } from "../../../dist/core/refusal-codes.js";

const DEEPSWE_COMMIT = "435ee89ec2f2e2289f33b0da4f992f0b7b7266b9";
const ANKO_BASE = "3f269a72ff69398b1250c584171f32d12c0d8085";
const TASK_ID = "datacurve/anko-typed-variable-bindings";
const ARMS = ["bare", "sortie"];
const OFFICIAL_FILES = [
  "instruction.md", "task.toml", "tests/test.patch", "tests/config.json", "tests/grader.py", "tests/test.sh",
];
const OFFICIAL_REWARD_FIELDS = [
  "f2p_total", "f2p_passed", "p2p_total", "p2p_passed", "f2p", "p2p", "partial", "apply_failed",
];
const TOOL_NAMES = ["git", "node", "go", "goyacc", "go_ctrf_json_reporter", "python", "npm", "bash", "script"];
const STATE_FILE = "frontierharness-state.json";
const REPORT_FILE = "sanitized-summary.json";
const CANCEL_FILE = "frontierharness-cancel.json";
const OUTPUT_LIMIT = 64 * 1024 * 1024;
const DEFAULT_WALL_SECONDS = 5400;
const DEFAULT_STARTUP_SECONDS = 5400;
const DEFAULT_ACTIVITY_SECONDS = 5400;
const DEFAULT_PROGRESS_SECONDS = 5400;
const HEARTBEAT_SECONDS = 120;
const DEBUG_MAX_CYCLES = 12;
const DEBUG_CONTINUATION_PROMPT = "DEBUG continuation for the same accepted goal. First call sortie_v010_operator_status and follow its exact public next_action. If status is absent, no operator grant exists: continue the original goal from this exact --dir and use repository-relative tool paths; do not stop merely because there is no packet. Otherwise use only a packet-authorized contract repair, process-defect resume, acceptance-remediation replacement, or awaiting-acceptance review disposition. For operator-acceptance-remediation-required, do not call resume_operator or edit the committed candidate: cancel the failed run, then prepare an approved replacement for the same goal and exact acceptance, preserving approved write scope and cumulative budget. For awaiting-acceptance, do not stop after reporting status: dispatch the required independent reviewer in this turn, apply its disposition, and call complete_operator on PASS. Blocking findings within unchanged acceptance, approved write scope, and remaining budget require autonomous reason=review-blocking cancellation and same-goal replacement from the committed head without user approval. Copy the status packet's acceptance array verbatim into that replacement plan; do not summarize or rewrite it. Preserve the workspace and root session; do not infer a code solution from this instruction. Complete the original goal.";
const MEMORY_CAPTURE_EXIT_BOUNDED = 243;
const MEMORY_CAPTURE_PYTHON = String.raw`import os, subprocess, sys, time
limit = int(sys.argv[1])
command = sys.argv[2:]
stdout_fd = os.memfd_create("frontier-config-stdout", 0)
stderr_fd = os.memfd_create("frontier-config-stderr", 0)
try:
    child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=stdout_fd, stderr=stderr_fd)
    while child.poll() is None:
        if os.fstat(stdout_fd).st_size > limit or os.fstat(stderr_fd).st_size > limit:
            child.terminate()
            try:
                child.wait(timeout=1)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
            sys.exit(${MEMORY_CAPTURE_EXIT_BOUNDED})
        time.sleep(0.05)
    if os.fstat(stdout_fd).st_size > limit or os.fstat(stderr_fd).st_size > limit:
        sys.exit(${MEMORY_CAPTURE_EXIT_BOUNDED})
    for source, target in ((stdout_fd, 1), (stderr_fd, 2)):
        os.lseek(source, 0, os.SEEK_SET)
        while True:
            chunk = os.read(source, 1024 * 1024)
            if not chunk:
                break
            offset = 0
            while offset < len(chunk):
                offset += os.write(target, chunk[offset:])
    sys.exit(child.returncode if child.returncode >= 0 else 128 - child.returncode)
finally:
    os.close(stdout_fd)
    os.close(stderr_fd)`;
const RUNNER_PROFILES = Object.freeze({
  stable: Object.freeze({
    agent: "dog-coordinator", initArgs: [], runtimeModule: "runtime-assets.js",
    markerExport: "RUNTIME_ASSET_VERSION", implementationAgents: ["dog-worker", "dog-luna-worker"],
    requiredAssets: [], operatorRoutes: [{ model: "openai/gpt-5.6-sol", variant: "high" }],
  }),
  v010: Object.freeze({
    agent: "dog-operator", initArgs: ["--profile", "v010"], runtimeModule: "runtime-assets-v010.js",
    markerExport: "V010_RUNTIME_ASSET_VERSION", implementationAgents: ["dog-worker-v010"],
    requiredAssets: ["agent/dog-operator.md", "agent/dogs-coordinator.md", "agent/dog-worker-v010.md",
      "command/sortie-v010.md"],
    operatorRoutes: [{ model: "openai/gpt-5.6-sol", variant: "high" },
      { model: "openai/gpt-5.6-terra", variant: "xhigh" },
      { model: "openai/gpt-5.6-luna-fast", variant: "max" }],
  }),
});

class HarnessFailure extends Error {
  constructor(gate, message, nativeEvidence = null) {
    super(message);
    this.name = "HarnessFailure";
    this.gate = gate;
    this.nativeEvidence = nativeEvidence;
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

export function resolveRunnerProfile(name = "stable") {
  invariant(Object.hasOwn(RUNNER_PROFILES, name), "profile", "Runner profile must be stable or v010.");
  return RUNNER_PROFILES[name];
}

export function validateManifest(value, manifestPath, repositoryRoot = process.cwd()) {
  invariant(record(value), "manifest-shape", "Manifest must be one JSON object.");
  exactKeys(value, ["schema_version", "methodology_comparable", "leaderboard", "task_id", "pins", "paths",
    "official_sha256", "package", "source", "opencode", "tools", "verifier", "protocol",
    ...(value.profile === undefined ? [] : ["profile"]),
    ...(value.expected_operation === undefined ? [] : ["expected_operation"]),
    ...(value.qualification_only === undefined ? [] : ["qualification_only"])], "manifest-keys");
  invariant(value.qualification_only === undefined || value.qualification_only === true,
    "qualification-mode", "qualification_only may only explicitly enable treatment qualification.");
  const profile = value.profile ?? "stable";
  const resolvedProfile = resolveRunnerProfile(profile);
  invariant(profile !== "v010" || value.qualification_only === true, "qualification-mode",
    "The v010 profile is qualification-only and cannot start a Bare arm.");
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
  invariant(resolvedProfile.requiredAssets.every((asset) => value.package.required_assets.includes(asset)),
    "package-assets", "The package required_assets omit a profile-required runtime asset.");
  invariant(record(value.source) && string(value.source.repository) && value.source.base === ANKO_BASE,
    "source", "Source repository and approved base are required.");
  exactKeys(value.source, ["repository", "base"], "source-keys");
  const approvedOperatorRoute = resolvedProfile.operatorRoutes.some((route) =>
    value.opencode?.model === route.model && value.opencode?.variant === route.variant);
  invariant(record(value.opencode) && string(value.opencode.wsl_executable) && string(value.opencode.executable) &&
    string(value.opencode.version) && string(value.opencode.auth_file) &&
    (profile !== "v010" || safeWslPath(value.opencode.host_database)) &&
    approvedOperatorRoute,
  "opencode", "Pinned WSL OpenCode, auth presence path, and an approved profile operator route are required.");
  exactKeys(value.opencode, ["wsl_executable", "executable", "version", "auth_file", "model", "variant",
    ...(profile === "v010" ? ["host_database"] : [])],
    "opencode-keys");
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
  return { manifest: value, profile: resolvedProfile, manifestPath: resolve(manifestPath), repositoryRoot: resolve(repositoryRoot),
    runtimeRoot, officialRoot, packagePath };
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
  if (result.code !== 0) throw new HarnessFailure(gate,
    `A prerequisite command failed (exit ${result.code}, stderr ${sha256Bytes(result.stderr)}).`,
    nativeCommandEvidence(result));
  return result;
}

export function nativeCommandEvidence(result) {
  return { exit: Number.isInteger(result?.code) ? result.code : null, signal: result?.signal ?? null,
    timed_out: result?.timedOut === true, watchdog: result?.watchdog ?? null,
    stdout_sha256: Buffer.isBuffer(result?.stdout) ? sha256Bytes(result.stdout) : null,
    stderr_sha256: Buffer.isBuffer(result?.stderr) ? sha256Bytes(result.stderr) : null,
    ...(result?.processScope === "wsl" ? { process_scope: "wsl",
      cleanup_confirmation: result.cleanupConfirmation ?? "unconfirmed",
      process_group: Number.isInteger(result.processGroup) ? result.processGroup : null } : {}) };
}

export function anonymousMemoryCaptureArgs(executable, args, outputLimit = OUTPUT_LIMIT) {
  invariant(string(executable) && Array.isArray(args) && args.every((arg) => typeof arg === "string") &&
    Number.isSafeInteger(outputLimit) && outputLimit > 0, "memory-capture", "Anonymous capture arguments are invalid.");
  return ["-c", MEMORY_CAPTURE_PYTHON, String(outputLimit), executable, ...args];
}

export function resolvedConfigCommandArgs() {
  return ["debug", "config"];
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
  return await checkedWslSpec(spec, { ...options, cwd: spec.cwd ?? options.cwd }, gate);
}

async function checkedWslSpec(spec, options, gate) {
  try { return await checked(spec.executable, spec.args, options, gate); }
  catch (error) {
    if (error instanceof HarnessFailure && error.nativeEvidence !== null)
      error.nativeEvidence = { ...error.nativeEvidence, process_scope: "wsl" };
    throw error;
  }
}

async function toWslPath(manifest, path) {
  if (process.platform !== "win32") return resolve(path).split(sep).join("/");
  const spec = wslSpec(manifest, "/", "/usr/bin/wslpath", ["-a", resolve(path)]);
  const result = await checkedWslSpec(spec, { cwd: spec.cwd }, "wsl-path");
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

export function isolatedConfig(profileName = "stable") {
  return { $schema: "https://opencode.ai/config.json", ...(profileName === "v010" ? { subagent_depth: 2 } : {}),
    mcp: {}, plugin: [] };
}

export async function createConfigRoots(runtimeRoot, arm, profileName = "stable", opencodeVersion) {
  invariant(string(opencodeVersion), "config-loader-version",
    "The isolated OpenCode loader dependency requires the manifest-pinned OpenCode version.");
  const opencode = join(runtimeRoot, "configs", arm, "opencode");
  const xdg = join(runtimeRoot, "configs", arm, "xdg");
  const loader = join(xdg, "opencode");
  await mkdir(loader, { recursive: true });
  await mkdir(opencode, { recursive: true });
  await atomicJson(join(opencode, "opencode.json"), isolatedConfig(profileName));
  await atomicJson(join(loader, "opencode.json"), isolatedConfig(profileName));
  await atomicJson(join(loader, "package.json"), { private: true,
    dependencies: { "@opencode-ai/plugin": opencodeVersion } });
  return { opencode, xdg, loader };
}

export async function verifyConfigLoaderDependency(loaderRoot, expectedVersion) {
  invariant(string(expectedVersion), "config-loader-version", "The expected OpenCode loader version is invalid.");
  const declared = JSON.parse(await readFile(join(loaderRoot, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(loaderRoot, "package-lock.json"), "utf8"));
  const lockRoot = lock?.packages?.[""];
  const lockEntry = lock?.packages?.["node_modules/@opencode-ai/plugin"];
  const installedRoot = join(loaderRoot, "node_modules", "@opencode-ai", "plugin");
  const installedInfo = await lstat(installedRoot);
  const installed = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
  invariant(declared?.dependencies?.["@opencode-ai/plugin"] === expectedVersion &&
    lockRoot?.dependencies?.["@opencode-ai/plugin"] === expectedVersion &&
    lockEntry?.version === expectedVersion && lockEntry.link === undefined &&
    installed?.name === "@opencode-ai/plugin" && installed.version === expectedVersion &&
    !installedInfo.isSymbolicLink(), "config-loader-identity",
  "The isolated OpenCode loader dependency differs from the manifest pin or is linked.");
  return { package: "@opencode-ai/plugin", version: installed.version,
    installed_copy_symlink: false, package_lock_link: false };
}

async function installConfigLoaderDependency(context, arm, roots) {
  const loaderRoot = roots.loader ?? join(roots.xdg, "opencode");
  const loaderWsl = await toWslPath(context.manifest, loaderRoot);
  const groupFile = join(context.runtimeRoot, `${arm}-loader-install-process-group.pid`);
  const groupFileWsl = await toWslPath(context.manifest, groupFile);
  const npm = context.manifest.tools.npm;
  const spec = ownedWslSpec(context.manifest, loaderWsl, npm.executable,
    [...npm.args, "install", "--force"], {}, groupFileWsl);
  const result = await checkedOwnedWslSpec(context.manifest, spec, groupFile,
    { timeoutMs: 300_000 }, "config-loader-install");
  return { ...await verifyConfigLoaderDependency(loaderRoot, context.manifest.opencode.version),
    install: nativeCommandEvidence(result) };
}

export function pinnedWorkspaceRefCommands() {
  return [["update-ref", "refs/heads/main", ANKO_BASE]];
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
  for (const args of pinnedWorkspaceRefCommands()) await runTool(context.manifest.tools.git, args,
    { cwd: destination }, "materialize-pinned-main");
  await runTool(context.manifest.tools.git, ["reflog", "expire", "--expire=now", "--all"],
    { cwd: destination }, "expire-reflog");
  await runTool(context.manifest.tools.git, ["gc", "--prune=now"], { cwd: destination }, "prune-future-objects");
  const hooks = join(destination, ".git", "frontierharness-empty-hooks");
  await mkdir(hooks, { recursive: true });
  await runTool(context.manifest.tools.git, ["config", "core.hooksPath", ".git/frontierharness-empty-hooks"],
    { cwd: destination }, "disable-hooks");
  const head = (await runTool(context.manifest.tools.git, ["rev-parse", "HEAD"], { cwd: destination }, "head-pin"))
    .stdout.toString("utf8").trim();
  invariant(head === ANKO_BASE, "base-mismatch", "Fresh workspace HEAD differs from the approved Anko base.");
  const main = (await runTool(context.manifest.tools.git, ["rev-parse", "--verify", "refs/heads/main^{commit}"],
    { cwd: destination }, "main-pin")).stdout.toString("utf8").trim();
  invariant(main === ANKO_BASE, "main-base-mismatch", "Fresh workspace main differs from the approved Anko base.");
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

export async function inspectResolvedConfig(context, arm, workspace, roots, options = {}) {
  const cwd = await toWslPath(context.manifest, workspace);
  const environment = {
    ...pinnedGoEnvironment(context.manifest),
    OPENCODE_CONFIG_DIR: await toWslPath(context.manifest, roots.opencode),
    XDG_CONFIG_HOME: await toWslPath(context.manifest, roots.xdg),
    OPENCODE_EXE: context.manifest.opencode.executable,
  };
  const python = context.manifest.tools.python;
  const groupFile = join(context.runtimeRoot, `${arm}-resolved-config-process-group.pid`);
  const groupFileWsl = await toWslPath(context.manifest, groupFile);
  const spec = ownedWslSpec(context.manifest, cwd, python.executable,
    [...python.args, ...anonymousMemoryCaptureArgs(context.manifest.opencode.executable, resolvedConfigCommandArgs())],
    environment, groupFileWsl);
  const result = await checkedOwnedWslSpec(context.manifest, spec, groupFile,
    { timeoutMs: options.timeoutMs ?? 120_000 }, "resolved-config");
  const nativeEvidence = nativeCommandEvidence(result);
  let config;
  try { config = JSON.parse(completeJson(result.stdout.toString("utf8"))); }
  catch { throw new HarnessFailure("resolved-config-json",
    "OpenCode did not emit one resolved JSON configuration.", nativeEvidence); }
  const isolation = arm === "bare" ? await assertBareIsolation({ projectRoot: workspace,
    configRoots: [roots.opencode, roots.xdg], resolvedConfig: config }) : null;
  return { config, environment, isolation, nativeEvidence };
}

export async function inspectRunArmPreAgent(context, arm, workspace, roots, options = {}) {
  const inspected = await inspectResolvedConfig(context, arm, workspace, roots, options);
  if (arm === "sortie" && !(Array.isArray(inspected.config.plugin) && inspected.config.plugin.length === 1 &&
    typeof inspected.config.plugin[0] === "string" && forbiddenText(inspected.config.plugin[0])))
    throw new HarnessFailure("sortie-plugin-config",
      "Sortie resolved config is not the exact project-local plugin.", inspected.nativeEvidence);
  if (context.manifest.profile === "v010" && inspected.config.subagent_depth !== 2)
    throw new HarnessFailure("sortie-subagent-depth",
      "The v0.10 resolved config must pin subagent_depth to two.", inspected.nativeEvidence);
  return inspected;
}

export async function installSortie(context, workspace, roots, candidate = null) {
  const packageIdentity = candidate ?? { packagePath: context.packagePath, ...context.manifest.package };
  const control = join(workspace, ".opencode");
  if (candidate === null)
    await writeFile(join(workspace, ".git", "info", "exclude"), ".opencode/\n.sortie-dogs/\n", { flag: "a" });
  await mkdir(control, { recursive: true });
  const tgz = await toWslPath(context.manifest, packageIdentity.packagePath);
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
  const markerPattern = new RegExp(`(?:const|var)\\s+${context.profile.markerExport}\\s*=\\s*["']([^"']+)`, "u");
  const marker = markerPattern.exec(markerText)?.[1];
  invariant(installedPackage.version === packageIdentity.version &&
    marker === packageIdentity.runtime_marker, "sortie-identity",
  "Installed package version or runtime marker differs from the manifest.");
  const workspaceWsl = await toWslPath(context.manifest, workspace);
  await runWsl(context.manifest, workspaceWsl, context.manifest.tools.node.executable,
    [...context.manifest.tools.node.args, await toWslPath(context.manifest, join(installed, "dist", "cli", "main.js")),
      "init", workspaceWsl, ...context.profile.initArgs], {}, { timeoutMs: 120_000 }, "sortie-init");
  const plugin = `file://${await toWslPath(context.manifest, join(installed, "dist", "plugin", "opencode.js"))}`;
  if (candidate === null) {
    await atomicJson(join(control, "opencode.json"), { $schema: "https://opencode.ai/config.json", plugin: [plugin],
      ...(context.manifest.profile === "v010" ? { subagent_depth: 2 } : {}) });
    const neutral = { $schema: "https://opencode.ai/config.json", mcp: {},
      ...(context.manifest.profile === "v010" ? { subagent_depth: 2 } : {}) };
    await atomicJson(join(roots.opencode, "opencode.json"), neutral);
    await atomicJson(join(roots.xdg, "opencode", "opencode.json"), neutral);
  }
  const runtimeModule = await import(`${pathToFileURL(join(installed, "dist", context.profile.runtimeModule)).href}` +
    `?frontierharness=${packageIdentity.sha256}`);
  invariant(Array.isArray(runtimeModule.runtimeAssets) && runtimeModule.runtimeAssets.length > 0,
    "asset-export", "Installed package does not export canonical runtime assets.");
  const assets = {};
  for (const asset of runtimeModule.runtimeAssets) {
    invariant(record(asset) && string(asset.installPath) && typeof asset.content === "string" &&
      asset.version === packageIdentity.runtime_marker, "asset-export",
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
  if (candidate !== null) for (const [path, expected] of Object.entries(candidate.critical_dist_sha256)) {
    const target = resolve(installed, path);
    invariant(isInside(installed, target) && await sha256File(target).catch(() => null) === expected,
      "refresh-critical-dist", "Installed refreshed critical module differs from the candidate receipt.");
  }
  return { version: installedPackage.version, marker, package_sha256: packageIdentity.sha256,
    asset_count: Object.keys(assets).length, assets_sha256: sha256Bytes(JSON.stringify(assets)),
    ...(candidate === null ? {} : { modules_sha256: candidate.modules_sha256 }) };
}

async function loadRefreshCandidate(context, candidatePath) {
  const absolute = resolve(candidatePath);
  const refreshRoot = join(dirname(context.manifestPath), "refreshes");
  invariant(isInside(refreshRoot, absolute) && absolute !== refreshRoot, "refresh-candidate-path",
    "Refresh candidate receipt must be inside this debug run root.");
  const value = JSON.parse(await readFile(absolute, "utf8"));
  invariant(record(value) && value.schema_version === 1 && record(value.package) &&
    Object.keys(value).sort().join("\0") === "package\0schema_version" &&
    Object.keys(value.package).sort().join("\0") ===
      "critical_dist_sha256\0modules_sha256\0path\0runtime_marker\0sha256\0version" &&
    string(value.package.path) && !isAbsolute(value.package.path) && !value.package.path.split(/[\\/]/u).includes("..") &&
    /^[a-f0-9]{64}$/u.test(value.package.sha256 ?? "") && /^[a-f0-9]{64}$/u.test(value.package.modules_sha256 ?? "") &&
    string(value.package.version) && string(value.package.runtime_marker) && record(value.package.critical_dist_sha256),
  "refresh-candidate", "Refresh candidate receipt is invalid.");
  const hashes = value.package.critical_dist_sha256;
  invariant(Object.keys(hashes).length > 0 && Object.entries(hashes).every(([path, hash]) =>
    path.startsWith("dist/") && !path.split("/").includes("..") && /^[a-f0-9]{64}$/u.test(hash)),
  "refresh-candidate", "Refresh candidate critical module hashes are invalid.");
  invariant(sha256Bytes(JSON.stringify(hashes)) === value.package.modules_sha256,
    "refresh-candidate", "Refresh candidate module fingerprint differs from its hashes.");
  const packagePath = resolve(dirname(absolute), value.package.path);
  invariant(isInside(dirname(absolute), packagePath) && await sha256File(packagePath).catch(() => null) === value.package.sha256,
    "refresh-candidate-package", "Refresh candidate package is absent or differs from its receipt.");
  return { ...value.package, packagePath };
}

async function refreshWorkspaceSnapshot(context, workspace, roots) {
  const git = async args => (await runTool(context.manifest.tools.git, args, { cwd: workspace }, "refresh-preservation"))
    .stdout.toString("utf8");
  return {
    head: await git(["rev-parse", "HEAD"]), main: await git(["rev-parse", "refs/heads/main"]),
    status: await git(["status", "--porcelain=v1"]),
    project_config: await readFile(join(workspace, ".opencode", "opencode.json"), "utf8"),
    opencode_config: await readFile(join(roots.opencode, "opencode.json"), "utf8"),
    xdg_config: await readFile(join(roots.xdg, "opencode", "opencode.json"), "utf8"),
  };
}

export async function refreshSortiePackage(context, candidatePath, dependencies = {}) {
  const state = await readState(context.runtimeRoot);
  const arm = state.arms?.sortie;
  invariant(context.manifest.profile === "v010" && context.manifest.qualification_only === true &&
    state.preflight?.status === "pass" && state.prepared?.status === "pass" &&
    state.debug?.mode === "state-preserving" && ["recoverable", "paused"].includes(state.debug.status),
  "refresh-state", "Refresh requires one paused state-preserving v0.10 debug run.");
  invariant(arm?.active_pid === null && (arm.verification?.active_pid === undefined || arm.verification.active_pid === null),
    "refresh-active-process", "Refresh is refused while an arm or verifier process is active.");
  const candidate = await loadRefreshCandidate(context, candidatePath);
  const workspace = join(context.runtimeRoot, "workspaces", "sortie");
  const roots = { opencode: join(context.runtimeRoot, "configs", "sortie", "opencode"),
    xdg: join(context.runtimeRoot, "configs", "sortie", "xdg") };
  const snapshot = dependencies.snapshot ?? refreshWorkspaceSnapshot;
  const before = await snapshot(context, workspace, roots);
  const preserved = { executions: JSON.stringify(state.debug.executions), deadline_at: state.debug.deadline_at,
    root_session_id: arm.run?.root_session_id, stopped: JSON.stringify(state.stopped), main: before.main };
  const installed = await (dependencies.install ?? installSortie)(context, workspace, roots, candidate);
  const after = await snapshot(context, workspace, roots);
  invariant(JSON.stringify(after) === JSON.stringify(before), "refresh-preservation",
    "Refresh changed workspace source, refs, or existing OpenCode configuration.");
  const current = await readState(context.runtimeRoot);
  invariant(JSON.stringify(current.debug?.executions) === preserved.executions &&
    current.debug?.deadline_at === preserved.deadline_at && current.arms?.sortie?.run?.root_session_id === preserved.root_session_id &&
    JSON.stringify(current.stopped) === preserved.stopped, "refresh-state-changed",
  "Refresh changed the official attempt, wall, cycle, stop, or root session state.");
  const evidence = { package_sha256: candidate.sha256, modules_sha256: candidate.modules_sha256,
    version: candidate.version, runtime_marker: candidate.runtime_marker, installed };
  state.debug.refreshes = [...(state.debug.refreshes ?? []), evidence];
  state.debug.active_candidate_sha256 = candidate.sha256;
  await saveState(context.runtimeRoot, state);
  return evidence;
}

export function eventMetadata(stdout, profileName = "stable") {
  const profile = resolveRunnerProfile(profileName);
  let rootSessionId = null;
  const metricReferences = new Set();
  const usage = new Map();
  let eventErrors = 0;
  const refusals = new Map();
  const implementationChildren = new Set();
  let terminalOutcome = null;
  for (const line of stdout.toString("utf8").split(/\r?\n/u)) {
    let value;
    try { value = JSON.parse(line); } catch { continue; }
    if (!record(value)) continue;
    if (expectedOperationEvent(value) !== null) eventErrors += 1;
    const refusal = recoverableRefusalEvent(value);
    if (refusal !== null) refusals.set(refusal, (refusals.get(refusal) ?? 0) + 1);
    const session = value.sessionID ?? value.part?.sessionID;
    if (rootSessionId === null && typeof session === "string" && /^ses_[A-Za-z0-9_-]+$/u.test(session)) rootSessionId = session;
    const part = value.part;
    if (record(part) && part.type === "tool" && part.tool === "task" && part.state?.status === "completed" &&
      profile.implementationAgents.includes(part.state.input?.subagent_type)) {
      const nativeMetadata = part.state.metadata;
      const child = nativeMetadata?.sessionId ?? nativeMetadata?.sessionID;
      if (profileName === "stable") {
        const legacyChild = child ?? /<task\s+id="(ses_[A-Za-z0-9_-]+)"/u.exec(part.state.output ?? "")?.[1];
        if (session === rootSessionId && typeof legacyChild === "string" && /^ses_[A-Za-z0-9_-]+$/u.test(legacyChild) &&
          legacyChild !== rootSessionId) implementationChildren.add(legacyChild);
      }
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
    cost: costAvailable ? cost : null, event_errors: eventErrors,
    recoverable_refusals: [...refusals.values()].reduce((total, count) => total + count, 0),
    refusal_codes: [...refusals.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .slice(0, 16).map(([code, count]) => ({ code, count })),
    implementation_children: [...implementationChildren], terminal_outcome: terminalOutcome,
    usage: { coverage: "cli-stream-only", steps: usage.size, tokens: tokensAvailable ? totals : null,
      cost_provenance: costAvailable ? "host-reported-not-invoice" : "unavailable" },
    stdout_sha256: sha256Bytes(stdout) };
}

export function debugEventEvidence(stdout) {
  const evidence = [];
  for (const line of stdout.toString("utf8").split(/\r?\n/u)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const refusal = recoverableRefusalEvent(event);
    if (expectedOperationEvent(event) === null && refusal === null) continue;
    const tool = event?.part?.type === "tool" && typeof event.part.tool === "string" ? event.part.tool : null;
    const detail = event?.part?.state?.error ?? event?.error ?? event?.type ?? "agent-event-error";
    evidence.push({ kind: refusal !== null ? "refusal" : tool === null ? "event" : "tool", tool,
      ...(refusal === null ? {} : { refusal_code: refusal }),
      error_sha256: sha256Bytes(typeof detail === "string" ? detail : JSON.stringify(detail)) });
  }
  return evidence;
}

export function debugRecoveryPacket(stdout, rootSessionId) {
  let packet = null;
  for (const line of stdout.toString("utf8").split(/\r?\n/u)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const part = event?.part;
    const session = event?.sessionID ?? part?.sessionID;
    if (session !== rootSessionId || part?.type !== "tool" || part.tool !== "sortie_v010_operator_status" ||
        part.state?.status !== "completed" || typeof part.state.output !== "string") continue;
    let value;
    try { value = JSON.parse(part.state.output); } catch { continue; }
    const repair = value?.contract_repair;
    const contractRepair = value?.status === "awaiting-decision" && value?.decision === "operator-contract-repair-required" &&
      repair?.mode === "discard-transient" && /^sha256:[a-f0-9]{64}$/u.test(repair?.repair_fingerprint ?? "") &&
      Array.isArray(repair?.files) && repair.files.length > 0 && repair.files.every(file =>
        string(file?.path) && Number.isSafeInteger(file?.size) && file.size >= 0 && /^[a-f0-9]{64}$/u.test(file?.sha256 ?? ""));
    const processDefect = value?.status === "awaiting-decision" && value?.contract_repair === null &&
      value?.resume_requires_host_reconciliation === true && string(value?.run_id) &&
      /^sha256:[a-f0-9]{64}$/u.test(value?.acceptance_fingerprint ?? "") && Array.isArray(value?.units) &&
      value.units.some(unit => unit?.status === "failed" && unit?.result_class === "process-defect");
    const acceptanceRemediation = value?.status === "awaiting-decision" &&
      value?.decision === "operator-acceptance-remediation-required" &&
      value?.resume_requires_host_reconciliation === false && string(value?.next_action) &&
      /cancel_operator[\s\S]+prepare_operator/u.test(value.next_action) &&
      Array.isArray(value?.acceptance_remediation?.failed_criteria) &&
      value.acceptance_remediation.failed_criteria.length > 0 &&
      Array.isArray(value?.acceptance_remediation?.failed_evidence?.command);
    const awaitingAcceptance = value?.status === "awaiting-acceptance" &&
      value?.review_decision === "root-assess-independent-review" && string(value?.run_id) &&
      /^sha256:[a-f0-9]{64}$/u.test(value?.acceptance_fingerprint ?? "") && string(value?.next_action) &&
      /independent-review[\s\S]+complete_operator[\s\S]+review-blocking/u.test(value.next_action) &&
      Array.isArray(value?.units) && value.units.length > 0 && value.units.every(unit => unit?.status === "succeeded");
    if (contractRepair) packet = { route: "contract-repair", decision: value.decision,
      repair_fingerprint: repair.repair_fingerprint,
      files: repair.files.map(file => ({ path: file.path, size: file.size, sha256: file.sha256 })) };
    else if (processDefect) packet = { route: "process-defect-resume", decision: value.decision,
      run_id: value.run_id, acceptance_fingerprint: value.acceptance_fingerprint };
    else if (acceptanceRemediation) packet = { route: "acceptance-remediation", decision: value.decision };
    else if (awaitingAcceptance) packet = { route: "awaiting-acceptance-review", decision: value.review_decision,
      run_id: value.run_id, acceptance_fingerprint: value.acceptance_fingerprint };
  }
  return packet;
}

export function debugRecoveryFailure(recovery, gate) {
  return recovery === null && gate?.status !== "pass" ? "debug-public-recovery-unproven" : null;
}

export function debugResumeArgs(manifest, cwd, rootSessionId) {
  invariant(manifest?.profile === "v010" && manifest?.qualification_only === true && safeWslPath(cwd) &&
    /^ses_[A-Za-z0-9_-]+$/u.test(rootSessionId ?? ""), "debug-resume-identity",
  "Debug resume requires the v0.10 qualification profile, safe workspace, and exact root session identity.");
  return ["run", "--dir", cwd, "--format", "json", "--model", manifest.opencode.model,
    "--variant", manifest.opencode.variant, "--agent", "dog-operator", "--session", rootSessionId,
    DEBUG_CONTINUATION_PROMPT];
}

export function classifyNativeImplementationChildren(evidence, rootSessionId, workspace) {
  invariant(record(evidence) && Array.isArray(evidence.sessions) && Array.isArray(evidence.tasks) &&
    evidence.sessions.length <= 256 && evidence.tasks.length <= 512, "native-child-evidence", "Native host evidence is invalid or unbounded.");
  const sessions = new Map();
  for (const item of evidence.sessions) {
    invariant(record(item) && /^ses_[A-Za-z0-9_-]+$/u.test(item.id ?? "") &&
      (item.parent === null || /^ses_[A-Za-z0-9_-]+$/u.test(item.parent ?? "")) && item.directory === workspace,
    "native-child-evidence", "Native session identity is invalid or outside the fixture directory.");
    sessions.set(item.id, item.parent);
  }
  invariant(sessions.has(rootSessionId), "native-child-root", "The CLI root session is absent from the native fixture family.");
  const descendsFromRoot = (child) => {
    const seen = new Set([child]);
    let parent = sessions.get(child);
    for (let depth = 0; depth < 8 && typeof parent === "string" && !seen.has(parent); depth += 1) {
      if (parent === rootSessionId) return true;
      seen.add(parent);
      parent = sessions.get(parent);
    }
    return false;
  };
  const children = new Set();
  for (const task of evidence.tasks) {
    if (!record(task) || task.status !== "completed" || task.agent !== "dog-worker-v010" ||
        !sessions.has(task.caller) || !sessions.has(task.child) || sessions.get(task.child) !== task.caller ||
        !descendsFromRoot(task.child)) continue;
    children.add(task.child);
  }
  return [...children].sort();
}

const NATIVE_CHILD_QUERY = String.raw`import json,sqlite3,sys,urllib.parse
db,directory=sys.argv[1:3]
uri='file:'+urllib.parse.quote(db,safe='/')+'?mode=ro'
con=sqlite3.connect(uri,uri=True)
try:
 sessions=[{'id':r[0],'parent':r[1],'directory':r[2]} for r in con.execute('SELECT id,parent_id,directory FROM session WHERE directory=? ORDER BY time_created DESC LIMIT 256',(directory,))]
 ids={r['id'] for r in sessions}
 tasks=[]
 for caller,data in con.execute("SELECT m.session_id,p.data FROM part p JOIN message m ON m.id=p.message_id JOIN session s ON s.id=m.session_id WHERE s.directory=? AND json_extract(p.data,'$.type')='tool' AND json_extract(p.data,'$.tool')='task' AND json_extract(p.data,'$.state.status')='completed' ORDER BY p.time_created DESC LIMIT 512",(directory,)):
  if caller not in ids: continue
  value=json.loads(data); state=value.get('state') or {}; metadata=state.get('metadata') or {}; child=metadata.get('sessionId') or metadata.get('sessionID'); agent=(state.get('input') or {}).get('subagent_type')
  if isinstance(child,str): tasks.append({'caller':caller,'child':child,'agent':agent,'status':'completed'})
 print(json.dumps({'sessions':sessions,'tasks':tasks},separators=(',',':')))
finally: con.close()`;

export async function nativeImplementationChildren(context, rootSessionId, workspace) {
  invariant(context.manifest.profile === "v010" && safeWslPath(context.manifest.opencode.host_database),
    "native-child-config", "v0.10 native child evidence requires a declared WSL host database.");
  const workspaceWsl = await toWslPath(context.manifest, workspace);
  const result = await runWsl(context.manifest, "/", context.manifest.tools.python.executable,
    [...context.manifest.tools.python.args, "-c", NATIVE_CHILD_QUERY, context.manifest.opencode.host_database,
      workspaceWsl], {}, { timeoutMs: 30_000 }, "native-child-query");
  let evidence;
  try { evidence = JSON.parse(result.stdout.toString("utf8")); }
  catch { throw new HarnessFailure("native-child-evidence", "Native child evidence was not bounded JSON."); }
  return classifyNativeImplementationChildren(evidence, rootSessionId, workspaceWsl);
}

async function collectPatch(context, arm, workspace) {
  const patchResult = await runTool(context.manifest.tools.git,
    ["diff", "--binary", ANKO_BASE], { cwd: workspace }, "model-patch");
  const evidence = join(context.runtimeRoot, "evidence", arm);
  await mkdir(evidence, { recursive: true });
  const patchPath = join(evidence, "model.patch");
  await writeFile(patchPath, patchResult.stdout, { mode: 0o600 });
  const changedResult = await runTool(context.manifest.tools.git,
    ["diff", "--name-only", ANKO_BASE], { cwd: workspace }, "changed-paths");
  const changedPaths = changedResult.stdout.toString("utf8").split(/\r?\n/u).filter(Boolean).sort();
  const statusResult = await execute(context.manifest.tools.git.executable,
    commandArgs(context.manifest.tools.git, ["status", "--porcelain=v1"]), { cwd: workspace });
  invariant(statusResult.code === 0, "worktree-status", "Unable to classify post-run worktree status.");
  return { patchPath, patch_sha256: sha256Bytes(patchResult.stdout), patch_bytes: patchResult.stdout.length,
    changed_paths: changedPaths, uncommitted_present: statusResult.stdout.length > 0,
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

export function expectedOperation(run, arm, expected = {
  min_patch_bytes: 1, min_implementation_children: arm === "sortie" ? 1 : 0,
  terminal_outcome: arm === "sortie" ? "DONE" : null,
}) {
  const reason = run.operation_failure ?? (run.exit !== 0 || run.timed_out ? "agent-process-failed" :
    run.event_errors > 0 ? "agent-event-error" :
    !run.root_session_id ? "session-identity-missing" :
    !(run.patch_bytes >= expected.min_patch_bytes) ? "no-delivered-patch" :
    (run.implementation_children?.length ?? 0) < expected.min_implementation_children ? "implementation-child-missing" :
    expected.terminal_outcome !== null && run.terminal_outcome !== expected.terminal_outcome ? "delivery-not-complete" : null);
  return { status: reason === null ? "pass" : "fail", reason };
}

export function recoverableRefusalEvent(event) {
  if (!(event?.part?.type === "tool" && event.part.state?.status === "error")) return null;
  return typedRefusalCode(event.part.state.error);
}

export function expectedOperationEvent(event) {
  const exploratoryMiss = event?.part?.type === "tool" && event.part.state?.status === "error" &&
    event.part.tool === "read" && typeof event.part.state.error === "string" &&
    (/^File not found: /u.test(event.part.state.error) ||
      /^Offset \d+ is out of range for this file \(\d+ lines\)$/u.test(event.part.state.error));
  // A typed refusal states an unsupported request the agent can correct in its next step. It is recorded
  // as a refusal rather than an operation failure; only unexplained errors end the run.
  const refusal = recoverableRefusalEvent(event) !== null;
  return event?.type === "error" || (event?.part?.type === "tool" && event.part.state?.status === "error" &&
    !exploratoryMiss && !refusal) ? "agent-event-error" : null;
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
  const official = await copyOfficial(context);
  const officialWsl = await toWslPath(context.manifest, official);
  const workspaces = {};
  const configs = {};
  const loaderDependencies = {};
  for (const arm of context.manifest.qualification_only ? ["sortie"] : ARMS) {
    workspaces[arm] = join(context.runtimeRoot, "workspaces", arm);
    await cloneAtBase(context, workspaces[arm]);
    await runWsl(context.manifest, await toWslPath(context.manifest, workspaces[arm]),
      context.manifest.tools.go.executable, ["mod", "download"], goEnvironment,
      { timeoutMs: 600_000 }, "prepare-go-mod-download");
    const preparedStatus = await runTool(context.manifest.tools.git, ["status", "--porcelain=v1"],
      { cwd: workspaces[arm] }, "prepare-cleanliness");
    invariant(preparedStatus.stdout.length === 0, "prepare-dirty", "Dependency preparation changed the arm workspace.");
    configs[arm] = await createConfigRoots(context.runtimeRoot, arm, context.manifest.profile ?? "stable",
      context.manifest.opencode.version);
    loaderDependencies[arm] = await installConfigLoaderDependency(context, arm, configs[arm]);
  }
  const count = context.manifest.qualification_only ? 1 : 2;
  state.prepared = { status: "pass", base: ANKO_BASE, official_sha256: state.preflight.official_sha256,
    official_wsl_sha256: sha256Bytes(officialWsl), workspace_count: count, isolated_config_count: count,
    isolated_loader_count: count, loader_dependencies: loaderDependencies };
  await saveState(context.runtimeRoot, state);
  return state.prepared;
}

export async function stopWslGroup(manifest, groupFile) {
  const pid = (await readFile(groupFile, "utf8")).trim();
  invariant(/^[1-9][0-9]*$/u.test(pid), "process-group", "Owned WSL process group identity is invalid.");
  await runWsl(manifest, "/", "/usr/bin/bash", ["-c",
    'kill -TERM -- "-$1" 2>/dev/null || true; sleep 0.5; kill -KILL -- "-$1" 2>/dev/null || true; sleep 0.2; ! kill -0 -- "-$1" 2>/dev/null',
    "frontier-stop", pid], {}, { timeoutMs: 30_000 }, "process-group-stop");
  return Number(pid);
}

async function waitForActiveAttempt(context, arm, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const state = await readState(context.runtimeRoot);
    const attempted = state.arms?.[arm];
    const verification = attempted?.verification;
    if (verification?.attempted === true && verification.status === undefined &&
      Number.isInteger(verification.active_pid)) return { state, phase: "verify-arm" };
    if (attempted?.attempted === true && attempted.run === undefined &&
      Number.isInteger(attempted.active_pid)) return { state, phase: "run-arm" };
    await new Promise(done => setTimeout(done, 50));
  } while (Date.now() < deadline);
  throw new HarnessFailure("cancel-active", "No active owned attempt became available for cancellation.");
}

async function waitForGroupFile(path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await stat(path).catch(() => null)) return;
    await new Promise(done => setTimeout(done, 50));
  } while (Date.now() < deadline);
  throw new HarnessFailure("cancel-process-group", "Owned WSL process group identity was not recorded.");
}

async function cancellationRequest(context, arm, phase) {
  const request = await readFile(join(context.runtimeRoot, CANCEL_FILE), "utf8").then(JSON.parse).catch(() => null);
  return request?.arm === arm && request.phase === phase ? request : null;
}

export async function cancelActive(context, arm, confirmed, signal = "SIGINT", options = {}) {
  invariant(confirmed, "cancel-confirmation", "Cancellation requires --confirm.");
  invariant(ARMS.includes(arm) && ["SIGINT", "SIGTERM"].includes(signal), "cancel-usage",
    "Cancellation requires an arm and SIGINT or SIGTERM.");
  const active = await (options.waitForActive?.(context, arm) ?? waitForActiveAttempt(context, arm));
  const groupFile = join(context.runtimeRoot, active.phase === "verify-arm"
    ? `${arm}-verifier-process-group.pid` : `${arm}-process-group.pid`);
  await (options.waitForGroupFile?.(groupFile) ?? waitForGroupFile(groupFile));
  const request = { arm, phase: active.phase, signal, requested_at: new Date().toISOString() };
  await atomicJson(join(context.runtimeRoot, CANCEL_FILE), request);
  let processGroup;
  try { processGroup = await (options.stopGroup?.(context.manifest, groupFile) ?? stopWslGroup(context.manifest, groupFile)); }
  catch { throw new HarnessFailure("cancel-process-group", "Owned WSL process group cancellation was not confirmed.",
    { process_scope: "wsl", cleanup_confirmation: "unconfirmed" }); }
  const state = await readState(context.runtimeRoot);
  const exit = signal === "SIGINT" ? 130 : 143;
  state.stopped = { arm, reason: "cancelled", gate: signal, at: request.requested_at };
  if (active.phase === "run-arm") {
    state.arms[arm].active_pid = null;
    state.arms[arm].run = { status: "cancelled", attempt: 1, retry: 0, exit, signal,
      timed_out: false, operation_failure: "cancelled", process_scope: "wsl", process_group: processGroup,
      cleanup_confirmation: "confirmed", expected_operation: { status: "fail", reason: "cancelled" } };
  } else {
    state.arms[arm].verification = { ...state.arms[arm].verification, active_pid: null, status: "cancelled",
      exit, signal, timed_out: false, reward: null, process_scope: "wsl", process_group: processGroup,
      cleanup_confirmation: "confirmed" };
  }
  await saveState(context.runtimeRoot, state);
  await summarize(context);
  return { status: "cancelled", arm, phase: active.phase, signal, process_group: processGroup,
    cleanup_confirmation: "confirmed" };
}

export function ownedWslSpec(manifest, cwd, executable, args, environment, groupFileWsl) {
  // A Windows taskkill of wsl.exe alone does not prove its Linux descendants stopped.
  return wslSpec(manifest, cwd, "/usr/bin/setsid", ["--wait", "/usr/bin/bash", "-c",
    'printf "%s\\n" "$$" > "$1"; shift; exec "$@"', "frontier-group", groupFileWsl,
    executable, ...args], environment);
}

async function checkedOwnedWslSpec(manifest, spec, groupFile, options, gate) {
  const stopTree = () => stopWslGroup(manifest, groupFile);
  let result;
  try {
    result = await execute(spec.executable, spec.args, { ...options, cwd: spec.cwd, stopTree });
  } catch (error) {
    try {
      const processGroup = await stopTree();
      if (error instanceof HarnessFailure) error.nativeEvidence = { ...(error.nativeEvidence ?? {}),
        process_scope: "wsl", cleanup_confirmation: "confirmed", process_group: processGroup };
    }
    catch { throw new HarnessFailure(gate, "Owned WSL process cleanup could not be confirmed.",
      { process_scope: "wsl", cleanup_confirmation: "unconfirmed" }); }
    throw error;
  }
  try {
    result.processGroup = await stopTree();
    result.processScope = "wsl";
    result.cleanupConfirmation = "confirmed";
    if (result.operationFailure === "process-cleanup-unconfirmed") result.operationFailure = null;
  } catch {
    result.processScope = "wsl";
    result.cleanupConfirmation = "unconfirmed";
    result.operationFailure = "process-cleanup-unconfirmed";
  }
  const evidence = nativeCommandEvidence(result);
  if (result.code === MEMORY_CAPTURE_EXIT_BOUNDED)
    throw new HarnessFailure("bounded-output", "Anonymous config capture exceeded bounded output.", evidence);
  if (result.code !== 0 || result.cleanupConfirmation !== "confirmed")
    throw new HarnessFailure(gate, `A prerequisite command failed (exit ${result.code}, stderr ${sha256Bytes(result.stderr)}).`, evidence);
  return result;
}

export async function recordPreAgentFailure(context, state, arm, gate, nativeEvidence = null,
  packageEvidence = null) {
  const evidence = nativeEvidence ?? {};
  const cleanupUnconfirmed = evidence.process_scope === "wsl" &&
    (evidence.cleanup_confirmation === "unconfirmed" ||
      (evidence.timed_out === true && evidence.cleanup_confirmation !== "confirmed"));
  state.arms[arm].active_pid = null;
  state.arms[arm].run = { status: "pre-agent-failure", attempt: 1, retry: 0,
    exit: evidence.exit ?? null, signal: evidence.signal ?? null, timed_out: evidence.timed_out === true,
    watchdog: evidence.watchdog ?? null,
    operation_failure: cleanupUnconfirmed ? "process-cleanup-unconfirmed" : "pre-agent-failure",
    process_scope: evidence.process_scope ?? null,
    process_group: evidence.process_group ?? null,
    cleanup_confirmation: cleanupUnconfirmed ? "unconfirmed" : evidence.cleanup_confirmation ?? "not-required", failure_gate: gate,
    stdout_sha256: evidence.stdout_sha256 ?? null, stderr_sha256: evidence.stderr_sha256 ?? null,
    package: packageEvidence, expected_operation: { status: "fail", reason: "pre-agent-failure" } };
  state.stopped = { arm, reason: "pre-agent-failure", gate, at: new Date().toISOString() };
  await saveState(context.runtimeRoot, state);
  return await summarize(context);
}

async function runArm(context, arm, debug = false) {
  const state = await readState(context.runtimeRoot);
  assertRunArmAllowed(state, arm, context.manifest.qualification_only === true);
  invariant(!debug || (arm === "sortie" && context.manifest.profile === "v010" &&
    context.manifest.qualification_only === true), "debug-mode", "Debug mode is limited to the v0.10 Sortie qualification arm.");
  if (debug) state.debug = { schema_version: 1, mode: "state-preserving", quality_gate: false,
    methodology_comparable: false, max_cycles: DEBUG_MAX_CYCLES, started_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + context.manifest.protocol.wall_seconds * 1000).toISOString(),
    status: "running", executions: [] };
  state.arms[arm] = { attempted: true, started_at: new Date().toISOString(), active_pid: null };
  await saveState(context.runtimeRoot, state);
  const workspace = join(context.runtimeRoot, "workspaces", arm);
  const roots = { opencode: join(context.runtimeRoot, "configs", arm, "opencode"),
    xdg: join(context.runtimeRoot, "configs", arm, "xdg") };
  let packageEvidence = null;
  let inspected;
  let instruction;
  let preRunStatus;
  let cwd;
  let args;
  let groupFile;
  let stopGroup;
  let spec;
  try {
    if (arm === "sortie") packageEvidence = await installSortie(context, workspace, roots);
    inspected = await inspectRunArmPreAgent(context, arm, workspace, roots);
    instruction = await readFile(join(context.runtimeRoot, "official", "instruction.md"), "utf8");
    preRunStatus = await runTool(context.manifest.tools.git, ["status", "--porcelain=v1"],
      { cwd: workspace }, "pre-run-cleanliness");
    if (preRunStatus.stdout.length !== 0) throw new HarnessFailure("pre-run-dirty",
      "Arm workspace is dirty before the timed run.", nativeCommandEvidence(preRunStatus));
    cwd = await toWslPath(context.manifest, workspace);
    args = ["run", "--dir", cwd, "--format", "json", "--model", context.manifest.opencode.model,
      "--variant", context.manifest.opencode.variant, "--agent", arm === "sortie" ? context.profile.agent : "build", instruction];
    groupFile = join(context.runtimeRoot, `${arm}-process-group.pid`);
    const groupFileWsl = await toWslPath(context.manifest, groupFile);
    stopGroup = () => stopWslGroup(context.manifest, groupFile);
    spec = ownedWslSpec(context.manifest, cwd, context.manifest.opencode.executable, args,
      inspected.environment, groupFileWsl);
  } catch (error) {
    const gate = error instanceof HarnessFailure ? error.gate : "pre-agent-internal";
    const nativeEvidence = error instanceof HarnessFailure ? error.nativeEvidence : null;
    if (debug) state.debug.status = "paused";
    await recordPreAgentFailure(context, state, arm, gate, nativeEvidence, packageEvidence);
    throw error;
  }
  const started = Date.now();
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
  try {
    result.processGroup = await stopGroup();
    result.processScope = "wsl";
    result.cleanupConfirmation = "confirmed";
  } catch {
    result.processScope = "wsl";
    result.cleanupConfirmation = "unconfirmed";
    result.operationFailure = "process-cleanup-unconfirmed";
  }
  const cancellation = await cancellationRequest(context, arm, "run-arm");
  if (cancellation) result.operationFailure = "cancelled";
  state.arms[arm].active_pid = null;
  const patch = await collectPatch(context, arm, workspace).catch(() => {
    result.operationFailure ??= "patch-capture-unavailable";
    return { patch_sha256: null, patch_bytes: null, changed_paths: null, uncommitted_present: null, status_sha256: null };
  });
  const metadata = eventMetadata(result.stdout, context.manifest.profile ?? "stable");
  if (context.manifest.profile === "v010" && metadata.root_session_id !== null) {
    try { metadata.implementation_children = await nativeImplementationChildren(context, metadata.root_session_id, workspace); }
    catch { result.operationFailure ??= "native-child-evidence-unavailable"; metadata.implementation_children = []; }
  }
  state.arms[arm].run = { status: "complete", exit: result.code, signal: result.signal, timed_out: result.timedOut,
    watchdog: result.watchdog,
    operation_failure: result.operationFailure ?? null,
    process_scope: result.processScope, process_group: result.processGroup ?? null,
    cleanup_confirmation: result.cleanupConfirmation,
    event_errors: metadata.event_errors, recoverable_refusals: metadata.recoverable_refusals,
    refusal_codes: metadata.refusal_codes, usage: metadata.usage,
    implementation_children: metadata.implementation_children, terminal_outcome: metadata.terminal_outcome,
    duration_ms: Date.now() - started, root_session_id: metadata.root_session_id,
    token_metric_references: metadata.token_metric_references, cost: metadata.cost, stdout_sha256: metadata.stdout_sha256,
    stderr_sha256: sha256Bytes(result.stderr), model: context.manifest.opencode.model,
    variant: context.manifest.opencode.variant, package: packageEvidence,
    isolation: inspected.isolation, resolved_config_sha256: sha256Bytes(JSON.stringify(inspected.config)),
    patch_sha256: patch.patch_sha256,
    patch_bytes: patch.patch_bytes, changed_paths: patch.changed_paths, uncommitted_present: patch.uncommitted_present,
    status_sha256: patch.status_sha256 };
  if (debug) {
    const errors = debugEventEvidence(result.stdout);
    const recovery = metadata.root_session_id === null ? null : debugRecoveryPacket(result.stdout, metadata.root_session_id);
    state.debug.executions.push({ cycle: 1, command: "run-arm", exit: result.code, signal: result.signal,
      timed_out: result.timedOut, watchdog: result.watchdog, operation_failure: result.operationFailure ?? null,
      event_errors: metadata.event_errors, recoverable_refusals: metadata.recoverable_refusals,
      refusal_codes: metadata.refusal_codes, errors, duration_ms: state.arms[arm].run.duration_ms,
      root_session_id: metadata.root_session_id, stdout_sha256: metadata.stdout_sha256,
      stderr_sha256: state.arms[arm].run.stderr_sha256, cleanup_confirmation: result.cleanupConfirmation,
      usage: metadata.usage, cost: metadata.cost, token_metric_references: metadata.token_metric_references, recovery });
  }
  const gate = expectedOperation(state.arms[arm].run, arm, context.manifest.expected_operation?.[arm]);
  state.arms[arm].run.expected_operation = gate;
  if (debug) state.debug.status = gate.status === "pass" ? "completed" :
    metadata.root_session_id !== null && state.debug.executions[0].recovery !== null &&
      (gate.reason === "delivery-not-complete" && state.debug.executions[0].recovery.route === "awaiting-acceptance-review" ||
       gate.reason === "agent-event-error" && (state.debug.executions[0].recovery.route === "acceptance-remediation" ||
         state.debug.executions[0].errors.some(item => item.kind !== "refusal") &&
         state.debug.executions[0].errors.every(item => item.kind === "refusal" || item.tool === "task")))
      ? "recoverable" : "paused";
  if (gate.status === "fail") state.stopped = { arm, reason: gate.reason,
    ...(cancellation ? { gate: cancellation.signal } : {}), at: new Date().toISOString() };
  await saveState(context.runtimeRoot, state);
  if (state.stopped) {
    await summarize(context);
    // Keep candidate workspaces for diagnosis; cleanup remains an explicit operation.
    throw new HarnessFailure("expected-operation", "Normal operation failed; partial summary saved. Stop and diagnose.");
  }
  return sanitizeForReport(state.arms[arm].run, reportSecrets(context.manifest));
}

async function resumeArm(context, arm) {
  const state = await readState(context.runtimeRoot);
  invariant(arm === "sortie" && context.manifest.profile === "v010" && context.manifest.qualification_only === true &&
    state.debug?.mode === "state-preserving" && ["recoverable", "paused"].includes(state.debug.status) &&
    state.stopped?.arm === arm && ["agent-event-error", "debug-unknown-agent-event-error",
      "debug-public-recovery-unproven", "delivery-not-complete"].includes(state.arms?.[arm]?.run?.expected_operation?.reason),
  "debug-resume-state", "No state-preserving debug arm is available to resume.");
  invariant(state.arms[arm].active_pid === null &&
    (state.arms[arm].verification?.active_pid === undefined || state.arms[arm].verification.active_pid === null),
  "debug-resume-active-process", "Debug continuation is refused while an arm or verifier process is active.");
  invariant(state.debug.executions.length < state.debug.max_cycles, "debug-cycle-cap", "Debug continuation cycle cap reached.");
  const remainingMs = Date.parse(state.debug.deadline_at) - Date.now();
  invariant(Number.isFinite(remainingMs) && remainingMs > 0, "debug-wall-cap", "Debug continuation wall cap reached.");
  const workspace = join(context.runtimeRoot, "workspaces", arm);
  invariant((await stat(workspace).catch(() => null))?.isDirectory(), "debug-resume-workspace",
    "Debug continuation requires the preserved arm workspace.");
  const roots = { opencode: join(context.runtimeRoot, "configs", arm, "opencode"),
    xdg: join(context.runtimeRoot, "configs", arm, "xdg") };
  const inspected = await inspectRunArmPreAgent(context, arm, workspace, roots);
  const cwd = await toWslPath(context.manifest, workspace);
  const rootSessionId = state.arms[arm].run.root_session_id;
  const args = debugResumeArgs(context.manifest, cwd, rootSessionId);
  const groupFile = join(context.runtimeRoot, `${arm}-process-group.pid`);
  const groupFileWsl = await toWslPath(context.manifest, groupFile);
  const stopGroup = () => stopWslGroup(context.manifest, groupFile);
  const preStatus = await runTool(context.manifest.tools.git, ["status", "--porcelain=v1"],
    { cwd: workspace }, "debug-pre-resume-status");
  const started = Date.now();
  const spec = ownedWslSpec(context.manifest, cwd, context.manifest.opencode.executable, args,
    inspected.environment, groupFileWsl);
  const result = await execute(spec.executable, spec.args, { timeoutMs: remainingMs, cwd: spec.cwd,
    heartbeat: `resume-arm:${arm}`, eventGate: expectedOperationEvent, stopTree: stopGroup,
    initialProgressValue: sha256Bytes(preStatus.stdout),
    progressProbe: async () => sha256Bytes((await runTool(context.manifest.tools.git,
      ["status", "--porcelain=v1"], { cwd: workspace }, "watchdog-progress")).stdout),
    watchdog: { wall_ms: remainingMs, startup_ms: Math.min(context.manifest.protocol.startup_seconds * 1000, remainingMs),
      activity_ms: Math.min(context.manifest.protocol.activity_seconds * 1000, remainingMs),
      progress_ms: Math.min(context.manifest.protocol.progress_seconds * 1000, remainingMs) },
    onSpawn: async pid => { state.arms[arm].active_pid = pid ?? null; await saveState(context.runtimeRoot, state); } });
  try { result.processGroup = await stopGroup(); result.processScope = "wsl"; result.cleanupConfirmation = "confirmed"; }
  catch { result.processScope = "wsl"; result.cleanupConfirmation = "unconfirmed";
    result.operationFailure = "process-cleanup-unconfirmed"; }
  state.arms[arm].active_pid = null;
  const metadata = eventMetadata(result.stdout, context.manifest.profile);
  const errors = debugEventEvidence(result.stdout);
  const recovery = debugRecoveryPacket(result.stdout, rootSessionId);
  if (metadata.root_session_id !== rootSessionId) result.operationFailure = "debug-root-session-mismatch";
  if (errors.some(item => item.kind !== "refusal" && item.tool !== "task") && recovery?.route !== "acceptance-remediation") {
    result.operationFailure = "debug-unknown-agent-event-error";
  }
  if (metadata.root_session_id === rootSessionId) {
    try { metadata.implementation_children = await nativeImplementationChildren(context, rootSessionId, workspace); }
    catch { result.operationFailure ??= "native-child-evidence-unavailable"; metadata.implementation_children = []; }
  }
  const patch = await collectPatch(context, arm, workspace).catch(() => {
    result.operationFailure ??= "patch-capture-unavailable";
    return { patch_sha256: null, patch_bytes: null, changed_paths: null, uncommitted_present: null, status_sha256: null };
  });
  result.operationFailure ??= debugRecoveryFailure(recovery, expectedOperation({
    exit: result.code, timed_out: result.timedOut, operation_failure: result.operationFailure ?? null,
    event_errors: metadata.event_errors, root_session_id: rootSessionId, patch_bytes: patch.patch_bytes,
    implementation_children: metadata.implementation_children, terminal_outcome: metadata.terminal_outcome,
  }, arm, context.manifest.expected_operation?.[arm]));
  const durationMs = Date.now() - started;
  state.debug.executions.push({ cycle: state.debug.executions.length + 1, command: "resume-arm", exit: result.code,
    signal: result.signal, timed_out: result.timedOut, watchdog: result.watchdog,
    operation_failure: result.operationFailure ?? null, event_errors: metadata.event_errors,
    recoverable_refusals: metadata.recoverable_refusals, refusal_codes: metadata.refusal_codes, errors,
    duration_ms: durationMs, root_session_id: metadata.root_session_id, stdout_sha256: metadata.stdout_sha256,
    stderr_sha256: sha256Bytes(result.stderr), cleanup_confirmation: result.cleanupConfirmation, recovery,
    usage: metadata.usage, cost: metadata.cost, token_metric_references: metadata.token_metric_references,
    ...(state.debug.active_candidate_sha256 ? { candidate_sha256: state.debug.active_candidate_sha256 } : {}) });
  Object.assign(state.arms[arm].run, { status: "complete", exit: result.code, signal: result.signal,
    timed_out: result.timedOut, watchdog: result.watchdog, operation_failure: result.operationFailure ?? null,
    process_scope: result.processScope, process_group: result.processGroup ?? null,
    cleanup_confirmation: result.cleanupConfirmation, event_errors: metadata.event_errors,
    recoverable_refusals: metadata.recoverable_refusals, refusal_codes: metadata.refusal_codes, usage: metadata.usage,
    implementation_children: metadata.implementation_children, terminal_outcome: metadata.terminal_outcome,
    duration_ms: Date.now() - Date.parse(state.debug.started_at), root_session_id: rootSessionId,
    token_metric_references: metadata.token_metric_references, cost: metadata.cost,
    stdout_sha256: metadata.stdout_sha256, stderr_sha256: sha256Bytes(result.stderr),
    isolation: inspected.isolation, resolved_config_sha256: sha256Bytes(JSON.stringify(inspected.config)),
    patch_sha256: patch.patch_sha256, patch_bytes: patch.patch_bytes, changed_paths: patch.changed_paths,
    uncommitted_present: patch.uncommitted_present, status_sha256: patch.status_sha256 });
  const gate = expectedOperation(state.arms[arm].run, arm, context.manifest.expected_operation?.[arm]);
  state.arms[arm].run.expected_operation = gate;
  if (gate.status === "pass") { delete state.stopped; state.debug.status = "completed"; }
  else {
    state.stopped = { arm, reason: gate.reason, ...(result.operationFailure ? { gate: result.operationFailure } : {}),
      at: new Date().toISOString() };
    state.debug.status = recovery !== null &&
      (gate.reason === "delivery-not-complete" && recovery.route === "awaiting-acceptance-review" ||
       gate.reason === "agent-event-error" &&
        (recovery.route === "acceptance-remediation" || errors.length > 0 && errors.every(item => item.tool === "task"))) &&
      state.debug.executions.length < state.debug.max_cycles &&
      Date.now() < Date.parse(state.debug.deadline_at) ? "recoverable" : "paused";
  }
  await saveState(context.runtimeRoot, state);
  if (state.stopped) { await summarize(context); throw new HarnessFailure("debug-paused", "Debug continuation did not complete; state preserved."); }
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
  invariant(attempted?.attempted === true && attempted.run === undefined && attempted.active_pid === null,
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

async function verifyArm(context, arm) {
  const state = await readState(context.runtimeRoot);
  assertVerifyAllowed(state, arm, context.manifest.qualification_only === true);
  state.arms[arm].verification = { attempted: true, started_at: new Date().toISOString(), active_pid: null };
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
  const groupFile = join(context.runtimeRoot, `${arm}-verifier-process-group.pid`);
  const groupFileWsl = await toWslPath(context.manifest, groupFile);
  const stopGroup = () => stopWslGroup(context.manifest, groupFile);
  const spec = ownedWslSpec(context.manifest, verifierWsl, bash.executable, [...bash.args, scriptWsl], environment,
    groupFileWsl);
  const result = await execute(spec.executable, spec.args, { timeoutMs: DEFAULT_WALL_SECONDS * 1000,
    cwd: spec.cwd,
    heartbeat: `verify-arm:${arm}`,
    stopTree: stopGroup,
    onSpawn: async (pid) => { state.arms[arm].verification.active_pid = pid ?? null;
      await saveState(context.runtimeRoot, state); } });
  try { result.processGroup = await stopGroup(); result.cleanupConfirmation = "confirmed"; }
  catch { result.operationFailure = "process-cleanup-unconfirmed"; result.cleanupConfirmation = "unconfirmed"; }
  const cancellation = await cancellationRequest(context, arm, "verify-arm");
  if (cancellation) result.operationFailure = "cancelled";
  state.arms[arm].verification.active_pid = null;
  const rewardPath = resolve(logs, "verifier", "reward.json");
  invariant(isInside(logs, rewardPath), "reward-path", "Reward file escaped verifier logs.");
  let resultJson = {};
  try { resultJson = JSON.parse(await readFile(rewardPath, "utf8")); } catch {}
  const reward = rewardEvidence(resultJson, context.manifest.verifier.result);
  await rm(logs, { recursive: true, force: true });
  state.arms[arm].verification = { ...state.arms[arm].verification, status: "complete", exit: result.code,
    signal: result.signal, timed_out: result.timedOut, duration_ms: Date.now() - started,
    operation_failure: result.operationFailure ?? null, process_scope: "wsl",
    process_group: result.processGroup ?? null, cleanup_confirmation: result.cleanupConfirmation ?? "unconfirmed",
    stdout_sha256: sha256Bytes(result.stdout), stderr_sha256: sha256Bytes(result.stderr),
    reward: reward.reward, counts: reward.counts, environment_deviation:
      "Docker and Runta intentionally unused; official test.sh and config report paths were localized without changing verifier logic." };
  await saveState(context.runtimeRoot, state);
  if (cancellation) {
    state.stopped = { arm, reason: "cancelled", gate: cancellation.signal, at: new Date().toISOString() };
    await saveState(context.runtimeRoot, state);
    await summarize(context);
    throw new HarnessFailure("cancelled", "Verifier cancelled; partial summary saved.");
  }
  return sanitizeForReport(state.arms[arm].verification, reportSecrets(context.manifest));
}

export async function summarize(context) {
  const state = await readState(context.runtimeRoot);
  if (state.stopped) {
    const report = sanitizeForReport({ schema_version: 1, task_id: TASK_ID, unofficial: true,
      methodology_comparable: false, leaderboard: false, public_publish: false,
      ...(state.debug ? { debug_mode: true, quality_gate: false } : {}),
      stopped: state.stopped, arms: Object.fromEntries(ARMS.map((arm) => [arm,
        state.arms?.[arm]?.run ?? { status: "not-run" }])),
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
    recoverable_refusals: state.arms[arm].run.recoverable_refusals ?? 0,
    refusal_codes: state.arms[arm].run.refusal_codes ?? [],
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
    ...(state.debug ? { debug_mode: true, quality_gate: false } : {}),
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
  invariant(!ARMS.some((arm) => state.arms?.[arm]?.run?.operation_failure === "process-cleanup-unconfirmed" ||
    state.arms?.[arm]?.verification?.operation_failure === "process-cleanup-unconfirmed"),
    "cleanup-process", "Linux process cleanup is unconfirmed; preserve the process group and diagnosis evidence.");
  invariant(await stat(join(context.runtimeRoot, REPORT_FILE)).catch(() => null), "cleanup-evidence",
    "Sanitized summary must exist before cleanup.");
  for (const arm of ARMS) for (const [suffix, evidence] of [["process-group.pid", state.arms?.[arm]?.run],
    ["verifier-process-group.pid", state.arms?.[arm]?.verification]]) {
    const groupFile = join(context.runtimeRoot, `${arm}-${suffix}`);
    if (await stat(groupFile).catch(() => null)) {
      const recorded = Number((await readFile(groupFile, "utf8")).trim());
      invariant(Number.isInteger(recorded) && recorded === evidence?.process_group,
        "cleanup-process", "Owned WSL process group identity differs from durable state.");
      invariant(evidence.cleanup_confirmation === "confirmed", "cleanup-process",
        "Owned WSL process group cleanup lacks durable confirmation.");
      await rm(groupFile, { force: true });
    }
  }
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
    if (key === "--confirm" || key === "--debug") { options[key.slice(2)] = true; continue; }
    invariant(key === "--manifest" || key === "--arm" || key === "--gate" || key === "--signal" || key === "--candidate",
      "usage", "Unknown CLI option.");
    invariant(argv[index + 1] !== undefined, "usage", "CLI option value is missing.");
    options[key.slice(2)] = argv[++index];
  }
  invariant(["preflight", "prepare", "refresh-sortie-package", "run-arm", "resume-arm", "recapture-arm", "replace-infrastructure-arm",
    "replace-infrastructure-verifier", "inspect-arm",
    "verify-arm", "cancel", "summarize", "cleanup"].includes(command) &&
    string(options.manifest), "usage", "Command and --manifest are required.");
  if (["run-arm", "resume-arm", "recapture-arm", "replace-infrastructure-arm", "replace-infrastructure-verifier", "cancel",
    "inspect-arm", "verify-arm"].includes(command)) invariant(ARMS.includes(options.arm), "usage",
    "--arm bare|sortie is required.");
  if (command === "cancel") invariant(options.confirm === true && ["SIGINT", "SIGTERM"].includes(options.signal),
    "usage", "cancel requires --confirm and --signal SIGINT|SIGTERM.");
  if (command === "refresh-sortie-package") invariant(string(options.candidate), "usage",
    "refresh-sortie-package requires --candidate.");
  invariant(options.debug === undefined || ((command === "run-arm" || command === "resume-arm") && options.debug === true),
    "usage", "--debug is limited to run-arm or resume-arm.");
  return { command, options };
}

async function loadContext(manifestPath) {
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
  else if (command === "refresh-sortie-package") output = await refreshSortiePackage(context, options.candidate);
  else if (command === "run-arm") output = await runArm(context, options.arm, options.debug === true);
  else if (command === "resume-arm") output = await resumeArm(context, options.arm);
  else if (command === "recapture-arm") output = await recaptureArm(context, options.arm);
  else if (command === "replace-infrastructure-arm") output = await replaceInfrastructureArm(context,
    options.arm, options.gate, options.confirm === true);
  else if (command === "replace-infrastructure-verifier") output = await replaceInfrastructureVerifier(context,
    options.arm, options.gate, options.confirm === true);
  else if (command === "inspect-arm") output = await inspectArm(context, options.arm);
  else if (command === "verify-arm") output = await verifyArm(context, options.arm);
  else if (command === "cancel") output = await cancelActive(context, options.arm, options.confirm === true, options.signal);
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
