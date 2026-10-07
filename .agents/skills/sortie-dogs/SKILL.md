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

Use the natural-language Mission route on POSIX and Windows:

```text
<entrypoint> codex mission --project-root <repository-root> --prompt <exact-user-request>
```

Forward `--model`, `--effort`, or `--permissions` only when the user selected those values. Never silently widen the native permission profile. If an existing Mission is reported, resume only its exact root with `--resume`; do not launch replacement work.

Leave `--model` unset to retain role-specific defaults: Sol 6.1 Operator/Coordinator/Reviewer and Luna-fast Worker. The Codex adapter maps the shared Luna-fast alias to native `gpt-6-luna` plus the `priority` (Fast) service tier; it does not alter OpenCode defaults. Fast consumes subscription limits faster than Standard; no metered API fallback is allowed.

On Windows the same Mission command resolves existing PowerShell 7 automatically. Add `--trusted-pwsh <absolute-pwsh.exe>` only when an exact existing executable needs to be selected; do not add a separate shell preflight or approval step.

The compatibility tool named `bash` executes PowerShell commands on Windows and POSIX bash on POSIX. Do not supply POSIX commands to the Windows shell. Shell and file commands still use the configured native permissions, or an explicitly integrated host executor. A sandbox startup failure is not a validation failure or success: preserve the failed execution and report the environment blocker; do not widen permissions or stop unrelated Codex processes.

Use the manifest-bound `codex run` route only for an explicitly selected single-task manifest workflow. It is not the full multi-role Mission route:

1. Read repository instructions and inspect only enough to identify bounded project-relative read scope, write scope, and meaningful validation commands.
2. Create one temporary manifest under `.sortie-dogs/codex-skill/` with `version`, `task_id`, `read`, `write`, and non-empty `validation`. Reject external or uncertain write scope instead of broadening it.
3. On Windows the manifest workflow needs the exact PowerShell executable for command-envelope observation. Resolve it with `(Get-Command pwsh.exe -ErrorAction Stop).Source`, then invoke:

```text
<entrypoint> codex run --project-root <repository-root> --manifest <temporary-manifest> --prompt <exact-user-request> --trusted-pwsh <resolved-pwsh.exe>
```

4. Remove only the temporary manifest created by this invocation after the command reaches a terminal result. Preserve `.git/sortie-dogs` evidence and any other state.

If no defensible validation or bounded write scope can be derived, explain the missing contract and stop without starting Codex.

## Completion

Treat only Mission acceptance or manifest settlement `succeeded` with admitted validation evidence as success. A completed native turn, model prose, or validation exit zero without admitted evidence is not completion.

Report the route, terminal status, root/thread identity, validation evidence count, changed paths, and any explicit remaining boundary. Subscription monetary cost is unavailable unless the host supplies it; never fabricate one.
