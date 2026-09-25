import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  acquireRunLock,
  createSupervisorState,
  processIdentity,
  releaseRunLock,
  runSupervisor,
  runWatchdog,
  stopSupervisor,
  writeAtomicJson,
} from "../scripts/swebench-lite-supervisor.mjs";

const manifestValue = {
  dataset: { id: "princeton-nlp/SWE-bench_Lite", revision: "pinned", split: "dev" },
  candidate: { package_tgz: "candidate.tgz", sha256: "a".repeat(64), version: "0.10.6", runtime_marker: "marker", profile: "v010", agent: "dog-operator" },
  instances: [
    { instance_id: "example__project-1", repo: "example/project", base_commit: "a".repeat(40), problem_statement: "one" },
    { instance_id: "example__project-2", repo: "example/project", base_commit: "b".repeat(40), problem_statement: "two" },
  ],
};

const liteDev23Manifest = {
  schema_version: 1,
  dataset: {
    id: "princeton-nlp/SWE-bench_Lite",
    revision: "6ec7bb89b9342f664a54a6e0a6ea6501d3437cc2",
    split: "dev",
  },
  candidate: {
    package_tgz: "candidate.tgz",
    sha256: "a".repeat(64),
    version: "0.10.6",
    runtime_marker: "marker",
    profile: "v010",
    agent: "dog-operator",
  },
  instances: Array.from({ length: 23 }, (_, index) => ({
    instance_id: `example__project-${index + 1}`,
    repo: "example/project",
    base_commit: "a".repeat(40),
    problem_statement: `Issue ${index + 1}`,
  })),
};

function fakeDependencies(runs: string[], configuration: { limits?: number[]; statuses?: Record<string, string>; usage?: Record<string, number> } = {}) {
  return {
    allowWindows: true,
    spawnWatchdog: async () => ({}),
    spawnRunner: async (_state: unknown, entry: { instance_id: string }, paths: { output: string; metadata: string }, options: { costLimitUsd: number }) => {
      runs.push(entry.instance_id);
      configuration.limits?.push(options.costLimitUsd);
      await mkdir(dirname(paths.output), { recursive: true });
      await writeFile(paths.output, `${JSON.stringify({ instance_id: entry.instance_id, model_name_or_path: "fake", model_patch: "" })}\n`);
      const usage = configuration.usage?.[entry.instance_id] ?? 0;
      await writeAtomicJson(paths.metadata, {
        execution: { spent_usd: usage, usage_complete: true },
        results: [{ instance_id: entry.instance_id, status: configuration.statuses?.[entry.instance_id] ?? "failed", exit_code: 1, usage: { usd: usage } }],
      });
      return { identity: { pid: 99999999, starttime: null } };
    },
    waitForChild: async () => ({ exit: 0, signal: null }),
  };
}

test("supervisor atomically claims each instance and writes ordered aggregate output", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-supervisor-"));
  const runs: string[] = [];
  try {
    const output = join(root, "predictions.jsonl");
    const state = await runSupervisor(manifestValue, {
      manifestPath: join(root, "manifest.json"),
      runRoot: root,
      output,
      costLimitUsd: 5,
      watchdog: false,
    }, fakeDependencies(runs));
    assert.deepEqual(runs, ["example__project-1", "example__project-2"]);
    assert.equal(state.status, "completed");
    assert.equal(state.schema_version, 1);
    assert.equal(state.workers, 1);
    assert.deepEqual(state.policy, { attempts_per_instance: 1, retry_count: 0 });
    assert.deepEqual(state.instances.map(entry => entry.status), ["failed", "failed"]);
    const lines = (await readFile(output, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(lines.map(line => line.instance_id), ["example__project-1", "example__project-2"]);
    assert.equal((await readFile(join(root, "supervisor-state.json"), "utf8")).includes('"status": "completed"'), true);
    assert.equal((await readFile(state.instances[0]!.child_output, "utf8")).includes("example__project-1"), true);
    const child = JSON.parse(await readFile(join(root, "manifests", "000-example__project-1.json"), "utf8"));
    assert.deepEqual(Object.keys(child).sort(), Object.keys(manifestValue).sort(),
      "the runner rejects supervisor-only fields in its strict inference manifest");
    assert.equal(child.instances.length, 1);
    const metadata = JSON.parse(await readFile(`${output}.metadata.json`, "utf8"));
    assert.equal(metadata.status, "completed");
    assert.equal((await readdir(root, { recursive: true })).some(path => String(path).endsWith(".tmp")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replay pins candidate and limits and retains an unpriced reservation", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-supervisor-budget-"));
  try {
    const value = { ...manifestValue, instances: [...manifestValue.instances, {
      ...manifestValue.instances[0], instance_id: "example__project-3" }] };
    const options = { manifestPath: join(root, "manifest.json"), runRoot: root,
      output: join(root, "predictions.jsonl"), workers: 2, costLimitUsd: 1, perInstanceUsd: 0.5, watchdog: false };
    const runs: string[] = [], limits: number[] = [];
    const dependencies = fakeDependencies(runs, { limits });
    dependencies.spawnRunner = async (_state: unknown, entry: { instance_id: string }, paths: { metadata: string }, opts: { costLimitUsd: number }) => {
      runs.push(entry.instance_id); limits.push(opts.costLimitUsd);
      await writeAtomicJson(paths.metadata, { execution: { spent_usd: 0, usage_complete: false },
        results: [{ instance_id: entry.instance_id, status: "failed", usage: { usd: 0 } }] });
      return { identity: { pid: 99999999, starttime: null } };
    };
    const state = await runSupervisor(value, options, dependencies);
    assert.deepEqual(limits, [0.5, 0.5]);
    assert.equal(state.held_unknown_usd, 1);
    assert.equal(state.instances[2].status, "not-run-cost-limit");
    const saved = await readFile(join(root, "supervisor-state.json"), "utf8");
    await assert.rejects(runSupervisor({ ...value, candidate: { ...value.candidate, sha256: "b".repeat(64) } }, options, dependencies), /supervisor-input-changed/);
    await assert.rejects(runSupervisor(value, { ...options, costLimitUsd: 2 }, dependencies), /supervisor-limits-changed/);
    assert.equal(await readFile(join(root, "supervisor-state.json"), "utf8"), saved);
    await runSupervisor(value, options, dependencies);
    assert.equal(runs.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fixed Lite dev23 runs pass@1 with four active runners and one queued state writer", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-supervisor-dev23-"));
  const runs: string[] = [];
  const reservations: number[] = [];
  let active = 0;
  let maximumActive = 0;
  let startedRunners = 0;
  let releaseRunners: () => void = () => undefined;
  const allRunnersStarted = new Promise<void>(resolvePromise => { releaseRunners = resolvePromise; });
  try {
    const result = await runSupervisor(liteDev23Manifest, {
      manifestPath: join(root, "manifest.json"),
      runRoot: root,
      output: join(root, "predictions.jsonl"),
      costLimitUsd: 23,
      workers: 4,
      heartbeatSeconds: 0.001,
      watchdog: false,
    }, {
      allowWindows: true,
      spawnRunner: async (_state: unknown, entry: { instance_id: string }, paths: { output: string; metadata: string }, options: { costLimitUsd: number }) => {
        runs.push(entry.instance_id);
        reservations.push(options.costLimitUsd);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        startedRunners += 1;
        if (startedRunners === 4) releaseRunners();
        await mkdir(dirname(paths.output), { recursive: true });
        await writeFile(paths.output, `${JSON.stringify({ instance_id: entry.instance_id, model_name_or_path: "fixed-candidate", model_patch: "" })}\n`);
        await writeAtomicJson(paths.metadata, {
          execution: { spent_usd: 0, usage_complete: true },
          results: [{ instance_id: entry.instance_id, status: "failed", exit_code: 1, usage: { usd: 0 } }],
        });
        return { identity: { pid: 99999999, starttime: null } };
      },
      waitForChild: async (_child: unknown, entry: { index: number }) => {
        await allRunnersStarted;
        await new Promise(resolvePromise => setTimeout(resolvePromise, 2 + (entry.index % 3)));
        active -= 1;
        return { exit: 0, signal: null };
      },
    });
    const expectedIds = liteDev23Manifest.instances.map(instance => instance.instance_id);
    assert.equal(liteDev23Manifest.dataset.split, "dev");
    assert.equal(liteDev23Manifest.instances.length, 23);
    assert.equal(maximumActive, 4);
    assert.equal(result.schema_version, 1);
    assert.equal(result.workers, 4);
    assert.deepEqual(result.policy, { attempts_per_instance: 1, retry_count: 0 });
    assert.deepEqual(result.instances.map(entry => entry.attempt), Array(23).fill(1));
    assert.deepEqual(runs, expectedIds);
    assert(reservations.every(value => Number.isFinite(value) && value > 0 && value <= 23));
    assert.equal(result.reserved_usd, 0);
    assert(result.heartbeat.sequence > 0);
    const persisted = JSON.parse(await readFile(join(root, "supervisor-state.json"), "utf8"));
    assert.equal(persisted.schema_version, 1);
    assert.equal(persisted.status, "completed");
    assert.equal(persisted.heartbeat.sequence, result.heartbeat.sequence);
    const lines = (await readFile(join(root, "predictions.jsonl"), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(lines.map(line => line.instance_id), expectedIds);
    assert.equal((await readdir(root, { recursive: true })).some(path => String(path).endsWith(".tmp")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workers bound active runners, preserve claim/output order, and reserve cost per instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-supervisor-workers-"));
  const runs: string[] = [];
  const limits: number[] = [];
  let active = 0;
  let maximumActive = 0;
  const value = {
    ...manifestValue,
    instances: Array.from({ length: 4 }, (_, index) => ({
      ...manifestValue.instances[0],
      instance_id: `example__project-${index + 1}`,
    })),
  };
  try {
    const result = await runSupervisor(value, {
      manifestPath: join(root, "manifest.json"),
      runRoot: root,
      output: join(root, "predictions.jsonl"),
      costLimitUsd: 4,
      workers: 2,
      watchdog: false,
    }, {
      allowWindows: true,
      spawnRunner: async (_state: unknown, entry: { instance_id: string }, paths: { output: string; metadata: string }, options: { costLimitUsd: number }) => {
        runs.push(entry.instance_id);
        limits.push(options.costLimitUsd);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await mkdir(dirname(paths.output), { recursive: true });
        await writeFile(paths.output, `${JSON.stringify({ instance_id: entry.instance_id, model_name_or_path: "fake", model_patch: "" })}\n`);
        await writeAtomicJson(paths.metadata, {
          execution: { spent_usd: 0.25, usage_complete: true },
          results: [{ instance_id: entry.instance_id, status: "failed", exit_code: 1, usage: { usd: 0.25 } }],
        });
        return { identity: { pid: 99999999, starttime: null } };
      },
      waitForChild: async (_child: unknown, entry: { instance_id: string }) => {
        await new Promise(resolvePromise => setTimeout(resolvePromise, entry.instance_id.endsWith("-2") || entry.instance_id.endsWith("-4") ? 5 : 20));
        active -= 1;
        return { exit: 0, signal: null };
      },
    });
    assert.equal(maximumActive, 2);
    assert.equal(result.workers, 2);
    assert.deepEqual(runs, [
      "example__project-1", "example__project-2", "example__project-3", "example__project-4",
    ]);
    assert.deepEqual(limits.slice(0, 2), [1, 1]);
    assert(limits.slice(2).every(limit => limit > 0 && limit <= 4));
    assert.deepEqual(result.instances.map(entry => entry.attempt), [1, 1, 1, 1]);
    assert.equal(result.reserved_usd, 0);
    const lines = (await readFile(join(root, "predictions.jsonl"), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(lines.map(line => line.instance_id), value.instances.map(instance => instance.instance_id));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supervisor resume marks an interrupted attempt and never reruns it", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-supervisor-resume-"));
  const runs: string[] = [];
  try {
    const statePath = join(root, "supervisor-state.json");
    const state = await createSupervisorState(manifestValue, {
      manifestPath: join(root, "manifest.json"),
      runRoot: root,
      output: join(root, "predictions.jsonl"),
    });
    state.instances[0]!.status = "running";
    state.instances[0]!.attempt = 1;
    await writeAtomicJson(statePath, state);
    const resumed = await runSupervisor(manifestValue, {
      manifestPath: join(root, "manifest.json"),
      runRoot: root,
      output: join(root, "predictions.jsonl"),
      costLimitUsd: 5,
      watchdog: false,
    }, fakeDependencies(runs));
    assert.deepEqual(runs, ["example__project-2"]);
    assert.equal(resumed.schema_version, 1);
    assert.equal(resumed.workers, 1);
    assert.deepEqual(resumed.policy, { attempts_per_instance: 1, retry_count: 0 });
    assert.equal(resumed.instances[0]!.status, "interrupted");
    assert.equal(resumed.instances[0]!.attempt, 1);
    assert.equal(resumed.instances[1]!.status, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resuming a partly priced child charges once and retains the unknown remainder", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-supervisor-partial-"));
  const runs: string[] = [];
  try {
    const options = { manifestPath: join(root, "manifest.json"), runRoot: root,
      output: join(root, "predictions.jsonl"), costLimitUsd: 1, watchdog: false };
    const state = await createSupervisorState(manifestValue, options);
    const metadata = join(root, "child-metadata.json");
    state.instances[0]!.status = "running";
    state.instances[0]!.attempt = 1;
    state.instances[0]!.cost_reservation_usd = 1;
    state.instances[0]!.child_metadata = metadata;
    state.reserved_usd = 1;
    await writeAtomicJson(metadata, { execution: { spent_usd: 0.3, usage_complete: false },
      results: [{ instance_id: state.instances[0]!.instance_id, status: "failed", usage: { usd: 0.3 } }] });
    await writeAtomicJson(join(root, "supervisor-state.json"), state);
    const resumed = await runSupervisor(manifestValue, options, fakeDependencies(runs));
    assert.deepEqual(runs, []);
    assert.equal(resumed.spent_usd, 0.3);
    assert.equal(resumed.held_unknown_usd, 0.7);
    assert.equal(resumed.instances[1]!.status, "not-run-cost-limit");
    const again = await runSupervisor(manifestValue, options, fakeDependencies(runs));
    assert.equal(again.spent_usd, 0.3);
    assert.equal(again.held_unknown_usd, 0.7);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("supervisor lock rejects a second owner and releases cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-supervisor-lock-"));
  try {
    const first = await acquireRunLock(root);
    await assert.rejects(acquireRunLock(root), /supervisor-already-running/);
    await releaseRunLock(first);
    const second = await acquireRunLock(root);
    await releaseRunLock(second);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("child failure is recorded while the supervisor advances to the next instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-supervisor-child-failure-"));
  const runs: string[] = [];
  try {
    const result = await runSupervisor(manifestValue, {
      manifestPath: join(root, "manifest.json"),
      runRoot: root,
      output: join(root, "predictions.jsonl"),
      costLimitUsd: 5,
      watchdog: false,
    }, fakeDependencies(runs, {
      statuses: { "example__project-1": "watchdog-stale", "example__project-2": "failed" },
    }));
    assert.deepEqual(runs, ["example__project-1", "example__project-2"]);
    assert.equal(result.instances[0]!.status, "watchdog-stale");
    assert.equal(result.instances[1]!.status, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supervisor passes the remaining global cost budget to each child", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-supervisor-cost-"));
  const limits: number[] = [];
  try {
    const result = await runSupervisor(manifestValue, {
      manifestPath: join(root, "manifest.json"),
      runRoot: root,
      output: join(root, "predictions.jsonl"),
      costLimitUsd: 3,
      watchdog: false,
    }, fakeDependencies([], { limits, usage: { "example__project-1": 1, "example__project-2": 1 } }));
    assert.deepEqual(limits, [1.5, 2]);
    assert.equal(result.spent_usd, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("watchdog records runner loss, PID identity mismatch, and terminal state", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-supervisor-watchdog-"));
  try {
    const report = join(root, "watchdog-report.jsonl");
    const current = await processIdentity();
    const statePath = join(root, "state.json");
    await writeAtomicJson(statePath, {
      status: "running",
      heartbeat: { at: new Date().toISOString(), supervisor: current },
      instances: [{ status: "running", runner: { pid: 99999999, starttime: null } }],
    });
    await runWatchdog({ state: statePath, report, intervalSeconds: 0.001, staleSeconds: 30, once: true });
    assert.equal((await readFile(report, "utf8")).includes('"event":"runner-lost"'), true);
    assert.equal((await readFile(report, "utf8")).includes('"progress":"1/1"'), true);
    await writeAtomicJson(statePath, {
      status: "running",
      heartbeat: { at: new Date().toISOString(), supervisor: { pid: process.pid, starttime: "wrong" } },
      instances: [],
    });
    await runWatchdog({ state: statePath, report, intervalSeconds: 0.001, staleSeconds: 30, reportSeconds: 0, once: true });
    assert.equal((await readFile(report, "utf8")).includes('"event":"supervisor-lost"'), true);
    await writeAtomicJson(statePath, {
      status: "running",
      heartbeat: { at: new Date().toISOString(), supervisor: current },
      instances: [],
    });
    await runWatchdog({ state: statePath, report, intervalSeconds: 0.001, staleSeconds: 30, reportSeconds: 0, once: true });
    assert.equal((await readFile(report, "utf8")).includes('"event":"heartbeat"'), true);
    await writeAtomicJson(statePath, { status: "completed", heartbeat: { at: new Date().toISOString() }, instances: [] });
    await runWatchdog({ state: statePath, report, intervalSeconds: 0.001, staleSeconds: 30 });
    assert.equal((await readFile(report, "utf8")).includes('"event":"terminal"'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("watchdog checks every active runner", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-supervisor-watchdog-all-"));
  try {
    const report = join(root, "watchdog-report.jsonl");
    const statePath = join(root, "state.json");
    await writeAtomicJson(statePath, {
      status: "running",
      heartbeat: { at: new Date().toISOString(), supervisor: await processIdentity() },
      instances: [
        { instance_id: "example__project-1", status: "running", runner: { pid: 99999998, starttime: null } },
        { instance_id: "example__project-2", status: "running", runner: { pid: 99999999, starttime: null } },
      ],
    });
    await runWatchdog({ state: statePath, report, intervalSeconds: 0.001, staleSeconds: 30, once: true });
    const events = (await readFile(report, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(events.filter(event => event.event === "runner-lost").map(event => event.instance_id), [
      "example__project-1", "example__project-2",
    ]);
    assert.equal(events.find(event => event.event === "runner-lost")?.progress, "2/2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("user stop preserves completed results and marks the active instance interrupted", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-supervisor-stop-"));
  try {
    const statePath = join(root, "supervisor-state.json");
    const output = join(root, "predictions.jsonl");
    const manifestPath = join(root, "manifest.json");
    const state = await createSupervisorState(manifestValue, { manifestPath, runRoot: root, output });
    state.instances[0].status = "succeeded";
    state.instances[0].result = { usage: { usd: 1 } };
    state.instances[1].status = "running";
    state.spent_usd = 1;
    await writeAtomicJson(statePath, state);

    const stopped = await stopSupervisor(statePath);
    assert.equal(stopped.status, "failed");
    assert.equal(stopped.failure, "user-stopped");
    assert.equal(stopped.instances[0].status, "succeeded");
    assert.equal(stopped.instances[1].status, "interrupted");
    assert.equal((await readFile(`${output}`, "utf8")).trim().split("\n").length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("user stop interrupts every active runner", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-supervisor-stop-all-"));
  try {
    const statePath = join(root, "supervisor-state.json");
    const output = join(root, "predictions.jsonl");
    const state = await createSupervisorState(manifestValue, {
      manifestPath: join(root, "manifest.json"),
      runRoot: root,
      output,
      workers: 2,
    });
    for (const entry of state.instances) {
      entry.status = "running";
      entry.attempt = 1;
      entry.runner = { pid: 99999999, starttime: null };
    }
    state.reserved_usd = 2;
    await writeAtomicJson(statePath, state);
    const stopped = await stopSupervisor(statePath);
    assert.deepEqual(stopped.instances.map(entry => entry.status), ["interrupted", "interrupted"]);
    assert.deepEqual(stopped.instances.map(entry => entry.runner), [null, null]);
    assert.equal(stopped.reserved_usd, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detached supervisor completes after its launcher returns", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-supervisor-detached-"));
  try {
    const fakeRunner = join(root, "fake-runner.mjs");
    await writeFile(fakeRunner, `import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
const args = process.argv.slice(2);
const value = key => args[args.indexOf(key) + 1];
const output = value("--output");
const metadata = value("--metadata");
await mkdir(dirname(output), { recursive: true });
await mkdir(dirname(metadata), { recursive: true });
await writeFile(output, JSON.stringify({ instance_id: "example__project-1", model_name_or_path: "fake", model_patch: "" }) + "\\n");
await writeFile(metadata, JSON.stringify({ results: [{ instance_id: "example__project-1", status: "failed", exit_code: 1 }] }));
`);
    const manifestPath = join(root, "manifest.json");
    const runRoot = join(root, "run");
    const output = join(root, "predictions.jsonl");
    await writeFile(manifestPath, JSON.stringify({ ...manifestValue, instances: [manifestValue.instances[0]] }));
    const launcher = join(root, "launcher.mjs");
    const supervisorModule = pathToFileURL(join(process.cwd(), "scripts", "swebench-lite-supervisor.mjs")).href;
    await writeFile(launcher, `import { startDetachedSupervisor } from ${JSON.stringify(supervisorModule)};
await startDetachedSupervisor(${JSON.stringify({ manifest: manifestPath, runRoot, output, costLimitUsd: 5, runnerScript: fakeRunner })});
`);
    const launcherExit = await new Promise<number>(resolvePromise => {
      const child = spawn(process.execPath, [launcher], { stdio: "ignore" });
      child.once("close", exit => resolvePromise(exit ?? 1));
    });
    assert.equal(launcherExit, 0);
    const started = { statePath: join(runRoot, "supervisor-state.json") };
    let state;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
      try { state = JSON.parse(await readFile(started.statePath, "utf8")); } catch { continue; }
      if (state.status === "completed") break;
    }
    assert.equal(state?.status, "completed");
    assert.equal((await readFile(output, "utf8")).includes("example__project-1"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
