import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { cancelActive, refreshSortiePackage } from "./fixtures/frontierharness-local/run-local-case-study.mjs";
import { createQualificationManifest, parseQualificationArgs, runQualification } from "../scripts/run-v010-qualification.mjs";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const official = ["instruction.md", "task.toml", "tests/test.patch", "tests/config.json", "tests/grader.py", "tests/test.sh"];
const tools = ["git", "node", "go", "goyacc", "go_ctrf_json_reporter", "python", "npm", "bash", "script"];

function baseManifest(root: string) {
  return {
    schema_version: 1, profile: "v010", qualification_only: true, methodology_comparable: false,
    leaderboard: false, task_id: "datacurve/anko-typed-variable-bindings",
    pins: { deepswe_commit: "435ee89ec2f2e2289f33b0da4f992f0b7b7266b9",
      anko_base: "3f269a72ff69398b1250c584171f32d12c0d8085" },
    paths: { runtime_root: join(root, "_testenv", "base-run"), official_root: join(root, "official"),
      package_tgz: join(root, "old-package.tgz") },
    official_sha256: Object.fromEntries(official.map(path => [path, hash(path)])),
    package: { sha256: hash("old"), version: "0.9.0", runtime_marker: "old-marker",
      required_assets: ["agent/dog-operator.md", "agent/dogs-coordinator.md", "agent/dog-worker-v010.md", "command/sortie-v010.md"] },
    source: { repository: "local-source", base: "3f269a72ff69398b1250c584171f32d12c0d8085" },
    opencode: { wsl_executable: "wsl.exe", executable: "/exact/opencode", version: "1.2.3",
      auth_file: "/secret/credential-value/auth.json", host_database: "/secret/credential-value/opencode.db",
      model: "openai/gpt-5.6-sol", variant: "high" },
    tools: Object.fromEntries(tools.map(name => [name, { environment: name === "git" ? "host" : "wsl",
      executable: name === "bash" ? "/usr/bin/bash" : name === "script" ? "/usr/bin/script" : `/exact/${name}`,
      args: [], probe_args: ["--version"], probe_exit: 0 }])),
    verifier: { environment: "wsl", result: { reward_file: "verifier/reward.json", reward_field: "reward",
      count_fields: ["f2p_total", "f2p_passed", "p2p_total", "p2p_passed", "f2p", "p2p", "partial", "apply_failed"] } },
    protocol: { wall_seconds: 5400, startup_seconds: 5400, activity_seconds: 5400, progress_seconds: 5400,
      retry_count: 0, attempts_per_arm: 1, arm_order: ["bare", "sortie"] },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "v010-qualification-"));
  await mkdir(join(root, "_testenv"));
  const base = baseManifest(root);
  const basePath = join(root, "base.json");
  await writeFile(basePath, JSON.stringify(base));
  return { root, base, basePath };
}

function mockDependencies(root: string, calls: string[], exits: Record<string, number> = {}) {
  const npmCli = "/exact/npm-cli.js";
  return {
    repositoryRoot: root, runner: join(root, "runner.mjs"), npmCli,
    inspectPackage: async (path: string) => ({ filename: path.split(/[\\/]/u).at(-1), sha256: hash("new-package"),
      version: "0.10.0-beta.1", runtimeMarker: "v010-current-marker",
      criticalDistSha256: { "dist/core/operator-runtime.js": hash("operator-runtime") },
      modulesSha256: hash(JSON.stringify({ "dist/core/operator-runtime.js": hash("operator-runtime") })) }),
    command: async (_executable: string, args: string[], options: { cwd: string }) => {
      let name: string;
      if (args[0] === npmCli && args[1] === "run") name = "npm-build";
      else if (args[0] === npmCli && args[1] === "pack") {
        name = "npm-pack";
        const destination = args[args.indexOf("--pack-destination") + 1];
        await writeFile(join(destination, "sortie-dogs-0.10.0-beta.1.tgz"), "fresh-direct-package");
      } else name = args[1] === "run-arm" || args[1] === "verify-arm" ? `${args[1]}-${args[3]}` : args[1];
      calls.push(name);
      if (name === "preflight") await mkdir(join(args.at(-1)!, "..", "run"));
      if (name === "summarize") {
        const manifestPath = args.at(-1)!;
        const run = join(manifestPath, "..", "run");
        await mkdir(run, { recursive: true });
        await writeFile(join(run, "sanitized-summary.json"), JSON.stringify({ arms: { sortie: {
          outcome: exits["run-arm-sortie"] ? "failed" : "succeeded", reward: exits["run-arm-sortie"] ? null : 1,
        } } }));
      }
      return { exit: exits[name] ?? 0, stdout: name === "npm-pack"
        ? JSON.stringify([{ filename: "sortie-dogs-0.10.0-beta.1.tgz" }]) : "" };
    },
  };
}

function debugMockDependencies(root: string, calls: string[], continuation: "success" | "unknown" | "cap" | "wall" = "success",
  argv: string[][] = []) {
  const dependencies = mockDependencies(root, calls, { "run-arm-sortie": 1 }) as any;
  const command = dependencies.command;
  dependencies.command = async (executable: string, args: string[], options: any) => {
    argv.push([...args]);
    const phase = args[1];
    const manifestPath = args.at(-1)!;
    const runtime = join(dirname(manifestPath), "run");
    if (phase === "summarize") {
      calls.push("summarize");
      const state = JSON.parse(await readFile(join(runtime, "frontierharness-state.json"), "utf8"));
      await writeFile(join(runtime, "sanitized-summary.json"), JSON.stringify({ debug_mode: true, quality_gate: false,
        methodology_comparable: false, arms: { sortie: state.debug.status === "completed"
          ? { outcome: "succeeded", reward: 1 } : { outcome: "failed", reward: null } } }));
      return { exit: 0, stdout: "" };
    }
    if (phase === "resume-arm") {
      calls.push("resume-arm-sortie");
      const state = JSON.parse(await readFile(join(runtime, "frontierharness-state.json"), "utf8"));
      state.debug.executions.push({ cycle: state.debug.executions.length + 1, command: "resume-arm", exit: continuation === "success" ? 0 : 1,
        event_errors: continuation === "success" ? 0 : 1, errors: continuation === "success" ? [] :
          [{ kind: "tool", tool: "bash", error_sha256: "b".repeat(64) }], root_session_id: "ses_same",
        ...(state.debug.active_candidate_sha256 ? { candidate_sha256: state.debug.active_candidate_sha256 } : {}) });
      if (continuation === "success") {
        state.debug.status = "completed";
        delete state.stopped;
        Object.assign(state.arms.sortie.run, { exit: 0, event_errors: 0, operation_failure: null,
          root_session_id: "ses_same", expected_operation: { status: "pass", reason: null } });
      } else state.debug.status = "paused";
      await writeFile(join(runtime, "frontierharness-state.json"), JSON.stringify(state));
      return { exit: continuation === "success" ? 0 : 1, stdout: "" };
    }
    if (phase === "refresh-sortie-package") {
      calls.push("refresh-sortie-package");
      const candidatePath = args[args.indexOf("--candidate") + 1];
      const candidate = JSON.parse(await readFile(candidatePath, "utf8"));
      const state = JSON.parse(await readFile(join(runtime, "frontierharness-state.json"), "utf8"));
      state.debug.active_candidate_sha256 = candidate.package.sha256;
      state.debug.refreshes = [...(state.debug.refreshes ?? []), { package_sha256: candidate.package.sha256,
        modules_sha256: candidate.package.modules_sha256 }];
      await writeFile(join(runtime, "frontierharness-state.json"), JSON.stringify(state));
      return { exit: 0, stdout: "" };
    }
    const result = await command(executable, args, options);
    if (phase === "run-arm") {
      await mkdir(join(runtime, "workspaces", "sortie"), { recursive: true });
      const executions = [{ cycle: 1, command: "run-arm", exit: 1, event_errors: 1,
        errors: [{ kind: "tool", tool: "task", error_sha256: "a".repeat(64) }], root_session_id: "ses_same" }];
      if (continuation === "cap") while (executions.length < 12) executions.push({ ...executions[0], cycle: executions.length + 1 });
      await writeFile(join(runtime, "frontierharness-state.json"), JSON.stringify({ schema_version: 1,
        debug: { mode: "state-preserving", status: "recoverable", max_cycles: 12,
          started_at: new Date().toISOString(), deadline_at: new Date(Date.now() + (continuation === "wall" ? -1 : 60_000)).toISOString(), executions },
        arms: { sortie: { attempted: true, active_pid: null, run: { status: "complete", root_session_id: "ses_same",
          expected_operation: { status: "fail", reason: "agent-event-error" } } } },
        stopped: { arm: "sortie", reason: "agent-event-error" } }));
    }
    return result;
  };
  return dependencies;
}

test("success uses a fresh direct pack and includes verify before summary and cleanup", async () => {
  const fx = await fixture();
  try {
    const calls: string[] = [];
    await writeFile(join(fx.root, "old-package.tgz"), "stale-package-must-not-be-used");
    const result = await runQualification({ baseManifestPath: fx.basePath, output: "_testenv/explicit-new" },
      mockDependencies(fx.root, calls));
    assert.equal(result.exitCode, 0);
    assert.deepEqual(calls, ["npm-build", "npm-pack", "preflight", "prepare", "run-arm-sortie",
      "verify-arm-sortie", "summarize", "cleanup"]);
    const generated = JSON.parse(await readFile(join(result.outputRoot, "qualification-manifest.json"), "utf8"));
    assert.equal(generated.paths.runtime_root, "run");
    assert.equal(generated.paths.package_tgz, "sortie-dogs-0.10.0-beta.1.tgz");
    assert.deepEqual(generated.pins, fx.base.pins);
    assert.deepEqual(generated.tools, fx.base.tools);
    assert.deepEqual(generated.protocol, fx.base.protocol);
    assert.equal(generated.opencode.model, fx.base.opencode.model);
    const receiptText = await readFile(join(result.outputRoot, "qualification-execution.json"), "utf8");
    assert.doesNotMatch(receiptText, /credential-value|auth\.json|opencode\.db|stale-package/u);
    const receipt = JSON.parse(receiptText);
    assert.equal(receipt.status, "succeeded");
    assert.deepEqual(Object.keys(receipt).sort(), ["attempt_count", "cleanup", "package", "phases", "retry_count",
      "reward", "run_id", "schema_version", "status"]);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("debug mode resumes the same prepared root/session, verifies, labels non-gate, then cleans", async () => {
  const fx = await fixture();
  try {
    const calls: string[] = [], argv: string[][] = [];
    const result = await runQualification({ baseManifestPath: fx.basePath, output: "_testenv/debug-success", debug: true },
      debugMockDependencies(fx.root, calls, "success", argv));
    assert.equal(result.exitCode, 0);
    assert.deepEqual(calls, ["npm-build", "npm-pack", "preflight", "prepare", "run-arm-sortie",
      "resume-arm-sortie", "verify-arm-sortie", "summarize", "cleanup"]);
    const resumed = argv.find(args => args[1] === "resume-arm")!;
    assert.deepEqual(resumed.slice(1, 6), ["resume-arm", "--arm", "sortie", "--debug", "--manifest"]);
    const receiptText = await readFile(join(result.outputRoot, "qualification-execution.json"), "utf8");
    const receipt = JSON.parse(receiptText);
    assert.equal(receipt.status, "succeeded");
    assert.equal(receipt.debug_mode, true);
    assert.equal(receipt.quality_gate, false);
    assert.equal(receipt.methodology_comparable, false);
    assert.equal(receipt.debug.cycles.length, 2);
    assert.deepEqual(receipt.debug.cycles.map((cycle: any) => cycle.root_session_id), ["ses_same", "ses_same"]);
    assert.equal(receipt.reward, 1);
    assert.equal(receipt.cleanup.status, "complete");
    assert.doesNotMatch(receiptText, /DEBUG continuation|official text|credential-value/u);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("debug unknown tool error pauses without verify or cleanup", async () => {
  const fx = await fixture();
  try {
    const calls: string[] = [];
    const result = await runQualification({ baseManifestPath: fx.basePath, output: "_testenv/debug-paused", debug: true },
      debugMockDependencies(fx.root, calls, "unknown"));
    assert.equal(result.receipt.status, "debug-paused");
    assert.equal(result.receipt.cleanup.status, "preserved");
    assert(!calls.includes("verify-arm-sortie"));
    assert(!calls.includes("cleanup"));
    assert(await stat(join(result.outputRoot, "run", "workspaces")).catch(() => null));
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("debug cycle cap pauses before another continuation", async () => {
  const fx = await fixture();
  try {
    const calls: string[] = [];
    const result = await runQualification({ baseManifestPath: fx.basePath, output: "_testenv/debug-cap", debug: true },
      debugMockDependencies(fx.root, calls, "cap"));
    assert.equal(result.receipt.status, "debug-paused");
    assert.equal(result.receipt.debug.cycles.length, 12);
    assert(!calls.includes("resume-arm-sortie"));
    assert(!calls.includes("cleanup"));
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("debug original wall cap pauses before another continuation", async () => {
  const fx = await fixture();
  try {
    const calls: string[] = [];
    const result = await runQualification({ baseManifestPath: fx.basePath, output: "_testenv/debug-wall", debug: true },
      debugMockDependencies(fx.root, calls, "wall"));
    assert.equal(result.receipt.status, "debug-paused");
    assert.equal(result.receipt.debug.cycles.length, 1);
    assert(!calls.includes("resume-arm-sortie"));
    assert(!calls.includes("cleanup"));
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("resume-debug reuses the run without build, pack, preflight, or prepare", async () => {
  const fx = await fixture();
  try {
    const firstCalls: string[] = [];
    const first = await runQualification({ baseManifestPath: fx.basePath, output: "_testenv/debug-resume", debug: true },
      debugMockDependencies(fx.root, firstCalls, "unknown"));
    assert.equal(first.receipt.status, "debug-paused");
    const calls: string[] = [];
    const resumed = await runQualification({ resumeDebug: first.outputRoot }, debugMockDependencies(fx.root, calls, "success"));
    assert.equal(resumed.exitCode, 0);
    assert.deepEqual(calls, ["resume-arm-sortie", "verify-arm-sortie", "summarize", "cleanup"]);
    const state = JSON.parse(await readFile(join(first.outputRoot, "run", "frontierharness-state.json"), "utf8"));
    assert.equal(state.arms.sortie.run.root_session_id, "ses_same");
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("resume-debug continues preserved delivery-not-complete only through the same debug root", async () => {
  const fx = await fixture();
  try {
    const first = await runQualification({ baseManifestPath: fx.basePath, output: "_testenv/debug-delivery-resume", debug: true },
      debugMockDependencies(fx.root, [], "unknown"));
    const statePath = join(first.outputRoot, "run", "frontierharness-state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.debug.status = "recoverable";
    state.stopped.reason = "delivery-not-complete";
    state.arms.sortie.active_pid = null;
    state.arms.sortie.run.expected_operation = { status: "fail", reason: "delivery-not-complete" };
    await writeFile(statePath, JSON.stringify(state));
    const calls: string[] = [], argv: string[][] = [];
    const resumed = await runQualification({ resumeDebug: first.outputRoot },
      debugMockDependencies(fx.root, calls, "success", argv));
    assert.equal(resumed.exitCode, 0);
    assert.deepEqual(calls, ["resume-arm-sortie", "verify-arm-sortie", "summarize", "cleanup"]);
    const resume = argv.find(args => args[1] === "resume-arm")!;
    assert.deepEqual(resume.slice(1, 6), ["resume-arm", "--arm", "sortie", "--debug", "--manifest"]);
    const after = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(after.arms.sortie.run.root_session_id, "ses_same");
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("refresh-candidate rebuilds and reinstalls before same-session debug resume without prepare", async () => {
  const fx = await fixture();
  try {
    const first = await runQualification({ baseManifestPath: fx.basePath, output: "_testenv/debug-refresh", debug: true },
      debugMockDependencies(fx.root, [], "unknown"));
    const manifestPath = join(first.outputRoot, "qualification-manifest.json");
    const manifestBefore = await readFile(manifestPath, "utf8");
    const calls: string[] = [];
    const resumed = await runQualification({ resumeDebug: first.outputRoot, refreshCandidate: true },
      debugMockDependencies(fx.root, calls, "success"));
    assert.equal(resumed.exitCode, 0);
    assert.deepEqual(calls, ["npm-build", "npm-pack", "refresh-sortie-package", "resume-arm-sortie",
      "verify-arm-sortie", "summarize", "cleanup"]);
    assert(!calls.includes("preflight") && !calls.includes("prepare"));
    assert.equal(await readFile(manifestPath, "utf8"), manifestBefore, "official generated manifest remains immutable");
    assert.equal(resumed.receipt.debug.refreshes.length, 1);
    assert.equal(resumed.receipt.debug.refreshes[0].package_sha256, hash("new-package"));
    assert.equal(resumed.receipt.debug.cycles.at(-1).candidate_sha256, hash("new-package"));
    assert.equal(resumed.receipt.quality_gate, false);
    const refreshDirectories = await stat(join(first.outputRoot, "refreshes")).catch(() => null);
    assert(refreshDirectories?.isDirectory());
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("runner refresh preserves workspace, configs, branch sentinel, session, attempt, wall, and cycles and refuses active processes", async () => {
  const fx = await fixture();
  try {
    const output = join(fx.root, "_testenv", "runner-refresh"), runtime = join(output, "run");
    const workspace = join(runtime, "workspaces", "sortie"), control = join(workspace, ".opencode");
    const opencodeConfig = join(runtime, "configs", "sortie", "opencode", "opencode.json");
    const xdgConfig = join(runtime, "configs", "sortie", "xdg", "opencode", "opencode.json");
    const refresh = join(output, "refreshes", "candidate-1");
    await Promise.all([mkdir(control, { recursive: true }), mkdir(dirname(opencodeConfig), { recursive: true }),
      mkdir(dirname(xdgConfig), { recursive: true }), mkdir(refresh, { recursive: true })]);
    await writeFile(join(workspace, "source-sentinel.txt"), "source\n");
    await writeFile(join(workspace, "main-head-sentinel.txt"), "main-oid\n");
    await writeFile(join(control, "opencode.json"), "project-config\n");
    await writeFile(opencodeConfig, "isolated-opencode\n");
    await writeFile(xdgConfig, "isolated-xdg\n");
    const deadline = new Date(Date.now() + 60_000).toISOString();
    const state = { schema_version: 1, preflight: { status: "pass", package_sha256: hash("official") },
      prepared: { status: "pass", base: "main-oid" }, debug: { mode: "state-preserving", status: "paused",
        deadline_at: deadline, max_cycles: 6, executions: [{ cycle: 1 }] },
      arms: { sortie: { attempted: true, active_pid: null, run: { root_session_id: "ses_same" } } },
      stopped: { arm: "sortie", reason: "agent-event-error" } };
    await writeFile(join(runtime, "frontierharness-state.json"), JSON.stringify(state));
    const tgz = join(refresh, "candidate.tgz");
    await writeFile(tgz, "candidate-package");
    const critical = { "dist/core/operator-runtime.js": hash("runtime-module") };
    const candidatePath = join(refresh, "refresh-candidate.json");
    await writeFile(candidatePath, JSON.stringify({ schema_version: 1, package: { path: "candidate.tgz",
      sha256: hash("candidate-package"), version: "0.10.0-beta.1", runtime_marker: "marker-refresh",
      critical_dist_sha256: critical, modules_sha256: hash(JSON.stringify(critical)) } }));
    const context = { runtimeRoot: runtime, manifestPath: join(output, "qualification-manifest.json"),
      manifest: { profile: "v010", qualification_only: true }, profile: { runtimeModule: "runtime-assets-v010.js" } } as any;
    const snapshot = async () => ({ source: await readFile(join(workspace, "source-sentinel.txt"), "utf8"),
      main: await readFile(join(workspace, "main-head-sentinel.txt"), "utf8"),
      project: await readFile(join(control, "opencode.json"), "utf8"), opencode: await readFile(opencodeConfig, "utf8"),
      xdg: await readFile(xdgConfig, "utf8") });
    let installs = 0;
    const result = await refreshSortiePackage(context, candidatePath, { snapshot, install: async (_context: unknown,
      candidateWorkspace: string, _roots: unknown, candidate: any) => {
      installs += 1;
      assert.equal(candidateWorkspace, workspace);
      assert.equal(candidate.sha256, hash("candidate-package"));
      await writeFile(join(candidateWorkspace, ".opencode", "package.json"), JSON.stringify({ dependencies: {
        "sortie-dogs": `file:${candidate.packagePath}` } }));
      return { version: candidate.version, marker: candidate.runtime_marker, package_sha256: candidate.sha256,
        modules_sha256: candidate.modules_sha256 };
    } });
    assert.equal(installs, 1);
    assert.equal(result.package_sha256, hash("candidate-package"));
    const after = JSON.parse(await readFile(join(runtime, "frontierharness-state.json"), "utf8"));
    assert.deepEqual(after.debug.executions, state.debug.executions);
    assert.equal(after.debug.deadline_at, deadline);
    assert.equal(after.arms.sortie.run.root_session_id, "ses_same");
    assert.deepEqual(after.stopped, state.stopped);
    assert.equal(after.debug.active_candidate_sha256, hash("candidate-package"));
    assert.equal(after.debug.refreshes[0].modules_sha256, hash(JSON.stringify(critical)));
    after.arms.sortie.active_pid = 1234;
    await writeFile(join(runtime, "frontierharness-state.json"), JSON.stringify(after));
    await assert.rejects(refreshSortiePackage(context, candidatePath, { snapshot, install: async () => { installs += 1; } }),
      /active/u);
    assert.equal(installs, 1, "active process refusal occurs before package mutation");
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("clean qualification refuses a generated debug manifest/root", async () => {
  const fx = await fixture();
  try {
    const debug = await runQualification({ baseManifestPath: fx.basePath, output: "_testenv/debug-base", debug: true },
      debugMockDependencies(fx.root, [], "unknown"));
    const calls: string[] = [];
    await assert.rejects(runQualification({ baseManifestPath: join(debug.outputRoot, "qualification-manifest.json"),
      output: "_testenv/illegal-clean-reuse" }, mockDependencies(fx.root, calls)), /cannot reuse a debug/u);
    assert.deepEqual(calls, []);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("debug CLI options are explicit and mutually exclusive", () => {
  assert.deepEqual(parseQualificationArgs(["--debug", "--base-manifest", "base.json"]),
    { debug: true, baseManifestPath: "base.json" });
  assert.deepEqual(parseQualificationArgs(["--resume-debug", "_testenv/run"]), { resumeDebug: "_testenv/run" });
  assert.deepEqual(parseQualificationArgs(["--resume-debug", "_testenv/run", "--refresh-candidate"]),
    { resumeDebug: "_testenv/run", refreshCandidate: true });
  assert.throws(() => parseQualificationArgs(["--debug", "--resume-debug", "_testenv/run"]));
  assert.throws(() => parseQualificationArgs(["--refresh-candidate", "--base-manifest", "base.json"]));
});

test("run failure omits verify but still summarizes and cleans", async () => {
  const fx = await fixture();
  try {
    const calls: string[] = [];
    const result = await runQualification({ baseManifestPath: fx.basePath, output: "_testenv/run-failure" },
      mockDependencies(fx.root, calls, { "run-arm-sortie": 7 }));
    assert.equal(result.exitCode, 7);
    assert.deepEqual(calls.slice(-3), ["run-arm-sortie", "summarize", "cleanup"]);
    assert(!calls.includes("verify-arm-sortie"));
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("cleanup failure does not mask the primary run exit", async () => {
  const fx = await fixture();
  try {
    const result = await runQualification({ baseManifestPath: fx.basePath, output: "_testenv/cleanup-failure" },
      mockDependencies(fx.root, [], { "run-arm-sortie": 7, cleanup: 9 }));
    assert.equal(result.exitCode, 7);
    assert.deepEqual(result.receipt.cleanup, { status: "failed", exit: 9 });
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("signal cancellation stops the active runner before summary and confirmed cleanup", async () => {
  const fx = await fixture();
  try {
    const calls: string[] = [];
    let releaseRun: ((value: { exit: number; stdout: string }) => void) | undefined;
    const dependencies = mockDependencies(fx.root, calls) as any;
    const normalCommand = dependencies.command;
    dependencies.command = async (executable: string, args: string[], options: any) => {
      if (args[1] !== "run-arm") return normalCommand(executable, args, options);
      calls.push("run-arm-sortie");
      setTimeout(() => process.emit("SIGINT"), 10);
      return await new Promise(resolve => { releaseRun = resolve; });
    };
    dependencies.controlCommand = async (_executable: string, args: string[]) => {
      assert.equal(args[1], "cancel");
      assert.deepEqual(args.slice(2, 8), ["--arm", "sortie", "--signal", "SIGINT", "--confirm", "--manifest"]);
      calls.push("cancel-run-arm");
      releaseRun?.({ exit: 1, stdout: "" });
      return { exit: 0, stdout: "" };
    };
    const result = await runQualification({ baseManifestPath: fx.basePath, output: "_testenv/signal-cancel" }, dependencies);
    assert.equal(result.exitCode, 130);
    assert.equal(result.receipt.status, "cancelled");
    assert.deepEqual(calls.slice(-4), ["run-arm-sortie", "cancel-run-arm", "summarize", "cleanup"]);
    assert(!calls.includes("verify-arm-sortie"));
    assert(result.receipt.phases.some((phase: any) => phase.command === "cancel-run-arm" && phase.exit === 0));
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("runner cancel records a stopped partial summary after confirmed owned-group stop", async () => {
  const fx = await fixture();
  try {
    const runtimeRoot = join(fx.root, "_testenv", "cancel-runtime");
    await mkdir(runtimeRoot);
    await writeFile(join(runtimeRoot, "sortie-process-group.pid"), "4321\n");
    await writeFile(join(runtimeRoot, "frontierharness-state.json"), JSON.stringify({ schema_version: 1,
      preflight: { status: "pass" }, prepared: { status: "pass" },
      arms: { sortie: { attempted: true, active_pid: 1234 } } }));
    const result = await cancelActive({ runtimeRoot, manifest: fx.base } as any, "sortie", true, "SIGTERM", {
      stopGroup: async () => 4321,
    });
    assert.equal(result.cleanup_confirmation, "confirmed");
    const state = JSON.parse(await readFile(join(runtimeRoot, "frontierharness-state.json"), "utf8"));
    assert.equal(state.stopped.reason, "cancelled");
    assert.equal(state.arms.sortie.run.exit, 143);
    assert.equal(state.arms.sortie.run.process_group, 4321);
    const summary = JSON.parse(await readFile(join(runtimeRoot, "sanitized-summary.json"), "utf8"));
    assert.equal(summary.stopped.reason, "cancelled");
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("SIGINT to a wrapper subprocess cancels its mock long runner and reaches cleanup", {
  skip: process.platform === "win32",
}, async () => {
  const fx = await fixture();
  try {
    const output = join(fx.root, "_testenv", "subprocess-cancel");
    const npmCli = join(fx.root, "fake-npm.mjs");
    const runner = join(fx.root, "fake-runner.mjs");
    const driver = join(fx.root, "driver.mjs");
    await writeFile(npmCli, `import{writeFile}from'node:fs/promises';import{join}from'node:path';const a=process.argv.slice(2);if(a[0]==='pack'){const d=a[a.indexOf('--pack-destination')+1];await writeFile(join(d,'fresh.tgz'),'fresh');console.log(JSON.stringify([{filename:'fresh.tgz'}]));}`);
    await writeFile(runner, `import{mkdir,readFile,stat,writeFile}from'node:fs/promises';import{dirname,join}from'node:path';const a=process.argv.slice(2),p=a[0],m=a[a.indexOf('--manifest')+1],o=dirname(m),r=join(o,'run'),has=async p=>!!await stat(p).catch(()=>null);if(p==='preflight')await mkdir(r);if(p==='run-arm'){await writeFile(join(o,'long-started'),'1');while(!await has(join(o,'cancel-requested')))await new Promise(d=>setTimeout(d,20));await writeFile(join(o,'long-stopped'),'1');process.exitCode=1;}if(p==='cancel')await writeFile(join(o,'cancel-requested'),'1');if(p==='summarize')await writeFile(join(r,'sanitized-summary.json'),JSON.stringify({stopped:{reason:'cancelled'},arms:{sortie:{outcome:'failed',reward:null}}}));if(p==='cleanup')await writeFile(join(o,'cleanup-called'),'1');`);
    const wrapperUrl = new URL("../scripts/run-v010-qualification.mjs", import.meta.url).href;
    await writeFile(driver, `import{runQualification,spawnCommand}from${JSON.stringify(wrapperUrl)};const[root,base,output,runner,npmCli]=process.argv.slice(2);const result=await runQualification({baseManifestPath:base,output},{repositoryRoot:root,runner,npmCli,command:spawnCommand,inspectPackage:async p=>({filename:'fresh.tgz',sha256:'${hash("fresh")}',version:'0.10.0-beta.1',runtimeMarker:'current'})});process.exitCode=result.exitCode;`);
    const child = spawn(process.execPath, [driver, fx.root, fx.basePath, output, runner, npmCli],
      { cwd: fx.root, shell: false, stdio: "ignore" });
    const deadline = Date.now() + 10_000;
    while (!await stat(join(output, "long-started")).catch(() => null) && Date.now() < deadline)
      await new Promise(done => setTimeout(done, 20));
    assert(await stat(join(output, "long-started")).catch(() => null), "mock long runner did not start");
    child.kill("SIGINT");
    const exit = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("wrapper cancellation timed out")), 15_000);
      child.once("close", code => { clearTimeout(timer); resolve(code); });
      child.once("error", reject);
    });
    assert.equal(exit, 130);
    assert(await stat(join(output, "long-stopped")).catch(() => null));
    assert(await stat(join(output, "cleanup-called")).catch(() => null));
    const receipt = JSON.parse(await readFile(join(output, "qualification-execution.json"), "utf8"));
    assert.equal(receipt.status, "cancelled");
    assert(receipt.phases.some((phase: any) => phase.command === "cancel-run-arm"));
    assert(!receipt.phases.some((phase: any) => phase.command === "verify-arm-sortie"));
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("existing output root is refused before any command", async () => {
  const fx = await fixture();
  try {
    await mkdir(join(fx.root, "_testenv", "existing"));
    const calls: string[] = [];
    await assert.rejects(runQualification({ baseManifestPath: fx.basePath, output: "_testenv/existing" },
      mockDependencies(fx.root, calls)), /already exists/u);
    assert.deepEqual(calls, []);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("manifest derivation updates only run and current package identity", () => {
  const root = join(tmpdir(), "qualification-derive");
  const base = baseManifest(root);
  const generated = createQualificationManifest(base, join(root, "base.json"), {
    filename: "fresh.tgz", sha256: "a".repeat(64), version: "0.10.0-beta.1", runtimeMarker: "current",
  });
  assert.deepEqual(generated.pins, base.pins);
  assert.deepEqual(generated.tools, base.tools);
  assert.deepEqual(generated.protocol, base.protocol);
  assert.deepEqual(generated.package.required_assets, base.package.required_assets);
  assert.equal(base.paths.package_tgz, join(root, "old-package.tgz"));
});

test("non-one-shot qualification base fails before paid commands", async () => {
  const fx = await fixture();
  try {
    fx.base.protocol.retry_count = 1;
    await writeFile(fx.basePath, JSON.stringify(fx.base));
    const calls: string[] = [];
    await assert.rejects(runQualification({ baseManifestPath: fx.basePath }, mockDependencies(fx.root, calls)));
    assert.deepEqual(calls, []);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});
