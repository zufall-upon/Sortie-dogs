import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { probe } from "./mission-cli-probe.mjs";

// Real V2 dispatch and compaction control with an intentionally minimal native summary.
// The observer does not repair state, inject a replacement task or execute the Worker validation.
const result = await probe(resolve(process.argv[2]), resolve(process.argv[3]), {
  mode: "complete", timeoutSeconds: 360, capUSD: 1,
  prompt: "Delegate to dogs-coordinator using the exact returned Task: replace result.txt with recovered and a trailing newline, then validate node check.mjs. Use Coordinator even for this one-unit compaction diagnostic. Do not change check.mjs or settings. Complete the low-risk mission.",
  setupFixture: async ({ control, run }) => {
    const wrapper = join(control, "plugins/sortie-dogs/index.js");
    const source = (await readFile(wrapper, "utf8")).replace("export default", "const sortiePlugin =");
    await writeFile(wrapper, source + `
import { appendFileSync, readFileSync } from "node:fs";
const log = value => appendFileSync(${JSON.stringify(join(run, "context-observation.jsonl"))}, JSON.stringify(value)+"\\n");
export default { id: "sortie-dogs.v010", async setup(ctx) {
  const cleanup = await sortiePlugin.setup(ctx);
  const compacted = new Set();
  await ctx.tool.transform(editor => editor.update("subagent", tool => {
    const execute = tool.execute;
    tool.execute = (input, execution) => execute(input, { ...execution, progress: async value => {
      await execution.progress(value);
      log({ kind: "progress", session: execution.sessionID, value });
    } });
  }));
  await ctx.tool.hook("execute.after", async event => {
    if (event.agent !== "dog-worker-v010" || event.status !== "completed" || compacted.has(event.sessionID)) return;
    if (readFileSync(${JSON.stringify(join(run, "project/result.txt"))}, "utf8") !== "recovered\\n") return;
    compacted.add(event.sessionID);
    await ctx.session.compact({ sessionID: event.sessionID });
    log({ kind: "compact-requested", session: event.sessionID });
  });
  await ctx.session.hook("compaction", event => {
    if (!compacted.has(event.sessionID)) return;
    log({ kind: "compaction", session: event.sessionID, system: event.system });
    event.result = { summary: "The conversation was compacted. Continue the assigned task." };
  });
  await ctx.session.hook("context", event => {
    if (event.agent === "dog-worker-v010") log({ kind: "worker-context", session: event.sessionID,
      after_compaction: compacted.has(event.sessionID), system: event.system });
  });
  return cleanup;
}};
`);
  },
});
const run = dirname(result.project);
const events = (await readFile(join(run, "context-observation.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
const db = new DatabaseSync(join(homedir(), ".local/share/opencode/opencode.db"), { readOnly: true });
let tasks, compactions;
try {
  tasks = db.prepare("select data from session_message where session_id=? and type='assistant' order by seq").all(result.root)
    .flatMap(row => JSON.parse(row.data).content ?? []).filter(part => part.name === "subagent");
  compactions = result.models.filter(row => row.agent === "dog-worker-v010").flatMap(worker =>
    db.prepare("select type,data from session_message where session_id=? and type='compaction'").all(worker.sessionID));
} finally { db.close(); }
const observation = { ...result, compactions: compactions.map(row => JSON.parse(row.data)),
  native_task_metadata: tasks.map(part => part.state?.metadata),
  progress_updates: events.filter(event => event.kind === "progress").length };
await writeFile(join(run, "context-probe.json"), JSON.stringify(observation, null, 2) + "\n");
console.log(JSON.stringify(observation, null, 2));
assert.equal(result.code, 0);
assert.equal(result.stopped, false);
assert.equal(result.receipt_status, "succeeded");
assert.equal(result.errors.length, 0);
assert.equal(compactions.length, 1);
assert.ok(events.some(event => event.kind === "compaction" && JSON.stringify(event.system).includes("SORTIE_WORKER_CONTEXT")));
assert.ok(events.some(event => event.kind === "worker-context" && event.after_compaction &&
  JSON.stringify(event.system).includes("SORTIE_WORKER_CONTEXT")));
assert.ok(events.some(event => event.kind === "progress" && event.value.sortie_progress?.status === "running"));
assert.ok(tasks.some(part => part.state?.metadata?.sortie_progress));
assert.ok(result.models.some(row => row.agent === "dog-worker-v010" && row.model.id === "gpt-6-luna-fast" && row.model.variant === "max"));
