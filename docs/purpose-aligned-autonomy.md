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

### 相談その2（2026-11-01）

同じ原会話へ初期候補`d352e12`、限定44件PASSと初期独立Review PASS、実モデル行動未実証を提示。
rootが回答「初期実装評価と実CLI実証方針」9994文字を全文確認。
既存probeのWorker必須成功契約を緩める案より、監視・DB・費用・settlement・teardownを再利用する
薄い行動runner案を採用。理由：Coordinator直実行と同Mission複数turnを独立して評価できる。
実装は`scripts/purpose-autonomy-probe.mjs`。既存成果再利用/非拡張と、代替/rollback/同Mission復帰を扱う。
安全checkpointではnative writers・inbox・idleを既存helperで全確認し、Mission openだけ許容する。
共有service停止・live tool途中のkill・DB直書きは行わない。実証前の効果は未検証。

plan失敗後に判断だけ保存される経路も公開toolで確認する。選択した助言の保持は正常だが実施証拠ではない。
表示へ`application_status: not-established-by-this-record`と、成果/参照はモデル申告でありhost観測ではない旨を追加。
新状態機械は作らない。currentは要求との関連であり証拠freshnessではない点を明示する。
大きな配列の可能性だけを理由にUI全体を改修せず、必要な実測時に範囲を絞る。
CLI結果とrelease判断は次の同会話への相談対象であり、初期PASSだけでrelease済みとはしない。

### 最初の実CLI結果（2026-11-01、未完了）

- 候補commit：`2c9911e50cc9c7d36160f2eb2c2372f41009f51e`。
- package：`0.16.0`、marker：`0.16.0-purpose-aligned-v1`。
- SHA-256：`2a847d323801c27ae0256eee84a8f4bbddf41ef6802b8efbb8401b880faae9a5`。
- runner SHA-256：`180b6dd6308700427b807492445e145cd64c3d016ebb9c87030bececa7cf2bf5`。
- 外側command：`node scripts/purpose-autonomy-probe.mjs run _testenv/purpose-v016/package/sortie-dogs-0.16.0.tgz _testenv/purpose-v016 3 600`。
  exit 1。S1のterminal収集後、履歴tool error 2件をrunnerが拒否。S2/checkpoint/resumeは起動していない。
- S1 root：`ses_e697423b8ffeEZTsUGEGL4D3ll`、Mission：`mission-543988b7-de96-4f44-8d38-82923b5712d8`。
  CLI exit 0、stop false、経過265607ms、正式Mission/receiptはcompleted/succeeded、独立Review PASS。
- Operator SOL/xhigh、Worker SOL/default、Reviewer SOL/xhighをnative messageで観測。
  3session、assistant message 30件。これは課題の実行経路であり改善率ではない。
- loaded markerと候補内adapterのbyte hashが一致。`profiled.js`実測SHA-256は
  `f2ef2e84bad42e6071326e444c7548b4a4e7a4cc7ad4094e8585cf0cf0351eda`。
- `product.json`、`unrelated.js`、全immutable入力はhash不変。必須`node verify-existing.mjs`は1回、exit 0、
  正式evidence `sha256:15d366db9e83173018d6e5ba0e776dbdaf84fd971445854c23b467fbfa569604`。
  成果再利用の実証であり、以前の正式PASSを再利用したという意味ではない。
- 手段記録のための同一plan再呼出しが`SORTIE_FAST_LANE_DENIED: BACKLOG_DRAIN_INVALID`。
  その後も元Mission/正式証拠を維持し再実装・再検証なし。Review初回dispatchも
  `SORTIE_FAST_LANE_DENIED: REVIEW_EVIDENCE_REQUIRED`で開始前拒否。
  モデルが`canonical_validation_exit: 0`、`review_phase: final`、実リスク`process-io`を補い、Review/受入まで復帰。
- REUSE判断は選択済み助言として保存されたが、記録だけの余計なplanと実装source調査が発生。
  正式成果は得られたものの「不要往復のない運用」は未達。履歴error 0だけで評価するrunner契約も見直し対象。
- 換算済み既知費用$0.3916352、unpriced_requests 0。全体請求総額ではない。
  外側$3留保はrunner失敗時のまま保持し、新allowanceで再開しない。
- 保存証拠：`_testenv/purpose-v016/execution.json`、`results.json`、`smoke-1/existing.json`、同stdout/stderr、隔離DB。
  固定package/全証拠を保持。private server PIDの消滅確認後、自作npm cache/tmpだけ約272MiB除去。
  共有service停止・他所有者退避への操作・同条件再実行なし。

次節目はこの実結果を同じChatGPTへ戻し、late判断の記録経路と回復した拒否の評価を比較する。
相談結果・採否の反映前に、別fixtureでS1を自動再実行したりrelease完了としない。

### 相談その3と追評価（2026-11-01）

rootが同じ原会話へS1実結果を提示し、回答7913文字と追回答を全文確認。
初回B案の前提「rootでもsubmitへ同伴可能」は実sourceのOperator controlsと異なると追加照会。
Fast-lane rootはsubmit入口を持たず、検証後の自然な判断保存入口が不足していた。
追評価でA案を限定採用：既に必要な`review_mission`にも同じoptional契約を接続する。
既存Review前提確認後に保存し、判断のために追加Reviewや低リスクskipの格上げはしない。
complete_missionへ万能入口は増やさず、既存plan/submit経路も維持する。
採用時の効果は未検証。旧S1を補正後のfresh PASS/clean実行に読み替えない。

S1の外側exit1/結果/raw記録/旧tgzは保持し、新assessmentへ個別の拒否call→正規次操作→正式状態を記録。
late planは不要操作の放棄、Review拒否は実Reviewerの起動/PASS/受入で回復したという違いを保つ。
未知error・未解決・cleanup失敗・usage不明を一括許容しない。成果成立と効率を分離する。
Review経路の一般gate改修には拡張せず、今回の自然なAPI接続と観測へ限定する。

`continue` commandは旧結果のhash/元$3ローカル台帳/既知費用を継承し、未起動S2だけ扱う。
外部budget承認APIは存在せず要求しない。旧S1のnative idle/所有PID消滅/費用完全性を照合して続行する。
新candidateのtgz/marker/関連実装bytehashを固定。停止済みfixtureの旧package byteを別名保存した上で
新packageへ更新し、依存契約が同一の場合だけ既存依存を再利用する。DB直書きやlive差替えはしない。

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
