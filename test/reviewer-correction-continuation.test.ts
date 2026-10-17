import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { missionReviewIndependent } from "../dist/core/operator-mission.js";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { type ObjectValue, fixture, initial, inlineReport, selfRecheck } from "./helpers/reviewer-correction-fixture.ts";

for (const mode of ["generated", "implicit", "cold", "legacy-cold"] as const) test(`independent Reviewer continues the same context after validation-only replan: ${mode}`, async () => {
  const f = await fixture();
  try {
    const previous = await initial(f);
    const modelBefore = f.switches.filter(input => "model" in input).length;
    await f.tool("root", "plan_units", { reason: "Refresh the current validation binding without changing the candidate",
      executor: "self", units: [{ title: "Refresh existing candidate validation", objective: "Validate unchanged candidate",
        read: ["result.txt", "check.mjs"], write: ["result.txt"], validation: ["node check.mjs"] }] });
    await f.tool("root", "start_direct_unit");
    await f.shell("root", "node check.mjs");
    await f.tool("root", "finish_direct_unit");
    const runBefore = await f.run(), budgetBefore = (await f.ledger()).state;
    const review = await f.tool("root", "review_mission", { risk_tags: ["public-logic"], traces: ["Continue the original Reviewer; retain the known Medium finding."] });
    assert.equal(review.task.task_id, "author", "independent means non-author, not a new conversation");
    assert.equal((await f.missions.required("root")).review!.mode, "independent");
    if (mode === "legacy-cold") {
      await f.missions.update("root", mission => { delete mission.review!.task!.task_id; });
      delete review.task.task_id;
    }
    if (mode === "cold" || mode === "legacy-cold") await f.start();
    const input = f.task(review.task);
    if (mode === "implicit" || mode === "legacy-cold") delete input.sessionID;
    const dispatch = await f.before("root", "subagent", input);
    assert.equal(dispatch.input.sessionID, "author", "the host supplies the retained context even when the model omits its ID");
    await f.prompt("author", dispatch.input.prompt);
    await f.before("author", "read", { path: "result.txt" });
    assert.equal((await f.ledger()).state.consumed_units, budgetBefore.consumed_units, "read-only Review continuation spends no Worker unit");
    assert.equal((await f.ledger()).state.outstanding_reservations.length, 0);
    assert.equal((await f.run()).runID, runBefore.runID);
    assert.notEqual(runBefore.runID, previous.run.runID);
    assert.equal((await f.missions.required("root")).id, previous.mission.id);
    assert.equal(f.switches.filter(input => "model" in input).length, modelBefore);
    assert.equal(f.history.final, undefined, "no replacement Reviewer is required");
    if (mode === "generated") {
      const findings = "Medium: preserve the ready output contract from the original Review.";
      const correction = await f.tool("author", "repair_review", { findings });
      assert.equal(correction.execution, "same-native-task");
      assert.equal((await f.run()).units[0]!.directExecution!.actor, "author");
      await f.edit("author", "ready resumed");
      await f.shell("author", "git add -- result.txt && git commit -m resumed-reviewer-correction");
      await f.shell("author", "node check.mjs");
      await f.tool("author", "finish_direct_unit");
      await f.finish(dispatch, "author", inlineReport());
      assert.equal((await f.missions.required("root")).review!.verdict, "self-rechecked");
      assert.equal((await f.ledger()).state.consumed_units, budgetBefore.consumed_units + 1);
    } else {
      await f.finish(dispatch, "author", "FINDINGS\nMedium: original finding remains; no new investigation needed.");
      assert.equal((await f.missions.required("root")).review!.verdict, "findings");
    }
  } finally { await f.dispose(); }
});

test("independent Review continuation rejects a foreign native owner rather than all existing contexts", async () => {
  const f = await fixture();
  try {
    await initial(f);
    const review = await f.tool("root", "review_mission", { risk_tags: ["public-logic"], traces: ["Relevant new context; reuse the original Reviewer."] });
    f.agents.foreign = { agent: "dog-reviewer-v010", parentID: "other-root" };
    await assert.rejects(f.before("root", "subagent", { ...f.task(review.task), sessionID: "foreign" }), /mission-review-task-required/);
    assert.equal((await f.missions.required("root")).review!.callID, undefined);
    assert.equal((await f.ledger()).state.outstanding_reservations.length, 0);
  } finally { await f.dispose(); }
});

for (const cold of [false, true]) test(`an active independent Review joins its original native call without overwriting the terminal: ${cold ? "cold" : "live"}`, async () => {
  const f = await fixture();
  try {
    const started = await initial(f, { keepReviewOpen: true, backgroundReview: cold });
    if (cold) { await f.after(started.dispatch, "Native Review running", { sessionID: "author", status: "running" }); await f.start(); }
    const before = await f.missions.required("root"), budget = (await f.ledger()).state.consumed_units;
    assert.equal((await f.tool("root", "review_mission", { risk_tags: ["public-logic"] })).status, "review-running");
    const joined = await f.before("root", "subagent", f.task(before.review!.task!));
    const result = await f.launch(joined);
    assert.equal(result.metadata.joined, true);
    assert.equal(result.metadata.joinedCallID, started.dispatch.id);
    assert.equal(f.nativeLaunches.length, 0, "joining never submits another native prompt");
    await f.after(joined, result.content, result.metadata);
    const active = await f.missions.required("root");
    assert.equal(active.review!.callID, before.review!.callID);
    assert.equal(active.review!.promptID, before.review!.promptID);
    const terminal = "FINDINGS\nMedium: original native result must remain actionable.";
    await f.finish(started.dispatch, "author", terminal);
    if (cold) await f.tool("root", "operator_status");
    const done = await f.missions.required("root");
    assert.equal(done.review!.result, terminal);
    assert.equal(done.review!.verdict, "findings");
    assert.equal((await f.ledger()).state.consumed_units, budget);
  } finally { await f.dispose(); }
});

test("earlier-run findings remain actionable after a validation-only replan", async () => {
  const f = await fixture();
  try {
    const previous = await initial(f);
    await f.tool("root", "plan_units", { reason: "Refresh existing validation only", executor: "self",
      units: [{ title: "Existing check", objective: "Validate unchanged source", read: ["result.txt", "check.mjs"], write: ["result.txt"], validation: ["node check.mjs"] }] });
    await f.tool("root", "start_direct_unit"); await f.shell("root", "node check.mjs"); await f.tool("root", "finish_direct_unit");
    assert.notEqual((await f.run()).runID, previous.run.runID);
    const repair = await f.tool("root", "repair_review");
    assert.equal(repair.task.task_id, "author");
    assert.equal((await f.missions.required("root")).corrections![0]!.findings, previous.mission.review!.result);
  } finally { await f.dispose(); }
});

for (const mode of ["live", "cold", "legacy-cold"] as const) test(`verification findings then direct correction preserve initial review lineage: ${mode}`, async () => {
  const f = await fixture();
  try {
    const previous = await initial(f);
    const initialPrompt = previous.mission.review!.initialPrompt;
    const verification = await f.tool("root", "review_mission", { risk_tags: ["public-logic"], traces: ["Inspect the remaining concrete finding."] });
    const dispatch = await f.before("root", "subagent", f.task(verification.task));
    await f.prompt("author", dispatch.input.prompt);
    assert.match(dispatch.input.prompt, /^review_phase: verification$/mu);
    await f.tool("author", "repair_review", { findings: "Medium: ready output is still missing." });
    await f.finish(dispatch, "author", "FINDINGS\nNo source edits; the controller will correct the retained finding.");
    if (mode === "legacy-cold") await f.missions.update("root", mission => {
      // v0.14.0 replaced the initial receipt with the verification prompt.
      mission.review!.initialPrompt = dispatch.input.prompt;
      mission.corrections!.at(-1)!.initialPrompt = dispatch.input.prompt;
      delete mission.review!.child; // A subsequently denied replacement has no native child yet.
    });
    await f.tool("root", "plan_units", { executor: "self", reason: "Controller corrects the concrete finding directly",
      units: [{ title: "Correct output", objective: "Produce ready output", read: ["check.mjs"], write: ["result.txt"], validation: ["node check.mjs"] }] });
    await f.edit("root", "ready");
    await f.shell("root", "git add -- result.txt && git commit -m direct-correction");
    await f.shell("root", "node check.mjs"); await f.tool("root", "finish_direct_unit");
    const run = await f.run(), budget = (await f.ledger()).state.consumed_units;
    if (mode !== "live") await f.start();
    const review = await f.tool("root", "review_mission", { risk_tags: ["public-logic"], mode: "independent", reviewer_session_id: "final" });
    const next = await f.before("root", "subagent", f.task(review.task));
    assert.match(next.input.prompt, /^review_phase: verification$/mu);
    assert.equal((await f.missions.required("root")).review!.initialPrompt, initialPrompt);
    await f.prompt("final", next.input.prompt);
    await f.finish(next, "final", "PASS\nCompared the corrected output and retained findings with the existing checks.");
    assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
    assert.equal((await f.run()).runID, run.runID);
    assert.equal((await f.ledger()).state.consumed_units, budget, "read-only continuation adds no implementation unit");
  } finally { await f.dispose(); }
});

for (const mode of ["no-writes", "writes", "failed-write", "missing-prompt", "missing-terminal"] as const) test(`failed inline admission preserves actual Reviewer authorship after direct correction: ${mode}`, async () => {
  const f = await fixture();
  try {
    const started = await initial(f, { keepReviewOpen: true });
    await f.tool("author", "repair_review", { findings: "Medium: result must be ready." });
    if (mode === "writes") await f.edit("author", "partial correction");
    if (mode === "failed-write") await f.after(await f.before("author", "patch", {
      patchText: "*** Begin Patch\n*** Update File: result.txt\n@@\n-wrong\n+partial\n*** End Patch",
    }), "Write failed; absence of partial effects is unknown", {}, "error");
    await f.finish(started.dispatch, "author", "FINDINGS\nController must finish the correction.");
    if (mode === "missing-prompt") f.history.author = f.history.author!.filter(message => message.type !== "user");
    if (mode === "missing-terminal") f.history.author = f.history.author!.filter(message => message.finish !== "stop");
    await f.tool("root", "plan_units", { executor: "self", reason: "Controller finishes the correction",
      units: [{ title: "Correct output", objective: "Produce ready output", read: ["check.mjs"], write: ["result.txt"], validation: ["node check.mjs"] }] });
    await f.edit("root", "ready"); await f.shell("root", "git add -- result.txt && git commit -m direct-correction");
    await f.shell("root", "node check.mjs"); await f.tool("root", "finish_direct_unit");
    await f.start();
    const review = await f.tool("root", "review_mission", { risk_tags: ["public-logic"] });
    assert.equal(review.task.task_id, "author");
    assert.equal(review.status, mode === "no-writes" ? "review-required" : "self-recheck-required");
    assert.equal(missionReviewIndependent(await f.missions.required("root"), "author"), mode === "no-writes");
    if (!["no-writes", "writes"].includes(mode)) {
      assert.equal((await f.missions.required("root")).corrections![0]!.noWriteReceipt, undefined);
      await assert.rejects(f.tool("root", "complete_mission"));
      return;
    }
    const dispatch = await f.before("root", "subagent", f.task(review.task)); await f.prompt("author", dispatch.input.prompt);
    const source = (await f.missions.required("root")).review!.source;
    await f.finish(dispatch, "author", mode === "writes" ? inlineReport([], null, source) : "PASS\nConfirmed the controller's actual correction against the retained findings.");
    assert.equal((await f.missions.required("root")).review!.verdict, mode === "writes" ? "self-rechecked" : "PASS");
    assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
  } finally { await f.dispose(); }
});

test("a failed native start may retry the identical prompt in the retained Reviewer", async () => {
  const f = await fixture();
  try {
    await initial(f);
    const prepared = await f.tool("root", "review_mission", { risk_tags: ["public-logic"], traces: ["Retain existing findings and Reviewer."] });
    const failed = await f.before("root", "subagent", f.task(prepared.task));
    await f.after(failed, "Native launch failed before delivering a prompt", {}, "error");
    const pending = await f.missions.required("root");
    assert.equal(pending.review!.verdict, "pending");
    assert.equal(pending.review!.child, "author");
    await f.start();
    const retry = await f.before("root", "subagent", f.task(prepared.task));
    assert.equal(retry.input.sessionID, "author");
    await f.prompt("author", retry.input.prompt);
    await f.tool("author", "repair_review", { findings: "Medium: result must be ready." });
    assert.equal((await f.missions.required("root")).corrections!.length, 1);
  } finally { await f.dispose(); }
});

for (const outcome of ["failed", "interrupted"] as const) test(`a cold ${outcome} Review with a saved launch receipt does not join a dead call`, async () => {
  const f = await fixture();
  try {
    const started = await initial(f, { keepReviewOpen: true, backgroundReview: true });
    await f.after(started.dispatch, "Review launched", { sessionID: "author", status: "running" });
    f.agents.author!.outcome = outcome;
    f.storage.clear(); // A project-local candidate has no old plugin-scoped lifecycle cache.
    await f.start();
    const review = await f.tool("root", "review_mission", { risk_tags: ["public-logic"] });
    assert.equal(review.status, "review-required");
    assert.equal(review.task.task_id, "author");
    assert.equal((await f.missions.required("root")).review!.verdict, "pending");
    const resumed = await f.before("root", "subagent", f.task(review.task));
    assert.equal(f.hooks().nativeTaskJoin?.(resumed.id, false), undefined);
    await f.prompt("author", resumed.input.prompt);
    await f.finish(resumed, "author", "FINDINGS\nMedium: the retained defect is still actionable.");
    assert.equal((await f.missions.required("root")).review!.verdict, "findings");
  } finally { await f.dispose(); }
});

test("a resumed Review recovers its exact invocation from durable history after context truncation", async () => {
  const f = await fixture({ contextWindow: 8 });
  try {
    await initial(f);
    const review = await f.tool("root", "review_mission", { risk_tags: ["public-logic"], traces: ["Use this invocation's native result only."] });
    const resumed = await f.before("root", "subagent", f.task(review.task)); await f.prompt("author", resumed.input.prompt);
    const promptID = (await f.missions.required("root")).review!.promptID;
    for (let index = 0; index < 12; index++) await f.after(await f.before("author", "read", { path: "result.txt" }), "Observed source");
    await f.finish(resumed, "author", "FINDINGS\nMedium: current invocation report, not a prior PASS.");
    const done = await f.missions.required("root");
    assert.equal(done.review!.promptID, promptID);
    assert.equal(done.review!.verdict, "findings");
    assert.match(done.review!.result!, /current invocation report/);
  } finally { await f.dispose(); }
});

for (const legacy of [false, true]) test(`actual implementation authorship survives a role change without forcing a replacement conversation: ${legacy ? "legacy-reference" : "observed"}`, async () => {
  const f = await fixture();
  try {
    await initial(f);
    assert.equal(missionReviewIndependent(await f.missions.required("root"), "worker"), false);
    if (legacy) {
      const part = f.history.root!.flatMap(message => message.content ?? []).find(part => part.type === "tool" && part.name === "subagent" && part.state.metadata.sessionID === "worker");
      assert(part);
      f.history.worker!.find(message => message.type === "user")!.text = `You are a subagent spawned by another session.\n${part.state.input.prompt}`;
      await f.missions.update("root", mission => { delete mission.sourceAuthors; });
    }
    f.agents.worker!.agent = "dog-reviewer-v010";
    await f.missions.update("root", mission => { mission.review!.child = "worker"; });
    const review = await f.tool("root", "review_mission", { risk_tags: ["public-logic"], traces: ["Use the existing implementation author's context, not independent approval."] });
    assert.equal(review.status, "self-recheck-required");
    assert.equal(review.task.task_id, "worker");
    const task = await f.before("root", "subagent", f.task(review.task)); await f.prompt("worker", task.input.prompt);
    await f.finish(task, "worker", "PASS\nAn author cannot grant independent approval.");
    const mission = await f.missions.required("root");
    assert.equal(mission.review!.verdict, "findings");
    assert.equal(missionReviewIndependent(mission, "worker"), false);
    await assert.rejects(f.tool("root", "complete_mission"));
  } finally { await f.dispose(); }
});

for (const mode of ["inline-environment", "task-environment", "inline-source", "unchanged"] as const) {
  test(`ready correction freshness recovery retains the SAME author: ${mode}`, async () => {
    const key = "SORTIE_CORRECTION_RESTART_INPUT", prior = process.env[key];
    process.env[key] = "before-restart";
    const f = await fixture();
    try {
      const commands = [`${key}=$${key} node required-test.mjs`, "node check.mjs"];
      const inline = mode !== "task-environment";
      const initialReview = await initial(f, { keepReviewOpen: inline, validation: commands });
      let dispatch = initialReview.dispatch;
      if (inline) await f.tool("author", "repair_review", { findings: "Medium: output must be ready, not wrong." });
      else {
        const prepared = await f.tool("root", "repair_review");
        dispatch = await f.before("root", "subagent", f.task(prepared.task));
        await f.prompt("author", dispatch.input.prompt); await f.bind("author");
      }
      await f.edit("author", "ready");
      for (const command of commands) await f.shell("author", command);
      await f.shell("author", "git add -- result.txt"); await f.shell("author", "git commit -m ready-correction");
      if (inline) assert.equal((await f.tool("author", "finish_direct_unit")).status, "correction-validated");
      await f.finish(dispatch, "author", inlineReport());
      const readyRun = await f.run(), readyMission = await f.missions.required("root"), readyLedger = await f.ledger();
      assert.equal(readyMission.corrections![0]!.status, "ready");
      assert.equal(readyMission.review!.verdict, "self-rechecked");
      const oldChecks = structuredClone(readyRun.units[0]!.reviewerCorrection!.checks);
      if (mode === "unchanged") {
        await f.start();
        const unchanged = await f.tool("root", "repair_review");
        assert.equal(unchanged.status, "correction-ready"); assert.equal(unchanged.task, undefined);
        assert.equal((await f.run()).runID, readyRun.runID);
        assert.equal((await f.ledger()).state.consumed_units, readyLedger.state.consumed_units);
        assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
        return;
      }
      if (mode === "inline-source") await writeFile(join(f.directory, "required-test.mjs"),
        (await readFile(join(f.directory, "required-test.mjs"), "utf8")) + "// changed validation input\n");
      else process.env[key] = "after-restart";
      await f.start();
      await assert.rejects(f.tool("root", "complete_mission"), /correction-validation-stale/);
      await assert.rejects(f.tool("root", "review_mission", { risk_tags: [] }), /correction-validation-stale/);
      const nativeOutcome = f.agents.author!.outcome;
      delete f.agents.author!.outcome;
      await assert.rejects(f.tool("root", "repair_review"), /reviewer-not-terminal/);
      assert.equal((await f.run()).runID, readyRun.runID, "an active author cannot gain a duplicate admission");
      f.agents.author!.outcome = nativeOutcome;
      const recovered = await f.tool("root", "repair_review", { reason: "Refresh stale checks in the original author after restart/input change" });
      assert.equal(recovered.status, "correction-required"); assert.equal(recovered.task.task_id, "author");
      const prepared = await f.run(), mission = await f.missions.required("root");
      assert.notEqual(prepared.runID, readyRun.runID);
      assert.deepEqual(prepared.acceptance, readyRun.acceptance);
      assert.deepEqual(prepared.sourceRefs, readyRun.sourceRefs);
      assert.deepEqual(prepared.units[0]!.unit.validation, commands);
      assert.deepEqual(prepared.units[0]!.unit.write, readyRun.units[0]!.unit.write);
      assert.equal(prepared.units[0]!.reviewerCorrection!.checks, undefined, "old checks are history, not fresh proof");
      assert.equal(mission.id, readyMission.id);
      assert.equal(mission.corrections![1]!.author, "author");
      assert.equal(mission.corrections![1]!.findings, readyMission.corrections![0]!.findings);
      assert.deepEqual(mission.corrections![0]!.selfRecheck, readyMission.corrections![0]!.selfRecheck);
      assert.equal(await readFile(join(f.directory, "result.txt"), "utf8"), "ready\n", "recovery does not redo implementation");
      assert.deepEqual((await f.tool("root", "repair_review")).task, recovered.task, "repeat preparation reuses its existing admission");
      assert.equal((await f.ledger()).state.consumed_units, readyLedger.state.consumed_units);
      await assert.rejects(f.tool("root", "complete_mission"), /mission-review|incomplete|validation/);
      const resumed = await f.before("root", "subagent", f.task(recovered.task));
      await f.prompt("author", resumed.input.prompt); await f.bind("author");
      const registration = await f.tool("author", "repair_review", { reason: "Preserve the same behavior check after restart",
        validation: commands, validation_cwd: {} });
      assert.equal(registration.status, "correction-registration-corrected");
      for (const command of commands) await f.shell("author", command);
      await f.finish(resumed, "author", inlineReport());
      const current = await f.run();
      assert.notDeepEqual(current.units[0]!.reviewerCorrection!.checks, oldChecks);
      assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
      assert.equal((await f.missions.required("root")).review!.child, "author");
      assert.equal((await f.ledger()).state.consumed_units, readyLedger.state.consumed_units + 1);
      assert.equal((await f.ledger()).state.outstanding_reservations.length, 0);
    } finally {
      if (prior === undefined) delete process.env[key]; else process.env[key] = prior;
      await f.dispose();
    }
  });
}

for (const mode of ["validation", "native"] as const) test(`terminal ${mode} correction failure continues the SAME author in a fresh exact admission`, async () => {
  const f = await fixture();
  try {
    await initial(f, { validation: ["node required-test.mjs", "node check.mjs"] });
    f.agents.author!.model = { providerID: "openai", id: "gpt-6.1-sol", variant: "high" };
    const prepared = await f.tool("root", "repair_review");
    const failed = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", failed.input.prompt); await f.bind("author");
    await f.edit("author", "bad-required");
    await f.shell("author", "git add -- result.txt"); await f.shell("author", "git commit -m failed-correction");
    await f.shell("author", "node required-test.mjs"); await f.shell("author", "node check.mjs");
    if (mode === "native") {
      f.terminal("author", "Native correction failed", true);
      await f.after(failed, "Native correction failed", { sessionID: "author", status: "failed" }, "error");
    } else await f.finish(failed, "author", "CORRECTION_READY");
    const failedRun = await f.run(), failedMission = await f.missions.required("root"), failedLedger = await f.ledger();
    assert.equal(failedRun.phase, "awaiting-decision");
    assert.equal(failedMission.corrections![0]!.status, "failed");
    assert.match((await f.tool("root", "operator_status")).next_action, /repair_review.*plan_units/);
    await assert.rejects(f.tool("root", "complete_mission"), /correction-validation|required|incomplete/);
    await f.start();
    const nativeOutcome = f.agents.author!.outcome;
    delete f.agents.author!.outcome;
    await assert.rejects(f.tool("root", "repair_review"), /reviewer-not-terminal/);
    assert.equal((await f.run()).runID, failedRun.runID);
    f.agents.author!.outcome = nativeOutcome;
    const recovered = await f.tool("root", "repair_review");
    assert.equal(recovered.status, "correction-required"); assert.equal(recovered.task.task_id, "author");
    assert.notEqual((await f.run()).runID, failedRun.runID);
    assert.deepEqual((await f.run()).acceptance, failedRun.acceptance);
    assert.deepEqual((await f.run()).units[0]!.unit.validation, failedRun.units[0]!.unit.validation);
    assert.deepEqual((await f.run()).units[0]!.reviewerCorrection!.checks, undefined, "prior failed logs are not current evidence");
    assert.equal((await f.missions.required("root")).corrections![1]!.findings, failedMission.corrections![0]!.findings);
    assert.deepEqual((await f.tool("root", "repair_review")).task, recovered.task);
    assert.equal((await f.ledger()).state.consumed_units, 2);
    const retry = await f.before("root", "subagent", f.task(recovered.task));
    await f.prompt("author", retry.input.prompt); await f.bind("author");
    await f.edit("author", "ready"); await f.shell("author", "git add -- result.txt"); await f.shell("author", "git commit -m recovered-correction");
    await f.shell("author", "node required-test.mjs"); await f.shell("author", "node check.mjs");
    await f.finish(retry, "author", "CORRECTION_READY");
    await f.after(retry, "Duplicate terminal", { sessionID: "author" });
    const ledger = await f.ledger(), status = await f.tool("root", "operator_status");
    assert.equal(ledger.state.consumed_units, 3); assert.equal(ledger.state.outstanding_reservations.length, 0);
    const settlements = ledger.records.map(record => record.event).filter(event => event.kind === "unit.settled");
    assert.equal(settlements.length, 3); assert.equal(settlements[1]!.disposition, "failed");
    assert.equal(settlements[2]!.disposition, "succeeded");
    assert(Math.abs(settlements[2]!.cost_usd! - 0.0028) < 1e-12, "new admission charges its seven native requests only, not old review/failed correction history");
    const priorCost = failedLedger.records.map(record => record.event).filter(event => event.kind === "unit.settled")
      .reduce((total, event) => total + (event.cost_usd ?? 0), 0);
    assert(Math.abs(status.budget.settled_cost_usd - priorCost - 0.0028) < 1e-12);
    assert.deepEqual(f.agents.author!.model, { providerID: "openai", id: "gpt-6.1-sol", variant: "high" });
    assert.equal((await f.missions.required("root")).corrections!.length, 2);
    const self = await selfRecheck(f); await f.finish(self.dispatch, "author", self.text);
    assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
  } finally { await f.dispose(); }
});

for (const disposition of ["ready", "failed", "unresolved"] as const) for (const executor of ["self", "worker"] as const) {
  test(`terminal correction history permits ${executor} continuation with ${disposition} findings/evidence retained`, async () => {
    const f = await fixture();
    try {
      await initial(f);
      const prepared = await f.tool("root", "repair_review");
      const dispatch = await f.before("root", "subagent", f.task(prepared.task));
      await f.prompt("author", dispatch.input.prompt); await f.bind("author");
      await f.edit("author", "ready"); await f.shell("author", "node check.mjs");
      if (disposition === "failed") {
        f.terminal("author", "Native correction failed", true);
        await f.after(dispatch, "Native correction failed", { sessionID: "author", status: "failed" }, "error");
      } else await f.finish(dispatch, "author", disposition === "unresolved"
        ? inlineReport(["Medium: output still needs the remaining requested behavior."]) : inlineReport());
      const oldRun = await f.run(), oldMission = await f.missions.required("root"), oldLedger = await f.ledger();
      await f.start(); // Durable/cold recovery must not recreate a historical owner lock.
      const next = await f.tool("root", "plan_units", { executor, execution: "", reason: "Continue remaining authorized implementation, retaining all findings",
        units: [{ title: "Remaining implementation", objective: "Finish the remaining output behavior and retained findings, not administrative rechecking",
          read: ["check.mjs"], write: ["result.txt"], validation: ["node check.mjs"] }] });
      const run = await f.run(), mission = await f.missions.required("root");
      assert.notEqual(run.runID, oldRun.runID);
      assert.equal(mission.id, oldMission.id);
      assert.deepEqual(mission.corrections, oldMission.corrections);
      assert.deepEqual(mission.sourceAuthors, oldMission.sourceAuthors);
      assert.deepEqual(run.acceptance, oldRun.acceptance);
      assert.equal(mission.phase, "running"); assert.equal(mission.submission, null);
      const handoff = JSON.parse(await readFile(run.units[0]!.handoffPath, "utf8")).ext["sortie-dogs/mission-context"];
      assert.deepEqual(handoff.continuity.corrections[0].findings, oldMission.corrections![0]!.findings);
      assert.deepEqual(handoff.continuity.corrections[0].selfRecheck, oldMission.corrections![0]!.selfRecheck);
      assert.equal(handoff.retained_validation[0].correction_checks[0].child_session_id, "author");
      assert.deepEqual(handoff.retained_validation[0].correction_checks[0].command, ["node check.mjs"]);
      assert.equal(run.units[0]!.reviewerCorrection, undefined, "historical authorship is not a new writer lease");
      const archived = JSON.parse(await readFile(join(f.directory, ".sortie-dogs-v010/operators",
        `${createHash("sha256").update("root").digest("hex")}.json.${oldRun.runID}.${oldRun.sequence}.archive`), "utf8"));
      assert.deepEqual(archived, oldRun, "old native checks, authors and failed evidence survive unmodified");
      assert.equal(handoff.retained_validation[0].correction_checks[0].details_ref.path,
        new OperatorRuntime(f.directory, V010_RUNTIME_PROFILE).replanArchivePath(oldRun));
      assert.equal(JSON.parse(await readFile(handoff.retained_validation[0].correction_checks[0].details_ref.path, "utf8")).runID, oldRun.runID);
      let worker: ObjectValue | undefined;
      if (executor === "worker") {
        assert(next.task); worker = await f.before("root", "subagent", f.task(next.task));
        await f.prompt("worker", worker.input.prompt); await f.bind("worker");
      } else assert.equal(next.status, "direct-unit-running");
      await f.edit(executor === "self" ? "root" : "worker", "ready remaining behavior");
      await f.shell(executor === "self" ? "root" : "worker", "node check.mjs");
      if (worker) await f.finish(worker, "worker", "Remaining implementation completed; retained findings compared");
      else await f.tool("root", "finish_direct_unit");
      const ledger = await f.ledger();
      assert.equal(ledger.state.budget!.max_units, oldLedger.state.budget!.max_units);
      assert.equal(ledger.state.consumed_units, oldLedger.state.consumed_units + 1);
      assert.equal(ledger.state.outstanding_reservations.length, 0);
      assert.equal((await f.missions.required("root")).corrections![0]!.status, oldMission.corrections![0]!.status);
      assert.equal(missionReviewIndependent(await f.missions.required("root"), "author"), false);
      const review = await f.tool("root", "review_mission", { risk_tags: ["public-logic"], reviewer_session_id: "final", mode: "independent" });
      assert.equal(review.task.task_id, "final");
      assert.match((await f.missions.required("root")).review!.task!.prompt, /retained_findings_and_authors:.*Medium/);
      await assert.rejects(f.tool("root", "complete_mission"), /mission-review/);
    } finally { await f.dispose(); }
  });
}

test("failed correction can hand off to another existing Reviewer without dropping findings, model or spend", async () => {
  const f = await fixture();
  try {
    await initial(f);
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.bind("author");
    await f.edit("author", "bad-required"); await f.shell("author", "node check.mjs");
    f.terminal("author", "Failed correction", true);
    await f.after(dispatch, "Failed correction", { sessionID: "author", status: "failed" }, "error");
    f.agents.final!.outcome = "succeeded";
    f.agents.final!.model = { providerID: "openai", id: "gpt-6.1-sol", variant: "high" };
    f.history.final = [{ id: "existing-review-context", type: "user", text: "Retain this existing Reviewer and its selected model.", time: { created: Date.now() - 10_000 } }];
    const old = await f.missions.required("root"), oldLedger = await f.ledger();
    const handoff = await f.tool("root", "repair_review", { author_session_id: "final" });
    assert.equal(handoff.task.task_id, "final");
    const resumed = await f.before("root", "subagent", f.task(handoff.task));
    await f.prompt("final", resumed.input.prompt); await f.bind("final");
    await f.edit("final", "ready"); await f.shell("final", "node check.mjs");
    const beforeFinish = await f.ledger();
    assert.equal((await f.tool("final", "finish_direct_unit")).status, "correction-validated", "native resumed author must not hit mission-controller-required");
    assert.equal((await f.run()).phase, "running", "advisory finish is not the native Task terminal");
    assert.equal((await f.ledger()).state.consumed_units, beforeFinish.state.consumed_units);
    await f.finish(resumed, "final", inlineReport());
    const mission = await f.missions.required("root"), ledger = await f.ledger();
    assert.equal(mission.corrections![1]!.author, "final");
    assert.deepEqual(mission.corrections![0], old.corrections![0]);
    assert.equal(mission.corrections![1]!.findings, old.corrections![0]!.findings);
    assert.equal(mission.review!.mode, "self-recheck"); assert.equal(mission.review!.verdict, "self-rechecked");
    assert.equal(missionReviewIndependent(mission, "author"), false);
    assert.equal(missionReviewIndependent(mission, "final"), false);
    assert.equal(ledger.state.consumed_units, oldLedger.state.consumed_units + 1);
    assert.equal(ledger.state.outstanding_reservations.length, 0);
    assert.deepEqual(f.agents.final!.model, { providerID: "openai", id: "gpt-6.1-sol", variant: "high" });
  } finally { await f.dispose(); }
});

test("an independent Reviewer remains selectable after a completed self-recheck without mandatory repeat checks", async () => {
  const f = await fixture();
  try {
    await initial(f);
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.bind("author");
    await f.edit("author", "ready"); await f.shell("author", "node check.mjs");
    await f.finish(dispatch, "author", inlineReport());
    const run = await f.run(), ledger = await f.ledger();
    await assert.rejects(f.tool("root", "review_mission", { risk_tags: ["public-logic"], mode: "independent", reviewer_session_id: "author" }), /author-mode-mismatch/);
    const review = await f.tool("root", "review_mission", { risk_tags: ["public-logic"], mode: "independent", reviewer_session_id: "final" });
    assert.equal(review.status, "review-required"); assert.equal(review.task.task_id, "final");
    const final = await f.before("root", "subagent", f.task(review.task));
    await f.prompt("final", final.input.prompt);
    await f.finish(final, "final", "PASS\nCompared retained findings and original behavior using the existing actual checks.");
    assert.equal((await f.missions.required("root")).review!.mode, "independent");
    assert.equal(missionReviewIndependent(await f.missions.required("root"), "final"), true);
    assert.deepEqual((await f.run()).units[0]!.reviewerCorrection!.checks, run.units[0]!.reviewerCorrection!.checks);
    assert.equal((await f.ledger()).state.consumed_units, ledger.state.consumed_units);
  } finally { await f.dispose(); }
});
