import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { releaseProfile, compareReleaseVersions, validateReleaseProfile, githubReleaseFlags } from "../scripts/release-profiles.mjs";
import { V010_RUNTIME_PROFILE, STABLE_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";
import { V010_RUNTIME_ASSET_VERSION } from "../dist/asset-version.js";
import { missionReleaseSmokeMode, v013StartupReceipt } from "../scripts/release-cli.mjs";

test("release profiles fix branch, channel, Latest behavior and isolated target", () => {
  const root = resolve("_testenv/profile-project"), isolated = resolve(root, "_testenv/install");
  const beta = releaseProfile("beta-v010"), independent = releaseProfile("independent-v010");
  validateReleaseProfile(beta, "0.10.0-beta.1", "beta/v0.10", root, isolated);
  validateReleaseProfile(independent, "0.10.0", "release/v0.10", root, isolated);
  assert.equal(beta.npmTag, "beta"); assert.equal(independent.npmTag, "next");
  assert.deepEqual(githubReleaseFlags(beta), ["--target", "beta/v0.10", "--prerelease", "--latest=false"]);
  assert.throws(() => validateReleaseProfile(beta, "0.10.0", beta.branch, root, isolated), /Prerelease/);
  assert.throws(() => validateReleaseProfile(beta, "0.9.11-beta.1", beta.branch, root, isolated), /profile/);
  assert.throws(() => validateReleaseProfile(beta, "0.10.0-rc.1", beta.branch, root, isolated), /label/);
  assert.throws(() => validateReleaseProfile(beta, "0.10.0-beta.1", "main", root, isolated), /target/);
  assert.throws(() => validateReleaseProfile(beta, "0.10.0-beta.1", beta.branch, root, resolve(root, "../global")), /install target/);
  assert.throws(() => releaseProfile("invented"), /Unknown/);
  assert.equal(beta.markerFile, V010_RUNTIME_PROFILE.markerFile);
  assert.equal(releaseProfile().markerFile, STABLE_RUNTIME_PROFILE.markerFile);
  const restored = releaseProfile("v012");
  validateReleaseProfile(restored, "0.12.0", "main", root, resolve(root, "../global"));
  assert.equal(restored.runtimeProfile, "v010");
  assert.equal(restored.markerFile, V010_RUNTIME_PROFILE.markerFile);
  assert.deepEqual(githubReleaseFlags(restored), ["--target", "main"]);
  assert.throws(() => validateReleaseProfile(restored, "0.11.4", "main", root, isolated), /profile/);
  const fastFirst = releaseProfile("v013");
  validateReleaseProfile(fastFirst, "0.13.0", "main", root, isolated);
  assert.equal(fastFirst.runtimeProfile, "v010", "the v0.13 release retains the actual Mission runtime");
  assert.equal(fastFirst.markerFile, V010_RUNTIME_PROFILE.markerFile);
  assert.equal(fastFirst.markerExport, "V010_RUNTIME_ASSET_VERSION");
  assert.equal(V010_RUNTIME_ASSET_VERSION, "0.13.4-reviewer-continuous-cache-v2");
  assert.deepEqual(githubReleaseFlags(fastFirst), ["--target", "main"]);
  assert.equal(missionReleaseSmokeMode(fastFirst.id), "start", "candidate smoke observes Worker/model, not a claimed solution");
  assert.equal(missionReleaseSmokeMode(restored.id), "complete", "historical v012 contract remains intact");
  assert.equal(missionReleaseSmokeMode("stable"), null);
  assert.throws(() => validateReleaseProfile(fastFirst, "0.12.25", "main", root, isolated), /profile/);
  assert.throws(() => validateReleaseProfile(fastFirst, "0.13.0", "release/v0.13", root, isolated), /target/);
});

test("v013 CLI proof is a real-model Worker startup, never a completed Mission", () => {
  const observed = { accepted: true, errors: [], stopped: "worker-started", root: "ses_root", candidate_sha256: "frozen",
    package_version: "0.13.0", runtime_marker: "0.13.0-fast-first-v1", priced_usd: 0.1, unpriced_requests: 0,
    models: [{ sessionID: "ses_root", agent: "dog-operator",
      model: { providerID: "openai", id: "gpt-6.1-sol", variant: "xhigh" } },
    { sessionID: "ses_worker", agent: "dog-worker-v010", started_ms: 95_000,
      model: { providerID: "openai", id: "gpt-6-luna-fast", variant: "max" } }] };
  const receipt = v013StartupReceipt(observed);
  assert.deepEqual([receipt.sha256, receipt.terminal, receipt.canonicalExit, receipt.workerStartedMs],
    ["frozen", "worker-started", null, 95_000]);
  assert.throws(() => v013StartupReceipt({ ...observed, stopped: false }), /native Worker start/u);
  assert.throws(() => v013StartupReceipt({ ...observed, runtime_marker: "0.12.25-old" }), /marker/u);
  assert.throws(() => v013StartupReceipt({ ...observed, models: [observed.models[0]] }), /Luna Fast/u);
  assert.throws(() => v013StartupReceipt({ ...observed, models: [
    { ...observed.models[0], model: { providerID: "openai", id: "gpt-6-sol", variant: "low" } }, observed.models[1],
  ] }), /Sol\/xhigh/u);
});

test("release version ordering handles beta increments and independent stable promotion", () => {
  for (const [older, newer] of [["0.9.10", "0.10.0-beta.1"], ["0.10.0-beta.2", "0.10.0-beta.10"],
    ["0.10.0-beta.10", "0.10.0"], ["0.10.0", "0.10.1"]]) {
    assert.equal(compareReleaseVersions(older, newer), -1);
    assert.equal(compareReleaseVersions(newer, older), 1);
  }
  assert.equal(compareReleaseVersions("0.10.0-beta.1", "0.10.0-beta.1"), 0);
  assert.throws(() => compareReleaseVersions("0.10.0-beta.01", "0.10.0"), /Invalid/);
});
