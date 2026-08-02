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

package plugin は `sortie-dogs/plugin` から `SortieDogsPlugin` を公開する。project root の
`opencode.json` で plugin を指定し、`.opencode/package.json` に package dependency を置く。

`opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["sortie-dogs/plugin"]
}
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

最後の command は package entrypoint の import smoke のみ。これは structural OpenCode hook と write gate の読込み設定。
MkII workflow、agent、command を起動・実行しない。
OpenCode runtime は project の通常起動時に `opencode.json` の plugin entry を読み込む。この package 自体に OpenCode 起動 command はない。
plugin 呼出しは project root の `operation-manifest.json` と `handoff.json` を既定使用する。
`.opencode/sortie-dogs.json`、JSON object形式の `SORTIE_DOGS_CONFIG`、host override の順で既定値を上書きする。
manifest/configを読めない場合、read-only hookはno-op、write/handoff hookはfail closed。package importのみではhookやI/Oを開始しない。

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
