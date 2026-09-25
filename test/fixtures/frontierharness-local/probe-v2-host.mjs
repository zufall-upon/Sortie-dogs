#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";

// This probe starts a private V2 server, reads only registration metadata, and never creates a session.
const [cli, workspace] = process.argv.slice(2);
if (!cli || !workspace || !process.env.OPENCODE_DB || !process.env.XDG_CONFIG_HOME)
  throw new Error("V2 probe requires a pinned CLI, workspace, isolated database and config root.");
const password = randomBytes(32).toString("hex");
const expectSortie = existsSync(`${workspace}/.opencode/plugins/sortie-dogs`);
const expectedAgents = ["dog-operator", "dogs-coordinator", "dog-worker-v010", "dog-luna-worker-v010",
  "dog-scout-v010", "dog-reviewer-v010", "dog-advisor-v010"];
const child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
  cwd: workspace, env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
  stdio: ["ignore", "pipe", "pipe"], shell: false,
});
let output = "";
let url;
let failed;
let closed = false;
child.once("error", error => { failed = error; });
child.once("close", () => { closed = true; });
child.stdout.on("data", bytes => {
  output = (output + bytes.toString("utf8")).slice(-4096);
  url ??= /http:\/\/127\.0\.0\.1:\d+/u.exec(output)?.[0];
});
// Do not print server logs: plugin errors may include paths or private configuration.
child.stderr.resume();
const wait = ms => new Promise(done => setTimeout(done, ms));
const deadline = Date.now() + 60_000;
async function get(route) {
  const response = await fetch(`${url}${route}`, {
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`V2 registration endpoint ${route} returned ${response.status}`);
  return response.json();
}
try {
  while (!url && !failed && !closed && Date.now() < deadline) await wait(100);
  if (!url) throw new Error("Private V2 server did not become ready.");
  let agents, plugins;
  while (Date.now() < deadline) {
    [agents, plugins] = await Promise.all([get("/api/agent"), get("/api/plugin")]);
    if (agents?.location?.directory === workspace && plugins?.location?.directory === workspace &&
      agents.data?.length && plugins.data?.length &&
      (!expectSortie || expectedAgents.every(id => agents.data.some(agent => agent.id === id))) &&
      (!expectSortie || plugins.data.some(plugin => plugin.id === "sortie-dogs.v010" &&
        plugin.state?.status === "active"))) break;
    await wait(250);
  }
  if (!agents?.data?.length || !plugins?.data?.length || Date.now() >= deadline)
    throw new Error("Private V2 registration did not settle before the deadline.");
  const selected = agents.data.filter(agent => /^(?:dog-|dogs-)/u.test(agent.id) || agent.id === "build")
    .map(agent => ({ id: agent.id, model: agent.model }));
  const external = plugins.data.filter(plugin => !plugin.id.startsWith("opencode."))
    .map(plugin => ({ id: plugin.id, state: plugin.state?.status, server: plugin.features?.server === true }));
  process.stdout.write(JSON.stringify({ agents: selected, plugins: external }) + "\n");
} finally {
  if (!closed) child.kill("SIGTERM");
  for (let i = 0; i < 30 && !closed; i += 1) await wait(100);
  if (!closed) child.kill("SIGKILL");
}
