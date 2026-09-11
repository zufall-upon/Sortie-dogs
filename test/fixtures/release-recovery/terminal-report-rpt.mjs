import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const [tgzArg, outputArg = "_testenv"] = process.argv.slice(2);
assert(tgzArg, "usage: node terminal-report-rpt.mjs <package.tgz> [output-root]");
const repository = process.cwd();
const tgz = resolve(repository, tgzArg);
const root = resolve(repository, outputArg, `terminal-report-rpt-${Date.now()}`);
const project = join(root, "project");
const xdg = join(root, "xdg");
const toWsl = path => `/mnt/${path[0].toLowerCase()}${path.slice(2).replaceAll("\\", "/")}`;
const projectWsl = toWsl(project);
await mkdir(join(project, ".opencode"), { recursive: true });
await mkdir(xdg, { recursive: true });
await writeFile(join(project, "result.txt"), "seed\n");
await writeFile(join(project, ".opencode", "package.json"), JSON.stringify({ private: true, type: "module",
  dependencies: { "sortie-dogs": `file:${toWsl(tgz)}` } }, null, 2));

const run = (file, args, cwd, env = {}, timeout = 180_000) => new Promise((accept, reject) => {
  const child = spawn(file, args, { cwd, env: { ...process.env, ...env }, shell: false, windowsHide: true });
  let stdout = "", stderr = "";
  child.stdout?.on("data", chunk => { stdout += chunk; });
  child.stderr?.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => { child.kill(); reject(new Error(`${file} timeout`)); }, timeout);
  child.once("error", reject);
  child.once("exit", code => {
    clearTimeout(timer);
    if (code === 0) accept(stdout);
    else reject(new Error(`${file} exit ${code}: ${stderr.slice(-500)}`));
  });
});

const env = { XDG_CONFIG_HOME: toWsl(xdg), OPENCODE_CONFIG_DIR: `${toWsl(project)}/.opencode` };
await run("wsl.exe", ["--cd", `${toWsl(project)}/.opencode`, "-e", "bash", "-ic", "npm install --force"], repository, env, 300_000);
const installed = `${toWsl(project)}/.opencode/node_modules/sortie-dogs`;
await run("wsl.exe", ["--cd", toWsl(project), "-e", "bash", "-ic",
  `node ${installed}/dist/cli/main.js init ${toWsl(project)}`], repository, env);
await writeFile(join(project, ".opencode", "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json",
  plugin: [`file://${installed}/dist/plugin/opencode.js`] }, null, 2));

const port = 47000 + Math.floor(Math.random() * 1000);
const server = spawn("wsl.exe", ["--cd", toWsl(project), "-e", "bash", "-ic",
  `OPENCODE_CONFIG_DIR='${env.OPENCODE_CONFIG_DIR}' XDG_CONFIG_HOME='${env.XDG_CONFIG_HOME}' opencode serve --hostname 127.0.0.1 --port ${port}`],
  { cwd: repository, env: process.env, shell: false, windowsHide: true });
const serverExit = new Promise(resolve => server.once("exit", resolve));
const url = `http://127.0.0.1:${port}`;
try {
  for (let i = 0; i < 120; i++) {
    if (await fetch(`${url}/global/health`).then(response => response.ok).catch(() => false)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
    if (i === 119) throw new Error("OpenCode server did not become healthy");
  }
  const session = await fetch(`${url}/session?directory=${encodeURIComponent(projectWsl)}`, { method: "POST" }).then(response => response.json());
  const sessionID = session.id;
  const report = "status: NEED_DECISION\n変更点: terminal report persistence fixture\n確認結果: no source mutation\n次: fixture decision only\n\n<details>\n<summary><strong>🐾 SORTIE DOGS — 帰還報告</strong></summary>\n\n**任務:** fixture decision\n**確認:** no source mutation\n\n</details>";
  const prompt = fetch(`${url}/session/${sessionID}/message?directory=${encodeURIComponent(projectWsl)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "dog-coordinator",
      parts: [{ type: "text", text: `Return exactly this canonical report and stop. Do not call tools:\n${report}` }] }),
  });
  await prompt;
  const before = await fetch(`${url}/session/${sessionID}/message?directory=${encodeURIComponent(projectWsl)}`).then(response => response.json());
  const assistantDiagnostics = before.filter(message => message.info.role === "assistant").map(message => {
    const text = message.parts.filter(part => part.type === "text").map(part => part.text).join("\n");
    return { firstLine: text.split(/\r?\n/u)[0] ?? "", sha256: createHash("sha256").update(text).digest("hex") };
  });
  console.error(JSON.stringify({ phase: "before-compaction", assistantDiagnostics }));
  const beforeText = before.findLast(message => message.info.role === "assistant")?.parts
    .filter(part => part.type === "text").map(part => part.text).join("\n") ?? "";
  assert(/^status:\s*NEED_DECISION/mu.test(beforeText),
    "terminal report was not persisted before compaction");
  assert(/<details>[\s\S]*🐾 SORTIE DOGS — 帰還報告[\s\S]*<\/details>/u.test(beforeText),
    "durable return report card was not persisted before compaction");
  const summary = await fetch(`${url}/session/${sessionID}/summarize?directory=${encodeURIComponent(projectWsl)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerID: "openai", modelID: "gpt-5.6-terra" }),
  });
  assert(summary.ok, `summarize failed: ${summary.status}`);
  await summary.arrayBuffer();
  let messages = before;
  for (let i = 0; i < 240; i++) {
    messages = await fetch(`${url}/session/${sessionID}/message?directory=${encodeURIComponent(projectWsl)}`).then(response => response.json());
    const reemit = messages.findLast(message => message.info.role === "assistant" &&
      message.parts.some(part => part.type === "text" && part.text.includes("terminal report persistence fixture")));
    const synthetic = messages.some(message => message.info.role === "user" &&
      message.parts.some(part => part.type === "text" && part.text.includes("SORTIE_TERMINAL_REEMIT")));
    if (synthetic && reemit !== undefined) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const originalAssistantID = before.findLast(message => message.info.role === "assistant")?.info.id;
  const persisted = messages.find(message => message.info.id === originalAssistantID);
  const persistedText = persisted?.parts.filter(part => part.type === "text").map(part => part.text).join("\n") ?? "";
  console.error(JSON.stringify({ phase: "after-compaction", messages: messages.map(message => ({
    role: message.info.role, agent: message.info.agent, synthetic: message.info.synthetic === true,
    firstLine: message.parts.filter(part => part.type === "text").map(part => part.text).join("\n").split(/\r?\n/u)[0] ?? "",
  })) }));
  assert(persistedText === beforeText,
    "persisted assistant message changed or lost the return report across compaction");
  console.log(JSON.stringify({ status: "pass", sessionID, persistedFallbackCard: true, postCompactionStable: true }));
} finally {
  await run("wsl.exe", ["-e", "bash", "-ic",
    `fuser -k ${port}/tcp >/dev/null 2>&1 || true; for i in $(seq 1 50); do if ! fuser ${port}/tcp >/dev/null 2>&1 && ! pgrep -f '[o]pencode serve --hostname 127.0.0.1 --port ${port}' >/dev/null; then exit 0; fi; sleep 0.2; done; exit 1`],
    repository, {}, 30_000);
  server.kill();
  await Promise.race([serverExit, new Promise(resolve => setTimeout(resolve, 10_000))]);
  assert.equal(await fetch(`${url}/global/health`).then(response => response.ok).catch(() => false), false,
    "OpenCode server remained reachable after cleanup");
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
