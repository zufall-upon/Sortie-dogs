# Anko共通runner・read局所診断・新規1回の実結果

## 結論

恒久entrypointを`node scripts/anko-benchmark.mjs run --version X.Y.Z`へ統一した。保存済み準備と版別package receiptを再利用する。

正式Workerの局所診断では、repo内readは完了し、祖先AGENTSのreadだけ`external_directory`確認待ちを再現した。Sortie hook自体は終了していた。**今回の再現の権限待ちは確定、過去58分停止の内部原因は当時の観測欠落により未確定**。

改善後の本体は**新規1回、74,539 msで未完了**。Workerのprovider transportが`WebSocket closed with code 1006`となり、usage欠測を検出して`unpriced-usage-safety-stop`で停止した。Ankoの実装、検証、Review、commit、受入receiptは未到達。短時間停止やshell exit0を成功・効率改善と扱わない。

本体は再起動していない。旧trialのresume/延長、元課題再送、代替Worker、消費resetもない。

## 固定identity・条件

- package：保存済みv0.13.8 local候補。公開tarballではない。
- package SHA-256：`b33f11f60609e22b2d6e709252e4a6e3b0c15bc20108b8823e34d300432bacaa`。
- marker：`0.13.8-native-binding-v1`。
- runner repository revision：`4b628d99c0f878154a4d430750b151ea274298e3`。新runnerは未commit変更として別hashを固定した。
- 実行arm module SHA-256：`157aa0fe6b2c5005844b466a97f41c322548c902d73fa722408877e932d24b0b`。
- task：`datacurve/anko-typed-variable-bindings`、原文1,825 bytes、SHA-256 `96c0c7ad98237d6176034c8893d8bff164ec5fda45889e51780a65cf599ffcfe`。
- Anko base：`3f269a72ff69398b1250c584171f32d12c0d8085`。mirrorの`master`新tipは不使用。同baseのlocal `main`と`bench/anko-v0138`をcloneごとに用意した。
- CLI/client2.0.18、Windows Node22.14.0/npm10.9.2、WSL Node22.22.3/npm10.9.8/git2.43.0、Go1.27.1。成功済み383 stdlib package確認、既存Go/clientを再利用。
- SOL `openai/gpt-6.1-sol#xhigh`、Worker `openai/gpt-6-luna-fast#max`、grading `none`。
- 本体1回、60分、$15 token価格推定cutoff。固定上限であり、実請求保証やcampaign残額ではない。

### 実行前に別固定した停滞・回復条件

`execution-policy.json`を`2026-10-05T11:31:23.006Z`に固定、SHA-256 `b9753dd5516436c57e3c274a7144e8a61ed941e5fac4814995b7a302c5abedd5`。旧試行と診断のobserve-only条件は変更していない。

- 無進捗180秒。native text/reasoning/tool境界、usage、Mission/source変化を観測。activeだけは進捗にしない。
- 適用済みAGENTSをhash付きで初回promptへ添付。同内容再取得を避ける。
- permission回復は、native所有session、read call ID、固定AGENTSのexact path/hash、要求resourceの全一致に限る`once`。`always`、無条件allow、shell/editへの返信はない。
- 未知の確認待ちは可視化、180秒後にowned active sessionへinterruptを1回要求。原因未確認のprompt再送・重複Workerは行わない。
- contextual continuationは全owned sessionのnative終了とpending0を確認できた同一Missionだけ、最大1回。本体では0回だった。

## 局所診断：本体とは別

最初のなかよびは5,423,344 msの外側unitを消費して失敗。診断作成不具合と過剰な再試行制約があり、本体は起動しなかった。同じ要求・予算を保持してCoordinatorが直接訂正した。

保存した診断経路：

- attempt1/2：plugin準備で失敗、prompt未送信。
- attempt3：prompt1回送信後、runnerの`STATE_ROOT`未定義で結果作成失敗。再接続は元promptを送らず、read前停止を記録。元DBと再接続結果は保持。無進捗1,171,069 msはこの旧診断の観測であり、後から180秒成功へ書き換えていない。
- attempt4：observerをV2 APIへ統一しhook入口/出口を追加。28,279 ms、Luna実message4件。3readがすべて`runtime-profile-session-inactive`でnative permission判定前に拒否。正式TaskなしWorker起動という診断routeの不具合を特定した。
- attempt5：その確認済みrouteだけ正式read-only Taskへ訂正。278,058 ms（clone/server/記録準備込み）、Root1＋Worker1。改変や本体実装はなし。

attempt5の同条件read：

- repo内`go.mod`：native success、read permission `allow`、before/after hook観測。
- repo内不在`AGENTS.md`：native file-not-found、before/after hook観測。長時間待ちなし。
- repo外の適用祖先`AGENTS.md`：call `call_2pO0URLrLazJiPbufPdNQiEG`。`11:01:14.203Z`にbefore hook、Sortie before終了`11:01:14.212Z`、permission evaluate `ask`、Sortie permission hook終了`11:01:14.215Z`。
- native request `per_10bb99567001ZiMue3sO4iR5w0`、action `external_directory`、resource `M:/_work/Sortie-dogs-acceptance-reuse/*`をeventとpermission.listの両方で観測。同じ1要求を177 snapshotsで観測したのであり、177要求ではない。
- 180秒無進捗後にWorkerへinterruptを1回要求、保存DBのnative `interrupted`を観測。native readはinterruptでfailed、通常のafter hookは未到達。filesystem syscall開始/終了は観測できない。

診断の初期失敗を隠して本体3回と数えない。新しい診断は観測/登録route変更の切り分けであり、停止したAnko本体の代替Workerではない。

## 本体1回の実測

```powershell
node scripts/anko-benchmark.mjs run --version 0.13.8
```

- trial：`20261005T113123007Z-90023a9b`。
- Root：`ses_ef42ab67bffexnti0C3y48Bgbj`。
- Worker：`ses_ef429b009ffewyG14Eg5M1BKkb`。内側派遣1回。追加Worker0、contextual recovery0、元prompt再送0。
- 本体開始`2026-10-05T11:31:29.790Z`、実行74,539 ms。子driver準備・記録込み81,891 ms、外wrapperの子process区間87,722 ms。native shell全区間はhost履歴で別時計として保持する。
- 実messageでSOL xhighとLuna maxを観測。Root3件はpriced、Luna1件は部分stream/tool実行後のtransport error・usage欠測。native records数からprovider request総数は断定しない。
- Lunaはhandoffのnative readを完了した直後、provider transport `WebSocket closed with code 1006`。retry scheduled event1件を保存。再試行の完了・追加Workerは観測なし。外observerは欠測を検出しinterruptを要求した。
- loaded runtimeはRootの実operator_status出力からmarker/hash、load時刻`11:31:29.264Z`、PID27876、host2.0.18を観測。adapter SHA-256 `c612586c0b586d2651cfc0a02c53d2eeb2abcd3e34b60fd2fbe404a9906e1c6f`。
- 調整側のglobal marker0.13.7/host2.0.23とは別。global適用はしていない。
- stop `unpriced-usage-safety-stop`、driver exit0。source変更0、commit0、検証/Review/受入なし。
- 本体ではAGENTS確認待ち・限定once回復とも未到達。改善の本体効果は未測定。
- Worker native `interrupted`を保存、Root native terminalは保存時点未観測。owned serverはprocess一覧に不在。interrupt ackをRoot成功へ転用しない。
- DB sourceとVACUUM snapshotはcredential行0。local/永続copyを照合する。

## 費用・時間：範囲を分離

すべてtoken価格推定で実請求ではない。欠測を$0と扱わない。

- 本体：priced **$0.06538680**（SOL3件）。Luna1件はusage欠測/unpriced、さらにRoot未完了record1件。最終総額は不明。
- 局所診断：attempt3の保存範囲は推論0/usage0、attempt4 **$0.00327388**、attempt5 **$0.06849104**。合計priced **$0.07176492**。準備失敗1/2、再接続、外側作業とは別。
- 外側Coordinator＋最初のWorkerのread-only DB checkpoint（`11:43:17.887Z`、v0.13.8 packageの価格表）：255 priced records、**$2.41328944**、Coordinator進行中usage欠測1。内訳Coordinator$1.25339440、Worker$1.15989504。後続調整、Review、root-parentは未算入。
- hostの最初のWorker-unit ledgerは5,423,344 ms/**$0.12385264**を保存している。上記DB全message checkpointとは収録/価格計算が異なり、同一総額と見なさず加算しない。
- Coordinator作成からcheckpointの暦上区間9,347,068 msはdiagnostic/arm/native check待ちと重複する。active準備時間や累計稼働時間として足し込まない。純粋なactive準備時間・最終外側費用・請求額・campaign残額は未知。
- source snapshot/host正式収録の待ちが大きい。directテスト自体約95 msに対し、native toolの開始終了区間には数分の記録処理を含む。runner再利用だけで外側効率が改善したとは主張しない。

比較対象v0.13.6＋旧v0.13.8＋今回の本体は**計3 arm、7,274,767 ms、既知priced小計$0.21861628**。旧Luna欠測と今回欠測を含まない。他のv0.13.2/v0.13.4 trialも保存したままで、この小計の範囲外。全campaignをresetした数値ではない。

## 検証・Reviewと保護

- `node --test test/anko-benchmark-runner.test.mjs`：8/8、exit0、Node test duration94.9503 ms。CLI、排他lock、active≠進捗、input-end≠tool完了、onceの対象外拒否を検証。初期6件から関連訂正後に8件へ増やしたため再実行。
- `node scripts/anko-benchmark.mjs diagnose --version 0.13.8`：exit0、診断attempt5を再利用。新promptなし。
- `node scripts/anko-benchmark.mjs verify --version 0.13.8`：preflightと本体後の保存整合性exit0。旧入力87ファイル不変、固定package、条件、model、runtime、local/永続copyを照合。整合性PASSはAnko受入ではない。
- 結果収集後、DB credential行/固定execution policyの直接照合をverifierへ追加した。未変更の本体記録を検証し直すだけで本体は反復しない。
- 外側共通runnerの独立Review/正式収録は後続host結果に従う。自分の確認を独立PASSとしない。
- 既存の起動管理/検証登録修正と旧未commit文書、runner/lock/package/log/DBは変更していない。global両installation、release、publication、PR/push、全suite、gradingも追加なし。

## 保存場所・次の操作

- 共通手順：[docs/anko-benchmark.md](../anko-benchmark.md)。次回も同じscriptへ版だけ渡す。
- 診断：`_testenv/anko-reusable/v0.13.8/diagnosis/attempt-{1..5}/`。元terminalと新latest pointerを分離し旧結果を保持。
- 本体：`_testenv/anko-reusable/v0.13.8/trials/20261005T113123007Z-90023a9b/`。
- 永続：`M:/_work/_Sortie-dogs-artifacts/records/anko-reusable/v0.13.8/`。
- 費用checkpoint：`_testenv/anko-reusable/accounting/checkpoint.json`。

今回の1armは消費済み。同版lockを消さず再起動しない。残るtransport障害とusage欠測はread停滞修正とは別で、本体の完遂・品質改善は証明できていない。

## 本体後の独立Reviewと限定訂正

server再起動で調整hostが2.0.11へ変わり、保存checkの2.0.23 executable/runtime bindingと不一致になった。元host2.0.23の復帰後、同じsourceと既存native成功証跡でdirect unitを終端化した。診断、回帰、本体は再実行していない。

初期独立ReviewerはMedium 2件を発見した。operation reviewの訂正routeは`mission-review-correction-unavailable`だったため、同じ要求・累計budget内でCoordinatorが次のsource訂正を直接行った。

- `session.get`のtimeoutでloop先頭へ戻り、180秒判定を迂回する枝を削除。取得失敗をJSONLへ保存し、API成否に関係なく停滞判定まで進む。
- observer directoryのmkdirと子ファイルwriteの競合を削除。mkdirをawaitしてから並列writeする。
- 関連2回帰を追加。連続timeoutでも180秒期限を評価する枝と、observer directoryが存在しないtemplateへの実ファイル生成を検証する。

これは**本体消費後のrunner訂正**。保存した本体module/hash、診断、package、条件、結果は未変更。この訂正版での追加armや診断は行わず、効果を本体実績と主張しない。限定回帰と同じ独立Reviewerによる再確認の実結果はhostの後続記録に従う。
