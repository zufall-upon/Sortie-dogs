import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { monitorMissionCLI } from '../../scripts/mission-cli-probe.mjs';
import { stopProcessGroup } from '../../scripts/release-cli.mjs';

// Run the real lifecycle code with an owned synthetic server process, no OpenCode/model.
const directory = process.argv[2], source = resolve('scripts/release-cli.mjs');
const context = vm.createContext({ process, Buffer, console, setTimeout, clearTimeout });
const module = new vm.SourceTextModule(await readFile(source, 'utf8'), { context, identifier: source,
  initializeImportMeta(meta) { meta.filename = source; meta.url = pathToFileURL(source).href; } });
let spawns = 0, requestedPassword;
const serverProgram = `
  const fs = require('node:fs'), path = require('node:path');
  const state = path.join(process.env.XDG_STATE_HOME, 'opencode');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'service.json'), JSON.stringify({ url: 'http://127.0.0.1:12345', password: 'fixture-service-password' }));
  console.log('server listening on http://127.0.0.1:12345');
  console.log('x'.repeat(30000) + process.env.OPENCODE_SERVER_PASSWORD + ' fixture-service-password');
  console.error('y'.repeat(30000) + ' fixture-server-failure ' + process.env.OPENCODE_SERVER_PASSWORD + ' fixture-service-password');
  setInterval(() => {}, 1000);
`;
await module.link(async specifier => {
  const original = await import(specifier.startsWith('.') ? new URL(specifier, pathToFileURL(source)) : specifier);
  const values = specifier === 'node:child_process' ? { ...original, spawn: (_exe, args, options) => {
    assert.equal(args[0], 'serve'); spawns++; requestedPassword = options.env.OPENCODE_SERVER_PASSWORD;
    return spawn(process.execPath, ['-e', serverProgram], options);
  } } : original;
  return new vm.SyntheticModule(Object.keys(values), function () {
    for (const [name, value] of Object.entries(values)) this.setExport(name, value);
  }, { context });
});
await module.evaluate();
await mkdir(directory, { recursive: true });
const server = await module.namespace.startV2ReleaseServer(directory, {}, { inheritEnvironment: false });
const cli = spawn(process.execPath, ['-e', 'console.log("ROOT_TURN_CLOSED")'], {
  detached: true, stdio: ['ignore', 'pipe', 'pipe'],
});
try {
  const monitored = monitorMissionCLI({ child: cli, server, project: directory, root: 'fixture-root',
    databasePath: join(directory, 'unused.db'), since: Date.now(), rootAgent: 'dog-operator', mode: 'complete',
    rootModel: 'openai/gpt-6.1-sol#xhigh', capUSD: 2, timeoutSeconds: 5,
    observe: () => ({ root: 'fixture-root', models: [], tools: [], responses: [], errors: [], priced_usd: 0, unpriced_requests: 0 }),
    pending: async () => true,
    finish: async result => ({ stopped: result.stopped, code: result.code, observation_error: result.observationError,
      usage_complete: result.observed.usage_complete, unpriced_requests: result.observed.unpriced_requests }),
  });
  await new Promise(done => cli.once('close', done));
  process.kill(server.pid, 'SIGTERM');
  const result = await monitored;
  // Neither the requested random password nor registration password may enter the receipt.
  assert.ok(!JSON.stringify(result).includes(requestedPassword));
  assert.ok(!JSON.stringify(result).includes(server.env.OPENCODE_SERVER_PASSWORD));
  await writeFile(join(directory, 'signal-receipt.json'), JSON.stringify({ ...result,
    closed_promise_value: await server.closed, spawns }) + '\n');
  console.log('PASS_OWNED_SERVER_SIGNAL_DIAGNOSTICS');
} finally { await Promise.all([stopProcessGroup(cli), server.stop()]); }
