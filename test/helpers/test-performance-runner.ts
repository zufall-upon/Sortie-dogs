import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = resolve(import.meta.dirname, "../..");
const deadlineMs = 48_000;
const fullDeadlineMs = 1_800_000;
const observer = pathToFileURL(join(import.meta.dirname, "test-performance-observer.ts")).href;
const setupImport = pathToFileURL(join(projectRoot, "test/setup.ts")).href;

type ChildResult = { exit: number; timed_out: boolean; wall_ms: number; stopped: boolean; output: string };
type CompletedTest = { name: string; path: string; duration_ms: number; phase: string; completion_order: number };
type SuiteTotal = CompletedTest;
type IntegrationGroups = { s01_duration_ms: number; remaining_duration_ms: number; overlap: number };
type FailureFingerprint = { test: string; assertion: string | null; error?: string; code?: string | null; message?: string; location?: string | null };
type SchedulerSummary = {
  files: number;
  enqueued: string[];
  started: string[];
  completed: string[];
  duplicate: { enqueued: number; started: number; completed: number };
  missing: { enqueued: string[]; started: string[]; completed: string[] };
  valid: boolean;
  max_lanes: number;
  transitions: { status: string; paths: string[]; phase: string; at_ms: number }[];
};
type ObservedChild = { pid: number | null; spawned_at_ms: number; closed: boolean; closed_at_ms: number | null };
type DeadlineProfile = {
  schema_version: 1;
  case: string;
  total_ms: number;
  takeover_calls: number;
  takeover_loop_iterations: number;
  stages: Array<{ name: string; duration_ms: number; total_ms: number }>;
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
    const collect = (chunk: Buffer, observe: boolean) => {
      const text = chunk.toString("utf8");
      if (observe) options.observe_output?.(text);
      if (options.collect_output !== false && output.length < 256_000) output += text;
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, true));
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

function completedTestCollector(): { accept: (chunk: string) => void; finish: () => { count: number; leaf_count: number; suite_count: number; top: CompletedTest[]; slow_cases: CompletedTest[]; suite_totals: SuiteTotal[]; integration_groups: IntegrationGroups | null; scheduler: SchedulerSummary | null; failures: FailureFingerprint[]; build_completed: boolean } } {
  let remainder = "";
  const completed: CompletedTest[] = [];
  const suiteTotals: SuiteTotal[] = [];
  const failures: FailureFingerprint[] = [];
  let lastFailure: FailureFingerprint | undefined;
  let startupFailure: FailureFingerprint | undefined;
  const active = new Map<string, { indent: number; name: string; hasChildren: boolean }[]>();
  let pending: { path: string; phase: string; indent: number; name: string; suite: boolean; explicit_type: "test" | "suite" | null; failed: boolean; assertion: string | null; duration_ms: number | null } | undefined;
  let completionOrder = 0;
  let integrationGroups: IntegrationGroups | null = null;
  let scheduler: SchedulerSummary | null = null;
  let buildCompleted = false;
  const finalizePending = () => {
    if (pending === undefined) return;
    const current = pending;
    if (current.duration_ms !== null && current.name.length > 0) {
      const suite = current.explicit_type === "suite" || (current.explicit_type === null && current.suite);
      const destination = suite ? suiteTotals : completed;
      destination.push({ name: current.name, path: current.path, duration_ms: current.duration_ms, phase: current.phase, completion_order: ++completionOrder });
      if (current.failed && !suite && failures.length < 5) {
        lastFailure = { test: `${current.path}: ${current.name}`.slice(0, 200), assertion: current.assertion };
        failures.push(lastFailure);
      }
    }
    const stack = active.get(current.path);
    if (stack !== undefined) {
      const index = stack.findIndex((node) => node.indent === current.indent && node.name === current.name);
      if (index >= 0) stack.splice(index);
    }
    pending = undefined;
  };
  const consume = (line: string) => {
    const uncolored = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "");
    const fileOutput = /^SORTIE_FULL_FILE_OUTPUT\s+(.+)$/u.exec(uncolored);
    let phase = "outer";
    let path = "";
    let clean = uncolored;
    if (fileOutput !== null) {
      try {
        const parsed = JSON.parse(fileOutput[1]!) as { phase: string; path: string; line: string };
        phase = parsed.phase;
        path = parsed.path.replaceAll("\\", "/");
        clean = parsed.line;
      } catch { return; }
    }
    if (clean.trim() === "...") {
      finalizePending();
      return;
    }
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
    const subtest = /^(\s*)# Subtest:\s+(.+?)\s*$/u.exec(clean);
    if (subtest !== null && path.length > 0) {
      if (pending !== undefined) finalizePending();
      const indent = subtest[1]!.length;
      const name = subtest[2]!.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
      const stack = active.get(path) ?? [];
      while (stack.length > 0 && stack.at(-1)!.indent >= indent) stack.pop();
      if (stack.length > 0) stack.at(-1)!.hasChildren = true;
      stack.push({ indent, name, hasChildren: false });
      active.set(path, stack);
      return;
    }
    const completion = /^(\s*)(ok|not ok)\s+\d+\s+-\s+(.+?)\s*$/u.exec(clean);
    if (completion !== null) {
      if (pending !== undefined) finalizePending();
      const indent = completion[1]!.length;
      const pendingName = completion[3]!.replace(/\s+#\s+(?:SKIP|TODO).*$/u, "").replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
      const stack = active.get(path) ?? [];
      const node = [...stack].reverse().find((candidate) => candidate.indent === indent && candidate.name === pendingName);
      pending = { path, phase, indent, name: pendingName, suite: node?.hasChildren === true, explicit_type: null, failed: completion[2] === "not ok", assertion: null, duration_ms: null };
      return;
    }
    const assertion = /^\s*(?:error:\s*)?(AssertionError.*|Expected values to be strictly equal.*|actual:.*|expected:.*)$/u.exec(clean.trim());
    if (assertion !== null && (pending?.failed === true || lastFailure?.assertion === null)) {
      const value = assertion[1]!.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 240);
      if (pending?.failed === true) pending.assertion = value;
      else if (lastFailure !== undefined) lastFailure.assertion = value;
      return;
    }
    const type = /^\s*type:\s*['"]?(test|suite)['"]?\s*$/u.exec(clean);
    if (type !== null && pending !== undefined) {
      pending.explicit_type = type[1] as "test" | "suite";
      return;
    }
    const duration = /^\s*duration_ms:\s*([0-9]+(?:\.[0-9]+)?)\s*$/u.exec(clean);
    if (duration !== null && pending !== undefined) {
      const durationMs = Number(duration[1]);
      if (Number.isFinite(durationMs)) pending.duration_ms = durationMs;
      return;
    }
    const error = /^\s*((?:[A-Za-z]+Error|Error)(?:\s*\[([A-Z0-9_]+)\])?):\s*(.+?)\s*$/u.exec(clean);
    if (path.length > 0 && pending === undefined && error !== null && failures.length < 5) {
      startupFailure = { test: path, assertion: null, error: error[1]!.slice(0, 80), code: error[2] ?? null, message: error[3]!.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 240), location: null };
      failures.push(startupFailure);
      return;
    }
    const code = /^\s*code:\s*['"]?([A-Z0-9_]+)['"]?,?\s*$/u.exec(clean);
    if (startupFailure !== undefined && code !== null) {
      startupFailure.code = code[1]!;
      return;
    }
    const location = /^\s*at\s+(.+?:\d+:\d+)\)?\s*$/u.exec(clean);
    if (startupFailure !== undefined && location !== null && startupFailure.location === null) startupFailure.location = location[1]!.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 240);
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
      finalizePending();
      return {
        count: completed.length,
        leaf_count: completed.length,
        suite_count: suiteTotals.length,
        top: [...completed].sort((left, right) => right.duration_ms - left.duration_ms).slice(0, 10),
        slow_cases: completed.filter((test) => test.duration_ms > 30_000),
        suite_totals: suiteTotals,
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

async function remainingProcesses(children: readonly ObservedChild[]): Promise<ObservedChild[]> {
  const identities = new Map<string, ObservedChild>();
  for (const child of children) {
    if (!child.closed && child.pid !== null) identities.set(`${child.pid}:${child.spawned_at_ms}`, child);
  }
  let remaining = [...identities.values()].filter((child) => processIsAlive(child.pid!));
  const deadline = performance.now() + 3_000;
  while (remaining.length > 0 && performance.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    remaining = remaining.filter((child) => processIsAlive(child.pid!));
  }
  return remaining;
}

async function execute(target: "npm" | "unit6" | "full" | "integration", npmCli?: string, fullConcurrency?: 1, summaryPath?: string): Promise<number> {
  const root = await mkdtemp(join(projectRoot, "_testenv", `test-performance-${target}-`));
  const reports = join(root, "reports");
  const temp = join(root, "temp");
  await mkdir(reports);
  await mkdir(temp);
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: childNodeOptions(), SORTIE_PERF_OUTPUT_DIR: reports, SORTIE_PERF_OBSERVER_MODE: target === "full" ? "process-only" : "profile", TEMP: temp, TMP: temp };
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
  const observedChildren = observed.flatMap((value) => Array.isArray(value.children) ? value.children.filter((item): item is ObservedChild => typeof item === "object" && item !== null && (item as ObservedChild).pid !== undefined) : []);
  const observedChildSpawns = observed.reduce((count, value) => count + (Number.isFinite(Number(value.child_spawns)) ? Number(value.child_spawns) : Array.isArray(value.children) ? value.children.length : 0), 0);
  const observedChildCloses = observed.reduce((count, value) => count + (Number.isFinite(Number(value.child_closes)) ? Number(value.child_closes) : Array.isArray(value.children) ? value.children.filter((child) => typeof child === "object" && child !== null && (child as ObservedChild).closed).length : 0), 0);
  let remainingChildren = boundedTarget ? await remainingProcesses(observedChildren) : null;
  if (boundedTarget && remainingChildren !== null && remainingChildren.length > 0 && result.exit !== 0) {
    const stopped = (await Promise.all(remainingChildren.map((child) => stopOwnedTree(child.pid!)))).every(Boolean);
    result.stopped &&= stopped;
    remainingChildren = await remainingProcesses(observedChildren);
  }
  const observationCoverage = boundedTarget ? {
    mode: target === "full" ? "process-only" : "profile",
    observed_processes: observed.length,
    process_exit_reports: observed.filter((value) => value.process_exit_observed === true).length,
    child_spawns: observedChildSpawns,
    child_closes: observedChildCloses,
    unclosed_children: (remainingChildren ?? []).map((child) => ({ pid: child.pid, spawned_at_ms: child.spawned_at_ms })),
    limitations: ["instrumented Node process tree only", "PID liveness checked only for observed children lacking a close event", "no unrelated process discovery"],
  } : null;
  const coverageValid = !boundedTarget || (observed.length > 0 && observedChildSpawns > 0);
  let cleanup = result.stopped && coverageValid && remainingChildren !== null ? remainingChildren.length === 0 : result.stopped && coverageValid;
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
    suite_totals: completedTests?.suite_totals ?? null,
    integration_groups: completedTests?.integration_groups ?? null,
    scheduler: completedTests?.scheduler ?? null,
    failure_fingerprint: completedTests?.failures ?? null,
    observation_coverage: observationCoverage,
    children_remaining: remainingChildren?.length ?? null,
    raw_log_saved: false,
  };
  if (summaryPath !== undefined) {
    const outputPath = resolve(projectRoot, summaryPath);
    const relativeOutput = relative(projectRoot, outputPath).split(sep).join("/");
    if (relativeOutput.startsWith("../") || !relativeOutput.startsWith("_testenv/") || !relativeOutput.endsWith(".json")) throw new Error("--summary-path must name a .json file inside _testenv");
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(sanitized, null, 2)}\n`);
  }
  console.log(JSON.stringify(sanitized));
  return result.exit;
}

function boundedFailureLines(output: string): string[] {
  const lines = output.split(/\r?\n/u)
    .map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "").replace(/[\u0000-\u001f\u007f]/gu, " ").trim())
    .filter((line) => line.length > 0);
  const failureStart = lines.findIndex((line) => /^not ok\b/u.test(line));
  return lines
    .filter((line, index) => /^(?:not ok\b|(?:[A-Za-z]+Error|Error)(?:\s*\[[A-Z0-9_]+\])?:|(?:error|cause|failureType|code|stack):|at\s+.+?:\d+:\d+)/u.test(line) || (failureStart >= 0 && index > failureStart && index <= failureStart + 12))
    .slice(0, 16)
    .map((line) => line.slice(0, 300));
}

function parseDeadlineProfile(output: string): DeadlineProfile | null {
  const markers = output.split(/\r?\n/u).filter((line) => line.includes("SORTIE_DEADLINE_PROFILE "));
  if (markers.length !== 1 || markers[0]!.length > 16_384) return null;
  const payload = markers[0]!.slice(markers[0]!.indexOf("SORTIE_DEADLINE_PROFILE ") + 24);
  try {
    const value = JSON.parse(payload) as DeadlineProfile;
    if (value.schema_version !== 1 || typeof value.case !== "string" || value.case.length === 0 || value.case.length > 240
      || !Number.isFinite(value.total_ms) || value.total_ms < 0 || value.total_ms > deadlineMs
      || !Number.isInteger(value.takeover_calls) || value.takeover_calls < 1 || value.takeover_calls > 1_000
      || !Number.isInteger(value.takeover_loop_iterations) || value.takeover_loop_iterations < 0 || value.takeover_loop_iterations > 999
      || value.takeover_calls !== value.takeover_loop_iterations + 1 || !Array.isArray(value.stages)
      || value.stages.length < 1 || value.stages.length > 1_100) return null;
    if (value.stages.some(({ name, duration_ms, total_ms }) => !/^[a-z0-9-]+$/u.test(name)
      || !Number.isFinite(duration_ms) || duration_ms < 0 || duration_ms > deadlineMs
      || !Number.isFinite(total_ms) || total_ms < 0 || total_ms > deadlineMs)) return null;
    if (value.stages.some((entry, index) => index > 0 && entry.total_ms < value.stages[index - 1]!.total_ms)) return null;
    return value;
  } catch {
    return null;
  }
}

function selectedProbeCompletion(output: string, name: string): { count: number; duration_ms: number | null } {
  const lines = output.split(/\r?\n/u).map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, ""));
  let count = 0;
  let durationMs: number | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const completion = /^\s*ok\s+\d+\s+-\s+(.+?)\s*$/u.exec(lines[index]!);
    if (completion === null || completion[1]!.replace(/\s+#\s+(?:SKIP|TODO).*$/u, "").trim() !== name
      || /\s+#\s+(?:SKIP|TODO)\b/u.test(completion[1]!)) continue;
    count += 1;
    for (let detail = index + 1; detail < Math.min(lines.length, index + 12); detail += 1) {
      if (/^\s*\.\.\.\s*$/u.test(lines[detail]!)) break;
      const duration = /^\s*duration_ms:\s*([0-9]+(?:\.[0-9]+)?)\s*$/u.exec(lines[detail]!);
      if (duration !== null) durationMs = Number(duration[1]);
    }
  }
  return { count, duration_ms: durationMs };
}

async function selfTest(probeFile?: string, probePattern?: string): Promise<number> {
  const root = await mkdtemp(join(projectRoot, "_testenv", "test-performance-self-test-"));
  const reports = join(root, "reports");
  const temp = join(root, "temp");
  await mkdir(reports);
  await mkdir(temp);
  const owned = join(root, "owned.txt");
  await writeFile(owned, "owned");
  const observerEnv = {
    ...process.env,
    NODE_OPTIONS: childNodeOptions(),
    SORTIE_PERF_OUTPUT_DIR: reports,
    SORTIE_PERF_OBSERVER_MODE: "process-only",
    TEMP: temp,
    TMP: temp,
  };
  const quick = await runChild(["-e", "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>{},10)']);c.once('close',()=>{});"], observerEnv);
  const partial = await summaries(reports);
  const slow = await runChild(["-e", "const {spawn}=require('node:child_process');spawn(process.execPath,['-e','setTimeout(()=>{},10000)']);setTimeout(()=>{},10000);"], observerEnv, { deadline_ms: 100 });
  const collector = completedTestCollector();
  const marker = (phase: string, path: string, line: string) => `SORTIE_FULL_FILE_OUTPUT ${JSON.stringify({ phase, path, line })}\n`;
  const synthetic = [
    marker("integration", "test/a.test.ts", "# Subtest: sibling suite one"),
    marker("integration", "test/a.test.ts", "    # Subtest: duplicate leaf"),
    marker("integration", "test/a.test.ts", "    not ok 1 - duplicate leaf"),
    marker("integration", "test/a.test.ts", "      ---"),
    marker("integration", "test/a.test.ts", "      duration_ms: 31001"),
    marker("integration", "test/a.test.ts", "      type: 'test'"),
    marker("integration", "test/a.test.ts", "      error: 'AssertionError: expected nested value'"),
    marker("integration", "test/a.test.ts", "      ..."),
    marker("integration", "test/a.test.ts", "not ok 1 - sibling suite one"),
    marker("integration", "test/a.test.ts", "  ---"),
    marker("integration", "test/a.test.ts", "  type: 'suite'"),
    marker("integration", "test/a.test.ts", "  duration_ms: 41001"),
    marker("integration", "test/a.test.ts", "  ..."),
    marker("integration", "test/a.test.ts", "# Subtest: sibling suite two"),
    marker("integration", "test/a.test.ts", "    # Subtest: second child"),
    marker("integration", "test/a.test.ts", "    ok 1 - second child"),
    marker("integration", "test/a.test.ts", "      ---"),
    marker("integration", "test/a.test.ts", "      type: 'test'"),
    marker("integration", "test/a.test.ts", "      duration_ms: 9"),
    marker("integration", "test/a.test.ts", "      ..."),
    marker("integration", "test/a.test.ts", "ok 2 - sibling suite two"),
    marker("integration", "test/a.test.ts", "  ---"),
    marker("integration", "test/a.test.ts", "  duration_ms: 10"),
    marker("integration", "test/a.test.ts", "  type: 'suite'"),
    marker("integration", "test/a.test.ts", "  ..."),
    marker("integration", "test/a.test.ts", "# Subtest: explicit test parent"),
    marker("integration", "test/a.test.ts", "    # Subtest: nested under test"),
    marker("integration", "test/a.test.ts", "    ok 1 - nested under test"),
    marker("integration", "test/a.test.ts", "      ---"),
    marker("integration", "test/a.test.ts", "      duration_ms: 1"),
    marker("integration", "test/a.test.ts", "      type: 'test'"),
    marker("integration", "test/a.test.ts", "      ..."),
    marker("integration", "test/a.test.ts", "ok 3 - explicit test parent"),
    marker("integration", "test/a.test.ts", "  ---"),
    marker("integration", "test/a.test.ts", "  duration_ms: 2"),
    marker("integration", "test/a.test.ts", "  type: 'test'"),
    marker("integration", "test/a.test.ts", "  ..."),
    marker("nonintegration", "test/b.test.ts", "# Subtest: duplicate leaf"),
    marker("nonintegration", "test/b.test.ts", "ok 1 - duplicate leaf"),
    marker("nonintegration", "test/b.test.ts", "  ---"),
    marker("nonintegration", "test/b.test.ts", "  duration_ms: 12.5"),
    marker("nonintegration", "test/b.test.ts", "  type: 'test'"),
    marker("nonintegration", "test/b.test.ts", "  ..."),
    marker("nonintegration", "test/startup.test.ts", "Error [ERR_SYNTHETIC_START]: synthetic startup failure"),
    marker("nonintegration", "test/startup.test.ts", "    at synthetic (test/startup.test.ts:7:3)"),
    marker("nonintegration", "test/startup.test.ts", "  code: 'ERR_SYNTHETIC_START'"),
  ].join("");
  collector.accept(synthetic.slice(0, 37));
  collector.accept(synthetic.slice(37));
  const collected = collector.finish();
  let probe: { file: string; pattern: string | null; exit: number; timed_out: boolean; cause: string[] | "PASS"; executed_cases: number; duration_ms: number | null; profile: DeadlineProfile | null; observed_processes: number; child_spawns: number; child_closes: number; children_remaining: number } | null = null;
  if (probeFile !== undefined) {
    const probePath = resolve(projectRoot, probeFile);
    const relativeProbe = relative(projectRoot, probePath).split(sep).join("/");
    if (relativeProbe.startsWith("../") || !relativeProbe.startsWith("test/") || !relativeProbe.endsWith(".test.ts") || await stat(probePath).catch(() => undefined) === undefined) {
      probe = { file: relativeProbe, pattern: probePattern ?? null, exit: 2, timed_out: false, cause: ["invalid --probe-file: expected an existing test/*.test.ts"], executed_cases: 0, duration_ms: null, profile: null, observed_processes: 0, child_spawns: 0, child_closes: 0, children_remaining: 0 };
    } else {
      const probeReports = join(root, "probe-reports");
      await mkdir(probeReports);
      const probeResult = await runChild(["--experimental-strip-types", "--import", setupImport, ...(probePattern === undefined ? [] : [`--test-name-pattern=${probePattern}`]), "--test", probePath], { ...observerEnv, SORTIE_PERF_OUTPUT_DIR: probeReports });
      const probeObserved = await summaries(probeReports);
      const profile = parseDeadlineProfile(probeResult.output);
      const completion = probePattern === undefined ? { count: 0, duration_ms: null }
        : selectedProbeCompletion(probeResult.output, profile?.case ?? probePattern);
      const probeChildren = probeObserved.flatMap((value) => Array.isArray(value.children) ? value.children.filter((item): item is ObservedChild => typeof item === "object" && item !== null && (item as ObservedChild).pid !== undefined) : []);
      const probeRemaining = await remainingProcesses(probeChildren);
      let cause: string[] | "PASS" = "PASS";
      if (probeResult.exit !== 0) {
        cause = boundedFailureLines(probeResult.output);
        if (probePattern === undefined) {
          const importDiagnostic = await runChild(["--experimental-strip-types", "--import", setupImport, "--eval", `import(${JSON.stringify(pathToFileURL(probePath).href)})`], { ...observerEnv, SORTIE_PERF_OUTPUT_DIR: probeReports });
          const importCause = boundedFailureLines(importDiagnostic.output);
          if (importCause.length > 0) cause.unshift(...importCause.map((line) => `module-import: ${line}`));
          else cause.unshift(`module-import diagnostic exit ${importDiagnostic.exit}`);
          const source = await readFile(probePath, "utf8");
          for (const match of source.matchAll(/\bfrom\s+["'](\.{1,2}\/[^"']+)["']/gu)) {
            const dependency = resolve(dirname(probePath), match[1]!);
            if (await stat(dependency).catch(() => undefined) === undefined && cause.length < 16) {
              cause.unshift(`Error [ERR_MODULE_NOT_FOUND]: Cannot find module '${dependency}' imported from ${probePath}`.slice(0, 300));
            }
          }
        }
      } else if (probePattern !== undefined && (completion.count !== 1 || completion.duration_ms === null || profile === null || !profile.case.includes(probePattern))) {
        cause = ["selected probe did not produce one non-skipped PASS with duration and a valid matching profile"];
      }
      probe = {
        file: relativeProbe,
        pattern: probePattern ?? null,
        exit: probeResult.exit,
        timed_out: probeResult.timed_out,
        cause,
        executed_cases: completion.count,
        duration_ms: completion.duration_ms,
        profile,
        observed_processes: probeObserved.length,
        child_spawns: probeObserved.reduce((count, value) => count + Number(value.child_spawns ?? 0), 0),
        child_closes: probeObserved.reduce((count, value) => count + Number(value.child_closes ?? 0), 0),
        children_remaining: probeRemaining.length,
      };
    }
  }
  await rm(root, { recursive: true, force: true });
  const cleaned = await stat(root).catch(() => undefined) === undefined;
  const observedChildren = partial.flatMap((value) => Array.isArray(value.children) ? value.children as ObservedChild[] : []);
  const duplicatePaths = collected.top.filter((test) => test.name === "duplicate leaf").map((test) => test.path).sort();
  const collectorValid = collected.leaf_count === 5 && collected.suite_count === 2 && collected.slow_cases.length === 1 && collected.slow_cases[0]?.path === "test/a.test.ts" && collected.suite_totals.some((suite) => suite.name === "sibling suite one" && suite.duration_ms === 41001) && collected.suite_totals.some((suite) => suite.name === "sibling suite two") && collected.top.some((test) => test.name === "explicit test parent") && duplicatePaths.join(",") === "test/a.test.ts,test/b.test.ts" && collected.failures.some((failure) => failure.test.includes("duplicate leaf")) && collected.failures.some((failure) => failure.test === "test/startup.test.ts" && failure.code === "ERR_SYNTHETIC_START" && failure.location?.includes("test/startup.test.ts:7:3") === true);
  const childSpawns = partial.reduce((count, value) => count + Number(value.child_spawns ?? 0), 0);
  const childCloses = partial.reduce((count, value) => count + Number(value.child_closes ?? 0), 0);
  const observationValid = partial.length > 0 && childSpawns > 0 && childSpawns === childCloses && observedChildren.length === 0;
  const probeValid = probe === null || (probe.exit === 0 && probe.cause === "PASS" && probe.observed_processes > 0 && probe.children_remaining === 0);
  const passed = quick.exit === 0 && observationValid && slow.exit === 124 && slow.stopped && cleaned && collectorValid && probeValid;
  console.log(JSON.stringify({ self_test: passed, normal_exit: quick.exit, deadline_exit: slow.exit, stopped: slow.stopped, cleanup: cleaned, process_observation: observationValid, observed_processes: partial.length, observed_child_spawns: childSpawns, observed_child_closes: childCloses, active_children_at_checkpoint: observedChildren.length, collector: collectorValid, leaf_count: collected.leaf_count, suite_count: collected.suite_count, slow_cases: collected.slow_cases, suite_totals: collected.suite_totals, failures: collected.failures, chunk_split: true, nested_sibling_suites: true, explicit_type_ordering: true, test_with_subtests: collected.top.some((test) => test.name === "explicit test parent"), same_name_distinct_paths: duplicatePaths.length === 2, startup_failure_fingerprint: collected.failures.find((failure) => failure.test === "test/startup.test.ts") ?? null, probe, raw_log_saved: false }));
  return passed ? 0 : 1;
}

const self = process.argv.includes("--self-test");
const probeFile = process.argv.find((value) => value.startsWith("--probe-file="))?.slice(13);
const probePattern = process.argv.find((value) => value.startsWith("--probe-pattern="))?.slice(16);
const targetArgument = process.argv.find((value) => value.startsWith("--target="))?.slice(9);
const npmCli = process.argv.find((value) => value.startsWith("--npm-cli="))?.slice(10);
const summaryPath = process.argv.find((value) => value.startsWith("--summary-path="))?.slice(15);
const fullConcurrencyArguments = process.argv.filter((value) => value.startsWith("--full-concurrency=")).map((value) => value.slice(19));
const fullConcurrency = fullConcurrencyArguments.length === 0 ? undefined : fullConcurrencyArguments.length === 1 && fullConcurrencyArguments[0] === "1" ? 1 : null;
process.exitCode = self ? await selfTest(probeFile, probePattern) : (targetArgument === "npm" || targetArgument === "unit6" || targetArgument === "full" || targetArgument === "integration") && fullConcurrency !== null && (fullConcurrency === undefined || targetArgument === "full")
  ? await execute(targetArgument, npmCli, fullConcurrency, summaryPath)
  : 2;
