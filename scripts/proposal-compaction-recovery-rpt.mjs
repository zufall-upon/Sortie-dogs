// Bounded real-CLI regression: fail before the fix, then resume the same proposal
// child and root in the same fixture with the candidate package. No raw logs saved.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { command, installedFixture } from './release-cli.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const events = text => text.split(/\r?\n/u).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const dbFile = join(process.env.XDG_DATA_HOME ?? join(os.homedir(), '.local/share'), 'opencode/opencode.db');
function history(id) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return db.prepare('SELECT data FROM part WHERE session_id=? ORDER BY time_created').all(id).map(row => JSON.parse(row.data));
  } finally { db.close(); }
}
async function cli(project, env, agent, prompt, session) {
  return events(await command('timeout', ['--signal=TERM', '--kill-after=10s', '720s', 'opencode', 'run',
    '--dir', project, '--format', 'json', '--print-logs', '--agent', agent,
    '--model', agent === 'dogs-coordinator' ? 'openai/gpt-5.6-terra' : 'openai/gpt-5.6-sol',
    '--variant', 'low', ...(session ? ['--session', session] : []), prompt], project, env, 750_000));
}
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
const statePath = (project, root) => join(project, '.sortie-dogs-v010/operator-proposals', `${hash(root)}.json`);

async function resumeChild(project, env, child, prompt) {
  // `opencode run --agent <subagent>` falls back to the primary build agent.
  // Use the native prompt endpoint for the already-parented child instead.
  const server = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: project, detached: true, env: { ...process.env, ...env, PWD: project, OPENCODE_SERVER_PASSWORD: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const base = await new Promise((resolveURL, reject) => {
      const timer = setTimeout(() => reject(Error('fixture server startup timeout')), 30000);
      let text = '';
      const inspect = chunk => {
        text = (text + chunk.toString()).slice(-4096);
        const match = /http:\/\/127\.0\.0\.1:\d+/u.exec(text);
        if (match) { clearTimeout(timer); resolveURL(match[0]); }
      };
      server.stdout.on('data', inspect); server.stderr.on('data', inspect);
      server.once('error', error => { clearTimeout(timer); reject(error); });
      server.once('exit', code => { clearTimeout(timer); reject(Error(`fixture server exited ${code}`)); });
    });
    const response = await fetch(`${base}/session/${child}/message?directory=${encodeURIComponent(project)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(720000),
      body: JSON.stringify({ agent: 'dogs-coordinator', model: { providerID: 'openai', modelID: 'gpt-5.6-terra' }, variant: 'low',
        parts: [{ type: 'text', text: prompt }] }),
    });
    assert(response.ok, `native child resume HTTP ${response.status}`);
    const result = await response.json();
    assert(!result.info?.error, `native child resume failed: ${result.info?.error?.name}`);
  } finally {
    try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already exited */ }
  }
}

async function before(tgz, directory) {
  const fixture = await installedFixture(tgz, directory, 'beta-v010');
  const { project, control, env } = fixture;
  await writeFile(join(project, '.gitignore'), '.opencode/\n.sortie-dogs-v010/\n');
  await writeFile(join(project, 'AGENTS.md'), '# Proposal compaction fixture\nOnly result.txt is writable. No commit, external access, or changes to validators.\n');
  const source = 'export const expected = "ready";\n' + Array.from({ length: 7000 }, (_, i) =>
    `// Fixture node ${i}: ${hash(String(i))}`).join('\n') + '\n';
  await writeFile(join(project, 'source.mjs'), source);
  await writeFile(join(project, 'verify.mjs'), 'import assert from "node:assert/strict";import{readFile}from"node:fs/promises";assert.equal(await readFile("result.txt","utf8"),"ready\\n");\n');
  await writeFile(join(project, 'result.txt'), 'pending\n');
  const config = await readJSON(join(control, 'opencode.json'));
  // Use native provider thresholds. Some hosts override configured model limits;
  // large anonymous fixture comments exercise compaction without altering usage.
  config.agent = { 'dogs-coordinator': { model: 'openai/gpt-5.6-terra', variant: 'low' } };
  config.compaction = { auto: true, prune: false, preserve_recent_tokens: 0, tail_turns: 0 };
  config.tool_output = { max_lines: 3000, max_bytes: 250000 };
  await writeFile(join(control, 'opencode.json'), JSON.stringify(config, null, 2));
  await command('git', ['init', '-q', '-b', 'main'], project, env);
  await command('git', ['add', '--', 'AGENTS.md', '.gitignore', 'source.mjs', 'verify.mjs', 'result.txt'], project, env);
  await command('git', ['-c', 'user.name=Sortie Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Seed proposal compaction fixture'], project, env);
  const intent = { schema_version: '0.1', original_request: { text: 'Write ready followed by a newline to result.txt. Preserve source.mjs and verify.mjs.', source_ref: 'user:fixture' },
    requirements: [{ id: 'R1', text: 'result.txt contains ready followed by a newline', kind: 'requirement' },
      { id: 'N1', text: 'Preserve source.mjs and verify.mjs', kind: 'negative' }],
    authoritative_refs: ['user:fixture', 'source.mjs', 'verify.mjs'], allow_read: ['source.mjs', 'verify.mjs', 'result.txt'],
    proposal_budget: { max_reads: 45, max_submissions: 4 } };
  // This is test input, not an extra rule in the production canonical Task.
  intent.requirements.push({ id: 'Q1', text: 'Investigation first reads all 7001 source.mjs lines, continuing after truncation. After finishing the source scan, Read verify.mjs in a separate tool round, then Read result.txt in another separate round before submitting. Run node verify.mjs after editing result.txt.', kind: 'quality' });
  const output = await cli(project, env, 'dog-operator',
    `Use this exact bounded investigation intent with sortie_v010_begin_operator_proposal, then dispatch its returned Task unchanged. ` +
    `Do not investigate source yourself or bypass proposal. If Task fails, report the failure and stop; do not retry or reset. goal_budget_units: 2\n${JSON.stringify(intent)}`);
  const root = output.find(event => event.sessionID)?.sessionID;
  assert(root, 'root session missing');
  const state = await readJSON(statePath(project, root));
  const child = state.proposal_session_id;
  assert(child, 'proposal child missing');
  const parts = history(child), parent = history(root);
  const failures = parent.filter(p => p.tool === 'task' && p.state?.status === 'error').map(p => p.state.error);
  const report = { root, child, project, env, package_version: fixture.pkg.version, runtime_marker: fixture.runtimeMarker,
    package_sha256: hash(await readFile(tgz)), compactions: parts.filter(p => p.type === 'compaction').length,
    phase: state.phase, reads: state.read_count, submissions: state.submission_count, failures,
    immutable_hash: hash(JSON.stringify([state.intent, state.intent_hash, state.goal_binding, state.proposal_call_id, state.proposal_session_id])) };
  await writeFile(join(directory, 'checkpoint.json'), JSON.stringify(report, null, 2));
  assert(report.compactions > 0, 'native auto compaction was not exercised');
  assert(failures.includes('operator-run-missing'), 'expected pre-fix proposal compaction failure missing');
  assert.equal(state.phase, 'investigating');
  console.log(JSON.stringify({ phase: 'before', ...report, env: undefined }));
}

async function after(tgz, directory) {
  const checkpoint = await readJSON(join(directory, 'checkpoint.json'));
  const { project, env, root, child } = checkpoint;
  const control = join(project, '.opencode'), installed = join(control, 'node_modules/sortie-dogs');
  const dependency = `file:${relative(control, tgz)}`;
  const config = await readJSON(join(control, 'package.json'));
  config.dependencies['sortie-dogs'] = dependency;
  await writeFile(join(control, 'package.json'), JSON.stringify(config, null, 2));
  await command('npm', ['install', '--force'], control, env);
  assert.equal((await readJSON(join(control, 'package.json'))).dependencies['sortie-dogs'], dependency);
  assert.equal((await lstat(installed)).isSymbolicLink(), false);
  const lock = await readJSON(join(control, 'package-lock.json'));
  assert.equal(lock.packages['node_modules/sortie-dogs'].link, undefined);
  assert.equal(typeof lock.packages['node_modules/sortie-dogs'].integrity, 'string');
  await command('node', [join(installed, 'dist/cli/main.js'), 'init', project, '--profile', 'v010'], project, env);
  const { OperatorProposalRuntime } = await import(pathToFileURL(join(installed, 'dist/core/operator-proposal.js')));
  const { V010_RUNTIME_PROFILE } = await import(pathToFileURL(join(installed, 'dist/core/runtime-profile.js')));
  const runtime = new OperatorProposalRuntime(project, V010_RUNTIME_PROFILE);
  const prior = await runtime.required(root);
  assert.equal(hash(JSON.stringify([prior.intent, prior.intent_hash, prior.goal_binding, prior.proposal_call_id, prior.proposal_session_id])), checkpoint.immutable_hash);
  // Native same-child session resume, NOT a replacement root Task/admission.
  // Exact reference proves the existing child claim; no durable state is edited.
  await resumeChild(project, env, child, runtime.referenceTask(prior).prompt);
  const submitted = await readJSON(statePath(project, root));
  assert.equal(submitted.phase, 'submitted', 'same proposal child did not submit');
  assert.equal(submitted.proposal_session_id, child);
  assert(submitted.read_count >= prior.read_count && submitted.submission_count >= prior.submission_count);
  const approval = { proposal_id: submitted.proposal_id, revision: submitted.proposal_revision, content_hash: submitted.proposal_hash,
    compared_requirement_ids: submitted.intent.requirements.map(item => item.id), decision: 'approve',
    rationale: 'The fixture result, protected inputs, full investigation read and canonical verifier are preserved.' };
  await cli(project, env, 'dog-operator', `Resume the existing goal. The same admitted proposal child submitted after compaction recovery. ` +
    `Call sortie_v010_operator_status, compare its proposal with the original fixture requirements and observed verifier. If it matches, approve using this exact packet: ${JSON.stringify(approval)}. ` +
    'Dispatch the returned worker Task unchanged. After canonical validation, call sortie_v010_complete_operator. No cancellation, new proposal, budget reset, or commit.', root);
  const operator = await readJSON(join(project, '.sortie-dogs-v010/operators', `${hash(root)}.json`));
  const parts = history(child);
  const summaries = parts.filter(p => p.type === 'text' && /summary|context|proposal|compaction/iu.test(p.text ?? ''));
  const db = new DatabaseSync(dbFile, { readOnly: true });
  let summaryMessages;
  try { summaryMessages = db.prepare('SELECT data FROM message WHERE session_id=?').all(child)
    .map(row => JSON.parse(row.data)).filter(message => message.summary === true).length; }
  finally { db.close(); }
  const versions = await import(pathToFileURL(join(installed, 'dist/asset-version.js')));
  const report = { phase: 'after', root, child, package_version: (await readJSON(join(installed, 'package.json'))).version,
    package_sha256: hash(await readFile(tgz)), runtime_marker: versions.V010_RUNTIME_ASSET_VERSION,
    same_fixture: true, same_child: submitted.proposal_session_id === checkpoint.child, summary_messages: summaryMessages,
    summary_texts: summaries.length, proposal_phase: submitted.phase, reads: submitted.read_count, submissions: submitted.submission_count,
    operator_phase: operator.phase, worker_status: operator.units.map(unit => unit.status),
    result: await readFile(join(project, 'result.txt'), 'utf8') };
  await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2));
  assert(summaryMessages > 0, 'native compaction summary missing');
  assert.equal(operator.phase, 'completed');
  assert(operator.units.every(unit => unit.status === 'succeeded'));
  assert.equal(report.result, 'ready\n');
  console.log(JSON.stringify(report));
}

const [mode, tarball, destination] = process.argv.slice(2);
assert(process.platform !== 'win32', 'Run inside WSL login shell, not Windows npm');
assert(['before', 'after'].includes(mode) && tarball && destination, 'Usage: before|after tarball fixture-directory');
const directory = resolve(destination);
await mkdir(directory, { recursive: true });
try { await (mode === 'before' ? before : after)(resolve(tarball), directory); }
catch (error) {
  const processResult = error?.processResult;
  console.error(JSON.stringify({ error: error.message, exit: processResult?.code,
    diagnostics: processResult ? (processResult.stdout + '\n' + processResult.stderr).split(/\r?\n/u)
      .filter(line => /Error:|ConfigInvalid|operator-run-missing|not found/u.test(line)).map(line => line.slice(0, 300)).slice(0, 8) : undefined }));
  process.exitCode = 1;
}
