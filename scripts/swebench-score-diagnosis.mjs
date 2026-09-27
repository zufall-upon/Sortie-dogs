/** Post-inference, read-only classification of frozen official SWE-bench logs.
 *  This tool never runs the harness or changes predictions, tests, or official scores.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const hash = value => createHash("sha256").update(value).digest("hex");
const safeID = id => typeof id === "string" && /^[\w.-]+__[\w.-]+-\d+$/u.test(id);
const read = async path => readFile(path).then(bytes => ({ sha256: hash(bytes), text: bytes.toString("utf8") }));
const optional = async path => read(path).catch(error => {
  if (error?.code === "ENOENT") return null;
  throw error;
});
const reported = report => report?.tests_status?.FAIL_TO_PASS?.failure ?? [];

export function classifyOfficialTest({ patch, report, runLog, testOutput }) {
  if (!patch) return { stage: "no-prediction-patch", candidate_patch: "absent", test_patch: "not-observed",
    test_exit_code: null, expected_failures: 0, tests_observed: 0, missing_expected_test_ids: [] };
  const applied = />>>>> Applied Patch:[\s\S]*?Applied patch .+ cleanly\./u.test(runLog);
  const applyError = /(?:error: patch failed:|error: .* does not apply|Failed to apply patch)/iu.test(runLog);
  const candidatePatch = applyError ? "observed-failed" : applied ? "observed-applied" : "unconfirmed";
  // Report.patch_successfully_applied can be false when collection fails *after* the
  // candidate was applied. It is recorded below, not used as an apply-failure oracle.
  const collisions = [...testOutput.matchAll(/^error: (.+already exists in working directory.*)$/gmu)]
    .map(match => match[1]).slice(0, 20);
  const testPatch = collisions.length ? "observed-collision" : testOutput.includes("Test Exit Code:")
    ? "no-collision-observed" : "unconfirmed";
  const tests = [...testOutput.matchAll(/^(?:PASSED|FAILED|ERROR) (\S+)/gmu)].map(match => match[1]);
  const testIds = new Set(tests);
  const expected = reported(report);
  const exit = [...testOutput.matchAll(/^>>>>> Test Exit Code: (\d+)$/gmu)].at(-1);
  const importFailure = /(?:ERROR collecting|ImportError:|ModuleNotFoundError:|error while importing test module|AttributeError: `np\.Inf` was removed)/iu.test(testOutput);
  const stage = candidatePatch === "observed-failed" ? "candidate-patch-apply"
    : collisions.length ? "test-patch-injection"
      : importFailure ? "collection-or-import"
        : report?.resolved === true ? "official-resolved"
          : expected.some(id => testIds.has(id)) || /^FAILED /mu.test(testOutput) ? "assertion-or-test-failure"
            : exit && Number(exit[1]) !== 0 ? "test-command-failed" : "unresolved-or-unconfirmed";
  return { stage, candidate_patch: candidatePatch, report_patch_successfully_applied: report?.patch_successfully_applied ?? null,
    test_patch: testPatch, test_exit_code: exit ? Number(exit[1]) : null, expected_failures: expected.length,
    tests_observed: tests.length, missing_expected_test_ids: expected.filter(id => !testIds.has(id)).slice(0, 30),
    ...(collisions.length ? { test_patch_collisions: collisions } : {}) };
}

function supplementalCheck(entry, patchSha256, evaluatorSha256) {
  if (!entry || entry.kind !== "supplemental-swebench-test-reset" || entry.official_score !== false ||
    entry.prediction_sha256 !== patchSha256 || entry.normalization?.input_sha256 !== evaluatorSha256 ||
    !/^[a-f0-9]{64}$/u.test(entry.normalization?.output_sha256) ||
    !/^sha256:[a-f0-9]{64}$/u.test(entry.image_id) ||
    !["output_sha256", "helper_sha256"].every(key => /^[a-f0-9]{64}$/u.test(entry[key])) ||
    !Array.isArray(entry.test_results) || !entry.test_results.every(line => typeof line === "string") ||
    !Number.isInteger(entry.container_exit)) throw new Error(`supplemental-evidence-invalid:${entry?.instance_id ?? "unknown"}`);
  const exits = entry.test_results.flatMap(line => {
    const match = /^>>>>> Test Exit Code: (\d+)$/u.exec(line);
    return match ? [Number(match[1])] : [];
  });
  if (exits.length !== 1 || !Array.isArray(entry.test_patch_apply_errors)) {
    throw new Error(`supplemental-test-exit-missing:${entry.instance_id}`);
  }
  return { kind: entry.kind, official_score: false, image_id: entry.image_id,
    candidate_patch_sha256: patchSha256, evaluator_sha256: evaluatorSha256,
    normalized_evaluator_sha256: entry.normalization.output_sha256, helper_sha256: entry.helper_sha256,
    output_sha256: entry.output_sha256, container_exit: entry.container_exit, test_exit_code: exits[0],
    test_ids_observed: entry.test_results.filter(line => /^(?:PASSED|FAILED|ERROR) /u.test(line)).map(line => line.split(" ")[1]),
    test_patch_apply_errors: entry.test_patch_apply_errors };
}

export async function diagnoseOfficialRun({ candidateRoot, predictionsPath, supplementalPath }) {
  const predictions = await read(predictionsPath);
  const rows = predictions.text.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  const supplemental = supplementalPath ? JSON.parse((await read(supplementalPath)).text) : [];
  if (!Array.isArray(supplemental)) throw new Error("supplemental-evidence-invalid");
  const checks = new Map(supplemental.map(entry => [entry.instance_id, entry]));
  if (checks.size !== supplemental.length) throw new Error("duplicate-supplemental-instance");
  const seen = new Set();
  const instances = [];
  for (const prediction of rows) {
    const id = prediction.instance_id;
    if (!safeID(id) || seen.has(id) || typeof prediction.model_patch !== "string") throw new Error(`invalid-prediction:${id}`);
    seen.add(id);
    const patchSha256 = hash(prediction.model_patch);
    const directory = join(candidateRoot, id);
    const files = await Promise.all(["report.json", "run_instance.log", "test_output.txt", "eval.sh"]
      .map(async name => ({ name, value: await optional(join(directory, name)) })));
    const sources = Object.fromEntries(files.filter(item => item.value).map(item => [item.name, item.value.sha256]));
    const contents = Object.fromEntries(files.map(item => [item.name, item.value?.text ?? ""]));
    const report = contents["report.json"] ? JSON.parse(contents["report.json"])[id] : null;
    if (contents["report.json"] && !report) throw new Error(`official-report-instance-mismatch:${id}`);
    const classified = classifyOfficialTest({ patch: prediction.model_patch, report,
      runLog: contents["run_instance.log"], testOutput: contents["test_output.txt"] });
    const check = checks.get(id);
    instances.push({ instance_id: id, prediction_sha256: patchSha256,
      official_resolved: report?.resolved ?? null, official_infra_failure: report?.infra_failure ?? null,
      diagnosis: classified, official_sources_sha256: sources,
      ...(check ? { supplemental: supplementalCheck(check, patchSha256, sources["eval.sh"]) } : {}) });
  }
  for (const id of checks.keys()) if (!seen.has(id)) throw new Error(`supplemental-instance-unknown:${id}`);
  return { kind: "supplemental-swebench-score-diagnosis", official_score: false,
    predictions_sha256: predictions.sha256, counts: Object.fromEntries([...new Set(instances.map(item => item.diagnosis.stage))]
      .sort().map(stage => [stage, instances.filter(item => item.diagnosis.stage === stage).length])), instances };
}

function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!["--candidate-root", "--predictions", "--output", "--supplemental"].includes(args[index]) || !args[index + 1]) {
      throw new Error("usage: --candidate-root <official-log-candidate-directory> --predictions <frozen-jsonl> --output <new-file> [--supplemental <frozen-results-json>]");
    }
    values[args[index].slice(2)] = resolve(args[index + 1]);
  }
  if (!values["candidate-root"] || !values.predictions || !values.output) throw new Error("missing-diagnostic-argument");
  return values;
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await diagnoseOfficialRun({ candidateRoot: args["candidate-root"],
      predictionsPath: args.predictions, supplementalPath: args.supplemental });
    await writeFile(args.output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`${JSON.stringify({ counts: result.counts, official_score: false, output: args.output })}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
