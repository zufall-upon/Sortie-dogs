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
初回相談時点の効果は静的案内と回帰テストの範囲のみだった。後述の通常Missionとroot実WebUI照合で本文配送を確認。これは独立SourceReviewの代替ではない。

本Coordinatorのbrowserは `browser.disconnected`。再試行・再送せず、rootの接続済み窓口へ具体candidate相談を引き継いだ（下記のとおり相談完了）。

2026-10-29追記：rootが既存会話へPR #311の具体source・観測・制約・未達を送信し、回答「Sortie-dogs PR #311 — 独立評価と残作業の推奨」を全文回収した。
採用：一発完遂の三重表示を「静かな一撃 — 一発完遂」に集約、未完了の連携称号を未授与へ変更、詳細根拠はCOST/PACK/戦歴の後へ移動。
理由：同一事実の報酬重複と未完了の成功誤読を避け、MISSIONを先に読めるようにする。カウンタと正式根拠は変えない。
将来称号を恣意的に授与せず構想保持する案も採用。通常本文を正式な進捗経路として実証し、リアルタイムTask字幕の修復や自動補完保証とは区別する。
この小補正は関連46件PASS（build 8.925秒、test 0.240秒）。実表示効果は別途確認が必要。
rootは正規pair済みOpenCode WebUIから実本文を閲覧可能になり、候補の正規読込・同一Mission保存確認後に下記の実UI照合を完了した。スクリーンショット取得は未成立であり成功と扱わない。

## 正規候補の通常Mission実行（保存・root実WebUI照合）

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
rootの背景Task字幕自体は未修復。中間値はCoordinatorの通常本文に保存されており、rootがそのsessionの正規UIで確認した。
追加の進捗専用turn・model callなし。Directには偽Taskを作っていない。

### 正式帰還の対応

rootの `complete_mission` call `call_525426954db54c0b9ac845a75a3996de`、message `msg_187caedd2001K1D2j0VCUjHpnu` が正式receipt succeededとhost `return_report` を返した。
その同じpanel bytesが最終assistant message `msg_187cafecc0010Cf3xBf44FoS03` に1回だけ存在することをverifyで確認。
外側のコードフェンスで全panelを包まず、通常のdetailsと内部text fenceを保持。
モデルの前文「候補表示確認済み」は実UI証拠ではない。collectorの `ui_verified:false` は収集時点の保存確認範囲を正確に表すため変更しない。後続rootの実UI確認は下記へ別記録する。
一般的な転記漏れの自動補完保証や、ネイティブDesktop画像取得に成功したという意味ではない。

証拠：`_testenv/return-report-live/run-1/{setup,launch,terminal,observation,native-history}.json`、`native-observer.jsonl`、`final.md`。
package・ログ・usageを保持。projectのlocal `.opencode`/node_modulesは後続の最終照合終了まで保持し、非稼働・不要と確定する前に削除しない。

### 後続rootによる正規WebUI照合

2026-10-29、rootが正規pair済みOpenCode WebUIで同じ候補sessionを直接開き、以下を確認した（Coordinatorへ観測結果を引継ぎ）。

- Coordinator `ses_e7835ef6dffeTLqzwTbbUW667g` の通常本文に61%・78%・92%を実render。上記のhost返却値・保存messageと同じMissionの値であり、過去入力0%→38%ではない。
- root `ses_e7836423bffeVnKlsx1CqqpK4A` の正式完了100%と帰還パネルを実render。detailsは1個、展開して作戦卓・COST・費用ゲージ・PACK累積戦歴・unknown・根拠後段・NEXTを確認。
- パネルのpre幅696、fontはIBM Plex Mono。巨大ASCII枠・文字送り・常時演出は追加されていない。
- これは正規WebUIのDOM/render確認。スクリーンショットはvisible制約で取得できておらず、native Desktop frameや画像capture成功とは扱わない。元添付画像のroot直接確認と、この候補の実render確認は区別する。

これにより、通常応答経路の進捗到達・更新、および正常完了時のhostパネル配送を保存→実画面まで確認した。
Task字幕リアルタイム更新の未修復、モデル転記漏れの一般的自動補完保証なし、未来称号の条件未確立という留保は変えない。
runtime・固定package・実行済みMissionは変更/再起動していない。`e7b5fd5..8e765a4` の差分はdocsとcollectorのみで、今回も文書追記だけ。既存の46 PASS、先行264 PASS / 2 skip、公開caller1 PASS、実行1回exit 0 / 98.824秒を再利用する。
文書追記後は保存済み結果のverifyとdiff checkのみを行い、無変更のruntimeテストや実Missionを再実行しない。

## 元PRレビュー回収

#230の本文・通常コメント・review本文・行コメントを回収。
通常コメントとreview本文は自動レビュー案内で、別の未解決修正要求はなかった。
行コメント3件はいずれも有効だが、既存 #249 / v0.13.20で修復済みという作者の対応記録あり：

- global workload cache解放：terminal保持・session削除・dispose時の解放と回帰。
- checkpoint細分化での誤継承：matching alias単位での保持と両path方向・command回帰。
- continuationへの動的進捗混入：`missionPacket(mission, run, false)` とbyte不変回帰。

今回この3件を再実装しない。元PRの修復記録を保持し、現候補の進捗表現変更と混同しない。
PR #311の現本文・通常コメント2件・review本文0件・行コメント0件を回収。本文の実UI未確認/Draft継続記述は今回の観測に合わせて更新する。通常2件は作者自身の過去段階の状況記録であり、新たな修正要求ではない。有効な追加指摘なし。既存独立ReviewのEVIDENCE_GAPS/Major・Mediumなしと作者再確認・低risk skipは保持し、独立PASSへ読み替えない。

## この候補の検証

- `npm run test:targeted -- test/sortie-debrief.test.ts test/sortie-career.test.ts test/run-metrics.test.ts test/work-quantity.test.ts test/v2-plugin.test.ts test/mission-direct-execution.test.ts test/mission-fast-first.test.ts test/runtime-assets.test.ts`：exit 0、264 PASS / 2 skip。build 9.205秒、test 50.580秒。
- `npm run test:targeted -- --test-name-pattern='recorded native validation can be reconciled without rerun only for the same protected source' test/v010-runtime.test.ts`：exit 0、1 PASS。build 9.027秒、test 0.384秒。検索で見つかった公開callerの帰還報告見出しassertionを、新デザインに合わせて確認。
- `git diff --check`：exit 0。

全体suite、Windows専用検証、release検証、SWE評価は今回未実施。
これらのテストは実Desktop表示・ChatGPT相談・正式最終配送の成功を意味しない。
実装者はCoordinator `openai/gpt-6.1-sol`。実装Workerの新規派遣なし、Gemma使用なし。
既存区間のhost実装計上は$0.2847668を継承。今回区間・Reviewer・外部相談を含む総額はこの時点でunknown。

## 追加仕様：条件型の特別記章と言語

既存ChatGPT相談「Sortie-dogs PR #311 — レア称号機構の独立設計評価」の採否を継承する。
条件型Aを採用。B（節目）とC（品質）は、今回の観測から再現可能な根拠を確立できず保留。
新規相談・獲得実験・常時モデル判定は追加しない。

- `rare.clean-sweep` / rule_version 1：静かな一撃 / Quiet Strike。
  既存の厳密な一発完遂を特別区分へ再分類。別名の追加実績ではなく、通常作戦称号と二重表示しない。
  完全な正式終端一致履歴・対象検証PASS・再試行/再計画/検証失敗なしが必要。
- `rare.recovery-coordination` / rule_version 1：不屈の連携 / Unbroken Formation。
  同じ子で対象検証失敗→変更→同じ検証成功、任務成功、異なる子の正の稼働重複。
  重複は観測事実であり、因果的な協働成果の証明ではない。
- 各条件は true / false / unknown。ANDでは確認済みfalseがunknownに優先する。
  不足情報を非該当としない。未完了・正式成功なしは授与しない。出現率は未計測。
- 既存GoalReportのoptional `rare` に安定ID・rule_version・状態・根拠コードを保存。
  `terminal_key` は正式receiptのfingerprint。初回保存を両公開配送経路が再利用し、表示言語や再計測で再授与しない。
  保存済み作戦特性も再表示時に復元する。費用は従来どおり表示時の観測範囲を明示する。
- PACKは保持された同goalの現在の正式成功終端だけ、記章別に各1件。記章間を合算しない。
  再開中の旧獲得は除外。旧未判定・報告なし・未知definition/ruleは別扱いし、現在の獲得に変換しない。
  旧履歴を翻訳名から再解釈したり、履歴を追加書換えしたりしない。

### 製品の表示言語

既存sourceには製品locale設定・翻訳辞書がなく、モデル向けの「利用者の言語で応答」指示だけだった。
今回の帰還パネルに限定して `SORTIE_REPORT_LOCALE` を追加する。
`ja` / `ja-JP` / `ja_JP` は日本語、`en`等は英語。未指定・空は既存互換の日本語、未対応の明示指定は英語fallback。
プロセス環境を**各配送時**に読む。plugin生成時の値に固定しない。
直接renderer APIでは `formatSortieResult(result, { locale: "en" })`、
`insertSortieResult(text, result, review, gaps, "en")` で環境値より優先できる。

対象は帰還報告・作戦称号・記章・条件/根拠/状態・PACK注記・費用/計測範囲。
ID・判定・rule_version・receipt・保存schema・獲得件数は言語共通。
利用者/モデルが書いた実装説明・レビュー注記・次操作・モデルIDは翻訳せず保持する。
従って日本語で書かれた説明を英語パネルへ渡せば、その説明自体は日本語のまま。
開発相談の日本語と製品localeを混同せず、未対応の製品全体・他言語まで翻訳済みとはしない。

`test/run-metrics.test.ts` の `rare saved receipt snapshots and bilingual renderer…` は同じ合成根拠で日英を切り替え、
`_testenv/pr311-rare-i18n/{earned,combination,not-applicable,unknown,future,legacy}.{ja,en}.{md,html}` を保存する。
mdは実際のtext renderer出力、htmlはその本文をpreに包む比較用fixture。実Missionの獲得や正規WebUIの実表示証拠ではない。
今回Workerのbrowserはdisconnectedで、スクリーンショット・DOM観測は未実施。過去候補の実UI結果を今回の記章/多言語表示へ流用しない。
独立Reviewは親の後続工程。作者テストや自己確認を独立PASSに読み替えない。

### 独立調査で見つかった多言語配送の補正

`98be72c` の独立read-only調査で、次の有効指摘を記録してから同じReviewerが修正した。
調査・修正モデルは `openai/gpt-6.1-sol`。修正後の確認は著者のSELF_RECHECKEDであり、独立PASSではない。

- Major：パネル抽出が日本語見出し限定。英語rendererの出力が通常V2完了tool resultの
  `return_report` に載らない。日英共通のパネル識別を完了caller・履歴投影・表示済み判定で使用する。
- Medium：再表示の説明抽出が旧hostカードを読み、以前のlocaleの「未取得」等を本文として保持していた。
  最上位の元本文のみを参照する。code/disclosure内の例は説明に流用せず、利用者由来の文章は言語を変えず保持する。
- Medium：tool-result完了callerのhost生成NEXT・補足既定文が日本語固定。
  各配送時のreport localeで生成する。単位titleや実レビュー本文は翻訳しない。

既存の公開tool-result完了テストを拡張し、同じ正式receiptを日本語→英語で再表示しても
パネル・配送指示が存在し、英語のNEXTになり、`goal.reported` を追加しないことを確認する。
V2の既存履歴投影テストも日英で共用し、通常requestと現在turnのcard保持、過去turnのcompaction投影、
保存履歴非変更を同じoracleで検証する。判定条件・保存schema・実績ID・費用計測・進捗％は変更しない。

- 修正前の限定回帰：4件中日本語V2投影1 PASS、再表示・公開英語完了・英語V2投影の3件FAIL、exit 1。
- 修正後の同じ限定回帰：4 PASS、exit 0。build 9.170秒、test 1.124秒。
  command：`PATH=/home/user/.local/bin:$PATH npm run test:targeted -- --test-name-pattern='report locale redisplay|V2 final request retains|root discards one exact diagnosed transient' test/run-metrics.test.ts test/v2-plugin.test.ts test/v010-runtime.test.ts`。

上記は既存test harnessの合成公開caller回帰。新しい実Mission・正規UI表示・獲得実績ではない。
先行の実UI・実費用記録は元候補の観測として保持し、今回へ読み替えない。
PR #311の再回収時点のbaseは `6a0a5764500884155e24ff06416e1aac86f51d8d`、review本文0。
通常コメントのCodex failed/usage limitは外部review未完のまま、技術指摘やPASSには変換しない。

### 狭幅表示の局所補正（2026-10-30）

rootが候補 `f87af45` の合成earned日英出力を正規OpenCode WebUIへ通常本文として提示し、
detailsを展開して実測した。viewport 634×843、pre幅598/client596、IBM Plex Mono、
white-space: pre、scrollWidthは日本語1041・英語1639。表示到達は確認したが、狭幅の可読性は不合格。
画像は折畳み状態の取得のみで、展開画像確認済みとはしない。

既存Advisor `ses_e75acf76dffeQ8bkB0nM2fFqv0` は、この観測だけを材料にA案
（details内を通常Markdownの縦並び＋短い等幅装飾）を推奨した。
助言者はsource未読・SourceReview/正式検証未実施という留保付き。A案を採用し、
B案（pre維持＋手動改行）は日本語幅・長IDで再溢れしやすく保守範囲が増えるため不採用。
助言をReview PASSやAcceptanceには読み替えない。

実装者 `openai/gpt-6.1-sol` がsourceで確認した共有点は `formatSortieResult`。
公開V2/tool-resultのパネル抽出と履歴投影はdetails/summary識別であり、本文のfenceに依存しない。
共通rendererだけを折返し可能な段落へ変更し、固定の短いTACTICAL DESK装飾のみinline codeとする。
費用・モデル別ゲージ・PACK・unknown・範囲・根拠・未完了注記は省略しない。
保存schema・判定・receipt・locale解決・数値・進捗配送の機構は変更しない。

利用者由来本文はHTML/Markdown構文文字を文字参照へ変換し、表示時の文字を保持する。
モデルIDの記号削除・120文字切捨てを廃止。長いASCIIトークンは24文字ごとの
`<wbr>`でレイアウト上の改行候補を追加し、ID自体へ空白やゼロ幅文字を挿入しない。
HTML/fence/画像/link/見出し/箇条書き注入と長IDの表示文字保持を局所回帰で確認する。
英語のmission/file/tokenは1のみ単数、0と複数は複数形。集計値は変えない。

同じ6状態×日英fixtureを同じパスへ再生成する。修正前の24ファイルは
`_testenv/pr311-rare-i18n/pre-narrow-f87af45/`へ保存し、旧証拠を保持。
新mdは実renderer出力、htmlは出力のliteral paragraph previewであって正規UIの証拠ではない。
既存callerの最終配送・再表示・日英履歴投影とrendererの影響assertionを更新した。
先行85 PASS・実Missionを無目的に再実行せず、今回登録の3表示モジュールと影響callerだけを確認する。
正式command/exit/時間は今回Taskのnative結果とPRの候補別記録に残す。
最初の今回正式実行は53 PASS/1 FAIL（build 9.326秒、test 0.282秒、exit 1）。
状態名のunderscoreが安全な文字参照になったことへの既存bytes assertion追従漏れだった。
EXTERNAL/USER_DECISIONの状態・表示文字・判定は変えず、該当assertionだけを補正して同じ3モジュールを再確認する。

今回Workerのbrowserは接続不可既知のため、今回候補の正規UI成功・横溢れ解消・
`wbr`の正規UI保持とcopy動作・展開画像はまだ未検証。
rootが同じviewport・正規UIで新earned日英mdを比較する必要がある。
本文全体のIBM Plex Mono維持は意図しない。合成fixtureは実任務の獲得・費用・Acceptanceではない。

今回PR本文・通常コメント6件・review本文0・行コメント0を再回収し、追加の具体技術指摘なし。
mainは `6a0a5764500884155e24ff06416e1aac86f51d8d` のまま。Codex failed/usage limitは保留を継承。
追加モデル相談・Gemma・新release・global変更・npm publish・共有host再起動・停止評価再開なし。

### rootによる狭幅補正後の正規UI比較

上記の「未検証」はWorker返却時点の記録。後続でrootがruntime候補
`33a06f4969905cc53e0fd4fb83c579823cacd0e7` の実renderer出力を正規OpenCode WebUIで比較した。
この節はroot提供の直接観測を記録するもので、Coordinatorによる別の撮影・実行を意味しない。

- 同じ既存比較turnの通常本文へ、日英earnedの保存bytesを合成fixtureと明示して提示。
  実任務の獲得・費用ではない。新しいMission、表示専用モデル実行、DB履歴変更、DOM/CSS注入は行っていない。
- 正規UIのviewportは634×843。新しい日英detailsは各68段落、本文幅598・scrollWidth598で横溢れなし。
  通常summaryクリックで開閉し、長い費用・復帰・記章条件・計測範囲の注記を直接読んだ。
  行高22.40625pxから44.8125pxへの自然折返しを確認。前候補のpre幅JP1041・EN1639から改善した。
  本文はInter、短いTACTICAL DESKのinline codeを保持。本文全体の等幅書体維持は保証しない。
- 費用、`fixture/model ██████████ 100.0% · $0.0200 · 1,500 tokens`、PACK、unknown、保存範囲、
  称号根拠、二重加算防止注記を実renderで比較した。Advisor A案採用の効果は、この狭幅の横溢れ解消として観測済み。
- 既存回帰と同じ179文字IDを使った実rendererの3段落も正規UIへ提示。
  各7個のwbr、幅598・scrollWidth598、段落高67.21875px。
  Range選択の`getSelection().toString()`で元179文字IDの完全一致を各1回確認した。
  空白・ゼロ幅文字の追加や文字欠落はなかった。OSクリップボードのread/write試験ではない。
- rootは画像 `/tmp/opencode-browser-iZlgOU/0/screenshot.png`
  （`file_b530867d-cf0a-48d2-b42e-7b64d1c3ebac`）をその場で直接確認。
  長ID3段落の折返しと折畳みの日英summaryを視認した。
  tool進行時の再描画でdetailsが閉じたため、展開パネルの画像取得成功とはしない。
  展開本文・全注記・幅・折返しは正規DOMで直接確認した代替検証である。

今回の正規UI未確認という残件は上記範囲で解消。合成表示の確認を実称号獲得、OS clipboard試験、
全状態の画像確認、独立Review PASS、要求全体のAcceptanceへ拡張しない。
source/testは非変更なので、既存の保存系85 PASS、表示54 PASS、影響caller6 PASSを再実行しない。
現候補のSELF_RECHECKED（未解決指摘なし・residual_major:null）は独立PASSではない。
文書確定後は既存12fixture比較とdiff checkだけで最終bindingを取得する。
最終PR回収は通常6件・review本文0・行コメント0。追加の具体技術指摘なし、Codex利用上限は保留。
費用累計unknownを維持し、公開v0.15.1/tag/global/npm/restart/停止評価・main mergeは行わない。

## 完成候補の最終講評（2026-10-30）

対象は `4e63668f1f9757152e758d19645473206b0c00e0`（runtime `33a06f4`）。
rootが既存ChatGPT会話 https://chatgpt.com/c/6ae2a3d0-23cc-83ee-a1f8-a0ab2e629bb1 へ、
完成候補のsource・日英出力・判定/保存契約・既存検証/Review・正規UI観測と留保を本文で再提示した。
添付ファイルは成立しておらず、提供済みとはしない。送信1回、最終回答完了と全文読了はrootの直接観測。
設計段階の相談とは別の「完成候補の最終講評」である。

回答は「GO — 現在の要求範囲では完成水準に達しています」、
「GO — 新たな確定Major/Medium欠陥なし」。採否は以下のとおり。

- **採用：現候補を正規の最終比較へ進める技術助言。** rootが確認した現source、既存成功チェック、
  正規UI観測、現SELF_RECHECKEDと矛盾する具体的欠陥はない。正式receipt結合、三値判定、
  再表示/再開/重複防止、旧/未知/部分履歴の区別、日英共通ID/判定/保存を保持する。
  「不屈の連携」の稼働重複は因果的な協働成果の証明ではない、という注記も保持する。
- **採用：今回の正規UI観測範囲で十分という助言。** 合成日英の展開本文・注記・狭幅・長ID文字保持は
  上節のroot観測を参照する。OS clipboard read/write、展開パネル画像、新記章の実任務獲得は未試験のまま。
  今回の元要求のために追加獲得Missionや撮影を開始する理由にはしない。
- **採用：PR説明の現在状態と履歴の分離。** 冒頭に最新状態と留保をまとめ、旧候補の
  「現在candidate」「未確認」を当時の記録と明示する。過去の失敗・費用・証拠は削除しない。
- **保留：任意UX改善。** 「静かな一撃」だけの場合に「作戦称号：特別記章へ集約」の行を省き、
  特別記章だけにする案。回答も「任意UX改善」「現状を不具合として止める必要はありません」と明記。
  現表示の意味・保存・重複防止は正しく、好みだけでruntime/fixture変更と再検証を増やさない。
  この案は実装済み・採用済みとはしない。

ChatGPTのGOは技術助言であり、独立Review PASS・実称号獲得・正式Acceptanceではない。
ChatGPT自身がローカルDBや正規UI、OS clipboardを再検証したという意味でもない。
現SELF_RECHECKEDを独立PASSに変更しない。既存85 PASS・表示54 PASS・影響caller6 PASS・12fixture比較は
重複を合算せず再利用する。今回source/test/判定/保存/fixtureは非変更、文書の実内容とdiffのみ確認する。

PR本文・通常コメント6件・review本文0・行コメント0を今回再回収。新たな具体技術指摘なし。
Codex failed/usage limitは保留（外部レビュー未完了）。再依頼や追加課金なし。
今回Coordinatorは `openai/gpt-6.1-sol`、実装Worker追加なし、Gemma不使用。
新規runtime実行やモデルMissionを行わないことは、外部相談を含む総費用ゼロを意味しない。費用累計unknownを保持する。
公開v0.15.1成果物/tagの差替え、新release、npm publish、global適用、共有host再起動、停止SWE/Frontier評価再開、
main mergeは今回行わない。文書の追加headは講評対象 `4e63668` と区別し、rootの正式受入は別途必要。
