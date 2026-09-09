import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = resolve(import.meta.dirname, "../../..");
const ROOT = join(REPO, "_testenv", "goal-continuity-v09");
const PROJECT = join(ROOT, "project");
const CONTROL = join(PROJECT, ".opencode");
const BASELINE = join(ROOT, "baseline", "sortie-dogs-0.8.3.tgz");
const attemptID = `${new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
const ATTEMPT = join(ROOT, "attempts", attemptID);
const CANDIDATE_DIR = join(ATTEMPT, "candidate");
const CANDIDATE = join(CANDIDATE_DIR, "sortie-dogs-0.9.1.tgz");
const RESULT = join(ATTEMPT, "goal-bound-rpt-summary.json");
const EXPECTED = "candidate-v09";
const STAGE_ONE = "seed";
const STAGE_TWO = "verified";
const UNIT_ONE_VALIDATION = "node validate.mjs unit-1";
const UNIT_TWO_VALIDATION = "node validate.mjs unit-2";
const VALIDATIONS = [UNIT_ONE_VALIDATION, UNIT_TWO_VALIDATION];
const OPENCODE = typeof process.env.OPENCODE_BIN === "string" && process.env.OPENCODE_BIN.trim() !== ""
  ? process.env.OPENCODE_BIN.trim() : "opencode";
const env = { ...process.env, OPENCODE_CONFIG: undefined, OPENCODE_CONFIG_CONTENT: undefined,
  OPENCODE_CONFIG_DIR: join(ATTEMPT, "config"), XDG_CONFIG_HOME: join(ATTEMPT, "xdg"),
  OPENCODE_SERVER_PASSWORD: undefined, OPENCODE_SERVER_USERNAME: undefined };
const ownedProcesses = new Map();
const observedPids = new Set();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const write = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value); };
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const jsonOutput = (value) => {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  assert.ok(start >= 0 && end >= start, "command output did not contain a JSON object");
  return JSON.parse(value.slice(start, end + 1));
};
const boundedError = (error) => ({ code: typeof error?.code === "string" ? error.code : error?.name ?? "Error",
  messageFingerprint: sha256(String(error?.message ?? error)), phase: summary.phase });

async function stopGroup(child, signal) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); } catch {}
}

async function command(executable, args, cwd = PROJECT, timeout = 600_000) {
  return await new Promise((done) => {
    const child = spawn(executable, args, { cwd, env: { ...env, PWD: cwd }, detached: true, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false, launchError;
    if (child.pid) { ownedProcesses.set(child.pid, child); observedPids.add(child.pid); }
    const append = (current, chunk) => (current + String(chunk)).slice(-(16 * 1024 * 1024));
    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => { launchError = error; });
    const timer = setTimeout(async () => {
      timedOut = true;
      await stopGroup(child, "SIGTERM");
      setTimeout(() => { if (child.exitCode === null && child.signalCode === null) void stopGroup(child, "SIGKILL"); }, 5_000).unref();
    }, timeout);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (child.pid) ownedProcesses.delete(child.pid);
      done({ exit: Number.isInteger(code) ? code : launchError ? 127 : timedOut ? 124 : 1,
        signal: signal ?? null, timedOut, stdout, stderr });
    });
  });
}

async function checked(executable, args, cwd = PROJECT, timeout = 600_000, phase = "command") {
  const result = await command(executable, args, cwd, timeout);
  assert.equal(result.exit, 0, JSON.stringify({ phase, executable: executable.split(/[\\/]/u).at(-1),
    exit: result.exit, signal: result.signal, timedOut: result.timedOut, stderrFingerprint: sha256(result.stderr) }));
  return result;
}

function allRecords(value, output = []) {
  if (Array.isArray(value)) value.forEach((entry) => allRecords(entry, output));
  else if (value !== null && typeof value === "object") {
    output.push(value);
    Object.values(value).forEach((entry) => allRecords(entry, output));
  }
  return output;
}

function transcriptMetadata(result) {
  const events = result.stdout.split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const records = allRecords(events);
  const sessionIDs = [...new Set(records.flatMap((record) => [record.sessionID, record.sessionId,
    record.session_id, record.part?.sessionID]).filter((value) => typeof value === "string" && value.startsWith("ses_")))];
  const tools = records.flatMap((record) => [record.tool, record.toolName, record.name])
    .filter((value) => typeof value === "string" && /^(?:task|bash|apply_patch|read|sortie_)/u.test(value));
  return { sessionIDs, eventCount: events.length,
    eventTypes: [...new Set(records.map((record) => record.type).filter((value) => typeof value === "string"))].slice(0, 24),
    toolCounts: Object.fromEntries([...new Set(tools)].map((tool) => [tool, tools.filter((value) => value === tool).length])),
    stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr),
    stdoutFingerprint: sha256(result.stdout), stderrFingerprint: sha256(result.stderr) };
}

function loadedPluginPaths(stderr) {
  const matches = stderr.match(/(?:file:\/\/)?\/?[^\s"']*sortie-dogs[^\s"']*dist\/plugin\/opencode\.js/gu) ?? [];
  return [...new Set(matches.map((path) => path.replaceAll("\\", "/")))];
}

async function inspectConfig(plugin) {
  // The CLI can exit before a large piped config finishes flushing. A PTY drains it completely.
  const executable = `'${OPENCODE.replaceAll("'", "'\\''")}'`;
  const result = await checked("script", ["-q", "-e", "-c", `${executable} debug config`, "/dev/null"], PROJECT, 120_000, "debug-config");
  const config = jsonOutput(result.stdout);
  assert.ok(config !== null && typeof config === "object" && Array.isArray(config.plugin));
  assert.deepEqual(config.plugin, [plugin], "resolved config must contain only the intended fixture-local plugin");
  return { pluginCount: config.plugin.length, localPlugin: config.plugin[0] === plugin,
    pluginFingerprint: sha256(plugin), stderrFingerprint: sha256(result.stderr) };
}

async function verifyAssets(packageRoot) {
  const module = await import(`${pathToFileURL(join(packageRoot, "dist", "runtime-assets.js")).href}?${Date.now()}`);
  const observations = [];
  for (const asset of module.runtimeAssets) {
    const disk = await readFile(join(CONTROL, asset.installPath), "utf8");
    assert.equal(disk, asset.content, `runtime asset mismatch: ${asset.installPath}`);
    observations.push(`${asset.installPath}:${sha256(disk)}`);
  }
  observations.sort();
  return { count: observations.length, fingerprint: sha256(observations.join("\n")) };
}

async function canonicalAssetPaths() {
  const candidates = [join(CONTROL, "node_modules", "sortie-dogs", "dist", "runtime-assets.js"),
    join(REPO, "dist", "runtime-assets.js")];
  let selected;
  for (const path of candidates) {
    if (await stat(path).catch(() => undefined)) { selected = path; break; }
  }
  assert.ok(selected, "runtime asset manifest is required before fixture cleanup");
  const module = await import(`${pathToFileURL(selected).href}?${Date.now()}`);
  const paths = module.runtimeAssets.map((asset) => asset.installPath);
  assert.equal(paths.length, 7, "fixture expects the seven canonical runtime assets");
  assert.equal(new Set(paths).size, paths.length, "canonical runtime asset paths must be unique");
  return paths;
}

async function archiveFixtureAssets(label) {
  const paths = [...await canonicalAssetPaths(), "sortie-dogs.version"];
  const archiveRoot = join(ATTEMPT, "preinstall-assets", label);
  const entries = [];
  for (const path of paths) {
    const source = join(CONTROL, path);
    const present = await stat(source).catch(() => undefined);
    if (present?.isFile()) {
      const bytes = await readFile(source);
      await write(join(archiveRoot, path), bytes);
      entries.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
    }
    await rm(source, { force: true });
    assert.equal(await stat(source).catch(() => undefined), undefined, `fixture asset cleanup failed: ${path}`);
  }
  await write(join(archiveRoot, "manifest.json"), `${JSON.stringify({ label, entries }, null, 2)}\n`);
  return { path: relative(REPO, archiveRoot).replaceAll("\\", "/"), count: entries.length,
    fingerprint: sha256(entries.map((entry) => `${entry.path}:${entry.sha256}`).join("\n")) };
}

async function install(archive, label) {
  const archivedAssets = await archiveFixtureAssets(label);
  const dependency = `file:${relative(CONTROL, archive).replaceAll("\\", "/")}`;
  await command("rm", ["-rf", join(CONTROL, "node_modules", "sortie-dogs")], CONTROL, 120_000);
  await command("rm", ["-f", join(CONTROL, "package-lock.json")], CONTROL, 120_000);
  await write(join(CONTROL, "package.json"), `${JSON.stringify({ private: true, type: "module",
    dependencies: { "@opencode-ai/plugin": "1.18.29", "sortie-dogs": dependency } })}\n`);
  const npm = await checked("npm", ["install", "--force"], CONTROL, 300_000, `${label}-npm-install`);
  assert.equal((await json(join(CONTROL, "package.json"))).dependencies["sortie-dogs"], dependency);
  const packageRoot = join(CONTROL, "node_modules", "sortie-dogs");
  assert.equal((await lstat(packageRoot)).isSymbolicLink(), false);
  assert.ok((await realpath(packageRoot)).startsWith(`${await realpath(CONTROL)}${sep}`));
  const lock = await json(join(CONTROL, "package-lock.json"));
  assert.equal(lock.packages["node_modules/sortie-dogs"].link, undefined);
  await checked(process.execPath, [join(packageRoot, "dist", "cli", "main.js"), "init", PROJECT], PROJECT, 180_000, `${label}-init`);
  const identity = await json(join(packageRoot, "package.json"));
  const marker = (await readFile(join(CONTROL, "sortie-dogs.version"), "utf8")).trim();
  const assets = await verifyAssets(packageRoot);
  const plugin = pathToFileURL(join(packageRoot, "dist", "plugin", "opencode.js")).href;
  await write(join(CONTROL, "opencode.json"), `${JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: [plugin] })}\n`);
  for (const config of [join(env.OPENCODE_CONFIG_DIR, "opencode.json"), join(env.XDG_CONFIG_HOME, "opencode", "opencode.json")]) {
    await write(config, '{"$schema":"https://opencode.ai/config.json"}\n');
  }
  const resolvedConfig = await inspectConfig(plugin);
  return { dependency, packageVersion: identity.version, diskMarker: marker, assets, archivedAssets,
    archiveSha256: sha256(await readFile(archive)), pluginEntrypointSha256: sha256(await readFile(join(packageRoot, "dist", "plugin", "opencode.js"))),
    installStderrFingerprint: sha256(npm.stderr), resolvedConfig, packageRoot };
}

async function runGoal(message, sessionID, label) {
  const args = ["run", "--format", "json", "--print-logs", "--log-level", "DEBUG", "--agent", "dog-coordinator"];
  if (sessionID !== undefined) args.push("--session", sessionID);
  args.push(message);
  const result = await command(OPENCODE, args, PROJECT, 900_000);
  const metadata = transcriptMetadata(result);
  const paths = loadedPluginPaths(result.stderr);
  summary.lastRun = { label, exit: result.exit, signal: result.signal, timedOut: result.timedOut,
    transcript: metadata, loadedPluginCount: paths.length,
    loadedPluginFingerprints: paths.map((path) => sha256(path)) };
  if (result.exit !== 0) throw Object.assign(new Error("cli-exit"), { code: `${label}-cli-exit` });
  return { metadata, paths: { diagnosticCount: paths.length,
    fingerprints: paths.map((path) => sha256(path)),
    allDetectedLocal: paths.every((path) => path.includes("goal-continuity-v09/project/.opencode/node_modules/sortie-dogs")) } };
}

async function seedFixture() {
  await mkdir(CONTROL, { recursive: true });
  const owned = ["AGENTS.md", "package.json", "goal.txt", "stage.txt", "validate.mjs", ".gitignore"];
  await write(join(PROJECT, "AGENTS.md"), `# Goal continuity v0.9 host fixture\n\n- Use dog-worker for the requested edit.\n- Change only goal.txt or stage.txt as authorized by the current operation manifest, plus generated Sortie control files.\n- Run exactly the validation command declared by the current operation manifest; no delegation from worker, commit, publish, global install, or network.\n- DONE requires the requested file content and actual validation.\n`);
  await write(join(PROJECT, "package.json"), '{"private":true,"type":"module"}\n');
  await write(join(PROJECT, "goal.txt"), "seed\n");
  await write(join(PROJECT, "stage.txt"), `${STAGE_ONE}\n`);
  await write(join(PROJECT, "validate.mjs"), `import assert from "node:assert/strict"; import {readFile} from "node:fs/promises";\nconst mode=process.argv[2]; assert.ok(mode==="unit-1"||mode==="unit-2","unknown validation mode");\nassert.equal((await readFile("goal.txt","utf8")).trim(),${JSON.stringify(EXPECTED)}); if(mode==="unit-2") assert.equal((await readFile("stage.txt","utf8")).trim(),${JSON.stringify(STAGE_TWO)});\n`);
  await write(join(PROJECT, ".gitignore"), ".opencode/\n.sortie-dogs/\n");
  if (!await stat(join(PROJECT, ".git")).catch(() => undefined)) await checked("git", ["init", "-q", "-b", "main"], PROJECT, 120_000, "fixture-git-init");
  const head = await command("git", ["rev-parse", "--verify", "HEAD"], PROJECT, 120_000);
  const worktreeChanged = (await command("git", ["diff", "--quiet", "--", ...owned], PROJECT, 120_000)).exit !== 0;
  const stagedChanged = (await command("git", ["diff", "--cached", "--quiet", "--", ...owned], PROJECT, 120_000)).exit !== 0;
  if (head.exit !== 0 || worktreeChanged || stagedChanged) {
    await checked("git", ["add", "--", ...owned], PROJECT, 120_000, "fixture-seed-stage");
    if (head.exit === 0 && (await command("git", ["diff", "--cached", "--quiet", "--", ...owned], PROJECT, 120_000)).exit === 0) return;
    await checked("git", ["-c", "user.name=Sortie Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "--only", "-qm", "goal fixture seed", "--", ...owned], PROJECT, 120_000, "fixture-seed-commit");
  }
}

async function controls(taskID, parentFingerprint = "none", stage = "unit-1") {
  const root = join(PROJECT, ".sortie-dogs", "contracts");
  const manifest = join(root, `${taskID}.operation-manifest.json`);
  const handoff = join(root, `handoff.${taskID}.json`);
  const manifestRelative = relative(PROJECT, manifest).replaceAll("\\", "/");
  const firstCriterion = `goal.txt equals ${EXPECTED} and the unit-1 oracle passes`;
  const secondCriterion = `stage.txt advances to ${STAGE_TWO}, goal.txt remains ${EXPECTED}, and the unit-2 oracle passes`;
  const unitTwo = stage === "unit-2";
  const criteria = unitTwo ? [firstCriterion, secondCriterion] : [firstCriterion];
  const validation = unitTwo ? UNIT_TWO_VALIDATION : UNIT_ONE_VALIDATION;
  const writePaths = unitTwo ? ["stage.txt"] : ["goal.txt"];
  const objective = unitTwo ? `Advance stage.txt to ${STAGE_TWO}, retain goal.txt at ${EXPECTED}, and run the unit-2 oracle.`
    : `Set goal.txt to ${EXPECTED} and run the unit-1 oracle.`;
  const { acceptanceContinuityFingerprint } = await import(pathToFileURL(join(REPO, "dist/core/acceptance-continuity.js")).href);
  const acceptanceFingerprint = acceptanceContinuityFingerprint(criteria);
  await write(manifest, `${JSON.stringify({ version: "0.1.0", task_id: taskID,
    read: ["AGENTS.md", "validate.mjs", "goal.txt", ...(unitTwo ? ["stage.txt"] : [])], write: writePaths, validation: [validation] }, null, 2)}\n`);
  await write(handoff, `${JSON.stringify({ version: "0.1.0", profile: "minimal", id: taskID,
    created_at: new Date().toISOString(), task: { title: taskID, objective },
    state: { done: unitTwo ? [firstCriterion] : [], next: [unitTwo
      ? `Set stage.txt to ${STAGE_TWO}; run ${validation}.`
      : `Set goal.txt to ${EXPECTED}; run ${validation}.`], blocked: [] }, risks: [],
    verification: [{ check: validation, status: "not_run", exit_code: null, summary: "Fixed fixture oracle" }],
    ext: { "sortie-dogs/write-gate": { operation_manifest: manifestRelative, project_root: PROJECT },
      "sortie-dogs/acceptance-continuity": { schema_version: "0.1", authority: "dispatch", task_id: taskID,
        criteria, fingerprint: acceptanceFingerprint, parent_fingerprint: parentFingerprint } } }, null, 2)}\n`);
  const { validateHandoffSchema } = await import(pathToFileURL(join(REPO, "dist/core/validate-schema.js")).href);
  const { validateManifest } = await import(pathToFileURL(join(REPO, "dist/core/validate-manifest.js")).href);
  const checked = validateHandoffSchema(await json(handoff));
  assert.ok(checked.ok, JSON.stringify(checked.diagnostics));
  const diagnostics = validateManifest(checked.value, await json(manifest), undefined, false, { requirePassedValidation: false });
  assert.ok(!diagnostics.some((entry) => entry.severity === "error"), JSON.stringify(diagnostics));
  return { taskID, manifest, manifestRelative, handoff, acceptanceFingerprint, criteria, validation,
    goalCriterionID: unitTwo ? "stage-file-oracle" : "goal-file-oracle",
    goalTarget: unitTwo ? "stage.txt verified while goal.txt is retained" : "goal.txt requested content",
    goalWorkload: unitTwo ? "one retained-goal stage transition" : "one fixed goal file transition",
    goalOracleCoverage: unitTwo ? ["stage.txt verified", "goal.txt retained", "fixed unit-2 node oracle"]
      : ["goal.txt content", "fixed unit-1 node oracle"] };
}

function workerContract(control, goalDeclaration = false, additionalCriteria = [], declarationControl = control) {
  const fingerprint = `sha256:${sha256(`goal-continuity-v09:${declarationControl.goalCriterionID}`)}`;
  return ["/sortie", "role: implementation", `project_root: ${PROJECT}`, `handoff_path: ${control.handoff}`,
    `task_id: ${control.taskID}`, 'source_manifest: ["AGENTS.md","validate.mjs","goal.txt","stage.txt"]',
    `operation_manifest: ${control.manifestRelative}`, `acceptance: ${JSON.stringify(control.criteria)}`,
    `validation: ${control.validation}`,
    ...(goalDeclaration ? [`goal_acceptance_fingerprint: ${fingerprint}`, "delivery_intent: implementation",
      "delivery_mode: mvp-first", "usable_path_established: false", "controlled_change: false", "goal_budget_units: 4",
      `goal_criterion_id: ${declarationControl.goalCriterionID}`, `goal_target: ${declarationControl.goalTarget}`, "goal_entrypoint: validate.mjs",
      `goal_workload: ${declarationControl.goalWorkload}`, '[goal placeholder]'] : [])].filter((line) => line !== "[goal placeholder]")
    .concat(goalDeclaration ? [`goal_oracle_coverage: ${JSON.stringify(declarationControl.goalOracleCoverage)}`,
      "goal_build_boundary: not-applicable", "goal_source: protected fixture seed", "goal_candidate: protected installed candidate",
      "goal_source_binding: current-protected", "goal_candidate_binding: current-protected",
      `goal_validation_command: ${declarationControl.validation}`, "goal_fixture: goal-continuity-v09", "goal_proof_scope: requested-full",
      "goal_expected_outcome: pass"] : []).concat(additionalCriteria.map((criterion) => {
        const declaration = workerContract(criterion, true);
        return declaration.slice(declaration.indexOf("goal_criterion_id:"));
      })).join("\n");
}

function goalLedgerPath(sessionID) {
  return join(PROJECT, ".git", "sortie-dogs", "run-flight", `${sha256(sessionID)}.json`);
}

async function goalObservation(path, expectedGoalID) {
  const value = await json(path);
  const records = value.goal_events ?? [];
  const accepted = records.find(({ event }) => event?.kind === "goal.accepted")?.event;
  assert.ok(accepted && (expectedGoalID === undefined || accepted.goal_id === expectedGoalID));
  const goalID = accepted.goal_id;
  const own = records.filter(({ event }) => event?.goal_id === goalID);
  const terminalRecord = own.find(({ event }) => event.kind === "goal.terminal");
  const settled = own.filter(({ event }) => event.kind === "unit.settled");
  const evidence = settled.flatMap(({ event }) => event.evidence ?? []).filter((entry) =>
    Array.isArray(entry.execution?.command) && entry.execution.command.length === 1 && VALIDATIONS.includes(entry.execution.command[0]));
  return { raw: value, goalID, eventCount: own.length, eventKinds: own.map(({ event }) => event.kind),
    consumedUnits: settled.length, unitIDs: settled.map(({ event }) => event.unit_id),
    issuedTickets: own.filter(({ event }) => event.kind === "ticket.issued").map(({ event }) => event),
    consumedTickets: own.filter(({ event }) => event.kind === "ticket.consumed").map(({ event }) => event),
    receipt: terminalRecord?.event?.receipt ?? null,
    terminalSequence: terminalRecord?.sequence ?? null,
    dispatchAfterTerminal: terminalRecord === undefined ? 0 : records.filter((record) =>
      record.sequence > terminalRecord.sequence && record.event?.kind === "dispatch.reserved").length,
    evidence: evidence.map((entry) => ({ evidenceID: entry.evidence_id, source: entry.identity?.source,
      candidate: entry.identity?.candidate, fixture: entry.identity?.fixture, command: entry.execution.command,
      exit: entry.execution.exit_code, outcome: entry.execution.outcome, criterionIDs: entry.measurement?.criterion_ids,
      protectedBinding: entry.protected_binding === undefined ? null : { manifestHash: entry.protected_binding.manifest_hash,
        sourcePathCount: entry.protected_binding.source_paths?.length, candidatePathCount: entry.protected_binding.candidate_paths?.length } })) };
}

async function rejectedTicketChecks(packageRoot, ledgerPath, observation) {
  assert.ok(observation.receipt, "terminal receipt required before stale ticket checks");
  assert.ok(observation.issuedTickets.length >= 1 && observation.consumedTickets.length >= 1, "host ticket roundtrip required");
  const module = await import(`${pathToFileURL(join(packageRoot, "dist", "core", "run-flight-ledger.js")).href}?${Date.now()}`);
  const ledger = await module.RunFlightLedger.openGoal(ledgerPath);
  const before = (await ledger.readGoal()).records.length;
  let duplicateCode = null, staleCode = null;
  try {
    const ticket = observation.consumedTickets[0];
    await ledger.appendGoal({ kind: "ticket.consumed", at: new Date().toISOString(), ticket_id: ticket.ticket_id,
      goal_id: observation.goalID, receiving_message_id: "rpt-duplicate-replay", session_id: ticket.session_id,
      origin_user_message_id: ticket.origin_user_message_id });
  } catch (error) { duplicateCode = error?.code ?? error?.name ?? "rejected"; }
  try {
    await ledger.appendGoal({ kind: "ticket.issued", at: new Date().toISOString(), ticket_id: `rpt-stale-${randomUUID()}`,
      goal_id: observation.goalID, revision: observation.receipt.terminal_revision, scope_epoch: observation.receipt.terminal_revision,
      checkpoint: "after-terminal", sequence: observation.issuedTickets.length + 1,
      session_id: observation.receipt.session_ids[0], origin_user_message_id: observation.raw.goal_events[0].event.origin_user_message_id });
  } catch (error) { staleCode = error?.code ?? error?.name ?? "rejected"; }
  const after = (await ledger.readGoal()).records.length;
  assert.ok(duplicateCode && staleCode, "duplicate and stale terminal ticket operations must reject");
  assert.equal(after, before, "rejected ticket operations must not mutate the ledger");
  return { duplicate: String(duplicateCode), staleAfterTerminal: String(staleCode), ledgerUnchanged: true };
}

async function buildCandidate() {
  await checked("npm", ["run", "build"], REPO, 300_000, "candidate-build");
  await checked(process.execPath, ["--check", join(REPO, "dist", "plugin", "index.js")], REPO, 120_000,
    "candidate-source-parse");
  await checked("npm", ["pack", "--ignore-scripts", "--pack-destination", CANDIDATE_DIR], REPO, 300_000,
    "candidate-pack");
  assert.ok((await stat(CANDIDATE)).isFile());
  return sha256(await readFile(CANDIDATE));
}

assert.equal(process.platform, "linux", "run this fixture inside WSL");
const summary = { schemaVersion: "goal-bound-rpt-v2", status: "running", phase: "preflight", processesStopped: false,
  root: relative(REPO, ROOT).replaceAll("\\", "/"), attempt: attemptID, baselineArchivePreserved: true,
  validationCommands: VALIDATIONS };

try {
  assert.ok((await stat(BASELINE)).isFile(), "preserved original baseline archive is required");
  await mkdir(CANDIDATE_DIR, { recursive: true });
  await seedFixture();
  const baselineControl = await controls("baseline-unit");
  if (process.argv.includes("--preflight-only")) {
    summary.phase = "candidate-build-pack-preflight";
    const candidateSha256 = await buildCandidate();
    await canonicalAssetPaths();
    const cwdProbe = await checked(process.execPath, ["-e",
      "process.stdout.write(JSON.stringify({cwd:process.cwd(),pwd:process.env.PWD}))"], PROJECT, 120_000, "cwd-preflight");
    const observed = JSON.parse(cwdProbe.stdout);
    assert.equal(observed.cwd, PROJECT);
    assert.equal(observed.pwd, PROJECT);
    summary.status = "pass";
    summary.phase = "preflight-only";
    summary.preflight = { handoff: relative(REPO, baselineControl.handoff).replaceAll("\\", "/"),
      manifest: relative(REPO, baselineControl.manifest).replaceAll("\\", "/"), canonicalAssetCount: 7,
      workingDirectoryFingerprint: sha256(observed.cwd), candidateSha256 };
  } else {
  const resumePath = process.argv.find((value) => value.startsWith("--resume-baseline="))?.slice("--resume-baseline=".length);
  const prior = resumePath === undefined ? undefined : await json(resolve(resumePath));
  if (prior?.baseline !== undefined) {
    assert.equal(prior.schemaVersion, "goal-bound-rpt-v2");
    assert.ok(prior.validationCommand === "node validate.mjs" ||
      JSON.stringify(prior.validationCommands) === JSON.stringify(VALIDATIONS));
    assert.equal(prior.root, relative(REPO, ROOT).replaceAll("\\", "/"));
    assert.equal(prior.baseline.identity?.archiveSha256, sha256(await readFile(BASELINE)));
    assert.equal(typeof prior.baseline.sessionID, "string");
    assert.equal(typeof prior.baseline.goalValue, "string");
    assert.ok(prior.baseline.taskOutcome === "completed" || prior.baseline.taskOutcome === "did-not-complete");
    assert.equal(typeof prior.baseline.goalLedgerPresent, "boolean");
  }
  summary.phase = "baseline-install";
  const baselineIdentity = prior?.baseline?.identity ?? await install(BASELINE, "baseline");
  let baseline;
  if (prior?.baseline !== undefined) {
    baseline = { metadata: prior.baseline.transcript, paths: prior.baseline.loadedPlugin };
    summary.baselineObservationReused = relative(REPO, resolve(resumePath)).replaceAll("\\", "/");
  } else if (prior !== undefined) {
    assert.equal(prior.lastRun?.label, "baseline");
    assert.equal(prior.lastRun?.exit, 0);
    baseline = { metadata: prior.lastRun.transcript, paths: { diagnosticCount: prior.lastRun.loadedPluginCount,
      fingerprints: prior.lastRun.loadedPluginFingerprints, allDetectedLocal: prior.lastRun.loadedPluginCount === 0 } };
    summary.baselineObservationReused = relative(REPO, resolve(resumePath)).replaceAll("\\", "/");
  } else {
    summary.phase = "baseline-run";
    const baselinePrompt = `/sortie\nActual isolated v0.9 baseline. Dispatch exactly one dog-worker, no scout/reviewer/other tools. Give it this exact contract:\n${workerContract(baselineControl)}\nThe worker must read the handoff, bind, set goal.txt to ${EXPECTED}, and run exactly ${baselineControl.validation}. Return the observed terminal result honestly; do not invent goal-bound metadata.`;
    baseline = await runGoal(baselinePrompt, undefined, "baseline");
  }
  const sessionID = prior?.baseline?.sessionID ?? baseline.metadata.sessionIDs[0];
  assert.ok(sessionID, "baseline run did not expose a host session id");
  const baselineGoalValue = prior?.baseline?.goalValue ?? (await readFile(join(PROJECT, "goal.txt"), "utf8")).trim();
  const baselineGoalPath = goalLedgerPath(sessionID);
  summary.baseline = { identity: { ...baselineIdentity, packageRoot: undefined }, transcript: baseline.metadata,
    loadedPlugin: baseline.paths, sessionID, goalValue: baselineGoalValue,
    taskOutcome: prior?.baseline?.taskOutcome ?? (baselineGoalValue === EXPECTED ? "completed" : "did-not-complete"),
    goalLedgerPresent: prior?.baseline?.goalLedgerPresent ?? Boolean(await stat(baselineGoalPath).catch(() => undefined)) };

  summary.phase = "fixture-reset";
  await write(join(PROJECT, "goal.txt"), "seed\n");
  assert.equal((await readFile(join(PROJECT, "goal.txt"), "utf8")), "seed\n");
  summary.fixtureSetupReset = { path: "goal.txt", valueFingerprint: sha256("seed\n"), purpose: "between-arm fixture setup; not user-data rollback" };

  summary.phase = "candidate-build-pack";
  await buildCandidate();
  const candidateIdentity = await install(CANDIDATE, "candidate");
  assert.equal(candidateIdentity.packageVersion, "0.9.1");
  assert.equal(candidateIdentity.diskMarker, "0.3.76-goal-control-report-v1");

  const recoveredOpen = process.argv.includes("--recovered-open");
  summary.phase = recoveredOpen ? "candidate-recovered-open" : "candidate-open-goal";
  const checkpointPrompt = "/sortie\nOpen the candidate goal in this real top-level session. Do not call any tool or claim completion. Return exactly CANDIDATE_CHECKPOINT_OPEN with no status, DONE, STOP, progress marker, next_action, or continuation marker. A second host process will resume this same session.";
  const checkpoint = await runGoal(checkpointPrompt, undefined, recoveredOpen ? "candidate-recovered-checkpoint" : "candidate-checkpoint");
  const candidateSessionID = checkpoint.metadata.sessionIDs[0];
  assert.ok(candidateSessionID, "candidate checkpoint did not expose a host session id");
  assert.notEqual(candidateSessionID, sessionID, "candidate arm must use its own top-level host session");
  const ledgerPath = goalLedgerPath(candidateSessionID);
  const checkpointObservation = await goalObservation(ledgerPath);
  assert.equal(checkpointObservation.receipt, null, "candidate checkpoint must remain nonterminal");
  const goalID = checkpointObservation.goalID;

  summary.phase = "candidate-goal-run";
  const first = await controls("candidate-unit-1");
  const second = await controls("candidate-unit-2", first.acceptanceFingerprint, "unit-2");
  const firstPrompt = `/sortie\nResume the already-open candidate goal. Preserve its real goal_id and spend. First call sortie_enable_backlog_drain with max_units 2. Dispatch candidate-unit-1 to dog-worker using exactly this contract, retaining BOTH goal_criterion_id declaration blocks verbatim as the single goal acceptance contract. Repeating the field name is the canonical multi-criterion list syntax; the two ID values are distinct, not duplicates:\n${workerContract(first, true, [second])}\nAfter its actual ${first.validation} exit 0, call sortie_compact_and_continue exactly once. In the synthetic resumed turn return exactly CANDIDATE_UNIT_ONE_COMPACTED with no tool call, status, DONE, STOP, progress marker, next_action, or continuation marker. A second host process will resume the same session. No scout, reviewer, fake receipts, shell from coordinator, extra dispatch, or preloaded execution facts.`;
  const unitOne = await runGoal(firstPrompt, candidateSessionID, "candidate-unit-1");
  const secondPrompt = `/sortie\nResume the same accepted goal_id and cumulative spend. Dispatch candidate-unit-2 to dog-worker using exactly this contract. Its complete typed declaration is identical to the accepted two-criterion declaration and must not revise it:\n${workerContract(second, true, [second], first)}\nIt must bind, advance only stage.txt to ${STAGE_TWO}, retain goal.txt, and run exactly ${second.validation}. Return status: DONE only after the actual worker result. Do not call sortie_compact_and_continue, scout, reviewer, coordinator shell, or any extra dispatch.`;
  const candidate = await runGoal(secondPrompt, candidateSessionID, "candidate-unit-2");
  const observation = await goalObservation(ledgerPath, goalID);
  assert.equal(observation.receipt?.status, "succeeded");
  assert.equal(observation.receipt?.goal_id, goalID);
  assert.ok(observation.consumedUnits >= 2, "candidate must settle a valid next unit");
  assert.ok(observation.issuedTickets.length >= 1 && observation.consumedTickets.length >= 1, "native ticket roundtrip missing");
  assert.equal(observation.dispatchAfterTerminal, 0);
  assert.ok(observation.evidence.length >= 2, "both automatic native validation evidence records are required");
  for (const evidence of observation.evidence) {
    assert.match(evidence.source, /^sha256:[a-f0-9]{64}$/u);
    assert.match(evidence.candidate, /^sha256:[a-f0-9]{64}$/u);
    assert.ok(VALIDATIONS.includes(evidence.command[0]));
    assert.equal(evidence.exit, 0);
    assert.equal(evidence.outcome, "pass");
    assert.ok(evidence.protectedBinding);
  }
  assert.deepEqual(new Set(observation.evidence.map((entry) => entry.command[0])), new Set(VALIDATIONS));
  const ticketRejections = await rejectedTicketChecks(candidateIdentity.packageRoot, ledgerPath, observation);
  summary.candidate = { identity: { ...candidateIdentity, packageRoot: undefined }, checkpoint: checkpoint.metadata,
    unitOneTranscript: unitOne.metadata,
    transcript: candidate.metadata, loadedPlugin: candidate.paths, sameSessionRestart: candidate.metadata.sessionIDs.includes(candidateSessionID),
    sessionID: candidateSessionID, baselineSessionID: sessionID, goalID, goalPreservedAcrossRestart: true, checkpointEventCount: checkpointObservation.eventCount,
    eventCount: observation.eventCount, eventKinds: observation.eventKinds, consumedUnits: observation.consumedUnits,
    unitIDs: observation.unitIDs, ticketRoundtrip: { issued: observation.issuedTickets.length, consumed: observation.consumedTickets.length },
    receipt: observation.receipt, evidence: observation.evidence, dispatchAfterTerminal: observation.dispatchAfterTerminal,
    ticketRejections, goalValue: (await readFile(join(PROJECT, "goal.txt"), "utf8")).trim(),
    stageValue: (await readFile(join(PROJECT, "stage.txt"), "utf8")).trim() };
  assert.equal(summary.candidate.goalValue, EXPECTED);
  assert.equal(summary.candidate.stageValue, STAGE_TWO);
  assert.equal(summary.candidate.sameSessionRestart, true);
  summary.status = "pass";
  summary.phase = "complete";
  }
} catch (error) {
  summary.status = "fail";
  summary.failure = boundedError(error);
  process.exitCode = 1;
} finally {
  summary.phase = summary.status === "pass" ? "cleanup" : summary.phase;
  for (const pid of observedPids) await stopGroup({ pid }, "SIGTERM");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, observedPids.size === 0 ? 0 : 1_000));
  for (const pid of observedPids) {
    try { process.kill(-pid, 0); await stopGroup({ pid }, "SIGKILL"); } catch {}
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, observedPids.size === 0 ? 0 : 250));
  let alive = 0;
  for (const pid of observedPids) { try { process.kill(-pid, 0); alive += 1; } catch {} }
  summary.processesStopped = ownedProcesses.size === 0 && alive === 0;
  summary.processObservation = { launched: observedPids.size, active: ownedProcesses.size, aliveGroups: alive };
  if (summary.status === "pass") summary.phase = "complete";
  await write(RESULT, `${JSON.stringify(summary, null, 2)}\n`);
}

process.stdout.write(`${JSON.stringify({ status: summary.status, phase: summary.phase,
  result: relative(REPO, RESULT).replaceAll("\\", "/"), processesStopped: summary.processesStopped,
  ...(summary.failure === undefined ? {} : { failure: summary.failure }) })}\n`);
