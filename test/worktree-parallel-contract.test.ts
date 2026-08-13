import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import type { WorktreeParallelContract, WorktreeFileScope } from "../src/core/types.ts";
import { validateWorktreeParallelSchema } from "../dist/core/validate-schema.js";
import { validateWorktreeParallelContract } from "../dist/core/validate-worktree-parallel.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const FINGERPRINT = "f".repeat(64);

function artifact(): WorktreeParallelContract["artifacts"][number] {
  return {
    task_id: "left",
    base_sha: SHA_A,
    commit_sha: SHA_B,
    branch: "sortie/left",
    changed_paths: ["src/a.ts"],
    change_fingerprint: FINGERPRINT,
    validation: {
      command: ["/usr/bin/node", "--test"],
      exit_code: 0,
      validation_fingerprint: FINGERPRINT,
    },
  };
}

function contract(
  left: WorktreeFileScope,
  right: WorktreeFileScope,
  dependsOnLeft = false,
): WorktreeParallelContract {
  return {
    version: "0.1.0",
    mode: "parallel",
    max_workers: 2,
    tasks: [
      { task_id: "left", worktree: "wt-left", branch: "sortie/left", base_sha: SHA_A, depends_on: [], scope: left },
      { task_id: "right", worktree: "wt-right", branch: "sortie/right", base_sha: SHA_A, depends_on: dependsOnLeft ? ["left"] : [], scope: right },
    ],
    artifacts: [],
    failure: null,
    baseline_metrics: {
      wall_clock_ms: 0,
      total_tokens: null,
      estimated_cost_usd: null,
      conflict_count: 0,
      validation_count: 0,
    },
  };
}

test("external and runtime schemas accept the same canonical contract", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../src/schema/worktree-parallel-v0.1.schema.json", import.meta.url),
    "utf8",
  ));
  const validateExternal = new Ajv2020({ strict: true }).compile(schema);
  const candidate = contract(
    { read: ["src/shared.ts"], write: ["src/a.ts"] },
    { read: ["src/shared.ts"], write: ["src/b.ts"] },
  );
  const before = structuredClone(candidate);

  assert.equal(validateExternal(candidate), true, JSON.stringify(validateExternal.errors));
  const runtime = validateWorktreeParallelSchema(candidate);
  assert.equal(runtime.ok, true);
  assert.strictEqual(runtime.value, candidate);
  assert.deepEqual(candidate, before);
  assert.deepEqual(validateWorktreeParallelContract(candidate), { ok: true, diagnostics: [] });
});

test("scope fixture fixes write/write, read/write, ancestor, and segment expectations", async () => {
  const matrix = JSON.parse(await readFile(
    new URL("./fixtures/worktree-parallel-scope-matrix.json", import.meta.url),
    "utf8",
  )) as {
    cases: Array<{
      name: string;
      left: WorktreeFileScope;
      right: WorktreeFileScope;
      depends_on_left?: boolean;
      ok: boolean;
    }>;
  };

  assert.equal(matrix.cases.length, 8);
  for (const entry of matrix.cases) {
    const result = validateWorktreeParallelContract(contract(entry.left, entry.right, entry.depends_on_left));
    assert.equal(result.ok, entry.ok, entry.name);
    assert.equal(result.diagnostics.some(({ code }) => code === "WTP006_SCOPE_OVERLAP"), !entry.ok, entry.name);
  }
});

test("single-worker fallback and all typed failure shapes are fixed", () => {
  const single = contract({ read: [], write: ["src/a.ts"] }, { read: [], write: ["src/b.ts"] });
  single.mode = "single-worker";
  single.max_workers = 1;
  single.tasks = [single.tasks[0]!];
  assert.equal(validateWorktreeParallelContract(single).ok, true);

  for (const code of ["stale-base", "dirty-tree", "abandoned-worker", "merge-conflict"] as const) {
    single.failure = { code, task_id: "left", fallback: "stop", detail: "bounded evidence" };
    assert.equal(validateWorktreeParallelSchema(single).ok, true, code);
    assert.equal(validateWorktreeParallelContract(single).ok, true, code);
  }
  single.failure = { code: "scope-overlap", task_id: "left", fallback: "single-worker", detail: "repartition" };
  assert.equal(validateWorktreeParallelContract(single).ok, true);

  single.failure = { code: "dirty-tree", task_id: "left", fallback: "single-worker", detail: "unsafe fallback" };
  assert.deepEqual(validateWorktreeParallelContract(single).diagnostics.map(({ code }) => code), ["WTP008_FAILURE_POLICY"]);
});

test("DAG identity, cycle, path, mode, artifact, and metrics boundaries fail closed", () => {
  const candidate = contract({ read: [], write: ["src/a.ts"] }, { read: [], write: ["src/b.ts"] });
  candidate.tasks[1]!.worktree = "WT-LEFT";
  candidate.tasks[1]!.branch = "SORTIE/LEFT";
  candidate.tasks[0]!.depends_on = ["right"];
  candidate.tasks[1]!.depends_on = ["left"];
  candidate.tasks[1]!.scope.write = ["../escape"];
  candidate.artifacts = [{ ...artifact(), base_sha: SHA_B, changed_paths: ["src/b.ts"] }];

  const result = validateWorktreeParallelContract(candidate);
  assert.equal(result.ok, false);
  assert.deepEqual(new Set(result.diagnostics.map(({ code }) => code)), new Set([
    "WTP001_DUPLICATE_IDENTITY",
    "WTP003_DEPENDENCY_CYCLE",
    "WTP005_PATH_INVALID",
    "WTP007_ARTIFACT_MISMATCH",
  ]));

  const invalidSchema = structuredClone(candidate) as WorktreeParallelContract & { unexpected?: boolean };
  invalidSchema.unexpected = true;
  invalidSchema.baseline_metrics = {
    wall_clock_ms: -1,
    total_tokens: -1,
    estimated_cost_usd: -1,
    conflict_count: -1,
    validation_count: -1,
  };
  const schemaResult = validateWorktreeParallelSchema(invalidSchema);
  assert.equal(schemaResult.ok, false);
  assert.ok(schemaResult.diagnostics.some(({ code }) => code === "schema_additionalProperties"));
  assert.ok(schemaResult.diagnostics.some(({ code }) => code === "schema_minimum"));

  for (const path of ["src//a.ts", "src/./a.ts", "src/a.ts\nforged"]) {
    const malformed = contract({ read: [], write: [path] }, { read: [], write: ["src/b.ts"] });
    assert.deepEqual(validateWorktreeParallelContract(malformed).diagnostics.map(({ code }) => code), [
      "WTP005_PATH_INVALID",
    ]);
    if (path.includes("\n")) assert.equal(validateWorktreeParallelSchema(malformed).ok, false);
  }

  for (const maxWorkers of [4, 2.5, Number.NaN]) {
    const invalidWorkers = contract({ read: [], write: ["src/a.ts"] }, { read: [], write: ["src/b.ts"] });
    invalidWorkers.max_workers = maxWorkers;
    assert.deepEqual(validateWorktreeParallelContract(invalidWorkers).diagnostics.map(({ code }) => code), [
      "WTP004_MODE_WORKER_MISMATCH",
    ]);
    assert.equal(validateWorktreeParallelSchema(invalidWorkers).ok, false);
  }
});

test("commit artifacts stay on the task base and inside declared write scope", () => {
  const candidate = contract({ read: [], write: ["src"] }, { read: [], write: ["test"] });
  candidate.artifacts = [{
    ...artifact(),
  }];
  assert.equal(validateWorktreeParallelContract(candidate).ok, true);

  candidate.artifacts[0]!.changed_paths = ["test/a.ts"];
  assert.deepEqual(validateWorktreeParallelContract(candidate).diagnostics.map(({ code }) => code), [
    "WTP007_ARTIFACT_MISMATCH",
  ]);
});

test("commit artifacts require the immutable evidence shape and semantic identity", () => {
  const candidate = contract({ read: [], write: ["src"] }, { read: [], write: ["test"] });
  candidate.artifacts = [artifact()];
  assert.equal(validateWorktreeParallelSchema(candidate).ok, true);
  assert.equal(validateWorktreeParallelContract(candidate).ok, true);

  candidate.artifacts[0]!.branch = "sortie/right";
  assert.ok(validateWorktreeParallelContract(candidate).diagnostics.some(({ code }) => code === "WTP007_ARTIFACT_MISMATCH"));
  candidate.artifacts[0]!.branch = "sortie/left";
  candidate.artifacts.push({ ...artifact(), task_id: "left", changed_paths: ["src/a.ts"] });
  assert.ok(validateWorktreeParallelContract(candidate).diagnostics.some(({ code }) => code === "WTP007_ARTIFACT_MISMATCH"));

  const schemaCases: Array<(value: Record<string, unknown>) => void> = [
    (value) => { value.validation = { ...value.validation as object, exit_code: 1 }; },
    (value) => { value.change_fingerprint = "F".repeat(64); },
    (value) => { value.raw_log = "forbidden"; },
  ];
  for (const mutate of schemaCases) {
    const malformed = structuredClone(artifact()) as Record<string, unknown>;
    mutate(malformed);
    const subject = contract({ read: [], write: ["src"] }, { read: [], write: ["test"] });
    subject.artifacts = [malformed as WorktreeParallelContract["artifacts"][number]];
    assert.equal(validateWorktreeParallelSchema(subject).ok, false);
  }

  const relative = contract({ read: [], write: ["src"] }, { read: [], write: ["test"] });
  relative.artifacts = [{ ...artifact(), validation: { ...artifact().validation, command: ["node"] } }];
  assert.ok(validateWorktreeParallelContract(relative).diagnostics.some(({ code }) => code === "WTP007_ARTIFACT_MISMATCH"));
});
