# V2 background終端と中断後の正規継続（2026-11-07）

## 原因と最小修正

基準は `main` / `origin/main` の `d8073040f33fec0d21dd806e7c06ea05e0bbccb3`。
cleanな既存checkout、MIT、Node 22.22.1、npm 10.9.4、既存node_modulesを使用。

保存V2履歴を読取確認したところ、background shellのlaunch toolは
`state.status=completed` / `metadata.status=running` のまま残る一方、
同じSessionにnativeの `synthetic` / `metadata.source=shell` /
`metadata.state=completed` 通知が保存されていた。launch完了はprocess完了ではないが、
後者まで無視して再登録を永久拒否するのは不具合。

- V2履歴adapterで、同じshell ID（job IDがあればそれも一致）、command、
  launch終端以後の時刻を持つ一意なnative通知だけを照合し、投影上のstatusを完了へする。
  proseの終了宣言、別ID/command/Session、古い通知、重複通知は解放根拠にしない。
- 通知のexitやprocess終了時刻をforeground検証へ移植しない。
  process終端はquiescenceであり、検査成功・成果完成・Mission受入ではない。
  native履歴自体も変更しない。
- 中断でafter hookが失われた同一所有者のdirect unitは、既存の正確なnative tool終端を
  再照合してから通常のreplan/handoffへ進む。未終了・欠落・重複・他者の記録は従来どおり拒否。

## 意図した境界（解除しない）

別rootのwriterは、そのSessionが非稼働というだけで親へ移譲できない。
今回のVDM実験の残存writerはこの安全条件であり、横取りする修正はしない。
正規の元所有者による同Mission継続・handoff、またはそのrootの通常cancelが必要。
既存の正確なsettlement、lease、予算、入力結合を維持する。
今回、それらの操作を停止済みVDM rootへ送ってはいない。

初回controller/Workerの `mode=self-recheck` は、修正著者Reviewerのnative
invocationではない。既存機構を一般的な自己承認へ拡張しない。
著者を選べない場合は、曖昧な `mission-review-selected-author-mode-mismatch` の代わりに
`mission-initial-self-recheck-unavailable` と次操作を返す。Review/受入は記録しない。
必要な独立Reviewは `mode=independent`、真に低riskなら `risk_tags=[]` で通常skip。
追加agent禁止かつ実質riskありなら、その制限を未検証として報告する。
既存Reviewer修正著者のself-recheckと独立PASSの区別は不変更。

## 独立Reviewで確認した中断起動の補正

Major: shellの起動toolが中断されると、`state.status=error` とprogressの
`metadata.shellID` だけが残り、独立background Jobはまだ実行中の場合がある。
`metadata.status` の欠落を静止と誤認すると、replan/handoffで旧processと新writerが重なる。
V2投影ではこの状態を `unknown` とし、同じ一意なnative完了通知がある場合だけ完了へする。
通常のpatch/error、foregroundの検証exit、native保存履歴は変更しない。

根拠はOpenCode V2 2.2.2の `packages/core/src/tool/plugin/shell.ts`
（shell.create → progress({shellID}) → Job.start/background → launch結果）と
`packages/core/src/session/runner/publish-llm-event.ts` のfailureSnapshot。
中断時のprogress保存はprocess終端の証明ではない。
既存の公開replan/handoff fixtureで、after-hook喪失＋error/shellIDのみを追加。
修正前は2件とも拒否されず失敗（exit 1）。修正後は通知なしのhot/cold継続を拒否し、
正確な完了通知後だけ同Missionの正規経路へ回復することを確認する。
これは同Reviewerによる指摘修正と著者self-recheckであり、修正後の独立PASSではない。

## 回帰確認

既存 `test/v2-plugin.test.ts` にnative通知照合と、after-hook喪失＋中断patch＋
background終端後のpublic `plan_units` replan/handoffを追加。
既存 `test/mission-direct-execution.test.ts` のroot/coordinator両経路で、
初回self-recheckの非受入と後続独立Reviewを確認する。
追加した5件の限定確認はbuild 7.775秒、test 1.368秒、exit 0。
途中の型narrowing失敗とtest fixtureの履歴API不足・古いruntime cache参照は修正し、
元の失敗記録はnative履歴に保持。既存結果を成功へ書き換えない。

統合候補の正規確認command（cwdはこのrepository）：

```sh
npm run test:targeted -- test/mission-direct-execution.test.ts test/mission-completion.test.ts test/mission-binding-recovery.test.ts test/v2-plugin.test.ts
git diff --check
npm_config_cache=/home/user/Sortie-dogs/_testenv/control-recovery-npm-cache npm run test:full
```

`test:full` はintegrationを含むLinux共通全体検査。Windows専用検査や有料benchmarkとは別。
最初のfullは既存global npm cacheのsymlink先で `ENOTDIR`、package-loader段階に停止。
そのsymlinkは変更せず、今回専用のrepo内cacheをcommand-local指定して再実行する。
その最終結果・Review・commit/PRはPR本文とnative Mission記録へ残す。

## 適用と成果の区別

packageを適用する場合はcommitと一つのtgz/SHA-256を固定し、旧版を保全する。
npm globalとOpenCode用node_modulesは同じtgzで通常install、`init --global` 後に
installed bytesを比較する。稼働中制御source/authorityの直接patchはしない。
同versionのローカル修正版とregistry版はhashで区別する。npm公開は今回対象外。
既に稼働中のprocessが新コードを読んだかはinstalled bytesと別に確認し、
未反映なら正直に再読込待ちと記録する。共有serviceを勝手に停止しない。

この修正はVDMの中断済み開発を完了させるものではない。
VDM製品source・dirty・失敗・原画像・未受領状態と、消費済みroot1/Send1/interrupt1/15分枠を保持。
今回のtest用生成物以外、`.sortie-env`、ユーザーデータ、authority、他者processは整理対象外。
