import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { main, verifyCycle } from "../scripts/swebench-lite-verify-cycle.mjs";
import { writeAtomicJson } from "../scripts/swebench-lite-supervisor.mjs";

test("cycle CLI is standalone and requires only its receipt, not a controller config", async () => {
  await assert.rejects(main([]), /usage: swebench-lite-verify-cycle/);
  await assert.rejects(main(["--config", "host-only-project.json"]), /usage: swebench-lite-verify-cycle/);
});

test("a practical response-only probe cannot verify a dev23 cycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-cycle-test-"));
  try {
    const receipt = join(root, "receipt.json");
    const file = join(root, "empty.json");
    await writeFile(file, JSON.stringify({ candidate: { sha256: "not-the-actual-package" } }));
    await writeFile(receipt, JSON.stringify({ manifest: file, supervisor: file, scoring: file,
      practical: { observation: file }, package: file, package_sha256: "not-the-actual-package" }));
    await assert.rejects(main(["--receipt", receipt]), /cycle-candidate-mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cycle verification binds official predictions, a real original CLI task, and Git main ancestry", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-cycle-test-"));
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git(["init", "-q", "-b", "main"]);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "initial"]);
    const commit = git(["rev-parse", "HEAD"]);
    git(["update-ref", "refs/remotes/origin/main", commit]);
    const packagePath = join(root, "candidate.tgz");
    await writeFile(packagePath, "candidate package bytes");
    const packageHash = digest("candidate package bytes");
    const manifestPath = join(root, "manifest.json"), supervisorPath = join(root, "supervisor.json");
    const scoringPath = join(root, "scoring.json"), practicalPath = join(root, "observation.json");
    const predictionPath = join(root, "predictions.jsonl"), taskPath = join(root, "original-task.txt"), log = join(root, "validation.log");
    const publicLock = JSON.parse(await readFile("scripts/swebench-lite-public-lock.json", "utf8"));
    const ids = Object.keys(publicLock.splits.dev.rows);
    const manifest = { dataset: { id: "princeton-nlp/SWE-bench_Lite", revision: "6ec7bb89b9342f664a54a6e0a6ea6501d3437cc2", split: "dev" },
      candidate: { sha256: packageHash, runtime_marker: "fixed-marker", version: "fixed-version" }, instances: ids.map(instance_id => ({ instance_id })) };
    const supervisor = { manifest: manifestPath, input_sha256: digest(JSON.stringify(manifest)), status: "completed",
      policy: { attempts_per_instance: 1, retry_count: 0 }, instances: ids.map(instance_id => ({ instance_id, attempt: 1 })),
      limits: { workers: 8, per_instance_usd: 2, cost_limit_usd: 46, timeout_seconds: 2400, prepared_environment: "official-image-testbed" } };
    const predictions = ids.map(instance_id => ({ instance_id, model_patch: "a frozen actual patch\n" }));
    const scoring = { status: "completed", split: "dev", max_workers: 1, retry_count: 0, supervisor_state: supervisorPath, last_harness: { exit_code: 0 },
      graded: Object.fromEntries(ids.map(id => [id, { patch_sha256: digest("a frozen actual patch\n"), result: { resolved: id === ids[0] } }])) };
    const practical = { candidate_sha256: packageHash, mode: "complete", accepted: true, mission_phase: "completed", receipt_status: "succeeded",
      code: 0, stopped: false, root: "practical-root", instance: { repo: "real/repo", base_commit: commit }, task_sha256: digest("original development task"),
      runtime_marker: "fixed-marker", package_version: "fixed-version",
      models: [{ agent: "dog-worker-v010", model: { providerID: "openai", id: "gpt-6-luna-fast", variant: "max" } }] };
    await Promise.all([writeAtomicJson(manifestPath, manifest), writeAtomicJson(supervisorPath, supervisor),
      writeAtomicJson(scoringPath, scoring), writeAtomicJson(practicalPath, practical),
      writeFile(predictionPath, predictions.map(item => JSON.stringify(item)).join("\n") + "\n"),
      writeFile(taskPath, "original development task"), writeFile(log, "canonical check passed")]);
    const runnerScripts = ["scripts/swebench-lite-runner.mjs", "scripts/swebench-lite-supervisor.mjs", "scripts/swebench-lite-grader.mjs",
      "scripts/swebench-model-cost.mjs", "scripts/release-cli.mjs"];
    for (const script of runnerScripts) await writeAtomicJson(join(root, script), { fixture: script });
    const runnerHashes = Object.fromEntries(await Promise.all(runnerScripts.map(async script =>
      [script, digest(await readFile(join(root, script), "utf8"))])));
    const receipt = { manifest: manifestPath, supervisor: supervisorPath, scoring: scoringPath, package: packagePath, package_sha256: packageHash,
      runtime_marker: "fixed-marker", runner_root: root, runner_sha256: runnerHashes,
      manifest_sha256: digest(await readFile(manifestPath, "utf8")), predictions: predictionPath, predictions_sha256: digest(await readFile(predictionPath, "utf8")),
      source_repo: root, commit, main_commit: commit, runner_commit: commit, main_integrated: true,
      practical: { observation: practicalPath, task: taskPath, repo: "real/repo", base_commit: commit,
        verification: [{ command: "canonical test", exit: 0, log, log_sha256: digest("canonical check passed") }] } };
    const receiptPath = join(root, "cycle.json");
    await writeAtomicJson(receiptPath, receipt);
    assert.equal((await main(["--receipt", receiptPath])).total, 23);
    await writeAtomicJson(practicalPath, { ...practical, mode: "start" });
    await assert.rejects(verifyCycle(receiptPath), /practical-session-not-accepted/);
    await writeAtomicJson(practicalPath, { ...practical, instance: null });
    await assert.rejects(verifyCycle(receiptPath), /original-task-required/);
    await writeAtomicJson(practicalPath, practical);
    await writeFile(taskPath, "substituted seed-file task");
    await assert.rejects(verifyCycle(receiptPath), /original-task-required/);
    await writeFile(taskPath, "original development task");
    await writeAtomicJson(scoringPath, { ...scoring, max_workers: 2 });
    await assert.rejects(verifyCycle(receiptPath), /comparison-conditions/);
    await writeAtomicJson(scoringPath, scoring);
    await writeAtomicJson(practicalPath, { ...practical, models: [{ agent: "dog-worker-v010", model: { ...practical.models[0].model, providerID: "other" } }] });
    await assert.rejects(verifyCycle(receiptPath), /practical-session-not-accepted/);
    await writeAtomicJson(practicalPath, practical);
    await writeAtomicJson(receiptPath, { ...receipt, runner_commit: "not-the-actual-commit" });
    await assert.rejects(verifyCycle(receiptPath), /runner-commit/);
    await writeAtomicJson(receiptPath, receipt);
    await writeFile(predictionPath, "changed after scoring");
    await assert.rejects(verifyCycle(receiptPath), /frozen-artifacts/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
