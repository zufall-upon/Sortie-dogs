# Anko共通ベンチrunner

## 固定コマンド

repository rootのforeground shellで、同じスクリプトへ版だけ渡す。

```sh
node scripts/anko-benchmark.mjs run --version X.Y.Z
```

対象版だけ渡す。WindowsとLinuxで同じentrypoint・監視を使う。`run`は未変更の準備を再利用し、モデルを呼ばない保存整合性preflight・新規arm 1回・結果保存まで行う。**有料の局所read診断は起動の必須条件ではない**。`tee`、redirect、別wrapperは足さない。

packageの既定保存先はWindowsが`M:/_work/_Sortie-dogs-artifacts/releases/vX.Y.Z/sortie-dogs-X.Y.Z.tgz`、Linuxが`_testenv/releases/X.Y.Z/sortie-dogs-X.Y.Z.tgz`。初回だけ別のlocal packageを選ぶ場合：

```powershell
node scripts/anko-benchmark.mjs prepare --version X.Y.Z --package <archive-path>
node scripts/anko-benchmark.mjs run --version X.Y.Z
```

Windowsの既存v0.13.8は`_testenv/anko-v0137-20261005/sortie-dogs-0.13.8.tgz`を選択する。公開tarballではなく保存済みlocal候補。receipt固定後は同版の別packageへ交換しない。

個別に確認したい場合もentrypointは同じ：

```powershell
node scripts/anko-benchmark.mjs prepare --version X.Y.Z
node scripts/anko-benchmark.mjs diagnose --version X.Y.Z
node scripts/anko-benchmark.mjs inspect --version X.Y.Z
node scripts/anko-benchmark.mjs verify --version X.Y.Z
```

`diagnose`は必要時に明示する有料の局所診断。事前に`prepare`が必要。保存済みの同じ診断は再利用し、過去の特定attempt番号を次の診断条件にしない。診断・回帰は本体試行ではない。`verify`は保存整合性/preflight検証であり、Anko成功・Review PASS・受入を意味しない。実行後も同じ`verify`で結果を照合する。

`inspect`は共通runnerの保存済みlockが示すterminal trialをofflineで読む。準備、server起動、credential取得、providerリクエスト、prompt、再派遣、ファイル更新は行わない。package/元runnerのhash、local/永続copy、DBのcredential行0、検査前後の入力不変を照合し、provider transportとobserver購読、usage欠測と価格不明、DBとexportの差をJSONで出す。元試行結果は訂正・上書きしない。旧Linux単独runnerのv0.13.9結果は`_testenv/anko-v0139-linux-20261007/run-1/diagnosis.json`を読む（共通trial形式へ上書き変換しない）。

## Host準備

`scripts/anko-benchmark/host.mjs`でhost依存pathと検証コマンドを分離する。task、base、model、費用・時間条件は共通。

- Windows：既存CLI 2.0.18、`.sortie-env`のclient、保存済みGoをWSLで使用。
- Linux：`npm ci`で導入済みrepository client 2.0.18、`_testenv/anko-linux-reusable/toolchains/`のCLI 2.0.18とGo 1.27.1をnativeで使用。source/taskは保存済み`_testenv/anko-v0139-linux-20261007/`から再利用。Windows pathや`wsl.exe`は呼ばない。
- 保存場所が異なるhostでは`ANKO_CLI`、`ANKO_SOURCE_PROJECT`、`ANKO_INSTRUCTION`、`ANKO_GO_DIRECTORY`、`ANKO_GO_ARCHIVE`、`ANKO_HOST_DATABASE`、`ANKO_RELEASE_ROOT`、`ANKO_ARTIFACT_ROOT`を指定できる。新しい権限ルールではなく準備済み入力のpath指定。profileへ固定し、実行中に交換しない。
- profileへ実CLI hash、client lock、hostとtoolchainを記録。版ごとに再install/initせず、未変更のinstallationを再利用。mirrorの可変tipや過去の失敗receiptは新規armの起動条件にしない。
- Linuxのrepository lockにはSortie自体の版番号も含まれるため、共通driverの再利用判定にはclient版を用いる。root lockの実hashと内容は各armで固定・保存し、実行中のdriftを検出する。Sortieの版番号だけ変わっても未変更のdriverを再installしない。Windowsの専用driver lock固定は維持。

## 分離したidentityと保存先

- 共通条件・Go/client準備・適用済み指示：`_testenv/anko-reusable/common/`。成功済みCLI/client2.0.18、Go1.27.1を再利用。
- 版ごとのpackageとhash/receipt：`_testenv/anko-reusable/packages/vX.Y.Z/`。
- 版ごとの制御installation・局所診断：`_testenv/anko-reusable/vX.Y.Z/`。
- 本体条件：実行前に固定する`execution-policy.json`。診断条件を後から変更しない。
- 本体試行：`vX.Y.Z/trials/<timestamp-uuid>/`。runnerのGit revision、変更有無、各module hashとpackage hashは別identity。
- 永続記録：Windowsは`M:/_work/_Sortie-dogs-artifacts/records/anko-reusable/vX.Y.Z/`、Linuxは`_testenv/anko-records/vX.Y.Z/`（同一diskの保持copyであり別disk backupとは主張しない）。

同版`run-once.lock`は排他的な本体消費記録。terminal失敗も消さず再起動しない。旧Linux単独runnerの消費済みlockも認識し、共通runnerへ移っただけで試行数をresetしない。v0.13.9は消費済み。`verify`は`retained-arm-consumed`と保存lockのpathを示す。

ユーザーが改修後の実行を新しく依頼した場合は、`run --version X.Y.Z --attempt <id>`で別の単一armを記録する。`verify`/`inspect`にも同じ`--attempt`を渡す。準備と固定packageは再利用し、lock/結果は`vX.Y.Z/attempts/<id>/`へ保存する。以前のlock・結果・費用は消さない。新しいIDは明示された実行の識別であり、自動retryや上限resetを意味しない。修正確認を反復する場合はcampaign累計費用と各candidateのcommit/hashを別途記録する。

反復の残予算は`run ... --max-priced-usd <remaining>`でarmへ引き継ぐ。既定$15を超える拡張は行わない。見積り不完全なmessage・実請求不明は残予算記録にも明示する。

`prepare`はGoだけでなく`golang.org/x/tools/cmd/goyacc@v0.42.0`を共通領域へ一度準備し、各候補の`.gopath/bin/goyacc`へコピーする。Linux WorkerのPATHへGo/gofmt/goyaccを渡し、Windowsでは既存WSL実行方式で同じbinaryを使う。module/version/hashを各armへ固定する。外部toolchain探索やpermission replyを起動条件の代用品にしない。

## 継承条件とread停滞処理

- task原文1,825 bytes、SHA-256 `96c0c7ad98237d6176034c8893d8bff164ec5fda45889e51780a65cf599ffcfe`。
- Anko base `3f269a72ff69398b1250c584171f32d12c0d8085`。mirrorの新tipへ移動しない。
- SOL `openai/gpt-6.1-sol#xhigh`、Worker `openai/gpt-6-luna-fast#max`。
- 本体1回、60分、$15 token価格推定cutoff、grading `none`。請求額保証や既存campaign残額ではない。
- 局所診断は正式read-only Workerでrepo内既存、不在AGENTS、repo外祖先AGENTSを比較。native event、permission.list、tool/Sortie hook前後を記録。
- 本体の無進捗閾値180秒。Worker activeは進捗ではない。親subagent待機は子の実測進捗と区別する。
- 既にdirtyの同じfileへ追加編集しても、diff/contentの変化を進捗として認識する。Go cacheやrunner制御fileはsourceの進捗へ混ぜない。
- `read`だけでなく`patch`/rename全対象pathとSortie hook開始/終了を記録。`no-progress-stop.json`の`tool_wait_observations`はnative permission、未復帰hook、native開始のみの境界を区別する。repo外pathは観測のみで、新しい拒否・承認・path書換えは行わない。未確定の原因を確定扱いしない。
- 指示の同内容再readを避けるため、hash固定済みAGENTSを初回promptへ添付する。
- 本体の`once`返信はnative所有session、read tool call、固定済みAGENTSのexact path/hash、要求resourceが全部一致した場合だけ。shell/edit、別file、別sessionには返信しない。`always`や無条件allowは使わない。
- 未知の権限待ち/tool停滞は状態を保存し、180秒後に所有active sessionへinterruptを1回要求。prompt再送・代替Workerで迂回しない。interrupt ackとnative terminalは別記録。
- 文脈継続はRootと全owned sessionがnative終了、pending tool/permissionなし、同じMission未完了の場合だけ最大1回。元課題は再送しない。

今回の前段診断はrunner不具合で未到達、次は正式TaskなしWorkerの拒否を発見した。これらを保存したまま、原因確認済みadmission routeだけ訂正した。版変更後は最初から正式Worker診断を用いる。変更のない失敗診断を自動反復しない。

## usage欠測と停止後回収

- 未完了streamの`pending-usage`、終了/error後の`missing-terminal-usage`、完全tokensでも価格不明の`unpriced-usage`を分離する。欠落fieldを0で補わない。完全な実測tokensが明示的に全0の場合だけ価格0があり得る。
- owned assistantだけでなく、usageを持つcompactionも集計する。completed/failedの欠測は安全停止、runningの欠測はpending。assistant件数とcompaction件数は分離し、欠測compactionを総額から消さない。Worker/SOL roleの実model照合はassistantだけを対象とし、独立compaction modelとは混ぜない。opaque providerStateのserviceTierは従来どおりstringだけを価格推定へ渡す。
- `priced_usd`は既知価格小計。欠測/価格不明/pendingが残れば`estimated_total_usd=null`。`actual_billed_usd`は常にunknown/nullで、token推定やnative `cost:0`を実請求へ転用しない。
- `unpriced-usage-safety-stop`は維持。停止判断時に最大10秒か残り本体wall時間の短い方の共通期限を固定する。owned session interrupt各1回、DB/session.get/permission.list/native tool状態、native exportを同じ期限内で回収する。exportはdrainと並行し、未応答でもserver停止・credential除去を妨げない。prompt admission応答へ別の10秒待ちを加えず、未確認のlocal応答待ちは取消する。期限0なら追加API問い合わせなし。usage回収後も元の安全停止を成功や継続へ変更しない。
- idle timestampとnative outcome、DBとAPIの照合、各子のpermission query成功・pending0、tool pending0を区別して保存する。ackだけ、片方だけのterminal、問い合わせ失敗ではsettledにしない。新しいowned子を再照合しても代替Workerは作らない。
- exportの成功分は保持し、失敗分は`history_error`へ分離する。所有session/outcomeと子dispatch件数はDB観測から保存し、export欠落を子0件やnative成功へ転用しない。
- `usage-safety-stop.json`、`settlement-snapshots.jsonl`/`settlement.json`、server停止・credential除去後の`post-cleanup-usage.json`を別観測として保存する。process停止からsession成功・native終端を推測しない。元停止時点と後観測の費用を重複加算しない。
- 今回の検証はoffline保存履歴とmock/一時DBのみ。新しい通信方式、proxy、provider設定、retry回数は変更しない。修正後の本体効果は未測定。

通信・usageの切り分け結果と今回の限定回帰は[続行結果](benchmarks/anko-transport-usage-20261006.md)を参照。

## 保護と結果解釈

旧runner/lock/package/log/DB/比較結果、global設定は保護する。生log、DB、dataset、資格情報、tgzはGitへ入れない。隔離DBのcredential行を除去・検証してから永続保存する。runnerの修正はhostの既存権限を維持し、新しい承認、無条件allow、新しいscope拒否、製品gateの推測修正を足さない。

今回の実結果・比較・未知項目は[結果文書](benchmarks/anko-read-recovery-20261005.md)へ記録。Root応答終了、shell exit0、低費用だけを課題成功と扱わない。

Linux v0.13.9の反省と改善PRは[三要素の点検](benchmarks/anko-runner-autonomy-20261007.md)を参照。
