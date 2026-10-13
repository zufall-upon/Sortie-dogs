import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

// Evaluate the actual helper unchanged with owned synthetic child/streams/signals.
// No real OpenCode server, process cleanup, runtime or model is exercised here.
const [directory, phase] = process.argv.slice(2);
const project = join(directory, 'project'), source = resolve('scripts/release-cli.mjs');
const readiness = phase.startsWith('readiness-'), cleanupFailed = phase.endsWith('cleanup-error');
const startupError = Object.assign(Error(readiness ? 'injected-owned-server-readiness' : 'injected-owned-service-registration-read'), { code: 'EIO' });
const cleanupError = Object.assign(Error('injected-owned-server-start-cleanup'), { code: 'EACCES' });
const child = new EventEmitter();
Object.assign(child, { pid: 719000001, stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
let starts = 0, reads = 0, stops = 0;
const context = vm.createContext({ process: { platform: 'linux', execPath: process.execPath, env: {}, argv: [],
  cwd: () => project, kill(pid, signal) {
    assert.equal(pid, -child.pid, 'never inspect or stop another process');
    if (signal === 'SIGTERM') { stops++; if (cleanupFailed) throw cleanupError; return true; }
    assert.equal(signal, 0); throw Object.assign(Error('synthetic group stopped'), { code: 'ESRCH' });
  } }, setTimeout, clearTimeout });
const script = new vm.SourceTextModule(await fs.readFile(source, 'utf8'), { context, identifier: source });
await script.link(async specifier => {
  let values;
  if (specifier === 'node:fs/promises') values = { ...fs, readFile: async (file, ...args) => {
    if (String(file) === join(project, '.opencode/v2-service-state/opencode/service.json')) { reads++; throw startupError; }
    return fs.readFile(file, ...args);
  } };
  else if (specifier === 'node:child_process') values = { spawn: () => {
    starts++;
    setImmediate(() => readiness ? child.emit('error', startupError)
      : child.stdout.write('server listening on http://127.0.0.1:7191\n'));
    return child;
  } };
  else values = await import(specifier.startsWith('.') ? new URL(specifier, pathToFileURL(source)) : specifier);
  return new vm.SyntheticModule(Object.keys(values), function () {
    for (const [name, value] of Object.entries(values)) this.setExport(name, value);
  }, { context });
});
await script.evaluate();
let rejected;
try { await script.namespace.startV2ReleaseServer(project, {}, { inheritEnvironment: false }); }
catch (error) { rejected = error; }
await fs.writeFile(join(directory, 'fixture-receipt.json'), JSON.stringify({ phase, starts, reads, stops,
  original_error_identity_retained: rejected === startupError,
  rejected: { name: rejected.name, code: rejected.code, message: rejected.message, serverStartContext: rejected.serverStartContext },
  native_model_requests: 0, actual_server_or_process_started: false }, null, 2) + '\n');
