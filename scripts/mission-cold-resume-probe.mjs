import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { probe, observeMissionCLI } from './mission-cli-probe.mjs';
import { startV2ReleaseServer } from './release-cli.mjs';

// A real native Worker is interrupted with its server. The next user turn uses a new
// plugin instance and the same root; fixture state is never manually repaired.
const tgz = resolve(process.argv[2]), output = resolve(process.argv[3]);
const started = await probe(tgz, output, { mode: 'start', timeoutSeconds: 240, capUSD: 1,
  model: 'openai/gpt-6-luna-fast#max',
  prompt: '2段階の作業です。Coordinatorへ委譲して進めてください。第1段階: result.txtをrecoveredと末尾改行へ変更、node check.mjsで確認。第2段階: result.txtを読んでreceipt.txtにconfirmedと末尾改行を保存、node check-receipt.mjsで確認。check*.mjsと設定は変更しない。',
  setupFixture: async ({ project }) => writeFile(join(project, 'check-receipt.mjs'),
    'import{readFileSync}from"node:fs";import assert from"node:assert/strict";assert.equal(readFileSync("receipt.txt","utf8"),"confirmed\\n");\n'),
});
assert.equal(started.stopped, 'worker-started', JSON.stringify(started));
assert.ok(started.models.some(item => item.agent === 'dogs-coordinator'), 'Exercise nested native dispatch');
const run = dirname(started.project), xdg = join(run, 'xdg');
const env = { XDG_CONFIG_HOME: xdg, OPENCODE_CONFIG_DIR: join(xdg, 'opencode'), OPENCODE_CONFIG: join(xdg, 'opencode/opencode.json') };
const baseline = observeMissionCLI(started.project);
const previousErrors = new Set(baseline.errors.map(error => JSON.stringify(error)));
const server = await startV2ReleaseServer(started.project, env);
let stdout = '', stderr = '', cutoff, code;
const since = Date.now();
const request = '前回の作業を置き換えます。旧runは中断済みです。start_missionのintent=replaceで現在の要件を保存し、古いreceipt.txt作成要件は取り消してください。現在の要件はresult.txtをrecoveredと末尾改行にしてnode check.mjsを通すことだけです。check*.mjs・設定は変更しない。単一unitのFast-laneで、既存の費用を継承して実行し、低リスクreview skipとcomplete_missionまで完了してください。';
const child = spawn('opencode', ['run', '--server', server.url, '--session', started.root, '--format', 'json',
  '--agent', 'dog-operator', '--model', 'openai/gpt-6-luna-fast#max', request], {
  cwd: started.project, env: { ...process.env, ...server.env, PWD: started.project }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', bytes => { stdout += bytes; });
child.stderr.on('data', bytes => { stderr += bytes; });
const timer = setInterval(() => {
  const observed = observeMissionCLI(started.project);
  if (observed.priced_usd >= 2 || Date.now() - since > 600_000) {
    cutoff = observed.priced_usd >= 2 ? 'budget' : 'timeout';
    void server.stop();
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  }
}, 1000);
try { code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); }); }
finally { clearInterval(timer); await server.stop(); }
const observed = observeMissionCLI(started.project);
const key = createHash('sha256').update(started.root).digest('hex');
const mission = JSON.parse(await readFile(join(started.project, '.sortie-dogs-v010/missions', key + '.json')));
const operator = JSON.parse(await readFile(join(started.project, '.sortie-dogs-v010/operators', key + '.json')));
const result = { ...observed, candidate_sha256: started.candidate_sha256, root: started.root, code, cutoff,
  initial_worker: started.models.find(item => item.agent === 'dog-worker-v010'),
  intentional_interruption_errors: baseline.errors, resume_errors: observed.errors.filter(error => !previousErrors.has(JSON.stringify(error))),
  elapsed_ms: Date.now() - since, mission: { id: mission.id, phase: mission.phase, requirements: mission.requirements },
  receipt: operator.receipt, requirements_replaced: mission.requirementsReplaced };
await writeFile(join(run, 'resume.stdout.jsonl'), stdout);
await writeFile(join(run, 'resume.stderr.log'), stderr);
await writeFile(join(run, 'cold-resume-observation.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
assert.equal(code, 0);
assert.equal(cutoff, undefined);
assert.equal(result.resume_errors.length, 0);
assert.equal(mission.requirementsReplaced, true);
assert.equal(mission.phase, 'completed');
assert.equal(operator.receipt?.status, 'succeeded');
assert.equal(await readFile(join(started.project, 'result.txt'), 'utf8'), 'recovered\n');
