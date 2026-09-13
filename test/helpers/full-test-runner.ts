import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = resolve(import.meta.dirname, "../..");
const testRoot = resolve(projectRoot, "test");
const suiteDeadlineMs = 1_790_000;
const startMarker = "SORTIE_FULL_TEST_RUNNER_STARTED";
const phase2Concurrency = 2;
const timingHistoryPath = join(projectRoot, "_testenv", "full-test-timings.json");
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
export type ExecutionRecord = { enqueued: string[]; started: string[]; completed: string[]; transitions: ExecutionTransition[] };

export async function readTimingHistory(path: string): Promise<Record<string, number>> {
  try {
    const history = JSON.parse(await readFile(path, "utf8"));
    if (history?.schema_version !== 1 || history.platform !== process.platform
      || history.durations_ms === null || typeof history.durations_ms !== "object" || Array.isArray(history.durations_ms)) return {};
    return Object.fromEntries(Object.entries(history.durations_ms)
      .filter(([, duration]) => typeof duration === "number" && Number.isFinite(duration) && duration > 0));
  } catch {
    // Timing history is an optional scheduling hint, never a validation prerequisite.
    return {};
  }
}

export function orderByDuration(paths: readonly string[], durations: Readonly<Record<string, number>>): string[] {
  return [...paths].sort((left, right) => (durations[right] ?? 0) - (durations[left] ?? 0));
}

export async function saveTimingHistory(path: string, record: ExecutionRecord): Promise<void> {
  const starts = new Map<string, number>();
  const durations = new Map<string, number>();
  for (const transition of record.transitions) {
    for (const file of transition.paths) {
      if (transition.status === "started") starts.set(file, transition.at_ms);
      if (transition.status !== "completed") continue;
      const start = starts.get(file);
      if (start !== undefined && transition.at_ms > start) durations.set(file, transition.at_ms - start);
    }
  }
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ schema_version: 1, platform: process.platform,
      durations_ms: Object.fromEntries(durations) }) + "\n");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

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
  const transition = { status, paths: [...paths], phase, at_ms: Math.round(performance.now() - startedAt) };
  record.transitions.push(transition);
  console.log(`SORTIE_FULL_PROGRESS ${JSON.stringify(transition)}`);
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

async function runConcurrentBatch(
  paths: readonly string[],
  laneConcurrency: number,
  testConcurrency: number,
  batch: string,
  remaining: () => number,
  record: ExecutionRecord,
  startedAt: number,
  controller: AbortController,
): Promise<ChildResult> {
  if (paths.length === 0) return { exit: 0, stopped: true };
  let nextIndex = 0;
  let firstFailure: ChildResult | undefined;
  const workers = Array.from({ length: Math.min(laneConcurrency, paths.length) }, async () => {
    while (!controller.signal.aborted) {
      const index = nextIndex++;
      if (index >= paths.length) return;
      const path = paths[index];
      recordExecution(record, "started", [path], startedAt, batch);
      const result = await runPhase(path, testConcurrency, remaining(), batch, controller.signal);
      if (result.exit === 0 && result.stopped) {
        recordExecution(record, "completed", [path], startedAt, batch);
        continue;
      }
      firstFailure ??= result;
      controller.abort();
    }
  });
  await Promise.all(workers);
  return firstFailure ?? { exit: 0, stopped: true };
}

async function runScheduledTests(partition: Partition, remaining: () => number, record: ExecutionRecord, startedAt: number, durations: Readonly<Record<string, number>>): Promise<ChildResult> {
  const controller = new AbortController();
  const distMutating = await runBatch(partition.distMutating, 1, "dist-mutating", remaining, record, startedAt, controller);
  if (distMutating.exit !== 0 || !distMutating.stopped) return distMutating;
  const integration = [...partition.s01, ...partition.integrationRemaining];
  const nonintegration = orderByDuration([...partition.heavy, ...partition.light], durations);
  const integrationResult = await runBatch(integration, 1, "integration", remaining, record, startedAt, controller);
  if (integrationResult.exit !== 0 || !integrationResult.stopped) return integrationResult;
  return await runConcurrentBatch(nonintegration, phase2Concurrency, 1, "nonintegration", remaining, record, startedAt, controller);
}

async function runAllTests(partition: Partition, remaining: () => number, record: ExecutionRecord, startedAt: number, durations: Readonly<Record<string, number>> = {}): Promise<ChildResult> {
  const processController = new AbortController();
  const processExclusive = await runBatch(partition.processExclusive, 1, "process-exclusive", remaining, record, startedAt, processController);
  if (processExclusive.exit !== 0 || !processExclusive.stopped) return processExclusive;
  return await runScheduledTests(partition, remaining, record, startedAt, durations);
}

async function selfTest(): Promise<number> {
  const partition = await partitionTests();
  const partitionValid = validPartition(partition);
  const integrationPhaseValid = partition.s01.every((path) => !partition.integrationRemaining.includes(path))
    && partition.integrationRemaining.every((path) => partition.integration.includes(path));
  const disjoint = partition.heavy.every((path) => !partition.light.includes(path));
  const concurrencyValid = Number.isInteger(phase2Concurrency) && phase2Concurrency > 1;
  const nonintegration = [...partition.heavy, ...partition.light];
  const schedulerPartitionValid = exactExecutionSet(partition.all, [...partition.distMutating, ...partition.processExclusive, ...partition.integration, ...nonintegration]);
  const distMutatingDisjoint = partition.distMutating.every((path) => !partition.processExclusive.includes(path) && !partition.integration.includes(path) && !partition.heavy.includes(path) && !partition.light.includes(path));
  const processExclusiveDisjoint = partition.processExclusive.every((path) => !partition.distMutating.includes(path) && !partition.integration.includes(path) && !partition.heavy.includes(path) && !partition.light.includes(path));
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
  const parallelFixtures = [join(root, "parallel-a.test.ts"), join(root, "parallel-b.test.ts")];
  await Promise.all(parallelFixtures.map(async (path) => await writeFile(path, "import { test } from 'node:test';\ntest('parallel fixture', async () => await new Promise((resolve) => setTimeout(resolve, 100)));\n")));
  const parallelRecord: ExecutionRecord = { enqueued: [...parallelFixtures], started: [], completed: [], transitions: [] };
  const parallelResult = await runConcurrentBatch(parallelFixtures, phase2Concurrency, 1, "self-test-parallel", () => 10_000, parallelRecord, performance.now(), new AbortController());
  const laneFixtures = {
    processExclusive: join(root, "lane-process-exclusive.test.ts"),
    distMutating: join(root, "lane-dist-mutating.test.ts"),
    integration: join(root, "lane-integration.test.ts"),
    nonintegrationA: join(root, "lane-nonintegration-a.test.ts"),
    nonintegrationB: join(root, "lane-nonintegration-b.test.ts"),
  };
  await Promise.all(Object.values(laneFixtures).map(async (path) => await writeFile(path, "import { test } from 'node:test';\ntest('lane fixture', async () => await new Promise((resolve) => setTimeout(resolve, 100)));\n")));
  const lanePartition: Partition = {
    all: Object.values(laneFixtures),
    processExclusive: [laneFixtures.processExclusive],
    distMutating: [laneFixtures.distMutating],
    integration: [laneFixtures.integration],
    s01: [laneFixtures.integration],
    integrationRemaining: [],
    heavy: [laneFixtures.nonintegrationA],
    light: [laneFixtures.nonintegrationB],
    remainingAll: [laneFixtures.nonintegrationB, laneFixtures.nonintegrationA],
  };
  const laneRecord: ExecutionRecord = { enqueued: [...lanePartition.all], started: [], completed: [], transitions: [] };
  const laneResult = await runAllTests(lanePartition, () => 10_000, laneRecord, performance.now());
  await rm(root, { recursive: true, force: true });
  const cleanup = timeout.exit === 124 && timeout.stopped;
  const failedPathValid = fixtureResult.exit !== 0 && fixtureRecord.started.length === 2 && fixtureRecord.completed.length === 1 && fixtureRecord.completed[0] === successFixture && fixtureRecord.started[1] === failureFixture && !fixtureRecord.started.includes(unstartedFixture);
  const firstParallelCompletion = parallelRecord.transitions.findIndex(({ status }) => status === "completed");
  const parallelOverlap = parallelResult.exit === 0 && parallelResult.stopped
    && firstParallelCompletion >= phase2Concurrency
    && parallelRecord.transitions.slice(0, phase2Concurrency).every(({ status }) => status === "started");
  const transitionIndex = (status: ExecutionStatus, phase: string) => laneRecord.transitions.findIndex((transition) => transition.status === status && transition.phase === phase);
  const exclusiveLaneOrder = laneResult.exit === 0 && laneResult.stopped
    && transitionIndex("completed", "process-exclusive") < transitionIndex("started", "dist-mutating")
    && transitionIndex("completed", "dist-mutating") < transitionIndex("started", "integration")
    && transitionIndex("completed", "integration") < transitionIndex("started", "nonintegration")
    && laneRecord.transitions.filter(({ status, phase }) => status === "started" && phase === "nonintegration").length === 2
    && laneRecord.transitions.findIndex(({ status, phase }) => status === "completed" && phase === "nonintegration")
      > laneRecord.transitions.findLastIndex(({ status, phase }) => status === "started" && phase === "nonintegration");
  const passed = partitionValid && integrationPhaseValid && disjoint && concurrencyValid && schedulerPartitionValid && batchLanesValid && cleanup && failedPathValid && parallelOverlap && exclusiveLaneOrder;
  console.log(JSON.stringify({ self_test: passed, files: partition.all.length, dist_mutating: partition.distMutating.length, dist_mutating_paths: partition.distMutating, process_exclusive: partition.processExclusive.length, process_exclusive_paths: partition.processExclusive, integration: partition.integration.length, s01: partition.s01.length, integration_remaining: partition.integrationRemaining.length, heavy: partition.heavy.length, light: partition.light.length, remaining_all: partition.remainingAll.length, partition: partitionValid, duplicate_files: partition.all.length - new Set([...partition.distMutating, ...partition.processExclusive, ...partition.integration, ...partition.heavy, ...partition.light]).size, dist_mutating_disjoint: partition.distMutating.every((path) => !partition.processExclusive.includes(path) && !partition.integration.includes(path) && !partition.heavy.includes(path) && !partition.light.includes(path)), process_exclusive_disjoint: partition.processExclusive.every((path) => !partition.distMutating.includes(path) && !partition.integration.includes(path) && !partition.heavy.includes(path) && !partition.light.includes(path)), integration_phase: integrationPhaseValid, integration_remaining_first: partition.integrationRemaining.every((path, index) => partition.remainingAll[index] === path), heavy_light_disjoint: disjoint, scheduler_partition: schedulerPartitionValid, scheduler_batch_lanes: batchLanesValid, scheduler_max_lanes: phase2Concurrency, scheduler_nonintegration_concurrency: phase2Concurrency, scheduler_serial_lanes: ["process-exclusive", "dist-mutating", "integration"], scheduler_parallel_lanes: ["nonintegration"], parallel_overlap: parallelOverlap, total_deadline_ms: suiteDeadlineMs, phase_deadlines: "absolute-remaining", remaining_concurrency: phase2Concurrency, concurrency: concurrencyValid, timeout_exit: timeout.exit, stopped: timeout.stopped, cleanup, failed_path: failureFixture, failed_path_identified: failedPathValid, unstarted_path: unstartedFixture, unstarted_preserved: !fixtureRecord.started.includes(unstartedFixture), raw_log_saved: false }));
  console.log(JSON.stringify({ self_test: passed, dist_mutating_paths: partition.distMutating, process_exclusive_paths: partition.processExclusive, dist_mutating_disjoint: distMutatingDisjoint, process_exclusive_disjoint: processExclusiveDisjoint, integration_phase: integrationPhaseValid, scheduler_batch_lanes: batchLanesValid, scheduler_serial_lanes: ["process-exclusive", "dist-mutating", "integration"], scheduler_parallel_lanes: ["nonintegration"], scheduler_nonintegration_concurrency: phase2Concurrency, scheduler_max_lanes: phase2Concurrency, parallel_overlap: parallelOverlap, exclusive_lane_order: exclusiveLaneOrder }));
  return passed ? 0 : 1;
}

async function execute(): Promise<number> {
  console.log(startMarker);
  const startedAt = performance.now();
  const deadline = startedAt + suiteDeadlineMs;
  const remaining = () => Math.ceil(deadline - performance.now());
  const partition = await partitionTests();
  if (!validPartition(partition)) return 2;
  const durations = await readTimingHistory(timingHistoryPath);
  const record: ExecutionRecord = { enqueued: [], started: [], completed: [], transitions: [] };
  recordExecution(record, "enqueued", partition.all, startedAt);
  const scheduled = await runAllTests(partition, remaining, record, startedAt, durations);
  const exact = reportExecution(partition, record);
  if (scheduled.exit !== 0 || !scheduled.stopped || !exact) return scheduled.exit || 1;
  try {
    await saveTimingHistory(timingHistoryPath, record);
  } catch {
    console.warn("SORTIE_FULL_TIMINGS_UNAVAILABLE");
  }
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = process.argv.includes("--self-test") ? await selfTest() : await execute();
}
