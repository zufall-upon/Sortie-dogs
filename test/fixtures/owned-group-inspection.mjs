import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

// Run fault injection in its own Node process; no shared permissions or service changes.
const [directory, fault = 'foreign-read'] = process.argv.slice(2);
await fs.mkdir(directory, { recursive: true });
const originalRead = fs.readFile, originalKill = process.kill, originalPath = process.env.PATH;
const child = spawn(process.execPath, [join(import.meta.dirname, 'owned-process-group.mjs'), directory, 'closed-stubborn'],
  { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '';
child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
const rootExit = await new Promise((done, reject) => {
  child.once('error', reject); child.once('close', (code, signal) => done({ code, signal }));
});
const { writerPID, file } = JSON.parse(stdout);
const foreignStat = await originalRead('/proc/1/stat', 'utf8');
assert.notEqual(Number(foreignStat.slice(foreignStat.lastIndexOf(')') + 2).trim().split(/\s+/)[2]), child.pid);
let deniedReads = 0, signals = [], cleanupError = null;
try {
  fs.readFile = async (path, ...args) => {
    if ((fault === 'foreign-read' && path === '/proc/1/stat') ||
        (fault === 'owned-read' && path === `/proc/${writerPID}/stat`)) {
      deniedReads++;
      throw Object.assign(Error(`injected-${fault}-denied`), { code: 'EACCES' });
    }
    return originalRead(path, ...args);
  };
  process.kill = (pid, signal) => {
    if (pid === -child.pid) {
      signals.push(signal);
      if (fault === 'signal-denied' && signal === 'SIGTERM') {
        throw Object.assign(Error('injected-owned-group-signal-denied'), { code: 'EPERM' });
      }
    }
    return originalKill(pid, signal);
  };
  if (fault === 'listing-unavailable') process.env.PATH = directory;
  if (fault === 'listing-timeout') {
    // Match the retained first-wave pgrep timeout once, then allow the existing
    // owned-group selector to observe the same writer. No native CLI or model.
    await fs.writeFile(join(directory, 'pgrep'), `#!${process.execPath}
(async () => {
const fs = await import('node:fs'), { spawnSync } = await import('node:child_process');
const directory = ${JSON.stringify(directory)};
fs.appendFileSync(directory + '/pgrep-calls.log', 'selected\\n');
const run = () => process.exit(spawnSync('/usr/bin/pgrep', process.argv.slice(2), { stdio: 'inherit' }).status ?? 2);
if (fs.existsSync(directory + '/pgrep-delayed')) run();
else { fs.writeFileSync(directory + '/pgrep-delayed', 'once'); setTimeout(run, 1500); }
})();
`, { mode: 0o755 });
    process.env.PATH = `${directory}:${originalPath}`;
  }
  syncBuiltinESMExports();
  const { stopProcessGroup } = await import('../../scripts/release-cli.mjs');
  const started = Date.now();
  try { await stopProcessGroup(child); }
  catch (error) { cleanupError = { code: error.code ?? null, message: error.message }; }
  const cleanupMs = Date.now() - started;
  fs.readFile = originalRead; process.kill = originalKill; process.env.PATH = originalPath; syncBuiltinESMExports();
  const snapshot = await fs.readFile(file);
  await new Promise(done => setTimeout(done, 100));
  const later = await fs.readFile(file);
  const writerState = await originalRead(`/proc/${writerPID}/stat`, 'utf8').then(stat =>
    stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[0], error => {
    if (error.code === 'ENOENT') return 'absent'; throw error;
  });
  const result = { fault, root_exit: rootExit, root_pid: child.pid, writer_pid: writerPID, writer_log: file,
    cleanup_error: cleanupError, denied_reads: deniedReads, signals, cleanup_ms: cleanupMs,
    writer_state: writerState, bytes_at_cleanup_return: snapshot.length, bytes_later: later.length,
    writer_frozen: snapshot.equals(later), writer_stopped: ['absent', 'Z', 'X'].includes(writerState),
    new_model_requests: 0, native_runtime_loaded: false };
  if (fault === 'listing-timeout') result.selector_calls = (await fs.readFile(join(directory, 'pgrep-calls.log'), 'utf8')).trim().split('\n').length;
  await fs.writeFile(join(directory, 'root.stdout.log'), stdout); await fs.writeFile(join(directory, 'root.stderr.log'), stderr);
  await fs.writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  fs.readFile = originalRead; process.kill = originalKill; process.env.PATH = originalPath; syncBuiltinESMExports();
  try { originalKill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  await new Promise(done => setTimeout(done, 100));
  const snapshot = await fs.readFile(file);
  await new Promise(done => setTimeout(done, 100));
  assert(snapshot.equals(await fs.readFile(file)), 'final cleanup stops only the owned writer');
  await fs.writeFile(join(directory, 'cleanup-receipt.json'), JSON.stringify({ exact_owned_group: child.pid,
    owned_writer_stopped: true, builtin_read_and_kill_restored: true, shared_host_touched: false }, null, 2) + '\n');
}
