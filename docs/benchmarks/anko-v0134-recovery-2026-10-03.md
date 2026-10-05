# Anko v0.13.4 recovery — 2026-10-03

## Recovery outcome

- 固定archive: `sortie-dogs-0.13.4.tgz`、SHA-256 `bebd61ae1f935ae1a83d8af6e1720e1d3efd1af0b584ca534ded6d308cefd9b1`。base `3f269a72ff69398b1250c584171f32d12c0d8085`、branch `bench/anko-v0134`。
- 既存root `ses_eff52a8d6ffeiq2Q1cyt2fSy3p`、Mission `mission-9b605f07-26c0-426c-a10f-150a55729ecc`、元Worker `ses_eff5218e7ffeP9Jzlcx5ThFVPU`を継続。新root・新benchmark armなし。
- Recovery `2026-10-03T09-08-06-428Z-20476` は `cumulative-priced-cost-cap` で停止。Mission `submitted`、submission `blocked`、Operator `awaiting-decision` / `interrupted`、Reviewなし、root receiptなし。Coordinatorの `mission-replan-terminal-unreconciled:descendant_records_unavailable` により、旧childのterminal／descendant履歴をreconcileできなかった。実装、Go局所検証、Review、候補commit、受付receiptは未完了。
- 候補は固定base上でclean、実装commit 0件。製品sourceと固定packageに変更なし。official scoring: not run。
- Native historyは3 sessions / 381 messages。観測route: root `openai/gpt-6-sol#xhigh`、Coordinator `openai/gpt-6.1-sol#xhigh`。Workerは `openai/gpt-6-luna-fast#max` 設定だが、token usage未観測。最終分類はpriced 193件、token付きunpriced 0件、pending 0件、完了／error済みだがtokenなし3件。このmissing-token記録は請求ゼロを意味しない。
- Recovery runnerはroot promptを86 turn送信。最後のroot turnのpriced usageが次回accounting poll前にcost上限を超え、上限超過後に停止を検知した。これは観測済みwait/stop不備で、追加usageの許可ではない。
- runner計上active elapsed `1,602,950 / 3,600,000 ms`（うち1,000 msは保守的加算）。この数値には先行setupの未計測2区間が含まれず、全作業の確定所要時間・残時間とは扱わない。停止から最終復旧開始までのgapは`5,721,632 ms`。推定API相当usage `$5.0388176`、累積上限 `$5` を `$0.0388176` 超過、priced headroom 0。`invoice: unknown`。元の上限ではモデル作業を再開しない。
- 隔離run DBに復旧履歴を追記後、server停止後にcredentialを除去。run DBとsnapshotのcredential rowは各0件。永続original DB copyとoriginal usage snapshotは不変。one-shot lock、凍結`run.mjs`、provenance、package、過去observation、native historyを保持。Recovery driver SHA-256 `23cefdaa757c657f83a2aaf10af4fac1374f9da881126d055ed2bce328b8c62f`。実請求額は不明。

## Runner correction and reproduction

- `recover.mjs` は凍結`run.mjs`と別entrypoint。usage classifierはzero-token pending/interrupted記録とtoken付きunpricedを分離し、後者のみunpriced safety stop対象。完了predicateはMission accepted、root receipt succeeded、rootと全owned child terminalを要求。
- `node --test _testenv/anko-v0134-20261003/recovery-state.test.mjs` — exit 0、5/5、71.495 ms。root idleとMission完了の区別、active childの拒否、priced/pending/missing-token分類を検証。
- Preflight-only recovery `2026-10-03T09-03-06-646Z-35596` は元childがすでにinterruptedだったため失敗。モデル実行・新armなし。shellから所要時間を取得できず、上限計算に保守的な1,000 msを加算し、記録を永続archiveへ複製。
- `node _testenv/anko-v0134-20261003/recover.mjs` — exit 1、計測区間1,548,451 ms。同じroot/Missionを継続したが、descendant record blockerを解消できず、cost上限を超過して停止。
- `node _testenv/anko-v0134-20261003/verify-recovery.mjs` — exit 1、`recovery did not observe actual accepted mission completion`（`recovery.terminal === false`）。未完了Missionを成功扱いしない正しい失敗結果。
- 復旧出力は8区間。最初の2区間は空directory／serverログとsnapshotのみで、所要時間・実行terminalの確定記録が不足。後続はruntime未active、Task参照取得失敗、child prompt HTTP 500、zero-token分類による停止、interrupted child preflight失敗、最後のcost-cap停止。元childへの継続promptは2区間各1回、最終区間のroot継続promptは86回。元`run.mjs`のarm数1と、この復旧履歴を混同しない。
- 外側の復旧担当Workerは1 dispatch。hostのworker-only推定usageは`$0.21635476`、settled timeは`4,346,852 ms`。これは上記Anko native treeの費用・active時間とは別scopeであり、外側調整・read-only review・実請求額は含まない。両者の既知推定額合計は`$5.25517236`だが、全体請求額とは扱わない。
- 完全履歴はexport 381件とDB 381件のmessage IDが一致。localと永続最終復旧出力の全file hash一致。元server PID 21944、最終復旧server PID 10868は停止済み。candidateは固定baseのままclean。
- push、PR、release、publish、hidden grader、別benchmarkなし。復旧記録とcredential-free snapshotは`_testenv/anko-v0134-20261003/recovery/`および対応する永続`M:/_work/_Sortie-dogs-artifacts/records/anko-v0134-20261003/recovery/`に保持。

## Earlier offline correction after the original $5 cap

計測時driverとhelperを`recovery/observed-driver-23cefdaa757c/`に別保存。計測済みdriver SHA-256は上記のまま。当時のoffline candidateはnative blocked／needs-decision submissionで停止し、rootの発言・usage増加だけを進捗とみなさず、同じMission／unit／child状態へのroot prompt反復を停止する。active childと未settle promptは引き続き待機し、実際のunit状態変更後だけ次のroot継続を許す。各prompt直前にも累積usage・active時間を再読取するが、未報告のin-flight usageをゼロ扱いしたり、厳密な課金上限保証を主張したりしない。

この補正後の実推論はその時点では未実施。完走、独立レビュー、Anko commit、accepted receiptも未達。後続の`$15`承認後に行った実推論は次節に記録する。追加armやbudget resetはない。

- `node --check _testenv/anko-v0134-20261003/recover.mjs` — exit 0。構文のみ、モデル起動なし。
- `node --test _testenv/anko-v0134-20261003/recovery-state.test.mjs` — exit 0、10/10、runner内計測76.051 ms、host native区間7,132 ms。反復停止修正を加えたため再検証。既存5件に同状態ack停止、unit進捗後継続、active child／pending prompt待機、blocked／needs-decision停止、完了predicate維持を追加。
- `node _testenv/anko-v0134-20261003/verify-recovery.mjs` — exit 1、同じ未完了assertion、host native区間7,022 ms。runner候補の補正後も未達の完走条件を維持したことを確認。
- 上記はnative実行の観測記録。`finish_direct_unit`は`mission-review-correction-validation-missing`を返しており、Mission formal PASS・完了受付はない。保存済み最終candidateへのチェックを再照合するが、cost-cap枯渇中の復旧entrypoint・追加推論は再実行しない。

## User decision required at the original $5 cap

固定累積推定API相当上限 `$5` を超過。継続に必要なのはユーザー指定の新しい累積上限であり、費用履歴をゼロに戻す承認ではない。時間は上述の未計測区間と外側作業scopeを保留し、`60分`を新たな60分に戻さない。新root・新Mission・新benchmark armは提案しない。同じMissionを再開する場合も、先に `descendant_records_unavailable` blockerのnative履歴routeを解決する。上限延長だけではその技術障害の解決・完走を保証しない。

## User decision and native descendant-route correction

- 2026-10-03のユーザー判断で、累積推定API相当上限を既消費 `$5.0388176` 込み `$15` に変更。60分・単一armは維持。固定 `run.mjs`、one-shot lock、Mission、root、child、base、packageは変更・再起動しない。
- native履歴route調査で、保持済み固定packageの `dist/plugin/v2-session-history.js` は `Service.discover()` から所有V2 serviceを検出し、未検出時に `v2-history-owning-service-unavailable` を返すことを確認。`dist/plugin/v2.js` の `session.children` は公開 `session.list({ parentID, limit, cursor })` に委譲する。V2 client 2.0.18 の `dist/promise/service.js` はservice registration fileを読む実装で、生成型 `dist/promise/generated/types.d.ts` に `SessionListInput.parentID/cursor` と `SessionsResponse.cursor` がある。CLI 2.0.18の `serve --help` は `--service` を公開。従来recovery server起動は `--service` を省略していたため、固定adapterのfallback discoveryと `descendant_records_unavailable` の観測に一致する。
- runner candidateはserverを専用 `XDG_STATE_HOME` と `serve --service` で起動し、service登録PIDの一致と、公開V2 `session.list(parentID, cursor)` による固定child発見・全descendant paginationを推論前に確認する。native履歴exportも同じparentID routeを使う。service registrationはserver終了後に所有PIDを確認して除去し、credentialを外部記録へ保存しない。製品sourceと固定packageは不変。
- 直前の状態が `blocked` でも、保存summaryに `descendant_records_unavailable` があり、native routeの事前検証が成功した場合のみ、同じrootから1回のreconciliation continuationを許可する。未進捗の同状態再prompt、他のblocked状態、`needs-decision` は停止する。
- 既存elapsed・推定usage・失敗preflight保守計上を引き継ぐ。以前のsetup計測欠落とrestart gapは記録を保つが、elapsed上限の既知加算には捏造しない。`time_cap_residual_upper_bound_ms` は既知時間だけで算出した上限値で、確定残時間ではない。外側作業時間と実請求額は不明。
- 新candidateのnative推論前検証と最終状態は次節に記録する。現段階では完走・Review・commit・accepted receiptを推測しない。

## Model-correct native recovery and cumulative-cap outcome

- 既存Mission `mission-9b605f07-26c0-426c-a10f-150a55729ecc`、root `ses_eff52a8d6ffeiq2Q1cyt2fSy3p`、元Worker `ses_eff5218e7ffeP9Jzlcx5ThFVPU`、base `3f269a72ff69398b1250c584171f32d12c0d8085`、branch `bench/anko-v0134`、固定archive SHA-256 `bebd61ae1f935ae1a83d8af6e1720e1d3efd1af0b584ca534ded6d308cefd9b1`を継続。新root／新Mission／新armなし。
- 10:34の試行はserver API `UnauthorizedError: Authentication required`で推論前に停止（565 ms、priced usage増加なし）。その後の10:50 preflightでは、最新の不完全な失敗記録だけを参照し、09:08の完全native snapshotから同じblocked Mission／interrupted childを確認できず停止。新推論・state変更なし。未計測時間として各preflightに保守的1,000 msを計上し、後続start recordへ継承。
- recovery driverは隔離V2 serviceへ一時Basic passwordを設定し、service登録に対応する認証済clientを使用。`session.list(parentID, cursor)`で固定childと全descendantをnative確認。09:08以前の完全snapshotも照合対象へ含め、不完全な最新attemptで根拠を失わないよう修正。
- 10:51:14Zからの `node _testenv/anko-v0134-20261003/recover.mjs` は、既存rootの `session.switchModel` を最初のresume inference前に実行し、`openai/gpt-6-sol#xhigh` から `openai/gpt-6.1-sol#xhigh` へ切替。旧message履歴とそのpriced usage保持。Coordinatorの既存 `gpt-6.1-sol#xhigh`、Luna Workerの `gpt-6-luna-fast#max` は不変。実native usageでは旧SOL 183 messages（182 priced、1 missing-token、`$4.917976`）、新SOL 72（71 priced、1 missing-token、`$3.1757132`）、Luna 5（3 priced、2 missing-token、`$0.00255064`）。旧SOL記録は過去履歴であり、新規推論routeではない。
- 開始時の既知累積値: `$5.0388176 / $15`、priced headroom `$9.9611824`、known elapsed `1,605,515 / 3,600,000 ms`、known residual upper bound `1,994,485 ms`。restart gaps・以前の未計測区間は別記録で保持し、60分をリセットせず、gapを測定済elapsedへ捏造加算もしない。
- 実行終了: exit 1、stop reason `cumulative-wall-time-cap`。計測recovery elapsed `2,024,536 ms`、累積 `3,630,051 ms`で、60分上限を `30,051 ms` 超過。native state collectionがdeadlineを跨いだことを確認。これ以降のmodel inferenceは実施しない。累積priced estimate `$8.09623984`、残headroom `$6.90376016`。missing-token 4件はゼロ費用扱いせず、実請求額 `unknown`。
- Final native状態: root outcome `succeeded`、元Worker `succeeded`、Coordinator child `interrupted`、Reviewer correction child `interrupted`。Mission `running`、submissionなし、Review `findings`、Operator `running`、root receiptなし。全owned childはnative terminalだがaccepted Missionではないため、recovery `terminal=false`。official/hidden/additional scoringなし。
- 隔離Anko clone: `bench/anko-v0134` HEAD `2405d10f48acef2dd0e16714886ff2b7afaae0ba` (`Implement typed variable bindings`)、固定baseから1 commit。Reviewは`findings`。Reviewer correction childの作業が残り、candidate worktreeも未commit差分あり。requested final review／accepted submission／receiptは未達。Anko指定 `go test ./...` は未解決correction差分に対して再検証していない。
- 原本native history 4 sessions／460 messages、credential-free run DB／snapshot（credential rows 0）、usage、logs、dataset、固定archiveをlocal `recovery/2026-10-03T10-51-14-368Z-22988/` と永続 `M:/_work/_Sortie-dogs-artifacts/records/anko-v0134-20261003/recovery/2026-10-03T10-51-14-368Z-22988/` に保持。成功runに使ったdriver SHA-256 `96a85264eb60b5fd13e99ead114feec5c3beb75b3eb46b378604c4f538d2a424` は `recovery/observed-driver-96a85264eb60/` に別保存。
- 上限超過を受け、未実行のoffline driver candidateへbounded correctionを追加: inference cutoff前に180,000 msをfinalization用に予約、native state collectionを30,000 msでabort、final native stateは同一collect結果を再利用して重複exportを削減、unsettled promptもinterrupt対象に含める。過去に実行したdriverとは別candidateで、live resumeには未使用。current runner SHA-256 `be694b61b61ac6f4a88eadf4d426e6d5b6791de0d8bfef064477aa81d6561f7c`、source snapshot `recovery/offline-correction-cap-reserve-20261003/` と永続recordsに保持。`node --check _testenv/anko-v0134-20261003/recover.mjs` — exit 0。正式check `node --test _testenv/anko-v0134-20261003/recovery-state.test.mjs` — exit 0、15/15、75.197 ms。
- 正式check `node _testenv/anko-v0134-20261003/verify-recovery.mjs` — exit 1、line 92で測定driver保持先のhash不一致。frozen verifierは既知の `23cef...` snapshotを選び、実行時driver `96a852...` を期待するため、この呼出しはterminal／Mission acceptance assertionへ到達しない。実行driverで得た最終native stateは上記の通り `terminal=false`、Mission未完了で、accepted receiptなし。verifier／frozen `run.mjs`／one-shot lockは変更なし。原本run出力と測定driver snapshotは保持。
- 60分上限を超過し、Review findingsと未commit correctionが残るため同じMissionのinferenceは停止。継続にはユーザーによる既存累積時間上限の明示的延長が必要。累積usage・restart gap・固定arm・existing Missionを維持し、新root／新Mission／予算resetへ迂回しない。
