# Sortie-dogs 日本語ガイド

**OpenCode にタスクを渡すだけで、調査・実装・検証を境界付きのループとして進められる。**

[![Sortie-dogs が境界付き実装ワークフローを統括する様子](assets/sortie-workflow.png)](assets/sortie-workflow.gif)

_画像を選択するとワークフローのアニメーションを再生できる。_

Sortie-dogs は、必要なセッションだけで動く OpenCode オーケストレーションプラグイン。
タスクを明確な計画、必要時だけの限定調査、自律的な逐次実装、canonical validation、証拠付き完了へつなげる。
OpenCode 標準のエージェントや設定は置き換えない。

要件: Node.js 22.6 以降、npm、OpenCode。

[English README](../README.md) · [简体中文](guide-zh-CN.md)

## Sortie-dogs の利点

- **必要なときだけ起動** — `/sortie` または `dog-coordinator` 選択時だけ有効。他の
  OpenCode セッションには影響しない。
- **過剰に広がらない限定調査** — manifest・validation・ownerの具体的gapごとに、発見時点を問わずscoutを使う。同一依頼は反復しない。
- **厳密な変更範囲** — source manifest または operation manifest が編集と handoff を制限。
- **自律的な逐次実装** — accepted scopeに必要なworkerを1体ずつ継続実行。通常laneに回数上限なし。並列fan-outだけ明示contract必須。
- **runtime競合防止** — 同一または祖先・子孫write scopeの同時bindを変更前に拒否。
  全parallel unitのjoin後にfull validationを1回実行。
- **証拠を伴う完了** — canonical validation、リスク別レビュー、terminal evidence の gate 後、
  coordinator だけが完了と commit を管理。
- **中断から継続可能** — restart recovery と境界付き compaction が handoff context を保持。

## 実際のループ

1. **Brief / plan** — `dog-coordinator` が acceptance criteria、変更 manifest、検証条件を確定。
2. **任意の scout** — concrete evidence gapが発生した時点で、read-only限定調査を実行。
3. **専用 worker** — accepted scope完了まで、固定manifest単位で逐次実装。
4. **Canonical validation** — 指定された test / build command の結果を evidence 化。
5. **リスク別 review** — 高リスク候補だけ独立 review。低リスク候補は validation 後に省略可能。
6. **Coordinator 完了** — manifest、validation、review、evidence gate 通過後だけ完了と commit を管理。
7. **境界付き継続** — restart recovery と compaction handoff で進捗を引き継ぎ、batch の無制限化を防止。

## 実行例

低リスクの実行例では、各 gate を示しながら境界内で完了する。

```text
利用者: /sortie 要求された動作を追加する
dog-coordinator: manifest 確定
dog-scout: 省略 — 具体的なevidence gapなし
dog-worker: 実装完了
validation: npm test — PASS
review: 省略 — 低リスク
dog-coordinator: 完了 evidence 承認
```

## 画面で見る流れ

### 複雑さを抑える

![役割とgateがオーケストレーションの複雑さを抑える構成](assets/sortie-complexity.png)

Coordinator が調査、実装、validation、review を別々の role に分ける。Project が複雑でも、
manifest gate が各 role の write scope を限定する。

### 証拠付きで完了する

![検証済み成果がcoordinator管理の完了へ到達する様子](assets/sortie-complete.png)

Canonical validation とリスク別 review を通過してから coordinator が完了を確定する。
変更内容と確認方法を示す簡潔な evidence を伴ってタスクを返す。

## npm からインストール

対象プロジェクトで公開 npm package を依存関係へ追加し、project-local な OpenCode runtime
file を生成する。

```sh
npm install --save-dev sortie-dogs
npx sortie-dogs init .
```

または CLI をグローバルインストールし、OpenCode のグローバル設定を初期化する。

```sh
npm install --global sortie-dogs
sortie-dogs init --global
```

`sortie-dogs init --global` は OpenCode のグローバル設定rootへ runtime fileを設置する。
project-local運用では別途 `sortie-dogs init .` を実行し、以下のproject-local設定または
plugin bridgeを使用する。

runtime asset の設置だけでは plugin は読み込まれず、その場合すべての role が呼び出し元と
同じ model で動作する。agent が動作する OpenCode 設定の `plugin` 配列へ package を追加する。
global asset なら `~/.config/opencode/opencode.json`、project なら `.opencode/opencode.json`。

```json
{
  "plugin": ["sortie-dogs"]
}
```

追加後は OpenCode を再起動する。`plugin` エントリには package 名を指定する。
`sortie-dogs/plugin` は import specifier であり plugin specifier ではない。

`dog-coordinator` のデフォルト model は `openai/gpt-5.6-terra` の `high` variant、`dog-scout` は
`openai/gpt-5.6-luna`。いずれかの role を変更する場合、次を `.opencode/sortie-dogs.json` に保存する。

```json
{
  "modelRouting": {
    "dog-coordinator": {
      "preferred": { "model": "provider/model" }
    },
    "dog-scout": {
      "preferred": { "model": "provider/model" }
    }
  },
  "modelCatalog": {
    "project": [{ "model": "provider/model" }]
  }
}
```

`provider/model` は利用可能な model に置き換える。

package を依存関係に持つ project では、`plugin` 配列の代わりに
`.opencode/plugins/sortie-dogs.ts` から読み込むこともできる。

```ts
export { SortieDogsPlugin } from "sortie-dogs/plugin";
```

この file は OpenCode が自動検出する。export は plugin だけにする。OpenCode は plugin module の
runtime export をすべて plugin factory として呼び出すため、余分な export が 1 つあるだけで
module 全体が無効になる。OpenCode 再起動後に開始する。

```text
/sortie <タスク>
```

`dog-coordinator` を直接選択しても起動できる。

## Write gate

Write gate は project ごとの opt-in。project root に `operation-manifest.json` が無い間、
plugin は passive でありツール呼び出しを一切拒否しない。この file を作ることが opt-in であり、
だから coordinator はいつでもこの file を作成できる。

```json
{
  "version": "0.1.0",
  "task_id": "add-requested-behavior",
  "read": ["src/feature.ts", "test/feature.test.ts"],
  "write": ["src/feature.ts", "test/feature.test.ts"],
  "validation": ["npm test"]
}
```

- `write`: bind 済み worker が変更できる唯一の path 集合。directory 指定は配下を含み、
  それ以外は exact path。
- `validation`: bind 済み worker が実行できる exact command。build / test command は path 抽出で
  分類できないため、宣言と完全一致した command だけを許可し、それ以外は unclassified として拒否する。
- `read`: 読み取り範囲の記録。read は拒否しない。

この file は `dog-coordinator` が所有する。worker は candidate ごとに一度だけ
`sortie_bind_write_gate` で bind し、bind は coordinator の handoff 検査後にのみ成立する。
coordinator session は gate 対象外。

handoff と operation manifest は inspection と bind の前に schema 検査され、どの object も
未知 property を拒否する。拒否時は必ず失敗した document、正確な JSON pointer、違反した規則を
返す。例: `Defects: handoff /state/blocked/0 schema_type`。coordinator は同じ document を
再送せず、その pointer を修復する。dispatch 前の確認には read-only の `sortie_check_contract`
tool を使う。inspection も bind も行わずに同じ defect を報告する。
`sortie-dogs lint <handoff.json> --manifest <operation-manifest.json>` でも同じ結果を得られる。
頻出 defect は 2 つ。`state.blocked` を `{ reason, needed }` object ではなく string 配列に
した場合と、operation manifest に `version` / `task_id` / `read` / `write` / `validation`
以外の property を宣言した場合。

`.opencode/sortie-dogs.json` の任意設定:

```json
{
  "operationManifestPath": "operation-manifest.json",
  "handoffPaths": ["handoff.json"],
  "readOnlyTools": ["my_mcp_search"],
  "dedicatedWorkerModel": { "model": "provider/model", "variant": "deep" },
  "reflection": {
    "enabled": false,
    "layers": { "run": true, "project": true, "global": false },
    "maxInjectedTokens": 500
  }
}
```

同じ schema を global の `~/.config/opencode/sortie-dogs.json`（Windows は
`%USERPROFILE%\.config\opencode\sortie-dogs.json`）にも保存できる。優先順は built-in default、
global file、project file、`SORTIE_DOGS_CONFIG`、plugin factory options。OpenCode の plugin
正規化で factory options が失われる環境では、global file を使う。

- `operationManifestPath`: manifest の位置。project 相対。
- `handoffPaths`: plugin が検査する handoff file。worker はこの検査を通過して初めて bind できる。
  空配列にすると bind 自体が成立しない。相対 entry は親 workspace 配下の nested repo でも
  candidate 相対として扱う。operational work では coordinator が dispatch 前に有効な handoff を
  作成して絶対 path を渡し、bind する child 自身が直前に built-in Read で読む。
  新規 contract は candidate 相対の `.sortie-dogs/contracts/` に
  `handoff.<id>.json` と `<id>.operation-manifest.json` として出力する。ここは `.gitignore`
  で ignore 推奨。legacy の root/scoped path と custom 設定 path は移動・削除せず、読み取り・preflight・bind
  互換を維持する。Sortie run が active でない場合だけ directory を削除する。
- `readOnlyTools`: MCP tool など、file を変更しない host 固有 tool 名を追加する。
  未知の tool は bind 済み session では既定で拒否される。
- `dedicatedWorkerModel`: `implementation`、`remediation`、`blocker-resolution`、
  `sol-worker-mk2a2`、`dog-worker` が使う serial implementation target。既定は
  `openai/gpt-5.6-sol` / variant `medium`。配布済み `dog-luna-worker` fabric route は
  `openai/gpt-5.6-luna` / variant `max` に固定される。serial target に同じ Luna model を指定すると
  route identity が収束するため、設定全体を無効として拒否する。coordinatorは prepared `luna-fabric` run の
  ready descriptor にだけこの role を dispatch し、`sol-serial` run では `dog-worker` を使う。
- `reflection`: activated root `dog-coordinator` だけが使える process prevention。既定無効。
  opt-in 後の run / project layer は既定有効、project 間で共有する global storage layer は明示的に
  有効化しない限り無効。child / 他 agent は拒否され、`SORTIE_REFLECTION=0` で即時停止する。
  governing `REFLECTION_POLICY` は reflection 有効時だけ注入する。`maxInjectedTokens` は動的な
  `SORTIE_PROCESS_REFLECTIONS` heading と永続化 entry 行の budget で、policy は対象外。
  解決済みblocker / review defect後とterminal unit時だけ評価し、1 run最大3件。通常のcode bugや
  外部障害は記録しない。
- 通常の OpenCode auto-compaction は host の auto-continue を維持する。Sortie が明示的に queue
  した rollover の処理中だけ、二重継続を防ぐため host auto-continue を抑止する。

## セッション lifecycle

プラグインは通常時 passive。`/sortie` を使うか `dog-coordinator` を選択したセッションだけを
有効化する。Source / operation manifest の exact write scope と worker handoff を検証し、
範囲外変更を通さない。標準 OpenCode agent、role、setting、無関係な session は維持される。

`session.idle` で最終 handoff を検証して session を解放し、`session.deleted` でも解放する。
後続 request では再度有効化が必要。

host 側の欠陥を 1 つだけ in-place で修復する。subagent の結果は child の最終メッセージの
「最後の text part」から構築されるため、reasoning model が turn の末尾に空の text part を
付けると結果が空になり、coordinator は worker が完了済みの作業を再 dispatch する。完了した
`task` の結果が空の場合、Sortie-dogs はその child session の最後の実 assistant text を復元する。
空でない結果、他の tool、読めない child session には触れない。

## モデルルーティング

`dog-coordinator` の built-in route は `openai/gpt-5.6-terra` の `high` variant。計画品質と進捗判断を
workflowのbottleneckにしないため、能力とcostの均衡を優先する。host が Terra unavailable と
証明した場合は設定済みfree-tier fallbackを使い、それもなければsession modelを維持する。`dog-scout` のデフォルトは
`openai/gpt-5.6-luna` の `high` variant。Project-local routing でどちらも上書きできる。

`implementation`、`remediation`、`blocker-resolution`、`sol-worker-mk2a2`、`dog-worker` は
stable serial target `openai/gpt-5.6-sol` の `medium` variant に固定される。host が提供できない場合だけ
`dedicatedWorkerModel` でserial targetを移動できる。配布済み `dog-luna-worker` はfabric admission後だけ使う
別routeで、`openai/gpt-5.6-luna` の `max` variantに固定される。coordinatorは v0.8 DAG contract を
`sortie_admit_luna_fabric` で admit し、`sortie_prepare_luna_fabric` で prepare した後にのみ、その
`luna-fabric` run のcurrent ready waveにある別々のunitを最大5つdispatchできる。DAG全体は最大64 unit。
active artifactがすべて検証された後、`sortie_advance_luna_fabric_wave` がruntime-owned hidden candidateへ統合し、
旧worktreeをcleanupして、そのexact snapshotから次waveのfresh worktreeを作る。最終wave後は
`sortie_validate_luna_fabric_candidate` がcanonical validationを1回実行し、review後の
`sortie_accept_luna_fabric_candidate` だけがtargetを1回CASする。宣言済みshared-path ownershipは重複unitをwave間で直列化する。
未所有overlapまたはadmission defectはjob全体を1つの `dog-worker` へ戻す。同じunitの複製実行は禁止。
`modelRouting` はどちらも置換できず、
serial targetに同じLuna modelを指定した設定も拒否する。0.7.0の`dog-worker`はLuna Maxだったが、v0.8は
その履歴を残した上でstable Solとfabric Lunaを分離する。その他の明示routeはPreferred targetから順序付き
fallbackへ決定的に解決する。Built-in defaultも明示routeもないroleはOpenCodeで選択済みmodelを維持する。

`dog-reviewer` と `dog-advisor` は呼び出し元の model を継承してはならない。候補を生成した model
で review / strategy を実行すると独立性が失われるため。両 role は catalog に
`anthropic/claude-opus-5` が宣言されていればそれを、なければserial workerより高effortの
`openai/gpt-5.6-sol` `xhigh` を使う。`dedicatedWorkerModel` の移動はconsultation policyを変更しない。
特定vendorは必須ではなく、両roleとも設定可能なので、実際に利用できるmodelを宣言すればよい。

```json
{
  "modelRouting": {
    "dog-coordinator": {
      "preferred": { "model": "openai/gpt-5.6-terra", "variant": "high" }
    },
    "dog-scout": {
      "preferred": { "model": "openai/gpt-5.6-luna", "variant": "high" }
    },
    "dog-reviewer": {
      "preferred": { "model": "anthropic/claude-opus-5" },
      "fallback": [{ "model": "openai/gpt-5.6-sol", "variant": "xhigh" }]
    },
    "dog-advisor": {
      "preferred": { "model": "openai/gpt-5.6-sol", "variant": "xhigh" }
    }
  },
  "modelCatalog": {
    "project": [
      { "model": "openai/gpt-5.6-terra", "variants": ["high"] },
      { "model": "openai/gpt-5.6-sol", "variants": ["medium", "xhigh"] },
      { "model": "openai/gpt-5.6-luna", "variants": ["max", "high"] },
      { "model": "anthropic/claude-opus-5" }
    ]
  }
}
```

設定先は `.opencode/sortie-dogs.json`。`modelCatalog` には実在する provider model と named
variant だけを宣言する。Sortie-dogs は variant を推測、probe、変換しない。Built-in catalog は
`anthropic/claude-opus-5` を意図的に含めないため、宣言して初めて推奨 consultation model が適用される。
Preferred、fallback の順で解決し、明示 route の候補が catalog に一つもなければ拒否する。

`dog-advisor` は coordinator からの限定 Strategy / SourceReview 相談専用。
`dog-reviewer` は canonical validation 後、高リスク候補だけを独立 review する。どちらも実装、
stage、commit、ユーザー対応を行わない。

## 更新と移行

[Release v0.8.1](https://github.com/zufall-upon/Sortie-dogs/releases/tag/v0.8.1)

依存 asset を新しい release に更新後、対象 project root で再実行する。

```sh
npx sortie-dogs init .
```

初期化後、coordinator の再開または新規 session 作成前に OpenCode host を完全に再起動する。
plugin module は process 単位で読み込まれるため、新規 session だけでは更新されない。

`init` は冪等。Sortie-dogs 所有 file を更新し、認識済み旧 runtime file を移行して、version を
`.opencode/sortie-dogs.version` に記録する。競合または未認識 file は変更せず安全に停止する。
`.opencode/sortie-dogs.json` を含むユーザー所有設定と OpenCode 標準 file は維持される。

## 安全な手動削除

Sortie-dogs にサポート対象の uninstall command はない。npm dependency は別途削除し、生成
runtime file は[安全な手動削除ガイド](uninstall.md)に従って削除する。Sortie-dogs 所有を確認した
exact path だけを対象とし、`.opencode` directory、wildcard、ユーザー所有 file は削除しない。
