import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { stopProcessGroup } from '../scripts/release-cli.mjs';

for (const phase of ['closed', 'pending', 'budget', 'signal', 'launch-error', 'observation-error',
  'cleanup-error', 'persistence-error', 'resume-error', 'later-root', 'missing-root']) {
  test(`cold-resume ${phase} uses the shared owned lifecycle without replay or startup-evidence overwrite`,
    { timeout: 20_000, skip: process.platform === 'win32' }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cold-resume-lifecycle-'));
    const child = spawn(process.execPath, ['--experimental-vm-modules', resolve('test/fixtures/cold-resume-controller.mjs'), directory, phase], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = ''; child.stdout.resume(); child.stderr.on('data', bytes => { stderr += bytes; });
    try {
      const exit = await new Promise<{ code: number | null; signal: string | null }>((done, reject) => {
        child.once('error', reject); child.once('close', (code, signal) => done({ code, signal }));
      });
      assert.equal(exit.signal, null); assert.equal(exit.code, 0, stderr);
      const receipt = JSON.parse(await readFile(join(directory, 'fixture-receipt.json'), 'utf8'));
      assert.equal(receipt.monitor_calls, 1);
      assert.equal(receipt.startup_calls, 1, 'no consumed startup/task replay');
      assert.equal(receipt.server_stop_calls, 1); assert.equal(receipt.startup_evidence_preserved, true);
      assert.equal(receipt.listeners_restored, true); assert.equal(receipt.native_model_requests, 0);
      assert.equal(receipt.monitor_options.capUSD, 2, 'retain cumulative cap, not a fresh resume allowance');
      assert.equal(receipt.monitor_options.timeoutSeconds, 600);
      assert.equal(receipt.monitor_options.mode, 'complete');
      assert.equal(receipt.result.candidate_sha256, 'fixed-package-projection');
      assert.equal(receipt.result.root, 'owned-cold-resume');
      assert(receipt.observation_arguments.every(args => args[1] === 0 && args[2] === 'dog-operator' &&
        args[4]?.root === 'owned-cold-resume'), 'every cumulative read is pinned to the same retained root');
      assert.equal(receipt.result.code === 0, !['signal', 'launch-error'].includes(phase));
      assert.equal(receipt.result.intentional_interruption_errors.length, 1);
      assert.equal(receipt.result.resume_errors.length, phase === 'resume-error' ? 1 : 0);
      const stopped = ['budget', 'later-root'].includes(phase) ? 'budget' : phase === 'signal' ? 'controller-interrupted'
        : phase === 'launch-error' ? 'cli-launch-failed' : ['observation-error', 'missing-root'].includes(phase) ? 'observation-failed'
        : phase === 'cleanup-error' ? 'cleanup-failed' : phase === 'persistence-error' ? 'persistence-failed' : false;
      assert.equal(receipt.result.stopped, stopped);
      assert.equal(receipt.result.cutoff, ['budget', 'later-root'].includes(phase) ? 'budget' : undefined);
      assert.equal(receipt.result.controller_signal, phase === 'signal' ? 'SIGTERM' : null);
      assert.equal(Boolean(receipt.rejected), !['closed', 'pending'].includes(phase), 'existing failure assertions remain failures');
      if (!['signal', 'launch-error'].includes(phase)) assert.equal(receipt.result.code, 0, 'do not relabel real normal root exit');
      if (phase !== 'launch-error') { assert.equal(receipt.writer.stopped, true); assert.equal(receipt.cli_stop_calls, 1); }
      if (['closed', 'pending', 'budget', 'resume-error'].includes(phase)) {
        assert.equal(receipt.result.priced_usd, phase === 'budget' ? 2 : 1.7674084);
        assert.equal(receipt.result.mission.phase, 'completed'); assert.equal(receipt.result.receipt.status, 'succeeded');
        assert.equal(receipt.result.requirements_replaced, true);
      }
      if (phase === 'pending') assert.equal(receipt.pending_released, true, 'include old root queued work in settlement');
      if (phase === 'persistence-error') {
        assert.equal(receipt.result.persistence_error.code, 'EACCES'); assert.equal(receipt.result.persistence_complete, false);
        assert.equal(receipt.result.failure_recorded, true); assert.equal(receipt.result.accepted, false);
        assert.equal(receipt.result.usage_complete, false); assert.equal(receipt.result.known_unpriced_requests, 0);
        assert.match(receipt.result.next_action, /Do not automatically replay/);
      }
      if (phase === 'observation-error') {
        assert.equal(receipt.result.observation_error.code, 'EACCES'); assert.equal(receipt.result.usage_complete, false);
      }
      if (['later-root', 'missing-root'].includes(phase)) {
        assert.deepEqual(receipt.result.models.map(item => item.sessionID), ['owned-cold-resume'],
          'real database observation never borrows the newer root model or usage');
        assert(Math.abs(receipt.result.priced_usd - (phase === 'later-root' ? 2.4 : 0.6)) < 1e-12);
        assert.equal(receipt.result.unpriced_requests, phase === 'later-root' ? 0 : 1);
        if (phase === 'missing-root') {
          assert.equal(receipt.result.usage_complete, false);
          assert.equal(receipt.result.known_unpriced_requests, 0);
          assert.match(receipt.result.observation_error.message, /Observation root owned-cold-resume not found/);
          assert.match(receipt.result.next_action, /Do not automatically replay/);
        }
      }
      if (phase === 'cleanup-error') {
        assert.equal(receipt.result.cleanup_errors[0].code, 'EACCES'); assert.equal(receipt.result.cleanup_complete, false);
        assert.equal(receipt.result.unpriced_requests, 1);
      }
      if (phase === 'launch-error') assert.equal(receipt.result.cli_error.code, 'ENOENT');
    } finally { await stopProcessGroup(child); await rm(directory, { recursive: true, force: true }); }
  });
}
