# CLI testing

This project has two distinct CLI test layers. Both are required before a
release. Do not treat the automated `sortie-dogs` CLI suite as a substitute for
a real OpenCode CLI run.

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
node --experimental-strip-types --test test/cli.test.ts
node --experimental-strip-types --test test/initialize.test.ts
node --experimental-strip-types --test test/security.test.ts
node --experimental-strip-types --test test/plugin-loader.test.ts
```

`test/plugin-loader.test.ts` requires `npm_execpath`, so use
`npm run test:full` if a direct Node invocation reports that variable missing.

## 2. Packed OpenCode CLI acceptance

This layer proves that OpenCode can load and execute the package produced for
release. It is manual because it needs an installed OpenCode CLI, provider
access, and a fresh process/session.

1. Run `npm run test:full`.
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

4. Create a fresh project under `_testenv`, install that exact tarball as a
   project-local dependency, and run its packed CLI entry:

   ```sh
   npm install --prefix <project>/.opencode --no-save <tarball>
   node <project>/.opencode/node_modules/sortie-dogs/dist/cli/main.js init <project>
   ```

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

The repository-local `AGENTS.md` records the currently approved executable and
environment details. Those local details override examples in this document.

## Acceptance oracle

The packed OpenCode CLI run passes only when all applicable checks succeed:

- `debug config` resolves the project-local packed plugin, `/sortie`, and the
  installed dog agents. No repository-source or developer-global fallback.
- A fresh `/sortie` session reaches `dog-coordinator`, performs the bounded scout
  and worker handoffs, records canonical validation, and reaches a terminal
  coordinator result.
- Before the first worker dispatch, that root coordinator may create or repair only
  root-level `operation-manifest.json`/`*.operation-manifest.json` and matching
  `handoff*.json` control files. One exact native write or one paired `apply_patch`
  is allowed. Shell redirection, source paths, child sessions, and malformed
  contracts remain fail-closed; after accepted dispatch, normal inspection and binding apply.
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
