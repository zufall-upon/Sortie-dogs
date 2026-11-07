import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import test from "node:test";
import { createHash } from "node:crypto";
import { missionPacket, OperatorMissionRuntime } from "../dist/core/operator-mission.js";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";
import { RunFlightLedger } from "../dist/core/run-flight-ledger.js";
import { runCodexMission } from "../dist/codex/run-mission.js";
import { goalFingerprint } from "../dist/core/goal-bound.js";
import { evidenceFromObservedExecution } from "../dist/core/observed-goal-evidence.js";
import { directHandoffValidationChecks } from "../dist/plugin/mission-review.js";
import nativeDockerTaskPlugin from "../scripts/frontierharness-docker-task.mjs";
import { pathToFileURL } from "node:url";
import { captureDockerWorkspaceSnapshot } from "../dist/plugin/docker-validation.js";
import { refreshProtectedSnapshot } from "../dist/plugin/protected-snapshot.js";

const exec = promisify(execFile);

const directModes = ["handoff-reload", "handoff-registration", "handoff-registration-latest-failure", "handoff-registration-chain-missing", "handoff-registration-chain-suffix", "handoff-registration-suffix", "handoff-registration-suffix-latest-failure", "handoff-cancel", "handoff-stale", "handoff-latest-failure", "handoff-storage-failure", "correction", "cancel", "non-git", "non-git-root", "junction", "replan", "cold-replan", "external-cwd", "registration", "recipe-registration", "large-source", "ledger-capacity", "blocked", "needs-decision", "retry-direct", "retry-worker", "retry-registration-worker", "retry-direct-unknown", "retry-direct-failed", "retry-direct-rescue", "parent-interrupted", "parent-cancelled", "parent-failed", "parent-completed", "parent-unset", "finish-cancelled", "recovery", "recovery-failed", "recovery-stale", "recovery-latest-failure", "recovery-missing-finish", "recovery-explicit-cancel", "recovery-crash", "recovery-projection-crash", "recovery-pending", "recovery-pending-projection-crash", "recovery-normal-succeeded", "recovery-boundary", "recovery-paginated"] as const;
const cancelledWriterModes = ["cancel-stale-writer", "cancel-delayed-writer", "cancel-background-writer", "cancel-missing-writer", "cancel-duplicate-writer", "cancel-foreign-writer"];
for (const actor of ["root", "coordinator"]) for (const mode of [...directModes, ...cancelledWriterModes, "generated-read-output", "registration-with-cwd", "compacted-success", "compacted-latest-failure", "compacted-stale"].filter(mode =>
  (actor === "coordinator" || !cancelledWriterModes.includes(mode) || mode === "cancel-stale-writer") && (
  actor === "coordinator" || !mode.includes("pending") && mode !== "recovery-normal-succeeded" && mode !== "retry-direct-rescue" && mode !== "ledger-capacity"))) test(`${actor} direct execution: ${mode}`, async t => {
  const cancel = mode === "cancel", nonGit = mode.startsWith("non-git");
  const retry = mode.startsWith("retry-");
  const incomplete = mode === "blocked" || mode === "needs-decision" || retry;
  const registeredSuffix = mode.startsWith("handoff-registration-chain") || mode.startsWith("handoff-registration-suffix");
  const oldChain = mode.startsWith("handoff-registration-chain");
  const missingMiddle = mode === "handoff-registration-chain-missing";
  const external = ["external-cwd", "registration", "registration-with-cwd"].includes(mode);
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(nonGit ? join(tmpdir(), "mission-direct-") : resolve("_testenv/mission-direct-"));
  const externalDirectory = external ? await mkdtemp(join(tmpdir(), "mission-direct-external-")) : undefined;
  const product = externalDirectory ?? (nonGit ? join(directory, "product") : directory);
  const resultPath = externalDirectory ? join(externalDirectory, "result.txt") : nonGit ? "product/result.txt" : "result.txt";
  try {
    await mkdir(product, { recursive: true });
    await exec("git", ["init", "--quiet"], { cwd: product });
    if (mode === "large-source") {
      await mkdir(join(product, "context"));
      // Keep the raw packet over 32 KB even with shorter POSIX paths; the size
      // precondition must not depend on the host's checkout path length.
      await Promise.all(Array.from({ length: 400 }, (_, i) => writeFile(join(product, "context", `protected-source-${i}.txt`), "protected source\n")));
      await exec("git", ["add", "--", "context"], { cwd: product });
      await exec("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture protected inputs"], { cwd: product });
    }
    if (mode === "junction") {
      const target = join(directory, "profile", "IE"), alias = join(directory, "profile", "Content.IE5");
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "cached.txt"), "old profile data");
      await fs.symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
      const original = fs.readdir;
      t.mock.method(fs, "readdir", async (...args: Parameters<typeof fs.readdir>) => {
        if (resolve(String(args[0])) === alias) throw Object.assign(new Error("alias enumeration denied"), { code: "EPERM" });
        return Reflect.apply(original, fs, args);
      });
      syncBuiltinESMExports();
    }
    await writeFile(join(directory, "check.mjs"), `import {readFileSync} from "node:fs";\nif (process.argv.includes("--expected-eight") || readFileSync(${JSON.stringify(resultPath)},"utf8") !== "fixed\\n") process.exit(1);\n`);
    if (mode === "generated-read-output") {
      await mkdir(join(directory, "reports"));
      // A real child leaves a new diagnostic log on every invocation, even when
      // the prepared source and command are unchanged. Splitting build cannot fix
      // an estimated read scope that also contains these retained outputs.
      await writeFile(join(directory, "emit.mjs"), `import {writeFileSync} from 'node:fs';
writeFileSync('reports/run-' + process.hrtime.bigint() + '.json', JSON.stringify({ok:true}));\n`);
      await writeFile(join(directory, "check.mjs"), (await readFile(join(directory, "check.mjs"), "utf8")) + `
import {spawnSync} from 'node:child_process';
if (spawnSync(process.execPath, ['emit.mjs'], {stdio:'inherit'}).status !== 0) process.exit(2);\n`);
    }
    if (incomplete && !retry) await writeFile(join(directory, "check.mjs"), "process.exit(4);\n");
    if (externalDirectory) await writeFile(join(externalDirectory, "check.mjs"), await readFile(join(directory, "check.mjs")));
    const agents: Record<string, { agent: string; parentID?: string; outcome?: string }> = {
      root: { agent: "dog-operator", outcome: "running" },
      coordinator: { agent: "dogs-coordinator", parentID: "root", outcome: "running" },
      reviewer: { agent: "dog-reviewer-v010", parentID: actor },
    };
    const history: Record<string, Record<string, unknown>[]> = {};
    const aborted: string[] = [];
    let historyAvailable = true;
    let rescueAvailable = false;
    const compacted = mode.startsWith("compacted-");
    const paginatedStarts: string[] = [];
    let historyBarrier: (() => Promise<void>) | undefined;
    const create = () => SortieDogsV010Plugin({ directory, client: {
      ...(mode === "retry-direct-rescue" ? { v2: { model: { list: async () => ({ data: rescueAvailable ? [{ providerID: "openai", id: "gpt-6-astra", enabled: true }] : [] }) } } } : {}),
      session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...agents[path.id] } }),
      messages: async ({ path }: { path: { id: string } }) => {
        await historyBarrier?.();
        if (historyAvailable) return { data: history[path.id] ?? [] };
        if (compacted) return { data: (history[path.id] ?? []).map(message => ({ ...message,
          parts: (message.parts as { tool?: string }[] ?? []).filter(part => part.tool !== "bash") })) };
        return mode === "recovery-paginated" ? { data: (history[path.id] ?? []).map(message => ({ ...message,
          parts: (message.parts as { tool?: string }[] ?? []).filter(part => part.tool !== "sortie_v010_finish_direct_unit") })) } : undefined;
      },
      ...(mode === "recovery-paginated" || compacted ? { reviewMessages: async ({ path, query }: { path: { id: string }; query?: { notBefore?: string } }) => {
        if (query?.notBefore) paginatedStarts.push(query.notBefore);
        return { data: history[path.id] ?? [] };
      } } : {}),
      children: async ({ path }: { path: { id: string } }) => ({ data: Object.entries(agents).filter(([, item]) => item.parentID === path.id)
        .map(([id, item]) => ({ id, ...item })) }),
      abort: async ({ path }: { path: { id: string } }) => { aborted.push(path.id); agents[path.id]!.outcome = "interrupted"; return { data: true }; },
    } } } as never);
    let hooks = await create();
    const prompt = async (id: string, text: string) => {
      await hooks["chat.message"]!({ sessionID: id, messageID: `${id}-prompt`, agent: agents[id]!.agent }, {
        message: { id: `${id}-prompt`, agent: agents[id]!.agent, model: { providerID: "openai", modelID: "gpt-6.1-sol" } },
        parts: [{ type: "text", text }],
      });
    };
    await prompt("root", "Make result.txt fixed and run node check.mjs; independent review required.");
    const started = JSON.parse(await hooks.tool!.sortie_v010_start_mission.execute({ requirements: ["Validated fixed result"] }, { sessionID: "root" }));
    if (actor === "coordinator") {
      const task = { args: structuredClone(started.task) };
      await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" }, task);
      await prompt(actor, task.args.prompt);
    }
    const declaration = { title: "Fix result", objective: "Create result.txt accepted by check.mjs",
      read: ["check.mjs", ...(mode === "generated-read-output" ? ["emit.mjs", "reports/**"] : []), ...(externalDirectory ? [join(externalDirectory, "check.mjs")] : []), ...(mode === "junction" ? ["profile/**"] : [])],
      write: mode === "non-git-root" ? [directory + "/**"] : [resultPath, "reports/**", ...(mode === "junction" ? ["profile/**"] : [])],
      validation: registeredSuffix ? ["node check.mjs", "node check.mjs --old-middle", "node check.mjs --last"]
        : [mode === "recipe-registration" ? "node check.mjs --expected-eight" : "node check.mjs"],
      ...(mode === "external-cwd" || mode === "registration-with-cwd" ? { validation_cwd: { "node check.mjs": mode === "external-cwd" ? externalDirectory! : directory } } : {}) };
    const multi = mode.includes("pending") || mode === "recovery-normal-succeeded";
    const planned = JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ executor: "self", units: [declaration,
      ...(multi ? [{ ...declaration, title: "Second planned result", objective: "Validate the second planned result",
        validation: ["node check.mjs --second"] }] : [])] }, { sessionID: actor }));
    assert.equal(planned.status, "direct-unit-running", JSON.stringify(planned));
    assert.equal(planned.work_quantity.scope, "whole-request");
    assert.equal(planned.work_quantity.n, 0);
    assert.equal(planned.task, undefined, "direct author receives no Worker handoff");
    const readRun = () => new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root");
    const before = await readRun();
    assert.equal(before.units[0]!.directExecution?.actor, actor);
    assert.equal(before.dispatched, 0, "no native Worker Task was dispatched");
    if (cancelledWriterModes.includes(mode)) {
      const callID = "cancelled-question", args = { questions: [] };
      await hooks["tool.execute.before"]!({ tool: "question", sessionID: actor, callID }, { args });
      const part = { type: "tool", tool: "question", callID,
        state: { status: mode === "cancel-delayed-writer" ? "running" : "error", input: args,
          ...(mode === "cancel-background-writer" ? { metadata: { status: "unknown" } } : {}), time: { end: Date.now() } } };
      history[actor] = [{ info: { role: "assistant", sessionID: mode === "cancel-foreign-writer" ? "another-actor" : actor },
        parts: mode === "cancel-missing-writer" ? [] : mode === "cancel-duplicate-writer" ? [part, structuredClone(part)] : [part] }];
      const stop = () => hooks.tool!.sortie_v010_cancel_operator.execute({ reason: "plain" }, { sessionID: "root" });
      if (mode === "cancel-stale-writer") await stop();
      else await assert.rejects(stop(), /mission-direct-release:tools-in-flight/);
      assert.equal((await readRun()).units[0]!.status, "cancelled");
      const budget = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" })).budget;
      assert.equal(budget.reserved_units, 0);
      if (actor === "coordinator") delete agents.reviewer;
      const next = JSON.parse(await hooks.tool!.sortie_v010_start_mission.execute({ requirements: ["Validated fixed result"] }, { sessionID: "root" }));
      if (actor === "coordinator") {
        await assert.rejects(hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "old-resume" },
          { args: { ...next.task, task_id: actor } }), /mission-dispatch-not-authorized/,
        "cancellation recovery never authorizes redispatch of the old Coordinator");
      }
      const replacement = JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ executor: "self", units: [{ ...declaration,
        write: ["new-result.txt"] }] }, { sessionID: "root" }));
      assert.equal(replacement.status, "direct-unit-running");
      const expand = () => hooks.tool!.sortie_v010_expand_unit.execute({ unit_id: replacement.unit_id, paths: ["result.txt"],
        reason: "Continue the original result after cancelling its prior author" }, { sessionID: "root" });
      if (mode !== "cancel-stale-writer") {
        await assert.rejects(expand(), /mission-scope-update-writer-conflict:coordinator/);
        part.state.status = "completed";
        delete (part.state as { metadata?: unknown }).metadata;
        history[actor] = [{ info: { role: "assistant", sessionID: actor }, parts: [part] }];
      }
      await expand();
      await Promise.all([expand(), expand()]);
      const after = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" })).budget;
      assert.equal(after.consumed_units, budget.consumed_units, "release retry never settles the old reservation twice");
      assert.equal(after.reserved_units, 1, "only the replacement direct unit reserves budget");
      return;
    }
    if (cancel) {
      hooks = await create();
      await hooks.tool!.sortie_v010_cancel_operator.execute({ reason: "plain" }, { sessionID: "root" });
      assert(!aborted.includes("root"), "cancelling direct work never aborts its root caller");
      assert.equal((await readRun()).units[0]!.status, "cancelled");
      const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({ view: "full" }, { sessionID: "root" }));
      assert.equal(status.budget.reserved_units, 0, JSON.stringify(status));
      if (actor === "coordinator") delete agents.reviewer; // No Reviewer Task exists in this branch.
      hooks = await create();
      await hooks.tool!.sortie_v010_start_mission.execute({ requirements: ["Validated fixed result"] }, { sessionID: "root" });
      const replacement = JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ executor: "self", units: [{ title: "Resume result",
        objective: "Create result.txt accepted by check.mjs", read: ["check.mjs"], write: ["result.txt"], validation: ["node check.mjs"] }] }, { sessionID: "root" }));
      assert.equal(replacement.status, "direct-unit-running", JSON.stringify(replacement));
      return;
    }
    let counter = 0;
    const write = async (content: string, path = resultPath, author = actor) => {
      const callID = `write-${++counter}`, args = { filePath: resolve(directory, path), content };
      await hooks["tool.execute.before"]!({ tool: "write", sessionID: author, callID }, { args });
      await writeFile(args.filePath, content);
      (history[author] ??= []).push({ info: { id: callID, role: "assistant", sessionID: author }, parts: [{ type: "tool", tool: "write", callID,
        state: { status: "completed", input: args, time: { end: Date.now() } } }] });
      const output: { output: string; metadata?: Record<string, unknown> } = { output: "written" };
      await hooks["tool.execute.after"]!({ tool: "write", sessionID: author, callID, args }, output);
      if (mode === "correction") {
        assert.ok(Number((output.metadata?.work_quantity as { n: number })?.n) > 0);
        if (counter === 1) assert.match(output.output, /全体作業量 \d+%（概算）/);
      }
    };
    let checkCommand = declaration.validation[0]!;
    const check = async (cwd = externalDirectory ?? directory, command = checkCommand, author = actor) => {
      const callID = `check-${++counter}`, args = { command, workdir: cwd }, start = Date.now();
      await hooks["tool.execute.before"]!({ tool: "bash", sessionID: author, callID }, { args });
      let exit = 0;
      try {
        if (command.includes(" && ")) await exec(command, { cwd, shell: true });
        else await exec(process.execPath, command.split(" ").slice(1), { cwd });
      } catch (error) { exit = Number((error as { code?: unknown }).code) || 1; }
      (history[author] ??= []).push({ info: { id: callID, role: "assistant", sessionID: author }, parts: [{ type: "tool", tool: "bash", callID,
        state: { status: "completed", input: args, metadata: { exit }, time: { start, end: Date.now() } } }] });
      await hooks["tool.execute.after"]!({ tool: "bash", sessionID: author, callID, args }, { output: exit ? "FAIL" : "PASS", metadata: { exit, status: "completed" } });
      return exit;
    };
    if (mode === "generated-read-output") {
      await write("fixed\n");
      const missionID = (await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root")).id;
      const firstManifest = before.units[0]!.manifestPath;
      const refused = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        assert.equal(await check(), 0, "the unchanged native command and its child really succeed");
        const result = JSON.parse(await hooks.tool!.sortie_v010_finish_direct_unit.execute({}, { sessionID: actor }));
        assert.equal(result.status, "direct-unit-awaits-validation");
        assert.match(result.reason, /validation-binding-unavailable/);
        assert.match(result.next_action, /declared read inputs changed or became unavailable/);
        assert.match(result.next_action, /plan_units/);
        assert.match(result.next_action, /Do not blindly rerun/);
        refused.push(result);
      }
      const failedChecks = JSON.stringify((await readRun()).units[0]!.directExecution!.checks);
      const manifestBytes = firstManifest ? await readFile(resolve(directory, firstManifest), "utf8") : undefined;
      const recovered = JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ executor: "self",
        reason: "Retained per-run logs are outputs, not prepared validation inputs; preserve source and acceptance",
        units: [{ ...declaration, read: ["check.mjs", "emit.mjs"] }] }, { sessionID: actor }));
      assert.equal(recovered.status, "direct-unit-running", JSON.stringify(recovered));
      const replacement = await readRun();
      assert.notEqual(replacement.runID, before.runID, "scope repair admits new evidence, never relabels the old checks");
      assert.equal((await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root")).id, missionID);
      assert.equal(await readFile(join(directory, "result.txt"), "utf8"), "fixed\n");
      assert.equal(await check(), 0, "the SAME command still creates another new child-process log");
      const finished = JSON.parse(await hooks.tool!.sortie_v010_finish_direct_unit.execute({}, { sessionID: actor }));
      assert.equal((await readRun()).units[0]!.status, "succeeded", JSON.stringify(finished));
      assert.equal((await readRun()).units[0]!.directExecution!.checks[0]!.fresh, true);
      if (firstManifest) assert.equal(await readFile(resolve(directory, firstManifest), "utf8"), manifestBytes);
      const lineage = await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).acceptanceHistory(await readRun(), [before.runID]);
      assert.equal(lineage.status, "available", JSON.stringify(lineage));
      const archived = lineage.runs.find(item => item.state.runID === before.runID)!.state;
      assert.equal(JSON.stringify(archived.units[0].directExecution.checks), failedChecks);
      assert(archived.units[0].directExecution.checks.every((item: {fresh:boolean}) => !item.fresh));
      assert(refused.every(item => item.status === "direct-unit-awaits-validation"));
      return;
    }
    if (mode.startsWith("handoff-")) {
      const registeredHandoff = mode.startsWith("handoff-registration");
      let effectiveValidation = declaration.validation;
      if (registeredHandoff) {
        await write(registeredSuffix ? "fixed\n" : "broken\n");
        assert.equal(await check(directory, oldChain ? declaration.validation.join(" && ") : checkCommand), registeredSuffix ? 0 : 1);
        effectiveValidation = registeredSuffix ? ["node check.mjs", `node check.mjs --${missingMiddle ? "expected-eight" : "middle"}`, "node check.mjs --last"]
          : ["node check.mjs --second"];
        const registered = JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ executor: "self", reason: "Correct delivery check recipe",
          units: [{ ...declaration, validation: effectiveValidation }] }, { sessionID: actor, callID: "register" }));
        assert.equal(registered.status, "direct-unit-registration-corrected");
        checkCommand = effectiveValidation[registeredSuffix ? 1 : 0]!;
      }
      if (!registeredSuffix) await write("fixed\n");
      if (mode !== "handoff-registration" && !registeredSuffix) assert.equal(await check(), 0);
      const direct = (await readRun()).units[0]!.directExecution!;
      const prefix = await directHandoffValidationChecks(registeredSuffix ? effectiveValidation : [checkCommand, "node check.mjs --tail"], actor, history[actor]!,
        Date.parse(direct.startedAt), direct.checks, directory, undefined, direct.validationRegisteredAt);
      assert.equal(prefix.length, mode === "handoff-registration" ? 0 : 1, "unexecuted tail must not discard the passing bound prefix");
      if (prefix.length) assert.equal(prefix[0]!.callID, direct.checks.at(-1)!.callID);
      if (registeredSuffix) assert.deepEqual(prefix[0]!.matchedOccurrences, [{ member: 0, occurrence: 0 }],
        "only the reusable occurrence counts, even when its native call also ran the old middle and final check");
      const handoff = () => hooks.tool!.sortie_v010_plan_units.execute({ executor: "worker",
        handoff_context: "Continue existing result; node check.mjs already passed. Keep that evidence if source remains current." },
        { sessionID: actor, callID: "handoff-call" });
      const priced = (id: string, modelID: string, created: number) => ({ info: { id, role: "assistant", sessionID: id === "direct-usage" ? actor : "worker",
        providerID: "openai", modelID, time: { created, completed: created + 1 },
        tokens: { input: 1000, output: 1000, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [] });
      for (const message of history[actor] ?? []) delete (message.info as Record<string, unknown>).id;
      history[actor]!.push(priced("direct-usage", "gpt-6.1-sol", Date.parse(before.units[0]!.directExecution!.startedAt)));
      hooks = await create();
      const unfinished = { info: { role: "assistant", sessionID: actor }, parts: [{ type: "tool", tool: "bash", callID: "background",
        state: { status: "completed", metadata: { status: "running" } } }] };
      history[actor]!.push(unfinished);
      assert.equal(JSON.parse(await handoff()).status, "direct-handoff-awaits-tools");
      assert.equal((await readRun()).units[0]!.status, "running");
      history[actor]!.pop();
      if (mode === "handoff-storage-failure") {
        const rename = fs.rename;
        const statePath = new OperatorRuntime(directory, V010_RUNTIME_PROFILE).statePath("root");
        const injected = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
          if (String(args[1]) === statePath) throw new Error("fixture handoff state write failure");
          return Reflect.apply(rename, fs, args);
        });
        syncBuiltinESMExports();
        await assert.rejects(handoff(), /fixture handoff state write failure/);
        injected.mock.restore(); syncBuiltinESMExports();
        assert.equal((await readRun()).units[0]!.status, "running");
        assert.equal(createHash("sha256").update(await readFile(before.units[0]!.handoffPath)).digest("hex"), before.units[0]!.hashes[0]);
        hooks = await create();
      }
      const delegated = JSON.parse(await handoff());
      const yielded = await readRun();
      assert.equal(yielded.runID, before.runID);
      assert.equal(yielded.units[0]!.unit.id, before.units[0]!.unit.id);
      assert.equal(yielded.units[0]!.directHandoffs!.length, 1);
      assert.equal(yielded.units[0]!.directHandoffs![0]!.checks.length, mode === "handoff-registration-latest-failure" ? 2 : 1);
      hooks = await create();
      assert.deepEqual(JSON.parse(await handoff()).task, delegated.task, "cold response replay retains pending Task");
      const key = createHash("sha256").update("v010\u0000root").digest("hex");
      const ledger = await RunFlightLedger.openGoal(join(directory, ".git", "sortie-dogs", V010_RUNTIME_PROFILE.flightDirectory, `${key}.json`));
      if (mode === "handoff-cancel") {
        await hooks.tool!.sortie_v010_cancel_operator.execute({ reason: "plain" }, { sessionID: "root" });
        const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
        assert.equal(status.budget.reserved_units, 0);
        assert.equal(status.budget.consumed_units, 1);
        assert.equal((await readRun()).phase, "cancelled");
        return;
      }
      agents.worker = { agent: "dog-worker-v010", parentID: actor, outcome: "running" };
      const task = { args: structuredClone(delegated.task) };
      await hooks["tool.execute.before"]!({ tool: "task", sessionID: actor, callID: "worker-call" }, task);
      await prompt("worker", task.args.prompt);
      const current = (await readRun()).units[0]!;
      await hooks["tool.execute.before"]!({ tool: "read", sessionID: "worker", callID: "handoff-read" }, { args: { filePath: current.handoffPath } });
      await hooks["tool.execute.after"]!({ tool: "read", sessionID: "worker", callID: "handoff-read", args: { filePath: current.handoffPath } },
        { output: await readFile(current.handoffPath, "utf8") });
      if (registeredHandoff) {
        assert.deepEqual(yielded.units[0]!.validationRegistration!.validation, effectiveValidation);
        if (!missingMiddle) {
          assert.equal(await check(directory, registeredSuffix ? effectiveValidation.slice(1).join(" && ") : checkCommand, "worker"), 0,
            "handoff captures the corrected suffix without replaying its checked prefix");
          assert.equal((await readRun()).units[0]!.validationRegistration!.checks.length, 1);
        }
        assert.deepEqual((await readRun()).units[0]!.directHandoffs![0]!.checks, direct.checks,
          "projecting reusable occurrences never rewrites the original native record");
      }
      if (mode === "handoff-stale" || mode.endsWith("latest-failure")) await write("broken\n", resultPath, "worker");
      if (mode.endsWith("latest-failure")) {
        assert.equal(await check(directory, checkCommand, "worker"), 1);
        await write("fixed\n", resultPath, "worker");
      }
      for (const message of history.worker ?? []) delete (message.info as Record<string, unknown>).id;
      (history.worker ??= []).push(priced("worker-usage", "gpt-6-luna", Date.now()));
      // A later Coordinator turn is not part of its yielded execution segment.
      history[actor]!.push({ ...priced("unpriced-later", "unpriced-model", Date.now()), info: {
        ...priced("unpriced-later", "unpriced-model", Date.now()).info, sessionID: actor } });
      agents.worker.outcome = "completed";
      await hooks["tool.execute.after"]!({ tool: "task", sessionID: actor, callID: "worker-call" },
        { output: "DONE", metadata: { sessionId: "worker", status: "completed" } });
      const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
      assert.equal(status.budget.reserved_units, 0);
      assert.equal(status.budget.consumed_units, 1);
      assert(Math.abs(status.budget.settled_cost_usd - 0.0126) < 1e-10, JSON.stringify(status.budget));
      assert.equal((await readRun()).units[0]!.status, mode === "handoff-stale" || mode.endsWith("latest-failure") || missingMiddle ? "failed" : "succeeded");
      const records = (await ledger.readGoal()).records;
      assert.equal(records.filter(item => item.event.kind === "dispatch.reserved").length, 1);
      assert.equal(records.filter(item => item.event.kind === "unit.settled").length, 1);
      return;
    }
    if (mode.endsWith("replan")) {
      const replacement = { executor: "self", reason: "Correct the remaining implementation objective; retain requirements",
        units: [{ title: "Fix result", objective: "Create and inspect result.txt accepted by check.mjs", read: ["check.mjs"],
          write: [resultPath, "reports/**"], validation: ["node check.mjs"] }] };
      const plan = () => hooks.tool!.sortie_v010_plan_units.execute(replacement as never, { sessionID: actor, callID: "current-plan" });
      await assert.rejects(hooks.tool!.sortie_v010_plan_units.execute({ ...replacement, reason: "" } as never, { sessionID: actor }), /reason-required/);
      const invalid = JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ ...replacement,
        units: [{ ...replacement.units[0], validation: ["Check: node check.mjs"] }] } as never, { sessionID: actor }));
      assert.equal(invalid.status, "invalid-plan");
      assert.equal((await readRun()).runID, before.runID);
      assert.equal((await readRun()).units[0]!.status, "running");
      if (mode === "cold-replan") hooks = await create();
      await hooks.tool!.sortie_v010_operator_status.execute({ view: "full" }, { sessionID: "root" });
      historyAvailable = false;
      assert.match(JSON.parse(await plan()).status, /tool_terminal_records_unavailable/);
      assert.equal((await readRun()).units[0]!.status, "running");
      historyAvailable = true;
      for (const malformed of [{ parts: [] }, { info: { sessionID: actor } }, { info: { sessionID: "other" }, parts: [] }]) {
        (history[actor] ??= []).push(malformed);
        assert.match(JSON.parse(await plan()).status, /tool_terminal_records_unavailable/);
        assert.equal((await readRun()).units[0]!.status, "running");
        history[actor]!.pop();
      }
      const unfinished = { info: { id: "unfinished", role: "assistant", sessionID: actor }, parts: [{ type: "tool", tool: "bash", callID: "unfinished",
        state: { status: "running", input: { command: "node check.mjs" }, metadata: { status: "running" } } }] };
      (history[actor] ??= []).push(unfinished);
      assert.match(JSON.parse(await plan()).status, /tool_dispatch_active_or_unproven/);
      unfinished.parts[0]!.state.status = "completed";
      assert.match(JSON.parse(await plan()).status, /tool_dispatch_active_or_unproven/, "background launch completion is not process completion");
      unfinished.parts[0]!.state.metadata.status = "completed";
      (history[actor] ??= []).push({ info: { role: "assistant", sessionID: actor }, parts: [{ type: "tool", tool: "sortie_v010_plan_units",
        callID: "other-plan", state: { status: "running" } }] });
      assert.match(JSON.parse(await plan()).status, /tool_dispatch_active_or_unproven/, "only the exact current planner is excluded");
      history[actor]!.pop();
      (history[actor] ??= []).push({ info: { role: "assistant", sessionID: actor }, parts: [{ type: "tool", tool: "sortie_v010_plan_units",
        callID: "current-plan", state: { status: "running" } }] });
      let corrected: { status: string };
      if (mode === "replan") {
        let entered!: () => void, release!: () => void;
        const enteredHistory = new Promise<void>(resolve => { entered = resolve; });
        const holdHistory = new Promise<void>(resolve => { release = resolve; });
        historyBarrier = async () => { entered(); await holdHistory; };
        const planning = plan();
        await enteredHistory;
        let admitted = false;
        const concurrentArgs = { filePath: join(directory, "check.mjs") };
        const concurrent = hooks["tool.execute.before"]!({ tool: "read", sessionID: actor, callID: "concurrent-read" }, { args: concurrentArgs })
          .then(() => { admitted = true; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(admitted, false, "ordinary tool admission waits for the whole replan transition");
        historyBarrier = undefined; release();
        corrected = JSON.parse(await planning);
        await concurrent;
        await hooks["tool.execute.after"]!({ tool: "read", sessionID: actor, callID: "concurrent-read", args: concurrentArgs }, { output: "inspected" });
      } else corrected = JSON.parse(await plan());
      assert.equal(corrected.status, "direct-unit-running", JSON.stringify(corrected));
      history[actor]!.pop();
      const revised = await readRun();
      assert.notEqual(revised.runID, before.runID);
      assert.deepEqual(revised.acceptance, before.acceptance);
      const retained = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
      assert.equal(retained.id, started.mission_id);
      assert.equal(retained.attempts?.length, 2);
      const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({ view: "full" }, { sessionID: "root" }));
      assert.equal(status.budget.consumed_units, 1, JSON.stringify(status.budget));
      assert.equal(status.budget.reserved_units, 1);
    }
    await write("broken\n");
    assert.equal(await check(), incomplete && !retry ? 4 : 1);
    if (mode === "retry-registration-worker") {
      const registered = JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ executor: "self", reason: "Correct the validation recipe",
        units: [{ ...declaration, validation: ["node check.mjs --registered"] }] }, { sessionID: actor, callID: "register-retry" }));
      assert.equal(registered.status, "direct-unit-registration-corrected");
      checkCommand = "node check.mjs --registered";
      assert.equal(await check(), 1);
    }
    const failed = JSON.parse(await hooks.tool!.sortie_v010_finish_direct_unit.execute({}, { sessionID: actor }));
    assert.equal(failed.status, "direct-unit-awaits-validation");
    assert.equal((await readRun()).units[0]!.status, "running", "failure remains with the same author");
    hooks = await create();
    if (incomplete) {
      const active = await readRun(), checks = active.units[0]!.directExecution!.checks;
      const budget = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" })).budget;
      assert.equal(budget.reserved_units, 1);
      const summary = "Original required native check failed; retain the patch and report incomplete, not success.";
      await assert.rejects(hooks.tool!.sortie_v010_submit_mission.execute({ status: "ready", summary }, { sessionID: actor }), /mission-units-incomplete/);
      if (retry) await assert.rejects(hooks.tool!.sortie_v010_retry_mission_unit.execute({ unit_id: "unit-1" }, { sessionID: actor }),
        /operator-mission-normal-remediation-unavailable/, "a still-running direct writer cannot be replaced");
      const args = { filePath: join(directory, "check.mjs") }, callID = "active-read";
      await hooks["tool.execute.before"]!({ tool: "read", sessionID: actor, callID }, { args });
      const submissionStatus = retry ? "blocked" : mode;
      await assert.rejects(hooks.tool!.sortie_v010_submit_mission.execute({ status: submissionStatus, summary }, { sessionID: actor }), /mission-direct-tools-running/);
      assert.equal((await readRun()).units[0]!.status, "running", "submitted blocker cannot release an active native tool");
      await hooks["tool.execute.after"]!({ tool: "read", sessionID: actor, callID, args }, { output: "process.exit(4);" });
      // The saved failure recorded a completed Coordinator outcome, then resumed the same session.
      if (retry && mode !== "retry-direct-unknown") agents[actor]!.outcome = "completed";
      const submitted = JSON.parse(await hooks.tool!.sortie_v010_submit_mission.execute({ status: submissionStatus, summary }, { sessionID: actor }));
      if (retry) agents[actor]!.outcome = "running";
      const stopped = await readRun();
      assert.equal(submitted.phase, "submitted");
      assert.deepEqual(submitted.submission, { status: submissionStatus, summary });
      assert.equal(submitted.execution_summary.accepted, false);
      assert.equal(stopped.phase, "awaiting-decision");
      assert.equal(stopped.runID, active.runID);
      assert.equal(stopped.units[0]!.callID, active.units[0]!.callID);
      assert.equal(stopped.units[0]!.status, "failed");
      assert.deepEqual(stopped.units[0]!.failure, { command: [checkCommand], outcome: "fail", exitCode: retry ? 1 : 4 });
      assert.ok(stopped.units[0]!.directExecution!.finishedAt);
      assert.deepEqual(stopped.units[0]!.directExecution!.checks, checks, "failed native checks remain historical, never rerun or rewritten");
      assert.deepEqual(stopped.units[0]!.evidence, [], "failed delivery contributes no successful evidence");
      const mission = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
      assert.equal(mission.attempts?.length, 1);
      assert.equal(mission.attempts?.[0]?.status, "failed");
      assert.equal(mission.attempts?.[0]?.terminal, undefined, "stopping direct work never fabricates a native child terminal");
      assert.equal(mission.review, undefined);
      await assert.rejects(hooks.tool!.sortie_v010_complete_mission.execute({}, { sessionID: "root" }));
      const settledBudget = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" })).budget;
      assert.equal(settledBudget.reserved_units, 0);
      assert.equal(settledBudget.consumed_units, budget.consumed_units + 1);
      await hooks.tool!.sortie_v010_submit_mission.execute({ status: submissionStatus, summary }, { sessionID: actor });
      assert.deepEqual(JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" })).budget, settledBudget,
        "repeated submission does not reserve or settle another unit");
      assert.equal(await readFile(join(directory, resultPath), "utf8"), "broken\n");
      assert.deepEqual(aborted, [], "failure disposition does not interrupt its controller or dispatch a replacement");
      if (retry) {
        assert.equal(mission.attempts?.[0]?.kind, "direct_execution");
        assert.equal(mission.attempts?.[0]?.failure?.category, "implementation");
        if (mode === "retry-direct-unknown") {
          // Older runtimes classified this exact failed native check as unknown while its direct actor remained live.
          await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).update("root", state => {
            state.attempts![0]!.failure = { category: "unknown", code: "acceptance" };
          });
        }
        const savedFailure = mode === "retry-direct-unknown" ? { category: "unknown", code: "acceptance" } : mission.attempts![0]!.failure!;
        await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).update("root", state => {
          state.attempts![0]!.failure = { category: "cancellation", code: "native-task-cancelled" };
        });
        await assert.rejects(hooks.tool!.sortie_v010_retry_mission_unit.execute({ unit_id: "unit-1" }, { sessionID: actor }),
          /operator-mission-normal-remediation-unavailable/, "a cancellation is not an implementation failure");
        await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).update("root", state => { state.attempts![0]!.failure = savedFailure; });
        if (actor === "coordinator") {
          await assert.rejects(hooks.tool!.sortie_v010_retry_mission_unit.execute({ unit_id: "unit-1" }, { sessionID: "root" }),
            /mission-remediation-coordinator-required/);
          await assert.rejects(hooks.tool!.sortie_v010_cancel_operator.execute({ reason: "plain" }, { sessionID: actor }),
            /profile-coordinator-root-required/);
        }
        await assert.rejects(hooks.tool!.sortie_v010_start_direct_unit.execute({}, { sessionID: actor }), /operator-direct-owner-mismatch/);
        const retryUnit = () => hooks.tool!.sortie_v010_retry_mission_unit.execute({ unit_id: "unit-1" }, { sessionID: actor, callID: "retry-call" });
        historyAvailable = false;
        assert.equal(JSON.parse(await retryUnit()).status, "non_rescue", "unavailable native history cannot prove quiescence");
        historyAvailable = true;
        const unfinished = { info: { id: "background", role: "assistant", sessionID: actor }, parts: [{ type: "tool", tool: "bash", callID: "background",
          state: { status: "completed", metadata: { status: "running" } } }] };
        history[actor]!.push(unfinished);
        const guarded = JSON.parse(await retryUnit());
        assert.equal(guarded.status, "non_rescue", JSON.stringify(guarded));
        assert.equal((await readRun()).units[0]!.status, "failed", "unproven writer cannot be replaced");
        history[actor]!.pop();
        const prepared = JSON.parse(await retryUnit());
        assert.equal(prepared.status, "normal_remediation_prepared", JSON.stringify(prepared));
        const queued = await readRun();
        assert.equal(queued.runID, active.runID);
        assert.deepEqual(queued.acceptance, active.acceptance);
        assert.deepEqual(queued.units[0]!.unit, active.units[0]!.unit);
        assert.deepEqual(queued.units[0]!.hashes, active.units[0]!.hashes);
        assert.equal(queued.units[0]!.normalRemediationUsed, true);
        assert.deepEqual(queued.units[0]!.priorDirectExecutions![0]!.checks, checks, "failed native observations remain historical");
        if (mode === "retry-registration-worker") {
          assert.deepEqual(queued.units[0]!.validationRegistration?.validation, [checkCommand]);
          assert.match(queued.units[0]!.task.prompt, /normal_remediation_validation: .*node check\.mjs --registered/,
            "the Worker receives the current registration, not only the original frozen recipe");
        }
        assert.deepEqual(JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" })).budget, settledBudget);
        await assert.rejects(retryUnit(), /operator-mission-normal-remediation-unavailable/, "ordinary retry is one-use");
        if (mode.startsWith("retry-direct")) {
          assert.equal(JSON.parse(await hooks.tool!.sortie_v010_start_direct_unit.execute({}, { sessionID: actor })).status, "direct-unit-running");
          if (mode === "retry-direct-failed" || mode === "retry-direct-rescue") {
            assert.equal(await check(), 1);
            await hooks.tool!.sortie_v010_submit_mission.execute({ status: "blocked", summary }, { sessionID: actor });
            const failedAgain = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
            assert.equal(failedAgain.attempts?.at(-1)?.kind, "direct_execution");
            assert.equal(failedAgain.attempts?.at(-1)?.normalRemediation, true);
            assert.equal(failedAgain.attempts?.at(-1)?.failure?.category, "implementation");
            await assert.rejects(retryUnit(), /operator-mission-normal-remediation-unavailable/, "a second ordinary retry is forbidden");
            if (actor === "coordinator") {
              const rescue = JSON.parse(await hooks.tool!.sortie_v010_rescue_mission_unit.execute({ unit_id: "unit-1" }, { sessionID: actor }));
              assert.equal(rescue.status, "non_rescue");
              assert.equal(rescue.reason, "target_unavailable", "direct remediation reaches the ordinary Rescue policy without inventing a target");
              if (mode === "retry-direct-rescue") {
                rescueAvailable = true;
                const beforeRescue = await readRun();
                const beforeBudget = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" })).budget;
                const rescueUnit = () => hooks.tool!.sortie_v010_rescue_mission_unit.execute({ unit_id: "unit-1" },
                  { sessionID: actor, callID: "current-rescue" });
                historyAvailable = false;
                assert.equal(JSON.parse(await rescueUnit()).status, "non_rescue", "missing native history cannot release a direct writer");
                historyAvailable = true;
                const background = { info: { role: "assistant", sessionID: actor }, parts: [{ type: "tool", tool: "bash", callID: "rescue-background",
                  state: { status: "completed", metadata: { status: "running" } } }] };
                history[actor]!.push(background);
                hooks = await create();
                const guarded = JSON.parse(await rescueUnit());
                assert.equal(guarded.status, "non_rescue");
                assert.match(guarded.reason, /tool_dispatch_active_or_unproven/);
                assert.deepEqual((await readRun()).units, beforeRescue.units, "cold unproven writer cannot change the unit owner");
                assert.deepEqual(JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" })).budget, beforeBudget);
                background.parts[0]!.state.metadata.status = "completed";
                history[actor]!.push({ info: { role: "assistant", sessionID: actor }, parts: [{ type: "tool", tool: "sortie_v010_rescue_mission_unit",
                  callID: "current-rescue", state: { status: "running" } }] });
                let entered!: () => void, release!: () => void;
                const enteredHistory = new Promise<void>(resolve => { entered = resolve; });
                const holdHistory = new Promise<void>(resolve => { release = resolve; });
                historyBarrier = async () => { entered(); await holdHistory; };
                const preparing = rescueUnit();
                await enteredHistory;
                let admitted = false;
                const readArgs = { filePath: join(directory, "check.mjs") };
                const concurrent = hooks["tool.execute.before"]!({ tool: "read", sessionID: actor, callID: "rescue-concurrent-read" }, { args: readArgs })
                  .then(() => { admitted = true; });
                await new Promise(resolve => setImmediate(resolve));
                assert.equal(admitted, false, "native admission waits for the entire direct Rescue transition");
                historyBarrier = undefined; release();
                const prepared = JSON.parse(await preparing);
                await concurrent;
                await hooks["tool.execute.after"]!({ tool: "read", sessionID: actor, callID: "rescue-concurrent-read", args: readArgs }, { output: "inspected" });
                history[actor]!.pop();
                assert.equal(prepared.status, "prepared", JSON.stringify(prepared));
                const queued = await readRun();
                assert.equal(queued.units[0]!.directExecution, undefined, "the previous direct owner is historical, not the Rescue Worker");
                assert.equal(queued.units[0]!.priorDirectExecutions!.length, 2);
                assert.deepEqual(queued.units[0]!.priorDirectExecutions![1]!.checks, beforeRescue.units[0]!.directExecution!.checks);
                agents.worker = { agent: "dog-worker-v010", parentID: actor, outcome: "running" };
                const task = { args: structuredClone(prepared.task) };
                await hooks["tool.execute.before"]!({ tool: "task", sessionID: actor, callID: "rescue-worker-call" }, task);
                await prompt("worker", task.args.prompt);
                const current = (await readRun()).units[0]!;
                await hooks["tool.execute.before"]!({ tool: "read", sessionID: "worker", callID: "rescue-handoff" }, { args: { filePath: current.handoffPath } });
                await hooks["tool.execute.after"]!({ tool: "read", sessionID: "worker", callID: "rescue-handoff", args: { filePath: current.handoffPath } },
                  { output: await readFile(current.handoffPath, "utf8") });
                await write("fixed\n", resultPath, "worker");
                assert.equal(await check(directory, checkCommand, "worker"), 0);
                agents.worker.outcome = "completed";
                await hooks["tool.execute.after"]!({ tool: "task", sessionID: actor, callID: "rescue-worker-call" },
                  { output: "DONE", metadata: { sessionId: "worker", status: "completed" } });
                const rescued = await readRun();
                assert.equal(rescued.runID, active.runID);
                assert.equal(rescued.units[0]!.status, "succeeded");
                const currentMission = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
                assert.equal(currentMission.id, started.mission_id);
                assert.equal(currentMission.attempts?.at(-1)?.kind, "astra_rescue");
                assert.equal(currentMission.attempts?.at(-1)?.terminal?.childSessionID, "worker");
                const review = JSON.parse(await hooks.tool!.sortie_v010_review_mission.execute({ risk_tags: ["public-logic"] }, { sessionID: actor }));
                await hooks["tool.execute.before"]!({ tool: "task", sessionID: actor, callID: "rescue-review" }, { args: structuredClone(review.task) });
                agents.reviewer!.outcome = "completed";
                await hooks["tool.execute.after"]!({ tool: "task", sessionID: actor, callID: "rescue-review" },
                  { output: "PASS\nThe corrected result and native validation agree.", metadata: { sessionId: "reviewer" } });
                await hooks.tool!.sortie_v010_submit_mission.execute({ status: "ready", summary: "Rescue result validated and reviewed" }, { sessionID: actor });
                assert.equal(JSON.parse(await hooks.tool!.sortie_v010_complete_mission.execute({}, { sessionID: "root" })).status, "succeeded");
                const finalBudget = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" })).budget;
                assert.equal(finalBudget.consumed_units, beforeBudget.consumed_units + 1);
                assert.equal(finalBudget.reserved_units, 0);
                assert.deepEqual(aborted, []);
                return;
              }
            }
            const afterBudget = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" })).budget;
            assert.equal(afterBudget.consumed_units, settledBudget.consumed_units + 1);
            assert.equal(afterBudget.reserved_units, 0);
            return;
          }
          await write("fixed\n");
          assert.equal(await check(), 0);
          await hooks.tool!.sortie_v010_finish_direct_unit.execute({}, { sessionID: actor });
        } else {
          agents.worker = { agent: "dog-worker-v010", parentID: actor, outcome: "running" };
          const task = { args: structuredClone(prepared.task) };
          await hooks["tool.execute.before"]!({ tool: "task", sessionID: actor, callID: "retry-worker-call" }, task);
          await prompt("worker", task.args.prompt);
          const current = (await readRun()).units[0]!;
          await hooks["tool.execute.before"]!({ tool: "read", sessionID: "worker", callID: "retry-handoff" }, { args: { filePath: current.handoffPath } });
          await hooks["tool.execute.after"]!({ tool: "read", sessionID: "worker", callID: "retry-handoff", args: { filePath: current.handoffPath } },
            { output: await readFile(current.handoffPath, "utf8") });
          await write("fixed\n", resultPath, "worker");
          assert.equal(await check(directory, checkCommand, "worker"), 0);
          agents.worker.outcome = "completed";
          await hooks["tool.execute.after"]!({ tool: "task", sessionID: actor, callID: "retry-worker-call" },
            { output: "DONE", metadata: { sessionId: "worker", status: "completed" } });
        }
        const resumed = await readRun();
        const resumedMission = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
        assert.equal(resumed.runID, active.runID);
        assert.equal(resumed.units[0]!.status, "succeeded");
        assert.equal(resumedMission.id, started.mission_id);
        assert.equal(resumedMission.coordinator, actor === "root" ? null : actor);
        assert.equal(resumedMission.attempts?.at(-1)?.kind, mode.startsWith("retry-direct") ? "direct_execution" : "normal_remediation");
        if (!mode.startsWith("retry-direct")) assert.equal(resumedMission.attempts?.at(-1)?.nativeOutcome, "completed");
        assert.deepEqual(resumed.units[0]!.priorDirectExecutions![0]!.checks, checks);
        const afterBudget = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" })).budget;
        assert.equal(afterBudget.consumed_units, settledBudget.consumed_units + 1);
        assert.equal(afterBudget.reserved_units, 0);
        assert.deepEqual(aborted, []);
      }
      return;
    }
    await write("fixed\n");
    if (mode === "recipe-registration") {
      assert.equal(await check(), 1, "wrong registered condition really fails");
      assert.equal(await check(directory, "node check.mjs"), 0, "correct diagnostic succeeds before registration but is not formal");
      const old = await readRun(), budget = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" })).budget;
      const corrected = { ...declaration, validation: ["node check.mjs"] };
      const register = () => hooks.tool!.sortie_v010_plan_units.execute({ executor: "self", reason: "Correct check condition only", units: [corrected] },
        { sessionID: actor, callID: "current-plan" });
      hooks = await create();
      const pending = { info: { role: "assistant", sessionID: actor }, parts: [{ type: "tool", tool: "task", callID: "other-task",
        state: { status: "completed", metadata: { status: "unknown" } } }] };
      history[actor]!.push(pending);
      assert.match(JSON.parse(await register()).status, /tool_dispatch_active_or_unproven/);
      assert.deepEqual((await readRun()).units[0], old.units[0], "unproven other Task cannot alter/release this admission");
      history[actor]!.pop();
      history[actor]!.push({ info: { role: "assistant", sessionID: actor }, parts: [{ type: "tool", tool: "sortie_v010_plan_units",
        callID: "current-plan", state: { status: "running" } }] });
      const registered = JSON.parse(await register());
      history[actor]!.pop();
      assert.equal(registered.status, "direct-unit-registration-corrected");
      assert.deepEqual(registered.validation, corrected.validation);
      const kept = await readRun();
      assert.equal(kept.runID, old.runID);
      assert.equal(kept.planHash, old.planHash);
      assert.equal(kept.units[0]!.callID, old.units[0]!.callID);
      assert.deepEqual(kept.units[0]!.hashes, old.units[0]!.hashes);
      assert.deepEqual(kept.units[0]!.unit, old.units[0]!.unit, "frozen contract is unchanged");
      assert.deepEqual(kept.units[0]!.directExecution!.checks, old.units[0]!.directExecution!.checks, "old failure retained verbatim");
      assert.equal(kept.units[0]!.directExecution!.checks.at(-1)!.exitCode, 1);
      assert.deepEqual(JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" })).budget, budget);
      assert.equal(JSON.parse(await hooks.tool!.sortie_v010_finish_direct_unit.execute({}, { sessionID: actor })).status,
        "direct-unit-awaits-validation", "unregistered diagnostic is never promoted after correction");
      await register();
      assert.deepEqual((await readRun()).units[0]!.validationRegistration, kept.units[0]!.validationRegistration, "same registration is idempotent");
      hooks = await create();
      checkCommand = "node check.mjs";
    }
    if (mode === "registration" || mode === "registration-with-cwd") {
      assert.equal(await check(), 0);
      const old = await readRun(), budget = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" })).budget;
      assert.equal(old.units[0]!.directExecution!.checks.length, 0, "external diagnostic has no retroactive formal binding");
      const missing = JSON.parse(await hooks.tool!.sortie_v010_finish_direct_unit.execute({}, { sessionID: actor }));
      assert.equal(missing.status, "direct-unit-awaits-validation");
      const corrected = { ...declaration, validation_cwd: { "node check.mjs": externalDirectory! } };
      for (const delta of [{ objective: "Different work" }, { write: ["other.txt"] }]) {
        await assert.rejects(hooks.tool!.sortie_v010_plan_units.execute({ executor: "self", reason: "cwd registration", units: [{ ...corrected, ...delta }] },
          { sessionID: actor }), /contract-mismatch/);
      }
      const registration = JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ executor: "self", reason: "cwd registration", units: [corrected] }, { sessionID: actor }));
      assert.equal(registration.status, "direct-unit-registration-corrected", JSON.stringify(registration));
      assert.equal(registration.task, undefined);
      const kept = await readRun();
      assert.equal(kept.runID, old.runID);
      assert.equal(kept.units[0]!.callID, old.units[0]!.callID);
      assert.deepEqual(kept.units[0]!.hashes, old.units[0]!.hashes);
      assert.equal(kept.units[0]!.directExecution!.startedAt, old.units[0]!.directExecution!.startedAt);
      assert.deepEqual(JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" })).budget, budget);
      assert.equal(JSON.parse(await hooks.tool!.sortie_v010_finish_direct_unit.execute({}, { sessionID: actor })).status,
        "direct-unit-awaits-validation", "registration does not manufacture a check/terminal");
      const register = async (unit: typeof corrected | typeof declaration) => JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({
        executor: "self", reason: "cwd registration", units: [unit] }, { sessionID: actor }));
      await register(corrected);
      assert.deepEqual((await readRun()).units[0]!.directExecution!.validationRegisteredAt, kept.units[0]!.directExecution!.validationRegisteredAt,
        "identical registration is idempotent");
      assert.equal((await register(declaration)).status, "direct-unit-registration-corrected", "returning to original cwd is still an in-place correction");
      assert.deepEqual((await readRun()).units[0]!.directExecution!.validationCwd, declaration.validation_cwd ?? {});
      if (mode === "registration-with-cwd") {
        const { validation_cwd: _cwd, ...withoutCwd } = declaration;
        assert.equal((await register(withoutCwd)).status, "direct-unit-registration-corrected", "explicit cwd can be omitted without changing the frozen contract");
        assert.deepEqual((await readRun()).units[0]!.directExecution!.validationCwd, {});
        assert.equal((await register(declaration)).status, "direct-unit-registration-corrected", "explicit cwd can be restored after omission");
        const restored = await readRun();
        assert.deepEqual(restored.units[0]!.directExecution!.validationCwd, declaration.validation_cwd);
        assert.equal(restored.runID, old.runID);
        assert.equal(restored.units[0]!.callID, old.units[0]!.callID);
        assert.equal(restored.units[0]!.directExecution!.startedAt, old.units[0]!.directExecution!.startedAt);
        assert.deepEqual(restored.units[0]!.unit, old.units[0]!.unit);
        assert.deepEqual(restored.units[0]!.hashes, old.units[0]!.hashes);
        assert.deepEqual(restored.units[0]!.directExecution!.checks, old.units[0]!.directExecution!.checks, "registration never relabels the old diagnostic");
      }
      assert.equal((await register(corrected)).status, "direct-unit-registration-corrected");
      assert.deepEqual(JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" })).budget, budget);
      hooks = await create();
    }
    if (compacted) historyAvailable = false; // Native history survives when the model's context window no longer contains checks.
    assert.equal(await check(), 0);
    if (externalDirectory) {
      const count = (await readRun()).units[0]!.directExecution!.checks.length;
      assert.equal(await check(directory), 0, "same-text diagnostic also succeeds against a different cwd");
      assert.equal((await readRun()).units[0]!.directExecution!.checks.length, count, "wrong cwd is not formal evidence");
    }
    await write("stale\n");
    const stale = JSON.parse(await hooks.tool!.sortie_v010_finish_direct_unit.execute({}, { sessionID: actor }));
    assert.equal(stale.status, "direct-unit-awaits-validation");
    await write("fixed\n");
    assert.equal(await check(), 0); // Real native write history requires a check after this edit.
    let capacityFixture: { file: string; prior: Awaited<ReturnType<RunFlightLedger["readGoal"]>>; pathCount: number } | undefined;
    if (mode === "ledger-capacity") {
      // Generated historical recipes reproduce the observed 44,632-path evidence without
      // copying private paths or creating tens of thousands of real files.
      const paths = Array.from({ length: 44_632 }, (_, i) => `/virtual/${String(i).padStart(5, "0")}/${"x".repeat(95)}`);
      const statePath = new OperatorRuntime(directory, V010_RUNTIME_PROFILE).statePath("root");
      const saved = JSON.parse(await readFile(statePath, "utf8"));
      const observed = saved.units[0].directExecution.checks.at(-1);
      observed.binding.freshness.protected_paths.push(...paths);
      await writeFile(statePath, JSON.stringify(saved));
      const key = createHash("sha256").update("v010\u0000root").digest("hex");
      const file = join(directory, ".git", "sortie-dogs", V010_RUNTIME_PROFILE.flightDirectory, `${key}.json`);
      const ledger = await RunFlightLedger.openGoal(file);
      for (let i = 0; i < 3; i++) {
        const unit = `historical-${i}`, at = new Date().toISOString();
        const state = await ledger.appendGoal({ kind: "dispatch.reserved", at, goal_id: (await ledger.readGoal()).state.goal_id!,
          unit_id: unit, reservation_id: unit, session_id: actor, ticket_id: null });
        const evidence = evidenceFromObservedExecution({ owner: "coordinator", immutableRef: goalFingerprint(unit), command: [checkCommand],
          startedAt: at, endedAt: at, exitCode: 0, outcome: "pass", fresh: true, source: observed.source, candidate: observed.candidate,
          binding: observed.binding }, state, unit);
        assert.equal(evidence.length, 1);
        await ledger.appendGoal({ kind: "unit.settled", at, goal_id: state.goal_id!, unit_id: unit, reservation_id: unit,
          receipt_id: unit, disposition: "succeeded", result_class: "acceptance", evidence,
          progress_fingerprint: i === 0 ? goalFingerprint(evidence) : null, elapsed_ms: 1, cost_usd: 0.25 });
      }
      const bytes = Buffer.byteLength(await readFile(file));
      t.diagnostic(`legacy goal ledger: ${bytes} bytes; generated protected paths: ${paths.length}`);
      assert.ok(bytes > 15_000_000 && bytes < 16 * 1024 * 1024);
      const prior = await ledger.readGoal();
      const originalHash = createHash("sha256").update(await readFile(file)).digest("hex");
      const assertUnchanged = async () => {
        assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), originalHash);
        assert.deepEqual((await ledger.readGoal()).state, prior.state);
        assert.equal((await readRun()).units[0]!.status, "running");
      };
      // Both failures occur while the same public finish is settling the unit.
      // An incomplete blob or failed index publication must leave the legacy
      // ledger and the live reservation untouched and retryable.
      hooks = await create();
      const originalLink = fs.link;
      const linkFault = t.mock.method(fs, "link", async (...args: Parameters<typeof fs.link>) => {
        if (String(args[1]).startsWith(`${file}.blobs`)) throw new Error("fixture blob publication failure");
        return Reflect.apply(originalLink, fs, args);
      });
      syncBuiltinESMExports();
      await assert.rejects(hooks.tool!.sortie_v010_finish_direct_unit.execute({}, { sessionID: actor }), /fixture blob publication failure/);
      linkFault.mock.restore(); syncBuiltinESMExports(); await assertUnchanged(); hooks = await create();
      const originalRename = fs.rename;
      const renameFault = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
        if (String(args[1]) === file) throw new Error("fixture ledger rename failure");
        return Reflect.apply(originalRename, fs, args);
      });
      syncBuiltinESMExports();
      await assert.rejects(hooks.tool!.sortie_v010_finish_direct_unit.execute({}, { sessionID: actor }), /fixture ledger rename failure/);
      renameFault.mock.restore(); syncBuiltinESMExports(); await assertUnchanged();
      capacityFixture = { file, prior, pathCount: paths.length };
      hooks = await create();
    }
    const checked = (await readRun()).units[0]!.directExecution!.checks;
    if (mode.startsWith("recovery") || mode === "finish-cancelled") {
      if (mode === "recovery-normal-succeeded") {
        await hooks.tool!.sortie_v010_finish_direct_unit.execute({}, { sessionID: actor });
        assert.equal((await readRun()).units[0]!.status, "succeeded");
        await hooks.tool!.sortie_v010_start_direct_unit.execute({}, { sessionID: actor });
        assert.equal(await check(directory, "node check.mjs --second"), 0);
      }
      if (mode === "recovery-latest-failure") {
        await write("bad\n"); assert.equal(await check(), 1); await writeFile(join(directory, resultPath), "fixed\n");
      }
      const state = await readRun(), unitIndex = mode === "recovery-normal-succeeded" ? 1 : 0, unit = state.units[unitIndex]!, direct = unit.directExecution!;
      const key = createHash("sha256").update("v010\u0000root").digest("hex");
      const ledger = await RunFlightLedger.openGoal(join(directory, ".git", "sortie-dogs", V010_RUNTIME_PROFILE.flightDirectory, `${key}.json`));
      const before = await ledger.readGoal(), reservation = before.state.outstanding_reservations[0]!;
      assert.equal(reservation.unit_id, /^task_id: (.+)$/mu.exec(unit.task.prompt)![1]);
      const failed = mode === "recovery-failed", at = new Date().toISOString();
      const receipt = goalFingerprint({ call_id: unit.callID,
        output: "Host-observed direct unit finished; controller session remains active." });
      await ledger.appendGoal({ kind: "unit.settled", at, goal_id: before.state.goal_id!, reservation_id: reservation.reservation_id,
        receipt_id: receipt, unit_id: reservation.unit_id, disposition: failed ? "failed" : "cancelled",
        result_class: failed ? "acceptance" : "interrupted", evidence: [], progress_fingerprint: null, elapsed_ms: 12, cost_usd: 0.7,
        native_session_id: actor, native_started_at: direct.startedAt });
      if (mode === "finish-cancelled") {
        const result = JSON.parse(await hooks.tool!.sortie_v010_finish_direct_unit.execute({}, { sessionID: actor }));
        assert.equal(result.units[0].status, "cancelled"); assert.equal(result.direct_settlement.disposition, "cancelled");
        assert.match(result.next_action, /not validated/); assert.doesNotMatch(result.next_action, /This direct unit is validated/);
        assert.equal((await readRun()).units[0]!.evidence.length, 0); return;
      }
      await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).settled({ rootSessionID: "root", callID: unit.callID!,
        unitID: reservation.unit_id, childSessionID: actor, disposition: failed ? "failed" : "cancelled",
        resultClass: failed ? "acceptance" : "interrupted", evidence: [], nativeOutcome: "failed" });
      await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).update("root", mission => {
        const attempt = mission.attempts!.find(attempt => attempt.callID === unit.callID)!;
        attempt.status = failed ? "failed" : "cancelled"; attempt.resultClass = failed ? "acceptance" : "interrupted";
        attempt.failure = { category: "cancellation", code: "native-task-cancelled" };
        mission.progress.push({ unit: `${state.runID}/${unit.unit.id}`, title: unit.unit.title, status: attempt.status, at });
      });
      if (mode !== "recovery-missing-finish") (history[actor] ??= []).push({
        info: { role: "assistant", sessionID: actor, finish: "stop", time: { created: Date.parse(at) - 1, completed: Date.parse(at) + 1 } },
        parts: [{ type: "tool", tool: "sortie_v010_finish_direct_unit", callID: "historical-finish", state: {
          status: "completed", input: {}, time: { start: Date.parse(at) - 1, end: Date.parse(at) + 1 },
          output: JSON.stringify({ run_id: state.runID, status: "awaiting-decision", next_action: "This direct unit is validated" }) } }],
      });
      const broken = await readRun(), spent = (await ledger.readGoal()).state;
      assert.equal(broken.units[unitIndex]!.evidence.length, 0);
      assert.equal(broken.phase, "awaiting-decision");
      if (mode === "recovery-stale") await writeFile(join(directory, resultPath), "changed after validation\n");
      agents[actor]!.outcome = failed ? "failed" : "interrupted";
      if (mode === "recovery-paginated") historyAvailable = false;
      hooks = await create();
      if (mode === "recovery-explicit-cancel") {
        await hooks.tool!.sortie_v010_cancel_operator.execute({ run_id: state.runID, reason: "Explicit user cancellation" }, { sessionID: "root" });
      }
      const recover = () => hooks.tool!.sortie_v010_resume_operator.execute({ run_id: state.runID,
        acceptance_fingerprint: state.acceptanceFingerprint }, { sessionID: "root" });
      if (mode === "recovery-boundary") t.mock.method(OperatorRuntime.prototype, "gitAcceptanceReadiness", () => "operator-post-commit-validation-required");
      if (["recovery-stale", "recovery-latest-failure", "recovery-missing-finish", "recovery-explicit-cancel"].includes(mode)) {
        await assert.rejects(recover, /operator-(?:resume|recovery)/u);
        assert.equal((await readRun()).units[unitIndex]!.evidence.length, 0);
        assert.equal((await ledger.readGoal()).records.filter(record => record.event.kind === "unit.evidence-reconciled").length, 0);
      } else {
        if (mode === "recovery-crash") {
          const fault = t.mock.method(OperatorRuntime.prototype, "resume", async () => { throw new Error("fixture crash after ledger append"); });
          await assert.rejects(recover, /fixture crash/);
          fault.mock.restore(); hooks = await create();
          assert.equal((await readRun()).units[unitIndex]!.evidence.length, 0);
          assert.equal((await ledger.readGoal()).records.filter(record => record.event.kind === "unit.evidence-reconciled").length, 1);
        }
        if (mode.includes("projection-crash")) {
          const fault = t.mock.method(OperatorMissionRuntime.prototype, "update", async () => { throw new Error("fixture crash after operator save"); });
          await assert.rejects(recover, /fixture crash after operator save/);
          fault.mock.restore(); hooks = await create();
          assert.equal((await readRun()).units[unitIndex]!.status, "succeeded");
          assert.ok((await readRun()).units[unitIndex]!.directExecution!.registrationRecovery);
        }
        const restored = JSON.parse(await recover()), done = await readRun();
        assert.equal(done.phase, mode.includes("pending") ? "prepared" : mode === "recovery-boundary" ? "awaiting-decision" : "awaiting-acceptance"); assert.equal(done.units[unitIndex]!.status, "succeeded");
        assert.ok(done.units[unitIndex]!.evidence.length); assert.equal(done.units[unitIndex]!.callID, unit.callID);
        const { registrationRecovery, ...retainedDirect } = done.units[unitIndex]!.directExecution!;
        assert.deepEqual(retainedDirect, broken.units[unitIndex]!.directExecution);
        assert.equal(registrationRecovery!.previousStatus, failed ? "failed" : "cancelled");
        assert.match(restored.next_action, /not acceptance, Go or completion/);
        const recoveredMission = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
        assert.equal(recoveredMission.attempts![unitIndex]!.status, "succeeded");
        assert.equal(recoveredMission.attempts![unitIndex]!.registrationRecovery!.previousStatus, failed ? "failed" : "cancelled");
        if (multi || mode === "recovery-boundary") assert.equal(restored.task, undefined, "registration recovery does not generate a replacement Task");
        if (mode === "recovery-boundary") {
          assert.equal(restored.decision, "operator-post-commit-validation-required");
          assert.match(restored.next_action, /recorded boundary decision remains pending/);
        }
        const eventCount = (await ledger.readGoal()).records.length;
        hooks = await create(); await recover();
        assert.equal((await ledger.readGoal()).records.length, eventCount, "cold replay does not append evidence again");
        assert.equal((await readRun()).generation, done.generation, "replay does not resume the run twice");
      }
      const after = (await ledger.readGoal()).state;
      for (const field of ["consumed_units", "consumed_time_ms", "consumed_cost_usd", "validation_budget", "outstanding_reservations"] as const) {
        assert.deepEqual(after[field], spent[field], `${field} is unchanged by recovery`);
      }
      if (mode !== "recovery-explicit-cancel") assert.equal(aborted.length, 0, "direct recovery never interrupts the retained conversation");
      return;
    }
    if (externalDirectory) assert.equal(checked.at(-1)!.directory, externalDirectory);
    if (mode === "non-git-root") {
      assert.equal(checked.at(-1)!.binding.validation_policy, undefined,
        "a whole-root grant without a concrete output inventory retains full-candidate freshness");
    } else {
      assert.equal(checked.at(-1)!.binding.validation_policy, "inputs-and-concrete-outputs-v1",
        "non-generating native checks retain input/source bindings through final acceptance");
      await mkdir(join(directory, "reports"));
      await write("Actual native check passed.\n", "reports/result.md");
    }
    hooks = await create(); // The saved native checks, not live hook memory, authorize finish.
    if (mode === "compacted-latest-failure") {
      await write("bad\n");
      assert.equal(await check(), 1);
      await writeFile(join(directory, resultPath), "fixed\n");
    } else if (mode === "compacted-stale") await write("changed after validation\n");
    if (mode.startsWith("parent-")) {
      const previousOutcome = mode.slice("parent-".length);
      if (previousOutcome === "unset") delete agents[actor]!.outcome;
      else agents[actor]!.outcome = previousOutcome;
    }
    const finished = JSON.parse(await hooks.tool!.sortie_v010_finish_direct_unit.execute({}, { sessionID: actor }));
    if (compacted) assert.ok(paginatedStarts.includes(before.units[0]!.directExecution!.startedAt),
      "read the actual admission window instead of the compacted context");
    if (mode === "compacted-latest-failure" || mode === "compacted-stale") {
      assert.equal(finished.status, "direct-unit-awaits-validation");
      assert.equal((await readRun()).units[0]!.evidence.length, 0, "old success cannot hide a later failure or changed inputs");
      return;
    }
    assert.notEqual(finished.status, "direct-unit-awaits-validation", JSON.stringify(finished));
    const done = await readRun();
    assert.equal(done.phase, "awaiting-acceptance", JSON.stringify(done));
    assert.ok(done.units[0]!.evidence.length);
    assert.equal(done.units[0]!.directExecution!.checks.length, checked.length, "finish preserves observed validation without reruns");
    if (capacityFixture) {
      const { file, prior, pathCount } = capacityFixture;
      const restored = await RunFlightLedger.readGoalFile(file);
      assert.deepEqual(restored.records.slice(0, prior.records.length), prior.records, "legacy logical events and their hashes are unchanged");
      assert.ok(Buffer.byteLength(JSON.stringify(restored.records)) > 16 * 1024 * 1024, "logical history exceeds the legacy byte limit");
      assert.equal(restored.state.consumed_units, prior.state.consumed_units + 1);
      assert.equal(restored.state.outstanding_reservations.length, 0);
      const settled = restored.records.at(-1)!.event;
      assert.equal(settled.kind, "unit.settled");
      if (settled.kind !== "unit.settled") throw new Error("expected finish settlement");
      assert.equal(settled.native_session_id, actor);
      assert.deepEqual(settled.evidence, done.units[0]!.evidence);
      assert.equal(restored.state.consumed_cost_usd, prior.state.consumed_cost_usd === null || settled.cost_usd === null
        ? null : prior.state.consumed_cost_usd + settled.cost_usd);
      const historical = prior.records.find(record => record.event.kind === "unit.settled" && record.event.unit_id === "historical-0")!.event;
      if (historical.kind !== "unit.settled") throw new Error("expected historical settlement");
      assert.deepEqual(settled.evidence[0]!.protected_binding!.freshness!.protected_paths,
        historical.evidence[0]!.protected_binding!.freshness!.protected_paths);
      assert.ok(settled.evidence[0]!.protected_binding!.freshness!.protected_paths.length >= pathCount);
      const document = JSON.parse(await readFile(file, "utf8"));
      assert.equal(document.schema_version, "0.2");
      assert.ok(document.goal_events.some((record: { event_blob?: unknown }) => record.event_blob));
      assert.ok(Buffer.byteLength(JSON.stringify(document)) <= 16 * 1024 * 1024);
      assert.ok(document.goal_events.filter((record: { event_blob?: unknown }) => record.event_blob)
        .every((record: { event_blob: { chunks: { bytes: number }[] } }) => record.event_blob.chunks.every(chunk => chunk.bytes <= 1024 * 1024)));
      // Simulate the unchanged 0.1 writer's locked read and closed version check.
      const beforeLegacyWriter = await readFile(file);
      const oldWriter = async () => {
        const lock = await fs.open(`${file}.lock`, "wx");
        try {
          const raw = JSON.parse(await readFile(file, "utf8"));
          if (raw.schema_version !== "0.1" || !Array.isArray(raw.goal_events)) throw new Error("Goal ledger document does not match the closed schema.");
        } finally { await lock.close(); await fs.unlink(`${file}.lock`); }
      };
      await assert.rejects(oldWriter(), /closed schema/);
      assert.deepEqual(await readFile(file), beforeLegacyWriter);

      const copy = join(directory, "isolated-goal-copy.json");
      await fs.copyFile(file, copy);
      await fs.cp(`${file}.blobs`, `${copy}.blobs`, { recursive: true });
      const first = await RunFlightLedger.openGoal(copy), second = await RunFlightLedger.openGoal(copy);
      const next = (id: string) => ({ kind: "goal.user-continued" as const, at: new Date().toISOString(),
        goal_id: restored.state.goal_id!, origin_user_message_id: id, session_id: actor, selected_agent: restored.state.selected_agent! });
      await writeFile(`${copy}.lock`, "held");
      await assert.rejects(first.appendGoal(next("held")), (error: unknown) => error instanceof Error && /lock remained busy/.test(error.message));
      await fs.unlink(`${copy}.lock`);
      const results = await Promise.allSettled([first.appendGoal(next("concurrent-one")), second.appendGoal(next("concurrent-two"))]);
      for (const [index, result] of results.entries()) {
        if (result.status === "rejected") {
          assert.match(String(result.reason), /lock remained busy/);
          await (index === 0 ? first : second).appendGoal(next(index === 0 ? "concurrent-one" : "concurrent-two"));
        }
      }
      const concurrent = await RunFlightLedger.readGoalFile(copy);
      assert.equal(concurrent.records.filter(record => record.event.kind === "goal.user-continued" &&
        ["concurrent-one", "concurrent-two"].includes(record.event.origin_user_message_id)).length, 2);
      assert.deepEqual(concurrent.records.slice(0, restored.records.length), restored.records);
      // Inventory is an existing caller which distinguishes goal ledgers by the
      // top-level goal_events key. A blob-backed active Codex goal must still
      // prevent a new external writer from starting.
      await first.appendGoal({ ...next("codex-unknown"), selected_agent: "codex" });
      const inventory = join(directory, ".git", "sortie-dogs", "run-flight", "active-codex.json");
      await mkdir(join(directory, ".git", "sortie-dogs", "run-flight"), { recursive: true });
      await fs.copyFile(copy, inventory);
      await fs.cp(`${copy}.blobs`, `${inventory}.blobs`, { recursive: true });
      const manifest = join(directory, ".git", "codex-inventory-test.json");
      await writeFile(manifest, JSON.stringify({ version: "0.1.0", task_id: "codex-test", read: ["check.mjs"], write: ["result.txt"], validation: ["node check.mjs"] }));
      await assert.rejects(runCodexMission({ projectRoot: directory, manifestPath: manifest, prompt: "Do not resend", executable: "must-not-start" }),
        /codex-mission-outcome-unknown:no-resend/);
      const copyBody = await readFile(copy, "utf8");
      const invalid = JSON.parse(copyBody);
      invalid.goal_events.find((record: { event_blob?: unknown }) => record.event_blob).event_blob.chunks[0].sha256 = "../outside";
      await writeFile(copy, JSON.stringify(invalid));
      await assert.rejects(RunFlightLedger.readGoalFile(copy), /blob chunk reference is malformed/);
      await writeFile(copy, copyBody);
      const chunk = document.goal_events.find((record: { event_blob?: unknown }) => record.event_blob).event_blob.chunks[0].sha256;
      const chunkPath = join(`${copy}.blobs`, chunk), chunkBytes = await readFile(chunkPath);
      await fs.unlink(chunkPath);
      await assert.rejects(RunFlightLedger.readGoalFile(copy), /blob chunk is missing/);
      await writeFile(chunkPath, chunkBytes.subarray(0, chunkBytes.length - 1));
      await assert.rejects(RunFlightLedger.readGoalFile(copy), /blob chunk has an invalid size/);
      chunkBytes[0] = chunkBytes[0]! ^ 1;
      await writeFile(chunkPath, chunkBytes);
      await assert.rejects(RunFlightLedger.readGoalFile(copy), /blob chunk hash mismatch/);
    }
    const mission = await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root");
    if (mode === "large-source") {
      const rawBytes = Buffer.byteLength(JSON.stringify(missionPacket(mission, done)));
      const finishBytes = Buffer.byteLength(JSON.stringify(finished));
      t.diagnostic(JSON.stringify({ raw_packet_bytes: rawBytes, finish_packet_bytes: finishBytes }));
      assert.ok(rawBytes > 32_000, "tracked inputs reproduce a large one-line finish packet");
      assert.ok(finishBytes < 16_000, "successful transition and next action fit without protected arrays");
      assert.ok(rawBytes - finishBytes > 20_000);
    }
    assert.equal(finished.status, done.phase);
    assert.equal(finished.units[0].status, "succeeded");
    assert.equal(finished.execution_summary.accepted, false, "unit validation is not Mission acceptance");
    assert.match(finished.next_action, /do not repeat passed checks or finish this settled unit again/);
    assert.match(finished.next_action, /Independent Review and Operator final acceptance remain required/);
    const full = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({ view: "full" }, { sessionID: "root" }));
    assert.deepEqual(full.units[0].evidence, done.units[0]!.evidence, "full diagnostics retain authoritative proof");
    for (const [index, proof] of done.units[0]!.evidence.entries()) {
      const { protected_binding, ...measured } = proof;
      const compact = finished.units[0].evidence[index];
      assert.deepEqual(compact, { ...measured, ...(protected_binding ? { protected_binding_ref: {
        manifest_path: protected_binding.manifest_path, manifest_hash: protected_binding.manifest_hash,
        source_policy: protected_binding.source_policy,
      } } : {}) }, "finish keeps command, exit, timing, identity and proof scope without snapshot arrays");
    }
    assert.deepEqual(finished.units[0].evidence_details_ref, {
      path: new OperatorRuntime(directory, V010_RUNTIME_PROFILE).statePath("root"), run_id: done.runID,
      unit_id: done.units[0]!.unit.id, field: "units[].evidence",
      omitted: "host snapshot recipe: source/candidate paths and freshness environment",
    });
    assert.deepEqual((await readRun()).units[0]!.evidence, done.units[0]!.evidence, "response projection never rewrites saved validation");
    assert.equal(mission.id, started.mission_id);
    assert.equal(mission.attempts?.length, mode.endsWith("replan") ? 2 : 1);
    assert.equal(mission.attempts?.[0]?.kind, "direct_execution");
    assert.equal(mission.attempts?.[0]?.terminal, undefined, "active parent is not a native child terminal");
    await assert.rejects(hooks.tool!.sortie_v010_complete_mission.execute({}, { sessionID: "root" }), /mission-review/);
    if (mode === "correction") {
      const initial = JSON.parse(await hooks.tool!.sortie_v010_review_mission.execute({ risk_tags: ["public-logic"],
        mode: "self-recheck" }, { sessionID: actor }));
      assert.equal(initial.status, "mission-initial-self-recheck-unavailable");
      assert.match(initial.next_action, /mode=independent/);
      assert.deepEqual(await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root"), mission,
        "initial self-recheck cannot manufacture a Reviewer, review disposition or acceptance");
      await assert.rejects(hooks.tool!.sortie_v010_complete_mission.execute({}, { sessionID: "root" }), /mission-review/);
    }
    const review = JSON.parse(await hooks.tool!.sortie_v010_review_mission.execute({ risk_tags: ["public-logic"] }, { sessionID: actor }));
    const task = { args: structuredClone(review.task) };
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: actor, callID: "review-call" }, task);
    agents.reviewer!.outcome = "succeeded";
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: actor, callID: "review-call" }, { output: "PASS\nResult and actual check agree.", metadata: { sessionId: "reviewer" } });
    if (actor === "coordinator") {
      for (const status of mode === "large-source" ? ["blocked", "needs-decision", "ready"] : ["ready"]) {
        const summary = "Direct correction validated and independently reviewed";
        const submittedText = await hooks.tool!.sortie_v010_submit_mission.execute({ status, summary }, { sessionID: actor });
        const submitted = JSON.parse(submittedText);
        assert.equal(Object.keys(submitted)[0], "acceptance_summary");
        assert.equal(submitted.phase, "submitted");
        assert.deepEqual(submitted.submission, { status, summary });
        assert.equal(submitted.execution_summary.accepted, false, "submission still requires Operator acceptance");
        assert.deepEqual(submitted.acceptance_summary.original_requests, mission.requests);
        assert.deepEqual(submitted.acceptance_summary.requirements, mission.requirements);
        assert.equal(submitted.acceptance_summary.independent_review.verdict, "PASS");
        assert.equal(submitted.acceptance_summary.independent_review.independent, true);
        if (status === "ready") {
          assert.match(submitted.next_action, /Compare the original requests with the candidate and actual evidence/);
          assert.match(submitted.next_action, /complete_mission receipt/);
        } else assert.match(submitted.next_action, /incomplete delivery, not acceptance/);
        if (mode === "large-source") {
          const rawText = JSON.stringify({ acceptance_summary: submitted.acceptance_summary,
            ...missionPacket(await new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE).required("root"), done),
            next_action: submitted.next_action });
          t.diagnostic(JSON.stringify({ submission_status: status, raw_submission_bytes: Buffer.byteLength(rawText),
            submission_bytes: Buffer.byteLength(submittedText) }));
          assert.ok(Buffer.byteLength(rawText) > 32_000, "protected inputs reproduce the oversized submission");
          assert.ok(Buffer.byteLength(submittedText) < 16_000, "submission acknowledgement and next action remain visible");
          assert.deepEqual(submitted.units[0].evidence, finished.units[0].evidence, "reuse measured evidence without protected arrays");
          assert.deepEqual(submitted.units[0].evidence_details_ref, finished.units[0].evidence_details_ref);
          assert.deepEqual((await readRun()).units[0]!.evidence, done.units[0]!.evidence, "submission projection preserves durable proof");
          const fullSubmitted = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({ view: "full" }, { sessionID: "root" }));
          assert.deepEqual(fullSubmitted.units[0].evidence, done.units[0]!.evidence, "explicit full status retains complete evidence");
          assert.deepEqual(fullSubmitted.acceptance_summary, submitted.acceptance_summary, "submission retains the full original acceptance summary");
        }
      }
    }
    const completed = JSON.parse(await hooks.tool!.sortie_v010_complete_mission.execute({}, { sessionID: "root" }));
    assert.equal(completed.status, "succeeded", JSON.stringify(completed));
    if (capacityFixture) {
      hooks = await create();
      const cold = await RunFlightLedger.readGoalFile(capacityFixture.file);
      assert.equal(cold.state.receipt?.status, "succeeded");
      assert.equal(cold.state.consumed_units, capacityFixture.prior.state.consumed_units + 1);
      assert.deepEqual(cold.records.slice(0, capacityFixture.prior.records.length), capacityFixture.prior.records);
      const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({ view: "full" }, { sessionID: "root" }));
      assert.equal(status.units[0].status, "succeeded");
    }
    assert.equal(await readFile(resolve(directory, resultPath), "utf8"), "fixed\n");
    assert.equal((await readRun()).units[0]!.directExecution?.actor, actor, "recovery and acceptance retain the same author without a user turn");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(directory, { recursive: true, force: true });
    if (externalDirectory) await rm(externalDirectory, { recursive: true, force: true }); }
});

for (const mode of ["shim", "shim-alias", "shim-external-file", "shim-git-only", "shim-git-only-external-file", "shim-git-only-assume-unchanged", "shim-git-only-skip-worktree", "shim-git-only-unborn", "shim-git-only-unborn-untracked", "actual"]) test(`native Docker validation binds the task container CWD and candidate through Worker settlement and independent Review (${mode})`, {
  skip: mode === "actual" && !process.env.SORTIE_NATIVE_DOCKER_IMAGE,
}, async () => {
  const actualDocker = mode === "actual", noPython = mode.includes("git-only");
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(resolve("_testenv/native-docker-formal-"));
  const gateway = join(root, "gateway"), physicalWorkspace = join(root, "workspace"), bin = join(root, "bin");
  const workspace = mode === "shim-alias" ? join(root, "workspace-link") : physicalWorkspace;
  let containerID = "0123456789abcdef01234567", ownedContainer: string | undefined;
  const priorPath = process.env.PATH, priorContainer = process.env.FAKE_DOCKER_CONTAINER;
  await mkdir(gateway); await mkdir(physicalWorkspace); await mkdir(bin);
  if (mode === "shim-alias") await fs.symlink(physicalWorkspace, workspace, "dir");
  const fakeDocker = join(bin, "docker");
  const source = 'test "$(cat input.txt)" = fixed || exit 7\nprintf "PASS\\n"\n';
  try {
    for (const dir of [gateway, workspace]) {
      await exec("git", ["init", "--quiet"], { cwd: dir });
      if (dir === gateway || !mode.includes("unborn")) {
        await exec("git", ["config", "user.name", "test"], { cwd: dir });
        await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
      }
    }
    await writeFile(join(gateway, "instruction.md"), "Validate the task workspace through its fixed container.\n");
    await writeFile(join(gateway, "host-canary.txt"), "gateway bytes are not the task candidate\n");
    await exec("git", ["add", "--", "instruction.md", "host-canary.txt"], { cwd: gateway });
    await exec("git", ["commit", "--quiet", "-m", "gateway fixture"], { cwd: gateway });
    await writeFile(join(workspace, "input.txt"), "fixed\n");
    if (mode.endsWith("external-file")) {
      await writeFile(join(root, "captured-check.sh"), source);
      await fs.symlink(join(root, "captured-check.sh"), join(workspace, "check.sh"));
    } else await writeFile(join(workspace, "check.sh"), source);
    if (!mode.endsWith("unborn-untracked")) await exec("git", ["add", "--", "input.txt", "check.sh"], { cwd: workspace });
    if (!mode.includes("unborn")) await exec("git", ["commit", "--quiet", "-m", "task fixture"], { cwd: workspace });
    const taskObjectsBefore = mode.includes("unborn") ? (await exec("git", ["count-objects", "-v"], { cwd: workspace })).stdout : undefined;
    if (mode.endsWith("assume-unchanged") || mode.endsWith("skip-worktree")) {
      await exec("git", ["update-index", mode.endsWith("assume-unchanged") ? "--assume-unchanged" : "--skip-worktree", "input.txt"], { cwd: workspace });
      assert.match((await exec("git", ["ls-files", "-v", "input.txt"], { cwd: workspace })).stdout,
        mode.endsWith("assume-unchanged") ? /^h / : /^S /);
    }
    await writeFile(fakeDocker, `#!/bin/sh\nset -eu\n[ "$1" = exec ] || exit 125\nshift\n[ "$1" = --workdir ] || exit 125\nworkdir=$2\nshift 2\n[ "$1" = "$FAKE_DOCKER_CONTAINER" ] || exit 125\nshift\ncd "$workdir"\nexport GIT_CEILING_DIRECTORIES=${JSON.stringify(root)}\nexec "$@"\n`);
    if (noPython) await writeFile(fakeDocker, `#!${process.execPath}\nimport {spawnSync} from 'node:child_process';\nconst a=process.argv.slice(2);\nif(a[0]!=='exec'||a[1]!=='--workdir'||a[3]!==process.env.FAKE_DOCKER_CONTAINER)process.exit(125);\nif(a[4]==='python3')process.exit(127);\nif(a[4]==='sh')a[6]=a[6].replace('if command -v python3 >/dev/null 2>&1; then','if false; then');\nconst r=spawnSync(a[4],a.slice(5),{cwd:a[2],env:{...process.env,GIT_CEILING_DIRECTORIES:${JSON.stringify(root)}},stdio:'inherit'});\nprocess.exit(r.status??125);\n`);
    await chmod(fakeDocker, 0o755);
    if (actualDocker) {
      const image = process.env.SORTIE_NATIVE_DOCKER_IMAGE!;
      assert.match(image, /^sha256:[a-f0-9]{64}$/);
      ownedContainer = (await exec("docker", ["create", "--network", "none", "--mount", `type=bind,src=${root},dst=${root}`,
        "--entrypoint", "/bin/sh", image, "-c", "sleep 240"])).stdout.trim();
      containerID = ownedContainer;
      await exec("docker", ["start", containerID]);
    } else process.env.PATH = `${bin}${process.platform === "win32" ? ";" : ":"}${priorPath ?? ""}`;
    process.env.FAKE_DOCKER_CONTAINER = containerID;

    const requiredTools = ["sortie_v010_start_mission", "sortie_v010_operator_next", "sortie_v010_plan_units",
      "sortie_v010_bind_write_gate", "sortie_v010_release_write_gate", "sortie_v010_operator_status",
      "sortie_v010_start_direct_unit", "sortie_v010_finish_direct_unit", "sortie_v010_repair_review"];
    let registeredTools: { id: string; [key: string]: unknown }[] = [
      ...["execute", "subagent", "read", "task", "shell", "edit", ...requiredTools].map(id => ({ id })),
    ];
    let dockerDefinition: { options?: { codemode?: boolean }; execute(input: unknown, context: Record<string, unknown>): Promise<{ content: string }> } | undefined;
    let dockerRead: typeof dockerDefinition;
    const nativeHooks = new Map<string, (event: any) => void>();
    const context = {
      location: { directory: gateway },
      options: { container: containerID, instruction: "fixed instruction", model: "openai/gpt-6-sol", allowedModels: ["openai/gpt-6-sol"] },
      session: {
        get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, agent: sessionID === "reviewer" ? "dog-reviewer-v010" : "dog-worker-v010", parentID: "coordinator" }),
        context: async () => [{ id: "usage", type: "assistant", agent: "dog-worker-v010", time: { completed: 2 },
          model: { providerID: "openai", id: "gpt-6-luna-fast" }, tokens: { input: 3, output: 2, cache: { read: 1, write: 0 } } }],
        hook: async (name: string, callback: (event: any) => void) => { nativeHooks.set(name, callback); return { dispose: async () => {} }; },
      },
      event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {
        yield { type: "session.idle", data: { sessionID: "worker" } };
        yield { type: "session.created", data: { sessionID: "reviewer" } };
      } }) },
      tool: {
        list: async () => registeredTools,
        transform: async (change: (editor: { namespace(): void; add(tool: any): void; list(): typeof registeredTools; remove(id: string): void }) => void) => {
          change({ namespace() {}, add(tool) { if (tool.name === "docker_exec") dockerDefinition = tool; else if (tool.name === "docker_read") dockerRead = tool;
            registeredTools.push({ id: `fh_${tool.name}` }); },
            list: () => registeredTools, remove(id) { registeredTools = registeredTools.filter(tool => tool.id !== id); } });
        },
      },
    };
    // Exercise the public preparation/loading path, not an unpublished in-memory tool.
    await exec("python3", ["-c", `import sys; sys.path.insert(0, sys.argv[1]); from frontierharness_gateway import install_native_docker_plugin; install_native_docker_plugin(sys.argv[2])`,
      resolve("scripts"), gateway], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    const installedPlugin = (await import(pathToFileURL(join(gateway, ".opencode/plugins/docker-task/index.js")).href)).default;
    const cleanupPlugin = await installedPlugin.setup(context as never);
    nativeHooks.get("model.request")!({ kind: "primary", sessionID: "worker", agent: "dog-worker-v010", model: { providerID: "openai", id: "gpt-6-luna-fast" } });
    const nativeContext = { agent: "dog-worker-v010", system: [] as { text: string }[] };
    nativeHooks.get("context")!(nativeContext);
    assert.match(nativeContext.system[0]!.text, /validation_cwd/);
    assert.ok(nativeContext.system[0]!.text.includes(containerID));
    assert.equal(dockerDefinition?.options?.codemode, false, "the replacement tool must produce an ordinary native call");
    assert.ok(dockerDefinition);

    const identities: Record<string, { agent: string; parentID?: string; outcome?: string }> = {
      root: { agent: "dog-operator" }, coordinator: { agent: "dogs-coordinator", parentID: "root" },
      worker: { agent: "dog-worker-v010", parentID: "coordinator" }, reviewer: { agent: "dog-reviewer-v010", parentID: "coordinator" },
    };
    const history: Record<string, Record<string, unknown>[]> = {};
    const hooks = await SortieDogsV010Plugin({ directory: gateway, returnReportTransport: "tool-result", client: { session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...identities[path.id] } }),
      children: async ({ path }: { path: { id: string } }) => ({ data: Object.entries(identities)
        .filter(([, item]) => item.parentID === path.id).map(([id, item]) => ({ id, ...item })) }),
      messages: async ({ path }: { path: { id: string } }) => ({ data: history[path.id] ?? [] }),
      abort: async () => ({ data: true }),
    } } } as never);
    const chat = async (id: string, text: string) => hooks["chat.message"]!({ sessionID: id, messageID: `${id}-user`, agent: identities[id]!.agent }, {
      message: { id: `${id}-user`, agent: identities[id]!.agent, model: { providerID: "openai", modelID: "gpt-6-sol" } },
      parts: [{ type: "text", text }],
    });
    await chat("root", "Validate the fixed task-container source and retain native Docker evidence.");
    const started = JSON.parse(await hooks.tool!.sortie_v010_start_mission.execute({ requirements: ["The task workspace check passes for the current source"] }, { sessionID: "root" }));
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" }, { args: structuredClone(started.task) });
    await chat("coordinator", started.task.prompt);
    const planned = JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ units: [{ title: "Validate task workspace",
       objective: "Run the declared check inside the fixed task container", read: ["instruction.md"], write: [], validation: ["sh check.sh"],
       validation_cwd: { "sh check.sh": workspace } }] },
    { sessionID: "coordinator" }));
    const workerTask = { args: structuredClone(planned.task) };
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "coordinator", callID: "worker-call" }, workerTask);
    await chat("worker", workerTask.args.prompt);
    const state = await new OperatorRuntime(gateway, V010_RUNTIME_PROFILE).required("root"), unit = state.units[0]!;
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: "worker", callID: "handoff" }, { args: { filePath: unit.handoffPath } });
    await hooks["tool.execute.after"]!({ tool: "read", sessionID: "worker", callID: "handoff", args: { filePath: unit.handoffPath } }, { output: "inspected" });
    assert.equal(JSON.parse(await hooks.tool!.sortie_v010_bind_write_gate.execute({ project_root: gateway,
      manifest_path: unit.manifestPath }, { sessionID: "worker" })).status, "bound");

    const wrongCwd = join(workspace, "other");
    await mkdir(wrongCwd); await writeFile(join(wrongCwd, "input.txt"), "fixed\n"); await writeFile(join(wrongCwd, "check.sh"), source);
    const wrongArgs = { container_id: containerID, cwd: wrongCwd, command: "sh check.sh" };
    await hooks["tool.execute.before"]!({ tool: "fh_docker_exec", sessionID: "worker", callID: "wrong-cwd-success" }, { args: wrongArgs });
    const wrongResult = await dockerDefinition!.execute(wrongArgs, { agent: "dog-worker-v010", sessionID: "worker" });
    assert.match(wrongResult.content, /^exit_code=0\n/);
    await hooks["tool.execute.after"]!({ tool: "fh_docker_exec", sessionID: "worker", callID: "wrong-cwd-success", args: wrongArgs },
      { output: wrongResult.content, metadata: { status: "completed" } });
    assert.equal((await new OperatorRuntime(gateway, V010_RUNTIME_PROFILE).required("root")).units[0]!.evidence.length, 0,
      "a real successful check in another container CWD is not the registered proof");
    const args = { container_id: containerID, cwd: workspace, command: "sh check.sh" }, callID = "native-docker-check";
    await hooks["tool.execute.before"]!({ tool: "fh_docker_exec", sessionID: "worker", callID }, { args });
    const startedAt = Date.now();
    const result = await dockerDefinition!.execute(args, { agent: "dog-worker-v010", sessionID: "worker" });
    const endedAt = Date.now();
    assert.match(result.content, /^exit_code=0\nPASS/m);
    (history.worker ??= []).push({ info: { id: "docker-result", role: "assistant", sessionID: "worker" }, parts: [{ type: "tool",
      tool: "fh_docker_exec", callID, state: { status: "completed", input: args, output: result.content,
        metadata: { status: "completed" }, time: { start: startedAt, end: endedAt } }, time: { created: startedAt, ran: startedAt, completed: endedAt } }] });
    await hooks["tool.execute.after"]!({ tool: "fh_docker_exec", sessionID: "worker", callID, args },
      { output: result.content, content: result.content, metadata: { status: "completed" } } as never);
    identities.worker!.outcome = "succeeded";
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "coordinator", callID: "worker-call" },
      { output: "native Docker check passed", metadata: { sessionId: "worker" } });

    const settled = await new OperatorRuntime(gateway, V010_RUNTIME_PROFILE).required("root"), evidence = settled.units[0]!.evidence;
    assert.equal(settled.units[0]!.status, "succeeded");
    assert.equal(evidence.length, 1, "native Docker result must be formally attached before Worker settlement");
    assert.equal(evidence[0]!.execution.command[0], "sh check.sh");
    assert.equal(evidence[0]!.execution.exit_code, 0);
    assert.equal(evidence[0]!.execution.outcome, "pass");
    const dockerBinding = evidence[0]!.protected_binding?.docker_workspace;
    assert.ok(dockerBinding);
    assert.equal(dockerBinding.container_id, containerID);
    assert.equal(dockerBinding.cwd, workspace);
    assert.equal(dockerBinding.repository_root, physicalWorkspace);
    assert.equal(dockerBinding.actual_cwd, mode === "shim-alias" ? physicalWorkspace : undefined,
      "retain native physical CWD without replacing the declared logical Docker CWD");
    assert.equal(dockerBinding.source, evidence[0]!.identity.source);
    assert.equal(dockerBinding.candidate, evidence[0]!.identity.candidate);
    assert.equal(evidence[0]!.protected_binding?.source_paths.length, 0, "Docker paths are not misrepresented as gateway host paths");
    const binding = evidence[0]!.protected_binding!;
    const unchanged = await refreshProtectedSnapshot(gateway, binding);
    assert.equal(unchanged?.candidate, dockerBinding.candidate);
    const review = JSON.parse(await hooks.tool!.sortie_v010_review_mission.execute({ risk_tags: ["public-logic"], mode: "independent" }, { sessionID: "coordinator" }));
    assert.ok(review.task, JSON.stringify(review));
    const reviewDispatch = { args: structuredClone(review.task) };
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "coordinator", callID: "docker-review-call" }, reviewDispatch);
    assert.ok(reviewDispatch.args.prompt.includes(dockerBinding.candidate), "expanded native Review envelope contains the actual candidate identity");
    const reviewerContext = { agent: "dog-reviewer-v010", system: [] as { text: string }[] };
    nativeHooks.get("context")!(reviewerContext);
    assert.match(reviewerContext.system.map(part => part.text).join("\n"), /fh_docker_read/);
    const readArgs = { container_id: containerID, cwd: workspace, candidate: dockerBinding.candidate, path: "check.sh" };
    await hooks["tool.execute.before"]!({ tool: "fh_docker_read", sessionID: "reviewer", callID: "docker-review-source" }, { args: readArgs });
    const inspected = await dockerRead!.execute(readArgs, { agent: "dog-reviewer-v010", sessionID: "reviewer" });
    const inspectedFile = JSON.parse(inspected.content);
    assert.equal(inspectedFile.sha256, createHash("sha256").update(source).digest("hex"));
    assert.equal(inspectedFile.workspace.candidate, dockerBinding.candidate);
    assert.equal(inspectedFile.lines.map((row: [number, string]) => row[1]).join(""), source);
    if (mode.endsWith("external-file")) {
      assert.equal(inspectedFile.path, join(root, "captured-check.sh"));
      await assert.rejects(dockerRead!.execute({ ...readArgs, path: join(root, "captured-check.sh") },
        { agent: "dog-reviewer-v010", sessionID: "reviewer" }), /file-outside-candidate-workspace/);
    }
    await hooks["tool.execute.after"]!({ tool: "fh_docker_read", sessionID: "reviewer", callID: "docker-review-source", args: readArgs },
      { output: inspected.content, metadata: { status: "completed" } });
    await assert.rejects(dockerDefinition!.execute(args, { agent: "dog-reviewer-v010", sessionID: "reviewer" }), /author-only/);
    assert.equal((await new OperatorRuntime(gateway, V010_RUNTIME_PROFILE).required("root")).units[0]!.evidence.length, 1,
      "read-only inspection does not produce extra validation evidence");
    identities.reviewer!.outcome = "succeeded";
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "coordinator", callID: "docker-review-call" },
      { output: "PASS\nRead the exact Docker candidate check.sh and confirmed its input assertion.", metadata: { sessionId: "reviewer" } });
    const receipt = JSON.parse(await hooks.tool!.sortie_v010_complete_mission.execute({}, { sessionID: "root" }));
    assert.equal(receipt.status, "succeeded", JSON.stringify(receipt));
    if (taskObjectsBefore !== undefined) {
      await assert.rejects(exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: workspace }), "native inspection does not create a commit");
      assert.equal((await exec("git", ["count-objects", "-v"], { cwd: workspace })).stdout, taskObjectsBefore, "native observation never writes Git objects");
    }
    const reviewed = await new OperatorMissionRuntime(gateway, V010_RUNTIME_PROFILE).required("root");
    assert.equal(reviewed.review?.verdict, "PASS");
    assert.equal(reviewed.review?.mode, "independent");
    assert.equal(reviewed.review?.child, "reviewer");
    assert.ok(!reviewed.sourceAuthors?.includes("reviewer"), "the Reviewer is not a candidate author");
    await writeFile(join(gateway, "host-canary.txt"), "changed gateway bytes after the Docker proof\n");
    const gatewayOnlyChange = await refreshProtectedSnapshot(gateway, binding);
    assert.equal(gatewayOnlyChange?.candidate, dockerBinding.candidate,
      "unrelated gateway host bytes cannot masquerade as or stale the Docker task candidate");
    await writeFile(join(workspace, "input.txt"), "changed after validation\n");
    const changedTaskInput = await refreshProtectedSnapshot(gateway, binding);
    assert.notEqual(changedTaskInput?.candidate, dockerBinding.candidate,
      "changed task-workspace bytes invalidate the saved Docker candidate binding");
    await assert.rejects(dockerRead!.execute(readArgs, { agent: "dog-reviewer-v010", sessionID: "reviewer" }), /candidate-stale/);
    await writeFile(join(workspace, "input.txt"), "fixed\n");
    await writeFile(join(workspace, ".gitignore"), "ignored-input.txt\n");
    await writeFile(join(workspace, "ignored-input.txt"), "before\n");
    const withIgnored = await captureDockerWorkspaceSnapshot(containerID, workspace);
    await writeFile(join(workspace, "ignored-input.txt"), "after\n");
    assert.notEqual((await captureDockerWorkspaceSnapshot(containerID, workspace))?.candidate, withIgnored?.candidate,
      "Git ignore rules do not exclude task inputs from Docker proof");
    const plain = join(root, "non-git-task"); await mkdir(plain); await writeFile(join(plain, "logs.txt"), "original\n");
    await writeFile(join(plain, "sitecustomize.py"), 'open("startup-side-effect.txt", "w").write("candidate startup executed\\n")\n');
    if (noPython) {
      await exec("git", ["init", "--quiet"], { cwd: plain });
      await exec("git", ["add", "."], { cwd: plain });
      await exec("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Git-only plain fixture"], { cwd: plain });
    }
    const plainBefore = await captureDockerWorkspaceSnapshot(containerID, plain);
    await assert.rejects(readFile(join(plain, "startup-side-effect.txt")), { code: "ENOENT" }, "snapshot does not execute candidate Python startup code");
    assert.ok(plainBefore, noPython ? "Git-only image reuses the committed Git identity" : "Terminal task workspaces need no Git initialization");
    const plainRead = await dockerRead!.execute({ container_id: containerID, cwd: plain, candidate: plainBefore.candidate, path: "logs.txt" },
      { agent: "dog-reviewer-v010", sessionID: "reviewer" });
    assert.equal(JSON.parse(plainRead.content).lines[0][1], "original\n");
    await assert.rejects(readFile(join(plain, "startup-side-effect.txt")), { code: "ENOENT" }, "read-only inspection does not execute candidate Python startup code");
    await writeFile(join(plain, "logs.txt"), "changed\n");
    assert.notEqual((await captureDockerWorkspaceSnapshot(containerID, plain))?.candidate, plainBefore.candidate);
    if (mode === "shim-alias") {
      const nested = join(physicalWorkspace, "nested");
      await mkdir(nested); await writeFile(join(nested, "input.txt"), "fixed\n");
      const beforeAlias = await captureDockerWorkspaceSnapshot(containerID, workspace);
      assert.ok(beforeAlias);
      await fs.unlink(workspace); await fs.symlink(nested, workspace, "dir");
      const retargeted = await captureDockerWorkspaceSnapshot(containerID, workspace);
      assert.ok(retargeted);
      assert.equal(retargeted.source, beforeAlias.source, "retargeting an external CWD alias does not edit repository bytes");
      assert.notEqual(retargeted.candidate, beforeAlias.candidate, "same repository bytes cannot hide a different actual execution CWD");
      assert.equal(retargeted.actual_cwd, nested);
      await assert.rejects(dockerRead!.execute({ ...readArgs, candidate: beforeAlias.candidate },
        { agent: "dog-reviewer-v010", sessionID: "reviewer" }), /candidate-stale/);
    }
    await cleanupPlugin();
    const requestAudit = await readFile(join(gateway, "model-request-audit.ndjson"), "utf8");
    const usageAudit = await readFile(join(gateway, "model-usage-audit.ndjson"), "utf8");
    assert.match(requestAudit, /openai\/gpt-6-luna-fast/);
    assert.match(usageAudit, /"message_id":"usage"/);
    assert.match(usageAudit, /"cost":null/, "unreported cost is retained as unknown, not zero");
    assert.match(await readFile(join(gateway, "sortie-agent-route-audit.ndjson"), "utf8"), /dog-reviewer-v010/);
    const audit = await readFile(join(gateway, "docker-exec-audit.ndjson"), "utf8");
    assert.match(audit, new RegExp(`"container_id":"${containerID}"`));
    assert.match(audit, new RegExp(`"cwd":"${workspace.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"`));
  } finally {
    process.env.PATH = priorPath;
    if (priorContainer === undefined) delete process.env.FAKE_DOCKER_CONTAINER; else process.env.FAKE_DOCKER_CONTAINER = priorContainer;
    if (ownedContainer) await exec("docker", ["rm", "-f", ownedContainer]);
    await rm(root, { recursive: true, force: true });
  }
});

test("native Docker smoke uses a fixed local image and a non-Git task workspace", {
  skip: !process.env.SORTIE_NATIVE_DOCKER_IMAGE,
}, async () => {
  const image = process.env.SORTIE_NATIVE_DOCKER_IMAGE!;
  assert.match(image, /^sha256:[a-f0-9]{64}$/, "do not pull or select a mutable task image");
  const root = await mkdtemp(resolve("_testenv/native-docker-smoke-"));
  const gateway = join(root, "gateway"), workspace = join(root, "task");
  let container: string | undefined;
  try {
    await mkdir(gateway); await mkdir(workspace);
    await writeFile(join(workspace, "input.txt"), "fixed\n");
    const created = await exec("docker", ["create", "--network", "none", "--label", "sortie.native-docker-smoke=true",
      "--mount", `type=bind,src=${workspace},dst=/app,readonly`, "--entrypoint", "/bin/sh", image, "-c", "sleep 180"]);
    container = created.stdout.trim();
    assert.match(container, /^[a-f0-9]{64}$/);
    await exec("docker", ["start", container]);
    const before = await captureDockerWorkspaceSnapshot(container, "/app");
    assert.ok(before, "actual non-Git container workspace is captured");
    let definition: { execute(input: unknown, context: unknown): Promise<{ content: string }> } | undefined;
    let tools = ["execute", "subagent", "read", "sortie_v010_start_mission", "sortie_v010_operator_next",
      "sortie_v010_plan_units", "sortie_v010_bind_write_gate", "sortie_v010_release_write_gate", "sortie_v010_operator_status",
      "sortie_v010_start_direct_unit", "sortie_v010_finish_direct_unit", "sortie_v010_repair_review"].map(id => ({ id }));
    const cleanup = await nativeDockerTaskPlugin.setup({
      location: { directory: gateway },
      options: { container, instruction: "synthetic smoke only", model: "openai/gpt-6-sol", allowedModels: ["openai/gpt-6-sol"] },
      tool: { list: async () => tools, transform: async (fn: (editor: any) => void) => fn({ namespace() {},
        add(tool: any) { if (tool.name === "docker_exec") definition = tool; tools.push({ id: `fh_${tool.name}` }); }, list: () => tools,
        remove(id: string) { tools = tools.filter(tool => tool.id !== id); } }) },
      session: { hook: async () => ({ dispose: async () => {} }), context: async () => [], get: async () => ({}) },
      event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
    } as never);
    try {
      const result = await definition!.execute({ container_id: container, cwd: "/app", command: 'test "$(cat input.txt)" = fixed' },
        { agent: "dog-worker-v010", sessionID: "no-model-smoke" });
      assert.match(result.content, /^exit_code=0\n/);
      assert.equal((await captureDockerWorkspaceSnapshot(container, "/app"))?.candidate, before.candidate);
      await writeFile(join(workspace, "input.txt"), "changed\n");
      assert.notEqual((await captureDockerWorkspaceSnapshot(container, "/app"))?.candidate, before.candidate);
      const failed = await definition!.execute({ container_id: container, cwd: "/app", command: 'test "$(cat input.txt)" = fixed' },
        { agent: "dog-worker-v010", sessionID: "no-model-smoke" });
      assert.match(failed.content, /^exit_code=1\n/);
    } finally { await cleanup(); }
  } finally {
    if (container) await exec("docker", ["rm", "-f", container]);
    await rm(root, { recursive: true, force: true });
  }
});
