# Windows テスト

- `npm test` / `npm run test:full`: 現在の作業ファイルを WSL Ubuntu の Linux filesystem に snapshot し、依存準備・build・共通テストを実施。Windows 側の build は不要。
- `npm ci` 後、`npm run test:windows`: Windows 専用の junction・case・process cleanup・PowerShell controller を検証。
- Windows での全体検証は `npm run test:full` と `npm run test:windows` の両方を順次通す。
- WSL は `bash -lc` で Node >=22.6、npm、git が使えること。別 distro は `SORTIE_WSL_DISTRO` 指定。
- ログ・source SHA-256・exit は `_testenv/wsl-*/`。取消は Ctrl+C。controller は setup 込み2400秒、runner は1790秒。Ubuntu の build/release 手順は従来どおり。

# Release gate

SWE-Benchはリリース必須gateではなく、必要時に別途実施する。

1. release対象commitを固定する。
2. `.tgz`を生成し、SHA-256を固定する。
3. candidate preflightを通す。
4. `npm run test:full`を通す。
5. global apply、tag、GitHub Releaseを実施する。
6. `npm publish`はユーザーが手動実行する。

## Release後のWindows反映

Ubuntu側でrelease済み版を反映する場合、次だけ一括実行する。

1. `git pull --ff-only origin main`
2. `.tgz`生成
3. global install
4. `node .\dist\cli\main.js init --global`
5. installed version、runtime marker、assets照合

OpenCode完全再起動は手動。`preflight`、`npm test`、`npm run test:full`、tag、GitHub Release、`npm publish`は再実施しない。

## Ubuntuベンチ改善lane

- 正本は`main`のみ。Ubuntuは`bench/swebench-dev23`系の短命branchで分析、改善、長時間ベンチを担当。Windowsは`fix/<issue>`系branchで実運用バグを修正し、unit test後に早期統合。
- 双方とも相手branchへ直接mergeせず、`branch → PR/確認 → main`。Ubuntuは各改善サイクル前に最新`main`へ追従。
- Ubuntuの各実行はcommit、package hash、条件、結果を固定。成功結果はbranch上で確定扱いせず、`main`統合後のcommitから23件を再実行。
- Windows修正がruntime挙動へ影響した場合は23件を再ベンチ。評価candidateは実行途中で更新しない。緊急修正中もUbuntu campaignは停止不要。
- ベンチ生成物、生ログ、datasetはGitへ入れず、要約と再現条件だけ記録。同じファイル、特に`src/plugin/index.ts`、`gate.ts`、runtime asset周辺の長期並行変更を避ける。
- 流れ: Ubuntuで失敗19件を分類 → 改善1件を短命branchで検証 → `main`統合 → 最新`main`でpackage再生成・23件評価 → Windowsへ同じpackageをglobal applyして実運用確認。
- 改善中は23件一括より単件反復を優先。旧失敗1件を推論・公式採点・原因分析し、必要なら1テーマ修正後に同じ1件を再確認して次へ進む。
- campaign累計予算を固定し、単件ごとに上限を割り当てて残額を継承。実行中のcandidate、package hash、条件は変更しない。

## GitHub カンバン

- 認証確認: `gh auth status`（private Projectは`project` scopeが必要）。
- Project一覧: `gh project list --owner <OWNER> --format json`
- カード取得: `gh project item-list <NUMBER> --owner <OWNER> --format json`
