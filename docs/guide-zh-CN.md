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

在目标项目中安装公开 npm package，再生成项目内 runtime file：

```sh
npm install --save-dev sortie-dogs
npx sortie-dogs init .
```

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

将 `provider/model` 替换为你可以使用的模型。然后创建 OpenCode 插件桥接文件
`.opencode/plugins/sortie-dogs.ts`：

```ts
export { SortieDogsPlugin } from "sortie-dogs/plugin";
```

OpenCode 会自动发现该桥接文件，无需在 `opencode.json` 中添加 `plugin` 设置。重启 OpenCode 后运行：

```text
/sortie <任务>
```

也可以直接选择 `dog-coordinator` 来激活工作流。

## 写入范围与会话生命周期

插件默认保持被动。只有消息使用 `/sortie` 或当前智能体为 `dog-coordinator` 时，才激活该会话。
插件会验证 source / operation manifest 中的精确写入范围以及 worker handoff，拒绝范围外变更。
OpenCode 的标准智能体、角色、设置和其他会话均保持原样。

发生 `session.idle` 时，插件检查最终 handoff 并释放会话；`session.deleted` 也会释放会话。
之后的请求必须重新激活工作流。

## 模型路由

`dog-coordinator` 和 `dog-scout` 默认使用 `openai/gpt-5.6-luna` 的 `xhigh` variant，这是推荐的
平衡方案：有边界的 prompt、简洁的 scout evidence，以及减少不必要的 context / tool turn，可以在
保持质量的同时降低 token 使用量。项目级 routing 可以覆盖这两个角色的默认设置。

`implementation`、`remediation` 和 `blocker-resolution` 始终使用专用 Sol worker，用户配置不能
替换这些路由。其他显式配置的路由会依次尝试 preferred target 和有序 fallback。没有 built-in
default 或显式路由的角色会保留 OpenCode 已选择的模型。

```json
{
  "modelRouting": {
    "dog-coordinator": {
      "preferred": { "model": "openai/gpt-5.6-luna", "variant": "xhigh" }
    },
    "dog-scout": {
      "preferred": { "model": "openai/gpt-5.6-luna", "variant": "xhigh" }
    },
    "dog-advisor": {
      "preferred": { "model": "fable/opus", "variant": "thinking" },
      "fallback": [{ "model": "provider/general" }]
    },
    "dog-reviewer": {
      "preferred": { "model": "fable/opus", "variant": "thinking" },
      "fallback": [{ "model": "provider/general" }]
    }
  },
  "modelCatalog": {
    "project": [
      { "model": "openai/gpt-5.6-luna", "variants": ["xhigh"] },
      { "model": "fable/opus", "variants": ["thinking"] },
      { "model": "provider/general" }
    ]
  }
}
```

将配置保存为 `.opencode/sortie-dogs.json`。`modelCatalog` 只声明实际可用的 provider model 与
named variant；Sortie-dogs 不会猜测、探测或转换 variant。解析顺序为 preferred、随后是各个
fallback。若显式路由的所有候选项均不在 catalog 中，该路由会被拒绝。上述 advisor / reviewer
路由只是可选的 secondary example，不需要时可以省略。

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
