import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { nativeReviewerRoleRules } from "../dist/plugin/v2.js";
import { OpenCode } from "@opencode/client";
import { convertedAssetPermissions, evaluate, whollyDisabled, type Rule } from "./fixtures/native-v2-2018-contract.ts";
import { runtimeAssets } from "../dist/runtime-assets-v010.js";
import { exec, fixture, initial, inlineReport } from "./helpers/reviewer-correction-fixture.ts";

for (const effect of ["allow", "ask"] as const) test(`native correction dispatch admits wildcard deny then original-target ${effect} without alias grants`, async () => {
  const f = await fixture();
  try {
    await initial(f);
    const rules: Rule[] = [{ action: "subagent", resource: "*", effect: "deny" },
      { action: "subagent", resource: "dog-reviewer-v010", effect }];
    f.agents.root!.permissions = rules;
    const prepared = await f.tool("root", "repair_review");
    const dispatch = await f.before("root", "subagent", f.task(prepared.task));
    assert.equal(dispatch.input.agent, "dog-reviewer-v010");
    assert.equal(await f.permission("root", "subagent", dispatch.input.agent), effect);
    await f.prompt("author", dispatch.input.prompt);
    assert.match(f.agents.author!.agent, /^dog-reviewer-correction-/);
    assert.equal(await f.permission("root", "subagent", f.agents.author!.agent), "deny", "native alias would be denied before evaluate, so it is NEVER the dispatch target");
    assert.deepEqual(f.agents.root!.permissions, rules);
    assert.equal(f.registry()["dog-operator"]!.permissions.some((rule: Rule) => rule.resource.startsWith("dog-reviewer-correction-")), false);
    await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
  } finally { await f.dispose(); }
});

for (const effect of ["allow", "ask", "deny"] as const) test(`native configured order: historical wildcard deny then Reviewer-specific ${effect}, including cold reload`, async () => {
  const f = await fixture();
  try {
    await initial(f);
    f.globalRules.push({ action: "shell", resource: "*", effect: "deny" });
    f.agentRules["dog-reviewer-v010"] = [{ action: "shell", resource: "node check.mjs", effect },
      ...(effect === "deny" ? [{ action: "shell", resource: "node check.mjs", effect: "allow" as const }, { action: "shell", resource: "node check.mjs", effect }] : [])];
    await f.start();
    const original = evaluate("shell", "node check.mjs", f.registry()["dog-reviewer-v010"]!.permissions).effect;
    const workerOriginal = evaluate("shell", "node check.mjs", f.registry()["dog-worker-v010"]!.permissions).effect;
    assert.equal(original, effect);
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.bind("author");
    for (const cold of [false, true]) {
      if (cold) await f.start();
      assert.equal(await f.permission("author", "shell", "node check.mjs"), original);
      assert.equal(await f.permission("author", "shell", "node required-test.mjs"), "deny");
      assert.equal(f.registry()["dog-reviewer-v010"]!.permissions.some((rule: Rule) => rule.action === "edit" && rule.effect === "deny"), true);
      assert.equal(await f.permission("worker", "shell", "node check.mjs"), workerOriginal, "unrelated Worker registry is unchanged");
      if (effect === "deny") await assert.rejects(f.before("author", "shell", { command: "node check.mjs" }), /native permission denied shell/);
      else await f.before("author", "shell", { command: "node check.mjs" });
    }
    await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
  } finally { await f.dispose(); }
});

test("correction execution permits focused tests/formatter/generator; formal proof and known output/prohibition gates remain", async () => {
  const f = await fixture();
  try {
    await initial(f, { validation: ["node required-test.mjs", "node check.mjs"] });
    await f.missions.update("root", state => { state.prohibitedWrite = ["check.mjs"]; });
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.bind("author");
    for (const command of ["go test ./vm -run '^TestTypedBindings$' -count=1", "gofmt -w result.txt", "node generate.mjs", "node format.mjs"]) {
      const event = await f.before("author", "shell", { command });
      await f.after(event, "Focused diagnostic/formatter admitted under native policy", { exit: 0 });
    }
    assert.equal((await f.run()).units[0]!.reviewerCorrection!.checks, undefined, "focused execution NEVER substitutes for formal inherited checks");
    await f.shell("author", "node generate.mjs"); await f.shell("author", "node format.mjs");
    await f.shell("author", "printf 'ready\\n' > result.txt");
    await assert.rejects(f.before("author", "shell", { command: "printf x > check.mjs" }), /mission-explicit-write-prohibition/);
    const output = await f.before("author", "shell", { command: "printf x > outside.txt" });
    assert.ok((await f.run()).units[0]!.reviewerCorrection!.writeUnion.includes("outside.txt"));
    await f.after(output, "Literal output reconciled without executing or creating formal evidence", { exit: 0 });
    assert.equal((await f.run()).units[0]!.reviewerCorrection!.checks, undefined);
    await assert.rejects(f.before("author", "shell", { command: "printf x > ../outside.txt" }), /repository-relative path without traversal/);
    await f.shell("author", "git add -- result.txt"); await f.shell("author", "git commit -m diagnostics-then-formal");
    await f.shell("author", "node required-test.mjs"); await f.shell("author", "node check.mjs");
    await f.finish(dispatch, "author", inlineReport());
    assert.equal((await f.tool("root", "complete_mission")).status, "succeeded");
    assert.equal(whollyDisabled("shell", f.registry()["dog-reviewer-v010"]!.permissions), false, "ordinary Reviewer retains native observations after restoration");
    assert.equal(whollyDisabled("edit", f.registry()["dog-reviewer-v010"]!.permissions), true);
  } finally { await f.dispose(); }
});

for (const effect of ["allow", "ask", "deny"] as const) test(`correction shell sink keeps native ${effect}, Reviewer read-only and real output prohibitions`, async () => {
  const f = await fixture();
  try {
    await initial(f);
    const sink = process.platform === "win32" ? "NUL" : "/dev/null";
    const command = `printf diagnostic 2>${sink}`;
    await f.before("author", "shell", { command });
    await assert.rejects(f.before("author", "shell", { command: "printf changed > result.txt" }), /mission-reviewer-readonly/);
    f.agentRules["dog-reviewer-v010"] = [{ action: "shell", resource: command, effect }];
    await f.start();
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.bind("author");
    assert.equal(await f.permission("author", "shell", command), effect, "sink classification never grants native allow over ask/deny");
    if (effect === "deny") await assert.rejects(f.before("author", "shell", { command }), /native permission denied shell/);
    else await f.shell("author", command);
    assert.equal((await f.run()).units[0]!.reviewerCorrection!.checks, undefined, "a sink diagnostic is not inherited formal proof");
    await f.missions.update("root", state => { state.prohibitedWrite = ["result.txt"]; });
    await assert.rejects(f.before("author", "shell", { command: `printf forbidden > result.txt 2>${sink}` }), /mission-explicit-write-prohibition/);
    assert.equal(await readFile(join(f.directory, "result.txt"), "utf8"), "wrong\n");
    await assert.rejects(f.tool("root", "complete_mission"), /incomplete|validation/);
    await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
  } finally { await f.dispose(); }
});

for (const absolute of [false, true]) for (const declared of [false, true]) test(`correction known outputs use native ${absolute ? "absolute" : "relative"} shell workdir for prohibitions and write union: ${declared ? "declared text in other cwd" : "diagnostic"}`, async () => {
  const f = await fixture();
  try {
    const command = declared ? "node generate.mjs > result.txt" : "printf overwritten > result.txt";
    await initial(f, declared ? { validation: [command, "node check.mjs"] } : {});
    await mkdir(join(f.directory, "nested"));
    await writeFile(join(f.directory, "nested", "result.txt"), "protected nested output\n");
    const prepared = await f.tool("root", "repair_review"), dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt); await f.bind("author");
    const input = { command, workdir: absolute ? join(f.directory, "nested") : "nested" };
    const reconciled = await f.before("author", "shell", input);
    assert.ok((await f.run()).units[0]!.reviewerCorrection!.writeUnion.includes("nested/result.txt"),
      "reconcile the actual native nested destination, not the same-named root file");
    await f.after(reconciled, "Correct directory observed; output not actually executed", { exit: 0 });
    assert.equal((await f.run()).units[0]!.reviewerCorrection!.checks, undefined,
      "matching command text in a different cwd is still not inherited formal proof");
    await f.missions.update("root", state => { state.prohibitedWrite = ["nested/result.txt"]; });
    await assert.rejects(f.before("author", "shell", input), /mission-explicit-write-prohibition/,
      "prohibition checks inspect the same destination native shell would write");
    assert.equal(await readFile(join(f.directory, "nested", "result.txt"), "utf8"), "protected nested output\n");
    const scoped = await f.before("author", "shell", { command: "printf 'ready\\n' > result.txt", workdir: f.directory });
    await exec("bash", ["-c", scoped.input.command], { cwd: scoped.input.workdir });
    await f.after(scoped, "Known root output executed", { exit: 0 });
    assert.equal((await f.run()).units[0]!.reviewerCorrection!.checks, undefined, "diagnostic writes are not formal check evidence");
    await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
  } finally { await f.dispose(); }
});

test("shipped Reviewer remains read-only and retains Sol/xhigh", () => {
  const asset = runtimeAssets.find(item => item.name === "dog-reviewer-v010")!.content;
  assert.match(asset, /model: openai\/gpt-6\.1-sol#xhigh/);
  assert.match(asset, /edit: deny/); assert.doesNotMatch(asset, /bash: (false|deny)/);
  assert.match(asset, /CORRECTION_READY/);
  assert.deepEqual(convertedAssetPermissions(asset), nativeReviewerRoleRules, "native role-block projection is grounded in the actual shipped header");
});

test("generated gateway Reviewer permissions follow correction while preserving configured rules", async () => {
  const f = await fixture();
  try {
    const { stdout } = await exec("python3", ["-c", "import json,sys; sys.path.insert(0,sys.argv[1]); from frontierharness_gateway import native_gateway_config; print(json.dumps(native_gateway_config('openai/gpt-6-sol','0123456789abcdef01234567','fixture',allowed_models=['openai/gpt-6-sol'])['agents']['dog-reviewer-v010']['permissions']))", resolve("scripts")],
      { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    const generated: Rule[] = JSON.parse(stdout);
    const custom: Rule[] = [{ action: "fh_docker_exec", resource: "user-denied", effect: "deny" },
      { action: "sortie_v010_finish_direct_unit", resource: "user-approval", effect: "ask" }];
    f.agentRules["dog-reviewer-v010"] = [...generated, ...custom];
    await f.start();
    await initial(f);
    assert.equal(await f.permission("author", "fh_docker_read", "*"), "allow");
    assert.equal(await f.permission("author", "fh_docker_exec", "*"), "deny");
    const prepared = await f.tool("root", "repair_review");
    const dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt);
    for (const cold of [false, true]) {
      if (cold) await f.start();
      assert.equal(await f.permission("author", "fh_docker_exec", "*"), "allow");
      assert.equal(await f.permission("author", "sortie_v010_finish_direct_unit", "*"), "allow");
      assert.equal(await f.permission("author", "fh_docker_exec", "user-denied"), "deny");
      assert.equal(await f.permission("author", "sortie_v010_finish_direct_unit", "user-approval"), "ask");
      f.agents.author!.permissions = [{ action: "fh_docker_exec", resource: "*", effect: "deny" }];
      assert.equal(await f.permission("author", "fh_docker_exec", "*"), "deny");
      delete f.agents.author!.permissions;
      assert.equal(await f.permission("author", "shell", "anything"), "deny", "gateway shell policy is retained");
      assert.deepEqual(f.registry()["dog-reviewer-v010"]!.permissions.slice(-generated.length - custom.length), [...generated, ...custom]);
    }
    await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
    assert.equal(f.agents.author!.agent, "dog-reviewer-v010");
    assert.equal(await f.permission("author", "fh_docker_exec", "*"), "deny");
  } finally { await f.dispose(); }
});

test("correction admission cannot bypass an original Reviewer parent-session deny", async () => {
  const f = await fixture();
  try {
    await initial(f);
    f.agents.root!.permissions = [{ action: "subagent", resource: "dog-reviewer-v010", effect: "deny" }];
    const prepared = await f.tool("root", "repair_review");
    await assert.rejects(f.before("root", "subagent", f.task(prepared.task)), /native-reviewer-correction-parent-permission-denied/);
    assert.equal(f.agents.author!.agent, "dog-reviewer-v010");
    assert.equal(f.storage.has("v2-reviewer-correction-permissions:author"), false);
    assert.equal((await f.ledger()).records.filter(({ event }) => event.kind === "unit.settled").length, 2);
  } finally { await f.dispose(); }
});

for (const role of ["dog-operator", "dogs-coordinator"]) test(`original-target native admission uses the actual ${role} caller and last-match semantics`, async () => {
  const f = await fixture();
  try {
    await initial(f);
    const prepared = await f.tool("root", "repair_review");
    const dispatch = await f.before("root", "subagent", f.task(prepared.task));
    assert.equal(dispatch.input.agent, "dog-reviewer-v010", "native admission never asserts the correction alias");
    await f.prompt("author", dispatch.input.prompt);
    const alias = f.agents.author!.agent;
    f.agents.root!.agent = role;
    f.agents.unrelated = { agent: role };
    const rule = (effect: Rule["effect"]): Rule => ({ action: "subagent", resource: "dog-reviewer-v010", effect });
    const wildcard: Rule = { action: "subagent", resource: "*", effect: "deny" };
    for (const permissions of [[rule("deny")], [rule("ask")], [wildcard, rule("allow")], [wildcard, rule("ask")],
      [rule("deny"), rule("allow")], [rule("allow"), rule("ask")], [rule("allow"), wildcard]]) {
      f.agents.root!.permissions = permissions;
      const expected = permissions.at(-1)!.effect;
      assert.equal(await f.permission("root", "subagent", dispatch.input.agent), expected, "configured deny precedes the hook; specific allow/ask survives wildcard deny");
      assert.equal(await f.permission("unrelated", "subagent", dispatch.input.agent), "allow", "no per-session rule leaks into the shared parent role");
      assert.equal(f.registry()[role]!.permissions.some((item: Rule) => item.resource === alias), false, "no shared parent alias grant");
    }
    f.agents.root!.agent = "dog-operator";
    (f.agentRules[role] ??= []).push(rule("deny"));
    await f.start();
    f.agents.root!.agent = role;
    f.agents.root!.permissions = [rule("allow")];
    assert.equal(await f.permission("root", "subagent", dispatch.input.agent), "allow", "later session allow overrides original agent deny");
    assert.equal(await f.permission("unrelated", "subagent", dispatch.input.agent, true), "deny", "configured deny precedes saved allow");
    assert.equal(whollyDisabled("edit", f.registry()["dog-reviewer-v010"]!.permissions), true);
    f.agents.root!.agent = "dog-operator";
    await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
  } finally { await f.dispose(); }
});

for (const failure of ["lookup", "switch"] as const) for (const cold of [false, true]) {
  test(`restoration retains recovery identity after ${failure} failure; ${cold ? "cold" : "live"} retry settles once`, async () => {
    const f = await fixture();
    try {
      await initial(f);
      const prepared = await f.tool("root", "repair_review");
      const dispatch = await f.before("root", "subagent", f.task(prepared.task));
      await f.prompt("author", dispatch.input.prompt);
      if (failure === "lookup") f.projection.failRestorationLookup = true;
      else f.projection.failRestore = true;
      await assert.rejects(f.tool("root", "cancel_operator", { reason: "explicit-cancellation" }), /native-(?:session-lookup|switch)-transient/);
      assert.match(f.agents.author!.agent, /^dog-reviewer-correction-/);
      assert(f.storage.has("v2-reviewer-correction-permissions:author"));
      f.projection.failRestorationLookup = false;
      const before = (await f.ledger()).records.filter(({ event }) => event.kind === "unit.settled").length;
      if (cold) await f.start();
      await f.tool("root", "operator_status");
      assert.equal(f.agents.author!.agent, "dog-reviewer-v010");
      assert.equal(f.storage.has("v2-reviewer-correction-permissions:author"), false);
      assert.equal((await f.ledger()).records.filter(({ event }) => event.kind === "unit.settled").length, before);
      assert.equal((await f.ledger()).state.consumed_units, 2);
    } finally { await f.dispose(); }
  });
}

test("cold restoration distinguishes native SessionNotFoundError from a transient lookup", async () => {
  const f = await fixture();
  try {
    await initial(f);
    const prepared = await f.tool("root", "repair_review");
    const dispatch = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", dispatch.input.prompt);
    f.projection.failRestorationLookup = true;
    await assert.rejects(f.tool("root", "cancel_operator", { reason: "explicit-cancellation" }), /native-session-lookup-transient/);
    assert(f.storage.has("v2-reviewer-correction-permissions:author"));
    delete f.agents.author;
    await f.start();
    assert.equal(f.storage.has("v2-reviewer-correction-permissions:author"), false);
    assert.equal((await f.ledger()).state.consumed_units, 2);
    assert.equal(Object.keys(f.registry()).some(id => id.startsWith("dog-reviewer-correction-")), false);
  } finally { await f.dispose(); }
});

test("installed client 2.0.18 and converted role tool snapshots support correction without permission.rules", async () => {
  const client = OpenCode.make({ baseUrl: "http://unused.invalid", fetch: async () => { throw new Error("no-network-contract-test"); } });
  assert.equal("rules" in client.permission, false);
  assert.equal(typeof client.session.switchAgent, "function");
  assert.equal(typeof client.session.switchModel, "function");
  const f = await fixture();
  try {
    for (const role of ["dog-operator", "dogs-coordinator"]) {
      const asset = runtimeAssets.find(item => item.name === role)!.content;
      assert.match(asset, /sortie_v010_repair_review: true/);
      const tool = "sortie_v010_repair_review", native = convertedAssetPermissions(asset);
      assert.equal(whollyDisabled(tool, native), false, "tool must survive snapshot creation before the context hook");
      const context = { sessionID: "root", agent: role, system: [], tools: { [tool]: { description: "repair", input: {} } } };
      await f.context(context);
      assert(tool in context.tools, "context filtering retains the real snapshot's repair tool");
    }
    const reviewer = f.registry()["dog-reviewer-v010"]!;
    assert.equal(whollyDisabled("edit", reviewer.permissions), true);
    assert.equal(whollyDisabled("shell", reviewer.permissions), false);
  } finally { await f.dispose(); }
});

for (const place of ["global", "project", "session", "global-all"] as const) test(`correction profile preserves explicit ${place} shell denies`, async () => {
  const f = await fixture();
  try {
    await initial(f);
    const deny: Rule = { action: "shell", resource: place === "global-all" ? "*" : "node check.mjs", effect: "deny" };
    if (place === "session") f.agents.author!.permissions = [deny];
    else f.globalRules.push(deny); // Host converts both project/global documents into the registry's inherited rules.
    await f.start();
    const prepared = await f.tool("root", "repair_review");
    const correction = await f.before("root", "subagent", f.task(prepared.task));
    await f.prompt("author", correction.input.prompt); await f.bind("author");
    await assert.rejects(f.before("author", "shell", { command: "node check.mjs" }), /native permission denied shell/);
    assert.equal(f.registry()[f.agents.author!.agent]!.permissions.some((rule: Rule) => rule.action === "shell" && rule.resource === "*" && rule.effect === "allow"), false);
    const command = "printf x > undeclared.txt";
    if (place === "global-all") await assert.rejects(f.before("author", "shell", { command }), /native permission denied shell/);
    else {
      const output = await f.before("author", "shell", { command });
      assert.ok((await f.run()).units[0]!.reviewerCorrection!.writeUnion.includes("undeclared.txt"));
      await f.after(output, "Known path reconciled, no formal check", { exit: 0 });
      await assert.rejects(f.before("author", "shell", { command: "node check.mjs" }), /native permission denied shell/,
        "scope reconciliation cannot alter the inherited native deny");
    }
    assert.equal((await f.run()).units[0]!.reviewerCorrection!.checks, undefined);
    await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
    assert.equal(f.agents.author!.agent, "dog-reviewer-v010");
    assert.deepEqual(f.agents.author!.permissions, place === "session" ? [deny] : undefined);
  } finally { await f.dispose(); }
});

test("native original-target admission then prompt activation retains the author's current model and non-default variant", async () => {
  const f = await fixture();
  try {
    await initial(f);
    const selected = { providerID: "openai", id: "gpt-6.1-sol", variant: "high" };
    f.agents.author!.model = selected; // A genuine native user model switch after the initial review.
    const previous = f.switches.filter(item => "model" in item).length;
    const prepared = await f.tool("root", "repair_review");
    const dispatch = await f.before("root", "subagent", f.task(prepared.task));
    assert.equal(dispatch.input.sessionID, "author"); assert.equal(dispatch.input.model, undefined);
    assert.equal(dispatch.input.agent, "dog-reviewer-v010");
    assert.equal(f.agents.author!.agent, dispatch.input.agent, "native existing-agent comparison cannot replace the current model");
    await f.prompt("author", dispatch.input.prompt); await f.start();
    assert.deepEqual(f.registry()[f.agents.author!.agent]!.model, selected);
    assert.deepEqual(f.agents.author!.model, selected);
    assert.equal(f.switches.filter(item => "model" in item).length, previous);
    await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
    assert.equal(f.agents.author!.agent, "dog-reviewer-v010");
    assert.deepEqual(f.agents.author!.model, selected);
    assert.equal(f.switches.filter(item => "model" in item).length, previous);
  } finally { await f.dispose(); }
});

for (const mode of ["cancel", "agent-change", "native-launch-error", "background-failed", "permission-failed"] as const) {
  test(`Reviewer correction restores permissions and settles once: ${mode}`, async () => {
    const f = await fixture();
    try {
      await initial(f);
      const prior = [{ action: "webfetch", resource: "*", effect: "deny" }];
      f.agents.author!.permissions = prior;
      const prepared = await f.tool("root", "repair_review");
      await assert.rejects(f.before("root", "subagent", { ...f.task(prepared.task), prompt: "Wrong task identity" }), /operator-/);
      assert.equal((await f.tool("root", "operator_status")).budget.reserved_units, 0);
      if (mode === "permission-failed") {
        f.projection.failGrant = true;
        await assert.rejects(f.before("root", "subagent", f.task(prepared.task)), /native-permission-storage-failed/);
      } else {
        const correction = await f.before("root", "subagent", { ...f.task(prepared.task), ...(mode === "background-failed" ? { background: true } : {}) });
        if (mode === "native-launch-error") {
          // A native resume failure need not return child metadata; admitted sessionID is retained.
          await f.after(correction, "Native launch failed", {}, "error");
          await f.after(correction, "Duplicate native failure", {}, "error");
        } else {
          await f.prompt("author", correction.input.prompt); await f.bind("author");
          await f.start();
          if (mode === "cancel") await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
          else if (mode === "agent-change") {
            f.agents.root!.agent = "build";
            await f.prompt("root", "Use Build for a different request.");
          } else {
            await f.after(correction, "Native Job running", { sessionID: "author", status: "running" });
            f.terminal("author", "Native correction failed", true);
            await f.tool("root", "operator_status");
          }
        }
      }
      assert.deepEqual(f.agents.author!.permissions, prior);
      assert.equal(f.storage.has("v2-reviewer-correction-permissions:author"), false);
      const mission = await f.missions.required("root"), ledger = await f.ledger();
      assert.equal(mission.corrections![0]!.status, ["cancel", "agent-change"].includes(mode) ? "cancelled" : "failed");
      assert.equal(ledger.state.outstanding_reservations.length, 0);
      assert.equal(ledger.state.consumed_units, 2);
      assert.equal(ledger.records.filter(({ event }) => event.kind === "unit.settled").length, 2);
      assert.equal(mission.review!.verdict, "findings");
    } finally { await f.dispose(); }
  });
}

test("unsupported native correction permissions refuse before creating a new run or spending budget", async () => {
  const f = await fixture({ permissionsUnavailable: true });
  try {
    const before = await initial(f);
    await assert.rejects(f.tool("root", "repair_review"), /native-reviewer-correction-permissions-unavailable/);
    assert.equal((await f.run()).runID, before.run.runID);
    assert.equal((await f.missions.required("root")).corrections, undefined);
    assert.equal((await f.ledger()).state.consumed_units, 1);
  } finally { await f.dispose(); }
});

test("native correction session grants preserve explicit session denies without granting global Reviewer writes", async () => {
  const f = await fixture();
  try {
    await initial(f);
    const prior = [{ action: "edit", resource: "result.txt", effect: "deny" }];
    f.agents.author!.permissions = prior;
    const prepared = await f.tool("root", "repair_review");
    await f.before("root", "subagent", f.task(prepared.task));
    assert.deepEqual(f.agents.author!.permissions, prior, "session denies never get replaced");
    assert.equal(evaluate("edit", "result.txt", f.rules.at(-1)!.permissions, prior).effect, "deny", "native last-match semantics retain user denial");
    assert.deepEqual(f.agents.final!.permissions, undefined);
    await f.tool("root", "cancel_operator", { reason: "explicit-cancellation" });
    assert.deepEqual(f.agents.author!.permissions, prior);
  } finally { await f.dispose(); }
});
