# Sortie-dogs 简体中文指南

**在保留既有OpenCode环境的同时固定目标，按任务调整执行方式，并优化成本、时间与证据的执行框架。**

平时照常使用OpenCode。只有需要限定范围的调研、实现、验证、审查和模型路由时，才启动Sortie。

- **Goal invariance**：accepted outcome与proof要求在委派、续跑、修复和重启后保持不变
- **Adaptive execution**：小任务保持小规模；只有任务形状或风险确有需要时，才增加agent或更强model
- **Coexistence**：仅在明确选择时启用，保留OpenCode标准agent、设置与user-owned file
- **Cost / time / proof**：目标是以最低可行成本和wall time取得verified result，而不是最大化agent数量

[English README](../README.md) · [日本語](guide-ja.md) ·
[测试](testing.md) · [CLI testing](cli-testing.md)

[Release v0.10.6](https://github.com/zufall-upon/Sortie-dogs/releases/tag/v0.10.6)

> **Beta：** v0.10.x仍在稳定化。1.0之前runtime behavior、配置和生成asset仍可能变化。

## 快速试用

要求：Node.js 22.6或更高版本、npm和OpenCode。

在目标project中执行：

```sh
npm install --save-dev sortie-dogs
npx sortie-dogs init .
```

Beta package默认使用v0.10 profile。保留现有值，在`.opencode/opencode.json`中添加OpenCode V2 plugin和
两层subagent设置：

```json
{
  "plugins": ["sortie-dogs"],
  "subagent_depth": 2
}
```

完全重启OpenCode，然后运行：

```text
/sortie-v010 <任务>
```

直接选择`dog-operator`也会启动相同workflow。v0.10中只有`dog-operator`拥有面向用户的authority。
`dogs-coordinator`和所有`*-v010` role都是内部child，不应作为任务入口选择。

`init`安装runtime asset；`plugins`条目加载runtime enforcement和model routing，两者都需要。
plugin module按process加载，因此升级后仅新建session不够，必须重启整个OpenCode host。

## v0.10.x方向

v0.10.x把strategic authority与bounded operations分开：

- `dog-operator`：保留original request、acceptance criteria、scope、review决定与final acceptance
- hidden `dogs-coordinator`：执行限定调研或推进已批准的serial queue；不能修改source、改变acceptance、审查或发布
- `dog-worker-v010`：在host生成的精确read/write/validation边界内实现一个unit
- scout、advisor与reviewer：仅在有明确evidence gap、strategy trigger或risk决定时限定调用

v0.10 profile有意采用serial路径。stable profile中的Luna fabric和parallel integration不在本profile开放。
目标不是更多agent，而是在不降低质量的前提下减少不必要的高成本工作。

### v0.10.6之后的SWE-bench方针

从v0.10.6起，开发将持续伴随SWE-bench测量。这是测量方针，不表示尚未运行的suite已经通过。

- 比较前冻结task input、package/source snapshot、model route、budget、tool和stop endpoint
- 所有writer停止后freeze candidate，再对独立copy运行一次pinned official verifier
- 分别记录benchmark completion、official task correctness和harness terminal；Sortie的`DONE`或review `PASS`不等于official reward
- 分开记录agent-to-freeze与verifier时间，并记录root/descendant token、model step、child、cache、估算cost和coverage
- 区分infrastructure failure与scored failure；小样本或unmatched结果不扩展为leaderboard或一般成功率结论

v0.10.6之前的local benchmark条件作为historical evidence结案。后续开发判断使用按
[Coding benchmark completion and correctness](benchmark-completion-contract.md)冻结的SWE-bench测量。

## 历史local case study

以下为2026-09-14至2026-09-18在固定DeepSWE任务
`datacurve/anko-typed-variable-bindings`上收集的completion-filtered参考值。
它们不是matched pair，也不是leaderboard结果。

- Bare OpenCode：Verified PASS `0/3`，F2P `3/27`，median agent wall `24.5 min`，median completed-run估算cost `$3.53`
- Sortie v0.9.12：Verified PASS `0/3`，F2P `23/27`，median wall `25.7 min`，median completed-run估算cost `$2.85`；另有2次interrupted attempt，估算cost `$6.20`
- Sortie v0.10.3 one-shot：Verified PASS `0/1`，F2P `7/9`，wall `22.7 min`，估算cost `$3.79`
- Sortie v0.10.5 one-shot：Verified PASS `1/1`，F2P `9/9`，P2P `94/94`，wall `43.8 min`，估算cost `$2.58`

v0.10.5只是1次verified success，不是成功率。historical rate schedule与endpoint并不相同，
host cost为0也不视为账单。详见[定义、冻结输入与限制](benchmark-reference.md)和
[machine-readable values](benchmarks/provisional-reference.json)。

## v0.10.6内部流程

1. **冻结Intent**：`dog-operator`把完整request保存为ordered requirement、negative constraint、quality threshold、reference及有限proposal/execution budget
2. **只在必要时调研**：nontrivial task可向hidden `dogs-coordinator`派发一次bounded read-only proposal调研；禁止edit、shell、worker dispatch与扩大read prefix
3. **批准Exact plan**：root将proposal与original request直接比较，并批准其exact revision/hash；uncovered requirement或scope扩大均fail closed。complete contract已知的simple task可走direct worker fast path
4. **生成Control**：host生成并schema校验handoff、operation manifest、acceptance ledger与short task reference；model不能自行授权write scope
5. **执行Serial unit**：单unit直接交给`dog-worker-v010`；multi-unit plan由hidden `dogs-coordinator`顺序推进。worker只bind一次，只能修改声明path并运行声明validation
6. **收集Host evidence**：validation identity绑定source snapshot、candidate、command、environment、scope与owner；文字中的PASS声明不构成proof
7. **按Risk review**：high-risk candidate接受独立SourceReview；low-risk可明确skip。reviewer不使用tool，也不实现修复
8. **不削弱Goal地修复**：acceptance failure或blocking review finding从committed candidate创建same-goal replacement，并保留acceptance及cumulative budget；扩大scope仍需后续user turn明确批准
9. **显式Acceptance**：只有root completion operation成功才关闭run。terminal保持`DONE`、`INTERRUPTED`、`BLOCKED`与`NEED_DECISION`；return report由host observation生成

Durable profile state和hash-bound task reference支持restart/compaction recovery，无需从summary prose重建criteria。
stale、foreign-root或已变更reference均被拒绝。可选Git lifecycle只能创建一次non-overwriting branch并执行一次
exact-path commit，不授予arbitrary Git、force push、release或publish authority。

## 配置

### Profile文件与优先级

默认package entry为v0.10 profile：

- Command：`/sortie-v010`
- Primary agent：`dog-operator`
- Project配置：`.opencode/sortie-dogs-v010.json`
- Global配置：`~/.config/opencode/sortie-dogs-v010.json`
- JSON环境变量override：`SORTIE_DOGS_V010_CONFIG`
- Runtime state：`.sortie-dogs-v010/`
- Installed asset marker：`.opencode/sortie-dogs-v010.version`

优先级依次为built-in default、global file、project file、environment JSON、plugin factory options。
未知property或无效type会被拒绝。`modelRouting`应使用`dog-operator`、`dogs-coordinator`、
`dog-reviewer-v010`等v0.10 external role名，不要同时声明其stable alias。

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
- `dedicatedWorkerModel`：canonical stable serial target，默认`openai/gpt-5.6-sol` / `medium`。v0.10 profile另有下列explicit role route，不能从此stable设置推断v0.10 worker route
- `consultation.strategy`：固定advisor identity、可选`required`及正整数`maxCallsPerCandidate`；默认not required、1次call
- `consultation.sourceReview`：risk-based review；`maxCallsPerCandidate`默认`1`，`maxArtifactBytes`默认且最大`30720`；仅review必需时因unavailable而阻塞
- `continuation.enabled`：默认`true`
- 自动续行无turn次数上限；旧`continuation.maxAutoContinues`正整数配置仍可接收，但会被忽略
- `continuation.taskWatchdogMilliseconds`：implementation Task进行时允许的root inactivity；默认`300000`，范围`10..1800000`
- `continuation.summarizeModel`：可选compaction model；省略时复用最新root model
- `validationProfile`：`fast` / `balanced` / `assurance`；默认`balanced`
- `reflection`：shared schema可以接收，但serial v0.10 profile不开放reflection write；stable reflection同样默认关闭并需opt-in

v0.10 host拥有`.sortie-dogs-v010/contracts/`下的handoff和manifest。不要为本profile创建legacy root
`operation-manifest.json`，也不要编辑生成control。只有没有active Sortie run时才能删除`.sortie-dogs-v010/`。

### Validation policy

`validationProfile`选择non-canonical depth：

- `fast`：static check
- `balanced`：targeted check
- `assurance`：related check

Canonical proof始终保持canonical。full-suite需要release context或explicit risk。
worker拥有static/targeted/related check，root拥有canonical/full-suite。candidate、command与environment未变化时，
复用同一evidence，不重复消耗validation budget。

### v0.10默认route

- `dog-operator`：`openai/gpt-5.6-luna-fast` / `max`
- `dogs-coordinator`：`openai/gpt-5.6-terra` / `xhigh`
- `dog-worker-v010`：`openai/gpt-5.6-luna-fast` / `max`
- `dog-scout-v010`：`openai/gpt-5.6-luna-fast` / `xhigh`
- `dog-reviewer-v010`：`openai/gpt-5.6-terra` / `xhigh`
- `dog-advisor-v010`：优先使用catalog中已声明的`anthropic/claude-opus-5`，否则使用`openai/gpt-5.6-sol` / `xhigh`

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
`SORTIE_DOGS_CONFIG`与`.sortie-dogs/`。不要从同一package install path把stable和v0.10同时注册到一个host。

## Global使用

推荐project-local安装。若明确需要在多个project中提供v0.10 asset：

```sh
npm install --global sortie-dogs
sortie-dogs init --global --profile v010
```

随后在global OpenCode config中添加`sortie-dogs`和`subagent_depth: 2`。Global init只安装asset，
不会静默更改default agent或合并user setting。

## 更新与删除

更新dependency后重新运行init并完全重启OpenCode：

```sh
npx sortie-dogs init .
```

`init`可重复安全执行。它更新已识别的Sortie-owned asset并记录version，保留user config；
遇到unknown ownership或冲突file时安全停止。

目前没有受支持的uninstall command。请单独删除npm dependency，再按
[安全手动删除指南](uninstall.md)操作。只能删除已知Sortie-owned exact path，
不要删除整个`.opencode`目录或使用broad wildcard。
