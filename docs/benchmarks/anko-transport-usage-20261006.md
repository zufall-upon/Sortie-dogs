# Anko通信切断・usage欠測のoffline続行

## 対象と制約

消費済みtrial `20261005T113123007Z-90023a9b`の74,539ms停止を調査した。本体の再開・延長・追加arm、元prompt再送、代替Workerは0。局所probeは保存履歴解析とmock/一時DBのみで、providerリクエスト0。成功済みGo/CLI/client準備、旧診断、旧runner/lock、固定candidate、未commit変更、設定、log/DBを保持する。

- package：v0.13.8 local候補、SHA-256 `b33f11f60609e22b2d6e709252e4a6e3b0c15bc20108b8823e34d300432bacaa`。
- 元arm SHA-256 `157aa0fe6b2c5005844b466a97f41c322548c902d73fa722408877e932d24b0b`。今回のrunner訂正と別identity。
- Anko base `3f269a72ff69398b1250c584171f32d12c0d8085`、原文SHA-256 `96c0c7ad98237d6176034c8893d8bff164ec5fda45889e51780a65cf599ffcfe`。
- SOL `openai/gpt-6.1-sol#xhigh`、Luna `openai/gpt-6-luna-fast#max`、CLI/client2.0.18。
- 既存上限：1arm・60分・$15 token価格推定cutoff・grading none。累計消費/残額をresetしない。
- `git ls-remote origin refs/heads/main`は`f01a3fc881c5b4a9e361c855336cc3d51422c49f`。同commitに共通Anko runnerはなく、この未commit runnerへ要求内訂正を加えた。既存product修正tree、global両installationへ変更なし。

## 観測できた順序と未確定の因果

保存DBと`native-history.json`のWorker assistant `msg_10bd65123001AXyd7g0jBqKXcF`は、型付きerror `provider.transport` / `WebSocket closed with code 1006`。モデル/variantは一致する。

1. `11:32:42.037Z`：handoffのnative read成功。
2. `11:32:43.257Z`：Worker step failed。read成功から1,220ms後。
3. `11:32:43.260Z`：native retry scheduled 1件。保存retryの`attempt:2`、予定時刻`11:32:45.403Z`は予約であり、2回目のprovider推論開始や完了の証拠ではない。
4. `11:32:44.359Z`：Worker native interrupted。予約時刻より1,044ms前。追加step開始・追加Workerは保存範囲で未観測。

observerのevent購読はerror=nullで、Worker失敗後もRoot text delta、step.streamed、子interruptedを受信していた。**Worker provider WebSocketとrunner→local serverのevent購読は別経路**。local購読断を今回の停止原因とする根拠はない。AGENTS permission待ちには未到達。

Worker tokensはDB・export両方にない。未知modelの価格表不足ではなく、tokens自体の欠測で旧runnerのcost estimatorが`missing-usage`となり安全停止した。保存範囲のfailure→欠測検出→interruptの制御順序は追えるが、**1006がusage欠測を直接起こしたとは断定しない**。providerがusageを未送信か、hostが未保存か、切断元がprovider/proxy/network/clientのどこかは、この履歴に通信frame・provider最終応答・内部保存traceがなく不明。

停止後も保存DBのRootはidle/outcomeなし。Rootの4件目assistantはstreamedのみでusageなし、exportにはこの未完了record自体がない。DBはassistant5件、exportは4件。exportだけの費用集計はRoot欠測1件を落とす。Worker interruptedはnative観測できるが、Root interrupt ackやserver process消失からRoot native終端を補っていない。

## 要求内の訂正

唯一のentrypointへ`inspect --version X.Y.Z`を追加。terminal lockが指す保存trialのみofflineで解析し、package/元runner/hash、DB credential行0、local/永続copy、検査前後の入力不変を照合する。元trialを書き換えずstdoutへJSONを返す。

共通armはusage完全性・価格不明・pendingを分離する。終端/error後の欠測、model不明かつtokens欠測も安全停止対象へ含め、全field0の明示usageとfield欠落を区別する。既知小計とunknown総額/実請求を分ける。

安全停止を維持して各owned sessionへinterrupt各1回。停止後に最大10秒/残りwall時間の有限回収を追加。DB/APIのidle+outcome、全owned子のpending permission/tool、query失敗を照合する。新しく観測したowned子も確認するが、prompt・resume・代替Worker・無条件allow・無制限retryは使わない。使用量が後から回収できても停止を取り消さない。

native eventのsanitized保存へerror type、1006 code、retry attempt/予定時刻、tokensの有無/数値を追加する。error全文、credential、headers、provider encrypted stateは新観測へ出さない。server停止/credential除去後のDB再観測も別ファイルに保存する。新しいmodule hashは次の明示許可trialで固定されるが、今回の固定済みmodule/package/policyは未変更。

## 検証と残る限界

正式チェックは次の順序。関連runner回帰のみで、全suite、live provider probe、Anko arm、gradingは追加しない。

```powershell
node --test test/anko-benchmark-runner.test.mjs
node scripts/anko-benchmark.mjs inspect --version 0.13.8
```

最初の関連回帰は17/18 PASS、exit1、Node duration563.5537ms、native shell1,832ms。最終snapshotの時刻とdrain全区間を同じelapsed fieldにしていたため400ms/500msの回帰assertが失敗。最終elapsedを実終了時刻へ訂正し、deadline0の追加回帰も含め再確認した。

- 関連回帰：**19/19 PASS、exit0**、Node duration533.7485ms、native shell1,534ms。再実行理由は上記の実失敗と追加回帰。
- offline `inspect`：**exit0、native shell1,048ms**。保存入力15ファイル不変、13対象のlocal/永続copy一致、固定package/元arm/原文hash、credential行0を照合。失敗後event15件、retry追加step開始0、DB5/export4件を出力。本体・provider送信0。
- 完全diff点検でDB/APIの「両方terminal」だけではoutcome/idle時刻の不一致を落とせる枝を発見。exact値照合へ訂正し、不一致2例・interrupt失敗各1回の回帰を追加。再確認は**20/20 PASS、exit0、Node duration511.2225ms、native shell1,410ms**。続く`inspect`も**exit0、native shell1,031ms**、保存trial結果は同一。再実行理由はこのsource/test変更。Node test durationとnative shell所要時間は別時計。
- 結果追記は文書だけでrunner/test/保存trialは未変更だが、`finish_direct_unit`は`mission-review-correction-validation-stale:node --test test/anko-benchmark-runner.test.mjs`を返した。hostの現候補fingerprint要求に従い、短い同じ2checkを宣言順で再実行して正式収録する。最終native所要時間/Reviewはroot-owned記録に残す。これを理由に有料probeや本体を反復しない。

正式収録・freshness・独立Reviewの結果は当Missionのnative履歴・root-owned記録で照合する。作者のチェックを独立PASSやAnko受入へ転用しない。

- 本体既知priced小計は依然**$0.06538680**。SOL3件のみ。Luna terminal欠測1件、Root pending欠測1件。総額・実請求・campaign残額はunknown。
- 比較するv0.13.6＋旧v0.13.8＋今回の本体は引き続き計3arm、7,274,767ms、既知priced小計$0.21861628＋欠測分。他trial、旧外側費用checkpointは保存したままで、この小計へ重複加算しない。
- 今回の外側調査/訂正/Review費用は本体費用へ混ぜない。最終外側費用・実請求は不明。probeのprovider費用0は、調整モデル全体の費用0を意味しない。
- 局所回帰は遅延usage、欠測継続、API timeout、DB/API不一致、未確認interrupt、pending permission/tool、子所有関係、deadline0を検証する。本体完遂・通信修復・実装品質の証明ではない。
- raw log/dataset/DB/tgz/資格情報はGitや公開へ追加しない。未commit/未pushを維持し、release/publication/global適用なし。

次の一手はこのoffline `inspect`を再利用した状態照合。新しい本体や有料通信probeは自動開始しない。根本通信原因の確定には別途provider/server側の通信・usage保存観測が必要であり、今回は原因未確認の設定変更をしない。

## 独立調査から同一Task内の訂正

独立ReviewerはMedium 3件を確認し、hostの既存write scopeへ遷移して同じTask内で訂正した。訂正中のexport欠落影響、compaction model照合影響、受入と保存整合性の判定不一致も追加保持した。自分の訂正版の再点検は作者self-recheckであり、独立PASSではない。

- 停止後の期限がdrainだけに適用され、先行interrupt/prompt待ちが別予算、後続native exportが無期限だった。SDKのmock未応答exportを実`persistFinal`から呼ぶ局所診断で、50ms後も未完了、exit1を確認。停止判断時の共通deadlineへ統一し、interrupt/状態照合とexportを並行回収する。未応答exportは打切り、成功した部分履歴は保持し、server停止・DB credential除去へ進む。local prompt応答待ちも取消し、元prompt再送はしない。
- V2のopaque providerStateに`serviceTier:null`があると、実価格estimatorの`toLowerCase`で例外になった。保存旧runnerのstring-only guardを復元。既知価格小計を保ち、null等を理由にowned interrupt経路を失わない。
- V2のcost-bearing compactionがassistant-only集計から消え、欠測でも総額completeとなっていた。completed/failed/runningとtokensをowned accountingへ含める。assistant件数は変更せず、inspectのassistant/compaction件数とexport照合も分離する。
- export欠落時にDBで確認済みの子までsessions/dispatch件数から消える枝を確認。実persistFinalの所有情報生成を空exportで評価した局所診断は0対2件でexit1。所有情報とoutcomeはDB観測から保存し、export成否を別記録にする。
- compactionを価格集計へ加えた影響を追跡し、独立compaction modelがWorker/SOL roleの実assistant routeへ混ざる枝を確認。異variantのcompactionを含む限定回帰はexit1、Node duration98.184ms。roleの観測・照合はassistant recordのみ、価格集計は両方に分離して訂正した。
- armの厳格なaccepted判定とverifierの旧receipt-only判定が不一致だった。receipt成功＋settlement未確認の限定回帰はexit1、Node duration78.3084ms。新観測ではnative settlementとusage完全性も判定し、旧観測にsettlement fieldがない場合は旧契約を保持する。未受入と保存整合性エラーを混同しない。

修正前のserviceTier/compaction限定回帰は2/2失敗、exit1、Node duration101.5853ms。修正後、未完了export・先行成功履歴保持・期限0/残りwall時間・並行interrupt・export欠落時の子件数を加えた**追加6回帰は6/6成功、exit0、Node duration195.6852ms**。すべてmock/一時DB/source評価のみでprovider送信0。本体試行ではない。

統合候補の初回正式チェックは宣言順で、**26/26成功・exit0・Node duration618.4127ms**、続くoffline inspectも**exit0**。保存入力15ファイル不変、provider送信0、元arm/package hash、DB5/export4、compaction0、既知priced小計$0.06538680、総額/実請求nullを再確認した。その後にverifier不一致の訂正と1回帰を追加したため、最終27件と同じoffline inspectを宣言順で正式収録し直す。再実行理由はこのsource/test変更と文書の候補fingerprint変更であり、本体・有料probe・全suiteは追加しない。最終exit・native所要時間・このTaskの実terminalはhost履歴で照合する。生log/DB/credentialsをGitへ追加せず、未commit/未pushを保持する。既知本体小計・累計消費・1006の原因未確定という結論、既存candidate/lock/package/過去結果は変更しない。

native exportは有限期限内で取得できた時点の履歴であり、その後の終端/usageはDB/APIのsettlementとpost-cleanup観測を別途読む。取得失敗や応答取消をnative終端や実請求の証拠にしない。live transport修復や追加Anko本体での効果は未測定のまま。
