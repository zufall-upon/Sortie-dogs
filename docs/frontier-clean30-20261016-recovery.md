# Frontier clean30 v0.14.1: 中断試行の回収

## 固定比較条件

- Product commit: `cc7481e5fe2ed89ec6baddc22b1feb317fc2fd0f` (`v0.14.1`)。
- Package SHA-256: `d4e51f5fa4e2084d26cbc0a278570d764c997d4517b27a64a6200e2ead661859`。
- Official eval commit: `e837a70bd6beb4e72eeeda62dd06e3bd34f6cb63`。
- clean30 inventory SHA-256: `76e02afaf7ec01d3ba55cd5f045226d500089f154f0e92277ea8cecc7def6f3e`。
- 既存正式2-slot入場条件を実測通過。SWE用の推論4並列は転用していない。
- Run ID: `2397cd1549ed4b789f2e26b8069fdd68`。固定package・inventory・公式verifier・凍結runner・元state/reportは変更していない。

## 観測結果

元native shell callは `2026-10-16T06:35:42.185Z` 開始、`07:35:53.556Z` にerror終端を観測。親processのexit codeは未回収であり、30件完了とは扱わない。

開始済みは `anko-typed-variable-bindings` と `arktype-json-schema-refs-dependencies` の2件、残28件は未開始。回収時点で親runnerと所有OpenCode server 2本は不在、監視process 2本はsleepingで生存し、zombieではなかった。所有を確認した監視2本だけへSIGTERMを送り、同じ試行のCLIログ・native DB・usageを保存、所有processの終了を確認した。課題・model promptの再送、共有hostの再起動、他利用者processの停止はしていない。

両CLI rootはcode 0で応答を出していたが、Missionは両方running、succeeded receiptなし。したがってMission完遂は **0/2**。CLI終了や最終応答をMission成功の代用にしていない。完了assistant usageは25件、未完了は2件。実モデルは `openai/gpt-6.1-sol#xhigh` と `openai/gpt-6-luna-fast#max`。

未実施だった公式verifierのみ、元の停止workspaceに対して各1回回収した。既存公式Pierのcollectと `_verify_once` を使用し、`Trial.run`・agent再実行・verifier retryは行っていない。元patchは両方空、公式rewardは両方0。残28件は未採点であり、これはFull30の成績やleaderboard結果ではない。

回収時の会計snapshotでは、2課題の既知推定額合計 `$0.26323572`、未確定留保合計 `$3.73676428`。別に実装・監督 `$5` の未確定留保を保持。共有合計はpriced `$566.02364072`、held `$280.89447768`、exposure `$846.9181184`、累計上限 `$1166.5503014`。nightly増分はpriced `$108.73810432` とheld `$71.62971268` で既存 `$500` 枠内。この時点のAPI換算推定であり、請求額や後続実装・レビューの最終総額ではない。

生証跡はGit外の `_testenv/frontierharness-v0141-clean30-2slot-20261016/` に保存：`recovery/before-*`、`recovery/native-before-teardown.json`、各trialのhistory/observation、公式verifier初回記録、`native-terminal-observation.json`、`accounting-after-run.json`、`one-pass-summary.json`。

## 1原因の最小修正

監視は既存の所有serverの `closed` promiseを参照せず、server消失後も保存されたnative pending状態を待っていた。所有server消失の正確な時刻・原因は未確定。本修正は最初のserver消失やouter中断そのものを解明したという主張ではない。

最小再現の前提は、root CLI終了・所有DBにpendingあり・所有server終了。旧実装ではtimeoutまで分類されなかった。修正後は `server-close` のobservation failureを記録し、元CLIのcode/signalをserver exitと分けて保持、usage不確定の留保を維持し、所有teardownを1回だけ行い、no-replayの次操作を示す。意図したteardownや先行する停止原因は上書きしない。

同条件のローカル再現はモデル呼出し・消費済み課題の再実行・公式再採点なし。ベンチ正答率改善や実campaign時間短縮の測定とは区別する。

## 自律性・効率・可視性の点検

- **自律性:** 既存lifecycle観測を利用するだけで、独自承認・追加権限境界・model route・controller・scope制限・security gateは増やさない。正当なhost権限と利用者禁止は維持。
- **効率:** 所有backend消失が確定した待機を止め、保存historyと既存testを再利用。自動再派遣・課題retry・再採点・Full23/Full30・通知専用reviewerは追加しない。未測定の節約を主張しない。
- **可視性:** CLI終了、server終了、Mission/receipt、公式reward、usage不確定を分離。最初の停止原因と次操作を残し、成功や費用ゼロを捏造しない。
- **最小対策:** 意図したserver teardownと既存停止原因を除外。予期せぬserver消失後は最終DBが読めてもusage coverageを未確定扱い。既存timeout/cost上限は緩和・置換しない。

## 検証・残作業

- 旧実装の最小再現は `timeout` と誤分類して失敗。修正後は同じ前提で `server-close` を記録。
- `npm run test:targeted -- test/mission-cli-probe.test.ts`: 98/98、exit 0、build 7.35秒＋test 38.11秒。
- `npm run test:full`: exit 0、125 test files、test 325.49秒。コード未変更の文書追記ではこの結果を再利用する。
- 回収検証は2件開始・28件未開始・公式採点2件・正答0件・Mission完遂0件・29 request audit eventsを確認。

元call `call_16747cbb0dc54565acae7ddebb041699` / shell `sh_1436c6eec001OWegt9UYdeQldL` はnative履歴にerrorが残るが、現在のshell取得・output取得APIはともに `ShellNotFoundError` (HTTP 404)。保存shellファイルも不在。元exit codeを復元できず、別commandの終了を流用しない。

残28件は元runnerのfail-stop・未確定usage・起動整合を解決せず有料再開しない。元commandは再送せず、保存失敗に基づく要求内のsource修正・PR作業を続ける。release・tag・npm publish・global apply・共有service再起動は禁止のまま。
