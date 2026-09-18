import assert from "node:assert/strict";
import test from "node:test";
// The audit adapter is a repository script, not shipped runtime code. It is imported directly so the
// aggregation rules are proved without a host database.
import { aggregateRun, collectTree, normalizeTokens, phaseForAgent, prefixReuse, proposalPacketStatus, proposalTaskStatus } from "../scripts/operator-run-cost-audit.mjs";

const ROOT = "ses_root";
const at = (iso: string) => Date.parse(iso);
function tokens(input: number, output = 0, reasoning = 0, cacheRead = 0, cacheWrite = 0) {
  return { input, output, reasoning, cacheRead, cacheWrite };
}
function sessions() {
  return [
    { id: ROOT, parentID: null, agent: "dog-operator", title: "root" },
    { id: "ses_proposal", parentID: ROOT, agent: "dogs-coordinator", title: "proposal child" },
    { id: "ses_worker", parentID: "ses_proposal", agent: "dog-worker-v010", title: "nested worker" },
    { id: "ses_review", parentID: "ses_worker", agent: "dog-reviewer-v010", title: "nested reviewer" },
    { id: "ses_other_root", parentID: null, agent: "dog-operator", title: "unrelated root" },
    { id: "ses_other_child", parentID: "ses_other_root", agent: "dogs-coordinator", title: "unrelated child" },
    { id: "ses_cycle_a", parentID: "ses_cycle_b", agent: "dog-worker-v010", title: "cycle a" },
    { id: "ses_cycle_b", parentID: "ses_cycle_a", agent: "dog-worker-v010", title: "cycle b" },
  ];
}
function toolParts() {
  return [
    { sessionID: ROOT, tool: "read", status: "completed", startedMs: at("2026-09-17T00:01:00Z"), path: "src/a.ts", outputBytes: 100, ranged: true },
    { sessionID: ROOT, tool: "read", status: "completed", startedMs: at("2026-09-17T00:01:30Z"), path: "src/a.ts", outputBytes: 100, ranged: false },
    { sessionID: "ses_proposal", tool: "read", status: "error", startedMs: at("2026-09-17T00:06:00Z"), path: "src/missing.ts", outputBytes: 0, ranged: false },
    { sessionID: "ses_other_child", tool: "read", status: "completed", startedMs: at("2026-09-17T00:06:10Z"), path: "src/foreign.ts", outputBytes: 9999, ranged: false },
    { sessionID: ROOT, tool: "sortie_v010_begin_operator_proposal", status: "completed",
      startedMs: at("2026-09-17T00:05:00Z"), endedMs: at("2026-09-17T00:05:01Z") },
    { sessionID: ROOT, tool: "task", status: "completed", startedMs: at("2026-09-17T00:05:05Z"), endedMs: at("2026-09-17T00:10:00Z"),
      proposalChild: true, proposalSubmitted: true },
    { sessionID: ROOT, tool: "sortie_v010_approve_operator_proposal", status: "completed",
      startedMs: at("2026-09-17T00:14:00Z"), endedMs: at("2026-09-17T00:15:00Z") },
    { sessionID: ROOT, tool: "sortie_v010_complete_operator", status: "completed",
      startedMs: at("2026-09-17T00:30:00Z"), endedMs: at("2026-09-17T00:30:01Z") },
  ];
}
function messages() {
  const astra = { providerID: "openai", modelID: "gpt-6-astra", variant: "low", agent: "dog-operator" };
  return [
    { id: "m-intake", sessionID: ROOT, role: "assistant", ...astra, createdMs: at("2026-09-17T00:02:00Z"), tokens: tokens(1000, 100), cost: null },
    { id: "m-proposal-root", sessionID: ROOT, role: "assistant", ...astra, createdMs: at("2026-09-17T00:06:00Z"), tokens: tokens(2000, 200), cost: null },
    { id: "m-approval", sessionID: ROOT, role: "assistant", ...astra, createdMs: at("2026-09-17T00:12:00Z"), tokens: tokens(3000, 300), cost: null },
    { id: "m-longcontext", sessionID: ROOT, role: "assistant", ...astra, createdMs: at("2026-09-17T00:16:00Z"), tokens: tokens(300_000), cost: null },
    { id: "m-final", sessionID: ROOT, role: "assistant", ...astra, createdMs: at("2026-09-17T00:31:00Z"), tokens: tokens(500, 50), cost: null },
    { id: "m-user", sessionID: ROOT, role: "user", createdMs: at("2026-09-17T00:00:30Z"), tokens: null, cost: null },
    { id: "m-child", sessionID: "ses_proposal", role: "assistant", providerID: "openai", modelID: "gpt-5.6-terra",
      variant: "max", agent: "dogs-coordinator", createdMs: at("2026-09-17T00:07:00Z"), tokens: tokens(10_000, 1000), cost: null },
    { id: "m-child", sessionID: "ses_proposal", role: "assistant", providerID: "openai", modelID: "gpt-5.6-terra",
      variant: "max", agent: "dogs-coordinator", createdMs: at("2026-09-17T00:07:00Z"), tokens: tokens(10_000, 1000), cost: null },
    { id: "m-worker", sessionID: "ses_worker", role: "assistant", providerID: "openai", modelID: "gpt-5.6-sol",
      agent: "dog-worker-v010", createdMs: at("2026-09-17T00:20:00Z"), tokens: tokens(4000, 400), cost: null },
    { id: "m-review", sessionID: "ses_review", role: "assistant", providerID: "openai", modelID: "gpt-5.6-sol",
      agent: "dog-reviewer-v010", createdMs: at("2026-09-17T00:25:00Z"), tokens: tokens(2000, 200), cost: 0.5 },
    { id: "m-unknown-model", sessionID: "ses_worker", role: "assistant", providerID: "openai", modelID: "gpt-9-unreleased",
      agent: "dog-worker-v010", createdMs: at("2026-09-17T00:21:00Z"), tokens: tokens(1000, 100), cost: null },
    { id: "m-pending", sessionID: "ses_worker", role: "assistant", providerID: "openai", modelID: "gpt-5.6-sol",
      agent: "dog-worker-v010", createdMs: at("2026-09-17T00:22:00Z"), tokens: null, cost: null },
    { id: "m-foreign", sessionID: "ses_other_child", role: "assistant", providerID: "openai", modelID: "gpt-6-astra",
      agent: "dogs-coordinator", createdMs: at("2026-09-17T00:08:00Z"), tokens: tokens(999_999, 9999), cost: null },
    { id: "m-cycle", sessionID: "ses_cycle_a", role: "assistant", providerID: "openai", modelID: "gpt-6-astra",
      agent: "dog-worker-v010", createdMs: at("2026-09-17T00:09:00Z"), tokens: tokens(777, 7), cost: null },
  ];
}
const input = () => ({ sessions: sessions(), messages: messages(), toolParts: toolParts() });

test("the audit walks every descendant, drops foreign roots, and keeps cycles out of the tree", () => {
  const { sessions: tree, cycles } = collectTree(sessions(), ROOT);
  assert.deepEqual(tree.map(session => `${session.depth}:${session.id}`),
    ["0:ses_root", "1:ses_proposal", "2:ses_worker", "3:ses_review"]);
  assert.deepEqual(cycles, []);
  const selfParent = [{ id: "ses_loop", parentID: "ses_loop", agent: "dog-operator" }];
  assert.deepEqual(collectTree(selfParent, "ses_loop").sessions.map(session => session.id), ["ses_loop"]);
  assert.throws(() => collectTree(sessions(), "ses_absent"), /root session not found/u);
});

test("role and packet classification never invents a phase it did not observe", () => {
  assert.equal(phaseForAgent("dogs-coordinator"), "proposal-investigation");
  assert.equal(phaseForAgent("dog-reviewer-v010"), "review");
  assert.equal(phaseForAgent("dog-advisor-v010"), "consultation");
  assert.equal(phaseForAgent("dog-luna-worker-v010"), "implementation");
  assert.equal(phaseForAgent("some-new-role"), "unclassified");
  assert.equal(phaseForAgent(undefined), "unclassified");
  assert.equal(proposalPacketStatus('{"status":"submitted"}'), "submitted");
  assert.equal(proposalPacketStatus('{"status":"investigating"}'), "investigating");
  assert.equal(proposalTaskStatus('{"status":"submitted"}'), "submitted");
  assert.equal(proposalTaskStatus('{"status":"awaiting-acceptance"}'), null,
    "an execution delegate packet is not a proposal Task");
  assert.equal(proposalPacketStatus("not json"), null);
  assert.equal(proposalPacketStatus("{broken"), null);
  assert.deepEqual(normalizeTokens({ input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } }),
    { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 });
  assert.deepEqual(normalizeTokens({ input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 }),
    { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 });
  assert.equal(normalizeTokens({ input: 1, output: 2 }), null, "incomplete usage must never become zero cost");
  assert.equal(normalizeTokens(null), null);
});

test("phase, role and model aggregates reconcile with the whole-tree total", () => {
  const report = aggregateRun(input(), { rootID: ROOT, asOfMs: at("2026-09-17T01:00:00Z") });
  assert.equal(report.integrity.phaseTokensMatchTotal, true);
  assert.equal(report.integrity.roleTokensMatchTotal, true);
  assert.equal(report.integrity.duplicateMessagesSkipped, 1);
  assert.equal(report.integrity.messagesOutsideTree, 2, "the unrelated root and the cycle must stay out");
  assert.equal(report.integrity.pendingUsageRequests, 1);
  assert.equal(report.integrity.unpricedRequests, 2, "unknown model and missing usage stay unpriced");
  assert.equal(report.integrity.partial, true);
  assert.equal(report.integrity.pricingCoverage, 0.8);
  assert.equal(report.total.requests, 10, "the duplicate is counted once and the user turn is not a request");
  const modelSum = Object.values(report.byModel).reduce((sum, bucket: any) => sum + bucket.tokens, 0);
  assert.equal(modelSum, report.total.tokens);
  const sessionSum = report.sessions.reduce((sum, session: any) => sum + session.usage.tokens, 0);
  assert.equal(sessionSum, report.total.tokens);
  assert.deepEqual(Object.keys(report.byRole).sort(),
    ["dog-reviewer-v010", "dog-worker-v010", "dogs-coordinator", "root:dog-operator"]);
  assert.equal(report.byPhase["review"].hostReportedUsd, 0.5, "host reported cost stays separate from the estimate");
});

test("root phases follow tool boundaries and a submitted proposal, not prose", () => {
  const report = aggregateRun(input(), { rootID: ROOT, asOfMs: at("2026-09-17T01:00:00Z") });
  assert.equal(report.byPhase["intake"].requests, 1);
  assert.equal(report.byPhase["proposal-investigation"].requests, 2, "root investigation plus the deduped child");
  assert.equal(report.byPhase["semantic-comparison-approval"].requests, 1);
  assert.equal(report.byPhase["implementation"].requests, 4, "approval, long context, nested worker and unknown model");
  assert.equal(report.byPhase["review"].requests, 1);
  assert.equal(report.byPhase["final-acceptance"].requests, 1);
  assert.deepEqual(report.timeline.map(event => event.phase),
    ["proposal-investigation", "semantic-comparison-approval", "implementation", "final-acceptance"]);

  const unsubmitted = input();
  unsubmitted.toolParts = unsubmitted.toolParts.map(part => part.tool === "task" ? { ...part, proposalSubmitted: false } : part);
  const failed = aggregateRun(unsubmitted, { rootID: ROOT, asOfMs: at("2026-09-17T01:00:00Z") });
  assert.equal(failed.timeline[1]!.phase, "remediation", "a proposal Task without a submission is failure handling");
  assert.equal(Object.hasOwn(failed.byPhase, "semantic-comparison-approval"), false);

  const executionDelegate = input();
  executionDelegate.toolParts.push({ sessionID: ROOT, tool: "task", status: "completed",
    startedMs: at("2026-09-17T00:20:00Z"), endedMs: at("2026-09-17T00:29:00Z"), proposalChild: false,
    proposalSubmitted: false });
  const delegated = aggregateRun(executionDelegate, { rootID: ROOT, asOfMs: at("2026-09-17T01:00:00Z") });
  assert.equal(delegated.timeline.some(event => event.at === at("2026-09-17T00:29:00Z")), false,
    "an execution coordinator Task is not a failed proposal investigation");

  const rejectedApproval = input();
  rejectedApproval.toolParts = rejectedApproval.toolParts.map(part => part.tool === "sortie_v010_approve_operator_proposal"
    ? { ...part, status: "error" } : part);
  const rejected = aggregateRun(rejectedApproval, { rootID: ROOT, asOfMs: at("2026-09-17T01:00:00Z") });
  assert.equal(rejected.timeline[2]!.phase, "final-acceptance");
  assert.equal(Object.hasOwn(rejected.byPhase, "implementation"), true,
    "nested worker role remains implementation even when the failed root tool does not transition root phase");
  assert.equal(rejected.byPhase["semantic-comparison-approval"].requests, 2,
    "root messages remain in semantic comparison until a successful phase boundary");
});

test("a resumed window inherits the active phase and excludes earlier spend", () => {
  const report = aggregateRun(input(), { rootID: ROOT, startMs: at("2026-09-17T00:16:00Z"), asOfMs: at("2026-09-17T01:00:00Z") });
  assert.equal(report.inheritedPhase, "implementation");
  assert.equal(Object.hasOwn(report.byPhase, "intake"), false);
  assert.equal(report.byPhase["implementation"].requests, 4, "the long context request and every nested worker request");
  assert.equal(report.integrity.messagesOutsideWindow, 5);
  assert.equal(report.integrity.phaseTokensMatchTotal, true);
  assert.equal(report.reads.calls, 0, "earlier reads belong to the earlier window");
});

test("prefix reuse separates a stalled prompt cache from a normal cold start", () => {
  // Observed shapes from one v0.10.3 qualification run: the proposal child kept reporting the same
  // small cached head while its prompt grew past 129k, and the root reused nearly the whole prompt
  // after the usual first-continuation miss.
  const stalledShape = [[7640, 0], [9514, 2560], [37058, 2560], [103964, 2560], [118862, 2560], [129164, 2560]];
  const healthyShape = [[7222, 0], [8199, 0], [19799, 8064], [16996, 27776], [2083, 44672], [4655, 46592]];
  const requests = (sessionID: string, agent: string, shape: number[][]) => shape.map(([input, cacheRead], index) => ({
    id: `m-${sessionID}-${index}`, sessionID, role: "assistant", providerID: "openai", modelID: "gpt-5.6-terra",
    variant: "xhigh", agent, createdMs: at("2026-09-17T00:00:00Z") + index * 12_000,
    tokens: tokens(input!, 0, 0, cacheRead!), cost: null,
  }));
  const report = aggregateRun({
    sessions: [{ id: ROOT, parentID: null, agent: "dog-operator", title: "root" },
      { id: "ses_proposal", parentID: ROOT, agent: "dogs-coordinator", title: "proposal child" }],
    messages: [...requests(ROOT, "dog-operator", healthyShape), ...requests("ses_proposal", "dogs-coordinator", stalledShape)],
    toolParts: [],
  }, { rootID: ROOT, asOfMs: at("2026-09-17T01:00:00Z") });

  assert.deepEqual(report.cacheHealth.stalledSessions, ["ses_proposal"]);
  const child = report.cacheHealth.bySession["ses_proposal"];
  assert.equal(child.agent, "dogs-coordinator");
  assert.equal(child.comparisons, 5);
  assert.equal(child.stalledRequests, 5);
  assert.equal(child.prefixStalled, true);
  assert.equal(child.cacheRatio, 0.031);
  assert.deepEqual(child.ratios, [0.335, 0.212, 0.065, 0.024, 0.021]);

  const root = report.cacheHealth.bySession[ROOT];
  assert.equal(root.prefixStalled, false, "one cold continuation is not a broken prefix");
  assert.equal(root.stalledRequests, 1);
  assert.equal(root.median, 0.997);

  assert.equal(prefixReuse([]).comparisons, 0);
  assert.equal(prefixReuse([{ input: 10, cacheRead: 0 }]).prefixStalled, false);
  assert.equal(prefixReuse([{ input: 0, cacheRead: 0 }, { input: 5, cacheRead: 0 }]).comparisons, 0,
    "an empty prior prompt proves nothing about reuse");
});

test("long context pricing and read accounting stay observable", () => {
  const report = aggregateRun(input(), { rootID: ROOT, asOfMs: at("2026-09-17T01:00:00Z") });
  // 300,000 uncached input tokens exceed the 272,000 threshold, so the doubled input price applies.
  const astra = report.byModel["openai/gpt-6-astra:low"];
  const baseline = (1000 + 2000 + 3000 + 500) * 10 / 1e6 + (100 + 200 + 300 + 50) * 50 / 1e6;
  assert.equal(astra.estimatedUsd, Math.round((baseline + 300_000 * 10 * 2 / 1e6) * 1e6) / 1e6);
  assert.equal(report.reads.calls, 3, "foreign sessions contribute no reads");
  assert.equal(report.reads.errors, 1);
  assert.equal(report.reads.uniquePaths, 2);
  assert.equal(report.reads.repeatCalls, 1);
  assert.equal(report.reads.rangedCalls, 1);
  assert.equal(report.reads.bytes, 200);
  assert.equal(report.tools.calls["read"], 3);
  assert.equal(report.tools.errors["read"], 1);
});
