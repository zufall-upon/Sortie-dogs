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
- 静かな一撃：既存「一発完遂」の作戦称号。完全な対象履歴・ledger照合による厳密判定、正式完了が前提。同じ実績の別名記章を重ねて表示・加算しない。
- 連携上手：正式完了と既存「連携作戦」。異なる子セッションの稼働区間重複であり、因果的協働の証明ではない。未完了時は称号を授与せず、稼働区間重複の観測特性のみ残す。
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
初回候補では正常経路の到達は未検証だった。後述の通常Missionで最終本文と保存までを確認し、実UIはroot確認を残す。
既存のcontext保持と逐語指示は維持するが、指示追加だけを配送保証とは呼ばない。

## 相談と採否

既存ChatGPT会話 `6ae2a3d0-23cc-83ee-a1f8-a0ab2e629bb1` の前回助言から、B本体＋A整列＋節目だけの遊び心、称号/記章/累積の分離を採用。利用者の続行承認済み。
停止中の↩表示は不採用。復帰済みとの誤読を避けるため、障害[!]と復帰↩を分ける。

今回のnative Advisor相談はTaskカード断点・API制約・禁止事項を提示して独立評価を取得。
「既存返却値→通常本文を優先、Task字幕更新は正規購読/更新APIなしでは未成立、保存とDesktop到達を別記録」の助言を採用。
理由：追加モデル呼出し・偽Task・履歴編集を増やさずDirectにも適用できるため。
効果：静的案内と回帰テストの範囲のみ。実表示効果は未検証。これはChatGPT相談や独立SourceReviewの代替ではない。

本Coordinatorのbrowserは `browser.disconnected`。再試行・再送せず、rootの接続済み窓口へ具体candidate相談を引き継いだ（下記のとおり相談完了）。

2026-10-29追記：rootが既存会話へPR #311の具体source・観測・制約・未達を送信し、回答「Sortie-dogs PR #311 — 独立評価と残作業の推奨」を全文回収した。
採用：一発完遂の三重表示を「静かな一撃 — 一発完遂」に集約、未完了の連携称号を未授与へ変更、詳細根拠はCOST/PACK/戦歴の後へ移動。
理由：同一事実の報酬重複と未完了の成功誤読を避け、MISSIONを先に読めるようにする。カウンタと正式根拠は変えない。
将来称号を恣意的に授与せず構想保持する案も採用。通常本文を正式な進捗経路として実証し、リアルタイムTask字幕の修復や自動補完保証とは区別する。
この小補正は関連46件PASS（build 8.925秒、test 0.240秒）。実表示効果は別途確認が必要。
rootは正規pair済みOpenCode WebUIから実本文を閲覧可能になった。候補の正規読込・同一Mission保存確認後、rootが実UIを確認する。スクリーンショット取得は未成立であり成功と扱わない。

## 正規候補の通常Mission実行（保存まで確認）

`scripts/return-report-ui-run.mjs` はprepare/run/collect/verifyを共有するrunner。
runはlaunch.jsonが存在すれば新規起動を拒否し、既存結果はcollectで収集する。
既存serviceを利用し、isolated projectのlocal pluginだけを正規読込。global設定・共有hostの起動/再起動・差替えはしない。
collectorの修正は再収集のみで確認し、実Missionを再起動していない。

- 候補runtime source：`e7b5fd51bbb15b1542fc96eac734661d3d481be1`。
- 固定local package SHA-256：`4c1a6f2ec7e6811505a012b300fa35cdc1ff426e02e0a2f8cc0d7fed9de94eae`。公開済み同versionの成果物ではなく、今回だけのlocal candidate。
- host：OpenCode 2.2.0、既存pid 2101816、`http://127.0.0.1:4096`。
- local loaded adapter SHA-256：`74cfa9db283594da18cee05eca88dd31d171cfa0162c054ec57e5fe757c4d24c`（adapter本体は今回無変更）。
- local module SHA-256：sortie-debrief `a27d250a21c71003c8f6a1c97f3252440aeb7d77bb3d529fa5c84f6d82763d55`、run-metrics `2d1f02e9aa876cf7edac71b089e797a94f3e9cb48c140c0656274b25ee6f6861`。setup/observerに読込locationとhashを保存。実パネルも補正後の表示を含む。
- run command：`node scripts/return-report-ui-run.mjs run _testenv/return-report-live/run-1`、exit 0。timeout/cost停止なし。
- root session：`ses_e7836423bffeVnKlsx1CqqpK4A`、Operator実モデル `openai/gpt-6.1-sol#xhigh`。
- child session：`ses_e7835ef6dffeTLqzwTbbUW667g`、Coordinator直実行、実モデル `openai/gpt-6.1-sol#default`。実装Workerの新規派遣なし。
- Mission：`mission-ca7bfecf-9a79-4a6e-8b47-ef98dfc27c4b`。実際の観測inputから `delivery-observation.md` を作り、既存 `node verify.mjs` がPASS。架空ledgerや手書きassistant出力は使っていない。
- 正式receiptの任務時間：2026-10-29T13:11:48.294Z〜13:13:09.947Z（81.653秒）。最終応答生成・収集時間とは別。
- 全native assistant usageの換算観測：$0.2297492、未換算0件。host費用0計上は無料を意味しない。最終パネルは最終応答前の$0.2027であり、collectorの全履歴額と置き換えない。外部相談を含む全費用はunknown。

### 同じ実行の進捗対応

hostの `work_quantity_display` → その後の通常assistant textへの逐語転記を、API保存履歴で照合。

- root：0% `call_f256aea33203404b934b76005d58dfbd` → `msg_187ca10df001fQAzQvR3khNcfz`。
- Coordinator：61% `call_d4fdd0ed67044b36a41f3a607d73c171` → `msg_187ca7bf1001aIpbrZNMx3MyEV`。
- Coordinator：78% `call_53bb0add506f45dc837afe655553d117` → `msg_187ca947d001D6EQ6v48ojZKru`。
- Coordinator：92% `call_54651bc9aa144ffd843f3c5a4739a5a9` → `msg_187cab042001w60fwWkA0Dbtqz`。
- root正式完了：100% `call_525426954db54c0b9ac845a75a3996de` → `msg_187cafecc0010Cf3xBf44FoS03`。

これらは実行中に算出された全体作業量。今回の文書化入力にある過去の0%→38%とは別の値であり、混同しない。
rootの背景Task字幕自体は未修復。中間値はCoordinatorの通常本文に保存されており、そのsessionの正規UIで確認する。
追加の進捗専用turn・model callなし。Directには偽Taskを作っていない。

### 正式帰還の対応

rootの `complete_mission` call `call_525426954db54c0b9ac845a75a3996de`、message `msg_187caedd2001K1D2j0VCUjHpnu` が正式receipt succeededとhost `return_report` を返した。
その同じpanel bytesが最終assistant message `msg_187cafecc0010Cf3xBf44FoS03` に1回だけ存在することをverifyで確認。
外側のコードフェンスで全panelを包まず、通常のdetailsと内部text fenceを保持。
モデルの前文「候補表示確認済み」は実UI証拠ではない。collectorは明示的に `ui_verified:false` とし、rootの実UI確認を残す。
一般的な転記漏れの自動補完保証や、ネイティブDesktop画像取得に成功したという意味ではない。

証拠：`_testenv/return-report-live/run-1/{setup,launch,terminal,observation,native-history}.json`、`native-observer.jsonl`、`final.md`。
package・ログ・usageを保持。projectのlocal `.opencode`/node_modulesはroot実UI確認用にまだ必要なので、不要とみなして削除しない。

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
