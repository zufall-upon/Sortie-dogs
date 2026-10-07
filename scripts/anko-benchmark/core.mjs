import { createHash } from 'node:crypto';
import { copyFile, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { comparablePath, hostPaths } from './host.mjs';

export const ROOT = process.cwd();
export const STATE_ROOT = join(ROOT, '_testenv/anko-reusable');
export const HOST = hostPaths();
export const ARTIFACT_ROOT = HOST.artifact_root;
export const LEGACY_RUN = HOST.legacy_run;
export const SOURCE_PROJECT = HOST.source_project;
export const CLI = HOST.cli;
export const HOST_DATABASE = HOST.host_database;
export const INSTRUCTION_SHA256 = '96c0c7ad98237d6176034c8893d8bff164ec5fda45889e51780a65cf599ffcfe';
export const ANKO_BASE = '3f269a72ff69398b1250c584171f32d12c0d8085';
export const CLI_SHA256 = '78f454c0a1581b66ce4f264f42bfaee6207c887053d8e4b02c4c9cfb74e90668';
export const CLIENT_LOCK_SHA256 = '4a35b93727d1c6c5e90b84a6090107b020defcb36371fa238711db8d79015d38';
export const READ_STALL_MS = 180_000;
export const MONITOR_INTERVAL_MS = 1_000;
export const WALL_LIMIT_MS = 60 * 60_000;
export const COST_LIMIT_USD = 15;
export const ROOT_MODEL = 'openai/gpt-6.1-sol#xhigh';
export const WORKER_MODEL = 'openai/gpt-6-luna-fast#max';
export const CLI_VERSION = '2.0.18';

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export async function hashFile(path) {
  const hash = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function writeJson(path, value, options = {}) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, options);
}

export function parseVersion(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/u.test(value))
    throw new Error(`Invalid --version value: ${String(value)}`);
  return value;
}

export function parseCommand(argv) {
  const [command, ...rest] = argv;
  if (!['prepare', 'profile', 'diagnose', 'inspect', 'verify', 'run'].includes(command))
    throw new Error('usage: node scripts/anko-benchmark.mjs <prepare|profile|diagnose|inspect|verify|run> [--version X.Y.Z] [--package PATH]');
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (!['--version', '--package'].includes(key) || options[key])
      throw new Error(`Unexpected or repeated option: ${key}`);
    const value = rest[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    options[key] = value;
  }
  if (command !== 'profile' && !options['--version']) throw new Error(`${command} requires --version X.Y.Z`);
  if (command === 'profile' && options['--version']) throw new Error('profile does not accept --version');
  if (command !== 'prepare' && options['--package']) throw new Error('--package is only accepted by prepare');
  return { command, version: options['--version'] ? parseVersion(options['--version']) : null,
    packagePath: options['--package'] ?? null };
}

export function versionRoot(version) {
  return join(STATE_ROOT, `v${parseVersion(version)}`);
}

export function packageRoot(version) {
  return join(STATE_ROOT, 'packages', `v${parseVersion(version)}`);
}

export function profilePath() {
  return join(STATE_ROOT, 'common', 'profile.json');
}

export function packageReceiptPath(version) {
  return join(packageRoot(version), 'receipt.json');
}

export function diagnosticRoot(version) {
  return join(versionRoot(version), 'diagnosis');
}

export function fixedProfile() {
  return {
    schema_version: 1,
    benchmark: {
      max_attempts: 1,
      max_wall_ms: WALL_LIMIT_MS,
      max_priced_usd: COST_LIMIT_USD,
      grading: 'none',
      task_id: 'datacurve/anko-typed-variable-bindings',
      base: ANKO_BASE,
      instruction_bytes: 1825,
      instruction_sha256: INSTRUCTION_SHA256,
      cli_version: CLI_VERSION,
      root_model: ROOT_MODEL,
      worker_model: WORKER_MODEL,
    },
    stall_policy: {
      no_progress_ms: READ_STALL_MS,
      polling_interval_ms: MONITOR_INTERVAL_MS,
      active_session_status_is_progress: false,
      progress_signals: ['native model text/reasoning delta', 'native tool start/end', 'permission request/reply state',
        'assistant token-usage change', 'Mission/operator state change', 'candidate source change'],
      pending_permission_response: 'observe-only; never auto-allow, auto-reject or infer consent',
      no_progress_action: 'record native state; interrupt each still-active owned session once; do not replay the prompt or dispatch a replacement Worker',
      contextual_recovery: {
        max_prompts: 1,
        eligibility: 'only after the root and every owned session have native terminal states, the same Mission remains incomplete, and no tool or permission request is pending',
        action: 'continue the same root and Mission with the observed terminal state; do not replay the original task or start another arm',
        prompt_context: 'include the already-read applicable AGENTS.md text so the Worker does not repeat the known external read',
      },
    },
  };
}

export function progressSignature(progress) {
  return JSON.stringify({
    priced_usd: progress.priced_usd,
    priced_messages: progress.priced_messages,
    unpriced_messages: progress.unpriced_messages,
    mission_phase: progress.mission_phase,
    review: progress.review,
    submission_status: progress.submission_status,
    operator_stage: progress.operator_stage,
    operator_decision: progress.operator_decision,
    native_receipt_status: progress.native_receipt_status,
    native_progress_event_count: progress.native_progress_event_count,
    plugin_hook_event_count: progress.plugin_hook_event_count,
    candidate_source_signature: progress.candidate_source_signature,
    permission_state: progress.permission_state,
    sessions: (progress.owned_sessions ?? []).map(session => ({ id: session.id, agent: session.agent,
      outcome: session.outcome, time_idle: session.time_idle, assistant_messages: session.assistant_messages,
      token_usage: session.token_usage })),
  });
}

export function shouldStopForNoProgress({ now, lastProgressAt, threshold = READ_STALL_MS }) {
  return Number.isFinite(now) && Number.isFinite(lastProgressAt) && now - lastProgressAt >= threshold;
}

export function noProgressStopReason({ pendingPermissionCount = 0, activeTool = null }) {
  if (pendingPermissionCount > 0) return 'permission-confirmation-no-progress-timeout';
  if (activeTool?.name === 'read') return 'native-read-no-progress-timeout';
  if (activeTool) return 'native-tool-no-progress-timeout';
  return 'session-no-progress-timeout';
}

function comparableObservedPath(value) {
  return comparablePath(value);
}

export function diagnosticReadObservations(events, hooks, targets) {
  const toolEvents = events.filter(event => event.type?.startsWith('session.tool.'));
  const callID = event => event.call_id ?? event.callID ?? event.id ?? null;
  return targets.map(target => {
    const wanted = new Set([target.path, ...(target.aliases ?? [])].map(comparableObservedPath));
    const matchesPath = event => wanted.has(comparableObservedPath(event.path));
    const directlyMatchedEvents = toolEvents.filter(matchesPath);
    const directlyMatchedHooks = hooks.filter(event => event.tool === 'read' && matchesPath(event));
    const matchedIDs = new Set([...directlyMatchedEvents, ...directlyMatchedHooks].map(callID).filter(Boolean));
    const relatedEvents = [...new Set([...directlyMatchedEvents,
      ...toolEvents.filter(event => matchedIDs.has(callID(event)))])];
    const relatedHooks = [...new Set([...directlyMatchedHooks,
      ...hooks.filter(event => event.tool === 'read' && matchedIDs.has(callID(event)))])];
    const types = relatedEvents.map(event => event.type);
    const nativeStart = types.some(type => type === 'session.tool.input.started' || type === 'session.tool.called');
    const nativeTerminal = types.some(type => ['session.tool.success',
      'session.tool.failed'].includes(type));
    const before = relatedHooks.some(event => event.phase === 'plugin-hook-before');
    const after = relatedHooks.some(event => event.phase === 'plugin-hook-after');
    return {
      target_id: target.id,
      requested_path: target.path,
      expected_presence: target.expected_presence,
      status: nativeStart || before ? 'read-boundary-observed' : 'not-observed',
      native_tool_start_observed: nativeStart,
      native_tool_call_observed: types.includes('session.tool.called'),
      native_tool_terminal_observed: nativeTerminal,
      plugin_hook_before_observed: before,
      plugin_hook_after_observed: after,
      call_ids: [...new Set([...relatedEvents, ...relatedHooks].map(callID).filter(Boolean))],
      native_event_types: [...new Set(types)],
    };
  });
}

export function tarEntryFromTgz(bytes, wanted) {
  const tar = gunzipSync(bytes);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/su, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/su, '');
    const entryName = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/su, '').trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid tar entry size in package archive');
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > tar.length) throw new Error('Truncated package tar entry');
    if (entryName === wanted) return tar.subarray(contentStart, contentEnd);
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${wanted} is missing from the .tgz`);
}

export function packageJsonFromTgz(bytes) {
  return JSON.parse(tarEntryFromTgz(bytes, 'package/package.json').toString('utf8'));
}

export async function writeExclusive(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'wx');
  try { await handle.writeFile(contents); }
  finally { await handle.close(); }
}

export async function copyExclusive(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination, 1);
}

export async function exists(path) {
  try { await stat(path); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

// Moving to the common runner must not reset a consumed retained Linux arm.
export async function priorStandaloneAttempt(version, paths = HOST) {
  if (paths.platform !== 'linux') return null;
  const lock = join(paths.legacy_run, 'run-once.lock');
  if (!await exists(lock)) return null;
  const candidate = await readJson(join(paths.legacy_run, 'candidate.json'));
  return candidate.version === version ? { lock, version, package_sha256: candidate.package_sha256 } : null;
}
