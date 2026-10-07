# Anko runner: 自律性・効率性・可視性の点検

## 実結果と反省

2026-10-07の初回評価で、公開v0.13.9の固定packageによるLinux Ankoを1回実行した。以下は後続の修正確認とは別の、保存済み初回結果。

- release commit: `19dea054b0b75a0d3a6431251706dfd4731da143`
- package SHA-256: `d193d69cdeb2cd8027067acfbc57f3a44ff00cd571c82164c2e50f666c44632a`
- SOL 6.1/xhighとLuna Fast/maxの実応答を観測。
- 最後のnative streamは開始204,650ms。最初のpatchがrunningのまま残り、3,600,380msでwall上限停止。
- patchは候補repo内2pathと誤ったrepo外2pathを含む。ソース変更・commitなし、Review未到達。
- 既知token価格小計$0.0715642。usage pending/欠測1件。総額・実請求額は不明。
- raw evidence: `_testenv/anko-v0139-linux-20261007/run-1/diagnosis.json`、`session-history.json`、`final-result.json`。

agent側の運用ミス:

1. Windows保存物へ直結した共通runnerの起動失敗を、Linuxそのものの実行不可と誤解した。Linuxの成功履歴・残存imageを先に調べるべきだった。
2. Linuxの旧runnerを復元する際、共通runnerに存在した180秒無進捗監視を引き継がず、約56分36秒の無進捗待機を許した。
3. permission.listとSortie hook境界を保存しなかった。誤pathを観測しても、native permission待ち・hook待ち・その他tool待機のどれかは確定できない。

長時間待機はmodelの熟考の証拠ではない。誤pathと停滞の共観測も因果の確定ではない。

## PR案と実装

### 自律性

- `run`から有料read-only Worker診断を切り離す。必要時だけ`diagnose`を明示し、通常の実装開始前に別model往復を要求しない。
- 過去の特定attempt番号・失敗メッセージを次の診断の許可条件にしない。保存済み同診断は再利用する。
- hostの既存権限を維持。新しい承認層、包括allow、新しいpath拒否を設けない。既存AGENTSの限定once処理とnative ask/denyは変更しない。
- 観測不足だけを理由に製品gateを緩めない。今回`src/`とruntime assetは変更しない。

### 効率性

- 一つのparameterized runnerへWindowsとLinuxを接続。host path/client/Go commandを分離し、Linuxが旧監視へ戻る必要をなくす。
- Linuxは既存toolchainとrepository clientを使用。Windowsは既存CLI/client/WSL Goを維持。
- Linuxのroot lockはSortieの版番号でも変わるため、共通driver再利用の停止条件にはしない。client版は固定し、各armの実lockは実行前に保存・固定する。
- Anko baseと課題原文のidentityを維持し、可変mirror tipや過去の失敗receiptへの依存を除く。
- 既にdirtyのfileの追加編集とuntracked fileの内容変化を進捗として観測。cacheの変化は除外。
- 今回の1回を別runnerへ移してresetしない。旧Linuxの消費済みlockも検出する。

### 可視性

- patchのAdd/Update/Delete/Move全pathをnative event・observer・Sortie hookへ記録。patch本文はこの観測へ複製しない。
- 停滞時はpending native permission、未復帰Sortie hook、native tool開始のみを区別して記録。repo外pathは観測だけで、入力の書換え・新しい拒否はしない。
- 実host/toolchain/hashと検証コマンドを記録。準備成功、model設定、実Worker応答、課題成功を区別する。
- 60分、$15価格推定cutoff、180秒無進捗停止、停止後のbounded回収・費用欠測扱いは維持する。

## 初期PR案の検証

- `npm run test:targeted -- test/anko-benchmark-runner.test.mjs`: 41/41成功。build 7,475ms、test 782ms、exit 0。初回はmockのstall policy設定漏れで38/39、exit 1。mock修正と残り回帰をまとめて再検証した。
- 最終lock再利用修正後の同限定回帰: 42/42成功、build 7,185ms、test 777ms、exit 0。LinuxのSortie版番号更新でもdriverを再利用し、実行中のlock固定は残ることを追加検証。
- `npm run test:full`: 114 files、1,777成功・2skip・失敗0、exit 0。build 7,191ms、test 266,986ms。統合候補で1回実施。最後の変更は共通runner/その`.test.mjs`/文書のみで、このfull runnerが選択する`.test.ts`には影響しないため、限定回帰だけを追加してfullを重複実行しない。
- `node scripts/anko-benchmark.mjs prepare --version 0.13.9`: Linuxで固定package導入・共通profile準備成功。新規arm・provider推論なし。
- `node scripts/anko-benchmark.mjs verify --version 0.13.9`: `retained-arm-consumed`。既存Linux lockを認識し、package hash一致。
- no-model preflight: CLI 2.0.18でSortieとobserverのactiveを確認。SOL/Luna設定を照合。native session 0、credential 0、1,079ms、exit 0。隔離server停止・DB credential行0。記録は`_testenv/anko-runner-autonomy-20261007/no-model-preflight.json`。

この時点の準備/接続確認は改修後の実Worker起動・課題完遂を証明しなかった。追加モデル推論費用$0。command・exit・所要時間・理由は`_testenv/anko-runner-autonomy-20261007/implementation-receipt.json`へ保持。後続の明示的な実行依頼による修正確認を以下に分離する。

## PR #168による実セッション修正確認

ユーザーの「そのPRを使って、ankoを1回」「動いて無ければ動くまで実セッションで確認して直して」に対し、Linuxで7個の名前付き単一armを実施した。共通runnerを再利用し、旧lock・各attempt・費用を上書きしない。途中で評価candidateは更新せず、修正ごとに次のrunner commitを固定した。

全armで同じ公開v0.13.9 packageを使用した。PRの変更はrunner/回帰/文書のみで、`src/`・runtime asset・provider transport・製品gateは変更していない。

### 観測→修正

1. `pr168-live-20261007-01` / `a008d796`: 起動前のScout SOL検査が実V2のLuna routeと矛盾し、推論前に失敗。canonical routeへ検査を修正。session 0、推論0、$0。
2. `-02` / `d0d4800`: `goyacc`不足でWorkerがrepo外toolchainを探索。Sortie hook返却後、native `external_directory` permission待ち180秒で停止。生成ツールを一度準備し、候補内`.gopath/bin/goyacc`とPATH/引継ぎへ渡す。包括permission許可は追加しない。未受理なのにexit 0だった結果表示も修正。
3. `-03` / `20f0dbd`: Workerは実装・正式テスト・commitまで成功。新しく再開した親messageを古いidleで終端扱いし、usage未着時に誤停止。message作成時刻とidleを比較。exit判定の変数スコープ誤りも修正。
4. `-04` / `49c212e`: Lunaの`provider.transport`、WebSocket code 1000、native retry予約を観測。runnerの欠測即停止がretryを中断した。欠測は未知費用として警告・保持し、native retryを先回りして止めない。価格を特定できないモデルの停止、wall/無進捗/既知価格小計上限は維持。費用完全性とMission受理を分離。
5. `-05` / `6e5d4fc`: tool/permission待ちなし、Luna推論deltaが180秒停止。通信失敗の証拠なし。原因未確定のまま、同一candidateを1回だけ測定再確認。推測的な製品修正なし。
6. `-06` / `6e5d4fc`: Workerの実装・正式テスト・commit成功。Review/replanが`descendant_records_unavailable`で止まる。runnerの単なる`serve`には既存`Service.discover()`が参照する登録がなかった。既存`release-cli.mjs`と同じ`serve --service`＋隔離`XDG_STATE_HOME`を使用。実registrationの生成passwordで接続し、metadataのみ保存、停止後にregistrationを除去。
7. `-07` / `403c35b16564ac0baf998c53a15eacdaaa9449ee`: 完走、`accepted: true`、native `succeeded/completed`、exit 0。post-runでservice metadataの保存prefix誤りと、隔離configに残る生成passwordを検出。実prefix `preflight/server`の保持と停止後の隔離`config/service.json`除去へ限定修正。実行後の保持/片付けのみの変更であり、成功armの実行挙動は変更しない。

### 最終armの実結果

```sh
node scripts/anko-benchmark.mjs run --version 0.13.9 --attempt pr168-live-20261007-07 --max-priced-usd 13.7064138
node scripts/anko-benchmark.mjs verify --version 0.13.9 --attempt pr168-live-20261007-07
```

- trial: `20261007T070656644Z-78ddfcb2`。本体1,646,352ms（27分26秒）、shell 1,657,771ms。verifyは`record-integrity-verified`、`benchmark_accepted: true`、exit 0。
- OpenCode/client `2.0.18`、Node `v22.22.1`、Go `go1.27.1 linux/amd64`。runtime marker/hashは初回と同じ固定packageから実loaded値を確認。
- SOL operator: `ses_eead02931ffexNGAza2Y9MEBbG`、Luna Worker: `ses_eeacf8a4bffeslG0kxebM0e2M4`、SOL Reviewer: `ses_eeac40e15ffe5H4YwaLnDOKQCh`。全3session実応答・成功終端、pending tool/permission 0。
- Worker commit `d2d998f284d768a3813ca9f1bbae0fb209db5411`。既存`TestChan`の失敗を修正し、局所回帰と正式`go test ./...`を通過。
- SOL ReviewはMedium 6件を記録し、同じnative Taskで修正。保存関数/集約callbackの現在option、無効時宣言型metadata、Go pointer書戻しのエラー伝播、channel optional targetの誤判定、未知namespace診断、非Env namespaceのpanicを修正。修正前失敗→修正後通過の局所回帰と正式`go test ./...`を確認。
- 最終commit `ceeeaf76a741b5d62174d51f12bc1701e0009758`、候補tree clean、指定base/隔離branchを維持。
- 最終Reviewは`self-rechecked`、未解決findingなし。修正前の独立調査は実施済みだが、修正後は同じ著者の自己再確認であり独立承認とは記述しない。Operatorがnative終端・元要求・receiptを比較しMission受理。
- contextual recovery 0、prompt replay 0。単なるroot idle/succeededではなく、実装・検証・Review修正・commit・受理・native settlementを確認。
- raw evidence: `_testenv/anko-reusable/v0.13.9/trials/20261007T070656644Z-78ddfcb2/`。永続記録: `_testenv/anko-records/v0.13.9/20261007T070656644Z-78ddfcb2/`。candidate source、Git、Mission、native history、DB、package/hash、receiptを保持し、生成installation/cacheのみ片付ける。

### 費用と上限

- 修正確認campaignの既知token価格小計: **$2.95108552**。成功armは109 priced message、推定**$1.65749932**、usage欠測0。
- 先行失敗armのusage欠損6件は保持。campaign完全総額・実請求額は不明。初回評価$0.0715642を加えた全観測済み小計は$3.02264972だが、これも完全総額ではない。
- campaignの既知価格予算$15を固定し、各armへ`--max-priced-usd`で残額を継承。完了時の既知価格残額$12.04891448。未知費用があるため実請求額の上限保証とは説明しない。
- 全履歴と会計は`_testenv/anko-pr168-live-20261007/campaign.json`へ保持。旧lock削除・同じattemptのreset・自動retryによる費用消去なし。

### 最終検証

- `npm run test:targeted -- test/anko-benchmark-runner.test.mjs`: 50/50、exit 0、build 7,059ms、test 767ms。
- service metadata保持prefix・停止後生成password除去の後続修正: `node --experimental-strip-types --import ./test/setup.ts --test test/anko-benchmark-runner.test.mjs`、50/50、exit 0、860ms。build対象変更なし、進行中のfull buildと競合させず既存buildを再利用。
- 最新統合候補の`npm run test:full`: 114 files、1,777成功・2skip・失敗0、exit 0、build 6,947ms、test 274,689ms。新しい実測修正をまとめた統合候補で1回実施。full開始後はrunner `.mjs`・直接回帰 `.test.mjs`・文書だけを変更し、build対象/全体選択 `.test.ts`は未変更。fullの生ログとcommand/exit/理由は`_testenv/anko-pr168-live-20261007/validation-receipt.json`と`test-full.log`へ保持。

### 片付け

全7attemptの完了記録・owned process停止・DB credential 0を確認後、trialと永続candidateコピーの生成`.opencode`/`node_modules`、trial cacheを削除。非installationの設定/agent/plugin/lockは永続記録の`runtime-setup/`へ退避し、古いpluginを通常再起動で読み込ませない。service metadataの永続コピーと隔離生成password除去も補完した。

22path、947,078,544 bytesを除去。作業source/Git・DB・dataset・未確定の証跡・費用記録・固定package/hashは保持。片付け後の同attempt `verify`も`record-integrity-verified` / `benchmark_accepted: true` / exit 0。詳細は`_testenv/anko-pr168-live-20261007/cleanup-receipt.json`。未変更の共通template/toolchainは`verify`と準備再利用に必要なため保持。

## 未解決と次の一手

PR #168によるLinux実セッションの完遂は確認済み。新たな有料armは不要。PRを確認してmainへ統合する段階であり、merge・release・global applyは今回未実施。

Windows実機のAnko起動は未検証（host/WSL commandのmock回帰のみ）。公式採点/hidden grader/追加スコアリングは実施していないため、完遂を公式スコアや全隠しケースの正解とは呼ばない。初回のpatch待機原因と`-05`の推論無出力原因は未確定のまま保持し、今回の確定原因と混同しない。
