import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { installedFixture, startV2ReleaseServer, stopProcessGroup, nativeCLI, spawnPromptCLI, command, missionDatabasePath, missionWorkerModelID } from './release-cli.mjs';
import { estimateModelUsageCost } from '../dist/plugin/model-cost.js';
import { nativeRunPending, waitForNativeSettlement } from './native-run-settlement.mjs';

export { missionDatabasePath } from './release-cli.mjs';
export const observationDirectories = project => [project, project.replaceAll('\\', '/')];
export const probeTaskIdentity = (request, instance, actualBaseCommit) => ({
  task_sha256: createHash('sha256').update(request).digest('hex'),
  instance: instance ? { instance_id: instance.instance_id, repo: instance.repo, base_commit: actualBaseCommit } : null,
});
export function observeMissionCLI(project, since = 0, rootAgent = 'dog-operator', databasePath = missionDatabasePath(process.env, project), { root: rootID } = {}) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const sessions = db.prepare('select id, parent_id, agent, time_created from session_v2 where directory in (?, ?) and time_created >= ? order by time_created')
      .all(...observationDirectories(project), since);
    const roots = sessions.filter(session => !session.parent_id && session.agent === rootAgent);
    const root = rootID === undefined ? roots.at(-1) : roots.find(session => session.id === rootID);
    // A resumed session keeps its own cumulative usage, not a newer task's root.
    if (rootID !== undefined && !root) throw new Error(`Observation root ${rootID} not found in selected agent/directory/since scope`);
    const descendants = new Set(root ? [root.id] : []);
    // Creation order need not put a parent before its descendants.
    for (let size = -1; size !== descendants.size;) {
      size = descendants.size;
      for (const session of sessions) if (descendants.has(session.parent_id)) descendants.add(session.id);
    }
    let usd = 0, unpriced = 0;
    const errors = [], models = [], tools = [], responses = [];
    for (const session of sessions.filter(item => descendants.has(item.id))) {
      let first;
      for (const message of db.prepare('select id, type, data from session_message where session_id = ? order by seq').all(session.id)) {
        if (message.type !== 'assistant') continue;
        const data = JSON.parse(message.data), tokens = data.tokens;
        first ??= { sessionID: session.id, parentID: session.parent_id, agent: session.agent, model: data.model,
          started_ms: data.time?.created - root.time_created };
        if (data.finish === 'stop' && (data.content ?? []).some(part => part.type === 'text' && part.text?.trim())) {
          responses.push({ sessionID: session.id, agent: session.agent, finished_ms: data.time?.completed - root.time_created });
        }
        const price = estimateModelUsageCost({ providerID: data.model?.providerID, modelID: data.model?.id,
          uncachedInputTokens: tokens?.input, cacheReadTokens: tokens?.cache?.read, cacheWriteTokens: tokens?.cache?.write,
          outputTokens: tokens?.output, reasoningTokens: tokens?.reasoning });
        if (price.status === 'priced') usd += price.usd;
        else unpriced++;
        for (const part of data.content ?? []) if (part.type === 'tool') {
          tools.push({ agent: session.agent, tool: part.name, status: part.state?.status, at_ms: part.time?.created - root.time_created,
            ...(part.name === 'sortie_v010_operator_status' ? { model: data.model } : {}) });
          if (part.state?.status === 'error') errors.push({ sessionID: session.id, tool: part.name,
            error: String(JSON.stringify(part.state?.error ?? part.state?.content)).slice(0, 1500) });
        }
      }
      if (first) models.push(first);
    }
    return { database_path: databasePath, root: root?.id, models, tools, responses, errors, priced_usd: usd, unpriced_requests: unpriced };
  } finally { db.close(); }
}

/** An explicit route/status probe is not a Mission run. Observe one real model turn and one status call. */
export function statusProbeStopReason(observed, expectedModel) {
  const first = observed.models.find(item => item.sessionID === observed.root && item.agent === 'dog-operator');
  if (!first) return null;
  const match = model => model?.providerID && model?.id &&
    `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ''}` === expectedModel;
  if (!match(first.model)) return 'model-mismatch';
  const status = observed.tools.find(item => item.agent === 'dog-operator' && item.tool === 'sortie_v010_operator_status' &&
    item.status === 'completed');
  if (!status) return null;
  return match(status.model) ? 'status-observed' : 'model-mismatch';
}

export const workerStartWithinProbeLimit = (mode, worker, instance, deadlineMs) =>
  mode !== 'start' || Number.isFinite(worker?.started_ms) && worker.started_ms >= 0 &&
    worker.started_ms <= (deadlineMs ?? (instance ? 180_000 : 60_000));

export function probeStopReason(observed, { mode, rootModel, capUSD, elapsedMs, timeoutMs }) {
  const statusReason = mode === 'status' ? statusProbeStopReason(observed, rootModel) : null;
  if (observed.priced_usd >= capUSD) return 'budget';
  if (statusReason) return statusReason;
  if (mode === 'start' && observed.models.some(item => item.agent === 'dog-worker-v010')) return 'worker-started';
  if (mode === 'build-start' && observed.responses.some(item => item.agent === 'build')) return 'build-responded';
  if (mode === 'operator-response' && observed.responses.some(item => item.agent === 'dog-operator')) return 'operator-responded';
  return elapsedMs > timeoutMs ? 'timeout' : null;
}

/** A normal parent exit can beat the interval even though its native Worker already started.
 * Inspect before server teardown; never relabel a failed exit or an earlier stop. */
export const cliCloseStopReason = (code, stopped, observed, options) =>
  code === 0 && !stopped ? probeStopReason(observed, options) : null;

/** Native Mission completion and exact Worker coverage are independent observations,
 * not official task correctness or a replacement for the existing probe acceptance. */
export function completeProbeObservations(result, schemaRejected = false) {
  if (result.mode !== 'complete') return {};
  return {
    native_completed: !schemaRejected && result.stopped === false && result.code === 0 &&
      result.mission_phase === 'completed' && result.receipt_status === 'succeeded',
    worker_model_observed: result.models.some(item => item.agent === 'dog-worker-v010' &&
      item.model?.providerID === 'openai' && item.model.id === missionWorkerModelID(result.package_version) && item.model.variant === 'max'),
  };
}

/** Monitor the owned CLI and server through native settlement and evidence persistence.
 * Observation seams let retained lifecycle facts be replayed without model requests.
 * finish persists completed evidence idempotently; a first late signal can require a re-save. */
export async function monitorMissionCLI({ child, server, project, since, rootAgent, root, mode, rootModel, capUSD, timeoutSeconds,
  databasePath = missionDatabasePath(server.env ?? process.env, project), observe = observeMissionCLI, pending, finish, persistFailure }) {
  let stdout = '', stderr = '', identityBuffer = '', stopped = false, stopping, cutoff, stopObservation, controllerSignal, lastObserved, observationRoot = root, observationError, cliError, usageIncomplete, serverExited = false;
  const cleanupErrors = [];
  const cleanup = (target, run) => Promise.resolve().then(run).catch(error => {
    cleanupErrors.push({ target, name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 1500),
      ...(error?.code === undefined ? {} : { code: error.code }) });
    if (!stopped) {
      cutoff = lastObserved;
      stopped = 'cleanup-failed';
      stopObservation = 'cleanup';
    }
  });
  let serverStopping;
  const stopServer = () => serverStopping ??= cleanup('server', () => server.stop());
  // Share one owned teardown across normal close, interruption and final-read failure.
  const stopOwned = () => stopping ??= Promise.all([cleanup('cli', () => stopProcessGroup(child)), stopServer()]);
  const emptyObservation = () => ({ database_path: databasePath, models: [], tools: [], responses: [], errors: [],
    priced_usd: 0, unpriced_requests: 0 });
  const observeNow = point => {
    try {
      // New runs identify their session in the owned CLI's JSON stream. Never adopt
      // another same-project CLI's root merely because its database row appeared first.
      if (observationRoot === undefined) {
        if (point === 'interval') return emptyObservation();
        throw new Error('Monitored CLI did not report its session identity');
      }
      lastObserved = observe(project, since, rootAgent, databasePath, { root: observationRoot });
      usageIncomplete = false;
      return lastObserved;
    } catch (error) {
      failObservation(error, point);
      return lastObserved ?? emptyObservation();
    }
  };
  const identifyRoot = line => {
    if (observationRoot !== undefined) return;
    try {
      const event = JSON.parse(line);
      if (['step_start', 'step_finish', 'text', 'tool_use', 'error'].includes(event?.type) &&
          typeof event.sessionID === 'string' && event.sessionID) observationRoot = event.sessionID;
    } catch { /* Keep non-JSON diagnostic lines in stdout; they cannot identify a run. */ }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', bytes => {
    stdout += bytes;
    if (observationRoot !== undefined) return;
    identityBuffer += bytes;
    let newline;
    while ((newline = identityBuffer.indexOf('\n')) >= 0) {
      identifyRoot(identityBuffer.slice(0, newline));
      identityBuffer = identityBuffer.slice(newline + 1);
    }
  });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const stop = (reason, observed, point) => {
    if (stopped) return;
    cutoff = observed;
    stopped = reason;
    stopObservation = point;
    clearInterval(timer);
    // Await both attempts even if one rejects; preserve errors without skipping persistence.
    stopOwned();
  };
  const failObservation = (error, point) => {
    observationError ??= { name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 1500),
      ...(error?.code === undefined ? {} : { code: error.code }),
      ...(error?.serverExit === undefined ? {} : { server_exit: error.serverExit }) };
    usageIncomplete = true;
    stop('observation-failed', lastObserved, point);
  };
  const stopOptions = () => ({ mode, rootModel, capUSD, elapsedMs: Date.now() - since, timeoutMs: timeoutSeconds * 1000 });
  const timer = setInterval(() => {
    try {
      const observed = observeNow('interval');
      const reason = probeStopReason(observed, stopOptions());
      if (reason) stop(reason, observed, 'interval');
    } catch (error) {
      failObservation(error, 'interval');
    }
  }, 250);
  const interrupt = signal => {
    controllerSignal ??= signal;
    stop('controller-interrupted', lastObserved, 'signal');
  };
  const onInterrupt = () => interrupt('SIGINT'), onTerminate = () => interrupt('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  // Persisted pending rows cannot finish once their owned server has exited.
  // Ignore our intentional teardown and preserve any earlier stop reason.
  server.closed?.then(code => {
    if (serverStopping || stopped) return;
    serverExited = true;
    const serverExit = server.termination;
    failObservation(Object.assign(Error(`Owned server exited before native settlement (exit ${code}${serverExit?.signal ? `, signal ${serverExit.signal}` : ''})`),
      { code, ...(serverExit === undefined ? {} : { serverExit }) }), 'server-close');
  });
  let code, signal;
  try {
    try {
      ({ code, signal } = await new Promise(done => {
        child.once('error', error => {
          cliError = { name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 1500),
            ...(error?.code === undefined ? {} : { code: error.code }) };
          stop(child.pid ? 'cli-error' : 'cli-launch-failed', lastObserved, 'cli-error');
        });
        // Even failed spawns emit close after their streams close. Preserve that
        // real outcome and complete owned cleanup before persisting the receipt.
        child.once('close', (code, signal) => done({ code, signal }));
      }));
      identifyRoot(identityBuffer); // Accept the last complete JSON event without a trailing newline.
      if (!stopped && code !== 0 && observationRoot === undefined) stop('cli-exit-failed', lastObserved, 'cli-close');
      const observed = observeNow('cli-close');
      // A failed close need not emit a child error event. Keep its real code/signal
      // and earlier stop, but do not leave this terminal outcome labelled normal.
      const reason = !stopped && code !== 0 ? 'cli-exit-failed' : cliCloseStopReason(code, stopped, observed, stopOptions());
      if (reason) stop(reason, observed, 'cli-close');
      if (mode === 'complete' && code === 0 && !stopped) {
        await waitForNativeSettlement({ pending: async () => {
          try { return await (pending ?? (() => nativeRunPending(project, databasePath, { since, root: observationRoot })))(); }
          catch (error) { failObservation(error, 'native-settlement'); return false; }
        }, stopped: () => stopped });
      }
    } finally {
      clearInterval(timer);
      try { await stopOwned(); } finally { await stopServer(); }
    }
    const observed = observeNow('final');
    await stopping; // A final read can fail after normal cleanup; retain one owned teardown.
    const usageComplete = !usageIncomplete && !serverExited && !cleanupErrors.length;
    const evidence = { observed: observationError || cliError || cleanupErrors.length ? { ...observed, usage_complete: usageComplete,
      // Missing coverage retains the existing reservation. The floor is an accounting
      // marker, not a claim that an additional model request was observed.
      ...(!usageComplete ? { known_unpriced_requests: observed.unpriced_requests,
        unpriced_requests: Math.max(1, observed.unpriced_requests) } : {}) } : observed,
      databasePath, stdout, stderr, code, signal, observationError, cliError, cleanupErrors };
    let savedStop, savedSignal, result;
    do {
      savedStop = stopped; savedSignal = controllerSignal;
      const context = { ...evidence, stopped: savedStop, stopObservation, cutoff, controllerSignal: savedSignal,
        nextAction: cleanupErrors.length
        ? 'Retry teardown only for the recorded owned CLI/server and verify all writers stopped, then reconcile database usage and saved CLI logs. Do not automatically replay the consumed task or restart the shared host.' : cliError
        ? 'Inspect the recorded CLI error, executable and working directory; reconcile the owned database usage and saved CLI logs. Do not automatically replay the consumed task.' : savedStop === 'cli-exit-failed'
        ? 'Inspect the recorded CLI exit code/signal and saved logs; reconcile the owned database usage and Mission receipt before deciding the next operation. Do not automatically replay the consumed task or restart the shared host.' : serverExited
        ? 'Inspect the recorded owned server exit and saved CLI logs; reconcile the retained database usage and Mission receipt. Do not automatically replay the consumed task or restart the shared host.' : observationError
        ? 'Inspect the recorded owned database and saved CLI logs; reconcile session usage. Do not automatically replay the consumed task.'
        : savedStop === 'controller-interrupted'
        ? 'Inspect the saved Mission receipt, owned database usage and CLI logs before deciding the next operation. Do not automatically replay the consumed task or restart the shared host.' : undefined };
      try { result = await finish(context); }
      catch (error) {
        stop('persistence-failed', lastObserved, 'persistence');
        const failureContext = () => ({ ...evidence, observed: { ...evidence.observed, usage_complete: false,
          known_unpriced_requests: evidence.observed.known_unpriced_requests ?? evidence.observed.unpriced_requests,
          unpriced_requests: Math.max(1, evidence.observed.unpriced_requests) },
          stopped, stopObservation, cutoff, controllerSignal, persistence_complete: false,
          persistenceError: { name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 1500),
            ...(error?.code === undefined ? {} : { code: error.code }) },
          nextAction: 'Inspect the recorded owned output and budget lock, retain unresolved usage holds, and reconcile saved receipt/database usage and CLI logs before retrying only failed persistence. Verify owned writers stopped. Do not automatically replay the consumed task, remove another owner\'s lock or restart the shared host.' });
        let failurePersistenceError;
        if (persistFailure) try {
          // A distinct evidence-only sink avoids repeating failed state reads or settlement.
          do {
            savedStop = stopped; savedSignal = controllerSignal;
            result = await persistFailure(failureContext());
          } while (savedStop !== stopped || savedSignal !== controllerSignal);
          return result;
        } catch (failure) {
          failurePersistenceError = { name: failure?.name ?? 'Error', message: String(failure?.message ?? failure).slice(0, 1500),
            ...(failure?.code === undefined ? {} : { code: failure.code }) };
        }
        // If the receipt path is unavailable, surface original cause plus fresh evidence,
        // never return the earlier success or claim the failure was durably recorded.
        const rejected = new Error('Mission CLI evidence persistence failed', { cause: error });
        if (error?.code !== undefined) rejected.code = error.code;
        rejected.monitorContext = { ...failureContext(), failure_recorded: false,
          ...(failurePersistenceError ? { failurePersistenceError } : {}) };
        throw rejected;
      }
      // A signal can arrive after finish copied or serialized its fields. Re-save
      // only changed stop metadata, not native work, observation or owned teardown.
      // Both fields are first-write-only, so repeated signals cannot prolong saving.
    } while (savedStop !== stopped || savedSignal !== controllerSignal);
    return result;
  } finally {
    // Retain handlers through log/usage persistence, including repeated signals.
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  }
}

/** Correct terminal evidence only; never retry model work, Mission reads or budget settlement. */
export async function persistMissionCLIFailure(run, context, metadata = {}, {
  observationFile = 'observation.json', stdoutFile = 'cli.stdout.jsonl', stderrFile = 'cli.stderr.log',
} = {}) {
  let previous = {}, previousObservationError;
  try { previous = JSON.parse(await readFile(join(run, observationFile), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') previousObservationError = { name: error.name, message: String(error.message).slice(0, 1500),
      ...(error.code === undefined ? {} : { code: error.code }) };
  }
  const result = { ...previous, ...context.observed, ...metadata,
    database_path: context.databasePath, stopped: context.stopped, stop_observation: context.stopObservation ?? null,
    code: context.code, signal: context.signal ?? null, controller_signal: context.controllerSignal ?? null,
    ...(context.cutoff ? { errors: context.cutoff.errors,
      cancellation_errors: context.observed.errors.filter(error => /"type":"aborted"/.test(error.error)) } : {}),
    ...(context.observationError ? { observation_error: context.observationError } : {}),
    ...(context.cliError ? { cli_error: context.cliError } : {}),
    ...(context.cleanupErrors.length ? { cleanup_complete: false, cleanup_errors: context.cleanupErrors } : {}),
    ...(previousObservationError ? { previous_observation_error: previousObservationError } : {}),
    persistence_complete: false, persistence_error: context.persistenceError,
    failure_recorded: true, next_action: context.nextAction, accepted: false };
  Object.assign(result, completeProbeObservations(result), { native_completed: false });
  await writeFile(join(run, stdoutFile), context.stdout);
  await writeFile(join(run, stderrFile), context.stderr);
  await writeFile(join(run, observationFile), JSON.stringify(result, null, 2));
  return result;
}

async function updateBudget(file, update) {
  if (!file) return;
  const lock = `${file}.lock`;
  await mkdir(lock); // An existing owner or unresolved crash blocks another launch.
  try {
    const budget = JSON.parse(await readFile(file, 'utf8'));
    update(budget);
    await writeFile(`${file}.tmp`, JSON.stringify(budget, null, 2));
    await rename(`${file}.tmp`, file);
  } finally { await rm(lock, { recursive: true }); }
}

export async function probe(tgz, output, { mode = 'start', prompt, instance, timeoutSeconds = 180, capUSD = 1, pythonBin, budgetFile,
  setupFixture, onServer, model, profileId = 'v012', workerStartDeadlineMs } = {}) {
  if (!Number.isFinite(capUSD) || capUSD <= 0 || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw Error('Probe needs finite positive limits');
  const fixture = await installedFixture(tgz, output, profileId, { nested: false });
  const { project, env, run } = fixture;
  if (instance) {
    await command('git', ['init', '-q'], project, env);
    await command('git', ['fetch', '--depth=1', '--no-tags', `https://github.com/${instance.repo}.git`, instance.base_commit], project, env);
    await command('git', ['checkout', '--detach', '-q', 'FETCH_HEAD'], project, env);
    await writeFile(join(project, '.git/info/exclude'), `.opencode/\n${fixture.runtime.stateDirectory}/\n`);
    if (pythonBin) env.PATH = `${pythonBin}:${process.env.PATH}`;
  } else {
  await writeFile(join(project, '.gitignore'), `.opencode/\n${fixture.runtime.stateDirectory}/\nchild/\n`);
  await writeFile(join(project, 'result.txt'), 'seed\n');
  await writeFile(join(project, 'check.mjs'), "import{readFileSync}from'node:fs';import assert from'node:assert/strict';assert.equal(readFileSync('result.txt','utf8'),'recovered\\n');console.log('MISSION_CLI_PASS');\n");
  await command('git', ['init', '-q'], project, env);
  await command('git', ['add', '--', '.gitignore', 'result.txt', 'check.mjs'], project, env);
  await command('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'], project, env);
  }
  if (setupFixture) await setupFixture(fixture);
  const actualBaseCommit = (await command('git', ['rev-parse', 'HEAD'], project, env)).trim();
  const candidateSHA256 = createHash('sha256').update(await readFile(tgz)).digest('hex');
  await updateBudget(budgetFile, budget => {
    const probes = budget.probes ??= [];
    const charged = probes.reduce((sum, item) => sum + item.charged_usd, 0);
    const baseline = budget.prior_priced_usd + budget.unresolved_prior_reserve_usd;
    if (![charged, baseline, budget.limit_usd, budget.new_probe_total_limit_usd].every(Number.isFinite) ||
        capUSD > budget.per_probe_limit_usd || baseline + charged + capUSD > budget.limit_usd ||
        charged + capUSD > budget.new_probe_total_limit_usd) throw Error('Campaign budget/reservations cannot admit this probe');
    probes.push({ project, charged_usd: capUSD, reserved_usd: capUSD, state: 'reserved' });
  });
  const buildStart = mode === 'build-start';
  const operatorResponse = mode === 'operator-response';
  const statusOnly = mode === 'status';
  const rootAgent = buildStart ? 'build' : 'dog-operator';
  const request = prompt ?? (statusOnly ? 'Call sortie_v010_operator_status once. Do not start a Mission or dispatch a Worker.' :
    buildStart ? 'Reply with just: ready' : operatorResponse
    ? '作業は不要です。ツールを呼ばず、READYとだけ返してください。' : 'result.txt の seed を recovered に置換して。末尾改行は維持。検証は node check.mjs。check.mjs と設定は変更しない。単純な1ユニット作業として実装して。');
  const rootModel = model ?? (operatorResponse ? 'openai/gpt-6-luna-fast#max' : 'openai/gpt-6.1-sol#xhigh');
  const serverSince = Date.now();
  async function persistPrelaunchFailure(error, stage, cleanup = error.serverStartContext) {
    // Admission already reserved this attempt. Persist evidence only; never settle
    // missing coverage as zero, rerun installation/startup, or invent a CLI session.
    const isHook = stage === 'server-hook', isLaunch = stage === 'cli-launch';
    const readyServer = isHook || isLaunch;
    const failure = { name: error.name, message: String(error.message).slice(0, 1500),
      ...(error.code === undefined ? {} : { code: error.code }) };
    const cleanupErrors = cleanup?.cleanupErrors ?? [];
    const result = { models: [], tools: [], responses: [], errors: [], priced_usd: 0,
      known_unpriced_requests: 0, unpriced_requests: 1, usage_complete: false,
      project, database_path: missionDatabasePath(env, project), data_home: env.XDG_DATA_HOME,
      mode, stopped: isHook ? 'server-hook-failed' : isLaunch ? 'cli-launch-failed' : 'server-start-failed', stop_observation: stage,
      code: null, signal: null, controller_signal: null, cli_started: false,
      server_start_attempted: true, server_ready: readyServer, ...(isHook ? { server_hook_attempted: true } : {}),
      ...(isLaunch ? { cli_start_attempted: true, cli_handle_obtained: false } : {}), cap_usd: capUSD,
      budget_settlement_attempted: false, ...(budgetFile ? { budget_file: budgetFile } : {}),
      elapsed_ms: Date.now() - serverSince,
      ...(isHook ? { server_hook_error: failure } : isLaunch ? { cli_error: failure } : { server_error: failure }),
      ...(cleanup ? { cleanup_complete: cleanup.cleanup_complete,
        ...(cleanupErrors.length ? { cleanup_errors: cleanupErrors } : {}),
        ...(cleanup.serverPID === undefined ? {} : { server_pid: cleanup.serverPID }),
        ...(cleanup.serverURL === undefined ? {} : { server_url: cleanup.serverURL }),
        server_state_directory: cleanup.stateDirectory } : {}),
      ...probeTaskIdentity(request, instance, actualBaseCommit), package_version: fixture.pkg.version,
      runtime_marker: fixture.runtimeMarker, candidate_sha256: candidateSHA256,
      accepted: false, native_completed: false, failure_recorded: true,
      next_action: cleanup?.nextAction ?? 'Inspect the recorded owned server startup failure, fixture/database path and package/runtime identity; verify any process from the failed owned start has stopped and reconcile session usage while retaining unresolved reservation holds. No CLI was launched. Do not automatically replay the consumed startup/task or restart the shared host.' };
    Object.assign(result, completeProbeObservations(result), { native_completed: false });
    try { await writeFile(join(run, 'observation.json'), JSON.stringify(result, null, 2) + '\n'); }
    catch (persistenceError) {
      error.monitorContext = { observed: { ...result, failure_recorded: false }, databasePath: result.database_path,
        stdout: '', stderr: '', code: null, signal: null, stopped: result.stopped, stopObservation: stage,
        ...(isHook ? { serverHookError: failure } : isLaunch ? { cliError: failure } : { serverError: failure }),
        cleanupErrors, persistence_complete: false, failure_recorded: false,
        persistenceError: { name: persistenceError.name, message: String(persistenceError.message).slice(0, 1500),
          ...(persistenceError.code === undefined ? {} : { code: persistenceError.code }) },
        nextAction: readyServer
          ? `${cleanupErrors.length ? 'Retry teardown only for the recorded owned server and verify all writers stopped; ' : 'The owned server was stopped; '}retain unresolved reservation/usage holds, then retry only failed evidence persistence after reconciling the recorded ${isHook ? 'callback' : 'CLI launch'}/fixture/database usage. ${isLaunch ? 'No CLI handle was obtained; verify any process from the failed launch has stopped.' : 'No CLI was launched.'} Do not automatically replay the consumed startup/task or restart the shared host.`
          : 'Inspect the recorded owned evidence path and failed server startup/cleanup; verify owned writers stopped, retain unresolved reservation/usage holds, then retry only failed evidence persistence after reconciling fixture/database usage. No CLI was launched. Do not automatically replay the consumed startup/task or restart the shared host.' };
    }
    throw error;
  }
  let server;
  try { server = await startV2ReleaseServer(project, env, { credentialSource: fixture.credentialSource }); }
  catch (error) { await persistPrelaunchFailure(error, 'server-start'); }
  async function stopServerAndPersistFailure(error, stage) {
    const isLaunch = stage === 'cli-launch';
    const cleanupErrors = [];
    try { await server.stop(); }
    catch (cleanupError) { cleanupErrors.push({ resource: 'server', name: cleanupError.name,
      message: String(cleanupError.message).slice(0, 1500),
      ...(cleanupError.code === undefined ? {} : { code: cleanupError.code }) }); }
    await persistPrelaunchFailure(error, stage, {
      serverURL: server.url, stateDirectory: server.env.XDG_STATE_HOME ?? join(project, '.opencode', 'v2-service-state'),
      cleanup_complete: cleanupErrors.length === 0, cleanupErrors,
      nextAction: cleanupErrors.length
        ? `Retry teardown only for the recorded owned server and verify all writers stopped; inspect the original ${isLaunch ? 'CLI launch' : 'server callback'} failure and reconcile fixture/database usage while retaining unresolved reservation holds. ${isLaunch ? 'No CLI handle was obtained; verify any process from the failed launch has stopped.' : 'No CLI was launched.'} Do not automatically replay the consumed startup/task or restart the shared host.`
        : `Inspect the recorded ${isLaunch ? 'CLI launch failure, executable and working directory' : 'server callback failure and fixture/database/package identity'}; the owned server was stopped. Reconcile session usage while retaining unresolved reservation holds before deciding continuation. ${isLaunch ? 'No CLI handle was obtained; verify any process from the failed launch has stopped.' : 'No CLI was launched.'} Do not automatically replay the consumed startup/task or restart the shared host.`,
    });
  }
  try { await onServer?.({ server, fixture }); }
  catch (error) { await stopServerAndPersistFailure(error, 'server-hook'); }
  const since = Date.now(); // Keep the successful CLI timing endpoint unchanged.
  let child;
  try {
    const launch = nativeCLI('opencode', ['run', '--server', server.url, '--format', 'json', '--agent', rootAgent, '--model', rootModel]);
    child = spawnPromptCLI(launch.executable, launch.args, request, {
      cwd: project, env: { ...server.env, PWD: project }, detached: true,
    });
  } catch (error) { await stopServerAndPersistFailure(error, 'cli-launch'); }
  return await monitorMissionCLI({ child, server, project, since, rootAgent, mode, rootModel, capUSD, timeoutSeconds,
    finish: async ({ observed, databasePath, stdout, stderr, stopped, stopObservation, cutoff, code, signal, controllerSignal, observationError, cliError, cleanupErrors, nextAction }) => {
      const state = async area => {
        if (!observed.root) return null;
        try { return JSON.parse(await readFile(join(project, fixture.runtime.stateDirectory, area,
          `${createHash('sha256').update(observed.root).digest('hex')}.json`), 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      };
      const mission = await state('missions'), operator = await state('operators');
      const result = { ...observed, ...(statusOnly ? { expected_model: rootModel,
        observed_model: observed.tools.find(item => item.agent === 'dog-operator' && item.tool === 'sortie_v010_operator_status' &&
          item.status === 'completed')?.model ?? observed.models.find(item => item.sessionID === observed.root)?.model ?? null } : {}),
        ...(cutoff ? { errors: cutoff.errors,
        cancellation_errors: observed.errors.filter(error => /"type":"aborted"/.test(error.error)) } : {}),
        project, database_path: databasePath, data_home: env.XDG_DATA_HOME,
        mode, stopped, stop_observation: stopObservation ?? null, code, signal: signal ?? null,
        controller_signal: controllerSignal ?? null, elapsed_ms: Date.now() - since,
        ...(observationError ? { observation_error: observationError } : {}),
        ...(cliError ? { cli_error: cliError } : {}),
        ...(cleanupErrors.length ? { cleanup_complete: false, cleanup_errors: cleanupErrors,
          cli_pid: child.pid ?? null, server_url: server.url ?? null } : {}),
        ...(nextAction ? { next_action: nextAction } : {}),
        ...probeTaskIdentity(request, instance, actualBaseCommit),
        package_version: fixture.pkg.version, runtime_marker: fixture.runtimeMarker,
        mission_phase: mission?.phase ?? null, receipt_status: operator?.receipt?.status ?? null,
        review: mission?.review ? { verdict: mission.review.verdict, child: mission.review.child ?? null } : null,
        candidate_sha256: candidateSHA256 };
      const worker = result.models.find(item => item.agent === 'dog-worker-v010');
      const schemaRejected = /invalid_function_parameters|Invalid schema for function/u.test(stdout + stderr);
      Object.assign(result, completeProbeObservations(result, schemaRejected));
      result.accepted = statusOnly ? !schemaRejected && !result.errors.length && stopped === 'status-observed' &&
        result.mission_phase === null :
        operatorResponse ? !schemaRejected && !result.errors.length &&
        (stopped === 'operator-responded' || (!stopped && code === 0)) && result.responses.some(item => item.agent === 'dog-operator') &&
        result.models.some(item => item.agent === 'dog-operator' && item.model?.id === 'gpt-6-luna-fast' && item.model.variant === 'max') :
        buildStart ? !result.errors.length && (stopped === 'build-responded' || (!stopped && code === 0)) &&
        result.responses.some(item => item.agent === 'build') &&
        result.models.some(item => item.agent === 'build' && item.model?.id === 'gpt-6.1-sol') :
        !schemaRejected && worker?.model?.providerID === 'openai' && worker.model.id === missionWorkerModelID(result.package_version) && worker.model.variant === 'max' &&
        workerStartWithinProbeLimit(mode, worker, instance, workerStartDeadlineMs) &&
        (mode === 'start' ? stopped === 'worker-started'
          : !stopped && code === 0 && result.mission_phase === 'completed' && result.receipt_status === 'succeeded');
      if (observationError || cliError || cleanupErrors.length) result.accepted = false; // Preserve the prior thrown-error failure, now with a durable receipt.
      await writeFile(join(run, 'cli.stdout.jsonl'), stdout);
      await writeFile(join(run, 'cli.stderr.log'), stderr);
      await writeFile(join(run, 'observation.json'), JSON.stringify(result, null, 2));
      await updateBudget(budgetFile, budget => {
        const entry = budget.probes.find(item => item.project === project);
        Object.assign(entry, { state: 'settled', root: result.root, priced_usd: result.priced_usd,
          unpriced_requests: result.unpriced_requests,
          charged_usd: result.unpriced_requests ? Math.max(entry.reserved_usd, result.priced_usd) : result.priced_usd });
      });
      return result;
    },
    persistFailure: context => persistMissionCLIFailure(run, context, {
      project, data_home: env.XDG_DATA_HOME, mode, elapsed_ms: Date.now() - since,
      ...probeTaskIdentity(request, instance, actualBaseCommit), package_version: fixture.pkg.version,
      runtime_marker: fixture.runtimeMarker, candidate_sha256: candidateSHA256,
      ...(context.cleanupErrors.length ? { cli_pid: child.pid ?? null, server_url: server.url ?? null } : {}),
    }),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const result = await probe(resolve(process.argv[2]), resolve(process.argv[3]), { mode: process.argv[4] ?? 'start',
    timeoutSeconds: Number(process.argv[5] ?? 180), ...(process.argv[6] ? { prompt: await readFile(process.argv[6], 'utf8') } : {}) });
  console.log(JSON.stringify(result, null, 2));
  // CLI-only start probes have already persisted their observation and logs.
  // Drop the large isolated installation so old tool schemas cannot be loaded
  // when the shared OpenCode server later revisits this fixture's session.
  if (result.accepted && ['start', 'build-start', 'operator-response', 'status'].includes(result.mode)) {
    const control = join(result.project, '.opencode');
    const observation = JSON.parse(await readFile(join(dirname(result.project), 'observation.json'), 'utf8'));
    if (observation.project === result.project && observation.candidate_sha256 === result.candidate_sha256 &&
        (await lstat(control)).isDirectory()) await rm(control, { recursive: true });
  }
  if (!result.accepted) process.exitCode = 1;
}
