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
const artifactRoot = join(root, '_testenv');
const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const hash = value => createHash('sha256').update(value).digest('hex');
const events = value => value.split(/\r?\n/u).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const criteria = [1, 2, 3].map(index => `Original accepted criterion ${index} remains satisfied`);

function sessionModels(sessionIDs) {
  const db = new DatabaseSync(join(process.env.XDG_DATA_HOME ?? join(os.homedir(), '.local/share'), 'opencode/opencode.db'), { readOnly: true });
  try {
    const query = db.prepare(`SELECT json_extract(data,'$.agent') agent,json_extract(data,'$.modelID') model,
      json_extract(data,'$.variant') variant,count(*) steps FROM message WHERE session_id=? AND json_extract(data,'$.role')='assistant' GROUP BY 1,2,3`);
    return [...new Set(sessionIDs.filter(Boolean))].flatMap(session => query.all(session).map(row => ({ session, ...row })));
  } finally { db.close(); }
}

function declaration(commands, fixture) {
  return { delivery_intent: 'repair', delivery_mode: 'repair-first', usable_path_established: false, controlled_change: false,
    goal_budget_units: 8, defaults: { target: 'anonymous interrupted workflow', entrypoint: 'fixture validators', workload: fixture,
      oracle_coverage: ['immutable file content'], build_boundary: 'not-applicable', source: 'anonymous protected source',
      candidate: 'anonymous protected candidate', source_binding: 'current-protected', candidate_binding: 'current-protected',
      fixture, proof_scope: 'requested-full', expected_outcome: 'pass' },
    criteria: commands.map((validation_command, index) => ({ criterion_id: `criterion-${index + 1}`, validation_command })) };
}

function initialPlan() {
  const commands = [1, 2, 3].map(index => `node verify-${index}.mjs`);
  return { schema_version: '0.1', acceptance: criteria, acceptance_proof: commands.map((_, index) => [`criterion-${index + 1}`]),
    source_refs: ['fixture:anonymous-interrupted-user-order'], goal_declaration: declaration(commands, 'repair-lineage-initial'),
    units: commands.map((validation, index) => ({ id: `initial-${index + 1}`, title: `Complete original unit ${index + 1}`,
      objective: `Change only result-${index + 1}.txt from pending to original-${index + 1}-complete, run the exact validation, and preserve all acceptance.`,
      read: [`result-${index + 1}.txt`, `verify-${index + 1}.mjs`], write: [`result-${index + 1}.txt`], validation: [validation], acceptance_indices: [index] })) };
}

function repairPlan() {
  const validation = 'node verify-repair.mjs';
  return { schema_version: '0.1', acceptance: criteria, acceptance_proof: criteria.map((_, index) => [`criterion-${index + 1}`]),
    source_refs: ['fixture:anonymous-interrupted-user-order', 'fixture:approved-repair'],
    goal_declaration: declaration(criteria.map(() => validation), 'repair-lineage-replacement'),
    units: [{ id: 'approved-repair', title: 'Apply the approved post-interruption repair',
      objective: 'Preserve the original ordered acceptance and completed outputs; change only repair.txt from pending to repaired, then run the exact repair validation.',
      read: ['repair.txt', 'verify-repair.mjs', 'result-1.txt', 'result-2.txt', 'result-3.txt'], write: ['repair.txt'],
      validation: [validation], acceptance_indices: [0, 1, 2] }] };
}

async function targeted() {
  const commands = [
    [process.execPath, [npmCli, '--prefix', root, 'run', 'build']],
    ['node', ['--experimental-strip-types', '--import', pathToFileURL(join(root, 'test/setup.ts')).href, '--test', '--test-concurrency=1',
      join(root, 'test/v010-runtime.test.ts'), join(root, 'test/run-metrics.test.ts'), join(root, 'test/sortie-debrief.test.ts'), join(root, 'test/model-cost.test.ts'),
      join(root, 'test/initialize.test.ts'), join(root, 'test/plugin-loader.test.ts')]],
  ];
  const evidence = [];
  for (const [executable, args] of commands) {
    try { await command(executable, args, root, {}, 1_200_000); }
    catch (error) {
      const output = error?.processResult;
      const lines = `${output?.stdout ?? ''}\n${output?.stderr ?? ''}`.split(/\r?\n/u);
      const syntax = lines.findIndex(line => line.includes('ERR_INVALID_TYPESCRIPT_SYNTAX'));
      const bounded = syntax >= 0 ? lines.slice(Math.max(0, syntax - 12), syntax + 5) : lines
        .filter(line => /^(?:not ok|\s*(?:error:|code:|expected:|actual:|at ))|AssertionError|ERR_|operator-/u.test(line)).slice(0, 24);
      console.error(JSON.stringify({ phase: 'targeted-failure', exit: output?.code ?? null, bounded }));
      throw error;
    }
    evidence.push({ command: [executable, ...args], exit: 0, fingerprint: hash(JSON.stringify([executable, ...args])) });
  }
  console.log(JSON.stringify({ schema: 1, artifact: 'operator-repair-resume-targeted', evidence }));
}

async function cliInside(tgz, directory) {
  const fixture = await installedFixture(tgz, directory, 'beta-v010');
  const { project, env, runtime, coordinatorAgent, workerAgent, reduceGoalFlight } = fixture;
  await writeFile(join(project, 'AGENTS.md'), '# Anonymous interrupted repair fixture\nEdit only the exact assigned output. Preserve validators and prior results. No commit, publish, global install, or alternate agent.\n');
  await writeFile(join(project, '.gitignore'), '.opencode/\n.sortie-dogs-v010/\n');
  for (let index = 1; index <= 3; index++) {
    await writeFile(join(project, `result-${index}.txt`), 'pending\n');
    await writeFile(join(project, `verify-${index}.mjs`), `import assert from'node:assert/strict';import{readFile}from'node:fs/promises';assert.equal((await readFile(new URL('./result-${index}.txt',import.meta.url),'utf8')).trim(),'original-${index}-complete');\n`);
  }
  await writeFile(join(project, 'repair.txt'), 'pending\n');
  await writeFile(join(project, 'verify-repair.mjs'), `import assert from'node:assert/strict';import{readFile}from'node:fs/promises';for(let i=1;i<=3;i++)assert.equal((await readFile(new URL('./result-'+i+'.txt',import.meta.url),'utf8')).trim(),'original-'+i+'-complete');assert.equal((await readFile(new URL('./repair.txt',import.meta.url),'utf8')).trim(),'repaired');\n`);
  await command('git', ['init', '-q', '-b', 'main'], project, env);
  await command('git', ['add', '--', 'AGENTS.md', '.gitignore', 'repair.txt', 'verify-repair.mjs',
    ...[1, 2, 3].flatMap(index => [`result-${index}.txt`, `verify-${index}.mjs`])], project, env);
  await command('git', ['-c', 'user.name=Sortie Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Seed interrupted repair fixture'], project, env);
  const initialPath = join(project, 'initial-plan.json'), repairPath = join(project, 'repair-plan.json');
  await writeFile(initialPath, JSON.stringify(initialPlan()));
  await writeFile(repairPath, JSON.stringify(repairPlan()));
  async function cli(prompt, session) {
    return events(await command('timeout', ['--signal=TERM', '--kill-after=10s', '1080s', 'opencode', 'run', '--dir', project,
      '--format', 'json', '--print-logs', '--agent', coordinatorAgent, '--model', 'openai/gpt-5.6-sol', '--variant', 'low',
      ...(session ? ['--session', session] : []), prompt], project, env, 1_120_000));
  }
  const opened = await cli('匿名の中断後修復RPTを開始する。toolを呼ばず、REPAIR_RPT_READYだけ返す。');
  const sessionID = opened.find(event => event.sessionID)?.sessionID;
  assert(sessionID, 'root session missing');
  const firstEvents = await cli(`${initialPath} を読み、そのplanをsortie_v010_prepare_operatorへ渡す。返されたTaskを完全一致で実行し、3 workerを順次完了する。sourceを自分で編集しない。全unit成功後、sortie_v010_complete_operatorは呼ばず、sortie_v010_cancel_operatorを一度呼び明示中断する。元のAcceptance、scope、run ID、消費予算を保持する。最終文は中断状態のみ報告し、DONEと言い換えない。`, sessionID);
  const key = hash(`${runtime.id}\u0000${sessionID}`);
  const ledgerPath = join(project, '.git/sortie-dogs', runtime.flightDirectory, `${key}.json`);
  const operatorPath = join(project, runtime.stateDirectory, 'operators', `${hash(sessionID)}.json`);
  const cancelled = JSON.parse(await readFile(operatorPath, 'utf8'));
  const beforeGoal = reduceGoalFlight(JSON.parse(await readFile(ledgerPath, 'utf8')).goal_events);
  assert.equal(cancelled.phase, 'cancelled');
  assert.equal(cancelled.units.filter(unit => unit.status === 'succeeded').length, 3);
  assert.equal(beforeGoal.consumed_units, 3);
  const oldRunID = cancelled.runID, oldGoalFingerprint = beforeGoal.acceptance_fingerprint;
  const oldTaskIDs = cancelled.units.map(unit => /^task_id: (.+)$/m.exec(unit.task.prompt)?.[1]);

  // A second CLI process is the host/plugin restart boundary; the same root session and durable files remain.
  const repairEvents = await cli(`同じユーザー案件を中断後に修復する。${repairPath} を読み、同じ元criteria順の修復planをsortie_v010_prepare_operatorへ一度渡す。返された1 worker Taskを完全一致で実行する。旧3 unitを再実行せず、repair.txtだけ変更する。run_idとacceptance_fingerprintを使いsortie_v010_complete_operatorを明示実行し、receipt.status=succeededでのみ終了する。登録失敗時にcancel/reprepareしない。`, sessionID);
  const repaired = JSON.parse(await readFile(operatorPath, 'utf8'));
  const records = JSON.parse(await readFile(ledgerPath, 'utf8')).goal_events;
  const afterGoal = reduceGoalFlight(records);
  const repairTaskID = /^task_id: (.+)$/m.exec(repaired.units[0].task.prompt)?.[1];
  const toolErrors = repairEvents.filter(event => event.type === 'tool_use' && event.part?.state?.status === 'error');
  const report = { schema: 1, artifact: 'operator-repair-resume-cli', package_version: fixture.pkg.version,
    runtime_marker: fixture.runtimeMarker, root_session: sessionID, root_agent: coordinatorAgent, worker_agent: workerAgent,
    old_run_id: oldRunID, repair_run_id: repaired.runID, parent_run_id: repaired.parentRunID,
    old_goal_fingerprint: oldGoalFingerprint, repair_goal_fingerprint: afterGoal.acceptance_fingerprint,
    consumed_before: beforeGoal.consumed_units, consumed_after: afterGoal.consumed_units,
    old_task_ids: oldTaskIDs, repair_task_id: repairTaskID, prior_accepted_units: repaired.priorAcceptedUnits?.map(item => item.taskID) ?? [],
    repair_child_session: repaired.units[0].childSessionID, repair_status: repaired.units[0].status,
    session_models: sessionModels([sessionID, cancelled.operatorSessionID, ...cancelled.units.map(unit => unit.childSessionID), repaired.units[0].childSessionID]),
    operator_phase: repaired.phase, terminal: afterGoal.receipt?.status ?? afterGoal.phase,
    original_results: await Promise.all([1, 2, 3].map(async index => (await readFile(join(project, `result-${index}.txt`), 'utf8')).trim())),
    repair_result: (await readFile(join(project, 'repair.txt'), 'utf8')).trim(),
    tool_errors: toolErrors.map(event => ({ tool: event.part.tool, code: String(event.part.state.error).split(/\r?\n/u)[0].slice(0, 160) })),
    first_dispatches: firstEvents.filter(event => event.type === 'tool_use' && event.part?.tool === 'task').length,
    repair_dispatches: repairEvents.filter(event => event.type === 'tool_use' && event.part?.tool === 'task').length };
  await writeFile(join(fixture.run, 'operator-repair-resume-rpt.json'), JSON.stringify(report, null, 2) + '\n');
  assert.equal(report.runtime_marker, '0.10.0-beta.1-v0912-language4-cost-rpt10-compaction-ref1-proposal1');
  assert.notEqual(report.old_run_id, report.repair_run_id);
  assert.equal(report.parent_run_id, report.old_run_id);
  assert.notEqual(report.old_goal_fingerprint, report.repair_goal_fingerprint);
  assert.equal(report.consumed_before, 3);
  assert.equal(report.consumed_after, 4);
  assert.equal(report.repair_status, 'succeeded');
  assert.equal(report.operator_phase, 'completed');
  assert.equal(report.terminal, 'succeeded');
  assert.deepEqual(report.original_results, ['original-1-complete', 'original-2-complete', 'original-3-complete']);
  assert.equal(report.repair_result, 'repaired');
  assert.equal(report.repair_dispatches, 1);
  assert.equal(report.tool_errors.length, 0);
  assert(report.repair_child_session && report.prior_accepted_units.includes(oldTaskIDs[2]));
  assert(report.session_models.some(item => item.session === sessionID && item.agent === coordinatorAgent && item.model === 'gpt-5.6-sol' && item.variant === 'low'));
  assert(report.session_models.some(item => item.agent === fixture.operatorAgent && item.model === 'gpt-5.6-terra' && item.variant === 'high'));
  assert(report.session_models.filter(item => item.agent === workerAgent && item.model === 'gpt-5.6-sol' && item.variant === 'medium').length >= 4);
  console.log(JSON.stringify(report));
}

async function cli() {
  await mkdir(artifactRoot, { recursive: true });
  const directory = await mkdtemp(join(artifactRoot, 'operator-repair-resume-rpt-'));
  const packed = JSON.parse(await command(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', directory], root, {}, 1_200_000));
  const tgz = join(directory, packed[0].filename), receipts = join(directory, 'receipts');
  if (process.platform !== 'win32') return cliInside(tgz, receipts);
  const linux = async value => (await command('wsl.exe', ['-e', 'wslpath', '-a', value], root)).trim();
  const [script, linuxTgz, linuxReceipts] = await Promise.all([import.meta.filename, tgz, receipts].map(linux));
  const output = await command('wsl.exe', ['-e', 'bash', '-ic', `timeout --signal=TERM --kill-after=10s 3000s node ${[script, '--cli-inside', linuxTgz, linuxReceipts].map(shellQuote).join(' ')}`], root, {}, 3_060_000);
  console.log(JSON.stringify(JSON.parse(output.trim())));
}

async function legacyCliInside(tgz, directory) {
  const fixture = await installedFixture(tgz, directory, 'beta-v010');
  const { project, env, runtime, coordinatorAgent } = fixture;
  await writeFile(join(project, 'AGENTS.md'), '# Anonymous legacy resume fixture\nEdit only result.txt through the exact returned worker Task.\n');
  await writeFile(join(project, '.gitignore'), '.opencode/\n.sortie-dogs-v010/\n');
  await writeFile(join(project, 'result.txt'), 'pending\n');
  await writeFile(join(project, 'verify.mjs'), "import assert from'node:assert/strict';import{readFile}from'node:fs/promises';assert.equal((await readFile(new URL('./result.txt',import.meta.url),'utf8')).trim(),'resumed');\n");
  await command('git', ['init', '-q', '-b', 'main'], project, env);
  await command('git', ['add', '--', 'AGENTS.md', '.gitignore', 'result.txt', 'verify.mjs'], project, env);
  await command('git', ['-c', 'user.name=Sortie Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '-qm', 'Seed anonymous legacy resume fixture'], project, env);
  async function runCli(prompt, session) {
    return events(await command('timeout', ['--signal=TERM', '--kill-after=10s', '1080s', 'opencode', 'run', '--dir', project,
      '--format', 'json', '--print-logs', '--agent', coordinatorAgent, '--model', 'openai/gpt-5.6-sol', '--variant', 'low',
      ...(session ? ['--session', session] : []), prompt], project, env, 1_120_000));
  }
  const opened = await runCli('匿名legacy resume RPTを開始する。toolを呼ばず、LEGACY_RPT_READYだけ返す。');
  const sessionID = opened.find(event => event.sessionID)?.sessionID;
  assert(sessionID, 'legacy root session missing');
  const { OperatorRuntime } = await import(pathToFileURL(join(fixture.installed, 'dist/core/operator-runtime.js')).href);
  const validation = 'node verify.mjs';
  const legacyPlan = { schema_version: '0.1', acceptance: ['Registered result is resumed without replacing its run'],
    acceptance_proof: [['criterion-1']], source_refs: ['fixture:anonymous-legacy-order'],
    goal_declaration: declaration([validation], 'legacy-registered-pending'), units: [{ id: 'legacy-pending', title: 'Resume pending unit',
      objective: 'Change only result.txt from pending to resumed and run the exact validator.', read: ['result.txt', 'verify.mjs'],
      write: ['result.txt'], validation: [validation], acceptance_indices: [0] }] };
  const operator = new OperatorRuntime(project, runtime);
  const prepared = await operator.prepare(sessionID, legacyPlan);
  const operatorPath = join(project, runtime.stateDirectory, 'operators', `${hash(sessionID)}.json`);
  const stopped = JSON.parse(await readFile(operatorPath, 'utf8'));
  stopped.phase = 'awaiting-decision'; stopped.decision = 'legacy-host-restart';
  await writeFile(operatorPath, JSON.stringify(stopped));
  const key = hash(`${runtime.id}\u0000${sessionID}`);
  const ledgerPath = join(project, '.git/sortie-dogs', runtime.flightDirectory, `${key}.json`);
  const before = fixture.reduceGoalFlight(JSON.parse(await readFile(ledgerPath, 'utf8')).goal_events);
  const resumedEvents = await runCli(`同じ登録済みrunをcold resumeする。sortie_v010_resume_operatorをrun_id=${prepared.runID}、acceptance_fingerprint=${prepared.acceptanceFingerprint}で一度呼ぶ。返されたTaskを完全一致で実行し、同じrun_idでsortie_v010_complete_operatorを呼ぶ。cancel/reprepare禁止。`, sessionID);
  const afterOperator = JSON.parse(await readFile(operatorPath, 'utf8'));
  const after = fixture.reduceGoalFlight(JSON.parse(await readFile(ledgerPath, 'utf8')).goal_events);

  await writeFile(join(project, 'failed-result.txt'), 'pending\n');
  await writeFile(join(project, 'verify-failed.mjs'), "import assert from'node:assert/strict';import{readFile}from'node:fs/promises';assert.equal((await readFile(new URL('./failed-result.txt',import.meta.url),'utf8')).trim(),'resumed');\n");
  const failedOpened = await runCli('別の匿名legacy failed-child-null RPTを開始する。toolを呼ばず、LEGACY_FAILED_READYだけ返す。');
  const failedSession = failedOpened.find(event => event.sessionID)?.sessionID;
  assert(failedSession, 'legacy failed root session missing');
  const failedValidation = 'node verify-failed.mjs';
  const failedPlan = { schema_version: '0.1', acceptance: ['Failed child-null unit resumes without replacing its run'],
    acceptance_proof: [['criterion-1']], source_refs: ['fixture:anonymous-legacy-failed-order'],
    goal_declaration: declaration([failedValidation], 'legacy-registered-failed'), units: [{ id: 'legacy-failed', title: 'Resume failed unit',
      objective: 'Change only failed-result.txt from pending to resumed and run the exact validator.', read: ['failed-result.txt', 'verify-failed.mjs'],
      write: ['failed-result.txt'], validation: [failedValidation], acceptance_indices: [0] }] };
  const failedOperator = new OperatorRuntime(project, runtime);
  const failedPrepared = await failedOperator.prepare(failedSession, failedPlan);
  const failedNext = await failedOperator.next(failedSession, failedSession);
  const failedKey = hash(`${runtime.id}\u0000${failedSession}`);
  const failedLedgerPath = join(project, '.git/sortie-dogs', runtime.flightDirectory, `${failedKey}.json`);
  const preAdmissionLegacyLedger = await readFile(failedLedgerPath, 'utf8');
  const failedTaskPath = join(project, 'legacy-failed-task.json');
  await writeFile(failedTaskPath, JSON.stringify(failedNext.task));
  const installedIndex = join(fixture.installed, 'dist/plugin/index.js');
  const currentIndex = await readFile(installedIndex, 'utf8');
  const functionHead = 'async function reserveGoalDispatch(sessionID, callID, prompt) {';
  assert(currentIndex.includes(functionHead), 'installed reserveGoalDispatch marker missing');
  await writeFile(installedIndex, currentIndex.replace(functionHead,
    `${functionHead}\n        throw new Error("legacy-pre-registration-admission-failure");`));
  let failedAttemptEvents;
  try {
    failedAttemptEvents = await runCli(`${failedTaskPath} のTask JSONを読み、task toolへ完全一致で一度渡す。失敗を回避、再prepare、別Task実行しない。`, failedSession);
  } finally {
    await writeFile(installedIndex, currentIndex);
  }
  // Reproduce the legacy host boundary: the operator admission failure was durable, but that
  // runtime exited before publishing its goal registration. The next CLI process reads both files cold.
  await writeFile(failedLedgerPath, preAdmissionLegacyLedger);
  const failedOperatorPath = join(project, runtime.stateDirectory, 'operators', `${hash(failedSession)}.json`);
  const failedBeforeOperator = JSON.parse(await readFile(failedOperatorPath, 'utf8'));
  const failedBeforeGoal = fixture.reduceGoalFlight(JSON.parse(await readFile(failedLedgerPath, 'utf8')).goal_events);
  const failedResumedEvents = await runCli(`同じfailed-child-null登録済みrunをcold resumeする。sortie_v010_resume_operatorをrun_id=${failedPrepared.runID}、acceptance_fingerprint=${failedPrepared.acceptanceFingerprint}で一度呼ぶ。返されたTaskを完全一致で実行し、同じrun_idでsortie_v010_complete_operatorを呼ぶ。cancel/reprepare禁止。`, failedSession);
  const failedAfterOperator = JSON.parse(await readFile(failedOperatorPath, 'utf8'));
  const failedAfterGoal = fixture.reduceGoalFlight(JSON.parse(await readFile(failedLedgerPath, 'utf8')).goal_events);
  const report = { schema: 1, artifact: 'operator-repair-resume-legacy-cli', package_version: fixture.pkg.version,
    runtime_marker: fixture.runtimeMarker, root_session: sessionID, run_id_before: prepared.runID, run_id_after: afterOperator.runID,
    phase_before: stopped.phase, pending_before: stopped.units.filter(unit => unit.status === 'pending').length,
    consumed_before: before.consumed_units, consumed_after: after.consumed_units, goal_fingerprint_before: before.acceptance_fingerprint,
    goal_fingerprint_after: after.acceptance_fingerprint, child_session: afterOperator.units[0].childSessionID,
    unit_status: afterOperator.units[0].status, operator_phase: afterOperator.phase, terminal: after.receipt?.status ?? after.phase,
    dispatches: resumedEvents.filter(event => event.type === 'tool_use' && event.part?.tool === 'task').length,
    failed_run_id_before: failedPrepared.runID, failed_run_id_after: failedAfterOperator.runID,
    failed_phase_before: failedBeforeOperator.phase, failed_child_before: failedBeforeOperator.units[0].childSessionID,
    failed_status_before: failedBeforeOperator.units[0].status, failed_outstanding_before: failedBeforeGoal.outstanding_reservations.length,
    failed_consumed_before: failedBeforeGoal.consumed_units, failed_consumed_after: failedAfterGoal.consumed_units,
    failed_goal_fingerprint_before: failedBeforeGoal.acceptance_fingerprint,
    failed_goal_fingerprint_after: failedAfterGoal.acceptance_fingerprint, failed_child_after: failedAfterOperator.units[0].childSessionID,
    failed_status_after: failedAfterOperator.units[0].status, failed_operator_phase: failedAfterOperator.phase,
    failed_terminal: failedAfterGoal.receipt?.status ?? failedAfterGoal.phase,
    failed_attempt_errors: failedAttemptEvents.filter(event => event.type === 'tool_use' && event.part?.state?.status === 'error').length,
    failed_resume_dispatches: failedResumedEvents.filter(event => event.type === 'tool_use' && event.part?.tool === 'task').length };
  process.stderr.write(JSON.stringify({ phase: 'checkpoint', report }) + '\n');
  await writeFile(join(fixture.run, 'operator-repair-resume-legacy-rpt.json'), JSON.stringify(report, null, 2) + '\n');
  assert.equal(report.runtime_marker, '0.10.0-beta.1-v0912-language4-cost-rpt10-compaction-ref1-proposal1');
  assert.equal(report.run_id_after, report.run_id_before);
  assert.equal(report.phase_before, 'awaiting-decision');
  assert.equal(report.pending_before, 1);
  assert.equal(report.consumed_before, 0);
  assert.equal(report.consumed_after, 1);
  assert.notEqual(report.goal_fingerprint_before, report.goal_fingerprint_after, 'pending goal was not relinked');
  assert(report.child_session);
  assert.equal(report.unit_status, 'succeeded');
  assert.equal(report.operator_phase, 'completed');
  assert.equal(report.terminal, 'succeeded');
  assert.equal(report.dispatches, 1);
  assert.equal(report.failed_run_id_after, report.failed_run_id_before);
  assert.equal(report.failed_phase_before, 'awaiting-decision');
  assert.equal(report.failed_child_before, null);
  assert.equal(report.failed_status_before, 'failed');
  assert.equal(report.failed_outstanding_before, 0);
  assert.equal(report.failed_consumed_before, 0);
  assert.equal(report.failed_consumed_after, 1);
  assert.notEqual(report.failed_goal_fingerprint_before, report.failed_goal_fingerprint_after, 'failed goal was not relinked');
  assert(report.failed_child_after);
  assert.equal(report.failed_status_after, 'succeeded');
  assert.equal(report.failed_operator_phase, 'completed');
  assert.equal(report.failed_terminal, 'succeeded');
  assert.equal(report.failed_attempt_errors, 1);
  assert.equal(report.failed_resume_dispatches, 1);
  console.log(JSON.stringify(report));
}

async function legacyCli() {
  await mkdir(artifactRoot, { recursive: true });
  const directory = await mkdtemp(join(artifactRoot, 'operator-repair-resume-legacy-rpt-'));
  const packed = JSON.parse(await command(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', directory], root, {}, 1_200_000));
  const tgz = join(directory, packed[0].filename), receipts = join(directory, 'receipts');
  if (process.platform !== 'win32') return legacyCliInside(tgz, receipts);
  const linux = async value => (await command('wsl.exe', ['-e', 'wslpath', '-a', value], root)).trim();
  const [script, linuxTgz, linuxReceipts] = await Promise.all([import.meta.filename, tgz, receipts].map(linux));
  let output;
  try {
    output = await command('wsl.exe', ['-e', 'bash', '-ic', `timeout --signal=TERM --kill-after=10s 3000s node ${[script, '--legacy-cli-inside', linuxTgz, linuxReceipts].map(shellQuote).join(' ')}`], root, {}, 3_060_000);
  } catch (error) {
    const result = error?.processResult;
    const bounded = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`.split(/\r?\n/u)
      .filter(line => /legacy-|operator-|Assertion|failed|missing|expected|actual|phase/u.test(line)).slice(-24);
    console.error(JSON.stringify({ phase: 'legacy-cli-failure', exit: result?.code ?? null, bounded }));
    throw error;
  }
  console.log(JSON.stringify(JSON.parse(output.trim())));
}

async function main() {
  if (process.argv[2] === '--targeted') return targeted();
  if (process.argv[2] === '--cli') return cli();
  if (process.argv[2] === '--cli-inside') return cliInside(resolve(process.argv[3]), resolve(process.argv[4]));
  if (process.argv[2] === '--legacy-cli') return legacyCli();
  if (process.argv[2] === '--legacy-cli-inside') return legacyCliInside(resolve(process.argv[3]), resolve(process.argv[4]));
  throw Error('Expected --targeted, --cli, or --legacy-cli');
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'operator-repair-resume-rpt-failed'); process.exitCode = 1; });
