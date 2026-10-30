# Review準備の外向きリンク停止：限定修正

## 観測と原因

- 2026-10-30、`/home/user/KF1Revival` の保存履歴で、Review Task生成前の `declared-artifact-link-outside-scope` を確認。Reviewerの不合格ではなく準備停止。
- 対象Missionは `mission-e932c978-0338-453d-aa0c-a46277801864`。最新保存context `context-dbcaf6e86a5707b1754dbb38679319355491fdd60e1d08664ecc55249ad9a811.json` のReview失敗・実装読取記録と照合した。累積write scopeに既存Proton prefixが残る。
- `declaredArtifacts` は外部scope配下を再帰走査し、リンク解決先が宣言した物理root外なら無条件に拒否していた。`pfx/dosdevices/z: → /` 相当の正常なリンクの**存在**でも停止する。実際の最初の拒否リンク名は元エラーに含まれず未特定。
- 先行担当は結果・相談を保存して停止。Sortie-dogsソースの未コミット変更なし。稼働host更新、ゲーム起動、停止した評価の再開は行っていない。

## 変更範囲

main `159b79c` 基点、別branch `fix/review-external-link-metadata`。PR #311の完成成果 `ae6c1a7` は基点に含まれ、本修正で変更しない。

Reviewの外部artifact走査だけ `reportOutsideLinks` を選択する。範囲外リンクはリンク文字列・解決先・未検査理由をfingerprintに記録し、リンク先を読まず再帰しない。抜粋にも `target not inspected: outside declared scope` を表示する。リンク先の内容を検査済みとは扱わない。リンク変更はReview fingerprintを変えるが、未追跡先の内容変更を検査したとは主張しない。対象実体が別途明示scope内なら従来どおり内容も検査する。

独立調査で、通常抜粋の24,000-byte枠を先行成果物が使い切ると未検査表示も失われるMediumを再現。同じReview Taskで補正し、既存の収集entriesから範囲外リンクの件数と代表pathを抽出する。`UNINSPECTED EXTERNAL LINK TARGETS` 要約を抜粋枠の外へ付加し、リンク経由では参照先内容を検査・fingerprintしていないことを明記する。代表path表示は先頭20件・2,000-byte previewへ制限する。collectorの既定挙動・共有API・validation/write境界は補正でも変更しない。

既定の `declaredArtifacts`、検証snapshot、manifest/write gateは変更しない。壊れたリンクの記録、内部リンクの追跡、ELOOP・権限・消失競合等の既存異常処理も維持。外部参照の書込み権限を付与する変更ではない。

## 限定検証

- `npm run test:targeted -- test/mission-review.test.ts`：exit 0、42件成功。build 9.206秒、test 4.044秒（runner計測）。人工fixtureには内部リンク、壊れたリンク、範囲外実体、`z: → /`、明示された外部実体を含む。公開 `sortie_v010_review_mission` のTask生成、累積scope保持、未追跡先の非収集、リンク変更fingerprint、preview上限を確認。
- `node --experimental-strip-types --import ./test/setup.ts --test --test-name-pattern='external directory scope rejects symlink escape|explicit symlink entry permits' test/manifest.test.ts`：exit 0、2件成功、0.213秒（Node計測）。実際のリンク経由scope外write拒否と、明示リンクentry操作／対象write拒否を既存テストで確認。build再実行なし。
- 既定収集で同じ範囲外リンクを拒否するassertionを保持。Reviewだけmetadata記録で進む差を確認。
- 追加checkの正式登録修正はhostが `mission-validation-registration-contract-mismatch` で拒否したため、既存の正式recipeを変更せず実行。manifestの2件は補助native検証として区別する。
- 大規模suite、ゲーム実行、GPU推論、global更新、release、npm publishは未実施。

### Review中の補正検証

- 既存の公開入口fixtureを通常抜粋／30,000-byte成果物で満杯の抜粋にparameterize。旧外部scopeを保持した正式 `sortie_v010_review_mission` の保存Task本文へ未検査要約が届くことを検査する。
- 修正前に `node --experimental-strip-types --import ./test/setup.ts --test --test-name-pattern='public broad external scope then narrow proof unit.*full source preview' test/mission-review.test.ts` を実行。exit 1、追加した公開Taskの未検査通知assertionで失敗し、欠落を再現。fixtureはfinallyで削除済み。
- 補正candidateの正式検証は継承した `npm run test:targeted -- test/mission-review.test.ts` を使用。結果は同candidateへ束縛したMissionのnative検証記録と最終報告に残す。修正後の自己再点検は独立PASSとは区別する。

## 未確認・未反映

実KF1環境でのReview再開は行っていない。稼働中pluginは旧実装のまま。本成果はソース修正と人工fixture上の公開入口検証であり、実環境の回復完了やKF1の技術的成果ではない。ゲーム／Steam／Proton／OS／driver／torch／ROCm／既存履歴は変更していない。

将来反映する場合は、修正を含む固定packageを選択し、npm global版と `~/.config/opencode/node_modules/sortie-dogs` のplugin参照先の両方を同一artifactへ揃え、版／hashを照合して既存手順によるOpenCodeの再読込を行う必要がある。影響範囲はReviewの外部リンク収集で、ゲーム環境を変更する必要はない。今回の禁止範囲なので、package適用・host再起動・実Review再開は行わない。

最初の正式検証後に本記録を追加してcommitしたため、独立Review要求が `mission-review-awaits-current-validation` を返した。コードは未変更だが、hostのcandidate鮮度条件に従い最終commitの限定検証を再登録する。未変更チェックの任意反復ではない。
