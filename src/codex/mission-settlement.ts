import { validGoalEvidence, type GoalEvidence, type GoalFlightState } from "../core/goal-bound.ts";
import type { SerialDispatchSettlement } from "../plugin/runtime-bridge.ts";
import { canonicalDeclaredValidationMembers, normalizeCommand } from "../plugin/gate.ts";
import type { CodexTurnResult } from "./app-server.ts";

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);

export interface CodexEvidenceCaptureRequest {
  readonly turn: CodexTurnResult;
  readonly validationExecutions: readonly {
    readonly item: JsonObject;
    readonly commands: readonly string[];
  }[];
  readonly declaredValidation: readonly string[];
}

export interface CodexValidationObservation {
  readonly threadID: string;
  readonly turnID: string;
  readonly itemID?: string;
  readonly rawCommand: string;
  readonly canonicalCommands: readonly string[];
  readonly status: string;
  readonly exitCode: number | null;
}

export interface CodexMissionSettlementRequest {
  readonly rootSessionID: string;
  readonly callID: string;
  readonly unitID: string;
  readonly turn: CodexTurnResult;
  /** Ordered canonical validation commands already admitted by the existing Sortie contract. */
  readonly declaredValidation: readonly string[];
  /** Exact trusted pwsh.exe path used by this Codex host. Without it, wrapped commands are rejected. */
  readonly trustedPowerShellExecutable?: string;
  /** Current durable goal identity and acceptance contract used by the existing validator. */
  readonly goalState: Pick<GoalFlightState, "goal_id" | "revision" | "scope_epoch" | "acceptance_fingerprint" | "acceptance_contract">;
  /** Existing protected-snapshot/evidence path. Codex event text alone is never evidence. */
  readonly captureEvidence: (request: CodexEvidenceCaptureRequest) => Promise<readonly GoalEvidence[]>;
}

export interface CodexMissionSettlementTarget {
  /** Retain host-native command identity before committing the derived settlement. */
  observedValidation(observations: readonly CodexValidationObservation[]): Promise<void>;
  settled(result: SerialDispatchSettlement): Promise<void>;
}

const commandText = (item: JsonObject): string | undefined => {
  if (typeof item.command === "string") return item.command;
  // Codex protocol revisions may expose argv instead of a shell command. Do not
  // collapse argv boundaries into a different command identity. A future caller
  // can admit argv explicitly once the core validation contract supports it.
  return undefined;
};

const powershellEnvelopePayload = (raw: string, trustedExecutable?: string): string | undefined => {
  if (!trustedExecutable) return undefined;
  // Windows Codex 0.160/0.162 reports a quoted absolute pwsh.exe plus one single-quoted
  // -Command payload. It may protocol-escape the boundary quotes/backslashes.
  // Only the observed optional -NoProfile flag is admitted. Other options,
  // nested quotes and trailing tokens remain rejected.
  const match = /^(?:"|\\")([A-Za-z]:[\\/](?:[^"'\r\n]|\\\\)+[\\/]pwsh\.exe)(?:"|\\") (?:-NoProfile )?-Command '([^'`\r\n]*)'$/iu.exec(raw);
  if (!match) return undefined;
  const identity = (value: string) => value.replaceAll("\\\\", "\\").replaceAll("/", "\\").toLowerCase();
  return identity(match[1]!) === identity(trustedExecutable) ? match[2] : undefined;
};

// Linux Codex reports the system bash command as one single-quoted payload.
// Admit only the observed absolute executable and flags. The payload still goes
// through the shared exact declared-command matcher; never evaluate shell text.
const bashEnvelopePayload = (raw: string): string | undefined =>
  /^\/bin\/bash -lc '([^'\r\n]*)'$/u.exec(raw)?.[1];

const declaredMembers = (item: JsonObject, expected: readonly string[], trustedExecutable?: string): string[] | undefined => {
  const raw = commandText(item);
  if (!raw) return undefined;
  const payload = powershellEnvelopePayload(raw, trustedExecutable) ?? bashEnvelopePayload(raw);
  return canonicalDeclaredValidationMembers(raw, expected) ?? (payload === undefined ? undefined :
    canonicalDeclaredValidationMembers(payload, expected));
};

/**
 * Converts authoritative Codex completed items into the existing Sortie settlement boundary.
 * This is deliberately post-execution reconciliation, not a replacement for a pre-execution
 * permission hook. Success requires the exact declared validation sequence plus fresh evidence
 * from Sortie's existing capture path.
 */
export class CodexMissionSettlementBridge {
  private readonly target: CodexMissionSettlementTarget;
  constructor(target: CodexMissionSettlementTarget) { this.target = target; }

  async settle(request: CodexMissionSettlementRequest): Promise<SerialDispatchSettlement> {
    const base = { rootSessionID: request.rootSessionID, callID: request.callID, unitID: request.unitID,
      childSessionID: request.turn.threadID } as const;
    if (request.turn.status === "interrupted") {
      const expected = request.declaredValidation.map(normalizeCommand);
      const observations: CodexValidationObservation[] = [];
      let cursor = 0;
      for (const item of request.turn.items) {
        if (!object(item) || item.type !== "commandExecution") continue;
        const members = declaredMembers(item, expected.slice(cursor), request.trustedPowerShellExecutable);
        if (!members || members.length === 0) continue;
        const normalized = members.map(normalizeCommand);
        if (normalized.some((member, index) => member !== expected[cursor + index])) continue;
        observations.push({ threadID: request.turn.threadID, turnID: request.turn.turnID,
          ...(typeof item.id === "string" ? { itemID: item.id } : {}), rawCommand: item.command as string,
          canonicalCommands: normalized, status: typeof item.status === "string" ? item.status : "unknown",
          exitCode: typeof item.exitCode === "number" ? item.exitCode : null });
        cursor += normalized.length;
        if (cursor === expected.length || item.status !== "completed" || item.exitCode !== 0) break;
      }
      if (observations.length > 0) {
        try { await this.target.observedValidation(observations); }
        catch { return this.commit({ ...base, disposition: "failed", evidence: [], resultClass: "process-defect", nativeOutcome: "failed" }); }
      }
      return this.commit({ ...base, disposition: "cancelled",
        evidence: [], resultClass: "interrupted", nativeOutcome: "failed" });
    }
    if (request.turn.status !== "completed") return this.commit({ ...base, disposition: "failed",
      evidence: [], resultClass: "process-defect", nativeOutcome: "failed" });
    if (request.declaredValidation.length === 0) return this.commit({ ...base, disposition: "failed",
      evidence: [], resultClass: "acceptance", nativeOutcome: "completed" });
    if (request.goalState.acceptance_contract?.criteria.some(criterion => criterion.expected_outcome !== "pass")) {
      return this.commit({ ...base, disposition: "failed", evidence: [], resultClass: "acceptance", nativeOutcome: "completed" });
    }

    const expected = request.declaredValidation.map(normalizeCommand);
    const validationExecutions: Array<{ item: JsonObject; commands: string[] }> = [];
    let cursor = 0;
    for (const item of request.turn.items) {
      if (!object(item) || item.type !== "commandExecution") continue;
      const members = declaredMembers(item, expected.slice(cursor), request.trustedPowerShellExecutable);
      if (!members || members.length === 0) continue;
      const normalized = members.map(normalizeCommand);
      if (normalized.some((member, index) => member !== expected[cursor + index])) continue;
      validationExecutions.push({ item, commands: normalized });
      const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
      if (item.status !== "completed" || exitCode !== 0) {
        const observations = validationExecutions.map(({ item: observed, commands }) => ({
          threadID: request.turn.threadID, turnID: request.turn.turnID,
          ...(typeof observed.id === "string" ? { itemID: observed.id } : {}), rawCommand: observed.command as string,
          canonicalCommands: commands, status: typeof observed.status === "string" ? observed.status : "unknown",
          exitCode: typeof observed.exitCode === "number" ? observed.exitCode : null,
        }));
        try { await this.target.observedValidation(observations); }
        catch { return this.commit({ ...base, disposition: "failed", evidence: [], resultClass: "process-defect", nativeOutcome: "completed" }); }
        return this.commit({ ...base, disposition: "failed", evidence: [],
          resultClass: "acceptance", nativeOutcome: "completed", failure: { command: normalized, outcome: "fail", exitCode } });
      }
      cursor += normalized.length;
      if (cursor === expected.length) break;
    }
    if (cursor !== expected.length) return this.commit({ ...base, disposition: "failed", evidence: [],
      resultClass: "acceptance", nativeOutcome: "completed",
      failure: { command: [expected[cursor]!], outcome: "fail", exitCode: null } });

    const observations = validationExecutions.map(({ item, commands }) => ({ threadID: request.turn.threadID,
      turnID: request.turn.turnID, ...(typeof item.id === "string" ? { itemID: item.id } : {}),
      rawCommand: item.command as string, canonicalCommands: commands,
      status: typeof item.status === "string" ? item.status : "unknown",
      exitCode: typeof item.exitCode === "number" ? item.exitCode : null }));
    try { await this.target.observedValidation(observations); }
    catch { return this.commit({ ...base, disposition: "failed", evidence: [], resultClass: "process-defect", nativeOutcome: "completed" }); }
    let evidence: readonly GoalEvidence[];
    try { evidence = await request.captureEvidence({ turn: request.turn, validationExecutions,
      declaredValidation: expected }); }
    catch { evidence = []; }
    const requiredCriteria = request.goalState.acceptance_contract?.criteria.filter(criterion =>
      criterion.expected_outcome === "pass") ?? [];
    const requiredCriterionIDs = new Set(requiredCriteria.map(criterion => criterion.criterion_id));
    const coveredCriterionIDs = new Set<string>();
    const coveredCommands = new Set<string>();
    const valid = evidence.length > 0 && requiredCriterionIDs.size > 0 && evidence.every(entry => {
      if (!validGoalEvidence(entry, request.goalState) || entry.execution.outcome !== "pass" ||
          entry.execution.command.length !== 1) return false;
      const command = normalizeCommand(entry.execution.command[0]!);
      if (!expected.includes(command)) return false;
      coveredCommands.add(command);
      for (const id of entry.measurement.criterion_ids) {
        if (!requiredCriterionIDs.has(id)) return false;
        coveredCriterionIDs.add(id);
      }
      return true;
    }) && expected.every(command => coveredCommands.has(command)) &&
      [...requiredCriterionIDs].every(id => coveredCriterionIDs.has(id));
    if (!valid) {
      return this.commit({ ...base, disposition: "failed", evidence: [], resultClass: "acceptance", nativeOutcome: "completed",
        failure: { command: expected, outcome: "fail", exitCode: null } });
    }
    return this.commit({ ...base, disposition: "succeeded", evidence, resultClass: "acceptance", nativeOutcome: "completed" });
  }

  private async commit(settlement: SerialDispatchSettlement): Promise<SerialDispatchSettlement> {
    await this.target.settled(settlement);
    return settlement;
  }
}
