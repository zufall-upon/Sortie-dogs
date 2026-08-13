import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { RUNTIME_ASSET_VERSION } from "../dist/asset-version.js";
import { DEDICATED_WORKER_MODEL, DEDICATED_WORKER_VARIANT } from "../dist/plugin/model-routing.js";

/*
 * The environment layer is a real configuration source, so a host that declares one would silently
 * change every packaged default this suite asserts. Tests observe the package, not the machine.
 */
delete process.env.SORTIE_DOGS_CONFIG;

const testEnvironment = fileURLToPath(new URL("../_testenv/", import.meta.url));
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const execFileAsync = promisify(execFile);

type CandidateRisk = "low" | "high";
type ValidationLevel = "targeted" | "full";

function classifyRisk(
  manifest: readonly string[],
  validationLevel: ValidationLevel,
  operationManifest: readonly string[] = [],
): CandidateRisk {
  return operationManifest.length > 0 ||
    validationLevel === "targeted" || manifest.some((path) => !path.startsWith("test/"))
    ? "high"
    : "low";
}

function gate(input: {
  readonly actor: "coordinator" | "worker";
  readonly intent: "stage" | "commit";
  readonly risk: CandidateRisk;
  readonly validationExit: number;
  readonly reviewed: boolean;
  readonly cachedPaths: readonly string[];
  readonly manifest: readonly string[];
}): { readonly action: "stage" | "commit" | "reject"; readonly report: readonly string[] } {
  if (input.actor === "worker") {
    return { action: "reject", report: [`worker ${input.intent} rejected and reported`] };
  }
  if (input.validationExit !== 0) {
    return {
      action: "reject",
      report: [`canonical validation exit ${input.validationExit}; ${input.intent} rejected`],
    };
  }

  const report: string[] = [];
  if (input.risk === "high" && !input.reviewed) {
    return {
      action: "reject",
      report: [`high-risk independent review required; ${input.intent} rejected`],
    };
  }
  report.push(input.risk === "low" ? "independent review skipped and recorded" : "independent review passed");

  if (input.intent === "stage") return { action: "stage", report };

  const cachedSet = [...new Set(input.cachedPaths)].sort();
  const manifestSet = [...new Set(input.manifest)].sort();
  const scopeMatches =
    cachedSet.length === manifestSet.length && cachedSet.every((path, index) => path === manifestSet[index]);
  if (!scopeMatches) {
    return {
      action: "reject",
      report: [...report, "cached paths differ from source_manifest; commit rejected"],
    };
  }
  return { action: "commit", report: [...report, "cached paths equal source_manifest; commit approved"] };
}

test("packed package exposes plugin and versioned runtime assets", async () => {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "npm_execpath is required for the package smoke test");

  await mkdir(testEnvironment, { recursive: true });
  const fixture = await mkdtemp(join(testEnvironment, "package-export-"));
  try {
    const { stdout: packOutput } = await execFileAsync(
      process.execPath,
      [npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", fixture],
      { cwd: projectRoot },
    );
    const packed = JSON.parse(packOutput) as Array<{ filename: string; files?: Array<{ path: string }> }>;
    assert.equal(packed.length, 1);
    assert.ok(packed[0].files);
    assert.equal(packed[0].files.some(({ path }) => /(?:^|\/)reflection\/seed\.(?:js|d\.ts)$/u.test(path)), false);
    const tarball = join(fixture, packed[0].filename);

    const consumer = join(fixture, "consumer");
    await mkdir(consumer);
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({ name: "package-export-consumer", private: true, type: "module" }),
    );
    await execFileAsync(
      process.execPath,
      [
        npmCli,
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        "--prefix",
        consumer,
        tarball,
      ],
      { cwd: projectRoot },
    );

    const installedPackage = JSON.parse(await readFile(
      join(consumer, "node_modules", "sortie-dogs", "package.json"),
      "utf8",
    )) as { version?: string; scripts?: { prebuild?: string } };
    assert.equal(installedPackage.version, "0.4.8");
    assert.equal(
      installedPackage.scripts?.prebuild,
      "node --input-type=module --eval \"import { rmSync } from 'node:fs'; rmSync('dist', { recursive: true, force: true });\"",
    );

    const rootDeclaration = await readFile(
      join(consumer, "node_modules", "sortie-dogs", "dist", "index.d.ts"),
      "utf8",
    );
    const consultationValueNames = [
      "CONSULTATION_CAPABILITIES",
      "CONSULTATION_ROLE_POLICY",
      "MAX_REVIEW_ARTIFACT_BYTES",
      "SOURCE_REVIEW_RISK_TAGS",
      "STRATEGY_TRIGGERS",
      "evaluateReviewAvailability",
      "evaluateReviewGate",
      "evaluateSourceReviewRequirement",
      "isSourceReviewRiskTag",
      "requiresSourceReview",
      "shouldConsultStrategy",
      "validateReviewArtifact",
      "validateReviewVerdict",
    ] as const;
    const consultationTypeNames = [
      "ConsultationAdapter",
      "ConsultationCapability",
      "ConsultationRequest",
      "ConsultationResult",
      "ReviewArtifact",
      "ReviewAvailability",
      "ReviewFinding",
      "ReviewFindingSeverity",
      "ReviewGateInput",
      "ReviewGateResult",
      "ReviewVerdict",
      "ReviewVerdictKind",
      "SourceReviewConsultationRequest",
      "SourceReviewConsultationResult",
      "SourceReviewRequirement",
      "SourceReviewRequirementInput",
      "SourceReviewRiskTag",
      "StrategyConsultationRequest",
      "StrategyConsultationResult",
      "StrategyTrigger",
      "StrategyTriggerInput",
      "UnavailableConsultationResult",
      "ValidationResult",
    ] as const;
    assert.doesNotMatch(rootDeclaration, /export \* from "\.\/core\/consultation\.js";/);
    assert.match(rootDeclaration, /export \{[^}]+\} from "\.\/core\/consultation\.js";/s);
    assert.match(rootDeclaration, /export type \{[^}]+\} from "\.\/core\/consultation\.js";/s);
    for (const publicName of [...consultationValueNames, ...consultationTypeNames]) {
      assert.match(rootDeclaration, new RegExp(`\\b${publicName}\\b`));
    }

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const [pluginEntry, serverEntry, { runtimeAssets }, root, consultation] = await Promise.all([
          import('sortie-dogs/plugin'),
          import('sortie-dogs/server'),
          import('sortie-dogs/assets'),
          import('sortie-dogs'),
          import('./node_modules/sortie-dogs/dist/core/consultation.js'),
        ]);
        const { SortieDogsPlugin } = pluginEntry;
        // OpenCode calls every runtime export of a plugin module as a plugin factory.
        const openCodeLoad = [];
        let packedTools = [];
        let packedHookKeys = [];
        for (const value of new Set(Object.values(pluginEntry))) {
          if (typeof value !== 'function') { openCodeLoad.push('not-a-function'); continue; }
          try {
            const hooks = await value({ directory: process.cwd() });
            openCodeLoad.push(hooks !== null && typeof hooks === 'object' ? 'hooks' : 'not-hooks');
            if (hooks !== null && typeof hooks === 'object') {
              packedTools = Object.keys(hooks.tool ?? {}).sort();
              packedHookKeys = Object.keys(hooks).filter((key) => key.startsWith('experimental.')).sort();
            }
          } catch (error) {
            openCodeLoad.push('threw: ' + String(error && error.message));
          }
        }
        const consultationValueNames = ${JSON.stringify(consultationValueNames)};
        const artifact = {
          schemaVersion: 1,
          candidateId: 'packed-candidate',
          sourceFingerprint: 'packed-source-v1',
          acceptance: ['fail closed before staging'],
          changedLogicSummary: ['consultation validator rejects incomplete SourceReview artifacts'],
          manifest: ['src/runtime-assets.ts'],
          riskTags: ['public-api'],
          riskBearingHunks: ['src/runtime-assets.ts:1-2'],
          validation: { command: 'npm test', exit: 0, fingerprint: 'packed-validation-v1' },
          invariants: ['dog-reviewer-only'],
        };
        process.stdout.write(JSON.stringify({
          pluginType: typeof SortieDogsPlugin,
          pluginEntryExports: Object.keys(pluginEntry),
          serverEntryExports: Object.keys(serverEntry),
          serverMatchesPlugin: serverEntry.SortieDogsPlugin === SortieDogsPlugin,
          openCodeLoad,
          packedTools,
          packedHookKeys,
          runtimeAssets,
          consultationCapabilities: root.CONSULTATION_CAPABILITIES,
          consultationRolePolicy: root.CONSULTATION_ROLE_POLICY,
          consultationValidatorTypes: [
            typeof root.isSourceReviewRiskTag,
            typeof root.requiresSourceReview,
            typeof root.evaluateSourceReviewRequirement,
            typeof root.shouldConsultStrategy,
          ],
          consultationIdentity: Object.fromEntries(
            consultationValueNames.map((name) => [name, root[name] === consultation[name]]),
          ),
          reviewAvailability: root.evaluateReviewAvailability(true, false),
          nonPassReviewGate: root.evaluateReviewGate({
            phase: 'initial',
            candidateId: 'packed-candidate',
            currentSourceFingerprint: 'packed-source-v1',
            artifact,
            verdict: {
              verdict: 'MUST_FIX',
              sourceFingerprint: 'packed-source-v1',
              findings: [{
                severity: 'major',
                path: 'src/runtime-assets.ts',
                evidence: 'reviewer did not return PASS',
                requiredFix: 'fail closed before staging',
              }],
            },
            reviewedFingerprints: [],
            maxCallsPerCandidate: 1,
            callsForPhase: 0,
          }),
        }));`,
      ],
      {
        cwd: consumer,
        env: { ...process.env, XDG_CONFIG_HOME: join(fixture, "xdg") },
      },
    );
    const loaded = JSON.parse(stdout) as {
      pluginType: string;
      pluginEntryExports: readonly string[];
      serverEntryExports: readonly string[];
      serverMatchesPlugin: boolean;
      openCodeLoad: readonly string[];
      packedTools: readonly string[];
      packedHookKeys: readonly string[];
      consultationCapabilities: readonly string[];
      consultationIdentity: Readonly<Record<string, boolean>>;
      consultationRolePolicy: Readonly<Record<string, string>>;
      consultationValidatorTypes: readonly string[];
      reviewAvailability: { readonly ok: boolean; readonly code?: string };
      nonPassReviewGate: { readonly ok: boolean; readonly permitStage?: boolean; readonly verdict?: string };
      runtimeAssets: Array<{
        name: string;
        version: string;
        installPath: string;
        content: string;
      }>;
    };
    assert.equal(loaded.pluginType, "function");
    assert.deepEqual(
      loaded.pluginEntryExports,
      ["SortieDogsPlugin"],
      "the OpenCode entry must export the plugin factory alone",
    );
    assert.deepEqual(loaded.serverEntryExports, ["SortieDogsPlugin"]);
    assert.equal(loaded.serverMatchesPlugin, true, "OpenCode package resolution must reach the plugin factory");
    assert.deepEqual(
      loaded.openCodeLoad,
      ["hooks"],
      "every runtime export must load as an OpenCode plugin factory",
    );
    /*
     * The packed artifact must carry the continuation runtime, not only the coordinator text that
     * names it. Text-only parity is exactly what let the batch loop ship inert.
     */
    assert.deepEqual(loaded.packedTools, [
      "sortie_bind_write_gate",
      "sortie_check_contract",
      "sortie_compact_and_continue",
      "sortie_enable_backlog_drain",
      "sortie_release_write_gate",
    ]);
    assert.deepEqual(loaded.packedHookKeys, [
      "experimental.chat.system.transform",
      "experimental.compaction.autocontinue",
      "experimental.session.compacting",
      "experimental.text.complete",
    ]);
    assert.deepEqual(loaded.consultationCapabilities, ["strategy", "sourceReview"]);
    assert.deepEqual(loaded.consultationRolePolicy, {
      strategy: "dog-advisor",
      sourceReview: "dog-reviewer",
    });
    assert.deepEqual(loaded.consultationValidatorTypes, ["function", "function", "function", "function"]);
    assert.deepEqual(
      loaded.consultationIdentity,
      Object.fromEntries(consultationValueNames.map((name) => [name, true])),
    );
    assert.equal(loaded.runtimeAssets.length, 6);
    assert.deepEqual(
      loaded.runtimeAssets.map(({ name, installPath }) => ({ name, installPath })),
      [
        { name: "dog-coordinator", installPath: "agent/dog-coordinator.md" },
        { name: "dog-worker", installPath: "agent/dog-worker.md" },
        { name: "dog-scout", installPath: "agent/dog-scout.md" },
        { name: "dog-reviewer", installPath: "agent/dog-reviewer.md" },
        { name: "dog-advisor", installPath: "agent/dog-advisor.md" },
        { name: "sortie", installPath: "command/sortie.md" },
      ],
    );

    const coordinator = loaded.runtimeAssets.find(({ name }) => name === "dog-coordinator");
    const worker = loaded.runtimeAssets.find(({ name }) => name === "dog-worker");
    const scout = loaded.runtimeAssets.find(({ name }) => name === "dog-scout")!;
    const reviewer = loaded.runtimeAssets.find(({ name }) => name === "dog-reviewer")!;
    const advisor = loaded.runtimeAssets.find(({ name }) => name === "dog-advisor")!;
    const sortie = loaded.runtimeAssets.find(({ name }) => name === "sortie");
    assert.ok(coordinator);
    assert.ok(worker);
    assert.ok(sortie);
    assert.match(
      coordinator.content,
      /^permission:\r?\n  question: allow\r?\n  task:\r?\n    "\*": deny\r?\n    dog-worker: allow\r?\n    dog-scout: allow\r?\n    dog-reviewer: allow\r?\n    dog-advisor: allow\r?\ntools:\r?\n  question: true\r?\n  task: true$/mu,
    );
    for (const denied of ["build", "implementer", "fixer", "reviewer", "explore", "general", "coordinator"]) {
      assert.doesNotMatch(coordinator.content, new RegExp(`^    ${denied}: allow$`, "m"));
    }
    // The worker model is resolved by dedicated routing, not pinned in the asset, so a host that
    // cannot serve the shipped target can still load and run this agent.
    for (const asset of loaded.runtimeAssets) {
      assert.equal(asset.version, RUNTIME_ASSET_VERSION, `${asset.name} version must match the shared marker`);
    }
    assert.equal(RUNTIME_ASSET_VERSION, "0.3.12-dispatch-preflight-v1");
    const coordinatorFrontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(coordinator.content)?.[1];
    assert.ok(coordinatorFrontmatter);
    assert.match(coordinatorFrontmatter, /^model: openai\/gpt-5\.6-terra$/m);
    assert.match(coordinatorFrontmatter, /^variant: medium$/m);
    assert.equal(/^---\r?\n[\s\S]*?\r?\n---/u.exec(worker.content)?.[0].includes("model:"), false);
    assert.equal(worker.content.includes(DEDICATED_WORKER_MODEL), false);
    assert.equal(worker.content.includes(DEDICATED_WORKER_VARIANT), false);

    assert.match(scout.content, /^---\r?\n[\s\S]*\nsteps:\s*8\r?\n/);
    const deniedScoutTools = [
      "bash",
      "webfetch",
      "task",
      "question",
      "glob",
      "grep",
      "edit",
      "list",
      "write",
      "patch",
    ];
    for (const tool of deniedScoutTools) {
      assert.match(scout.content, new RegExp(`^  ${tool}: deny$`, "m"));
      assert.match(scout.content, new RegExp(`^  ${tool}: false$`, "m"));
    }
    assert.match(scout.content, /permission:\r?\n(?:  [a-z]+: deny\r?\n){10}tools:/);
    assert.match(scout.content, /tools:\r?\n(?:  [a-z]+: false\r?\n){10}---/);
    assert.doesNotMatch(scout.content, /^  read: (?:deny|false)$/im);
    assert.match(
      scout.content,
      /one concrete missing_evidence_code: manifest, validation, or owner-risk[\s\S]+known_paths list of at most four paths[\s\S]+Use Read only[\s\S]+at most 120 lines[\s\S]+no more than one read per supplied path[\s\S]+Do not resolve a second key, explore, invoke another tool, retry/i,
    );
    // A scout resolving supplied paths against the session directory wastes the whole fan-out when
    // the session sits above the candidate repository.
    assert.match(
      scout.content,
      /explicit absolute project_root[\s\S]+Resolve only that evidence key from those paths under project_root; never resolve a path against the\s+session directory/i,
    );
    assert.match(
      scout.content,
      /When project_root is missing, or a supplied path does not resolve under it, or a resolved path is\s+unreadable, report that dispatch defect as the facts for the requested key and name the exact paths/i,
    );
    assert.match(
      scout.content,
      /exactly one concise JSON object of at most 800 characters with exactly these keys:\s+missing_evidence_code, facts, evidence_paths, risks[\s\S]+no Markdown, code fence, commentary, or raw log/i,
    );
    assert.ok(scout.content.length >= 350, "dog-scout needs a substantive bounded role");
    assert.match(
      reviewer.content,
      /only one bounded SourceReview request from dog-coordinator[\s\S]+after canonical\s+validation for one high-risk candidate[\s\S]+Do not request raw logs or full source\s+files[\s\S]+Return one concise PASS or concrete-finding response only to dog-coordinator/i,
    );
    assert.match(
      reviewer.content,
      /supplied\s+fields as the complete bounded SourceReview artifact; use only that artifact and invoke no tools/i,
    );
    assert.match(
      reviewer.content,
      /every acceptance item explicitly\s+maps to at least one changedLogicSummary entry[\s\S]+Missing or incomplete coverage is a concrete finding, never PASS/i,
    );
    assert.match(reviewer.content, /indexed acceptance\[i\] -> changedLogicSummary\[j\] mapping line per acceptance item/i);
    assert.ok(reviewer.content.length >= 350, "dog-reviewer needs a substantive risk-gated role");
    assert.match(
      advisor.content,
      /only one bounded Strategy request from dog-coordinator[\s\S]+one candidate and one focused\s+question[\s\S]+Do not request raw logs or full source files[\s\S]+options and one recommendation only to dog-coordinator/i,
    );
    assert.match(advisor.content, /Reject every SourceReview request[\s\S]+SourceReview is\s+dog-reviewer-only work/i);
    assert.doesNotMatch(advisor.content, /Accept[^.]*SourceReview/i);
    assert.ok(advisor.content.length >= 350, "dog-advisor needs a substantive consultation role");
    for (const consultationAsset of [reviewer, advisor]) {
      const frontmatter = consultationAsset.content.match(/^---\r?\n([\s\S]+?)\r?\n---/)?.[1];
      assert.ok(frontmatter, `${consultationAsset.name} needs frontmatter`);
      assert.doesNotMatch(frontmatter, /^(?:model|variant):/m);
      assert.doesNotMatch(
        consultationAsset.content,
        /(?:opus|fable|claude|openai|anthropic|gemini|powershell|windows|credential|provider[ /_-]*api|vendor[ /_-]*api)/i,
      );
    }
    for (const consultationAsset of [reviewer, advisor]) {
      assert.match(consultationAsset.content, /host-routed/);
      assert.match(
        consultationAsset.content,
        /do not require or identify a\s+provider, vendor, model, variant,\s+or transport/i,
      );
    }

    assert.match(coordinator.content, /only user-facing agent/i);
    assert.match(coordinator.content, /before any edit/i);
    assert.match(coordinator.content, /no more than three lines/i);
    assert.match(coordinator.content, /canonical MkII order/i);
    assert.match(coordinator.content, /all required context inline/i);
    assert.match(coordinator.content, /Every other target, including generic build,\s+implementer, fixer, reviewer, explore, general, and alternate coordinators, is denied fail-closed/i);

    const initialHandoff = coordinator.content.match(
      /INITIAL_HANDOFF_FIXTURE\r?\n([\s\S]+?)\r?\nEND_INITIAL_HANDOFF_FIXTURE/,
    );
    assert.ok(initialHandoff, "coordinator needs an initial handoff fixture");
    assert.match(initialHandoff[1], /task_id:/);
    assert.match(initialHandoff[1], /context_digest:/);
    assert.match(initialHandoff[1], /project_root:/);
    assert.match(initialHandoff[1], /handoff_path:\s*<absolute registered candidate handoff; every mutating dispatch>/);
    assert.match(initialHandoff[1], /acceptance:/);
    assert.match(initialHandoff[1], /role:\s*implementation/);
    assert.match(initialHandoff[1], /validation:\s*\{\s*level:\s*full,\s*command:/);
    assert.match(initialHandoff[1], /validation:\s*\{ level: full, command: <exact canonical command>, diagnostics: \[<zero or one exact predeclared command>\] \}/);
    assert.match(initialHandoff[1], /validation_attempts:\s*\{ canonical: 0, diagnostic: 0 \}/);
    assert.match(initialHandoff[1], /known_facts:/);
    assert.match(initialHandoff[1], /known_paths:\s*\[<up to 4 exact paths>\]/);
    assert.match(initialHandoff[1], /relevant_constraints:/);
    assert.match(
      initialHandoff[1],
      /scout:\s*\{ attempted: <candidate boolean>, revision: <candidate revision>, blocker_owner: <fixed owner>, reason: <exact skip or fan-out reason> \}/,
    );
    assert.match(initialHandoff[1], /resume_delta:\s*none/);
    assert.match(initialHandoff[1], /source_manifest:/);
    assert.match(initialHandoff[1], /operation_manifest:\s*<exact absolute operation manifest>/);

    const resumedHandoff = coordinator.content.match(
      /RESUMED_HANDOFF_FIXTURE\r?\n([\s\S]+?)\r?\nEND_RESUMED_HANDOFF_FIXTURE/,
    );
    assert.ok(resumedHandoff, "coordinator needs a same-task resume fixture");
    assert.match(resumedHandoff[1], /mode:\s*same-task-resume/);
    assert.doesNotMatch(resumedHandoff[1], /preserve:/);
    assert.match(resumedHandoff[1], /resume_delta:/);
    assert.match(resumedHandoff[1], /stale_paths:/);
    assert.match(resumedHandoff[1], /new_findings:/);
    assert.match(resumedHandoff[1], /previous_exit:/);
    assert.doesNotMatch(resumedHandoff[1], /validation_attempts:|scout:/);
    assert.match(resumedHandoff[1], /next_action:/);
    assert.doesNotMatch(resumedHandoff[1], /project_root:|command:\s*</);

    const restartRecovery = coordinator.content.match(
      /RESTART_RECOVERY_FIXTURE\r?\n([\s\S]+?)\r?\nEND_RESTART_RECOVERY_FIXTURE/,
    );
    assert.ok(restartRecovery, "coordinator needs restart recovery policy");
    assert.match(
      restartRecovery[1],
      /reconstruction:\s*project-local durable artifacts \+ durable OpenCode session messages \+ latest compaction summary \+ bounded handoff\/checkpoint/,
    );
    assert.match(restartRecovery[1], /preserve:\s*\[source_manifest, operation_manifest, validation_history, inventoryFingerprint, candidateQueue, pendingTrackerUpdates, trackerFlushState\]/);
    assert.match(
      restartRecovery[1],
      /validation_history_entry:\s*\{ command: <exact command>, exit: <exit>, fingerprint: <concise fingerprint> \}/,
    );
    assert.match(restartRecovery[1], /resume_route:\s*dog-coordinator -> dog-worker/);
    assert.match(restartRecovery[1], /new_session_reconcile:\s*git history \+ source state \+ matching acceptanceFingerprint and acceptanceHashes \+ durable handoff before dispatch/);
    assert.match(restartRecovery[1], /stale_tracker_commit:\s*batchReconciled \+ queued tracker repair; reimplementation forbidden/);
    assert.match(restartRecovery[1], /user_route:\s*dog-coordinator only/);
    assert.match(coordinator.content, /dispatch implementation only to dog-worker/i);
    const scoutSkip = coordinator.content.match(
      /SCOUT_SKIP_FIXTURE\r?\n([\s\S]+?)\r?\nEND_SCOUT_SKIP_FIXTURE/,
    );
    assert.ok(scoutSkip, "coordinator needs the Scout skip branch");
    assert.match(scoutSkip[1], /exact manifest \+ canonical validation \+ blocker owner all fixed/);
    assert.match(scoutSkip[1], /candidate_default:\s*Scout 0/);
    assert.match(scoutSkip[1], /allowed_gap:\s*manifest \| validation \| owner-risk/);
    assert.match(scoutSkip[1], /dispatch:\s*one dog-scout maximum before worker/);
    assert.match(scoutSkip[1], /prompt_field:\s*missing_evidence_code: <allowed gap>/);
    assert.match(scoutSkip[1], /unresolved_action:\s*question or exact blocker; no second Scout/);
    assert.match(scoutSkip[1], /known_paths:\s*worker read boundary even without Scout read/);
    assert.match(scoutSkip[1], /action:\s*route directly to dog-worker/);

    const artifactFastPath = coordinator.content.match(
      /ARTIFACT_ONLY_FAST_PATH_FIXTURE\r?\n([\s\S]+?)\r?\nEND_ARTIFACT_ONLY_FAST_PATH_FIXTURE/,
    );
    assert.ok(artifactFastPath, "coordinator needs a bounded path for source-free local artifacts");
    assert.match(artifactFastPath[1], /source_manifest=none \+ exact local output files \+ full validation/);
    assert.match(artifactFastPath[1], /scout:\s*skipped/);
    assert.match(artifactFastPath[1], /route:\s*dog-coordinator -> one dog-worker -> dog-coordinator/);
    assert.match(artifactFastPath[1], /review:\s*skipped; artifact-only low-risk/);
    assert.match(artifactFastPath[1], /stage_commit:\s*forbidden; return artifact directly/);
    assert.match(artifactFastPath[1], /follow_up_agents:\s*forbidden for evidence formatting, hash transcription, or redundant verification/);
    assert.match(
      coordinator.content,
      /Handoff sources are revision evidence, not mutation classification[\s\S]+artifact-only dispatch uses source_manifest none/i,
    );
    assert.match(
      coordinator.content,
      /Require a digest only when the user requests one or when release, publication,\s*transfer, or integrity acceptance explicitly needs one/i,
    );

    const visualCapture = coordinator.content.match(
      /VISUAL_EVIDENCE_CAPTURE_FIXTURE\r?\n([\s\S]+?)\r?\nEND_VISUAL_EVIDENCE_CAPTURE_FIXTURE/,
    );
    assert.ok(visualCapture, "coordinator needs a bounded capture protocol");
    assert.match(visualCapture[1], /preflight:\s*exact process \+ visible window handle\/title \+ nonzero client bounds \+ one target visual anchor/);
    assert.match(visualCapture[1], /preflight_failure:\s*repair harness only; no video or full screenshot set/);
    assert.match(visualCapture[1], /full_capture_limit:\s*one per attempt_key/);
    assert.match(visualCapture[1], /valid_evidence_visual_fail:\s*return to source remediation; same-source recapture forbidden/);
    assert.match(visualCapture[1], /corrected_harness:\s*one new revision \+ one final capture/);
    assert.match(visualCapture[1], /second_invalid_capture:\s*terminal capture blocker; no third capture/);
    assert.match(visualCapture[1], /duplicate_pixel_review:\s*no additional worker to reread or reformat the same images/);

    const scoutFanout = coordinator.content.match(
      /SCOUT_FANOUT_FIXTURE\r?\n([\s\S]+?)\r?\nEND_SCOUT_FANOUT_FIXTURE/,
    );
    assert.ok(scoutFanout, "coordinator needs the exceptional one-Scout lane");
    assert.match(scoutFanout[1], /decision:\s*exceptional; one concrete evidence key blocks safe worker dispatch/);
    assert.match(scoutFanout[1], /dispatch_guard:\s*no prior Scout and no worker dispatch in the real user turn/);
    assert.match(scoutFanout[1], /dispatch:\s*exactly one bounded dog-scout call/);
    assert.match(scoutFanout[1], /role:\s*resolve only missing_evidence_code/);
    // Scouts inherit no project context, so the dispatch must carry the same root as the worker.
    assert.match(scoutFanout[1], /project_root:\s*<absolute project root; same value as the worker digest>/);
    assert.match(
      scoutFanout[1],
      /known_paths:\s*at most 4 supplied paths, each resolvable under project_root/,
    );
    assert.match(scoutFanout[1], /malformed \| timeout \| empty -> exact blocker without retry/);
    assert.match(scoutFanout[1], /resolved -> one dog-worker; unresolved -> question \| blocker/);

    const parallelImplementation = coordinator.content.match(
      /PARALLEL_IMPLEMENTATION_FIXTURE\r?\n([\s\S]+?)\r?\nEND_PARALLEL_IMPLEMENTATION_FIXTURE/,
    );
    assert.ok(parallelImplementation, "coordinator needs the runtime single-worker lane");
    for (const contract of [
      "default: one dog-worker",
      "route: dog-coordinator -> one dog-worker -> deterministic evidence verification -> DONE",
      "ownership: one worker owns inspect | edit | targeted checks | canonical validation | remediation once",
      "second_worker: runtime denied in the same real user turn",
      "synthetic_turn: never resets worker limit",
      "scope_gap: return typed gap; no manifest expansion | replacement worker",
      "parallel_fanout: forbidden on normal lane",
    ]) assert.ok(parallelImplementation[1].includes(contract), contract);
    assert.match(coordinator.content, /only consultation capabilities are Strategy and SourceReview/);
    assert.match(coordinator.content, /Strategy follows\s+dog-coordinator -> dog-advisor -> dog-coordinator/);
    assert.match(coordinator.content, /SourceReview follows\s+dog-coordinator -> dog-reviewer -> dog-coordinator only after canonical validation/);
    assert.match(coordinator.content, /Each consultation covers one candidate and one capability/);
    assert.match(coordinator.content, /Do not encode a provider, vendor, model, variant, or transport/);
    assert.match(coordinator.content, /implementation,\s+remediation, and blocker-resolution work on dog-worker/i);
    assert.match(coordinator.content, /findings from every subagent return\s+through\s+dog-coordinator/i);
    assert.match(coordinator.content, /do not repeat a recorded successful validation unless\s+relevant source changed/i);

    const takeover = coordinator.content.match(
      /TAKEOVER_FIXTURE\r?\n([\s\S]+?)\r?\nEND_TAKEOVER_FIXTURE/,
    );
    assert.ok(takeover, "coordinator needs same-task dog-worker takeover");
    assert.match(takeover[1], /same task_id \+ preserved effective inline handoff \+ bounded resume_delta/);
    assert.match(takeover[1], /roles:\s*remediation \| blocker-resolution/);
    assert.match(takeover[1], /route:\s*dog-coordinator -> dog-worker only/);

    const batchContinuation = coordinator.content.match(
      /BATCH_CONTINUATION_FIXTURE\r?\n([\s\S]+?)\r?\nEND_BATCH_CONTINUATION_FIXTURE/,
    );
    assert.ok(batchContinuation, "coordinator needs the single-worker terminal policy");
    assert.match(batchContinuation[1], /scope:\s*backlogDrain\.enabled=false; mode=runtime single-worker lane/);
    assert.match(batchContinuation[1], /top_level_request:\s*one accepted scope -> one worker/);
    assert.match(batchContinuation[1], /worker_return:\s*deterministic evidence verification -> terminal report/);
    assert.match(batchContinuation[1], /normal_path_forbidden:\s*second worker \| manual compaction \| synthetic continuation \| critical-path tracker call/);
    assert.match(batchContinuation[1], /native_compaction:\s*host overflow only/);
    assert.match(batchContinuation[1], /tracker_update:\s*after DONE; noncritical path/);
    assert.match(
      coordinator.content,
      /structured worker result containing the declared canonical command, exit 0, and a concise\s+fingerprint as deterministic evidence/i,
    );
    assert.match(coordinator.content, /Do not reread source, inspect Git, or rerun validation unless/i);
    assert.doesNotMatch(coordinator.content, /\bbatchDone\b/);

    const compactionIdentity = coordinator.content.match(
      /COMPACTION_IDENTITY_FIXTURE\r?\n([\s\S]+?)\r?\nEND_COMPACTION_IDENTITY_FIXTURE/,
    );
    assert.ok(compactionIdentity, "coordinator needs identity-safe compaction continuation");
    assert.match(compactionIdentity[1], /one resolver for direct tool \| continuation marker fallback \| step-exhausted fallback/);
    assert.match(compactionIdentity[1], /configured continuation agent \+ configured continuation capability required/);
    assert.match(compactionIdentity[1], /available root dog-coordinator; preserved across compaction/);
    assert.match(compactionIdentity[1], /another coordinator rejected/);
    assert.match(compactionIdentity[1], /child session -> root rejected/);
    assert.match(compactionIdentity[1], /automatic continuation disabled/);
    assert.match(compactionIdentity[1], /only when direct capability unavailable; never combine direct tool and marker/);
    assert.match(coordinator.content, /Only when the continuation guard proves an independent\s+next candidate/i);
    assert.match(
      coordinator.content,
      /normal single-worker terminal result has no independent next\s+candidate: do not call a compaction tool and do not emit either continuation marker/i,
    );
    assert.match(coordinator.content, /sortie_enable_backlog_drain exactly once/);
    assert.match(coordinator.content, /typed runtime opt-in is mandatory/i);
    // Every literal below must match a capability the packed plugin actually registers.
    assert.match(compactionIdentity[1], /continuation_agent:\s*dog-coordinator/);
    assert.match(compactionIdentity[1], /direct_capability:\s*sortie_compact_and_continue/);
    assert.match(compactionIdentity[1], /marker_literal:\s*<!-- SORTIE_CONTINUE -->/);
    assert.match(compactionIdentity[1], /legacy_stop_marker_literal:\s*<!-- SORTIE_COMPACT -->; runtime compatibility only; normal policy never emits it/);
    assert.ok(
      loaded.packedTools.includes(
        /direct_capability:\s*(\S+)/.exec(compactionIdentity[1])![1]!,
      ),
      "the packed plugin must register the capability the coordinator asset names",
    );
    assert.doesNotMatch(coordinator.content, /MK2A2|MKII_|MK4_|MK5_|MK6_/);
    assert.match(compactionIdentity[1], /final_unit:\s*terminal response with no forced compaction or resume/);
    assert.match(compactionIdentity[1], /pending_host_autocontinue:\s*no compaction/);
    assert.match(compactionIdentity[1], /same-turn stop; no tool \| Task \| analysis \| final/);
    assert.match(coordinator.content, /OpenCode owns token-limit automatic compaction; leave its auto-continue\s+enabled/);
    assert.doesNotMatch(coordinator.content, /stop compaction is universal/i);

    const backlogDrain = coordinator.content.match(
      /BACKLOG_DRAIN_FIXTURE\r?\n([\s\S]+?)\r?\nEND_BACKLOG_DRAIN_FIXTURE/,
    );
    assert.ok(backlogDrain, "coordinator needs an explicit backlog-drain policy");
    assert.match(backlogDrain[1], /default_config:\s*batchTarget=1; backlogDrain\.enabled=false; one accepted scope -> one worker/);
    assert.match(backlogDrain[1], /normal_multi_item:\s*1\.\.3 related requested items -> one accepted scope; no sequential worker units/);
    assert.doesNotMatch(coordinator.content, /default_config:\s*batchTarget=3/);
    assert.match(
      backlogDrain[1],
      /opt_in_required:\s*backlogDrain\.enabled=true; backlogDrain\.maxUnits=<positive integer>/,
    );
    assert.match(
      backlogDrain[1],
      /natural_language_opt_in:\s*explicit ordered 4\.\.11 units \+ sequential no-stop instruction -> enabled=true; maxUnits=exact named count/,
    );
    assert.match(backlogDrain[1], /over_ceiling:\s*12\+ named units -> ask user to split; never claim one-session no-stop execution/);
    assert.match(backlogDrain[1], /execution:\s*sequential; coordinator_authority=unchanged; per_unit_gates=unchanged/);
    assert.match(
      backlogDrain[1],
      /drain_counts:\s*batchAttempted=terminal handoffs; batchCommitted=new commits; batchReconciled=accepted existing commits/,
    );
    assert.match(
      backlogDrain[1],
      /display:\s*committed <batchCommitted>\/<backlogDrain\.maxUnits>; attempted <batchAttempted>\/<backlogDrain\.maxUnits>; reconciled <batchReconciled>/,
    );
    assert.match(backlogDrain[1], /inventory_acquisition:\s*once at drain start in one client invocation; never after compaction/);
    assert.match(backlogDrain[1], /inventory_page_1:\s*items\(first:100\)/);
    assert.match(
      backlogDrain[1],
      /inventory_next_page:\s*inside same invocation while pageInfo\.hasNextPage; after=pageInfo\.endCursor/,
    );
    assert.match(backlogDrain[1], /inventory_filter:\s*include every item whose status is not Done/);
    assert.match(backlogDrain[1], /candidate_queue:\s*at most backlogDrain\.maxUnits; deterministic acceptance fingerprint \+ hashes \+ bounded digest \+ required selection fields; raw body discarded/);
    assert.match(
      backlogDrain[1],
      /continuation:\s*terminal handoff -> session checkpoint -> local queue update -> compact resume; no tracker access/,
    );
    assert.match(backlogDrain[1], /source_identity:\s*preserve root source agent identity across drain compaction/);
    assert.match(backlogDrain[1], /child_promotion:\s*child session -> root rejected/);
    assert.match(backlogDrain[1], /pending_host_autocontinue:\s*drain compaction rejected/);
    assert.match(backlogDrain[1], /fallback_exclusivity:\s*direct capability or marker fallback; never both/);
    assert.match(
      backlogDrain[1],
      /attempted_count:\s*survive every compact resume; carry in session checkpoint and resume_delta/,
    );
    assert.match(
      backlogDrain[1],
      /max_guard_scope:\s*count attempted units across the whole drain run; never reset on resume/,
    );
    assert.match(backlogDrain[1], /progress:\s*compare bounded queue and terminal outcomes across a full resume cycle/);
    assert.match(
      backlogDrain[1],
      /stop:\s*no progress \| user decision \| proven external blocker \| backlogDrain\.maxUnits reached/,
    );
    assert.match(backlogDrain[1], /blocked_item:\s*continue with next independent item/);
    assert.match(backlogDrain[1], /tracker_flush:\s*once when drain stops; all pending updates in one direct invocation/);
    assert.match(backlogDrain[1], /queue_exhausted:\s*stop without inventory refresh; next top-level request may reacquire/);
    assert.doesNotMatch(coordinator.content, /\b(?:PVT|PVTI|PVTSF|PVTSSF)_[A-Za-z0-9]+\b/);

    const manifestScope = coordinator.content.match(
      /MANIFEST_SCOPE_FIXTURE\r?\n([\s\S]+?)\r?\nEND_MANIFEST_SCOPE_FIXTURE/,
    );
    assert.ok(manifestScope, "coordinator needs manifest scope examples");
    assert.match(manifestScope[1], /source_manifest:\s*\[src\/declared\.ts\]/);
    assert.match(manifestScope[1], /allowed:\s*write src\/declared\.ts/);
    assert.match(manifestScope[1], /rejected:\s*write src\/undeclared\.ts -> fail closed before mutation/);
    assert.match(coordinator.content, /operational work requires an exact operation_manifest/i);
    assert.match(coordinator.content, /undeclared write or mutation must be reported as rejected/i);
    assert.match(
      coordinator.content,
      /For read-only work, keep operation_manifest=none,[\s\S]{0,220}?omit\s+handoff_path,[\s\S]{0,120}?never inspect a handoff or call sortie_bind_write_gate/i,
    );
    const directOperations = coordinator.content.match(
      /COORDINATOR_DIRECT_OPERATION_FIXTURE\r?\n([\s\S]+?)\r?\nEND_COORDINATOR_DIRECT_OPERATION_FIXTURE/,
    );
    assert.ok(directOperations, "coordinator needs bounded direct operations");
    assert.match(directOperations[1], /known_executable_probe:\s*one batched direct depth-one read-only command; no Task/);
    assert.match(directOperations[1], /project_inventory:\s*exactly one complete snapshot per top-level user request in one direct client invocation; no Task/);
    assert.match(
      directOperations[1],
      /inventory_retry:\s*external failure -> forbidden; local construction \| JSON decode defect -> one corrected approved-client invocation; unchanged payload forbidden; total invocations <=2/,
    );
    assert.match(
      directOperations[1],
      /local_inventory_defect:\s*quoting \| variable binding \| stdout JSON decode before valid API result -> name defect; one corrected same-client same-query-shape invocation; no direct HTTP/,
    );
    assert.match(directOperations[1], /terminal_checkpoint:\s*append session-only pendingTrackerUpdates; no external tracker call per unit/);
    assert.match(directOperations[1], /batch_flush:\s*one coordinator-owned direct tracker invocation when batch stops; apply every pending update/);
    const releaseOwnership = coordinator.content.match(
      /RELEASE_OWNERSHIP_FIXTURE\r?\n([\s\S]+?)\r?\nEND_RELEASE_OWNERSHIP_FIXTURE/,
    );
    assert.ok(releaseOwnership, "coordinator needs explicit release-operation ownership");
    assert.match(releaseOwnership[1], /owner:\s*dog-coordinator direct; no Task/);
    assert.match(releaseOwnership[1], /remote push \| annotated tag creation and push \| release creation \| registry publication/);
    assert.match(releaseOwnership[1], /manifest:\s*none; no handoff \| operation manifest \| worker bind/);
    assert.match(releaseOwnership[1], /existing tag \| release \| registry version -> select next permitted version before commit/);
    assert.match(releaseOwnership[1], /routing defect -> coordinator direct; no allowlist change \| rebind \| redispatch/);
    assert.match(releaseOwnership[1], /source \| package-content assertions are preflight only; not runtime acceptance/);
    assert.match(releaseOwnership[1], /exact staged package \+ real deployment or update path \+ requested behavior or controlling asset provenance/);
    assert.match(releaseOwnership[1], /runtime_unavailable:\s*stop before promotion with exact needed evidence/);
    assert.match(releaseOwnership[1], /approval_boundary:\s*authorizes mutation; never waives acceptance/);
    assert.match(releaseOwnership[1], /actual installed or running target identity \+ behavior before DONE/);
    assert.match(releaseOwnership[1], /manual_boundary:\s*preserve project-defined manual publication step/);
    const writeGateHandoff = coordinator.content.match(
      /WRITE_GATE_HANDOFF_FIXTURE\r?\n([\s\S]+?)\r?\nEND_WRITE_GATE_HANDOFF_FIXTURE/,
    );
    assert.ok(writeGateHandoff, "coordinator needs the standard write-gate Handoff extension");
    assert.match(
      writeGateHandoff[1],
      /ext\["sortie-dogs\/write-gate"\] = \{ operation_manifest: <candidate-root-relative-path>, project_root: <candidate-root-absolute-path> \}/,
    );
    assert.match(writeGateHandoff[1], /timing:\s*bind before mutation/);
    assert.match(writeGateHandoff[1], /contract_id:\s*exact handoff id; safe \[A-Za-z0-9\._-\] token; unique among active coordinator roots/);
    assert.match(writeGateHandoff[1], /creation:\s*handoff\.<contract_id>\.json \+ <contract_id>\.operation-manifest\.json exist before Task dispatch/);
    assert.match(writeGateHandoff[1], /handoff_path:\s*exact absolute task-scoped candidate handoff path included in worker digest/);
    assert.match(writeGateHandoff[1], /authorization:\s*current session \+ current candidate only/);
    assert.match(writeGateHandoff[1], /handoff\.json \+ operation-manifest\.json are read-compatible only; never emitted for new mutating work/);
    assert.match(writeGateHandoff[1], /distinct contract_id \+ distinct files; one thread regeneration never revokes another/);
    assert.match(writeGateHandoff[1], /parent workspace \+ child repo -> project_root is child candidate absolute path/);
    assert.match(writeGateHandoff[1], /old candidate manifest or authorization rejected/);
    const terminalEvidence = coordinator.content.match(
      /TERMINAL_EVIDENCE_FIXTURE\r?\n([\s\S]+?)\r?\nEND_TERMINAL_EVIDENCE_FIXTURE/,
    );
    assert.ok(terminalEvidence, "coordinator needs complete terminal evidence");
    for (const field of [
      "status",
      "task_id",
      "manifest",
      "decisions",
      "validation",
      "scout",
      "tracker",
      "raw_status",
      "diff",
      "stale_paths",
      "new_findings",
      "next_action",
    ]) {
      assert.match(terminalEvidence[1], new RegExp(`^\\s*${field}:`, "m"));
    }
    assert.match(
      terminalEvidence[1],
      /manifest:\s*\{ source_manifest: <exact entries or none>, operation_manifest: <exact path or none> \}/,
    );
    assert.match(terminalEvidence[1], /validation:\s*\[\{ command: <exact command>, exit: <exit>, fingerprint: <concise fingerprint> \}\]/);
    assert.match(
      terminalEvidence[1],
      /scout:\s*\{ attempted: <boolean>, revision: <revision>, blocker_owner: <owner>, reason: <exact decision reason> \}/,
    );
    // A dispatched worker is gated by its session, so source work needs the same authorization.
    assert.match(
      worker.content,
      /Every mutating dispatch, source work included, carries an exact absolute handoff_path and an\s+operation_manifest/i,
    );
    assert.match(
      worker.content,
      /operation_manifest=none the dispatch is read-only:[\s\S]{0,220}?require no\s+handoff_path,[\s\S]{0,120}?never inspect a handoff, never call sortie_bind_write_gate/i,
    );
    assert.match(
      coordinator.content,
      /Never dispatch source-changing work with operation_manifest none[\s\S]{0,120}?denied every mutating tool/i,
    );
    assert.match(
      worker.content,
      /Return it unchanged together with bounded\s+candidate provenance[\s\S]{0,180}?task_id, both manifest values, ordered canonical\s+validation command\/exit\/fingerprint evidence, and Scout attempted\/revision\/blocker owner\/reason/i,
    );

    const recoverableHandshake = coordinator.content.match(
      /RECOVERABLE_HANDSHAKE_FIXTURE\r?\n([\s\S]+?)\r?\nEND_RECOVERABLE_HANDSHAKE_FIXTURE/,
    );
    assert.ok(recoverableHandshake, "coordinator needs recoverable denial provenance");
    assert.match(recoverableHandshake[1], /exactly one JSON object matching denial_shape/);
    assert.match(recoverableHandshake[1], /"denial"[\s\S]+"provenance"[\s\S]+"changes": "none"/);
    assert.match(
      recoverableHandshake[1],
      /operation manifest \+ valid registered handoff -> Task child activation -> built-in Read exact handoff_path -> bind in same turn/,
    );
    assert.match(recoverableHandshake[1], /second unchanged denial -> retry-exhausted and checkpoint/);
    assert.match(
      recoverableHandshake[1],
      /provenance:\s*\{ task_id: <stable task id>, manifest: \{ source_manifest: <exact entries or none>, operation_manifest: <exact path or none> \}, validation: \[\{ command: <exact command>, exit: <exit>, fingerprint: <concise fingerprint> \}\] \| \[\], scout: \{ attempted: <boolean>, revision: <revision>, blocker_owner: <owner>, reason: <exact decision reason> \} \}/,
    );

    const gatePolicy = coordinator.content.match(
      /GATE_POLICY_FIXTURE\r?\n([\s\S]+?)\r?\nEND_GATE_POLICY_FIXTURE/,
    );
    assert.ok(gatePolicy, "coordinator needs deterministic validation and review gates");
    assert.match(
      gatePolicy[1],
      /risk_rule: high when source_manifest has an entry outside test\/, validation level is targeted, or operation_manifest mutates non-artifact state; a qualifying artifact-only candidate is low-risk despite operation_manifest/,
    );
    assert.match(gatePolicy[1], /canonical_validation_nonzero: staging rejected; commit rejected/);
    assert.match(gatePolicy[1], /worker_stage_or_commit: rejected and reported/);
    assert.match(gatePolicy[1], /low_risk_validated: independent_review skipped and recorded; staging allowed/);
    assert.match(gatePolicy[1], /high_risk_unreviewed: staging rejected; commit rejected/);
    assert.match(gatePolicy[1], /high_risk_reviewer_unavailable: staging rejected; commit rejected/);
    assert.match(gatePolicy[1], /high_risk_validated_reviewed: staging allowed/);
    assert.match(
      coordinator.content,
      /high-risk candidate, run\s+dog-reviewer only after canonical validation passes[\s\S]+before the coordinator\s+stages or commits/i,
    );
    assert.match(coordinator.content, /low-risk candidate,\s+explicitly record dog-reviewer skipped/i);
    assert.match(coordinator.content, /dog-reviewer is unavailable or does not return PASS, fail closed before staging/i);
    const reviewRetry = coordinator.content.match(
      /CONSULTATION_FALLBACK_RETRY_FIXTURE\r?\n([\s\S]+?)\r?\nEND_CONSULTATION_FALLBACK_RETRY_FIXTURE/,
    );
    assert.ok(reviewRetry);
    assert.match(reviewRetry[1], /same validated SourceReview artifact exactly once/);
    assert.match(reviewRetry[1], /same Strategy request exactly once/);
    assert.match(reviewRetry[1], /parent_scope:\s*consume one retry for this parent coordinator and exact role/);
    assert.match(reviewRetry[1], /second_marker_or_empty_retry:\s*fail closed; no further retry/);

    const commitScope = coordinator.content.match(
      /COMMIT_SCOPE_FIXTURE\r?\n([\s\S]+?)\r?\nEND_COMMIT_SCOPE_FIXTURE/,
    );
    assert.ok(commitScope, "coordinator needs deterministic cached-path scope rules");
    assert.match(commitScope[1], /source_manifest: \[src\/declared\.ts\]/);
    assert.match(commitScope[1], /coordinator_stage: git add -- src\/declared\.ts/);
    assert.match(commitScope[1], /required: cached_paths set equals source_manifest set/);
    assert.match(commitScope[1], /mismatch: commit rejected/);

    assert.equal(classifyRisk(["test/manifest.txt"], "full"), "low");
    assert.equal(classifyRisk(["src/manifest.txt"], "full"), "high");
    assert.equal(classifyRisk(["test/manifest.txt"], "targeted"), "high");
    assert.equal(classifyRisk([], "full", ["deploy/config.json"]), "high");

    assert.deepEqual(loaded.reviewAvailability, { ok: false, code: "REVIEW_UNAVAILABLE" });
    assert.deepEqual(loaded.nonPassReviewGate, { ok: true, permitStage: false, verdict: "MUST_FIX" });
    const packedReviewRepo = await mkdtemp(join(testEnvironment, "git-packed-review-gate-"));
    try {
      await execFileAsync("git", ["-C", packedReviewRepo, "init", "--quiet"]);
      await mkdir(join(packedReviewRepo, "src"));
      await writeFile(join(packedReviewRepo, "src", "candidate.txt"), "candidate\n");
      const unavailableStagePermitted = loaded.reviewAvailability.ok;
      const nonPassStagePermitted = loaded.nonPassReviewGate.ok && loaded.nonPassReviewGate.permitStage === true;
      assert.equal(unavailableStagePermitted, false);
      assert.equal(nonPassStagePermitted, false);
      if (unavailableStagePermitted || nonPassStagePermitted) {
        await execFileAsync("git", ["-C", packedReviewRepo, "add", "--", "src/candidate.txt"]);
      }
      const { stdout: packedReviewCachedPaths } = await execFileAsync("git", [
        "-C",
        packedReviewRepo,
        "diff",
        "--cached",
        "--name-only",
      ]);
      assert.equal(packedReviewCachedPaths, "");
    } finally {
      await rm(packedReviewRepo, { recursive: true, force: true });
    }

    const failedValidationRepo = await mkdtemp(join(testEnvironment, "git-failed-validation-"));
    try {
      await execFileAsync("git", ["-C", failedValidationRepo, "init", "--quiet"]);
      await mkdir(join(failedValidationRepo, "src"));
      await writeFile(join(failedValidationRepo, "src", "manifest.txt"), "declared\n");
      await writeFile(join(failedValidationRepo, "undeclared.txt"), "outside manifest\n");

      const manifest = ["src/manifest.txt"];
      const risk = classifyRisk(manifest, "full");
      const failedValidation = gate({
        actor: "coordinator",
        intent: "stage",
        risk,
        validationExit: 1,
        reviewed: true,
        cachedPaths: [],
        manifest,
      });
      const workerStage = gate({
        actor: "worker",
        intent: "stage",
        risk,
        validationExit: 0,
        reviewed: true,
        cachedPaths: [],
        manifest,
      });
      const workerCommit = gate({
        actor: "worker",
        intent: "commit",
        risk,
        validationExit: 0,
        reviewed: true,
        cachedPaths: manifest,
        manifest,
      });
      assert.deepEqual(failedValidation, {
        action: "reject",
        report: ["canonical validation exit 1; stage rejected"],
      });
      assert.deepEqual(workerStage, {
        action: "reject",
        report: ["worker stage rejected and reported"],
      });
      assert.deepEqual(workerCommit, {
        action: "reject",
        report: ["worker commit rejected and reported"],
      });
      const { stdout: cachedPaths } = await execFileAsync("git", [
        "-C",
        failedValidationRepo,
        "diff",
        "--cached",
        "--name-only",
      ]);
      assert.equal(cachedPaths, "");
      await assert.rejects(
        execFileAsync("git", ["-C", failedValidationRepo, "rev-parse", "--verify", "HEAD"]),
      );
      const { stdout: status } = await execFileAsync("git", [
        "-C",
        failedValidationRepo,
        "status",
        "--porcelain",
      ]);
      assert.deepEqual(status.trim().split(/\r?\n/), ["?? src/", "?? undeclared.txt"]);
    } finally {
      await rm(failedValidationRepo, { recursive: true, force: true });
    }

    const lowRiskRepo = await mkdtemp(join(testEnvironment, "git-low-risk-"));
    try {
      await execFileAsync("git", ["-C", lowRiskRepo, "init", "--quiet"]);
      await mkdir(join(lowRiskRepo, "test"));
      await writeFile(join(lowRiskRepo, "test", "manifest.txt"), "declared\n");
      await writeFile(join(lowRiskRepo, "undeclared.txt"), "outside manifest\n");

      const manifest = ["test/manifest.txt"];
      const risk = classifyRisk(manifest, "full");
      const stageDecision = gate({
        actor: "coordinator",
        intent: "stage",
        risk,
        validationExit: 0,
        reviewed: false,
        cachedPaths: [],
        manifest,
      });
      assert.deepEqual(stageDecision, {
        action: "stage",
        report: ["independent review skipped and recorded"],
      });
      if (stageDecision.action === "stage") {
        await execFileAsync("git", ["-C", lowRiskRepo, "add", "--", ...manifest]);
      }
      const { stdout: cachedPaths } = await execFileAsync("git", [
        "-C",
        lowRiskRepo,
        "diff",
        "--cached",
        "--name-only",
      ]);
      const cached = cachedPaths.trim().split(/\r?\n/);
      assert.deepEqual(cached, manifest);
      const commitDecision = gate({
        actor: "coordinator",
        intent: "commit",
        risk,
        validationExit: 0,
        reviewed: false,
        cachedPaths: cached,
        manifest,
      });
      assert.deepEqual(commitDecision, {
        action: "commit",
        report: [
          "independent review skipped and recorded",
          "cached paths equal source_manifest; commit approved",
        ],
      });
      if (commitDecision.action === "commit") {
        await execFileAsync("git", [
          "-C",
          lowRiskRepo,
          "-c",
          "user.name=Sortie Test",
          "-c",
          "user.email=sortie@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "--quiet",
          "-m",
          "low-risk: independent review skipped and recorded",
        ]);
      }
      const { stdout: commitMessage } = await execFileAsync("git", [
        "-C",
        lowRiskRepo,
        "log",
        "-1",
        "--format=%s",
      ]);
      assert.equal(commitMessage.trim(), "low-risk: independent review skipped and recorded");
      const { stdout: committedPaths } = await execFileAsync("git", [
        "-C",
        lowRiskRepo,
        "show",
        "--pretty=format:",
        "--name-only",
        "HEAD",
      ]);
      assert.deepEqual(committedPaths.trim().split(/\r?\n/), manifest);
      const { stdout: status } = await execFileAsync("git", ["-C", lowRiskRepo, "status", "--porcelain"]);
      assert.equal(status.trim(), "?? undeclared.txt");
    } finally {
      await rm(lowRiskRepo, { recursive: true, force: true });
    }

    const highRiskRepo = await mkdtemp(join(testEnvironment, "git-high-risk-"));
    try {
      await execFileAsync("git", ["-C", highRiskRepo, "init", "--quiet"]);
      await mkdir(join(highRiskRepo, "src"));
      await writeFile(join(highRiskRepo, "src", "manifest.txt"), "declared\n");
      await writeFile(join(highRiskRepo, "undeclared.txt"), "outside manifest\n");

      const manifest = ["src/manifest.txt"];
      const risk = classifyRisk(manifest, "full");
      const unreviewedDecision = gate({
        actor: "coordinator",
        intent: "stage",
        risk,
        validationExit: 0,
        reviewed: false,
        cachedPaths: [],
        manifest,
      });
      assert.deepEqual(unreviewedDecision, {
        action: "reject",
        report: ["high-risk independent review required; stage rejected"],
      });
      const { stdout: unreviewedCachedPaths } = await execFileAsync("git", [
        "-C",
        highRiskRepo,
        "diff",
        "--cached",
        "--name-only",
      ]);
      assert.equal(unreviewedCachedPaths, "");
      await assert.rejects(execFileAsync("git", ["-C", highRiskRepo, "rev-parse", "--verify", "HEAD"]));

      const reviewedDecision = gate({
        actor: "coordinator",
        intent: "stage",
        risk,
        validationExit: 0,
        reviewed: true,
        cachedPaths: [],
        manifest,
      });
      assert.deepEqual(reviewedDecision, {
        action: "stage",
        report: ["independent review passed"],
      });
      if (reviewedDecision.action === "stage") {
        await execFileAsync("git", ["-C", highRiskRepo, "add", "--", ...manifest]);
      }
      await execFileAsync("git", ["-C", highRiskRepo, "add", "--", "undeclared.txt"]);
      const { stdout: reviewedCachedPaths } = await execFileAsync("git", [
        "-C",
        highRiskRepo,
        "diff",
        "--cached",
        "--name-only",
      ]);
      const mismatchedCache = reviewedCachedPaths.trim().split(/\r?\n/);
      assert.deepEqual(mismatchedCache, ["src/manifest.txt", "undeclared.txt"]);
      const mismatchDecision = gate({
        actor: "coordinator",
        intent: "commit",
        risk,
        validationExit: 0,
        reviewed: true,
        cachedPaths: mismatchedCache,
        manifest,
      });
      assert.deepEqual(mismatchDecision, {
        action: "reject",
        report: [
          "independent review passed",
          "cached paths differ from source_manifest; commit rejected",
        ],
      });
      await assert.rejects(execFileAsync("git", ["-C", highRiskRepo, "rev-parse", "--verify", "HEAD"]));

      await execFileAsync("git", ["-C", highRiskRepo, "rm", "--cached", "--quiet", "--", "undeclared.txt"]);
      const { stdout: restoredCachedPaths } = await execFileAsync("git", [
        "-C",
        highRiskRepo,
        "diff",
        "--cached",
        "--name-only",
      ]);
      const restoredCache = restoredCachedPaths.trim().split(/\r?\n/);
      assert.deepEqual(restoredCache, manifest);
      const commitDecision = gate({
        actor: "coordinator",
        intent: "commit",
        risk,
        validationExit: 0,
        reviewed: true,
        cachedPaths: restoredCache,
        manifest,
      });
      assert.equal(commitDecision.action, "commit");
      if (commitDecision.action === "commit") {
        await execFileAsync("git", [
          "-C",
          highRiskRepo,
          "-c",
          "user.name=Sortie Test",
          "-c",
          "user.email=sortie@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "--quiet",
          "-m",
          "high-risk: independent review passed",
        ]);
      }
      const { stdout: committedPaths } = await execFileAsync("git", [
        "-C",
        highRiskRepo,
        "show",
        "--pretty=format:",
        "--name-only",
        "HEAD",
      ]);
      assert.deepEqual(committedPaths.trim().split(/\r?\n/), manifest);
      const { stdout: status } = await execFileAsync("git", ["-C", highRiskRepo, "status", "--porcelain"]);
      assert.equal(status.trim(), "?? undeclared.txt");
    } finally {
      await rm(highRiskRepo, { recursive: true, force: true });
    }

    assert.match(sortie.content, /Do not preflight installed runtime assets/i);
    assert.match(sortie.content, /plugin reports version skew without adding model\s+turns/i);
    assert.doesNotMatch(sortie.content, /\.opencode\/sortie-dogs\.version/i);
    assert.match(sortie.content, /\$ARGUMENTS/);
    assert.match(sortie.content, /if \$ARGUMENTS is empty, request task context and stop/i);
    assert.ok(sortie.content.length < 900, "sortie command should remain concise");
    const sortieFrontmatter = sortie.content.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n/);
    assert.ok(sortieFrontmatter);
    const routeLines = sortieFrontmatter[1].match(/^agent:\s*.+$/gmu) ?? [];
    assert.deepEqual(routeLines, ["agent: dog-coordinator"]);
    assert.doesNotMatch(sortieFrontmatter[1], /^agent:\s*(?:build|alternate-coordinator)\s*$/imu);
    assert.match(sortie.content, /single coordinator\s+transfer/i);
    assert.match(
      sortie.content,
      /restart or re-entry[\s\S]+project-local durable artifacts and the\s+latest bounded handoff or checkpoint/i,
    );
    assert.match(
      sortie.content,
      /preserve both manifests and ordered validation history/i,
    );
    assert.match(sortie.content, /resume the same task through dog-coordinator/i);
    assert.match(sortie.content, /never route a worker to the user/i);

    for (const asset of loaded.runtimeAssets) {
      assert.equal(asset.version, "0.3.12-dispatch-preflight-v1");
      const frontmatter = asset.content.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n/);
      assert.ok(frontmatter, `${asset.name} must have frontmatter`);
      const entries = Object.fromEntries(
        frontmatter[1].split(/\r?\n/).map((line) => {
          const separator = line.indexOf(":");
          assert.notEqual(separator, -1, `${asset.name} has malformed frontmatter`);
          return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
        }),
      );
      assert.ok(entries.description, `${asset.name} needs a description`);
      if (asset.name === "dog-coordinator") assert.equal(entries.mode, "primary");
      if (["dog-worker", "dog-scout", "dog-reviewer", "dog-advisor"].includes(asset.name)) {
        assert.equal(entries.mode, "subagent");
      }
      if (asset.name === "sortie") assert.equal(entries.agent, "dog-coordinator");
      assert.doesNotMatch(
        asset.content,
        /project\s+helper|capsule|controller|\bFSM\b|routing\s+ledger|dedicated\s+harness|alternate\s+orchestrator/i,
        `${asset.name} must not reference forbidden artifacts`,
      );
    }
    assert.equal(new Set(loaded.runtimeAssets.map(({ version }) => version)).size, 1);
    assert.doesNotMatch(
      loaded.runtimeAssets.map(({ content }) => content).join("\n"),
      /mk2a2/i,
    );
    assert.doesNotMatch(
      loaded.runtimeAssets.filter(({ name }) => name !== "sortie").map(({ name, installPath }) => `${name}:${installPath}`).join("\n"),
      /coordinator-mk2a2|sol-worker-mk2a2/,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
