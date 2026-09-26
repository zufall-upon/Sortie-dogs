import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDryRunPlan } from "./swebench-lite-runner.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

/** Reuse fixed public dataset rows, selecting the release archive by its receipt, never by a version search. */
export async function releaseManifest(basePath, receiptPath, outputPath, { publicRowHashes } = {}) {
  const base = JSON.parse(await readFile(basePath, "utf8"));
  const receiptBytes = await readFile(receiptPath);
  const receipt = JSON.parse(receiptBytes);
  const candidate = receipt.candidate_preflight?.candidate;
  if (!candidate || candidate.version !== receipt.version || candidate.package_sha256 !== receipt.package_sha256 ||
      !/^[a-f0-9]{64}$/.test(receipt.package_sha256) || !/^[a-f0-9]{40}$/.test(receipt.release_commit)) {
    throw new Error("release-receipt-candidate-mismatch");
  }
  const archive = resolve(dirname(receiptPath), `sortie-dogs-${receipt.version}.tgz`);
  if (sha256(await readFile(archive)) !== receipt.package_sha256) throw new Error("release-archive-sha256-mismatch");
  const manifest = { ...base, candidate: {
    package_tgz: relative(dirname(resolve(outputPath)), archive).replaceAll("\\", "/"),
    sha256: receipt.package_sha256, version: receipt.version, runtime_marker: candidate.runtime_marker,
    profile: candidate.profile, agent: candidate.agent,
  } };
  createDryRunPlan(manifest, publicRowHashes); // The same dataset/candidate parser used by inference.
  const runnerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const sources = ["scripts/swebench-lite-runner.mjs", "scripts/swebench-lite-supervisor.mjs", "scripts/release-cli.mjs"];
  const runnerHashes = Object.fromEntries(await Promise.all(sources.map(async path => [path, sha256(await readFile(resolve(runnerRoot, path)))])));
  const provenance = { release_commit: receipt.release_commit, package_sha256: receipt.package_sha256,
    receipt_path: resolve(receiptPath), receipt_sha256: sha256(receiptBytes), runner_root: runnerRoot,
    runner_commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: runnerRoot, encoding: "utf8" }).trim(),
    runner_sha256: runnerHashes, manifest_sha256: sha256(JSON.stringify(manifest, null, 2) + "\n") };
  // Exclusive creation protects an existing fixed campaign. No inference or global configuration changes.
  await writeFile(outputPath, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  await writeFile(`${outputPath}.provenance.json`, JSON.stringify(provenance, null, 2) + "\n", { flag: "wx" });
  return provenance;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5) throw new Error("usage: swebench-release-manifest.mjs <base-manifest> <release-receipt> <new-manifest>");
  console.log(JSON.stringify(await releaseManifest(...process.argv.slice(2)), null, 2));
}
