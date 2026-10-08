# Contributing to Sortie-dogs

Bug reports, documentation improvements, accessibility feedback, tests and focused code changes
are welcome. Participation follows our [Code of Conduct](CODE_OF_CONDUCT.md).

## Choose the right channel

- Use the [issue forms](https://github.com/zufall-upon/Sortie-dogs/issues/new/choose) for bugs,
  feature proposals and accessibility barriers. English and Japanese reports are welcome.
- Report suspected vulnerabilities **privately**, following [SECURITY.md](SECURITY.md).
- For usage questions, check the [README](README.md#documentation) and existing issues first.
  A blank issue remains available when a form does not fit.

Include the host (OpenCode V2 or Codex), OS, Sortie-dogs/host/Node versions, a minimal reproduction,
expected versus observed behavior, and relevant command exits. Missing information can be marked
unknown; do not rerun paid inference merely to fill a form. Remove credentials, private prompts,
repository content and identifying paths from shared logs.

## Development setup

Use Node.js **22.6+**, npm and Git. Fork the repository for external contributions, then create
a short-lived branch from the latest `main` in your clone:

```sh
git switch main
git pull --ff-only
git switch -c fix/short-description
npm ci
```

Use a `docs/` branch for documentation-only changes. Work against source under `src/`, tests under
`test/`, and documentation under `docs/`. `dist/`, `_testenv/`, raw benchmark logs, datasets and
local credentials are generated or private material, not PR content. Follow [AGENTS.md](AGENTS.md)
for repository-specific development and release rules.

Keep fixes small and preserve existing host authentication, permissions, models and user-owned
configuration. Add a regression test for changed behavior; avoid unrelated refactors. AI-assisted
contributions follow the same review and evidence requirements as other contributions. Model prose
is not execution evidence, and contributors remain responsible for their submitted changes.

## Validate the change

While editing, group related changes and run the affected tests:

```sh
npm run test:targeted -- test/<affected-file>.test.ts
```

Replace the placeholder with an existing test file. The targeted command builds once and runs only
the selected tests. At the finished integration candidate, code changes use:

```sh
npm run test:full
```

On Windows, common tests run from a source snapshot on the WSL Ubuntu Linux filesystem. WSL login
Bash needs Node.js 22.6+, npm and Git; select another distro with `SORTIE_WSL_DISTRO`. Complete
Windows validation also runs the Windows-only suite, **after** the full suite:

```sh
npm run test:windows
```

See the [testing guide](docs/testing.md) and [Windows details](docs/windows-tests.md) for prerequisites,
timeouts and retained receipts. Record command, exit, elapsed time and any skipped checks. Do not
claim an unavailable OS or host was tested. Reuse valid evidence for unchanged inputs.

For documentation/templates alone, check links, anchors, examples and YAML syntax plus
`git diff --check`; a model call, benchmark, package release or local full-suite rerun is not needed
unless the change affects executable behavior. SWE-bench is optional measurement, not a release gate.

## Open a pull request

- Target `main`; do not merge another contributor's working branch directly.
- Explain the problem, focused change and validation in the PR template. Link an issue if relevant;
  an issue is not mandatory for a small fix.
- Distinguish verified results from remaining limitations. Keep raw logs and secrets out of Git;
  share redacted summaries or appropriate public evidence instead.
- Update user-facing docs when behavior changes. If runtime asset markers change, synchronize their
  definitions and tests using the existing repository rules.

Maintainers review and integrate PRs through `main`. Publishing, tagging and global installation are
separate maintainer operations, not routine contribution checks. Do not bump the package version or
publish a release unless that is the agreed task; see [release guidance](docs/release-batch.md) and
[AGENTS.md](AGENTS.md#release-gate).
