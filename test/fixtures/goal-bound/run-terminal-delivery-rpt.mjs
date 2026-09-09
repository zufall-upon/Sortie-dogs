import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = resolve(import.meta.dirname, "../../..");
const valueAfter = (flag) => process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined;
const baselineArg = valueAfter("--baseline");
const outputArg = valueAfter("--output");
assert.ok(baselineArg && outputArg, "--baseline and --output are required");
const BASELINE = resolve(REPO, baselineArg);
const ROOT = resolve(REPO, outputArg);
assert.ok(ROOT.startsWith(`${join(REPO, "_testenv")}${sep}`), "output must be a child of _testenv");
const CANDIDATE_DIR = join(ROOT, "candidate-package");
const packageVersion = JSON.parse(await readFile(join(REPO, "package.json"), "utf8")).version;
const CANDIDATE = join(CANDIDATE_DIR, `sortie-dogs-${packageVersion}.tgz`);
const RESULT = join(ROOT, "terminal-delivery-summary.json");
const OPENCODE = process.env.OPENCODE_BIN?.trim() || "opencode";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const started = Date.now();
const owned = new Map();
const observed = new Set();
const write = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value); };
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const boundedFailure = (error, phase) => ({ phase, code: String(error?.code ?? error?.name ?? "Error"),
  messageFingerprint: sha256(String(error?.message ?? error)) });

async function stopGroup(pid, signal) {
  try { process.kill(-pid, signal); } catch {}
}

async function command(executable, args, cwd, env, timeout = 180_000) {
  assert.ok(Date.now() - started < 600_000, "fixture wall limit exceeded");
  return await new Promise((done) => {
    const child = spawn(executable, args, { cwd, env, detached: true, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false, launchError;
    if (child.pid) { owned.set(child.pid, child); observed.add(child.pid); }
    const append = (current, chunk) => (current + String(chunk)).slice(-(16 * 1024 * 1024));
    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => { launchError = error; });
    const timer = setTimeout(async () => {
      timedOut = true;
      if (child.pid) await stopGroup(child.pid, "SIGTERM");
      setTimeout(() => { if (child.pid && child.exitCode === null) void stopGroup(child.pid, "SIGKILL"); }, 3_000).unref();
    }, timeout);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (child.pid) owned.delete(child.pid);
      done({ exit: Number.isInteger(code) ? code : launchError ? 127 : timedOut ? 124 : 1,
        signal: signal ?? null, timedOut, stdout, stderr });
    });
  });
}

async function checked(executable, args, cwd, env, timeout, phase) {
  const result = await command(executable, args, cwd, env, timeout);
  assert.equal(result.exit, 0, JSON.stringify({ phase, exit: result.exit, signal: result.signal,
    timedOut: result.timedOut, stderrFingerprint: sha256(result.stderr) }));
  return result;
}

function records(value, output = []) {
  if (Array.isArray(value)) value.forEach((entry) => records(entry, output));
  else if (value !== null && typeof value === "object") {
    output.push(value);
    Object.values(value).forEach((entry) => records(entry, output));
  }
  return output;
}

function transcript(result) {
  const events = result.stdout.split(/\r?\n/u).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const all = records(events);
  const sessionIDs = [...new Set(all.flatMap((entry) => [entry.sessionID, entry.sessionId, entry.session_id,
    entry.part?.sessionID]).filter((entry) => typeof entry === "string" && entry.startsWith("ses_")))];
  const texts = [...new Set(all.flatMap((entry) => [entry.text, entry.part?.text])
    .filter((entry) => typeof entry === "string" && entry.trim() !== ""))];
  const eventErrors = [...new Set(all.flatMap((entry) => [entry.error?.name, entry.error?.code, entry.code])
    .filter((entry) => typeof entry === "string" && /^[A-Za-z0-9_-]{2,80}$/u.test(entry)))];
  const usage = new Map();
  let usageIdentityMissing = false;
  for (const entry of all) {
    const role = entry.info?.role ?? entry.role;
    const stepUsage = entry.type === "step-finish" || entry.type === "step_finish";
    if (role !== "assistant" && !stepUsage) continue;
    const source = entry.info ?? entry;
    const id = source.id ?? entry.id;
    const tokens = source.tokens ?? entry.tokens;
    const cost = source.cost ?? entry.cost;
    if (tokens === undefined && cost === undefined) continue;
    if (typeof id !== "string") { usageIdentityMissing = true; continue; }
    usage.set(id, { tokens, cost });
  }
  let tokenTotal = 0, tokensAvailable = usage.size > 0 && !usageIdentityMissing;
  let costTotal = 0, costAvailable = usage.size > 0 && !usageIdentityMissing;
  for (const item of usage.values()) {
    const tokens = item.tokens;
    const fields = [tokens?.input, tokens?.output, tokens?.reasoning, tokens?.cache?.read, tokens?.cache?.write];
    if (!fields.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) tokensAvailable = false;
    else tokenTotal += fields.reduce((sum, value) => sum + value, 0);
    if (typeof item.cost !== "number" || !Number.isFinite(item.cost) || item.cost < 0) costAvailable = false;
    else costTotal += item.cost;
  }
  return { sessionIDs, texts, eventErrors, eventCount: events.length, stdoutBytes: Buffer.byteLength(result.stdout),
    stderrBytes: Buffer.byteLength(result.stderr), stdoutFingerprint: sha256(result.stdout),
    stderrFingerprint: sha256(result.stderr), usageRecords: usage.size,
    tokens: { availability: tokensAvailable ? "available" : "unavailable", value: tokensAvailable ? tokenTotal : null },
    cost: { availability: costAvailable ? "available" : "unavailable", value: costAvailable ? costTotal : null } };
}

async function buildCandidate(env) {
  await mkdir(CANDIDATE_DIR, { recursive: true });
  await checked("npm", ["run", "build"], REPO, env, 180_000, "candidate-build");
  await checked("npm", ["pack", "--ignore-scripts", "--pack-destination", CANDIDATE_DIR], REPO, env, 180_000, "candidate-pack");
  assert.ok((await stat(CANDIDATE)).isFile());
  return sha256(await readFile(CANDIDATE));
}

async function seedProject(project) {
  await mkdir(join(project, ".opencode"), { recursive: true });
  await write(join(project, ".gitignore"), ".opencode/sortie-dogs-luna-fabric.json\n.sortie-dogs/\n.opencode/\n");
  await write(join(project, "base.txt"), "terminal delivery fixture\n");
  await write(join(project, "test", ".gitkeep"), "");
  await write(join(project, "validate.mjs"), `import assert from "node:assert/strict"; import {readFile} from "node:fs/promises";
const unit=process.argv[2]; if(unit==="all"){for(const id of ["a","b"])assert.equal((await readFile("test/"+id+".txt","utf8")).trim(),"delivered-"+id);}else assert.equal((await readFile("test/"+unit+".txt","utf8")).trim(),"delivered-"+unit);\n`);
  await checked("git", ["init", "-q", "-b", "main"], project, process.env, 60_000, "git-init");
  await checked("git", ["add", "--", ".gitignore", "base.txt", "validate.mjs", "test/.gitkeep"], project, process.env, 60_000, "git-add");
  await checked("git", ["-c", "user.name=Sortie Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "-qm", "fixture seed"], project, process.env, 60_000, "git-commit");
  const head = (await checked("git", ["rev-parse", "HEAD"], project, process.env, 60_000, "git-head")).stdout.trim();
  await checked("git", ["branch", "delivery-target", head], project, process.env, 60_000, "git-target");
  const contract = { version: "0.8.0", provenance: { source: "dog-coordinator",
    acceptance_fingerprint: "d".repeat(64), target_branch: "delivery-target", target_sha: head },
    acceptance_items: ["deliver-a", "deliver-b"], effects: [], shared_paths: [],
    units: ["a", "b"].map((id, scheduler_order) => ({ unit_id: id, acceptance_items: [`deliver-${id}`],
      scope_read: ["base.txt", "validate.mjs"], scope_write: [`test/${id}.txt`], depends_on: [],
      validation: { level: "targeted", command: [process.execPath, "validate.mjs", id] },
      shared_path_keys: [], exclusive_resources: [], scheduler_order })) };
  await write(join(project, ".opencode", "sortie-dogs-luna-fabric.json"), `${JSON.stringify(contract, null, 2)}\n`);
  return { head, contractPath: join(project, ".opencode", "sortie-dogs-luna-fabric.json") };
}

async function install(project, archive, label) {
  const control = join(project, ".opencode");
  const dependency = `file:${relative(control, archive).replaceAll("\\", "/")}`;
  await write(join(control, "package.json"), `${JSON.stringify({ private: true, type: "module",
    dependencies: { "@opencode-ai/plugin": "1.18.29", "sortie-dogs": dependency } })}\n`);
  const env = { ...process.env, PWD: control };
  await checked("npm", ["install", "--force"], control, env, 180_000, `${label}-install`);
  const packageRoot = join(control, "node_modules", "sortie-dogs");
  assert.equal((await lstat(packageRoot)).isSymbolicLink(), false);
  assert.ok((await realpath(packageRoot)).startsWith(`${await realpath(control)}${sep}`));
  assert.equal((await json(join(control, "package.json"))).dependencies["sortie-dogs"], dependency);
  assert.equal((await json(join(control, "package-lock.json"))).packages["node_modules/sortie-dogs"].link, undefined);
  await checked(process.execPath, [join(packageRoot, "dist", "cli", "main.js"), "init", project], project, env, 60_000, `${label}-init`);
  const identity = await json(join(packageRoot, "package.json"));
  const marker = (await readFile(join(control, "sortie-dogs.version"), "utf8")).trim();
  const plugin = pathToFileURL(join(packageRoot, "dist", "plugin", "opencode.js")).href;
  await write(join(control, "opencode.json"), `${JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: [plugin] })}\n`);
  return { packageVersion: identity.version, marker, archiveSha256: sha256(await readFile(archive)),
    pluginSha256: sha256(await readFile(join(packageRoot, "dist", "plugin", "index.js"))) };
}

async function runCLI(project, configRoot, message, sessionID, label) {
  const env = { ...process.env, PWD: project, OPENCODE_CONFIG: undefined, OPENCODE_CONFIG_CONTENT: undefined,
    OPENCODE_CONFIG_DIR: join(configRoot, "config"), XDG_CONFIG_HOME: join(configRoot, "xdg"),
    OPENCODE_SERVER_PASSWORD: undefined, OPENCODE_SERVER_USERNAME: undefined };
  await write(join(env.OPENCODE_CONFIG_DIR, "opencode.json"), '{"$schema":"https://opencode.ai/config.json"}\n');
  await write(join(env.XDG_CONFIG_HOME, "opencode", "opencode.json"), '{"$schema":"https://opencode.ai/config.json"}\n');
  const args = ["run", "--format", "json", "--print-logs", "--agent", "dog-coordinator"];
  if (sessionID) args.push("--session", sessionID);
  args.push(message);
  const before = Date.now();
  const result = await command(OPENCODE, args, project, env, 180_000);
  const metadata = transcript(result);
  return { exit: result.exit, signal: result.signal, timedOut: result.timedOut,
    elapsedMs: Date.now() - before, transcript: metadata, label,
    diagnosticCodes: [...new Set(result.stderr.match(/SORTIE_[A-Z0-9_-]+(?::\s*[a-z0-9-]+)?|fresh-session-required|goal-[a-z0-9-]+|active-run/giu) ?? [])] };
}

async function arm(label, archive, candidate = false) {
   const project = join(ROOT, "project");
   if (candidate) await rm(project, { recursive: true, force: true });
  const config = join(ROOT, label, "host");
  const fixture = await seedProject(project);
  const identity = await install(project, archive, label);
  const preparePrompt = `/sortie\nCall sortie_prepare_luna_fabric exactly once with contract_path ${fixture.contractPath}. Do not dispatch, advance, validate, review, accept, cancel, or ask a question. After the prepared result, deliberately return exactly status: DONE — preparation claimed complete. This is a terminal-boundary probe, not permission to fabricate completion.`;
  const checkpoint = await runCLI(project, config, preparePrompt, undefined, `${label}-checkpoint`);
  assert.equal(checkpoint.exit, 0, `${label} checkpoint CLI failed`);
  const sessionID = checkpoint.transcript.sessionIDs[0];
  assert.ok(sessionID, `${label} session id missing`);
  const statePath = join(project, ".git", "sortie-dogs", "parallel-dispatch-v5", "state.json");
  const state = await json(statePath);
  const durable = state.run?.kind === "run" ? state.run : state.archived?.at(-1)?.run;
  const visible = checkpoint.transcript.texts.join("\n");
  const observation = { identity, checkpoint, sessionID, activeRunID: durable?.run_id ?? null,
    durablePhase: state.run?.kind === "run" ? "active" : state.archived?.at(-1)?.terminal_reason ?? "absent",
    successClaimVisible: /(?:^|\n)(?:status:\s*DONE\b|✅\s+\*\*DONE\*\*)/iu.test(visible),
    incompleteVisible: /status:\s*(?:IN_PROGRESS|INTERRUPTED)|durable delivery active|実行待ち/iu.test(visible) };
  if (!candidate) return observation;
  if (state.run?.kind !== "run") return observation;
  const final = await runCLI(project, config,
    `/sortie\nThis is an explicit user cancellation of the pending fixture run ${state.run.run_id}. Call sortie_cancel_parallel_dispatch with this exact run_id. Do not dispatch workers or implement anything. After the runtime confirms cancellation and cleanup, report status: INTERRUPTED and state that the requested files were not delivered. Never report DONE.`,
    sessionID, `${label}-cancel`);
  const after = await json(statePath);
  const archiveState = after.archived?.find((entry) => entry.run?.run_id === state.run.run_id);
  const target = (await checked("git", ["rev-parse", "delivery-target"], project, process.env, 60_000, "target-head")).stdout.trim();
  const finalVisible = final.transcript.texts.join("\n");
  const completed = final.exit === 0 && final.transcript.sessionIDs.includes(sessionID) &&
    archiveState?.terminal_reason === "cancelled" && archiveState?.run?.fabric?.promoted === false &&
    target === fixture.head && after.run === null &&
    !/(?:^|\n)(?:status:\s*DONE\b|✅\s+\*\*DONE\*\*)/iu.test(finalVisible);
  return { ...observation, final, sameSession: final.transcript.sessionIDs.includes(sessionID),
    result: completed ? "cancelled-without-false-success" : "did-not-complete", promotedHead: target,
    terminalReason: archiveState?.terminal_reason ?? (after.run === null ? "absent" : "active"),
    promoted: archiveState?.run?.fabric?.promoted ?? false };
}

const summary = { schemaVersion: "terminal-delivery-rpt-v1", status: "running", phase: "preflight",
  processesStopped: false, root: relative(REPO, ROOT).replaceAll("\\", "/") };
try {
  assert.ok(isAbsolute(BASELINE) && (await stat(BASELINE)).isFile(), "baseline archive missing");
  if (process.argv.includes("--resume-cancellation")) {
    const previous = await json(RESULT);
    assert.equal(previous.cancellationRecovery, undefined, "only one cancellation recovery is allowed");
    assert.equal(previous.candidate?.successClaimVisible, false);
    assert.equal(previous.candidate?.incompleteVisible, true);
    assert.equal(previous.candidate?.final?.exit, 1, "only a CLI error permits this recovery");
    assert.equal(sha256(await readFile(CANDIDATE)), previous.candidateArchiveSha256);
    Object.assign(summary, previous, { status: "running", phase: "cancellation-recovery",
      cancellationRecovery: { previousFinal: previous.candidate.final, previousFailure: previous.failure } });
    delete summary.failure;
    const project = join(ROOT, "project");
    const runID = previous.candidate.activeRunID;
    const sessionID = previous.candidate.sessionID;
    const final = await runCLI(project, join(ROOT, "candidate", "host"),
      `/sortie\nExplicit user cancellation: call sortie_cancel_parallel_dispatch for run_id ${runID}. Do not dispatch or implement. Confirm cancellation and report status: INTERRUPTED, never DONE.`,
      sessionID, "candidate-cancel-recovery");
    const state = await json(join(project, ".git", "sortie-dogs", "parallel-dispatch-v5", "state.json"));
    const archived = state.archived?.find((entry) => entry.run?.run_id === runID);
    const target = (await checked("git", ["rev-parse", "delivery-target"], project, process.env, 60_000, "target-head")).stdout.trim();
    assert.equal(final.exit, 0);
    assert.ok(final.transcript.sessionIDs.includes(sessionID));
    assert.equal(archived?.terminal_reason, "cancelled");
    assert.equal(archived?.run?.fabric?.promoted, false);
    assert.equal(state.run, null);
    assert.equal(target, previous.candidate.promotedHead);
    assert.doesNotMatch(final.transcript.texts.join("\n"), /(?:^|\n)(?:status:\s*DONE\b|✅\s+\*\*DONE\*\*)/iu);
    Object.assign(summary.candidate, { final, sameSession: true, result: "cancelled-without-false-success",
      terminalReason: "cancelled", promoted: false });
  } else {
  assert.equal(await stat(ROOT).catch(() => undefined), undefined, "use a fresh output directory; preserve previous evidence");
  await mkdir(ROOT, { recursive: true });
  summary.phase = "candidate-build";
  summary.candidateArchiveSha256 = await buildCandidate(process.env);
  summary.phase = "baseline";
  summary.baseline = await arm("baseline", BASELINE, false);
  assert.equal(summary.baseline.successClaimVisible, true, "baseline did not reproduce premature success");
  summary.phase = "candidate";
  summary.candidate = await arm("candidate", CANDIDATE, true);
  assert.equal(summary.candidate.durablePhase, "active", "candidate active delivery was not retained");
  assert.equal(summary.candidate.successClaimVisible, false, "candidate must reject DONE while delivery is active");
  assert.equal(summary.candidate.incompleteVisible, true, "candidate must explain active incomplete delivery");
  assert.equal(summary.candidate.result, "cancelled-without-false-success", "candidate did not settle the cancelled run");
  assert.equal(summary.candidate.sameSession, true, "candidate did not resume the same session");
  assert.equal(summary.candidate.identity.packageVersion, packageVersion);
  assert.notEqual(summary.baseline.identity.pluginSha256, summary.candidate.identity.pluginSha256);
  assert.equal(summary.candidate.identity.marker, "0.3.77-terminal-delivery-v1");
  }
  summary.status = "pass";
  summary.phase = "complete";
} catch (error) {
  summary.status = "fail";
  summary.failure = boundedFailure(error, summary.phase);
  process.exitCode = 1;
} finally {
  for (const pid of observed) await stopGroup(pid, "SIGTERM");
  await new Promise((done) => setTimeout(done, observed.size === 0 ? 0 : 750));
  for (const pid of observed) { try { process.kill(-pid, 0); await stopGroup(pid, "SIGKILL"); } catch {} }
  await new Promise((done) => setTimeout(done, observed.size === 0 ? 0 : 250));
  let alive = 0;
  for (const pid of observed) { try { process.kill(-pid, 0); alive += 1; } catch {} }
  summary.processesStopped = owned.size === 0 && alive === 0;
  summary.processObservation = { launched: observed.size, active: owned.size, aliveGroups: alive };
  if (!summary.processesStopped) { summary.status = "fail"; process.exitCode = 1; }
  await write(RESULT, `${JSON.stringify(summary, (key, value) => key === "texts" ? undefined : value, 2)}\n`);
}

process.stdout.write(`${JSON.stringify({ status: summary.status, phase: summary.phase,
  result: relative(REPO, RESULT).replaceAll("\\", "/"), processesStopped: summary.processesStopped,
  ...(summary.failure ? { failure: summary.failure } : {}) })}\n`);
