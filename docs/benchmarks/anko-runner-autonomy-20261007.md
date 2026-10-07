# Anko runner: 自律性・効率性・可視性の点検

## 実結果と反省

2026-10-07、公開v0.13.9の固定packageでLinux Ankoを1回実行した。

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
- Anko baseと課題原文のidentityを維持し、可変mirror tipや過去の失敗receiptへの依存を除く。
- 既にdirtyのfileの追加編集とuntracked fileの内容変化を進捗として観測。cacheの変化は除外。
- 今回の1回を別runnerへ移してresetしない。旧Linuxの消費済みlockも検出する。

### 可視性

- patchのAdd/Update/Delete/Move全pathをnative event・observer・Sortie hookへ記録。patch本文はこの観測へ複製しない。
- 停滞時はpending native permission、未復帰Sortie hook、native tool開始のみを区別して記録。repo外pathは観測だけで、入力の書換え・新しい拒否はしない。
- 実host/toolchain/hashと検証コマンドを記録。準備成功、model設定、実Worker応答、課題成功を区別する。
- 60分、$15価格推定cutoff、180秒無進捗停止、停止後のbounded回収・費用欠測扱いは維持する。

## 検証

- `npm run test:targeted -- test/anko-benchmark-runner.test.mjs`: 41/41成功。build 7,475ms、test 782ms、exit 0。初回はmockのstall policy設定漏れで38/39、exit 1。mock修正と残り回帰をまとめて再検証した。
- `node scripts/anko-benchmark.mjs prepare --version 0.13.9`: Linuxで固定package導入・共通profile準備成功。新規arm・provider推論なし。
- `node scripts/anko-benchmark.mjs verify --version 0.13.9`: `retained-arm-consumed`。既存Linux lockを認識し、package hash一致。
- no-model preflight: CLI 2.0.18でSortieとobserverのactiveを確認。SOL/Luna設定を照合。native session 0、credential 0、1,079ms、exit 0。隔離server停止・DB credential行0。記録は`_testenv/anko-runner-autonomy-20261007/no-model-preflight.json`。

準備/接続確認は改修後の実Worker起動・課題完遂を証明しない。Windowsの実機起動は未検証（host/WSL commandのmock回帰のみ）。本体の再試行、公式採点、release、global applyは実施しない。

## 未解決と次の一手

今回のpatch待機原因は依然未確定。既存履歴を保存したまま、将来の別candidate評価で新しい境界観測を使う。製品の誤拒否・hook停滞が実測できた場合、その原因だけを修正する。元のv0.13.9試行を延長・再送しない。
