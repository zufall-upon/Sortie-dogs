import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, mkdirSync, writeFileSync, createWriteStream, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function route(platform, mode) {
  if (!['quick', 'full', 'windows'].includes(mode)) throw new Error(`Unknown test mode: ${mode}`);
  if (mode === 'windows' && platform !== 'win32') throw new Error('test:windows requires Windows');
  return platform === 'win32' && mode !== 'windows' ? 'wsl' : 'native';
}

export function snapshot(root) {
  const names = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, maxBuffer: 32 * 1024 * 1024 }).toString().split('\0');
  const files = [];
  for (const path of [...new Set(names)].filter(Boolean).sort()) {
    if (path.split('/').some(p => ['.git', 'node_modules', 'dist', '_testenv'].includes(p))) continue;
    let stat;
    try { stat = lstatSync(resolve(root, path)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) files.push({ path, link: readlinkSync(resolve(root, path)) });
    else if (stat.isFile()) files.push({ path, data: readFileSync(resolve(root, path)).toString('base64'), mode: stat.mode & 0o777 });
    else throw new Error(`Unsupported snapshot entry: ${path}`);
  }
  return { files, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}

export function snapshotHelper(source) {
  const helper = source.files.find(file => file.path === 'scripts/wsl-test-helper.mjs');
  if (!helper || typeof helper.data !== 'string') throw new Error('WSL helper must be a regular snapshot file');
  return helper.data;
}

export function run(command, args, options = {}) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    const stop = () => child.kill('SIGTERM');
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    child.once('error', error => { process.off('SIGTERM', stop); process.off('SIGINT', stop); reject(error); });
    child.once('close', code => { process.off('SIGTERM', stop); process.off('SIGINT', stop); done(code ?? 1); });
  });
}

async function offload(mode) {
  const started = Date.now();
  const root = process.cwd();
  const source = snapshot(root);
  const id = `wsl-${Date.now()}-${process.pid}`;
  const logs = resolve(root, '_testenv', id);
  mkdirSync(logs, { recursive: true });
  writeFileSync(resolve(logs, 'source.json'), JSON.stringify({ sha256: source.sha256, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), paths: source.files.map(f => f.path) }));
  console.log(`SORTIE_WSL_SOURCE ${JSON.stringify({ id, sha256: source.sha256, logs })}`);
  const helper = snapshotHelper(source);
  const command = `p=$(mktemp /tmp/sortie-test-XXXXXX.mjs); printf %s ${helper} | base64 -d > $p; node $p; rc=$?; rm -f $p; exit $rc`;
  const child = spawn('wsl.exe', ['--distribution', process.env.SORTIE_WSL_DISTRO || 'Ubuntu', '--exec', 'bash', '-lc', command], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const out = createWriteStream(resolve(logs, 'stdout.log'));
  const err = createWriteStream(resolve(logs, 'stderr.log'));
  child.stdout.pipe(out); child.stderr.pipe(err);
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  child.stdin.on('error', () => {});
  child.stdin.write(JSON.stringify({ ...source, mode, id }) + '\n');
  const heartbeat = setInterval(() => {
    if (process.env.SORTIE_TEST_CANCEL_FILE && existsSync(process.env.SORTIE_TEST_CANCEL_FILE)) child.stdin.end();
    else if (!child.stdin.writableEnded) child.stdin.write('heartbeat\n');
  }, 1000);
  const cancel = () => child.stdin.end();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  return await new Promise((done, reject) => {
    child.once('error', error => {
      clearInterval(heartbeat); process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
      out.end(); err.end();
      reject(error);
    });
    child.once('close', code => {
      clearInterval(heartbeat); process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
      writeFileSync(resolve(logs, 'result.json'), JSON.stringify({ exit: code ?? 1, sha256: source.sha256, duration_ms: Date.now() - started }));
      done(code ?? 1);
    });
  });
}

export async function main(mode) {
  if (route(process.platform, mode) === 'wsl') return await offload(mode);
  {
    const build = process.platform === 'win32'
      ? await run(process.execPath, [process.env.npm_execpath || resolve(process.execPath, '../node_modules/npm/bin/npm-cli.js'), 'run', 'build'])
      : await run('npm', ['run', 'build']);
    if (build) return build;
  }
  const args = ['--experimental-strip-types'];
  if (mode === 'full') args.push('test/helpers/full-test-runner.ts');
  else args.push('--import', './test/setup.ts', '--test', ...(mode === 'windows'
    ? readdirSync('test/windows').filter(p => p.endsWith('.test.ts')).map(p => `test/windows/${p}`)
    : ['test/plugin.test.ts', 'test/continuation.test.ts', 'test/fast-lane.test.ts', 'test/swebench-lite-grader.test.ts', 'test/swebench-lite-supervisor.test.ts', 'test/swebench-lite-runner.test.ts', 'test/swebench-test-reset.test.ts']));
  mkdirSync('_testenv', { recursive: true });
  return await run(process.execPath, args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await main(process.argv[2]); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
