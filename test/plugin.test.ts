import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runtimeAssets } from "../dist/runtime-assets.js";
import { RUNTIME_ASSET_VERSION } from "../dist/asset-version.js";
import {
  ACCEPTANCE_CONTINUITY_EXTENSION,
  acceptanceContinuityFingerprint,
} from "../dist/core/acceptance-continuity.js";
import {
  FreshSessionRequiredError,
  HandoffDeniedError,
  ModelRoutingDeniedError,
  SortieDogsPlugin,
  isExplicitTaskHandoff,
} from "../dist/plugin/index.js";
import { ParallelDispatchError } from "../dist/core/worktree-parallel-dispatch.js";
import { ParallelDispatchCoordinator } from "../dist/core/worktree-parallel-dispatch.js";
import { WorktreeLifecycle } from "../dist/core/worktree-lifecycle.js";
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
  LUNA_FABRIC_WORKER_MODEL,
  LUNA_FABRIC_WORKER_ROLE,
  LUNA_FABRIC_WORKER_VARIANT,
  RECOMMENDED_SCOUT_VARIANT,
  RECOMMENDED_CONSULTATION_MODEL,
  RECOMMENDED_CONSULTATION_ROLES,
  parseModelRoutingConfig,
  resolveModelRoute,
} from "../dist/plugin/model-routing.js";
import {
  CONSULTATION_FALLBACK_RETRY_MARKER,
  lastAssistantText,
  type SessionMessage,
} from "../dist/plugin/task-result-repair.js";
import { REFLECTION_POLICY, ReflectionStore } from "../dist/reflection/index.js";
import { normalizeCommand } from "../dist/plugin/gate.js";
import { configRoot } from "../dist/reflection/config.js";
import {
  CONTINUATION_CAPABILITY,
  CONTINUATION_MARKER,
  DEFAULT_TASK_WATCHDOG_MILLISECONDS,
  ROLLOVER_MARKER,
  STEP_CONTINUE_PREFIX,
} from "../dist/plugin/continuation.js";
import { createProjectPaths, createWriteGate, extractWritePaths } from "../dist/plugin/gate.js";
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

function isFreshSessionError(
  error: unknown,
  reason: "child-lineage" | "asset-contract-skew",
  status: "redispatched" | "user-action-required" = "user-action-required",
  action?: "open-fresh-root" | "install-assets-then-open-fresh-root",
): boolean {
  return error instanceof FreshSessionRequiredError && error.result.reason === reason &&
    error.result.status === status && error.result.retry_same_session === false &&
    (action === undefined || (error.result.status === "user-action-required" && error.result.action === action));
}

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
    assert.deepEqual(parsed.modelRouting[LUNA_FABRIC_WORKER_ROLE], {
      preferred: { model: LUNA_FABRIC_WORKER_MODEL, variant: LUNA_FABRIC_WORKER_VARIANT },
    });
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

test("a host may relocate serial workers without changing the fixed Luna fabric route", () => {
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
  assert.deepEqual(configured.modelRouting[LUNA_FABRIC_WORKER_ROLE], {
    preferred: { model: LUNA_FABRIC_WORKER_MODEL, variant: LUNA_FABRIC_WORKER_VARIANT },
  });
  assert.deepEqual(resolveModelRoute({
    role: LUNA_FABRIC_WORKER_ROLE,
    local: configured.localModelRouting,
    global: configured.globalModelRouting,
    catalog: configured.modelCatalog,
    dedicated: configured.dedicatedWorkerModel,
  }), {
    ok: true,
    role: LUNA_FABRIC_WORKER_ROLE,
    source: "fixed",
    catalog: "global",
    model: LUNA_FABRIC_WORKER_MODEL,
    variant: LUNA_FABRIC_WORKER_VARIANT,
  });
  // Declaring either role directly still cannot displace fixed serial/fabric policy.
  const attempted = resolvePluginConfiguration({
    dedicatedWorkerModel: target,
    modelRouting: {
      "dog-worker": { model: "attempted/override" },
      [LUNA_FABRIC_WORKER_ROLE]: { model: "attempted/fabric-override" },
    },
  });
  assert.equal(attempted.kind, "configured");
  if (attempted.kind === "configured") {
    assert.deepEqual(attempted.modelRouting["dog-worker"], { preferred: target });
    assert.deepEqual(attempted.modelRouting[LUNA_FABRIC_WORKER_ROLE], {
      preferred: { model: LUNA_FABRIC_WORKER_MODEL, variant: LUNA_FABRIC_WORKER_VARIANT },
    });
  }
  assert.deepEqual(resolvePluginConfiguration({
    dedicatedWorkerModel: { model: LUNA_FABRIC_WORKER_MODEL },
  }), { kind: "invalid" });
  assert.deepEqual(resolvePluginConfiguration({
    dedicatedWorkerModel: { model: LUNA_FABRIC_WORKER_MODEL, variant: "high" },
  }), { kind: "invalid" });
  const laterSerialOverride = resolvePluginConfiguration(
    { dedicatedWorkerModel: { model: LUNA_FABRIC_WORKER_MODEL } },
    { dedicatedWorkerModel: target },
  );
  assert.equal(laterSerialOverride.kind, "configured");
  if (laterSerialOverride.kind === "configured") {
    assert.deepEqual(laterSerialOverride.dedicatedWorkerModel, target);
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
  // The host declared another Luna variant, so it joins the shared scout/fabric catalog entry.
  assert.deepEqual(defaults.modelCatalog.global, [
    {
      model: DEFAULT_COORDINATOR_MODEL,
      variants: [DEFAULT_COORDINATOR_VARIANT],
    },
    {
      model: DEDICATED_WORKER_MODEL,
      variants: [DEDICATED_WORKER_VARIANT, CONSULTATION_FALLBACK_VARIANT]
        .filter((variant, index, all) => all.indexOf(variant) === index),
    },
    {
      model: LUNA_FABRIC_WORKER_MODEL,
      variants: [LUNA_FABRIC_WORKER_VARIANT, RECOMMENDED_SCOUT_VARIANT, "xhigh"]
        .filter((variant, index, all) => all.indexOf(variant) === index),
    },
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
    configured: { preferred: { model: LUNA_FABRIC_WORKER_MODEL, variant } },
    resolved: {
      ok: true,
      role,
      source: "global",
      catalog: "global",
      model: LUNA_FABRIC_WORKER_MODEL,
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
   * Review has to be able to reject what the worker produced, so the fallback stays at a higher effort
   * than the stable serial worker even though both routes use Sol.
   */
  assert.equal(ESCALATION_WORKER_VARIANT, DEDICATED_WORKER_VARIANT);
  assert.notEqual(CONSULTATION_FALLBACK_VARIANT, DEDICATED_WORKER_VARIANT);

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
  assert.deepEqual(resolveModelRoute({
    role: LUNA_FABRIC_WORKER_ROLE,
    local: missingSol.localModelRouting,
    global: missingSol.globalModelRouting,
    catalog: missingSol.modelCatalog,
  }), {
    ok: false,
    role: LUNA_FABRIC_WORKER_ROLE,
    reason: "unresolved-role",
    attempts: [{
      source: "fixed",
      target: { model: LUNA_FABRIC_WORKER_MODEL, variant: LUNA_FABRIC_WORKER_VARIANT },
      reason: "model-unavailable",
    }],
  });
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
  assert.equal(SOURCE_REVIEW_RISK_TAGS.length, 19);
  assert.deepEqual(SOURCE_REVIEW_RISK_TAGS, [
    "security", "credential", "permission", "network", "public-api", "privacy", "transaction", "time",
    "timezone", "public-logic",
    "storage-compatibility", "package", "build", "release", "migration", "concurrency", "process-io",
    "write-gate", "authorization",
  ]);
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
  const lunaWorker = runtimeAssets.find((asset) => asset.name === LUNA_FABRIC_WORKER_ROLE);
  assert.ok(dogWorker);
  assert.ok(lunaWorker);
  assert.ok(dogWorker.content.startsWith(`---
description: Dedicated worker for the canonical Sortie-dogs coordinator
mode: subagent
---
`));
  // Pinning an unavailable model in the asset would stop the agent from loading at all, so the
  // dedicated target stays a routing decision that a host can redeclare.
  assert.equal(dogWorker.content.includes(DEDICATED_WORKER_MODEL), false);
  assert.ok(lunaWorker.content.startsWith(`---
description: Isolated Luna fabric worker for one admitted Sortie-dogs unit
mode: subagent
---
`));
  assert.equal(lunaWorker.content.includes(LUNA_FABRIC_WORKER_MODEL), false);
  for (const asset of [dogWorker, lunaWorker]) {
    assert.match(asset.content, /## Shared worker contract/u);
    assert.match(asset.content, /same immutable manifests/u);
    assert.match(asset.content, /sortie_bind_write_gate/u);
    assert.match(asset.content, /Every failed validation must produce a concrete source or harness change/u);
  }
});

test("generated coordinator requires bounded progress, one Task evidence line, and deny-safe delegation", () => {
  const coordinator = runtimeAssets.find((asset) => asset.name === "dog-coordinator");
  assert.ok(coordinator);
  const content = coordinator.content.replace(/\s+/gu, " ");
  for (const required of [
    "進行中: <candidate> — worker dispatch",
    "根拠(<child>/<role>): <result evidence>",
    "no duplicate assessment or next-action projection",
    "Never test an unapproved script in the coordinator shell",
    "After a command deny",
    "explicit user correction, renewed authorization, or project-instruction exact executable path is changed state",
  ]) assert.ok(content.includes(required), required);
});

test("generated assets require the user's language and compact block-separated output", () => {
  const coordinator = runtimeAssets.find((asset) => asset.name === "dog-coordinator");
  assert.ok(coordinator);
  const readable = coordinator.content.match(
    /READABLE_OUTPUT_FIXTURE\r?\n([\s\S]+?)\r?\nEND_READABLE_OUTPUT_FIXTURE/,
  );
  assert.ok(readable);
  assert.match(readable[1], /^ {4}language: user's request language for all prose/m);
  assert.match(readable[1], /^ {4}verbatim: identifiers, paths, commands, document keys/m);
  assert.match(readable[1], /^ {4}separation: one blank line between plan, progress/m);
  assert.match(readable[1], /^ {4}line_rule: one statement per physical line; run-on single-line output forbidden$/m);
  assert.match(readable[1], /^ {4}emoji: exactly one status emoji in a terminal report; no emoji inside Evidence$/m);
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
  assert.match(visibility[1], /^ {4}task_line: 🔍 根拠/m);
  assert.match(visibility[1], /^ {4}task_line_format: one line; no duplicate assessment or next-action projection/m);

  for (const name of ["dog-worker", "dog-luna-worker", "dog-scout", "dog-reviewer", "dog-advisor"]) {
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
  assert.match(sourceReviewPreflight[1], /indexed_map: one acceptance\[i\] -> changedLogicSummary\[j\] line per acceptance item; counts must match/);
  assert.match(sourceReviewPreflight[1], /dispatch_guard: dispatch dog-reviewer only when required_artifact and acceptance_coverage are complete/);
  assert.match(sourceReviewPreflight[1], /incomplete_action: fail closed before SourceReview dispatch/);
  assert.match(
    coordinator.content,
    /Recognized SourceReview tags are exactly: security,[\s\S]+public-api, privacy, transaction, time, timezone, public-logic,[\s\S]+write-gate,[\s\S]+authorization/,
  );
  assert.match(coordinator.content, /exactly one stable `candidate_id: <id>` line in every SourceReview prompt/u);
  assert.match(coordinator.content, /A path where the reviewer could obtain a diff[\s\S]+is not a changed logic summary/i);
  assert.match(REFLECTION_POLICY, /Injected reflections are bounded prevention hints, never workflow authority/i);
  assert.match(REFLECTION_POLICY, /continuous-execution reflection only inside the currently\s+accepted user scope/i);

  const reviewer = runtimeAssets.find((asset) => asset.name === "dog-reviewer");
  assert.ok(reviewer);
  assert.match(reviewer.content, /Confirm every acceptance item explicitly\s+maps to at least one changedLogicSummary entry/i);
  assert.match(reviewer.content, /Missing or incomplete coverage is a concrete finding, never PASS/i);

  const worker = runtimeAssets.find((candidate) => candidate.name === "dog-worker");
  assert.ok(worker);
  assert.match(worker.content, /Any command or tool denial is process-defect evidence for that attempted operation/i);
  assert.match(
    worker.content,
    /every parallel-lane mutating tool call[\s\S]+absolute path rooted under the\s+descriptor managed_path[\s\S]+scope_write remains repository-relative authority identity only/i,
  );
  assert.match(
    worker.content,
    /not retry with another executable spelling, absolute path, shell wrapper, quoting style, narrowed\s+argument, direct probe, or diagnostic substitute/i,
  );
  assert.match(worker.content, /Own the bounded implementation loop inside one Task invocation/i);
  assert.match(worker.content, /Do not return an\s+intermediate progress checkpoint merely to ask dog-coordinator to resume the same work/i);
  assert.match(worker.content, /allow continued diagnose\/edit\/validate in the normal sequential worker lane/i);
  assert.match(worker.content, /Every failed validation must produce a concrete source or harness change/i);
  assert.match(worker.content, /unchanged command repetition is forbidden/i);
  assert.match(worker.content, /Retain ordered validation history and\s+canonical\/diagnostic counts across resumes and redispatches/i);
  assert.match(worker.content, /every terminal BLOCKED report must include its own line in the exact form TRUE_BLOCKER: external: <condition>/i);
  assert.match(worker.content, /Run only the exact canonical validation command\s+and its optional single diagnostic command predeclared in the applicable handoff and operation\s+manifest, or in the inline validation contract when operation_manifest=none/i);
  assert.match(worker.content, /denied optional\s+check remains DENIED evidence and never justifies unchanged repetition/i);
});

test("generated coordinator renders a compact conclusion and collapsible YAML Evidence", () => {
  const coordinator = runtimeAssets.find((asset) => asset.name === "dog-coordinator");
  assert.ok(coordinator);
  const semantics = coordinator.content.match(
    /TERMINAL_STATUS_SEMANTICS_FIXTURE\r?\n([\s\S]+?)\r?\nEND_TERMINAL_STATUS_SEMANTICS_FIXTURE/,
  );
  assert.ok(semantics);
  assert.match(semantics[1], /DONE: requested evaluation completed, including evidence-based candidate rejection or non-adoption/);
  assert.match(semantics[1], /status_icons: DONE=✅ \| BLOCKED=⛔ \| NEED_DECISION=❓/u);
  assert.match(semantics[1], /quality_gate_fail: validation evidence \+ autonomous non-adoption decision -> DONE; release remains unperformed/);
  assert.match(semantics[1], /process_defect: gate \| routing \| handoff \| local tool defect -> autonomous repair; never terminal BLOCKED/);
  assert.match(coordinator.content, /plugin injects a measured \*\*Run:\*\* paragraph/i);
  assert.match(coordinator.content, /Do not emit,\s*estimate, or fabricate Run metrics/i);
  assert.match(coordinator.content, /LUNA_FABRIC_CONTRACT_SHAPE_FIXTURE/);
  assert.match(coordinator.content, /"version": "0\.8\.0"/);
  assert.match(coordinator.content, /"validation": \{ "level": "targeted", "command":/);
  const output = coordinator.content.match(
    /TERMINAL_OUTPUT_TEMPLATE\r?\n([\s\S]+?)\r?\nEND_TERMINAL_OUTPUT_TEMPLATE/,
  );
  assert.ok(output);
  const [summary, evidence] = output[1].split(/\r?\n\r?\n(?=<details>)/);
  assert.ok(summary);
  assert.ok(evidence);
  assert.deepEqual(summary.split(/\r?\n\r?\n/), [
    "<status emoji> **<DONE | BLOCKED | NEED_DECISION>** `<stable task id>` — <short conclusion>",
    "**Validation:** <ordered PASS/FAIL summary>",
    "**Next:** <single action or none>",
  ], "visible conclusion is three compact paragraphs without list styling");
  assert.equal(summary.match(/<status emoji>/gu)?.length, 1, "template has one status emoji slot");
  assert.doesNotMatch(summary, /^-/mu, "visible conclusion has no Markdown list items");
  assert.match(evidence, /^<details>\r?\n<summary>Evidence: <compact counts><\/summary>/u);
  assert.match(evidence, /\r?\n```yaml\r?\n[\s\S]+\r?\n```\r?\n\r?\n<\/details>$/u);
  assert.doesNotMatch(evidence, /[✅⛔❓🎯📊🐕🔍➡️]/u, "Evidence has no icons");
  const yaml = /```yaml\r?\n([\s\S]+?)\r?\n```/u.exec(evidence)?.[1];
  assert.ok(yaml);
  assert.match(yaml, /^manifest:\r?\n {2}source:\r?\n {4}- <exact source path>\r?\n {2}operation:/mu);
  assert.match(yaml, /^decisions:\r?\n {2}- /mu);
  assert.match(yaml, /^validation:$/mu);
  assert.doesNotMatch(yaml, /^(?:status|task_id|next_action|scout|tracker):/mu, "empty and duplicated fields are omitted");
  const validationEntries = [...yaml.matchAll(
    /^ {2}- command: (.+)\r?\n {4}exit: (.+)\r?\n {4}fingerprint: (.+)$/gmu,
  )].map((match) => ({ command: match[1], exit: Number(match[2]), fingerprint: match[3] }));
  assert.deepEqual(validationEntries, [
    { command: "npm test", exit: 1, fingerprint: "initial failure" },
    { command: "npm test", exit: 0, fingerprint: "final pass" },
  ], "fenced YAML retains append-only command, exit, and fingerprint evidence");
  assert.match(
    coordinator.content,
    /conclusion is the user's answer[\s\S]+detail layer, never a replacement for the conclusion/i,
  );
  assert.match(coordinator.content, /first non-empty\s+output: no plan, progress, assessment, Evidence heading, or preamble may precede it/i);
  assert.match(coordinator.content, /Omit false, none,\s+empty arrays, empty objects, and fields already represented by the status line or Next paragraph/i);
  assert.match(coordinator.content, /status, task_id, and next_action never repeat inside Evidence/i);
});

test("coordinator DONE output receives host-reported root and child run metrics", async () => {
  await withProject("done-run-metrics", async (directory) => {
    const created = Date.now() - 65_000;
    const logs: Array<Record<string, unknown>> = [];
    const hooks = await SortieDogsPlugin({ directory, client: { app: {
      log: (request: Record<string, unknown>) => { logs.push(request); return Promise.resolve(true); },
    }, session: {
      get: async () => ({ data: { agent: "dog-coordinator", time: { created } } }),
      children: async ({ path }) => ({ data: path.id === "root" ? [{ id: "child" }] : [] }),
      messages: async ({ path }) => ({ data: path.id === "root" ? [{ info: {
        id: "root-step", role: "assistant", agent: "dog-coordinator", cost: 0.1,
        tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 50, write: 5 } },
      } }] : [{ info: {
        id: "child-step", role: "assistant", agent: "dog-worker", cost: 0.2,
        tokens: { input: 30, output: 5, reasoning: 0, cache: { read: 10, write: 0 } },
      } }] }),
    } } as never });
    await hooks["chat.message"]!(
      { sessionID: "root", agent: "dog-coordinator" },
      {
        message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } },
        parts: [{ type: "text", text: "task" }],
      },
    );
    await hooks["tool.execute.before"]!(
      { tool: "read", sessionID: "root", callID: "metrics-read", agent: "dog-coordinator" },
      { args: { filePath: join(directory, "operation-manifest.json") } },
    );
    await hooks["tool.execute.before"]!(
      { tool: "read", sessionID: "root", callID: "metrics-bootstrap", agent: "build" },
      { args: { filePath: join(directory, "operation-manifest.json") } },
    );
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "root" } } });
    const compacted = { context: ["old context"], prompt: "old prompt" };
    await hooks["experimental.session.compacting"]!({ sessionID: "root" }, compacted);
    const completed = {
      text: "✅ **DONE** `metrics` — complete\n\n**Validation:** PASS\n\n**Next:** none\n\n<details>evidence</details>",
    };
    await hooks["experimental.text.complete"]!({ sessionID: "root" }, completed);
    assert.match(completed.text, /^✅ \*\*DONE\*\*[^\n]+\n\n\*\*Run:\*\* pre-terminal host snapshot · 1m /u);
    assert.match(completed.text, /pre-terminal host snapshot[\s\S]*215 tokens · \$0\.3000 · 2 completed assistant model steps · 2 sessions · 27\.9% cache ratio/u);
    assert.match(completed.text, /\n\n\*\*Validation:\*\* PASS/u);
    const runLogs = () => logs.filter((entry) =>
      (entry.body as { message?: unknown } | undefined)?.message === "run-metrics.snapshot"
    );
    assert.equal(runLogs().length, 1);
    const first = runLogs()[0]!;
    assert.deepEqual(first.query, { directory });
    const body = first.body as {
      service: string;
      level: string;
      message: string;
      extra: Record<string, unknown>;
    };
    assert.equal(body.service, "sortie-dogs");
    assert.equal(body.level, "info");
    assert.equal(body.message, "run-metrics.snapshot");
    assert.equal(body.extra.available, true);
    assert.equal(body.extra.outcome, "DONE");
    assert.equal(body.extra.sessionID, "root");
    assert.equal(body.extra.runtimeAssetVersion, "0.3.63-luna-artifact-join-v1");
    assert.equal(body.extra.inputTokens, 130);
    assert.equal(body.extra.outputTokens, 15);
    assert.equal(body.extra.reasoningTokens, 5);
    assert.equal(body.extra.cacheReadTokens, 60);
    assert.equal(body.extra.cacheWriteTokens, 5);
    assert.deepEqual(body.extra.roles, {
      "dog-coordinator": {
        tokens: 170, inputTokens: 100, outputTokens: 10, reasoningTokens: 5,
        cacheReadTokens: 50, cacheWriteTokens: 5, cost: 0.1, steps: 1, cacheRatio: 50 / 170,
      },
      "dog-worker": {
        tokens: 45, inputTokens: 30, outputTokens: 5, reasoningTokens: 0,
        cacheReadTokens: 10, cacheWriteTokens: 0, cost: 0.2, steps: 1, cacheRatio: 10 / 45,
      },
    });
    assert.equal(body.extra.compactionPolicyCount, 1);
    assert.equal(body.extra.compactionContextInputBytes, Buffer.byteLength("old context"));
    assert.ok((body.extra.compactionContextOutputBytes as number) > Buffer.byteLength("old context"));
    assert.equal(body.extra.compactionPromptInputBytes, Buffer.byteLength("old prompt"));
    assert.ok((body.extra.compactionPromptOutputBytes as number) > Buffer.byteLength("old prompt"));
    assert.equal(body.extra.hostSessionIdentityCount, 1);
    assert.equal(body.extra.bootstrapControlStateCount, 2);
    assert.equal(body.extra.collectRunMetricsCount, 1);
    for (const key of [
      "hostSessionIdentityElapsedMilliseconds",
      "bootstrapControlStateElapsedMilliseconds",
      "collectRunMetricsElapsedMilliseconds",
    ]) {
      assert.equal(typeof body.extra[key], "number");
      assert.ok((body.extra[key] as number) >= 0);
    }
    const terminalTransition = logs.find((entry) =>
      (entry.body as { message?: unknown } | undefined)?.message === "continuation.not_required"
    );
    assert.ok(terminalTransition);
    assert.deepEqual(terminalTransition.query, { directory });
    assert.deepEqual((terminalTransition.body as { level: string; extra: Record<string, unknown> }).level, "info");
    assert.deepEqual(
      Object.keys((terminalTransition.body as { extra: Record<string, unknown> }).extra).sort(),
      ["attempts", "epoch", "reason", "resumeAttempts", "sessionID"],
    );

    await hooks.event!({ event: { type: "session.deleted", properties: { sessionID: "root" } } });
    await hooks["chat.message"]!(
      { sessionID: "root", agent: "dog-coordinator" },
      {
        message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } },
        parts: [{ type: "text", text: "new task" }],
      },
    );
    await hooks["tool.execute.before"]!(
      { tool: "read", sessionID: "root", callID: "metrics-read-2", agent: "dog-coordinator" },
      { args: { filePath: join(directory, "operation-manifest.json") } },
    );
    await hooks["tool.execute.before"]!(
      { tool: "read", sessionID: "root", callID: "metrics-bootstrap-2", agent: "build" },
      { args: { filePath: join(directory, "operation-manifest.json") } },
    );
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "root" } } });
    const second = { text: "✅ **DONE** `metrics-2` — complete" };
    await hooks["experimental.text.complete"]!({ sessionID: "root" }, second);
    assert.equal(runLogs().length, 2);
    const reset = (runLogs()[1]!.body as { extra: Record<string, unknown> }).extra;
    assert.equal(reset.hostSessionIdentityCount, 1);
    assert.equal(reset.bootstrapControlStateCount, 2);
    assert.equal(reset.collectRunMetricsCount, 1);
  });
});

test("terminal run metrics log an unavailable snapshot when host metrics cannot be collected", async () => {
  await withProject("unavailable-run-metrics", async (directory) => {
    const logs: Array<Record<string, unknown>> = [];
    const hooks = await SortieDogsPlugin({ directory, client: {
      app: { log: (request: Record<string, unknown>) => { logs.push(request); return Promise.resolve(true); } },
      session: { get: async () => ({ data: { agent: "dog-coordinator" } }) },
    } as never });
    await hooks["chat.message"]!(
      { sessionID: "root", agent: "dog-coordinator" },
      {
        message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } },
        parts: [{ type: "text", text: "task" }],
      },
    );
    const completed = { text: "✅ **DONE** `metrics-unavailable` — complete" };
    await hooks["experimental.text.complete"]!({ sessionID: "root" }, completed);

    const snapshots = logs.filter((entry) =>
      (entry.body as { message?: unknown } | undefined)?.message === "run-metrics.snapshot"
    );
    assert.equal(snapshots.length, 1);
    const body = snapshots[0]!.body as { level: string; extra: Record<string, unknown> };
    assert.equal(body.level, "info");
    assert.equal(body.extra.available, false);
    assert.equal(body.extra.collectRunMetricsCount, 1);
    assert.equal(typeof body.extra.collectRunMetricsElapsedMilliseconds, "number");
    assert.doesNotMatch(completed.text, /\*\*Run:\*\*/u);
  });
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
  assert.match(preflight[1], /defective_dispatch: forbidden/);
  assert.match(preflight[1], /default_path: <project root>\/\.sortie-dogs\/contracts\/handoff\.<id>\.json/);
  assert.match(preflight[1], /timing: before Task dispatch and after every handoff regeneration/);
  assert.match(preflight[1], /authorization: read-only report; never inspection, bind, or mutation/);
  assert.match(preflight[1], /configured fixed path or \.sortie-dogs\/contracts\/handoff\.<id>\.json with filename id exactly equal to handoff id/);
  assert.match(preflight[1], /<id>\.operation-manifest\.json is unique to the same active coordinator contract/);
  assert.match(preflight[1], /arbitrary filename or filename\/id mismatch -> defective before dispatch/);
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
    /^permission:\r?\n  question: allow\r?\n  task:\r?\n    "\*": deny\r?\n    dog-worker: allow\r?\n    dog-luna-worker: allow\r?\n    dog-scout: allow\r?\n    dog-reviewer: allow\r?\n    dog-advisor: allow\r?\ntools:\r?\n  question: true\r?\n  task: true$/mu,
  );
  for (const denied of ["build", "implementer", "fixer", "reviewer", "explore", "general", "coordinator"]) {
    assert.doesNotMatch(coordinator.content, new RegExp(`^    ${denied}: allow$`, "m"));
  }
  assert.match(question[1], /context_line_1:/);
  assert.match(question[1], /context_line_5:/);
  assert.match(question[1], /invoke question tool; plain-text final forbidden/);
  assert.match(question[1], /unavailable_fallback: canonical NEED_DECISION once/);
  assert.match(question[1], /automatically resume the same candidate flow/);
  /*
   * Scoping the tool to blocked external state left every design or scope choice as a prose question,
   * which ends the turn without the selectable options the user asked to answer.
   */
  assert.match(question[1], /^ {4}trigger: any user question, including [\s\S]*design or scope choice/m);
  assert.match(question[1], /^ {4}payload: \{ question: .+ options: \[\{ label: <choice; recommended first>/m);
  assert.match(
    coordinator.content,
    /Every question you do put to the user[\s\S]+goes through the question tool[\s\S]+Never end a turn with a question written as prose/,
  );
  assert.match(coordinator.content, /Ask only when the missing fact or choice is exclusively user-controlled/);
  assert.match(coordinator.content, /normal Scout and sequential-worker lanes[\s\S]+no per-turn count ceiling/);

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
  assert.match(handshake[1], /TRUE_BLOCKER: external: <condition> or TRUE_BLOCKER: user-decision: <condition> absent -> blocker-resolution takeover on the same solSession/);
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
  assert.match(batch[1], /mode=runtime sequential-worker lane/);
  assert.match(batch[1], /top_level_request: one accepted scope -> sequential workers as evidence requires/);
  assert.match(batch[1], /worker_return: deterministic evidence verification -> next unit \| terminal report/);
  assert.match(batch[1], /normal_path_forbidden: concurrent fanout \| unchanged redispatch \| critical-path tracker call/);
  assert.match(batch[1], /compaction: host overflow \| repeated nonterminal recovery \| guarded direct capability/);

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
  assert.match(coordinator.content, /Build the bounded flush\s+payload in process memory from pendingTrackerUpdates/i);
  assert.match(coordinator.content, /never write it or tracker metadata to a script\s+or file/i);
  const direct = coordinator.content.match(
    /COORDINATOR_DIRECT_OPERATION_FIXTURE\r?\n([\s\S]+?)\r?\nEND_COORDINATOR_DIRECT_OPERATION_FIXTURE/,
  );
  assert.ok(direct);
  for (const contract of [
    "known_executable_probe: one batched direct depth-one read-only command; no Task",
    "graphify_route: direct query once -> unavailable | script denial -> bounded read | grep; no source inspection",
    "windows_gh: literal token clears -> direct client; no if | Test-Path | scriptblock",
    "executable_absent: question tool; no worker discovery or recursive search",
    "project_inventory: exactly one complete snapshot per top-level user request in one direct client invocation; no Task",
    "pagination: all pages inside that invocation until pageInfo.hasNextPage=false; no model turn per page",
    "candidate_queue: snapshot selects at most configured batch bound; evaluate full body once then retain identity | status | ordering | implementation root | exact handoff path | opaque acceptance fingerprint only; raw body discarded",
    "fingerprint_algorithm: Unicode NFC + CRLF/CR to LF + no trim; lowercase hex SHA-256 full body",
    "inventory_fingerprint_algorithm: fixed key order identity,status,ordering,implementationRoot,handoffPath,acceptanceFingerprint + sort ordering then identity + NFC/LF + compact canonical JSON + lowercase hex SHA-256",
    "checkpoint_authority: summary never authors acceptance; preserve exact fingerprint + handoff path; reread exact immutable handoff after compaction",
    "inventory_reuse: compaction | worker return | local tracker mutation never invalidate; apply successful mutations locally then recompute canonical inventoryFingerprint before compaction or selection",
    "inventory_retry: external failure -> forbidden; local construction | JSON decode defect -> one corrected approved-client invocation; unchanged payload forbidden; total invocations <=2",
    "candidate_body: full body evaluated at snapshot acquisition; exact immutable handoff + opaque fingerprint are sufficient after compaction",
    "relevance_gate: current user scope + project evidence required; title | order | bulk status insufficient",
    "relevance_ambiguous: one question before mutation or dispatch",
    "active_project_root: most specific task + tracker + project-instruction owner; immutable source ownership and local commit root",
    "workspace_ancestor: multiple projects below it -> forbidden as activeProjectRoot",
    "unrelated_external_root: hold | reassign | switch owning project; no inspect | dispatch | mutation",
    "cross_project_recommendation: forbidden; recommend project-local option or hold",
    "authorized_remote_target: project instructions or explicit user selection + same logical project -> execute from current session",
    "remote_worker_root: active local project; exact transport + host + remote path + scope + validation in local operation manifest",
    "guest_opencode_session: never required for an authorized remote target",
    "remote_unknown: ask once for missing host | root; never report cross-project capacity unavailable",
    "remote_safety_boundary: environment authorization never waives credential | destructive | publication | promotion gates",
    "canonical_validation: exact accepted handoff or manifest command + project authorization -> coordinator-owned fallback",
    "worker_validation_denial: executable-not-allowlisted -> compare declared command with actual shell spelling; repair once | coordinator fallback",
    "validation_fallback: coordinator direct exactly once; user reauthorization or project exact executable path resumes without another question",
    "denied_command_equivalence: PowerShell call operator + quoted absolute executable equals declared bare absolute executable with identical arguments",
    "denial_classification: routing defect; not external blocker | not validation failure",
    "terminal_checkpoint: append session-only pendingTrackerUpdates; no external tracker call per unit",
    "batch_flush: one coordinator-owned direct tracker invocation when batch stops; apply every pending update",
    "durable_session_state: terminal Evidence + compaction summary preserve inventoryFingerprint | candidateQueue | pendingTrackerUpdates | trackerFlushState",
    "restart_reconcile: stale tracker -> require git + source + matching opaque acceptanceFingerprint + durable handoff; accepted commit becomes batchReconciled, never reimplemented",
    "flush_failure: source outcomes authoritative + reconciliation pending; no same-request retry",
    "github_auth: approved gh only + child-process GITHUB_TOKEN/GH_TOKEN clear when guide requires stored auth; credential extraction forbidden",
    "github_failure: auth | rate-limit | transport | API GraphQL error -> whole-batch blocker; no retry | REST fallback | query rewrite | diagnostic API",
    "local_inventory_defect: quoting | variable binding | stdout JSON decode before valid API result -> name defect; one corrected same-client same-query-shape invocation; no direct HTTP",
    "direct_operation_artifacts: no handoff | operation manifest | generated script | child session; inventory and flush payloads stay process-only",
    "tracker_unavailable: redacted session checkpoint; never a worker or API retry loop",
  ]) assert.ok(direct[1].includes(contract), contract);
  const projectInventoryQuery = coordinator.content.match(
    /PROJECT_V2_INVENTORY_QUERY_FIXTURE\r?\n([\s\S]+?)\r?\nEND_PROJECT_V2_INVENTORY_QUERY_FIXTURE/,
  );
  assert.ok(projectInventoryQuery, "coordinator needs a canonical ProjectV2 inventory query");
  for (const contract of [
    "query($id: ID!, $endCursor: String)",
    "items(first: 100, after: $endCursor)",
    "... on DraftIssue { id title body }",
    "... on Issue { id title body }",
    "... on PullRequest { id title body }",
    "... on ProjectV2ItemFieldSingleSelectValue",
    "... on ProjectV2ItemFieldTextValue",
    "... on ProjectV2ItemFieldNumberValue",
    "pageInfo { hasNextPage endCursor }",
    "guide_gate: read exact tracker section named by root instructions; unrelated runbook insufficient",
    "query_source: complete guide query verbatim or this canonical fallback verbatim",
    "invocation: direct env token-clear + approved gh api graphql --paginate --slurp + jq aggregate pipeline",
    "pagination: native gh $endCursor pagination; manual loop + assignment + command substitution forbidden",
    "query_binding: one single-quoted -f 'query=<canonical multiline query>' argument; QUERY assignment + variable expansion forbidden",
    "output_boundary: jq emits aggregate only; raw Project response remains process-only and is never printed or saved",
    "local_retry: shell quoting + variable binding + output decoding only; query text unchanged",
    "repeated_local_failure: user authorized stuck consultation -> dog-advisor material-uncertainty before terminal; third inventory invocation forbidden",
  ]) assert.ok(projectInventoryQuery[1].includes(contract), contract);
  const projectQueryText = projectInventoryQuery[1].split(/^\s*guide_gate:/mu)[0];
  assert.equal(projectQueryText.match(/\{/gu)?.length, projectQueryText.match(/\}/gu)?.length);
  assert.equal(projectQueryText.match(/\(/gu)?.length, projectQueryText.match(/\)/gu)?.length);
  const scoutFanout = coordinator.content.match(
    /SCOUT_FANOUT_FIXTURE\r?\n([\s\S]+?)\r?\nEND_SCOUT_FANOUT_FIXTURE/,
  );
  assert.ok(scoutFanout);
  for (const contract of [
    "decision: exceptional; one concrete evidence key blocks safe worker dispatch",
    "dispatch_guard: exact unresolved gap + no unchanged duplicate",
    "dispatch: one bounded dog-scout call per concrete gap; later new gaps allowed",
    "role: resolve only missing_evidence_code",
    "invalid: prompt defect -> corrected dispatch | user-controlled gap -> question | external failure -> blocker",
    "next_route: resolved -> next dog-worker | new gap -> bounded Scout | user decision | blocker",
  ]) assert.ok(scoutFanout[1].includes(contract), contract);
  assert.match(
    coordinator.content,
    new RegExp(`configured continuation capability is\\s+the plugin tool ${CONTINUATION_CAPABILITY}`, "i"),
  );

  assert.doesNotMatch(coordinator.content, /REFLECTION_POLICY_FIXTURE/u);
  const reflection = REFLECTION_POLICY.match(
    /REFLECTION_POLICY_FIXTURE\r?\n([\s\S]+?)\r?\nEND_REFLECTION_POLICY_FIXTURE/,
  );
  assert.ok(reflection);
  assert.match(reflection[1], /checkpoints: user correction immediately \| other evidence after resolved blocker or review defect \| terminal unit/);
  assert.match(
    reflection[1],
    /allowed_evidence: user-correction \| repeated-process-failure \| review-artifact-defect \| retry-policy-violation/,
  );
  assert.match(
    REFLECTION_POLICY,
    /Global-layer writes are forbidden by default and allowed only when the user or config explicitly enables\s+reflection\.layers\.global\./,
  );
  assert.match(reflection[1], /global_layer: forbidden by default; allowed only when user or config explicitly enables reflection\.layers\.global/);
  assert.match(reflection[1], /attribution: before\/after state or exact command evidence required/);
  assert.match(reflection[1], /tracker_privacy: no item\/node\/draft ID \| URL \| title \| body \| field value \| status \| inventory payload/);
  assert.match(reflection[1], /user_correction_layer: project immediately/);
  assert.match(reflection[1], /project_layer: same stable scope recurred in a later unit or was injected from an earlier run/);
  assert.match(reflection[1], /dedup: same scope updates trigger and hits; equivalent evidence reuses the injected scope; synonym scopes forbidden/);
  assert.match(reflection[1], /call_limit: one record per triggering event; three record calls per run/);
  assert.match(reflection[1], /injected_project_recurrence: record project once to increment hits/);
  assert.match(reflection[1], /non_triggers: code bug \| ordinary validation failure/);
  assert.match(reflection[1], /call: sortie_reflection \{ action: record, layer: <run\|project\|global>/);
  assert.match(reflection[1], /field_budget: concise ASCII English; scope \+ trigger \+ cause \+ prevention \+ evidenceRef <=400 characters total/);
  assert.match(reflection[1], /scope_format: lowercase kebab-case \[a-z0-9-\]\+; underscores forbidden/);
  assert.match(reflection[1], /list: never before record; once before replace \| forget \| promote only when target id is absent/);
  assert.match(reflection[1], /correction: improved cause or prevention -> replace; disproved attribution -> forget/);
  assert.match(reflection[1], /forget_confirmation: none; exact entry id is the deletion boundary/);
  assert.match(reflection[1], /durable_fix: hits>=2 or policy-related user correction -> report follow-up after active batch; new explicit top-level request required/);
  assert.match(reflection[1], /active_batch_quarantine: no process-only candidate \| instruction edit \| Task \| review \| batch unit \| tracker mutation \| commit/);
  assert.match(reflection[1], /promotion: durable fix committed -> promote/);
  assert.match(reflection[1], /read: automatic injection with id and hits under SORTIE_PROCESS_REFLECTIONS/);

  const drain = coordinator.content.match(
    /BACKLOG_DRAIN_FIXTURE\r?\n([\s\S]+?)\r?\nEND_BACKLOG_DRAIN_FIXTURE/,
  );
  assert.ok(drain);
  for (const contract of [
    "drain_counts: batchAttempted=terminal handoffs; batchCommitted=new commits; batchReconciled=accepted existing commits",
    "inventory_acquisition: once at drain start in one client invocation; never after compaction",
    "candidate_queue: at most backlogDrain.maxUnits; exact handoff path + deterministic opaque acceptance fingerprint + required selection fields; raw body discarded",
    "continuation: terminal handoff -> session checkpoint -> local queue update -> compact resume; no tracker access",
    "tracker_flush: once when drain stops; all pending updates in one direct invocation",
    "queue_exhausted: stop without inventory refresh; next top-level request may reacquire",
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
      maxAutoContinues: 10,
      taskWatchdogMilliseconds: DEFAULT_TASK_WATCHDOG_MILLISECONDS,
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
    { continuation: { taskWatchdogMilliseconds: 9 } },
    { continuation: { taskWatchdogMilliseconds: 30 * 60 * 1000 + 1 } },
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
    await mkdir(join(directory, ".git"));
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
}

async function configuredHooks(directory: string) {
  await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
  return await SortieDogsPlugin({ directory });
}

test("reflection policy injection is disabled by default, complete when empty or seeded, and exactly once", async () => {
  await withProject("reflection-policy-injection", async (directory) => {
    const oldXdg = process.env.XDG_CONFIG_HOME;
    const oldConfig = process.env.SORTIE_DOGS_CONFIG;
    const oldReflection = process.env.SORTIE_REFLECTION;
    const xdg = await mkdtemp(join(testEnvironment, "reflection-policy-xdg-"));
    const client = { session: { get: async () => ({ data: { agent: "dog-coordinator" } }) } } as never;
    try {
      process.env.XDG_CONFIG_HOME = xdg;
      delete process.env.SORTIE_DOGS_CONFIG;
      delete process.env.SORTIE_REFLECTION;

      const disabled = await SortieDogsPlugin({ directory, client });
      await disabled["chat.message"]!(
        { sessionID: "reflection-disabled", agent: "dog-coordinator" },
        { message: { model: {} }, parts: [{ type: "text", text: "root" }] },
      );
      const disabledSystem = { system: ["base"] };
      await disabled["experimental.chat.system.transform"]!({ sessionID: "reflection-disabled" }, disabledSystem);
      assert.deepEqual(disabledSystem.system, ["base"]);

      const enabled = await SortieDogsPlugin(
        { directory, client },
        { reflection: { enabled: true, maxInjectedEntries: 2, maxInjectedTokens: 500 } },
      );
      const rootSession = "reflection-policy-root";
      await enabled["chat.message"]!(
        { sessionID: rootSession, agent: "dog-coordinator" },
        { message: { model: {} }, parts: [{ type: "text", text: "root" }] },
      );
      const empty = { system: ["base"] };
      await enabled["experimental.chat.system.transform"]!({ sessionID: rootSession }, empty);
      assert.deepEqual(empty.system, ["base", REFLECTION_POLICY]);
      await enabled["experimental.chat.system.transform"]!({ sessionID: rootSession }, empty);
      assert.equal(empty.system.filter((element) => element.includes(REFLECTION_POLICY)).length, 1);

      const execute = enabled.tool!.sortie_reflection.execute;
      const first = JSON.parse(await execute({ action: "record", layer: "run", scope: "first", trigger: "t", cause: "c", prevention: "First.", evidence: "user-correction", evidenceRef: "r" }, { sessionID: rootSession, agent: "dog-coordinator" }));
      const second = JSON.parse(await execute({ action: "record", layer: "run", scope: "second", trigger: "t", cause: "c", prevention: "Second.", evidence: "user-correction", evidenceRef: "r" }, { sessionID: rootSession, agent: "dog-coordinator" }));
      await execute({ action: "replace", layer: "run", id: first.id, scope: "first", trigger: "t2", cause: "c2", prevention: "First updated." }, { sessionID: rootSession, agent: "dog-coordinator" });
      const seeded = { system: [] as string[] };
      await enabled["experimental.chat.system.transform"]!({ sessionID: rootSession }, seeded);
      assert.deepEqual(seeded.system, [
        `${REFLECTION_POLICY}\n\nSORTIE_PROCESS_REFLECTIONS\n- [${first.id}] first (hits=2): First updated.\n- [${second.id}] second (hits=1): Second.`,
      ]);
      const seededElement = seeded.system[0]!;
      process.env.SORTIE_REFLECTION = "0";
      await enabled["experimental.chat.system.transform"]!({ sessionID: rootSession }, seeded);
      assert.deepEqual(seeded.system, []);
      delete process.env.SORTIE_REFLECTION;

      seeded.system = [seededElement];
      await enabled["experimental.chat.system.transform"]!({ sessionID: "reflection-rejected" }, seeded);
      assert.deepEqual(seeded.system, []);

      const injectBuckets = ReflectionStore.prototype.injectBuckets;
      seeded.system = [seededElement];
      try {
        ReflectionStore.prototype.injectBuckets = async () => { throw new Error("injected storage failure"); };
        await enabled["experimental.chat.system.transform"]!({ sessionID: rootSession }, seeded);
        assert.deepEqual(seeded.system, [REFLECTION_POLICY]);
        assert.equal(seeded.system[0]!.includes(first.id), false);
        assert.equal(seeded.system[0]!.includes(second.id), false);
      } finally {
        ReflectionStore.prototype.injectBuckets = injectBuckets;
      }
      await enabled["experimental.session.compacting"]!({ sessionID: rootSession }, { context: [], prompt: "" });
      await enabled["experimental.chat.system.transform"]!({ sessionID: rootSession }, seeded);
      assert.deepEqual(seeded.system, [seededElement]);
    } finally {
      if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldXdg;
      if (oldConfig === undefined) delete process.env.SORTIE_DOGS_CONFIG; else process.env.SORTIE_DOGS_CONFIG = oldConfig;
      if (oldReflection === undefined) delete process.env.SORTIE_REFLECTION; else process.env.SORTIE_REFLECTION = oldReflection;
      await rm(xdg, { recursive: true, force: true });
    }
  });
});

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
        "sortie_accept_luna_fabric_candidate",
        "sortie_accept_parallel_integration",
        "sortie_admit_luna_fabric",
        "sortie_advance_luna_fabric_wave",
        "sortie_bind_write_gate",
        "sortie_cancel_parallel_dispatch",
        "sortie_check_contract",
        "sortie_compact_and_continue",
        "sortie_create_parallel_commit_artifact",
        "sortie_enable_backlog_drain",
        "sortie_enqueue_parallel_integration",
        "sortie_integrate_parallel_queue",
        "sortie_parallel_dispatch_status",
        "sortie_parallel_integration_status",
        "sortie_prepare_luna_fabric",
        "sortie_prepare_parallel_dispatch",
        "sortie_release_write_gate",
        "sortie_submit_integration_remediation",
        "sortie_validate_luna_fabric_candidate",
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
      assert.deepEqual(empty.system, ["base", REFLECTION_POLICY]);
      assert.deepEqual(logs, [{ level: "warn", service: "sortie-dogs", message: "reflection_corrupt_json" }]);
      const execute = hooks.tool!.sortie_reflection.execute;
      const recorded = JSON.parse(await execute({ action: "record", layer: "run", scope: "integration", trigger: "trigger", cause: "cause", prevention: "Prevent this.", evidence: "user-correction", evidenceRef: "ref" }, { sessionID: rootSession, agent: "dog-coordinator" }));
      const injected = { system: [] as string[] };
      await hooks["experimental.chat.system.transform"]!({ sessionID: rootSession }, injected);
      assert.equal(injected.system[0], `${REFLECTION_POLICY}\n\nSORTIE_PROCESS_REFLECTIONS\n- [${recorded.id}] integration (hits=1): Prevent this.`);
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
      assert.equal(afterCompaction.system[0], `${REFLECTION_POLICY}\n\nSORTIE_PROCESS_REFLECTIONS\n- [${recorded.id}] integration (hits=2): Use the improved prevention.`);
      assert.equal(await execute({ action: "promote", layer: "run", id: recorded.id, promotedRef: "fix", }, { sessionID: rootSession, agent: "dog-coordinator" }), "promoted");
      assert.equal(await execute({ action: "clear", layer: "run" }, { sessionID: rootSession, agent: "dog-coordinator" }), "cleared");
      await execute({ action: "record", layer: "run", scope: "survive", trigger: "trigger", cause: "cause", prevention: "Keep this.", evidence: "user-correction", evidenceRef: "ref" }, { sessionID: rootSession, agent: "dog-coordinator" });
      const projectEntry = JSON.parse(await execute({ action: "record", layer: "project", scope: "project", trigger: "trigger", cause: "cause", prevention: "Keep project.", evidence: "user-correction", evidenceRef: "ref" }, { sessionID: rootSession, agent: "dog-coordinator" }));
      assert.equal(await execute({ action: "clear", layer: "project", confirmation: "wrong" }, { sessionID: rootSession, agent: "dog-coordinator" }), "reflection_confirmation_required");
      assert.equal(JSON.parse(await execute({ action: "list", layer: "project" }, { sessionID: rootSession, agent: "dog-coordinator" })).entries[0].id, projectEntry.id);
      const layered = { system: [] as string[] };
      await hooks["experimental.chat.system.transform"]!({ sessionID: rootSession }, layered);
      assert.equal(layered.system[0]?.slice(REFLECTION_POLICY.length).trim().split("\n").length, 3);
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
      const entryBudgetSuppressesEntries = { system: [] as string[] };
      await tinyHooks["experimental.chat.system.transform"]!({ sessionID: tinyRoot }, entryBudgetSuppressesEntries);
      assert.deepEqual(entryBudgetSuppressesEntries.system, [REFLECTION_POLICY], "maxInjectedTokens=1 suppresses entries while preserving the enabled reflection policy");
      process.env.SORTIE_REFLECTION = "0";
      const killed = await SortieDogsPlugin({ directory }, { reflection: { enabled: true } });
      assert.equal(killed.tool?.sortie_reflection, undefined);
      assert.ok(killed["experimental.chat.system.transform"]);
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
        const invokeChat = async () => await hooks["chat.message"]!(
          { sessionID, agent: "dog-coordinator" },
          { message: { model: {} }, parts: [{ type: "text", text: "root" }] },
        );
        if (sessionID === "child") {
          await assert.rejects(invokeChat, /SORTIE_FRESH_SESSION_REQUIRED/u);
        }
        else await invokeChat();
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
      assert.ok(hooks["experimental.chat.system.transform"]);
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

function acceptanceContinuity(taskID: string, criteria: string[], parent = "none"): Record<string, unknown> {
  return {
    schema_version: "0.1",
    authority: "dispatch",
    task_id: taskID,
    criteria,
    fingerprint: acceptanceContinuityFingerprint(criteria),
    parent_fingerprint: parent,
  };
}

function readOnlyWorkerPrompt(directory: string): string {
  return [
    "role: implementation",
    `project_root: ${directory}`,
    "source_manifest: [AGENTS.md]",
    "operation_manifest: none",
    "acceptance: read only",
    "validation: read only",
  ].join("\n");
}

async function beginTrackedTaskChild(
  hooks: Awaited<ReturnType<typeof SortieDogsPlugin>>,
  directory: string,
  parentID: string,
  childID: string,
  callID: string,
  taskID?: string,
): Promise<void> {
  const chat = hooks["chat.message"]!;
  const before = hooks["tool.execute.before"]!;
  const task = [
    "context_digest:",
    ...(taskID === undefined ? [] : [`  task_id: ${taskID}`]),
    `  project_root: ${directory}`,
    `  handoff_path: ${join(directory, "handoff.json")}`,
    "  acceptance: safe change",
    "  role: implementation",
    "  source_manifest: [allowed.txt]",
    "operation_manifest: operation-manifest.json",
    "validation: npm test",
  ].join("\n");
  await chat(
    { sessionID: parentID, agent: "dog-coordinator" },
    {
      message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } },
      parts: [{ type: "text", text: "tracked task" }],
    },
  );
  await before(
    { tool: "task", sessionID: parentID, callID },
    { args: { subagent_type: "dog-worker", prompt: task } },
  );
  await hooks.event!({
    event: { type: "session.created", properties: { info: { id: childID, parentID, directory } } },
  });
  await chat(
    { sessionID: childID, agent: "dog-worker", parentID } as never,
    {
      message: { agent: "dog-worker", model: { providerID: "host", modelID: "selected" } },
      parts: [{ type: "text", text: task }],
    },
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

async function executeReleaseWriteGate(
  hooks: Awaited<ReturnType<typeof SortieDogsPlugin>>,
  sessionID: string,
): Promise<Record<string, unknown>> {
  const release = hooks.tool?.sortie_release_write_gate as unknown as {
    execute(args: Record<string, never>, context: { sessionID: string }): Promise<string>;
  } | undefined;
  assert.ok(release);
  return JSON.parse(await release.execute({}, { sessionID })) as Record<string, unknown>;
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
      await chat({ sessionID: `routing-${role}`, agent: role }, consultation);
      assert.deepEqual(consultation.message.model, {
        providerID: "openai",
        modelID: "gpt-5.6-sol",
        variant: "xhigh",
      }, `${role} never keeps the caller model`);
    }
    await assert.rejects(
      () => chat({ sessionID: "routing-reviewer", agent: "reviewer" }, output),
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
      "dog-worker": { providerID: "openai", modelID: "gpt-5.6-sol", variant: DEDICATED_WORKER_VARIANT },
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

test("an explicit root coordinator model wins over a declared coordinator route", async () => {
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
      message: {
        agent: "dog-coordinator",
        model: { providerID: "openai", modelID: "gpt-5.6-sol", variant: "medium" },
      },
      parts: [{ type: "text", text: "continue the batch" }],
    };
    await chat({
      sessionID: "declared-coordinator",
      agent: "dog-coordinator",
      model: { providerID: "openai", modelID: "gpt-5.6-sol" },
    }, declared);
    assert.deepEqual(declared.message.model, {
      providerID: "openai",
      modelID: "gpt-5.6-sol",
      variant: "medium",
    });

    const synthetic = {
      message: { agent: "dog-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
      parts: [{ type: "text", text: "continue", synthetic: true }],
    };
    await chat({ sessionID: "declared-coordinator", agent: "dog-coordinator" }, synthetic);
    assert.deepEqual(synthetic.message.model, {
      providerID: "openai",
      modelID: "gpt-5.6-sol",
      variant: "medium",
    });

    const defaulted = {
      message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "default" } },
      parts: [{ type: "text", text: "start with the configured route" }],
    };
    await chat({ sessionID: "defaulted-coordinator", agent: "dog-coordinator" }, defaulted);
    assert.deepEqual(defaulted.message.model, {
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

test("coordinator task hooks permit autonomous sequential workers across synthetic turns", async () => {
  await withProject("sequential-worker-fast-lane", async (directory) => {
    const hooks = await SortieDogsPlugin({ directory });
    const chat = hooks["chat.message"]!;
    const before = hooks["tool.execute.before"]!;
    const after = hooks["tool.execute.after"]!;
    const turn = (synthetic = false) => chat(
      { sessionID: "root", agent: "dog-coordinator" },
      {
        message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } },
        parts: [{ type: "text", text: "task", ...(synthetic ? { synthetic: true } : {}) }],
      },
    );
    const dispatch = (callID: string) => before(
      { tool: "task", sessionID: "root", callID },
      { args: { subagent_type: "dog-worker", prompt: readOnlyWorkerPrompt(directory) } },
    );
    const complete = (callID: string) => after(
      { tool: "task", sessionID: "root", callID },
      { output: "<task_result>done</task_result>", metadata: {} },
    );

    await turn();
    await dispatch("worker-1");
    await assert.rejects(() => dispatch("worker-overlap"), /SORTIE_FAST_LANE_DENIED: WORKER_LIMIT/u);
    await complete("worker-1");
    await dispatch("worker-2");
    await complete("worker-2");
    await turn(true);
    await dispatch("worker-3");
    await complete("worker-3");
    await turn();
    await dispatch("worker-4");
    await complete("worker-4");
  });
});

test("coordinator-only Luna admission returns bounded route evidence without dispatch authority", async () => {
  await withProject("luna-fabric-admission", async (directory) => {
    await mkdir(join(directory, ".opencode"));
    const contractPath = join(directory, ".opencode", "sortie-dogs-luna-fabric.json");
    const unit = (id: string, order: number) => ({
      unit_id: id,
      acceptance_items: [`accept-${id}`],
      scope_read: ["src/shared.ts"],
      scope_write: [`src/${id}.ts`],
      depends_on: [],
      validation: { level: "targeted", command: ["node", "--test", `test/${id}.test.ts`] },
      shared_path_keys: [],
      exclusive_resources: [],
      scheduler_order: order,
    });
    await writeFile(contractPath, JSON.stringify({
      version: "0.8.0",
      provenance: {
        source: "dog-coordinator",
        acceptance_fingerprint: "a".repeat(64),
        target_branch: "main",
        target_sha: "b".repeat(40),
      },
      acceptance_items: ["accept-unit-a", "accept-unit-b"],
      effects: [],
      shared_paths: [],
      units: [unit("unit-a", 0), unit("unit-b", 1)],
    }));
    const hooks = await SortieDogsPlugin({ directory });
    await hooks["chat.message"]!(
      { sessionID: "root", agent: "dog-coordinator" },
      { message: { agent: "dog-coordinator", model: {} }, parts: [{ type: "text", text: "route" }] },
    );
    const misplaced = JSON.parse(await hooks.tool!.sortie_admit_luna_fabric!.execute(
      { contract_path: join(directory, "luna-fabric.json") },
      { sessionID: "root", agent: "dog-coordinator" },
    ));
    assert.deepEqual(misplaced, {
      status: "denied",
      reason: "contract-control-path-required",
      required_contract_path: ".opencode/sortie-dogs-luna-fabric.json",
    });
    const admitted = JSON.parse(await hooks.tool!.sortie_admit_luna_fabric!.execute(
      { contract_path: contractPath },
      { sessionID: "root", agent: "dog-coordinator" },
    ));
    assert.deepEqual(Object.keys(admitted).sort(), [
      "contract_fingerprint", "depth", "route", "status", "unit_count", "width",
    ]);
    assert.equal(admitted.status, "admitted");
    assert.equal(admitted.route, "luna-fabric");
    assert.equal(admitted.width, 2);
    assert.equal(admitted.unit_count, 2);

    await writeFile(contractPath, JSON.stringify({ bad: true }));
    const serial = JSON.parse(await hooks.tool!.sortie_admit_luna_fabric!.execute(
      { contract_path: contractPath },
      { sessionID: "root", agent: "dog-coordinator" },
    ));
    assert.equal(serial.status, "serial-route");
    assert.equal(serial.reason, "malformed-contract");

    const child = JSON.parse(await hooks.tool!.sortie_admit_luna_fabric!.execute(
      { contract_path: contractPath },
      { sessionID: "child", agent: "dog-worker" },
    ));
    assert.equal(child.status, "denied");
  });
});

test("fabric prepare returns a luna-fabric run whose descriptors bind only dog-luna-worker", async () => {
  await withProject("luna-fabric-prepare", async (directory) => {
    await writeFile(join(directory, ".gitignore"), ".opencode/sortie-dogs-luna-fabric.json\n");
    await writeFile(join(directory, "base.txt"), "base\n");
    await mkdir(join(directory, ".opencode"));
    await writeFile(join(directory, ".opencode", "sortie-dogs.version"), `${RUNTIME_ASSET_VERSION}\n`);
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify({
      ...fixture.manifest,
      validation: ["npm test"],
    }));
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: directory });
    await execFileAsync("git", ["config", "user.name", "Sortie Test"], { cwd: directory });
    await execFileAsync("git", ["config", "user.email", "sortie@example.invalid"], { cwd: directory });
    await execFileAsync("git", ["add", ".gitignore", "base.txt", ".opencode/sortie-dogs.version",
      "operation-manifest.json"], { cwd: directory });
    await execFileAsync("git", ["commit", "-q", "-m", "base"], { cwd: directory });
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: directory });
    const sha = stdout.trim();
    const contractPath = join(directory, ".opencode", "sortie-dogs-luna-fabric.json");
    await writeFile(contractPath, JSON.stringify({
      version: "0.8.0",
      provenance: {
        source: "dog-coordinator",
        acceptance_fingerprint: "c".repeat(64),
        target_branch: "main",
        target_sha: sha,
      },
      acceptance_items: ["own-a", "own-b"],
      effects: [],
      shared_paths: [],
      units: ["a", "b"].map((id, order) => ({
        unit_id: id,
        acceptance_items: [`own-${id}`],
        scope_read: ["base.txt"],
        scope_write: [`${id}.txt`],
        depends_on: [],
        validation: { level: "targeted", command: ["node", "--test", `test/${id}.test.ts`] },
        shared_path_keys: [],
        exclusive_resources: [],
        scheduler_order: order,
      })),
    }));

    const hooks = await SortieDogsPlugin({ directory });
    await hooks["chat.message"]!(
      { sessionID: "root", agent: "dog-coordinator" },
      {
        message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } },
        parts: [{ type: "text", text: "fabric" }],
      },
    );
    const prepared = JSON.parse(await hooks.tool!.sortie_prepare_luna_fabric!.execute(
      { contract_path: contractPath },
      { sessionID: "root", agent: "dog-coordinator" },
    )) as { status: string; run_id: string; route: string; width: number; depth: number; fabric_fingerprint: string;
      ready: Array<Record<string, unknown>> };
    assert.equal(prepared.status, "prepared", JSON.stringify(prepared));
    assert.equal(prepared.route, "luna-fabric");
    assert.equal(prepared.width, 2);
    assert.equal(prepared.depth, 1);
    assert.match(prepared.fabric_fingerprint, /^[0-9a-f]{64}$/u);
    assert.equal(prepared.ready.length, 2);
    assert.deepEqual(prepared.ready.map((descriptor) => descriptor.acceptance), [
      ["own-a", "Complete the prepared parallel descriptor within its declared scope."],
      ["own-b", "Complete the prepared parallel descriptor within its declared scope."],
    ]);
    const earlyAdvance = JSON.parse(await hooks.tool!.sortie_advance_luna_fabric_wave!.execute(
      { run_id: prepared.run_id },
      { sessionID: "root", agent: "dog-coordinator" },
    ));
    assert.deepEqual(earlyAdvance, { status: "denied", reason: "wave-not-ready" });

    const prompt = (descriptor: Record<string, unknown>) => [
      "context_digest:",
      `  task_id: ${descriptor.task_id}`,
      `  run_id: ${descriptor.run_id}`,
      `  dispatch_id: ${descriptor.dispatch_id}`,
      "  role: implementation",
      `  project_root: ${descriptor.managed_path}`,
      `  branch: ${descriptor.branch}`,
      `  base_sha: ${descriptor.base_sha}`,
      `  depends_on: ${JSON.stringify(descriptor.depends_on)}`,
      `  scope_read: ${JSON.stringify(descriptor.scope_read)}`,
      `  scope_write: ${JSON.stringify(descriptor.scope_write)}`,
      `  handoff_path: ${descriptor.handoff_path}`,
      "  acceptance:",
      ...(descriptor.acceptance as string[]).map((criterion) => `    - ${criterion}`),
      "  validation: no canonical validation",
      `  parallel_group: ${descriptor.parallel_group}`,
      `  parallel_unit: ${descriptor.parallel_unit}`,
      `  parallel_units: ${descriptor.parallel_units}`,
      `  attempt: ${descriptor.attempt}`,
      `  contract_fingerprint: ${descriptor.contract_fingerprint}`,
      "  source_manifest: [base.txt]",
      `operation_manifest: ${descriptor.operation_manifest}`,
    ].join("\n");
    const before = hooks["tool.execute.before"]!;
    await assert.rejects(
      () => before(
        { tool: "task", sessionID: "root", callID: "serial-role" },
        { args: { subagent_type: "dog-worker", prompt: prompt(prepared.ready[0]!) } },
      ),
      /parallel_route_role_mismatch/u,
    );
    await assert.rejects(
      () => before(
        { tool: "task", sessionID: "root", callID: "luna-without-descriptor" },
        { args: { subagent_type: "dog-luna-worker", prompt: readOnlyWorkerPrompt(directory) } },
      ),
      /luna_worker_requires_admitted_descriptor/u,
    );
    const descriptorOnlyPrompt = prompt(prepared.ready[0]!).replace("  role: implementation\n", "");
    await before(
      { tool: "task", sessionID: "root", callID: "luna-a" },
      { args: { subagent_type: "dog-luna-worker", prompt: descriptorOnlyPrompt } },
    );
    await before(
      { tool: "task", sessionID: "root", callID: "luna-b" },
      { args: { subagent_type: "dog-luna-worker", prompt: prompt(prepared.ready[1]!) } },
    );
    await hooks.event!({ event: { type: "session.created",
      properties: { info: { id: "luna-child-a", parentID: "root" } } } });
    await hooks["chat.message"]!(
      { sessionID: "luna-child-a", agent: "dog-luna-worker", parentID: "root" } as never,
      { message: { agent: "dog-luna-worker", model: {} }, parts: [{ type: "text", text: descriptorOnlyPrompt }] },
    );
    await inspectHandoffWithRead(hooks, prepared.ready[0]!.handoff_path as string, "luna-child-a");
    assert.equal((await executeBindWriteGate(
      hooks,
      prepared.ready[0]!.managed_path as string,
      "luna-child-a",
      prepared.ready[0]!.operation_manifest as string,
    )).status, "bound");
    const mismatchedChild = "luna-child-mismatch";
    const mismatchedPrompt = descriptorOnlyPrompt.replace(
      `  project_root: ${prepared.ready[0]!.managed_path}`,
      `  project_root: ${directory}`,
    );
    await hooks.event!({ event: { type: "session.created",
      properties: { info: { id: mismatchedChild, parentID: "root" } } } });
    await hooks["chat.message"]!(
      { sessionID: mismatchedChild, agent: "dog-luna-worker", parentID: "root" } as never,
      { message: { agent: "dog-luna-worker", model: {} }, parts: [{ type: "text", text: mismatchedPrompt }] },
    );
    assert.deepEqual(await executeBindWriteGate(
      hooks,
      prepared.ready[0]!.managed_path as string,
      mismatchedChild,
      prepared.ready[0]!.operation_manifest as string,
    ), {
      status: "denied",
      reason: "parallel-contract-invalid",
      recoverable: false,
      remedy: "Redispatch a fresh worker with parallel_group, parallel_unit, and parallel_units=2..5 all present, or omit all three fields for serial work.",
      escalation: { action: "follow-remedy", resume_session: false, true_blocker: false },
    });
    const status = JSON.parse(await hooks.tool!.sortie_parallel_dispatch_status!.execute(
      { run_id: prepared.ready[0]!.run_id as string, reconcile: "false" },
      { sessionID: "root", agent: "dog-coordinator" },
    )) as { route: string; tasks: Array<{ phase: string }> };
    assert.equal(status.route, "luna-fabric");
    assert.deepEqual(status.tasks.map(({ phase }) => phase), ["running", "running"]);
  });
});

test("typed parallel prepare is the only path to reserved dependency-aware worker dispatch", async () => {
  await withProject("typed-parallel-dispatch", async (directory) => {
    await writeFile(join(directory, ".gitignore"), "parallel-contract.json\n");
    await writeFile(join(directory, "base.txt"), "base\n");
    await mkdir(join(directory, ".opencode"));
    await writeFile(join(directory, ".opencode", "sortie-dogs.version"), `${RUNTIME_ASSET_VERSION}\n`);
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify({
      ...fixture.manifest,
      validation: ["npm test"],
    }));
    const parentCriteria = ["Preserve the sequential parent criterion."];
    const parentFingerprint = acceptanceContinuityFingerprint(parentCriteria);
    const parentHandoff = writeGateHandoff(directory, "operation-manifest.json") as { ext: Record<string, unknown> };
    await writeFile(join(directory, "handoff.sequential-parent.json"), JSON.stringify({
      ...parentHandoff,
      id: "sequential-parent",
      ext: {
        ...parentHandoff.ext,
        [ACCEPTANCE_CONTINUITY_EXTENSION]: acceptanceContinuity("sequential-parent", parentCriteria),
      },
    }));
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: directory });
    await execFileAsync("git", ["config", "user.name", "Sortie Test"], { cwd: directory });
    await execFileAsync("git", ["config", "user.email", "sortie@example.invalid"], { cwd: directory });
    await execFileAsync("git", ["add", ".gitignore", "base.txt", ".opencode/sortie-dogs.version",
      "operation-manifest.json", "handoff.sequential-parent.json"], { cwd: directory });
    await execFileAsync("git", ["commit", "-q", "-m", "base"], { cwd: directory });
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: directory });
    const sha = stdout.trim();
    const contractPath = join(directory, "parallel-contract.json");
    await writeFile(contractPath, JSON.stringify({
      version: "0.1.0",
      mode: "parallel",
      max_workers: 2,
      tasks: ["a", "b"].map((taskID) => ({
        task_id: taskID,
        worktree: `plugin-${taskID}`,
        branch: `sortie/plugin-${taskID}`,
        base_sha: sha,
        depends_on: [],
        scope: { read: ["base.txt"], write: [`${taskID}.txt`] },
      })),
      artifacts: [],
      failure: null,
      baseline_metrics: null,
    }));

    const hooks = await SortieDogsPlugin({ directory });
    await hooks["chat.message"]!(
      { sessionID: "literal-root", agent: "dog-coordinator" },
      {
        message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } },
        parts: [{ type: "text", text: "literal fields are not opt-in" }],
      },
    );
    await hooks["chat.message"]!(
      { sessionID: "root", agent: "dog-coordinator" },
      {
        message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } },
        parts: [{ type: "text", text: "parallel" }],
      },
    );
    const before = hooks["tool.execute.before"]!;
    await before(
      { tool: "task", sessionID: "root", callID: "sequential-parent" },
      { args: { subagent_type: "dog-worker", prompt: [
        "task_id: sequential-parent",
        "role: implementation",
        `project_root: ${directory}`,
        `handoff_path: ${join(directory, "handoff.sequential-parent.json")}`,
        "source_manifest: [base.txt]",
        "operation_manifest: operation-manifest.json",
        "acceptance:",
        ...parentCriteria.map((criterion) => `  - ${criterion}`),
        "validation: npm test",
      ].join("\n") } },
    );
    await hooks["tool.execute.after"]!(
      { tool: "task", sessionID: "root", callID: "sequential-parent" },
      { output: "<task_result>done</task_result>", metadata: {} },
    );
    await hooks["chat.message"]!(
      { sessionID: "root", agent: "dog-coordinator" },
      {
        message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } },
        parts: [{ type: "text", text: "parallel turn" }],
      },
    );
    await before(
      { tool: "task", sessionID: "literal-root", callID: "literal-one" },
      { args: { subagent_type: "dog-worker", prompt: readOnlyWorkerPrompt(directory) +
        "\nparallel_group: literal\nparallel_unit: a\nparallel_units: 2" } },
    );
    await assert.rejects(
      () => before(
        { tool: "task", sessionID: "literal-root", callID: "literal-two" },
        { args: { subagent_type: "dog-worker", prompt: readOnlyWorkerPrompt(directory) +
          "\nparallel_group: literal\nparallel_unit: b\nparallel_units: 2" } },
      ),
      /SORTIE_FAST_LANE_DENIED: WORKER_LIMIT/u,
    );

    const prepared = JSON.parse(await hooks.tool!.sortie_prepare_parallel_dispatch!.execute(
      { contract_path: contractPath },
      { sessionID: "root", agent: "dog-coordinator" },
    )) as { status: string; run_id: string; ready: Array<Record<string, unknown>> };
    assert.equal(prepared.status, "prepared", JSON.stringify(prepared));
    assert.equal(prepared.ready.length, 2);
    const generatedCriteria = [...parentCriteria, "Complete the prepared parallel descriptor within its declared scope."];
    for (const descriptor of prepared.ready) {
      assert.deepEqual(descriptor.acceptance, generatedCriteria);
      assert.equal(descriptor.acceptance_parent_fingerprint, parentFingerprint);
      const generatedHandoff = JSON.parse(await readFile(descriptor.handoff_path as string, "utf8")) as {
        ext: Record<string, { criteria?: string[]; parent_fingerprint?: string }>;
      };
      assert.deepEqual(generatedHandoff.ext[ACCEPTANCE_CONTINUITY_EXTENSION]?.criteria, generatedCriteria);
      assert.equal(generatedHandoff.ext[ACCEPTANCE_CONTINUITY_EXTENSION]?.parent_fingerprint, parentFingerprint);
    }
    assert.equal(prepared.ready[0]!.acceptance_fingerprint, prepared.ready[1]!.acceptance_fingerprint,
      "ready siblings share one parent acceptance rather than chaining through each other");
    const prompt = (descriptor: Record<string, unknown>) => [
      "context_digest:",
      `  task_id: ${descriptor.task_id}`,
      `  run_id: ${descriptor.run_id}`,
      `  dispatch_id: ${descriptor.dispatch_id}`,
      "  role: implementation",
      `  project_root: ${descriptor.managed_path}`,
      `  branch: ${descriptor.branch}`,
      `  base_sha: ${descriptor.base_sha}`,
      `  depends_on: ${JSON.stringify(descriptor.depends_on)}`,
      `  scope_read: ${JSON.stringify(descriptor.scope_read)}`,
      `  scope_write: ${JSON.stringify(descriptor.scope_write)}`,
      `  handoff_path: ${descriptor.handoff_path}`,
      "  acceptance:",
      ...(descriptor.acceptance as string[]).map((criterion) => `    - ${criterion}`),
      "  validation: no canonical validation",
      `  parallel_group: ${descriptor.parallel_group}`,
      `  parallel_unit: ${descriptor.parallel_unit}`,
      `  parallel_units: ${descriptor.parallel_units}`,
      `  attempt: ${descriptor.attempt}`,
      `  contract_fingerprint: ${descriptor.contract_fingerprint}`,
      "  source_manifest: [base.txt]",
      `operation_manifest: ${descriptor.operation_manifest}`,
    ].join("\n");
    const client = { session: {
      get: async () => ({ data: { agent: "dog-coordinator" } }),
      messages: async () => ({ data: [{ info: { role: "user", agent: "dog-coordinator" }, parts: [{ type: "text", text: "resume" }] }] }),
    } } as never;
    const restarted = await SortieDogsPlugin({ directory, client });
    const system = { system: [] as string[] };
    await restarted["experimental.chat.system.transform"]!({ sessionID: "root" }, system);
    assert.match(system.system.join("\n"), /SORTIE_PARALLEL_DISPATCH_STATE/u);
    const restartedBefore = restarted["tool.execute.before"]!;
    const originalBindDispatch = ParallelDispatchCoordinator.prototype.bindDispatch;
    let releaseFirstBind: (() => void) | undefined;
    let bound = 0;
    ParallelDispatchCoordinator.prototype.bindDispatch = async function (
      ...args: Parameters<ParallelDispatchCoordinator["bindDispatch"]>
    ) {
      const result = await originalBindDispatch.apply(this, args);
      bound += 1;
      if (bound === 1) await new Promise<void>((resolve) => { releaseFirstBind = resolve; });
      else releaseFirstBind?.();
      return result;
    };
    try {
      await Promise.all(prepared.ready.map(async (descriptor, index) => {
        await restartedBefore(
          { tool: "task", sessionID: "root", callID: `parallel-${index}` },
          { args: { subagent_type: "dog-worker", prompt: prompt(descriptor) } },
        );
      }));
    } finally {
      ParallelDispatchCoordinator.prototype.bindDispatch = originalBindDispatch;
    }
    for (const [index, descriptor] of prepared.ready.entries()) {
      await restartedBefore(
        { tool: "task", sessionID: "root", callID: `parallel-${index}` },
        { args: { subagent_type: "dog-worker", prompt: prompt(descriptor) } },
      );
    }
    await assert.rejects(
      () => restartedBefore(
        { tool: "task", sessionID: "root", callID: "parallel-replay" },
        { args: { subagent_type: "dog-worker", prompt: prompt(prepared.ready[0]!) } },
      ),
      (error: unknown) => error instanceof ParallelDispatchError && error.code === "descriptor-replay",
    );
    for (const [index, descriptor] of prepared.ready.entries()) {
      await restarted["tool.execute.after"]!(
        { tool: "task", sessionID: "root", callID: `parallel-${index}` },
        { output: `<task_result>\nSORTIE_PARALLEL_OUTCOME ${JSON.stringify({
          run_id: descriptor.run_id,
          dispatch_id: descriptor.dispatch_id,
          status: "failed",
        })}\n</task_result>`, metadata: { sessionId: `child-${index}` } },
      );
    }
    const status = JSON.parse(await restarted.tool!.sortie_parallel_dispatch_status!.execute(
      { run_id: prepared.run_id, reconcile: "false" },
      { sessionID: "root", agent: "dog-coordinator" },
    )) as { tasks: Array<{ phase: string }> };
    assert.deepEqual(status.tasks.map(({ phase }) => phase), ["failed", "failed"]);

    assert.doesNotMatch(system.system.join("\n"), /SORTIE_PARALLEL_OUTCOME/u);
  });
});

test("parallel worker artifact capability enforces exact lineage, terminal release, and bounded archive evidence", async () => {
  await withProject("parallel-artifact-capability", async (directory) => {
    await writeFile(join(directory, ".gitignore"), "parallel-contract.json\n*.operation-manifest.json\nhandoff*.json\n");
    await writeFile(join(directory, "base.txt"), "base\n");
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: directory });
    await execFileAsync("git", ["config", "user.name", "Sortie Test"], { cwd: directory });
    await execFileAsync("git", ["config", "user.email", "sortie@example.invalid"], { cwd: directory });
    await execFileAsync("git", ["add", ".gitignore", "base.txt"], { cwd: directory });
    await execFileAsync("git", ["commit", "-q", "-m", "base"], { cwd: directory });
    const sha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: directory })).stdout.trim();
    const contractPath = join(directory, "parallel-contract.json");
    await writeFile(contractPath, JSON.stringify({
      version: "0.1.0", mode: "parallel", max_workers: 2,
      tasks: ["a", "b"].map((taskID) => ({ task_id: taskID, worktree: `artifact-${taskID}`,
        branch: `sortie/artifact-${taskID}`, base_sha: sha, depends_on: taskID === "b" ? ["a"] : [],
        scope: { read: ["base.txt"], write: [`${taskID}.txt`] } })),
      artifacts: [], failure: null, baseline_metrics: null,
    }));
    const hooks = await SortieDogsPlugin({ directory });
    await hooks["chat.message"]!(
      { sessionID: "root", agent: "dog-coordinator" },
      { message: { agent: "dog-coordinator", model: {} }, parts: [{ type: "text", text: "parallel" }] },
    );
    const prepared = JSON.parse(await hooks.tool!.sortie_prepare_parallel_dispatch!.execute(
      { contract_path: contractPath }, { sessionID: "root", agent: "dog-coordinator" },
    )) as { run_id: string; ready: Array<Record<string, unknown>> };
    assert.equal(prepared.ready.length, 1);
    const descriptor = prepared.ready[0]!;
    const child = "artifact-child";
    const callID = "artifact-call";
    const managedPath = descriptor.managed_path as string;
    const manifestPath = descriptor.operation_manifest as string;
    const handoffPath = descriptor.handoff_path as string;
    assert.equal(
      relative(managedPath, manifestPath).replaceAll("\\", "/"),
      `.sortie-dogs/contracts/${descriptor.task_id}.operation-manifest.json`,
    );
    assert.equal(
      relative(managedPath, handoffPath).replaceAll("\\", "/"),
      `.sortie-dogs/contracts/handoff.${descriptor.task_id}.json`,
    );
    assert.equal((JSON.parse(await readFile(manifestPath, "utf8")) as { task_id: string }).task_id, descriptor.task_id);
    assert.equal((JSON.parse(await readFile(handoffPath, "utf8")) as { id: string }).id, descriptor.task_id);
    const prompt = [
      `task_id: ${descriptor.task_id}`, "role: implementation", `project_root: ${managedPath}`,
      `handoff_path: ${handoffPath}`, `source_manifest: [${descriptor.task_id}.txt]`,
      `operation_manifest: ${manifestPath}`, "acceptance: create bounded artifact", "validation: typed capability",
      ...Object.entries(descriptor).filter(([key]) => ![
        "task_id", "managed_path", "handoff_path", "operation_manifest",
        "acceptance", "acceptance_fingerprint", "acceptance_parent_fingerprint",
      ].includes(key))
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? JSON.stringify(value) : value}`),
      `managed_path: ${managedPath}`,
    ].join("\n");
    await hooks["tool.execute.before"]!(
      { tool: "task", sessionID: "root", callID },
      { args: { subagent_type: "dog-worker", prompt } },
    );
    await hooks.event!({ event: { type: "session.created", properties: { info: { id: child, parentID: "root" } } } });
    await hooks["chat.message"]!(
      { sessionID: child, agent: "dog-worker", parentID: "root" } as never,
      { message: { agent: "dog-worker", model: {} }, parts: [{ type: "text", text: prompt }] },
    );
    await inspectHandoffWithRead(hooks, handoffPath, child);
    assert.equal((await executeBindWriteGate(hooks, managedPath, child, manifestPath)).status, "bound");
    await expectMessage(
      () => hooks["tool.execute.before"]!(
        { tool: "apply_patch", sessionID: child, callID: "relative-parallel-write" },
        { args: { patchText: `*** Begin Patch\n*** Add File: ${descriptor.task_id}.txt\n+leak\n*** End Patch` } },
      ),
      `Write denied for "${descriptor.task_id}.txt": parallel implementation write paths must be absolute and rooted in managed_path.`,
      "parallel-relative-path",
    );
    await writeFile(join(managedPath, `${descriptor.task_id}.txt`), "artifact\n");
    await execFileAsync("git", ["add", "--", `${descriptor.task_id}.txt`], { cwd: managedPath });
    const capability = hooks.tool!.sortie_create_parallel_commit_artifact!;
    const args = {
      run_id: descriptor.run_id as string,
      dispatch_id: descriptor.dispatch_id as string,
      validation_executable: "git",
      validation_args_json: JSON.stringify(["diff", "--check"]),
    };
    const malformed = JSON.parse(await capability.execute(
      { ...args, validation_args_json: "{}" }, { sessionID: child, agent: "dog-worker" },
    ));
    assert.equal(malformed.reason, "invalid-request");
    const deniedRoot = JSON.parse(await capability.execute(args, { sessionID: "root", agent: "dog-coordinator" }));
    assert.equal(deniedRoot.reason, "worker-required");
    await hooks["tool.execute.before"]!(
      { tool: "sortie_create_parallel_commit_artifact", sessionID: child, callID: "artifact-tool" }, { args },
    );
    const originalAcceptArtifact = ParallelDispatchCoordinator.prototype.acceptArtifact;
    let crashBeforeAcceptance = true;
    ParallelDispatchCoordinator.prototype.acceptArtifact = async function (
      ...acceptArgs: Parameters<ParallelDispatchCoordinator["acceptArtifact"]>
    ) {
      if (crashBeforeAcceptance) {
        crashBeforeAcceptance = false;
        throw new Error("simulated postcommit crash");
      }
      return await originalAcceptArtifact.apply(this, acceptArgs);
    };
    const crashed = JSON.parse(await capability.execute(args, { sessionID: child, agent: "dog-worker" }));
    assert.equal(crashed.reason, "artifact-production-failed");
    const postcommitHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: managedPath })).stdout.trim();
    const wrongRecovery = JSON.parse(await capability.execute(
      { ...args, validation_args_json: JSON.stringify(["-e", "process.exit(1)"]) },
      { sessionID: child, agent: "dog-worker" },
    ));
    assert.equal(wrongRecovery.reason, "artifact-verification-failed");
    let created: Record<string, unknown>;
    try {
      created = JSON.parse(await capability.execute(args, { sessionID: child, agent: "dog-worker" }));
    } finally {
      ParallelDispatchCoordinator.prototype.acceptArtifact = originalAcceptArtifact;
    }
    assert.equal(created.status, "created", JSON.stringify(created));
    assert.equal(created.replay, true);
    assert.equal((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: managedPath })).stdout.trim(), postcommitHead);
    assert.equal(JSON.stringify(created).match(/stdout|stderr|log/gu), null);
    const durable = JSON.parse(await hooks.tool!.sortie_parallel_dispatch_status!.execute(
      { run_id: prepared.run_id }, { sessionID: "root", agent: "dog-coordinator" },
    )) as { tasks: Array<{ phase: string; artifact: unknown }> };
    assert.equal(durable.tasks[0]!.phase, "running");
    assert.ok(durable.tasks[0]!.artifact);
    assert.deepEqual(await executeReleaseWriteGate(hooks, child), { status: "denied", reason: "tools-in-flight" });
    await hooks["tool.execute.after"]!(
      { tool: "sortie_create_parallel_commit_artifact", sessionID: child, callID: "artifact-tool", args },
      { output: JSON.stringify(created) },
    );
    const replay = JSON.parse(await capability.execute(args, { sessionID: child }));
    assert.equal(replay.replay, true);
    assert.equal(JSON.parse(await capability.execute(
      { ...args, validation_args_json: JSON.stringify(["-e", "process.exit(1)"]) },
      { sessionID: child, agent: "dog-worker" },
    )).reason, "artifact-replay");
    assert.equal(JSON.parse(await capability.execute(
      { ...args, timeout_ms: "1" }, { sessionID: child, agent: "dog-worker" },
    )).reason, "artifact-replay");
    assert.deepEqual(await executeReleaseWriteGate(hooks, child), { status: "released" });
    await hooks["tool.execute.after"]!(
      { tool: "task", sessionID: "root", callID },
      { output: "SORTIE_PARALLEL_OUTCOME: completed", metadata: { sessionId: child } },
    );
    const status = JSON.parse(await hooks.tool!.sortie_parallel_dispatch_status!.execute(
      { run_id: prepared.run_id }, { sessionID: "root", agent: "dog-coordinator" },
    )) as { ready: Array<Record<string, unknown>>; tasks: Array<{ phase: string; artifact: unknown }> };
    assert.equal(status.tasks[0]!.phase, "completed");
    assert.ok(status.tasks[0]!.artifact);
    assert.equal(status.ready.length, 1);
    await assert.rejects(readFile(handoffPath, "utf8"));
    await assert.rejects(readFile(manifestPath, "utf8"));
    assert.equal((JSON.parse(await readFile(status.ready[0]!.handoff_path as string, "utf8")) as { id: string }).id, "b");
    assert.equal((JSON.parse(await readFile(status.ready[0]!.operation_manifest as string, "utf8")) as { task_id: string }).task_id, "b");
  });
});

test("parallel cancellation is coordinator-only, survives running join, and session deletion cancels pending work", async () => {
  await withProject("parallel-cancel", async (directory) => {
    await writeFile(join(directory, ".gitignore"), "parallel-contract.json\n");
    await writeFile(join(directory, "base.txt"), "base\n");
    await execFileAsync("git", ["init", "-q"], { cwd: directory });
    await execFileAsync("git", ["config", "user.name", "Sortie Test"], { cwd: directory });
    await execFileAsync("git", ["config", "user.email", "sortie@example.invalid"], { cwd: directory });
    await execFileAsync("git", ["add", ".gitignore", "base.txt"], { cwd: directory });
    await execFileAsync("git", ["commit", "-q", "-m", "base"], { cwd: directory });
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: directory });
    const contractPath = join(directory, "parallel-contract.json");
    await writeFile(contractPath, JSON.stringify({
      version: "0.1.0", mode: "parallel", max_workers: 2,
      tasks: ["a", "b"].map((taskID) => ({ task_id: taskID, worktree: `cancel-${taskID}`,
        branch: `sortie/cancel-${taskID}`, base_sha: stdout.trim(), depends_on: [],
        scope: { read: ["base.txt"], write: [`${taskID}.txt`] } })),
      artifacts: [], failure: null, baseline_metrics: null,
    }));
    const hooks = await SortieDogsPlugin({ directory });
    await hooks["chat.message"]!(
      { sessionID: "root", agent: "dog-coordinator" },
      { message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } },
        parts: [{ type: "text", text: "parallel" }] },
    );
    const denied = JSON.parse(await hooks.tool!.sortie_cancel_parallel_dispatch!.execute(
      {}, { sessionID: "child", agent: "dog-worker" },
    )) as { status: string; reason: string };
    assert.deepEqual(denied, { status: "denied", reason: "coordinator-root-required" });
    const prepared = JSON.parse(await hooks.tool!.sortie_prepare_parallel_dispatch!.execute(
      { contract_path: contractPath }, { sessionID: "root", agent: "dog-coordinator" },
    )) as { run_id: string; ready: Array<Record<string, unknown>> };
    const descriptor = prepared.ready[0]!;
    const pendingDescriptor = prepared.ready[1]!;
    const prompt = [
      `task_id: ${descriptor.task_id}`, "role: implementation", `project_root: ${descriptor.managed_path}`,
      "source_manifest: [base.txt]", "operation_manifest: none", "acceptance: bounded cancel",
      "validation: no canonical validation", ...Object.entries(descriptor).filter(([key]) =>
        ![
          "task_id", "managed_path", "handoff_path", "operation_manifest",
          "acceptance", "acceptance_fingerprint", "acceptance_parent_fingerprint",
        ].includes(key))
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? JSON.stringify(value) : value}`),
      `managed_path: ${descriptor.managed_path}`,
    ].join("\n");
    await hooks["tool.execute.before"]!(
      { tool: "task", sessionID: "root", callID: "running" },
      { args: { subagent_type: "dog-worker", prompt } },
    );
    const originalCancel = ParallelDispatchCoordinator.prototype.cancel;
    ParallelDispatchCoordinator.prototype.cancel = async function () { throw new Error("simulated cancellation persistence failure"); };
    try {
      const failedCancellation = JSON.parse(await hooks.tool!.sortie_cancel_parallel_dispatch!.execute(
        { run_id: prepared.run_id }, { sessionID: "root", agent: "dog-coordinator" },
      ));
      assert.equal(failedCancellation.status, "denied");
      await readFile(pendingDescriptor.handoff_path as string, "utf8");
      await readFile(pendingDescriptor.operation_manifest as string, "utf8");
    } finally {
      ParallelDispatchCoordinator.prototype.cancel = originalCancel;
    }
    const cancelled = JSON.parse(await hooks.tool!.sortie_cancel_parallel_dispatch!.execute(
      { run_id: prepared.run_id }, { sessionID: "root", agent: "dog-coordinator" },
    )) as { archived: boolean; ready: unknown[]; tasks: Array<{ phase: string }> };
    assert.equal(cancelled.archived, false);
    assert.equal(cancelled.ready.length, 0);
    assert.deepEqual(cancelled.tasks.map(({ phase }) => phase).sort(), ["running", "suppressed"]);
    await assert.rejects(readFile(pendingDescriptor.handoff_path as string, "utf8"));
    await assert.rejects(readFile(pendingDescriptor.operation_manifest as string, "utf8"));
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "root" } } });
    const idle = JSON.parse(await hooks.tool!.sortie_parallel_dispatch_status!.execute(
      { run_id: prepared.run_id }, { sessionID: "root", agent: "dog-coordinator" },
    )) as { cancelled: boolean };
    assert.equal(idle.cancelled, true);
    await hooks["tool.execute.after"]!(
      { tool: "task", sessionID: "root", callID: "running" },
      { output: `SORTIE_PARALLEL_OUTCOME ${JSON.stringify({ run_id: prepared.run_id,
        dispatch_id: descriptor.dispatch_id, status: "completed" })}`, metadata: { sessionId: "child" } },
    );
    const archived = JSON.parse(await hooks.tool!.sortie_parallel_dispatch_status!.execute(
      { run_id: prepared.run_id }, { sessionID: "root", agent: "dog-coordinator" },
    )) as { archived: boolean; terminal_reason: string; tasks: Array<{ managed_path: string }> };
    assert.equal(archived.archived, true);
    assert.equal(archived.terminal_reason, "cancelled");
    assert.ok(archived.tasks.every(({ managed_path }) => managed_path.length > 0));

    const lifecycle = await WorktreeLifecycle.open({ repositoryRoot: directory });
    for (const id of ["cancel-a", "cancel-b"]) await lifecycle.cleanup(id);
    await writeFile(contractPath, (await readFile(contractPath, "utf8")).replaceAll("cancel-", "deleted-")
      .replaceAll("sortie/cancel-", "sortie/deleted-"));
    const next = JSON.parse(await hooks.tool!.sortie_prepare_parallel_dispatch!.execute(
      { contract_path: contractPath }, { sessionID: "root", agent: "dog-coordinator" },
    )) as { run_id: string };
    await hooks.event!({ event: { type: "session.deleted", properties: { sessionID: "root" } } });
    const reopened = await ParallelDispatchCoordinator.open({ repositoryRoot: directory });
    assert.equal((await reopened.snapshot("root", next.run_id))!.terminal_reason, "cancelled");
  });
});

test("an explicit Build selection relinquishes an established coordinator while preserving its model", async () => {
  await withProject("explicit-build-agent", async (directory) => {
    const hooks = await SortieDogsPlugin({ directory });
    const chat = hooks["chat.message"]!;
    await chat(
      { sessionID: "root", agent: "dog-coordinator" },
      {
        message: { agent: "dog-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
        parts: [{ type: "text", text: "start" }],
      },
    );
    const driftInput = { sessionID: "root", agent: "build" };
    const driftOutput = {
      message: { agent: "dog-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-sol", variant: "xhigh" } },
      parts: [{ type: "text", text: "continue with Sol" }],
    };
    await chat(driftInput, driftOutput);

    assert.equal(driftInput.agent, "build");
    assert.equal(driftOutput.message.agent, "build");
    assert.deepEqual(driftOutput.message.model, {
      providerID: "openai",
      modelID: "gpt-5.6-sol",
      variant: "xhigh",
    });
    await hooks["tool.execute.before"]!(
      { tool: "task", sessionID: "root", callID: "generic-after-agent-switch" },
      { args: { subagent_type: "agent-mk2a2-sol", prompt: "consult directly" } },
    );
  });
});

test("an explicit coordinator selection replaces a root agent but never promotes a child", async () => {
  await withProject("foreign-root-coordinator-command", async (directory) => {
    const hooks = await SortieDogsPlugin({ directory, client: { session: {
      get: async () => ({ data: { agent: "build" } }),
    } } as never });
    const chat = hooks["chat.message"]!;
    const foreignInput = { sessionID: "foreign-root", agent: "dog-coordinator" };
    const foreignOutput = {
      message: { agent: "dog-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
      parts: [{ type: "text", text: "release routine" }],
    };
    await chat(foreignInput, foreignOutput);
    assert.equal(foreignInput.agent, "dog-coordinator");
    assert.equal(foreignOutput.message.agent, "dog-coordinator");
    assert.deepEqual(foreignOutput.parts, [{ type: "text", text: "release routine" }]);
    await hooks["tool.execute.before"]!(
      { tool: "task", sessionID: "foreign-root", callID: "worker-after-build" },
      { args: { subagent_type: "dog-worker", prompt: readOnlyWorkerPrompt(directory) } },
    );

    const historyHooks = await SortieDogsPlugin({ directory, client: { session: {
      get: async () => ({ data: {} }),
      messages: async () => ({ data: [
        { info: { role: "user", agent: "build" }, parts: [{ type: "text", text: "prior build task" }] },
        { info: { role: "user", agent: "dog-coordinator" }, parts: [{ type: "text", text: "release routine" }] },
      ] }),
    } } as never });
    await historyHooks["experimental.chat.system.transform"]!(
      { sessionID: "foreign-history" },
      { system: [] },
    );
    const historyInput = { sessionID: "foreign-history", agent: "dog-coordinator" };
    const historyOutput = {
      message: { agent: "dog-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
      parts: [{ type: "text", text: "release routine" }],
    };
    await historyHooks["chat.message"]!(historyInput, historyOutput);
    assert.equal(historyInput.agent, "dog-coordinator");
    assert.equal(historyOutput.message.agent, "dog-coordinator");

    const partialClientHooks = await SortieDogsPlugin({ directory, client: { session: {
      messages: async () => { throw new Error("unavailable"); },
    } } as never });
    await partialClientHooks["chat.message"]!(
      { sessionID: "unverifiable-history", agent: "dog-coordinator" },
      {
        message: { agent: "dog-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
        parts: [{ type: "text", text: "release routine" }],
      },
    );

    const childHooks = await SortieDogsPlugin({ directory, client: { session: {
      get: async () => ({ data: { agent: "dog-coordinator", parentID: "foreign-root" } }),
    } } as never });
    await assert.rejects(
      () => childHooks["chat.message"]!(
        { sessionID: "foreign-child", parentID: "foreign-root", agent: "dog-coordinator" } as never,
        {
          message: { agent: "dog-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
          parts: [{ type: "text", text: "release routine" }],
        },
      ),
      (error: unknown) => isFreshSessionError(error, "child-lineage", "user-action-required", "open-fresh-root"),
    );
    await childHooks["chat.message"]!(
      { sessionID: "foreign-child", parentID: "foreign-root", agent: "build" } as never,
      {
        message: { agent: "build", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
        parts: [{ type: "text", text: "leave Sortie routing" }],
      },
    );
    const childAutoContinue = { enabled: true };
    await childHooks["experimental.compaction.autocontinue"]!(
      { sessionID: "foreign-child" },
      childAutoContinue,
    );
    assert.equal(childAutoContinue.enabled, true, "an explicit agent change releases the stopped Sortie lifecycle");

    const noClientHooks = await SortieDogsPlugin({ directory });
    await assert.rejects(
      () => noClientHooks["chat.message"]!(
        { sessionID: "explicit-child", parentID: "foreign-root", agent: "dog-coordinator" } as never,
        {
          message: { agent: "dog-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
          parts: [{ type: "text", text: "release routine" }],
        },
      ),
      (error: unknown) => isFreshSessionError(error, "child-lineage", "user-action-required", "open-fresh-root"),
    );

    await noClientHooks.event!({ event: { type: "session.created", properties: {
      info: { id: "remembered-child", parentID: "foreign-root", directory },
    } } });
    await assert.rejects(
      () => noClientHooks["chat.message"]!(
        { sessionID: "remembered-child", agent: "dog-coordinator" },
        {
          message: { agent: "dog-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
          parts: [{ type: "text", text: "release routine" }],
        },
      ),
      (error: unknown) => isFreshSessionError(error, "child-lineage", "user-action-required", "open-fresh-root"),
    );

    const nullRootHooks = await SortieDogsPlugin({ directory, client: { session: {
      get: async () => ({ data: { agent: "dog-coordinator", parentID: null } }),
    } } as never });
    await nullRootHooks["chat.message"]!(
      { sessionID: "null-root", parentID: null, agent: "dog-coordinator" } as never,
      {
        message: { agent: "dog-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
        parts: [{ type: "text", text: "release routine" }],
      },
    );
    await nullRootHooks["tool.execute.before"]!(
      { tool: "apply_patch", sessionID: "null-root", callID: "null-root-bootstrap", agent: "dog-coordinator" },
      { args: { patchText: [
        "*** Begin Patch",
        "*** Add File: null-root.operation-manifest.json",
        "+{}",
        "*** End Patch",
      ].join("\n") } },
    );
  });
});

test("a child coordinator request redispatches once to a fresh top-level session", async () => {
  await withProject("child-fresh-root-redispatch", async (directory) => {
    let creates = 0;
    let prompts = 0;
    let deletes = 0;
    let promptRequest: Record<string, unknown> | undefined;
    const hooks = await SortieDogsPlugin({ directory, client: { session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: path.id === "child"
        ? { id: "child", agent: "dog-coordinator", parentID: "parent" }
        : { id: path.id, agent: "dog-coordinator" } }),
      create: async () => { creates += 1; return { data: { id: "fresh-root" } }; },
      promptAsync: async (request: Record<string, unknown>) => {
        prompts += 1;
        promptRequest = request;
        return { data: true };
      },
      delete: async () => { deletes += 1; return { data: true }; },
    } } as never });
    const invoke = () => hooks["chat.message"]!(
      { sessionID: "child", parentID: "parent", agent: "dog-coordinator" } as never,
      {
        message: { agent: "dog-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
        parts: [{ type: "text", text: "continue the benchmark" }],
      },
    );
    const redispatched = (error: unknown) => {
      assert.ok(isFreshSessionError(error, "child-lineage", "redispatched"));
      assert.ok(error instanceof FreshSessionRequiredError && error.result.status === "redispatched");
      assert.equal(error.result.source_session_id, "child");
      assert.equal(error.result.target_session_id, "fresh-root");
      return true;
    };
    await assert.rejects(invoke, redispatched);
    await assert.rejects(invoke, redispatched);

    assert.equal(creates, 1);
    assert.equal(prompts, 1);
    assert.equal(deletes, 0);
    assert.deepEqual(promptRequest, {
      path: { id: "fresh-root" },
      query: { directory },
      body: {
        agent: "dog-coordinator",
        parts: [{ type: "text", text: "continue the benchmark" }],
      },
    });
  });
});

test("a host-created child is discarded instead of being treated as a fresh root", async () => {
  await withProject("child-fresh-root-rejected", async (directory) => {
    let prompts = 0;
    let deletes = 0;
    const hooks = await SortieDogsPlugin({ directory, client: { session: {
      get: async () => ({ data: { id: "child", agent: "dog-coordinator", parentID: "parent" } }),
      create: async () => ({ data: { id: "not-a-root", parentID: "parent" } }),
      promptAsync: async () => { prompts += 1; return { data: true }; },
      delete: async () => { deletes += 1; return { data: true }; },
    } } as never });
    await assert.rejects(
      () => hooks["chat.message"]!(
        { sessionID: "child", parentID: "parent", agent: "dog-coordinator" } as never,
        {
          message: { agent: "dog-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
          parts: [{ type: "text", text: "continue" }],
        },
      ),
      (error: unknown) => isFreshSessionError(error, "child-lineage", "user-action-required", "open-fresh-root"),
    );
    assert.equal(prompts, 0);
    assert.equal(deletes, 1);
  });
});

test("a rejected fresh-root prompt deletes the empty session and does not retry", async () => {
  await withProject("child-fresh-root-prompt-rejected", async (directory) => {
    let creates = 0;
    let prompts = 0;
    let deletes = 0;
    const hooks = await SortieDogsPlugin({ directory, client: { session: {
      get: async () => ({ data: { id: "child", agent: "dog-coordinator", parentID: "parent" } }),
      create: async () => { creates += 1; return { data: { id: "empty-root" } }; },
      promptAsync: async () => { prompts += 1; return { error: { name: "rejected" } }; },
      delete: async () => { deletes += 1; return { data: true }; },
    } } as never });
    const invoke = () => hooks["chat.message"]!(
      { sessionID: "child", parentID: "parent", agent: "dog-coordinator" } as never,
      {
        message: { agent: "dog-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
        parts: [{ type: "text", text: "continue" }],
      },
    );
    await assert.rejects(
      invoke,
      (error: unknown) => isFreshSessionError(error, "child-lineage", "user-action-required", "open-fresh-root"),
    );
    await assert.rejects(
      invoke,
      (error: unknown) => isFreshSessionError(error, "child-lineage", "user-action-required", "open-fresh-root"),
    );
    assert.equal(creates, 1);
    assert.equal(prompts, 1);
    assert.equal(deletes, 1);
  });
});

test("a completed coordinator message triggers checkpoint continuation when text-complete is absent", async () => {
  await withProject("message-event-continuation", async (directory) => {
    let summarizeCalls = 0;
    let historyReads = 0;
    const messages: SessionMessage[] = [{
      info: { id: "message-1", role: "assistant", agent: "dog-coordinator" } as never,
      parts: [{
        type: "text",
        text: "📊 進行中: event checkpoint — 100% (Project checkpoint) | " +
          "committed 1/3; attempted 1/3; reconciled 0 | continuation: required",
      }],
    }];
    const hooks = await SortieDogsPlugin({ directory, client: { session: {
      get: async () => ({ data: { agent: "dog-coordinator" } }),
      messages: async () => ({ data: ++historyReads > 1 ? messages : [] }),
      summarize: async () => { summarizeCalls += 1; return { data: true }; },
      promptAsync: async () => ({ data: true }),
    } } as never });
    await hooks["chat.message"]!(
      { sessionID: "root", agent: "dog-coordinator" },
      {
        message: { agent: "dog-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
        parts: [{ type: "text", text: "start" }],
      },
    );
    await hooks.tool!.sortie_enable_backlog_drain!.execute(
      { max_units: "4" },
      { sessionID: "root", agent: "dog-coordinator" },
    );
    await hooks["tool.execute.before"]!(
      { tool: "task", sessionID: "root", callID: "worker-1" },
      { args: { subagent_type: "dog-worker", prompt: readOnlyWorkerPrompt(directory) } },
    );
    const completed = { type: "message.updated", properties: { info: {
      id: "message-1",
      sessionID: "root",
      role: "assistant",
      agent: "dog-coordinator",
      time: { completed: Date.now() },
    } } };
    await hooks.event!({ event: completed });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(summarizeCalls, 1);
    assert.equal(historyReads, 2);
  });
});

test("a completed coordinator text part triggers continuation before step finish", async () => {
  await withProject("text-part-event-continuation", async (directory) => {
    let summarizeCalls = 0;
    const messages: SessionMessage[] = [{
      info: { id: "message-1", role: "assistant", agent: "dog-coordinator" } as never,
      parts: [{
        id: "part-1",
        type: "text",
        text: "📊 進行中: part checkpoint — 100% (Project checkpoint) | " +
          "committed 1/3; attempted 1/3; reconciled 0 | continuation: required",
      } as never],
    }];
    const hooks = await SortieDogsPlugin({ directory, client: { session: {
      get: async () => ({ data: { agent: "dog-coordinator" } }),
      messages: async () => ({ data: messages }),
      summarize: async () => { summarizeCalls += 1; return { data: true }; },
      promptAsync: async () => ({ data: true }),
    } } as never });
    await hooks["chat.message"]!(
      { sessionID: "root", agent: "dog-coordinator" },
      {
        message: { agent: "dog-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
        parts: [{ type: "text", text: "start" }],
      },
    );
    await hooks.tool!.sortie_enable_backlog_drain!.execute(
      { max_units: "4" },
      { sessionID: "root", agent: "dog-coordinator" },
    );
    await hooks["tool.execute.before"]!(
      { tool: "task", sessionID: "root", callID: "worker-1" },
      { args: { subagent_type: "dog-worker", prompt: readOnlyWorkerPrompt(directory) } },
    );
    const completed = { type: "message.part.updated", properties: { part: {
      id: "part-1",
      messageID: "message-1",
      sessionID: "root",
      type: "text",
      text: "📊 進行中: part checkpoint — 100% (Project checkpoint) | " +
        "committed 1/3; attempted 1/3; reconciled 0 | continuation: required",
      time: { start: Date.now() - 1, end: Date.now() },
    } } };
    await hooks.event!({ event: completed });
    await hooks.event!({ event: completed });
    await hooks.event!({ event: { type: "message.updated", properties: { info: {
      id: "message-1",
      sessionID: "root",
      role: "assistant",
      agent: "dog-coordinator",
      time: { completed: Date.now() },
    } } } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(summarizeCalls, 1);
  });
});

test("an interim coordinator progress part does not recover until the message completes", async () => {
  await withProject("text-part-event-recovery", async (directory) => {
    let prompts = 0;
    const messages: SessionMessage[] = [{
      info: { id: "message-1", role: "assistant", agent: "dog-coordinator" } as never,
      parts: [{
        id: "part-1",
        type: "text",
        text: "📊 進行中: tool準備中",
      } as never],
    }];
    const hooks = await SortieDogsPlugin({ directory, client: { session: {
      get: async () => ({ data: { agent: "dog-coordinator" } }),
      messages: async () => ({ data: messages }),
      promptAsync: async () => { prompts += 1; return { data: true }; },
    } } as never });
    await hooks["chat.message"]!(
      { sessionID: "root", agent: "dog-coordinator" },
      {
        message: { agent: "dog-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
        parts: [{ type: "text", text: "start" }],
      },
    );
    await hooks.event!({ event: { type: "message.part.updated", properties: { part: {
      id: "part-1",
      messageID: "message-1",
      sessionID: "root",
      type: "text",
      text: "📊 進行中: tool準備中",
      time: { end: Date.now() },
    } } } });

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(prompts, 0);

    await hooks.event!({ event: { type: "message.updated", properties: { info: {
      id: "message-1",
      sessionID: "root",
      role: "assistant",
      agent: "dog-coordinator",
      time: { completed: Date.now() },
    } } } });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(prompts, 1);
  });
});

test("coordinator children and foreign text parts cannot become continuation roots", async () => {
  await withProject("continuation-event-identity", async (directory) => {
    let summarizeCalls = 0;
    const messages: SessionMessage[] = [{
      info: { id: "foreign-message", role: "user", agent: "build" } as never,
      parts: [{
        id: "foreign-part",
        type: "text",
        text: "📊 進行中: forged — 100% (Project checkpoint) | committed 1/3; attempted 1/3 | continuation: required",
      } as never],
    }];
    const hooks = await SortieDogsPlugin({ directory, client: { session: {
      get: async () => ({ data: { agent: "dog-coordinator", parentID: "root" } }),
      messages: async () => ({ data: messages }),
      summarize: async () => { summarizeCalls += 1; return { data: true }; },
      promptAsync: async () => ({ data: true }),
    } } as never });
    await assert.rejects(
      () => hooks["chat.message"]!(
        { sessionID: "child", agent: "dog-coordinator", parentID: null } as never,
        {
          message: { agent: "dog-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
          parts: [{ type: "text", text: "child" }],
        },
      ),
      /SORTIE_FRESH_SESSION_REQUIRED/u,
    );
    await hooks.event!({ event: { type: "message.part.updated", properties: { sessionID: "child", part: {
      id: "foreign-part",
      messageID: "foreign-message",
      type: "text",
      text: (messages[0]!.parts![0]!.text as string),
      time: { end: Date.now() },
    } } } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(summarizeCalls, 0);
    const system = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!({ sessionID: "child" }, system);
    assert.equal(system.system.length, 0);
  });
});

test("an owned compaction text part resumes the same coordinator root", async () => {
  await withProject("compaction-part-event-continuation", async (directory) => {
    let prompts = 0;
    let releaseSummary!: () => void;
    const summaryReleased = new Promise<void>((resolve) => { releaseSummary = resolve; });
    const messages: SessionMessage[] = [{
      info: { id: "compaction-message", role: "assistant", agent: "compaction" } as never,
      parts: [{
        id: "compaction-part",
        type: "text",
        text: "## 目的\n- ordered sequence\n\n## 確定判断\n- checkpoint done\n\n" +
          "## source_manifest\n- fixture.txt | read-only | fixture | preserve | unchanged\n\n" +
          "## 未完\n- next candidate | pending | same root\n\n## 検証command\n- none | fixture | none | pending\n\n" +
          "## 次の一手\n- continue\n\n## 参照済みfile一覧\n- fixture.txt | fixture",
      } as never],
    }];
    const hooks = await SortieDogsPlugin({ directory, client: { session: {
      get: async () => ({ data: { agent: "dog-coordinator" } }),
      messages: async () => ({ data: messages }),
      summarize: async () => { await summaryReleased; return { data: true }; },
      promptAsync: async () => { prompts += 1; return { data: true }; },
    } } as never });
    await hooks["chat.message"]!(
      { sessionID: "root", agent: "dog-coordinator" },
      {
        message: { agent: "dog-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
        parts: [{ type: "text", text: "start" }],
      },
    );
    await hooks.tool!.sortie_enable_backlog_drain!.execute(
      { max_units: "4" },
      { sessionID: "root", agent: "dog-coordinator" },
    );
    await hooks["tool.execute.before"]!(
      { tool: "task", sessionID: "root", callID: "worker-1" },
      { args: { subagent_type: "dog-worker", prompt: readOnlyWorkerPrompt(directory) } },
    );
    await hooks["experimental.text.complete"]!(
      { sessionID: "root" },
      { text: "📊 進行中: checkpoint — 100% (Project checkpoint) | committed 1/3; attempted 1/3 | continuation: required" },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await hooks["experimental.session.compacting"]!({ sessionID: "root" }, {});
    await hooks.event!({ event: { type: "message.part.updated", properties: { sessionID: "root", part: {
      id: "compaction-part",
      messageID: "compaction-message",
      type: "text",
      text: messages[0]!.parts![0]!.text,
      time: { end: Date.now() },
    } } } });
    releaseSummary();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(prompts, 1);
    await hooks["chat.message"]!(
      { sessionID: "root", agent: "dog-coordinator" },
      {
        message: { agent: "dog-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
        parts: [{ type: "text", text: "resume", synthetic: true }],
      },
    );
    await hooks["tool.execute.before"]!(
      { tool: "task", sessionID: "root", callID: "worker-2" },
      { args: { subagent_type: "dog-worker", prompt: readOnlyWorkerPrompt(directory) } },
    );
  });
});

test("worker dispatch rejects an unregistered handoff and trusts its inspected manifest", async () => {
  await withProject("worker-dispatch-preflight", async (directory) => {
    await mkdir(join(directory, ".opencode"));
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify({
      ...fixture.manifest,
      validation: ["npm test"],
    }));
    const unregistered = join(directory, ".opencode", "handoff.task-a.json");
    await writeFile(unregistered, JSON.stringify(writeGateHandoff(directory, "operation-manifest.json")));
    const registered = join(directory, "handoff.task-a.json");
    await writeFile(registered, JSON.stringify({
      ...writeGateHandoff(directory, "operation-manifest.json"),
      id: "task-a",
    }));
    const hooks = await SortieDogsPlugin({ directory });
    await hooks["chat.message"]!(
      { sessionID: "root", agent: "dog-coordinator" },
      {
        message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } },
        parts: [{ type: "text", text: "task" }],
      },
    );
    const dispatch = (handoffPath: string, callID: string) => hooks["tool.execute.before"]!(
      { tool: "task", sessionID: "root", callID },
      {
        args: {
          subagent_type: "dog-worker",
          prompt: [
            "task_id: task-a",
            "role: implementation",
            `project_root: ${directory}`,
            `handoff_path: ${handoffPath}`,
            "source_manifest:",
            "  - allowed.txt",
            "operation_manifest: operation-manifest.json",
            "acceptance:",
            "  - safe change",
            "validation:",
            "  command: npm test",
          ].join("\n"),
        },
      },
    );

    await assert.rejects(
      () => dispatch(unregistered, "bad-worker"),
      (error: unknown) => {
        assert.ok(error instanceof HandoffDeniedError);
        assert.equal(error.reason, "path-invalid");
        assert.deepEqual(error.defects, ["handoff / handoff_path_not_registered"]);
        return true;
      },
    );
    await hooks["tool.execute.before"]!(
      { tool: "task", sessionID: "root", callID: "validation-manifest-mismatch" },
      {
        args: {
          subagent_type: "dog-worker",
          prompt: [
            "task_id: task-a",
            "context_digest:",
            `  project_root: ${directory}`,
            `  handoff_path: ${registered}`,
            "  acceptance: safe change",
            "  role: implementation",
            "  validation: { level: full, command: npm run different, diagnostics: [] }",
            "source_manifest: [allowed.txt]",
            "operation_manifest: operation-manifest.json",
          ].join("\n"),
        },
      },
    );
    await hooks["tool.execute.after"]!(
      { tool: "task", sessionID: "root", callID: "validation-manifest-mismatch" },
      {},
    );
    await hooks["tool.execute.before"]!(
      { tool: "task", sessionID: "root", callID: "validation-block-manifest-mismatch" },
      {
        args: {
          subagent_type: "dog-worker",
          prompt: [
            "task_id: task-a",
            "context_digest:",
            `  project_root: ${directory}`,
            `  handoff_path: ${registered}`,
            "  acceptance: safe change",
            "  role: implementation",
            "  validation:",
            "    command: npm run different",
            "source_manifest: [allowed.txt]",
            "operation_manifest: operation-manifest.json",
          ].join("\n"),
        },
      },
    );
    await hooks["tool.execute.after"]!(
      { tool: "task", sessionID: "root", callID: "validation-block-manifest-mismatch" },
      {},
    );
    await assert.rejects(
      () => hooks["tool.execute.before"]!(
        { tool: "task", sessionID: "root", callID: "partial-worker" },
        { args: { subagent_type: "dog-worker", prompt: "role: implementation" } },
      ),
      (error: unknown) => {
        assert.ok(error instanceof HandoffDeniedError);
        assert.deepEqual(error.defects, ["contract / dispatch_inline_handoff_incomplete"]);
        return true;
      },
    );
    await hooks["tool.execute.before"]!(
      { tool: "task", sessionID: "root", callID: "readonly-worker-with-output-schema" },
      {
        args: {
          subagent_type: "dog-worker",
          prompt: [
            "task_id: readonly-a",
            "context_digest:",
            `  project_root: ${directory}`,
            "  acceptance:",
            "    - report one read-only identity",
            "  role: implementation",
            "  validation:",
            "    command: git hash-object AGENTS.md",
            "source_manifest: [AGENTS.md]",
            "operation_manifest: none",
            "return format:",
            "validation: { command: exact, exit: 0, fingerprint: concise }",
          ].join("\n"),
        },
      },
    );
    await hooks["tool.execute.after"]!(
      { tool: "task", sessionID: "root", callID: "readonly-worker-with-output-schema" },
      { output: "<task_result>done</task_result>", metadata: {} },
    );
    await assert.rejects(
      () => hooks["tool.execute.before"]!(
        { tool: "task", sessionID: "root", callID: "partial-readonly-worker" },
        { args: { subagent_type: "dog-worker", prompt: "role: implementation\noperation_manifest: none" } },
      ),
      (error: unknown) => {
        assert.ok(error instanceof HandoffDeniedError);
        assert.deepEqual(error.defects, ["contract / dispatch_inline_handoff_incomplete"]);
        return true;
      },
    );
    await assert.rejects(
      () => hooks["tool.execute.before"]!(
        { tool: "task", sessionID: "root", callID: "relative-readonly-worker" },
        {
          args: {
            subagent_type: "dog-worker",
            prompt: "role: implementation\nproject_root: .\nsource_manifest: [AGENTS.md]\noperation_manifest: none\nacceptance: read only\nvalidation: read only",
          },
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof HandoffDeniedError);
        assert.deepEqual(error.defects, ["contract /project_root dispatch_project_root_unique_absolute"]);
        return true;
      },
    );
    await assert.rejects(
      () => hooks["tool.execute.before"]!(
        { tool: "task", sessionID: "root", callID: "duplicate-readonly-worker" },
        {
          args: {
            subagent_type: "dog-worker",
            prompt: [
              "role: implementation",
              `project_root: ${directory}`,
              "source_manifest: [AGENTS.md]",
              "source_manifest: [README.md]",
              "operation_manifest: none",
              "acceptance: read only",
              "validation: read only",
            ].join("\n"),
          },
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof HandoffDeniedError);
        assert.deepEqual(error.defects, ["contract /source_manifest readonly_source_manifest_unique"]);
        return true;
      },
    );
    await assert.rejects(
      () => hooks["tool.execute.before"]!(
        { tool: "task", sessionID: "root", callID: "ambiguous-acceptance-worker" },
        {
          args: {
            subagent_type: "dog-worker",
            prompt: [
              "role: implementation",
              `project_root: ${directory}`,
              "source_manifest: [AGENTS.md]",
              "operation_manifest: none",
              "acceptance: first",
              "acceptance: second",
              "validation: read only",
            ].join("\n"),
          },
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof HandoffDeniedError);
        assert.deepEqual(error.defects, ["contract / dispatch_acceptance_validation_ambiguous"]);
        return true;
      },
    );
    await assert.rejects(
      () => hooks["tool.execute.before"]!(
        { tool: "task", sessionID: "root", callID: "duplicate-worker" },
        {
          args: {
            subagent_type: "dog-worker",
            prompt: [
              "task_id: task-a",
              "role: implementation",
              `project_root: ${directory}`,
              "handoff_path:",
              `handoff_path: ${registered}`,
              "source_manifest: [allowed.txt]",
              "operation_manifest: operation-manifest.json",
              "acceptance: safe change",
              "validation: npm test",
            ].join("\n"),
          },
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof HandoffDeniedError);
        assert.deepEqual(error.defects, ["contract /handoff_path dispatch_handoff_path_unique_absolute"]);
        return true;
      },
    );
    await assert.rejects(
      () => hooks["tool.execute.before"]!(
        { tool: "task", sessionID: "root", callID: "mismatch-worker" },
        {
          args: {
            subagent_type: "dog-worker",
            prompt: [
              "task_id: task-a",
              "role: implementation",
              `project_root: ${directory}`,
              `handoff_path: ${registered}`,
              "source_manifest: [allowed.txt]",
              "operation_manifest: other-manifest.json",
              "acceptance: safe change",
              "validation: npm test",
            ].join("\n"),
          },
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof HandoffDeniedError);
        assert.deepEqual(error.defects, ["contract / dispatch_identity_mismatch"]);
        return true;
      },
    );
    const implicit = join(directory, "handoff.implicit.json");
    const implicitHandoff = { ...fixture.handoffs.valid, id: "implicit" };
    await writeFile(implicit, JSON.stringify(implicitHandoff));
    await assert.rejects(
      () => dispatch(implicit, "implicit-worker"),
      (error: unknown) => {
        assert.ok(error instanceof HandoffDeniedError);
        assert.deepEqual(error.defects, ["handoff / ext_write_gate_missing"]);
        return true;
      },
    );
    await assert.rejects(
      () => hooks["tool.execute.before"]!(
        { tool: "task", sessionID: "root", callID: "empty-block-worker" },
        { args: { subagent_type: "dog-worker", prompt: [
          "task_id: task-a",
          "role: implementation",
          `project_root: ${directory}`,
          `handoff_path: ${registered}`,
          "  source_manifest:",
          "operation_manifest: operation-manifest.json",
          "  acceptance:",
          "  validation:",
        ].join("\n") } },
      ),
      (error: unknown) => error instanceof HandoffDeniedError &&
        error.defects.includes("contract / dispatch_inline_handoff_incomplete"),
    );
    await dispatch(registered, "good-worker");
  });
});

test("current runtime assets require exact acceptance continuity on mutating dispatch", async () => {
  await withProject("acceptance-continuity-dispatch", async (directory) => {
    await mkdir(join(directory, ".opencode"));
    await writeFile(join(directory, ".opencode", "sortie-dogs.version"), `${RUNTIME_ASSET_VERSION}\n`);
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify({
      ...fixture.manifest,
      validation: ["npm test"],
    }));
    const handoffPath = join(directory, "handoff.task-a.json");
    const base = writeGateHandoff(directory, "operation-manifest.json") as { ext: Record<string, unknown> };
    await writeFile(handoffPath, JSON.stringify({ ...base, id: "task-a" }));
    const hooks = await SortieDogsPlugin({ directory });
    await hooks["chat.message"]!(
      { sessionID: "root", agent: "dog-coordinator" },
      { message: { agent: "dog-coordinator", model: {} }, parts: [{ type: "text", text: "task" }] },
    );
    const dispatch = (acceptance: string, callID: string, taskID = "task-a") => hooks["tool.execute.before"]!(
      { tool: "task", sessionID: "root", callID },
      { args: { subagent_type: "dog-worker", prompt: [
        `task_id: ${taskID}`,
        "role: implementation",
        `project_root: ${directory}`,
        `handoff_path: ${handoffPath}`,
        "source_manifest: [allowed.txt]",
        "operation_manifest: operation-manifest.json",
        "acceptance:",
        `  - ${acceptance}`,
        "validation: npm test",
      ].join("\n") } },
    );
    await assert.rejects(() => dispatch("preserve exact quality", "missing-continuity"),
      (error: unknown) => error instanceof HandoffDeniedError &&
        error.defects.includes("handoff /ext/sortie-dogs~1acceptance-continuity acceptance_continuity_absent"));

    const criteria = ["preserve exact quality"];
    await writeFile(handoffPath, JSON.stringify({
      ...base,
      id: "task-a",
      ext: { ...base.ext, [ACCEPTANCE_CONTINUITY_EXTENSION]: acceptanceContinuity("task-other", criteria) },
    }));
    await assert.rejects(() => dispatch(criteria[0]!, "handoff-ledger-id-mismatch", "task-other"),
      (error: unknown) => error instanceof HandoffDeniedError &&
        error.defects.includes("contract /acceptance acceptance_continuity_mismatch"));
    await writeFile(handoffPath, JSON.stringify({
      ...base,
      id: "task-a",
      ext: { ...base.ext, [ACCEPTANCE_CONTINUITY_EXTENSION]: acceptanceContinuity("task-a", criteria,
        acceptanceContinuityFingerprint(["unrelated criterion"])) },
    }));
    await assert.rejects(() => dispatch(criteria[0]!, "initial-parent"),
      (error: unknown) => error instanceof HandoffDeniedError &&
        error.defects.includes("handoff /ext/sortie-dogs~1acceptance-continuity acceptance_parent_continuity_mismatch"));
    await writeFile(handoffPath, JSON.stringify({
      ...base,
      id: "task-a",
      ext: { ...base.ext, [ACCEPTANCE_CONTINUITY_EXTENSION]: acceptanceContinuity("task-a", criteria) },
    }));
    await assert.rejects(() => dispatch("broad quality", "drifted-continuity"),
      (error: unknown) => error instanceof HandoffDeniedError &&
        error.defects.includes("contract /acceptance acceptance_continuity_mismatch"));
    await dispatch(criteria[0]!, "valid-continuity");
  });
});

test("follow-up mutating dispatch cannot drop parent acceptance criteria", async () => {
  await withProject("acceptance-parent-continuity", async (directory) => {
    await mkdir(join(directory, ".opencode"));
    await writeFile(join(directory, ".opencode", "sortie-dogs.version"), `${RUNTIME_ASSET_VERSION}\n`);
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify({
      ...fixture.manifest,
      validation: ["npm test"],
    }));
    const firstCriteria = ["keep the reference", "preserve visual density"];
    const firstFingerprint = acceptanceContinuityFingerprint(firstCriteria);
    const firstPath = join(directory, "handoff.task-a.json");
    const secondPath = join(directory, "handoff.task-b.json");
    const thirdPath = join(directory, "handoff.task-c.json");
    const base = writeGateHandoff(directory, "operation-manifest.json") as { ext: Record<string, unknown> };
    await writeFile(firstPath, JSON.stringify({
      ...base, id: "task-a",
      ext: { ...base.ext, [ACCEPTANCE_CONTINUITY_EXTENSION]: acceptanceContinuity("task-a", firstCriteria) },
    }));
    const hooks = await SortieDogsPlugin({ directory });
    await hooks["chat.message"]!(
      { sessionID: "root", agent: "dog-coordinator" },
      { message: { agent: "dog-coordinator", model: {} }, parts: [{ type: "text", text: "task" }] },
    );
    const dispatch = async (taskID: string, handoffPath: string, criteria: string[], callID: string) => {
      await hooks["tool.execute.before"]!(
        { tool: "task", sessionID: "root", callID },
        { args: { subagent_type: "dog-worker", prompt: [
          `task_id: ${taskID}`,
          "role: implementation",
          `project_root: ${directory}`,
          `handoff_path: ${handoffPath}`,
          "source_manifest: [allowed.txt]",
          "operation_manifest: operation-manifest.json",
          "acceptance:",
          ...criteria.map((criterion) => `  - ${criterion}`),
          "validation: npm test",
        ].join("\n") } },
      );
    };
    await dispatch("task-a", firstPath, firstCriteria, "first-continuity");
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "first-continuity" }, {});
    await writeFile(firstPath, JSON.stringify({
      ...base, id: "task-a",
      ext: { ...base.ext, [ACCEPTANCE_CONTINUITY_EXTENSION]: acceptanceContinuity(
        "task-a", firstCriteria, acceptanceContinuityFingerprint(["wrong parent"]),
      ) },
    }));
    await assert.rejects(() => dispatch("task-a", firstPath, firstCriteria, "unchanged-parent-drift"),
      (error: unknown) => error instanceof HandoffDeniedError &&
        error.defects.includes("handoff /ext/sortie-dogs~1acceptance-continuity acceptance_parent_continuity_mismatch"));
    const dispatchFollowUp = async (criteria: string[], callID: string, accepted = false) => {
      await writeFile(secondPath, JSON.stringify({
        ...base, id: "task-b",
        ext: { ...base.ext, [ACCEPTANCE_CONTINUITY_EXTENSION]: acceptanceContinuity("task-b", criteria, firstFingerprint) },
      }));
      if (accepted) {
        await dispatch("task-b", secondPath, criteria, callID);
      } else {
        await assert.rejects(() => dispatch("task-b", secondPath, criteria, callID),
          (error: unknown) => error instanceof HandoffDeniedError &&
            error.defects.includes("handoff /ext/sortie-dogs~1acceptance-continuity acceptance_parent_continuity_mismatch"));
      }
    };
    await dispatchFollowUp([firstCriteria[1]!, firstCriteria[0]!], "reordered-parent");
    await dispatchFollowUp(firstCriteria, "changed-task-without-strict-append");
    await dispatchFollowUp(["add grass clusters", ...firstCriteria], "inserted-before-parent");
    await dispatchFollowUp([firstCriteria[0]!, "add grass clusters", firstCriteria[1]!], "inserted-between-parent");
    await hooks["tool.execute.before"]!(
      { tool: "task", sessionID: "root", callID: "lane-blocker" },
      { args: { subagent_type: "dog-worker", prompt: readOnlyWorkerPrompt(directory) } },
    );
    const rejectedCriteria = [...firstCriteria, "rejected staged criterion"];
    await writeFile(secondPath, JSON.stringify({
      ...base, id: "task-b",
      ext: { ...base.ext, [ACCEPTANCE_CONTINUITY_EXTENSION]: acceptanceContinuity(
        "task-b", rejectedCriteria, firstFingerprint,
      ) },
    }));
    await assert.rejects(() => dispatch("task-b", secondPath, rejectedCriteria, "rejected-before-dispatch"),
      /SORTIE_FAST_LANE_DENIED: WORKER_LIMIT/u);
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "lane-blocker" }, {});
    const correctedCriteria = [...firstCriteria, "corrected criterion"];
    await writeFile(thirdPath, JSON.stringify({
      ...base, id: "task-c",
      ext: { ...base.ext, [ACCEPTANCE_CONTINUITY_EXTENSION]: acceptanceContinuity(
        "task-c", correctedCriteria, firstFingerprint,
      ) },
    }));
    await dispatch("task-c", thirdPath, correctedCriteria, "corrected-after-rejection");
  });
});

test("a fresh coordinator recovers serial acceptance continuity from its strict prefix", async () => {
  await withProject("acceptance-parent-serial-recovery", async (directory) => {
    await mkdir(join(directory, ".opencode"));
    await writeFile(join(directory, ".opencode", "sortie-dogs.version"), `${RUNTIME_ASSET_VERSION}\n`);
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify({
      ...fixture.manifest,
      validation: ["npm test"],
    }));
    const parentCriteria = ["keep the pinned snapshot", "preserve the non-claim boundary"];
    const criteria = [...parentCriteria, "record the measured snapshot state"];
    const handoffPath = join(directory, "handoff.resumed-task.json");
    const base = writeGateHandoff(directory, "operation-manifest.json") as { ext: Record<string, unknown> };
    await writeFile(handoffPath, JSON.stringify({
      ...base,
      id: "resumed-task",
      ext: { ...base.ext, [ACCEPTANCE_CONTINUITY_EXTENSION]: acceptanceContinuity(
        "resumed-task", criteria, acceptanceContinuityFingerprint(parentCriteria),
      ) },
    }));
    const hooks = await SortieDogsPlugin({ directory });
    await hooks["chat.message"]!(
      { sessionID: "fresh-root", agent: "dog-coordinator" },
      { message: { agent: "dog-coordinator", model: {} }, parts: [{ type: "text", text: "resume" }] },
    );
    await hooks["tool.execute.before"]!(
      { tool: "task", sessionID: "fresh-root", callID: "serial-recovery" },
      { args: { subagent_type: "dog-worker", prompt: [
        "task_id: resumed-task",
        "role: implementation",
        `project_root: ${directory}`,
        `handoff_path: ${handoffPath}`,
        "source_manifest: [allowed.txt]",
        "operation_manifest: operation-manifest.json",
        "acceptance:",
        ...criteria.map((criterion) => `  - ${criterion}`),
        "validation: npm test",
      ].join("\n") } },
    );
  });
});

test("global stale marker blocks dispatch when no project marker exists", async () => {
  await withProject("global-asset-version-skew", async (directory) => {
    const globalRoot = process.env.OPENCODE_CONFIG_DIR!;
    await rm(globalRoot, { recursive: true, force: true });
    await mkdir(globalRoot, { recursive: true });
    await writeFile(join(globalRoot, "sortie-dogs.version"), "0.3.33-readable-terminal-report-v1\n");
    try {
      const hooks = await SortieDogsPlugin({ directory });
      await hooks["chat.message"]!(
        { sessionID: "root", agent: "dog-coordinator" },
        { message: { agent: "dog-coordinator", model: {} }, parts: [{ type: "text", text: "task" }] },
      );
      await assert.rejects(() => hooks["tool.execute.before"]!(
        { tool: "task", sessionID: "root", callID: "global-skewed-worker" },
        { args: { subagent_type: "dog-worker", prompt: readOnlyWorkerPrompt(directory) } },
      ), (error: unknown) => isFreshSessionError(
        error, "asset-contract-skew", "user-action-required", "install-assets-then-open-fresh-root",
      ));
    } finally {
      await rm(globalRoot, { recursive: true, force: true });
    }
  });
});

test("current global marker enables acceptance continuity enforcement", async () => {
  await withProject("global-current-continuity", async (directory) => {
    const globalRoot = process.env.OPENCODE_CONFIG_DIR!;
    await rm(globalRoot, { recursive: true, force: true });
    await mkdir(globalRoot, { recursive: true });
    await writeFile(join(globalRoot, "sortie-dogs.version"), `${RUNTIME_ASSET_VERSION}\n`);
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify({
      ...fixture.manifest,
      validation: ["npm test"],
    }));
    const handoffPath = join(directory, "handoff.task-global.json");
    await writeFile(handoffPath, JSON.stringify({
      ...writeGateHandoff(directory, "operation-manifest.json"),
      id: "task-global",
    }));
    try {
      const hooks = await SortieDogsPlugin({ directory });
      await hooks["chat.message"]!(
        { sessionID: "root", agent: "dog-coordinator" },
        { message: { agent: "dog-coordinator", model: {} }, parts: [{ type: "text", text: "task" }] },
      );
      await assert.rejects(() => hooks["tool.execute.before"]!(
        { tool: "task", sessionID: "root", callID: "global-current-worker" },
        { args: { subagent_type: "dog-worker", prompt: [
          "task_id: task-global",
          "role: implementation",
          `project_root: ${directory}`,
          `handoff_path: ${handoffPath}`,
          "source_manifest: [allowed.txt]",
          "operation_manifest: operation-manifest.json",
          "acceptance: preserve exact quality",
          "validation: npm test",
        ].join("\n") } },
      ), (error: unknown) => error instanceof HandoffDeniedError &&
        error.defects.includes("handoff /ext/sortie-dogs~1acceptance-continuity acceptance_continuity_absent"));
    } finally {
      await rm(globalRoot, { recursive: true, force: true });
    }
  });
});

test("present corrupt project markers override a current global marker and fail closed", async () => {
  await withProject("project-marker-corruption", async (directory) => {
    const globalRoot = process.env.OPENCODE_CONFIG_DIR!;
    await rm(globalRoot, { recursive: true, force: true });
    await mkdir(globalRoot, { recursive: true });
    await writeFile(join(globalRoot, "sortie-dogs.version"), `${RUNTIME_ASSET_VERSION}\n`);
    await mkdir(join(directory, ".opencode"));
    const marker = join(directory, ".opencode", "sortie-dogs.version");
    await writeFile(marker, "");
    try {
      const hooks = await SortieDogsPlugin({ directory });
      const rejectSession = async (sessionID: string) => {
        await hooks["chat.message"]!(
          { sessionID, agent: "dog-coordinator" },
          { message: { agent: "dog-coordinator", model: {} }, parts: [{ type: "text", text: "task" }] },
        );
        await assert.rejects(() => hooks["tool.execute.before"]!(
          { tool: "task", sessionID, callID: `worker-${sessionID}` },
          { args: { subagent_type: "dog-worker", prompt: readOnlyWorkerPrompt(directory) } },
        ), (error: unknown) => isFreshSessionError(
          error, "asset-contract-skew", "user-action-required", "install-assets-then-open-fresh-root",
        ));
      };
      await rejectSession("empty-marker-root");
      await rm(marker);
      await mkdir(marker);
      await rejectSession("directory-marker-root");
    } finally {
      await rm(globalRoot, { recursive: true, force: true });
    }
  });
});

test("asset version skew stays blocked until a fresh plugin session", async () => {
  await withProject("asset-version-skew-block", async (directory) => {
    await mkdir(join(directory, ".opencode"));
    const marker = join(directory, ".opencode", "sortie-dogs.version");
    await writeFile(marker, "0.3.33-readable-terminal-report-v1\n");
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    const hooks = await SortieDogsPlugin({ directory });
    await hooks["chat.message"]!(
      { sessionID: "root", agent: "dog-coordinator" },
      { message: { agent: "dog-coordinator", model: {} }, parts: [{ type: "text", text: "task" }] },
    );
    const dispatch = (sessionID = "root", prompt = "role: implementation") => hooks["tool.execute.before"]!(
      { tool: "task", sessionID, callID: `skewed-worker-${sessionID}` },
      { args: { subagent_type: "dog-worker", prompt } },
    );
    await assert.rejects(dispatch, (error: unknown) => isFreshSessionError(
      error, "asset-contract-skew", "user-action-required", "install-assets-then-open-fresh-root",
    ));
    await writeFile(marker, `${RUNTIME_ASSET_VERSION}\n`);
    await assert.rejects(dispatch, (error: unknown) => isFreshSessionError(
      error, "asset-contract-skew", "user-action-required", "open-fresh-root",
    ));
    await hooks["chat.message"]!(
      { sessionID: "fresh-root", agent: "dog-coordinator" },
      { message: { agent: "dog-coordinator", model: {} }, parts: [{ type: "text", text: "task" }] },
    );
    await dispatch("fresh-root", readOnlyWorkerPrompt(directory));
  });
});

test("a repaired asset skew redispatches the retained request to one fresh root", async () => {
  await withProject("asset-version-skew-redispatch", async (directory) => {
    await mkdir(join(directory, ".opencode"));
    const marker = join(directory, ".opencode", "sortie-dogs.version");
    await writeFile(marker, "0.3.33-readable-terminal-report-v1\n");
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    let creates = 0;
    let prompts = 0;
    let promptRequest: Record<string, unknown> | undefined;
    const hooks = await SortieDogsPlugin({ directory, client: { session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, agent: "dog-coordinator" } }),
      create: async () => { creates += 1; return { data: { id: "repaired-root" } }; },
      promptAsync: async (request: Record<string, unknown>) => {
        prompts += 1;
        promptRequest = request;
        return { data: true };
      },
    } } as never });
    await hooks["chat.message"]!(
      { sessionID: "stale-root", agent: "dog-coordinator" },
      {
        message: { agent: "dog-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
        parts: [{ type: "text", text: "continue benchmark from durable handoff" }],
      },
    );
    const dispatch = (callID: string) => hooks["tool.execute.before"]!(
      { tool: "task", sessionID: "stale-root", callID },
      { args: { subagent_type: "dog-worker", prompt: readOnlyWorkerPrompt(directory) } },
    );
    await assert.rejects(
      () => dispatch("before-repair"),
      (error: unknown) => isFreshSessionError(
        error, "asset-contract-skew", "user-action-required", "install-assets-then-open-fresh-root",
      ),
    );
    assert.equal(creates, 0);

    await writeFile(marker, `${RUNTIME_ASSET_VERSION}\n`);
    const redispatched = (error: unknown) => {
      assert.ok(isFreshSessionError(error, "asset-contract-skew", "redispatched"));
      assert.ok(error instanceof FreshSessionRequiredError && error.result.status === "redispatched");
      assert.equal(error.result.target_session_id, "repaired-root");
      return true;
    };
    await assert.rejects(() => dispatch("after-repair"), redispatched);
    await assert.rejects(() => dispatch("duplicate-after-repair"), redispatched);

    assert.equal(creates, 1);
    assert.equal(prompts, 1);
    assert.deepEqual(promptRequest, {
      path: { id: "repaired-root" },
      query: { directory },
      body: {
        agent: "dog-coordinator",
        parts: [{ type: "text", text: "continue benchmark from durable handoff" }],
      },
    });
  });
});

test("asset skew returning during root creation deletes the unprompted session", async () => {
  await withProject("asset-version-skew-create-race", async (directory) => {
    await mkdir(join(directory, ".opencode"));
    const marker = join(directory, ".opencode", "sortie-dogs.version");
    await writeFile(marker, "0.3.33-readable-terminal-report-v1\n");
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    let creates = 0;
    let prompts = 0;
    let deletes = 0;
    const hooks = await SortieDogsPlugin({ directory, client: { session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, agent: "dog-coordinator" } }),
      create: async () => {
        creates += 1;
        if (creates === 1) await writeFile(marker, "0.3.33-readable-terminal-report-v1\n");
        return { data: { id: `raced-root-${creates}` } };
      },
      promptAsync: async () => { prompts += 1; return { data: true }; },
      delete: async () => { deletes += 1; return { data: true }; },
    } } as never });
    await hooks["chat.message"]!(
      { sessionID: "stale-root", agent: "dog-coordinator" },
      {
        message: { agent: "dog-coordinator", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
        parts: [{ type: "text", text: "continue benchmark" }],
      },
    );
    await writeFile(marker, `${RUNTIME_ASSET_VERSION}\n`);
    await assert.rejects(
      () => hooks["tool.execute.before"]!(
        { tool: "task", sessionID: "stale-root", callID: "marker-race" },
        { args: { subagent_type: "dog-worker", prompt: readOnlyWorkerPrompt(directory) } },
      ),
      (error: unknown) => isFreshSessionError(
        error, "asset-contract-skew", "user-action-required", "install-assets-then-open-fresh-root",
      ),
    );
    assert.equal(prompts, 0);
    assert.equal(deletes, 1);

    await writeFile(marker, `${RUNTIME_ASSET_VERSION}\n`);
    await assert.rejects(
      () => hooks["tool.execute.before"]!(
        { tool: "task", sessionID: "stale-root", callID: "after-marker-race-repair" },
        { args: { subagent_type: "dog-worker", prompt: readOnlyWorkerPrompt(directory) } },
      ),
      (error: unknown) => {
        assert.ok(isFreshSessionError(error, "asset-contract-skew", "redispatched"));
        assert.ok(error instanceof FreshSessionRequiredError && error.result.status === "redispatched");
        assert.equal(error.result.target_session_id, "raced-root-2");
        return true;
      },
    );
    assert.equal(creates, 2);
    assert.equal(prompts, 1);
    assert.equal(deletes, 1);
  });
});

test("an explicit real build turn clears an in-memory coordinator route", async () => {
  await withProject("coordinator-route-relinquished", async (directory) => {
    const hooks = await SortieDogsPlugin({ directory });
    const chat = hooks["chat.message"]!;
    const before = hooks["tool.execute.before"]!;
    await chat(
      { sessionID: "shared", agent: "dog-coordinator" },
      {
        message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } },
        parts: [{ type: "text", text: "sortie task" }],
      },
    );
    await before(
      { tool: "task", sessionID: "shared", callID: "sortie-worker" },
      { args: { subagent_type: "dog-worker", prompt: readOnlyWorkerPrompt(directory) } },
    );
    await hooks.event!({ event: { type: "session.created", properties: {
      info: { id: "old-child", parentID: "shared", directory },
    } } });
    const buildInput = { sessionID: "shared", agent: "build" };
    const buildOutput = {
      message: { agent: "build", model: { providerID: "host", modelID: "selected" } },
      parts: [{ type: "text", text: "continue directly" }],
    };
    await chat(buildInput, buildOutput);
    assert.equal(buildInput.agent, "build");
    assert.equal(buildOutput.message.agent, "build");

    await before(
      { tool: "task", sessionID: "shared", callID: "generic-sol" },
      { args: { subagent_type: "agent-mk2a2-sol", prompt: "bounded implementation" } },
    );
    await assert.rejects(
      () => chat(
        { sessionID: "old-child", agent: "dog-coordinator" },
        {
          message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } },
          parts: [{ type: "text", text: "promote" }],
        },
      ),
      (error: unknown) => isFreshSessionError(error, "child-lineage", "user-action-required", "open-fresh-root"),
    );
  });
});

test("a dispatched fast-lane worker suppresses legacy terminal compaction", async () => {
  await withProject("single-worker-terminal-marker", async (directory) => {
    const hooks = await SortieDogsPlugin({ directory });
    await hooks["chat.message"]!(
      { sessionID: "root", agent: "dog-coordinator" },
      {
        message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } },
        parts: [{ type: "text", text: "task" }],
      },
    );
    await hooks["tool.execute.before"]!(
      { tool: "task", sessionID: "root", callID: "worker" },
      { args: { subagent_type: "dog-worker", prompt: readOnlyWorkerPrompt(directory) } },
    );
    const system = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!({ sessionID: "root" }, system);
    assert.match(system.system[0]!, /SORTIE_FAST_LANE_TERMINAL/u);
    assert.match(system.system[0]!, /Do not call a compaction capability/u);
    const completed = { text: `terminal\n${ROLLOVER_MARKER}\n${CONTINUATION_MARKER}` };
    await hooks["experimental.text.complete"]!({ sessionID: "root" }, completed);
    assert.equal(completed.text, "terminal");
    await hooks["tool.execute.before"]!(
      { tool: "read", sessionID: "root", callID: "terminal-read" },
      { args: {} },
    );
  });
});

test("a normal lane strips compaction markers but still recovers non-terminal progress", async () => {
  await withProject("normal-lane-progress-recovery", async (directory) => {
    let prompts = 0;
    const report = "📊進行中: 原因確定。\n次: r14で修正し、検証を再実行。";
    const messages: SessionMessage[] = [{
      info: { id: "progress-message", role: "assistant", agent: "dog-coordinator" } as never,
      parts: [{ id: "progress-part", type: "text", text: report } as never],
    }];
    const hooks = await SortieDogsPlugin({ directory, client: { session: {
      get: async () => ({ data: { agent: "dog-coordinator" } }),
      messages: async () => ({ data: messages }),
      promptAsync: async () => { prompts += 1; return { data: true }; },
    } } as never });
    await hooks["chat.message"]!(
      { sessionID: "root", agent: "dog-coordinator" },
      {
        message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } },
        parts: [{ type: "text", text: "task" }],
      },
    );
    const completed = {
      text: `${report}\n${ROLLOVER_MARKER}\n${CONTINUATION_MARKER}`,
    };
    await hooks["experimental.text.complete"]!({ sessionID: "root" }, completed);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await hooks.event!({ event: { type: "message.part.updated", properties: { part: {
      id: "progress-part",
      messageID: "progress-message",
      sessionID: "root",
      type: "text",
      text: report,
      time: { end: Date.now() },
    } } } });
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "root" } } });
    assert.doesNotMatch(completed.text, /SORTIE_(?:COMPACT|CONTINUE)/u);
    assert.equal(prompts, 1);
  });
});

test("a review-only normal lane suppresses legacy terminal compaction", async () => {
  await withProject("review-only-terminal-marker", async (directory) => {
    const hooks = await SortieDogsPlugin({ directory });
    await hooks["chat.message"]!(
      { sessionID: "root", agent: "dog-coordinator" },
      {
        message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } },
        parts: [{ type: "text", text: "review only" }],
      },
    );
    await hooks["tool.execute.before"]!(
      { tool: "task", sessionID: "root", callID: "review" },
      {
        args: {
          subagent_type: "dog-reviewer",
          prompt: "review_phase: initial\ncanonical_validation_exit: 0\nrisk_tags: [public-api, privacy, transaction]",
        },
      },
    );
    const system = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!({ sessionID: "root" }, system);
    assert.match(system.system[0]!, /normal single-unit lane/u);
    const completed = { text: `review PASS\n${ROLLOVER_MARKER}\n${CONTINUATION_MARKER}` };
    await hooks["experimental.text.complete"]!({ sessionID: "root" }, completed);
    assert.equal(completed.text, "review PASS");
  });
});

test("typed backlog opt-in permits continuation only before its first worker", async () => {
  await withProject("backlog-drain-opt-in", async (directory) => {
    const hooks = await SortieDogsPlugin({ directory });
    await hooks["chat.message"]!(
      { sessionID: "root", agent: "dog-coordinator" },
      {
        message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } },
        parts: [{ type: "text", text: "four-unit drain" }],
      },
    );
    const enabled = await hooks.tool!.sortie_enable_backlog_drain!.execute(
      { max_units: "4" },
      { sessionID: "root", agent: "dog-coordinator" },
    );
    assert.deepEqual(JSON.parse(enabled), { status: "enabled", max_units: 4 });
    await hooks["tool.execute.before"]!(
      { tool: "task", sessionID: "root", callID: "worker" },
      { args: { subagent_type: "dog-worker", prompt: readOnlyWorkerPrompt(directory) } },
    );
    await hooks["tool.execute.before"]!(
      { tool: "sortie_compact_and_continue", sessionID: "root", callID: "continue" },
      { args: {} },
    );
    await assert.rejects(
      () => hooks.tool!.sortie_enable_backlog_drain!.execute(
        { max_units: "4" },
        { sessionID: "root", agent: "dog-coordinator" },
      ),
      /SORTIE_FAST_LANE_DENIED: BACKLOG_DRAIN_TOO_LATE/u,
    );
  });
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
  assert.match(dispatch, /^\s*validation:\s*\{ level: full, command: <exact canonical command>, diagnostics: \[<zero or one exact predeclared command>\] \}\s*$/mu);
  assert.match(dispatch, /^\s*validation_history:\s*\[<zero or more \{ command: <exact command>, exit: <exit>, fingerprint: <concise fingerprint> \}>\]\s*$/mu);
  assert.match(dispatch, /^\s*validation_attempts:\s*\{ canonical: <preserved count>, diagnostic: <preserved count> \}\s*$/mu);
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
  assert.equal(isExplicitTaskHandoff([
    "役割: implementation",
    "担当: blocker-resolution",
    "project_root: O:\\candidate",
    "source_manifest: [src/a.ts]",
    "acceptance: safe change",
  ].join("\n")), false);
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
  assert.equal(isExplicitTaskHandoff([
    "role: reviewer",
    "note: implementation",
    "project_root: C:\\candidate",
    "source_manifest: [src/a.ts]",
    "acceptance: safe change",
  ].join("\n")), false);
  assert.equal(isExplicitTaskHandoff([
    "role: implementation",
    "role: blocker-resolution",
    "project_root: C:\\candidate",
    "source_manifest: [src/a.ts]",
    "acceptance: safe change",
  ].join("\n")), false);
  assert.equal(isExplicitTaskHandoff([
    "role: implementation",
    "役割: remediation",
    "project_root: C:\\candidate",
    "source_manifest: [src/a.ts]",
    "acceptance: safe change",
  ].join("\n")), false);
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

test("fresh exact coordinator is ungated while child sessions remain fail-closed", async () => {
  await withProject("coordinator-bootstrap", async (directory) => {
    const identities: Record<string, Record<string, unknown>> = {
      root: { agent: "dog-coordinator" },
      worker: { agent: "dog-worker", parentID: "root" },
      reviewer: { agent: "dog-reviewer", parentID: "root" },
      unrelated: { agent: "build" },
    };
    const hooks = await SortieDogsPlugin({
      directory,
      client: { session: { get: async ({ path }: { path: { id: string } }) => ({ data: identities[path.id] }) } } as never,
    });
    const chat = hooks["chat.message"]!;
    const before = hooks["tool.execute.before"]!;
    await chat(
      { sessionID: "root", agent: "dog-coordinator" },
      { message: { agent: "dog-coordinator", model: {} }, parts: [{ type: "text", text: "/sortie bootstrap" }] },
    );
    const invoke = (tool: string, args: unknown, callID: string, sessionID = "root", agent?: string) => before(
      { tool, sessionID, callID, agent },
      { args },
    );
    const manifestPath = join(directory, "operation-manifest.json");
    const handoffPath = join(directory, "handoff.json");

    for (const [sessionID, agent] of [["worker", "dog-worker"], ["reviewer", "dog-reviewer"], ["unrelated", "build"]]) {
      await assert.rejects(
        invoke("write", { file: manifestPath, content: "not-written" }, `deny-${sessionID}`, sessionID, agent),
        (error: unknown) => error instanceof Error && /operation manifest unavailable/u.test(error.message),
      );
    }
    await invoke("apply_patch", {
      patchText: "*** Begin Patch\n*** Add File: task.operation-manifest.json\n+{}\n*** Add File: handoff.task.json\n+{}\n*** End Patch",
    }, "allow-control-pair");
    await writeFile(join(directory, "task.operation-manifest.json"), "{}");
    await writeFile(join(directory, "handoff.task.json"), "{}");
    await invoke("apply_patch", {
      patchText: "*** Begin Patch\n*** Update File: task.operation-manifest.json\n@@\n-{}\n+{}\n*** Update File: handoff.task.json\n@@\n-{}\n+{}\n*** End Patch",
    }, "repair-control-pair");
    await invoke("powershell", {
      command: `& "M:\\@HyperV\\gh-cli\\bin\\gh.exe" api graphql -f 'query=query { viewer { login } }'`,
    }, "bootstrap-project-query");
    await invoke("bash", {
      command: `& "M:\\@HyperV\\gh-cli\\bin\\gh.exe" api graphql -f 'query=query { viewer { login } }'`,
    }, "bootstrap-project-query-bash");
    await invoke("powershell", {
      command: `& "M:\\@HyperV\\gh-cli\\bin\\gh.exe" version`,
    }, "bootstrap-gh-version");
    await invoke("bash", {
      command: `/opt/gh.exe --version`,
    }, "bootstrap-gh-version-flag");
    await invoke("powershell", {
      command: `$env:GITHUB_TOKEN=$null; $env:GH_TOKEN=$null; & "M:\\@HyperV\\gh-cli\\bin\\gh.exe" auth status`,
    }, "bootstrap-gh-auth-status-with-token-clear");
    await invoke("powershell", {
      command: `& "M:\\@HyperV\\gh-cli\\bin\\gh.exe" version unexpected`,
    }, "bootstrap-gh-version-extra");
    await invoke("powershell", {
      command: `& "M:\\@HyperV\\gh-cli\\bin\\gh.exe" future-command --future-flag`,
    }, "bootstrap-gh-future-command");
    await invoke("sortie_reflection", {
      action: "list",
      layer: "process",
    }, "bootstrap-reflection");
    await invoke("bash", {
      command: `& "M:\\@HyperV\\gh-cli\\bin\\gh.exe" api graphql -f 'query=mutation { placeholder }'`,
    }, "bootstrap-project-mutation-bash");
    await invoke("powershell", {
      command: `$env:GITHUB_TOKEN = $null; $env:GH_TOKEN = $null; & "M:\\@HyperV\\gh-cli\\bin\\gh.exe" api graphql --paginate --slurp -f 'query=mutation { placeholder }'`,
    }, "bootstrap-project-mutation");
    await invoke("powershell", {
      command: `& "M:\\@HyperV\\gh-cli\\bin\\gh.exe" api graphql --field query=@payload.graphql`,
    }, "bootstrap-project-query-file");
    await invoke("powershell", {
      command: `& "M:\\@HyperV\\gh-cli\\bin\\gh.exe" api graphql -f=query=@payload.graphql`,
    }, "bootstrap-project-query-file-equals");
    await invoke("powershell", {
      command: `& "M:\\@HyperV\\gh-cli\\bin\\gh.exe" api graphql -fquery=@payload.graphql`,
    }, "bootstrap-project-query-file-concatenated");
    for (const [tool, args, callID] of [
      ["write", { file: "src/plugin/index.ts", content: "not-written" }, "deny-source"],
      ["write", { content: "not-written" }, "deny-unknown"],
      ["bash", { command: `echo bad > ${manifestPath}` }, "deny-shell"],
      ["apply_patch", { patchText: `*** Begin Patch\n*** Add File: operation-manifest.json\n+{}\n*** Add File: handoff.json\n+{}\n*** Add File: source.ts\n+bad\n*** End Patch` }, "deny-broad-patch"],
    ] as const) {
      await invoke(tool, args, callID);
    }

    await hooks["tool.execute.after"]!(
      { tool: "sortie_check_contract", sessionID: "root", callID: "contract-check" },
      { output: JSON.stringify({ status: "ok", defects: [] }) },
    );
    await invoke("bash", { command: "git status --short" }, "coordinator-finalize");
  });
});

test("fresh exact coordinator remains ungated after malformed control files and idle", async () => {
  await withProject("coordinator-bootstrap-malformed", async (directory) => {
    const hooks = await SortieDogsPlugin({
      directory,
      client: { session: { get: async () => ({ data: { agent: "dog-coordinator" } }) } } as never,
    });
    await hooks["chat.message"]!(
      { sessionID: "root", agent: "dog-coordinator" },
      { message: { agent: "dog-coordinator", model: {} }, parts: [{ type: "text", text: "/sortie bootstrap" }] },
    );
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "root" } } });
    const manifestPath = join(directory, "operation-manifest.json");
    await hooks["tool.execute.before"]!(
      { tool: "write", sessionID: "root", callID: "malformed-manifest", agent: "dog-coordinator" },
      { args: { file: manifestPath, content: "{}" } },
    );
    await writeFile(manifestPath, "{}");
    await hooks["tool.execute.before"]!(
      { tool: "write", sessionID: "root", callID: "handoff-after-malformed", agent: "dog-coordinator" },
      { args: { file: join(directory, "handoff.json"), content: "{}" } },
    );
    await hooks["tool.execute.before"]!(
      { tool: "write", sessionID: "root", callID: "source-after-malformed", agent: "dog-coordinator" },
      { args: { file: join(directory, "source.ts"), content: "bad" } },
    );
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
    await inspectHandoffWithRead(hooks, join(directory, "handoff.json"), "child");
    const resumedBinding = await executeBindWriteGate(hooks, directory, "child");
    assert.equal(resumedBinding.status, "bound");
    assert.equal(resumedBinding.idempotent, true);
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
    assert.deepEqual(await executeReleaseWriteGate(hooks, "recovery-child"), { status: "released" });

    const blockDispatch = [
      "task_id: block-task",
      "role: implementation",
      `project_root: ${directory}`,
      `handoff_path: ${handoffPath}`,
      "source_manifest:",
      "  - allowed.txt",
      "operation_manifest: operation-manifest.json",
      "acceptance:",
      "  - safe change",
      "validation:",
      "  command: npm test",
    ].join("\n");
    await chat(
      { sessionID: "block-child", parentID: "recovery-parent", agent: "dog-worker" },
      { message: { agent: "dog-worker", model: { providerID: "host", modelID: "selected" } },
        parts: [{ type: "text", text: blockDispatch }] },
    );
    await inspectHandoffWithRead(hooks, handoffPath, "block-child");
    const blockBind = await bindWriteGate(hooks, directory, "block-child");
    assert.equal(blockBind.status, "bound", JSON.stringify(blockBind));
    assert.deepEqual(await executeReleaseWriteGate(hooks, "block-child"), { status: "released" });

    for (const [sessionID, roleLines] of [
      ["unknown-role-child", ["role: unknown"]],
      ["duplicate-role-child", ["role: implementation", "role: remediation"]],
      ["mixed-duplicate-role-child", ["role: implementation", "- role: remediation"]],
    ] as const) {
      const invalidDispatch = blockDispatch.replace("role: implementation", roleLines.join("\n"));
      await chat(
        { sessionID, parentID: "recovery-parent", agent: "dog-worker" },
        { message: { agent: "dog-worker", model: { providerID: "host", modelID: "selected" } },
          parts: [{ type: "text", text: invalidDispatch }] },
      );
      await inspectHandoffWithRead(hooks, handoffPath, sessionID);
      assert.equal((await executeBindWriteGate(hooks, directory, sessionID)).reason, "session-inactive");
    }

    for (const [sessionID, invalidDispatch] of [
      ["relative-root-child", blockDispatch.replace(`project_root: ${directory}`, "project_root: .")],
      ["relative-handoff-child", blockDispatch.replace(`handoff_path: ${handoffPath}`, "handoff_path: handoff.json")],
      ["empty-operation-child", blockDispatch.replace(
        "operation_manifest: operation-manifest.json", "operation_manifest:")],
    ] as const) {
      await chat(
        { sessionID, parentID: "recovery-parent", agent: "dog-worker" },
        { message: { agent: "dog-worker", model: { providerID: "host", modelID: "selected" } },
          parts: [{ type: "text", text: invalidDispatch }] },
      );
      await inspectHandoffWithRead(hooks, handoffPath, sessionID);
      assert.equal((await executeBindWriteGate(hooks, directory, sessionID)).reason, "session-inactive");
    }
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

test("a nested candidate accepts the canonical contract directory", async () => {
  await withProject("nested-canonical-contract", async (directory) => {
    const candidateRoot = join(directory, "candidate");
    const contractDirectory = join(candidateRoot, ".sortie-dogs", "contracts");
    await mkdir(contractDirectory, { recursive: true });
    const id = "nested-canonical";
    const manifestRelative = `.sortie-dogs/contracts/${id}.operation-manifest.json`;
    await writeFile(join(candidateRoot, manifestRelative), JSON.stringify({
      ...operationManifest(["allowed.txt"]),
      task_id: id,
    }));
    const handoff = writeGateHandoff(candidateRoot, manifestRelative);
    handoff.id = id;
    const handoffPath = join(contractDirectory, `handoff.${id}.json`);
    await writeFile(handoffPath, JSON.stringify(handoff));

    const hooks = await SortieDogsPlugin({ directory });
    const check = hooks.tool?.sortie_check_contract as unknown as {
      execute(args: { handoff_path: string }, context: { sessionID: string }): Promise<string>;
    } | undefined;
    assert.ok(check);
    assert.deepEqual(
      JSON.parse(await check.execute({ handoff_path: handoffPath }, { sessionID: "nested-root" })),
      { status: "ok", defects: [] },
    );
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

    const malformedCriteria = ["preserve the boundary"];
    const malformedContinuity = writeGateHandoff(directory, "operation-manifest.json") as {
      ext: Record<string, unknown>;
    };
    const malformedLedger = acceptanceContinuity("task-a", malformedCriteria) as { fingerprint: string };
    malformedLedger.fingerprint = `sha256:${"0".repeat(64)}`;
    malformedContinuity.ext[ACCEPTANCE_CONTINUITY_EXTENSION] = malformedLedger;
    await writeFile(handoffPath, JSON.stringify(malformedContinuity));
    assert.deepEqual(await report(handoffPath), {
      status: "defective",
      reason: "contract-invalid",
      defects: ["handoff /ext/sortie-dogs~1acceptance-continuity acceptance_continuity_malformed"],
      remedy: "Repair each reported pointer in the named document, then check it again.",
    });

    await writeFile(handoffPath, JSON.stringify(writeGateHandoff(directory, "operation-manifest.json")));
    assert.deepEqual(await report(handoffPath), { status: "ok", defects: [] });

    const contractDirectory = join(directory, ".sortie-dogs", "contracts");
    await mkdir(contractDirectory, { recursive: true });
    const canonicalID = "canonical-task";
    const canonicalManifest = `.sortie-dogs/contracts/${canonicalID}.operation-manifest.json`;
    await writeFile(join(directory, canonicalManifest), JSON.stringify({
      ...fixture.manifest,
      task_id: canonicalID,
    }));
    const canonicalHandoff = writeGateHandoff(directory, canonicalManifest);
    canonicalHandoff.id = canonicalID;
    const canonicalHandoffPath = join(contractDirectory, `handoff.${canonicalID}.json`);
    await writeFile(canonicalHandoffPath, JSON.stringify(canonicalHandoff));
    assert.deepEqual(await report(canonicalHandoffPath), { status: "ok", defects: [] });

    const hiddenDirectory = join(directory, ".sortie-dogs", "other");
    await mkdir(hiddenDirectory);
    const hiddenHandoffPath = join(hiddenDirectory, `handoff.${canonicalID}.json`);
    await writeFile(hiddenHandoffPath, JSON.stringify(canonicalHandoff));
    assert.deepEqual((await report(hiddenHandoffPath)).defects, ["handoff / handoff_path_not_registered"]);

    const artifactManifest = {
      ...fixture.manifest,
      write: ["temp/artifact/archive.tar.gz", "temp/artifact/extracted"],
      validation: [
        "curl -fL https://example.test/archive.tar.gz -o temp/artifact/archive.tar.gz",
        "tar -xzf temp/artifact/archive.tar.gz -C temp/artifact/extracted",
      ],
    };
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(artifactManifest));
    assert.deepEqual((await report(handoffPath)).defects, [
      "manifest /validation/0 artifact_directory_unprepared",
    ]);
    artifactManifest.validation.unshift("mkdir -p temp/artifact/extracted");
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(artifactManifest));
    assert.deepEqual(await report(handoffPath), { status: "ok", defects: [] });
    const validDownload = artifactManifest.validation[1]!;
    artifactManifest.validation[1] = "curl -fLO https://example.test/archive.tar.gz";
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(artifactManifest));
    assert.deepEqual((await report(handoffPath)).defects, [
      "manifest /validation/1 artifact_command_unclassified",
    ]);
    artifactManifest.validation[1] = validDownload;
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(artifactManifest));

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

test("in-flight authorization retains root lineage while inspection TTL still expires", async () => {
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
      assert.equal((await executeBindWriteGate(hooks, directory, "late-child")).reason, "handoff-uninspected");
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

test("two coordinator threads bind isolated task-scoped handoffs in one project", async () => {
  await withProject("parallel-scoped-handoffs", async (directory) => {
    const contracts = ["thread-a", "thread-b"] as const;
    for (const id of contracts) {
      const manifestPath = `${id}.operation-manifest.json`;
      await writeFile(join(directory, manifestPath), JSON.stringify({
        ...operationManifest([`allowed-${id}.txt`]),
        task_id: id,
      }));
      const handoff = writeGateHandoff(directory, manifestPath);
      handoff.id = id;
      await writeFile(join(directory, `handoff.${id}.json`), JSON.stringify(handoff));
    }
    const hooks = await SortieDogsPlugin({ directory });
    const chat = hooks["chat.message"];
    const event = hooks.event;
    const before = hooks["tool.execute.before"];
    assert.ok(chat);
    assert.ok(event);
    assert.ok(before);

    for (const id of contracts) {
      await chat(
        { sessionID: `root-${id}`, agent: "dog-coordinator" },
        { message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: "ordinary" }] },
      );
      await event({ event: { type: "session.created", properties: { info: { id: `child-${id}`, parentID: `root-${id}`, directory } } } });
      await chat(
        { sessionID: `child-${id}`, agent: "dog-worker" },
        {
          message: { agent: "dog-worker", model: { providerID: "host", modelID: "selected" } },
          parts: [{ type: "text", text: `role=implementation\nproject_root=${directory}\noperation_manifest=${id}.operation-manifest.json\nacceptance=safe change` }],
        },
      );
      await inspectHandoffWithRead(hooks, join(directory, `handoff.${id}.json`), `child-${id}`);
      assert.equal(
        (await executeBindWriteGate(hooks, directory, `child-${id}`, `${id}.operation-manifest.json`)).status,
        "bound",
      );
      await before(
        { tool: "write", sessionID: `child-${id}`, callID: `write-${id}` },
        { args: { file: `allowed-${id}.txt`, content: "not-written" } },
      );
    }

    const changed = writeGateHandoff(directory, "thread-b.operation-manifest.json");
    changed.id = "thread-b";
    changed.task = { title: "Changed B", objective: "Invalidate only thread B." };
    const changedPath = join(directory, "handoff.thread-b.json");
    await writeFile(changedPath, JSON.stringify(changed));
    await event({ event: { type: "file.edited", properties: { file: changedPath } } });

    await before(
      { tool: "write", sessionID: "child-thread-a", callID: "thread-a-still-bound" },
      { args: { file: "allowed-thread-a.txt", content: "not-written" } },
    );
    await expectMessage(
      () => before(
        { tool: "write", sessionID: "child-thread-b", callID: "thread-b-revoked" },
        { args: { file: "allowed.txt", content: "not-written" } },
      ),
      'Write denied for "<unknown>": operation manifest unavailable.',
      "manifest-unavailable",
    );
  });
});

test("a bind waits for its concurrent successful handoff inspection", async () => {
  await withProject("concurrent-handoff-inspection", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    const handoffPath = join(directory, "handoff.json");
    await writeFile(handoffPath, JSON.stringify(writeGateHandoff(directory, "operation-manifest.json")));
    const hooks = await SortieDogsPlugin({ directory });
    await hooks["chat.message"]!(
      { sessionID: "concurrent-root", agent: "dog-coordinator" },
      {
        message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } },
        parts: [{ type: "text", text: "ordinary" }],
      },
    );
    await hooks.event!({
      event: {
        type: "session.created",
        properties: { info: { id: "concurrent-child", parentID: "concurrent-root", directory } },
      },
    });
    await hooks["chat.message"]!(
      { sessionID: "concurrent-child", agent: "dog-worker" },
      {
        message: { agent: "dog-worker", model: { providerID: "host", modelID: "selected" } },
        parts: [{
          type: "text",
          text: `role=implementation\nproject_root=${directory}\noperation_manifest=operation-manifest.json\nacceptance=safe change`,
        }],
      },
    );
    const before = hooks["tool.execute.before"]!;
    const after = hooks["tool.execute.after"]!;
    const args = { filePath: handoffPath };
    await before({ tool: "read", sessionID: "concurrent-child", callID: "concurrent-read" }, { args });
    const inspection = after(
      { tool: "read", sessionID: "concurrent-child", callID: "concurrent-read", args },
      { output: "read" },
    );
    const binding = executeBindWriteGate(hooks, directory, "concurrent-child");
    const [, result] = await Promise.all([inspection, binding]);
    assert.equal(result.status, "bound");
  });
});

test("a task-scoped handoff filename must equal the handoff id", async () => {
  await withProject("scoped-handoff-id-mismatch", async (directory) => {
    await writeFile(join(directory, "thread-a.operation-manifest.json"), JSON.stringify(fixture.manifest));
    const handoff = writeGateHandoff(directory, "thread-a.operation-manifest.json");
    handoff.id = "thread-b";
    const handoffPath = join(directory, "handoff.thread-a.json");
    await writeFile(handoffPath, JSON.stringify(handoff));
    const hooks = await SortieDogsPlugin({ directory });
    const check = hooks.tool?.sortie_check_contract as unknown as {
      execute(args: { handoff_path: string }, context: { sessionID: string }): Promise<string>;
    };
    const result = JSON.parse(await check.execute(
      { handoff_path: handoffPath },
      { sessionID: "preflight" },
    ));
    assert.deepEqual(result.defects, ["handoff /id handoff_path_scope_mismatch"]);
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
        messages: async ({ path }: { path: { id: string } }) => ({ data: path.id === "host-root" ? [{
          info: { role: "user", agent: "dog-coordinator" },
          parts: [{ type: "text", text: "continue" }],
        }] : [] }),
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

test("cold CLI coordinator recovers before parallel dispatch gating", async () => {
  await withProject("cold-cli-coordinator-recovery", async (directory) => {
    let historyReads = 0;
    const hooks = await SortieDogsPlugin({ directory, client: { session: {
      get: async () => ({ data: { agent: "dog-coordinator" } }),
      messages: async () => {
        historyReads += 1;
        if (historyReads > 1) throw new Error("history read repeated");
        return { data: [] };
      },
    } } as never });
    historyReads = 0;

    await hooks["tool.execute.before"]!(
      { tool: "sortie_prepare_parallel_dispatch", sessionID: "cold-root", callID: "cold-dispatch" },
      { args: { contract_path: join(directory, "parallel-contract.json") } },
    );
    assert.equal(historyReads, 1);

    const denied = async (client: unknown, sessionID: string) => {
      await writeFile(join(directory, "operation-manifest.json"), "{}");
      const deniedHooks = await SortieDogsPlugin({ directory, client: client as never });
      await deniedHooks["chat.message"]!(
        { sessionID, agent: "build" },
        { message: { agent: "build", model: {} }, parts: [{ type: "text", text: "/sortie task" }] },
      );
      await assert.rejects(
        () => deniedHooks["tool.execute.before"]!(
          { tool: "sortie_prepare_parallel_dispatch", sessionID, callID: `denied-${sessionID}` },
          { args: { contract_path: join(directory, "parallel-contract.json") } },
        ),
        /operation manifest unavailable/u,
      );
    };
    await denied({ session: {
      get: async () => ({ data: { agent: "dog-coordinator" } }),
      messages: async () => { throw new Error("unavailable"); },
    } }, "unreadable-history");
    await denied({ session: {
      get: async () => ({ data: undefined }),
      messages: async () => ({ data: [] }),
    } }, "undefined-identity");
    await denied({ session: {
      get: async () => ({ data: { agent: "dog-coordinator" } }),
      messages: async () => ({ data: [{}] }),
    } }, "malformed-history");
  });
});

test("a restarted plugin does not recover a coordinator over a foreign host root", async () => {
  await withProject("lineage-command-restart", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    const handoffPath = join(directory, "handoff.json");
    await writeFile(handoffPath, JSON.stringify(writeGateHandoff(directory, "operation-manifest.json")));
    const identities: Record<string, { agent: string; parentID?: string }> = {
      root: { agent: "build" },
      child: { agent: "dog-worker", parentID: "root" },
    };
    const messages: Record<string, SessionMessage[]> = {
      root: [{
        info: { role: "user", agent: "dog-coordinator" },
        parts: [{ type: "text", text: "continue after restart" }],
      }],
      child: [],
    };
    const hooks = await SortieDogsPlugin({ directory, client: { session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: identities[path.id] }),
      messages: async ({ path }: { path: { id: string } }) => ({ data: messages[path.id] }),
    } } as never });
    const prompt = [
      `project_root: ${directory}`,
      `handoff_path: ${handoffPath}`,
      "acceptance: safe change",
      "role: implementation",
      "source_manifest: [allowed.txt]",
      "operation_manifest: operation-manifest.json",
      "validation: npm test",
    ].join("\n");

    await hooks["tool.execute.before"]!(
      { tool: "task", sessionID: "root", callID: "restarted-task" },
      { args: { subagent_type: "dog-worker", prompt } },
    );
    await hooks.event!({ event: { type: "session.created", properties: { info: { id: "child", parentID: "root", directory } } } });
    await hooks["chat.message"]!(
      { sessionID: "child", agent: "dog-worker", parentID: "root" } as never,
      {
        message: { agent: "dog-worker", model: { providerID: "host", modelID: "selected" } },
        parts: [{ type: "text", text: prompt }],
      },
    );
    await inspectHandoffWithRead(hooks, handoffPath, "child");
    assert.deepEqual(await executeBindWriteGate(hooks, directory, "child"), {
      status: "denied",
      reason: "session-inactive",
      recoverable: true,
      remedy: "Freshly redispatch this worker with prompt text containing role, project_root, source_manifest or operation_manifest, and acceptance or validation fields; a bare resume or file read cannot activate the session.",
      escalation: { action: "redispatch-worker", resume_session: false, true_blocker: false },
    });
  });
});

test("serial handoff accepts a unit label when group is none and count is one", async () => {
  await withProject("serial-unit-label", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    const handoffPath = join(directory, "handoff.json");
    await writeFile(handoffPath, JSON.stringify(writeGateHandoff(directory, "operation-manifest.json")));
    const hooks = await SortieDogsPlugin({ directory });
    await hooks["chat.message"]!(
      { sessionID: "root", agent: "dog-coordinator" },
      {
        message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } },
        parts: [{ type: "text", text: "dispatch" }],
      },
    );
    await hooks.event!({ event: { type: "session.created", properties: { info: { id: "child", parentID: "root", directory } } } });
    const prompt = [
      `project_root: ${directory}`,
      "acceptance: safe change",
      "role: implementation",
      "operation_manifest: operation-manifest.json",
      "parallel_group: none",
      "parallel_unit: serial-task-id",
      "parallel_units: 1",
    ].join("\n");
    await hooks["chat.message"]!(
      { sessionID: "child", agent: "dog-worker", parentID: "root" } as never,
      {
        message: { agent: "dog-worker", model: { providerID: "host", modelID: "selected" } },
        parts: [{ type: "text", text: prompt }],
      },
    );
    await inspectHandoffWithRead(hooks, handoffPath, "child");
    assert.equal((await executeBindWriteGate(hooks, directory, "child")).status, "bound");
  });
});

test("restart recovery ignores a stale coordinator route and a cold synthetic turn", async () => {
  await withProject("lineage-command-restart-denied", async (directory) => {
    const identities = { root: { agent: "build" } };
    const plugin = async (agent: string, synthetic: boolean) => await SortieDogsPlugin({
      directory,
      client: { session: {
        get: async () => ({ data: identities.root }),
        messages: async () => ({ data: [{
          info: { role: "user", agent },
          parts: [{ type: "text", text: "resume", ...(synthetic ? { synthetic: true } : {}) }],
        }] }),
      } } as never,
    });
    const dispatch = async (hooks: Awaited<ReturnType<typeof SortieDogsPlugin>>, callID: string) =>
      await hooks["tool.execute.before"]!(
        { tool: "task", sessionID: "root", callID },
        { args: { subagent_type: "dog-worker", prompt: readOnlyWorkerPrompt(directory) } },
      );

    await dispatch(await plugin("build", false), "stale-route");
    const synthetic = await plugin("dog-coordinator", true);
    await dispatch(synthetic, "synthetic-route");

    const staleDedicated = await SortieDogsPlugin({ directory, client: { session: {
      get: async () => ({ data: { agent: "dog-coordinator" } }),
      messages: async () => ({ data: [{
        info: { role: "user", agent: "build" },
        parts: [{ type: "text", text: "switched agent" }],
      }] }),
    } } as never });
    await dispatch(staleDedicated, "dedicated-stale-one");
    await dispatch(staleDedicated, "dedicated-stale-two");

    const unreadableHistory = await SortieDogsPlugin({ directory, client: { session: {
      get: async () => ({ data: { agent: "dog-coordinator" } }),
      messages: async () => { throw new Error("unavailable"); },
    } } as never });
    await dispatch(unreadableHistory, "unreadable-one");
    await dispatch(unreadableHistory, "unreadable-two");
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

test("parallel worker bindings allow disjoint scopes and reject equal or ancestor scopes", async () => {
  await withProject("parallel-write-scopes", async (directory) => {
    await mkdir(join(directory, "src"));
    const contracts = [
      { id: "unit-a", write: ["src/a.ts"] },
      { id: "unit-b", write: ["src/b.ts"] },
      { id: "unit-equal", write: ["src/a.ts"] },
      { id: "unit-case", write: ["src/A.ts"] },
      { id: "unit-ancestor", write: ["src"] },
      { id: "unit-reader", write: ["src/c.ts"], read: ["src/a.ts"] },
      { id: "unit-segment", write: ["src/a.tsx"], validation: ["npm test"] },
      { id: "unit-invalid", write: ["src/invalid.ts"] },
      { id: "unit-serial", write: ["src/serial.ts"] },
    ] as const;
    const hooks = await SortieDogsPlugin({ directory });
    const chat = hooks["chat.message"];
    const event = hooks.event;
    assert.ok(chat);
    assert.ok(event);
    await chat(
      { sessionID: "parallel-root", agent: "dog-coordinator" },
      { message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: "ordinary" }] },
    );
    for (const contract of contracts) {
      const { id, write } = contract;
      const manifestPath = `${id}.operation-manifest.json`;
      const handoffPath = join(directory, `handoff.${id}.json`);
      await writeFile(join(directory, manifestPath), JSON.stringify({
        ...operationManifest([...write]),
        task_id: id,
        read: "read" in contract ? [...contract.read] : [],
        validation: "validation" in contract ? [...contract.validation] : [],
      }));
      await writeFile(handoffPath, JSON.stringify({
        ...writeGateHandoff(directory, manifestPath),
        id,
      }));
      await event({ event: { type: "session.created", properties: { info: { id, parentID: "parallel-root", directory } } } });
      const parallelFields = id === "unit-invalid"
        ? "parallel_group=group-one"
        : id === "unit-serial"
        ? "parallel_group=none\nparallel_unit=none\nparallel_units=1"
        : `parallel_group=group-one\nparallel_unit=${id}\nparallel_units=3`;
      await chat(
        { sessionID: id, agent: "dog-worker" },
        {
          message: { agent: "dog-worker", model: { providerID: "host", modelID: "selected" } },
          parts: [{
            type: "text",
            text: `role=implementation\nproject_root=${directory}\noperation_manifest=${manifestPath}\nacceptance=safe parallel unit\n${parallelFields}`,
          }],
        },
      );
      await inspectHandoffWithRead(hooks, handoffPath, id);
    }

    const before = hooks["tool.execute.before"];
    const after = hooks["tool.execute.after"];
    assert.ok(before);
    assert.ok(after);
    await expectMessage(
      () => before(
        { tool: "bash", sessionID: "unit-segment", callID: "unbound-parallel-graphql" },
        { args: { command: "gh api graphql --input mutation.json" } },
      ),
      'Write denied for "<parallel-unit>": parallel implementation workers cannot mutate shared remote state.',
      "parallel-remote-mutation",
    );
    assert.equal((await executeBindWriteGate(hooks, directory, "unit-a", "unit-a.operation-manifest.json")).status, "bound");
    assert.equal((await executeBindWriteGate(hooks, directory, "unit-b", "unit-b.operation-manifest.json")).status, "bound");
    assert.equal((await executeBindWriteGate(hooks, directory, "unit-segment", "unit-segment.operation-manifest.json")).status, "bound");
    assert.equal((await executeBindWriteGate(hooks, directory, "unit-serial", "unit-serial.operation-manifest.json")).status, "bound");
    await before(
      { tool: "read", sessionID: "unit-b", callID: "failed-read" },
      { args: { filePath: join(directory, "missing.ts") } },
    );
    await event({ event: { type: "message.part.updated", properties: { part: {
      type: "tool", sessionID: "unit-b", callID: "failed-read", state: { status: "error" },
    } } } });
    assert.deepEqual(await executeReleaseWriteGate(hooks, "unit-b"), { status: "released" });
    await expectMessage(
      () => before(
        { tool: "bash", sessionID: "unit-segment", callID: "parallel-validation" },
        { args: { command: "npm test" } },
      ),
      'Write denied for "<parallel-unit>": parallel implementation validation must run after the worker join.',
      "parallel-validation",
    );
    await expectMessage(
      () => before(
        { tool: "bash", sessionID: "unit-segment", callID: "parallel-git-add" },
        { args: { command: "git add -- src/a.tsx" } },
      ),
      'Write denied for "<parallel-unit>": parallel implementation workers cannot mutate shared Git state.',
      "parallel-git-mutation",
    );
    await expectMessage(
      () => before(
        { tool: "powershell", sessionID: "unit-segment", callID: "parallel-project-edit" },
        { args: { command: "gh project item-edit --id item --project-id project --field-id field --single-select-option-id option" } },
      ),
      'Write denied for "<parallel-unit>": parallel implementation workers cannot mutate shared remote state.',
      "parallel-remote-mutation",
    );
    await expectMessage(
      () => before(
        { tool: "bash", sessionID: "unit-segment", callID: "parallel-graphql-mutation" },
        { args: { command: "gh api graphql -f 'query=mutation($id:ID!){deleteProjectV2(input:{projectV2Id:$id}){projectV2{id}}}'" } },
      ),
      'Write denied for "<parallel-unit>": parallel implementation workers cannot mutate shared remote state.',
      "parallel-remote-mutation",
    );
    const deniedUnits = ["unit-equal", "unit-ancestor", "unit-reader"];
    if (process.platform === "win32") deniedUnits.push("unit-case");
    for (const id of deniedUnits) {
      const denied = await executeBindWriteGate(hooks, directory, id, `${id}.operation-manifest.json`);
      assert.equal(denied.reason, "manifest-overlap");
      assert.equal(denied.recoverable, true);
      assert.deepEqual(denied.defects, ["manifest /write parallel_write_scope_overlap"]);
      assert.deepEqual(denied.escalation, {
        action: "blocker-resolution-takeover",
        resume_session: true,
        true_blocker: false,
      });
    }
    const invalidParallel = await executeBindWriteGate(
      hooks,
      directory,
      "unit-invalid",
      "unit-invalid.operation-manifest.json",
    );
    assert.equal(invalidParallel.reason, "parallel-contract-invalid");
    assert.equal(invalidParallel.recoverable, false);

    const inFlightInput = { tool: "write", sessionID: "unit-a", callID: "in-flight-write",
      args: { file: join(directory, "src", "a.ts"), content: "not-written" } };
    await before(inFlightInput, { args: inFlightInput.args });
    const originalNow = Date.now;
    let now = Date.now();
    Date.now = () => now;
    try {
      now += 31 * 60 * 1000;
      const lateID = "unit-late";
      const equalManifest = `${lateID}.operation-manifest.json`;
      await writeFile(join(directory, equalManifest), JSON.stringify({
        ...operationManifest(["src/a.ts"]),
        task_id: lateID,
        validation: [],
      }));
      await writeFile(join(directory, `handoff.${lateID}.json`), JSON.stringify({
        ...writeGateHandoff(directory, equalManifest),
        id: lateID,
      }));
      await chat(
        { sessionID: lateID, agent: "dog-worker" },
        {
          message: { agent: "dog-worker", model: { providerID: "host", modelID: "selected" } },
          parts: [{ type: "text", text: `/sortie\nrole=implementation\nproject_root=${directory}\noperation_manifest=${equalManifest}\nacceptance=safe parallel unit\nparallel_group=group-one\nparallel_unit=${lateID}\nparallel_units=3` }],
        },
      );
      await inspectHandoffWithRead(hooks, join(directory, `handoff.${lateID}.json`), lateID);
      const longRunningConflict = await executeBindWriteGate(hooks, directory, lateID, equalManifest);
      assert.equal(longRunningConflict.reason, "manifest-overlap");
    } finally {
      Date.now = originalNow;
    }
    assert.deepEqual(await executeReleaseWriteGate(hooks, "unit-a"), { status: "denied", reason: "tools-in-flight" });
    await after(inFlightInput, { output: "not-written" });
    assert.deepEqual(await executeReleaseWriteGate(hooks, "unit-a"), { status: "released" });
    assert.deepEqual(await executeReleaseWriteGate(hooks, "unit-a"), { status: "released", idempotent: true });
    await expectMessage(
      () => before(
        { tool: "read", sessionID: "unit-a", callID: "released-source-read" },
        { args: { filePath: join(directory, "src", "a.ts") } },
      ),
      'Write denied for "<released-session>": released session must re-read only its handoff and bind before further work.',
      "session-released",
    );
    assert.equal(
      (await executeBindWriteGate(hooks, directory, "unit-a", "unit-a.operation-manifest.json")).reason,
      "handoff-uninspected",
    );
    await activate(hooks, "unit-equal");
    await inspectHandoffWithRead(hooks, join(directory, "handoff.unit-equal.json"), "unit-equal");
    assert.equal((await executeBindWriteGate(hooks, directory, "unit-equal", "unit-equal.operation-manifest.json")).status, "bound");
    await inspectHandoffWithRead(hooks, join(directory, "handoff.unit-a.json"), "unit-a");
    const blockedResume = await executeBindWriteGate(hooks, directory, "unit-a", "unit-a.operation-manifest.json");
    assert.equal(blockedResume.reason, "manifest-overlap");
    await executeReleaseWriteGate(hooks, "unit-equal");
    const resumed = await executeBindWriteGate(hooks, directory, "unit-a", "unit-a.operation-manifest.json");
    assert.equal(resumed.status, "bound");
    assert.equal(resumed.idempotent, true);
  });
});

test("competing parallel binds atomically grant one overlapping scope", async () => {
  await withProject("parallel-write-atomic", async (directory) => {
    const hooks = await SortieDogsPlugin({ directory });
    const chat = hooks["chat.message"];
    const event = hooks.event;
    assert.ok(chat);
    assert.ok(event);
    await chat(
      { sessionID: "atomic-root", agent: "dog-coordinator" },
      { message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: "ordinary" }] },
    );
    for (const id of ["unit-one", "unit-two"]) {
      const manifestPath = `${id}.operation-manifest.json`;
      const handoffPath = join(directory, `handoff.${id}.json`);
      await writeFile(join(directory, manifestPath), JSON.stringify({
        ...operationManifest(["shared.ts"]),
        task_id: id,
      }));
      await writeFile(handoffPath, JSON.stringify({
        ...writeGateHandoff(directory, manifestPath),
        id,
      }));
      await event({ event: { type: "session.created", properties: { info: { id, parentID: "atomic-root", directory } } } });
      await chat(
        { sessionID: id, agent: "dog-worker" },
        {
          message: { agent: "dog-worker", model: { providerID: "host", modelID: "selected" } },
          parts: [{ type: "text", text: `role=implementation\nproject_root=${directory}\noperation_manifest=${manifestPath}\nacceptance=safe parallel unit\nparallel_group=atomic-group\nparallel_unit=${id}\nparallel_units=2` }],
        },
      );
      await inspectHandoffWithRead(hooks, handoffPath, id);
    }
    const results = await Promise.all([
      executeBindWriteGate(hooks, directory, "unit-one", "unit-one.operation-manifest.json"),
      executeBindWriteGate(hooks, directory, "unit-two", "unit-two.operation-manifest.json"),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), ["bound", "denied"]);
    assert.deepEqual(
      results.filter((result) => result.status === "denied").map((result) => result.reason),
      ["manifest-overlap"],
    );
  });
});

test("separate plugin instances share the Git scope lease and release authority", async () => {
  await withProject("parallel-write-cross-instance", async (directory) => {
    await rm(join(directory, ".git"), { recursive: true });
    const commonGit = join(directory, ".git-common");
    const worktreeGit = join(commonGit, "worktrees", "candidate");
    await mkdir(worktreeGit, { recursive: true });
    await writeFile(join(directory, ".git"), `gitdir: ${worktreeGit}\n`);
    await writeFile(join(worktreeGit, "commondir"), "../..\n");
    const instances = await Promise.all([
      SortieDogsPlugin({ directory }),
      SortieDogsPlugin({ directory }),
    ]);
    const sessions = ["cross-instance-one", "cross-instance-two"];
    for (let index = 0; index < instances.length; index += 1) {
      const hooks = instances[index]!;
      const sessionID = sessions[index]!;
      const manifestPath = `${sessionID}.operation-manifest.json`;
      const handoffPath = join(directory, `handoff.${sessionID}.json`);
      await writeFile(join(directory, manifestPath), JSON.stringify({
        ...operationManifest(["shared-cross-instance.ts"]),
        task_id: sessionID,
      }));
      await writeFile(handoffPath, JSON.stringify({
        ...writeGateHandoff(directory, manifestPath),
        id: sessionID,
      }));
      await hooks["chat.message"]!(
        { sessionID, agent: "dog-worker" },
        {
          message: { agent: "dog-worker", model: { providerID: "host", modelID: "selected" } },
          parts: [{
            type: "text",
            text: `/sortie\nrole=implementation\nproject_root=${directory}\noperation_manifest=${manifestPath}\nacceptance=safe parallel unit\nparallel_group=cross-instance\nparallel_unit=${sessionID}\nparallel_units=2`,
          }],
        },
      );
      await inspectHandoffWithRead(hooks, handoffPath, sessionID);
    }

    const first = await executeBindWriteGate(
      instances[0]!, directory, sessions[0]!, `${sessions[0]}.operation-manifest.json`,
    );
    const blocked = await executeBindWriteGate(
      instances[1]!, directory, sessions[1]!, `${sessions[1]}.operation-manifest.json`,
    );
    assert.equal(first.status, "bound");
    assert.equal(blocked.reason, "manifest-overlap");
    const registry = await readFile(
      join(commonGit, "sortie-dogs", "scope-leases", "scope-leases.json"),
      "utf8",
    );
    assert.equal(registry.includes(sessions[0]!), false);
    assert.equal(registry.includes(sessions[1]!), false);
    assert.deepEqual(await executeReleaseWriteGate(instances[0]!, sessions[0]!), { status: "released" });
    assert.equal((await executeBindWriteGate(
      instances[1]!, directory, sessions[1]!, `${sessions[1]}.operation-manifest.json`,
    )).status, "bound");
    await executeReleaseWriteGate(instances[1]!, sessions[1]!);
  });
});

test("transient durable release failure denies release and retains authority for retry", async () => {
  await withProject("parallel-write-release-contention", async (directory) => {
    const hooks = await SortieDogsPlugin({ directory });
    const sessionID = "release-contention";
    const manifestPath = `${sessionID}.operation-manifest.json`;
    const handoffPath = join(directory, `handoff.${sessionID}.json`);
    await writeFile(join(directory, manifestPath), JSON.stringify({
      ...operationManifest(["release-contention.ts"]),
      task_id: sessionID,
    }));
    await writeFile(handoffPath, JSON.stringify({
      ...writeGateHandoff(directory, manifestPath),
      id: sessionID,
    }));
    await hooks["chat.message"]!(
      { sessionID, agent: "dog-worker" },
      {
        message: { agent: "dog-worker", model: { providerID: "host", modelID: "selected" } },
        parts: [{
          type: "text",
          text: `/sortie\nrole=implementation\nproject_root=${directory}\noperation_manifest=${manifestPath}\nacceptance=safe parallel unit\nparallel_group=release-group\nparallel_unit=${sessionID}\nparallel_units=2`,
        }],
      },
    );
    await inspectHandoffWithRead(hooks, handoffPath, sessionID);
    assert.equal((await executeBindWriteGate(hooks, directory, sessionID, manifestPath)).status, "bound");

    const scopeRoot = join(directory, ".git", "sortie-dogs", "scope-leases");
    const lock = join(scopeRoot, ".scope-leases.lock");
    const blocker = "00000000-0000-4000-8000-000000000003";
    await mkdir(lock);
    await writeFile(join(lock, `owner.${blocker}`), blocker);
    assert.deepEqual(await executeReleaseWriteGate(hooks, sessionID), {
      status: "denied",
      reason: "durable-scope-unavailable",
    });
    const assertedUnderContention = await executeBindWriteGate(hooks, directory, sessionID, manifestPath);
    assert.equal(assertedUnderContention.reason, "durable-scope-unavailable");
    const heldState = JSON.parse(await readFile(join(scopeRoot, "scope-leases.json"), "utf8")) as {
      leases: unknown[];
    };
    assert.equal(heldState.leases.length, 1);

    await rm(lock, { recursive: true });
    const rebound = await executeBindWriteGate(hooks, directory, sessionID, manifestPath);
    assert.equal(rebound.status, "bound");
    assert.equal(rebound.idempotent, true);
    await hooks["tool.execute.before"]!(
      { tool: "write", sessionID, callID: "retained-authority" },
      { args: { file: join(directory, "release-contention.ts"), content: "not-written" } },
    );
    await hooks["tool.execute.after"]!(
      { tool: "write", sessionID, callID: "retained-authority" },
      { output: "not-written" },
    );
    assert.deepEqual(await executeReleaseWriteGate(hooks, sessionID), { status: "released" });
  });
});

test("session idle detaches after transient durable release failure and permits TTL reclaim", async () => {
  await withProject("parallel-write-idle-release-contention", async (directory) => {
    const first = await SortieDogsPlugin({ directory });
    const second = await SortieDogsPlugin({ directory });
    const sessions = ["idle-contention-owner", "idle-contention-replacement"];
    for (const [index, hooks] of [first, second].entries()) {
      const sessionID = sessions[index]!;
      const manifestPath = `${sessionID}.operation-manifest.json`;
      const handoffPath = join(directory, `handoff.${sessionID}.json`);
      await writeFile(join(directory, manifestPath), JSON.stringify({
        ...operationManifest(["idle-contention.ts"]),
        task_id: sessionID,
      }));
      await writeFile(handoffPath, JSON.stringify({
        ...writeGateHandoff(directory, manifestPath),
        id: sessionID,
      }));
      await hooks["chat.message"]!(
        { sessionID, agent: "dog-worker" },
        {
          message: { agent: "dog-worker", model: { providerID: "host", modelID: "selected" } },
          parts: [{
            type: "text",
            text: `/sortie\nrole=implementation\nproject_root=${directory}\noperation_manifest=${manifestPath}\nacceptance=safe parallel unit\nparallel_group=idle-contention\nparallel_unit=${sessionID}\nparallel_units=2`,
          }],
        },
      );
      await inspectHandoffWithRead(hooks, handoffPath, sessionID);
    }
    assert.equal((await executeBindWriteGate(
      first,
      directory,
      sessions[0]!,
      `${sessions[0]}.operation-manifest.json`,
    )).status, "bound");

    const scopeRoot = join(directory, ".git", "sortie-dogs", "scope-leases");
    const statePath = join(scopeRoot, "scope-leases.json");
    const lock = join(scopeRoot, ".scope-leases.lock");
    const blocker = "00000000-0000-4000-8000-000000000005";
    await mkdir(lock);
    await writeFile(join(lock, `owner.${blocker}`), blocker);
    await first.event!({ event: { type: "session.idle", properties: { sessionID: sessions[0] } } });

    const retained = JSON.parse(await readFile(statePath, "utf8")) as {
      leases: Array<{ heartbeatAt: number; expiresAt: number }>;
    };
    assert.equal(retained.leases.length, 1);
    await rm(lock, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const unchanged = JSON.parse(await readFile(statePath, "utf8")) as typeof retained;
    assert.deepEqual(unchanged.leases, retained.leases);

    const originalNow = Date.now;
    Date.now = () => retained.leases[0]!.expiresAt + 1;
    try {
      assert.equal((await executeBindWriteGate(
        second,
        directory,
        sessions[1]!,
        `${sessions[1]}.operation-manifest.json`,
      )).status, "bound");
    } finally {
      Date.now = originalNow;
    }
    await executeReleaseWriteGate(second, sessions[1]!);
  });
});

test("same-session bind and release operations are serialized", async () => {
  await withProject("binding-operation-serialization", async (directory) => {
    const id = "serialized";
    const manifestPath = `${id}.operation-manifest.json`;
    const handoffPath = join(directory, `handoff.${id}.json`);
    await writeFile(join(directory, manifestPath), JSON.stringify({
      ...operationManifest(["serialized.ts"]),
      task_id: id,
    }));
    await writeFile(handoffPath, JSON.stringify({
      ...writeGateHandoff(directory, manifestPath),
      id,
    }));
    const hooks = await SortieDogsPlugin({ directory });
    await activate(hooks, id);
    await inspectHandoffWithRead(hooks, handoffPath, id);
    const concurrent = await Promise.all([
      executeBindWriteGate(hooks, directory, id, manifestPath),
      executeBindWriteGate(hooks, directory, id, manifestPath),
      executeReleaseWriteGate(hooks, id),
    ]);
    assert.equal(concurrent.filter((result) => result.status === "bound").length, 1);
    assert.ok(concurrent.some((result) => result.reason === "binding-in-flight"));
    assert.equal((await executeBindWriteGate(hooks, directory, id, manifestPath)).status, "bound");
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

test("session idle releases a valid binding when parent Task completion is unavailable", async () => {
  await withProject("idle-release", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    const handoffPath = join(directory, "handoff.json");
    await writeFile(handoffPath, JSON.stringify(writeGateHandoff(directory, "operation-manifest.json")));
    const hooks = await SortieDogsPlugin({ directory });
    await activate(hooks, "idle-release");
    await inspectHandoffWithRead(hooks, handoffPath, "idle-release");
    assert.equal((await executeBindWriteGate(hooks, directory, "idle-release")).status, "bound");
    const event = hooks.event;
    const before = hooks["tool.execute.before"];
    assert.ok(event);
    assert.ok(before);
    await event({ event: { type: "session.idle", properties: { sessionID: "idle-release" } } });
    await expectMessage(
      () => before(
        { tool: "write", sessionID: "idle-release", callID: "released-write" },
        { args: { file: "allowed.txt", content: "not-written" } },
      ),
      'Write denied for "<released-session>": released session must re-read only its handoff and bind before further work.',
      "session-released",
    );
    await inspectHandoffWithRead(hooks, handoffPath, "idle-release");
    const resumed = await executeBindWriteGate(hooks, directory, "idle-release");
    assert.equal(resumed.status, "bound");
    assert.equal(resumed.idempotent, true);
  });
});

test("child idle retains authorization only while its parent Task call is in flight", async () => {
  await withProject("task-in-flight-idle", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    const handoffPath = join(directory, "handoff.json");
    await writeFile(handoffPath, JSON.stringify(writeGateHandoff(directory, "operation-manifest.json")));
    const hooks = await SortieDogsPlugin({ directory });
    await beginTrackedTaskChild(hooks, directory, "parent", "child", "task-call");
    await inspectHandoffWithRead(hooks, handoffPath, "child");
    assert.equal((await executeBindWriteGate(hooks, directory, "child")).status, "bound");

    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "child" } } });
    await hooks["tool.execute.before"]!(
      { tool: "write", sessionID: "child", callID: "held-write" },
      { args: { file: "allowed.txt", content: "not-written" } },
    );

    await hooks["tool.execute.after"]!(
      { tool: "task", sessionID: "parent", callID: "task-call" },
      { output: "<task><task_result>done</task_result></task>", metadata: { sessionId: "child" } },
    );
    await activate(hooks, "child");
    await expectMessage(
      () => hooks["tool.execute.before"]!(
        { tool: "write", sessionID: "child", callID: "completed-write" },
        { args: { file: "allowed.txt", content: "not-written" } },
      ),
      'Write denied for "<unknown>": operation manifest unavailable.',
      "manifest-unavailable",
    );
  });
});

test("an unrelated consultation Task cannot retain worker authorization", async () => {
  await withProject("task-lineage-isolation", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    const handoffPath = join(directory, "handoff.json");
    await writeFile(handoffPath, JSON.stringify(writeGateHandoff(directory, "operation-manifest.json")));
    const hooks = await SortieDogsPlugin({ directory });
    await beginTrackedTaskChild(hooks, directory, "parent", "child", "worker-call");
    await inspectHandoffWithRead(hooks, handoffPath, "child");
    assert.equal((await executeBindWriteGate(hooks, directory, "child")).status, "bound");

    await hooks["tool.execute.before"]!(
      { tool: "task", sessionID: "parent", callID: "review-call" },
      {
        args: {
          subagent_type: "dog-reviewer",
          prompt: "review_phase: initial\ncanonical_validation_exit: 0\nrisk_tags: [write-gate]",
        },
      },
    );
    await hooks["tool.execute.after"]!(
      { tool: "task", sessionID: "parent", callID: "worker-call" },
      { output: "<task><task_result>done</task_result></task>" },
    );
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "child" } } });

    await expectMessage(
      () => hooks["tool.execute.before"]!(
        { tool: "write", sessionID: "child", callID: "unrelated-task-write" },
        { args: { file: "allowed.txt", content: "not-written" } },
      ),
      'Write denied for "<released-session>": released session must re-read only its handoff and bind before further work.',
      "session-released",
    );
  });
});

test("parent idle evicts authorization left by an interrupted Task call", async () => {
  await withProject("task-interrupted-idle", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    const handoffPath = join(directory, "handoff.json");
    await writeFile(handoffPath, JSON.stringify(writeGateHandoff(directory, "operation-manifest.json")));
    const hooks = await SortieDogsPlugin({ directory });
    await beginTrackedTaskChild(hooks, directory, "parent", "child", "task-call");
    await inspectHandoffWithRead(hooks, handoffPath, "child");
    assert.equal((await executeBindWriteGate(hooks, directory, "child")).status, "bound");
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "child" } } });

    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "parent" } } });
    await activate(hooks, "child");
    await expectMessage(
      () => hooks["tool.execute.before"]!(
        { tool: "write", sessionID: "child", callID: "interrupted-write" },
        { args: { file: "allowed.txt", content: "not-written" } },
      ),
      'Write denied for "<unknown>": operation manifest unavailable.',
      "manifest-unavailable",
    );
  });
});

test("root task watchdog aborts and resumes the same coordinator once when after and idle are absent", async () => {
  await withProject("task-watchdog-recovery", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    await writeFile(join(directory, "handoff.json"), JSON.stringify(writeGateHandoff(directory, "operation-manifest.json")));
    const aborts: string[] = [];
    const prompts: Array<{ id: string; text: string }> = [];
    const hooks = await SortieDogsPlugin({
      directory,
      client: {
        session: {
          abort: async ({ path }) => { aborts.push(path.id); return true; },
          promptAsync: async ({ path, body }) => {
            prompts.push({ id: path.id, text: body.parts[0]!.text });
            return true;
          },
        },
      },
    }, { continuation: { taskWatchdogMilliseconds: 20 } });
    await beginTrackedTaskChild(hooks, directory, "watchdog-root", "watchdog-child", "watchdog-call");

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(aborts, ["watchdog-root"]);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0]!.id, "watchdog-root");
    assert.ok(prompts[0]!.text.startsWith(STEP_CONTINUE_PREFIX));
    assert.match(prompts[0]!.text, /coordinator-task-watchdog/);

    await hooks["tool.execute.after"]!(
      { tool: "task", sessionID: "watchdog-root", callID: "watchdog-call" },
      { output: "<task><task_result>late</task_result></task>", metadata: { sessionId: "watchdog-child" } },
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(aborts.length, 1);
    assert.equal(prompts.length, 1);
  });
});

test("root task watchdog recovery is passive outside the coordinator abort and synthetic resume APIs", async () => {
  await withProject("task-watchdog-passive-recovery", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    await writeFile(join(directory, "handoff.json"), JSON.stringify(writeGateHandoff(directory, "operation-manifest.json")));
    await writeFile(join(directory, "tracked.txt"), "unchanged\n");
    const hostMutationCalls: string[] = [];
    const hooks = await SortieDogsPlugin({
      directory,
      client: {
        app: { log: async () => undefined },
        session: {
          abort: async ({ path }) => { hostMutationCalls.push(`session.abort:${path.id}`); return true; },
          promptAsync: async ({ path }) => { hostMutationCalls.push(`session.promptAsync:${path.id}`); return true; },
          create: async () => { hostMutationCalls.push("session.create"); return true; },
          delete: async () => { hostMutationCalls.push("session.delete"); return true; },
          summarize: async () => { hostMutationCalls.push("session.summarize"); return true; },
        },
      } as never,
    }, { continuation: { taskWatchdogMilliseconds: 20 } });
    await beginTrackedTaskChild(hooks, directory, "passive-root", "passive-child", "passive-call");

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(hostMutationCalls, ["session.abort:passive-root", "session.promptAsync:passive-root"]);
    assert.equal(await readFile(join(directory, "tracked.txt"), "utf8"), "unchanged\n");
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "passive-root" } } });
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
});

test("normal Task completion and manual session cancellation disarm root watchdog recovery", async () => {
  await withProject("task-watchdog-disarm", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    await writeFile(join(directory, "handoff.json"), JSON.stringify(writeGateHandoff(directory, "operation-manifest.json")));
    const aborts: string[] = [];
    const prompts: string[] = [];
    const hooks = await SortieDogsPlugin({ directory, client: { session: {
      abort: async ({ path }) => { aborts.push(path.id); return true; },
      promptAsync: async ({ path }) => { prompts.push(path.id); return true; },
    } } as never }, { continuation: { taskWatchdogMilliseconds: 20 } });

    await beginTrackedTaskChild(hooks, directory, "normal-root", "normal-child", "normal-call");
    await hooks["tool.execute.after"]!(
      { tool: "task", sessionID: "normal-root", callID: "normal-call" },
      { output: "<task><task_result>done</task_result></task>", metadata: { sessionId: "normal-child" } },
    );
    await beginTrackedTaskChild(hooks, directory, "cancel-root", "cancel-child", "cancel-call");
    await hooks.event!({ event: { type: "session.deleted", properties: { sessionID: "cancel-root" } } });

    await new Promise((resolve) => setTimeout(resolve, 55));
    assert.deepEqual(aborts, []);
    assert.deepEqual(prompts, []);
  });
});

test("root task watchdog defers and rearms for a running parallel task with unarchived durable state", async () => {
  await withProject("task-watchdog-parallel-defer", async (directory) => {
    await writeFile(join(directory, ".gitignore"), "parallel-contract.json\n");
    await writeFile(join(directory, "base.txt"), "base\n");
    await execFileAsync("git", ["init", "-q"], { cwd: directory });
    await execFileAsync("git", ["config", "user.name", "Sortie Test"], { cwd: directory });
    await execFileAsync("git", ["config", "user.email", "sortie@example.invalid"], { cwd: directory });
    await execFileAsync("git", ["add", ".gitignore", "base.txt"], { cwd: directory });
    await execFileAsync("git", ["commit", "-q", "-m", "base"], { cwd: directory });
    const baseSHA = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: directory })).stdout.trim();
    const contractPath = join(directory, "parallel-contract.json");
    await writeFile(contractPath, JSON.stringify({
      version: "0.1.0", mode: "parallel", max_workers: 2,
      tasks: ["a", "b"].map((taskID) => ({ task_id: `parallel-watchdog-${taskID}`,
        worktree: `parallel-watchdog-${taskID}`, branch: `sortie/parallel-watchdog-${taskID}`,
        base_sha: baseSHA, depends_on: [], scope: { read: ["base.txt"], write: [`result-${taskID}.txt`] } })),
      artifacts: [], failure: null, baseline_metrics: null,
    }));
    const aborts: string[] = [];
    const logs: Array<{ message: string; extra?: Record<string, unknown> }> = [];
    const hooks = await SortieDogsPlugin({ directory, client: {
      app: { log: ({ body }) => { logs.push({ message: body.message, extra: body.extra }); } },
      session: {
        abort: async ({ path }) => { aborts.push(path.id); return true; },
        promptAsync: async () => true,
      },
    } as never }, { continuation: { taskWatchdogMilliseconds: 20 } });
    await hooks["chat.message"]!(
      { sessionID: "parallel-root", agent: "dog-coordinator" },
      { message: { agent: "dog-coordinator", model: {} }, parts: [{ type: "text", text: "parallel watchdog" }] },
    );
    const prepared = JSON.parse(await hooks.tool!.sortie_prepare_parallel_dispatch!.execute(
      { contract_path: contractPath }, { sessionID: "parallel-root", agent: "dog-coordinator" },
    )) as { run_id: string; ready: Array<Record<string, unknown>> };
    const descriptor = prepared.ready[0]!;
    const prompt = [
      `task_id: ${descriptor.task_id}`, "role: implementation", `project_root: ${descriptor.managed_path}`,
      `handoff_path: ${descriptor.handoff_path}`, "source_manifest: [base.txt]",
      `operation_manifest: ${descriptor.operation_manifest}`, "acceptance: bounded parallel watchdog",
      "validation: no canonical validation", ...Object.entries(descriptor).filter(([key]) => ![
        "task_id", "managed_path", "handoff_path", "operation_manifest",
        "acceptance", "acceptance_fingerprint", "acceptance_parent_fingerprint",
      ].includes(key)).map(([key, value]) => `${key}: ${Array.isArray(value) ? JSON.stringify(value) : value}`),
      `managed_path: ${descriptor.managed_path}`,
    ].join("\n");
    await hooks["tool.execute.before"]!(
      { tool: "task", sessionID: "parallel-root", callID: "parallel-call" },
      { args: { subagent_type: "dog-worker", prompt } },
    );

    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(aborts, []);
    const deferred = logs.find(({ message, extra }) => message === "batch-watchdog.deferred" &&
      Array.isArray(extra?.reasons) && extra.reasons.includes("parallel-running"));
    assert.ok(deferred);
    assert.deepEqual(deferred.extra?.reasons, ["durable-state-present", "parallel-running"]);
    assert.ok(logs.filter(({ message }) => message === "batch-watchdog.deferred").length >= 2);
    assert.deepEqual(aborts, []);

    await hooks["tool.execute.after"]!(
      { tool: "task", sessionID: "parallel-root", callID: "parallel-call" },
      { output: `SORTIE_PARALLEL_OUTCOME ${JSON.stringify({ run_id: prepared.run_id,
        dispatch_id: descriptor.dispatch_id, status: "failed" })}`, metadata: {} },
    );
    await hooks.tool!.sortie_cancel_parallel_dispatch!.execute(
      { run_id: prepared.run_id }, { sessionID: "parallel-root", agent: "dog-coordinator" },
    );
    await hooks.event!({ event: { type: "session.deleted", properties: { sessionID: "parallel-root" } } });
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
});

test("root task watchdog records deferred evidence and rearms while a child write gate is bound", async () => {
  await withProject("task-watchdog-bound-defer", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    const handoffPath = join(directory, "handoff.json");
    await writeFile(handoffPath, JSON.stringify(writeGateHandoff(directory, "operation-manifest.json")));
    const aborts: string[] = [];
    const logs: Array<{ message: string; extra?: Record<string, unknown> }> = [];
    const hooks = await SortieDogsPlugin({
      directory,
      client: {
        app: { log: ({ body }) => { logs.push({ message: body.message, extra: body.extra }); } },
        session: {
          abort: async ({ path }) => { aborts.push(path.id); return true; },
          promptAsync: async () => true,
        },
      },
    }, { continuation: { taskWatchdogMilliseconds: 20 } });
    await beginTrackedTaskChild(hooks, directory, "defer-root", "defer-child", "defer-call");
    await inspectHandoffWithRead(hooks, handoffPath, "defer-child");
    assert.equal((await executeBindWriteGate(hooks, directory, "defer-child")).status, "bound");

    await new Promise((resolve) => setTimeout(resolve, 55));
    assert.deepEqual(aborts, []);
    const deferred = logs.find(({ message }) => message === "batch-watchdog.deferred");
    assert.ok(deferred);
    assert.deepEqual(deferred.extra?.reasons, ["bound-write-gate"]);

    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "defer-root" } } });
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.deepEqual(aborts, []);
  });
});

test("parent idle retains only a recoverable worker until its same-child resume", async () => {
  await withProject("recoverable-task-idle", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    await writeFile(join(directory, "handoff.json"), JSON.stringify(writeGateHandoff(directory, "operation-manifest.json")));
    const hooks = await SortieDogsPlugin({ directory });
    const task = [
      "context_digest:",
      "  task_id: task-a",
      `  project_root: ${directory}`,
      `  handoff_path: ${join(directory, "handoff.json")}`,
      "  acceptance: safe change",
      "  role: implementation",
      "  source_manifest: [allowed.txt]",
      "operation_manifest: operation-manifest.json",
      "validation: npm test",
    ].join("\n");
    await hooks["chat.message"]!(
      { sessionID: "parent", agent: "dog-coordinator" },
      { message: { agent: "dog-coordinator", model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: "tracked task" }] },
    );
    await hooks["tool.execute.before"]!(
      { tool: "task", sessionID: "parent", callID: "first-task" },
      { args: { subagent_type: "dog-worker", prompt: task } },
    );
    await hooks.event!({ event: { type: "session.created", properties: { info: { id: "child", parentID: "parent", directory } } } });
    await hooks["chat.message"]!(
      { sessionID: "child", agent: "dog-worker", parentID: "parent" } as never,
      { message: { agent: "dog-worker", model: { providerID: "host", modelID: "selected" } }, parts: [{ type: "text", text: task }] },
    );
    assert.equal((await executeBindWriteGate(hooks, directory, "child")).reason, "handoff-uninspected");
    await hooks["tool.execute.after"]!(
      { tool: "task", sessionID: "parent", callID: "first-task" },
      { output: "<task><task_result>denied</task_result></task>", metadata: { sessionId: "child" } },
    );

    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "parent" } } });
    await assert.rejects(
      () => hooks["tool.execute.before"]!(
        { tool: "task", sessionID: "parent", callID: "malformed-resume-task" },
        {
          args: {
            subagent_type: "dog-worker",
            task_id: "child",
            prompt: "task_id: task-a\nmode: same-task-resume\nrole: implementation",
          },
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof HandoffDeniedError);
        assert.deepEqual(error.defects, ["contract / resume_contract_redefinition"]);
        return true;
      },
    );
    await assert.rejects(
      () => hooks["tool.execute.before"]!(
        { tool: "task", sessionID: "parent", callID: "duplicate-mode-resume-task" },
        {
          args: {
            subagent_type: "dog-worker",
            task_id: "child",
            prompt: "task_id: task-a\nmode: initial\nmode: same-task-resume",
          },
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof HandoffDeniedError);
        assert.deepEqual(error.defects, ["contract /mode dispatch_mode_invalid"]);
        return true;
      },
    );
    await assert.rejects(
      () => hooks["tool.execute.before"]!(
        { tool: "task", sessionID: "parent", callID: "redefined-facts-resume-task" },
        {
          args: {
            subagent_type: "dog-worker",
            task_id: "child",
            prompt: "task_id: task-a\nmode: same-task-resume\nknown_facts: [changed]",
          },
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof HandoffDeniedError);
        assert.deepEqual(error.defects, ["contract / resume_contract_redefinition"]);
        return true;
      },
    );
    await assert.rejects(
      () => hooks["tool.execute.before"]!(
        { tool: "task", sessionID: "parent", callID: "redefined-history-resume-task" },
        {
          args: {
            subagent_type: "dog-worker",
            task_id: "child",
            prompt: "task_id: task-a\nmode: same-task-resume\nvalidation_attempts: { canonical: 0, diagnostic: 0 }\nscout: { attempted: false }",
          },
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof HandoffDeniedError);
        assert.deepEqual(error.defects, ["contract / resume_contract_redefinition"]);
        return true;
      },
    );
    await assert.rejects(
      () => hooks["tool.execute.before"]!(
        { tool: "task", sessionID: "parent", callID: "missing-delta-resume-task" },
        {
          args: {
            subagent_type: "dog-worker",
            task_id: "child",
            prompt: "task_id: task-a\nmode: same-task-resume",
          },
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof HandoffDeniedError);
        assert.deepEqual(error.defects, ["contract / resume_contract_redefinition"]);
        return true;
      },
    );
    await assert.rejects(
      () => hooks["tool.execute.before"]!(
        { tool: "task", sessionID: "parent", callID: "empty-delta-resume-task" },
        {
          args: {
            subagent_type: "dog-worker",
            task_id: "child",
            prompt: "task_id: task-a\nmode: same-task-resume\nresume_delta: none",
          },
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof HandoffDeniedError);
        assert.deepEqual(error.defects, ["contract / resume_contract_redefinition"]);
        return true;
      },
    );
    await assert.rejects(
      () => hooks["tool.execute.before"]!(
        { tool: "task", sessionID: "parent", callID: "inline-delta-resume-task" },
        {
          args: {
            subagent_type: "dog-worker",
            task_id: "child",
            prompt: "task_id: task-a\nmode: same-task-resume\nresume_delta: { acceptance: changed }",
          },
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof HandoffDeniedError);
        assert.deepEqual(error.defects, ["contract / resume_contract_redefinition"]);
        return true;
      },
    );
    await assert.rejects(
      () => hooks["tool.execute.before"]!(
        { tool: "task", sessionID: "parent", callID: "parallel-resume-task" },
        {
          args: {
            subagent_type: "dog-worker",
            task_id: "child",
            prompt: "task_id: task-a\nmode: same-task-resume\nresume_delta:\nparallel_group: changed",
          },
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof HandoffDeniedError);
        assert.deepEqual(error.defects, ["contract / resume_contract_redefinition"]);
        return true;
      },
    );
    await assert.rejects(
      () => hooks["tool.execute.before"]!(
        { tool: "task", sessionID: "parent", callID: "nested-required-resume-task" },
        {
          args: {
            subagent_type: "dog-worker",
            task_id: "child",
            prompt: "context_digest:\n  resume_delta:\n    task_id: task-a\n    mode: same-task-resume\n    resume_delta:\n      next_action: read then bind",
          },
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof HandoffDeniedError);
        assert.deepEqual(error.defects, ["contract / resume_contract_redefinition"]);
        return true;
      },
    );
    await assert.rejects(
      () => hooks["tool.execute.before"]!(
        { tool: "task", sessionID: "parent", callID: "indirect-required-resume-task" },
        {
          args: {
            subagent_type: "dog-worker",
            task_id: "child",
            prompt: "task_id: task-a\ncontext_digest:\n  wrapper:\n    mode: same-task-resume\n    resume_delta:\n      next_action: read then bind",
          },
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof HandoffDeniedError);
        assert.deepEqual(error.defects, ["contract / resume_contract_redefinition"]);
        return true;
      },
    );
    await hooks["tool.execute.before"]!(
      { tool: "task", sessionID: "parent", callID: "resume-task" },
      {
        args: {
          subagent_type: "dog-worker",
          task_id: "child",
          prompt: "task_id: task-a\ncontext_digest:\n  mode: same-task-resume\n  resume_delta:\n    next_action: read then bind",
        },
      },
    );
    await inspectHandoffWithRead(hooks, join(directory, "handoff.json"), "child");
    assert.equal((await executeBindWriteGate(hooks, directory, "child")).status, "bound");
    await hooks["tool.execute.after"]!(
      { tool: "task", sessionID: "parent", callID: "resume-task" },
      { output: "<task><task_result>bound</task_result></task>", metadata: { sessionId: "child" } },
    );
    assert.equal((await executeBindWriteGate(hooks, directory, "child")).reason, "session-inactive");

    await beginTrackedTaskChild(hooks, directory, "deleted-parent", "deleted-child", "deleted-task", "task-delete");
    assert.equal((await executeBindWriteGate(hooks, directory, "deleted-child")).reason, "handoff-uninspected");
    await hooks["tool.execute.after"]!(
      { tool: "task", sessionID: "deleted-parent", callID: "deleted-task" },
      { output: "<task><task_result>denied</task_result></task>", metadata: { sessionId: "deleted-child" } },
    );
    await hooks.event!({ event: { type: "session.deleted", properties: { sessionID: "deleted-parent" } } });
    assert.equal((await executeBindWriteGate(hooks, directory, "deleted-child")).reason, "session-inactive");
  });
});

test("session idle revokes authorization even when handoff revalidation fails", async () => {
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
        { tool: "write", sessionID: "idle-failure", callID: "released-after-idle" },
        { args: { file: "allowed.txt", content: "not-written" } },
      ),
      'Write denied for "<released-session>": released session must re-read only its handoff and bind before further work.',
      "session-released",
    );
  });
});

test("parent Task completion releases the child authorization", async () => {
  await withProject("task-completion-release", async (directory) => {
    await writeFile(join(directory, "operation-manifest.json"), JSON.stringify(fixture.manifest));
    const handoffPath = join(directory, "handoff.json");
    await writeFile(handoffPath, JSON.stringify(writeGateHandoff(directory, "operation-manifest.json")));
    const hooks = await SortieDogsPlugin({ directory });
    await activate(hooks, "child");
    await inspectHandoffWithRead(hooks, handoffPath, "child");
    assert.equal((await executeBindWriteGate(hooks, directory, "child")).status, "bound");

    await hooks["tool.execute.after"]!(
      { tool: "task", sessionID: "parent", callID: "parent-task" },
      { output: "<task><task_result>done</task_result></task>", metadata: { sessionId: "child" } },
    );
    await activate(hooks, "child");
    await expectMessage(
      () => hooks["tool.execute.before"]!(
        { tool: "write", sessionID: "child", callID: "after-completion" },
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
    await expectMessage(
      () => invoke("true & rm blocked-background.txt"),
      'Write denied for "blocked-background.txt": operation manifest write scope.',
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
    await invokePowerShell(
      'Copy-Item -LiteralPath "read-only-source.bin" -Destination "allowed.txt" -Force',
    );
    await expectMessage(
      () => invokePowerShell(
        'Copy-Item -LiteralPath "read-only-source.bin" -Destination "blocked-copy.bin" -Force',
      ),
      'Write denied for "blocked-copy.bin": operation manifest write scope.',
      "manifest-scope",
    );
    for (const command of [
      'Copy-Item "read-only-source.bin" "blocked-copy.bin" -Include "allowed.txt"',
      'Copy-Item -LiteralPath "read-only-source.bin" -Destination "$env:TEMP" -Force',
      'Copy-Item -LiteralPath "read-only-source.bin" -Destination "*.bin" -Force',
      'Copy-Item -Path "$dynamic" -Destination "allowed.txt"',
      'Copy-Item -Path "*.bin" -Destination "allowed.txt"',
      'Copy-Item -Path "[ab].bin" -Destination "allowed.txt"',
      'Copy-Item -Path @("a","b") -Destination "allowed.txt"',
      'Copy-Item -Path (Get-Location) -Destination "allowed.txt"',
      'Copy-Item -LiteralPath -Recurse -Destination "allowed.txt"',
      'Copy-Item -LiteralPath "read-only-source.bin" -Destination -Force',
      'Copy-Item -LiteralPath "read-only-source.bin" -Destination "allowed.txt" -Force -Force',
      'Copy-Item "source-a.bin" "source-b.bin" "allowed.txt"',
    ]) {
      await expectActionableCommandDenial(
        () => invokePowerShell(command),
        "unsupported-copy-item-form",
      );
    }
    const robocopyTarget = directory.replaceAll("/", "\\");
    await invokePowerShell(
      `& "C:\\Windows\\System32\\Robocopy.exe" "C:\\approved-source" "${robocopyTarget}" "allowed.txt"`,
    );
    await expectMessage(
      () => invokePowerShell(
        `& "C:\\Windows\\System32\\Robocopy.exe" "C:\\approved-source" "${robocopyTarget}" "blocked.txt"`,
      ),
      'Write denied for "blocked.txt": operation manifest write scope.',
      "manifest-scope",
    );
    for (const command of [
      `& "C:\\Windows\\System32\\Robocopy.exe" "C:\\approved-*" "${robocopyTarget}" "allowed.txt"`,
      `& "C:\\Windows\\System32\\Robocopy.exe" "C:\\approved-source" "${robocopyTarget}\\*" "allowed.txt"`,
      `& "C:\\Windows\\System32\\Robocopy.exe" "C:\\approved-source" "$env:TEMP" "allowed.txt"`,
      `& "C:\\Windows\\System32\\Robocopy.exe" "C:\\approved-source" "${robocopyTarget}" "*.txt"`,
    ]) {
      await expectActionableCommandDenial(
        () => invokePowerShell(command),
        "unsupported-robocopy-form",
      );
    }
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
    await assert.rejects(
      () => invokePowerShell("$value = & Remove-Item C:\\out\\f.txt"),
      (error: unknown) => error instanceof Error &&
        (error as Error & { reason?: string }).reason === "project-boundary",
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

test("declared Windows executable commands accept equivalent PowerShell call-operator spelling", () => {
  const declared = 'M:\\@HyperV\\WPy64-310111\\python-3.10.11.amd64\\python.exe -c "import openpyxl;print(openpyxl.__version__)"';
  const invoked = '& \'M:\\@HyperV\\WPy64-310111\\python-3.10.11.amd64\\python.exe\' -c "import openpyxl;print(openpyxl.__version__)"';

  assert.equal(normalizeCommand(invoked), normalizeCommand(declared));
  assert.equal(
    normalizeCommand("& 'C:/tools/python.exe' --version"),
    normalizeCommand("C:/tools/python.exe --version"),
  );
  assert.equal(
    normalizeCommand("& '\\\\server\\tools\\python.exe' --version"),
    normalizeCommand("\\\\server\\tools\\python.exe --version"),
  );
  assert.equal(
    normalizeCommand("& '/opt/tools/python' --version"),
    normalizeCommand("/opt/tools/python --version"),
  );
  assert.notEqual(normalizeCommand("& 'relative-tool' --version"), normalizeCommand("relative-tool --version"));
  assert.notEqual(
    normalizeCommand("& 'C:\\tools\\python.exe -c safe'"),
    normalizeCommand("C:\\tools\\python.exe -c safe"),
  );
});

test("shell gate extracts bounded artifact download and archive paths", () => {
  assert.deepEqual(
    extractWritePaths("bash", { command: "curl -fL --retry 0 --max-time 120 https://example.test/a.tar.gz -o temp/a.tar.gz" }),
    { applies: true, ambiguous: false, paths: ["temp/a.tar.gz"], requiredDirectories: ["temp"] },
  );
  assert.deepEqual(
    extractWritePaths("powershell", { command: "Invoke-WebRequest -Uri https://example.test/a.zip -OutFile temp/a.zip" }),
    { applies: true, ambiguous: false, paths: ["temp/a.zip"], requiredDirectories: ["temp"] },
  );
  assert.deepEqual(
    extractWritePaths("bash", { command: "tar -tzf temp/a.tar.gz" }),
    { applies: false, ambiguous: false, paths: [] },
  );
  assert.deepEqual(
    extractWritePaths("bash", { command: "tar -xzf temp/a.tar.gz -C temp/extracted" }),
    { applies: true, ambiguous: false, paths: ["temp/extracted"], requiredDirectories: ["temp/extracted"] },
  );
  assert.deepEqual(
    extractWritePaths("bash", { command: "find temp/extracted -type f -name libmoonshine.so -exec sha256sum {} \\;" }),
    { applies: false, ambiguous: false, paths: [] },
  );
  assert.deepEqual(
    extractWritePaths("bash", {
      command: "env -u GITHUB_TOKEN -u GH_TOKEN /approved/gh.exe api graphql --paginate --slurp -F id=PVT -f 'query=query($id:ID!,$endCursor:String){node(id:$id){id}}' | jq -c '{count:length}'",
    }),
    { applies: false, ambiguous: false, paths: [] },
  );
  assert.deepEqual(
    extractWritePaths("powershell", {
      command: '$env:GITHUB_TOKEN = $null; $env:GH_TOKEN = $null; & "M:\\@HyperV\\gh-cli\\bin\\gh.exe" auth status',
    }),
    { applies: false, ambiguous: false, paths: [] },
  );
  for (const command of [
    "curl -fLO https://example.test/a.tar.gz",
    "curl https://example.test/a.tar.gz -o temp/a -D temp/headers",
    "tar -xzf temp/a.tar.gz",
    "tar -czf temp/a.tar.gz temp/input",
    "tar -tzf temp/a.tar.gz --to-command=calc",
    "tar -xzf temp/a.tar.gz -C temp/extracted --checkpoint-action=exec=calc",
  ]) {
    const result = extractWritePaths("bash", { command });
    assert.equal(result.ambiguous, true, command);
    assert.ok(result.issue, command);
  }
});

test("declared recursive mkdir authorizes a missing future directory scope", async () => {
  await withProject("future-directory-scope", async (directory) => {
    const gate = await createWriteGate(await createProjectPaths(directory), {
      version: "0.1.0",
      task_id: "future-directory-scope",
      read: [],
      write: ["temp/artifact"],
      validation: [
        "mkdir -p temp/artifact",
        "curl -fL https://example.test/archive.tar.gz -o temp/artifact/archive.tar.gz",
      ],
    });
    await gate.checkPath("temp/artifact/archive.tar.gz");
    await assert.rejects(
      gate.checkPath("temp/sibling/archive.tar.gz"),
      (error: unknown) => error instanceof Error && (error as Error & { reason?: string }).reason === "manifest-scope",
    );
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
    await inspectHandoffWithRead(hooks, handoffPath, "one");
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
