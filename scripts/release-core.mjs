import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, open, unlink, lstat } from 'node:fs/promises';
import { resolve, relative, join, isAbsolute } from 'node:path';
import { releaseProfile, validateReleaseProfile, compareReleaseVersions, parseReleaseVersion, githubReleaseFlags } from './release-profiles.mjs';

export const digest = (data, algorithm = 'sha256') => createHash(algorithm).update(data).digest('hex');
export const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
export async function atomicJSON(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  await rename(temporary, path);
}
const exists = async path => { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const ensure = (condition, message) => { if (!condition) throw Error(message); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function relativeFile(value) {
  ensure(typeof value === 'string' && value.length > 0 && !isAbsolute(value) &&
    !value.includes('\\') && !value.split('/').some(part => ['', '.', '..'].includes(part)) && !value.startsWith('-'), `Invalid repository path: ${value}`);
  return value;
}
export function validateManifest(value) {
  ensure(value?.schema === 1 && /^[\w.-]+\/[\w.-]+$/.test(value.repository), 'Manifest schema/repository required');
  const profile = releaseProfile(value.releaseProfile);
  ensure(value.branch === profile.branch && value.remote === 'origin', `Release target must be origin/${profile.branch}`);
  ensure(Array.isArray(value.files) && value.files.length > 0, 'Explicit intended files required');
  value.files.forEach(relativeFile);
  ensure(new Set(value.files).size === value.files.length, 'Duplicate intended files');
  ensure(Array.isArray(value.versionTextFiles) && value.versionTextFiles.length > 0, 'Version text files required');
  for (const path of ['package.json', 'package-lock.json', ...value.versionTextFiles]) {
    relativeFile(path); ensure(value.files.includes(path), `Version file missing from intended scope: ${path}`);
  }
  ensure(Array.isArray(value.targetTests) && value.targetTests.length > 0, 'Target tests required');
  value.targetTests.forEach(relativeFile);
  ensure(typeof value.globalRoot === 'string' && isAbsolute(value.globalRoot), 'Absolute globalRoot required');
  ensure(typeof value.npm === 'string' && typeof value.gh === 'string', 'npm and gh executable paths required');
  ensure(typeof value.notesFile === 'string', 'Release notes file required'); relativeFile(value.notesFile);
  if (value.recovery) {
    ensure(typeof value.recovery.driver === 'string', 'Recovery driver required'); relativeFile(value.recovery.driver);
    ensure(typeof value.recovery.baselineTgz === 'string', 'Recovery baseline tgz required'); relativeFile(value.recovery.baselineTgz);
    ensure(['succeeded', 'stopped'].includes(value.recovery.expectedTerminal ?? 'succeeded'), 'Recovery expectedTerminal invalid');
  }
  return value;
}

export class Release {
  constructor({ root, version, manifest, execute, progress = () => {} }) {
    this.root = resolve(root); this.version = version; this.m = validateManifest(manifest);
    this.profile = releaseProfile(this.m.releaseProfile);
    validateReleaseProfile(this.profile, version, this.m.branch, this.root, this.m.globalRoot);
    this.execute = execute; this.progress = progress;
    this.directory = join(this.root, '_testenv', 'releases', version);
    this.statePath = join(this.directory, 'state.json');
    this.tgz = join(this.directory, `sortie-dogs-${version}.tgz`);
  }
  async command(tool, args, { allowFailure = false, ...options } = {}) {
    const result = await this.execute(tool, args, { cwd: this.root, ...options });
    ensure(!result.timedOut && !result.overflow, `${tool}: deadline/output bound exceeded; release stopped`);
    if (!allowFailure) ensure(result.code === 0, `${tool} ${args[0]} failed (exit ${result.code}); no raw log persisted`);
    return result;
  }
  async git(...args) { return (await this.command('git', args)).stdout.trim(); }
  async npm(...args) { return (await this.command('npm', args)).stdout.trim(); }
  async api(path, { optional = false, ...options } = {}) {
    const result = await this.command('gh', ['api', path, ...(options.args ?? [])], { allowFailure: optional });
    if (result.code !== 0) {
      ensure(optional && /HTTP 404/.test(result.stderr), 'GitHub availability check failed; absence not established');
      return null;
    }
    return JSON.parse(result.stdout);
  }
  async npmVersion() {
    const result = await this.command('npm', ['view', `sortie-dogs@${this.version}`, 'version', '--json', '--registry=https://registry.npmjs.org/'], { allowFailure: true });
    if (result.code !== 0) {
      ensure(/E404/.test(result.stderr), 'npm availability check failed; absence not established');
      return null;
    }
    return JSON.parse(result.stdout);
  }
  async save() { await atomicJSON(this.statePath, this.state); }
  async artifact() {
    const bytes = await readFile(this.tgz);
    return { sha256: digest(bytes), sha1: digest(bytes, 'sha1'), bytes: bytes.length };
  }
  async fingerprint() {
    const listed = (await this.command('git', ['ls-files', '-z'])).stdout.split('\0').filter(Boolean);
    const paths = [...new Set([...listed, ...this.m.files, ...(this.m.recovery ? [this.m.recovery.driver] : [])])].sort();
    const files = [];
    for (const path of paths) {
      try { files.push([path, digest(await readFile(join(this.root, path)))]); }
      catch (e) { if (e.code !== 'ENOENT') throw e; files.push([path, null]); }
    }
    return digest(JSON.stringify(files));
  }
  async freezeCheck() {
    ensure(await this.fingerprint() === this.state.source, 'Source changed after freeze; candidate invalid, do not resume publication');
    if (this.state.artifact) ensure(same(await this.artifact(), this.state.artifact), 'Frozen tgz changed');
  }
  async initialize({ readOnly = false } = {}) {
    if (!readOnly) await mkdir(this.directory, { recursive: true });
    const hash = digest(JSON.stringify(this.m));
    if (await exists(this.statePath)) {
      this.state = await readJSON(this.statePath);
      ensure(this.state.schema === 1 && this.state.version === this.version && this.state.manifest === hash, 'Release state/manifest mismatch');
    } else {
      ensure(!readOnly, 'No prepared release receipt');
      ensure(await this.git('branch', '--show-current') === this.m.branch, 'Wrong branch');
      ensure(await this.git('diff', '--cached', '--name-only') === '', 'Index must start empty');
      const remoteBefore = (await this.git('ls-remote', this.m.remote, `refs/heads/${this.m.branch}`)).split(/\s/)[0];
      ensure(remoteBefore || this.profile.allowInitialBranch, 'Remote release branch is missing');
      if (remoteBefore) await this.git('fetch', this.m.remote, this.m.branch);
      const head = await this.git('rev-parse', 'HEAD');
      ensure(!remoteBefore || head === remoteBefore, `Local and remote ${this.m.branch} must match before prepare`);
      ensure(await this.npmVersion() === null, 'npm version already exists: choose next patch');
      ensure(await this.api(`repos/${this.m.repository}/releases/tags/v${this.version}`, { optional: true }) === null, 'Release already exists: choose next patch');
      ensure(await this.git('ls-remote', this.m.remote, `refs/tags/v${this.version}`) === '', 'Remote tag exists: choose next patch');
      const tag = await this.command('git', ['rev-parse', '--verify', `refs/tags/v${this.version}`], { allowFailure: true });
      ensure(tag.code !== 0, 'Local tag exists: choose next patch');
      // Production/package changes must be included. Unrelated test/docs work may stay unstaged.
      const dirty = await this.git('diff', '--name-only', 'HEAD');
      const untracked = await this.git('ls-files', '--others', '--exclude-standard');
      for (const path of [...dirty.split('\n'), ...untracked.split('\n')].filter(Boolean)) {
        if (/^(src\/|package(?:-lock)?\.json$|scripts\/)/.test(path)) ensure(this.m.files.includes(path), `Unlisted release input: ${path}`);
      }
      if (this.m.files.some(path => /^src\/(?:plugin\/(?:continuation|index)|core\/goal-bound)\./.test(path))) {
        ensure(this.m.recovery, 'Continuation/goal changes require a baseline recovery driver');
      }
      const pkg = await readJSON(join(this.root, 'package.json'));
      const current = parseReleaseVersion(pkg.version);
      ensure(this.profile.prerelease || current.prerelease.length === 0 || this.profile.id !== 'stable', 'Current package version must be stable semver');
      const versionOrder = compareReleaseVersions(this.version, pkg.version);
      ensure(versionOrder > 0 || (this.profile.allowInitialBranch && versionOrder === 0), 'Target version must advance the current version');
      this.state = { schema: 1, version: this.version, manifest: hash, base: head, oldVersion: pkg.version, steps: {}, pending: null };
      await this.save();
    }
    if (!readOnly) {
      ensure(await this.git('branch', '--show-current') === this.m.branch, 'Branch changed during release');
      if (this.state.source) await this.freezeCheck();
    }
  }
  async phase(name, operation, verify) {
    this.progress(name);
    if (this.state.source) await this.freezeCheck();
    if (this.state.steps[name]) { if (verify) await verify(this.state.steps[name]); return this.state.steps[name]; }
    this.state.pending = name; await this.save();
    const result = await operation();
    this.state.steps[name] = result ?? { ok: true };
    this.state.pending = null; await this.save();
    return result;
  }
  async prepare() {
    await this.initialize();
    await this.phase('version', async () => {
      for (const path of ['package.json', 'package-lock.json']) {
        const file = join(this.root, path), data = await readJSON(file);
        ensure([this.state.oldVersion, this.version].includes(data.version), `Unexpected version: ${path}`);
        data.version = this.version;
        if (path === 'package.json' && this.profile.id !== 'stable') data.publishConfig = { ...data.publishConfig, tag: this.profile.npmTag };
        if (path === 'package-lock.json') data.packages[''].version = this.version;
        await writeFile(file, JSON.stringify(data, null, 2) + '\n');
      }
      for (const path of this.m.versionTextFiles) {
        const file = join(this.root, path), text = await readFile(file, 'utf8');
        ensure(text.includes(this.state.oldVersion) || text.includes(this.version), `Version reference missing: ${path}`);
        await writeFile(file, text.replaceAll(this.state.oldVersion, this.version));
      }
      this.state.source = await this.fingerprint();
      this.state.notes = await readFile(join(this.root, this.m.notesFile), 'utf8');
    });
    await this.phase('tests', async () => {
      await this.npm('run', 'build');
      await this.command('node', ['--experimental-strip-types', '--import', './test/setup.ts', '--test', ...this.m.targetTests]);
      await this.npm('test');
      await this.npm('run', 'test:full');
      await this.git('diff', '--check');
      await this.freezeCheck();
    });
    await this.phase('pack', async () => {
      ensure(!await exists(this.tgz), 'Unreceipted tarball exists; inspect interrupted pack, never overwrite it');
      await this.npm('pack', '--pack-destination', this.directory, '--json');
      this.state.artifact = await this.artifact();
      await this.freezeCheck();
      return this.state.artifact;
    }, async () => { await this.freezeCheck(); });
    await this.phase('cli', async () => {
      const result = await this.command('cli', [this.tgz, this.directory]);
      const receipt = JSON.parse(result.stdout);
      this.checkCLI(receipt);
      return receipt;
    }, async receipt => this.checkCLI(receipt));
    if (this.m.recovery) await this.phase('recovery', async () => {
      const baseline = join(this.root, this.m.recovery.baselineTgz);
      const baselineHash = digest(await readFile(baseline));
      const result = await this.command('recovery', [this.tgz, baseline, this.directory]);
      const receipt = JSON.parse(result.stdout);
      ensure(receipt?.schema === 1 && receipt.version === this.version && receipt.sha256 === this.state.artifact.sha256 &&
        typeof receipt.runtimeMarker === 'string' && receipt.artifactMatch === true && receipt.canonicalExit === 0 &&
        receipt.terminal === (this.m.recovery.expectedTerminal ?? 'succeeded'), 'Recovery candidate receipt invalid');
      ensure(receipt.baselineSha256 === baselineHash && receipt.beforeStopped === true &&
        receipt.beforeSession === receipt.sessionID && receipt.sameGoal === true &&
        ['synthetic-turn', 'compaction-summary'].includes(receipt.continuationEvidence), 'Incomplete recovery receipt');
      return receipt;
    }, async receipt => {
      ensure(receipt.terminal === (this.m.recovery.expectedTerminal ?? 'succeeded') && receipt.sha256 === this.state.artifact.sha256,
        'Recovery receipt mismatch');
      ensure(receipt.baselineSha256 === digest(await readFile(join(this.root, this.m.recovery.baselineTgz))), 'Recovery baseline changed');
    });
    await this.phase('global', async () => {
      await this.command('global', [this.tgz, this.m.globalRoot]);
      return { ok: true };
    }, async () => { await this.command('global-verify', [this.tgz, this.m.globalRoot]); });
    await this.phase('commit', async () => {
      await this.freezeCheck();
      const head = await this.git('rev-parse', 'HEAD');
      if (head !== this.state.base) { await this.checkCommit(head); return { head }; }
      const staged = (await this.git('diff', '--cached', '--name-only')).split('\n').filter(Boolean);
      ensure(staged.every(path => this.m.files.includes(path)), 'Index contains unrelated changes');
      await this.git('add', '--', ...this.m.files);
      ensure((await this.git('diff', '--cached', '--name-only')).split('\n').every(path => this.m.files.includes(path)), 'Staged scope mismatch');
      await this.git('diff', '--cached', '--check');
      await this.git('commit', '--author=zufall-upon <zufall@s151.xrea.com>', '-m', `Release v${this.version}`);
      const committed = await this.git('rev-parse', 'HEAD');
      await this.checkCommit(committed);
      return { head: committed };
    }, async receipt => { ensure(await this.git('rev-parse', 'HEAD') === receipt.head, 'HEAD changed after release commit'); await this.checkCommit(receipt.head); });
    const head = this.state.steps.commit.head;
    await this.phase('push', async () => {
      const remote = await this.git('ls-remote', this.m.remote, `refs/heads/${this.m.branch}`);
      const remoteHead = remote.split(/\s/)[0];
      ensure([this.state.base, head].includes(remoteHead) || (!remoteHead && this.profile.allowInitialBranch), 'Remote release branch advanced; do not overwrite');
      if (remoteHead !== head) await this.git('push', this.m.remote, this.m.branch);
      await this.checkRemote(head); return { head };
    }, async () => this.checkRemote(head));
    await this.phase('tag', async () => {
      const found = await this.command('git', ['rev-parse', '--verify', `refs/tags/v${this.version}`], { allowFailure: true });
      if (found.code !== 0) await this.git('tag', '-a', `v${this.version}`, '-m', `Sortie-dogs v${this.version}`, head);
      ensure(await this.git('cat-file', '-t', `refs/tags/v${this.version}`) === 'tag', 'Release tag must be annotated');
      ensure(await this.git('rev-parse', `v${this.version}^{}`) === head, 'Tag target mismatch');
      const remote = await this.git('ls-remote', this.m.remote, `refs/tags/v${this.version}`, `refs/tags/v${this.version}^{}`);
      if (!remote) await this.git('push', this.m.remote, `v${this.version}`);
      await this.checkTag(head); return { head };
    }, async () => this.checkTag(head));
    await this.phase('release', async () => {
      const notes = join(this.directory, 'release-notes.md');
      await writeFile(notes, `${this.state.notes}\n\nSHA-256 (${this.tgz.split(/[\\/]/).at(-1)}): \`${this.state.artifact.sha256}\`\n`);
      const existing = await this.api(`repos/${this.m.repository}/releases/tags/v${this.version}`, { optional: true });
      if (!existing) await this.command('gh', ['release', 'create', `v${this.version}`, this.tgz, '--verify-tag',
        '--repo', this.m.repository, '--title', `v${this.version}`, '--notes-file', notes, ...githubReleaseFlags(this.profile)]);
      return await this.checkRelease();
    }, async () => this.checkRelease());
    return { version: this.version, profile: this.profile.id, npmTag: this.profile.npmTag, tgz: this.tgz,
      ...this.state.artifact, url: this.state.steps.release.url, npmPublish: 'manual' };
  }
  checkCLI(receipt) {
    ensure(receipt?.schema === 1 && receipt.version === this.version && receipt.sha256 === this.state.artifact.sha256 &&
      typeof receipt.runtimeMarker === 'string' && receipt.runtimeMarker.length > 0 &&
      typeof receipt.sessionID === 'string' && receipt.sessionID.startsWith('ses_') &&
      receipt.workerStarted === true && receipt.canonicalExit === 0 && receipt.terminal === 'succeeded' &&
      receipt.artifactMatch === true, 'CLI receipt does not prove the frozen candidate completed');
    if (this.profile.runtimeProfile !== 'stable') ensure(receipt.profile === this.profile.runtimeProfile, 'CLI receipt runtime profile mismatch');
  }
  async checkCommit(head) {
    ensure(await this.git('rev-parse', `${head}^`) === this.state.base, 'Unexpected release commit ancestry');
    ensure(await this.git('show', '-s', '--format=%s', head) === `Release v${this.version}`, 'Unexpected release commit subject');
    ensure(await this.git('show', '-s', '--format=%an <%ae>', head) === 'zufall-upon <zufall@s151.xrea.com>', 'Unexpected release author');
    const changed = (await this.git('diff-tree', '--no-commit-id', '--name-only', '-r', head)).split('\n').filter(Boolean);
    ensure(changed.length > 0 && changed.every(path => this.m.files.includes(path)), 'Release commit includes unrelated changes');
    ensure(await this.git('diff', 'HEAD', '--', ...this.m.files) === '', 'Release files differ from committed candidate');
  }
  async checkRemote(head) {
    ensure((await this.git('ls-remote', this.m.remote, `refs/heads/${this.m.branch}`)).split(/\s/)[0] === head, 'Remote main mismatch');
  }
  async checkTag(head) {
    ensure((await this.git('ls-remote', this.m.remote, `refs/tags/v${this.version}^{}`)).split(/\s/)[0] === head, 'Remote annotated tag mismatch');
  }
  async checkRelease() {
    const release = await this.api(`repos/${this.m.repository}/releases/tags/v${this.version}`);
    const assets = release.assets?.filter(asset => asset.name === `sortie-dogs-${this.version}.tgz`);
    ensure(release.draft === false && assets?.length === 1 && assets[0].digest === `sha256:${this.state.artifact.sha256}`,
      'Published Release artifact differs; do not recreate or replace it');
    ensure((release.prerelease ?? false) === this.profile.prerelease, 'Release prerelease channel mismatch');
    if (!this.profile.latest) {
      const latest = await this.api(`repos/${this.m.repository}/releases/latest`, { optional: true });
      ensure(latest?.tag_name !== `v${this.version}`, 'Independent/preview release must not replace Latest');
    }
    return { url: release.html_url, digest: assets[0].digest };
  }
  async verifyPublish() {
    await this.initialize({ readOnly: true });
    ensure(this.state.steps.release && this.state.steps.commit, 'Prepare has not completed');
    ensure(same(await this.artifact(), this.state.artifact), 'Local tgz differs');
    ensure(await this.npmVersion() === this.version, 'Requested npm version unavailable');
    const shasum = JSON.parse(await this.npm('view', `sortie-dogs@${this.version}`, 'dist.shasum', '--json', '--registry=https://registry.npmjs.org/'));
    ensure(shasum === this.state.artifact.sha1, 'Registry/local SHA-1 mismatch');
    await this.checkTag(this.state.steps.commit.head);
    const release = await this.checkRelease();
    const latest = JSON.parse(await this.npm('view', 'sortie-dogs', 'version', '--json', '--registry=https://registry.npmjs.org/'));
    const channelVersion = this.profile.npmTag === 'latest' ? latest
      : JSON.parse(await this.npm('view', `sortie-dogs@${this.profile.npmTag}`, 'version', '--json', '--registry=https://registry.npmjs.org/'));
    ensure(channelVersion === this.version, 'npm dist-tag does not point to the released version');
    const main = await this.git('ls-remote', this.m.remote, `refs/heads/${this.m.branch}`);
    return { version: this.version, profile: this.profile.id, npmTag: this.profile.npmTag, channelVersion,
      registrySHA1: shasum, latest, remoteMain: main.split(/\s/)[0], ...release, verified: true };
  }
}

export async function withReleaseLock(directory, operation) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'release.lock');
  let handle;
  try { handle = await open(path, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw Error('Release lock exists. Confirm its owning process has stopped before removing this lock.');
  }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid })); return await operation(); }
  finally { await handle.close(); await unlink(path); }
}
