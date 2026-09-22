import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile, cp, rm, symlink, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin });
let lastHeartbeat = Date.now();
let cancelled = false;
let child;
let stopping;
const owned = new Set();
async function descendants(pid) {
  try {
    const tasks = await readdir(`/proc/${pid}/task`);
    for (const task of tasks) {
      const children = (await readFile(`/proc/${pid}/task/${task}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean).map(Number);
      for (const next of children) if (!owned.has(next)) { owned.add(next); await descendants(next); }
    }
  } catch { /* process closed */ }
}
function stop() {
  return stopping ??= stopTree();
}
async function stopTree() {
  cancelled = true;
  await descendants(process.pid);
  for (const pid of owned) try { process.kill(pid, 'SIGTERM'); } catch {}
  await new Promise(done => setTimeout(done, 2000));
  for (const pid of owned) try { process.kill(pid, 'SIGKILL'); } catch {}
}
input.on('close', () => { if (child) void stop(); else cancelled = true; });
process.on('SIGTERM', stop); process.on('SIGINT', stop);
const packet = await new Promise(resolvePacket => input.once('line', line => resolvePacket(JSON.parse(line))));
input.on('line', () => { lastHeartbeat = Date.now(); });
const watchdog = setInterval(() => { if (Date.now() - lastHeartbeat > 10000) void stop(); }, 1000);
function run(command, args, cwd) {
  if (cancelled) throw new Error('Windows test owner disconnected');
  return new Promise((done, reject) => {
    child = spawn(command, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('error', reject);
    child.once('close', code => { child = undefined; done(code ?? 1); });
  });
}
let root;
try {
  const base = resolve(homedir(), '.cache/sortie-dogs-tests');
  if (base.startsWith('/mnt/')) throw new Error('WSL test cache must be on the Linux filesystem');
  await mkdir(base, { recursive: true });
  root = await mkdtemp(join(base, 'run-'));
  if (createHash('sha256').update(JSON.stringify(packet.files)).digest('hex') !== packet.sha256) throw new Error('Snapshot hash mismatch');
  for (const file of packet.files) {
    if (file.path.startsWith('/') || file.path.split('/').some(p => ['..', '.git', 'node_modules', 'dist', '_testenv'].includes(p))) throw new Error('Invalid snapshot path');
    const path = join(root, file.path);
    await mkdir(resolve(path, '..'), { recursive: true });
    if (file.link !== undefined) await symlink(file.link, path);
    else await writeFile(path, Buffer.from(file.data, 'base64'), { mode: file.mode });
  }
  // Some test fixtures discover the enclosing checkout. Never copy the host Git database.
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const npmVersion = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
  const key = createHash('sha256').update('verbatim-symlinks-v1').update(await readFile(join(root, 'package-lock.json'))).update(process.version).update(npmVersion).digest('hex');
  const cache = join(base, `deps-${key}`);
  try { await cp(join(cache, 'node_modules'), join(root, 'node_modules'), { recursive: true, verbatimSymlinks: true }); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await rm(join(root, 'node_modules'), { recursive: true, force: true });
    const code = await run('npm', ['ci', '--no-audit', '--no-fund'], root);
    if (code) throw new Error(`npm ci exited ${code}`);
    const staging = await mkdtemp(join(base, 'deps-tmp-'));
    try {
      await mkdir(join(root, 'node_modules'), { recursive: true });
      await cp(join(root, 'node_modules'), join(staging, 'node_modules'), { recursive: true, verbatimSymlinks: true });
      const { rename } = await import('node:fs/promises');
      try { await rename(staging, cache); } catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  console.log(`SORTIE_WSL_RUN ${JSON.stringify({ root, sha256: packet.sha256, node: process.version, npm: npmVersion, dependency_key: key })}`);
  process.exitCode = await run('npm', packet.mode === 'full' ? ['run', 'test:full'] : ['test'], root);
  if (cancelled) process.exitCode = 130;
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  clearInterval(watchdog);
  await stopping;
  if (root) await rm(root, { recursive: true, force: true });
  input.close(); process.stdin.destroy();
}
