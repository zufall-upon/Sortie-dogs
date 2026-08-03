# Sortie-dogs

Sortie-dogs packages the Mk2A2 orchestration workflow as an OpenCode plugin. It
adds the `/sortie` command, a coordinator, bounded worker roles, write-scope
checks, handoff validation, and deterministic model selection without replacing
standard OpenCode roles or settings.

Requirements: Node.js 22.6 or newer, npm, and OpenCode.

Guides: [日本語](docs/guide-ja.md) · [简体中文](docs/guide-zh-CN.md)

## Build and test

```sh
npm ci
npm run build
npm test
```

`npm test` builds the TypeScript package and then runs the Node test suite.

To create an installable archive:

```sh
npm pack
```

## Install in an OpenCode project

Install the resulting archive in the target project, initialize the runtime
files, and add the OpenCode plugin bridge:

```sh
npm install --save-dev /path/to/sortie-dogs-0.1.0.tgz
npx sortie-dogs init .
```

Create `.opencode/plugins/sortie-dogs.ts`:

```ts
export { SortieDogsPlugin } from "sortie-dogs/plugin";
```

OpenCode discovers this bridge automatically; no `plugin` entry in
`opencode.json` is required. Restart OpenCode after installation, then invoke:

```text
/sortie <task>
```

`sortie-dogs init` is idempotent. It installs the packaged agents and command
under `.opencode/` and records their version in
`.opencode/sortie-dogs.version`. On update, it replaces files that it owns and
migrates recognized older runtime files. Conflicting or unrecognized files are
left untouched and initialization stops safely. User-owned files, including
`.opencode/sortie-dogs.json`, and standard OpenCode agents, roles, and settings
are preserved.

## Session behavior

The plugin is passive by default. A session activates only when a message uses
`/sortie` or the selected agent is `dog-coordinator`. Other OpenCode sessions
continue unchanged.

An active session enforces its operation manifest and validates its handoff. On
`session.idle`, the final handoff is checked and the session is released. A
`session.deleted` event also releases it. A later request must activate the
session again.

## Model routing

Model routing is optional. With no route for a role, OpenCode's already selected
model remains unchanged. A `modelRouting` entry is therefore an explicit model
override for a non-worker role, not a global default.

The Mk2A2 execution roles `implementation`, `remediation`, and
`blocker-resolution` use the dedicated Sol model. User configuration cannot
replace those routes. Other roles may define a preferred target and ordered
fallbacks:

```json
{
  "modelRouting": {
    "dog-reviewer": {
      "preferred": { "model": "provider/reviewer" },
      "fallback": [{ "model": "provider/general", "variant": "careful" }]
    }
  },
  "modelCatalog": {
    "project": [
      { "model": "provider/reviewer" },
      { "model": "provider/general", "variants": ["careful"] }
    ]
  }
}
```

Save project configuration as `.opencode/sortie-dogs.json`. `modelCatalog`
declares which provider models and named variants are available; it does not
invent, probe, or translate variants. Variant names must be supplied by the
provider. Resolution tries the preferred target, then its fallbacks, and rejects
an explicitly routed role when none appears in the catalog.

## Runtime file maintenance and manual removal

Sortie-dogs has no supported uninstall command. Re-running
`npx sortie-dogs init .` remains the normal installation and migration path.

Removing the npm dependency is a separate operation: run
`npm uninstall sortie-dogs` in the directory whose `package.json` declares the
dependency. Never delete `package.json` or `package-lock.json` to remove the
package.

To remove the generated runtime manually, delete only these exact
Sortie-dogs-owned files:

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
remove `.opencode/sortie-dogs.json`, the plugin bridge, other agents, or
OpenCode settings as part of runtime-file removal.

The legacy files `.opencode/agent/coordinator-mk2a2.md` and
`.opencode/agent/sol-worker-mk2a2.md` may be removed only after their old
Sortie-dogs marker or content confirms Sortie-dogs ownership. If the marker is
absent or unknown, or any filename is unexpected, stop and inspect instead of
deleting it.

This safety guidance does not change installation or migration behavior, or
the scope of `/sortie --model`.
