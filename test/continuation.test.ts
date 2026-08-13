import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_CONTINUE_PREFIX,
  CONTINUATION_CAPABILITY,
  CONTINUATION_MARKER,
  DEFAULT_MAX_AUTO_CONTINUES,
  ROLLOVER_MARKER,
  ROLLOVER_TOKEN,
  STEP_CONTINUE_PREFIX,
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
  assert.deepEqual(resolution({ identity: { agent: COORDINATOR, parentPresent: true } }), {
    compact: false,
    continue: false,
    reason: "child-session",
  });

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
  let compactionContext: string[] = [];
  host.client.session!.summarize = async (request) => {
    host.summarizeCalls.push({ id: request.path.id, body: request.body });
    const output: { context?: string[]; prompt?: string } = {};
    await hooks.sessionCompacting({ sessionID: request.path.id }, output);
    compactionPrompt = output.prompt ?? "";
    compactionContext = output.context ?? [];
    return { data: true };
  };
  hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);
  const report = "batchAttempted=1 batchCommitted=1 batchReconciled=0; next=visual-check";
  await hooks.textComplete({ sessionID: "ses_root" }, { text: report });
  await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR });
  await settle();
  assert.match(compactionPrompt, new RegExp(report));
  assert.match(compactionContext.join("\n"), new RegExp(report));
  assert.match(host.promptCalls[0]!.text, new RegExp(report));
  assert.match(host.promptCalls[0]!.text, /直前のcompaction summaryは破棄する/);
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

test("fake host event permutations converge on one compaction and one same-root resume", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  let hooks!: ReturnType<typeof createContinuationHooks>;
  host.client.session!.summarize = async (request) => {
    host.summarizeCalls.push({ id: request.path.id, body: request.body });
    await hooks.sessionCompacting({ sessionID: request.path.id }, {});
    await hooks.sessionIdle(request.path.id);
    await hooks.sessionCompacted(request.path.id);
    await hooks.textComplete(
      { sessionID: request.path.id },
      { text: `${ROLLOVER_TOKEN}\nsummary` },
    );
    return { data: true };
  };
  hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);
  const report = [
    "task_id=task-batch-continuation-r1",
    "source_manifest=src/plugin/continuation.ts,test/continuation.test.ts",
    "operation_manifest=operation-manifest.json",
    "validation=npm test|exit 0|fingerprint-a;git diff --check|exit 0|fingerprint-b",
    "batchTarget=3 batchAttempted=2 batchCommitted=1 batchReconciled=1",
    "blocker=none next=independent-unit-3",
  ].join("\n");
  await hooks.textComplete({ sessionID: "ses_root" }, { text: report });
  await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR });
  await settle();

  await Promise.all([
    hooks.sessionIdle("ses_root"),
    hooks.sessionCompacted("ses_root"),
    hooks.textComplete({ sessionID: "ses_root" }, { text: `${ROLLOVER_TOKEN}\nlate duplicate` }),
  ]);
  assert.equal(host.summarizeCalls.length, 1);
  assert.equal(host.promptCalls.length, 1);
  assert.equal(host.promptCalls[0]!.id, "ses_root");
  assert.match(host.promptCalls[0]!.text, new RegExp(report.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
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

test("child and foreign sessions reject every resume trigger without promotion", async () => {
  for (const [id, identity, contextAgent] of [
    ["ses_child", { agent: COORDINATOR, parentID: "ses_root" }, COORDINATOR],
    ["ses_foreign", { agent: "foreign-coordinator" }, "foreign-coordinator"],
  ] as const) {
    const host = fakeHost(identity);
    const hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);
    const result = await hooks.tool.execute({}, { sessionID: id, agent: contextAgent });
    assert.match(result, /^SORTIE_CONTINUATION_REJECTED:/u);
    await hooks.textComplete({ sessionID: id }, { text: `blocked checkpoint\n${CONTINUATION_MARKER}` });
    await Promise.all([hooks.sessionIdle(id), hooks.sessionCompacted(id)]);
    await hooks.textComplete({ sessionID: id }, { text: `${ROLLOVER_TOKEN}\nforeign summary` });
    await settle();
    assert.deepEqual(host.summarizeCalls, [], `${id} must not compact`);
    assert.deepEqual(host.promptCalls, [], `${id} must not resume or become root`);
  }
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
  assert.equal(
    await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR }),
    "SORTIE_CONTINUATION_REJECTED: limit-reached",
    "a fourth dispatch in the same synthetic batch stays rejected",
  );
  await settle();
  assert.equal(host.summarizeCalls.length, 3);
  assert.equal(host.promptCalls.length, 2);
});

test("blocked units continue only by preserving the coordinator report below batchTarget", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  const hooks = createContinuationHooks(host.client, "/project", { ...POLICY, maxAutoContinues: 2 }, FAST);
  const reports = [
    "batchTarget=3 batchAttempted=1 batchCommitted=0 batchReconciled=0 blocker=unit-1 blocked next=independent-unit-2",
    "batchTarget=3 batchAttempted=2 batchCommitted=1 batchReconciled=0 blocker=unit-1 blocked next=independent-unit-3",
  ];
  for (const report of reports) {
    await hooks.textComplete({ sessionID: "ses_root" }, { text: report });
    assert.equal(
      await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR }),
      "SORTIE_COMPACT_AND_CONTINUE_QUEUED",
    );
    await settle();
    hooks.observeModel("ses_root", { providerID: "openai", modelID: "gpt-5.6-luna" }, true);
  }
  assert.equal(host.promptCalls.length, 2);
  assert.match(host.promptCalls[0]!.text, /blocker=unit-1 blocked next=independent-unit-2/);
  assert.match(host.promptCalls[1]!.text, /blocker=unit-1 blocked next=independent-unit-3/);
});

test("resume payload preserves every authoritative checkpoint field and validation order", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  const hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);
  const fields = [
    "task_id: task-batch-continuation-r1",
    "source_manifest: src/plugin/continuation.ts,test/continuation.test.ts",
    "operation_manifest: M:\\_work\\_Sortie-dogs\\operation-manifest.json",
    "validation[0]: npm test|exit 0|fingerprint-test",
    "validation[1]: git diff --check|exit 0|fingerprint-diff",
    "batchTarget: 3 / batchAttempted: 2 / batchCommitted: 1 / batchReconciled: 1",
    "blocker: unit-1|owner=dog-worker|reason=external",
    "next_action: independent-unit-3",
  ];
  await hooks.textComplete({ sessionID: "ses_root" }, { text: fields.join("\n") });
  await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR });
  await settle();
  const payload = host.promptCalls[0]!.text;
  for (const field of fields) assert.ok(payload.includes(field), `missing checkpoint field: ${field}`);
  assert.ok(payload.indexOf(fields[3]!) < payload.indexOf(fields[4]!), "validation history order changed");
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

test("ordinary terminal text does not force compaction and real user turns reset the continuation budget", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  const hooks = createContinuationHooks(host.client, "/project", { ...POLICY, maxAutoContinues: 1 }, FAST);
  await hooks.textComplete({ sessionID: "ses_root" }, { text: "terminal with no continuation" });
  await settle();
  assert.deepEqual([host.summarizeCalls.length, host.promptCalls.length], [0, 0]);

  assert.equal(await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR }), "SORTIE_COMPACT_AND_CONTINUE_QUEUED");
  await settle();
  hooks.observeModel("ses_root", { providerID: "openai", modelID: "gpt-5.6-luna" }, false);
  assert.equal(await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR }), "SORTIE_COMPACT_AND_CONTINUE_QUEUED");
});

test("synthetic continuation turns do not reset the continuation budget", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  const hooks = createContinuationHooks(host.client, "/project", { ...POLICY, maxAutoContinues: 1 }, FAST);
  assert.equal(await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR }), "SORTIE_COMPACT_AND_CONTINUE_QUEUED");
  await settle();
  hooks.observeModel("ses_root", { providerID: "openai", modelID: "gpt-5.6-luna" }, true);
  assert.equal(await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR }), "SORTIE_COMPACT_QUEUED: auto-continue limit reached");
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

  const output: { context?: string[]; prompt?: string } = {};
  await hooks.sessionCompacting({ sessionID: "ses_root" }, output);
  const prompt = output.prompt ?? "";
  assert.ok(prompt.includes(ROLLOVER_TOKEN));
  assert.match((output.context ?? []).join("\n"), /Sortie authoritative latest coordinator final report follows/);
  for (const preserved of [
    "task identity",
    "batchTarget",
    "batchAttempted",
    "batchCommitted",
    "batchReconciled",
    "inventory fingerprint",
    "bounded candidate queue",
    "status",
    "ordering",
    "implementation root",
    "acceptance fingerprint",
    "acceptance hashes",
    "acceptance digest",
    "pending tracker updates",
    "tracker flush state",
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

test("session idle resumes non-terminal progress at most twice per context segment", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  const hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);
  hooks.observeModel("ses_root", { providerID: "openai", modelID: "gpt-5.6-terra" });

  await hooks.textComplete(
    { sessionID: "ses_root" },
    { text: "📊 進行中: task — 45%\n➡️ 次action: workerをdispatchする" },
  );
  await hooks.sessionIdle("ses_root");
  assert.equal(host.promptCalls.length, 1);
  assert.ok(host.promptCalls[0]!.text.startsWith(STEP_CONTINUE_PREFIX));

  for (const percent of [55, 65]) {
    hooks.observeModel("ses_root", { providerID: "openai", modelID: "gpt-5.6-terra" }, true);
    await hooks.textComplete(
      { sessionID: "ses_root" },
      { text: `📊 進行中: task — ${percent}%\n➡️ 次action: 次toolを実行する` },
    );
    await hooks.sessionIdle("ses_root");
  }
  assert.equal(host.promptCalls.length, 2, "one context segment has a bounded recovery budget");

  hooks.observeModel("ses_root", { providerID: "openai", modelID: "gpt-5.6-terra" });
  await hooks.textComplete(
    { sessionID: "ses_root" },
    { text: "➡️ next_action: resume after the new user turn" },
  );
  await hooks.sessionIdle("ses_root");
  assert.equal(host.promptCalls.length, 3, "a real user turn resets the recovery budget");
});

test("a successful compaction resume refreshes the bounded step recovery segment", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  const hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);
  hooks.observeModel("ses_root", { providerID: "openai", modelID: "gpt-5.6-terra" });

  for (const percent of [35, 45, 55]) {
    await hooks.textComplete(
      { sessionID: "ses_root" },
      { text: `📊 進行中: task — ${percent}%\n➡️ 次action: 次toolを実行する` },
    );
    await hooks.sessionIdle("ses_root");
    hooks.observeModel("ses_root", { providerID: "openai", modelID: "gpt-5.6-terra" }, true);
  }
  assert.equal(host.promptCalls.length, 2, "the first context segment exhausts its two recoveries");

  await hooks.textComplete(
    { sessionID: "ses_root" },
    { text: "📊 進行中: task — 100% | committed 1/3; attempted 1/3; reconciled 0 | continuation: none" },
  );
  assert.equal(
    await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR }),
    "SORTIE_COMPACT_AND_CONTINUE_QUEUED",
  );
  await settle();
  assert.equal(host.promptCalls.length, 3);
  assert.ok(host.promptCalls[2]!.text.startsWith(AUTO_CONTINUE_PREFIX));

  hooks.observeModel("ses_root", { providerID: "openai", modelID: "gpt-5.6-terra" }, true);
  await hooks.textComplete(
    { sessionID: "ses_root" },
    { text: "📊 進行中: next task — 80%\n➡️ 次action: commit後のterminal reportを出す" },
  );
  await hooks.sessionIdle("ses_root");
  assert.equal(host.promptCalls.length, 4, "the post-compaction segment receives a fresh bounded recovery");
  assert.ok(host.promptCalls[3]!.text.startsWith(STEP_CONTINUE_PREFIX));

  hooks.observeModel("ses_root", { providerID: "openai", modelID: "gpt-5.6-terra" }, true);
  await hooks.textComplete(
    { sessionID: "ses_root" },
    { text: "📊 進行中: next task — 85%\n➡️ 次action: terminal reportを準備する" },
  );
  await hooks.sessionIdle("ses_root");
  assert.equal(host.promptCalls.length, 5, "the real user turn permits four step recoveries total");

  assert.equal(
    await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR }),
    "SORTIE_COMPACT_AND_CONTINUE_QUEUED",
  );
  await settle();
  assert.equal(host.promptCalls.length, 6);
  assert.ok(host.promptCalls[5]!.text.startsWith(AUTO_CONTINUE_PREFIX));

  hooks.observeModel("ses_root", { providerID: "openai", modelID: "gpt-5.6-terra" }, true);
  await hooks.textComplete(
    { sessionID: "ses_root" },
    { text: "📊 進行中: final segment — 90%\n➡️ 次action: fifth recovery must stay blocked" },
  );
  await hooks.sessionIdle("ses_root");
  assert.equal(host.promptCalls.length, 6, "another compaction cannot bypass the per-turn total");
});

test("text completion recovers when a one-shot host omits session idle", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  const hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);
  hooks.observeModel("ses_cli", { providerID: "openai", modelID: "gpt-5.6-terra" });
  await hooks.textComplete(
    { sessionID: "ses_cli" },
    { text: "📊 進行中: CLI fixture — 45% (deterministic pause) | committed 0/3; attempted 0/3; reconciled 0 | continuation: none" },
  );
  await settle();
  assert.equal(host.promptCalls.length, 1);
  assert.ok(host.promptCalls[0]!.text.startsWith(STEP_CONTINUE_PREFIX));

  const eventHost = fakeHost({ agent: COORDINATOR });
  const eventHooks = createContinuationHooks(eventHost.client, "/project", POLICY, FAST);
  eventHooks.observeModel("ses_event", { providerID: "openai", modelID: "gpt-5.6-terra" });
  await eventHooks.textComplete(
    { sessionID: "ses_event" },
    { text: "📊 進行中: event fixture — 45% | committed 0/3; attempted 0/3; reconciled 0 | continuation: none" },
  );
  await eventHooks.sessionIdle("ses_event");
  await settle();
  assert.equal(eventHost.promptCalls.length, 1, "real idle and fallback share one recovery state");
});

test("text completion compacts and resumes a checkpoint before a one-shot host can exit", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  let hooks!: ReturnType<typeof createContinuationHooks>;
  host.client.session!.summarize = async (request) => {
    host.summarizeCalls.push({ id: request.path.id, body: request.body });
    await hooks.sessionCompacting({ sessionID: request.path.id }, {});
    await hooks.textComplete(
      { sessionID: request.path.id },
      {
        text: `${ROLLOVER_TOKEN}\n\n## 未達のユーザー要求\n- next candidate\n\n` +
          "## task identity と制約\n- cli fixture\n\n## manifest\n- fixture.txt\n\n" +
          "## validation履歴\n- none\n\n## batch counters\n- attempted 1/3\n\n" +
          "## tracker batch state\n- none\n\n## 未解決blocker\n- none\n\n## 次action\n- continue",
      },
    );
    return { data: true };
  };
  hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);
  hooks.observeModel("ses_cli_checkpoint", { providerID: "openai", modelID: "gpt-5.6-terra" });

  await hooks.textComplete(
    { sessionID: "ses_cli_checkpoint" },
    {
      text: "📊 進行中: CLI checkpoint — 100% (Project checkpoint) | " +
        "バッチ: committed 1/3; attempted 1/3; reconciled 0 | continuation: required",
    },
  );
  await settle();

  assert.equal(host.summarizeCalls.length, 1);
  assert.equal(host.promptCalls.length, 1);
  assert.equal(host.promptCalls[0]!.id, "ses_cli_checkpoint");
  assert.equal(host.promptCalls[0]!.agent, COORDINATOR);
  assert.ok(host.promptCalls[0]!.text.startsWith(AUTO_CONTINUE_PREFIX));
});

test("forgotten session cannot resume after delayed identity lookup", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  let markIdentityStarted!: () => void;
  let releaseIdentity!: () => void;
  const identityStarted = new Promise<void>((resolve) => { markIdentityStarted = resolve; });
  const identityReleased = new Promise<void>((resolve) => { releaseIdentity = resolve; });
  const mutableSession = host.client.session as {
    get: NonNullable<NonNullable<ContinuationClient["session"]>["get"]>;
  };
  mutableSession.get = async () => {
    markIdentityStarted();
    await identityReleased;
    return { data: { agent: COORDINATOR } };
  };
  const hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);
  hooks.observeModel("ses_forgotten", { providerID: "openai", modelID: "gpt-5.6-terra" });
  await hooks.textComplete(
    { sessionID: "ses_forgotten" },
    { text: "📊 進行中: forgotten — 45% | attempted 0/3 | continuation: none" },
  );
  await identityStarted;
  hooks.forgetSession("ses_forgotten");
  releaseIdentity();
  await settle();
  assert.equal(host.promptCalls.length, 0);
});

test("session idle never resumes a terminal checkpoint", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  const hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);
  hooks.observeModel("ses_root", { providerID: "openai", modelID: "gpt-5.6-terra" });
  await hooks.textComplete(
    { sessionID: "ses_root" },
    { text: "✅ status: BLOCKED; task_id: task\n➡️ next_action: user approval" },
  );
  await hooks.sessionIdle("ses_root");
  assert.equal(host.promptCalls.length, 0);
});

test("session idle recovers in-progress output without a next action", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  const hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);
  hooks.observeModel("ses_root", { providerID: "openai", modelID: "gpt-5.6-terra" });
  await hooks.textComplete(
    { sessionID: "ses_root" },
    { text: "📊 進行中: task — 45%" },
  );
  await hooks.sessionIdle("ses_root");
  assert.equal(host.promptCalls.length, 1);
  assert.ok(host.promptCalls[0]!.text.startsWith(STEP_CONTINUE_PREFIX));
  assert.match(host.promptCalls[0]!.text, /next_actionが欠落していれば/);
});

test("session idle compacts a terminal unit checkpoint below the batch target", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  let markMainSummaryStarted!: () => void;
  let releaseMainSummary!: () => void;
  const mainSummaryStarted = new Promise<void>((resolve) => { markMainSummaryStarted = resolve; });
  const mainSummaryReleased = new Promise<void>((resolve) => { releaseMainSummary = resolve; });
  const mutableMainSession = host.client.session as {
    summarize: NonNullable<NonNullable<ContinuationClient["session"]>["summarize"]>;
  };
  mutableMainSession.summarize = async (request) => {
    host.summarizeCalls.push({ id: request.path.id, body: request.body });
    markMainSummaryStarted();
    await mainSummaryReleased;
    return { data: true };
  };
  const hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);
  hooks.observeModel("ses_root", { providerID: "openai", modelID: "gpt-5.6-terra" });
  await hooks.textComplete(
    { sessionID: "ses_root" },
    { text: "📊 進行中: Release 03 — 100% (Project checkpoint) | バッチ: committed 1/3; attempted 1/3; reconciled 0" },
  );
  await mainSummaryStarted;
  const compacting: { context?: string[]; prompt?: string } = {};
  await hooks.sessionCompacting({ sessionID: "ses_root" }, compacting);
  assert.match((compacting.context ?? []).join("\n"), /Preserve unmet user requirements, ordered scope, and no-stop constraints/);
  assert.match(compacting.prompt ?? "", /recovery report overrides only terminal outcomes and batch counters/i);
  assert.doesNotMatch(compacting.prompt ?? "", /outcomes and next action override older context/i);
  await hooks.textComplete(
    { sessionID: "ses_root" },
    { text: `${ROLLOVER_TOKEN}

## 未達のユーザー要求
- Release 04から10を順次停止せず完了

## task identity と制約
- release-program-r1 /project

## manifest
- source_manifest: none

## validation履歴
- なし

## batch counters
- batchTarget: 10 / batchAttempted: 1 / batchCommitted: 1 / batchReconciled: 0

## tracker batch state
- inventoryFingerprint: inv-1 / candidateQueue: Release 04 | status ready | ordering 4 | implementation root /project | acceptance fingerprint fp-4 | acceptance hashes h-4 | redacted acceptance digest ship release
- pendingTrackerUpdates: Release 03 done / flushState: pending

## 未解決blocker
- なし

## 次action
- Release 04へ進む` },
  );
  releaseMainSummary();
  await settle();
  assert.equal(host.summarizeCalls.length, 1);
  assert.equal(host.promptCalls.length, 1);
  assert.ok(host.promptCalls[0]!.text.startsWith(AUTO_CONTINUE_PREFIX));
  assert.match(host.promptCalls[0]!.text, /compaction summaryの未達user要求・ordered scope・no-stop制約を保持/);
  assert.match(host.promptCalls[0]!.text, /➡️ 次action: 未達user要求の次の独立candidateへ進む/);

  const markerHost = fakeHost({ agent: COORDINATOR });
  const markerHooks = createContinuationHooks(markerHost.client, "/project", POLICY, FAST);
  markerHooks.observeModel("ses_marker", { providerID: "openai", modelID: "gpt-5.6-terra" });
  await markerHooks.textComplete(
    { sessionID: "ses_marker" },
    { text: "📊 处理中: Release 04 — 100% (项目检查点) | committed 2/10; attempted 2/10; reconciled 0 | continuation: required" },
  );
  await settle();
  assert.equal(markerHost.summarizeCalls.length, 1, "protocol keys survive localized labels");

  const validationHost = fakeHost({ agent: COORDINATOR });
  const validationHooks = createContinuationHooks(validationHost.client, "/project", POLICY, FAST);
  validationHooks.observeModel("ses_validation", { providerID: "openai", modelID: "gpt-5.6-terra" });
  await validationHooks.textComplete(
    { sessionID: "ses_validation" },
    { text: "📊 進行中: old — 100% (Project checkpoint) | committed 1/3; attempted 1/3; reconciled 0 | continuation: required\n📊 進行中: Release 03 — 100% (Project checkpoint) | committed 1/3; attempted 1/3; reconciled 0 | continuation: none" },
  );
  await validationHooks.sessionIdle("ses_validation");
  await settle();
  assert.equal(validationHost.summarizeCalls.length, 0, "non-checkpoint 100% cannot compact");
  assert.equal(validationHost.promptCalls.length, 1);
  assert.ok(validationHost.promptCalls[0]!.text.startsWith(STEP_CONTINUE_PREFIX));

  const nativeHost = fakeHost({ agent: COORDINATOR });
  let markNativeSummaryStarted!: () => void;
  let releaseNativeSummary!: () => void;
  const nativeSummaryStarted = new Promise<void>((resolve) => { markNativeSummaryStarted = resolve; });
  const nativeSummaryReleased = new Promise<void>((resolve) => { releaseNativeSummary = resolve; });
  const mutableNativeSession = nativeHost.client.session as {
    summarize: NonNullable<NonNullable<ContinuationClient["session"]>["summarize"]>;
  };
  mutableNativeSession.summarize = async (request) => {
    nativeHost.summarizeCalls.push({ id: request.path.id, body: request.body });
    markNativeSummaryStarted();
    await nativeSummaryReleased;
    return { data: true };
  };
  const nativeHooks = createContinuationHooks(nativeHost.client, "/project", POLICY, FAST);
  nativeHooks.observeModel("ses_native", { providerID: "openai", modelID: "gpt-5.6-terra" });
  await nativeHooks.textComplete(
    { sessionID: "ses_native" },
    { text: "📊 進行中: native — 100% (Project checkpoint) | committed 1/3; attempted 1/3; reconciled 0 | continuation: required" },
  );
  await nativeSummaryStarted;
  await nativeHooks.sessionCompacting({ sessionID: "ses_native" }, {});
  await nativeHooks.textComplete(
    { sessionID: "ses_native" },
    { text: `## Purpose
- ordered sequenceを完了する

## Decisions
- current checkpoint完了

## source_manifest
- fixture.txt | read-only | fixture | preserve scope | unchanged

## Remaining
- next independent candidate | pending | same rootで継続

## Validation
- none | fixture | none | pending

## Next action
- next independent candidateへ進む

## Files read
- fixture.txt | fixture` },
  );
  releaseNativeSummary();
  await settle();
  assert.equal(nativeHost.promptCalls.length, 1, "OpenCode native compaction summary resumes recovery");
  assert.ok(nativeHost.promptCalls[0]!.text.startsWith(AUTO_CONTINUE_PREFIX));

  async function assertMalformedRecovery(summary: string, sessionID: string): Promise<void> {
    const malformedHost = fakeHost({ agent: COORDINATOR });
    let markSummaryStarted!: () => void;
    let releaseSummary!: () => void;
    const summaryStarted = new Promise<void>((resolve) => { markSummaryStarted = resolve; });
    const summaryReleased = new Promise<void>((resolve) => { releaseSummary = resolve; });
    const mutableSession = malformedHost.client.session as {
      summarize: NonNullable<NonNullable<ContinuationClient["session"]>["summarize"]>;
    };
    mutableSession.summarize = async (request) => {
      malformedHost.summarizeCalls.push({ id: request.path.id, body: request.body });
      markSummaryStarted();
      await summaryReleased;
      return { data: true };
    };
    const malformedHooks = createContinuationHooks(malformedHost.client, "/project", POLICY, FAST);
    malformedHooks.observeModel(sessionID, { providerID: "openai", modelID: "gpt-5.6-terra" });
    await malformedHooks.textComplete(
      { sessionID },
      { text: "📊 進行中: malformed — 100% (Project checkpoint) | attempted 1/3 | continuation: required" },
    );
    await summaryStarted;
    await malformedHooks.sessionCompacting({ sessionID }, {});
    await malformedHooks.textComplete({ sessionID }, { text: summary });
    releaseSummary();
    await settle();
    assert.equal(malformedHost.promptCalls.length, 0, "recovery cannot resume from malformed scope");
  }
  await assertMalformedRecovery(
    `${ROLLOVER_TOKEN}\nsummary without required recovery headings`,
    "ses_malformed_sortie",
  );
  await assertMalformedRecovery(
    `## Purpose
- ordered work
## Decision
- checkpoint done
## source_manifest
- fixture.txt
## Remaining
${"- "}
## Validation
- none
## Next
${"- "}
## Files read
- fixture.txt`,
    "ses_malformed_native",
  );

  const finalHost = fakeHost({ agent: COORDINATOR });
  const finalHooks = createContinuationHooks(finalHost.client, "/project", POLICY, FAST);
  finalHooks.observeModel("ses_final", { providerID: "openai", modelID: "gpt-5.6-terra" });
  await finalHooks.textComplete(
    { sessionID: "ses_final" },
    { text: "📊 進行中: Release 05 — 100% (Project checkpoint) | バッチ: committed 3/3; attempted 3/3; reconciled 0 | continuation: none" },
  );
  await finalHooks.sessionIdle("ses_final");
  await settle();
  assert.equal(finalHost.summarizeCalls.length, 0, "a complete batch remains terminal");
  assert.equal(finalHost.promptCalls.length, 0);
});

test("session idle never promotes a child or foreign session into the coordinator", async () => {
  for (const session of [
    { agent: COORDINATOR, parentID: "ses_parent" },
    { agent: "dog-worker" },
  ]) {
    const host = fakeHost(session);
    const hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);
    hooks.observeModel("ses_other", { providerID: "openai", modelID: "gpt-5.6-terra" });
    await hooks.textComplete(
      { sessionID: "ses_other" },
      { text: "➡️ next_action: continue foreign work" },
    );
    await hooks.sessionIdle("ses_other");
    assert.equal(host.promptCalls.length, 0);
  }
});

test("session idle leaves step recovery disabled with continuation policy", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  const hooks = createContinuationHooks(host.client, "/project", { ...POLICY, enabled: false }, FAST);
  hooks.observeModel("ses_root", { providerID: "openai", modelID: "gpt-5.6-terra" });
  await hooks.textComplete(
    { sessionID: "ses_root" },
    { text: "➡️ next_action: must remain manual" },
  );
  await hooks.sessionIdle("ses_root");
  assert.equal(host.promptCalls.length, 0);
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
  assert.equal(completed.enabled, false, "the owned compaction cannot race a duplicate host resume");
  hooks.observeModel("ses_root", { providerID: "openai", modelID: "gpt-5.6-luna" }, true);
  const stillOwned = { enabled: true };
  await hooks.compactionAutoContinue({ sessionID: "ses_root", overflow: false }, stillOwned);
  assert.equal(stillOwned.enabled, false, "synthetic prompt observation cannot reopen the race");
  await hooks.textComplete({ sessionID: "ses_root" }, { text: "resumed unit checkpoint" });
  const resumed = { enabled: true };
  await hooks.compactionAutoContinue({ sessionID: "ses_root", overflow: false }, resumed);
  assert.equal(resumed.enabled, true, "the observed resumed turn releases host auto-continue");
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

test("an exhausted step budget cannot bypass a disabled checkpoint continuation gate", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  const hooks = createContinuationHooks(host.client, "/project", POLICY, FAST);
  await hooks.textComplete(
    { sessionID: "ses_root", allowCheckpointContinuation: false },
    { text: "最大step数に到達しました。残作業: 次の独立unit。" },
  );
  await settle();
  assert.equal(host.summarizeCalls.length, 0);
  assert.equal(host.promptCalls.length, 0);
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

test("fake host prompt rejection has a bounded retry budget and never recompacts", async () => {
  const host = fakeHost({ agent: COORDINATOR });
  let attempts = 0;
  host.client.session!.promptAsync = async () => {
    attempts += 1;
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
    assert.equal(host.summarizeCalls.length, 1);
    assert.equal(attempts, FAST.scheduleAttempts + 1);
    assert.equal(hooks.blocksTool("ses_root"), false);
    const autoContinue = { enabled: true };
    await hooks.compactionAutoContinue({ sessionID: "ses_root", overflow: false }, autoContinue);
    assert.equal(autoContinue.enabled, true, "retry exhaustion releases host auto-continue");
    await Promise.all([hooks.sessionIdle("ses_root"), hooks.sessionCompacted("ses_root")]);
    assert.equal(attempts, FAST.scheduleAttempts + 1, "late host events cannot restart retries");
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
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

  const nullParent = fakeHost({ parentID: undefined });
  (nullParent.client.session!.get as NonNullable<ContinuationClient["session"]>["get"]) = async () => ({
    data: { parentID: null },
  });
  const nullParentHooks = createContinuationHooks(nullParent.client, "/project", POLICY, FAST);
  assert.equal(
    await nullParentHooks.tool.execute({}, { sessionID: "ses_null_child", agent: COORDINATOR }),
    "SORTIE_CONTINUATION_REJECTED: child-session",
  );
});

test("a host without the continuation client never resumes anything", async () => {
  const hooks = createContinuationHooks(undefined, "/project", POLICY, FAST);
  // The tool still answers deterministically instead of throwing into the coordinator turn.
  const answer = await hooks.tool.execute({}, { sessionID: "ses_root", agent: COORDINATOR });
  assert.equal(answer, "SORTIE_CONTINUATION_REJECTED: identity-unavailable");
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
