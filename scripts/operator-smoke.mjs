import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installedFixture, command } from './release-cli.mjs';
import { shellQuote } from './release-process.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const assert = (condition, message) => { if (!condition) throw Error(message); };
const events = value => value.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });

async function collectFamily(root, project, env) {
  const queue = [root], seen = new Set(), agents = {};
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const exported = JSON.parse(await command('opencode', ['export', id], project, env));
    const messages = exported.messages ?? exported.data?.messages;
    assert(Array.isArray(messages), 'Host export does not expose session messages');
    for (const message of messages) {
      const info = message.info ?? message;
      if (info.role === 'assistant') {
        const key = `${info.agent ?? 'unknown'}|${info.modelID ?? 'unknown'}|${info.variant ?? ''}`;
        const row = agents[key] ??= { agent: info.agent ?? 'unknown', model: info.modelID ?? null, variant: info.variant ?? null,
          steps: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, reportedCost: 0 };
        const tokens = info.tokens ?? {};
        row.steps++;
        row.input += tokens.input ?? 0; row.output += tokens.output ?? 0; row.reasoning += tokens.reasoning ?? 0;
        row.cacheRead += tokens.cache?.read ?? 0; row.cacheWrite += tokens.cache?.write ?? 0;
        row.reportedCost += info.cost ?? 0;
      }
      for (const part of message.parts ?? []) {
        if (part.type !== 'tool' || part.tool !== 'task') continue;
        const metadata = part.state?.metadata ?? {};
        const child = metadata.sessionId ?? metadata.sessionID;
        if (typeof child === 'string') queue.push(child);
      }
    }
  }
  const rows = Object.values(agents).map(row => ({ ...row, totalTokens: row.input + row.cacheRead + row.cacheWrite + row.output + row.reasoning }));
  return { sessionCount: seen.size, agents: rows, totalTokens: rows.reduce((sum, row) => sum + row.totalTokens, 0),
    modelSteps: rows.reduce((sum, row) => sum + row.steps, 0), reportedCost: rows.reduce((sum, row) => sum + row.reportedCost, 0),
    pricingCoverage: null, costInterpretation: 'host-reported only; not a complete API price calculation' };
}

export async function operatorSmoke(tgz, directory, arm = 'operator') {
  assert(['operator', 'astra', 'terra'].includes(arm), 'Unknown comparison arm');
  const profileId = arm === 'operator' ? 'beta-v010' : 'stable';
  const fixture = await installedFixture(tgz, directory, profileId);
  const { project, env, runtime, installed, coordinatorAgent, workerAgent, reduceGoalFlight, acceptanceContinuityFingerprint } = fixture;
  const model = arm === 'terra' ? 'openai/gpt-5.6-terra' : 'openai/gpt-6-astra';
  const values = { first: 'first-complete', second: 'second-complete' };
  const oracleSources = {};
  for (const [name, expected] of Object.entries(values)) {
    await writeFile(join(project, `${name}.txt`), 'pending\n');
    const source = `import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';assert.equal((await readFile(new URL('./${name}.txt',import.meta.url),'utf8')).trim(),${JSON.stringify(expected)});console.log('ORACLE_PASS');\n`;
    await writeFile(join(project, `check-${name}.mjs`), source);
    oracleSources[name] = hash(source);
  }
  await writeFile(join(project, 'AGENTS.md'), '# Isolated operator smoke\nUse the supplied immutable plan. Only first.txt and second.txt may change. Do not change oracles, commit, publish, install dependencies, or use generic agents.\n');
  await writeFile(join(project, '.gitignore'), `.opencode/\n.sortie-dogs/\n.sortie-dogs-v010/\n`);
  await command('git', ['init', '-q', '-b', 'main'], project, env);
  await command('git', ['add', '--', 'AGENTS.md', '.gitignore', 'first.txt', 'second.txt', 'check-first.mjs', 'check-second.mjs'], project, env);
  await command('git', ['-c', 'user.name=Sortie Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Seed operator smoke'], project, env);
  const acceptance = ['first.txt must equal first-complete', 'second.txt must equal second-complete', 'The verification scripts must remain unchanged'];
  const plan = { schema_version: '0.1', acceptance, acceptance_proof: [['first'], ['second'], ['first', 'second']], source_refs: ['fixture:operator-smoke-original-request'], goal_declaration: {
    delivery_intent: 'implementation', delivery_mode: 'mvp-first', usable_path_established: false, controlled_change: false, goal_budget_units: 4,
    defaults: { target: 'two accepted content artifacts', entrypoint: 'check-first.mjs and check-second.mjs', workload: 'two independent text files',
      oracle_coverage: ['first and second content', 'unchanged oracles'], build_boundary: 'not-applicable', source: 'source', candidate: 'candidate',
      source_binding: 'current-protected', candidate_binding: 'current-protected', fixture: 'operator-smoke', proof_scope: 'requested-full', expected_outcome: 'pass' },
    criteria: Object.keys(values).map(name => ({ criterion_id: name, validation_command: `node check-${name}.mjs` })),
  }, units: Object.keys(values).map((name, index) => ({ id: name, title: `Complete ${name}`, objective: `Write exactly ${values[name]} to ${name}.txt and preserve the oracle.`,
    read: [`${name}.txt`, `check-${name}.mjs`], write: [`${name}.txt`], validation: [`node check-${name}.mjs`], acceptance_indices: [index, 2] })) };
  async function cli(prompt, id) {
    return events(await command('timeout', ['--signal=TERM', '--kill-after=10s', '720s', 'opencode', 'run', '--dir', project,
      '--format', 'json', '--print-logs', '--agent', coordinatorAgent, '--model', model, '--variant', 'high',
      ...(id ? ['--session', id] : []), prompt], project, env, 760000));
  }
  const started = Date.now();
  const initial = await cli('Open the isolated two-artifact smoke task. Do not call tools yet. Reply SMOKE_READY without a terminal report.');
  const sessionID = initial.find(event => event.sessionID)?.sessionID;
  assert(sessionID, 'Initial host session not observed');
  const planPath = join(project, 'plan.json');
  await writeFile(planPath, JSON.stringify(plan));
  let prompt;
  if (arm === 'operator') {
    prompt = `Continue the same goal. Read ${planPath}, freeze that exact plan with sortie_v010_prepare_operator, and dispatch the returned operator Task verbatim. Let it execute both units and return its complete packet. Do not edit source or use the direct worker fast path for these two units. This changes only requested local text artifacts; use the existing low-risk review policy. Accept only when both original criteria have host verification and the oracles remain unchanged.`;
  } else {
    const controls = join(project, runtime.stateDirectory, 'contracts', 'smoke');
    await mkdir(controls, { recursive: true });
    const fingerprint = acceptanceContinuityFingerprint(acceptance);
    const declarationPath = join(controls, 'goal.json');
    await writeFile(declarationPath, JSON.stringify(plan.goal_declaration));
    const tasks = [];
    for (const [index, unit] of plan.units.entries()) {
      const id = `smoke-${unit.id}`, manifest = `${runtime.stateDirectory}/contracts/smoke/${unit.id}.operation-manifest.json`;
      const handoff = join(controls, `handoff.${unit.id}.json`);
      await writeFile(join(project, manifest), JSON.stringify({ version: '0.1.0', task_id: id, read: unit.read, write: unit.write, validation: unit.validation }));
      await writeFile(handoff, JSON.stringify({ version: '0.1.0', profile: 'minimal', id, created_at: new Date().toISOString(),
        task: { title: unit.title, objective: unit.objective }, state: { done: [], next: [unit.objective], blocked: [] }, risks: [],
        verification: unit.validation.map(check => ({ check, status: 'not_run', exit_code: null, summary: 'Content oracle' })),
        ext: { 'sortie-dogs/write-gate': { project_root: project, operation_manifest: manifest },
          'sortie-dogs/acceptance-continuity': { schema_version: '0.1', authority: 'dispatch', task_id: id, criteria: acceptance,
            fingerprint, parent_fingerprint: index === 0 ? 'none' : fingerprint } } }));
      tasks.push({ subagent_type: workerAgent, description: unit.title, prompt: [
        'role: implementation', `task_id: ${id}`, `project_root: ${project}`, `source_manifest: ${unit.write.join(', ')}`,
        `operation_manifest: ${manifest}`, `handoff_path: ${handoff}`, `goal_declaration_path: ${declarationPath}`,
        'acceptance:', ...acceptance.map(item => `- ${item}`), 'validation:', ...unit.validation.map(item => `- ${item}`), unit.objective,
      ].join('\n') });
    }
    prompt = `Continue the same goal. Execute these two prepared worker Tasks sequentially, preserving each prompt verbatim. Do not edit source yourself. This changes only requested local text artifacts; use the existing low-risk review policy. Finish only when both have host verification and the oracles remain unchanged.\n${JSON.stringify(tasks)}`;
  }
  const outcome = await cli(prompt, sessionID);
  const elapsedMs = Date.now() - started;
  const ledgerDirectory = runtime.flightDirectory ?? 'run-flight';
  const key = runtime.id === 'stable' ? sessionID : `${runtime.id}\u0000${sessionID}`;
  const ledger = JSON.parse(await readFile(join(project, '.git/sortie-dogs', ledgerDirectory, `${hash(key)}.json`), 'utf8'));
  const goal = reduceGoalFlight(ledger.goal_events);
  const oracleChecks = {};
  for (const name of Object.keys(values)) {
    oracleChecks[name] = (await readFile(join(project, `${name}.txt`), 'utf8')).trim() === values[name] &&
      hash(await readFile(join(project, `check-${name}.mjs`))) === oracleSources[name];
  }
  const metrics = await collectFamily(sessionID, project, env);
  const operatorState = arm === 'operator' ? JSON.parse(await readFile(join(project, runtime.stateDirectory, 'operators', `${hash(sessionID)}.json`), 'utf8')) : null;
  const report = { schema: 1, arm, version: fixture.pkg.version, profile: runtime.id, runtimeMarker: fixture.runtimeMarker,
    tgzSHA256: hash(await readFile(tgz)), sourceFixtureFingerprint: hash(JSON.stringify(oracleSources)), sessionID, requestedModel: model,
    elapsedMs, oracleChecks, terminal: goal.receipt?.status ?? goal.phase, operatorPhase: operatorState?.phase ?? null,
    operatorUnits: operatorState?.units.map(unit => ({ id: unit.unit.id, status: unit.status, child: unit.childSessionID })) ?? [],
    events: outcome.map(event => event.type), metrics, measurement: 'smoke only; not a representative efficiency benchmark' };
  await writeFile(join(fixture.run, 'operator-smoke.json'), JSON.stringify(report, null, 2) + '\n');
  assert(Object.values(oracleChecks).every(Boolean) && goal.receipt?.status === 'succeeded', 'Smoke acceptance is incomplete');
  if (arm === 'operator') assert(operatorState.phase === 'completed' && operatorState.units.every(unit => unit.status === 'succeeded'), 'Operator queue did not finish');
  return report;
}

async function main() {
  const tgz = process.argv[2] && resolve(process.argv[2]), directory = process.argv[3] && resolve(process.argv[3]), arm = process.argv[4] ?? 'operator';
  assert(tgz && directory, 'tarball and receipt directory required');
  if (process.platform !== 'win32') { console.log(JSON.stringify(await operatorSmoke(tgz, directory, arm), null, 2)); return; }
  const linux = async value => (await command('wsl.exe', ['-e', 'wslpath', '-a', value], process.cwd())).trim();
  const paths = await Promise.all([import.meta.filename, tgz, directory].map(linux));
  const out = await command('wsl.exe', ['-e', 'bash', '-ic', `timeout --signal=TERM --kill-after=10s 1800s node ${[...paths, arm].map(shellQuote).join(' ')}`], process.cwd(), {}, 1860000);
  console.log(JSON.stringify(JSON.parse(out.trim()), null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
