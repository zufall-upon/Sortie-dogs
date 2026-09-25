import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { appendFile, chmod, lstat, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { estimateModelUsageCost } from "../dist/plugin/model-cost.js";
import { startV2ReleaseServer, v2PluginWrapperSource } from "./release-cli.mjs";

const execFileAsync = promisify(execFile);
const MAX_COMMAND_OUTPUT = 8 * 1024 * 1024;
export const MAX_REPLAY_ARTIFACT_BYTES = 8 * 1024 * 1024;
const DEFAULT_AGENT = "dog-operator";
const DEFAULT_TIMEOUT_SECONDS = 30 * 60;
const DEFAULT_WATCHDOG_SECONDS = 120;
const BENCHMARK_ENVIRONMENT_KEYS = Object.freeze([
  "LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "PATH", "SHELL", "TERM", "TZ", "USER",
  "WSL_DISTRO_NAME",
]);

const PUBLIC_INSTANCE_FIELDS = Object.freeze([
  "instance_id",
  "repo",
  "base_commit",
  "problem_statement",
  "version",
  "environment_setup_commit",
]);

const OPTIONAL_PUBLIC_INSTANCE_FIELDS = Object.freeze([
  "created_at",
]);

const INSTANCE_INPUT_FIELDS = Object.freeze([
  ...PUBLIC_INSTANCE_FIELDS,
  ...OPTIONAL_PUBLIC_INSTANCE_FIELDS,
]);

const INFERENCE_MANIFEST_FIELDS = Object.freeze([
  "schema_version",
  "dataset",
  "candidate",
  "instances",
]);

const DATASET_FIELDS = Object.freeze([
  "id",
  "revision",
  "split",
]);

const FIXED_LITE_DATASET = Object.freeze({
  id: "princeton-nlp/SWE-bench_Lite",
  revision: "6ec7bb89b9342f664a54a6e0a6ea6501d3437cc2",
});
const LITE_DATASET_SPLITS = Object.freeze(["dev", "test"]);
const PUBLIC_ROW_LOCK = JSON.parse(readFileSync(new URL("./swebench-lite-public-lock.json", import.meta.url), "utf8"));

const HIDDEN_INSTANCE_FIELDS = Object.freeze([
  "patch",
  "test_patch",
  "hints_text",
  "FAIL_TO_PASS",
  "PASS_TO_PASS",
]);

const REQUIRED_INSTANCE_FIELDS = Object.freeze([
  "instance_id",
  "repo",
  "base_commit",
  "problem_statement",
]);

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;

const CANDIDATE_FIELDS = Object.freeze([
  "package_tgz",
  "sha256",
  "version",
  "runtime_marker",
  "profile",
  "agent",
]);

const ensure = (condition, message) => {
  if (!condition) throw new Error(message);
};

const hasExactFields = (value, fields) =>
  Object.keys(value).sort().join("\0") === [...fields].sort().join("\0");

const exists = async path => Boolean(await stat(path).catch(error => {
  if (error?.code === "ENOENT") return null;
  throw error;
}));

export function benchmarkEnvironment(source = process.env) {
  return Object.fromEntries(BENCHMARK_ENVIRONMENT_KEYS.flatMap(key =>
    typeof source[key] === "string" && source[key].length > 0 ? [[key, source[key]]] : []));
}

export function benchmarkPermissionPolicy(externalDirectory) {
  const rules = [
    { action: "webfetch", resource: "*", effect: "deny" },
    { action: "websearch", resource: "*", effect: "deny" },
    { action: "shell", resource: "*", effect: "allow" },
    ...["*curl *", "*wget *", "*gh *", "*ssh *", "*scp *", "*rsync *",
      "*git clone *", "*git fetch *", "*git pull *", "*git push *", "*git ls-remote *",
      "*git remote add *", "*git remote set-url *", "*git archive *--remote*",
      "*http://*", "*https://*", "*git+*"].map(resource => ({ action: "shell", resource, effect: "deny" })),
  ];
  if (typeof externalDirectory === "string" && externalDirectory.length > 0) {
    rules.push({ action: "external_directory", resource: `${resolve(externalDirectory)}/*`, effect: "allow" });
  }
  return rules;
}

export function benchmarkInlineConfig(plugin, agentNames, externalDirectory) {
  const permissions = benchmarkPermissionPolicy(externalDirectory);
  return {
    plugins: [plugin],
    permissions,
    agents: Object.fromEntries(agentNames.map(name => [name, {
      permissions,
    }])),
  };
}

export function verifyCandidateAgent(name, resolvedAgent) {
  ensure(resolvedAgent?.id === name, `candidate-agent-not-loaded:${name}`);
  const rules = Array.isArray(resolvedAgent.permissions) ? resolvedAgent.permissions : [];
  const denied = (action, resource) => {
    const matching = rules.filter(rule => (rule.action === action || rule.action === "*") &&
      (rule.resource === resource || rule.resource === "*"));
    return matching.at(-1)?.effect === "deny";
  };
  ensure(denied("webfetch", "*") && denied("websearch", "*"),
    `candidate-agent-web-permission-invalid:${name}`);
  ensure(denied("shell", "*https://*"), `candidate-agent-network-permission-invalid:${name}`);
  const sol = name === "dog-operator" || name === "dogs-coordinator" ||
    name === "dog-reviewer-v010" || name === "dog-advisor-v010";
  const target = sol ? ["gpt-6-sol", "xhigh"] : ["gpt-6-luna-fast", "max"];
  const selected = resolvedAgent.model;
  ensure(selected?.providerID === "openai" && (selected.id ?? selected.model) === target[0] &&
    selected.variant === target[1], `candidate-agent-model-mismatch:${name}`);
}

const text = (value, field, allowEmpty = false) => {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) throw new Error(`invalid-instance-field:${field}`);
  return value;
};

const record = value => value !== null && typeof value === "object" && !Array.isArray(value);

const digest = value => createHash("sha256").update(value).digest("hex");

const canonicalize = value => Array.isArray(value)
  ? value.map(canonicalize)
  : record(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
    : value;

const canonicalJson = value => JSON.stringify(canonicalize(value));

const publicRowDigest = instance => digest(canonicalJson(Object.fromEntries(PUBLIC_INSTANCE_FIELDS
  .filter(field => instance[field] !== undefined)
  .map(field => [field, instance[field]]))));

function lockedPublicRows(dataset, instances, override) {
  const rowHashes = override ?? PUBLIC_ROW_LOCK?.splits?.[dataset.split]?.rows;
  ensure(record(rowHashes), "invalid-lite-public-row-lock");
  if (override === undefined) {
    ensure(PUBLIC_ROW_LOCK.schema_version === 1 && PUBLIC_ROW_LOCK.dataset?.id === FIXED_LITE_DATASET.id &&
      PUBLIC_ROW_LOCK.dataset?.revision === FIXED_LITE_DATASET.revision,
    "invalid-lite-public-row-lock");
    const splitLock = PUBLIC_ROW_LOCK.splits?.[dataset.split];
    ensure(Number.isInteger(splitLock?.row_count) && splitLock.row_count === Object.keys(rowHashes).length,
      "invalid-lite-public-row-lock");
  }
  for (const instance of instances) {
    ensure(typeof rowHashes[instance.instance_id] === "string", `instance-not-in-lite-dataset:${instance.instance_id}`);
    ensure(rowHashes[instance.instance_id] === publicRowDigest(instance),
      `instance-public-data-mismatch:${instance.instance_id}`);
  }
}

const replayFailure = message => {
  const error = new Error(message);
  error.replayFatal = true;
  return error;
};

const ensureReplay = (condition, message) => {
  if (!condition) throw replayFailure(message);
};

const environmentHash = environment => {
  ensureReplay(record(environment), "replay-environment-invalid");
  return digest(canonicalJson(environment));
};

const candidateEvidenceHash = evidence => {
  ensureReplay(record(evidence), "replay-candidate-evidence-invalid");
  return digest(canonicalJson(evidence));
};

const optionalHash = (value, field) => {
  if (value === undefined) return undefined;
  ensureReplay(typeof value === "string" && /^[a-f0-9]{64}$/u.test(value), `invalid-${field}`);
  return value;
};

function candidateIdentity(value) {
  if (!record(value) || !hasExactFields(value, CANDIDATE_FIELDS)) {
    throw new Error("invalid-candidate");
  }
  const candidate = {
    package_tgz: text(value.package_tgz, "candidate.package_tgz"),
    sha256: text(value.sha256, "candidate.sha256"),
    version: text(value.version, "candidate.version"),
    runtime_marker: text(value.runtime_marker, "candidate.runtime_marker"),
    profile: text(value.profile, "candidate.profile"),
    agent: text(value.agent, "candidate.agent"),
  };
  ensure(/^[a-f0-9]{64}$/u.test(candidate.sha256), "invalid-candidate-sha256");
  ensure(candidate.profile === "v010", "invalid-candidate-profile");
  ensure(candidate.agent === DEFAULT_AGENT, "invalid-candidate-agent");
  return Object.freeze(candidate);
}

function fixedLiteDataset(value) {
  if (!record(value) || !hasExactFields(value, DATASET_FIELDS)) {
    throw new Error("invalid-lite-dataset");
  }
  const dataset = {
    id: text(value.id, "dataset.id"),
    revision: text(value.revision, "dataset.revision"),
    split: text(value.split, "dataset.split"),
  };
  for (const field of ["id", "revision"]) {
    ensure(dataset[field] === FIXED_LITE_DATASET[field], `invalid-lite-dataset-${field}`);
  }
  ensure(LITE_DATASET_SPLITS.includes(dataset.split), "invalid-lite-dataset-split");
  return dataset;
}

function publicInstance(value) {
  if (!record(value)) throw new Error("invalid-instance");
  for (const field of HIDDEN_INSTANCE_FIELDS) {
    if (Object.hasOwn(value, field)) throw new Error(`hidden-instance-field:${field}`);
  }
  if (Object.keys(value).some(field => !INSTANCE_INPUT_FIELDS.includes(field))) {
    throw new Error("invalid-public-instance-fields");
  }
  for (const field of REQUIRED_INSTANCE_FIELDS) text(value[field], field);
  for (const field of PUBLIC_INSTANCE_FIELDS) {
    if (value[field] !== undefined) text(value[field], field);
  }
  for (const field of OPTIONAL_PUBLIC_INSTANCE_FIELDS) {
    if (Object.hasOwn(value, field)) text(value[field], field);
  }
  ensure(REPOSITORY_PATTERN.test(value.repo), "invalid-instance-repo");
  ensure(COMMIT_PATTERN.test(value.base_commit), "invalid-instance-base-commit");
  if (value.environment_setup_commit !== undefined) {
    ensure(COMMIT_PATTERN.test(value.environment_setup_commit), "invalid-instance-environment-setup-commit");
  }
  const instancePrefix = `${value.repo.replace("/", "__")}-`;
  ensure(value.instance_id.startsWith(instancePrefix) && /^\d+$/u.test(value.instance_id.slice(instancePrefix.length)),
    "instance-id-repo-mismatch");
  const fields = [...PUBLIC_INSTANCE_FIELDS, ...OPTIONAL_PUBLIC_INSTANCE_FIELDS];
  return Object.freeze(Object.fromEntries(fields
    .filter(field => value[field] !== undefined)
    .map(field => [field, text(value[field], field)])));
}

export function createInferenceManifest(value, publicRowHashes) {
  if (!record(value) || !hasExactFields(value, INFERENCE_MANIFEST_FIELDS) || value.schema_version !== 1 ||
      !record(value.dataset) || !record(value.candidate) ||
      !Array.isArray(value.instances)) {
    throw new Error("invalid-inference-manifest");
  }
  const dataset = fixedLiteDataset(value.dataset);
  if (value.instances.length === 0) throw new Error("empty-inference-manifest");
  const instances = value.instances.map(publicInstance).sort((left, right) =>
    left.instance_id < right.instance_id ? -1 : left.instance_id > right.instance_id ? 1 : 0);
  if (new Set(instances.map(instance => instance.instance_id)).size !== instances.length) {
    throw new Error("duplicate-instance-id");
  }
  lockedPublicRows(dataset, instances, publicRowHashes);
  return {
    schema_version: 1,
    mode: "host-inference-for-official-docker-scoring",
    dataset,
    candidate: candidateIdentity(value.candidate),
    policy: {
      attempts_per_instance: 1,
      retry_count: 0,
      scoring: "official-swebench-harness",
      live_process_started: false,
    },
    instances,
  };
}

export function formatPrediction(value) {
  if (!record(value) || !hasExactFields(value, ["instance_id", "model_name_or_path", "model_patch"])) {
    throw new Error("invalid-prediction");
  }
  return JSON.stringify({
    instance_id: text(value.instance_id, "prediction.instance_id"),
    model_name_or_path: text(value.model_name_or_path, "prediction.model_name_or_path"),
    model_patch: text(value.model_patch, "prediction.model_patch", true),
  });
}

function replayExecution(value) {
  const execution = record(value) ? value : {};
  if (execution.output_limit_exceeded === true) {
    throw replayFailure("replay-artifact-capacity-exceeded:command-output");
  }
  const command = execution.command === undefined || execution.command === null
    ? null : text(execution.command, "replay.execution.command");
  const stdout = execution.stdout === undefined ? "" : execution.stdout;
  const stderr = execution.stderr === undefined ? "" : execution.stderr;
  ensureReplay(typeof stdout === "string", "invalid-replay-execution-stdout");
  ensureReplay(typeof stderr === "string", "invalid-replay-execution-stderr");
  ensureReplay(Buffer.byteLength(stdout) <= MAX_COMMAND_OUTPUT,
    "replay-artifact-capacity-exceeded:stdout");
  ensureReplay(Buffer.byteLength(stderr) <= MAX_COMMAND_OUTPUT,
    "replay-artifact-capacity-exceeded:stderr");
  const exit = execution.exit === undefined || execution.exit === null ? null : execution.exit;
  ensureReplay(exit === null || Number.isInteger(exit), "invalid-replay-execution-exit");
  const signal = execution.signal === undefined || execution.signal === null ? null : execution.signal;
  ensureReplay(signal === null || typeof signal === "string", "invalid-replay-execution-signal");
  return {
    command,
    exit,
    exit_code: exit,
    signal,
    stdout,
    stderr,
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    reason: execution.reason ?? null,
  };
}

export function createInstanceReplayArtifact(value) {
  if (!record(value) || !record(value.instance) || !record(value.dataset)) {
    throw replayFailure("invalid-replay-artifact-input");
  }
  const instanceInput = { ...value.instance };
  delete instanceInput.prompt;
  const instance = publicInstance(instanceInput);
  const execution = replayExecution(value.execution);
  const patch = value.patch === undefined ? "" : value.patch;
  ensureReplay(typeof patch === "string", "invalid-replay-patch");
  const candidateSha256 = optionalHash(value.candidate_sha256, "replay-candidate-sha256");
  const environmentSha256 = optionalHash(value.environment_sha256, "replay-environment-sha256");
  ensureReplay(candidateSha256 !== undefined && environmentSha256 !== undefined,
    "replay-hashes-required");
  const maxBytes = value.max_bytes ?? MAX_REPLAY_ARTIFACT_BYTES;
  ensureReplay(Number.isInteger(maxBytes) && maxBytes > 0, "invalid-replay-artifact-capacity");
  const artifact = {
    schema_version: 1,
    kind: "swebench-instance-replay",
    mode: text(value.mode, "replay.mode"),
    official_scoring_boundary: text(value.official_scoring_boundary, "replay.official_scoring_boundary"),
    public_input: {
      dataset: value.dataset,
      instance,
      prompt: createInstancePrompt(instance),
    },
    candidate: {
      sha256: candidateSha256,
      evidence_sha256: value.candidate_evidence_sha256 === undefined
        ? null : optionalHash(value.candidate_evidence_sha256, "replay-candidate-evidence-sha256"),
    },
    environment: { sha256: environmentSha256 },
    candidate_sha256: candidateSha256,
    environment_sha256: environmentSha256,
    execution,
    status: text(value.status, "replay.status"),
    patch,
    patch_bytes: Buffer.byteLength(patch),
    patch_sha256: patch.length > 0 ? digest(patch) : null,
    ...(value.failure === undefined ? {} : { failure: text(value.failure, "replay.failure") }),
    ...(value.cleanup_error === undefined ? {} : { cleanup_error: text(value.cleanup_error, "replay.cleanup_error") }),
  };
  const encoded = Buffer.from(`${canonicalJson(artifact)}\n`);
  ensureReplay(encoded.byteLength <= maxBytes, "replay-artifact-capacity-exceeded");
  return artifact;
}

async function writeBoundedJson(path, value, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_REPLAY_ARTIFACT_BYTES;
  ensureReplay(Number.isInteger(maxBytes) && maxBytes > 0, "invalid-replay-artifact-capacity");
  const encoded = Buffer.from(`${canonicalJson(value)}\n`);
  ensureReplay(encoded.byteLength <= maxBytes, "replay-artifact-capacity-exceeded");
  const expectedHash = digest(encoded);
  const temporary = `${path}.tmp`;
  const remove = options.remove ?? rm;
  let committed = false;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, encoded, { flag: "wx" });
    const staged = await readFile(temporary);
    ensureReplay(digest(staged) === expectedHash, "replay-artifact-hash-mismatch");
    await rename(temporary, path);
    committed = true;
    const stored = await readFile(path);
    ensureReplay(digest(stored) === expectedHash, "replay-artifact-hash-mismatch");
    return { path, bytes: stored.byteLength, sha256: expectedHash };
  } catch (error) {
    let cleanupError;
    try { await remove(temporary, { force: true }); } catch (cleanup) { cleanupError = cleanup; }
    if (committed) {
      try { await remove(path, { force: true }); } catch (cleanup) { cleanupError ??= cleanup; }
    }
    if (cleanupError) {
      throw replayFailure(`replay-artifact-cleanup-failed:${String(cleanupError.message ?? cleanupError)}`);
    }
    if (error?.replayFatal) throw error;
    throw replayFailure(`replay-artifact-write-failed:${String(error?.message ?? error)}`);
  }
}

async function writeRunOutputs(outputPath, predictions, metadataPath, metadata, remove = rm) {
  const outputTemporary = `${outputPath}.tmp`;
  const metadataTemporary = `${metadataPath}.tmp`;
  const temporaryPaths = [outputTemporary, metadataTemporary];
  const committedPaths = [];
  try {
    await writeFile(outputTemporary, predictions, { flag: "wx" });
    await writeFile(metadataTemporary, metadata, { flag: "wx" });
    await rename(metadataTemporary, metadataPath);
    committedPaths.push(metadataPath);
    await rename(outputTemporary, outputPath);
    committedPaths.push(outputPath);
  } catch (error) {
    let cleanupError;
    for (const path of [...temporaryPaths, ...committedPaths]) {
      try { await remove(path, { force: true }); } catch (cleanup) { cleanupError ??= cleanup; }
    }
    if (cleanupError) {
      throw replayFailure(`run-output-cleanup-failed:${String(cleanupError.message ?? cleanupError)}`);
    }
    throw replayFailure(`run-output-write-failed:${String(error?.message ?? error)}`);
  }
}

export async function writeReplayArtifact(path, value, options = {}) {
  return writeBoundedJson(path, value, options);
}

export function createReplayManifest(value) {
  if (!record(value) || !record(value.dataset) || !Array.isArray(value.artifacts)) {
    throw replayFailure("invalid-replay-manifest-input");
  }
  const candidateSha256 = optionalHash(value.candidate_sha256, "replay-candidate-sha256");
  const environmentSha256 = optionalHash(value.environment_sha256, "replay-environment-sha256");
  ensureReplay(candidateSha256 !== undefined && environmentSha256 !== undefined,
    "replay-hashes-required");
  const manifest = {
    schema_version: 1,
    kind: "swebench-replay-manifest",
    mode: text(value.mode, "replay.mode"),
    dataset: value.dataset,
    official_scoring_boundary: text(value.official_scoring_boundary, "replay.official_scoring_boundary"),
    candidate: {
      sha256: candidateSha256,
      evidence_sha256: value.candidate_evidence_sha256 === undefined
        ? null : optionalHash(value.candidate_evidence_sha256, "replay-candidate-evidence-sha256"),
    },
    environment: { sha256: environmentSha256 },
    candidate_sha256: candidateSha256,
    environment_sha256: environmentSha256,
    policy: { attempts_per_instance: 1, retry_count: 0, scoring: "official-swebench-harness" },
    artifacts: value.artifacts,
  };
  const maxBytes = value.max_bytes ?? MAX_REPLAY_ARTIFACT_BYTES;
  const encoded = Buffer.from(`${canonicalJson(manifest)}\n`);
  ensureReplay(Number.isInteger(maxBytes) && maxBytes > 0, "invalid-replay-artifact-capacity");
  ensureReplay(encoded.byteLength <= maxBytes, "replay-artifact-capacity-exceeded");
  return manifest;
}

function validateExecutionHashes(execution, candidateSha256, environmentSha256, patch) {
  if (!record(execution)) return;
  const reportedCandidate = execution.candidate_sha256 ?? execution.candidate_hash;
  const reportedEnvironment = execution.environment_sha256 ?? execution.environment_hash;
  const reportedPatch = execution.patch_sha256;
  if (reportedCandidate !== undefined) {
    ensureReplay(reportedCandidate === candidateSha256, "replay-candidate-hash-mismatch");
  }
  if (reportedEnvironment !== undefined) {
    ensureReplay(reportedEnvironment === environmentSha256, "replay-environment-hash-mismatch");
  }
  if (reportedPatch !== undefined) {
    ensureReplay(reportedPatch === (patch.length > 0 ? digest(patch) : null), "replay-patch-hash-mismatch");
  }
}

async function persistReplayFile(writer, path, value, maxBytes, remove) {
  let result;
  try {
    result = await writer(path, value, { maxBytes, remove });
  } catch (error) {
    if (error?.replayFatal) throw error;
    let cleanupError;
    try { await remove(path, { force: true }); } catch (cleanup) { cleanupError = cleanup; }
    if (cleanupError) {
      throw replayFailure(`replay-artifact-cleanup-failed:${String(cleanupError.message ?? cleanupError)}`);
    }
    throw replayFailure(`replay-artifact-write-failed:${String(error?.message ?? error)}`);
  }
  const expected = Buffer.from(`${canonicalJson(value)}\n`);
  let stored;
  try {
    stored = await readFile(path);
    ensureReplay(stored.byteLength <= maxBytes, "replay-artifact-capacity-exceeded");
    ensureReplay(digest(stored) === digest(expected), "replay-artifact-hash-mismatch");
    if (result?.sha256 !== undefined) ensureReplay(result.sha256 === digest(stored), "replay-artifact-hash-mismatch");
  } catch (error) {
    let cleanupError;
    try { await remove(path, { force: true }); } catch (cleanup) { cleanupError = cleanup; }
    if (cleanupError) {
      throw replayFailure(`replay-artifact-cleanup-failed:${String(cleanupError.message ?? cleanupError)}`);
    }
    if (error?.replayFatal) throw error;
    throw replayFailure(`replay-artifact-write-failed:${String(error?.message ?? error)}`);
  }
  return { path, bytes: stored.byteLength, sha256: digest(stored) };
}

export function createInstancePrompt(instance) {
  const version = instance.version === undefined ? "" : `\nTarget package version: ${instance.version}`;
  return [
    "Solve this public SWE-bench issue in the checked-out repository.",
    "Use the repository's existing development workflow and leave the fix as an uncommitted working-tree diff.",
    "The current working directory is the repository root; when supplying a path yourself, use a relative path and never guess or reconstruct the repository's absolute path.",
    "For initial repository discovery, omit the path argument from glob and grep, and read the repository root as '.'; keep later tool inputs relative and never copy absolute paths returned by tools.",
    "For shell commands, omit the workdir argument and use the current repository directory; never construct or copy an absolute workdir.",
    "Keep every glob, grep, read, and shell path relative even after coordinator or worker handoffs; only the host may use absolute workspace paths.",
    "Before editing, reproduce the public issue with its smallest concrete example and locate the existing focused regression test or tests that express the expected behavior.",
    "Time-box dependency setup to a brief, repository-documented attempt; do not repeatedly create environments or install unrelated packages.",
    "Installing repository-declared build/runtime/test dependencies from package registries is allowed. Follow the repository's compatible versions; do not impose an offline install or a conflicting latest-package pin merely because web/solution retrieval is forbidden.",
    "If a dependency remains unavailable, inspect the source and implement the smallest plausible fix, then run every focused check that the available environment permits.",
    "If required behavioral verification still cannot execute, retain the patch and report a blocked/incomplete outcome, not succeeded completion based on compilation or an unrelated reproduction.",
    "Do not invent an expected output from the issue alone; inspect existing public code, nearby visitor methods, node string or name conventions, and public tests before choosing a regression assertion.",
    "When public tests do not state the expected representation, derive it from the repository's established analogous representation and keep the assertion aligned with that convention.",
    "After editing, rerun that exact reproduction plus the focused regression test and at least one adjacent relevant test; do not finalize a patch that only passes syntax checks or a self-invented test while the issue's focused test still fails.",
    "Read the complete focused test failure and adjust the implementation until the public scenario and focused regression pass; keep the final diff limited to the fix and necessary regression coverage.",
    "Do not commit, push, access Git remotes or history beyond the checked-out base commit, browse the web, or access benchmark solution metadata.",
    "Do not use issue or pull-request pages, mirrors, hints, gold patches, test patches, or hidden evaluation tests.",
    `Repository: ${instance.repo}`,
    `Base commit: ${instance.base_commit}${version}`,
    "Public issue statement:",
    instance.problem_statement,
  ].join("\n");
}

export function createLiveRunPlan(value, options = {}, publicRowHashes) {
  const manifest = createInferenceManifest(value, publicRowHashes);
  const agent = options.agent ?? manifest.candidate.agent;
  const modelNameOrPath = options.modelNameOrPath ??
    `sortie-dogs@${manifest.candidate.version}+${manifest.candidate.sha256.slice(0, 12)}`;
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const watchdogSeconds = options.watchdogSeconds ?? DEFAULT_WATCHDOG_SECONDS;
  const costLimitUsd = options.costLimitUsd;
  ensure(typeof agent === "string" && agent.length > 0, "invalid-live-agent");
  ensure(agent === manifest.candidate.agent, "candidate-agent-mismatch");
  ensure(typeof modelNameOrPath === "string" && modelNameOrPath.length > 0, "invalid-model-name-or-path");
  ensure(Number.isInteger(timeoutSeconds) && timeoutSeconds > 0, "invalid-timeout-seconds");
  ensure(Number.isInteger(watchdogSeconds) && watchdogSeconds > 0, "invalid-watchdog-seconds");
  ensure(Number.isFinite(costLimitUsd) && costLimitUsd > 0, "live-cost-limit-usd-required");
  return {
    ...manifest,
    mode: "host-inference-for-official-docker-scoring",
    policy: {
      ...manifest.policy,
      live_process_started: true,
    },
    execution: {
      inference: "host-wsl-opencode",
      scoring: "external-official-docker-harness-after-patch-freeze",
      agent,
      model_name_or_path: modelNameOrPath,
      timeout_seconds: timeoutSeconds,
      watchdog_interval_seconds: watchdogSeconds,
      cost_limit_usd: costLimitUsd,
      live_process_started: false,
      provider_requests_started: false,
    },
    instances: manifest.instances.map(instance => ({ ...instance, prompt: createInstancePrompt(instance) })),
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function repositoryUrl(repo) {
  ensure(REPOSITORY_PATTERN.test(repo), "invalid-repository");
  return `https://github.com/${repo}.git`;
}

async function runGit(args, cwd, environment) {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      env: environment,
      maxBuffer: MAX_COMMAND_OUTPUT,
      timeout: 120_000,
      encoding: "utf8",
    });
    return { exit: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      exit: typeof error?.code === "number" ? error.code : 1,
      stdout: typeof error?.stdout === "string" ? error.stdout : "",
      stderr: typeof error?.stderr === "string" ? error.stderr : String(error?.message ?? error),
      outputOverflow: error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    };
  }
}

export async function cloneInstance(instance, workspace, git = runGit) {
  const initialized = await git(["init", "--quiet", workspace], dirname(workspace));
  ensure(initialized.exit === 0, `clone-init-failed:${instance.instance_id}`);
  const fetched = await git(["-C", workspace, "fetch", "--quiet", "--depth=1", "--no-tags",
    repositoryUrl(instance.repo), instance.base_commit], process.cwd());
  ensure(fetched.exit === 0, `clone-fetch-failed:${instance.instance_id}`);
  const checkedOut = await git(["-C", workspace, "checkout", "--detach", "--quiet", "FETCH_HEAD"], process.cwd());
  ensure(checkedOut.exit === 0, `checkout-failed:${instance.instance_id}`);
  const history = await git(["-C", workspace, "rev-list", "--count", "HEAD"], process.cwd());
  ensure(history.exit === 0 && history.stdout.trim() === "1", `checkout-history-not-shallow:${instance.instance_id}`);
  const remotes = await git(["-C", workspace, "remote"], process.cwd());
  ensure(remotes.exit === 0 && remotes.stdout.trim() === "", `checkout-remote-present:${instance.instance_id}`);
  for (const configPath of ["opencode.json", "opencode.jsonc", ".opencode"]) {
    const present = await lstat(join(workspace, configPath)).then(() => true, error => {
      if (error?.code === "ENOENT") return false;
      throw error;
    });
    ensure(!present, `checkout-opencode-config-present:${instance.instance_id}:${configPath}`);
  }
}

export async function capturePatch(workspace, git = runGit) {
  const patchPaths = [".", ":(exclude).sortie-dogs-v010"];
  const intent = await git(["-C", workspace, "add", "-N", "--", ...patchPaths], process.cwd());
  ensure(intent.exit === 0, "patch-index-failed");
  const diff = await git(["-C", workspace, "diff", "--binary", "--no-ext-diff", "--no-color", "HEAD", "--", ...patchPaths], process.cwd());
  ensure(!diff.outputOverflow, "replay-artifact-capacity-exceeded:patch");
  ensure(diff.exit === 0, "patch-diff-failed");
  return diff.stdout;
}

async function requiredCommand(executable, args, options) {
  try {
    return await execFileAsync(executable, args, {
      ...options,
      env: { ...options.env, PWD: options.cwd },
      maxBuffer: MAX_COMMAND_OUTPUT,
      encoding: "utf8",
      windowsHide: true,
    });
  } catch (error) {
    let failure;
    try { failure = JSON.parse(String(error?.stdout ?? ""))._tag; } catch { /* no typed CLI error */ }
    const stage = executable === "opencode" ? args.slice(0, 3).join(":") : executable;
    throw new Error(`candidate-command-failed:${stage}:${typeof error?.code === "number" ? error.code : error?.code ?? 1}${typeof failure === "string" ? `:${failure}` : ""}`);
  }
}

export async function prepareCandidateRuntime(candidate, packagePath, runRoot, dependencies = {}) {
  ensure(process.platform !== "win32", "live-mode-requires-wsl-login-shell");
  const execute = dependencies.execute ?? requiredCommand;
  const packageBytes = await readFile(packagePath);
  ensure(digest(packageBytes) === candidate.sha256, "candidate-package-sha256-mismatch");
  const candidateRoot = join(runRoot, "candidate-runtime");
  try {
  const configRoot = join(candidateRoot, "opencode");
  // V2 resolves global agents from XDG_CONFIG_HOME/opencode, including when an
  // older init command is given OPENCODE_CONFIG_DIR for the same directory.
  const xdgRoot = candidateRoot;
  const dataRoot = join(candidateRoot, "data");
  const cacheRoot = join(candidateRoot, "cache");
  const homeRoot = join(candidateRoot, "home");
  const temporaryRoot = join(candidateRoot, "tmp");
  await mkdir(configRoot, { recursive: true });
  await mkdir(join(xdgRoot, "opencode"), { recursive: true });
  await mkdir(join(dataRoot, "opencode"), { recursive: true });
  await mkdir(cacheRoot, { recursive: true });
  await mkdir(homeRoot, { recursive: true });
  await mkdir(temporaryRoot, { recursive: true });
  const hostDataRoot = process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share");
  const hostAuth = join(hostDataRoot, "opencode", "auth.json");
  ensure(await exists(hostAuth), "candidate-opencode-auth-unavailable");
  await symlink(hostAuth, join(dataRoot, "opencode", "auth.json"));
  const environment = {
    ...benchmarkEnvironment(),
    HOME: homeRoot,
    OPENCODE_CONFIG_DIR: configRoot,
    OPENCODE_CONFIG: join(configRoot, "opencode.json"),
    XDG_CONFIG_HOME: xdgRoot,
    XDG_DATA_HOME: dataRoot,
    XDG_CACHE_HOME: cacheRoot,
    TMPDIR: temporaryRoot,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(homeRoot, ".gitconfig"),
    GIT_ASKPASS: "/bin/false",
  };
  const versionResult = await execute("opencode", ["--version"], { cwd: candidateRoot, env: environment });
  const opencodeVersion = /(?:^|\s)v?(\d+\.\d+\.\d+)/u.exec(String(versionResult.stdout).trim())?.[1];
  ensure(opencodeVersion !== undefined && Number(opencodeVersion.split(".")[0]) >= 2, "candidate-opencode-v2-required");
  const dependency = `file:${packagePath}`;
  await writeFile(join(configRoot, "package.json"), `${JSON.stringify({ private: true, type: "module", dependencies: {
    "sortie-dogs": dependency,
    "@opencode/plugin": opencodeVersion,
  } }, null, 2)}\n`, { flag: "wx" });
  await execute("npm", ["install", "--force"], { cwd: configRoot, env: environment });
  const installed = join(configRoot, "node_modules", "sortie-dogs");
  ensure(!(await lstat(installed)).isSymbolicLink(), "candidate-package-linked");
  const installedPackage = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  ensure(installedPackage.version === candidate.version, "candidate-package-version-mismatch");
  const versions = await import(`${pathToFileURL(join(installed, "dist", "asset-version.js")).href}?candidate=${candidate.sha256}`);
  ensure(versions.V010_RUNTIME_ASSET_VERSION === candidate.runtime_marker, "candidate-runtime-marker-mismatch");
  const plugin = join(configRoot, "plugins", "sortie-dogs");
  await mkdir(plugin, { recursive: true });
  await writeFile(join(plugin, "index.js"), v2PluginWrapperSource({ id: "v010" }), { flag: "wx" });
  await writeFile(join(configRoot, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    experimental: { subagent_depth: 2 },
    plugins: [plugin],
    permissions: benchmarkPermissionPolicy(runRoot),
  }, null, 2)}\n`, { flag: "wx" });
  await execute(process.execPath, [join(installed, "dist", "cli", "main.js"), "init", "--global", "--profile", candidate.profile],
    { cwd: candidateRoot, env: environment });
  const module = await import(`${pathToFileURL(join(installed, "dist", "runtime-assets-v010.js")).href}?candidate=${candidate.sha256}`);
  ensure(Array.isArray(module.runtimeAssets) && module.runtimeAssets.length > 0, "candidate-runtime-assets-missing");
  const assetHashes = {};
  const agentNames = [];
  for (const asset of module.runtimeAssets) {
    ensure(asset?.version === candidate.runtime_marker && typeof asset.installPath === "string" &&
      typeof asset.content === "string", "candidate-runtime-asset-invalid");
    const installedContent = await readFile(join(configRoot, asset.installPath), "utf8");
    ensure(installedContent === asset.content, "candidate-runtime-asset-mismatch");
    assetHashes[asset.installPath] = digest(installedContent);
    if (asset.installPath.startsWith("agent/") && asset.installPath.endsWith(".md")) {
      agentNames.push(asset.installPath.slice("agent/".length, -".md".length));
    }
  }
  environment.OPENCODE_CONFIG_CONTENT = JSON.stringify(benchmarkInlineConfig(plugin, agentNames, runRoot));
  await (dependencies.probeAgents ?? probeCandidateV2Agents)(candidateRoot, environment, candidate.agent, agentNames);
  // V2 OAuth connections live in its SQLite credential store. The legacy auth.json
  // alone cannot route the model in an isolated server. Copy only the selected
  // provider's credential into the throwaway runtime, never the host session DB.
  await seedIsolatedV2Credential(join(hostDataRoot, "opencode", "opencode.db"),
    join(dataRoot, "opencode", "opencode.db"), join(dataRoot, "opencode"));
  return {
    environment,
    runtimeRoot: candidateRoot,
    databasePath: join(dataRoot, "opencode", "opencode.db"),
    evidence: {
      package_sha256: candidate.sha256,
      version: candidate.version,
      runtime_marker: candidate.runtime_marker,
      profile: candidate.profile,
      agent: candidate.agent,
      opencode_version: opencodeVersion,
      asset_count: Object.keys(assetHashes).length,
      assets_sha256: digest(JSON.stringify(assetHashes)),
    },
  };
  } catch (error) {
    await rm(candidateRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function seedIsolatedV2Credential(sourcePath, targetPath, targetDirectory) {
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const credential = source.prepare("SELECT id, integration_id, label, value, connector_id, method_id, active, time_created, time_updated FROM credential WHERE integration_id = ? ORDER BY time_updated DESC LIMIT 1").get("openai");
    ensure(credential !== undefined && JSON.parse(credential.value).type === "oauth", "candidate-openai-credential-unavailable");
    await chmod(targetDirectory, 0o700);
    await chmod(targetPath, 0o600);
    const target = new DatabaseSync(targetPath);
    try {
      target.prepare("INSERT INTO credential (id, integration_id, label, value, connector_id, method_id, active, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        credential.id, credential.integration_id, credential.label, credential.value, credential.connector_id,
        credential.method_id, credential.active, credential.time_created, credential.time_updated);
    } finally { target.close(); }
  } finally { source.close(); }
}

async function probeCandidateV2Agents(root, environment, primary, agentNames) {
  const server = await startV2ReleaseServer(root, environment);
  try {
    const headers = { "content-type": "application/json",
      authorization: `Basic ${Buffer.from(`opencode:${server.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}` };
    const request = async (path, method = "GET", body) => {
      const response = await fetch(`${server.url}${path}`, { method, headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(25_000) });
      ensure(response.ok, `candidate-v2-api-failed:${method}:${path.split("/").slice(0, 3).join("/")}:${response.status}`);
      return response.status === 204 ? undefined : response.json();
    };
    // Switching an empty session resolves the native agent registry without a model request.
    const session = await request("/api/session", "POST", { title: "Candidate configuration check (no inference)" });
    ensure(typeof session?.data?.id === "string", "candidate-preflight-session-unavailable");
    await request(`/api/session/${encodeURIComponent(session.data.id)}/agent`, "POST", { agent: primary });
    let plugins;
    const deadline = Date.now() + 10_000;
    do {
      plugins = await request("/api/plugin");
      if (plugins.data?.some(plugin => plugin.id === "sortie-dogs.v010")) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    } while (Date.now() < deadline);
    ensure(plugins.data?.some(plugin => plugin.id === "sortie-dogs.v010"), "candidate-plugin-not-loaded");
    const agents = await request("/api/agent");
    for (const name of agentNames) verifyCandidateAgent(name, agents.data?.find(agent => agent.id === name));
  } finally { await server.stop(); }
}

async function killProcessGroup(pid, force = false) {
  if (!Number.isInteger(pid)) return;
  if (process.platform === "win32") {
    await new Promise(resolvePromise => {
      const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", () => resolvePromise());
      killer.once("close", () => resolvePromise());
    });
    return;
  }
  try { process.kill(-pid, force ? "SIGKILL" : "SIGTERM"); } catch { /* process already exited */ }
}

function processGroupAlive(pid) {
  if (!Number.isInteger(pid) || process.platform === "win32") return false;
  try { process.kill(-pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

async function terminateProcessGroup(pid) {
  if (!Number.isInteger(pid)) return true;
  await killProcessGroup(pid, false);
  if (process.platform === "win32") return true;
  for (let attempt = 0; attempt < 100 && processGroupAlive(pid); attempt += 1) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  if (!processGroupAlive(pid)) return true;
  await killProcessGroup(pid, true);
  for (let attempt = 0; attempt < 20 && processGroupAlive(pid); attempt += 1) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  return !processGroupAlive(pid);
}

function usageDatabasePath() {
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "opencode", "opencode.db");
}

export function readDirectoryUsage(directory, databasePath = usageDatabasePath()) {
  const result = { usd: 0, requests: 0, unpriced: [] };
  if (!existsSync(databasePath)) throw new Error("usage-database-unavailable");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const unpriced = new Set();
  try {
    const v2 = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_v2'").get() !== undefined;
    const sessions = database.prepare(`SELECT id FROM ${v2 ? "session_v2" : "session"} WHERE directory = ?`).all(directory);
    const messages = database.prepare(`SELECT ${v2 ? "type, " : ""}data FROM ${v2 ? "session_message" : "message"} WHERE session_id = ?`);
    for (const session of sessions) {
      for (const row of messages.all(session.id)) {
        let message;
        try { message = JSON.parse(row.data); } catch {
          unpriced.add("missing-usage");
          continue;
        }
        if (v2 ? !["assistant", "compaction"].includes(row.type) : message?.role !== "assistant") continue;
        if (!message?.tokens) {
          // V2 persists the assistant before a model request finishes. Keep the
          // reservation while it is in flight; only a terminal missing usage
          // record is a pricing failure.
          unpriced.add(v2 && !message.time?.completed && !message.error ? "pending-usage" : "missing-usage");
          continue;
        }
        result.requests += 1;
        const tokens = message.tokens;
        const estimate = estimateModelUsageCost({
          providerID: v2 ? message.model?.providerID : message.providerID,
          modelID: v2 ? message.model?.id : message.modelID,
          uncachedInputTokens: tokens.input,
          cacheReadTokens: tokens.cache?.read,
          cacheWriteTokens: tokens.cache?.write,
          outputTokens: tokens.output,
          reasoningTokens: tokens.reasoning,
          serviceTier: v2 ? message.providerState?.serviceTier : message.serviceTier,
        });
        if (estimate.status === "priced") result.usd += estimate.usd;
        else unpriced.add(estimate.reason);
      }
    }
  } finally {
    database.close();
  }
  result.unpriced = [...unpriced];
  return result;
}

export async function runOpenCode(options, dependencies = {}) {
  ensure(process.platform !== "win32", "live-mode-requires-wsl-login-shell");
  const readUsage = dependencies.readUsage ?? readDirectoryUsage;
  const watchdogSeconds = options.watchdogSeconds ?? DEFAULT_WATCHDOG_SECONDS;
  const startedAt = options.startedAt ?? Date.now();
  const command = [
    "exec", "opencode", "run",
    "--standalone",
    "--format", "json",
    "--print-logs",
    "--agent", shellQuote(options.agent),
    "--model", "openai/gpt-6-sol#xhigh",
    shellQuote(options.prompt),
  ].join(" ");
  const child = spawn("bash", ["-ic", command], {
    cwd: options.workspace,
    env: { ...options.environment, PWD: options.workspace },
    detached: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const stdoutChunks = [];
  const stderrChunks = [];
  let outputLimitExceeded = false;
  let lastActivity = Date.now();
  let stopReason = "completed";
  let stopping = false;
  let usage = { usd: 0, requests: 0, unpriced: [] };
  let pollInFlight = false;
  let watchdogInFlight = false;
  let watchdogEvents = 0;
  let cleanupPromise;
  let previousUsage = { usd: 0, requests: 0 };
  let timer;
  let poller;
  let watchdogTimer;
  const stop = async reason => {
    if (stopping) return;
    stopping = true;
    stopReason = reason;
    cleanupPromise ??= terminateProcessGroup(child.pid);
    await cleanupPromise;
  };
  const captureOutput = (chunks, chunk, currentBytes) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const nextBytes = currentBytes + bytes.byteLength;
    const remaining = Math.max(0, MAX_COMMAND_OUTPUT - currentBytes);
    if (remaining > 0) chunks.push(bytes.subarray(0, remaining));
    if (nextBytes > MAX_COMMAND_OUTPUT) {
      outputLimitExceeded = true;
      void stop("output-limit");
    }
    return nextBytes;
  };
  child.stdout?.on("data", chunk => {
    stdoutBytes = captureOutput(stdoutChunks, chunk, stdoutBytes);
    lastActivity = Date.now();
  });
  child.stderr?.on("data", chunk => {
    stderrBytes = captureOutput(stderrChunks, chunk, stderrBytes);
    lastActivity = Date.now();
  });
  const recordWatchdog = async event => {
    if (!options.watchdogPath) return;
    await appendFile(options.watchdogPath, `${JSON.stringify({
      at: new Date().toISOString(),
      event,
      instance_id: options.instanceId,
      pid: child.pid,
      elapsed_ms: Date.now() - startedAt,
      idle_ms: Date.now() - lastActivity,
      stdout_bytes: stdoutBytes,
      stderr_bytes: stderrBytes,
      usage,
    })}\n`, "utf8");
    watchdogEvents += 1;
  };
  try {
    await recordWatchdog("started");
  } catch {
    const cleanupEstablished = await terminateProcessGroup(child.pid);
    return {
      exit: 1,
      signal: null,
      reason: cleanupEstablished ? "watchdog-write-failed" : "cleanup-failed",
      stdoutBytes,
      stderrBytes,
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
      output_limit_exceeded: outputLimitExceeded,
      command,
      usage,
      cleanupEstablished,
      watchdogEvents,
      lastActivityAgeMs: Date.now() - lastActivity,
    };
  }
  const result = await new Promise(resolvePromise => {
    const finish = (exit, signal) => {
      if (timer) clearTimeout(timer);
      if (poller) clearInterval(poller);
      if (watchdogTimer) clearInterval(watchdogTimer);
      resolvePromise({
        exit: exit ?? (signal ? 1 : 0),
        signal,
        reason: stopReason,
        stdoutBytes,
        stderrBytes,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        output_limit_exceeded: outputLimitExceeded,
        command,
      });
    };
    child.once("error", error => { stopReason = "spawn-failed"; finish(127, error.code); });
    child.once("close", finish);
    timer = setTimeout(() => { void stop("timeout"); }, options.timeoutSeconds * 1000);
    if (options.costLimitUsd !== undefined) {
      poller = setInterval(async () => {
        if (pollInFlight || stopping) return;
        pollInFlight = true;
        try {
          usage = readUsage(options.workspace, options.databasePath);
          if (usage.unpriced.some(reason => reason !== "pending-usage")) await stop("pricing-coverage-missing");
          else if (usage.usd >= options.costLimitUsd) await stop("cost-limit");
        } catch {
          await stop("usage-monitor-failed");
        } finally {
          pollInFlight = false;
        }
      }, 1000);
    }
    watchdogTimer = setInterval(async () => {
      if (watchdogInFlight || stopping) return;
      watchdogInFlight = true;
      try {
        const nextUsage = readUsage(options.workspace, options.databasePath);
        if (nextUsage.requests !== previousUsage.requests || nextUsage.usd !== previousUsage.usd) lastActivity = Date.now();
        previousUsage = { usd: nextUsage.usd, requests: nextUsage.requests };
        usage = nextUsage;
        await recordWatchdog("heartbeat");
      } catch {
        await recordWatchdog("usage-read-failed").catch(() => undefined);
        await stop("watchdog-usage-failed");
      } finally {
        watchdogInFlight = false;
      }
    }, watchdogSeconds * 1000);
  });
  cleanupPromise ??= terminateProcessGroup(child.pid);
  const cleanupEstablished = await cleanupPromise;
  try { usage = readUsage(options.workspace, options.databasePath); } catch { usage = { usd: usage.usd, requests: usage.requests, unpriced: ["usage-read-failed"] }; }
  await recordWatchdog("exited").catch(() => undefined);
  const finalReason = !cleanupEstablished ? "cleanup-failed"
    : usage.unpriced.length > 0 ? "pricing-coverage-missing"
      : usage.requests === 0 && result.reason === "completed" ? "usage-unverified"
      : options.costLimitUsd !== undefined && usage.usd >= options.costLimitUsd ? "cost-limit" : result.reason;
  return { ...result, exit: finalReason === "completed" ? result.exit : result.exit === 0 ? 1 : result.exit,
    reason: finalReason, usage, usageComplete: usage.unpriced.length === 0 && usage.requests > 0,
    cleanupEstablished, watchdogEvents, lastActivityAgeMs: Date.now() - lastActivity };
}

function emptyLiveResult(instance, status) {
  return {
    instance_id: instance.instance_id,
    base_commit: instance.base_commit,
    status,
    exit_code: null,
    signal: null,
    patch_bytes: 0,
    patch_sha256: null,
    elapsed_ms: 0,
    usage: { usd: 0, requests: 0, unpriced: [] },
    watchdog_events: 0,
    watchdog_idle_ms: 0,
  };
}

function costEnforcementStopReason(execution) {
  const reason = execution?.reason;
  if (["pricing-coverage-missing", "usage-unverified", "usage-monitor-failed", "watchdog-usage-failed", "usage-read-failed"].includes(reason)) {
    return reason;
  }
  return undefined;
}

export async function runLive(value, options, dependencies = {}) {
  const plan = createLiveRunPlan(value, options, dependencies.publicRowHashes);
  ensure(typeof options.runRoot === "string" && options.runRoot.length > 0, "live-run-root-required");
  ensure(typeof options.output === "string" && options.output.length > 0, "live-output-required");
  const runRoot = resolve(options.runRoot);
  const outputPath = resolve(options.output);
  const metadataPath = resolve(options.metadata ?? `${outputPath}.metadata.json`);
  const replayRoot = resolve(options.replayRoot ?? options.artifactRoot ?? join(runRoot, "replay"));
  const replayManifestPath = resolve(options.replayManifest ?? join(replayRoot, "replay-manifest.json"));
  const replayMaxBytes = options.replayArtifactMaxBytes ?? options.maxReplayArtifactBytes ?? MAX_REPLAY_ARTIFACT_BYTES;
  ensure(Number.isInteger(replayMaxBytes) && replayMaxBytes > 0, "invalid-replay-artifact-capacity");
  if (process.platform === "linux" && /^\/mnt\/[a-z]\//u.test(runRoot)) {
    throw new Error("live-run-root-must-be-wsl-native");
  }
  ensure(!(await exists(runRoot)), "live-run-root-already-exists");
  ensure(!(await exists(outputPath)), "live-output-already-exists");
  ensure(!(await exists(metadataPath)), "live-metadata-already-exists");
  ensure(!(await exists(replayRoot)), "replay-root-already-exists");
  ensure(!(await exists(replayManifestPath)), "replay-manifest-already-exists");
  await mkdir(join(runRoot, "instances"), { recursive: true });
  await mkdir(join(runRoot, "watchdog"), { recursive: true });
  await mkdir(replayRoot, { recursive: true });
  const packagePath = resolve(options.manifest ? dirname(resolve(options.manifest)) : process.cwd(),
    plan.candidate.package_tgz);
  const prepareCandidate = dependencies.prepareCandidate ?? prepareCandidateRuntime;
  const candidateRuntime = await prepareCandidate(plan.candidate, packagePath, runRoot);
  const remove = dependencies.remove ?? rm;
  if (!record(candidateRuntime) || !record(candidateRuntime.environment) || !record(candidateRuntime.evidence) ||
      candidateRuntime.evidence.package_sha256 !== plan.candidate.sha256) {
    if (record(candidateRuntime) && typeof candidateRuntime.runtimeRoot === "string") {
      await remove(candidateRuntime.runtimeRoot, { recursive: true, force: true });
    }
    throw new Error("candidate-runtime-evidence-invalid");
  }
  const candidateSha256 = plan.candidate.sha256;
  const candidateEvidenceSha256 = candidateEvidenceHash(candidateRuntime.evidence);
  const environmentSha256 = environmentHash(candidateRuntime.environment);
  const reportedCandidateHash = candidateRuntime.evidence.candidate_sha256 ?? candidateRuntime.evidence.candidate_hash;
  const reportedEnvironmentHash = candidateRuntime.evidence.environment_sha256 ?? candidateRuntime.evidence.environment_hash;
  if (reportedCandidateHash !== undefined && reportedCandidateHash !== candidateSha256) {
    if (typeof candidateRuntime.runtimeRoot === "string") {
      await remove(candidateRuntime.runtimeRoot, { recursive: true, force: true });
    }
    throw replayFailure("replay-candidate-hash-mismatch");
  }
  if (reportedEnvironmentHash !== undefined && reportedEnvironmentHash !== environmentSha256) {
    if (typeof candidateRuntime.runtimeRoot === "string") {
      await remove(candidateRuntime.runtimeRoot, { recursive: true, force: true });
    }
    throw replayFailure("replay-environment-hash-mismatch");
  }
  const gitCommand = dependencies.git ?? runGit;
  const git = (args, cwd) => gitCommand(args, cwd, candidateRuntime.environment);
  const clone = dependencies.clone ?? ((instance, workspace) => cloneInstance(instance, workspace, git));
  const execute = dependencies.execute ?? (instanceOptions => runOpenCode(instanceOptions));
  const writeReplay = dependencies.writeReplayArtifact ?? writeReplayArtifact;
  const predictions = [];
  const results = [];
  const replayArtifacts = [];
  let spentUsd = 0;
  let stopRemainingReason;
  try { for (const [index, instance] of plan.instances.entries()) {
    const replayArtifactPath = join(replayRoot, "instances", `${String(index).padStart(3, "0")}-${encodeURIComponent(instance.instance_id)}.json`);
    if (stopRemainingReason !== undefined) {
      const notRunStatus = `not-run-${stopRemainingReason}`;
      const artifact = createInstanceReplayArtifact({
        dataset: plan.dataset,
        instance,
        mode: plan.mode,
        official_scoring_boundary: plan.execution.scoring,
        candidate_sha256: candidateSha256,
        candidate_evidence_sha256: candidateEvidenceSha256,
        environment_sha256: environmentSha256,
        execution: { reason: notRunStatus },
        status: notRunStatus,
        patch: "",
        max_bytes: replayMaxBytes,
      });
      const storedArtifact = await persistReplayFile(writeReplay, replayArtifactPath, artifact, replayMaxBytes, remove);
      replayArtifacts.push({
        instance_id: instance.instance_id,
        path: relative(replayRoot, replayArtifactPath).replaceAll("\\", "/"),
        sha256: storedArtifact.sha256,
        status: notRunStatus,
      });
      predictions.push(formatPrediction({ instance_id: instance.instance_id, model_name_or_path: plan.execution.model_name_or_path, model_patch: "" }));
      results.push({ ...emptyLiveResult(instance, notRunStatus), replay_artifact: storedArtifact });
      continue;
    }
    const workspace = join(runRoot, "instances", `${String(index).padStart(3, "0")}-${encodeURIComponent(instance.instance_id)}`);
    const started = Date.now();
    let patch = "";
    let execution;
    let status = "failed";
    let failure;
    let fatalError;
    try {
      await clone(instance, workspace);
      execution = await execute({
        workspace,
        instanceId: instance.instance_id,
        prompt: createInstancePrompt(instance),
        agent: plan.execution.agent,
        environment: candidateRuntime.environment,
        databasePath: candidateRuntime.databasePath,
        timeoutSeconds: plan.execution.timeout_seconds,
        watchdogSeconds: plan.execution.watchdog_interval_seconds,
        watchdogPath: join(runRoot, "watchdog", `${String(index).padStart(3, "0")}-${encodeURIComponent(instance.instance_id)}.jsonl`),
        startedAt: started,
        costLimitUsd: plan.execution.cost_limit_usd === undefined
          ? undefined
          : Math.max(0, plan.execution.cost_limit_usd - spentUsd),
      });
      ensureReplay(record(execution), "invalid-instance-execution-result");
      ensureReplay(execution.cleanupEstablished !== false && execution.reason !== "cleanup-failed",
        "replay-process-cleanup-failed");
      if (execution.output_limit_exceeded === true) {
        throw replayFailure("replay-artifact-capacity-exceeded:command-output");
      }
      if (execution.reason === "completed" && execution.exit === 0) {
        patch = await capturePatch(workspace, git);
        status = patch.length > 0 ? "succeeded" : "empty-patch";
      } else {
        status = execution.reason ?? "failed";
      }
      validateExecutionHashes(execution, candidateSha256, environmentSha256, patch);
    } catch (error) {
      if (error?.replayFatal) {
        fatalError = error;
        failure = error.message;
        status = "replay-failed";
      } else {
        status = error instanceof Error ? error.message : "instance-failed";
        failure = status;
      }
    }
    const usage = execution?.usage ?? { usd: 0, requests: 0, unpriced: [] };
    const usageComplete = execution?.usageComplete === true;
    spentUsd += usage.usd;
    const cleanupError = await remove(workspace, { recursive: true, force: true }).then(() => null, error => error);
    if (cleanupError) {
      status = "cleanup-failed";
      patch = "";
      failure = String(cleanupError.message ?? cleanupError);
      fatalError ??= replayFailure(`replay-artifact-cleanup-failed:${failure}`);
    }
    const monitoringFailure = costEnforcementStopReason(execution);
    if (monitoringFailure !== undefined) stopRemainingReason = monitoringFailure;
    else if (plan.execution.cost_limit_usd !== undefined && spentUsd >= plan.execution.cost_limit_usd) stopRemainingReason = "cost-limit";
    const artifactExecution = execution === undefined ? undefined : { ...execution, output_limit_exceeded: false };
    const artifact = createInstanceReplayArtifact({
      dataset: plan.dataset,
      instance,
      mode: plan.mode,
      official_scoring_boundary: plan.execution.scoring,
      candidate_sha256: candidateSha256,
      candidate_evidence_sha256: candidateEvidenceSha256,
      environment_sha256: environmentSha256,
      execution: artifactExecution,
      status,
      patch: status === "succeeded" ? patch : "",
      ...(failure === undefined ? {} : { failure }),
      ...(cleanupError ? { cleanup_error: String(cleanupError.message ?? cleanupError) } : {}),
      max_bytes: replayMaxBytes,
    });
    const storedArtifact = await persistReplayFile(writeReplay, replayArtifactPath, artifact, replayMaxBytes, remove);
    replayArtifacts.push({
      instance_id: instance.instance_id,
      path: relative(replayRoot, replayArtifactPath).replaceAll("\\", "/"),
      sha256: storedArtifact.sha256,
      status,
    });
    predictions.push(formatPrediction({
      instance_id: instance.instance_id,
      model_name_or_path: plan.execution.model_name_or_path,
      model_patch: status === "succeeded" ? patch : "",
    }));
    results.push({
      instance_id: instance.instance_id,
      base_commit: instance.base_commit,
      status,
      exit_code: execution?.exit ?? null,
      signal: execution?.signal ?? null,
      patch_bytes: status === "succeeded" ? Buffer.byteLength(patch) : 0,
      patch_sha256: status === "succeeded" ? digest(patch) : null,
      elapsed_ms: Date.now() - started,
      usage,
      usage_complete: usageComplete,
      watchdog_events: execution?.watchdogEvents ?? 0,
      watchdog_idle_ms: execution?.lastActivityAgeMs ?? 0,
      replay_artifact: storedArtifact,
      ...(cleanupError ? { cleanup_error: String(cleanupError.message ?? cleanupError) } : {}),
    });
    if (fatalError) throw fatalError;
  } } finally {
    if (typeof candidateRuntime.runtimeRoot === "string") {
      await remove(candidateRuntime.runtimeRoot, { recursive: true, force: true });
    }
  }
  const replayManifest = createReplayManifest({
    dataset: plan.dataset,
    mode: plan.mode,
    official_scoring_boundary: plan.execution.scoring,
    candidate_sha256: candidateSha256,
    candidate_evidence_sha256: candidateEvidenceSha256,
    environment_sha256: environmentSha256,
    artifacts: replayArtifacts,
    max_bytes: replayMaxBytes,
  });
  const storedReplayManifest = await persistReplayFile(writeReplay, replayManifestPath, replayManifest, replayMaxBytes, remove);
  const metadata = {
    schema_version: 1,
    mode: plan.mode,
    dataset: plan.dataset,
    candidate: candidateRuntime.evidence,
    policy: { ...plan.policy, live_process_started: results.some(result => result.exit_code !== null) },
    execution: {
      ...plan.execution,
      live_process_started: results.some(result => result.exit_code !== null),
      provider_requests_started: results.some(result => (result.usage?.requests ?? 0) > 0),
      spent_usd: spentUsd,
      usage_complete: results.every(result => result.usage_complete === true),
    },
    replay: {
      root: replayRoot,
      manifest: storedReplayManifest,
      artifact_count: replayArtifacts.length,
      official_scoring_boundary: plan.execution.scoring,
    },
    results,
  };
  await writeRunOutputs(
    outputPath,
    `${predictions.join("\n")}\n`,
    metadataPath,
    `${JSON.stringify(metadata, null, 2)}\n`,
    remove,
  );
  return { ...metadata, output: outputPath, metadata: metadataPath, replay_manifest: storedReplayManifest };
}

export function createDryRunPlan(value, publicRowHashes) {
  const manifest = createInferenceManifest(value, publicRowHashes);
  return {
    ...manifest,
    execution: {
      inference: "host-wsl-opencode",
      scoring: "external-official-docker-harness-after-patch-freeze",
      live_process_started: false,
      provider_requests_started: false,
    },
  };
}

export async function runDryRun(manifestPath, outputPath, dependencies = {}) {
  const value = JSON.parse(await readFile(manifestPath, "utf8"));
  const plan = createDryRunPlan(value, dependencies.publicRowHashes);
  const packagePath = resolve(dirname(resolve(manifestPath)), plan.candidate.package_tgz);
  ensure(digest(await readFile(packagePath)) === plan.candidate.sha256, "candidate-package-sha256-mismatch");
  const verified = { ...plan, execution: { ...plan.execution, candidate_package_verified: true } };
  if (outputPath) await writeFile(outputPath, `${JSON.stringify(verified, null, 2)}\n`, { flag: "wx" });
  return verified;
}

export function parseArguments(argv) {
  const options = {
    dryRun: false,
    live: false,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    watchdogSeconds: DEFAULT_WATCHDOG_SECONDS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") { options.dryRun = true; continue; }
    if (argument === "--live") { options.live = true; continue; }
    if (["--manifest", "--output", "--metadata", "--run-root", "--agent", "--model-name-or-path", "--timeout-seconds", "--watchdog-seconds", "--cost-limit-usd"].includes(argument)) {
      const value = argv[++index];
      if (!value) throw new Error(`missing-value:${argument}`);
      if (argument === "--manifest") options.manifest = value;
      else if (argument === "--output") options.output = value;
      else if (argument === "--metadata") options.metadata = value;
      else if (argument === "--run-root") options.runRoot = value;
      else if (argument === "--agent") options.agent = value;
      else if (argument === "--model-name-or-path") options.modelNameOrPath = value;
      else if (argument === "--timeout-seconds") options.timeoutSeconds = Number(value);
      else if (argument === "--watchdog-seconds") options.watchdogSeconds = Number(value);
      else options.costLimitUsd = Number(value);
      continue;
    }
    throw new Error(`unknown-option:${argument}`);
  }
  if (options.dryRun === options.live || !options.manifest) throw new Error("exactly-one-run-mode-and-manifest-required");
  if (options.live && (!options.runRoot || !options.output)) throw new Error("live-run-root-output-required");
  if (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds <= 0) throw new Error("invalid-timeout-seconds");
  if (!Number.isInteger(options.watchdogSeconds) || options.watchdogSeconds <= 0) throw new Error("invalid-watchdog-seconds");
  if (options.costLimitUsd !== undefined && (!Number.isFinite(options.costLimitUsd) || options.costLimitUsd <= 0)) {
    throw new Error("invalid-cost-limit-usd");
  }
  if (options.live && options.costLimitUsd === undefined) throw new Error("live-cost-limit-usd-required");
  return options;
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const options = parseArguments(process.argv.slice(2));
  const run = options.live
    ? readFile(options.manifest, "utf8").then(JSON.parse).then(value => runLive(value, options))
    : runDryRun(options.manifest, options.output);
  run
    .then(plan => process.stdout.write(`${JSON.stringify(plan)}\n`))
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
