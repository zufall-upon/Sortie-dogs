import { readFile, writeFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { installedFixture, command } from './release-cli.mjs';
import { shellQuote } from './release-process.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const workspace = resolve(import.meta.dirname, '..');
function localArtifact(value) {
  const resolved = resolve(value);
  const rel = relative(join(workspace, '_testenv'), resolved);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) {
    throw Error('Dogfooding paths must be inside this worktree _testenv.');
  }
  return resolved;
}

async function inspect(file) {
  const receipt = JSON.parse(await readFile(file, 'utf8'));
  const project = localArtifact(receipt.project);
  const installed = join(project, '.opencode/node_modules/sortie-dogs');
  if (await realpath(installed) !== installed) throw Error('Dogfooding package must be a tarball directory, not a link.');
  const pkg = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  const { runtimeAssets } = await import(pathToFileURL(join(installed, 'dist/runtime-assets-v010.js')).href);
  for (const asset of runtimeAssets) {
    if (await readFile(join(project, '.opencode', asset.installPath), 'utf8') !== asset.content) throw Error(`Asset mismatch: ${asset.name}`);
  }
  if (digest(await readFile(localArtifact(receipt.tarball))) !== receipt.sha256 || pkg.version !== receipt.version) throw Error('Package identity mismatch.');
  const config = JSON.parse(await readFile(join(project, '.opencode/opencode.json'), 'utf8'));
  if (config.default_agent !== 'dog-operator' || config.model !== 'openai/gpt-5.6-sol' || config.experimental?.subagent_depth !== 2) throw Error('Unexpected dogfooding defaults.');
  const primary = runtimeAssets.find(asset => asset.name === 'dog-operator');
  if (!primary || !/^variant: low$/m.test(primary.content)) throw Error('Primary variant is not low.');
  return { ...receipt, project };
}

async function main() {
  const [action, first, second] = process.argv.slice(2);
  if (!['prepare', 'inspect', 'start'].includes(action) || !first || (action === 'prepare' && !second)) {
    throw Error('Usage: dogfood-preview.mjs prepare <tgz> <directory> | inspect <receipt> | start <receipt>');
  }
  if (process.platform === 'win32') {
    const convert = async path => (await command('wsl.exe', ['-e', 'wslpath', '-a', '-u', resolve(path)], workspace)).trim();
    const args = [await convert(import.meta.filename), action, await convert(localArtifact(first))];
    if (second) args.push(await convert(localArtifact(second)));
    const child = spawn('wsl.exe', ['--cd', await convert(workspace), '-e', 'bash', '-ic', `exec node ${args.map(shellQuote).join(' ')}`], { stdio: 'inherit' });
    child.once('error', error => { console.error(error.message); process.exitCode = 1; });
    child.once('close', code => { process.exitCode = code ?? 1; });
    return;
  }
  if (action === 'prepare') {
    const tgz = localArtifact(first), directory = localArtifact(second);
    const fixture = await installedFixture(tgz, directory, 'beta-v010');
    const configPath = join(fixture.control, 'opencode.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    Object.assign(config, { default_agent: 'dog-operator', model: 'openai/gpt-5.6-sol' });
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
    await writeFile(join(fixture.project, '.gitignore'), '.opencode/\n.sortie-dogs-v010/\n');
    await writeFile(join(fixture.project, 'AGENTS.md'), '# Preview dogfooding workspace\nUse only this project. Preserve user criteria, original verification commands and existing files. Keep each task small and low-risk. Do not modify global configuration, publish, or access the adjacent stable checkout. Report incomplete work honestly.\n');
    await command('git', ['init', '-q', '-b', 'main'], fixture.project, fixture.env);
    const receipt = { schema: 1, project: fixture.project, env: fixture.env, tarball: tgz, sha256: digest(await readFile(tgz)),
      version: fixture.pkg.version, runtimeMarker: fixture.runtimeMarker, defaultAgent: 'dog-operator', defaultModel: 'openai/gpt-5.6-sol', defaultVariant: 'low',
      llmExecuted: false, scope: 'dedicated low-risk serial dogfooding; not production acceptance' };
    const file = join(fixture.run, 'dogfood.json');
    await writeFile(file, JSON.stringify(receipt, null, 2) + '\n');
    console.log(JSON.stringify({ receipt: file, ...await inspect(file) }, null, 2));
    return;
  }
  const receipt = await inspect(localArtifact(first));
  if (action === 'inspect') { console.log(JSON.stringify(receipt, null, 2)); return; }
  const child = spawn('opencode', [receipt.project, '--agent', receipt.defaultAgent, '--model', receipt.defaultModel],
    { cwd: receipt.project, env: { ...process.env, ...receipt.env, PWD: receipt.project }, stdio: 'inherit' });
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.once('close', code => { process.exitCode = code ?? 1; });
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
