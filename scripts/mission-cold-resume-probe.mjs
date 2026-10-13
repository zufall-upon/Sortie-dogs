import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { probe, observeMissionCLI, monitorMissionCLI, persistMissionCLIFailure } from './mission-cli-probe.mjs';
import { nativeRunPending } from './native-run-settlement.mjs';
import { startV2ReleaseServer } from './release-cli.mjs';

// A real native Worker is interrupted with its server. The next user turn uses a new
// plugin instance and the same root; fixture state is never manually repaired.
const tgz = resolve(process.argv[2]), output = resolve(process.argv[3]);
const started = await probe(tgz, output, { mode: 'start', timeoutSeconds: 240, capUSD: 1,
  model: 'openai/gpt-6-luna-fast#max',
  prompt: '2段階の作業です。Coordinatorへ委譲して進めてください。第1段階: result.txtをrecoveredと末尾改行へ変更、node check.mjsで確認。第2段階: result.txtを読んでreceipt.txtにconfirmedと末尾改行を保存、node check-receipt.mjsで確認。check*.mjsと設定は変更しない。',
  setupFixture: async ({ project }) => writeFile(join(project, 'check-receipt.mjs'),
    'import{readFileSync}from"node:fs";import assert from"node:assert/strict";assert.equal(readFileSync("receipt.txt","utf8"),"confirmed\\n");\n'),
});
assert.equal(started.stopped, 'worker-started', JSON.stringify(started));
assert.ok(started.models.some(item => item.agent === 'dogs-coordinator'), 'Exercise nested native dispatch');
const run = dirname(started.project), xdg = join(run, 'xdg');
const env = { XDG_CONFIG_HOME: xdg, OPENCODE_CONFIG_DIR: join(xdg, 'opencode'), OPENCODE_CONFIG: join(xdg, 'opencode/opencode.json'),
  OPENCODE_DB: started.database_path, XDG_DATA_HOME: started.data_home };
const observe = () => observeMissionCLI(started.project, 0, 'dog-operator', started.database_path, { root: started.root });
const baselineSince = Date.now();
async function persistPrelaunchFailure(error, observed, stage, server) {
  // No continuation has launched. Preserve startup evidence and known cumulative
  // usage, but do not settle the unresolved coverage as zero or replay startup.
  const isBaseline = stage === 'baseline', isCLILaunch = stage === 'cli-launch';
  const cleanupErrors = [];
  // A synchronous spawn failure never reaches the shared monitor. Only this
  // caller's already-obtained server handle needs teardown; preserve the launch cause.
  if (isCLILaunch) try { await server.stop(); }
  catch (cleanupError) { cleanupErrors.push({ resource: 'server', name: cleanupError.name,
    message: String(cleanupError.message).slice(0, 1500),
    ...(cleanupError.code === undefined ? {} : { code: cleanupError.code }) }); }
  const failure = { name: error.name, message: String(error.message).slice(0, 1500),
    ...(error.code === undefined ? {} : { code: error.code }) };
  const result = { ...started, ...observed, mode: 'complete',
    stopped: isBaseline ? 'observation-failed' : isCLILaunch ? 'cli-launch-failed' : 'server-start-failed', stop_observation: stage,
    code: null, signal: null, controller_signal: null, cli_started: false,
    ...(isBaseline ? { resume_server_started: false } : { server_start_attempted: true, resume_server_ready: isCLILaunch }),
    ...(isCLILaunch ? { cli_start_attempted: true, server_url: server.url ?? null,
      cleanup_complete: cleanupErrors.length === 0, ...(cleanupErrors.length ? { cleanup_errors: cleanupErrors } : {}) } : {}),
    usage_complete: false, known_unpriced_requests: observed.known_unpriced_requests ?? observed.unpriced_requests,
    unpriced_requests: Math.max(1, observed.unpriced_requests), accepted: false, native_completed: false,
    ...(isBaseline ? { observation_error: failure } : isCLILaunch ? { cli_error: failure } : { server_error: failure }),
    intentional_interruption_errors: observed.errors, resume_errors: [], elapsed_ms: Date.now() - baselineSince,
    failure_recorded: true,
    next_action: isBaseline
      ? 'Inspect the recorded owned database read failure and retained startup receipt; reconcile cumulative session usage before deciding continuation. No resume CLI/server was launched. Do not automatically replay the consumed startup/task or restart the shared host.'
      : isCLILaunch ? cleanupErrors.length
        ? 'Retry teardown only for the recorded owned server and verify it stopped, then inspect the recorded CLI launch error and reconcile cumulative baseline/startup receipt/database usage. No resume CLI handle was obtained. Do not automatically replay the consumed startup/task or restart the shared host.'
        : 'Inspect the recorded CLI launch error, executable and working directory; reconcile cumulative baseline/startup receipt/database usage before deciding continuation. No resume CLI handle was obtained; the owned server was stopped. Do not automatically replay the consumed startup/task or restart the shared host.'
      : 'Inspect the recorded owned server startup failure and retained cumulative baseline/startup receipt; verify any process from the failed owned start has stopped, then reconcile session usage before deciding continuation. No resume CLI was launched. Do not automatically replay the consumed startup/task or restart the shared host.' };
  try { await writeFile(join(run, 'cold-resume-observation.json'), JSON.stringify(result, null, 2) + '\n'); }
  catch (persistenceError) {
    // If the sink is unavailable, retain the original failure plus fresh evidence.
    error.monitorContext = { observed: { ...result, failure_recorded: false }, databasePath: started.database_path, stdout: '', stderr: '',
      code: null, signal: null, stopped: result.stopped, stopObservation: stage, cleanupErrors,
      ...(isBaseline ? { observationError: failure } : isCLILaunch ? { cliError: failure } : { serverError: failure }),
      persistence_complete: false, failure_recorded: false,
      persistenceError: { name: persistenceError.name, message: String(persistenceError.message).slice(0, 1500),
        ...(persistenceError.code === undefined ? {} : { code: persistenceError.code }) },
      nextAction: isBaseline
        ? 'Inspect the recorded owned evidence path and retain unresolved usage holds; retry only failed evidence persistence after reconciling the startup receipt/database. No resume CLI/server was launched. Do not automatically replay the consumed startup/task or restart the shared host.'
        : isCLILaunch ? cleanupErrors.length
          ? 'Retry teardown only for the recorded owned server and verify it stopped, then retain unresolved usage holds and retry only failed evidence persistence after reconciling the cumulative baseline/startup receipt/database. No resume CLI handle was obtained. Do not automatically replay the consumed startup/task or restart the shared host.'
          : 'Inspect the recorded owned evidence path and retain unresolved usage holds; retry only failed evidence persistence after reconciling the cumulative baseline/startup receipt/database. No resume CLI handle was obtained; the owned server was stopped. Do not automatically replay the consumed startup/task or restart the shared host.'
        : 'Inspect the recorded owned evidence path and retain unresolved usage holds; verify any process from the failed owned server start has stopped, then retry only failed evidence persistence after reconciling the cumulative baseline/startup receipt/database. No resume CLI was launched. Do not automatically replay the consumed startup/task or restart the shared host.' };
  }
  throw error;
}
let baseline;
try { baseline = observe(); }
catch (error) { await persistPrelaunchFailure(error, started, 'baseline'); }
const previousErrors = new Set(baseline.errors.map(error => JSON.stringify(error)));
let server;
try { server = await startV2ReleaseServer(started.project, env); }
catch (error) { await persistPrelaunchFailure(error, baseline, 'server-start'); }
const since = Date.now();
const request = '前回の作業を置き換えます。旧runは中断済みです。start_missionのintent=replaceで現在の要件を保存し、古いreceipt.txt作成要件は取り消してください。現在の要件はresult.txtをrecoveredと末尾改行にしてnode check.mjsを通すことだけです。check*.mjs・設定は変更しない。単一unitのFast-laneで、既存の費用を継承して実行し、低リスクreview skipとcomplete_missionまで完了してください。';
let child;
try { child = spawn('opencode', ['run', '--server', server.url, '--session', started.root, '--format', 'json',
  '--agent', 'dog-operator', '--model', 'openai/gpt-6-luna-fast#max', request], {
  cwd: started.project, env: { ...process.env, ...server.env, PWD: started.project }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
}); }
catch (error) { await persistPrelaunchFailure(error, baseline, 'cli-launch', server); }
const key = createHash('sha256').update(started.root).digest('hex');
const metadata = observed => ({ candidate_sha256: started.candidate_sha256, root: started.root,
  initial_worker: started.models.find(item => item.agent === 'dog-worker-v010'),
  intentional_interruption_errors: baseline.errors, resume_errors: observed.errors.filter(error => !previousErrors.has(JSON.stringify(error))),
  elapsed_ms: Date.now() - since });
const result = await monitorMissionCLI({ child, server, project: started.project, databasePath: started.database_path,
  root: started.root,
  since, rootAgent: 'dog-operator', mode: 'complete', rootModel: 'openai/gpt-6-luna-fast#max',
  capUSD: 2, timeoutSeconds: 600, observe,
  // The same old root owns cumulative usage and queued continuations. Do not
  // filter it out by the newer resume-launch timestamp or grant a fresh allowance.
  pending: () => nativeRunPending(started.project, started.database_path, { since: 0, root: started.root }),
  finish: async ({ observed, stdout, stderr, stopped, stopObservation, code, signal, controllerSignal,
    observationError, cliError, cleanupErrors, nextAction }) => {
    const mission = JSON.parse(await readFile(join(started.project, '.sortie-dogs-v010/missions', key + '.json')));
    const operator = JSON.parse(await readFile(join(started.project, '.sortie-dogs-v010/operators', key + '.json')));
    const result = { ...observed, ...metadata(observed), code, signal: signal ?? null, stopped,
      stop_observation: stopObservation ?? null, controller_signal: controllerSignal ?? null,
      cutoff: ['budget', 'timeout'].includes(stopped) ? stopped : undefined,
      ...(observationError ? { observation_error: observationError } : {}),
      ...(cliError ? { cli_error: cliError } : {}),
      ...(cleanupErrors.length ? { cleanup_complete: false, cleanup_errors: cleanupErrors,
        cli_pid: child.pid ?? null, server_url: server.url ?? null } : {}),
      ...(nextAction || stopped ? { next_action: nextAction ??
        'Inspect the saved cold-resume receipt, cumulative owned usage and CLI logs before deciding the next operation. Do not automatically replay the consumed task or restart the shared host.' } : {}),
      mission: { id: mission.id, phase: mission.phase, requirements: mission.requirements },
      receipt: operator.receipt, requirements_replaced: mission.requirementsReplaced };
    await writeFile(join(run, 'resume.stdout.jsonl'), stdout);
    await writeFile(join(run, 'resume.stderr.log'), stderr);
    await writeFile(join(run, 'cold-resume-observation.json'), JSON.stringify(result, null, 2) + '\n');
    return result;
  },
  persistFailure: context => persistMissionCLIFailure(run, context, metadata(context.observed), {
    observationFile: 'cold-resume-observation.json', stdoutFile: 'resume.stdout.jsonl', stderrFile: 'resume.stderr.log',
  }),
});
console.log(JSON.stringify(result, null, 2));
assert.equal(result.code, 0);
assert.equal(result.stopped, false);
assert.equal(result.cutoff, undefined);
assert.equal(result.resume_errors.length, 0);
assert.equal(result.requirements_replaced, true);
assert.equal(result.mission.phase, 'completed');
assert.equal(result.receipt?.status, 'succeeded');
assert.equal(await readFile(join(started.project, 'result.txt'), 'utf8'), 'recovered\n');
