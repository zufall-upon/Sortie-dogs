import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { SortieDogsV010Plugin } from "../dist/plugin/profiled.js";
import { OperatorMissionRuntime } from "../dist/core/operator-mission.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";

test("background Coordinator: short ack, root idle, unrelated chat, explicit once-only steering and terminal", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/mission-background-"));
  try {
    const steering: Record<string, unknown>[] = [];
    let awaiting = true;
    const session = {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, agent: path.id === "root" ? "dog-operator" : "dogs-coordinator",
        ...(path.id === "root" ? {} : { parentID: "root" }) } }),
      messages: async () => ({ data: [] }),
      children: async () => ({ data: [] }),
      missionSteering: async (request: Record<string, unknown>) => { steering.push(request); return { id: "native-inbox" }; },
    };
    const input = { directory, nativeBackground: { awaiting: async () => awaiting }, client: { session } } as never;
    let hooks = await SortieDogsV010Plugin(input);
    const chat = async (id: string, text: string) => hooks["chat.message"]!({ sessionID: "root", messageID: id, agent: "dog-operator" }, {
      message: { id, agent: "dog-operator", model: { providerID: "openai", modelID: "gpt-6-sol" } }, parts: [{ type: "text", text }],
    });
    await chat("original", "  Fix the original target.\r\nPreserve constraints.  ");
    const packet = JSON.parse(await hooks.tool!.sortie_v010_start_mission.execute({ requirements: ["Fix target", "Preserve constraints"] }, { sessionID: "root" }));
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" }, { args: { ...packet.task, background: true } });
    await hooks["chat.message"]!({ sessionID: "coordinator", messageID: "coordinator-prompt", agent: "dogs-coordinator" }, {
      message: { id: "coordinator-prompt", agent: "dogs-coordinator", model: { providerID: "openai", modelID: "gpt-6-sol" } },
      parts: [{ type: "text", text: packet.task.prompt }],
    });
    const ack = { output: "Job running", metadata: { status: "running", sessionID: "coordinator" } };
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" }, ack);
    assert.equal(ack.output, "Job running");
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "root" } } });
    const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
    const original = await missions.required("root");
    await chat("unrelated", "What is a closure?");
    const afterChat = await missions.required("root");
    assert.deepEqual(afterChat, original, "unrelated real chat neither mutates nor replaces the Mission");
    assert.equal(steering.length, 0);
    const response = { text: "A closure captures its lexical environment." };
    await hooks["experimental.text.complete"]!({ sessionID: "root", messageID: "normal-reply" }, response);
    assert.equal(response.text, "A closure captures its lexical environment.", "normal chat is not a Mission return report");
    await chat("steering", "Continue that target and retain the constraints.");
    const args = { requirements: ["Fix target", "Preserve constraints"], intent: "continue" };
    await hooks.tool!.sortie_v010_start_mission.execute(args, { sessionID: "root" });
    await hooks.tool!.sortie_v010_start_mission.execute(args, { sessionID: "root" });
    assert.equal(steering.length, 1);
    assert.equal(steering[0]!.child, "coordinator");
    assert.match(String(steering[0]!.text), /Continue that target/);
    assert.deepEqual((await missions.required("root")).requests.map(item => item.id), ["original", "steering"]);
    // Process-local profile owners can be restored from the native adapter's durable snapshot.
    const owner = hooks.backgroundOwner!("coordinator-call")!;
    hooks = await SortieDogsV010Plugin(input);
    hooks.backgroundOwner!("coordinator-call", owner);
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "root", callID: "coordinator-call" },
      { output: "Coordinator result", metadata: { sessionID: "coordinator", status: "succeeded" } });
    awaiting = false;
    const final = await missions.required("root");
    assert.equal(final.dispatchOpen, false);
    assert.equal(final.phase, "running", "native success never accepts the Mission");
    assert.equal(final.requests[0]!.text, "  Fix the original target.\r\nPreserve constraints.  ");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
