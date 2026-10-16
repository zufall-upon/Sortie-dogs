# v0.14.0 保存履歴からの夜間改善（2026-10-16）

## 固定結果と診断範囲

- 元候補: `e69a3b2317a76eeea1229034f52902812ff1d580`、package SHA-256
  `120922c31dd6d85040210d68456192b4e6aa45dc87a11451476f3ed576a68e30`。
- 元結果は Mission 完遂 22/23、公式正答 10/23。不正答13件と費用停止1件を保持する。
  split=dev、max_workers=1、retry_count=0。推論・採点・Full23を再実行していない。
- 既存 `swebench-score-diagnosis.mjs` で保存済み公式ログを読むと、13不正答のうち
  7件は assertion/test failure、6件は collection/import failure。
  pvlib 5件には NumPy 2で削除された `np.Inf` のimport時例外がある。
  これは元の公式FAILを訂正するものでも、各patchが正しいと示すものでもない。

## 1件目: sqlfluff-2419 / Coordinator修正経路

保存された同一Task内で、正しいpatchに対するCLI検証がlint exit 1を期待していた。
実際の既存契約はexit 65。rootが検証を訂正しようとしたところ、次のprotocol tool失敗が
2回記録された（別途CLI検証assertionの失敗あり）。

1. `plan_units(executor=self)`:
   `mission-coordinator-required: dispatch the returned Coordinator task`。
   しかし、この拒否結果にCoordinator Taskは返されない。
2. `operator_next`: `operator-owner-mismatch`。

その後、rootは既存Coordinatorセッションを明示して再開し、候補を変更せずCLI検証を
exit 65へ訂正した。元Taskは最終receiptなしの費用停止、公式採点はPASSのまま保持する。
この経路が費用停止全体を引き起こした、あるいは今回の変更で完遂率が上がったとは主張しない。

### 最小修正

rootが既存Coordinator所有Missionにplanを提示した場合、所有権拒否を曖昧な例外で返さず、
同じMission・Coordinatorセッションへ戻る正確な継続Taskを返す。
Coordinatorまたはunitが稼働中ならTaskを返さず、元セッション継続／native完了待機を案内する。
`executor=self`でも、このCoordinator Taskを新規direct unitと取り違えない。

提案planのadmission、submission、候補、権限、既存証跡、予算は変更しない。
無関係actorの制約や、通常のTask admissionとroot最終受入れは従来どおり。
既存completion-packetとREADMEの元結果記載は保持する。

### 同条件の局所確認

既存 `test/mission-completion.test.ts` の通常Mission完遂fixtureに回帰を追加。
稼働中の重複派遣防止、submitted-readyからの正確な継続先、状態不変、無関係actorの拒否を確認する。
実CLIや元ベンチ課題の再推論ではなく、同じ公開Mission tool・永続状態を使う局所回帰確認。
実CLI完遂率、時間短縮、費用削減、公式正答の改善は未測定。

修正前はimplementation subtestが元履歴と同じ例外で失敗した。
途中の修正では`executor=self`が継続Taskをdirect unitと誤認して失敗し、同じ作者が補正した。
検証command、exit、所要時間、既存レビュー回収結果、費用観測は外部証跡とPRへ記録する。

### PR #263 の既存レビュー

レビュー本文・通常コメント・行コメントを回収した。本文と通常コメントは一般案内／実行状態。
行コメント3件は既存契約と照合し、すべて有効として最小修正した。

- `4289787568`（P1）: opaque参照だけでは未admitの検証修正内容が再開先に届かない。
  既存Coordinatorの認可済みresume promptへ具体的提案と理由・引継ぎを載せ、admission後の受信内容を確認する。
- `4289787576`（P1）: missed `tool.execute.after`／再起動時の古い`dispatchOpen`で誤待機する。
  rootのplan処理で既存のnative終端照合を先に使い、同じCoordinator継続を回復する。
- `4289787581`（P2）: Fast-laneのpending Review中にmulti-unit planを出すと並行Coordinatorを返す。
  pending Reviewを稼働中として扱い、既存のReviewer待機案内を保持する。

初回native独立ReviewはPASSだったが、この3経路の抜けを検出できなかった。
CI成功を指摘解消の代替とせず、同じMission完遂fixtureの関連境界を補正する。

## 継続と会計

実装作者はCoordinator `openai/gpt-6.1-sol`。モデル網羅のWorker委譲なし。
共有runnerへ実装・監督用最大exposure $5を予約し、未確定usageは留保する。
上限は累計 $1166.5503014、nightly $500。旧留保解放による枠補充はしない。
独立有料CLI／課題を追加する場合だけ、従来runnerへ一意な実出力パスと最大exposureを事前予約する。

次は `pydicom-1139` の保存済み `TestPersonName.test_next` 失敗を起点に、
反復可能性とiterator契約の検証不足を診断する。課題の有料再実行や採点再送はしない。
生ログ、DB、固定package、費用台帳、元結果はGitへ追加せず保持する。
継続指示は同じ共有runner向けの構造化`autodev` handoffで渡す。
