import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { OperatorMissionRuntime } from "../dist/core/operator-mission.js";
import { RunFlightLedger } from "../dist/core/run-flight-ledger.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";
import { modelLiveState } from "../dist/plugin/model-live-state.js";

const terminal = "SORTIE_FAST_LANE_TERMINAL";
for (const phase of ["open", "running", "submitted", "completed", "cancelled"] as const) {
  test(`Mission lifecycle supersedes one-shot terminal instruction: ${phase}`, async () => {
    await mkdir(resolve("_testenv"), { recursive: true });
    const directory = await mkdtemp(resolve("_testenv/mission-terminal-"));
    try {
      const agents: Record<string, object> = {
        root: { agent: "dog-operator" },
        coordinator: { agent: "dogs-coordinator", parentID: "root" },
      };
      const request = { info: { id: "request", sessionID: "root", role: "user", agent: "dog-operator" },
        parts: [{ type: "text", text: "Continue the original work until its requested boundary; do not stop after consultation." }] };
      const create = () => SortieDogsV010Plugin({ directory, client: { session: {
        get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...agents[path.id] } }),
        messages: async ({ path }: { path: { id: string } }) => ({ data: path.id === "root" ? [request] : [] }),
        children: async () => ({ data: [] }),
      } } } as never);
      let hooks = await create();
      await hooks["chat.message"]!({ sessionID: "root", messageID: "request", agent: "dog-operator" }, {
        message: { id: "request", agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-6.1-sol" } },
        parts: request.parts,
      });
      const advisor = async (callID: string, sessionID = "root") => hooks["tool.execute.before"]!({ tool: "task", sessionID, callID }, {
        args: { subagent_type: "dog-advisor-v010", prompt: "strategy_trigger: material-uncertainty\nQuestion: Compare the known result with remaining work." },
      });
      const transform = async (sessionID = "root", system: string[] = []) => {
        const output = { system };
        await hooks["experimental.chat.system.transform"]!({ sessionID }, output);
        return output.system;
      };
      // Admission hooks only: no native child, Worker, model execution or validation took place.
      await advisor("before-mission");
      const ordinary = await transform();
      assert.ok(ordinary.some(item => item.startsWith(terminal)), "a genuine one-shot consultation retains its terminal policy");
      const native = [{ role: "user", content: "Original request" }];
      const priorProjection = modelLiveState(ordinary, native);
      const started = JSON.parse(await hooks.tool!.sortie_v010_start_mission.execute({ requirements: [request.parts[0]!.text] }, { sessionID: "root" }));
      const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
      if (phase !== "open") {
        await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" }, { args: structuredClone(started.task) });
        await hooks["chat.message"]!({ sessionID: "coordinator", messageID: "coordinator-request", agent: "dogs-coordinator" }, {
          message: { id: "coordinator-request", agent: "dogs-coordinator", model: { providerID: "openai", modelID: "gpt-6.1-sol" } },
          parts: [{ type: "text", text: started.task.prompt }],
        });
        // Select lifecycle branches only; these fixture transitions are not formal completion proof.
        await missions.update("root", state => { state.phase = phase; state.dispatchOpen = phase === "running"; });
      }
      const active = !["completed", "cancelled"].includes(phase);
      const actor = phase === "open" ? "root" : "coordinator";
      if (active) {
        // Recreate the incident directly: a cold active Mission admits advice before
        // any execution run/Worker exists. No earlier one-shot counter is required.
        hooks = await create();
        await advisor("mission-advisor", actor);
      }
      const ledgerPath = join(directory, ".sortie-dogs-v010/run-flight", `${createHash("sha256").update("v010\0root").digest("hex")}.json`);
      const before = await RunFlightLedger.readGoalFile(ledgerPath);
      const missionBefore = await missions.required("root");
      assert.equal(before.state.consumed_units, 0);
      assert.equal(before.state.outstanding_reservations.length, 0);
      assert.deepEqual(before.state.unit_ids, []);
      assert.equal(missionBefore.runID, null, "advice has not planned or admitted an implementation unit");
      const current = await transform("root", [ordinary.find(item => item.startsWith(terminal))!]);
      assert.equal(current.some(item => item === terminal || item.startsWith(terminal + "\n")), !active,
        "only the active Mission lifecycle supersedes the one-shot default, including a stale generated block");
      assert.match(ordinary.find(item => item.startsWith(terminal))!, /not evidence.*user.*limit/i,
        "a plugin default must not be presented as proof of a user-imposed limit");
      assert.ok(current.some(item => item.startsWith("SORTIE_VALIDATION_POLICY")));
      assert.ok(current.some(item => item.startsWith("SORTIE_GOAL_BOUND_STATE")));
      assert.deepEqual(await RunFlightLedger.readGoalFile(ledgerPath), before, "presentation never spends/resets budget or creates a stop/acceptance receipt");
      assert.deepEqual(await missions.required("root"), missionBefore, "presentation cannot change ownership, requests, phase or dispatch");
      if (active) {
        const projection = modelLiveState(current, native, priorProjection.history);
        assert.match(JSON.stringify(projection.messages), /SORTIE_LIVE_STATE_WITHDRAWN.*SORTIE_FAST_LANE_TERMINAL/,
          "the existing V2 live-state projection retires a previously sent one-shot block");
        hooks = await create();
        await advisor("after-reload", actor);
        assert.ok(!(await transform()).some(item => item.startsWith(terminal)), "reload reads the durable Mission without requiring a fresh plan or worker");
        assert.deepEqual(await RunFlightLedger.readGoalFile(ledgerPath), before);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
