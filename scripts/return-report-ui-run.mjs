import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';
import { estimateModelUsageCost } from '../dist/plugin/model-cost.js';

// One ordinary Mission on the existing service. No synthetic messages, private APIs or DB writes.
const [mode, outputArg, packageArg] = process.argv.slice(2);
assert(['prepare', 'run', 'collect', 'verify'].includes(mode), 'prepare|run|collect|verify output [tgz]');
const output = resolve(outputArg), project = join(output, 'project');
const json = async file => JSON.parse(await readFile(join(output, file), 'utf8'));
const save = async (file, value) => writeFile(join(output, file), JSON.stringify(value, null, 2));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const endpoint = await Service.discover();
assert(endpoint, 'An existing service is required; do not start or restart the shared service');
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
const text = value => typeof value === 'string' ? value : Array.isArray(value)
  ? value.filter(p => p.type === 'text').map(p => p.text).join('\n') : '';

if (mode === 'prepare') {
  await mkdir(output, { recursive: true });
  const tgz = resolve(packageArg), control = join(project, '.opencode');
  await mkdir(control, { recursive: true });
  const history = await client.session.export({ sessionID: 'ses_e78598750ffea8mRay7CTqIN8F' });
  const parent = await client.session.export({ sessionID: 'ses_95f3b16f0069428390dd8c26ab7d0097' });
  const task = parent.messages.flatMap(m => m.content ?? []).find(p => p.id === 'call_8f93338bc55e4219a6c71844f2e0f262');
  assert(task?.state?.metadata?.sortie_progress?.work_quantity);
  const plans = history.messages.flatMap(m => m.content ?? []).filter(p => p.name === 'sortie_v010_plan_units');
  const updated = plans.map(p => { try { return { call: p.id, value: JSON.parse(text(p.state?.content)) }; } catch { return null; } })
    .find(p => p?.value.work_quantity?.n === 38);
  assert(updated, 'Retain the actual same-Mission plan result, not a handwritten progress sample');
  const input = { mission_id: task.state.metadata.sortie_progress.mission_id,
    task_call: task.id, initial: task.state.metadata.sortie_progress.work_quantity,
    updated_call: updated.call, updated: updated.value.work_quantity,
    limits: ['Task input caption is static; metadata delivery does not prove UI rendering.',
      'Whole-request workload estimate, not time, cost or budget consumption.'] };
  await writeFile(join(project, 'input.json'), JSON.stringify(input, null, 2));
  await writeFile(join(project, 'verify.mjs'), `import assert from 'node:assert/strict';
import fs from 'node:fs';
const input=JSON.parse(fs.readFileSync('input.json','utf8'));
const notes=fs.readFileSync('delivery-observation.md','utf8');
assert(notes.includes(input.mission_id));
for(const n of [input.initial.n,input.updated.n]) assert(notes.includes(n+'%'));
assert(notes.includes('概算')); assert(notes.includes('Task')); assert(notes.includes('Direct'));
assert(notes.includes('未修復')); assert(notes.includes('時間')); assert(notes.includes('費用'));
console.log('delivery-observation: PASS');\n`);
  await writeFile(join(project, 'AGENTS.md'), '# 配送観測記録の整備\ninput.jsonとverify.mjsは既存の不変入力。観測をdelivery-observation.mdへ短く記録し、node verify.mjsで確認する。候補の表示確認も含む通常のMission。実装/Coordinator/Reviewerは明示openai/gpt-6.1-solのみ。追加の進捗専用turn、synthetic、DB/履歴/stream編集は禁止。global設定・共有hostは変更しない。\n');
  await writeFile(join(project, '.gitignore'), '.opencode/\n.sortie-dogs-v010/\n');
  await writeFile(join(control, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { 'sortie-dogs': pathToFileURL(tgz).href } }));
  execFileSync('npm', ['install', '--prefix', control, '--cache', join(output, 'npm-cache'), '--ignore-scripts', '--no-audit', '--no-fund'], { stdio: 'pipe' });
  const installed = join(control, 'node_modules/sortie-dogs');
  execFileSync(process.execPath, [join(installed, 'dist/cli/main.js'), 'init', project], { cwd: project, stdio: 'pipe' });
  const pluginPath = join(control, 'plugins/sortie-dogs');
  await mkdir(pluginPath, { recursive: true });
  await writeFile(join(pluginPath, 'index.js'), `import plugin from 'sortie-dogs/server';
import {appendFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const log=value=>appendFileSync(${JSON.stringify(join(output, 'native-observer.jsonl'))},JSON.stringify(value)+'\\n');
export default {id:'sortie-dogs.return-report-ui',async setup(ctx){
 const cleanup=await plugin.setup(ctx);
 await ctx.agent.transform(editor=>{for(const role of ['dog-operator','dogs-coordinator','dog-worker-v010','dog-reviewer-v010','dog-advisor-v010','dog-scout-v010','dog-luna-worker-v010']) editor.update(role,agent=>{agent.model={providerID:'openai',id:'gpt-6.1-sol',variant:'xhigh'};});});
 log({kind:'loaded',host:ctx.app.version,pid:process.pid,directory:ctx.location.directory,
 adapter_sha256:createHash('sha256').update(readFileSync(${JSON.stringify(join(installed, 'dist/plugin/v2.js'))})).digest('hex'),
 modules:Object.fromEntries(['sortie-debrief','run-metrics','profiled'].map(n=>[n,createHash('sha256').update(readFileSync(${JSON.stringify(join(installed, 'dist/plugin'))}+'/'+n+'.js')).digest('hex')]))});
 await ctx.tool.hook('execute.after',event=>{if(event.tool.startsWith('sortie_'))log({kind:'tool',event});});
 return cleanup;
}};\n`);
  await writeFile(join(control, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json',
    plugins: ['-sortie-dogs.v010', './plugins/sortie-dogs'], subagent_depth: 2 }));
  for (const args of [['init', '-q'], ['add', 'AGENTS.md', '.gitignore', 'input.json', 'verify.mjs'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Preserve observed delivery input']]) execFileSync('git', args, { cwd: project, stdio: 'pipe' });
  await save('setup.json', { project, tgz, package_sha256: hash(await readFile(tgz)),
    source_commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    runner_sha256: hash(await readFile(new URL(import.meta.url))), host: await client.server.info(), model: 'openai/gpt-6.1-sol#xhigh' });
  console.log(JSON.stringify(await json('setup.json')));
}

if (mode === 'run') {
  const setup = await json('setup.json');
  let prior;
  try { prior = await json('launch.json'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  assert(!prior, 'This run already has a session. Use collect; do not launch it again.');
  const root = await client.session.create({ title: '作戦卓候補：進捗配送の観測記録', agent: 'dog-operator',
    model: { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'xhigh' }, location: { directory: project } });
  await save('launch.json', { root: root.id, started_at: new Date().toISOString(), project,
    package_sha256: setup.package_sha256, server_url: endpoint.url });
  console.log(JSON.stringify({ sessionID: root.id, project, server_url: endpoint.url }));
  const prompt = 'input.jsonに保存された同一Missionの実観測からdelivery-observation.mdを作成して。' +
    '開始時と更新後の作業量、概算であって時間・費用・予算消費率ではないこと、DirectにはTaskがない場合があること、背景Task字幕の配送/表示断点は未修復という留保を短く記録する。' +
    'input.jsonとverify.mjsを変更せず、既存node verify.mjsで確認し、通常のMissionを正式完了まで進めて。' +
    'この検証はCoordinator直実行の経路で進める。Coordinator/実装/Reviewerはopenai/gpt-6.1-solを明示、Gemma禁止。' +
    '作業の有用な節目でhostのwork_quantity_displayを通常本文へそのまま示す。進捗だけの呼出し/追加turnは作らず、正式return_reportは最終本文に逐語一度だけ添付する。';
  await save('request.json', { prompt });
  await client.session.prompt({ sessionID: root.id, text: prompt });
  const start = Date.now();
  let limitReason = null;
  const monitor = setInterval(async () => {
    try {
      const sessions = (await client.session.list({ directory: project, limit: 30 })).data;
      let usd = 0;
      for (const info of sessions) {
        const h = await client.session.export({ sessionID: info.id });
        for (const m of h.messages) if (m.type === 'assistant') {
          const t = m.tokens, p = estimateModelUsageCost({ providerID: m.model?.providerID, modelID: m.model?.id,
            uncachedInputTokens: t?.input, cacheReadTokens: t?.cache?.read, cacheWriteTokens: t?.cache?.write,
            outputTokens: t?.output, reasoningTokens: t?.reasoning });
          if (p.status === 'priced') usd += p.usd;
        }
      }
      if (usd >= 3 || Date.now() - start > 600_000) {
        limitReason ??= usd >= 3 ? 'priced-cost-cap' : 'timeout';
        for (const info of sessions) await client.session.interrupt({ sessionID: info.id, resume: false });
      }
    } catch (error) { console.warn('observation:', error.message); }
  }, 15000);
  try {
    await client.session.wait({ sessionID: root.id }, { signal: AbortSignal.timeout(660_000) });
    // A background launch ends one root turn, not the Mission or its final parent delivery.
    const missionPath = join(project, '.sortie-dogs-v010/missions', hash(root.id) + '.json');
    while (!limitReason) {
      let mission;
      try { mission = JSON.parse(await readFile(missionPath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const infos = (await client.session.list({ directory: project, limit: 50 })).data;
      const histories = await Promise.all(infos.map(i => client.session.export({ sessionID: i.id })));
      const rootInfo = infos.find(i => i.id === root.id);
      const allIdle = histories.every(h => {
        const last = h.messages.filter(m => m.type === 'assistant').at(-1);
        return last && last.time?.completed && h.info.time?.idle >= last.time.completed &&
          !(last.content ?? []).some(p => p.type === 'tool' && ['pending', 'running'].includes(p.state?.status));
      }) && rootInfo?.time?.idle >= Math.max(...infos.map(i => i.time?.idle ?? Infinity));
      const terminal = mission?.phase === 'completed' || mission?.phase === 'cancelled' ||
        mission?.phase === 'submitted' && ['blocked', 'needs-decision'].includes(mission.submission?.status);
      if (terminal && allIdle) break;
      if (Date.now() - start > 660_000) throw new Error('Native settlement is not observed; use collect, never relaunch');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  finally { clearInterval(monitor); await save('terminal.json', { ended_at: new Date().toISOString(), limit_reason: limitReason }); }
}

if (mode === 'run' || mode === 'collect') {
  const launch = await json('launch.json');
  const sessions = (await client.session.list({ directory: project, limit: 50 })).data;
  const histories = await Promise.all(sessions.map(info => client.session.export({ sessionID: info.id })));
  await save('native-history.json', histories);
  const root = histories.find(h => h.info.id === launch.root);
  assert(root, 'Exact root history must remain available');
  const tools = histories.flatMap(h => h.messages.flatMap(m => (m.content ?? []).filter(p => p.type === 'tool')
    .map(p => ({ sessionID: h.info.id, messageID: m.id, ...p }))));
  const completions = tools.filter(p => p.name === 'sortie_v010_complete_mission').flatMap(p => {
    try { return [{ sessionID: p.sessionID, messageID: p.messageID, callID: p.id, value: JSON.parse(text(p.state?.content)) }]; } catch { return []; }
  });
  const finals = root.messages.filter(m => m.type === 'assistant' && m.finish === 'stop' && text(m.content).trim());
  const hostLabels = tools.flatMap(p => { try {
    const v = JSON.parse(text(p.state?.content)); return v.work_quantity_display ? [{ sessionID: p.sessionID,
      messageID: p.messageID, callID: p.id, label: v.work_quantity_display, scope_id: v.work_quantity?.scope_id }] : [];
  } catch { return []; } });
  const deliveredLabels = hostLabels.flatMap(x => {
    const h = histories.find(h => h.info.id === x.sessionID);
    const sourceIndex = h.messages.findIndex(m => m.id === x.messageID);
    const matches = h.messages.slice(sourceIndex + 1).filter(m => m.type === 'assistant' && text(m.content).includes(x.label));
    return matches.length ? [{ ...x, assistant_message_ids: matches.map(m => m.id) }] : [];
  });
  const models = histories.flatMap(h => h.messages.filter(m => m.type === 'assistant').map(m => ({ sessionID: h.info.id, agent: m.agent, model: m.model })));
  let usd = 0, unpriced = 0;
  for (const h of histories) for (const m of h.messages) if (m.type === 'assistant') {
    const t = m.tokens, p = estimateModelUsageCost({ providerID: m.model?.providerID, modelID: m.model?.id,
      uncachedInputTokens: t?.input, cacheReadTokens: t?.cache?.read, cacheWriteTokens: t?.cache?.write,
      outputTokens: t?.output, reasoningTokens: t?.reasoning });
    if (p.status === 'priced') usd += p.usd; else unpriced++;
  }
  const final = finals.at(-1), panel = completions.findLast(c => typeof c.value.return_report === 'string');
  const finalText = final ? text(final.content) : '';
  const occurrences = panel ? finalText.split(panel.value.return_report).length - 1 : 0;
  const observation = { root: launch.root, project, server_url: launch.server_url,
    root_state: await client.session.get({ sessionID: launch.root }), models: [...new Map(models.map(m => [m.sessionID + JSON.stringify(m.model), m])).values()],
    host_labels: hostLabels, delivered_labels: deliveredLabels, completions, final_message_id: final?.id ?? null,
    exact_return_report_occurrences: occurrences, priced_usd: usd, unpriced_requests: unpriced,
    collector_sha256: hash(await readFile(new URL(import.meta.url))),
    ui_verified: false, ui_note: 'Saved native messages only; root must inspect the normal WebUI. Model prose claiming display confirmation is not UI evidence.' };
  await save('observation.json', observation);
  await writeFile(join(output, 'final.md'), finalText);
  console.log(JSON.stringify({ root: launch.root, final_message_id: observation.final_message_id, delivered_labels: deliveredLabels,
    exact_return_report_occurrences: occurrences, priced_usd: usd, unpriced_requests: unpriced }));
}

if (mode === 'verify') {
  const o = await json('observation.json'), setup = await json('setup.json');
  assert.equal(hash(await readFile(setup.tgz)), setup.package_sha256);
  const logs = (await readFile(join(output, 'native-observer.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert(logs.some(l => l.kind === 'loaded' && l.directory === project && l.host === setup.host.version));
  assert(o.models.length > 0 && o.models.every(m => m.model?.providerID === 'openai' && m.model?.id === 'gpt-6.1-sol'));
  assert(o.completions.some(c => c.value.status === 'succeeded' || c.value.phase === 'completed' || c.value.receipt?.status === 'succeeded'));
  assert.equal(o.exact_return_report_occurrences, 1, 'Formal host return_report must be copied once byte-for-byte');
  const n = a => Number(/(\d+)%/u.exec(a.label)?.[1]);
  assert(o.delivered_labels.some((a, i, all) => all.some((b, j) => i !== j && a.scope_id === b.scope_id &&
    a.sessionID === b.sessionID && n(a) > 0 && n(a) < 100 && n(b) > 0 && n(b) < 100 && n(a) !== n(b))),
    'Two different intermediate whole-request labels must follow their host results in ordinary native assistant text of the same session/Mission');
  const final = await readFile(join(output, 'final.md'), 'utf8');
  assert(final.includes('TACTICAL DESK / 作戦卓'));
  assert((await readFile(join(project, 'delivery-observation.md'), 'utf8')).includes('未修復'));
  console.log('Native delivery verified; real UI rendering remains a separate root observation.');
}
