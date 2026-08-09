import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runtimeAssets } from "../dist/runtime-assets.js";
import { ModelRoutingDeniedError, SortieDogsPlugin, isExplicitTaskHandoff } from "../dist/plugin/index.js";
import {
  resolvePluginConfiguration,
  resolvePluginConfigurationSources,
  resolvePluginConfigurationSourcesWithGlobal,
} from "../dist/plugin/config.js";
import {
  CONSULTATION_FALLBACK_VARIANT,
  DEFAULT_COORDINATOR_MODEL,
  DEFAULT_COORDINATOR_VARIANT,
  DEDICATED_WORKER_MODEL,
  DEDICATED_WORKER_VARIANT,
  DEDICATED_WORKER_ROLES,
  DEFAULT_FREE_TIER_FALLBACK_MODELS,
  ESCALATION_WORKER_MODEL,
  ESCALATION_WORKER_VARIANT,
  RECOMMENDED_SCOUT_VARIANT,
  RECOMMENDED_CONSULTATION_MODEL,
  RECOMMENDED_CONSULTATION_ROLES,
  parseModelRoutingConfig,
  resolveModelRoute,
} from "../dist/plugin/model-routing.js";
import {
  CONSULTATION_FALLBACK_RETRY_MARKER,
  lastAssistantText,
} from "../dist/plugin/task-result-repair.js";
import { ReflectionStore } from "../dist/reflection/index.js";
import { configRoot } from "../dist/reflection/config.js";
import {
  CONTINUATION_CAPABILITY,
  CONTINUATION_MARKER,
  ROLLOVER_MARKER,
} from "../dist/plugin/continuation.js";
import { validateManifest } from "../dist/core/validate-manifest.js";
import {
  validateHandoffSchema,
  validateOperationManifestSchema,
} from "../dist/core/validate-schema.js";
import {
  CONSULTATION_ROLE_POLICY,
  SOURCE_REVIEW_RISK_TAGS,
  evaluateReviewAvailability,
  evaluateReviewGate,
  evaluateSourceReviewRequirement,
  requiresSourceReview,
  shouldConsultStrategy,
  validateReviewArtifact,
  validateReviewVerdict,
  type ConsultationAdapter,
  type ConsultationRequest,
  type ConsultationResult,
  type ReviewArtifact,
  type ReviewVerdict,
} from "../dist/core/consultation.js";

/*
 * Environment and global-file layers are real configuration sources, so machine settings would
 * silently change every packaged default this suite asserts. Tests observe the package, not the machine.
 */
delete process.env.SORTIE_DOGS_CONFIG;

interface PluginCase {
  name: string;
  target?: string;
  error?: string;
}

interface PluginFixture {
  manifest: Record<string, unknown>;
  handoffs: {
    valid: Record<string, unknown>;
    invalid: Record<string, unknown>;
  };
  invalidManifestJson: string;
  shell: {
    readOnly: string[];
    unknownWrites: string[];
  };
  cases: PluginCase[];
}

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/plugin-cases.json", import.meta.url), "utf8"),
) as PluginFixture;
const cases = new Map(fixture.cases.map((candidate) => [candidate.name, candidate]));
const testEnvironment = fileURLToPath(new URL("../_testenv/", import.meta.url));
process.env.XDG_CONFIG_HOME = join(testEnvironment, "plugin-default-xdg");
assert.equal(configRoot(), join(testEnvironment, "plugin-default-xdg", "opencode"));
const execFileAsync = promisify(execFile);

test("model routing configuration is strict and merges roles by layer", () => {
  const project = {
    reviewer: { preferred: { model: "vendor-a/review", variant: "deep" } },
  };
  const host = {
    implementer: {
      preferred: { model: "provider/primary" },
      fallback: [{ model: "provider/free" }],
    },
  };
  const parsed = resolvePluginConfiguration(
    {
      modelRouting: project,
      modelCatalog: { global: [{ model: "provider/primary" }] },
      freeTierFallbackModels: ["project/free"],
    },
    { modelRouting: host, freeTierFallbackModels: ["host/free"] },
  );
  assert.equal(parsed.kind, "configured");
  if (parsed.kind === "configured") {
    assert.deepEqual(parsed.modelRouting.reviewer, project.reviewer);
    assert.deepEqual(parsed.modelRouting.implementer, host.implementer);
    assert.deepEqual(parsed.freeTierFallbackModels, ["host/free"]);
    for (const role of DEDICATED_WORKER_ROLES) {
      assert.deepEqual(parsed.modelRouting[role], {
        preferred: { model: DEDICATED_WORKER_MODEL, variant: DEDICATED_WORKER_VARIANT },
      });
    }
  }
  assert.equal(parseModelRoutingConfig({ reviewer: { preferred: { model: "x", extra: true } } }), undefined);
  assert.deepEqual(
    parseModelRoutingConfig({ reviewer: { model: "vendor-b/review", variant: "careful" } })?.reviewer,
    { preferred: { model: "vendor-b/review", variant: "careful" } },
  );
  assert.equal(parseModelRoutingConfig({ reviewer: { model: "x", fallback: [] } }), undefined);
  assert.deepEqual(resolvePluginConfiguration({ unknown: true }), { kind: "invalid" });
  const reflectionDefaults = resolvePluginConfiguration();
  assert.equal(reflectionDefaults.kind, "configured");
  if (reflectionDefaults.kind === "configured") {
    assert.deepEqual(reflectionDefaults.reflection, { enabled: false, layers: { run: true, project: true, global: false }, maxInjectedEntries: 3, maxInjectedTokens: 500 });
  }
  assert.equal(resolvePluginConfiguration({ reflection: { enabled: "yes" } }).kind, "invalid");
  assert.equal(resolvePluginConfiguration({ reflection: { maxInjectedEntries: 4 } }).kind, "invalid");
  assert.equal(resolvePluginConfiguration({ reflection: { maxInjectedTokens: 501 } }).kind, "invalid");
  assert.equal(resolvePluginConfiguration({ reflection: { layers: { unknown: true } } }).kind, "invalid");
  const partialReflection = resolvePluginConfiguration({ reflection: { layers: { global: true }, maxInjectedTokens: 100 } });
  assert.equal(partialReflection.kind, "configured");
  if (partialReflection.kind === "configured") assert.deepEqual(partialReflection.reflection.layers, { run: true, project: true, global: true });
  const globalSources = resolvePluginConfigurationSourcesWithGlobal(
    { reflection: { enabled: true, maxInjectedEntries: 1, layers: { global: true } } },
    { reflection: { maxInjectedEntries: 2 } },
    { reflection: { maxInjectedTokens: 100 } },
    { reflection: { layers: { global: false } } },
  );
  assert.equal(globalSources.kind, "configured");
  if (globalSources.kind === "configured") {
    assert.deepEqual(globalSources.reflection, {
      enabled: true,
      layers: { run: true, project: true, global: false },
      maxInjectedEntries: 2,
      maxInjectedTokens: 100,
    });
  }
  assert.deepEqual(resolvePluginConfiguration({ freeTierFallbackModels: [""] }), { kind: "invalid" });
  for (const invalidModel of ["provider", "/model", "provider/", "provider /model"]) {
    assert.deepEqual(resolvePluginConfiguration({ freeTierFallbackModels: [invalidModel] }), { kind: "invalid" });
  }
  const disabled = resolvePluginConfiguration({ freeTierFallbackModels: [] });
  assert.equal(disabled.kind, "configured");
  if (disabled.kind === "configured") assert.deepEqual(disabled.freeTierFallbackModels, []);
  assert.deepEqual(DEFAULT_FREE_TIER_FALLBACK_MODELS, ["opencode/deepseek-v4-flash-free"]);
  assert.deepEqual(resolvePluginConfiguration({
    modelRouting: host,
    modelCatalog: { global: [{ model: "" }] },
  }), { kind: "invalid" });
  const fixed = resolvePluginConfiguration({
    modelRouting: { implementation: { model: "attempted/override" } },
  });
  assert.equal(fixed.kind, "configured");
  if (fixed.kind === "configured") {
    assert.deepEqual(fixed.modelRouting.implementation, {
      preferred: { model: DEDICATED_WORKER_MODEL, variant: DEDICATED_WORKER_VARIANT },
    });
  }
});

test("a host may declare which single model every dedicated worker role resolves to", () => {
  const target = { model: "vendor-host/worker", variant: "deep" };
  const configured = resolvePluginConfigurationSources(
    { dedicatedWorkerModel: target },
    undefined,
    undefined,
  );
  assert.equal(configured.kind, "configured");
  if (configured.kind !== "configured") return;
  for (const role of DEDICATED_WORKER_ROLES) {
    assert.deepEqual(configured.modelRouting[role], { preferred: target }, `${role} follows the declared target`);
    assert.deepEqual(resolveModelRoute({
      role,
      local: configured.localModelRouting,
      global: configured.globalModelRouting,
      catalog: configured.modelCatalog,
      dedicated: configured.dedicatedWorkerModel,
    }), {
      ok: true,
      role,
      source: "fixed",
      catalog: "global",
      model: target.model,
      variant: target.variant,
    }, `${role} resolves against the declared target`);
  }
  // Declaring a role route directly still cannot displace the dedicated worker policy.
  const attempted = resolvePluginConfiguration({
    dedicatedWorkerModel: target,
    modelRouting: { "dog-worker": { model: "attempted/override" } },
  });
  assert.equal(attempted.kind, "configured");
  if (attempted.kind === "configured") {
    assert.deepEqual(attempted.modelRouting["dog-worker"], { preferred: target });
  }
  assert.deepEqual(resolvePluginConfiguration({ dedicatedWorkerModel: { model: "" } }), { kind: "invalid" });
  assert.deepEqual(
    resolvePluginConfiguration({ dedicatedWorkerModel: { model: "vendor/worker", unknown: true } }),
    { kind: "invalid" },
  );
});

test("model routing rejects prototype-sensitive JSON role names", () => {
  const routing = JSON.parse('{"__proto__":{"preferred":{"model":"provider/model"}}}') as unknown;
  assert.equal(parseModelRoutingConfig(routing), undefined);
});

test("model resolver preserves valid variants and prioritizes preferred, local, and project catalog", () => {
  const resolution = resolveModelRoute({
    role: "reviewer",
    local: {
      reviewer: {
        preferred: { model: "vendor-a/review", variant: "deep" },
        fallback: [{ model: "provider/free" }],
      },
    },
    global: { reviewer: { preferred: { model: "provider/global" } } },
    catalog: {
      project: [{ model: "vendor-a/review", variants: ["deep"] }],
      global: [
        { model: "vendor-a/review", variants: ["deep"] },
        { model: "provider/free" },
        { model: "provider/global" },
      ],
    },
  });
  assert.deepEqual(resolution, {
    ok: true,
    role: "reviewer",
    source: "local",
    catalog: "project",
    model: "vendor-a/review",
    variant: "deep",
  });
});

test("model resolver falls back in order and returns structured unresolved failures", () => {
  const route = {
    reviewer: {
      preferred: { model: "vendor-a/review", variant: "missing" },
      fallback: [{ model: "provider/free" }],
    },
  };
  assert.deepEqual(resolveModelRoute({
    role: "reviewer",
    local: route,
    catalog: { global: [{ model: "vendor-a/review", variants: ["valid"] }, { model: "provider/free" }] },
  }), {
    ok: true,
    role: "reviewer",
    source: "local",
    catalog: "global",
    model: "provider/free",
  });

  assert.deepEqual(resolveModelRoute({
    role: "unknown",
    local: route,
    catalog: { global: [{ model: "provider/free" }] },
  }), {
    ok: false,
    role: "unknown",
    reason: "unresolved-role",
    attempts: [],
  });

  for (const role of ["constructor", "toString", "valueOf"]) {
    assert.deepEqual(resolveModelRoute({ role, local: {}, global: {}, catalog: {} }), {
      ok: false,
      role,
      reason: "unresolved-role",
      attempts: [],
    });
  }
});

test("recommended coordinator and Luna routes cover exact installed roles and remain overridable", () => {
  const defaults = resolvePluginConfigurationSources(undefined, undefined, {
    modelCatalog: { global: [
      { model: "openai/gpt-5.6-luna", variants: ["xhigh"] },
      { model: "provider/custom" },
    ] },
  });
  assert.equal(defaults.kind, "configured");
  if (defaults.kind !== "configured") return;
  // The host declared another variant of the shipped worker model, so it joins that catalog entry.
  assert.deepEqual(defaults.modelCatalog.global, [
    { model: DEFAULT_COORDINATOR_MODEL, variants: [DEFAULT_COORDINATOR_VARIANT] },
    {
      model: DEDICATED_WORKER_MODEL,
      variants: [DEDICATED_WORKER_VARIANT, RECOMMENDED_SCOUT_VARIANT, "xhigh"]
        .filter((variant, index, all) => all.indexOf(variant) === index),
    },
    { model: ESCALATION_WORKER_MODEL, variants: [ESCALATION_WORKER_VARIANT, CONSULTATION_FALLBACK_VARIANT] },
    { model: "provider/custom" },
  ]);
  assert.deepEqual(defaults.modelRouting["dog-coordinator"], {
    preferred: { model: DEFAULT_COORDINATOR_MODEL, variant: DEFAULT_COORDINATOR_VARIANT },
  });
  assert.deepEqual(resolveModelRoute({
    role: "dog-coordinator",
    local: defaults.localModelRouting,
    global: defaults.globalModelRouting,
    catalog: defaults.modelCatalog,
  }), {
    ok: true,
    role: "dog-coordinator",
    source: "global",
    catalog: "global",
    model: DEFAULT_COORDINATOR_MODEL,
    variant: DEFAULT_COORDINATOR_VARIANT,
  });
  const lunaRoleVariants = {
    "dog-scout": RECOMMENDED_SCOUT_VARIANT,
  };
  assert.deepEqual(Object.keys(lunaRoleVariants).map((role) => ({
    configured: defaults.modelRouting[role],
    resolved: resolveModelRoute({
      role,
      local: defaults.localModelRouting,
      global: defaults.globalModelRouting,
      catalog: defaults.modelCatalog,
    }),
  })), Object.entries(lunaRoleVariants).map(([role, variant]) => ({
    configured: { preferred: { model: DEDICATED_WORKER_MODEL, variant } },
    resolved: {
      ok: true,
      role,
      source: "global",
      catalog: "global",
      model: DEDICATED_WORKER_MODEL,
      variant,
    },
  })));

  const projectModel = "provider/project-coordinator";
  const overridden = resolvePluginConfigurationSources({
    modelRouting: { "dog-coordinator": { preferred: { model: projectModel } } },
    modelCatalog: { project: [{ model: projectModel }] },
  }, undefined, undefined);
  assert.equal(overridden.kind, "configured");
  if (overridden.kind !== "configured") return;
  assert.deepEqual(resolveModelRoute({
    role: "dog-coordinator",
    local: overridden.localModelRouting,
    global: overridden.globalModelRouting,
    catalog: overridden.modelCatalog,
  }), {
    ok: true,
    role: "dog-coordinator",
    source: "local",
    catalog: "project",
    model: projectModel,
  });
});

test("consultation never inherits the caller model and stays host-configurable", () => {
  assert.deepEqual([...RECOMMENDED_CONSULTATION_ROLES].sort(), ["dog-advisor", "dog-reviewer"]);
  const resolveFor = (sources, role) => resolveModelRoute({
    role,
    local: sources.localModelRouting,
    global: sources.globalModelRouting,
    catalog: sources.modelCatalog,
  });

  // Without a declared preferred model the route still resolves, never to the Luna caller model.
  const defaults = resolvePluginConfigurationSources(undefined, undefined, undefined);
  assert.equal(defaults.kind, "configured");
  if (defaults.kind !== "configured") return;

  const declared = resolvePluginConfigurationSources(undefined, undefined, {
    modelCatalog: { global: [{ model: RECOMMENDED_CONSULTATION_MODEL }] },
  });
  assert.equal(declared.kind, "configured");
  if (declared.kind !== "configured") return;

  // A host that redeclares the dedicated target cannot reduce the consultation fallback effort.
  const relocated = resolvePluginConfigurationSources(undefined, undefined, {
    dedicatedWorkerModel: { model: "provider/host-worker", variant: "deep" },
  });
  assert.equal(relocated.kind, "configured");
  if (relocated.kind !== "configured") return;

  /*
   * Review has to be able to reject what the worker produced, so the fallback stays on the stronger
   * model rather than matching the cheap worker target the cost curve selected.
   */
  assert.notEqual(ESCALATION_WORKER_MODEL, DEDICATED_WORKER_MODEL);

  for (const role of RECOMMENDED_CONSULTATION_ROLES) {
    assert.deepEqual(resolveFor(defaults, role), {
      ok: true,
      role,
      source: "global",
      catalog: "global",
      model: ESCALATION_WORKER_MODEL,
      variant: CONSULTATION_FALLBACK_VARIANT,
    });
    assert.deepEqual(resolveFor(declared, role), {
      ok: true,
      role,
      source: "global",
      catalog: "global",
      model: RECOMMENDED_CONSULTATION_MODEL,
    });
    assert.deepEqual(resolveFor(relocated, role), {
      ok: true,
      role,
      source: "global",
      catalog: "global",
      model: ESCALATION_WORKER_MODEL,
      variant: CONSULTATION_FALLBACK_VARIANT,
    });

    // Any host may assign its own model to a consultation role.
    const projectModel = `provider/project-${role}`;
    const overridden = resolvePluginConfigurationSources({
      modelRouting: { [role]: { preferred: { model: projectModel } } },
      modelCatalog: { project: [{ model: projectModel }] },
    }, undefined, undefined);
    assert.equal(overridden.kind, "configured");
    if (overridden.kind !== "configured") return;
    assert.deepEqual(resolveFor(overridden, role), {
      ok: true,
      role,
      source: "local",
      catalog: "project",
      model: projectModel,
    });
  }
});

test("MkII worker routes stay fixed while consultation roles remain host configurable", () => {
  const canonicalModel = "provider/canonical";
  const configured = resolvePluginConfigurationSources(
    { modelRouting: {
      implementation: { preferred: { model: canonicalModel } },
      "dog-worker": { preferred: { model: canonicalModel } },
      "dog-advisor": { preferred: { model: "vendor-a/advice" } },
    } },
    { modelRouting: {
      remediation: { preferred: { model: canonicalModel } },
      "dog-worker": { preferred: { model: canonicalModel } },
      "dog-reviewer": { preferred: { model: "vendor-b/review" } },
    } },
    {
      modelRouting: {
        "blocker-resolution": { preferred: { model: canonicalModel } },
        "dog-worker": { preferred: { model: canonicalModel } },
        "dog-reviewer": { preferred: { model: "vendor-c/review" } },
      },
      modelCatalog: { global: [
        { model: canonicalModel },
        { model: "vendor-a/advice" },
        { model: "vendor-b/review" },
        { model: "vendor-c/review" },
      ] },
    },
  );
  assert.equal(configured.kind, "configured");
  if (configured.kind !== "configured") return;

  assert.deepEqual([...DEDICATED_WORKER_ROLES], [
    "implementation",
    "remediation",
    "blocker-resolution",
    "sol-worker-mk2a2",
    "dog-worker",
  ]);

  const resolveRole = (role: string) => resolveModelRoute({
    role,
    local: configured.localModelRouting,
    global: configured.globalModelRouting,
    catalog: configured.modelCatalog,
  });
  for (const role of DEDICATED_WORKER_ROLES) {
    const expected = {
      ok: true,
      role,
      source: "fixed",
      catalog: "global",
      model: DEDICATED_WORKER_MODEL,
      variant: DEDICATED_WORKER_VARIANT,
    };
    assert.deepEqual(configured.modelRouting[role], {
      preferred: { model: DEDICATED_WORKER_MODEL, variant: DEDICATED_WORKER_VARIANT },
    }, `${role} public route must remain authoritative`);
    assert.deepEqual(resolveRole(role), expected);
    assert.deepEqual(resolveModelRoute({
      role,
      local: {
        [role]: {
          preferred: { model: canonicalModel },
          fallback: [{ model: "vendor-a/advice" }],
        },
      },
      global: {
        [role]: {
          preferred: { model: "vendor-b/review" },
          fallback: [{ model: "vendor-c/review" }],
        },
      },
      catalog: configured.modelCatalog,
    }), expected, `${role} must reject direct override and fallback injection`);
    assert.deepEqual(resolveModelRoute({
      role,
      local: { ...configured.localModelRouting },
      global: { ...configured.globalModelRouting },
      catalog: {
        project: configured.modelCatalog.project === undefined
          ? undefined
          : [...configured.modelCatalog.project],
        global: configured.modelCatalog.global === undefined
          ? undefined
          : [...configured.modelCatalog.global],
      },
    }), expected, `${role} resume route must remain stable for equivalent fresh input`);
  }
  assert.deepEqual(resolveRole("dog-advisor"), {
    ok: true,
    role: "dog-advisor",
    source: "local",
    catalog: "global",
    model: "vendor-a/advice",
  });
  assert.deepEqual(resolveRole("dog-reviewer"), {
    ok: true,
    role: "dog-reviewer",
    source: "global",
    catalog: "global",
    model: "vendor-c/review",
  });
  for (const role of ["coordinator", "planning", "reviewer", "scout", "unknown"]) {
    assert.deepEqual(resolveRole(role), {
      ok: false,
      role,
      reason: "unresolved-role",
      attempts: [],
    });
  }

  const missingSol = {
    ...configured,
    modelCatalog: { global: [{ model: canonicalModel }] },
  };
  for (const role of DEDICATED_WORKER_ROLES) {
    assert.deepEqual(resolveModelRoute({
      role,
      local: missingSol.localModelRouting,
      global: missingSol.globalModelRouting,
      catalog: missingSol.modelCatalog,
    }), {
      ok: false,
      role,
      reason: "unresolved-role",
      attempts: [{
        source: "fixed",
        target: { model: DEDICATED_WORKER_MODEL, variant: DEDICATED_WORKER_VARIANT },
        reason: "model-unavailable",
      }],
    });
  }
});

test("consultation policy parses strictly and deep-merges defaults through host precedence", () => {
  const projectConsultation = {
    strategy: { agent: CONSULTATION_ROLE_POLICY.strategy },
    sourceReview: { maxArtifactBytes: 20_000 },
  };
  const configured = resolvePluginConfiguration(
    {
      handoffPaths: ["project.json"],
      consultation: projectConsultation,
    },
    {
      consultation: {
        strategy: { required: true },
        sourceReview: { agent: CONSULTATION_ROLE_POLICY.sourceReview },
      },
    },
    {
      handoffPaths: ["host.json"],
      consultation: { strategy: { maxCallsPerCandidate: 2 } },
    },
  );
  assert.equal(configured.kind, "configured");
  if (configured.kind !== "configured") return;
  assert.deepEqual(configured.handoffPaths, ["host.json"]);
  assert.deepEqual(configured.consultation, {
    strategy: { agent: CONSULTATION_ROLE_POLICY.strategy, required: true, maxCallsPerCandidate: 2 },
    sourceReview: {
      agent: CONSULTATION_ROLE_POLICY.sourceReview,
      requiredPolicy: "risk-based",
      unavailable: "block-required-only",
      maxCallsPerCandidate: 1,
      maxArtifactBytes: 20_000,
    },
  });
  projectConsultation.strategy.agent = "mutated-after-resolution";
  projectConsultation.sourceReview.maxArtifactBytes = 1;
  assert.equal(configured.consultation.strategy.agent, CONSULTATION_ROLE_POLICY.strategy);
  assert.equal(configured.consultation.sourceReview.maxArtifactBytes, 20_000);
  assert.equal(Object.isFrozen(configured.consultation.strategy), true);
  assert.equal(Object.isFrozen(configured.consultation.sourceReview), true);
  for (const consultation of [
    { strategy: { maxCallsPerCandidate: 0 } },
    { sourceReview: { maxArtifactBytes: 30_721 } },
    { sourceReview: { requiredPolicy: "always" } },
    { sourceReview: { command: "external-tool" } },
    { strategy: { agent: "alternate-advisor" } },
    { sourceReview: { agent: "alternate-reviewer" } },
  ]) {
    assert.deepEqual(resolvePluginConfiguration({ consultation }), { kind: "invalid" });
  }
});

test("Strategy trigger is decision-based, excludes routine/resume work, and permits at most one call", () => {
  const base = {
    candidateId: "candidate-1",
    trigger: "architecture-choice" as const,
    callsForCandidate: 0,
  };
  assert.equal(shouldConsultStrategy(base), true);
  assert.equal(shouldConsultStrategy({ ...base, callsForCandidate: 1 }), false);
  assert.equal(shouldConsultStrategy({ ...base, decisionAlreadyRecorded: true }), false);
  assert.equal(shouldConsultStrategy({ ...base, mechanicalChange: true }), false);
  assert.equal(shouldConsultStrategy({ ...base, sameTaskResume: true }), false);
  assert.equal(shouldConsultStrategy({ ...base, trigger: undefined }), false);
});

test("SourceReview risk matrix is fixed and review is gated after validation and before staging", () => {
  assert.equal(SOURCE_REVIEW_RISK_TAGS.length, 14);
  for (const riskTag of SOURCE_REVIEW_RISK_TAGS) {
    assert.equal(requiresSourceReview([riskTag]), true, riskTag);
    assert.equal(evaluateSourceReviewRequirement({
      riskTags: [riskTag],
      canonicalValidationExit: 0,
      stagingStarted: false,
    }), "REVIEW_REQUIRED", riskTag);
  }
  assert.equal(evaluateSourceReviewRequirement({
    riskTags: [],
    canonicalValidationExit: 0,
    stagingStarted: false,
  }), "SKIP_LOW_RISK");
  assert.equal(evaluateSourceReviewRequirement({
    riskTags: ["security"],
    canonicalValidationExit: 1,
    stagingStarted: false,
  }), "WAIT_CANONICAL_VALIDATION");
  assert.equal(evaluateSourceReviewRequirement({
    riskTags: ["security"],
    canonicalValidationExit: 0,
    stagingStarted: true,
  }), "REVIEW_TOO_LATE");
  assert.equal(evaluateSourceReviewRequirement({
    riskTags: ["not-a-risk-tag"],
    canonicalValidationExit: 0,
    stagingStarted: false,
  }), "RISK_TAGS_INVALID");
  assert.equal(evaluateSourceReviewRequirement({
    riskTags: "security",
    canonicalValidationExit: 0,
    stagingStarted: false,
  }), "RISK_TAGS_INVALID");
  assert.deepEqual(evaluateReviewAvailability(true, false), { ok: false, code: "REVIEW_UNAVAILABLE" });
  assert.deepEqual(evaluateReviewAvailability(false, false), { ok: true });
});

function reviewArtifact(overrides: Partial<ReviewArtifact> = {}): ReviewArtifact {
  return {
    schemaVersion: 1,
    candidateId: "candidate-1",
    sourceFingerprint: "source-v1",
    acceptance: ["preserve behavior"],
    changedLogicSummary: ["consultation.ts: validate the strict review artifact schema before dispatch"],
    manifest: ["src/core/consultation.ts"],
    riskTags: ["public-api"],
    riskBearingHunks: ["src/core/consultation.ts:1-20"],
    validation: { command: "package test", exit: 0, fingerprint: "validation-v1" },
    invariants: ["provider-neutral"],
    ...overrides,
  };
}

function reviewVerdict(
  verdict: ReviewVerdict["verdict"] = "PASS",
  sourceFingerprint = "source-v1",
): ReviewVerdict {
  return {
    verdict,
    sourceFingerprint,
    findings: verdict === "PASS" ? [] : [{
      severity: "major",
      path: "src/core/consultation.ts",
      evidence: "A material issue remains",
      requiredFix: "Preserve the review boundary",
    }],
  };
}

test("review artifact and verdict validators reject extra, raw, oversized, and invalid evidence", () => {
  assert.equal(validateReviewArtifact(reviewArtifact()).ok, true);
  assert.deepEqual(validateReviewArtifact({ ...reviewArtifact(), raw: "opaque" }), {
    ok: false,
    code: "ARTIFACT_SCHEMA_INVALID",
  });
  assert.deepEqual(validateReviewArtifact(reviewArtifact({
    acceptance: ["x".repeat(31_000)],
  })), { ok: false, code: "ARTIFACT_TOO_LARGE" });
  assert.deepEqual(validateReviewArtifact({
    ...reviewArtifact(),
    validation: { command: "package test", exit: 1, fingerprint: "validation-v1" },
  }), { ok: false, code: "ARTIFACT_SCHEMA_INVALID" });
  assert.deepEqual(validateReviewArtifact({
    ...reviewArtifact(),
    validation: { command: "package test", exit: 0, fingerprint: "" },
  }), { ok: false, code: "ARTIFACT_SCHEMA_INVALID" });
  const { changedLogicSummary: omittedChangedLogicSummary, ...withoutChangedLogicSummary } = reviewArtifact();
  const { riskBearingHunks: omittedRiskHunks, ...withoutRiskHunks } = reviewArtifact();
  const { invariants: omittedInvariants, ...withoutInvariants } = reviewArtifact();
  assert.ok(omittedChangedLogicSummary.length > 0 && omittedRiskHunks.length > 0 && omittedInvariants.length > 0);
  assert.deepEqual(validateReviewArtifact(withoutChangedLogicSummary), {
    ok: false,
    code: "ARTIFACT_SCHEMA_INVALID",
  });
  assert.deepEqual(validateReviewArtifact(reviewArtifact({ changedLogicSummary: [] })), {
    ok: false,
    code: "ARTIFACT_SCHEMA_INVALID",
  });
  assert.deepEqual(validateReviewArtifact(reviewArtifact({ changedLogicSummary: [""] })), {
    ok: false,
    code: "ARTIFACT_SCHEMA_INVALID",
  });
  assert.deepEqual(validateReviewArtifact(withoutRiskHunks), {
    ok: false,
    code: "ARTIFACT_SCHEMA_INVALID",
  });
  assert.deepEqual(validateReviewArtifact(withoutInvariants), {
    ok: false,
    code: "ARTIFACT_SCHEMA_INVALID",
  });
  assert.equal(validateReviewVerdict(reviewVerdict()).ok, true);
  assert.deepEqual(validateReviewVerdict({ ...reviewVerdict(), extra: true }), {
    ok: false,
    code: "VERDICT_SCHEMA_INVALID",
  });
  assert.deepEqual(validateReviewVerdict({
    verdict: "PASS",
    sourceFingerprint: "source-v1",
    findings: [{ severity: "minor", path: "x", evidence: "nit", requiredFix: "fix" }],
  }), { ok: false, code: "VERDICT_SCHEMA_INVALID" });
  assert.deepEqual(validateReviewVerdict({
    verdict: "MUST_FIX",
    sourceFingerprint: "source-v1",
    findings: [{ severity: "major", code: "old", summary: "old", paths: ["x"] }],
  }), { ok: false, code: "VERDICT_SCHEMA_INVALID" });
});

test("review gate rejects stale, mismatched, and reused fingerprints and allows one verification", () => {
  const initial = {
    phase: "initial" as const,
    candidateId: "candidate-1",
    currentSourceFingerprint: "source-v1",
    artifact: reviewArtifact(),
    verdict: reviewVerdict("MUST_FIX"),
    reviewedFingerprints: [],
    maxCallsPerCandidate: 1,
    callsForPhase: 0,
  };
  assert.deepEqual(evaluateReviewGate(initial), { ok: true, permitStage: false, verdict: "MUST_FIX" });
  assert.deepEqual(evaluateReviewGate({ ...initial, currentSourceFingerprint: "source-v2" }), {
    ok: false,
    code: "STALE_FINGERPRINT",
  });
  assert.deepEqual(evaluateReviewGate({ ...initial, verdict: reviewVerdict("PASS", "other") }), {
    ok: false,
    code: "FINGERPRINT_MISMATCH",
  });
  assert.deepEqual(evaluateReviewGate({ ...initial, reviewedFingerprints: ["source-v1"] }), {
    ok: false,
    code: "FINGERPRINT_REUSED",
  });
  const verified = evaluateReviewGate({
    phase: "verification",
    candidateId: "candidate-1",
    currentSourceFingerprint: "source-v2",
    artifact: reviewArtifact({ sourceFingerprint: "source-v2" }),
    verdict: reviewVerdict("PASS", "source-v2"),
    reviewedFingerprints: ["source-v1"],
    maxCallsPerCandidate: 1,
    callsForPhase: 0,
    initialVerdict: "MUST_FIX",
    initialArtifact: reviewArtifact(),
    remediationApplied: true,
  });
  assert.deepEqual(verified, { ok: true, permitStage: true, verdict: "PASS" });
  assert.deepEqual(evaluateReviewGate({
    phase: "verification",
    candidateId: "candidate-1",
    currentSourceFingerprint: "source-v3",
    artifact: reviewArtifact({ sourceFingerprint: "source-v3" }),
    verdict: reviewVerdict("PASS", "source-v3"),
    reviewedFingerprints: ["source-v1", "source-v2"],
    maxCallsPerCandidate: 1,
    callsForPhase: 0,
    initialVerdict: "MUST_FIX",
    initialArtifact: reviewArtifact(),
    remediationApplied: true,
  }), { ok: false, code: "VERIFICATION_NOT_ALLOWED" });
  assert.deepEqual(evaluateReviewGate({ ...initial, callsForPhase: 1 }), {
    ok: false,
    code: "REVIEW_BUDGET_EXHAUSTED",
  });
  assert.deepEqual(evaluateReviewGate({
    phase: "verification",
    candidateId: "candidate-1",
    currentSourceFingerprint: "source-v2",
    artifact: reviewArtifact({ sourceFingerprint: "source-v2", manifest: [] }),
    verdict: reviewVerdict("PASS", "source-v2"),
    reviewedFingerprints: ["source-v1"],
    maxCallsPerCandidate: 1,
    callsForPhase: 0,
    initialVerdict: "MUST_FIX",
    initialArtifact: reviewArtifact(),
    remediationApplied: true,
  }), { ok: false, code: "REVIEW_SCOPE_MISMATCH" });
  for (const artifact of [
    reviewArtifact({ sourceFingerprint: "source-v2", acceptance: [] }),
    reviewArtifact({ sourceFingerprint: "source-v2", changedLogicSummary: ["different logic scope"] }),
    reviewArtifact({ sourceFingerprint: "source-v2", riskTags: [] }),
    reviewArtifact({ sourceFingerprint: "source-v2", riskBearingHunks: [] }),
    reviewArtifact({ sourceFingerprint: "source-v2", invariants: [] }),
    reviewArtifact({
      sourceFingerprint: "source-v2",
      validation: { command: "different validation", exit: 0, fingerprint: "validation-v2" },
    }),
  ]) {
    assert.deepEqual(evaluateReviewGate({
      phase: "verification",
      candidateId: "candidate-1",
      currentSourceFingerprint: "source-v2",
      artifact,
      verdict: reviewVerdict("PASS", "source-v2"),
      reviewedFingerprints: ["source-v1"],
      maxCallsPerCandidate: 1,
      callsForPhase: 0,
      initialVerdict: "MUST_FIX",
      initialArtifact: reviewArtifact(),
      remediationApplied: true,
    }), { ok: false, code: "REVIEW_SCOPE_MISMATCH" });
  }
});

test("consultation adapter is provider-neutral and model names do not affect core requests", async () => {
  const seen: ConsultationRequest[] = [];
  const adapter: ConsultationAdapter = {
    async consult(request): Promise<ConsultationResult> {
      seen.push(request);
      return {
        requestId: request.requestId,
        candidateId: request.candidateId,
        capability: "strategy",
        status: "completed",
        recommendation: "keep the port pure",
        considerations: [],
      };
    },
  };
  const request: ConsultationRequest = {
    requestId: "request-1",
    candidateId: "candidate-1",
    capability: "strategy",
    agent: CONSULTATION_ROLE_POLICY.strategy,
    question: "Which boundary is stable?",
    constraints: ["no command execution"],
    options: ["port", "direct integration"],
  };
  const result = await adapter.consult(request);
  assert.equal(result.status, "completed");
  assert.deepEqual(seen, [request]);
  assert.deepEqual(Object.keys(request).sort(), [
    "agent",
    "candidateId",
    "capability",
    "constraints",
    "options",
    "question",
    "requestId",
  ]);
  assert.deepEqual(Object.keys(result).sort(), [
    "candidateId",
    "capability",
    "considerations",
    "recommendation",
    "requestId",
    "status",
  ]);
  for (const envelope of [request, result]) {
    for (const forbidden of ["provider", "vendor", "model", "variant", "transport"]) {
      assert.equal(Object.hasOwn(envelope, forbidden), false, `${forbidden} leaked into consultation envelope`);
    }
  }
  for (const model of ["vendor-one/model-a", "vendor-two/model-z"]) {
    const route = parseModelRoutingConfig({ "dog-advisor": { model } });
    assert.deepEqual(route?.["dog-advisor"], { preferred: { model } });
    assert.equal(JSON.stringify(request).includes(model), false);
  }

  const coordinator = runtimeAssets.find((asset) => asset.name === "dog-coordinator");
  assert.ok(coordinator);
  assert.match(
    coordinator.content,
    /ConsultationAdapter is the sole explicit transport boundary;\s+the host adapter owns it/i,
  );
  for (const name of ["dog-advisor", "dog-reviewer"]) {
    const asset = runtimeAssets.find((candidate) => candidate.name === name);
    assert.ok(asset);
    const frontmatter = asset.content.match(/^---\r?\n([\s\S]+?)\r?\n---/)?.[1];
    assert.ok(frontmatter);
    assert.doesNotMatch(frontmatter, /^(?:provider|vendor|model|variant|transport):/m);
  }
  const coordinatorFrontmatter = coordinator.content.match(/^---\r?\n([\s\S]+?)\r?\n---/)?.[1];
  assert.ok(coordinatorFrontmatter);
  assert.match(coordinatorFrontmatter, new RegExp(`^model: ${DEFAULT_COORDINATOR_MODEL}$`, "m"));
  assert.match(coordinatorFrontmatter, new RegExp(`^variant: ${DEFAULT_COORDINATOR_VARIANT}$`, "m"));
});

test("generated dog-worker runtime asset leaves its model to dedicated routing", () => {
  const dogWorker = runtimeAssets.find((asset) => asset.name === "dog-worker");
  assert.ok(dogWorker);
  assert.ok(dogWorker.content.startsWith(`---
description: Dedicated worker for the canonical Sortie-dogs coordinator
mode: subagent
---
`));
  // Pinning an unavailable model in the asset would stop the agent from loading at all, so the
  // dedicated target stays a routing decision that a host can redeclare.
  assert.equal(dogWorker.content.includes(DEDICATED_WORKER_MODEL), false);
});

test("generated coordinator requires progress, immediate Task feedback, and deny-safe delegation", () => {
  const coordinator = runtimeAssets.find((asset) => asset.name === "dog-coordinator");
  assert.ok(coordinator);
  const content = coordinator.content.replace(/\s+/gu, " ");
  for (const required of [
    "進行中: <candidate> — <n>% (<phase>) | バッチ: committed <committed>/<target>; attempted <attempted>/<target>; reconciled <reconciled>",
    "所感(<child>/<role>): <assessment>",
    "根拠: <result evidence>",
    "次action: <single next action>",
    "Never test an unapproved script in the coordinator shell",
    "After any command deny",
  ]) assert.ok(content.includes(required), required);
});

test("generated assets require the user's language, per-line output, and emoji-marked lines", () => {
  const coordinator = runtimeAssets.find((asset) => asset.name === "dog-coordinator");
  assert.ok(coordinator);
  const readable = coordinator.content.match(
    /READABLE_OUTPUT_FIXTURE\r?\n([\s\S]+?)\r?\nEND_READABLE_OUTPUT_FIXTURE/,
  );
  assert.ok(readable);
  assert.match(readable[1], /^ {4}language: user's request language for all prose/m);
  assert.match(readable[1], /^ {4}verbatim: identifiers, paths, commands, document keys/m);
  assert.match(readable[1], /^ {4}separation: one blank line between plan, progress/m);
  assert.match(readable[1], /^ {4}line_rule: one statement per line; run-on single-line output forbidden$/m);
  assert.match(readable[1], /^ {4}emoji: exactly one leading emoji per user-facing line$/m);
  for (const emoji of ["🎯", "📊", "🐕", "🔍", "➡️", "⛔", "✅"]) {
    assert.ok(readable[1].includes(emoji), emoji);
  }
  // The user cannot audit a delegated exchange written in a language they did not use.
  assert.match(
    coordinator.content,
    /Detect the language of the user's latest request[\s\S]+prose\s+fields of every handoff, checkpoint, and consultation payload in that same language/i,
  );
  assert.match(
    coordinator.content,
    /Translate the user-facing display labels of the fixtures below into that language/i,
  );
  // A localized digest key hides the value the write gate reads, so key form is not a prose choice.
  assert.match(
    coordinator.content,
    /field key is a protocol token the\s+write gate reads[\s\S]+exact ASCII form/i,
  );
  assert.match(readable[1], /^ {4}protocol_keys: dispatch, handoff, checkpoint, consultation field keys stay verbatim ASCII$/m);
  const visibility = coordinator.content.match(
    /OPERATIONAL_VISIBILITY_FIXTURE\r?\n([\s\S]+?)\r?\nEND_OPERATIONAL_VISIBILITY_FIXTURE/,
  );
  assert.ok(visibility);
  assert.match(visibility[1], /^ {4}progress_line: 📊 進行中:/m);
  assert.match(visibility[1], /^ {4}task_line_1: 🐕 所感/m);
  assert.match(visibility[1], /^ {4}task_line_2: 🔍 根拠/m);
  assert.match(visibility[1], /^ {4}task_line_3: ➡️ 次action/m);
  assert.match(visibility[1], /^ {4}task_line_format: one line each, never joined into one line/m);

  for (const name of ["dog-worker", "dog-scout", "dog-reviewer", "dog-advisor"]) {
    const asset = runtimeAssets.find((candidate) => candidate.name === name);
    assert.ok(asset, name);
    assert.match(asset.content, /in the language the\s+(?:supplied|dispatch uses)/i, name);
    assert.match(asset.content, /verbatim/i, name);
  }

  // A tool-free reviewer cannot recover evidence the coordinator omitted from its inline artifact.
  const sourceReviewPreflight = coordinator.content.match(
    /SOURCE_REVIEW_PREFLIGHT_FIXTURE\r?\n([\s\S]+?)\r?\nEND_SOURCE_REVIEW_PREFLIGHT_FIXTURE/,
  );
  assert.ok(sourceReviewPreflight);
  assert.match(sourceReviewPreflight[1], /required_artifact: acceptance \+ exact manifest \+ non-empty changedLogicSummary \+ canonical validation command\/exit\/fingerprint/);
  assert.match(sourceReviewPreflight[1], /acceptance_coverage: every acceptance item explicitly maps to at least one changedLogicSummary entry/);
  assert.match(sourceReviewPreflight[1], /dispatch_guard: dispatch dog-reviewer only when required_artifact and acceptance_coverage are complete/);
  assert.match(sourceReviewPreflight[1], /incomplete_action: fail closed before SourceReview dispatch/);
  assert.match(coordinator.content, /A path where the reviewer could obtain a diff[\s\S]+is not a changed logic summary/i);

  const reviewer = runtimeAssets.find((asset) => asset.name === "dog-reviewer");
  assert.ok(reviewer);
  assert.match(reviewer.content, /Confirm every acceptance item explicitly\s+maps to at least one changedLogicSummary entry/i);
  assert.match(reviewer.content, /Missing or incomplete coverage is a concrete finding, never PASS/i);

  const worker = runtimeAssets.find((candidate) => candidate.name === "dog-worker");
  assert.ok(worker);
  assert.match(worker.content, /Any command or tool denial is terminal evidence for that attempted operation/i);
  assert.match(
    worker.content,
    /not retry with another executable spelling, absolute path, shell wrapper, quoting style, narrowed\s+argument, direct probe, or diagnostic substitute/i,
  );
  assert.match(worker.content, /Run only the exact canonical validation command\s+from the handoff/i);
  assert.match(worker.content, /denied optional check remains\s+DENIED evidence and never justifies another tool step/i);
});

test("generated coordinator renders a four-line standard view without dropping canonical Evidence", () => {
  const coordinator = runtimeAssets.find((asset) => asset.name === "dog-coordinator");
  assert.ok(coordinator);
  const output = coordinator.content.match(
    /TERMINAL_OUTPUT_TEMPLATE\r?\n([\s\S]+?)\r?\nEND_TERMINAL_OUTPUT_TEMPLATE/,
  );
  assert.ok(output);
  assert.equal(output[1].match(/\r?\n\r?\n/g)?.length, 1, "layers need exactly one blank separator");
  assert.match(
    output[1],
    /^➡️ next_action: <single action or none>\r?\n\r?\n🔍 Evidence\r?$/mu,
    "exactly one blank line leads from the fourth standard line to the fixed Evidence heading",
  );
  const layers = output[1].split(/\r?\n\r?\n/);
  assert.equal(layers.length, 2);
  const [standard, evidence] = layers;
  assert.ok(evidence, "standard view and Evidence need one blank separator");
  const standardLines = standard.split(/\r?\n/);
  assert.equal(standardLines.length, 4);
  assert.ok(standardLines.every((line) => line.length > 0), "standard view has no internal blank line");
  assert.match(standardLines[0], /^✅ status: .+; task_id: .+$/u);
  assert.match(standardLines[1], /^🐕 decisions: <short decision summary>$/u);
  assert.match(standardLines[2], /^🔍 validation: <ordered PASS\/FAIL summary>$/u);
  assert.match(standardLines[3], /^➡️ next_action: <single action or none>$/u);
  assert.deepEqual(standardLines, [
    "✅ status: <DONE | BLOCKED | NEED_DECISION>; task_id: <stable task id>",
    "🐕 decisions: <short decision summary>",
    "🔍 validation: <ordered PASS/FAIL summary>",
    "➡️ next_action: <single action or none>",
  ], "standard view is exactly four lines in status+task_id, decisions, validation, next_action order");
  assert.deepEqual(
    standardLines.map((line) => /^\S+ ([a-z_]+):/u.exec(line)?.[1]),
    ["status", "decisions", "validation", "next_action"],
    "standard protocol keys stay exact ASCII and ordered",
  );
  assert.ok(standardLines[0].includes("; task_id: "), "task_id stays exact ASCII on the status statement");
  assert.ok(
    standardLines.every((line) => /^(?:✅|🐕|🔍|➡️) [\x00-\x7F]/u.test(line)),
    "each standard line has exactly one leading emoji before an ASCII protocol key",
  );
  assert.ok(
    standardLines.every((line) => !/[.!?]\s+\S/u.test(line)),
    "each standard line contains one statement",
  );

  const evidenceLines = evidence.split(/\r?\n/);
  assert.equal(evidenceLines[0], "🔍 Evidence");
  assert.ok(evidenceLines.every((line) => line.length > 0), "Evidence has no internal blank line");
  const evidenceKeys = [
    "status",
    "task_id",
    "manifest",
    "decisions",
    "validation",
    "scout",
    "raw_status",
    "diff",
    "stale_paths",
    "new_findings",
    "next_action",
  ];
  assert.deepEqual(
    evidenceLines.slice(1).map((line) => /^\S+ ([a-z_]+):/u.exec(line)?.[1]),
    evidenceKeys,
    "Evidence protocol keys stay exact ASCII and ordered",
  );
  assert.match(evidence, /^🔍 manifest: /mu, "Evidence retains the exact ASCII manifest key");
  assert.match(evidence, /^🔍 decisions: /mu, "Evidence retains the exact ASCII decisions key");
  assert.match(evidence, /^🔍 raw_status: /mu, "Evidence retains the exact ASCII raw_status key");
  assert.match(evidence, /^🔍 diff: /mu, "Evidence retains the exact ASCII diff key");
  assert.match(evidence, /^🔍 stale_paths: /mu, "Evidence retains the exact ASCII stale_paths key");
  assert.match(evidence, /^🔍 new_findings: /mu, "Evidence retains the exact ASCII new_findings key");
  assert.match(evidence, /^➡️ next_action: /mu, "Evidence retains the exact ASCII next_action key");
  assert.ok(
    evidenceLines.every((line) => /^(?:🔍|➡️) [\x00-\x7F]/u.test(line)),
    "each Evidence line has exactly one leading emoji",
  );
  assert.ok(
    evidenceLines.slice(1).every((line) => /^\S+ [a-z_]+: /u.test(line)),
    "each Evidence line contains one canonical field statement",
  );
  const validationLine = evidenceLines.find((line) => line.startsWith("🔍 validation:"));
  assert.equal(
    validationLine,
    "🔍 validation: [{ command: npm test, exit: 1, fingerprint: initial failure }, " +
      "{ command: npm test, exit: 0, fingerprint: final pass }]",
    "ordered validation retains every command, exit, and fingerprint from initial failure through final pass",
  );
  const validationEntries = [...(validationLine ?? "").matchAll(
    /\{ (command): ([^,]+), (exit): ([^,]+), (fingerprint): ([^}]+) \}/gu,
  )].map((match) => ({
    keys: [match[1], match[3], match[5]],
    command: match[2],
    exit: Number(match[4]),
    fingerprint: match[6],
  }));
  assert.deepEqual(validationEntries, [
    { keys: ["command", "exit", "fingerprint"], command: "npm test", exit: 1, fingerprint: "initial failure" },
    { keys: ["command", "exit", "fingerprint"], command: "npm test", exit: 0, fingerprint: "final pass" },
  ], "every Evidence validation entry retains exact ASCII command, exit, and fingerprint keys and values");
  assert.equal(validationEntries[0]?.exit, 1, "append-only validation history keeps initial exit=1 first");
  assert.equal(validationEntries.at(-1)?.exit, 0, "append-only validation history keeps latest exit=0 last");
  assert.match(
    coordinator.content,
    /standard view is a projection, never a\s+replacement for Evidence/i,
  );
});

test("shipped document fixtures satisfy the schemas the write gate enforces", () => {
  const coordinator = runtimeAssets.find((asset) => asset.name === "dog-coordinator");
  const worker = runtimeAssets.find((asset) => asset.name === "dog-worker");
  assert.ok(coordinator);
  assert.ok(worker);
  const block = (name: string): string => {
    const match = coordinator.content.match(
      new RegExp(`${name}\\r?\\n([\\s\\S]+?)\\r?\\n {4}required:`),
    );
    assert.ok(match, `missing ${name}`);
    return match[1];
  };

  // The example an agent copies must pass the same validators that deny a defective candidate.
  const handoff = JSON.parse(block("HANDOFF_DOCUMENT_FIXTURE")) as Record<string, unknown>;
  const manifest = JSON.parse(block("OPERATION_MANIFEST_DOCUMENT_FIXTURE")) as Record<string, unknown>;
  const handoffResult = validateHandoffSchema(handoff);
  const manifestResult = validateOperationManifestSchema(manifest);
  assert.deepEqual(handoffResult.diagnostics, []);
  assert.deepEqual(manifestResult.diagnostics, []);
  assert.ok(handoffResult.ok);
  assert.ok(manifestResult.ok);
  assert.deepEqual(
    validateManifest(handoffResult.value, manifestResult.value, undefined, false, {
      requirePassedValidation: false,
    }).filter(({ severity }) => severity === "error"),
    [],
  );

  const state = (handoff.state as { blocked: unknown[] }).blocked;
  assert.deepEqual(state, [{ reason: "<what is blocked>", needed: "<what unblocks it>" }]);
  assert.match(
    coordinator.content,
    /state\.blocked holds objects, never strings; an empty array is the correct value/,
  );
  assert.match(
    coordinator.content,
    /candidate, targets, constraints, source_manifest, and project_root are not manifest fields/,
  );

  const preflight = coordinator.content.match(
    /CONTRACT_PREFLIGHT_FIXTURE\r?\n([\s\S]+?)\r?\nEND_CONTRACT_PREFLIGHT_FIXTURE/,
  );
  assert.ok(preflight);
  assert.match(preflight[1], /tool: sortie_check_contract \{ handoff_path: <exact absolute handoff path> \}/);
  assert.match(preflight[1], /required_result: status=ok/);
  assert.match(preflight[1], /timing: before Task dispatch and after every handoff regeneration/);
  assert.match(preflight[1], /authorization: read-only report; never inspection, bind, or mutation/);
  assert.match(preflight[1], /equivalent_command: sortie-dogs lint <handoff_path> --manifest <operation_manifest_path> requires exit 0/);
  assert.match(preflight[1], /repair: fix the named pointer; an unchanged resend earns retry-exhausted/);
  assert.match(worker.content, /denied Read[\s\S]+denied bind[\s\S]+exact JSON\s+pointer/i);
  assert.match(worker.content, /Return those defect entries\s+verbatim to dog-coordinator/i);
});

test("runtime contract requires interactive continuation and deterministic recoverable handshake", async () => {
  const coordinator = runtimeAssets.find((asset) => asset.name === "dog-coordinator");
  const worker = runtimeAssets.find((asset) => asset.name === "dog-worker");
  assert.ok(coordinator);
  assert.ok(worker);
  const question = coordinator.content.match(
    /USER_QUESTION_FIXTURE\r?\n([\s\S]+?)\r?\nEND_USER_QUESTION_FIXTURE/,
  );
  assert.ok(question);
  assert.match(
    coordinator.content,
    /^permission:\r?\n  question: allow\r?\n  task:\r?\n    "\*": deny\r?\n    dog-worker: allow\r?\n    dog-scout: allow\r?\n    dog-reviewer: allow\r?\n    dog-advisor: allow\r?\ntools:\r?\n  question: true\r?\n  task: true$/mu,
  );
  for (const denied of ["build", "implementer", "fixer", "reviewer", "explore", "general", "coordinator"]) {
    assert.doesNotMatch(coordinator.content, new RegExp(`^    ${denied}: allow$`, "m"));
  }
  assert.match(question[1], /context_line_1:/);
  assert.match(question[1], /context_line_5:/);
  assert.match(question[1], /invoke question tool; plain-text final forbidden/);
  assert.match(question[1], /automatically resume the same candidate flow/);
  /*
   * Scoping the tool to blocked external state left every design or scope choice as a prose question,
   * which ends the turn without the selectable options the user asked to answer.
   */
  assert.match(question[1], /^ {4}trigger: any user question, including [\s\S]*design or scope choice/m);
  assert.match(question[1], /^ {4}payload: \{ question: .+ options: \[\{ label: <choice; recommended first>/m);
  assert.match(
    coordinator.content,
    /Every question you put to the user goes through the question tool[\s\S]+Never end a turn with a question written as prose/,
  );

  const handshake = coordinator.content.match(
    /RECOVERABLE_HANDSHAKE_FIXTURE\r?\n([\s\S]+?)\r?\nEND_RECOVERABLE_HANDSHAKE_FIXTURE/,
  );
  assert.ok(handshake);
  assert.match(handshake[1], /session-inactive \| session-expired \| handoff-uninspected \| handoff-mismatch/);
  assert.match(handshake[1], /operation manifest \+ valid registered handoff -> Task child activation -> built-in Read exact handoff_path -> bind in same turn/);
  assert.match(handshake[1], /one recoverable retry only after state change; second unchanged denial -> retry-exhausted/);
  assert.match(handshake[1], /successful built-in Read by binding child only; shell\/coordinator\/sibling\/file\.edited do not grant/);
  assert.match(handshake[1], /retry_exhausted: nonrecoverable local blocker/);
  assert.match(handshake[1], /same manifest hash \+ mtime after reread -> idempotent bound/);
  assert.match(handshake[1], /changed path, hash, or mtime -> deny/);
  assert.match(handshake[1], /dog-coordinator regenerates registered handoff; worker never rewrites it/);
  assert.match(handshake[1], /recoverable_bind_signal: escalation\.action=blocker-resolution-takeover/);
  assert.match(handshake[1], /nonrecoverable_bind_signal: escalation\.action=follow-remedy; resume_session=false/);
  assert.match(handshake[1], /redispatch_bind_signal: escalation\.action=redispatch-worker; resume_session=false; true_blocker=false/);
  assert.match(handshake[1], /TRUE_BLOCKER absent -> blocker-resolution takeover on the same solSession/);
  assert.match(worker.content, /do not terminate and do not ask the\s+user/i);
  assert.match(worker.content, /mutating dispatch[\s\S]+exact absolute handoff_path[\s\S]+built-in Read once on that handoff_path[\s\S]+same turn/i);
  assert.match(worker.content, /operation_manifest=none the dispatch is read-only:[\s\S]+require no\s+handoff_path[\s\S]+never inspect a handoff[\s\S]+never call sortie_bind_write_gate/i);
  assert.match(worker.content, /structured\s+session-inactive denial proves an invalid dispatch/i);
  assert.match(worker.content, /Only\s+dog-coordinator may regenerate a mismatched handoff/i);
  assert.match(worker.content, /Only a recoverable[\s\S]+resume_session=true[\s\S]+same solSession/i);
  assert.match(worker.content, /nonrecoverable denial[\s\S]+existing remedy[\s\S]+never same-session resume/i);
  assert.match(worker.content, /redispatch-worker escalation[\s\S]+unchanged[\s\S]+never resume the denied session/i);

  const pluginSource = await readFile(new URL("../src/plugin/index.ts", import.meta.url), "utf8");
  const bindSource = /async function bindWriteGate[\s\S]+?(?=\n  async function sessionGate)/u.exec(pluginSource)?.[0];
  assert.ok(bindSource);
  const emittedActions = [...bindSource.matchAll(/\baction: "([^"]+)"/gu)].map((match) => match[1]);
  const namedActions = [...handshake[1].matchAll(/\w+_bind_signal: escalation\.action=([^;\s]+)/gu)]
    .map((match) => match[1]);
  assert.deepEqual([...new Set(namedActions)].sort(), [...new Set(emittedActions)].sort());

  const batch = coordinator.content.match(
    /BATCH_CONTINUATION_FIXTURE\r?\n([\s\S]+?)\r?\nEND_BATCH_CONTINUATION_FIXTURE/,
  );
  assert.ok(batch);
  assert.match(batch[1], /terminal_order: establish terminal handoff first; then increment batchAttempted/);
  assert.match(batch[1], /new_successful_commit: increment batchCommitted only/);
  assert.match(batch[1], /existing_commit_accepted: increment batchReconciled only/);
  assert.match(
    batch[1],
    /blocked_unit: increment batchAttempted only; record blocker with concrete needed action; continue to next independent unit/,
  );
  assert.match(batch[1], /local_handoff_defect: recover in the same candidate flow; never stop or count the unit terminal/);
  assert.match(batch[1], /compact_guard: batchAttempted < batchTarget and independent next candidate exists/);
  assert.match(batch[1], /compact_action: after checkpoint invoke configured continuation; then same-turn stop/);
  // The observed field defect was a blocked unit ending the batch at attempted 1 of 3.
  assert.match(
    batch[1],
    /blocked_unit_continuation: required while batchAttempted < batchTarget and an independent next candidate exists/,
  );
  assert.match(batch[1], /plain_final_instead_of_continuation: defect/);

  const compaction = coordinator.content.match(
    /COMPACTION_IDENTITY_FIXTURE\r?\n([\s\S]+?)\r?\nEND_COMPACTION_IDENTITY_FIXTURE/,
  );
  assert.ok(compaction);
  for (const contract of [
    "resolver: one resolver for direct tool | continuation marker fallback | step-exhausted fallback",
    "configured_route: configured continuation agent + configured continuation capability required",
    "source_identity: available root dog-coordinator; preserved across compaction",
    "identity_conversion: another coordinator rejected",
    "child_promotion: child session -> root rejected",
    "unavailable_identity: automatic continuation disabled",
    "marker_fallback: only when direct capability unavailable; never combine direct tool and marker",
    "final_unit: terminal response with no forced compaction or resume",
    "pending_host_autocontinue: no compaction",
    "post_call: same-turn stop; no tool | Task | analysis | final",
    // Abstract policy alone left the coordinator with nothing to invoke, so the route is named.
    "continuation_agent: dog-coordinator",
    `direct_capability: ${CONTINUATION_CAPABILITY}`,
    `marker_literal: ${CONTINUATION_MARKER}`,
    `legacy_stop_marker_literal: ${ROLLOVER_MARKER}; runtime compatibility only; normal policy never emits it`,
  ]) assert.ok(compaction[1].includes(contract), contract);
  assert.match(
    coordinator.content,
    /marker fallback\s+only when the direct capability is unavailable, never in addition to or after a direct call/i,
  );
  assert.match(coordinator.content, /OpenCode owns token-limit automatic compaction; leave its auto-continue\s+enabled/i);
  assert.doesNotMatch(coordinator.content, /stop compaction is universal/i);
  assert.match(
    coordinator.content,
    /For three or more tracker mutations,[\s\S]+secret-free UTF-8 script[\s\S]+syntax-check it locally/i,
  );
  const direct = coordinator.content.match(
    /COORDINATOR_DIRECT_OPERATION_FIXTURE\r?\n([\s\S]+?)\r?\nEND_COORDINATOR_DIRECT_OPERATION_FIXTURE/,
  );
  assert.ok(direct);
  for (const contract of [
    "known_executable_probe: one batched direct depth-one read-only command; no Task",
    "executable_absent: question tool; no worker discovery or recursive search",
    "project_inventory: one direct read-only tracker command; no Task",
    "project_item_identity: same direct inventory evidence; no identity-only worker",
    "inventory_reuse: successful result reused until tracker mutation | compact resume | relevant user scope change",
    "identical_inventory_retry: forbidden before invalidation",
    "candidate_body: read full body before first status mutation",
    "relevance_gate: current user scope + project evidence required; title | order | bulk status insufficient",
    "relevance_ambiguous: one question before mutation or dispatch",
    "active_project_root: most specific task + tracker + project-instruction owner; immutable for the session",
    "workspace_ancestor: multiple projects below it -> forbidden as activeProjectRoot",
    "external_implementation_root: hold | reassign | switch owning project; no inspect | dispatch | mutation",
    "cross_project_recommendation: forbidden; recommend project-local option or hold",
    "explicit_external_selection: identifies next owning-project task; never continues under current root",
    "terminal_checkpoint: at most two tracker mutations -> one coordinator-owned direct tracker command",
    "local_checkpoint_file: excluded from tracker mutation count",
    "direct_operation_artifacts: no handoff | operation manifest | generated script | child session",
    "tracker_unavailable: project-local checkpoint fallback; never a worker retry loop",
  ]) assert.ok(direct[1].includes(contract), contract);
  assert.match(
    coordinator.content,
    new RegExp(`configured continuation capability is\\s+the plugin tool ${CONTINUATION_CAPABILITY}`, "i"),
  );

  const reflection = coordinator.content.match(
    /REFLECTION_POLICY_FIXTURE\r?\n([\s\S]+?)\r?\nEND_REFLECTION_POLICY_FIXTURE/,
  );
  assert.ok(reflection);
  assert.match(reflection[1], /checkpoints: user correction immediately \| other evidence after resolved blocker or review defect \| terminal unit/);
  assert.match(
    reflection[1],
    /allowed_evidence: user-correction \| repeated-process-failure \| review-artifact-defect \| retry-policy-violation/,
  );
  assert.match(reflection[1], /global_layer: forbidden/);
  assert.match(reflection[1], /attribution: before\/after state or exact command evidence required/);
  assert.match(reflection[1], /tracker_privacy: no item\/node\/draft ID \| URL \| title \| body \| field value \| status \| inventory payload/);
  assert.match(reflection[1], /user_correction_layer: project immediately/);
  assert.match(reflection[1], /project_layer: same stable scope recurred in a later unit or was injected from an earlier run/);
  assert.match(reflection[1], /dedup: same scope updates trigger and hits; cause and prevention change only through replace/);
  assert.match(reflection[1], /call_limit: one record per triggering event; three record calls per run/);
  assert.match(reflection[1], /injected_project_recurrence: record project once to increment hits/);
  assert.match(reflection[1], /non_triggers: code bug \| ordinary validation failure/);
  assert.match(reflection[1], /call: sortie_reflection \{ action: record/);
  assert.match(reflection[1], /field_budget: concise ASCII English; scope \+ trigger \+ cause \+ prevention \+ evidenceRef <=400 characters total/);
  assert.match(reflection[1], /list: never before record; once before replace \| forget \| promote only when target id is absent/);
  assert.match(reflection[1], /correction: improved cause or prevention -> replace; disproved attribution -> forget/);
  assert.match(reflection[1], /forget_confirmation: none; exact entry id is the deletion boundary/);
  assert.match(reflection[1], /durable_fix: hits>=2 or policy-related user correction -> create durable-fix candidate/);
  assert.match(reflection[1], /promotion: durable fix committed -> promote/);
  assert.match(reflection[1], /read: automatic injection with id and hits under SORTIE_PROCESS_REFLECTIONS/);

  const drain = coordinator.content.match(
    /BACKLOG_DRAIN_FIXTURE\r?\n([\s\S]+?)\r?\nEND_BACKLOG_DRAIN_FIXTURE/,
  );
  assert.ok(drain);
  for (const contract of [
    "drain_counts: batchAttempted=terminal handoffs; batchCommitted=new commits; batchReconciled=accepted existing commits",
    "continuation: terminal handoff -> Project checkpoint -> same identity-preserving resolver -> compact resume -> complete reinventory",
    "source_identity: preserve root source agent identity across drain compaction",
    "child_promotion: child session -> root rejected",
    "pending_host_autocontinue: drain compaction rejected",
    "fallback_exclusivity: direct capability or marker fallback; never both",
  ]) assert.ok(drain[1].includes(contract), contract);
});

test("continuation configuration ships a working default and rejects an unsafe override", () => {
  const shipped = resolvePluginConfiguration({});
  assert.equal(shipped.kind, "configured");
  if (shipped.kind === "configured") {
    // Continuation must work with no configuration at all, or the loop silently never runs.
    assert.deepEqual(shipped.continuation, {
      enabled: true,
      agent: "dog-coordinator",
      capability: CONTINUATION_CAPABILITY,
      maxAutoContinues: 2,
    });
  }

  const tuned = resolvePluginConfiguration({
    continuation: { maxAutoContinues: 5, summarizeModel: { model: "vendor-a/compact" } },
    modelCatalog: { global: [{ model: "vendor-a/compact" }] },
  });
  assert.equal(tuned.kind, "configured");
  if (tuned.kind === "configured") {
    assert.equal(tuned.continuation.maxAutoContinues, 5);
    assert.deepEqual(tuned.continuation.summarizeModel, { model: "vendor-a/compact" });
    assert.equal(tuned.continuation.agent, "dog-coordinator");
  }

  const disabled = resolvePluginConfiguration({ continuation: { enabled: false } });
  assert.equal(disabled.kind === "configured" && disabled.continuation.enabled, false);

  // The resumed agent and the invoked capability are the safety boundary, so neither is free text.
  for (const invalid of [
    { continuation: { agent: "coordinator-mk2a2" } },
    { continuation: { capability: "compact_and_continue" } },
    { continuation: { maxAutoContinues: 0 } },
    { continuation: { maxAutoContinues: 11 } },
    { continuation: { maxAutoContinues: 2.5 } },
    { continuation: { enabled: "yes" } },
    { continuation: { summarizeModel: { model: "" } } },
    { continuation: { unknown: true } },
  ]) assert.deepEqual(resolvePluginConfiguration(invalid), { kind: "invalid" }, JSON.stringify(invalid));
});

assert.deepEqual([...cases.keys()], [
  "allow-write",
  "deny-write",
  "deny-traversal",
  "missing-manifest",
  "invalid-manifest-json",
  "strict-warning",
]);

function fixtureCase(name: string): PluginCase {
  const candidate = cases.get(name);
  assert.ok(candidate, `missing fixture case ${name}`);
  return candidate;
}

async function withProject(
  name: string,
  run: (directory: string) => Promise<void>,
): Promise<void> {
  await mkdir(testEnvironment, { recursive: true });
  const directory = await mkdtemp(join(testEnvironment, `plugin-${name}-`));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function configuredHooks(directory: string) {
  await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
  return await SortieDogsPlugin({ directory });
}

test("global Sortie config enables reflection without plugin tuple options", async () => {
  await withProject("reflection-global-config", async (directory) => {
    const oldXdg = process.env.XDG_CONFIG_HOME;
    const oldConfig = process.env.SORTIE_DOGS_CONFIG;
    const oldReflection = process.env.SORTIE_REFLECTION;
    const xdg = await mkdtemp(join(testEnvironment, "reflection-global-xdg-"));
    try {
      process.env.XDG_CONFIG_HOME = xdg;
      delete process.env.SORTIE_DOGS_CONFIG;
      delete process.env.SORTIE_REFLECTION;
      await mkdir(join(xdg, "opencode"), { recursive: true });
      await writeFile(join(xdg, "opencode", "sortie-dogs.json"), JSON.stringify({
        reflection: { enabled: true, layers: { run: true, project: true, global: false } },
      }));
      const global = await SortieDogsPlugin({ directory });
      assert.ok(global.tool?.sortie_reflection);
      assert.ok(global["experimental.chat.system.transform"]);

      await mkdir(join(directory, ".opencode"), { recursive: true });
      await writeFile(join(directory, ".opencode", "sortie-dogs.json"), JSON.stringify({
        reflection: { enabled: false },
      }));
      const project = await SortieDogsPlugin({ directory });
      assert.equal(project.tool?.sortie_reflection, undefined);

      process.env.SORTIE_DOGS_CONFIG = JSON.stringify({ reflection: { enabled: true } });
      const environment = await SortieDogsPlugin({ directory });
      assert.ok(environment.tool?.sortie_reflection);
      const host = await SortieDogsPlugin({ directory }, { reflection: { enabled: false } });
      assert.equal(host.tool?.sortie_reflection, undefined);
    } finally {
      if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldXdg;
      if (oldConfig === undefined) delete process.env.SORTIE_DOGS_CONFIG; else process.env.SORTIE_DOGS_CONFIG = oldConfig;
      if (oldReflection === undefined) delete process.env.SORTIE_REFLECTION; else process.env.SORTIE_REFLECTION = oldReflection;
      await rm(xdg, { recursive: true, force: true });
    }
  });
});

test("invalid global Sortie config fails reflection closed without removing core tools", async () => {
  await withProject("reflection-invalid-global", async (directory) => {
    const oldXdg = process.env.XDG_CONFIG_HOME;
    const xdg = await mkdtemp(join(testEnvironment, "reflection-invalid-global-xdg-"));
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    try {
      process.env.XDG_CONFIG_HOME = xdg;
      await mkdir(join(xdg, "opencode"), { recursive: true });
      await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
      await writeFile(join(xdg, "opencode", "sortie-dogs.json"), "{bad");
      console.warn = (...args: unknown[]) => warnings.push(args);
      const hooks = await SortieDogsPlugin({ directory });
      assert.equal(hooks.tool?.sortie_reflection, undefined);
      assert.deepEqual(Object.keys(hooks.tool ?? {}).sort(), [
        "sortie_bind_write_gate",
        "sortie_check_contract",
        "sortie_compact_and_continue",
      ]);
      assert.equal(warnings.length, 1);
      await activate(hooks, "invalid-json-global");
      assert.equal((await bindWriteGate(hooks, directory, "invalid-json-global")).status, "bound");

      await writeFile(join(xdg, "opencode", "sortie-dogs.json"), JSON.stringify({ unknown: true }));
      const schemaHooks = await SortieDogsPlugin({ directory });
      assert.equal(schemaHooks.tool?.sortie_reflection, undefined);
      assert.equal(warnings.length, 2);
      await activate(schemaHooks, "invalid-schema-global");
      assert.equal((await bindWriteGate(schemaHooks, directory, "invalid-schema-global")).status, "bound");
    } finally {
      console.warn = originalWarn;
      if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldXdg;
      await rm(xdg, { recursive: true, force: true });
    }
  });
});

test("reflection integration is opt-in, layered, guarded, kill-switchable, and deletes root runs", async () => {
  await withProject("reflection-integration", async (directory) => {
    const oldXdg = process.env.XDG_CONFIG_HOME;
    const oldConfig = process.env.SORTIE_DOGS_CONFIG;
    const oldReflection = process.env.SORTIE_REFLECTION;
    const xdg = await mkdtemp(join(testEnvironment, "reflection-xdg-"));
    try {
      process.env.XDG_CONFIG_HOME = xdg;
      process.env.SORTIE_DOGS_CONFIG = JSON.stringify({ reflection: { maxInjectedEntries: 1, maxInjectedTokens: 500 } });
      delete process.env.SORTIE_REFLECTION;
      await mkdir(join(directory, ".opencode"), { recursive: true });
      await writeFile(join(directory, ".opencode", "sortie-dogs.json"), JSON.stringify({ reflection: { enabled: true, layers: { run: true, project: true, global: false } } }));
      const staleStartupLock = join(xdg, "opencode", "sortie-dogs", "reflection", "runs", "startup.json.lock");
      await mkdir(join(xdg, "opencode", "sortie-dogs", "reflection", "runs"), { recursive: true });
      await writeFile(staleStartupLock, JSON.stringify({ pid: 999999, token: "dead" }));
      await utimes(staleStartupLock, new Date(Date.now() - 6001), new Date(Date.now() - 6001));
      const logs: unknown[] = [];
      const client = { app: { log: (event: unknown) => logs.push(event) }, session: { get: async () => ({ data: { agent: "dog-coordinator" } }) } } as never;
      const hooks = await SortieDogsPlugin({ directory, client }, { reflection: { maxInjectedEntries: 2 } });
      assert.equal(await stat(staleStartupLock).catch(() => undefined), undefined);
      assert.ok(hooks.tool?.sortie_reflection);
      assert.ok(hooks["experimental.chat.system.transform"]);
      assert.ok(Object.keys(hooks.tool!.sortie_reflection.args).includes("id"));
      assert.ok(Object.keys(hooks.tool!.sortie_reflection.args).includes("promotedRef"));
      assert.ok(Math.ceil(Buffer.byteLength(JSON.stringify(hooks.tool!.sortie_reflection.args), "utf8") / 4) <= 150);
      const rootSession = "reflection-root";
      await mkdir(join(xdg, "opencode", "sortie-dogs", "reflection", "runs"), { recursive: true });
      await writeFile(join(xdg, "opencode", "sortie-dogs", "reflection", "runs", `${rootSession}.json`), "{bad");
      await hooks["chat.message"]!({ sessionID: rootSession, agent: "dog-coordinator" }, { message: { model: {} }, parts: [{ type: "text", text: "root" }] });
      const empty = { system: ["base"] };
      await hooks["experimental.chat.system.transform"]!({ sessionID: rootSession }, empty);
      assert.deepEqual(empty.system, ["base"]);
      assert.deepEqual(logs, [{ level: "warn", service: "sortie-dogs", message: "reflection_corrupt_json" }]);
      const execute = hooks.tool!.sortie_reflection.execute;
      const recorded = JSON.parse(await execute({ action: "record", layer: "run", scope: "integration", trigger: "trigger", cause: "cause", prevention: "Prevent this.", evidence: "user-correction", evidenceRef: "ref" }, { sessionID: rootSession, agent: "dog-coordinator" }));
      const injected = { system: [] as string[] };
      await hooks["experimental.chat.system.transform"]!({ sessionID: rootSession }, injected);
      assert.match(injected.system[0] ?? "", new RegExp(`^SORTIE_PROCESS_REFLECTIONS\\n- \\[${recorded.id}\\] integration \\(hits=1\\): Prevent this\\.$`, "u"));
      const listed = JSON.parse(await execute({ action: "list", layer: "run" }, { sessionID: rootSession, agent: "dog-coordinator" }));
      assert.equal(listed.entries[0].id, recorded.id);
      const replaced = JSON.parse(await execute({ action: "replace", layer: "run", id: recorded.id, scope: "integration", trigger: "new trigger", cause: "new cause", prevention: "Use the improved prevention." }, { sessionID: rootSession, agent: "dog-coordinator" }));
      assert.equal(replaced.id, recorded.id);
      assert.equal(replaced.hits, 2);
      assert.equal(await execute({ action: "forget", layer: "run", id: "unknown" }, { sessionID: rootSession, agent: "dog-coordinator" }), "not-found");
      const forgotten = JSON.parse(await execute({ action: "record", layer: "run", scope: "forget-me", trigger: "trigger", cause: "cause", prevention: "Remove this.", evidence: "user-correction", evidenceRef: "ref" }, { sessionID: rootSession, agent: "dog-coordinator" }));
      assert.equal(await execute({ action: "forget", layer: "run", id: forgotten.id }, { sessionID: rootSession, agent: "dog-coordinator" }), "forgotten");
      const compacted = { context: [] as string[], prompt: "" };
      await hooks["experimental.session.compacting"]!({ sessionID: rootSession }, compacted);
      const afterCompaction = { system: [] as string[] };
      await hooks["experimental.chat.system.transform"]!({ sessionID: rootSession }, afterCompaction);
      assert.match(afterCompaction.system[0] ?? "", new RegExp(`^SORTIE_PROCESS_REFLECTIONS\\n- \\[${recorded.id}\\] integration \\(hits=2\\): Use the improved prevention\\.$`, "u"));
      assert.equal(await execute({ action: "promote", layer: "run", id: recorded.id, promotedRef: "fix", }, { sessionID: rootSession, agent: "dog-coordinator" }), "promoted");
      assert.equal(await execute({ action: "clear", layer: "run" }, { sessionID: rootSession, agent: "dog-coordinator" }), "cleared");
      await execute({ action: "record", layer: "run", scope: "survive", trigger: "trigger", cause: "cause", prevention: "Keep this.", evidence: "user-correction", evidenceRef: "ref" }, { sessionID: rootSession, agent: "dog-coordinator" });
      const projectEntry = JSON.parse(await execute({ action: "record", layer: "project", scope: "project", trigger: "trigger", cause: "cause", prevention: "Keep project.", evidence: "user-correction", evidenceRef: "ref" }, { sessionID: rootSession, agent: "dog-coordinator" }));
      assert.equal(await execute({ action: "clear", layer: "project", confirmation: "wrong" }, { sessionID: rootSession, agent: "dog-coordinator" }), "reflection_confirmation_required");
      assert.equal(JSON.parse(await execute({ action: "list", layer: "project" }, { sessionID: rootSession, agent: "dog-coordinator" })).entries[0].id, projectEntry.id);
      const layered = { system: [] as string[] };
      await hooks["experimental.chat.system.transform"]!({ sessionID: rootSession }, layered);
      assert.equal(layered.system[0]?.split("\n").length, 3);
      const child = await execute({ action: "clear", layer: "run" }, { sessionID: "child", agent: "dog-coordinator" });
      assert.equal(child, "reflection_not_permitted");
      assert.equal(await execute({ action: "clear", layer: "run" }, { sessionID: rootSession, agent: "other-agent" }), "reflection_not_permitted");
      assert.equal(await execute({ action: "record", layer: "global", scope: "global", trigger: "t", cause: "c", prevention: "p", evidence: "user-correction", evidenceRef: "r" }, { sessionID: rootSession, agent: "dog-coordinator" }), "reflection_not_permitted");
      assert.equal(await execute({ action: "promote", layer: "global", id: projectEntry.id, promotedRef: "fix" }, { sessionID: rootSession, agent: "dog-coordinator" }), "reflection_not_permitted");
      assert.equal(await execute({ action: "clear", layer: "project", confirmation: "CLEAR_REFLECTIONS" }, { sessionID: rootSession, agent: "dog-coordinator" }), "cleared");
      assert.deepEqual(JSON.parse(await execute({ action: "list", layer: "project" }, { sessionID: rootSession, agent: "dog-coordinator" })).entries, []);

      const globalHooks = await SortieDogsPlugin({ directory, client }, { reflection: { enabled: true, layers: { global: true } } });
      const globalRoot = "reflection-global-root";
      await globalHooks["chat.message"]!({ sessionID: globalRoot, agent: "dog-coordinator" }, { message: { model: {} }, parts: [{ type: "text", text: "root" }] });
      const globalExecute = globalHooks.tool!.sortie_reflection.execute;
      const globalEntry = JSON.parse(await globalExecute({ action: "record", layer: "global", scope: "global-enabled", trigger: "t", cause: "c", prevention: "p", evidence: "user-correction", evidenceRef: "r" }, { sessionID: globalRoot, agent: "dog-coordinator" }));
      assert.equal(await globalExecute({ action: "promote", layer: "global", id: globalEntry.id, promotedRef: "fix" }, { sessionID: globalRoot, agent: "dog-coordinator" }), "promoted");

      const tinyHooks = await SortieDogsPlugin({ directory, client }, { reflection: { enabled: true, maxInjectedTokens: 1 } });
      const tinyRoot = "reflection-tiny-root";
      await tinyHooks["chat.message"]!({ sessionID: tinyRoot, agent: "dog-coordinator" }, { message: { model: {} }, parts: [{ type: "text", text: "root" }] });
      await tinyHooks.tool!.sortie_reflection.execute({ action: "record", layer: "run", scope: "tiny", trigger: "t", cause: "c", prevention: "p", evidence: "user-correction", evidenceRef: "r" }, { sessionID: tinyRoot, agent: "dog-coordinator" });
      const headingDoesNotFit = { system: [] as string[] };
      await tinyHooks["experimental.chat.system.transform"]!({ sessionID: tinyRoot }, headingDoesNotFit);
      assert.deepEqual(headingDoesNotFit.system, []);
      process.env.SORTIE_REFLECTION = "0";
      const killed = await SortieDogsPlugin({ directory }, { reflection: { enabled: true } });
      assert.equal(killed.tool?.sortie_reflection, undefined);
      assert.equal(killed["experimental.chat.system.transform"], undefined);
      assert.equal(await execute({ action: "clear", layer: "run" }, { sessionID: rootSession, agent: "dog-coordinator" }), "reflection_not_permitted");
      const unchanged = { system: ["base"] };
      await hooks["experimental.chat.system.transform"]!({ sessionID: rootSession }, unchanged);
      assert.deepEqual(unchanged.system, ["base"]);
      delete process.env.SORTIE_REFLECTION;
       const originalNow = Date.now;
       Date.now = () => originalNow() + 30 * 60 * 1000 + 1;
       try { await hooks.event!({ event: { type: "session.deleted", properties: { sessionID: rootSession } } }); } finally { Date.now = originalNow; }
      const reflectionRoot = join(xdg, "opencode", "sortie-dogs", "reflection");
      assert.equal(await stat(join(reflectionRoot, "runs", `${rootSession}.json`)).catch(() => undefined), undefined);
    } finally {
      if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldXdg;
      if (oldConfig === undefined) delete process.env.SORTIE_DOGS_CONFIG; else process.env.SORTIE_DOGS_CONFIG = oldConfig;
      if (oldReflection === undefined) delete process.env.SORTIE_REFLECTION; else process.env.SORTIE_REFLECTION = oldReflection;
      await rm(xdg, { recursive: true, force: true });
    }
  });
});

test("reflection host identity failures and children leave storage absent", async () => {
  await withProject("reflection-host-identity", async (directory) => {
    const oldXdg = process.env.XDG_CONFIG_HOME; const xdg = await mkdtemp(join(testEnvironment, "reflection-host-xdg-"));
    try {
      process.env.XDG_CONFIG_HOME = xdg; await mkdir(join(directory, ".opencode"), { recursive: true });
      await writeFile(join(directory, ".opencode", "sortie-dogs.json"), JSON.stringify({ reflection: { enabled: true } }));
      const cases: Array<[string, unknown, string]> = [
        ["absent", undefined, "root-absent"],
        ["throw", { session: { get: async () => { throw new Error("unavailable"); } } }, "root-throw"],
        ["incomplete", { session: { get: async () => ({ data: {} }) } }, "root-incomplete"],
        ["child", { session: { get: async ({ path }: { path: { id: string } }) => ({ data: path.id === "child" ? { agent: "dog-coordinator", parentID: "root" } : { agent: "dog-coordinator" } }) } }, "child"],
      ];
      for (const [_name, client, sessionID] of cases) {
        const hooks = await SortieDogsPlugin({ directory, ...(client === undefined ? {} : { client: client as never }) });
        if (sessionID === "child") await hooks.event!({ event: { type: "session.created", properties: { info: { id: "child", parentID: "root" } } } });
        await hooks["chat.message"]!({ sessionID, agent: "dog-coordinator" }, { message: { model: {} }, parts: [{ type: "text", text: "root" }] });
        const runFile = join(xdg, "opencode", "sortie-dogs", "reflection", "runs", `${sessionID}.json`); const original = "{\"sentinel\":true}";
        await mkdir(join(xdg, "opencode", "sortie-dogs", "reflection", "runs"), { recursive: true }); await writeFile(runFile, original);
        assert.equal(await hooks.tool!.sortie_reflection.execute({ action: "record", layer: "run", scope: "identity", trigger: "t", cause: "c", prevention: "p", evidence: "user-correction", evidenceRef: "r" }, { sessionID, agent: "dog-coordinator" }), "reflection_not_permitted");
        const system = { system: ["base"] }; await hooks["experimental.chat.system.transform"]!({ sessionID }, system);
        assert.deepEqual(system.system, ["base"]); assert.equal(await readFile(runFile, "utf8"), original);
      }
    } finally { if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldXdg; await rm(xdg, { recursive: true, force: true }); }
  });
});

test("reflection deletion closes a root before deleting its completed in-flight record", async () => {
  await withProject("reflection-delete-barrier", async (directory) => {
    const oldXdg = process.env.XDG_CONFIG_HOME, xdg = await mkdtemp(join(testEnvironment, "reflection-delete-xdg-")); let unblock!: () => void, begun!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; }), started = new Promise<void>((resolve) => { begun = resolve; }); const original = ReflectionStore.prototype.record;
    try {
      process.env.XDG_CONFIG_HOME = xdg; await mkdir(join(directory, ".opencode"), { recursive: true }); await writeFile(join(directory, ".opencode", "sortie-dogs.json"), JSON.stringify({ reflection: { enabled: true } }));
      ReflectionStore.prototype.record = async function (...args: Parameters<ReflectionStore["record"]>) { begun(); await blocked; return await original.apply(this, args); };
      const hooks = await SortieDogsPlugin({ directory, client: { session: { get: async () => ({ data: { agent: "dog-coordinator" } }) } } as never }); const root = "delete-root";
      await hooks["chat.message"]!({ sessionID: root, agent: "dog-coordinator" }, { message: { model: {} }, parts: [{ type: "text", text: "root" }] }); const execute = hooks.tool!.sortie_reflection.execute;
      const recording = execute({ action: "record", layer: "run", scope: "delete", trigger: "t", cause: "c", prevention: "p", evidence: "user-correction", evidenceRef: "r" }, { sessionID: root, agent: "dog-coordinator" }); await started;
      const deleting = hooks.event!({ event: { type: "session.deleted", properties: { sessionID: root } } });
      assert.equal(await execute({ action: "record", layer: "run", scope: "late", trigger: "t", cause: "c", prevention: "p", evidence: "user-correction", evidenceRef: "r" }, { sessionID: root, agent: "dog-coordinator" }), "reflection_not_permitted");
      unblock(); await recording; await deleting;
      assert.equal(await stat(join(xdg, "opencode", "sortie-dogs", "reflection", "runs", `${root}.json`)).catch(() => undefined), undefined);
    } finally { ReflectionStore.prototype.record = original; if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldXdg; await rm(xdg, { recursive: true, force: true }); }
  });
});

test("reflection remains byte and storage passive when disabled", async () => {
  await withProject("reflection-disabled", async (directory) => {
    const oldXdg = process.env.XDG_CONFIG_HOME;
    try {
      const xdg = await mkdtemp(join(testEnvironment, "reflection-disabled-xdg-")); process.env.XDG_CONFIG_HOME = xdg;
      const hooks = await SortieDogsPlugin({ directory });
      assert.equal(hooks.tool?.sortie_reflection, undefined);
      assert.equal(hooks["experimental.chat.system.transform"], undefined);
      await hooks["chat.message"]!({ sessionID: "disabled", agent: "dog-coordinator" }, { message: { model: {} }, parts: [{ type: "text", text: "unchanged" }] });
      assert.equal(await stat(join(xdg, "opencode", "sortie-dogs", "reflection")).catch(() => undefined), undefined);
      await rm(xdg, { recursive: true, force: true });
    } finally { if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldXdg; }
  });
});

function operationManifest(write: string[]): Record<string, unknown> {
  return { ...fixture.manifest, write };
}

function writeGateHandoff(projectRoot: string, manifestPath: string): Record<string, unknown> {
  return {
    ...fixture.handoffs.valid,
    ext: {
      "sortie-dogs/write-gate": {
        operation_manifest: manifestPath,
        project_root: projectRoot,
      },
    },
  };
}

async function activate(
  hooks: Awaited<ReturnType<typeof SortieDogsPlugin>>,
  sessionID = "plugin-session",
): Promise<void> {
  const chat = hooks["chat.message"];
  assert.ok(chat);
  await chat(
    { sessionID },
    { message: { model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: "/sortie task" }] },
  );
}

async function bindWriteGate(
  hooks: Awaited<ReturnType<typeof SortieDogsPlugin>>,
  directory: string,
  sessionID = "plugin-session",
  manifestPath = "operation-manifest.json",
  handoffDirectory = directory,
): Promise<Record<string, unknown>> {
  const handoffPath = join(handoffDirectory, "handoff.json");
  await readFile(handoffPath, "utf8").catch(async () => {
    await writeFile(handoffPath, JSON.stringify(writeGateHandoff(directory, manifestPath)));
  });
  // Some denial fixtures intentionally provide an invalid handoff or manifest and assert the bind
  // result rather than the read-hook error. Production callers see the inspection error directly.
  await inspectHandoffWithRead(hooks, handoffPath, sessionID).catch(() => undefined);
  return await executeBindWriteGate(hooks, directory, sessionID, manifestPath);
}

async function inspectHandoffWithRead(
  hooks: Awaited<ReturnType<typeof SortieDogsPlugin>>,
  handoffPath: string,
  sessionID: string,
): Promise<void> {
  const before = hooks["tool.execute.before"];
  const after = hooks["tool.execute.after"];
  assert.ok(before);
  assert.ok(after);
  const args = { filePath: handoffPath };
  await before({ tool: "read", sessionID, callID: `read-${sessionID}` }, { args });
  await after({ tool: "read", sessionID, callID: `read-${sessionID}`, args }, { output: "read" });
}

async function readDenialMessage(
  hooks: Awaited<ReturnType<typeof SortieDogsPlugin>>,
  handoffPath: string,
  sessionID = "plugin-session",
): Promise<string> {
  try {
    await inspectHandoffWithRead(hooks, handoffPath, sessionID);
  } catch (error) {
    return (error as Error).message;
  }
  assert.fail("expected the registered handoff read to be denied");
}

async function executeBindWriteGate(
  hooks: Awaited<ReturnType<typeof SortieDogsPlugin>>,
  directory: string,
  sessionID = "plugin-session",
  manifestPath = "operation-manifest.json",
): Promise<Record<string, unknown>> {
  const binding = hooks.tool?.sortie_bind_write_gate as unknown as {
    execute(args: { project_root: string; manifest_path: string }, context: { sessionID: string }): Promise<string>;
  } | undefined;
  assert.ok(binding);
  return JSON.parse(await binding.execute(
    { project_root: directory, manifest_path: manifestPath },
    { sessionID },
  )) as Record<string, unknown>;
}

async function invokeWrite(
  hooks: Awaited<ReturnType<typeof SortieDogsPlugin>>,
  target: string,
  directory: string,
  manifestPath = "operation-manifest.json",
  handoffDirectory = directory,
): Promise<void> {
  await activate(hooks);
  await bindWriteGate(hooks, directory, "plugin-session", manifestPath, handoffDirectory);
  const before = hooks["tool.execute.before"];
  assert.ok(before);
  await before(
    { tool: "write", sessionID: "plugin-session", callID: "plugin-call" },
    { args: { file: target, content: "PRIVATE_WRITE_CONTENT" } },
  );
}

async function expectMessage(
  action: () => Promise<void>,
  expected: string,
  reason?: string,
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, expected);
    assert.equal(error.message.includes("PRIVATE_"), false);
    if (reason !== undefined) {
      assert.equal(error.name.endsWith("DeniedError"), true);
      assert.equal((error as Error & { reason?: string }).reason, reason);
    }
    return true;
  });
}

async function expectActionableCommandDenial(
  action: () => Promise<void>,
  cause?: string,
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { reason?: string }).reason, "unclassified-command");
    assert.match(error.message, /segment=.+; cause=.+; hint=.+/u);
    assert.equal(error.message.includes("<unknown>"), false);
    if (cause !== undefined) assert.match(error.message, new RegExp(`cause=${cause}`, "u"));
    return true;
  });
}

test("chat message hook applies explicit catalog routing and fails closed with ordered attempts", async () => {
  await withProject("model-routing-hook", async (directory) => {
    await mkdir(join(directory, ".opencode"));
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    await writeFile(join(directory, ".opencode", "sortie-dogs.json"), JSON.stringify({
      modelRouting: {
        implementer: { preferred: { model: "provider/local-primary", variant: "thinking" } },
        reviewer: {
          preferred: { model: "provider/local-missing" },
          fallback: [{ model: "provider/variant", variant: "missing" }],
        },
      },
    }));
    const client = { config: { providers: async () => ({ data: { providers: [
      { id: "provider", models: { "local-primary": { id: "local-primary" } } },
      { id: "openai", models: {
        "gpt-5.6-luna": { id: "gpt-5.6-luna" },
        "gpt-5.6-sol": { id: "gpt-5.6-sol" },
        "gpt-5.6-terra": { id: "gpt-5.6-terra" },
      } },
    ] } }) } };
    const hooks = await SortieDogsPlugin({ directory, client }, {
      modelRouting: {
        implementer: { preferred: { model: "provider/global-primary", variant: "thinking" } },
        reviewer: {
          preferred: { model: "provider/global-missing" },
          fallback: [{ model: "provider/variant", variant: "also-missing" }],
        },
      },
      modelCatalog: { global: [
        { model: "openai/gpt-5.6-luna", variants: ["xhigh"] },
        { model: "provider/local-primary", variants: ["thinking"] },
        { model: "provider/global-primary", variants: ["thinking"] },
        { model: "provider/variant", variants: ["valid"] },
      ] },
    });
    const chat = hooks["chat.message"];
    assert.ok(chat);
    const output = {
      message: { agent: "implementer", model: { providerID: "old", modelID: "old", variant: "old" } },
      parts: [{ type: "text", text: "/sortie route" }],
    };
    await chat({ sessionID: "routing", agent: "implementer" }, output);
    assert.deepEqual(output.message.model, { providerID: "provider", modelID: "local-primary", variant: "thinking" });
    const unclassified = { message: { model: { providerID: "host", modelID: "preserved" } }, parts: [] };
    await chat({ sessionID: "routing" }, unclassified);
    assert.deepEqual(unclassified.message.model, { providerID: "host", modelID: "preserved" });
    const unconfigured = {
      message: { agent: "planning", model: { providerID: "host", modelID: "session-fallback" } },
      parts: [],
    };
    await chat({ sessionID: "routing", agent: "planning" }, unconfigured);
    assert.deepEqual(unconfigured.message.model, { providerID: "host", modelID: "session-fallback" });
    const recommended = {
      message: { agent: "dog-scout", model: { providerID: "host", modelID: "selected" } },
      parts: [],
    };
    await chat({ sessionID: "routing", agent: "dog-scout" }, recommended);
    assert.deepEqual(recommended.message.model, {
      providerID: "openai",
      modelID: "gpt-5.6-luna",
      variant: RECOMMENDED_SCOUT_VARIANT,
    });
    const coordinator = {
      message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } },
      parts: [],
    };
    await chat({ sessionID: "routing", agent: "dog-coordinator" }, coordinator);
    assert.deepEqual(coordinator.message.model, {
      providerID: "openai",
      modelID: "gpt-5.6-terra",
      variant: DEFAULT_COORDINATOR_VARIANT,
    });
    for (const role of RECOMMENDED_CONSULTATION_ROLES) {
      const consultation = {
        message: { agent: role, model: { providerID: "openai", modelID: "gpt-5.6-luna", variant: "xhigh" } },
        parts: [],
      };
      await chat({ sessionID: "routing", agent: role }, consultation);
      assert.deepEqual(consultation.message.model, {
        providerID: "openai",
        modelID: "gpt-5.6-sol",
        variant: "xhigh",
      }, `${role} never keeps the caller model`);
    }
    await assert.rejects(
      () => chat({ sessionID: "routing", agent: "reviewer" }, output),
      (error: unknown) => {
        assert.ok(error instanceof ModelRoutingDeniedError);
        assert.equal(error.reason, "unresolved-role");
        assert.deepEqual(error.attempts, [
          { source: "local", target: { model: "provider/local-missing" }, reason: "model-unavailable" },
          { source: "local", target: { model: "provider/variant", variant: "missing" }, reason: "variant-unavailable" },
          { source: "global", target: { model: "provider/global-missing" }, reason: "model-unavailable" },
          { source: "global", target: { model: "provider/variant", variant: "also-missing" }, reason: "variant-unavailable" },
        ]);
        return true;
      },
    );
  });
});

test("model routing rewrites only targets present in the cached host provider list", async () => {
  await withProject("model-routing-host-present", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    let providerQueries = 0;
    const client = {
      config: {
        providers: async () => {
          providerQueries += 1;
          return { data: { providers: [{ id: "provider", models: { target: { id: "target" } } }] } };
        },
      },
    };
    const hooks = await SortieDogsPlugin({ directory, client }, {
      modelRouting: { implementer: { preferred: { model: "provider/target" } } },
      modelCatalog: { global: [{ model: "provider/target" }] },
    });
    const chat = hooks["chat.message"];
    assert.ok(chat);
    for (const sessionID of ["host-present-1", "host-present-2"]) {
      const output = {
        message: { agent: "implementer", model: { providerID: "host", modelID: "selected" } },
        parts: [],
      };
      await chat({ sessionID, agent: "implementer" }, output);
      assert.deepEqual(output.message.model, { providerID: "provider", modelID: "target" });
    }
    assert.equal(providerQueries, 1);
  });
});

test("consultation routing uses Sol xhigh before free tier when Opus is absent from the host", async () => {
  await withProject("model-routing-consultation-host-fallback", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    const hooks = await SortieDogsPlugin({
      directory,
      client: {
        // The legacy configured-provider catalog can contain models hidden from the current picker.
        config: { providers: async () => ({ data: { providers: [
          { id: "anthropic", models: { "claude-opus-5": { id: "claude-opus-5" } } },
          { id: "openai", models: { "gpt-5.6-sol": { id: "gpt-5.6-sol" } } },
        ] } }) },
        provider: { list: async () => ({ data: {
          all: [
            { id: "anthropic", models: { "claude-opus-5": { id: "claude-opus-5" } } },
            { id: "openai", models: { "gpt-5.6-sol": { id: "gpt-5.6-sol" } } },
            { id: "opencode", models: { "deepseek-v4-flash-free": { id: "deepseek-v4-flash-free" } } },
          ],
          connected: ["openai", "opencode"],
        } }) },
      },
    }, {
      dedicatedWorkerModel: { model: "openai/gpt-5.6-sol" },
      modelCatalog: { global: [{ model: RECOMMENDED_CONSULTATION_MODEL }] },
    });
    const chat = hooks["chat.message"];
    assert.ok(chat);
    for (const role of RECOMMENDED_CONSULTATION_ROLES) {
      const output = {
        message: { agent: role, model: { providerID: "host", modelID: "selected" } },
        parts: [],
      };
      await chat({ sessionID: `consultation-host-fallback-${role}`, agent: role }, output);
      assert.deepEqual(output.message.model, {
        providerID: "openai",
        modelID: "gpt-5.6-sol",
        variant: CONSULTATION_FALLBACK_VARIANT,
      });
    }
  });
});

test("model routing refreshes a missing cached target at most once per minute before degrading", async () => {
  await withProject("model-routing-host-refresh", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    let providerQueries = 0;
    const client = { config: { providers: async () => {
      providerQueries += 1;
      return { data: { providers: [{ id: "provider", models: providerQueries === 1
        ? { free: { id: "free" } }
        : { target: { id: "target" }, free: { id: "free" } } }] } };
    } } };
    const hooks = await SortieDogsPlugin({ directory, client }, {
      modelRouting: { implementer: { preferred: { model: "provider/target" } } },
      modelCatalog: { global: [{ model: "provider/target" }] },
      freeTierFallbackModels: ["provider/free"],
    });
    const chat = hooks["chat.message"];
    assert.ok(chat);
    let now = 1_000;
    const originalNow = Date.now;
    const originalWarn = console.warn;
    Date.now = () => now;
    console.warn = () => {};
    try {
      const first = { message: { agent: "implementer", model: { providerID: "host", modelID: "selected" } }, parts: [] };
      await chat({ sessionID: "refresh-1", agent: "implementer" }, first);
      assert.deepEqual(first.message.model, { providerID: "provider", modelID: "free" });
      now += 59_999;
      await chat({ sessionID: "refresh-2", agent: "implementer" }, first);
      assert.equal(providerQueries, 1);
      now += 1;
      const refreshed = { message: { agent: "implementer", model: { providerID: "host", modelID: "selected" } }, parts: [] };
      await chat({ sessionID: "refresh-3", agent: "implementer" }, refreshed);
      assert.deepEqual(refreshed.message.model, { providerID: "provider", modelID: "target" });
      assert.equal(providerQueries, 2);
    } finally {
      Date.now = originalNow;
      console.warn = originalWarn;
    }
  });
});

test("model routing uses the literal free fallback for fixed roles, drops variants, and warns per role per session", async () => {
  await withProject("model-routing-host-absent", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...arguments_: unknown[]) => { warnings.push(arguments_); };
    try {
       const hooks = await SortieDogsPlugin({
         directory,
         client: { config: { providers: async () => ({
           data: { providers: [{ id: "opencode", models: {
             "deepseek-v4-flash-free": { id: "deepseek-v4-flash-free" },
           } }] },
         }) } },
       });
      const chat = hooks["chat.message"];
      assert.ok(chat);
      const output = {
         message: { agent: "dog-worker", model: { providerID: "host", modelID: "selected", variant: "host" } },
        parts: [],
      };
       await chat({ sessionID: "host-absent-1", agent: "dog-worker" }, output);
       await chat({ sessionID: "host-absent-1", agent: "dog-worker" }, output);
       assert.deepEqual(output.message.model, {
         providerID: "opencode",
         modelID: "deepseek-v4-flash-free",
       });
       const otherRole = {
         message: { agent: "implementation", model: { providerID: "host", modelID: "selected", variant: "host" } },
         parts: [],
       };
       await chat({ sessionID: "host-absent-1", agent: "implementation" }, otherRole);
       await chat({ sessionID: "host-absent-2", agent: "dog-worker" }, output);
       assert.equal(warnings.length, 3);
       assert.match(String(warnings[0][0]), /Degraded model routing/u);
       assert.match(String(warnings[0][0]), /dog-worker/u);
       assert.match(String(warnings[0][0]), /opencode\/deepseek-v4-flash-free/u);
    } finally {
      console.warn = originalWarn;
    }
  });
});

test("model routing fails open when host availability cannot be determined", async () => {
  await withProject("model-routing-host-unknown", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    let providerQueries = 0;
    const hooks = await SortieDogsPlugin({
      directory,
      client: { config: { providers: async () => {
        providerQueries += 1;
        throw new Error("provider listing unavailable");
      } } },
    }, {
      modelRouting: { implementer: { preferred: { model: "provider/target" } } },
      modelCatalog: { global: [{ model: "provider/target" }] },
    });
    const chat = hooks["chat.message"];
    assert.ok(chat);
    const output = {
      message: { agent: "implementer", model: { providerID: "host", modelID: "selected" } },
      parts: [],
    };
    await chat({ sessionID: "host-unknown", agent: "implementer" }, output);
     assert.deepEqual(output.message.model, { providerID: "host", modelID: "selected" });
    assert.equal(providerQueries, 1);
  });
});

test("model routing discovers a deterministically sorted free model after configured literal misses", async () => {
  await withProject("model-routing-free-discovery", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    const hooks = await SortieDogsPlugin({
      directory,
      client: { config: { providers: async () => ({ data: { providers: [{
        id: "provider",
        models: {
          "z-free": { id: "z-free" },
          "a-free": { id: "a-free" },
        },
      }, {
        id: "aaa",
        models: { "0-free": { id: "0-free" } },
      }] } }) } },
    }, {
      modelRouting: { implementer: { preferred: { model: "provider/target", variant: "thinking" } } },
      modelCatalog: { global: [{ model: "provider/target", variants: ["thinking"] }] },
      freeTierFallbackModels: ["provider/not-hosted-free"],
    });
    const chat = hooks["chat.message"];
    assert.ok(chat);
    const output = {
      message: { agent: "implementer", model: { providerID: "host", modelID: "selected", variant: "host" } },
      parts: [],
    };
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await chat({ sessionID: "free-discovery", agent: "implementer" }, output);
    } finally {
      console.warn = originalWarn;
    }
    assert.deepEqual(output.message.model, { providerID: "provider", modelID: "a-free" });
  });
});

test("model routing treats missing and empty host model lists as unknown", async () => {
  await withProject("model-routing-host-list-unknown", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    const options = {
      modelRouting: { implementer: { preferred: { model: "provider/target" } } },
      modelCatalog: { global: [{ model: "provider/target" }] },
    };
    const withoutClient = await SortieDogsPlugin({ directory }, options);
    const emptyClient = await SortieDogsPlugin({
      directory,
      client: { config: { providers: async () => ({ data: { providers: [] } }) } },
    }, options);
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...arguments_: unknown[]) => { warnings.push(arguments_); };
    try {
      for (const [name, hooks] of [["missing", withoutClient], ["empty", emptyClient]] as const) {
        const chat = hooks["chat.message"];
        assert.ok(chat);
        const output = {
          message: { agent: "implementer", model: { providerID: "host", modelID: name, variant: "host" } },
          parts: [],
        };
        const originalModel = output.message.model;
        await chat({ sessionID: `host-list-${name}`, agent: "implementer" }, output);
        await chat({ sessionID: `host-list-${name}-again`, agent: "implementer" }, output);
        assert.strictEqual(output.message.model, originalModel);
      }
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /implementer/u);
  });
});

test("an explicitly empty free fallback list disables degraded routing", async () => {
  await withProject("model-routing-free-disabled", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    const hooks = await SortieDogsPlugin({
      directory,
      client: { config: { providers: async () => ({ data: { providers: [{
        id: "opencode",
        models: { "deepseek-v4-flash-free": { id: "deepseek-v4-flash-free" } },
      }] } }) } },
    }, {
      modelRouting: { implementer: { preferred: { model: "provider/target" } } },
      modelCatalog: { global: [{ model: "provider/target" }] },
      freeTierFallbackModels: [],
    });
    const chat = hooks["chat.message"];
    assert.ok(chat);
    const output = {
      message: { agent: "implementer", model: { providerID: "host", modelID: "selected" } },
      parts: [],
    };
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await chat({ sessionID: "free-disabled", agent: "implementer" }, output);
    } finally {
      console.warn = originalWarn;
    }
    assert.deepEqual(output.message.model, { providerID: "host", modelID: "selected" });
  });
});

test("every packaged role follows default routing independently of write-gate activation", async () => {
  await withProject("model-routing-inactive", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    const client = { config: { providers: async () => ({ data: { providers: [{
      id: "openai",
      models: {
        "gpt-5.6-luna": { id: "gpt-5.6-luna" },
        "gpt-5.6-sol": { id: "gpt-5.6-sol" },
        "gpt-5.6-terra": { id: "gpt-5.6-terra" },
      },
    }] } }) } };
    const hooks = await SortieDogsPlugin({ directory, client });
    const chat = hooks["chat.message"];
    assert.ok(chat);
    const expected: Record<string, { providerID: string; modelID: string; variant?: string }> = {
      "dog-coordinator": {
        providerID: "openai",
        modelID: "gpt-5.6-terra",
        variant: DEFAULT_COORDINATOR_VARIANT,
      },
      "dog-scout": { providerID: "openai", modelID: "gpt-5.6-luna", variant: RECOMMENDED_SCOUT_VARIANT },
      "dog-worker": { providerID: "openai", modelID: "gpt-5.6-luna", variant: DEDICATED_WORKER_VARIANT },
      "dog-reviewer": { providerID: "openai", modelID: "gpt-5.6-sol", variant: CONSULTATION_FALLBACK_VARIANT },
      "dog-advisor": { providerID: "openai", modelID: "gpt-5.6-sol", variant: CONSULTATION_FALLBACK_VARIANT },
    };
    for (const [role, target] of Object.entries(expected)) {
      // A consultation or evidence session carries no /sortie trigger and no worker handoff.
      const output = {
        message: { agent: role, model: { providerID: "openai", modelID: "gpt-5.6-luna", variant: "xhigh" } },
        parts: [{ type: "text", text: "Answer one bounded question." }],
      };
      await chat({ sessionID: `inactive-${role}`, agent: role }, output);
      assert.deepEqual(output.message.model, target, `${role} must be routed without activation`);
    }
    const unrouted = {
      message: { agent: "plan", model: { providerID: "host", modelID: "session-default" } },
      parts: [{ type: "text", text: "unrelated" }],
    };
    await chat({ sessionID: "inactive-plan", agent: "plan" }, unrouted);
    assert.deepEqual(unrouted.message.model, { providerID: "host", modelID: "session-default" });

  });
});

test("a declared coordinator route still applies, because the host asked for it", async () => {
  await withProject("coordinator-route-declared", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    await mkdir(join(directory, ".opencode"), { recursive: true });
    await writeFile(
      join(directory, ".opencode", "sortie-dogs.json"),
      JSON.stringify({
        modelRouting: { "dog-coordinator": { preferred: { model: "openai/gpt-5.6-luna", variant: "max" } } },
        modelCatalog: { project: [{ model: "openai/gpt-5.6-luna", variants: ["max"] }] },
      }),
    );
    const client = { config: { providers: async () => ({ data: { providers: [
      { id: "openai", models: { "gpt-5.6-luna": { id: "gpt-5.6-luna" } } },
    ] } }) } };
    const hooks = await SortieDogsPlugin({ directory, client });
    const chat = hooks["chat.message"];
    assert.ok(chat);
    const declared = {
      message: { agent: "dog-coordinator", model: { providerID: "anthropic", modelID: "claude-opus-5" } },
      parts: [{ type: "text", text: "continue the batch" }],
    };
    await chat({ sessionID: "declared-coordinator", agent: "dog-coordinator" }, declared);
    assert.deepEqual(declared.message.model, {
      providerID: "openai",
      modelID: "gpt-5.6-luna",
      variant: "max",
    });
  });
});

test("an empty task result is repaired from the child session instead of re-dispatched", async () => {
  await withProject("task-result-repair", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    const requested: unknown[] = [];
    // The exact shape the defect produced: real answer, then a trailing empty text part.
    const child = [
      { info: { role: "user" }, parts: [{ type: "text", text: "dispatch" }] },
      {
        info: { role: "assistant" },
        parts: [
          { type: "reasoning" },
          { type: "text", text: "status: READY\ntask_id: PVTI-1\n" },
          { type: "reasoning" },
          { type: "text", text: "" },
        ],
      },
    ];
    const client = {
      session: {
        messages: async (request: { path: { id: string } }) => {
          requested.push(request);
          return { data: child };
        },
      },
    };
    const hooks = await SortieDogsPlugin({ directory, client });
    const after = hooks["tool.execute.after"];
    assert.ok(after);

    const emptyResult = {
      output: '<task id="ses_child" state="completed">\n<task_result>\n\n</task_result>\n</task>',
      metadata: { sessionId: "ses_child", parentSessionId: "ses_parent" },
    };
    await after({ tool: "task", sessionID: "ses_parent" }, emptyResult);
    assert.deepEqual(requested, [{ path: { id: "ses_child" } }]);
    assert.equal(
      emptyResult.output,
      '<task id="ses_child" state="completed">\n<task_result>\nstatus: READY\ntask_id: PVTI-1\n</task_result>\n</task>',
    );

    // A result the host already filled in must survive byte-identical.
    const intact = {
      output: '<task id="ses_child" state="completed">\n<task_result>\nPONG\n</task_result>\n</task>',
      metadata: { sessionId: "ses_child" },
    };
    const intactOutput = intact.output;
    await after({ tool: "task", sessionID: "ses_parent" }, intact);
    assert.equal(intact.output, intactOutput);

    // Other tools, other output shapes, and unreadable children are never rewritten.
    const foreign = { output: "<task_result>\n\n</task_result>", metadata: { sessionId: "ses_child" } };
    await after({ tool: "bash", sessionID: "ses_parent" }, foreign);
    assert.equal(foreign.output, "<task_result>\n\n</task_result>");

    const silent = await SortieDogsPlugin({
      directory,
      client: { session: { messages: async () => { throw new Error("unreachable"); } } },
    });
    const failing = {
      output: '<task id="ses_child" state="completed">\n<task_result>\n\n</task_result>\n</task>',
      metadata: { sessionId: "ses_child" },
    };
    const failingOutput = failing.output;
    await silent["tool.execute.after"]!({ tool: "task", sessionID: "ses_parent" }, failing);
    assert.equal(failing.output, failingOutput);

    // A child that produced no text at all leaves the empty result for the coordinator to handle.
    const blank = await SortieDogsPlugin({
      directory,
      client: {
        session: {
          messages: async () => ({
            data: [{ info: { role: "assistant" }, parts: [{ type: "reasoning" }, { type: "text", text: "  " }] }],
          }),
        },
      },
    });
    const unrecoverable = {
      output: '<task id="ses_child" state="completed">\n<task_result>\n\n</task_result>\n</task>',
      metadata: { sessionId: "ses_child" },
    };
    const unrecoverableOutput = unrecoverable.output;
    await blank["tool.execute.after"]!({ tool: "task", sessionID: "ses_parent" }, unrecoverable);
    assert.equal(unrecoverable.output, unrecoverableOutput);
  });
});

test("task result repair never substitutes an earlier turn for a silent final turn", () => {
  // Reaching back would answer a later dispatch with an earlier answer.
  assert.equal(
    lastAssistantText([
      { info: { role: "assistant" }, parts: [{ type: "text", text: "first answer" }] },
      { info: { role: "user" }, parts: [{ type: "text", text: "second dispatch" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "" }] },
    ]),
    undefined,
  );
  // A host that reports the role on the message itself resolves the same way.
  assert.equal(
    lastAssistantText([{ role: "assistant", parts: [{ type: "text", text: " kept " }] }]),
    "kept",
  );
  // Host-injected reminders are not the child's answer.
  assert.equal(
    lastAssistantText([{
      role: "assistant",
      parts: [{ type: "text", text: "answer" }, { type: "text", text: "reminder", synthetic: true }],
    }]),
    "answer",
  );
});

test("worker activation accepts the dispatch layout the shipped coordinator asset prescribes", () => {
  const coordinator = runtimeAssets.find((asset) => asset.name === "dog-coordinator");
  assert.ok(coordinator);
  const dispatch = /INITIAL_HANDOFF_FIXTURE\r?\n([\s\S]*?)END_INITIAL_HANDOFF_FIXTURE/u
    .exec(coordinator.content)?.[1];
  assert.ok(dispatch);
  assert.equal(isExplicitTaskHandoff(dispatch), true);
});

test("proven silent consultation agents get isolated parent-scoped fallback retries", async () => {
  await withProject("silent-review-fallback", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    const identities: Record<string, Record<string, unknown>> = {
      review1: { agent: "dog-reviewer", parentID: "parent" },
      review2: { agent: "dog-reviewer", parentID: "parent" },
      advisor1: { agent: "dog-advisor", parentID: "parent" },
      advisor2: { agent: "dog-advisor", parentID: "parent" },
      worker1: { agent: "dog-worker", parentID: "parent-worker" },
      unknown1: { parentID: "parent-unknown" },
    };
    const client = {
      config: { providers: async () => ({ data: { providers: [
        { id: "anthropic", models: { "claude-opus-5": { id: "claude-opus-5" } } },
        { id: "openai", models: { "gpt-5.6-sol": { id: "gpt-5.6-sol" } } },
      ] } }) },
      session: {
        get: async ({ path }: { path: { id: string } }) => ({ data: identities[path.id] }),
        messages: async () => ({ data: [{ info: { role: "assistant" }, parts: [
          { type: "reasoning" }, { type: "text", text: "" },
        ] }] }),
      },
    };
    const hooks = await SortieDogsPlugin({ directory, client }, {
      modelCatalog: { global: [
        { model: RECOMMENDED_CONSULTATION_MODEL },
        { model: "openai/gpt-5.6-sol", variants: [CONSULTATION_FALLBACK_VARIANT] },
      ] },
    });
    const chat = hooks["chat.message"]!;
    const after = hooks["tool.execute.after"]!;
    const emptyTask = (child: string, parent: string) => ({
      output: `<task><task_result>\n\n</task_result></task>`,
      metadata: { sessionId: child, parentSessionId: parent },
    });
    for (const [role, firstChild, retryChild] of [
      ["dog-reviewer", "review1", "review2"],
      ["dog-advisor", "advisor1", "advisor2"],
    ] as const) {
      const firstDispatch = {
        message: { agent: role, model: { providerID: "host", modelID: "selected" } },
        parts: [],
      };
      await chat({ sessionID: firstChild, agent: role, parentID: "parent" } as never, firstDispatch);
      assert.deepEqual(firstDispatch.message.model, { providerID: "anthropic", modelID: "claude-opus-5" });

      const firstSilent = emptyTask(firstChild, "parent");
      await after({ tool: "task", sessionID: "parent" }, firstSilent);
      assert.equal(firstSilent.output.includes(CONSULTATION_FALLBACK_RETRY_MARKER), true);
      assert.equal(firstSilent.output.includes(`role=${role}`), true);

      const retryDispatch = {
        message: { agent: role, model: { providerID: "host", modelID: "selected" } },
        parts: [],
      };
      await chat({ sessionID: retryChild, agent: role, parentID: "parent" } as never, retryDispatch);
      assert.deepEqual(retryDispatch.message.model, {
        providerID: "openai",
        modelID: "gpt-5.6-sol",
        variant: CONSULTATION_FALLBACK_VARIANT,
      });
      const secondSilent = emptyTask(retryChild, "parent");
      const secondOriginal = secondSilent.output;
      await after({ tool: "task", sessionID: "parent" }, secondSilent);
      assert.equal(secondSilent.output, secondOriginal);
    }

    for (const [child, parent] of [["worker1", "parent-worker"], ["unknown1", "parent-unknown"]]) {
      const unchanged = emptyTask(child, parent);
      const original = unchanged.output;
      await after({ tool: "task", sessionID: parent }, unchanged);
      assert.equal(unchanged.output, original);
    }
  });
});

test("parallel silent consultation results emit at most one marker per parent and role", async () => {
  await withProject("parallel-silent-consultation", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    const identities = {
      first: { agent: "dog-advisor", parentID: "parent" },
      second: { agent: "dog-advisor", parentID: "parent" },
    };
    const hooks = await SortieDogsPlugin({
      directory,
      client: { session: {
        get: async ({ path }: { path: { id: keyof typeof identities } }) => ({ data: identities[path.id] }),
        messages: async () => ({ data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "" }] }] }),
      } },
    });
    const empty = (child: keyof typeof identities) => ({
      output: "<task><task_result>\n\n</task_result></task>",
      metadata: { sessionId: child },
    });
    const outputs = [empty("first"), empty("second")];
    await Promise.all(outputs.map((output) =>
      hooks["tool.execute.after"]!({ tool: "task", sessionID: "parent" }, output)
    ));
    assert.equal(outputs.filter((output) => output.output.includes(CONSULTATION_FALLBACK_RETRY_MARKER)).length, 1);
  });
});

test("consultation retry tombstones survive unrelated active parents", async () => {
  await withProject("consultation-retry-tombstones", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    const hooks = await SortieDogsPlugin({
      directory,
      client: { session: {
        get: async ({ path }: { path: { id: string } }) => {
          const parentID = path.id.startsWith("repeat-") ? path.id.slice("repeat-".length) : path.id.slice("child-".length);
          return { data: { agent: "dog-reviewer", parentID } };
        },
        messages: async () => ({ data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "" }] }] }),
      } },
    });
    const after = hooks["tool.execute.after"]!;
    for (let index = 0; index < 257; index += 1) {
      const parent = `parent-${index}`;
      const output = { output: "<task><task_result>\n\n</task_result></task>", metadata: { sessionId: `child-${parent}` } };
      await after({ tool: "task", sessionID: parent }, output);
      assert.equal(output.output.includes(CONSULTATION_FALLBACK_RETRY_MARKER), true);
    }
    const repeated = { output: "<task><task_result>\n\n</task_result></task>", metadata: { sessionId: "repeat-parent-0" } };
    const original = repeated.output;
    await after({ tool: "task", sessionID: "parent-0" }, repeated);
    assert.equal(repeated.output, original);
  });
});

test("failed consultation fallback routing rolls back its one-shot reservation", async () => {
  await withProject("consultation-fallback-rollback", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    const identities = {
      initial: { agent: "dog-advisor", parentID: "parent" },
      retry1: { agent: "dog-advisor", parentID: "parent" },
      retry2: { agent: "dog-advisor", parentID: "parent" },
    };
    const hooks = await SortieDogsPlugin({
      directory,
      client: { session: {
        get: async ({ path }: { path: { id: keyof typeof identities } }) => ({ data: identities[path.id] }),
        messages: async () => ({ data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "" }] }] }),
      } },
    }, {
      modelRouting: { "dog-advisor": {
        preferred: { model: "provider/primary" },
        fallback: [{ model: "provider/missing" }],
      } },
      modelCatalog: { project: [{ model: "provider/primary" }] },
    });
    const silent = { output: "<task><task_result>\n\n</task_result></task>", metadata: { sessionId: "initial" } };
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "parent" }, silent);
    assert.equal(silent.output.includes(CONSULTATION_FALLBACK_RETRY_MARKER), true);

    for (const child of ["retry1", "retry2"] as const) {
      const output = { message: { agent: "dog-advisor", model: { providerID: "host", modelID: "selected" } }, parts: [] };
      await assert.rejects(
        () => hooks["chat.message"]!({ sessionID: child, agent: "dog-advisor", parentID: "parent" } as never, output),
        ModelRoutingDeniedError,
      );
    }
  });
});

test("silent reviewer retry respects the first configured consultation fallback", async () => {
  const resolution = resolveModelRoute({
    role: "dog-reviewer",
    local: { "dog-reviewer": {
      preferred: { model: "vendor/preferred" },
      fallback: [
        { model: "vendor/fallback", variant: "deep" },
        { model: "vendor/later" },
      ],
    } },
    catalog: { project: [
      { model: "vendor/preferred" },
      { model: "vendor/fallback", variants: ["deep"] },
      { model: "vendor/later" },
    ] },
    skipPreferred: true,
  });
  assert.deepEqual(resolution, {
    ok: true,
    role: "dog-reviewer",
    source: "local",
    catalog: "project",
    model: "vendor/fallback",
    variant: "deep",
  });
});

test("session-inactive redispatch fixture is a complete fresh worker handoff", () => {
  const coordinator = runtimeAssets.find((asset) => asset.name === "dog-coordinator");
  assert.ok(coordinator);
  const dispatch = /FRESH_REDISPATCH_HANDOFF_FIXTURE\r?\n([\s\S]*?)END_FRESH_REDISPATCH_HANDOFF_FIXTURE/u
    .exec(coordinator.content)?.[1];
  assert.ok(dispatch);
  assert.equal(isExplicitTaskHandoff(dispatch), true);
  assert.match(dispatch, /^\s*role:\s*implementation\s*$/mu);
  assert.match(dispatch, /^\s*project_root:\s*<absolute project root>\s*$/mu);
  assert.match(dispatch, /^\s*source_manifest:\s*\[<exact source path>\]\s*$/mu);
  assert.match(dispatch, /^\s*acceptance:\s*<fixed acceptance criteria>\s*$/mu);
  assert.match(dispatch, /^\s*validation:\s*\{ level: full, command: <exact command> \}\s*$/mu);
  assert.match(dispatch, /^\s*resume_delta:\s*none\s*$/mu);
  assert.match(dispatch, /operational_variant: source_manifest=none; operation_manifest=<exact absolute operation manifest>/u);

  const resumeOnly = [
    "task_id: task-06",
    "context_digest:",
    "  mode: same-task-resume",
    "  resume_delta:",
    "    next_action: retry bind",
  ].join("\n");
  assert.equal(isExplicitTaskHandoff(resumeOnly), false);
  assert.equal(isExplicitTaskHandoff(dispatch.replace(/^\s*role:.*(?:\r?\n|$)/mu, "")), false);
});

test("worker activation accepts both inline digest and flat wrapper dispatch forms", () => {
  const inlineDigest = [
    "Continue the current candidate and return structured evidence only.",
    "",
    "context_digest:",
    "- task_id: task-06",
    "- project_root: C:\\candidate",
    "- acceptance: move the driver to a real browser flow",
    "- role: blocker-resolution",
    '- validation: { level: targeted, command: "npm test" }',
    '- source_manifest: ["tests/e2e/driver.mjs"]',
    '- operation_manifest: "candidate.operation-manifest.json"',
  ].join("\n");
  const flatWrapper = [
    "role=implementation",
    "projectRoot=C:\\candidate",
    "source_manifest=[src/a.ts]",
    "acceptance: safe change",
  ].join("\n");
  assert.equal(isExplicitTaskHandoff(inlineDigest), true);
  assert.equal(isExplicitTaskHandoff(flatWrapper), true);
});

test("worker activation accepts symmetrically decorated handoff keys and values", () => {
  const decorated = [
    "- **role**: **implementation**",
    "**project_root:** `C:\\candidate`",
    "`source_manifest`: `[src/a.ts]`",
    "_acceptance_: __safe change__",
  ].join("\n");
  assert.equal(isExplicitTaskHandoff(decorated), true);
  assert.equal(isExplicitTaskHandoff("**role** implementation"), false);
  assert.equal(isExplicitTaskHandoff("ordinary prose about **role** and project_root"), false);
});

test("worker activation survives a localized role label", () => {
  // A Japanese request makes the coordinator localize its labels; the role value stays a protocol token.
  const localized = [
    "候補: 本番ライフサイクルE2E",
    "役割: blocker-resolution",
    "",
    "context_digest:",
    "- task_id: task-production-lifecycle-e2e",
    "- project_root: O:\\candidate",
    "- handoff_path: O:\\candidate\\handoff.json",
    "- acceptance: canonical E2Eを完遂する",
    "- operation_manifest: candidate.operation-manifest.json",
  ].join("\n");
  assert.equal(isExplicitTaskHandoff(localized), true);
  // The role token alone is never a dispatch; the remaining contract keys stay mandatory.
  assert.equal(isExplicitTaskHandoff("役割: blocker-resolution"), false);
  assert.equal(
    isExplicitTaskHandoff("同一solSessionをrole=blocker-resolutionで再開する。\nproject_root: O:\\c"),
    false,
  );
});

test("worker activation rejects dispatches without a complete worker contract", () => {
  const unknownRole = [
    "context_digest:",
    "- project_root: C:\\candidate",
    "- acceptance: review only",
    "- role: reviewer",
    "- source_manifest: [src/a.ts]",
  ].join("\n");
  const missingManifest = [
    "context_digest:",
    "- project_root: C:\\candidate",
    "- acceptance: safe change",
    "- role: implementation",
  ].join("\n");
  const missingRoot = [
    "context_digest:",
    "- acceptance: safe change",
    "- role: implementation",
    "- source_manifest: [src/a.ts]",
  ].join("\n");
  assert.equal(isExplicitTaskHandoff(unknownRole), false);
  assert.equal(isExplicitTaskHandoff(missingManifest), false);
  assert.equal(isExplicitTaskHandoff(missingRoot), false);
  assert.equal(isExplicitTaskHandoff("ordinary prose about role and acceptance"), false);
});

test("session policy is passive until an exact trigger and deactivates only on end", async () => {
  await withProject("session-activation", async (directory) => {
    const hooks = await configuredHooks(directory);
    const before = hooks["tool.execute.before"];
    const chat = hooks["chat.message"];
    const event = hooks.event;
    assert.ok(before);
    assert.ok(chat);
    assert.ok(event);
    const write = (sessionID: string) => before(
      { tool: "write", sessionID, callID: "activation" },
      { args: { file: "outside.txt", content: "not-written" } },
    );
    const message = (sessionID: string, text: string, agent?: string) => chat(
      { sessionID, agent },
      { message: { agent, model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text }] },
    );

    await write("passive");
    await message(
      "task-handoff",
      "role=implementation\nprojectRoot=C:\\candidate\ncandidate=card-01\nsource_manifest=[src/a.ts]\nacceptance: safe change",
    );
    await write("task-handoff");
    await message(
      "quoted-handoff",
      "log copy:\nrole=implementation\nprojectRoot=C:\\candidate\ncandidate=card-01\nsource_manifest=[src/a.ts]\nacceptance: safe change",
    );
    await write("quoted-handoff");
    await message(
      "coordinator-task",
      "role=implementation\nprojectRoot=C:\\candidate\ncandidate=card-01\nsource_manifest=[src/a.ts]\nacceptance: safe change",
      "dog-coordinator",
    );
    await write("coordinator-task");
    await message("passive", "/sortie-other");
    await write("passive");
    await message("passive", "/sortie task");
    await message("passive", "/sortie task");
    const isolatedHooks = await SortieDogsPlugin({ directory });
    const isolatedBefore = isolatedHooks["tool.execute.before"];
    assert.ok(isolatedBefore);
    await isolatedBefore(
      { tool: "write", sessionID: "passive", callID: "isolated" },
      { args: { file: "outside.txt", content: "not-written" } },
    );
    await expectMessage(() => write("passive"), 'Write denied for "<unknown>": operation manifest unavailable.', "manifest-unavailable");
    await event({ event: { type: "session.idle", properties: { sessionID: "passive" } } });
    await expectMessage(
      () => write("passive"),
      'Write denied for "<repeated-command>": same command and denial reason already denied in this session; retry blocked.',
      "repeated-denial",
    );
    await event({ event: { type: "session.deleted", properties: { sessionID: "passive" } } });
    await write("passive");

    await message("coordinator", "ordinary text", "dog-coordinator");
    await write("coordinator");
    await event({ event: { type: "session.deleted", properties: { sessionID: "coordinator" } } });
    await write("coordinator");
    await message("malformed", "/sortie task");
    await event({ event: { type: "session.deleted", properties: {} } });
  });
});

test("passive coordinator lineage activates only its Task child without inheriting authorization", async () => {
  await withProject("child-session-activation", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    await writeFile(join(directory, "handoff.json"), JSON.stringify(writeGateHandoff(directory, "operation-manifest.json")));
    const hooks = await SortieDogsPlugin({ directory });
    const chat = hooks["chat.message"];
    const before = hooks["tool.execute.before"];
    const event = hooks.event;
    assert.ok(chat);
    assert.ok(before);
    assert.ok(event);
    await chat(
      { sessionID: "parent", agent: "dog-coordinator" },
      { message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: "ordinary coordinator turn" }] },
    );
    assert.equal((await executeBindWriteGate(hooks, directory, "parent")).reason, "session-inactive");
    await event({ event: { type: "session.created", properties: { info: { id: "child", parentID: "parent", directory } } } });
    assert.equal((await executeBindWriteGate(hooks, directory, "child")).reason, "session-inactive");
    // The shipped coordinator asset dispatches an inline digest, so activation must accept it.
    const task = [
      "context_digest:",
      "  task_id: task-06",
      `  project_root: ${directory}`,
      "  acceptance: safe change",
      "  role: implementation",
      "  source_manifest: [src/a.ts]",
    ].join("\n");
    await chat(
      { sessionID: "child", agent: "renamed-worker" },
      { message: { agent: "renamed-worker", model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: task }] },
    );
    const uninspected = await executeBindWriteGate(hooks, directory, "child");
    assert.equal(uninspected.reason, "handoff-uninspected");
    assert.deepEqual(uninspected.escalation, {
      action: "blocker-resolution-takeover",
      resume_session: true,
      true_blocker: false,
    });
    await inspectHandoffWithRead(hooks, join(directory, "handoff.json"), "child");
    // Inspection is deterministic in the same tool turn; no idle/resume timing dependency remains.
    assert.equal((await executeBindWriteGate(hooks, directory, "child")).status, "bound");
    await before(
      { tool: "write", sessionID: "child", callID: "child-write" },
      { args: { file: "allowed.txt", content: "not-written" } },
    );

    await event({ event: { type: "session.idle", properties: { sessionID: "child" } } });
    await chat(
      { sessionID: "child", agent: "renamed-worker" },
      { message: { agent: "renamed-worker", model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: "resume completed child" }] },
    );
    await before(
      { tool: "write", sessionID: "child", callID: "resumed-child-write" },
      { args: { file: "allowed.txt", content: "not-written" } },
    );

    for (const [sessionID, parentID, projectRoot] of [
      ["inactive-child", "inactive-parent", directory],
      ["other-project-child", "parent", join(directory, "..", "other-project")],
    ]) {
      await event({ event: { type: "session.created", properties: { info: { id: sessionID, parentID, directory: projectRoot } } } });
      await chat(
        { sessionID, agent: "renamed-worker" },
        { message: { agent: "renamed-worker", model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: `role=implementation\nprojectRoot=${projectRoot}\ncandidate=child\nsource_manifest=[src/a.ts]\nacceptance: safe change` }] },
      );
      assert.equal((await executeBindWriteGate(hooks, directory, sessionID)).reason, "session-inactive");
    }

    await event({ event: { type: "session.created", properties: { info: { id: "fresh-child", parentID: "parent", directory } } } });
    await chat(
      { sessionID: "fresh-child", agent: "renamed-worker" },
      { message: { agent: "renamed-worker", model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: task }] },
    );
    assert.equal((await executeBindWriteGate(hooks, directory, "fresh-child")).reason, "handoff-uninspected");

    await chat(
      { sessionID: "deleted-parent", agent: "dog-coordinator" },
      { message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: "ordinary coordinator turn" }] },
    );
    await event({ event: { type: "session.created", properties: { info: { id: "deleted-parent-child", parentID: "deleted-parent" } } } });
    await event({ event: { type: "session.deleted", properties: { sessionID: "deleted-parent" } } });
    await chat(
      { sessionID: "deleted-parent-child", agent: "renamed-worker" },
      { message: { agent: "renamed-worker", model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: task }] },
    );
    assert.equal((await executeBindWriteGate(hooks, directory, "deleted-parent-child")).reason, "session-inactive");
  });
});

test("session-inactive recovery requires a fresh inline-handoff dispatch", async () => {
  await withProject("inactive-redispatch", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    const handoffPath = join(directory, "handoff.json");
    await writeFile(handoffPath, JSON.stringify(writeGateHandoff(directory, "operation-manifest.json")));
    const hooks = await SortieDogsPlugin({ directory });
    const chat = hooks["chat.message"];
    assert.ok(chat);
    await chat(
      { sessionID: "recovery-parent", agent: "dog-coordinator" },
      { message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: "dispatch worker" }] },
    );

    await inspectHandoffWithRead(hooks, handoffPath, "recovery-child");
    const inactive = await executeBindWriteGate(hooks, directory, "recovery-child");
    assert.equal(
      inactive.remedy,
      "Freshly redispatch this worker with prompt text containing role, project_root, source_manifest or operation_manifest, and acceptance or validation fields; a bare resume or file read cannot activate the session.",
    );
    assert.deepEqual(inactive.escalation, {
      action: "redispatch-worker",
      resume_session: false,
      true_blocker: false,
    });

    await chat(
      { sessionID: "recovery-child", parentID: "recovery-parent", agent: "renamed-worker" },
      { message: { agent: "renamed-worker", model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: "resume without handoff fields" }] },
    );
    assert.equal((await executeBindWriteGate(hooks, directory, "recovery-child")).reason, "session-inactive");

    const dispatch = [
      "- **role**: **implementation**",
      `**project_root:** \`${directory}\``,
      "`source_manifest`: `[src/a.ts]`",
      "_acceptance_: __safe change__",
    ].join("\n");
    await chat(
      { sessionID: "recovery-child", parentID: "recovery-parent", agent: "renamed-worker" },
      { message: { agent: "renamed-worker", model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: dispatch }] },
    );
    assert.equal((await bindWriteGate(hooks, directory, "recovery-child")).status, "bound");
  });
});

test("same-fingerprint inspection cannot cross coordinator root lineage", async () => {
  await withProject("child-inspection-fallback", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    await writeFile(join(directory, "handoff.json"), JSON.stringify(writeGateHandoff(directory, "operation-manifest.json")));
    const hooks = await SortieDogsPlugin({ directory });
    const chat = hooks["chat.message"];
    const event = hooks.event;
    assert.ok(chat);
    assert.ok(event);
    for (const sessionID of ["root-a", "root-b"]) {
      await chat(
        { sessionID, agent: "dog-coordinator" },
        { message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: "ordinary" }] },
      );
    }
    await event({ event: { type: "session.created", properties: { info: { id: "owner-child", parentID: "root-a", directory } } } });
    await chat(
      { sessionID: "owner-child", agent: "renamed-worker" },
      { message: { agent: "renamed-worker", model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: `role=implementation\nprojectRoot=${directory}\ncandidate=child\nsource_manifest=[src/a.ts]\nacceptance: safe change` }] },
    );
    await inspectHandoffWithRead(hooks, join(directory, "handoff.json"), "owner-child");
    assert.equal((await executeBindWriteGate(hooks, directory, "owner-child")).status, "bound");
    await event({ event: { type: "session.created", properties: { info: { id: "fallback-child", parentID: "root-b", directory } } } });
    await chat(
      { sessionID: "fallback-child", agent: "renamed-worker" },
      { message: { agent: "renamed-worker", model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: `role=implementation\nprojectRoot=${directory}\ncandidate=child\nsource_manifest=[src/a.ts]\nacceptance: safe change` }] },
    );
    assert.equal((await executeBindWriteGate(hooks, directory, "fallback-child")).reason, "handoff-uninspected");
  });
});

test("a nested candidate binds from its own default handoff after one successful Read", async () => {
  await withProject("nested-candidate-read-inspection", async (directory) => {
    const candidateRoot = join(directory, "candidate");
    await mkdir(candidateRoot);
    await writeFile(
      join(candidateRoot, "candidate-manifest.json"),
      JSON.stringify(operationManifest(["allowed.txt"])),
    );
    const handoffPath = join(candidateRoot, "handoff.json");
    const pendingHandoff = writeGateHandoff(candidateRoot, "candidate-manifest.json");
    pendingHandoff.verification = (pendingHandoff.verification as Array<Record<string, unknown>>).map(
      (entry) => ({ ...entry, status: "not_run", exit_code: null, summary: "Pending worker bind" }),
    );
    await writeFile(
      handoffPath,
      JSON.stringify(pendingHandoff),
    );

    // The plugin runs at the parent workspace and keeps its default handoffPaths=["handoff.json"].
    const hooks = await SortieDogsPlugin({ directory });
    const chat = hooks["chat.message"];
    const event = hooks.event;
    assert.ok(chat);
    assert.ok(event);
    await chat(
      { sessionID: "nested-parent", agent: "dog-coordinator" },
      { message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: "ordinary" }] },
    );
    await event({ event: { type: "session.created", properties: { info: { id: "nested-child", parentID: "nested-parent", directory } } } });
    await chat(
      { sessionID: "nested-child", agent: "dog-worker" },
      {
        message: { agent: "dog-worker", model: { providerID: "host", modelID: "selected" } },
        parts: [{
          type: "text",
          text: `role=implementation\nproject_root=${candidateRoot}\noperation_manifest=candidate-manifest.json\nacceptance=safe change`,
        }],
      },
    );

    await inspectHandoffWithRead(hooks, handoffPath, "nested-child");
    const binding = await executeBindWriteGate(
      hooks,
      candidateRoot,
      "nested-child",
      join(candidateRoot, "candidate-manifest.json"),
    );
    assert.deepEqual(
      { status: binding.status, manifest_path: binding.manifest_path },
      { status: "bound", manifest_path: "candidate-manifest.json" },
    );
    assert.match(String(binding.manifest_hash), /^[0-9a-f]{64}$/u);
  });
});

test("a denied handoff read reports the document, pointer, and rule that must be repaired", async () => {
  await withProject("handoff-denial-defects", async (directory) => {
    const hooks = await configuredHooks(directory);
    await activate(hooks);
    const handoffPath = join(directory, "handoff.json");
    const denial = async (handoff: Record<string, unknown>): Promise<string> => {
      await writeFile(handoffPath, JSON.stringify(handoff));
      return await readDenialMessage(hooks, handoffPath);
    };

    // A blocker list holds objects. Bare strings are the defect that stalled real candidates.
    const stringBlocked = writeGateHandoff(directory, "operation-manifest.json");
    stringBlocked.state = { done: [], next: ["bind"], blocked: ["waiting on the coordinator"] };
    assert.match(
      await denial(stringBlocked),
      /Defects: handoff \/state\/blocked\/0 schema_type\. Correct the registered handoff/u,
    );

    const missingRoot = writeGateHandoff(directory, "operation-manifest.json");
    missingRoot.ext = { "sortie-dogs/write-gate": { operation_manifest: "operation-manifest.json" } };
    assert.match(
      await denial(missingRoot),
      /handoff \/ext\/sortie-dogs~1write-gate\/project_root ext_project_root_missing/u,
    );

    const undeclaredCheck = writeGateHandoff(directory, "operation-manifest.json");
    undeclaredCheck.verification = [
      { check: "npm test", status: "not_run", exit_code: null, summary: "Pending bind" },
    ];
    assert.match(
      await denial(undeclaredCheck),
      /contract \/verification\/0\/check M004_VERIFICATION_NOT_DECLARED/u,
    );

    // An operation manifest with an invented shape reports the manifest, never its content.
    await writeFile(
      join(directory, "invented-manifest.json"),
      JSON.stringify({ candidate: "PVTI_x", targets: [{ path: "allowed.txt" }], constraints: [] }),
    );
    const inventedMessage = await denial(writeGateHandoff(directory, "invented-manifest.json"));
    assert.match(inventedMessage, /manifest \/@unknown schema_additionalProperties/u);
    assert.match(inventedMessage, /manifest \/read schema_required/u);
    assert.ok(!inventedMessage.includes("PVTI_x"));

    // Every unknown property collapses into one redacted pointer, so authored names never leak.
    assert.equal(inventedMessage.match(/schema_additionalProperties/gu)?.length, 1);

    const manyDefects = writeGateHandoff(directory, "operation-manifest.json");
    manyDefects.profile = "full";
    manyDefects.scope = { paths: Array.from({ length: 10 }, (_, index) => `undeclared-${index}.txt`) };
    manyDefects.sources = [{ path: "allowed.txt", rev: "r1" }];
    assert.match(await denial(manyDefects), /contract \/scope\/paths\/7 M002_SCOPE_NOT_ALLOWED; \+2 more\./u);

    await writeFile(handoffPath, "{ not json");
    assert.match(await readDenialMessage(hooks, handoffPath), /handoff \/ input_invalid_json/u);
  });
});

test("the contract preflight reports gate defects without granting inspection", async () => {
  await withProject("contract-preflight", async (directory) => {
    const hooks = await configuredHooks(directory);
    const check = hooks.tool?.sortie_check_contract as unknown as {
      execute(args: { handoff_path: string }, context: { sessionID: string }): Promise<string>;
    } | undefined;
    assert.ok(check);
    const report = async (handoffPath: string): Promise<Record<string, unknown>> =>
      JSON.parse(await check.execute({ handoff_path: handoffPath }, { sessionID: "plugin-session" }));

    const handoffPath = join(directory, "handoff.json");
    const defective = writeGateHandoff(directory, "operation-manifest.json");
    defective.state = { done: [], next: ["bind"], blocked: ["still waiting"] };
    await writeFile(handoffPath, JSON.stringify(defective));
    assert.deepEqual(await report(handoffPath), {
      status: "defective",
      reason: "schema-invalid",
      defects: ["handoff /state/blocked/0 schema_type"],
      remedy: "Repair each reported pointer in the named document, then check it again.",
    });

    // An unregistered path is a defect, never a silent pass that a dispatch could trust.
    const unregistered = join(directory, "elsewhere.json");
    await writeFile(unregistered, JSON.stringify(writeGateHandoff(directory, "operation-manifest.json")));
    assert.equal((await report(unregistered)).status, "defective");
    assert.deepEqual((await report(unregistered)).defects, ["handoff / handoff_path_not_registered"]);

    await writeFile(handoffPath, JSON.stringify(writeGateHandoff(directory, "operation-manifest.json")));
    assert.deepEqual(await report(handoffPath), { status: "ok", defects: [] });

    // A passing report must not stand in for the binding child's own Read.
    await activate(hooks);
    const denied = await executeBindWriteGate(hooks, directory);
    assert.equal(denied.reason, "handoff-uninspected");
  });
});

test("a denied bind carries the same defect evidence the coordinator must repair", async () => {
  await withProject("bind-denial-defects", async (directory) => {
    const hooks = await configuredHooks(directory);
    await activate(hooks);
    const handoffPath = join(directory, "handoff.json");
    await writeFile(
      join(directory, "invented-manifest.json"),
      JSON.stringify({ candidate: "PVTI_x", targets: [] }),
    );
    await writeFile(
      handoffPath,
      JSON.stringify(writeGateHandoff(directory, "invented-manifest.json")),
    );
    await inspectHandoffWithRead(hooks, handoffPath, "plugin-session").catch(() => undefined);

    const denied = await executeBindWriteGate(
      hooks,
      directory,
      "plugin-session",
      "invented-manifest.json",
    );
    assert.equal(denied.status, "denied");
    assert.equal(denied.reason, "manifest-invalid");
    const defects = denied.defects as string[];
    assert.ok(defects.includes("manifest /read schema_required"));
    assert.ok(defects.includes("manifest /@unknown schema_additionalProperties"));
    assert.ok(defects.length <= 8);
    assert.ok(!JSON.stringify(denied).includes("PVTI_x"));
  });
});

test("unchanged bind denial stops across fresh children until inspection changes state", async () => {
  await withProject("binding-no-progress", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    const handoffPath = join(directory, "handoff.json");
    await writeFile(handoffPath, JSON.stringify(writeGateHandoff(directory, "operation-manifest.json")));
    const hooks = await SortieDogsPlugin({ directory });
    const chat = hooks["chat.message"];
    const event = hooks.event;
    assert.ok(chat);
    assert.ok(event);
    await chat(
      { sessionID: "retry-root", agent: "dog-coordinator" },
      { message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: "ordinary" }] },
    );
    const task = `role=implementation\nproject_root=${directory}\noperation_manifest=operation-manifest.json\nacceptance=safe change`;
    for (const sessionID of ["retry-child", "reader-child", "fresh-retry-child"]) {
      await event({ event: { type: "session.created", properties: { info: { id: sessionID, parentID: "retry-root", directory } } } });
      await chat(
        { sessionID, agent: "dog-worker" },
        { message: { agent: "dog-worker", model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: task }] },
      );
    }

    assert.equal(
      (await executeBindWriteGate(hooks, directory, "retry-child")).reason,
      "handoff-uninspected",
    );
    // A sibling may inspect for itself, but it cannot erase the denial owned by retry-child.
    await inspectHandoffWithRead(hooks, handoffPath, "reader-child");
    const changedHandoff = writeGateHandoff(directory, "operation-manifest.json");
    changedHandoff.task = { title: "Changed", objective: "Create a distinct mismatch signature." };
    await writeFile(handoffPath, JSON.stringify(changedHandoff));
    assert.equal(
      (await executeBindWriteGate(hooks, directory, "reader-child")).reason,
      "handoff-mismatch",
    );
    await event({ event: { type: "file.edited", properties: { file: handoffPath } } });
    const stopped = await executeBindWriteGate(hooks, directory, "fresh-retry-child");
    assert.deepEqual(
      {
        reason: stopped.reason,
        recoverable: stopped.recoverable,
        escalation: stopped.escalation,
      },
      {
        reason: "retry-exhausted",
        recoverable: false,
        escalation: { action: "follow-remedy", resume_session: false, true_blocker: true },
      },
    );

    // A successful child-owned inspection is real progress and clears the root-lineage stop state.
    await inspectHandoffWithRead(hooks, handoffPath, "retry-child");
    assert.equal((await executeBindWriteGate(hooks, directory, "retry-child")).status, "bound");
  });
});

test("another candidate cannot erase a root lineage no-progress denial", async () => {
  await withProject("binding-no-progress-interleaved", async (directory) => {
    const roots: Record<string, string> = {};
    for (const name of ["candidate-a", "candidate-b"]) {
      const root = join(directory, name);
      roots[name] = root;
      await mkdir(root);
      await writeFile(join(root, "manifest.json"), JSON.stringify(operationManifest(["allowed.txt"])));
    }
    const hooks = await SortieDogsPlugin({ directory });
    const chat = hooks["chat.message"];
    const event = hooks.event;
    assert.ok(chat);
    assert.ok(event);
    await chat(
      { sessionID: "interleaved-root", agent: "dog-coordinator" },
      { message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: "ordinary" }] },
    );
    for (const [sessionID, root] of [
      ["candidate-a-first", roots["candidate-a"]],
      ["candidate-b-first", roots["candidate-b"]],
      ["candidate-a-fresh", roots["candidate-a"]],
    ] as const) {
      await event({ event: { type: "session.created", properties: { info: { id: sessionID, parentID: "interleaved-root", directory } } } });
      await chat(
        { sessionID, agent: "dog-worker" },
        {
          message: { agent: "dog-worker", model: { providerID: "host", modelID: "selected" } },
          parts: [{ type: "text", text: `role=implementation\nproject_root=${root}\noperation_manifest=manifest.json\nacceptance=safe change` }],
        },
      );
    }
    assert.equal(
      (await executeBindWriteGate(hooks, roots["candidate-a"], "candidate-a-first", "manifest.json")).reason,
      "handoff-uninspected",
    );
    assert.equal(
      (await executeBindWriteGate(hooks, roots["candidate-b"], "candidate-b-first", "manifest.json")).reason,
      "handoff-uninspected",
    );
    assert.equal(
      (await executeBindWriteGate(hooks, roots["candidate-a"], "candidate-a-fresh", "manifest.json")).reason,
      "retry-exhausted",
    );
  });
});

test("a successful sibling bind cannot erase another child's mismatch history", async () => {
  await withProject("binding-no-progress-owner-isolation", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    const handoffPath = join(directory, "handoff.json");
    const originalHandoff = writeGateHandoff(directory, "operation-manifest.json");
    const changedHandoff = writeGateHandoff(directory, "operation-manifest.json");
    changedHandoff.task = { title: "Changed", objective: "Repeat one exact mismatch fingerprint." };
    await writeFile(handoffPath, JSON.stringify(originalHandoff));
    const hooks = await SortieDogsPlugin({ directory });
    const chat = hooks["chat.message"];
    const event = hooks.event;
    assert.ok(chat);
    assert.ok(event);
    await chat(
      { sessionID: "owner-root", agent: "dog-coordinator" },
      { message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: "ordinary" }] },
    );
    const task = `role=implementation\nproject_root=${directory}\noperation_manifest=operation-manifest.json\nacceptance=safe change`;
    for (const sessionID of ["mismatch-owner", "successful-sibling", "replay-sibling"]) {
      await event({ event: { type: "session.created", properties: { info: { id: sessionID, parentID: "owner-root", directory } } } });
      await chat(
        { sessionID, agent: "dog-worker" },
        { message: { agent: "dog-worker", model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: task }] },
      );
    }

    await inspectHandoffWithRead(hooks, handoffPath, "mismatch-owner");
    await writeFile(handoffPath, JSON.stringify(changedHandoff));
    assert.equal(
      (await executeBindWriteGate(hooks, directory, "mismatch-owner")).reason,
      "handoff-mismatch",
    );
    await inspectHandoffWithRead(hooks, handoffPath, "successful-sibling");
    assert.equal((await executeBindWriteGate(hooks, directory, "successful-sibling")).status, "bound");

    await writeFile(handoffPath, JSON.stringify(originalHandoff));
    await inspectHandoffWithRead(hooks, handoffPath, "replay-sibling");
    await writeFile(handoffPath, JSON.stringify(changedHandoff));
    assert.equal(
      (await executeBindWriteGate(hooks, directory, "replay-sibling")).reason,
      "retry-exhausted",
    );
  });
});

test("file edits revoke authorization and never grant inspection even with a session ID", async () => {
  await withProject("sessionless-file-edit", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    const handoffPath = join(directory, "handoff.json");
    await writeFile(handoffPath, JSON.stringify(writeGateHandoff(directory, "operation-manifest.json")));
    const hooks = await SortieDogsPlugin({ directory });
    await activate(hooks, "event-owner");
    await inspectHandoffWithRead(hooks, handoffPath, "event-owner");
    assert.equal((await executeBindWriteGate(hooks, directory, "event-owner")).status, "bound");
    const event = hooks.event;
    const before = hooks["tool.execute.before"];
    assert.ok(event);
    assert.ok(before);

    await event({ event: { type: "file.edited", properties: { file: handoffPath } } });
    await expectMessage(
      () => before(
        { tool: "write", sessionID: "event-owner", callID: "revoked" },
        { args: { file: "allowed.txt", content: "not-written" } },
      ),
      'Write denied for "<unknown>": operation manifest unavailable.',
      "manifest-unavailable",
    );
    assert.equal(
      (await executeBindWriteGate(hooks, directory, "event-owner")).reason,
      "handoff-uninspected",
    );
    await inspectHandoffWithRead(hooks, handoffPath, "event-owner");
    assert.equal((await executeBindWriteGate(hooks, directory, "event-owner")).status, "bound");
    await event({ event: { type: "file.edited", properties: { file: handoffPath, sessionID: "event-owner" } } });
    assert.equal(
      (await executeBindWriteGate(hooks, directory, "event-owner")).reason,
      "handoff-uninspected",
    );
  });
});

test("sibling inspection fallback requires the same inspected fingerprint", async () => {
  await withProject("child-inspection-fingerprint", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    const handoffPath = join(directory, "handoff.json");
    await writeFile(handoffPath, JSON.stringify(writeGateHandoff(directory, "operation-manifest.json")));
    const hooks = await SortieDogsPlugin({ directory });
    const chat = hooks["chat.message"];
    const event = hooks.event;
    assert.ok(chat);
    assert.ok(event);
    await activate(hooks, "parent");
    await event({ event: { type: "file.edited", properties: { file: handoffPath, sessionID: "parent" } } });
    const changedHandoff = writeGateHandoff(directory, "operation-manifest.json");
    changedHandoff.task = { title: "Plugin harness", objective: "Exercise a different inspected handoff." };
    await writeFile(handoffPath, JSON.stringify(changedHandoff));
    await event({ event: { type: "file.edited", properties: { file: handoffPath, sessionID: "fingerprint-child" } } });
    await chat(
      { sessionID: "fingerprint-child", agent: "renamed-worker" },
      { message: { agent: "renamed-worker", model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: `role=implementation\nprojectRoot=${directory}\ncandidate=child\nsource_manifest=[src/a.ts]\nacceptance: safe change` }] },
    );
    assert.equal((await executeBindWriteGate(hooks, directory, "fingerprint-child")).reason, "session-inactive");
  });
});

test("root and inspection TTLs stop new inheritance without revoking existing child authorization", async () => {
  await withProject("lineage-ttl", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    await writeFile(join(directory, "handoff.json"), JSON.stringify(writeGateHandoff(directory, "operation-manifest.json")));
    const hooks = await SortieDogsPlugin({ directory });
    const chat = hooks["chat.message"];
    const before = hooks["tool.execute.before"];
    const event = hooks.event;
    assert.ok(chat);
    assert.ok(before);
    assert.ok(event);
    const originalNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      const task = `role=implementation\nprojectRoot=${directory}\ncandidate=child\nsource_manifest=[src/a.ts]\nacceptance: safe change`;
      await chat(
        { sessionID: "ttl-root", agent: "dog-coordinator" },
        { message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: "ordinary" }] },
      );
      await event({ event: { type: "session.created", properties: { info: { id: "authorized-child", parentID: "ttl-root", directory } } } });
      await chat(
        { sessionID: "authorized-child", agent: "dog-worker" },
        { message: { agent: "dog-worker", model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: task }] },
      );
      await inspectHandoffWithRead(hooks, join(directory, "handoff.json"), "authorized-child");
      assert.equal((await executeBindWriteGate(hooks, directory, "authorized-child")).status, "bound");

      await activate(hooks, "inspection-ttl");
      await inspectHandoffWithRead(hooks, join(directory, "handoff.json"), "inspection-ttl");
      now += 20 * 60 * 1000;
      for (const sessionID of ["authorized-child", "inspection-ttl"]) {
        await chat(
          { sessionID, agent: "dog-worker" },
          { message: { agent: "dog-worker", model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: "keep active" }] },
        );
      }
      await before(
        { tool: "write", sessionID: "authorized-child", callID: "refresh-authorization" },
        { args: { file: "allowed.txt", content: "not-written" } },
      );
      now += 10 * 60 * 1000 + 1;
      assert.equal((await executeBindWriteGate(hooks, directory, "inspection-ttl")).reason, "handoff-uninspected");

      await event({ event: { type: "session.created", properties: { info: { id: "late-child", parentID: "ttl-root", directory } } } });
      await chat(
        { sessionID: "late-child", agent: "dog-worker" },
        { message: { agent: "dog-worker", model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: task }] },
      );
      assert.equal((await executeBindWriteGate(hooks, directory, "late-child")).reason, "session-inactive");
      await before(
        { tool: "write", sessionID: "authorized-child", callID: "post-root-expiry" },
        { args: { file: "allowed.txt", content: "not-written" } },
      );
      // The inspection entry has expired, but authorization still pins its handoff path and must
      // therefore be suspended by the host's session-less file event.
      await event({ event: { type: "file.edited", properties: { file: join(directory, "handoff.json") } } });
      await expectMessage(
        () => before(
          { tool: "write", sessionID: "authorized-child", callID: "edited-after-inspection-ttl" },
          { args: { file: "allowed.txt", content: "not-written" } },
        ),
        'Write denied for "<unknown>": operation manifest unavailable.',
        "manifest-unavailable",
      );
    } finally {
      Date.now = originalNow;
    }
  });
});

test("a late child re-proves expired coordinator lineage from host session identity", async () => {
  await withProject("lineage-host-recovery", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    await writeFile(
      join(directory, "handoff.json"),
      JSON.stringify(writeGateHandoff(directory, "operation-manifest.json")),
    );
    const identities: Record<string, { agent: string; parentID?: string }> = {
      "host-root": { agent: "dog-coordinator" },
      "late-host-child": { agent: "dog-worker", parentID: "host-root" },
    };
    const client = {
      session: {
        get: async ({ path }: { path: { id: string } }) => ({ data: identities[path.id] }),
      },
    };
    const hooks = await SortieDogsPlugin({ directory, client });
    const chat = hooks["chat.message"];
    assert.ok(chat);
    await chat(
      { sessionID: "host-root", agent: "dog-coordinator" },
      {
        message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } },
        parts: [{ type: "text", text: "ordinary" }],
      },
    );

    const originalNow = Date.now;
    const started = originalNow();
    Date.now = () => started + 30 * 60 * 1000 + 1;
    try {
      await chat(
        { sessionID: "late-host-child", agent: "dog-worker" },
        {
          message: { agent: "dog-worker", model: { providerID: "host", modelID: "selected" } },
          parts: [{
            type: "text",
            text: `role=implementation\nproject_root=${directory}\noperation_manifest=operation-manifest.json\nacceptance=safe change`,
          }],
        },
      );
      await inspectHandoffWithRead(hooks, join(directory, "handoff.json"), "late-host-child");
      assert.equal((await executeBindWriteGate(hooks, directory, "late-host-child")).status, "bound");
    } finally {
      Date.now = originalNow;
    }
  });
});

test("plugin fixture allows a manifest-scoped write", async () => {
  const candidate = fixtureCase("allow-write");
  await withProject(candidate.name, async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    const nested = join(directory, "nested");
    await mkdir(nested);
    await writeFile(join(nested, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    await invokeWrite(
      await SortieDogsPlugin(
        { directory: nested, worktree: directory },
        { handoffPaths: ["nested/handoff.json"] },
      ),
      candidate.target!,
      nested,
    );
    await writeFile(join(directory, "handoff.json"), JSON.stringify(writeGateHandoff(directory, "operation-manifest.json")));
    await invokeWrite(await SortieDogsPlugin({ directory }, {}), candidate.target!, directory);
  });
});

test("plugin gate allows directory descendants without allowing prefixed siblings", async () => {
  await withProject("directory-write-scope", async (directory) => {
    await mkdir(join(directory, "_testenv"));
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify({
      ...fixture.manifest,
      write: ["_testenv", "_future"],
    }));
    const hooks = await SortieDogsPlugin({ directory });

    await invokeWrite(hooks, "_testenv/result.json", directory);
    await expectMessage(
      () => invokeWrite(hooks, "undeclared/result.json", directory),
      'Write denied for "undeclared/result.json": operation manifest write scope.',
      "manifest-scope",
    );
    await expectMessage(
      () => invokeWrite(hooks, "_testenv-sibling/result.json", directory),
      'Write denied for "_testenv-sibling/result.json": operation manifest write scope.',
      "manifest-scope",
    );
    await expectMessage(
      () => invokeWrite(hooks, "_future/result.json", directory),
      'Write denied for "_future/result.json": operation manifest write scope.',
      "manifest-scope",
    );
  });
});

test("plugin gate denies directory-scope writes routed through an escaping symlink", async () => {
  await withProject("directory-write-scope-symlink", async (directory) => {
    const scope = join(directory, "_testenv");
    const outsideScope = join(directory, "other");
    await mkdir(scope);
    await mkdir(outsideScope);
    await symlink(outsideScope, join(scope, "link"), process.platform === "win32" ? "junction" : "dir");
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify({
      ...fixture.manifest,
      write: ["_testenv"],
    }));
    const hooks = await SortieDogsPlugin({ directory });

    await expectMessage(
      () => invokeWrite(hooks, "_testenv/link/result.json", directory),
      'Write denied for "_testenv/link/result.json": operation manifest write scope.',
      "manifest-scope",
    );
  });
});

test("plugin gate uses the execution directory when worktree differs", async () => {
  await withProject("directory-worktree-divergence", async (worktree) => {
    const directory = join(worktree, "u3-rpt");
    await mkdir(directory);
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    await writeFile(join(worktree, "operation-manifest.json"), JSON.stringify({
      ...fixture.manifest,
      write: ["denied.txt"],
    }));

    const hooks = await SortieDogsPlugin({ directory, worktree }, { handoffPaths: ["u3-rpt/handoff.json"] });
    await invokeWrite(hooks, "allowed.txt", directory);
    const before = hooks["tool.execute.before"];
    const permission = hooks["permission.ask"];
    assert.ok(before);
    assert.ok(permission);
    await expectMessage(
      () => before(
        { tool: "apply_patch", sessionID: "plugin-session", callID: "patch-call" },
        { args: { patchText: `*** Begin Patch\n*** Add File: ${join(directory, "denied.txt")}\n+blocked\n*** End Patch` } },
      ),
      'Write denied for "denied.txt": operation manifest write scope.',
      "manifest-scope",
    );
    await permission(
      { permission: "edit", patterns: [join("u3-rpt", "allowed.txt")], sessionID: "plugin-session" },
      { status: "allow" },
    );
    // Without a session identity no gate can be attributed, so the permission hook stays passive
    // and tool.execute.before remains the enforcing path.
    await permission(
      { permission: "edit", patterns: [join("u3-rpt", "denied.txt")] },
      { status: "allow" },
    );
    await expectMessage(
      () => permission(
        { permission: "edit", patterns: [join("u3-rpt", "denied.txt")], sessionID: "plugin-session" },
        { status: "allow" },
      ),
      'Write denied for "denied.txt": operation manifest write scope.',
      "manifest-scope",
    );
    await assert.rejects(stat(join(directory, "denied.txt")), { code: "ENOENT" });
  });
});

test("plugin fixture denies an out-of-manifest write with target and reason", async () => {
  const candidate = fixtureCase("deny-write");
  await withProject(candidate.name, async (directory) => {
    const hooks = await configuredHooks(directory);
    await expectMessage(() => invokeWrite(hooks, candidate.target!, directory), candidate.error!, "manifest-scope");
  });
});

test("plugin fixture denies traversal before write-scope comparison", async () => {
  const candidate = fixtureCase("deny-traversal");
  await withProject(candidate.name, async (directory) => {
    const hooks = await configuredHooks(directory);
    await expectMessage(() => invokeWrite(hooks, candidate.target!, directory), candidate.error!, "project-boundary");
  });
});

test("plugin stays passive for an absent manifest while reads remain no-op", async () => {
  await withProject("missing-manifest", async (directory) => {
    const hooks = await SortieDogsPlugin({ directory });
    // A project without an operation manifest never declared a write scope. Enforcing an undeclared
    // scope would also deny creating that manifest, so enforcement stays off until it exists.
    await invokeWrite(hooks, "allowed.txt", directory);
    await invokeWrite(hooks, "outside.txt", directory);

    const before = hooks["tool.execute.before"];
    assert.ok(before);
    await before(
      { tool: "read", sessionID: "plugin-session", callID: "read-call" },
      { args: { file: "unrestricted-read.txt" } },
    );
    await assert.rejects(stat(join(directory, "outside.txt")), { code: "ENOENT" });
  });
});

test("plugin fixture fails closed for invalid manifest JSON without exposing input", async () => {
  const candidate = fixtureCase("invalid-manifest-json");
  await withProject(candidate.name, async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), fixture.invalidManifestJson);
    const hooks = await SortieDogsPlugin({ directory });
    await expectMessage(() => invokeWrite(hooks, "allowed.txt", directory), candidate.error!, "manifest-unavailable");
  });
});

test("plugin reloads a missing or invalid manifest after repair in the same session", async () => {
  await withProject("manifest-repair", async (directory) => {
    const hooks = await SortieDogsPlugin({ directory });
    await invokeWrite(hooks, "allowed.txt", directory);
    await writeFile(join(directory, "operation-manifest.json"), fixture.invalidManifestJson);
    await expectMessage(
      () => invokeWrite(hooks, "allowed.txt", directory),
      'Write denied for "<unknown>": operation manifest unavailable.',
      "manifest-unavailable",
    );
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    await invokeWrite(hooks, "allowed.txt", directory);
  });
});

test("a repaired manifest remains pinned to the original hash and mtime", async () => {
  await withProject("loaded-manifest-repair", async (directory) => {
    const manifestPath = join(directory, "operation-manifest.json");
    await writeFile(manifestPath, JSON.stringify(fixture.manifest));
    const hooks = await SortieDogsPlugin({ directory });
    await invokeWrite(hooks, "allowed.txt", directory);

    await writeFile(manifestPath, fixture.invalidManifestJson);
    await expectMessage(
      () => invokeWrite(hooks, "allowed.txt", directory),
      'Write denied for "<unknown>": operation manifest unavailable.',
      "manifest-unavailable",
    );

    await writeFile(manifestPath, JSON.stringify(fixture.manifest));
    await inspectHandoffWithRead(hooks, join(directory, "handoff.json"), "plugin-session");
    const replay = await executeBindWriteGate(hooks, directory, "plugin-session");
    assert.equal(replay.reason, "binding-replay");
    assert.equal(replay.recoverable, false);
  });
});

test("handoff write authorization uses its candidate root when the parent worktree differs", async () => {
  await withProject("candidate-root", async (directory) => {
    const candidateRoot = join(directory, "subrepo");
    await mkdir(candidateRoot);
    await writeFile(
      join(candidateRoot, "candidate-manifest.json"),
      JSON.stringify(operationManifest(["allowed.txt"])),
    );
    await writeFile(
      join(candidateRoot, "handoff.json"),
      JSON.stringify(writeGateHandoff(candidateRoot, "candidate-manifest.json")),
    );
    const hooks = await SortieDogsPlugin({ directory, worktree: candidateRoot });
    await activate(hooks, "candidate");
    assert.equal((await bindWriteGate(hooks, candidateRoot, "candidate", "candidate-manifest.json")).status, "bound");
    const event = hooks.event;
    const before = hooks["tool.execute.before"];
    assert.ok(event);
    assert.ok(before);
    await before(
      { tool: "write", sessionID: "candidate", callID: "candidate-allowed" },
      { args: { file: "allowed.txt", content: "not-written" } },
    );
    await expectMessage(
      () => before(
        { tool: "write", sessionID: "candidate", callID: "candidate-denied" },
        { args: { file: "parent.txt", content: "not-written" } },
      ),
      'Write denied for "parent.txt": operation manifest write scope.',
      "manifest-scope",
    );
  });
});

test("handoff write authorization rejects a candidate root above the execution allowlist", async () => {
  await withProject("candidate-root-ancestor", async (directory) => {
    const executionRoot = join(directory, "execution");
    await mkdir(executionRoot);
    await writeFile(
      join(directory, "ancestor-manifest.json"),
      JSON.stringify(operationManifest(["execution/allowed.txt"])),
    );
    await writeFile(
      join(executionRoot, "handoff.json"),
      JSON.stringify(writeGateHandoff(directory, "ancestor-manifest.json")),
    );
    const hooks = await SortieDogsPlugin({ directory: executionRoot });
    await activate(hooks, "ancestor");
    const event = hooks.event;
    assert.ok(event);
    assert.equal((await bindWriteGate(hooks, directory, "ancestor", "ancestor-manifest.json")).status, "denied");
    await event({ event: { type: "file.edited", properties: { file: "handoff.json", sessionID: "ancestor" } } });
  });
});

test("active sessions use sliding TTL, fail closed after expiry, and discard deleted state", async () => {
  await withProject("session-bounds", async (directory) => {
    const hooks = await configuredHooks(directory);
    const chat = hooks["chat.message"];
    const before = hooks["tool.execute.before"];
    assert.ok(chat);
    assert.ok(before);
    const originalNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      for (let index = 0; index <= 256; index += 1) {
        const sessionID = `bounded-${index}`;
        await chat(
          { sessionID },
          { message: { model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: "/sortie task" }] },
        );
      }
      const write = (sessionID: string) => before(
        { tool: "write", sessionID, callID: "bounded-write" },
        { args: { file: "outside.txt", content: "not-written" } },
      );
      await expectMessage(
        () => write("bounded-0"),
        'Write denied for "<expired-session>": active session expired; start or resume an explicit Task takeover.',
        "session-expired",
      );
      await expectMessage(
        () => write("bounded-1"),
        'Write denied for "<unknown>": operation manifest unavailable.',
        "manifest-unavailable",
      );
      now += 20 * 60 * 1000;
      await chat(
        { sessionID: "bounded-256" },
        { message: { model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: "activity" }] },
      );
      now += 20 * 60 * 1000;
      await expectMessage(
        () => write("bounded-256"),
        'Write denied for "<unknown>": operation manifest unavailable.',
        "manifest-unavailable",
      );
      now += 30 * 60 * 1000 + 1;
      await expectMessage(
        () => write("bounded-256"),
        'Write denied for "<expired-session>": active session expired; start or resume an explicit Task takeover.',
        "session-expired",
      );
      const expiredBind = await executeBindWriteGate(hooks, directory, "bounded-256");
      assert.equal(expiredBind.reason, "session-expired");
      assert.equal((expiredBind.escalation as Record<string, unknown>).action, "blocker-resolution-takeover");
      await write("bounded-0");
      const event = hooks.event;
      assert.ok(event);
      await event({ event: { type: "session.deleted", properties: { sessionID: "bounded-0" } } });
      await write("bounded-0");
      await event({ event: { type: "session.deleted", properties: { sessionID: "bounded-256" } } });
      await write("bounded-256");
    } finally {
      Date.now = originalNow;
    }
  });
});

test("expired session signals are FIFO bounded", async () => {
  await withProject("expired-session-bounds", async (directory) => {
    const hooks = await configuredHooks(directory);
    const before = hooks["tool.execute.before"];
    assert.ok(before);
    for (let index = 0; index <= 512; index += 1) await activate(hooks, `expired-bounded-${index}`);
    await before(
      { tool: "write", sessionID: "expired-bounded-0", callID: "trimmed-expiry" },
      { args: { file: "outside.txt", content: "not-written" } },
    );
    await expectMessage(
      () => before(
        { tool: "write", sessionID: "expired-bounded-1", callID: "retained-expiry" },
        { args: { file: "outside.txt", content: "not-written" } },
      ),
      'Write denied for "<expired-session>": active session expired; start or resume an explicit Task takeover.',
      "session-expired",
    );
  });
});

test("expired sessions ignore created and updated reactivation events", async () => {
  await withProject("expired-session-events", async (directory) => {
    const hooks = await configuredHooks(directory);
    const event = hooks.event;
    assert.ok(event);
    const originalNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      await activate(hooks, "expired-child");
      now += 20 * 60 * 1000;
      await activate(hooks, "active-parent");
      now += 10 * 60 * 1000 + 1;
      assert.equal((await executeBindWriteGate(hooks, directory, "expired-child")).reason, "session-expired");
      for (const type of ["session.created", "session.updated"] as const) {
        await event({ event: { type, properties: { info: { id: "expired-child", parentID: "active-parent", directory } } } });
        assert.equal((await executeBindWriteGate(hooks, directory, "expired-child")).reason, "session-expired");
      }
    } finally {
      Date.now = originalNow;
    }
  });
});

test("write-gate binding denies symlink escape and malformed manifests as results", async () => {
  await withProject("binding-denials", async (directory) => {
    const outside = await mkdtemp(join(testEnvironment, "plugin-binding-outside-"));
    try {
      await writeFile(join(outside, "manifest.json"), JSON.stringify(operationManifest(["allowed.txt"])));
      await symlink(outside, join(directory, "escaped"), "junction");
      await writeFile(join(directory, "invalid.json"), fixture.invalidManifestJson);
      const hooks = await SortieDogsPlugin({ directory });
      await activate(hooks, "binding-denials");
      assert.equal((await bindWriteGate(hooks, directory, "binding-denials", "escaped/manifest.json")).reason, "project-boundary");
      assert.equal((await bindWriteGate(hooks, directory, "binding-denials", "invalid.json")).status, "denied");
      assert.equal((await bindWriteGate(hooks, outside, "binding-denials", "manifest.json")).reason, "project-boundary");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("write-gate binding requires a matching inspected Task handoff", async () => {
  await withProject("binding-inspection", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    const handoffPath = join(directory, "handoff.json");
    await writeFile(handoffPath, JSON.stringify(writeGateHandoff(directory, "operation-manifest.json")));
    const hooks = await SortieDogsPlugin({ directory });
    await activate(hooks, "binding-inspection");
    const uninspected = await executeBindWriteGate(hooks, directory, "binding-inspection");
    assert.equal(uninspected.reason, "handoff-uninspected");
    assert.equal(uninspected.recoverable, true);
    assert.match(String(uninspected.remedy), /exact registered handoff path/i);
    const event = hooks.event;
    assert.ok(event);
    await inspectHandoffWithRead(hooks, handoffPath, "binding-inspection");
    await writeFile(handoffPath, JSON.stringify({
      ...writeGateHandoff(directory, "operation-manifest.json"),
      created_at: "2035-01-02T03:04:06Z",
    }));
    assert.equal(
      (await executeBindWriteGate(hooks, directory, "binding-inspection")).reason,
      "handoff-mismatch",
    );
  });
});

test("an inspected schema-invalid handoff exhausts an unchanged bind retry", async () => {
  await withProject("binding-invalid-handoff-retry", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    const handoffPath = join(directory, "handoff.json");
    await writeFile(handoffPath, JSON.stringify(writeGateHandoff(directory, "operation-manifest.json")));
    const hooks = await SortieDogsPlugin({ directory });
    await activate(hooks, "invalid-handoff-retry");
    await inspectHandoffWithRead(hooks, handoffPath, "invalid-handoff-retry");
    await writeFile(handoffPath, JSON.stringify(fixture.handoffs.invalid));

    assert.equal(
      (await executeBindWriteGate(hooks, directory, "invalid-handoff-retry")).reason,
      "handoff-mismatch",
    );
    assert.equal(
      (await executeBindWriteGate(hooks, directory, "invalid-handoff-retry")).reason,
      "retry-exhausted",
    );
  });
});

test("an inspected unreadable handoff exhausts an unchanged bind retry", async () => {
  await withProject("binding-unreadable-handoff-retry", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    const handoffPath = join(directory, "handoff.json");
    await writeFile(handoffPath, JSON.stringify(writeGateHandoff(directory, "operation-manifest.json")));
    const hooks = await SortieDogsPlugin({ directory });
    await activate(hooks, "unreadable-handoff-retry");
    await inspectHandoffWithRead(hooks, handoffPath, "unreadable-handoff-retry");
    await writeFile(handoffPath, "{invalid-json");

    assert.equal(
      (await executeBindWriteGate(hooks, directory, "unreadable-handoff-retry")).reason,
      "handoff-mismatch",
    );
    assert.equal(
      (await executeBindWriteGate(hooks, directory, "unreadable-handoff-retry")).reason,
      "retry-exhausted",
    );
  });
});

test("inactive file events stay passive and only an active child Read enables binding", async () => {
  await withProject("inactive-inspection", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    const handoffPath = join(directory, "handoff.json");
    await writeFile(handoffPath, JSON.stringify(writeGateHandoff(directory, "operation-manifest.json")));
    const hooks = await SortieDogsPlugin({ directory });
    const event = hooks.event;
    assert.ok(event);

    await event({ event: { type: "file.edited", properties: { file: handoffPath, sessionID: "inactive" } } });
    const inactive = await executeBindWriteGate(hooks, directory, "inactive");
    assert.deepEqual(
      { status: inactive.status, reason: inactive.reason, recoverable: inactive.recoverable },
      { status: "denied", reason: "session-inactive", recoverable: true },
    );
    await activate(hooks, "inactive");
    assert.equal((await executeBindWriteGate(hooks, directory, "inactive")).reason, "handoff-uninspected");
    await event({ event: { type: "session.idle", properties: { sessionID: "inactive" } } });
    assert.equal((await executeBindWriteGate(hooks, directory, "inactive")).reason, "retry-exhausted");
    await inspectHandoffWithRead(hooks, handoffPath, "inactive");
    assert.equal((await executeBindWriteGate(hooks, directory, "inactive")).status, "bound");

    await event({ event: { type: "file.edited", properties: { file: join(directory, "other.json"), sessionID: "off-path" } } });
    await activate(hooks, "off-path");
    const offPath = await executeBindWriteGate(hooks, directory, "off-path");
    assert.equal(offPath.reason, "handoff-uninspected");

    await event({ event: { type: "file.edited", properties: { file: handoffPath, sessionID: "deleted-inactive" } } });
    await event({ event: { type: "session.deleted", properties: { sessionID: "deleted-inactive" } } });
    await activate(hooks, "deleted-inactive");
    const deletedInactive = await executeBindWriteGate(hooks, directory, "deleted-inactive");
    assert.equal(deletedInactive.reason, "handoff-uninspected");
  });
});

test("session idle keeps activation but revokes authorization when handoff inspection fails", async () => {
  await withProject("idle-failed-handoff", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    await writeFile(join(directory, "candidate-manifest.json"), JSON.stringify(operationManifest(["allowed.txt"])));
    const handoffPath = join(directory, "handoff.json");
    await writeFile(handoffPath, JSON.stringify(writeGateHandoff(directory, "candidate-manifest.json")));
    const hooks = await SortieDogsPlugin({ directory });
    await activate(hooks, "idle-failure");
    const event = hooks.event;
    const before = hooks["tool.execute.before"];
    assert.ok(event);
    assert.ok(before);
    assert.equal((await bindWriteGate(hooks, directory, "idle-failure", "candidate-manifest.json")).status, "bound");
    await before(
      { tool: "write", sessionID: "idle-failure", callID: "authorized" },
      { args: { file: "allowed.txt", content: "not-written" } },
    );
    await writeFile(handoffPath, fixture.invalidManifestJson);
    await event({ event: { type: "session.idle", properties: { sessionID: "idle-failure" } } });
    await expectMessage(
      () => before(
        { tool: "write", sessionID: "idle-failure", callID: "still-active-after-idle" },
        { args: { file: "outside.txt", content: "not-written" } },
      ),
      'Write denied for "<unknown>": operation manifest unavailable.',
      "manifest-unavailable",
    );
    await activate(hooks, "idle-failure");
    await expectMessage(
      () => before(
        { tool: "write", sessionID: "idle-failure", callID: "authorization-evicted" },
        { args: { file: "allowed.txt", content: "not-written" } },
      ),
      'Write denied for "<unknown>": operation manifest unavailable.',
      "manifest-unavailable",
    );
  });
});

test("handoff edits suspend writes without releasing the pinned manifest identity", async () => {
  await withProject("candidate-replacement", async (directory) => {
    await writeFile(join(directory, "manifest-a.json"), JSON.stringify(operationManifest(["old.txt"])));
    await writeFile(join(directory, "manifest-b.json"), JSON.stringify(operationManifest(["new.txt"])));
    const handoffPath = join(directory, "handoff.json");
    await writeFile(handoffPath, JSON.stringify(writeGateHandoff(directory, "manifest-a.json")));
    const hooks = await SortieDogsPlugin({ directory });
    await activate(hooks, "replacement");
    const chat = hooks["chat.message"];
    const event = hooks.event;
    const before = hooks["tool.execute.before"];
    assert.ok(chat);
    assert.ok(event);
    assert.ok(before);
    assert.equal((await bindWriteGate(hooks, directory, "replacement", "manifest-a.json")).status, "bound");
    const idempotent = await executeBindWriteGate(hooks, directory, "replacement", "manifest-a.json");
    assert.equal(idempotent.status, "bound");
    assert.equal(idempotent.idempotent, true);
    await writeFile(handoffPath, JSON.stringify(writeGateHandoff(directory, "manifest-b.json")));
    const mismatch = await executeBindWriteGate(hooks, directory, "replacement", "manifest-a.json");
    assert.equal(mismatch.reason, "handoff-mismatch");
    assert.equal(mismatch.recoverable, true);
    assert.match(String(mismatch.remedy), /dog-coordinator regenerate/i);
    const replay = await executeBindWriteGate(hooks, directory, "replacement", "manifest-b.json");
    assert.equal(replay.reason, "binding-replay");
    assert.equal(replay.recoverable, false);
    assert.deepEqual(replay.escalation, {
      action: "follow-remedy",
      resume_session: false,
      true_blocker: false,
    });
    const edited = { event: { type: "file.edited", properties: { file: "handoff.json", sessionID: "replacement" } } };
    const write = (file: string) => before(
      { tool: "write", sessionID: "replacement", callID: file },
      { args: { file, content: "not-written" } },
    );
    await event(edited);
    await expectMessage(
      () => write("old.txt"),
      'Write denied for "<unknown>": operation manifest unavailable.',
      "manifest-unavailable",
    );
    const originalNow = Date.now;
    let now = Date.now();
    Date.now = () => now;
    try {
      now += 20 * 60 * 1000;
      await chat(
        { sessionID: "replacement", agent: "dog-worker" },
        { message: { agent: "dog-worker", model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: "keep session active" }] },
      );
      now += 11 * 60 * 1000;
      await expectMessage(
        () => before(
          { tool: "apply_patch", sessionID: "replacement", callID: "expired-auth-pinned" },
          { args: { patchText: "*** Begin Patch\n*** Update File: old.txt\n@@\n-old\n+new\n*** End Patch" } },
        ),
        'Write denied for "<unknown>": operation manifest unavailable.',
        "manifest-unavailable",
      );
      await inspectHandoffWithRead(hooks, handoffPath, "replacement");
      assert.equal(
        (await executeBindWriteGate(hooks, directory, "replacement", "manifest-b.json")).reason,
        "binding-replay",
        "authorization TTL expiry must not release the session binding pin",
      );
      now += 31 * 60 * 1000;
      assert.equal(
        (await executeBindWriteGate(hooks, directory, "replacement", "manifest-b.json")).reason,
        "session-expired",
      );
      await chat(
        { sessionID: "replacement", agent: "dog-worker" },
        { message: { agent: "dog-worker", model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: "/sortie resume" }] },
      );
      await inspectHandoffWithRead(hooks, handoffPath, "replacement");
      assert.equal(
        (await executeBindWriteGate(hooks, directory, "replacement", "manifest-b.json")).reason,
        "binding-replay",
        "session reactivation must not release the original manifest pin",
      );
    } finally {
      Date.now = originalNow;
    }
  });
});

test("failed candidate handoff inspection revokes authorization without falling back", async () => {
  await withProject("candidate-inspection-failure", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(operationManifest(["old.txt"])));
    await writeFile(join(directory, "candidate-manifest.json"), JSON.stringify(operationManifest(["old.txt"])));
    const handoffPath = join(directory, "handoff.json");
    await writeFile(handoffPath, JSON.stringify(writeGateHandoff(directory, "candidate-manifest.json")));
    const hooks = await SortieDogsPlugin({ directory });
    await activate(hooks, "inspection-failure");
    const event = hooks.event;
    const before = hooks["tool.execute.before"];
    assert.ok(event);
    assert.ok(before);
    assert.equal((await bindWriteGate(hooks, directory, "inspection-failure", "candidate-manifest.json")).status, "bound");
    const edited = { event: { type: "file.edited", properties: { file: "handoff.json", sessionID: "inspection-failure" } } };
    const write = () => before(
      { tool: "write", sessionID: "inspection-failure", callID: "old" },
      { args: { file: "old.txt", content: "not-written" } },
    );

    await write();
    await writeFile(handoffPath, fixture.invalidManifestJson);
    await event(edited);
    await expectMessage(
      write,
      'Write denied for "<unknown>": operation manifest unavailable.',
      "manifest-unavailable",
    );
  });
});

test("candidate authorization fails closed when its operation manifest becomes stale", async () => {
  await withProject("candidate-stale-manifest", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(operationManifest(["fallback.txt"])));
    const manifestPath = join(directory, "candidate-manifest.json");
    await writeFile(manifestPath, JSON.stringify(operationManifest(["old.txt"])));
    await writeFile(join(directory, "handoff.json"), JSON.stringify(writeGateHandoff(directory, "candidate-manifest.json")));
    const hooks = await SortieDogsPlugin({ directory });
    await activate(hooks, "stale-manifest");
    const event = hooks.event;
    const before = hooks["tool.execute.before"];
    assert.ok(event);
    assert.ok(before);
    const originalManifest = await stat(manifestPath);
    assert.equal((await bindWriteGate(hooks, directory, "stale-manifest", "candidate-manifest.json")).status, "bound");
    const write = (file: string) => before(
      { tool: "write", sessionID: "stale-manifest", callID: file },
      { args: { file, content: "not-written" } },
    );

    await write("old.txt");
    await writeFile(manifestPath, JSON.stringify(operationManifest(["new.txt"])));
    await utimes(manifestPath, originalManifest.atime, originalManifest.mtime);
    const staleRebind = await executeBindWriteGate(
      hooks,
      directory,
      "stale-manifest",
      "candidate-manifest.json",
    );
    assert.equal(staleRebind.reason, "binding-replay");
    assert.equal(staleRebind.recoverable, false);
    await expectMessage(
      () => write("new.txt"),
      'Write denied for "<unknown>": operation manifest unavailable.',
      "manifest-unavailable",
    );
    await expectMessage(
      () => write("old.txt"),
      'Write denied for "<unknown>": operation manifest unavailable.',
      "manifest-unavailable",
    );
  });
});

test("git add requires exact explicit paths and rejects broad or undeclared pathspecs", async () => {
  await withProject("git-add-gate", async (directory) => {
    await writeFile(
      join(directory, "operation-manifest.json"),
      JSON.stringify(operationManifest(["allowed.txt", "second.txt", "nested/file.txt"])),
    );
    const hooks = await SortieDogsPlugin({ directory });
    await activate(hooks, "git-add");
    const before = hooks["tool.execute.before"];
    assert.ok(before);
    const invoke = (command: string) => before(
      { tool: "bash", sessionID: "git-add", callID: command },
      { args: { command } },
    );
    await expectMessage(
      () => invoke("git add -- allowed.txt"),
      'Write denied for "<unbound:bash>": operation manifest unavailable.',
      "manifest-unavailable",
    );
    assert.equal((await bindWriteGate(hooks, directory, "git-add")).status, "bound");
    await invoke("git add -- allowed.txt second.txt");
    await invoke("git add -- nested\\file.txt");
    await expectMessage(
      () => invoke("git add allowed.txt"),
      'Write denied for "<missing-path>": write path must be explicit.',
      "path-required",
    );
    await expectMessage(
      () => invoke("git add -- ."),
      'Write denied for "<missing-path>": write path must be explicit.',
      "path-required",
    );
    await expectMessage(
      () => invoke("git add -- allowed.txt undeclared.txt"),
      'Write denied for "undeclared.txt": operation manifest write scope.',
      "manifest-scope",
    );
  });
});

test("git commit requires the cached path set to equal the manifest", async () => {
  await withProject("git-commit-gate", async (directory) => {
    await execFileAsync("git", ["init", directory]);
    await writeFile(join(directory, "allowed.txt"), "allowed");
    await writeFile(join(directory, "second.txt"), "second");
    await writeFile(join(directory, "undeclared.txt"), "undeclared");
    await writeFile(
      join(directory, "operation-manifest.json"),
      JSON.stringify(operationManifest(["allowed.txt", "second.txt"])),
    );
    const hooks = await SortieDogsPlugin({ directory });
    await activate(hooks, "git-commit");
    assert.equal((await bindWriteGate(hooks, directory, "git-commit")).status, "bound");
    const before = hooks["tool.execute.before"];
    assert.ok(before);
    const commit = () => before(
      { tool: "bash", sessionID: "git-commit", callID: "commit" },
      { args: { command: "git commit -m gate" } },
    );
    await execFileAsync("git", ["-C", directory, "add", "--", "allowed.txt"]);
    await expectMessage(
      commit,
      'Write denied for "<cached>": operation manifest write scope.',
      "manifest-scope",
    );
    await execFileAsync("git", ["-C", directory, "add", "--", "undeclared.txt"]);
    await expectMessage(
      commit,
      'Write denied for "<repeated-command>": same command and denial reason already denied in this session; retry blocked.',
      "repeated-denial",
    );
    await execFileAsync("git", ["-C", directory, "rm", "--cached", "--", "undeclared.txt"]);
    await execFileAsync("git", ["-C", directory, "add", "--", "second.txt"]);
    await commit();
    await expectMessage(
      () => before(
        { tool: "bash", sessionID: "git-commit", callID: "commit-all" },
        { args: { command: "git commit --all -m gate" } },
      ),
      'Write denied for "<missing-path>": write path must be explicit.',
      "path-required",
    );
  });
});

test("git commit normalizes cached paths relative to a candidate subdirectory", async () => {
  await withProject("git-commit-candidate-subdirectory", async (directory) => {
    const candidateRoot = join(directory, "subrepo");
    await mkdir(candidateRoot);
    await execFileAsync("git", ["init", directory]);
    await writeFile(join(candidateRoot, "allowed.txt"), "allowed");
    await writeFile(
      join(candidateRoot, "candidate-manifest.json"),
      JSON.stringify(operationManifest(["allowed.txt"])),
    );
    await writeFile(
      join(candidateRoot, "handoff.json"),
      JSON.stringify(writeGateHandoff(candidateRoot, "candidate-manifest.json")),
    );
    await execFileAsync("git", ["-C", directory, "add", "--", "subrepo/allowed.txt"]);
    const hooks = await SortieDogsPlugin({ directory, worktree: candidateRoot });
    await activate(hooks, "candidate-commit");
    assert.equal((await bindWriteGate(hooks, candidateRoot, "candidate-commit", "candidate-manifest.json")).status, "bound");
    const event = hooks.event;
    const before = hooks["tool.execute.before"];
    assert.ok(event);
    assert.ok(before);
    await before(
      { tool: "bash", sessionID: "candidate-commit", callID: "candidate-commit" },
      { args: { command: "git commit -m gate" } },
    );
  });
});

test("git commit accepts cached descendants of declared directory scopes", async () => {
  await withProject("git-commit-directory-scope", async (directory) => {
    const generated = join(directory, "generated");
    await mkdir(generated);
    await execFileAsync("git", ["init", directory]);
    await writeFile(join(directory, "required.txt"), "required");
    await writeFile(join(generated, "result.txt"), "result");
    await writeFile(
      join(directory, "operation-manifest.json"),
      JSON.stringify(operationManifest(["required.txt", "generated"])),
    );
    await execFileAsync("git", ["-C", directory, "add", "--", "required.txt", "generated/result.txt"]);
    const hooks = await SortieDogsPlugin({ directory });
    await activate(hooks, "directory-commit");
    assert.equal((await bindWriteGate(hooks, directory, "directory-commit")).status, "bound");
    const before = hooks["tool.execute.before"];
    assert.ok(before);
    await before(
      { tool: "bash", sessionID: "directory-commit", callID: "directory-commit" },
      { args: { command: "git commit -m gate" } },
    );
  });
});

test("plugin fixture loads project and environment configuration with host override precedence", async () => {
  await withProject("configuration", async (directory) => {
    await mkdir(join(directory, ".opencode"));
    await writeFile(join(directory, "project-manifest.json"), JSON.stringify(fixture.manifest));
    await writeFile(join(directory, "environment-manifest.json"), JSON.stringify(fixture.manifest));
    await writeFile(join(directory, "override-manifest.json"), JSON.stringify(fixture.manifest));
    await writeFile(join(directory, ".opencode", "sortie-dogs.json"), JSON.stringify({
      operationManifestPath: "project-manifest.json",
      handoffPaths: ["handoff.json"],
    }));

    const previous = process.env.SORTIE_DOGS_CONFIG;
    process.env.SORTIE_DOGS_CONFIG = JSON.stringify({
      operationManifestPath: "environment-manifest.json",
    });
    try {
      const fromEnvironment = await SortieDogsPlugin({ directory });
      await invokeWrite(fromEnvironment, "allowed.txt", directory, "environment-manifest.json");
      await writeFile(
        join(directory, "handoff.json"),
        JSON.stringify(writeGateHandoff(directory, "override-manifest.json")),
      );
      const overridden = await SortieDogsPlugin(
        { directory },
        { operationManifestPath: "override-manifest.json" },
      );
      await invokeWrite(overridden, "allowed.txt", directory, "override-manifest.json");
    } finally {
      if (previous === undefined) delete process.env.SORTIE_DOGS_CONFIG;
      else process.env.SORTIE_DOGS_CONFIG = previous;
    }
  });
});

test("plugin ignores the old project config path when the new config is absent", async () => {
  await withProject("old-configuration", async (directory) => {
    await mkdir(join(directory, ".opencode"));
    await writeFile(join(directory, "legacy-manifest.json"), JSON.stringify(fixture.manifest));
    await writeFile(join(directory, ".opencode", "agent-contract-guard.json"), JSON.stringify({
      operationManifestPath: "legacy-manifest.json",
    }));

    const hooks = await SortieDogsPlugin({ directory });
    // The legacy configuration path is ignored, so the default manifest path stays absent and the
    // gate remains passive instead of adopting the legacy scope.
    await invokeWrite(hooks, "allowed.txt", directory);
  });
});

test("plugin shell gate allows explicit reads and denies unknown executables", async () => {
  await withProject("shell", async (directory) => {
    const hooks = await configuredHooks(directory);
    await activate(hooks, "shell");
    assert.equal((await bindWriteGate(hooks, directory, "shell")).status, "bound");
    const before = hooks["tool.execute.before"];
    assert.ok(before);
    const invoke = (command: string) => before(
      { tool: "bash", sessionID: "shell", callID: command },
      { args: { command } },
    );
    for (const command of fixture.shell.readOnly) await invoke(command);
    for (const command of [
      "cat $(node -e write)",
      "grep needle `node -e write`",
      'cat "${WRITE_TARGET}"',
      "cat <(node -e write)",
    ]) {
      await expectActionableCommandDenial(() => invoke(command), "active-expansion");
    }
    const invokePowerShell = (command: string) => before(
      { tool: "powershell", sessionID: "shell", callID: command },
      { args: { command } },
    );
    await invokePowerShell("$value = Get-Content env:PATH | Select-Object -First 1");
    await invokePowerShell('$value = "literal"');
    await invokePowerShell("$value = 42");
    await invokePowerShell("$value = $null");
    await invokePowerShell("$value = $other");
    await invokePowerShell("$value = $env:PATH");
    await invokePowerShell("$env:PATH");
    await invokePowerShell("git status; git rev-parse --show-toplevel; git ls-files | ForEach-Object { $_ }");
    await invokePowerShell("git ls-files | ForEach-Object { $_.Length }");
    await invokePowerShell("git ls-files | % { $_ }");
    await invokePowerShell("gh api graphql -f 'query=query { viewer { login } }'");
    await invokePowerShell("pwsh -NoProfile -Command 'Get-Date'");
    await invokePowerShell("pwsh -NoProfile -Command 'git status'");
    await expectActionableCommandDenial(
      () => invokePowerShell("pwsh -NoProfile -Command '[Console]::WriteLine((Get-Date).ToString(\"o\"))'"),
      "executable-not-allowlisted",
    );
    await expectActionableCommandDenial(
      () => invoke('echo "don\'t $(node -e write)"'),
      "active-expansion",
    );
    await expectMessage(
      () => invokePowerShell('Get-ChildItem "src\\" ; Remove-Item blocked.txt'),
      'Write denied for "blocked.txt": operation manifest write scope.',
      "manifest-scope",
    );
    for (const command of [
      "git ls-files | ForEach-Object { Remove-Item $_ }",
      "Get-Content allowed.txt | Where-Object { $_ }",
      "pwsh -File inventory.ps1",
      "pwsh -EncodedCommand Z2l0IHN0YXR1cw==",
      "pwsh -NoProfile -Command 'pwsh -NoProfile -Command ''git status'''",
    ]) {
      await expectActionableCommandDenial(() => invokePowerShell(command));
    }
    await invokePowerShell("Set-Content -LiteralPath allowed.txt -Value safe");
    await expectMessage(
      () => invokePowerShell("Get-Content allowed.txt > blocked.txt"),
      'Write denied for "blocked.txt": operation manifest write scope.',
      "manifest-scope",
    );
    for (const [command, target] of [
      ["echo x>blocked-no-space.txt", "blocked-no-space.txt"],
      ["cat allowed.txt>>blocked-append.txt", "blocked-append.txt"],
      ["echo x 2>blocked-fd.txt", "blocked-fd.txt"],
      ["echo x>|blocked-clobber.txt", "blocked-clobber.txt"],
    ] as const) {
      await expectMessage(
        () => invoke(command),
        `Write denied for "${target}": operation manifest write scope.`,
        "manifest-scope",
      );
    }
    await expectMessage(
      () => invokePowerShell("Get-Content allowed.txt>blocked-ps.txt"),
      'Write denied for "blocked-ps.txt": operation manifest write scope.',
      "manifest-scope",
    );
    await expectActionableCommandDenial(() => invoke("echo x 2>&1"), "redirect-target-unresolved");
    for (const command of [
      "$value = $(Remove-Item C:\\out\\f.txt)",
      '$value = "$(Remove-Item C:\\out\\f.txt)"',
      "$value = `Remove-Item C:\\out\\f.txt`",
    ]) {
      await expectActionableCommandDenial(() => invokePowerShell(command), "active-expansion");
    }
    await expectActionableCommandDenial(
      () => invokePowerShell("$value = & Remove-Item C:\\out\\f.txt"),
      "executable-not-allowlisted",
    );
    await invoke("echo safe > allowed.txt");
    await expectMessage(
      () => invoke("echo blocked > blocked.txt"),
      'Write denied for "blocked.txt": operation manifest write scope.',
      "manifest-scope",
    );
    await invoke('env -u GITHUB_TOKEN "/approved/gh.exe" project item-list 1 --owner example');
    await invoke('env -u GITHUB_TOKEN "/approved/gh.exe" project item-edit --id ITEM --field-id FIELD --single-select-option-id OPTION');
    await invoke('env -u GITHUB_TOKEN "/approved/gh.exe" api graphql -f query="query { viewer { login } }"');
    await invoke('env -u GITHUB_TOKEN "/approved/gh.exe" api graphql -f query="mutation { placeholder }"');
    await invoke("gh api graphql -f 'query=query { viewer { login } }'");
    await expectActionableCommandDenial(
      () => invoke('gh api graphql -f query="query { viewer { login(name: $(node -e write)) } }"'),
      "active-expansion",
    );
    await invoke("git branch --show-current");
    await expectActionableCommandDenial(() => invoke("env -u GITHUB_TOKEN node -e write"));
    await expectActionableCommandDenial(() => invoke("git branch feature"));
    for (const command of fixture.shell.unknownWrites) {
      await expectActionableCommandDenial(() => invoke(command));
    }
  });
});

test("read-only operation_manifest=none sessions need no handoff and deny every mutation", async () => {
  await withProject("unbound-reverse-allowlist", async (directory) => {
    const hooks = await configuredHooks(directory);
    // No inspected handoff or bound manifest is the runtime shape of operation_manifest=none.
    await activate(hooks, "unbound");
    const before = hooks["tool.execute.before"];
    assert.ok(before);
    const invoke = (tool: string, args: unknown) => before(
      { tool, sessionID: "unbound", callID: tool },
      { args },
    );
    await invoke("read", { filePath: join(directory, "allowed.txt") });
    await invoke("bash", { command: "git status" });
    for (const command of [
      "cat $(node -e write)",
      "grep needle `node -e write`",
    ]) {
      await expectActionableCommandDenial(() => invoke("bash", { command }), "active-expansion");
    }
    for (const command of ["echo x>blocked.txt", "cat allowed.txt>>blocked.txt"]) {
      await expectMessage(
        () => invoke("bash", { command }),
        'Write denied for "<unbound:bash>": operation manifest unavailable.',
        "manifest-unavailable",
      );
    }
    for (const [tool, args] of [
      ["multiedit", { edits: [{ file: "allowed.txt" }] }],
      ["mcp_write_file", { path: "allowed.txt" }],
      ["unknown_tool", {}],
    ] as const) {
      await expectMessage(
        () => invoke(tool, args),
        'Write denied for "<unknown>": operation manifest unavailable.',
        "manifest-unavailable",
      );
    }
    await expectActionableCommandDenial(
      () => invoke("bash", {}),
      "command-argument-missing",
    );
  });
});

test("session denial signatures normalize command whitespace without merging commands or reasons", async () => {
  await withProject("denial-signatures", async (directory) => {
    const hooks = await configuredHooks(directory);
    await activate(hooks, "denial-signatures");
    assert.equal((await bindWriteGate(hooks, directory, "denial-signatures")).status, "bound");
    const before = hooks["tool.execute.before"];
    assert.ok(before);
    const invoke = (command: string) => before(
      { tool: "powershell", sessionID: "denial-signatures", callID: command },
      { args: { command } },
    );
    await expectActionableCommandDenial(() => invoke("node -e write"), "executable-not-allowlisted");
    await expectMessage(
      () => invoke("  node   -e   write  "),
      'Write denied for "<repeated-command>": same command and denial reason already denied in this session; retry blocked.',
      "repeated-denial",
    );
    await expectActionableCommandDenial(() => invoke("node -e other-write"), "executable-not-allowlisted");
    await expectMessage(
      () => invoke("echo blocked > blocked.txt"),
      'Write denied for "blocked.txt": operation manifest write scope.',
      "manifest-scope",
    );
  });
});

test("plugin fixture accepts warning-only handoff state and dedupes per session", async () => {
  const candidate = fixtureCase("strict-warning");
  await withProject(candidate.name, async (directory) => {
    const handoffPath = join(directory, "handoff.json");
    const valid = JSON.stringify(fixture.handoffs.valid);
    const invalidValue = JSON.stringify(fixture.handoffs.invalid);
    assert.ok(Buffer.byteLength(invalidValue) < Buffer.byteLength(valid));
    const invalid = invalidValue.padEnd(Buffer.byteLength(valid), " ");
    await writeFile(handoffPath, valid);
    const fixtureTime = new Date("2035-01-02T03:04:05.000Z");
    await utimes(handoffPath, fixtureTime, fixtureTime);

    const hooks = await configuredHooks(directory);
    const event = hooks.event;
    const before = hooks["tool.execute.before"];
    assert.ok(event);
    assert.ok(before);
    await activate(hooks, "one");
    assert.equal((await bindWriteGate(hooks, directory, "one")).status, "bound");
    const edited = { event: { type: "file.edited", properties: { file: "handoff.json", sessionID: "one" } } };

    // Missing changed-path evidence produces only M007; the plugin rejects errors, not warnings.
    await event(edited);
    await event({ event: { type: "session.idle", properties: { sessionID: "one" } } });
    assert.equal((await executeBindWriteGate(hooks, directory, "one")).status, "bound");
    await expectMessage(
      () => before(
        { tool: "write", sessionID: "one", callID: "idle-still-bound" },
        { args: { file: "outside.txt", content: "not-written" } },
      ),
      'Write denied for "outside.txt": operation manifest write scope.',
      "manifest-scope",
    );
    await activate(hooks, "one");
    await event({ event: { type: "file.edited", properties: { file: "ordinary.txt", sessionID: "one" } } });
    await event({ event: { type: "unrelated.event", properties: { sessionID: "one" } } });

    const original = await stat(handoffPath);
    await writeFile(handoffPath, invalid);
    await utimes(handoffPath, original.atime, original.mtime);
    const replaced = await stat(handoffPath);
    assert.deepEqual(
      [replaced.size, replaced.mtimeMs],
      [original.size, original.mtimeMs],
      "content change fixture must retain the filesystem metadata",
    );

    await event(edited);
    await expectMessage(
      () => before(
        { tool: "write", sessionID: "one", callID: "invalid-handoff-denied" },
        { args: { file: "allowed.txt", content: "not-written" } },
      ),
      'Write denied for "<unknown>": operation manifest unavailable.',
      "manifest-unavailable",
    );
  });
});
