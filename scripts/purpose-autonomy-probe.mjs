import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installedFixture, startV2ReleaseServer, nativeCLI, spawnPromptCLI, command, missionDatabasePath } from './release-cli.mjs';
import { observeMissionCLI, monitorMissionCLI, persistMissionCLIFailure } from './mission-cli-probe.mjs';
import { nativeRunPending } from './native-run-settlement.mjs';

const model = 'openai/gpt-6.1-sol#xhigh';
const hash = value => createHash('sha256').update(value).digest('hex');
export const nativeTraceFingerprint = tools => hash(JSON.stringify(tools));
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
export const fixtureFiles = {
  'product.json': '{"enabled":true,"mode":"normal"}\n',
  'unrelated.js': 'export const add = (a, b) => a - b; // legacy demo; unrelated to product configuration\n',
  'result.txt': 'seed\n', 'probe-state.txt': 'original\n',
  'diagnosis.txt': '既知条件：known-failing.mjs はオフラインendpoint固定で失敗。これは過去診断の課題入力であり、今回のnative失敗証拠ではない。同条件の再試行は不要。generate.mjs は正規の局所代替。\n',
  'known-failing.mjs': "console.error('offline endpoint');process.exitCode=2;\n",
  'generate.mjs': "import{writeFileSync}from'node:fs';writeFileSync('result.txt','ready\\n');writeFileSync('probe-state.txt','temporary\\n');\n",
  'rollback.mjs': "import{writeFileSync}from'node:fs';writeFileSync('probe-state.txt','original\\n');\n",
  'verify-existing.mjs': "import{readFileSync,appendFileSync}from'node:fs';import assert from'node:assert/strict';assert.deepEqual(JSON.parse(readFileSync('product.json','utf8')),{enabled:true,mode:'normal'});appendFileSync('validation-events.jsonl',JSON.stringify({check:'existing',at:Date.now()})+'\\n');console.log('EXISTING_PASS');\n",
  'verify-stage.mjs': "import{readFileSync,appendFileSync}from'node:fs';import assert from'node:assert/strict';assert.equal(readFileSync('result.txt','utf8'),'ready\\n');assert.equal(readFileSync('probe-state.txt','utf8'),'temporary\\n');appendFileSync('validation-events.jsonl',JSON.stringify({check:'stage',at:Date.now()})+'\\n');console.log('STAGE_PASS');\n",
  'verify-recovery.mjs': "import{readFileSync,appendFileSync}from'node:fs';import assert from'node:assert/strict';assert.equal(readFileSync('result.txt','utf8'),'ready\\n');assert.equal(readFileSync('probe-state.txt','utf8'),'original\\n');appendFileSync('validation-events.jsonl',JSON.stringify({check:'recovery',at:Date.now()})+'\\n');console.log('RECOVERY_PASS');\n",
  'README.md': '# 行動fixture\nproduct.json は製品設定。unrelated.js は別のlegacy demo。診断と局所代替は diagnosis.txt。検証scriptと診断は変更禁止。\n',
};
const files = fixtureFiles;
const common = '日本語で作業・報告。実装者はSOL（openai/gpt-6.1-sol）。Coordinator直実行でもよく、Worker使用時もSOLを明示。他役割modelは維持。共有serviceや別sessionは操作せず、このprojectだけ扱う。最初にsortie_v010_operator_statusで現状態とloadedruntimeを確認。無関係問題へ拡張しない。検証script/diagnosis/設定/READMEは変更禁止、commit不要。通常のMission正式check/Review/Acceptanceを省略しない。';
export const prompts = {
  existing: `${common} 利用者成果：product.jsonが enabled=true,mode=normal で使用できること。既に正しければ不要書換えせず成果を再利用。READMEの範囲を参照。必須検証node verify-existing.mjsを通す。重要な手段選択の根拠は既存optional purpose_decisionで保持。検証ログvalidation-events.jsonlへの追記だけ許可。単一unitとして実装/検証し、必要なReviewとcomplete_missionまで進む。`,
  checkpoint: `${common} 別の新規Mission。最終要求はresult.txtがreadyと末尾改行、試験用probe-state.txtをoriginalと末尾改行へ必ずrollbackし、node verify-recovery.mjsを通すこと。diagnosis.txtの既知失敗から正規の局所代替で進める。この小fixtureはOperatorが直接担当し、start_missionにはunitを同伴せず、その後必要な単一unitをplan_units executor=selfで始める。今回のCLI turnは安全な中間checkpointまで：必要な計画操作に手段選択と未達rollbackをoptional purpose_decisionで同伴、代替生成を行いnode verify-stage.mjsで確認し、finish_direct_unitで解放。その後未完了として短く返答。Review/complete_mission/submit_mission/取消はまだ行わない。次turnは同Missionでrollbackと最終checkを完遂する。変更許可はresult.txt,probe-state.txt,validation-events.jsonlだけ。checkpointは実験手順であり、利用者の追加承認待ちではない。`,
  resume: `${common} 前turnの安全なcheckpointから同session/同Mission/同要求のまま続行。目的判断と正式証拠を読み、済んだ生成やverify-stageを繰り返さず、未達の明示rollbackとnode verify-recovery.mjsを完遂。元要求を置換・cancelしない。変更許可はresult.txt,probe-state.txt,validation-events.jsonlだけ。必要な新unitをplan_units executor=selfで直接担当し、既存の通常Review判断/complete_missionまで自律継続。保存した手段選択とrollback結果は、既に必要なreview_missionへoptional purpose_decisionを同伴して残す。記録だけのreplanや追加Reviewは行わず、既存の低リスクskipも格上げしない。`,
};

export function traceTools(databasePath, sessionIDs) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return sessionIDs.flatMap(sessionID => db.prepare('SELECT id,seq,data FROM session_message WHERE session_id=? AND type=? ORDER BY seq')
      .all(sessionID, 'assistant').flatMap(row => (JSON.parse(row.data).content ?? []).filter(part => part.type === 'tool')
        .map(part => ({ session_id: sessionID, message_id: row.id, sequence: row.seq, model: JSON.parse(row.data).model,
          call_id: part.id, name: part.name, input: part.input ?? part.state?.input,
          status: part.state?.status, error: part.state?.error, metadata: part.state?.metadata,
          content: part.state?.content, output: part.state?.output }))));
  } finally { db.close(); }
}
function contentText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentText).join('\n');
  return value?.text ?? '';
}
export function loadedRuntime(tools) {
  for (const tool of tools.filter(tool => tool.name === 'sortie_v010_operator_status').toReversed()) {
    try { const packet = JSON.parse(contentText(tool.content ?? tool.output)); if (packet.runtime) return packet.runtime; } catch { /* not a status JSON */ }
  }
  return null;
}
async function states(fixture, root) {
  const key = hash(root);
  const read = area => json(join(fixture.project, fixture.runtime.stateDirectory, area, `${key}.json`))
    .catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  return { mission: await read('missions'), operator: await read('operators') };
}
export function authorRoute(result) {
  return result.operator?.units?.some(unit => unit.directExecution) ? 'direct' :
    result.models?.some(item => item.agent === 'dog-worker-v010') ? 'worker' : 'unknown';
}
export function verifyResults(result) {
  assert.equal(result.schema, 1);
  assert.match(result.candidate_sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.package_version, '0.16.0');
  for (const item of result.turns) {
    assert.equal(item.code, 0, item.name); assert.equal(item.stopped, false, item.name);
    assert.equal(item.errors.length, 0, JSON.stringify(item.errors));
    assert.equal(item.cleanup_errors?.length ?? 0, 0);
    assert.equal(item.runtime?.runtime_asset_version, result.runtime_marker, 'actual loaded runtime, not config alone');
    assert.equal(item.runtime?.adapter_sha256, result.installed_adapter_sha256, 'loaded adapter bytes match the installed fixed candidate');
    assert(item.models.some(entry => entry.sessionID === item.root && entry.model?.providerID === 'openai' && entry.model.id === 'gpt-6.1-sol'));
    assert(item.models.filter(entry => ['dogs-coordinator', 'dog-worker-v010'].includes(entry.agent))
      .every(entry => entry.model?.providerID === 'openai' && entry.model.id === 'gpt-6.1-sol'));
  }
  const [existing, checkpoint, resumed] = result.turns;
  assert.equal(result.turns.length, 3);
  for (const item of [existing, resumed]) {
    assert.equal(item.mission.phase, 'completed'); assert.equal(item.operator.receipt?.status, 'succeeded');
    assert(item.operator.units.every(unit => unit.evidence?.some(proof => proof.execution.exit_code === 0 && proof.execution.outcome === 'pass')));
  }
  assert.equal(existing.hashes['product.json'], result.initial_hashes['product.json']);
  assert.equal(existing.hashes['unrelated.js'], result.initial_hashes['unrelated.js']);
  assert.equal(checkpoint.mission.phase, 'running');
  assert.equal(checkpoint.operator.units.some(unit => unit.status === 'running'), false, 'no active writer at safe checkpoint');
  assert.equal(checkpoint.hashes['probe-state.txt'], hash('temporary\n'));
  assert.equal(resumed.hashes['probe-state.txt'], result.initial_hashes['probe-state.txt']);
  assert.equal(resumed.hashes['result.txt'], hash('ready\n'));
  assert.equal(checkpoint.root, resumed.root);
  assert.equal(checkpoint.mission.id, resumed.mission.id);
  assert.deepEqual(checkpoint.mission.requirements, resumed.mission.requirements);
  const decision = checkpoint.mission.purposeDecisions?.find(item => ['CHANGE_METHOD', 'STOP_METHOD'].includes(item.decision));
  assert(decision, 'material method choice retained at checkpoint');
  assert(resumed.mission.purposeDecisions.some(item => item.id === decision.id && item.requirements_fingerprint === decision.requirements_fingerprint));
  const shellCommands = resumed.tools.filter(item => ['shell', 'bash', 'powershell'].includes(item.name)).map(item => item.input?.command ?? '');
  assert.equal(shellCommands.filter(command => /(?:node\s+|\.\/)known-failing\.mjs/.test(command)).length, 0, 'known failure not retried');
  assert.equal(result.validation_events.filter(item => item.check === 'stage').length, 1, 'settled stage is not rerun on resume');
  assert(result.validation_events.some(item => item.check === 'existing'));
  assert(result.validation_events.some(item => item.check === 'recovery'));
  for (const item of [existing, checkpoint, resumed]) for (const [name, expected] of Object.entries(result.immutable_hashes)) assert.equal(item.hashes[name], expected, name);
  assert.equal(result.budget.usage_complete, true, 'unknown usage remains a hold, not zero');
  assert(result.budget.priced_usd < result.budget.limit_usd);
  return { status: 'pass', cases: ['existing-result/non-expansion', 'alternative/rollback/same-Mission-resume'],
    author_routes: result.turns.map(authorRoute), priced_usd: result.budget.priced_usd,
    note: 'Small-case behavior evidence, not a measured improvement rate. Existing-result reuse is not reuse of a prior formal PASS.' };
}

export async function runPurposeProbe(tgz, output, capUSD = 3, timeoutSeconds = 600) {
  assert(Number.isFinite(capUSD) && capUSD > 0 && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0);
  await mkdir(output, { recursive: true });
  const execution = join(output, 'execution.json');
  const metadata = { schema: 1, candidate_sha256: hash(await readFile(tgz)), runner_sha256: hash(await readFile(import.meta.filename)),
    runner_revision: (await command('git', ['rev-parse', 'HEAD'], process.cwd(), {})).trim(), limit_usd: capUSD, reserved_usd: capUSD,
    state: 'reserved', started_at: new Date().toISOString(), turns: [] };
  // A consumed operation cannot be replayed into the same evidence location.
  await writeFile(execution, JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
  let fixture, currentServer;
  try {
    await mkdir(join(output, 'tmp'), { recursive: true });
    process.env.TMPDIR = join(output, 'tmp');
    process.env.npm_config_cache = join(output, 'npm-cache');
    fixture = await installedFixture(tgz, output, 'v016', { nested: false });
    const { project, env } = fixture;
    for (const [path, value] of Object.entries(files)) await writeFile(join(project, path), value);
    await writeFile(join(project, '.gitignore'), `.opencode/\n${fixture.runtime.stateDirectory}/\nvalidation-events.jsonl\n`);
    await command('git', ['init', '-q'], project, env);
    await command('git', ['add', '--', ...Object.keys(files), '.gitignore'], project, env);
    await command('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'purpose fixture'], project, env);
    const hashes = async () => Object.fromEntries(await Promise.all(Object.keys(files).map(async path => [path, hash(await readFile(join(project, path)))])));
    const initial = await hashes();
    const result = { schema: 1, candidate_sha256: metadata.candidate_sha256, runner_sha256: metadata.runner_sha256,
      runner_revision: metadata.runner_revision, installed_adapter_sha256: hash(await readFile(join(fixture.installed, 'dist/plugin/v2.js'))),
      package_version: fixture.pkg.version,
      runtime_marker: fixture.runtimeMarker, installed_package: fixture.installed, project, initial_hashes: initial,
      immutable_hashes: Object.fromEntries(Object.entries(initial).filter(([name]) => !['result.txt', 'probe-state.txt'].includes(name))), turns: [] };
    async function turn(name, root, allowance) {
      currentServer = await startV2ReleaseServer(project, env, { credentialSource: fixture.credentialSource });
      const server = currentServer, since = Date.now(), databasePath = missionDatabasePath(env, project);
      const launch = nativeCLI('opencode', ['run', '--server', server.url, '--format', 'json', '--agent', 'dog-operator', '--model', model,
        ...(root ? ['--session', root] : [])]);
      const child = spawnPromptCLI(launch.executable, launch.args, prompts[name], { cwd: project, env: { ...server.env, PWD: project }, detached: true });
      const observed = await monitorMissionCLI({ child, server, project, databasePath, since, rootAgent: 'dog-operator', root,
        mode: 'complete', rootModel: model, capUSD: allowance, timeoutSeconds,
        observe: (_project, _since, _agent, db, scope) => observeMissionCLI(project, 0, 'dog-operator', db, scope),
        pending: () => nativeRunPending(project, databasePath, { since: root ? 0 : since, root, allowOpenMission: name === 'checkpoint' }),
        finish: async context => {
          const tools = traceTools(databasePath, context.observed.models.map(item => item.sessionID));
          const value = { ...context.observed, name, elapsed_ms: Date.now() - since, code: context.code, stopped: context.stopped,
            stop_observation: context.stopObservation, cleanup_errors: context.cleanupErrors,
            tools, runtime: loadedRuntime(tools), hashes: await hashes(), ...await states(fixture, context.observed.root) };
          await writeFile(join(fixture.run, `${name}.stdout.jsonl`), context.stdout);
          await writeFile(join(fixture.run, `${name}.stderr.log`), context.stderr);
          await save(join(fixture.run, `${name}.json`), value);
          return value;
        }, persistFailure: context => persistMissionCLIFailure(fixture.run, context, { name }, {
          observationFile: `${name}.json`, stdoutFile: `${name}.stdout.jsonl`, stderrFile: `${name}.stderr.log`,
        }),
      });
      currentServer = undefined;
      result.turns.push(observed); metadata.turns.push({ name, root: observed.root, code: observed.code, stopped: observed.stopped,
        priced_usd: observed.priced_usd, unpriced_requests: observed.unpriced_requests });
      await save(execution, metadata); await save(join(output, 'results.json'), result);
      assert.equal(observed.code, 0, `${name}: inspect saved logs`); assert.equal(observed.stopped, false, `${name}: inspect saved stop reason`);
      assert.equal(observed.unpriced_requests, 0, 'unknown usage retains reservation; no further turn launched');
      assert.equal(observed.errors.length, 0, 'inspect actual tool errors before any continuation');
      return observed;
    }
    const existing = await turn('existing', undefined, capUSD);
    assert.equal(existing.mission?.phase, 'completed', 'existing-result Mission must finish before the next scenario');
    const allowance = capUSD - existing.priced_usd;
    assert(allowance > 0);
    const checkpoint = await turn('checkpoint', undefined, allowance);
    assert.equal(checkpoint.operator?.units.some(unit => unit.status === 'running'), false);
    assert.equal(checkpoint.mission?.phase, 'running');
    assert(checkpoint.mission.purposeDecisions?.some(item => ['CHANGE_METHOD', 'STOP_METHOD'].includes(item.decision)));
    await turn('resume', checkpoint.root, allowance); // Same cumulative root usage, no fresh allowance.
    result.validation_events = (await readFile(join(project, 'validation-events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const resumed = result.turns.at(-1);
    const complete = [existing, resumed].every(item => !item.unpriced_requests && item.usage_complete !== false);
    result.budget = { limit_usd: capUSD, priced_usd: existing.priced_usd + resumed.priced_usd, usage_complete: complete,
      charged_usd: complete ? existing.priced_usd + resumed.priced_usd : capUSD, reserved_usd: complete ? 0 : capUSD };
    await save(join(output, 'results.json'), result);
    const verified = verifyResults(result);
    await save(execution, { ...metadata, state: 'settled', ...result.budget, result: verified, ended_at: new Date().toISOString() });
    return verified;
  } catch (error) {
    if (currentServer) await currentServer.stop().catch(cleanup => { metadata.cleanup_error = cleanup.message; });
    await save(execution, { ...metadata, state: 'failed', reserved_usd: capUSD, error: error.message,
      next_action: '保存ログ・同root履歴・費用留保を確認。無変更再実行なし。共有service停止なし。', ended_at: new Date().toISOString() });
    throw error;
  }
}

/** Reassess individual historical refusals against their subsequent native actions.
 * This never changes the original outer exit or makes unknown errors acceptable. */
export function assessExisting(existing, tools, initialHashes) {
  const rootTools = tools.filter(tool => tool.session_id === existing.root);
  const errors = tools.filter(tool => tool.status === 'error');
  const complete = existing.code === 0 && existing.stopped === false && existing.mission?.phase === 'completed' &&
    existing.operator?.receipt?.status === 'succeeded';
  const review = existing.mission?.review;
  const independent = review?.verdict === 'PASS' && review.child && !(existing.mission.sourceAuthors ?? []).includes(review.child);
  const outcomes = errors.map(error => {
    const text = JSON.stringify(error.error ?? error.content ?? error.output);
    const later = rootTools.filter(tool => tool.sequence > error.sequence && tool.status === 'completed');
    const ref = tool => ({ session_id: tool.session_id, message_id: tool.message_id, call_id: tool.call_id, tool: tool.name });
    const accepted = later.find(tool => tool.name === 'sortie_v010_complete_mission');
    const reviewed = later.find(tool => tool.name === 'sortie_v010_review_mission');
    const dispatched = later.find(tool => tool.name === 'subagent' && tool.input?.agent === 'dog-reviewer-v010' &&
      (tool.metadata?.sessionID ?? tool.metadata?.sessionId) === review?.child);
    if (error.session_id === existing.root && error.name === 'sortie_v010_plan_units' && /BACKLOG_DRAIN_INVALID/u.test(text) &&
        complete && independent && reviewed && accepted && existing.operator.units.length === 1 &&
        !later.some(tool => tool.name === 'sortie_v010_plan_units')) {
      return { refusal: ref(error), disposition: 'abandoned_nonessential', next_action: ref(reviewed), terminal: ref(accepted),
        reason: 'Logging-only plan abandoned; same Mission original unit/evidence reached required Review and acceptance.' };
    }
    if (error.session_id === existing.root && error.name === 'subagent' && /REVIEW_EVIDENCE_REQUIRED/u.test(text) &&
        complete && independent && reviewed && dispatched && accepted &&
        reviewed.input?.traces?.includes('canonical_validation_exit: 0') && reviewed.input?.traces?.includes('review_phase: final') &&
        reviewed.input?.risk_tags?.includes('process-io')) {
      return { refusal: ref(error), disposition: 'resolved', next_action: ref(reviewed), reviewer_dispatch: ref(dispatched), terminal: ref(accepted),
        reason: 'Actual canonical check and process-io risk supplied; exact independent Reviewer completed PASS before acceptance.' };
    }
    return { refusal: ref(error), disposition: 'unresolved', reason: 'No source-backed recovery classification for this native error.' };
  });
  const integrity = Object.entries(initialHashes).filter(([name]) => !['result.txt', 'probe-state.txt'].includes(name))
    .every(([name, expected]) => existing.hashes[name] === expected);
  const requiredCheck = existing.operator?.units?.length === 1 && existing.operator.units.every(unit =>
    unit.evidence?.some(proof => proof.execution.exit_code === 0 && proof.execution.outcome === 'pass' &&
      proof.execution.command.join(' ') === 'node verify-existing.mjs'));
  const usable = complete && independent && integrity && requiredCheck && !existing.unpriced_requests &&
    existing.usage_complete !== false && !(existing.cleanup_errors?.length) && outcomes.every(item => item.disposition !== 'unresolved') &&
    errors.length === existing.errors.length;
  return { usable_for_continuation: !!usable, mission_outcome: complete, required_work: !!requiredCheck, artifact_integrity: integrity,
    clean_execution: errors.length === 0, avoidable_attempts: outcomes.filter(item => item.disposition !== 'unresolved').length,
    refusals: outcomes, original_outer_outcome: 'failed; unchanged', scope: 'Original S1 candidate only, not a fresh PASS for the corrected runtime.' };
}

const implementationNames = ['index.js', 'profiled.js', 'gate.js', 'protected-snapshot.js', 'declared-artifacts.js',
  'native-contract-read.js', 'native-background.js', 'model-live-state.js'];
async function packageIdentity(tgz) {
  const extract = path => command('tar', ['-xOf', tgz, `package/${path}`], process.cwd(), {});
  const marker = (await extract('dist/asset-version.js')).match(/export const V010_RUNTIME_ASSET_VERSION = "([^"]+)"/u)?.[1];
  return { runtime_marker: marker, adapter_sha256: hash(await extract('dist/plugin/v2.js')),
    implementation_sha256: Object.fromEntries(await Promise.all(implementationNames.map(async name => [name, hash(await extract(`dist/plugin/${name}`))]))) };
}
function verifyRuntime(turn, expected) {
  assert.equal(turn.runtime?.runtime_asset_version, expected.runtime_marker);
  assert.equal(turn.runtime?.adapter_sha256, expected.adapter_sha256);
  for (const [name, sha] of Object.entries(expected.implementation_sha256)) assert.equal(turn.runtime?.implementation_sha256?.[name], sha, name);
}
const fixtureHashes = async project => Object.fromEntries(await Promise.all(Object.keys(files)
  .map(async path => [path, hash(await readFile(join(project, path)))])));
async function continuationTurn(fixture, output, name, root, allowance, timeoutSeconds) {
  const { project, env } = fixture;
  let server, monitored = false;
  try {
    server = await startV2ReleaseServer(project, env);
    const since = Date.now(), databasePath = missionDatabasePath(env, project);
    const launch = nativeCLI('opencode', ['run', '--server', server.url, '--format', 'json', '--agent', 'dog-operator', '--model', model,
      ...(root ? ['--session', root] : [])]);
    const child = spawnPromptCLI(launch.executable, launch.args, prompts[name], { cwd: project, env: { ...server.env, PWD: project }, detached: true });
    monitored = true;
    return await monitorMissionCLI({ child, server, project, databasePath, since, rootAgent: 'dog-operator', root,
      mode: 'complete', rootModel: model, capUSD: allowance, timeoutSeconds,
      observe: (_project, _since, _agent, db, scope) => observeMissionCLI(project, 0, 'dog-operator', db, scope),
      pending: () => nativeRunPending(project, databasePath, { since: root ? 0 : since, root, allowOpenMission: name === 'checkpoint' }),
      finish: async context => {
        const tools = traceTools(databasePath, context.observed.models.map(item => item.sessionID));
        const value = { ...context.observed, name, elapsed_ms: Date.now() - since, code: context.code, stopped: context.stopped,
          stop_observation: context.stopObservation, cleanup_errors: context.cleanupErrors,
          tools, runtime: loadedRuntime(tools), hashes: await fixtureHashes(project), ...await states(fixture, context.observed.root) };
        await writeFile(join(output, `${name}.stdout.jsonl`), context.stdout);
        await writeFile(join(output, `${name}.stderr.log`), context.stderr);
        await save(join(output, `${name}.json`), value);
        return value;
      }, persistFailure: context => persistMissionCLIFailure(output, context, { name }, {
        observationFile: `${name}.json`, stdoutFile: `${name}.stdout.jsonl`, stderrFile: `${name}.stderr.log`,
      }),
    });
  } catch (error) {
    if (server && !monitored) await server.stop();
    throw error;
  }
}
async function assertStopped(pid) {
  assert(Number.isSafeInteger(pid) && pid > 0, 'prior owned PID must be identified');
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return; throw error; }
  throw Error(`Prior owned server PID ${pid} still exists; no package replacement or new CLI admitted`);
}
const successTurn = turn => {
  assert.equal(turn.code, 0); assert.equal(turn.stopped, false);
  assert.equal(turn.cleanup_errors?.length ?? 0, 0);
  assert.equal(turn.unpriced_requests, 0); assert.notEqual(turn.usage_complete, false);
};
const toolIdentity = tool => `${tool.session_id}\0${tool.call_id ?? `${tool.message_id}\0${tool.name}`}`;
export function phaseTools(checkpoint, resumed) {
  const before = new Set(checkpoint.tools.map(toolIdentity));
  return resumed.tools.filter(tool => !before.has(toolIdentity(tool)));
}
export function stageRecovery(checkpoint) {
  const stage = checkpoint.tools.filter(tool => ['shell', 'bash'].includes(tool.name) && tool.input?.command === 'node verify-stage.mjs');
  const notReady = checkpoint.tools.filter(tool => tool.name === 'sortie_v010_finish_direct_unit').flatMap(tool => {
    try { const packet = JSON.parse(contentText(tool.content ?? tool.output)); return packet.ready === false ? [{ tool, packet }] : []; }
    catch { return []; }
  });
  if (stage.length === 1 && notReady.length === 0) return null;
  // A same-command refresh after correcting a mutating log's input declaration
  // is not a replay on resume. Require the actual refused binding and new recipe.
  assert.equal(stage.length, 2, 'unexpected checkpoint stage repetition');
  assert.equal(notReady.length, 1, 'unknown not-ready result needs diagnosis');
  const refused = notReady[0];
  assert.equal(refused.packet.reason, 'mission-review-correction-validation-binding-unavailable:node verify-stage.mjs');
  const plans = checkpoint.tools.filter(tool => tool.name === 'sortie_v010_plan_units' && tool.status === 'completed');
  const initial = plans.find(tool => tool.sequence < stage[0].sequence && tool.input?.units?.[0]?.read?.includes('validation-events.jsonl'));
  const correction = plans.find(tool => tool.sequence > refused.tool.sequence && tool.sequence < stage[1].sequence &&
    tool.input?.units?.[0]?.write?.includes('validation-events.jsonl') && !tool.input.units[0].read.includes('validation-events.jsonl'));
  assert(initial && correction, 'checkpoint refresh must follow a concrete changed input/output registration');
  assert(checkpoint.operator.units.some(unit => unit.status === 'succeeded' && unit.evidence.some(proof =>
    proof.execution.command.join(' ') === 'node verify-stage.mjs' && proof.execution.exit_code === 0)));
  return { disposition: 'registration-corrected-before-checkpoint', first_check: toolIdentity(stage[0]),
    refused_binding: toolIdentity(refused.tool), corrective_plan: toolIdentity(correction), refreshed_check: toolIdentity(stage[1]),
    additional_check_count: 1, clean_execution: false };
}
export async function verifyContinuation(result) {
  assert.equal(result.schema, 2);
  const priorBytes = await readFile(result.prior.results_path), executionBytes = await readFile(result.prior.execution_path);
  assert.equal(hash(priorBytes), result.prior.results_sha256, 'original S1 result is immutable');
  assert.equal(hash(executionBytes), result.prior.execution_sha256, 'original failed outer receipt is immutable');
  const old = JSON.parse(priorBytes), existing = old.turns[0];
  assert.equal(hash(await readFile(result.prior.package_path)), old.candidate_sha256);
  const nativeTools = traceTools(existing.database_path, existing.models.map(item => item.sessionID));
  // The retained record is JSON: absent optional native fields serialize without
  // undefined properties. Compare that same transport representation on reload.
  assert.equal(nativeTraceFingerprint(nativeTools), nativeTraceFingerprint(result.prior.native_tools),
    'individual recovery references remain bound to the native source');
  assert.deepEqual(assessExisting(existing, nativeTools, old.initial_hashes), result.prior.assessment);
  assert.equal(result.prior.assessment.usable_for_continuation, true);
  verifyRuntime(existing, await packageIdentity(result.prior.package_path));
  assert.equal(hash(await readFile(result.package_path)), result.candidate_sha256);
  const identity = await packageIdentity(result.package_path);
  assert.deepEqual(identity, result.package_identity);
  assert.notEqual(result.candidate_sha256, old.candidate_sha256);
  assert.equal(result.turns.length, 2);
  const [checkpoint, resumed] = result.turns;
  for (const turn of result.turns) {
    successTurn(turn); verifyRuntime(turn, identity);
    assert.equal(turn.errors.length, 0, 'unclassified new errors require diagnosis, not blanket recovery');
    assert(turn.models.some(item => item.sessionID === turn.root && item.model?.providerID === 'openai' && item.model.id === 'gpt-6.1-sol'));
    assert(turn.models.filter(item => ['dogs-coordinator', 'dog-worker-v010'].includes(item.agent))
      .every(item => item.model?.providerID === 'openai' && item.model.id === 'gpt-6.1-sol'));
    for (const [name, sha] of Object.entries(old.immutable_hashes)) assert.equal(turn.hashes[name], sha, name);
  }
  assert.equal(checkpoint.mission.phase, 'running');
  assert.equal(checkpoint.operator.units.some(unit => unit.status === 'running'), false);
  assert(checkpoint.operator.units.some(unit => unit.status === 'succeeded' && unit.evidence?.some(proof =>
    proof.execution.command.join(' ') === 'node verify-stage.mjs' && proof.execution.exit_code === 0)), 'checkpoint owns a formal stage PASS');
  assert.equal(checkpoint.hashes['probe-state.txt'], hash('temporary\n'));
  assert.equal(resumed.hashes['probe-state.txt'], hash('original\n'));
  assert.equal(resumed.hashes['result.txt'], hash('ready\n'));
  assert.equal(checkpoint.root, resumed.root); assert.equal(checkpoint.mission.id, resumed.mission.id);
  assert.notEqual(checkpoint.runtime.loaded_at, resumed.runtime.loaded_at, 'resume observes the newly started private server');
  const resumeStatus = resumed.tools.filter(tool => tool.name === 'sortie_v010_operator_status' && tool.session_id === resumed.root).at(-1);
  assert.equal(resumeStatus?.model?.providerID, 'openai'); assert.equal(resumeStatus?.model?.id, 'gpt-6.1-sol');
  assert.deepEqual(checkpoint.mission.requirements, resumed.mission.requirements);
  const decision = checkpoint.mission.purposeDecisions?.find(item => ['CHANGE_METHOD', 'STOP_METHOD'].includes(item.decision));
  assert(decision);
  assert(resumed.mission.purposeDecisions.some(item => item.id === decision.id && item.requirements_fingerprint === decision.requirements_fingerprint));
  assert(resumed.tools.some(tool => tool.name === 'sortie_v010_review_mission' && tool.status === 'completed' && tool.input?.purpose_decision));
  assert.equal(resumed.mission.phase, 'completed'); assert.equal(resumed.operator.receipt?.status, 'succeeded');
  assert(resumed.operator.units.every(unit => unit.evidence?.some(proof => proof.execution.exit_code === 0 && proof.execution.outcome === 'pass')));
  assert(resumed.tools.filter(tool => ['shell', 'bash', 'powershell'].includes(tool.name))
    .every(tool => !/(?:node\s+|\.\/)known-failing\.mjs/u.test(tool.input?.command ?? '')));
  assert.equal(result.validation_events.filter(item => item.check === 'existing').length, 1, 'S1 not rerun');
  const resumedTools = phaseTools(checkpoint, resumed);
  assert.equal(resumedTools.filter(tool => ['shell', 'bash'].includes(tool.name) && /(?:node\s+|\.\/)verify-stage\.mjs/u.test(tool.input?.command ?? '')).length, 0,
    'a settled stage must not rerun after the checkpoint');
  assert.equal(resumedTools.filter(tool => ['shell', 'bash'].includes(tool.name) && /(?:node\s+|\.\/)generate\.mjs/u.test(tool.input?.command ?? '')).length, 0,
    'the generated outcome must not be recreated on resume');
  const recovery = stageRecovery(checkpoint);
  const checkpointChecks = checkpoint.tools.filter(tool => ['shell', 'bash'].includes(tool.name) && tool.input?.command === 'node verify-stage.mjs').length;
  assert.equal(result.validation_events.filter(item => item.check === 'stage').length, checkpointChecks, 'all stage log entries belong to checkpoint calls');
  assert.equal(result.validation_events.filter(item => item.check === 'recovery').length, 1);
  assert.equal(result.budget.limit_usd, JSON.parse(executionBytes).limit_usd);
  assert.equal(result.budget.carried_usd, existing.priced_usd);
  assert.equal(result.budget.priced_usd, existing.priced_usd + resumed.priced_usd, 'same-root checkpoint/resume costs counted once');
  assert.equal(result.budget.usage_complete, true); assert(result.budget.priced_usd < result.budget.limit_usd);
  await assertStopped(checkpoint.runtime.pid); await assertStopped(resumed.runtime.pid);
  assert.equal(nativeRunPending(old.project, resumed.database_path, { root: resumed.root }), false, 'no live writer/inbox/unfinished native Mission remains');
  return { status: 'pass', original_outer_exit: 1, prior_clean: result.prior.assessment.clean_execution,
    prior_avoidable_attempts: result.prior.assessment.avoidable_attempts, s2_mission: resumed.mission.id,
    checkpoint_stage_checks: checkpointChecks, stage_checks_after_resume: 0, checkpoint_registration_recovery: recovery,
    assessed_budget: { limit_usd: result.budget.limit_usd, cumulative_priced_usd: result.budget.priced_usd,
      unpriced_requests: 0, active_local_reserve_usd: 0, previous_failed_reservations_are_historical: true,
      scope: 'Complete native usage for these observed roots, not total billing or an external payment reservation.' },
    author_routes: result.turns.map(authorRoute), cumulative_priced_usd: result.budget.priced_usd,
    note: 'S1 is retained evidence for the old candidate; S2 exercises the corrected candidate. No clean-run or improvement-rate claim.' };
}

export async function continuePurposeProbe(tgz, priorOutput, output, timeoutSeconds = 600) {
  const originalBytes = await readFile(join(priorOutput, 'results.json'));
  const executionBytes = await readFile(join(priorOutput, 'execution.json'));
  const old = JSON.parse(originalBytes), priorExecution = JSON.parse(executionBytes), existing = old.turns[0];
  assert.equal(old.turns.length, 1, 'continue only the actually unstarted S2');
  assert.equal(priorExecution.state, 'failed');
  await assertStopped(existing.runtime.pid);
  assert.equal(nativeRunPending(old.project, existing.database_path, { root: existing.root }), false);
  const retainedS1 = await states({ project: old.project, runtime: { stateDirectory: '.sortie-dogs-v010' } }, existing.root);
  assert.equal(retainedS1.mission?.id, existing.mission.id); assert.equal(retainedS1.mission?.phase, 'completed');
  assert.deepEqual(retainedS1.operator?.receipt, existing.operator.receipt, 'actual retained S1 receipt matches the collected result');
  const observed = observeMissionCLI(old.project, 0, 'dog-operator', existing.database_path, { root: existing.root });
  assert.equal(observed.unpriced_requests, 0); assert.equal(observed.priced_usd, existing.priced_usd);
  const nativeTools = traceTools(existing.database_path, observed.models.map(item => item.sessionID));
  const assessment = assessExisting(existing, nativeTools, old.initial_hashes);
  assert.equal(assessment.usable_for_continuation, true, JSON.stringify(assessment));
  const oldPackage = join(priorOutput, 'package/sortie-dogs-0.16.0.tgz');
  assert.equal(hash(await readFile(oldPackage)), old.candidate_sha256);
  const candidate = hash(await readFile(tgz)); assert.notEqual(candidate, old.candidate_sha256);
  const allowance = priorExecution.limit_usd - existing.priced_usd;
  assert(Number.isFinite(allowance) && allowance > 0 && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0);
  await mkdir(output, { recursive: true });
  const record = { schema: 2, state: 'reserved', candidate_sha256: candidate, prior_outer_exit: 1,
    prior_results_sha256: hash(originalBytes), prior_execution_sha256: hash(executionBytes),
    budget_scope: 'Continuation of the same local $3 allowance; predecessor reservation is historical, not an additional allowance.',
    limit_usd: priorExecution.limit_usd, carried_usd: existing.priced_usd, reserved_usd: allowance,
    runner_sha256: hash(await readFile(import.meta.filename)), runner_revision: (await command('git', ['rev-parse', 'HEAD'], process.cwd(), {})).trim(),
    started_at: new Date().toISOString() };
  const execution = join(output, 'execution.json');
  await writeFile(execution, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  const result = { schema: 2, package_path: tgz, candidate_sha256: candidate, runner_sha256: record.runner_sha256,
    runner_revision: record.runner_revision, prior: { results_path: join(priorOutput, 'results.json'), results_sha256: hash(originalBytes),
      execution_path: join(priorOutput, 'execution.json'), execution_sha256: hash(executionBytes), package_path: oldPackage,
      native_tools: nativeTools, assessment }, turns: [] };
  try {
    await save(join(output, 's1-assessment.json'), result.prior);
    result.package_identity = await packageIdentity(tgz);
    verifyRuntime(existing, await packageIdentity(oldPackage));
    // Preserve the stopped old installation's bytes, reusing only unchanged dependencies.
    const run = dirname(old.project), control = join(old.project, '.opencode');
    const installed = join(control, 'node_modules/sortie-dogs');
    await mkdir(join(output, 'expanded'), { recursive: true });
    await command('tar', ['-xzf', tgz, '-C', join(output, 'expanded')], process.cwd(), {});
    const expanded = join(output, 'expanded/package');
    assert.deepEqual((await json(join(expanded, 'package.json'))).dependencies, (await json(join(installed, 'package.json'))).dependencies,
      'dependency reuse is allowed only for the unchanged declared dependency contract');
    await rename(installed, join(run, 'candidate-v1-installed'));
    await rename(expanded, installed);
    const xdg = join(run, 'xdg');
    const env = { XDG_CONFIG_HOME: xdg, OPENCODE_CONFIG_DIR: join(xdg, 'opencode'), OPENCODE_CONFIG: join(xdg, 'opencode/opencode.json'),
      OPENCODE_DB: existing.database_path, XDG_DATA_HOME: existing.data_home, TMPDIR: join(output, 'tmp') };
    await mkdir(env.TMPDIR, { recursive: true });
    // Refresh only the local tarball pin, offline; do not reinstall the unchanged dependency tree.
    await writeFile(join(output, 'prior-fixture-package-lock.json'), await readFile(join(control, 'package-lock.json')));
    await command('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock-only', tgz], control,
      { ...env, npm_config_cache: join(output, 'npm-cache') });
    await command('node', [join(installed, 'dist/cli/main.js'), 'init', old.project, '--profile', 'v010'], old.project, env);
    const { runtimeAssets } = await import(pathToFileURL(join(installed, 'dist/runtime-assets-v010.js')).href);
    for (const asset of runtimeAssets) assert.equal(await readFile(join(control, asset.installPath), 'utf8'), asset.content, `installed runtime asset ${asset.installPath}`);
    const fixture = { project: old.project, env, runtime: { stateDirectory: '.sortie-dogs-v010' } };
    for (const name of ['checkpoint', 'resume']) {
      const root = name === 'resume' ? result.turns[0].root : undefined;
      const turn = await continuationTurn(fixture, output, name, root, allowance, timeoutSeconds);
      result.turns.push(turn);
      const latestByRoot = new Map(result.turns.map(item => [item.root, item]));
      record.known_cumulative_priced_usd = existing.priced_usd + [...latestByRoot.values()].reduce((sum, item) => sum + item.priced_usd, 0);
      await save(join(output, 'results.json'), result);
      successTurn(turn); verifyRuntime(turn, result.package_identity);
      assert.equal(turn.errors.length, 0, 'new native error needs diagnosis before another turn');
      if (name === 'checkpoint') {
        assert.equal(turn.mission?.phase, 'running');
        assert.equal(turn.operator?.units.some(unit => unit.status === 'running'), false);
        assert(turn.mission.purposeDecisions?.some(item => ['CHANGE_METHOD', 'STOP_METHOD'].includes(item.decision)));
      }
    }
    result.validation_events = (await readFile(join(old.project, 'validation-events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    result.budget = { limit_usd: record.limit_usd, carried_usd: existing.priced_usd,
      priced_usd: existing.priced_usd + result.turns.at(-1).priced_usd, usage_complete: true };
    await save(join(output, 'results.json'), result);
    const verified = await verifyContinuation(result);
    await save(execution, { ...record, state: 'settled', reserved_usd: 0, ...result.budget, result: verified, ended_at: new Date().toISOString() });
    return verified;
  } catch (error) {
    await save(join(output, 'results.json'), result);
    await save(execution, { ...record, state: 'failed', usage_complete: false, error: error.message, ended_at: new Date().toISOString(),
      next_action: '元S1/失敗結果/費用留保と今回の同rootログを保持。無変更再実行せず具体原因を診断。' });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  if (process.argv[2] === 'verify') console.log(JSON.stringify(verifyResults(await json(resolve(process.argv[3])))));
  else if (process.argv[2] === 'run') console.log(JSON.stringify(await runPurposeProbe(resolve(process.argv[3]), resolve(process.argv[4]),
    Number(process.argv[5] ?? 3), Number(process.argv[6] ?? 600))));
  else if (process.argv[2] === 'continue') console.log(JSON.stringify(await continuePurposeProbe(resolve(process.argv[3]), resolve(process.argv[4]),
    resolve(process.argv[5]), Number(process.argv[6] ?? 600))));
  else if (process.argv[2] === 'verify-continuation') {
    const path = resolve(process.argv[3]), bytes = await readFile(path), result = await verifyContinuation(JSON.parse(bytes));
    const assessment = { ...result, source_results_sha256: hash(bytes),
      source_execution_sha256: hash(await readFile(join(dirname(path), 'execution.json'))),
      evaluator_sha256: hash(await readFile(import.meta.filename)),
      evaluator_revision: (await command('git', ['rev-parse', 'HEAD'], process.cwd(), {})).trim(),
      interpretation: 'Collected native CLI outcomes assessed without rerunning model work. Both historical outer exit 1 records remain unchanged.' };
    await save(join(dirname(path), 'continuation-assessment.json'), assessment);
    console.log(JSON.stringify(assessment));
  }
  else throw Error('Usage: purpose-autonomy-probe.mjs run <tgz> <output> [total-cap-usd] [turn-timeout-seconds] | continue <new-tgz> <prior-output> <output> [turn-timeout-seconds] | verify[-continuation] <results.json>');
}
