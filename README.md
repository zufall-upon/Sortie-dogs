# Sortie-dogs

**Give OpenCode a task; get a bounded, validated implementation loop instead of an open-ended agent run.**

![Sortie-dogs coordinating a bounded implementation workflow](https://raw.githubusercontent.com/zufall-upon/Sortie-dogs/main/docs/assets/sortie-workflow.gif)

Sortie-dogs is an opt-in OpenCode orchestration plugin. It turns a task into a
scoped plan, parallel investigation, dedicated implementation, canonical
validation, and evidence-backed completion—while preserving standard OpenCode
agents and settings.

Requirements: Node.js 22.6 or newer, npm, and OpenCode.

Guides: [日本語](docs/guide-ja.md) · [简体中文](docs/guide-zh-CN.md)

## Why Sortie-dogs

- **Focused when invited, invisible otherwise.** Activate it with `/sortie` or
  select `dog-coordinator`; ordinary OpenCode sessions remain unchanged.
- **Parallel context without uncontrolled fan-out.** Every worker handoff uses
  exactly three bounded scouts before implementation begins.
- **Writes stay inside the assignment.** Exact source or operation manifests
  gate edits and handoffs.
- **One accountable implementation path.** A dedicated Sol worker handles
  implementation, remediation, and blocker resolution.
- **Evidence before completion.** Canonical validation, risk-based review, and
  terminal evidence gate coordinator-owned completion and commits.
- **Long work can recover.** Restart recovery and bounded compaction continue
  from retained handoff context rather than silently starting over.

## The workflow

1. **Brief and plan** — `dog-coordinator` turns the request into acceptance
   criteria, a write manifest, and validation requirements.
2. **Exactly three scouts** — bounded, read-only investigation collects
   complementary evidence without expanding the write scope.
3. **Dedicated worker** — the Sol worker implements only the approved manifest
   and also owns scoped remediation or blocker resolution.
4. **Canonical validation** — the declared test or build command must produce
   acceptable evidence.
5. **Risk-based review** — high-risk candidates receive independent review;
   low-risk candidates can skip that extra pass after validation.
6. **Coordinator completion** — only the coordinator closes the loop and owns
   any commit after manifest, validation, review, and evidence gates pass.
7. **Bounded continuation** — restart recovery and compaction handoffs preserve
   progress; repeated batches remain bounded rather than becoming endless
   delegation.

## A visual walkthrough

### Control complexity

![Bounded roles and gates containing orchestration complexity](https://raw.githubusercontent.com/zufall-upon/Sortie-dogs/main/docs/assets/sortie-complexity.png)

The coordinator keeps investigation, implementation, validation, and review in
separate roles. Manifest gates keep their writes bounded even as the project
gets more complex.

### Finish with evidence

![Validated work reaching coordinator-owned completion](https://raw.githubusercontent.com/zufall-upon/Sortie-dogs/main/docs/assets/sortie-complete.png)

Validation and risk-based review happen before coordinator-owned completion, so
the result returns with a concise record of what changed and how it was checked.

## Install from the v0.1.0 release

Install the published GitHub release asset in the target project, then generate
the project-local runtime files:

```sh
npm install --save-dev https://github.com/zufall-upon/Sortie-dogs/releases/download/v0.1.0/sortie-dogs-0.1.0.tgz
npx sortie-dogs init .
```

Create `.opencode/plugins/sortie-dogs.ts` as the OpenCode plugin bridge:

```ts
export { SortieDogsPlugin } from "sortie-dogs/plugin";
```

OpenCode discovers the bridge automatically; no `plugin` entry in
`opencode.json` is required. Restart OpenCode, then start a task:

```text
/sortie <task>
```

Selecting `dog-coordinator` directly also activates the workflow.

## Scope and session guarantees

The plugin is passive by default. It activates a session only when a message
uses `/sortie` or the selected agent is `dog-coordinator`. It validates exact
write scope through source or operation manifests and rejects invalid worker
handoffs. Standard OpenCode agents, roles, settings, and unrelated sessions are
preserved.

On `session.idle`, the final handoff is checked and the session is released. A
`session.deleted` event also releases it. A later request must activate the
workflow again.

## Model routing

The `implementation`, `remediation`, and `blocker-resolution` roles always use
the dedicated Sol worker; user configuration cannot replace those routes. For
non-worker roles, routing is optional and deterministic: Sortie-dogs tries the
preferred target, then ordered fallbacks. If no route is configured, OpenCode's
already selected model remains unchanged.

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

Save project configuration as `.opencode/sortie-dogs.json`. `modelCatalog`
declares provider models and named variants that are actually available;
Sortie-dogs does not invent, probe, or translate variants. Resolution tries the
preferred target and then its fallbacks, rejecting an explicitly routed role
when no candidate appears in the catalog.

`dog-advisor` accepts bounded Strategy or SourceReview consultation from the
coordinator. `dog-reviewer` independently checks high-risk candidates after
canonical validation. Neither role implements, stages, commits, or acts as a
user-facing worker.

## Updates and migration

After replacing the dependency with a newer release asset, run:

```sh
npx sortie-dogs init .
```

`init` is idempotent. It updates files owned by Sortie-dogs, migrates recognized
older runtime files, and records the installed version in
`.opencode/sortie-dogs.version`. Conflicting or unrecognized files remain
untouched and initialization stops safely. User-owned configuration—including
`.opencode/sortie-dogs.json`—and standard OpenCode files are preserved.

## Safe manual removal

There is no supported Sortie-dogs uninstall command. Removing the npm dependency
is a separate package-manager operation: run `npm uninstall sortie-dogs` only in
the directory whose `package.json` declares it. Never delete `package.json` or
`package-lock.json` to remove the package.

To remove generated runtime files manually, delete only these exact
Sortie-dogs-owned paths:

```text
.opencode/agent/dog-coordinator.md
.opencode/agent/dog-worker.md
.opencode/agent/dog-scout.md
.opencode/agent/dog-reviewer.md
.opencode/agent/dog-advisor.md
.opencode/command/sortie.md
.opencode/sortie-dogs.version
```

Never delete the `.opencode`, `.opencode/agent`, or `.opencode/command`
directories, and never use a wildcard such as `*.md`. Preserve the standard
`plan`, `build`, and `builder` agents and every other user-owned file. Do not
remove `.opencode/sortie-dogs.json`, the plugin bridge, other agents, or OpenCode
settings as part of runtime-file removal.

The legacy files `.opencode/agent/coordinator-mk2a2.md` and
`.opencode/agent/sol-worker-mk2a2.md` may be removed only after an old
Sortie-dogs marker or the content confirms Sortie-dogs ownership. If ownership
is unclear or a filename is unexpected, stop and inspect instead of deleting.
