import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { benchmarkEnvironment, benchmarkInlineConfig, benchmarkPermissionPolicy, cloneInstance, createDryRunPlan, createInferenceManifest, createInstancePrompt, createLiveRunPlan, formatPrediction, parseArguments, runDryRun, runLive, runOpenCode } from "../scripts/swebench-lite-runner.mjs";
import { runCandidatePreflight } from "../scripts/swebench-candidate-preflight.mjs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

const candidate = {
  package_tgz: "sortie-dogs-0.10.6.tgz",
  sha256: "a".repeat(64),
  version: "0.10.6",
  runtime_marker: "0.10.0-v0912-language4-cost-rpt10-compaction-ref2-proposal1-review-remediation1-surface4-proposal-recovery2-quality1-terminal2-route1-path1-permission2-prerequisite1",
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
  assert.match(result.instances[0]!.prompt, /example\/project/);
  assert.equal(Object.hasOwn(result.instances[0]!, "patch"), false);
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

test("benchmark permissions deny browsing and remote shell access while retaining local commands", () => {
  const policy = benchmarkPermissionPolicy();
  assert.equal(policy.webfetch, "deny");
  assert.equal(policy.websearch, "deny");
  assert.equal(policy.bash["*"], "allow");
  for (const pattern of ["*curl *", "*wget *", "*gh *", "*git fetch *", "*git push *", "*https://*"]) {
    assert.equal(policy.bash[pattern], "deny");
  }
  const inline = benchmarkInlineConfig("file:///candidate/plugin.js", ["dog-operator", "dog-worker"]);
  assert.deepEqual(inline.plugin, ["file:///candidate/plugin.js"]);
  assert.equal(inline.agent["dog-operator"]!.permission.bash["*https://*"], "deny");
  assert.equal(inline.agent["dog-worker"]!.tools.webfetch, false);
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
  assert.equal((await readFile(output, "utf8")).trim().split("\n").length, 2);
  const replayManifest = JSON.parse(await readFile(result.replay.manifest.path, "utf8"));
  assert.equal(replayManifest.official_scoring_boundary, "external-official-docker-harness-after-patch-freeze");
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
      }, { readUsage: () => ({ usd: 0, requests: 0, unpriced: [] }) });
      assert.equal(result.reason, "watchdog-write-failed");
      assert.equal(result.cleanupEstablished, true);
      assert.match(result.command, /opencode run/u);
      assert.equal(result.exit, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

test("watchdog stops an idle live process after two intervals", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-watchdog-"));
  const bin = join(root, "bin");
  const watchdogPath = join(root, "watchdog.jsonl");
  await mkdir(bin, { recursive: true });
  const executable = join(bin, "opencode");
  await writeFile(executable, "#!/bin/sh\nsleep 30\n");
  await chmod(executable, 0o755);
  try {
    const result = await runOpenCode({
      workspace: root,
      instanceId: "idle",
      agent: "dog-operator",
      prompt: "idle",
      environment: { PATH: `${bin}:${process.env.PATH ?? ""}` },
      timeoutSeconds: 30,
      watchdogSeconds: 1,
      watchdogPath,
      startedAt: Date.now(),
    }, { readUsage: () => ({ usd: 0, requests: 0, unpriced: [] }) });
    assert.equal(result.reason, "watchdog-stale");
    assert.ok(result.watchdogEvents >= 2);
    assert.match(await readFile(watchdogPath, "utf8"), /"event":"heartbeat"/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
