import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { exists, hashFile, readJson, versionRoot, writeJson } from './core.mjs';

const pathKey = value => String(value ?? '').replaceAll('\\', '/').toLowerCase();

// The caller proves native ownership and verifies the retained file hash before replying.
export function eligibleReadPermission(request, tool, policy, ownedSessionIDs) {
  if (!ownedSessionIDs.has(request.session_id ?? request.sessionID) || request.source?.type !== 'tool') return false;
  if (!tool || tool.name !== 'read' || tool.call_id !== request.source.id ||
    tool.session_id !== (request.session_id ?? request.sessionID)) return false;
  if (pathKey(tool.path) !== pathKey(policy.applicable_agents_path)) return false;
  const resources = request.resources ?? [];
  if (resources.length !== 1) return false;
  if (request.action === 'read') return pathKey(resources[0]) === pathKey(policy.applicable_agents_path);
  return request.action === 'external_directory' &&
    pathKey(resources[0]) === `${pathKey(dirname(policy.applicable_agents_path))}/*`;
}

export async function fixExecutionPolicy(version, profile, diagnosis) {
  const path = join(versionRoot(version), 'execution-policy.json');
  const policy = { schema_version: 1, no_progress_ms: profile.stall_policy.no_progress_ms,
    applicable_agents_path: join(profile.repo_root, 'AGENTS.md'),
    applicable_agents_sha256: profile.applicable_agents_sha256,
    known_read_permission_decision: 'once', other_permissions: 'observe-only; stop after no-progress timeout',
    prompt_replay: false, replacement_worker_on_stall: false,
    diagnosis_record_path: diagnosis.record_path, diagnosis_stop_reason: diagnosis.stop_reason,
    original_diagnostic_policy_unchanged: true };
  assert.equal(await hashFile(policy.applicable_agents_path), policy.applicable_agents_sha256);
  if (await exists(path)) {
    const existing = await readJson(path);
    for (const [key, value] of Object.entries(policy)) assert.deepEqual(existing[key], value, `fixed execution policy changed: ${key}`);
    return existing;
  }
  const retained = { ...policy, fixed_at: new Date().toISOString() };
  await writeJson(path, retained, { flag: 'wx' });
  return retained;
}
