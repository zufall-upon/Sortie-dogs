# Operatorの戦略判断と同担当への復帰

## 今回の原因区分

2026-11-03、簡易リリースでも検証・修復が増えるという指摘を、利用者提供の原画像と
Sortie-dogsの既存source・公開PRから調査した。個人の反省だけで解決とは扱わない。

- WindowsのMobMate履歴ログは当地にはなく、利用者もログなしと明示した。
  画像の「package 16分36秒」「17:16〜19:53の2時間37分」は担当者の説明であり、
  native commandの実測ではない。差を全て無駄と計上しない。
- inactive登録が公開Build生成に必要という説明も画像内の主張。
  実際の公開要件、dry-runの重複、追加を決定した主体・当時の実ロード版は未確定。
  リリース担当の独断、Sortieの要求、正常なguardによる復旧を断定しない。
- 追加の原画像2枚には、文書checker反復失敗で中断し、利用者の指摘後に
  commit差分・文書/source直接照合へ変更したという説明がある。
  当時のcheckerが正式な必須検査だったか、その変更が正規登録されたかは証明しない。
- 現行sourceはOperatorを戦略責任者と定義し、目的比較・証拠再利用・不要工程の回避も
  既に指示している。戦略判断を禁止する権限設計とは確認できなかった。
- 一方、終了したCoordinatorに未完了unitがあると、hostの次操作は単に同担当の再開を
  勧める内容だった。失敗した手段を続けるべきかの判断と、具体方針の入口が弱かった。
  optionalな`purpose_decision`保存は戦略上の観測であり、工程逸脱の自動制御ではない。
- public tool fixtureでは、native終了したCoordinatorのdirect unitが保持中の場合、
  rootの`plan_units`がunitの`running`だけを見て補正案のcontinuationを返さなかった。
  完了済みunitには既に具体案の伝達経路があり、そちらを作り直す必要はない。

従って、今回直すのは既存の役割契約・復帰案内と、保持中direct ownerへの具体案伝達。
Windows事例の責任確定や、AIの判断能力全般を保証する修正ではない。

## 重要方式の相談と採否

相談先は利用者指定の既存ChatGPT会話。接続済みrootが内蔵ブラウザを担当し、
最初の原画像7枚、追加の原画像2枚を実際に添付した。
子側の`browser.disconnected`を繰り返し呼ばず、接続済み経路を使った。
実回答を取得してから方針を確定した。助言は正式検査・SourceReview・実行権限ではない。

- 「工程自己増殖の独立評価」：疑いには根拠があるが原因は分けるべき、
  Windowsログ探索・製品再現は不要、当地で確認できる既存経路を調べるという評価を採用。
  source上の確定挙動と画像内説明を混同しないため。
- 「要求縮小時の受入・証拠再利用方式」：本文不変の独立項目削除だけの限定案を
  条件付きで支持。任意の言い換え・旧PASS再割当は不採用。
  ただし現行要求は`{id,text}`で安全条件の種別がなく、実際の長い要求の言い換えも
  この案の対象外。受入機構・分類器へ拡大しないため、動作実装は今回見送った。
- 「Operatorの戦略判断能力に関する独立評価」：
  「戦略を判断することと、実装作業を奪うことは別」、
  役割契約の局所補正と既存hostの復帰案内改善を推奨した回答を採用。
  指示追加だけ、root常時実装、新監督役・毎回承認は採用しない。
  この判断は利用者の「仕組みの問題」という追加指摘と新2原画像を踏まえた方法変更。

## 変更する契約

予定内の有用な実行には介入しない。手段が停滞したり不要工程が提案されたときに、
Operatorは元目的・実成果・具体的未達を比べ、継続・変更・その手段だけの中止を判断する。
単に担当の停止報告を利用者へ中継して全体停止にしない。

必須の成果・検査と、AIが選択したchecker・表示形式・手順は区別する。
ただし自選の手段でも正式validationに登録済みなら、正規recipe訂正・再計画が必要。
未実施検査を省略したり、直接の目視確認を架空の正式PASSへ昇格したりしない。

具体案が必要なら、rootは既存`plan_units`の`units`、`reason`、`handoff_context`へ
代替手段・根拠・維持する条件を渡す。返るTaskは提案であって新契約のadmissionではない。
同じCoordinatorの実入力へ届き、担当が通常の判断と正規操作で扱う。

保持中direct unitの例外は、Coordinatorのnative終端・lineageと既存quiescence確認が
成立した場合だけ。同じsession/unit/予約を再開する。live/不明owner・未終端tool、
Worker稼働、pending Reviewには別Taskを出さず、所有権・予算・検査・Reviewを保持する。
新API・状態・監視・gate・必須記録制度・専用runnerは追加しない。

## 検査と限界

既存の`operator-mission.test.ts`で生成される役割契約を、
`mission-completion.test.ts`でpublic root提案→同担当の実入力→元direct unitの検査/精算を検査する。
live/unknown/background-toolにはcontinuationなし、提案だけではrun・予約・消費を変更せず、
元の実check後に同じ予約を一度だけ精算する。既存pending Review・Worker保護も維持する。
文字列assertionを実モデルの戦略判断改善の実証とは呼ばない。

正式関連検査（cwd: source checkout）：

```sh
npm run test:targeted -- test/mission-completion.test.ts test/operator-mission.test.ts test/mission-direct-execution.test.ts
```

別の探索では、完成候補から要求1項目を削除する`start_mission(intent=replace)`が新Missionへ
変わることをpublic fixtureの失敗として確認した。失敗commandは以下。動作は未修正。
探索用testは採用済み仕様ではないため最終sourceから除去したが、native失敗履歴は保持する。

```sh
node --experimental-strip-types --import ./test/setup.ts --test --test-name-pattern="completed candidate narrows" test/mission-completion.test.ts
```

PR #316の目的判断保存、#320のdirect検査recipe復旧は統合済みで再実装しない。
今回の実装中にもrecipe訂正の契約拒否を観測したが、台帳・実ロード版の直接変更はしない。
登録済みの関連suite内で実際の新回帰を扱い、未登録の新commandを正式PASSと偽らない。
リリース再実行・製品操作・新しい実モデル実験・full suite・benchmarkは行わない。
到達点はPR作成まで。merge・global apply・公開は対象外。
