# Codex owned Task終端管理の修正

## 対象と固定条件

- baselineは[Anko v0.13.21途中停止](anko-v01321-20261014.md)。保存eventを再利用し、baseline armは再実行しない。
- 最新`origin/main` `04c3f31972a25ac65f6c2e6c26eab49b4b60ce2e`から`fix/codex-owned-task-lifecycle`。
- 同じAnko原文、base、Windows native Codex SDK、既存CLI／Go、3600秒、grading `none`、修正candidateで1 arm。
- local source candidateは公開releaseと同じversion `0.13.21`。source commit、tgz hash、runner revisionを別々に固定する。global配置／設定／Location overrideを変更しない。

## 最小修正

`CodexAppServerHost`はnative `turn/completed`時に残っていたdynamic tool Promiseを保持する。
正常native応答でもそのtool／子Taskの復帰前に`runTurn`を返さない。protocol pumpは動き続け、command responseやchild terminalを受け取れる。
復帰した結果は`deferredToolResults`として渡す。native完了itemや過去のTask成功を補作しない。

`CodexMissionSession`はその結果だけを同じthreadへ1回渡して後続処理を続ける。
元課題の再送、Task置換、待機中の推論／polling、予算reset、台帳手編集、新しい権限gateはない。
失敗／interrupted native turn、明示close、transport lossは通常の停止経路を保持し、成功へ読み替えない。
Missionがcompleted／cancelledなら追加turnを作らない。tool失敗は失敗結果のまま同Missionへ返す。

CLIとrunnerは`root_turn_terminal`、`owned_tasks_settled`、`mission_accepted`を分離する。
`mission_terminal`はMission state由来であり、Rootのnative `completed`だけではtrueにならない。
旧resultにある誤ったflagはそのまま保存し、旧記録の意味を後付け変更しない。

## 回帰と検証

- `test/fixtures/codex-anko-pending-task.json`は保存eventのlifecycle投影。原event SHA-256を記録。
  未観測のWorker終端はfixtureにない。testで注入した遅延完了を旧runの実証へ転用しない。
- app-server回帰：Root完了中もTaskを保持、遅延成功／失敗、close、transport loss、native failed／interrupted。
- Mission回帰：同じRoot／Mission／既存Taskで検証、commit、Review、root受理へ続行。待機中の追加turnなし、子の再派遣なし。
- 既存public CLI progress、command evidence／cold recovery、native run-missionとAnko runner checksを再利用。
- 限定check：`npm run test:targeted -- test/codex-app-server.test.ts test/codex-mission-session.test.ts test/codex-run-mission.test.ts test/anko-benchmark-runner.test.mjs`、exit0、125件PASS、setup込み23,359 ms。
- 最終統合：`npm run test:full`、exit0、setup込み360,776 ms（test部分346,528 ms）。
  続いて`npm run test:windows`、exit0、19件PASS、build10,489 ms＋test4,116 ms。
  限定／full snapshot SHA-256は同じ`a1a94d03b564d34b1969fb04f823fc8f66ef6fb96c7973622f5b4b9461460d5c`。
  記録：`_testenv/wsl-*/source.json`、`result.json`、stdout／stderr。
  初回局所60件もexit0。host transport-loss後のlate-send防止とrunner変更をまとめた後だけ125件／fullを実施。

## 単件と配送

実行前にsource commitとlocal `.tgz`を固定し、既存replay entrypointから同じparameterized driverを使う。
新規arm1回のみ。実結果、Task終端、検証、Review／受理、時間／累積費用、停止理由／次操作を追記してPRへ配送する。
正式採点なし。課題完遂と終了管理の効果を分け、未確認を成功扱いしない。
