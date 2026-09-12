import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";

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
});
