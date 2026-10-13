import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

for (const [order, created] of [
  ["parent-first", [210, 220]],
  ["parent-later", [220, 210]],
  ["equal-time child-first", [210, 210]],
  ["deep reverse ancestry", [240, 230, 220, 210]],
] as const) {
  test(`practical observation covers ${order} descendants once within the selected root, directory and since`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-observer-hierarchy-"));
    const path = join(directory, "owned.db"), project = "M:\\work\\owned-fixture", normalized = project.replaceAll("\\", "/");
    const db = seedObservationDatabase(path, project, "selected-root", 200);
    try {
      const session = db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, 300, 'succeeded')");
      const chain = ["selected-root", ...created.map((_, i) => `child-${i}`)];
      // Insert children first as well, so equal timestamps cannot supply a parent-first guarantee.
      for (let i = created.length - 1; i >= 0; i--) {
        session.run(chain[i + 1], chain[i], i ? "dog-worker-v010" : "dogs-coordinator", normalized, created[i]);
      }
      for (const [id, parent, agent, scope, at] of [
        ["older-root", null, "dog-operator", project, 150],
        ["older-child", "older-root", "dog-worker-v010", normalized, 250],
        ["other-agent-root", null, "build", normalized, 260],
        ["other-agent-child", "other-agent-root", "dog-worker-v010", project, 270],
        ["foreign-root", null, "dog-operator", "M:/work/foreign-fixture", 280],
        ["foreign-child", "selected-root", "dog-worker-v010", "M:/work/foreign-fixture", 290],
        ["before-since", "selected-root", "dogs-coordinator", project, 99],
        ["through-before-since", "before-since", "dog-worker-v010", project, 230],
        ["through-foreign-directory", "foreign-child", "dog-worker-v010", project, 230],
        ["cycle-a", "cycle-b", "dog-worker-v010", project, 230],
        ["cycle-b", "cycle-a", "dog-worker-v010", project, 230],
        ["orphan", "missing-parent", "dog-worker-v010", project, 230],
      ] as const) session.run(id, parent, agent, scope, at);
      const message = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)");
      for (const { id } of db.prepare("SELECT id FROM session_v2").all() as { id: string }[]) {
        // The same message ID in different sessions must not drop either session's usage.
        message.run("same-id-across-sessions", id, "assistant", 1, JSON.stringify({
          model: root.model, tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 290, completed: 295 }, finish: "stop",
          content: [{ type: "text", text: `fixture response ${id}` },
            { type: "tool", name: "shell", time: { created: 291 }, state: { status: "completed" } }],
        }));
        message.run("user-message", id, "user", 0, JSON.stringify({ content: [
          { type: "tool", name: "ignored-user-tool", state: { status: "error", error: "not an assistant" } },
        ] }));
      }
      const leaf = chain.at(-1)!;
      message.run("unpriced-error", leaf, "assistant", 2, JSON.stringify({
        model: { providerID: "unpriced-fixture", id: "fixture-only-model" }, time: { created: 296, completed: 299 },
        content: [{ type: "tool", name: "shell", time: { created: 297 },
          state: { status: "error", error: "owned-descendant-failure" } }],
      }));
      const observed = observeMissionCLI(project, 100, "dog-operator", path);
      assert.equal(observed.root, "selected-root", "latest matching scoped root, not another root or agent");
      assert.equal(observed.database_path, path);
      assert.deepEqual(observed.models.map((item: { sessionID: string }) => item.sessionID).sort(), [...chain].sort());
      assert(observed.models.every((item: { started_ms: number }) => item.started_ms === 90));
      assert.deepEqual(observed.responses.map((item: { sessionID: string }) => item.sessionID).sort(), [...chain].sort());
      assert(observed.responses.every((item: { finished_ms: number }) => item.finished_ms === 95));
      assert.equal(observed.tools.length, chain.length + 1, "multiple ancestry passes do not repeat message/tool reads");
      assert.equal(observed.tools.filter((item: { status: string }) => item.status === "error").length, 1);
      assert.deepEqual(observed.errors, [{ sessionID: leaf, tool: "shell", error: '"owned-descendant-failure"' }]);
      assert(Math.abs(observed.priced_usd - chain.length * 0.003) < 1e-12, "each selected request priced exactly once");
      assert.equal(observed.unpriced_requests, 1, "missing descendant usage remains unknown, not zero or duplicated");
      assert.equal(probeStopReason(observed, { mode: "complete", capUSD: chain.length * 0.003 - 0.0001,
        elapsedMs: 0, timeoutMs: 1000 }), "budget", "descendant coverage feeds the existing budget stop");
      assert.deepEqual(observeMissionCLI(project, 100, "absent-agent", path), {
        database_path: path, root: undefined, models: [], tools: [], responses: [], errors: [], priced_usd: 0, unpriced_requests: 0,
      }, "no matching root does not collect foreign ancestry or cycles");
    } finally {
      db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("explicit observation root keeps cumulative usage when a newer same-project root exists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mission-observer-root-"));
  const path = join(directory, "owned.db"), db = seedObservationDatabase(path, directory, "retained-root", 100);
  try {
    const session = db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, 500, 'succeeded')");
    session.run("retained-coordinator", "retained-root", "dogs-coordinator", directory, 110);
    session.run("retained-worker", "retained-coordinator", "dog-worker-v010", directory, 105);
    session.run("later-root", null, "dog-operator", directory, 200);
    session.run("wrong-agent", null, "build", directory, 300);
    session.run("wrong-directory", null, "dog-operator", join(directory, "foreign"), 300);
    const message = db.prepare("INSERT INTO session_message VALUES (?, ?, 'assistant', ?, ?)");
    for (const [id, input, output] of [
      ["retained-root", 100000, 60000], ["retained-coordinator", 100000, 60000],
      ["retained-worker", 100000, 60000], ["later-root", 1000, 100],
    ] as const) message.run(`${id}-priced`, id, 1, JSON.stringify({ model: root.model,
      tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 250, completed: 290 }, finish: "stop", content: [{ type: "text", text: "fixture response" }],
    }));
    message.run("unknown-error", "retained-worker", 2, JSON.stringify({
      model: { providerID: "unpriced-fixture", id: "fixture-only-model" }, time: { completed: 290 },
      content: [{ type: "tool", name: "shell", state: { status: "error", error: "retained-root-error" } }],
    }));
    const pinned = observeMissionCLI(directory, 0, "dog-operator", path, { root: "retained-root" });
    assert.equal(pinned.root, "retained-root");
    assert.deepEqual(pinned.models.map((item: { sessionID: string }) => item.sessionID),
      ["retained-root", "retained-worker", "retained-coordinator"]);
    assert(pinned.models.every((item: { started_ms: number }) => item.started_ms === 150));
    assert.equal(pinned.responses.length, 3);
    assert.equal(pinned.unpriced_requests, 1);
    assert.deepEqual(pinned.errors, [{ sessionID: "retained-worker", tool: "shell", error: '"retained-root-error"' }]);
    assert(Math.abs(pinned.priced_usd - 2.4) < 1e-12);
    const options = { mode: "complete", capUSD: 2, elapsedMs: 1, timeoutMs: 1000 };
    assert.equal(probeStopReason(pinned, options), "budget", "resume does not grant a new root's cheaper allowance");
    const ordinary = observeMissionCLI(directory, 0, "dog-operator", path);
    assert.equal(ordinary.root, "later-root", "ordinary callers retain newest matching root selection");
    assert.deepEqual(ordinary.models.map((item: { sessionID: string }) => item.sessionID), ["later-root"]);
    assert.equal(ordinary.priced_usd, 0.003);
    assert.equal(ordinary.unpriced_requests, 0);
    assert.equal(probeStopReason(ordinary, options), null);
    for (const id of ["missing", "wrong-agent", "wrong-directory", "retained-worker", ""]) {
      assert.throws(() => observeMissionCLI(directory, 0, "dog-operator", path, { root: id }),
        /Observation root .* not found in selected agent\/directory\/since scope/, "never fall back to another root");
    }
    assert.throws(() => observeMissionCLI(directory, 101, "dog-operator", path, { root: "retained-root" }),
      /Observation root/, "an explicit root does not bypass the since filter");
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
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
      root: "owned-root",
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

for (const phase of ["budget", "settlement", "missing", "no-root-first", "stable"]) {
  test(`practical monitor retains its first observed root through ${phase}`, { timeout: 10_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-monitor-root-"));
    const path = join(directory, "owned.db"), since = Date.now();
    const db = seedObservationDatabase(path, directory, "owned-root", since, phase === "settlement");
    db.prepare("UPDATE session_v2 SET time_idle = ?").run(since + 500);
    const session = db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, 'succeeded')");
    session.run("owned-coordinator", "owned-root", "dogs-coordinator", directory, since + 10, since + 500);
    const message = db.prepare("INSERT INTO session_message VALUES (?, ?, 'assistant', ?, ?)");
    const priced = (input: number, output: number) => JSON.stringify({ model: root.model,
      tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: since + 150, completed: since + 190 }, content: [],
    });
    message.run("owned-priced", "owned-root", 1, priced(100000, 60000));
    message.run("owned-unpriced", "owned-coordinator", 1, JSON.stringify({
      model: { providerID: "unpriced-fixture", id: "fixture-only-model" }, time: { completed: since + 190 },
      content: [{ type: "tool", name: "shell", state: { status: "error", error: "owned-root-error" } }],
    }));
    if (phase === "no-root-first") db.exec("DELETE FROM session_v2 WHERE id = 'owned-root'");
    const child = spawn(process.execPath, ["-e", "process.stdin.on('data', bytes => process.stdout.write(bytes))"], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const reads: { root?: string, pinned?: string }[] = [];
    let serverStops = 0, finishCalls = 0, released = false, releaseTimer;
    const listenerCounts = ["SIGINT", "SIGTERM"].map(signal => process.listenerCount(signal));
    try {
      if (phase === "no-root-first") {
        // No native identity yet: wait without adopting an unrelated database root.
        releaseTimer = setTimeout(() => {
          session.run("owned-root", null, "dog-operator", directory, since, since + 500);
          child.stdin.write(JSON.stringify({ type: "step_start", sessionID: "owned-root" }) + "\n");
        }, 300);
      }
      const result = await monitorMissionCLI({ child, server: { stop: async () => {
        serverStops++;
        if (phase === "settlement") assert(released, "a later idle root cannot settle original queued work");
      } }, project: directory, databasePath: path, since, rootAgent: "dog-operator", mode: "complete",
        ...(phase === "no-root-first" ? {} : { root: "owned-root" }),
        rootModel: expected, capUSD: 2, timeoutSeconds: 5,
        observe: (project: string, after: number, agent: string, selected: string, options: { root?: string }) => {
          assert.equal(after, since); assert.equal(selected, path); assert.equal(agent, "dog-operator");
          reads.push({ pinned: options.root });
          const observed = observeMissionCLI(project, after, agent, selected, options);
          reads.at(-1)!.root = observed.root;
          const firstOwned = 1;
          if (reads.length === firstOwned && phase !== "stable") {
            session.run("later-root", null, "dog-operator", directory, since + 100, since + 500);
            message.run("later-priced", "later-root", 1, priced(1000, 100));
            if (phase === "budget") for (let seq = 2; seq <= 3; seq++)
              message.run(`owned-${seq}`, "owned-root", seq, priced(100000, 60000));
            if (phase === "missing") db.exec("DELETE FROM session_v2 WHERE id = 'owned-root'");
          }
          if (reads.length === firstOwned + 1 && ["settlement", "no-root-first", "stable"].includes(phase)) {
            child.stdin.end();
            if (phase === "settlement") releaseTimer = setTimeout(() => {
              db.exec("DELETE FROM session_pending"); released = true;
            }, 50);
          }
          return observed;
        },
        finish: async context => { finishCalls++; return context; },
      });
      assert.equal(result.observed.root, "owned-root");
      assert.deepEqual(result.observed.models.map((item: { sessionID: string }) => item.sessionID), ["owned-root", "owned-coordinator"]);
      assert.deepEqual(result.observed.errors, [{ sessionID: "owned-coordinator", tool: "shell", error: '"owned-root-error"' }]);
      assert.equal(result.observed.unpriced_requests, 1);
      assert(Math.abs(result.observed.priced_usd - (phase === "budget" ? 2.4 : 0.8)) < 1e-12);
      assert.equal(result.stopped, phase === "budget" ? "budget" : phase === "missing" ? "observation-failed" : false);
      assert.equal(serverStops, 1); assert.equal(finishCalls, 1);
      assert(reads.length >= 2);
      assert(reads.every(read => read.pinned === "owned-root"));
      if (phase === "missing") {
        assert.equal(result.observed.usage_complete, false);
        assert.equal(result.observed.known_unpriced_requests, 1);
        assert.match(result.observationError.message, /Observation root owned-root not found/);
        assert.match(result.nextAction, /Do not automatically replay/);
      }
      if (["settlement", "no-root-first", "stable"].includes(phase)) assert.equal(result.code, 0);
      assert.deepEqual(["SIGINT", "SIGTERM"].map(signal => process.listenerCount(signal)), listenerCounts);
    } finally {
      clearTimeout(releaseTimer);
      db.exec("DELETE FROM session_pending");
      child.stdin.end();
      await stopProcessGroup(child);
      db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const phase of ["fragmented", "no-newline", "missing-identity", "missing-identity-failed", "wrong-scope"]) {
  test(`monitor identifies only its owned CLI root through ${phase}`, { timeout: 10_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-cli-identity-"));
    const path = join(directory, "owned.db"), since = Date.now();
    const db = seedObservationDatabase(path, directory, "concurrent-root", since);
    const session = db.prepare("INSERT INTO session_v2 VALUES (?, NULL, 'dog-operator', ?, ?, ?, 'succeeded')");
    session.run("cli-owned-root", phase === "wrong-scope" ? join(directory, "foreign") : directory, since + 1, since + 2);
    const priced = (input: number, output: number) => JSON.stringify({ model: root.model,
      tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } }, content: [], time: { created: since, completed: since + 2 } });
    const message = db.prepare("INSERT INTO session_message VALUES (?, ?, 'assistant', 1, ?)");
    message.run("foreign-expensive", "concurrent-root", priced(300000, 180000));
    message.run("owned-priced", "cli-owned-root", priced(100000, 60000));
    const child = spawn(process.execPath, ["-e", `console.log('OWNED_READY');process.stdin.on('data',bytes=>process.stdout.write(bytes));process.stdin.on('end',()=>process.exit(${phase === "missing-identity-failed" ? 7 : 0}))`],
      { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let serverStops = 0, finishCalls = 0, observedCalls = 0, injected, continued;
    const listeners = ["SIGINT", "SIGTERM"].map(signal => process.listenerCount(signal));
    child.stdout.once("data", () => {
      injected = setTimeout(() => {
        // Diagnostic/part-only IDs are not the native top-level CLI identity.
        child.stdin.write('not json\n{"sessionID":"concurrent-root"}\n{"type":"text","part":{"sessionID":"concurrent-root"}}\n');
        const event = JSON.stringify({ type: "step_start", sessionID: "cli-owned-root", part: { sessionID: "concurrent-root" } });
        if (phase === "fragmented") {
          child.stdin.write(event.slice(0, 28));
          continued = setTimeout(() => child.stdin.end(event.slice(28) + "\n"), 50);
        } else child.stdin.end(phase.startsWith("missing-identity") ? "" : event + (phase === "no-newline" ? "" : "\n"));
      }, 300);
    });
    try {
      const result = await monitorMissionCLI({ child, server: { stop: async () => { serverStops++; } },
        project: directory, databasePath: path, since, rootAgent: "dog-operator", mode: "complete",
        rootModel: expected, capUSD: 2, timeoutSeconds: 5,
        observe: (...args) => { observedCalls++; assert.equal(args[4].root, "cli-owned-root"); return observeMissionCLI(...args); },
        finish: async context => { finishCalls++; return context; },
      });
      assert.equal(result.code, phase === "missing-identity-failed" ? 7 : 0); assert.equal(serverStops, 1); assert.equal(finishCalls, 1);
      if (phase.startsWith("missing-identity") || phase === "wrong-scope") {
        assert.equal(result.stopped, phase === "missing-identity-failed" ? "cli-exit-failed" : "observation-failed");
        assert.equal(result.observed.priced_usd, 0, "foreign usage cannot release or charge this run's allowance");
        assert.equal(result.observed.usage_complete, false); assert.equal(result.observed.unpriced_requests, 1);
        assert.equal(result.observed.known_unpriced_requests, 0, "hold marker is not a new model request");
        assert.match(result.nextAction, /Do not automatically replay/);
        assert.match(result.observationError.message, phase === "wrong-scope" ? /selected agent\/directory\/since scope/ : /did not report its session identity/);
        assert.equal(observedCalls, phase.startsWith("missing-identity") ? 0 : 2);
      } else {
        assert.equal(result.stopped, false); assert.equal(result.observed.root, "cli-owned-root");
        assert.equal(result.observed.priced_usd, 0.8); assert.equal(result.observed.unpriced_requests, 0);
        assert(observedCalls >= 2);
        assert.equal(result.observationError, undefined);
      }
      assert.match(result.stdout, /OWNED_READY/);
      assert.deepEqual(["SIGINT", "SIGTERM"].map(signal => process.listenerCount(signal)), listeners);
    } finally {
      clearTimeout(injected); clearTimeout(continued); child.stdin.end();
      await stopProcessGroup(child); db.close(); await rm(directory, { recursive: true, force: true });
    }
  });
}

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

for (const phase of ["persistence-first", "persistence-first-after-write", "persistence-first-budget",
  "persistence-first-cleanup", "persistence-first-observation", "persistence-first-launch", "persistence-normal"] as const) {
  test(`first controller signal during ${phase} reconciles the durable receipt without repeating owned teardown`,
    { skip: process.platform === "win32", timeout: 20_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-first-persistence-"));
    const observed = { root: "root", models: [root], responses: [], tools: [], errors: [],
      priced_usd: 1.7674084, unpriced_requests: 0 };
    await writeFile(join(directory, "retained-observation.json"), JSON.stringify(observed));
    const child = spawn(process.execPath, [resolve("test/fixtures/mission-probe-controller.mjs"), directory, phase], {
      detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stderr = "", persistenceCalls = 0;
    let owned: { serverPID: number; cliPID?: number } | undefined;
    let returned: { stopped: string | false } | undefined;
    const firstSignal = phase === "persistence-first-after-write" ? "SIGINT" : "SIGTERM";
    child.stdout.resume(); child.stderr.on("data", bytes => { stderr += bytes; });
    child.on("message", message => {
      const event = message as { phase: string; serverPID?: number; cliPID?: number; stopped: string | false };
      if (event.serverPID) owned = { serverPID: event.serverPID, cliPID: event.cliPID };
      if (event.phase === "persistence") {
        persistenceCalls++;
        child.kill(persistenceCalls === 1 ? firstSignal : firstSignal === "SIGTERM" ? "SIGINT" : "SIGTERM");
      }
      if (event.phase === "finished") returned = event;
    });
    try {
      const exit = await new Promise<{ code: number | null; signal: string | null }>((done, reject) => {
        child.once("error", reject); child.once("close", (code, signal) => done({ code, signal }));
      });
      assert.equal(exit.signal, null, "keep handlers until reconciliation finishes"); assert.equal(exit.code, 1, stderr);
      const result = JSON.parse(await readFile(join(directory, "observation.json"), "utf8"));
      const prior = phase === "persistence-first-budget" ? "budget" : phase === "persistence-first-cleanup" ? "cleanup-failed"
        : phase === "persistence-first-observation" ? "observation-failed" : phase === "persistence-first-launch" ? "cli-launch-failed"
        : phase === "persistence-normal" ? false : "controller-interrupted";
      assert.equal(result.stopped, prior); assert.equal(returned?.stopped, prior, "saved and returned outcomes agree");
      assert.equal(result.controller_signal, phase === "persistence-normal" ? null : firstSignal);
      assert.equal(result.stop_observation, phase === "persistence-first-budget" ? "cli-close"
        : phase === "persistence-first-cleanup" ? "cleanup" : phase === "persistence-first-observation" ? "cli-close"
        : phase === "persistence-first-launch" ? "cli-error" : phase === "persistence-normal" ? undefined : "signal");
      assert.equal(result.finish_calls, phase === "persistence-normal" ? 1 : 2,
        "repersist only changed stop metadata; a second signal must not cause more writes");
      assert.equal(persistenceCalls, phase === "persistence-normal" ? 0 : 2);
      assert.equal(result.server_stop_calls, 1, "reconciliation never retries owned teardown");
      assert.equal(result.native_completed, phase === "persistence-normal"); assert.equal(result.accepted, false);
      assert.equal(result.worker_model_observed, false);
      if (phase === "persistence-first-launch") assert.notEqual(result.code, 0);
      else assert.equal(result.code, 0, "the actual root outcome survives the later controller interruption");
      const missing = ["persistence-first-cleanup", "persistence-first-observation"].includes(phase);
      assert.equal(result.unpriced_requests, missing ? 1 : 0);
      if (missing) { assert.equal(result.usage_complete, false); assert.equal(result.known_unpriced_requests, 0); }
      assert.equal(result.priced_usd, phase === "persistence-first-observation" ? 0 : observed.priced_usd);
      assert.equal(Boolean(result.cleanup_errors), phase === "persistence-first-cleanup");
      assert.equal(Boolean(result.observation_error), phase === "persistence-first-observation");
      assert.equal(Boolean(result.cli_error), phase === "persistence-first-launch");
      if (["persistence-first", "persistence-first-after-write"].includes(phase)) {
        assert.match(result.next_action, /saved.*receipt|receipt.*saved/i);
        assert.match(result.next_action, /do not.*replay/i);
      }
      const stdout = await readFile(join(directory, "cli.stdout.jsonl"), "utf8");
      const logs = await readFile(join(directory, "cli.stderr.log"), "utf8");
      if (phase === "persistence-first-launch") { assert.equal(stdout, ""); assert.equal(logs, ""); }
      else { assert.match(stdout, /CLI_CONNECTED/); assert.match(logs, /CLI_OWNED/); }
      assert(owned);
      for (const pid of [owned.serverPID, ...(owned.cliPID ? [owned.cliPID] : [])])
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      const listeners = JSON.parse(await readFile(join(directory, "listener-counts.json"), "utf8"));
      assert.deepEqual(listeners.after, listeners.before);
    } finally {
      await stopProcessGroup(child);
      for (const pid of owned ? [owned.serverPID, ...(owned.cliPID ? [owned.cliPID] : [])] : []) {
        try { process.kill(-pid, "SIGKILL"); } catch { /* exact fixture group already stopped */ }
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const phase of ["signal", "nonzero", "prior-observation", "later-cleanup"] as const) {
  test(`abnormal CLI ${phase} close records failure and next action without relabeling the real exit`,
    { skip: process.platform === "win32", timeout: 20_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-abnormal-close-"));
    const child = spawn(process.execPath, phase === "nonzero"
      ? ["-e", "console.log('CLI_FAILED');console.error('owned exit failure');process.exit(7)"]
      : [resolve("test/fixtures/owned-process-group.mjs"), directory, "signalled"], {
      detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let serverStops = 0, finishCalls = 0, pendingCalls = 0;
    const listeners = ["SIGINT", "SIGTERM"].map(signal => process.listenerCount(signal));
    try {
      const result = await monitorMissionCLI({ child,
        root: "owned-abnormal-root",
        server: { stop: async () => {
          serverStops++;
          if (phase === "later-cleanup") throw Object.assign(Error("injected-owned-stop-failure"), { code: "EIO" });
        } }, project: directory, databasePath: join(directory, "unused-owned.db"), since: Date.now(),
        rootAgent: "dog-operator", mode: "complete", rootModel: expected, capUSD: 2, timeoutSeconds: 10,
        observe: () => {
          if (phase === "prior-observation") throw Object.assign(Error("injected-owned-db-read-failure"), { code: "EACCES" });
          return { models: [], tools: [], responses: [], errors: [], priced_usd: 0, unpriced_requests: 0 };
        },
        pending: () => { pendingCalls++; return false; },
        finish: async context => {
          finishCalls++;
          await writeFile(join(directory, "cli.stdout.jsonl"), context.stdout);
          await writeFile(join(directory, "cli.stderr.log"), context.stderr);
          return context;
        },
      });
      assert.equal(result.stopped, phase === "prior-observation" ? "observation-failed" : "cli-exit-failed");
      assert.equal(result.stopObservation, "cli-close");
      assert.equal(result.code, phase === "nonzero" ? 7 : null);
      assert.equal(result.signal, phase === "nonzero" ? null : "SIGTERM");
      assert.equal(result.controllerSignal, undefined, "external CLI termination is not a controller interruption");
      assert.match(result.nextAction, /Do not automatically replay/);
      assert.match(result.nextAction, /owned|recorded/i);
      assert.equal(result.cliError, undefined, "real failed close is distinct from an executable/process error event");
      assert.equal(serverStops, 1); assert.equal(finishCalls, 1); assert.equal(pendingCalls, 0);
      assert.deepEqual(["SIGINT", "SIGTERM"].map(signal => process.listenerCount(signal)), listeners);
      assert.equal(result.observed.priced_usd, 0); assert.deepEqual(result.observed.models, []);
      if (phase === "prior-observation" || phase === "later-cleanup") {
        assert.equal(result.observed.usage_complete, false); assert.equal(result.observed.unpriced_requests, 1);
        assert.equal(result.observed.known_unpriced_requests, 0, "retain coverage hold without inventing model requests");
      }
      if (phase === "prior-observation") assert.equal(result.observationError.code, "EACCES");
      if (phase === "later-cleanup") assert.equal(result.cleanupErrors[0].code, "EIO");
      const stdout = await readFile(join(directory, "cli.stdout.jsonl"), "utf8");
      if (phase === "nonzero") {
        assert.match(stdout, /CLI_FAILED/); assert.match(await readFile(join(directory, "cli.stderr.log"), "utf8"), /owned exit failure/);
      } else {
        const { writerPID, file } = JSON.parse(stdout), before = await readFile(file);
        await new Promise(done => setTimeout(done, 100)); assert(before.equals(await readFile(file)));
        const state = await readFile(`/proc/${writerPID}/stat`, "utf8").then(stat =>
          stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[0], error => {
            if (error.code === "ENOENT") return "absent"; throw error;
          });
        assert(["absent", "Z", "X"].includes(state));
      }
    } finally { await stopProcessGroup(child); await rm(directory, { recursive: true, force: true }); }
  });
}

for (const phase of ["persistence-reject", "persistence-reject-signal", "persistence-reject-budget",
  "persistence-reject-cleanup", "persistence-reject-observation", "persistence-reject-launch",
  "persistence-reject-late-signal", "persistence-reject-no-handler", "persistence-reject-fallback"] as const) {
  test(`${phase} retains a structured persistence failure without retrying settlement or clearing its lock`,
    { timeout: 20_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-persistence-rejection-"));
    const observed = { root: "root", models: [root], responses: [], tools: [], errors: [],
      priced_usd: 1.7674084, unpriced_requests: 0 };
    await writeFile(join(directory, "retained-observation.json"), JSON.stringify(observed));
    const budget = { probes: [{ root: "root", state: "reserved", reserved_usd: 2, charged_usd: 2 }] };
    const budgetBytes = JSON.stringify(budget);
    await writeFile(join(directory, "owned-settlement.json"), budgetBytes);
    const child = spawn(process.execPath, [resolve("test/fixtures/mission-probe-controller.mjs"), directory, phase], {
      detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stderr = "", signalsSent = 0;
    let owned: { serverPID: number; cliPID?: number } | undefined;
    child.stdout.resume(); child.stderr.on("data", bytes => { stderr += bytes; });
    child.on("message", message => {
      const event = message as { phase: string; serverPID?: number; cliPID?: number };
      if (event.serverPID) owned = { serverPID: event.serverPID, cliPID: event.cliPID };
      if (process.platform !== "win32" && ["persistence", "failure-persistence"].includes(event.phase)) {
        signalsSent++;
        child.kill(signalsSent === 1 ? "SIGTERM" : "SIGINT");
      }
    });
    try {
      const exit = await new Promise<{ code: number | null; signal: string | null }>((done, reject) => {
        child.once("error", reject); child.once("close", (code, signal) => done({ code, signal }));
      });
      assert.equal(exit.signal, null); assert.equal(exit.code, 1, stderr);
      const unsaved = ["persistence-reject-no-handler", "persistence-reject-fallback"].includes(phase);
      const rejection = unsaved ? JSON.parse(await readFile(join(directory, "terminal-rejection.json"), "utf8")) : undefined;
      if (!unsaved) await assert.rejects(readFile(join(directory, "terminal-rejection.json")), { code: "ENOENT" });
      const result = unsaved ? rejection.monitorContext : JSON.parse(await readFile(join(directory, "observation.json"), "utf8"));
      const prior = phase === "persistence-reject-budget" ? "budget" : phase === "persistence-reject-cleanup" ? "cleanup-failed"
        : phase === "persistence-reject-observation" ? "observation-failed" : phase === "persistence-reject-launch" ? "cli-launch-failed"
        : phase === "persistence-reject-signal" && process.platform !== "win32" ? "controller-interrupted" : "persistence-failed";
      assert.equal(result.stopped, prior);
      const error = unsaved ? result.persistenceError : result.persistence_error;
      assert.equal(error.code, "EEXIST"); assert.match(error.message, /owned-settlement.json.lock/);
      const coverage = unsaved ? result.observed : result;
      assert.equal(coverage.usage_complete, false); assert.equal(coverage.unpriced_requests, 1);
      assert.equal(coverage.known_unpriced_requests, 0, "missing persistence is a hold marker, not a new model request");
      assert.equal(coverage.priced_usd, phase === "persistence-reject-observation" ? 0 : observed.priced_usd);
      assert.equal(result.code === 0, phase !== "persistence-reject-launch", "retain actual root outcome");
      assert.equal(result.persistence_complete, false);
      assert.match(unsaved ? result.nextAction : result.next_action, /lock/i);
      assert.match(unsaved ? result.nextAction : result.next_action, /do not.*replay/i);
      if (unsaved) {
        assert.equal(rejection.code, "EEXIST"); assert.equal(rejection.cause_code, "EEXIST");
        assert.equal(result.failure_recorded, false);
        assert.equal(rejection.finish_calls, 1); assert.equal(rejection.server_stop_calls, 1);
        assert.equal(rejection.failure_saves, phase === "persistence-reject-fallback" ? 1 : 0);
        if (phase === "persistence-reject-fallback") assert.equal(result.failurePersistenceError.code, "EACCES");
      } else {
        assert.equal(result.accepted, false); assert.equal(result.native_completed, false); assert.equal(result.failure_recorded, true);
        assert.equal(result.finish_calls, 1, "never retry the known failed full settlement callback");
        assert.equal(result.failure_saves, phase === "persistence-reject-late-signal" && process.platform !== "win32" ? 2 : 1);
        assert.equal(result.server_stop_calls, 1); assert.equal(result.worker_model_observed, false);
        assert.equal(result.controller_signal, ["persistence-reject-signal", "persistence-reject-late-signal"].includes(phase) && process.platform !== "win32" ? "SIGTERM" : null);
      }
      assert.equal(await readFile(join(directory, "owned-settlement.json"), "utf8"), budgetBytes, "do not release or recharge held usage");
      assert.deepEqual(await readdir(join(directory, "owned-settlement.json.lock")), [], "existing owner retained");
      const listeners = JSON.parse(await readFile(join(directory, "listener-counts.json"), "utf8"));
      assert.deepEqual(listeners.after, listeners.before);
      assert(owned);
      if (process.platform !== "win32") for (const pid of [owned.serverPID, ...(owned.cliPID ? [owned.cliPID] : [])])
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally {
      await stopProcessGroup(child);
      if (process.platform !== "win32") for (const pid of owned ? [owned.serverPID, ...(owned.cliPID ? [owned.cliPID] : [])] : []) {
        try { process.kill(-pid, "SIGKILL"); } catch { /* exact fixture group already stopped */ }
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
  test(`monitor finalization stops the ${phase} CLI group before persisting its outcome`,
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
        root: observed.root,
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
      assert.equal(result.stopped, phase === "closed-cleanup-error" ? "cleanup-failed" : phase === "signalled" ? "cli-exit-failed" : false);
      if (phase === "signalled") {
        assert.equal(result.stopObservation, "cli-close"); assert.match(result.nextAction, /recorded CLI exit code\/signal/);
      }
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
