import assert from "node:assert/strict";
import test from "node:test";
import { AdaptiveRemediationRuntime, type AdaptiveCandidate, type AdaptiveRemediationRequest,
  type AdaptiveRemediationRuntimeHost } from "../dist/core/adaptive-remediation-runtime.js";

const A = "a".repeat(40), B = "b".repeat(40), F = "f".repeat(64);
const request = (platform: "windows" | "wsl" = "windows"): AdaptiveRemediationRequest => ({ task_id: "adaptive",
  eligibility: { platform, canonical_validation_expensive: true, repeatable_typed_signal: true, signal_id: "errors",
    signal_definition: "typed errors", patch_reversible: true, patch_isolated: true, scope_bounded: true,
    security_sensitive: false, schema_migration: false, release_or_publication: false,
    irreversible_external_operation: false, explicit_standard_override: false }, target_ref: "refs/heads/target",
  allowed_paths: { read: ["probe.mjs"], write: ["score.txt"] }, iteration_budget: 2, max_changed_paths: 1,
  cleanup_timeout_ms: 1000, probe_validation: { executable: process.execPath, args: ["probe.mjs", "{observation_path}"],
    timeout_ms: 1000, observation_path: "signal.json" }, canonical_validation: { executable: process.execPath, timeout_ms: 1000 },
  improvement_signal: { signal_id: "errors", improvement_direction: "decrease", absolute_improvement_threshold: 1,
    goal: { operator: "at-most", value: 1 } }, risk_class: "medium",
  post_merge_validation: { executable: process.execPath, timeout_ms: 1000 }, acceptance: ["reach declared signal goal"] });

class Host implements AdaptiveRemediationRuntimeHost {
  probeValues = [2, 1]; cleanup = true; reviewStatus: "pass" | "remediation-required" | "fail" = "pass";
  cas: "promoted" | "cas-drift" = "promoted"; post: "pass" | "fail" = "pass"; canonicalCount = 0; postCount = 0;
  targetHead = A; opened = 0; reserved = 0; released = false;
  async snapshotTarget() { return { head: this.targetHead, tree: B }; }
  async openCandidate(parentHead: string) { this.opened += 1; return { worktree_id: `w${this.opened}`, path: `/w${this.opened}`, parent_head: parentHead }; }
  async runBaselineProbe() { return { command: [process.execPath], exit_code: 0, fingerprint: F, signal_id: "errors", value: 3 }; }
  async reserveProbe() { this.reserved += 1; return `r${this.reserved}`; }
  async finishProbe() {}
  async producePatch(input: { candidate: AdaptiveCandidate; iteration: 1 | 2 | 3 }) {
    const value = this.probeValues[input.iteration - 1] ?? this.probeValues.at(-1)!;
    return { candidate: input.candidate, candidate_head: input.iteration === 1 ? B : "c".repeat(40),
      hypothesis: `lower errors ${input.iteration}`, patch_fingerprint: F, changed_paths: ["score.txt"],
      probe: { command: [process.execPath], exit_code: 0, fingerprint: F, signal_id: "errors", value } };
  }
  async inspectCleanup() { return { ok: this.cleanup, remaining_paths: this.cleanup ? [] : ["residue.tmp"] }; }
  async discardCandidate() {}
  async runCanonical() { this.canonicalCount += 1; return { command: [process.execPath], status: "pass" as const, exit_code: 0, fingerprint: F }; }
  async review() { return { status: this.reviewStatus, fingerprint: F }; }
  async promote(input: { candidate_head: string }) { if (this.cas === "promoted") this.targetHead = input.candidate_head;
    return { status: this.cas, observed_head: this.targetHead }; }
  async runPostMerge() { this.postCount += 1; return { command: [process.execPath], status: this.post, exit_code: this.post === "pass" ? 0 : 1, fingerprint: F }; }
  async release() { this.released = true; return { ok: true, remaining_paths: [] }; }
}

test("runtime auto-selects, converges, validates canonically once, reviews, CASes and verifies", async () => {
  for (const platform of ["windows", "wsl"] as const) {
    const host = new Host();
    const result = await new AdaptiveRemediationRuntime(host).execute(request(platform));
    assert.equal(result.state, "VERIFIED", JSON.stringify(result)); assert.equal(result.selection.mode, "adaptive-remediation");
    assert.equal(result.metrics.probe_count, 3); assert.equal(host.canonicalCount, 1); assert.equal(host.postCount, 1);
    assert.equal(result.full_validation.status, "pass"); assert.equal(result.post_merge.status, "pass"); assert.equal(host.released, true);
  }
});

test("standard fallback performs no probe, validation, review or CAS", async () => {
  const host = new Host(); const value = request();
  (value.eligibility as any).security_sensitive = true;
  const result = await new AdaptiveRemediationRuntime(host).execute(value);
  assert.equal(result.selection.mode, "standard"); assert.equal(result.metrics.probe_count, 0); assert.equal(host.opened, 0); assert.equal(host.canonicalCount, 0);
});

test("no improvement abandons and never runs canonical", async () => {
  const host = new Host(); host.probeValues = [3];
  const result = await new AdaptiveRemediationRuntime(host).execute(request());
  assert.equal(result.state, "ABANDONED"); assert.equal(result.failure?.code, "NO_IMPROVEMENT"); assert.equal(result.metrics.discarded_patch_count, 1); assert.equal(host.canonicalCount, 0);
});

test("budget exhaustion demotes without resetting the bounded iteration count", async () => {
  const host = new Host(); host.probeValues = [2, 1]; const value = request();
  (value.improvement_signal.goal as any).value = 0;
  const result = await new AdaptiveRemediationRuntime(host).execute(value);
  assert.equal(result.state, "SOL_DEMOTED"); assert.equal(result.failure?.code, "ITERATION_BUDGET_EXHAUSTED"); assert.equal(result.iterations.length, 2); assert.equal(host.reserved, 2); assert.equal(host.canonicalCount, 0);
});

test("cleanup, review remediation, CAS drift and post-merge failure stay typed", async () => {
  const cases = [
    { configure: (host: Host) => { host.cleanup = false; }, state: "ABANDONED", code: "CLEANUP_FAILED" },
    { configure: (host: Host) => { host.reviewStatus = "remediation-required"; }, state: "REJECTED", code: "REVIEW_REMEDIATION_REQUIRED" },
    { configure: (host: Host) => { host.cas = "cas-drift"; }, state: "REINTEGRATE_REQUIRED", code: "CAS_DRIFT" },
    { configure: (host: Host) => { host.post = "fail"; }, state: "MERGED", code: "POST_MERGE_VERIFICATION_FAILED" },
  ] as const;
  for (const scenario of cases) {
    const host = new Host(); scenario.configure(host);
    const result = await new AdaptiveRemediationRuntime(host).execute(request());
    assert.equal(result.state, scenario.state); assert.equal(result.failure?.code, scenario.code);
    if (scenario.code === "CLEANUP_FAILED") assert.equal(host.canonicalCount, 0);
  }
});
