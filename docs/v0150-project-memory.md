# v0.15.x: 帰還報告の復元

## 欠落経路と変更時期

- `f5c758c`（2026-10-02T20:43:42+09:00）は、tool-result の返却指示を原文の一度転記から `do not transcribe this card` へ変更。
- `12ec5defb9ceba3682e3e523b965eba8a89abf6f`（2026-10-03T07:42:14+09:00）は、V2 の通常 context と compaction から成功時の `return_report` を除去。
- この組合せは 0.14.9 に残っている。正式 receipt → host によるパネル生成 → tool 結果の保存までは存在するが、通常の最終モデル要求にはカードが渡らない。V2 の terminal finalizer は legacy text hook を呼んでも出力を保存しない accounting-only 経路。
- legacy の `Part.update` 表示経路は V2 公開 API の出力編集機能ではない。確認した `@opencode/client` 2.0.18 の `message` は `list`、`session.message` は `get` のみ。synthetic は入力をキューへ積むため、表示の代替にしない。

上記はコード導入時刻。利用者が最初に症状を見た時刻ではない。保存された利用者申告（`msg_185c40ff0001ONyvFd27uAOh0C`）は「いつからか帰還報告が出なくなっている」で、正確な初発日時は不明。

## 表示責務

V2 は既存の tool-result transport を使う。通常の最終要求には正式な host カードと「原文を一度だけ付ける」指示を残す。host からの二重追記、表示だけの追加モデル turn、完了処理や実作業の再実行は行わない。数値・unknown・留保・正規見出しをモデルに再生成させない。compaction は、後続のユーザー要求がある過去 turn のカード本文だけを省く。完了 tool と最終回答の間に compaction が入っても、現在 turn のカードと表示指示は保持する。過去カードの要約は再表示すべき未完了作業として扱わない。

正式 receipt の成功条件は変更しない。operation の失敗と Mission の受入れは別で、既存報告にある失敗・Review の証拠不足は保持する。通常の未完了・失敗 tool 結果を成功カードへ変換しない。

自動テストは tool 結果、通常のモデル要求、compaction、既存 final hook の非重複を検証する。これは実 OpenCode CLI/UI の最終表示を実証するものではない。固定された統合候補の実モデルによる最終表示確認は、実運用検証で別途必要。
