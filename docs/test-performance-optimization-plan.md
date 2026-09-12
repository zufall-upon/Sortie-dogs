# テスト性能最適化計画

> 以下はP0/P1策定時の性能改善計画です。300秒は本計画の性能目標・当時の計測条件であり、
> 現行runner/controllerのtimeout設定ではありません。現在の実行手順と1790秒／1800秒の
> 計時境界は[テスト実行ガイド](testing.md)を参照してください。5分以内の達成を意味しません。
>
> 現行の`_testenv/full-test-timings.json`はtest実行順だけのヒントです。test結果、候補artifact、
> freshness判定のcacheではなく、以下に記録した製品側の候補再利用条件を変更するものではありません。

## 目的と固定目標

- 計画策定時に約20分かかっていた全体テストを、必要な検証を維持したまま5分以内へ短縮する。
- 実行時間短縮とは独立して、SSDへの不要なI/O、特に書込み回数と論理書込み量を削減する。速度改善だけでI/O改善と判定しない。
- 最終判定では `node --test`、`npm test`、`npm run test:full` を別々の対象として扱う。
- `npm test` と `npm run test:full` の時間は、それぞれ `pretest` / `pretest:full` が実行する build を含む wall time とする。
- 最終全体確認の上限は各入口とも build 込み300秒。延長して約20分の完走を待たない。
- 調整中の計測は、10秒超の重い実ケースに対する30〜60秒の工程区間計測に限定する。短い代理ケースへの置換は禁止する。

## 対象入口

- `node --test`: 対象ファイルを限定した回帰、重い実ケース、工程区間の診断用。単独結果を全体達成判定に使わない。
- `npm test`: `pretest` の clean build と通常3 suite（plugin、continuation、fast-lane）を含む独立した改善対象。
- `npm run test:full`: `pretest:full` の clean build と `test/**/*.test.ts` 全件を含む最終全体対象。
- 通常testとintegration testの分離は計測軸であり、分離だけを性能改善とみなさない。

## 確定事実と仮説

### 確定事実

- 旧TAPでは10秒超が11ケース、合計約380.8秒。
- 最優先は約80.8秒の6-unit wave、次点は約66.6秒のnon-final wave。
- 続く候補はvalidation failure cleanup約35.7秒、CAS再開約31.8秒。
- 旧revisionの記録は `npm test` 256/256、約112秒、fullは553 pass・1 skip・約18分15秒。現revisionのbaselineではない。
- 小さい2-unit profileの約5秒の代理ケースは、重い6-unitやfullの短縮根拠にしない。
- `integrateFabricWave` から候補構築後、advance/assert経路で候補再構築へ至る呼出しが存在する。
- 最新小変更と以前のbatch変更には、全体検証未完了の差分がある。

### 未確認の仮説

- 同一operation内の候補再構築と、それに伴うGit process、一時index・patch・message生成が主要時間を占める可能性。
- 通常suiteではhelper、固定待機、Git setupの重複が主要時間を占める可能性。
- 仮説はP1の実測前に実装理由として使わない。

## I/O計測と記録

- source、test、buildの工程別に、同じrevision条件、同じ実ケース、同じcoverageでbefore/afterを比較する。
- 各工程で書込み回数、観測可能な論理書込みbytes、生成・再生成・削除file数、読取り量・metadata照会数、同時I/O上限を記録する。
- 一時index・patch・messageの生成、state保存とsync呼出し、buildのclean・emit・再生成量を個別に記録する。Git process起動数は補助指標であり、SSD書込み量と同一視しない。
- wall time短縮、並行化による待ち時間短縮、I/O総量削減を別欄で判定する。並行化時は総量が減らない可能性とI/O burstの増加を記録し、無制限の同時I/Oを許可しない。
- 実測値、観測可能な論理I/O、推定値を区別する。OSのlogical I/Oはcacheやpipeを含み得るため、物理SSD/NAND書込み量を表さない。
- 物理SSD書込み量と機器故障・寿命への効果は未計測であり、本計画の結果から改善を主張または診断しない。

## 維持する安全性とcoverage

- 必要なassertion、coverage、restart、CAS、scope、cleanupの意味を維持する。
- run、wave、base、ordered artifact identities、candidateの完全一致bindingを維持する。
- fresh target/ref/scope check、再開時の再構築と再検証を維持する。
- coreとplugin hookは同じ用語でも異なるcoverageとして扱う。年代だけを理由にtestを削除しない。
- test整理は、完全重複または廃止仕様を証明し、元test名とoracleの対応を残せる場合だけ許可する。
- SHA条件、時間条件、cleanup後のchild残留0、失敗・キャンセル時の振る舞いを維持する。

## 変更禁止

- 約20分の完走待ち、失敗後の無変更rerun、timeoutやvalidationのbypass。
- assertion、coverage、restart、CAS、scope、cleanup、freshness確認の削除・弱化。
- persistent/global cache、artifact偽造、fsync弱化、独立性未確認の並行化。
- 書込み削減を理由とするdurable checkpoint、crash recovery、freshness・scope検証の弱化。必要なstate保存とfsyncは維持する。
- root権限・ETW・追加toolの導入、SMART調査、OS設定変更、RAM disk導入、無制限の同時I/O。
- 遅いtestをscriptから外すだけの短縮、5秒の代理ケースや短い別ケースからの外挿。
- 既存ユーザー差分・未検証batch変更の無断rollback、stage、commit、push、release、公開。
- source変更や削除・rename後にstale distを許す運用。release時のclean build省略。
- この文書を後続unitのwrite権限として扱うこと。実装ごとにexact manifestを必要とする。

## 段階P0: 差分保護とoracle固定

- 実施記録: [テスト性能P0 baseline](test-performance-baseline.md)。旧10秒超11ケースの現行親子対応、保護差分、同値未確認点を記録済み。
- 状態: 静的対応11件は完了。同値確認済み0件、同値未確認11件。通常/integration分離とS01へのS02/S06統合で比較条件が変わるため、P1の同一revision実測対象に残す。
- 残る未知点: 全体wall time、最優先2ケースの現行区間、`npm test` のpretest/build/3 suite内訳、論理I/O、物理SSD/NAND I/O。P0ではtest、build、計測を実施していない。
- 編集範囲: 計画文書と調査記録のみ。code、test、package scriptは変更しない。
- 計測項目: なし。現行差分を「今回の自分の変更」「既存ユーザー変更」「未検証batch変更」に分類する。
- 検証条件: 通常/integrationの元test名、現行subtest名、assertion・oracle、coverage目的の対応表を固定する。
- 完了条件: 10秒超11ケースについて旧TAPとの同値対応、保護対象、未知点を記録できること。
- 未達時: testを削除・統合せず、対応不明を明記してP1の計測対象に残す。

## 段階P1: 実ケースの区間計測

- 編集範囲: 計測に必要な最小限のtest/harness instrumentation。製品挙動は変更しない。
- 計測項目:
  - `npm test` のprebuild/build、plugin、continuation、fast-lane各suite。
  - 約81秒の6-unitと約67秒のnon-finalを最優先とする10秒超wave実ケース。
  - setup、produce、accept、候補構築、再構築、cleanup、final validationの各区間。
  - 候補再構築回数、Git process起動数、wall time、exit、pass/fail/skip/キャンセル。
  - source・test・build別の書込み回数、論理書込みbytes、生成・再生成・削除file数、読取り・metadata照会、同時I/O上限。
  - 一時index・patch・message、state保存・sync呼出し、npm prebuild/buildのclean・emit・再生成量。
- 検証条件: 1区間30〜60秒でcheckpointを残し、停止時にprocess treeを止め、child残留0を確認する。raw log保存は不要。
- 完了条件: 最優先2ケースと `npm test` の支配区間を同じrevision上の実測で特定できること。
- 未達時: 5秒の代理ケースへ置換せず、instrumentationまたは区間境界だけを修正する。無変更rerunしない。

## 段階P2: 候補再構築の最小化

- 開始条件: P1で候補再構築が重いと実測された場合のみ開始する。
- 編集範囲候補: `src/core/worktree-parallel-dispatch.ts` と `test/integration/worktree-parallel-dispatch.test.ts`。
- 実装前Strategy: 通常の同一operation内だけで、計算済み候補結果を次工程へ引き継ぐ最小案を確認する。
- 維持条件: run/wave/base/ordered artifact identities/candidate exact binding、fresh target/ref/scope checkを照合する。
- 再開経路: process/session再開時はキャッシュを信用せず、候補再構築と再検証を行う。
- 検証条件: 限定回帰後、同じ6-unit/non-final実ケースと同じ区間で前後比較する。
- 完了条件: oracle、SHA、scope、cleanupが同値で、主要区間が実測短縮すること。重複candidate再構築由来の書込み回数または論理書込み量も別に比較し、削減有無を判定する。
- 未達時: 変更を拡大せず原因を記録し、P1データから次の1箇所を選ぶ。

## 段階P3: `npm test` の独立改善

- 編集範囲: 実測上重いplugin/continuation/fast-laneのhelper、固定待機、重複Git setup。`package.json` は測定根拠と互換性testがある場合のみ。
- 計測項目: prebuild/buildと3 suiteそれぞれのwall time、process起動、fixture/setup回数、dist clean・emit・再生成量、fixtureの重複書込み。
- 方針: test-only変更時の不要なclean build反復を避ける検証経路を検討する。
- 安全条件: source変更、削除、rename時はclean buildを必須とし、stale distを許さない。release clean buildも維持する。
- 検証条件: 対象限定回帰と `npm test` のbuild込み計測。遅いtestの除外を改善として数えない。
- 完了条件: inventoryとoracleを維持し、`npm test` がexit 0かつbuild込み300秒以内。
- 未達時: 最重区間の1箇所だけを次候補にし、full改善済みとの推定をしない。

## 段階P4: 残る10秒超ケースの改善

- 編集範囲: P1〜P3で確認した共通原因の影響順に、1原因・限定scopeずつ。
- 計測項目: 対象ケースの前後wall time、区間内訳、Git process、一時file、pass/fail/skip、cleanup、工程別I/O指標。
- 検証条件: 各変更で限定回帰後、同じ重いケース・同じ区間を再計測する。
- 同値性記録: 元test名、oracle、SHA条件、時間条件、coverage、restart/CAS/scope/cleanup対応。
- 完了条件: 対象caseの短縮と同値性を証明し、回帰がexit 0。速度とI/Oは別欄で判定し、片方だけの改善を両方の改善として扱わない。
- 未達時: 並行化や安全条件弱化をせず、測定データから次の1箇所を選ぶ。

## 段階P5: reviewと最終評価

- 開始条件: 限定回帰を通過した候補だけを対象とする。
- 計測対象: `node --test` の対象inventory、`npm test`、`npm run test:full` を別々に記録する。
- 計測項目: revision、build込みwall time、exit、pass/fail/skip/キャンセル、対象test inventory、途中checkpoint、source・test・build別I/O指標。
- 実行条件: 各候補revisionにつき最終測定は1回。各入口の全体wall上限300秒。超過時はprocess treeを停止し途中結果を回収する。
- 判定条件: 全件完走、exit 0、対象件数とskipがP0の対応表と整合し、必要なcoverageが維持されること。速度目標とI/O受入条件を別々に合否判定する。
- review条件: fresh canonical validationの後に最終reviewする。成功前のcommit、release、公開は禁止する。
- 未達時: timeoutまたは失敗として扱い、20分へ延長せず、無変更rerunしない。全体未実測なら5分達成を主張しない。

## 受入条件

- `npm test` と `npm run test:full` が別々に、pretest build込み300秒以内で全件完走しexit 0。
- `node --test` の限定回帰が対象inventoryどおりに完走しexit 0。
- pass/fail/skip/キャンセル数とtest inventoryを変更前後で比較し、差分を説明できる。
- 10秒超の実ケース、とくに6-unitとnon-finalの同一ケース比較で短縮を確認する。
- assertion、coverage、restart、CAS、scope、cleanup、freshness、失敗経路の同値性を確認する。
- 旧ログ、約5秒の代理ケース、通常/integration分離だけを全体改善の証拠に使わない。
- I/O最適化対象工程で、同じ実ケース・coverageの比較により書込み回数または論理書込み量が根拠付きで減る。他工程や全体への過大な転嫁をせず、増加があれば工程別に理由と影響を説明する。
- Git起動数減少だけでSSD書込み改善と判定しない。未観測の物理SSD/NAND書込みbytes減少や故障・寿命改善を主張しない。
- 並行化による待ち時間短縮をI/O総量削減として扱わず、総量とburstを別記する。必要なfsync、durable checkpoint、crash recovery、freshness、scope検証を維持する。

## 計画変更ルール

- 未達時は計測データから次に変更する1箇所を選ぶ。
- scope、段階順序、検証方法の変更が必要なら、実装より先に本書の該当段階へ理由と影響を追記する。
- 目標、coverage、安全条件の変更はユーザー判断を必要とする。
- それ以外は該当段階の編集範囲だけを修正し、計画外変更を混在させない。
