import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { observeFrontierHarness, observeGateway } from "../scripts/frontierharness-v2-observe.mjs";

test("root-owned V2 Workers and internal redispatch are observed without claiming formal validation", () => {
  const routes = [{ type: "agent_session", session_id: "coord", agent: "dogs-coordinator", parent_id: "root" },
    ...["w1", "w2", "w3", "w4"].map(id => ({ type: "agent_session", session_id: id, agent: "dog-worker-v010", parent_id: "root" }))];
  const docker = ["w1", "w1", "w2", "w3", "w4"].map(id =>
    ({ type: "docker_exec", agent: "dog-worker-v010", session_id: id, exit_code: id === "w4" ? 1 : 0 }));
  const mission = { root: "root", runID: "run-4", attempts: ["w1", "w2", "w3", "w4"].map((id, i) =>
    ({ childSessionID: id, status: "failed", observedModel: "openai/gpt-6-luna-fast", resultClass: "process-defect", callID: `call-${i}` })) };
  const observation = observeFrontierHarness({ registry: { candidate_plugin_tools_seen: true }, routes, docker,
    events: [{ type: "step_start" }, { type: "step_start" }], mission,
    operator: { runID: "run-4", units: [{ evidence: [] }] } });
  assert.equal(observation.operator_session_observed, false, "a missed root creation event is not invented");
  assert.equal(observation.mission_root_matches_coordinator, true);
  assert.deepEqual(observation.worker_parent_routes, ["operator-root"]);
  assert.equal(observation.worker_docker_route_observed, true);
  assert.equal(observation.worker_dispatches_observed, 4);
  assert.equal(observation.additional_worker_dispatches, 3);
  assert.equal(observation.current_run_formal_evidence_count, 0);
  assert.equal(observation.root_log_step_starts, 2);
  assert.match(observation.usage_scope, /child model requests.*not totaled/u);
  assert.equal(observation.official_verifier, "not assessed by this observer");
});

test("unattributed Docker calls remain unproven without forbidding a later corrected route", () => {
  const base = { registry: null, routes: [{ type: "agent_session", session_id: "coord", agent: "dogs-coordinator", parent_id: "root" },
    { type: "agent_session", session_id: "worker", agent: "dog-worker-v010", parent_id: "coord" }],
    docker: [{ type: "docker_exec", agent: "dog-worker-v010", session_id: "other", exit_code: 0 }], events: [], mission: null, operator: null };
  assert.equal(observeFrontierHarness(base).worker_docker_route_observed, false);
  assert.equal(observeFrontierHarness(base).current_run_formal_evidence_count, null);
  assert.deepEqual(observeFrontierHarness({ ...base, docker: [{ ...base.docker[0], session_id: "worker" }] }).worker_parent_routes,
    ["coordinator"]);
});

test("gateway reader uses the active mission rather than counting archived attempts twice", async () => {
  const root = resolve("_testenv");
  await mkdir(root, { recursive: true });
  const gateway = await mkdtemp(join(root, "fh-observe-"));
  try {
    const missions = join(gateway, ".sortie-dogs-v010", "missions");
    const operators = join(gateway, ".sortie-dogs-v010", "operators");
    await mkdir(missions, { recursive: true });
    await mkdir(operators);
    const file = `${"a".repeat(64)}.json`;
    await writeFile(join(missions, file), JSON.stringify({ runID: "run", attempts: [{ status: "failed", callID: "call", resultClass: "process-defect" }] }));
    await writeFile(join(missions, `${"a".repeat(64)}.mission-old.json`), JSON.stringify({ attempts: Array(50).fill({ status: "failed" }) }));
    await writeFile(join(operators, file), JSON.stringify({ runID: "run", units: [{ evidence: [] }] }));
    const observation = await observeGateway(gateway);
    assert.equal(observation.worker_dispatches_observed, 1);
    assert.equal(observation.current_run_formal_evidence_count, 0);
    assert.equal(observation.worker_docker_route_observed, false);
  } finally { await rm(gateway, { recursive: true, force: true }); }
});
