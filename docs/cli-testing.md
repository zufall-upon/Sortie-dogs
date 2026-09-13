# CLI testing

This project has two distinct CLI test layers. Both are required before a
release. Do not treat the automated `sortie-dogs` CLI suite as a substitute for
a real OpenCode CLI run.

For everyday test selection, build requirements, Windows detached full-test
execution, monitoring, and timing history, see the
[test execution guide (日本語)](testing.md). Full-suite commands below are release
gates; ordinary development uses the relevant targeted tests plus `npm test`.

## 1. Automated package CLI regression

Run from the repository root:

```sh
npm run test:full
```

`npm test` is the fast development gate for plugin, continuation, and fast-lane
behavior. `npm run test:full` rebuilds `dist/`, then executes every
`test/**/*.test.ts` file for release. CLI coverage is split across these files:

- `test/cli.test.ts` starts the real TypeScript CLI entry in a child process and
  fixes stdout, stderr, exit codes, link resolution, handoff/manifest linting,
  resource limits, and diagnostic ordering.
- `test/initialize.test.ts` starts the same entry and covers project and global
  `init`, idempotence, environment precedence, legacy-file preservation, and
  rollback.
- `test/security.test.ts` starts the CLI with hostile input and proves that
  oversized, malformed, secret-like, and control-character input is not leaked.
- `test/plugin-loader.test.ts` packs the repository into `_testenv`, installs the
  tarball offline into an isolated consumer, and imports the public package,
  plugin, server, and runtime-asset entries. This guards the packed artifact,
  not only repository source.

The subprocess assertions are intentional. Calling CLI functions directly
would not test process exits, stream routing, shebang generation, or linked
entry behavior. Fixtures and temporary consumers belong under `_testenv` and
must be removed by the test that created them. Do not commit `_testenv`.

Targeted commands are useful while developing, but do not replace the full
release gate. They import `dist/`, so rebuild it first:

```sh
npm run build
node --experimental-strip-types --import ./test/setup.ts --test test/cli.test.ts
node --experimental-strip-types --import ./test/setup.ts --test test/initialize.test.ts
node --experimental-strip-types --import ./test/setup.ts --test test/security.test.ts
node --experimental-strip-types --import ./test/setup.ts --test test/plugin-loader.test.ts
```

`test/plugin-loader.test.ts` uses `npm_execpath` when available, otherwise it looks
for `node_modules/npm/bin/npm-cli.js` beside the current Node executable. If a
custom installation uses another layout, set `npm_execpath` to its actual
`npm-cli.js` entry before running the targeted test. A missing npm entry is not a
reason to start a full-suite run. Run package-loader tests separately from other
commands that read or rebuild `dist/`, because `npm pack` runs the build lifecycle.

## 2. Packed OpenCode CLI acceptance

This layer proves that OpenCode can load and execute the package produced for
release. It is manual because it needs an installed OpenCode CLI, provider
access, and a fresh process/session.

1. Confirm a passing `npm run test:full` result for the exact release candidate.
   Reuse a completed result for unchanged source rather than starting the same
   full validation again.
2. Create the tarball only under `_testenv`:

   ```powershell
   npm pack --pack-destination .\_testenv
   ```

3. Verify the approved OpenCode CLI. On the repository maintainer's Windows
   environment the CLI is in WSL and must be invoked through `wsl.exe`; the
   Windows Desktop executable is a different acceptance target:

   ```powershell
   wsl.exe -e bash -ic 'command -v opencode; opencode --version'
   ```

4. Create a fresh project under `_testenv` with an explicit project-local
   `.opencode/package.json` dependency on that exact tarball. For example:

   ```text
   _testenv/cli-acceptance/
     sortie-dogs-<version>.tgz
     project/
       .opencode/package.json
   ```

   The dependency in this layout is
   `"sortie-dogs": "file:../../sortie-dogs-<version>.tgz"`.
   Install it in the same environment that will run OpenCode. In a WSL login
   shell through `bash -ic`, run from the fixture's `.opencode` directory:

   ```sh
   npm install --force
   node node_modules/sortie-dogs/dist/cli/main.js init ..
   ```

   From Windows, enter that directory with
   `wsl.exe --cd "<absolute-WSL-project-path>/.opencode" -e bash -ic 'npm install --force && node node_modules/sortie-dogs/dist/cli/main.js init ..'`.
   Do not use Windows `npm install --prefix` for a WSL fixture: nested fixtures
   can be rewritten to a repository self-link instead of the packed tarball.
   After installation, confirm that the declared `file:` dependency is unchanged,
   the lockfile is not a repository link, and `node_modules/sortie-dogs` contains
   the extracted package with the expected package version and runtime marker.

5. Load the installed package either with an OpenCode `plugin` entry naming
   `sortie-dogs`, or with this project-local bridge and no other runtime export:

   ```ts
   export { SortieDogsPlugin } from "sortie-dogs/plugin";
   ```

6. Fully stop and restart OpenCode. From the fresh project, run the equivalent
   of:

   ```sh
   opencode debug config
   opencode run --command sortie
   ```

   On the Windows/WSL host, use
   `wsl.exe --cd "<absolute-WSL-project-path>" -e bash -ic 'opencode debug config && opencode run --command sortie'`.
   Keep `bash -ic` in the launch path so the plugin and its children inherit the
   same executable resolution environment.

The repository-local `AGENTS.md` records the currently approved executable and
environment details. Those local details override examples in this document.

## Acceptance oracle

The packed OpenCode CLI run passes only when all applicable checks succeed:

- `debug config` resolves the project-local packed plugin, `/sortie`, and the
  installed dog agents. No repository-source or developer-global fallback.
- A fresh `/sortie` session reaches `dog-coordinator`, performs the bounded scout
  and worker handoffs, records canonical validation, and reaches a terminal
  coordinator result.
- The exact root coordinator is never write-gated, including before the first worker dispatch.
  It owns direct inspection, tracker, Git, release, package, and control-file operations without
  executable or subcommand allowlists. Child and worker sessions remain fail-closed until their
  accepted handoff and operation manifest bind an exact write scope.
- A declared write succeeds while an undeclared write is rejected before
  mutation. Independently, `sortie-dogs lint ... --changed-path
  undeclared.txt --strict` returns exit `1` and
  `M005_CHANGED_PATH_NOT_WRITABLE` for the same manifest boundary.
- Restart/update validation uses retained project artifacts rather than silently
  starting a different run.
- The process exits cleanly. Evidence contains command, exit code, and a short
  fingerprint only; never retain credentials, raw session logs, provider login
  URLs, or private Project metadata.
- All temporary projects and transferred tarballs remain under `_testenv` and
  are cleaned after acceptance.

Windows Desktop acceptance remains separate. Installing or initializing over
SSH does not prove the interactive Desktop `/sortie` path.

For continuation or compaction repairs, unit tests and the generic packed CLI
smoke are not sufficient. Reuse the same `_testenv` fixture for before/after WSL
CLI runs with `opencode run --format json --print-logs`. Confirm the original
stop, the synthetic turn or compaction summary, same-session resume, and terminal
completion. Record the WSL-installed package version and runtime asset marker
separately. Retain bounded results and sanitized evidence, not raw session logs.

## Historical U2/U3 harness

The first implementation used committed `_testenv/u2-canonical` and
`_testenv/u3-rpt` fixtures:

- U2 ran `opencode debug config` and `opencode run --command sortie` with the
  canonical coordinator and write gate active.
- U3 repeated the run from a cold runtime and required native Patch to reject
  `denied.txt` while permitting `allowed.txt`.

The fixtures were introduced in commits `274afaa` and `6e2eaaa`, refreshed in
`a19e523` and `dd29897`, then removed in `1a4961b` because `_testenv` is
ephemeral. Their scenario oracle remains valid and is captured above; their
host-specific manifests and result files must not be restored as tracked test
data.
