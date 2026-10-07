import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ANKO_BASE, CLI, CLI_SHA256, CLIENT_LOCK_SHA256, CLI_VERSION, HOST, INSTRUCTION_SHA256, LEGACY_RUN,
  SOURCE_PROJECT, STATE_ROOT, fixedProfile, hashFile, packageJsonFromTgz, packageReceiptPath,
   packageRoot, profilePath, readJson, sha256, tarEntryFromTgz, versionRoot, writeJson,
} from './core.mjs';
import { assertReusableDriver, npmCommand, goToolchain } from './host.mjs';

const toUrl = path => pathToFileURL(path).href;
const hex = bytes => createHash('sha256').update(bytes).digest('hex');

async function sourceArchive(version, explicitPath) {
  if (explicitPath) return explicitPath;
  if (version === '0.13.8' && process.platform === 'win32') return join(LEGACY_RUN, 'sortie-dogs-0.13.8.tgz');
  return join(HOST.release_root, process.platform === 'win32' ? `v${version}` : version, `sortie-dogs-${version}.tgz`);
}

async function ensureProfile() {
  const path = profilePath();
  const sourceAgents = join(process.cwd(), 'AGENTS.md');
  const agentsBytes = await readFile(sourceAgents);
  const instructionsPath = join(STATE_ROOT, 'common', 'AGENTS.md');
  const npm = npmCommand(['--version']);
  const npmVersion = execFileSync(npm.file, npm.args, { encoding: 'utf8', windowsHide: true }).trim();
  const clientPackagePath = HOST.client_package;
  const clientPackage = JSON.parse(await readFile(clientPackagePath, 'utf8'));
  const clientLockPath = HOST.client_lock;
  const profile = {
    ...fixedProfile(),
    prepared_at: new Date().toISOString(),
    repo_root: process.cwd(),
    applicable_agents_sha256: hex(agentsBytes),
    cli: { path: CLI, version: CLI_VERSION, sha256: await hashFile(CLI) },
    node: { version: process.version, platform: process.platform },
    npm: { version: npmVersion },
    paths: HOST,
    driver_client: { package: '@opencode/client', version: clientPackage.version,
      package_lock_sha256: await hashFile(clientLockPath) },
    common_preparation: {
      driver_client_installation: clientPackagePath,
      go_installation: HOST.go_directory,
      candidate_template: SOURCE_PROJECT,
      per_version_control_profile: 'version-specific installed package; unchanged setup reused',
    },
  };
  assert.equal(execFileSync(CLI, ['--version'], { encoding: 'utf8' }).trim(), `opencode v${CLI_VERSION}`);
  if (process.platform === 'win32') assert.equal(profile.cli.sha256, CLI_SHA256, 'fixed OpenCode CLI changed');
  assert.equal(profile.driver_client.version, CLI_VERSION, 'fixed @opencode/client version changed');
  if (process.platform === 'win32') assert.equal(profile.driver_client.package_lock_sha256, CLIENT_LOCK_SHA256, 'fixed @opencode/client lock changed');
  assert.equal(profile.benchmark.base, ANKO_BASE);
  assert.equal(profile.benchmark.instruction_sha256, INSTRUCTION_SHA256);
  await mkdir(dirname(path), { recursive: true });
  if (await fileExists(path)) {
    const existing = await readJson(path);
    assert.equal(existing.applicable_agents_sha256, profile.applicable_agents_sha256,
      'AGENTS.md changed after the common profile was fixed; do not silently replace it');
    assert.deepEqual(existing.benchmark, profile.benchmark, 'common benchmark conditions changed');
    assert.deepEqual(existing.stall_policy, profile.stall_policy, 'fixed no-progress policy changed');
    assert.equal(existing.cli.sha256, profile.cli.sha256);
    assertReusableDriver(existing.driver_client, profile.driver_client);
    if (existing.paths) assert.deepEqual(existing.paths, HOST, 'saved host preparation paths changed');
  } else {
    assert.equal(await hashFile(HOST.instruction), INSTRUCTION_SHA256, 'Anko task input changed');
    const checkDirectory = join(STATE_ROOT, 'common/toolchain-check');
    await Promise.all(['.gocache', '.gomodcache', '.gopath', '.tmp'].map(name => mkdir(join(checkDirectory, name), { recursive: true })));
    const go = goToolchain(HOST, checkDirectory);
    const versionCommand = go.invocation(['version']);
    const version = execFileSync(versionCommand.file, versionCommand.args, { encoding: 'utf8', env: versionCommand.env }).trim();
    assert.equal(version, 'go version go1.27.1 linux/amd64');
    const std = go.invocation(['list', 'std']);
    profile.go = { version, archive_sha256: await hashFile(HOST.go_archive),
      stdlib_package_count: execFileSync(std.file, std.args, { encoding: 'utf8', env: std.env }).trim().split(/\r?\n/u).length };
    assert.equal(profile.go.archive_sha256, '63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445');
    await writeJson(path, profile, { flag: 'wx' });
    await writeFile(instructionsPath, agentsBytes, { flag: 'wx' });
  }
  const retainedAgents = await readFile(instructionsPath);
  assert.equal(hex(retainedAgents), profile.applicable_agents_sha256, 'saved AGENTS.md differs from current profile');
  return { path, profile: await readJson(path), instructionsPath };
}

async function fileExists(path) {
  try { await readFile(path); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function ensureVersionControl(version, packageReceipt) {
  const control = join(versionRoot(version), 'template-project/.opencode');
  const controlLock = join(control, 'package-lock.json');
  const controlManifest = join(control, 'package.json');
  if (await fileExists(controlLock)) {
    const lock = JSON.parse(await readFile(controlLock, 'utf8'));
    assert.equal(lock.packages?.['node_modules/sortie-dogs']?.version, version);
    assert.equal(lock.packages?.['node_modules/sortie-dogs']?.integrity, packageReceipt.integrity);
    const installed = JSON.parse(await readFile(join(control, 'node_modules/sortie-dogs/package.json'), 'utf8'));
    assert.equal(installed.version, version);
    return { path: control, reused: true, package_lock_sha256: await hashFile(controlLock) };
  }

  await mkdir(join(versionRoot(version), 'template-project'), { recursive: true });
  const sourceControl = join(SOURCE_PROJECT, '.opencode');
  if (process.platform === 'win32') await cp(sourceControl, control, { recursive: true, force: false, errorOnExist: true });
  else await mkdir(control, { recursive: true });
  const manifest = process.platform === 'win32' ? JSON.parse(await readFile(controlManifest, 'utf8')) : { private: true, type: 'module' };
  manifest.dependencies = { ...(manifest.dependencies ?? {}), 'sortie-dogs': toUrl(packageReceipt.archive_path) };
  await writeFile(controlManifest, `${JSON.stringify(manifest, null, 2)}\n`);

  const profileHome = join(versionRoot(version), 'npm-home');
  const npmCache = join(STATE_ROOT, 'common/npm-cache');
  await mkdir(profileHome, { recursive: true });
  await mkdir(npmCache, { recursive: true });
  const env = { ...process.env, HOME: profileHome, USERPROFILE: profileHome,
    APPDATA: join(profileHome, 'appdata'), LOCALAPPDATA: join(profileHome, 'localappdata'),
    NPM_CONFIG_CACHE: npmCache, NPM_CONFIG_USERCONFIG: join(profileHome, 'npmrc'),
    NPM_CONFIG_GLOBALCONFIG: join(profileHome, 'global-npmrc'), NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/' };
  for (const name of Object.keys(env)) if (/(?:API[_-]?KEY|ACCESS[_-]?KEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|(?:^|_)TOKEN(?:_|$)|PASSWORD|SECRET|CREDENTIAL|COOKIE|AUTH|NODE_OPTIONS|NODE_PATH|GIT_ASKPASS|SSH_AUTH_SOCK|SSH_AGENT_PID)/iu.test(name)) delete env[name];
  await Promise.all([writeFile(env.NPM_CONFIG_USERCONFIG, '\n'), writeFile(env.NPM_CONFIG_GLOBALCONFIG, '\n')]);
  const npm = npmCommand(['install', '--no-audit', '--no-fund', '--ignore-scripts']);
  execFileSync(npm.file, npm.args, {
    cwd: control, env, stdio: 'inherit', windowsHide: true,
  });
  const initProject = join(versionRoot(version), 'template-project');
  const configPath = join(control, 'opencode.json');
  const savedConfig = process.platform === 'win32' ? await readFile(configPath) : null;
  execFileSync(process.execPath, [join(control, 'node_modules/sortie-dogs/dist/cli/main.js'),
    'init', initProject, '--profile', 'v010'], { cwd: initProject, env, stdio: 'inherit', windowsHide: true });
  if (savedConfig) await writeFile(configPath, savedConfig);
  else {
    await mkdir(join(control, 'plugins/sortie-dogs'), { recursive: true });
    await writeFile(join(control, 'plugins/sortie-dogs/index.js'), "export { default } from 'sortie-dogs/server';\n");
    await writeFile(configPath, JSON.stringify({ $schema: 'https://opencode.ai/config.json', plugins: ['./plugins/sortie-dogs'] }, null, 2) + '\n');
  }
  const lock = JSON.parse(await readFile(controlLock, 'utf8'));
  assert.equal(lock.packages?.['node_modules/sortie-dogs']?.version, version);
  assert.equal(lock.packages?.['node_modules/sortie-dogs']?.integrity, packageReceipt.integrity);
  return { path: control, reused: false, package_lock_sha256: await hashFile(controlLock) };
}

export async function prepareVersion(version, explicitPackagePath) {
  const profileResult = await ensureProfile();
  const generator = await ensureGoGenerator();
  const retainedReceipt = await fileExists(packageReceiptPath(version)) ? await readJson(packageReceiptPath(version)) : null;
  const source = explicitPackagePath ?? retainedReceipt?.archive_path ?? await sourceArchive(version, null);
  const bytes = await readFile(source);
  const packageJson = packageJsonFromTgz(bytes);
  assert.equal(packageJson.name, 'sortie-dogs', 'selected archive is not a Sortie-dogs package');
  assert.equal(packageJson.version, version, 'selected archive version does not match --version');
  const destination = join(packageRoot(version), `sortie-dogs-${version}.tgz`);
  const sha256 = hex(bytes);
  const sha1 = createHash('sha1').update(bytes).digest('hex');
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const receiptPath = packageReceiptPath(version);
  const existingReceipt = await fileExists(receiptPath) ? await readJson(receiptPath) : null;
  if (existingReceipt) {
    assert.equal(existingReceipt.sha256, sha256, 'an existing version receipt pins a different package; never replace it');
    assert.equal(await hashFile(destination), sha256, 'stored package changed after its receipt was fixed');
  } else {
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { force: false, errorOnExist: true });
  }
  const oldMetadata = version === '0.13.8' && process.platform === 'win32' ? await readJson(join(LEGACY_RUN, 'candidate-package.json')) : {};
  const receipt = existingReceipt ?? {
    schema_version: 1,
    version,
    archive_path: destination,
    source_archive_path: source,
    archive_filename: `sortie-dogs-${version}.tgz`,
    sha256, sha1, integrity,
    runtime_marker: oldMetadata.runtime_marker ?? /V010_RUNTIME_ASSET_VERSION\s*=\s*["']([^"']+)["']/u.exec(
      tarEntryFromTgz(bytes, 'package/dist/asset-version.js').toString('utf8'))?.[1] ?? null,
    source_kind: oldMetadata.source_kind ?? 'version-pinned package archive',
    source_commit: oldMetadata.source_commit ?? null,
    patch_sha256: oldMetadata.patch_sha256 ?? null,
    package_name: packageJson.name,
    package_version: packageJson.version,
    fixed_at: new Date().toISOString(),
  };
  assert.equal(receipt.sha256, sha256);
  assert.equal(receipt.integrity, integrity);
  if (!existingReceipt) await writeJson(receiptPath, receipt, { flag: 'wx' });

  const control = await ensureVersionControl(version, receipt);
  const frozenPath = join(versionRoot(version), 'frozen-inputs.json');
  if (!(await fileExists(frozenPath))) {
    if (process.platform === 'win32') await cp(join(LEGACY_RUN, 'frozen-inputs.json'), frozenPath, { force: false, errorOnExist: true });
    else await writeJson(frozenPath, { [HOST.instruction]: await hashFile(HOST.instruction),
      [HOST.go_archive]: await hashFile(HOST.go_archive) }, { flag: 'wx' });
  }
  const setupPath = join(versionRoot(version), 'setup.json');
  const setup = await fileExists(setupPath) ? await readJson(setupPath) : {
    prepared_at: new Date().toISOString(),
    package_version: version,
    package_receipt_sha256: sha256,
    package_path: destination,
    package_lock_sha256: control.package_lock_sha256,
    profile_sha256: await hashFile(profileResult.path),
    applicable_agents_sha256: profileResult.profile.applicable_agents_sha256,
    template_source: SOURCE_PROJECT,
    template_base: ANKO_BASE,
    control_profile: control.path,
    control_profile_reused: control.reused,
    frozen_inputs_sha256: await hashFile(frozenPath),
    benchmark_roots_created: 0,
    prior_trials_resumed: false,
  };
  if (!(await fileExists(setupPath))) await writeJson(setupPath, setup, { flag: 'wx' });
  assert.equal(setup.package_receipt_sha256, sha256, 'version setup is pinned to another archive');
  assert.equal(setup.profile_sha256, await hashFile(profileResult.path), 'common profile changed after setup');
  assert.equal(setup.frozen_inputs_sha256, await hashFile(frozenPath), 'frozen source evidence changed after setup');
  return { version, receipt_path: receiptPath, sha256, archive_path: destination,
    profile_path: profileResult.path, setup_path: setupPath, control_profile: control.path,
    reused_control_profile: control.reused, generator };
}

export async function ensureGoGenerator() {
  const directory = join(STATE_ROOT, 'common/toolchain-check');
  await Promise.all(['.gocache', '.gomodcache', '.gopath', '.tmp'].map(name => mkdir(join(directory, name), { recursive: true })));
  const binary = join(directory, '.gopath/bin/goyacc');
  const receiptPath = join(directory, 'goyacc.json');
  if (await fileExists(receiptPath) && await fileExists(binary)) {
    const receipt = await readJson(receiptPath);
    assert.equal(await hashFile(binary), receipt.sha256);
    return receipt;
  }
  const go = goToolchain(HOST, directory);
  const install = go.invocation(['install', 'golang.org/x/tools/cmd/goyacc@v0.42.0']);
  execFileSync(install.file, install.args, { cwd: directory, env: install.env, stdio: 'inherit', windowsHide: true });
  const check = go.invocation(['version', '-m', `${go.variables.GOPATH}/bin/goyacc`]);
  const version = execFileSync(check.file, check.args, { cwd: directory, env: check.env, encoding: 'utf8', windowsHide: true });
  assert.match(version, /golang.org\/x\/tools\s+v0\.42\.0/u);
  const receipt = { path: binary, module: 'golang.org/x/tools/cmd/goyacc@v0.42.0',
    sha256: await hashFile(binary), version, prepared_at: new Date().toISOString() };
  await writeJson(receiptPath, receipt);
  return receipt;
}

export async function showProfile() {
  const result = await ensureProfile();
  const output = { profile_path: result.path, profile_sha256: await hashFile(result.path), profile: result.profile };
  console.log(JSON.stringify(output, null, 2));
  return output;
}

export async function prepareCommand(version, packagePath) {
  const result = await prepareVersion(version, packagePath);
  console.log(JSON.stringify({ preparation: 'ready', ...result }, null, 2));
  return result;
}
