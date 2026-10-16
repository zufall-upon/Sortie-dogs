# v0.14.0 dev23 保存履歴の夜間診断（2026-10-16）

対象は固定candidate `e69a3b2317a76eeea1229034f52902812ff1d580`、package SHA-256
`120922c31dd6d85040210d68456192b4e6aa45dc87a11451476f3ed576a68e30` の保存履歴。
元結果は公式正答 **10/23**、Mission完遂 **22/23**。以下の診断・修正はこの結果を変更せず、
現在のmainの正答率や、今回測定した効率改善を意味しない。課題推論・公式採点・Full23の再実行なし。

## pydicom-1139: 直接nextの期待値は公開契約から確定できない

- 保存patchの `iter(pn)` による文字取得・枯渇は公式出力でも通過。
- `TestPersonName.test_next` の直接 `next(pn4)` は、期待された `AttributeError` に対し
  `TypeError: 'PersonName' object is not an iterator` で失敗した。
- 当時読まれた既存公開testsにはこの直接nextの期待値がなく、公開例・既存PersonName testsは通過。
  反復可能性全体の不具合やSortieの検証gate不具合とは断定しない。隠れた期待値に合わせた製品修正なし。
- 別の `TestBadValueRead` 2件の `self.tag` 未初期化は旧pytest setup互換性の問題として分離する。

## pydicom-1413: 同一表現の型群を検証範囲から取りこぼした

- 公開例の `Dataset.add_new(..., 'OL', data)` → `save_as(...)` に対し、保存patchは
  値分割のexclusion setへOLだけ追加した。backslashを含むOLの再現・回帰は検証済み。
- 公開 `VALUE_REFERENCE` はOB/OD/OF/OL/OV/OWをbytesとして列挙し、
  `values.converters` も対応するbytes変換契約を示していた。既存Reviewerもこの箇所を読んでいた。
- 隣接チェックはODのwriter testsを選んだが、問題を起こすbackslash付き代入を通していない。
  公式出力ではOLは通過、OD/OVはbytesではなく分割listになった。正常な隣接名の成功だけでは、
  同じ分岐に残る契約違反を検出できなかった。旧setup失敗2件とは別原因。

### 既存対策の再利用と限界

Cycle032のcommit `050e0afa0c9622dd42552c159573409a7138b6e7` は、同じ診断に対する
汎用ガイダンスを既に実装・検証していたが、main未統合だった。最新main `d566971` を基点に
その小修正を適合する。dispatch/exclusion変更時は既存schema/registryとpublic callersから
同一表現の影響型群を比較し、適切なparameterized checksを再利用する。課題固有名・解答・
網羅matrix・新gate・追加unit/review laneは導入しない。

- 保存済みCycle032ではCoordinator/Sol直実行でsemantic FAIL_TO_PASS 3/3、
  独立Review、通常CLIのMission完遂を観測。ただし公式0/1は旧setup失敗のため不変。
- 別のWorker/Luna経路は初回にOVを取りこぼし、Coordinator指摘後の2派遣目で完遂。
  ガイダンスだけで初回網羅・手戻り削減を保証した証拠にはならない。
- 今回の関連testは役割assetへの配置と既存CLI initによる生成を確認するもの。
  保存済み同条件確認を再利用し、新たな有料CLI完遂や公式正答改善とは主張しない。

## 実作業中に観測した最終check選択の停止

型群対策のPR #264をmain `a644e10`へ統合した後、統合記録を保存し
`git diff --check`を再実行しても、`finish_direct_unit` は更新前のcheckのbindingを選び
`mission-review-correction-validation-stale:git diff --check` で停止した。
登録補正も `mission-replan-terminal-unreconciled:tool_dispatch_active_or_unproven` で拒否。
未変更の全体test再実行による回避は行わず、この具体的な停止経路を次の修正対象とした。

- 原因: `reviewerCorrectionValidation` が最初の全列完了を保持し、後続の最終checkだけの
  成功を完了列へ反映しなかった。以前のprefixは有効でも古いtailが選ばれた。
- 修正範囲: 完了列に続く、同じregistration group内で出現箇所が一意な最終checkの再実行だけ、
  新しいnative callのbindingへ置換する。prefixの実入力・cwd・時間・結果の検証は維持。
  同じコマンドが複数回宣言される場合のoccurrence規則は変更しない。
- 既存fixtureで旧callが選ばれることを再現。通常のnative hookと実shellを使うcold resumeでは、
  prefix→旧tail→レポート更新→新tailの3呼出しで完了し、prefixは再実行しない。
  ソース変更・最新tailの失敗/未知exit・stale bindingは引き続き拒否する。
- これはrepository candidateの修正。共有hostの読込済みruntime更新・再起動・global applyは行わない。
  課題推論・公式採点結果への改善主張もない。新しいソース変更に対する関連・全体検証は、
  先の型群対策の未変更testを証跡整形のためだけに再実行することとは区別する。

## 証跡

- `benchmark-v0140-20261015/swe-dev23/children/007-pydicom__pydicom-1139/usage/opencode.db`
- `benchmark-v0140-20261015/swe-dev23/children/009-pydicom__pydicom-1413/usage/opencode.db`
- 同childrenの `predictions.jsonl` と元公式 `test_output.txt`
- `cycle-032/result-summary.json`、`runtime-type-family-observations.json`、`official-stage-diagnosis.json`

上記相対証跡は既存共有runnerの `_testenv/autodev/sortie-dogs-dev23/` 配下。
生ログ・DB・datasetはGitに追加しない。README・completion-packet・固定結果と費用留保を保持する。
