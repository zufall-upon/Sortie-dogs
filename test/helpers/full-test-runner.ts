import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

const projectRoot = resolve(import.meta.dirname, "../..");
const testRoot = resolve(projectRoot, "test");
const suiteDeadlineMs = 1_790_000;
const startMarker = "SORTIE_FULL_TEST_RUNNER_STARTED";
const phase2Concurrency = 1;
const s01Paths = new Set([
  "test/integration/worktree-parallel-dispatch.test.ts",
]);
const distMutatingPaths = new Set([
  "test/plugin-loader.test.ts",
]);
const processExclusivePaths = new Set([
  "test/child-lifecycle-runtime.test.ts",
]);

type Partition = {
  all: string[];
  distMutating: string[];
  processExclusive: string[];
  integration: string[];
  s01: string[];
  integrationRemaining: string[];
  heavy: string[];
  light: string[];
  remainingAll: string[];
};
type ChildResult = { exit: number; stopped: boolean };
type ExecutionStatus = "enqueued" | "started" | "completed";
type ExecutionTransition = { status: ExecutionStatus; paths: string[]; phase: string; at_ms: number };
type ExecutionRecord = { enqueued: string[]; started: string[]; completed: string[]; transitions: ExecutionTransition[] };

function normalized(path: string): string {
  return path.split(sep).join("/");
}

async function partitionTests(): Promise<Partition> {
  const entries = await readdir(testRoot, { recursive: true, withFileTypes: true });
  const all = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => normalized(relative(projectRoot, resolve(entry.parentPath, entry.name))))
    .sort();
  const distMutating = all.filter((path) => distMutatingPaths.has(path));
  const processExclusive = all.filter((path) => processExclusivePaths.has(path));
  const integration = all.filter((path) => path.startsWith("test/integration/"));
  const s01 = integration.filter((path) => s01Paths.has(path));
  const integrationRemaining = integration.filter((path) => !s01Paths.has(path));
  const heavy = all.filter((path) => !distMutating.includes(path) && !processExclusive.includes(path) && !integration.includes(path) && basename(path).includes("worktree"));
  const light = all.filter((path) => !distMutating.includes(path) && !processExclusive.includes(path) && !integration.includes(path) && !heavy.includes(path));
  return { all, distMutating, processExclusive, integration, s01, integrationRemaining, heavy, light, remainingAll: [...integrationRemaining, ...light, ...heavy] };
}

function validPartition({ all, distMutating, processExclusive, integration, s01, integrationRemaining, heavy, light, remainingAll }: Partition): boolean {
  const classified = [...distMutating, ...processExclusive, ...integration, ...heavy, ...light];
  return new Set(all).size === all.length
    && new Set(classified).size === classified.length
    && classified.length === all.length
    && distMutating.length === distMutatingPaths.size
    && distMutating.every((path) => distMutatingPaths.has(path))
    && [...distMutatingPaths].every((path) => distMutating.includes(path))
    && distMutating.every((path) => !processExclusive.includes(path) && !integration.includes(path) && !heavy.includes(path) && !light.includes(path))
    && processExclusive.length === processExclusivePaths.size
    && processExclusive.every((path) => processExclusivePaths.has(path))
    && [...processExclusivePaths].every((path) => processExclusive.includes(path))
    && processExclusive.every((path) => !distMutating.includes(path) && !integration.includes(path) && !heavy.includes(path) && !light.includes(path))
    && s01.length === s01Paths.size
    && s01.every((path) => s01Paths.has(path))
    && s01.every((path) => integration.includes(path))
    && integrationRemaining.length === integration.length - s01.length
    && new Set(integrationRemaining).size === integrationRemaining.length
    && integrationRemaining.every((path) => integration.includes(path) && !s01.includes(path))
    && remainingAll.length === integrationRemaining.length + light.length + heavy.length
    && new Set(remainingAll).size === remainingAll.length
    && integrationRemaining.every((path, index) => remainingAll[index] === path)
    && heavy.every((path) => !distMutating.includes(path) && !processExclusive.includes(path) && !integration.includes(path) && !light.includes(path))
    && light.every((path) => !distMutating.includes(path) && !processExclusive.includes(path) && !integration.includes(path) && !heavy.includes(path))
    && all.every((path) => classified.includes(path));
}

async function stopOwnedTree(pid: number): Promise<boolean> {
  if (process.platform !== "win32") {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already closed */ }
    return true;
  }
  return await new Promise<boolean>((resolvePromise) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
    const guard = setTimeout(() => { killer.kill(); resolvePromise(false); }, 3_000);
    killer.once("close", () => { clearTimeout(guard); resolvePromise(true); });
    killer.once("error", () => { clearTimeout(guard); resolvePromise(false); });
  });
}

async function runPhase(
  path: string,
  concurrency: number | undefined,
  deadlineMs: number,
  batch: string,
  signal?: AbortSignal,
): Promise<ChildResult> {
  if (deadlineMs <= 0) return { exit: 124, stopped: true };
  const args = ["--experimental-strip-types", "--import", "./test/setup.ts", "--test", "--test-reporter=tap"];
  if (concurrency !== undefined) args.push(`--test-concurrency=${concurrency}`);
  args.push(path);
  return await new Promise<ChildResult>((resolvePromise) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      env: process.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["inherit", "pipe", "pipe"],
    });
    const forward = (stream: NodeJS.ReadableStream, destination: NodeJS.WritableStream) => {
      let remainder = "";
      stream.on("data", (chunk: Buffer) => {
        remainder += chunk.toString("utf8");
        const lines = remainder.split(/\r?\n/u);
        remainder = lines.pop() ?? "";
        for (const line of lines) destination.write(`SORTIE_FULL_FILE_OUTPUT ${JSON.stringify({ phase: batch, path, line })}\n`);
      });
      stream.on("end", () => {
        if (remainder.length > 0) destination.write(`SORTIE_FULL_FILE_OUTPUT ${JSON.stringify({ phase: batch, path, line: remainder })}\n`);
      });
    };
    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stdout);
    let timedOut = false;
    let stopped = true;
    let stopDone = true;
    let closed = false;
    let exit = 1;
    let settled = false;
    let stopPromise: Promise<void> | undefined;
    const stop = (timedOutValue: boolean) => {
      if (closed || stopPromise !== undefined) return;
      timedOut ||= timedOutValue;
      stopDone = false;
      stopPromise = child.pid === undefined ? Promise.resolve().then(() => { stopped = false; }) : stopOwnedTree(child.pid).then((value) => { stopped = value; });
      stopPromise.finally(() => {
        stopDone = true;
        finish();
      });
    };
    const abort = () => stop(false);
    const finish = () => {
      if (closed && stopDone && !settled) {
        settled = true;
        signal?.removeEventListener("abort", abort);
        resolvePromise({ exit: timedOut ? 124 : exit, stopped });
      }
    };
    const deadline = setTimeout(() => stop(true), Math.max(1, deadlineMs));
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", () => {
      clearTimeout(deadline);
      closed = true;
      exit = 1;
      finish();
    });
    child.once("close", (code) => {
      clearTimeout(deadline);
      closed = true;
      exit = code ?? 1;
      finish();
    });
  });
}

function exactExecutionSet(expectedPaths: readonly string[], actualPaths: readonly string[]): boolean {
  const expected = new Set(expectedPaths);
  const actual = new Set(actualPaths);
  return expected.size === expectedPaths.length
    && actual.size === actualPaths.length
    && expected.size === actual.size
    && [...expected].every((path) => actual.has(path));
}

function reportExecution(partition: Partition, record: ExecutionRecord): boolean {
  const enqueuedValid = exactExecutionSet(partition.all, record.enqueued);
  const startedValid = exactExecutionSet(partition.all, record.started);
  const completedValid = exactExecutionSet(partition.all, record.completed);
  const duplicate = {
    enqueued: record.enqueued.length - new Set(record.enqueued).size,
    started: record.started.length - new Set(record.started).size,
    completed: record.completed.length - new Set(record.completed).size,
  };
  const missing = {
    enqueued: partition.all.filter((path) => !record.enqueued.includes(path)),
    started: partition.all.filter((path) => !record.started.includes(path)),
    completed: partition.all.filter((path) => !record.completed.includes(path)),
  };
  const valid = enqueuedValid && startedValid && completedValid;
  console.log(`SORTIE_FULL_SCHEDULER ${JSON.stringify({ files: partition.all.length, enqueued: record.enqueued, started: record.started, completed: record.completed, duplicate, missing, valid, max_lanes: phase2Concurrency, transitions: record.transitions })}`);
  return valid;
}

function recordExecution(record: ExecutionRecord, status: ExecutionStatus, paths: readonly string[], startedAt: number, phase = "scheduler"): void {
  record[status].push(...paths);
  record.transitions.push({ status, paths: [...paths], phase, at_ms: Math.round(performance.now() - startedAt) });
}

async function runBatch(
  paths: readonly string[],
  concurrency: number,
  batch: string,
  remaining: () => number,
  record: ExecutionRecord,
  startedAt: number,
  controller: AbortController,
): Promise<ChildResult> {
  if (paths.length === 0) return { exit: 0, stopped: true };
  if (controller.signal.aborted) return { exit: 1, stopped: true };
  for (const path of paths) {
    if (controller.signal.aborted) return { exit: 1, stopped: true };
    recordExecution(record, "started", [path], startedAt, batch);
    const result = await runPhase(path, concurrency, remaining(), batch, controller.signal);
    if (result.exit === 0 && result.stopped) recordExecution(record, "completed", [path], startedAt, batch);
    if (result.exit !== 0 || !result.stopped) {
      controller.abort();
      return result;
    }
  }
  return { exit: 0, stopped: true };
}

async function runScheduledTests(partition: Partition, remaining: () => number, record: ExecutionRecord, startedAt: number): Promise<ChildResult> {
  const controller = new AbortController();
  const distMutating = await runBatch(partition.distMutating, 1, "dist-mutating", remaining, record, startedAt, controller);
  if (distMutating.exit !== 0 || !distMutating.stopped) return distMutating;
  const integration = [...partition.s01, ...partition.integrationRemaining];
  const nonintegration = [...partition.heavy, ...partition.light];
  const integrationResult = await runBatch(integration, 1, "integration", remaining, record, startedAt, controller);
  if (integrationResult.exit !== 0 || !integrationResult.stopped) return integrationResult;
  return await runBatch(nonintegration, 1, "nonintegration", remaining, record, startedAt, controller);
}

async function selfTest(): Promise<number> {
  const partition = await partitionTests();
  const partitionValid = validPartition(partition);
  const integrationPhaseValid = partition.s01.every((path) => !partition.integrationRemaining.includes(path))
    && partition.integrationRemaining.every((path) => partition.integration.includes(path));
  const disjoint = partition.heavy.every((path) => !partition.light.includes(path));
  const concurrencyValid = phase2Concurrency === 1;
  const nonintegration = [...partition.heavy, ...partition.light];
  const schedulerPartitionValid = exactExecutionSet(partition.all, [...partition.distMutating, ...partition.processExclusive, ...partition.integration, ...nonintegration]);
  const batchLanesValid = partition.processExclusive.every((path) => !partition.integration.includes(path) && !nonintegration.includes(path))
    && partition.integration.every((path) => !nonintegration.includes(path));
  const root = await mkdtemp(join(projectRoot, "_testenv", "full-test-runner-self-test-"));
  const fixture = join(root, "timeout.test.ts");
  await writeFile(fixture, "import { test } from 'node:test';\ntest('timeout cleanup fixture', async () => await new Promise(() => {}));\n");
  const timeout = await runPhase(fixture, undefined, 20, "self-test");
  const successFixture = join(root, "success.test.ts");
  const failureFixture = join(root, "failure.test.ts");
  const unstartedFixture = join(root, "unstarted.test.ts");
  await writeFile(successFixture, "import { test } from 'node:test';\ntest('success fixture', () => {});\n");
  await writeFile(failureFixture, "import { test } from 'node:test';\ntest('failure fixture', () => { throw new Error('expected self-test failure'); });\n");
  await writeFile(unstartedFixture, "import { test } from 'node:test';\ntest('must remain unstarted', () => {});\n");
  const fixtureRecord: ExecutionRecord = { enqueued: [successFixture, failureFixture, unstartedFixture], started: [], completed: [], transitions: [] };
  const fixtureResult = await runBatch([successFixture, failureFixture, unstartedFixture], 1, "self-test-files", () => 10_000, fixtureRecord, performance.now(), new AbortController());
  await rm(root, { recursive: true, force: true });
  const cleanup = timeout.exit === 124 && timeout.stopped;
  const failedPathValid = fixtureResult.exit !== 0 && fixtureRecord.started.length === 2 && fixtureRecord.completed.length === 1 && fixtureRecord.completed[0] === successFixture && fixtureRecord.started[1] === failureFixture && !fixtureRecord.started.includes(unstartedFixture);
  const passed = partitionValid && integrationPhaseValid && disjoint && concurrencyValid && schedulerPartitionValid && batchLanesValid && cleanup && failedPathValid;
  console.log(JSON.stringify({ self_test: passed, files: partition.all.length, dist_mutating: partition.distMutating.length, process_exclusive: partition.processExclusive.length, integration: partition.integration.length, s01: partition.s01.length, integration_remaining: partition.integrationRemaining.length, heavy: partition.heavy.length, light: partition.light.length, remaining_all: partition.remainingAll.length, partition: partitionValid, duplicate_files: partition.all.length - new Set([...partition.distMutating, ...partition.processExclusive, ...partition.integration, ...partition.heavy, ...partition.light]).size, dist_mutating_disjoint: partition.distMutating.every((path) => !partition.processExclusive.includes(path) && !partition.integration.includes(path) && !partition.heavy.includes(path) && !partition.light.includes(path)), process_exclusive_disjoint: partition.processExclusive.every((path) => !partition.distMutating.includes(path) && !partition.integration.includes(path) && !partition.heavy.includes(path) && !partition.light.includes(path)), integration_phase: integrationPhaseValid, integration_remaining_first: partition.integrationRemaining.every((path, index) => partition.remainingAll[index] === path), heavy_light_disjoint: disjoint, scheduler_partition: schedulerPartitionValid, scheduler_batch_lanes: batchLanesValid, scheduler_max_lanes: phase2Concurrency, scheduler_nonintegration_concurrency: 1, total_deadline_ms: suiteDeadlineMs, phase_deadlines: "absolute-remaining", remaining_concurrency: phase2Concurrency, concurrency: concurrencyValid, timeout_exit: timeout.exit, stopped: timeout.stopped, cleanup, failed_path: failureFixture, failed_path_identified: failedPathValid, unstarted_path: unstartedFixture, unstarted_preserved: !fixtureRecord.started.includes(unstartedFixture), raw_log_saved: false }));
  return passed ? 0 : 1;
}

async function execute(): Promise<number> {
  console.log(startMarker);
  const startedAt = performance.now();
  const deadline = startedAt + suiteDeadlineMs;
  const remaining = () => Math.ceil(deadline - performance.now());
  const partition = await partitionTests();
  if (!validPartition(partition)) return 2;
  const record: ExecutionRecord = { enqueued: [], started: [], completed: [], transitions: [] };
  recordExecution(record, "enqueued", partition.all, startedAt);
  const processController = new AbortController();
  const processExclusive = await runBatch(partition.processExclusive, 1, "process-exclusive", remaining, record, startedAt, processController);
  if (processExclusive.exit !== 0 || !processExclusive.stopped) {
    reportExecution(partition, record);
    return processExclusive.exit || 1;
  }
  const scheduled = await runScheduledTests(partition, remaining, record, startedAt);
  const exact = reportExecution(partition, record);
  return scheduled.exit === 0 && scheduled.stopped && exact ? 0 : scheduled.exit || 1;
}

process.exitCode = process.argv.includes("--self-test") ? await selfTest() : await execute();
