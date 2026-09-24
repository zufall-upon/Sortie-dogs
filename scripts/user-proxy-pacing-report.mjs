import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const read = path => readFile(path, 'utf8').then(JSON.parse);

/** No best-of selection: every run in the selected frozen comparison must be present. */
export async function pacingReport(directory, scenarios = ['known', 'bug', 'feature', 'repository', 'chain']) {
  const selected = [], failures = [], hashes = { baseline: new Set(), candidate: new Set(), driver: new Set(), repository: new Set() };
  for (const scenario of scenarios) {
    const sides = {};
    for (const mode of ['baseline', 'candidate']) {
      const root = join(directory, mode, scenario);
      const attempts = (await readdir(root)).filter(name => /^smoke-\d+$/.test(name)).sort();
      if (attempts.length !== 3) failures.push(`${scenario}/${mode}: expected exactly three retained attempts, found ${attempts.length}`);
      sides[mode] = [];
      for (const attempt of attempts) {
        let row;
        try { row = await read(join(root, attempt, 'qualification.json')); }
        catch { failures.push(`${scenario}/${mode}/${attempt}: missing result`); continue; }
        hashes[mode].add(row.sha256); hashes.driver.add(row.driver_sha256); hashes.repository.add(row.repository_driver_sha256);
        if (row.scenario !== scenario || row.mode !== mode) failures.push(`${scenario}/${mode}/${attempt}: identity mismatch`);
        if (mode === 'candidate' && (row.terminal !== 'succeeded' || row.failures.length)) failures.push(`${scenario}/${attempt}: ${row.failures.join(', ')}`);
        sides[mode].push(row);
      }
    }
    const summarize = rows => ({ target_ms: rows.map(r => r.target_ms), completion_ms: rows.map(r => r.completion_ms),
      pretarget_tools: rows.map(r => r.pretarget_tools), median_target_ms: rows.every(r => Number.isFinite(r.target_ms)) && rows.length ? median(rows.map(r => r.target_ms)) : null,
      failures: rows.map(r => r.failures), runs: rows.map(r => r.run) });
    const baseline = summarize(sides.baseline), candidate = summarize(sides.candidate);
    if (baseline.median_target_ms === null || candidate.median_target_ms === null || candidate.median_target_ms >= baseline.median_target_ms) failures.push(`${scenario}: no matched target-start improvement`);
    selected.push({ scenario, baseline, candidate });
  }
  for (const [name, values] of Object.entries(hashes)) if (values.size !== 1 || values.has(undefined)) failures.push(`${name}: mixed/missing frozen identity`);
  const report = { terminal: failures.length ? 'failed' : 'succeeded', failures, selected,
    hashes: Object.fromEntries(Object.entries(hashes).map(([name, values]) => [name, [...values]])),
    claim: 'Fixed-fixture initiation, continuity, behavior and accepted-scope comparison only. Native recovery, cost-history coverage and actual presentation require their separate receipts; this is not a universal repository success rate.' };
  await writeFile(join(directory, 'comparison.json'), JSON.stringify(report, null, 2));
  if (failures.length) throw Error(failures.join('\n'));
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) pacingReport(resolve(process.argv[2])).then(report => console.log(JSON.stringify(report, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
