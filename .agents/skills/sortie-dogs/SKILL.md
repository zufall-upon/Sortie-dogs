---
name: sortie-dogs
description: Run a task through the installed Sortie-dogs Codex Mission adapter when the user explicitly invokes $sortie-dogs. Preserve the existing Mission ledger and keep OpenCode configuration separate.
---

# Sortie-dogs

Treat the user's text accompanying `$sortie-dogs` as the Mission request. If no task was supplied, ask for it and stop.

## Boundaries

- Use the reviewed, locally installed `sortie-dogs` package. Never install or update a package, use `@latest`, publish, or switch authentication as part of invocation.
- Require the existing Codex CLI ChatGPT authentication. Do not use an API key or metered API fallback.
- Do not run `sortie-dogs init`; that command configures OpenCode. This skill uses only `sortie-dogs codex ...` and never edits `.opencode`.
- Do not create another ledger. The Codex adapter must reuse Sortie's existing Mission state, protected evidence, and scope leases.
- After starting a child Mission, observe it; do not edit the same project concurrently from the parent Codex chat.
- Preserve the user's authority boundaries. Invocation does not authorize push, publication, dependency installation, broader permissions, or unrelated changes.

## Resolve the local entrypoint

Prefer `npx --no-install sortie-dogs` when the current project has the package installed. In the Sortie-dogs source repository itself, use `node dist/cli/main.js` after the repository's normal build when needed. Do not resolve a missing command from the network.

Check the selected entrypoint with `<entrypoint> codex --help` before starting work. If the packaged command lacks `codex mission` and `codex run`, report that the installed candidate is too old.

## Choose one route

On a POSIX host with `/bin/bash`, use the natural-language Mission route:

```text
<entrypoint> codex mission --project-root <repository-root> --prompt <exact-user-request>
```

Forward `--model`, `--effort`, or `--permissions` only when the user selected those values. Never silently widen the native permission profile. If an existing Mission is reported, resume only its exact root with `--resume`; do not launch replacement work.

On Windows, use the manifest-bound route until the full Mission shell path supports Windows natively:

1. Read repository instructions and inspect only enough to identify bounded project-relative read scope, write scope, and meaningful validation commands.
2. Create one temporary manifest under `.sortie-dogs/codex-skill/` with `version`, `task_id`, `read`, `write`, and non-empty `validation`. Reject external or uncertain write scope instead of broadening it.
3. Resolve the exact PowerShell executable with `(Get-Command pwsh.exe -ErrorAction Stop).Source`. Invoke:

```text
<entrypoint> codex run --project-root <repository-root> --manifest <temporary-manifest> --prompt <exact-user-request> --trusted-pwsh <resolved-pwsh.exe>
```

4. Remove only the temporary manifest created by this invocation after the command reaches a terminal result. Preserve `.git/sortie-dogs` evidence and any other state.

If no defensible validation or bounded write scope can be derived, explain the missing contract and stop without starting Codex.

## Completion

Treat only Mission acceptance or manifest settlement `succeeded` with admitted validation evidence as success. A completed native turn, model prose, or validation exit zero without admitted evidence is not completion.

Report the route, terminal status, root/thread identity, validation evidence count, changed paths, and any explicit remaining boundary. Subscription monetary cost is unavailable unless the host supplies it; never fabricate one.
