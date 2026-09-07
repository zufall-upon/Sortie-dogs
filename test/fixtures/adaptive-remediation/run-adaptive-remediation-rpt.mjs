import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AdaptiveRemediationRuntime, AdaptiveRunFlightLineage } from "../../../dist/core/adaptive-remediation-runtime.js";
import { RunFlightLedger } from "../../../dist/core/run-flight-ledger.js";
import { EvidenceCapsuleStore } from "../../../dist/core/evidence-capsule.js";
import { GitAdaptiveRemediationHost } from "../../../dist/plugin/adaptive-remediation-host.js";

const run = (file, args, cwd) => new Promise((ok, fail) => execFile(file, args, { cwd, encoding: "utf8", timeout: 60000 },
  (error, stdout) => error === null ? ok(stdout.trim()) : fail(error)));
const rootArg = process.argv.find((value) => value.startsWith("--evidence="))?.slice(11);
const platform = process.argv.find((value) => value.startsWith("--platform="))?.slice(11) ?? "windows";
if (!rootArg || !["windows", "wsl"].includes(platform)) throw new Error("usage: --evidence=<absolute-path> --platform=windows|wsl");
const evidencePath = resolve(rootArg), root = dirname(evidencePath);
await mkdir(root, { recursive: true });
function resolveOpenCode(environment) {
  return typeof environment.OPENCODE_BIN === "string" && environment.OPENCODE_BIN.trim() !== ""
    ? environment.OPENCODE_BIN.trim() : "opencode";
}
const OPENCODE = resolveOpenCode(process.env);

const eligibility = { platform, canonical_validation_expensive: true, repeatable_typed_signal: true, signal_id: "errors",
  signal_definition: "numeric count emitted as typed JSON", patch_reversible: true, patch_isolated: true, scope_bounded: true,
  security_sensitive: false, schema_migration: false, release_or_publication: false,
  irreversible_external_operation: false, explicit_standard_override: false };

async function repository(name, canonicalDelayMs = 0) {
  const repo = join(root, `${name}-${randomUUID()}`);
  await mkdir(repo, { recursive: true });
  await run("git", ["init", "-b", "main"], repo);
  await writeFile(join(repo, "score.txt"), "3\n");
  await writeFile(join(repo, ".gitignore"), ".sortie-dogs/\n");
  await writeFile(join(repo, "probe.mjs"), `import {readFile,writeFile} from "node:fs/promises";const value=Number((await readFile("score.txt","utf8")).trim());await writeFile(process.argv[2],JSON.stringify({signal_id:"errors",value}));`);
  const canonicalDelay = canonicalDelayMs === 0 ? "" : `await new Promise(resolve=>setTimeout(resolve,${canonicalDelayMs}));`;
  await writeFile(join(repo, "validate.mjs"), `import {readFile} from "node:fs/promises";${canonicalDelay}const value=Number((await readFile("score.txt","utf8")).trim());process.exit(value===1?0:1);`);
  await writeFile(join(repo, "post-fail.mjs"), "process.exit(1);\n");
  await run("git", ["add", ".gitignore", "score.txt", "probe.mjs", "validate.mjs", "post-fail.mjs"], repo);
  await run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"], repo);
  await run("git", ["branch", "target"], repo);
  return { repo, baseHead: await run("git", ["rev-parse", "main"], repo), baseTree: await run("git", ["rev-parse", "main^{tree}"], repo) };
}

const makeRequest = (kind) => ({ task_id: `rpt-${kind}`, eligibility: structuredClone(eligibility), target_ref: "refs/heads/target",
  allowed_paths: { read: ["probe.mjs", "validate.mjs", "post-fail.mjs"], write: ["score.txt"] }, iteration_budget: 2,
  max_changed_paths: 1, cleanup_timeout_ms: 30000,
  probe_validation: { executable: process.execPath, args: ["probe.mjs", "{observation_path}"], timeout_ms: 30000, observation_path: "signal.json" },
  canonical_validation: { executable: process.execPath, args: ["validate.mjs"], timeout_ms: 30000 },
  improvement_signal: { signal_id: "errors", improvement_direction: "decrease", absolute_improvement_threshold: 1,
    goal: { operator: "at-most", value: kind === "budget" ? 0 : 1 } }, risk_class: "medium",
  post_merge_validation: { executable: process.execPath, args: [kind === "post" ? "post-fail.mjs" : "validate.mjs"], timeout_ms: 30000 },
  acceptance: ["reduce score to the declared numeric goal with one reversible score.txt patch per iteration"] });

async function lineage(repo, baseHead, kind, probeBudget = 3) {
  const ledgerPath = join(repo, ".sortie-dogs", `adaptive-flight-${kind}.json`);
  const ledger = await RunFlightLedger.open(ledgerPath, { store: new EvidenceCapsuleStore(join(repo, ".sortie-dogs", "evidence-capsules")),
    declared_capsule_ids: [], authorized_source_paths: ["score.txt", "probe.mjs", "validate.mjs", "post-fail.mjs"] });
  const at = new Date().toISOString(), route = `route-${kind}`, unit = `unit-${kind}`;
  await ledger.append({ kind: "run.planned", at, run_id: `run-${kind}`, initial_candidate_id: baseHead,
    budget_limits: { recovery_actions: probeBudget, probe_iterations: probeBudget, model_attempts: 3 } });
  await ledger.append({ kind: "route.selected", at, route_id: route, candidate_id: baseHead, role: "implementation", model: "controlled-process",
    variant: null, reason: "adaptive_probe" });
  await ledger.append({ kind: "wave.opened", at, wave_id: `wave-${kind}`, wave_index: 1, candidate_id: baseHead });
  await ledger.append({ kind: "unit.opened", at, unit_id: unit, wave_id: `wave-${kind}`, candidate_id: baseHead,
    references: { capsule_ids: [], artifact_ids: [] } });
  return { ledger, adapter: new AdaptiveRunFlightLineage({ ledger, unit_id: unit, route_id: route, candidate_id: baseHead,
    selected_model: "controlled-process", selected_variant: null, predecessor_attempt_id: null, model_attempt_per_patch: false }) };
}

async function executeLiveOpenCode() {
  assert.equal(platform, "wsl");
  const sourceRoot = resolve(import.meta.dirname, "../../..");
  const project = join(root, "project"), control = join(project, ".opencode");
  const env = { ...process.env, OPENCODE_CONFIG: undefined, OPENCODE_CONFIG_CONTENT: undefined,
    OPENCODE_CONFIG_DIR: join(root, "opencode-config"), XDG_CONFIG_HOME: join(root, "xdg-config"),
    OPENCODE_SERVER_PASSWORD: undefined, OPENCODE_SERVER_USERNAME: undefined };
  const checked = async (exe, args, cwd = project) => {
    const output = await new Promise((ok, fail) => execFile(exe, args, { cwd, env, encoding: "utf8", timeout: 180000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => error === null ? ok(stdout.trim()) : fail(error)));
    return output;
  };
  await mkdir(control, { recursive: true });
  const version = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8")).version;
  await checked("npm", ["pack", "--ignore-scripts", "--pack-destination", root], sourceRoot);
  const tgz = `sortie-dogs-${version}.tgz`;
  await writeFile(join(control, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: { "sortie-dogs": `file:../../${tgz}` } }));
  await checked("npm", ["install", "--force"], control);
  const installed = join(control, "node_modules", "sortie-dogs");
  const lock = JSON.parse(await readFile(join(control, "package-lock.json"), "utf8"));
  assert.equal(JSON.parse(await readFile(join(control, "package.json"), "utf8")).dependencies["sortie-dogs"], `file:../../${tgz}`);
  assert.equal(lock.packages["node_modules/sortie-dogs"].link, undefined);
  await checked(process.execPath, [join(installed, "dist", "cli", "main.js"), "init", project]);
  await mkdir(env.OPENCODE_CONFIG_DIR, { recursive: true });
  await mkdir(join(env.XDG_CONFIG_HOME, "opencode"), { recursive: true });
  const plugin = pathToFileURL(join(installed, "dist", "plugin", "opencode.js")).href;
  await writeFile(join(control, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: [plugin] }));
  await writeFile(join(env.OPENCODE_CONFIG_DIR, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json" }));
  await writeFile(join(env.XDG_CONFIG_HOME, "opencode", "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json" }));
  await writeFile(join(project, ".gitignore"), ".opencode/\n.sortie-dogs/\n");
  await writeFile(join(project, "AGENTS.md"), "# Adaptive fixture\nEdit only score.txt. Preserve controls.\n");
  await writeFile(join(project, "score.txt"), "2\n");
  await writeFile(join(project, "probe.mjs"), `import {readFile,writeFile} from "node:fs/promises";const value=Number((await readFile("score.txt","utf8")).trim());await writeFile(process.argv[2],JSON.stringify({signal_id:"errors",value}));`);
  await writeFile(join(project, "validate.mjs"), `import {readFile} from "node:fs/promises";process.exit(Number((await readFile("score.txt","utf8")).trim())===1?0:1);`);
  await checked("git", ["init", "-q", "-b", "main"]);
  await checked("git", ["add", ".gitignore", "AGENTS.md", "score.txt", "probe.mjs", "validate.mjs"]);
  await checked("git", ["-c", "user.name=Adaptive Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "adaptive baseline"]);
  const base = await checked("git", ["rev-parse", "HEAD"]);
  await checked("git", ["branch", "target"]);
  const ledgerPath = ".sortie-dogs/adaptive-live-flight.json";
  const flight = await RunFlightLedger.open(join(project, ledgerPath), { store: new EvidenceCapsuleStore(join(project, ".sortie-dogs/evidence-capsules")),
    declared_capsule_ids: [], authorized_source_paths: ["AGENTS.md", "score.txt", "probe.mjs", "validate.mjs"] });
  const at = new Date().toISOString();
  await flight.append({ kind: "run.planned", at, run_id: "adaptive-live", initial_candidate_id: base,
    budget_limits: { recovery_actions: 1, probe_iterations: 1, model_attempts: 1 } });
  await flight.append({ kind: "route.selected", at, route_id: "adaptive-route", candidate_id: base, role: "implementation",
    model: "openai/gpt-5.6-sol", variant: null, reason: "adaptive_probe" });
  await flight.append({ kind: "wave.opened", at, wave_id: "adaptive-wave", wave_index: 1, candidate_id: base });
  await flight.append({ kind: "unit.opened", at, unit_id: "score", wave_id: "adaptive-wave", candidate_id: base,
    references: { capsule_ids: [], artifact_ids: [] } });
  const request = makeRequest("live");
  request.task_id = "adaptive-live-score";
  request.iteration_budget = 1;
  request.risk_class = "high";
  request.acceptance = ["change score.txt from numeric value 2 to the declared at-most goal 1"];
  request.allowed_paths.read = ["AGENTS.md", "probe.mjs", "validate.mjs"];
  request.post_merge_validation.args = ["validate.mjs"];
  await writeFile(join(control, "sortie-dogs-adaptive-remediation.json"), JSON.stringify({ request, ledger_path: ledgerPath, capsule_ids: [],
    lineage: { unit_id: "score", route_id: "adaptive-route", candidate_id: base, predecessor_attempt_id: null } }));
  let server, url;
  try {
    server = spawn(OPENCODE, ["serve", "--hostname", "127.0.0.1", "--port", "0"],
      { cwd: project, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    server.stderr.on("data", () => {});
    await new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error("adaptive-live-server-timeout")), 30000);
      server.stdout.on("data", (chunk) => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/u);
        if (match) { url = match[0]; clearTimeout(timer); done(); } });
      server.once("error", fail);
    });
    const api = async (path, method = "GET", body) => {
      const response = await fetch(`${url}${path}${path.includes("?") ? "&" : "?"}directory=${encodeURIComponent(project)}`,
        { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(600000) });
      assert.ok(response.ok, `HTTP ${response.status} ${path}`);
      return response.json();
    };
    const owner = await api("/session", "POST", { title: "Adaptive remediation live RPT" });
    await api(`/session/${owner.id}/message`, "POST", { agent: "dog-coordinator", noReply: true,
      parts: [{ type: "text", text: "Register this isolated adaptive fixture coordinator." }] });
    const response = await api(`/session/${owner.id}/message`, "POST", { agent: "dog-coordinator", parts: [{ type: "text", text:
      "Fixed isolated operational test. Call sortie_execute_adaptive_remediation exactly once with no arguments. Do not inspect, delegate, retry, alter controls, or perform any other operation. Return the exact typed result, then stop." }] });
    const strings = [];
    const collect = (value) => { if (typeof value === "string") strings.push(value); else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === "object") Object.values(value).forEach(collect); };
    collect(response);
    const encoded = strings.find((value) => value.includes('"version"') && value.includes('"selection"') && value.includes('"state"'));
    assert.ok(encoded, "adaptive tool contract missing from coordinator response");
    const contract = JSON.parse(encoded.slice(encoded.indexOf("{"), encoded.lastIndexOf("}") + 1));
    const children = await api(`/session/${owner.id}/children`);
    const observed = [];
    for (const child of children) {
      const messages = await api(`/session/${child.id}/message`);
      const message = messages.filter((item) => item.info?.role === "assistant").at(-1);
      if (message) observed.push({ agent: message.info.agent,
        model: `${message.info.providerID}/${message.info.modelID}`, error: message.info.error === undefined ? null : "present" });
    }
    const ledgerSnapshot = await flight.read();
    const worktrees = await checked("git", ["worktree", "list", "--porcelain"]);
    const status = await checked("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
    const liveEvidence = { schema: "adaptive-remediation-opencode-rpt-v1", platform, package_version: version,
      installed_from_tgz: lock.packages["node_modules/sortie-dogs"].link === undefined, runtime_marker: (await readFile(join(control, "sortie-dogs.version"), "utf8")).trim(),
      contract: { state: contract.state, mode: contract.selection.mode, reason: contract.selection.reason, iterations: contract.metrics.iteration_count,
        probes: contract.metrics.probe_count, canonical: contract.metrics.full_validation_count, review: contract.review.status,
        promotion: contract.promotion.status, post_merge: contract.metrics.post_merge_validation_count, failure: contract.failure },
      target: { base, after: await checked("git", ["rev-parse", "target"]), score: await checked("git", ["show", "target:score.txt"]),
        checkout_head: await checked("git", ["rev-parse", "main"]), checkout_status: status },
      sessions: { worker: observed.filter((item) => item.agent === "dog-worker"), reviewer: observed.filter((item) => item.agent === "dog-reviewer") },
      lineage: { budget_consumed: ledgerSnapshot.state.budget_consumed,
        attempts: ledgerSnapshot.records.filter(({ event }) => event.kind === "attempt.started").length,
        unknown_tokens: ledgerSnapshot.state.observations.every((item) => item.usage.input_tokens === null),
        unknown_cost: ledgerSnapshot.state.observations.every((item) => item.estimated_cost.usd === null) },
      cleanup: { worktree_entries: worktrees.split(/\r?\n/u).filter((line) => line.startsWith("worktree ")).length, status } };
    await writeFile(evidencePath, JSON.stringify(liveEvidence, null, 2));
    assert.equal(contract.state, "VERIFIED"); assert.equal(contract.metrics.full_validation_count, 1); assert.equal(contract.metrics.probe_count, 2);
    assert.equal(liveEvidence.target.score, "1"); assert.equal(liveEvidence.target.checkout_head, base); assert.equal(status, "");
    assert.equal(liveEvidence.cleanup.worktree_entries, 1); assert.equal(liveEvidence.sessions.worker.length, 1); assert.equal(liveEvidence.sessions.reviewer.length, 1);
    console.log(JSON.stringify({ status: "PASS", evidence: evidencePath, platform, live_opencode: true }));
  } finally {
    if (server?.pid) { try { process.kill(-server.pid, "SIGTERM"); } catch {} }
  }
}

if (process.argv.includes("--live-opencode")) {
  await executeLiveOpenCode();
  process.exit(0);
}

const comparisonFixedCanonicalMs = 750;

const comparisonCleanup = async (source, released) => {
  const worktrees = await run("git", ["worktree", "list", "--porcelain"], source.repo);
  const status = await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], source.repo);
  const mainHead = await run("git", ["rev-parse", "main"], source.repo);
  const mainTree = await run("git", ["rev-parse", "main^{tree}"], source.repo);
  return { release_ok: released.ok, remaining_paths: released.remaining_paths,
    worktree_entries: worktrees.split(/\r?\n/u).filter((line) => line.startsWith("worktree ")).length,
    checkout_status: status, checkout_unchanged: mainHead === source.baseHead && mainTree === source.baseTree };
};

const comparisonProvider = (source, counters) => ({
  apply: async ({ worktree_path }) => {
    counters.patches += 1;
    const current = Number((await readFile(join(worktree_path, "score.txt"), "utf8")).trim());
    await writeFile(join(worktree_path, "score.txt"), `${current - 1}\n`);
    return { hypothesis: "decrease the declared errors signal by one" };
  },
  review: async ({ worktree_path, candidate_head, risk_class }) => {
    counters.reviews += 1;
    const whitespace = await run("git", ["diff", "--check", source.baseHead, candidate_head, "--"], worktree_path);
    const names = (await run("git", ["diff", "--name-only", source.baseHead, candidate_head, "--"], worktree_path)).split(/\r?\n/u).filter(Boolean);
    const score = Number((await readFile(join(worktree_path, "score.txt"), "utf8")).trim());
    return { status: whitespace === "" && names.join(",") === "score.txt" && score === 1 && risk_class === "medium" ? "pass" : "fail",
      fingerprint: (await run("git", ["rev-parse", `${candidate_head}^{tree}`], worktree_path)).padEnd(64, "0").slice(0, 64) };
  },
});

async function executeStandardComparison() {
  const source = await repository("comparison-standard", comparisonFixedCanonicalMs);
  const request = makeRequest("comparison-standard"), counters = { patches: 0, commit_checks: 0, canonical: 0, probes: 0, reviews: 0, post_merge: 0 };
  const provider = comparisonProvider(source, counters);
  const host = new GitAdaptiveRemediationHost({ repositoryRoot: source.repo, runID: "comparison-standard", taskID: request.task_id,
    targetRef: request.target_ref, allowedPaths: request.allowed_paths, patchProducer: provider, reviewProvider: provider });
  const candidates = [], hypotheses = [], patchTrees = [], canonical = [];
  const target = await host.snapshotTarget(request.target_ref), started = Date.now();
  let state = "ADMITTED", promotion = null, postMerge = null, targetIntegrityBeforeCas = false, released = { ok: false, remaining_paths: [] };
  try {
    let currentHead = target.head;
    for (let number = 1; number <= request.iteration_budget; number += 1) {
      const candidate = await host.openCandidate(currentHead, number);
      candidates.push(candidate);
      counters.commit_checks += 1;
      const patch = await host.producePatch({ candidate, iteration: number, acceptance: request.acceptance,
        allowed_paths: request.allowed_paths, probe_validation: { executable: "git", args: ["diff", "--check", "HEAD", "--", "score.txt"],
          timeout_ms: 30000, observation_path: "unused-standard-observation.json" } });
      hypotheses.push(patch.hypothesis);
      currentHead = patch.candidate_head;
      patchTrees.push(await run("git", ["rev-parse", `${currentHead}^{tree}`], candidate.path));
      const cleanup = await host.inspectCleanup(candidate, request.cleanup_timeout_ms);
      if (!cleanup.ok) { state = "ABANDONED"; break; }
      counters.canonical += 1;
      const validation = await host.runCanonical(candidate, request.canonical_validation);
      canonical.push({ status: validation.status, exit_code: validation.exit_code, fingerprint: validation.fingerprint });
      if (validation.status === "pass") {
        state = "FULL_VALIDATED";
        const review = await host.review({ candidate, candidate_head: currentHead, risk_class: request.risk_class });
        if (review.status !== "pass") { state = "REJECTED"; break; }
        state = "REVIEWED";
        const beforeCas = await host.snapshotTarget(request.target_ref);
        targetIntegrityBeforeCas = beforeCas.head === target.head && beforeCas.tree === target.tree;
        if (!targetIntegrityBeforeCas) { state = "REINTEGRATE_REQUIRED"; break; }
        promotion = await host.promote({ target_ref: request.target_ref, expected_head: target.head, candidate_head: currentHead });
        if (promotion.status !== "promoted") { state = "REINTEGRATE_REQUIRED"; break; }
        state = "MERGED"; counters.post_merge += 1;
        postMerge = await host.runPostMerge(request.post_merge_validation);
        if (postMerge.status === "pass") state = "VERIFIED";
        break;
      }
    }
  } finally { released = await host.release(candidates); }
  const duration = Date.now() - started;
  return { state, duration_ms: duration, source, hypotheses, patch_trees: patchTrees, canonical, promotion, post_merge: postMerge,
    counts: counters, target_integrity_before_cas: targetIntegrityBeforeCas,
    before_content_fingerprint: source.baseTree, after_content_fingerprint: await run("git", ["rev-parse", "target^{tree}"], source.repo),
    final_score: await run("git", ["show", "target:score.txt"], source.repo), cleanup: await comparisonCleanup(source, released) };
}

async function executeAdaptiveComparison() {
  const source = await repository("comparison-adaptive", comparisonFixedCanonicalMs);
  const request = makeRequest("comparison-adaptive"), counters = { patches: 0, commit_checks: 0, canonical: 0, probes: 0, reviews: 0, post_merge: 0 };
  const provider = comparisonProvider(source, counters);
  const flight = await lineage(source.repo, source.baseHead, "comparison-adaptive", 3);
  const host = new GitAdaptiveRemediationHost({ repositoryRoot: source.repo, runID: "comparison-adaptive", taskID: request.task_id,
    targetRef: request.target_ref, allowedPaths: request.allowed_paths, patchProducer: provider, reviewProvider: provider,
    reserveProbe: () => flight.adapter.reserveProbe(), finishProbe: (value) => flight.adapter.finishProbe(value), failProbe: (value) => flight.adapter.failProbe(value) });
  const originalCanonical = host.runCanonical.bind(host), originalPromote = host.promote.bind(host), originalPostMerge = host.runPostMerge.bind(host);
  let targetIntegrityBeforeCas = false;
  host.runCanonical = async (...args) => { counters.canonical += 1; return originalCanonical(...args); };
  host.promote = async (input) => {
    const beforeCas = await host.snapshotTarget(request.target_ref);
    targetIntegrityBeforeCas = beforeCas.head === source.baseHead && beforeCas.tree === source.baseTree;
    return originalPromote(input);
  };
  host.runPostMerge = async (...args) => { counters.post_merge += 1; return originalPostMerge(...args); };
  const result = await new AdaptiveRemediationRuntime(host).execute(request);
  counters.probes = result.metrics.probe_count;
  const patchTrees = [];
  for (const iteration of result.iterations) patchTrees.push(await run("git", ["rev-parse", `${iteration.candidate_head}^{tree}`], source.repo));
  const released = { ok: result.failure?.code !== "CLEANUP_FAILED", remaining_paths: [] };
  return { state: result.state, duration_ms: result.metrics.duration_ms, source, hypotheses: result.iterations.map(({ hypothesis }) => hypothesis),
    patch_trees: patchTrees, canonical: [{ status: result.full_validation.status, exit_code: result.full_validation.exit_code,
      fingerprint: result.full_validation.fingerprint }], promotion: result.promotion, post_merge: result.post_merge, counts: counters,
    target_integrity_before_cas: targetIntegrityBeforeCas, before_content_fingerprint: source.baseTree,
    after_content_fingerprint: await run("git", ["rev-parse", "target^{tree}"], source.repo),
    final_score: await run("git", ["show", "target:score.txt"], source.repo), cleanup: await comparisonCleanup(source, released) };
}

const comparisonArm = ({ source, ...arm }) => ({ ...arm, repository: source.repo });

async function executeMatchedComparison() {
  const standard = await executeStandardComparison(), adaptive = await executeAdaptiveComparison();
  const equivalent = { initial_content: standard.before_content_fingerprint === adaptive.before_content_fingerprint,
    final_content: standard.after_content_fingerprint === adaptive.after_content_fingerprint,
    patch_sequence: JSON.stringify(standard.patch_trees) === JSON.stringify(adaptive.patch_trees),
    hypotheses: JSON.stringify(standard.hypotheses) === JSON.stringify(adaptive.hypotheses),
    final_score: standard.final_score === adaptive.final_score };
  const completed = [standard, adaptive].every((arm) => arm.state === "VERIFIED" && arm.promotion?.status === "promoted" &&
    arm.post_merge?.status === "pass" && arm.target_integrity_before_cas && arm.cleanup.release_ok && arm.cleanup.remaining_paths.length === 0 &&
    arm.cleanup.worktree_entries === 1 && arm.cleanup.checkout_status === "" && arm.cleanup.checkout_unchanged);
  assert.ok(completed, "matched comparison completion or cleanup invariant failed");
  assert.ok(Object.values(equivalent).every(Boolean), "matched comparison input/output invariant failed");
  assert.equal(standard.counts.probes, 0); assert.equal(standard.counts.canonical, standard.counts.patches);
  assert.equal(adaptive.counts.probes, adaptive.counts.patches + 1); assert.equal(adaptive.counts.canonical, 1);
  const evidence = { schema: "adaptive-remediation-native-comparison-v1", platform,
    measurement: { label: "native Git/process fixture comparison", canonical_fixed_cost_ms: comparisonFixedCanonicalMs,
      note: "Controlled fixed-cost fixture measurement; not live model performance or universal performance savings.", universal_savings_claimed: false },
    task: { acceptance: makeRequest("comparison").acceptance, patch_hypothesis: "decrease the declared errors signal by one",
      canonical_validation: [process.execPath, "validate.mjs"], review_policy: "same controlled Git/process/source review", target_ref: "refs/heads/target" },
    equivalent, arms: { standard: comparisonArm(standard), adaptive: comparisonArm(adaptive) } };
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ status: "PASS", evidence: evidencePath, platform, comparison_only: true }));
}

if (process.argv.includes("--comparison-only")) {
  await executeMatchedComparison();
  process.exit(0);
}

async function executeCase(kind) {
  const source = await repository(kind);
  const request = makeRequest(kind);
  if (kind === "fallback") request.eligibility.security_sensitive = true;
  const flight = await lineage(source.repo, source.baseHead, kind, kind === "budget" ? 1 : 3);
  let canonicalCalls = 0, reviewProcesses = 0;
  const provider = {
    apply: async ({ iteration, worktree_path }) => {
      const current = Number((await readFile(join(worktree_path, "score.txt"), "utf8")).trim());
      await writeFile(join(worktree_path, "score.txt"), kind === "no-improvement" ? `${current} \n` : `${current - 1}\n`);
      return { hypothesis: "decrease the declared errors signal by one" };
    },
    review: async ({ worktree_path, candidate_head, risk_class }) => {
      reviewProcesses += 1;
      const whitespace = await run("git", ["diff", "--check", source.baseHead, candidate_head, "--"], worktree_path);
      const names = (await run("git", ["diff", "--name-only", source.baseHead, candidate_head, "--"], worktree_path)).split(/\r?\n/u).filter(Boolean);
      const score = Number((await readFile(join(worktree_path, "score.txt"), "utf8")).trim());
      if (kind === "cas") {
        const drift = await run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit-tree", source.baseTree,
          "-p", source.baseHead, "-m", "controlled external drift"], source.repo);
        await run("git", ["update-ref", "refs/heads/target", drift, source.baseHead], source.repo);
      }
      return { status: kind === "review" ? "remediation-required" : whitespace === "" && names.join(",") === "score.txt" && score === 1 && risk_class === "medium" ? "pass" : "fail",
        fingerprint: (await run("git", ["rev-parse", `${candidate_head}^{tree}`], worktree_path)).padEnd(64, "0").slice(0, 64) };
    },
  };
  const host = new GitAdaptiveRemediationHost({ repositoryRoot: source.repo, runID: `run-${kind}`, taskID: request.task_id,
    targetRef: request.target_ref, allowedPaths: request.allowed_paths, patchProducer: provider, reviewProvider: provider,
    reserveProbe: () => flight.adapter.reserveProbe(), finishProbe: (value) => flight.adapter.finishProbe(value), failProbe: (value) => flight.adapter.failProbe(value) });
  const originalPatch = host.producePatch.bind(host), originalCanonical = host.runCanonical.bind(host);
  host.producePatch = async (input) => {
    const patch = await originalPatch(input);
    if (kind === "cleanup") await writeFile(join(input.candidate.path, "residue.tmp"), "controlled residue\n");
    return patch;
  };
  host.runCanonical = async (...args) => { canonicalCalls += 1; return originalCanonical(...args); };
  const result = await new AdaptiveRemediationRuntime(host).execute(request);
  const targetAfter = await run("git", ["rev-parse", "target"], source.repo);
  const mainAfter = await run("git", ["rev-parse", "main"], source.repo), mainTreeAfter = await run("git", ["rev-parse", "main^{tree}"], source.repo);
  const ledgerSnapshot = await flight.ledger.read(), ledgerState = ledgerSnapshot.state;
  return { result, native: { repository: source.repo, base_head: source.baseHead, target_after: targetAfter,
    checkout_unchanged: mainAfter === source.baseHead && mainTreeAfter === source.baseTree, canonical_calls: canonicalCalls,
    review_processes: reviewProcesses }, lineage: { budget_consumed: ledgerState.budget_consumed,
      attempts: ledgerSnapshot.records.filter(({ event }) => event.kind === "attempt.started").length,
      unknown_cost: ledgerState.observations.every((item) => item.estimated_cost.usd === null),
      unknown_tokens: ledgerState.observations.every((item) => item.usage.input_tokens === null) } };
}

const cases = {};
for (const kind of ["success", "fallback", "no-improvement", "budget", "cleanup", "review", "cas", "post"]) cases[kind] = await executeCase(kind);
const compact = ({ result, native, lineage }) => ({ state: result.state, failure: result.failure?.code ?? null, mode: result.selection.mode,
  reason: result.selection.reason, iterations: result.metrics.iteration_count, probes: result.metrics.probe_count,
  canonical: result.metrics.full_validation_count, post_merge: result.metrics.post_merge_validation_count,
  review: result.review.status, promotion: result.promotion.status, discarded: result.metrics.discarded_patch_count,
  sol_demotions: result.metrics.sol_demotions, cas_conflicts: result.metrics.cas_conflicts,
  post_merge_failures: result.metrics.post_merge_failures, duration_ms: result.metrics.duration_ms, native, lineage });
const matrix = Object.fromEntries(Object.entries(cases).map(([key, value]) => [key, compact(value)]));
const evidence = { schema: "adaptive-remediation-rpt-v2", platform,
  adapter_evidence: "native Git worktrees, commits, contained Node probes/validations, update-ref CAS, and cleanup; negative outcomes use explicit controlled adapter faults",
  review_evidence: "matrix uses a controlled Git/process/source provider contract; plugin wiring uses an independent dog-reviewer session",
  matrix,
  selector_overhead: { condition: "fallback differs only by security_sensitive=true", adaptive_completed_workflow_duration_ms: matrix.success.duration_ms,
    standard_selector_duration_ms: matrix.fallback.duration_ms, comparable_as_completed_workflows: false,
    note: "The standard fallback is admission/selector overhead only; use a --comparison-only evidence run for matched completed workflows." } };
await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
const expected = { success: ["VERIFIED", null, 1], fallback: ["ADMITTED", null, 0], "no-improvement": ["ABANDONED", "NO_IMPROVEMENT", 0],
  budget: ["SOL_DEMOTED", "ITERATION_BUDGET_EXHAUSTED", 0], cleanup: ["ABANDONED", "CLEANUP_FAILED", 0],
  review: ["REJECTED", "REVIEW_REMEDIATION_REQUIRED", 1], cas: ["REINTEGRATE_REQUIRED", "CAS_DRIFT", 1],
  post: ["MERGED", "POST_MERGE_VERIFICATION_FAILED", 1] };
for (const [kind, [state, failure, canonical]] of Object.entries(expected)) {
  if (matrix[kind].state !== state || matrix[kind].failure !== failure || matrix[kind].canonical !== canonical || !matrix[kind].native.checkout_unchanged) {
    throw new Error(`adaptive RPT ${kind} invariant failed: ${JSON.stringify(matrix[kind])}`);
  }
}
if (matrix.success.probes !== 3 || matrix.success.post_merge !== 1 || matrix.success.review !== "pass" || matrix.success.promotion !== "promoted" ||
  matrix.success.native.target_after !== cases.success.result.promotion.candidate_head || matrix.success.lineage.budget_consumed.probe_iterations !== 2 ||
  matrix.success.lineage.budget_consumed.model_attempts !== 0 || !matrix.success.lineage.unknown_cost || !matrix.success.lineage.unknown_tokens ||
  matrix.budget.lineage.budget_consumed.probe_iterations !== 1) throw new Error("adaptive RPT lineage or success evidence failed");
console.log(JSON.stringify({ status: "PASS", evidence: evidencePath, platform }));
