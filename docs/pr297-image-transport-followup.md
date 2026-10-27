# PR #297: native tool image transport follow-up

## 対象と原因

ユーザーの追加スクリーンショット `23aa71cd08410d2475741953f88d52ca27e146ecd328d0844e69e7f1b7976ca6.png` と、元session `ses_e9ddd9b06ffd6ZE0ehOw8Cxuhf` の公開V2 `message.list` を調べた。対象Missionは `mission-1e4d2c55-b046-4286-82a7-ce196032e9c8`。最後の `INTERRUPTED` は視覚確認未完了を正直に示していたが、作業の実用的完遂には至っていなかった。

- 原添付保存：前修正のmessage-linked添付保存は維持。保存/hash一致は視認の証明ではない。
- toolからモデルへの到達：`src/plugin/v2.ts` の `execute.after` は、native toolの `content` からtextを取り出し、画像/fileを含む配列全体をtextだけに置換していた。変更がない場合も実行され、公開 `read` の結果には `Image read successfully` だけが残っていた。これはSortie内の欠陥。
- browser：元sessionでは `tabs.focus` 成功後も `browser.screenshot` が `Screenshot needs a visible tab` で失敗。今回の調査sessionは `browser.disconnected`。これらは別の接続・可視状態制約であり、今回の修正で直ったとは扱わない。`preview` のユーザー表示はモデル入力ではない。
- 視認・自律継続：画像消失を監督指示の追加や一律停止で補うのではなく、既存の正規画像入力を復元する。

修正はV2後処理だけ。text不変なら元resultをそのまま返し、text変更時もfile等の非textブロック・順序・metadataを保持する。通常Worker Terra Standard/max（Fastなし）、他role、明示override、認証、既存設定、添付保持、監督判断は変更しない。新しい承認gate、証明ファイル義務、画像取得手段の一律指定は追加しない。

## 再現・検証

旧buildを使った追加回帰テストはexit 1（0.593秒）。画像/PDFが消えることを再現した。追加回帰は実際のnative `file` / `uri: data:...` 形式を使用し、公開 `read` とCode Mode `execute`、text不変/変更、file-only、text-only、outgoing contextを検証する。

機能回帰：`npm run test:targeted -- test/v2-plugin.test.ts test/mission-context.test.ts`。新しい差分の83件を検証し、前候補の全体133ファイル・Windows19件・routing等の成功は履歴として保持する。変更していない全体検証を反復せず、実画像の確認は別に行う。

### 同じ公開read・実モデルでの確認

既存Desktop/共有serverを再起動・再読込せず、同じOpenCode CLI `2.1.4` と `openai/gpt-6.1-sol#xhigh` を隔離serverで使用した。通常Workerの設定変更やモデル比較、別APIへのfallbackは行っていない。既存OAuth行だけを元DB read-onlyで隔離DBへ複写し、終了後の隔離credential残数0を確認。元認証DBを変更せず、他sessionを複写しない。

準備時に2回、plugin registryをwarm前に読んで空配列を受け、推論開始前に失敗した（1.712秒、1.557秒、推論0回）。診断で `agent.list` 後の正規registry初期化を確認して修正。同じ失敗経路のまま推論を反復していない。

実確認session：`ses_e83751a4bffehAL9HX1Dkx4ytn`。候補adapter SHA-256：`fc88932a955a7f4b1f473f70b1a18eff1bd1d6e42446ea7eaa0737a910a05e91`。

1. 追加画像を元の保存pathのまま公開 `read`。実結果にtextと `file` / PNG data URIが残り、モデルが「左側にチャットとツール履歴、中央にファイル一覧、右側に市松背景とWeb画像」「INTERRUPTED」と中断理由を読んだ。
2. 同じpromptで、答えを入力していないランダム8桁の文字列を描いたPNGも公開 `read`。モデルは `5C594F10`、左下の青い円、右上の黄色い長方形を識別し、自律的に最終JSONまで返した。最初の確認はexit 0、21.347秒、3モデル応答。
3. 同じ成功sessionを継続し、別入力として元の失敗tool呼出し `msg_17c774610001Z6Tz1IowSl4Tql` と同一の `O:\__gamedev\_AIHosted_mulch\temp\fhd-typewriter\refinement\viewport-home-ja-1920.png` を公開 `read`（SHA-256 `8a48991cb33fbf893f8a20b3d63ce752b6512db2e4683ac561812a74b9f074a7`）。「遊びたい、を 次の約束に。」、淡いベージュ、説明とロボット図・3列・下段2列、細い灰色線と角丸なしを説明し終了した。exit 0、22.863秒、2モデル応答。成功した前入力のやり直しではない。

実確認の合計は1session・2prompt・5モデル応答。raw usage/response ID/画像付きnative messageを `_testenv/image-transport-warmed-20261027/` に保持する。初期失敗記録も別ディレクトリに保持する。生ログ・DB・画像・生成物はGitへ入れない。native cost表示は0だが、subscriptionの実請求USDは不明であり無料・費用削減とは結論しない。以前のMissionの費用不明も引き継ぐ。

## 未解決・適用上の境界

- 成功したのは画像入力の復元と、保存済み実画像を読んだ後の短い自律継続。対象サイトの改修・再deployや美術要件全体の受入、元Missionの完遂を行ったことにはしない。
- Desktop browserの再撮影成功は未検証。可視/接続状態制約は残るが、保存済み画像の公開 `read` は既存権限で使える代替経路になった。
- 稼働中共有host PID `42416` は旧adapter `d223cd12abf0a1a037c4f43c9bcf28615e140799f0e968134a6ca469b60d6735` を保持する。新packageのディスク反映と実読込は区別する。自動restart/reloadをしないため、旧hostでの解消を断言しない。
- PR #297の同branchを更新する。merge、release、publishはしない。同じ固定tgzをnpm-global・C/O同一実体・実global plugin参照先へ適用し、設定不変とpayload/marker/assetsを既存の適用runnerで照合する。
