# 帰還報告 / 作戦卓

## 採用範囲

B案「作戦卓」を本体に、A案の短い見出し・細い区切り・余白を採用する。
結果、今回の作戦称号、条件達成型記章、MISSION、COST / PACK、PACK RECORD、NEXTの順。
既存の折畳み、モデル内訳、費用ゲージ、計測範囲、unknownを保持する。
文字送り、音、点滅、常時演出や追加モデル呼出しは導入しない。
狭い画面での厳密な桁揃えは要求せず、巨大なASCII枠や横長の表を避ける。
正式完了時だけ小さな欄外文を置き、未完了・警告には混ぜない。

通常応答は開始⚑、発見◎、補足✎、障害[!]など意味に対応する短い見出しを使う。
↩は復帰を観測した後だけ。コード・機械状態・失敗理由を装飾で言い換えない。

## 称号と根拠

表示名は既存の観測特性から選ぶ。新しい成果カウンタや保存形式は追加しない。
原則ひとつの作戦称号を、復帰→一発完遂→連携の優先順で表示する。

- 立て直し屋：既存「修正から復帰」。同じ子セッションで対象検証失敗→変更→同じ検証成功、正式完了。
- 一発完遂：既存の完全な対象履歴・ledger照合による厳密判定。正式完了が前提。
- 連携上手：既存「連携作戦」。異なる子セッションの稼働区間重複。成功や因果的協働の証明ではない。
- 静かな一撃：一発完遂の特別記章名。同じ実績の別名であり、二重加算しない。
- 不屈の連携：同じ任務で修正復帰と稼働区間重複を観測した組合せ。追加実績として加算しない。

記章は抽選でなく条件達成型。「レア枠」は設計上の区分であり、測定した出現率・希少率を意味しない。
PACKの任務完遂の隊・連携の隊・復帰の隊・一発完遂の隊は累積戦歴欄へ分離する。
対象件数・eligible件数・未終端記録・取得履歴の範囲を残し、未観測を該当なしへ変換しない。

### 構想を保持する候補（まだ授与しない）

- 早打ち：品質を維持した迅速遂行。比較可能な作業規模・待機除外・品質条件の定義が未確立。
- 手際良し：不要な重複・手戻りを抑制。既存skipや再試行だけでは不要性の根拠にならず、対象範囲の定義が必要。
- 堅実派：必要な確認を過不足なく実施。検証数の多さで授与せず、要求に対する充足と過剰性の定義が必要。
- 全員帰投：派遣担当すべての終端・回収確認。対象担当と正常回収の集計定義が必要。
- 電光石火：比較可能な条件での迅速完遂。比較基準・品質条件・計測範囲が未確立。

測定不足は候補削除の理由ではない。条件確立前に恣意的な閾値で授与しない。
称号獲得を目的とした不要検証・危険操作・高額支出・並行派遣はしない。
称号・外部助言は実行権限、正式検証、Review PASS、Acceptanceを代替しない。

## 全体作業量の配送断点

元PR：[#230](https://github.com/zufall-upon/Sortie-dogs/pull/230)。
要求全体の作業量概算であり、時間・費用・予算消費・完了unit比率ではない。
見積更新で低下し得る。正式完了前は99以下、正式完了のみ100。
純粋なformatterを `%` 表記へ変更するが、それ自体は配送不具合の解消ではない。

2026-10-29、共有hostを変更せずOpenCode 2.2.0の実物を確認した。

1. 同じMissionのplan/status返却に `work_quantity` と `work_quantity_display` が存在。
2. `v2.ts` はsubagentの `execution.progress` に `metadata.description` と `sortie_progress` を配送し、完了metadataにも保持する。
3. Desktop 2.2.0の `app.asar` 内 `route-1vx1MaOx.js` のsubagent rendererは、表示文を `input.description || sessionID` から取得する。`metadata.description` と `sortie_progress` は読まず、詳細も非表示。
4. 同じMission `mission-a212fd38-4a54-427e-979f-eb542468c5e9` のroot message API保存を確認。Coordinator call `call_8f93338bc55e4219a6c71844f2e0f262` は `background:true`、native tool stateは即時 `completed`、metadataの子状態は `running`、作業量は開始時の `0/100`。一方、同Missionのplan返却は38/100（見積更新）まで進んだ。`v2.ts` のobserverはnative execute返却時のfinallyで解除されるため、background実行の生涯を追わない。UI非購読に加え、配送更新にも断点がある。
5. 従ってmetadataの保存成功とTaskカード表示成功は同義でない。現時点で動的Task字幕の修復は未完。背景Taskへ非公開の永続更新を後付けしない。
6. DirectにはTaskがない場合がある。偽Taskを作らず、既存tool返却値を次の有用な通常応答へ転記する静的指示をOperator/Coordinatorへ追加する。動的progressをsystem/continuationへ注入せず、表示専用呼出し・モデルturnは追加しない。

正式APIの同host `/openapi.json` ではmessageはget/listのみ。
`session.synthetic` はInboxへの合成入力の受理で、assistant最終本文の更新APIではない。
`resume:false` を付けても最終本文配送の保証とは扱わない。DB・履歴・streamを直接改変しない。
現GUI pluginの読込はglobal設定に依存するため、今回のglobal非変更条件下で新GUI基盤を導入しない。

必要な実確認は、同じ実行の返却値→通常assistant本文→message get/listによる保存→Desktop表示の対応付け。
候補adapterを正規に読込んだ隔離環境でDirectとTaskを区別し、少なくとも2つの異なる値の到達を確認する。
mock callbackテスト、formatterテスト、ここに記載したsource確認だけを実画面成功としない。

## 帰還パネルの配送

正式receiptとhost生成 `return_report` が正本。モデルには逐語で一度だけ最終本文へ添付させる。
V2 finalizerはaccounting-onlyで、後から本文を永続化するものではない。
今回、正常経路での最終本文・保存・実画面までの到達は未検証。
既存のcontext保持と逐語指示は維持するが、指示追加だけを配送保証とは呼ばない。

## 相談と採否

既存ChatGPT会話 `6ae2a3d0-23cc-83ee-a1f8-a0ab2e629bb1` の前回助言から、B本体＋A整列＋節目だけの遊び心、称号/記章/累積の分離を採用。利用者の続行承認済み。
停止中の↩表示は不採用。復帰済みとの誤読を避けるため、障害[!]と復帰↩を分ける。

今回のnative Advisor相談はTaskカード断点・API制約・禁止事項を提示して独立評価を取得。
「既存返却値→通常本文を優先、Task字幕更新は正規購読/更新APIなしでは未成立、保存とDesktop到達を別記録」の助言を採用。
理由：追加モデル呼出し・偽Task・履歴編集を増やさずDirectにも適用できるため。
効果：静的案内と回帰テストの範囲のみ。実表示効果は未検証。これはChatGPT相談や独立SourceReviewの代替ではない。

本Coordinatorのbrowserは `browser.disconnected`。再試行・再送せず、rootの接続済み窓口で具体candidateと観測を既存ChatGPT会話へ戻す作業を残す。

## 元PRレビュー回収

#230の本文・通常コメント・review本文・行コメントを回収。
通常コメントとreview本文は自動レビュー案内で、別の未解決修正要求はなかった。
行コメント3件はいずれも有効だが、既存 #249 / v0.13.20で修復済みという作者の対応記録あり：

- global workload cache解放：terminal保持・session削除・dispose時の解放と回帰。
- checkpoint細分化での誤継承：matching alias単位での保持と両path方向・command回帰。
- continuationへの動的進捗混入：`missionPacket(mission, run, false)` とbyte不変回帰。

今回この3件を再実装しない。元PRの修復記録を保持し、現候補の進捗表現変更と混同しない。
新PRの既存本文・通常/行レビューも統合前に別途回収・分類する。

## この候補の検証

- `npm run test:targeted -- test/sortie-debrief.test.ts test/sortie-career.test.ts test/run-metrics.test.ts test/work-quantity.test.ts test/v2-plugin.test.ts test/mission-direct-execution.test.ts test/mission-fast-first.test.ts test/runtime-assets.test.ts`：exit 0、264 PASS / 2 skip。build 9.205秒、test 50.580秒。
- `npm run test:targeted -- --test-name-pattern='recorded native validation can be reconciled without rerun only for the same protected source' test/v010-runtime.test.ts`：exit 0、1 PASS。build 9.027秒、test 0.384秒。検索で見つかった公開callerの帰還報告見出しassertionを、新デザインに合わせて確認。
- `git diff --check`：exit 0。

全体suite、Windows専用検証、release検証、SWE評価は今回未実施。
これらのテストは実Desktop表示・ChatGPT相談・正式最終配送の成功を意味しない。
実装者はCoordinator `openai/gpt-6.1-sol`。実装Workerの新規派遣なし、Gemma使用なし。
既存区間のhost実装計上は$0.2847668を継承。今回区間・Reviewer・外部相談を含む総額はこの時点でunknown。
