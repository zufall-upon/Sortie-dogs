import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const GRADER_SCHEMA_VERSION = 1;
export const OFFICIAL_SCORING_SPLIT = "dev";
export const OFFICIAL_SCORING_MAX_WORKERS = 1;
export const OFFICIAL_SCORING_BOUNDARY = "official-swebench-harness";
export const FIXED_LITE_DATASET_ID = "princeton-nlp/SWE-bench_Lite";
export const MAX_GRADER_OUTPUT_BYTES = 8 * 1024 * 1024;
export const SCORING_STATE_SCHEMA_VERSION = GRADER_SCHEMA_VERSION;
export const OFFICIAL_HARNESS_SPLIT = OFFICIAL_SCORING_SPLIT;

const TERMINAL_INFERENCE_STATUSES = new Set([
  "completed", "succeeded", "empty-patch", "failed", "interrupted", "watchdog-stale",
  "agent-failed", "timeout", "output-limit", "cost-limit", "pricing-coverage-missing",
  "usage-monitor-failed", "watchdog-usage-failed", "cleanup-failed", "replay-failed",
]);
const HIDDEN_FIELDS = Object.freeze(["patch", "test_patch", "hints_text", "FAIL_TO_PASS", "PASS_TO_PASS"]);
const PUBLIC_INSTANCE_FIELDS = Object.freeze([
  "instance_id", "repo", "base_commit", "problem_statement", "version", "environment_setup_commit", "created_at",
]);
const PREDICTION_FIELDS = Object.freeze(["instance_id", "model_name_or_path", "model_patch"]);
const RESULT_FIELDS = Object.freeze([
  "instance_id", "status", "exit_code", "signal", "patch_bytes", "patch_sha256", "elapsed_ms", "usage",
  "watchdog_events", "watchdog_idle_ms", "replay_artifact", "cleanup_error", "resolved", "tests_passed", "score",
]);

const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const ensure = (condition, message) => {
  if (!condition) throw new Error(message);
};
const digest = value => createHash("sha256").update(value).digest("hex");
const canonicalize = value => Array.isArray(value)
  ? value.map(canonicalize)
  : record(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
    : value;
const canonicalJson = value => JSON.stringify(canonicalize(value));
const hashJson = value => digest(canonicalJson(value));

const text = (value, field, allowEmpty = false) => {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) throw new Error(`invalid-${field}`);
  return value;
};

function errorWithCode(code, detail) {
  const error = new Error(detail ? `${code}:${detail}` : code);
  error.code = code;
  return error;
}

function assertNoHiddenFields(value, path = "input") {
  if (!record(value) && !Array.isArray(value)) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoHiddenFields(item, `${path}[${index}]`));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (HIDDEN_FIELDS.includes(key)) throw errorWithCode(`hidden-field:${key}`, path);
    assertNoHiddenFields(item, `${path}.${key}`);
  }
}

function publicInstance(value, fallbackId) {
  const source = record(value) ? value : {};
  for (const field of HIDDEN_FIELDS) {
    if (Object.hasOwn(source, field)) throw errorWithCode(`hidden-instance-field:${field}`);
  }
  const instanceId = source.instance_id ?? fallbackId;
  text(instanceId, "instance-id");
  const result = Object.fromEntries(PUBLIC_INSTANCE_FIELDS
    .filter(field => source[field] !== undefined)
    .map(field => [field, text(source[field], `instance.${field}`)]));
  result.instance_id = instanceId;
  return Object.fromEntries(PUBLIC_INSTANCE_FIELDS.filter(field => result[field] !== undefined)
    .map(field => [field, result[field]]));
}

function safeResult(value, instanceId) {
  if (!record(value)) return { instance_id: instanceId };
  const result = { instance_id: instanceId };
  for (const field of RESULT_FIELDS) {
    if (value[field] === undefined) continue;
    if (field === "usage") {
      if (record(value[field])) {
        result[field] = Object.fromEntries(Object.entries(value[field]).filter(([key, item]) =>
          ["usd", "requests"].includes(key) || (key === "unpriced" && Array.isArray(item) && item.every(entry => typeof entry === "string"))));
      }
      continue;
    }
    if (field === "replay_artifact") {
      if (record(value[field])) {
        result[field] = Object.fromEntries(["path", "bytes", "sha256"]
          .filter(key => value[field][key] !== undefined)
          .map(key => [key, value[field][key]]));
      }
      continue;
    }
    if (["status", "signal", "cleanup_error"].includes(field)) {
      if (value[field] === null || typeof value[field] === "string") result[field] = value[field];
      continue;
    }
    if (typeof value[field] === "number" || typeof value[field] === "boolean" || value[field] === null) {
      result[field] = value[field];
    }
  }
  return result;
}

function prediction(value, expectedInstanceId) {
  if (!record(value) || Object.keys(value).sort().join("\0") !== [...PREDICTION_FIELDS].sort().join("\0")) {
    throw errorWithCode("invalid-prediction");
  }
  const result = {
    instance_id: text(value.instance_id, "prediction.instance_id"),
    model_name_or_path: text(value.model_name_or_path, "prediction.model_name_or_path"),
    model_patch: text(value.model_patch, "prediction.model_patch", true),
  };
  ensure(result.instance_id === expectedInstanceId, "prediction-instance-mismatch");
  return result;
}

function parsePredictionText(value, instanceId) {
  if (record(value)) return prediction(value, instanceId);
  if (typeof value !== "string") throw errorWithCode("invalid-prediction");
  const line = value.split(/\r?\n/u).map(item => item.trim()).find(item => item.length > 0);
  if (!line) throw errorWithCode("missing-prediction", instanceId);
  let parsed;
  try { parsed = JSON.parse(line); }
  catch { throw errorWithCode("invalid-prediction", instanceId); }
  return prediction(parsed, instanceId);
}

function isInferenceCompleted(entry) {
  if (!record(entry)) return false;
  if (entry.status === "pending" || entry.status === "running") return false;
  if (entry.runner) return false;
  if (entry.status && !TERMINAL_INFERENCE_STATUSES.has(entry.status) && !entry.finished_at) return false;
  return entry.attempt === undefined || entry.attempt === 1;
}

function reportedPatchHash(entry) {
  const result = record(entry?.result) ? entry.result : {};
  return result.patch_sha256 ?? result.patch_hash ?? entry?.patch_sha256 ?? entry?.patch_hash;
}

function validatePatchHash(entry, patch) {
  const actual = digest(patch);
  const reported = reportedPatchHash(entry);
  if (patch.length > 0) {
    if (typeof reported !== "string" || !/^[a-f0-9]{64}$/u.test(reported)) {
      throw errorWithCode("patch-hash-required", entry.instance_id);
    }
    if (reported !== actual) throw errorWithCode("patch-hash-mismatch", entry.instance_id);
  } else if (reported !== undefined && reported !== null && reported !== actual) {
    throw errorWithCode("patch-hash-mismatch", entry.instance_id);
  }
  return actual;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readJsonIfPresent(path) {
  if (!path) return undefined;
  try { return await readJson(path); }
  catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function appendLog(path, event) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
}

async function loadManifest(state, options) {
  if (record(options.manifest)) return options.manifest;
  if (record(state.manifest_value)) return state.manifest_value;
  if (record(state.manifest_data)) return state.manifest_data;
  if (typeof state.manifest !== "string") return undefined;
  return readJsonIfPresent(state.manifest);
}

function manifestDataset(manifest, state) {
  const dataset = record(manifest?.dataset) ? manifest.dataset : record(state?.dataset) ? state.dataset : {};
  const split = dataset.split ?? OFFICIAL_SCORING_SPLIT;
  if (split !== OFFICIAL_SCORING_SPLIT) throw errorWithCode("grader-split-required", split);
  if (dataset.id !== undefined && dataset.id !== FIXED_LITE_DATASET_ID) {
    throw errorWithCode("grader-dataset-required", dataset.id);
  }
  return {
    ...(typeof dataset.id === "string" ? { id: dataset.id } : { id: FIXED_LITE_DATASET_ID }),
    ...(typeof dataset.revision === "string" ? { revision: dataset.revision } : {}),
    split: OFFICIAL_SCORING_SPLIT,
  };
}

function manifestInstances(manifest) {
  return Array.isArray(manifest?.instances) ? manifest.instances : [];
}

function publicInstanceFor(manifest, state, entry) {
  const manifestItem = manifestInstances(manifest).find(item => item?.instance_id === entry.instance_id);
  const source = manifestItem ?? entry.instance ?? entry.public_instance;
  return publicInstance(source, entry.instance_id);
}

async function predictionFor(entry, state) {
  if (entry.prediction !== undefined) return parsePredictionText(entry.prediction, entry.instance_id);
  if (entry.child_output) {
    const path = resolve(String(entry.child_output));
    try { return parsePredictionText(await readFile(path, "utf8"), entry.instance_id); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (entry.result?.prediction !== undefined) return parsePredictionText(entry.result.prediction, entry.instance_id);
  const patch = typeof entry.patch === "string" ? entry.patch
    : typeof entry.result?.patch === "string" ? entry.result.patch : "";
  const modelName = entry.model_name_or_path ?? state.model_name_or_path ?? "swebench-candidate";
  return prediction({ instance_id: entry.instance_id, model_name_or_path: modelName, model_patch: patch }, entry.instance_id);
}

function snapshotHash(snapshot) {
  const { snapshot_sha256: _ignored, ...withoutHash } = snapshot;
  return hashJson(withoutHash);
}

/**
 * Read only inference-terminal entries and capture their candidate patches.
 * Pending and running entries are deliberately absent from this snapshot.
 */
export async function createCompletedSnapshot(state, options = {}) {
  ensure(record(state) && Array.isArray(state.instances), "invalid-supervisor-state");
  const manifest = await loadManifest(state, options);
  const dataset = manifestDataset(manifest, state);
  const entries = [];
  for (const [index, entry] of state.instances.entries()) {
    if (!isInferenceCompleted(entry)) continue;
    const itemPrediction = await predictionFor(entry, state);
    const patchSha256 = validatePatchHash(entry, itemPrediction.model_patch);
    const publicInput = publicInstanceFor(manifest, state, entry);
    entries.push({
      index,
      instance_id: entry.instance_id,
      status: entry.status,
      instance: publicInput,
      prediction: itemPrediction,
      patch_sha256: patchSha256,
      patch_bytes: Buffer.byteLength(itemPrediction.model_patch),
      result: safeResult(entry.result, entry.instance_id),
    });
  }
  entries.sort((left, right) => left.index - right.index);
  if (new Set(entries.map(item => item.instance_id)).size !== entries.length) {
    throw errorWithCode("duplicate-completed-instance");
  }
  const snapshot = {
    schema_version: GRADER_SCHEMA_VERSION,
    kind: "swebench-completed-snapshot",
    dataset,
    run_id: state.run_id ?? null,
    inference_status: state.status ?? "unknown",
    instances: entries,
  };
  return { ...snapshot, snapshot_sha256: snapshotHash(snapshot) };
}

export const readCompletedSnapshot = createCompletedSnapshot;
export const snapshotCompletedInstances = createCompletedSnapshot;
export const createGraderSnapshot = createCompletedSnapshot;

function safeRequestInstance(value) {
  const result = publicInstance(value, value?.instance_id);
  return result;
}

/** Build the only scoring contract accepted by the official harness. */
export function createOfficialHarnessRequest(snapshot, options = {}) {
  ensure(record(snapshot) && Array.isArray(snapshot.instances), "invalid-completed-snapshot");
  const split = options.split ?? snapshot.dataset?.split ?? OFFICIAL_SCORING_SPLIT;
  if (split !== OFFICIAL_SCORING_SPLIT) throw errorWithCode("grader-split-required", split);
  const maxWorkers = options.max_workers ?? options.maxWorkers ?? OFFICIAL_SCORING_MAX_WORKERS;
  if (maxWorkers !== OFFICIAL_SCORING_MAX_WORKERS) throw errorWithCode("grader-max-workers-required", maxWorkers);
  const instances = snapshot.instances.map(item => safeRequestInstance(item.instance));
  const predictions = snapshot.instances.map(item => prediction(item.prediction, item.instance_id));
  const request = {
    schema_version: GRADER_SCHEMA_VERSION,
    kind: "swebench-official-scoring-request",
    mode: "official-docker-scoring",
    split: OFFICIAL_SCORING_SPLIT,
    max_workers: OFFICIAL_SCORING_MAX_WORKERS,
    dataset: { ...snapshot.dataset, split: OFFICIAL_SCORING_SPLIT },
    official_scoring_boundary: OFFICIAL_SCORING_BOUNDARY,
    retry_count: 0,
    snapshot_sha256: snapshot.snapshot_sha256 ?? snapshotHash(snapshot),
    instances,
    predictions,
  };
  assertNoHiddenFields(request);
  return request;
}

export const buildOfficialHarnessRequest = createOfficialHarnessRequest;

async function writePredictionFile(path, predictions) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${predictions.map(item => JSON.stringify(item)).join("\n")}\n`, { flag: "w" });
}

function scoringPaths(options, supervisorStatePath) {
  const runRoot = resolve(options.runRoot ?? (supervisorStatePath ? dirname(supervisorStatePath) : process.cwd()));
  return {
    runRoot,
    supervisorState: supervisorStatePath ?? null,
    snapshot: resolve(options.snapshotPath ?? join(runRoot, "completed-snapshot.json")),
    state: resolve(options.scoringStatePath ?? options.scoringState ?? join(runRoot, "scoring-state.json")),
    log: resolve(options.scoringLogPath ?? options.logPath ?? join(runRoot, "scoring.log")),
    liveResults: resolve(options.liveResultsPath ?? options.liveResults ?? join(runRoot, "live-results.jsonl")),
    request: resolve(options.requestPath ?? join(runRoot, "scoring-request.json")),
    predictions: resolve(options.predictionsPath ?? join(runRoot, "scoring-predictions.jsonl")),
  };
}

async function readStateInput(options) {
  const path = options.supervisorStatePath ?? options.inferenceStatePath ?? options.statePath;
  if (record(options.state)) return { state: options.state, path: path ? resolve(path) : null };
  ensure(typeof path === "string" && path.length > 0, "grader-state-required");
  return { state: await readJson(path), path: resolve(path) };
}

function initialScoringState(paths, supervisorState, snapshot) {
  return {
    schema_version: GRADER_SCHEMA_VERSION,
    kind: "swebench-scoring-state",
    run_id: supervisorState.run_id ?? null,
    status: "idle",
    split: OFFICIAL_SCORING_SPLIT,
    max_workers: OFFICIAL_SCORING_MAX_WORKERS,
    official_scoring_boundary: OFFICIAL_SCORING_BOUNDARY,
    retry_count: 0,
    supervisor_state: paths.supervisorState,
    snapshot_path: paths.snapshot,
    log_path: paths.log,
    live_results_path: paths.liveResults,
    request_path: paths.request,
    predictions_path: paths.predictions,
    snapshot_sha256: snapshot?.snapshot_sha256 ?? null,
    completed_instance_ids: snapshot?.instances.map(item => item.instance_id) ?? [],
    graded_instance_ids: [],
    graded: {},
    active_instance_ids: [],
    updated_at: new Date().toISOString(),
  };
}

export function createScoringState(value = {}, options = {}) {
  const paths = scoringPaths(options, options.supervisorStatePath ?? options.inferenceStatePath ?? options.statePath);
  const snapshot = record(value.snapshot) ? value.snapshot : undefined;
  return initialScoringState(paths, record(value.state) ? value.state : value, snapshot);
}

function assertScoringState(value) {
  ensure(record(value) && value.schema_version === GRADER_SCHEMA_VERSION, "invalid-scoring-state");
  if (value.split !== undefined && value.split !== OFFICIAL_SCORING_SPLIT) throw errorWithCode("grader-split-required", value.split);
  if (value.max_workers !== undefined && value.max_workers !== OFFICIAL_SCORING_MAX_WORKERS) {
    throw errorWithCode("grader-max-workers-required", value.max_workers);
  }
  value.graded ??= {};
  value.graded_instance_ids ??= Object.keys(value.graded);
  return value;
}

function inferenceStillRunning(state) {
  return state.status === "running" || state.instances.some(entry => entry.status === "pending" || entry.status === "running");
}

function ungradedInstances(snapshot, scoringState) {
  return snapshot.instances.filter(item => {
    const prior = scoringState.graded?.[item.instance_id];
    if (!prior) return true;
    if (prior.patch_sha256 !== item.patch_sha256) throw errorWithCode("scoring-patch-hash-mismatch", item.instance_id);
    return false;
  });
}

function gradeSnapshotFrom(snapshot, instances) {
  const subset = {
    ...snapshot,
    instances,
  };
  return { ...subset, snapshot_sha256: snapshotHash(subset) };
}

function safeHarnessResult(value) {
  if (Array.isArray(value)) return { exit_code: 0, results: value };
  if (!record(value)) return { exit_code: 0, results: [] };
  const result = {};
  for (const field of ["exit_code", "exit", "code", "signal", "status", "stdout", "stderr", "results", "instance_results", "live_results"]) {
    if (value[field] !== undefined) result[field] = value[field];
  }
  return result;
}

function harnessResults(value, instances) {
  const result = safeHarnessResult(value);
  const raw = Array.isArray(result.results) ? result.results
    : Array.isArray(result.instance_results) ? result.instance_results
      : Array.isArray(result.live_results) ? result.live_results : [];
  const byId = new Map(raw.filter(item => record(item) && typeof item.instance_id === "string")
    .map(item => [item.instance_id, item]));
  return instances.map(item => {
    const source = byId.get(item.instance_id);
    const safe = record(source) ? {} : { status: result.exit_code === 0 ? "scored" : "harness-failed" };
    if (record(source)) {
      assertNoHiddenFields(source, `harness-result.${item.instance_id}`);
      for (const [key, value] of Object.entries(source)) {
        if (key === "instance_id" || HIDDEN_FIELDS.includes(key)) continue;
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) safe[key] = value;
      }
    }
    return { instance_id: item.instance_id, ...safe };
  });
}

async function readLiveResults(path) {
  try {
    const textValue = await readFile(path, "utf8");
    const rows = textValue.split(/\r?\n/u).map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line));
    return rows.filter(row => record(row) && typeof row.instance_id === "string");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function writeLiveResults(path, rows, manifestOrder = []) {
  const byId = new Map(rows.map(row => [row.instance_id, row]));
  const order = new Map(manifestOrder.map((instanceId, index) => [instanceId, index]));
  const ordered = [...byId.values()].sort((left, right) => {
    const leftIndex = order.get(left.instance_id) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = order.get(right.instance_id) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex === rightIndex
      ? String(left.instance_id).localeCompare(String(right.instance_id))
      : leftIndex - rightIndex;
  });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${ordered.map(row => JSON.stringify(row)).join("\n")}${ordered.length > 0 ? "\n" : ""}`, { flag: "w" });
  return ordered;
}

function harnessExit(value) {
  const result = safeHarnessResult(value);
  if (result.exit_code !== undefined) return result.exit_code;
  if (result.exit !== undefined) return result.exit;
  if (result.code !== undefined) return result.code;
  return 0;
}

async function verifySnapshotHashes(supervisorStatePath, expected, options, stateFallback) {
  const currentState = supervisorStatePath ? await readJson(supervisorStatePath) : stateFallback;
  if (!currentState) return;
  const current = await createCompletedSnapshot(currentState, options);
  const currentById = new Map(current.instances.map(item => [item.instance_id, item]));
  for (const item of expected.instances) {
    if (currentById.get(item.instance_id)?.patch_sha256 !== item.patch_sha256) {
      throw errorWithCode("patch-hash-mismatch", item.instance_id);
    }
  }
}

async function executeOfficialHarness(request, context, options) {
  const configured = context.runHarness ?? context.officialHarness ?? options.runHarness ?? options.runOfficialHarness
    ?? options.officialHarness ?? options.harness;
  const runner = typeof configured === "function" ? configured : configured?.run;
  if (typeof runner === "function") return runner(request, context);
  if (Array.isArray(options.harnessCommand) && options.harnessCommand.length > 0) {
    const [executable, ...fixedArgs] = options.harnessCommand;
    return runOfficialHarness(request, { ...context, executable, args: fixedArgs });
  }
  if (options.harnessExecutable) {
    return runOfficialHarness(request, { ...context, executable: options.harnessExecutable, args: options.harnessArgs });
  }
  throw errorWithCode("official-harness-runner-required");
}

/** Execute a configured official harness. The caller must explicitly provide its command. */
export function runOfficialHarness(request, options = {}) {
  ensure(request.split === OFFICIAL_SCORING_SPLIT && request.max_workers === OFFICIAL_SCORING_MAX_WORKERS,
    "official-harness-contract-invalid");
  const executable = options.executable ?? options.harnessExecutable ?? "python";
  const args = options.args ?? [
    "-m", "swebench.harness",
    "--dataset_name", request.dataset?.id ?? "princeton-nlp/SWE-bench_Lite",
    "--split", OFFICIAL_SCORING_SPLIT,
    "--max_workers", String(OFFICIAL_SCORING_MAX_WORKERS),
    "--predictions_path", options.predictionsPath ?? "scoring-predictions.jsonl",
  ];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    const stderr = [];
    let overflow = false;
    const capture = (chunks, chunk, current) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const next = current + bytes.byteLength;
      const remaining = Math.max(0, MAX_GRADER_OUTPUT_BYTES - current);
      if (remaining > 0) chunks.push(bytes.subarray(0, remaining));
      if (next > MAX_GRADER_OUTPUT_BYTES) overflow = true;
      return next;
    };
    child.stdout?.on("data", chunk => { stdoutBytes = capture(stdout, chunk, stdoutBytes); });
    child.stderr?.on("data", chunk => { stderrBytes = capture(stderr, chunk, stderrBytes); });
    child.once("error", reject);
    child.once("close", (exit, signal) => {
      if (overflow) { reject(errorWithCode("grader-output-capacity-exceeded")); return; }
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      let parsed;
      const candidate = stdoutText.trim().split(/\r?\n/u).at(-1);
      if (candidate) {
        try { parsed = JSON.parse(candidate); } catch { /* official harness may emit human-readable output */ }
      }
      resolvePromise({
        ...(record(parsed) ? parsed : {}),
        exit_code: exit ?? (signal ? 1 : 0),
        signal: signal ?? null,
        stdout: stdoutText,
        stderr: stderrText,
        stdout_bytes: stdoutBytes,
        stderr_bytes: stderrBytes,
        command: [executable, ...args],
      });
    });
  });
}

async function runIncrementalGraderOnce(options, dependencies) {
  const input = await readStateInput(options);
  const paths = scoringPaths(options, input.path);
  const snapshot = await createCompletedSnapshot(input.state, options);
  await atomicWriteJson(paths.snapshot, snapshot);
  const requestable = createOfficialHarnessRequest(snapshot, options);
  await atomicWriteJson(paths.request, requestable);
  await writePredictionFile(paths.predictions, requestable.predictions);
  let scoringState = assertScoringState(await readJsonIfPresent(paths.state)
    ?? initialScoringState(paths, input.state, snapshot));
  const existingLive = await readLiveResults(paths.liveResults);
  scoringState.graded ??= {};
  for (const row of existingLive) {
    const current = snapshot.instances.find(item => item.instance_id === row.instance_id);
    if (!current || typeof row.patch_sha256 !== "string") continue;
    if (row.patch_sha256 !== current.patch_sha256) throw errorWithCode("scoring-patch-hash-mismatch", row.instance_id);
    scoringState.graded[row.instance_id] ??= {
      patch_sha256: row.patch_sha256,
      status: row.status ?? "scored",
      result: record(row.result) ? row.result : { instance_id: row.instance_id, status: row.status ?? "scored" },
    };
  }
  const pending = ungradedInstances(snapshot, scoringState);
  scoringState.snapshot_sha256 = snapshot.snapshot_sha256;
  scoringState.completed_instance_ids = snapshot.instances.map(item => item.instance_id);
  scoringState.supervisor_state = paths.supervisorState;
  if (pending.length === 0) {
    scoringState.status = scoringState.status === "failed" ? "failed" : "completed";
    scoringState.active_instance_ids = [];
    scoringState.graded_instance_ids = Object.keys(scoringState.graded);
    scoringState.updated_at = new Date().toISOString();
    await atomicWriteJson(paths.state, scoringState);
    return {
      status: inferenceStillRunning(input.state) ? "waiting" : "completed",
      coalesced: false,
      started: false,
      inference_running: inferenceStillRunning(input.state),
      snapshot,
      request: null,
      results: [],
      state: scoringState,
      paths,
    };
  }

  const gradeSnapshot = gradeSnapshotFrom(snapshot, pending);
  const request = createOfficialHarnessRequest(gradeSnapshot, options);
  const startedAt = new Date().toISOString();
  scoringState.status = "running";
  scoringState.active_instance_ids = pending.map(item => item.instance_id);
  scoringState.active_patch_hashes = Object.fromEntries(pending.map(item => [item.instance_id, item.patch_sha256]));
  scoringState.snapshot_sha256 = gradeSnapshot.snapshot_sha256;
  scoringState.updated_at = startedAt;
  await atomicWriteJson(paths.state, scoringState);
  await appendLog(paths.log, {
    event: "grader-started",
    at: startedAt,
    split: OFFICIAL_SCORING_SPLIT,
    max_workers: OFFICIAL_SCORING_MAX_WORKERS,
    instance_ids: pending.map(item => item.instance_id),
    inference_running: inferenceStillRunning(input.state),
  });
  await atomicWriteJson(paths.request, request);
  await writePredictionFile(paths.predictions, request.predictions);
  let harnessResult;
  try {
    harnessResult = await executeOfficialHarness(request, {
      predictionPath: paths.predictions,
      requestPath: paths.request,
      scoringStatePath: paths.state,
      runRoot: paths.runRoot,
      snapshot: gradeSnapshot,
      runHarness: dependencies.runHarness,
      officialHarness: dependencies.officialHarness ?? dependencies.runOfficialHarness,
    }, options);
    const exit = harnessExit(harnessResult);
    if (exit !== 0) throw errorWithCode("official-harness-failed", String(exit));
    await verifySnapshotHashes(input.path, gradeSnapshot, options, input.state);
  } catch (error) {
    scoringState.status = "failed";
    scoringState.failure = String(error?.message ?? error);
    scoringState.active_instance_ids = [];
    scoringState.updated_at = new Date().toISOString();
    await atomicWriteJson(paths.state, scoringState);
    await appendLog(paths.log, { event: "grader-failed", at: scoringState.updated_at, error: scoringState.failure });
    throw error;
  }

  const scored = harnessResults(harnessResult, pending);
  const oldLive = await readLiveResults(paths.liveResults);
  const liveRows = [...oldLive];
  for (const [index, item] of pending.entries()) {
    const row = {
      instance_id: item.instance_id,
      patch_sha256: item.patch_sha256,
      status: scored[index]?.status ?? "scored",
      scoring: OFFICIAL_SCORING_BOUNDARY,
      split: OFFICIAL_SCORING_SPLIT,
      max_workers: OFFICIAL_SCORING_MAX_WORKERS,
      result: scored[index] ?? { instance_id: item.instance_id, status: "scored" },
    };
    liveRows.push(row);
    scoringState.graded[item.instance_id] = {
      patch_sha256: item.patch_sha256,
      status: row.status,
      result: row.result,
    };
  }
  const orderedLiveRows = await writeLiveResults(paths.liveResults, liveRows,
    snapshot.instances.map(item => item.instance_id));
  scoringState.graded_instance_ids = Object.keys(scoringState.graded);
  scoringState.active_instance_ids = [];
  scoringState.status = "completed";
  scoringState.failure = undefined;
  scoringState.last_harness = {
    exit_code: harnessExit(harnessResult),
    instance_ids: pending.map(item => item.instance_id),
    completed_at: new Date().toISOString(),
  };
  scoringState.updated_at = scoringState.last_harness.completed_at;
  await atomicWriteJson(paths.state, scoringState);
  await appendLog(paths.log, {
    event: "grader-completed",
    at: scoringState.updated_at,
    instance_ids: pending.map(item => item.instance_id),
    inference_running: inferenceStillRunning(input.state),
  });
  return {
    status: "completed",
    coalesced: false,
    started: true,
    inference_running: inferenceStillRunning(input.state),
    snapshot,
    request,
    harness: safeHarnessResult(harnessResult),
    results: scored,
    live_results: orderedLiveRows,
    state: scoringState,
    paths,
  };
}

const inFlight = new Map();

function coalesceKey(options) {
  if (options.scoringStatePath || options.scoringState) return resolve(options.scoringStatePath ?? options.scoringState);
  if (options.supervisorStatePath || options.inferenceStatePath || options.statePath) {
    return resolve(options.supervisorStatePath ?? options.inferenceStatePath ?? options.statePath);
  }
  return resolve(options.runRoot ?? process.cwd());
}

/** Run at most one official grader for a run root; concurrent calls share one Promise. */
export function runIncrementalGrader(options = {}, dependencies = {}) {
  const key = coalesceKey(options);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = runIncrementalGraderOnce(options, dependencies)
    .finally(() => { if (inFlight.get(key) === promise) inFlight.delete(key); });
  inFlight.set(key, promise);
  return promise;
}

export const requestIncrementalGrader = runIncrementalGrader;
export const runIncrementalGrade = runIncrementalGrader;
export const startIncrementalGrader = runIncrementalGrader;
export const gradeCompletedInstances = runIncrementalGrader;

export function clearGraderCoalescing() {
  inFlight.clear();
}

export function parseArguments(argv) {
  const options = { split: OFFICIAL_SCORING_SPLIT, maxWorkers: OFFICIAL_SCORING_MAX_WORKERS };
  let grade = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--grade") { grade = true; continue; }
    if (["--state", "--supervisor-state", "--scoring-state", "--run-root", "--log", "--live-results", "--snapshot",
      "--request", "--predictions", "--harness-executable"].includes(argument)) {
      const value = argv[++index];
      if (!value) throw new Error(`missing-value:${argument}`);
      const field = {
        "--state": "supervisorStatePath", "--supervisor-state": "supervisorStatePath", "--scoring-state": "scoringStatePath",
        "--run-root": "runRoot", "--log": "scoringLogPath", "--live-results": "liveResultsPath", "--snapshot": "snapshotPath",
        "--request": "requestPath", "--predictions": "predictionsPath", "--harness-executable": "harnessExecutable",
      }[argument];
      options[field] = value;
      continue;
    }
    if (argument === "--split") {
      const value = argv[++index];
      if (!value) throw new Error("missing-value:--split");
      options.split = value;
      continue;
    }
    if (argument === "--max-workers") {
      options.maxWorkers = Number(argv[++index]);
      continue;
    }
    throw new Error(`unknown-option:${argument}`);
  }
  if (!grade) throw new Error("grader-mode-required");
  if (options.split !== OFFICIAL_SCORING_SPLIT) throw errorWithCode("grader-split-required", options.split);
  if (options.maxWorkers !== OFFICIAL_SCORING_MAX_WORKERS) throw errorWithCode("grader-max-workers-required", options.maxWorkers);
  if (!options.supervisorStatePath) throw new Error("grader-state-required");
  return options;
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const options = parseArguments(process.argv.slice(2));
  runIncrementalGrader(options)
    .then(result => process.stdout.write(`${JSON.stringify({ status: result.status, started: result.started })}\n`))
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
