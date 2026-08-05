# Sortie-dogs 简体中文指南

**只需向 OpenCode 交付任务，即可获得边界清晰、经过验证的实现闭环。**

[![Sortie-dogs 协调有明确边界的实现工作流](assets/sortie-workflow.png)](assets/sortie-workflow.gif)

_点击图片可播放工作流动画。_

Sortie-dogs 是一个按需启用的 OpenCode 编排插件。它把任务依次推进到明确规划、并行调研、
专职实现、canonical validation 和证据完备的收尾，同时保留 OpenCode 的标准智能体与设置。

要求：Node.js 22.6 或更高版本、npm 和 OpenCode。

[English README](../README.md) · [日本語](guide-ja.md)

## 为什么使用 Sortie-dogs

- **需要时启用，其余时间保持安静** — 使用 `/sortie` 或选择 `dog-coordinator` 才会激活；
  普通 OpenCode 会话不受影响。
- **并行调研不会失控** — 每次 worker handoff 前固定使用三个有边界的 scout，不会无限扩散。
- **写入范围精确可控** — source manifest 或 operation manifest 约束编辑和 handoff。
- **实现责任集中** — 专用 Sol worker 负责 implementation、remediation 和 blocker-resolution。
- **先验证，后完成** — canonical validation、按风险 review 和 terminal evidence 共同控制由
  coordinator 负责的完成与 commit。
- **长任务能够恢复** — restart recovery 与有界 compaction 沿用 handoff context，不会静默重来。

## 实际工作闭环

1. **Brief / plan** — `dog-coordinator` 明确 acceptance criteria、写入 manifest 和验证要求。
2. **三个 scout** — 固定三个只读、范围受限的 scout 并行收集互补 evidence。
3. **专用 worker** — 仅在已批准 manifest 内实现，并处理范围内修正或 blocker。
4. **Canonical validation** — 运行声明的 test / build command，保留可核验结果。
5. **按风险 review** — 高风险候选项接受独立 review；低风险项通过验证后可跳过额外审查。
6. **Coordinator 收尾** — 只有 manifest、validation、review 和 evidence gate 全部通过，
   coordinator 才负责完成与 commit。
7. **有界续跑** — restart recovery 和 compaction handoff 保留进度，每个 batch 仍有明确上限。

## 运行示例

以下低风险示例在明确边界内完成，并报告各项 gate：

```text
用户：/sortie 添加所需行为
dog-coordinator：manifest 已确认
dog-scout ×3：调研完成
dog-worker：实现完成
validation：npm test — PASS
review：已跳过 — 低风险
dog-coordinator：完成 evidence 已接受
```

## 图解流程

### 控制复杂度

![角色与gate共同限制编排复杂度](assets/sortie-complexity.png)

Coordinator 将调研、实现、validation 和 review 分配给不同角色。即使项目变得复杂，manifest
gate 仍会限制各角色的写入范围。

### 携带证据完成

![通过验证的成果进入coordinator负责的完成阶段](assets/sortie-complete.png)

通过 canonical validation 和按风险 review 后，coordinator 才会确认完成，并附上说明变更内容与
验证方法的简洁 evidence。

## 从 npm 安装

在目标项目中安装公开 npm package，再生成项目内的 OpenCode runtime file：

```sh
npm install --save-dev sortie-dogs
npx sortie-dogs init .
```

也可以全局安装 CLI，再初始化目标项目：

```sh
npm install --global sortie-dogs
sortie-dogs init .
```

全局安装会提供 `sortie-dogs` CLI；`sortie-dogs init .` 写入的 OpenCode runtime file 仍位于
目标项目内。仅全局安装 npm package 不会激活目标项目，还需要继续完成下面的项目级配置和
plugin bridge。

只安装 runtime asset 不会加载插件；未加载插件时，所有角色都会沿用调用方的模型。
请把该 package 加入这些 agent 所在 OpenCode 配置的 `plugin` 数组：全局 asset 对应
`~/.config/opencode/opencode.json`，项目对应 `.opencode/opencode.json`。

```json
{
  "plugin": ["sortie-dogs"]
}
```

随后重启 OpenCode。`plugin` 条目必须写 package 名称；`sortie-dogs/plugin` 是 import specifier，
不是 plugin specifier。

`dog-coordinator` 和 `dog-scout` 默认使用 `openai/gpt-5.6-luna`。如需为这两个角色改用其他模型，
请将以下配置保存为 `.opencode/sortie-dogs.json`：

```json
{
  "modelRouting": {
    "dog-coordinator": {
      "preferred": { "model": "provider/model" }
    },
    "dog-scout": {
      "preferred": { "model": "provider/model" }
    }
  },
  "modelCatalog": {
    "project": [{ "model": "provider/model" }]
  }
}
```

将 `provider/model` 替换为你可以使用的模型。

已把该 package 加入依赖的项目，也可以用
`.opencode/plugins/sortie-dogs.ts` 代替 `plugin` 数组：

```ts
export { SortieDogsPlugin } from "sortie-dogs/plugin";
```

OpenCode 会自动发现该文件。请只导出插件本身：OpenCode 会把插件模块的每一个 runtime export
都当作插件工厂调用，多出一个导出就会让整个模块失效。重启 OpenCode 后运行：

```text
/sortie <任务>
```

也可以直接选择 `dog-coordinator` 来激活工作流。

## 写入门禁

写入门禁按项目选择启用。项目根目录没有 `operation-manifest.json` 时，插件保持被动，不会拒绝
任何工具调用。创建该文件即表示启用，因此协调者始终可以创建它。

```json
{
  "version": "0.1.0",
  "task_id": "add-requested-behavior",
  "read": ["src/feature.ts", "test/feature.test.ts"],
  "write": ["src/feature.ts", "test/feature.test.ts"],
  "validation": ["npm test"]
}
```

- `write`：已绑定的 worker 可以修改的唯一路径集合。列出的目录包含其下文件，其余为精确路径。
- `validation`：已绑定的 worker 可以执行的精确命令。构建和测试命令无法按路径分类，
  因此只有与声明完全一致的命令才被允许，其余一律作为未分类命令拒绝。
- `read`：记录预期的读取范围；读取不会被拒绝。

该文件由 `dog-coordinator` 拥有。worker 每个候选只绑定一次 `sortie_bind_write_gate`，
且必须在协调者的 handoff 通过检查之后。协调者会话不受门禁约束。

`.opencode/sortie-dogs.json` 中的可选设置：

```json
{
  "operationManifestPath": "operation-manifest.json",
  "handoffPaths": ["handoff.json"],
  "readOnlyTools": ["my_mcp_search"],
  "dedicatedWorkerModel": { "model": "provider/model", "variant": "deep" }
}
```

- `operationManifestPath`：manifest 的位置，相对于项目根目录。
- `handoffPaths`：插件检查的 handoff 文件。worker 只有通过其中一个文件的检查后才能绑定，
  因此空数组会完全禁用绑定。
- `readOnlyTools`：追加不会修改文件的宿主专用工具名，例如 MCP 工具。
  对已绑定的会话，未知工具默认被拒绝。
- `dedicatedWorkerModel`：所有 worker 角色解析到的唯一模型。默认为 `openai/gpt-5.6-sol`
  与变体 `medium`；当该模型不可用、或你想要不同的 worker effort 时，请声明自己的模型。worker 角色始终解析到这一个目标，
  无法按角色分别路由。

## 会话生命周期

插件默认保持被动。只有消息使用 `/sortie` 或当前智能体为 `dog-coordinator` 时，才激活该会话。
插件会验证 source / operation manifest 中的精确写入范围以及 worker handoff，拒绝范围外变更。
OpenCode 的标准智能体、角色、设置和其他会话均保持原样。

发生 `session.idle` 时，插件检查最终 handoff 并释放会话；`session.deleted` 也会释放会话。
之后的请求必须重新激活工作流。

插件只就地修复一个 host 缺陷。subagent 的结果取自 child 最终消息的「最后一个 text part」，
因此推理模型若在回合末尾附加一个空 text part，结果就会为空，coordinator 会重新派发 worker
已经完成的工作。当已完成的 `task` 结果为空时，Sortie-dogs 会从该 child session 恢复最后一段
真实的 assistant text。非空结果、其他 tool、无法读取的 child session 都不会被改动。

## 模型路由

`dog-coordinator` 和 `dog-scout` 默认使用 `openai/gpt-5.6-luna` 的 `xhigh` variant，这是推荐的
平衡方案：有边界的 prompt、简洁的 scout evidence，以及减少不必要的 context / tool turn，可以在
保持质量的同时降低 token 使用量。项目级 routing 可以覆盖这两个角色的默认设置。

`implementation`、`remediation`、`blocker-resolution` 和 `dog-worker` 始终使用专用 worker
target，即 `openai/gpt-5.6-sol` 的 `medium` variant。worker effort 被刻意设置在 review effort 之下：
高风险候选必须经过 source review，worker 需要修复返回的 finding，也就是说这套循环本来就会重跑质量不足的
实现；首轮就付出最高 effort，往往只是提前买下 reviewer 会提供的准确性。想要提前支付时，请调高
`dedicatedWorkerModel`。`modelRouting` 不能替换这些路由，只有 `dedicatedWorkerModel` 能移动它们。其他显式配置的路由
会依次尝试 preferred target 和有序 fallback。没有 built-in default 或显式路由的角色会保留 OpenCode
已选择的模型。

`dog-reviewer` 和 `dog-advisor` 不得继承调用方的模型：如果 review / strategy 运行在生成候选的同一个
模型上，就失去了独立性。当 catalog 声明了 `anthropic/claude-opus-5` 时，这两个角色默认使用它；否则回退到
比 worker target 高一档的 `openai/gpt-5.6-sol` `xhigh`。重新声明了 `dedicatedWorkerModel` 的 host，
会把该 target 作为第一顺位 fallback，因为这类 host 可能根本无法提供内置模型。这里不强制任何厂商：
两个角色都可配置，声明你实际可用的模型即可。

```json
{
  "modelRouting": {
    "dog-coordinator": {
      "preferred": { "model": "openai/gpt-5.6-luna", "variant": "xhigh" }
    },
    "dog-scout": {
      "preferred": { "model": "openai/gpt-5.6-luna", "variant": "xhigh" }
    },
    "dog-reviewer": {
      "preferred": { "model": "anthropic/claude-opus-5" },
      "fallback": [{ "model": "openai/gpt-5.6-sol", "variant": "xhigh" }]
    },
    "dog-advisor": {
      "preferred": { "model": "openai/gpt-5.6-sol", "variant": "xhigh" }
    }
  },
  "modelCatalog": {
    "project": [
      { "model": "openai/gpt-5.6-sol", "variants": ["medium", "xhigh"] },
      { "model": "openai/gpt-5.6-luna", "variants": ["xhigh"] },
      { "model": "anthropic/claude-opus-5" }
    ]
  }
}
```

将配置保存为 `.opencode/sortie-dogs.json`。`modelCatalog` 只声明实际可用的 provider model 与
named variant；Sortie-dogs 不会猜测、探测或转换 variant。内置 catalog 有意不包含
`anthropic/claude-opus-5`，因此只有在你声明之后，推荐的 consultation 模型才会生效。解析顺序为
preferred、随后是各个 fallback。若显式路由的所有候选项均不在 catalog 中，该路由会被拒绝。

`dog-advisor` 只接受 coordinator 发起的有限 Strategy / SourceReview 咨询。`dog-reviewer` 仅在
canonical validation 后独立审查高风险候选项。二者都不负责实现、stage、commit 或用户交互。

## 更新与迁移

将依赖替换为新版 Release asset 后，在目标项目根目录再次运行：

```sh
npx sortie-dogs init .
```

`init` 可重复安全执行。它会更新 Sortie-dogs 自有文件、迁移能够识别的旧 runtime file，并将
版本记录到 `.opencode/sortie-dogs.version`。遇到冲突或无法识别的文件时，初始化不会改动它们，
而是安全停止。包括 `.opencode/sortie-dogs.json` 在内的用户配置和 OpenCode 标准文件均会保留。

## 安全手动删除

Sortie-dogs 没有受支持的 uninstall command。请单独移除 npm dependency，再按照
[安全手动删除指南](uninstall.md)删除生成的 runtime file。只能删除已确认归 Sortie-dogs 所有的
准确路径；切勿删除 `.opencode` 目录、使用通配符或移除用户自有文件。
