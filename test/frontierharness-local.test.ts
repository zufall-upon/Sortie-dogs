import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

import {
  assertBareIsolation,
  anonymousMemoryCaptureArgs,
  assertRunArmAllowed,
  assertVerifyAllowed,
  buildSpawnSpec,
  buildVerifierEnvironment,
  computeSummary,
  createConfigRoots,
  createLocalVerifierConfig,
  debugEventEvidence,
  debugRecoveryFailure,
  debugRecoveryPacket,
  debugResumeArgs,
  eventMetadata,
  hasPinnedSubagentDepth,
  isolatedConfig,
  deliveryResult,
  expectedOperation,
  expectedOperationEvent,
  execute,
  nativeCommandEvidence,
  pairRemainingMs,
  pinnedWorkspaceRefCommands,
  recordPreAgentFailure,
  registeredOperatorTools,
  resolvedConfigCommandArgs,
  summarize,
  cleanup,
  classifyNativeImplementationChildren,
  createPathOnlyWrapper,
  sanitizeForReport,
  resolveRunnerProfile,
  validateManifest,
  v1PluginWrapperSource,
  verifyPinnedFiles,
  verifyConfigLoaderDependency,
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
    protocol: { wall_seconds: 5400, startup_seconds: 5400, activity_seconds: 5400, progress_seconds: 5400,
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
  const value = manifest(join(tmpdir(), "schema-protocol")) as any;
  value.expected_operation = {
    bare: { min_patch_bytes: 1, min_implementation_children: 0, terminal_outcome: null },
    sortie: { min_patch_bytes: 1, min_implementation_children: 1, terminal_outcome: "DONE" },
  };
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  assert.doesNotThrow(() => validateManifest(value, join(tmpdir(), "schema-protocol", "manifest.json"), join(tmpdir(), "schema-protocol")));
  value.qualification_only = true;
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  assert.doesNotThrow(() => validateManifest(value, join(tmpdir(), "schema-protocol", "manifest.json"), join(tmpdir(), "schema-protocol")));
  value.expected_operation.sortie.min_patch_bytes = 0;
  assert.equal(validate(value), false);
  assert.throws(() => validateManifest(value, join(tmpdir(), "schema-protocol", "manifest.json"), join(tmpdir(), "schema-protocol")));
});

test("v010 profile is closed, qualification-only, and pins its runtime surface", async () => {
  const root = join(tmpdir(), "schema-v010");
  const schema = JSON.parse(await readFile(new URL("./fixtures/frontierharness-local/manifest.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv2020().compile(schema);
  const value = manifest(root) as any;
  value.profile = "v010";
  assert.equal(validate(value), false);
  assert.throws(() => validateManifest(value, join(root, "manifest.json"), root),
    (error: Error & { gate?: string }) => error.gate === "qualification-mode");
  value.qualification_only = true;
  value.opencode.host_database = "/home/fixture/.local/share/opencode/opencode.db";
  value.package.required_assets = ["agent/dog-operator.md", "agent/dogs-coordinator.md",
    "agent/dog-worker-v010.md", "command/sortie-v010.md"];
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  const context = validateManifest(value, join(root, "manifest.json"), root);
  assert.equal(context.profile, resolveRunnerProfile("v010"));
  assert.deepEqual(context.profile.initArgs, ["--profile", "v010"]);
  assert.equal(context.profile.agent, "dog-operator");
  assert.equal(context.profile.runtimeModule, "runtime-assets-v010.js");
  assert.equal(context.profile.markerExport, "V010_RUNTIME_ASSET_VERSION");
  assert.equal(isolatedConfig("v010").experimental?.subagent_depth, 2);
  assert.equal("experimental" in isolatedConfig("stable"), false);
  const terra = structuredClone(value);
  terra.opencode.model = "openai/gpt-5.6-terra";
  terra.opencode.variant = "xhigh";
  assert.equal(validate(terra), true, JSON.stringify(validate.errors));
  assert.doesNotThrow(() => validateManifest(terra, join(root, "terra-manifest.json"), root));
  terra.opencode.variant = "high";
  assert.throws(() => validateManifest(terra, join(root, "invalid-terra-manifest.json"), root),
    (error: Error & { gate?: string }) => error.gate === "opencode");
  const lunaFast = structuredClone(value);
  lunaFast.opencode.model = "openai/gpt-5.6-luna-fast";
  lunaFast.opencode.variant = "max";
  assert.doesNotThrow(() => validateManifest(lunaFast, join(root, "luna-fast-manifest.json"), root));
  lunaFast.opencode.variant = "xhigh";
  assert.throws(() => validateManifest(lunaFast, join(root, "invalid-luna-fast-manifest.json"), root),
    (error: Error & { gate?: string }) => error.gate === "opencode");
  value.package.required_assets.pop();
  assert.equal(validate(value), false);
  assert.throws(() => validateManifest(value, join(root, "manifest.json"), root),
    (error: Error & { gate?: string }) => error.gate === "package-assets");
  value.profile = "future";
  assert.equal(validate(value), false);
});

test("v0127 matched profile pins the published package, GPT-6 route, and one shared deadline", async () => {
  const root = join(tmpdir(), "schema-v0127");
  const schema = JSON.parse(await readFile(new URL("./fixtures/frontierharness-local/manifest.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv2020().compile(schema);
  const value = manifest(root) as any;
  value.profile = "v0127";
  value.package.version = "0.12.7";
  value.package.required_assets = ["agent/dog-operator.md", "agent/dogs-coordinator.md",
    "agent/dog-worker-v010.md", "command/sortie-v010.md"];
  value.opencode.host_database = "/home/fixture/.local/share/opencode/opencode.db";
  value.opencode.model = "openai/gpt-6-sol";
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  assert.equal(validateManifest(value, join(root, "manifest.json"), root).profile.agent, "dog-operator");
  assert.equal(isolatedConfig("v0127").experimental?.subagent_depth, 2);
  assert.equal(hasPinnedSubagentDepth({ subagent_depth: 2, experimental: {} }), true);
  assert.equal(hasPinnedSubagentDepth({ experimental: { subagent_depth: 2 } }), true);
  assert.equal(hasPinnedSubagentDepth({ subagent_depth: 1, experimental: { subagent_depth: 2 } }), false);
  assert.equal(hasPinnedSubagentDepth({ experimental: {} }), false);
  assert.equal(pairRemainingMs({ protocol: { pair_deadline_at: new Date(100_000).toISOString() } }, 0), 100_000);
  assert.equal(pairRemainingMs({ protocol: { pair_deadline_at: new Date(100_000).toISOString() } }, 100_000), 0);
  value.protocol.total_wall_seconds = 3600;
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  assert.doesNotThrow(() => validateManifest(value, join(root, "bounded-manifest.json"), root));
  assert.equal(pairRemainingMs({ protocol: { pair_deadline_at: new Date(10_000_000).toISOString(),
    pair_wall_seconds: 3600 } }, 0), 3_600_000);
  const invalidLimit = structuredClone(value);
  invalidLimit.protocol.total_wall_seconds = 5401;
  assert.equal(validate(invalidLimit), false);
  assert.throws(() => validateManifest(invalidLimit, join(root, "unbounded-manifest.json"), root),
    (error: Error & { gate?: string }) => error.gate === "total-wall-limit");
  value.opencode.variant = "xhigh";
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  assert.doesNotThrow(() => validateManifest(value, join(root, "xhigh-manifest.json"), root));
  value.opencode.variant = "max";
  assert.equal(validate(value), false);
  assert.throws(() => validateManifest(value, join(root, "manifest.json"), root));
  value.opencode.variant = "high";
  value.package.version = "0.12.6";
  assert.equal(validate(value), false);
  assert.throws(() => validateManifest(value, join(root, "manifest.json"), root),
    (error: Error & { gate?: string }) => error.gate === "v0127-version");
});

test("v0127 V1 loader adapter exposes the mission factory and refuses missing host tools", async () => {
  assert.equal(v1PluginWrapperSource(),
    'import { SortieDogsPlugin } from "sortie-dogs/plugin";\n' +
    'export default { id: "sortie-dogs.v010", server: SortieDogsPlugin };\n');
  const registered = { name: "dog-operator", tools: {
    sortie_v010_start_mission: true, sortie_v010_plan_units: true, sortie_v010_complete_mission: true,
  } };
  assert.equal(registeredOperatorTools(registered), true);
  assert.equal(registeredOperatorTools({ ...registered, tools: { read: true } }), false);
  assert.equal(registeredOperatorTools({ ...registered, name: "build" }), false);
  const root = await mkdtemp(join(tmpdir(), "sortie-v1-adapter-"));
  try {
    const control = join(root, ".opencode");
    const packageRoot = join(control, "node_modules", "sortie-dogs");
    const plugins = join(control, "plugins");
    await mkdir(packageRoot, { recursive: true });
    await mkdir(plugins);
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "sortie-dogs", type: "module",
      exports: { "./plugin": "./plugin.mjs" } }));
    await writeFile(join(packageRoot, "plugin.mjs"),
      "export async function SortieDogsPlugin() { return { tool: { sortie_v010_start_mission: {} } }; }\n");
    const entry = join(plugins, "sortie-dogs-compat.mjs");
    await writeFile(entry, v1PluginWrapperSource());
    const module = await import(pathToFileURL(entry).href);
    assert.equal(module.default.id, "sortie-dogs.v010");
    assert.equal(typeof module.default.server, "function");
    assert.equal(typeof (await module.default.server()).tool.sortie_v010_start_mission, "object");
  } finally { await rm(root, { recursive: true, force: true }); }
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
  assert.doesNotThrow(() => assertRunArmAllowed(base, "sortie", true));
  assert.throws(() => assertRunArmAllowed(base, "bare", true), (error: Error & { gate?: string }) =>
    error.gate === "qualification-arm");
  assert.doesNotThrow(() => assertVerifyAllowed(completed, "bare"));
  completed.arms.bare.verification = { attempted: true };
  assert.throws(() => assertVerifyAllowed(completed, "bare"), (error: Error & { gate?: string }) =>
    error.gate === "verify-once");
  assert.doesNotThrow(() => assertVerifyAllowed({ arms: { sortie: { run: { status: "complete" } } } }, "sortie", true));
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
  assert.deepEqual(computeSummary({ bare: { reward: 1, duration_ms: 20, cost: 4 },
    sortie: { reward: 1, duration_ms: 10, cost: 2 } }, false),
  { comparison_eligible: false, speed_ratio: null, cost_ratio: null, refusal: "normal-operation-unproven" });
});

test("empty delivery and transport errors cannot be successful results", () => {
  assert.deepEqual(deliveryResult({ exit: 0, patch_bytes: 0 }, { exit: 0, reward: 1 }),
    { outcome: "failed", reason: "no-delivered-patch" });
  assert.equal(deliveryResult({ exit: 0, patch_bytes: 20, event_errors: 1 }, { exit: 0, reward: 1 }).reason, "agent-event-error");
  assert.equal(deliveryResult({ exit: 0, patch_bytes: 20 }, { exit: 0, reward: 0 }).reason, "acceptance-failed");
});

test("expected-operation failure blocks both remaining arms and verifiers", () => {
  const run = { exit: 0, root_session_id: "ses_root", patch_bytes: 20, event_errors: 0,
    implementation_children: ["ses_child"], terminal_outcome: "DONE" };
  assert.equal(expectedOperation(run, "sortie").status, "pass");
  for (const change of [{ patch_bytes: 0 }, { implementation_children: [] },
    { root_session_id: null }, { terminal_outcome: "INTERRUPTED" }, { event_errors: 1 }]) {
    assert.equal(expectedOperation({ ...run, ...change }, "sortie").status, "fail");
  }
  const state = { stopped: { reason: "no-delivered-patch" } };
  for (const arm of ["bare", "sortie"]) {
    assert.throws(() => assertRunArmAllowed(state, arm), /Benchmark stopped/u);
    assert.throws(() => assertVerifyAllowed(state, arm), /Benchmark stopped/u);
  }
  assert.equal(expectedOperationEvent({ part: { type: "tool", tool: "task", state: { status: "error" } } }), "agent-event-error");
  assert.equal(expectedOperationEvent({ part: { type: "tool", tool: "read",
    state: { status: "error", error: "File not found: /project/ast/type.go" } } }), null);
  assert.equal(expectedOperationEvent({ part: { type: "tool", tool: "read",
    state: { status: "error", error: "Offset 495 is out of range for this file (458 lines)" } } }), null);
  for (const tool of ["read", "glob", "grep", "task", "bash"]) {
    assert.equal(expectedOperationEvent({ part: { type: "tool", tool,
      state: { status: "error", error: "Permission denied" } } }), "agent-event-error");
  }
  assert.equal(eventMetadata(Buffer.from(JSON.stringify({
    part: { type: "tool", tool: "read", state: { status: "error", error: "File not found: /project/ast/type.go" } },
  }))).event_errors, 0);
  assert.equal(expectedOperationEvent({ part: { type: "tool", state: { status: "running" } } }), null);
});

test("typed refusals are recorded as recoverable instead of ending the run", () => {
  const refusals = [
    { tool: "sortie_v010_cancel_operator", error: "operator-cancel-reason-invalid" },
    { tool: "task", error: "SORTIE_FAST_LANE_DENIED: REVIEW_EVIDENCE_REQUIRED; required: canonical_validation_exit: 0" },
  ];
  for (const { tool, error } of refusals) {
    assert.equal(expectedOperationEvent({ part: { type: "tool", tool, state: { status: "error", error } } }), null);
  }
  for (const error of ["Permission denied", "ENOENT: no such file or directory, open '/app/vm/vm.go'",
    "TypeError: Cannot read properties of undefined (reading 'units')"]) {
    assert.equal(expectedOperationEvent({ part: { type: "tool", tool: "task", state: { status: "error", error } } }),
      "agent-event-error");
  }
  const stream = [...refusals, { tool: "sortie_v010_cancel_operator", error: "operator-cancel-reason-invalid" }]
    .map(({ tool, error }) => ({ part: { type: "tool", tool, state: { status: "error", error } } }));
  const metadata = eventMetadata(Buffer.from(stream.map(value => JSON.stringify(value)).join("\n")));
  assert.equal(metadata.event_errors, 0);
  assert.equal(metadata.recoverable_refusals, 3);
  assert.deepEqual(metadata.refusal_codes, [{ code: "SORTIE_FAST_LANE_DENIED", count: 1 },
    { code: "operator-cancel-reason-invalid", count: 2 }]);
  assert.equal(expectedOperation({ exit: 0, root_session_id: "ses_root", patch_bytes: 20, event_errors: 0,
    recoverable_refusals: 3, implementation_children: ["ses_child"], terminal_outcome: "DONE" }, "sortie").status, "pass");
});

test("CLI records completed implementation child identity and canonical terminal outcome", () => {
  const events = [{ sessionID: "ses_root", part: { type: "tool", tool: "task", state: {
    status: "completed", input: { subagent_type: "dog-worker" }, metadata: { sessionId: "ses_child" } } } },
  { sessionID: "ses_root", part: { type: "text", text: "✅ **DONE** task — complete" } }];
  const result = eventMetadata(Buffer.from(events.map(JSON.stringify).join("\n")));
  assert.deepEqual(result.implementation_children, ["ses_child"]);
  assert.equal(result.terminal_outcome, "DONE");
});

test("debug continuation pins the same session and accepts only bounded public recovery packets", () => {
  const root = join(tmpdir(), "debug-resume");
  const value = manifest(root) as any;
  value.profile = "v010";
  value.qualification_only = true;
  value.opencode.host_database = "/home/fixture/.local/share/opencode/opencode.db";
  value.package.required_assets = ["agent/dog-operator.md", "agent/dogs-coordinator.md",
    "agent/dog-worker-v010.md", "command/sortie-v010.md"];
  const args = debugResumeArgs(value, "/tmp/debug-workspace", "ses_exact_root");
  assert.deepEqual(args.slice(0, 4), ["run", "--dir", "/tmp/debug-workspace", "--format"]);
  assert.deepEqual(args.slice(args.indexOf("--session"), args.indexOf("--session") + 2),
    ["--session", "ses_exact_root"]);
  assert.match(args.at(-1)!, /First call sortie_v010_operator_status/u);
  assert.match(args.at(-1)!, /follow its exact public next_action/u);
  assert.match(args.at(-1)!, /status is absent[\s\S]+repository-relative tool paths/u);
  assert.match(args.at(-1)!, /awaiting-acceptance[\s\S]+independent review/u);
  assert.match(args.at(-1)!, /reason=review-blocking[\s\S]+without user approval/u);
  assert.doesNotMatch(args.at(-1)!, /discard y\.output|typed variable binding|modify parser|edit source/u);
  const v0127 = structuredClone(value);
  v0127.profile = "v0127";
  v0127.opencode.model = "openai/gpt-6-sol";
  v0127.opencode.variant = "xhigh";
  assert.deepEqual(debugResumeArgs(v0127, "/tmp/debug-workspace", "ses_exact_root")
    .slice(0, 4), args.slice(0, 4));

  const packet = { status: "awaiting-decision", decision: "operator-contract-repair-required",
    contract_repair: { mode: "discard-transient", repair_fingerprint: `sha256:${"a".repeat(64)}`,
      files: [{ path: "y.output", size: 3, sha256: "b".repeat(64) }] },
    resume_requires_host_reconciliation: false };
  const stream = Buffer.from(JSON.stringify({ sessionID: "ses_exact_root", part: { type: "tool",
    tool: "sortie_v010_operator_status", state: { status: "completed", output: JSON.stringify(packet) } } }));
  assert.deepEqual(debugRecoveryPacket(stream, "ses_exact_root"), { route: "contract-repair",
    decision: "operator-contract-repair-required", repair_fingerprint: `sha256:${"a".repeat(64)}`,
    files: [{ path: "y.output", size: 3, sha256: "b".repeat(64) }] });
  assert.equal(debugRecoveryPacket(stream, "ses_other"), null);

  const acceptancePacket = { status: "awaiting-decision", decision: "operator-acceptance-remediation-required",
    resume_requires_host_reconciliation: false, repair_generation: 1,
    next_action: "call sortie_v010_cancel_operator, then call sortie_v010_prepare_operator for the same acceptance",
    acceptance_remediation: { failed_criteria: [{ index: 0, criterion: "canonical test passes" }],
      failed_evidence: { command: ["go test ./..."], outcome: "fail", exit_code: 1 } },
    units: [{ result_class: "acceptance", repair_validation: null }] };
  const acceptanceStream = Buffer.from(JSON.stringify({ sessionID: "ses_exact_root", part: { type: "tool",
    tool: "sortie_v010_operator_status", state: { status: "completed", output: JSON.stringify(acceptancePacket) } } }));
  assert.deepEqual(debugRecoveryPacket(acceptanceStream, "ses_exact_root"), {
    route: "acceptance-remediation", decision: "operator-acceptance-remediation-required" });

  const reviewPacket = { status: "awaiting-acceptance", review_decision: "root-assess-independent-review",
    run_id: "operator-review-ready", acceptance_fingerprint: `sha256:${"d".repeat(64)}`,
    next_action: "assess independent-review; review PASS calls complete_operator; blocking findings use review-blocking replacement",
    units: [{ status: "succeeded" }] };
  const reviewStream = Buffer.from(JSON.stringify({ sessionID: "ses_exact_root", part: { type: "tool",
    tool: "sortie_v010_operator_status", state: { status: "completed", output: JSON.stringify(reviewPacket) } } }));
  assert.deepEqual(debugRecoveryPacket(reviewStream, "ses_exact_root"), { route: "awaiting-acceptance-review",
    decision: "root-assess-independent-review", run_id: "operator-review-ready",
    acceptance_fingerprint: `sha256:${"d".repeat(64)}` });
  assert.equal(debugRecoveryFailure(null, { status: "fail" }), "debug-public-recovery-unproven");
  assert.equal(debugRecoveryFailure(null, { status: "pass" }), null);
  assert.equal(debugRecoveryFailure({ route: "process-defect-resume" }, { status: "fail" }), null);
});

test("debug evidence fingerprints errors and process-defect resume requires public support", () => {
  const errors = Buffer.from([
    { sessionID: "ses_root", part: { type: "tool", tool: "task", state: { status: "error", error: "private task error" } } },
    { sessionID: "ses_root", part: { type: "tool", tool: "bash", state: { status: "error", error: "private shell error" } } },
  ].map(JSON.stringify).join("\n"));
  const evidence = debugEventEvidence(errors);
  assert.deepEqual(evidence.map(item => item.tool), ["task", "bash"]);
  assert.match(evidence[0]!.error_sha256, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(evidence), /private/u);

  const packet = { status: "awaiting-decision", decision: "dispatch-admission-rejected", contract_repair: null,
    resume_requires_host_reconciliation: true, run_id: "operator-run",
    acceptance_fingerprint: `sha256:${"c".repeat(64)}`,
    units: [{ status: "failed", result_class: "process-defect" }] };
  const stream = Buffer.from(JSON.stringify({ sessionID: "ses_root", part: { type: "tool",
    tool: "sortie_v010_operator_status", state: { status: "completed", output: JSON.stringify(packet) } } }));
  assert.deepEqual(debugRecoveryPacket(stream, "ses_root"), { route: "process-defect-resume",
    decision: "dispatch-admission-rejected", run_id: "operator-run",
    acceptance_fingerprint: `sha256:${"c".repeat(64)}` });
  packet.resume_requires_host_reconciliation = false;
  const unsupported = Buffer.from(JSON.stringify({ sessionID: "ses_root", part: { type: "tool",
    tool: "sortie_v010_operator_status", state: { status: "completed", output: JSON.stringify(packet) } } }));
  assert.equal(debugRecoveryPacket(unsupported, "ses_root"), null);
});

test("prepare materializes only main at the exact pinned base without changing the six official inputs", () => {
  assert.deepEqual(pinnedWorkspaceRefCommands(), [["update-ref", "refs/heads/main",
    "3f269a72ff69398b1250c584171f32d12c0d8085"]]);
  assert.equal(pinnedWorkspaceRefCommands().flat().includes("master"), false);
  assert.deepEqual(officialPaths, [
    "instruction.md", "task.toml", "tests/test.patch", "tests/config.json", "tests/grader.py", "tests/test.sh",
  ]);
});

test("isolated config roots pin and verify a non-linked OpenCode loader package", async () => {
  const root = await mkdtemp(join(tmpdir(), "frontier-loader-"));
  const version = "1.18.29";
  try {
    const roots = [];
    for (const arm of ["bare", "sortie"]) {
      const armRoots = await createConfigRoots(root, arm, "stable", version);
      roots.push(armRoots);
      const declared = JSON.parse(await readFile(join(armRoots.loader, "package.json"), "utf8"));
      assert.deepEqual(declared.dependencies, { "@opencode-ai/plugin": version });
      const installed = join(armRoots.loader, "node_modules", "@opencode-ai", "plugin");
      await mkdir(installed, { recursive: true });
      await writeFile(join(installed, "package.json"), JSON.stringify({ name: "@opencode-ai/plugin", version }));
      await writeFile(join(armRoots.loader, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {
        "": { dependencies: { "@opencode-ai/plugin": version } },
        "node_modules/@opencode-ai/plugin": { version },
      } }));
      assert.deepEqual(await verifyConfigLoaderDependency(armRoots.loader, version), {
        package: "@opencode-ai/plugin", version, installed_copy_symlink: false, package_lock_link: false,
      });
    }
    const linkedLock = JSON.parse(await readFile(join(roots[1].loader, "package-lock.json"), "utf8"));
    linkedLock.packages["node_modules/@opencode-ai/plugin"].link = true;
    await writeFile(join(roots[1].loader, "package-lock.json"), JSON.stringify(linkedLock));
    await assert.rejects(verifyConfigLoaderDependency(roots[1].loader, version),
      (error: Error & { gate?: string }) => error.gate === "config-loader-identity");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("v010 counts only native completed worker descendants in the exact fixture family", () => {
  const directory = "/fixture/project";
  const sessions = [
    { id: "ses_root", parent: null, directory }, { id: "ses_proposal", parent: "ses_root", directory },
    { id: "ses_delegate", parent: "ses_root", directory }, { id: "ses_worker", parent: "ses_delegate", directory },
    { id: "ses_operator", parent: "ses_root", directory }, { id: "ses_failed", parent: "ses_delegate", directory },
    { id: "ses_cycle_a", parent: "ses_cycle_b", directory }, { id: "ses_cycle_b", parent: "ses_cycle_a", directory },
  ];
  const tasks = [
    { caller: "ses_root", child: "ses_proposal", agent: "dog-operator", status: "completed" },
    { caller: "ses_root", child: "ses_delegate", agent: "dogs-coordinator", status: "completed" },
    { caller: "ses_delegate", child: "ses_worker", agent: "dog-worker-v010", status: "completed" },
    { caller: "ses_root", child: "ses_operator", agent: "dog-worker-v010", status: "failed" },
    { caller: "ses_delegate", child: "ses_failed", agent: "dog-worker-v010", status: "failed" },
    { caller: "ses_cycle_a", child: "ses_cycle_b", agent: "dog-worker-v010", status: "completed" },
    { caller: "ses_root", child: "ses_worker", agent: "dog-worker-v010", status: "completed" },
  ];
  assert.deepEqual(classifyNativeImplementationChildren({ sessions, tasks }, "ses_root", directory), ["ses_worker"]);
  const stream = [{ sessionID: "ses_root", part: { type: "tool", tool: "task", state: { status: "completed",
    input: { subagent_type: "dog-worker-v010" }, metadata: { sessionId: "ses_fake" } } } }];
  assert.deepEqual(eventMetadata(Buffer.from(stream.map(JSON.stringify).join("\n")), "v010").implementation_children, []);
});

test("first error stops a live process and partial summary permits cleanup without verifiers", async () => {
  const root = await mkdtemp(join(process.cwd(), "_testenv", "frontier-stop-"));
  try {
    const result = await execute(process.execPath, ["-e",
      `console.log(JSON.stringify({type:'error'}));setInterval(()=>{},60000)`],
    { eventGate: expectedOperationEvent, timeoutMs: 10000 });
    assert.equal(result.operationFailure, "agent-event-error");
    assert.equal(result.timedOut, false);
    assert.throws(() => process.kill(result.pid, 0));
    const state = { stopped: { arm: "bare", reason: result.operationFailure },
      arms: { bare: { active_pid: null, run: { exit: result.code, patch_bytes: 0 } } } };
    await writeFile(join(root, "frontierharness-state.json"), JSON.stringify(state));
    await mkdir(join(root, "workspaces"));
    const context = { runtimeRoot: root, manifest: manifest(process.cwd()) };
    const report = await summarize(context);
    assert.equal(report.comparison.comparison_eligible, false);
    assert.equal(report.arms.sortie.status, "not-run");
    assert.equal((await cleanup(context, true)).remaining_agent_processes, 0);
    const saved = JSON.parse(await readFile(join(root, "frontierharness-state.json"), "utf8"));
    assert.equal(saved.arms.bare.verification, undefined);
    assert.equal(saved.arms.sortie, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pre-agent native failure consumes attempt and persists only bounded evidence for summary and cleanup", async () => {
  const root = await mkdtemp(join(process.cwd(), "_testenv", "frontier-pre-agent-"));
  try {
    const result = await execute(process.execPath, ["-e",
      "process.stdout.write('provider-secret-body');process.stderr.write('auth-secret-body');process.exit(17)"]);
    const state: any = { schema_version: 1, arms: { sortie: { attempted: true,
      started_at: "2026-09-14T00:00:00.000Z", active_pid: null } } };
    const context = { runtimeRoot: root, manifest: manifest(process.cwd()) };
    await mkdir(join(root, "configs"));
    await mkdir(join(root, "workspaces"));
    const report = await recordPreAgentFailure(context, state, "sortie", "resolved-config",
      nativeCommandEvidence(result), { version: "fixture" });
    assert.equal(report.comparison.comparison_eligible, false);
    assert.equal(report.comparison.refusal, "expected-operation");
    assert.equal(report.arms.sortie.status, "pre-agent-failure");
    const savedText = await readFile(join(root, "frontierharness-state.json"), "utf8");
    const saved = JSON.parse(savedText);
    assert.equal(saved.arms.sortie.attempted, true);
    assert.equal(saved.arms.sortie.run.attempt, 1);
    assert.equal(saved.arms.sortie.run.retry, 0);
    assert.equal(saved.arms.sortie.run.exit, 17);
    assert.equal(saved.arms.sortie.run.stdout_sha256, hash("provider-secret-body"));
    assert.equal(saved.arms.sortie.run.stderr_sha256, hash("auth-secret-body"));
    assert.equal(saved.stopped.gate, "resolved-config");
    assert.equal(savedText.includes("provider-secret-body"), false);
    assert.equal(savedText.includes("auth-secret-body"), false);
    assert.equal((await cleanup(context, true)).remaining_agent_processes, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pre-agent WSL timeout keeps cleanup fail-closed when Linux process cleanup is unconfirmed", async () => {
  const root = await mkdtemp(join(process.cwd(), "_testenv", "frontier-pre-agent-wsl-timeout-"));
  try {
    const state: any = { schema_version: 1, arms: { sortie: { attempted: true,
      started_at: "2026-09-14T00:00:00.000Z", active_pid: null } } };
    const context = { runtimeRoot: root, manifest: manifest(process.cwd()) };
    await mkdir(join(root, "configs"));
    await mkdir(join(root, "workspaces"));
    await writeFile(join(root, "configs", "must-remain"), "diagnosis-evidence");
    const timeout = nativeCommandEvidence({ code: 124, signal: "hard-wall", timedOut: true,
      watchdog: "hard-wall", stdout: Buffer.from("provider-secret-body"), stderr: Buffer.from("auth-secret-body") });
    await recordPreAgentFailure(context, state, "sortie", "resolved-config",
      { ...timeout, process_scope: "wsl" }, { version: "fixture" });
    const savedText = await readFile(join(root, "frontierharness-state.json"), "utf8");
    const saved = JSON.parse(savedText);
    assert.equal(saved.arms.sortie.run.operation_failure, "process-cleanup-unconfirmed");
    assert.equal(saved.arms.sortie.run.cleanup_confirmation, "unconfirmed");
    assert.equal(saved.arms.sortie.run.watchdog, "hard-wall");
    assert.equal(savedText.includes("provider-secret-body"), false);
    assert.equal(savedText.includes("auth-secret-body"), false);
    await assert.rejects(cleanup(context, true),
      (error: Error & { gate?: string }) => error.gate === "cleanup-process");
    assert.equal(await readFile(join(root, "configs", "must-remain"), "utf8"), "diagnosis-evidence");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("confirmed owned WSL timeout records sanitized failure and permits normal cleanup", async () => {
  const root = await mkdtemp(join(process.cwd(), "_testenv", "frontier-pre-agent-wsl-confirmed-"));
  try {
    const state: any = { schema_version: 1, arms: { sortie: { attempted: true,
      started_at: "2026-09-14T00:00:00.000Z", active_pid: null } } };
    const context = { runtimeRoot: root, manifest: manifest(process.cwd()) };
    await mkdir(join(root, "configs"));
    await mkdir(join(root, "workspaces"));
    const timeout = nativeCommandEvidence({ code: 124, signal: "hard-wall", timedOut: true,
      watchdog: "hard-wall", stdout: Buffer.from("provider-secret-body"), stderr: Buffer.from("auth-secret-body"),
      processScope: "wsl", processGroup: 1234, cleanupConfirmation: "confirmed" });
    await recordPreAgentFailure(context, state, "sortie", "resolved-config", timeout, { version: "fixture" });
    const savedText = await readFile(join(root, "frontierharness-state.json"), "utf8");
    const saved = JSON.parse(savedText);
    assert.equal(saved.arms.sortie.run.operation_failure, "pre-agent-failure");
    assert.equal(saved.arms.sortie.run.cleanup_confirmation, "confirmed");
    assert.equal(saved.arms.sortie.run.process_group, 1234);
    assert.equal(savedText.includes("provider-secret-body"), false);
    assert.equal(savedText.includes("auth-secret-body"), false);
    assert.equal((await cleanup(context, true)).remaining_agent_processes, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("anonymous memory capture preserves complete JSON beyond 64 KiB without files", {
  skip: process.platform !== "linux" || !process.execPath,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "frontier-memory-config-"));
  try {
    const payloadBytes = 70 * 1024;
    const child = ["-e", `process.stdout.write(JSON.stringify({config:"x".repeat(${payloadBytes})}))`];
    const result = await execute("/usr/bin/python3", anonymousMemoryCaptureArgs(process.execPath, child),
      { cwd: root, timeoutMs: 10_000 });
    assert.equal(result.code, 0);
    assert.ok(result.stdout.length > 64 * 1024);
    assert.equal(JSON.parse(result.stdout.toString("utf8")).config.length, payloadBytes);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
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
  const capture = anonymousMemoryCaptureArgs("/exact/tool", ["--value", hostile]);
  assert.deepEqual(capture.slice(-3), ["/exact/tool", "--value", hostile]);
  assert.deepEqual(resolvedConfigCommandArgs(), ["debug", "config"]);
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
