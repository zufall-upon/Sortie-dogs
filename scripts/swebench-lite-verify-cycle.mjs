#!/usr/bin/env node
// Benchmark-specific verification; scheduling and notification belong to the host.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const sha = value => createHash("sha256").update(value).digest("hex");
const json = async path => JSON.parse(await readFile(path, "utf8"));
const ensure = (ok, message) => { if (!ok) throw Error(message); };
const exec = promisify(execFile);

export async function verifyCycle(path) {
  const receipt = await json(path);
  const [manifest, supervisor, scoring, practical] = await Promise.all([
    json(receipt.manifest), json(receipt.supervisor), json(receipt.scoring), json(receipt.practical.observation),
  ]);
  const packageHash = sha(await readFile(receipt.package));
  ensure(packageHash === receipt.package_sha256 && packageHash === manifest.candidate.sha256 &&
    practical.candidate_sha256 === packageHash,
  "cycle-candidate-mismatch");
  ensure(supervisor.manifest === receipt.manifest && supervisor.input_sha256 === sha(JSON.stringify(manifest)),
    "cycle-supervisor-manifest-mismatch");
  const ids = manifest.instances.map(item => item.instance_id);
  const publicLock = await json(new URL("./swebench-lite-public-lock.json", import.meta.url));
  const canonicalIds = Object.keys(publicLock.splits.dev.rows);
  ensure(manifest.dataset.id === publicLock.dataset.id && manifest.dataset.revision === publicLock.dataset.revision &&
    manifest.dataset.split === "dev" && ids.length === 23 && new Set(ids).size === 23 &&
    ids.every(id => canonicalIds.includes(id)),
    "cycle-requires-23-distinct-dev-cases");
  ensure(supervisor.status === "completed" && supervisor.policy.attempts_per_instance === 1 &&
    supervisor.policy.retry_count === 0 && supervisor.instances.length === 23 &&
    supervisor.instances.every((item, index) => item.instance_id === ids[index] && item.attempt === 1), "cycle-inference-incomplete");
  ensure(scoring.status === "completed" && ids.every(id => scoring.graded?.[id]?.result &&
    typeof scoring.graded[id].result.resolved === "boolean"), "cycle-official-score-incomplete");
  ensure(scoring.split === "dev" && scoring.max_workers === 1 && scoring.retry_count === 0 &&
    supervisor.limits.workers === 8 && supervisor.limits.per_instance_usd === 2 &&
    supervisor.limits.cost_limit_usd === 46 && supervisor.limits.timeout_seconds === 2400 &&
    supervisor.limits.prepared_environment === "official-image-testbed", "cycle-comparison-conditions-mismatch");
  ensure(scoring.supervisor_state === receipt.supervisor && scoring.last_harness?.exit_code === 0 &&
    sha(await readFile(receipt.manifest)) === receipt.manifest_sha256 &&
    sha(await readFile(receipt.predictions)) === receipt.predictions_sha256,
  "cycle-frozen-artifacts-unconfirmed");
  const predictions = (await readFile(receipt.predictions, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  ensure(predictions.length === 23 && predictions.every((item, index) => item.instance_id === ids[index] &&
    typeof item.model_patch === "string" && sha(item.model_patch) === scoring.graded[item.instance_id].patch_sha256),
  "cycle-scored-prediction-mismatch");
  ensure(practical.mode === "complete" && practical.accepted === true && practical.mission_phase === "completed" &&
    practical.receipt_status === "succeeded" && practical.code === 0 && practical.stopped === false &&
    practical.models?.some(item => item.agent === "dog-worker-v010" && item.model?.providerID === "openai" &&
      item.model.id === "gpt-6-luna-fast" && item.model.variant === "max"),
  "cycle-practical-session-not-accepted");
  ensure(receipt.runtime_marker && receipt.runtime_marker === manifest.candidate.runtime_marker &&
    practical.runtime_marker === receipt.runtime_marker && practical.package_version === manifest.candidate.version,
  "cycle-runtime-identity-mismatch");
  ensure(receipt.practical.task && receipt.practical.repo && receipt.practical.base_commit &&
    receipt.practical.verification?.length && practical.instance?.repo === receipt.practical.repo &&
    practical.instance?.base_commit === receipt.practical.base_commit &&
    practical.task_sha256 === sha(await readFile(receipt.practical.task)), "cycle-practical-original-task-required");
  for (const check of receipt.practical.verification) {
    ensure(typeof check.command === "string" && check.command && check.exit === 0 &&
      check.log_sha256 === sha(await readFile(check.log)), "cycle-practical-verification-incomplete");
  }
  ensure(receipt.commit && receipt.runner_commit && receipt.main_integrated === true && receipt.source_repo && receipt.main_commit,
    "cycle-main-integration-unconfirmed");
  await exec("git", ["merge-base", "--is-ancestor", receipt.commit, receipt.main_commit], { cwd: receipt.source_repo });
  await exec("git", ["merge-base", "--is-ancestor", receipt.main_commit, "origin/main"], { cwd: receipt.source_repo });
  ensure(receipt.runner_root && (await exec("git", ["rev-parse", "HEAD"], { cwd: receipt.runner_root })).stdout.trim() === receipt.runner_commit,
    "cycle-runner-commit-mismatch");
  for (const script of ["scripts/swebench-lite-runner.mjs", "scripts/swebench-lite-supervisor.mjs",
    "scripts/swebench-lite-grader.mjs", "scripts/swebench-model-cost.mjs", "scripts/release-cli.mjs"]) {
    ensure(receipt.runner_sha256?.[script] === sha(await readFile(join(receipt.runner_root, script))), "cycle-runner-source-mismatch");
  }
  return { action: "cycle-verified", package_sha256: packageHash, commit: receipt.commit,
    resolved: ids.filter(id => scoring.graded[id].result.resolved), total: 23,
    practical_session: practical.root, guarantee: "observed task/candidate only, not universal correctness" };
}

export async function main(args = process.argv.slice(2)) {
  ensure(args.length === 2 && args[0] === "--receipt" && args[1], "usage: swebench-lite-verify-cycle.mjs --receipt <path>");
  return verifyCycle(resolve(args[1]));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await main(), null, 2)); }
  catch (error) { console.error(JSON.stringify({ action: "error", reason: error.message })); process.exitCode = 1; }
}
