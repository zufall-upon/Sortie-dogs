# Release batch

The release tooling is repository-maintainer tooling, not part of the distributed plugin. It runs on
Windows with PowerShell 7, Node 22, Git, the approved npm/gh executables, and a configured WSL OpenCode
CLI. The batch does not perform npm authentication or publication itself; the manual publication
stage is still part of the release routine, not an optional follow-up.

## Release completion

**The release routine includes npm publication.** Validation, global application, a version tag,
or a GitHub Release alone does not complete it. Use the same frozen tarball throughout validation,
installation, GitHub Release attachment and npm publication. Record npm's successful acceptance,
retain the receipts, finish cleanup, and perform the read-only publication checks below.

`prepare` completes the batch's preparation/distribution stages and prints the npm commands; it
does **not** complete the overall release routine. For an authorized release, continue through the
manual npm publication stage within the existing authorization. Do not add another approval gate
merely because the batch command ended. If login, OTP or another user-only action is required,
report that concrete dependency and the unfinished publication rather than claiming release success.

An explicit validation/install-only request or publication hold is a narrower delivery scope:
report a validated or installed **candidate**, with npm publication unperformed. Historical
candidate notes that retained a manual publication boundary describe that request's scope; they
do not remove npm publication from the normal release routine or prove that version was published.
A documentation-only request does not itself authorize publishing an existing candidate.

Record registry propagation separately from npm's successful acceptance. A temporary 404 or stale
`latest` after acceptance requires later read-only reconciliation, not another publish. Report any
pending checks explicitly. Restarting a shared OpenCode host remains a separate manual operation;
installed bytes, npm publication and the running host's loaded version are different observations.

## Prepare a manifest

Use `scripts/release.example.json` as the starting point for an ignored `.opencode/release.json`.
Do not put credentials, Project metadata, or private operations in the manifest or public notes.

- `files`: the exact repository-relative files to include in the release commit. Include all changed
  production source and release tooling. Unrelated test/docs work can remain unstaged.
- `versionTextFiles`: files containing the old package version to synchronize. The example includes
  README, both translated guides, and the package-loader test. `package.json` and `package-lock.json`
  are updated structurally. Runtime asset changes must already have synchronized their separate marker,
  asset versions, descriptions, and corresponding tests before prepare.
- `targetTests`: tests relevant to the changes. The batch also runs `npm test` and `npm run test:full`.
- `notesFile`: reviewed, public release notes, normally `temp/release-notes.md`. The batch adds the tgz
  SHA-256. It does not generate release claims from raw logs.
- `npm`, `gh`, `globalRoot`: local tool/install paths. `GITHUB_TOKEN` is removed from gh's environment;
  the existing gh authentication is used. Global init explicitly uses the configured root.
- `recovery`: required for changes to the continuation runtime, goal reducer, or main plugin hook;
  see the recovery-driver contract below.

Paths use forward slashes. `files` must include the package/version files. Keep the package version
at its current value; the batch updates it to the requested new version. Start with an empty index,
on `main`, with local HEAD equal to `origin/main`. Existing release versions/tags are rejected; choose
the next patch rather than reusing them.

Freeze the candidate before preparation: finish and review the exact source files, manifest, and
public notes, then stop unrelated edits. `preflight` checks manifest scope, tool/version
availability, recovery-driver inputs, and target release tests without changing source, the index,
tags, releases, global installation, or package version:

```powershell
.\scripts\release.ps1 preflight -Version 0.9.7 -Manifest .opencode/release.json
```

```powershell
.\scripts\release.ps1 prepare -Version 0.9.7 -Manifest .opencode/release.json
```

This command **does commit, push, tag, create a public GitHub Release, and update the global install**
after validation succeeds. Run it only for an intended release. Creating/testing the batch itself
does not invoke this command against the real repository.

## Fixed sequence

1. Audit branch, index, remote main, version availability, and intended production files.
2. Synchronize package version references and freeze the source fingerprint/public notes.
3. Build, targeted tests, `npm test`, `npm run test:full`, `git diff --check`.
4. Generate one distributable tarball in `_testenv/releases/<version>/` and record SHA-256/SHA-1.
5. Run the bundled WSL CLI smoke using that exact tarball; run the additional recovery fixture when required.
6. Install the same tarball globally, initialize assets, compare installed code and all canonical assets.
7. Stage only `files`, check staged scope and source, commit with the repository release author.
8. Push `main`, create/push an annotated version tag, create the Release with the frozen tarball.
9. `prepare` prints manual npm login/publish and `verify-publish` commands. The release remains
   publication-pending until the manual npm stage below succeeds.
10. Publish the same frozen tarball once, record npm acceptance, perform read-only publication
    verification and finish cleanup. Retain any propagation delay as a pending observation, not a
    reason to republish or rerun unchanged validation.

Tests may create their own fixture packages. The **distributable** tarball is generated once and used
unchanged by CLI, global installation, GitHub Release, and the required manual npm publication stage. A changed source
fingerprint or digest invalidates the candidate. No tag/Release is deleted or replaced automatically.

## CLI smoke

`scripts/release-cli.mjs` creates a new `_testenv` fixture for each explicit attempt. It installs the
tarball using WSL npm, checks the relative `file:` dependency and non-link lock entry, and verifies
runtime assets. It creates a Git seed, obtains a CLI checkpoint, then resumes the same session/goal.
The worker binds a nested manifest, patches `child/result.txt`, and runs the fixed canonical command.
Success requires native ledger evidence, a successful terminal receipt, and an independent content
oracle. A model's success claim alone is insufficient.

The WSL entry uses `bash -ic`; nested commands set both `cwd` and `PWD`. Each OpenCode call runs under
guest-side `timeout` with TERM/KILL handling so killing only Windows `wsl.exe` is not the cleanup plan.
stdin is closed, output is bounded, and raw CLI logs remain in memory. Only typed phase diagnostics and
the final proof are returned. Failed fixtures are retained, and retries create a new fixture instead
of silently rewriting the failed attempt.

Run this smoke independently against an already generated package:

```powershell
node scripts/release-cli.mjs _testenv/sortie-dogs-0.9.6.tgz _testenv/release-batch-cli-check
```

This smoke checks ordinary same-session continuation. It is **not** proof of a particular historical
compaction, ticket, or budget bug being fixed.

## Recovery-driver contract

For a recovery-related change, add a dedicated, reviewed fixture driver matching that defect. The
tracked `test/fixtures/release-recovery/driver.mjs` is a deterministic input/receipt contract
fixture only. It does not run a model or prove continuation; do not report it as runtime proof:

```json
{
  "recovery": {
    "driver": "test/fixtures/release-recovery/driver.mjs",
    "baselineTgz": "_testenv/sortie-dogs-previous.tgz"
  }
}
```

These are illustrative paths; the driver must exist. A generic baseline failure is not substituted
for the defect being released. The driver runs as:

```text
node <driver> <candidate-tgz> <baseline-tgz> <release-directory>
```

It must reproduce the old stop in an isolated fixture, retain its session and goal, install the exact
candidate tarball, observe a synthetic continuation turn or compaction summary, resume, and verify
worker execution, canonical PASS, and terminal success. It prints exactly one JSON receipt on stdout:

```json
{
  "schema": 1,
  "version": "0.9.7",
  "sha256": "candidate tarball SHA-256",
  "runtimeMarker": "installed runtime marker",
  "sessionID": "ses_same_session",
  "workerStarted": true,
  "canonicalExit": 0,
  "terminal": "succeeded",
  "artifactMatch": true,
  "baselineSha256": "baseline tarball SHA-256",
  "beforeStopped": true,
  "beforeSession": "ses_same_session",
  "sameGoal": true,
  "continuationEvidence": "synthetic-turn"
}
```

`continuationEvidence` also accepts `compaction-summary`. The batch validates this receipt and both
artifact hashes; the trusted driver is responsible for deriving fields from host/fixture evidence.
Its source is included in the frozen input fingerprint. It may not edit real user-session ledgers.

## Failure and restart

Repeat the **same command with the same manifest** after resolving an external failure. State lives
in `_testenv/releases/<version>/state.json`, with a pending phase recorded before effects.

- Completed test phases are reused only if the frozen input fingerprint still matches. The phases are
  `build`, target tests, `npm test`, and `npm run test:full`; a later failure resumes at that phase
  and does not rerun earlier passed tests.
- Completed CLI receipts must still identify the same candidate digest.
- Completed global application is reverified rather than assumed valid.
- An interrupted commit is reconciled against its parent, author, subject, scope, and current files.
- Remote main advancement blocks a resumed push. Annotated tag target is checked before reuse.
- A lost response after Release creation is reconciled against the existing asset digest. Missing or
  mismatched assets stop the batch for inspection; it does not replace or recreate published assets.
- An interrupted pack that left an unreceipted tgz stops for inspection rather than overwriting it.
- Source changes after freeze stop the run. Before any publication, the maintainer can explicitly
  abandon the failed candidate directory after confirming no operation remains active, then start
  validation afresh. After tag/Release publication, use a new version for changed code.

`_testenv/releases/release.lock` serializes prepare across versions. It records the process ID. An
uncleanly terminated batch can leave this lock; confirm the owner and all children stopped before
manually removing it. The batch never assumes an unknown live owner is stale.

Every failed phase writes `_testenv/releases/<version>/failure.json` with typed phase, exact command,
tool category, exit code, timeout/overflow flags, and timestamp. Raw logs and secrets are never
persisted. The receipt is removed after a successful phase or successful preflight.

## 2026-09-11 feedback

The v0.9.7 first run took about 60 minutes. Causes: repeated broad validation during prepare/resume,
recovery/CLI work mixed into the release path, and input/tool problems discovered after effects
started. Target 20–35 minutes by freezing the candidate before `prepare`, running `preflight` first,
and resuming at granular completed test phases instead of rerunning target tests, `npm test`, and
`test:full`. This target excludes model capacity and external npm/GitHub delays.

## Manual npm publication and verification

This is the final publication stage of the release routine, not a separate optional task. Use the
command block printed by prepare. It runs `whoami`, browser login only if needed, then manual
`npm publish` and optional interactive OTP. No credential values are saved in the receipt.

When a maintainer already has a suitable npm token in a private file, an isolated userconfig can be
used instead of changing the existing npm login. Set `NPM_TOKEN_FILE` and `TGZ` to the private token
file and the already validated, fixed archive respectively. Disable shell tracing, restrict access to
the token file, and never print or commit the token. The following Linux shell example keeps the
credential out of command arguments and uses a temporary config and cache:

```sh
(
set +x
set -e
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
printf '%s\n' '//registry.npmjs.org/:_authToken=${NPM_TOKEN}' > "$tmpdir/npmrc"
chmod 600 "$tmpdir/npmrc"
NPM_TOKEN="$(cat "$NPM_TOKEN_FILE")" \
  NPM_CONFIG_USERCONFIG="$tmpdir/npmrc" NPM_CONFIG_CACHE="$tmpdir/cache" NPM_CONFIG_LOGS_MAX=0 \
  npm publish "$TGZ" --access public --tag latest
)
```

Before publishing, check whether the exact version already exists; if so, compare its integrity with
the fixed archive and do not publish again. Record the publish command's result separately from the
subsequent registry version, `latest`, and integrity checks. A successful publish followed by a 404
can be registry propagation delay, not permission to retry publication. If the response is lost,
reconcile the existing operation and registry before deciding how to resume. Keep local machine paths
and credentials out of shared documents and version control.

```powershell
.\scripts\release.ps1 verify-publish -Version 0.9.7 -Manifest .opencode/release.json
```

Verification is read-only: it checks the exact npm version, registry SHA-1/local tgz equality, remote
annotated tag, and GitHub asset digest. It reports the current latest npm version and remote main
without treating a later legitimate release as corruption of the older version. It does not require
the current workspace to remain frozen after a completed release.

Restart OpenCode completely to load newly installed global code. Successful CLI smoke proves its
isolated fixture; it does not claim that every paused real project has already resumed.

## Maintainer tests

```powershell
node --experimental-strip-types --import ./test/setup.ts --test test/release.test.ts
npm test
```

Release tests use real local Git repositories and a local bare remote, with simulated npm, GitHub,
global install, and model services. They cover failed stages, resumed effects, lost Release responses,
fingerprint/digest drift, unrelated changes, version collisions, and process deadline cleanup. They
never publish a real version. Actual CLI smoke is a separate explicit command because it uses model
capacity and WSL credentials.
