import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { installedFixture, startV2ReleaseServer, spawnPromptCLI, stopProcessGroup, missionDatabasePath } from './release-cli.mjs';
import { observeMissionCLI } from './mission-cli-probe.mjs';
import { verifyCurrentPackage } from './run-v010-qualification.mjs';
import { nativeRunPending, waitForNativeSettlement } from './native-run-settlement.mjs';

// One retained environment and candidate. Explicit phases never replay a consumed turn.
const root = process.cwd();
const base = path.resolve(process.env.SORTIE_STABILITY_OUTPUT ?? '_testenv/v0150-stability');
const phase = process.argv[2];
const sha = b => createHash('sha256').update(b).digest('hex');
const json = async p => JSON.parse(await fs.readFile(p, 'utf8'));
const save = async (p, v) => fs.writeFile(p, JSON.stringify(v, null, 2) + '\n');
await fs.mkdir(base, {recursive:true});
async function command(label, exe, args, cwd=root, env={}) {
  const started=Date.now();
  const child=spawn(exe,args,{cwd,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.on('data',b=>{stdout+=b;});child.stderr.on('data',b=>{stderr+=b;});
  const timer=setTimeout(()=>child.kill('SIGTERM'),600000);
  const exit=await new Promise((ok,no)=>{child.on('close',ok);child.on('error',no)}).finally(()=>clearTimeout(timer));
  await save(path.join(base,label+'.json'),{exe,args,cwd,exit,elapsed_ms:Date.now()-started,stdout,stderr});
  assert.equal(exit,0,stderr);return stdout;
}
const envFile=path.join(base,'environment.json');
if(phase==='review-setup') {
  await assert.rejects(fs.stat(envFile),{code:'ENOENT'});
  const candidate=await json(path.join(base,'candidate.json'));
  assert.equal(sha(await fs.readFile(candidate.tgz)),candidate.sha256);
  const fixture=await installedFixture(candidate.tgz,path.join(base,'review'),'v014',{nested:false});
  const {project,env,installed,credentialSource}=fixture;
  const retained=await json(path.join(root,'_testenv/v0150-qualification/environment.json'));
  const settings=await json(path.join(retained.config,'opencode.json'));
  settings.plugins=[path.join(project,'.opencode/plugins/sortie-dogs')];
  await save(path.join(project,'.opencode/opencode.json'),settings);
  const bin=path.join(fixture.run,'bin');await fs.mkdir(bin);
  await fs.symlink('missing-python',path.join(bin,'python'));
  await fs.writeFile(path.join(project,'proof.txt'),'retained\n');
  await fs.writeFile(path.join(project,'check.mjs'),'import assert from "node:assert/strict";import fs from "node:fs";assert.equal(fs.readFileSync("proof.txt","utf8"),"retained\\n");console.log("RETAINED_PROOF_PASS");\n');
  await command('review-git-init','git',['init'],project);
  await command('review-git-add','git',['add','proof.txt','check.mjs'],project);
  await command('review-git-commit','git',['-c','user.name=Qualification','-c','user.email=qualification@example.invalid','commit','-m','test: retained required proof'],project);
  const prompt=`日本語。これは隔離された実運用回帰。SOL openai/gpt-6.1-solだけをCoordinator/Reviewerに明示指定。共有hostへ触らない。既存proof.txtの検証だけ、再実装・新成果作成なし。元要求は「proof.txtがretained\\nであることを一度検証し、外部binの切れリンクを変更せず、履歴scopeを保持してReview/独立Review/Acceptance/receiptまで完了」。通常start_mission→Coordinatorで進める。Coordinatorはまずexecutor=workerでpending unitをplan_unitsする（dispatchしない）。この最初のunitのreadはcheck.mjs, proof.txt, ${bin}/**、writeは${bin}/**、validationはnode check.mjs。次に同じ要求をnarrow read-only proof unitへplan_units(executor=self)で正式replan（read=check.mjs,proof.txt、write=[]、validation=node check.mjs）。これは広い履歴scopeを保持したままの正規復帰。narrow unitでnode check.mjsを一回だけ実行、finish_direct_unit、その後review_mission(risk_tags=[public-logic])を呼ぶ。review_missionを飛ばしたりscope削除したりledger編集しない。独立ReviewerをSOLで派遣しPASS後submit_mission、rootがcomplete_missionでreceiptを取得し正式帰還報告を一度だけ表示。元要求と実リンクとproofと検証履歴を保持。上限はこの回帰で実行unit1つ、再実行なし。費用はunknownを報告。最初と最後にoperator_statusでruntime実ロードとbudgetを観測。`;
  await fs.writeFile(path.join(base,'review-prompt.txt'),prompt+'\n');
  await save(envFile,{root,base,project,installed,env,credentialSource,bin,proof_sha256:sha(await fs.readFile(path.join(project,'proof.txt'))),candidate_sha256:candidate.sha256});
  console.log(envFile);
} else if(phase==='review-summary') {
  const setup=await json(envFile),candidate=await json(path.join(base,'candidate.json'));
  const native=await json(path.join(base,'native-messages.json')),turn=await json(path.join(base,'review.json'));
  const captures=Object.values(native.captures).flat();
  const parts=captures.flatMap(m=>m.content??[]);
  const packets=name=>parts.filter(p=>p.type==='tool'&&p.name===name&&p.state?.status==='completed').map(p=>JSON.parse(p.state.content[0].text));
  const statuses=packets('sortie_v010_operator_status'),completed=packets('sortie_v010_complete_mission');
  const key=sha(turn.session),state=path.join(setup.project,'.sortie-dogs-v010');
  const mission=await json(path.join(state,'missions',key+'.json')),operator=await json(path.join(state,'operators',key+'.json'));
  const models=[...new Set(captures.filter(m=>m.type==='assistant'&&m.model).map(m=>`${m.model.providerID}/${m.model.id}`))];
  const errors=parts.filter(p=>p.type==='tool'&&p.state?.status==='error').map(p=>({tool:p.name,error:p.state.error}));
  const checks={candidate_loaded:statuses.some(s=>s.runtime?.runtime_asset_version===candidate.runtimeMarker)&&sha(await fs.readFile(candidate.tgz))===candidate.sha256,
    public_review:packets('sortie_v010_review_mission').some(p=>p.status==='review-required'),
    history_scope_retained:mission.reviewScope?.write?.includes(setup.bin+'/**'),
    proof_preserved:sha(await fs.readFile(path.join(setup.project,'proof.txt')))===setup.proof_sha256,
    link_preserved:await fs.readlink(path.join(setup.bin,'python'))==='missing-python',
    independent_review:mission.review?.verdict==='PASS'&&mission.review.child!==turn.session,
    receipt:operator.receipt?.status==='succeeded'&&completed.length===1,
    no_duplicate_execution:operator.units.length===1&&operator.units[0].evidence.length===1&&mission.attempts.filter(a=>a.kind==='direct_execution').length===1,
    sol_only:models.length===1&&models[0]==='openai/gpt-6.1-sol',native_settled:!native.pending};
  const summary={checks,models,errors,cost_usd:null,elapsed_ms:turn.elapsed_ms,candidate,receipt:operator.receipt,mission_id:mission.id,root_session:turn.session,
    limitations:['Isolated new Mission public-path reproduction, not continuation or acceptance of the original shared-host Mission.','Known old-version ENOENT oracle retained in handoff; not replayed.','Actual total cost remains unknown; no budget reset.']};
  await save(path.join(base,'review-summary.json'),summary);console.log(JSON.stringify(summary,null,2));
  assert.ok(Object.values(checks).every(Boolean),'review recovery checks failed');
} else if(phase==='setup') {
  await assert.rejects(fs.stat(envFile),{code:'ENOENT'});
  const stable=JSON.parse(await command('stable-pack','npm',['pack','sortie-dogs@0.14.9','--json','--pack-destination',base]));
  const stableTgz=path.join(base,stable[0].filename);
  const fixture=await installedFixture(stableTgz,path.join(base,'migration'),'v014',{nested:false});
  const {project,env,installed,credentialSource}=fixture;
  const retained=await json(path.join(root,'_testenv/v0150-qualification/environment.json'));
  const settings=await json(path.join(retained.config,'opencode.json'));
  settings.plugins=[path.join(project,'.opencode/plugins/sortie-dogs')];
  await save(path.join(project,'.opencode/opencode.json'),settings);
  await save(path.join(project,'.opencode/sortie-dogs.json'),{reflection:{enabled:true,layers:{run:true,project:true,global:false},maxInjectedEntries:2,maxInjectedTokens:400}});
  await fs.writeFile(path.join(project,'input.json'),JSON.stringify([{sku:'A',quantity:2,price:125},{sku:'B',quantity:3,price:80},{sku:'A',quantity:1,price:125}])+'\n');
  await fs.writeFile(path.join(project,'check-stage1.mjs'),`import assert from 'node:assert/strict';import fs from 'node:fs';assert.ok(fs.readFileSync('tools/inventory.mjs','utf8').length>20);console.log('STAGE1_PASS');\n`);
  await fs.writeFile(path.join(project,'check.mjs'),`import assert from 'node:assert/strict';import fs from 'node:fs';import {execFileSync} from 'node:child_process';const r=JSON.parse(execFileSync(process.execPath,['tools/inventory.mjs','input.json'],{encoding:'utf8'}));assert.deepEqual(r,{items:[{sku:'A',quantity:3,total:375},{sku:'B',quantity:3,total:240}],total:615});assert.deepEqual(JSON.parse(fs.readFileSync('result.json','utf8')),r);console.log('INVENTORY_PASS');\n`);
  await save(envFile,{root,base,project,installed,env,credentialSource,stable_tgz:stableTgz,stable_sha256:sha(await fs.readFile(stableTgz))});
  console.log(envFile);
} else if(phase==='reflection-migration') {
  const retained=await json(envFile),candidate=await json(path.join(base,'candidate.json'));
  const output=path.join(base,'reflection-migration');
  await assert.rejects(fs.stat(output),{code:'ENOENT'});
  assert.equal(sha(await fs.readFile(retained.stable_tgz)),retained.stable_sha256);
  assert.equal(sha(await fs.readFile(candidate.tgz)),candidate.sha256);
  const fixture=await installedFixture(retained.stable_tgz,output,'v014',{nested:false});
  const {project,installed,env}=fixture;
  // Opt-in and reminder are established on stable only, never supplied by upgrade.
  await save(path.join(project,'.opencode/sortie-dogs.json'),{reflection:{enabled:true,layers:{run:false,project:true,global:false},maxInjectedEntries:2,maxInjectedTokens:400}});
  await command('reflection-git-init','git',['init'],project);
  const probe=path.join(root,'scripts/reflection-migration-probe.mjs');
  const before=JSON.parse(await command('reflection-stable','node',[probe,installed,project,'seed'],project,env));
  const files={};
  async function snapshot(dir) {
    for(const e of await fs.readdir(dir,{withFileTypes:true})) {
      const p=path.join(dir,e.name);if(e.isDirectory())await snapshot(p);else if(e.isFile())files[p]=sha(await fs.readFile(p));
    }
  }
  await snapshot(path.join(env.XDG_CONFIG_HOME,'opencode/sortie-dogs-v010/reflection'));
  for(const name of ['sortie-dogs.json','opencode.json']) {const p=path.join(project,'.opencode',name);files[p]=sha(await fs.readFile(p));}
  await save(path.join(output,'before.json'),{before,files});
  await command('reflection-install','npm',['install','--force','--save-exact',candidate.tgz],path.join(project,'.opencode'),env);
  await command('reflection-init','node',[path.join(installed,'dist/cli/main.js'),'init',project,'--profile','v010'],project,env);
  const after=JSON.parse(await command('reflection-candidate','node',[probe,installed,project,'read'],project,env));
  assert.deepEqual(after.bucket,before.bucket);
  assert.deepEqual(after.injected,before.injected);
  for(const [p,h] of Object.entries(files))assert.equal(sha(await fs.readFile(p)),h,p);
  const result={reflection_migration:true,stable_sha256:retained.stable_sha256,candidate_sha256:candidate.sha256,
    project,files,before,after,model_calls:0,limitations:['Native plugin API and caller-visible system transform; no model inference or GUI rendering.']};
  await save(path.join(output,'result.json'),result);console.log(JSON.stringify(result));
} else if(phase==='init-project') {
  const {project}=await json(envFile);
  await command('fixture-init','git',['init'],project);
  await command('fixture-git','git',['add','input.json','check.mjs','check-stage1.mjs'],project);
  await command('fixture-commit','git',['-c','user.name=Qualification','-c','user.email=qualification@example.invalid','commit','-m','test: fixed inventory oracle'],project);
} else if(phase==='freeze') {
  await assert.rejects(fs.stat(path.join(base,'candidate.json')),{code:'ENOENT'});
  await command('build','npm',['run','build']);
  const commit=(await command('candidate-commit','git',['rev-parse','HEAD'])).trim();
  const packed=JSON.parse(await command('candidate-pack','npm',['pack','--ignore-scripts','--json','--pack-destination',base]));
  const tgz=path.join(base,packed[0].filename);
  const artifact=await verifyCurrentPackage(tgz);
  await save(path.join(base,'candidate.json'),{commit,tgz,...artifact});console.log(artifact);
} else if(phase==='upgrade') {
  const setup=await json(envFile),candidate=await json(path.join(base,'candidate.json'));
  const files={};
  async function snapshot(dir) {
    for(const e of await fs.readdir(dir,{withFileTypes:true})) {
      const p=path.join(dir,e.name);if(e.isDirectory())await snapshot(p);else if(e.isFile())files[path.relative(setup.project,p)]=sha(await fs.readFile(p));
    }
  }
  await snapshot(path.join(setup.project,'.sortie-dogs-v010'));
  for(const name of ['.opencode/sortie-dogs.json','.opencode/opencode.json','tools/inventory.mjs'])files[name]=sha(await fs.readFile(path.join(setup.project,name)));
  await save(path.join(base,'pre-upgrade.json'),files);
  assert.equal(sha(await fs.readFile(candidate.tgz)),candidate.sha256);
  await command('candidate-install','npm',['install','--force','--save-exact',candidate.tgz],path.join(setup.project,'.opencode'),setup.env);
  await command('candidate-init','node',[path.join(setup.installed,'dist/cli/main.js'),'init',setup.project,'--profile','v010'],setup.project,setup.env);
  const changed=[];for(const [name,hash] of Object.entries(files))if(sha(await fs.readFile(path.join(setup.project,name)))!==hash)changed.push(name);
  await save(path.join(base,'migration.json'),{state_preserved:changed.length===0,changed,stable_sha256:setup.stable_sha256,candidate_sha256:candidate.sha256,files});
  assert.deepEqual(changed,[]);
  console.log('Migration preserved',Object.keys(files).length,'files');
} else if(phase==='checkpoint') {
  const setup=await json(envFile),session=process.argv[3],key=sha(session);
  const state=path.join(setup.project,'.sortie-dogs-v010');
  const memory=await command('memory-status','node',[path.join(setup.installed,'dist/cli/main.js'),'memory','status',setup.project],setup.project,setup.env);
  await save(path.join(base,'interrupted-state.json'),{mission:await json(path.join(state,'missions',key+'.json')),operator:await json(path.join(state,'operators',key+'.json')),result_sha256:sha(await fs.readFile(path.join(setup.project,'result.json'))),memory_status:memory});
} else if(phase==='turn') {
  const setup=await json(envFile),[label,session,promptFile,interrupt]=process.argv.slice(3);
  assert.match(label,/^[a-z0-9-]+$/);
  await assert.rejects(fs.stat(path.join(base,label+'.json')),{code:'ENOENT'});
  const prompt=await fs.readFile(promptFile,'utf8');
  const server=await startV2ReleaseServer(setup.project,setup.env,{credentialSource:setup.credentialSource});
  const started=Date.now();let stdout='',stderr='',reason=null,child;
  try {
    child=spawnPromptCLI('/home/user/.opencode/bin/opencode',['run','--server',server.url,'--format','json','--auto','--agent','dog-operator','--model','openai/gpt-6.1-sol',...(session==='-'?[]:['--session',session])],prompt,{cwd:setup.project,env:{...process.env,...server.env},detached:true});
    let stopping;
    const stop=why=>{if(stopping)return;reason=why;stopping=Promise.all([stopProcessGroup(child),server.stop()]);};
    child.stdout.on('data',b=>{stdout+=b;process.stdout.write(b);if(interrupt==='interrupt'&&stdout.includes('STABILITY_INTERRUPT_READY'))stop('injected-owned-server-interruption');});
    child.stderr.on('data',b=>{stderr+=b;process.stderr.write(b);});
    const timer=setTimeout(()=>stop('timeout'),Number(process.env.SORTIE_STABILITY_TIMEOUT_MS??600000));
    const exit=await new Promise((ok,no)=>{child.on('close',ok);child.on('error',no)});
    if(stopping)await stopping;
    const ids=[...stdout.matchAll(/"sessionID":"([^"]+)"/g)].map(x=>x[1]);
    const id=session==='-'?ids[0]:session;
    if(interrupt==='settle'&&exit===0)await waitForNativeSettlement({pending:()=>nativeRunPending(setup.project,missionDatabasePath(server.env,setup.project),{root:id}),stopped:()=>reason!==null});
    clearTimeout(timer);
    const observation=id?observeMissionCLI(setup.project,0,'dog-operator',missionDatabasePath(server.env,setup.project),{root:id}):null;
    await save(path.join(base,label+'.json'),{session:id,prompt_file:promptFile,exit,elapsed_ms:Date.now()-started,reason,stdout,stderr,observation,cost_usd:null});
    console.log(JSON.stringify({session:id,exit,reason,elapsed_ms:Date.now()-started}));
  } catch(error) {
    await save(path.join(base,label+'.failure.json'),{elapsed_ms:Date.now()-started,stdout,stderr,error:{name:error.name,message:error.message},cost_usd:null});
    throw error;
  } finally { await server.stop(); }
} else if(phase==='collect') {
  const setup=await json(envFile),session=process.argv[3];
  const database=missionDatabasePath(setup.env,setup.project);
  const db=new DatabaseSync(database,{readOnly:true});
  try {
    const sessions=db.prepare('SELECT id,parent_id,agent,time_idle,idle_outcome FROM session_v2').all();
    const captures={};
    for(const s of sessions) {
      captures[s.id]=db.prepare('SELECT id,type,data FROM session_message WHERE session_id = ? ORDER BY seq').all(s.id).map(row=>({...JSON.parse(row.data),id:row.id,type:row.type}));
      for(const m of captures[s.id]){delete m.native;m.content=m.content?.filter(p=>p.type!=='reasoning');}
    }
    await save(path.join(base,'native-messages.json'),{sessions,captures,pending:nativeRunPending(setup.project,database,{root:session})});
    console.log(sessions);
  } finally {db.close();}
} else if(phase==='summary') {
  const setup=await json(envFile),candidate=await json(path.join(base,'candidate.json'));
  const native=await json(path.join(base,'native-messages.json'));
  const baseline=await json(path.join(base,'baseline.json'));
  const interrupted=await json(path.join(base,'interruption.json'));
  const checkpoint=await json(path.join(base,'interrupted-state.json'));
  const migration=await json(path.join(base,'migration.json'));
  const finalMemory=JSON.parse(await command('memory-status-final','node',[path.join(setup.installed,'dist/cli/main.js'),'memory','status',setup.project],setup.project,setup.env));
  const messages=native.captures[baseline.session];
  const parts=messages.flatMap(m=>m.content??[]);
  const packets=name=>parts.filter(p=>p.type==='tool'&&p.name===name&&p.state?.status==='completed').map(p=>JSON.parse(p.state.content[0].text));
  const statuses=packets('sortie_v010_operator_status');
  const completion=packets('sortie_v010_complete_mission');
  const finals=messages.filter(m=>m.type==='assistant'&&m.finish==='stop');
  const finalText=finals.map(m=>(m.content??[]).filter(p=>p.type==='text').map(p=>p.text).join('\n')).join('\n');
  const key=sha(baseline.session),state=path.join(setup.project,'.sortie-dogs-v010');
  const mission=await json(path.join(state,'missions',key+'.json'));
  const operator=await json(path.join(state,'operators',key+'.json'));
  const firstStatus=statuses[0],resumeStatus=statuses.find(s=>s.run_id===checkpoint.operator.runID);
  const models=[...new Set(Object.values(native.captures).flat().filter(m=>m.type==='assistant'&&m.model).map(m=>`${m.model.providerID}/${m.model.id}`))];
  const latest=statuses.at(-1);
  const panel=completion[0]?.return_report;
  const historicalEvidence=firstStatus?.acceptance_summary?.formal_validation??[];
  const preservedEvidence=resumeStatus?.acceptance_summary?.formal_validation??[];
  const tools=parts.filter(p=>p.type==='tool');
  const errors=Object.entries(native.captures).flatMap(([session,ms])=>ms.flatMap(m=>(m.content??[]).filter(p=>p.type==='tool'&&p.state?.status==='error').map(p=>({session,tool:p.name,error:p.state.error}))));
  const loaded=statuses.filter(s=>s.runtime?.runtime_asset_version===candidate.runtimeMarker);
  const installedMatch=(await Promise.all(Object.entries(candidate.criticalDistSha256).map(async([p,h])=>sha(await fs.readFile(path.join(setup.installed,p)))===h))).every(Boolean);
  const checks={
    migration:migration.state_preserved&&baseline.exit===0&&setup.stable_sha256===sha(await fs.readFile(setup.stable_tgz)),
    state_preserved:migration.state_preserved&&mission.id===checkpoint.mission.id&&operator.runID===checkpoint.operator.runID&&sha(await fs.readFile(path.join(setup.project,'result.json')))===checkpoint.result_sha256&&JSON.stringify(mission.requirements)===JSON.stringify(checkpoint.mission.requirements)&&latest.budget.consumed_units===2&&latest.budget.max_units===firstStatus.budget.max_units,
    memory_off:JSON.parse(checkpoint.memory_status).enabled===false&&finalMemory.enabled===false&&!tools.some(p=>/memory.*(?:on|configure)/.test(p.name)),
    recovery_completed:interrupted.exit===130&&interrupted.reason==='injected-owned-server-interruption'&&mission.phase==='completed'&&!native.pending&&mission.attempts.length===2&&mission.attempts.every(a=>a.kind==='direct_execution'&&a.status==='succeeded'),
    validation_preserved:historicalEvidence.length>0&&historicalEvidence.every(e=>preservedEvidence.some(p=>p.evidence_id===e.evidence_id))&&operator.receipt?.evidence_refs.includes(historicalEvidence[0].evidence_id)&&operator.units.every(u=>u.evidence.some(e=>e.execution.exit_code===0)),
    acceptance_completed:completion.length===1&&operator.receipt?.status==='succeeded'&&mission.review?.verdict==='PASS'&&mission.review.child!==baseline.session,
    return_once:Boolean(panel)&&finalText.split(panel).length-1===1,
    candidate_loaded:loaded.length>=2&&loaded.every(s=>s.runtime.implementation_sha256['profiled.js']===candidate.criticalDistSha256['dist/plugin/profiled.js'])&&installedMatch&&sha(await fs.readFile(candidate.tgz))===candidate.sha256,
  };
  await fs.writeFile(path.join(base,'final-message.md'),finalText);
  const summary={checks,observed_model:models.length===1?models[0]:null,models,candidate_commit:candidate.commit,candidate_sha256:candidate.sha256,candidate_tgz:candidate.tgz,stable_sha256:setup.stable_sha256,runner:'scripts/stability-qualification.mjs',runner_sha256:sha(await fs.readFile(new URL(import.meta.url))),runner_base_commit:candidate.commit,root_session:baseline.session,reviewer_session:mission.review.child,receipt:operator.receipt,budget_before:firstStatus.budget,budget_after:latest.budget,cost_usd:null,cost_note:'Campaign actual cost unknown. Receipt estimates are partial, not actual total or a fresh allowance.',errors,
    evidence_refs:['migration.json','pre-upgrade.json','interrupted-state.json','baseline.json','interruption.json','resume.json','native-messages.json','memory-status.json','final-message.md','candidate.json'].map(p=>path.join(base,p)),
    reused_evidence:['afc7839 A–C targeted evidence and independent Review PASS in authoritative handoff','_testenv/v0150-qualification/qualification-summary.json: prior candidate Memory/Advisor/return evidence, not new candidate freshness'],
    attempts:[{phase:'setup',exit:1,elapsed_ms:null,cause:'Fixture installed successfully; git add resolved parent repository ignored _testenv. Continued same setup by initializing only owned project git, no install replay.'},{phase:'baseline',exit:baseline.exit,elapsed_ms:baseline.elapsed_ms},{phase:'interruption',exit:interrupted.exit,elapsed_ms:interrupted.elapsed_ms,reason:interrupted.reason},{phase:'resume',...Object.fromEntries(Object.entries(await json(path.join(base,'resume.json'))).filter(([k])=>['exit','elapsed_ms','reason'].includes(k))),note:'Controller stopped owned server at parent exit while background Reviewer still active; continued same Reviewer after controller settlement fix.'},{phase:'settle',exit:1,elapsed_ms:null,cause:'Real Mission/Reviewer/Acceptance/return completed. Controller observation then failed: no such table session_pending on V2 2.2. Preserved DB and native final; no model replay.'},{phase:'collect',exit:0,elapsed_ms:null,native_pending:native.pending,note:'Reran same saved database settlement after optional-table compatibility correction; no new model turn.'}],
    limitations:['Bounded inventory implementation proves this recovery path, not universal stability or release acceptance.','No desktop GUI rendering observed; native user-facing Markdown captured verbatim.','Reflection explicit configuration preserved byte-for-byte; no nonempty reflection reminder store was generated by this workload.','User workload cap 3 units respected by 2 direct units; native configured default max_units remains 32, not claimed configured 3.','The same-reviewer continuation tool returned an error while retained reviewer completion was independently delivered; error preserved, no duplicate Reviewer session.','Controller-only scripts/tests changed after package freeze; shipped src/dist remained unchanged. Final full/PR/main/preflight/release gates remain for root.','No cleanup: installed environment and DB still referenced by evidence and needed for follow-up.']};
  await save(path.join(base,'summary.json'),summary);console.log(JSON.stringify({checks,models,receipt:operator.receipt.status},null,2));
} else if(phase==='inspect') {
  const setup=await json(envFile),session=process.argv[3];
  const server=await startV2ReleaseServer(setup.project,setup.env,{credentialSource:setup.credentialSource});
  try {
    const data=JSON.parse(await command('messages-'+session,'/home/user/.opencode/bin/opencode',['api','--server',server.url,'session.message.list','--param',`sessionID=${session}`,'--param','limit=200','--param','order=asc'],setup.project,server.env));
    for(const m of data.data??[]){delete m.native;m.content=m.content?.filter(p=>p.type!=='reasoning');}
    await save(path.join(base,'native-'+session+'.json'),data);
  } finally {await server.stop();}
} else throw Error('phase: setup | freeze | upgrade | turn LABEL SESSION|- PROMPT [interrupt] | inspect SESSION');
