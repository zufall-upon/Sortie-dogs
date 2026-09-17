// SD101-03 L2: one bounded real-CLI dogfood of the revised proposal investigation prompt.
// The fixture reads real repository source read-only and writes a single findings file, so the
// run exercises requirement mapping and ranged reading without a heavy toolchain. No raw logs saved.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { command, installedFixture } from './release-cli.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const events = text => text.split(/\r?\n/u).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const dbFile = join(process.env.XDG_DATA_HOME ?? join(os.homedir(), '.local/share'), 'opencode/opencode.db');
const SOURCES = ['profiled.ts', 'operator-proposal.ts', 'operator-runtime.ts'];

const VERIFY = `import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
const manifest = JSON.parse(await readFile("source-manifest.json", "utf8"));
for (const [name, digest] of Object.entries(manifest)) {
  const actual = createHash("sha256").update(await readFile(name)).digest("hex");
  assert.equal(actual, digest, name + " must stay unchanged");
}
const findings = await readFile("findings.md", "utf8");
assert.ok(findings.length > 400, "findings.md must carry a substantive result");
assert.match(findings, /^## dispatch$/mu, "findings.md needs a dispatch section");
assert.match(findings, /^## return$/mu, "findings.md needs a return section");
assert.ok(findings.split("operator-run-missing").length - 1 >= 2, "both paths must name the observed error");
for (const name of ["profiled.ts", "operator-proposal.ts"]) {
  assert.ok(findings.includes(name), "findings.md must cite " + name);
}
console.log("verify ok");
`;

async function main() {
  const [tarball, destination, repository] = process.argv.slice(2);
  assert(process.platform !== 'win32', 'Run inside a WSL login shell, not Windows npm');
  assert(tarball && destination && repository, 'Usage: <tarball> <fixture-directory> <repository-root>');
  const directory = resolve(destination);
  await mkdir(directory, { recursive: true });
  const fixture = await installedFixture(resolve(tarball), directory, 'beta-v010');
  const { project, control, env } = fixture;

  const manifest = {};
  for (const name of SOURCES) {
    const from = name === 'profiled.ts' ? join(repository, 'src/plugin', name) : join(repository, 'src/core', name);
    await copyFile(from, join(project, name));
    manifest[name] = hash(await readFile(join(project, name)));
  }
  await writeFile(join(project, 'source-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(project, 'verify.mjs'), VERIFY);
  await writeFile(join(project, 'findings.md'), 'pending\n');
  await writeFile(join(project, '.gitignore'), '.opencode/\n.sortie-dogs-v010/\n');
  await writeFile(join(project, 'AGENTS.md'),
    '# SD101-06 investigation fixture\nOnly findings.md is writable. The copied sources and verify.mjs are protected inputs.\n');
  const config = JSON.parse(await readFile(join(control, 'opencode.json'), 'utf8'));
  config.agent = { 'dogs-coordinator': { model: 'openai/gpt-5.6-terra', variant: 'low' } };
  await writeFile(join(control, 'opencode.json'), JSON.stringify(config, null, 2));
  await command('git', ['init', '-q', '-b', 'main'], project, env);
  await command('git', ['add', '--', 'AGENTS.md', '.gitignore', 'verify.mjs', 'findings.md',
    'source-manifest.json', ...SOURCES], project, env);
  await command('git', ['-c', 'user.name=Sortie Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Seed SD101-06 investigation fixture'], project, env);

  const intent = {
    schema_version: '0.1',
    original_request: { text: 'proposal Task dispatchがoperator-run-missingで拒否され得る経路を、コピーされたsourceだけを根拠にfindings.mdへまとめる。', source_ref: 'user:sd101-06' },
    requirements: [
      { id: 'R1', text: 'dispatch時に即時拒否される経路を、file名と該当する判定条件の根拠付きでfindings.mdへ書く', kind: 'requirement' },
      { id: 'R2', text: 'child返却時に失敗する経路を、dispatch時拒否と区別してfindings.mdへ書く', kind: 'requirement' },
      { id: 'N1', text: 'profiled.ts、operator-proposal.ts、operator-runtime.ts、verify.mjs、source-manifest.jsonを変更しない', kind: 'negative' },
      { id: 'Q1', text: 'node verify.mjs が成功する', kind: 'quality' },
    ],
    authoritative_refs: ['user:sd101-06', 'verify.mjs'],
    allow_read: ['profiled.ts', 'operator-proposal.ts', 'operator-runtime.ts', 'verify.mjs', 'findings.md', 'source-manifest.json'],
    proposal_budget: { max_reads: 30, max_submissions: 4 },
  };
  const started = Date.now();
  const output = events(await command('timeout', ['--signal=TERM', '--kill-after=10s', '2400s', 'opencode', 'run',
    '--dir', project, '--format', 'json', '--print-logs', '--agent', 'dog-operator',
    '--model', 'openai/gpt-6-astra', '--variant', 'low',
    'Use this exact bounded investigation intent with sortie_v010_begin_operator_proposal, then dispatch its returned Task unchanged. ' +
    'Do not investigate the sources yourself and do not bypass the proposal. After the proposal is submitted, compare it with the ' +
    'requirements and approve it, dispatch the returned worker Task unchanged, then call sortie_v010_complete_operator. ' +
    `No commit, no new proposal after approval, no budget reset. goal_budget_units: 3\n${JSON.stringify(intent)}`],
    project, env, 2_460_000));
  const root = output.find(event => event.sessionID)?.sessionID;
  assert(root, 'root session missing');

  const statePath = join(project, '.sortie-dogs-v010/operator-proposals', `${hash(root)}.json`);
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  let operator = null;
  try { operator = JSON.parse(await readFile(join(project, '.sortie-dogs-v010/operators', `${hash(root)}.json`), 'utf8')); }
  catch { /* the run may have stopped before an execution run existed */ }
  const db = new DatabaseSync(dbFile, { readOnly: true });
  let sessions;
  try {
    sessions = db.prepare(`with recursive tree(id) as (select ? union select s.id from session s join tree t on s.parent_id=t.id)
      select s.id id, s.parent_id parentID, s.agent agent from session s join tree t on t.id=s.id`).all(root);
  } finally { db.close(); }

  const report = {
    phase: 'sd101-03-l2', root, project, package_version: fixture.pkg.version, runtime_marker: fixture.runtimeMarker,
    package_sha256: hash(await readFile(resolve(tarball))), elapsed_ms: Date.now() - started,
    sessions: sessions.map(session => ({ id: session.id, parentID: session.parentID, agent: session.agent })),
    proposal_phase: state.phase, proposal_reads: state.read_count, proposal_submissions: state.submission_count,
    proposal_read_paths: state.read_paths, uncovered: state.proposal?.uncovered ?? null,
    operator_phase: operator?.phase ?? null, worker_status: operator?.units.map(unit => unit.status) ?? null,
    findings_bytes: Buffer.byteLength(await readFile(join(project, 'findings.md'), 'utf8'), 'utf8'),
  };
  await writeFile(join(directory, 'sd101-03-l2.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}

try { await main(); }
catch (error) {
  const processResult = error?.processResult;
  console.error(JSON.stringify({ error: error.message, exit: processResult?.code,
    diagnostics: processResult ? (processResult.stdout + '\n' + processResult.stderr).split(/\r?\n/u)
      .filter(line => /Error:|ConfigInvalid|operator-|not found/u.test(line)).map(line => line.slice(0, 300)).slice(0, 10) : undefined }));
  process.exitCode = 1;
}
