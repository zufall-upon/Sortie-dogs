# Sortie-dogs 日本語ガイド

**既存のOpenCode環境を維持しながらgoalを固定し、taskに応じて実行方法を変え、
cost・time・proofを最適化する実行ハーネス。**

通常はOpenCodeをそのまま使用する。範囲を限定した調査、実装、検証、review、
model routingが必要なtaskだけSortieを起動する。

- **Goal invariance**: accepted outcomeとproof要件を委譲、継続、remediation、再起動後も維持
- **Adaptive execution**: 小さい仕事は小さいまま処理。追加agentや強いmodelはtask形状・riskが必要とする場合だけ使用
- **Coexistence**: 選択時だけ有効化。通常のOpenCode agent、設定、user-owned fileを維持
- **Cost / time / proof**: agent数最大化ではなく、verified resultを得る実用上最小のcostとwall timeを目標化

[English README](../README.md) · [简体中文](guide-zh-CN.md) ·
[テスト](testing.md) · [CLI testing](cli-testing.md)

[Release v0.10.6](https://github.com/zufall-upon/Sortie-dogs/releases/tag/v0.10.6)

> **Beta:** v0.10.xは安定化中。1.0まではruntime behavior、設定、生成assetが
> 変更される可能性がある。

## まず試す

要件: Node.js 22.6以降、npm、OpenCode。

対象projectで実行する。

```sh
npm install --save-dev sortie-dogs
npx sortie-dogs init .
```

Beta packageの既定profileはv0.10。既存値を保持しながら、
`.opencode/opencode.json`へOpenCode V2 pluginと2階層subagent設定を追加する。

```json
{
  "plugins": ["sortie-dogs"],
  "experimental": { "subagent_depth": 2 }
}
```

OpenCodeを完全再起動して開始する。

```text
/sortie-v010 <タスク>
```

`dog-operator`の直接選択でも同じworkflowが起動する。v0.10でuser-facing authorityを
持つのは`dog-operator`だけ。`dogs-coordinator`と`*-v010` roleは内部childであり、
task開始agentとして選択しない。

`init`はruntime assetを設置し、`plugins` entryはruntime enforcementとmodel routingを
読み込む。両方必要。plugin moduleはprocess単位のため、更新後は新sessionだけでなく
OpenCode host全体を再起動する。

## v0.10.x方針

v0.10.xはstrategic authorityとbounded operationsを分離する。

- `dog-operator`: original request、acceptance criteria、scope、review判断、final acceptanceを保持
- hidden `dogs-coordinator`: 限定調査または承認済みserial queueを進行。source edit、acceptance変更、review、publishは禁止
- `dog-worker-v010`: host生成の1 unitをexact read/write/validation境界内で実装
- scout、advisor、reviewer: 明示evidence gap、strategy trigger、risk判断がある場合だけ限定起動

v0.10 profileは意図的にserial。stable profileのLuna fabricとparallel integrationは
このprofileでは公開しない。agent数ではなく、品質を落とさず高cost作業を減らすことが目的。

### v0.10.6以降のSWE-bench方針

v0.10.6以降、継続的にSWE-bench計測を取りながら開発する。未実行suiteの成功を
主張するものではなく、開発と計測を分離しない方針。

- 比較前にtask input、package/source snapshot、model route、budget、tool、stop endpointを固定
- 全writer停止後にcandidateをfreezeし、別copyへpinned official verifierを1回実行
- benchmark completion、official task correctness、harness terminalを別々に記録。Sortieの`DONE`やreview `PASS`をofficial reward扱いしない
- agent-to-freezeとverifier時間を分離し、root/descendant token、model step、child、cache、推定cost、coverageも記録
- infrastructure failureとscored failureを分離。小標本・unmatched結果をleaderboardや一般成功率に拡張しない

v0.10.6より前のlocal benchmark条件はhistorical evidenceとして完了扱い。以降の判断は
[Coding benchmark completion and correctness](benchmark-completion-contract.md)に従う
SWE-bench計測を使用する。

## 旧local case study

2026-09-14から2026-09-18に、固定DeepSWE task
`datacurve/anko-typed-variable-bindings`で収集したcompletion-filtered参考値。
matched pairでもleaderboard結果でもない。

- Bare OpenCode: Verified PASS `0/3`、F2P `3/27`、median agent wall `24.5 min`、median completed-run推定cost `$3.53`
- Sortie v0.9.12: Verified PASS `0/3`、F2P `23/27`、median wall `25.7 min`、median completed-run推定cost `$2.85`。追加interrupted attempt 2件の推定cost `$6.20`
- Sortie v0.10.3 one-shot: Verified PASS `0/1`、F2P `7/9`、wall `22.7 min`、推定cost `$3.79`
- Sortie v0.10.5 one-shot: Verified PASS `1/1`、F2P `9/9`、P2P `94/94`、wall `43.8 min`、推定cost `$2.58`

v0.10.5はverified success 1件であり成功率ではない。historical rate scheduleとendpointは
同一でなく、host cost 0も請求額として扱わない。詳細は
[定義、固定入力、制約](benchmark-reference.md)と
[machine-readable values](benchmarks/provisional-reference.json)。

## v0.10.6内部動作

1. **Intent固定**: `dog-operator`が完全なrequestをordered requirement、negative constraint、quality threshold、reference、有限proposal/execution budgetとして保持
2. **必要時だけ調査**: nontrivial taskはhidden `dogs-coordinator`へbounded read-only proposal調査を1件委譲可能。edit、shell、worker dispatch、read prefix拡大は禁止
3. **Exact plan承認**: rootがproposalをoriginal requestと比較し、exact revision/hashを承認。uncovered requirementやscope拡大はfail closed。complete contractが既知のsimple taskはdirect worker fast path
4. **Control生成**: hostがhandoff、operation manifest、acceptance ledger、short task referenceを生成しschema検証。model自身がwrite scopeを認可しない
5. **Serial unit実行**: 1 unitは`dog-worker-v010`へ直接、multi-unit planはhidden `dogs-coordinator`が逐次進行。workerは1回bindし、宣言pathだけ変更、宣言validationだけ実行
6. **Host evidence収集**: validation identityはsource snapshot、candidate、command、environment、scope、ownerを結合。prose上のPASSをproofにしない
7. **Risk別review**: high-risk candidateは独立SourceReview、low-riskは明示skip可能。reviewerはtool-freeで修正を実装しない
8. **Goalを弱めずremediation**: acceptance failureまたはblocking review findingはcommitted candidateからsame-goal replacementを作り、acceptanceとcumulative budgetを維持。scope拡大は後続user turnの明示承認が必要
9. **明示acceptance**: rootのcompletion operation成功時だけrunを閉じる。terminalは`DONE`、`INTERRUPTED`、`BLOCKED`、`NEED_DECISION`。return reportはhost observationから生成

Durable profile stateとhash-bound task referenceにより、summary proseからcriteriaを再構築せず
restart/compaction recoveryを行う。stale、foreign-root、変更済みreferenceは拒否。
任意Git lifecycleはnon-overwriting branchを1回作成し、exact path commitを1回実行できるが、
arbitrary Git、force push、release、publish authorityは付与しない。

## 設定

### Profile fileと優先順

既定package entryはv0.10 profile。

- Command: `/sortie-v010`
- Primary agent: `dog-operator`
- Project設定: `.opencode/sortie-dogs-v010.json`
- Global設定: `~/.config/opencode/sortie-dogs-v010.json`
- JSON環境変数override: `SORTIE_DOGS_V010_CONFIG`
- Runtime state: `.sortie-dogs-v010/`
- Installed asset marker: `.opencode/sortie-dogs-v010.version`

優先順はbuilt-in default、global file、project file、environment JSON、plugin factory options。
未知propertyまたは不正typeは拒否。`modelRouting`には`dog-operator`、
`dogs-coordinator`、`dog-reviewer-v010`などv0.10 external role名を使い、stable aliasを併記しない。

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
- `dedicatedWorkerModel`: canonical stable serial target。既定`openai/gpt-5.6-sol` / `medium`。v0.10 profileは下記explicit role routeも持つため、このstable設定からv0.10 worker routeを推定しない
- `consultation.strategy`: 固定advisor identity、任意`required`、正整数`maxCallsPerCandidate`。既定はnot required、1 call
- `consultation.sourceReview`: risk-based review。`maxCallsPerCandidate`既定`1`、`maxArtifactBytes`既定・最大`30720`。review必須時だけunavailableをblock扱い
- `continuation.enabled`: 既定`true`
- 自動継続にturn数上限なし。旧`continuation.maxAutoContinues`正整数設定は受理するが無視
- `continuation.taskWatchdogMilliseconds`: implementation Task待機中root inactivity。既定`300000`、範囲`10..1800000`
- `continuation.summarizeModel`: 任意compaction model。省略時は最新root modelを再利用
- `validationProfile`: `fast` / `balanced` / `assurance`。既定`balanced`
- `reflection`: shared schemaでは受理するが、serial v0.10 profileはreflection writeを公開しない。stable reflectionも既定無効のopt-in

v0.10 hostは`.sortie-dogs-v010/contracts/`配下のhandoffとmanifestを所有する。
このprofile用にlegacy root `operation-manifest.json`を作らず、生成controlを編集しない。
`.sortie-dogs-v010/`削除はactive Sortie runがない時だけ行う。

### Validation policy

`validationProfile`はnon-canonical depthを選択する。

- `fast`: static check
- `balanced`: targeted check
- `assurance`: related check

Canonical proofは常にcanonical。full-suiteはrelease contextまたはexplicit riskが必要。
workerはstatic/targeted/related、rootはcanonical/full-suiteを所有する。同一candidate、command、
environmentのevidenceは再利用し、validation budgetを重複消費しない。

### v0.10既定route

- `dog-operator`: `openai/gpt-5.6-luna-fast` / `max`
- `dogs-coordinator`: `openai/gpt-5.6-terra` / `xhigh`
- `dog-worker-v010`: `openai/gpt-5.6-luna-fast` / `max`
- `dog-scout-v010`: `openai/gpt-5.6-luna-fast` / `xhigh`
- `dog-reviewer-v010`: `openai/gpt-5.6-terra` / `xhigh`
- `dog-advisor-v010`: catalog宣言済み`anthropic/claude-opus-5`を優先、なければ`openai/gpt-5.6-sol` / `xhigh`

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
`SORTIE_DOGS_CONFIG`、`.sortie-dogs/`を使用。同一package install pathからstableとv0.10を
同じhostへ同時登録しない。

## Global利用

Project-local導入を推奨。複数projectへv0.10 assetを明示公開する場合:

```sh
npm install --global sortie-dogs
sortie-dogs init --global --profile v010
```

global OpenCode configへ`sortie-dogs`と`experimental.subagent_depth: 2`を追加する。Global initはassetだけを
設置し、default agentやuser settingを暗黙変更しない。

## 更新と削除

dependency更新後、initを再実行してOpenCodeを完全再起動する。

```sh
npx sortie-dogs init .
```

`init`は冪等。認識済みSortie-owned assetを更新しversionを記録する。user configを保持し、
unknown ownershipまたは競合fileでは安全に停止する。

uninstall commandは未提供。npm dependencyを別途削除後、
[安全な手動削除ガイド](uninstall.md)に従う。既知のSortie-owned exact pathだけを削除し、
`.opencode`全体やbroad wildcardを使用しない。
