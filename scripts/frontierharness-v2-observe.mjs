import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rows = text => text.split(/\r?\n/u).filter(Boolean).flatMap(line => {
  try { const row = JSON.parse(line); return row && typeof row === "object" && !Array.isArray(row) ? [row] : []; }
  catch { return []; }
});

/** This describes observed V2 activity, not formal acceptance or an official verifier result. */
export function observeFrontierHarness({ registry, routes, docker, events, mission, operator }) {
  const sessions = routes.filter(row => row.type === "agent_session" && typeof row.session_id === "string");
  const coordinators = sessions.filter(row => row.agent === "dogs-coordinator" && typeof row.parent_id === "string");
  const operators = new Set(sessions.filter(row => row.agent === "dog-operator" && row.parent_id === null)
    .map(row => row.session_id));
  const roots = new Set(coordinators.map(row => row.parent_id));
  const workers = sessions.filter(row => row.agent === "dog-worker-v010" &&
    coordinators.some(coordinator => row.parent_id === coordinator.session_id ||
      (row.parent_id === coordinator.parent_id && roots.has(row.parent_id))));
  const workerIDs = new Set(workers.map(row => row.session_id));
  const calls = docker.filter(row => row.type === "docker_exec");
  const attributed = calls.filter(row => row.agent === "dog-worker-v010" && workerIDs.has(row.session_id));
  const attempts = (mission?.attempts ?? []).filter(attempt => attempt.status !== "pending" &&
    (typeof attempt.callID === "string" || typeof attempt.childSessionID === "string"));
  const models = [...new Set(attempts.map(attempt => attempt.observedModel).filter(Boolean))].sort();
  const currentEvidence = operator && mission && operator.runID === mission.runID
    ? operator.units?.reduce((sum, unit) => sum + (unit.evidence?.length ?? 0), 0) ?? null : null;
  const rootSteps = events.filter(event => event.type === "step_start").length;
  return {
    candidate_tools_observed: registry?.candidate_plugin_tools_seen === true,
    operator_session_observed: [...operators].some(id => roots.has(id)),
    mission_root_matches_coordinator: typeof mission?.root === "string"
      ? coordinators.some(coordinator => coordinator.parent_id === mission.root) : null,
    coordinator_sessions_observed: coordinators.length,
    worker_sessions_observed: workers.length,
    worker_parent_routes: [...new Set(workers.map(worker => coordinators.some(coordinator =>
      coordinator.session_id === worker.parent_id) ? "coordinator" : "operator-root"))].sort(),
    worker_docker_route_observed: calls.length > 0 && calls.length === attributed.length,
    docker_tool_calls: calls.length,
    docker_tool_nonzero_exits: calls.filter(call => call.exit_code !== 0).length,
    worker_dispatches_observed: attempts.length,
    additional_worker_dispatches: Math.max(0, attempts.length - 1),
    worker_models_observed: models,
    worker_process_defects: attempts.filter(attempt => attempt.resultClass === "process-defect").length,
    current_run_formal_evidence_count: currentEvidence,
    root_log_step_starts: rootSteps,
    usage_scope: "root JSONL only; child model requests and subscription charges are not totaled",
    official_verifier: "not assessed by this observer",
  };
}

async function optionalJSON(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function optionalRows(path) {
  try { return rows(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

export async function observeGateway(gateway) {
  const missionDir = join(gateway, ".sortie-dogs-v010", "missions");
  let files;
  try { files = (await readdir(missionDir)).filter(file => /^[a-f0-9]{64}\.json$/u.test(file)); }
  catch (error) { if (error.code !== "ENOENT") throw error; files = []; }
  if (files.length > 1) throw new Error("multiple mission roots: select a single-task gateway");
  const mission = files[0] ? await optionalJSON(join(missionDir, files[0])) : null;
  const operator = files[0] ? await optionalJSON(join(gateway, ".sortie-dogs-v010", "operators", files[0])) : null;
  return observeFrontierHarness({
    registry: await optionalJSON(join(gateway, "docker-tool-registry.json")),
    routes: await optionalRows(join(gateway, "sortie-agent-route-audit.ndjson")),
    docker: await optionalRows(join(gateway, "docker-exec-audit.ndjson")),
    events: await optionalRows(join(gateway, "opencode.jsonl")), mission, operator,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.length !== 3) {
    console.error("usage: node scripts/frontierharness-v2-observe.mjs <gateway-directory>");
    process.exitCode = 2;
  } else {
    observeGateway(process.argv[2]).then(observation => console.log(JSON.stringify(observation, null, 2)), error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
