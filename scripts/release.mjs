import { readFile, readdir, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Release, readJSON, withReleaseLock } from './release-core.mjs';
import { runProcess, commandFor } from './release-process.mjs';
import { releaseProfile } from './release-profiles.mjs';

export async function verifyGlobal(root, globalRoot, version, profile = releaseProfile()) {
  const installed = join(globalRoot, 'node_modules/sortie-dogs');
  if ((await readJSON(join(installed, 'package.json'))).version !== version) throw Error('Global package version mismatch');
  if ((await lstat(installed)).isSymbolicLink()) throw Error('Global package must be a tarball installation');
  const { runtimeAssets } = await import(pathToFileURL(join(installed, 'dist', profile.assetsModule)).href);
  const versions = await import(pathToFileURL(join(installed, 'dist/asset-version.js')).href);
  const RUNTIME_ASSET_VERSION = versions[profile.markerExport];
  if ((await readFile(join(globalRoot, profile.markerFile), 'utf8')).trim() !== RUNTIME_ASSET_VERSION) throw Error('Global runtime marker mismatch');
  for (const asset of runtimeAssets) {
    if (asset.version !== RUNTIME_ASSET_VERSION || await readFile(join(globalRoot, asset.installPath), 'utf8') !== asset.content) throw Error(`Global asset mismatch: ${asset.installPath}`);
  }
  for (const path of await readdir(join(root, 'dist'), { recursive: true })) {
    const local = join(root, 'dist', path);
    if (!(await lstat(local)).isFile()) continue;
    if (!(await readFile(local)).equals(await readFile(join(installed, 'dist', path)))) throw Error(`Installed code mismatch: ${path}`);
  }
  await import(pathToFileURL(join(installed, 'dist/plugin/opencode.js')).href);
  return { version, runtimeMarker: RUNTIME_ASSET_VERSION, assets: runtimeAssets.length };
}

export function productionExecutor(root, manifest, version) {
  const profile = releaseProfile(manifest.releaseProfile);
  const execute = async (tool, args, options = {}) => {
    if (tool === 'global' || tool === 'global-verify') {
      if (tool === 'global') {
        const install = await execute('npm', ['install', '--prefix', args[1], '--no-save', '--force', args[0]], options);
        if (install.code !== 0) return install;
        const init = await execute('node', [join(args[1], 'node_modules/sortie-dogs/dist/cli/main.js'), 'init', '--global', '--profile', profile.runtimeProfile],
          { ...options, env: { OPENCODE_CONFIG_DIR: args[1] } });
        if (init.code !== 0) return init;
      }
      return { code: 0, stdout: JSON.stringify(await verifyGlobal(root, args[1], version, profile)), stderr: '' };
    }
    let executable = tool, argv = args;
    if (tool === 'npm') executable = manifest.npm;
    if (tool === 'gh') executable = manifest.gh;
    if (tool === 'cli') { executable = process.execPath; argv = [join(root, 'scripts/release-cli.mjs'), ...args, profile.id]; }
    if (tool === 'recovery') { executable = process.execPath; argv = [join(root, manifest.recovery.driver), ...args]; }
    const command = commandFor(executable, argv);
    const env = { ...process.env, ...options.env };
    if (tool === 'gh') delete env.GITHUB_TOKEN;
    return runProcess(command.executable, command.args, { cwd: root, ...options, env });
  };
  return execute;
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  const option = name => { const index = args.indexOf(name); if (index < 0 || !args[index + 1]) throw Error(`${name} required`); return args[index + 1]; };
  if (!['prepare', 'verify-publish'].includes(action)) throw Error('Usage: release.mjs prepare|verify-publish --version <version> --manifest <path>');
  const root = resolve(import.meta.dirname, '..');
  const version = option('--version');
  const manifest = await readJSON(resolve(root, option('--manifest')));
  const release = new Release({ root, version, manifest, execute: productionExecutor(root, manifest, version),
    progress: name => process.stderr.write(`release ${version}: ${name}\n`) });
  const result = action === 'prepare'
    ? await withReleaseLock(join(root, '_testenv/releases'), () => release.prepare())
    : await release.verifyPublish();
  console.log(JSON.stringify(result, null, 2));
  if (action === 'prepare') {
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    console.log(`\n# Run manually in PowerShell; no credentials are persisted by this batch.
$npm = ${quote(manifest.npm)}
$registry = 'https://registry.npmjs.org/'
$tgz = ${quote(release.tgz)}
& $npm whoami --registry=$registry
if ($LASTEXITCODE -ne 0) {
  & $npm login --auth-type=web --browser=true --registry=$registry
  if ($LASTEXITCODE -ne 0) { throw 'npm login failed' }
  & $npm whoami --registry=$registry
  if ($LASTEXITCODE -ne 0) { throw 'npm authentication unavailable' }
}
& $npm publish $tgz --access public --registry=$registry --tag ${release.profile.npmTag}
# Only if OTP is requested:
# $otp = Read-Host 'npm OTP'; & $npm publish $tgz --access public --registry=$registry --tag ${release.profile.npmTag} "--otp=$otp"; Remove-Variable otp
& ./scripts/release.ps1 verify-publish -Version ${quote(version)} -Manifest ${quote(option('--manifest'))}`);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch(error => { console.error(`Release stopped: ${error.message}`); process.exitCode = 1; });
}
