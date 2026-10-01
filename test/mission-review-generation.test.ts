import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";
import { OperatorMissionRuntime } from "../dist/core/operator-mission.js";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";

const exec = promisify(execFile);
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
};

for (const mode of ["already-replaced", "identity-await", "history-await", "foreground-current"] as const) {
  test(`Reviewer generation ownership: ${mode}`, { timeout: 20_000 }, async () => {
    await mkdir(resolve("_testenv"), { recursive: true });
    const directory = await mkdtemp(resolve("_testenv/mission-review-generation-"));
    try {
      await exec("git", ["init", "--quiet"], { cwd: directory });
      await writeFile(join(directory, "check.mjs"), 'import { readFileSync } from "node:fs"; if (readFileSync("result.txt", "utf8") !== "ready\\n") process.exit(1);\n');
      const agents: Record<string, { agent: string; parentID?: string; outcome?: string }> = {
        root: { agent: "dog-operator" }, worker: { agent: "dog-worker-v010", parentID: "root" },
        reviewer: { agent: "dog-reviewer-v010", parentID: "root" },
      };
      const entered = deferred(), release = deferred();
      let pause = false, reviewerIdentityReads = 0, running = false;
      const report = mode === "history-await" ? "EVIDENCE_GAPS\nReview A advisory notes" : "PASS\nReview A result";
      const hooks = await SortieDogsV010Plugin({ directory,
        nativeBackground: { awaiting: async () => running }, client: { session: {
          get: async ({ path }: { path: { id: string } }) => {
            if (pause && path.id === "reviewer" && ++reviewerIdentityReads === 2 && mode === "identity-await") {
              entered.resolve(); await release.promise;
            }
            return { data: { id: path.id, ...agents[path.id] } };
          },
          messages: async ({ path }: { path: { id: string } }) => {
            if (path.id === "reviewer") {
              if (pause && mode === "history-await") { entered.resolve(); await release.promise; }
              return { data: [{ info: { id: "reviewer-final", sessionID: "reviewer", role: "assistant" },
                parts: [{ type: "text", text: report }] }] };
            }
            return { data: [] };
          },
          children: async ({ path }: { path: { id: string } }) => ({ data: Object.entries(agents)
            .filter(([, agent]) => agent.parentID === path.id).map(([id, agent]) => ({ id, ...agent })) }),
        } } } as never);
      const chat = async (sessionID: string, text: string) => hooks["chat.message"]!({ sessionID,
        messageID: `${sessionID}-prompt`, agent: agents[sessionID]!.agent }, {
        message: { id: `${sessionID}-prompt`, agent: agents[sessionID]!.agent, model: { providerID: "openai", modelID: "test" } },
        parts: [{ type: "text", text }],
      });
      await chat("root", "Create result.txt with ready and validate and independently review it.");
      await hooks.tool!.sortie_v010_start_mission.execute({ requirements: ["Create validated ready output"] }, { sessionID: "root" });
      const plan = JSON.parse(await hooks.tool!.sortie_v010_plan_units.execute({ units: [{ title: "Ready output",
        objective: "Write the requested ready output", read: ["check.mjs"], write: ["result.txt"], validation: ["node check.mjs"] }] }, { sessionID: "root" }));
      await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "worker-call" }, { args: plan.task });
      await chat("worker", plan.task.prompt);
      const unit = (await new OperatorRuntime(directory, V010_RUNTIME_PROFILE).required("root")).units[0]!;
      await hooks["tool.execute.before"]!({ tool: "read", sessionID: "worker", callID: "handoff" }, { args: { filePath: unit.handoffPath } });
      await hooks["tool.execute.after"]!({ tool: "read", sessionID: "worker", callID: "handoff", args: { filePath: unit.handoffPath } },
        { output: await readFile(unit.handoffPath, "utf8") });
      await hooks.tool!.sortie_v010_bind_write_gate.execute({ project_root: directory, manifest_path: unit.manifestPath }, { sessionID: "worker" });
      await writeFile(join(directory, "result.txt"), "ready\n");
      await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "worker", callID: "validation" }, { args: { command: "node check.mjs" } });
      await exec(process.execPath, ["check.mjs"], { cwd: directory });
      await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "worker", callID: "validation" }, { output: "PASS", metadata: { exit: 0 } });
      agents.worker!.outcome = "succeeded";
      await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "worker-call" }, { output: "Validated", metadata: { sessionID: "worker" } });
      const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
      const review = async (generation: string) => JSON.parse(await hooks.tool!.sortie_v010_review_mission.execute({
        risk_tags: ["public-logic"], traces: [`Candidate notes ${generation}`],
      }, { sessionID: "root" }));
      const a = await review("A");
      await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "review-call-A" }, { args: a.task });
      await chat("reviewer", a.task.prompt);
      if (mode !== "foreground-current") {
        running = true;
        await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "review-call-A" },
          { output: "Native Reviewer Job running", metadata: { status: "running", sessionID: "reviewer" } });
      }
      let replacement: Awaited<ReturnType<typeof missions.required>>["review"];
      if (mode === "already-replaced") {
        await review("B"); replacement = (await missions.required("root")).review;
      }
      agents.reviewer!.outcome = "succeeded";
      pause = mode === "identity-await" || mode === "history-await";
      const output = { output: report, metadata: { sessionID: "reviewer" } };
      const returned = hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "review-call-A" }, output);
      if (pause) {
        await Promise.race([entered.promise, returned.then(() => { throw new Error("Reviewer completion did not reach the intended await boundary"); })]);
        await review("B"); replacement = (await missions.required("root")).review;
        release.resolve();
      }
      await returned;
      running = false;
      const final = await missions.required("root");
      if (mode === "foreground-current") {
        assert.equal(final.review!.callID, "review-call-A");
        assert.equal(final.review!.verdict, "PASS");
        assert.equal(final.review!.child, "reviewer");
        assert.equal(final.review!.result, report);
      } else {
        assert.equal(replacement!.callID, undefined, "replacement B has not been dispatched");
        assert.deepEqual(final.review, replacement, "A cannot write verdict/result/child/initialPrompt or advisory counts into B");
        assert.equal(final.review!.verdict, "pending");
        assert.doesNotMatch(output.output, /HOST: advisory review notes recorded/);
        await assert.rejects(hooks.tool!.sortie_v010_complete_mission.execute({}, { sessionID: "root" }), /mission-review-required-or-stale/);
      }
      assert.equal(hooks.backgroundOwner!("review-call-A"), undefined, "stale completion still clears its own settled ownership");
      const status = JSON.parse(await hooks.tool!.sortie_v010_operator_status.execute({}, { sessionID: "root" }));
      assert.equal(status.budget.reserved_units, 0);
      assert.equal(status.budget.consumed_units, 1, "the existing Worker accounting is unchanged by either review generation");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
