import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { OperatorRuntime } from '../../dist/core/operator-runtime.js';
import { OperatorMissionRuntime } from '../../dist/core/operator-mission.js';
import { V010_RUNTIME_PROFILE } from '../../dist/core/runtime-profile.js';
import { SortieDogsV010Plugin } from '../../dist/plugin/profiled.js';

const execOperationCaseProbe = promisify(execFile);

test('Windows Mission operation admission and recovery share case-insensitive cwd identity', async () => {
  await mkdir(resolve('_testenv'), { recursive: true });
  const directory = await mkdtemp(resolve('_testenv/windows-operation-case-'));
  const identities: Record<string, object> = { root: { agent: 'dog-operator' },
    worker: { agent: 'dog-worker-v010', parentID: 'root', time: { created: Date.now() } } };
  const history: Record<string, object[]> = {};
  const create = () => SortieDogsV010Plugin({ directory, client: { session: {
    get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...identities[path.id] } }),
    messages: async ({ path }: { path: { id: string } }) => ({ data: history[path.id] ?? [] }),
    children: async () => ({ data: [] }), abort: async () => ({ data: true }),
  } } } as never);
  let hooks = await create();
  const chat = (sessionID: string, agent: string, text: string) => hooks['chat.message']!({ sessionID, agent, messageID: `${sessionID}-prompt` }, {
    message: { id: `${sessionID}-prompt`, agent, model: { providerID: 'openai', modelID: 'gpt-6-sol' } }, parts: [{ type: 'text', text }],
  });
  try {
    await execOperationCaseProbe('git', ['init', '--quiet'], { cwd: directory });
    await writeFile(join(directory, 'check.mjs'), 'console.log("case probe");\n');
    await chat('root', 'dog-operator', 'Run this operation once and retain its native result.');
    const started = JSON.parse(await hooks.tool!.sortie_v010_start_mission.execute({ requirements: ['Collect the native operation result'], kind: 'operation',
      execution: { commands: ['node check.mjs'], directory }, unit: { title: 'Case probe', objective: 'Collect the native result',
        read: ['check.mjs'], write: ['result.txt'], validation: ['node check.mjs'] } }, { sessionID: 'root' }));
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: 'root', callID: 'case-worker' }, { args: structuredClone(started.task) });
    await chat('worker', 'dog-worker-v010', started.task.prompt);
    const run = await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required('root'), unit = run.units[0]!;
    const read = { tool: 'read', sessionID: 'worker', callID: 'case-handoff', args: { filePath: unit.handoffPath } };
    await hooks['tool.execute.before']!(read, { args: read.args });
    await hooks['tool.execute.after']!(read, { output: 'inspected' });
    await hooks.tool!.sortie_v010_bind_write_gate.execute({ project_root: directory, manifest_path: unit.manifestPath }, { sessionID: 'worker' });
    const args = { command: 'node check.mjs', workdir: directory.toLowerCase() };
    await hooks['tool.execute.before']!({ tool: 'shell', sessionID: 'worker', callID: 'case-live' }, { args });
    const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
    assert.equal((await missions.required('root')).execution!.observations.length, 1, 'native casing still admits the same operation');
    const checked = await execOperationCaseProbe(process.execPath, ['check.mjs'], { cwd: directory });
    await hooks['tool.execute.after']!({ tool: 'shell', sessionID: 'worker', callID: 'case-live', args }, { output: checked.stdout, metadata: { status: 'completed', exit: 0 } });
    const start = Date.now();
    history.worker = [{ info: { role: 'assistant', sessionID: 'worker' }, parts: [{ type: 'tool', tool: 'shell', callID: 'case-recovered',
      state: { status: 'completed', input: { command: 'node check.mjs', workdir: directory.toUpperCase() }, output: checked.stdout,
        metadata: { status: 'completed', exit: 0 }, time: { start, end: start + 1 } } }] }];
    hooks = await create();
    const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: 'root' }));
    assert.equal(status.acceptance_summary.operation.status, 'executed');
    assert.deepEqual(status.acceptance_summary.operation.observations.map((item: { callID: string }) => item.callID), ['case-live', 'case-recovered']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
