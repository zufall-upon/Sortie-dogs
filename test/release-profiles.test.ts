import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { releaseProfile, compareReleaseVersions, validateReleaseProfile, githubReleaseFlags } from "../scripts/release-profiles.mjs";
import { V010_RUNTIME_PROFILE, STABLE_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";

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
