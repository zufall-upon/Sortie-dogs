# Sortie-dogs 日本語ガイド

**既存のOpenCode環境を維持しながらgoalを固定し、taskに応じて実行方法を変え、
cost・time・proofを最適化する実行ハーネス。**

通常はOpenCodeをそのまま使用する。範囲を限定した調査、実装、検証、review、
model routingが必要なtaskだけSortieを起動する。

- **Goal invariance**: accepted outcomeとproof要件を委譲、継続、remediation、再起動後も維持
- **Adaptive execution**: 小さい仕事は小さいまま処理。追加agentや強いmodelはtask形状・riskが必要とする場合だけ使用
- **明確なWorker指示**: 簡潔な目標、明示制約、完了条件を渡し、実行管理はhost側で担う。[指示設計の原則](worker-instruction-design.md)を参照
- **Coexistence**: 選択時だけ有効化。通常のOpenCode agent、設定、user-owned fileを維持
- **Cost / time / proof**: agent数最大化ではなく、verified resultを得る実用上最小のcostとwall timeを目標化

[English README](../README.md) · [简体中文](guide-zh-CN.md) ·
[テスト](testing.md) · [CLI testing](cli-testing.md)

**現行release: [v0.13.3](https://github.com/zufall-upon/Sortie-dogs/releases/tag/v0.13.3)**
（[release notes](release-v0.13.3.md)）。既定Mission runtimeの`v010` profile、command、設定名は
互換性のため維持している。名前が`v010`でも導入版がv0.10という意味ではない。
現行asset markerは`0.13.3-coordinator-direct-v5`。

> **Beta:** v0.13.xは安定化中。1.0まではruntime behavior、設定、生成assetが
> 変更される可能性がある。

## まず試す

要件: Node.js 22.6以降、npm、OpenCode V2。

対象projectで実行する。

```sh
npm install --save-dev sortie-dogs@latest
npx sortie-dogs init .
```

既定は`v010` Mission profile。`init`が無関係な既存設定を保持しながら、
`.opencode/opencode.json(c)`へOpenCode V2 pluginを登録し、subagent depthを最低2へ設定する。

```json
{
  "plugins": ["sortie-dogs"],
  "experimental": { "subagent_depth": 2 }
}
```

既存local bridgeが`sortie-dogs/server`をimportしている場合は、それを再利用して重複登録を避ける。
既存のsubagent depthが2より大きい場合は維持する。

OpenCodeを完全再起動して開始する。

```text
/sortie-v010 <タスク>
```

`dog-operator`の直接選択でも同じworkflowが起動する。Mission profileの利用者向け入口は
`dog-operator`。`dogs-coordinator`と`*-v010` roleは内部childであり、
task開始agentとして選択しない。

`init`はruntime assetとOpenCode設定を設置し、package entryまたは既存local bridgeが
実行制御とmodel routingを読み込む。OpenCodeは監視対象設定を再読込できるが、導入済みdependencyの
置換は完全再起動が必要な場合がある。新しい会話sessionだけでは新pluginの読込を証明しない。

## v0.13.3の更新

PR #148・#149とUbuntuでの後続修正を統合。native background Mission、簡潔で原要求を保持する
Worker handoff、同じReviewer contextでの修正を導入した。

- OperatorはCoordinator、直接Worker、Reviewerをnative background jobとして起動し、短い応答後も
  利用者との会話に対応する。native完了通知が同じOperatorを再開する。起動通知やroot idleはMission完了ではない。
  Coordinator内部の委譲はforegroundのまま。無関係な会話で進行中Missionを取消・置換しない。
- 指摘したReviewer自身が、同じnative session・model・contextで修正、継承した正式検証、要求された
  Git delivery、明示self-recheckまで担当する。hostは修正中だけscope付きprofileを有効化し、終了後は
  read-only Reviewerへ戻す。元要求、現在sourceの証跡、累積budgetを保持する。
- 作者の再確認は`self-rechecked`、`independent=false`として記録し、独立Reviewの`PASS`とはしない。
  別Reviewerは、再確認後に具体的な到達可能経路を持つ残存Major riskがある場合だけ必要。
  未解決Major・Mediumは受理不可。最終比較と成功receiptはOperatorが担当する。

固定releaseはcandidate preflight、Linux全体 **1,589/1,589**、Windows **12/12** を通過。
native CLI probeでは実WorkerのLuna Fast/max、OperatorのSol 6.1/xhighを観測した。
これは起動と実modelの確認であり、task完遂の証明ではない。

導入済みnative修正fixtureは成功したが、元Anko taskの観測は最新25分runを含め未受理。
一般的な高速化、元task完遂、新SWE-bench scoreは主張しない。
[実装と測定の記録](anko-pr149-ubuntu-handoff.md)と[Reviewer修正仕様](reviewer-context-repair.md)を参照。

## Mission workflow

有用な1 unitと意味のある正式checkが既知ならOperator → Worker。
調査や分割が本当に必要ならOperator → Coordinator → Workerを使う。

- `dog-operator`: 簡潔な要件・禁止事項、利用者判断、最終acceptanceを担当。hostが元発言を原文保存する。
- hidden `dogs-coordinator`: 調査、unit宣言、Worker/Scout/Advisor/Reviewer委譲、元要求内の
  write scope調整、修正進行を担当。read/searchと確認shellを使える。source実装はWorkerまたは
  同contextで修正を許可されたReviewerが担当する。
- `dog-worker-v010`: host生成unitをfile/directory write scope内で実装。調査commandの事前登録は不要。
  正式checkはhostが実結果を記録する。
- 高risk変更は最初の独立Reviewerがread/searchで審査。低risk skipは明示記録する。
  Fast-laneは高riskの単一unitにも利用可能だが、Review skipを意味しない。
- 調査・実装・正式検証・要求されたGit deliveryは同じ実装child内で完了する。利用者指定の順序を維持し、
  定型的なplan承認やcommit専用handoffを挟まない。unit進捗は実行中Taskへ表示する。

`v010` Mission profileはserial。background化は並列writerの追加ではない。
stable profileのLuna fabricとparallel integrationは公開しない。
agent数ではなく、品質を維持しながら不要な高cost作業を減らすことが目的。

## SWE-bench測定結果

- **v0.12.24 / Lite test300: 170/300（56.67%）**。1回のpass@1 campaign、空patch 9件、
  公式評価error 0件。実Workerは`openai/gpt-6-luna-fast#max`、Operator/Coordinator/Reviewは
  `openai/gpt-6-sol#xhigh`。これはsystem全体の結果で、Luna単独比較やVerified/full SWE-bench scoreではない。
  確定推論費用 **$162.99**、価格不明usageの予算hold **$34.60** は別管理し既知費用へ加算しない。
  [技術報告](benchmarks/swebench-lite-v01224-test300-2026-09-29.md)・
  [公開prediction/log/trajectory](https://github.com/zufall-upon/sortie-dogs-swebench-lite-20260929)。
- **v0.13.1 / Lite dev23: 8/23（34.8%）**、2026-09-30。v0.12.25の7/23から
  `pylint-dev__astroid-1333`が追加解決し、既存7件を維持。空patch・公式評価errorは0件。
  WorkerはLuna Fast/max、Operator/Coordinator/Reviewer/AdvisorはGPT-6.1 Sol/xhigh。
  8 slots、$2/instance、campaign上限$46、20分進捗確認・最大40分。
  既知推論費用 **$17.73**、不明usage hold **$1.98** は別管理。推論約81分、公式採点7.2分。
  [固定条件・中断runの扱い・詳細](../README.md#v0131-dev23-2026-09-30)。

どちらも過去の固定candidateの結果で、v0.13.3のscoreではない。version、予算、条件が異なるため
統制比較や一般成功率へ拡張しない。inference完了、Sortieの`DONE`、Review `PASS`、公式解決を区別する。
公式local評価とleaderboard登録・承認も別扱い。SWE-benchは必要時の別計測で、release必須gateではない。
[測定契約](benchmark-completion-contract.md)、[結果履歴](../README.md#swe-bench-evaluation)、
[旧local case study](benchmark-reference.md)に条件と制約を保持する。

## Mission tools

1. `start_mission`: Operatorが簡潔な要件を渡し、hostが元発言を保存してCoordinator Taskを返す。
2. `plan_units`: title、objective、file/directory scope、正式checkを指定。hostがID、handoff、manifest、
   proof対応、実行可能なWorker Taskを生成する。proposal承認の往復は不要。
3. `operator_next`: serial unitを進める。`expand_unit`は同じTaskを維持して元要求内の必要outputを調整。
   通常unitの回復は理由付き`plan_units`修正または`retry_mission_unit`で行い、累積budgetを維持する。
4. `review_mission`: source、原要求、実checkから独立Review packetを生成。高riskではReviewer Taskを委譲し、
   低riskでは明示skipを記録する。
5. `repair_review`: 指摘した元Reviewerのnative sessionを再開。修正、継承check、要求されたGit delivery、
   `SELF_RECHECKED`を同じTaskで実施する。旧`CORRECTION_READY`だけの場合は、`review_mission`から
   同じ作者のread-only再確認へ進む。
6. `submit_mission`: Coordinatorが完了candidate、利用者のみ判断可能な事項、証明済み外部/scope/budget blockerを返す。
7. `complete_mission`: Operatorが原要求・source・証跡を比較して明示acceptance。
   成功receiptだけが`DONE`と実測🐾 return reportを許可する。

全tool名は`sortie_v010_` prefix。旧proposal/plan-repairは互換実装に残るが、通常Missionのtool一覧では非表示。
元要求内のpath調整はOperator/Coordinatorが担当し、新たな利用者承認は不要。
原要求を超える変更や累積budget増額はOperator/利用者へ戻す。
`EVIDENCE_GAPS`は参考制約でありReview `PASS`でも追加Reviewの自動起動理由でもない。
必要checkの失敗・未実行はacceptanceを妨げる。

Durable profile stateとhash-bound task referenceにより、summary proseからcriteriaを再構築せず
restart/compaction recoveryを行う。stale、foreign-root、変更済みreferenceは拒否。
要求された`git add <paths>`と`git commit -m ...`は実sourceのwrite scopeを使用し、架空の`.git/**` scopeを要求しない。
任意のhost管理Git lifecycleはbranch・commit・post-commit境界を維持する。
どちらもarbitrary Git、force push、release、publish authorityを付与しない。

### 簡潔な進捗表示

`sortie_v010_operator_status`は原要求、正式command・exit・時刻、Review判断、記録済みdeliveryを簡潔に表示する。
`{ "view": "progress" }`は現在unit、完了数/総数、host budget、次操作を示し、
`{ "view": "full" }`または`details_ref`でsnapshot診断の詳細を取得できる。
未観測cleanや失敗commitはdelivery成功にしない。進捗参照はdispatch・retry・acceptanceを起こさない。
pollingではなくnative完了通知を使う。statusの既存reconciliationは取り逃したchild終了を回復できる。

## 設定

### Profile fileと優先順

既定package entryは`v010` Mission profile。

- Command: `/sortie-v010`
- Primary agent: `dog-operator`
- Project設定: `.opencode/sortie-dogs-v010.json`
- Global設定: `~/.config/opencode/sortie-dogs-v010.json`
- JSON環境変数override: `SORTIE_DOGS_V010_CONFIG`
- Runtime state: `.sortie-dogs-v010/`
- Installed asset marker: `.opencode/sortie-dogs-v010.version`

Global導入時のmarkerは`<OpenCode config root>/sortie-dogs-v010.version`。

優先順はbuilt-in default、global file、project file、environment JSON、plugin factory options。
未知propertyまたは不正typeは拒否。`modelRouting`には`dog-operator`、
`dogs-coordinator`、`dog-reviewer-v010`など`v010` external role名を使い、stable aliasを併記しない。

`.opencode/sortie-dogs-v010.json`例:

```json
{
  "validationProfile": "balanced",
  "readOnlyTools": ["my_mcp_search"],
  "freeTierFallbackModels": ["opencode/deepseek-v4-flash-free"],
  "modelRouting": {
    "dog-operator": {
      "preferred": { "model": "provider/model", "variant": "high" }
    },
    "dogs-coordinator": {
      "preferred": { "model": "provider/model", "variant": "deep" }
    }
  },
  "modelCatalog": {
    "project": [
      { "model": "provider/model", "variants": ["high", "deep"] }
    ]
  },
  "continuation": {
    "enabled": true,
    "taskWatchdogMilliseconds": 300000
  }
}
```

hostが実際に提供するmodelとnamed variantだけを宣言する。Sortieはvariantを推測、probe、変換しない。

### 設定reference

- `readOnlyTools`: project fileを変更しないhost固有tool名を追加。layer間で累積。bind済みworkerでは未知toolを拒否
- `modelRouting`: external profile role別preferred targetとordered fallback
- `modelCatalog`: 利用可能な`project` / `global` model・variant宣言
- `freeTierFallbackModels`: global last-resort model ID。既定`opencode/deepseek-v4-flash-free`、`[]`で無効
- `dedicatedWorkerModel`: canonical stable serial target。既定`openai/gpt-6.1-sol` / `medium`。Mission profileは下記explicit role routeを持ち、このstable設定からWorker routeを推定しない
- `consultation.strategy`: 固定advisor identity、任意`required`、正整数`maxCallsPerCandidate`。既定はnot required、1 call
- `consultation.sourceReview`: risk-based review。`maxCallsPerCandidate`既定`1`、`maxArtifactBytes`既定・最大`30720`。review必須時だけunavailableをblock扱い
- `continuation.enabled`: 既定`true`
- 自動継続にturn数上限なし。旧`continuation.maxAutoContinues`正整数設定は受理するが無視
- `continuation.taskWatchdogMilliseconds`: implementation Task待機中root inactivity。既定`300000`、範囲`10..1800000`
- `continuation.summarizeModel`: 任意compaction model。省略時は最新root modelを再利用
- `validationProfile`: `fast` / `balanced` / `assurance`。既定`balanced`
- `reflection`: 既定有効。`run` / `project` / `global` layerを使い、最大3件・推定500 tokensを注入。
  root Operatorが`sortie_v010_reflection`で確認済みの作業上の原因・予防策を保存し、後続turn/sessionで再利用する。
  モデルの再学習ではない。保存先とmanaged blockはstableから独立。`reflection.enabled: false`で無効化

Mission hostは`.sortie-dogs-v010/contracts/`配下のhandoffとmanifestを所有する。
このprofile用にlegacy root `operation-manifest.json`を作らず、生成controlを編集しない。
`.sortie-dogs-v010/`削除はactive Sortie runがない時だけ行う。

### Validation policy

`validationProfile`は補助的なnon-canonical depthを選択する。

- `fast`: static check
- `balanced`: targeted check
- `assurance`: related check

宣言済みの意味ある正式checkや利用者/project必須の全体検証を置き換える設定ではない。
関連修正をまとめ、限定checkを通してから、安定candidateで全宣言checkを順番に実施する。
実装Workerまたは修正を許可されたReviewerが実commandを走らせる。
canonical/full-suiteの`owner=coordinator`は証跡管理上の分類で、root自身の実行を強制するものではない。

必須の全体検証は最終統合candidateで行う。同一証跡はcontractが許す場合だけ再利用し、
candidate・command・environment・scope・ownerを照合する。必須の反復checkには各実行identityがあり、
重複扱いで省略しない。native command、実workdir、exit、時間、保存source bindingで鮮度を判断する。
診断は正式証跡の代用にならない。変更影響・失敗・鮮度要件で再実行を選び、
Worker交代や文書編集だけを理由に無関係な検証を繰り返さない。

### 既定route

- `dog-operator`: `openai/gpt-6.1-sol` / `xhigh`
- `dogs-coordinator`: `openai/gpt-6.1-sol` / `xhigh`
- `dog-worker-v010`: `openai/gpt-6-luna-fast` / `max`
- `dog-scout-v010`: `openai/gpt-6-luna-fast` / `max`
- `dog-reviewer-v010`: `openai/gpt-6.1-sol` / `xhigh`
- `dog-advisor-v010`: `openai/gpt-6.1-sol` / `xhigh`

OpenCodeで明示選択したmodel/variantはそのsessionで最優先。child defaultはnative設定がない時だけ補完し、
有効なprofile routingで上書き可能。reviewがimplementation modelを暗黙継承することはない。

## Stable互換profile

従来のparallel-capable runtimeは明示的に利用可能。

```sh
npx sortie-dogs init . --profile stable
```

既定package plugin entryではなくproject bridgeから読み込む。

```ts
export { SortieDogsPlugin } from "sortie-dogs/plugin/stable";
```

Stable profileは`/sortie`、`dog-coordinator`、`.opencode/sortie-dogs.json`、
`SORTIE_DOGS_CONFIG`、`.sortie-dogs/`を使用。同一package install pathからstableと`v010`を
同じhostへ同時登録しない。

## Global利用

Project-local導入を推奨。現行Mission assetをglobalで利用する場合:

```sh
npm install --global sortie-dogs@0.13.3
sortie-dogs init --global --profile v010
```

Global initはpackage登録または既存local V2 bridgeを再利用し、subagent depthを最低2へ設定する。
default agentと無関係な利用者設定は保持する。

既存の`<OpenCode config root>/plugins/sortie-dogs/index.js`が`sortie-dogs/server`をimportする構成では、
そのconfig root配下の**別dependency**を参照する場合がある。npm global版だけの更新では揃わない。
この構成では実際のconfig rootにも同じreleaseを導入し、global initを再実行する。

```sh
npm install --prefix "$HOME/.config/opencode" sortie-dogs@0.13.3
sortie-dogs init --global --profile v010
```

上記は既定config root。上書き設定がある場合は実pathを使う。設定済みnpm package entryには
OpenCode V2の`opencode plugin list` / `opencode plugin update`も使える。固定versionは明示変更が必要。
更新後はOpenCodeを完全再起動し、導入package・asset marker・実際の読込版を照合する。

## 更新と削除

Project-local更新はdependencyを置換し、initを再実行してOpenCodeを完全再起動する。

```sh
npm install --save-dev sortie-dogs@latest
npx sortie-dogs init .
```

`init`は冪等。認識済みSortie-owned assetを更新しversionを記録する。user configを保持し、
unknown ownershipまたは競合fileでは安全に停止する。

固定version設定や別bridge dependencyも対象releaseへ揃える。
`0.13.3-coordinator-direct-v5`は導入assetの識別子であり、稼働中OpenCodeの新plugin読込を証明しない。

uninstall commandは未提供。npm dependencyを別途削除後、
[安全な手動削除ガイド](uninstall.md)に従う。既知のSortie-owned exact pathだけを削除し、
`.opencode`全体やbroad wildcardを使用しない。

Maintainer向け[release batch guide](release-batch.md)には固定tarball検証、global反映、
GitHub公開、手動npm公開の手順を記載している。
