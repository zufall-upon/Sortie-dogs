import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

// One owned process group; no native service, session or model request.
const [directory, phase = 'closed', supervisor] = process.argv.slice(2);
const file = join(directory, 'owned-writer.log');
if (phase === 'writer' || phase === 'stubborn-writer') {
  if (phase === 'stubborn-writer') process.on('SIGTERM', () => {});
  appendFileSync(file, 'owned\n');
  if (supervisor) {
    const owner = Number(supervisor);
    if (!Number.isSafeInteger(owner) || owner <= 0) throw Error('invalid fixture supervisor');
    setInterval(() => {
      try { process.kill(owner, 0); }
      catch (error) { if (error.code === 'ESRCH') process.exit(0); else throw error; }
    }, 50);
  }
  setInterval(() => appendFileSync(file, 'owned\n'), 20);
  process.send({ ready: true });
} else {
  const writer = spawn(process.execPath, [import.meta.filename, directory,
    phase.endsWith('stubborn') ? 'stubborn-writer' : 'writer', ...(supervisor ? [supervisor] : [])], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  writer.once('error', error => { throw error; });
  writer.once('message', () => {
    console.log(JSON.stringify({ writerPID: writer.pid, file }));
    if (phase.startsWith('closed')) process.exit(0);
    else if (phase === 'signalled') process.kill(process.pid, 'SIGTERM');
  });
}
