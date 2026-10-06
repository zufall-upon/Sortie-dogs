# Anko v0.13.6：同一arm継続・60分上限停止

## 結果

本体を**1回実行したが、課題は未完了・未受理**。品質成功やscoreではない。

- 外側Mission：`mission-02f2da75-baa9-487c-8984-d41504ce6a56`。
- 本体Root：`ses_ef6b65018ffedqYEVlTe370QNW`。
- 本体内側Mission：`mission-549d904a-0858-4661-aed4-3886be00c8ee`。
- 内側Worker：`ses_ef6b524c2ffeKt3AEBqnw7NKii`。本体arm 1回、内側Worker派遣1回。
- 停止理由：`wall-time-cap`。本体経過 **3,600,134 ms**。
  60分上限から134 msのpolling超過を観測。上限延長ではない。
- ソース変更0、Anko commit 0。HEADは元baseのまま。
  実装検証、Review、submission、native受理receiptはない。
- Rootのnative `succeeded`は**85,009 msで終わった応答**の状態。
  Workerはその後も未完了だったため、本体の成功とは扱わなかった。
- 時間上限でWorkerへinterruptを要求し、API応答はerrorなし。
  保存時のWorker sessionのnative terminalは未観測。
  所有serverは停止済み。保存DBとVACUUM snapshotのcredential行は各0。
- 新trial、追加Worker、本体の再起動、元課題の再送、上限延長は行っていない。

## 準備修復と条件保持

以前の「CLI 2.0.18ではLunaがない」は、モデル提供停止ではなく
**準備runnerのcatalogue照合ミス**だった。

固定CLI 2.0.18の実際の`model.list`には次のentryが存在した。

- 選択用`id`：`gpt-6-luna-fast`。
- API用`modelID`：`gpt-6-luna`。
- variantに`max`あり。aliasのbodyは`service_tier: priority`。

旧runnerは`modelID === 'gpt-6-luna-fast'`で探索していたため偽の不在を報告。
新しい継続runnerだけを`id`照合に修正した。CLI、model、variant、共有設定、
isolated project設定、製品コードは変更していない。
初期化直後にはmodel/agent一覧が空の観測もあったため、初期化完了を待つ。
診断ではAPI用IDを待ち続ける旧条件が45回継続した。診断用server停止判定も
Windowsの`exitCode === null`と実際の`close`を取り違えたため、同じ診断で修正。
これらは準備診断であり、本体試行ではない。診断DBのsession/message/credentialは0。

外側の保存Worker `ses_ef94edc91ffeNmX7JHuXzBE7cz`はserver再起動中に停止。
同じWorkerの再開が`operator-unit-not-authorized`で拒否された履歴を保持。
root/hostでnative failed・`process-defect`を確定した後、このCoordinatorが
直接継続した。拒否routeへの再派遣、累計ledgerのresetはしていない。

固定条件：

- package **0.13.6**、marker `0.13.6-acceptance-reuse-v1`。
- 同じtgz SHA-256：
  `1bf29e9bbfee1f5379914fe72279b2bfe2aceedb039d52a98b916981a197c5eb`。
- task：`datacurve/anko-typed-variable-bindings`。
  原文 **1,825 bytes**、SHA-256
  `96c0c7ad98237d6176034c8893d8bff164ec5fda45889e51780a65cf599ffcfe`。
  request末尾も同じ原文bytesを保持。
- base：`3f269a72ff69398b1250c584171f32d12c0d8085`。
  作成済みlocal `main`と`bench/anko-v0136`を再利用。
  mirrorの新しい`master` tipへは移動していない。
- CLI/client **2.0.18**。Windows Node **22.14.0** / npm **10.9.2**。
  WSL Node **22.22.3** / npm **10.9.8** / git **2.43.0**。
  Go **1.27.1**、既存の383 stdlib packages確認を再利用。
- 全SOL役：`openai/gpt-6.1-sol#xhigh`。
  Luna Worker：`openai/gpt-6-luna-fast#max`。
- 最新の有効なv0.13.4 recovery条件から**1回・60分・$15 token価格推定cutoff・grading none**を継承。
  旧v0.13.4の停止trialは再開・延長していない。
- 実行runnerのrepository revision：`4b628d99c0f878154a4d430750b151ea274298e3`。
  継続runner SHA-256：
  `095faa6d1c979fec5b3f8061fc6d4098fc7d8b6aa60ea8cdaae81326db6d4d91`。
  packageのhashとrunnerのhash/revisionは別のidentity。

clone、成功済みisolated npm install、Goを再利用。
global適用、製品の全体検証、release/publication、PR/pushは追加していない。
旧runner・lock・receipt・package・原文・元log・credential-free DBは保持。
`frozen-inputs.json`の39ファイルで実行前後の同一性を照合する。

## 時間・費用・停滞の実測

### 本体

native foreground command：

```text
node _testenv/anko-v0136-20261004/arm-continuation/run.mjs
```

- native shell：2026-10-04 **23:39:43.887Z** → 2026-10-05 **00:39:56.869Z**。
  **3,612,982 ms、exit 0**。
- runner自身のsetup・本体・記録保存を含む区間：**3,606,037 ms**。
  native shell区間とは別の時計。
- 本体開始：**23:39:46.529Z**。本体経過：**3,600,134 ms**。
- exit 0はdriverが上限処理と記録保存まで到達した状態。
  課題完遂、公式score、受理の成功ではない。

観測token価格推定：**$0.07269480**。7 priced assistant message records、
unpriced 0、使用量欠測の未完了message 1。欠測分を0費用とは扱わない。

- SOL：4 records、**$0.06839480**。
  input 20,862 / output 1,869 / reasoning 272 / cache-read 52,608。
- Luna：4 recordsのうち3 priced、**$0.00430000**。
  input 14,297 / output 650 / reasoning 381 / cache-read 20,480。
  1 recordは未完了・usage欠測。
- 実messageのmodelは指定したSOL/Luna route。
  `providerState.serviceTier`の観測は両方`default`。
  alias設定の`priority`と実responseのtierを同一視しない。
- native message record数はprovider request数を保証しない。
  この推定は実請求ではなく、actual invoiceは不明。

Workerは`AGENTS.md`がclone内にないことを確認し、shell経由で祖先の同ファイルを
既に取得。その後のnative `read`が
`M:\_work\Sortie-dogs-acceptance-reuse\AGENTS.md`で停滞した。

- read開始 **23:41:41.131Z**、interruptによる終了 **00:39:46.667Z**。
- ran-to-completed **3,485,536 ms（58m05.536s）**、queue **63 ms**。
- 最終tool状態：`error` / `aborted` / `Tool execution interrupted`。
- 全12 tool callsの重複を統合した実行区間：**3,487,574 ms**。
  ほぼ全部が上記readであり、CPU作業や有益なファイル処理時間ではない。

assistant created-to-streamed proxyの合算はSOL **83,112 ms**、Luna **34,759 ms**。
streamed-to-completedはSOL **703 ms**、Luna **2,092 ms**で、Lunaに1区間欠測。
proxyにはmodel推論、応答待ち、schedulerなどが混在し、純粋な通信待ちの内訳は不明。
並行区間を含むためtool/modelの合計を本体wall timeの分解とは扱わない。
停滞場所はnative read区間と特定できるが、その内部原因、権限待ち、provider障害は
この履歴だけでは断定できない。server stderrは空で、logにpermission/errorの
対応する説明は見つからなかった。

RootがWorkerを`background: true`で派遣した事実を保存。
本体observerはRoot終了後もowned Workerを上限まで追跡した。
回復promptは0。Workerがactiveのままなので、元promptを再送していない。
Review・受理の時間区間は到達しておらず、0秒成功ではなく**未実施**。

### 準備・外側調整・結果収集（本体と別）

- 既存の準備Worker：**3,991,774 ms、172 priced records、$0.86967720**。
  265 tool calls、完了toolの重複統合区間 **145,133 ms**。
  これは今回の本体60分へ加算しない。
- 既存準備Coordinator、上記Worker、現在のCoordinator、再起動中断Workerの
  4 native sessionを累計観測。既存Worker費用を重複加算しない。
- 起動前checkpoint：**$2.90704456**。
- 結果収集checkpoint：**$3.19994376**。
  起動後の外側調整・収集増分 **$0.29289920**。
  checkpoint以後の応答、root-parent調整、欠測usageは未算入。
  最終request総額や実請求ではない。
- 起動前checkpointにusage欠測4 records。
  外側Coordinatorのstreamed-to-completedには長いtool待ち・再起動区間が含まれ、
  active推論時間としては集計できない。
- 最初の関連Coordinator作成から本体開始までの暦上区間は
  **49,953,799 ms（13h52m33.799s）**。
  子処理との重複、user idle、server再起動を含むため累計active準備時間ではない。
  既存の66m31.774sと足し算して水増ししない。

## 保存結果との比較

- v0.13.2保存比較：本体 **2,425,698 ms**、推定 **$1.23370664**、
  3 sessions、2 candidate commits。`descendant_records_unavailable`で未受理。
- v0.13.4初回：Root応答 **42,171 ms**で終了したがWorker/Missionは未完了。
  commit、Review、receiptなし。短いRoot応答をベンチ速度とは扱わない。
- v0.13.4最新recovery：累計 **3,630,051 ms**、推定 **$8.09623984**、
  256 priced records、usage欠測4、Review `findings`、受理receiptなし。
  元の時間消費・30,051 ms超過・途中SOL model変更も保持。
- 今回：本体 **3,600,134 ms**、観測推定 **$0.07269480**、
  native read停滞、変更0、Review/receiptなし。
  低い観測費用は実装が進まなかった結果で、効率向上や節約を示さない。

### 自律性・効率・可視性・品質

- **自律性**：準備のID照合とWindows診断停止判定を要求内で直接修復。
  既存環境を再利用し、独自承認や製品修正を追加せず起動に到達した。
  一方、本体の実装・再修正・受理までの自律性は未達。
- **効率**：準備の不要な再インストール・別Worker調査を増やさなかった。
  ただし、本体58分超をnative read待ちで消費。重複したAGENTS取得とread停滞の
  早期可視化が次の改善対象。未適用の改善効果や削減額は計算しない。
- **可視性**：準備失敗、catalogue alias、Root応答、背景派遣、owned Worker、
  tool停滞、cap、欠測費用、Review、受理を分離して保存できた。
  Root終了に追従して早期成功報告する誤りは避けた。
  このobserverの改善をpackage単独の改善とは主張しない。
- **品質**：今回のAnko実装はない。local validation、独立Review、公式grading、
  commit、受理を通ったという主張はできない。

同じtask/baseでもrunner修復、完全なSOL 6.1使用、以前のrecovery範囲が異なる。
package単独の高速化・因果効果・品質成功・実請求は推定しない。
本体の単一試行と時間上限は消費済み。再実行や実装継続を自動追加しない。

## 記録と結果検証

- 現地記録：`_testenv/anko-v0136-20261004/arm-continuation/`。
- 永続記録：
  `M:/_work/_Sortie-dogs-artifacts/records/anko-v0136-20261004/arm-continuation/`。
- runner/hash、native command observation、request bytes、model discovery、
  価格/token、progress、native history、Mission/operator、元log、source/Git、
  credential-free DBとsnapshot、準備累計、tool時系列を保存。
- 生log/dataset/DBはGitへ入れていない。共有設定・既存未commit変更は保持。
- `node _testenv/anko-v0136-20261004/arm-continuation/verify.mjs`は
  条件・旧保存物不変・原文bytes・モデル・資格情報除去・保存copy・結果との一致を検証。
  **記録整合性PASSはベンチ完遂・Review PASS・受理receiptではない**。

結果検証のnative exit・所要時間は同じMissionの正式証跡に記録する。
