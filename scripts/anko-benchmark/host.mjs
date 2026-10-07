import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';

export function comparablePath(value) {
  const path = String(value ?? '').replaceAll('\\', '/');
  return /^[a-z]:\//iu.test(path) ? path.toLowerCase() : path;
}

export function assertReusableDriver(saved, current, platform = process.platform) {
  assert.equal(current.version, saved.version, 'fixed @opencode/client version changed');
  // The repository lock also carries the Sortie version. It is captured afresh
  // for each arm, not a cross-version Linux driver installation identity.
  if (platform === 'win32') assert.equal(current.package_lock_sha256, saved.package_lock_sha256,
    'fixed Windows driver lock changed');
}

// Host preparation is separate from benchmark/task conditions. No permission rules.
export function hostPaths({ root = process.cwd(), platform = process.platform, home = homedir(), env = process.env } = {}) {
  const windows = platform === 'win32';
  const path = windows ? win32 : { join };
  const legacy = path.join(root, '_testenv', windows ? 'anko-v0137-20261005' : 'anko-v0139-linux-20261007');
  const prepared = path.join(root, '_testenv', windows ? 'anko-v0136-20261004' : 'anko-linux-reusable/toolchains');
  const clientRoot = path.join(root, windows ? '.sortie-env' : '.');
  return {
    platform,
    legacy_run: legacy,
    source_project: env.ANKO_SOURCE_PROJECT ?? path.join(legacy, windows ? 'project' : 'anko'),
    instruction: env.ANKO_INSTRUCTION ?? path.join(windows ? prepared : legacy, windows ? 'instruction.md' : 'original-task.md'),
    cli: env.ANKO_CLI ?? (windows ? 'C:/Users/rozen/AppData/Roaming/ai.opencode.desktop/cli/2.0.18/opencode-cli.exe'
      : path.join(prepared, 'opencode-2.0.18/node_modules/@opencode/cli-linux-x64/bin/opencode')),
    host_database: env.ANKO_HOST_DATABASE ?? path.join(home, '.local/share/opencode/opencode.db'),
    go_directory: env.ANKO_GO_DIRECTORY ?? path.join(prepared, windows ? 'tools/go' : 'go'),
    go_archive: env.ANKO_GO_ARCHIVE ?? path.join(prepared, 'go1.27.1.linux-amd64.tar.gz'),
    client_package: path.join(clientRoot, 'node_modules/@opencode/client/package.json'),
    client_entry: path.join(clientRoot, 'node_modules/@opencode/client/dist/promise/index.js'),
    client_lock: path.join(clientRoot, 'package-lock.json'),
    artifact_root: env.ANKO_ARTIFACT_ROOT ?? (windows ? 'M:/_work/_Sortie-dogs-artifacts/records/anko-reusable'
      : path.join(root, '_testenv/anko-records')),
    release_root: env.ANKO_RELEASE_ROOT ?? (windows ? 'M:/_work/_Sortie-dogs-artifacts/releases'
      : path.join(root, '_testenv/releases')),
  };
}

export function npmCommand(args, { platform = process.platform, execPath = process.execPath, npmExecPath = process.env.npm_execpath } = {}) {
  if (platform !== 'win32') return { file: 'npm', args };
  return { file: execPath, args: [npmExecPath ?? win32.join(win32.dirname(execPath), 'node_modules/npm/bin/npm-cli.js'), ...args] };
}

export function goToolchain(paths, project, execute = execFileSync) {
  const options = { encoding: 'utf8', windowsHide: true };
  const native = paths.platform !== 'win32';
  const directory = native ? paths.go_directory : execute('wsl.exe', ['-e', 'wslpath', '-a', paths.go_directory], options).trim();
  const workspace = native ? project : execute('wsl.exe', ['-e', 'wslpath', '-a', project], options).trim();
  const executable = `${directory}/bin/go`;
  const variables = { GOCACHE: `${workspace}/.gocache`, GOMODCACHE: `${workspace}/.gomodcache`,
    GOPATH: `${workspace}/.gopath`, TMPDIR: `${workspace}/.tmp`, GOTOOLCHAIN: 'local' };
  const invocation = args => native ? { file: executable, args, env: { ...process.env, ...variables } }
    : { file: 'wsl.exe', args: ['--cd', workspace, '-e', '/usr/bin/env',
      ...Object.entries(variables).map(([key, value]) => `${key}=${value}`), executable, ...args] };
  const test = native ? { file: '/usr/bin/env', args: [...Object.entries(variables).map(([key, value]) => `${key}=${value}`), executable, 'test', './...'] }
    : invocation(['test', './...']);
  const quote = value => `"${value.replaceAll('"', '\\"')}"`;
  return { executable, workspace, variables, invocation,
    validation_command: [test.file, ...test.args].map(quote).join(' '),
    environment_description: native ? `Linux native Go: ${executable}` : `Windows host / WSL Ubuntu Go: ${executable}` };
}

export async function loadClient(paths = hostPaths()) {
  try { return await import(pathToFileURL(paths.client_entry).href); }
  catch (error) { throw new Error(`Anko driver client unavailable at ${paths.client_entry}; install repository dependencies (npm ci) or restore .sortie-env on Windows`, { cause: error }); }
}
