import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { durableScopeRoot } from "../core/durable-scope-root.js";
import { goalFingerprint, type GoalAcceptanceContract, type GoalFlightState } from "../core/goal-bound.js";
import { normalizeManifestScope } from "../core/path.js";
import { RunFlightLedger } from "../core/run-flight-ledger.js";
import { ScopeLeaseRegistry } from "../core/scope-lease-registry.js";
import { STABLE_RUNTIME_PROFILE, type RuntimeProfile } from "../core/runtime-profile.js";
import type { OperationManifest } from "../core/types.js";
import { validateOperationManifestSchema } from "../core/validate-schema.js";
import type { SerialDispatchSettlement } from "../plugin/runtime-bridge.js";
import { CodexAppServerHost, createCodexAppServerTransport, type CodexTurnResult } from "./app-server.js";
import { CodexMissionSettlementBridge, type CodexValidationObservation } from "./mission-settlement.js";
import { CodexProtectedEvidenceCapture } from "./protected-evidence.js";
import { promisify } from "node:util";

export interface RunCodexMissionOptions {
  readonly projectRoot: string;
  readonly manifestPath: string;
  readonly prompt: string;
  readonly executable?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly trustedPowerShellExecutable?: string;
  readonly profile?: RuntimeProfile;
  readonly rootSessionID?: string;
}

export interface RunCodexMissionResult {
  readonly rootSessionID: string;
  readonly ledgerPath: string;
  readonly implementation: CodexTurnResult;
  readonly validation: CodexTurnResult;
  readonly observations: readonly CodexValidationObservation[];
  readonly settlement: SerialDispatchSettlement;
  readonly state: GoalFlightState;
}

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const exec = promisify(execFile);

function localScope(projectRoot: string, entries: readonly string[]): string[] {
  return entries.map(entry => {
    const normalized = normalizeManifestScope(entry);
    if (normalized.kind !== "relative") throw new Error("codex-mission-external-scope-unsupported");
    return normalized.path + (normalized.directory ? "/**" : "");
  });
}

function acceptanceContract(manifest: OperationManifest): GoalAcceptanceContract {
  return { criteria: manifest.validation.map((command, index) => ({
    criterion_id: `validation-${index + 1}`, target: manifest.task_id, entrypoint: command.split(/\s+/u)[0]!,
    workload: "declared validation", oracle_coverage: [`manifest.validation[${index}]`], build_boundary: "included" as const,
    source: "current", candidate: "current", source_binding: "current-protected" as const,
    candidate_binding: "current-protected" as const, validation_command: command, fixture: manifest.task_id,
    proof_scope: "requested-full" as const, expected_outcome: "pass" as const,
  })) };
}

async function projectSnapshot(projectRoot: string, profile: RuntimeProfile): Promise<Map<string, string>> {
  const listed = await Promise.all([
    exec("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: projectRoot, maxBuffer: 64 * 1024 * 1024 }),
    exec("git", ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"], { cwd: projectRoot, maxBuffer: 64 * 1024 * 1024 }),
  ]);
  const paths = [...new Set(listed.flatMap(result => result.stdout.split("\0").filter(Boolean)))]
    .filter(path => path !== profile.stateDirectory && !path.startsWith(`${profile.stateDirectory}/`));
  const snapshot = new Map<string, string>();
  for (const path of paths) {
    const absolute = resolve(projectRoot, path);
    const metadata = await lstat(absolute).catch(() => undefined);
    if (!metadata) continue;
    if (metadata.isSymbolicLink()) snapshot.set(path, `link:${await readlink(absolute)}`);
    else if (metadata.isFile()) snapshot.set(path, `file:${sha256(await readFile(absolute))}`);
  }
  return snapshot;
}

function allowedWrite(path: string, writes: readonly string[]): boolean {
  return writes.some(scope => scope.endsWith("/**") ? path === scope.slice(0, -3) || path.startsWith(scope.slice(0, -2)) : path === scope);
}

function changedPaths(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path) !== after.get(path)).sort();
}

/** Run one Codex implementation and settle its validation into Sortie's existing goal ledger. */
export async function runCodexMission(options: RunCodexMissionOptions): Promise<RunCodexMissionResult> {
  if (!options.prompt.trim()) throw new Error("codex-mission-prompt-required");
  const projectRoot = await realpath(resolve(options.projectRoot));
  const manifestPath = resolve(projectRoot, options.manifestPath);
  const manifestRelative = relative(projectRoot, manifestPath).replaceAll("\\", "/");
  if (!manifestRelative || manifestRelative === ".." || manifestRelative.startsWith("../") || isAbsolute(manifestRelative)) {
    throw new Error("codex-mission-manifest-outside-project");
  }
  const physicalManifest = await realpath(manifestPath).catch(() => undefined);
  if (!physicalManifest) throw new Error("codex-mission-manifest-invalid");
  const physicalRelative = relative(projectRoot, physicalManifest).replaceAll("\\", "/");
  if (!physicalRelative || physicalRelative === ".." || physicalRelative.startsWith("../") || isAbsolute(physicalRelative)) {
    throw new Error("codex-mission-manifest-outside-project");
  }
  const source = await readFile(manifestPath);
  if (source.byteLength > 512 * 1024) throw new Error("codex-mission-manifest-too-large");
  let raw: unknown;
  try { raw = JSON.parse(source.toString("utf8")); } catch { throw new Error("codex-mission-manifest-invalid"); }
  const checked = validateOperationManifestSchema(raw);
  if (!checked.ok) {
    throw new Error("codex-mission-manifest-invalid");
  }
  const manifest = checked.value;
  if (manifest.validation.length === 0) throw new Error("codex-mission-validation-required");
  const readScope = localScope(projectRoot, manifest.read);
  const writeScope = localScope(projectRoot, manifest.write);
  const scopeRoot = await durableScopeRoot(projectRoot);
  if (!scopeRoot) throw new Error("codex-mission-git-lease-unavailable");
  const profile = options.profile ?? STABLE_RUNTIME_PROFILE;
  const lease = await new ScopeLeaseRegistry(scopeRoot).acquire({ ownerId: `codex:${process.pid}:${randomUUID()}`,
    scope: { read: [...new Set([...readScope, manifestRelative])], write: ["**"] } });
  const rootSessionID = options.rootSessionID ?? `codex:${sha256(projectRoot)}:${randomUUID()}`;
  const key = sha256(profile.id === "stable" ? rootSessionID : `${profile.id}\0${rootSessionID}`);
  const ledgerPath = join(dirname(scopeRoot), profile.flightDirectory, `${key}.json`);
  let ledger: RunFlightLedger | undefined;
  let host: CodexAppServerHost | undefined;
  let goalID: string | undefined;
  let reservationID: string | undefined;
  let unitID: string | undefined;
  let startedAt: string | undefined;
  try {
    ledger = await RunFlightLedger.openGoal(ledgerPath);
    host = new CodexAppServerHost(createCodexAppServerTransport({ executable: options.executable }));
    const initial = (await ledger.readGoal()).state;
    if (initial.goal_id !== null && initial.phase === "active") throw new Error("codex-mission-active-goal");
    const contract = acceptanceContract(manifest);
    goalID = `codex-${randomUUID()}`;
    const fingerprint = goalFingerprint({ manifest: sha256(source), prompt: options.prompt, contract });
    const at = new Date().toISOString();
    startedAt = at;
    await ledger.appendGoal({ kind: "goal.accepted", at, goal_id: goalID, revision: 1, scope_epoch: 1,
      acceptance_fingerprint: fingerprint, origin_user_message_id: `codex-request-${randomUUID()}`,
      origin_session_id: rootSessionID, selected_agent: "codex", delivery: "mvp-first",
      budget: { max_units: 1, time_ms: null, cost_usd: null, source: "accepted-plan" }, acceptance_contract: contract });
    reservationID = randomUUID();
    unitID = manifest.task_id;
    await ledger.appendGoal({ kind: "dispatch.reserved", at: new Date().toISOString(), reservation_id: reservationID,
      goal_id: goalID, unit_id: unitID, session_id: rootSessionID, ticket_id: null });
    const threadID = await host.startThread({ cwd: projectRoot, model: options.model, ephemeral: true });
    const sandboxPolicy = { type: "workspaceWrite", writableRoots: [projectRoot], networkAccess: false };
    const before = await projectSnapshot(projectRoot, profile);
    const implementation = await host.runTurn(threadID,
      `${options.prompt}\n\nWork only within the operation manifest scope. Do not run validation commands yet.`,
      { cwd: projectRoot, approvalPolicy: "never", sandboxPolicy, model: options.model, effort: options.effort });
    if (implementation.status !== "completed") throw new Error("codex-mission-implementation-failed");
    await lease.assertHeld();
    const after = await projectSnapshot(projectRoot, profile);
    const outOfScope = changedPaths(before, after).filter(path => !allowedWrite(path, writeScope));
    if (outOfScope.length) throw new Error(`codex-mission-write-scope-violation:${outOfScope.slice(0, 8).join(",")}`);
    const goalState = (await ledger.readGoal()).state;
    const capture = await CodexProtectedEvidenceCapture.admit({ manifestPath, manifestHash: sha256(source), projectRoot,
      goalState, unitID, declaredValidation: manifest.validation, owner: "coordinator" });
    if (!capture) throw new Error("codex-mission-evidence-admission-failed");
    const validationStartedAt = new Date().toISOString();
    const validation = await host.runTurn(threadID,
      `Run only these validation commands, once each and in order. Do not modify files:\n${manifest.validation.map(command => `- ${command}`).join("\n")}`,
      { cwd: projectRoot, approvalPolicy: "never", sandboxPolicy, model: options.model, effort: options.effort });
    await lease.assertHeld();
    const observations: CodexValidationObservation[] = [];
    const bridge = new CodexMissionSettlementBridge({
      observedValidation: async value => { observations.push(...value); },
      settled: async settlement => {
        await ledger!.appendGoal({ kind: "unit.settled", at: new Date().toISOString(), reservation_id: reservationID!,
          receipt_id: randomUUID(), goal_id: goalID!, unit_id: unitID!, disposition: settlement.disposition,
          result_class: settlement.resultClass === "process-defect" ? "process-defect" :
            settlement.resultClass === "interrupted" ? "interrupted" : "acceptance",
          progress_fingerprint: settlement.disposition === "succeeded" ? goalFingerprint(settlement.evidence) : null,
          evidence: settlement.evidence, elapsed_ms: null, cost_usd: null, native_session_id: validation.threadID,
          native_started_at: validationStartedAt,
          ...(observations.length ? { native_validation_observations: observations.map(item => ({ thread_id: item.threadID,
            turn_id: item.turnID, ...(item.itemID ? { item_id: item.itemID } : {}), raw_command: item.rawCommand,
            canonical_commands: item.canonicalCommands })) } : {}) });
      },
    });
    const settlement = await bridge.settle({ rootSessionID, callID: validation.turnID, unitID, turn: validation,
      declaredValidation: manifest.validation, trustedPowerShellExecutable: options.trustedPowerShellExecutable,
      goalState, captureEvidence: capture.capture });
    const settled = (await ledger.readGoal()).state;
    const endedAt = new Date().toISOString();
    await ledger.appendGoal({ kind: "goal.terminal", at: endedAt, goal_id: goalID, receipt: { goal_id: goalID,
      terminal_revision: settled.revision, acceptance_fingerprint: settled.acceptance_fingerprint!, started_at: at,
      ended_at: endedAt, status: settlement.disposition === "succeeded" ? "succeeded" : "stopped",
      stop_reason: settlement.disposition === "succeeded" ? "completed" : "stopped",
      unit_ids: settled.unit_ids, session_ids: settled.session_ids, evidence_refs: settled.evidence_refs,
      milestone_at: settlement.disposition === "succeeded" ? endedAt : null } });
    return { rootSessionID, ledgerPath, implementation, validation, observations, settlement,
      state: (await ledger.readGoal()).state };
  } catch (error) {
    let compensation: unknown;
    try {
      if (ledger && goalID && reservationID && unitID && startedAt) {
        let state = (await ledger.readGoal()).state;
        if (state.outstanding_reservations.some(item => item.reservation_id === reservationID)) {
          await ledger.appendGoal({ kind: "unit.settled", at: new Date().toISOString(), reservation_id: reservationID,
            receipt_id: randomUUID(), goal_id: goalID, unit_id: unitID, disposition: "failed", result_class: "process-defect",
            progress_fingerprint: null, evidence: [], elapsed_ms: null, cost_usd: null });
          state = (await ledger.readGoal()).state;
        }
        if (state.goal_id === goalID && state.phase === "active" && state.outstanding_reservations.length === 0) {
          const endedAt = new Date().toISOString();
          await ledger.appendGoal({ kind: "goal.terminal", at: endedAt, goal_id: goalID, receipt: { goal_id: goalID,
            terminal_revision: state.revision, acceptance_fingerprint: state.acceptance_fingerprint!, started_at: startedAt,
            ended_at: endedAt, status: "stopped", stop_reason: "stopped", unit_ids: state.unit_ids,
            session_ids: state.session_ids, evidence_refs: state.evidence_refs, milestone_at: null } });
        }
      }
    } catch (failure) { compensation = failure; }
    if (compensation) throw new Error(`codex-mission-compensation-failed:${error instanceof Error ? error.message : String(error)}`, { cause: compensation });
    throw error;
  } finally {
    try { await host?.close(); }
    finally { await lease.release().catch(() => lease.close()); }
  }
}
