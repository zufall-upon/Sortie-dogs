# Sortie-dogs 简体中文指南

**在保留既有OpenCode环境的同时固定目标，按任务调整执行方式，并优化成本、时间与证据的执行框架。**

平时照常使用OpenCode。只有需要限定范围的调研、实现、验证、审查和模型路由时，才启动Sortie。

- **Goal invariance**：accepted outcome与proof要求在委派、续跑、修复和重启后保持不变
- **Adaptive execution**：小任务保持小规模；只有任务形状或风险确有需要时，才增加agent或更强model
- **清晰的Worker指令**：提供简洁目标、明确约束和完成条件，由host承担执行管理。参见[指令设计原则](worker-instruction-design.md)
- **Coexistence**：仅在明确选择时启用，保留OpenCode标准agent、设置与user-owned file
- **Cost / time / proof**：目标是以最低可行成本和wall time取得verified result，而不是最大化agent数量

[English README](../README.md) · [日本語](guide-ja.md) ·
[测试](testing.md) · [CLI testing](cli-testing.md)

**当前release：[v0.13.3](https://github.com/zufall-upon/Sortie-dogs/releases/tag/v0.13.3)**
（[发布说明](release-v0.13.3.md)）。默认Mission runtime保留`v010` profile、命令和配置名称以兼容已有安装；
名称中的`v010`不表示安装的仍是v0.10。当前asset marker为`0.13.3-coordinator-direct-v4`。

> **Beta：** v0.13.x仍在稳定化。1.0之前runtime behavior、配置和生成asset仍可能变化。

## 快速试用

要求：Node.js 22.6或更高版本、npm和OpenCode V2。

在目标project中执行：

```sh
npm install --save-dev sortie-dogs@latest
npx sortie-dogs init .
```

默认使用`v010` Mission profile。`init`保留无关设置，在`.opencode/opencode.json(c)`中注册
OpenCode V2 plugin，并将subagent depth设为至少2：

```json
{
  "plugins": ["sortie-dogs"],
  "experimental": { "subagent_depth": 2 }
}
```

如果已有local bridge导入`sortie-dogs/server`，`init`会复用它，避免重复注册。
已有的更大subagent depth保持不变。

完全重启OpenCode，然后运行：

```text
/sortie-v010 <任务>
```

直接选择`dog-operator`也会启动相同workflow。Mission profile面向用户的入口是`dog-operator`。
`dogs-coordinator`和所有`*-v010` role都是内部child，不应作为任务入口选择。

`init`安装runtime asset并合并OpenCode设置；package entry或已有local bridge加载执行控制和model routing。
OpenCode可以重新加载受监视的配置，但替换已安装dependency可能需要完全重启。
仅新建聊天session不能证明新plugin已经加载。

## v0.13.3更新

本版整合PR #148、#149及Ubuntu后续修复：native background Mission、简洁且保留原始请求的
Worker handoff，以及在同一Reviewer context内完成修复。

- Operator以native background job启动Coordinator、直接Worker和Reviewer，简短确认后仍可响应用户聊天。
  native完成通知会唤醒同一个Operator；启动确认或root idle不代表Mission完成。
  Coordinator内部委派仍为foreground；无关聊天不会取消或替换进行中的Mission。
- 发现问题的Reviewer在同一个native session、model和context中修复，执行继承的正式检查、要求的
  Git delivery并明确self-recheck。host仅在修复期间启用限定scope的执行profile，结束后恢复read-only
  Reviewer。原始要求、当前source证据和累计budget保持不变。
- 作者自查如实记录为`self-rechecked`、`independent=false`，不是独立Review的`PASS`。
  只有自查后仍存在具体可达路径上的残余Major risk，才需要另一名Reviewer。
  未解决的Major或Medium问题不能被接受；最终比较和成功receipt仍由Operator负责。

固定release通过candidate preflight、Linux完整测试 **1,589/1,589** 和Windows测试 **12/12**。
native CLI probe观测到真实的Luna Fast/max Worker与Sol 6.1/xhigh Operator。
该probe仅证明启动和实际model身份，不证明任务完成。

已安装的native修复fixture成功，但原始Anko任务的观测仍未通过验收，包括最新的25分钟run。
本版不宣称一般性提速、原任务完成或新的SWE-bench分数。
参见[实现与测量记录](anko-pr149-ubuntu-handoff.md)和[Reviewer修复规格](reviewer-context-repair.md)。

## Mission workflow

已知一个有用unit及有意义的正式check时，采用Operator → Worker；
确实需要调研或拆分时，采用Operator → Coordinator → Worker。

- `dog-operator`：负责简洁要求、禁止事项、用户决定和最终acceptance；host逐字保存原始消息。
- hidden `dogs-coordinator`：负责调研、unit声明、Worker/Scout/Advisor/Reviewer委派、原要求内的
  write scope调整和修复推进。可使用read/search和确认用shell；source实现由Worker或获准在
  同context修复的Reviewer承担。
- `dog-worker-v010`：在file/directory write scope内实现host生成的unit。调研command无需预先注册；
  正式check保留host记录的真实结果。
- 高风险修改需要初始独立Reviewer，可自行read/search；低风险skip必须明确记录。
  Fast-lane也可用于高风险单unit，但不意味着跳过Review。
- 调研、修改、正式检查和要求的Git delivery在同一个实现child中完成。保留用户指定顺序，
  无需例行plan批准或仅为commit另建handoff。unit进度显示在运行中的Task上。

`v010` Mission profile采用serial路径；background响应能力不等于增加并行writer。
stable profile中的Luna fabric和parallel integration不在本profile开放。
目标是在保持质量的同时减少不必要的高成本工作，而不是增加agent数量。

## SWE-bench测量结果

- **v0.12.24 / Lite test300：170/300（56.67%）**。一次pass@1 campaign，9个空patch，
  官方评测error为0。实际Worker为`openai/gpt-6-luna-fast#max`，Operator/Coordinator/Review为
  `openai/gpt-6-sol#xhigh`。这是整个system的结果，不是Luna单模型比较，也不是Verified/full SWE-bench分数。
  已确认推理费用 **$162.99**；另有价格未知usage的预算hold **$34.60**，不计入已知费用。
  [技术报告](benchmarks/swebench-lite-v01224-test300-2026-09-29.md) ·
  [公开prediction/log/trajectory](https://github.com/zufall-upon/sortie-dogs-swebench-lite-20260929)。
- **v0.13.1 / Lite dev23：8/23（34.8%）**，2026-09-30。相较v0.12.25的7/23，新增解决
  `pylint-dev__astroid-1333`，原有7项全部保留。空patch和官方评测error均为0。
  Worker为Luna Fast/max，Operator/Coordinator/Reviewer/Advisor为GPT-6.1 Sol/xhigh。
  8 slots、$2/instance、campaign总上限$46，20分钟检查进度、最长40分钟。
  已知推理费用 **$17.73**，未知usage hold **$1.98** 单独记录；推理约81分钟、官方评分7.2分钟。
  [固定条件、中断run处理与详情](../README.md#v0131-dev23-2026-09-30)。

这些是历史固定candidate的结果，不是v0.13.3分数。版本、预算和条件不同，不能视为受控比较或一般成功率。
推理完成、Sortie的`DONE`、Review `PASS`和官方解决结果分别记录；官方本地评测也不等于leaderboard注册或接受。
SWE-bench按需单独执行，不是release必需gate。条件和限制保留在[测量契约](benchmark-completion-contract.md)、
[结果历史](../README.md#swe-bench-evaluation)及[历史local case study](benchmark-reference.md)中。

## Mission tools

1. `start_mission`：Operator提交简洁要求；host保存原始消息并返回Coordinator Task。
2. `plan_units`：提供title、objective、file/directory scope和正式check；host生成ID、handoff、manifest、
   proof映射及可执行的Worker Task，无需proposal批准往返。
3. `operator_next`：推进serial unit。`expand_unit`在保留同一Task的情况下补齐原要求内的必要output。
   普通unit通过附理由的`plan_units`修正或`retry_mission_unit`恢复，保留原始要求和累计budget。
4. `review_mission`：根据source、原始要求和真实check生成独立Review packet；高风险派发Reviewer Task，
   低风险明确记录skip。
5. `repair_review`：恢复发现问题的原Reviewer native session，在同一Task中修复、执行继承check和要求的
   Git delivery，并明确返回`SELF_RECHECKED`。旧版仅返回`CORRECTION_READY`时，需通过`review_mission`
   进入同一作者的read-only复查。
6. `submit_mission`：Coordinator返回完成candidate、仅用户能作出的决定，或已证明的外部/scope/budget blocker。
7. `complete_mission`：Operator比较原始请求、source和证据，再显式acceptance。
   只有成功receipt才能授权`DONE`和基于实测的🐾 return report。

所有tool名使用`sortie_v010_`前缀。旧proposal/plan-repair仍保留在兼容实现中，但不出现在普通Mission tool列表。
Operator/Coordinator可协调原要求内的path，无需新增用户批准；超出原要求的变更或累计budget增加交回Operator/用户。
`EVIDENCE_GAPS`是参考限制，不是Review `PASS`，也不会自动要求额外Review；必要check失败或未运行仍阻止验收。

Durable profile state和hash-bound task reference支持restart/compaction recovery，无需从summary prose重建criteria。
stale、foreign-root或已变更reference均被拒绝。要求的`git add <paths>`和`git commit -m ...`使用实际source
write scope，不要求虚构的`.git/**` scope。可选host管理Git lifecycle保留branch、commit和post-commit边界。
两种方式均不授予任意Git、force push、release或publish authority。

### 进度与验收证据

`sortie_v010_operator_status`以紧凑视图保留原始请求、正式command/exit/时间、Review判断和已记录delivery。
`{ "view": "progress" }`显示当前unit、完成数/总数、host budget及下一操作；
`{ "view": "full" }`或`details_ref`提供完整snapshot诊断。
未知clean状态或失败commit不是delivery成功。读取进度不派发、重试或接受任务；应使用native完成通知而非polling。
status中已有的reconciliation可恢复遗漏的child结束事件。

## 配置

### Profile文件与优先级

默认package entry为`v010` Mission profile：

- Command：`/sortie-v010`
- Primary agent：`dog-operator`
- Project配置：`.opencode/sortie-dogs-v010.json`
- Global配置：`~/.config/opencode/sortie-dogs-v010.json`
- JSON环境变量override：`SORTIE_DOGS_V010_CONFIG`
- Runtime state：`.sortie-dogs-v010/`
- Installed asset marker：`.opencode/sortie-dogs-v010.version`

Global安装的marker位于`<OpenCode config root>/sortie-dogs-v010.version`。

优先级依次为built-in default、global file、project file、environment JSON、plugin factory options。
未知property或无效type会被拒绝。`modelRouting`应使用`dog-operator`、`dogs-coordinator`、
`dog-reviewer-v010`等`v010` external role名，不要同时声明其stable alias。

`.opencode/sortie-dogs-v010.json`示例：

```json
{
  "validationProfile": "balanced",
  "readOnlyTools": ["my_mcp_search"],
  "freeTierFallbackModels": ["opencode/deepseek-v4-flash-free"],
  "modelRouting": {
    "dog-operator": {
      "preferred": { "model": "provider/model", "variant": "high" }
    },
    "dogs-coordinator": {
      "preferred": { "model": "provider/model", "variant": "deep" }
    }
  },
  "modelCatalog": {
    "project": [
      { "model": "provider/model", "variants": ["high", "deep"] }
    ]
  },
  "continuation": {
    "enabled": true,
    "taskWatchdogMilliseconds": 300000
  }
}
```

只声明host实际提供的model和named variant。Sortie不会猜测、probe或转换variant名称。

### 配置reference

- `readOnlyTools`：追加不会修改project file的host专用tool名；各layer累积。已bind worker拒绝未知tool
- `modelRouting`：按external profile role设置preferred target与ordered fallback
- `modelCatalog`：声明可用的`project` / `global` model与variant
- `freeTierFallbackModels`：global last-resort model ID；默认`opencode/deepseek-v4-flash-free`，`[]`禁用
- `dedicatedWorkerModel`：canonical stable serial target，默认`openai/gpt-6.1-sol` / `medium`。Mission profile另有下列explicit role route，不能从此stable设置推断Worker route
- `consultation.strategy`：固定advisor identity、可选`required`及正整数`maxCallsPerCandidate`；默认not required、1次call
- `consultation.sourceReview`：risk-based review；`maxCallsPerCandidate`默认`1`，`maxArtifactBytes`默认且最大`30720`；仅review必需时因unavailable而阻塞
- `continuation.enabled`：默认`true`
- 自动续行无turn次数上限；旧`continuation.maxAutoContinues`正整数配置仍可接收，但会被忽略
- `continuation.taskWatchdogMilliseconds`：implementation Task进行时允许的root inactivity；默认`300000`，范围`10..1800000`
- `continuation.summarizeModel`：可选compaction model；省略时复用最新root model
- `validationProfile`：`fast` / `balanced` / `assurance`；默认`balanced`
- `reflection`：默认启用`run` / `project` / `global`层，最多注入3条、估算500 tokens。
  root Operator可通过`sortie_v010_reflection`保存已验证的流程原因及预防措施，在后续turn/session中复用。
  这不是模型训练；存储及managed block与stable隔离。设置`reflection.enabled: false`可禁用

Mission host拥有`.sortie-dogs-v010/contracts/`下的handoff和manifest。不要为本profile创建legacy root
`operation-manifest.json`，也不要编辑生成control。只有没有active Sortie run时才能删除`.sortie-dogs-v010/`。

### Validation policy

`validationProfile`选择辅助性的non-canonical depth：

- `fast`：static check
- `balanced`：targeted check
- `assurance`：related check

它不替代已声明的有意义的正式check，也不替代用户/project要求的完整验证。
集中完成相关修改，先运行针对性check，再在稳定candidate上依次执行所有声明check。
实际command由实现Worker或获准修复的Reviewer运行；canonical/full-suite的`owner=coordinator`
是证据记账分类，不要求root亲自执行。

必需的完整验证留给最终集成candidate。只有contract允许时才复用有效且未变化的证据，
身份包括candidate、command、environment、scope及owner。必需的重复check保留各自执行identity，不能当作重复证据跳过。
native command、实际workdir、exit、耗时及保存的source binding共同证明时效性。诊断不能代替正式proof。
是否重跑取决于修改影响、失败或时效要求，而不是仅因为换了Worker或编辑了文档。

### 默认route

- `dog-operator`：`openai/gpt-6.1-sol` / `xhigh`
- `dogs-coordinator`：`openai/gpt-6.1-sol` / `xhigh`
- `dog-worker-v010`：`openai/gpt-6-luna-fast` / `max`
- `dog-scout-v010`：`openai/gpt-6-luna-fast` / `max`
- `dog-reviewer-v010`：`openai/gpt-6.1-sol` / `xhigh`
- `dog-advisor-v010`：`openai/gpt-6.1-sol` / `xhigh`

在OpenCode中显式选择的model/variant对该session保持最高优先级。child default仅在native设置缺失时补全，
也可由有效profile routing覆盖。review不会静默继承implementation model。

## Stable兼容profile

之前支持parallel的runtime仍可显式使用：

```sh
npx sortie-dogs init . --profile stable
```

不要使用默认package plugin entry，应通过project bridge加载：

```ts
export { SortieDogsPlugin } from "sortie-dogs/plugin/stable";
```

Stable profile使用`/sortie`、`dog-coordinator`、`.opencode/sortie-dogs.json`、
`SORTIE_DOGS_CONFIG`与`.sortie-dogs/`。不要从同一package install path把stable和`v010`同时注册到一个host。

## Global使用

推荐project-local安装。若需全局提供当前Mission asset：

```sh
npm install --global sortie-dogs@0.13.3
sortie-dogs init --global --profile v010
```

Global init注册package或复用已有local V2 bridge，将subagent depth设为至少2，
保留default agent和无关用户设置。

如果已有`<OpenCode config root>/plugins/sortie-dogs/index.js`导入`sortie-dogs/server`，
它可能解析到该config root下的**另一份dependency**。仅更新npm-global不会更新这一份。
对此布局，还需在实际config root安装同一release，然后重新运行global init：

```sh
npm install --prefix "$HOME/.config/opencode" sortie-dogs@0.13.3
sortie-dogs init --global --profile v010
```

上述命令使用默认config root；如已覆盖配置，请使用实际路径。配置中的npm package entry也可通过
OpenCode V2的`opencode plugin list` / `opencode plugin update`管理；精确版本固定需要显式修改版本。
更新后完全重启OpenCode，再核对已安装package、asset marker及实际加载版本。

## 更新与删除

Project-local更新时，替换dependency、重新运行init并完全重启OpenCode：

```sh
npm install --save-dev sortie-dogs@latest
npx sortie-dogs init .
```

`init`可重复安全执行。它更新已识别的Sortie-owned asset并记录version，保留user config；
遇到unknown ownership或冲突file时安全停止。

同时将精确版本配置和独立bridge dependency对齐到目标release。
`0.13.3-coordinator-direct-v4`标识已安装asset，不证明正在运行的OpenCode已经重新加载新plugin。

目前没有受支持的uninstall command。请单独删除npm dependency，再按
[安全手动删除指南](uninstall.md)操作。只能删除已知Sortie-owned exact path，
不要删除整个`.opencode`目录或使用broad wildcard。

Maintainer可参见[release batch guide](release-batch.md)，其中说明固定tarball验证、global应用、
GitHub发布及手动npm发布流程。
