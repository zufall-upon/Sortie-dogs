# 正式完了後の保留要求とGoal登録の整合性

## 保存実V2履歴の原因

OpenCode 2.2.5、Sortie-dogs `0.16.6-goal-ledger-blobs-v1` の実読込情報と保存tool履歴を照合した。画像の説明だけを根拠にしていない。

1. 別要求Bと追加情報が、作業Aの正式完了より前に実ユーザー入力として届いた。
2. AはGoal revision 27で正式成功。台帳は `terminal`、消費28/32、予約0。
3. rootがBの新Missionを開始したが、`plan_units`はprepared run保存後、旧Goalへ `goal.revised` を登録した。
4. reducerが `Scope revision is stale or resets consumed budget.` を返した。今回の違反はterminalへのrevisionであり、残額不足ではない。
5. Mission/run結合は登録成功後なので、続く `start_direct_unit` は `mission-run-registration-incomplete: retry plan_units with the same plan to finish goal registration and Mission binding; no unit admitted` で拒否。Worker経路へ変更しても同じ登録段階で止まった。

圧縮そのもの、サイト容量、旧版未読込、OpenCodeの実ユーザー権限消失が原因とは確認されなかった。登録遷移を選ぶSortie-dogs側の不具合であり、reducerのterminal保護は正しい。元サイト・画像・実台帳・他の稼働セッションは変更していない。

## 実ChatGPT相談

利用者指定の既存内蔵ブラウザの[ChatGPT会話](https://chatgpt.com/c/6aebf164-79b0-83ee-88d9-ea63c7792ccf)で、rootが匿名化した Goal → Constraints → Observed facts → Question を送信し、生成終了と回答完了まで回収した。Coordinator側の `browser.disconnected` は相談実施と数えていない。認証情報、DB、顧客URL、個人パス、元画像、無関係な会話は送信していない。助言は実行権限・正式検証・独立Reviewの代用ではない。

回答の主要部分（原回答から引用）:

> 今回の障害は、Missionの切り替えとGoalのライフサイクル遷移が混同されていることが本質だと判断します。
>
> 推奨は「保留済み実ユーザー要求Bを、Aの正式完了後に新しいGoalとして受理する」方式です。
>
> Bのmessage IDが存在するだけでは不十分です。Bが未処理であり、Aの受理済み要求とは別であることも確認します。
>
> Bを新Goalとして受理しても、消費28/32を新規0/32にしてはいけません。
>
> 受理成功とrun結合の間で失敗しても、再試行によって`goal.accepted`やrunが重複しない必要があります。
>
> ただし、受理時の予算継承方法、Bの未処理判定、prepared runの再利用条件は、提示された情報だけでは完全には確認できていません。ここはsourceと照合して確定させる必要があります。

採用した助言:

- terminal保護維持と、新しい実ユーザー入力を要求しない既存受理処理の再利用。
- 同じB Mission・prepared runの冪等再登録。受理直後とMission/run結合前の中断再試行。
- 旧receipt・要件・添付参照・既存成果・検証の入力hash/鮮度・失敗履歴・担当を原本のまま保持し、予算系列だけ継承。

具体案の条件付き採用と変更:

- 通常の `goal.accepted` はreducerで予算消費を初期化するため、単純呼出しは不採用。
- 正式受理部分は `acceptRealGoalTurn` を再利用し、限定された `goal.queued-accepted` イベントで旧terminal receiptと同一予算を検証する。消費units/time/costと検証予算は前状態から導出し、model指定の繰越額を受け付けない。
- 新Goalの満足criterion・証跡参照・unit一覧は空から開始する。AのPASSをBの証明へ付け替えない。
- 新しい復旧framework・監視・承認待ち、Aの再open、terminal guard削除、手台帳編集、ユーザー偽装、予算0reset/自動増額は不採用。

## 実装と互換性

公開 `plan_units` の既存登録段階で、Mission/root/plan source refsを照合する。terminal時に限り、現在Missionの原要求について、正規native user messageのID、root、agent、非synthetic parts、原文、受信時刻を確認する。別Goalで受理済み、またはscope revisionに採用済みの要求は新規受理しない。

受理は旧Goal ID・receipt fingerprint・Mission ID・要求fingerprintを保存する。再起動後に同じMission/要求の受理済みイベントがあればその事実を再利用し、新Goalやrunを追加しない。prepared runのcontrol hashとplan hashは既存の検査・再利用経路を維持する。

新イベントは新Goal IDを使うため、それを知らない旧reducerはGoal identity mismatchで拒否し、予算を0へ解釈して書き進めない。既存の旧形式ledger、immutable blob保存、hash chainと同じlockは変更しない。既存の圧縮/背景通知の表示compact化、direct retry、cancelled writer解放も維持する。新しい受理種別を読む既存の履歴集計・帰還報告callerも更新する。

## 再現・確認

- 隔離された既存publictool fixtureで「A revision27/terminal成功・B事前受信・消費28/32・予約0」を生成。実ユーザーの台帳/DBやサイトをfixtureへ取り込まない。
- 初回はfixtureの成功証跡設定不足でterminal生成が拒否されたため、fixtureのみ修正。その後、未修正実装の公開 `plan_units` が保存故障と同じエラーになることを確認した。
- 修正後はroot/Coordinator両経路の登録と、受理直後・結合直前の中断→plugin再作成→同prepared run再利用を確認する。
- 旧record prefix/receipt/hash・28消費・32上限・time/cost（未取得を含む）を保持する。late usageの再集計でも繰越costを失わない。
- native user proof欠落/別root/assistant/synthetic/原文変更、受理済み要求、receipt不一致、上限増減を拒否する。残4に対する5unit計画と、消費+予約が上限に達した後の追加予約も拒否する。
- 既存の通常revision、prepared再試行、writer競合/direct retry、圧縮/背景通知、大容量台帳とcaller回帰は関連チェックと最終統合検証で確認する。

独立Reviewでは、B登録後にAの未取得native usageが届いても累計costを更新できないMediumを検出した。既存公開fixtureの `operator_status` で、Aの後着usageとB自身のcostを合算した期待値 `7.2503` に対して `null` が残ることを修正前に再現した。queued受理の予算系列だけsettled unitの価格履歴を保持し、旧Goalの正確なreservation/native sessionに対する価格照合を許可するよう修正した。通常の `goal.accepted` は引き続き別予算系列であり、旧receipt・証跡・消費unitは変更しない。同じstatusの反復では価格イベントを追加せず、別native sessionによる照合も拒否する。

正式コマンド・終了値・所要時間・PRレビュー採否はPR本文/コメントに実行後記録する。修正だけで元の画像圧縮や稼働セッション復旧の実成功を主張しない。今回の配送はPRまでであり、global apply、release/tag/npm publish、自動再起動は対象外。
