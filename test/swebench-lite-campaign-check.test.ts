import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { admission, checkBudget, inspectCampaign, nextAdmission } from "../scripts/swebench-lite-campaign-check.mjs";

const hash = (data: string) => createHash("sha256").update(data).digest("hex");
const json = (value: unknown) => `${JSON.stringify(value)}\n`;

test("unknown pricing is held against the original reservation, never treated as free budget", () => {
  assert.deepEqual(checkBudget(0.57667964, 1.42332036, 2), {
    spent_usd: 0.57667964, held_unknown_usd: 1.42332036, exposure_usd: 2,
  });
  assert.throws(() => checkBudget(0.8, 1.3, 2), /cost-plus-held-exceeds-original-cap/);
});

test("refill slots prefer ordinary images, keep heavy images through scoring cleanup, and recheck disk", () => {
  const heavy = { repo: "pydata/xarray", instance_id: "heavy" };
  const ordinary = { repo: "django/django", instance_id: "ordinary" };
  assert.equal(nextAdmission([heavy, ordinary], { freeGiB: 18 })?.instance_id, "ordinary");
  assert.equal(admission(heavy, { freeGiB: 21, heavyOutstanding: 0 }), "heavy-image-disk-guard");
  assert.equal(admission(heavy, { freeGiB: 20, heavyOutstanding: 1 }), null);
  assert.equal(admission(heavy, { freeGiB: 40, heavyOutstanding: 2 }), "heavy-image-limit");
  assert.equal(admission(ordinary, { freeGiB: 11 }), "disk-too-low-for-new-inference");
  assert.equal(admission(ordinary, { freeGiB: 30, pendingScoring: 4 }), "score-or-cleanup-backlog");
  assert.equal(admission(ordinary, { freeGiB: 30, activeSlots: 4 }), "all-inference-slots-busy");
});

test("a handoff scores frozen terminal predictions first and never retries an active attempt", async t => {
  const tempBase = join(tmpdir(), "opencode");
  await mkdir(tempBase, { recursive: true });
  const root = await mkdtemp(join(tempBase, "swebench-lite-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = join(root, "manifest.json"), planPath = join(root, "plan.json");
  const campaignDir = join(root, "campaign"), packagePath = join(root, "candidate.tgz");
  const ids = Array.from({ length: 300 }, (_, i) => `repo__case-${i}`);
  const rows = ids.map(instance_id => ({ instance_id, repo: "django/django" }));
  await writeFile(packagePath, "fixed candidate");
  const manifestText = json({ dataset: { id: "princeton-nlp/SWE-bench_Lite", split: "test" },
    candidate: { sha256: hash("fixed candidate") }, instances: rows });
  await writeFile(manifestPath, manifestText);
  const plan = { manifest_sha256: hash(manifestText), candidate_package_sha256: hash("fixed candidate"),
    total_conservative_exposure_usd: 600,
    policy: { attempts_per_instance: 1, max_workers: 4, per_instance_usd: 2 },
    batches: ids.map(instance_id => ({ instance_ids: [instance_id], images: ["image"], cost_limit_usd: 2 })) };
  await writeFile(planPath, json(plan));
  const terminal = join(campaignDir, "batches", "000"), scored = join(campaignDir, "batches", "001");
  const active = join(campaignDir, "batches", "002");
  for (const dir of [terminal, scored, active]) await mkdir(join(dir, "inference"), { recursive: true });
  const state = (id: string, status: string, held = 0) => ({ status,
    policy: { attempts_per_instance: 1, retry_count: 0 }, spent_usd: 0.5, held_unknown_usd: held,
    instances: [{ instance_id: id, attempt: 1, status: status === "completed" ? "succeeded" : "running" }] });
  await writeFile(join(terminal, "inference", "supervisor-state.json"), json(state(ids[0], "completed", 1.5)));
  await writeFile(join(terminal, "inference", "predictions.jsonl"), json({ instance_id: ids[0], model_patch: "diff" }));
  await writeFile(join(scored, "inference", "supervisor-state.json"), json(state(ids[1], "completed")));
  const prediction = json({ instance_id: ids[1], model_patch: "diff" });
  await writeFile(join(scored, "inference", "predictions.jsonl"), prediction);
  await mkdir(join(scored, "scoring"));
  await writeFile(join(scored, "scoring", "report.json"), "official output");
  await writeFile(join(scored, "receipt.json"), json({ ids: [ids[1]], spent_usd: 0.5, held_unknown_usd: 0,
    predictions_sha256: hash(prediction), report_sha256: hash("official output") }));
  await writeFile(join(active, "inference", "supervisor-state.json"), json(state(ids[2], "running")));

  const options = { manifestPath, planPath, campaignDir, packagePath };
  const result = await inspectCampaign(options);
  assert.deepEqual(result.score_only, [ids[0]]);
  assert.deepEqual(result.scored, [ids[1]]);
  assert.deepEqual(result.needs_attention, [ids[2]]);
  assert.equal(result.infer.length, 297);
  assert.equal(result.new_known_spent_usd, 1.5);
  assert.equal(result.new_held_unknown_usd, 1.5);
  assert.equal(result.total_known_spent_usd, null);
  assert.equal(result.prior_cost_note, null);
  assert.match(result.next_step, /do-not-reinfer/);
  await writeFile(join(terminal, "receipt.json"), json({ ids: [ids[1]] }));
  await assert.rejects(inspectCampaign(options), /not-one-attempt|duplicate-attempt/);
  assert.equal((await readFile(join(scored, "receipt.json"), "utf8")).includes(ids[1]), true);
});
