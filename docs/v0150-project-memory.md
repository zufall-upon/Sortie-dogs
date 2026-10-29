# v0.15.x: Project Memory と帰還報告

## Project Memory の有効化

初回だけ `sortie-dogs memory on [project-root]`。その後プロジェクトのプラグインをreload。共有サービスの再起動・global候補差替えは不要。`init` と CLI help にもこの導線を表示する。既存の未設定projectは新しい記憶file・専用tool・記憶注入なし。

`sortie-dogs memory status [project-root]` で現在像、pending件数・最古日時・最終成功を確認。`memory off` は実行中インスタンスでもcapture/recallを停止し、保存データは保持する。最初のopt-in前に生成済みのpluginインスタンスではreloadが必要。再有効化は既存履歴を再利用。削除はoffとは別の明示ファイル削除操作であり、自動削除しない。

保存先はユーザーconfig配下 `opencode/sortie-dogs/project-memory/<local-identity-sha256>.json`。local Git common-dir（既存のdurable scope identity）を使い、同一repositoryの短命worktreeから参照可能。remote URLで別cloneを統合しない。Gitなしでは実project pathを使う。project vision、workspace仮案、Mission今回GOはscope/contextで分離。長期記憶にTTLなし。reflection v1/default/明示設定/TTL/managed同期とは独立し、Advisor助言をreflectionへ混入しない。

## 通常判断の処理

v010の公開ユーザーturn（画像only含む）を安定session/message IDのSourceとして保持。synthetic入力やchild Taskをユーザー原文と扱わない。原文と画像URL/MIMEを保持し、画像を見た・画像が永続的に取得可能という証明にはしない。外部任意会話は自動取得しない。通常Operatorが専用 `sortie_v010_project_memory` 一つへ意味差分を返す。専用の毎turnモデル・新役職・schedulerなし。

- Source: 観測した原文、actor、出典、添付参照、availability。
- Event: vision/constraint/decision/unresolved/result、提案/採用/撤回/未検証、理由、supersedes、出典、操作ID。Advisorの既存ID/native callID・採否・効果（改善/不変/悪化/未検証）も関連付け可能。
- Snapshot: Eventから都度再構築。撤回を除去して古い採用案を復活させない。workspace案をproject visionへ自動昇格しない。

既存のMission開始・単位結果・Review・提出・正式完了tool結果と、native Advisor/Scout相談の実応答も別actorのSourceとして保持する。ユーザー発言と偽らず、native outcome・child/model/callIDと意味上の採否/効果を分離。処理済みユーザーSourceを改変せず、その後の結果・採否変更を新SourceからEventへ追加できる。

Mission外の通常PM相談も、既存Advisorの応答・質問・callID・child/modelをSourceへ保持する。背景起動のackだけを相談完了と扱わない。通常Operatorが採否をEventへ関連付けるまで、応答は観測・未処理のままであり、採用や効果をhostが推測しない。

toolの `request_json` は `action: recall|source|apply`。recallはqueryに関連する現在像と未処理原文を返す。原文excerptが切られた場合はsourceで全文取得。applyはsource/operation/changesを受け、`changes: []` は明示no-change。訂正は新Sourceと現Eventのsupersedesを指定。Snapshot競合なら再想起して訂正し、同じ処理の再送は同一operationで冪等。SourceとEventを混同せず、processedとEventは同一atomic renameでcommitする。排他競合はbounded retry、失敗時はpendingを残す。中断でlockが残った場合はエラーに出たlockのowner停止を確認してそのlockだけ除去し同じ処理を再送。壊れた/将来schemaのデータを空で上書きしない。

次の通常判断/新sessionでpendingとSnapshotを提示して漏れを回復する。意味抽出の完全性・追加費用ゼロは保証しない。モデルの採否/効果記録は実測証拠の代わりではない。PM判断とAdvisor独立評価の改善はopt-inに従属しない。元要求→実物→正式check→Review→delivery→未達を照合し、必要画像は実際に取得評価する。既存native AdvisorへGoal→Constraints→Observed facts→Questionを送り、自己推奨案は初回独立評価後。既存相談上限・モデル差替えを維持し、助言/記憶を権限・Review PASS・正式検証にしない。製品にブラウザ自動操作を必須化しない。

実装fixtureだけを実運用完遂と扱わない。固定統合候補による実OpenCode/実モデルで自然訂正・新session想起・Advisor実派遣・採否効果想起・未完成報告のPM判断・画像評価・off/通常Mission非回帰を別途検証する。Codex側への自然capture接続はこのv010 OpenCode経路とは別で、未検証。

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

## 実CLI launcherの再利用

隔離setupの `environment.json` を再利用して `node scripts/qualification-turn.mjs <label> <session|-> <message>`。別setupは `SORTIE_QUALIFICATION_ENV`、CLIは `SORTIE_QUALIFICATION_CLI` で指定する。結果はsetupのbaseへ保存し、費用unknownを維持する。`SORTIE_QUALIFICATION_TIMEOUT_MS` は1000〜900000、既定180000。

正式履歴のowning-service fallbackが必要なMissionでは `SORTIE_QUALIFICATION_MANAGED=1` を使う。専用 `base/state` のXDG_STATE_HOMEでmanaged serviceを分離し、共有hostのregistration・global候補を変更しない。stdio standaloneは公開履歴APIがないhostでこのfallbackを利用できない。背景Taskは起動ackと完了を区別し、native final/receiptを別途回収する。終了後は同じ専用XDG_STATE_HOMEでそのserviceだけ停止し、観測・DB・成果・設定は保持する。

OpenCode 2.2.0/SOLで、自然訂正・新session想起・off、独立Advisorの実応答と採否理由/効果未検証の想起、未完成報告のOperator受入拒否を確認。通常の限定inventory実装Missionは正式check→独立Review→receipt→最終ユーザーMarkdownへ同一hostパネル一度、まで確認。小成果の成功は製品全体の受入ではない。元添付画像は相談の誘導性と旧Gemma表示の診断材料であり、pixel一致のUI目標ではない。desktopの実レンダリングと画像生成能力は、このCLI確認で実証したとは扱わない。

保存観測は `_testenv/v0150-qualification/`（Git対象外）。`native-mission.json` の成功完了toolから取得した `return_report` と、同じsessionの最終assistant本文（`normal-mission-final.md`）を完全一致で照合し、一度だけ含まれることを確認した。対象goalは `sha256:38e3e624e7d3ca652df059fa1ea92d0df1dae5efc4e55567da434a357c594b64`。実装・Advisor・独立Reviewerのnative assistant modelは全て `openai/gpt-6.1-sol`。報告パネルの費用予測は累計実費と同一視せず、今回の費用はunknownのまま保持する。

再起動時のunit process-defectと、製品のsource検証失敗は別である。完了済みの実モデル推論を再実行せず、残存native記録を照合する。`ca0590e` の一般PM相談応答capture補正後は統合候補の正式検証が必要。開発中ChatGPTの結果相談、独立source Review、PRレビュー回収・main統合・固定成果物によるreleaseは別途完了が必要で、CLI小成果やunitの成功だけでは満たさない。
