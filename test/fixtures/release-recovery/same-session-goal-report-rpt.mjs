import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const [tgzArg, outputArg = "_testenv"] = process.argv.slice(2);
assert(tgzArg, "usage: node same-session-goal-report-rpt.mjs <package.tgz> [output-root]");
const repository = process.cwd();
const tgz = resolve(repository, tgzArg);
const expectedPackage = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
const root = resolve(repository, outputArg, `same-session-goal-report-rpt-${Date.now()}`);
const project = join(root, "project");
const xdg = join(root, "xdg");
const home = join(root, "home");
const toWsl = path => `/mnt/${path[0].toLowerCase()}${path.slice(2).replaceAll("\\", "/")}`;
const projectWsl = toWsl(project);
let server;
let serverExit;
const port = 48000 + Math.floor(Math.random() * 1000);
const url = `http://127.0.0.1:${port}`;

const run = (file, args, cwd, env = {}, timeout = 300_000) => new Promise((accept, reject) => {
  const child = spawn(file, args, { cwd, env: { ...process.env, ...env }, shell: false, windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout?.on("data", chunk => { stdout += chunk; });
  child.stderr?.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => { child.kill(); reject(new Error(`${file} timeout`)); }, timeout);
  child.once("error", reject);
  child.once("exit", code => {
    clearTimeout(timer);
    if (code === 0) accept({ stdout, stderr });
    else reject(new Error(`${file} exit ${code}`));
  });
});

async function goalEvents() {
  const directory = join(project, ".git", "sortie-dogs", "run-flight");
  const files = (await readdir(directory)).filter(file => file.endsWith(".json"));
  assert.equal(files.length, 1, "expected one root goal ledger");
  const payload = JSON.parse(await readFile(join(directory, files[0]), "utf8"));
  assert(Array.isArray(payload.goal_events), "goal ledger events missing");
  return payload.goal_events.map(entry => entry.event);
}

await mkdir(join(project, ".opencode"), { recursive: true });
await mkdir(xdg, { recursive: true });
await mkdir(home, { recursive: true });
const packageReference = `file:${relative(join(project, ".opencode"), tgz).replaceAll("\\", "/")}`;
await writeFile(join(project, ".opencode", "package.json"), JSON.stringify({ private: true, type: "module",
  dependencies: { "sortie-dogs": packageReference } }, null, 2));
const env = { XDG_CONFIG_HOME: toWsl(xdg), OPENCODE_CONFIG_DIR: `${projectWsl}/.opencode` };

try {
  console.error(JSON.stringify({ phase: "git-init" }));
  await run("wsl.exe", ["--cd", projectWsl, "-e", "bash", "-ic", "git init -q"], repository, env);
  console.error(JSON.stringify({ phase: "npm-install" }));
  await run("wsl.exe", ["--cd", `${projectWsl}/.opencode`, "-e", "bash", "-ic", "npm install --force"], repository, env);
  const installedPath = join(project, ".opencode", "node_modules", "sortie-dogs");
  assert.equal((await lstat(installedPath)).isSymbolicLink(), false, "installed package must be tgz content, not a repository link");
  const installedPackage = JSON.parse(await readFile(join(installedPath, "package.json"), "utf8"));
  assert.equal(installedPackage.version, expectedPackage.version);
  assert.equal(JSON.parse(await readFile(join(project, ".opencode", "package.json"), "utf8")).dependencies["sortie-dogs"],
    packageReference);
  const lock = JSON.parse(await readFile(join(project, ".opencode", "package-lock.json"), "utf8"));
  assert.equal(lock.packages["node_modules/sortie-dogs"].link, undefined, "lock must identify a tarball, not a link");
  assert.match(lock.packages["node_modules/sortie-dogs"].resolved, /\.tgz$/u);
  const installed = `${projectWsl}/.opencode/node_modules/sortie-dogs`;
  console.error(JSON.stringify({ phase: "sortie-init" }));
  await run("wsl.exe", ["--cd", projectWsl, "-e", "bash", "-ic", `node ${installed}/dist/cli/main.js init ${projectWsl}`], repository, env);
  const runtimeAssetMarker = (await readFile(join(project, ".opencode", "sortie-dogs.version"), "utf8")).trim();
  assert(runtimeAssetMarker.length > 0, "runtime asset marker missing");
  await rm(join(project, ".opencode", "opencode.jsonc"), { force: true });
  await writeFile(join(project, ".opencode", "legacy-output-plugin.mjs"), `
import { readFileSync } from "node:fs";
export default async function LegacyOutputPlugin() {
  return { "experimental.text.complete": async (_input, output) => {
    const phase = readFileSync(new URL("./rpt-phase", import.meta.url), "utf8").trim();
    output.text = phase === "first"
      ? "status: NEED_DECISION\\n変更点: first goal stopped\\n確認結果: fixture decision\\n次: new user order\\n\\n<details><summary>Evidence: fixture</summary>\\n~~~yaml\\nmanifest: first\\nraw_status: awaiting_user\\n~~~\\n</details>"
      : "status: NEED_DECISION\\n変更点: second goal stopped\\n確認結果: fixture decision\\n次: none\\n\\n<details><summary>Evidence: contract 1、validation 1</summary>\\n~~~yaml\\nmanifest: second\\nraw_status: awaiting_user\\n~~~\\n</details>";
  } };
}
`);
  await writeFile(join(project, ".opencode", "rpt-phase"), "first\n");
  await writeFile(join(project, ".opencode", "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json",
    plugin: [`file://${projectWsl}/.opencode/legacy-output-plugin.mjs`, `file://${installed}/dist/plugin/opencode.js`] }, null, 2));

  await run("wsl.exe", ["-e", "bash", "-ic", `if fuser ${port}/tcp >/dev/null 2>&1; then exit 1; fi`], repository);
  console.error(JSON.stringify({ phase: "opencode-serve", port }));
  server = spawn("wsl.exe", ["--cd", projectWsl, "-e", "bash", "-ic",
    `HOME='${toWsl(home)}' XDG_DATA_HOME='/home/rozen/.local/share' OPENCODE_CONFIG_DIR='${env.OPENCODE_CONFIG_DIR}' ` +
    `XDG_CONFIG_HOME='${env.XDG_CONFIG_HOME}' opencode serve --print-logs --log-level INFO --hostname 127.0.0.1 --port ${port}`],
  { cwd: repository, env: process.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  // Drain both pipes: an unread --print-logs pipe can block a later session turn.
  // Do not retain raw server logs or credentials.
  server.stdout?.resume();
  server.stderr?.resume();
  serverExit = new Promise(resolveExit => server.once("exit", resolveExit));
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (await fetch(`${url}/global/health`).then(response => response.ok).catch(() => false)) break;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 500));
    if (attempt === 179) throw new Error("OpenCode server did not become healthy");
  }

  const session = await fetch(`${url}/session?directory=${encodeURIComponent(projectWsl)}`, { method: "POST" })
    .then(response => response.json());
  const invoke = async (phase, message) => {
    await writeFile(join(project, ".opencode", "rpt-phase"), `${phase}\n`);
    console.error(JSON.stringify({ phase: `opencode-${phase}` }));
    const quoted = value => `'${value.replaceAll("'", "'\\''")}'`;
    const command = `opencode run --attach ${quoted(url)} --format json --print-logs ` +
      `--model openai/gpt-5.6-luna-fast --agent dog-coordinator --session ${quoted(session.id)} ` +
      `--dir ${quoted(projectWsl)} ${quoted(message)}`;
    const output = await run("wsl.exe", ["--cd", projectWsl, "-e", "bash", "-ic", command], repository, env);
    const stream = output.stdout.split(/\r?\n/u).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    assert(stream.some(event => event.sessionID === session.id), "CLI did not resume the requested session");
    assert(!stream.some(event => event.type === "error"), "CLI returned an error event");
    const messages = await fetch(`${url}/session/${session.id}/message?directory=${encodeURIComponent(projectWsl)}`)
      .then(response => response.json());
    const payload = messages.findLast(message => message.info.role === "assistant");
    return { sessionID: session.id,
      text: payload?.parts?.filter(part => part.type === "text").map(part => part.text).join("\n") ?? "" };
  };

  const first = await invoke("first", "Stop this fixture and return the requested status.");
  assert(first.sessionID, "first CLI run did not expose a session id");
  assert.match(first.text, /🐾 SORTIE DOGS — 帰還報告/u);
  assert.doesNotMatch(first.text, /Evidence|manifest:|raw_status/iu);
  const firstGoal = (await goalEvents()).filter(event => event.kind === "goal.accepted").at(-1)?.goal_id;
  assert(firstGoal, "first CLI run did not accept a goal");

  const second = await invoke("second", "New independent fixture order: return status: NEED_DECISION without calling tools.");
  const secondText = second.text;
  const accepted = (await goalEvents()).filter(event => event.kind === "goal.accepted");
  assert.match(secondText, /second goal stopped/u);
  assert.match(secondText, /🐾 SORTIE DOGS — 帰還報告/u);
  assert.doesNotMatch(secondText, /Evidence|manifest:|raw_status/iu);
  console.error(JSON.stringify({ phase: "accepted-goals", count: accepted.length }));
  assert.equal(accepted.length, 2, "same-session user turns must create exactly two accepted goals");
  assert(accepted.some(event => event.origin_user_message_id !== accepted[0].origin_user_message_id &&
    event.goal_id !== firstGoal), "same-session new user order reused the stopped goal_id");
  const events = await goalEvents();
  for (const goal of accepted) {
    assert(events.some(event => event.kind === "goal.terminal" && event.goal_id === goal.goal_id),
      "both accepted goals must reach a durable terminal state");
  }
  console.log(JSON.stringify({ status: "pass", cli: "opencode run --attach --format json --print-logs", installedPackageVersion: installedPackage.version,
    runtimeAssetMarker, freshGoalInSameSession: true, evidenceReplacedByReturnReport: true }));
} finally {
  if (server !== undefined) {
    await run("wsl.exe", ["-e", "bash", "-ic",
      `fuser -k ${port}/tcp >/dev/null 2>&1 || true; for i in $(seq 1 50); do if ! fuser ${port}/tcp >/dev/null 2>&1 && ! pgrep -f '[o]pencode serve --print-logs --log-level INFO --hostname 127.0.0.1 --port ${port}' >/dev/null; then exit 0; fi; sleep 0.2; done; exit 1`],
      repository, {}, 30_000);
    server.kill();
    await Promise.race([serverExit, new Promise(resolveDelay => setTimeout(resolveDelay, 10_000))]);
    assert.equal(await fetch(`${url}/global/health`).then(response => response.ok).catch(() => false), false,
      "OpenCode server remained reachable after cleanup");
  }
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
