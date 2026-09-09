import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import {
  assertBareIsolation,
  assertRunArmAllowed,
  assertVerifyAllowed,
  buildSpawnSpec,
  buildVerifierEnvironment,
  computeSummary,
  createLocalVerifierConfig,
  eventMetadata,
  deliveryResult,
  createPathOnlyWrapper,
  sanitizeForReport,
  validateManifest,
  verifyPinnedFiles,
  watchdogReason,
} from "./fixtures/frontierharness-local/run-local-case-study.mjs";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const officialPaths = [
  "instruction.md", "task.toml", "tests/test.patch", "tests/config.json", "tests/grader.py", "tests/test.sh",
];
const rewardFields = [
  "f2p_total", "f2p_passed", "p2p_total", "p2p_passed", "f2p", "p2p", "partial", "apply_failed",
];

function manifest(root: string): Record<string, unknown> {
  const toolNames = [
    "git", "node", "go", "goyacc", "go_ctrf_json_reporter", "python", "npm", "bash", "script",
  ];
  return {
    schema_version: 1, methodology_comparable: false, leaderboard: false,
    task_id: "datacurve/anko-typed-variable-bindings",
    pins: { deepswe_commit: "435ee89ec2f2e2289f33b0da4f992f0b7b7266b9",
      anko_base: "3f269a72ff69398b1250c584171f32d12c0d8085" },
    paths: { runtime_root: join(root, "_testenv", "run"), official_root: join(root, "official"),
      package_tgz: join(root, "package.tgz") },
    official_sha256: Object.fromEntries(officialPaths.map((path) => [path, hash(path)])),
    package: { sha256: hash("package"), version: "1.2.3", runtime_marker: "marker",
      required_assets: ["agent/dog-coordinator.md"] },
    source: { repository: "local-source", base: "3f269a72ff69398b1250c584171f32d12c0d8085" },
    opencode: { wsl_executable: "wsl.exe", executable: "/exact/opencode", version: "1.0.0",
      auth_file: "/secret/auth.json", model: "openai/gpt-5.6-sol", variant: "high" },
    tools: Object.fromEntries(toolNames
      .map((name) => [name, { environment: name === "git" ? "host" : "wsl",
        executable: name === "bash" ? "/usr/bin/bash" : name === "script" ? "/usr/bin/script" : `/exact/${name}`,
        args: [], probe_args: ["--version"], probe_exit: 0 }])),
    verifier: { environment: "wsl", result: { reward_file: "verifier/reward.json", reward_field: "reward",
      count_fields: rewardFields } },
    protocol: { wall_seconds: 5400, startup_seconds: 120, activity_seconds: 5400, progress_seconds: 5400,
      retry_count: 0, attempts_per_arm: 1, arm_order: ["bare", "sortie"] },
  };
}

test("rejects malformed and outside-root manifests", () => {
  const root = join(tmpdir(), "frontier-project");
  const valid = manifest(root);
  assert.throws(() => validateManifest(null, join(root, "manifest.json"), root), (error: Error & { gate?: string }) =>
    error.gate === "manifest-shape");
  const outside = structuredClone(valid) as any;
  outside.paths.runtime_root = join(tmpdir(), "outside-run");
  assert.throws(() => validateManifest(outside, join(root, "manifest.json"), root),
    (error: Error & { gate?: string }) => error.gate === "runtime-root");
});

test("published manifest schema accepts the runner protocol", async () => {
  const schema = JSON.parse(await readFile(new URL("./fixtures/frontierharness-local/manifest.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv2020().compile(schema);
  assert.equal(validate(manifest(join(tmpdir(), "schema-protocol"))), true, JSON.stringify(validate.errors));
});

test("rejects approved pin and byte hash mismatches", async () => {
  const root = await mkdtemp(join(tmpdir(), "frontier-pins-"));
  try {
    const value = manifest(root) as any;
    value.pins.anko_base = "0".repeat(40);
    assert.throws(() => validateManifest(value, join(root, "manifest.json"), root),
      (error: Error & { gate?: string }) => error.gate === "pin-mismatch");
    const valid = manifest(root) as any;
    for (const path of officialPaths) {
      await mkdir(join(root, "official", path, ".."), { recursive: true });
      await writeFile(join(root, "official", path), path);
    }
    await writeFile(join(root, "package.tgz"), "different");
    const context = validateManifest(valid, join(root, "manifest.json"), root);
    await assert.rejects(verifyPinnedFiles(context), (error: Error & { gate?: string }) =>
      error.gate === "package-hash-mismatch");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("requires the byte-pinned official tests/test.sh", () => {
  const root = join(tmpdir(), "frontier-test-script");
  const value = manifest(root) as any;
  delete value.official_sha256["tests/test.sh"];
  assert.throws(() => validateManifest(value, join(root, "manifest.json"), root),
    (error: Error & { gate?: string }) => error.gate === "official-hashes");
});

test("enforces Bare-before-Sortie and one-shot run/verifier guards", () => {
  const base: any = { preflight: { status: "pass" }, prepared: { status: "pass" }, arms: {} };
  assert.doesNotThrow(() => assertRunArmAllowed(base, "bare"));
  assert.throws(() => assertRunArmAllowed(base, "sortie"), (error: Error & { gate?: string }) => error.gate === "arm-order");
  const completed: any = { ...base, arms: { bare: { attempted: true, run: { status: "complete" } } } };
  assert.throws(() => assertRunArmAllowed(completed, "bare"), (error: Error & { gate?: string }) =>
    error.gate === "attempt-once");
  assert.doesNotThrow(() => assertRunArmAllowed(completed, "sortie"));
  assert.doesNotThrow(() => assertVerifyAllowed(completed, "bare"));
  completed.arms.bare.verification = { attempted: true };
  assert.throws(() => assertVerifyAllowed(completed, "bare"), (error: Error & { gate?: string }) =>
    error.gate === "verify-once");
});

test("detects Bare filesystem and resolved-config contamination", async () => {
  const root = await mkdtemp(join(tmpdir(), "frontier-bare-"));
  try {
    const config = join(root, "config");
    await mkdir(config);
    await writeFile(join(config, "opencode.json"), JSON.stringify({ plugin: [] }));
    await assertBareIsolation({ projectRoot: root, configRoots: [config], resolvedConfig: { plugin: [] } });
    await writeFile(join(config, "dog-coordinator.md"), "agent");
    await assert.rejects(assertBareIsolation({ projectRoot: root, configRoots: [config], resolvedConfig: { plugin: [] } }),
      (error: Error & { gate?: string }) => error.gate === "bare-filesystem-contamination");
    await rm(join(config, "dog-coordinator.md"));
    await assert.rejects(assertBareIsolation({ projectRoot: root, configRoots: [config],
      resolvedConfig: { plugin: ["sortie-dogs"] } }),
    (error: Error & { gate?: string }) => error.gate === "bare-config-contamination");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("sanitized output excludes credential paths/content and raw protocol material", () => {
  const authPath = "/home/person/.local/share/opencode/auth.json";
  const secret = "credential-value-never-retain";
  const output = sanitizeForReport({ status: "pass", auth_file: authPath, credential: secret,
    nested: { provider_url: "https://provider.invalid", raw_log: secret, prompt: "official text",
      patch_path: "/private/model.patch", safe: `prefix:${authPath}` }, token_metric_references: ["$.usage.tokens"] },
  [authPath, secret]);
  const encoded = JSON.stringify(output);
  assert.doesNotMatch(encoded, /auth\.json|credential-value|provider\.invalid|official text|model\.patch/u);
  assert.match(encoded, /\[excluded\]/u);
  assert.deepEqual((output as any).token_metric_references, ["$.usage.tokens"]);
});

test("refuses ratios unless both rewards are one and all metrics exist", () => {
  assert.deepEqual(computeSummary({ bare: { reward: 0, duration_ms: 20, cost: 2 },
    sortie: { reward: 1, duration_ms: 10, cost: 1 } }),
  { comparison_eligible: false, speed_ratio: null, cost_ratio: null, refusal: "reward_not_one" });
  assert.deepEqual(computeSummary({ bare: { reward: 1, duration_ms: 20 },
    sortie: { reward: 1, duration_ms: 10 } }),
  { comparison_eligible: true, speed_ratio: 2, cost_ratio: null, refusal: null });
  assert.deepEqual(computeSummary({ bare: { reward: 1, duration_ms: 20, cost: 4 },
    sortie: { reward: 1, duration_ms: 10, cost: 2 } }),
  { comparison_eligible: true, speed_ratio: 2, cost_ratio: 2, refusal: null });
});

test("empty delivery and transport errors cannot be successful results", () => {
  assert.deepEqual(deliveryResult({ exit: 0, patch_bytes: 0 }, { exit: 0, reward: 1 }),
    { outcome: "failed", reason: "no-delivered-patch" });
  assert.equal(deliveryResult({ exit: 0, patch_bytes: 20, event_errors: 1 }, { exit: 0, reward: 1 }).reason, "agent-event-error");
  assert.equal(deliveryResult({ exit: 0, patch_bytes: 20 }, { exit: 0, reward: 0 }).reason, "acceptance-failed");
});

test("CLI usage deduplicates step IDs, excludes tool bodies, and preserves zero versus missing", () => {
  const step = { sessionID: "ses_test", part: { id: "step1", type: "step-finish", cost: 0,
    tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 5, write: 0 } } } };
  const report = eventMetadata(Buffer.from([step, step, { part: { type: "tool", cost: 999 } }].map(JSON.stringify).join("\n")));
  assert.equal(report.usage.steps, 1);
  assert.equal(report.usage.tokens.input, 10);
  assert.equal(report.cost, 0);
  assert.equal(eventMetadata(Buffer.from("{}")).cost, null);
});

test("constructs processes with literal argument arrays and shell disabled", () => {
  const hostile = "value; echo SHOULD_NOT_RUN && $(touch nope)";
  const spec = buildSpawnSpec("/exact/tool", ["--value", hostile], { cwd: "/safe/root" });
  assert.equal(spec.executable, "/exact/tool");
  assert.deepEqual(spec.args, ["--value", hostile]);
  assert.equal(spec.options.shell, false);
  assert.equal(spec.options.cwd, "/safe/root");
});

test("watchdog prioritizes hard wall, startup, activity, and workspace progress", () => {
  const limits = { wall_ms: 3600, startup_ms: 120, activity_ms: 300, progress_ms: 600 };
  assert.equal(watchdogReason(120, { started_at: 0, first_output_at: null, last_activity_at: 0,
    last_progress_at: 0 }, limits), "startup");
  assert.equal(watchdogReason(500, { started_at: 0, first_output_at: 1, last_activity_at: 200,
    last_progress_at: 400 }, limits), "activity");
  assert.equal(watchdogReason(600, { started_at: 0, first_output_at: 1, last_activity_at: 599,
    last_progress_at: 0 }, limits), "progress");
  assert.equal(watchdogReason(3600, { started_at: 0, first_output_at: 1, last_activity_at: 3599,
    last_progress_at: 3599 }, limits), "hard-wall");
});

test("localizes only official verifier config report paths", () => {
  const source = Buffer.from(JSON.stringify({ base_commit: "abc", grade: { format: "ctrf",
    reports: ["/logs/verifier/base-ctrf.json", "/logs/verifier/gate-ctrf.json"] } }));
  const localized = JSON.parse(createLocalVerifierConfig(source, "/run/logs").toString("utf8"));
  assert.equal(localized.base_commit, "abc");
  assert.equal(localized.grade.format, "ctrf");
  assert.deepEqual(localized.grade.reports,
    ["/run/logs/verifier/base-ctrf.json", "/run/logs/verifier/gate-ctrf.json"]);
});

test("test.sh wrapper changes only approved absolute path prefixes", () => {
  const source = Buffer.from([
    "#!/usr/bin/bash",
    "python3 /tests/grader.py prepare --repo /app --artifacts /logs/artifacts",
    "bash /tests/steps.sh --app=/app --logs=/logs",
    "python3 /tests/grader.py grade --repo /app --logs /logs",
    "echo /application /testsuite /logs-old",
    "",
  ].join("\n"));
  const before = hash(source.toString("utf8"));
  const wrapped = createPathOnlyWrapper(source, {
    "/app": "/local/verifier", "/tests": "/local/official/tests", "/logs": "/local/logs",
  });
  assert.equal(hash(source.toString("utf8")), before);
  const expected = source.toString("utf8")
    .replaceAll(/\/app(?=\/|[^A-Za-z0-9._-]|$)/gu, "/local/verifier")
    .replaceAll(/\/tests(?=\/|[^A-Za-z0-9._-]|$)/gu, "/local/official/tests")
    .replaceAll(/\/logs(?=\/|[^A-Za-z0-9._-]|$)/gu, "/local/logs");
  assert.equal(wrapped.toString("utf8"), expected);
  assert.match(wrapped.toString("utf8"), /\/application \/testsuite \/logs-old/u);
  assert.match(wrapped.toString("utf8"), /grader\.py prepare[\s\S]*steps\.sh[\s\S]*grader\.py grade/u);
});

test("builds the official verifier environment from pinned tool and local paths", () => {
  const value = manifest(join(tmpdir(), "frontier-env")) as any;
  value.tools.go.executable = "/opt/go/bin/go";
  value.tools.goyacc.executable = "/opt/frontier-go/bin/goyacc";
  value.tools.go_ctrf_json_reporter.executable = "/opt/frontier-go/bin/go-ctrf-json-reporter";
  assert.deepEqual(buildVerifierEnvironment(value, {
    tests: "/run/official/tests", verifier: "/run/logs/verifier", app: "/run/app",
    artifacts: "/run/artifacts", gocache: "/run/gocache", gopath: "/run/gopath",
  }), {
    PATH: "/run/gopath/bin:/opt/go/bin:/opt/frontier-go/bin:/exact:/usr/bin:/bin",
    GOPATH: "/run/gopath",
    TESTS_DIR: "/run/official/tests",
    VERIFIER_DIR: "/run/logs/verifier",
    APP_DIR: "/run/app",
    ARTIFACTS_DIR: "/run/artifacts",
    GOCACHE: "/run/gocache",
  });
});

test("requires selectors matching the official FrontierHarness reward schema", () => {
  const root = join(tmpdir(), "frontier-selectors");
  assert.doesNotThrow(() => validateManifest(manifest(root), join(root, "manifest.json"), root));
  const wrong = manifest(root) as any;
  wrong.verifier.result.count_fields = [...rewardFields].reverse();
  assert.throws(() => validateManifest(wrong, join(root, "manifest.json"), root),
    (error: Error & { gate?: string }) => error.gate === "reward-selectors");
});
