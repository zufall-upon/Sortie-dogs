import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';
import { estimateModelUsageCost } from '../dist/plugin/model-cost.js';

// Connect only to the already-running Desktop service; never substitute a CLI server.
const [tgzArg, outputArg, mode = 'executed'] = process.argv.slice(2);
assert(['executed', 'NO_START', 'compaction'].includes(mode));
const tgz = resolve(tgzArg), output = resolve(outputArg), project = join(output, 'project');
await mkdir(output, { recursive: true });
const endpoint = await Service.discover();
assert(endpoint, 'Start OpenCode V2 Desktop first');
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
const host = await client.server.info();
const parent = JSON.parse(execFileSync('pwsh', ['-NoProfile', '-Command',
  `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${host.pid}"; Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" | Select-Object ProcessId,Name,ExecutablePath | ConvertTo-Json -Compress`], { encoding: 'utf8' }));
assert.equal(parent.Name, 'OpenCode.exe', 'The service must be owned by the real Desktop process');
const control = join(project, '.opencode');
await mkdir(control, { recursive: true });
await writeFile(join(control, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { 'sortie-dogs': pathToFileURL(tgz).href } }));
const npmCLI = resolve(process.execPath, '../node_modules/npm/bin/npm-cli.js');
execFileSync(process.execPath, [npmCLI, 'install', '--no-audit', '--no-fund'], { cwd: control, stdio: 'pipe' });
const installed = join(control, 'node_modules/sortie-dogs');
execFileSync(process.execPath, [join(installed, 'dist/cli/main.js'), 'init', project], { cwd: project, stdio: 'pipe' });
await mkdir(join(control, 'plugins/sortie-dogs'), { recursive: true });
await writeFile(join(control, 'plugins/sortie-dogs/index.js'), `import plugin from "sortie-dogs/server";
import { appendFileSync } from "node:fs";
import { Service } from "@opencode/client/service";
import { OpenCode } from "@opencode/client";
const log = value => appendFileSync(${JSON.stringify(join(output, 'native-observer.jsonl'))}, JSON.stringify(value)+"\\n");
export default { id: "sortie-dogs.desktop-probe", async setup(ctx) {
  const cleanup = await plugin.setup(ctx);
  log({kind: "loaded", host: ctx.app.version, pid: process.pid, directory: ctx.location.directory,
    candidate: ${JSON.stringify(createHash('sha256').update(await readFile(tgz)).digest('hex'))}});
  const requested = new Set();
  if (${JSON.stringify(mode)} === "compaction") {
    await ctx.tool.hook("execute.after", async event => {
      if (event.tool !== "read" || event.status !== "completed" || requested.has(event.sessionID)) return;
      if (!(await ctx.session.get({sessionID:event.sessionID})).agent?.includes("worker")) return;
      requested.add(event.sessionID);
      const endpoint = await Service.discover();
      const client = OpenCode.make({baseUrl:endpoint.url, headers:Service.headers(endpoint)});
      await client.session.compact({sessionID:event.sessionID});
      log({kind:"compact-requested",sessionID:event.sessionID});
    });
    await ctx.session.hook("compaction", event => {
      if (!requested.has(event.sessionID)) return;
      log({kind:"compacted",sessionID:event.sessionID,system:event.system});
      event.result = {summary:"Compacted before execution. Recover your assigned handoff from the host context, read its exact path again, bind and continue the original operation once."};
    });
  }
  return cleanup;
}};\n`);
await writeFile(join(control, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json',
  plugins: ['-sortie-dogs.v010', './plugins/sortie-dogs'], subagent_depth: 2 }));
await writeFile(join(project, '.gitignore'), '.opencode/\n.sortie-dogs-v010/\nresult.json\n');
await writeFile(join(project, 'AGENTS.md'), '# Desktop operation fixture\nUse the supplied existing runner once. Do not edit the runner, settings or package. No approval is needed for this local fixture. Formal validation and requested execution are both `node run.mjs`. Write scope: result.json. Read scope: run.mjs.\n');
await writeFile(join(project, 'run.mjs'), `import { existsSync, writeFileSync } from 'node:fs';
if (existsSync('result.json')) throw Error('duplicate operation attempt');
const result = ${JSON.stringify({ status: mode === 'NO_START' ? 'NO_START' : 'executed', attempts: mode === 'NO_START' ? 0 : 1, reward: 0, target: 'candidate-v0.12.15' })};
writeFileSync('result.json', JSON.stringify(result));
console.log(JSON.stringify(result));\n`);
for (const args of [['init', '-q'], ['add', 'AGENTS.md', '.gitignore', 'run.mjs'],
  ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Desktop fixture']]) {
  execFileSync('git', args, { cwd: project, stdio: 'pipe' });
}
const marker = (await import(pathToFileURL(join(installed, 'dist/asset-version.js')).href)).V010_RUNTIME_ASSET_VERSION;
const root = await client.session.create({ title: `Sortie Desktop efficiency ${mode}`, agent: 'dog-operator',
  model: { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'xhigh' }, location: { directory: project } });
// Plugin inventory is a live startup snapshot and may initially be empty, even after create.
let plugins = [];
for (let attempt = 0; attempt < 100; attempt++) {
  plugins = (await client.plugin.list({ location: { directory: project } })).data;
  if (plugins.some(item => item.id === 'sortie-dogs.desktop-probe')) break;
  await new Promise(resolve => setTimeout(resolve, 100));
}
await writeFile(join(output, 'plugins.json'), JSON.stringify(plugins, null, 2));
assert(plugins.some(item => item.id === 'sortie-dogs.desktop-probe' && item.state.status === 'active'), JSON.stringify(plugins.filter(item => item.id.includes('sortie'))));
assert(!plugins.some(item => item.id === 'sortie-dogs.v010' && item.state.status === 'active'), 'Global plugin must be disabled in the fixture');
await writeFile(join(output, 'launch.json'), JSON.stringify({ root: root.id, project, host, parent, marker,
  candidate_sha256: createHash('sha256').update(await readFile(tgz)).digest('hex') }, null, 2));
console.log(JSON.stringify({ root: root.id, project, host, mode }));
await client.session.prompt({ sessionID: root.id, text: '対象はcandidate-v0.12.15。既存runnerはnode run.mjs、準備済み。対象と手順を次の依頼へ引き継いで。', resume: false });
const started = Date.now();
await client.session.prompt({ sessionID: root.id,
  text: 'では、その対象で既存runnerを1回実行して結果を報告して。実行できなかった場合は未実行と報告して。' +
    (mode === 'compaction' ? ' この診断ではCoordinator経由で実施して。' : '') });
let timedOut = false;
try { await client.session.wait({ sessionID: root.id }, { signal: AbortSignal.timeout(600_000) }); }
catch (error) { timedOut = true; await client.session.interrupt({ sessionID: root.id }); }
const list = await client.session.list({ directory: project, limit: 100 });
const sessions = list.data ?? list;
assert(Array.isArray(sessions), 'Native session list unavailable');
// Export retains the pre-compaction messages as well; active context would undercount spend.
const history = await Promise.all(sessions.map(info => client.session.export({ sessionID: info.id })));
await writeFile(join(output, 'native-history.json'), JSON.stringify(history, null, 2));
let usd = 0, unpriced = 0;
const models = [], tools = [];
for (const { info, messages } of history) for (const message of messages) {
  if (message.type !== 'assistant') continue;
  const tokens = message.tokens;
  const cost = estimateModelUsageCost({ providerID: message.model?.providerID, modelID: message.model?.id,
    uncachedInputTokens: tokens?.input, cacheReadTokens: tokens?.cache?.read, cacheWriteTokens: tokens?.cache?.write,
    outputTokens: tokens?.output, reasoningTokens: tokens?.reasoning });
  if (cost.status === 'priced') usd += cost.usd; else unpriced++;
  if (!models.some(item => item.sessionID === info.id)) models.push({ sessionID: info.id, parentID: info.parentID, agent: info.agent, model: message.model });
  for (const part of message.content ?? []) if (part.type === 'tool') tools.push({ sessionID: info.id, tool: part.name, state: part.state });
}
const key = createHash('sha256').update(root.id).digest('hex');
const readState = async area => JSON.parse(await readFile(join(project, '.sortie-dogs-v010', area, `${key}.json`), 'utf8'));
// Missing state is recorded explicitly rather than mistaken for a successful empty run.
const state = async area => { try { return await readState(area); } catch { return null; } };
const mission = await state('missions'), operator = await state('operators');
const observation = { root: root.id, host, parent, marker, mode, elapsed_ms: Date.now() - started,
  candidate_sha256: createHash('sha256').update(await readFile(tgz)).digest('hex'), timedOut,
  models, priced_usd: usd, unpriced_requests: unpriced,
  mission_phase: mission?.phase ?? null, execution: mission?.execution ?? null, receipt: operator?.receipt ?? null,
  tools: tools.map(({ sessionID, tool, state }) => ({ sessionID, tool, status: state?.status })) };
await writeFile(join(output, 'observation.json'), JSON.stringify(observation, null, 2));
console.log(JSON.stringify(observation, null, 2));
assert(!timedOut, 'Desktop probe timed out');
assert(models.some(item => item.sessionID === root.id && item.model?.id === 'gpt-6.1-sol' && item.model.variant === 'xhigh'), 'Real GPT-6.1 Sol/xhigh Operator must execute');
assert(models.some(item => item.agent === 'dog-worker-v010' && item.model?.id === 'gpt-6-luna-fast' && item.model.variant === 'max'), 'Real Luna/max Worker must execute');
assert.equal(models.filter(item => item.agent === 'dog-worker-v010').length, 1, 'The routine operation must not require an evidence-only successor');
assert(mission?.context?.some(item => item.text.includes('candidate-v0.12.15')), 'Previous target must survive the short follow-up');
assert(operator, 'Operator state must be retained');
assert.equal(mission?.execution?.observations.length, 1, 'Exactly one native execution');
assert.equal(mission.execution.observations[0].outcome, mode === 'NO_START' ? 'not-started' : 'executed');
if (mode === 'compaction') {
  const observer = (await readFile(join(output, 'native-observer.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(observer.filter(item => item.kind === 'compacted').length, 1);
  assert(observer.some(item => item.kind === 'compacted' && JSON.stringify(item.system).includes('SORTIE_WORKER_CONTEXT')));
  const worker = history.find(item => item.info.agent === 'dog-worker-v010');
  const compacted = worker.messages.findIndex(message => message.type === 'compaction' && message.status === 'completed');
  assert(compacted > 0, 'Native history must retain the actual completed compaction');
  const calls = messages => messages.flatMap(message => message.content ?? []).filter(part => part.type === 'tool');
  const before = calls(worker.messages.slice(0, compacted)), after = calls(worker.messages.slice(compacted + 1));
  const handoff = before.find(part => part.name === 'read' && JSON.stringify(part.state.input).includes('handoff'));
  assert(handoff, 'Compaction must occur after the initial handoff read');
  assert(after.some(part => part.name === 'read' && JSON.stringify(part.state.input) === JSON.stringify(handoff.state.input)), 'Worker must reread the same exact handoff');
  assert(after.some(part => part.name === 'sortie_v010_bind_write_gate' && JSON.stringify(part.state.content).includes('bound')), 'Worker must rebind successfully after compaction');
}
assert(mode === 'NO_START' ? mission?.phase !== 'completed' && operator?.receipt?.status !== 'succeeded' : mission?.phase === 'completed' && operator?.receipt?.status === 'succeeded');
