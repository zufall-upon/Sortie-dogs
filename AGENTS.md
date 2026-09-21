# Release gate

SWE-Benchはリリース必須gateではなく、必要時に別途実施する。

1. release対象commitを固定する。
2. `.tgz`を生成し、SHA-256を固定する。
3. candidate preflightを通す。
4. `npm run test:full`を通す。
5. global apply、tag、GitHub Releaseを実施する。
6. `npm publish`はユーザーが手動実行する。
