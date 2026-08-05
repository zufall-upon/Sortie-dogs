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
/** First line the rollover summary must emit, mirroring the batch target of three attempts. */
export const ROLLOVER_TOKEN = "SORTIE_ROLLOVER_COMPACTED";
export const DEFAULT_MAX_AUTO_CONTINUES = 3;

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
  /** A rollover that cannot start yet is retried on a short backoff rather than dropped. */
  scheduleMilliseconds: 1_500,
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
  | "pending-autocontinue";

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
      body?: { providerID: string; modelID: string };
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
  | "terminal-identity-rejected";

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
  compactionAutoContinue(
    input: { sessionID: string; overflow?: boolean },
    output: { enabled: boolean },
  ): Promise<void>;
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
  /** Latest authoritative coordinator report, handed to the compaction prompt. */
  latestReport?: string | undefined;
  /** A rollover is executing right now. */
  active: boolean;
  /** A rollover-shaped compaction prompt is still owed to the host. */
  promptPending: boolean;
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
      active: false,
      promptPending: false,
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

  function summarizeBody(): { providerID: string; modelID: string } | undefined {
    const summarizeModel = policy().summarizeModel;
    if (summarizeModel === undefined) return undefined;
    return openCodeModel(summarizeModel.model);
  }

  async function runRollover(sessionID: string): Promise<boolean> {
    const state = sessions.get(sessionID);
    if (state === undefined || !state.pendingRollover || state.active) return false;
    const summarize = client?.session?.summarize;
    if (summarize === undefined) {
      warnRollover(sessionID, "summarize-unavailable");
      return false;
    }

    const cooldownRemaining = state.lastRollover === undefined
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

    const continueReport = state.continueReport;
    state.active = true;
    state.promptPending = true;
    let summarized = false;
    try {
      const body = summarizeBody();
      await summarize.call(client!.session, {
        path: { id: sessionID },
        query: { directory },
        ...(body === undefined ? {} : { body }),
      });
      summarized = true;
      state.lastRollover = Date.now();
      state.pendingRollover = false;
      state.continueReport = undefined;
      if (continueReport === undefined) return true;

      const resume = client?.session?.promptAsync;
      if (resume === undefined) return true;
      await new Promise((settle) => unrefTimer(setTimeout(settle, timings.settleMilliseconds)));
      await resume.call(client!.session, {
        path: { id: sessionID },
        query: { directory },
        body: {
          agent: policy().agent,
          parts: [{
            type: "text",
            synthetic: true,
            text: `${AUTO_CONTINUE_PREFIX}\n直前最終報告（最新正本）:\n${continueReport}\n` +
              "batchAttempted/batchCommitted/batchReconciledを保持し、terminal unitを再実行せず次の独立unitから同rootで継続。",
          }],
        },
      });
      return true;
    } catch (error) {
      console.error("[sortie-continuation] rollover failed", sessionID, error);
      return false;
    } finally {
      const current = sessions.get(sessionID);
      if (current !== undefined) {
        current.active = false;
        if (!summarized) current.promptPending = false;
      }
    }
  }

  function scheduleRollover(sessionID: string, attempt = 0): void {
    unrefTimer(setTimeout(async () => {
      const completed = await runRollover(sessionID);
      const state = sessions.get(sessionID);
      if (!completed && state?.pendingRollover === true && attempt < timings.scheduleAttempts) {
        scheduleRollover(sessionID, attempt + 1);
      }
    }, timings.scheduleMilliseconds * (attempt + 1)));
  }

  function queueRollover(sessionID: string, report: string, resume: boolean): void {
    const state = stateFor(sessionID);
    state.pendingRollover = true;
    state.latestReport = report;
    state.continueReport = resume ? report : undefined;
    if (resume) state.attempts += 1;
    scheduleRollover(sessionID);
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
      if (!resolution.compact) return `SORTIE_CONTINUATION_REJECTED: ${resolution.reason}`;
      // The direct capability and the marker fallback are mutually exclusive within one turn.
      state.directUsed = true;
      queueRollover(
        context.sessionID,
        "Tool-requested Sortie rollover. Preserve task identity, both manifests, validation history, " +
          "batch counters, blocker state, and the exact next action from the latest messages.",
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
      const state = sessions.get(input.sessionID);
      try {
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
          queueRollover(input.sessionID, report, false);
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
        if (current !== undefined) current.directUsed = false;
      }
    },

    async sessionCompacting(input, output): Promise<void> {
      const state = sessions.get(input.sessionID);
      if (state === undefined || (!state.active && !state.promptPending)) return;
      state.promptPending = false;
      output.prompt = state.latestReport === undefined
        ? ROLLOVER_PROMPT
        : `${ROLLOVER_PROMPT}\n\nExact latest coordinator final report (authoritative):\n${state.latestReport}`;
    },

    async compactionAutoContinue(input, output): Promise<void> {
      const state = sessions.get(input.sessionID);
      const pending = state?.pendingRollover === true || state?.active === true ||
        state?.promptPending === true;
      if (input.overflow !== true || pending) output.enabled = false;
    },

    async sessionIdle(sessionID): Promise<void> {
      await runRollover(sessionID);
    },

    forgetSession,
  };
}
