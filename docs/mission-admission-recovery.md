# 取消後のTask再開拒否：調査記録

## 原課題とPRの対応

- PR #322（`1e1145633d30a4bdf20fc04e3534b4026dfb7bd5`）はOperatorの判断・具体方針伝達の局所補正。2026-11-03の確認時点でOPEN、未merge。
- PR #320は検査recipe・登録復旧に関する補正。本件や工程肥大化全般の解消とは別。
- 当初の工程肥大化・目的と手段の逆転問題全体を解消する別PRは、今回の調査開始時点では未作成。
- 本件は新しい利用者画像に示された取消後の再開拒否に関する調査。#322の成功検査を本件の成功証拠として転用しない。

## 証拠の区分

### 利用者の原画像

画像SHA-256: `65452388ea8628a41d082049ac307e5610d24ddab7cbdadd7d5ff99e160f7334`

画像内の担当は、取消・reconciliation後も`native Task admission remains refused`、root直接実行でも旧Taskが未終了扱いで拒否されたと説明している。
これは画像内の説明であり、こちらで観測したnative終端や具体的なエラーコードではない。
Windows対象の履歴ログは当地になく、利用者もログなしと明示済み。追加取得要求や対象製品の再実行は行わない。

### Sourceと当地のpublic入口

基点main: `c8a8991d66062f5957212872005cd73666741b15`。
既存`test/mission-operation-lifecycle.test.ts`のpublic plugin fixtureへ`cancel-before-child`を追加。
前段成功・既存成果保持・Task受付・取消・plugin再読込・`start_mission`・次の`plan_units`の既存経路を再利用した。
子sessionの最初のpromptをまだ受けていないTaskについて、同じcallのnative error/aborted終端をfixtureに供給する。
実製品のリリース操作やモデル推論を再現するものではない。

実行:

```sh
npm run test:targeted -- test/mission-operation-lifecycle.test.ts
```

- cwd: `source/`
- exit: **1**（修正前の回帰再現）
- runner計測: build **10.063秒**、test **3.617秒**。コマンド全体の壁時計時間は未記録。
- 既存5例成功、追加1例失敗。
- エラー: `mission-superseded-run-has-work: reconcile prior workers and evidence before changing acceptance`
- 発生: `OperatorRuntime.prepareOnce`から`declareMissionUnits`へ返る。

`interruptedOnce`は受付済みrunning unitをcancelledにする一方、子prompt前なら`childSessionID`はnullのまま。
`prepareOnce`のsuperseding検査はcancelled unitの`childSessionID === null`を一律拒否する。
したがって取消・予約解消後にも次の計画が拒否されるsource上の条件を確認できた。
ただし、これが利用者Windows事例の原因だったとは確認していない。

## 方式相談と採否

このCoordinator子セッションからの内蔵ブラウザ`tabs.list`は`[browser.disconnected]`。
これをMission全体の停止理由にせず、接続を持つrootが既存ChatGPTの同じ会話で相談を継続した。

会話: <https://chatgpt.com/c/6ae2a3d0-23cc-83ee-a1f8-a0ab2e629bb1>

rootは原画像を`browser.files.drop`で実添付し、Goal / Constraints / Observed facts / Questionと以下の代替案を、推奨未確定のまま提示。
composerの画像添付、実送信、実回答「Sortie-dogs：取消後のTask admission拒否に関する独立評価」の全文取得と回答完了を確認した。
この実観測と採否は2026-11-03T12:47:07.175Zの同Mission共有記録に保存されている。

- A: 子が未紐付けでも、正確な旧Taskのnative終端・入力同一性・既存所有権と予約の解消を確認できる場合だけ、既存取消照合から次の計画へ進める。
- B: 現状の一律拒否を維持し、次の操作を案内する。
- C: null子を無条件に許可する。

実回答の引用:

> 総合判断：Aを条件付きで推奨。Bは安全側の代替、Cは不採用

> nullを許可条件にするのではなく、正規Taskの終了と所有権解消が既存情報から確認された場合に限って、nullを拒否理由から除外

OperatorはAの限定修正を採用。情報取得不能・矛盾・live時はB相当の通常拒否を維持し、Cは不採用。
理由は、確認済みの取消をnullだけで永久残留にせず、既存のnative終端・所有権照合と会計を維持できるため。
新しい完全性field・モデル申告の許可flag・永続証明制度・監視役・runnerは作らない。
この助言は実行権限、正式検査、独立SourceReview、Mission acceptanceの代わりではない。

## 局所修正

- 既存の取消後planning遷移で、未紐付けcancelled unitのcallだけを対象にする。
- 既存native history readerから、同じ所有session・call・Task入力の実tool終端と終端時刻を照合。別root/run/prompt、子参照のある矛盾、running/未取得は通さない。
- 取消はadmission generationを失効させる。過去のTask参照は、同じroot/run/unit/contract/task hashかつ失効前generationとして**歴史比較のみ**行う。古い参照を再入場可能にはしない。
- 既存active snapshotとchildren情報で旧owner/関連childがliveでなく、子孫や未確認の実行が残らないことを確認する。native停止確認は成功検証とは別。
- 既存の予約0・終端照合後、旧runとexact call ID群を内部引数としてprepareへ渡す。モデル入力や新しい台帳receiptにはしない。
- coreはこの照合を得たcancelled admissionだけを受け入れ、元のnull child・取消状態・成功証拠・費用をarchiveにそのまま残す。
- Coordinatorの次の計画とroot直接実行の両方で、同じ仕組みを使用する。古いWorkerは再利用しない。

## 検査と限界

既存public fixtureで以下を確認する。実モデル推論・対象製品のリリース再実行ではない。

- cold reload後、exact終端と所有権解消が確認済みの未紐付けTaskから次のCoordinator計画およびroot直接実行へ進める。
- 別call/prompt/root/run/generation/owner/child参照、終端不明、children取得不能、active不明、live childは拒否し、旧run・予算・証拠を保持する。
- root Fast-laneの未紐付けTaskも、関連childがlive/終端未確認なら拒否し、planningから強制停止しない。
- 旧成功成果、既知の非ゼロ費用、未取得使用量を保持する。未取得を0へ変換せず、再読込・再照合による二重精算を起こさない。

修正中の限定検査では、集計費用がunknownになるfixture条件と、取消前generationの歴史比較を順に補正した。
2026-11-03の単file検査は最終的にexit **0**、7例成功、runner計測build **9.231秒** / test **4.657秒**。
その後、root Fast-laneと別root/run/generationの境界assertを追加した。
最終統合候補は次の宣言済みcommandで検証し、実exit・所要時間をnative正式記録とPR本文へ残す。

```sh
npm run test:targeted -- test/mission-operation-lifecycle.test.ts test/mission-binding-recovery.test.ts test/mission-direct-execution.test.ts
```

検査fixtureは既存の`finally`で所有する一時treeを削除する。旧履歴、元環境、他製品processは整理対象にしない。
既存依存と検査に必要な`dist/`は再利用し、新しい隔離環境・package・常駐processは作成しない。

到達対象はこの局所誤拒否の修正とPR作成まで。Windows画像との同一因果、工程肥大化全般、要求縮小の高速受入、戦略判断能力全般の改善は確認していない。
#320・#322の成果と本件を合算して当初問題全体の解決とは扱わない。
merge、global apply、公開は対象外。

## 独立Reviewで確認した残留拒否と補正

配送候補`44ec60f`を独立に調べ、同じpublic plugin入口で次を確認した。Windows事例への原因帰属ではない。

- 同じ利用者発言・同じ要求の`intent=continue`では、旧unitに非null childがないと取消後照合を呼ばず、coreのexact Task終端guardに拒否される。未紐付けcancelled Worker callも既存取消後分岐へ含め、root直接実行とCoordinator計画の双方で照合する。
- root配下の無関係なnative `general`子もprofile role不明として拒否していた。既知の非対象agentは当該Workerの所有物と扱わない。agent自体が不明、関連Workerがlive/終端不明の場合は拒否を維持する。
- planning内の正規停止確認を保存した直後、古い`stoppedChildren`を参照して最初のplanningだけ拒否していた。既存停止照合後に同じrunの最新状態を読み直す。live子の停止や未確認acknowledgementの許可には使わない。
- 同一要求continuationが到達可能になると、旧取消runをarchiveしないまま置換する分岐にも到達した。今回exact Task終端で復旧する未紐付け取消も既存archive手順へ含め、元のnull child・cancelled状態・証拠を保持する。新acceptanceへの成功証拠化はしない。

既存`mission-operation-lifecycle.test.ts`を拡張し、新しい利用者発言なしのroot/Coordinator復旧、無関係な非profile子、同じplanning内の停止照合、旧取消記録のarchiveを検査する。live/未知/停止拒否、予約・累計費用保持の既存assertは削除しない。

最小回帰command:

```sh
node --experimental-strip-types --import ./test/setup.ts --test --test-timeout=100000 --test-reporter=spec --test-name-pattern="unclaimed (root|Coordinator) Worker" test/mission-operation-lifecycle.test.ts
```

- 修正前: exit **1**、1成功/4失敗、test runner **0.766秒**。上記3種の誤拒否をpublic回帰として確認。
- 途中: buildで`previous`の再読込に伴うTypeScript narrowingエラー（exit **1**）を修正。続くbuildはexit **0**。
- 途中の最小回帰: exit **1**、4成功/1失敗、test runner **0.770秒**。同一要求の旧archiveが`ENOENT`となる履歴保持欠落を確認し、追加指摘として保持してから補正。
- 最終検査は上記の宣言済み3ファイルcommandをそのまま使用し、実exit・時間・件数をnative正式記録とPRへ残す。前候補の成功結果を補正候補の成功扱いにはしない。

相談済みAの「正規Task終端・所有権解消を既存情報で確認できた場合だけ復旧」を変えず、局所的な呼出し漏れ・対象除外・snapshot再利用・既存archive接続を補正した。追加gate・監視役・台帳field・runnerは導入していない。
