import {
  reconstructRunFlightLedger,
  RunFlightLedgerError,
  type FlightBudgetLimits,
  type RunFlightEventRecord,
  type RunFlightLedgerErrorCode,
  type RunFlightState,
} from "./run-flight-ledger.js";

const EVENT_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export type WaveBoundaryReplayReason = "latest_accepted_boundary" | "diagnostic_override";
export type WaveBoundaryReplayErrorCode = "invalid_ledger" | "boundary_missing" | "invalid_override" | "unknown_override";

export class WaveBoundaryReplayError extends Error {
  readonly code: WaveBoundaryReplayErrorCode;
  readonly ledger_code: RunFlightLedgerErrorCode | null;

  constructor(code: WaveBoundaryReplayErrorCode, message: string, ledgerCode: RunFlightLedgerErrorCode | null = null) {
    super(message);
    this.name = "WaveBoundaryReplayError";
    this.code = code;
    this.ledger_code = ledgerCode;
  }
}

export interface WaveBoundaryReplayOptions {
  readonly boundary_event_hash?: string;
}

export interface WaveBoundaryIdentity {
  readonly sequence: number;
  readonly event_hash: string;
  readonly from_candidate_id: string;
  readonly candidate_id: string;
  readonly wave_id: string;
  readonly artifact_id: string;
}

export interface WaveBoundaryRecoveryBudget {
  readonly budget_consumed: FlightBudgetLimits;
  readonly budget_limits: FlightBudgetLimits;
  readonly validated_event_count: number;
  readonly validated_tail_hash: string;
}

export interface WaveBoundaryReplaySelection {
  readonly reason: WaveBoundaryReplayReason;
  readonly boundary: WaveBoundaryIdentity;
  readonly prefix: readonly RunFlightEventRecord[];
  readonly state: RunFlightState;
  readonly recovery_budget: WaveBoundaryRecoveryBudget;
}

function validateEntireLedger(records: unknown): {
  readonly records: readonly RunFlightEventRecord[];
  readonly state: RunFlightState;
} {
  if (!Array.isArray(records)) {
    throw new WaveBoundaryReplayError("invalid_ledger", "Ledger records must be an array.");
  }
  try {
    const state = reconstructRunFlightLedger(records as readonly RunFlightEventRecord[]);
    return { records: records as readonly RunFlightEventRecord[], state };
  } catch (error) {
    if (error instanceof RunFlightLedgerError) {
      throw new WaveBoundaryReplayError("invalid_ledger", error.message, error.code);
    }
    throw error;
  }
}

function validateOptions(options: unknown): WaveBoundaryReplayOptions {
  if (options === undefined) return {};
  if (typeof options !== "object" || options === null || Array.isArray(options) ||
    Object.keys(options).some((key) => key !== "boundary_event_hash")) {
    throw new WaveBoundaryReplayError("invalid_override", "Replay options do not match the closed override schema.");
  }
  const override = (options as Record<string, unknown>).boundary_event_hash;
  if (override !== undefined && (typeof override !== "string" || !EVENT_HASH_PATTERN.test(override))) {
    throw new WaveBoundaryReplayError("invalid_override", "Boundary override must be a canonical event hash.");
  }
  return override === undefined ? {} : { boundary_event_hash: override as string };
}

export function selectWaveBoundaryReplay(records: unknown, options?: unknown): WaveBoundaryReplaySelection {
  // Validate the complete ledger before selecting a prefix. An invalid tail must never be hidden by replay.
  const validated = validateEntireLedger(records);
  const validatedOptions = validateOptions(options);
  const boundaries = validated.records.filter((record) => record.event.kind === "candidate.advanced");
  if (boundaries.length === 0) {
    throw new WaveBoundaryReplayError("boundary_missing", "Ledger has no accepted candidate advancement boundary.");
  }

  const override = validatedOptions.boundary_event_hash;
  const selected = override === undefined
    ? boundaries[boundaries.length - 1]
    : boundaries.find((record) => record.event_hash === override);
  if (selected === undefined) {
    throw new WaveBoundaryReplayError("unknown_override", "Boundary override does not identify a candidate advancement event.");
  }

  const prefix = structuredClone(validated.records.slice(0, selected.sequence));
  const state = reconstructRunFlightLedger(prefix);
  const event = selected.event;
  if (event.kind !== "candidate.advanced" || validated.state.budget_limits === null) {
    throw new WaveBoundaryReplayError("invalid_ledger", "Validated boundary state is internally inconsistent.");
  }

  return {
    reason: override === undefined ? "latest_accepted_boundary" : "diagnostic_override",
    boundary: {
      sequence: selected.sequence,
      event_hash: selected.event_hash,
      from_candidate_id: event.from_candidate_id,
      candidate_id: event.candidate_id,
      wave_id: event.wave_id,
      artifact_id: event.artifact_id,
    },
    prefix,
    state,
    recovery_budget: {
      budget_consumed: { ...validated.state.budget_consumed },
      budget_limits: { ...validated.state.budget_limits },
      validated_event_count: validated.records.length,
      validated_tail_hash: validated.records[validated.records.length - 1].event_hash,
    },
  };
}
