# OpenCode configuration and Mission reference

[README](../README.md) · [Codex integration](codex.md) ·
[日本語ガイド](guide-ja.md) · [简体中文指南](guide-zh-CN.md)

This page describes the OpenCode plugin route. Codex has its own entrypoints and does not import
these host settings. The default Mission runtime keeps the `v010` compatibility names; these do
not mean the installed package is v0.10.

## Project installation

Requirements: Node.js 22.6+, npm and OpenCode V2. In the target project:

```sh
npm install --save-dev sortie-dogs@0.13.11
npx --no-install sortie-dogs init .
```

`init` installs recognized Sortie-owned assets and merges the plugin into
`.opencode/opencode.json(c)`, preserving unrelated settings and the default agent. It registers
`plugins: ["sortie-dogs"]` and sets `experimental.subagent_depth` to at least two. An existing
local bridge importing `sortie-dogs/server` is reused instead of duplicated; a larger depth remains.

Completely restart OpenCode, then use `/sortie-v010 <task>` or select `dog-operator`.
`dogs-coordinator` and `*-v010` roles are internal children, not task entrypoints.
Watched configuration may reload, but a new chat alone does not prove a replaced dependency loaded.

## Profile files and precedence

- Command: `/sortie-v010`; primary agent: `dog-operator`.
- Project settings: `.opencode/sortie-dogs-v010.json`.
- Global settings: `~/.config/opencode/sortie-dogs-v010.json`.
- JSON environment override: `SORTIE_DOGS_V010_CONFIG`.
- Runtime state: `.sortie-dogs-v010/`.
- Project asset marker: `.opencode/sortie-dogs-v010.version`.
- Global marker: `<OpenCode config root>/sortie-dogs-v010.version`.

Precedence: built-in defaults → global file → project file → environment JSON → plugin factory
options. Unknown properties and invalid types are rejected. Use external profile names such as
`dog-operator`, `dogs-coordinator` and `dog-reviewer-v010` in `modelRouting`, not duplicate stable aliases.

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

Declare only models and named variants the host provides. Sortie does not invent, probe or translate
OpenCode variant names. An explicitly selected native session model/variant remains authoritative;
child defaults fill absent settings and valid profile routing may override them. Review never
silently inherits the implementation model.

## Settings reference

- `readOnlyTools`: additional non-mutating host tools; values accumulate across configuration layers.
  Unknown tools are denied in a bound Worker session.
- `modelRouting`: preferred and ordered fallback targets by external profile role.
- `modelCatalog`: available `project` and `global` model/variant declarations.
- `freeTierFallbackModels`: ordered global last-resort model IDs. Default
  `opencode/deepseek-v4-flash-free`; `[]` disables this fallback.
- `dedicatedWorkerModel`: canonical stable serial target, default `openai/gpt-6.1-sol` / `medium`.
  Mission routes are explicit and do not derive their Worker target from this stable setting.
- `consultation.strategy`: fixed Advisor identity, optional `required`, positive
  `maxCallsPerCandidate`; default one call, not required.
- `consultation.sourceReview`: risk-based review; `maxCallsPerCandidate` defaults to `1`,
  `maxArtifactBytes` default/maximum `30720`. Unavailable review blocks only when required.
- `continuation.enabled`: default `true`. Automatic continuation has no turn-count ceiling;
  legacy positive-integer `maxAutoContinues` is accepted but ignored.
- `continuation.taskWatchdogMilliseconds`: root inactivity with an outstanding implementation Task;
  default `300000`, range `10..1800000`.
- `continuation.summarizeModel`: explicit compaction model; omission reuses the latest observed root model.
- `validationProfile`: `fast`, `balanced` or `assurance`; default `balanced`.
- `reflection`: enabled for `run`, `project` and `global` layers; at most three entries / 500 estimated
  tokens injected. `sortie_v010_reflection` retains verified process causes/preventions, not model
  training. Storage/managed blocks are separate from stable; `reflection.enabled: false` disables it.

The host owns generated controls under `.sortie-dogs-v010/contracts/`. Do not hand-edit those
controls or create a legacy root `operation-manifest.json` for this profile. Remove runtime state
only when no Sortie run is active.

## Validation and review

Supplementary non-canonical depth: `fast` = static checks, `balanced` = targeted checks,
`assurance` = related checks. These do not replace meaningful formal commands or user/project-required
broad validation. Batch related edits, use focused checks while fixing, then run all declared checks
in order on the stable candidate. The implementing Worker or admitted correcting Reviewer runs them;
canonical/full-suite `owner=coordinator` is evidence accounting, not a root-execution requirement.

Reuse unchanged evidence only where the contract permits: identity includes candidate, command,
environment, scope and owner. Required repeated occurrences keep distinct execution identities.
Actual cwd, exit, duration and source bindings establish freshness. Diagnostics are not formal proof;
repeat checks for changes, failure or freshness, not merely a new Worker or edited documentation.

High-risk changes need initial independent Review; low-risk skips are recorded explicitly.
The original Reviewer can investigate, correct, validate and perform `SELF_RECHECKED` in its same
Task. Author self-recheck is `independent=false`, not a second independent PASS. A different Reviewer
is conditional on concrete residual Major risk; unresolved Major/Medium findings block acceptance.

## Mission tools

All names use `sortie_v010_`. The host generates IDs, handoff, manifest and proof mappings.

1. `start_mission`: save concise requirements and original user messages. A known single unit may
   include `unit`; known operations also include `execution` commands/directory to dispatch directly.
2. `plan_units`: declare useful units, estimated scope and meaningful formal checks. `executor="self"`
   keeps work in the controller; `start_direct_unit` / `finish_direct_unit` preserve formal-check freshness.
3. `operator_next`: advance serial units. `expand_unit` reconciles required in-request outputs without
   replacing the Task. Reasoned replan or `retry_mission_unit` retains requirements and cumulative spend.
4. `review_mission`: create Review from source, requirements and observed checks; dispatch the Reviewer
   for high-risk work or record an allowed low-risk skip.
5. `repair_review`: retain findings and continue/resume the original Reviewer. Accumulate later findings,
   run inherited checks/requested Git delivery and explicitly self-recheck. Legacy `CORRECTION_READY`
   alone requires a same-author read-only fallback through `review_mission`.
6. `submit_mission`: return a completion candidate, user-only decision or proven external/scope/budget blocker.
7. `complete_mission`: Operator compares original request, source and evidence, then explicitly accepts.
   Only a succeeded receipt authorizes DONE and the measured return report.

Legacy proposal/plan-repair tools remain compatible but hidden from the normal Mission list.
In-request path reconciliation adds no new user approval; work beyond the request or cumulative
budget returns to Operator/user. `EVIDENCE_GAPS` is an advisory limitation, not Review PASS or an
automatic extra review. Required missing/failed checks still block acceptance. For run-once/report
operations, collected terminal failure is distinct from process success and remains visible after acceptance.

Durable state and hash-bound references preserve criteria across restart/compaction. Stale/foreign
references cannot authorize work. Requested `git add <paths>` / `git commit -m ...` uses actual source
scope, not fabricated `.git/**`; optional host-managed delivery keeps branch/commit boundaries.
Neither mode grants arbitrary Git, force-push, release or publication authority.

### Progress and acceptance evidence

`sortie_v010_operator_status` retains original requests, command/exit/timing, operation outcome,
review and delivery. `{"view":"progress"}` shows current/completed/total units, host budget and next
action; `{"view":"full"}` / `details_ref` exposes diagnostics. Unknown clean state or a failed commit
is not delivery success. Reading status does not dispatch, retry or accept; native completion
notifications avoid polling. Reconciliation can recover a missed child terminal event.

## Stable compatibility profile

The earlier parallel-capable runtime remains opt-in:

```sh
npx --no-install sortie-dogs init . --profile stable
```

Load through a project bridge instead of the default package entry:

```ts
import { createSortieDogsV2Plugin } from "sortie-dogs/server";
import { SortieDogsPlugin } from "sortie-dogs/plugin/stable";

export default createSortieDogsV2Plugin(SortieDogsPlugin);
```

Stable uses `/sortie`, `dog-coordinator`, `.opencode/sortie-dogs.json`, `SORTIE_DOGS_CONFIG` and
`.sortie-dogs/`. Do not register stable and `v010` from the same package path in one host.
The default Mission profile is serial; background responsiveness is not parallel writers or Luna fabric.

## Global availability

Project-local installation is recommended. For global OpenCode Mission assets:

```sh
npm install --global sortie-dogs@0.13.11
sortie-dogs init --global --profile v010
```

If `<OpenCode config root>/plugins/sortie-dogs/index.js` imports `sortie-dogs/server`, that bridge
may resolve a **separate dependency** under the config root. Updating npm-global alone does not
update it. Install the same release there and rerun global init:

```sh
npm install --prefix "$HOME/.config/opencode" sortie-dogs@0.13.11
sortie-dogs init --global --profile v010
```

Use the actual config root if overridden. For configured npm entries, OpenCode V2 supports
`opencode plugin list` / `opencode plugin update`; exact pins need an explicit version change.
Completely restart OpenCode after updating and check installed package, assets and loaded runtime.

## Updates and removal

For a project update:

```sh
npm install --save-dev sortie-dogs@0.13.11
npx --no-install sortie-dogs init .
```

`init` is idempotent, updates recognized Sortie-owned assets, records their version and preserves
user settings. Unknown ownership or conflicting files stop the update. Align exact version pins
and separate bridge dependencies. Marker `0.13.11-operation-result-v1` identifies installed Mission
assets, not proof that an already-running OpenCode process reloaded them.

There is no supported uninstall command. Remove the dependency separately, then follow
[safe manual removal](uninstall.md). Never remove the entire `.opencode` directory or broad wildcards.
Maintainers: [fixed-tarball release batch](release-batch.md).
