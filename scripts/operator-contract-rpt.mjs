import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { command, installedFixture } from './release-cli.mjs';
import { shellQuote } from './release-process.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const artifactRoot = join(root, '_testenv');
const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const hash = value => createHash('sha256').update(value).digest('hex');
const events = value => value.split(/\r?\n/u).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const longObjective = index => (`Use apply_patch to replace pending with unit-${index}-complete in result-${index}.txt, then run the exact assigned validation command. ` +
  `Do not use todowrite. Preserve every original acceptance criterion, the fixed unit split, all negative constraints, and the exact validation command. ` +
  `${'Keep the complete approved objective available to the worker without copying it into transient state. '.repeat(18)}`).slice(0, 1672);
const longCommand = index => `node verify-${index}.mjs --fixture-phase=${index} --test-target=single-unit --readonly-oracle=verified ` +
  `--expected-value=unit-${index}-complete --source-binding=current-protected --candidate-binding=current-protected ` +
  `--output-path=result-${index}.txt --contract-schema=0.1 --proof-scope=requested-full --network-policy=disabled --retain-evidence=true`;

function plan(invalidMapping = false, sharedMeasurements = false) {
  const validation = [1, 2, 3].map(longCommand);
  const ids = [1, 2, 3].flatMap(i => sharedMeasurements ? [0, 1, 2].map(j => `proof-${i}-${j}`) : [`proof-${i}`]);
  return { schema_version: '0.1', acceptance: ids.map(id => `${id} declared oracle passes`),
    acceptance_proof: ids.map(id => [id]), source_refs: ['fixture:anonymous-contract-rpt'],
    goal_declaration: { delivery_intent: 'implementation', delivery_mode: 'mvp-first', usable_path_established: false,
      controlled_change: false, goal_budget_units: 8, defaults: { target: 'three representative outputs', entrypoint: 'verify-1.mjs through verify-3.mjs',
        workload: 'three fixed serial units', oracle_coverage: ['three immutable content oracles'], build_boundary: 'not-applicable',
        source: 'anonymous fixture source', candidate: 'anonymous fixture candidate', source_binding: 'current-protected',
        candidate_binding: 'current-protected', fixture: 'operator-contract-rpt', proof_scope: 'requested-full', expected_outcome: 'pass' },
      criteria: validation.flatMap((validation_command, index) => sharedMeasurements ? [0, 1, 2].map(j => ({
        criterion_id: `proof-${index + 1}-${j}`, target: `output-${index + 1}-condition-${j}`, oracle_coverage: [`condition-${j}-oracle`], validation_command,
      })) : [{ criterion_id: `proof-${index + 1}`, validation_command }]) },
    units: validation.map((commandText, index) => ({ id: `unit-${index + 1}`, title: `Complete representative unit ${index + 1}`,
      objective: longObjective(index + 1), read: [`result-${index + 1}.txt`, `verify-${index + 1}.mjs`], write: [`result-${index + 1}.txt`],
      validation: [invalidMapping && index === 1 ? validation[0] : commandText],
      acceptance_indices: sharedMeasurements ? [index * 3, index * 3 + 1, index * 3 + 2] : [index] })) };
}

async function diagnoseOnly() {
  const installed = join(root, '_testenv', 'desktop-language3', 'node_modules', 'sortie-dogs', 'dist');
  const module = await import(pathToFileURL(join(installed, 'core/operator-runtime.js')).href);
  const profiles = await import(pathToFileURL(join(installed, 'core/runtime-profile.js')).href);
  const area = await mkdtemp(join(artifactRoot, 'temp-contract-rpt-before-'));
  const before = [];
  try {
    try { module.parseOperatorPlan(plan(true)); } catch (error) {
      before.push({ scenario: 'three-unit-invalid-mapping', code: String(error?.message ?? 'unknown').slice(0, 128),
        units: 3, objective_length: longObjective(1).length, command_length: longCommand(1).length });
    }
    const collapsed = plan(false);
    collapsed.units = collapsed.units.slice(0, 1);
    collapsed.units[0].acceptance_indices = [0, 1, 2];
    collapsed.units[0].validation = collapsed.goal_declaration.criteria.map(item => item.validation_command);
    try { await new module.OperatorRuntime(area, profiles.V010_RUNTIME_PROFILE).prepare('before-collapsed', collapsed); } catch (error) {
      before.push({ scenario: 'collapsed-long-generated-contract', code: String(error?.message ?? 'unknown').slice(0, 128),
        units: 1, objective_length: longObjective(1).length, command_length: collapsed.units[0].validation.join(' ').length });
    }
  } finally { await rm(area, { recursive: true, force: true }); }
  assert.deepEqual(before.map(item => item.code), ['operator-unit-coverage-invalid', 'operator-generated-contract-invalid']);
  const report = { schema: 1, artifact: 'before', installed_marker: '0.10.0-beta.1-v0912-language3', before };
  console.log(JSON.stringify(report));
  return report;
}

async function targeted() {
  const commands = [
    [process.execPath, [npmCli, '--prefix', root, 'run', 'build']],
    ['node', ['--experimental-strip-types', '--import', pathToFileURL(join(root, 'test/setup.ts')).href, '--test', '--test-concurrency=1',
      join(root, 'test/v010-runtime.test.ts'), join(root, 'test/schema.test.ts'), join(root, 'test/initialize.test.ts'), join(root, 'test/plugin-loader.test.ts')]],
  ];
  const evidence = [];
  for (const [executable, args] of commands) {
    try {
      await command(executable, args, root, {}, 1_200_000);
    } catch (error) {
      const output = error?.processResult;
      const lines = `${output?.stdout ?? ''}\n${output?.stderr ?? ''}`.split(/\r?\n/u);
      const summary = lines.filter(line => /^(?:not ok|\s*(?:error:|code:|expected:|actual:|operator-contract-rpt))|AssertionError|ERR_/u.test(line)).slice(0, 20);
      const detail = lines.filter(line => /(?:Cannot find|SyntaxError|TypeError|ReferenceError|ERR_)/u.test(line)).slice(0, 8);
      console.error(JSON.stringify({ phase: 'targeted-failure', exit: output?.code ?? null, summary, detail }));
      throw error;
    }
    evidence.push({ command: [executable, ...args], exit: 0, fingerprint: hash(JSON.stringify([executable, ...args])) });
  }
  console.log(JSON.stringify({ schema: 1, artifact: 'targeted-after', evidence }));
}

async function collectSessions(sessionIDs, project, env) {
  // CLI export can truncate a large streamed JSON at process exit. Use the local
  // read-only host DB for bounded metadata; never write sessions or export logs.
  const db = new DatabaseSync(join(process.env.XDG_DATA_HOME ?? join(os.homedir(), '.local/share'), 'opencode/opencode.db'), { readOnly: true });
  try {
    const agents = [], errors = [];
    const ids = [...new Set(sessionIDs.filter(id => typeof id === 'string'))];
    const query = db.prepare(`SELECT json_extract(data,'$.agent') agent,json_extract(data,'$.modelID') model,
      json_extract(data,'$.variant') variant,count(*) steps FROM message WHERE session_id=? AND json_extract(data,'$.role')='assistant' GROUP BY 1,2,3`);
    for (const id of ids) {
      const rows = query.all(id);
      if (!rows.length) errors.push({ session: id, code: 'host-message-metadata-missing' });
      agents.push(...rows.map(row => ({ session: id, ...row })));
    }
    return { session_count: ids.length, agents, errors };
  } finally { db.close(); }
}

async function observedReturnReport(sessionID) {
  const db = new DatabaseSync(join(process.env.XDG_DATA_HOME ?? join(os.homedir(), '.local/share'), 'opencode/opencode.db'), { readOnly: true });
  try {
    const query = db.prepare(`SELECT json_extract(p.data,'$.text') text FROM part p JOIN message m ON m.id=p.message_id
      WHERE m.session_id=? AND json_extract(m.data,'$.role')='assistant' AND json_extract(p.data,'$.type')='text'
      AND length(trim(json_extract(p.data,'$.text')))>0 ORDER BY m.time_created DESC,p.time_created DESC LIMIT 1`);
    let text = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      text = query.get(sessionID)?.text ?? '';
      if (text.includes('🐾 SORTIE DOGS — 帰還報告')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return { present: text.includes('🐾 SORTIE DOGS — 帰還報告'), mission: text.includes('⚔️ MISSION'),
      cost_pack: text.includes('🪙 COST / PACK'), career: text.includes('📜 PACK RECORD') };
  } finally { db.close(); }
}

async function cliInside(tgz, directory) {
  const fixture = await installedFixture(tgz, directory, 'beta-v010');
  const { project, env, runtime, coordinatorAgent, operatorAgent, reduceGoalFlight } = fixture;
  const sourceHashes = {};
  for (let index = 1; index <= 3; index++) {
    const expected = `unit-${index}-complete`;
    await writeFile(join(project, `result-${index}.txt`), 'pending\n');
    const source = `import assert from'node:assert/strict';import{readFile}from'node:fs/promises';assert.equal((await readFile(new URL('./result-${index}.txt',import.meta.url),'utf8')).trim(),'${expected}');console.log('UNIT_${index}_PASS');\n`;
    await writeFile(join(project, `verify-${index}.mjs`), source);
    sourceHashes[index] = hash(source);
  }
  await writeFile(join(project, 'AGENTS.md'), '# Anonymous three-unit contract RPT\nEdit only the assigned result file. Preserve all verification scripts. No commit, publish, global install, or alternate agents.\n');
  await writeFile(join(project, '.gitignore'), '.opencode/\n.sortie-dogs-v010/\n');
  await command('git', ['init', '-q', '-b', 'main'], project, env);
  await command('git', ['add', '--', 'AGENTS.md', '.gitignore', ...[1, 2, 3].flatMap(index => [`result-${index}.txt`, `verify-${index}.mjs`])], project, env);
  await command('git', ['-c', 'user.name=Sortie Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Seed anonymous contract RPT'], project, env);
  const invalidPath = join(project, 'invalid-plan.json'), patchPath = join(project, 'repair-fields.json');
  await writeFile(invalidPath, JSON.stringify(plan(true, true)));
  const patches = [{ op: 'replace', path: '/units/1/validation', value: plan(false, true).units[1].validation }];
  await writeFile(patchPath, JSON.stringify(patches));
  async function cli(prompt, session) {
    return events(await command('timeout', ['--signal=TERM', '--kill-after=10s', '1080s', 'opencode', 'run', '--dir', project,
      '--format', 'json', '--print-logs', '--agent', coordinatorAgent, '--model', 'openai/gpt-5.6-sol', '--variant', 'low',
      ...(session ? ['--session', session] : []), prompt], project, env, 1_120_000));
  }
  const initial = await cli('この匿名3 unit検証案件を開始する。まだtoolを呼ばず、RPT_READYだけ返す。');
  const sessionID = initial.find(event => event.sessionID)?.sessionID;
  assert(sessionID, 'CLI root session was not observed');
  const outcome = await cli(`同じ案件を続行する。まず ${invalidPath} を読み、そのplan_jsonをsortie_v010_prepare_operatorへ一度渡す。返却diagnosticがdocument=plan、pointer=/units/1/acceptance_indices/0、code=operator-unit-coverage-invalid、repair_kind=repair-proof-mappingで値本文を含まないことを確認する。次に ${patchPath} の明示承認済みfield修正を、返却draft_idと共にsortie_v010_repair_operator_planへ渡す。全planを再生成せず、3 unit・全acceptance・長いobjectiveを保持する。返された ${operatorAgent} Taskを完全一致でdispatchし、3 workerを順次実行。sourceは自分で編集しない。各workerはresult-N.txtをunit-N-completeへ変更し、長いexact validation commandを実行する。Task完了後は結果を確認し、run_idとacceptance_fingerprintを使ってsortie_v010_complete_operatorへ明示受入を要求する。そのtoolのreceipt.status=succeededでのみ完了。文章のDONE宣言で代替しない。最終応答は「## 変更点」から始め、帰還報告や数値パネルを自作しない。hostの表示経路を検証する。Vibe本体や本番完了は主張しない。`, sessionID);
  const key = `${runtime.id}\u0000${sessionID}`;
  const ledgerPath = join(project, '.git/sortie-dogs', runtime.flightDirectory, `${hash(key)}.json`);
  const operatorPath = join(project, runtime.stateDirectory, 'operators', `${hash(sessionID)}.json`);
  const operatorState = JSON.parse(await readFile(operatorPath, 'utf8'));
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  const goal = reduceGoalFlight(ledger.goal_events);
  const oracles = [];
  for (let index = 1; index <= 3; index++) oracles.push((await readFile(join(project, `result-${index}.txt`), 'utf8')).trim() === `unit-${index}-complete` &&
    hash(await readFile(join(project, `verify-${index}.mjs`))) === sourceHashes[index]);
  const family = await collectSessions([sessionID, operatorState.operatorSessionID, ...operatorState.units.map(unit => unit.childSessionID)], project, env);
  const validationEvidence = ledger.goal_events.flatMap(({ event }) => event.kind === 'unit.settled' ? event.evidence ?? [] : [])
    .filter(item => item.execution?.exit_code === 0).map(item => ({ criteria: item.measurement.criterion_ids, command_length: item.execution.command.join(' ').length,
      exit: item.execution.exit_code, fingerprint: hash(JSON.stringify(item.execution.command)) }));
  const report = { schema: 1, artifact: 'cli-after', package_version: fixture.pkg.version, runtime_marker: fixture.runtimeMarker,
    root_session: sessionID, root_agent: coordinatorAgent, operator_agent: operatorAgent, family,
    units: operatorState.units.map(unit => ({ id: unit.unit.id, status: unit.status, child_session: unit.childSessionID, result_class: unit.resultClass })),
    operator_phase: operatorState.phase, operator_decision: operatorState.decision, root_terminal: goal.receipt?.status ?? goal.phase, oracles, validation_evidence: validationEvidence,
    tool_errors: outcome.filter(event => event.type === 'tool_use' && event.part?.state?.status === 'error').map(event => ({ tool: event.part.tool, code: String(event.part.state.error).split(/\r?\n/u)[0].slice(0, 160) })),
    return_report: await observedReturnReport(sessionID) };
  await writeFile(join(fixture.run, 'operator-contract-rpt.json'), JSON.stringify(report, null, 2) + '\n');
  assert(report.runtime_marker === '0.10.0-beta.1-v0912-language4-cost-rpt10-compaction-ref1-proposal1');
  assert(operatorState.phase === 'completed' && operatorState.units.length === 3 && operatorState.units.every(unit => unit.status === 'succeeded'));
  assert(goal.receipt?.status === 'succeeded' && oracles.every(Boolean));
  assert(validationEvidence.length >= 3 && validationEvidence.every(item => item.command_length > 256));
  assert.equal(new Set(validationEvidence.flatMap(item => item.criteria)).size, 9, 'Every distinct measurement identity must survive a shared command');
  assert(family.agents.some(item => item.agent === coordinatorAgent && item.model === 'gpt-5.6-sol' && item.variant === 'low'));
  assert(family.agents.some(item => item.agent === operatorAgent && item.model === 'gpt-5.6-terra' && item.variant === 'high'));
  assert(family.agents.filter(item => item.agent === fixture.workerAgent && item.model === 'gpt-5.6-sol' && item.variant === 'medium').length >= 3);
  assert(report.tool_errors.length === 0);
  assert(Object.values(report.return_report).every(Boolean), 'Native final message must contain the canonical game-style return report');
  const calls = outcome.filter(event => event.type === 'tool_use').map(event => event.part);
  assert.equal(calls.filter(part => part.tool === 'sortie_v010_prepare_operator').length, 1, 'Do not regenerate the full plan');
  assert.equal(calls.filter(part => part.tool === 'sortie_v010_repair_operator_plan').length, 1, 'Repair only the declared fields');
  assert.ok(calls.some(part => part.tool === 'sortie_v010_complete_operator' && part.state?.status === 'completed'));
  console.log(JSON.stringify(report));
}

async function cli() {
  await mkdir(artifactRoot, { recursive: true });
  const directory = await mkdtemp(join(artifactRoot, 'operator-contract-rpt-'));
  const packed = JSON.parse(await command(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', directory], root, {}, 1_200_000));
  const tgz = join(directory, packed[0].filename), receipts = join(directory, 'receipts');
  if (process.platform !== 'win32') return cliInside(tgz, receipts);
  const linux = async value => (await command('wsl.exe', ['-e', 'wslpath', '-a', value], root)).trim();
  const [script, linuxTgz, linuxReceipts] = await Promise.all([import.meta.filename, tgz, receipts].map(linux));
  try {
    const output = await command('wsl.exe', ['-e', 'bash', '-ic', `timeout --signal=TERM --kill-after=10s 1800s node ${[script, '--cli-inside', linuxTgz, linuxReceipts].map(shellQuote).join(' ')}`], root, {}, 1_860_000);
    console.log(JSON.stringify(JSON.parse(output.trim())));
  } catch (error) {
    const result = error?.processResult;
    const bounded = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`.split(/\r?\n/u)
      .filter(line => line.trim().length > 0).slice(-8).map(line => line.slice(0, 320));
    console.error(JSON.stringify({ phase: 'cli-failure', exit: result?.code ?? null, bounded }));
    throw error;
  }
}

async function main() {
  await mkdir(artifactRoot, { recursive: true });
  if (process.argv[2] === '--diagnose-only') return diagnoseOnly();
  if (process.argv[2] === '--targeted') return targeted();
  if (process.argv[2] === '--cli') return cli();
  if (process.argv[2] === '--cli-inside') return cliInside(resolve(process.argv[3]), resolve(process.argv[4]));
  throw Error('Expected --diagnose-only, --targeted, or --cli');
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'operator-contract-rpt-failed'); process.exitCode = 1; });
