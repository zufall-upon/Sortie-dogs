# Sortie-dogs v0.11 简体中文指南

**高能力的窗口模型代表用户维护意图与质量，低成本的执行模型完成实际工作。**

## 安装

需要 Node.js 22.6+、npm、OpenCode V2（实机验证版本为 2.0.14），以及 SOL6 和 Luna6 Fast 的访问权限。

```sh
npm install --save-dev sortie-dogs
npx sortie-dogs init .
```

`init` 默认使用 `v011` profile。在保留现有设置的前提下，将插件添加到 `.opencode/opencode.json(c)`：

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

完全重启 OpenCode，然后运行 `/sortie-v011 <任务>`，或直接选择 `dog-operator`。
`init` 安装角色与命令，插件配置加载执行控制，两者都需要。

## 角色与执行流程

| 角色 | 模型 | 工作 |
| --- | --- | --- |
| `dog-operator` | `openai/gpt-6-sol#xhigh` | 代表用户核对原始要求和实际成果，决定返工或验收 |
| `dogs-coordinator` | `openai/gpt-6-luna-fast#max` | 调研、搜索、编辑、依赖准备、测试、诊断与修正 |
| reviewer / advisor | 保留现有配置 | 按需提供独立审查或技术建议 |

窗口模型只需补充简短指导。执行模型在一次调用内持续完成调查、实现、测试和普通错误修复。
如果仍有缺项，窗口模型通过 `review_work` 将具体意见返给**同一个子会话**。
默认流程不要求先编写完整 proposal、不可变执行计划、精确文件 manifest 或 milestone/proof 对照表。

宿主持久保存用户原文、禁止事项、后续指示、附件、所选 skill 与验证记录。
窗口模型必须依据实际源码和证据核对全部要求；节省成本不能成为减少范围或降低质量的理由。

## 验证、续跑与取消

- `sortie_v011_check` 调用 OpenCode 原生 shell，记录真实退出码及执行前后的源码身份。
  原生权限检查、进程管理和取消机制继续适用。
- 窗口模型读取 `work_status` 并检查实际改动，再通过 `review_work` 验收或返工。
  验收拒绝失败、过期、已被后续结果替代的检查，以及过期的源码或用户指示视图。
- 执行模型不能自行验收。测试成功支持判断，但不能代替对用户要求的语义核对。
- 每次正式 `check` 都必须在最终源码上成功；源码修改或无关检查的成功不能隐藏失败。
  修正或合并命令时，窗口用 `check_replacements` 记录覆盖范围相当或更广的成功检查及理由。
  `work_status(check_ids=[...])` 可读取保存的输出。普通探索性诊断使用 shell。
  必要测试无法执行时返回 `blocked`，解决阻碍后用 `start_work` 恢复同一任务与子会话。
- OpenCode 负责正常续跑和 compaction。持久记录在压缩或重启后仍可恢复。
- `start_work` 恢复被中断的同一任务与子会话；`cancel_work` 停止该任务的子会话并保留已有文件和证据。
- 默认每个任务最多调用执行模型 **6 次**，返工与恢复累计计数；这不是子会话内部的工具调用次数上限。
  后续独立请求创建新任务并归档旧任务。

可通过原生插件选项将 `maxAttempts` 设置为 1–32：

```jsonc
{
  "plugins": [{ "package": "sortie-dogs", "options": { "maxAttempts": 6 } }]
}
```

## Luna6 Fast 与费用

**`openai/gpt-6-luna-fast` 是真实的 OpenCode 模型选择名，已经包含 Fast 设置。**
它向 API 发送 `gpt-6-luna`，模型定义的 body 为 `service_tier: "priority"`。
Fast 与 reasoning variant 相互独立，无需用户再创建别名。

常规执行使用 SOL6 与 Luna6 Fast，reviewer/advisor 使用既有配置。
如果旧的辅助角色仍选择 base Luna6，Sortie 会在该会话的请求中补上 Fast tier。
费用根据已完成请求的 token 数和 Fast 的 2 倍费率估算，包含缓存与长上下文规则。
provider 返回的 tier 单独展示；估算不是账单，也不包含尚未完成的验收响应及最后报告。
历史 Terra 兼容价格计算继续保留。

## 从 v0.10 升级

更新依赖后运行 `init .`；全局安装则运行 `init --global`，然后完全重启 OpenCode。

- 新 marker 为 `sortie-dogs-v011.version`。
- 旧 `dog-operator` / `dogs-coordinator` 文件更新前备份到 `sortie-dogs-v011-backup/agent/`。
- 现有 reviewer/advisor 文件与用户 JSON/JSONC 配置保持不变。
- 插件会将旧的倒置角色路由修正为 SOL6 窗口 / Luna6 Fast 执行模型。
- 导出 `sortie-dogs/server` 默认值的 wrapper 会加载 v0.11。
  旧的显式 `createSortieDogsV2Plugin()` 调用仍加载兼容运行时；改为
  `export { default } from "sortie-dogs/server"` 即可使用 v0.11。
- 切换前完成或取消正在运行的 v0.10 任务。旧计划不会自动转换为 v0.11 任务。

v0.10 可通过 `init --profile v010` 和 `sortie-dogs/server/v010` 继续使用。
同一安装只注册一个运行时；v0.10 和 v0.11 共用窗口与执行角色文件名。
v0.10 兼容运行时优先使用 catalog 已声明的 `anthropic/claude-opus-5-5` 进行咨询，
否则回退到 `openai/gpt-6-sol#xhigh`。历史限制与设计方向见 [v0.10 回顾](v010-retrospective.md)。

## 实机验证

验证脚本从固定 tarball 安装隔离环境，使用 SOL6 / Luna6 Fast 执行：
初始测试失败 → 原生 compaction → 修正 → 再验证 → 窗口验收，随后在同一窗口提交另一个独立任务。
脚本检查模型定义、实际发出的 tier、退出码、受保护文件和验收凭据。

```sh
node scripts/user-proxy-smoke.mjs <candidate.tgz> <evidence-directory>
```

这是功能验证 fixture，不是一般成功率或成本 benchmark。SWE-bench 为独立的可选评估。

[English README](../README.md) · [日本語](guide-ja.md) · [测试](testing.md) ·
[历史 v0.10.14 benchmark](benchmark-v0.10.14-dev23.md) · [发布](release-batch.md)
