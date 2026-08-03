# Sortie-dogs 日本語ガイド

Sortie-dogs は、Mk2A2 オーケストレーションワークフローを OpenCode
プラグインとして導入する。標準の OpenCode エージェント、ロール、設定は置換しない。

要件: Node.js 22.6 以降、npm、OpenCode。

## インストールと初期化

作成済みのパッケージを対象プロジェクトへインストールし、プロジェクトのルートで初期化する。

```sh
npm install --save-dev /path/to/sortie-dogs-0.1.0.tgz
npx sortie-dogs init .
```

次に `.opencode/plugins/sortie-dogs.ts` を作成する。

```ts
export { SortieDogsPlugin } from "sortie-dogs/plugin";
```

OpenCode はこのブリッジを自動検出するため、`opencode.json` の `plugin` 設定は不要。
OpenCode を再起動後、次のように開始する。

```text
/sortie <タスク>
```

## 更新と移行

パッケージ更新後も、対象プロジェクトのルートで同じ初期化コマンドを再実行する。

```sh
npx sortie-dogs init .
```

`init` は冪等。Sortie-dogs が所有するファイルを更新し、認識可能な旧ランタイムファイルを
移行して、バージョンを `.opencode/sortie-dogs.version` に記録する。競合するファイルや
認識できないファイルは変更せず、安全に停止する。ユーザー所有の
`.opencode/sortie-dogs.json` と、OpenCode 標準のエージェント、ロール、設定は保持される。

## セッションの有効化

プラグインは通常のセッションでは動作しない。メッセージで `/sortie` を使用するか、
`dog-coordinator` を選択したときだけ、そのセッションで有効になる。他の OpenCode
セッションの動作は変わらない。

有効なセッションでは operation manifest と handoff が検証される。`session.idle` 時に
最終 handoff を検証してセッションを解放し、`session.deleted` 時にも解放する。
後続リクエストでは再度有効化が必要。

## モデルルーティングとフォールバック

モデルルーティングは任意。ロールにルートがなければ、OpenCode で選択済みのモデルを
変更しない。`modelRouting` はロール単位の明示的な上書きであり、全体の既定値ではない。

Mk2A2 の `implementation`、`remediation`、`blocker-resolution` は、専用 Sol モデル
`openai/gpt-5.6-sol` に固定される。フォールバックはなく、ユーザー設定では置換できない。
実装 worker は `dog-coordinator` からのみ作業を受け取り、ユーザー窓口にはならない。

`dog-advisor` は coordinator からの限定された Strategy または SourceReview 相談専用。
`dog-reviewer` は canonical validation 通過後の高リスク候補だけを独立レビューし、
低リスク候補では呼び出されない。どちらも実装、stage、commit、ユーザー対応を行わない。
Fable の Opus を使う場合も、この advisor/reviewer ロールにだけ明示的なルートを設定し、
必要なら順序付きフォールバックを指定する。

```json
{
  "modelRouting": {
    "dog-advisor": {
      "preferred": { "model": "fable/opus", "variant": "thinking" },
      "fallback": [{ "model": "provider/general" }]
    },
    "dog-reviewer": {
      "preferred": { "model": "fable/opus", "variant": "thinking" },
      "fallback": [{ "model": "provider/general" }]
    }
  },
  "modelCatalog": {
    "project": [
      { "model": "fable/opus", "variants": ["thinking"] },
      { "model": "provider/general" }
    ]
  }
}
```

設定は `.opencode/sortie-dogs.json` に保存する。`modelCatalog` には実際に利用可能な
provider model と named variant だけを宣言する。Sortie-dogs は variant を推測、検出、
変換しない。解決順は preferred、続いて記載順の fallback。明示的にルーティングした
ロールで候補が catalog に存在しなければ、そのルートは拒否される。

## 手動削除

Sortie-dogs に対応済みのアンインストールコマンドはない。通常の更新・移行には引き続き
`npx sortie-dogs init .` を使う。

npm 依存関係の削除は別操作となる。依存関係を宣言した `package.json` があるディレクトリで
`npm uninstall sortie-dogs` を実行する。パッケージ削除のために `package.json` や
`package-lock.json` を削除してはならない。

生成されたランタイムを手動削除する場合、次の Sortie-dogs 所有ファイルだけを正確な
パスで削除する。

```text
.opencode/agent/dog-coordinator.md
.opencode/agent/dog-worker.md
.opencode/agent/dog-scout.md
.opencode/agent/dog-reviewer.md
.opencode/agent/dog-advisor.md
.opencode/command/sortie.md
.opencode/sortie-dogs.version
```

`.opencode`、`.opencode/agent`、`.opencode/command` の各ディレクトリを削除してはならない。
`*.md` のようなワイルドカードも使用しない。標準の `plan`、`build`、`builder` エージェントと、
その他すべてのユーザー所有ファイルを残す。ランタイムファイルの削除時には
`.opencode/sortie-dogs.json`、プラグインブリッジ、他のエージェント、OpenCode 設定を削除しない。

旧ファイル `.opencode/agent/coordinator-mk2a2.md` と
`.opencode/agent/sol-worker-mk2a2.md` は、旧 Sortie-dogs マーカーまたは内容から
Sortie-dogs 所有と確認できる場合だけ削除できる。マーカーがない、判別できない、または
想定外のファイル名がある場合、削除を中止して内容を確認する。

この安全上の説明は、導入・移行の動作や `/sortie --model` の対象範囲を変更しない。
