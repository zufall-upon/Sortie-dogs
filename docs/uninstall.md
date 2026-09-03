# Safe manual removal

There is no supported Sortie-dogs uninstall command. Removing the npm dependency
is a separate package-manager operation: run `npm uninstall sortie-dogs` only in
the directory whose `package.json` declares it. Never delete `package.json` or
`package-lock.json` to remove the package.

To remove generated runtime files manually, delete only these exact
Sortie-dogs-owned paths:

```text
.opencode/agent/dog-coordinator.md
.opencode/agent/dog-worker.md
.opencode/agent/dog-luna-worker.md
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
