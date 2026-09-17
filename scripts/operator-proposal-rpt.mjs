import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { command, installedFixture } from './release-cli.mjs';
import { shellQuote } from './release-process.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = join(root, '_testenv');
const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const hash = value => createHash('sha256').update(value).digest('hex');
const events = value => value.split(/\r?\n/u).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const COMPLEX_MARKER = '0.10.0-beta.1-v0912-language4-cost-rpt10-compaction-ref1-proposal1';
const COMPLEX_FILES = ['original-request.txt', 'service.json', 'rollout.json', 'receipt.json', 'verify.mjs'];
const COMPLEX_OUTPUTS = {
  service: { name: 'atlas', environment: 'staging', owner: 'platform', replicas: 3, health_path: '/healthz' },
  rollout: { service: 'atlas', strategy: 'canary', percentages: [10, 50, 100], gates: ['health', 'latency', 'errors'], rollback_on_failure: true },
  receipt: { release_id: 'atlas-staging-2026-09', status: 'ready', summary: 'atlas staging canary ready' },
};
const COMPLEX_REQUIREMENTS = [
  { id: 'R1', text: 'service.jsonのnameをatlasにする', kind: 'requirement' },
  { id: 'R2', text: 'service.jsonのenvironmentをstagingにする', kind: 'requirement' },
  { id: 'R3', text: 'service.jsonのownerをplatformにする', kind: 'requirement' },
  { id: 'R4', text: 'service.jsonのreplicasを数値3にする', kind: 'requirement' },
  { id: 'R5', text: 'service.jsonのhealth_pathを/healthzにする', kind: 'requirement' },
  { id: 'N1', text: 'service.jsonへcredential、secret、token、password、api_keyを追加しない', kind: 'negative' },
  { id: 'Q1', text: 'service.jsonを許可された5キーだけの有効なJSONとして改行付きで保存する', kind: 'quality' },
  { id: 'R6', text: 'rollout.jsonのserviceをatlasにしてservice.jsonと一致させる', kind: 'requirement' },
  { id: 'R7', text: 'rollout.jsonのstrategyをcanaryにする', kind: 'requirement' },
  { id: 'R8', text: 'rollout.jsonのpercentagesを数値配列[10,50,100]にする', kind: 'requirement' },
  { id: 'R9', text: 'rollout.jsonのgatesを順序付き配列[health,latency,errors]にする', kind: 'requirement' },
  { id: 'R10', text: 'rollout.jsonのrollback_on_failureをtrueにする', kind: 'requirement' },
  { id: 'N2', text: 'rollout.jsonへskip_checks、credential、secret、tokenを追加しない', kind: 'negative' },
  { id: 'Q2', text: 'canary percentagesを重複なしの昇順かつ100終端、gatesを重複なしにする', kind: 'quality' },
  { id: 'R11', text: 'receipt.jsonのrelease_idをatlas-staging-2026-09にする', kind: 'requirement' },
  { id: 'R12', text: 'receipt.jsonのstatusをreadyにする', kind: 'requirement' },
  { id: 'R13', text: 'receipt.jsonのsummaryをatlas staging canary readyにする', kind: 'requirement' },
  { id: 'N3', text: 'receipt.jsonへcredential、secret、token、password、api_keyを追加しない', kind: 'negative' },
  { id: 'Q3', text: '3ファイルを相互整合した2-space canonical JSONと末尾改行で完成させる', kind: 'quality' },
];
const COMPLEX_GROUPS = [Array.from({ length: 7 }, (_, index) => index), Array.from({ length: 7 }, (_, index) => index + 7),
  Array.from({ length: 5 }, (_, index) => index + 14)];
const COMPLEX_COMMANDS = ['node verify.mjs stage1', 'node verify.mjs stage2', 'node verify.mjs final'];

const canonicalJSON = value => JSON.stringify(value, null, 2) + '\n';
const complexValidator = `import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const mode=process.argv[2];assert(['stage1','stage2','final'].includes(mode),'mode must be stage1, stage2, or final');
const load=async name=>{const text=await readFile(new URL('./'+name,import.meta.url),'utf8');assert(text.endsWith('\\n'),name+' needs final newline');return{text,value:JSON.parse(text)}};
const forbidden=(name,value,extra=[])=>{const keys=Object.keys(value);assert.equal(keys.some(key=>/credential|secret|token|password|api_key/i.test(key)||extra.includes(key)),false,name+' contains forbidden key')};
const exact=(name,actual,expected)=>{assert.deepEqual(actual,expected,name+' content mismatch');assert.equal(Object.keys(actual).join(','),Object.keys(expected).join(','),name+' schema mismatch')};
const expectedService=${JSON.stringify(COMPLEX_OUTPUTS.service)};
const expectedRollout=${JSON.stringify(COMPLEX_OUTPUTS.rollout)};
const expectedReceipt=${JSON.stringify(COMPLEX_OUTPUTS.receipt)};
const service=await load('service.json');forbidden('service.json',service.value);exact('service.json',service.value,expectedService);assert(service.value.health_path.startsWith('/'));
if(mode!=='stage1'){const rollout=await load('rollout.json');forbidden('rollout.json',rollout.value,['skip_checks']);exact('rollout.json',rollout.value,expectedRollout);assert.equal(rollout.value.service,service.value.name);assert(rollout.value.percentages.every((value,index,array)=>index===0||value>array[index-1]));assert.equal(rollout.value.percentages.at(-1),100);assert.equal(new Set(rollout.value.gates).size,rollout.value.gates.length);
if(mode==='final'){const receipt=await load('receipt.json');forbidden('receipt.json',receipt.value);exact('receipt.json',receipt.value,expectedReceipt);assert.equal(receipt.value.release_id,service.value.name+'-'+service.value.environment+'-2026-09');assert.equal(receipt.value.summary,service.value.name+' '+service.value.environment+' '+rollout.value.strategy+' ready');for(const [name,item,expected] of [['service.json',service,expectedService],['rollout.json',rollout,expectedRollout],['receipt.json',receipt,expectedReceipt]])assert.equal(item.text,JSON.stringify(expected,null,2)+'\\n',name+' is not canonical JSON');}}
console.log('COMPLEX_PROPOSAL_'+mode.toUpperCase()+'_PASS');
`;

async function targeted() {
  const commands = [
    [process.execPath, [npmCli, '--prefix', root, 'run', 'build']],
    ['node', ['--experimental-strip-types', '--import', pathToFileURL(join(root, 'test/setup.ts')).href, '--test', '--test-concurrency=1',
      join(root, 'test/operator-proposal.test.ts'), join(root, 'test/v010-runtime.test.ts'), join(root, 'test/initialize.test.ts'), join(root, 'test/plugin-loader.test.ts')]],
  ];
  const evidence = [];
  for (const [executable, args] of commands) {
    try { await command(executable, args, root, {}, 1_200_000); }
    catch (error) {
      const output = error?.processResult;
      const bounded = `${output?.stdout ?? ''}\n${output?.stderr ?? ''}`.split(/\r?\n/u)
        .filter(line => /^(?:not ok|# fail|# pass|\s*(?:error:|code:|expected:|actual:))|AssertionError|ERR_|operator-proposal/u.test(line)).slice(0, 32);
      console.error(JSON.stringify({ phase: 'targeted-failure', exit: output?.code ?? null, bounded }));
      throw error;
    }
    evidence.push({ command: [executable, ...args], exit: 0, fingerprint: hash(JSON.stringify([executable, ...args])) });
  }
  console.log(JSON.stringify({ schema: 1, artifact: 'operator-proposal-targeted', evidence }));
}

function models(ids) {
  const db = new DatabaseSync(join(process.env.XDG_DATA_HOME ?? join(os.homedir(), '.local/share'), 'opencode/opencode.db'), { readOnly: true });
  try {
    const query = db.prepare(`SELECT json_extract(data,'$.agent') agent,json_extract(data,'$.modelID') model,json_extract(data,'$.variant') variant,count(*) steps FROM message WHERE session_id=? AND json_extract(data,'$.role')='assistant' GROUP BY 1,2,3`);
    return [...new Set(ids.filter(Boolean))].flatMap(session => query.all(session).map(row => ({ session, ...row })));
  } finally { db.close(); }
}
function lastText(id) {
  if (!id) return null;
  const db = new DatabaseSync(join(process.env.XDG_DATA_HOME ?? join(os.homedir(), '.local/share'), 'opencode/opencode.db'), { readOnly: true });
  try { return String(db.prepare(`SELECT json_extract(p.data,'$.text') text FROM part p JOIN message m ON m.id=p.message_id WHERE m.session_id=? AND json_extract(m.data,'$.role')='assistant' AND json_extract(p.data,'$.type')='text' ORDER BY m.time_created DESC,p.time_created DESC LIMIT 1`).get(id)?.text ?? '').slice(0, 500); }
  finally { db.close(); }
}
function lastToolInput(id) {
  if (!id) return null;
  const db = new DatabaseSync(join(process.env.XDG_DATA_HOME ?? join(os.homedir(), '.local/share'), 'opencode/opencode.db'), { readOnly: true });
  try { return String(db.prepare(`SELECT json_extract(p.data,'$.state.input.proposal_json') input FROM part p JOIN message m ON m.id=p.message_id WHERE m.session_id=? AND json_extract(p.data,'$.type')='tool' AND json_extract(p.data,'$.tool')='sortie_v010_submit_operator_proposal' ORDER BY p.time_created DESC LIMIT 1`).get(id)?.input ?? '').slice(0, 2500); }
  finally { db.close(); }
}
function proposalInputShape(id) {
  if (!id) return null;
  const db = new DatabaseSync(join(process.env.XDG_DATA_HOME ?? join(os.homedir(), '.local/share'), 'opencode/opencode.db'), { readOnly: true });
  try {
    const input = db.prepare(`SELECT json_extract(p.data,'$.state.input.proposal_json') input FROM part p JOIN message m ON m.id=p.message_id WHERE m.session_id=? AND json_extract(p.data,'$.type')='tool' AND json_extract(p.data,'$.tool')='sortie_v010_submit_operator_proposal' ORDER BY p.time_created DESC LIMIT 1`).get(id)?.input;
    const raw = typeof input === 'string' ? input : '';
    const packet = JSON.parse(raw);
    return { acceptance_present: Object.hasOwn(packet?.plan ?? {}, 'acceptance'), input_hash: hash(raw) };
  } finally { db.close(); }
}
function beginIntentShape(id) {
  if (!id) return null;
  const db = new DatabaseSync(join(process.env.XDG_DATA_HOME ?? join(os.homedir(), '.local/share'), 'opencode/opencode.db'), { readOnly: true });
  try {
    const input = db.prepare(`SELECT json_extract(p.data,'$.state.input.intent_json') input FROM part p JOIN message m ON m.id=p.message_id WHERE m.session_id=? AND json_extract(p.data,'$.type')='tool' AND json_extract(p.data,'$.tool')='sortie_v010_begin_operator_proposal' ORDER BY p.time_created LIMIT 1`).get(id)?.input;
    const raw = typeof input === 'string' ? input : '';
    const intent = JSON.parse(raw);
    return { proposal_budget_omitted: !Object.hasOwn(intent, 'proposal_budget'), requirements: intent.requirements?.length ?? null,
      kinds: intent.requirements?.reduce((counts, item) => ({ ...counts, [item.kind]: (counts[item.kind] ?? 0) + 1 }), {}) ?? {}, input_hash: hash(raw) };
  } finally { db.close(); }
}
function lastApprovalInput(id) {
  const db = new DatabaseSync(join(process.env.XDG_DATA_HOME ?? join(os.homedir(), '.local/share'), 'opencode/opencode.db'), { readOnly: true });
  try { return String(db.prepare(`SELECT json_extract(p.data,'$.state.input.approval_json') input FROM part p JOIN message m ON m.id=p.message_id WHERE m.session_id=? AND json_extract(p.data,'$.type')='tool' AND json_extract(p.data,'$.tool')='sortie_v010_approve_operator_proposal' ORDER BY p.time_created DESC LIMIT 1`).get(id)?.input ?? '').slice(0, 1600); }
  finally { db.close(); }
}

function proposalTransport(rootID, childID) {
  const db = new DatabaseSync(join(process.env.XDG_DATA_HOME ?? join(os.homedir(), '.local/share'), 'opencode/opencode.db'), { readOnly: true });
  try {
    const begin = db.prepare(`SELECT json_extract(data,'$.state.output') output FROM part WHERE session_id=? AND json_extract(data,'$.type')='tool' AND json_extract(data,'$.tool')='sortie_v010_begin_operator_proposal' AND json_extract(data,'$.state.status')='completed' ORDER BY time_created LIMIT 1`).get(rootID);
    const native = db.prepare(`SELECT json_extract(data,'$.state.input.prompt') prompt,json_extract(data,'$.state.input.description') description,json_extract(data,'$.state.input.subagent_type') subagent_type FROM part WHERE session_id=? AND json_extract(data,'$.type')='tool' AND json_extract(data,'$.tool')='task' AND json_extract(data,'$.state.status')='completed' ORDER BY time_created LIMIT 1`).get(rootID);
    const child = db.prepare(`SELECT json_extract(p.data,'$.text') text FROM part p JOIN message m ON m.id=p.message_id WHERE m.session_id=? AND json_extract(m.data,'$.role')='user' AND json_extract(p.data,'$.type')='text' ORDER BY m.time_created,p.time_created LIMIT 1`).get(childID);
    const returnedTask = JSON.parse(String(begin?.output ?? '{}')).task ?? {};
    const short = returnedTask.prompt;
    const childPrompt = String(child?.text ?? '');
    let reference = null;
    try { reference = JSON.parse(String(short).slice('SORTIE_OPERATOR_PROPOSAL_TASK_REF '.length)); } catch { /* reported as non-equivalent */ }
    const nativeTask = { subagent_type: String(native?.subagent_type ?? ''), description: String(native?.description ?? ''), prompt: String(native?.prompt ?? '') };
    const childTask = { ...nativeTask, prompt: childPrompt };
    return {
      short_reference: typeof short === 'string' && short.startsWith('SORTIE_OPERATOR_PROPOSAL_TASK_REF '),
      short_bytes: typeof short === 'string' ? Buffer.byteLength(short) : null,
      canonical_bytes: Buffer.byteLength(childPrompt),
      short_hash: typeof short === 'string' ? hash(short) : null,
      native_task_hash: hash(JSON.stringify(nativeTask)), child_prompt_hash: hash(childPrompt),
      native_reference_preserved: JSON.stringify(nativeTask) === JSON.stringify(returnedTask),
      child_canonical_bound: typeof reference?.h === 'string' && reference.h === hash(JSON.stringify(childTask)) && nativeTask.prompt !== childTask.prompt,
      reference_canonical_hash: reference?.h ?? null,
      child_canonical_task_hash: hash(JSON.stringify(childTask)),
      description: String(native?.description ?? ''),
    };
  } finally { db.close(); }
}

function workerTransports(parentID, childIDs) {
  const db = new DatabaseSync(join(process.env.XDG_DATA_HOME ?? join(os.homedir(), '.local/share'), 'opencode/opencode.db'), { readOnly: true });
  try {
    const returned = db.prepare(`SELECT json_extract(data,'$.state.output') output FROM part WHERE session_id=? AND json_extract(data,'$.type')='tool' AND json_extract(data,'$.tool')='sortie_v010_operator_next' AND json_extract(data,'$.state.status')='completed' ORDER BY time_created`).all(parentID);
    const native = db.prepare(`SELECT json_extract(data,'$.state.input.prompt') prompt,json_extract(data,'$.state.input.description') description,json_extract(data,'$.state.input.subagent_type') subagent_type FROM part WHERE session_id=? AND json_extract(data,'$.type')='tool' AND json_extract(data,'$.tool')='task' AND json_extract(data,'$.state.status')='completed' ORDER BY time_created`).all(parentID);
    const child = db.prepare(`SELECT s.parent_id parent,json_extract(p.data,'$.text') text FROM session s JOIN message m ON m.session_id=s.id JOIN part p ON p.message_id=m.id WHERE s.id=? AND json_extract(m.data,'$.role')='user' AND json_extract(p.data,'$.type')='text' ORDER BY m.time_created,p.time_created LIMIT 1`);
    return childIDs.map((childID, index) => {
      const returnedTask = JSON.parse(String(returned[index]?.output ?? '{}')).task ?? {};
      const nativeTask = { subagent_type: String(native[index]?.subagent_type ?? ''), description: String(native[index]?.description ?? ''), prompt: String(native[index]?.prompt ?? '') };
      const childRow = child.get(childID);
      const childTask = { ...nativeTask, prompt: String(childRow?.text ?? '') };
      let reference = null;
      try { reference = JSON.parse(nativeTask.prompt.slice('SORTIE_OPERATOR_TASK_REF '.length)); } catch { /* reported as invalid */ }
      return {
        child: childID, native_parent: String(childRow?.parent ?? ''), reference_serialized: nativeTask.prompt.startsWith('SORTIE_OPERATOR_TASK_REF '),
        returned_reference_hash: hash(JSON.stringify(returnedTask)), native_reference_hash: hash(JSON.stringify(nativeTask)),
        native_reference_preserved: JSON.stringify(nativeTask) === JSON.stringify(returnedTask),
        reference_canonical_hash: reference?.h ?? null, child_canonical_hash: hash(JSON.stringify(childTask)),
        child_canonical_bound: typeof reference?.h === 'string' && reference.h === hash(JSON.stringify(childTask)) && nativeTask.prompt !== childTask.prompt,
      };
    });
  } finally { db.close(); }
}

function delegateTransport(rootID, childID) {
  const db = new DatabaseSync(join(process.env.XDG_DATA_HOME ?? join(os.homedir(), '.local/share'), 'opencode/opencode.db'), { readOnly: true });
  try {
    const approvals = db.prepare(`SELECT json_extract(data,'$.state.output') output FROM part WHERE session_id=? AND json_extract(data,'$.type')='tool' AND json_extract(data,'$.tool')='sortie_v010_approve_operator_proposal' AND json_extract(data,'$.state.status')='completed' ORDER BY time_created`).all(rootID);
    const returnedTask = approvals.map(row => JSON.parse(String(row.output ?? '{}'))?.execution?.task).find(task => task?.prompt?.startsWith('SORTIE_OPERATOR_DELEGATE_REF ')) ?? {};
    const nativeRows = db.prepare(`SELECT json_extract(data,'$.state.input.prompt') prompt,json_extract(data,'$.state.input.description') description,json_extract(data,'$.state.input.subagent_type') subagent_type FROM part WHERE session_id=? AND json_extract(data,'$.type')='tool' AND json_extract(data,'$.tool')='task' ORDER BY time_created`).all(rootID);
    const native = nativeRows.find(row => String(row.prompt ?? '').startsWith('SORTIE_OPERATOR_DELEGATE_REF ')) ?? {};
    const nativeTask = { subagent_type: String(native.subagent_type ?? ''), description: String(native.description ?? ''), prompt: String(native.prompt ?? '') };
    const child = db.prepare(`SELECT s.parent_id parent,json_extract(p.data,'$.text') text FROM session s JOIN message m ON m.session_id=s.id JOIN part p ON p.message_id=m.id WHERE s.id=? AND json_extract(m.data,'$.role')='user' AND json_extract(p.data,'$.type')='text' ORDER BY m.time_created,p.time_created LIMIT 1`).get(childID);
    const childTask = { ...nativeTask, prompt: String(child?.text ?? '') };
    let reference = null;
    try { reference = JSON.parse(nativeTask.prompt.slice('SORTIE_OPERATOR_DELEGATE_REF '.length)); } catch { /* reported as invalid */ }
    return {
      child: childID, native_parent: String(child?.parent ?? ''), reference_serialized: nativeTask.prompt.startsWith('SORTIE_OPERATOR_DELEGATE_REF '),
      returned_reference_hash: hash(JSON.stringify(returnedTask)), native_reference_hash: hash(JSON.stringify(nativeTask)),
      native_reference_preserved: JSON.stringify(nativeTask) === JSON.stringify(returnedTask), reference_canonical_hash: reference?.h ?? null,
      child_canonical_hash: hash(JSON.stringify(childTask)), child_canonical_bound: typeof reference?.h === 'string' &&
        reference.h === hash(JSON.stringify(childTask)) && nativeTask.prompt !== childTask.prompt,
    };
  } finally { db.close(); }
}

function executionTiming(root, workerIDs) {
  const db = new DatabaseSync(join(process.env.XDG_DATA_HOME ?? join(os.homedir(), '.local/share'), 'opencode/opencode.db'), { readOnly: true });
  try {
    const window = db.prepare(`SELECT min(time_created) started,max(time_created) ended FROM message WHERE session_id=?`);
    const rootTurns = db.prepare(`SELECT count(*) turns FROM message WHERE session_id=? AND json_extract(data,'$.role')='assistant' AND time_created>? AND time_created<?`);
    const worker_windows = workerIDs.filter(Boolean).map(session => ({ session, ...window.get(session) }));
    const between = worker_windows.slice(1).map((current, index) => worker_windows[index].ended !== null && current.started !== null
      ? Number(rootTurns.get(root, worker_windows[index].ended, current.started)?.turns ?? 0) : null);
    return { worker_windows, root_normal_turns_between_workers: between.every(value => value !== null)
      ? between.reduce((total, value) => total + value, 0) : null, root_turns_between_worker_pairs: between };
  } finally { db.close(); }
}

function taskCalls(ids) {
  const db = new DatabaseSync(join(process.env.XDG_DATA_HOME ?? join(os.homedir(), '.local/share'), 'opencode/opencode.db'), { readOnly: true });
  try {
    const query = db.prepare(`SELECT count(*) calls FROM part p JOIN message m ON m.id=p.message_id WHERE m.session_id=? AND json_extract(p.data,'$.type')='tool' AND json_extract(p.data,'$.tool')='task'`);
    return [...new Set(ids.filter(Boolean))].reduce((total, session) => total + Number(query.get(session)?.calls ?? 0), 0);
  } finally { db.close(); }
}

function toolErrors(ids) {
  const db = new DatabaseSync(join(process.env.XDG_DATA_HOME ?? join(os.homedir(), '.local/share'), 'opencode/opencode.db'), { readOnly: true });
  try {
    const query = db.prepare(`SELECT json_extract(data,'$.tool') tool,json_extract(data,'$.state.error') error FROM part WHERE session_id=? AND json_extract(data,'$.type')='tool' AND json_extract(data,'$.state.status')='error' ORDER BY time_created`);
    return [...new Set(ids.filter(Boolean))].flatMap(session => query.all(session).map(row => ({
      session, tool: row.tool, code: String(row.error ?? '').split(/\r?\n/u)[0].slice(0, 160),
    })));
  } finally { db.close(); }
}

function descendantSessions(rootID) {
  const db = new DatabaseSync(join(process.env.XDG_DATA_HOME ?? join(os.homedir(), '.local/share'), 'opencode/opencode.db'), { readOnly: true });
  try {
    const rows = db.prepare('SELECT id,parent_id FROM session').all();
    const found = [rootID];
    for (let index = 0; index < found.length; index++) {
      for (const row of rows) if (row.parent_id === found[index] && !found.includes(row.id)) found.push(row.id);
    }
    return found;
  } finally { db.close(); }
}

function nativeStages(stages) {
  const db = new DatabaseSync(join(process.env.XDG_DATA_HOME ?? join(os.homedir(), '.local/share'), 'opencode/opencode.db'), { readOnly: true });
  try {
    const messages = db.prepare(`SELECT count(*) messages,sum(CASE WHEN json_extract(data,'$.role')='assistant' THEN 1 ELSE 0 END) assistant_steps,min(time_created) started,max(time_created) ended FROM message WHERE session_id=?`);
    const tools = db.prepare(`SELECT json_extract(data,'$.tool') tool,json_extract(data,'$.state.status') status,count(*) count FROM part WHERE session_id=? AND json_extract(data,'$.type')='tool' GROUP BY 1,2 ORDER BY 1,2`);
    return stages.filter(([, session]) => session).map(([stage, session]) => {
      const counts = messages.get(session), started = Number(counts?.started ?? 0), ended = Number(counts?.ended ?? 0);
      return { stage, session, messages: Number(counts?.messages ?? 0), assistant_steps: Number(counts?.assistant_steps ?? 0),
        elapsed_ms: started > 0 && ended >= started ? ended - started : null,
        tool_codes: tools.all(session).slice(0, 24).map(row => ({ tool: row.tool, status: row.status, count: Number(row.count) })) };
    });
  } finally { db.close(); }
}

async function processCleanup(project) {
  if (process.platform === 'win32') return { checked: false, remaining: null, polls: 0 };
  const marker = resolve(project);
  for (let poll = 1; poll <= 10; poll++) {
    const remaining = [];
    for (const entry of await readdir('/proc', { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/u.test(entry.name) || Number(entry.name) === process.pid) continue;
      const cwd = await readlink(`/proc/${entry.name}/cwd`).catch(() => '');
      const commandLine = await readFile(`/proc/${entry.name}/cmdline`, 'utf8').catch(() => '');
      if (cwd === marker || cwd.startsWith(`${marker}/`) || commandLine.includes(marker)) remaining.push(entry.name);
    }
    if (remaining.length === 0) return { checked: true, remaining: 0, polls: poll };
    if (poll < 10) await new Promise(resolveDelay => setTimeout(resolveDelay, 1_000));
    else return { checked: true, remaining: remaining.length, polls: poll };
  }
}

function complexRequest() {
  return [
    '3段階のstaging canary release資料を、保護されたverify.mjsを変更せず順番に完成させる。',
    'unit 1はservice.jsonだけ、unit 2はrollout.jsonだけ、unit 3はreceipt.jsonだけを変更する。各unitはその時点までの状態をverify.mjsの対応stageで検証する。',
    '3 unitは順序依存。proposal予約1とexecution 3を収容するgoal_budget_units=4。sourceはoriginal-request.txt、service.json、rollout.json、receipt.json、verify.mjs。',
    '以下は順序・ID・本文・kindがauthoritativeな19要件:',
    ...COMPLEX_REQUIREMENTS.map(item => `${item.id} [${item.kind}]: ${item.text}`),
  ].join('\n');
}

async function seedComplex(project, env, runtime) {
  const originalRequest = complexRequest();
  await writeFile(join(project, 'AGENTS.md'), '# Complex anonymous proposal fixture\nProposal phase is read-only. Preserve verify.mjs and original-request.txt. Execute exactly three ordered units; each worker edits only its assigned JSON file and never commits.\n');
  await writeFile(join(project, '.gitignore'), `.opencode/\n${runtime.stateDirectory}/\n`);
  for (const name of ['service.json', 'rollout.json', 'receipt.json']) await writeFile(join(project, name), '{"state":"pending"}\n');
  await writeFile(join(project, 'verify.mjs'), complexValidator);
  await writeFile(join(project, 'original-request.txt'), originalRequest);
  await command('git', ['init', '-q', '-b', 'main'], project, env);
  await command('git', ['add', '--', 'AGENTS.md', '.gitignore', ...COMPLEX_FILES], project, env);
  await command('git', ['-c', 'user.name=Sortie Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Seed complex proposal fixture'], project, env);
  return { originalRequest, validatorHash: hash(complexValidator) };
}

async function expectedValidatorFailure(project, env, mode) {
  try { await command('node', ['verify.mjs', mode], project, env); }
  catch (error) {
    assert.notEqual(error?.processResult?.code, 0, `validator ${mode} did not return a real nonzero exit`);
    return error.processResult.code;
  }
  assert.fail(`validator ${mode} accepted a protected negative violation`);
}

function proofCommandMap(proposal) {
  const defaults = proposal.plan.goal_declaration.defaults ?? {};
  return new Map(proposal.plan.goal_declaration.criteria.map(item => [item.criterion_id ?? item.goal_criterion_id,
    item.validation_command ?? item.goal_validation_command ?? defaults.validation_command ?? defaults.goal_validation_command]));
}

function verifyComplexProposal(proposal) {
  assert.equal(proposal.plan.units.length, 3, 'complex proposal must contain exactly three units');
  assert.deepEqual(proposal.plan.acceptance, COMPLEX_REQUIREMENTS.map(item => item.text));
  assert.equal(proposal.plan.goal_declaration.goal_budget_units, 4, 'proposal plus three execution units require budget four');
  assert.equal(proposal.budget_estimate.execution_units, 3);
  const commands = proofCommandMap(proposal);
  const writes = ['service.json', 'rollout.json', 'receipt.json'];
  for (const [unitIndex, unit] of proposal.plan.units.entries()) {
    assert.deepEqual(unit.write, [writes[unitIndex]], `unit ${unitIndex + 1} must own one distinct output`);
    assert.deepEqual(unit.acceptance_indices, COMPLEX_GROUPS[unitIndex], `unit ${unitIndex + 1} acceptance assignment changed`);
    assert(unit.validation.includes(COMPLEX_COMMANDS[unitIndex]), `unit ${unitIndex + 1} lacks its protected stage validator`);
    for (const acceptanceIndex of COMPLEX_GROUPS[unitIndex]) {
      assert(proposal.plan.acceptance_proof[acceptanceIndex].some(id => commands.get(id) === COMPLEX_COMMANDS[unitIndex]),
        `acceptance ${acceptanceIndex} is not mapped to its behavioral stage validator`);
    }
  }
  assert.deepEqual(proposal.coverage.map(item => item.requirement_id), COMPLEX_REQUIREMENTS.map(item => item.id));
  assert.deepEqual(proposal.uncovered, []);
  assert.deepEqual([...new Set(proposal.negative_handling.map(item => item.requirement_id))].sort(), ['N1', 'N2', 'N3']);
  return { mapped_requirements: proposal.plan.acceptance_proof.length, units: proposal.plan.units.length,
    unique_worker_writes: new Set(proposal.plan.units.flatMap(unit => unit.write)).size,
    protected_commands: COMPLEX_COMMANDS.every(commandValue => [...commands.values()].includes(commandValue)) };
}

async function prepareComplexInside(tgz, directory) {
  const startedAt = Date.now();
  const fixture = await installedFixture(tgz, directory, 'beta-v010');
  const { project, env, runtime } = fixture;
  const seeded = await seedComplex(project, env, runtime);
  const stages = [];
  await writeFile(join(project, 'service.json'), canonicalJSON(COMPLEX_OUTPUTS.service));
  await command('node', ['verify.mjs', 'stage1'], project, env); stages.push({ stage: 'stage1-positive', command: COMPLEX_COMMANDS[0], exit: 0 });
  await writeFile(join(project, 'service.json'), canonicalJSON({ ...COMPLEX_OUTPUTS.service, token: 'forbidden-fixture-value' }));
  stages.push({ stage: 'stage1-negative', command: COMPLEX_COMMANDS[0], exit: await expectedValidatorFailure(project, env, 'stage1') });
  await writeFile(join(project, 'service.json'), canonicalJSON(COMPLEX_OUTPUTS.service));
  await writeFile(join(project, 'rollout.json'), canonicalJSON(COMPLEX_OUTPUTS.rollout));
  await command('node', ['verify.mjs', 'stage2'], project, env); stages.push({ stage: 'stage2-positive', command: COMPLEX_COMMANDS[1], exit: 0 });
  await writeFile(join(project, 'rollout.json'), canonicalJSON({ ...COMPLEX_OUTPUTS.rollout, skip_checks: true }));
  stages.push({ stage: 'stage2-negative', command: COMPLEX_COMMANDS[1], exit: await expectedValidatorFailure(project, env, 'stage2') });
  await writeFile(join(project, 'rollout.json'), canonicalJSON(COMPLEX_OUTPUTS.rollout));
  await writeFile(join(project, 'receipt.json'), canonicalJSON(COMPLEX_OUTPUTS.receipt));
  await command('node', ['verify.mjs', 'final'], project, env); stages.push({ stage: 'final-positive', command: COMPLEX_COMMANDS[2], exit: 0 });
  await writeFile(join(project, 'receipt.json'), canonicalJSON({ ...COMPLEX_OUTPUTS.receipt, api_key: 'forbidden-fixture-value' }));
  stages.push({ stage: 'final-negative', command: COMPLEX_COMMANDS[2], exit: await expectedValidatorFailure(project, env, 'final') });
  assert.equal(hash(await readFile(join(project, 'verify.mjs'))), seeded.validatorHash);
  const cleanup = await processCleanup(project); assert.equal(cleanup.remaining, 0);
  const report = { schema: 1, artifact: 'operator-proposal-complex-prepare', status: 'PASS', package_version: fixture.pkg.version,
    runtime_marker: fixture.runtimeMarker, cli_version: fixture.cliVersion, requirements: COMPLEX_REQUIREMENTS.length, units: 3,
    validator_unchanged: true, stages, elapsed_ms: Date.now() - startedAt, process_cleanup: cleanup };
  const receipt = join(fixture.run, 'operator-proposal-complex-prepare.json');
  await writeFile(receipt, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, receipt: relative(root, receipt).replaceAll('\\', '/') }));
}

async function cliInside(tgz, directory) {
  const fixture = await installedFixture(tgz, directory, 'beta-v010');
  const { project, env, runtime, coordinatorAgent, operatorAgent, workerAgent, reduceGoalFlight } = fixture;
  const validator = "import assert from'node:assert/strict';import{readFile}from'node:fs/promises';assert.equal((await readFile(new URL('./result-a.txt',import.meta.url),'utf8')).trim(),'proposal-a');if(process.argv[2]!=='a')assert.equal((await readFile(new URL('./result-b.txt',import.meta.url),'utf8')).trim(),'proposal-b');\n";
  await writeFile(join(project, 'AGENTS.md'), '# Anonymous proposal fixture\nProposal phase is read-only. Each approved worker edits only its assigned result file. Preserve verify.mjs.\n');
  await writeFile(join(project, '.gitignore'), '.opencode/\n.sortie-dogs-v010/\n');
  await writeFile(join(project, 'result-a.txt'), 'pending\n'); await writeFile(join(project, 'result-b.txt'), 'pending\n'); await writeFile(join(project, 'verify.mjs'), validator);
  await command('git', ['init', '-q', '-b', 'main'], project, env);
  await command('git', ['add', '--', 'AGENTS.md', '.gitignore', 'result-a.txt', 'result-b.txt', 'verify.mjs'], project, env);
  await command('git', ['-c', 'user.name=Sortie Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Seed proposal fixture'], project, env);
  const expectedRequirements = [
      { id: 'R1', text: 'result-a.txtをproposal-aへ変更する', kind: 'requirement' },
      { id: 'R2', text: 'result-b.txtをproposal-bへ変更する', kind: 'requirement' },
      { id: 'N1', text: 'verify.mjsを変更しない', kind: 'negative' },
      { id: 'Q1', text: 'node verify.mjsが成功する', kind: 'quality' },
    ];
  const originalRequest = '下位がresult-a.txtとresult-b.txtを別unitで変更し、verify.mjsを変更せず検証する。順序付き2 unitとし、unit 1はresult-a.txtだけを書いてnode verify.mjs a、unit 2はresult-b.txtだけを書いてnode verify.mjsを実行する。GoalDeclarationはproposal予約1とexecution 2を収容するgoal_budget_units=3とする。\n\n元要求（順序とID、各要件の本文を保持）:\n'
    + expectedRequirements.map(item => `${item.id}: ${item.text}`).join('\n');
  const requestPath = join(project, 'original-request.txt'); await writeFile(requestPath, originalRequest);
  async function cli(prompt, session) {
    return events(await command('timeout', ['--signal=TERM', '--kill-after=10s', '1200s', 'opencode', 'run', '--dir', project,
      '--format', 'json', '--print-logs', '--agent', coordinatorAgent, '--model', 'openai/gpt-5.6-sol', '--variant', 'low',
      ...(session ? ['--session', session] : []), prompt], project, env, 1_240_000));
  }
  const opened = await cli('匿名proposal RPTを開始する。toolを呼ばずPROPOSAL_RPT_READYだけ返す。');
  const sessionID = opened.find(event => event.sessionID)?.sessionID; assert(sessionID, 'root session missing');
  process.stderr.write(JSON.stringify({ phase: 'checkpoint', fixture: fixture.run, sessionID,
    package_version: fixture.pkg.version, runtime_marker: fixture.runtimeMarker, cli_version: fixture.cliVersion }) + '\n');
  const proposedEvents = await cli(`${requestPath} は完成済みintent JSONではなく元要求の原文である。原文ファイル末尾は改行なし（Read表示の改行は追加禁止）。Readし、toolが公開するcanonical schemaに従い自分でintent_jsonを生成してsortie_v010_begin_operator_proposalを一度呼ぶ。原文全体を一字も弱めず保持し、出典はuser:anonymous-proposal。4要件のID・順序・本文を保持し、実装要求・禁止事項・品質条件を区別する。調査許可はresult-a.txt、result-b.txt、verify.mjsのみ、read上限5、submission上限3。tool error発生時は修復再実行せず停止して報告する。返された${operatorAgent} Taskのshort referenceを何も追記せず完全一致で一度実行し、proposal提出まで行う。proposal内容は元要求、許可されたRead結果、hostが提示するTask/tool contractだけから生成する。root側からproposal packetのcriteria、proof mapping、acceptance indices、validation配列を事前指定しない。canonical全文をhandoffへ複写しない。rootはsource編集、prepare_operator、approve、worker実行をまだ行わない。提出後、承認せず停止する。`, sessionID);
  const entryFailures = proposedEvents.filter(event => event.type === 'tool_use' && event.part?.state?.status === 'error')
    .map(event => ({ tool: event.part.tool, error: String(event.part.state.error).split(/\r?\n/u)[0].slice(0, 240) }));
  assert.equal(entryFailures.length, 0, `model-generated-intent/tool-failure:${JSON.stringify(entryFailures)}`);
  const proposalPath = join(project, runtime.stateDirectory, 'operator-proposals', `${hash(sessionID)}.json`);
  const submitted = JSON.parse(await readFile(proposalPath, 'utf8'));
  assert.deepEqual(submitted.intent, { schema_version: '0.1', original_request: { text: originalRequest, source_ref: 'user:anonymous-proposal' },
    requirements: expectedRequirements, authoritative_refs: ['user:anonymous-proposal'],
    allow_read: ['result-a.txt', 'result-b.txt', 'verify.mjs'], proposal_budget: { max_reads: 5, max_submissions: 3 } }, 'model-generated intent must preserve the complete request and exact requirements');
  if (submitted.phase !== 'submitted') {
    const failures = proposedEvents.filter(event => event.type === 'tool_use' && event.part?.state?.status === 'error')
      .map(event => ({ tool: event.part.tool, error: String(event.part.state.error).split(/\r?\n/u)[0].slice(0, 240) }));
    throw new Error(`proposal-not-submitted:${JSON.stringify({ phase: submitted.phase, reads: submitted.read_count, submissions: submitted.submission_count, failures, child_text: lastText(submitted.proposal_session_id), input: lastToolInput(submitted.proposal_session_id) })}`);
  }
  const proposalInput = proposalInputShape(submitted.proposal_session_id);
  assert.equal(proposalInput?.acceptance_present, false, 'generated proposal must omit host-derived plan.acceptance');
  assert.deepEqual(submitted.proposal.acceptance, undefined);
  assert.deepEqual(submitted.proposal.plan.acceptance, expectedRequirements.map(item => item.text));
  assert.equal(submitted.proposal_hash, hash(JSON.stringify(submitted.proposal)), 'durable proposal hash must cover host-materialized acceptance');
  const proposalErrors = toolErrors([sessionID, submitted.proposal_session_id]);
  assert.equal(proposalErrors.length, 0, `proposal-child-tool-failure:${JSON.stringify(proposalErrors)}`);
  assert.equal((await readFile(join(project, 'result-a.txt'), 'utf8')).trim(), 'pending');
  assert.equal((await readFile(join(project, 'result-b.txt'), 'utf8')).trim(), 'pending');
  assert.equal(hash(await readFile(join(project, 'verify.mjs'))), hash(validator));
  const executedEvents = await cli('同じ元要求と提出proposalをsortie_v010_operator_statusで確認する。original requirement 4件、coverage、uncovered=[]、negative handling、read/write/2 unit/GoalDeclaration、proposal精算後に残るexecution予算を直接照合する。goal criterion IDはproposal内部のlocal IDなのでR1等との文字列一致を要求せず、acceptance_proof indexとvalidation_commandの対応で照合する。unit 1のproof commandはnode verify.mjs a、unit 2のproof commandはnode verify.mjsであることを確認する。approval_jsonのexact keysはproposal_id, revision, content_hash, compared_requirement_ids, decision, rationale。compared_requirement_ids=["R1","R2","N1","Q1"]とし、ordered_compared_requirement_idsという別名は禁止。proposal_id/revision/content_hash、decision="approve"、具体的rationaleでsortie_v010_approve_operator_proposalを一度呼ぶ。返された既存execution Taskを完全一致で一度だけ実行し、rootはsourceを編集せず、worker間にroot通常運行turnを挟まない。下位は各unitごとにoperator_nextを一度呼び、その時返された新しいTaskだけを一度実行して結果を待つ。直前Taskの再利用・再試行は禁止。unit 1 workerはresult-a.txtだけをproposal-aへ変更してnode verify.mjs a、unit 2 workerはresult-b.txtだけをproposal-bへ変更してnode verify.mjsを実行する。成功後run_id/acceptance_fingerprintでsortie_v010_complete_operatorを呼びreceipt.status=succeededで終了する。', sessionID);
  const approved = JSON.parse(await readFile(proposalPath, 'utf8'));
  const operatorPath = join(project, runtime.stateDirectory, 'operators', `${hash(sessionID)}.json`);
  const operatorSource = await readFile(operatorPath, 'utf8').catch(() => undefined);
  if (approved.phase !== 'approved' || !operatorSource) {
    const failures = executedEvents.filter(event => event.type === 'tool_use' && event.part?.state?.status === 'error')
      .map(event => ({ tool: event.part.tool, error: String(event.part.state.error).split(/\r?\n/u)[0].slice(0, 240) }));
    throw new Error(`proposal-not-executed:${JSON.stringify({ phase: approved.phase, failures, root_text: lastText(sessionID), approval: lastApprovalInput(sessionID), expected: { proposal_id: approved.proposal_id, revision: approved.proposal_revision, content_hash: approved.proposal_hash } })}`);
  }
  const operator = JSON.parse(operatorSource);
  const ledgerPath = join(project, '.git/sortie-dogs', runtime.flightDirectory, `${hash(`${runtime.id}\u0000${sessionID}`)}.json`);
  const goal = reduceGoalFlight(JSON.parse(await readFile(ledgerPath, 'utf8')).goal_events);
  const workerSessions = operator.units.map(unit => unit.childSessionID);
  const timing = executionTiming(sessionID, workerSessions);
  const transport = proposalTransport(sessionID, submitted.proposal_session_id);
  const report = {
    schema: 1,
    artifact: 'operator-proposal-cli',
    package_version: fixture.pkg.version,
    runtime_marker: fixture.runtimeMarker,
    root_session: sessionID,
    root_agent: coordinatorAgent,
    proposal_agent: operatorAgent,
    worker_agent: workerAgent,
    proposal_phase: approved.phase,
    intent_entry: 'model-generated-from-raw-request',
    original_request_hash: hash(originalRequest),
    intent_exact_match: true,
    proposal_reads: approved.read_count,
    proposal_submissions: approved.submission_count,
    proposal_id: approved.proposal_id,
    proposal_revision: approved.proposal_revision,
    proposal_hash: approved.proposal_hash,
    proposal_input_acceptance_omitted: proposalInput?.acceptance_present === false,
    proposal_input_hash: proposalInput?.input_hash ?? null,
    host_materialized_acceptance_exact: JSON.stringify(approved.proposal.plan.acceptance) === JSON.stringify(expectedRequirements.map(item => item.text)),
    host_canonical_hash_verified: approved.proposal_hash === hash(JSON.stringify(approved.proposal)),
    proposal_task_transport: transport,
    approval_rationale: approved.approval_rationale,
    uncovered: approved.proposal.uncovered,
    preapproval_unchanged: submitted.phase === 'submitted',
    operator_run_id: operator.runID,
    operator_phase: operator.phase,
    worker_statuses: operator.units.map(unit => unit.status),
    worker_sessions: workerSessions,
    terminal: goal.receipt?.status ?? goal.phase,
    results: [(await readFile(join(project, 'result-a.txt'), 'utf8')).trim(), (await readFile(join(project, 'result-b.txt'), 'utf8')).trim()],
    goal_consumed_units: goal.consumed_units,
    goal_unit_ids: goal.unit_ids,
    validator_unchanged: hash(await readFile(join(project, 'verify.mjs'))) === hash(validator),
    models: models([sessionID, submitted.proposal_session_id, operator.operatorSessionID, ...workerSessions]),
    worker_windows: timing.worker_windows,
    root_normal_turns_between_workers: timing.root_normal_turns_between_workers,
    task_calls: taskCalls([sessionID, submitted.proposal_session_id, operator.operatorSessionID]),
    nested_worker_task_calls: taskCalls(workerSessions),
    tool_errors: toolErrors([sessionID, submitted.proposal_session_id, operator.operatorSessionID, ...workerSessions]),
  };
  await writeFile(join(fixture.run, 'operator-proposal-rpt.json'), JSON.stringify(report, null, 2) + '\n');
  assert.equal(report.runtime_marker, '0.10.0-beta.1-v0912-language4-cost-rpt10-compaction-ref1-proposal1');
  assert(report.preapproval_unchanged && report.proposal_phase === 'approved' && report.proposal_submissions >= 1 && report.proposal_submissions <= 3 && report.uncovered.length === 0);
  assert(report.proposal_input_acceptance_omitted && report.host_materialized_acceptance_exact && report.host_canonical_hash_verified);
  if (!(report.proposal_reads > 0 && report.proposal_reads <= 5 && report.operator_phase === 'completed' && report.worker_statuses.every(status => status === 'succeeded'))) {
    throw new Error(`proposal-execution-incomplete:${JSON.stringify({ reads: report.proposal_reads, operator_phase: report.operator_phase,
      worker_statuses: report.worker_statuses, terminal: report.terminal, results: report.results, tool_errors: report.tool_errors, models: report.models })}`);
  }
  assert(report.terminal === 'succeeded' && JSON.stringify(report.results) === JSON.stringify(['proposal-a', 'proposal-b']) && report.validator_unchanged);
  assert.equal(report.goal_consumed_units, 3);
  assert.equal(report.goal_unit_ids.filter(id => id.startsWith('proposal:')).length, 1);
  assert.equal(report.root_normal_turns_between_workers, 0);
  assert(report.proposal_task_transport.short_reference && report.proposal_task_transport.native_reference_preserved &&
    report.proposal_task_transport.child_canonical_bound);
  assert(report.proposal_task_transport.short_bytes < report.proposal_task_transport.canonical_bytes);
  assert.equal(report.nested_worker_task_calls, 0);
  assert(report.models.some(item => item.agent === coordinatorAgent && item.model === 'gpt-5.6-sol' && item.variant === 'low'));
  assert(report.models.some(item => item.agent === operatorAgent && item.model === 'gpt-5.6-terra' && item.variant === 'high'));
  assert(report.models.some(item => item.agent === workerAgent && item.model === 'gpt-5.6-sol' && item.variant === 'medium'));
  if (report.task_calls !== 4 || report.tool_errors.length !== 0) {
    throw new Error(`proposal-call-count:${JSON.stringify({ task_calls: report.task_calls, tool_errors: report.tool_errors })}`);
  }
  console.log(JSON.stringify(report));
}

async function complexCliInside(tgz, directory) {
  const fixture = await installedFixture(tgz, directory, 'beta-v010');
  const { project, env, runtime, coordinatorAgent, operatorAgent, workerAgent, reduceGoalFlight } = fixture;
  const seeded = await seedComplex(project, env, runtime);
  const scenarioStarted = Date.now();
  let phase = 'open', sessionID = null, proposalSessionID = null, operatorSessionID = null, workerSessions = [];
  const receipt = join(fixture.run, 'operator-proposal-complex-rpt.json');
  async function cli(prompt, session) {
    return events(await command('timeout', ['--signal=TERM', '--kill-after=10s', '1800s', 'opencode', 'run', '--dir', project,
      '--format', 'json', '--print-logs', '--agent', coordinatorAgent, '--model', 'openai/gpt-5.6-sol', '--variant', 'low',
      ...(session ? ['--session', session] : []), prompt], project, env, 1_840_000));
  }
  try {
    const opened = await cli('匿名complex proposal RPTを開始する。toolを呼ばずCOMPLEX_PROPOSAL_RPT_READYだけ返す。');
    sessionID = opened.find(event => event.sessionID)?.sessionID; assert(sessionID, 'complex-root-session-missing');
    process.stderr.write(JSON.stringify({ phase: 'checkpoint', fixture: fixture.run, sessionID,
      package_version: fixture.pkg.version, runtime_marker: fixture.runtimeMarker, cli_version: fixture.cliVersion }) + '\n');

    phase = 'proposal';
    const requestPath = join(project, 'original-request.txt');
    const proposedEvents = await cli(`${requestPath} は完成済みintent/plan/proof mapではなく、authoritativeな元要求原文である。末尾改行なしの原文全体をReadし、goal、19要件、source pointersからtoolのcanonical schemaに従って自分でintent_jsonを生成する。source_refはuser:complex-proposal。19件のID・順序・本文・kindを一字も変えず、requirement/negative/qualityを正しく保持する。authoritative_refsはuser:complex-proposal、allow_readはoriginal-request.txt、service.json、rollout.json、receipt.json、verify.mjsの既存5 file。proposal_budgetは意図的に省略し、host defaultを使う。sortie_v010_begin_operator_proposalを一度呼び、返された${operatorAgent} Task short referenceへ追記せず完全一致で一度実行する。proposal childは許可sourceとhost canonical contractから3段階の実行契約とbehavioral proofを自分で組み立てる。rootから完成済みintent、plan、proof mapping、criteria、validation command assignmentを与えない。hostのstructured invalid-proposal時はproposal childがcanonical指示どおり同じgrant内で修正できるが、rootは別Taskやpaid retryを開始しない。proposal提出後、承認・source編集・prepare_operator・worker実行をせず停止する。`, sessionID);
    const proposalEntryErrors = proposedEvents.filter(event => event.type === 'tool_use' && event.part?.state?.status === 'error')
      .map(event => ({ tool: event.part.tool, code: String(event.part.state.error ?? '').split(/\r?\n/u)[0].slice(0, 160) }));
    assert.equal(proposalEntryErrors.length, 0, `complex-proposal-entry-errors:${JSON.stringify(proposalEntryErrors)}`);
    const proposalPath = join(project, runtime.stateDirectory, 'operator-proposals', `${hash(sessionID)}.json`);
    const submitted = JSON.parse(await readFile(proposalPath, 'utf8'));
    proposalSessionID = submitted.proposal_session_id;
    assert.equal(submitted.phase, 'submitted', `complex-proposal-phase:${submitted.phase}`);
    assert.deepEqual(submitted.intent, { schema_version: '0.1', original_request: { text: seeded.originalRequest, source_ref: 'user:complex-proposal' },
      requirements: COMPLEX_REQUIREMENTS, authoritative_refs: ['user:complex-proposal'], allow_read: COMPLEX_FILES,
      proposal_budget: { max_reads: 45, max_submissions: 9 } }, 'model intent or host default materialization mismatch');
    const intentInput = beginIntentShape(sessionID);
    assert(intentInput?.proposal_budget_omitted && intentInput.requirements === 19, 'root must omit proposal budget and generate 19 requirements');
    assert.deepEqual(intentInput.kinds, { requirement: 13, negative: 3, quality: 3 });
    const proposalInput = proposalInputShape(proposalSessionID);
    assert.equal(proposalInput?.acceptance_present, false, 'complex proposal input must omit plan.acceptance');
    const proof = verifyComplexProposal(submitted.proposal);
    assert.equal(submitted.proposal_hash, hash(JSON.stringify(submitted.proposal)), 'complex durable proposal hash mismatch');
    assert(submitted.read_count > 0 && submitted.read_count <= 45 && submitted.submission_count >= 1 && submitted.submission_count <= 9);
    assert.equal(hash(await readFile(join(project, 'verify.mjs'))), seeded.validatorHash, 'validator changed before approval');
    for (const name of ['service.json', 'rollout.json', 'receipt.json']) assert.equal((await readFile(join(project, name), 'utf8')).trim(), '{"state":"pending"}');

    phase = 'execution';
    const executedEvents = await cli(`同じraw requestと提出proposalをsortie_v010_operator_statusで確認する。host materialized acceptanceがordered 19件、kind別coverageとnegative handling、uncovered=[]、順序依存3 unit、各unitのdistinct write、保護verify.mjsから導かれた段階的behavioral proof、goal_budget_units=4であることを照合する。rootは19/3という期待数だけを既知とし、criteria名やcommand割当を捏造・置換しない。approval_json exact keysはproposal_id, revision, content_hash, compared_requirement_ids, decision, rationale。compared_requirement_idsはraw requestの19 IDを同順に使い、durable identityと具体的rationaleでsortie_v010_approve_operator_proposalを一度呼ぶ。返された既存execution Taskを完全一致で一度実行する。rootはsourceを編集せずworker間に通常運行turnを挟まない。operatorは各unit直前にoperator_nextを一度呼び、返された新しいTaskだけを一度実行して結果を待つ。workerはmanifestどおり担当JSONだけを変更し、保護validatorを変更せず、commitやnested Taskを行わない。3 unit成功後run_id/acceptance_fingerprintでsortie_v010_complete_operatorを呼び、receipt.status=succeededで終了する。失敗時は別paid runを開始せず停止する。`, sessionID);
    const approved = JSON.parse(await readFile(proposalPath, 'utf8'));
    const operatorPath = join(project, runtime.stateDirectory, 'operators', `${hash(sessionID)}.json`);
    const operator = JSON.parse(await readFile(operatorPath, 'utf8'));
    operatorSessionID = operator.operatorSessionID;
    workerSessions = operator.units.map(unit => unit.childSessionID);
    assert.equal(approved.phase, 'approved');
    assert.equal(operator.units.length, 3);
    assert.equal(new Set(workerSessions).size, 3, 'workers must have three distinct sessions');
    assert(workerSessions.every(Boolean), 'all three workers must exist');
    const ledgerPath = join(project, '.git/sortie-dogs', runtime.flightDirectory, `${hash(`${runtime.id}\u0000${sessionID}`)}.json`);
    const goal = reduceGoalFlight(JSON.parse(await readFile(ledgerPath, 'utf8')).goal_events);
    await command('node', ['verify.mjs', 'final'], project, env);
    assert.equal(hash(await readFile(join(project, 'verify.mjs'))), seeded.validatorHash, 'protected validator changed');
    const descendants = descendantSessions(sessionID);
    const allErrors = toolErrors(descendants);
    const timing = executionTiming(sessionID, workerSessions);
    const transport = proposalTransport(sessionID, proposalSessionID);
    const workerTransport = workerTransports(operatorSessionID, workerSessions);
    const cleanup = await processCleanup(project);
    const resultValues = {};
    for (const name of ['service.json', 'rollout.json', 'receipt.json']) resultValues[name] = JSON.parse(await readFile(join(project, name), 'utf8'));
    const report = {
      schema: 1, artifact: 'operator-proposal-complex-cli', status: 'PASS', receipt: relative(root, receipt).replaceAll('\\', '/'),
      repro_command: 'node scripts/operator-proposal-rpt.mjs --cli-complex', package_version: fixture.pkg.version,
      runtime_marker: fixture.runtimeMarker, cli_version: fixture.cliVersion, elapsed_ms: Date.now() - scenarioStarted,
      root_session: sessionID, root_agent: coordinatorAgent, proposal_agent: operatorAgent, worker_agent: workerAgent,
      intent_entry: 'model-generated-from-raw-request', intent_requirements: submitted.intent.requirements.length,
      intent_kind_counts: intentInput.kinds, intent_input_hash: intentInput.input_hash, proposal_budget_input_omitted: intentInput.proposal_budget_omitted,
      materialized_proposal_budget: submitted.intent.proposal_budget, proposal_reads: approved.read_count, proposal_submissions: approved.submission_count,
      proposal_id: approved.proposal_id, proposal_revision: approved.proposal_revision, proposal_hash: approved.proposal_hash,
      proposal_input_acceptance_omitted: proposalInput.acceptance_present === false, proposal_input_hash: proposalInput.input_hash,
      host_materialized_acceptance_count: approved.proposal.plan.acceptance.length, host_materialized_acceptance_exact: true,
      host_canonical_hash_verified: approved.proposal_hash === hash(JSON.stringify(approved.proposal)), proposal_task_transport: transport,
      delegate_task_transport: delegateTransport(sessionID, operatorSessionID),
      worker_task_transport: workerTransport,
      proof, uncovered: approved.proposal.uncovered, operator_run_id: operator.runID, operator_phase: operator.phase,
      unit_ids: operator.units.map(unit => unit.unit.id), worker_statuses: operator.units.map(unit => unit.status), worker_sessions: workerSessions,
      worker_results: resultValues, terminal: goal.receipt?.status ?? goal.phase, acceptance_fingerprint: goal.receipt?.acceptance_fingerprint ?? null,
      goal_consumed_units: goal.consumed_units, goal_unit_ids: goal.unit_ids, canonical_validation: { command: COMPLEX_COMMANDS[2], exit: 0 },
      validator_unchanged: true, root_turns_between_worker_pairs: timing.root_turns_between_worker_pairs,
      root_normal_turns_between_workers: timing.root_normal_turns_between_workers,
      task_calls: taskCalls([sessionID, proposalSessionID, operatorSessionID]), nested_worker_task_calls: taskCalls(workerSessions),
      descendant_sessions: descendants.length, native_stages: nativeStages([['root', sessionID], ['proposal', proposalSessionID],
        ['operator', operatorSessionID], ...workerSessions.map((id, index) => [`worker-${index + 1}`, id])]),
      models: models(descendants), tool_errors: allErrors, process_cleanup: cleanup,
      paid_retry_count: 0, benchmark_complete: false,
    };
    assert.equal(report.runtime_marker, COMPLEX_MARKER);
    assert(report.proposal_task_transport.short_reference && report.proposal_task_transport.native_reference_preserved &&
      report.proposal_task_transport.child_canonical_bound);
    assert(report.proposal_task_transport.short_bytes < report.proposal_task_transport.canonical_bytes);
    assert(report.delegate_task_transport.native_parent === sessionID && report.delegate_task_transport.reference_serialized &&
      report.delegate_task_transport.native_reference_preserved && report.delegate_task_transport.child_canonical_bound);
    assert.equal(report.worker_task_transport.length, 3);
    assert(report.worker_task_transport.every(item => item.native_parent === operatorSessionID && item.reference_serialized &&
      item.native_reference_preserved && item.child_canonical_bound));
    assert.equal(report.operator_phase, 'completed'); assert.deepEqual(report.worker_statuses, ['succeeded', 'succeeded', 'succeeded']);
    assert.equal(report.terminal, 'succeeded'); assert.equal(report.goal_consumed_units, 4);
    assert.equal(report.goal_unit_ids.filter(id => id.startsWith('proposal:')).length, 1);
    assert.equal(report.root_normal_turns_between_workers, 0); assert.equal(report.nested_worker_task_calls, 0);
    assert.equal(report.task_calls, 5); assert.equal(report.descendant_sessions, 6); assert.equal(report.tool_errors.length, 0);
    assert.equal(report.process_cleanup.remaining, 0);
    assert(report.models.some(item => item.agent === coordinatorAgent && item.model === 'gpt-5.6-sol' && item.variant === 'low'));
    assert(report.models.some(item => item.agent === operatorAgent && item.model === 'gpt-5.6-terra' && item.variant === 'high'));
    assert(report.models.filter(item => item.agent === workerAgent && item.model === 'gpt-5.6-sol' && item.variant === 'medium').length >= 3);
    await writeFile(receipt, JSON.stringify(report, null, 2) + '\n');
    process.stderr.write(JSON.stringify({ phase: 'outcome', status: 'PASS', receipt: report.receipt, elapsed_ms: report.elapsed_ms,
      requirements: 19, units: 3, tool_errors: 0, consumed_units: 4 }) + '\n');
    console.log(JSON.stringify(report));
  } catch (error) {
    const descendants = sessionID ? descendantSessions(sessionID) : [];
    const cleanup = await processCleanup(project).catch(() => ({ checked: false, remaining: null, polls: 0 }));
    const failure = { schema: 1, artifact: 'operator-proposal-complex-cli', status: 'FAIL', receipt: relative(root, receipt).replaceAll('\\', '/'),
      repro_command: 'node scripts/operator-proposal-rpt.mjs --cli-complex', phase, package_version: fixture.pkg.version,
      runtime_marker: fixture.runtimeMarker, elapsed_ms: Date.now() - scenarioStarted, code: String(error?.code ?? error?.name ?? 'Error').slice(0, 80),
      error: String(error?.message ?? error).split(/\r?\n/u)[0].slice(0, 320), paid_retry_count: 0,
      sessions: { root: sessionID, proposal: proposalSessionID, operator: operatorSessionID, workers: workerSessions },
      native_stages: sessionID ? nativeStages([['root', sessionID], ['proposal', proposalSessionID], ['operator', operatorSessionID],
        ...workerSessions.map((id, index) => [`worker-${index + 1}`, id])]) : [], tool_errors: toolErrors(descendants).slice(0, 24),
      process_cleanup: cleanup, benchmark_complete: false };
    await writeFile(receipt, JSON.stringify(failure, null, 2) + '\n');
    process.stderr.write(JSON.stringify({ phase: 'outcome', status: 'FAIL', receipt: failure.receipt, failure_phase: phase,
      code: failure.code, error: failure.error, paid_retry_count: 0 }) + '\n');
    throw error;
  }
}

async function cli(mode = 'smoke') {
  await mkdir(artifacts, { recursive: true }); const directory = await mkdtemp(join(artifacts, 'operator-proposal-rpt-'));
  const packed = JSON.parse(await command(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', directory], root, {}, 1_200_000));
  const tgz = join(directory, packed[0].filename), receipts = join(directory, 'receipts');
  const inside = mode === 'complex' ? complexCliInside : mode === 'prepare-complex' ? prepareComplexInside : cliInside;
  if (process.platform !== 'win32') return inside(tgz, receipts);
  const linux = async value => (await command('wsl.exe', ['-e', 'wslpath', '-a', value], root)).trim();
  const [script, linuxTgz, linuxReceipts] = await Promise.all([import.meta.filename, tgz, receipts].map(linux));
  let output;
  const insideFlag = mode === 'complex' ? '--cli-complex-inside' : mode === 'prepare-complex' ? '--prepare-complex-inside' : '--cli-inside';
  const timeoutSeconds = mode === 'complex' ? 7200 : 3600;
  try { output = await command('wsl.exe', ['-e', 'bash', '-ic', `timeout --signal=TERM --kill-after=10s ${timeoutSeconds}s node ${[script, insideFlag, linuxTgz, linuxReceipts].map(shellQuote).join(' ')}`], root, {}, (timeoutSeconds + 60) * 1_000); }
  catch (error) {
    const result = error?.processResult;
    const bounded = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`.split(/\r?\n/u)
      .filter(line => /(?:failed|missing|invalid|denied|expected|actual|Assertion|operator-proposal|tool|Error)/iu.test(line)).slice(-40);
    console.error(JSON.stringify({ phase: 'cli-failure', exit: result?.code ?? null, bounded })); throw error;
  }
  console.log(JSON.stringify(JSON.parse(output.trim())));
}
async function main() {
  if (process.argv[2] === '--targeted') return targeted();
  if (process.argv[2] === '--cli') return cli();
  if (process.argv[2] === '--cli-complex') return cli('complex');
  if (process.argv[2] === '--prepare-complex') return cli('prepare-complex');
  if (process.argv[2] === '--cli-inside') return cliInside(resolve(process.argv[3]), resolve(process.argv[4]));
  if (process.argv[2] === '--cli-complex-inside') return complexCliInside(resolve(process.argv[3]), resolve(process.argv[4]));
  if (process.argv[2] === '--prepare-complex-inside') return prepareComplexInside(resolve(process.argv[3]), resolve(process.argv[4]));
  throw Error('Expected --targeted, --cli, --prepare-complex, or --cli-complex');
}
main().catch(error => { console.error(error instanceof Error ? String(error.stack ?? error.message).split(/\r?\n/u).slice(0, 12).join('\n') : 'operator-proposal-rpt-failed'); process.exitCode = 1; });
