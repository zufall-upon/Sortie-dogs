import assert from "node:assert/strict";
import test from "node:test";

import {
  ALLOW_FIXTURE,
  COMPLETION_FIXTURE,
  DENY_FIXTURE,
  HOST_CAPABILITIES,
  HOST_CONFORMANCE_VERSION,
  type HostConformanceSubject,
  allow,
  completionIdentity,
  deny,
  modelIdentity,
  replayDisposition,
  sessionIdentity,
  toolIdentity,
  workerIdentity,
} from "../dist/plugin/host-conformance.js";
import { CONTINUATION_CAPABILITY } from "../dist/plugin/continuation.js";
import { SortieDogsPlugin } from "../dist/plugin/index.js";

function replaySubject(): HostConformanceSubject {
  const sessions = new Map<string, string>();
  const workers = new Map<string, string>();
  return {
    capabilities: HOST_CAPABILITIES,
    tool: { invoke: async (identity, payload) => identity.sessionID === "ses_child" ? deny(DENY_FIXTURE.reason) : allow() },
    session: {
      identity: async (sessionID) => sessionID === COMPLETION_FIXTURE.root.sessionID ? COMPLETION_FIXTURE.root : sessionID === COMPLETION_FIXTURE.child.sessionID ? COMPLETION_FIXTURE.child : undefined,
      complete: async (identity, payload) => { const key = JSON.stringify(identity); const result = replayDisposition(sessions.get(key), payload); if (result === "first") sessions.set(key, payload); return result; },
    },
    worker: { complete: async (identity, payload) => { const key = JSON.stringify(identity); const result = replayDisposition(workers.get(key), payload); if (result === "first") workers.set(key, payload); return result; } },
    continuation: { resume: async (_sessionID, parentSessionID) => parentSessionID === undefined ? allow() : deny("child-session") },
    model: { inspect: async (identity) => ({ identity, available: identity.providerID === "openai" && identity.modelID === "gpt-5.6-terra" }) },
  };
}

async function runConformance(name: string, make: () => HostConformanceSubject | Promise<HostConformanceSubject>): Promise<void> {
  await test(name, async () => {
    const subject = await make();
    assert.equal(subject.capabilities.version, HOST_CONFORMANCE_VERSION);
    assert.deepEqual(subject.capabilities.tools, ["task", "sortie_compact_and_continue"]);
    assert.deepEqual(subject.capabilities.identities, {
      session: "sessionID + optional agent + optional parentID + explicit parentPresent",
      tool: "sessionID + callID",
      worker: "parentSessionID + callID + childSessionID",
      completion: "sessionID + messageID + optional partID",
      model: "providerID + modelID",
    });
    assert.deepEqual(subject.capabilities.replay, { exact: "idempotent", conflict: "denied" });
    assert.deepEqual(subject.capabilities.continuation, { rootOnly: true, sameRoot: true });
    assert.equal(Object.isFrozen(subject.capabilities), true);
    assert.equal(Object.isFrozen(subject.capabilities.tools), true);
    assert.equal(Object.isFrozen(ALLOW_FIXTURE), true);
    assert.equal(Object.isFrozen(DENY_FIXTURE), true);
    assert.equal(Object.isFrozen(COMPLETION_FIXTURE), true);
    assert.deepEqual(toolIdentity("ses_root", "call_allow"), ALLOW_FIXTURE.tool);
    assert.deepEqual(workerIdentity("ses_root", "call_1", "ses_child"), COMPLETION_FIXTURE.worker.identity);
    assert.deepEqual(completionIdentity("ses_root", "msg_1", "part_1"), COMPLETION_FIXTURE.part.identity);
    assert.deepEqual(modelIdentity("openai", "gpt-5.6-terra"), { providerID: "openai", modelID: "gpt-5.6-terra" });
    assert.deepEqual(subject.capabilities.ports, { tool: true, session: true, worker: true, continuation: true, model: true });
    assert.deepEqual(await subject.session.identity("ses_root"), COMPLETION_FIXTURE.root);
    assert.deepEqual(await subject.session.identity("ses_child"), COMPLETION_FIXTURE.child);
    assert.equal((await subject.session.identity("ses_child"))?.parentPresent, true);
    assert.equal((await subject.session.identity("ses_root"))?.parentPresent, false);
    assert.deepEqual(await subject.tool.invoke(ALLOW_FIXTURE.tool, ALLOW_FIXTURE.payload), { decision: "allow" });
    assert.deepEqual(await subject.tool.invoke(DENY_FIXTURE.tool, DENY_FIXTURE.payload), { decision: "deny", reason: DENY_FIXTURE.reason });
    assert.equal(await subject.session.complete(COMPLETION_FIXTURE.session.identity, COMPLETION_FIXTURE.session.payload), "first");
    assert.equal(await subject.session.complete(COMPLETION_FIXTURE.session.identity, COMPLETION_FIXTURE.session.payload), "exact-replay");
    assert.equal(await subject.session.complete(COMPLETION_FIXTURE.session.identity, "changed"), "conflict");
    assert.equal(await subject.worker.complete(COMPLETION_FIXTURE.worker.identity, COMPLETION_FIXTURE.worker.payload), "first");
    assert.equal(await subject.worker.complete(COMPLETION_FIXTURE.worker.identity, COMPLETION_FIXTURE.worker.payload), "exact-replay");
    assert.equal(await subject.worker.complete(COMPLETION_FIXTURE.worker.identity, "changed-worker"), "conflict");
    assert.deepEqual(await subject.continuation.resume("ses_root"), { decision: "allow" });
    assert.deepEqual(await subject.continuation.resume("ses_child", "ses_root"), { decision: "deny", reason: "child-session" });
    assert.deepEqual(await subject.model.inspect(modelIdentity("openai", "gpt-5.6-terra")), { identity: modelIdentity("openai", "gpt-5.6-terra"), available: true });
    assert.equal((await subject.model.inspect(modelIdentity("missing", "model"))).available, false);
  });
}

await runConformance("reference host satisfies the conformance contract", replaySubject);

await runConformance("OpenCode continuation/session seams compose with the conformance contract", async () => {
  const fakeClient = {
    session: {
      get: async (request: { path: { id: string } }) => ({ data: request.path.id === "ses_child" ? { agent: "dog-worker", parentID: "ses_root" } : { agent: "dog-coordinator" } }),
      summarize: async () => ({ data: true }),
      promptAsync: async () => ({ data: true }),
    },
    config: {
      providers: async () => ({ data: { providers: [{ id: "fake", models: { compact: { id: "compact" } } }] } }),
    },
  };
  const hooks = await SortieDogsPlugin(
    { directory: process.cwd(), client: fakeClient },
    {
      continuation: { summarizeModel: { model: "fake/compact" } },
      modelRouting: { "dog-coordinator": { preferred: { model: "fake/compact" } } },
      modelCatalog: { global: [{ model: "fake/compact" }] },
    },
  );
  const continuation = hooks.tool?.[CONTINUATION_CAPABILITY];
  assert.ok(continuation);
  const rootInput = { sessionID: "ses_root", agent: "dog-coordinator" };
  const rootOutput = { message: { agent: "dog-coordinator", model: { providerID: "fake", modelID: "compact" } }, parts: [{ type: "text", text: "root" }] };
  await hooks["chat.message"]!(rootInput, rootOutput);
  await assert.rejects(
    () => hooks["chat.message"]!(
      { sessionID: "ses_child", parentID: "ses_root", agent: "dog-coordinator" },
      { message: { agent: "dog-coordinator", model: { providerID: "fake", modelID: "compact" } }, parts: [{ type: "text", text: "child" }] },
    ),
    /SORTIE_FRESH_SESSION_REQUIRED: \/sortie cannot promote a child session/u,
  );
  const base = replaySubject();
  return {
    ...base,
    session: {
      ...base.session,
      identity: async (sessionID) => {
        const response = await fakeClient.session.get({ path: { id: sessionID } });
        const value = response.data;
        return sessionIdentity(sessionID, { agent: value.agent, ...(value.parentID === undefined ? {} : { parentID: value.parentID }), parentPresent: value.parentID !== undefined });
      },
    },
    continuation: {
      resume: async (sessionID, parentSessionID) => {
        if (parentSessionID !== undefined) return deny("child-session");
        try {
          const result = await continuation.execute({}, { sessionID, agent: "dog-coordinator" });
          return result === "SORTIE_COMPACT_AND_CONTINUE_QUEUED" ? allow() : deny(result);
        } catch (error) {
          return deny(error instanceof Error ? error.message : String(error));
        }
      },
    },
  };
});
