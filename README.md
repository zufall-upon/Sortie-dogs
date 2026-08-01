# Sortie-dogs

OpenCode の既存 MkII ワークフローを配布可能にする AI orchestration loop plugin。
`agent-contract-guard` は handoff と operation manifest の契約をローカルで検査する。

## Quickstart

Node.js 22.6.0 以上で install、build する。

```console
npm install
npm run build
```

### Manifest gate（推奨）

`handoff.json`:

```json
{
  "version": "0.1.0",
  "profile": "minimal",
  "id": "quickstart",
  "created_at": "2026-08-02T00:00:00Z",
  "task": {
    "title": "Quickstart",
    "objective": "Validate the handoff and changed paths"
  },
  "state": { "done": [], "next": ["Run the guard"], "blocked": [] },
  "risks": [],
  "verification": []
}
```

`operation-manifest.json`:

```json
{
  "version": "0.1.0",
  "task_id": "quickstart",
  "read": [],
  "write": ["src/index.ts"],
  "validation": ["npm test"]
}
```

変更対象を manifest と照合する。warning も gate failure にする場合は `--strict` を使う。

```console
npm exec --package=. -- acg lint handoff.json --manifest operation-manifest.json --changed-path src/index.ts --strict
```

最小検査では manifest と変更対象を省略できる。

```console
npm exec --package=. -- agent-contract-guard lint handoff.json
```

`--package=.` は現在の local package の bin を一時 PATH に追加する。`agent-contract-guard` と `acg` は同じ CLI を起動する bin 名。

## CLI contract

- exit `0`: error なし。通常モードでは warning のみも含む
- exit `1`: error あり、または `--strict` で warning あり
- exit `2`: usage、入力読込、JSON parse など検査を開始できない失敗
- `--changed-paths-from -` の stdin は改行区切り changed paths 専用。handoff JSON は stdin から読まず、引数の file path から読む
- host や LLM は不要。検査はローカルかつ決定的で、handoff の内容を命令として実行しない
- 入力には機密情報を含めない。診断は入力値の露出を避けるが、file の読取権限と保管・削除は呼出側の責任

「opus相当」と「sol相当」は役割を人に示す表示ラベルのみ。特定 model、provider、host の選択や実行を保証・要求しない。
