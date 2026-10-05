import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CodexProtectedEvidenceCapture } from "../dist/codex/protected-evidence.js";
import type { GoalFlightState } from "../dist/core/goal-bound.js";

const command = "node verify.js";

test("Codex protected capture emits existing goal evidence only while the protected snapshot stays fresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "sortie-codex-protected-"));
  const manifestPath = join(root, "operation-manifest.json");
  const manifest = JSON.stringify({ version: "0.1.0", task_id: "codex-protected", read: ["hello.txt"],
    write: ["hello.txt"], validation: [command] });
  await writeFile(join(root, "hello.txt"), "ready\n");
  await writeFile(manifestPath, manifest);
  const criterion = { criterion_id: "criterion-1", target: "hello.txt", entrypoint: "node", workload: "verify",
    oracle_coverage: ["content"], build_boundary: "not-applicable" as const, source: "declared-source",
    candidate: "declared-candidate", source_binding: "current-protected" as const,
    candidate_binding: "current-protected" as const, validation_command: command, fixture: "fixture-1",
    proof_scope: "requested-full" as const, expected_outcome: "pass" as const };
  const goalState: Pick<GoalFlightState, "goal_id" | "revision" | "scope_epoch" | "acceptance_fingerprint" | "acceptance_contract"> = {
    goal_id: "goal-1", revision: 1, scope_epoch: 1, acceptance_fingerprint: "fingerprint-1",
    acceptance_contract: { criteria: [criterion] },
  };
  const capture = await CodexProtectedEvidenceCapture.admit({ manifestPath,
    manifestHash: createHash("sha256").update(manifest).digest("hex"), projectRoot: root, goalState,
    unitID: "unit-1", declaredValidation: [command], owner: "coordinator" });
  assert.ok(capture);
  const request = { turn: { threadID: "thread-1", turnID: "turn-1", status: "completed", items: [] },
    validationExecutions: [{ item: { id: "cmd-1", type: "commandExecution", command, status: "completed", exitCode: 0 },
      commands: [command] }],
    declaredValidation: [command] };
  const evidence = await capture.capture(request);
  assert.equal(evidence.length, 1);
  assert.ok(evidence[0]!.protected_binding);
  assert.deepEqual(evidence[0]!.measurement.criterion_ids, ["criterion-1"]);
  await writeFile(join(root, "hello.txt"), "changed\n");
  assert.deepEqual(await capture.capture(request), []);
});

test("Codex protected capture rejects a manifest validation contract different from the admitted declaration", async () => {
  const root = await mkdtemp(join(tmpdir(), "sortie-codex-contract-"));
  const manifestPath = join(root, "operation-manifest.json");
  const manifest = JSON.stringify({ version: "0.1.0", task_id: "codex-contract", read: ["hello.txt"],
    write: ["hello.txt"], validation: ["node other.js"] });
  await writeFile(join(root, "hello.txt"), "ready\n");
  await writeFile(manifestPath, manifest);
  const criterion = { criterion_id: "criterion-1", target: "hello.txt", entrypoint: "node", workload: "verify",
    oracle_coverage: ["content"], build_boundary: "not-applicable" as const, source: "source", candidate: "candidate",
    validation_command: command, fixture: "fixture", proof_scope: "requested-full" as const, expected_outcome: "pass" as const };
  const capture = await CodexProtectedEvidenceCapture.admit({ manifestPath,
    manifestHash: createHash("sha256").update(manifest).digest("hex"), projectRoot: root,
    goalState: { goal_id: "goal", revision: 1, scope_epoch: 1, acceptance_fingerprint: "fingerprint",
      acceptance_contract: { criteria: [criterion] } }, unitID: "unit", declaredValidation: [command], owner: "coordinator" });
  assert.equal(capture, undefined);
});
