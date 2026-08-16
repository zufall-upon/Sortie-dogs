# Worktree parallel RPT audit

Observed 2026-08-16 for the shipped 0.5.0 release line.

## Completed evidence

- `npm test`: 210 tests passed in the final 0.5.0 release worktree.
- Windows focused integration queue: 18 tests passed after the final durable failure-state fixes.
- `npm pack --pack-destination .\_testenv`: `sortie-dogs-0.5.0.tgz` created.
- Package SHA-256: `548A6E44C5E1323797C1F0910AE956454B981EE21B36C23E73A9FDB316C3A903`.
- WSL OpenCode CLI: version `1.18.11` resolved from the approved CLI path.
- Fresh `_testenv/card08-wsl` install and packed CLI initialization completed with runtime asset marker
  `0.3.33-readable-terminal-report-v1`.
- Fresh-project `opencode debug config` resolved `/sortie` to `dog-coordinator` and loaded the installed
  dog agent set.
- A fresh packed-plugin WSL `/sortie` run reached terminal `DONE`: one scoped worker changed only
  `alpha.txt` and `beta.txt`, and `git diff --check` passed.
- A matched release-asset serial fixture reached terminal `DONE` in `173889 ms`: the same two files
  changed and `git diff --check` exited `0`.
- The Windows 11 guest at its current address accepted the same tarball, matched its SHA-256, initialized
  the project assets, and reported OpenCode Desktop version `1.18.13`.

## Missing evidence

- The matched parallel fixture passed contract schema/semantic checks but coordinator activation and
  `sortie_prepare_parallel_dispatch` stopped before worker descriptors were returned. No worker, worktree,
  main, or shared-target mutation occurred, so no parallel duration is a valid comparison.
- Same-task tokens, cost, steps, children, cache ratio, validation errors, and reviewer errors remain
  unavailable. The workflow audit database reports the WSL sessions as zero-token and is not a valid source
  for this comparison.
- The workflow audit script selected a zero-token session outside the candidate run. Its output is invalid
  for efficiency comparison and is not used as a baseline.
- Interactive Desktop restart and terminal `/sortie` workflow evidence remains unavailable; SSH package
  installation and asset verification do not prove the GUI path.
- The deterministic fixture has a clean serial WSL result, but the matching parallel run remains blocked
  before dispatch.

## Decision

Normal serial `/sortie` is ready for dogfooding with the shipped 0.5.0 package. Parallel worktree execution
remains explicit opt-in because the matching parallel run stops before dispatch and interactive Desktop evidence
is incomplete.
Revisit the parallel default only after the deterministic fixture passes the matching parallel WSL run and
the Windows Desktop acceptance path.

## Single-worker comparison

- Matched three-run build-agent baseline: `23939 ms`, `25080 ms`, `27847 ms`; median `25080 ms`.
- Matched three-run serial `/sortie` lane: `155136 ms`, `173889 ms`, `198685 ms`; median `173889 ms`.
- Serial median is `6.933x` the build-agent median, so the `1.5x` acceptance target is not met.
- The serial lane completed all six runs with the declared two-file scope and `git diff --check` exit `0`.
  No fast-lane implementation change is justified by this audit alone; keep the target in Backlog.
