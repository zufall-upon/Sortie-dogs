import { isSourceReviewRiskTag, STRATEGY_TRIGGERS } from "../core/consultation.js";

const MAX_SESSIONS = 256;
const MAX_REVIEW_CANDIDATES = 11;
const GAP_CODES = new Set(["manifest", "validation", "owner-risk"]);
const STRATEGY_TRIGGER_SET = new Set<string>(STRATEGY_TRIGGERS);
const MANUAL_COMPACTION_TOOLS = new Set(["compact_and_continue", "sortie_compact_and_continue"]);
export const BACKLOG_DRAIN_CAPABILITY = "sortie_enable_backlog_drain";

export type FastLaneDenialCode =
  | "TURN_STATE_REQUIRED"
  | "ROLE_FORBIDDEN"
  | "WORKER_LIMIT"
  | "SCOUT_GAP_REQUIRED"
  | "SCOUT_LIMIT"
  | "SCOUT_TOO_LATE"
  | "REVIEW_EVIDENCE_REQUIRED"
  | "REVIEW_PHASE_INVALID"
  | "REVIEW_LIMIT"
  | "ADVISOR_TRIGGER_REQUIRED"
  | "ADVISOR_LIMIT"
  | "CONSULTATION_RETRY_INVALID"
  | "CONSULTATION_RETRY_UNAUTHORIZED"
  | "CONSULTATION_RETRY_MISMATCH"
  | "BACKLOG_DRAIN_INVALID"
  | "BACKLOG_DRAIN_TOO_LATE"
  | "MANUAL_COMPACTION_FORBIDDEN";

export class FastLaneDeniedError extends Error {
  readonly code: FastLaneDenialCode;

  constructor(code: FastLaneDenialCode) {
    super(`SORTIE_FAST_LANE_DENIED: ${code}`);
    this.name = "FastLaneDeniedError";
    this.code = code;
  }
}

interface FastLaneTurnState {
  advisorDispatches: number;
  advisorPrompt?: string;
  reviewCandidates: Map<string, ReviewCandidateState>;
  reviewsLocked: boolean;
  scoutDispatches: number;
  backlogDrain: boolean;
  continuationPending: boolean;
  totalWorkerDispatches: number;
  workerLimit: number;
  workerDispatches: number;
}

interface ReviewCandidateState {
  initialDispatches: number;
  initialPrompt?: string;
  verificationDispatches: number;
  verificationPrompt?: string;
}

export interface FastLaneToolOptions {
  readonly consultationFallbackAuthorized?: boolean;
}

function taskArgument(args: unknown, key: string): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function lineValue(prompt: string, key: string): string | undefined {
  const values = [...prompt.matchAll(new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, "gmu"))];
  return values.length === 1 ? values[0]![1] : undefined;
}

function hasReviewEvidence(prompt: string): boolean {
  if (lineValue(prompt, "canonical_validation_exit") !== "0") return false;
  const rawTags = lineValue(prompt, "risk_tags");
  if (rawTags === undefined || !/^\[[^\[\]]+\]$/u.test(rawTags)) return false;
  const tags = rawTags.slice(1, -1).split(",").map((tag) => tag.trim());
  return tags.length > 0 && tags.every((tag) => tag.length > 0) &&
    new Set(tags).size === tags.length && tags.every(isSourceReviewRiskTag);
}

function freshState(): FastLaneTurnState {
  return {
    advisorDispatches: 0,
    backlogDrain: false,
    continuationPending: false,
    reviewCandidates: new Map(),
    reviewsLocked: false,
    scoutDispatches: 0,
    totalWorkerDispatches: 0,
    workerLimit: 1,
    workerDispatches: 0,
  };
}

function lockedState(): FastLaneTurnState {
  return {
    advisorDispatches: 2,
    backlogDrain: false,
    continuationPending: false,
    reviewCandidates: new Map(),
    reviewsLocked: true,
    scoutDispatches: 1,
    totalWorkerDispatches: 1,
    workerLimit: 1,
    workerDispatches: 1,
  };
}

function fallbackBasis(prompt: string): string {
  return prompt.replace(/\r\n?/gu, "\n")
    .split("\n")
    .filter((line) => !/^\s*fallback_retry\s*:\s*true\s*$/u.test(line))
    .join("\n")
    .trimEnd();
}

function reviewCandidateBasis(prompt: string): string {
  const explicit = lineValue(prompt, "candidate_id") ?? lineValue(prompt, "candidateId") ??
    lineValue(prompt, "task_id");
  if (explicit !== undefined) return `id:${explicit}`;
  return `artifact:${fallbackBasis(prompt).split("\n")
    .filter((line) => !/^\s*review_phase\s*:/u.test(line))
    .join("\n")}`;
}

export class FastLaneController {
  private readonly sessions = new Map<string, FastLaneTurnState>();

  private setSession(sessionID: string, state: FastLaneTurnState): void {
    this.sessions.delete(sessionID);
    this.sessions.set(sessionID, state);
    while (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
  }

  beginTurn(sessionID: string, synthetic: boolean): void {
    if (synthetic) {
      const state = this.sessions.get(sessionID);
      if (state === undefined) {
        this.setSession(sessionID, lockedState());
      } else if (state.backlogDrain && state.continuationPending) {
        state.advisorDispatches = 0;
        delete state.advisorPrompt;
        state.continuationPending = false;
        state.reviewCandidates.clear();
        state.reviewsLocked = false;
        state.scoutDispatches = 0;
        state.workerDispatches = 0;
      }
      return;
    }
    this.setSession(sessionID, freshState());
  }

  forget(sessionID: string): void {
    this.sessions.delete(sessionID);
  }

  manualCompactionForbidden(sessionID: string): boolean {
    const state = this.sessions.get(sessionID);
    return state !== undefined &&
      (!state.backlogDrain || state.totalWorkerDispatches >= state.workerLimit);
  }

  terminalInstructionRequired(sessionID: string): boolean {
    const state = this.sessions.get(sessionID);
    return state !== undefined && !state.backlogDrain && (
      state.workerDispatches > 0 || state.scoutDispatches > 0 || state.advisorDispatches > 0 ||
      state.reviewCandidates.size > 0
    );
  }

  backlogDrainEnabled(sessionID: string): boolean {
    return this.sessions.get(sessionID)?.backlogDrain === true;
  }

  backlogContinuationAllowed(sessionID: string): boolean {
    const state = this.sessions.get(sessionID);
    return state?.backlogDrain === true && state.workerDispatches === 1 &&
      state.totalWorkerDispatches < state.workerLimit && !state.continuationPending;
  }

  enableBacklogDrain(sessionID: string, maxUnits: number): void {
    const state = this.sessions.get(sessionID);
    if (state === undefined) throw new FastLaneDeniedError("TURN_STATE_REQUIRED");
    if (!Number.isInteger(maxUnits) || maxUnits < 4 || maxUnits > 11) {
      throw new FastLaneDeniedError("BACKLOG_DRAIN_INVALID");
    }
    if (state.backlogDrain || state.totalWorkerDispatches > 0) {
      throw new FastLaneDeniedError("BACKLOG_DRAIN_TOO_LATE");
    }
    state.backlogDrain = true;
    state.workerLimit = maxUnits;
  }

  continuationQueued(sessionID: string): void {
    const state = this.sessions.get(sessionID);
    if (this.backlogContinuationAllowed(sessionID) && state !== undefined) {
      state.continuationPending = true;
    }
  }

  beforeTool(sessionID: string, tool: string, args: unknown, options: FastLaneToolOptions = {}): void {
    const state = this.sessions.get(sessionID);
    if (state === undefined) {
      if (tool === "task" || MANUAL_COMPACTION_TOOLS.has(tool)) {
        throw new FastLaneDeniedError("TURN_STATE_REQUIRED");
      }
      return;
    }
    if (MANUAL_COMPACTION_TOOLS.has(tool)) {
      if (!this.backlogContinuationAllowed(sessionID)) {
        throw new FastLaneDeniedError("MANUAL_COMPACTION_FORBIDDEN");
      }
      return;
    }
    if (tool !== "task") return;

    const role = taskArgument(args, "subagent_type");
    const prompt = taskArgument(args, "prompt") ?? "";
    if (role === "dog-worker") {
      if (state.workerDispatches >= 1 || state.totalWorkerDispatches >= state.workerLimit) {
        throw new FastLaneDeniedError("WORKER_LIMIT");
      }
      state.workerDispatches += 1;
      state.totalWorkerDispatches += 1;
      return;
    }
    if (role === "dog-scout") {
      if (state.workerDispatches > 0) throw new FastLaneDeniedError("SCOUT_TOO_LATE");
      const gap = lineValue(prompt, "missing_evidence_code");
      if (gap === undefined || !GAP_CODES.has(gap)) throw new FastLaneDeniedError("SCOUT_GAP_REQUIRED");
      if (state.scoutDispatches >= 1) throw new FastLaneDeniedError("SCOUT_LIMIT");
      state.scoutDispatches += 1;
      return;
    }
    if (role === "dog-reviewer") {
      if (!hasReviewEvidence(prompt)) throw new FastLaneDeniedError("REVIEW_EVIDENCE_REQUIRED");
      const requestedPhase = lineValue(prompt, "review_phase");
      const phase = requestedPhase === "final" ? "initial" : requestedPhase;
      if (phase !== "initial" && phase !== "verification") {
        throw new FastLaneDeniedError("REVIEW_PHASE_INVALID");
      }
      if (state.reviewsLocked) throw new FastLaneDeniedError("REVIEW_LIMIT");
      const candidateKey = reviewCandidateBasis(prompt);
      let candidate = state.reviewCandidates.get(candidateKey);
      if (candidate === undefined) {
        if (state.reviewCandidates.size >= MAX_REVIEW_CANDIDATES) {
          throw new FastLaneDeniedError("REVIEW_LIMIT");
        }
        candidate = { initialDispatches: 0, verificationDispatches: 0 };
        state.reviewCandidates.set(candidateKey, candidate);
      }
      const retry = lineValue(prompt, "fallback_retry");
      const count = phase === "initial" ? candidate.initialDispatches : candidate.verificationDispatches;
      const previousPrompt = phase === "initial" ? candidate.initialPrompt : candidate.verificationPrompt;
      if (phase === "initial" && candidate.verificationDispatches > 0) {
        throw new FastLaneDeniedError("REVIEW_PHASE_INVALID");
      }
      if (phase === "verification" && candidate.initialDispatches === 0) {
        throw new FastLaneDeniedError("REVIEW_PHASE_INVALID");
      }
      if ((count === 0 && retry !== undefined) || (count === 1 && retry !== "true")) {
        throw new FastLaneDeniedError("CONSULTATION_RETRY_INVALID");
      }
      if (count === 1 && options.consultationFallbackAuthorized !== true) {
        throw new FastLaneDeniedError("CONSULTATION_RETRY_UNAUTHORIZED");
      }
      if (count === 1 && previousPrompt !== fallbackBasis(prompt)) {
        throw new FastLaneDeniedError("CONSULTATION_RETRY_MISMATCH");
      }
      if (count >= 2) throw new FastLaneDeniedError("REVIEW_LIMIT");
      if (phase === "initial") {
        candidate.initialPrompt ??= fallbackBasis(prompt);
        candidate.initialDispatches += 1;
      } else {
        candidate.verificationPrompt ??= fallbackBasis(prompt);
        candidate.verificationDispatches += 1;
      }
      return;
    }
    if (role === "dog-advisor") {
      const trigger = lineValue(prompt, "strategy_trigger");
      if (trigger === undefined || !STRATEGY_TRIGGER_SET.has(trigger)) {
        throw new FastLaneDeniedError("ADVISOR_TRIGGER_REQUIRED");
      }
      const retry = lineValue(prompt, "fallback_retry");
      if ((state.advisorDispatches === 0 && retry !== undefined) ||
        (state.advisorDispatches === 1 && retry !== "true")) {
        throw new FastLaneDeniedError("CONSULTATION_RETRY_INVALID");
      }
      if (state.advisorDispatches === 1 && options.consultationFallbackAuthorized !== true) {
        throw new FastLaneDeniedError("CONSULTATION_RETRY_UNAUTHORIZED");
      }
      if (state.advisorDispatches === 1 && state.advisorPrompt !== fallbackBasis(prompt)) {
        throw new FastLaneDeniedError("CONSULTATION_RETRY_MISMATCH");
      }
      if (state.advisorDispatches >= 2) throw new FastLaneDeniedError("ADVISOR_LIMIT");
      state.advisorPrompt ??= fallbackBasis(prompt);
      state.advisorDispatches += 1;
      return;
    }
    throw new FastLaneDeniedError("ROLE_FORBIDDEN");
  }
}
