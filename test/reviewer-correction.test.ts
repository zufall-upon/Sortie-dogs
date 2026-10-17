import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { evaluate, whollyDisabled } from "./fixtures/native-v2-2018-contract.ts";
import { missionReviewIndependent } from "../dist/core/operator-mission.js";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { exec, type ObjectValue, fixture, initial, correctionReady, inlineReport, selfRecheck } from "./helpers/reviewer-correction-fixture.ts";

for (const operation of [false, true]) test(`initial Reviewer records findings, corrects and validates in one native Task without a handoff reread: ${operation ? "operation" : "implementation"}`, async () => {
  const f = await fixture();
  try {
    const started = await initial(f, { operation, keepReviewOpen: true, validation: ["node required-test.mjs", "node check.mjs"] });
    const promptID = started.mission.review!.promptID;
    const investigatedSystem = { sessionID: "author", agent: f.agents.author!.agent, tools: { read: {}, grep: {}, sortie_v010_repair_review: {} }, system: [], messages: [] };
    await f.context(investigatedSystem);
    const findings = "FINDINGS\nMedium: result.txt is wrong rather than ready; preserve result, checks and clean delivery.";
    const begun = await f.tool("author", "repair_review", { findings, reason: "", validation: [], validation_cwd: {} });
    assert.equal(begun.execution, "same-native-task");
    assert.match(begun.next_action, /Run inherited formal commands in order as exact separate foreground native shell calls/);
    assert.match(begun.next_action, /Run formatting and diagnostics separately; do not append undeclared shell commands, tee, redirect or wrapper/);
    assert.equal(begun.findings, findings);
    assert.equal(begun.task, undefined);
    const active = await f.run();
    assert.equal(active.units[0]!.directExecution?.actor, "author");
    assert.equal(active.units[0]!.reviewerCorrection?.promptID, promptID);
    const handoff = JSON.parse(await readFile(active.units[0]!.handoffPath, "utf8"));
    assert.equal(handoff.ext["sortie-dogs/mission-context"].correction_context.findings, findings);
    assert.equal(handoff.ext["sortie-dogs/mission-context"].correction_context.initialPrompt, undefined);
    assert.equal((await f.tool("author", "repair_review", { findings, reason: "", validation: [], validation_cwd: {} })).status, "correction-running");
    assert.equal((await f.missions.required("root")).corrections!.length, 1);
    const available = ["read", "shell", "patch", "sortie_v010_repair_review", "sortie_v010_finish_direct_unit", "sortie_v010_bind_write_gate"];
    assert(available.every(name => !whollyDisabled(name === "patch" ? "edit" : name, f.registry()[f.agents.author!.agent]!.permissions)), "controls survive the real native snapshot");
    const system = { sessionID: "author", agent: f.agents.author!.agent, tools: Object.fromEntries(available.map(name => [name, {}])), system: [], messages: [] };
    await f.context(system);
    assert.deepEqual(system.system, investigatedSystem.system, "repair admission does not replace the absolute instruction prefix; tool permissions still change normally");
    assert.doesNotMatch(JSON.stringify(system.system), /SORTIE_REVIEWER_CONTINUOUS_CONTEXT/);
    assert.match(JSON.stringify(system.messages), /SORTIE_REVIEWER_CONTINUOUS_CONTEXT/);
    assert.doesNotMatch(JSON.stringify(system), /SORTIE_WORKER_CONTEXT|Read the retained handoff/);
    assert.deepEqual(Object.keys(system.tools).sort(), available.sort());
    assert.equal((await f.tool("author", "finish_direct_unit")).status, "direct-unit-awaits-validation");
    await f.edit("author", "ready corrected");
    await f.shell("author", "node required-test.mjs");
    await f.shell("author", "node check.mjs");
    await f.shell("author", "git add -- result.txt");
    await f.shell("author", "git commit -m correction");
    assert.equal((await f.tool("author", "finish_direct_unit")).status, "correction-validated");
    const validatedSystem = { ...system, system: [] };
    await f.context(validatedSystem);
    assert.deepEqual(validatedSystem.system, system.system, "stable prefix remains through final self-recheck, without changing counters or phase");
    assert.deepEqual(validatedSystem.messages, system.messages, "current assignment/findings remain through final self-recheck");
    await assert.rejects(f.edit("author", "not allowed after settlement"), /mission-reviewer-readonly/);
    assert.equal((await f.missions.required("root")).review!.verdict, "findings", "finish tool is not a native terminal or approval");
    await assert.rejects(f.tool("root", "complete_mission"), /mission-review-required-or-stale/);
    const self = 'SELF_RECHECKED\nself_recheck: {"candidate":"current-validated","unresolved_findings":[],"residual_major":null}\nCompared the original requirements, retained defect and impacted results with actual checks and clean commit; author self-recheck, not independent approval.';
    const returned = JSON.parse(await f.finish(started.dispatch, "author", self));
    assert.equal(returned.status, "review-correction-recorded");
    assert.equal(returned.independent, false);
    assert(returned.acceptance_summary);
    const receipt = returned.completion_receipt;
    assert.equal(receipt.status, "review-correction-recorded");
    assert.equal(receipt.native_terminal.call_id, started.dispatch.id);
    assert.equal(receipt.native_terminal.prompt_id, promptID);
    assert.equal(receipt.native_terminal.child_session_id, "author");
    assert.equal(receipt.independent, false); assert.equal(receipt.accepted, false);
    assert.equal(receipt.formal_checks.length, 2);
    assert(receipt.formal_checks.every((check: ObjectValue) => check.call_id && check.exit === 0 && check.directory === f.directory));
    assert.match(receipt.next_action, /record and hold, stop without acceptance preparation/);
    const beforeProjection = await f.ledger(), recordedMission = await f.missions.required("root");
    await f.start();
    assert.deepEqual(JSON.parse((await f.hooks().backgroundResult!("root", started.dispatch.id, "author", promptID))!), receipt);
    assert.equal(await f.hooks().backgroundResult!("root", "other-call", "author", promptID), undefined);
    assert.equal(await f.hooks().backgroundResult!("root", started.dispatch.id, "other-child", promptID), undefined);
    assert.equal(await f.hooks().backgroundResult!("root", started.dispatch.id, "author", "other-prompt"), undefined);
    assert.deepEqual(await f.missions.required("root"), recordedMission, "historical receipt projection never rewrites the Mission");
    assert.deepEqual(await f.ledger(), beforeProjection, "receipt recovery never spends, settles or revalidates");
    assert.match(returned.next_action, /no routine operator_status/);
    const done = await f.missions.required("root");
    assert.equal(done.review!.verdict, "self-rechecked");
    assert.equal(done.review!.selfRecheck!.callID, started.dispatch.id);
    assert.equal(done.review!.selfRecheck!.promptID, promptID);
    assert.equal(done.corrections![0]!.inlineReview!.callID, started.dispatch.id);
    assert.deepEqual(done.execution, started.mission.execution, "correction retains the operation result without replaying it");
    assert.equal(f.history.author!.filter(message => message.type === "user").length, 1);
    const unit = (await f.run()).units[0]!;
    assert(unit.directExecution!.finishedAt);
    assert.equal(done.attempts!.at(-1)!.kind, "direct_execution");
    assert.equal(done.attempts!.at(-1)!.terminal, undefined, "no fabricated second native Task terminal");
    assert.equal(unit.reviewerCorrection!.checks!.length, 2);
    assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
    assert.equal((await f.ledger()).state.consumed_units, 2);
  } finally { await f.dispose(); }
});

for (const mode of ["live", "cold-reload"] as const) test(`continuous findings update retains complete correction assignment: ${mode}`, async () => {
  const f = await fixture();
  try {
    const original = "Original unchanged contract sentinel: preserve requested delivery and public behavior.";
    await initial(f, { keepReviewOpen: true, original, validation: ["node required-test.mjs", "node check.mjs"] });
    const first = "FINDINGS\nMedium: first exact retained defect.";
    await f.tool("author", "repair_review", { findings: first });
    const native: ObjectValue[] = [{ role: "user", content: [{ type: "text", text: "Independent initial Task" }] }];
    const context = () => ({ sessionID: "author", agent: f.agents.author!.agent, tools: {}, system: [], messages: [...native] });
    const before = context();
    await f.context(before);
    assert(JSON.stringify(before.messages).includes(original));
    const prior = structuredClone(before.messages);
    native.push({ role: "assistant", content: [{ type: "text", text: "New independent correction-impact observation" }] });
    if (mode === "cold-reload") await f.start();
    const extra = "FINDINGS\nMedium: second exact retained defect with newline\nand quoted \"detail\".";
    await f.tool("author", "repair_review", { findings: extra });
    const after = context();
    await f.context(after);
    assert.deepEqual(after.system, before.system, "stable role policy unaffected by new findings");
    assert.deepEqual(after.messages.slice(0, prior.length), prior, "previously sent state remains at its native boundary");
    assert.equal(after.messages[prior.length], native[1], "native message identity and ordering preserved");
    const latest = after.messages.at(-1) as ObjectValue;
    assert.equal(latest.role, "system");
    assert(JSON.stringify(latest).includes(original), "current state includes the complete original requirements");
    const text = latest.content.find((part: ObjectValue) => part.text.startsWith("SORTIE_REVIEWER_CONTINUOUS_CONTEXT\n"))?.text;
    assert(text, "assignment and exact cumulative findings share one current host-state block");
    assert.deepEqual(JSON.parse(text.split("\n")[1]).validation, ["node required-test.mjs", "node check.mjs"]);
    assert.equal(JSON.parse(text.split("\n")[1]).findings, `${first}\n\n${extra}`);
    const ledger = f.storage.get("v2-model-live-state:author") as ObjectValue;
    assert.equal(ledger.updates.flatMap((update: ObjectValue) => update.text).filter((text: string) => text.includes(original)).length, 2);
    const correction = (await f.missions.required("root")).corrections![0]!;
    assert.equal(correction.findings, `${first}\n\n${extra}`, "authoritative Mission findings not summarized or replaced");
    assert.equal(f.history.author!.filter(message => message.type === "user").length, 1);
  } finally { await f.dispose(); }
});

for (const mode of ["live", "cold-reload", "failed-native-recovery"] as const) test(`running continuous correction retains additional findings without redispatch: ${mode}`, async () => {
  const f = await fixture();
  try {
    const started = await initial(f, { keepReviewOpen: true, backgroundReview: mode === "cold-reload",
      validation: ["node required-test.mjs", "node check.mjs"] });
    if (mode === "cold-reload") await f.after(started.dispatch, "Native Review Job running", { sessionID: "author", status: "running" });
    const first = "FINDINGS\nMedium: result must be ready; preserve the initial investigation.";
    const extra = "FINDINGS\nAdditional Medium: ready output loses callback errors; preserve the independently reproduced behavior.";
    await f.tool("author", "repair_review", { findings: first });
    const originalContext = { sessionID: "author", agent: f.agents.author!.agent, tools: {}, system: [], messages: [] };
    await f.context(originalContext);
    await f.edit("author", "ready initial correction");
    await f.shell("author", "node required-test.mjs");
    const before = await f.run(), budget = (await f.ledger()).state;
    const handoff = await readFile(before.units[0]!.handoffPath, "utf8");
    if (mode === "cold-reload") await f.start();
    const continued = await f.tool("author", "repair_review", { findings: extra });
    assert.equal(continued.execution, "same-native-task");
    assert(continued.findings.includes(extra), "the real repeated native tool call must retain and return the new finding");
    await f.tool("author", "repair_review", { findings: extra });
    await f.tool("author", "repair_review", { findings: extra.replace(/^FINDINGS\n/u, "") });
    await f.tool("author", "repair_review");
    const mission = await f.missions.required("root"), after = await f.run();
    const correction = mission.corrections![0]!;
    assert.equal(mission.corrections!.length, 1);
    assert.equal(correction.findings, `${first}\n\n${extra}`, "exact retained submissions, idempotent header/no-header retries");
    assert.equal(mission.review!.result, first, "do not relabel a later author finding as the independent initial report");
    assert.equal(correction.reviewIdentity, before.units[0]!.reviewerCorrection!.reviewIdentity);
    assert.equal(after.runID, before.runID);
    assert.deepEqual(after.units[0]!.directExecution, before.units[0]!.directExecution);
    assert.deepEqual(after.units[0]!.reviewerCorrection, before.units[0]!.reviewerCorrection);
    assert.equal(await readFile(after.units[0]!.handoffPath, "utf8"), handoff, "immutable original handoff/check contract");
    assert.equal((await f.ledger()).state.consumed_units, budget.consumed_units);
    assert.equal((await f.ledger()).state.outstanding_reservations.length, budget.outstanding_reservations.length);
    const context = { sessionID: "author", agent: f.agents.author!.agent, tools: {}, system: [], messages: [] };
    await f.context(context);
    assert.deepEqual(context.system, originalContext.system, "additional findings and cold reconstruction preserve the original correction prefix");
    assert(JSON.stringify(context.messages).includes("Additional Medium"), "outgoing chronological system update reconstructs all known findings from durable state");
    assert(!JSON.stringify(context.system).includes("Additional Medium"), "new findings never rewrite the absolute system prefix");
    if (mode === "failed-native-recovery") {
      f.terminal("author", "Native correction failed before remaining formal checks", true);
      await f.after(started.dispatch, "Native correction failed", { sessionID: "author", status: "failed" }, "error");
      const recovery = await f.tool("root", "repair_review");
      const resumed = await f.before("root", "subagent", f.task(recovery.task));
      await f.prompt("author", resumed.input.prompt); await f.bind("author");
      const recovered = await f.missions.required("root"), unit = (await f.run()).units[0]!;
      assert.equal(recovered.corrections!.at(-1)!.findings, correction.findings);
      assert.equal(JSON.parse(await readFile(unit.handoffPath, "utf8")).ext["sortie-dogs/mission-context"].correction_context.findings, correction.findings);
      await f.edit("author", "ready all findings corrected");
      await f.shell("author", "git add -- result.txt && git commit -m all-findings-correction");
      await f.shell("author", "node required-test.mjs"); await f.shell("author", "node check.mjs");
      await f.finish(resumed, "author", inlineReport());
    } else {
      await f.edit("author", "ready all findings corrected");
      assert.equal((await f.tool("author", "finish_direct_unit")).status, "direct-unit-awaits-validation", "added defects do not waive source freshness");
      await f.shell("author", "node required-test.mjs"); await f.shell("author", "node check.mjs");
      await f.shell("author", "git add -- result.txt && git commit -m all-findings-correction");
      await f.tool("author", "finish_direct_unit");
      await f.finish(started.dispatch, "author", inlineReport());
      assert.equal(f.history.author!.filter(message => message.type === "user").length, 1);
      assert.equal((await f.ledger()).state.consumed_units, 2);
    }
    assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
  } finally { await f.dispose(); }
});

test("additional continuous findings are serialized, original-author and generation bound", async () => {
  const f = await fixture();
  try {
    await initial(f, { keepReviewOpen: true });
    const first = "Medium: retain the original ready result contract.";
    await f.tool("author", "repair_review", { findings: first });
    const extra = ["Medium: callback errors are lost.", "Medium: reflected interface values are rejected."];
    await Promise.all(extra.map(findings => f.tool("author", "repair_review", { findings })));
    const mission = await f.missions.required("root");
    const findings = mission.corrections![0]!.findings.split("\n\n");
    assert.equal(findings.shift(), `FINDINGS\n${first}`);
    assert.deepEqual(findings.sort(), [...extra].sort(), "concurrent arrivals retain each complete finding once, irrespective of arrival order");
    const retained = structuredClone(mission.corrections);
    await assert.rejects(f.tool("final", "repair_review", { findings: "Medium: wrong actor" }), /mission-review-correction-reviewer-not-current/);
    assert.deepEqual((await f.missions.required("root")).corrections, retained);
    const promptID = mission.review!.promptID;
    await f.missions.update("root", item => { item.review!.promptID = "different-native-generation"; });
    await assert.rejects(f.tool("author", "repair_review", { findings: "Medium: stale generation" }), /mission-review-correction-generation-stale/);
    assert.deepEqual((await f.missions.required("root")).corrections, retained);
    await f.missions.update("root", item => { item.review!.promptID = promptID; });
    await f.tool("author", "repair_review", { findings: "FINDINGS\n" });
    await f.tool("author", "repair_review", { findings: " \n" });
    assert.deepEqual((await f.missions.required("root")).corrections, retained);
    assert.equal(f.history.author!.filter(message => message.type === "user").length, 1);
    assert.equal((await f.missions.required("root")).review!.result, `FINDINGS\n${first}`);
  } finally { await f.dispose(); }
});

test("inline correction retains its actual Reviewer and may repair a changed source without accepting stale validation", async () => {
  const f = await fixture();
  try {
    await initial(f, { keepReviewOpen: true });
    const findings = "FINDINGS\nMedium: result must be ready.";
    await assert.rejects(f.tool("final", "repair_review", { findings }), /mission-review-correction-reviewer-not-current/);
    await writeFile(join(f.directory, "result.txt"), "changed outside review\n");
    assert.equal((await f.tool("author", "repair_review", { findings })).status, "correction-running");
    assert.equal((await f.tool("author", "finish_direct_unit")).status, "direct-unit-awaits-validation");
    await assert.rejects(f.tool("root", "complete_mission"));
  } finally { await f.dispose(); }
});

test("an unfinished inline correction cannot borrow a native terminal and releases its reserved direct unit", async () => {
  const f = await fixture();
  try {
    const started = await initial(f, { keepReviewOpen: true });
    await f.tool("author", "repair_review", { findings: "FINDINGS\nMedium: result must be ready." });
    const returned = JSON.parse(await f.finish(started.dispatch, "author", 'SELF_RECHECKED\nself_recheck: {"candidate":"current-validated","unresolved_findings":[],"residual_major":null}'));
    assert.equal(returned.status, "review-correction-incomplete");
    assert.notEqual((await f.missions.required("root")).review!.verdict, "self-rechecked");
    assert.equal((await f.ledger()).state.outstanding_reservations.length, 0);
    assert.equal((await f.run()).units[0]!.status, "failed");
    await assert.rejects(f.tool("root", "complete_mission"));
    const recovered = await f.tool("root", "repair_review");
    assert.equal(recovered.task.task_id, "author", "only actual incomplete terminal needs a continuation Task");
    const resumed = await f.before("root", "subagent", f.task(recovered.task));
    await f.prompt("author", resumed.input.prompt); await f.bind("author");
    await f.edit("author", "ready resumed");
    await f.shell("author", "git add -- result.txt && git commit -m resumed-correction");
    await f.shell("author", "node check.mjs");
    await f.finish(resumed, "author", inlineReport());
    assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
    assert.equal((await f.ledger()).state.consumed_units, 3);
  } finally { await f.dispose(); }
});

test("continuous Reviewer background Task survives cold reload before and after direct validation", async () => {
  const f = await fixture();
  try {
    const started = await initial(f, { keepReviewOpen: true, backgroundReview: true });
    await f.after(started.dispatch, "Native Review Job running", { sessionID: "author", status: "running" });
    await f.tool("author", "repair_review", { findings: "Medium: result must be ready." });
    await f.start();
    await f.edit("author", "ready continuous");
    await f.shell("author", "git add -- result.txt && git commit -m continuous-correction");
    await f.shell("author", "node check.mjs");
    await f.tool("author", "finish_direct_unit");
    await f.start();
    assert.match(f.agents.author!.agent, /^dog-reviewer-correction-/);
    assert.equal((await f.missions.required("root")).review!.verdict, "findings");
    f.terminal("author", inlineReport());
    await f.tool("root", "operator_status");
    const done = await f.missions.required("root");
    assert.equal(done.review!.verdict, "self-rechecked");
    assert.equal(done.review!.selfRecheck!.callID, started.dispatch.id);
    assert.equal(done.review!.selfRecheck!.promptID, started.mission.review!.promptID);
    assert.equal(f.history.author!.filter(message => message.type === "user").length, 1);
    assert.equal(f.agents.author!.agent, "dog-reviewer-v010");
    assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
    assert.equal((await f.ledger()).state.consumed_units, 2);
  } finally { await f.dispose(); }
});

for (const mode of ["failed-check", "changed-source", "unresolved-medium", "native-failure", "missing-self-report", "cancel"] as const) test(`continuous Reviewer preserves formal validation and actual terminal: ${mode}`, async () => {
  const f = await fixture();
  try {
    const started = await initial(f, { keepReviewOpen: true, validation: ["node required-test.mjs", "node check.mjs"] });
    await f.tool("author", "repair_review", { findings: "Medium: result must be ready." });
    await f.edit("author", "ready corrected");
    await f.shell("author", "node required-test.mjs", mode === "failed-check" ? 1 : 0);
    await f.shell("author", "node check.mjs");
    await f.shell("author", "git add -- result.txt && git commit -m continuous-guard");
    if (mode === "changed-source") await f.edit("author", "ready changed after checks");
    if (mode === "cancel") {
      await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
      assert.equal(f.agents.author!.agent, "dog-reviewer-v010");
      assert.equal((await f.missions.required("root")).corrections![0]!.status, "cancelled");
      assert.equal(f.agents.author!.outcome, "interrupted", "cancellation stops the actual still-running native Review, not only its direct grant");
    } else if (["changed-source", "failed-check"].includes(mode)) {
      assert.equal((await f.tool("author", "finish_direct_unit")).status, "direct-unit-awaits-validation");
      await f.finish(started.dispatch, "author", inlineReport());
      assert.equal((await f.missions.required("root")).corrections![0]!.status, "failed");
    } else {
      await f.tool("author", "finish_direct_unit");
      if (mode === "native-failure") {
        f.terminal("author", inlineReport(), true);
        await f.after(started.dispatch, inlineReport(), { sessionID: "author", status: "failed" }, "error");
      } else if (mode === "missing-self-report") await f.finish(started.dispatch, "author", "Correction done, no actual self-recheck report.");
      else await f.finish(started.dispatch, "author", inlineReport(["Medium: original ready requirement remains wrong."]));
    }
    assert.notEqual((await f.missions.required("root")).review!.verdict, "self-rechecked");
    if (mode === "cancel") assert.notEqual((await f.tool("root", "complete_mission")).status, "succeeded");
    else await assert.rejects(f.tool("root", "complete_mission"));
    assert.equal((await f.ledger()).state.outstanding_reservations.length, 0);
    assert.equal((await f.ledger()).state.consumed_units, 2);
    if (mode === "native-failure" || mode === "missing-self-report") {
      const formalCalls = f.history.author!.flatMap(message => message.content ?? []).filter(part => part.type === "tool" &&
        ["node required-test.mjs", "node check.mjs"].includes(part.state.input.command)).length;
      assert.equal(formalCalls, 2);
      const fallback = await f.tool("root", "review_mission", { risk_tags: [] });
      assert.equal(fallback.status, "self-recheck-required");
      assert.equal(fallback.task.task_id, "author");
      const resumed = await f.before("root", "subagent", f.task(fallback.task));
      await f.prompt("author", resumed.input.prompt);
      await assert.rejects(f.edit("author", "read-only fallback"), /mission-reviewer-readonly/);
      await f.finish(resumed, "author", inlineReport([], null, (await f.missions.required("root")).review!.source));
      assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
      assert.equal((await f.ledger()).state.consumed_units, 2, "only missing self-recheck, no new correction/validation unit");
    }
  } finally { await f.dispose(); }
});

test("cancellation after continuous validation still stops the actual native self-recheck", async () => {
  const f = await fixture();
  try {
    await initial(f, { keepReviewOpen: true });
    await f.tool("author", "repair_review", { findings: "Medium: result must be ready." });
    await f.edit("author", "ready corrected");
    await f.shell("author", "git add -- result.txt && git commit -m continuous-cancel");
    await f.shell("author", "node check.mjs");
    await f.tool("author", "finish_direct_unit");
    await f.start();
    await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
    assert.equal(f.agents.author!.outcome, "interrupted");
    assert.equal(f.agents.author!.agent, "dog-reviewer-v010");
    assert.equal((await f.missions.required("root")).phase, "cancelled");
    assert.equal((await f.missions.required("root")).corrections![0]!.status, "cancelled");
    assert.equal((await f.ledger()).state.outstanding_reservations.length, 0);
    assert.equal((await f.ledger()).state.consumed_units, 2);
  } finally { await f.dispose(); }
});

for (const mode of ["success", "latest-failure", "stale"] as const) test(`compacted correction retains native terminal and current validation: ${mode}`, async () => {
  const f = await fixture({ compactedHistory: true });
  try {
    const { dispatch } = await initial(f, { keepReviewOpen: true, validation: ["node required-test.mjs", "node check.mjs"] });
    await f.tool("author", "repair_review", { findings: "Medium: result.txt must contain ready output." });
    await f.edit("author", "ready");
    await f.shell("author", "git add -- result.txt && git commit -m correction");
    await f.shell("author", "node required-test.mjs"); await f.shell("author", "node check.mjs");
    const checks = (await f.run()).units[0]!.reviewerCorrection!.checks!;
    f.compaction.start = f.history.author!.length; // The admission prompt and successful tools leave context together.
    if (mode === "latest-failure") {
      await f.edit("author", "bad-required"); await f.shell("author", "node required-test.mjs");
      await f.edit("author", "ready"); // Restored bytes do not erase the later native failure.
    } else if (mode === "stale") await f.edit("author", "ready changed after validation");
    const finished = await f.tool("author", "finish_direct_unit");
    if (mode !== "success") {
      assert.equal(finished.status, "direct-unit-awaits-validation");
      assert.match(finished.reason, mode === "latest-failure" ? /validation-failed/ : /validation-stale/);
      await assert.rejects(f.tool("root", "complete_mission"), /validation|incomplete/);
      assert.notEqual((await f.missions.required("root")).review!.verdict, "self-rechecked");
      return;
    }
    assert.equal(finished.status, "correction-validated");
    const returned = JSON.parse(await f.finish(dispatch, "author", inlineReport()));
    assert.equal(returned.status, "review-correction-recorded", JSON.stringify(returned));
    assert.equal((await f.missions.required("root")).review!.verdict, "self-rechecked");
    assert.deepEqual((await f.run()).units[0]!.reviewerCorrection!.checks, checks, "no successful native check is repeated or replaced");
    assert.equal((await f.tool("root", "review_mission", { risk_tags: ["public-logic"] })).status, "review-recorded");
    assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
  } finally { await f.dispose(); }
});

for (const mode of ["foreground", "background", "background-cold"] as const) {
  test(`stale inline correction terminal cannot block subsequent native prompts: ${mode}`, async () => {
    const f = await fixture();
    try {
      const background = mode !== "foreground";
      const { dispatch } = await initial(f, { keepReviewOpen: true, backgroundReview: background });
      if (background) await f.after(dispatch, "Native review Job running", { sessionID: "author", status: "running" });
      await f.tool("author", "repair_review", { findings: "Medium: result.txt must contain ready output." });
      await f.edit("author", "ready"); await f.shell("author", "node check.mjs");
      await f.shell("author", "git add -- result.txt && git commit -m correction");
      assert.equal((await f.tool("author", "finish_direct_unit")).status, "correction-validated");
      const run = await f.run(), ledger = await f.ledger();
      await writeFile(join(f.directory, "check.mjs"), (await readFile(join(f.directory, "check.mjs"), "utf8")) + "// changed after formal validation\n");
      if (background) {
        f.terminal("author", inlineReport());
        if (mode === "background-cold") await f.start();
      } else {
        const returned = JSON.parse(await f.finish(dispatch, "author", inlineReport()));
        assert.equal(returned.status, "review-correction-incomplete");
        assert.match(returned.reason, /correction-validation-stale/);
        assert.match(returned.next_action, /repair_review.*SAME author/);
        assert.doesNotMatch(returned.next_action, /Formal correction validation remains current/);
      }
      await f.context({ sessionID: "root", agent: "dog-operator", system: [], messages: [], tools: {} });
      await assert.rejects(f.tool("root", "complete_mission"), /correction-validation-stale/);
      f.agents.root!.agent = "build";
      await f.context({ sessionID: "root", agent: "build", system: [], messages: [], tools: {} });
      await f.prompt("root", "Continue");
      await f.context({ sessionID: "root", agent: "build", system: [], messages: [], tools: {} });
      if (background) {
        const dispatches = f.storage.get("v2-background-dispatches:root") as ObjectValue[];
        assert.equal(dispatches.find(item => item.callID === dispatch.id)!.settled, true, "stale proof is not an accounting failure retried on every prompt");
        await f.start();
        await f.prompt("root", "Continue after reload");
      }
      assert.notEqual((await f.missions.required("root")).review!.verdict, "self-rechecked");
      assert.deepEqual((await f.run()).units[0]!.reviewerCorrection!.checks, run.units[0]!.reviewerCorrection!.checks);
      assert.deepEqual((await f.ledger()).records.filter(item => item.event.kind === "unit.settled"), ledger.records.filter(item => item.event.kind === "unit.settled"));
    } finally { await f.dispose(); }
  });
}

for (const mode of ["missing-add", "failed-commit"] as const) test(`failed native correction after actual add then commit failure cannot produce receipt: ${mode}`, async () => {
  const f = await fixture();
  try {
    await initial(f, { write: ["result.txt", "missing.txt"] });
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.bind("author");
    await f.edit("author", "ready"); await f.shell("author", "node check.mjs");
    const evidenceBefore = structuredClone((await f.run()).units[0]!.reviewerCorrection!.checks);
    const headBefore = (await exec("git", ["rev-parse", "HEAD"], { cwd: f.directory })).stdout;
    if (mode === "failed-commit") {
      const hook = join(f.directory, ".git/hooks/pre-commit");
      await writeFile(hook, "#!/bin/sh\nexit 1\n"); await chmod(hook, 0o755);
    }
    await f.shell("author", `git add ${mode === "missing-add" ? "missing.txt" : "result.txt"} && git commit -m failed-chain`);
    const native = f.history.author!.at(-1)!.content[0];
    assert.notEqual(native.state.metadata.exit, 0, "real Git failure is recorded, not prospective success");
    assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: f.directory })).stdout, headBefore);
    assert.deepEqual((await f.run()).units[0]!.reviewerCorrection!.checks, evidenceBefore, "Git preflight never manufactures formal evidence");
    f.terminal("author", "Requested Git delivery failed", true);
    await f.after(dispatch, "Requested Git delivery failed", { sessionID: "author", status: "failed" }, "error");
    assert.equal((await f.missions.required("root")).corrections![0]!.status, "failed");
    await assert.rejects(f.tool("root", "complete_mission"), /correction-validation|required|incomplete/);
    assert.equal((await f.ledger()).state.consumed_units, 2, "failed correction settles once");
  } finally { await f.dispose(); }
});

for (const mode of ["foreground", "background-cold", "synthetic-notification", "medium", "major", "missing", "PASS", "old-report", "nonterminal", "old-terminal", "failed-check", "edited-after-check", "native-failed", "missing-prompt", "later-prompt"] as const) {
  test(`inline correction native self-recheck: ${mode}`, async () => {
    const f = await fixture();
    try {
      const previous = await initial(f, { validation: ["node required-test.mjs", "node check.mjs"] });
      const prepared = await f.tool("root", "repair_review");
      assert.match((await f.run()).units[0]!.unit.objective, /in this Task/);
      assert.match((await f.run()).units[0]!.unit.objective, /current-validated/);
      const dispatch = await f.before("root", "subagent", { ...f.task(prepared.task), ...(["background-cold", "missing-prompt"].includes(mode) ? { background: true } : {}) });
      await f.prompt("author", dispatch.input.prompt); await f.bind("author");
      const unit = (await f.run()).units[0]!;
      assert.equal(unit.reviewerCorrection!.promptID, f.history.author!.filter(message => message.type === "user").at(-1)!.id);
      const authorTaskCount = () => f.history.root!.flatMap(message => message.content ?? []).filter(part => part.type === "tool" && part.name === "subagent" && part.state.input.sessionID === "author").length;
      if (mode === "missing-prompt") await f.after(dispatch, "Native Job running", { sessionID: "author", status: "running" });
      if (mode === "background-cold") {
        await f.after(dispatch, "Native Job running", { sessionID: "author", status: "running" });
        await f.start();
        await f.bind("author"); // Existing cold binding recovery, not a new Task or validation.
        assert.equal((await f.run()).units[0]!.reviewerCorrection!.promptID, unit.reviewerCorrection!.promptID);
        assert.equal((await f.ledger()).state.outstanding_reservations.length, 1);
      }
      await f.edit("author", mode === "failed-check" ? "bad-required" : "ready");
      await f.shell("author", "git add -- result.txt"); await f.shell("author", "git commit -m inline-correction");
      await f.shell("author", "node required-test.mjs"); await f.shell("author", "node check.mjs");
      if (mode === "edited-after-check") await f.edit("author", "ready but unvalidated edit");
      if (mode === "missing-prompt") {
        const runtime = new OperatorRuntime(f.directory, V010_RUNTIME_PROFILE), state = await f.run();
        delete state.units[0]!.reviewerCorrection!.promptID;
        await writeFile(runtime.statePath("root"), JSON.stringify(state));
        await f.start();
      }
      if (mode === "later-prompt") f.history.author!.push({ id: "unowned-later-user", type: "user", text: "Different prompt", time: { created: Date.now() } });
      if (mode === "synthetic-notification") f.history.author!.push({ id: "native-shell-job-completion", type: "synthetic",
        text: "Background command completed (shell ID: diagnostic-shell). Exit code: 0", time: { created: Date.now() } });
      const text = mode === "missing" ? "CORRECTION_READY" : mode === "PASS" ? "PASS" :
        inlineReport(mode === "medium" ? ["Medium: retained output behavior remains broken"] : [],
          mode === "major" ? { reachable_path: "caller retries an unsuccessful transaction", consequence: "persisted state corruption across retries" } : null,
          mode === "old-report" ? previous.mission.review!.source : "current-validated");
      if (mode === "nonterminal" || mode === "old-terminal") {
        if (mode === "nonterminal") f.history.author!.push({ id: "still-tool-calls", type: "assistant", finish: "tool-calls", time: { created: Date.now(), completed: Date.now() }, content: [{ type: "text", text }] });
        await f.after(dispatch, text, { sessionID: "author" });
      } else if (mode === "native-failed") {
        f.terminal("author", text, true); await f.after(dispatch, text, { sessionID: "author", status: "failed" }, "error");
      } else if (mode === "background-cold" || mode === "missing-prompt") {
        f.terminal("author", text); await f.start(); await f.tool("root", "operator_status");
      } else await f.finish(dispatch, "author", text);
      const mission = await f.missions.required("root"), settledRun = await f.run();
      if (["foreground", "background-cold", "synthetic-notification", "medium", "major"].includes(mode)) {
        const proof = mission.review!.selfRecheck!;
        assert(proof, "actual correction terminal records self-recheck without another author Task");
        assert.equal(mission.review!.mode, "self-recheck"); assert.equal(proof.callID, dispatch.id);
        assert.equal(proof.promptID, unit.reviewerCorrection!.promptID); assert.equal(proof.runID, settledRun.runID);
        assert.equal(proof.author, "author"); assert.equal(proof.nativeOutcome, "completed");
        assert.equal(proof.messageID, f.history.author!.filter(message => message.type === "assistant" && message.finish === "stop").at(-1)!.id);
        assert.notEqual(proof.source, previous.mission.review!.source, "HOST binds post-edit source, never the old prompt hash");
        assert.equal(missionReviewIndependent(mission, "author"), false);
        assert.equal(mission.corrections![0]!.selfRecheck!.messageID, proof.messageID);
        if (mode === "medium") {
          await assert.rejects(f.tool("root", "complete_mission"), /mission-review/);
          await assert.rejects(f.tool("root", "review_mission", { risk_tags: [] }), /known-findings-require-correction/);
          const retry = await f.tool("root", "repair_review");
          assert.equal(retry.status, "correction-required"); assert.equal(retry.task.task_id, "author");
        } else if (mode === "major") {
          await assert.rejects(f.tool("root", "complete_mission"), /mission-review/);
          const second = await f.tool("root", "review_mission", { risk_tags: [] });
          assert.equal(second.status, "review-required"); assert.equal(second.task.task_id, undefined);
        } else {
          await f.start();
          assert.equal((await f.tool("root", "review_mission", { risk_tags: ["public-api"] })).status, "review-recorded");
          const acceptance = (await f.tool("root", "operator_status")).acceptance_summary;
          const count = authorTaskCount(), receipt = await f.tool("root", "complete_mission");
          assert.equal(receipt.status, "succeeded"); assert.equal(acceptance.independent_review.independent, false);
          assert.equal(acceptance.independent_review.verdict, "self-rechecked");
          assert.equal(authorTaskCount(), count, "root receipt adds NO second author Task");
          const beforeDuplicate = await f.ledger();
          await f.after(dispatch, text, { sessionID: "author" });
          const ledger = await f.ledger();
          assert.equal(ledger.state.consumed_units, 2); assert.equal(ledger.state.outstanding_reservations.length, 0);
          assert.deepEqual(ledger.records.filter(item => item.event.kind === "unit.settled"), beforeDuplicate.records.filter(item => item.event.kind === "unit.settled"));
          const spend = ledger.records.filter(item => item.event.kind === "unit.settled").at(-1)!.event.cost_usd!;
          assert(Math.abs(spend - (mode === "background-cold" ? 0.0032 : 0.0028)) < 1e-12, "owned correction native requests charged once; no self-recheck round spend");
          assert.equal(f.agents.author!.agent, "dog-reviewer-v010");
          await assert.rejects(f.before("author", "patch", { patchText: "*** Begin Patch\n*** Update File: result.txt\n@@\n-ready\n+changed\n*** End Patch" }), /mission-reviewer-readonly/);
        }
      } else {
        assert.notEqual(mission.review!.verdict, "self-rechecked");
        await assert.rejects(f.tool("root", "complete_mission"), /mission-review|validation|incomplete|unit-validation/);
        if (["missing", "PASS", "old-report", "missing-prompt", "later-prompt"].includes(mode)) {
          assert.equal(settledRun.phase, "awaiting-acceptance", "successful formal unit alone cannot certify missing native self-recheck proof");
          const fallback = await f.tool("root", "review_mission", { risk_tags: [] });
          assert.equal(fallback.status, "self-recheck-required"); assert.equal(fallback.task.task_id, "author");
        }
      }
    } finally { await f.dispose(); }
  });
}

test("native residual concrete Major requires independent Review; new findings reuse their reporting Reviewer by default", async () => {
  const f = await fixture();
  try {
    await initial(f); await correctionReady(f);
    const self = await selfRecheck(f, { reachable_path: "caller consumes ready output after a failed transaction", consequence: "persisted state can be corrupted across transactions" });
    await f.finish(self.dispatch, "author", self.text);
    await assert.rejects(f.tool("root", "complete_mission"), /mission-review/);
    assert.match((await f.tool("root", "operator_status")).next_action, /DIFFERENT Reviewer/);
    const second = await f.tool("root", "review_mission", { risk_tags: [] });
    assert.equal(second.status, "review-required");
    const dispatch = await f.before("root", "subagent", f.task(second.task));
    assert.equal(dispatch.input.sessionID, undefined);
    assert.match(dispatch.input.prompt, /residual_major:.*persisted state/);
    assert.match(dispatch.input.prompt, /author_self_recheck:/);
    await f.prompt("final", dispatch.input.prompt);
    await f.finish(dispatch, "final", "FINDINGS\nMedium: ready output has a newly detected concrete formatting defect; fix result.txt.");
    const newCorrection = await f.tool("root", "repair_review");
    assert.equal(newCorrection.status, "correction-required", "new generation is not the old settled idempotent Task");
    assert.equal(newCorrection.task.task_id, "final", "new reporting context is reusable, not permanently bound to an old author");
    assert.equal((await f.missions.required("root")).corrections!.length, 2);
  } finally { await f.dispose(); }
});

test("concrete residual Major independent PASS can accept after current native self-recheck", async () => {
  const f = await fixture();
  try {
    await initial(f); await correctionReady(f);
    const self = await selfRecheck(f, { reachable_path: "failed public transaction retry", consequence: "wide contract break for callers" });
    await f.finish(self.dispatch, "author", self.text);
    const second = await f.tool("root", "review_mission", { risk_tags: [] });
    const dispatch = await f.before("root", "subagent", f.task(second.task));
    await f.prompt("final", dispatch.input.prompt); await f.finish(dispatch, "final", "PASS\nRelevant retry state inspected: no remaining concrete defect.");
    assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
    assert.equal(missionReviewIndependent(await f.missions.required("root"), "final"), true);
  } finally { await f.dispose(); }
});

for (const mode of ["medium", "absent", "stale", "stale-report", "nonterminal", "tag-only", "old-terminal", "failed", "cancelled"] as const) test(`native self-recheck rejects ${mode} without independent approval`, async () => {
  const f = await fixture();
  try {
    await initial(f); await correctionReady(f);
    const self = await selfRecheck(f, mode === "tag-only" ? "public-api" : null,
      mode === "medium" ? ["Medium: ready output still violates a required behavior"] : []);
    if (mode === "stale") await writeFile(join(f.directory, "result.txt"), "changed after self-recheck admission\n");
    if (mode === "nonterminal" || mode === "old-terminal") {
      if (mode === "nonterminal") f.history.author!.push({ id: "unfinished", type: "assistant", finish: "tool-calls", content: [{ type: "text", text: self.text }], time: { created: Date.now(), completed: Date.now() } });
      await f.after(self.dispatch, self.text, { sessionID: "author" });
    } else if (mode === "failed" || mode === "cancelled") {
      f.terminal("author", self.text, true);
      if (mode === "cancelled") f.agents.author!.outcome = "interrupted";
      await f.after(self.dispatch, self.text, { sessionID: "author", status: mode });
    } else if (mode === "stale") {
      await f.finish(self.dispatch, "author", self.text);
      await f.context({ sessionID: "root", agent: "dog-operator", system: [], messages: [], tools: {} });
    } else await f.finish(self.dispatch, "author", mode === "absent" ? "CORRECTION_READY\nFixed" : mode === "stale-report" ? self.text.replace(self.candidate, "old-candidate") : self.text);
    const mission = await f.missions.required("root");
    assert.notEqual(mission.review!.verdict, "self-rechecked");
    await assert.rejects(f.tool("root", "complete_mission"), /mission-review|validation-stale/);
    if (mode === "medium") {
      assert.match((await f.tool("root", "operator_status")).next_action, /known Major\/Medium|Known Major\/Medium/);
      await assert.rejects(f.tool("root", "review_mission", { risk_tags: ["public-api"] }), /known-findings-require-correction/);
      assert.equal((await f.tool("root", "repair_review")).task.task_id, "author");
    }
  } finally { await f.dispose(); }
});

test("native Reviewer gets verbatim full original request outside source excerpts", async () => {
  const f = await fixture();
  try {
    const original = "  Original task and acceptance constraints\r\n" + "Preserve unchanged requirement text. ".repeat(800) + "\nEND original  ";
    await initial(f, { original });
    const prompt = f.history.author!.find(message => message.type === "user")!.text;
    assert(prompt.includes(original));
    assert.match(prompt, /Verbatim original user requests \(complete, outside the source-excerpt budget/);
    assert.match(prompt, /Major AND Medium/);
  } finally { await f.dispose(); }
});

for (const residual of [false, true]) test(`evidence refresh ${residual ? "invalidates old Major report" : "after acceptance is presentation only"} stays in the SAME author`, async () => {
  const f = await fixture();
  try {
    await initial(f); await correctionReady(f);
    const self = await selfRecheck(f, residual ? { reachable_path: "failed transaction retry", consequence: "state corruption" } : null);
    await f.finish(self.dispatch, "author", self.text);
    const before = await f.run(), prior = (await f.missions.required("root")).review!;
    const refreshed = await f.tool("root", "review_mission", { risk_tags: ["public-api"], evidence: [{ path: "result.txt", offset: 1, limit: 1 }] });
    if (!residual) {
      assert.equal(refreshed.status, "review-recorded", "unchanged candidate/semantics need no extra author Task for optional presentation");
      assert.deepEqual((await f.missions.required("root")).review, prior, "accepted source/evidence pin remains unchanged");
      assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
      return;
    }
    assert.equal(refreshed.status, "self-recheck-required");
    assert.equal(refreshed.task.task_id, "author", "excerpt/hash changes cannot purchase a second Reviewer");
    assert.equal((await f.missions.required("root")).review!.mode, "self-recheck");
    assert.notEqual((await f.missions.required("root")).review!.source, prior.source);
    await assert.rejects(f.tool("root", "complete_mission"), /mission-review/);
    const dispatch = await f.before("root", "subagent", f.task(refreshed.task));
    await f.prompt("author", dispatch.input.prompt);
    await f.after(dispatch, self.text, { sessionID: "author" }); // Older terminal cannot certify this prompt.
    assert.notEqual((await f.missions.required("root")).review!.verdict, "self-rechecked");
    await assert.rejects(f.tool("root", "complete_mission"), /mission-review/);
    const retry = await f.tool("root", "review_mission", { risk_tags: ["public-logic"] });
    assert.equal(retry.status, "self-recheck-required");
    assert.equal(retry.task.task_id, "author");
    const final = await f.before("root", "subagent", f.task(retry.task));
    await f.prompt("author", final.input.prompt);
    const candidate = (await f.missions.required("root")).review!.source;
    await f.finish(final, "author", `SELF_RECHECKED\nself_recheck: ${JSON.stringify({ candidate, unresolved_findings: [], residual_major: null })}\nCompared refreshed evidence, original requirements and corrected findings with the same actual checks.`);
    assert.equal((await f.tool("root", "review_mission", { risk_tags: ["public-api"] })).status, "review-recorded", "omitting evidence retains its current pin");
    assert.deepEqual((await f.run()).units[0]!.reviewerCorrection!.checks, before.units[0]!.reviewerCorrection!.checks, "read-only refresh reruns no unchanged check");
    assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
    assert.equal(missionReviewIndependent(await f.missions.required("root"), "author"), false);
  } finally { await f.dispose(); }
});

for (const mode of ["foreground", "background-restart", "failure", "self-review"] as const) {
  test(`native Reviewer correction lifecycle: ${mode}`, { timeout: 30_000 }, async () => {
    const f = await fixture();
    try {
      const previous = await initial(f);
      const priorModelSwitches = f.switches.length;
      await assert.rejects(f.before("author", "patch", { patchText: "*** Begin Patch\n*** Add File: other\n+x\n*** End Patch" }), /mission-reviewer-readonly/);
      const prepared = await f.tool("root", "repair_review");
      assert.equal(prepared.task.task_id, "author"); assert.equal(prepared.task.subagent_type, "dog-reviewer-v010");
      assert.deepEqual((await f.run()).acceptance, previous.run.acceptance);
      assert.deepEqual((await f.run()).acceptanceProof, previous.run.acceptanceProof);
      assert.deepEqual((await f.run()).sourceRefs, previous.run.sourceRefs);
      const declaration = (run: ObjectValue) => /^goal_declaration_path: (.+)$/mu.exec(run.units[0].task.prompt)![1]!;
      assert.equal(await readFile(declaration(await f.run()), "utf8"), await readFile(declaration(previous.run), "utf8"));
      assert.deepEqual((await f.run()).units[0]!.unit.write, previous.run.units[0]!.unit.write);
      assert.deepEqual((await f.run()).units[0]!.unit.validation, previous.run.units[0]!.unit.validation);
      assert.deepEqual((await f.tool("root", "repair_review")).task, prepared.task, "prepare is idempotent, not another unit/model run");
      const correction = await f.before("root", "subagent", { ...f.task(prepared.task), ...(mode === "background-restart" ? { background: true } : {}) });
       assert.equal(correction.input.sessionID, "author"); assert.equal(correction.input.agent, "dog-reviewer-v010");
      assert.equal((await f.tool("root", "operator_status")).budget.reserved_units, 1);
      await f.prompt("author", correction.input.prompt);
      if (mode === "background-restart") {
        await f.after(correction, "Native Job running", { sessionID: "author", status: "running" });
        const ack = { text: "⚠️ **INTERRUPTED** — launch returned\nTRUE_INTERRUPTION: internal: background acknowledgement" };
        await f.hooks()["experimental.text.complete"]!({ sessionID: "root", messageID: "ack" }, ack);
        assert.doesNotMatch(ack.text, /INTERRUPTED/);
        assert.equal((await f.ledger()).state.receipt, null, "background ack cannot create a Mission receipt");
        await f.start();
        assert.equal((await f.tool("root", "operator_status")).budget.reserved_units, 1);
      }
      await f.bind("author");
       assert.match(f.agents.author!.agent, /^dog-reviewer-correction-v010-/);
      assert.equal(f.switches.filter(input => "agent" in input).length, 1, "only the same author's scoped profile is selected, never Worker");
      assert.equal(f.switches.filter(input => "model" in input).length, priorModelSwitches, "same-child correction retains the native Sol model and variant too");
      const grants = f.rules.at(-1)!.permissions;
       assert.equal(evaluate("edit", "result.txt", grants).effect, "allow", "existing implementation defaults, not generated scope grants");
       assert.equal(grants.some((rule: ObjectValue) => rule.action === "shell" && rule.effect === "deny"), false, "only shipped shell role deny removed");
      const context = { sessionID: "author", agent: f.agents.author!.agent, tools: Object.fromEntries(["read", "patch", "write", "shell",
        "sortie_v010_bind_write_gate", "sortie_v010_expand_unit", "sortie_v010_review_mission"].filter(name =>
          !whollyDisabled(["patch", "write"].includes(name) ? "edit" : name,
            [...f.registry()[f.agents.author!.agent]!.permissions, ...(f.agents.author!.permissions ?? [])]))
        .map(name => [name, { description: name, input: {} }])), system: [] };
      await f.context(context);
      assert.deepEqual(Object.keys(context.tools).sort(), ["patch", "read", "shell", "sortie_v010_bind_write_gate", "sortie_v010_expand_unit", "write"].sort());
      const scopeBefore = await f.tool("root", "operator_status");
      assert.equal(evaluate("sortie_v010_expand_unit", "*", grants).effect, "allow",
        "admitted correction exposes the same existing scope-repair control as Worker");
      const expanded = await f.tool("author", "expand_unit", { unit_id: (await f.run()).units[0]!.unit.id,
        paths: ["generated-regression.txt"], reason: "Necessary in-request regression output discovered during correction" });
      assert.equal(expanded.status, "scope-updated");
      assert.equal(expanded.child_session_id, "author", "scope update retains the original Reviewer session");
      assert.deepEqual((await f.tool("root", "operator_status")).budget, scopeBefore.budget,
        "scope correction neither redispatches nor reserves another unit");
      await f.missions.update("root", mission => { mission.prohibitedWrite = ["undeclared.txt"]; });
      await assert.rejects(f.tool("author", "expand_unit", { unit_id: (await f.run()).units[0]!.unit.id,
        paths: ["undeclared.txt"], reason: "Explicit prohibition is not an estimate" }), /mission-explicit-write-prohibition/);
      await assert.rejects(f.before("author", "patch", { patchText: "*** Begin Patch\n*** Add File: undeclared.txt\n+x\n*** End Patch" }), /mission-explicit-write-prohibition/);
       await assert.rejects(f.before("author", "shell", { command: "printf x > undeclared.txt" }), /mission-explicit-write-prohibition/);
       const knownWrite = await f.before("author", "shell", { command: "printf x > result.txt" });
       await f.after(knownWrite, "Known scoped diagnostic allowed", { exit: 0 });
      await f.edit("author", "ready"); await f.shell("author", "git add -- result.txt"); await f.shell("author", "git commit -m correction");
      await f.shell("author", "node check.mjs", mode === "failure" ? 1 : 0);
      if (mode === "background-restart") {
        f.terminal("author", "CORRECTION_READY\nFixed the retained finding and ran its exact validation.");
        await f.tool("root", "operator_status");
      } else await f.finish(correction, "author", "CORRECTION_READY\nFixed the retained finding and ran its exact validation.");
      const corrected = await f.missions.required("root"), status = await f.tool("root", "operator_status");
      assert.equal(status.budget.reserved_units, 0); assert.equal(status.budget.consumed_units, 2);
      assert.deepEqual(f.agents.author!.permissions, undefined, "native session rules are never changed");
      assert.equal(f.agents.author!.agent, "dog-reviewer-v010", "terminal restores Reviewer immediately");
      assert.equal(f.storage.has("v2-reviewer-correction-permissions:author"), false);
       assert(Math.abs(status.budget.settled_cost_usd - 0.0056) < 1e-12, "initial Worker and eight correction requests are each priced exactly once");
      const settled = (await f.ledger()).records.map(record => record.event).filter(event => event.kind === "unit.settled");
      assert.equal(settled.length, 2);
      const correctionSettlement = settled.find(event => event.native_session_id === "author")!;
       assert(Math.abs(correctionSettlement.cost_usd! - 0.0032) < 1e-12, "same-child review history is excluded from correction spend; scope repair is priced once");
      assert(correctionSettlement.native_started_at);
      assert.equal(corrected.corrections![0]!.author, "author");
      assert.equal(corrected.corrections![0]!.status, mode === "failure" ? "failed" : "ready");
      assert.equal(corrected.review!.verdict, "findings", "correction is NEVER a self PASS");
      await assert.rejects(f.tool("root", "complete_mission"), /mission-review|required|incomplete/);
      await assert.rejects(f.before("author", "patch", { patchText: "*** Begin Patch\n*** Update File: result.txt\n@@\n-ready\n+wrong\n*** End Patch" }), /mission-reviewer-readonly/);
      if (mode === "failure") return;
      await f.start();
      const finalReview = await f.tool("root", "review_mission", { risk_tags: [] });
       assert.equal(finalReview.status, "self-recheck-required", "correction cannot low-risk skip explicit self-recheck");
       const finalDispatch = await f.before("root", "subagent", { ...f.task(finalReview.task), ...(mode === "background-restart" ? { background: true } : {}) });
       assert.equal(finalDispatch.input.sessionID, "author", "explicit self-recheck continues the SAME native child");
       const readonlyContext = { sessionID: "author", agent: f.agents.author!.agent, system: [], tools: { read: {}, grep: {}, patch: {}, shell: {} } };
       await f.context(readonlyContext);
       assert.deepEqual(Object.keys(readonlyContext.tools).sort(), ["grep", "read", "shell"]);
       assert.match(JSON.stringify(readonlyContext.system), /Native tools actually available in this request: grep, read/);
       assert.match(finalDispatch.input.prompt, /review_phase: verification/);
       assert.match(finalDispatch.input.prompt, /review_mode: self-recheck/);
       assert(finalDispatch.input.prompt.includes(previous.original), "verbatim original text is directly supplied");
       assert.match(finalDispatch.input.prompt, /prior_findings_ref:/);
       assert.match(finalDispatch.input.prompt, /Changed since correction baseline/);
       await f.prompt("author", finalDispatch.input.prompt);
       if (mode === "self-review") {
        await f.finish(finalDispatch, "author", "PASS\nMy own correction is fine");
        assert.equal((await f.missions.required("root")).review!.verdict, "findings");
        assert.equal(missionReviewIndependent(await f.missions.required("root"), "author"), false);
        await assert.rejects(f.tool("root", "complete_mission"), /mission-review/);
        return;
      }
       const source = (await f.missions.required("root")).review!.source;
       const selfText = `SELF_RECHECKED\nself_recheck: ${JSON.stringify({ candidate: source, unresolved_findings: [], residual_major: null })}\nAll original requirements and three Medium findings compared with correction and actual checks; resolved.`;
       if (mode === "background-restart") {
         await f.after(finalDispatch, "Native self-recheck Job running", { sessionID: "author", status: "running" });
         assert.equal((await f.ledger()).state.receipt, null);
         await f.start();
         f.terminal("author", selfText);
         await f.tool("root", "operator_status");
       } else await f.finish(finalDispatch, "author", selfText);
       const selfchecked = await f.missions.required("root");
       assert.equal(selfchecked.review!.verdict, "self-rechecked");
       assert.equal(missionReviewIndependent(selfchecked, "author"), false);
       assert.equal(f.switches.filter(input => "model" in input).length, priorModelSwitches, "same-author self-recheck never replaces model/variant");
       await f.start();
       assert.equal(missionReviewIndependent(await f.missions.required("root"), "author"), false, "reload cannot make the author independent");
       assert.equal((await f.tool("root", "review_mission", { risk_tags: ["public-logic", "public-api"] })).status, "review-recorded", "tags alone cannot trigger a second Reviewer");
       assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
      const completed = await f.missions.required("root");
      assert.deepEqual(completed.requirements, previous.mission.requirements);
      assert.equal(completed.requests[0]!.text, previous.original);
       assert.equal(completed.review!.child, "author"); assert.equal((await f.run()).receipt!.status, "succeeded");
       assert.equal(f.history.final, undefined, "three Medium findings need ZERO second Reviewer children");
      assert.equal((await exec("git", ["status", "--porcelain"], { cwd: f.directory })).stdout, "");
      assert.equal((await exec("git", ["log", "-1", "--format=%s"], { cwd: f.directory })).stdout.trim(), "correction");
      assert.equal((await f.tool("root", "operator_status")).budget.consumed_units, 2, "review and receipt cannot spend the correction twice");
    } finally { await f.dispose(); }
  });
}

for (const mode of ["readonly", "stale"] as const) test(`Reviewer correction does not broaden mission semantics: ${mode}`, async () => {
  const f = await fixture();
  try {
    await initial(f, { readonly: mode === "readonly" });
    if (mode === "stale") await writeFile(join(f.directory, "result.txt"), "changed outside review\n");
    if (mode === "readonly") {
      await assert.rejects(f.tool("root", "repair_review"), /mission-review-correction-unavailable/);
      assert.equal((await f.missions.required("root")).corrections, undefined);
    } else {
      assert.equal((await f.tool("root", "repair_review")).task.task_id, "author");
      await assert.rejects(f.tool("root", "complete_mission"));
    }
    assert.equal(f.rules.length, 0, "ordinary reviews never receive writer permissions");
    assert.equal((await f.tool("root", "operator_status")).budget.consumed_units, 1);
  } finally { await f.dispose(); }
});

for (const skipOperation of [false, true]) test(`operation correction recovers the same Reviewer after reload without repeating execution: ${skipOperation ? "not-started" : "executed"}`, async () => {
  const f = await fixture();
  try {
    const previous = await initial(f, { operation: true, skipOperation });
    await f.start();
    const prepared = await f.tool("root", "repair_review");
    assert.equal(prepared.task.task_id, "author");
    const dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt);
    // The admitted operation correction activates normally, without another handoff read.
    await f.edit("author", "ready");
    await f.shell("author", "node check.mjs");
    await f.shell("author", "git add -- result.txt");
    await f.shell("author", "git commit -m operation-correction");
    await f.finish(dispatch, "author", 'SELF_RECHECKED\nself_recheck: {"candidate":"current-validated","unresolved_findings":[],"residual_major":null}\nCompared original requirements and retained findings; corrected records do not imply operation success.');
    const corrected = await f.missions.required("root");
    assert.deepEqual(corrected.execution, previous.mission.execution);
    assert.deepEqual(corrected.requirements, previous.mission.requirements);
    assert.equal(corrected.review!.verdict, "self-rechecked");
    assert.equal(corrected.review!.child, "author");
    assert.equal(missionReviewIndependent(corrected, "author"), false);
    assert.equal(f.history.final, undefined, "no second Reviewer or replacement Worker");
    const status = await f.tool("root", "operator_status");
    assert.equal(status.budget.consumed_units, 2);
    assert.equal(status.budget.reserved_units, 0);
    assert.equal(status.operation.status, skipOperation ? "not-started" : "executed");
    const completed = await f.tool("root", "complete_mission");
    if (skipOperation) {
      assert.equal(completed.status, "not-ready");
      assert.equal(completed.operation_status, "not-started");
      assert.equal((await f.run()).receipt, null, "self-recheck cannot accept an unexecuted operation");
    } else assert.equal(completed.status, "succeeded");
  } finally { await f.dispose(); }
});
