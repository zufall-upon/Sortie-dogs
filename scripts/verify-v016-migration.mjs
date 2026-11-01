import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { command } from './release-cli.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function snapshot(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return Object.fromEntries(await Promise.all(entries.filter(entry => entry.isFile()).map(async entry => {
    const path = join(entry.parentPath, entry.name);
    return [path.slice(root.length + 1), sha(await readFile(path))];
  })));
}

/** CLI-only migration proof. Copy real retained Mission bytes; never run a model
 * or rewrite its original DB, ledger, claims or candidate. */
export async function verifyMigration(tgz, legacyCLI, retainedProject, output) {
  const started = Date.now();
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'started.json'), JSON.stringify({ tgz, legacyCLI, retainedProject }) + '\n', { flag: 'wx' });
  const project = join(output, 'project'), expanded = join(output, 'expanded');
  await mkdir(project); await mkdir(expanded);
  const legacyVersion = JSON.parse(await readFile(join(dirname(legacyCLI), '../../package.json'))).version;
  assert.equal(legacyVersion, '0.15.3', 'representative retained release is fixed');
  await command('node', [legacyCLI, 'init', project, '--profile', 'v010'], project, {});
  const marker = join(project, '.opencode/sortie-dogs-v010.version');
  const beforeMarker = (await readFile(marker, 'utf8')).trim();
  assert(beforeMarker.startsWith('0.15.3-'));
  const sourceState = join(retainedProject, '.sortie-dogs-v010'), copiedState = join(project, '.sortie-dogs-v010');
  const beforeState = await snapshot(sourceState);
  assert(Object.keys(beforeState).some(path => path.startsWith('missions/')));
  assert(Object.keys(beforeState).some(path => path.startsWith('operators/')));
  await cp(sourceState, copiedState, { recursive: true, preserveTimestamps: true });
  assert.deepEqual(await snapshot(copiedState), beforeState);
  await command('tar', ['-xzf', tgz, '-C', expanded], project, {});
  const installed = join(expanded, 'package'), cli = join(installed, 'dist/cli/main.js');
  const version = JSON.parse(await readFile(join(installed, 'package.json'))).version;
  assert.equal(version, '0.16.0');
  const { V010_RUNTIME_ASSET_VERSION: expected } = await import(pathToFileURL(join(installed, 'dist/asset-version.js')).href);
  const { runtimeAssets } = await import(pathToFileURL(join(installed, 'dist/runtime-assets-v010.js')).href);
  const result = await command('node', [cli, 'init', project, '--profile', 'v010'], project, {});
  assert.equal((await readFile(marker, 'utf8')).trim(), expected);
  for (const asset of runtimeAssets) assert.equal(await readFile(join(project, '.opencode', asset.installPath), 'utf8'), asset.content, asset.installPath);
  assert.deepEqual(await snapshot(copiedState), beforeState, 'requirements/history/ledger bytes survive public CLI migration');
  assert.deepEqual(await snapshot(sourceState), beforeState, 'original retained evidence is read-only');
  const repeated = await command('node', [cli, 'init', project, '--profile', 'v010'], project, {});
  assert.match(repeated, /already initialized/u);
  assert.deepEqual(await snapshot(copiedState), beforeState);
  // Exercise the changed cross-minor branch too, with the same owned assets.
  await writeFile(marker, '0.12.25-mission-continuity-v1\n');
  const retainedResult = await command('node', [cli, 'init', project, '--profile', 'v010'], project, {});
  assert.equal((await readFile(marker, 'utf8')).trim(), expected);
  assert.deepEqual(await snapshot(copiedState), beforeState);
  const receipt = { status: 'pass', candidate_sha256: sha(await readFile(tgz)), version,
    legacy_version: legacyVersion, before_marker: beforeMarker, after_marker: expected,
    assets_verified: runtimeAssets.length, retained_state_files: Object.keys(beforeState).length,
    retained_state_fingerprint: sha(JSON.stringify(beforeState)),
    commands: [[legacyCLI, 'init', project, '--profile', 'v010'], [cli, 'init', project, '--profile', 'v010']],
    stdout: result.trim(), repeated_stdout: repeated.trim(), retained_marker_stdout: retainedResult.trim(),
    elapsed_ms: Date.now() - started,
    scope: 'Actual public CLI init from legacy-generated assets and retained marker; Mission bytes preserved, not a new model continuation or acceptance.' };
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  assert.equal(process.argv.length, 6, 'Usage: verify-v016-migration.mjs <candidate.tgz> <legacy-cli> <retained-project> <output>');
  console.log(JSON.stringify(await verifyMigration(...process.argv.slice(2).map(path => resolve(path)))));
}
