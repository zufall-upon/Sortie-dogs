import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { runCodexMission, RunFlightLedger, ScopeLeaseRegistry } from "../dist/index.js";

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
