# Direct unitの検査登録訂正

## 原因と版の切り分け

検査条件の誤りとruntimeの不具合は別問題。報告のZIPはpayload 8個と内包manifest 1個の計9 memberで、8 memberという検査条件はassistant側の誤り。

修正前の現行sourceは同一direct admissionの`validation_cwd`だけを訂正可能だった。recipe本文の変更は通常replanへ流れ、継続中のcontroller自身や別のpending native toolの終了判定で停止し、通った場合も別runと追加unit消費になった。今回、凍結contractと有効な検査登録を分離し、所有する静止中direct unitのrecipe/cwd訂正を同一run・callID・reservationで処理する。旧checkと失敗は保持し、新規・変更した登録の発効後に開始したnative checkだけを採用する。不変のcheckでもsource/input bindingが変われば再利用できない。

報告された実ロード先はWindowsの次の**開発artifact**であり、markerだけでは公開版や現在のsourceとの同一性を証明しない。

- host: `2.2.5`
- marker: `0.13.17-handoff-continuity-v1`
- adapter: `file:///M:/_work/_Sortie-dogs-artifacts/worktrees/direct-unit-settlement-20261013/_testenv/direct-settlement/candidate-5bfa72193b42/package/dist/plugin/v2.js`
- 報告SHA-256: `4b6b619b78526b2c1117cba83b2fffca7ab4a570140b78aafef7c0de7749498a`

今回の作業環境はUbuntu。親の取得記録では実ロードは`/home/user/.config/opencode/node_modules/sortie-dogs/dist/plugin/v2.js`、`0.16.1-review-git-boundary-v1`、host `2.2.2`。Windows artifactは未取得で、上記SHAとの実照合・Windowsでの再現・適用は未実施。既存のdirect finish settlement/recovery修正と今回のrecipe登録修正は別テーマ。生成済みadapterだけの直接書換えは行わない。

## 既存Missionを保持した復旧

以下は元の環境で所有controllerが行う手順。この修正TaskからVibe側の再開や完了を代行しない。

1. 元Missionの`operator_status`と実ロードadapterのpath/SHA、公開tool schemaを再取得する。報告時の予算値を現在値とみなさない。要求、履歴、旧失敗、結果、消費量、reservationを保持する。
2. 全native foreground/background toolとTaskの実状態を確認する。終了未確認の他Task/writerは解放しない。現在のplanner自身は正確なcallIDとtool名だけを除外し、同じsession全体を終了扱いにしない。
3. 所有する静止中direct unitで`plan_units`を`executor: "self"`、具体的な`reason`、同じtitle/objective/read/write/acceptance/executionと、正しい`validation`（必要なら`validation_cwd`）で呼ぶ。`direct-unit-registration-corrected`のrun/unitが元と同じことを確認する。
4. 返された有効recipe/cwdで必要な新しいnative checkを開始する。登録前の診断exit 0を正式PASSに付け替えない。検査済み本文が不変である証拠は保持し、追加・変更された配送bundle/manifest/receiptを正式検査する。入力や出力が変わった古いcheckは再利用しない。
5. `finish_direct_unit`で実checkを記録し、現在candidateに対するReviewへ進む。単位完了はMission受入ではない。追加配送出力による`mission-review-awaits-current-validation`は正常なguardであり、迂回しない。

binding競合などでWorkerへ引き継ぐ場合の実行可能な代替は、同じ`plan_units`の`executor: "worker"`と`handoff_context`。V2では`units: ""`、legacy APIでは`units`を省略する。**`units: []`は使わない**。V2公開schemaは省略sentinelを受理し、handlerへ未指定として渡す。同じunit・reservation・旧check・有効recipeが引き継がれ、返されたTaskを一度だけ実行する。handoff自体は検査成功でもterminalでもない。

## 適用境界

この修正ではinstall、global apply、公開、npm publishを行わない。適用する場合は既存AGENTSの手順で同じ固定tgzを用い、npm global、`C:/Users/rozen/.config/opencode/node_modules/sortie-dogs`、`O:/_LocalLLM/.config/opencode/node_modules/sortie-dogs`を照合する。通常配置の更新だけでは、別testenv artifactを実ロードする既存Sessionへ反映済みとは判断しない。実ロードpathとSHAを別途確認する。
