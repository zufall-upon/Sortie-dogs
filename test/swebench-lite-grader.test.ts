import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  OFFICIAL_SCORING_BOUNDARY,
  OFFICIAL_SCORING_MAX_WORKERS,
  OFFICIAL_SCORING_SPLIT,
  createCompletedSnapshot,
  createOfficialHarnessRequest,
  runOfficialHarness,
  runIncrementalGrader,
} from "../scripts/swebench-lite-grader.mjs";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

const manifest = {
  schema_version: 1,
  dataset: { id: "princeton-nlp/SWE-bench_Lite", revision: "pinned", split: "dev" },
  instances: [
    { instance_id: "example__project-1", repo: "example/project", base_commit: "a".repeat(40), problem_statement: "one" },
    { instance_id: "example__project-2", repo: "example/project", base_commit: "b".repeat(40), problem_statement: "two" },
  ],
};

function stateFor(root: string, firstPatch = "diff --git a/one b/one\n") {
  const firstOutput = join(root, "first.predictions.jsonl");
  const secondOutput = join(root, "second.predictions.jsonl");
  return {
    schema_version: 1,
    run_id: "run-grader-test",
    status: "running",
    model_name_or_path: "candidate",
    instances: [
      {
        index: 0,
        instance_id: "example__project-1",
        status: "succeeded",
        attempt: 1,
        runner: null,
        child_output: firstOutput,
        result: { instance_id: "example__project-1", status: "succeeded", patch_sha256: hash(firstPatch) },
      },
      {
        index: 1,
        instance_id: "example__project-2",
        status: "running",
        attempt: 1,
        runner: { pid: 1, starttime: null },
        child_output: secondOutput,
        result: null,
      },
    ],
  };
}

async function writeStateFixture(root: string, state: Record<string, unknown>, patch = "diff --git a/one b/one\n") {
  const firstOutput = join(root, "first.predictions.jsonl");
  await writeFile(firstOutput, `${JSON.stringify({ instance_id: "example__project-1", model_name_or_path: "candidate", model_patch: patch })}\n`);
  const statePath = join(root, "supervisor-state.json");
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return statePath;
}

test("completed snapshot excludes pending/running entries and binds the candidate patch hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-grader-snapshot-"));
  try {
    const state = stateFor(root);
    await writeStateFixture(root, state);
    const snapshot = await createCompletedSnapshot(state, { manifest });
    assert.deepEqual(snapshot.instances.map(item => item.instance_id), ["example__project-1"]);
    assert.equal(snapshot.instances[0]!.patch_sha256, hash("diff --git a/one b/one\n"));
    assert.equal(Object.hasOwn(snapshot.instances[0]!.instance, "patch"), false);
    assert.equal(snapshot.instances[0]!.prediction.model_patch, "diff --git a/one b/one\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("official harness request is fixed to dev and one worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-grader-contract-"));
  try {
    const state = stateFor(root);
    await writeStateFixture(root, state);
    const snapshot = await createCompletedSnapshot(state, { manifest });
    const request = createOfficialHarnessRequest(snapshot);
    assert.equal(request.schema_version, 1);
    assert.equal(request.mode, "official-docker-scoring");
    assert.equal(request.split, OFFICIAL_SCORING_SPLIT);
    assert.equal(request.max_workers, OFFICIAL_SCORING_MAX_WORKERS);
    assert.equal(request.official_scoring_boundary, OFFICIAL_SCORING_BOUNDARY);
    assert.equal(request.retry_count, 0);
    assert.equal(request.instances.length, 1);
    assert.equal(request.predictions.length, 1);
    assert.equal(request.predictions[0]!.instance_id, "example__project-1");
    assert.throws(() => createOfficialHarnessRequest(snapshot, { split: "test" }), /grader-split-required/);
    assert.throws(() => createOfficialHarnessRequest(snapshot, { max_workers: 2 }), /grader-max-workers-required/);
    assert.equal(JSON.stringify(request).includes("test_patch"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("official harness receives the generated prediction path and runs from its scoring root", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-grader-launch-"));
  try {
    const predictionPath = join(root, "scoring-predictions.jsonl");
    const runner = join(root, "fake-official-harness");
    await writeFile(predictionPath, "{}\n");
    await writeFile(runner, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n");
    await chmod(runner, 0o755);
    const result = await runOfficialHarness({ split: "dev", max_workers: 1 }, {
      executable: runner,
      predictionPath,
      runRoot: root,
    });
    assert.equal(result.exit_code, 0);
    assert.equal(result.cwd, root);
    assert.deepEqual(result.argv.slice(-2), ["--predictions_path", predictionPath]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("incremental grading passes its generated prediction file to the real launcher path", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-grader-default-launch-"));
  try {
    const state = stateFor(root);
    const statePath = await writeStateFixture(root, state);
    const runner = join(root, "fake-official-harness");
    const capturePath = join(root, "invocation.json");
    const source = [
      "#!/usr/bin/env node",
      'import { readFileSync, writeFileSync } from "node:fs";',
      'const args = process.argv.slice(2);',
      'const predictionPath = args[args.indexOf("--predictions_path") + 1];',
      'const predictions = readFileSync(predictionPath, "utf8").trim().split(/\\r?\\n/u).map(JSON.parse);',
      `writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ cwd: process.cwd(), predictionPath, predictions }));`,
      'process.stdout.write(JSON.stringify({ results: predictions.map(item => ({ instance_id: item.instance_id, status: "scored", resolved: false, patch_successfully_applied: false, infra_failure: false })) }));',
      "",
    ].join("\n");
    await writeFile(runner, source);
    await chmod(runner, 0o755);

    const result = await runIncrementalGrader({
      supervisorStatePath: statePath,
      runRoot: root,
      manifest,
      harnessExecutable: runner,
    });
    assert.equal(result.started, true);
    assert.equal(result.results.length, 1);
    const invocation = JSON.parse(await readFile(capturePath, "utf8"));
    assert.equal(invocation.cwd, root);
    assert.equal(invocation.predictionPath, join(root, "scoring-predictions.jsonl"));
    assert.deepEqual(invocation.predictions.map((item: { instance_id: string }) => item.instance_id), ["example__project-1"]);
    const liveRows = (await readFile(join(root, "live-results.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(liveRows[0]!.result.infra_failure, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one grader is coalesced, scores completed instances only, and leaves inference running", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-grader-run-"));
  let harnessCalls = 0;
  try {
    const state = stateFor(root);
    const statePath = await writeStateFixture(root, state);
    const runHarness = async (request: { split: string; max_workers: number; instances: Array<{ instance_id: string }> }) => {
      harnessCalls += 1;
      assert.equal(request.split, "dev");
      assert.equal(request.max_workers, 1);
      assert.deepEqual(request.instances.map(item => item.instance_id), ["example__project-1"]);
      await new Promise(resolve => setTimeout(resolve, 10));
      return { exit_code: 0, results: [{ instance_id: "example__project-1", resolved: true, score: 1 }] };
    };
    const options = { supervisorStatePath: statePath, runRoot: root, manifest };
    const first = runIncrementalGrader(options, { runHarness });
    const second = runIncrementalGrader(options, { runHarness });
    assert.strictEqual(first, second);
    const result = await first;
    assert.equal(harnessCalls, 1);
    assert.equal(result.started, true);
    assert.equal(result.inference_running, true);
    assert.deepEqual(result.results.map(item => item.instance_id), ["example__project-1"]);
    const unchangedInferenceState = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(unchangedInferenceState.instances[1].status, "running");
    const scoringState = JSON.parse(await readFile(join(root, "scoring-state.json"), "utf8"));
    assert.equal(scoringState.schema_version, 1);
    assert.equal(scoringState.status, "completed");
    assert.equal(scoringState.split, "dev");
    assert.equal(scoringState.max_workers, 1);
    assert.equal(scoringState.retry_count, 0);
    assert.deepEqual(scoringState.completed_instance_ids, ["example__project-1"]);
    assert.deepEqual(scoringState.graded_instance_ids, ["example__project-1"]);
    assert.deepEqual(scoringState.active_instance_ids, []);
    const liveResults = (await readFile(join(root, "live-results.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(liveResults.map(item => item.instance_id), ["example__project-1"]);
    assert.equal(JSON.parse(await readFile(join(root, "scoring-state.json"), "utf8")).max_workers, 1);
    assert.match(await readFile(join(root, "scoring.log"), "utf8"), /grader-started/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grader resume is incremental and does not score the same patch twice", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-grader-resume-"));
  let harnessCalls = 0;
  try {
    const state = stateFor(root);
    const statePath = await writeStateFixture(root, state);
    const runHarness = async (request: { instances: Array<{ instance_id: string }> }) => {
      harnessCalls += 1;
      return { exit_code: 0, results: request.instances.map(item => ({ instance_id: item.instance_id, resolved: true })) };
    };
    const options = { supervisorStatePath: statePath, runRoot: root, manifest };
    await runIncrementalGrader(options, { runHarness });
    const resumed = await runIncrementalGrader(options, { runHarness });
    assert.equal(resumed.started, false);
    assert.equal(harnessCalls, 1);

    const secondPatch = "diff --git a/two b/two\n";
    await writeFile(join(root, "second.predictions.jsonl"), `${JSON.stringify({
      instance_id: "example__project-2", model_name_or_path: "candidate", model_patch: secondPatch,
    })}\n`);
    const changed = JSON.parse(await readFile(statePath, "utf8"));
    changed.instances[1].status = "succeeded";
    changed.instances[1].runner = null;
    changed.instances[1].finished_at = "2026-09-20T00:00:00.000Z";
    changed.instances[1].result = { instance_id: "example__project-2", status: "succeeded", patch_sha256: hash(secondPatch) };
    await writeFile(statePath, `${JSON.stringify(changed, null, 2)}\n`);
    const next = await runIncrementalGrader(options, { runHarness });
    assert.equal(next.started, true);
    assert.equal(harnessCalls, 2);
    assert.deepEqual(next.request!.instances.map(item => item.instance_id), ["example__project-2"]);
    const liveResults = (await readFile(join(root, "live-results.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(liveResults.map(item => item.instance_id), ["example__project-1", "example__project-2"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("patch mutation fails closed before the official harness is called", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-grader-hash-"));
  let harnessCalls = 0;
  try {
    const original = "diff --git a/one b/one\n";
    const state = stateFor(root, original);
    const statePath = await writeStateFixture(root, state, "diff --git a/tampered b/tampered\n");
    await assert.rejects(runIncrementalGrader({ supervisorStatePath: statePath, runRoot: root, manifest }, {
      runHarness: async () => { harnessCalls += 1; return { exit_code: 0 }; },
    }), /patch-hash-mismatch/);
    assert.equal(harnessCalls, 0);
    await assert.rejects(stat(join(root, "live-results.jsonl")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hidden solution fields are never accepted into the scoring request", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-grader-hidden-"));
  try {
    const state = stateFor(root);
    const statePath = await writeStateFixture(root, state);
    const hiddenManifest = { ...manifest, instances: [{ ...manifest.instances[0], patch: "gold" }] };
    await assert.rejects(createCompletedSnapshot(state, { manifest: hiddenManifest }), /hidden-instance-field:patch/);
    await assert.rejects(runIncrementalGrader({ supervisorStatePath: statePath, runRoot: root, manifest: hiddenManifest }, {
      runHarness: async () => ({ exit_code: 0 }),
    }), /hidden-instance-field:patch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
