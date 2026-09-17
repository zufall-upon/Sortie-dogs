import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { command, installedFixture } from './release-cli.mjs';
import { shellQuote } from './release-process.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = join(root, '_testenv');
const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const hash = value => createHash('sha256').update(value).digest('hex');
const events = value => value.split(/\r?\n/u).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });

function plan() {
  const validation = 'node verify-result.mjs';
  return { schema_version: '0.1', acceptance: ['Registered result is complete', 'Validator remains unchanged'],
    acceptance_proof: [['result'], ['result']], source_refs: ['fixture:anonymous-compaction-order'],
    goal_declaration: { delivery_intent: 'implementation', delivery_mode: 'mvp-first', usable_path_established: false,
      controlled_change: false, goal_budget_units: 3, defaults: { target: 'anonymous compacted task', entrypoint: 'verify-result.mjs',
        workload: 'one registered unit across compaction', oracle_coverage: ['immutable content oracle'], build_boundary: 'not-applicable',
        source: 'anonymous source', candidate: 'anonymous candidate', source_binding: 'current-protected', candidate_binding: 'current-protected',
        fixture: 'operator-compaction-rpt', proof_scope: 'requested-full', expected_outcome: 'pass' },
      criteria: [{ criterion_id: 'result', validation_command: validation }] },
    units: [{ id: 'compacted-unit', title: 'Complete registered compacted unit',
      objective: 'Use apply_patch to replace pending with compacted-complete in result.txt. Run only the exact validation. Preserve verify-result.mjs.',
      read: ['result.txt', 'verify-result.mjs'], write: ['result.txt'], validation: [validation], acceptance_indices: [0, 1] }] };
}

async function targeted() {
  const commands = [
    [process.execPath, [npmCli, '--prefix', root, 'run', 'build']],
    ['node', ['--experimental-strip-types', '--import', pathToFileURL(join(root, 'test/setup.ts')).href, '--test', '--test-concurrency=1',
      join(root, 'test/v010-runtime.test.ts'), join(root, 'test/continuation.test.ts'), join(root, 'test/initialize.test.ts'), join(root, 'test/plugin-loader.test.ts')]],
  ];
  const evidence = [];
  for (const [executable, args] of commands) {
    try { await command(executable, args, root, {}, 1_200_000); }
    catch (error) {
      const output = error?.processResult;
      const bounded = `${output?.stdout ?? ''}\n${output?.stderr ?? ''}`.split(/\r?\n/u)
        .filter(line => /^(?:not ok|\s*(?:error:|code:|expected:|actual:))|AssertionError|ERR_|operator-/u.test(line)).slice(0, 24);
      console.error(JSON.stringify({ phase: 'targeted-failure', exit: output?.code ?? null, bounded }));
      throw error;
    }
    evidence.push({ command: [executable, ...args], exit: 0, fingerprint: hash(JSON.stringify([executable, ...args])) });
  }
  console.log(JSON.stringify({ schema: 1, artifact: 'operator-compaction-targeted', evidence }));
}

function hostObservation(sessionIDs) {
  const db = new DatabaseSync(join(process.env.XDG_DATA_HOME ?? join(os.homedir(), '.local/share'), 'opencode/opencode.db'), { readOnly: true });
  try {
    const query = db.prepare(`SELECT json_extract(data,'$.agent') agent,json_extract(data,'$.modelID') model,
      json_extract(data,'$.variant') variant,count(*) steps FROM message WHERE session_id=? AND json_extract(data,'$.role')='assistant' GROUP BY 1,2,3`);
    const models = [...new Set(sessionIDs.filter(Boolean))].flatMap(session => query.all(session).map(row => ({ session, ...row })));
    const texts = db.prepare(`SELECT json_extract(p.data,'$.text') text,json_extract(p.data,'$.synthetic') synthetic
      FROM part p JOIN message m ON m.id=p.message_id WHERE m.session_id=? AND json_extract(p.data,'$.type')='text'`).all(sessionIDs[0]);
    return { models, rollover_summaries: texts.filter(row => String(row.text ?? '').startsWith('SORTIE_ROLLOVER_COMPACTED')).length,
      durable_resumes: texts.filter(row => row.synthetic && String(row.text ?? '').includes('durable-operator-state') && String(row.text ?? '').includes('operator_status/operator_next')).length };
  } finally { db.close(); }
}

async function cliInside(tgz, directory) {
  const fixture = await installedFixture(tgz, directory, 'beta-v010');
  const { project, env, runtime, coordinatorAgent, workerAgent, reduceGoalFlight } = fixture;
  await writeFile(join(project, 'AGENTS.md'), '# Anonymous compaction fixture\nEdit only result.txt. Preserve validator. No commit, publish, global install, or alternate agent.\n');
  await writeFile(join(project, '.gitignore'), '.opencode/\n.sortie-dogs-v010/\n');
  await writeFile(join(project, 'result.txt'), 'pending\n');
  const validator = `import assert from'node:assert/strict';import{readFile}from'node:fs/promises';assert.equal((await readFile(new URL('./result.txt',import.meta.url),'utf8')).trim(),'compacted-complete');\n`;
  await writeFile(join(project, 'verify-result.mjs'), validator);
  const planPath = join(project, 'plan.json');
  await writeFile(planPath, JSON.stringify(plan()));
  await command('git', ['init', '-q', '-b', 'main'], project, env);
  await command('git', ['add', '--', 'AGENTS.md', '.gitignore', 'result.txt', 'verify-result.mjs'], project, env);
  await command('git', ['-c', 'user.name=Sortie Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Seed compaction fixture'], project, env);
  async function cli(prompt, session) {
    return events(await command('timeout', ['--signal=TERM', '--kill-after=10s', '1500s', 'opencode', 'run', '--dir', project,
      '--format', 'json', '--print-logs', '--agent', coordinatorAgent, '--model', 'openai/gpt-5.6-sol', '--variant', 'low',
      ...(session ? ['--session', session] : []), prompt], project, env, 1_540_000));
  }
  const opened = await cli('匿名compaction RPTを開始する。toolを呼ばずCOMPACTION_RPT_READYだけ返す。');
  const sessionID = opened.find(event => event.sessionID)?.sessionID;
  assert(sessionID, 'root session missing');
  const run = await cli(`${planPath} を読みsortie_v010_prepare_operatorへ一度だけ渡す。返却Task.promptがSORTIE_OPERATOR_TASK_REFで始まることを確認し、worker実行前にsortie_v010_compact_and_continueを呼ぶ。compaction後はsummary本文を正本にせず、durable checkpointに従ってsortie_v010_operator_statusとsortie_v010_operator_nextから同じrefを復元する。cancel/reprepareせず、そのref Taskを完全一致で一度だけ実行する。result.txtだけ変更し検証後、sortie_v010_complete_operatorを呼びreceipt.status=succeededで終える。`, sessionID);
  const statePath = join(project, runtime.stateDirectory, 'operators', `${hash(sessionID)}.json`);
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const ledgerPath = join(project, '.git/sortie-dogs', runtime.flightDirectory, `${hash(`${runtime.id}\u0000${sessionID}`)}.json`);
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  const goal = reduceGoalFlight(ledger.goal_events);
  const observation = hostObservation([sessionID, state.units[0]?.childSessionID]);
  const calls = run.filter(event => event.type === 'tool_use').map(event => event.part);
  const report = { schema: 1, artifact: 'operator-compaction-cli', package_version: fixture.pkg.version,
    runtime_marker: fixture.runtimeMarker, root_session: sessionID, root_agent: coordinatorAgent, worker_agent: workerAgent,
    operator_phase: state.phase, generation: state.generation, dispatched: state.dispatched,
    worker_status: state.units[0]?.status, worker_session: state.units[0]?.childSessionID,
    terminal: goal.receipt?.status ?? goal.phase, consumed_units: goal.consumed_units,
    result: (await readFile(join(project, 'result.txt'), 'utf8')).trim(), validator_unchanged: hash(await readFile(join(project, 'verify-result.mjs'))) === hash(validator),
    prepare_calls: calls.filter(part => part.tool === 'sortie_v010_prepare_operator').length,
    compact_calls: calls.filter(part => part.tool === 'sortie_v010_compact_and_continue').length,
    status_calls: calls.filter(part => part.tool === 'sortie_v010_operator_status').length,
    next_calls: calls.filter(part => part.tool === 'sortie_v010_operator_next').length,
    worker_dispatches: calls.filter(part => part.tool === 'task').length,
    tool_errors: calls.filter(part => part.state?.status === 'error').map(part => ({ tool: part.tool, code: String(part.state.error).split(/\r?\n/u)[0].slice(0, 160) })),
    compaction: observation };
  await writeFile(join(fixture.run, 'operator-compaction-rpt.json'), JSON.stringify(report, null, 2) + '\n');
  assert.equal(report.runtime_marker, '0.10.0-beta.1-v0912-language4-cost-rpt10-compaction-ref1-proposal1');
  assert.equal(report.operator_phase, 'completed');
  assert.equal(report.worker_status, 'succeeded');
  assert.equal(report.terminal, 'succeeded');
  assert.equal(report.dispatched, 1);
  assert.equal(report.consumed_units, 1);
  assert.equal(report.result, 'compacted-complete');
  assert.equal(report.validator_unchanged, true);
  assert.equal(report.prepare_calls, 1);
  assert.equal(report.compact_calls, 1);
  assert(report.status_calls >= 1 && report.next_calls >= 1);
  assert.equal(report.worker_dispatches, 1);
  assert.equal(report.tool_errors.length, 0);
  assert(report.compaction.rollover_summaries >= 1 && report.compaction.durable_resumes >= 1);
  assert(report.compaction.models.some(item => item.agent === coordinatorAgent && item.model === 'gpt-5.6-sol' && item.variant === 'low'));
  assert(report.compaction.models.some(item => item.agent === workerAgent && item.model === 'gpt-5.6-sol' && item.variant === 'medium'));
  console.log(JSON.stringify(report));
}

async function cli() {
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, 'operator-compaction-rpt-'));
  const packed = JSON.parse(await command(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', directory], root, {}, 1_200_000));
  const tgz = join(directory, packed[0].filename), receipts = join(directory, 'receipts');
  if (process.platform !== 'win32') return cliInside(tgz, receipts);
  const linux = async value => (await command('wsl.exe', ['-e', 'wslpath', '-a', value], root)).trim();
  const [script, linuxTgz, linuxReceipts] = await Promise.all([import.meta.filename, tgz, receipts].map(linux));
  const output = await command('wsl.exe', ['-e', 'bash', '-ic', `timeout --signal=TERM --kill-after=10s 3600s node ${[script, '--cli-inside', linuxTgz, linuxReceipts].map(shellQuote).join(' ')}`], root, {}, 3_660_000);
  console.log(JSON.stringify(JSON.parse(output.trim())));
}

async function main() {
  await mkdir(artifacts, { recursive: true });
  if (process.argv[2] === '--targeted') return targeted();
  if (process.argv[2] === '--cli') return cli();
  if (process.argv[2] === '--cli-inside') return cliInside(resolve(process.argv[3]), resolve(process.argv[4]));
  throw Error('Expected --targeted or --cli');
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'operator-compaction-rpt-failed'); process.exitCode = 1; });
