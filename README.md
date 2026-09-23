# Sortie-dogs

> **Status (2026-09-23): v0.10.x failed as a general-use release line.**
> The intended combination of reliable end-to-end execution and lower total model
> cost has not been demonstrated. Later releases still have unresolved live-session
> recovery and acceptance failures; passing unit tests or isolated CLI fixtures
> do not close those gaps. Do not install the unpinned `latest` version for new work.
> For limited legacy use, pin **v0.10.14** as a temporary fallback, not a certified
> stable or universally working version.

**Design goal: a goal-preserving, adaptive execution harness for OpenCode that
optimizes cost, time, and proof without taking your setup over.**

Use OpenCode normally. Invoke Sortie only when you want scoped investigation,
implementation, validation, review, and model routing.

- **Goal invariance**: accepted outcomes and proof requirements survive delegation,
  continuation, remediation, and restart.
- **Adaptive execution**: small work stays small; additional agents and stronger
  models are used only when task shape or risk justifies them.
- **Coexistence**: Sortie activates only when selected and preserves normal
  OpenCode agents, settings, and user-owned files.
- **Cost, time, and proof**: the objective is a verified result at the lowest
  practical cost and wall time, not the largest agent count.

[![GitHub Release](https://img.shields.io/github/v/release/zufall-upon/Sortie-dogs)](https://github.com/zufall-upon/Sortie-dogs/releases/latest)
[![npm](https://img.shields.io/npm/v/sortie-dogs?label=npm)](https://www.npmjs.com/package/sortie-dogs)
[![Tests](https://github.com/zufall-upon/Sortie-dogs/actions/workflows/test.yml/badge.svg)](https://github.com/zufall-upon/Sortie-dogs/actions/workflows/test.yml)
[![OpenCode Plugin](https://img.shields.io/badge/OpenCode-Plugin-5C5CFF)](https://opencode.ai/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/node/v/sortie-dogs)](https://www.npmjs.com/package/sortie-dogs)
[![MIT License](https://img.shields.io/npm/l/sortie-dogs)](LICENSE)

![Sortie-dogs coordinating a bounded implementation workflow](https://raw.githubusercontent.com/zufall-upon/Sortie-dogs/main/docs/assets/sortie-workflow.gif)

Guides: [日本語](docs/guide-ja.md) · [简体中文](docs/guide-zh-CN.md) ·
[Testing](docs/testing.md) · [CLI testing](docs/cli-testing.md)

## Recommended version and v0.11.x

v0.10.14 is published on [npm](https://www.npmjs.com/package/sortie-dogs/v/0.10.14)
and as a [GitHub Release](https://github.com/zufall-upon/Sortie-dogs/releases/tag/v0.10.14)
(release tarball SHA-256: `f2caf67268a5f69b67a252a0d84bfc5ad09db82684aa8c1e0f5c49f8d2986993`).
It has a [frozen 23-task evaluation](docs/benchmark-v0.10.14-dev23.md).
That evaluation passed 6/23 official checks. Later v0.10.x releases have
successful targeted tests, but no evidence establishes v0.10.14 as the last
fully working version or proves that it meets the product's cost objective.
Use it only as the explicitly pinned fallback while v0.11.x is developed.

v0.11.x is in development to restore the original division of labor: a capable,
lightweight user-facing agent; inexpensive subordinate models doing bounded
investigation and routine execution; and an operator focused on independently
checking whether a plan and its result contradict the user's instructions.
The host should assemble and validate repetitive contract structure instead of
making agents author and recheck large plans. The original goal, native evidence,
quality gates, user-only decisions, and cumulative budgets must remain intact.
The target is measured end-to-end quality at lower **total** cost, including
delegation, rework, and review. No v0.11.x release is available yet.

## Quick start

Requirements: Node.js 22.6 or newer, npm, and OpenCode.

For a new or idle target project, install the pinned fallback:

```sh
npm install --save-dev --save-exact sortie-dogs@0.10.14
npx sortie-dogs init .
```

The v0.10.14 package defaults to the v0.10 profile. Load its OpenCode V2 entry
from `.opencode/plugins/sortie-dogs.ts`:

```ts
export { default } from "sortie-dogs/server";
```

Set the required two-level subagent depth in `.opencode/opencode.json`,
preserving existing values:

```json
{
  "experimental": { "subagent_depth": 2 }
}
```

Restart OpenCode, then run:

```text
/sortie-v010 <task>
```

Selecting `dog-operator` directly starts the same workflow. `dog-operator` is the
only user-facing v0.10 authority. `dogs-coordinator` and every `*-v010` role are
internal children and must not be selected as task entry points.

`init` installs runtime assets; the V2 plugin entry loads runtime enforcement and
model routing. Both are required. A new session alone does not reload an updated
plugin process, so restart OpenCode after installation or upgrade.

## What v0.10.x attempted

v0.10.x separates strategic authority from bounded operations:

- `dog-operator` preserves the original request, acceptance criteria, scope,
  review decision, and final acceptance.
- Hidden `dogs-coordinator` investigates or advances an approved serial queue,
  but cannot edit source, change acceptance, review, or publish.
- `dog-worker-v010` implements one host-generated unit inside exact read, write,
  and validation boundaries.
- Scout, advisor, and reviewer roles are optional and bounded by an explicit
  evidence gap, strategy trigger, or risk decision.

The v0.10 profile is serial by design. The stable profile's Luna fabric and
parallel integration path are not exposed in this profile. In practice, the
proposal workflow made an agent author a large execution contract and the
user-facing agent review it, increasing coordination and repair work. This did
not establish the intended low-cost division of labor described above.

### SWE-bench evaluation

A frozen Sortie-dogs v0.10.14 build was evaluated on 23 fixed tasks.

- Official verifier PASS: 6 / 23
- Scored FAIL: 17 / 23
- Infrastructure blocked: 0 / 23
- Total estimated model cost: $15.75
- Median agent runtime: 15.2 min

The same Sortie-dogs candidate, model routes, budgets, tools, and verification
procedure were held fixed for all tasks. This is one frozen evaluation, not a
general success-rate claim.

Full methodology and per-task results: [benchmark details](docs/benchmark-v0.10.14-dev23.md)

Historical qualification references remain in [benchmark reference](docs/benchmark-reference.md).

## Historical v0.10.x workflow

1. **Freeze intent**: `dog-operator` preserves the complete request as ordered
   requirements, negative constraints, quality thresholds, references, and finite
   proposal/execution budgets.
2. **Investigate only when needed**: a nontrivial task can send one bounded,
   read-only proposal investigation to `dogs-coordinator`. It cannot edit, run
   shell commands, dispatch workers, or widen its approved read prefixes.
3. **Approve an exact plan**: the root compares the proposal with the original
   request and approves its exact revision and hash. Uncovered requirements or
   widened scope fail closed. A simple task with a complete known contract can
   use the direct worker fast path.
4. **Generate controls**: the host creates and schema-validates the handoff,
   operation manifest, acceptance ledger, and short task reference. Models do not
   hand-authorize their own write scope.
5. **Execute serial units**: one unit goes directly to `dog-worker-v010`; a
   multi-unit plan is advanced serially by hidden `dogs-coordinator`. A worker
   binds once and can modify only declared paths and run only declared validation.
6. **Collect host evidence**: validation identity binds source snapshot,
   candidate, command, environment, scope, and owner. Claims in prose do not
   become proof.
7. **Review by risk**: high-risk candidates receive independent SourceReview;
   low-risk review may be explicitly skipped. The reviewer is tool-free and does
   not implement fixes.
8. **Remediate without weakening the goal**: acceptance failures and blocking
   review findings create a same-goal replacement from the committed candidate,
   retaining acceptance and cumulative budget. Scope growth still requires a
   later explicit user decision.
9. **Accept explicitly**: only the root's successful completion operation closes
   the run. Terminal states remain `DONE`, `INTERRUPTED`, `BLOCKED`, and
   `NEED_DECISION`; the host-generated return report uses observed evidence.

Durable profile state and hash-bound task references support restart and
compaction recovery without reconstructing criteria from summary prose. Stale,
foreign-root, or changed references are rejected. An optional Git lifecycle can
create one non-overwriting branch and one explicit-path commit; it never grants
arbitrary Git, force push, release, or publication authority.

## Configuration

### Profile files and precedence

The default package entry is the v0.10 profile:

- Command: `/sortie-v010`
- Primary agent: `dog-operator`
- Project settings: `.opencode/sortie-dogs-v010.json`
- Global settings: `~/.config/opencode/sortie-dogs-v010.json`
- JSON environment override: `SORTIE_DOGS_V010_CONFIG`
- Runtime state: `.sortie-dogs-v010/`
- Installed asset marker: `.opencode/sortie-dogs-v010.version`

Precedence is built-in defaults, global file, project file, environment JSON,
then plugin factory options. Unknown properties or invalid types are rejected.
Use external v0.10 role names such as `dog-operator`, `dogs-coordinator`, and
`dog-reviewer-v010` in `modelRouting`; do not also declare their stable aliases.

Example `.opencode/sortie-dogs-v010.json`:

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

Declare only models and named variants the host actually provides. Sortie does
not invent, probe, or translate variant names.

### Settings reference

- `readOnlyTools`: additional host-specific tools known not to mutate project
  files. Values accumulate across configuration layers. Unknown tools are denied
  in a bound worker session.
- `modelRouting`: preferred and ordered fallback targets by external profile role.
- `modelCatalog`: available `project` and `global` model/variant declarations.
- `freeTierFallbackModels`: ordered global last-resort model IDs. Default:
  `opencode/deepseek-v4-flash-free`; `[]` disables this fallback.
- `dedicatedWorkerModel`: canonical stable serial target, default
  `openai/gpt-6-sol` / `medium`. The v0.10 profile also supplies its explicit
  role routes below; do not infer the v0.10 worker route from this stable setting.
- `consultation.strategy`: fixed advisor identity, optional `required`, and
  positive `maxCallsPerCandidate`; default one call and not required.
- `consultation.sourceReview`: risk-based review with `maxCallsPerCandidate`
  default `1` and `maxArtifactBytes` default/maximum `30720`. Unavailable review
  blocks only when review is required.
- `continuation.enabled`: default `true`.
- Automatic continuation has no turn-count ceiling. The legacy positive-integer
  `continuation.maxAutoContinues` setting is accepted but ignored.
- `continuation.taskWatchdogMilliseconds`: root inactivity while an implementation
  Task is outstanding; default `300000`, valid range `10..1800000`.
- `continuation.summarizeModel`: optional explicit compaction model; omission
  reuses the latest observed root model.
- `validationProfile`: `fast`, `balanced`, or `assurance`; default `balanced`.
- `reflection`: accepted by the shared schema, but reflection writes are not
  exposed by the serial v0.10 profile. Stable reflection remains opt-in and off by
  default.

The v0.10 host owns handoff and manifest controls under
`.sortie-dogs-v010/contracts/`. Do not create a legacy root
`operation-manifest.json` for this profile and do not edit generated controls.
Delete `.sortie-dogs-v010/` only when no Sortie run is active.

### Validation policy

`validationProfile` chooses non-canonical depth:

- `fast`: static checks
- `balanced`: targeted checks
- `assurance`: related checks

Canonical proof remains canonical. Full-suite execution requires release context
or explicit risk. Workers own static, targeted, and related checks; the root owns
canonical and full-suite checks. An unchanged candidate, command, and environment
reuse the same evidence instead of spending the validation budget again.

### Default v0.10 routes

The routes below describe this repository's current v0.10.23 source, **not**
the recommended pinned v0.10.14 package. In v0.10.14, `dog-operator`,
`dog-worker-v010`, and `dog-scout-v010` default to
`openai/gpt-5.6-luna-fast`; `dogs-coordinator` and `dog-reviewer-v010` default
to `openai/gpt-5.6-terra`. The pinned version does not ship the newer Sol 6 /
Luna 6 routes; custom model selections require explicit configuration.

- `dog-operator`: `openai/gpt-6-luna` / `max`
- `dogs-coordinator`: `openai/gpt-6-sol` / `xhigh`
- `dog-worker-v010`: `openai/gpt-6-luna` / `max`
- `dog-scout-v010`: `openai/gpt-6-luna` / `xhigh`
- `dog-reviewer-v010`: `openai/gpt-6-sol` / `xhigh`
- `dog-advisor-v010`: preferred declared `anthropic/claude-opus-5`, otherwise
  `openai/gpt-6-sol` / `xhigh`

An explicit model and variant selected in OpenCode remains authoritative for that
session. Child role defaults fill absent native settings and may be overridden by
valid profile routing. Review never silently inherits the implementation model.

## Stable compatibility profile

The earlier parallel-capable runtime remains available explicitly:

```sh
npx sortie-dogs init . --profile stable
```

Load it through a project bridge instead of the default package plugin entry:

```ts
export { SortieDogsPlugin } from "sortie-dogs/plugin/stable";
```

The stable profile uses `/sortie`, `dog-coordinator`,
`.opencode/sortie-dogs.json`, `SORTIE_DOGS_CONFIG`, and `.sortie-dogs/`. Do not
register stable and v0.10 from the same package installation path in one host.

## Global availability

Project-local installation is recommended. To expose the pinned fallback's
v0.10 assets globally:

```sh
npm install --global sortie-dogs@0.10.14
sortie-dogs init --global --profile v010
```

Global initialization installs assets only; it does not load the V2 plugin or
change the default agent. Install the same pinned package where OpenCode's
global plugin wrapper can resolve it (for example,
`npm install --prefix "$HOME/.config/opencode" --save-exact sortie-dogs@0.10.14`),
put the same `export { default } from "sortie-dogs/server";` wrapper in
`~/.config/opencode/plugins/sortie-dogs.ts`, and set
`experimental.subagent_depth: 2` in the global OpenCode config.

## Updates and removal

After replacing the dependency, rerun initialization and restart OpenCode:

```sh
npx sortie-dogs init .
```

`init` is idempotent. It updates recognized Sortie-owned assets, records the asset
version, preserves user configuration, and stops safely on unknown ownership or
conflicting files.

There is no supported uninstall command. Remove the npm dependency separately,
then follow the [safe manual removal guide](docs/uninstall.md). Delete only known
Sortie-owned paths; never remove the whole `.opencode` directory or use broad
wildcards.

Maintainers: the [release batch guide](docs/release-batch.md) covers fixed-tarball
validation, global application, GitHub publication, and manual npm publication.
