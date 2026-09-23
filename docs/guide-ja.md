# Sortie-dogs v0.11 日本語ガイド

**窓口がユーザーの意図と品質を守り、安価な下位モデルが実作業を担当します。**

## 導入

Node.js 22.6以降、npm、OpenCode V2（実機検証は2.0.14）、SOL6とLuna6 Fastへのアクセスが必要です。

```sh
npm install --save-dev sortie-dogs
npx sortie-dogs init .
```

`init`の既定profileは`v011`です。既存設定を保持して`.opencode/opencode.json(c)`へ追加します。

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["sortie-dogs"],
  "agents": {
    "compaction": { "model": "openai/gpt-6-luna-fast#high" },
    "title": { "model": "openai/gpt-6-luna-fast#high" }
  }
}
```

OpenCodeを完全再起動して、`/sortie-v011 <依頼>`、または`dog-operator`の直接選択で開始します。
`init`はagent/commandを配置し、plugin設定が実行制御を読み込みます。両方必要です。

## 役割

| 担当 | モデル | 仕事 |
| --- | --- | --- |
| `dog-operator` | `openai/gpt-6-sol#xhigh` | ユーザーの代理として依頼と成果物を照合し、差し戻し・受理を判断 |
| `dogs-coordinator` | `openai/gpt-6-luna-fast#max` | 調査、検索、編集、依存準備、テスト、失敗修正、その他の実務 |
| reviewer / advisor | 既存設定 | 必要な場合だけ独立レビュー・技術助言 |

窓口は短い補足を付けて委任します。下位担当は一回の呼び出しの中で実装と修正を継続します。
不足があれば**同じ担当session**へ戻します。通常の依頼にproposal、全体実行計画、exact-file manifest、
milestone/proof対応表の作成は求めません。実装範囲と適切なテストは作業中に発見します。

元のユーザー文、禁止事項、追加指示、添付、選択skillはホストが保持します。
窓口は実際の変更と検証結果を全要件に照らして確認します。安くするための要件削減や品質の引き下げは認めません。

## 検証と完了

下位担当の`sortie_v011_check`はOpenCodeのnative shellを呼び、実exitと実行前後のsource identityを記録します。
通常のshell権限、外部directory確認、process管理、取消が適用されます。

窓口は`work_status`と実sourceを確認し、`review_work`で具体的な差し戻し、または現在有効な成功checkを指定して受理します。
古いsource、古いユーザー指示、失敗・失効check、下位担当による自己受理は拒否されます。
意味的な要件充足の判断は窓口が担当し、無関係なテストの成功で代用しません。

一度`check`した検証は、最終sourceで成功するまで未解決として残ります。source編集や別の成功checkの選択で
失敗を隠せません。コマンド訂正・統合時は、窓口が`check_replacements`で同等以上の成功checkと理由を記録します。
`work_status(check_ids=[...])`で保存済み出力を確認できます。探索用の診断には通常のshellを使います。
必要なテストを実行できない場合は`blocked`として保持し、解消後に`start_work`で同じ仕事・担当を再開します。

元の依頼・feedback・checkはnative compactionや再起動後も保持されます。
`start_work`で中断した同じ仕事を再開し、`cancel_work`で担当を停止します。
既定上限は**1仕事あたり6回の担当呼び出し**で、差し戻し・再開も累積します。
担当内部のtool呼び出し回数ではありません。次の別依頼では新しい仕事を作成します。

```jsonc
{
  "plugins": [{ "package": "sortie-dogs", "options": { "maxAttempts": 6 } }]
}
```

`maxAttempts`は1〜32です。通常の継続・compactionはOpenCodeに委ねます。
2.0.14のplugin APIに`session.compact`はないため、未提供のcompaction toolを公開しません。
手動・自動compactionはOpenCode本体の機能で実行できます。

## Luna6 Fastと費用

**`openai/gpt-6-luna-fast`は実在するOpenCodeの選択名で、選ぶだけでFast指定になります。**
APIへ送るmodel IDは`gpt-6-luna`、モデル定義のbodyは`service_tier: "priority"`です。
これは公式Fast指定の互換表記です。独自の別名や追加の手動tier設定は不要で、reasoning variantとは別です。

通常実行はSOL6とLuna6 Fastにし、reviewer/advisorは既存の設定を使います。
旧compaction設定でbase Luna6が残っている場合も、Sortie sessionの送信にはFast指定を補います。
費用は完了済みrequestのtoken数とFastの2倍料金から概算し、providerが返したtierも別途表示します。
受理中の応答・最後の報告分はその時点では未計上です。過去のTerra互換価格計算も保持します。

## v0.10からの移行

dependency更新後に`init .`、global利用なら`init --global`を実行します。

- markerは`sortie-dogs-v011.version`です。
- 旧`dog-operator` / `dogs-coordinator`は`sortie-dogs-v011-backup/agent/`へ退避して更新します。
- 既存reviewer/advisorファイル、user JSON/JSONC設定は保持します。
- 旧設定で逆転していた窓口Luna / 実務Solは、v0.11 pluginが新しい役割へ補正します。
- `sortie-dogs/server`のdefaultをexportするwrapperはv0.11を読み込みます。
  明示的に`createSortieDogsV2Plugin()`を呼ぶ旧wrapperは、default exportへ変更してください。
- 進行中のv0.10仕事を完了または取消してから切り替え、完全再起動後に新しい依頼を開始します。

v0.10専用JSONや旧planを新しい仕事へ自動変換しません。
互換profileの利用方法、実機検証の再現コマンドは[README](../README.md)を参照してください。

## 実機検証

固定tarballを隔離環境へinstallし、SOL6/Luna6 Fastで初回テスト失敗→native compaction→修正→再検証→窓口受理、
同じ窓口での次の別依頼まで確認します。生成物、生ログ、datasetはGitへ入れず、要約と再現条件を記録します。
機能確認の小規模fixtureであり、一般的な成功率・費用のbenchmarkではありません。

[テスト](testing.md) · [過去のv0.10.14ベンチ](benchmark-v0.10.14-dev23.md) · [リリース](release-batch.md)
