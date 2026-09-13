import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { copyFile, lstat, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};
const baselineRef = option("--baseline-ref");
const outputArg = option("--output");
assert(baselineRef && /^[a-f0-9]{40}$/u.test(baselineRef), "--baseline-ref must be an exact 40-character Git object");
assert(outputArg, "--output is required");
assert(argv.includes("--all"), "--all is required");

const repository = process.cwd();
const outputRoot = resolve(repository, outputArg);
assert(outputRoot.startsWith(resolve(repository, "_testenv") + "\\"), "output must remain under _testenv");
const archiveRoot = join(outputRoot, "baseline-source");
const packsRoot = join(outputRoot, "packs");
const runsRoot = join(outputRoot, "runs");
const npmCache = join(outputRoot, "npm-cache");
const commands = [];
const owned = new Set();
const startedAt = Date.now();
const OVERALL_MS = 24 * 60_000;
const RUN_MS = 4 * 60_000;
const CLI = "/home/rozen/.opencode/bin/opencode";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fileDigest = async (path) => sha256(await readFile(path));
const toWsl = (path) => `/mnt/${path[0].toLowerCase()}${path.slice(2).replaceAll("\\", "/")}`;
const sleep = (ms) => new Promise((accept) => setTimeout(accept, ms));
const bounded = (value, maximum = 16_384) => value.length <= maximum ? value : value.slice(0, maximum);

function record(command, code, stdout, stderr) {
  const fingerprint = `sha256:${sha256(`${command}\nexit=${code}\n${bounded(stdout, 4096)}\n${bounded(stderr, 4096)}`)}`;
  commands.push({ command, exit: code, fingerprint });
  return fingerprint;
}

async function terminateOwnedWsl(pid) {
  if (!pid) return false;
  const script = `descendants() { for child in $(pgrep -P "$1" 2>/dev/null || true); do descendants "$child"; done; echo "$1"; }; pids=$(descendants ${pid}); kill -TERM $pids 2>/dev/null || true; sleep 1; kill -KILL $pids 2>/dev/null || true; ! kill -0 ${pid} 2>/dev/null`;
  return new Promise((accept) => {
    const cleanup = spawn("wsl.exe", ["-e", "bash", "-ic", script], {
      cwd: repository, shell: false, windowsHide: true, stdio: "ignore",
    });
    const timer = setTimeout(() => { cleanup.kill(); accept(false); }, 10_000);
    cleanup.once("error", () => { clearTimeout(timer); accept(false); });
    cleanup.once("exit", code => { clearTimeout(timer); accept(code === 0); });
  });
}

function run(file, args, options = {}) {
  const command = options.label ?? [file, ...args].join(" ");
  const timeout = Math.min(options.timeout ?? RUN_MS, Math.max(1, OVERALL_MS - (Date.now() - startedAt)));
  return new Promise((accept, reject) => {
    const spawnArgs = [...args];
    const shellIndex = file.toLowerCase().endsWith("wsl.exe") ? spawnArgs.indexOf("-ic") : -1;
    if (shellIndex >= 0 && typeof spawnArgs[shellIndex + 1] === "string") {
      spawnArgs[shellIndex + 1] = `echo SORTIE_RUN_PID=$$ >&2; ${spawnArgs[shellIndex + 1]}`;
    }
    const child = spawn(file, spawnArgs, {
      cwd: options.cwd ?? repository,
      env: { ...process.env, ...(options.env ?? {}) },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    owned.add(child);
    let stdout = "", stderr = "", settled = false, timingOut = false, ownedWslPid;
    child.stdout?.on("data", (chunk) => { if (stdout.length < 128_000) stdout += chunk; });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 128_000) stderr += chunk;
      ownedWslPid ??= /SORTIE_RUN_PID=(\d+)/u.exec(stderr)?.[1];
    });
    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      owned.delete(child);
      const fingerprint = record(command, code, stdout, stderr);
      if (error) reject(Object.assign(error, { command, code, fingerprint, stdout, stderr }));
      else accept({ code, stdout, stderr, fingerprint });
    };
    const timer = setTimeout(async () => {
      timingOut = true;
      const stopped = file.toLowerCase().endsWith("wsl.exe") ? await terminateOwnedWsl(ownedWslPid) : true;
      child.kill();
      finish(new Error(`${command} timed out; owned_process_stopped=${stopped}`), null);
    }, timeout);
    child.once("error", (error) => finish(error, null));
    child.once("exit", (code) => timingOut ? undefined : code === 0 || options.allowFailure
      ? finish(undefined, code)
      : finish(new Error(`${command} exited ${code}`), code));
  });
}

async function archive(ref, destination) {
  await mkdir(destination, { recursive: true });
  const command = `git archive ${ref} | tar -x -C ${destination}`;
  await new Promise((accept, reject) => {
    const git = spawn("git", ["archive", ref], { cwd: repository, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const tar = spawn("tar", ["-x", "-C", destination], { cwd: repository, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    owned.add(git); owned.add(tar); git.stdout.pipe(tar.stdin);
    let stdout = "", stderr = "", gitCode, tarCode;
    git.stderr.on("data", chunk => { stderr += chunk; });
    tar.stdout.on("data", chunk => { stdout += chunk; });
    tar.stderr.on("data", chunk => { stderr += chunk; });
    const done = () => {
      if (gitCode === undefined || tarCode === undefined) return;
      owned.delete(git); owned.delete(tar);
      const code = gitCode === 0 && tarCode === 0 ? 0 : 1;
      const fingerprint = record(command, code, stdout, stderr);
      if (code === 0) accept(); else reject(Object.assign(new Error("baseline archive failed"), { fingerprint }));
    };
    git.once("error", reject); tar.once("error", reject);
    git.once("exit", code => { gitCode = code; done(); });
    tar.once("exit", code => { tarCode = code; done(); });
  });
}

async function pack(source, label) {
  const destination = join(packsRoot, label);
  await mkdir(destination, { recursive: true });
  const result = await run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm.cmd", "pack", "--json", "--pack-destination", destination], {
    cwd: source,
    env: { npm_config_cache: npmCache, npm_config_tmp: join(outputRoot, "npm-tmp") },
    timeout: 360_000,
    label: `${label}: npm pack --json --pack-destination ${relative(repository, destination)}`,
  });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.length, 1);
  const tgz = join(destination, payload[0].filename);
  return { tgz, digest: await fileDigest(tgz), version: JSON.parse(await readFile(join(source, "package.json"), "utf8")).version };
}

const providerSource = String.raw`
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
const statePath = new URL("./provider-state.json", import.meta.url);
let state = { requests: 0, tool_calls: 0, done_claims: 0 };
const persist = () => writeFile(statePath, JSON.stringify(state));
const textOf = body => (body.messages ?? []).flatMap(m => typeof m.content === "string" ? [m.content] :
  Array.isArray(m.content) ? m.content.filter(p => p.type === "text").map(p => p.text ?? "") : []).join("\n");
const toolResultOf = (value, depth = 0) => {
  if (depth > 6 || value == null) return undefined;
  if (typeof value === "string") { try { return toolResultOf(JSON.parse(value), depth + 1); } catch { return undefined; } }
  if (Array.isArray(value)) { for (const item of value) { const found = toolResultOf(item, depth + 1); if (found) return found; } return undefined; }
  if (typeof value !== "object") return undefined;
  if (typeof value.status === "string") return value;
  for (const key of ["output", "text", "content", "result", "data"]) { const found = toolResultOf(value[key], depth + 1); if (found) return found; }
};
const responseFor = body => {
  state.requests += 1;
  state.request_shapes ??= [];
  state.request_shapes.push({
    roles: (body.messages ?? []).map(message => message.role ?? null).slice(-8),
    content_types: (body.messages ?? []).flatMap(message => Array.isArray(message.content)
      ? message.content.map(part => part?.type ?? typeof part) : [typeof message.content]).slice(-16),
    tools: (body.tools ?? []).map(tool => tool?.function?.name ?? tool?.name ?? null).filter(Boolean).slice(0, 32),
  });
  const all = textOf(body), hasTool = (body.messages ?? []).some(m => m.role === "tool");
  const toolAvailable = (body.tools ?? []).some(tool => (tool?.function?.name ?? tool?.name) === "sortie_prepare_luna_fabric");
  if (all.includes("fixture-scenario:luna-prepare-checkout") && state.tool_calls === 0 && !hasTool && toolAvailable) {
    state.tool_calls += 1;
    const match = all.match(/contract-path:([^\s"']+)/u);
    return { tool: { name: "sortie_prepare_luna_fabric", arguments: JSON.stringify({ contract_path: match?.[1] ?? "" }) } };
  }
  if (all.includes("fixture-scenario:luna-prepare-checkout")) {
    const toolMessage = (body.messages ?? []).findLast(message => message.role === "tool");
    const content = typeof toolMessage?.content === "string" ? toolMessage.content : JSON.stringify(toolMessage?.content ?? null);
    const parsed = toolResultOf(content);
    state.last_tool_summary = parsed ? { status: parsed.status ?? null, reason: parsed.reason ?? null,
      run_id: parsed.run_id ?? null, ready_descriptors: Array.isArray(parsed.ready) ? parsed.ready.length : 0 } :
      { status: "missing", reason: "tool result was not parseable", run_id: null, ready_descriptors: 0 };
    return { text: "status: NEED_DECISION — Luna fixture observed\n変更点: Luna prepare result recorded\n未実施: worker dispatch and CAS\n次: inspect fixture summary" };
  }
  if (all.includes("fixture-scenario:unproved-done-stop")) {
    const users = (body.messages ?? []).filter(m => m.role === "user").map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content));
    if (users.some(value => value.includes("real-user-resume"))) return { text: "status: NEED_DECISION — real user resumed same session\n変更点: synthetic loop stopped\n未実施: acceptance proof\n次: provide proof" };
    if (state.requests === 1) return { text: "status: BLOCKED\nLocal process defect requiring automatic recovery" };
    state.done_claims += 1;
    return { text: "status: DONE — model claimed completion without evidence\n変更点: original DONE claim\n未実施: typed proof\n次: stop synthetic recovery" };
  }
  return { text: "status: NEED_DECISION — attachment fixture delivered\n変更点: attachment received\n未実施: content analysis\n次: inspect acceptance fingerprint" };
};
const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") { response.end("ok"); return; }
  let raw = ""; for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw || "{}"); const selected = responseFor(body); await persist();
  const delta = selected.tool ? { role: "assistant", tool_calls: [{ index: 0, id: "fixture-call-" + state.requests,
    type: "function", function: selected.tool }] } : { role: "assistant", content: selected.text };
  const finish = selected.tool ? "tool_calls" : "stop";
  if (body.stream) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (selected.tool) {
      const call = delta.tool_calls[0];
      response.write("data: " + JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1,
        model: "fixture", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ ...call,
          function: { name: call.function.name, arguments: "" } }] }, finish_reason: null }] }) + "\n\n");
      response.write("data: " + JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1,
        model: "fixture", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: call.id, type: "function",
          function: { arguments: call.function.arguments } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + "\n\n");
    } else {
      response.write("data: " + JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1,
        model: "fixture", choices: [{ index: 0, delta, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + "\n\n");
    }
    response.end("data: [DONE]\n\n");
  } else response.end(JSON.stringify({ id: "fixture", object: "chat.completion", created: 1, model: "fixture",
    choices: [{ index: 0, message: delta, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
});
server.listen(0, "127.0.0.1", () => console.log("FIXTURE_URL=http://127.0.0.1:" + server.address().port));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;

async function startWslProcess(projectWsl, command, env, marker) {
  const quotedEnv = Object.entries(env).map(([key, value]) => `${key}='${String(value).replaceAll("'", "'\\''")}'`).join(" ");
  const child = spawn("wsl.exe", ["--cd", projectWsl, "-e", "bash", "-ic",
    `${quotedEnv} sh -c 'echo SORTIE_OWNED_PID=$$ >&2; exec ${command}'`], { cwd: repository, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  owned.add(child);
   let stdout = "", stderr = "";
   const errors = [];
  child.stdout.on("data", chunk => { if (stdout.length < 32_768) stdout += chunk; });
   child.stderr.on("data", chunk => {
     stderr = (stderr + chunk).slice(-32_768);
     for (const match of String(chunk).matchAll(/\berror=("(?:\\.|[^"\\\r\n])*"|[^\s]+)/gu)) {
       let message = match[1];
       try { message = JSON.parse(message); } catch { /* unquoted host error */ }
       errors.push(bounded(message, 2048));
       if (errors.length > 16) errors.shift();
     }
   });
  for (let index = 0; index < 300; index += 1) {
    const match = marker.exec(stdout + "\n" + stderr);
    if (match) {
      const pid = /SORTIE_OWNED_PID=(\d+)/u.exec(stderr)?.[1];
      assert(pid, "owned WSL process did not expose its PID");
       return { child, pid, value: match[1], output: () => ({ stdout, stderr }), errors };
    }
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  throw new Error(`process did not emit ${marker}: ${bounded(stderr, 1000)}`);
}

async function stopOwnedProcess(entry) {
  if (!entry || entry.child.exitCode !== null) return true;
  const stopped = await terminateOwnedWsl(entry.pid);
  entry.child.kill();
  for (let index = 0; index < 50 && entry.child.exitCode === null; index += 1) await sleep(100);
  if (entry.child.exitCode === null) entry.child.kill("SIGKILL");
  return stopped && entry.child.exitCode !== null;
}

async function waitHealth(url) {
  for (let index = 0; index < 240; index += 1) {
    if (await fetch(`${url}/global/health`).then(response => response.ok).catch(() => false)) return;
    await sleep(250);
  }
  throw new Error(`health timeout: ${url}`);
}

async function messages(url, sessionID, directory) {
  return fetch(`${url}/session/${sessionID}/message?directory=${encodeURIComponent(directory)}`).then(response => response.json());
}

const assistantText = (items) => items.findLast(item => item.info?.role === "assistant")?.parts
  ?.filter(part => part.type === "text").map(part => part.text).join("\n") ?? "";

function embeddedToolResult(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    try { return embeddedToolResult(JSON.parse(value), depth + 1); } catch { return undefined; }
  }
  if (Array.isArray(value)) {
    for (const item of value) { const found = embeddedToolResult(item, depth + 1); if (found) return found; }
    return undefined;
  }
  if (typeof value !== "object") return undefined;
  if (typeof value.status === "string") return value;
  for (const key of ["output", "text", "content", "result", "data"]) {
    const found = embeddedToolResult(value[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

async function fixture(build, scenario, packed) {
  const area = join(runsRoot, `${build}-${scenario}`);
  const project = join(area, "project"), control = join(project, ".opencode");
  const projectWsl = toWsl(project), controlWsl = `${projectWsl}/.opencode`;
  const isolation = {
    HOME: toWsl(join(area, "home")), XDG_CONFIG_HOME: toWsl(join(area, "xdg-config")),
    XDG_DATA_HOME: toWsl(join(area, "xdg-data")), XDG_CACHE_HOME: toWsl(join(area, "xdg-cache")),
    TMPDIR: toWsl(join(area, "tmp")), OPENCODE_CONFIG_DIR: controlWsl,
    npm_config_cache: toWsl(join(outputRoot, "wsl-npm-cache")), npm_config_tmp: toWsl(join(outputRoot, "wsl-npm-tmp")),
  };
  const fromWsl = (value) => value.replace(/^\/mnt\/([a-z])\//u, (_, drive) => `${drive.toUpperCase()}:\\`).replaceAll("/", "\\");
  await Promise.all(Object.values(isolation).filter(value => value.startsWith("/mnt/"))
    .map(value => mkdir(fromWsl(value), { recursive: true })));
  await mkdir(control, { recursive: true });
  const reference = `file:${relative(control, packed.tgz).replaceAll("\\", "/")}`;
  await writeFile(join(control, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: { "sortie-dogs": reference } }, null, 2));
  await writeFile(join(project, "a.txt"), "a\n"); await writeFile(join(project, "b.txt"), "b\n");
  await run("wsl.exe", ["--cd", projectWsl, "-e", "bash", "-ic", "git init -q && git config user.email fixture@example.invalid && git config user.name fixture && printf '.opencode/\\n.sortie-dogs/\\n' > .gitignore && git add .gitignore a.txt b.txt && git commit -qm base && git branch target && git checkout -q target"], {
    env: isolation, label: `${build}/${scenario}: fixture git init/commit/checkout target`, timeout: 60_000,
  });
  const targetSha = (await run("wsl.exe", ["--cd", projectWsl, "-e", "bash", "-ic", "git rev-parse HEAD"], {
    env: isolation, label: `${build}/${scenario}: fixture target sha`, timeout: 30_000,
  })).stdout.trim();
  await run("wsl.exe", ["--cd", controlWsl, "-e", "bash", "-ic", "npm install --force"], {
    env: isolation, label: `${build}/${scenario}: WSL npm install --force`, timeout: 360_000,
  });
   const installedPath = join(control, "node_modules", "sortie-dogs");
   assert.equal((await lstat(installedPath)).isSymbolicLink(), false, "installed package must not be a symlink");
   assert.equal(JSON.parse(await readFile(join(installedPath, "package.json"), "utf8")).version, packed.version);
  assert.equal(JSON.parse(await readFile(join(control, "package.json"), "utf8")).dependencies["sortie-dogs"], reference);
  const lock = JSON.parse(await readFile(join(control, "package-lock.json"), "utf8"));
  assert.match(lock.packages["node_modules/sortie-dogs"].resolved, /\.tgz$/u);
  assert.equal(lock.packages["node_modules/sortie-dogs"].link, undefined);
    const installedEntry = join(installedPath, "dist", "plugin", "opencode.js");
    const installedRuntime = join(installedPath, "dist", "plugin", "index.js");
  const installed = `${controlWsl}/node_modules/sortie-dogs`;
  await run("wsl.exe", ["--cd", projectWsl, "-e", "bash", "-ic", `node ${installed}/dist/cli/main.js init ${projectWsl}`], {
    env: isolation, label: `${build}/${scenario}: sortie init fixture`, timeout: 60_000,
  });
  await rm(join(control, "opencode.jsonc"), { force: true });
  await writeFile(join(control, "provider.mjs"), providerSource);
  await writeFile(join(control, "provider-state.json"), JSON.stringify({ requests: 0, tool_calls: 0, done_claims: 0 }));
  const provider = await startWslProcess(projectWsl, `node ${controlWsl}/provider.mjs`, isolation, /FIXTURE_URL=(http:\/\/127\.0\.0\.1:\d+)/u);
   const providerUrl = provider.value;
   await writeFile(join(control, "observe-parts.mjs"), `
import { readFile, writeFile } from "node:fs/promises";
const path = new URL("./part-shapes.json", import.meta.url);
export default async function ObserveParts() {
  return { "chat.message": async (input, output) => {
    const previous = JSON.parse(await readFile(path, "utf8").catch(() => "[]"));
    previous.push({ sessionID: input.sessionID, messageID: input.messageID ?? output.message?.id ?? null,
      parts: output.parts.map(part => ({ type: part.type, synthetic: part.synthetic === true,
        mime: part.mime ?? null, keys: Object.keys(part).sort() })) });
    await writeFile(path, JSON.stringify(previous));
  } };
}
`);
   await writeFile(join(control, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json",
     model: "fixture/deterministic", agent: { "dog-coordinator": { model: "fixture/deterministic" } },
     plugin: [`file://${controlWsl}/observe-parts.mjs`, `file://${installed}/dist/plugin/opencode.js`], provider: { fixture: { npm: "@ai-sdk/openai-compatible", name: "Fixture",
      options: { baseURL: `${providerUrl}/v1`, apiKey: "fixture-not-secret" }, models: { deterministic: { name: "Deterministic Fixture" } } } } }, null, 2));
  let server;
  const cleanup = { provider: false, opencode: false, health_unreachable: false };
  try {
    server = await startWslProcess(projectWsl, `${CLI} serve --print-logs --log-level INFO --hostname 127.0.0.1 --port 0`, isolation,
      /(http:\/\/127\.0\.0\.1:\d+)/u);
    const url = server.value;
    await waitHealth(url);
    const createSession = async (body = {}) => fetch(`${url}/session?directory=${encodeURIComponent(projectWsl)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }).then(response => response.json());
    let session = await createSession();
    let sourceSessionID = session.id;
    let cliRuns = [];
    const invoke = async (message, extra = [], allowFailure = false) => {
      const args = ["--cd", projectWsl, "-e", "bash", "-ic", `${CLI} run --attach '${url}' --format json --print-logs --model fixture/deterministic --agent dog-coordinator --session '${session.id}' --dir '${projectWsl}' ${extra.join(" ")} '${message.replaceAll("'", "'\\''")}'`];
      const exact = `${CLI} run --attach ${url} --format json --print-logs --model fixture/deterministic --agent dog-coordinator --session ${session.id} --dir ${projectWsl}${extra.length ? ` ${extra.join(" ")}` : ""} <fixture-message>`;
      const result = await run("wsl.exe", args, { env: isolation, label: `${build}/${scenario}: ${exact}`, allowFailure, timeout: RUN_MS });
      cliRuns.push({ command: exact, exit: result.code, fingerprint: result.fingerprint });
      return result;
    };
    let observed;
    if (scenario === "attachment-redelivery") {
      const rootSession = session;
      const rootExecution = await invoke("fixture-scenario:attachment-bootstrap establish CLI root", [], true);
      const child = await createSession({ parentID: rootSession.id });
      assert(child.id && child.id !== session.id, "child session was not created");
      session = child; sourceSessionID = child.id;
      const projected = [{ type: "text", text: "fixture-scenario:attachment-redelivery inspect attached file" },
        { type: "file", mime: "text/plain", filename: "attachment.txt", url: `data:text/plain;base64,${Buffer.from("fixture attachment payload\n").toString("base64")}` }];
      const redelivery = await fetch(`${url}/session/${child.id}/message?directory=${encodeURIComponent(projectWsl)}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "dog-coordinator",
          model: { providerID: "fixture", modelID: "deterministic" }, parts: projected }),
      }).then(async response => ({ status: response.status, text: bounded(await response.text(), 1024) }))
        .catch(error => ({ status: 0, text: String(error) }));
       let sessions = [];
       let redeliveredAttachmentParts = 0;
       for (let index = 0; index < 80; index += 1) {
          sessions = await fetch(`${url}/session?directory=${encodeURIComponent(projectWsl)}`).then(response => response.json());
          redeliveredAttachmentParts = 0;
          for (const candidateSession of sessions.filter(item => item.id !== rootSession.id && item.id !== child.id)) {
            const candidateMessages = await messages(url, candidateSession.id, projectWsl);
            redeliveredAttachmentParts += candidateMessages.flatMap(item => item.parts ?? []).filter(part => part.type === "file").length;
          }
          if (redeliveredAttachmentParts > 0) break;
          await sleep(250);
       }
      const ledgerDirectory = join(project, ".git", "sortie-dogs", "run-flight");
      const ledgers = await readdir(ledgerDirectory).catch(() => []);
       const accepted = [];
      for (const name of ledgers.filter(name => name.endsWith(".json"))) {
        const payload = JSON.parse(await readFile(join(ledgerDirectory, name), "utf8"));
        accepted.push(...(payload.goal_events ?? []).filter(entry => entry.event?.kind === "goal.accepted").map(entry => entry.event));
       }
       let redeliveryError;
       try {
         const parsed = JSON.parse(redelivery.text);
         redeliveryError = parsed && typeof parsed === "object" ? {
           keys: Object.keys(parsed).sort().slice(0, 16),
           name: parsed.name ?? parsed.error?.name ?? null,
            message: bounded(String(parsed.message ?? parsed.data?.message ?? parsed.error?.message ?? ""), 1024),
         } : undefined;
       } catch { redeliveryError = { keys: [], name: null, message: bounded(redelivery.text, 256) }; }
       observed = { source_session_id: sourceSessionID, session_count: sessions.length, cli_exit: rootExecution.code,
        source_parent_id: child.parentID ?? child.parentId ?? null,
        cli_attachment_parts: projected.filter(part => part.type === "file").length, redelivery_http_status: redelivery.status,
         redelivery_result_class: /(?:FreshSessionRequiredError|SORTIE_[A-Z0-9_-]+|unsafe-message-parts)[^\r\n]*/iu.exec(redelivery.text)?.[0] ?? null,
          redelivery_error: redeliveryError, server_error_messages: [...server.errors],
          host_part_shapes: JSON.parse(await readFile(join(control, "part-shapes.json"), "utf8").catch(() => "[]")),
        redispatched: sessions.length >= 3, redelivered_attachment_parts: redeliveredAttachmentParts,
        attachment_fingerprint: accepted.at(-1)?.acceptance_fingerprint ?? null,
        accepted_goal_count: accepted.length };
    } else if (scenario === "luna-prepare-checkout") {
        const contractPath = `${controlWsl}/sortie-dogs-luna-fabric.json`;
      const contract = { version: "0.8.0", provenance: { source: "dog-coordinator", acceptance_fingerprint: "a".repeat(64),
        target_branch: "target", target_sha: targetSha }, acceptance_items: ["a", "b"], effects: [], shared_paths: [], units: [
        { unit_id: "a", acceptance_items: ["a"], scope_read: [], scope_write: ["a.txt"], depends_on: [], validation: { level: "targeted", command: ["node", "--version"] }, shared_path_keys: [], exclusive_resources: [], scheduler_order: 0 },
        { unit_id: "b", acceptance_items: ["b"], scope_read: [], scope_write: ["b.txt"], depends_on: [], validation: { level: "targeted", command: ["node", "--version"] }, shared_path_keys: [], exclusive_resources: [], scheduler_order: 1 },
      ] };
      await writeFile(join(control, "sortie-dogs-luna-fabric.json"), JSON.stringify(contract));
      const execution = await invoke(`fixture-scenario:luna-prepare-checkout contract-path:${contractPath}`, [], true);
      const itemMessages = await messages(url, session.id, projectWsl);
      const partInventory = itemMessages.flatMap(item => item.parts ?? []).map(part => ({ type: part.type ?? null,
        tool: part.tool ?? part.name ?? null, keys: Object.keys(part).sort(), state_status: part.state?.status ?? null,
        output: bounded(String(part.state?.output ?? part.state?.metadata?.output ?? ""), 512),
        text_first_line: typeof part.text === "string" ? part.text.split(/\r?\n/u)[0].slice(0, 256) : null }));
      const toolParts = itemMessages.flatMap(item => item.parts ?? []).filter(part => part.type === "tool" && part.tool === "sortie_prepare_luna_fabric");
      const last = toolParts.at(-1);
      const rawOutput = last?.state?.output ?? last?.state?.metadata?.output ?? "";
      const providerSnapshot = JSON.parse(await readFile(join(control, "provider-state.json"), "utf8"));
      const result = providerSnapshot.last_tool_summary ?? embeddedToolResult(rawOutput) ?? { status: "missing", reason: bounded(String(rawOutput), 256) };
      observed = { session_id: session.id, cli_exit: execution.code, prepare_tool_calls: toolParts.length,
        prepare_status: result.status ?? null, prepare_reason: result.reason ?? null, run_id: result.run_id ?? null,
         ready_descriptors: Array.isArray(result.ready) ? result.ready.length : result.ready_descriptors ?? 0,
        target_branch: "target", target_sha: targetSha, part_inventory: partInventory };
    } else {
      const first = await invoke("fixture-scenario:unproved-done-stop begin", [], true);
      await sleep(1500);
      const before = await messages(url, session.id, projectWsl);
      const syntheticBefore = before.filter(item => item.info?.role === "user" && item.parts?.some(part => part.synthetic === true)).length;
      const interrupted = before.map(item => assistantText([item])).find(text => /accepted criteria remain unproved/u.test(text)) ?? "";
      const second = await invoke("fixture-scenario:unproved-done-stop real-user-resume", [], true);
      const after = await messages(url, session.id, projectWsl);
      const syntheticAfter = after.filter(item => item.info?.role === "user" && item.parts?.some(part => part.synthetic === true)).length;
      const finalText = assistantText(after);
      observed = { session_id: session.id, same_session_resume: true, first_exit: first.code, second_exit: second.code,
        synthetic_before_real_resume: syntheticBefore, synthetic_after_real_resume: syntheticAfter,
        synthetic_stable_after_stop: syntheticBefore === syntheticAfter, unproved_reason_visible: /accepted criteria remain unproved/u.test(interrupted),
        in_progress_replacement: before.some(item => /status:\s*IN_PROGRESS — durable delivery active/u.test(assistantText([item]))),
        final_terminal: /^status:\s*(?:NEED_DECISION|DONE|INTERRUPTED|BLOCKED)/mu.test(finalText), final_report: finalText };
      if (build === "candidate") await writeFile(join(outputRoot, "report.txt"), finalText);
    }
    const providerState = JSON.parse(await readFile(join(control, "provider-state.json"), "utf8"));
    return { build, scenario, cli_command: cliRuns, installed_version: JSON.parse(await readFile(join(installedPath, "package.json"), "utf8")).version,
      runtime_marker: (await readFile(join(control, "sortie-dogs.version"), "utf8")).trim(), tgz_digest: packed.digest,
      installed_entry_digest: await fileDigest(installedEntry), installed_runtime_digest: await fileDigest(installedRuntime),
      provider: providerState, observed, cleanup };
  } finally {
    cleanup.opencode = await stopOwnedProcess(server);
    cleanup.provider = await stopOwnedProcess(provider);
    if (server) cleanup.health_unreachable = !(await fetch(`${server.value}/global/health`).then(response => response.ok).catch(() => false));
  }
}

let summary;
try {
  const previousSummary = await readFile(join(outputRoot, "summary.json"), "utf8").catch(() => undefined);
  const previousReport = await readFile(join(outputRoot, "report.txt"), "utf8").catch(() => undefined);
   // Preserve every prior attempt; only disposable build/run directories are replaced.
   for (const path of [archiveRoot, packsRoot, runsRoot]) await rm(path, { recursive: true, force: true });
  await Promise.all([mkdir(packsRoot, { recursive: true }), mkdir(runsRoot, { recursive: true }), mkdir(npmCache, { recursive: true })]);
  if (previousSummary !== undefined) {
    const historyRoot = join(outputRoot, "history", `${Date.now()}-${sha256(previousSummary).slice(0, 12)}`);
    await mkdir(historyRoot, { recursive: true });
    await writeFile(join(historyRoot, "summary.json"), previousSummary);
    if (previousReport !== undefined) await writeFile(join(historyRoot, "report.txt"), previousReport);
  }
  await archive(baselineRef, archiveRoot);
  const primaryModules = join(repository, "node_modules"), baselineModules = join(archiveRoot, "node_modules");
  await symlink(primaryModules, baselineModules, "junction");
  const baseline = await pack(archiveRoot, "baseline");
  const candidate = await pack(repository, "candidate");
  assert.notEqual(baseline.digest, candidate.digest, "baseline and candidate tarballs must have distinct digests");
   const availableScenarios = ["attachment-redelivery", "luna-prepare-checkout", "unproved-done-stop"];
   const requestedScenario = option("--scenario");
   assert(!requestedScenario || availableScenarios.includes(requestedScenario), "unknown scenario");
   const scenarios = requestedScenario ? [requestedScenario] : availableScenarios;
  const results = [];
  for (const build of ["baseline", "candidate"]) for (const scenario of scenarios) {
    results.push(await fixture(build, scenario, build === "baseline" ? baseline : candidate));
  }
   const get = (build, scenario) => results.find(result => result.build === build && result.scenario === scenario)?.observed ?? {};
  const expected = {
    attachment_redelivery: "baseline lacks attachment-safe fresh-root delivery; candidate redispatches and records a sha256 fingerprint",
    luna_prepare_checkout: "baseline does not prepare from an already checked-out target; candidate returns prepared descriptors",
    unproved_done_stop: "baseline repeats or rewrites the unproved DONE cycle; candidate exposes the proof reason, stops synthetic growth, and resumes on the same session",
  };
   const allMatches = {
    attachment_redelivery: !get("baseline", "attachment-redelivery").redispatched && get("candidate", "attachment-redelivery").redispatched && get("candidate", "attachment-redelivery").redelivered_attachment_parts >= 1 && /^sha256:[a-f0-9]{64}$/u.test(get("candidate", "attachment-redelivery").attachment_fingerprint ?? ""),
    luna_prepare_checkout: get("baseline", "luna-prepare-checkout").prepare_status !== "prepared" && get("candidate", "luna-prepare-checkout").prepare_status === "prepared" && get("candidate", "luna-prepare-checkout").ready_descriptors >= 2,
    unproved_done_stop: get("candidate", "unproved-done-stop").unproved_reason_visible && get("candidate", "unproved-done-stop").synthetic_stable_after_stop && get("candidate", "unproved-done-stop").same_session_resume && get("candidate", "unproved-done-stop").final_terminal,
  };
   const matches = Object.fromEntries(Object.entries(allMatches).filter(([key]) => scenarios.includes(key.replaceAll("_", "-"))));
   summary = { status: Object.values(matches).every(Boolean) ? "pass" : "fail", scenarios, baseline_ref: baselineRef, generated_at: new Date().toISOString(), duration_ms: Date.now() - startedAt,
    boundary: "loopback deterministic OpenAI-compatible provider; real WSL OpenCode CLI/session/file/tool/plugin hooks; not a production-provider end-to-end claim",
    package: { version: candidate.version, baseline_tgz: relative(repository, baseline.tgz), candidate_tgz: relative(repository, candidate.tgz), baseline_digest: baseline.digest, candidate_digest: candidate.digest },
    expected, matches, results, commands };
  await writeFile(join(outputRoot, "summary.json"), JSON.stringify(summary, null, 2));
  assert(Object.values(matches).every(Boolean), `comparison mismatch: ${JSON.stringify(matches)}`);
  assert(results.every(result => result.cleanup.provider && result.cleanup.opencode && result.cleanup.health_unreachable), "owned process cleanup incomplete");
  console.log(JSON.stringify({ status: summary.status, summary: relative(repository, join(outputRoot, "summary.json")), report: relative(repository, join(outputRoot, "report.txt")), matches }));
} finally {
  for (const child of [...owned]) { try { child.kill("SIGKILL"); } catch {} }
}
