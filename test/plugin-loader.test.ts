import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { DEDICATED_SOL_MODEL, DEDICATED_SOL_VARIANT } from "../dist/plugin/model-routing.js";

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
    const packed = JSON.parse(packOutput) as Array<{ filename: string }>;
    assert.equal(packed.length, 1);
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
        `const [{ SortieDogsPlugin }, { runtimeAssets }, root, consultation] = await Promise.all([
          import('sortie-dogs/plugin'),
          import('sortie-dogs/assets'),
          import('sortie-dogs'),
          import('./node_modules/sortie-dogs/dist/core/consultation.js'),
        ]);
        const consultationValueNames = ${JSON.stringify(consultationValueNames)};
        const artifact = {
          schemaVersion: 1,
          candidateId: 'packed-candidate',
          sourceFingerprint: 'packed-source-v1',
          acceptance: ['fail closed before staging'],
          manifest: ['src/runtime-assets.ts'],
          riskTags: ['public-api'],
          riskBearingHunks: ['src/runtime-assets.ts:1-2'],
          validation: { command: 'npm test', exit: 0, fingerprint: 'packed-validation-v1' },
          invariants: ['dog-reviewer-only'],
        };
        process.stdout.write(JSON.stringify({
          pluginType: typeof SortieDogsPlugin,
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
      { cwd: consumer },
    );
    const loaded = JSON.parse(stdout) as {
      pluginType: string;
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
      worker.content,
      new RegExp(`model: ${DEDICATED_SOL_MODEL.replace("/", "\\/")}\\r?\\nvariant: ${DEDICATED_SOL_VARIANT}`),
    );

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
      /assigned parallel role A \(manifest\), B \(canonical validation\), or C \(blocker owner\)[\s\S]+known_paths list of at most four paths[\s\S]+Use Read only[\s\S]+at most 120 lines per read[\s\S]+no more than one read per path[\s\S]+Do not explore for more paths, invoke another tool, retry/i,
    );
    assert.match(
      scout.content,
      /exactly one concise JSON object of at most 800 characters with exactly these keys: role,\s+facts, evidence_paths, risks[\s\S]+no Markdown, code fence, commentary, or raw log/i,
    );
    assert.ok(scout.content.length >= 350, "dog-scout needs a substantive bounded role");
    assert.match(
      reviewer.content,
      /only one bounded SourceReview request from dog-coordinator[\s\S]+after canonical\s+validation for one high-risk candidate[\s\S]+Do not request raw logs or full source\s+files[\s\S]+Return one concise PASS or concrete-finding response only to dog-coordinator/i,
    );
    assert.ok(reviewer.content.length >= 350, "dog-reviewer needs a substantive risk-gated role");
    assert.match(
      advisor.content,
      /only one bounded Strategy request from dog-coordinator[\s\S]+one candidate and one focused\s+question[\s\S]+Do not request raw logs or full source files[\s\S]+options and one recommendation only to dog-coordinator/i,
    );
    assert.match(advisor.content, /Reject every SourceReview request[\s\S]+SourceReview is\s+dog-reviewer-only work/i);
    assert.doesNotMatch(advisor.content, /Accept[^.]*SourceReview/i);
    assert.ok(advisor.content.length >= 350, "dog-advisor needs a substantive consultation role");
    for (const consultationAsset of [coordinator, reviewer, advisor]) {
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
    assert.match(coordinator.content, /never invoke the build\s+agent or any alternate coordinator/i);

    const initialHandoff = coordinator.content.match(
      /INITIAL_HANDOFF_FIXTURE\r?\n([\s\S]+?)\r?\nEND_INITIAL_HANDOFF_FIXTURE/,
    );
    assert.ok(initialHandoff, "coordinator needs an initial handoff fixture");
    assert.match(initialHandoff[1], /task_id:/);
    assert.match(initialHandoff[1], /context_digest:/);
    assert.match(initialHandoff[1], /project_root:/);
    assert.match(initialHandoff[1], /acceptance:/);
    assert.match(initialHandoff[1], /role:\s*implementation/);
    assert.match(initialHandoff[1], /validation:\s*\{\s*level:\s*full,\s*command:/);
    assert.match(initialHandoff[1], /known_facts:/);
    assert.match(initialHandoff[1], /known_paths:\s*\[<up to 4 exact paths>\]/);
    assert.match(initialHandoff[1], /relevant_constraints:/);
    assert.match(initialHandoff[1], /resume_delta:\s*none/);
    assert.match(initialHandoff[1], /source_manifest:/);
    assert.match(initialHandoff[1], /operation_manifest:\s*none/);

    const resumedHandoff = coordinator.content.match(
      /RESUMED_HANDOFF_FIXTURE\r?\n([\s\S]+?)\r?\nEND_RESUMED_HANDOFF_FIXTURE/,
    );
    assert.ok(resumedHandoff, "coordinator needs a same-task resume fixture");
    assert.match(resumedHandoff[1], /mode:\s*same-task-resume/);
    assert.match(resumedHandoff[1], /preserve:\s*\[acceptance, role, validation, known_facts,/);
    assert.match(resumedHandoff[1], /resume_delta:/);
    assert.match(resumedHandoff[1], /stale_paths:/);
    assert.match(resumedHandoff[1], /new_findings:/);
    assert.match(resumedHandoff[1], /previous_exit:/);
    assert.match(resumedHandoff[1], /scoutAttempted:\s*<preserved candidate boolean>/);
    assert.match(resumedHandoff[1], /scoutRevision:\s*<preserved candidate revision>/);
    assert.match(resumedHandoff[1], /scout_reason:\s*<exact skip or retry reason>/);
    assert.match(resumedHandoff[1], /next_action:/);
    assert.doesNotMatch(resumedHandoff[1], /project_root:|command:\s*</);

    const restartRecovery = coordinator.content.match(
      /RESTART_RECOVERY_FIXTURE\r?\n([\s\S]+?)\r?\nEND_RESTART_RECOVERY_FIXTURE/,
    );
    assert.ok(restartRecovery, "coordinator needs restart recovery policy");
    assert.match(
      restartRecovery[1],
      /reconstruction:\s*project-local durable artifacts \+ latest bounded handoff\/checkpoint/,
    );
    assert.match(restartRecovery[1], /preserve:\s*\[source_manifest, operation_manifest, validation_history\]/);
    assert.match(
      restartRecovery[1],
      /validation_history_entry:\s*\{ command: <exact command>, exit: <exit>, fingerprint: <concise fingerprint> \}/,
    );
    assert.match(restartRecovery[1], /resume_route:\s*dog-coordinator -> dog-worker/);
    assert.match(restartRecovery[1], /user_route:\s*dog-coordinator only/);
    assert.match(coordinator.content, /dispatch implementation only to dog-worker/i);
    const scoutSkip = coordinator.content.match(
      /SCOUT_SKIP_FIXTURE\r?\n([\s\S]+?)\r?\nEND_SCOUT_SKIP_FIXTURE/,
    );
    assert.ok(scoutSkip, "coordinator needs the Scout skip branch");
    assert.match(scoutSkip[1], /exact manifest \+ canonical validation \+ blocker owner all fixed/);
    assert.match(scoutSkip[1], /candidate_default:\s*at most one Scout fan-out/);
    assert.match(scoutSkip[1], /first_handoff_skip:\s*simple <=2 files \| compact resume/);
    assert.match(scoutSkip[1], /scoutAttempted:\s*true when same-candidate Scout evidence exists/);
    assert.match(scoutSkip[1], /revision_guard:\s*same scoutRevision may not fan-out twice/);
    assert.match(scoutSkip[1], /no re-Scout even when manifest, validation, or owner remains unresolved/);
    assert.match(scoutSkip[1], /route same dog-worker with role=blocker-resolution/);
    assert.match(scoutSkip[1], /new revision \+ stale_paths that actually invalidate manifest, validation, or owner/);
    assert.match(scoutSkip[1], /unrelated_stale_path:\s*retain scoutAttempted; no retry/);
    assert.match(scoutSkip[1], /checkpoint decisions\[\] and resume_delta record scoutAttempted \+ scoutRevision \+ exact skip or retry reason/);
    assert.match(scoutSkip[1], /known_paths:\s*worker read boundary even without Scout read/);
    assert.match(scoutSkip[1], /action:\s*route directly to dog-worker/);

    type ScoutSkipEvidence = {
      exactManifest: boolean;
      canonicalValidation: boolean;
      blockerOwner: boolean;
      editableFiles: number;
      compactResume?: boolean;
      scoutAttempted?: boolean;
      revision: string;
      scoutAttemptedRevision?: string;
      stalePathsInvalidateDecision?: boolean;
    };
    const shouldSkipScout = (evidence: ScoutSkipEvidence): boolean => {
      const exactEvidence = evidence.exactManifest && evidence.canonicalValidation && evidence.blockerOwner;
      if (evidence.scoutAttempted === true) {
        if (evidence.scoutAttemptedRevision === evidence.revision) return true;
        return evidence.stalePathsInvalidateDecision !== true;
      }
      return exactEvidence && (evidence.editableFiles <= 2 || evidence.compactResume === true);
    };
    const exactEvidence = {
      exactManifest: true,
      canonicalValidation: true,
      blockerOwner: true,
      revision: "r1",
    };
    assert.equal(shouldSkipScout({ ...exactEvidence, editableFiles: 2 }), true);
    assert.equal(shouldSkipScout({ ...exactEvidence, editableFiles: 3, compactResume: true }), true);
    assert.equal(
      shouldSkipScout({
        exactManifest: false,
        canonicalValidation: false,
        blockerOwner: false,
        editableFiles: 3,
        scoutAttempted: true,
        revision: "r1",
        scoutAttemptedRevision: "r1",
      }),
      true,
    );
    assert.equal(shouldSkipScout({ ...exactEvidence, editableFiles: 3 }), false);
    assert.equal(
      shouldSkipScout({
        ...exactEvidence,
        editableFiles: 3,
        scoutAttempted: true,
        scoutAttemptedRevision: "r1",
        stalePathsInvalidateDecision: true,
      }),
      true,
    );
    assert.equal(
      shouldSkipScout({
        ...exactEvidence,
        editableFiles: 3,
        scoutAttempted: true,
        revision: "r2",
        scoutAttemptedRevision: "r1",
        stalePathsInvalidateDecision: true,
      }),
      false,
    );
    assert.equal(
      shouldSkipScout({
        ...exactEvidence,
        editableFiles: 3,
        scoutAttempted: true,
        revision: "r2",
        scoutAttemptedRevision: "r1",
        stalePathsInvalidateDecision: false,
      }),
      true,
    );
    for (const absent of ["exactManifest", "canonicalValidation", "blockerOwner"] as const) {
      assert.equal(shouldSkipScout({ ...exactEvidence, [absent]: false, editableFiles: 2 }), false);
    }

    const scoutFanout = coordinator.content.match(
      /SCOUT_FANOUT_FIXTURE\r?\n([\s\S]+?)\r?\nEND_SCOUT_FANOUT_FIXTURE/,
    );
    assert.ok(scoutFanout, "coordinator needs the required three-role scout fan-out");
    assert.match(scoutFanout[1], /required for unresolved or complex candidate not skipped/);
    assert.match(scoutFanout[1], /dispatch_guard:\s*scoutAttempted=false for current scoutRevision/);
    assert.match(scoutFanout[1], /exactly three bounded dog-scout calls in one parallel fan-out/);
    assert.match(scoutFanout[1], /role_A:\s*determine exact source_manifest or operation_manifest/);
    assert.match(scoutFanout[1], /role_B:\s*determine exact canonical validation command/);
    assert.match(scoutFanout[1], /role_C:\s*identify blocker owner/);
    assert.match(scoutFanout[1], /known_paths:\s*at most 4 supplied paths per scout/);
    assert.match(scoutFanout[1], /worker_gate:\s*one bounded scout step, then dog-worker/);
    assert.match(scoutFanout[1], /union all well-formed facts; no voting or majority rule/);
    assert.match(scoutFanout[1], /malformed \| timeout \| empty -> discard without retry/);
    assert.match(scoutFanout[1], /after_dispatch:\s*scoutAttempted=true for current scoutRevision even when evidence remains unresolved/);
    assert.match(scoutFanout[1], /implementation \| remediation \| blocker-resolution -> dog-worker only/);
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
    assert.ok(batchContinuation, "coordinator needs bounded batch continuation policy");
    assert.match(
      batchContinuation[1],
      /scope:\s*backlogDrain\.enabled=false; mode=normal bounded batch/,
    );
    assert.match(
      batchContinuation[1],
      /fresh_session:\s*max_units=3; batchAttempted=0; batchCommitted=0; batchReconciled=0/,
    );
    assert.match(
      batchContinuation[1],
      /display:\s*committed <batchCommitted>\/<batchTarget>; attempted <batchAttempted>\/<batchTarget>; reconciled <batchReconciled>/,
    );
    assert.match(batchContinuation[1], /order:\s*sequential/);
    assert.match(batchContinuation[1], /unit_N_plus_1_start:\s*only after unit N terminal handoff/);
    assert.match(batchContinuation[1], /terminal_unit:\s*increment batchAttempted; record Project status checkpoint/);
    assert.match(batchContinuation[1], /new_successful_commit:\s*increment batchCommitted only/);
    assert.match(batchContinuation[1], /existing_commit_accepted:\s*increment batchReconciled only/);
    assert.match(
      batchContinuation[1],
      /blocked_unit:\s*increment batchAttempted only; record blocker with concrete needed action; continue to next independent unit/,
    );
    assert.match(
      batchContinuation[1],
      /compact_guard:\s*batchAttempted < batchTarget and independent next candidate exists/,
    );
    assert.match(batchContinuation[1], /compact_action:\s*after checkpoint invoke configured continuation; then same-turn stop/);
    assert.match(batchContinuation[1], /early_stop:\s*only whole-batch blocker or user question/);
    assert.match(batchContinuation[1], /fourth_unit:\s*rejected/);
    assert.match(batchContinuation[1], /noncomplete_handoff:\s*exact next action required/);
    assert.match(batchContinuation[1], /completed handoff:\s*completion evidence required/);
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
    assert.match(compactionIdentity[1], /final_unit:\s*no compaction/);
    assert.match(compactionIdentity[1], /pending_host_autocontinue:\s*no compaction/);
    assert.match(compactionIdentity[1], /same-turn stop; no tool \| Task \| analysis \| final/);

    const backlogDrain = coordinator.content.match(
      /BACKLOG_DRAIN_FIXTURE\r?\n([\s\S]+?)\r?\nEND_BACKLOG_DRAIN_FIXTURE/,
    );
    assert.ok(backlogDrain, "coordinator needs an explicit backlog-drain policy");
    assert.match(backlogDrain[1], /default_config:\s*batchTarget=3; backlogDrain\.enabled=false/);
    assert.match(
      backlogDrain[1],
      /opt_in_required:\s*backlogDrain\.enabled=true; backlogDrain\.maxUnits=<positive integer>/,
    );
    assert.match(backlogDrain[1], /execution:\s*sequential; coordinator_authority=unchanged; per_unit_gates=unchanged/);
    assert.match(
      backlogDrain[1],
      /drain_counts:\s*batchAttempted=terminal handoffs; batchCommitted=new commits; batchReconciled=accepted existing commits/,
    );
    assert.match(
      backlogDrain[1],
      /display:\s*committed <batchCommitted>\/<backlogDrain\.maxUnits>; attempted <batchAttempted>\/<backlogDrain\.maxUnits>; reconciled <batchReconciled>/,
    );
    assert.match(backlogDrain[1], /inventory_page_1:\s*items\(first:100\)/);
    assert.match(
      backlogDrain[1],
      /inventory_next_page:\s*while pageInfo\.hasNextPage; after=pageInfo\.endCursor/,
    );
    assert.match(backlogDrain[1], /inventory_filter:\s*include every item whose status is not Done/);
    assert.match(
      backlogDrain[1],
      /continuation:\s*terminal handoff -> Project checkpoint -> same identity-preserving resolver -> compact resume -> complete reinventory/,
    );
    assert.match(backlogDrain[1], /source_identity:\s*preserve root source agent identity across drain compaction/);
    assert.match(backlogDrain[1], /child_promotion:\s*child session -> root rejected/);
    assert.match(backlogDrain[1], /pending_host_autocontinue:\s*drain compaction rejected/);
    assert.match(backlogDrain[1], /fallback_exclusivity:\s*direct capability or marker fallback; never both/);
    assert.match(
      backlogDrain[1],
      /attempted_count:\s*survive every compact resume; carry in Project checkpoint and resume_delta/,
    );
    assert.match(
      backlogDrain[1],
      /max_guard_scope:\s*count attempted units across the whole drain run; never reset on resume/,
    );
    assert.match(backlogDrain[1], /progress:\s*compare complete inventory and terminal outcomes across a full resume cycle/);
    assert.match(
      backlogDrain[1],
      /stop:\s*no progress \| user decision \| proven external blocker \| backlogDrain\.maxUnits reached/,
    );
    assert.match(backlogDrain[1], /blocked_item:\s*continue with next independent item/);
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
    const writeGateHandoff = coordinator.content.match(
      /WRITE_GATE_HANDOFF_FIXTURE\r?\n([\s\S]+?)\r?\nEND_WRITE_GATE_HANDOFF_FIXTURE/,
    );
    assert.ok(writeGateHandoff, "coordinator needs the standard write-gate Handoff extension");
    assert.match(
      writeGateHandoff[1],
      /ext\["sortie-dogs\/write-gate"\] = \{ operation_manifest: <candidate-root-relative-path>, project_root: <candidate-root-absolute-path> \}/,
    );
    assert.match(writeGateHandoff[1], /timing:\s*bind before mutation/);
    assert.match(writeGateHandoff[1], /authorization:\s*current session \+ current candidate only/);
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
      "raw_status",
      "diff",
      "stale_paths",
      "new_findings",
      "next_action",
    ]) {
      assert.match(terminalEvidence[1], new RegExp(`^\\s*${field}:`, "m"));
    }
    assert.match(terminalEvidence[1], /validation:\s*\[\{ command: <exact command>, exit: <exit>, fingerprint: <concise fingerprint> \}\]/);

    const gatePolicy = coordinator.content.match(
      /GATE_POLICY_FIXTURE\r?\n([\s\S]+?)\r?\nEND_GATE_POLICY_FIXTURE/,
    );
    assert.ok(gatePolicy, "coordinator needs deterministic validation and review gates");
    assert.match(
      gatePolicy[1],
      /risk_rule: high when operation_manifest is non-empty, any source_manifest entry is outside test\/, or validation level is targeted; otherwise low/,
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

    assert.match(sortie.content, /preflight/i);
    assert.match(sortie.content, /\.opencode\/sortie-dogs\.version/i);
    for (const name of ["dog-coordinator", "dog-worker", "dog-scout", "dog-reviewer", "dog-advisor"]) {
      assert.match(sortie.content, new RegExp(`${name}\\.md`, "i"));
    }
    assert.match(sortie.content, /command\/sortie\.md/i);
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
      assert.equal(asset.version, "0.2.0-card05");
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
