import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = resolve(import.meta.dirname, "../..");
const deadlineMs = 48_000;
const fullDeadlineMs = 1_800_000;
const observer = pathToFileURL(join(import.meta.dirname, "test-performance-observer.ts")).href;

type ChildResult = { exit: number; timed_out: boolean; wall_ms: number; stopped: boolean; output: string };
type CompletedTest = { name: string; duration_ms: number; phase: string; completion_order: number };
type IntegrationGroups = { s01_duration_ms: number; remaining_duration_ms: number; overlap: number };
type FailureFingerprint = { test: string; assertion: string | null };
type SchedulerSummary = {
  files: number;
  enqueued: string[];
  started: string[];
  completed: string[];
  duplicate: { enqueued: number; started: number; completed: number };
  missing: { enqueued: string[]; started: string[]; completed: string[] };
  valid: boolean;
  max_lanes: number;
  transitions: { status: string; paths: string[]; at_ms: number }[];
};

function childNodeOptions(includeObserver = true): string {
  const escapedObserver = observer.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const inherited = includeObserver
    ? process.env.NODE_OPTIONS
    : process.env.NODE_OPTIONS?.replace(new RegExp(`(?:^|\\s)--import(?:=|\\s+)(?:"${escapedObserver}"|'${escapedObserver}'|${escapedObserver})(?=\\s|$)`, "gu"), " ").trim();
  return [inherited, "--experimental-strip-types", includeObserver ? `--import=${observer}` : undefined].filter(Boolean).join(" ");
}

async function stopOwnedTree(pid: number): Promise<boolean> {
  if (process.platform !== "win32") {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already closed */ }
    return true;
  }
  return await new Promise<boolean>((resolvePromise) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { shell: false, windowsHide: true });
    const guard = setTimeout(() => { killer.kill(); resolvePromise(false); }, 3_000);
    killer.once("close", () => { clearTimeout(guard); resolvePromise(true); });
    killer.once("error", () => { clearTimeout(guard); resolvePromise(false); });
  });
}

async function runChild(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  options: { deadline_ms?: number; collect_output?: boolean; observe_output?: (chunk: string) => void } = {},
): Promise<ChildResult> {
  const started = performance.now();
  return await new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot, env, shell: false, windowsHide: true, detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      options.observe_output?.(text);
      if (options.collect_output !== false && output.length < 256_000) output += text;
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    let timedOut = false;
    let stopped = true;
    let closed = false;
    let stopDone = true;
    let exitCode = 1;
    const finish = () => {
      if (!closed || !stopDone) return;
      resolvePromise({ exit: timedOut ? 124 : exitCode, timed_out: timedOut, wall_ms: Math.round(performance.now() - started), stopped, output });
    };
    const deadline = setTimeout(async () => {
      if (child.exitCode !== null) return;
      timedOut = true;
      stopDone = false;
      stopped = await stopOwnedTree(child.pid!);
      stopDone = true;
      finish();
    }, options.deadline_ms ?? deadlineMs);
    child.once("close", (code) => {
      clearTimeout(deadline);
      exitCode = code ?? 1;
      closed = true;
      finish();
    });
  });
}

function completedTestCollector(): { accept: (chunk: string) => void; finish: () => { count: number; leaf_count: number; top: CompletedTest[]; slow_cases: CompletedTest[]; integration_groups: IntegrationGroups | null; scheduler: SchedulerSummary | null; failures: FailureFingerprint[]; build_completed: boolean } } {
  let remainder = "";
  const pendingNames = new Map<string, string>();
  let reportedTests: number | null = null;
  const completed: CompletedTest[] = [];
  const failures: FailureFingerprint[] = [];
  let integrationGroups: IntegrationGroups | null = null;
  let scheduler: SchedulerSummary | null = null;
  let buildCompleted = false;
  const consume = (line: string) => {
    const uncolored = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "");
    const batchOutput = /^SORTIE_FULL_BATCH_OUTPUT\s+(\S+)\s?(.*)$/u.exec(uncolored);
    const phase = batchOutput?.[1] ?? "outer";
    const clean = batchOutput?.[2] ?? uncolored;
    if (clean.trim() === "SORTIE_FULL_TEST_RUNNER_STARTED") {
      buildCompleted = true;
      return;
    }
    const groups = /^\s*(?:#\s*)?SORTIE_INTEGRATION_GROUPS\s+(.+)\s*$/u.exec(clean);
    if (groups !== null) {
      try {
        const parsed = JSON.parse(groups[1]!) as IntegrationGroups;
        integrationGroups = integrationGroups === null ? parsed : {
          s01_duration_ms: integrationGroups.s01_duration_ms + parsed.s01_duration_ms,
          remaining_duration_ms: integrationGroups.remaining_duration_ms + parsed.remaining_duration_ms,
          overlap: integrationGroups.overlap + parsed.overlap,
        };
      } catch { /* malformed test output */ }
      return;
    }
    const schedulerMarker = /^\s*(?:#\s*)?SORTIE_FULL_SCHEDULER\s+(.+)\s*$/u.exec(clean);
    if (schedulerMarker !== null) {
      try {
        const parsed = JSON.parse(schedulerMarker[1]!) as SchedulerSummary;
        scheduler = {
          files: parsed.files,
          enqueued: parsed.enqueued,
          started: parsed.started,
          completed: parsed.completed,
          duplicate: parsed.duplicate,
          missing: parsed.missing,
          valid: parsed.valid,
          max_lanes: parsed.max_lanes,
          transitions: parsed.transitions,
        };
      } catch { /* malformed runner marker */ }
      return;
    }
    const testSummary = /^\s*(?:ℹ|#)\s+tests\s+(\d+)\s*$/u.exec(clean);
    if (testSummary !== null) {
      reportedTests = (reportedTests ?? 0) + Number(testSummary[1]);
      return;
    }
    const specCompletion = /^\s*[✔✖]\s+(.+?)\s+\(([0-9]+(?:\.[0-9]+)?)ms\)\s*$/u.exec(clean);
    if (specCompletion !== null) {
      completed.push({ name: specCompletion[1]!.replace(/[\u0000-\u001f\u007f]/gu, " ").trim(), duration_ms: Number(specCompletion[2]), phase, completion_order: completed.length + 1 });
      if (/^\s*✖/u.test(clean) && failures.length < 5) failures.push({ test: specCompletion[1]!.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 200), assertion: null });
      return;
    }
    const completion = /^\s*(?:ok|not ok)\s+\d+\s+-\s+(.+?)\s*$/u.exec(clean);
    if (completion !== null) {
      const pendingName = completion[1]!.replace(/\s+#\s+(?:SKIP|TODO).*$/u, "").replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
      pendingNames.set(phase, pendingName);
      if (/^\s*not ok/u.test(clean) && failures.length < 5) failures.push({ test: pendingName, assertion: null });
      return;
    }
    const assertion = /^\s*(?:error:\s*)?(AssertionError.*|Expected values to be strictly equal.*|actual:.*|expected:.*)$/u.exec(clean.trim());
    if (assertion !== null && failures.length > 0 && failures.at(-1)!.assertion === null) {
      failures.at(-1)!.assertion = assertion[1]!.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 240);
      return;
    }
    const duration = /^\s*duration_ms:\s*([0-9]+(?:\.[0-9]+)?)\s*$/u.exec(clean);
    const pendingName = pendingNames.get(phase);
    if (duration === null || pendingName === undefined) return;
    const durationMs = Number(duration[1]);
    if (pendingName.length > 0 && Number.isFinite(durationMs)) completed.push({ name: pendingName, duration_ms: durationMs, phase, completion_order: completed.length + 1 });
    pendingNames.delete(phase);
  };
  return {
    accept(chunk) {
      remainder += chunk;
      const lines = remainder.split(/\r?\n/u);
      remainder = lines.pop() ?? "";
      for (const line of lines) consume(line);
    },
    finish() {
      if (remainder.length > 0) consume(remainder);
      return {
        count: completed.length,
        leaf_count: reportedTests ?? completed.length,
        top: [...completed].sort((left, right) => right.duration_ms - left.duration_ms).slice(0, 10),
        slow_cases: completed.filter((test) => test.duration_ms > 30_000),
        integration_groups: integrationGroups,
        scheduler,
        failures,
        build_completed: buildCompleted,
      };
    },
  };
}

async function summaries(directory: string): Promise<Record<string, unknown>[]> {
  const values: Record<string, unknown>[] = [];
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".json")) continue;
    try { values.push(JSON.parse(await readFile(join(directory, name), "utf8")) as Record<string, unknown>); } catch { /* partial checkpoint */ }
  }
  return values;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function remainingProcesses(pids: readonly number[]): Promise<number> {
  let remaining = [...new Set(pids)].filter(processIsAlive);
  const deadline = performance.now() + 3_000;
  while (remaining.length > 0 && performance.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    remaining = remaining.filter(processIsAlive);
  }
  return remaining.length;
}

async function execute(target: "npm" | "unit6" | "full" | "integration", npmCli?: string, fullConcurrency?: 1): Promise<number> {
  const root = await mkdtemp(join(projectRoot, "_testenv", `test-performance-${target}-`));
  const reports = join(root, "reports");
  const temp = join(root, "temp");
  await mkdir(reports);
  await mkdir(temp);
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: childNodeOptions(target !== "full"), SORTIE_PERF_OUTPUT_DIR: reports, TEMP: temp, TMP: temp };
  if (target === "full") delete env.SORTIE_PERF_OUTPUT_DIR;
  const boundedTarget = target === "full" || target === "integration";
  const args = target === "npm" || boundedTarget
    ? [npmCli ?? "", ...(target === "full" ? ["run", "test:full", ...(fullConcurrency === 1 ? ["--", "--test-concurrency=1"] : [])] : target === "integration" ? ["run", "test:integration"] : ["test"])]
    : ["--experimental-strip-types", join(import.meta.dirname, "heavy-case-profile.ts")];
  if ((target === "npm" || boundedTarget) && !npmCli) throw new Error(`--npm-cli is required for ${target} target`);
  const testCollector = boundedTarget ? completedTestCollector() : undefined;
  const result = await runChild(args, env, boundedTarget ? {
    deadline_ms: fullDeadlineMs,
    collect_output: false,
    observe_output: (chunk) => testCollector!.accept(chunk),
  } : {});
  const completedTests = testCollector?.finish() ?? null;
  const observed = await summaries(reports);
  const fixtureRoots = observed.flatMap((value) => Array.isArray(value.fixture_roots) ? value.fixture_roots.filter((item): item is string => typeof item === "string") : []);
  const observedPids = observed.flatMap((value) => typeof value.pid === "number" ? [value.pid] : []);
  let childrenRemaining = boundedTarget ? await remainingProcesses(observedPids) : null;
  if (boundedTarget && childrenRemaining !== null && childrenRemaining > 0 && result.exit !== 0) {
    const living = [...new Set(observedPids)].filter(processIsAlive);
    const stopped = (await Promise.all(living.map(stopOwnedTree))).every(Boolean);
    result.stopped &&= stopped;
    childrenRemaining = await remainingProcesses(observedPids);
  }
  let cleanup = result.stopped && childrenRemaining !== null ? childrenRemaining === 0 : result.stopped;
  if (cleanup) {
    for (const path of fixtureRoots) {
      if (await stat(path).catch(() => undefined) !== undefined) await rm(path, { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
    if (boundedTarget) cleanup = await stat(root).catch(() => undefined) === undefined;
  }
  const phases: Record<string, { processes: number; wall_ms: number; git_processes: number; write_count: number; write_bytes: number; state_count: number; state_bytes: number; temp_count: number; temp_bytes: number; observer_writes: number; methods: Record<string, unknown> }> = {};
  for (const value of observed) {
    const phase = String(value.phase);
    const entry = phases[phase] ??= { processes: 0, wall_ms: 0, git_processes: 0, write_count: 0, write_bytes: 0, state_count: 0, state_bytes: 0, temp_count: 0, temp_bytes: 0, observer_writes: 0, methods: {} };
    const writes = value.writes as { count?: number; bytes?: number } | undefined;
    const state = value.state_writes as { count?: number; bytes?: number } | undefined;
    const temporary = value.temp_writes as { count?: number; bytes?: number } | undefined;
    entry.processes += 1;
    entry.wall_ms = Math.max(entry.wall_ms, Number(value.wall_ms) || 0);
    entry.git_processes += Number(value.git_processes) || 0;
    entry.write_count += writes?.count ?? 0;
    entry.write_bytes += writes?.bytes ?? 0;
    entry.state_count += state?.count ?? 0;
    entry.state_bytes += state?.bytes ?? 0;
    entry.temp_count += temporary?.count ?? 0;
    entry.temp_bytes += temporary?.bytes ?? 0;
    entry.observer_writes += Number(value.observer_writes) || 0;
    Object.assign(entry.methods, value.methods ?? {});
  }
  const sanitized = {
    target, exit: result.exit, timed_out: result.timed_out, wall_ms: result.wall_ms,
    stopped: result.stopped, cleanup,
    build_completed: target === "full" ? completedTests?.build_completed ?? false : target === "npm" || boundedTarget ? observed.some((value) => value.phase === "postbuild") : null,
    case_reached: result.output.includes("a six-unit fabric advances only at the barrier into a fresh exact-base worktree"),
    non_final_reached: result.output.includes("integrateFabricWaveAndValidate advances non-final waves without running supplied validation"),
    phases,
    physical_ssd_io: null,
    git_internal_write_bytes: null,
    completed_tests: completedTests?.count ?? null,
    completed_leaves: completedTests?.leaf_count ?? null,
    top_durations: completedTests?.top ?? null,
    slow_cases: completedTests?.slow_cases ?? null,
    integration_groups: completedTests?.integration_groups ?? null,
    scheduler: completedTests?.scheduler ?? null,
    failure_fingerprint: completedTests?.failures ?? null,
    children_remaining: childrenRemaining,
    raw_log_saved: false,
  };
  console.log(JSON.stringify(sanitized));
  return result.exit;
}

async function selfTest(): Promise<number> {
  const root = await mkdtemp(join(projectRoot, "_testenv", "test-performance-self-test-"));
  const reports = join(root, "reports");
  await mkdir(reports);
  const owned = join(root, "owned.txt");
  await writeFile(owned, "owned");
  const quick = await runChild(["-e", "setTimeout(()=>{},10)"], {
    ...process.env,
    NODE_OPTIONS: childNodeOptions(),
    SORTIE_PERF_OUTPUT_DIR: reports,
  });
  const partial = await summaries(reports);
  const previousDeadline = deadlineMs;
  void previousDeadline;
  const slow = await new Promise<ChildResult>((resolvePromise) => {
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { shell: false, windowsHide: true });
    const started = performance.now();
    let stopped = false;
    let closed = false;
    let stopDone = false;
    const finish = () => {
      if (closed && stopDone) resolvePromise({ exit: 124, timed_out: true, wall_ms: Math.round(performance.now() - started), stopped, output: "" });
    };
    child.once("close", () => { closed = true; finish(); });
    setTimeout(async () => {
      stopped = await stopOwnedTree(child.pid!);
      stopDone = true;
      finish();
    }, 100);
  });
  await rm(root, { recursive: true, force: true });
  const cleaned = await stat(root).catch(() => undefined) === undefined;
  const passed = quick.exit === 0 && partial.length > 0 && slow.exit === 124 && slow.stopped && cleaned;
  console.log(JSON.stringify({ self_test: passed, normal_exit: quick.exit, deadline_exit: slow.exit, stopped: slow.stopped, cleanup: cleaned, partial_report: partial.length > 0 }));
  return passed ? 0 : 1;
}

const self = process.argv.includes("--self-test");
const targetArgument = process.argv.find((value) => value.startsWith("--target="))?.slice(9);
const npmCli = process.argv.find((value) => value.startsWith("--npm-cli="))?.slice(10);
const fullConcurrencyArguments = process.argv.filter((value) => value.startsWith("--full-concurrency=")).map((value) => value.slice(19));
const fullConcurrency = fullConcurrencyArguments.length === 0 ? undefined : fullConcurrencyArguments.length === 1 && fullConcurrencyArguments[0] === "1" ? 1 : null;
process.exitCode = self ? await selfTest() : (targetArgument === "npm" || targetArgument === "unit6" || targetArgument === "full" || targetArgument === "integration") && fullConcurrency !== null && (fullConcurrency === undefined || targetArgument === "full")
  ? await execute(targetArgument, npmCli, fullConcurrency)
  : 2;
