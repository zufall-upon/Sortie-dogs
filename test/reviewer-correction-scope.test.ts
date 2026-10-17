import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { missionPlan, missionReviewIndependent } from "../dist/core/operator-mission.js";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { exec, type ObjectValue, fixture, initial, stagedInitial, correctUnicode, inlineReport, selfRecheck } from "./helpers/reviewer-correction-fixture.ts";

test("claimed Mission correction activates before limit-bearing Read or shell, without manual binding", async () => {
  const f = await fixture();
  try {
    await stagedInitial(f);
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt);
    const unit = (await f.run()).units[0]!;
    const read = await f.before("author", "read", { path: unit.handoffPath, limit: 2000 });
    const clipped = 'Read file, lines 1-1\n1: ' + (await readFile(unit.handoffPath, "utf8")).slice(0, 2000) + '... (line truncated to 2000 chars)';
    assert.match(await f.after(read, clipped, { truncated: false }), /SORTIE_EXACT_CONTRACT_VIEW/u,
      "limit is a line count; a full-file request receives exact values despite native line clipping");
    const partial = await f.before("author", "read", { path: unit.handoffPath, offset: 2, limit: 1 });
    assert.equal(await f.after(partial, "partial line", { truncated: false }), "partial line",
      "a true partial range does not acquire a full projection");
    await f.shell("author", "node check.mjs");
    const checks = (await f.run()).units[0]!.reviewerCorrection!.checks;
    assert.equal(checks?.length, 1, "exact admission must bind before a model-chosen Read or its first actual formal check");
    assert.equal(checks![0]!.fresh, true); assert.equal(checks![0]!.dispatchCallID, dispatch.id);
    await correctUnicode(f);
    const expanded = (await f.run()).units[0]!;
    assert.deepEqual(expanded.unit.write, ["README.md", "greet.mjs", "check.mjs"]);
    assert.deepEqual(expanded.reviewerCorrection!.writeUnion, expanded.unit.write);
    await f.shell("author", "node check.mjs");
    await f.shell("author", "git add greet.mjs check.mjs && git commit -m admitted-unicode");
    const current = (await f.run()).units[0]!, evidence = structuredClone(current.reviewerCorrection!.checks), budget = await f.ledger();
    await Promise.all([f.prompt("author", current.task.prompt, current.reviewerCorrection!.promptID),
      f.prompt("author", current.task.prompt, current.reviewerCorrection!.promptID)]);
    assert.deepEqual((await f.run()).units[0]!.unit.write, current.unit.write, "duplicate hook retains CURRENT expanded scope");
    assert.deepEqual((await f.run()).units[0]!.reviewerCorrection!.checks, evidence, "activation does not create or replace execution proof");
    assert.deepEqual((await f.ledger()).state.outstanding_reservations, budget.state.outstanding_reservations);
    assert.equal((await exec("git", ["status", "--short"], { cwd: f.directory })).stdout, "");
    await f.finish(dispatch, "author", inlineReport());
    assert.equal((await f.missions.required("root")).review!.verdict, "self-rechecked");
    assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
    assert.equal((await f.ledger()).state.consumed_units, 2, "one Worker and one correction, no activation unit");
    assert.equal((await f.missions.required("root")).corrections!.length, 1);
    assert.equal(f.history.author!.some(message => message.content?.some((part: ObjectValue) => part.name === "sortie_v010_bind_write_gate")), false);
    assert.equal(f.agents.author!.agent, "dog-reviewer-v010");
    assert.equal(f.storage.has("v2-reviewer-correction-permissions:author"), false);
    assert.equal(Object.keys(f.registry()).some(id => id.startsWith("dog-reviewer-correction-")), false);
  } finally { await f.dispose(); }
});

test("admission activation and legacy bind retries retain expanded correction scope and check occurrences", async () => {
  const f = await fixture();
  try {
    await stagedInitial(f);
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await correctUnicode(f); await f.shell("author", "node check.mjs");
    const current = (await f.run()).units[0]!, checks = structuredClone(current.reviewerCorrection!.checks), budget = await f.ledger();
    await f.prompt("author", current.task.prompt, current.reviewerCorrection!.promptID);
    for (let retry = 0; retry < 2; retry++) {
      const bound = await f.tool("author", "bind_write_gate", { project_root: f.directory, manifest_path: current.manifestPath });
      assert.equal(bound.idempotent, true); assert.equal(bound.manifest_hash, current.hashes[1]);
    }
    await f.prompt("author", current.task.prompt, current.reviewerCorrection!.promptID);
    assert.deepEqual((await f.run()).units[0]!.reviewerCorrection!.checks, checks);
    assert.deepEqual((await f.run()).units[0]!.unit.write, current.unit.write);
    assert.deepEqual((await f.ledger()).state.outstanding_reservations, budget.state.outstanding_reservations);
    await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
  } finally { await f.dispose(); }
});

test("ordinary Reviewer and an unclaimed copied correction Task cannot acquire admission authority", async () => {
  const f = await fixture();
  try {
    await stagedInitial(f);
    const prepared = await f.tool("root", "repair_review");
    await f.prompt("author", prepared.task.prompt);
    await assert.rejects(f.before("author", "patch", { patchText: "*** Begin Patch\n*** Add File: greet.mjs\n+x\n*** End Patch" }), /mission-reviewer-readonly/);
    assert.equal((await f.run()).phase, "prepared");
    assert.equal((await f.run()).units[0]!.reviewerCorrection!.promptID, undefined);
    assert.equal(f.storage.has("v2-reviewer-correction-permissions:author"), false);
    assert.equal((await f.ledger()).state.consumed_units, 1);
    const dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.shell("author", "node check.mjs");
    assert.equal((await f.run()).units[0]!.reviewerCorrection!.checks!.length, 1, "only the actual native admission activates it");
    await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
  } finally { await f.dispose(); }
});

test("cancelled admission cannot reactivate a saved correction prompt or settle its unit twice", async () => {
  const f = await fixture();
  try {
    await stagedInitial(f);
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt);
    const unit = (await f.run()).units[0]!;
    await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
    const settled = (await f.ledger()).records.filter(({ event }) => event.kind === "unit.settled");
    await f.prompt("author", unit.task.prompt, unit.reviewerCorrection!.promptID);
    await assert.rejects(f.before("author", "patch", { patchText: "*** Begin Patch\n*** Add File: greet.mjs\n+x\n*** End Patch" }), /mission-reviewer-readonly|session-inactive/);
    await f.after(dispatch, "Duplicate old native cancellation", { sessionID: "author", status: "cancelled" }, "cancelled");
    assert.deepEqual((await f.ledger()).records.filter(({ event }) => event.kind === "unit.settled"), settled);
    assert.equal((await f.run()).phase, "cancelled");
    assert.equal(f.agents.author!.agent, "dog-reviewer-v010"); assert.equal(f.storage.has("v2-reviewer-correction-permissions:author"), false);
  } finally { await f.dispose(); }
});

for (const mode of ["handoff", "manifest", "copied-child", "wrong-reference", "wrong-parent", "prompt-generation"] as const) {
  test(`admission-owned activation does not authorize a changed or foreign identity: ${mode}`, async () => {
    const f = await fixture();
    try {
      await stagedInitial(f);
      const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
      const unit = (await f.run()).units[0]!;
      if (mode === "handoff" || mode === "manifest") {
        const path = mode === "handoff" ? unit.handoffPath : unit.manifestPath;
        const source = await readFile(path, "utf8"), changed = JSON.parse(source);
        if (mode === "handoff") changed.task.objective += " unauthorized replacement";
        else changed.write.push("settings.json");
        await writeFile(path, JSON.stringify(changed));
        await assert.rejects(f.prompt("author", dispatch.input.prompt), /Handoff denied|contract-invalid|mission-activation/);
        await writeFile(path, source);
      } else if (mode === "copied-child") {
        f.agents.final!.agent = "dog-worker-v010";
        await assert.rejects(f.prompt("final", dispatch.input.prompt), /worker-child-mismatch/);
        assert.equal((await f.run()).units[0]!.childSessionID, "author");
      } else if (mode === "wrong-reference") {
        await assert.rejects(f.prompt("author", dispatch.input.prompt + " altered"), /task-reference-mismatch/);
      } else if (mode === "wrong-parent") {
        await assert.rejects(new OperatorRuntime(f.directory, V010_RUNTIME_PROFILE).claimAdmittedWorkerPrompt("root", "final", "author", dispatch.input.prompt), /parent-mismatch/);
      } else {
        await f.prompt("author", dispatch.input.prompt);
        const admitted = (await f.run()).units[0]!.reviewerCorrection!;
        await assert.rejects(f.prompt("author", unit.task.prompt), /prompt-generation-mismatch/);
        assert.equal((await f.run()).units[0]!.reviewerCorrection!.promptID, admitted.promptID);
      }
      f.terminal("author", "FINDINGS\nNative admission stopped; candidate unchanged.", true);
      await f.after(dispatch, "Native prompt failed", { sessionID: "author", status: "failed" }, "error");
      assert.equal((await f.run()).units[0]!.status, "failed");
      assert.equal((await f.ledger()).state.outstanding_reservations.length, 0);
      assert.equal((await f.ledger()).state.consumed_units, 2);
      assert.equal(f.agents.author!.agent, "dog-reviewer-v010");
      assert.equal(f.storage.has("v2-reviewer-correction-permissions:author"), false);
      await assert.rejects(f.before("author", "patch", { patchText: "*** Begin Patch\n*** Add File: settings.json\n+x\n*** End Patch" }), /mission-reviewer-readonly/);
    } finally { await f.dispose(); }
  });
}

test("staged native correction repairs source/test scope in the SAME admitted Reviewer and completes a fresh receipt", async () => {
  const f = await fixture();
  try {
    const previous = await stagedInitial(f);
    assert.deepEqual(previous.run.units[0]!.unit.write, ["README.md"]);
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.bind("author");
    const before = await f.run(), unit = before.units[0]!, budget = await f.ledger(), switches = f.switches.length;
    await f.shell("author", "node check.mjs");
    const oldChecks = structuredClone((await f.run()).units[0]!.reviewerCorrection!.checks);
    await correctUnicode(f);
    const expanded = await f.run(), next = expanded.units[0]!;
    assert.deepEqual(next.unit.write, ["README.md", "greet.mjs", "check.mjs"]);
    assert.deepEqual(next.reviewerCorrection!.writeUnion, next.unit.write);
    assert.equal(next.callID, dispatch.id); assert.equal(next.childSessionID, "author");
    assert.equal(next.reviewerCorrection!.promptID, unit.reviewerCorrection!.promptID);
    assert.equal(next.reviewerCorrection!.reviewIdentity, unit.reviewerCorrection!.reviewIdentity);
    assert.equal(next.reviewerCorrection!.admittedAt, unit.reviewerCorrection!.admittedAt);
    assert.equal(expanded.generation, before.generation); assert.equal(expanded.dispatched, before.dispatched);
    assert.notEqual(next.hashes[1], unit.hashes[1]); assert.equal(next.hashes[0], unit.hashes[0]);
    assert.deepEqual(next.reviewerCorrection!.checks, oldChecks, "scope repair retains historical proof, never relabels it");
    assert.equal(f.switches.length, switches, "scope repair changes no model, native role or prompt generation");
    assert.deepEqual((await f.ledger()).state.outstanding_reservations, budget.state.outstanding_reservations);
    const manifest = await readFile(next.manifestPath, "utf8"), checks = structuredClone(next.reviewerCorrection!.checks);
    await f.tool("root", "expand_unit", { unit_id: next.unit.id, paths: ["greet.mjs", "check.mjs"], reason: "Already covered correction outputs" });
    assert.equal(await readFile(next.manifestPath, "utf8"), manifest, "covered expansion is a no-op");
    assert.deepEqual((await f.run()).units[0]!.reviewerCorrection!.checks, checks);
    await f.shell("author", "node check.mjs");
    await f.shell("author", "git add greet.mjs check.mjs && git commit -m unicode-correction");
    assert.equal((await exec("git", ["status", "--short"], { cwd: f.directory })).stdout, "");
    await f.finish(dispatch, "author", inlineReport());
    const mission = await f.missions.required("root");
    assert.equal(mission.review!.verdict, "self-rechecked"); assert.equal(mission.review!.selfRecheck!.promptID, unit.reviewerCorrection!.promptID);
    assert.equal(mission.review!.selfRecheck!.author, "author"); assert.equal(missionReviewIndependent(mission, "author"), false);
    assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
    const settled = (await f.ledger()).records.filter(({ event }) => event.kind === "unit.settled");
    await f.after(dispatch, inlineReport(), { sessionID: "author" });
    assert.deepEqual((await f.ledger()).records.filter(({ event }) => event.kind === "unit.settled"), settled);
    assert.equal((await f.ledger()).state.consumed_units, 2);
    assert.equal(f.agents.author!.agent, "dog-reviewer-v010"); assert.equal(f.storage.has("v2-reviewer-correction-permissions:author"), false);
    assert.equal(Object.keys(f.registry()).some(id => id.startsWith("dog-reviewer-correction-")), false);
  } finally { await f.dispose(); }
});

test("staged correction literal shell scope reconciles the original command without a new admission", async () => {
  const f = await fixture();
  try {
    await stagedInitial(f);
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.bind("author");
    const command = "printf 'regression diagnostic' > correction.txt";
    const run = await f.run(), budget = await f.ledger();
    await f.shell("author", command);
    const unit = (await f.run()).units[0]!;
    assert.ok(unit.unit.write.includes("correction.txt"));
    assert.deepEqual(unit.reviewerCorrection!.writeUnion, unit.unit.write);
    assert.equal(unit.reviewerCorrection!.promptID, run.units[0]!.reviewerCorrection!.promptID);
    assert.equal(unit.reviewerCorrection!.checks, undefined, "diagnostics are not formal proof");
    assert.equal(await readFile(join(f.directory, "correction.txt"), "utf8"), "regression diagnostic");
    assert.equal((await f.run()).units[0]!.callID, dispatch.id); assert.equal((await f.run()).generation, run.generation);
    assert.deepEqual((await f.ledger()).state.outstanding_reservations, budget.state.outstanding_reservations);
    await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
  } finally { await f.dispose(); }
});

test("expanded correction cannot accept old-scope checks after actual source/test changes", async () => {
  const f = await fixture();
  try {
    await stagedInitial(f);
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.bind("author"); await f.shell("author", "node check.mjs");
    await correctUnicode(f); await f.shell("author", "git add greet.mjs check.mjs && git commit -m unvalidated-correction");
    await f.finish(dispatch, "author", inlineReport());
    assert.equal((await f.missions.required("root")).corrections![0]!.status, "failed");
    assert.notEqual((await f.missions.required("root")).review!.verdict, "self-rechecked");
    await assert.rejects(f.tool("root", "complete_mission"), /validation|incomplete/);
    assert.equal(f.agents.author!.agent, "dog-reviewer-v010"); assert.equal(f.storage.has("v2-reviewer-correction-permissions:author"), false);
    const retry = await f.tool("root", "repair_review");
    assert.equal(retry.task.task_id, "author");
    assert.deepEqual((await f.run()).units[0]!.unit.write, ["README.md", "greet.mjs", "check.mjs"]);
    const admitted = await f.before("root", "subagent", f.task(retry.task));
    await f.prompt("author", admitted.input.prompt); await f.bind("author"); await f.shell("author", "node check.mjs");
    await f.finish(admitted, "author", inlineReport());
    assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
    assert.equal((await f.ledger()).state.consumed_units, 3, "failed and fresh same-owner correction settle once each");
  } finally { await f.dispose(); }
});

test("failed narrow correction restores read-only, repairs its scope and retries only the SAME native owner", async () => {
  const f = await fixture();
  try {
    await stagedInitial(f);
    const prepared = await f.tool("root", "repair_review"), failed = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", failed.input.prompt); await f.bind("author");
    await f.finish(failed, "author", "FINDINGS\nRetained Unicode defect unresolved; no correction validation or commit occurred.");
    const old = await f.run(), oldLedger = await f.ledger();
    assert.equal(old.units[0]!.status, "failed"); assert.equal(f.agents.author!.agent, "dog-reviewer-v010");
    assert.equal(f.storage.has("v2-reviewer-correction-permissions:author"), false);
    assert.equal(Object.keys(f.registry()).some(id => id.startsWith("dog-reviewer-correction-")), false);
    const scope = await f.tool("root", "expand_unit", { unit_id: "unit-1", paths: ["greet.mjs", "check.mjs"], reason: "Original post-Review source/test correction, not a new user requirement" });
    assert.equal(scope.status, "scope-updated"); assert.equal(scope.task, undefined);
    assert.equal((await f.run()).runID, old.runID); assert.equal((await f.run()).units[0]!.callID, failed.id);
    assert.deepEqual((await f.run()).units[0]!.reviewerCorrection!.writeUnion, ["README.md", "greet.mjs", "check.mjs"]);
    assert.deepEqual((await f.ledger()).records.filter(({ event }) => event.kind === "unit.settled"), oldLedger.records.filter(({ event }) => event.kind === "unit.settled"));
    await assert.rejects(f.before("author", "patch", { patchText: "*** Begin Patch\n*** Add File: greet.mjs\n+x\n*** End Patch" }), /mission-reviewer-readonly/);
    const retry = await f.tool("root", "repair_review");
    assert.equal(retry.task.task_id, "author");
    const admitted = await f.before("root", "subagent", f.task(retry.task));
    await f.prompt("author", admitted.input.prompt); await f.bind("author"); await correctUnicode(f);
    await f.shell("author", "node check.mjs"); await f.shell("author", "git add greet.mjs check.mjs && git commit -m recovered-unicode");
    await f.finish(admitted, "author", inlineReport());
    assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
    await f.after(failed, "Duplicate old failed terminal", { sessionID: "author", status: "failed" }, "error");
    assert.equal((await f.ledger()).state.consumed_units, 3); assert.equal((await f.ledger()).state.outstanding_reservations.length, 0);
    assert.equal(f.agents.author!.agent, "dog-reviewer-v010");
    assert.equal(f.storage.has("v2-reviewer-correction-permissions:author"), false);
  } finally { await f.dispose(); }
});

for (const mode of ["settings", "contracts", "outside-shell", "traversal", "wrong-owner", "stale-owner", "native-deny", "native-ask"] as const) {
  test(`staged correction scope repair preserves existing boundaries: ${mode}`, async () => {
    const f = await fixture();
    try {
      await stagedInitial(f);
      const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
      await f.prompt("author", dispatch.input.prompt); await f.bind("author");
      const before = await f.run(), unit = before.units[0]!, manifest = await readFile(unit.manifestPath, "utf8");
      if (mode === "settings" || mode === "contracts") {
        const path = mode === "settings" ? "settings.json" : ".sortie-dogs-v010/contracts/forbidden.json";
        await assert.rejects(f.tool("root", "expand_unit", { unit_id: "unit-1", paths: [path], reason: "Forbidden output" }), /mission-explicit-write-prohibition/);
        await assert.rejects(f.before("author", "patch", { patchText: `*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch` }), /mission-explicit-write-prohibition/);
      } else if (mode === "outside-shell") {
        await assert.rejects(f.before("author", "shell", { command: `printf x > ${join(f.directory, "../outside.txt")}` }), /project-root-relative path required/);
      } else if (mode === "traversal" || mode === "wrong-owner") {
        await assert.rejects(new OperatorRuntime(f.directory, V010_RUNTIME_PROFILE).expandMissionWriteScope("root", mode === "wrong-owner" ? "final" : "author",
          /^task_id: (.+)$/mu.exec(unit.task.prompt)![1]!, [mode === "traversal" ? "../outside.txt" : "greet.mjs"], async () => async () => {}),
        mode === "traversal" ? /traversal/ : /current-task-required/);
      } else if (mode === "stale-owner") {
        f.terminal("author", "FINDINGS\nCorrection failed without current validation.", true);
        await f.after(dispatch, "Correction failed", { sessionID: "author", status: "failed" }, "error");
        await assert.rejects(f.before("author", "patch", { patchText: "*** Begin Patch\n*** Update File: greet.mjs\n@@\n-old\n+new\n*** End Patch" }), /mission-reviewer-readonly/);
        await f.tool("root", "operator_status");
        assert.equal(f.agents.author!.agent, "dog-reviewer-v010");
        assert.equal(f.storage.has("v2-reviewer-correction-permissions:author"), false);
      } else {
        const effect = mode === "native-deny" ? "deny" : "ask";
        const prior = [{ action: "edit", resource: "*greet.mjs", effect }];
        f.agents.author!.permissions = prior;
        await f.tool("root", "expand_unit", { unit_id: "unit-1", paths: ["greet.mjs"], reason: "Original source correction" });
        assert.equal(await f.permission("author", "edit", join(f.directory, "greet.mjs"), effect === "deny"), effect);
        assert.deepEqual(f.agents.author!.permissions, prior);
        assert.equal(await readFile(join(f.directory, "greet.mjs"), "utf8"), 'export const greet = name => `Hello, ${name.replace(/[^\\x00-\\x7f]/g, "")}!`;\n');
      }
      if (!["native-deny", "native-ask"].includes(mode)) assert.equal(await readFile(unit.manifestPath, "utf8"), manifest);
      await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
    } finally { await f.dispose(); }
  });
}

test("correction commits only actual changed outputs despite unchanged exact permission and deleted scratch", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, "untouched.txt"), "unchanged");
    await exec("git", ["add", "untouched.txt"], { cwd: f.directory });
    await exec("git", ["commit", "-m", "fixture unchanged input"], { cwd: f.directory });
    await initial(f, { write: ["result.txt", "untouched.txt", "scratch.tmp"] });
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.bind("author");
    await f.edit("author", "ready");
    await f.shell("author", "printf scratch > scratch.tmp"); await f.shell("author", "rm scratch.tmp");
    await f.shell("author", "node check.mjs");
    assert.equal((await exec("git", ["diff", "--cached", "--name-only"], { cwd: f.directory })).stdout, "");
    await f.shell("author", "git add result.txt && git diff --cached --stat && git commit -m correction-subset");
    assert.equal((await exec("git", ["status", "--short"], { cwd: f.directory })).stdout, "");
    await f.finish(dispatch, "author", inlineReport());
    assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
    assert.equal((await f.missions.required("root")).review!.verdict, "self-rechecked");
    assert.equal((await f.ledger()).state.consumed_units, 2);
  } finally { await f.dispose(); }
});

for (const mode of ["outside-index", "prohibited-index", "prohibited-add"] as const) test(`correction add then commit preserves actual index and prohibited glob: ${mode}`, async () => {
  const f = await fixture();
  try {
    await initial(f, { write: ["result.txt", "nested/**"] });
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.bind("author");
    await f.missions.update("root", state => { state.prohibitedWrite = ["nested/forbidden/**"]; });
    await f.edit("author", "ready"); await f.shell("author", "node check.mjs");
    const path = mode === "outside-index" ? "outside.txt" : "nested/forbidden/file.txt";
    await mkdir(join(f.directory, "nested/forbidden"), { recursive: true }); await writeFile(join(f.directory, path), "forbidden");
    if (mode !== "prohibited-add") await exec("git", ["add", path], { cwd: f.directory });
    const indexBefore = (await exec("git", ["diff", "--cached", "--name-only"], { cwd: f.directory })).stdout;
    if (mode !== "prohibited-add") await assert.rejects(f.before("author", "shell", { command: "git commit -m forbidden" }),
      mode === "outside-index" ? /cached/ : /mission-explicit-write-prohibition/);
    await assert.rejects(f.before("author", "shell", { command: `git add result.txt${mode === "prohibited-add" ? ` ${path}` : ""} && git commit -m forbidden` }),
      mode === "outside-index" ? /cached/ : /mission-explicit-write-prohibition/);
    assert.equal((await exec("git", ["diff", "--cached", "--name-only"], { cwd: f.directory })).stdout, indexBefore, "denied preflight leaves the actual index unchanged");
    await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
  } finally { await f.dispose(); }
});

test("Reviewer correction inherits the host Git lifecycle and exact proof/declaration rather than creating new authority", async () => {
  const f = await fixture();
  try {
    await f.prompt("root", "Produce ready output with the original check and host-owned commit boundary.");
    await f.tool("root", "start_mission", { requirements: ["Ready output; preserve the check and clean commit"] });
    const raw = { ...missionPlan(await f.missions.required("root"), [{ title: "Ready output", objective: "Produce ready output",
      read: ["check.mjs"], write: ["result.txt"], validation: ["node check.mjs"] }], f.directory),
      git_lifecycle: { branch_create: { branch: "feature/retained-correction", start_ref: "refs/heads/base" },
        commit: { message: "Preserve the authorized commit boundary" }, post_commit_validation: ["node check.mjs"] } };
    const runtime = new OperatorRuntime(f.directory, V010_RUNTIME_PROFILE);
    const first = await runtime.prepareMission("root", raw);
    const implement = async (state: typeof first, child: string, callID: string, text: string) => {
      const task = runtime.nextWorkerTask(state);
      await runtime.admitWorker("root", "root", callID, task);
      await runtime.claimAdmittedWorkerPrompt("root", "root", child, task.prompt);
      await writeFile(join(f.directory, "result.txt"), text + "\n");
      await runtime.beforePostCommitValidation("root", child, "node check.mjs");
      assert.equal(await runtime.postCommitLocked("root"), true);
      await assert.rejects(runtime.beforePostCommitValidation("root", child, "node format.mjs"), /operator-git-post-commit-command-denied/);
      await exec(process.execPath, ["check.mjs"], { cwd: f.directory });
      // Focused core boundary test: bridge evidence is synthetic here, not a native live receipt.
      await runtime.settled({ rootSessionID: "root", callID, childSessionID: child, unitID: state.units[0]!.unit.id,
        disposition: "succeeded", resultClass: "acceptance", evidence: [{ measurement: { criterion_ids: ["requirement-1"] },
          execution: { command: ["node check.mjs"], exit_code: 0 } }] as never });
      return runtime.required("root");
    };
    const settled = await implement(first, "worker", "core-initial", "wrong");
    assert.equal(settled.phase, "awaiting-acceptance");
    const priorHead = settled.gitLifecycle!.committedHead;
    const correctionPlan = { ...raw, units: [{ ...raw.units[0]!, title: "Correct the retained finding", objective: "Correct wrong to ready" }] };
    for (const invalid of [
      { ...correctionPlan, goal_declaration: { ...raw.goal_declaration, goal_budget_units: 999 } },
      { ...correctionPlan, acceptance_proof: [[]] },
      { ...correctionPlan, git_lifecycle: { ...raw.git_lifecycle, commit: { message: "Different authority" } } },
      { ...correctionPlan, units: [{ ...correctionPlan.units[0]!, write: ["undeclared.txt"] }] },
    ]) {
      await assert.rejects(runtime.prepareReviewerCorrection("root", settled.runID, invalid, "author", "review-identity", ["result.txt"]));
      assert.equal((await runtime.required("root")).runID, settled.runID, "rejected correction retains the settled candidate");
    }
    const corrected = await runtime.prepareReviewerCorrection("root", settled.runID, correctionPlan, "author", "review-identity", ["result.txt"]);
    assert.equal(corrected.units[0]!.task.task_id, "author");
    assert.equal(corrected.units[0]!.task.subagent_type, "dog-reviewer-v010");
    assert.deepEqual(corrected.gitLifecycle, { ...settled.gitLifecycle, committedHead: null, commitProvenance: null });
    assert.deepEqual(corrected.acceptanceProof, settled.acceptanceProof);
    assert.deepEqual(corrected.sourceRefs, settled.sourceRefs);
    assert.equal(corrected.acceptanceFingerprint, settled.acceptanceFingerprint);
    assert.equal(corrected.units[0]!.hashes[2], settled.units[0]!.hashes[2], "fixed declaration hash is inherited unchanged");
    assert.deepEqual(corrected.units[0]!.evidence, [], "old validation cannot certify the correction");
    assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: f.directory })).stdout.trim(), priorHead);
    const cold = new OperatorRuntime(f.directory, V010_RUNTIME_PROFILE);
    const done = await implement(await cold.required("root"), "author", "core-correction", "ready");
    assert.equal(done.phase, "awaiting-acceptance");
    assert.notEqual(done.gitLifecycle!.committedHead, priorHead);
    assert.equal(done.gitLifecycle!.commitProvenance, "host-created");
    assert.equal((await exec("git", ["rev-parse", "HEAD^"], { cwd: f.directory })).stdout.trim(), priorHead);
    assert.equal((await exec("git", ["log", "-1", "--format=%s"], { cwd: f.directory })).stdout.trim(), raw.git_lifecycle.commit.message);
    assert.equal((await exec("git", ["branch", "--show-current"], { cwd: f.directory })).stdout.trim(), raw.git_lifecycle.branch_create.branch);
    assert.equal((await exec("git", ["status", "--porcelain"], { cwd: f.directory })).stdout, "");
  } finally { await f.dispose(); }
});
