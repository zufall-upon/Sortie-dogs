import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { userProxyBench } from './user-proxy-bench.mjs';
import { writeAtomicJson, writeAtomicText } from './swebench-lite-supervisor.mjs';

/** Existing supervisor protocol -> one native v0.11 inference. No scheduling or process ownership here. */
export async function runSupervisedUserProxy(options, infer = userProxyBench) {
  const manifest = JSON.parse(await readFile(options.manifest, 'utf8'));
  if (manifest.instances?.length !== 1 || !manifest.supervisor?.manifest) throw Error('supervised-single-instance-required');
  const source = JSON.parse(await readFile(manifest.supervisor.manifest, 'utf8'));
  const digest = createHash('sha256').update(JSON.stringify(source)).digest('hex');
  if (digest !== manifest.supervisor.input_sha256) throw Error('supervised-source-manifest-changed');
  const instance = manifest.instances[0];
  if (!source.instances.some(item => JSON.stringify(item) === JSON.stringify(instance))) throw Error('supervised-instance-changed');
  if (!Number.isFinite(options.costLimitUsd) || options.costLimitUsd <= 0) throw Error('supervised-cost-limit-required');
  let report, error;
  try { report = await infer(resolve(manifest.candidate.package_tgz), resolve(manifest.supervisor.manifest), instance.instance_id, resolve(options.runRoot), options.costLimitUsd); }
  catch (failure) { error = failure; report = failure.report; }
  const usage = report?.routing?.filter(row => row.kind === 'usage').at(-1);
  const spent = Number.isFinite(usage?.usd) ? usage.usd : null;
  const predictionText = report?.run ? await readFile(join(report.run, 'predictions.jsonl'), 'utf8')
    : JSON.stringify({ instance_id: instance.instance_id, model_name_or_path: 'sortie-dogs-native-unverified', model_patch: '' }) + '\n';
  const prediction = JSON.parse(predictionText.trim());
  if (prediction.instance_id !== instance.instance_id || typeof prediction.model_patch !== 'string') throw Error('supervised-prediction-invalid');
  const patchHash = createHash('sha256').update(prediction.model_patch).digest('hex');
  if (report?.patch_sha256 && report.patch_sha256 !== patchHash) throw Error('supervised-frozen-patch-changed');
  // The request-boundary snapshot excludes any later response: hold unobserved reservation conservatively.
  const result = { instance_id: instance.instance_id, status: report?.terminal ?? 'failed',
    error: error?.message ?? null, native_receipt: report?.receipt?.receipt ?? null, inference_result: report?.run ? join(report.run, 'inference-result.json') : null,
    patch_sha256: patchHash, patch_bytes: Buffer.byteLength(prediction.model_patch),
    usage: { usd: spent, complete: false } };
  await writeAtomicText(options.output, predictionText);
  await writeAtomicJson(options.metadata, { schema_version: 1, execution: { spent_usd: spent, usage_complete: false }, results: [result] });
  if (error) throw error;
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = process.argv.slice(2), value = key => args[args.indexOf(key) + 1];
  runSupervisedUserProxy({ manifest: value('--manifest'), runRoot: value('--run-root'), output: value('--output'), metadata: value('--metadata'), costLimitUsd: Number(value('--cost-limit-usd')) })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
