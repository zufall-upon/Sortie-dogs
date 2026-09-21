# SWE-Bench / release 引き継ぎ

更新日: 2026-09-21

## 目的

Windows側でSWE-Benchのscore向上を先に進める。stable `v0.10.7`のrelease routineは、ユーザー指示により一時中断した。

## 固定candidate

- commit: `859c39668e4ec883b7da0206bd3bd6206aeed9d6` (`Stabilize child lifecycle deadline test`)
- package: `sortie-dogs@0.10.6`
- package SHA-256: `010eb4840dbd6ecc74dd5c7ed564d74d321efceaac7d9fe35e01c02058500500`
- dev manifest: `_testenv/swebench-lite-dev23/manifest-dev-23.json`
- 推論条件: dev 23件、`--workers 4`

## SWE-Bench結果

- supervisor: 23 predictions、23 replay artifacts、`spent_usd=9.37981144`
- supervisor内訳: 18 succeeded、3 empty-patch、1 cost-limit、1 watchdog-stale
- official incremental grader: PASS、infra error 0、submitted 23/23、resolved 4/23、empty-patch 5
- Kanbanのscore gateはローカル証跡に記録されていないため、Windows側で確認が必要。

## 中断したrelease preflight

予定は stable `v0.10.7`、`main`、`origin`。実行したcommandは次のとおり。

```text
node scripts/release.mjs preflight --version 0.10.7 --manifest .opencode/release.json
```

- exit 1: `node --experimental-strip-types --import ./test/setup.ts --test test/child-lifecycle-runtime.test.ts`
- 失敗箇所: `plugin deadline takes over one critical child and preserves an unrelated lane`
- 失敗理由: `contained validation settled before start marker: {"status":"denied","reason":"artifact-validation-failed"}`
- 同じtarget testを再実行しても再現。試したdeadline変更はrelease中断時に戻し、candidateには含めていない。
- release側のcommit、push、tag、GitHub Release、global apply、npm publishは未実施。

## Windows側の次手

1. Kanban score gate、23件の個別結果、empty-patchとwatchdog/cost失敗を確認する。
2. scoreを下げた共通要因を特定し、runtime変更を行う場合は新commit・新package hashでdev 23件を再実行する。
3. benchmark合格commitでcandidate preflightを通し、release再開の明示判断を行う。

## ローカル生成物

`official-report/harness-output.log`は`scoring-predictions.jsonl`欠落の失敗trace、`official-report/official-dataset.json`は評価入力である。生ログ・dataset・`.opencode/package.json`は秘密情報混入と不要な巨大差分を避けるため、このhandoff commitには含めない。
