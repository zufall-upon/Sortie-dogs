import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { candidateFailureMessage, cleanupCandidateRuntime, createDryRunPlan, prepareCandidateRuntime } from "./swebench-lite-runner.mjs";

export async function runCandidatePreflight(manifestArgument, runRootArgument, dependencies = {}) {
  if (!manifestArgument || !runRootArgument) {
    throw new Error("usage: swebench-candidate-preflight.mjs <manifest> <run-root>");
  }
  const manifestPath = resolve(manifestArgument);
  const runRoot = resolve(runRootArgument);
  const value = JSON.parse(await readFile(manifestPath, "utf8"));
  const plan = (dependencies.createPlan ?? createDryRunPlan)(value);
  const packagePath = resolve(dirname(manifestPath), plan.candidate.package_tgz);
  let ownsRunRoot = false;
  let prepared;
  let unresolvedRuntime = false;
  try {
    try { await mkdir(runRoot); ownsRunRoot = true; }
    catch (error) {
      if (error?.code === "EEXIST") throw new Error("candidate-preflight-run-root-already-exists");
      throw error;
    }
    prepared = await (dependencies.prepareCandidate ?? prepareCandidateRuntime)(plan.candidate, packagePath, runRoot);
    return { candidate: prepared.evidence, config_verified: true, provider_requests_started: false };
  } catch (error) {
    unresolvedRuntime = error?.candidateRuntimeContext?.cleanup_complete === false;
    throw error;
  } finally {
    if (ownsRunRoot && !unresolvedRuntime) {
      try { await cleanupCandidateRuntime(prepared); }
      finally { await rm(runRoot, { recursive: true, force: true }); }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runCandidatePreflight(...process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) { process.stderr.write(candidateFailureMessage(error)); process.exitCode = 1; }
}
