import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';

// Reuse the retained isolated setup. Never initialize or replace the shared host.
const file=process.env.SORTIE_QUALIFICATION_ENV??'_testenv/v0150-qualification/environment.json';
const setup=JSON.parse(await fs.readFile(path.resolve(file),'utf8'));
const [label,session,message]=process.argv.slice(2);
if(!label||!message||!/^[-a-zA-Z0-9_]+$/.test(label))throw new Error('label session|- message required');
const managed=process.env.SORTIE_QUALIFICATION_MANAGED==='1';
const timeout=Number(process.env.SORTIE_QUALIFICATION_TIMEOUT_MS??180000);
if(!Number.isSafeInteger(timeout)||timeout<1000||timeout>900000)throw new Error('timeout must be 1000..900000 ms');
const args=['run',...(managed?[]:['--standalone']),'--format','json','--auto','--agent','dog-operator','--model','openai/gpt-6.1-sol',...(session==='-'?[]:['--session',session]),message];
const env={...process.env,...setup.env,PWD:setup.project};
if(managed)env.XDG_STATE_HOME=`${setup.base}/state`;
delete env.OPENCODE_SESSION_ID;
const started=Date.now();
const child=spawn(process.env.SORTIE_QUALIFICATION_CLI??'/home/user/.opencode/bin/opencode',args,{cwd:setup.project,env,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='',timedOut=false;
child.stdout.on('data',b=>{stdout+=b;process.stdout.write(b)});
child.stderr.on('data',b=>{stderr+=b;process.stderr.write(b)});
const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM')},timeout);
const exit=await new Promise((resolve,reject)=>{child.on('close',resolve);child.on('error',reject)}).finally(()=>clearTimeout(timer));
await fs.writeFile(`${setup.base}/${label}.json`,JSON.stringify({args,started,elapsed_ms:Date.now()-started,exit,timedOut,timeout,model:'openai/gpt-6.1-sol',cost_usd:null,stdout,stderr},null,2));
process.exit(exit??1);
