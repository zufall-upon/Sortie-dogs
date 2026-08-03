# Sortie-dogs 日本語ガイド

**OpenCode にタスクを渡すだけで、調査・実装・検証を境界付きのループとして進められる。**

[![Sortie-dogs が境界付き実装ワークフローを統括する様子](assets/sortie-workflow.png)](assets/sortie-workflow.gif)

_画像を選択するとワークフローのアニメーションを再生できる。_

Sortie-dogs は、必要なセッションだけで動く OpenCode オーケストレーションプラグイン。
タスクを明確な計画、並列調査、専任実装、canonical validation、証拠付き完了へつなげる。
OpenCode 標準のエージェントや設定は置き換えない。

要件: Node.js 22.6 以降、npm、OpenCode。

[English README](../README.md) · [简体中文](guide-zh-CN.md)

## Sortie-dogs の利点

- **必要なときだけ起動** — `/sortie` または `dog-coordinator` 選択時だけ有効。他の
  OpenCode セッションには影響しない。
- **過剰に広がらない並列調査** — 各 worker handoff の前に境界付き scout を必ず3体だけ使う。
- **厳密な変更範囲** — source manifest または operation manifest が編集と handoff を制限。
- **実装責任を一本化** — 専用 Sol worker が implementation、remediation、
  blocker-resolution を担当。
- **証拠を伴う完了** — canonical validation、リスク別レビュー、terminal evidence の gate 後、
  coordinator だけが完了と commit を管理。
- **中断から継続可能** — restart recovery と境界付き compaction が handoff context を保持。

## 実際のループ

1. **Brief / plan** — `dog-coordinator` が acceptance criteria、変更 manifest、検証条件を確定。
2. **3体の scout** — read-only の限定調査を並列実行し、異なる観点の evidence を収集。
3. **専用 worker** — 承認済み manifest 内だけを実装。範囲内の修正と blocker 解消も担当。
4. **Canonical validation** — 指定された test / build command の結果を evidence 化。
5. **リスク別 review** — 高リスク候補だけ独立 review。低リスク候補は validation 後に省略可能。
6. **Coordinator 完了** — manifest、validation、review、evidence gate 通過後だけ完了と commit を管理。
7. **境界付き継続** — restart recovery と compaction handoff で進捗を引き継ぎ、batch の無制限化を防止。

## 画面で見る流れ

### 複雑さを抑える

![役割とgateがオーケストレーションの複雑さを抑える構成](assets/sortie-complexity.png)

Coordinator が調査、実装、validation、review を別々の role に分ける。Project が複雑でも、
manifest gate が各 role の write scope を限定する。

### 証拠付きで完了する

![検証済み成果がcoordinator管理の完了へ到達する様子](assets/sortie-complete.png)

Canonical validation とリスク別 review を通過してから coordinator が完了を確定する。
変更内容と確認方法を示す簡潔な evidence を伴ってタスクを返す。

## v0.1.1 リリースからインストール

対象プロジェクトで GitHub Release の公開 asset を依存関係へ追加し、runtime file を生成する。

```sh
npm install --save-dev https://github.com/zufall-upon/Sortie-dogs/releases/download/v0.1.1/sortie-dogs-0.1.1.tgz
npx sortie-dogs init .
```

OpenCode 用ブリッジ `.opencode/plugins/sortie-dogs.ts` を作成する。

```ts
export { SortieDogsPlugin } from "sortie-dogs/plugin";
```

OpenCode が自動検出するため、`opencode.json` の `plugin` 設定は不要。OpenCode 再起動後に開始する。

```text
/sortie <タスク>
```

`dog-coordinator` を直接選択しても起動できる。

## Write scope とセッション lifecycle

プラグインは通常時 passive。`/sortie` を使うか `dog-coordinator` を選択したセッションだけを
有効化する。Source / operation manifest の exact write scope と worker handoff を検証し、
範囲外変更を通さない。標準 OpenCode agent、role、setting、無関係な session は維持される。

`session.idle` で最終 handoff を検証して session を解放し、`session.deleted` でも解放する。
後続 request では再度有効化が必要。

## モデルルーティング

`dog-coordinator` と `dog-scout` のデフォルトは `openai/gpt-5.6-luna` の `xhigh`
variant。この構成を推奨する。境界付き prompt、簡潔な scout evidence、不要な context / tool turn
の削減により、品質維持に配慮しつつ token 使用量を抑えられる可能性がある。Project-local routing
で両 role のデフォルトを上書き可能。

`implementation`、`remediation`、`blocker-resolution` は専用 Sol worker に固定され、
ユーザー設定では置換できない。その他の明示 route は Preferred target から順序付き fallback
へ決定的に解決する。Built-in default も明示 route もない role は、OpenCode で選択済みの model
を維持する。

```json
{
  "modelRouting": {
    "dog-coordinator": {
      "preferred": { "model": "openai/gpt-5.6-luna", "variant": "xhigh" }
    },
    "dog-scout": {
      "preferred": { "model": "openai/gpt-5.6-luna", "variant": "xhigh" }
    },
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
      { "model": "openai/gpt-5.6-luna", "variants": ["xhigh"] },
      { "model": "fable/opus", "variants": ["thinking"] },
      { "model": "provider/general" }
    ]
  }
}
```

設定先は `.opencode/sortie-dogs.json`。`modelCatalog` には実在する provider model と named
variant だけを宣言する。Sortie-dogs は variant を推測、probe、変換しない。Preferred、fallback
の順で解決し、明示 route の候補が catalog に一つもなければ拒否する。上記 advisor / reviewer
route は任意の secondary example。不要なら省略できる。

`dog-advisor` は coordinator からの限定 Strategy / SourceReview 相談専用。
`dog-reviewer` は canonical validation 後、高リスク候補だけを独立 review する。どちらも実装、
stage、commit、ユーザー対応を行わない。

## 更新と移行

依存 asset を新しい release に更新後、対象 project root で再実行する。

```sh
npx sortie-dogs init .
```

`init` は冪等。Sortie-dogs 所有 file を更新し、認識済み旧 runtime file を移行して、version を
`.opencode/sortie-dogs.version` に記録する。競合または未認識 file は変更せず安全に停止する。
`.opencode/sortie-dogs.json` を含むユーザー所有設定と OpenCode 標準 file は維持される。

## 安全な手動削除

Sortie-dogs に対応済み uninstall command はない。npm dependency の削除は別操作。
依存を宣言した `package.json` の directory だけで `npm uninstall sortie-dogs` を実行する。
削除目的で `package.json` や `package-lock.json` を消してはならない。

生成 runtime を手動削除する場合、次の Sortie-dogs 所有 path だけを正確に削除する。

```text
.opencode/agent/dog-coordinator.md
.opencode/agent/dog-worker.md
.opencode/agent/dog-scout.md
.opencode/agent/dog-reviewer.md
.opencode/agent/dog-advisor.md
.opencode/command/sortie.md
.opencode/sortie-dogs.version
```

`.opencode`、`.opencode/agent`、`.opencode/command` directory 自体を削除しない。`*.md` のような
wildcard も使わない。標準の `plan`、`build`、`builder` agent と全ユーザー所有 file を残す。
`.opencode/sortie-dogs.json`、plugin bridge、他 agent、OpenCode setting も削除対象外。

旧 file `.opencode/agent/coordinator-mk2a2.md` と
`.opencode/agent/sol-worker-mk2a2.md` は、旧 Sortie-dogs marker または内容で Sortie-dogs 所有を
確認できた場合だけ削除可能。所有不明または想定外 filename なら削除を中止して確認する。
