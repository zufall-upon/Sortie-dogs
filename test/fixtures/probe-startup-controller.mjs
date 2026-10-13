import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as release from '../../scripts/release-cli.mjs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

// Actual probe source, synthetic installation/git/startup; no native CLI/model.
const [directory, phase] = process.argv.slice(2);
const run = join(directory, 'smoke-1'), project = join(run, 'project');
await fs.mkdir(project, { recursive: true });
const tgz = join(directory, 'seeded-package.tgz'); await fs.writeFile(tgz, 'fixture-only-package-bytes\n');
const budgetFile = join(directory, 'projected-budget.json');
await fs.writeFile(budgetFile, JSON.stringify({ prior_priced_usd: 1.7674084, unresolved_prior_reserve_usd: 1,
  limit_usd: 5, new_probe_total_limit_usd: 2, per_probe_limit_usd: 2, probes: [] }));
const failure = Object.assign(Error('injected-owned-probe-server-start'), { code: 'EIO' });
if (phase.includes('cleanup')) failure.serverStartContext = {
  serverPID: 719000001, stateDirectory: join(project, '.opencode/v2-service-state'), cleanup_complete: false,
  cleanupErrors: [{ resource: 'server', name: 'Error', code: 'EACCES', message: 'injected-owned-start-cleanup' }],
  nextAction: 'Retry teardown only for the recorded owned server PID/process group; retain unresolved usage holds. Do not automatically replay the consumed startup/task or restart the shared host.' };
const env = { OPENCODE_DB: join(run, 'data/opencode/opencode.db'), XDG_DATA_HOME: join(run, 'data') };
const source = resolve('scripts/mission-cli-probe.mjs');
let installations = 0, starts = 0, cliStarts = 0, writes = 0;
const commands = [];
const context = vm.createContext({ process: { argv: [], env: {}, cwd: () => project, execPath: process.execPath },
  setTimeout, clearTimeout, setInterval, clearInterval });
const script = new vm.SourceTextModule(await fs.readFile(source, 'utf8'), { context, identifier: source });
await script.link(async specifier => {
  let values;
  if (specifier === './release-cli.mjs') values = { ...release,
    installedFixture: async () => { installations++; return { project, run, env,
      pkg: { version: '0.13.19' }, runtimeMarker: 'fixture-only-projection', runtime: { stateDirectory: '.sortie-dogs-v010' } }; },
    command: async (exe, args) => { commands.push({ exe, args }); return args[0] === 'rev-parse' ? 'b'.repeat(40) + '\n' : ''; },
    startV2ReleaseServer: async () => { starts++; throw failure; },
    spawnPromptCLI: () => { cliStarts++; throw Error('must not launch CLI after failed server start'); },
  };
  else if (specifier === 'node:fs/promises') values = { ...fs, writeFile: async (file, ...args) => {
    if (String(file) === join(run, 'observation.json')) {
      writes++;
      if (phase.endsWith('persistence-error')) throw Object.assign(Error('injected-owned-startup-receipt-write'), { code: 'EACCES' });
    }
    return fs.writeFile(file, ...args);
  } };
  else values = await import(specifier.startsWith('.') ? new URL(specifier, pathToFileURL(source)) : specifier);
  return new vm.SyntheticModule(Object.keys(values), function () {
    for (const [name, value] of Object.entries(values)) this.setExport(name, value);
  }, { context });
});
await script.evaluate();
let rejected, result;
try { await script.namespace.probe(tgz, directory, { mode: 'complete', timeoutSeconds: 30, capUSD: 2,
  budgetFile, prompt: 'retained immutable fixture task, not a native model request' }); }
catch (error) { rejected = error; }
assert.equal(rejected, failure);
try { result = JSON.parse(await fs.readFile(join(run, 'observation.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await fs.writeFile(join(directory, 'fixture-receipt.json'), JSON.stringify({ phase, installations, starts, cliStarts,
  writes, commands, original_error_identity_retained: rejected === failure,
  rejected: { name: rejected.name, code: rejected.code, message: rejected.message, monitorContext: rejected.monitorContext },
  result, projected_budget: JSON.parse(await fs.readFile(budgetFile, 'utf8')), native_model_requests: 0,
  actual_installation_or_CLI_started: false }, null, 2) + '\n');
