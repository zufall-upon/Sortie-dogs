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

本页是OpenCode指南。Codex集成也已实现，并记录了Ubuntu／Windows真实Mission的完成与受理。
Codex安装、SDK及host特定边界请参见[Codex指南](codex.md)；不要对Codex使用OpenCode初始化步骤。

**当前release：[v0.13.19](https://github.com/zufall-upon/Sortie-dogs/releases/tag/v0.13.19)**
（[发布说明](release-v0.13.19.md)）。默认Mission runtime保留`v010` profile、命令和配置名称以兼容已有安装；
名称中的`v010`不表示安装的仍是v0.10。当前asset marker为`0.13.19-workload-progress-v1`。

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

## v0.13.19更新

整合PR #223至#232。显示当前完整请求的`全体作業量 n/100（概算）`，基于具体产物、checks及剩余工作的相对量，
不是预算、unit计数或固定stage比例。复用已有native观察及settlement，不增加进度专用推理、验证或写入。
估计更新可降低数值；正式完成前最多99，仅已有完整请求正式完成才到100。
保留read内容、command stdout、执行契约、model及接受条件；任意metadata错误使用fallback而不拒绝执行。
init保留local V2 factory wrapper。隔离CLI fixture的session DB，观察及结束等待使用实际所属DB。
controller中断、观察失败、CLI启动失败或cleanup失败均保存原exit、未知费用、日志和下一步。
POSIX父进程结束后仍等待实际所属group的子writer停止；不宣称Windows orphan清理或真实请求完成率提升。
Linux详细proc读取仅针对实际所属group；无关读取拒绝不再阻止清理，保留所属目标的真实错误。
详见[发布说明](release-v0.13.19.md)和[完整请求工作量进度](work-quantity-progress.md)。

## v0.13.18更新（保留）

整合PR #217至#221。将direct unit结束与复用父会话的历史native outcome分离，只有实际保存的
settlement与evidence成功才报告validated。已识别的结束注册缺陷可从同一unit/run/actor的native
admission历史及当前输入freshness进行append-only恢复，保留原错误receipt、checks、authors、费用、预算与Git boundary。
不重跑验证、不增加unit、不允许任意成功证据；保留显式取消、真实Worker/Reviewer失败及stale/missing checks。
validation command统一为既有共享8192字符上限，identifier仍为4096字符。整合generated-read freshness回归、
兼容依赖修复及官方失败诊断，不将历史0/1或full23的9/23改称发布版成绩提升。
原unit恢复不代表产品接受或Go；global反映不会自动移除原Location临时candidate。
详见[发布说明](release-v0.13.18.md)和[direct结束恢复记录](direct-unit-settlement-recovery.md)。

## v0.13.17更新（保留）

整合PR #214、#215。将已终止修正/Git历史与live writer所有权分离，允许继续已授权的剩余Worker/direct开发。
默认复用原上下文，也可选择其他可用Reviewer进行handoff或有用的独立Review。
保留finding、真实author、native check、run archive引用与累计消耗；self-recheck不变成独立PASS。
保留live-bound成功check的已声明tail、实际command、exit、顺序与输入freshness，不因诊断前缀要求重跑。
在大量证据之前显示model、费用与next action；区分native完成、Worker-model观察及正式评分。
整合源自既有source/tests的public caller assertion、client state及return/mutation契约指引，不增加gate或例行Review。
原会话确实继续开发，但仍有2项Medium finding，产品接受和Go未完成；不代表发布版完成或速度提升。
详见[发布说明](release-v0.13.17.md)和[Reviewer连续性记录](reviewer-handoff-continuity.md)。

## v0.13.16更新（保留）

整合PR #212。未保存Task ID的旧Review也恢复原Reviewer上下文，正在运行的Review直接join而不重新派发。
恢复native失败、中断及compaction；过期验证或前run的finding不阻止开始修复，正式完成仍要求当前真实验证。
保留未变command/cwd的证据、snapshot recipe、显式配置及实际toolchain。探索read允许并发，
重叠write与Git整合仍受控；取消隐式第二次no-progress停止，保留显式预算。
在同一native完成通知旁投影host receipt，将结果记录及hold与正式接受分离；反省记录为可选checkpoint工作。
开放默认Reviewer的shell观察，保留用户权限、自定义指令及model选择。
原会话诊断不代表发布版产品接受或速度对比。详见[发布说明](release-v0.13.16.md)和
[连续性审计](practical-continuity-audit.md)。

## v0.13.15更新（保留）

整合PR #210。重启后优先使用当前native session的agent，而非历史fallback，
不再将子Reviewer的synthetic完成通知误认为父Operator的agent选择。
已有Reviewer correction alias映射到逻辑Reviewer，保留native alias、model、权限和修正所有者。
当前Build选择优先于旧Sortie历史；已知identity无需为确定role重新读取完整历史。
不增加审批、Mission重建、预算reset或Task重新派发，正式验证与接受条件保持不变。
详见[发布说明](release-v0.13.15.md)及原candidate观察的限制。

## v0.13.14更新（保留）

整合PR #190〜#207。过期Reviewer验证不再阻塞native会话并重复HTTP 500，正式接受仍要求
fresh validation；由同一author补齐缺失check。已有批准的累计预算扩展tool可从V2 Operator的
Code Mode搜索发现，保留已消耗与预留预算。保留raw heredoc、quote、stdin原始指令与可读交付证据。
计划继承依赖准备限制、公开entrypoint、独立复现root及回归test位置。
Hermes自动开发control plane移出产品repo；release不重跑已有campaign。
详见[发布说明](release-v0.13.14.md)。

## v0.13.13更新（保留）

整合PR #188，将启动及计划时的公开会话、近期tool结果、已知环境、判断与已完成操作传递到
Worker handoff。较长历史保留原文snapshot及message/call ID，可按需读取；支持可选`handoff_context`。
失败的重新计划保留现有上下文、执行与预算。不增加审批、必填备注或model调用，
历史结果不代替当前正式验证。详见[上下文连续性记录](mission-context-continuity.md)。

## v0.13.12更新（保留）

整合PR #177〜#186的文档与Mission修复：Worker返回、native idle等待、Reviewer同一Task修正、
验证recipe的真实path及Python heredoc匹配、symlink cycle快照和大型受保护path历史。
同时整合Hermes自动开发runner，保留已有Session、委托指示、费用台账与真实发送receipt。
过去单项结果不代表公开v0.13.12的新benchmark分数。

## v0.13.11更新（保留）

修复Codex大文件write与运行中status观察、切换agent后已终止Mission返回造成的持续HTTP 500，
并区分run-once结果收集与进程成功。保留真实失败exit；未启动、运行中及必需成功check仍阻止完成。
[Windows Codex完成及评分记录](codex-write-status-anko-20261007.md)属于固定development package，
不是已发布v0.13.11的新benchmark结果，也不证明native sandbox已修复。

## v0.13.8更新（保留）

整合PR #161：Windows directory junction的alias枚举失败时，从已解析且可读取的physical target
捕获native验证binding。保留logical证据标签、link identity和完整target bytes；未改变的可读取
junction保持原证据identity。外部link/cycle、真实source/output freshness及Review不变，
不新增审批、权限或model变化。PR隔离Windows真实session恢复同一Mission后，无需重跑成功check，
达到独立Review PASS与最终受理；不代表原product已恢复或无中断同turn完成。
release证据：`_testenv/releases/0.13.8/`，参见[发布说明](release-v0.13.8.md)。

## v0.13.7更新（保留）

整合PR #158/#159：后续write-only报告的时间戳不会单独使已绑定的非生成native check失效。
真实source/具体成果freshness、失败和旧证据recipe保持不变；无具体inventory的whole-root grant
仍使用full-candidate freshness。非Git Mission root也可从声明的nested repo/worktree/plain output
准备独立Review，包含已commit内容；真实Git/HEAD损坏仍明确报错。Operator在原权限内同turn修复
通常故障，不增加审批、改变要求或reset费用。识别Ubuntu mount边界的非Git诊断。
PR真实观测仅达到Reviewer启动，未证明最终受理。release证据：`_testenv/releases/0.13.7/`，
参见[发布说明](release-v0.13.7.md)。

## v0.13.6更新（保留）

整合PR #156：成功unit的正式PASS证据覆盖全部声明command时，acceptance summary引用已有formal
evidence，不为显示再次获取native历史。证据缺失/失败仍保留历史诊断；历史证据不是当前freshness或受理。
外部artifact inventory仅在一次snapshot refresh内共享，下次调用仍重新观测修改/删除。
Operator在当前证据覆盖要求且无具体gap时直接进入受理。既有freshness/Review条件、provider/model和
cache-prefix机制不变。未测量端到端提速或live token/cache-hit改善。
证据位于`_testenv/releases/0.13.6/`；参见[发布说明](release-v0.13.6.md)。

## v0.13.5更新（保留）

整合PR #154：保留稳定model指令，在native历史边界追加变化的host state；compaction后完整重建
当前state。真实Reviewer tool采用确定性的read-only优先顺序，实际修复权限切换保持不变。
最终版恢复v3 behavioral review和合并assignment/findings，保留精确AGENTS.md探索、继承formal
command的独立执行、literal local shell-file scope整合及明确project-root read/write表记。
新whole-project证据不因host bookkeeping单独变化而失效；旧证据recipe、真实source/artifact freshness不变。

固定pre-release cycle 11 Anko观测：官方local score 1、选定public 9/9、26分1.866秒、估算$1.41968316。
比旧v3更快但费用增加15.762%，不是速度与费用同时优化或一般质量保证。
release证据保存在`_testenv/releases/0.13.5/`；启动不代表任务完成。
参见[发布说明](release-v0.13.5.md)及[比较和失败记录](cache-prefix-loop-20261003.md)。

## v0.13.4更新（保留）

整合PR #152。通过`plan_units(executor="self")`、`start_direct_unit`和`finish_direct_unit`，
Coordinator/Operator可在同session直接实现和正式验证。已知单一unit可合并Mission启动与规划，
默认Worker仍为Luna Fast/max。明确Read行范围覆盖整个生成contract时保留全文。
background启动确认或root idle仍不代表Mission完成。

最初独立Reviewer可在原native Task中连续调查、修复、执行继承check、Git delivery及明确self-recheck，
无需先结束Task或重新委派。后续发现的Major/Medium累积保存在同一修复context中。
作者自查是`self-rechecked`、`independent=false`，不是独立`PASS`；仅具体残余Major risk需要另一Reviewer。
未解决Major/Medium不能接受，最终receipt由Operator负责。

修复继承compiler scratch造成的正式证据误失效；改善Git delivery观测、调用时设置审查及test合成指导。
host完成card保留在历史/UI中，V2的model/compaction context仅省略显示正文，保留receipt、hash、原要求和证据。

相同固定pre-release v8 package两次完成原Anko任务，均为官方local score 1（F2P 9/9、P2P 94/94），
选定public probe 9/9。耗时26分49秒/$1.47908048和25分55秒/$1.54610816，各比记录中的v5节省七分以上。
这是同任务的有限观测，不是一般性提速或新SWE-bench分数。release的preflight、完整test、固定commit
Windows CI及真实Worker启动证据保存在`_testenv/releases/0.13.4/`；启动/model身份不证明任务完成。
参见[发布说明](release-v0.13.4.md)和[质量改进记录](nightly-quality-loop-20261002.md)。

## Mission workflow

已知一个有用unit及有意义的正式check时，采用Operator → Worker；
确实需要调研或拆分时，采用Operator → Coordinator → Worker。

- `dog-operator`：负责简洁要求、禁止事项、用户决定和最终acceptance；host逐字保存原始消息。
- hidden `dogs-coordinator`：负责调研、unit声明、Worker/Scout/Advisor/Reviewer委派、原要求内的
  write scope调整和修复推进。可在同session直接实现及正式验证，也可委派Worker。
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
  [固定条件、中断run处理与详情](benchmarks/swebench-lite-history.md#v0131-dev23-2026-09-30)。

这些是历史固定candidate的结果，不是v0.13.11分数。版本、预算和条件不同，不能视为受控比较或一般成功率。
推理完成、Sortie的`DONE`、Review `PASS`和官方解决结果分别记录；官方本地评测也不等于leaderboard注册或接受。
SWE-bench按需单独执行，不是release必需gate。条件和限制保留在[测量契约](benchmark-completion-contract.md)、
[结果历史](benchmarks/swebench-lite-history.md)及[历史local case study](benchmark-reference.md)中。

## Mission tools

1. `start_mission`：Operator提交简洁要求；host保存原始消息。已知单一unit可附`unit`合并启动/规划，
   返回已配置的Worker Task。
2. `plan_units`：提供title、objective、file/directory scope和正式check；host生成ID、handoff、manifest、
   proof映射及可执行的Worker Task。`executor="self"`保留同controller直接执行；
   `start_direct_unit` / `finish_direct_unit`维持真实正式check与当前source的新鲜度。
3. `operator_next`：推进serial unit。`expand_unit`在保留同一Task的情况下补齐原要求内的必要output。
   普通unit通过附理由的`plan_units`修正或`retry_mission_unit`恢复，保留原始要求和累计budget。
4. `review_mission`：根据source、原始要求和真实check生成独立Review packet；高风险派发Reviewer Task，
   低风险明确记录skip。
5. `repair_review`：保存发现，在运行中的原Reviewer Task连续修复，或恢复同native session。
   后续发现累积保存；在同一Task中修复、执行继承check和要求的
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
import { createSortieDogsV2Plugin } from "sortie-dogs/server";
import { SortieDogsPlugin } from "sortie-dogs/plugin/stable";

export default createSortieDogsV2Plugin(SortieDogsPlugin);
```

Stable profile使用`/sortie`、`dog-coordinator`、`.opencode/sortie-dogs.json`、
`SORTIE_DOGS_CONFIG`与`.sortie-dogs/`。不要从同一package install path把stable和`v010`同时注册到一个host。

## Global使用

推荐project-local安装。若需全局提供当前Mission asset：

```sh
npm install --global sortie-dogs@0.13.19
sortie-dogs init --global --profile v010
```

Global init注册package或复用已有local V2 bridge，将subagent depth设为至少2，
保留default agent和无关用户设置。

如果已有`<OpenCode config root>/plugins/sortie-dogs/index.js`导入`sortie-dogs/server`，
它可能解析到该config root下的**另一份dependency**。仅更新npm-global不会更新这一份。
对此布局，还需在实际config root安装同一release，然后重新运行global init：

```sh
npm install --prefix "$HOME/.config/opencode" sortie-dogs@0.13.19
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
`0.13.19-workload-progress-v1`标识已安装asset，不证明正在运行的OpenCode已经重新加载新plugin。

目前没有受支持的uninstall command。请单独删除npm dependency，再按
[安全手动删除指南](uninstall.md)操作。只能删除已知Sortie-owned exact path，
不要删除整个`.opencode`目录或使用broad wildcard。

Maintainer可参见[release batch guide](release-batch.md)，其中说明固定tarball验证、global应用、
GitHub发布及手动npm发布流程。
