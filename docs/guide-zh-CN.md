# Sortie-dogs 简体中文指南

Sortie-dogs 将 Mk2A2 编排工作流打包为 OpenCode 插件，不会替换 OpenCode
的标准智能体、角色或设置。

要求：Node.js 22.6 或更高版本、npm 和 OpenCode。

## 安装与初始化

在目标项目中安装已生成的软件包，并在项目根目录初始化：

```sh
npm install --save-dev /path/to/sortie-dogs-0.1.0.tgz
npx sortie-dogs init .
```

然后创建 `.opencode/plugins/sortie-dogs.ts`：

```ts
export { SortieDogsPlugin } from "sortie-dogs/plugin";
```

OpenCode 会自动发现此桥接文件，无需在 `opencode.json` 中添加 `plugin` 设置。
重启 OpenCode，然后运行：

```text
/sortie <任务>
```

## 更新与迁移

更新软件包后，在目标项目根目录再次运行同一初始化命令：

```sh
npx sortie-dogs init .
```

`init` 可重复安全执行。它会更新 Sortie-dogs 自有文件、迁移能够识别的旧版运行时文件，
并将版本记录到 `.opencode/sortie-dogs.version`。遇到冲突或无法识别的文件时，初始化会
保留这些文件并安全停止。用户自有的 `.opencode/sortie-dogs.json` 以及 OpenCode
的标准智能体、角色和设置均会保留。

## 激活会话

插件默认处于被动状态。只有消息使用 `/sortie`，或当前选择的智能体是
`dog-coordinator` 时，插件才会在该会话中激活；其他 OpenCode 会话不受影响。

激活后，插件会执行 operation manifest 并验证 handoff。发生 `session.idle` 时，插件会
检查最终 handoff 并释放会话；`session.deleted` 也会释放会话。后续请求必须重新激活。

## 模型路由与回退

模型路由是可选功能。某个角色没有路由时，OpenCode 已选择的模型保持不变。因此，
`modelRouting` 是针对单个角色的显式覆盖，不是全局默认模型。

Mk2A2 的 `implementation`、`remediation` 和 `blocker-resolution` 角色固定使用专用 Sol
模型 `openai/gpt-5.6-sol`，没有回退目标，用户配置也不能覆盖。实现 worker 只接受
`dog-coordinator` 的任务，不会直接面向用户。

`dog-advisor` 仅处理 coordinator 发起的有限 Strategy 或 SourceReview 咨询。
`dog-reviewer` 仅在 canonical validation 通过后独立审查高风险候选项；低风险候选项不会
调用 reviewer。二者都不负责实现、stage、commit 或用户交互。需要使用 Fable 的 Opus 时，
应只为这些 advisor/reviewer 角色显式设置路由，并可按顺序配置回退目标。

```json
{
  "modelRouting": {
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
      { "model": "fable/opus", "variants": ["thinking"] },
      { "model": "provider/general" }
    ]
  }
}
```

将配置保存为 `.opencode/sortie-dogs.json`。`modelCatalog` 只能声明实际可用的 provider
model 和 named variant；Sortie-dogs 不会猜测、探测或转换 variant。解析时先尝试
preferred，再按声明顺序尝试 fallback。若显式路由角色的所有候选项均不在 catalog 中，
该路由会被拒绝。

## 手动删除

Sortie-dogs 没有受支持的卸载命令。正常更新和迁移仍应使用
`npx sortie-dogs init .`。

删除 npm 依赖是另一项操作：请在声明该依赖的 `package.json` 所在目录中运行
`npm uninstall sortie-dogs`。切勿通过删除 `package.json` 或 `package-lock.json` 来移除包。

如需手动删除生成的运行时，请仅按准确路径删除以下 Sortie-dogs 自有文件：

```text
.opencode/agent/dog-coordinator.md
.opencode/agent/dog-worker.md
.opencode/agent/dog-scout.md
.opencode/agent/dog-reviewer.md
.opencode/agent/dog-advisor.md
.opencode/command/sortie.md
.opencode/sortie-dogs.version
```

切勿删除 `.opencode`、`.opencode/agent` 或 `.opencode/command` 目录，也不要使用 `*.md`
之类的通配符。必须保留标准的 `plan`、`build`、`builder` 智能体以及所有其他用户文件。
删除运行时文件时，不要删除 `.opencode/sortie-dogs.json`、插件桥接文件、其他智能体或
OpenCode 设置。

只有在旧 Sortie-dogs 标记或文件内容能够确认归属时，才可删除旧文件
`.opencode/agent/coordinator-mk2a2.md` 和 `.opencode/agent/sol-worker-mk2a2.md`。
若标记缺失、归属不明或出现非预期文件名，请停止删除并检查文件。

这些安全说明不会改变安装或迁移行为，也不会改变 `/sortie --model` 的适用范围。
