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

## 固定candidateと単件結果

- source commit：`484f8ea3b86356199abdcbcf4ece166c25ff2833`。
- version：`0.13.21`、runtime marker：`0.13.21-operation-recovery-v1`。
  公開release版と同versionだが**local修正candidate**であり、release／publish／global applyは行っていない。
- archive：`_testenv/codex-owned-task-candidate/sortie-dogs-0.13.21.tgz`。
  SHA-256：`69852ef9ba43dcc1ed8802c713b28067b85b800667030dc55c186b9876a13972`。
  `test:windows`でbuild済みの固定sourceから`npm pack --ignore-scripts`。receiptとSHA256SUMSを保持。
- 実driver：`scripts/anko-codex-runner.mjs`、revision `484f8ea3...`、
  SHA-256：`94186972dc9ed89f84a2ccf75786841f8cbedadbdebb85cdb0329ea175f59aa9`。
  元公開entrypoint `_testenv/anko-codex-replay-20261014/runner.mjs`は同driverへのshim。
- 原文SHA-256：`96c0c7ad98237d6176034c8893d8bff164ec5fda45889e51780a65cf599ffcfe`、1,825 bytes。
  base `3f269a72ff69398b1250c584171f32d12c0d8085`、旧fixture／Goを再利用した新clone。
  pre-arm baseline：exit0、42,290 ms。既存CLI `0.162.0-alpha.17.2`とGo1.27.1、認証／permission設定は不変。
- record：`M:/_work/_Sortie-dogs-artifacts/records/anko-codex/owned-task-lifecycle-20261014/20261014T072854315Z-e0e3f757/`。
- outer arm **1**、native inference turns開始 **3**（Root／Worker／Reviewer各1）、
  Worker派遣 **1**、同Reviewerの直接修正 **1**。代替Worker、追加arm、無修正リトライなし。
  provider内部の総request件数は未確認。outer arm数と内側Task／修正unit数を混同しない。

実foreground command：

```text
node _testenv/anko-codex-replay-20261014/runner.mjs run --version 0.13.21 --candidate-receipt _testenv/codex-owned-task-candidate/candidate-receipt.json
```

- host native開始 `2026-10-14T07:29:45.094Z`、終端 `08:07:33.270Z`、**exit0／2,268,176 ms**。
  runner wallは`07:29:45.797Z`→`08:07:33.141Z`、**2,267,344 ms（37分47.344秒）**。
- Root：`01a13951-39c9-7230-a69a-c821866faf7f`、`gpt-6.1-sol`／`xhigh`／`default`。
- Worker：`01a13952-0a89-7270-9d6c-ba458f3679e4`、`gpt-6-luna`／`max`／`priority`。
- Reviewer：`01a13964-5683-7550-bac2-1009be7921cc`、`gpt-6.1-sol`／`xhigh`／`default`。
- Anko Mission：`mission-9a529ddb-b100-490c-9c16-c715402c77e7`、phase `completed`、SDK accepted **true**。
  `root_turn_terminal:true`、`owned_tasks_settled:true`、`mission_accepted:true`、`mission_terminal:true`。
- Worker native終端 `07:50:12.032Z`→同Task復帰 `07:50:12.727Z`。
  Reviewer native終端 `08:05:28.483Z`→同Task復帰 `08:05:29.496Z`。
  Root native終端 `08:07:32.959Z`。両Task復帰後、同Rootで検証結果・commit・Review修正を確認して正式受理。

## 修正効果と未確認

今回の実armではRootがTask未復帰のまま早期終了するeventは**再発しなかった**。
`sortie/continuation`は0件。したがって、live armが新しい遅延結果続行分岐を実際に踏んだとは主張しない。
未完了Task→早期Root終了→host保持→同Root続行の効果は保存event由来の注入回帰で確認した。
実armは固定candidateで指示完遂／受理できたことを確認したが、改善の因果や再発率、速度優位は単発から断定しない。

比較：v0.13.11対応完遂armは43分31.535秒／17,999,005 tokens、
未修正v0.13.21は13分52.956秒／未受理／Worker未終端。
今回37分47.344秒を前者比の性能向上とは扱わず、後者の短時間も高速化とは扱わない。
v0.13.11とのCLI差、provider条件不完全一致は旧比較文書のまま保持。

## 課題成果・検証・Review

- Anko branch：`feature/typed-variable-bindings`。local commits：
  `6cfbd7c109dcd878ff9403d152ae194bef96cc7a`、
  最終 `2949bbf802f5fb1684239315d83b9e6e7ecf0032`。tracked files clean、推し対象なし／pushなし。
  未trackedはbenchmark／Mission／Go cache等の生成物。完遂を全面的なgit cleanと混同しない。
- 全体validator `& ".benchmark/validate.ps1"`：command139 exit1（9,252 ms、test import cycle）
  →同Worker修正後148 exit0（9,413 ms）→最終Worker candidate153 exit0（8,847 ms）。
- 初回独立Reviewerはpointer write-back、callback option、type resolution、multiline parsing、
  lexical error位置、newline後annotation消失の**Medium6件**を指摘し、同Reviewerが修正。
  最終validator244 exit0（9,379 ms）。著者self-recheckは`unresolved_findings:[]`、`residual_major:null`。
  **著者self-recheckを独立した最終PASSへ読み替えない**。Rootの正式受理とは別観測。
- 正式採点は`none`。reward／hidden gradeはunknown。過去の別commit向けreward1を転記しない。
- host commands258（read117／bash105／write36）、全258終端、pending0。
  command区間単純合計217,605 ms。純推論時間や節約額ではない。

## 費用・累積・保存

- 今回SDK thread累積：14,592,263 tokens（input14,453,482、cached13,771,136、output138,781、reasoning97,248）。
  cached／reasoningは内訳であり、totalへ再加算しない。
- 対応v0.13.11＋未修正v0.13.21＋今回の観測小計：**37,295,298 tokens**。
  未修正armのWorker未終端snapshotを含むため、3 armの確定最終総量ではない。過去armは保持。
- native subscription USD請求／推定／残額はunknown。別Linux／OpenCode campaignの$15上限を転用しない。
  外側修正Missionの直接authorはOpenCode `ses_ec6c3dc43ffenm80kj0exR63h4`／`openai/gpt-6.1-sol#xhigh`。
  外側費用は内側Anko token小計に含めない。host ledgerのusage欠測を0へ変換しない。
- result／conditions／events／commands／usage／quality／cleanup／run-once.lockと固定tgzを保持。
  元製品の既存Mission／override、dataset、global C／O／npm配置、旧結果は不変。
- 停止理由：今回`accepted`。次操作はSortie修正の独立ReviewとPR配送。追加Anko／23件／release／publish／再起動なし。

結果整合性check（同runの収集、再armなし）：

```text
node _testenv/anko-codex-replay-20261014/runner.mjs verify --version 0.13.21 --candidate-receipt _testenv/codex-owned-task-candidate/candidate-receipt.json
```

## 独立Review後の同Task修正

実armの終了後、Sortie修正の独立ReviewでMediumを1件再現した。
既存Workerがcommand結果待ち中にnative応答を終了すると、遅延commandは正常に復帰するが、
内部続行文を初回Task admissionへ渡すため`operator-worker-task-reference-mismatch`となり、全hostが停止していた。
Rootの保存event回帰と今回の実arm（continuation 0件）だけでは、この子Task経路を検証できていなかった。

host起因の結果続行だけを初回Task再claim／新しい実user要求と分離した。
同session、既存admission、モデル／effort／service tier、Mission owner、消費済みbudgetを維持し、
既存のclose・失敗・transport loss経路は変更しない。新しいpublic optionや権限gateは追加しない。
公開Mission harnessにcommand exit0／exit7のWorker回帰を追加し、失敗exitは同Taskへそのまま渡し、
同Taskの修正・正式check・commit・Root Review／受理まで確認する。
修正前の限定checkは37 PASS／2 FAIL、修正後の同checkは39 PASS（ともに`test/codex-mission-session.test.ts`）。

修正後の統合候補では以下を順次実施し、native exitとsource snapshotは既存check記録に残す。

```text
npm run test:targeted -- test/codex-app-server.test.ts test/codex-mission-session.test.ts test/codex-run-mission.test.ts test/anko-benchmark-runner.test.mjs
npm run test:full
npm run test:windows
node _testenv/anko-codex-replay-20261014/runner.mjs verify --version 0.13.21 --candidate-receipt _testenv/codex-owned-task-candidate/candidate-receipt.json
```

この追加修正は上記実armの**後**であり、固定`484f8ea3`／tgz hashを差し替えない。
実armの結果を修正後sourceのlive実証へ読み替えず、追加Anko／23件評価／release／publish／global applyは行わない。
独立調査から同Reviewerによる修正・著者self-recheckへ移行したため、修正後の報告は独立PASSではない。
次操作は統合候補の著者self-recheckとRootによる要求比較・PR配送。
