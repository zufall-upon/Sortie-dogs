import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_CONTINUE_PREFIX,
  CONTINUATION_CAPABILITY,
  CONTINUATION_MARKER,
  DEFAULT_MAX_AUTO_CONTINUES,
  ROLLOVER_MARKER,
  ROLLOVER_TOKEN,
  STEP_EXHAUSTED_PATTERN,
  createContinuationHooks,
  resolveContinuation,
  type ContinuationClient,
  type ContinuationPolicy,
  type ContinuationTimings,
} from "../dist/plugin/continuation.js";
import { runtimeAssets } from "../dist/runtime-assets.js";
import { SortieDogsPlugin } from "../dist/plugin/index.js";

const COORDINATOR = "dog-coordinator";

const UNPINNED_POLICY: ContinuationPolicy = {
  enabled: true,
  agent: COORDINATOR,
  capability: CONTINUATION_CAPABILITY,
  maxAutoContinues: DEFAULT_MAX_AUTO_CONTINUES,
};
const POLICY: ContinuationPolicy = {
  ...UNPINNED_POLICY,
  summarizeModel: { model: "vendor-a/default-compact" },
};

/** Real durations would add minutes to the suite without exercising one extra branch. */
const FAST: ContinuationTimings = {
  cooldownMilliseconds: 0,
  settleMilliseconds: 0,
  scheduleMilliseconds: 0,
  scheduleAttempts: 2,
};

interface SummarizeCall {
  readonly id: string;
  readonly body: { providerID: string; modelID: string };
}

interface PromptCall {
  readonly id: string;
  readonly agent: string;
  readonly text: string;
}

interface FakeHost {
  readonly client: ContinuationClient;
  readonly summarizeCalls: SummarizeCall[];
  readonly promptCalls: PromptCall[];
  readonly getCalls: Array<{ id: string; directory?: string }>;
}

function fakeHost(session: { agent?: string; parentID?: string } | undefined): FakeHost {
  const summarizeCalls: SummarizeCall[] = [];
  const promptCalls: PromptCall[] = [];
  const getCalls: Array<{ id: string; directory?: string }> = [];
  const client: ContinuationClient = {
    session: {
      get: async (request) => {
        getCalls.push({ id: request.path.id, directory: request.query?.directory });
        return session === undefined ? { data: undefined } : { data: session };
      },
      summarize: async (request) => {
        summarizeCalls.push({ id: request.path.id, body: request.body });
        return { data: true };
      },
      promptAsync: async (request) => {
        promptCalls.push({
          id: request.path.id,
          agent: request.body.agent,
          text: request.body.parts[0]!.text,
        });
        return { data: true };
      },
    },
  };
  return { client, summarizeCalls, promptCalls, getCalls };
}

/** The scheduled rollover runs on a timer, so drain the macrotask queue before asserting. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function resolution(overrides: Partial<Parameters<typeof resolveContinuation>[0]> = {}) {
  return resolveContinuation({
    identity: { agent: COORDINATOR, parentID: undefined },
    configuredAgent: COORDINATOR,
    configuredCapability: CONTINUATION_CAPABILITY,
    requestedCapability: CONTINUATION_CAPABILITY,
    enabled: true,
    attempts: 0,
    maxAutoContinues: DEFAULT_MAX_AUTO_CONTINUES,
    pendingAutoContinue: false,
    ...overrides,
  });
}

test("continuation resolver grants only a configured root coordinator", () => {
  assert.deepEqual(resolution(), { compact: true, continue: true });

  assert.deepEqual(resolution({ enabled: false }), {
    compact: false,
    continue: false,
    reason: "continuation-disabled",
  });
  assert.equal(resolution({ configuredAgent: undefined }).reason, "capability-unavailable");
  assert.equal(resolution({ configuredCapability: "" }).reason, "capability-unavailable");
  assert.equal(resolution({ requestedCapability: "other_tool" }).reason, "capability-unavailable");
  assert.equal(resolution({ identity: undefined }).reason, "identity-unavailable");
  assert.equal(resolution({ identity: { agent: "" } }).reason, "identity-unavailable");
  // A child session is never promoted to root, even when it runs the coordinator agent.
  assert.equal(
    resolution({ identity: { agent: COORDINATOR, parentID: "ses_parent" } }).reason,
    "child-session",
  );
  assert.equal(
    resolution({ identity: { agent: "another-coordinator", parentID: undefined } }).reason,
    "agent-mismatch",
  );
  assert.equal(resolution({ pendingAutoContinue: true }).reason, "pending-autocontinue");

  // The ceiling stops the resume, not the compaction.
  assert.deepEqual(resolution({ attempts: DEFAULT_MAX_AUTO_CONTINUES }), {
    compact: true,
    continue: false,
    reason: "limit-reached",
  });
});

test("the direct capability compacts the root coordinator and resumes the same session", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  const hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);

  await hooks.textComplete(
    { sessionID: "ses_root" },
    { text: "batchAttempted=2 batchCommitted=1 batchReconciled=1; next=card-3" },
  );
  const result = await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR });
  assert.equal(result, "SORTIE_COMPACT_AND_CONTINUE_QUEUED");
  await settle();

  assert.equal(host.summarizeCalls.length, 1);
  assert.equal(host.summarizeCalls[0]!.id, "ses_root");
  assert.deepEqual(host.summarizeCalls[0]!.body, {
    providerID: "vendor-a",
    modelID: "default-compact",
  });
  assert.equal(host.promptCalls.length, 1);
  assert.equal(host.promptCalls[0]!.agent, COORDINATOR);
  assert.ok(host.promptCalls[0]!.text.startsWith(AUTO_CONTINUE_PREFIX));
  assert.match(host.promptCalls[0]!.text, /batchAttempted=2 batchCommitted=1 batchReconciled=1; next=card-3/);
  assert.doesNotMatch(host.promptCalls[0]!.text, /Tool-requested Sortie rollover/);
});

test("the direct capability uses the current report in both compaction and resume prompts", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  let hooks!: ReturnType<typeof createContinuationHooks>;
  let compactionPrompt = "";
  host.client.session!.summarize = async (request) => {
    host.summarizeCalls.push({ id: request.path.id, body: request.body });
    const output: { prompt?: string } = {};
    await hooks.sessionCompacting({ sessionID: request.path.id }, output);
    compactionPrompt = output.prompt ?? "";
    return { data: true };
  };
  hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);
  const report = "batchAttempted=1 batchCommitted=1 batchReconciled=0; next=visual-check";
  await hooks.textComplete({ sessionID: "ses_root" }, { text: report });
  await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR });
  await settle();
  assert.match(compactionPrompt, new RegExp(report));
  assert.match(host.promptCalls[0]!.text, new RegExp(report));
});

test("the direct capability keeps its generic fallback when no current report exists", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  const hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);
  await hooks.textComplete({ sessionID: "ses_root" }, { text: `${ROLLOVER_TOKEN}\nsummary` });
  await hooks.textComplete({ sessionID: "ses_root" }, { text: `${AUTO_CONTINUE_PREFIX}\nrequest` });
  await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR });
  await settle();
  assert.match(host.promptCalls[0]!.text, /Tool-requested Sortie rollover/);
});

test("a second direct capability call in the same turn is rejected without another rollover", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  const hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);
  assert.equal(
    await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR }),
    "SORTIE_COMPACT_AND_CONTINUE_QUEUED",
  );
  assert.equal(
    await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR }),
    "SORTIE_CONTINUATION_REJECTED: pending-autocontinue",
  );
  await settle();
  assert.equal(host.summarizeCalls.length, 1);
  assert.equal(host.promptCalls.length, 1);
});

test("a second rollover carries the checkpoint from its resumed user turn", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  const hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);
  await hooks.textComplete({ sessionID: "ses_root" }, { text: "first checkpoint" });
  await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR });
  await settle();

  hooks.observeModel("ses_root", { providerID: "openai", modelID: "gpt-5.6-luna" });
  await hooks.textComplete({ sessionID: "ses_root" }, { text: "second checkpoint; next=unit-3" });
  await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR });
  await settle();
  assert.equal(host.promptCalls.length, 2);
  assert.match(host.promptCalls[1]!.text, /second checkpoint; next=unit-3/);
  assert.doesNotMatch(host.promptCalls[1]!.text, /Tool-requested Sortie rollover/);
});

test("the direct capability starts before its delayed idle-event fallback", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  const hooks = createContinuationHooks(host.client, "/project", POLICY, {
    ...FAST,
    scheduleMilliseconds: 60_000,
  });

  await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR });
  await settle();
  assert.equal(host.summarizeCalls.length, 1);
  assert.equal(host.promptCalls.length, 1);
});

test("the compacted event issues the resume before the summarize request returns", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  let hooks!: ReturnType<typeof createContinuationHooks>;
  host.client.session!.summarize = async (request) => {
    host.summarizeCalls.push({ id: request.path.id, body: request.body });
    await hooks.sessionCompacted(request.path.id);
    return { data: true };
  };
  hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);

  await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR });
  await settle();
  assert.equal(host.summarizeCalls.length, 1);
  assert.equal(host.promptCalls.length, 1, "post-summary fallback must not duplicate the event resume");
  assert.ok(host.promptCalls[0]!.text.startsWith(AUTO_CONTINUE_PREFIX));
  assert.equal(hooks.blocksTool("ses_root"), false);
});

test("the compaction summary issues the resume before a one-shot host can exit", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  let hooks!: ReturnType<typeof createContinuationHooks>;
  host.client.session!.summarize = async (request) => {
    host.summarizeCalls.push({ id: request.path.id, body: request.body });
    await hooks.sessionCompacting({ sessionID: request.path.id }, {});
    await hooks.textComplete({ sessionID: request.path.id }, { text: "## 目的\nsummary without rollover token" });
    return { data: true };
  };
  hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);

  await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR });
  await settle();
  assert.equal(host.summarizeCalls.length, 1);
  assert.equal(host.promptCalls.length, 1, "post-summary fallback must not duplicate the early resume");
  assert.ok(host.promptCalls[0]!.text.startsWith(AUTO_CONTINUE_PREFIX));
  assert.equal(hooks.blocksTool("ses_root"), false);
});

test("a new user turn clears an armed compaction boundary before ordinary text completes", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  let hooks!: ReturnType<typeof createContinuationHooks>;
  let summaryStarted!: () => void;
  const started = new Promise<void>((resolve) => { summaryStarted = resolve; });
  let releaseSummary!: () => void;
  const summaryReady = new Promise<void>((resolve) => { releaseSummary = resolve; });
  host.client.session!.summarize = async (request) => {
    host.summarizeCalls.push({ id: request.path.id, body: request.body });
    await hooks.sessionCompacting({ sessionID: request.path.id }, {});
    summaryStarted();
    await summaryReady;
    return { data: true };
  };
  hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);
  await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR });
  await started;
  hooks.observeModel("ses_root", { providerID: "openai", modelID: "gpt-5.6-luna" });
  await hooks.textComplete({ sessionID: "ses_root" }, { text: "ordinary next-turn text" });
  assert.equal(host.promptCalls.length, 0);
  releaseSummary();
  await settle();
  assert.equal(host.promptCalls.length, 1, "post-summary fallback still resumes exactly once");
});

test("an in-flight compaction-boundary resume is not duplicated after summarize resolves", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  let hooks!: ReturnType<typeof createContinuationHooks>;
  let releaseResume!: () => void;
  const resumeReady = new Promise<void>((resolve) => { releaseResume = resolve; });
  host.client.session!.promptAsync = async (request) => {
    await resumeReady;
    host.promptCalls.push({
      id: request.path.id,
      agent: request.body.agent,
      text: request.body.parts[0]!.text,
    });
    return { data: true };
  };
  let boundary!: Promise<void>;
  host.client.session!.summarize = async (request) => {
    host.summarizeCalls.push({ id: request.path.id, body: request.body });
    boundary = hooks.textComplete(
      { sessionID: request.path.id },
      { text: `${ROLLOVER_TOKEN}\nsummary` },
    );
    return { data: true };
  };
  hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);

  await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR });
  await new Promise((resolve) => setTimeout(resolve, 0));
  releaseResume();
  await boundary;
  await settle();
  assert.equal(host.promptCalls.length, 1);
});

test("a rejected compaction-boundary resume falls back after summarize", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  let hooks!: ReturnType<typeof createContinuationHooks>;
  let attempts = 0;
  host.client.session!.promptAsync = async (request) => {
    attempts += 1;
    if (attempts === 1) return { error: { message: "injected rejection" } };
    host.promptCalls.push({
      id: request.path.id,
      agent: request.body.agent,
      text: request.body.parts[0]!.text,
    });
    return { data: true };
  };
  host.client.session!.summarize = async (request) => {
    host.summarizeCalls.push({ id: request.path.id, body: request.body });
    await hooks.textComplete({ sessionID: request.path.id }, { text: `${ROLLOVER_TOKEN}\nsummary` });
    return { data: true };
  };
  hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);
  const originalError = console.error;
  try {
    console.error = () => undefined;
    await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR });
    await settle();
    assert.equal(attempts, 2);
    assert.equal(host.promptCalls.length, 1);
  } finally {
    console.error = originalError;
  }
});

test("compacted events cannot resume child, foreign, or untracked sessions", async () => {
  const child = fakeHost({ agent: COORDINATOR, parentID: "ses_parent" });
  const childHooks = createContinuationHooks(child.client, "/project", POLICY, FAST);
  await childHooks.tool.execute({}, { sessionID: "ses_child", agent: COORDINATOR });
  await childHooks.sessionCompacted("ses_child");

  const foreign = fakeHost({ agent: "another-coordinator" });
  const foreignHooks = createContinuationHooks(foreign.client, "/project", POLICY, FAST);
  await foreignHooks.tool.execute({}, { sessionID: "ses_foreign", agent: "another-coordinator" });
  await foreignHooks.sessionCompacted("ses_foreign");

  const untracked = fakeHost(undefined);
  const untrackedHooks = createContinuationHooks(untracked.client, "/project", POLICY, FAST);
  await untrackedHooks.sessionCompacted("ses_unknown");
  await settle();
  assert.deepEqual(
    [child.promptCalls.length, foreign.promptCalls.length, untracked.promptCalls.length],
    [0, 0, 0],
  );
});

test("the latest coordinator model is sent when no summarize override is configured", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  const hooks = createContinuationHooks(host.client, "/project", UNPINNED_POLICY, FAST);
  hooks.observeModel("ses_root", { providerID: "openai", modelID: "gpt-5.6-luna" });

  await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR });
  await settle();
  assert.deepEqual(host.summarizeCalls[0]!.body, {
    providerID: "openai",
    modelID: "gpt-5.6-luna",
  });
});

test("continuation rejects a missing summarize model before claiming it was queued", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  const hooks = createContinuationHooks(host.client, "/project", UNPINNED_POLICY, FAST);
  assert.equal(
    await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR }),
    "SORTIE_CONTINUATION_REJECTED: summarize-model-unavailable",
  );
  assert.equal(host.summarizeCalls.length, 0);
});

test("a child session and a foreign agent are both refused without any host call", async () => {
  const child = fakeHost({ agent: COORDINATOR, parentID: "ses_root" });
  const childHooks = createContinuationHooks(child.client, "/project", POLICY, FAST);
  assert.equal(
    await childHooks.tool.execute({}, { sessionID: "ses_child", agent: COORDINATOR }),
    "SORTIE_CONTINUATION_REJECTED: child-session",
  );

  const foreign = fakeHost({ agent: "dog-worker" });
  const foreignHooks = createContinuationHooks(foreign.client, "/project", POLICY, FAST);
  assert.equal(
    await foreignHooks.tool.execute({}, { sessionID: "ses_worker", agent: "dog-worker" }),
    "SORTIE_CONTINUATION_REJECTED: agent-mismatch",
  );

  await settle();
  assert.deepEqual([child.summarizeCalls.length, child.promptCalls.length], [0, 0]);
  assert.deepEqual([foreign.summarizeCalls.length, foreign.promptCalls.length], [0, 0]);
});

test("continuation stops resuming at its ceiling but still compacts", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  const hooks = createContinuationHooks(host.client, "/project", { ...POLICY, maxAutoContinues: 2 }, FAST);

  for (let call = 0; call < 2; call += 1) {
    assert.equal(
      await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR }),
      "SORTIE_COMPACT_AND_CONTINUE_QUEUED",
    );
    await settle();
  }
  assert.equal(
    await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR }),
    "SORTIE_COMPACT_QUEUED: auto-continue limit reached",
  );
  await settle();

  assert.equal(host.summarizeCalls.length, 3);
  assert.equal(host.promptCalls.length, 2);
});

test("the marker fallback continues only when the direct capability did not run", async () => {
  const fallback = fakeHost({ agent: COORDINATOR });
  const fallbackHooks = createContinuationHooks(fallback.client, "/project", POLICY, FAST);
  await fallbackHooks.textComplete(
    { sessionID: "ses_root" },
    { text: `unit terminal\n${CONTINUATION_MARKER}` },
  );
  await settle();
  assert.equal(fallback.summarizeCalls.length, 1);
  assert.equal(fallback.promptCalls.length, 1);
  assert.doesNotMatch(fallback.promptCalls[0]!.text, /SORTIE_CONTINUE/);

  const both = fakeHost({ agent: COORDINATOR });
  const bothHooks = createContinuationHooks(both.client, "/project", POLICY, FAST);
  await bothHooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR });
  await bothHooks.textComplete(
    { sessionID: "ses_root" },
    { text: `unit terminal\n${CONTINUATION_MARKER}` },
  );
  await settle();
  // Exactly one continuation mechanism may act on one turn.
  assert.equal(both.summarizeCalls.length, 1);
  assert.equal(both.promptCalls.length, 1);

  bothHooks.observeModel("ses_root", { providerID: "openai", modelID: "gpt-5.6-luna" });
  await bothHooks.textComplete(
    { sessionID: "ses_root" },
    { text: `next turn terminal\n${CONTINUATION_MARKER}` },
  );
  await settle();
  assert.equal(both.summarizeCalls.length, 2, "the next user turn clears the direct-tool flag");
});

test("the stop marker compacts without resuming and clears the continuation budget", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  const hooks = createContinuationHooks(host.client, "/project", { ...POLICY, maxAutoContinues: 1 }, FAST);

  await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR });
  await settle();
  hooks.observeModel("ses_root", { providerID: "openai", modelID: "gpt-5.6-luna" });
  await hooks.textComplete({ sessionID: "ses_root" }, { text: `batch stop\n${ROLLOVER_MARKER}` });
  await settle();
  assert.equal(host.promptCalls.length, 1, "the stop marker must not resume the batch");

  // The budget reset means a fresh batch can continue again.
  assert.equal(
    await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR }),
    "SORTIE_COMPACT_AND_CONTINUE_QUEUED",
  );
});

test("the stop marker compacts only a session whose identity is the configured coordinator", async () => {
  // A foreign root that merely emitted the marker must never have its own history summarized away.
  const foreign = fakeHost({ agent: "another-coordinator" });
  const foreignHooks = createContinuationHooks(foreign.client, "/project", POLICY, FAST);
  await foreignHooks.textComplete({ sessionID: "ses_other" }, { text: `stop\n${ROLLOVER_MARKER}` });
  await settle();
  assert.deepEqual(foreign.summarizeCalls, []);

  const child = fakeHost({ agent: COORDINATOR, parentID: "ses_parent" });
  const childHooks = createContinuationHooks(child.client, "/project", POLICY, FAST);
  await childHooks.textComplete({ sessionID: "ses_child" }, { text: `stop\n${ROLLOVER_MARKER}` });
  await settle();
  assert.deepEqual(child.summarizeCalls, []);

  const unknown = fakeHost(undefined);
  const unknownHooks = createContinuationHooks(unknown.client, "/project", POLICY, FAST);
  await unknownHooks.textComplete({ sessionID: "ses_root" }, { text: `stop\n${ROLLOVER_MARKER}` });
  await settle();
  assert.deepEqual(unknown.summarizeCalls, []);
});

test("a session lookup is scoped to the plugin directory and yields to the local identity", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  const hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);
  await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR });
  await settle();
  assert.ok(host.getCalls.length > 0);
  for (const call of host.getCalls) assert.equal(call.directory, "/project");

  /*
   * A host whose lookup cannot answer for this session used to abort every rollover silently. The
   * plugin already observed the coordinator root, so that observation is authoritative.
   */
  const blind = fakeHost(undefined);
  const local = createContinuationHooks(
    blind.client,
    "/project",
    POLICY,
    FAST,
    (sessionID) => sessionID === "ses_root" ? { agent: COORDINATOR, parentID: undefined } : undefined,
  );
  await local.textComplete({ sessionID: "ses_root" }, { text: `stop\n${ROLLOVER_MARKER}` });
  await settle();
  assert.deepEqual(blind.summarizeCalls.map(({ id }) => id), ["ses_root"]);
  assert.deepEqual(blind.getCalls, [], "the local identity must answer without a host call");

  await local.textComplete({ sessionID: "ses_unknown" }, { text: `stop\n${ROLLOVER_MARKER}` });
  await settle();
  assert.deepEqual(blind.summarizeCalls.map(({ id }) => id), ["ses_root"]);
});

test("an exhausted step budget is treated as a continuation request", async () => {
  assert.match("最大step到達。残作業は次candidate。", STEP_EXHAUSTED_PATTERN);
  assert.match("step limit reached; remaining work is the next unit", STEP_EXHAUSTED_PATTERN);
  assert.doesNotMatch("unit committed and batch complete", STEP_EXHAUSTED_PATTERN);

  const host = fakeHost({ agent: COORDINATOR });
  const hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);
  await hooks.textComplete(
    { sessionID: "ses_root" },
    { text: "最大step数に到達しました。残作業: 次の独立unit。" },
  );
  await settle();
  assert.equal(host.promptCalls.length, 1);
});

test("the compaction prompt preserves batch state and names no legacy workflow", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  const hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);
  await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR });
  // The host asks for the compaction prompt once the queued rollover has started.
  await settle();

  const output: { prompt?: string } = {};
  await hooks.sessionCompacting({ sessionID: "ses_root" }, output);
  const prompt = output.prompt ?? "";
  assert.ok(prompt.includes(ROLLOVER_TOKEN));
  for (const preserved of [
    "task identity",
    "batchTarget",
    "batchAttempted",
    "batchCommitted",
    "batchReconciled",
    "source_manifest",
    "operation_manifest",
    "validation",
  ]) {
    assert.ok(prompt.includes(preserved), `the rollover prompt must preserve ${preserved}`);
  }
  assert.doesNotMatch(prompt, /MK2A2|MKII|MK4|MK5|MK6/);

  const untracked: { prompt?: string } = {};
  const foreign = fakeHost({ agent: "build" });
  const foreignHooks = createContinuationHooks(foreign.client, "/project", POLICY, FAST);
  await foreignHooks.sessionCompacting({ sessionID: "ses_other" }, untracked);
  assert.equal(untracked.prompt, undefined, "an untracked session keeps the host compaction prompt");
});

test("a root coordinator gets the Sortie prompt without shared in-memory rollover state", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  const hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);
  const output = { prompt: "host prompt" };
  await hooks.sessionCompacting({ sessionID: "ses_root" }, output);
  assert.ok(output.prompt.includes(ROLLOVER_TOKEN));
  assert.match(output.prompt, /## batch counters/);
  assert.match(output.prompt, /batchTarget:/);

  const child = fakeHost({ agent: COORDINATOR, parentID: "ses_root" });
  const childHooks = createContinuationHooks(child.client, "/project", POLICY, FAST);
  const unchanged = { prompt: "host child prompt" };
  await childHooks.sessionCompacting({ sessionID: "ses_child" }, unchanged);
  assert.equal(unchanged.prompt, "host child prompt");
});

test("host auto-continue is disabled only while a Sortie rollover is pending", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  const hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);

  const overflow = { enabled: true };
  await hooks.compactionAutoContinue({ sessionID: "ses_root", overflow: true }, overflow);
  assert.equal(overflow.enabled, true, "an untracked overflow keeps the host behaviour");

  const nonOverflow = { enabled: true };
  await hooks.compactionAutoContinue({ sessionID: "ses_root", overflow: false }, nonOverflow);
  assert.equal(nonOverflow.enabled, true, "normal host auto-compaction keeps its continuation");

  await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR });
  const pending = { enabled: true };
  await hooks.compactionAutoContinue({ sessionID: "ses_root", overflow: true }, pending);
  assert.equal(pending.enabled, false, "continuation owns the resume while it is pending");
  const pendingNormal = { enabled: true };
  await hooks.compactionAutoContinue({ sessionID: "ses_root", overflow: false }, pendingNormal);
  assert.equal(pendingNormal.enabled, false, "pending Sortie rollover owns normal compaction too");
  await settle();
  await hooks.sessionCompacting({ sessionID: "ses_root" }, {});
  const completed = { enabled: true };
  await hooks.compactionAutoContinue({ sessionID: "ses_root", overflow: false }, completed);
  assert.equal(completed.enabled, true, "completed Sortie rollover releases host auto-continue");
});

test("exhausted rollover retries release host auto-continue", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  host.client.session!.summarize = async () => {
    throw new Error("injected summarize failure");
  };
  const hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);
  const originalError = console.error;
  const originalWarn = console.warn;
  try {
    console.error = () => undefined;
    console.warn = () => undefined;
    await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR });
    await settle();
    const output = { enabled: true };
    await hooks.compactionAutoContinue({ sessionID: "ses_root", overflow: false }, output);
    assert.equal(output.enabled, true);
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
});

test("a resolved host error response is not mistaken for successful compaction", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  host.client.session!.summarize = async (request) => {
    host.summarizeCalls.push({ id: request.path.id, body: request.body });
    return { error: { message: "injected rejection" } };
  };
  const hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);
  const originalError = console.error;
  const originalWarn = console.warn;
  try {
    console.error = () => undefined;
    console.warn = () => undefined;
    await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR });
    await settle();
    assert.equal(host.promptCalls.length, 0);
    assert.ok(host.summarizeCalls.length > 0);
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
});

test("concurrent idle signals cannot start duplicate rollovers", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  const hooks = createContinuationHooks(host.client, "/project", POLICY, {
    ...FAST,
    scheduleMilliseconds: 60_000,
  });
  await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR });

  let releaseIdentity!: () => void;
  const identityReady = new Promise<void>((resolve) => { releaseIdentity = resolve; });
  host.client.session!.get = async () => {
    await identityReady;
    return { data: { agent: COORDINATOR } };
  };
  const first = hooks.sessionIdle("ses_root");
  const second = hooks.sessionIdle("ses_root");
  releaseIdentity();
  await Promise.all([first, second]);
  assert.equal(host.summarizeCalls.length, 1);
  assert.equal(host.promptCalls.length, 1);
});

test("a resolved resume error retries only the resume after one compaction", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  let attempts = 0;
  host.client.session!.promptAsync = async (request) => {
    attempts += 1;
    if (attempts === 1) return { error: { message: "injected rejection" } };
    host.promptCalls.push({
      id: request.path.id,
      agent: request.body.agent,
      text: request.body.parts[0]!.text,
    });
    return { data: true };
  };
  const hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);
  const originalError = console.error;
  try {
    console.error = () => undefined;
    await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR });
    await settle();
    assert.equal(host.summarizeCalls.length, 1);
    assert.equal(attempts, 2);
    assert.equal(host.promptCalls.length, 1);
  } finally {
    console.error = originalError;
  }
});

test("a 204-style prompt response completes the resume and releases the compaction lock", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  host.client.session!.promptAsync = async () => ({
    data: undefined,
    error: undefined,
    response: { ok: true, status: 204 },
  });
  const hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);
  await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR });
  await settle();
  assert.equal(host.summarizeCalls.length, 1);
  assert.equal(hooks.blocksTool("ses_root"), false);
});

test("a queued rollover blocks later coordinator tools until compaction completes", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  const hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);
  assert.equal(hooks.blocksTool("ses_root"), false);
  await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR });
  assert.equal(hooks.blocksTool("ses_root"), true);
  await settle();
  assert.equal(hooks.blocksTool("ses_root"), false);
});

test("root coordinator idle never starts an implicit rollover", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  const hooks = createContinuationHooks(host.client, "/project", UNPINNED_POLICY, FAST);
  hooks.observeModel("ses_root", { providerID: "openai", modelID: "gpt-5.6-luna" });
  await hooks.sessionIdle("ses_root");
  await hooks.sessionIdle("ses_root");
  hooks.observeModel("ses_root", { providerID: "openai", modelID: "gpt-5.6-luna" });
  await hooks.sessionIdle("ses_root");
  assert.equal(host.summarizeCalls.length, 0);
  assert.equal(host.promptCalls.length, 0);
});

test("idle starts an explicitly queued rollover before its delayed fallback", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  const hooks = createContinuationHooks(host.client, "/project", POLICY, {
    ...FAST,
    scheduleMilliseconds: 60_000,
  });
  await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR });
  await hooks.sessionIdle("ses_root");
  assert.equal(host.summarizeCalls.length, 1);
  assert.equal(host.promptCalls.length, 1);
});

test("the stop marker clears stale reports and resets the continuation budget", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  const hooks = createContinuationHooks(
    host.client,
    "/project",
    { ...UNPINNED_POLICY, maxAutoContinues: 1 },
    FAST,
  );
  hooks.observeModel("ses_root", { providerID: "openai", modelID: "gpt-5.6-luna" });
  assert.equal(
    await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR }),
    "SORTIE_COMPACT_AND_CONTINUE_QUEUED",
  );
  await settle();
  hooks.observeModel("ses_root", { providerID: "openai", modelID: "gpt-5.6-luna" });
  await hooks.textComplete({ sessionID: "ses_root" }, { text: `terminal\n${ROLLOVER_MARKER}` });
  await settle();
  const prompt = { prompt: "host" };
  await hooks.sessionCompacting({ sessionID: "ses_root" }, prompt);
  assert.doesNotMatch(prompt.prompt, /Exact latest coordinator final report/);
  assert.equal(
    await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR }),
    "SORTIE_COMPACT_AND_CONTINUE_QUEUED",
  );
});

test("an explicit continuation marker wins when idle arrives during marker resolution", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  let releaseIdentity!: () => void;
  const identityReady = new Promise<void>((resolve) => { releaseIdentity = resolve; });
  const hooks = createContinuationHooks(host.client, "/project", UNPINNED_POLICY, FAST);
  hooks.observeModel("ses_root", { providerID: "openai", modelID: "gpt-5.6-luna" });
  host.client.session!.get = async () => {
    await identityReady;
    return { data: { agent: COORDINATOR } };
  };
  const completing = hooks.textComplete(
    { sessionID: "ses_root" },
    { text: `terminal\n${CONTINUATION_MARKER}` },
  );
  await hooks.sessionIdle("ses_root");
  releaseIdentity();
  await completing;
  await settle();
  assert.equal(host.summarizeCalls.length, 1);
  assert.equal(host.promptCalls.length, 1);
});

test("cooldown defers a queued rollover without exhausting it", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  const hooks = createContinuationHooks(host.client, "/project", POLICY, {
    cooldownMilliseconds: 50,
    settleMilliseconds: 0,
    scheduleMilliseconds: 0,
    scheduleAttempts: 0,
  });
  await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR });
  await settle();
  assert.equal(host.summarizeCalls.length, 1);

  await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(host.summarizeCalls.length, 2, "the cooldown timer retains and runs the queued rollover");
});

test("host auto-continue stays untouched for sessions the loop never owns", async () => {
  const foreign = fakeHost({ agent: "build" });
  const foreignHooks = createContinuationHooks(foreign.client, "/project", POLICY, FAST);
  const untouched = { enabled: true };
  await foreignHooks.compactionAutoContinue({ sessionID: "ses_plain", overflow: false }, untouched);
  assert.equal(untouched.enabled, true, "an unrelated agent keeps the host auto-continue");

  const child = fakeHost({ agent: COORDINATOR, parentID: "ses_root" });
  const childHooks = createContinuationHooks(child.client, "/project", POLICY, FAST);
  const childOutput = { enabled: true };
  await childHooks.compactionAutoContinue({ sessionID: "ses_child", overflow: false }, childOutput);
  assert.equal(childOutput.enabled, true, "a child session keeps the host auto-continue");

  const blind = createContinuationHooks(undefined, "/project", POLICY, FAST);
  const blindOutput = { enabled: true };
  await blind.compactionAutoContinue({ sessionID: "ses_unknown", overflow: false }, blindOutput);
  assert.equal(blindOutput.enabled, true, "an unreadable identity never changes host behaviour");
});

test("forgetting a session clears its continuation budget", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  const hooks = createContinuationHooks(host.client, "/project", { ...POLICY, maxAutoContinues: 1 }, FAST);

  await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR });
  await settle();
  hooks.forgetSession("ses_root");
  assert.equal(
    await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR }),
    "SORTIE_COMPACT_AND_CONTINUE_QUEUED",
  );

  const compacting: { prompt?: string } = {};
  hooks.forgetSession("ses_root");
  await hooks.sessionCompacting({ sessionID: "ses_root" }, compacting);
  assert.ok(compacting.prompt?.includes(ROLLOVER_TOKEN));
});

test("a session lookup without an agent field still trusts the reported parent link", async () => {
  const anonymous = fakeHost({});
  const anonymousHooks = createContinuationHooks(anonymous.client, "/project", POLICY, FAST);
  assert.equal(
    await anonymousHooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR }),
    "SORTIE_COMPACT_AND_CONTINUE_QUEUED",
  );

  const nested = fakeHost({ parentID: "ses_root" });
  const nestedHooks = createContinuationHooks(nested.client, "/project", POLICY, FAST);
  assert.equal(
    await nestedHooks.tool.execute({}, { sessionID: "ses_child", agent: COORDINATOR }),
    "SORTIE_CONTINUATION_REJECTED: child-session",
  );
  await settle();
  assert.deepEqual([nested.summarizeCalls.length, nested.promptCalls.length], [0, 0]);
});

test("a host without the continuation client never resumes anything", async () => {
  const hooks = createContinuationHooks(undefined, "/project", POLICY, FAST);
  // The tool still answers deterministically instead of throwing into the coordinator turn.
  const answer = await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR });
  assert.equal(answer, "SORTIE_CONTINUATION_REJECTED: capability-unavailable");
  await settle();
  await hooks.sessionIdle("ses_root");
});

/*
 * The original defect shipped a coordinator prompt naming a continuation capability that no runtime
 * provided, and every test passed because they only inspected prompt text. This oracle fails unless
 * each literal named by the asset is backed by something the plugin actually exposes.
 */
test("every capability and marker named by the coordinator asset exists at runtime", async () => {
  const coordinator = runtimeAssets.find((asset) => asset.name === "dog-coordinator");
  assert.ok(coordinator);

  const capabilities = [...coordinator.content.matchAll(/^\s*direct_capability:\s*(\S+)$/gmu)]
    .map((match) => match[1]!);
  assert.deepEqual(capabilities, [CONTINUATION_CAPABILITY]);

  const markers = [...coordinator.content.matchAll(/<!--\s*[A-Z0-9_]+\s*-->/gu)].map((match) => match[0]);
  assert.ok(markers.length > 0, "the asset must name its fallback markers");
  for (const marker of new Set(markers)) {
    assert.ok(
      marker === CONTINUATION_MARKER || marker === ROLLOVER_MARKER,
      `the asset names marker ${marker} with no runtime that recognizes it`,
    );
  }

  const hooks = await SortieDogsPlugin({ directory: process.cwd() });
  for (const capability of capabilities) {
    assert.ok(
      hooks.tool?.[capability] !== undefined,
      `the asset names capability ${capability} with no registered tool`,
    );
  }
  for (const hook of [
    "experimental.text.complete",
    "experimental.session.compacting",
    "experimental.compaction.autocontinue",
  ] as const) {
    assert.equal(typeof hooks[hook], "function", `${hook} must be registered for continuation`);
  }
});
