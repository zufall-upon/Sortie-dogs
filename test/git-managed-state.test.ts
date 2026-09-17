import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ensureGitManagedStateExcluded } from "../dist/core/git-managed-state.js";
import { OperatorRuntime } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";

async function git(root: string, args: readonly string[]): Promise<string> {
  return (await promisify(execFile)("git", [...args], { cwd: root, encoding: "utf8" })).stdout.trim();
}

async function repository(root: string): Promise<string> {
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.name", "Fixture User"]);
  await git(root, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(root, "seed.txt"), "main\n");
  await git(root, ["add", "--", "seed.txt"]);
  await git(root, ["commit", "-m", "fixture main"]);
  return git(root, ["rev-parse", "HEAD"]);
}

function lifecyclePlan(start: string) {
  const command = "node check.mjs";
  return { ...plainPlan(),
    git_lifecycle: { branch_create: { branch: "feature/metadata-failure", start_ref: start }, commit: { message: "Implement result" },
      post_commit_validation: [command] } };
}

function plainPlan() {
  const command = "node check.mjs";
  return { schema_version: "0.1", acceptance: ["Metadata failure stops before branch creation"], acceptance_proof: [["proof"]],
    source_refs: ["fixture:metadata-failure"], goal_declaration: { delivery_intent: "implementation", delivery_mode: "mvp-first",
      usable_path_established: false, controlled_change: false, defaults: { target: "result", entrypoint: "check.mjs", workload: "fixture",
        oracle_coverage: ["Git preflight"], build_boundary: "not-applicable", source: "main", candidate: "feature/metadata-failure",
        fixture: "metadata-failure", source_binding: "current-protected", candidate_binding: "current-protected",
        proof_scope: "requested-full", expected_outcome: "pass" }, criteria: [{ criterion_id: "proof", validation_command: command }] },
    units: [{ id: "implementation", title: "Implement result", objective: "Implement only after a complete Git metadata preflight.",
      read: ["seed.txt"], write: ["result.ts"], validation: [command], acceptance_indices: [0] }] };
}

test("managed operator state uses only the repository-local exact profile exclusion", async () => {
  const area = resolve("_testenv"); await mkdir(area, { recursive: true });
  const root = await mkdtemp(join(area, "managed-state-"));
  const linked = `${root}-linked`;
  try {
    await repository(root);
    const exclude = join(root, ".git", "info", "exclude");
    await writeFile(exclude, "existing-rule-without-newline");
    const own = join(root, V010_RUNTIME_PROFILE.stateDirectory);
    await mkdir(join(own, "operator-proposals"), { recursive: true });
    await mkdir(join(own, "operators"), { recursive: true });
    await writeFile(join(own, "operator-proposals", "root.json"), "{}\n");
    await writeFile(join(own, "operators", "root.json.draft.json"), "{}\n");

    assert.equal(await ensureGitManagedStateExcluded(root, V010_RUNTIME_PROFILE), true);
    assert.equal(await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    const first = await readFile(exclude, "utf8");
    assert.equal(first, "existing-rule-without-newline\n/.sortie-dogs-v010/\n");
    assert.equal(await ensureGitManagedStateExcluded(root, V010_RUNTIME_PROFILE), true);
    assert.equal(await readFile(exclude, "utf8"), first, "repeated initialization is byte-idempotent");

    await writeFile(join(root, "foreign.txt"), "foreign\n");
    assert.match(await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]), /foreign\.txt/u);
    await rm(join(root, "foreign.txt"));
    const trackedState = join(own, "tracked.json");
    await writeFile(trackedState, "tracked\n");
    await git(root, ["add", "--force", "--", `${V010_RUNTIME_PROFILE.stateDirectory}/tracked.json`]);
    await git(root, ["commit", "-m", "track explicit state fixture"]);
    await writeFile(trackedState, "modified\n");
    assert.match(await git(root, ["status", "--porcelain=v1"]), /tracked\.json/u,
      "Git exclusions must never hide tracked user content");
    await git(root, ["reset", "--hard", "HEAD"]);

    await git(root, ["worktree", "add", "-b", "feature/worktree-case", linked, "main"]);
    await mkdir(join(linked, V010_RUNTIME_PROFILE.stateDirectory, "operators"), { recursive: true });
    await writeFile(join(linked, V010_RUNTIME_PROFILE.stateDirectory, "operators", "linked.json"), "{}\n");
    assert.equal(await ensureGitManagedStateExcluded(linked, V010_RUNTIME_PROFILE), true);
    assert.equal(await git(linked, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    assert.equal(await readFile(exclude, "utf8"), first, "linked worktrees reuse the common repository exclusion");
  } finally {
    await rm(linked, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("non-Git projects remain untouched", async () => {
  const area = resolve("_testenv"); await mkdir(area, { recursive: true });
  const root = await mkdtemp(join(area, "managed-state-nongit-"));
  try { assert.equal(await ensureGitManagedStateExcluded(root, V010_RUNTIME_PROFILE, join(root, "missing-git")), false); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test("lifecycle absence leaves an enclosing repository untouched while a declared lifecycle rejects its root", async () => {
  const area = resolve("_testenv"); await mkdir(area, { recursive: true });
  const parent = await mkdtemp(join(area, "managed-state-parent-"));
  try {
    const main = await repository(parent);
    const exclude = join(parent, ".git", "info", "exclude");
    const before = await readFile(exclude, "utf8");
    const plainRoot = join(parent, "plain-project");
    const lifecycleRoot = join(parent, "lifecycle-project");
    await mkdir(plainRoot); await mkdir(lifecycleRoot);

    const prepared = await new OperatorRuntime(plainRoot, V010_RUNTIME_PROFILE).prepare("plain-root", plainPlan());
    assert.equal(prepared.gitLifecycle, null);
    assert.equal(await readFile(exclude, "utf8"), before);

    await assert.rejects(new OperatorRuntime(lifecycleRoot, V010_RUNTIME_PROFILE).prepare("lifecycle-root", lifecyclePlan(main)),
      /operator-git-managed-state-root-mismatch/u);
    assert.equal(await readFile(exclude, "utf8"), before);
    assert.equal(await git(parent, ["symbolic-ref", "--short", "HEAD"]), "main");
    await assert.rejects(lstat(join(lifecycleRoot, V010_RUNTIME_PROFILE.stateDirectory)), { code: "ENOENT" });
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("confirmed Git roots fail closed when the injected lifecycle Git cannot resolve metadata", async () => {
  const area = resolve("_testenv"); await mkdir(area, { recursive: true });
  const root = await mkdtemp(join(area, "managed-state-metadata-"));
  try {
    const main = await repository(root);
    const exclude = join(root, ".git", "info", "exclude");
    const before = await readFile(exclude, "utf8");
    const calls = join(root, "git-calls.jsonl");
    const script = join(root, "rev-parse");
    await writeFile(script, [
      'import { appendFileSync } from "node:fs";',
      `const calls = ${JSON.stringify(calls)}, root = ${JSON.stringify(root)};`,
      'const args = ["rev-parse", ...process.argv.slice(2)]; appendFileSync(calls, `${JSON.stringify(args)}\\n`);',
      'if (JSON.stringify(args) === JSON.stringify(["rev-parse", "--show-toplevel"])) { console.log(root); process.exit(0); }',
      'process.exit(17);',
    ].join("\n"));
    const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE, process.execPath);
    await assert.rejects(runtime.prepare("metadata-root", lifecyclePlan(main)), /operator-git-managed-state-metadata-unavailable/u);
    const invoked = (await readFile(calls, "utf8")).trim().split(/\r?\n/u).map(line => JSON.parse(line));
    assert.deepEqual(invoked, [
      ["rev-parse", "--show-toplevel"],
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
    ]);
    assert.equal(await readFile(exclude, "utf8"), before);
    assert.equal(await git(root, ["symbolic-ref", "--short", "HEAD"]), "main");
    await assert.rejects(lstat(join(root, V010_RUNTIME_PROFILE.stateDirectory)), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
