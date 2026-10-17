import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { canonicalDeclaredValidationMembers } from "../dist/plugin/gate.js";
import { reviewerCorrectionValidation } from "../dist/plugin/mission-review.js";
import { exec, type ObjectValue, fixture, initial, inlineReport, selfRecheck } from "./helpers/reviewer-correction-fixture.ts";

for (const cold of [false, true]) test(`Reviewer repairs an expected-nonzero check recipe in the same correction admission: ${cold ? "cold" : "live"}`, async () => {
  const f = await fixture();
  try {
    const started = await initial(f, { keepReviewOpen: true, validation: ["node required-test.mjs", "node check.mjs"] });
    await f.tool("author", "repair_review", { findings: "Medium: preserve required behavior." });
    await f.edit("author", "ready corrected\n");
    await f.shell("author", "node required-test.mjs");
    await f.shell("author", "node check.mjs");
    const unchangedChecks = structuredClone((await f.run()).units[0]!.reviewerCorrection!.checks!);
    const raw = 'node -e "process.exit(65)"';
    await f.tool("author", "repair_review", { validation: ["node required-test.mjs", raw, "node check.mjs"], reason: "Register CLI reproduction." });
    await f.shell("author", raw);
    const failed = await f.tool("author", "finish_direct_unit");
    assert.equal(failed.status, "direct-unit-awaits-validation");
    assert.match(failed.reason, /validation-failed/);
    const before = await f.run(), missionBefore = await f.missions.required("root");
    const recipe = 'node -e "process.exit(65)"; test $? -eq 65';
    // Earlier success is not proof for a later recipe registration.
    await f.shell("author", recipe);
    await new Promise(resolve => setTimeout(resolve, 5));
    await assert.rejects(f.tool("root", "repair_review", { validation: [recipe], reason: "expected diagnostic exit" }), /registration-owner/);
    const corrected = await f.tool("author", "repair_review", {
      validation: ["node required-test.mjs", recipe, "node check.mjs"], reason: "Assert expected diagnostic exit rather than require the raw command to exit zero." });
    assert.equal(corrected.status, "correction-registration-corrected");
    assert.equal(corrected.task, undefined);
    const after = await f.run();
    assert.equal(after.runID, before.runID);
    assert.equal(after.units[0]!.callID, before.units[0]!.callID);
    assert.equal(after.units[0]!.reviewerCorrection!.admittedAt, before.units[0]!.reviewerCorrection!.admittedAt);
    assert.deepEqual(after.units[0]!.unit.write, before.units[0]!.unit.write);
    assert.deepEqual(after.units[0]!.reviewerCorrection!.checks, before.units[0]!.reviewerCorrection!.checks);
    assert.equal(after.units[0]!.reviewerCorrection!.validationRegisteredAt?.["node required-test.mjs"], undefined);
    assert.equal(after.units[0]!.reviewerCorrection!.validationRegisteredAt?.["node check.mjs"], undefined);
    assert.deepEqual(await f.missions.required("root"), missionBefore);
    if (cold) await f.start();
    assert.equal((await f.tool("author", "finish_direct_unit")).status, "direct-unit-awaits-validation");
    await f.shell("author", recipe);
    await f.shell("author", "git add -- result.txt && git commit -m correction");
    assert.equal((await f.tool("author", "finish_direct_unit")).status, "correction-validated");
    const checks = (await f.run()).units[0]!.reviewerCorrection!.checks!;
    for (const check of unchangedChecks) {
      assert.deepEqual(checks.find(item => item.callID === check.callID), check, "unchanged checks retain their original native receipt and snapshot");
      assert.equal(checks.filter(item => item.command.includes(check.command[0]!)).length, 1, "unchanged successful checks are never rerun");
    }
    if (cold) return; // Durable recipe/freshness survives reload; live branch checks native terminal acceptance.
    const report = 'SELF_RECHECKED\nself_recheck: {"candidate":"current-validated","unresolved_findings":[],"residual_major":null}\nCompared retained findings, original behavior and expected diagnostic with fresh checks.';
    const returned = JSON.parse(await f.finish(started.dispatch, "author", report));
    assert.equal(returned.status, "review-correction-recorded", JSON.stringify(returned));
    assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
    assert.equal((await f.ledger()).state.consumed_units, 2);
  } finally { await f.dispose(); }
});

for (const cold of [false, true]) test(`Reviewer recipe cwd repair retains the unchanged later check: ${cold ? "cold" : "live"}`, async () => {
  const f = await fixture();
  try {
    const A = `node -e "if(!require('node:fs').readFileSync('${join(f.directory, "result.txt")}', 'utf8').trim()) process.exit(1)"`;
    const B = "node check.mjs", alternate = join(f.directory, ".cache", "alternate");
    await mkdir(alternate, { recursive: true });
    await initial(f, { keepReviewOpen: true, validation: [A, B] });
    await f.tool("author", "repair_review", { findings: "Medium: output must be ready." });
    await f.edit("author", "ready");
    await f.shell("author", A); await f.shell("author", B);
    const before = await f.run(), checks = structuredClone(before.units[0]!.reviewerCorrection!.checks!);
    await f.tool("author", "repair_review", { validation_cwd: { [A]: f.directory }, reason: "Spell the existing cwd explicitly." });
    assert.equal((await f.run()).units[0]!.reviewerCorrection!.validationRegisteredAt?.[A], undefined,
      "equivalent cwd metadata does not invalidate the existing check");
    await f.tool("author", "repair_review", { validation_cwd: { [A]: alternate }, reason: "Bind only the first check to its actual cwd." });
    const registered = (await f.run()).units[0]!.reviewerCorrection!.validationRegisteredAt!;
    assert(registered[A]); assert.equal(registered[B], undefined);
    assert.equal((await f.tool("author", "finish_direct_unit")).status, "direct-unit-awaits-validation");
    await f.shell("author", A); // Success in the old cwd is a diagnostic, not the repaired registration.
    assert.equal((await f.tool("author", "finish_direct_unit")).status, "direct-unit-awaits-validation");
    if (cold) await f.start();
    await f.shell("author", A, 0, alternate);
    await f.shell("author", "git add -- result.txt && git commit -m cwd-correction");
    assert.equal((await f.tool("author", "finish_direct_unit")).status, "correction-validated");
    const after = await f.run(), retained = after.units[0]!.reviewerCorrection!.checks!;
    assert.equal(after.runID, before.runID); assert.equal(after.units[0]!.callID, before.units[0]!.callID);
    assert.deepEqual(retained.find(check => check.callID === checks[1]!.callID), checks[1]);
    assert.equal(retained.filter(check => check.command.includes(B)).length, 1, "the unaffected later check is never rerun");
    assert.equal(retained.filter(check => check.command.includes(A)).length, 2, "only the newly registered cwd produces a replacement receipt");
    assert.equal((await f.ledger()).state.consumed_units, 2);
    assert.equal((await f.ledger()).state.outstanding_reservations.length, 0);
  } finally { await f.dispose(); }
});

for (const changed of ["candidate", "executable", "environment"] as const) test(`Reviewer recipe repair does not promote a stale retained PASS: ${changed}`, async () => {
  const key = "SORTIE_RECIPE_REPAIR_INPUT", prior = process.env[key];
  process.env[key] = "original";
  const f = await fixture();
  try {
    const A = `${key}=$${key} node required-test.mjs`, B = "node check.mjs";
    await initial(f, { keepReviewOpen: true, validation: [A, B] });
    await f.tool("author", "repair_review", { findings: "Medium: output must be ready." });
    await f.edit("author", "ready");
    await f.shell("author", A); await f.shell("author", B);
    const checks = structuredClone((await f.run()).units[0]!.reviewerCorrection!.checks!);
    const extra = 'node -e "if(!require(\'node:fs\').readFileSync(\'result.txt\', \'utf8\').startsWith(\'ready\')) process.exit(1)"';
    await f.tool("author", "repair_review", { validation: [A, extra, B], reason: "Add the ready-output diagnostic without rerunning unchanged checks." });
    if (changed === "candidate") await f.edit("author", "ready changed");
    if (changed === "executable") await writeFile(join(f.directory, "required-test.mjs"),
      (await readFile(join(f.directory, "required-test.mjs"), "utf8")) + "// changed executable input\n");
    if (changed === "environment") process.env[key] = "changed";
    await f.shell("author", extra);
    const result = await f.tool("author", "finish_direct_unit");
    assert.equal(result.status, "direct-unit-awaits-validation");
    assert.match(result.reason, /correction-validation-stale/);
    const current = (await f.run()).units[0]!.reviewerCorrection!.checks!;
    assert.deepEqual(current.slice(0, 2), checks, "old native receipts remain historical and are not relabeled");
    assert.equal(current.length, 3, "only the new check ran; stale inputs are reported rather than silently revalidated");
  } finally {
    if (prior === undefined) delete process.env[key]; else process.env[key] = prior;
    await f.dispose();
  }
});

test("Reviewer recipe repair preserves original chain members and still requires each real repeated occurrence", () => {
  const A = "node a.mjs", B = "node b.mjs", C = "node c.mjs", child = "author";
  const part = (commands: string[], callID: string, start: number, exit = 0) => ({ type: "tool", tool: "shell", callID,
    state: { status: "completed", input: { command: commands.join(" && ") }, metadata: { exit }, time: { start, end: start + 10 } } });
  const old = part([A, B], "original-chain", 110), corrected = part([C], "corrected", 210), repeated = part([A], "repeated", 230);
  const binding = (item: ReturnType<typeof part>, command: string[]) => ({ childSessionID: child, callID: item.callID,
    command, fresh: true, exitCode: item.state.metadata.exit,
    startedAt: new Date(item.state.time.start).toISOString(), endedAt: new Date(item.state.time.end).toISOString() });
  const checks = [binding(old, [A, B]), binding(corrected, [C]), binding(repeated, [A])] as any;
  const compare = (validation: string[], parts: unknown[], bindings = checks) => reviewerCorrectionValidation(validation, child,
    [{ info: { role: "assistant", sessionID: child }, parts }], 100, bindings, undefined, undefined, { [C]: new Date(200).toISOString() });
  const result = compare([A, C, B], [old, corrected]);
  assert.equal(result.ready, true);
  assert.equal(compare([], [old, corrected]).ready, false, "an empty recipe cannot turn history into validation");
  assert.deepEqual(result.matched, [
    { callID: "original-chain", member: 0, occurrence: 0 },
    { callID: "corrected", member: 0, occurrence: 1 },
    { callID: "original-chain", member: 1, occurrence: 2 },
  ]);
  assert.equal(compare([A, C, B], [old]).ready, false, "the repaired recipe needs its own native success");
  assert.equal(compare([A, C, B, A], [old, corrected, old]).ready, false, "one old call cannot fill a new repeated occurrence");
  assert.equal(compare([A, C, B, A], [old, corrected, repeated]).ready, true);
  const failed = part([A, B], "original-chain", 110, 1);
  assert.equal(compare([A, C, B], [failed, corrected], [binding(failed, [A, B]), checks[1]]).ready, false,
    "a failed chain never lends an inferred member PASS to the repaired recipe");
});

test("declared composite validation is atomic before chain decomposition", () => {
  const A = "node required-test.mjs", B = "node check.mjs", C = `${A} && ${B}`;
  assert.deepEqual(canonicalDeclaredValidationMembers(C, new Set([C, A, B])), [C]);
  assert.deepEqual(canonicalDeclaredValidationMembers(`${C} && ${C}`, new Set([C])), [C, C]);
  assert.deepEqual(canonicalDeclaredValidationMembers(`${C} && ${A}`, new Set([C, A])), [C, A]);
  assert.equal(canonicalDeclaredValidationMembers(A, new Set([C])), undefined);
  assert.equal(canonicalDeclaredValidationMembers(`${C} && printf x > undeclared.txt`, [C]), undefined);
  assert.equal(canonicalDeclaredValidationMembers(`${C}; printf x > result.txt`, [C]), undefined);
  assert.deepEqual(canonicalDeclaredValidationMembers(`${C} && ${C}`, [A, B, C]), [A, B, C]);
  assert.deepEqual(canonicalDeclaredValidationMembers(`${C} && ${C}`, [C, A, B]), [C, A, B]);
  assert.deepEqual(canonicalDeclaredValidationMembers(`${C} && ${C}`, [A, B, A, B]), [A, B, A, B]);
  assert.deepEqual(canonicalDeclaredValidationMembers(C, [A, B, C]), [C], "exact WHOLE declaration wins before occurrence-aware coalescing");
  assert.deepEqual(canonicalDeclaredValidationMembers(`${C} && ${C}`, [A, B, C], 2), [C, A, B], "current occurrence, not longest Set match");
});

for (const order of ["A,B,C", "C,A,B", "A,B,A,B", "C,C", "A,B,C,A,B,C"] as const) for (const failed of [false, true]) {
  test(`mixed coalesced validation ${order} ${failed ? "failed chain" : "success"} binds execution/history identically`, async () => {
    const f = await fixture();
    try {
      const A = "node required-test.mjs", B = "node check.mjs", C = `${A} && ${B}`;
      const map = { A, B, C }, validation = order.split(",").map(key => map[key as keyof typeof map]);
      await initial(f, { validation });
      const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
      await f.prompt("author", dispatch.input.prompt); await f.bind("author");
      await f.edit("author", failed ? "bad-required" : "ready");
      await f.shell("author", "git add -- result.txt"); await f.shell("author", "git commit -m ordered-composite");
      await f.shell("author", validation.join(" && "));
      const check = (await f.run()).units[0]!.reviewerCorrection!.checks!.at(-1)!;
      assert.deepEqual(check.command, validation); assert.equal(check.dispatchCallID, dispatch.id);
      assert.equal(check.exitCode, failed ? 1 : 0);
      await f.finish(dispatch, "author", inlineReport());
      assert.equal((await f.missions.required("root")).corrections![0]!.status, failed ? "failed" : "ready");
      if (failed) await assert.rejects(f.tool("root", "complete_mission"), /validation|incomplete/);
      else assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
    } finally { await f.dispose(); }
  });
}

test("ordered mixed composite uses progress from preceding actual calls and retains call/member/occurrence binding", async () => {
  const f = await fixture();
  try {
    const A = "node required-test.mjs", B = "node check.mjs", C = `${A} && ${B}`;
    await initial(f, { validation: [A, B, C] });
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.bind("author");
    await f.edit("author", "ready"); await f.shell("author", "git add -- result.txt"); await f.shell("author", "git commit -m occurrence-position");
    await f.shell("author", A);
    await f.shell("author", `${B} && ${C}`);
    const checks = (await f.run()).units[0]!.reviewerCorrection!.checks!;
    assert.deepEqual(checks.map(check => check.command), [[A], [B, C]]);
    assert.notEqual(checks[0]!.callID, checks[1]!.callID);
    const runtime = new OperatorRuntime(f.directory, V010_RUNTIME_PROFILE), state = await f.run();
    state.units[0]!.reviewerCorrection!.checks![1]!.command = [C, B];
    await writeFile(runtime.statePath("root"), JSON.stringify(state));
    await f.start();
    await f.finish(dispatch, "author", inlineReport());
    assert.equal((await f.missions.required("root")).corrections![0]!.status, "failed", "different saved call-member decomposition cannot certify actual history");
  } finally { await f.dispose(); }
});

test("semicolon declaration uses independent native parsed resources, one atomic formal check, and unchanged explicit deny/ask", async () => {
  const f = await fixture();
  try {
    const A = "node required-test.mjs", B = "node check.mjs", C = `${A}; ${B}`;
    await initial(f, { validation: [C] });
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.bind("author");
    await f.edit("author", "ready"); await f.shell("author", "git add -- result.txt"); await f.shell("author", "git commit -m semicolon-declaration");
    for (const effect of ["deny", "ask"] as const) {
      f.agents.author!.permissions = [{ action: "shell", resource: B, effect }];
      assert.equal(await f.permission("author", "shell", [A, B]), effect);
      if (effect === "deny") await assert.rejects(f.before("author", "shell", { command: C }), /native permission denied shell/);
    }
    delete f.agents.author!.permissions;
    await f.shell("author", A); await f.shell("author", B);
    assert.equal((await f.run()).units[0]!.reviewerCorrection!.checks, undefined, "standalone resources are diagnostics, not the composite declaration");
    await f.shell("author", C);
    assert.deepEqual((await f.run()).units[0]!.reviewerCorrection!.checks!.map(check => check.command), [[C]]);
    await f.finish(dispatch, "author", inlineReport());
    assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
  } finally { await f.dispose(); }
});

for (const mode of ["wrong-only", "diagnostic-before", "diagnostic-after"] as const) test(`correction formal proof binds native check directory: ${mode}`, async () => {
  const f = await fixture();
  try {
    const A = "node required-test.mjs", B = "node check.mjs", C = `${A} && ${B}`;
    const validation = [A, B, C];
    await initial(f, { validation });
    const other = join(f.directory, ".cache", "other");
    await mkdir(other, { recursive: true });
    for (const name of ["required-test.mjs", "check.mjs"]) await writeFile(join(other, name), await readFile(join(f.directory, name)));
    await writeFile(join(other, "result.txt"), "ready\n");
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.bind("author");
    await f.edit("author", mode === "wrong-only" ? "bad-required" : "ready");
    await f.shell("author", "git add -- result.txt"); await f.shell("author", "git commit -m directory-binding");
    let diagnostic = 0;
    const elsewhere = async (command: string) => {
      const event = await f.before("author", "shell", { command, workdir: diagnostic++ % 2 ? other : ".cache/other" });
      const result = await exec("bash", ["-c", event.input.command], { cwd: resolve(f.directory, event.input.workdir) })
        .catch(error => ({ stdout: error.stdout, code: error.code }));
      await f.after(event, result.stdout, { exit: "code" in result ? result.code : 0 });
    };
    if (mode === "wrong-only") {
      for (const command of validation) await elsewhere(command);
      assert.equal((await f.run()).units[0]!.reviewerCorrection!.checks, undefined,
        "checks of another directory never acquire the root candidate binding");
    } else {
      await f.shell("author", A);
      if (mode === "diagnostic-before") await elsewhere(`${B} && ${C}`);
      const formal = await f.before("author", "shell", { command: `${B} && ${C}`, workdir: mode === "diagnostic-after" ? f.directory : "." });
      const output = await exec("bash", ["-c", formal.input.command], { cwd: resolve(f.directory, formal.input.workdir) });
      await f.after(formal, output.stdout, { exit: 0 });
      if (mode === "diagnostic-after") {
        await writeFile(join(other, "result.txt"), "bad-required\n");
        for (const command of validation) await elsewhere(command);
      }
      assert.deepEqual((await f.run()).units[0]!.reviewerCorrection!.checks!.map(check => check.command), [[A], [B, C]],
        "other-directory diagnostics do not alter ordered formal progress or call-member bindings");
    }
    await f.finish(dispatch, "author", inlineReport());
    if (mode === "wrong-only") {
      assert.equal((await f.missions.required("root")).corrections![0]!.status, "failed");
      await assert.rejects(f.tool("root", "complete_mission"), /validation|incomplete/);
      const summary = (await f.tool("root", "operator_status")).acceptance_summary.native_declared_validation.find((item: ObjectValue) => !item.historical);
      assert.deepEqual(summary.observations.not_observed, validation);
    } else assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
  } finally { await f.dispose(); }
});

test("atomic composite shell admission preserves native parsed-member and whole-command deny/ask", async () => {
  const f = await fixture();
  try {
    const A = "node required-test.mjs", B = "node check.mjs", C = `${A} && ${B}`;
    await initial(f, { validation: [C] });
    const prepared = await f.tool("root", "repair_review");
    const dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.bind("author");
    for (const resource of [A, C]) for (const effect of ["deny", "ask"] as const) {
      f.agents.author!.permissions = [{ action: "shell", resource, effect }];
      assert.equal(await f.permission("author", "shell", resource), effect, "real configured rule keeps its native effect");
      if (effect === "deny" && resource === A) await assert.rejects(f.before("author", "shell", { command: C }), /native permission denied shell/);
      else {
        const shell = await f.before("author", "shell", { command: C });
        assert.equal(await f.permission("author", "shell", [A, B], false, shell.id), resource === A ? effect : "allow", "ACTUAL parsed resources, not invented whole-command projection");
      }
    }
    await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
  } finally { await f.dispose(); }
});

for (const failed of [false, true]) test(`native exact composite required check ${failed ? "failure" : "success"} retains one atomic call binding`, async () => {
  const f = await fixture();
  try {
    const C = "node required-test.mjs && node check.mjs";
    await initial(f, { validation: [C, C] });
    const prepared = await f.tool("root", "repair_review");
    const dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.bind("author");
    await f.edit("author", failed ? "bad-required" : "ready");
    await f.shell("author", "git add -- result.txt"); await f.shell("author", "git commit -m composite-correction");
    await f.shell("author", "node required-test.mjs"); // Diagnostic, never partial composite proof.
    await f.shell("author", C); await f.shell("author", C);
    const checks = (await f.run()).units[0]!.reviewerCorrection!.checks!;
    assert.equal(checks.length, 2);
    assert(checks.every(check => JSON.stringify(check.command) === JSON.stringify([C])));
    assert.notEqual(checks[0]!.callID, checks[1]!.callID);
    assert(checks.every(check => check.dispatchCallID === dispatch.id && check.exitCode === (failed ? 1 : 0)));
    await f.finish(dispatch, "author", "CORRECTION_READY");
    assert.equal((await f.missions.required("root")).corrections![0]!.status, failed ? "failed" : "ready");
    if (failed) await assert.rejects(f.tool("root", "complete_mission"), /correction-validation|incomplete/);
    else {
      const self = await selfRecheck(f); await f.finish(self.dispatch, "author", self.text);
      assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
    }
  } finally { await f.dispose(); }
});

test("exact correction chains preserve each member's native deny and ask", async () => {
  const f = await fixture();
  try {
    const A = "node required-test.mjs", B = "node check.mjs";
    await initial(f, { validation: [A, B] });
    const prepared = await f.tool("root", "repair_review");
    const correction = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", correction.input.prompt); await f.bind("author");
    for (const effect of ["deny", "ask", "allow"] as const) {
      f.agents.author!.permissions = [{ action: "shell", resource: A, effect }];
      assert.equal(await f.permission("author", "shell", [A, B]), effect,
        "actual native parsed resources preserve each configured member effect");
    }
    await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
  } finally { await f.dispose(); }
});

for (const mode of ["four", "two", "early-fail", "late-fail", "chain", "failed-chain", "retry"] as const) {
  test(`native correction executes each inherited [A,B,A,B] occurrence: ${mode}`, async () => {
    const f = await fixture();
    try {
      const validation = ["node required-test.mjs", "node check.mjs", "node required-test.mjs", "node check.mjs"];
      await initial(f, { validation });
      const initialValidation = (await f.ledger()).records.filter(({ event }) => event.kind === "validation.admission");
      assert.equal(initialValidation.filter(({ event }) => event.kind === "validation.admission" && event.decision === "ALLOW").length, 2,
        "the original Worker also actually executes/counts both mandatory canonical occurrences");
      assert.equal(initialValidation.some(({ event }) => event.kind === "validation.admission" && event.decision === "SKIP"), false);
      const prepared = await f.tool("root", "repair_review");
      assert.deepEqual((await f.run()).units[0]!.unit.validation, validation, "planning and correction preserve every declared occurrence");
      const correction = await f.before("root", "subagent", f.task(prepared.task));
      await f.prompt("author", correction.input.prompt); await f.bind("author"); await f.edit("author", "ready");
      await f.shell("author", "git add -- result.txt"); await f.shell("author", "git commit -m correction");
      if (mode === "chain" || mode === "failed-chain") {
        await f.shell("author", validation.join(" && "), mode === "failed-chain" ? 1 : 0);
      } else {
        for (const [i, command] of (mode === "two" ? validation.slice(0, 2) : validation).entries()) {
          await f.shell("author", command, mode === "early-fail" && i === 0 || mode === "late-fail" && i === 2 ? 1 : 0);
        }
        if (mode === "retry") for (const command of validation) await f.shell("author", command);
      }
      const checkedRun = await f.run();
      const checks = checkedRun.units[0]!.reviewerCorrection!.checks!;
      assert.equal(checks.length, mode === "two" ? 2 : mode.includes("chain") ? 1 : mode === "retry" ? 8 : 4);
      const validations = (await f.ledger()).records.filter(({ event }) => event.kind === "validation.admission");
      assert(validations.every(({ event }) => event.kind !== "validation.admission" || event.operation_id === undefined ||
        !checks.some(check => check.callID === event.operation_id) || event.decision === "ALLOW"), "mandatory repeats never become SKIP notices");
      await f.finish(correction, "author", "CORRECTION_READY");
      assert.equal((await f.missions.required("root")).corrections![0]!.status, ["four", "chain", "retry"].includes(mode) ? "ready" : "failed");
    } finally { await f.dispose(); }
  });
}

for (const mode of ["hook-edit", "hook-edit-rerun", "scratch-cold", "missing-binding", "generators", "report-edit"] as const) {
  test(`required correction checks retain actual candidate bindings: ${mode}`, async () => {
    const f = await fixture();
    try {
      const validation = mode === "generators" ? ["node generate.mjs", "node format.mjs", "node required-test.mjs", "node check.mjs"]
        : mode === "scratch-cold" ? ["TMPDIR=.cache node required-test.mjs", "TMPDIR=.cache node check.mjs"]
        : ["node required-test.mjs", "node check.mjs"];
      await initial(f, { validation, ...(mode === "report-edit" ? { write: ["result.txt", "reports/**"] } : {}) });
      const prepared = await f.tool("root", "repair_review");
      const correction = await f.before("root", "subagent", f.task(prepared.task));
      await f.prompt("author", correction.input.prompt); await f.bind("author"); await f.edit("author", "ready");
      for (const command of validation.slice(0, -1)) await f.shell("author", command);
      if (mode.startsWith("hook-edit")) {
        const hook = join(f.directory, ".git", "hooks", "pre-commit");
        await writeFile(hook, '#!/bin/sh\nprintf "hook-changed\\n" > result.txt\ngit add -- result.txt\n'); await chmod(hook, 0o755);
      }
      await f.shell("author", "git add -- result.txt && git commit -m correction");
      if (mode === "hook-edit-rerun") await f.shell("author", "node required-test.mjs");
      await f.shell("author", validation.at(-1)!);
      if (mode === "report-edit") {
        const report = await f.before("author", "patch", { patchText: "*** Begin Patch\n*** Add File: reports/result.md\n+Native checks passed.\n*** End Patch" });
        await mkdir(join(f.directory, "reports"));
        await writeFile(join(f.directory, "reports/result.md"), "Native checks passed.\n");
        await f.after(report, "Added report");
      }
      await f.finish(correction, "author", "CORRECTION_READY");
      if (mode === "missing-binding") {
        const runtime = new OperatorRuntime(f.directory, V010_RUNTIME_PROFILE);
        const statePath = runtime.statePath("root");
        const state = JSON.parse(await readFile(statePath, "utf8"));
        state.units[0].reviewerCorrection.checks = state.units[0].reviewerCorrection.checks.filter((check: ObjectValue) => check.command[0] !== "node required-test.mjs");
        await writeFile(statePath, JSON.stringify(state));
      }
      if (mode === "scratch-cold") {
        await mkdir(join(f.directory, ".cache"), { recursive: true });
        await writeFile(join(f.directory, ".cache", "scratch"), "ignored cache");
      }
      await f.start(); // Settlement erased live executions; later Review uses original persisted recipes.
      const expected = mode === "hook-edit" ? "failed" : "ready";
      assert.equal((await f.missions.required("root")).corrections![0]!.status, expected);
      if (mode === "missing-binding") await assert.rejects(f.tool("root", "review_mission", { risk_tags: ["public-logic"] }), /correction-validation-binding-unavailable/);
      else if (expected === "ready") assert.equal((await f.tool("root", "review_mission", { risk_tags: ["public-logic"] })).status, "self-recheck-required");
      const checks = (await f.run()).units[0]!.reviewerCorrection!.checks!;
      assert(checks.every(check => check.binding.freshness && check.dispatchCallID === correction.id));
      if (mode === "generators") assert(checks.slice(0, 2).every(check => check.generatedInputs));
    } finally { await f.dispose(); }
  });
}

for (const mode of ["missing", "failed", "historical", "out-of-order", "source-changed", "fresh-pass"] as const) {
  test(`all inherited correction checks require fresh native outcomes: ${mode}`, async () => {
    const f = await fixture();
    try {
      await initial(f, { validation: ["node required-test.mjs", "node check.mjs"] });
      if (mode === "historical") {
        const past = Date.now() - 60_000;
        (f.history.author ??= []).push({ id: "old-review-context", type: "assistant", agent: "dog-reviewer-v010", content: [{ type: "tool", name: "shell", id: "historical-check",
          time: { ran: past, completed: past + 1 }, state: { status: "completed", input: { command: "node required-test.mjs" }, metadata: { exit: 0 } } }] });
      }
      const prepared = await f.tool("root", "repair_review");
      const correction = await f.before("root", "subagent", f.task(prepared.task));
      await f.prompt("author", correction.input.prompt); await f.bind("author");
      await f.edit("author", mode === "failed" ? "bad-required" : "ready");
      if (mode === "out-of-order") await f.shell("author", "node check.mjs");
      if (!["missing", "historical"].includes(mode)) await f.shell("author", "node required-test.mjs");
      if (mode === "source-changed") await f.edit("author", "ready-again");
      await f.shell("author", "git add -- result.txt"); await f.shell("author", "git commit -m correction");
      if (mode !== "out-of-order") await f.shell("author", "node check.mjs");
      await f.finish(correction, "author", "CORRECTION_READY\nThe canonical check passed.");
      const mission = await f.missions.required("root"), run = await f.run(), ledger = await f.ledger();
      assert.equal(mission.corrections![0]!.status, mode === "fresh-pass" ? "ready" : "failed");
      assert.equal(ledger.state.outstanding_reservations.length, 0);
      assert.equal(ledger.state.consumed_units, 2);
      assert.equal(f.agents.author!.agent, "dog-reviewer-v010");
      const settled = ledger.records.map(record => record.event).filter(event => event.kind === "unit.settled").at(-1)!;
      assert.equal(settled.disposition, mode === "fresh-pass" ? "succeeded" : "failed");
      if (mode !== "fresh-pass") {
        assert.equal(run.phase, "awaiting-decision");
        assert.equal(settled.evidence.length, 0, "canonical-only evidence cannot silently satisfy a missing mandatory check");
        if (mode === "historical") {
          const status = await f.tool("root", "operator_status");
          const validation = status.acceptance_summary.native_declared_validation.find((item: ObjectValue) => !item.historical);
          assert(validation.observations.not_observed.includes("node required-test.mjs"), "acceptance summary also excludes initial Reviewer history");
        }
        await assert.rejects(f.tool("root", "review_mission", { risk_tags: ["public-logic"] }), /awaits-unit-validation|terminal-unreconciled/);
        // Even an independently accepted final Reviewer cannot mask the inherited missing check.
        await f.missions.update("root", state => { state.review = { ...state.review!, runID: run.runID, child: "final", verdict: "PASS" }; });
        await assert.rejects(f.tool("root", "complete_mission"), /correction-validation|unit-validation|awaiting|incomplete/);
      } else {
        const review = await f.tool("root", "review_mission", { risk_tags: ["public-logic"] });
        const dispatch = await f.before("root", "subagent", f.task(review.task));
        await f.prompt("author", dispatch.input.prompt);
        await f.finish(dispatch, "author", `SELF_RECHECKED\nself_recheck: ${JSON.stringify({ candidate: (await f.missions.required("root")).review!.source, unresolved_findings: [], residual_major: null })}\nBoth inherited checks passed on this correction; original requirements and relevant impact compared.`);
        assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
      }
    } finally { await f.dispose(); }
  });
}
