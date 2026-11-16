import assert from "node:assert/strict";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { CONTRACT_TEXT_LIMITS } from "../dist/core/contract-limits.js";
import { decideValidationBudget, selectValidationScope, validationEvidenceKey, validationEvidenceState, validationResultFingerprint, type ValidationBudgetRequest } from "../dist/core/validation-budget.js";
import { managedTestCommand } from "../dist/plugin/managed-test-command.js";
import { copyManagedRouterFixture } from "./helpers/managed-router-fixture.ts";

test("managed test reachability resolves literal project scripts without claiming opaque commands", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(resolve("_testenv/managed-command-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: {
      all: "npm run unit", unit: "node --test", quick: "node --test example.test.mjs",
      cycle: "npm run cycle", release: "echo release && node --test", opaque: "node scripts/test-router.mjs full",
      protected: "node --test", preprotected: "node prepare.mjs", "test:windows": "node --test",
    } }));
    for (const [command, scope, runner] of [
      ["npm run all", "full", "node"], ["npm run quick", "focused", "node"],
      ["python3 -m pytest -q", "full", "pytest"], ["go test ./...", "full", "go"],
      ["cargo test --workspace", "full", "cargo"], ["vitest run", "full", "vitest"], ["jest", "full", "jest"],
      ["node --test example.test.mjs", "focused", "node"], ["pytest test_example.py -q", "focused", "pytest"],
    ]) {
      const resolved = await managedTestCommand(command!, root);
      assert.equal(resolved.scope, scope, command);
      assert.equal("runner" in resolved ? resolved.runner : undefined, runner, command);
    }
    const original = await managedTestCommand("npm run quick", root);
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { quick: "node --test another.test.mjs" } }));
    const changed = await managedTestCommand("npm run quick", root);
    assert.equal(original.scope, "focused"); assert.equal(changed.scope, "focused");
    assert.notEqual("identity" in original && original.identity, "identity" in changed && changed.identity,
      "the same script name does not retain an earlier definition's identity");
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: {
      cycle: "npm run cycle", release: "echo release && node --test", opaque: "node scripts/test-router.mjs full",
      protected: "node --test", preprotected: "node prepare.mjs", "test:windows": "node --test",
    } }));
    for (const command of ["npm run cycle", "npm run release", "npm run opaque", "npm run protected",
      "npm run missing", "npm run test:windows", "pytest test_example.py --collect-only", "node --test --unknown", "echo done && node --test"]) {
      assert.equal((await managedTestCommand(command, root)).scope, "unknown", command);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("managed project router uses actual sources, build configuration, cwd and selection", { skip: process.platform === "win32" }, async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(resolve("_testenv/managed-router-"));
  const project = process.cwd();
  const originalEnvironment = { HOME: process.env.HOME, npm_config_userconfig: process.env.npm_config_userconfig,
    npm_config_globalconfig: process.env.npm_config_globalconfig };
  try {
    process.env.HOME = join(root, "home");
    process.env.npm_config_userconfig = join(root, "home/.npmrc");
    process.env.npm_config_globalconfig = join(root, "global.npmrc");
    await mkdir(process.env.HOME, { recursive: true });
    const pkg = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
    const scripts = { ...pkg.scripts, whole: "npm run test:full" };
    await copyManagedRouterFixture(project, root);
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", scripts }));
    await writeFile(join(root, "test/check.test.ts"), "// project fixture\n");
    const full = await managedTestCommand("npm run whole", root);
    const focused = await managedTestCommand("npm run test:targeted -- test/check.test.ts", root);
    assert.equal(full.scope, "full"); assert.equal(focused.scope, "focused");
    assert.equal("runner" in full && full.runner, "node-project-router");
    assert.equal("suiteKey" in full && full.suiteKey, "suiteKey" in focused && focused.suiteKey);
    const projectScope = (await lstat(join(project, "node_modules"))).isSymbolicLink() ? "unknown" : "full";
    assert.equal((await managedTestCommand("npm run test:full", project)).scope, projectScope, "external dependency trees are not inspected project-local tooling");
    const realFocused = await managedTestCommand("npm run test:targeted -- test/validation-budget.test.ts", project);
    assert.equal(realFocused.scope, projectScope === "full" ? "focused" : "unknown", "real targeted script and file");
    await writeFile(join(root, "test/companion.test.ts"), "// companion fixture\n");
    for (const command of ["npm run test:targeted -- test/missing.test.ts", "npm run test:targeted -- test/check.test.js",
      "npm run test:targeted -- test/../test/check.test.ts", "npm run test:full -- test/check.test.ts", "npm run test:windows",
      "npm run test:targeted -- test/check.test.ts test/companion.test.ts"])
      assert.equal((await managedTestCommand(command, root)).scope, "unknown", command);
    for (const config of [process.env.npm_config_userconfig, process.env.npm_config_globalconfig]) {
      await writeFile(config, "script-shell=/custom/shell\n");
      assert.equal((await managedTestCommand("npm run whole", root)).scope, "unknown", "uninspected effective npm config remains native");
      await rm(config);
    }
    const shellOption = process.env["npm_config_script-shell"];
    try {
      process.env["npm_config_script-shell"] = "/custom/shell";
      assert.equal((await managedTestCommand("npm run whole", root)).scope, "unknown", "npm also accepts dashed option names in its environment");
    } finally {
      if (shellOption === undefined) delete process.env["npm_config_script-shell"]; else process.env["npm_config_script-shell"] = shellOption;
    }
    const compiler = join(root, "node_modules/typescript/bin/tsc"), originalCompiler = await readFile(compiler);
    await writeFile(compiler, "#!/bin/sh\nexit 0\n");
    assert.equal((await managedTestCommand("npm run whole", root)).scope, "unknown", "a local compiler wrapper is not the inspected CLI");
    await writeFile(compiler, originalCompiler);
    await writeFile(join(root, "scripts/test-router.mjs"), "// changed runner\n");
    assert.equal((await managedTestCommand("npm run whole", root)).scope, "unknown");
    await cp(join(project, "scripts/test-router.mjs"), join(root, "scripts/test-router.mjs"));
    await writeFile(join(root, "test/helpers/full-test-runner.ts"), "// changed selection\n");
    assert.equal((await managedTestCommand("npm run whole", root)).scope, "unknown");
    await cp(join(project, "test/helpers/full-test-runner.ts"), join(root, "test/helpers/full-test-runner.ts"));
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { ...scripts, prebuild: "node prepare.mjs" } }));
    assert.equal((await managedTestCommand("npm run whole", root)).scope, "unknown", "unknown build lifecycle remains runnable");
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { ...scripts, "pretest:full": "node prepare.mjs" } }));
    assert.equal((await managedTestCommand("npm run whole", root)).scope, "unknown");
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts }));
    await writeFile(join(root, ".npmrc"), "ignore-scripts=true\n");
    assert.equal((await managedTestCommand("npm run whole", root)).scope, "unknown");
    await rm(join(root, ".npmrc"));
    await rm(join(root, "test/check.test.ts"));
    await symlink(join(project, "test/validation-budget.test.ts"), join(root, "test/check.test.ts"));
    assert.equal((await managedTestCommand("npm run test:targeted -- test/check.test.ts", root)).scope, "unknown");
  } finally {
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

const request = (extra: Partial<ValidationBudgetRequest> = {}): ValidationBudgetRequest => ({
  run_id: "run", operation_id: "operation", source_snapshot: "base", candidate: "candidate",
  command: ["node", "check"], environment: { platform: "win32", arch: "x64", runtime: "node-22" },
  scope: "targeted", owner: "worker", expected_evidence: ["command", "source_snapshot"],
  marginal_value: { unmet_criteria: ["criterion"], risk_hypothesis: null }, reason: "preflight", ...extra,
});
const state = (consumed = 0, evidence_keys: string[] = [], prior_duration_ms?: number, blocked_evidence_keys: string[] = []) => ({
  limit: 1, consumed, evidence_keys, prior_duration_ms, blocked_evidence_keys,
});

test("typed invalid requests deny before execution", () => {
  assert.equal(decideValidationBudget({ ...request(), reason: "not-a-reason" }, state()).decision, "DENY");
  assert.equal(decideValidationBudget({ ...request(), expected_evidence: [] }, state()).reason, "invalid-contract");
});

test("validation commands use the shared command bound without widening identifier fields", () => {
  for (const length of [4097, CONTRACT_TEXT_LIMITS.command]) {
    const value = request({ command: ["x".repeat(length)] });
    assert.equal(decideValidationBudget(value, state()).decision, "ALLOW");
    const key = validationEvidenceKey(value);
    assert.equal(decideValidationBudget(value, state(1, [key])).decision, "SKIP");
    assert.equal(decideValidationBudget(value, state(1)).reason, "budget-exhausted");
  }
  for (const command of [[], [""], ["x".repeat(CONTRACT_TEXT_LIMITS.command + 1)], [null]]) {
    assert.equal(decideValidationBudget({ ...request(), command }, state()).reason, "invalid-contract");
  }
  assert.equal(decideValidationBudget(request({ operation_id: "x".repeat(4097) }), state()).reason, "invalid-contract");
});

test("same candidate, command, and environment dedupe while changed conditions do not", () => {
  const first = validationEvidenceKey(request());
  assert.equal(validationEvidenceKey({ ...request(), reason: "acceptance" }), first);
  assert.notEqual(validationEvidenceKey({ ...request(), candidate: "changed" }), first);
  assert.notEqual(validationEvidenceKey({ ...request(), command: ["node", "other-check"] }), first);
  assert.notEqual(validationEvidenceKey({ ...request(), environment: { ...request().environment, runtime: "node-23" } }), first);
  assert.equal(decideValidationBudget(request(), state(0, [first])).reason, "duplicate-evidence");
});

test("evidence identity includes actual owner and normalized scope provenance", () => {
  const workerTargeted = validationEvidenceKey(request());
  const workerStatic = validationEvidenceKey(request({ scope: "static" }));
  const coordinatorCanonical = validationEvidenceKey(request({ scope: "canonical", owner: "coordinator" }));
  const coordinatorLegacyFull = validationEvidenceKey(request({ scope: "full", owner: "coordinator" }));
  assert.notEqual(workerTargeted, workerStatic);
  assert.notEqual(workerTargeted, coordinatorCanonical);
  assert.equal(coordinatorCanonical, coordinatorLegacyFull);
  assert.equal(decideValidationBudget(request({ scope: "canonical", owner: "coordinator" }), state(0, [workerTargeted])).decision, "ALLOW");
});

test("request identity does not affect deduplication, but candidate content does", () => {
  const renamed = { ...request(), run_id: "renamed-run", operation_id: "renamed-operation" };
  const first = validationEvidenceKey(request());
  assert.equal(validationEvidenceKey(renamed), first);
  assert.equal(decideValidationBudget(renamed, state(0, [first])).reason, "duplicate-evidence");
  const changed = { ...renamed, candidate: "actual-content-changed" };
  assert.equal(decideValidationBudget(changed, state(0, [first])).decision, "ALLOW");
});

test("mandatory correction executions count separately while ordinary duplicate validation still skips", () => {
  const first = request({ required_execution: { admission: "correction-task", call_id: "native-first" } });
  const key = validationEvidenceKey(first);
  const next = request({ required_execution: { admission: "correction-task", call_id: "native-second" } });
  assert.notEqual(validationEvidenceKey(next), key);
  assert.equal(decideValidationBudget(next, { ...state(1, [key]), limit: 2 }).decision, "ALLOW");
  assert.equal(decideValidationBudget(first, { ...state(1, [key]), limit: 2 }).decision, "SKIP", "same native execution remains idempotent");
  assert.equal(decideValidationBudget({ ...first, required_execution: { admission: "", call_id: "x" } }, state()).decision, "DENY");
  const ordinary = request();
  assert.equal(decideValidationBudget(ordinary, state(1, [validationEvidenceKey(ordinary)])).decision, "SKIP");
});

test("retry requires a bounded cause and consumes one reservation", () => {
  assert.equal(decideValidationBudget({ ...request(), reason: "retry" }, state()).reason, "retry-justification-required");
  const result = decideValidationBudget({ ...request(), reason: "retry", retry_of: "prior", changed_cause: "source changed" }, state());
  assert.deepEqual({ decision: result.decision, consumed: result.consumed }, { decision: "ALLOW", consumed: 1 });
});

test("exhausted budget denies without selecting a smaller scope", () => {
  const result = decideValidationBudget({ ...request(), scope: "full-suite", owner: "coordinator" }, state(1));
  assert.deepEqual({ decision: result.decision, reason: result.reason, scope: result.scope }, { decision: "DENY", reason: "budget-exhausted", scope: "full-suite" });
});

test("validation scope changes preserve the declared high-risk review evidence", () => {
  const expectedEvidence = ["command", "source_snapshot", "independent-review"];
  for (const [scope, owner] of [["targeted", "worker"], ["full-suite", "coordinator"]] as const) {
    const validation = { ...request(), scope, owner, expected_evidence: expectedEvidence };
    const result = decideValidationBudget(validation, state());
    assert.equal(result.decision, "ALLOW");
    assert.deepEqual(validation.expected_evidence, expectedEvidence);
    assert.ok(validation.expected_evidence.includes("independent-review"));
  }
});

test("profile ladder and ownership escalation are deterministic", () => {
  assert.equal(selectValidationScope({ profile: "fast", canonical: false, release: false, explicit_risk: false }), "static");
  assert.equal(selectValidationScope({ profile: "balanced", canonical: false, release: false, explicit_risk: false }), "targeted");
  assert.equal(selectValidationScope({ profile: "assurance", canonical: false, release: false, explicit_risk: false }), "related");
  assert.equal(selectValidationScope({ profile: "fast", canonical: true, release: false, explicit_risk: false }), "canonical");
  assert.equal(selectValidationScope({ profile: "balanced", canonical: false, release: true, explicit_risk: false }), "full-suite");
  assert.equal(selectValidationScope({ profile: "balanced", canonical: false, release: false, explicit_risk: true }), "full-suite");
  assert.equal(decideValidationBudget({ ...request(), scope: "canonical", owner: "worker" }, state()).reason, "owner-mismatch");
});

test("duplicate skip preserves budget and reports prior duration; settlement fingerprint is stable", () => {
  const first = request();
  const key = validationEvidenceKey(first);
  const result = decideValidationBudget(first, state(1, [key], 125));
  assert.deepEqual({ decision: result.decision, consumed: result.consumed, redundant_time_ms: result.redundant_time_ms },
    { decision: "SKIP", consumed: 1, redundant_time_ms: 125 });
  assert.notEqual(validationResultFingerprint(first, "passed", 0), validationResultFingerprint(first, "failed", 1));
});

test("blocked evidence denies instead of producing a false skip", () => {
  const key = validationEvidenceKey(request());
  for (const blocked of [key]) {
    const result = decideValidationBudget(request(), state(0, [], undefined, [blocked]));
    assert.deepEqual({ decision: result.decision, reason: result.reason, consumed: result.consumed },
      { decision: "DENY", reason: "duplicate-evidence", consumed: 0 });
  }
});

test("nonzero failures can consume a fresh attempt, while active and unsettled outcomes remain blocked", () => {
  const key = validationEvidenceKey(request());
  const admission = { kind: "validation.admission", decision: "ALLOW", reservation_id: "first", evidence_key: key };
  const failure = { kind: "validation.settled", reservation_id: "first", evidence_key: key, outcome: "failed", exit_code: 1 };
  const evidence = validationEvidenceState([admission, failure]);
  assert.deepEqual(evidence, { reusable: [], blocked: [] });
  const budget = { limit: 2, consumed: 1, evidence_keys: evidence.reusable, blocked_evidence_keys: evidence.blocked };
  assert.deepEqual(decideValidationBudget(request(), budget), {
    decision: "ALLOW", reason: "allowed", scope: "targeted", evidence_key: key, consumed: 2, redundant_time_ms: 0,
  });
  assert.equal(decideValidationBudget(request(), { ...budget, limit: 1 }).reason, "budget-exhausted");
  const retry = { ...admission, reservation_id: "second" };
  assert.deepEqual(validationEvidenceState([admission, failure, retry]), { reusable: [], blocked: [key] });
  assert.deepEqual(validationEvidenceState([admission, failure, retry, { ...failure, reservation_id: "second", outcome: "passed", exit_code: 0 }]),
    { reusable: [key], blocked: [] });
  for (const [outcome, exit_code] of [["failed", 0], ["failed", null], ["timeout", 124], ["interrupted", 130], ["cancelled", null]]) {
    assert.deepEqual(validationEvidenceState([admission, { ...failure, outcome, exit_code }]), { reusable: [], blocked: [key] });
  }
});

test("passed evidence is reusable only with exit code zero", () => {
  const key = validationEvidenceKey(request());
  const evidence = validationEvidenceState([
    { kind: "validation.admission", decision: "ALLOW", reservation_id: "reservation", evidence_key: key },
    { kind: "validation.settled", reservation_id: "reservation", evidence_key: key, outcome: "passed", exit_code: 9 },
  ]);
  assert.deepEqual(evidence, { reusable: [], blocked: [key] });
});

test("marginal value and retry justification fail closed", () => {
  assert.equal(decideValidationBudget({ ...request(), marginal_value: { unmet_criteria: [], risk_hypothesis: null } }, state()).reason, "marginal-value-required");
  assert.equal(decideValidationBudget({ ...request(), reason: "retry", retry_of: "prior" }, state()).reason, "retry-justification-required");
});
