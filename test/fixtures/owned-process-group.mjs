import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

// One owned process group; no native service, session or model request.
const [directory, phase = 'closed'] = process.argv.slice(2);
const file = join(directory, 'owned-writer.log');
if (phase === 'writer' || phase === 'stubborn-writer') {
  if (phase === 'stubborn-writer') process.on('SIGTERM', () => {});
  appendFileSync(file, 'owned\n');
  setInterval(() => appendFileSync(file, 'owned\n'), 20);
  process.send({ ready: true });
} else {
  const writer = spawn(process.execPath, [import.meta.filename, directory,
    phase.endsWith('stubborn') ? 'stubborn-writer' : 'writer'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  writer.once('error', error => { throw error; });
  writer.once('message', () => {
    console.log(JSON.stringify({ writerPID: writer.pid, file }));
    if (phase.startsWith('closed')) process.exit(0);
    else if (phase === 'signalled') process.kill(process.pid, 'SIGTERM');
  });
}
