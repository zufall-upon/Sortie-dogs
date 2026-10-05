import { goalFingerprint, type GoalEvidence, type GoalFlightState } from "../core/goal-bound.js";
import { readFile } from "node:fs/promises";
import { evidenceFromObservedExecution } from "../core/observed-goal-evidence.js";
import { protectedSnapshot, refreshProtectedSnapshot } from "../plugin/protected-snapshot.js";
import { normalizeCommand } from "../plugin/gate.js";
import type { CodexEvidenceCaptureRequest } from "./mission-settlement.js";

type GoalState = Pick<GoalFlightState, "goal_id" | "revision" | "scope_epoch" | "acceptance_fingerprint" | "acceptance_contract">;

export interface CodexProtectedEvidenceAuthorization {
  readonly manifestPath: string;
  readonly manifestHash: string;
  readonly projectRoot: string;
  readonly goalState: GoalState;
  readonly unitID: string;
  readonly declaredValidation: readonly string[];
  /** Derive this from the host session lineage, never from model output. */
  readonly owner: "worker" | "coordinator";
}

/**
 * Host-owned Codex evidence capture. Admit immediately before a validation-only
 * turn, then pass capture to CodexMissionSettlementBridge. Any protected change
 * during validation fails closed instead of being relabelled as fresh proof.
 */
export class CodexProtectedEvidenceCapture {
  private constructor(private readonly authorization: CodexProtectedEvidenceAuthorization,
    private readonly admitted: NonNullable<Awaited<ReturnType<typeof protectedSnapshot>>>,
    private readonly startedAt: string) {}

  static async admit(authorization: CodexProtectedEvidenceAuthorization): Promise<CodexProtectedEvidenceCapture | undefined> {
    const source = await readFile(authorization.manifestPath, "utf8").catch(() => undefined);
    if (!source) return undefined;
    let manifest: unknown;
    try { manifest = JSON.parse(source); } catch { return undefined; }
    const record = manifest !== null && typeof manifest === "object" && !Array.isArray(manifest)
      ? manifest as Record<string, unknown> : undefined;
    const validation = record?.validation;
    if (!Array.isArray(validation) || !validation.every(value => typeof value === "string")) return undefined;
    const declared = authorization.declaredValidation.map(normalizeCommand);
    if (validation.map(normalizeCommand).length !== declared.length ||
        validation.map(normalizeCommand).some((command, index) => command !== declared[index])) return undefined;
    const criteria = authorization.goalState.acceptance_contract?.criteria ?? [];
    if (criteria.some(criterion => criterion.expected_outcome !== "pass" || criterion.validation_command === undefined ||
        !declared.includes(normalizeCommand(criterion.validation_command))) ||
        declared.some(command => !criteria.some(criterion => criterion.validation_command !== undefined &&
          normalizeCommand(criterion.validation_command) === command))) return undefined;
    const admitted = await protectedSnapshot(authorization).catch(() => undefined);
    return admitted && new CodexProtectedEvidenceCapture(authorization, admitted, new Date().toISOString());
  }

  readonly capture = async (request: CodexEvidenceCaptureRequest): Promise<readonly GoalEvidence[]> => {
    const current = await refreshProtectedSnapshot(this.authorization.projectRoot, this.admitted.binding).catch(() => undefined);
    if (!current || current.source !== this.admitted.source || current.candidate !== this.admitted.candidate) return [];
    const evidence: GoalEvidence[] = [];
    const admittedCommands = this.authorization.declaredValidation.map(normalizeCommand);
    if (request.declaredValidation.length !== admittedCommands.length ||
        request.declaredValidation.some((command, index) => command !== admittedCommands[index])) return [];
    for (const execution of request.validationExecutions) {
      const item = execution.item;
      if (typeof item.command !== "string" || item.status !== "completed" || item.exitCode !== 0) return [];
      for (const command of execution.commands) {
        if (!request.declaredValidation.includes(command)) return [];
        const endedAt = new Date().toISOString();
        const immutableRef = goalFingerprint({ host: "codex-app-server", thread_id: request.turn.threadID,
          turn_id: request.turn.turnID, item_id: item.id, raw_command: item.command, command,
          started_at: this.startedAt, ended_at: endedAt,
          exit_code: 0, source: current.source, candidate: current.candidate });
        evidence.push(...evidenceFromObservedExecution({ owner: this.authorization.owner, immutableRef,
          command: [command], startedAt: this.startedAt, endedAt, exitCode: 0, outcome: "pass", fresh: true,
          source: current.source, candidate: current.candidate, binding: this.admitted.binding },
        this.authorization.goalState, this.authorization.unitID));
      }
    }
    return evidence;
  };
}
