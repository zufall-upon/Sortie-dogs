import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import * as probe from '../../scripts/mission-cli-probe.mjs';
import { stopProcessGroup } from '../../scripts/release-cli.mjs';

// Evaluate the real script unchanged. Seeded startup/Mission values are lifecycle
// preconditions, not actual Worker coverage or task success; no native model calls.
const [directory, phase = 'closed'] = process.argv.slice(2);
const project = join(directory, 'project'), root = 'owned-cold-resume';
const key = createHash('sha256').update(root).digest('hex');
for (const area of ['missions', 'operators']) await mkdir(join(project, '.sortie-dogs-v010', area), { recursive: true });
await writeFile(join(project, '.sortie-dogs-v010/missions', `${key}.json`), JSON.stringify({
  id: 'seeded-mission', phase: 'completed', requirements: 'seeded', requirementsReplaced: true }));
await writeFile(join(project, '.sortie-dogs-v010/operators', `${key}.json`), JSON.stringify({ receipt: { status: 'succeeded' } }));
await writeFile(join(project, 'result.txt'), 'recovered\n');
const startupFiles = ['observation.json', 'cli.stdout.jsonl', 'cli.stderr.log'];
for (const file of startupFiles) await writeFile(join(directory, file), 'retained-startup-evidence\n');
const database = join(directory, 'owned-lifecycle.db'), db = new DatabaseSync(database);
db.exec(`CREATE TABLE session_v2(id TEXT, parent_id TEXT, directory TEXT, time_created INTEGER, time_idle INTEGER, idle_outcome TEXT);
  CREATE TABLE session_message(session_id TEXT, type TEXT, seq INTEGER, data TEXT);
  CREATE TABLE session_pending(session_id TEXT); CREATE TABLE session_inbox(session_id TEXT);`);
db.prepare('INSERT INTO session_v2 VALUES (?, NULL, ?, 1, 2, ?)').run(root, project, 'succeeded');
db.prepare("INSERT INTO session_message VALUES (?, 'assistant', 1, ?)").run(root, JSON.stringify({ time: { completed: 2 }, content: [] }));
if (phase === 'pending') db.prepare('INSERT INTO session_pending VALUES (?)').run(root);
db.close();
const intentional = { sessionID: root, tool: 'subagent', error: 'retained intentional interruption' };
const newError = { sessionID: root, tool: 'shell', error: 'new resume failure' };
const observed = { root, models: [], tools: [], responses: [], errors: [intentional], priced_usd: 1.7674084, unpriced_requests: 0 };
const started = { ...observed, project, stopped: 'worker-started', models: [{ agent: 'dogs-coordinator' }],
  database_path: database, data_home: join(directory, 'data'), candidate_sha256: 'fixed-package-projection' };
const source = resolve('scripts/mission-cold-resume-probe.mjs');
const beforeListeners = ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal));
let child, serverStops = 0, monitorCalls = 0, observationCalls = 0, startupCalls = 0, pendingReleased = false;
let monitorOptions, result, rejected, cliStops = 0;
const originalKill = process.kill;
process.kill = (pid, signal) => {
  if (pid === -child?.pid && signal === 'SIGTERM') cliStops++;
  return originalKill(pid, signal);
};
const context = vm.createContext({ process: { argv: [process.execPath, source, 'owned-package.tgz', directory], env: process.env,
  kill: (...args) => process.kill(...args) }, console: { log() {} }, setTimeout, clearTimeout, setInterval, clearInterval });
const script = new vm.SourceTextModule(await readFile(source, 'utf8'), { context, identifier: source });
await script.link(async specifier => {
  let values;
  if (specifier === './mission-cli-probe.mjs') values = { ...probe,
    probe: async () => { startupCalls++; return started; },
    observeMissionCLI: () => {
      observationCalls++;
      if (phase === 'observation-error' && observationCalls > 1) throw Object.assign(Error('injected-owned-db-read'), { code: 'EACCES' });
      return { ...observed, priced_usd: phase === 'budget' && observationCalls > 1 ? 2 : observed.priced_usd,
        errors: phase === 'resume-error' && observationCalls > 1 ? [intentional, newError] : observed.errors };
    },
    monitorMissionCLI: options => {
      monitorCalls++;
      monitorOptions = { capUSD: options.capUSD, timeoutSeconds: options.timeoutSeconds, since: options.since, mode: options.mode };
      return probe.monitorMissionCLI(options);
    },
  };
  else if (specifier === './release-cli.mjs') values = {
    startV2ReleaseServer: async () => ({ url: 'http://owned-process-only.invalid', env: {}, stop: async () => {
      serverStops++;
      if (phase === 'pending') assert(pendingReleased, 'do not stop the server before inherited native continuation settles');
      if (phase === 'cleanup-error') throw Object.assign(Error('injected-owned-server-stop'), { code: 'EACCES' });
    } }),
  };
  else if (specifier === 'node:child_process') values = { spawn: () => {
    child = phase === 'launch-error'
      ? spawn(join(directory, 'missing-executable'), [], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(process.execPath, [resolve('test/fixtures/owned-process-group.mjs'), directory, phase === 'signal' ? 'alive' : 'closed'],
        { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (phase === 'pending') child.stdout.once('data', () => setTimeout(() => {
      const db = new DatabaseSync(database); db.exec('DELETE FROM session_pending'); db.close(); pendingReleased = true;
    }, 300));
    if (phase === 'signal') child.stdout.once('data', () => process.kill(process.pid, 'SIGTERM'));
    return child;
  } };
  else if (specifier === 'node:fs/promises') values = { mkdir, writeFile, readFile: async (file, ...args) => {
    if (phase === 'persistence-error' && String(file).includes('/missions/'))
      throw Object.assign(Error('injected-owned-mission-read'), { code: 'EACCES' });
    return readFile(file, ...args);
  } };
  else values = await import(specifier.startsWith('.') ? new URL(specifier, pathToFileURL(source)) : specifier);
  return new vm.SyntheticModule(Object.keys(values), function () {
    for (const [name, value] of Object.entries(values)) this.setExport(name, value);
  }, { context });
});
try {
  try { await script.evaluate(); }
  catch (error) { rejected = { name: error.name, code: error.code, message: String(error.message), monitorContext: error.monitorContext }; }
  try { result = JSON.parse(await readFile(join(directory, 'cold-resume-observation.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const stdout = await readFile(join(directory, 'resume.stdout.jsonl'), 'utf8').catch(() => '');
  let writer;
  if (stdout) {
    const { writerPID, file } = JSON.parse(stdout), before = await readFile(file);
    await new Promise(done => setTimeout(done, 100));
    const after = await readFile(file);
    const state = await readFile(`/proc/${writerPID}/stat`, 'utf8').then(stat =>
      stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[0], error => {
      if (error.code === 'ENOENT') return 'absent'; throw error;
    });
    writer = { pid: writerPID, bytes_at_return: before.length, bytes_later: after.length, state,
      stopped: before.equals(after) && ['absent', 'Z', 'X'].includes(state) };
  }
  const startupEvidencePreserved = (await Promise.all(startupFiles.map(file => readFile(join(directory, file), 'utf8'))))
    .every(bytes => bytes === 'retained-startup-evidence\n');
  await writeFile(join(directory, 'fixture-receipt.json'), JSON.stringify({ phase, result, rejected, writer,
    server_stop_calls: serverStops, cli_stop_calls: cliStops, startup_calls: startupCalls, monitor_calls: monitorCalls,
    observation_calls: observationCalls, monitor_options: monitorOptions, pending_released: pendingReleased,
    listeners_restored: ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal)).join() === beforeListeners.join(),
    startup_evidence_preserved: startupEvidencePreserved, native_model_requests: 0 }, null, 2) + '\n');
} finally {
  process.kill = originalKill;
  if (child) await stopProcessGroup(child);
}
