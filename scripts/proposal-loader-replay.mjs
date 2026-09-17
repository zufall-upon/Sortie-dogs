// Deterministic replay of a legacy hook rejecting a current proposal tool's Task.
// Supply the preserved legacy package entry; no model calls or live-session writes.
// Usage: node scripts/proposal-loader-replay.mjs <legacy/dist/plugin/opencode.js>
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const legacyEntry = process.argv[2];
assert(legacyEntry, 'Supply the legacy package plugin entry as the only argument.');
const area = resolve('_testenv');
await mkdir(area, { recursive: true });
const project = await mkdtemp(join(area, 'proposal-loader-replay-'));
const originalConfig = process.env.OPENCODE_CONFIG_DIR;
process.env.OPENCODE_CONFIG_DIR = join(project, 'isolated-global');
const rootID = 'loader-replay-root';
const digest = value => createHash('sha256').update(value).digest('hex');
try {
  await promisify(execFile)('git', ['init', '--quiet'], { cwd: project });
  await mkdir(join(project, 'src'));
  const [{ SortieDogsPlugin: currentPlugin }, { SortieDogsPlugin: legacyPlugin }] = await Promise.all([
    import('../dist/plugin/opencode.js'), import(pathToFileURL(resolve(legacyEntry)).href),
  ]);
  const input = { directory: project, client: { session: {
    get: async ({ path }) => ({ data: path.id === rootID ? { agent: 'dog-operator' }
      : { agent: 'dogs-coordinator', parentID: rootID } }),
    messages: async () => ({ data: [] }),
  } } };
  const current = await currentPlugin(input);
  const legacy = await legacyPlugin(input);
  assert.equal(legacy.tool.sortie_v010_begin_operator_proposal, undefined,
    'The historical hook must predate proposal support.');
  const model = { providerID: 'openai', modelID: 'gpt-6-astra' };
  for (const hooks of [legacy, current]) {
    await hooks['chat.message']({ sessionID: rootID, messageID: 'user-replay', agent: 'dog-operator', model }, {
      message: { agent: 'dog-operator', model: { ...model } },
      parts: [{ type: 'text', text: 'Investigate the existing source.\ngoal_budget_units: 2' }],
    });
  }
  const intent = { schema_version: '0.1',
    original_request: { text: 'Investigate the existing source.', source_ref: 'user:replay' },
    requirements: [{ id: 'R1', text: 'Investigate the existing source.', kind: 'requirement' }],
    authoritative_refs: ['user:replay'], allow_read: ['src'],
    proposal_budget: { max_reads: 4, max_submissions: 2 } };
  const started = JSON.parse(await current.tool.sortie_v010_begin_operator_proposal.execute(
    { intent_json: JSON.stringify(intent) }, { sessionID: rootID }));
  const statePath = join(project, '.sortie-dogs-v010/operator-proposals', `${digest(rootID)}.json`);
  const ledgerPath = join(project, '.git/sortie-dogs/run-flight-v010', `${digest(`v010\0${rootID}`)}.json`);
  const before = await readFile(statePath, 'utf8');
  const ledgerBefore = await readFile(ledgerPath, 'utf8');
  const taskArgs = structuredClone(started.task);
  let rejected;
  try {
    // OpenCode keeps each plugin's before hook even when the tool map comes from a later plugin.
    for (const hooks of [legacy, current]) await hooks['tool.execute.before'](
      { tool: 'task', sessionID: rootID, callID: 'mixed-dispatch' }, { args: taskArgs });
    assert.fail('The mixed loader must reject before native Task execution.');
  } catch (error) {
    assert.equal(error.message, 'operator-run-missing');
    rejected = error;
  }
  assert.equal(await readFile(statePath, 'utf8'), before);
  assert.equal(await readFile(ledgerPath, 'utf8'), ledgerBefore);
  assert.deepEqual(taskArgs, started.task);
  const status = JSON.parse(await current.tool.sortie_v010_operator_status.execute({}, { sessionID: rootID }));
  assert.equal(status.proposal.status, 'investigating');
  assert.equal(status.proposal.task_admitted, false);

  // A cold single-loader instance accepts that same durable grant/reference. No reset or rewrite.
  const restarted = await currentPlugin(input);
  await restarted['tool.execute.before']({ tool: 'task', sessionID: rootID, callID: 'single-dispatch' },
    { args: structuredClone(started.task) });
  const admitted = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(admitted.root_session_id, rootID);
  assert.equal(admitted.proposal_call_id, 'single-dispatch');
  assert.equal(admitted.intent_hash, JSON.parse(before).intent_hash);
  assert.equal(admitted.read_count, 0);
  assert.equal(admitted.submission_count, 0);
  const child = { message: { agent: 'dogs-coordinator', model: { providerID: 'openai', modelID: 'gpt-5.6-terra' } },
    parts: [{ type: 'text', text: started.task.prompt }] };
  await restarted['chat.message']({ sessionID: 'loader-replay-child', messageID: 'child-replay', agent: 'dogs-coordinator' }, child);
  assert.match(child.parts[0].text, /^SORTIE_OPERATOR_PROPOSAL /u);
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).proposal_session_id, 'loader-replay-child');
  await restarted['tool.execute.after']({ tool: 'task', sessionID: rootID, callID: 'single-dispatch' },
    { output: 'Replay ends before model execution.' });
  console.log(JSON.stringify({
    legacy_entry: basename(legacyEntry), legacy_entry_sha256: digest(await readFile(legacyEntry)),
    legacy_hook_sha256: digest(await readFile(join(dirname(legacyEntry), 'profiled.js'))),
    current_hook_sha256: digest(await readFile(new URL('../dist/plugin/profiled.js', import.meta.url))),
    mixed_loader: rejected.message, rejection_stack: rejected.stack.split('\n').slice(1, 4)
      .map(line => line.trim().replace(/\s+\(.*$/u, '')),
    proposal_state_preserved: true, budget_preserved_on_rejection: true,
    cold_single_loader: 'same-reference-admitted-and-child-bound', model_calls: 0,
  }, null, 2));
} finally {
  if (originalConfig === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = originalConfig;
  await rm(project, { recursive: true, force: true });
}
