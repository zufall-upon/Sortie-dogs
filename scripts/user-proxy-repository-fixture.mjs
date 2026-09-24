import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A multi-module CLI/library task, frozen independently of the work-loop implementation. */
export async function repositoryFixture(project, record, chain) {
  await mkdir(join(project, 'bin'), { recursive: true });
  await mkdir(join(project, 'examples'), { recursive: true });
  const files = {
    'src/value.mjs': "export {audit} from './events.mjs';\n",
    'src/csv.mjs': `export function parseCSV(text, options = {}) {
  const lines = text.split(/\\r?\\n/).filter(line => line.trim());
  const headers = lines.shift().split(',');
  return lines.map((line, index) => Object.fromEntries(headers.map((header, column) => [header, line.split(',')[column]])));
}\n`,
    'src/events.mjs': `import {parseCSV} from './csv.mjs';
export function audit(text, options = {}) {
  const rows = parseCSV(text, options), actors = new Map(); let total = 0;
  for (const row of rows) {
    const amount = Number(row.amount);
    if (!Number.isFinite(amount)) throw new Error('Invalid amount');
    total += amount;
    actors.set(row.actor, (actors.get(row.actor) ?? 0) + amount);
  }
  return {count: rows.length, total, actors: Object.fromEntries(actors)};
}\n`,
    'bin/audit.mjs': `import {readFileSync,appendFileSync} from 'node:fs';import {audit} from '../src/value.mjs';
${record}
const args = process.argv.slice(2), path = args.find(arg => !arg.startsWith('--'));
try { const input = readFileSync(path, 'utf8');record('target-start');console.log(JSON.stringify(audit(input, {strict: args.includes('--strict')}))); }
catch(error) { console.error(error.message);process.exitCode = 2; }
finally { record('target-result'); }
`,
    'examples/events.csv': '\uFEFFamount,actor\r\n2,Alice\r\n\r\n3,Bob\r\n-1,Alice\r\n',
    'README.md': '# Event audit\n\nA small CSV library and CLI. Source is in src/, CLI in bin/.\nThe format has a header and comma-separated unquoted fields; quoted fields are not supported.\nRun the tests with npm test. An example input is examples/events.csv.\n',
  };
  await Promise.all(Object.entries(files).map(([path, content]) => writeFile(join(project, path), content)));
  const oracle = `import test,{after} from 'node:test';import assert from 'node:assert/strict';import{appendFileSync,mkdtempSync,writeFileSync,rmSync}from'node:fs';import{spawnSync}from'node:child_process';import{tmpdir}from'node:os';import{join}from'node:path';import{audit}from'../src/value.mjs';
${record}
after(()=>record('target-result'));
test('BOM, CRLF, blank lines and actor grouping',()=>{record('target-start');assert.deepEqual(audit('\\uFEFFamount,actor\\r\\n2,Alice\\r\\n\\r\\n3,Bob\\r\\n-1,Alice\\r\\n'),{count:3,total:4,actors:{Alice:1,Bob:3}});});
test('empty input and a header without data',()=>{for(const input of ['', ' \\r\\n', 'amount,actor\\n'])assert.deepEqual(audit(input),{count:0,total:0,actors:{}});});
test('legacy extra columns remain accepted outside strict mode',()=>assert.deepEqual(audit('amount,actor,note\\n2,A,a note'),{count:1,total:2,actors:{A:2}}));
test('strict mode uses original physical line numbers',()=>{
 for(const [input,line]of [['amount,actor\\n\\n2,A,extra',3],['amount,actor\\n2',2],['amount,actor\\n\\n,A',3],['amount,actor\\nInfinity,A',2],['amount,actor\\nabc,A',2]]){
   assert.throws(()=>audit(input,{strict:true}),error=>error instanceof Error&&new RegExp('line[ :]*'+line+'\\\\b','i').test(error.message));
 }
});
test('header rules distinguish strict and compatibility modes',()=>{
 for(const input of ['amount,amount,actor\\n1,2,A','amount,actor,note\\n2,A,x','actor\\nA'])assert.throws(()=>audit(input,{strict:true}),/line[ :]*1\\b/i);
 assert.deepEqual(audit('actor,amount\\nA,2',{strict:true}),{count:1,total:2,actors:{A:2}});
});
test('CLI exercises the same API and reports errors without a stack',()=>{
 const dir=mkdtempSync(join(tmpdir(),'audit-cli-'));try{
  const path=join(dir,'events.csv');writeFileSync(path,'\\uFEFFamount,actor\\r\\n2,Alice\\r\\n3,Bob\\r\\n-1,Alice\\r\\n');
  const ok=spawnSync(process.execPath,['bin/audit.mjs','--strict',path],{encoding:'utf8'});assert.equal(ok.status,0,ok.stderr);assert.deepEqual(JSON.parse(ok.stdout),{count:3,total:4,actors:{Alice:1,Bob:3}});
  writeFileSync(path,'amount,actor\\n\\n2,A,extra');const bad=spawnSync(process.execPath,['bin/audit.mjs',path,'--strict'],{encoding:'utf8'});
  assert.equal(bad.status,2);assert.match(bad.stderr,/line[ :]*3\\b/i);assert(!bad.stderr.includes(' at '));assert.equal(bad.stdout,'');
 }finally{rmSync(dir,{recursive:true,force:true});}
});\n`;
  const scope = 'CSV集計のライブラリとCLIを修正してください。先頭BOM、CRLF、空行を含む入力を扱い、空入力とヘッダーだけなら件数・合計0にしてください。strictモードを追加し、重複ヘッダー、amount/actorの不足、未知の列、列数不一致、空または非有限のamountを拒否してください。エラーには元ファイルの物理行番号を含めること。strictでない場合は余分な列を従来どおり許容してください。CLIの--strictでも同じ検証を行い、失敗時はスタックなしのメッセージと終了コード2、成功時はJSONを返すこと。READMEにAPIとCLIの仕様と例を書き、既存テストを保持して動作を検証してください。';
  const prompt = chain
    ? 'まず準備済みの node bin/audit.mjs examples/events.csv を実行してください。その結果から原因を調べて修正し、strict機能を追加、再検証まで完了してください。REPORT.mdに初回の観測、原因、修正後の実測と検証結果を書いてください。' + scope
    : scope;
  return { prompt, oracle, protectedFiles: ['examples/events.csv'], async verify() {
    const readme = await readFile(join(project, 'README.md'), 'utf8');
    if (!readme.includes('--strict') || !readme.includes('audit')) throw Error('API/CLI documentation missing');
    if (chain) {
      const report = await readFile(join(project, 'REPORT.md'), 'utf8');
      if (!/BOM/i.test(report) || !/4/.test(report) || !/test|検証|テスト/i.test(report)) throw Error('Run/diagnosis/improvement report incomplete');
    }
  } };
}
