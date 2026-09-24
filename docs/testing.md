# テスト実行ガイド

このガイドは、リポジトリのテストと計測用controllerの実行手順です。
commandの定義は [`package.json`](../package.json)、fullの実行順は
[`test/helpers/full-test-runner.ts`](../test/helpers/full-test-runner.ts) を参照してください。
以下の例はリポジトリrootで実行します。

## 1. 準備と通常検証

Node.js 22.6以上、npm、Gitを用意します。Windowsの独立起動には、追加でPowerShell 7の
`pwsh.exe`とWindows Task Schedulerが必要です。

初回の準備:

```sh
npm ci
node --input-type=module --eval "import { mkdirSync } from 'node:fs'; mkdirSync('_testenv', { recursive: true });"
```

通常の変更では、変更対象のtestと`npm test`を実行します。例えばrunner/controllerの変更なら:

```sh
npm test
node --experimental-strip-types --import ./test/setup.ts --test "test/full-test-runner.test.ts" "test/full-test-controller.test.ts"
```

`npm test`にはclean buildが含まれます。その後sourceを変更していなければ、続く限定testは
同じ`dist/`を使用できます。限定testを先に実行する場合やsourceを再編集した場合は、
`npm run build`で`dist/`を更新してください。直接の`node --test`には自動buildがありません。

`--import ./test/setup.ts`は、test用のOpenCode設定rootをprocessごとに分離します。
開発者のglobal設定をtestへ持ち込まないため、直接実行でも指定してください。

### 実行対象の選び方

- `npm test`: plugin、continuation、fast-laneの通常検証です。全testではありません。
- `npm run test:dispatch`: execution plan、dispatch、acceptance、ledger、evidenceの対象testを実行します。
- `npm run test:integration`: worktree dispatchの重いintegration層を実行します。
- `node --experimental-strip-types --import ./test/setup.ts --test "test/<file>.test.ts"`:
  任意の対象ファイルを限定して実行します。`<file>`を実在する名前へ置き換えてください。
- `npm run test:full`: build後、`test/**/*.test.ts`を全件実行するリリース検証です。

ここで挙げたnpmの各test scriptは、対応するpretest buildを持ちます。
通常の開発でfullを繰り返す必要はありません。**fullはリリースルーチンの実施を明示的に
依頼されたときに実行します。** 同一候補の完了済み検証を重複起動せず、再編集や新しい失敗根拠が
ある場合に必要な検証を選び直してください。

## 2. Full testの同期実行

リリース検証では、同期実行か次節の独立起動のどちらかを選びます。
同じ候補について両方を起動する手順ではありません。

```sh
npm run test:full
```

このcommandはtest終了まで戻りません。各testファイルは別のNode processで実行されますが、
command全体がOpenCodeやterminalから独立するわけではありません。

現在の実行順は次のとおりです。

1. **process-exclusive**: child lifecycleのprocess制御test。
2. **dist-mutating**: pack/installで`dist/`を再構築するpackage-loader test。
3. **integration**: worktree dispatchのintegration層。
4. **nonintegration**: 残るtestを最大2ファイル並列で実行。

前のgroupが終了してから次へ進みます。各ファイルは`--test-concurrency=1`付きで起動し、
test自身が宣言するsubtest/helperの並行処理は各testの設定に従います。
integrationの独立した準備artifactは、既存の上限付きproducer poolを使う場合がありますが、
integrationのscenario順序や上記group間の排他は維持されます。

runnerは次のmetadataを出力します。

- `SORTIE_FULL_TEST_RUNNER_STARTED`: build後にrunnerが開始したこと。
- `SORTIE_FULL_PROGRESS`: enqueue/start/completeの逐次進捗。
- `SORTIE_FULL_FILE_OUTPUT`: ファイル名とphaseを付けたtest出力。
- `SORTIE_FULL_SCHEDULER`: 最終inventory、完了数、欠落・重複、実行順。

成功判定にはcommandのexit `0`と最終schedulerの`valid=true`を確認します。
`missing`が空、`duplicate`がすべて0、`files`件のファイルが完了していることも確認してください。
skipがある場合は理由を記録します。過去runの件数を現在の期待値として固定しません。

### 時間上限

- runner内部: **1790秒**。runner開始からの時間であり、pretest buildは含みません。
- Windows controller: 既定で**1800秒**。controllerの`started_at`から測り、npm起動とbuildを含みます。
- launcherの待機やTask Schedulerのqueue時間は、controllerのwall timeとは別です。

計測や外部toolにもtimeoutがある場合は、意図したrunを途中で切らない実行経路を選びます。
特に短いtool上限で同期fullを開始せず、Windowsでは独立起動と一回読取のmonitorを利用できます。
性能計画の「300秒以内」という目標と、現行runner/controllerの強制終了時刻は別の値です。

## 3. Windowsでの独立起動

[`scripts/full-test-controller.ps1`](../scripts/full-test-controller.ps1) は、現在のWindows userの
Interactive/LimitedなScheduled Taskを一つ登録し、別PowerShell controllerを起動します。
controllerが`npm run test:full`、heartbeat、deadline、process tree停止、terminal artifactを管理します。

同じworking treeで別のfullやbuildが動いていないことを確認し、新しいRunIdで起動します。

```powershell
$repository = (Get-Location).Path
$runId = 'full-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')

pwsh -NoProfile -NonInteractive -File .\scripts\full-test-controller.ps1 `
  -Mode Launch -RunId $runId -Repository $repository -OuterDeadlineSeconds 1800
```

launcherはRunIdを出力して戻ります。**Launchのexit `0`は起動成功であり、test合格ではありません。**
RunIdは後続の確認に使用するため控えておいてください。省略した場合はlauncherが生成します。

起動後はlauncherやmonitorの存続に依存せずcontrollerが動作します。ただし現在の実装は
Windowsへのinteractive logonを使用し、ログオフ・OS再起動後の自動再開やtest途中からの再開を
提供するものではありません。`-Mode Controller`の直接起動は通常の利用手順ではありません。

### 進捗を一回確認する

```powershell
pwsh -NoProfile -NonInteractive -File .\scripts\monitor-full-test.ps1 `
  -RunId $runId -Repository $repository -Once
```

[`monitor-full-test.ps1`](../scripts/monitor-full-test.ps1) はstateを読むだけです。
monitorのexitはtestのexitを表しません。`-Once`を外すと2秒ごとに継続表示し、
terminal状態になっても自動終了しません。monitorを`Ctrl+C`で止めてもcontrollerは停止しません。

通常のstate保存は最大毎秒1回です。起動・終了時は即時保存されます。
一時的に読取結果が空でも、同じRunIdを読み直してください。これを新規起動の理由にはしません。

### 結果とbuild込みwall timeを確認する

次の例は`result.json`生成後に実行します。

```powershell
$runDirectory = Join-Path $repository "_testenv/$runId"
$state = Get-Content -LiteralPath (Join-Path $runDirectory 'state.json') -Raw | ConvertFrom-Json
$result = Get-Content -LiteralPath (Join-Path $runDirectory 'result.json') -Raw | ConvertFrom-Json

$wallSeconds = if ($state.started_at -and $result.completed_at) {
  ([DateTimeOffset]::Parse($result.completed_at) - [DateTimeOffset]::Parse($state.started_at)).TotalSeconds
} else {
  $null
}

[pscustomobject]@{
  RunId = $runId
  Status = $result.status
  Exit = $result.exit
  Cleanup = $result.cleanup_established
  Progress = $state.progress
  TotalFiles = $state.total_files
  SchedulerValid = $state.scheduler_valid
  StartedAt = $state.started_at
  CompletedAt = $result.completed_at
  WallSeconds = $wallSeconds
}
```

状態の読み方:

- `queued` / `running`: 非terminalです。`result.json`の有無とheartbeatを確認します。
- `complete`: `exit=0`、`cleanup_established=true`、`scheduler_valid=true`、全ファイル完了を確認して合格にします。
- `timed-out`: 上限超過です。runnerのexit `124`は`phase=runner-timeout`、controller側の上限超過は`phase=timeout`になります。
- `failed`: testまたはcontrollerの失敗です。`exit`と`phase`を併せて確認します。
- `cleanup_established=false`や`phase=cleanup-failed`: process/artifact cleanupの確認が必要です。

`phase=complete`だけで合格にはしません。これは子commandの終了を示す場合があります。
stateは更新用、`result.json`はterminal結果用です。結果を先に保存してから最終stateを更新するため、
一時的に両者の表示がずれることがあります。

### Artifactと後片付け

runごとの保存先は`_testenv/<run-id>/`です。

- `manifest.json`: exact npm command、deadline、Git情報、artifact path。
- `launch.marker` / `controller.marker`: 起動とcontroller所有の記録。同じRunIdの重複起動を防ぎます。
- `state.json`: heartbeat、controller/child PID、進捗、結果の有無。
- `result.json`: terminal status、exit、cleanup、完了時刻、進捗。
- `stdout.log` / `stderr.log`: 各最大1 MiB、1行最大4096文字の保存用ログ。
  `output_truncated`で切詰めを確認します。保存ログが切れても進捗metadataの解析は継続します。
- `stdout.redirect` / `stderr.redirect`: 実行中の一時redirect。通常はterminal処理で削除されます。

既存の失敗・未完artifactは保持します。再実行が必要と判断した場合も、古いRunIdを再利用せず、
前runの終了を確認して新しいRunIdで実行してください。RunIdが異なっても同じworking tree上の
build競合は防げないため、full同士を重ねて起動しません。

controller終了とcleanupを確認した後、不要になった登録Taskだけを削除できます。
これはtestのキャンセル手順ではありません。

```powershell
$manifest = Get-Content -LiteralPath (Join-Path $runDirectory 'manifest.json') -Raw | ConvertFrom-Json
Get-ScheduledTaskInfo -TaskName $manifest.task_name
Unregister-ScheduledTask -TaskName $manifest.task_name -Confirm:$false
```

## 4. 実行時間の履歴と性能計測

成功したfull runは`_testenv/full-test-timings.json`を更新します。
同じplatformの有効な履歴がある場合、nonintegrationだけを前回長かったファイル順に並べます。
履歴がない・壊れている・platformが違う場合は、元の順序へ戻ります。

履歴は**実行順のヒント**であり、test結果の再利用ではありません。ファイルの省略、
最大並列数の変更、排他groupの並べ替えには使用しません。失敗・未完のrunでは履歴を更新しません。
履歴の読書きができなくても、testの合否はtest自身の結果で決まります。

比較では次を記録してください。

- source revisionと差分、Node/npm version、OS、同時に動いている作業。
- 実行command、buildを含むか、開始・終了時刻、wall time。
- test inventory、pass/fail/skip、schedulerの欠落・重複、cleanup。
- 履歴あり／なしと実行順。A/Bでは条件と対象区間を揃えます。

部分区間の短縮、過去時間を固定した順序シミュレーション、full全体の実測は分けて報告します。
並列caseの時間やinclusiveなmethod時間を加算して、全体wall timeとはしません。
state保存頻度の削減も、SSDの物理書込み量や寿命改善の証拠ではありません。

### 限定した性能診断

[`test-performance-runner.ts`](../test/helpers/test-performance-runner.ts) は、通常検証とは別の
観測用helperです。例えば既存の6-unitケースを計測する場合:

```sh
npm run build
node --experimental-strip-types test/helpers/test-performance-runner.ts --target=unit6 --summary-path=_testenv/profile-unit6.json
```

- `unit6` / `npm`の観測上限は48秒です。ここでのtimeoutだけで通常入口のtimeoutとは判定しません。
- `npm` / `integration` / `full` targetには`--npm-cli=<absolute-path-to-npm-cli.js>`が必要です。
  Nodeで起動するため、`npm.cmd`や`npm.ps1`ではなくnpmのJavaScript entryを指定します。
- `integration` / `full`の観測上限は1800秒です。`full` targetにもリリース時だけ実行する規則が適用されます。
- `--summary-path`は`_testenv/`配下のJSONを指定します。比較時はrunごとに別名を使います。
- observer自体の負荷があります。通常実行とinstrumented実行の時間を無条件に同一視しません。

## 5. CLI・実環境の確認

package CLIの対象testと、実OpenCodeがpack済みpluginを読む確認は別の層です。
WSL CLI、packed dependencyの確認、同一sessionの継続、Desktopでの確認は
[CLI testing](cli-testing.md) を参照してください。

関連資料:

- [Release batch](release-batch.md): 明示的なリリース時の検証・配布順序。
- [テスト性能baseline](test-performance-baseline.md): 過去のケース対応と限定観測。
- [テスト性能最適化計画](test-performance-optimization-plan.md): 性能目標と評価条件。

`_testenv/`のartifact、tarball、履歴はGitへ追加しません。共有する証拠はcommand、exit、短いfingerprint、
計測値を中心にし、credential、raw OpenCode session log、内部Project情報を含めないでください。
