import { isAbsolute, relative, resolve } from 'node:path';

export const RELEASE_PROFILES = Object.freeze({
  'v012': Object.freeze({ id: 'v012', branch: 'main', prerelease: false, npmTag: 'latest', latest: true,
    runtimeProfile: 'v010', assetsModule: 'runtime-assets-v010.js', markerExport: 'V010_RUNTIME_ASSET_VERSION', markerFile: 'sortie-dogs-v010.version',
    allowInitialBranch: false, isolatedInstall: false, line: [0, 12] }),
  stable: Object.freeze({ id: 'stable', branch: 'main', prerelease: false, npmTag: 'latest', latest: true,
    runtimeProfile: 'stable', assetsModule: 'runtime-assets.js', markerExport: 'RUNTIME_ASSET_VERSION', markerFile: 'sortie-dogs.version',
    allowInitialBranch: false, isolatedInstall: false, line: null }),
  'beta-v010': Object.freeze({ id: 'beta-v010', branch: 'beta/v0.10', prerelease: true, prereleaseLabel: 'beta', npmTag: 'beta', latest: false,
    runtimeProfile: 'v010', assetsModule: 'runtime-assets-v010.js', markerExport: 'V010_RUNTIME_ASSET_VERSION', markerFile: 'sortie-dogs-v010.version',
    allowInitialBranch: true, isolatedInstall: true, line: [0, 10] }),
  'independent-v010': Object.freeze({ id: 'independent-v010', branch: 'release/v0.10', prerelease: false, npmTag: 'next', latest: false,
    runtimeProfile: 'v010', assetsModule: 'runtime-assets-v010.js', markerExport: 'V010_RUNTIME_ASSET_VERSION', markerFile: 'sortie-dogs-v010.version',
    allowInitialBranch: true, isolatedInstall: true, line: [0, 10] }),
});

export function releaseProfile(id = 'stable') {
  if (!Object.hasOwn(RELEASE_PROFILES, id)) throw Error('Unknown release profile');
  const profile = RELEASE_PROFILES[id];
  if (!profile) throw Error('Unknown release profile');
  return profile;
}

export function parseReleaseVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  if (!match) throw Error('Valid semver required');
  const pre = match[4]?.split('.') ?? [];
  if (pre.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) throw Error('Invalid numeric prerelease identifier');
  return { numbers: match.slice(1, 4).map(Number), prerelease: pre };
}

export function compareReleaseVersions(left, right) {
  const a = parseReleaseVersion(left), b = parseReleaseVersion(right);
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] < b.numbers[i] ? -1 : 1;
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i], y = b.prerelease[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function validateReleaseProfile(profile, version, branch, root, installRoot) {
  const parsed = parseReleaseVersion(version);
  if (branch !== profile.branch) throw Error(`Release target must be origin/${profile.branch}`);
  if (profile.prerelease !== (parsed.prerelease.length > 0)) throw Error(profile.prerelease ? 'Prerelease semver required' : 'Stable semver required');
  if (profile.line && profile.line.some((part, index) => part !== parsed.numbers[index])) throw Error('Version does not match release profile');
  if (profile.prereleaseLabel && parsed.prerelease[0] !== profile.prereleaseLabel) throw Error('Prerelease label does not match channel');
  if (profile.isolatedInstall) {
    const within = relative(resolve(root, '_testenv'), resolve(installRoot));
    if (!within || within === '..' || within.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(within)) {
      throw Error('Preview/independent install target must be inside this worktree _testenv');
    }
  }
}

export function githubReleaseFlags(profile) {
  return ['--target', profile.branch, ...(profile.prerelease ? ['--prerelease'] : []), ...(profile.latest ? [] : ['--latest=false'])];
}
