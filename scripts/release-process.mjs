import { spawn } from 'node:child_process';

// Capture only in memory. Callers persist typed evidence, never raw CLI/authentication logs.
export async function runProcess(executable, args, { cwd, env = process.env, timeoutMs = 1_800_000 } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', overflow = false, timedOut = false;
    const limit = 32 * 1024 * 1024;
    const capture = (name, data) => {
      if (stdout.length + stderr.length + data.length > limit) { overflow = true; terminate(); return; }
      if (name === 'stdout') stdout += data; else stderr += data;
    };
    let terminating = false;
    function terminate() {
      if (terminating || !child.pid) return;
      terminating = true;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ } }
    }
    child.stdout.on('data', data => capture('stdout', data));
    child.stderr.on('data', data => capture('stderr', data));
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    const abort = () => { timedOut = true; terminate(); };
    process.once('SIGINT', abort);
    process.once('SIGTERM', abort);
    const cleanup = () => { clearTimeout(timer); process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); };
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', code => { cleanup(); resolve({ code: code ?? -1, stdout, stderr, timedOut, overflow }); });
  });
}

export const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;

export function commandFor(executable, args) {
  // PowerShell scripts (notably the approved Windows npm) are not native executables.
  return /\.ps1$/i.test(executable)
    ? { executable: 'pwsh', args: ['-NoProfile', '-File', executable, ...args] }
    : { executable, args };
}
