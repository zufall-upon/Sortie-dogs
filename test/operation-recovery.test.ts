import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createProjectPaths, createWriteGate, canonicalManifestWriteScopes, extractWritePaths } from "../dist/plugin/gate.js";
import { protectedSnapshot, refreshProtectedSnapshot } from "../dist/plugin/protected-snapshot.js";
import { missionReviewSource } from "../dist/plugin/mission-review.js";
import { OperatorMissionRuntime, missionPlan } from "../dist/core/operator-mission.js";
import { OperatorRuntime, operatorGitPathAuthorized } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";

const exec = promisify(execFile);
async function fixture(run: (root: string) => Promise<void>) {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(resolve("_testenv/operation-recovery-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("native mission directory scope survives creation, archive, protected validation and review", async () => fixture(async root => {
  const git = (...args: string[]) => exec("git", args, { cwd: root });
  await git("init", "-q");
  await writeFile(join(root, "input.txt"), "source bytes\n");
  await writeFile(join(root, ".gitignore"), "_testenv/\n.sortie-dogs-v010/\n");
  await git("add", "--", "input.txt", ".gitignore");
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  const missions = new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "request", text: "Prepare an isolated source archive and record evidence." });
  const mission = await missions.start("root", ["Prepare an isolated source archive and record evidence."]);
  const plan = missionPlan(mission, [{ title: "Prepare candidate", objective: "Archive input.txt and record evidence",
    read: ["input.txt"], write: ["_testenv/candidate/"], validation: ["node check.mjs"] }]);
  assert.deepEqual(plan.units[0]!.write, ["_testenv/candidate/**"]);
  const run = await new OperatorRuntime(root, V010_RUNTIME_PROFILE).prepareMission("root", plan);
  const manifestPath = run.units[0]!.manifestPath;
  const bytes = await readFile(manifestPath);
  const manifest = JSON.parse(bytes.toString());
  const project = await createProjectPaths(root), gate = await createWriteGate(project, manifest);
  assert.deepEqual(await canonicalManifestWriteScopes(project, manifest), [join(root, "_testenv/candidate")]);
  const shell = (command: string) => gate.check({ tool: "shell", sessionID: "worker", callID: command },
    { args: { command } }, { investigativeShell: true });
  await shell("mkdir -p _testenv/candidate/snapshot");
  await mkdir(join(root, "_testenv/candidate/snapshot"), { recursive: true });
  await shell("git archive --format=tar --output=_testenv/candidate/source.tar HEAD");
  await git("archive", "--format=tar", "--output=_testenv/candidate/source.tar", "HEAD");
  assert.ok((await readFile(join(root, "_testenv/candidate/source.tar"))).includes(Buffer.from("source bytes")));
  await gate.checkPath("_testenv/candidate/evidence.json");
  await writeFile(join(root, "_testenv/candidate/evidence.json"), '{"result":"PASS"}');
  assert.equal(operatorGitPathAuthorized("_testenv/candidate/evidence.json", manifest.write), true);
  await assert.rejects(gate.checkPath("_testenv/other/result.json"), /write scope/);
  const snapshot = await protectedSnapshot({ manifestPath, projectRoot: root,
    manifestHash: createHash("sha256").update(bytes).digest("hex") });
  assert.ok(snapshot);
  assert.deepEqual(snapshot.binding.candidate_paths, ["_testenv/candidate"]);
  const review = await missionReviewSource(root, run);
  assert.match(review.excerpt, /evidence.json/);
  await writeFile(join(root, "_testenv/candidate/evidence.json"), '{"result":"changed"}');
  assert.notEqual((await refreshProtectedSnapshot(root, snapshot.binding))?.candidate, snapshot.candidate);
  assert.notEqual((await missionReviewSource(root, run)).fingerprint, review.fingerprint);
}));

test("candidate preparation classifies real curl, local archive and tag observation commands", () => {
  const curl = extractWritePaths("shell", { command: "curl --fail --location --show-error --silent --output _testenv/candidate/source.tar.gz --write-out '%{http_code} %{url_effective} %{size_download}\\n' https://github.com/zufall-upon/Sortie-dogs/archive/refs/tags/v0.12.10.tar.gz" });
  assert.equal(curl.ambiguous, false);
  assert.deepEqual(curl.paths, ["_testenv/candidate/source.tar.gz"]);
  for (const command of ["git tag --points-at HEAD", "git tag --contains HEAD", "git archive HEAD"]) {
    const extracted = extractWritePaths("shell", { command });
    assert.equal(extracted.ambiguous, false, command);
    assert.equal(extracted.applies, false, command);
  }
  const redirected = extractWritePaths("shell", { command: "git archive HEAD > _testenv/candidate/source.tar" });
  assert.equal(redirected.ambiguous, false);
  assert.deepEqual(redirected.paths, ["_testenv/candidate/source.tar"]);
  for (const command of ["git tag -d v1", "git archive --remote=https://example.test HEAD", "curl -o result https://example.test -w '%output{other.txt}'"]) {
    assert.equal(extractWritePaths("shell", { command }).ambiguous, true, command);
  }
});

test("format correction continues within the same bound Worker and scope errors name the remedy", async () => fixture(async root => {
  const gate = await createWriteGate(await createProjectPaths(root), {
    version: "0.1.0", task_id: "format-repair", read: [], write: ["output/**"], validation: [],
  });
  const shell = (command: string) => gate.check({ tool: "shell", sessionID: "worker", callID: command }, { args: { command } }, { investigativeShell: true });
  await assert.rejects(shell("curl --progress-bar -o output/result https://example.test/result"), /action=correct-format-within-current-manifest/);
  await shell("curl -fLsS -o output/result https://example.test/result");
  await assert.rejects(shell("curl -fLsS -o other/result https://example.test/result"), /Coordinator: expand_unit/);
  await assert.rejects(gate.check({ tool: "shell", sessionID: "legacy", callID: "legacy" },
    { args: { command: "curl --progress-bar -o output/result https://example.test/result" } }), /retry=false/);
}));
