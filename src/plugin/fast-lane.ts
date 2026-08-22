import { isSourceReviewRiskTag, STRATEGY_TRIGGERS } from "../core/consultation.js";

const MAX_SESSIONS = 256;
const GAP_CODES = new Set(["manifest", "validation", "owner-risk"]);
const STRATEGY_TRIGGER_SET = new Set<string>(STRATEGY_TRIGGERS);
const MANUAL_COMPACTION_TOOLS = new Set(["compact_and_continue", "sortie_compact_and_continue"]);
export const BACKLOG_DRAIN_CAPABILITY = "sortie_enable_backlog_drain";

export type FastLaneDenialCode =
  | "TURN_STATE_REQUIRED"
  | "ROLE_FORBIDDEN"
  | "WORKER_LIMIT"
  | "WORKER_RESUME_INVALID"
  | "SCOUT_GAP_REQUIRED"
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
  advisorRequests: Map<string, number>;
  reviewCandidates: Map<string, ReviewCandidateState>;
  reviewsLocked: boolean;
  scoutDispatches: number;
  backlogDrain: boolean;
  continuationPending: boolean;
  dispatchLocked: boolean;
  parallelMode: boolean;
  parallelWorkerLimit: number;
  totalWorkerDispatches: number;
  workerLimit: number;
  workerDispatches: number;
  workerInFlight: boolean;
  workerResumeSessionID?: string;
  workerResumeTaskID?: string;
  workerResumeUsed: boolean;
  workerTaskID?: string;
}

interface ReviewCandidateState {
  initialPrompts: Set<string>;
  verificationPrompts: Set<string>;
  fallbackRetries: Set<string>;
}

export interface FastLaneToolOptions {
  readonly consultationFallbackAuthorized?: boolean;
  readonly parallelWorkerAlreadyBound?: boolean;
  readonly parallelWorkerAuthorized?: boolean;
}

function taskArgument(args: unknown, key: string): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function lineValue(prompt: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const values = [...prompt.matchAll(new RegExp(`^\\s*${escapedKey}\\s*:\\s*(.+?)\\s*$`, "gmu"))];
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
    advisorRequests: new Map(),
    backlogDrain: false,
    continuationPending: false,
    dispatchLocked: false,
    parallelMode: false,
    parallelWorkerLimit: 1,
    reviewCandidates: new Map(),
    reviewsLocked: false,
    scoutDispatches: 0,
    totalWorkerDispatches: 0,
    workerLimit: 1,
    workerDispatches: 0,
    workerInFlight: false,
    workerResumeUsed: false,
  };
}

function lockedState(): FastLaneTurnState {
  return {
    advisorRequests: new Map(),
    backlogDrain: false,
    continuationPending: false,
    dispatchLocked: true,
    parallelMode: false,
    parallelWorkerLimit: 1,
    reviewCandidates: new Map(),
    reviewsLocked: true,
    scoutDispatches: 1,
    totalWorkerDispatches: 1,
    workerLimit: 1,
    workerDispatches: 1,
    workerInFlight: false,
    workerResumeUsed: true,
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
        state.advisorRequests.clear();
        state.continuationPending = false;
        state.reviewCandidates.clear();
        state.reviewsLocked = false;
        state.scoutDispatches = 0;
        state.workerDispatches = 0;
        state.workerInFlight = false;
        delete state.workerResumeSessionID;
        delete state.workerResumeTaskID;
        state.workerResumeUsed = false;
        delete state.workerTaskID;
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
      state.workerDispatches > 0 || state.scoutDispatches > 0 || state.advisorRequests.size > 0 ||
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
    if (!Number.isSafeInteger(maxUnits) || maxUnits < 1) {
      throw new FastLaneDeniedError("BACKLOG_DRAIN_INVALID");
    }
    if (state.backlogDrain || state.totalWorkerDispatches > 0) {
      throw new FastLaneDeniedError("BACKLOG_DRAIN_TOO_LATE");
    }
    state.backlogDrain = true;
    state.workerLimit = maxUnits;
  }

  enableParallelDispatch(
    sessionID: string,
    maxWorkers: number,
    dispatched: number,
    running = dispatched,
    totalTasks = maxWorkers,
  ): void {
    const state = this.sessions.get(sessionID);
    if (state === undefined) throw new FastLaneDeniedError("TURN_STATE_REQUIRED");
    if (state.backlogDrain || !Number.isInteger(maxWorkers) || maxWorkers < 2 || maxWorkers > 3 ||
      !Number.isInteger(totalTasks) || totalTasks < maxWorkers || totalTasks > 3 ||
      !Number.isInteger(dispatched) || dispatched < 0 || dispatched > totalTasks ||
      !Number.isInteger(running) || running < 0 || running > maxWorkers ||
      (state.totalWorkerDispatches > 0 && state.workerLimit !== totalTasks)) {
      throw new FastLaneDeniedError("WORKER_LIMIT");
    }
    state.parallelWorkerLimit = maxWorkers;
    state.parallelMode = true;
    state.workerLimit = totalTasks;
    state.workerDispatches = running;
    state.totalWorkerDispatches = dispatched;
  }

  continuationQueued(sessionID: string): void {
    const state = this.sessions.get(sessionID);
    if (this.backlogContinuationAllowed(sessionID) && state !== undefined) {
      state.continuationPending = true;
    }
  }

  authorizeRecoverableWorkerResume(sessionID: string, taskID: string, childSessionID: string): boolean {
    const state = this.sessions.get(sessionID);
    if (state === undefined || state.dispatchLocked || state.workerDispatches < 1 || state.workerResumeUsed ||
      state.workerTaskID === undefined || taskID !== state.workerTaskID) return false;
    state.workerResumeSessionID = childSessionID;
    state.workerResumeTaskID = state.workerTaskID;
    return true;
  }

  workerCompleted(sessionID: string): void {
    const state = this.sessions.get(sessionID);
    if (state !== undefined) state.workerInFlight = false;
  }

  beforeTool(sessionID: string, tool: string, args: unknown, options: FastLaneToolOptions = {}): string | undefined {
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
    if (state.dispatchLocked) throw new FastLaneDeniedError("TURN_STATE_REQUIRED");

    const role = taskArgument(args, "subagent_type");
    const prompt = taskArgument(args, "prompt") ?? "";
    if (role === "dog-worker") {
      const taskID = lineValue(prompt, "task_id");
      if (state.workerDispatches >= 1 && state.workerResumeTaskID !== undefined &&
        state.workerResumeSessionID !== undefined &&
        !state.workerResumeUsed && lineValue(prompt, "mode") === "same-task-resume" &&
        taskID === state.workerResumeTaskID &&
        taskArgument(args, "task_id") === state.workerResumeSessionID) {
        state.workerResumeUsed = true;
        state.workerInFlight = true;
        delete state.workerResumeSessionID;
        delete state.workerResumeTaskID;
        return taskArgument(args, "task_id");
      }
      if (lineValue(prompt, "mode") === "same-task-resume") {
        throw new FastLaneDeniedError("WORKER_RESUME_INVALID");
      }
      if (state.parallelMode) {
        if (options.parallelWorkerAuthorized !== true) throw new FastLaneDeniedError("WORKER_LIMIT");
        if (options.parallelWorkerAlreadyBound === true) {
          if (state.workerDispatches < 1 || state.workerDispatches > state.parallelWorkerLimit ||
            state.totalWorkerDispatches < 1 || state.totalWorkerDispatches > state.workerLimit) {
            throw new FastLaneDeniedError("WORKER_LIMIT");
          }
          state.workerInFlight = true;
          return;
        }
        if (state.workerDispatches >= state.parallelWorkerLimit || state.totalWorkerDispatches >= state.workerLimit) {
          throw new FastLaneDeniedError("WORKER_LIMIT");
        }
      } else if (state.backlogDrain &&
        (state.workerDispatches >= 1 || state.totalWorkerDispatches >= state.workerLimit)) {
        throw new FastLaneDeniedError("WORKER_LIMIT");
      } else if (state.workerInFlight) {
        throw new FastLaneDeniedError("WORKER_LIMIT");
      }
      state.workerDispatches += 1;
      state.totalWorkerDispatches += 1;
      state.workerInFlight = true;
      state.workerTaskID = taskID;
      state.workerResumeUsed = false;
      delete state.workerResumeSessionID;
      delete state.workerResumeTaskID;
      return;
    }
    if (role === "dog-scout") {
      const gap = lineValue(prompt, "missing_evidence_code");
      if (gap === undefined || !GAP_CODES.has(gap)) throw new FastLaneDeniedError("SCOUT_GAP_REQUIRED");
      state.scoutDispatches += 1;
      return;
    }
    if (role === "dog-reviewer") {
      if (!hasReviewEvidence(prompt)) throw new FastLaneDeniedError("REVIEW_EVIDENCE_REQUIRED");
      const requestedPhase = lineValue(prompt, "review_phase");
      if (requestedPhase !== "initial" && requestedPhase !== "verification" && requestedPhase !== "final") {
        throw new FastLaneDeniedError("REVIEW_PHASE_INVALID");
      }
      if (state.reviewsLocked) throw new FastLaneDeniedError("REVIEW_LIMIT");
      const candidateKey = reviewCandidateBasis(prompt);
      let candidate = state.reviewCandidates.get(candidateKey);
      if (candidate === undefined) {
        candidate = { initialPrompts: new Set(), verificationPrompts: new Set(), fallbackRetries: new Set() };
        state.reviewCandidates.set(candidateKey, candidate);
      }
      const phase = requestedPhase === "final"
        ? candidate.initialPrompts.size === 0 ? "initial" : "verification"
        : requestedPhase;
      const retry = lineValue(prompt, "fallback_retry");
      const basis = fallbackBasis(prompt);
      const prompts = phase === "initial" ? candidate.initialPrompts : candidate.verificationPrompts;
      if (phase === "initial" && candidate.verificationPrompts.size > 0) {
        throw new FastLaneDeniedError("REVIEW_PHASE_INVALID");
      }
      if (phase === "verification" && candidate.initialPrompts.size === 0) {
        throw new FastLaneDeniedError("REVIEW_PHASE_INVALID");
      }
      if (retry !== undefined) {
        if (retry !== "true" || !prompts.has(basis)) throw new FastLaneDeniedError("CONSULTATION_RETRY_INVALID");
        if (candidate.fallbackRetries.has(`${phase}\0${basis}`)) throw new FastLaneDeniedError("REVIEW_LIMIT");
        if (options.consultationFallbackAuthorized !== true) {
          throw new FastLaneDeniedError("CONSULTATION_RETRY_UNAUTHORIZED");
        }
        candidate.fallbackRetries.add(`${phase}\0${basis}`);
      } else {
        if (prompts.has(basis)) throw new FastLaneDeniedError("CONSULTATION_RETRY_INVALID");
        if (phase === "initial" && candidate.initialPrompts.size > 0) {
          throw new FastLaneDeniedError("REVIEW_PHASE_INVALID");
        }
        prompts.add(basis);
      }
      return;
    }
    if (role === "dog-advisor") {
      const trigger = lineValue(prompt, "strategy_trigger");
      if (trigger === undefined || !STRATEGY_TRIGGER_SET.has(trigger)) {
        throw new FastLaneDeniedError("ADVISOR_TRIGGER_REQUIRED");
      }
      const basis = fallbackBasis(prompt);
      const dispatches = state.advisorRequests.get(basis) ?? 0;
      const retry = lineValue(prompt, "fallback_retry");
      if ((dispatches === 0 && retry !== undefined) || (dispatches === 1 && retry !== "true")) {
        throw new FastLaneDeniedError("CONSULTATION_RETRY_INVALID");
      }
      if (dispatches === 1 && options.consultationFallbackAuthorized !== true) {
        throw new FastLaneDeniedError("CONSULTATION_RETRY_UNAUTHORIZED");
      }
      if (dispatches >= 2) throw new FastLaneDeniedError("ADVISOR_LIMIT");
      state.advisorRequests.set(basis, dispatches + 1);
      return;
    }
    throw new FastLaneDeniedError("ROLE_FORBIDDEN");
  }
}
