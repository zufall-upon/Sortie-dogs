import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execute, expectedOperationEvent, ownedWslSpec, stopWslGroup } from "./run-local-case-study.mjs";

// Run in WSL through bash -ic. No model call, credentials, or benchmark attempt.
assert.equal(process.platform, "linux");
const root = resolve(import.meta.dirname, "../../../_testenv", `frontier-stop-rpt-${Date.now()}`);
await mkdir(root);
const groupFile = join(root, "process-group.pid");
const manifest = { opencode: { wsl_executable: "wsl.exe" } };
const spec = ownedWslSpec(manifest, root, process.execPath, ["-e",
  `console.log(JSON.stringify({type:'error'}));setInterval(()=>{},60000)`], {}, groupFile);
let result;
try {
  result = await execute(spec.executable, spec.args, { cwd: spec.cwd, eventGate: expectedOperationEvent,
    stopTree: () => stopWslGroup(manifest, groupFile), timeoutMs: 10000 });
  assert.equal(result.operationFailure, "agent-event-error");
  assert.equal(result.timedOut, false);
} finally { await stopWslGroup(manifest, groupFile); }
const summary = { status: "pass", processGroupStopped: true, reason: result.operationFailure };
await writeFile(join(root, "summary.json"), `${JSON.stringify(summary)}\n`);
console.log(JSON.stringify(summary));
