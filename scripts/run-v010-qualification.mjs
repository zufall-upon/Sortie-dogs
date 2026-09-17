#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { dirname, basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";

import { validateManifest } from "../test/fixtures/frontierharness-local/run-local-case-study.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUNNER = join(REPOSITORY_ROOT, "test", "fixtures", "frontierharness-local", "run-local-case-study.mjs");
const RECEIPT = "qualification-execution.json";
const GENERATED_MANIFEST = "qualification-manifest.json";
const SUMMARY = "sanitized-summary.json";
const DEBUG_MAX_CYCLES = 12;
const CRITICAL_DIST_FILES = Object.freeze([
  "dist/asset-version.js",
  "dist/runtime-assets-v010.js",
  "dist/core/operator-runtime.js",
  "dist/core/operator-proposal.js",
  "dist/core/git-managed-state.js",
  "dist/plugin/profiled.js",
]);

const digest = value => createHash("sha256").update(value).digest("hex");
const exists = async path => Boolean(await stat(path).catch(error => {
  if (error?.code === "ENOENT") return null;
  throw error;
}));
const ensure = (condition, message) => { if (!condition) throw new Error(message); };

function inside(parent, child) {
  const value = relative(resolve(parent), resolve(child));
  return value !== "" && !value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value);
}

async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, path);
}

function generatedRunId(now = new Date(), bytes = randomBytes(4)) {
  return `v010-qualification-${now.toISOString().replace(/[-:.]/gu, "")}-${bytes.toString("hex")}`;
}

export function parseQualificationArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--debug" || key === "--refresh-candidate") { options[key === "--debug" ? "debug" : "refreshCandidate"] = true; continue; }
    ensure(key === "--base-manifest" || key === "--output" || key === "--resume-debug", `Unknown option: ${key}`);
    ensure(argv[index + 1] !== undefined, `Missing value for ${key}`);
    options[key === "--base-manifest" ? "baseManifestPath" : key === "--resume-debug" ? "resumeDebug" : "output"] = argv[++index];
  }
  ensure(!(options.resumeDebug && (options.baseManifestPath || options.output || options.debug)),
    "--resume-debug cannot be combined with start options");
  ensure(!options.refreshCandidate || options.resumeDebug, "--refresh-candidate requires --resume-debug");
  ensure(options.resumeDebug || (typeof options.baseManifestPath === "string" && options.baseManifestPath.length > 0),
    "--base-manifest is required unless --resume-debug is used");
  return options;
}

export function createQualificationManifest(base, baseManifestPath, artifact) {
  ensure(base?.profile === "v010" && base.qualification_only === true,
    "Base manifest must be the v010 qualification-only profile");
  ensure(base.protocol?.attempts_per_arm === 1 && base.protocol?.retry_count === 0,
    "Base manifest must retain one attempt and retry zero");
  const manifest = structuredClone(base);
  manifest.paths = {
    ...manifest.paths,
    runtime_root: "run",
    official_root: resolve(dirname(resolve(baseManifestPath)), manifest.paths.official_root),
    package_tgz: artifact.filename,
  };
  manifest.package = {
    ...manifest.package,
    sha256: artifact.sha256,
    version: artifact.version,
    runtime_marker: artifact.runtimeMarker,
  };
  return manifest;
}

function tarFiles(tgz) {
  const tar = gunzipSync(tgz);
  const files = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const text = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/su, "");
    const name = text(0, 100);
    const prefix = text(345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const sizeText = text(124, 12).trim();
    const size = sizeText === "" ? 0 : Number.parseInt(sizeText, 8);
    ensure(Number.isSafeInteger(size) && size >= 0, "Package archive has an invalid tar entry size");
    const body = offset + 512;
    ensure(body + size <= tar.length, "Package archive is truncated");
    const type = text(156, 1);
    if (type === "" || type === "0") {
      ensure(!files.has(path), `Package archive repeats ${path}`);
      files.set(path, tar.subarray(body, body + size));
    }
    offset = body + Math.ceil(size / 512) * 512;
  }
  return files;
}

export async function verifyCurrentPackage(tgzPath, repositoryRoot = REPOSITORY_ROOT) {
  const tgz = await readFile(tgzPath);
  const archive = tarFiles(tgz);
  const criticalDistSha256 = {};
  for (const path of CRITICAL_DIST_FILES) {
    const current = await readFile(join(repositoryRoot, path));
    const packed = archive.get(`package/${path}`);
    ensure(packed && digest(packed) === digest(current), `Packed ${path} differs from current dist`);
    criticalDistSha256[path] = digest(packed);
  }
  const packageBytes = archive.get("package/package.json");
  ensure(packageBytes, "Packed package.json is missing");
  const packedPackage = JSON.parse(packageBytes.toString("utf8"));
  const currentPackage = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  ensure(packedPackage.version === currentPackage.version, "Packed version differs from current package.json");
  const markerModule = await import(`${pathToFileURL(join(repositoryRoot, "dist", "asset-version.js")).href}?qualification=${randomUUID()}`);
  const runtimeMarker = markerModule.V010_RUNTIME_ASSET_VERSION;
  ensure(typeof runtimeMarker === "string" && runtimeMarker.length > 0, "Current V010 runtime marker export is missing");
  ensure(archive.get("package/dist/asset-version.js")?.includes(Buffer.from(JSON.stringify(runtimeMarker))),
    "Packed V010 runtime marker differs from the built export");
  return { filename: basename(tgzPath), sha256: digest(tgz), version: currentPackage.version, runtimeMarker,
    criticalDistSha256, modulesSha256: digest(JSON.stringify(criticalDistSha256)) };
}

async function wait(milliseconds) { await new Promise(done => setTimeout(done, milliseconds)); }

async function taskkill(pid, force) {
  await new Promise(done => {
    const child = spawn("taskkill.exe", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
      { shell: false, windowsHide: true, stdio: "ignore" });
    child.once("error", () => done());
    child.once("close", () => done());
  });
}

export async function terminateOwnedProcess(handle) {
  if (!handle || handle.closed || !Number.isInteger(handle.pid)) return;
  if (process.platform === "win32") await taskkill(handle.pid, false);
  else { try { process.kill(-handle.pid, "SIGTERM"); } catch {} }
  await wait(1_000);
  if (handle.closed) return;
  if (process.platform === "win32") await taskkill(handle.pid, true);
  else { try { process.kill(-handle.pid, "SIGKILL"); } catch {} }
}

export async function spawnCommand(executable, args, { cwd, capture = false, onSpawn, onClose } = {}) {
  return await new Promise(resolvePromise => {
    let stdout = "";
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true,
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const handle = { pid: child.pid, closed: false };
    onSpawn?.(handle);
    child.stdout.on("data", chunk => {
      if (capture) stdout += chunk;
      else process.stdout.write(chunk);
    });
    child.stderr.on("data", chunk => process.stderr.write(chunk));
    child.once("error", () => {
      handle.closed = true;
      onClose?.(handle);
      resolvePromise({ exit: 127, stdout: "" });
    });
    child.once("close", (code, signal) => {
      handle.closed = true;
      onClose?.(handle);
      resolvePromise({ exit: code ?? (signal ? 1 : 0), stdout });
    });
  });
}

function packedFilename(stdout) {
  const result = JSON.parse(stdout);
  ensure(Array.isArray(result) && result.length === 1 && typeof result[0]?.filename === "string",
    "npm pack did not report exactly one package");
  const filename = result[0].filename;
  ensure(filename === basename(filename) && filename.endsWith(".tgz"), "npm pack returned an unsafe filename");
  return filename;
}

export async function runQualification(options, dependencies = {}) {
  const repositoryRoot = resolve(dependencies.repositoryRoot ?? REPOSITORY_ROOT);
  const runner = resolve(dependencies.runner ?? join(repositoryRoot, "test", "fixtures", "frontierharness-local", "run-local-case-study.mjs"));
  const command = dependencies.command ?? spawnCommand;
  const inspectPackage = dependencies.inspectPackage ?? verifyCurrentPackage;
  const clock = dependencies.clock ?? (() => Date.now());
  const npmCli = dependencies.npmCli ?? process.env.npm_execpath ??
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const testenv = join(repositoryRoot, "_testenv");
  await mkdir(testenv, { recursive: true });
  const resumingDebug = typeof options.resumeDebug === "string";
  let baseManifestPath;
  let base;
  let outputRoot;
  if (resumingDebug) {
    outputRoot = resolve(repositoryRoot, options.resumeDebug);
    ensure(inside(testenv, outputRoot) && await exists(outputRoot), "Debug run root must be an existing child of repository _testenv");
  } else {
    baseManifestPath = resolve(repositoryRoot, options.baseManifestPath);
    base = JSON.parse(await readFile(baseManifestPath, "utf8"));
    validateManifest(base, baseManifestPath, repositoryRoot);
    ensure(base.profile === "v010" && base.qualification_only === true &&
      base.protocol.attempts_per_arm === 1 && base.protocol.retry_count === 0,
    "Base manifest is not a one-shot v010 qualification manifest");
    const priorReceipt = await readFile(join(dirname(baseManifestPath), RECEIPT), "utf8").then(JSON.parse).catch(() => null);
    ensure(priorReceipt?.debug_mode !== true, "A clean qualification cannot reuse a debug run manifest/root");
    outputRoot = options.output ? resolve(repositoryRoot, options.output)
      : join(testenv, generatedRunId(dependencies.date?.() ?? new Date(), dependencies.randomBytes?.(4) ?? randomBytes(4)));
    ensure(inside(testenv, outputRoot), "Output must be a new child of repository _testenv");
    ensure(!await exists(outputRoot), "Output root already exists; refusing overwrite");
    await mkdir(outputRoot, { recursive: false });
  }
  const receiptPath = join(outputRoot, RECEIPT);
  const receipt = resumingDebug ? JSON.parse(await readFile(receiptPath, "utf8")) : {
    schema_version: 1, run_id: basename(outputRoot), status: "running",
    attempt_count: 1, retry_count: 0, package: { sha256: null, version: null, runtime_marker: null },
    phases: [], reward: null, cleanup: { status: "not-required", exit: null },
    ...(options.debug ? { debug_mode: true, quality_gate: false, methodology_comparable: false,
      debug: { status: "running", cycles: [], max_cycles: DEBUG_MAX_CYCLES } } : {}) };
  ensure(!resumingDebug || receipt.debug_mode === true, "--resume-debug requires a debug qualification receipt");
  ensure(!resumingDebug || receipt.status === "debug-paused", "--resume-debug requires a paused debug qualification");
  if (resumingDebug) receipt.status = "running";
  await atomicJson(receiptPath, receipt);
  let primaryExit = 0;
  let summarySucceeded = false;
  let manifestPath = resumingDebug ? join(outputRoot, GENERATED_MANIFEST) : undefined;
  let cancellationRequested = false;
  let cancellationExit = 0;
  let cancellationTask;
  let activeHandle;
  let activeRunnerPhase;
  const controlCommand = dependencies.controlCommand ?? command;
  const requestCancellation = signal => {
    if (cancellationRequested) return;
    cancellationRequested = true;
    cancellationExit = signal === "SIGINT" ? 130 : 143;
    if (!manifestPath || !["run-arm", "verify-arm"].includes(activeRunnerPhase)) return;
    const phaseAtSignal = activeRunnerPhase;
    const handleAtSignal = activeHandle;
    const started = clock();
    cancellationTask = (async () => {
      const args = [runner, "cancel", "--arm", "sortie", "--signal", signal, "--confirm",
        "--manifest", manifestPath];
      let result;
      try { result = await controlCommand(process.execPath, args, { cwd: repositoryRoot, control: true }); }
      catch { result = { exit: 1 }; }
      for (let elapsed = 0; handleAtSignal && !handleAtSignal.closed && elapsed < 10_000; elapsed += 100)
        await wait(100);
      if (handleAtSignal && !handleAtSignal.closed) await terminateOwnedProcess(handleAtSignal);
      if (result.exit !== 0) {
        try { result = await controlCommand(process.execPath, args, { cwd: repositoryRoot, control: true }); }
        catch { result = { exit: 1 }; }
      }
      return { ...result, command: `cancel-${phaseAtSignal}`, duration_ms: Math.max(0, clock() - started) };
    })();
  };
  const onSigint = () => requestCancellation("SIGINT");
  const onSigterm = () => requestCancellation("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  const phase = async (name, operation) => {
    const started = clock();
    let result;
    try { result = await operation(); }
    catch { result = { exit: 1 }; }
    if (!Number.isInteger(result?.exit)) result = { ...result, exit: 1 };
    receipt.phases.push({ command: name, exit: result.exit, duration_ms: Math.max(0, clock() - started) });
    await atomicJson(receiptPath, receipt);
    return result;
  };
  const runnerPhase = (name, args = []) => phase(name, async () => {
    const longPhase = ["run-arm", "resume-arm", "verify-arm"].includes(args[0]);
    if (longPhase) activeRunnerPhase = args[0];
    try {
      return await command(process.execPath, [runner, ...args, "--manifest", manifestPath], { cwd: repositoryRoot,
        onSpawn: handle => { if (longPhase) activeHandle = handle; },
        onClose: handle => { if (activeHandle === handle) activeHandle = undefined; } });
    } finally { if (longPhase) activeRunnerPhase = undefined; }
  });

  const debugState = async () => JSON.parse(await readFile(join(outputRoot, "run", "frontierharness-state.json"), "utf8"));
  const syncDebugReceipt = async () => {
    if (!receipt.debug_mode) return null;
    const state = await debugState();
    receipt.debug = { status: state.debug?.status ?? "paused", cycles: state.debug?.executions ?? [],
      max_cycles: state.debug?.max_cycles ?? DEBUG_MAX_CYCLES, started_at: state.debug?.started_at ?? null,
      deadline_at: state.debug?.deadline_at ?? null,
      refreshes: state.debug?.refreshes ?? receipt.debug?.refreshes ?? [] };
    await atomicJson(receiptPath, receipt);
    return state;
  };
  const driveDebugContinuations = async forceFirst => {
    let force = forceFirst;
    let lastExit = 1;
    for (;;) {
      const before = await debugState();
      const arm = before.arms?.sortie;
      const workspace = join(outputRoot, "run", "workspaces", "sortie");
      const reason = arm?.run?.expected_operation?.reason;
      const permitted = before.debug?.mode === "state-preserving" &&
        ["recoverable", "paused"].includes(before.debug?.status) &&
        ["agent-event-error", "debug-unknown-agent-event-error", "debug-public-recovery-unproven",
          "delivery-not-complete"].includes(reason) &&
        /^ses_[A-Za-z0-9_-]+$/u.test(arm?.run?.root_session_id ?? "") &&
        arm?.active_pid === null && (arm?.verification?.active_pid === undefined || arm.verification.active_pid === null) &&
        (await stat(workspace).catch(() => null))?.isDirectory() === true &&
        before.debug?.executions?.length < before.debug?.max_cycles && Date.now() < Date.parse(before.debug?.deadline_at);
      if (!permitted || (!force && before.debug?.status !== "recoverable")) break;
      force = false;
      const resumed = await runnerPhase("resume-arm-sortie-debug", ["resume-arm", "--arm", "sortie", "--debug"]);
      lastExit = resumed.exit;
      const after = await syncDebugReceipt();
      if (after?.debug?.status === "completed") return 0;
      if (after?.debug?.status !== "recoverable") break;
    }
    return lastExit || 1;
  };

  try {
    if (resumingDebug) {
      validateManifest(JSON.parse(await readFile(manifestPath, "utf8")), manifestPath, repositoryRoot);
      if (options.refreshCandidate) {
        const refreshRoot = join(outputRoot, "refreshes", `refresh-${generatedRunId(dependencies.date?.() ?? new Date(),
          dependencies.randomBytes?.(4) ?? randomBytes(4)).slice("v010-qualification-".length)}`);
        await mkdir(dirname(refreshRoot), { recursive: true });
        ensure(!await exists(refreshRoot), "Refresh output already exists; refusing overwrite");
        await mkdir(refreshRoot, { recursive: false });
        const build = await phase("refresh-npm-build", () => command(process.execPath, [npmCli, "run", "build"],
          { cwd: repositoryRoot }));
        if (build.exit !== 0) primaryExit = build.exit;
        let artifact;
        if (primaryExit === 0 && !cancellationRequested) {
          const packed = await phase("refresh-npm-pack", async () => {
            const result = await command(process.execPath,
              [npmCli, "pack", "--json", "--pack-destination", refreshRoot], { cwd: repositoryRoot, capture: true });
            if (result.exit !== 0) return result;
            const filename = packedFilename(result.stdout);
            const tgzPath = join(refreshRoot, filename);
            ensure(await exists(tgzPath), "npm refresh pack output is missing");
            artifact = await inspectPackage(tgzPath, repositoryRoot);
            ensure(artifact.filename === filename && artifact.criticalDistSha256 && artifact.modulesSha256,
              "Inspected refresh package identity is incomplete");
            return result;
          });
          if (packed.exit !== 0 || !artifact) primaryExit = packed.exit || 1;
        }
        if (primaryExit === 0 && !cancellationRequested) {
          const candidatePath = join(refreshRoot, "refresh-candidate.json");
          await atomicJson(candidatePath, { schema_version: 1, package: { path: artifact.filename,
            sha256: artifact.sha256, version: artifact.version, runtime_marker: artifact.runtimeMarker,
            critical_dist_sha256: artifact.criticalDistSha256, modules_sha256: artifact.modulesSha256 } });
          const refreshed = await runnerPhase("refresh-sortie-package", ["refresh-sortie-package", "--candidate", candidatePath]);
          if (refreshed.exit !== 0) primaryExit = refreshed.exit;
          else {
            receipt.debug.refreshes = [...(receipt.debug.refreshes ?? []), { package_sha256: artifact.sha256,
              modules_sha256: artifact.modulesSha256, version: artifact.version, runtime_marker: artifact.runtimeMarker }];
            await atomicJson(receiptPath, receipt);
          }
        }
      }
      if (primaryExit === 0 && !cancellationRequested) {
        primaryExit = await driveDebugContinuations(true);
        const state = await syncDebugReceipt();
        if (state?.debug?.status === "completed") primaryExit = 0;
        if (primaryExit === 0 && !cancellationRequested) {
          const verify = await runnerPhase("verify-arm-sortie", ["verify-arm", "--arm", "sortie"]);
          if (verify.exit !== 0) primaryExit = verify.exit;
        }
      }
    } else {
    const build = await phase("npm-build", () => command(process.execPath, [npmCli, "run", "build"],
      { cwd: repositoryRoot }));
    if (build.exit !== 0) primaryExit = build.exit;
    let artifact;
    if (primaryExit === 0 && !cancellationRequested) {
      const packed = await phase("npm-pack", async () => {
        const result = await command(process.execPath,
          [npmCli, "pack", "--json", "--pack-destination", outputRoot], { cwd: repositoryRoot, capture: true });
        if (result.exit !== 0) return result;
        const filename = packedFilename(result.stdout);
        const tgzPath = join(outputRoot, filename);
        ensure(await exists(tgzPath), "npm pack output is missing");
        artifact = await inspectPackage(tgzPath, repositoryRoot);
        ensure(artifact.filename === filename, "Inspected package filename mismatch");
        return result;
      });
      if (packed.exit !== 0 || !artifact) primaryExit = packed.exit || 1;
    }
    if (primaryExit === 0 && !cancellationRequested) {
      receipt.package = { sha256: artifact.sha256, version: artifact.version, runtime_marker: artifact.runtimeMarker };
      const generated = createQualificationManifest(base, baseManifestPath, artifact);
      manifestPath = join(outputRoot, GENERATED_MANIFEST);
      validateManifest(generated, manifestPath, repositoryRoot);
      await atomicJson(manifestPath, generated);
      await atomicJson(receiptPath, receipt);

      const preflight = await runnerPhase("preflight", ["preflight"]);
      if (preflight.exit !== 0 && primaryExit === 0) primaryExit = preflight.exit;
      if (primaryExit === 0 && !cancellationRequested) {
        const prepare = await runnerPhase("prepare", ["prepare"]);
        if (prepare.exit !== 0 && primaryExit === 0) primaryExit = prepare.exit;
      }
      if (primaryExit === 0 && !cancellationRequested) {
        const run = await runnerPhase(options.debug ? "run-arm-sortie-debug" : "run-arm-sortie",
          ["run-arm", "--arm", "sortie", ...(options.debug ? ["--debug"] : [])]);
        if (options.debug) {
          await syncDebugReceipt();
          primaryExit = run.exit === 0 ? 0 : await driveDebugContinuations(false);
          const state = await syncDebugReceipt();
          if (state?.debug?.status === "completed") primaryExit = 0;
        } else if (run.exit !== 0 && primaryExit === 0) primaryExit = run.exit;
        if (primaryExit === 0 && !cancellationRequested) {
          const verify = await runnerPhase("verify-arm-sortie", ["verify-arm", "--arm", "sortie"]);
          if (verify.exit !== 0 && primaryExit === 0) primaryExit = verify.exit;
        }
      }
    }
    }
    if (cancellationRequested) primaryExit = cancellationExit;
  } catch {
    if (primaryExit === 0) primaryExit = 1;
  } finally {
    if (cancellationRequested) primaryExit = cancellationExit;
    try {
      if (cancellationTask) {
        const cancelled = await cancellationTask;
        receipt.phases.push({ command: cancelled.command, exit: cancelled.exit,
          duration_ms: cancelled.duration_ms });
        await atomicJson(receiptPath, receipt);
      }
       if (manifestPath && await exists(join(outputRoot, "run"))) {
        const preservedDebug = receipt.debug_mode && !cancellationRequested &&
          (await debugState().catch(() => null))?.debug?.status !== "completed";
        const summarized = await runnerPhase("summarize", ["summarize"]);
        summarySucceeded = summarized.exit === 0;
        if (!summarySucceeded && primaryExit === 0) primaryExit = summarized.exit || 1;
        if (summarySucceeded) {
          try {
            const summary = JSON.parse(await readFile(join(outputRoot, "run", SUMMARY), "utf8"));
            receipt.reward = typeof summary?.arms?.sortie?.reward === "number" ? summary.arms.sortie.reward : null;
            if (summary?.arms?.sortie?.outcome !== "succeeded" || receipt.reward !== 1) {
              if (primaryExit === 0) primaryExit = 1;
            }
          } catch { if (primaryExit === 0) primaryExit = 1; }
           if (preservedDebug) receipt.cleanup = { status: "preserved", exit: null };
           else {
             const cleaned = await runnerPhase("cleanup", ["cleanup", "--confirm"]);
             receipt.cleanup = { status: cleaned.exit === 0 ? "complete" : "failed", exit: cleaned.exit };
             if (cleaned.exit !== 0 && primaryExit === 0) primaryExit = cleaned.exit;
           }
        } else receipt.cleanup = { status: "not-run", exit: null };
      }
    } catch {
      receipt.cleanup = { status: "failed", exit: null };
      if (primaryExit === 0) primaryExit = 1;
    }
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    if (cancellationRequested) primaryExit = cancellationExit;
    if (receipt.debug_mode) await syncDebugReceipt().catch(() => null);
    receipt.status = cancellationRequested ? "cancelled" : receipt.debug_mode && receipt.debug?.status !== "completed"
      ? "debug-paused" : primaryExit === 0 ? "succeeded" : "failed";
    await atomicJson(receiptPath, receipt);
  }
  return { exitCode: primaryExit, outputRoot, receipt };
}

export async function main(argv = process.argv.slice(2)) {
  const result = await runQualification(parseQualificationArgs(argv));
  process.stdout.write(`${JSON.stringify({ status: result.receipt.status, run_id: result.receipt.run_id,
    exit: result.exitCode })}\n`);
  process.exitCode = result.exitCode;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main().catch(() => {
  process.stderr.write(`${JSON.stringify({ status: "failed", gate: "qualification-wrapper" })}\n`);
  process.exitCode = 1;
});
