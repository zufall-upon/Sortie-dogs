import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OperatorRuntime } from '../dist/core/operator-runtime.js';
import { OperatorProposalRuntime } from '../dist/core/operator-proposal.js';
import { V010_RUNTIME_PROFILE } from '../dist/core/runtime-profile.js';
import { RunFlightLedger } from '../dist/core/run-flight-ledger.js';
import { SortieDogsV010Plugin } from '../dist/plugin/profiled.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const artifactRoot = join(root, '_testenv');
const hash = value => createHash('sha256').update(value).digest('hex');
const startedAt = Date.now();
const failureInjection = process.argv[2] === '--internal-test-failure-receipt';
const receiptRelative = failureInjection ? '_testenv/proposal-contract-rpt-failure.json' : '_testenv/proposal-contract-rpt.json';
const receiptPath = join(root, receiptRelative);
if (process.argv.length > 2 && !failureInjection) throw new Error('proposal-contract-rpt-argument-invalid');
const reproCommand = failureInjection ? 'node scripts/proposal-contract-rpt.mjs --internal-test-failure-receipt'
  : 'npm run build && node scripts/proposal-contract-rpt.mjs';
const stages = [];
const proposalRefPrefix = 'SORTIE_OPERATOR_PROPOSAL_TASK_REF ';
let packageVersion = null;
let cleanupConfirmed = false;
const requirements = Array.from({ length: 19 }, (_, index) => ({
  id: `R${index + 1}`,
  text: `Exact acceptance requirement ${index + 1}`,
  kind: 'requirement',
}));
const defaults = {
  target: 'proposal contract', entrypoint: 'test/proposal-proof.mjs', workload: 'deterministic fixture',
  oracle_coverage: ['all exact acceptance requirements'], build_boundary: 'not-applicable',
  source: 'fixture source', candidate: 'fixture candidate', fixture: 'proposal-contract-rpt',
  source_binding: 'current-protected', candidate_binding: 'current-protected',
  proof_scope: 'requested-full', expected_outcome: 'pass',
};

function packet(mode) {
  const malformedCommands = requirements.map((_, index) => `node test/proof-${index + 1}.mjs`);
  const first = 'node test/shared-first.mjs', second = 'node test/shared-second.mjs', third = 'node test/shared-third.mjs';
  const corrected = mode !== 'malformed';
  const criteria = corrected
    ? [{ criterion_id: 'shared-first', validation_command: first }, { criterion_id: 'shared-second', validation_command: second },
      { criterion_id: 'shared-third', validation_command: third }]
    : malformedCommands.map((validation_command, index) => ({ criterion_id: `C${index + 1}`, validation_command }));
  const plan = {
      schema_version: '0.1',
      acceptance_proof: requirements.map((_, index) => [corrected ? (index < 6 ? 'shared-first' : index < 12 ? 'shared-second' : 'shared-third')
        : index === 1 ? 'C1' : index === 3 ? 'C3' : `C${index + 1}`]),
      source_refs: ['fixture:proposal-contract-rpt'],
      goal_declaration: { delivery_intent: 'implementation', delivery_mode: 'mvp-first', usable_path_established: false,
        controlled_change: false, goal_budget_units: 4, defaults, criteria },
      units: corrected ? [
        { id: 'first', title: 'First milestone', objective: 'Satisfy acceptance requirements 0 through 5.', read: ['src', 'test'],
          write: ['src/first.ts'], validation: [first], acceptance_indices: Array.from({ length: 6 }, (_, index) => index) },
        { id: 'second', title: 'Second milestone', objective: 'Satisfy acceptance requirements 6 through 11.', read: ['src', 'test'],
          write: ['src/second.ts'], validation: [second], acceptance_indices: Array.from({ length: 6 }, (_, index) => index + 6) },
        { id: 'third', title: 'Third milestone', objective: 'Satisfy acceptance requirements 12 through 18.', read: ['src', 'test'],
          write: ['src/third.ts'], validation: [third], acceptance_indices: Array.from({ length: 7 }, (_, index) => index + 12) },
      ] : [
        { id: 'first', title: 'First milestone', objective: 'Reproduce mismatched exact acceptance proof.', read: ['src', 'test'],
          write: ['src/first.ts'], validation: [malformedCommands[0], malformedCommands[17]], acceptance_indices: Array.from({ length: 19 }, (_, index) => index) },
        { id: 'second', title: 'Second milestone', objective: 'Reproduce an empty acceptance assignment.', read: ['src', 'test'],
          write: ['src/second.ts'], validation: [malformedCommands[6]], acceptance_indices: [] },
        { id: 'third', title: 'Third milestone', objective: 'Reproduce incomplete declared proof coverage.', read: ['src', 'test'],
          write: ['src/third.ts'], validation: malformedCommands.slice(12), acceptance_indices: Array.from({ length: 7 }, (_, index) => index + 12) },
      ],
    };
  if (mode === 'rewritten') plan.acceptance = requirements.map((item, index) => index === 15 ? `${item.text}!` : item.text);
  return {
    schema_version: '0.1', revision: mode === 'malformed' ? 1 : mode === 'rewritten' ? 2 : 3,
    coverage: requirements.map(item => ({ requirement_id: item.id, approach: `Preserve ${item.id}`, validation: corrected ? third : malformedCommands.at(-1) })),
    uncovered: [], negative_handling: [], read_scope: ['src', 'test'], write_scope: ['src/first.ts', 'src/second.ts', 'src/third.ts'],
    budget_estimate: { proposal_reads: 1, execution_units: 3 }, plan,
  };
}

async function hooks(project, rootSessionID = 'root') {
  return SortieDogsV010Plugin({ directory: project, client: { session: {
    get: async ({ path }) => ({ data: path.id === rootSessionID ? { agent: 'dog-operator' } : { agent: 'dogs-coordinator', parentID: rootSessionID } }),
    messages: async () => ({ data: [] }),
  } } });
}

async function run() {
  await mkdir(artifactRoot, { recursive: true });
  packageVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  const project = await mkdtemp(join(artifactRoot, 'proposal-contract-rpt-'));
  try {
    await mkdir(join(project, '.git')); await mkdir(join(project, 'src')); await mkdir(join(project, 'test'));
    await writeFile(join(project, 'src', 'input.ts'), 'export {};\n');
    const intent = { schema_version: '0.1', original_request: { text: 'Preserve 19 exact acceptance requirements across three ordered units.', source_ref: 'fixture:r9' },
      requirements, authoritative_refs: ['fixture:r9'], allow_read: ['src', 'test'], proposal_budget: { max_reads: 1, max_submissions: 3 } };
    const plugin = await hooks(project);
    await plugin['chat.message']({ sessionID: 'root', messageID: 'fixture-user', agent: 'dog-operator', model: {} },
      { message: { agent: 'dog-operator', model: {} }, parts: [{ type: 'text', text: intent.original_request.text }] });
    const started = JSON.parse(await plugin.tool.sortie_v010_begin_operator_proposal.execute(
      { intent_json: JSON.stringify(intent) }, { sessionID: 'root' }));
    assert.deepEqual(Object.keys(started.task).sort(), ['description', 'prompt', 'subagent_type']);
    assert(started.task.prompt.startsWith(proposalRefPrefix));
    assert.equal(started.dispatch_instruction,
      'Pass this short Task reference verbatim; do not append or paraphrase it.');
    const runtime = new OperatorProposalRuntime(project, V010_RUNTIME_PROFILE);
    const canonicalTask = runtime.task(await runtime.required('root'));
    assert(Buffer.byteLength(started.task.prompt) < Buffer.byteLength(canonicalTask.prompt));
    const ledgerPath = join(project, '.git/sortie-dogs/run-flight-v010', `${createHash('sha256').update('v010\0root').digest('hex')}.json`);
    const beforeChangedTask = await (await RunFlightLedger.openGoal(ledgerPath)).readGoal();
    const reference = JSON.parse(started.task.prompt.slice(proposalRefPrefix.length));
    const invalid = [
      ['appended', { ...started.task, prompt: `${started.task.prompt}!` }],
      ['foreign', { ...started.task, prompt: proposalRefPrefix + JSON.stringify({ ...reference, r: 'foreign' }) }],
      ['stale', { ...started.task, prompt: proposalRefPrefix + JSON.stringify({ ...reference, s: 'submitted' }) }],
      ['wrong-role', { ...started.task, subagent_type: 'dog-worker-v010' }],
      ['changed-hash', { ...started.task, prompt: proposalRefPrefix + JSON.stringify({ ...reference, h: '0'.repeat(64) }) }],
    ];
    for (const [name, task] of invalid) {
      let failure;
      try { await plugin['tool.execute.before']({ tool: 'task', sessionID: 'root', callID: name }, { args: task }); }
      catch (error) { failure = error; }
      assert.match(String(failure?.message), /operator-proposal-dispatch-not-authorized/u);
    }
    let proposalState = await runtime.required('root');
    assert.equal(proposalState.proposal_call_id, null); assert.equal(proposalState.proposal_session_id, null);
    assert.equal(await new OperatorRuntime(project, V010_RUNTIME_PROFILE).read('root'), undefined);
    const afterChangedTask = await (await RunFlightLedger.openGoal(ledgerPath)).readGoal();
    assert.deepEqual(afterChangedTask.records, beforeChangedTask.records);
    stages.push({ stage: 'proposal-task-byte-identity-rejection', exit: 0,
      rejected_variants: invalid.map(([name]) => name), reservation_count: 0,
      proposal_child_session_id: proposalState.proposal_session_id, execution_run_present: false });

    const coldPlugin = await hooks(project);
    const nativeArgs = structuredClone(started.task);
    await coldPlugin['tool.execute.before']({ tool: 'task', sessionID: 'root', callID: 'proposal-call' }, { args: nativeArgs });
    assert.deepEqual(nativeArgs, started.task);
    proposalState = await new OperatorProposalRuntime(project, V010_RUNTIME_PROFILE).required('root');
    assert.equal(proposalState.proposal_call_id, 'proposal-call'); assert.equal(proposalState.proposal_session_id, null);
    assert.equal((await (await RunFlightLedger.openGoal(ledgerPath)).readGoal()).state.outstanding_reservations.length, 1);
    let duplicateError;
    try { await coldPlugin['tool.execute.before']({ tool: 'task', sessionID: 'root', callID: 'duplicate' }, { args: structuredClone(started.task) }); }
    catch (error) { duplicateError = error; }
    assert.match(String(duplicateError?.message), /operator-proposal-dispatch-not-authorized/u);
    assert.equal((await (await RunFlightLedger.openGoal(ledgerPath)).readGoal()).state.outstanding_reservations.length, 1);
    const childMessage = { message: { agent: 'dogs-coordinator', model: {} }, parts: [{ type: 'text', text: nativeArgs.prompt }] };
    await coldPlugin['chat.message']({ sessionID: 'child', messageID: 'child-user', agent: 'dogs-coordinator', model: {} }, childMessage);
    assert.equal(childMessage.parts[0].text, canonicalTask.prompt);
    await coldPlugin['tool.execute.before']({ tool: 'read', sessionID: 'child', callID: 'proposal-read' },
      { args: { filePath: 'src/input.ts' } });
    proposalState = await new OperatorProposalRuntime(project, V010_RUNTIME_PROFILE).required('root');
    assert.equal(proposalState.proposal_session_id, 'child'); assert.equal(proposalState.read_count, 1);
    stages.push({ stage: 'proposal-task-exact-admission-after-reject', exit: 0,
      call_id: proposalState.proposal_call_id, short_reference_bytes: Buffer.byteLength(started.task.prompt),
      canonical_prompt_bytes: Buffer.byteLength(childMessage.parts[0].text), parent_native_prompt: 'short-reference',
      child_prompt: 'canonical-byte-exact', duplicate_reservation_count: 1,
      proposal_child_session_id: proposalState.proposal_session_id });

    const replay = JSON.parse(await coldPlugin.tool.sortie_v010_submit_operator_proposal.execute(
      { proposal_json: JSON.stringify(packet('malformed')) }, { sessionID: 'child' }));
    assert.equal(replay.status, 'invalid-proposal'); assert.equal(replay.code, 'operator-unit-coverage-invalid');
    assert.equal(replay.actual_reads, 1); assert.equal(replay.submissions, 1); assert.equal(replay.remaining_submissions, 2);
    assert.equal(replay.diagnostics_truncated, true); assert(replay.diagnostics.length > 0 && replay.diagnostics.length <= 16);
    stages.push({ stage: 'bounded-invalid-submission', exit: 0, status: replay.status, error: replay.code,
      diagnostics: replay.diagnostics.length, diagnostics_truncated: replay.diagnostics_truncated,
      actual_reads: replay.actual_reads, submissions: replay.submissions, remaining_submissions: replay.remaining_submissions });
    if (failureInjection) assert.fail('injected failure after bounded invalid submission');

    const rewritten = JSON.parse(await coldPlugin.tool.sortie_v010_submit_operator_proposal.execute(
      { proposal_json: JSON.stringify(packet('rewritten')) }, { sessionID: 'child' }));
    assert.equal(rewritten.status, 'invalid-proposal'); assert.equal(rewritten.code, 'operator-proposal-acceptance-rewritten');
    assert.equal(rewritten.actual_reads, 1); assert.equal(rewritten.submissions, 2); assert.equal(rewritten.remaining_submissions, 1);
    assert.deepEqual(rewritten.diagnostics, [{ document: 'plan', pointer: '/acceptance', code: 'operator-proposal-acceptance-rewritten',
      rule: 'omit-for-host-derived-exact-ordered-intent-requirements', repair_kind: 'repair-field', repair_paths: ['/acceptance'] }]);
    stages.push({ stage: 'legacy-one-character-rewrite-rejected', exit: 0, status: rewritten.status, error: rewritten.code,
      actual_reads: rewritten.actual_reads, submissions: rewritten.submissions, remaining_submissions: rewritten.remaining_submissions,
      diagnostic_pointer: rewritten.diagnostics[0].pointer, remedy: 'omit-plan-acceptance' });

    const corrected = JSON.parse(await coldPlugin.tool.sortie_v010_submit_operator_proposal.execute(
      { proposal_json: JSON.stringify(packet('corrected')) }, { sessionID: 'child' }));
    assert.equal(corrected.status, 'submitted'); assert.equal(corrected.reads, 1); assert.equal(corrected.submissions, 3);
    assert.deepEqual(corrected.proposal.plan.acceptance, requirements.map(item => item.text));
    assert.equal(corrected.content_hash, hash(JSON.stringify(corrected.proposal)));
    stages.push({ stage: 'host-materialized-canonical-submission', exit: 0, status: corrected.status, error: null,
      actual_reads: corrected.reads, submissions: corrected.submissions, remaining_submissions: 0,
      requirements: corrected.proposal.plan.acceptance.length, units: corrected.proposal.plan.units.length, shared_proof: true,
      canonical_content_hash: corrected.content_hash, acceptance_source: 'durable-intent-requirements' });

    const proposalPath = join(project, V010_RUNTIME_PROFILE.stateDirectory, 'operator-proposals', `${hash('root')}.json`);
    const canonicalState = await readFile(proposalPath, 'utf8');
    const tamperCases = [
      ['acceptance', value => { value.proposal.plan.acceptance[15] += '!'; }],
      ['unit', value => { value.proposal.plan.units[1].title += '!'; }],
      ['hash', value => { value.proposal_hash = '0'.repeat(64); }],
      ['id', value => { value.proposal_id += 'x'; }],
    ];
    for (const [name, mutate] of tamperCases) {
      const corrupted = JSON.parse(canonicalState); mutate(corrupted); await writeFile(proposalPath, JSON.stringify(corrupted));
      let integrityError;
      try {
        await new OperatorProposalRuntime(project, V010_RUNTIME_PROFILE).approve('root', { proposal_id: corrected.proposal_id,
          revision: corrected.revision, content_hash: corrected.content_hash, compared_requirement_ids: requirements.map(item => item.id),
          decision: 'approve', rationale: 'A corrupt cold state must fail before approval.' });
      } catch (error) { integrityError = error; }
      assert.match(String(integrityError?.message), /operator-proposal-state-invalid/u);
      assert.equal(JSON.parse(await readFile(proposalPath, 'utf8')).submission_count, 3);
      await writeFile(proposalPath, canonicalState);
    }
    assert.equal((await new OperatorProposalRuntime(project, V010_RUNTIME_PROFILE).required('root')).phase, 'submitted');
    stages.push({ stage: 'cold-durable-proposal-integrity', exit: 0, rejected: tamperCases.map(([name]) => name),
      rejection: 'operator-proposal-state-invalid', submissions_preserved: 3, restored_phase: 'submitted' });
    await coldPlugin['tool.execute.after']({ tool: 'task', sessionID: 'root', callID: 'proposal-call' }, { output: 'Submitted.' });
    const settled = await (await RunFlightLedger.openGoal(ledgerPath)).readGoal();
    assert.equal(settled.state.outstanding_reservations.length, 0);
    stages.push({ stage: 'proposal-task-settlement', exit: 0, disposition: 'succeeded', reservation_count: 0 });

    const legacyState = await runtime.begin('legacy-root', intent);
    const legacyTask = runtime.task(legacyState);
    assert.deepEqual(await new OperatorProposalRuntime(project, V010_RUNTIME_PROFILE).admit('legacy-root', 'legacy-call', legacyTask), legacyTask);
    stages.push({ stage: 'legacy-canonical-task-compatibility', exit: 0, canonical_hash: hash(JSON.stringify(legacyTask)) });

    const revisionRoot = 'revision-root', revisionChild = 'revision-child';
    const revisionPlugin = await hooks(project, revisionRoot);
    const revisionIntent = { ...intent }; delete revisionIntent.proposal_budget;
    await revisionPlugin['chat.message']({ sessionID: revisionRoot, messageID: 'revision-user', agent: 'dog-operator', model: {} },
      { message: { agent: 'dog-operator', model: {} }, parts: [{ type: 'text', text: revisionIntent.original_request.text }] });
    const revisionStarted = JSON.parse(await revisionPlugin.tool.sortie_v010_begin_operator_proposal.execute(
      { intent_json: JSON.stringify(revisionIntent) }, { sessionID: revisionRoot }));
    assert.deepEqual((await new OperatorProposalRuntime(project, V010_RUNTIME_PROFILE).required(revisionRoot)).intent.proposal_budget,
      { max_reads: 45, max_submissions: 9 });
    await revisionPlugin['tool.execute.before']({ tool: 'task', sessionID: revisionRoot, callID: 'revision-call' },
      { args: revisionStarted.task });
    const revisionLedgerPath = join(project, '.git/sortie-dogs/run-flight-v010', `${createHash('sha256').update(`v010\0${revisionRoot}`).digest('hex')}.json`);
    const oneReservation = await (await RunFlightLedger.openGoal(revisionLedgerPath)).readGoal();
    let duplicateRevisionTask;
    try {
      await revisionPlugin['tool.execute.before']({ tool: 'task', sessionID: revisionRoot, callID: 'revision-duplicate' },
        { args: structuredClone(revisionStarted.task) });
    } catch (error) { duplicateRevisionTask = error; }
    assert.match(String(duplicateRevisionTask?.message), /operator-proposal-dispatch-not-authorized/u);
    assert.deepEqual((await (await RunFlightLedger.openGoal(revisionLedgerPath)).readGoal()).records, oneReservation.records);
    await revisionPlugin['chat.message']({ sessionID: revisionChild, messageID: 'revision-child-user', agent: 'dogs-coordinator', model: {} },
      { message: { agent: 'dogs-coordinator', model: {} }, parts: [{ type: 'text', text: revisionStarted.task.prompt }] });
    for (let index = 0; index < 13; index++) {
      await revisionPlugin['tool.execute.before']({ tool: 'read', sessionID: revisionChild, callID: `revision-read-${index}` },
        { args: { filePath: 'src/input.ts' } });
    }
    for (let index = 0; index < 3; index++) {
      const prior = JSON.parse(await revisionPlugin.tool.sortie_v010_submit_operator_proposal.execute(
        { proposal_json: '{}' }, { sessionID: revisionChild }));
      assert.equal(prior.status, 'invalid-proposal'); assert.equal(prior.code, 'operator-proposal-invalid');
    }
    const invalidRevisionPacket = packet('corrected');
    invalidRevisionPacket.revision = '1'; invalidRevisionPacket.budget_estimate.proposal_reads = 13;
    const invalidRevision = JSON.parse(await revisionPlugin.tool.sortie_v010_submit_operator_proposal.execute(
      { proposal_json: JSON.stringify(invalidRevisionPacket) }, { sessionID: revisionChild }));
    assert.equal(invalidRevision.status, 'invalid-proposal'); assert.equal(invalidRevision.code, 'operator-proposal-revision-invalid');
    assert.equal(invalidRevision.actual_reads, 13); assert.equal(invalidRevision.submissions, 4); assert.equal(invalidRevision.remaining_submissions, 5);
    assert.deepEqual(invalidRevision.diagnostics, [{ document: 'proposal', pointer: '/revision', code: 'operator-proposal-revision-invalid',
      rule: 'positive-integer', repair_kind: 'repair-field', repair_paths: ['/revision'], expected: 'positive-integer', actual_type: 'string' }]);
    assert.equal('actual' in invalidRevision.diagnostics[0], false); assert.equal('value' in invalidRevision.diagnostics[0], false);
    const correctedRevisionPacket = { ...invalidRevisionPacket, revision: 1 };
    const correctedRevision = JSON.parse(await revisionPlugin.tool.sortie_v010_submit_operator_proposal.execute(
      { proposal_json: JSON.stringify(correctedRevisionPacket) }, { sessionID: revisionChild }));
    assert.equal(correctedRevision.status, 'submitted'); assert.equal(correctedRevision.reads, 13);
    assert.equal(correctedRevision.submissions, 5); assert.equal(correctedRevision.remaining_submissions, 4);
    assert.equal(correctedRevision.revision, 1); assert.equal(typeof correctedRevision.revision, 'number');
    stages.push({ stage: 'revision-type-diagnostic-and-corrected-submission', exit: 0,
      invalid_status: invalidRevision.status, invalid_error: invalidRevision.code, diagnostic: invalidRevision.diagnostics[0],
      actual_reads: invalidRevision.actual_reads, submissions_before_correction: invalidRevision.submissions,
      remaining_before_correction: invalidRevision.remaining_submissions, corrected_status: correctedRevision.status,
      corrected_revision: correctedRevision.revision, corrected_revision_type: typeof correctedRevision.revision,
      submissions_after_correction: correctedRevision.submissions, remaining_after_correction: correctedRevision.remaining_submissions,
      duplicate_task_rejected: true, extra_reservation: false, coercion: false });
    await revisionPlugin['tool.execute.after']({ tool: 'task', sessionID: revisionRoot, callID: 'revision-call' }, { output: 'Submitted.' });

    const terminalRoot = 'terminal-root', terminalChild = 'terminal-child';
    const terminalPlugin = await hooks(project, terminalRoot);
    await terminalPlugin['chat.message']({ sessionID: terminalRoot, messageID: 'terminal-user', agent: 'dog-operator', model: {} },
      { message: { agent: 'dog-operator', model: {} }, parts: [{ type: 'text', text: revisionIntent.original_request.text }] });
    const terminalStarted = JSON.parse(await terminalPlugin.tool.sortie_v010_begin_operator_proposal.execute(
      { intent_json: JSON.stringify(revisionIntent) }, { sessionID: terminalRoot }));
    await terminalPlugin['tool.execute.before']({ tool: 'task', sessionID: terminalRoot, callID: 'terminal-call' }, { args: terminalStarted.task });
    await terminalPlugin['chat.message']({ sessionID: terminalChild, messageID: 'terminal-child-user', agent: 'dogs-coordinator', model: {} },
      { message: { agent: 'dogs-coordinator', model: {} }, parts: [{ type: 'text', text: terminalStarted.task.prompt }] });
    await terminalPlugin['tool.execute.after']({ tool: 'task', sessionID: terminalRoot, callID: 'terminal-call' },
      { output: 'Proposal child terminated without submission.' });
    const terminalStatus = JSON.parse(await terminalPlugin.tool.sortie_v010_operator_status.execute({}, { sessionID: terminalRoot }));
    assert.equal(terminalStatus.proposal.task_admitted, true); assert.equal(terminalStatus.proposal.remaining_submissions, 9);
    assert.equal('task' in terminalStatus, false); assert.equal('dispatch_instruction' in terminalStatus, false);
    assert.match(terminalStatus.next_action, /report the terminal proposal failure/u);
    assert.match(terminalStatus.next_action, /does not authorize a new Task, budget reset, or replacement child/u);
    const terminalLedgerPath = join(project, '.git/sortie-dogs/run-flight-v010', `${createHash('sha256').update(`v010\0${terminalRoot}`).digest('hex')}.json`);
    const terminalLedger = await (await RunFlightLedger.openGoal(terminalLedgerPath)).readGoal();
    assert.equal(terminalLedger.state.consumed_units, 1); assert.equal(terminalLedger.state.outstanding_reservations.length, 0);
    let terminalRetry;
    try {
      await terminalPlugin['tool.execute.before']({ tool: 'task', sessionID: terminalRoot, callID: 'terminal-retry' },
        { args: structuredClone(terminalStarted.task) });
    } catch (error) { terminalRetry = error; }
    assert.match(String(terminalRetry?.message), /operator-proposal-dispatch-not-authorized/u);
    assert.deepEqual((await (await RunFlightLedger.openGoal(terminalLedgerPath)).readGoal()).records, terminalLedger.records);
    stages.push({ stage: 'unsubmitted-proposal-terminal-no-redispatch', exit: 0, status: terminalStatus.proposal.status,
      task_admitted: terminalStatus.proposal.task_admitted, remaining_submissions: terminalStatus.proposal.remaining_submissions,
      task_returned: false, next_action: terminalStatus.next_action, consumed_units: terminalLedger.state.consumed_units,
      reservation_count: terminalLedger.state.outstanding_reservations.length, retry_rejected: true, extra_reservation: false });

    const status = JSON.parse(await coldPlugin.tool.sortie_v010_operator_status.execute({}, { sessionID: 'root' }));
    assert.match(status.next_action, /do not call operator_next before approval/u);
    let nextError;
    try { await coldPlugin.tool.sortie_v010_operator_next.execute({}, { sessionID: 'root' }); } catch (error) { nextError = error; }
    assert.match(String(nextError?.message), /operator-run-missing/u);
    assert.equal(await new OperatorRuntime(project, V010_RUNTIME_PROFILE).read('root'), undefined);
    stages.push({ stage: 'proposal-only-status', exit: 0, error: null, next_action: status.next_action,
      operator_next_exit: 1, operator_next_error: nextError.message });
  } finally {
    await rm(project, { recursive: true, force: true });
    try { await access(project); } catch (error) { cleanupConfirmed = error?.code === 'ENOENT'; }
    stages.push({ stage: 'cleanup', exit: cleanupConfirmed ? 0 : 1,
      error: cleanupConfirmed ? null : 'fixture-cleanup-unconfirmed', confirmed: cleanupConfirmed });
  }
  assert.equal(cleanupConfirmed, true);
  const receipt = { schema: 1, artifact: 'proposal-contract-rpt', package_version: packageVersion,
    repro_command: reproCommand, elapsed_ms: Date.now() - startedAt, stages,
    cleanup: { confirmed: cleanupConfirmed, fixture_removed: cleanupConfirmed } };
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'PASS', receipt: receiptRelative, package_version: packageVersion,
    elapsed_ms: receipt.elapsed_ms, cleanup: true }));
}

run().catch(async error => {
  const failure = { stage: 'rpt-failure', exit: 1, code: String(error?.code ?? error?.name ?? 'Error').slice(0, 80),
    error: String(error?.message ?? error).slice(0, 240) };
  stages.push(failure);
  const receipt = { schema: 1, artifact: 'proposal-contract-rpt', package_version: packageVersion, repro_command: reproCommand,
    elapsed_ms: Date.now() - startedAt, stages,
    cleanup: { confirmed: cleanupConfirmed, fixture_removed: cleanupConfirmed } };
  await mkdir(artifactRoot, { recursive: true }); await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  console.error(JSON.stringify({ status: 'FAIL', receipt: receiptRelative, code: failure.code,
    error: failure.error, cleanup: cleanupConfirmed }));
  process.exitCode = 1;
});
