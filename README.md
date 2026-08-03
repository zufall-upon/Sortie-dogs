# Sortie-dogs

OpenCode の既存 MkII ワークフローを配布可能にする AI orchestration loop plugin。
`sortie-dogs` は handoff と operation manifest の契約をローカルで検査する。

## Prerequisites

- Node.js 22.6.0 以上
- npm

## Install、build、test

source checkout では lockfile から dependency を install し、`dist/` を build して test する。

```console
npm ci
npm run build
npm test
```

`npm test` は `pretest` で build してから Node.js test suite を実行する。

### Manifest gate（推奨）

`handoff.json`:

```json
{
  "version": "0.1.0",
  "profile": "minimal",
  "id": "quickstart",
  "created_at": "2026-08-02T00:00:00Z",
  "task": {
    "title": "Quickstart",
    "objective": "Validate the handoff and changed paths"
  },
  "state": { "done": [], "next": ["Run the guard"], "blocked": [] },
  "risks": [],
  "verification": []
}
```

`operation-manifest.json`:

```json
{
  "version": "0.1.0",
  "task_id": "quickstart",
  "read": [],
  "write": ["src/index.ts"],
  "validation": ["npm test"]
}
```

変更対象を manifest と照合する。warning も gate failure にする場合は `--strict` を使う。

```console
npm exec --package=. -- sortie-dogs lint handoff.json --manifest operation-manifest.json --changed-path src/index.ts --strict
```

### Minimal

handoff の schema と semantic rules だけを検査する場合は manifest と変更対象を省略できる。

```console
npm exec --package=. -- sortie-dogs lint handoff.json
```

`--package=.` は現在の local package の bin を一時 PATH に追加する。

### Entry points

- `sortie-dogs`: CLI entry point

## Package distribution and OpenCode runtime

配布用 tarball は repository の test environment に作成する。

```console
npm pack --pack-destination ./_testenv
```

tarball は build 済み `dist/`、`sortie-dogs` CLI、`sortie-dogs/plugin` export を含む。
次の例では `npm pack` が出力した tarball 名を `.opencode/package.json` に指定する。

package plugin は `sortie-dogs/plugin` から `SortieDogsPlugin` を公開する。
`.opencode/package.json` に package dependency を置き、project-local bridge から再公開する。
OpenCode は `.opencode/plugins/` を自動検出するため、`opencode.json` の `plugin` entry は不要。

`.opencode/plugins/sortie-dogs.ts`:

```ts
export { SortieDogsPlugin } from "sortie-dogs/plugin";
```

`.opencode/package.json`:

```json
{
  "private": true,
  "scripts": {
    "check:sortie-dogs": "node --input-type=module --eval \"import('sortie-dogs/plugin').then(({ SortieDogsPlugin }) => { if (typeof SortieDogsPlugin !== 'function') process.exit(1); console.log('plugin import PASS') })\""
  },
  "dependencies": {
    "sortie-dogs": "file:../_testenv/sortie-dogs-0.1.0.tgz"
  }
}
```

local tarball を dependency として install し、package export を smoke test する。両 command は host shell に依存しない。

```console
npm install --prefix ./.opencode
npm --prefix ./.opencode run check:sortie-dogs
```

`.tgz` の install は package と bridge が参照する dependency の配置だけを行い、OpenCode runtime asset を project へコピーしない。
install 後、project root で次の `init` を必ず実行する。

```console
node ./.opencode/node_modules/sortie-dogs/dist/cli/main.js init <project-root>
```

`init` は `.opencode/command/sortie.md`、`coordinator-mk2a2.md`、`sol-worker-mk2a2.md` などの runtime asset をコピーする。
完了後、OpenCode Desktop を完全終了・再起動し、fresh session を開く。これらを終えるまで `/sortie` は表示されない。

最後の command は package entrypoint の import smoke のみ。これは structural OpenCode hook と write gate の読込み設定。
MkII workflow、agent、command を起動・実行しない。
OpenCode runtime は project の通常起動時に local bridge を検出する。bridge 位置から
`.opencode/node_modules/sortie-dogs` が解決され、npm global cache の同名 package に依存しない。
この package 自体に OpenCode 起動 command はない。
plugin 呼出しは project root の `operation-manifest.json` と `handoff.json` を既定使用する。
`.opencode/sortie-dogs.json`、JSON object形式の `SORTIE_DOGS_CONFIG`、host override の順で既定値を上書きする。
manifest/configを読めない場合、read-only hookはno-op、write/handoff hookはfail closed。package importのみではhookやI/Oを開始しない。

## Fresh OpenCode acceptance

repository source や global npm cache ではなく、同じ checkout の `_testenv` に作成した tarball を使う。
fresh project も `_testenv` 以下に置き、package を project-local に install、runtime を init する。

```console
npm test
npm pack --pack-destination ./_testenv
npm install --prefix ./_testenv/rpt/project/.opencode ./_testenv/sortie-dogs-0.1.0.tgz
node ./_testenv/rpt/project/.opencode/node_modules/sortie-dogs/dist/cli/main.js init ./_testenv/rpt/project
```

前述の bridge を `.opencode/plugins/sortie-dogs.ts` に置く。WSL では `/mnt/...` の tarball と
project を使って同じ install/init を実行する。Windows Desktop 検証では tarball だけを承認済みの
private test host の `_testenv` へ転送し、remote test project で同じ手順を実行する。host、user、key、
Project item metadata は evidence に含めない。

init 後に OpenCode を完全終了・再起動し、対象 project の fresh session で `/sortie` を開始する。
次を順に確認する。

1. `coordinator-mk2a2` が manifest を固定し、implementation を `sol-worker-mk2a2` だけへ handoff する
2. canonical validation 後、risk rule に従う review 実施または skip decision が記録される
3. coordinator だけが manifest と staged path の一致を確認して commit する
4. terminal unit ごとに private Project checkpoint が同期され、3 attempted units で停止し、4件目を拒否する
5. manifest 外 path の write を mutation 前に拒否する

write gate は CLI でも独立確認できる。`operation-manifest.json` の `write` にない path を渡した
次の command は、入力値を露出しない `M005_CHANGED_PATH_NOT_WRITABLE` と exit `1` が期待値。

```console
sortie-dogs lint handoff.json --manifest operation-manifest.json --changed-path undeclared.txt --strict
```

evidence は command、exit、件数などの短い fingerprint、review/commit/checkpoint decision のみ保存する。
raw session log、token、credential、private Project metadata は保存しない。完了後は fresh project と転送した
tarball だけを削除し、source checkout、user file、global cache は変更しない。

### Known constraints

- `init` は runtime asset を install するが、dependency、bridge、user settings、credential は作成しない
- runtime 認識には OpenCode の再起動と fresh session が必要
- plugin は manifest/write gate を提供する。workflow、agent、validation、review、commit 自体の実行主体ではない
- CLI/agent provider の接続、credit、permission failure は package で回避せず external blocker として記録する
- Desktop acceptance は対話 session で `/sortie` を実行する。SSH による install/init だけで代替しない

### Sanitized RPT checkpoint (2026-08-03)

- `npm test`: exit `0`, 113/113 PASS
- local pack/install/init/import smoke: exit `0`; `_testenv` tarball と project-local dependency を確認
- undeclared-write gate: diagnostic `M005_CHANGED_PATH_NOT_WRITABLE`, expected exit `1`
- WSL CLI launcher/version: exit `0`; packed artifact の fresh install/init PASS
- WSL `/sortie`: fresh coordinator と `sol-worker-mk2a2` handoff、canonical validation、review skip、3 attempted units 停止、第4 unit 拒否を確認。承認済み private Project checkpoint 同期 PASS
- Windows Desktop: package transfer、fresh project-local install/init/import smoke は exit `0`。対話 Desktop の restart、fresh session、`/sortie` で coordinator から専用 worker への handoff、validation/review decision、3 attempted units 停止、第4 unit 拒否、undeclared-write 拒否を確認
- private Project checkpoint evidence は repository 外で確認し、Project URL/item metadata は保存しない
- repository 内の raw log/credential persistence なし。fresh acceptance artifacts は `_testenv` 限定

## CLI contract

- exit `0`: error なし。通常モードでは warning のみも含む
- exit `1`: error あり、または `--strict` で warning あり
- exit `2`: usage、入力読込、JSON parse など検査を開始できない失敗
- `--changed-paths-from -` の stdin は改行区切り changed paths 専用。handoff JSON は stdin から読まず、引数の file path から読む

## Non-goals

- OpenCode や MkII workflow の実行・代替
- agent、host、LLM、model、provider の選択・起動
- handoff や manifest に書かれた command、instruction、next action の実行

「opus相当」と「sol相当」は役割を人に示す表示ラベルのみ。特定 model、provider、host の選択や実行を保証・要求しない。

## Security boundary

- host や LLM は不要。検査はローカルかつ決定的で、入力内容を命令として実行しない
- CLI が読むのは引数で指定した handoff、任意の manifest、任意の changed-path file、および `--changed-paths-from -` の stdin
- 入力には機密情報を含めない。診断は入力値の露出を避けるが、file と stdin の読取権限、保管、削除は呼出側の責任
- untrusted input を安全な command や agent instruction に変換する sandbox ではない
