# Anko再実施後の自己反省と回復経路修正案

## 自己反省

- 終端済みshellが遅延hook-beforeで再活性化した誤停滞と、Worker完了後の新しいRoot実行に古いidleを流用した競合を別々の問題として扱うべきだった。外側shellのexit 0、Workerのテスト・commit、AnkoのReview・受入は別の観測である。
- 未確定の終端・usageを残したまま再実施しても、比較可能な成功にはならない。保存済みpriced小計を最終総額に転用せず、既存履歴を使って原因を修正する。
- operationという分類だけで既存書込範囲内の修正を拒否する製品規則が、同じReviewerの修正・検証・自己再確認を妨げた。これを追加承認や別Reviewerで回避するのではなく、実装と運用で共通の回復経路を使う。
- RootがCoordinator所有の短いReview Taskを直接dispatchした際のlegacy fast-lane拒否も、ファイルシステム故障ではない。所有Coordinator経由という既存経路と、operation修正拒否という製品不具合を混同しない。

## 実履歴の根拠

- 固定候補：main `f109bf0c0d64de3be552288088dec965604f0d1c`、package SHA-256 `5c67dcf8ff9a762062bc69d4beaf14311e66ecb0437e981a019f9c69951f114d`。
- 前回：Mission `mission-30654d69-1060-4d95-90a2-ab20dea56894`。約6分で停止、Anko未受入。
- 追加1回：Mission `mission-9a8b8b08-3002-4840-90b3-4767b8cec64b`、trial `20261006T103412354Z-2cd8f6c0`。本体18m55.039s、Workerは`go test ./...`とcommitに到達、独立Review・受入は未達。
- 保存native列：Worker終了`10:53:12.275Z`、Root新execution開始`10:53:12.294Z`、runnerの続行送信`10:53:12.725Z`。Rootの旧idleは`10:35:21.314Z`。最新execution終端は保存列にない。
- 追加armの保存済みpriced小計は`$0.293475`。最新Root turnと過去欠測があるためarm/campaign総額は不明。
- 原記録は`M:/_work/_Sortie-dogs-artifacts/records/anko-reusable/`に保持する。本PRへ生ログ、DB、資格情報、datasetは追加しない。

## PR案：既存権限内の回復と正確な終端観測

1. operation一律拒否を外し、既存の書込範囲・検証を同じReviewerへ継承する。native V2の同一Task内修正と、終了・reload後の同一Reviewer復帰を両方使えるようにする。
2. operationの実行記録・累計費用・原要求を保持する。修正チェックを本体再実行やoperation成功へ置き換えない。実行していないoperationは自己再確認だけで受入しない。
3. native tool終端とplugin hook終端を同じ観測へ統合する。遅延startで終了済みcallを復活させず、別session/callの本当の停滞は観測する。
4. 最新execution開始より古いidleは完了・続行・settlementに使わない。enqueue応答は終端ではない。保存小計と未確定総額を別fieldで表示する。

## 三要素への適合

- 自律：要求内の修正は同じ著者・既存ホスト権限で続行。新しい承認・role・scope台帳・セキュリティ機構は追加しない。
- 効率：一律拒否を削除し、履歴を使う。新規Worker、定型レビュー往復、版ごとのrunner再作成、追加有料ベンチは実施しない。
- 可視：既存statusの著者・自己再確認・operation結果・費用を別の事実として保持。自己再確認を独立PASSとして表示しない。

既存のホストpermissions、利用者の明示禁止、実チェック失敗、履歴・費用、Rootの意味的受入は維持する。これは新しいセキュリティ段階ではなく、元要求と実観測を偽らないための既存契約である。

## 検証と未確認事項

関連回帰ではnative V2 operationの連続修正、reload後の同一Reviewer回復、未実行operationの非受入、終端イベントの順序競合、settlementと費用表示を検証する。全体検証は修正がまとまった候補で実施し、command・exit・時間は既存test runnerの記録に残す。

修正版の観測関数へ保存済みnative列をoffline再生したところ、最新Root startは`1791283992294`、保存idleは`1791282921314`、最新turn終端は未確認となった。旧`native_settled=true`を再利用せず、原記録・小計は変更していない。

初回限定検証は`npm run test:targeted -- test/reviewer-correction.test.ts test/anko-benchmark-runner.test.mjs test/mission-completion.test.ts test/mission-operation-lifecycle.test.ts`。202件中201成功、1失敗、test exit 1、103,803ms。失敗は新規テストが未実行operationの拒否を例外と誤想定したことによる。既存実装は`status=not-ready/operation_status=not-started`を返しており、製品の拒否動作は変更せずテスト期待だけ修正した。初回証跡は`_testenv/wsl-1791286857335-39912/`に保持する。

最終検証：

- `npm run test:full`：exit 0。113ファイル、1,774成功・2skip・0失敗。controller 296,790ms、test phase 282,010ms。共有runtimeのoperation起動・修正経路変更と既知のテスト期待修正がまとまった候補を一度検証した。snapshot SHA-256 `428b41dc4dfccc54d9f339284224651e89e6c13dd7f0fe05498ab1f97bc45c28`。証跡：`_testenv/wsl-1791287074291-43464/`。
- `npm ci --no-audit --no-fund`後、`npm run test:windows`：exit 0、14/14。build phase 12,581ms、test phase 3,937ms（Node 3,857.8451ms）。全体検証の後にWindows固有process・junction・controllerを順次検証した。
- `node --test test/anko-benchmark-runner.test.mjs`：exit 0、32/32、Node 825.5447ms。全体suiteは`.test.ts`のみを収集するため、最後に調整した観測helperの同一timestamp境界と`.mjs`回帰は別途Windowsで検証した。共有runtime sourceは全体検証時から変更しておらず、全体検証は再実施していない。
- `git diff --check`：exit 0。テストfixtureのmodel routing警告はmock hostによるもので、実モデル推論・有料probeの成功証跡ではない。

追加Anko試行、実モデルprobe、global適用、release、publishは実施しない。従って修正版でのAnko実完遂は未確認であり、過去armを遡及的に成功へ変更しない。
