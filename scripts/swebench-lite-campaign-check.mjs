#!/usr/bin/env node
// Read-only guard for the next SWE-bench Lite pass@1 campaign. Run before launch,
// after every controller handoff, and before assembling the final report:
//   node scripts/swebench-lite-campaign-check.mjs --manifest manifest.json \
//     --plan plan.json --campaign campaign-dir
// It does not start inference, score, pull/remove images, or edit receipts. The
// inference controller must act only on `infer`, serialize scoring and image pulls,
// recheck disk at the pull boundary, and freeze one prediction per ID. A running
// or interrupted supervisor is NEVER an invitation to infer the same ID again.
// These disk thresholds came from the v0.12.24 Lite-300 host and its image sizes;
// measure the next host before reusing them. This is a guard, not an orchestrator.

import { createHash } from "node:crypto";
import { readFile, readdir, statfs } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GiB = 1024 ** 3;
export const DISK = Object.freeze({ ordinary: 12, firstHeavy: 22, secondHeavy: 20,
  beforePull: 10, beforeInference: 8, runningStop: 4 });
export const HEAVY_REPOS = new Set(["matplotlib/matplotlib", "scikit-learn/scikit-learn", "pydata/xarray"]);
const assert = (ok, message) => { if (!ok) throw Error(message); };
const json = async path => JSON.parse(await readFile(path, "utf8"));
const digest = data => createHash("sha256").update(data).digest("hex");
const sha = async path => digest(await readFile(path));
const exists = async path => readFile(path).then(() => true, error => {
  if (error.code === "ENOENT") return false;
  throw error;
});

// Keep priced and unpriced usage separate. An unknown price holds the remaining
// original reservation; it is NOT zero spend and must not trigger a retry.
export function checkBudget(spent, heldUnknown, cap) {
  assert([spent, heldUnknown, cap].every(x => Number.isFinite(x) && x >= 0), "invalid-cost-or-hold");
  assert(spent + heldUnknown <= cap + 1e-8, "cost-plus-held-exceeds-original-cap");
  return { spent_usd: spent, held_unknown_usd: heldUnknown, exposure_usd: spent + heldUnknown };
}

export function admission(task, { freeGiB, activeSlots = 0, heavyOutstanding = 0,
  pendingScoring = 0, maxSlots = 4, maxHeavy = 2 } = {}) {
  assert(Number.isFinite(freeGiB) && freeGiB >= 0, "invalid-disk-availability");
  assert(Number.isInteger(activeSlots) && Number.isInteger(heavyOutstanding) &&
    Number.isInteger(pendingScoring) && activeSlots >= 0 && heavyOutstanding >= 0 && pendingScoring >= 0,
  "invalid-slot-counters");
  if (activeSlots >= maxSlots) return "all-inference-slots-busy";
  if (pendingScoring >= maxSlots) return "score-or-cleanup-backlog";
  if (freeGiB < DISK.ordinary) return "disk-too-low-for-new-inference";
  if (!HEAVY_REPOS.has(task.repo)) return null;
  // Count a heavy image until its serialized official score AND owned-image
  // cleanup finish, not merely until inference frees a slot.
  if (heavyOutstanding >= maxHeavy) return "heavy-image-limit";
  if (freeGiB < (heavyOutstanding === 0 ? DISK.firstHeavy : DISK.secondHeavy)) return "heavy-image-disk-guard";
  return null;
}

export function nextAdmission(pending, context) {
  const index = pending.findIndex(task => admission(task, context) === null);
  return index < 0 ? null : pending[index]; // never pop a task before its pull is admitted
}

export function plannedIds(plan, manifest) {
  const prior = [plan.prior_smoke?.instance_id, ...(plan.prior_pilot?.instance_ids ?? [])].filter(Boolean);
  const batches = plan.batches ?? [];
  const newIds = batches.flatMap(batch => batch.instance_ids ?? []);
  const ids = [...prior, ...newIds];
  const manifestIds = manifest.instances?.map(row => row.instance_id) ?? [];
  assert(manifest.dataset?.split === "test" && /SWE-bench_Lite/.test(manifest.dataset.id), "not-lite-test");
  assert(manifestIds.length === 300 && new Set(manifestIds).size === 300 && ids.length === 300 &&
    new Set(ids).size === 300 && ids.every(id => manifestIds.includes(id)), "not-300-distinct-frozen-ids");
  assert(plan.policy?.attempts_per_instance === 1 && plan.policy?.per_instance_usd > 0 &&
    plan.policy?.max_workers <= 4 && plan.policy?.max_workers > 0 &&
    plan.total_conservative_exposure_usd >= 300 * plan.policy.per_instance_usd,
  "not-bounded-pass-at-one");
  assert(batches.every(b => b.instance_ids?.length === b.images?.length &&
    b.cost_limit_usd === b.instance_ids.length * plan.policy.per_instance_usd), "batch-reservation-mismatch");
  return { prior, newIds };
}

// A receipt is scored; terminal inference without a receipt is SCORE_ONLY;
// running/paused/failed inference needs an operator decision, never a retry.
// A mismatched receipt or missing frozen prediction stops the entire handoff.
export async function inspectCampaign({ manifestPath, planPath, campaignDir, packagePath }) {
  const [manifest, plan] = await Promise.all([json(manifestPath), json(planPath)]);
  const { prior, newIds } = plannedIds(plan, manifest);
  assert(plan.manifest_sha256 === await sha(manifestPath), "manifest-hash-changed");
  assert(plan.candidate_package_sha256 === manifest.candidate?.sha256, "candidate-identity-changed");
  assert(plan.candidate_package_sha256 === await sha(packagePath), "candidate-package-changed");
  if (plan.prior_smoke) {
    const original = resolve(dirname(planPath), plan.prior_smoke.predictions_path ?? "smoke-run/predictions.jsonl");
    assert(plan.prior_smoke.prediction_sha256 === await sha(original), "prior-smoke-prediction-changed");
  }
  if (plan.prior_pilot) {
    const original = resolve(dirname(planPath), plan.prior_pilot.predictions_path ?? "pilot4-scoring/predictions.jsonl");
    assert(plan.prior_pilot.predictions_sha256 === await sha(original), "prior-pilot-predictions-changed");
  }
  const target = new Set(newIds);
  const scored = new Set(), scoreOnly = new Set(), attention = new Set();
  let priced = 0, held = 0;
  const batchDir = join(campaignDir, "batches");
  const entries = await readdir(batchDir, { withFileTypes: true }).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const root = join(batchDir, entry.name), receiptPath = join(root, "receipt.json");
    const supervisorPath = join(root, "inference", "supervisor-state.json");
    const predictionPath = join(root, "inference", "predictions.jsonl");
    const [hasReceipt, hasSupervisor] = await Promise.all([exists(receiptPath), exists(supervisorPath)]);
    if (!hasReceipt && !hasSupervisor) continue;
    const record = hasReceipt ? await json(receiptPath) : await json(supervisorPath);
    const ids = hasReceipt ? record.ids : record.instances?.map(x => x.instance_id);
    assert(ids?.length && new Set(ids).size === ids.length && ids.every(id => target.has(id)),
      `unplanned-or-duplicate-id:${entry.name}`);
    for (const id of ids) assert(!scored.has(id) && !scoreOnly.has(id) && !attention.has(id), `duplicate-attempt:${id}`);
    if (hasSupervisor) {
      const state = await json(supervisorPath);
      assert(state.policy?.attempts_per_instance === 1 && state.policy?.retry_count === 0 &&
        state.instances.length === ids.length && state.instances.every((x, i) => x.attempt === 1 && x.instance_id === ids[i]),
      `not-one-attempt:${entry.name}`);
      // Receipt cost already includes this supervisor; never double-count it.
      if (!hasReceipt) {
        const cost = checkBudget(state.spent_usd, state.held_unknown_usd ?? 0,
          ids.length * plan.policy.per_instance_usd);
        priced += cost.spent_usd;
        held += cost.held_unknown_usd;
      }
      if (hasReceipt) assert(state.status === "completed", `scored-nonterminal-inference:${entry.name}`);
    }
    if (hasReceipt) {
      assert(hasSupervisor, `receipt-without-supervisor:${entry.name}`);
      assert(await exists(predictionPath) && record.predictions_sha256 === await sha(predictionPath),
        `scored-predictions-changed:${entry.name}`);
      const reportFiles = (await readdir(join(root, "scoring"))).filter(name => name.endsWith(".json"));
      assert(reportFiles.length === 1 && record.report_sha256 === await sha(join(root, "scoring", reportFiles[0])),
        `scored-report-changed:${entry.name}`);
      const cost = checkBudget(record.spent_usd, record.held_unknown_usd ?? 0,
        ids.length * plan.policy.per_instance_usd);
      priced += cost.spent_usd;
      held += cost.held_unknown_usd;
      ids.forEach(id => scored.add(id));
    } else if (record.status === "completed" && record.instances.every(x =>
      !["pending", "running", "not-run-cost-limit"].includes(x.status))) {
      assert(await exists(predictionPath), `terminal-without-frozen-predictions:${entry.name}`);
      const lines = (await readFile(predictionPath, "utf8")).trim().split("\n").map(JSON.parse);
      assert(lines.length === ids.length && lines.every((x, i) => x.instance_id === ids[i] &&
        typeof x.model_patch === "string"), `terminal-predictions-invalid:${entry.name}`);
      ids.forEach(id => scoreOnly.add(id));
    } else {
      ids.forEach(id => attention.add(id));
    }
  }
  const infer = newIds.filter(id => !scored.has(id) && !scoreOnly.has(id) && !attention.has(id));
  assert(priced + held <= plan.total_conservative_exposure_usd + 1e-8, "campaign-exposure-exceeded");
  const finalPath = join(campaignDir, "final-summary.json");
  let finalVerified = false;
  let totalKnownSpend = null;
  if (await exists(finalPath)) {
    const final = await json(finalPath);
    const priorSpent = final.prior_spent_usd ?? final.initial_five_spent_usd ?? (prior.length ? NaN : 0);
    const reports = (await readdir(campaignDir)).filter(name => name.endsWith(`.${final.run_id}.json`));
    assert(infer.length === 0 && attention.size === 0 && scoreOnly.size === 0 &&
      scored.size + prior.length === 300 && final.total === 300 && final.submitted === 300 &&
      final.candidate_sha256 === plan.candidate_package_sha256 && final.manifest_sha256 === plan.manifest_sha256 &&
      final.predictions_sha256 === await sha(join(campaignDir, "predictions-300.jsonl")) &&
      reports.length === 1 && final.report_sha256 === await sha(join(campaignDir, reports[0])) &&
      Math.abs(final.new_spent_usd - priced) < 1e-8 &&
      Math.abs(final.new_held_unknown_usd - held) < 1e-8 &&
      Number.isFinite(priorSpent) && priorSpent >= 0,
    "final-report-or-predictions-changed");
    finalVerified = true;
    totalKnownSpend = priorSpent + priced;
  }
  // Receipts here cover only new IDs. Prior smoke/pilot spending is accounted
  // separately in their original records; never call this the campaign total.
  return { prior_protected: prior, scored: [...scored], score_only: [...scoreOnly], needs_attention: [...attention],
    infer, new_known_spent_usd: priced, new_held_unknown_usd: held,
    total_known_spent_usd: totalKnownSpend,
    prior_cost_note: prior.length ? "new_known_spent_usd excludes prior smoke/pilot; total_known_spent_usd includes them only when the hash-checked final summary provides prior spend." : null,
    max_exposure_usd: plan.total_conservative_exposure_usd,
    final_report_verified: finalVerified,
    next_step: finalVerified ? "complete; preserve-original-evidence" :
      attention.size ? "inspect-active-or-interrupted-attempts; do-not-reinfer" :
      scoreOnly.size ? "score-frozen-predictions-first; do-not-reinfer" : infer.length ?
        "admit-new-ids-with-disk-and-heavy-guards" : "assemble-one-final-300-case-report" };
}

async function main() {
  const flags = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, args) => {
    if (index % 2 === 0) pairs.push([value, args[index + 1]]);
    return pairs;
  }, []));
  assert(process.argv.length === 8, "usage: --manifest FILE --plan FILE --campaign DIR");
  assert(flags["--manifest"] && flags["--plan"] && flags["--campaign"] &&
    Object.keys(flags).every(key => ["--manifest", "--plan", "--campaign"].includes(key)),
  "missing-or-unknown-option");
  const manifestPath = resolve(flags["--manifest"]);
  const manifest = await json(manifestPath);
  const packagePath = resolve(dirname(manifestPath), manifest.candidate.package_tgz);
  const status = await inspectCampaign({ manifestPath, planPath: resolve(flags["--plan"]),
    campaignDir: resolve(flags["--campaign"]), packagePath });
  const s = await statfs(resolve(flags["--campaign"])).catch(error => {
    if (error.code === "ENOENT") return statfs(dirname(resolve(flags["--campaign"])));
    throw error;
  });
  const freeGiB = s.bavail * s.bsize / GiB;
  const remaining = status.infer.map(id => {
    const row = manifest.instances.find(x => x.instance_id === id);
    return { instance_id: id, repo: row.repo };
  });
  console.log(JSON.stringify({ ...status, free_gib: freeGiB,
    next_admissible: status.needs_attention.length || status.score_only.length ? null :
      nextAdmission(remaining, { freeGiB })?.instance_id ?? null,
    guards: { ...DISK, heavy_concurrency: 2, inference_slots: 4, scoring_workers: 1,
      note: "Recheck disk at serialized pull; stop active inference below runningStop; cleanup only owned images after scoring." },
    submission: status.final_report_verified ?
      "Use a separate current upstream swebench submit CLI (scorer 5.0.2 has no submit): export original inference-time trajectories, audit secrets/solution access, package existing frozen predictions and official logs without re-inference or Docker re-scoring, verify locally and from the published artifacts before requesting review." : null,
  }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(String(error)); process.exitCode = 1; });
}
