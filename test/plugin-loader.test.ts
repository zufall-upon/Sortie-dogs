import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const testEnvironment = fileURLToPath(new URL("../_testenv/", import.meta.url));
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const execFileAsync = promisify(execFile);

type CandidateRisk = "low" | "high";
type ValidationLevel = "targeted" | "full";

function classifyRisk(manifest: readonly string[], validationLevel: ValidationLevel): CandidateRisk {
  return validationLevel === "targeted" || manifest.some((path) => !path.startsWith("test/"))
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

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const [{ SortieDogsPlugin }, { runtimeAssets }] = await Promise.all([
          import('sortie-dogs/plugin'),
          import('sortie-dogs/assets'),
        ]);
        process.stdout.write(JSON.stringify({ pluginType: typeof SortieDogsPlugin, runtimeAssets }));`,
      ],
      { cwd: consumer },
    );
    const loaded = JSON.parse(stdout) as {
      pluginType: string;
      runtimeAssets: Array<{
        name: string;
        version: string;
        installPath: string;
        content: string;
      }>;
    };
    assert.equal(loaded.pluginType, "function");
    assert.equal(loaded.runtimeAssets.length, 3);
    assert.deepEqual(
      loaded.runtimeAssets.map(({ name, installPath }) => ({ name, installPath })),
      [
        { name: "coordinator-mk2a2", installPath: "agent/coordinator-mk2a2.md" },
        { name: "sol-worker-mk2a2", installPath: "agent/sol-worker-mk2a2.md" },
        { name: "sortie", installPath: "command/sortie.md" },
      ],
    );

    const coordinator = loaded.runtimeAssets.find(({ name }) => name === "coordinator-mk2a2");
    const sortie = loaded.runtimeAssets.find(({ name }) => name === "sortie");
    assert.ok(coordinator);
    assert.ok(sortie);

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
    assert.match(resumedHandoff[1], /next_action:/);
    assert.doesNotMatch(resumedHandoff[1], /project_root:|command:\s*</);

    const batchContinuation = coordinator.content.match(
      /BATCH_CONTINUATION_FIXTURE\r?\n([\s\S]+?)\r?\nEND_BATCH_CONTINUATION_FIXTURE/,
    );
    assert.ok(batchContinuation, "coordinator needs bounded batch continuation policy");
    assert.match(batchContinuation[1], /fresh_session:\s*max_units=3; batchAttempted=0; batchDone=0/);
    assert.match(batchContinuation[1], /order:\s*sequential/);
    assert.match(batchContinuation[1], /unit_N_plus_1_start:\s*only after unit N terminal handoff/);
    assert.match(batchContinuation[1], /terminal_unit:\s*increment batchAttempted; record Project status checkpoint/);
    assert.match(batchContinuation[1], /successful_commit:\s*increment batchDone/);
    assert.match(
      batchContinuation[1],
      /blocked_unit:\s*record blocker with concrete needed action; continue to next independent unit/,
    );
    assert.match(batchContinuation[1], /early_stop:\s*only whole-batch blocker or user question/);
    assert.match(batchContinuation[1], /fourth_unit:\s*rejected/);
    assert.match(batchContinuation[1], /noncomplete_handoff:\s*exact next action required/);
    assert.match(batchContinuation[1], /completed handoff:\s*completion evidence required/);

    const manifestScope = coordinator.content.match(
      /MANIFEST_SCOPE_FIXTURE\r?\n([\s\S]+?)\r?\nEND_MANIFEST_SCOPE_FIXTURE/,
    );
    assert.ok(manifestScope, "coordinator needs manifest scope examples");
    assert.match(manifestScope[1], /source_manifest:\s*\[src\/declared\.ts\]/);
    assert.match(manifestScope[1], /allowed:\s*write src\/declared\.ts/);
    assert.match(manifestScope[1], /rejected:\s*write src\/undeclared\.ts -> fail closed before mutation/);
    assert.match(coordinator.content, /operational work requires an exact operation_manifest/i);
    assert.match(coordinator.content, /undeclared write or mutation must be reported as rejected/i);
    assert.match(coordinator.content, /validation attempts in order with exact command,\s*\nexit, and fingerprint/i);

    const gatePolicy = coordinator.content.match(
      /GATE_POLICY_FIXTURE\r?\n([\s\S]+?)\r?\nEND_GATE_POLICY_FIXTURE/,
    );
    assert.ok(gatePolicy, "coordinator needs deterministic validation and review gates");
    assert.match(
      gatePolicy[1],
      /risk_rule: high when any source_manifest entry is outside test\/, or validation level is targeted; otherwise low/,
    );
    assert.match(gatePolicy[1], /canonical_validation_nonzero: staging rejected; commit rejected/);
    assert.match(gatePolicy[1], /worker_stage_or_commit: rejected and reported/);
    assert.match(gatePolicy[1], /low_risk_validated: independent_review skipped and recorded; staging allowed/);
    assert.match(gatePolicy[1], /high_risk_unreviewed: staging rejected; commit rejected/);
    assert.match(gatePolicy[1], /high_risk_validated_reviewed: staging allowed/);

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

    assert.match(sortie.content, /preflight the current project/i);
    assert.match(sortie.content, /\.opencode\/sortie-dogs\.version/i);
    assert.match(sortie.content, /\.opencode\/agent\/coordinator-mk2a2\.md/i);
    assert.match(sortie.content, /\.opencode\/agent\/sol-worker-mk2a2\.md/i);
    assert.match(sortie.content, /\.opencode\/command\/sortie\.md/i);
    assert.match(sortie.content, /gather the inline task entry context/i);
    assert.match(sortie.content, /\$ARGUMENTS/);
    const sortieFrontmatter = sortie.content.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n/);
    assert.ok(sortieFrontmatter);
    const routeLines = sortieFrontmatter[1].match(/^agent:\s*.+$/gmu) ?? [];
    assert.deepEqual(routeLines, ["agent: coordinator-mk2a2"]);
    assert.doesNotMatch(sortieFrontmatter[1], /^agent:\s*(?:build|alternate-coordinator)\s*$/imu);
    assert.match(sortie.content, /single coordinator transfer/i);

    for (const asset of loaded.runtimeAssets) {
      assert.equal(asset.version, "0.2.0-card04");
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
      if (asset.name === "coordinator-mk2a2") assert.equal(entries.mode, "primary");
      if (asset.name === "sol-worker-mk2a2") assert.equal(entries.mode, "subagent");
      if (asset.name === "sortie") assert.equal(entries.agent, "coordinator-mk2a2");
      assert.doesNotMatch(
        asset.content,
        /project\s+helper|capsule|controller|\bFSM\b|routing\s+ledger|dedicated\s+harness|alternate\s+orchestrator/i,
        `${asset.name} must not reference forbidden artifacts`,
      );
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
