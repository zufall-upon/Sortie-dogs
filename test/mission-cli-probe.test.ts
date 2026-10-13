import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { cliCloseStopReason, completeProbeObservations, missionDatabasePath, monitorMissionCLI, observeMissionCLI, observationDirectories, probeStopReason, statusProbeStopReason, workerStartWithinProbeLimit, probeTaskIdentity } from "../scripts/mission-cli-probe.mjs";
import { fixtureDataEnvironment, nativeCLI, spawnPromptCLI, stopProcessGroup } from "../scripts/release-cli.mjs";

const expected = "openai/gpt-6.1-sol#xhigh";
const root = { sessionID: "root", agent: "dog-operator", model: { providerID: "openai", id: "gpt-6.1-sol", variant: "xhigh" } };
const status = { agent: "dog-operator", tool: "sortie_v010_operator_status", status: "completed", model: root.model };

test("practical observation binds the exact original prompt and observed checkout, not the declared base", () => {
  const request = "Original task\r\nKeep exact bytes.\n";
  assert.deepEqual(probeTaskIdentity(request, { instance_id: "case", repo: "owner/repo", base_commit: "declared" }, "observed"), {
    task_sha256: createHash("sha256").update(request).digest("hex"),
    instance: { instance_id: "case", repo: "owner/repo", base_commit: "observed" },
  });
  assert.notEqual(probeTaskIdentity(request, undefined, "base").task_sha256,
    probeTaskIdentity(request.trim(), undefined, "base").task_sha256);
  assert.equal(probeTaskIdentity(request, undefined, "base").instance, null);
});

test("explicit status probe observes the requested model and returns on its first status result", () => {
  assert.equal(statusProbeStopReason({ root: "root", models: [], tools: [] }, expected), null);
  assert.equal(statusProbeStopReason({ root: "root", models: [root], tools: [] }, expected), null);
  assert.equal(statusProbeStopReason({ root: "root", models: [root], tools: [status] }, expected), "status-observed");
});

test("a wrong model ends only the explicit probe, even if it can call status", () => {
  const actual = { ...root, model: { providerID: "opencode", id: "space-bunny-free" } };
  assert.equal(statusProbeStopReason({ root: "root", models: [actual], tools: [status] }, expected), "model-mismatch");
  assert.equal(statusProbeStopReason({ root: "root", models: [root], tools: [{ ...status, model: actual.model }] }, expected), "model-mismatch",
    "the status tool's real model, not only the session's first turn, must match");
  assert.equal(statusProbeStopReason({ root: "root", models: [{ ...root, sessionID: "foreign" }], tools: [status] }, expected), null);
  assert.equal(statusProbeStopReason({ root: "root", models: [root], tools: [
    { ...status, status: "error" }, { ...status, agent: "dog-worker-v010" },
  ] }, expected), null);
});

test("CLI probes invoke native Windows npm and OpenCode binaries without a shell", () => {
  const entry = resolve("test/mission-cli-probe.test.ts");
  assert.deepEqual(nativeCLI("npm", ["install", "--force"], {
    platform: "win32", node: "node.exe", npmEntry: entry, openCodeEntry: entry,
  }), { executable: "node.exe", args: [entry, "install", "--force"] });
  assert.deepEqual(nativeCLI("opencode", ["run", "user prompt"], {
    platform: "win32", node: "node.exe", npmEntry: entry, openCodeEntry: entry,
  }), { executable: entry, args: ["run", "user prompt"] });
  assert.deepEqual(nativeCLI("npm", ["install"], { platform: "linux", npmEntry: entry }),
    { executable: "npm", args: ["install"] });
});

test("native CLI prompt stdin preserves quotes, CRLF, indentation and Unicode without a positional message", async () => {
  const prompt = "Original task\r\nKeep \"SQL\", 'quotes', \\n, $HOME and `code` literally.\n    日本語\n";
  const script = 'console.log(JSON.stringify({ args: process.argv.slice(1), text: (await import("node:fs")).readFileSync(0, "utf8") }))';
  const child = spawnPromptCLI(process.execPath, ["--input-type=module", "-e", script, "--", "flag value"], prompt, {});
  let stdout = "";
  child.stdout.on("data", bytes => { stdout += bytes; });
  const code = await new Promise((done, reject) => { child.once("error", reject); child.once("close", done); });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), { args: ["flag value"], text: prompt });
});

test("native CLI prompt stdin delivers a multi-buffer task without truncation or an extra newline", async () => {
  const prompt = '  "日本語"\\n\r\n'.repeat(20_000);
  const script = 'console.log((await import("node:crypto")).createHash("sha256").update((await import("node:fs")).readFileSync(0)).digest("hex"))';
  const child = spawnPromptCLI(process.execPath, ["--input-type=module", "-e", script], prompt, {});
  let stdout = "";
  child.stdout.on("data", bytes => { stdout += bytes; });
  const code = await new Promise((done, reject) => { child.once("error", reject); child.once("close", done); });
  assert.equal(code, 0);
  assert.equal(stdout.trim(), createHash("sha256").update(prompt).digest("hex"));
});

test("native CLI exit before reading prompt stdin retains the failed process outcome", async () => {
  const child = spawnPromptCLI(process.execPath, ["-e", "process.exit(23)"], "x".repeat(512_000), {});
  const code = await new Promise((done, reject) => { child.once("error", reject); child.once("close", done); });
  assert.equal(code, 23, "a closed stdin pipe neither crashes the observer nor accepts the CLI");
});

test("native V2 session directories use forward slashes even for Windows projects", () => {
  assert.deepEqual(observationDirectories("M:\\work\\fixture"), ["M:\\work\\fixture", "M:/work/fixture"]);
  assert.deepEqual(observationDirectories("/home/user/fixture"), ["/home/user/fixture", "/home/user/fixture"]);
});

test("practical database paths respect explicit, XDG and home settings with server-relative paths", () => {
  const project = resolve("_testenv", "owning-project"), home = resolve("_testenv", "private-home");
  assert.equal(missionDatabasePath({ OPENCODE_DB: "owned.db", XDG_DATA_HOME: "ignored" }, project), join(project, "owned.db"));
  assert.equal(missionDatabasePath({ OPENCODE_DB: join(home, "fixed.db") }, project), join(home, "fixed.db"));
  assert.equal(missionDatabasePath({ XDG_DATA_HOME: join(home, "data") }, project), join(home, "data/opencode/opencode.db"));
  assert.equal(missionDatabasePath({ HOME: home }, project), join(home, ".local/share/opencode/opencode.db"));
  assert.equal(missionDatabasePath({ USERPROFILE: home }, project), join(home, ".local/share/opencode/opencode.db"));
});

test("installed V2 fixture data settings replace the inherited host DB and remain stable across restart", () => {
  const run = resolve("_testenv", "owned-run"), host = resolve("_testenv", "host-data");
  const env = { OPENCODE_DB: join(host, "opencode.db"), XDG_DATA_HOME: host, ...fixtureDataEnvironment(run) };
  const selected = join(run, "data/opencode/opencode.db");
  assert.equal(env.OPENCODE_DB, selected);
  assert.equal(env.XDG_DATA_HOME, join(run, "data"));
  assert.equal(missionDatabasePath(env, join(run, "project")), selected);
  assert.equal(missionDatabasePath({ ...env }, join(run, "project")), selected);
  assert.notEqual(fixtureDataEnvironment(resolve("_testenv", "other-run")).OPENCODE_DB, selected);
});

function seedObservationDatabase(path: string, project: string, root: string, since: number, pending = false) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE session_v2(id TEXT, parent_id TEXT, agent TEXT, directory TEXT, time_created INTEGER,
    time_idle INTEGER, idle_outcome TEXT);
    CREATE TABLE session_message(id TEXT, session_id TEXT, type TEXT, seq INTEGER, data TEXT);
    CREATE TABLE session_pending(session_id TEXT); CREATE TABLE session_inbox(session_id TEXT);`);
  db.prepare("INSERT INTO session_v2 VALUES (?, NULL, 'dog-operator', ?, ?, ?, 'succeeded')")
    .run(root, project, since, since);
  if (pending) db.prepare("INSERT INTO session_pending VALUES (?)").run(root);
  return db;
}

test("practical database observation honors explicit OPENCODE_DB instead of a foreign host-path root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mission-observer-db-"));
  const home = join(directory, "home"), project = join(directory, "project");
  const host = join(home, ".local/share/opencode/opencode.db"), owned = join(directory, "owned.db");
  try {
    await mkdir(join(home, ".local/share/opencode"), { recursive: true });
    seedObservationDatabase(host, project, "foreign-root", 100).close();
    seedObservationDatabase(owned, project, "owned-root", 100).close();
    const code = `import { observeMissionCLI } from ${JSON.stringify(new URL("../scripts/mission-cli-probe.mjs", import.meta.url).href)};
      console.log(JSON.stringify(observeMissionCLI(${JSON.stringify(project)})));`;
    const observed = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home, OPENCODE_DB: owned },
    }));
    assert.equal(observed.root, "owned-root");
    assert.equal(observed.database_path, owned);
    assert.deepEqual(observed.models, [], "synthetic session metadata is not a model request");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("practical monitor freezes the owning server database for observation and native settlement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mission-monitor-db-"));
  const path = join(directory, "owned.db"), since = Date.now();
  const db = seedObservationDatabase(path, directory, "owned-root", since, true);
  const child = spawn(process.execPath, ["-e", "console.log('ROOT_TURN_CLOSED')"], {
    detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let stopped = false, settled = false;
  try {
    const monitor = monitorMissionCLI({ child, server: { env: { OPENCODE_DB: path }, stop: async () => { stopped = true; } },
      project: directory, since, rootAgent: "dog-operator", mode: "complete", rootModel: expected,
      capUSD: 2, timeoutSeconds: 30,
      observe: (project: string, after: number, agent: string, selected: string) => {
        assert.equal(selected, path, "never fall back to the controller host DB");
        return observeMissionCLI(project, after, agent, selected);
      },
      finish: async (result: unknown) => result,
    }).finally(() => { settled = true; });
    const pendingResult = monitor.then(value => ({ value }), error => ({ error }));
    await new Promise<void>(done => child.once("close", () => done()));
    await new Promise(done => setTimeout(done, 30));
    assert.equal(settled, false, "root CLI close must wait for this DB's native inbox/pending work");
    assert.equal(stopped, false, "do not tear down the owning server while its work is pending");
    db.exec("DELETE FROM session_pending");
    const result = await pendingResult;
    if ("error" in result) throw result.error;
    assert.equal(result.value.observed.root, "owned-root");
    assert.equal(result.value.databasePath, path);
    assert.equal(result.value.stopped, false);
    assert.equal(stopped, true);
  } finally {
    db.exec("DELETE FROM session_pending");
    await stopProcessGroup(child);
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the start-only Worker deadline does not invalidate a completed native receipt", () => {
  const worker = { started_ms: 75_895 };
  assert.equal(workerStartWithinProbeLimit("start", worker), false);
  assert.equal(workerStartWithinProbeLimit("start", worker, { repo: "example/repo" }), true);
  assert.equal(workerStartWithinProbeLimit("start", worker, undefined, 180_000), true,
    "a release startup probe has its own deadline, not the benchmark's 60-second target");
  assert.equal(workerStartWithinProbeLimit("start", { started_ms: -1 }, undefined, 180_000), false);
  assert.equal(workerStartWithinProbeLimit("complete", worker), true);
});

// Public outcome projection from the retained Cycle042 astroid1978 native CLI run.
// Keep its accepted=false and official FAIL; do not replay inference or embed task solutions.
const directCompletion = {
  mode: "complete", stopped: false, code: 0, mission_phase: "completed", receipt_status: "succeeded",
  models: [root, { sessionID: "coordinator", agent: "dogs-coordinator", model: root.model }],
  errors: [], accepted: false,
};
const worker = { sessionID: "worker", agent: "dog-worker-v010",
  model: { providerID: "openai", id: "gpt-6-luna-fast", variant: "max" } };

test("a completed direct Mission remains visible without inventing Worker coverage or changing acceptance", () => {
  const before = structuredClone(directCompletion);
  assert.deepEqual(completeProbeObservations(directCompletion), {
    native_completed: true, worker_model_observed: false,
  });
  assert.deepEqual(directCompletion, before, "retained observation and route acceptance remain unchanged");
});

test("actual Worker model coverage neither proves native completion nor hides a completed receipt", () => {
  assert.deepEqual(completeProbeObservations({ ...directCompletion, accepted: true, models: [root, worker] }), {
    native_completed: true, worker_model_observed: true,
  });
  for (const incomplete of [
    { mission_phase: "working" }, { receipt_status: null }, { receipt_status: "failed" },
    { code: 1 }, { code: null }, { stopped: "timeout" }, { stopped: "budget" }, { stopped: undefined },
  ]) {
    assert.deepEqual(completeProbeObservations({ ...directCompletion, models: [worker], ...incomplete }), {
      native_completed: false, worker_model_observed: true,
    });
  }
  assert.deepEqual(completeProbeObservations({ ...directCompletion, models: [worker] }, true), {
    native_completed: false, worker_model_observed: true,
  }, "a rejected schema is not successful native completion");
  assert.equal(completeProbeObservations({ ...directCompletion, errors: [{ tool: "shell" }] }).native_completed, true,
    "a recovered earlier tool error does not replace the terminal native receipt or add an acceptance gate");
});

test("Worker coverage requires the actual agent, provider, model and variant, not planned settings", () => {
  for (const model of [undefined, {}, { ...worker.model, providerID: "other" },
    { ...worker.model, id: "gpt-6.1-sol" }, { ...worker.model, variant: "high" },
    { ...worker.model, variant: undefined }]) {
    assert.equal(completeProbeObservations({ ...directCompletion, models: [{ ...worker, model }] }).worker_model_observed, false);
  }
  assert.equal(completeProbeObservations({ ...directCompletion,
    models: [{ ...worker, agent: "dogs-coordinator" }] }).worker_model_observed, false);
  assert.equal(completeProbeObservations({ ...directCompletion,
    expected_model: "openai/gpt-6-luna-fast#max" }).worker_model_observed, false);
});

test("completion observations leave startup, status and response-only probe output unchanged", () => {
  for (const mode of ["start", "status", "operator-response", "build-start"]) {
    assert.deepEqual(completeProbeObservations({ ...directCompletion, mode }), {});
  }
});

test("normal CLI close observes an already-started Worker before teardown, not just the next interval", () => {
  const observed = { models: [root, { agent: "dog-worker-v010", started_ms: 14_082,
    model: { providerID: "openai", id: "gpt-6-luna-fast", variant: "max" } }],
    responses: [], tools: [], errors: [], priced_usd: 0.0523404 };
  const options = { mode: "start", rootModel: expected, capUSD: 1, elapsedMs: 14_100, timeoutMs: 180_000 };
  assert.equal(probeStopReason(observed, options), "worker-started");
  assert.equal(cliCloseStopReason(0, false, observed, options), "worker-started");
  assert.equal(cliCloseStopReason(1, false, observed, options), null, "a failed CLI exit is not silently accepted");
  for (const prior of ["budget", "timeout", "model-mismatch"]) {
    assert.equal(cliCloseStopReason(0, prior, observed, options), null, "an earlier stop remains authoritative");
  }
  assert.equal(cliCloseStopReason(0, false, { ...observed, models: [root] }, options), null,
    "parent success alone is not native Worker startup");
  assert.equal(cliCloseStopReason(0, false, { ...observed, priced_usd: 1 }, options), "budget");
  assert.equal(cliCloseStopReason(0, false, observed, { ...options, mode: "complete" }), null,
    "startup does not qualify a completion-mode probe");
});

// Cycle053's original controller exit/signal is unknown. Exercise the smallest
// reproducible disconnect path, not another paid replay of its completed task.
for (const [signal, phase] of [["SIGTERM", "active"], ["SIGINT", "settlement"], ["SIGTERM", "persistence"]] as const) {
  test(`controller ${signal} during ${phase} stops owned writers and persists usage without acceptance`,
    { skip: process.platform === "win32", timeout: 20_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-controller-signal-"));
    const observed = { root: "root", models: [root], responses: [], tools: [], errors: [],
      priced_usd: 1.7674084, unpriced_requests: 0 };
    await writeFile(join(directory, "retained-observation.json"), JSON.stringify(observed));
    const child = spawn(process.execPath, [resolve("test/fixtures/mission-probe-controller.mjs"), directory, phase], {
      detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr.on("data", bytes => { stderr += bytes; });
    child.stdout.resume();
    const closed = new Promise<{ code: number | null; signal: string | null }>((done, reject) => {
      child.once("error", reject); child.once("close", (code, signal) => done({ code, signal }));
    });
    let owned: { serverPID: number; cliPID: number } | undefined;
    let persistenceSignalSent = false;
    child.on("message", message => {
      if ((message as { phase: string }).phase === "persistence") {
        persistenceSignalSent = true;
        child.kill("SIGINT");
      }
    });
    try {
      owned = await new Promise((done, reject) => {
        child.on("message", message => {
          const event = message as { phase: string; serverPID: number; cliPID: number };
          if (["monitoring", "settlement"].includes(event.phase)) done(event);
        });
        child.once("close", () => reject(Error(`Controller exited before monitoring: ${stderr}`)));
      });
      child.kill(signal);
      const exit = await closed;
      assert.equal(exit.signal, null, "the controller must finish cleanup/persistence, not die on the signal");
      assert.equal(exit.code, 1, stderr);
      const result = JSON.parse(await readFile(join(directory, "observation.json"), "utf8"));
      assert.equal(result.stopped, "controller-interrupted");
      assert.equal(result.stop_observation, "signal");
      assert.equal(result.controller_signal, signal);
      assert.equal(result.code, phase === "settlement" ? 0 : null,
        "the original CLI exit remains separate from the controller's interruption");
      assert.equal(result.native_completed, false, "a retained succeeded Mission receipt cannot accept an interrupted probe");
      assert.equal(result.accepted, false);
      assert.equal(result.priced_usd, observed.priced_usd);
      assert.equal(result.unpriced_requests, 0);
      assert.equal(result.worker_model_observed, false, "no invented Worker coverage");
      assert.equal(persistenceSignalSent, phase === "persistence");
      for (const pid of [owned.serverPID, owned.cliPID]) {
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "no detached owned writer remains");
      }
      assert.match(await readFile(join(directory, "cli.stdout.jsonl"), "utf8"), /CLI_CONNECTED/);
      assert.match(await readFile(join(directory, "cli.stderr.log"), "utf8"), /CLI_OWNED/);
      const listeners = JSON.parse(await readFile(join(directory, "listener-counts.json"), "utf8"));
      assert.deepEqual(listeners.after, listeners.before, "later probes do not inherit stale signal handlers");
    } finally {
      await stopProcessGroup(child);
      // Only exact PIDs created by this fixture; baseline failure leaves them detached.
      for (const pid of owned ? [owned.serverPID, owned.cliPID] : []) {
        try { process.kill(-pid, "SIGKILL"); } catch { /* already stopped */ }
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const point of ["interval", "first", "close", "final", "pending", "budget"] as const) {
  test(`observer read failure at ${point} persists logs, stop reason and incomplete-usage coverage`,
    { timeout: 20_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-observer-failure-"));
    const observed = { root: "root", models: [root], responses: [], tools: [], errors: [],
      priced_usd: 1.7674084, unpriced_requests: 0 };
    await writeFile(join(directory, "retained-observation.json"), JSON.stringify(observed));
    const child = spawn(process.execPath, [resolve("test/fixtures/mission-probe-controller.mjs"), directory,
      `observation-failure-${point}`], { detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stderr = "", owned: { serverPID: number; cliPID: number } | undefined;
    child.stderr.on("data", bytes => { stderr += bytes; }); child.stdout.resume();
    child.on("message", message => {
      const event = message as { serverPID?: number; cliPID?: number };
      if (event.serverPID && event.cliPID) owned = { serverPID: event.serverPID, cliPID: event.cliPID };
    });
    try {
      const exit = await new Promise<{ code: number | null; signal: string | null }>((done, reject) => {
        child.once("error", reject); child.once("close", (code, signal) => done({ code, signal }));
      });
      assert.equal(exit.signal, null); assert.equal(exit.code, 1, stderr);
      const result = JSON.parse(await readFile(join(directory, "observation.json"), "utf8"));
      assert.equal(result.stopped, point === "budget" ? "budget" : "observation-failed");
      assert.equal(result.stop_observation, { interval: "interval", first: "interval", close: "cli-close",
        final: "final", pending: "native-settlement", budget: "cli-close" }[point]);
      assert.equal(result.accepted, false); assert.equal(result.native_completed, false);
      assert.equal(result.usage_complete, point === "pending", "only a successful final DB read can release missing-coverage holds");
      assert.equal(result.priced_usd, ["first", "close"].includes(point) ? 0 : observed.priced_usd);
      assert.equal(result.unpriced_requests, point === "pending" ? 0 : 1);
      assert.equal(result.known_unpriced_requests, point === "pending" ? undefined : 0,
        "incomplete coverage is an accounting marker, not an invented model request");
      assert.match(result.observation_error.message, /injected-(database|native-settlement)-read-failure/);
      assert.match(result.next_action, /database/i); assert.match(result.next_action, /usage/i);
      assert.match(result.next_action, /do not.*replay/i);
      assert.match(await readFile(join(directory, "cli.stdout.jsonl"), "utf8"), /CLI_CONNECTED/);
      assert.match(await readFile(join(directory, "cli.stderr.log"), "utf8"), /CLI_OWNED/);
      const listeners = JSON.parse(await readFile(join(directory, "listener-counts.json"), "utf8"));
      assert.deepEqual(listeners.after, listeners.before);
      assert(owned);
      if (process.platform !== "win32") for (const pid of [owned.serverPID, owned.cliPID]) {
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "no owned writer remains");
      }
    } finally {
      await stopProcessGroup(child);
      if (process.platform !== "win32") for (const pid of owned ? [owned.serverPID, owned.cliPID] : []) {
        try { process.kill(-pid, "SIGKILL"); } catch { /* already stopped */ }
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const phase of ["launch-failure", "launch-failure-observation", "cli-process-error"] as const) {
  test(`${phase} persists its distinct process error after owned cleanup without replay`,
    { timeout: 20_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-cli-error-"));
    const observed = { models: [], responses: [], tools: [], errors: [], priced_usd: 0, unpriced_requests: 0 };
    await writeFile(join(directory, "retained-observation.json"), JSON.stringify(observed));
    const child = spawn(process.execPath, [resolve("test/fixtures/mission-probe-controller.mjs"), directory, phase],
      { detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stderr = "", owned: { serverPID: number; cliPID?: number } | undefined;
    child.stderr.on("data", bytes => { stderr += bytes; }); child.stdout.resume();
    child.on("message", message => {
      const event = message as { serverPID?: number; cliPID?: number };
      if (event.serverPID) owned = { serverPID: event.serverPID, cliPID: event.cliPID };
    });
    try {
      const exit = await new Promise<{ code: number | null; signal: string | null }>((done, reject) => {
        child.once("error", reject); child.once("close", (code, signal) => done({ code, signal }));
      });
      assert.equal(exit.signal, null); assert.equal(exit.code, 1, stderr);
      const result = JSON.parse(await readFile(join(directory, "observation.json"), "utf8"));
      const launched = phase === "cli-process-error", missingUsage = phase === "launch-failure-observation";
      assert.equal(result.stopped, launched ? "cli-error" : "cli-launch-failed");
      assert.equal(result.stop_observation, "cli-error");
      assert.equal(result.cli_error.code, launched ? "EIO" : "ENOENT");
      assert.match(result.cli_error.message, launched ? /injected-cli-process-error/ : /intentionally-absent-cli/);
      if (!launched) assert.notEqual(result.code, 0, "keep the failed OS spawn outcome, not a fabricated success");
      assert.equal(result.accepted, false); assert.equal(result.native_completed, false);
      assert.equal(result.cli_started, launched); assert.equal(result.server_stop_calls, 1);
      assert.equal(result.pending_calls, 0, "a failed process never waits for or replays a native turn");
      assert.equal(result.usage_complete, !missingUsage);
      assert.equal(result.priced_usd, 0);
      assert.equal(result.unpriced_requests, missingUsage ? 1 : 0);
      assert.equal(result.known_unpriced_requests, missingUsage ? 0 : undefined);
      assert.equal(Boolean(result.observation_error), missingUsage, "launch errors are not observer errors");
      assert.match(result.next_action, /executable/i); assert.match(result.next_action, /usage/i);
      assert.match(result.next_action, /do not.*replay/i);
      const stdoutLog = await readFile(join(directory, "cli.stdout.jsonl"), "utf8");
      const stderrLog = await readFile(join(directory, "cli.stderr.log"), "utf8");
      if (launched) { assert.match(stdoutLog, /CLI_CONNECTED/); assert.match(stderrLog, /CLI_OWNED/); }
      else { assert.equal(stdoutLog, ""); assert.equal(stderrLog, "", "do not invent output from an unstarted CLI"); }
      assert.deepEqual(result.models, [], "no invented model request or Worker coverage");
      const listeners = JSON.parse(await readFile(join(directory, "listener-counts.json"), "utf8"));
      assert.deepEqual(listeners.after, listeners.before);
      assert(owned);
      if (process.platform !== "win32") for (const pid of [owned.serverPID, ...(owned.cliPID ? [owned.cliPID] : [])]) {
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "no owned writer remains");
      }
    } finally {
      await stopProcessGroup(child);
      if (process.platform !== "win32") for (const pid of owned ? [owned.serverPID, ...(owned.cliPID ? [owned.cliPID] : [])] : []) {
        try { process.kill(-pid, "SIGKILL"); } catch { /* already stopped */ }
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const phase of ["cleanup-failure", "cleanup-failure-budget", "cleanup-failure-observation", "launch-failure-cleanup"] as const) {
  test(`${phase} persists uncertain cleanup and usage without hiding the original stop`,
    { timeout: 20_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-cleanup-error-"));
    const observed = { models: [], responses: [], tools: [], errors: [], priced_usd: 1.7674084, unpriced_requests: 0 };
    await writeFile(join(directory, "retained-observation.json"), JSON.stringify(observed));
    const child = spawn(process.execPath, [resolve("test/fixtures/mission-probe-controller.mjs"), directory, phase],
      { detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stderr = "", owned: { serverPID: number; cliPID?: number } | undefined;
    child.stderr.on("data", bytes => { stderr += bytes; }); child.stdout.resume();
    child.on("message", message => {
      const event = message as { serverPID?: number; cliPID?: number };
      if (event.serverPID) owned = { serverPID: event.serverPID, cliPID: event.cliPID };
    });
    try {
      const exit = await new Promise<{ code: number | null; signal: string | null }>((done, reject) => {
        child.once("error", reject); child.once("close", (code, signal) => done({ code, signal }));
      });
      assert.equal(exit.signal, null); assert.equal(exit.code, 1, stderr);
      const result = JSON.parse(await readFile(join(directory, "observation.json"), "utf8"));
      const prior = phase === "cleanup-failure-budget" ? "budget" : phase === "launch-failure-cleanup" ? "cli-launch-failed" : "cleanup-failed";
      assert.equal(result.stopped, prior);
      assert.equal(result.stop_observation, prior === "budget" ? "cli-close" : prior === "cli-launch-failed" ? "cli-error" : "cleanup");
      assert.equal(result.code === 0, phase !== "launch-failure-cleanup", "do not replace the original CLI close outcome");
      assert.equal(result.cleanup_complete, false, "a rejected teardown is not proof that native writers stopped");
      assert.equal(result.cleanup_errors.length, 1); assert.equal(result.cleanup_errors[0].target, "server");
      assert.equal(result.cleanup_errors[0].code, "EIO");
      assert.match(result.cleanup_errors[0].message, /injected-owned-server-stop-failure/);
      assert.equal(result.server_stop_calls, 1, "persist the failed teardown, do not automatically retry it");
      assert.equal(result.accepted, false); assert.equal(result.native_completed, false);
      assert.equal(result.usage_complete, false, "a successful final read cannot settle usage while teardown is uncertain");
      assert.equal(result.priced_usd, observed.priced_usd); assert.equal(result.unpriced_requests, 1);
      assert.equal(result.known_unpriced_requests, 0, "retain the existing incomplete-coverage marker, not an invented request");
      assert.equal(Boolean(result.observation_error), phase === "cleanup-failure-observation");
      assert.equal(Boolean(result.cli_error), phase === "launch-failure-cleanup");
      assert.match(result.next_action, /owned/i); assert.match(result.next_action, /stop|teardown/i);
      assert.match(result.next_action, /usage/i); assert.match(result.next_action, /do not.*replay/i);
      const stdoutLog = await readFile(join(directory, "cli.stdout.jsonl"), "utf8");
      const stderrLog = await readFile(join(directory, "cli.stderr.log"), "utf8");
      if (phase === "launch-failure-cleanup") { assert.equal(stdoutLog, ""); assert.equal(stderrLog, ""); }
      else { assert.match(stdoutLog, /CLI_CONNECTED/); assert.match(stderrLog, /CLI_OWNED/); }
      const listeners = JSON.parse(await readFile(join(directory, "listener-counts.json"), "utf8"));
      assert.deepEqual(listeners.after, listeners.before);
      assert(owned);
      if (process.platform !== "win32") for (const pid of [owned.serverPID, ...(owned.cliPID ? [owned.cliPID] : [])]) {
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "this fixture stops both surrogates before injecting rejection");
      }
    } finally {
      await stopProcessGroup(child);
      if (process.platform !== "win32") for (const pid of owned ? [owned.serverPID, ...(owned.cliPID ? [owned.cliPID] : [])] : []) {
        try { process.kill(-pid, "SIGKILL"); } catch { /* already stopped */ }
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const phase of ["closed", "closed-stubborn", "signalled", "active"] as const) {
  test(`owned process group cleanup stops its ${phase} parent's remaining writer before returning`,
    { skip: process.platform !== "linux", timeout: 20_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-owned-group-"));
    const child = spawn(process.execPath, [resolve("test/fixtures/owned-process-group.mjs"), directory, phase],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
    const closed = new Promise<{ code: number | null; signal: string | null }>((done, reject) => {
      child.once("error", reject); child.once("close", (code, signal) => done({ code, signal }));
    });
    try {
      const ready = await new Promise<{ writerPID: number; file: string }>((done, reject) => {
        child.stdout.on("data", () => { if (stdout.includes("\n")) done(JSON.parse(stdout)); });
        child.once("error", reject);
        child.once("close", () => { if (!stdout.includes("\n")) reject(Error(`Root closed before writer readiness: ${stderr}`)); });
      });
      const original = phase === "active" ? null : await closed;
      assert(ready.writerPID);
      await stopProcessGroup(child);
      const snapshot = await readFile(ready.file, "utf8");
      await new Promise(done => setTimeout(done, 100));
      assert.equal(await readFile(ready.file, "utf8"), snapshot, "no descendant writes after the cleanup barrier");
      const exit = await closed;
      assert.deepEqual(exit, original ?? { code: null, signal: "SIGTERM" }, "retain the actual root exit/signal");
      const absentOrZombie = await readFile(`/proc/${ready.writerPID}/stat`, "utf8").then(value => {
        const state = value.slice(value.lastIndexOf(")") + 2).split(" ")[0];
        return state === "Z" || state === "X";
      }, error => { if (error.code === "ENOENT") return true; throw error; });
      assert.equal(absentOrZombie, true, "a writer is stopped, not merely paused between writes");
      const started = Date.now();
      await stopProcessGroup(child);
      assert(Date.now() - started < 1_000, "already-stopped groups do not wait for a second close event or kill timeout");
    } finally {
      // Only the exact detached group created by this fixture; also clean baseline failures.
      try { process.kill(-child.pid!, "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      await closed;
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const fault of ["foreign-read", "owned-read", "signal-denied", "listing-unavailable"] as const) {
  test(`owned group inspection handles ${fault} without hiding an uncertain cleanup`,
    { skip: process.platform !== "linux", timeout: 20_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-group-inspection-"));
    try {
      const result = JSON.parse(execFileSync(process.execPath,
        [resolve("test/fixtures/owned-group-inspection.mjs"), directory, fault], { encoding: "utf8", timeout: 15_000 }));
      assert.deepEqual(result.root_exit, { code: 0, signal: null }, "retain the actual closed root outcome");
      assert.equal(result.new_model_requests, 0);
      if (fault === "foreign-read") {
        assert.equal(result.cleanup_error, null, "unrelated denied metadata must not abort the owned cleanup");
        assert.equal(result.denied_reads, 0, "read detailed metadata only for the selected owned group");
        assert.equal(result.writer_frozen, true, "no descendant writes after the cleanup barrier");
        assert.equal(result.writer_stopped, true);
        assert(result.signals.includes("SIGKILL"), "still escalate a stubborn owned writer after the existing grace");
      } else {
        const expected = fault === "owned-read" ? "EACCES" : fault === "signal-denied" ? "EPERM" : "ENOENT";
        assert.equal(result.cleanup_error?.code, expected, "genuine owned cleanup failures remain actionable errors");
        assert.equal(result.writer_stopped, false, "uncertain cleanup is not a successful barrier");
        if (fault === "owned-read") assert.equal(result.denied_reads, 1);
      }
      const cleanup = JSON.parse(await readFile(join(directory, "cleanup-receipt.json"), "utf8"));
      assert.equal(cleanup.owned_writer_stopped, true);
      assert.equal(cleanup.builtin_read_and_kill_restored, true);
      assert.equal(cleanup.shared_host_touched, false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

for (const phase of ["closed", "closed-stubborn", "signalled", "closed-cleanup-error"] as const) {
  test(`normal monitor finalization stops the ${phase} CLI group before persisting its outcome`,
    { skip: process.platform !== "linux", timeout: 20_000 }, async context => {
    const directory = await mkdtemp(join(tmpdir(), "mission-normal-close-"));
    const child = spawn(process.execPath, [resolve("test/fixtures/owned-process-group.mjs"), directory,
      phase === "closed-cleanup-error" ? "closed" : phase], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let serverStops = 0, pendingCalls = 0, cliStops = 0, snapshot = "", writerPID: number | undefined;
    const observed = { root: "process-only-root", models: [], tools: [], responses: [], errors: [],
      priced_usd: 0, unpriced_requests: 0 };
    const kill = process.kill;
    const injected = context.mock.method(process, "kill", (pid: number, signal: NodeJS.Signals | number) => {
      if (pid === -child.pid! && signal === "SIGTERM") {
        cliStops++;
        if (phase === "closed-cleanup-error") throw Object.assign(Error("injected-owned-cli-stop-failure"), { code: "EPERM" });
      }
      return kill(pid, signal);
    });
    try {
      const result = await monitorMissionCLI({ child, server: { stop: async () => { serverStops++; } },
        project: directory, databasePath: join(directory, "unused-process-only.db"), since: Date.now(),
        rootAgent: "dog-operator", mode: "complete", rootModel: expected, capUSD: 2, timeoutSeconds: 10,
        observe: () => observed, pending: async () => { pendingCalls++; return false; },
        finish: async value => {
          writerPID = JSON.parse(value.stdout).writerPID;
          snapshot = await readFile(join(directory, "owned-writer.log"), "utf8");
          await writeFile(join(directory, "stop-receipt.json"), JSON.stringify(value));
          return value;
        } });
      assert.equal(cliStops, 1, "one owned CLI teardown even on normal close or cleanup failure");
      assert.equal(serverStops, 1, "do not duplicate server teardown");
      assert.equal(pendingCalls, phase === "signalled" ? 0 : 1, "keep native-settlement eligibility before teardown");
      assert.equal(result.code, phase === "signalled" ? null : 0);
      assert.equal(result.signal, phase === "signalled" ? "SIGTERM" : null, "keep the real root exit/signal");
      assert.equal(result.stopped, phase === "closed-cleanup-error" ? "cleanup-failed" : false);
      assert(writerPID);
      await new Promise(done => setTimeout(done, 100));
      const later = await readFile(join(directory, "owned-writer.log"), "utf8");
      if (phase === "closed-cleanup-error") {
        assert.notEqual(later, snapshot, "a denied teardown must not be described as a successful writer barrier");
        assert.equal(result.cleanupErrors.length, 1); assert.equal(result.cleanupErrors[0].target, "cli");
        assert.equal(result.cleanupErrors[0].code, "EPERM"); assert.equal(result.stopObservation, "cleanup");
        assert.equal(result.observed.usage_complete, false); assert.equal(result.observed.unpriced_requests, 1);
        assert.equal(result.observed.known_unpriced_requests, 0, "retain coverage hold, not an invented model request");
        assert.match(result.nextAction, /owned.*CLI\/server/i); assert.match(result.nextAction, /do not.*replay/i);
      } else {
        assert.equal(later, snapshot, "no descendant writes after the persistence boundary");
        assert.deepEqual(result.cleanupErrors, []); assert.equal(result.observed.unpriced_requests, 0);
        const state = await readFile(`/proc/${writerPID}/stat`, "utf8").then(stat =>
          stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[0], error => {
          if (error.code === "ENOENT") return "absent"; throw error;
        });
        assert(["absent", "Z", "X"].includes(state), "writer is stopped, not merely between writes");
      }
      const persisted = JSON.parse(await readFile(join(directory, "stop-receipt.json"), "utf8"));
      assert.equal(persisted.stopped, result.stopped); assert.equal(persisted.code, result.code);
      assert.deepEqual(persisted.cleanupErrors, result.cleanupErrors); assert.deepEqual(result.observed.models, []);
    } finally {
      injected.mock.restore();
      // Exact detached group created here; baseline and genuine cleanup failures still need teardown.
      try { kill(-child.pid!, "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
}
