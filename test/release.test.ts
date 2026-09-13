import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Release, digest, readJSON, withReleaseLock } from '../scripts/release-core.mjs';
import { runProcess, shellQuote, commandFor } from '../scripts/release-process.mjs';

const version = '1.0.1';
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
async function fixture(action: (ctx: any) => Promise<void>) {
  const area = resolve('_testenv');
  await mkdir(area, { recursive: true });
  const home = await mkdtemp(join(area, 'release-batch-'));
  const root = join(home, 'project'), remote = join(home, 'remote.git');
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'test')); await mkdir(join(root, 'temp'));
  const git = async (...args: string[]) => {
    const result = await runProcess('git', args, { cwd: root, env: { ...process.env,
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } });
    assert.equal(result.code, 0, result.stderr); return result.stdout.trim();
  };
  try {
    await writeFile(join(root, '.gitignore'), '_testenv/\ntemp/\n');
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'sortie-dogs', version: '1.0.0' }));
    await writeFile(join(root, 'package-lock.json'), JSON.stringify({ version: '1.0.0', packages: { '': { version: '1.0.0' } } }));
    await writeFile(join(root, 'README.md'), 'Release 1.0.0\n');
    await writeFile(join(root, 'src/widget.js'), 'before\n');
    await writeFile(join(root, 'test/widget.test.ts'), 'fixture\n');
    await writeFile(join(root, 'unrelated.md'), 'user original\n');
    await writeFile(join(root, 'temp/notes.md'), 'Recovery fixes\n');
    await git('init', '-q', '-b', 'main');
    await git('init', '-q', '--bare', remote);
    await git('add', '--', '.gitignore', 'package.json', 'package-lock.json', 'README.md', 'src/widget.js', 'test/widget.test.ts', 'unrelated.md');
    await git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Seed');
    await git('remote', 'add', 'origin', remote); await git('push', '-qu', 'origin', 'main');
    await writeFile(join(root, 'src/widget.js'), 'after\n');
    await writeFile(join(root, 'unrelated.md'), 'user work retained\n');
    const manifest = { schema: 1, repository: 'fixture/repo', remote: 'origin', branch: 'main', npm: 'npm', gh: 'gh',
      globalRoot: join(home, 'global'), files: ['package.json', 'package-lock.json', 'README.md', 'src/widget.js'],
      versionTextFiles: ['README.md'], targetTests: ['test/widget.test.ts'], notesFile: 'temp/notes.md' };
    const calls: string[] = [];
    const service: any = { release: null, published: null, fail: null, failOnce: true, corruptCLI: false };
    const execute = async (tool: string, args: string[], options: any) => {
      const key = `${tool} ${args[0]}`; calls.push(key);
      if (service.fail === key && service.failOnce) { service.failOnce = false; return { code: 1, stdout: '', stderr: 'simulated external failure' }; }
      if (tool === 'git') return runProcess('git', args, { ...options, env: { ...process.env,
        GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } });
      if (tool === 'node') return ok();
      if (tool === 'npm') {
        if (args[0] === 'view') {
          if (!service.published) return { code: 1, stdout: '', stderr: 'npm error E404' };
          return ok(JSON.stringify(args[2] === 'dist.shasum' ? service.published : version));
        }
        if (args[0] === 'pack') await writeFile(join(args[2], `sortie-dogs-${version}.tgz`), 'frozen tarball fixture');
        return ok();
      }
      if (tool === 'cli') return ok(JSON.stringify({ schema: 1, version, sha256: digest(await readFile(args[0])),
        runtimeMarker: 'fixture-marker', sessionID: 'ses_fixture', workerStarted: true, canonicalExit: service.corruptCLI ? 1 : 0,
        terminal: 'succeeded', artifactMatch: true }));
      if (tool === 'global' || tool === 'global-verify') return ok();
      if (tool === 'gh') {
        if (args[0] === 'api') return service.release ? ok(JSON.stringify(service.release)) : { code: 1, stdout: '', stderr: 'HTTP 404' };
        if (args[0] === 'release' && args[1] === 'create') {
          service.release = { draft: false, html_url: 'https://example.invalid/release', assets: [{ name: `sortie-dogs-${version}.tgz`, digest: `sha256:${digest(await readFile(args[3]))}` }] };
          if (service.afterReleaseFailure) { service.afterReleaseFailure = false; return { code: 1, stdout: '', stderr: 'connection interrupted after creation' }; }
          return ok();
        }
      }
      throw Error(`Unexpected command ${key}`);
    };
    const batch = () => new Release({ root, version, manifest, execute });
    await action({ root, git, manifest, batch, calls, service });
  } finally { await rm(home, { recursive: true, force: true }); }
}

test('release batch freezes one tarball, preserves user work, publishes once and verifies read-only', async () => {
  await fixture(async ({ root, git, batch, calls, service }) => {
    const result = await batch().prepare();
    assert.equal(result.npmPublish, 'manual');
    assert.equal(calls.filter((call: string) => call === 'npm pack').length, 1);
    assert.equal(await git('diff', '--name-only'), 'unrelated.md');
    assert.equal(await readFile(join(root, 'unrelated.md'), 'utf8'), 'user work retained\n');
    assert.equal(await git('cat-file', '-t', `v${version}`), 'tag');
    const again = await batch().prepare();
    assert.equal(again.sha256, result.sha256);
    assert.equal(calls.filter((call: string) => call === 'npm pack').length, 1);
    assert.equal(calls.filter((call: string) => call === 'gh release').length, 1);
    assert.ok(calls.includes('global-verify ' + result.tgz));
    service.published = result.sha1;
    const before = await readFile(join(root, '_testenv/releases', version, 'state.json'), 'utf8');
    assert.equal((await batch().verifyPublish()).verified, true);
    assert.equal(await readFile(join(root, '_testenv/releases', version, 'state.json'), 'utf8'), before);
  });
});

test('preflight runs the target release test without release side effects', async () => {
  await fixture(async ({ root, batch, calls, git }) => {
    const before = await git('diff'), head = await git('rev-parse', 'HEAD');
    const result = await batch().preflight();
    assert.deepEqual(result.tests, ['test/widget.test.ts']);
    assert.equal(result.sideEffects, 'none');
    assert.equal(await git('diff'), before);
    assert.equal(await git('rev-parse', 'HEAD'), head);
    assert.equal(calls.some((call: string) => /^(global|cli|gh release|git (commit|push|tag))/.test(call)), false);
    await assert.rejects(readFile(join(root, '_testenv/releases', version, 'state.json')), /ENOENT/);
  });
});

test('failed phase writes a typed receipt with the exact command and success clears it', async () => {
  await fixture(async ({ root, batch, service }) => {
    service.fail = 'npm test';
    await assert.rejects(batch().prepare(), /npm test failed/);
    const receipt = JSON.parse(await readFile(join(root, '_testenv/releases', version, 'failure.json'), 'utf8'));
    assert.deepEqual({ phase: receipt.phase, command: receipt.command, toolCategory: receipt.toolCategory,
      exitCode: receipt.exitCode, timedOut: receipt.timedOut, overflow: receipt.overflow },
      { phase: 'npm-test', command: 'npm test', toolCategory: 'npm', exitCode: 1, timedOut: false, overflow: false });
    assert.equal(typeof receipt.timestamp, 'string');
    await batch().prepare();
    await assert.rejects(readFile(join(root, '_testenv/releases', version, 'failure.json')), /ENOENT/);
  });
});

test('resume after full test failure skips completed test phases', async () => {
  await fixture(async ({ root, batch, calls }) => {
    const release = batch(), execute = release.execute;
    let failed = false;
    release.execute = async (tool: string, args: string[], options: any) => {
      if (!failed && tool === 'npm' && args[0] === 'run' && args[1] === 'test:full') {
        failed = true; return { code: 1, stdout: '', stderr: 'full test failure' };
      }
      return execute(tool, args, options);
    };
    await assert.rejects(release.prepare(), /npm run test:full failed/);
    const targetBefore = calls.filter((call: string) => call === 'node --experimental-strip-types').length;
    const npmBefore = calls.filter((call: string) => call === 'npm test').length;
    await batch().prepare();
    assert.equal(calls.filter((call: string) => call === 'node --experimental-strip-types').length, targetBefore);
    assert.equal(calls.filter((call: string) => call === 'npm test').length, npmBefore);
  });
});

for (const failure of ['npm test', 'cli', 'global', 'git push', 'git tag', 'gh release']) {
  test(`release resumes safely after ${failure} failure`, async () => {
    await fixture(async ({ batch, service, calls }) => {
      const original = batch();
      const exec = original.execute;
      let injected = false;
      original.execute = async (tool: string, args: string[], options: any) => {
        if (!injected && (failure === tool || failure === `${tool} ${args[0]}`)) {
          injected = true; return { code: 1, stdout: '', stderr: 'fixture failure' };
        }
        return exec(tool, args, options);
      };
      await assert.rejects(original.prepare(), /failed/);
      assert.equal(injected, true);
      assert.equal(service.published, null);
      const result = await batch().prepare();
      assert.equal(result.version, version);
      assert.equal(calls.filter((call: string) => call === 'npm pack').length, 1);
      assert.equal(calls.includes('npm publish'), false);
    });
  });
}

test('lost response after Release creation is reconciled without recreating the Release', async () => {
  await fixture(async ({ batch, service, calls }) => {
    service.afterReleaseFailure = true;
    await assert.rejects(batch().prepare(), /failed/);
    await batch().prepare();
    assert.equal(calls.filter((call: string) => call === 'gh release').length, 1);
  });
});

for (const effect of ['commit', 'push', 'tag']) test(`lost Git ${effect} response is reconciled from actual refs`, async () => {
  await fixture(async ({ batch, calls }) => {
    const release = batch(), execute = release.execute;
    let lost = false;
    release.execute = async (tool: string, args: string[], options: any) => {
      const result = await execute(tool, args, options);
      if (!lost && tool === 'git' && args[0] === effect && result.code === 0) {
        lost = true; return { code: 1, stdout: '', stderr: 'lost response after effect' };
      }
      return result;
    };
    await assert.rejects(release.prepare(), /failed/);
    await batch().prepare();
    assert.equal(calls.filter((call: string) => call === 'npm pack').length, 1);
    assert.equal(calls.filter((call: string) => call === `git ${effect}`).length, effect === 'push' ? 2 : 1);
  });
});

test('an unreceipted pack is never overwritten on restart', async () => {
  await fixture(async ({ batch, calls }) => {
    const release = batch(), execute = release.execute;
    release.execute = async (tool: string, args: string[], options: any) => {
      const result = await execute(tool, args, options);
      return tool === 'npm' && args[0] === 'pack' ? { code: 1, stdout: '', stderr: 'pack interrupted after output' } : result;
    };
    await assert.rejects(release.prepare(), /failed/);
    await assert.rejects(batch().prepare(), /Unreceipted tarball/);
    assert.equal(calls.filter((call: string) => call === 'npm pack').length, 1);
  });
});

for (const matchingSession of [false, true]) test(`recovery gate requires bound evidence (same session=${matchingSession})`, async () => {
  await fixture(async ({ root, batch, manifest, service }) => {
    await mkdir(join(root, 'src/plugin'));
    await writeFile(join(root, 'src/plugin/continuation.ts'), '// fixture\n');
    await writeFile(join(root, 'test/recovery-driver.mjs'), '// trusted fixture driver\n');
    await writeFile(join(root, 'temp/baseline.tgz'), 'baseline');
    manifest.files.push('src/plugin/continuation.ts', 'test/recovery-driver.mjs');
    manifest.recovery = { driver: 'test/recovery-driver.mjs', baselineTgz: 'temp/baseline.tgz' };
    const release = batch(), execute = release.execute;
    release.execute = async (tool: string, args: string[], options: any) => {
      if (tool !== 'recovery') return execute(tool, args, options);
      return ok(JSON.stringify({ schema: 1, version, sha256: digest(await readFile(args[0])), runtimeMarker: 'marker',
        sessionID: 'ses_one', workerStarted: true, canonicalExit: 0, terminal: 'succeeded', artifactMatch: true,
        baselineSha256: digest(await readFile(args[1])), beforeStopped: true, beforeSession: matchingSession ? 'ses_one' : 'ses_different',
        sameGoal: true, continuationEvidence: 'synthetic-turn' }));
    };
    if (matchingSession) {
      assert.equal((await release.prepare()).version, version);
      await writeFile(join(root, 'temp/baseline.tgz'), 'different baseline');
      await assert.rejects(batch().prepare(), /Recovery baseline changed/);
    } else {
      await assert.rejects(release.prepare(), /Incomplete recovery receipt/);
      assert.equal(service.release, null);
    }
  });
});

test('CLI proof failure prevents global install, commit and publication', async () => {
  await fixture(async ({ batch, service, calls, git }) => {
    const head = await git('rev-parse', 'HEAD'); service.corruptCLI = true;
    await assert.rejects(batch().prepare(), /CLI receipt/);
    assert.equal(await git('rev-parse', 'HEAD'), head);
    assert.equal(calls.some((call: string) => call.startsWith('global ')), false);
    assert.equal(service.release, null);
  });
});

test('source or frozen tarball mutation refuses resume before further effects', async () => {
  for (const mutation of ['source', 'tarball']) await fixture(async ({ root, batch, service, calls }) => {
    service.fail = 'gh release';
    await assert.rejects(batch().prepare(), /failed/);
    const count = calls.length;
    if (mutation === 'source') await writeFile(join(root, 'src/widget.js'), 'changed after testing');
    else await writeFile(join(root, '_testenv/releases', version, `sortie-dogs-${version}.tgz`), 'changed after testing');
    await assert.rejects(batch().prepare(), /Source changed|Frozen tgz changed/);
    assert.equal(calls.slice(count).some((call: string) => /^(npm |global |gh release|git push)/.test(call)), false);
  });
});

test('unknown external errors are not treated as available versions', async () => {
  await fixture(async ({ batch, service, git }) => {
    service.fail = 'npm view';
    const before = await git('diff');
    await assert.rejects(batch().prepare(), /absence not established/);
    assert.equal(await git('diff'), before);
  });
});

test('published version collision stops before modifying source', async () => {
  await fixture(async ({ batch, service, git }) => {
    service.published = 'existing'; const before = await git('diff');
    await assert.rejects(batch().prepare(), /already exists/);
    assert.equal(await git('diff'), before);
  });
});

test('registry or Release digest mismatch never replaces an asset', async () => {
  await fixture(async ({ batch, service, calls }) => {
    const result = await batch().prepare(); service.published = 'wrong';
    await assert.rejects(batch().verifyPublish(), /SHA-1 mismatch/);
    service.published = result.sha1; service.release.assets[0].digest = 'sha256:wrong';
    await assert.rejects(batch().verifyPublish(), /artifact differs/);
    assert.equal(calls.filter((call: string) => call === 'gh release').length, 1);
  });
});

test('continuation changes require a dedicated baseline recovery fixture', async () => {
  await fixture(async ({ batch, manifest }) => {
    manifest.files.push('src/plugin/continuation.ts');
    await assert.rejects(batch().prepare(), /require a baseline recovery driver/);
  });
});

test('release lock serializes publication and always releases on errors', async () => {
  const root = await mkdtemp(resolve('_testenv/release-lock-'));
  try {
    await assert.rejects(withReleaseLock(root, async () => {
      await assert.rejects(withReleaseLock(root, async () => {}), /lock exists/);
      throw Error('fixture interruption');
    }), /fixture interruption/);
    await withReleaseLock(root, async () => {});
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('subprocess deadline closes owned process tree and script arguments stay literal', async () => {
  const result = await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  assert.deepEqual(commandFor('path with spaces/npm.ps1', ['view', 'sortie-dogs@1.0.1']), {
    executable: 'pwsh', args: ['-NoProfile', '-File', 'path with spaces/npm.ps1', 'view', 'sortie-dogs@1.0.1'] });
});
