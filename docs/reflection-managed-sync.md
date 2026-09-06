# Project Reflection Synchronization

When project reflections are enabled, the coordinator automatically synchronizes
qualifying project entries after a terminal `DONE` checkpoint. No separate sync
tool, activation step, or per-update confirmation is required. Existing reflection
opt-out settings remain authoritative; enabling this feature does not enable
reflection collection by itself.

Only `promotable` entries with at least two hits or `user-correction` evidence are
eligible. The renderer receives prevention text only, deduplicates by scope, and
limits the generated block to five entries and 4096 bytes. Run and global entries
are not promoted. These reminders cannot authorize changes to scope, permissions,
validation, or review requirements.

The coordinator owns a separate maintenance manifest at
`.sortie-dogs/reflection-maintenance/operation-manifest.json`. It explicitly covers
`AGENTS.md` and its maintenance state. This does not expand any worker's manifest.
Active calls, bound write gates, unarchived parallel work, or queued continuation
defer synchronization.

To stop synchronization for a project, create
`.sortie-dogs/reflection-maintenance/options.json`:

```json
{"enabled": false}
```

To exclude selected scopes while keeping synchronization enabled:

```json
{"excludedScopes": ["example-scope"]}
```

`SORTIE_REFLECTION_SYNC=0` also stops synchronization for the host process.
Forgotten, expired, and excluded entries disappear at the next eligible terminal
checkpoint. User-authored bytes outside the managed markers are preserved.

Writes use a file lock, hash checks, a recovery receipt, and atomic rename. Manual
drift, unknown blocks, changed manifests, and lock contention leave `AGENTS.md`
untouched and return a non-blocking typed proposal. When the control directory is
authorized, the proposal is recorded in its `proposal.json`. A manual rollback is
treated as drift, not permission to restore generated instructions.
