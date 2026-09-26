import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import test from "node:test";
import { benchmarkEnvironment, benchmarkPythonCacheEnvironment, benchmarkInlineConfig, benchmarkPermissionPolicy, capturePatch, cloneInstance, createDryRunPlan, createInferenceManifest, createInstancePrompt, createLiveRunPlan, runOpenCode, waitForBenchmarkModelRoute, readDirectoryUsage, formatPrediction, officialEvaluationImage, parseArguments, relocateOfficialEnvironment, retainUsageDatabase, runDryRun, runLive, seedIsolatedV2Credential, verifyCandidateAgent } from "../scripts/swebench-lite-runner.mjs";
import { runCandidatePreflight } from "../scripts/swebench-candidate-preflight.mjs";
import { releaseManifest } from "../scripts/swebench-release-manifest.mjs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const instance = (instance_id: string, extra: Record<string, unknown> = {}) => ({
  instance_id,
  repo: "example/project",
  base_commit: "0123456789abcdef0123456789abcdef01234567",
  problem_statement: "Fix the reported issue.",
  version: "1.0",
  environment_setup_commit: "fedcba9876543210fedcba9876543210fedcba98",
  ...extra,
});

const fakeReadyServer = {
  startServer: async (_workspace: string, environment: Record<string, string>) => ({
    url: "http://127.0.0.1:12345", env: environment, stop: async () => undefined,
  }),
  waitForModelRoute: async () => undefined,
};

test("benchmark waits for the selected model and variant before starting a V2 session", async () => {
  let calls = 0;
  await waitForBenchmarkModelRoute({ url: "http://127.0.0.1:12345", env: { OPENCODE_SERVER_PASSWORD: "fixture" } }, {
    fetchModel: async (url: string, options: { headers: { authorization: string } }) => {
      assert.equal(url, "http://127.0.0.1:12345/api/model");
      assert.match(options.headers.authorization, /^Basic /u);
      return { ok: true, json: async () => ({ data: calls++ === 0 ? [] : [{ providerID: "openai", id: "gpt-6-sol",
        variants: [{ id: "xhigh" }] }] }) };
    },
  });
  assert.equal(calls, 2);
  await assert.rejects(waitForBenchmarkModelRoute({ url: "http://127.0.0.1:12345", env: { OPENCODE_SERVER_PASSWORD: "fixture" } }, {
    fetchModel: async () => ({ ok: true, json: async () => ({ data: [] }) }), timeoutMs: 0,
  }), /candidate-v2-model-route-unavailable/u);
});

test("isolated V2 runtime copies only its OAuth route into a private credential store", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-v2-auth-"));
  const directory = join(root, "isolated"), sourcePath = join(root, "source.db"), targetPath = join(directory, "opencode.db");
  const schema = "CREATE TABLE credential (id TEXT, integration_id TEXT, label TEXT, value TEXT, connector_id TEXT, method_id TEXT, active INTEGER, time_created INTEGER, time_updated INTEGER)";
  try {
    await mkdir(directory);
    for (const path of [sourcePath, targetPath]) {
      const db = new DatabaseSync(path);
      try { db.exec(schema); } finally { db.close(); }
    }
    const source = new DatabaseSync(sourcePath);
    try {
      const insert = source.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      insert.run("openai-route", "openai", "fixture", JSON.stringify({ type: "oauth", access: "dummy" }), null, null, null, 1, 1);
      insert.run("unrelated", "other", "fixture", JSON.stringify({ type: "oauth", access: "other" }), null, null, null, 1, 1);
    } finally { source.close(); }
    await seedIsolatedV2Credential(sourcePath, targetPath, directory);
    const target = new DatabaseSync(targetPath, { readOnly: true });
    try { assert.deepEqual(target.prepare("SELECT id FROM credential").all().map(row => row.id), ["openai-route"]); }
    finally { target.close(); }
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(targetPath)).mode & 0o777, 0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("V2 usage reader charges owned sessions including Luna Fast and retains missing usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-v2-usage-"));
  const path = join(root, "opencode.db"), workspace = join(root, "workspace");
  try {
    assert.throws(() => readDirectoryUsage(workspace, path), /usage-database-unavailable/);
    const db = new DatabaseSync(path);
    try {
      db.exec("CREATE TABLE session_v2 (id TEXT, directory TEXT); CREATE TABLE session_message (session_id TEXT, type TEXT, data TEXT)");
      db.prepare("INSERT INTO session_v2 VALUES (?, ?)").run("root", workspace);
      db.prepare("INSERT INTO session_v2 VALUES (?, ?)").run("child", workspace);
      db.prepare("INSERT INTO session_v2 VALUES (?, ?)").run("other", join(root, "other"));
      const write = db.prepare("INSERT INTO session_message VALUES (?, ?, ?)");
      const message = { model: { providerID: "openai", id: "gpt-6-luna-fast" },
        tokens: { input: 1000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } }, time: { completed: 1 } };
      write.run("root", "assistant", JSON.stringify(message));
      write.run("child", "assistant", JSON.stringify(message));
      write.run("other", "assistant", JSON.stringify(message));
      assert.deepEqual(readDirectoryUsage(workspace, path), { usd: 0.0014, requests: 2, unpriced: [] });
      write.run("child", "assistant", JSON.stringify({ time: { completed: 2 }, error: { message: "after transport" } }));
      assert.deepEqual(readDirectoryUsage(workspace, path), { usd: 0.0014, requests: 2, unpriced: ["missing-usage"] });
      db.prepare("DELETE FROM session_message WHERE session_id = ? AND data LIKE ?").run("child", '%after transport%');
      write.run("child", "assistant", JSON.stringify({ time: { created: 3 }, model: { providerID: "openai", id: "gpt-6-sol" } }));
      assert.deepEqual(readDirectoryUsage(workspace, path), { usd: 0.0014, requests: 2, unpriced: ["pending-usage"] });
    } finally { db.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a pending V2 assistant does not abort an in-flight priced request", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-v2-pending-"));
  try {
    await mkdir(join(root, "bin"));
    const executable = join(root, "bin", "opencode");
    await writeFile(executable, "#!/bin/sh\nsleep 2\nexit 0\n");
    await chmod(executable, 0o755);
    await writeFile(join(root, ".bashrc"), `export PATH=${join(root, "bin")}:$PATH\n`);
    let calls = 0;
    const result = await runOpenCode({ workspace: root, instanceId: "pending", agent: "dog-operator", prompt: "probe",
      environment: { HOME: root, PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}` }, timeoutSeconds: 8,
      costLimitUsd: 1, watchdogSeconds: 5, startedAt: Date.now() }, {
      ...fakeReadyServer,
      readUsage: () => ++calls < 3 ? { usd: 0, requests: 0, unpriced: ["pending-usage"] }
        : { usd: 0.1, requests: 1, unpriced: [] },
    });
    assert.equal(result.reason, "completed");
    assert.match(result.command, /opencode run --server /u);
    assert.doesNotMatch(result.command, /--standalone/u);
    assert.equal(result.usageComplete, true);
    assert.ok(calls >= 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function fakeOpenCode(script: string) {
  const root = await mkdtemp(join(tmpdir(), "swebench-v2-fake-"));
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "bin", "opencode"), `#!/bin/sh\n${script}\n`);
  await chmod(join(root, "bin", "opencode"), 0o755);
  await writeFile(join(root, ".bashrc"), `export PATH=${join(root, "bin")}:$PATH\n`);
  const options = (extra: Record<string, unknown>) => ({ workspace: root, instanceId: "fake", agent: "dog-operator", prompt: "probe",
    environment: { HOME: root, PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}` }, costLimitUsd: 1, watchdogSeconds: 30,
    startedAt: Date.now(), ...extra });
  return { root, options };
}

test("a transient terminal usage gap does not kill the run, but a persistent one does", { skip: process.platform === "win32" }, async () => {
  const { root, options } = await fakeOpenCode("sleep 3\nexit 0");
  try {
    let calls = 0;
    const transient = await runOpenCode(options({ timeoutSeconds: 8, unpricedGraceSeconds: 5 }), {
      ...fakeReadyServer,
      readUsage: () => ++calls === 1 ? { usd: 0.1, requests: 1, unpriced: ["missing-usage"] } : { usd: 0.1, requests: 2, unpriced: [] },
    });
    assert.equal(transient.reason, "completed");
    const persistent = await runOpenCode(options({ timeoutSeconds: 8, unpricedGraceSeconds: 1 }), {
      ...fakeReadyServer,
      readUsage: () => ({ usd: 0.1, requests: 1, unpriced: ["missing-usage"] }),
    });
    assert.equal(persistent.reason, "pricing-coverage-missing");
    assert.equal(persistent.usageComplete, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a timeout keeps its cause when usage is incomplete, and a failed exit is not completed", { skip: process.platform === "win32" }, async () => {
  const slow = await fakeOpenCode("sleep 30");
  const failed = await fakeOpenCode("exit 1");
  try {
    const timeout = await runOpenCode(slow.options({ timeoutSeconds: 1 }), {
      ...fakeReadyServer,
      readUsage: () => ({ usd: 0.1, requests: 1, unpriced: ["pending-usage"] }),
    });
    assert.equal(timeout.reason, "timeout");
    assert.equal(timeout.usageComplete, false);
    const agentFailure = await runOpenCode(failed.options({ timeoutSeconds: 8 }), {
      ...fakeReadyServer,
      readUsage: () => ({ usd: 0.1, requests: 1, unpriced: [] }),
    });
    assert.equal(agentFailure.reason, "agent-failed");
    assert.notEqual(agentFailure.exit, 0);
  } finally {
    await rm(slow.root, { recursive: true, force: true });
    await rm(failed.root, { recursive: true, force: true });
  }
});

test("the retained usage database carries sessions but no credential", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-retain-"));
  const source = join(root, "source.db"), target = join(root, "usage", "opencode.db");
  try {
    const db = new DatabaseSync(source);
    try {
      db.exec("CREATE TABLE credential (id TEXT, value TEXT); CREATE TABLE session_v2 (id TEXT, directory TEXT)");
      db.prepare("INSERT INTO credential VALUES (?, ?)").run("openai", "secret-token-value");
      db.prepare("INSERT INTO session_v2 VALUES (?, ?)").run("root", "/workspace");
    } finally { db.close(); }
    await retainUsageDatabase(source, target);
    const copy = new DatabaseSync(target, { readOnly: true });
    try {
      assert.deepEqual(copy.prepare("SELECT id FROM session_v2").all().map(row => row.id), ["root"]);
      assert.equal(copy.prepare("SELECT count(*) AS n FROM credential").get()!.n, 0);
    } finally { copy.close(); }
    assert.equal((await readFile(target)).includes("secret-token-value"), false);
    assert.equal((await stat(target)).mode & 0o777, 0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a benchmark coordinator override is applied and verified exactly", () => {
  const config = benchmarkInlineConfig("/plugin", ["dogs-coordinator", "dog-worker-v010"], "/run",
    { "dogs-coordinator": "openai/gpt-6-luna-fast#max" });
  assert.equal(config.agents["dogs-coordinator"].model, "openai/gpt-6-luna-fast#max");
  assert.equal("model" in config.agents["dog-worker-v010"], false);
  const permissions = benchmarkPermissionPolicy("/run").map(rule => ({ ...rule }));
  const luna = { id: "dogs-coordinator", permissions, model: { providerID: "openai", id: "gpt-6-luna-fast", variant: "max" } };
  verifyCandidateAgent("dogs-coordinator", luna, "openai/gpt-6-luna-fast#max");
  assert.throws(() => verifyCandidateAgent("dogs-coordinator", luna), /candidate-agent-model-mismatch/);
});

test("a successful CLI exit without durable usage remains unverified", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-unverified-"));
  const bin = join(root, "bin");
  try {
    await mkdir(bin, { recursive: true });
    const executable = join(bin, "opencode");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);
    await writeFile(join(root, ".bashrc"), `export PATH=${bin}:$PATH\n`);
    const result = await runOpenCode({ workspace: root, instanceId: "no-usage", agent: "dog-operator", prompt: "probe",
      environment: { HOME: root, PATH: `${bin}:${process.env.PATH ?? ""}` }, timeoutSeconds: 5,
      watchdogSeconds: 5, startedAt: Date.now() }, { ...fakeReadyServer,
        readUsage: () => ({ usd: 0, requests: 0, unpriced: [] }) });
    assert.equal(result.reason, "usage-unverified");
    assert.equal(result.usageComplete, false);
    assert.equal(result.exit, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const candidate = {
  package_tgz: "sortie-dogs-0.10.6.tgz",
  sha256: "a".repeat(64),
  version: "0.10.6",
  runtime_marker: "0.10.0-v0912-language4-cost-rpt10-compaction-ref2-proposal1-review-remediation1-surface4-proposal-recovery2-quality1-terminal2-route1-path1-permission2-prerequisite1-v2-bridge1-intent1-reflection1-cancel1",
  profile: "v010",
  agent: "dog-operator",
};

const manifest = (instances = [instance("example__project-2"), instance("example__project-1")]) => ({
  schema_version: 1,
  dataset: {
    id: "princeton-nlp/SWE-bench_Lite",
    revision: "6ec7bb89b9342f664a54a6e0a6ea6501d3437cc2",
    split: "dev",
  },
  candidate,
  instances,
});

const dev23Manifest = () => manifest(Array.from({ length: 23 }, (_, index) =>
  instance(`example__project-${String(index + 1).padStart(2, "0")}`, { problem_statement: `Issue ${index + 1}.` })));

const canonicalize = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonicalize)
  : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]))
    : value;

const testPublicRowHashes = (value: ReturnType<typeof manifest>) => Object.fromEntries(value.instances.map(item => {
  const publicRow = Object.fromEntries([
    "instance_id", "repo", "base_commit", "problem_statement", "version", "environment_setup_commit",
  ].filter(field => item[field as keyof typeof item] !== undefined)
    .map(field => [field, item[field as keyof typeof item]]));
  return [item.instance_id, createHash("sha256").update(JSON.stringify(canonicalize(publicRow))).digest("hex")];
}));

const createTestInferenceManifest = (value: ReturnType<typeof manifest>) =>
  createInferenceManifest(value, testPublicRowHashes(value));
const createTestDryRunPlan = (value: ReturnType<typeof manifest>) =>
  createDryRunPlan(value, testPublicRowHashes(value));
const createTestLiveRunPlan = (value: ReturnType<typeof manifest>, options: Record<string, unknown>) =>
  createLiveRunPlan(value, options, testPublicRowHashes(value));
const runTestLive = (value: ReturnType<typeof manifest>, options: Record<string, unknown>, dependencies: Record<string, unknown>) =>
  runLive(value, options, { ...dependencies, publicRowHashes: testPublicRowHashes(value) });
const execFileAsync = promisify(execFile);

test("release manifest selects receipt bytes over a same-version development candidate and records runner identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-release-manifest-"));
  try {
    const release = join(root, "release"), output = join(root, "campaign.json"), base = manifest();
    await mkdir(release);
    const archive = `sortie-dogs-${base.candidate.version}.tgz`;
    await writeFile(join(root, archive), "earlier development candidate");
    await writeFile(join(release, archive), "fixed release bytes");
    await writeFile(join(root, "base.json"), JSON.stringify(base));
    const hash = createHash("sha256").update("fixed release bytes").digest("hex");
    const receipt = { version: base.candidate.version, release_commit: "a".repeat(40), package_sha256: hash,
      candidate_preflight: { candidate: { ...base.candidate, package_sha256: hash } } };
    const receiptPath = join(release, "release-receipt.json");
    await writeFile(receiptPath, JSON.stringify(receipt));
    const dependencies = { publicRowHashes: testPublicRowHashes(base) };
    const provenance = await releaseManifest(join(root, "base.json"), receiptPath, output, dependencies);
    const result = JSON.parse(await readFile(output, "utf8"));
    assert.equal(result.candidate.sha256, hash);
    assert.equal(result.candidate.package_tgz, `release/${archive}`);
    assert.deepEqual(result.instances, base.instances);
    assert.equal(provenance.release_commit, receipt.release_commit);
    assert.match(provenance.runner_commit, /^[a-f0-9]{40}$/);
    assert.equal(provenance.runner_sha256["scripts/swebench-lite-runner.mjs"],
      createHash("sha256").update(await readFile("scripts/swebench-lite-runner.mjs")).digest("hex"));
    assert.equal(JSON.parse(await readFile(`${output}.provenance.json`, "utf8")).manifest_sha256,
      createHash("sha256").update(await readFile(output)).digest("hex"));
    await assert.rejects(releaseManifest(join(root, "base.json"), receiptPath, output, dependencies), /EEXIST/);
    await writeFile(join(release, archive), "earlier development candidate");
    await assert.rejects(releaseManifest(join(root, "base.json"), receiptPath, join(root, "wrong.json"), dependencies),
      /release-archive-sha256-mismatch/);
    await assert.rejects(readFile(join(root, "wrong.json")), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("dry-run manifest keeps only public issue inputs in stable order", () => {
  const result = createTestInferenceManifest(manifest());
  assert.deepEqual(result.instances.map(item => item.instance_id), ["example__project-1", "example__project-2"]);
  assert.deepEqual(Object.keys(result.instances[0]!), [
    "instance_id", "repo", "base_commit", "problem_statement", "version", "environment_setup_commit",
  ]);
  assert.deepEqual(result.policy, {
    attempts_per_instance: 1,
    retry_count: 0,
    scoring: "official-swebench-harness",
    live_process_started: false,
  });
});

test("manifest is pinned to the fixed SWE-bench Lite dataset", () => {
  for (const field of ["id", "revision"]) {
    const value = manifest();
    value.dataset = { ...value.dataset, [field]: "different" };
    assert.throws(() => createTestInferenceManifest(value), new RegExp(`invalid-lite-dataset-${field}`));
  }
  const testManifest = manifest();
  testManifest.dataset = { ...testManifest.dataset, split: "test" };
  assert.equal(createTestInferenceManifest(testManifest).dataset.split, "test");
  const invalidSplit = manifest();
  invalidSplit.dataset = { ...invalidSplit.dataset, split: "train" };
  assert.throws(() => createTestInferenceManifest(invalidSplit), /invalid-lite-dataset-split/);
});

test("hidden solution, test, hint, and oracle fields are rejected", () => {
  for (const field of ["patch", "test_patch", "hints_text", "FAIL_TO_PASS", "PASS_TO_PASS"]) {
    assert.throws(() => createTestInferenceManifest(manifest([instance("example__project-1", { [field]: "hidden" })])),
      new RegExp(`hidden-instance-field:${field}`));
  }
});

test("unknown instance metadata is rejected instead of entering the agent contract", () => {
  assert.throws(() => createTestInferenceManifest(manifest([instance("example__project-1", { created_by: "fixture" })])),
    /invalid-public-instance-fields/);
  const withCreatedAt = createTestInferenceManifest(manifest([instance("example__project-1", { created_at: "2026-09-19T00:00:00Z" })]));
  assert.equal(withCreatedAt.instances[0]!.created_at, "2026-09-19T00:00:00Z");
});

test("manifest rejects duplicate instances and missing required fields", () => {
  assert.throws(() => createTestInferenceManifest(manifest([
    instance("example__project-1"), instance("example__project-1"),
  ])), /duplicate-instance-id/);
  assert.throws(() => createTestInferenceManifest(manifest([instance("missing", { problem_statement: undefined })])),
    /invalid-instance-field:problem_statement/);
  assert.throws(() => createTestInferenceManifest(manifest([instance("example__project-1", { base_commit: "main" })])),
    /invalid-instance-base-commit/);
  assert.throws(() => createTestInferenceManifest(manifest([instance("other__project-1")])),
    /instance-id-repo-mismatch/);
});

test("manifest binds every public instance row to the pinned dataset lock", () => {
  assert.throws(() => createInferenceManifest(manifest()), /instance-not-in-lite-dataset/);
  const trusted = manifest([instance("example__project-1")]);
  const altered = manifest([instance("example__project-1", { problem_statement: "Different issue." })]);
  assert.throws(() => createInferenceManifest(altered, testPublicRowHashes(trusted)), /instance-public-data-mismatch/);
});

test("prediction format is exactly the official JSONL shape", () => {
  assert.equal(formatPrediction({ instance_id: "x", model_name_or_path: "sortie-dogs", model_patch: "" }),
    '{"instance_id":"x","model_name_or_path":"sortie-dogs","model_patch":""}');
  assert.throws(() => formatPrediction({ instance_id: "x", model_name_or_path: "sortie-dogs", model_patch: "", status: "failed" }),
    /invalid-prediction/);
});

test("dry-run records the host/scoring boundary without starting a process or provider request", () => {
  const result = createTestDryRunPlan(manifest());
  assert.equal(result.mode, "host-inference-for-official-docker-scoring");
  assert.deepEqual(result.execution, {
    inference: "host-wsl-opencode",
    scoring: "external-official-docker-harness-after-patch-freeze",
    live_process_started: false,
    provider_requests_started: false,
  });
});

test("fixed Lite dev23 adapter contract is public-only pass@1 with no retries", () => {
  const result = createTestDryRunPlan(dev23Manifest());
  assert.deepEqual(result.candidate, candidate);
  assert.deepEqual(result.dataset, {
    id: "princeton-nlp/SWE-bench_Lite",
    revision: "6ec7bb89b9342f664a54a6e0a6ea6501d3437cc2",
    split: "dev",
  });
  assert.equal(result.instances.length, 23);
  assert.deepEqual(result.instances.map(item => item.instance_id),
    Array.from({ length: 23 }, (_, index) => `example__project-${String(index + 1).padStart(2, "0")}`));
  assert.deepEqual(result.policy, {
    attempts_per_instance: 1,
    retry_count: 0,
    scoring: "official-swebench-harness",
    live_process_started: false,
  });
  assert.equal(result.execution.inference, "host-wsl-opencode");
  assert.equal(result.execution.scoring, "external-official-docker-harness-after-patch-freeze");
  assert.equal(result.execution.live_process_started, false);
  assert.equal(result.execution.provider_requests_started, false);
  for (const item of result.instances) {
    for (const field of ["patch", "test_patch", "hints_text", "FAIL_TO_PASS", "PASS_TO_PASS"]) {
      assert.equal(Object.hasOwn(item, field), false);
    }
  }
});

test("dry-run verifies the candidate package without creating a live execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-dry-run-"));
  try {
    const packageBytes = Buffer.from("candidate package\n");
    const candidatePackage = join(root, candidate.package_tgz);
    const manifestPath = join(root, "manifest.json");
    const outputPath = join(root, "dry-run.json");
    await writeFile(candidatePackage, packageBytes);
    const value = {
      ...manifest(),
      candidate: {
        ...candidate,
        sha256: createHash("sha256").update(packageBytes).digest("hex"),
      },
    };
    await writeFile(manifestPath, `${JSON.stringify(value)}\n`);
    const result = await runDryRun(manifestPath, outputPath, { publicRowHashes: testPublicRowHashes(value) });
    assert.equal(result.execution.candidate_package_verified, true);
    assert.equal(result.execution.live_process_started, false);
    assert.equal(result.execution.provider_requests_started, false);
    assert.equal(result.policy.attempts_per_instance, 1);
    assert.equal(result.policy.retry_count, 0);
    assert.equal(result.instances.length, 2);
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), result);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate preflight owns and removes only its fresh isolated runtime root", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-preflight-"));
  const manifestPath = join(root, "manifest.json"), runRoot = join(root, "runtime");
  try {
    await writeFile(manifestPath, "{}\n");
    const result = await runCandidatePreflight(manifestPath, runRoot, {
      createPlan: () => ({ candidate: { package_tgz: "candidate.tgz" } }),
      prepareCandidate: async (_candidate: unknown, packagePath: string, preparedRoot: string) => {
        assert.equal(packagePath, join(root, "candidate.tgz"));
        assert.equal(preparedRoot, runRoot);
        assert.equal((await stat(preparedRoot)).isDirectory(), true);
        return { evidence: { package_sha256: "a".repeat(64) } };
      },
    });
    assert.deepEqual(result, { candidate: { package_sha256: "a".repeat(64) }, config_verified: true,
      provider_requests_started: false });
    await assert.rejects(stat(runRoot), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
    await mkdir(runRoot);
    await assert.rejects(runCandidatePreflight(manifestPath, runRoot, {
      createPlan: () => ({ candidate: { package_tgz: "candidate.tgz" } }),
    }), /candidate-preflight-run-root-already-exists/);
    assert.equal((await stat(runRoot)).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("live plan keeps instance sessions independent and prompt input public", () => {
  const result = createTestLiveRunPlan(manifest(), {
    agent: "dog-operator",
    modelNameOrPath: "sortie-dogs",
    timeoutSeconds: 1800,
    watchdogSeconds: 120,
    costLimitUsd: 50,
  });
  assert.deepEqual(result.instances.map(item => item.instance_id), ["example__project-1", "example__project-2"]);
  assert.equal(result.execution.agent, "dog-operator");
  assert.equal(result.execution.timeout_seconds, 1800);
  assert.equal(result.execution.watchdog_interval_seconds, 120);
  assert.equal(result.execution.cost_limit_usd, 50);
  assert.match(result.instances[0]!.prompt, /Public issue statement:/);
  assert.match(result.instances[0]!.prompt, /host disables Python bytecode writes and redirects pytest's cache into the isolated runtime/u);
  assert.match(result.instances[0]!.prompt,
    /when supplying a repository path yourself, use a relative path and never guess or reconstruct the repository's absolute path/u);
  assert.match(result.instances[0]!.prompt,
    /omit the path argument from glob and grep, and read the repository root as '\.'; keep later repository path inputs relative and never copy absolute workspace paths returned by tools/u);
  assert.match(result.instances[0]!.prompt,
    /For shell commands, omit the workdir argument and use the current repository directory; never construct or copy an absolute workdir/u);
  assert.match(result.instances[0]!.prompt,
    /Keep repository paths in glob, grep, read, and shell inputs relative even after coordinator or worker handoffs; only the host may use absolute workspace paths/u);
  assert.match(result.instances[0]!.prompt,
    /The null device \/dev\/null is allowed for shell redirection and as the empty-file operand in a diff/u);
  assert.match(result.instances[0]!.prompt,
    /Preserve this distinction in delegated requirements and reviews/u);
  assert.match(result.instances[0]!.prompt,
    /This allowance does not authorize access to other paths outside the repository or benchmark solution metadata/u);
  assert.match(result.instances[0]!.prompt,
    /Before editing, reproduce the public issue with its smallest concrete example and locate the existing focused regression test or tests that express the expected behavior/u);
  assert.match(result.instances[0]!.prompt,
    /Time-box dependency setup to a brief, repository-documented attempt; do not repeatedly create environments or install unrelated packages/u);
  assert.match(result.instances[0]!.prompt,
    /If a dependency remains unavailable, inspect the source and implement the smallest plausible fix, then run every focused check that the available environment permits/u);
  assert.match(result.instances[0]!.prompt,
    /Do not invent an expected output from the issue alone; inspect existing public code, nearby visitor methods, node string or name conventions, and public tests before choosing a regression assertion/u);
  assert.match(result.instances[0]!.prompt,
    /When public tests do not state the expected representation, derive it from the repository's established analogous representation and keep the assertion aligned with that convention/u);
  assert.match(result.instances[0]!.prompt,
    /After editing, rerun that exact reproduction plus the focused regression test and at least one adjacent relevant test; do not finalize a patch that only passes syntax checks or a self-invented test while the issue's focused test still fails/u);
  assert.match(result.instances[0]!.prompt,
    /Read the complete focused test failure and adjust the implementation until the public scenario and focused regression pass; keep the final diff limited to the fix and necessary regression coverage/u);
  assert.match(result.instances[0]!.prompt, /leave the fix as an uncommitted working-tree diff/u);
  assert.match(result.instances[0]!.prompt, /Do not commit, push, access Git remotes or history beyond the checked-out base commit/u);
  assert.match(result.instances[0]!.prompt, /Do not use issue or pull-request pages, mirrors, hints, gold patches, test patches, or hidden evaluation tests/u);
  assert.match(result.instances[0]!.prompt, /example\/project/);
  assert.equal(Object.hasOwn(result.instances[0]!, "patch"), false);
});

test("benchmark prompt preserves public-only safety boundaries individually", () => {
  const result = createTestLiveRunPlan(manifest(), {
    agent: "dog-operator",
    modelNameOrPath: "sortie-dogs",
    timeoutSeconds: 1800,
    watchdogSeconds: 120,
    costLimitUsd: 50,
  });
  const prompt = result.instances[0]!.prompt;
  assert.match(prompt, /browse the web/u);
  assert.match(prompt, /Git remotes/u);
  assert.match(prompt, /history beyond the checked-out base commit/u);
  assert.match(prompt, /public SWE-bench issue/u);
  assert.match(prompt, /uncommitted working-tree diff/u);
});

test("live argument parsing requires an explicit mode and bounded execution options", () => {
  assert.deepEqual(parseArguments(["--live", "--manifest", "manifest.json", "--run-root", "run", "--output", "predictions.jsonl", "--cost-limit-usd", "50"]), {
    live: true,
    dryRun: false,
    manifest: "manifest.json",
    runRoot: "run",
    output: "predictions.jsonl",
    costLimitUsd: 50,
    timeoutSeconds: 1800,
    watchdogSeconds: 120,
  });
  assert.throws(() => parseArguments(["--manifest", "manifest.json"]), /exactly-one-run-mode/);
  assert.throws(() => parseArguments(["--live", "--manifest", "manifest.json", "--run-root", "run", "--output", "predictions.jsonl"]),
    /live-cost-limit-usd-required/);
  assert.throws(() => parseArguments(["--live", "--manifest", "manifest.json", "--run-root", "run", "--output", "predictions.jsonl", "--timeout-seconds", "0"]), /invalid-timeout/);
});

test("benchmark child environment omits host credentials and retains only execution context", () => {
  assert.deepEqual(benchmarkEnvironment({ PATH: "/bin", HOME: "/home/test", LANG: "C.UTF-8",
    GITHUB_TOKEN: "secret", OPENAI_API_KEY: "secret", NPM_TOKEN: "secret", CUSTOM: "value",
    WSLENV: "host/value", WSL_INTEROP: "/run/WSL/interop" }), {
    LANG: "C.UTF-8", PATH: "/bin",
  });
});

test("benchmark Python cache policy keeps cold imports out of protected source and quotes pytest cache paths", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-python-cache-"));
  try {
    const workspace = join(root, "repository");
    const cache = join(root, "runtime cache's files");
    await mkdir(workspace);
    await writeFile(join(workspace, "subject.py"), "VALUE = 42\n");
    const execute = promisify(execFile);
    const clean = benchmarkEnvironment(process.env);
    const args = ["-c", "import subject; assert subject.VALUE == 42"];
    await execute("python3", args, { cwd: workspace, env: clean });
    assert.ok((await readdir(workspace)).includes("__pycache__"), "cold imports reproduce the incidental source mutation");
    await rm(join(workspace, "__pycache__"), { recursive: true });
    const before = await readdir(workspace, { recursive: true });
    const environment = { ...clean, ...benchmarkPythonCacheEnvironment(cache) };
    await execute("python3", args, { cwd: workspace, env: environment });
    assert.deepEqual(await readdir(workspace, { recursive: true }), before);
    assert.equal(await readFile(join(workspace, "subject.py"), "utf8"), "VALUE = 42\n");
    const parsed = await execute("python3", ["-c", "import json,os,shlex; print(json.dumps(shlex.split(os.environ['PYTEST_ADDOPTS'])))"],
      { cwd: workspace, env: environment, encoding: "utf8" });
    assert.deepEqual(JSON.parse(parsed.stdout), ["-o", `cache_dir=${join(cache, "pytest")}`]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("benchmark permissions deny browsing and remote shell access while retaining local commands", () => {
  const policy = benchmarkPermissionPolicy();
  const has = (rules: typeof policy, action: string, resource: string, effect: string) =>
    rules.some(rule => rule.action === action && rule.resource === resource && rule.effect === effect);
  assert.ok(has(policy, "webfetch", "*", "deny"));
  assert.ok(has(policy, "websearch", "*", "deny"));
  assert.ok(has(policy, "shell", "*", "allow"));
  assert.equal(policy.some(rule => rule.action === "external_directory"), false);
  assert.ok(has(benchmarkPermissionPolicy("/tmp/opencode/swebench-run"), "external_directory",
    "/tmp/opencode/swebench-run/*", "allow"));
  for (const pattern of ["*curl *", "*wget *", "*gh *", "*git fetch *", "*git push *", "*https://*"]) {
    assert.ok(has(policy, "shell", pattern, "deny"));
  }
  const inline = benchmarkInlineConfig("file:///candidate/plugin.js", ["dog-operator", "dog-worker"]);
  assert.deepEqual(inline.plugins, ["file:///candidate/plugin.js"]);
  assert.ok(has(inline.permissions, "shell", "*https://*", "deny"));
  assert.ok(has(inline.agents["dog-operator"]!.permissions, "webfetch", "*", "deny"));
  assert.ok(has(inline.agents["dog-worker"]!.permissions, "websearch", "*", "deny"));
  const scopedInline = benchmarkInlineConfig("file:///candidate/plugin.js", ["dog-operator"], "/tmp/opencode/swebench-run");
  assert.ok(has(scopedInline.permissions, "external_directory", "/tmp/opencode/swebench-run/*", "allow"));
  assert.ok(has(scopedInline.agents["dog-operator"]!.permissions,
    "external_directory", "/tmp/opencode/swebench-run/*", "allow"));
});

test("candidate agent verification rejects missing models and later allow rules", () => {
  const base = {
    id: "dog-worker-v010", model: { providerID: "openai", id: "gpt-6-luna-fast", variant: "max" },
    permissions: benchmarkPermissionPolicy(),
  };
  verifyCandidateAgent(base.id, base);
  assert.throws(() => verifyCandidateAgent(base.id, { ...base, model: undefined }), /candidate-agent-model-mismatch/);
  assert.throws(() => verifyCandidateAgent(base.id, { ...base, permissions: [
    ...base.permissions, { action: "shell", resource: "*", effect: "allow" },
  ] }), /candidate-agent-network-permission-invalid/);
});

test("base checkout fetches one commit directly and retains no remote", async () => {
  const calls: string[][] = [];
  await cloneInstance(instance("example__project-1"), "/tmp/example-project", async (args: string[]) => {
    calls.push(args);
    if (args.includes("rev-list")) return { exit: 0, stdout: "1\n", stderr: "" };
    if (args.at(-1) === "remote") return { exit: 0, stdout: "", stderr: "" };
    return { exit: 0, stdout: "", stderr: "" };
  });
  assert.deepEqual(calls[0], ["init", "--quiet", "/tmp/example-project"]);
  assert.deepEqual(calls[1], ["-C", "/tmp/example-project", "fetch", "--quiet", "--depth=1", "--no-tags",
    "https://github.com/example/project.git", instance("example__project-1").base_commit]);
  assert.ok(calls.some(args => args.includes("rev-list")));
  assert.ok(calls.some(args => args.at(-1) === "remote"));
  assert.ok(calls.every(args => !args.includes("clone")));
});

test("base checkout fails closed when history or remotes exceed the boundary", async () => {
  await assert.rejects(cloneInstance(instance("example__project-1"), "/tmp/example-project", async (args: string[]) => {
    if (args.includes("rev-list")) return { exit: 0, stdout: "2\n", stderr: "" };
    return { exit: 0, stdout: "", stderr: "" };
  }), /checkout-history-not-shallow/);
  await assert.rejects(cloneInstance(instance("example__project-1"), "/tmp/example-project", async (args: string[]) => {
    if (args.includes("rev-list")) return { exit: 0, stdout: "1\n", stderr: "" };
    if (args.at(-1) === "remote") return { exit: 0, stdout: "origin\n", stderr: "" };
    return { exit: 0, stdout: "", stderr: "" };
  }), /checkout-remote-present/);
});

test("base checkout rejects target-controlled OpenCode configuration", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swebench-checkout-config-"));
  try {
    await writeFile(join(workspace, "opencode.json"), "{}\n");
    await assert.rejects(cloneInstance(instance("example__project-1"), workspace, async (args: string[]) => {
      if (args.includes("rev-list")) return { exit: 0, stdout: "1\n", stderr: "" };
      return { exit: 0, stdout: "", stderr: "" };
    }), /checkout-opencode-config-present/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("captured patches exclude runtime artifacts and retain product changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-patch-filter-"));
  try {
    await execFileAsync("git", ["init", "--quiet"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "test"], { cwd: root });
    await writeFile(join(root, "product.txt"), "base\n");
    await execFileAsync("git", ["add", "product.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "--quiet", "-m", "base"], { cwd: root });
    await writeFile(join(root, "product.txt"), "fixed\n");
    await mkdir(join(root, ".sortie-dogs-v010", "contracts"), { recursive: true });
    await writeFile(join(root, ".sortie-dogs-v010", "contracts", "state.json"), "internal\n");
    await mkdir(join(root, ".sortie-env", "bin"), { recursive: true });
    await writeFile(join(root, ".sortie-env", "bin", "python"), "tool environment\n");

    const patch = await capturePatch(root);

    assert.match(patch, /diff --git a\/product\.txt b\/product\.txt/u);
    assert.match(patch, /-base\n\+fixed/u);
    assert.doesNotMatch(patch, /\.sortie-dogs-v010/u);
    assert.doesNotMatch(patch, /\.sortie-env/u);
    // A prepared environment is also git-ignored; a literal exclude pathspec would make `git add` fail.
    await writeFile(join(root, ".git", "info", "exclude"), "/.sortie-env/\n");
    assert.equal(await capturePatch(root), patch);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an official prepared environment is relocated, activated first on PATH, announced and recorded", async () => {
  assert.equal(officialEvaluationImage("pvlib__pvlib-python-1154"), "swebench/sweb.eval.x86_64.pvlib_1776_pvlib-python-1154:latest");
  assert.throws(() => officialEvaluationImage("../escape"), /invalid-instance-id/);
  const root = await mkdtemp(join(tmpdir(), "swebench-prepared-"));
  try {
    const workspace = join(root, "ws"), environment = join(workspace, ".sortie-env"), site = join(environment, "lib", "python3.9", "site-packages");
    await mkdir(join(site, "pkg-1.0.dist-info"), { recursive: true });
    await mkdir(join(environment, "bin"), { recursive: true });
    await writeFile(join(site, "easy-install.pth"), "/testbed\n");
    await writeFile(join(site, "pkg.egg-link"), "/testbed\n.");
    await writeFile(join(site, "__editable___pkg_finder.py"), "MAPPING = {'pkg': '/testbed/src/pkg'}\n");
    await writeFile(join(site, "pkg-1.0.dist-info", "direct_url.json"), '{"url": "file:///testbed"}');
    await writeFile(join(site, "other.pth"), "/testbedlike\n");
    await writeFile(join(site, "binary.pth"), Buffer.from([0, 47, 116, 101, 115, 116, 98, 101, 100]));
    await writeFile(join(environment, "bin", "pytest"), "#!/opt/miniconda3/envs/testbed/bin/python\nimport pytest\n");
    const rewritten = await relocateOfficialEnvironment(environment, workspace);
    assert.equal(await readFile(join(site, "easy-install.pth"), "utf8"), `${workspace}\n`);
    assert.equal(await readFile(join(site, "__editable___pkg_finder.py"), "utf8"), `MAPPING = {'pkg': '${workspace}/src/pkg'}\n`);
    assert.equal(await readFile(join(site, "pkg-1.0.dist-info", "direct_url.json"), "utf8"), `{"url": "file://${workspace}"}`);
    assert.equal(await readFile(join(site, "other.pth"), "utf8"), "/testbedlike\n");
    assert.equal((await readFile(join(environment, "bin", "pytest"), "utf8")).split("\n")[0], `#!${environment}/bin/python`);
    assert.equal(rewritten.length, 5);
    assert.match(createTestLiveRunPlan(manifest(), { costLimitUsd: 1, preparedEnvironment: "official-image-testbed" }).instances[0]!.prompt,
      /already active: \.sortie-env\/ is first on PATH/u);
    assert.doesNotMatch(createTestLiveRunPlan(manifest(), { costLimitUsd: 1 }).instances[0]!.prompt, /\.sortie-env/u);
    assert.throws(() => createTestLiveRunPlan(manifest(), { costLimitUsd: 1, preparedEnvironment: "host" }), /invalid-prepared-environment/);
    const seen: Array<{ path: string; prompt: string }> = [];
    const result = await runTestLive(manifest(), { costLimitUsd: 5, runRoot: join(root, "run"), output: join(root, "p.jsonl"),
      preparedEnvironment: "official-image-testbed" }, {
      prepareCandidate: async (candidateValue: typeof candidate, _packagePath: string, preparedRoot: string) => {
        const runtimeRoot = join(preparedRoot, "candidate-runtime");
        await mkdir(runtimeRoot, { recursive: true });
        return { environment: { HOME: "/isolated", PATH: "/usr/bin" }, runtimeRoot, evidence: { package_sha256: candidateValue.sha256,
          version: candidateValue.version, runtime_marker: candidateValue.runtime_marker, profile: candidateValue.profile, agent: candidateValue.agent } };
      },
      clone: async () => undefined,
      prepareEnvironment: async () => ({ kind: "official-image-testbed", image: "img", image_id: "sha256:x", python: "3.9.21", rewritten_files: 2 }),
      execute: async (options: { workspace: string; environment: Record<string, string>; prompt: string }) => {
        seen.push({ path: options.environment.PATH!, prompt: options.prompt });
        assert.equal(options.environment.VIRTUAL_ENV, join(options.workspace, ".sortie-env"));
        return { command: "c", exit: 0, signal: null, reason: "completed", stdout: "", stderr: "", watchdogEvents: 0,
          lastActivityAgeMs: 0, usage: { usd: 0, requests: 1, unpriced: [] }, usageComplete: true };
      },
      git: async (args: string[]) => ({ exit: 0, stdout: args.includes("diff") ? "diff --git a/f b/f\n" : "", stderr: "" }),
    });
    assert.ok(seen.every(item => /\/\.sortie-env\/bin:\/usr\/bin$/u.test(item.path) && item.prompt.includes("already active")));
    assert.equal(result.results[0]!.prepared_environment.image_id, "sha256:x");
    assert.equal(result.execution.prepared_environment, "official-image-testbed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("live run writes one prediction per instance and removes dedicated workspaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-live-"));
  const runRoot = join(root, "run");
  const output = join(root, "predictions.jsonl");
  const metadata = join(root, "metadata.json");
  const executions: string[] = [];
  const gitCommands: string[][] = [];
  const gitEnvironments: Array<Record<string, string>> = [];
  const isolatedEnvironment = { HOME: "/isolated/home", XDG_CONFIG_HOME: "/isolated/xdg",
    GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  const result = await runTestLive(manifest(), {
    agent: "dog-operator",
    modelNameOrPath: "sortie-dogs",
    timeoutSeconds: 1800,
    watchdogSeconds: 120,
    costLimitUsd: 50,
    runRoot,
    output,
    metadata,
  }, {
    prepareCandidate: async (candidateValue: typeof candidate, _packagePath: string, preparedRoot: string) => {
      const runtimeRoot = join(preparedRoot, "candidate-runtime");
      await mkdir(runtimeRoot, { recursive: true });
      await writeFile(join(runtimeRoot, "opencode.db"), "raw benchmark state\n");
      return { environment: isolatedEnvironment, runtimeRoot, databasePath: join(runtimeRoot, "opencode.db"),
      evidence: {
        package_sha256: candidateValue.sha256,
        version: candidateValue.version,
        runtime_marker: candidateValue.runtime_marker,
        profile: candidateValue.profile,
        agent: candidateValue.agent,
      },
    }; },
    clone: async (_instance: unknown, workspace: string) => { executions.push(workspace); },
    execute: async () => ({ command: "bash -ic opencode", exit: 0, signal: null, reason: "completed",
      stdout: "agent output\n", stderr: "", watchdogEvents: 2, lastActivityAgeMs: 0,
      usage: { usd: 0, requests: 1, unpriced: [] } }),
    git: async (args: string[], _cwd: string, environment: Record<string, string>) => {
      gitCommands.push(args);
      gitEnvironments.push(environment);
      return args.includes("diff")
        ? { exit: 0, stdout: "diff --git a/fix.txt b/fix.txt\n", stderr: "" }
        : { exit: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(result.results.filter(item => item.status === "succeeded").length, 2);
  assert.equal(executions.length, 2);
  assert.equal(gitEnvironments.length, 4);
  assert.ok(gitEnvironments.every(environment => environment === isolatedEnvironment));
  assert.ok(gitCommands.filter(args => args.includes("diff")).every(args => args.includes("HEAD")));
  assert.ok(gitCommands.filter(args => args.includes("add") || args.includes("diff"))
    .every(args => args.includes(":(exclude).sortie-dogs-v010")));
  assert.equal((await readFile(output, "utf8")).trim().split("\n").length, 2);
    const replayManifest = JSON.parse(await readFile(result.replay.manifest.path, "utf8"));
    assert.equal(replayManifest.schema_version, 1);
    assert.equal(replayManifest.mode, "host-inference-for-official-docker-scoring");
    assert.equal(replayManifest.official_scoring_boundary, "external-official-docker-harness-after-patch-freeze");
    assert.equal(replayManifest.candidate_sha256, candidate.sha256);
    assert.match(replayManifest.environment_sha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(replayManifest.policy, {
      attempts_per_instance: 1,
      retry_count: 0,
      scoring: "official-swebench-harness",
    });
    assert.equal(replayManifest.policy.retry_count, 0);
    assert.equal(replayManifest.artifacts.length, 2);
  const replayArtifact = JSON.parse(await readFile(join(runRoot, "replay", replayManifest.artifacts[0].path), "utf8"));
  assert.equal(replayArtifact.execution.command, "bash -ic opencode");
  assert.equal(replayArtifact.execution.stdout, "agent output\n");
  assert.equal(replayArtifact.execution.exit_code, 0);
  assert.equal(replayArtifact.official_scoring_boundary, "external-official-docker-harness-after-patch-freeze");
  assert.equal(replayArtifact.candidate_sha256, candidate.sha256);
  assert.match(replayArtifact.environment_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(replayArtifact.patch, "diff --git a/fix.txt b/fix.txt\n");
  assert.equal(Object.hasOwn(replayArtifact.public_input.instance, "patch"), false);
  await assert.rejects(stat(executions[0]!));
  await assert.rejects(stat(executions[1]!));
  await assert.rejects(stat(join(runRoot, "candidate-runtime")));
});

test("cost enforcement failures stop later instances with deterministic replay evidence", async t => {
  for (const reason of ["pricing-coverage-missing", "usage-monitor-failed"]) {
    await t.test(reason, async () => {
      const root = await mkdtemp(join(tmpdir(), "swebench-replay-usage-stop-"));
      const runRoot = join(root, "run");
      let executeCalls = 0;
      try {
        const result = await runTestLive(manifest(), {
          agent: "dog-operator",
          modelNameOrPath: "sortie-dogs",
          timeoutSeconds: 1800,
          watchdogSeconds: 120,
          costLimitUsd: 50,
          runRoot,
          output: join(root, "predictions.jsonl"),
        }, {
          prepareCandidate: async (candidateValue: typeof candidate, _packagePath: string, preparedRoot: string) => {
            const runtimeRoot = join(preparedRoot, "candidate-runtime");
            await mkdir(runtimeRoot, { recursive: true });
            return {
              environment: { HOME: "/isolated/home" },
              runtimeRoot,
              evidence: {
                package_sha256: candidateValue.sha256,
                version: candidateValue.version,
                runtime_marker: candidateValue.runtime_marker,
                profile: candidateValue.profile,
                agent: candidateValue.agent,
              },
            };
          },
          clone: async () => undefined,
          execute: async () => {
            executeCalls += 1;
            return {
              command: "host",
              exit: 1,
              signal: null,
              reason,
              stdout: "",
              stderr: "",
              usage: { usd: 0, requests: 0, unpriced: [] },
            };
          },
        });
        const notRunStatus = `not-run-${reason}`;
        assert.equal(executeCalls, 1);
        assert.deepEqual(result.results.map(item => item.status), [reason, notRunStatus]);
        const replayManifest = JSON.parse(await readFile(result.replay.manifest.path, "utf8"));
        assert.deepEqual(replayManifest.artifacts.map((item: { status: string }) => item.status), [reason, notRunStatus]);
        const failedArtifact = JSON.parse(await readFile(join(runRoot, "replay", replayManifest.artifacts[0].path), "utf8"));
        const skippedArtifact = JSON.parse(await readFile(join(runRoot, "replay", replayManifest.artifacts[1].path), "utf8"));
        assert.equal(failedArtifact.status, reason);
        assert.equal(failedArtifact.execution.reason, reason);
        assert.equal(skippedArtifact.status, notRunStatus);
        assert.equal(skippedArtifact.execution.reason, notRunStatus);
        assert.equal(skippedArtifact.execution.exit_code, null);
        assert.equal(skippedArtifact.patch, "");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("failed instance replay records public input, command output, patch state, and hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-replay-failure-"));
  const runRoot = join(root, "run");
  const output = join(root, "predictions.jsonl");
  try {
    const result = await runTestLive(manifest([instance("example__project-1")]), {
      agent: "dog-operator",
      modelNameOrPath: "sortie-dogs",
      timeoutSeconds: 1800,
      watchdogSeconds: 120,
      costLimitUsd: 50,
      runRoot,
      output,
    }, {
      prepareCandidate: async (candidateValue: typeof candidate, _packagePath: string, preparedRoot: string) => {
        const runtimeRoot = join(preparedRoot, "candidate-runtime");
        await mkdir(runtimeRoot, { recursive: true });
        return {
          environment: { HOME: "/isolated/home", GIT_TERMINAL_PROMPT: "0" },
          runtimeRoot,
          evidence: {
            package_sha256: candidateValue.sha256,
            version: candidateValue.version,
            runtime_marker: candidateValue.runtime_marker,
            profile: candidateValue.profile,
            agent: candidateValue.agent,
          },
        };
      },
      clone: async () => undefined,
      execute: async () => ({ command: "bash -ic opencode", exit: 17, signal: null, reason: "agent-failed",
        stdout: "partial stdout\n", stderr: "diagnostic stderr\n", usage: { usd: 0, requests: 0, unpriced: [] } }),
    });
    assert.equal(result.results[0]!.status, "agent-failed");
    const replayManifest = JSON.parse(await readFile(result.replay.manifest.path, "utf8"));
    const artifact = JSON.parse(await readFile(join(runRoot, "replay", replayManifest.artifacts[0].path), "utf8"));
    assert.deepEqual(artifact.public_input.instance, instance("example__project-1"));
    assert.equal(artifact.execution.command, "bash -ic opencode");
    assert.equal(artifact.execution.exit_code, 17);
    assert.equal(artifact.execution.stdout, "partial stdout\n");
    assert.equal(artifact.execution.stderr, "diagnostic stderr\n");
    assert.equal(artifact.patch, "");
    assert.equal(artifact.candidate_sha256, candidate.sha256);
    assert.match(artifact.environment_sha256, /^[a-f0-9]{64}$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replay artifact capacity overflow fails closed before predictions are written", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-replay-capacity-"));
  const runRoot = join(root, "run");
  const output = join(root, "predictions.jsonl");
  try {
    await assert.rejects(runTestLive(manifest([instance("example__project-1")]), {
      agent: "dog-operator",
      modelNameOrPath: "sortie-dogs",
      timeoutSeconds: 1800,
      watchdogSeconds: 120,
      costLimitUsd: 50,
      runRoot,
      output,
      replayArtifactMaxBytes: 128,
    }, {
      prepareCandidate: async (candidateValue: typeof candidate, _packagePath: string, preparedRoot: string) => {
        const runtimeRoot = join(preparedRoot, "candidate-runtime");
        await mkdir(runtimeRoot, { recursive: true });
        return {
          environment: { HOME: "/isolated/home" },
          runtimeRoot,
          evidence: {
            package_sha256: candidateValue.sha256,
            version: candidateValue.version,
            runtime_marker: candidateValue.runtime_marker,
            profile: candidateValue.profile,
            agent: candidateValue.agent,
          },
        };
      },
      clone: async () => undefined,
      execute: async () => ({ command: "host", exit: 1, reason: "failed", stdout: "", stderr: "",
        usage: { usd: 0, requests: 0, unpriced: [] } }),
    }), /replay-artifact-capacity-exceeded/);
    await assert.rejects(stat(output));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate environment hash mismatch fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-replay-hash-"));
  try {
    await assert.rejects(runTestLive(manifest([instance("example__project-1")]), {
      agent: "dog-operator",
      modelNameOrPath: "sortie-dogs",
      timeoutSeconds: 1800,
      watchdogSeconds: 120,
      costLimitUsd: 50,
      runRoot: join(root, "run"),
      output: join(root, "predictions.jsonl"),
    }, {
      prepareCandidate: async (candidateValue: typeof candidate, _packagePath: string, preparedRoot: string) => {
        const runtimeRoot = join(preparedRoot, "candidate-runtime");
        await mkdir(runtimeRoot, { recursive: true });
        return {
          environment: { HOME: "/isolated/home" },
          runtimeRoot,
          evidence: {
            package_sha256: candidateValue.sha256,
            environment_sha256: "b".repeat(64),
            version: candidateValue.version,
            runtime_marker: candidateValue.runtime_marker,
            profile: candidateValue.profile,
            agent: candidateValue.agent,
          },
        };
      },
    }), /replay-environment-hash-mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate hash binding fails closed before replay or prediction output", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-replay-candidate-hash-"));
  const runRoot = join(root, "run");
  const output = join(root, "predictions.jsonl");
  try {
    await assert.rejects(runTestLive(manifest([instance("example__project-1")]), {
      agent: "dog-operator",
      modelNameOrPath: "sortie-dogs",
      timeoutSeconds: 1800,
      watchdogSeconds: 120,
      costLimitUsd: 50,
      runRoot,
      output,
    }, {
      prepareCandidate: async (candidateValue: typeof candidate, _packagePath: string, preparedRoot: string) => {
        const runtimeRoot = join(preparedRoot, "candidate-runtime");
        await mkdir(runtimeRoot, { recursive: true });
        return {
          environment: { HOME: "/isolated/home" },
          runtimeRoot,
          evidence: {
            package_sha256: candidateValue.sha256,
            candidate_sha256: "b".repeat(64),
            version: candidateValue.version,
            runtime_marker: candidateValue.runtime_marker,
            profile: candidateValue.profile,
            agent: candidateValue.agent,
          },
        };
      },
    }), /replay-candidate-hash-mismatch/);
    await assert.rejects(stat(output));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unconfirmed process cleanup fails closed before predictions are written", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-process-cleanup-"));
  const output = join(root, "predictions.jsonl");
  try {
    await assert.rejects(runTestLive(manifest([instance("example__project-1")]), {
      agent: "dog-operator",
      modelNameOrPath: "sortie-dogs",
      timeoutSeconds: 1800,
      watchdogSeconds: 120,
      costLimitUsd: 50,
      runRoot: join(root, "run"),
      output,
    }, {
      prepareCandidate: async (candidateValue: typeof candidate, _packagePath: string, preparedRoot: string) => {
        const runtimeRoot = join(preparedRoot, "candidate-runtime");
        await mkdir(runtimeRoot, { recursive: true });
        return {
          environment: { HOME: "/isolated/home" },
          runtimeRoot,
          evidence: {
            package_sha256: candidateValue.sha256,
            version: candidateValue.version,
            runtime_marker: candidateValue.runtime_marker,
            profile: candidateValue.profile,
            agent: candidateValue.agent,
          },
        };
      },
      clone: async () => undefined,
      execute: async () => ({ command: "host", exit: 1, reason: "cleanup-failed", stdout: "", stderr: "",
        cleanupEstablished: false, usage: { usd: 0, requests: 0, unpriced: [] } }),
    }), /replay-process-cleanup-failed/);
    await assert.rejects(stat(output));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact write and workspace cleanup failures fail closed", async () => {
  const writeRoot = await mkdtemp(join(tmpdir(), "swebench-replay-write-"));
  const cleanupRoot = await mkdtemp(join(tmpdir(), "swebench-replay-cleanup-"));
  const outputRoot = await mkdtemp(join(tmpdir(), "swebench-output-write-"));
  const prepare = async (candidateValue: typeof candidate, _packagePath: string, preparedRoot: string) => {
    const runtimeRoot = join(preparedRoot, "candidate-runtime");
    await mkdir(runtimeRoot, { recursive: true });
    return {
      environment: { HOME: "/isolated/home" },
      runtimeRoot,
      evidence: {
        package_sha256: candidateValue.sha256,
        version: candidateValue.version,
        runtime_marker: candidateValue.runtime_marker,
        profile: candidateValue.profile,
        agent: candidateValue.agent,
      },
    };
  };
  const execute = async () => ({ command: "host", exit: 1, reason: "failed", stdout: "", stderr: "",
    usage: { usd: 0, requests: 0, unpriced: [] } });
  try {
    await assert.rejects(runTestLive(manifest([instance("example__project-1")]), {
      agent: "dog-operator", modelNameOrPath: "sortie-dogs", timeoutSeconds: 1800, watchdogSeconds: 120,
      costLimitUsd: 50, runRoot: join(writeRoot, "run"), output: join(writeRoot, "predictions.jsonl"),
    }, { prepareCandidate: prepare, clone: async () => undefined, execute,
      writeReplayArtifact: async () => { throw new Error("disk-full"); } }), /replay-artifact-write-failed/);
    await assert.rejects(runTestLive(manifest([instance("example__project-1")]), {
      agent: "dog-operator", modelNameOrPath: "sortie-dogs", timeoutSeconds: 1800, watchdogSeconds: 120,
      costLimitUsd: 50, runRoot: join(cleanupRoot, "run"), output: join(cleanupRoot, "predictions.jsonl"),
    }, { prepareCandidate: prepare, clone: async () => undefined, execute,
      remove: async (path: string, options: Record<string, unknown>) => {
        if (path.includes("instances")) throw new Error("workspace-locked");
         return rm(path, options);
       } }), /replay-artifact-cleanup-failed/);
    const output = join(outputRoot, "predictions.jsonl");
    await assert.rejects(runTestLive(manifest([instance("example__project-1")]), {
      agent: "dog-operator", modelNameOrPath: "sortie-dogs", timeoutSeconds: 1800, watchdogSeconds: 120,
      costLimitUsd: 50, runRoot: join(outputRoot, "run"), output,
      metadata: join(outputRoot, "missing", "metadata.json"),
    }, { prepareCandidate: prepare, clone: async () => undefined, execute }), /run-output-write-failed/);
    await assert.rejects(stat(output));
    await assert.rejects(stat(`${output}.tmp`));
  } finally {
    await rm(writeRoot, { recursive: true, force: true });
    await rm(cleanupRoot, { recursive: true, force: true });
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("initial watchdog write failure terminates the process and returns replayable execution evidence",
  { skip: process.platform === "win32" }, async () => {
    const root = await mkdtemp(join(tmpdir(), "swebench-watchdog-write-"));
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    const executable = join(bin, "opencode");
    await writeFile(executable, "#!/bin/sh\nsleep 30\n");
    await chmod(executable, 0o755);
    try {
      const result = await runOpenCode({
        workspace: root,
        instanceId: "watchdog-write-failure",
        agent: "dog-operator",
        prompt: "idle",
        environment: { PATH: `${bin}:${process.env.PATH ?? ""}` },
        timeoutSeconds: 30,
        watchdogSeconds: 1,
        watchdogPath: join(root, "missing", "watchdog.jsonl"),
        startedAt: Date.now(),
      }, { ...fakeReadyServer, readUsage: () => ({ usd: 0, requests: 0, unpriced: [] }) });
      assert.equal(result.reason, "watchdog-write-failed");
      assert.equal(result.cleanupEstablished, true);
      assert.match(result.command, /opencode run/u);
      assert.equal(result.exit, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

test("watchdog observes an idle live process until the hard timeout", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-watchdog-"));
  const bin = join(root, "bin");
  const watchdogPath = join(root, "watchdog.jsonl");
  await mkdir(bin, { recursive: true });
  const executable = join(bin, "opencode");
  await writeFile(executable, "#!/bin/sh\nsleep 30\n");
  await chmod(executable, 0o755);
  await writeFile(join(root, ".bashrc"), `export PATH=${bin}:$PATH\n`);
  try {
    const result = await runOpenCode({
      workspace: root,
      instanceId: "idle",
      agent: "dog-operator",
      prompt: "idle",
      environment: { HOME: root, PATH: `${bin}:${process.env.PATH ?? ""}` },
      timeoutSeconds: 3,
      watchdogSeconds: 1,
      watchdogPath,
      startedAt: Date.now(),
    }, { ...fakeReadyServer, readUsage: () => ({ usd: 0, requests: 0, unpriced: [] }) });
    assert.equal(result.reason, "timeout");
    assert.ok(result.watchdogEvents >= 2);
    assert.match(await readFile(watchdogPath, "utf8"), /"event":"heartbeat"/u);
    assert.ok(result.lastActivityAgeMs >= 2000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cost polling stops an idle live process independently of watchdog activity",
  { skip: process.platform === "win32" }, async () => {
    const root = await mkdtemp(join(tmpdir(), "swebench-cost-limit-"));
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    const executable = join(bin, "opencode");
    await writeFile(executable, "#!/bin/sh\nsleep 30\n");
    await chmod(executable, 0o755);
    await writeFile(join(root, ".bashrc"), `export PATH=${bin}:$PATH\n`);
    try {
      let reads = 0;
      const result = await runOpenCode({
        workspace: root,
        instanceId: "cost-limit",
        agent: "dog-operator",
        prompt: "idle",
        environment: { HOME: root, PATH: `${bin}:${process.env.PATH ?? ""}` },
        timeoutSeconds: 30,
        watchdogSeconds: 5,
        startedAt: Date.now(),
        costLimitUsd: 0.5,
      }, { ...fakeReadyServer, readUsage: () => ({ usd: reads++ > 0 ? 0.5 : 0, requests: reads, unpriced: [] }) });
      assert.equal(result.reason, "cost-limit");
      assert.equal(result.cleanupEstablished, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
