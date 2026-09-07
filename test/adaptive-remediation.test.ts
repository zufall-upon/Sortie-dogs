import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { selectAdaptiveRemediation, type AdaptiveEligibilityInput } from "../src/core/adaptive-eligibility.ts";
import { compareAdaptiveSignal } from "../src/core/adaptive-signal-comparison.ts";
import { decideAdaptiveProgression } from "../src/core/adaptive-progression.ts";
import { validateAdaptiveRemediationSchema } from "../src/core/validate-schema.ts";
import type { AdaptiveRemediationContract } from "../src/core/types.ts";

const eligible = (platform: "windows" | "wsl" = "windows"): AdaptiveEligibilityInput => ({ platform,
  canonical_validation_expensive: true, repeatable_typed_signal: true, signal_id: "errors", signal_definition: "typed count",
  patch_reversible: true, patch_isolated: true, scope_bounded: true, security_sensitive: false, schema_migration: false,
  release_or_publication: false, irreversible_external_operation: false, explicit_standard_override: false });

test("admission auto-selects on both platforms and fail-closes every exclusion", () => {
  for (const platform of ["windows", "wsl"] as const) assert.deepEqual(selectAdaptiveRemediation(eligible(platform)), {
    status: "selected", selection: { mode: "adaptive-remediation", reason: "eligible-auto", activation_reason: "eligible", platform }, detail_reason: "eligible" });
  for (const field of ["security_sensitive", "schema_migration", "release_or_publication", "irreversible_external_operation", "explicit_standard_override"] as const) {
    assert.equal(selectAdaptiveRemediation({ ...eligible(), [field]: true }).status, "selected");
    assert.equal((selectAdaptiveRemediation({ ...eligible(), [field]: true }) as any).selection.mode, "standard");
  }
});

test("signal comparison uses declared direction and threshold without a universal goal", () => {
  const signal = { signal_id: "errors", improvement_direction: "decrease" as const, absolute_improvement_threshold: 2 };
  for (const [value, outcome] of [[7, "improved"], [9, "unchanged"], [11, "worse"], [null, "inconclusive"]] as const) {
    assert.deepEqual(compareAdaptiveSignal({ signal, baseline: { signal_id: "errors", value: 10 }, current: { signal_id: "errors", value } }), { status: "compared", outcome });
  }
});

test("schema and progression require post-merge VERIFIED, not promotion alone", async () => {
  const hash = "a".repeat(40), fingerprint = "f".repeat(64);
  const validation = (status: "pending" | "pass" = "pending") => ({ command: [process.execPath], status,
    exit_code: status === "pass" ? 0 : null, fingerprint: status === "pass" ? fingerprint : null } as const);
  const value: AdaptiveRemediationContract = { version: "0.1.0", task_id: "adaptive", selection: {
    mode: "adaptive-remediation", reason: "eligible-auto", activation_reason: "eligible", platform: "windows" }, state: "MERGED",
    target: { ref: "refs/heads/target", base_head: hash, base_tree: hash }, allowed_paths: { read: [], write: ["score.txt"] },
    limits: { iteration_budget: 1, max_changed_paths: 1, cleanup_timeout_ms: 1000 },
    probe_validation: { executable: process.execPath, timeout_ms: 1000, observation_path: "signal.json" },
    canonical_validation: { executable: process.execPath, timeout_ms: 1000 }, improvement_signals: [{ signal_id: "errors",
      improvement_direction: "decrease", absolute_improvement_threshold: 1, goal: { operator: "at-most", value: 0 } }],
    risk_class: "low", post_merge_validation: { executable: process.execPath, timeout_ms: 1000 },
    baseline_probe: { signal_id: "errors", value: 1, artifact_fingerprint: fingerprint }, iterations: [{ iteration: 1,
      parent_candidate: hash, candidate_head: "b".repeat(40), hypothesis: "remove one error", patch_fingerprint: fingerprint,
      changed_paths: ["score.txt"], measured_probe: { signal_id: "errors", baseline_value: 1, current_value: 0,
        outcome: "improved", artifact_fingerprint: fingerprint }, cleanup: { status: "pass", remaining_paths: [] } }],
    converged: true, full_validation: validation("pass"), review: { status: "pass", fingerprint, remediation_attempts: 0 },
    promotion: { status: "promoted", expected_target_head: hash, observed_target_head: "b".repeat(40), candidate_head: "b".repeat(40) },
    post_merge: validation(), failure: null, metrics: { mode: "adaptive-remediation", reason: "eligible-auto", activation_reason: "eligible",
      iteration_count: 1, probe_count: 2, full_validation_count: 1, post_merge_validation_count: 0, discarded_patch_count: 0,
      time_to_first_signal_ms: 1, duration_ms: 2, total_tokens: null, estimated_cost_usd: null, sol_demotions: 0, cas_conflicts: 0, post_merge_failures: 0 } };
  const schema = JSON.parse(await readFile(new URL("../src/schema/adaptive-remediation-v0.1.schema.json", import.meta.url), "utf8"));
  assert.equal(new Ajv2020({ strict: true }).compile(schema)(value), true);
  assert.equal(validateAdaptiveRemediationSchema(value).ok, true);
  assert.deepEqual(decideAdaptiveProgression(value), { kind: "request", request: { phase: "post-merge-validation" } });
  (value as any).state = "VERIFIED"; (value as any).post_merge = validation("pass"); (value as any).metrics.post_merge_validation_count = 1;
  assert.deepEqual(decideAdaptiveProgression(value), { kind: "complete" });
});
