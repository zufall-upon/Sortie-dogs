import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { orderByDuration, readTimingHistory, saveTimingHistory, type ExecutionRecord } from "./helpers/full-test-runner.ts";

const execFileAsync = promisify(execFile);

test("full test runner preserves exclusive lanes and parallelizes only nonintegration", async () => {
  const { NODE_TEST_CONTEXT: _nodeTestContext, ...env } = process.env;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(process.execPath, [
      "--experimental-strip-types",
      "test/helpers/full-test-runner.ts",
      "--self-test",
    ], { cwd: process.cwd(), env, timeout: 30_000 }));
  } catch (error) {
    const result = error as Error & { stdout?: string; stderr?: string };
    throw new Error(`runner self-test failed\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`, { cause: error });
  }
  const contract = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1) ?? "null") as Record<string, unknown>;

  assert.equal(contract.self_test, true);
  assert.deepEqual(contract.dist_mutating_paths, ["test/plugin-loader.test.ts"]);
  assert.deepEqual(contract.process_exclusive_paths, ["test/child-lifecycle-runtime.test.ts"]);
  assert.equal(contract.dist_mutating_disjoint, true);
  assert.equal(contract.process_exclusive_disjoint, true);
  assert.equal(contract.integration_phase, true);
  assert.equal(contract.scheduler_batch_lanes, true);
  assert.deepEqual(contract.scheduler_serial_lanes, ["process-exclusive", "dist-mutating", "integration"]);
  assert.deepEqual(contract.scheduler_parallel_lanes, ["nonintegration"]);
  assert.equal(contract.scheduler_nonintegration_concurrency, contract.scheduler_max_lanes);
  assert.ok(Number(contract.scheduler_nonintegration_concurrency) > 1);
  assert.equal(contract.parallel_overlap, true);
  assert.equal(contract.exclusive_lane_order, true);
  const progress = stdout.split(/\r?\n/u).filter((line) => line.startsWith("SORTIE_FULL_PROGRESS "))
    .map((line) => JSON.parse(line.slice("SORTIE_FULL_PROGRESS ".length)));
  assert.ok(progress.some(({ phase, status }) => phase === "process-exclusive" && status === "completed"));
  assert.ok(progress.some(({ phase, status }) => phase === "nonintegration" && status === "completed"));
});

test("duration hints reduce the scheduling tail without adding, dropping or mutating paths", () => {
  const paths = ["small-a", "small-b", "long-a", "long-b", "new"];
  const durations = { "small-a": 1, "small-b": 1, "long-a": 8, "long-b": 4, "stale": 100 };
  const ordered = orderByDuration(paths, durations);
  assert.deepEqual(ordered, ["long-a", "long-b", "small-a", "small-b", "new"]);
  assert.deepEqual([...ordered].sort(), [...paths].sort());
  assert.deepEqual(paths, ["small-a", "small-b", "long-a", "long-b", "new"]);
  assert.deepEqual(orderByDuration(paths, {}), paths);
  const makespan = (queue: string[]) => {
    const lanes = [0, 0];
    for (const path of queue) {
      const lane = lanes[0] <= lanes[1] ? 0 : 1;
      lanes[lane] += durations[path as keyof typeof durations] ?? 1;
    }
    return Math.max(...lanes);
  };
  assert.ok(makespan(ordered) < makespan(paths));
});

test("timing history tolerates missing and invalid hints and replaces old successful measurements", async () => {
  const root = await mkdtemp(join(process.cwd(), "_testenv", "full-test-timings-"));
  const path = join(root, "timings.json");
  try {
    assert.deepEqual(await readTimingHistory(path), {});
    await writeFile(path, "incomplete JSON");
    assert.deepEqual(await readTimingHistory(path), {});
    await writeFile(path, JSON.stringify({ schema_version: 1, platform: process.platform,
      durations_ms: { valid: 10, negative: -1, zero: 0, text: "20", missing: null } }));
    assert.deepEqual(await readTimingHistory(path), { valid: 10 });
    const record: ExecutionRecord = { enqueued: [], started: [], completed: [], transitions: [
      { status: "started", paths: ["one", "unfinished"], phase: "nonintegration", at_ms: 2 },
      { status: "completed", paths: ["one"], phase: "nonintegration", at_ms: 7 },
    ] };
    await saveTimingHistory(path, record);
    assert.deepEqual(await readTimingHistory(path), { one: 5 });
    assert.deepEqual(await readdir(root), ["timings.json"]);
    await writeFile(path, JSON.stringify({ schema_version: 1, platform: "different-platform", durations_ms: { one: 5 } }));
    assert.deepEqual(await readTimingHistory(path), {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
