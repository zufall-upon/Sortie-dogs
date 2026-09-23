# Sortie-dogs

**A user-facing operator protects your intent and quality; a cheaper implementer does the work.**

Sortie-dogs v0.11 is a native OpenCode V2 plugin. Use OpenCode normally, then select
Sortie to delegate investigation, implementation, testing and corrections while
keeping the complete original request.

[![GitHub Release](https://img.shields.io/github/v/release/zufall-upon/Sortie-dogs)](https://github.com/zufall-upon/Sortie-dogs/releases/latest)
[![npm](https://img.shields.io/npm/v/sortie-dogs?label=npm)](https://www.npmjs.com/package/sortie-dogs)
[![Tests](https://github.com/zufall-upon/Sortie-dogs/actions/workflows/test.yml/badge.svg)](https://github.com/zufall-upon/Sortie-dogs/actions/workflows/test.yml)
[![MIT License](https://img.shields.io/npm/l/sortie-dogs)](LICENSE)

Guides: [日本語](docs/guide-ja.md) · [简体中文](docs/guide-zh-CN.md) ·
[Testing](docs/testing.md) · [CLI testing](docs/cli-testing.md)

> Pre-1.0: runtime behavior, configuration and generated assets may change between minor versions.

## Quick start

Requirements: Node.js 22.6+, npm, OpenCode V2 (qualified with 2.0.14), and access to
`openai/gpt-6-sol` and `openai/gpt-6-luna-fast`.

```sh
npm install --save-dev sortie-dogs
npx sortie-dogs init .
```

`init` defaults to the **v011** runtime assets. Add the plugin to
`.opencode/opencode.json(c)`, preserving existing settings:

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

The auxiliary settings select Luna6 Fast for summaries and titles. Keep any
additional settings on those agents. Sortie permits SOL6 and Luna6 for its
execution requests; reviewer/advisor model selections are independent.

Restart the OpenCode host after installing or updating the plugin, then run:

```text
/sortie-v011 <your task>
```

Selecting **`dog-operator`** directly uses the same workflow. `dogs-coordinator`
is an internal implementation child. The default V2 package export and
`sortie-dogs/server` both load v0.11. This workflow uses one child level.

## How v0.11 works

1. **Keep the original request.** The host retains the user's words, attachments,
   selected skills and subsequent instructions in durable plugin storage.
2. **Delegate practical work.** The operator adds short guidance and dispatches
   one host-generated native task. The implementer searches, reads, edits, builds,
   tests and fixes ordinary problems within that invocation.
3. **Collect real checks.** `sortie_v011_check` calls OpenCode's native shell
   executor, retaining its permission checks, process ownership and cancellation.
   It records actual exit status and source identity before and after execution.
4. **Compare intent with results.** The operator inspects actual changes and
   current check evidence against every original requirement, including negative
   constraints. Relevant successful tests support this judgment; they do not replace it.
5. **Correct or accept.** A revision returns feedback to the **same child session**.
   Only the operator can accept. Acceptance rejects missing, failed, superseded or
   stale selected checks and an outdated operator view of the request/source.

The default workflow requires no proposal investigation, immutable whole-task
execution plan, exact-file manifest, or model-authored proof mapping.
Technical scope and useful verification commands are discovered while working.
Project `AGENTS.md`, user instructions and native OpenCode permissions remain authoritative.

### Roles and models

| Role | Model | Responsibility |
| --- | --- | --- |
| `dog-operator` | `openai/gpt-6-sol#xhigh` | User proxy, intent/quality comparison, feedback, final acceptance |
| `dogs-coordinator` | `openai/gpt-6-luna-fast#max` | Investigation, implementation, tests, corrections and routine work |
| `dog-reviewer-v010` / `dog-advisor-v010` | Existing configuration | Optional independent review or focused advice |

**`gpt-6-luna-fast` is a real OpenCode catalog selector.** It sends API model
`gpt-6-luna` with `body.service_tier: "priority"`, the documented Fast setting.
Selecting it is sufficient; a second custom alias or manual tier setting is unnecessary.
Fast is separate from the reasoning variant. Older auxiliary configurations selecting
base Luna6 also receive a Fast tier overlay while used by Sortie.

The cost report estimates completed requests using published per-request rates,
including Fast's 2x multiplier and long-context/cache pricing. Provider-reported
tiers are shown separately. The acceptance call's in-flight model response and
later final answer are not yet included, so this is an estimate rather than a bill.
Historical Terra-compatible pricing remains available for older reports.

### Continuation, cancellation and budgets

- Native OpenCode owns normal continuation and compaction. Original instructions,
  feedback, attempts and validation receipts are durable; `work_status` restores them.
- `start_work` resumes interrupted work with the same child and cumulative attempt
  count. `cancel_work` stops the owned child and preserves existing files/evidence.
- A completed/cancelled job is archived when a subsequent request starts. It does
  not authorize or spend the next job's attempts.
- The default is **six child invocations per job**, including revisions/resumptions.
  This is not a six-tool-call limit. The implementer can investigate and correct
  failures continuously inside one invocation. OpenCode controls context/turn budgets.
- Configure `maxAttempts` (1–32) through native plugin options:

```jsonc
{
  "plugins": [{ "package": "sortie-dogs", "options": { "maxAttempts": 6 } }]
}
```

These are v0.11 options; `.opencode/sortie-dogs-v010.json` configures only the
compatibility runtime. The v0.11 source identity covers tracked and nonignored
working files (or regular workspace files outside Git), rather than dependency
caches or external services. The operator selects meaningful checks for the task.

## Upgrading from v0.10

After replacing the dependency, run `npx sortie-dogs init .` or
`sortie-dogs init --global` and restart OpenCode.

- The v0.11 marker is `.opencode/sortie-dogs-v011.version` (without `.opencode/`
  for global installation).
- Existing v0.10 `dog-operator` and `dogs-coordinator` files are backed up under
  `sortie-dogs-v011-backup/agent/` before their role definitions are replaced.
- Existing reviewer/advisor definitions and user JSON/JSONC configuration are
  preserved. Their settings can still be customized normally.
- The plugin enforces the new SOL6 operator / Luna6 Fast implementer routes,
  including sessions that retained an inverted v0.10 model selection.
- A wrapper exporting the default from `sortie-dogs/server` uses v0.11.
  Explicit `createSortieDogsV2Plugin()` wrappers select the older runtime;
  change them to `export { default } from "sortie-dogs/server"` for v0.11.
- Finish or cancel an active v0.10 job before switching runtimes. Its immutable
  plans are not converted into v0.11 jobs. A fresh request starts the new workflow.

`init` installs assets and is idempotent. Plugin registration is a separate config
step. Unknown ownership or conflicting backup files stop initialization with rollback.

## Compatibility runtimes

The v0.10 serial runtime remains explicit:

```sh
npx sortie-dogs init . --profile v010
```

```js
// .opencode/plugins/sortie-compat/index.js
export { default } from "sortie-dogs/server/v010";
```

The earlier stable parallel runtime uses `init --profile stable` and a V2 wrapper:

```js
import { createSortieDogsV2Plugin } from "sortie-dogs/server";
import { SortieDogsPlugin } from "sortie-dogs/plugin/stable";
export default createSortieDogsV2Plugin(SortieDogsPlugin);
```

Register one runtime per installation. v0.10 and v0.11 share primary/implementation
agent filenames. Legacy V1 entrypoints remain at `sortie-dogs/plugin` (v0.10) and
`sortie-dogs/plugin/stable`; they are separate from the V2 default.

## Verification and historical benchmarks

The native qualification runs a frozen installed tarball with SOL6/Luna6 Fast, an
initial failing oracle, native compaction, correction, explicit operator acceptance,
and a second task in the same root session. It records outbound model/tier choices,
protected-file hashes, actual exits and receipts. Run it with:

```sh
node scripts/user-proxy-smoke.mjs <candidate.tgz> <evidence-directory>
```

This is functional qualification, not a representative cost or success-rate benchmark.
SWE-bench is a separate optional evaluation. The earlier **v0.10.14** 23-task run
scored 6 PASS / 17 FAIL at $15.75 estimated cost and 15.2 minutes median runtime;
those are historical results, not v0.11 scores.
[Historical methodology](docs/benchmark-v0.10.14-dev23.md).

For global assets, use `npm install --global sortie-dogs` and
`sortie-dogs init --global`, then register the package in the global OpenCode config.
[Manual removal](docs/uninstall.md) · [Release batch guide](docs/release-batch.md).
