# Mission停止の根本原因監査 — 2026-09-26 / v0.12.12

## 結論

反復する停止の中心は、モデル性能やOSの権限不足ではなく、**同じ仕事の状態と判断を複数の層が所有し、拒否条件に対して復旧経路が不足している構造**にある。
特に、永続予約とプロセス内予約の二重管理、ユーザー要件を変更できない継承規則、shell構文を権限のように扱う判定が、自律性・効率・可視性を阻害している。

今回の調査は、実V2履歴・台帳の読取、固定コードの確認、生成した隔離fixtureでのproduction-hook再現による。稼働mission・DB・campaign・predictionには書き込んでいない。新しいモデル推論・ベンチ・releaseは実行していない。

## 固定した根拠

- 調査対象コード: `7021918e0849ea6afcb5cad4da1ec62487f5a9db`、v0.12.12。
- Desktop root: `ses_f2804a5e5ffexUfgBFRutRDhMD`。
- 停止mission: `mission-9300e86d-8d94-4ad6-9eac-6c545889ed77`。
- 旧run: `operator-e1658b4e-cf02-48c5-80a8-5b1fa1fbb913`。
- 旧Coordinator: `ses_f236a0164ffeJqYvZiMwyN5YAP`。
- 予約が残ったWorker: `ses_f23497b6dffebIBRpq9XluV9VM`。
- 新Coordinator: `ses_f22ec0368ffek44nf36YNNt97J`。
- 実statusのloaded runtime: `0.12.12-mission-lineage-external-v1`、PID 915491、loaded at `2026-09-26T09:30:50.681Z`、Desktop host 2.0.11。
- adapter SHA-256 `5cdfd56f0ec902973742a652394f6e70b4b02a7d2f2319a32be074aa1a65c25a`と、statusに含まれる5 implementation hashesは固定v0.12.12のdistと一致した。

したがって、**今回の停止を「新しい版をまだ再起動していないため」と説明するのは誤り**。2.0.14のCLI probeとDesktop 2.0.11も同一環境として扱わない。

観測JSON・スクリプト・fixture・結果は `_testenv/audits/2026-09-26-autonomy/` に保存した。sourceファイル・native履歴のSHA-256を観測JSONに記録。生履歴・DBはGitへ追加しない。

## 1. P0: reload前後で取消の意味が変わる

### 実履歴

- goal ledgerは07:55:44 UTCにunit-2の予約を保存した。
- 旧CoordinatorのWorker Task `call_2hKrW1hI9OyBorHOsEV5Bobl`はnative履歴で`error / aborted`。
- 旧Coordinator自身は`interrupted`。Workerのnative `idle_outcome`は未記録で、終了の確認に不足がある。
- 09:36 UTCの`cancel_operator`は成功し、operator unitを`cancelled`にした。
- goal ledgerには対応する`unit.settled`がなく、予約1件が残る。
- 新Coordinatorの09:38と09:41の`plan_units`は`mission-superseded-run-reservations-pending`。後者は`write: []`の読取調査unitだった。

### 実装上の原因

- `src/plugin/index.ts:2613–2633`: 永続`dispatch.reserved`とは別に`goalReservations` Mapを保持し、通常のsettleはMapにないcallを無視する。
- `src/plugin/index.ts:8223–8228`: cancelはMapにある予約だけを精算する。cold loadでは空なので、永続予約が残る。
- `src/plugin/index.ts:1952–2107`: 通常復旧はroot履歴を探索する。今回のWorker TaskはCoordinator履歴にあり、一般経路では見つからない。
- 同関数の`terminalCancelledMissionTask`は「root Task completed・Coordinator succeeded・Worker子が存在しない／depth refusal」の特殊な形を要求する。今回のinterrupted Coordinatorと実在Workerは対象外。
- `src/plugin/profiled.ts:98–130`: 新計画は予約0件を要求してから旧子sessionを調べる。予約残留があると終端照合まで進まない。
- `src/core/goal-bound.ts:124–125,185`: durable reservationに実際のdispatch session、call ID、child IDを直接持たず、rootとunit ID＋hashから履歴を再探索する。

### 再現結果

同じproduction hooks・実ファイル・実validatorで、最初のunitを成功させ、次のWorkerをadmit。native履歴はroot TaskとWorker Taskのaborted、子はinterruptedとした。その後の条件を一つだけ変えた。

| 条件 | cancel後の予約 | 次の読取unit |
|---|---:|---|
| 同じplugin instanceでcancel | 0 | 起動可能 |
| cancel直前にplugin instance再生成 | 1 | `mission-superseded-run-reservations-pending` |

実DesktopのWorker outcome欠落より**有利な終端情報をfixtureで与えても**cold recoveryが失敗する。単にnative Workerのoutcomeが未記録だったことだけでは説明できない。

### 根治方向

予約の正本をdurable dispatchレコードに一本化し、実dispatch session/call/childと生命周期を保存する。Mapはcacheに限定する。取消・再読込・after-hook欠落を同じ冪等なreconcileで扱う。

実行中かどうかの確認、費用の未確定hold、成果のacceptanceを独立させる。終了確認は成果PASSを要求しない。未確定費用を消さず、読取診断や精算操作を実装Workerの新規予約条件から切り離す。

## 2. P0: ユーザーの変更指示より古い要件を優先する

実ユーザーはv0.12.12・4並列を指定した。rootの置換指示は`mission-requirements-preserved`で拒否され、cancel→new後も旧5要件が新5要件の前に追加された。現在の10要件にはv0.12.10固定／逐次実行とv0.12.12固定／同時4件が共存する。

- `src/core/operator-mission.ts:158–160`: 継続は旧要件の文字列・順序の完全一致を要求する。
- `src/plugin/profiled.ts:459–474`と`src/core/operator-mission.ts:187–200`: 旧runに受理済みunitがある場合、旧acceptanceを新missionの必須要件として前置する。
- fixtureでも、旧版の調査unitが一つ成功したあと新しい版へ置換すると、`Install version 0.12.10.`と`Install version 0.12.12.`がともに必須になる。

「過去の支出・結果を保持する」と「過去の要件を現在も実行する」は別である。要件には明示的なrevision/superseded関係が必要。実ユーザーによる変更を新しい有効要件へ反映し、旧版の履歴・費用・未完了の扱いは履歴として残す。文字列を不変にする独自ゲートをユーザーの意思より上位に置かない。

## 3. P1: shell classifierが実用性と保護の双方で一貫しない

新Coordinatorの最初の診断は`pwd; git status; ls; rg ... 2>/dev/null`だったが、`mission-coordinator-shell-readonly`で拒否された。`/dev/null`へのstderr破棄を通常出力への書込として扱う。

固定v0.12.12のgateを実際に呼び出した結果（コマンド自体は未実行）:

| コマンド | 判定 |
|---|---|
| `curl -I https://example.test` | 拒否: unsupported-curl-form |
| `echo "$(git rev-parse HEAD)"` | 拒否: active-expansion、Coordinatorへ戻れ |
| `rg pattern README.md 2>/dev/null` | 拒否: project-boundary |
| `curl -fLsS -o output/a https://example.test` | 許可 |
| `node -e 'require("fs").writeFileSync("outside.txt", "x")'` | 許可 |

`src/plugin/gate.ts:1224–1237`は登録済みvalidationを早期許可し、missionの未分類executableも一部許可する一方、知っているコマンドの未対応構文は拒否する。shellの任意副作用は判定できないのに、構文の好みがハードな停止条件になっている。

対処はさらにallowlistを増やすことではない。missionではnative host permissionsを実行権限の正本にし、Sortieのcommand分析は出力/evidence収集の補助へ下げる。明示された禁止・同時編集衝突と、parserが分からないだけのケースを分ける。通常の出力範囲補正は同じWorker内で処理できる構造へ寄せる。

## 4. P1: 拒否するが、実行可能な復旧操作を返さない

- `src/plugin/profiled.ts:1084–1091`にはorphan reconcile toolがあるが、`src/plugin/v2.ts:486–496`の通常mission向けvisible toolsにはない。
- そのreconcile自体も`SORTIE_OPERATOR_DELEGATE_REF`を前提とした旧delegate用で、今回の`SORTIE_MISSION_REF`に一致しない（`src/plugin/index.ts:7783–7805`）。単にtoolを表示しても直らない。
- `missionDispatchPacket`はblocked submissionにも「同じCoordinatorをdispatchせよ」と返す。実際には再dispatchしても同じ予約拒否になる。
- 新mission `runID:null`でも旧cancelled runをstatusに混ぜ、そのunitを`execution_summary`に数える。新しい作業がどこまで進んだか分かりにくい。
- `operator_next`は未準備の新Coordinatorから旧operatorへ進もうとして`operator-owner-mismatch`を返した。

停止理由・照合対象reservation/call/child・native終端の観測・未解決の一手を一つの診断結果として返し、status/next/dispatchがそれを共有するべきである。ホストが直せる内部状態を、モデルやユーザーに「ホスト側で直して」と投げ返さない。

また、今回opaque Task hashの末尾をモデルが1文字余計にコピーして1回拒否されている。hashを会話経由で転記させる手順も不要な故障点。host-owned dispatch-next/opaque handle参照へ整理する余地がある。

## 5. P1: 調査にも最終証明形式を強制し、形式だけ満たす方向へ誘導する

新Coordinatorの初期計画は`mission-uncovered: R3, R8`。その後の読取専用unitは`validation: ["node -e 'console.log(\"読取専用照合完了\")'"]`を宣言していた。

`src/core/operator-mission.ts:265–296`は全要件のunit割当と最終validation commandを要求し、requirement IDsを省くと全要件への割当になる。調査の一歩と最終acceptanceの計画を同じ書式へ押し込むため、未確定の後続作業や単なるechoを「証明」の枠へ入れやすい。これは今回実行・受理された証拠ではないが、モデルの実入力で確認した設計上の誘導である。

探索/環境観測と実装・受入証明の段階を分け、最初の調査に全将来unitを固定させない。受入は実際の要件に対応する意味のある観測で判断し、形式的なコマンド登録を増やさない。

## 6. P1: observation scopeと証明input scopeの混同

同じ読取計画に`/tmp/opencode/**`、`/home/user/.config/opencode/**`、`/home/user/.local/share/opencode/**`が含まれている。

`protectedSnapshot`はmanifest read全体とwrite全体をsource hashへ含める（`src/plugin/protected-snapshot.ts:79–90`）。外部treeは全再帰で走査し、socket/特殊fileや範囲外linkなどで失敗すると上位でundefinedへ落ちる。`recordHostGoalStart`はその理由を返さず証明記録を開始しない（`src/plugin/index.ts:1815–1816`）。

小さい隔離fixtureでも、外部read treeのsession進捗だけを変えるとcandidate不変のままsource証明が変わった。実セッションのDB/WALやログまでread scopeに含めれば、自己更新による陳腐化と過大走査を招く。今回の計画は予約拒否でまだこの処理へ到達しておらず、これは潜在問題の再現である。

読める範囲、実際に観測した資料、acceptanceを左右する不変入力は分ける。証明用の入力/出力だけを必要時に照合し、失敗理由を可視化する。

## 7. P1/P2: 費用と長時間jobのライフサイクルが接続されていない

- 通常Worker settle、復旧settleともgoal ledgerへ`cost_usd:null`を書く（`src/plugin/index.ts:2102,2680,7842`）。`goal-bound.ts:417`では一度nullになると後続もnull。単なる遅延ではなく、実測usageを精算する経路が足りない。
- 数値cost limitが指定されたgoalはusage unknownで次dispatchを拒否する。他方、今回のgoal台帳ではcost limit自体がnullで、$135 campaignは別supervisor/budgetファイルが管理している。両者の「予約」は同じものではない。
- 旧supervisorは09:30:40 UTCの`running`表示と6件のrunner成功・7件目runningを残した。PID 846337は観測時に存在せず、公式採点成功の意味ではない。
- 旧Workerは`read status → sleep`を10回実行していた。foreground Taskで長時間jobを抱え、ホスト再起動・親中断とjob/sessionの寿命がずれる。`mission-progress`のsinkもprocess-localで、内部jobの進捗とは別管理。

費用は確定/推定/未確定holdと出典を保持し、後から冪等に精算できる形にする。長時間jobには実行プロセス・heartbeat・終了・再接続の観測を持たせ、モデルをsleep/pollの監視役にしない。元runを再起動して確認する必要はない。

## 8. なぜこれまでのテストと局所修正で残ったか

- PR #75のlifecycle regressionはcancelをwarm instanceで実施し、native outcomeをfixture側でinterruptedに設定する。cold loadは次missionのunit間に入れる。**旧runの予約を保持したままreload→cancel**という今回の順序は試していない（`test/mission-operation-lifecycle.test.ts:63–79`）。
- releaseの実モデルprobeは新規・短時間・単一Workerの成功を確認した。旧版由来の中断台帳を新runtimeが復旧する証拠にはならない。
- mission、operator、goal ledger、native sessions、メモリのownership Map、外部supervisorにそれぞれ状態がある。各ファイルはatomic writeでも、その間の遷移は一つのtransactionではない（既存auditもこの限界を記載）。
- gateを個別に追加/緩和しても、どの層が最終判断するかと、部分完了からどう復旧するかが統一されなければ次の境界で止まる。
- pending予約があるstatusではroot native履歴を繰り返し全探索する。観測時rootは847 messages・約12.5 MBのDB JSON。これはモデル課金token数とは異なるが、復旧のAPI・解析負荷が履歴とともに増える。直接のdispatch identity保存で探索を減らせる。

## 改善順序と確認条件

1. **P0: dispatch/取消/reconcileを一本化。** durable identityからcold recovery、missed after-hook、native outcome未記録を扱う。一般のnative中断確認と未確定holdを使い、成果証明は要求しない。読取診断は開始可能にする。
2. **P0: requirement revision。** 最新の実ユーザー変更を有効要件へ反映し、旧義務の置換/取消と既支出・結果の保持を分ける。
3. **P1: 重複の実行制限を減らす。** missionのshell allowlistを権限判定から外し、host permissionsと明示されたユーザー制約へ寄せる。小さなscope/command補正を同じWorkerで扱う。
4. **P1: statusと実行の同じ診断。** 現mission/旧run、実行中/精算待ち/証明待ち、次に実行可能な操作を揃える。内部修復のための承認階層を追加しない。
5. **P1/P2: 証明・費用・job監視の役割を整理。** 調査を最終証明から、観測範囲をfingerprint inputから分け、費用とprocessをhostで追跡する。

検証はテスト件数の追加より遷移の確認を重視する: reloadがadmit後/cancel前/settle途中に起きる、親だけ中断、Worker終端欠落、after-hook欠落、ユーザー要件置換、読取のみの復旧、通常shell構文、外部観測変化。失敗注入後も同じ処理をもう一度行えば整合へ収束し、支出や完了証拠が二重計上されないことを確認する。

残すべきなのはnative host permissions、実ユーザーの禁止/予算、実行重複の防止、観測済み検証結果と成果変更の区別。減らすべきなのは同じ権限・親子関係・要件を別の形式で何度も承認させる処理と、復旧不能な不一致ゲートである。

## 費用・未解決点

この調査で新規モデル推論は起動していない。既存履歴の価格表による見積りでは、新Coordinatorは新Workerを1件も起動できず約$0.3101892を使用。旧候補準備で失敗した5 Worker合計は約$0.15998968（Coordinator分は含まない）。これら全額が無駄だという採点ではなく、停止・調査に費用が発生した観測である。

旧Workerのnative終端と外部campaignの最終費用は未精算。修正・release・旧campaignの再開は今回の調査では行っていない。次の実装はまず上記P0二件を一つの状態遷移設計として扱い、今回のcold-cancel fixtureと要件置換を受入条件にする。

## 実装と検証 — v0.12.13候補

上記はv0.12.12の監査時点の記録。後続の実装で次を変更した。

- **cold cancellation:** goal予約の照合にdurable operatorのunit/call/childを使い、native interruptの確認を`stoppedChildren`として同じrunへ保存する。warm/coldで同じ予約回収経路を使用し、再実行しても確認済みの子を再取消しない。旧V2 private serverの一覧APIが未提供でも、保存済みの子sessionをget/interruptできれば復旧できる。
- **明示的な要件置換:** `start_mission(intent: "replace")`で旧runを取消・保存してから、現在の要件を登録する。`new`も旧版の必須要件を新規missionへ前置しない。通常の同一要求の継続は既存acceptanceを保持する。予算台帳は共通で、履歴の成功を新要件の成功として引き継がない。
- **shellの重複判定を削減:** mission Worker/Coordinatorのshell構文を独自の実行許可として扱う処理を削除。native permissionsと役割指示を使用し、正式な証明は引き続き実際に観測されたvalidationだけから作る。
- **状態表示:** 新missionの実行状況へ旧runの成功unitを混ぜず、`predecessor`として表示。未計画の新Coordinatorの`operator_next`は、旧operatorへ接続してowner mismatchを起こさず、現在のunit計画へ案内する。
- **費用:** native usageと既存価格表からWorker費用を算出する。未確定のusageはnullを保持し、後日のstatusで`unit.usage-reconciled`を一度だけ記録できるようにした。usage回収は成果受理やunit再実行を発生させない。旧イベントにnative session情報がないものや、APIからusageを取得できないものは不明のまま保持する。
- **着手の軽量化:** fast-laneの説明を既知の実行手順単位へ修正。件数・runner内並列度・時間だけではCoordinator必須にしない。結果依存の修正/PRループはCoordinatorが担当する。通常診断はnative read/shellで実施し、dummy validationや全live DB treeのproof入力宣言を避けるよう指示を短く明示した。

回帰テストは、旧unit成功→次Worker開始→reload→取消または実ユーザー置換→旧要件を含まない新run→外部成果物検証→再reload→レビュー/完了までをproduction hooksで実行する。一覧API未提供、終端outcome未記録、取消の冪等性、遅延usageの精算も含む。

`scripts/mission-cold-resume-probe.mjs`は実V2のCoordinator/Luna Fast max Workerを起動し、private serverを停止してから新しいserverで**同じroot**を再開する。最初の実行では一覧API依存の停止を発見。修正候補では再開後のtool拒否0件で新mission completed / receipt succeededに到達した（候補hash `02ee536fb4fd8234f41a2810789ad69e7034b996d588d541a6f1a41e0775d05c`、価格計上約$0.06137476、意図的中断によるusage未確定1件）。最終releaseの固定package・gate結果はrelease receiptへ記録する。

この検証は隔離した実V2 sessionの取消・置換・完遂を証明する。元の23件campaignの再開/採点や最終精算、画像のDesktop mission自体の復旧は別の観測対象である。長時間jobのhost管理とproof入力schema全体の再設計は、この修正で完了したとは扱わない。
