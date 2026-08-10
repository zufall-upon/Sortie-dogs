/**
 * Bounded batch continuation for the canonical Sortie-dogs coordinator.
 *
 * The coordinator asset requires a continuation loop: after a terminal unit and its checkpoint it
 * must compact and resume the same root session on the next independent unit. That policy is only
 * a policy; without a runtime capability the coordinator has nothing to invoke and silently stops
 * after the first unit. This module supplies that capability.
 *
 * Identity is the whole safety story. Continuation re-prompts a session on the caller's behalf, so
 * it may only ever target the configured coordinator agent running as a root session. A child
 * session is never promoted to root and a different coordinator is never adopted; every unresolved
 * identity fails closed into "no automatic continuation" rather than into a guess.
 */

import { openCodeModel } from "./model-routing-hook.js";
import type { ModelTarget } from "./model-routing.js";

/** Plugin tool name the coordinator asset names as the direct continuation capability. */
export const CONTINUATION_CAPABILITY = "sortie_compact_and_continue";
/** Fallback marker, used only when the direct capability is unavailable. */
export const CONTINUATION_MARKER = "<!-- SORTIE_CONTINUE -->";
/** Terminal marker: compact the batch without resuming it. */
export const ROLLOVER_MARKER = "<!-- SORTIE_COMPACT -->";
/** First token of the synthetic resume prompt, so the coordinator can recognize its own resume. */
export const AUTO_CONTINUE_PREFIX = "SORTIE_AUTO_CONTINUE";
const TOOL_REQUESTED_REPORT =
  "Tool-requested Sortie rollover. Preserve task identity, both manifests, validation history, " +
  "batch counters, blocker state, and the exact next action from the latest messages.";
/** First line the rollover summary must emit, mirroring the batch target of three attempts. */
export const ROLLOVER_TOKEN = "SORTIE_ROLLOVER_COMPACTED";
export const DEFAULT_MAX_AUTO_CONTINUES = 2;

/**
 * A coordinator that exhausted its step budget reports remaining work instead of continuing. That
 * report is a continuation request in every respect except the marker, so it is treated as one.
 * The pattern stays deliberately narrow: a step-exhaustion statement followed by remaining work.
 */
export const STEP_EXHAUSTED_PATTERN =
  /(?:最大step(?:s|数)?(?:に)?到達|step(?:s)?\s*(?:limit|budget)\s*(?:reached|exhausted)|maximum\s+steps?\s+reached)[\s\S]{0,2500}(?:残作業|未完了|未完|次action|next\s+action|remaining\s+work)/iu;

const MAX_TRACKED_SESSIONS = 256;

const DEFAULT_TIMINGS = {
  /** Compaction is expensive; one rollover per minute per session is the canonical ceiling. */
  cooldownMilliseconds: 60_000,
  /** Let the new summary's token state settle before a fresh turn can trigger overflow compaction. */
  settleMilliseconds: 1_500,
  /** A delayed retry backs up the immediate rollover kick and the normal session-idle path. */
  scheduleMilliseconds: 30_000,
  scheduleAttempts: 2,
} as const;

export type ContinuationTimings = typeof DEFAULT_TIMINGS;

export type ContinuationRejection =
  | "identity-unavailable"
  | "child-session"
  | "agent-mismatch"
  | "capability-unavailable"
  | "continuation-disabled"
  | "limit-reached"
  | "pending-autocontinue"
  | "summarize-model-unavailable";

export interface ContinuationIdentity {
  readonly agent?: string | undefined;
  readonly parentID?: string | undefined;
}

export interface ContinuationResolution {
  /** Queue a compaction of the source session. */
  readonly compact: boolean;
  /** Resume the same root session after that compaction. */
  readonly continue: boolean;
  readonly reason?: ContinuationRejection;
}

export interface ContinuationResolutionInput {
  readonly identity: ContinuationIdentity | undefined;
  readonly configuredAgent: string | undefined;
  readonly configuredCapability: string | undefined;
  readonly requestedCapability: string;
  readonly enabled: boolean;
  /** Continuations already granted to this session. */
  readonly attempts: number;
  readonly maxAutoContinues: number;
  readonly pendingAutoContinue: boolean;
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function reject(reason: ContinuationRejection): ContinuationResolution {
  return { compact: false, continue: false, reason };
}

/**
 * The single resolver every continuation path shares: the direct tool, the marker fallback, and the
 * step-exhausted fallback. Keeping it pure means the identity policy is provable without a host.
 */
export function resolveContinuation(input: ContinuationResolutionInput): ContinuationResolution {
  if (!input.enabled) return reject("continuation-disabled");
  if (!nonEmpty(input.configuredAgent) || !nonEmpty(input.configuredCapability)) {
    return reject("capability-unavailable");
  }
  if (input.requestedCapability !== input.configuredCapability) return reject("capability-unavailable");
  if (input.identity === undefined || !nonEmpty(input.identity.agent)) return reject("identity-unavailable");
  if (nonEmpty(input.identity.parentID)) return reject("child-session");
  if (input.identity.agent !== input.configuredAgent) return reject("agent-mismatch");
  if (input.pendingAutoContinue) return reject("pending-autocontinue");
  // A batch that reached its continuation ceiling still compacts; it just stops resuming itself.
  if (input.attempts >= input.maxAutoContinues) {
    return { compact: true, continue: false, reason: "limit-reached" };
  }
  return { compact: true, continue: true };
}

/** The subset of the OpenCode SDK client continuation depends on. */
export interface ContinuationClient {
  readonly session?: {
    readonly get?: (request: { path: { id: string } }) => Promise<unknown>;
    readonly summarize?: (request: {
      path: { id: string };
      query?: { directory?: string };
      body: { providerID: string; modelID: string };
    }) => Promise<unknown>;
    readonly promptAsync?: (request: {
      path: { id: string };
      query?: { directory?: string };
      body: {
        agent: string;
        parts: ReadonlyArray<{ type: "text"; synthetic: true; text: string }>;
      };
    }) => Promise<unknown>;
  };
}

export interface ContinuationPolicy {
  readonly enabled: boolean;
  readonly agent: string;
  readonly capability: string;
  readonly maxAutoContinues: number;
  /** Absent means the host chooses the compaction model; this package never pins one. */
  readonly summarizeModel?: ModelTarget | undefined;
}

/**
 * Configuration loads lazily, but the tool must be registered when the plugin is constructed. A
 * resolver lets the registered capability read the effective policy at call time instead of
 * freezing whatever was known at construction.
 */
export type ContinuationPolicySource = ContinuationPolicy | (() => ContinuationPolicy);

/**
 * The plugin already learns which sessions run the coordinator as a root from its own message hook.
 * Trusting that observation first keeps continuation working on a host whose session lookup answers
 * without an agent field, or answers for a different directory, instead of failing silently.
 */
export type LocalIdentitySource = (sessionID: string) => ContinuationIdentity | undefined;

export type RolloverAbort =
  | "identity-unavailable"
  | "child-session"
  | "summarize-unavailable"
  | "summarize-model-unavailable"
  | "retries-exhausted"
  | "terminal-identity-rejected"
  | "compaction-summary-malformed";

export interface ContinuationToolContext {
  readonly sessionID: string;
  readonly agent?: string | undefined;
}

export interface ContinuationTool {
  readonly name: string;
  readonly description: string;
  execute(args: Record<string, never>, context: ContinuationToolContext): Promise<string>;
}

export interface ContinuationHooks {
  readonly tool: ContinuationTool;
  textComplete(input: { sessionID: string }, output: { text: string }): Promise<void>;
  sessionCompacting(
    input: { sessionID: string },
    output: { context?: string[]; prompt?: string },
  ): Promise<void>;
  sessionCompacted(sessionID: string): Promise<void>;
  compactionAutoContinue(
    input: { sessionID: string; overflow?: boolean },
    output: { enabled: boolean },
  ): Promise<void>;
  observeModel(sessionID: string, model: { providerID: string; modelID: string }, synthetic?: boolean): void;
  blocksTool(sessionID: string): boolean;
  sessionIdle(sessionID: string): Promise<void>;
  forgetSession(sessionID: string): void;
}

const ROLLOVER_PROMPT = [
  `Your very first output line must be exactly: ${ROLLOVER_TOKEN}`,
  "Write nothing before that line: no greeting, no explanation, no restatement of this instruction.",
  "You have no tools here. Never call a tool and never emit tool-call markup, XML-like tags, or function-call syntax. Output plain text only.",
  "Output the template below. Keep the first line and every heading exactly as written, in this order.",
  "Write the content in Japanese. Every content line starts with '- ' and stays on one short line.",
  "Replace each <...> placeholder with real content. Never output the angle brackets themselves.",
  "If a section has nothing, write exactly '- なし'. Never delete a heading.",
  "At most 2 content lines per section. Keep the whole output under 1200 characters.",
  "Copy task identity, manifest paths, commands, exit codes, and counter values character-for-character.",
  "The coordinator final report immediately before compaction is the newest source of truth. Its outcomes and next action override older context.",
  "Never list a unit as uncommitted or next when that final report says it was committed or completed.",
  "Drop the finished unit's conversation, raw logs, diffs, and tool output.",
  "Preserve task identity, every accepted fact, both manifests, ordered validation history, batchTarget, batchAttempted, batchCommitted, batchReconciled, blocker state, and the exact next action. If a value is absent, write なし; never guess one.",
  "Never write credentials, API keys, tokens, personal data, or source code.",
  "Never output an HTML comment.",
  "",
  ROLLOVER_TOKEN,
  "",
  "## 未達のユーザー要求",
  "- <まだ満たされていない明示要求>",
  "",
  "## task identity と制約",
  "- <task_id・候補識別子・project root。該当なしはなし>",
  "- <守り続ける制約と確定済みの受け入れ基準>",
  "",
  "## manifest",
  "- source_manifest: <exact entries または none>",
  "- operation_manifest: <exact path または none>",
  "",
  "## validation履歴",
  "- <command> | exit <code> | <fingerprint>",
  "",
  "## batch counters",
  "- batchTarget: <n> / batchAttempted: <n> / batchCommitted: <n> / batchReconciled: <n>",
  "",
  "## 未解決blocker",
  "- <blocker> | <解消条件>",
  "",
  "## 次action",
  "- <次に着手する1手順>",
].join("\n");

interface SessionState {
  /** Continuations already granted to this session. */
  attempts: number;
  pendingRollover: boolean;
  /** Set only when the queued rollover must resume the session afterwards. */
  continueReport?: string | undefined;
  /** A deliberate terminal marker starts a fresh batch; a limit-reached compaction does not. */
  resetAttemptsAfterCompaction: boolean;
  /** The terminal unit at the continuation ceiling was already compacted. */
  limitCompacted: boolean;
  /** Latest authoritative coordinator report, handed to the compaction prompt. */
  latestReport?: string | undefined;
  /** Latest non-compaction coordinator text observed during the current user turn. */
  latestCoordinatorReport?: string | undefined;
  /** A rollover is executing right now. */
  active: boolean;
  /** Summarize succeeded; a failed synthetic resume must not summarize the same state again. */
  compactedRollover: boolean;
  /** A rollover-shaped compaction prompt is still owed to the host. */
  promptPending: boolean;
  /** Latest coordinator model; the host requires it in every summarize payload. */
  model?: { providerID: string; modelID: string } | undefined;
  /** Coordinator user turns observed by chat.message. */
  turnRevision: number;
  /** Turn revision owned by the active rollover. */
  activeRevision: number;
  /** A newer turn became idle while an older rollover was still active. */
  idleDeferred: boolean;
  /** Invalidates retry timers when a newer rollover supersedes their state. */
  rolloverEpoch: number;
  /** Epoch currently issuing its resume from the host's compacted event. */
  resumeIssuingEpoch?: number | undefined;
  /** Epoch whose resume was accepted before the summarize request returned. */
  resumeIssuedEpoch?: number | undefined;
  /** Resume attempts made for the current epoch, bounded by the configured scheduler budget. */
  resumeAttempts: number;
  /** This compaction belongs to Sortie until the resumed turn is observed. */
  ownsHostContinuation: boolean;
  /** Rollover epoch whose compaction prompt hook has started. */
  compactingEpoch?: number | undefined;
  /** Prevents idle fallback from racing an explicit marker being resolved. */
  textCompleting: boolean;
  /** The direct capability already ran in this turn, so the marker must not run too. */
  directUsed: boolean;
  lastRollover?: number | undefined;
  cooldownTimer?: unknown;
  touched: number;
}

function unrefTimer(timer: unknown): unknown {
  if (typeof (timer as { unref?: () => unknown } | undefined)?.unref === "function") {
    (timer as { unref: () => unknown }).unref();
  }
  return timer;
}

function clearTimer(timer: unknown): void {
  if (timer !== undefined) clearTimeout(timer as Parameters<typeof clearTimeout>[0]);
}

function sessionInfo(response: unknown): ContinuationIdentity | undefined {
  const payload = response !== null && typeof response === "object" && "data" in response
    ? (response as { data?: unknown }).data
    : response;
  if (payload === null || typeof payload !== "object") return undefined;
  const record = payload as { agent?: unknown; parentID?: unknown };
  return {
    agent: typeof record.agent === "string" ? record.agent : undefined,
    parentID: typeof record.parentID === "string" ? record.parentID : undefined,
  };
}

/**
 * Build the continuation runtime. Every hook fails closed: an unreadable session, an absent client,
 * or a rejected identity leaves the coordinator exactly where it was, with manual continuation
 * still available to the user.
 */
export function createContinuationHooks(
  client: ContinuationClient | undefined,
  directory: string,
  policySource: ContinuationPolicySource,
  timings: ContinuationTimings = DEFAULT_TIMINGS,
  localIdentity?: LocalIdentitySource,
): ContinuationHooks {
  const sessions = new Map<string, SessionState>();
  const warned = new Set<string>();

  /**
   * A rollover that cannot start is otherwise indistinguishable from a coordinator that never asked
   * for one, so every abort names its own reason exactly once per session.
   */
  function warnRollover(sessionID: string, reason: RolloverAbort): void {
    const key = `${sessionID}:${reason}`;
    if (warned.has(key)) return;
    if (warned.size >= MAX_TRACKED_SESSIONS) warned.clear();
    warned.add(key);
    console.warn(`[sortie-continuation] rollover skipped ${sessionID}: ${reason}`);
  }

  function policy(): ContinuationPolicy {
    return typeof policySource === "function" ? policySource() : policySource;
  }

  function pruneSessions(): void {
    while (sessions.size > MAX_TRACKED_SESSIONS) {
      let oldestID: string | undefined;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [id, state] of sessions) {
        if (state.touched < oldest) {
          oldest = state.touched;
          oldestID = id;
        }
      }
      if (oldestID === undefined) return;
      forgetSession(oldestID);
    }
  }

  function stateFor(sessionID: string): SessionState {
    const existing = sessions.get(sessionID);
    if (existing !== undefined) {
      existing.touched = Date.now();
      return existing;
    }
    const created: SessionState = {
      attempts: 0,
      pendingRollover: false,
      resetAttemptsAfterCompaction: false,
      limitCompacted: false,
      active: false,
      compactedRollover: false,
      promptPending: false,
      turnRevision: 0,
      activeRevision: -1,
      idleDeferred: false,
      rolloverEpoch: 0,
      resumeAttempts: 0,
      ownsHostContinuation: false,
      textCompleting: false,
      directUsed: false,
      touched: Date.now(),
    };
    sessions.set(sessionID, created);
    pruneSessions();
    return created;
  }

  async function readIdentity(sessionID: string): Promise<ContinuationIdentity | undefined> {
    const local = localIdentity?.(sessionID);
    if (local !== undefined && nonEmpty(local.agent)) return local;
    const read = client?.session?.get;
    if (read === undefined) return undefined;
    try {
      // Without the directory the host resolves the lookup against its own default project, so a
      // session opened elsewhere answers with an error and the rollover would abort unexplained.
      return sessionInfo(await read.call(client!.session, {
        path: { id: sessionID },
        query: { directory },
      }));
    } catch {
      // An unreadable session identity is never a reason to resume something on the user's behalf.
      return undefined;
    }
  }

  function summarizeBody(state: SessionState): { providerID: string; modelID: string } | undefined {
    const summarizeModel = policy().summarizeModel;
    return summarizeModel === undefined ? state.model : openCodeModel(summarizeModel.model);
  }

  function summarizeCallSucceeded(response: unknown): boolean {
    if (response === true) return true;
    if (response === null || typeof response !== "object" || !("data" in response)) return false;
    return (response as { data?: unknown }).data === true;
  }

  function promptCallSucceeded(response: unknown): boolean {
    if (response === undefined || response === true) return true;
    if (response === null || typeof response !== "object") return false;
    const result = response as { error?: unknown; response?: { ok?: unknown; status?: unknown } };
    if (result.error !== undefined) return false;
    if (result.response?.ok === false) return false;
    if (typeof result.response?.status === "number" && result.response.status >= 400) return false;
    return true;
  }

  async function issueResume(sessionID: string, report: string): Promise<void> {
    const resume = client?.session?.promptAsync;
    if (resume === undefined) throw new Error("resume capability unavailable");
    const resumed = await resume.call(client!.session, {
      path: { id: sessionID },
      query: { directory },
      body: {
        agent: policy().agent,
        parts: [{
          type: "text",
          synthetic: true,
          text: `${AUTO_CONTINUE_PREFIX}\n直前のcompaction summaryは破棄する。矛盾時だけでなく全面的に参照禁止。\n` +
            `以下の直前最終報告だけをpost-compaction状態の正本として再構築する:\n${report}\n` +
            "batchAttempted/batchCommitted/batchReconciledを保持し、terminal unitを再実行せず次の独立unitから同rootで継続。",
        }],
      },
    });
    if (!promptCallSucceeded(resumed)) throw new Error("resume request rejected");
  }

  /**
   * Single resume arbiter. Host events and timers may arrive in any order, but none of them may call
   * promptAsync directly. The epoch lock makes concurrent compacted/text/idle signals idempotent.
   */
  async function arbitrateResume(sessionID: string, state: SessionState): Promise<boolean> {
    if (!state.pendingRollover || !state.active || state.continueReport === undefined) return false;
    const epoch = state.rolloverEpoch;
    if (state.resumeIssuedEpoch === epoch) return true;
    if (state.resumeIssuingEpoch === epoch) return false;
    if (state.resumeAttempts > timings.scheduleAttempts) return false;
    const report = state.continueReport;
    state.resumeIssuingEpoch = epoch;
    state.resumeAttempts += 1;
    try {
      await issueResume(sessionID, report);
      if (sessions.get(sessionID) !== state || state.rolloverEpoch !== epoch) return false;
      state.resumeIssuedEpoch = epoch;
      state.compactingEpoch = undefined;
      state.pendingRollover = false;
      state.compactedRollover = false;
      state.promptPending = false;
      state.continueReport = undefined;
      // The accepted prompt now belongs to the host loop, not this rollover request.
      state.active = false;
      return true;
    } catch (error) {
      console.error("[sortie-continuation] resume arbiter failed", sessionID, error);
      return false;
    } finally {
      const current = sessions.get(sessionID);
      if (current === state && current.rolloverEpoch === epoch) {
        current.resumeIssuingEpoch = undefined;
      }
    }
  }

  async function runRollover(sessionID: string): Promise<boolean> {
    const state = sessions.get(sessionID);
    if (state === undefined || !state.pendingRollover || state.active) return false;
    const summarize = client?.session?.summarize;
    if (summarize === undefined) {
      warnRollover(sessionID, "summarize-unavailable");
      return false;
    }

    // Acquire the session lock before the first await so idle and fallback timers cannot overlap.
    state.active = true;
    const operationEpoch = state.rolloverEpoch;
    state.activeRevision = state.turnRevision;
    let compactionStarted = false;
    let compactionSucceeded = false;
    try {
      const cooldownRemaining = state.lastRollover === undefined || state.compactedRollover
        ? 0
        : timings.cooldownMilliseconds - (Date.now() - state.lastRollover);
      if (cooldownRemaining > 0) {
        if (state.cooldownTimer === undefined) {
          state.cooldownTimer = unrefTimer(setTimeout(() => {
            const current = sessions.get(sessionID);
            if (current !== undefined) current.cooldownTimer = undefined;
            void runRollover(sessionID);
          }, cooldownRemaining));
        }
        return false;
      }

      // A child session must never compact or resume its parent's batch.
      const identity = await readIdentity(sessionID);
      if (identity === undefined || !nonEmpty(identity.agent)) {
        warnRollover(sessionID, "identity-unavailable");
        return false;
      }
      if (nonEmpty(identity.parentID)) {
        warnRollover(sessionID, "child-session");
        return false;
      }
      if (!state.compactedRollover) {
        const body = summarizeBody(state);
        if (body === undefined) {
          warnRollover(sessionID, "summarize-model-unavailable");
          return false;
        }
        state.promptPending = true;
        compactionStarted = true;
        const summarizedResponse = await summarize.call(client!.session, {
          path: { id: sessionID },
          query: { directory },
          body,
        });
        if (!summarizeCallSucceeded(summarizedResponse)) throw new Error("summarize request rejected");
        compactionSucceeded = true;
        if (sessions.get(sessionID) !== state || state.rolloverEpoch !== operationEpoch) return true;
        // A successful summarize response means the host already ran the compaction prompt hook.
        // Clear the local lock even when another plugin instance handled that hook.
        state.promptPending = false;
        state.compactedRollover = true;
        state.lastRollover = Date.now();
      }
      if (
        state.resumeIssuingEpoch === operationEpoch ||
        state.resumeIssuedEpoch === operationEpoch
      ) {
        state.compactedRollover = false;
        return true;
      }
      const continueReport = state.continueReport;
      if (continueReport === undefined) {
        state.pendingRollover = false;
        state.compactedRollover = false;
        state.ownsHostContinuation = false;
        if (state.resetAttemptsAfterCompaction) state.attempts = 0;
        state.limitCompacted = !state.resetAttemptsAfterCompaction;
        state.resetAttemptsAfterCompaction = false;
        state.latestReport = undefined;
        return true;
      }

      await new Promise((settle) => setTimeout(settle, timings.settleMilliseconds));
      return await arbitrateResume(sessionID, state);
    } catch (error) {
      console.error("[sortie-continuation] rollover failed", sessionID, error);
      return false;
    } finally {
      const current = sessions.get(sessionID);
      if (current === state && current.rolloverEpoch === operationEpoch) {
        current.active = false;
        if (compactionStarted && !compactionSucceeded) {
          current.promptPending = false;
          current.compactingEpoch = undefined;
        }
        if (current.idleDeferred) {
          current.idleDeferred = false;
          queueMicrotask(() => { void handleSessionIdle(sessionID); });
        }
      }
    }
  }

  function scheduleRollover(sessionID: string, attempt = 0, epoch = sessions.get(sessionID)?.rolloverEpoch): void {
    unrefTimer(setTimeout(async () => {
      if (epoch === undefined || sessions.get(sessionID)?.rolloverEpoch !== epoch) return;
      const completed = await runRollover(sessionID);
      const state = sessions.get(sessionID);
      if (state?.rolloverEpoch !== epoch) return;
      if (!completed && (state?.cooldownTimer !== undefined || state?.active === true)) return;
      if (!completed && state?.pendingRollover === true && attempt < timings.scheduleAttempts) {
        scheduleRollover(sessionID, attempt + 1, epoch);
      } else if (!completed && state?.pendingRollover === true) {
        state.pendingRollover = false;
        state.compactedRollover = false;
        state.promptPending = false;
        state.continueReport = undefined;
        state.latestReport = undefined;
        state.ownsHostContinuation = false;
        warnRollover(sessionID, "retries-exhausted");
      }
    }, timings.scheduleMilliseconds * (attempt + 1)));
  }

  function queueRollover(
    sessionID: string,
    report: string,
    resume: boolean,
    resetAttemptsAfterCompaction = false,
  ): void {
    const state = stateFor(sessionID);
    state.pendingRollover = true;
    state.compactedRollover = false;
    state.rolloverEpoch += 1;
    state.resumeIssuingEpoch = undefined;
    state.resumeIssuedEpoch = undefined;
    state.resumeAttempts = 0;
    state.ownsHostContinuation = true;
    state.compactingEpoch = undefined;
    state.latestReport = report;
    state.continueReport = resume ? report : undefined;
    state.resetAttemptsAfterCompaction = resetAttemptsAfterCompaction;
    state.latestCoordinatorReport = undefined;
    if (resume) state.attempts += 1;
    const epoch = state.rolloverEpoch;
    // session.idle can be lost when a one-shot CLI host exits. Keep this zero-delay timer referenced
    // so the rollover reaches the host after the current plugin hook returns but before process exit.
    setTimeout(async () => {
      if (sessions.get(sessionID)?.rolloverEpoch !== epoch) return;
      await runRollover(sessionID);
      const current = sessions.get(sessionID);
      if (
        current?.pendingRollover === true && current.rolloverEpoch === epoch &&
        current.resumeIssuingEpoch !== epoch
      ) {
        scheduleRollover(sessionID, 0, epoch);
      }
    }, 0);
  }

  async function requestContinuation(
    sessionID: string,
    identity: ContinuationIdentity | undefined,
    report: string,
  ): Promise<ContinuationResolution> {
    const state = stateFor(sessionID);
    const active = policy();
    const resolution = resolveContinuation({
      identity,
      configuredAgent: active.agent,
      configuredCapability: active.capability,
      requestedCapability: active.capability,
      enabled: active.enabled,
      attempts: state.attempts,
      maxAutoContinues: active.maxAutoContinues,
      pendingAutoContinue: state.pendingRollover,
    });
    if (resolution.reason === "limit-reached" && state.limitCompacted) {
      return reject("limit-reached");
    }
    if (resolution.compact) queueRollover(sessionID, report, resolution.continue);
    return resolution;
  }

  function forgetSession(sessionID: string): void {
    const state = sessions.get(sessionID);
    if (state !== undefined) clearTimer(state.cooldownTimer);
    sessions.delete(sessionID);
  }

  const tool: ContinuationTool = {
    name: CONTINUATION_CAPABILITY,
    description:
      "Compact the coordinator session and continue the bounded batch on the next independent unit.",
    async execute(_args, context): Promise<string> {
      /*
       * A host that answers the session lookup without an agent field still knows the caller, so
       * the tool context supplies the identity while any reported parent link stays authoritative.
       */
      const reported = await readIdentity(context.sessionID);
      const identity: ContinuationIdentity | undefined = nonEmpty(reported?.agent)
        ? reported
        : nonEmpty(context.agent)
          ? { agent: context.agent, parentID: reported?.parentID }
          : reported;
      const state = stateFor(context.sessionID);
      const active = policy();
      const resolution = resolveContinuation({
        identity,
        configuredAgent: active.agent,
        configuredCapability: active.capability,
        requestedCapability: active.capability,
        enabled: active.enabled,
        attempts: state.attempts,
        maxAutoContinues: active.maxAutoContinues,
        // A tool call is the request itself, so an already pending rollover is the only conflict.
        pendingAutoContinue: state.pendingRollover,
      });
      if (resolution.reason === "limit-reached" && state.limitCompacted) {
        return "SORTIE_CONTINUATION_REJECTED: limit-reached";
      }
      if (!resolution.compact) return `SORTIE_CONTINUATION_REJECTED: ${resolution.reason}`;
      if (client?.session?.summarize === undefined) {
        return "SORTIE_CONTINUATION_REJECTED: capability-unavailable";
      }
      if (summarizeBody(state) === undefined) {
        return "SORTIE_CONTINUATION_REJECTED: summarize-model-unavailable";
      }
      // The direct capability and the marker fallback are mutually exclusive within one turn.
      state.directUsed = true;
      queueRollover(
        context.sessionID,
        state.latestCoordinatorReport ?? TOOL_REQUESTED_REPORT,
        resolution.continue,
      );
      return resolution.continue
        ? "SORTIE_COMPACT_AND_CONTINUE_QUEUED"
        : "SORTIE_COMPACT_QUEUED: auto-continue limit reached";
    },
  };

  return {
    tool,

    async textComplete(input, output): Promise<void> {
      const state = stateFor(input.sessionID);
      state.textCompleting = true;
      try {
        const trimmed = output.text.trimStart();
        const ownedCompactionSummary = state.compactingEpoch === state.rolloverEpoch &&
          (state.active || state.pendingRollover);
        if (ownedCompactionSummary) state.compactingEpoch = undefined;
        if (ownedCompactionSummary && !trimmed.startsWith(ROLLOVER_TOKEN)) {
          warnRollover(input.sessionID, "compaction-summary-malformed");
        }
        /*
         * One-shot CLI hosts can exit as soon as the compaction assistant finishes, before the
         * compacted event or summarize response. Its text-complete hook is the last awaited boundary
         * where the summary message already exists and a resume prompt can still join the same loop.
         */
        if (ownedCompactionSummary || trimmed.startsWith(ROLLOVER_TOKEN)) {
          await arbitrateResume(input.sessionID, state);
          if (state.resumeIssuedEpoch === state.rolloverEpoch) return;
        }
        if (
          !state.pendingRollover && !state.active && !state.promptPending &&
          trimmed.length > 0 && !trimmed.startsWith(ROLLOVER_TOKEN) &&
          !trimmed.startsWith(AUTO_CONTINUE_PREFIX)
        ) {
          state.latestCoordinatorReport = output.text.trim();
          // The resumed coordinator completed a turn, so no late event from its prior compaction can
          // compete with the next host-managed compaction.
          state.ownsHostContinuation = false;
        }
        if (state.directUsed && output.text.includes(ROLLOVER_MARKER)) return;
        if (output.text.includes(ROLLOVER_MARKER)) {
          /*
           * A terminal rollover still compacts a real session, so it needs the same identity proof
           * the resuming path requires. Without it any root session that merely quoted the marker
           * would have its own history summarized away.
           */
          const active = policy();
          const identity = await readIdentity(input.sessionID);
          if (
            !active.enabled || identity === undefined || !nonEmpty(identity.agent) ||
            nonEmpty(identity.parentID) || identity.agent !== active.agent
          ) {
            warnRollover(input.sessionID, "terminal-identity-rejected");
            return;
          }
          // A terminal batch compacts without resuming, and its continuation budget resets.
          const report = output.text.replaceAll(ROLLOVER_MARKER, "").trim();
          const terminal = stateFor(input.sessionID);
          terminal.attempts = 0;
          queueRollover(input.sessionID, report, false, true);
          return;
        }
        if (state?.directUsed === true) return;
        if (output.text.includes(CONTINUATION_MARKER)) {
          const report = output.text.replaceAll(CONTINUATION_MARKER, "").trim();
          await requestContinuation(input.sessionID, await readIdentity(input.sessionID), report);
          return;
        }
        if (STEP_EXHAUSTED_PATTERN.test(output.text)) {
          await requestContinuation(input.sessionID, await readIdentity(input.sessionID), output.text.trim());
        }
      } finally {
        const current = sessions.get(input.sessionID);
        if (current !== undefined) {
          current.textCompleting = false;
          if (current.idleDeferred) {
            current.idleDeferred = false;
            queueMicrotask(() => { void handleSessionIdle(input.sessionID); });
          }
        }
      }
    },

    async sessionCompacting(input, output): Promise<void> {
      const state = sessions.get(input.sessionID);
      if (state?.pendingRollover === true && (state.active || state.promptPending)) {
        state.compactingEpoch = state.rolloverEpoch;
      }
      if (state === undefined || (!state.active && !state.promptPending)) {
        /*
         * OpenCode may execute summarize through another plugin instance. In-memory rollover state
         * is therefore enrichment, not authorization: durable host identity is the fallback gate.
         * Ordinary sessions retain the host prompt byte-for-byte.
         */
        const identity = await readIdentity(input.sessionID);
        if (
          identity === undefined || !nonEmpty(identity.agent) || nonEmpty(identity.parentID) ||
          identity.agent !== policy().agent
        ) return;
      }
      if (state !== undefined) state.promptPending = false;
      const report = state?.latestReport;
      const authority = report === undefined
        ? "Sortie rollover policy is authoritative. Preserve only facts supported by the latest coordinator final report."
        : "Sortie authoritative latest coordinator final report follows. It overrides all older context; copy its terminal outcomes, counters, and next action exactly:\n" + report;
      output.context = [...(output.context ?? []), authority];
      output.prompt = report === undefined
        ? ROLLOVER_PROMPT
        : `${ROLLOVER_PROMPT}\n\nExact latest coordinator final report (authoritative):\n${report}`;
    },

    async sessionCompacted(sessionID): Promise<void> {
      const state = sessions.get(sessionID);
      if (state !== undefined) await arbitrateResume(sessionID, state);
    },

    async compactionAutoContinue(input, output): Promise<void> {
      const state = sessions.get(input.sessionID);
      const pending = state?.pendingRollover === true || state?.active === true ||
        state?.promptPending === true;
      /*
       * Auto-continue is a host behaviour every ordinary session relies on. Suppressing it is a
       * coordinator policy, so an untracked session must first prove it is a coordinator root before
       * this hook changes anything; otherwise installing the plugin would silently alter unrelated
       * sessions that never invoked the loop.
       */
      if (state === undefined) {
        const identity = await readIdentity(input.sessionID);
        if (
          identity === undefined || !nonEmpty(identity.agent) || nonEmpty(identity.parentID) ||
          identity.agent !== policy().agent
        ) return;
      }
      if (pending || state?.ownsHostContinuation === true) output.enabled = false;
    },

    observeModel(sessionID, model, synthetic = false): void {
      if (!nonEmpty(model.providerID) || !nonEmpty(model.modelID)) return;
      const state = stateFor(sessionID);
      if (!synthetic && !state.pendingRollover && !state.active && !state.promptPending) state.attempts = 0;
      state.directUsed = false;
      state.latestCoordinatorReport = undefined;
      state.compactingEpoch = undefined;
      state.model = { providerID: model.providerID, modelID: model.modelID };
      state.turnRevision += 1;
      if (!synthetic) {
        state.ownsHostContinuation = false;
        state.limitCompacted = false;
      }
    },

    blocksTool(sessionID): boolean {
      const state = sessions.get(sessionID);
      return state?.pendingRollover === true || state?.active === true || state?.promptPending === true;
    },

    sessionIdle: handleSessionIdle,

    forgetSession,
  };

  async function handleSessionIdle(sessionID: string): Promise<void> {
      const state = sessions.get(sessionID);
      if (state?.textCompleting === true) {
        state.idleDeferred = true;
        return;
      }
      if (state?.active === true) {
        if (state.turnRevision > state.activeRevision) state.idleDeferred = true;
        return;
      }
      if (state?.pendingRollover === true) {
        await runRollover(sessionID);
      }
  }
}
