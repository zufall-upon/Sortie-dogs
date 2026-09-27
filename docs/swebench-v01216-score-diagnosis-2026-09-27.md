# v0.12.16 dev23: スコア低下の診断と自律ループ改善PR案

## 結論

**公式結果は4/23。前回5/23との差分は、解決済み2件のtimeoutと、新規解決1件で説明できる。**
現時点でWorkerのモデル品質低下、8並列化、v0.12.16の製品変更のいずれかを根因とは断定できない。

| 前回からの変化 | Instance | 今回の直接の結果 |
| --- | --- | --- |
| resolved → 空patch | `pydicom-1694` | Workerの誤った絶対パスへのreadが約38.7分戻らずtimeout |
| resolved → 空patch | `pydicom-1256` | 修正・検証・Reviewer PASS後、次の応答が未完了のまま約22.1分でtimeout |
| 空patch → resolved | `sqlfluff-1733` | 今回は公式テスト合格 |
| resolved維持 | `marshmallow-1343/1359`, `astroid-1196` | 3件維持 |

停止を解消した場合のスコアは未測定であり、上記2件を加算した仮想スコアは出さない。
保存された実Workerのassistant履歴では、観測モデルは全件`openai/gpt-6-luna-fast#max`だった。

改善の中心は、**原指示 → Operator → Coordinator → Workerの修正ループ → Operatorの品質判定**を通すこと。
`sqlfluff-1763`には、Operatorが弱い完了候補を退け、同じCoordinatorへ戻した実例がある。
この差し戻しは期待動作であり、修正対象はその後のローカルパス誤記・長時間停止と、判定に渡る証拠の質である。

## 固定条件・分析範囲

- Candidate: 公開`v0.12.16`、commit `9b05a348418a09d4dd074d1258eed7a0efe6a04b`。
- Package SHA-256: `95d3c8c6a06ea03168538117d4d3ef456d5642252d6791b0f62271486cc0cb92`。
- Runner: `b1a6c0e390e9d8b0ba0adcad3334e4661b879bf7`。後続の修正を実行途中に適用していない。
- 23件各1回、8枠、40分/件、`official-image-testbed`、$1.50/件・$34.50/run。
- Predictions SHA-256: `a616a2152fe89f473f1f1b63b2d00f283857d5ffe2b16e7d5fa851fa3235ac4b`。
- 公式採点: SWE-bench 5.0.2、`dev`、1 worker、1回、exit 0。4 resolved、14非空unresolved、5空patch。
- 比較対象v0.12.15は4枠。同一条件での因果比較ではない。
- 保存V2 DBはOpenCode 2.0.18。現在のOpenCodeセッションで履歴・公式ログ・公開問題文・候補patchを照合した。
- 追加のモデル推論は起動していない。後述2件だけ、既存のtest-reset helperによるモデル不要の補助検証を行った。

公式推移表・run全体の費用とrunner修正は[PR #86](https://github.com/zufall-upon/Sortie-dogs/pull/86)を参照。
この文書は調査と実装提案であり、以下の製品改善はまだ実装・効果測定していない。

## 1. timeout 5件の停止位置

時刻は2026-09-27 UTC。readは`time.ran`、1256は`time.created`から終了までを示す。

| Instance | 最後の未完了操作 | 待機区間 | 根拠の強さ |
| --- | --- | --- | --- |
| `pydicom-1139` | 2人目Workerの最初のhandoff read | 04:17:22–04:53:16、35.9分 | 入力パス誤記・実行開始を確認 |
| `pydicom-1694` | 最初のWorkerのhandoff read | 04:20:31–04:59:12、38.7分 | 入力パス誤記・実行開始を確認 |
| `pyvista-4315` | Workerの`pyvista/core/grid.py` read | 04:27:19–05:05:55、38.6分 | 入力パス誤記・実行開始を確認 |
| `sqlfluff-1763` | 差し戻し後Workerのmanifest read | 05:00:24–05:19:06、18.7分 | 入力パス誤記・実行開始を確認 |
| `pydicom-1256` | Coordinator応答中の`sortie_v010_operator_status` | 04:35:36–04:57:39、22.1分 | tool生成は確認、実行開始は未確認 |

### 4件共通: パス再生成と無人実行中の待機

実際のrootは`.../swebench-v01216-dev23-night-20260927/...`だが、4件ともread入力が
`.../swebench-v01216-dev23-nightly-20260927/...`になっている。
正しいroot/handoffはhost生成のWorker promptに存在する。Runnerの元指示も相対パスを要求していた。
つまり、注意書きは既にあり、長い絶対パスをモデルが再出力する経路が残っていた。

最終エラーは`Interaction cancelled because the location shut down`。
外部ディレクトリへの誤読によるhost interaction待ちと整合するが、**permission待ちの種類・request IDまでは確定していない**。
cleanup後DBの`session_pending`・`session_inbox`・`event`はいずれも0行で、停止直前の状態を復元できない。
この終了時エラーを根因として扱わない。

### 1256: status実装のdeadlockとはまだ言えない

04:35:19にReviewerがPASSを返している。直前のWorker報告には最小再現・4テスト通過がある。
次のCoordinator assistantは`operator_status`を生成したが、toolの`time.ran`と`providerState`がなく、
assistantのusage/finishも通常完了していない。`time.streamed`はcleanup時刻まで伸び、最後は`Step interrupted`。
これは未完了provider streamやhostの実行前待機とも整合する。status内部の再帰・lockを根因とする証拠はない。

Runnerは正常終了時だけpatchをcaptureし、その後workspaceを片付けるため、timeoutのpredictionは空になる。
したがって「空patch」は「ソース編集なし」を意味しない。1256と1763には編集・検証の履歴が残っている。

### 期待どおりのOperator差し戻し

`sqlfluff-1763`のOperatorは04:59:23に同じCoordinator
`ses_f1ed6f23affeoI0P05xJBacZGS`へフィードバックを送った。
候補はファイル切詰めを防ぐだけでUnicodeEncodeErrorが残り、直接`persist_tree()`を叩くテストしかなかった。
Operatorは元の`fix` CLI・UTF-8入力・戻り値・ファイル内容での確認を要求し、Coordinatorは修正Workerを起動した。
ユーザーの「続けて」を挟まずに品質未達を差し戻している。そのWorkerが上記のmanifest readで止まった。

## 2. 非空unresolved 14件の分類

一次分類は**環境で起動不可5、公式テスト適用衝突2、動作/期待契約の不一致7**。
複数要因のある件は下表に併記する。公式aggregateの`infra_failure=0`は環境問題の不存在を保証しない。

| Instance | 公式ログ・候補diffから確認したこと | 改善への意味 |
| --- | --- | --- |
| `pvlib-1072/1154/1606/1707/1854` (5件) | 全件conftest importでNumPy 2の`np.Inf`廃止により停止。候補patchはrun logでは適用済みだがreportの`patch_successfully_applied`はfalse | reportフラグだけからpatch適用失敗・実装不良と判定しない。環境互換性と実装効果を切り分ける |
| `pydicom-901` | 候補が新設した`pydicom/tests/test_config.py`と公式新設テストが衝突。候補テスト3件のみ通過、公式の期待5件は未実行 | 補助検証では衝突解消後も5件不合格。採点衝突に加え、期待されたlogger/`debug` APIとの不一致がある |
| `sqlfluff-2419` | 新設`test/rules/std_L060_test.py`が衝突。候補の1テストのみ通過、公式期待テストは未実行 | 補助検証では公式期待テスト通過。実装失敗に分類するのは不正確 |
| `pydicom-1413` | OD/OLの2件は通過、OVのbytes扱いが不合格。加えて既存2件が`self.tag`未初期化で失敗 | 関連VRの境界不足とpytest環境問題が混在 |
| `astroid-1268` | 例外は消えたが文字列表現が`Unknown`、公式期待は`Unknown.Unknown()` | 候補テストが実装と同じ期待値を新設。公開慣例から期待値を根拠付ける必要。問題文自体は正確な文字列を指定していない |
| `astroid-1333` | namespaceの別経路は検証したが、`modpath_from_file('src/package', ['.'])`がImportError | 公開再現の相対パス・cwd・入口APIを保持して検証する価値が高い |
| `astroid-1866` | `TypeError`を捕捉したが`'{:4x}'.format('1')`の`ValueError`が未捕捉 | 同じ変更分岐の隣接エラー条件が未確認 |
| `astroid-1978` | `FutureWarning`抑止は実装。公式はmodule getattrのstdout/stderrをloggingへ捕捉する挙動を期待し、`caplog.text`が空 | 公開問題より広い期待契約との不一致。単純に「警告抑止が動かない」とは言えない |
| `sqlfluff-1517` | セミコロンでのcrashは解消、診断文が`Found unparsable section`、公式期待は`Could not parse` | 外部向け診断の意味・互換性を確認。公開問題は具体的診断文を指定していない |
| `sqlfluff-1625` | 候補はTSQL/no-JOIN時のL031抑止を実装。公式はCLIのL031説明文変更を期待し不合格 | 問題の解釈と公式期待のずれ。TSQL再現の通過だけでも、公式の文字列だけでも一般的品質を断定できない |

以前のgold検証は15/23で、同じpvlib 5件、pytest旧setup互換性の`pydicom-1139/1413`、
`libGL.so.1`不足の`pyvista-4315`が失敗している（[環境記録](swebench-lite-benchmark.md#optional-prepared-official-environment)）。
これは2026-09-25の環境観測であり、今回19件の未解決をすべて説明するものではない。

### モデル不要の補助検証: テスト適用衝突

既存`main`の`scripts/swebench-test-reset.py`を再利用した。
公式`eval.sh`のtest-file resetだけを正規化し、baseに存在しない新設テストを一時コンテナから取り除いて公式test patchを適用した。
候補patchと公式test patchの内容は変更していない。元のpredictions・公式ログ・4/23には反映しない。

| Instance | 固定image ID | 補助検証結果 |
| --- | --- | --- |
| `pydicom-901` | `sha256:9eefbfc3074839815a9f3a319a78980aa2d568b828087457df54e11caf849865` | 公式期待5件実行、5件不合格、test exit 1 |
| `sqlfluff-2419` | `sha256:881e3b830d8a68b52041b8ec79af813d12adf75d0c1838b17950e5a5b6238353` | 公式期待1件実行・通過、test exit 0 |

両方ともtest patchの適用エラーは消えた。外側script/container exitは両方0だったため、
**外側exitだけで成功とせず、`Test Exit Code`と実際のテスト名・結果を確認した**。
補助結果から公式スコアを5/23へ書き換えることはしない。検証コンテナは終了・削除済み。

## 3. 改善PR案（小さいテーマ順）

### P1: Workerに渡すローカル参照を短くし、同じ任務内で作業を継続する

**狙い:** 4件で観測した長い絶対パスの再構成を減らす。最初の単件対象は`pydicom-1694`。

- `src/core/operator-runtime.ts`の生成prompt、`src/core/operator-mission.ts`のbrief、
  `src/runtime-mission-assets.ts`のWorker案内を対象とする。
- 同じproject root内のhandoff/manifest/source参照はhostが相対表示を生成する。
  正本のパス・hash・unit所有者はhost側に保持し、consumerはセッションのproject rootを基準に解決する。
  外部出力を指定した操作任務は既存の絶対パス表現を使う。
- `goal_declaration_path`を再読する継続・完了処理、handoff readの照合、bind/release、
  修正契約・resumeにも同じ解決規則を適用する。単にpromptの文字列だけを変える変更では不十分。
- 通常のファイル未発見はWorkerが正しい参照を使って続行し、契約修正が必要ならCoordinatorが同じ任務で修正する。
  追加のユーザー承認ステップは設けない。

**検証:** 長い`night` rootのfixtureでread→bind→編集→検証→差し戻し→同じCoordinatorの再開→完了を検証。
cwdが別のhost processでも正しいunitへ解決されること、以前の絶対参照の保存状態からresumeできることを確認する。
現在のV2実セッションで単件のWorker実モデル・最初のread結果・完了まで観測する。
相対表示だけで誤記やhost待ちが完全になくなるとは主張しない。

### P2: timeout前の状態を保存し、確認できた停止だけを既存ループへ返す

**狙い:** `pydicom-1256`の「応答未完了」「tool開始前」「tool実行中」を区別できるようにする。

- `scripts/swebench-lite-runner.mjs`のwatchdog/cleanupに、停止前のnative session状態、
  pending permission/form、tool作成/開始/終了時刻、最後のstream更新、usage確定状態の保存を加える。
  取得不能時はその事実を残し、既存のdeadline処理を進める。
- timeout直前の作業diffも診断artifactに保存し、空predictionと編集有無を区別できるようにする。
- 実行中の長い検証、permission待ち、provider stream停止を別に表示する。
  再開はnative childの終了が確認できた場合に同じCoordinator・同じbudget・保持済み検証から行う。
  プロセスが動いているか不明なままWorkerを重複起動しない。
- `src/plugin/v2.ts`のstatus処理変更は、観測でその処理まで到達した証拠を得てから決める。

**検証:** 未完了stream、実行前tool、実行中shell、interaction待ち、cleanupでpending消失、snapshot取得失敗のfixture。
終了・再開を伴うケースでは費用/予約の継承、二重dispatchなし、進行状況の表示を検証する。

### P3: 既存の品質判定へ、公開仕様と期待値の根拠を渡す

**狙い:** Operatorが「自身の実装に合わせて書いたテストのPASS」を原指示達成と取り違えにくくする。

- `src/runtime-mission-assets.ts`のCoordinator/Worker/Operator案内と既存のreview/submit証拠に、
  公開再現の入口・入力・期待結果の根拠・実際の結果を簡潔に残す。
- 具体的に未解決の懸念があるとき、変更分岐に近い反例を1件選ぶ。
  例: relative cwdの公開再現、同じformat処理の別例外、CLIの戻り値とファイル内容。
  再現と既存の公開慣例で十分なら、チェックやレビューの周回を追加しない。
- Operatorはその証拠を原指示と比較し、不足なら既存の同一Coordinator再開で具体的な修正を返す。
  再現・修正・確認の判断をユーザーへ戻さず、成功済みの環境準備・無関係な検証を再実行しない。
- 隠れた公式テストの文字列を製品promptや合格条件へ埋め込まない。
  `1268/1978/1517/1625`のような公開問題との期待差は、製品不良の確定根拠と区別する。

**検証:** 1763のように局所テストは通るが原指示のCLI動作が未達の完了候補を与え、
Operatorが同じCoordinatorを再開し、修正後に完了するシナリオ。
元の要件・累計費用・完了済みの仕事が引き継がれ、ユーザーの「続けて」が不要であることを受入条件とする。

### P4: 採点の説明を正確にする（既存helperを活用）

- `scripts/swebench-lite-grader.mjs`周辺の結果要約に、candidate patch適用、test patch適用、
  collection、期待テスト実行、assertion失敗の各段階を付記する。
- `pydicom-901/2419`の衝突には既存test-reset helperの補助結果と正規化前後hashを添付する。
  公式結果はそのまま保持する。テストを追加したこと自体をWorkerの違反にしない。
- `np.Inf`とpytest旧setupのような環境要因は、既存環境証跡を再利用して記載する。
  将来の環境修正は別の固定条件として、同じ候補patchでまず単件確認する。

**検証:** 候補テストのみPASSだが公式期待テストが未実行、import失敗なのにreportがpatch未適用を示すケース、
外側exit 0かつtest exit 1のケース。`resolved`の公式判定と診断分類を混同しない。

## 4. 次の実行と予算

1. 最新`main`からP1を1テーマで実装し、関連するmission/child lifecycle検証を行う。
2. 現在のV2セッションで`pydicom-1694`を1件再現し、Workerの初回readからOperatorの完了まで確認する。
   単件上限$1.50、Workerは`openai/gpt-6-luna-fast#max`、同じ累計台帳を継承する。
3. 修正をPR経由で`main`へ統合後、packageと条件を固定して次の評価へ進む。
   今回の23件・各1回の公式結果と、学習済み単件再現は別実験として記録する。

今回の調査で追加の有料推論・追加Reviewer呼出しは起動していない。
記録済みcampaign費用・未確定holdを含む保守的露出は**$155.22517132 / $185、残$29.77482868**。
これはbenchmark台帳上の値であり、この対話の利用料金を新たに計測した値ではない。
PR #86は調査時点でOPEN・MERGEABLE、既存CIの`npm test`2件SUCCESS。ここで挙げた製品改善の検証結果ではない。

## 5. 証跡と再現

保存root: `/home/user/Sortie-dogs/_testenv/swebench-v01216-dev23-night-20260927/`。

- `diagnosis/extract.mjs`: read-onlyで23 DB、公式ログ・reportを抽出。分類件数・4件のパス誤記・1256の実行開始未記録をassert。
- `diagnosis/evidence.json`: 入力ファイルhash、失敗toolの時刻・入力、公式失敗テスト、実モデル、Operator差し戻し。
  SHA-256 `23f1d41d001e1fefac2a47df1e206cec5919d2e453165218b78910e784ba032b`。
- `diagnosis/test-collision.py`と`diagnosis/test-reset/results.json`: 補助検証のコマンド、固定image ID、patch/helper/output hash。
  helper SHA-256 `c05cfe0e8e0d6285c0e95b4a4aab1176802969a2fca13ed67ff1a878106b58f9`。
- 1694: `run/children/010-pydicom__pydicom-1694/usage/opencode.db`、Worker
  `ses_f1ee83842ffe84doCLzwJz4EKH`、assistant seq 5。
- 1256: `run/children/008-pydicom__pydicom-1256/usage/opencode.db`、Coordinator
  `ses_f1eea8a20ffe6aDSVfYXJERzRY`、review返却seq 221、未完了応答seq 230。
- 各公式結果: `scoring/logs/run_evaluation/sortie-v01216-dev23-night-20260927/sortie-dogs@0.12.16+95d3c8c6a06e/<instance>/`。

抽出の再実行は`node <保存root>/diagnosis/extract.mjs`。
補助検証は`python3 <保存root>/diagnosis/test-collision.py <mainのscripts/swebench-test-reset.py> <新しい出力directory>`。
各instanceの出力先が既存なら上書きせず終了する。
生ログ・DB・dataset・predictions・生成物はGitへ含めず、この要約と条件だけを残す。
