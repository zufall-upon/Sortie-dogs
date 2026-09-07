# テスト性能P0 baseline

## 記録範囲

- 対象: 途中までの旧TAPで10秒超だった11ケース。ケース時間合計380.83188秒であり、full wall timeではない。旧TAPのrevisionと現在のHEADが同一とは確認できない。
- 並び: 旧秒数の降順。top 2は147.4437705秒。
- 現行参照: `test/integration/worktree-parallel-dispatch.test.ts`。通常層は `test/worktree-parallel-dispatch.test.ts` から `?normal` importされ、`normalCases`の3ケースだけを登録する。integration層は残りをgroup登録する。
- 判定: 旧ログと現行sourceの静的対応だけを記録した。test、build、計測は未実施。assertionやworkflowの差を同一revisionで比較していないため、11件すべて同値未確認。
- 分離・統合の影響: 通常層への移動は実行入口、並行度、fixture競合条件を変え得る。S01親ケースには旧名S02とS06が現行subtestとして統合され、親setup・wave進行を共有する。ケース単独時間との直接比較不可。移動や統合だけを速度改善またはcoverage維持の証拠にしない。

## 旧10秒超ケース対応（降順）

### S01 a six-unit fabric advances only at the barrier into a fresh exact-base worktree

- 旧秒数: 80.8095723秒。
- 現行: `test/integration/worktree-parallel-dispatch.test.ts`; integration親group `six-unit and interrupted durable integration scenarios`; 親case同名。S02、S06を子subtestとして内包。
- 現oracle: 5+1 dependencyの6-unit、barrier前に次wave未公開、batch state revision +1、first-wave worktree/ref cleanup、fresh candidate base、restart後の単一artifact統合、final candidateとtarget不変、accept後promotionをassert。
- 同値性: **同値未確認**。旧S02/S06の統合でsetup、cleanup、計時境界、失敗局所性が変化。旧親単独のassertion集合と現親全体の一致、並行group下の条件が未知。

### S02 integrateFabricWaveAndValidate advances non-final waves without running supplied validation

- 旧秒数: 66.6341982秒。
- 現行: 同file; S01親内の `t.test` 子subtest同名。独立top-level caseではない。
- 現oracle: non-final advanceがarchiveせず次の`f`だけをready化、fresh candidateをbaseにし、validationをpendingのまま保ち、 supplied commandのcounterを作らないことをassert。
- 同値性: **同値未確認**。S01のsetup・first-wave統合結果を共有し、旧独立caseとの実行範囲と秒数境界が異なる。command非実行oracleの完全一致も旧revision未照合。

### S03 failed fabric validation archives cleanly and releases the active slot

- 旧秒数: 35.7241559秒。
- 現行: 同file; integration親group `remaining worktree dispatch integration scenarios`; top-level case同名。
- 現oracle: validation exit 7でfailed archive、candidate/source ref除去、worktree 1、target SHA不変、別rootで次fabric prepare可能をassert。
- 同値性: **同値未確認**。現行cleanup・slot再利用oracleは確認したが、旧assertion集合、helper実装、artifact生成経路との差が未知。

### S04 fabric claims validation once and resumes acceptance after a completed target CAS

- 旧秒数: 31.805897秒。
- 現行: 同file; `remaining worktree dispatch integration scenarios`; top-level case同名。interrupted validation replayの子subtestを含む。
- 現oracle: candidate/ref/content、並行validation claim一勝一敗、validation一回、replay非再実行、異なるcommand拒否、target CAS済み状態からaccept再開、archive・promotion・ref cleanup・idempotent再acceptをassert。
- 同値性: **同値未確認**。子subtest追加・統合、state直接更新、現行CAS/bootstrap経路と旧revisionの差が未知。

### S05 failed fabric target promotion releases its review claim for cancellation

- 旧秒数: 30.8211634秒。
- 現行: 同file; `remaining worktree dispatch integration scenarios`; top-level case同名。
- 現oracle: targetを別commitへ移動後のacceptが`candidate-invalid`、review pendingへ戻り、cancelがarchive/cancelledになることをassert。
- 同値性: **同値未確認**。現行の同一HEAD/base照会とbootstrap boolean統合を含む可能性があり、旧promotion conflict条件との完全一致は未照合。

### S06 integrateFabricWaveAndValidate integrates the final wave and validates without changing target

- 旧秒数: 30.7680272秒。
- 現行: 同file; S01親内の `t.test` 子subtest同名。独立top-level caseではない。
- 現oracle: final wave後にactive unit 0、validation pass、candidateがbaseと異なり、main target SHAがacceptまで不変であることをassert。
- 同値性: **同値未確認**。S01の共有setup、restart、事前の明示`integrateFabricWave`を含む現workflowと旧独立caseの比較条件が異なる。

### S07 failed fabric review archives cleanly without moving the target

- 旧秒数: 30.6442998秒。
- 現行: 同file; `remaining worktree dispatch integration scenarios`; top-level case同名。
- 現oracle: validation pass後のreview failでfailed archive、review status fail、main SHA不変、candidate/source ref cleanupをassert。
- 同値性: **同値未確認**。現行artifact、candidate構築、cleanup helperと旧revisionの同値性が未知。

### S08 fabric operation authority heartbeats throughout validation

- 旧秒数: 29.8043919秒。
- 現行: 同file; `remaining worktree dispatch integration scenarios`; top-level case同名。
- 現oracle: validation中の短TTL lease heartbeat、競合operation authority取得の`scope-conflict`、validation passをassert。
- 同値性: **同値未確認**。timing依存の90/180/350ms条件、lease実装、integration並行度が旧測定条件と一致するか未知。

### S09 five concurrent fabric binds skip recovery authority for a stable active run

- 旧秒数: 17.6488333秒。
- 現行: 同file; `remaining worktree dispatch integration scenarios`; top-level case同名。
- 現oracle: 5 descriptorを並行bindし、prepare authority未取得、state authorityを5回以上取得、全task runningをassert。
- 同値性: **同値未確認**。helper、state保存、bind内authority経路、group concurrencyと旧revisionの一致が未知。

### S10 fork/join reserves only DAG-ready tasks and supports three bounded workers

- 旧秒数: 16.1463275秒。
- 現行source: 同file; `normalCases`経由で通常wrapperの親group `worktree dispatch`へ登録されるtop-level case同名。integration層からは除外。
- 現oracle: 初期ready `a,c`、3 tasks、worktree一意・frozen descriptor、bind後ready 0、`c`完了後もjoin待機、`a`完了後に`b` ready、`a` completedをassert。
- 同値性: **同値未確認**。通常層への移動、wrapper/import、並行度、helper抽出後のfixtureが旧top-level実行条件と異なる可能性。

### S11 an admitted fabric contract prepares one durable luna-fabric run

- 旧秒数: 10.0250135秒。
- 現行: 同file; `remaining worktree dispatch integration scenarios`; top-level case同名。
- 現oracle: luna-fabric route、width/depth、unit acceptance、fingerprint、ready順・worktree一意、artifact未生成、branch/base binding、durable state route、cancel後archive routeをassert。
- 同値性: **同値未確認**。execution planやschemaを含む現行prepare経路、helper抽出、旧assertion集合との差が未知。

## 差分保護

- この会話で確認済みの変更単位だけを会話由来候補として扱う: test層分離、helper抽出、`test:dispatch`/`test:integration`追加、`test/plugin.test.ts`限定並行化、`src/plugin/index.ts` watchdog修正、core dispatchの`pendingFabricOutcomes`利用batch、lifecycleの同一HEAD/base照会とbootstrap boolean統合、artifact fingerprint内base tree共有。
- 上記はファイル全体の帰属を意味しない。特に`pendingFabricOutcomes` batchは未検証。既存差分と混在するためrollback・stage・commit対象外として保護する。
- `src/core/types.ts`、`src/core/validate-schema.ts`、`src/index.ts`、多数のuntracked moduleは性能task外または由来不明の既存差分。Git statusだけで作者を推定せず保護する。
- 直近の小case 4〜5秒、Git process 185→182→178、state save約69msは小case限定観測。11ケース、full、物理SSD I/Oへの一般化禁止。

## P1 exact next scope候補

- 同一revisionで実ケース2本を観測: S01の実6-unit親scenarioとS02のnon-final子subtest。共有setupを含む親wall timeと子区間を分け、setup、produce、accept、候補構築・再構築、cleanup、validation、Git processを記録する。
- 同じrevisionで `npm test` をpretest/prebuild・build・plugin・continuation・fast-laneの3 suiteに分けて観測する。全体入口はまだ未測定。
- source・test・build別の書込み回数、観測可能な論理書込みbytes、file生成/再生成/削除、読取り・metadata照会、同時I/O上限を速度と別判定する。物理SSD/NAND I/Oは未測定。
- instrumentationのsource編集は次unitのexact manifestで限定する。調整時は重い実caseの30〜60秒区間、最終目標は `npm test` と `npm run test:full` を各pretest build込み300秒以内。分離、統合、不要I/O削減を時間短縮と混同しない。

## P0結論

- 対応11件、欠落0、重複0。同値確認済み0件、同値未確認11件。
- 現時点で全体5分、35件等の全coverage維持、full短縮、SSD物理I/O削減は未確認。

## P1限定観測（2026-09-06）

### 条件と境界

- 同一working tree上で、専用childへobserverをpreloadした実 `npm test` と、S01の実callbackを登録する専用 `unit6` invocationを各50秒以内で観測した。`npm run test:full` と全test inventoryは未実行・未測定。
- `npm test` は指定npm CLIから通常どおり起動し、`pretest` の `npm run build`、`prebuild`、TypeScript build、`postbuild`、plugin、continuation、fast-laneを変更していない。build完了を確認後に同じ生成済みdistでunit6を起動した。
- unit6は `worktreeDispatchCases("integration")` の `a six-unit fabric advances only at the barrier into a fresh exact-base worktree` callbackをそのまま委譲した。小さい2-unit代理caseではない。non-final、restart、finalの既存子subtestとoracleをすべて実行し、non-final到達を確認した。
- wallとmethod時間は階層・並行実行を含むinclusive値。加算して全体時間にしない。observerは元APIへ同じ引数で委譲し、fsync、cache、batch、scope、freshness、test選択、既存assertion、package scriptを変更していない。
- Git内部processが行うindex/object書込みbytesと物理SSD/NAND I/Oはobserver対象外で、値は `null`（未測定）。0または推定値で補完しない。Nodeから観測可能なwriteだけを記録した。

### `npm test` 実測

- 結果: exit 0、wall 41.635秒、timeoutなし。build完了。owned child停止確認、run-owned temp/reports cleanup完了、raw stdout/stderr・argv・env・secret保存なし。
- npm root: 41.470秒。build: 3.368秒、114 writes / 1,509,238 bytes。postbuild: 0.005秒、1 write / 13,838 bytes。prebuild: 0.015秒。`pretest`分類はnpm親子2 processを含み最大3.865秒で、phase値は排他的合計ではない。
- plugin: 36.942秒、Git 916起動、1,430 writes / 381,414 bytes。内訳はstate 645 / 186,009 bytes、その他run-owned temp 785 / 195,405 bytes。
- continuation: 13.920秒、fast-lane: 0.044秒。suiteはNode test runner配下で重なり得るため、3値をnpm wallへ加算しない。今回の観測ではpluginがnpm wallの支配区間。
- observer自身のsummary write: npm root 14、plugin 13、continuation 5、build/prebuild/postbuild/fast-lane各1、pretest分類合計3。これらは上記Node write count/bytesから除外した。

### 実6-unit / non-final実測

- 結果: exit 0、親callback 28.865秒、process wall 29.038秒（supervisor wall 29.153秒）、timeoutなし。S01、S02 non-final、restart、finalすべて到達。owned child停止確認、登録されたexact fixture rootとrun-owned temp/reports cleanup完了、raw log保存なし。
- non-final側の最初の `integrateFabricWaveAndValidate`: 12.627秒。後続final側は1.076秒。non-final子subtest自身のassert区間は0.001秒で、重い処理は子subtest登録直前の同API invocationにある。
- `integrateFabricWave`: 2回inclusive合計15.650秒（12.610秒、3.040秒）。`recoverFabricTransition`: 2回11.061秒（9.219秒、1.842秒）。`buildFabricCandidate`: 6回4.892秒（1.393、1.339、1.325、0.282、0.278、0.275秒）。`assertFabricCandidate`: 4回4.418秒。階層重複のため合計不可。
- artifact produce: 5回9.894秒、accept: fixture側5回6.730秒 / coordinator全6回7.303秒、lifecycle cleanup 6回7.069秒、restart子subtest5.386秒。
- Git 836起動。Node観測write 507 / 354,707 bytes、うちstate 266 / 242,669 bytes、その他temp 241 / 112,038 bytes。observer summary write 10は除外。Git内部書込みbytesと物理SSD I/Oは未測定。

### 判定と次候補

- P1の固定対象では、npm支配区間=plugin、S01/S02支配区間=最初のnon-final integration/recovery経路を同じworking treeで特定できた。ただしfullと全体5分は未測定で、達成扱いにしない。
- candidate構築は6回観測したが、`integrateFabricWave`、`recoverFabricTransition`、cleanupとinclusiveに重なる。P2開始条件である「候補再構築が重い」の因果判定には、最初のnon-final経路内でrecoveryとcandidate buildの境界をさらに分離した同一case比較が必要。現時点でP2開始不可。
- 次の限定修正候補は、製品修正ではなくnon-finalの `recoverFabricTransition` 9.219秒と最初のcandidate build 3回を分離する区間境界。full実行、20分待ち、無変更再実行、commit、公開、OS設定変更は行っていない。
