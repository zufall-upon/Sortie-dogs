import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { monitorMissionCLI, completeProbeObservations } from '../../scripts/mission-cli-probe.mjs';
import { spawnPromptCLI, startV2ReleaseServer, stopProcessGroup } from '../../scripts/release-cli.mjs';

// Process-only replay of Cycle053: root CLI close can precede native settlement.
// These are retained lifecycle projections, not a model request or task solution.
const [directory, phase, serverKind = 'process'] = process.argv.slice(2);
const launchFailure = phase.startsWith('launch-failure');
const cleanupFailure = phase.startsWith('cleanup-failure') || phase === 'launch-failure-cleanup';
const observationFailure = phase.startsWith('observation-failure-');
const immediateClose = ['settlement', 'observation-failure-close', 'observation-failure-final',
  'observation-failure-pending', 'observation-failure-budget', 'cleanup-failure',
  'cleanup-failure-budget', 'cleanup-failure-observation'].includes(phase);
let server, serverPID;
if (serverKind === 'native') {
  // Explicit service-only check: no native run/session/provider request.
  const config = join(directory, 'xdg', 'opencode');
  await mkdir(config, { recursive: true });
  await writeFile(join(config, 'opencode.json'), '{}\n');
  server = await startV2ReleaseServer(directory, {
    PATH: process.env.PATH, HOME: process.env.HOME,
    XDG_CONFIG_HOME: join(directory, 'xdg'), OPENCODE_CONFIG_DIR: config,
    OPENCODE_CONFIG: join(config, 'opencode.json'),
  }, { inheritEnvironment: false });
  serverPID = JSON.parse(await readFile(join(server.env.XDG_STATE_HOME, 'opencode/service.json'), 'utf8')).pid;
} else {
  const serverChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true, stdio: 'ignore',
  });
  server = { stop: () => stopProcessGroup(serverChild) };
  serverPID = serverChild.pid;
}
let serverStopCalls = 0, pendingCalls = 0;
const ownedStop = server.stop;
server.stop = async () => {
  serverStopCalls++;
  await ownedStop();
  if (cleanupFailure) throw Object.assign(Error('injected-owned-server-stop-failure'), { code: 'EIO' });
};
const observed = JSON.parse(await readFile(join(directory, 'retained-observation.json'), 'utf8'));
const child = spawnPromptCLI(launchFailure ? join(directory, 'intentionally-absent-cli') : process.execPath, ['-e',
  `process.stdin.resume();console.log('CLI_CONNECTED');console.error('CLI_OWNED');${immediateClose
    ? 'process.exit(0)' : 'setInterval(() => {}, 1000)'}`], 'retained task bytes', { detached: true });
const initialListeners = ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal));
let announced = false, reads = 0;
if (launchFailure) {
  announced = true;
  process.send({ phase: 'monitoring', serverPID });
}
const result = await monitorMissionCLI({ child, server,
  project: directory, since: Date.now(), rootAgent: 'dog-operator', mode: 'complete',
  rootModel: 'openai/gpt-6.1-sol#xhigh', capUSD: ['budget', 'observation-failure-budget', 'cleanup-failure-budget'].includes(phase) ? 1 : 2, timeoutSeconds: 30,
  observe: () => {
    if (!announced && phase !== 'settlement') {
      announced = true;
      process.send({ phase: 'monitoring', serverPID, cliPID: child.pid });
    }
    reads++;
    if (phase === 'cli-process-error' && reads === 1) {
      // A post-spawn process/pipe error is not a failed executable launch.
      child.emit('error', Object.assign(Error('injected-cli-process-error'), { code: 'EIO' }));
    }
    if (phase === 'launch-failure-observation') throw Error('injected-database-read-failure');
    if (phase === 'cleanup-failure-observation' && reads > 1) throw Error('injected-database-read-failure');
    if (['observation-failure-first', 'observation-failure-close'].includes(phase) ||
      ['observation-failure-interval', 'observation-failure-final', 'observation-failure-budget'].includes(phase) && reads > 1) {
      throw Error('injected-database-read-failure');
    }
    return observed;
  },
  pending: () => {
    pendingCalls++;
    if (phase === 'observation-failure-pending') throw Error('injected-native-settlement-read-failure');
    if (observationFailure || cleanupFailure) return false;
    if (!announced) {
      announced = true;
      process.send({ phase: 'settlement', serverPID, cliPID: child.pid });
    }
    return true;
  },
  finish: async ({ observed, stdout, stderr, stopped, stopObservation, code, signal, controllerSignal, observationError, cliError, cleanupErrors, nextAction }) => {
    const result = { ...observed, mode: 'complete', stopped, stop_observation: stopObservation,
      code, signal, controller_signal: controllerSignal ?? null,
      mission_phase: 'completed', receipt_status: 'succeeded', accepted: false,
      ...(observationError ? { observation_error: observationError } : {}),
      ...(cliError ? { cli_error: cliError } : {}),
      ...(cleanupErrors?.length ? { cleanup_complete: false, cleanup_errors: cleanupErrors } : {}),
      ...(nextAction ? { next_action: nextAction } : {}),
      ...(launchFailure || cleanupFailure || phase === 'cli-process-error' ? { server_stop_calls: serverStopCalls,
        pending_calls: pendingCalls, cli_started: Boolean(child.pid) } : {}) };
    Object.assign(result, completeProbeObservations(result));
    // A signal during persistence must not truncate the final usage/observation.
    if (phase === 'persistence') {
      process.send({ phase: 'persistence' });
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    await writeFile(join(directory, 'cli.stdout.jsonl'), stdout);
    await writeFile(join(directory, 'cli.stderr.log'), stderr);
    await writeFile(join(directory, 'observation.json'), JSON.stringify(result));
    return result;
  },
});
await writeFile(join(directory, 'listener-counts.json'), JSON.stringify({ before: initialListeners,
  after: ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal)) }));
process.send({ phase: 'finished', stopped: result.stopped });
process.disconnect();
process.exitCode = result.accepted ? 0 : 1;
