# v0.13.21 — recover observed Mission operations without replay

Integrates PR #250 and its existing-review follow-up while preserving the source commits, native evidence and existing ledgers.

- Match admitted operation commands across the supported PowerShell error-action envelope and absolute Node/script/input path spelling. Preserve pinned executable identity, shell suffix boundaries, literal options/URLs and opaque relative or POSIX-looking route arguments. Two drive/UNC absolute positional arguments use Windows case/separator identity.
- Recover the same admitted native shell call through existing Mission APIs, retaining owner session, call ID, working directory, native start/end, actual process exit and classified outcome. Reuse the write gate's existing shell-tool predicate for live and saved PowerShell/pwsh/suffixed spellings; do not introduce a permission or validation route.
- Bound history recovery to the current native admission/correction window. Retain conflicts, native timestamp provenance and the latest conflicting start across reordered or partial history. Do not replace a newer unknown/failed/running observation with an older success or overwrite a concurrently completed/cancelled Mission.
- Missing, invalid or unavailable history yields actionable `recovery-unavailable` diagnostics. Observed missing or contradictory terminal evidence yields `recovery-blocked`, not `not-started`; retain a terminal call lacking end time without inventing an outcome. Status and ready/blocked submissions instruct inspecting that same call and explicitly prohibit operation replay. Explicit `NO_START`, known process outcomes and running calls remain distinct.
- Execution observation is not validation or Mission acceptance. Do not rerun an already-consumed operation, rewrite old ledgers, replace a campaign candidate, reset budget or automatically restart an active user service.

## Existing review disposition

All existing PR #250 body, ordinary/review and inline comments were collected. The 16 findings are valid: 13 already corrected in retained source commits; three remaining findings corrected before release integration:

- [Windows absolute arguments](https://github.com/zufall-upon/Sortie-dogs/pull/250#discussion_r4266702436): normalized drive/UNC identity, with different-path and literal-value controls.
- [PowerShell tool observations](https://github.com/zufall-upon/Sortie-dogs/pull/250#discussion_r4266702438): shared supported shell-tool predicate for admission, terminal observation and saved history.
- [Unknown execution result](https://github.com/zufall-upon/Sortie-dogs/pull/250#discussion_r4266816127): `recovery-blocked` with explicit no-replay guidance across public result routes, including missing terminal times.

Ten same-condition regressions failed before repair. The related six-file check passed 134 tests and exposed five missing blocked-submission no-replay instructions plus one packet fixture omission. After those corrections, only the affected six-test scope was rerun: 6/6 passed. Retain those original receipts until the mandatory integrated fixed-candidate full. The public shell fixtures use disposable real Node results; they do not claim an actual PowerShell process ran on Ubuntu. No extra model-review request or approval wait.

## Verification boundaries

Freeze one integrated `main` commit and one tarball before candidate preflight, mandatory Linux full, native Windows CI and one actual Worker startup/model check. Apply that same tarball to both existing npm global prefixes and the OpenCode config-local package, attach it to GitHub Release and publish once. No new SWE-bench/Anko evaluation or old product/campaign replay is part of this release.

Mission marker: `0.13.21-operation-recovery-v1`; unchanged Codex skill marker: `0.13.11-codex-skill-v2`. Installed bytes and isolated startup do not prove an already-running user service loaded the new code. Complete OpenCode restart remains manual; original Location-only recovery override retirement, saved configuration, authentication, conversations and product ledger remain separate and preserved.
