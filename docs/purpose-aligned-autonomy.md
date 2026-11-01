# 目的整合型の自律判断（v0.16.x候補）

## 目的と境界

利用者のビジョン・要求成果と、その実現に現在使っている手段を分離する。
小タスクの成功、名前、指示の追加、形式上の完了はビジョン達成の証拠ではない。
既存Operator/Coordinatorが、実際の成果・具体的な未達・既存証拠を照合して手段を選ぶ。
新役職、常駐判断器、毎Task前の確認、追加承認、同コマンド一律拒否は導入しない。

判断は次の既存の節目に同伴する。

- 既存成果が使える：CONTINUE / REUSE。
- 失敗した手段を再試行するか：CONTINUE / CHANGE_METHOD / STOP_METHOD。
- 周辺問題を見つけた：要求との関係を照合し、無関係なら拡張しない。
- 完成候補：元要求と成果・検証・Review・配送・具体的残件を比較する。
- 利用者にしか選べないこと、元範囲・予算の拡張：NEEDS_DECISION。

STOP_METHODは特定の手段を終える判断。Missionの完了・取消やlive processの停止ではない。
必須検証、明示的rollback/recovery、正式Review、root Acceptanceは省略できない。
条件変更・新仮説による正当な再実行は許容し、未変更の成功証拠は既存freshness規則に従って再利用する。

## 最小保存契約

`plan_units` / `submit_mission` にoptional `purpose_decision` を同伴できる。
記録専用のreplan、Task、追加turnは不要。重要な根拠を復帰時に失う場合だけ使う。

- `decision`：上記5種。
- `requirement_ids`：現在の要求ID。
- `observed_outcome`：実際に観測した利用者成果。失敗・未観測も区別する。
- `unmet_work`：具体的な残件。
- `reason` / `evidence_refs`：判断根拠と既存参照。参照先の取得・実行・PASSを意味しない。
- `affected_method`：変更・停止対象の手段。その2判断では必須。
- `next_action`：モデルの提案。hostの正式`next_action`とは別物。

hostがMission ID、run ID、要求fingerprint、時刻、IDを付け、直近8件を保持する。
連続した同一入力は重複保存しない。原要求・ログ全文の複製や独立監査DBは作らない。
旧Missionにfieldがないことは正常。壊れたoptional記録は判断表示から除外する。
同Missionの再開・作者変更時はbriefと既存handoff continuityに渡す。
要求変更後の旧判断はhistoricalとして表示し、自動採用しない。
Missionをまたぐ旧判断はcurrentにしない。元Missionの保存履歴は既存のまま残る。

保存・表示は戦略上の観測だけ。予算・writer所有権・権限・正式証拠・Review・root受入を変更しない。
モデルのREUSE宣言を正式証拠へ昇格させない。空の残件配列も完成を証明しない。

## 相談記録と採否

- 原会話：<https://chatgpt.com/c/6ae2a3d0-23cc-83ee-a1f8-a0ab2e629bb1>。
- 2026-11-01、rootが最新3往復と設計評価回答全文（9109文字）を確認済み。
  同Missionの保存continuityに結果・採否を保持。別プロジェクトの相談で代用しない。
- A「既存Operator/Coordinatorの行動判断強化」採用。理由：新役職なしで元目的と残件へ戻れる。
- B「重要判断の小さなoptional保存」限定採用。現実装のcontinuity notesは自由文の所有者別保存であり、
  要求fingerprintによるcurrent/historical分離がないため、既存Mission内へbounded記録を追加。
- C「新規強制停止・同コマンド一律拒否」不採用。理由：正当な再実行や必須工程を妨げる。
- この段階での行動改善効果は未検証。相談は設計入力であり実行権限・正式検証・Reviewではない。

## 受入条件と実証

1. 保存/読込、旧互換、同Mission復帰、要求変更失効、壊れたoptional記録を限定testで確認。
2. 実public tool経由のoptional入力がWorkerの既存handoffへ届くことを確認。
3. REUSE/STOP_METHOD等の宣言で証拠・正式next_action・必須検証・Review・予算を回避しない。
4. 小さい隔離CLIで実モデル・loaded runtime・成果・残件・復帰・停止理由を観測。
   未変更成果再利用、無意味retry回避、無関係問題への非拡張、必須検証/rollback完遂、復帰時の保持を
   少数の組合せcaseで扱う。関数testや文言一致を実モデルの行動実証と呼ばない。
5. 実装/実証結果を同じChatGPTへ戻し、重要修正とrelease判断の採否・理由・観測効果/未検証を残す。
6. 独立Review、PR既存レビュー回収、最終統合候補test:fullとrelease gateを履行する。
   固定commitと同一package/SHAを使用し、npm publishは今回の手動境界を守る。

## 現在の範囲

開始点main `2a84798fec6b98b131157d9c538d918a07f1c1b7`、公開`v0.15.3`。
PR311（帰還報告・進捗配送）とPR314（外向きlink metadata）は統合済み。
既存ゲーム的UX、日英製品locale、帰還/PACK/unknown表現は変更しない。
ゲーム/GPU/AI/helper/HIPや停止中benchmarkの再開は実証へ混ぜない。
容量逼迫下では既存依存を再利用し、他所有者の退避、DB、dataset、保存証拠、固定packageと費用を保護する。
