import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

// Fresh process per installed version; identical persisted caller settings.
const [installed, project, mode] = process.argv.slice(2);
const { SortieDogsV010Plugin } = await import(pathToFileURL(path.join(installed, 'dist/plugin/profiled.js')));
const sessionID = 'reflection-migration';
const context = { sessionID, agent: 'dog-operator' };
const client = { session: {
  get: async () => ({ data: { agent: 'dog-operator' } }),
  children: async () => ({ data: [] }), messages: async () => ({ data: [] }),
} };
const hooks = await SortieDogsV010Plugin({ directory: project, client });
await hooks['chat.message']({ sessionID, messageID: 'reflection-migration-user', agent: 'dog-operator' }, {
  message: { agent: 'dog-operator', model: { providerID: 'fixture', modelID: 'no-inference' } },
  parts: [{ type: 'text', text: 'Retain the existing process prevention reminder.' }],
});
const reflect = hooks.tool.sortie_v010_reflection.execute;
const input = { action: 'record', layer: 'project', scope: 'migration-recovery',
  trigger: 'Interrupted work must resume without duplicate dispatch.', cause: 'Recreating a run loses continuity.',
  prevention: 'Resume the retained run and preserve cumulative consumption.',
  evidence: 'user-correction', evidenceRef: 'migration-fixture' };
if (mode === 'seed') {
  const first = JSON.parse(await reflect(input, context));
  const second = JSON.parse(await reflect(input, context));
  assert.equal(first.id, second.id);
  assert.equal(second.hits, 2);
}
const bucket = JSON.parse(await reflect({ action: 'list', layer: 'project' }, context));
assert.equal(bucket.entries.length, 1);
assert.equal(bucket.entries[0].hits, 2);
assert.equal(bucket.entries[0].prevention, input.prevention);
const output = { system: [] };
await hooks['experimental.chat.system.transform']({ sessionID }, output);
const injected = output.system.filter(s => s.includes('SORTIE_PROCESS_REFLECTIONS'));
assert.equal(injected.length, 1);
assert.ok(injected[0].includes(bucket.entries[0].id));
assert.ok(injected[0].includes(input.prevention));
process.env.SORTIE_REFLECTION = '0';
await hooks['experimental.chat.system.transform']({ sessionID }, output);
assert.ok(!output.system.some(s => s.includes('SORTIE_PROCESS_REFLECTIONS')));
assert.equal(await reflect({ action: 'list', layer: 'project' }, context), 'reflection_not_permitted');
delete process.env.SORTIE_REFLECTION;
await hooks['experimental.chat.system.transform']({ sessionID }, output);
assert.ok(output.system.some(s => s.includes(input.prevention)));
const memory = await fs.readFile(path.join(project, '.opencode/sortie-dogs.json'), 'utf8');
console.log(JSON.stringify({ bucket, injected, kill_switch: true, reenabled: true, settings: JSON.parse(memory), model_calls: 0 }));
