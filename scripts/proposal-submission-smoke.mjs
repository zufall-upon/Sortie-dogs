// Small real-CLI submission/return smoke. Run inside a WSL login shell.
// Usage: node scripts/proposal-submission-smoke.mjs <tgz> <fixture-dir> <USD-stop-threshold>
// Only typed receipts are saved. The host DB is read-only; never edit a live session.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { command, installedFixture } from './release-cli.mjs';
import { estimateModelUsageCost } from '../dist/plugin/model-cost.js';

const [tarball, destination, threshold] = process.argv.slice(2);
assert(process.platform !== 'win32', 'Use WSL bash -ic.');
assert(tarball && destination && Number(threshold) > 0, 'Supply tgz, fixture directory and finite USD stop threshold.');
assert(Number.isFinite(Number(threshold)));
const fixture = await installedFixture(resolve(tarball), resolve(destination), 'beta-v010');
const { project, control, env } = fixture;
const hash = value => createHash('sha256').update(value).digest('hex');
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
const verifier = 'import assert from "node:assert/strict";import{readFile}from"node:fs/promises";assert.equal(await readFile("result.txt","utf8"),"ready\\n");\n';
await writeFile(join(project, 'verify.mjs'), verifier);
await writeFile(join(project, 'result.txt'), 'pending\n');
await writeFile(join(project, '.gitignore'), '.opencode/\n.sortie-dogs-v010/\n');
await writeFile(join(project, 'AGENTS.md'), '# Submission smoke\nOnly result.txt may be edited. Preserve verify.mjs. No commits or external changes.\n');
const config = await readJSON(join(control, 'opencode.json'));
config.agent = { 'dogs-coordinator': { model: 'openai/gpt-5.6-terra', variant: 'low' } };
await writeFile(join(control, 'opencode.json'), JSON.stringify(config, null, 2));
await command('git', ['init', '-q', '-b', 'main'], project, env);
await command('git', ['add', '--', 'AGENTS.md', '.gitignore', 'verify.mjs', 'result.txt'], project, env);
await command('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
  '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Seed submission fixture'], project, env);
const intent = { schema_version: '0.1',
  original_request: { text: 'Write ready followed by a newline to result.txt. Preserve verify.mjs and pass node verify.mjs.', source_ref: 'user:fixture' },
  requirements: [
    { id: 'R1', text: 'result.txt contains ready followed by a newline', kind: 'requirement' },
    { id: 'N1', text: 'Preserve verify.mjs', kind: 'negative' },
    { id: 'Q1', text: 'node verify.mjs passes', kind: 'quality' },
  ], authoritative_refs: ['user:fixture', 'verify.mjs'], allow_read: ['verify.mjs', 'result.txt'],
  proposal_budget: { max_reads: 6, max_submissions: 3 } };
const dbPath = join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'opencode/opencode.db');
function inspect() {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const sessions = db.prepare('SELECT id, parent_id FROM session WHERE directory=?').all(project);
    let usd = 0, unpriced = 0;
    const models = new Set();
    for (const session of sessions) for (const row of db.prepare('SELECT data FROM message WHERE session_id=?').all(session.id)) {
      const m = JSON.parse(row.data);
      if (m.role !== 'assistant') continue;
      const t = m.tokens;
      // A usage-less in-flight placeholder is not a priced request. Stop on an unknown priced identity.
      if (!t) continue;
      const estimate = estimateModelUsageCost({ providerID: m.providerID, modelID: m.modelID,
        uncachedInputTokens: t.input, cacheReadTokens: t.cache?.read, cacheWriteTokens: t.cache?.write,
        outputTokens: t.output, reasoningTokens: t.reasoning });
      models.add(`${m.agent}/${m.providerID}/${m.modelID}/${m.variant ?? 'unreported'}`);
      if (estimate.status === 'priced') usd += estimate.usd;
      else if (m.time?.completed) unpriced++;
    }
    return { sessions, usd, unpriced, models: [...models] };
  } finally { db.close(); }
}
let stopped = null, monitorError = null;
const started = Date.now();
const child = spawn('opencode', ['run', '--dir', project, '--format', 'json', '--print-logs',
  '--agent', 'dog-operator', '--model', 'openai/gpt-6-astra', '--variant', 'low',
  'Begin the exact proposal intent below and dispatch its returned Task unchanged. The proposal child returns after submission. ' +
  'Compare the submitted proposal with the requirements and observed verifier; approve only if they match. ' +
  'Dispatch the returned worker, then explicitly complete the operator after canonical validation. No reset or repeated investigation. goal_budget_units: 3\n' + JSON.stringify(intent)],
{ cwd: project, env: { ...process.env, ...env, PWD: project }, detached: true, stdio: 'ignore' });
const stop = reason => {
  if (stopped) return;
  stopped = reason;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
};
const timer = setTimeout(() => stop('wall-time-limit'), 600_000);
const monitor = setInterval(() => {
  try {
    const usage = inspect();
    if (usage.usd >= Number(threshold)) stop('estimated-cost-limit');
    if (usage.unpriced) stop('pricing-coverage-missing');
  } catch (error) { monitorError = error.code ?? error.name; stop('cost-monitor-failed'); }
}, 1000);
let exit;
try { exit = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit); }); }
finally { clearTimeout(timer); clearInterval(monitor); }
const usage = inspect();
const root = usage.sessions.find(session => session.parent_id === null)?.id;
assert(root, 'No native root session was created.');
const proposal = await readJSON(join(project, '.sortie-dogs-v010/operator-proposals', `${hash(root)}.json`));
const operator = await readJSON(join(project, '.sortie-dogs-v010/operators', `${hash(root)}.json`)).catch(() => null);
const db = new DatabaseSync(dbPath, { readOnly: true });
let proposalTools;
try { proposalTools = db.prepare('SELECT data FROM part WHERE session_id=? ORDER BY time_created').all(proposal.proposal_session_id)
  .map(row => JSON.parse(row.data)).filter(part => part.type === 'tool'); } finally { db.close(); }
const afterSubmit = proposalTools.slice(proposalTools.findLastIndex(part => part.tool.endsWith('submit_operator_proposal')) + 1);
const report = { package_version: fixture.pkg.version, runtime_marker: fixture.runtimeMarker,
  package_sha256: hash(await readFile(resolve(tarball))), elapsed_ms: Date.now() - started, exit, stopped, monitorError,
  estimated_usd: usage.usd, unpriced: usage.unpriced, models: usage.models, root,
  proposal_reads: proposal.read_count, proposal_submissions: proposal.submission_count,
  after_submission_tools: afterSubmit.map(part => part.tool),
  operator_phase: operator?.phase ?? null, worker_status: operator?.units.map(unit => unit.status) ?? null,
  verifier_preserved: await readFile(join(project, 'verify.mjs'), 'utf8') === verifier,
  result: await readFile(join(project, 'result.txt'), 'utf8') };
await writeFile(join(resolve(destination), 'receipt.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
assert.equal(stopped, null);
assert.equal(exit, 0);
assert.equal(operator?.phase, 'completed');
assert(operator.units.every(unit => unit.status === 'succeeded'));
assert.deepEqual(afterSubmit, []);
assert(report.verifier_preserved);
assert.equal(report.result, 'ready\n');
