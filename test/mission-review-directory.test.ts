import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { missionReviewSource } from "../dist/plugin/mission-review.js";

const git = promisify(execFile);

test("mission review expands an ignored nested Git project and pins its outputs", async () => {
  const fixtureRoot = tmpdir();
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(join(fixtureRoot, "mission-review-directory-"));
  try {
    await git("git", ["init", "--quiet"], { cwd: root });
    await writeFile(join(root, ".gitignore"), "_testenv/\n");
    const relativeProject = "_testenv/releases/0.13.0/cli-probe/smoke-1/project";
    const project = join(root, relativeProject);
    await mkdir(project, { recursive: true });
    await git("git", ["init", "--quiet"], { cwd: project });
    await git("git", ["config", "user.email", "test@example.invalid"], { cwd: project });
    await git("git", ["config", "user.name", "test"], { cwd: project });
    await writeFile(join(project, "check.mjs"), "export const result = 1;\n");
    await writeFile(join(project, "result.txt"), "observed output\n");
    const stateOutput = "_testenv/releases/0.13.0/cli-probe/smoke-1/project/.sortie-dogs-v010/missions/state.json";
    await mkdir(join(project, ".sortie-dogs-v010", "missions"), { recursive: true });
    await writeFile(join(project, ".sortie-dogs-v010", "missions", "state.json"), "runtime state\n".repeat(4_000));
    await git("git", ["add", "--all"], { cwd: project });
    await git("git", ["commit", "--quiet", "-m", "project output"], { cwd: project });

    const run = { units: [{ unit: { write: ["_testenv/**"] }, hashes: [] }] } as never;
    const first = await missionReviewSource(root, run);
    assert.match(first.excerpt, /new file: _testenv\/releases\/0\.13\.0\/cli-probe\/smoke-1\/project\//u);
    assert.match(first.excerpt, /new file: _testenv\/releases\/0\.13\.0\/cli-probe\/smoke-1\/project\/check\.mjs/u);
    assert.match(first.excerpt, /export const result = 1/u);
    assert.match(first.excerpt, /new file: _testenv\/releases\/0\.13\.0\/cli-probe\/smoke-1\/project\/result\.txt/u);
    assert.match(first.excerpt, /observed output/u);
    assert.doesNotMatch(first.excerpt, /project\/\.git\//u, "nested repository administration is not reviewed output");
    assert.ok(first.truncatedSource.includes(stateOutput), "large internal state is fingerprinted and explicitly omitted");

    await writeFile(join(project, "result.txt"), "OBSERVED output\n");
    const changed = await missionReviewSource(root, run);
    assert.notEqual(changed.fingerprint, first.fingerprint, "nested output bytes invalidate the review");
    assert.match(changed.excerpt, /OBSERVED output/u);

    await rm(join(project, "result.txt"));
    const deleted = await missionReviewSource(root, run);
    assert.notEqual(deleted.fingerprint, changed.fingerprint, "deleting a nested output invalidates the review");
    assert.doesNotMatch(deleted.excerpt, /OBSERVED output/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
