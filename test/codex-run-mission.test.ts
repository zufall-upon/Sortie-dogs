import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { runCodexMission, RunFlightLedger, ScopeLeaseRegistry } from "../dist/index.js";

async function scriptedMission(mode: "success" | "validation-fail" | "validation-mutates" | "interrupted") {
  const root = await mkdtemp(join(tmpdir(), `sortie-codex-${mode}-`));
  await promisify(execFile)("git", ["-C", root, "init", "--quiet"]);
  await writeFile(join(root, "verify.mjs"), "process.exit(0);\n");
  await writeFile(join(root, "operation-manifest.json"), JSON.stringify({ version: "0.1.0", task_id: "unit-codex",
    read: ["verify.mjs", "hello.txt"], write: ["hello.txt"], validation: ["node verify.mjs"] }));
  const server = join(root, "scripted-server.mjs");
  await writeFile(server, `import {createInterface} from 'node:readline'; import {writeFile} from 'node:fs/promises'; import {join} from 'node:path';
const mode=${JSON.stringify(mode)}; let turns=0; const out=x=>process.stdout.write(JSON.stringify(x)+'\\n');
for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);
if(m.method==='initialize'&&m.id)out({id:m.id,result:{}}); else if(m.method==='thread/start')out({id:m.id,result:{thread:{id:'thread'}}});
else if(m.method==='turn/start'){turns++;const id='turn-'+turns;out({id:m.id,result:{turn:{id}}});
if(turns===1){if(mode!=='interrupted')await writeFile(join(m.params.cwd,'hello.txt'),'ok\\n');out({method:'turn/completed',params:{threadId:'thread',turn:{id,status:mode==='interrupted'?'interrupted':'completed'}}});}
else {if(mode==='validation-mutates')await writeFile(join(m.params.cwd,'hello.txt'),'changed\\n');out({method:'item/completed',params:{threadId:'thread',turnId:id,item:{id:'cmd',type:'commandExecution',command:'node verify.mjs',status:mode==='validation-fail'?'failed':'completed',exitCode:mode==='validation-fail'?2:0}}});out({method:'turn/completed',params:{threadId:'thread',turn:{id,status:'completed'}}});}}}`);
  const executable = join(root, "scripted-codex");
  await writeFile(executable, `#!/bin/sh\nexec "${process.execPath}" "${server}"\n`); await chmod(executable, 0o755);
  return { root, executable };
}

test("runCodexMission reuses the goal ledger and persists native validation identity", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "sortie-codex-runner-"));
  await promisify(execFile)("git", ["-C", root, "init", "--quiet"]);
  await writeFile(join(root, "verify.mjs"), "import assert from 'node:assert/strict';\nimport {readFileSync} from 'node:fs';\nassert.equal(readFileSync('hello.txt','utf8'),'ok\\n');\n");
  await writeFile(join(root, "operation-manifest.json"), JSON.stringify({ version: "0.1.0", task_id: "unit-codex",
    read: ["verify.mjs", "hello.txt"], write: ["hello.txt"], validation: ["node verify.mjs"] }));
  const server = join(root, "fake-server.mjs");
  await writeFile(server, `import {createInterface} from 'node:readline'; import {writeFile} from 'node:fs/promises'; import {join} from 'node:path';
let thread='thread-1', turns=0; const out=x=>process.stdout.write(JSON.stringify(x)+'\\n');
for await (const line of createInterface({input:process.stdin})) { const m=JSON.parse(line);
 if(m.method==='initialize'&&m.id) out({id:m.id,result:{}});
 else if(m.method==='thread/start') out({id:m.id,result:{thread:{id:thread}}});
 else if(m.method==='turn/start'){ turns++; const id='turn-'+turns; out({id:m.id,result:{turn:{id}}});
  if(turns===1){await writeFile(join(m.params.cwd,'hello.txt'),'ok\\n');
   out({method:'item/completed',params:{threadId:thread,turnId:id,item:{id:'file-1',type:'fileChange',status:'completed'}}});}
  else out({method:'item/completed',params:{threadId:thread,turnId:id,item:{id:'cmd-1',type:'commandExecution',command:'node verify.mjs',status:'completed',exitCode:0}}});
  out({method:'turn/completed',params:{threadId:thread,turn:{id,status:'completed'}}}); }
}`);
  const executable = join(root, "fake-codex");
  await writeFile(executable, `#!/bin/sh\nexec "${process.execPath}" "${server}"\n`);
  await chmod(executable, 0o755);
  const result = await runCodexMission({ projectRoot: root, manifestPath: "operation-manifest.json", prompt: "Create hello.txt", executable });
  assert.equal(result.settlement.disposition, "succeeded");
  assert.equal(result.state.phase, "terminal");
  assert.equal(await readFile(join(root, "hello.txt"), "utf8"), "ok\n");
  const ledger = await RunFlightLedger.readGoalFile(result.ledgerPath);
  const settled = ledger.records.find(record => record.event.kind === "unit.settled")?.event;
  assert.equal(settled?.kind, "unit.settled");
  if (settled?.kind === "unit.settled") {
    assert.equal(settled.native_validation_observations?.[0]?.raw_command, "node verify.mjs");
    assert.deepEqual(settled.native_validation_observations?.[0]?.canonical_commands, ["node verify.mjs"]);
  }
});

test("runCodexMission rejects external manifest scope before starting Codex", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "sortie-codex-runner-scope-"));
  await promisify(execFile)("git", ["-C", root, "init", "--quiet"]);
  await writeFile(join(root, "operation-manifest.json"), JSON.stringify({ version: "0.1.0", task_id: "unit-codex",
    read: ["/tmp/external"], write: ["hello.txt"], validation: ["node verify.mjs"] }));
  await assert.rejects(runCodexMission({ projectRoot: root, manifestPath: "operation-manifest.json", prompt: "Create hello.txt",
    executable: "must-not-start" }), /codex-mission-external-scope-unsupported/u);
});

test("runCodexMission compensates an app-server startup failure and releases the repository lease", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "sortie-codex-runner-startup-"));
  await promisify(execFile)("git", ["-C", root, "init", "--quiet"]);
  await writeFile(join(root, "verify.mjs"), "process.exit(0);\n");
  await writeFile(join(root, "operation-manifest.json"), JSON.stringify({ version: "0.1.0", task_id: "unit-codex",
    read: ["verify.mjs"], write: ["hello.txt"], validation: ["node verify.mjs"] }));
  await assert.rejects(runCodexMission({ projectRoot: root, manifestPath: "operation-manifest.json", prompt: "Create hello.txt",
    executable: join(root, "missing-codex") }), /Unable to start Codex app-server|server/u);
  const flightRoot = join(root, ".git", "sortie-dogs", "run-flight");
  const files = await readdir(flightRoot);
  assert.equal(files.length, 1);
  const snapshot = await RunFlightLedger.readGoalFile(join(flightRoot, files[0]!));
  assert.equal(snapshot.state.phase, "stopped");
  assert.deepEqual(snapshot.state.outstanding_reservations, []);
  assert.equal(await new ScopeLeaseRegistry(join(root, ".git", "sortie-dogs", "scope-leases"))
    .hasConflictingLease({ read: [], write: ["**"] }), false);
});

test("runCodexMission fails closed when Codex writes outside manifest scope", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "sortie-codex-runner-outside-"));
  await promisify(execFile)("git", ["-C", root, "init", "--quiet"]);
  await writeFile(join(root, "verify.mjs"), "process.exit(0);\n");
  await writeFile(join(root, "operation-manifest.json"), JSON.stringify({ version: "0.1.0", task_id: "unit-codex",
    read: ["verify.mjs"], write: ["hello.txt"], validation: ["node verify.mjs"] }));
  const server = join(root, "outside-server.mjs");
  await writeFile(server, `import {createInterface} from 'node:readline'; import {writeFile} from 'node:fs/promises'; import {join} from 'node:path';
const out=x=>process.stdout.write(JSON.stringify(x)+'\\n'); for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);
if(m.method==='initialize'&&m.id)out({id:m.id,result:{}}); else if(m.method==='thread/start')out({id:m.id,result:{thread:{id:'t'}}});
else if(m.method==='turn/start'){out({id:m.id,result:{turn:{id:'u'}}}); await writeFile(join(m.params.cwd,'outside.txt'),'bad'); out({method:'turn/completed',params:{threadId:'t',turn:{id:'u',status:'completed'}}});}}`);
  const executable = join(root, "outside-codex");
  await writeFile(executable, `#!/bin/sh\nexec "${process.execPath}" "${server}"\n`); await chmod(executable, 0o755);
  await assert.rejects(runCodexMission({ projectRoot: root, manifestPath: "operation-manifest.json", prompt: "Create hello.txt", executable }),
    /codex-mission-write-scope-violation:outside\.txt/u);
  const files = await readdir(join(root, ".git", "sortie-dogs", "run-flight"));
  const snapshot = await RunFlightLedger.readGoalFile(join(root, ".git", "sortie-dogs", "run-flight", files[0]!));
  assert.equal(snapshot.state.phase, "stopped");
  assert.deepEqual(snapshot.state.outstanding_reservations, []);
});

test("runCodexMission retains failed validation identity and terminates without evidence", { skip: process.platform === "win32" }, async () => {
  const fixture = await scriptedMission("validation-fail");
  const result = await runCodexMission({ projectRoot: fixture.root, manifestPath: "operation-manifest.json",
    prompt: "Create hello.txt", executable: fixture.executable });
  assert.equal(result.settlement.disposition, "failed");
  assert.equal(result.state.phase, "stopped");
  assert.equal(result.settlement.evidence.length, 0);
  const ledger = await RunFlightLedger.readGoalFile(result.ledgerPath);
  const settled = ledger.records.find(record => record.event.kind === "unit.settled")?.event;
  assert.equal(settled?.kind, "unit.settled");
  if (settled?.kind === "unit.settled") {
    assert.equal(settled.native_validation_observations?.[0]?.raw_command, "node verify.mjs");
    assert.equal(settled.disposition, "failed");
  }
});

test("runCodexMission rejects validation that mutates protected output", { skip: process.platform === "win32" }, async () => {
  const fixture = await scriptedMission("validation-mutates");
  const result = await runCodexMission({ projectRoot: fixture.root, manifestPath: "operation-manifest.json",
    prompt: "Create hello.txt", executable: fixture.executable });
  assert.equal(result.settlement.disposition, "failed");
  assert.equal(result.state.phase, "stopped");
  assert.equal(result.settlement.evidence.length, 0);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0]!.status, "completed");
  assert.equal(result.observations[0]!.exitCode, 0);
  assert.equal(await readFile(join(fixture.root, "hello.txt"), "utf8"), "changed\n");
});

test("runCodexMission compensates an interrupted implementation turn", { skip: process.platform === "win32" }, async () => {
  const fixture = await scriptedMission("interrupted");
  await assert.rejects(runCodexMission({ projectRoot: fixture.root, manifestPath: "operation-manifest.json",
    prompt: "Create hello.txt", executable: fixture.executable }), /codex-mission-implementation-interrupted/u);
  const files = await readdir(join(fixture.root, ".git", "sortie-dogs", "run-flight"));
  const ledger = await RunFlightLedger.readGoalFile(join(fixture.root, ".git", "sortie-dogs", "run-flight", files[0]!));
  assert.equal(ledger.state.phase, "stopped");
  assert.deepEqual(ledger.state.outstanding_reservations, []);
  const settled = ledger.records.find(record => record.event.kind === "unit.settled")?.event;
  assert.equal(settled?.kind === "unit.settled" ? settled.disposition : undefined, "cancelled");
  assert.equal(settled?.kind === "unit.settled" ? settled.result_class : undefined, "interrupted");
});

test("runCodexMission refuses a conflicting OpenCode lease without opening a goal", { skip: process.platform === "win32" }, async () => {
  const fixture = await scriptedMission("success");
  const scopeRoot = join(fixture.root, ".git", "sortie-dogs", "scope-leases");
  const held = await new ScopeLeaseRegistry(scopeRoot).acquire({ ownerId: "opencode-worker", scope: { read: [], write: ["hello.txt"] } });
  try {
    await assert.rejects(runCodexMission({ projectRoot: fixture.root, manifestPath: "operation-manifest.json",
      prompt: "Create hello.txt", executable: fixture.executable }), (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "scope-conflict");
    await assert.rejects(readdir(join(fixture.root, ".git", "sortie-dogs", "run-flight")), /ENOENT/u);
  } finally { await held.release(); }
});

test("runCodexMission can append a new terminal goal for the same explicit root identity", { skip: process.platform === "win32" }, async () => {
  const fixture = await scriptedMission("success");
  const rootSessionID = "codex-repeat-root";
  const first = await runCodexMission({ projectRoot: fixture.root, manifestPath: "operation-manifest.json",
    prompt: "Create hello.txt", executable: fixture.executable, rootSessionID });
  const second = await runCodexMission({ projectRoot: fixture.root, manifestPath: "operation-manifest.json",
    prompt: "Create hello.txt", executable: fixture.executable, rootSessionID });
  assert.equal(first.ledgerPath, second.ledgerPath);
  assert.equal(second.state.phase, "terminal");
  const ledger = await RunFlightLedger.readGoalFile(second.ledgerPath);
  assert.equal(ledger.records.filter(record => record.event.kind === "goal.terminal").length, 2);
});


test("Codex CLI SIGTERM compensates startup but preserves dispatched work as unknown", { skip: process.platform === "win32", timeout: 30_000 }, async () => {
  for (const phase of ["startup", "implementation", "validation"]) {
    const fixture = await scriptedMission("success");
    const ready = join(fixture.root, ".git", "ready");
    await writeFile(join(fixture.root, "scripted-server.mjs"), `import {createInterface} from 'node:readline'; import {writeFile} from 'node:fs/promises';
const out=x=>process.stdout.write(JSON.stringify(x)+'\\n');let turns=0;
for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);
if(m.method==='initialize'){if(${JSON.stringify(phase)}==='startup')await writeFile(${JSON.stringify(ready)},String(process.pid));else out({id:m.id,result:{}});}
else if(m.method==='thread/start')out({id:m.id,result:{thread:{id:'thread'}}});
else if(m.method==='turn/start'){turns++;const id='turn-'+turns;out({id:m.id,result:{turn:{id}}});
if(${JSON.stringify(phase)}==='validation'&&turns===1)out({method:'turn/completed',params:{threadId:'thread',turn:{id,status:'completed'}}});
else await writeFile(${JSON.stringify(ready)},String(process.pid));}
else if(m.method==='turn/interrupt'){out({id:m.id,result:{}});out({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn-'+turns,status:'interrupted'}}});}}
`);
    const child = spawn(process.execPath, [join(process.cwd(), "dist/cli/main.js"), "codex", "run", "--project-root", fixture.root,
      "--manifest", "operation-manifest.json", "--executable", fixture.executable, "--prompt", "Wait"], { stdio: "ignore" });
    const closed = new Promise<number | null>(resolve => child.once("exit", resolve));
    try {
      const deadline = Date.now() + 5000;
      while (!(await readFile(ready, "utf8").catch(() => ""))) {
        assert.ok(Date.now() < deadline, `server never reached ${phase}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      child.kill("SIGTERM");
      assert.equal(await closed, 143, phase);
      const directory = join(fixture.root, ".git", "sortie-dogs", "run-flight");
      const files = await readdir(directory);
      const { records, state } = await RunFlightLedger.readGoalFile(join(directory, files[0]!));
      assert.equal(state.phase, phase === "startup" ? "stopped" : "active", phase);
      assert.equal(state.outstanding_reservations.length, phase === "startup" ? 0 : 1);
      assert.equal(records.filter(r => r.event.kind === "dispatch.reserved").length, 1);
      const settled = records.find(r => r.event.kind === "unit.settled")?.event;
      if (phase === "startup") assert.equal(settled?.kind === "unit.settled" && settled.disposition, "cancelled");
      else assert.equal(settled, undefined);
      const leases = JSON.parse(await readFile(join(fixture.root, ".git/sortie-dogs/scope-leases/scope-leases.json"), "utf8"));
      assert.equal(leases.leases.length, phase === "startup" ? 0 : 1);
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  }
});

test("Codex mission refuses unresolved prior goal across fresh identities and runtime profiles", { skip: process.platform === "win32" }, async () => {
  const fixture = await scriptedMission("success");
  const result = await runCodexMission({ projectRoot: fixture.root, manifestPath: "operation-manifest.json",
    prompt: "Wait", executable: fixture.executable });
  const raw = JSON.parse(await readFile(result.ledgerPath, "utf8"));
  raw.goal_events = raw.goal_events.slice(0, 2);
  await writeFile(result.ledgerPath, JSON.stringify(raw));
  const { V010_RUNTIME_PROFILE } = await import("../dist/core/runtime-profile.js");
  for (const profile of [undefined, V010_RUNTIME_PROFILE]) {
    await assert.rejects(runCodexMission({ projectRoot: fixture.root, manifestPath: "operation-manifest.json",
      prompt: "Must not resend", executable: "must-not-spawn", profile }), /codex-mission-outcome-unknown:no-resend/u);
  }
  const { state } = await RunFlightLedger.readGoalFile(result.ledgerPath);
  assert.equal(state.phase, "active");
  assert.equal(state.outstanding_reservations.length, 1);
  assert.equal((await readdir(join(fixture.root, ".git/sortie-dogs/run-flight"))).length, 1);
  assert.equal(await new ScopeLeaseRegistry(join(fixture.root, ".git/sortie-dogs/scope-leases"))
    .hasConflictingLease({ read: [], write: ["**"] }), false);
});


test("Codex mission preserves unknown outcome when transport dies during a dispatched turn", { skip: process.platform === "win32" }, async () => {
  const fixture = await scriptedMission("success");
  const path = join(fixture.root, "scripted-server.mjs");
  const server = await readFile(path, "utf8");
  await writeFile(path, server.replace("else if(m.method==='turn/start'){", "else if(m.method==='turn/start'){process.exit(3);"));
  await assert.rejects(runCodexMission({ projectRoot: fixture.root, manifestPath: "operation-manifest.json",
    prompt: "Wait", executable: fixture.executable }), /codex-mission-outcome-unknown:no-resend/u);
  const directory = join(fixture.root, ".git/sortie-dogs/run-flight");
  const { state } = await RunFlightLedger.readGoalFile(join(directory, (await readdir(directory))[0]!));
  assert.equal(state.phase, "active"); assert.equal(state.outstanding_reservations.length, 1);
  const leases = JSON.parse(await readFile(join(fixture.root, ".git/sortie-dogs/scope-leases/scope-leases.json"), "utf8"));
  assert.equal(leases.leases.length, 1);
});

test("Codex cleanup failure cannot terminalize completed validation or implementation failure", { skip: process.platform === "win32" }, async t => {
  const { CodexAppServerHost } = await import("../dist/codex/app-server.js");
  const original = CodexAppServerHost.prototype.close;
  t.mock.method(CodexAppServerHost.prototype, "close", async function (this: InstanceType<typeof CodexAppServerHost>) {
    await original.call(this);
    throw new Error("unconfirmed-cleanup");
  });
  for (const scopeFailure of [false, true]) {
    const fixture = await scriptedMission("success");
    if (scopeFailure) {
      const path = join(fixture.root, "operation-manifest.json");
      const manifest = JSON.parse(await readFile(path, "utf8"));
      manifest.write = [];
      await writeFile(path, JSON.stringify(manifest));
    }
    await assert.rejects(runCodexMission({ projectRoot: fixture.root, manifestPath: "operation-manifest.json",
      prompt: "Wait", executable: fixture.executable }), /codex-mission-outcome-unknown:no-resend/u);
    const directory = join(fixture.root, ".git/sortie-dogs/run-flight");
    const { state } = await RunFlightLedger.readGoalFile(join(directory, (await readdir(directory))[0]!));
    assert.equal(state.phase, "active"); assert.equal(state.outstanding_reservations.length, 1);
    const leases = JSON.parse(await readFile(join(fixture.root, ".git/sortie-dogs/scope-leases/scope-leases.json"), "utf8"));
    assert.equal(leases.leases.length, 1);
  }
});

test("cancellation arriving during error cleanup cannot compensate dispatched work", { skip: process.platform === "win32" }, async t => {
  const fixture = await scriptedMission("success");
  const path = join(fixture.root, "operation-manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8")); manifest.write = [];
  await writeFile(path, JSON.stringify(manifest));
  const controller = new AbortController();
  const { CodexAppServerHost } = await import("../dist/codex/app-server.js");
  const original = CodexAppServerHost.prototype.close;
  t.mock.method(CodexAppServerHost.prototype, "close", async function (this: InstanceType<typeof CodexAppServerHost>) {
    await original.call(this);
    controller.abort();
  });
  await assert.rejects(runCodexMission({ projectRoot: fixture.root, manifestPath: "operation-manifest.json",
    prompt: "Wait", executable: fixture.executable, signal: controller.signal }), /codex-mission-outcome-unknown:no-resend/u);
  const directory = join(fixture.root, ".git/sortie-dogs/run-flight");
  const { state } = await RunFlightLedger.readGoalFile(join(directory, (await readdir(directory))[0]!));
  assert.equal(state.phase, "active"); assert.equal(state.outstanding_reservations.length, 1);
});
