import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runProcess } from "../../../scripts/release-process.mjs";

assert.equal(process.platform, "linux");
const area = resolve(process.argv[2]);
const root = join(area, "project"), control = join(root, ".opencode");
const before = JSON.parse(await readFile(join(area, "before.json"), "utf8"));
const after = JSON.parse(await readFile(join(area, "after.json"), "utf8"));
assert.deepEqual(before.dispositions, ["succeeded", "failed", "failed"]);
assert.deepEqual(after.dispositions, ["succeeded", "succeeded", "succeeded"]);
assert.equal(before.goal_id, after.goal_id);
assert.equal(before.session_id, after.session_id);
const sessionID = after.session_id;
const env = { ...process.env, HOME: join(area, "home"), XDG_CONFIG_HOME: join(area, "xdg"),
  XDG_DATA_HOME: "/home/rozen/.local/share", OPENCODE_CONFIG_DIR: control, PWD: root };
const cli = "/home/rozen/.opencode/bin/opencode";
const server = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
  cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
server.stdout.on("data", data => { if (stdout.length < 8192) stdout += data; });
server.stderr.resume();
const exited = new Promise(resolve => server.once("exit", resolve));
const stop = () => { try { process.kill(-server.pid, "SIGTERM"); } catch {} };
process.once("exit", stop);
try {
  let url;
  for (let i = 0; i < 150; i++) {
    url = stdout.match(/http:\/\/127\.0\.0\.1:\d+/u)?.[0];
    if (url) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert(url);
  const prompt = "Resume the SAME accepted goal. All three after-update implementation Tasks already completed and their exact canonical validations passed. The test harness interrupted final review; finish the required review and durable terminal return report now. Do not dispatch additional implementation Tasks or repeat unchanged validation. Use current protected evidence, not an invented PASS. No commit required.\ngoal_budget_units: 16";
  const execution = await runProcess(cli, ["run", "--attach", url, "--dir", root, "--format", "json", "--print-logs",
    "--agent", "dog-coordinator", "--model", "openai/gpt-5.6-terra", "--variant", "high", "--session", sessionID, prompt],
  { cwd: root, env, timeoutMs: 600_000 });
  assert.equal(execution.timedOut, false);
  assert.equal(execution.code, 0);
  const ledgerPath = join(root, ".git/sortie-dogs/run-flight", `${createHash("sha256").update(sessionID).digest("hex")}.json`);
  const records = JSON.parse(await readFile(ledgerPath, "utf8")).goal_events;
  const { reduceGoalFlight } = await import(pathToFileURL(join(control, "node_modules/sortie-dogs/dist/core/goal-bound.js")).href);
  const state = reduceGoalFlight(records);
  assert.equal(state.goal_id, after.goal_id);
  assert.equal(state.receipt?.status, "succeeded");
  assert.equal(state.no_progress_results, 0);
  const messages = await fetch(`${url}/session/${sessionID}/message?directory=${encodeURIComponent(root)}`).then(r => r.json());
  const final = messages.findLast(message => message.info.role === "assistant");
  const text = final.parts.filter(part => part.type === "text").map(part => part.text).join("\n");
  assert.match(text, /🐾 SORTIE DOGS — 帰還報告/u);
  assert.match(text, /DONE/u);
  const summary = { status: "pass", area, same_session: true, same_goal: true,
    package_version: JSON.parse(await readFile(join(control, "node_modules/sortie-dogs/package.json"), "utf8")).version,
    runtime_marker: (await readFile(join(control, "sortie-dogs.version"), "utf8")).trim(),
    before, after: { ...after, terminal: state.receipt.status, report: true },
    resumed_after_harness_review_interruption: true };
  await writeFile(join(area, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} finally {
  stop();
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
  if (server.exitCode === null) { try { process.kill(-server.pid, "SIGKILL"); } catch {} }
  process.removeListener("exit", stop);
}
