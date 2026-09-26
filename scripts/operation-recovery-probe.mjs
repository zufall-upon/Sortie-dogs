import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { probe } from './mission-cli-probe.mjs';

// Real-model reproduction of the candidate-preparation friction, isolated from any benchmark run.
const result = await probe(resolve(process.argv[2]), resolve(process.argv[3]), {
  mode: 'complete', timeoutSeconds: 600, capUSD: 1.5, model: 'openai/gpt-6-luna-fast#max',
  prompt: `候補準備を1ユニットで実施してください。Operator Fast-laneを使えます。
要求: _testenv/candidate/** のみを出力範囲にし、mkdir -p _testenv/candidate/snapshot で新規領域を作成。
git tag --points-at HEAD でタグ観測し、git archive --format=tar --output=_testenv/candidate/source.tar HEAD でローカルsourceを固定。
curl --fail --location --silent --show-error --output _testenv/candidate/package.json --write-out '%{http_code} %{size_download}\\n' https://raw.githubusercontent.com/zufall-upon/Sortie-dogs/e8eb994769c4416d66a2303e055084f984e1b626/package.json で既知の公開ファイルを取得。
_testenv/candidate/receipt.json に {"archive":"source.tar","download":"package.json"} を保存。
検証は node check.mjs。入力readはcheck.mjsとinput.txt。入力・check.mjs・設定を変更しない。git commit/pushやリリース操作は不要。
成功したら低リスクのreview skipとcomplete_missionまで完了してください。`,
  setupFixture: async ({ project }) => {
    await writeFile(join(project, 'input.txt'), 'operation-recovery-source\n');
    await writeFile(join(project, 'check.mjs'), `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root='_testenv/candidate/';
assert.ok(readFileSync(root+'source.tar').includes(Buffer.from('seed\\n')));
assert.equal(JSON.parse(readFileSync(root+'package.json','utf8')).version,'0.12.10');
assert.deepEqual(JSON.parse(readFileSync(root+'receipt.json','utf8')),{archive:'source.tar',download:'package.json'});
console.log('OPERATION_RECOVERY_PASS');\n`);
  },
});
console.log(JSON.stringify(result, null, 2));
assert.equal(result.accepted, true, 'Real mission must reach a succeeded completion receipt');
assert.equal(result.errors.length, 0, 'Candidate preparation must not need denial/replanning');
assert.equal(result.models.filter(item => item.agent === 'dog-worker-v010').length, 1, 'One Worker, no replacement loop');
const receipts = JSON.parse(await readFile(join(result.project, '_testenv/candidate/receipt.json')));
assert.equal(receipts.archive, 'source.tar');
