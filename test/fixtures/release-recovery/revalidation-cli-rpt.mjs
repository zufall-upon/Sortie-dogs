import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { runProcess } from "../../../scripts/release-process.mjs";

assert.equal(process.platform, "linux", "use WSL bash -ic");
const [beforeArg, afterArg, outputArg] = process.argv.slice(2);
const beforeTgz = resolve(beforeArg), afterTgz = resolve(afterArg);
const area = join(resolve(outputArg), `revalidation-cli-${Date.now()}`);
const root = join(area, "project"), control = join(root, ".opencode");
const cli = "/home/rozen/.opencode/bin/opencode";
const hash = value => createHash("sha256").update(value).digest("hex");
const env = { ...process.env, HOME: join(area, "home"), XDG_CONFIG_HOME: join(area, "xdg"),
  XDG_DATA_HOME: "/home/rozen/.local/share", OPENCODE_CONFIG_DIR: control, PWD: root,
  GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
await mkdir(control, { recursive: true });
await mkdir(join(root, ".sortie-dogs/contracts"), { recursive: true });
await mkdir(env.HOME, { recursive: true });
await mkdir(env.XDG_CONFIG_HOME, { recursive: true });
async function run(exe, args, cwd = root, timeoutMs = 120_000) {
  const result = await runProcess(exe, args, { cwd, env, timeoutMs });
  assert.equal(result.code, 0, `${exe} exit ${result.code}`);
  assert.equal(result.timedOut, false, `${exe} timeout`);
  return result.stdout;
}
await writeFile(join(root, "AGENTS.md"), "# Revalidation fixture\nOnly result.txt changes. Use each exact supplied handoff and operation manifest. Canonical command is node validate.mjs in its own tool call. Follow normal review rules; only text fixture data changes.\n");
await writeFile(join(root, ".gitignore"), ".opencode/\n.sortie-dogs/\n");
await writeFile(join(root, "result.txt"), "seed\n");
await writeFile(join(root, "validate.mjs"), "import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';assert.match((await readFile('result.txt','utf8')).trim(),/^(alpha|beta|gamma)$/);console.log('REVALIDATION_PASS');\n");
await run("git", ["init", "-q", "-b", "main"]);
await run("git", ["add", "--", "AGENTS.md", ".gitignore", "result.txt", "validate.mjs"]);
await run("git", ["commit", "-qm", "Initialize revalidation fixture"]);
const installed = join(control, "node_modules/sortie-dogs");
async function install(tgz) {
  const bytes = await readFile(tgz);
  const dependency = `file:${relative(control, tgz)}`;
  await writeFile(join(control, "package.json"), JSON.stringify({ private: true, type: "module",
    dependencies: { "sortie-dogs": dependency } }));
  await run("npm", ["install", "--force"], control, 300_000);
  assert.equal((await lstat(installed)).isSymbolicLink(), false);
  assert.equal(JSON.parse(await readFile(join(control, "package.json"), "utf8")).dependencies["sortie-dogs"], dependency);
  const lock = JSON.parse(await readFile(join(control, "package-lock.json"), "utf8"));
  assert.equal(lock.packages["node_modules/sortie-dogs"].integrity,
    `sha512-${createHash("sha512").update(bytes).digest("base64")}`);
  await run("node", [join(installed, "dist/cli/main.js"), "init", root]);
  await writeFile(join(control, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json",
    plugin: [pathToFileURL(join(installed, "dist/plugin/opencode.js")).href], model: "openai/gpt-5.6-terra" }));
  return { version: JSON.parse(await readFile(join(installed, "package.json"), "utf8")).version,
    marker: (await readFile(join(control, "sortie-dogs.version"), "utf8")).trim(), sha256: hash(bytes) };
}
const beforePackage = await install(beforeTgz);
const { acceptanceContinuityFingerprint } = await import(pathToFileURL(join(installed, "dist/core/acceptance-continuity.js")).href);
const criterion = "result.txt contains one allowed label and node validate.mjs passes";
await writeFile(join(root, ".sortie-dogs/contracts/goal.json"), JSON.stringify({
  delivery_intent: "implementation", delivery_mode: "repair-first", usable_path_established: true,
  controlled_change: false, goal_budget_units: 16,
  defaults: { entrypoint: "validate.mjs", workload: "allowed-label data refinement",
    oracle_coverage: ["allowed-label content"], build_boundary: "not-applicable", source: "fixture source",
    candidate: "fixture candidate", source_binding: "current-protected", candidate_binding: "current-protected",
    fixture: "revalidation", proof_scope: "requested-full", expected_outcome: "pass", validation_command: "node validate.mjs" },
  criteria: [{ target: criterion }],
}));
const declarations = {};
for (const phase of ["before", "after"]) {
  declarations[phase] = [];
  for (const [index, value] of ["alpha", "beta", "gamma"].entries()) {
    const id = `${phase}-${index + 1}`;
    const manifest = `.sortie-dogs/contracts/${id}.operation-manifest.json`;
    const handoff = join(root, `.sortie-dogs/contracts/handoff.${id}.json`);
    await writeFile(join(root, manifest), JSON.stringify({ version: "0.1.0", task_id: id,
      read: ["result.txt", "validate.mjs"], write: ["result.txt"], validation: ["node validate.mjs"] }));
    await writeFile(handoff, JSON.stringify({ version: "0.1.0", profile: "minimal", id, created_at: new Date().toISOString(),
      task: { title: `Refine allowed label ${id}`, objective: criterion },
      state: { done: [], next: [`Set result.txt to ${value}, then run node validate.mjs.`], blocked: [] }, risks: [],
      verification: [{ check: "node validate.mjs", status: "not_run", exit_code: null, summary: "content oracle" }],
      ext: { "sortie-dogs/write-gate": { project_root: root, operation_manifest: manifest },
        "sortie-dogs/acceptance-continuity": { schema_version: "0.1", authority: "dispatch", task_id: id,
          criteria: [criterion], fingerprint: acceptanceContinuityFingerprint([criterion]), parent_fingerprint: "none" } } }));
    declarations[phase].push(`Task ${index + 1}: set result.txt to ${value}.\n` +
      `task_id: ${id}\ncontext_digest:\n  project_root: ${root}\n  handoff_path: ${handoff}\n  role: implementation\n` +
      `  acceptance:\n    - ${criterion}\n  validation: { level: full, command: node validate.mjs, diagnostics: [] }\n` +
      `  known_facts: ["One allowed label; existing full oracle; no code change."]\n` +
      `  known_paths: ["result.txt", "validate.mjs"]\n  relevant_constraints: ["Run validation in its own tool call."]\n` +
      `  resume_delta: none\nsource_manifest: ["result.txt"]\noperation_manifest: ${manifest}\n` +
      `goal_declaration_path: .sortie-dogs/contracts/goal.json\ngoal_budget_units: 16`);
  }
}
let sessionID;
async function exercise(phase) {
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
    assert(url, "server unavailable");
    const endpoint = `${url}/session`;
    if (!sessionID) sessionID = (await fetch(`${endpoint}?directory=${encodeURIComponent(root)}`, { method: "POST" }).then(r => r.json())).id;
    const prompt = `This is an authorized three-revision regression fixture within ONE goal. ${phase === "after" ? "Resume the existing goal after the plugin update; this is an explicit same-goal continuation." : "Start the supplied goal."}
goal_budget_units: 16
Execute exactly THREE serial dog-worker Tasks using the supplied declarations and exact handoffs, first alpha, then beta, then gamma. Every revision satisfies the SAME accepted criterion; do not invent new criteria or revise the goal declaration. Preserve the normal handoff acceptance parent chain when needed, without changing its criteria. Tell each worker to change result.txt and run exactly node validate.mjs in its OWN separate bash tool call. Each Task must finish before the next. Follow normal review rules if review is required. Existing tests are complete for this data-only scope; no code change, additional acceptance, or new negative tests. No commit required.
After the third Task, output status: DONE with the canonical return-report card. For this regression measurement, do not dispatch a fourth implementation Task even if the host rejects completion; stop so the harness can inspect the receipt. Do not ask the user for decisions.
${declarations[phase].join("\n\n")}`;
    console.log(JSON.stringify({ phase: `cli-${phase}`, session_id: sessionID, area }));
    const execution = runProcess(cli, ["run", "--attach", url, "--dir", root, "--format", "json", "--print-logs",
      "--agent", "dog-coordinator", "--model", "openai/gpt-5.6-terra", "--variant", "high", "--session", sessionID, prompt],
    { cwd: root, env, timeoutMs: 900_000 });
    let ended = false;
    execution.then(() => { ended = true; });
    const ledgerPath = join(root, ".git/sortie-dogs/run-flight", `${hash(sessionID)}.json`);
    let records = [], detected = 0;
    for (let i = 0; i < 1800; i++) {
      records = await readFile(ledgerPath, "utf8").then(JSON.parse).then(data => data.goal_events).catch(() => []);
      const units = records.filter(({ event }) => event.kind === "unit.settled" && event.unit_id.startsWith(`${phase}-`));
      if (units.length >= 3 && detected === 0) detected = Date.now();
      // A completed third worker does not imply that review/report persistence has finished.
      if (ended || (phase === "before" && detected > 0 && Date.now() - detected > 120_000)) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ended) await fetch(`${endpoint}/${sessionID}/abort?directory=${encodeURIComponent(root)}`, { method: "POST" });
    const result = await execution;
    records = JSON.parse(await readFile(ledgerPath, "utf8")).goal_events;
    const { reduceGoalFlight } = await import(pathToFileURL(join(installed, "dist/core/goal-bound.js")).href);
    const state = reduceGoalFlight(records);
    const units = records.filter(({ event }) => event.kind === "unit.settled" && event.unit_id.startsWith(`${phase}-`)).map(({ event }) => event);
    const messages = await fetch(`${endpoint}/${sessionID}/message?directory=${encodeURIComponent(root)}`).then(r => r.json());
    const report = messages.filter(message => message.info.role === "assistant").flatMap(message => message.parts)
      .filter(part => part.type === "text").some(part => /🐾 SORTIE DOGS — 帰還報告/u.test(part.text));
    const summary = { phase, cli_exit: result.code, timed_out: result.timedOut, goal_id: state.goal_id,
      dispositions: units.map(unit => unit.disposition), evidence_counts: units.map(unit => unit.evidence.length),
      no_progress: state.no_progress_results, replan_required: state.replan_required,
      terminal: state.receipt?.status ?? null, report, session_id: sessionID };
    await writeFile(join(area, `${phase}.json`), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary));
    assert.equal(units.length, 3, "expected all three serial implementation units");
    assert(units.every(unit => unit.evidence.length > 0), "all revisions require native canonical evidence");
    await run("node", ["validate.mjs"]);
    return summary;
  } finally {
    stop();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
    if (server.exitCode === null) { try { process.kill(-server.pid, "SIGKILL"); } catch {} }
    process.removeListener("exit", stop);
  }
}
const before = await exercise("before");
assert.deepEqual(before.dispositions, ["succeeded", "failed", "failed"]);
assert.notEqual(before.terminal, "succeeded");
const afterPackage = await install(afterTgz);
const after = await exercise("after");
assert.deepEqual(after.dispositions, ["succeeded", "succeeded", "succeeded"]);
assert.equal(after.goal_id, before.goal_id);
assert.equal(after.terminal, "succeeded");
assert.equal(after.report, true);
assert.equal(after.no_progress, 0);
const summary = { status: "pass", area, before_package: beforePackage, after_package: afterPackage,
  same_session: before.session_id === after.session_id, same_goal: before.goal_id === after.goal_id, before, after };
await writeFile(join(area, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
