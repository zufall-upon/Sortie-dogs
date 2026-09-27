import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { classifyOfficialTest, diagnoseOfficialRun } from "../scripts/swebench-score-diagnosis.mjs";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const patch = "diff --git a/source.py b/source.py\n";
const id = (suffix: number) => `example__project-${suffix}`;

test("post-score diagnosis separates candidate application, test injection, collection and assertions", async () => {
  const applied = "INFO - >>>>> Applied Patch:\nApplied patch source.py cleanly.\n";
  const report = { patch_successfully_applied: false, resolved: false,
    tests_status: { FAIL_TO_PASS: { failure: ["tests/test_new.py::test_case"] } } };
  const collision = classifyOfficialTest({ patch, report: { ...report, patch_successfully_applied: true }, runLog: applied,
    testOutput: "error: tests/test_new.py: already exists in working directory\nPASSED tests/test_candidate.py::test_local\n>>>>> Test Exit Code: 0\n" });
  assert.equal(collision.stage, "test-patch-injection");
  assert.equal(collision.test_exit_code, 0);
  assert.deepEqual(collision.missing_expected_test_ids, ["tests/test_new.py::test_case"]);
  assert.equal(collision.candidate_patch, "observed-applied");
  const imported = classifyOfficialTest({ patch, report, runLog: applied,
    testOutput: "ImportError: libGL.so.1: cannot open shared object file\n>>>>> Test Exit Code: 1\n" });
  assert.equal(imported.stage, "collection-or-import");
  assert.equal(imported.report_patch_successfully_applied, false);
  assert.equal(imported.candidate_patch, "observed-applied", "the report flag cannot negate an observed candidate apply");
  assert.equal(classifyOfficialTest({ patch, report, runLog: "error: patch failed: source.py\n", testOutput: "" }).stage,
    "candidate-patch-apply");
  assert.equal(classifyOfficialTest({ patch, report, runLog: applied,
    testOutput: "FAILED tests/test_new.py::test_case\n>>>>> Test Exit Code: 1\n" }).stage, "assertion-or-test-failure");
  assert.equal(classifyOfficialTest({ patch, report: { ...report, resolved: true }, runLog: applied,
    testOutput: "PASSED tests/test_new.py::test_case\n>>>>> Test Exit Code: 0\n" }).stage, "official-resolved");
  assert.equal(classifyOfficialTest({ patch: "", report: null, runLog: "", testOutput: "" }).stage, "no-prediction-patch");
});

test("frozen official run and reset evidence remain separate with bound hashes and inner test exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "swebench-stage-diagnosis-"));
  try {
    const candidateRoot = join(root, "logs"), predictionsPath = join(root, "predictions.jsonl");
    const predictions = [
      { instance_id: id(1), model_name_or_path: "candidate", model_patch: patch },
      { instance_id: id(2), model_name_or_path: "candidate", model_patch: "" },
    ];
    const frozen = predictions.map(row => JSON.stringify(row)).join("\n") + "\n";
    await writeFile(predictionsPath, frozen);
    const directory = join(candidateRoot, id(1));
    await mkdir(directory, { recursive: true });
    const official = { [id(1)]: { resolved: false, infra_failure: false, patch_successfully_applied: true,
      tests_status: { FAIL_TO_PASS: { failure: ["tests/new.py::test_expected"] } } } };
    await writeFile(join(directory, "report.json"), JSON.stringify(official));
    await writeFile(join(directory, "run_instance.log"), "INFO - >>>>> Applied Patch:\nApplied patch source.py cleanly.\n");
    await writeFile(join(directory, "test_output.txt"), "error: tests/new.py: already exists in working directory\n" +
      "PASSED tests/candidate.py::test_local\n>>>>> Test Exit Code: 0\n");
    const evalScript = "#!/bin/sh\ngit checkout base tests/new.py\n";
    await writeFile(join(directory, "eval.sh"), evalScript);
    const supplementalPath = join(root, "reset-results.json");
    const supplement = { instance_id: id(1), kind: "supplemental-swebench-test-reset", official_score: false,
      image_id: `sha256:${"a".repeat(64)}`, prediction_sha256: sha(patch), helper_sha256: sha("helper"),
      output_sha256: sha("supplemental test output"), normalization: { input_sha256: sha(evalScript), output_sha256: sha("normalized") },
      container_exit: 0, test_results: ["FAILED tests/new.py::test_expected", ">>>>> Test Exit Code: 1"], test_patch_apply_errors: [] };
    await writeFile(supplementalPath, JSON.stringify([supplement]));
    const result = await diagnoseOfficialRun({ candidateRoot, predictionsPath, supplementalPath });
    assert.deepEqual(result.counts, { "no-prediction-patch": 1, "test-patch-injection": 1 });
    assert.equal(result.predictions_sha256, sha(frozen));
    assert.equal(result.official_score, false);
    assert.equal(result.instances[0]!.official_resolved, false);
    assert.equal(result.instances[0]!.diagnosis.test_exit_code, 0);
    assert.equal(result.instances[0]!.supplemental.test_exit_code, 1);
    assert.equal(result.instances[0]!.supplemental.container_exit, 0);
    assert.deepEqual(result.instances[0]!.supplemental.test_ids_observed, ["tests/new.py::test_expected"]);
    assert.equal(result.instances[1]!.diagnosis.stage, "no-prediction-patch");
    const output = join(root, "summary.json");
    const invoke = () => promisify(execFile)(process.execPath, [resolve("scripts/swebench-score-diagnosis.mjs"),
      "--candidate-root", candidateRoot, "--predictions", predictionsPath,
      "--supplemental", supplementalPath, "--output", output]);
    await invoke();
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), result);
    await assert.rejects(invoke(), /Command failed/, "a frozen diagnosis cannot be silently overwritten");
    supplement.prediction_sha256 = sha("different patch");
    await writeFile(supplementalPath, JSON.stringify([supplement]));
    await assert.rejects(diagnoseOfficialRun({ candidateRoot, predictionsPath, supplementalPath }), /supplemental-evidence-invalid/);
    assert.equal(await readFile(predictionsPath, "utf8"), frozen);
    assert.deepEqual(JSON.parse(await readFile(join(directory, "report.json"), "utf8")), official);
  } finally { await rm(root, { recursive: true, force: true }); }
});
