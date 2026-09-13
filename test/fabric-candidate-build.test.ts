import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fixture, gitExecutable, openParallelCoordinator, run } from "./helpers/worktree-dispatch-fixture.ts";

const execFileAsync = promisify(execFile);
type BuildTask = { descriptor: { task_id: string }; artifact: { base_sha: string; commit_sha: string } };
type Builder = {
  stateRoot: string;
  gitBuffer: (args: readonly string[], environment?: NodeJS.ProcessEnv, cwd?: string) => Promise<Buffer>;
  buildFabricCandidate: (runID: string, base: string, tasks: readonly BuildTask[]) => Promise<string>;
};

test("fabric candidate build reuses one index and preserves ordered commit identities", async () => {
  const value = await fixture("candidate-build");
  try {
    const makeArtifact = async (id: string, path: string, content: string, date: string): Promise<BuildTask> => {
      await run(value.repository, "checkout", "-q", "-b", `fixture-${id}`, value.sha);
      await writeFile(join(value.repository, path), content);
      await run(value.repository, "add", path);
      await execFileAsync(gitExecutable!, ["-c", "user.name=Sortie Test", "-c", "user.email=sortie@example.invalid",
        "commit", "-qm", `artifact-${id}`], { cwd: value.repository, windowsHide: true, timeout: 10_000,
        env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
      return { descriptor: { task_id: id }, artifact: { base_sha: value.sha,
        commit_sha: (await run(value.repository, "rev-parse", "HEAD")).trim() } };
    };
    const dates = ["2020-01-02T00:00:00Z", "2020-01-01T00:00:00Z"] as const;
    const a = await makeArtifact("a", "a.txt", "changed-a\n", dates[0]);
    const b = await makeArtifact("b", "b.txt", "changed-b\n", dates[1]);
    const conflict = await makeArtifact("conflict", "a.txt", "conflicting-a\n", dates[1]);
    await run(value.repository, "checkout", "--detach", "-q", value.sha);
    const coordinator = await openParallelCoordinator(value.repository);
    const builder = coordinator as unknown as Builder;
    await mkdir(builder.stateRoot, { recursive: true });
    const initialStatus = await run(value.repository, "status", "--porcelain");
    const original = builder.gitBuffer.bind(coordinator);
    const calls: string[][] = [];
    builder.gitBuffer = (args, ...rest) => { calls.push([...args]); return original(args, ...rest); };
    const runID = randomUUID();
    assert.equal(await builder.buildFabricCandidate(runID, value.sha, []), value.sha);
    assert.deepEqual(calls, []);
    const head = await builder.buildFabricCandidate(runID, value.sha, [a, b]);
    assert.equal(calls.filter(([command]) => command === "read-tree").length, 1);
    assert.equal(calls.filter(([command]) => command === "show").length, 1);
    const chain = (await run(value.repository, "rev-list", "--reverse", `${value.sha}..${head}`)).trim().split(/\r?\n/u);
    assert.equal(chain.length, 2);
    for (const [index, task] of [a, b].entries()) {
      assert.equal((await run(value.repository, "show", "-s", "--format=%P", chain[index]!)).trim(), index === 0 ? value.sha : chain[index - 1]);
      assert.equal((await run(value.repository, "show", "-s", "--format=%ct", chain[index]!)).trim(), String(Date.parse(dates[index]!) / 1000));
      assert.ok((await run(value.repository, "show", "-s", "--format=%B", chain[index]!)).includes(`Sortie-Artifact: ${task.artifact.commit_sha}`));
    }
    assert.equal(await run(value.repository, "show", `${chain[0]}:b.txt`), "base-b\n");
    assert.equal(await run(value.repository, "show", `${head}:a.txt`), "changed-a\n");
    assert.equal(await run(value.repository, "show", `${head}:b.txt`), "changed-b\n");
    assert.deepEqual((await run(value.repository, "diff", "--name-only", value.sha, head)).trim().split(/\r?\n/u), ["a.txt", "b.txt"]);
    assert.equal(await builder.buildFabricCandidate(runID, value.sha, [a, b]), head, "replay must recreate the exact commit SHA");
    await assert.rejects(builder.buildFabricCandidate(runID, value.sha, [a, conflict]), { code: "wave-integration-failed" });
    assert.deepEqual((await readdir(builder.stateRoot)).filter(path => /^\.fabric-(?:index|patch|message)-/u.test(path)), []);
    assert.equal((await run(value.repository, "rev-parse", "HEAD")).trim(), value.sha);
    assert.equal(await run(value.repository, "status", "--porcelain"), initialStatus);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
