import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile, appendFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCHEMA_VERSION = 1;
const DEFAULT_HEARTBEAT_SECONDS = 5;
const DEFAULT_STALE_SECONDS = 30;
const DEFAULT_REPORT_SECONDS = 120;
const TERMINAL_STATES = new Set(["completed", "failed"]);

const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const ensure = (condition, message) => {
  if (!condition) throw new Error(message);
};
const now = () => new Date().toISOString();
const fingerprint = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sleep = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));

function workerCount(value) {
  const workers = value ?? 1;
  ensure(Number.isInteger(workers) && workers > 0, "supervisor-workers-required");
  return workers;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function writeAtomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx");
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeAtomicText(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx");
    await handle.writeFile(value, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function appendJsonLine(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

async function processStartTime(pid) {
  if (!Number.isInteger(pid) || process.platform === "win32") return null;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(") ");
    const fields = close < 0 ? [] : stat.slice(close + 2).trim().split(/\s+/u);
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

export async function processIdentity(pid = process.pid) {
  return { pid, starttime: await processStartTime(pid) };
}

export async function processAlive(identity) {
  if (!record(identity) || !Number.isInteger(identity.pid)) return false;
  try { process.kill(identity.pid, 0); }
  catch { return false; }
  if (identity.starttime === null || identity.starttime === undefined) return true;
  return (await processStartTime(identity.pid)) === identity.starttime;
}

async function killProcessGroup(identity) {
  if (!record(identity) || !Number.isInteger(identity.pid)) return true;
  if (!await processAlive(identity)) return true;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(identity.pid), "/T", "/F"], {
      stdio: "ignore", windowsHide: true,
    });
    await new Promise(resolvePromise => {
      killer.once("error", resolvePromise);
      killer.once("close", resolvePromise);
    });
    return !(await processAlive(identity));
  }
  try { process.kill(-identity.pid, "SIGTERM"); } catch { /* already stopped */ }
  for (let attempt = 0; attempt < 50 && await processAlive(identity); attempt += 1) await sleep(100);
  if (await processAlive(identity)) {
    try { process.kill(-identity.pid, "SIGKILL"); } catch { /* already stopped */ }
  }
  for (let attempt = 0; attempt < 20 && await processAlive(identity); attempt += 1) await sleep(100);
  return !(await processAlive(identity));
}

export async function acquireRunLock(runRoot) {
  const lockPath = join(runRoot, "supervisor.lock");
  await mkdir(runRoot, { recursive: true });
  const owner = await processIdentity();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await handle.sync();
      return { handle, path: lockPath, owner };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let previous;
      try { previous = await readJson(lockPath); } catch { previous = undefined; }
      if (await processAlive(previous)) throw new Error("supervisor-already-running");
      await rm(lockPath, { force: true });
    }
  }
  throw new Error("supervisor-lock-unavailable");
}

export async function releaseRunLock(lock) {
  await lock?.handle?.close().catch(() => undefined);
  if (lock?.path) await rm(lock.path, { force: true }).catch(() => undefined);
}

function instanceEntry(instance, index) {
  return {
    index,
    instance_id: instance.instance_id,
    status: "pending",
    attempt: 0,
    cost_reservation_usd: null,
    usage_recorded: false,
    runner: null,
    child_output: null,
    child_metadata: null,
    result: null,
  };
}

export async function createSupervisorState(value, options) {
  ensure(record(value) && Array.isArray(value.instances) && value.instances.length > 0, "invalid-supervisor-manifest");
  const supervisor = await processIdentity();
  const workers = workerCount(options.workers);
  return {
    schema_version: SCHEMA_VERSION,
    run_id: options.runId ?? `swebench-${Date.now()}`,
    status: "running",
    created_at: now(),
    updated_at: now(),
    heartbeat: { sequence: 0, at: now(), supervisor },
    manifest: resolve(options.manifestPath),
    output: resolve(options.output),
    metadata: resolve(options.metadata ?? `${options.output}.metadata.json`),
    run_root: resolve(options.runRoot),
    watchdog: { pid: null, report: join(resolve(options.runRoot), "watchdog-report.jsonl") },
    workers,
    input_sha256: fingerprint(value),
    limits: { cost_limit_usd: options.costLimitUsd ?? null, per_instance_usd: options.perInstanceUsd ?? null, workers,
      runner_script: options.runnerScript ? resolve(options.runnerScript) : null,
      prepared_environment: options.preparedEnvironment ?? null },
    policy: { attempts_per_instance: 1, retry_count: 0 },
    spent_usd: 0,
    reserved_usd: 0,
    held_unknown_usd: 0,
    next_index: 0,
    instances: value.instances.map(instanceEntry),
  };
}

async function writeState(state, statePath) {
  state.updated_at = now();
  state.heartbeat.sequence += 1;
  state.heartbeat.at = state.updated_at;
  await writeAtomicJson(statePath, state);
}

function stateWriteQueue(state, statePath) {
  let tail = Promise.resolve();
  return {
    enqueue() {
      const write = tail.then(() => writeState(state, statePath));
      tail = write.catch(() => undefined);
      return write;
    },
    async flush() {
      await tail;
    },
  };
}

async function markInterrupted(state) {
  for (const entry of state.instances) {
    if (entry.status !== "running") continue;
    const runner = entry.runner;
    let metadata;
    if (entry.child_metadata) {
      try { metadata = await readJson(entry.child_metadata); } catch { /* incomplete metadata */ }
    }
    if (runner) await killProcessGroup(runner);
    if (metadata?.results?.[0]) {
      entry.status = metadata.results[0].status ?? "completed";
      entry.result = metadata.results[0];
      const usage = recordedUsage(metadata, entry.result);
      if (entry.usage_recorded !== true && usage !== null && usage > 0) {
        state.spent_usd = (Number.isFinite(state.spent_usd) ? state.spent_usd : 0) + usage;
      }
      entry.usage_usd = usage;
      entry.usage_recorded = true;
    } else {
      entry.status = "interrupted";
      entry.reason = "supervisor-restarted";
    }
    if (metadata?.execution?.usage_complete !== true || entry.usage_usd == null) {
      const hold = Math.max(0, (entry.cost_reservation_usd ?? 0) - (entry.usage_usd ?? 0));
      state.held_unknown_usd = (state.held_unknown_usd ?? 0) + hold;
      entry.held_unknown_usd = hold;
    }
    entry.finished_at = now();
    entry.runner = null;
    entry.cost_reservation_usd = entry.cost_reservation_usd ?? null;
  }
  state.reserved_usd = 0;
  state.next_index = state.instances.findIndex(entry => entry.status === "pending");
  if (state.next_index < 0) state.next_index = state.instances.length;
}

function recordedUsage(metadata, result) {
  const value = metadata?.execution?.spent_usd ?? result?.usage?.usd;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function childPaths(state, entry) {
  const stem = `${String(entry.index).padStart(3, "0")}-${encodeURIComponent(entry.instance_id)}`;
  const root = join(state.run_root, "children", stem);
  return {
    root,
    manifest: join(state.run_root, "manifests", `${stem}.json`),
    output: join(root, "predictions.jsonl"),
    metadata: join(root, "metadata.json"),
    log: join(state.run_root, "logs", `${stem}.log`),
  };
}

async function makeChildManifest(value, state, entry, paths) {
  const child = {
    ...value,
    candidate: {
      ...value.candidate,
      package_tgz: resolve(dirname(state.manifest), value.candidate.package_tgz),
    },
    instances: [value.instances[entry.index]],
  };
  await writeAtomicJson(paths.manifest, child);
}

function runnerScriptPath(options) {
  return resolve(options.runnerScript ?? fileURLToPath(new URL("./swebench-lite-runner.mjs", import.meta.url)));
}

async function spawnRunner(state, entry, paths, options, dependencies) {
  if (dependencies.spawnRunner) return dependencies.spawnRunner(state, entry, paths, options);
  await mkdir(dirname(paths.log), { recursive: true });
  const logFd = openSync(paths.log, "a");
  const args = [runnerScriptPath(options), "--live", "--manifest", paths.manifest,
    "--run-root", paths.root, "--output", paths.output, "--metadata", paths.metadata,
    "--cost-limit-usd", String(options.costLimitUsd),
    ...(options.preparedEnvironment ? ["--prepared-environment", options.preparedEnvironment] : [])];
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...(options.environment ?? {}) },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);
  return { child, identity: await processIdentity(child.pid) };
}

function waitForChild(child) {
  return new Promise(resolvePromise => {
    child.once("error", error => resolvePromise({ exit: 127, signal: error.code ?? "spawn-error" }));
    child.once("close", (exit, signal) => resolvePromise({ exit: exit ?? 1, signal }));
  });
}

export async function finalizeOutput(state) {
  const predictions = [];
  const results = [];
  for (const entry of state.instances) {
    const fallback = JSON.stringify({ instance_id: entry.instance_id, model_name_or_path: state.model_name_or_path, model_patch: "" });
    if (entry.child_output) {
      try {
        const prediction = (await readFile(entry.child_output, "utf8")).trim();
        predictions.push(prediction || fallback);
      } catch { predictions.push(fallback); }
    } else {
      predictions.push(fallback);
    }
    results.push({ instance_id: entry.instance_id, status: entry.status, ...(entry.result ?? {}) });
  }
  await writeAtomicText(state.output, `${predictions.join("\n")}\n`);
  await writeAtomicJson(state.metadata, {
    schema_version: SCHEMA_VERSION,
    run_id: state.run_id,
    status: state.status,
    manifest: state.manifest,
    results,
    supervisor_state: state,
  });
}

export async function stopSupervisor(statePath) {
  ensure(typeof statePath === "string", "supervisor-state-required");
  let state = await readJson(statePath);
  const owner = await readJson(join(state.run_root, "supervisor.lock")).catch(() => null);
  if (await processAlive(owner) && !TERMINAL_STATES.has(state.status)) {
    ensure(owner.pid === state.heartbeat?.supervisor?.pid && owner.starttime === state.heartbeat?.supervisor?.starttime, "supervisor-owner-mismatch");
    ensure(owner.pid !== process.pid, "cannot-stop-own-supervisor");
    await killProcessGroup(owner);
    state = await readJson(statePath);
  }
  const lock = await acquireRunLock(state.run_root);
  const writes = stateWriteQueue(state, statePath);
  try {
    if (state.instances?.some(entry => entry.status === "running")) await markInterrupted(state);
    if (state.watchdog?.pid) await killProcessGroup(state.watchdog.pid);
    state.watchdog ??= { pid: null, report: join(state.run_root, "watchdog-report.jsonl") };
    state.watchdog.pid = null;
    state.status = "failed";
    state.failure = "user-stopped";
    await finalizeOutput(state);
    await writes.enqueue();
    return state;
  } finally {
    await releaseRunLock(lock);
  }
}

export async function runSupervisor(value, options, dependencies = {}) {
  ensure(process.platform !== "win32" || dependencies.allowWindows === true, "supervisor-requires-wsl");
  ensure(typeof options.manifestPath === "string" && typeof options.output === "string" &&
    typeof options.runRoot === "string", "supervisor-paths-required");
  ensure(Number.isFinite(options.costLimitUsd) && options.costLimitUsd > 0, "supervisor-cost-limit-required");
  const runRoot = resolve(options.runRoot);
  const statePath = resolve(options.statePath ?? join(runRoot, "supervisor-state.json"));
  const lock = await acquireRunLock(runRoot);
  let state;
  let watchdog;
  let heartbeatTimer;
  let heartbeatInFlight = false;
  let writes;
  let admitted = false;
  const active = new Map();
  try {
    state = await readJson(statePath).catch(async error => {
      if (error?.code !== "ENOENT") throw error;
      const initial = await createSupervisorState(value, { ...options, runRoot, statePath });
      await writeAtomicJson(statePath, initial);
      return initial;
    });
    ensure(state.schema_version === SCHEMA_VERSION, "invalid-supervisor-state");
    ensure(Array.isArray(state.instances), "invalid-supervisor-state");
    const workers = workerCount(options.workers ?? state.workers);
    ensure(state.input_sha256 === undefined || state.input_sha256 === fingerprint(value), "supervisor-input-changed");
    const limits = state.limits;
    ensure(!limits || ((limits.cost_limit_usd === null || limits.cost_limit_usd === options.costLimitUsd) &&
      limits.per_instance_usd === (options.perInstanceUsd ?? null) && limits.workers === workers &&
      limits.runner_script === (options.runnerScript ? resolve(options.runnerScript) : null) &&
      (limits.prepared_environment ?? null) === (options.preparedEnvironment ?? null)), "supervisor-limits-changed");
    ensure(options.perInstanceUsd === undefined || (Number.isFinite(options.perInstanceUsd) && options.perInstanceUsd > 0), "supervisor-instance-limit-invalid");
    admitted = true;
    state.input_sha256 ??= fingerprint(value);
    state.held_unknown_usd ??= 0;
    state.workers = workers;
    state.policy ??= { attempts_per_instance: 1, retry_count: 0 };
    state.policy.attempts_per_instance = 1;
    state.policy.retry_count = 0;
    state.spent_usd = Number.isFinite(state.spent_usd) ? state.spent_usd : 0;
    state.reserved_usd = Number.isFinite(state.reserved_usd) ? state.reserved_usd : 0;
    state.heartbeat ??= { sequence: 0, at: now(), supervisor: await processIdentity() };
    state.heartbeat.sequence = Number.isInteger(state.heartbeat.sequence) ? state.heartbeat.sequence : 0;
    state.watchdog ??= { pid: null, report: join(runRoot, "watchdog-report.jsonl") };
    state.heartbeat.supervisor = await processIdentity();
    state.model_name_or_path ??= `sortie-dogs@${value.candidate?.version}+${String(value.candidate?.sha256 ?? "").slice(0, 12)}`;
    if (state.status === "running") await markInterrupted(state);
    writes = stateWriteQueue(state, statePath);
    await writes.enqueue();
    if (TERMINAL_STATES.has(state.status)) return state;
    if (!TERMINAL_STATES.has(state.status) && dependencies.spawnWatchdog) watchdog = await dependencies.spawnWatchdog(state, statePath);
    else if (!TERMINAL_STATES.has(state.status) && options.watchdog !== false) {
      const report = state.watchdog.report;
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--watchdog", "--state", statePath, "--report", report,
        "--interval-seconds", String(options.heartbeatSeconds ?? DEFAULT_HEARTBEAT_SECONDS),
        "--stale-seconds", String(options.staleSeconds ?? DEFAULT_STALE_SECONDS),
        "--report-seconds", String(options.reportSeconds ?? DEFAULT_REPORT_SECONDS)], {
         detached: false, stdio: "ignore",
       });
       watchdog = { child, identity: await processIdentity(child.pid) };
       state.watchdog.pid = watchdog.identity;
       await writes.enqueue();
    }
    heartbeatTimer = setInterval(() => {
      if (heartbeatInFlight || TERMINAL_STATES.has(state.status)) return;
      heartbeatInFlight = true;
      writes.enqueue().catch(() => undefined).finally(() => { heartbeatInFlight = false; });
    }, (options.heartbeatSeconds ?? DEFAULT_HEARTBEAT_SECONDS) * 1000);
    const firstPending = () => state.instances.findIndex(entry => entry.status === "pending");
    const reservationFor = () => {
      const pending = state.instances.filter(entry => entry.status === "pending").length;
      const slots = Math.max(1, Math.min(workers - active.size, pending));
       const available = options.costLimitUsd - state.spent_usd - state.reserved_usd - state.held_unknown_usd;
       // Without an explicit cap, distribute the remaining budget across the entire queue;
       // unused funds from a settled instance flow back into later reservations.
       return available > 0 ? Math.min(options.perInstanceUsd ?? available / pending, available / slots) : 0;
    };
    const markCostLimited = async index => {
      const entry = state.instances[index];
      entry.status = "not-run-cost-limit";
      entry.finished_at = now();
      entry.result = { instance_id: entry.instance_id, status: entry.status };
      state.next_index = Math.max(state.next_index ?? 0, index + 1);
      await writes.enqueue();
    };
    const claim = async (index, reservation) => {
      const entry = state.instances[index];
      const paths = childPaths(state, entry);
      try {
        await makeChildManifest(value, state, entry, paths);
      } catch (error) {
        entry.status = "failed";
        entry.finished_at = now();
        entry.result = { instance_id: entry.instance_id, status: "failed", error: String(error?.message ?? error) };
        state.next_index = Math.max(state.next_index ?? 0, index + 1);
        await writes.enqueue();
        return null;
      }
      entry.status = "running";
      entry.attempt = 1;
      entry.started_at = now();
      entry.cost_reservation_usd = reservation;
      entry.child_output = paths.output;
      entry.child_metadata = paths.metadata;
      state.reserved_usd += reservation;
      state.next_index = Math.max(state.next_index ?? 0, index + 1);
      await writes.enqueue();
      return paths;
    };
    const runClaim = async (index, paths) => {
      const entry = state.instances[index];
      try {
        const child = await spawnRunner(state, entry, paths, {
          ...options,
          workers,
          costLimitUsd: entry.cost_reservation_usd,
        }, dependencies);
        const identity = child?.identity ?? (Number.isInteger(child?.child?.pid)
          ? await processIdentity(child.child.pid) : null);
        entry.runner = identity;
        await writes.enqueue();
        const exit = dependencies.waitForChild
          ? await dependencies.waitForChild(child, entry)
          : await waitForChild(child.child);
        return { exit };
      } catch (error) {
        return { error };
      }
    };
    const settle = async (index, paths, outcome) => {
      const entry = state.instances[index];
      let metadata;
      try { metadata = await readJson(paths.metadata); } catch { metadata = undefined; }
      const childResult = metadata?.results?.[0];
      if (childResult) {
        entry.result = childResult;
        entry.status = childResult.status ?? "completed";
      } else if (outcome.error) {
        entry.status = "failed";
        entry.result = {
          instance_id: entry.instance_id,
          status: "failed",
          exit_code: null,
          signal: null,
          error: String(outcome.error?.message ?? outcome.error),
        };
      } else {
        const exit = outcome.exit ?? { exit: 1, signal: null };
        entry.status = exit.exit === 0 ? "completed" : "failed";
        entry.result = { instance_id: entry.instance_id, status: entry.status, exit_code: exit.exit, signal: exit.signal };
      }
      const usage = recordedUsage(metadata, entry.result);
      if (entry.usage_recorded !== true && usage !== null && usage > 0) state.spent_usd += usage;
      entry.usage_usd = usage;
       if (metadata?.execution?.usage_complete !== true || usage === null) {
        const hold = Math.max(0, (entry.cost_reservation_usd ?? 0) - (usage ?? 0));
        state.held_unknown_usd += hold;
        entry.held_unknown_usd = hold;
      }
      entry.usage_recorded = true;
       state.reserved_usd = Math.max(0, state.reserved_usd - (entry.cost_reservation_usd ?? 0));
       if (state.reserved_usd < 1e-10) state.reserved_usd = 0;
      entry.finished_at = now();
      entry.runner = null;
      await writes.enqueue();
    };
    while (true) {
      while (active.size < workers) {
        const index = firstPending();
        if (index < 0) break;
        const reservation = reservationFor();
        if (reservation <= 0) {
          if (active.size > 0) break;
          await markCostLimited(index);
          continue;
        }
        const paths = await claim(index, reservation);
        if (!paths) continue;
        const task = runClaim(index, paths).then(outcome => ({ index, paths, outcome }));
        active.set(index, task);
      }
      if (active.size === 0) {
        const index = firstPending();
        if (index < 0) break;
        if (options.costLimitUsd - state.spent_usd - state.reserved_usd - state.held_unknown_usd <= 0) {
          await markCostLimited(index);
          continue;
        }
        continue;
      }
      const finished = await Promise.race(active.values());
      active.delete(finished.index);
      await settle(finished.index, finished.paths, finished.outcome);
    }
    state.next_index = state.instances.length;
    state.status = "completed";
    await finalizeOutput(state);
    await writes.enqueue();
    return state;
  } catch (error) {
    if (state && admitted) {
      await markInterrupted(state).catch(() => undefined);
      state.status = "failed";
      state.failure = String(error?.message ?? error);
      if (writes) await writes.enqueue().catch(() => undefined);
      else await writeState(state, statePath).catch(() => undefined);
    }
    throw error;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (watchdog?.child) {
      try { watchdog.child.kill(); } catch { /* already stopped */ }
    }
    await releaseRunLock(lock);
  }
}

export async function startDetachedSupervisor(options) {
  ensure(process.platform !== "win32", "supervisor-requires-wsl");
  ensure(typeof options.manifest === "string" && typeof options.output === "string" &&
    typeof options.runRoot === "string", "supervisor-paths-required");
  ensure(Number.isFinite(options.costLimitUsd) && options.costLimitUsd > 0, "supervisor-cost-limit-required");
  const workers = workerCount(options.workers);
  const runRoot = resolve(options.runRoot);
  await mkdir(runRoot);
  const logPath = join(runRoot, "supervisor.log");
  const logFd = openSync(logPath, "a");
  const args = [fileURLToPath(import.meta.url), "--supervise", "--manifest", resolve(options.manifest),
    "--run-root", runRoot, "--output", resolve(options.output), "--cost-limit-usd", String(options.costLimitUsd),
    "--workers", String(workers)];
  if (options.runnerScript) args.push("--runner-script", resolve(options.runnerScript));
  if (options.perInstanceUsd) args.push("--per-instance-usd", String(options.perInstanceUsd));
  if (options.preparedEnvironment) args.push("--prepared-environment", options.preparedEnvironment);
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...(options.environment ?? {}) },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);
  child.unref();
  return { pid: child.pid, runRoot, statePath: join(runRoot, "supervisor-state.json"), logPath };
}

function watchdogProgress(state) {
  const entries = Array.isArray(state.instances) ? state.instances : [];
  const currentEntries = entries.filter(entry => entry.status === "running");
  const processed = entries.filter(entry => !["pending", "running"].includes(entry.status)).length;
  return {
    progress: `${Math.min(entries.length, processed + currentEntries.length)}/${entries.length}`,
    current_instance: currentEntries[0]?.instance_id ?? null,
    current_instances: currentEntries.map(entry => entry.instance_id),
  };
}

export async function runWatchdog(options) {
  const interval = (options.intervalSeconds ?? DEFAULT_HEARTBEAT_SECONDS) * 1000;
  const stale = (options.staleSeconds ?? DEFAULT_STALE_SECONDS) * 1000;
  const reportInterval = (options.reportSeconds ?? DEFAULT_REPORT_SECONDS) * 1000;
  let lastReport = 0;
  await appendJsonLine(options.report, { at: now(), event: "started", interval_ms: interval, report_interval_ms: reportInterval });
  lastReport = Date.now();
  while (true) {
    const state = await readJson(options.state);
    const progress = watchdogProgress(state);
    if (TERMINAL_STATES.has(state.status)) {
      await appendJsonLine(options.report, { ...progress, at: now(), event: "terminal", status: state.status });
      return;
    }
    const supervisorAlive = await processAlive(state.heartbeat?.supervisor);
    const heartbeatAge = Date.now() - Date.parse(state.heartbeat?.at ?? 0);
    if (!supervisorAlive || heartbeatAge > stale) {
      await appendJsonLine(options.report, { ...progress, at: now(), event: "supervisor-lost", supervisorAlive, heartbeatAge });
      return;
    }
    const runners = (state.instances ?? [])
      .filter(entry => entry.status === "running" && entry.runner)
      .map(entry => ({ instance_id: entry.instance_id, runner: entry.runner }));
    let runnerLost = false;
    for (const { instance_id, runner } of runners) {
      if (await processAlive(runner)) continue;
      runnerLost = true;
      await appendJsonLine(options.report, { ...progress, at: now(), event: "runner-lost", instance_id, runner });
    }
    if (runnerLost && options.once) return;
    if (Date.now() - lastReport >= reportInterval) {
      await appendJsonLine(options.report, {
        ...progress,
        at: now(),
        event: "heartbeat",
        supervisor_alive: supervisorAlive,
        heartbeat_age_ms: heartbeatAge,
        spent_usd: state.spent_usd ?? 0,
        statuses: Object.fromEntries((state.instances ?? []).map(entry => [entry.instance_id, entry.status])),
      });
      lastReport = Date.now();
    }
    if (options.once) return;
    await sleep(interval);
  }
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--start", "--stop", "--supervise", "--watchdog"].includes(argument)) { values.mode = argument.slice(2); continue; }
    if (argument.startsWith("--")) {
      const key = argument.slice(2).replaceAll("-", "_");
      const name = { run_root: "runRoot", cost_limit_usd: "costLimitUsd", workers: "workers", heartbeat_seconds: "heartbeatSeconds",
        stale_seconds: "staleSeconds", report_seconds: "reportSeconds", state_path: "statePath", runner_script: "runnerScript", per_instance_usd: "perInstanceUsd",
        prepared_environment: "preparedEnvironment" }[key] ?? key;
      const value = argv[++index];
      values[name] = ["costLimitUsd", "perInstanceUsd", "workers", "heartbeatSeconds", "staleSeconds", "reportSeconds"].includes(name) ? Number(value) : value;
    }
    else throw new Error(`unknown-option:${argument}`);
  }
  return values;
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const options = parseArguments(process.argv.slice(2));
  if (options.mode === "watchdog") runWatchdog(options).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  else if (options.mode === "stop") {
    stopSupervisor(options.statePath)
      .then(state => process.stdout.write(`${JSON.stringify({ run_id: state.run_id, status: state.status, failure: state.failure })}\n`))
      .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  }
  else if (options.mode === "start") {
    startDetachedSupervisor(options)
      .then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
      .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  }
  else if (options.mode === "supervise") {
    readFile(options.manifest, "utf8").then(JSON.parse).then(value => runSupervisor(value, {
      ...options,
      manifestPath: options.manifest,
      runRoot: options.runRoot,
      output: options.output,
      costLimitUsd: options.costLimitUsd,
    }))
      .then(state => process.stdout.write(`${JSON.stringify({ run_id: state.run_id, status: state.status })}\n`))
      .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  } else {
    process.stderr.write("use --supervise or --watchdog\n");
    process.exitCode = 2;
  }
}
