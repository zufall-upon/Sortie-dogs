# Worktree parallel RPT audit

Observed 2026-08-14 for the unshipped 0.5.0 development line.

## Completed evidence

- `npm test`: 433 tests passed after the dogfood bootstrap and bounded review-retry fixes.
- Windows focused integration queue: 18 tests passed after the final durable failure-state fixes.
- `npm pack --pack-destination .\_testenv`: `sortie-dogs-0.5.0.tgz` created.
- Package SHA-256: `01EB1AD8DBC6B5553CF6BD60A16DD6486CD931EFA0C077DED4AD27401D030A19`.
- WSL OpenCode CLI: version `1.18.11` resolved from the approved CLI path.
- Fresh `_testenv/card08-wsl` install and packed CLI initialization completed with runtime asset marker
  `0.3.17-parallel-conflict-remediation-v1`.
- Fresh-project `opencode debug config` resolved `/sortie` to `dog-coordinator` and loaded the installed
  dog agent set.
- A fresh packed-plugin WSL `/sortie` run reached terminal `DONE`: one scoped worker changed only
  `alpha.txt` and `beta.txt`, and `git diff --check` passed.
- The Windows 11 guest at its current address accepted the same tarball, matched its SHA-256, initialized
  the project assets, and reported OpenCode Desktop version `1.18.13`.

## Missing evidence

- No same-task serial and parallel model-run fixture exists, so duration, tokens, cost, steps, children,
  cache ratio, validation errors, and reviewer errors cannot be compared under identical conditions.
- The workflow audit script selected a zero-token session outside the candidate run. Its output is invalid
  for efficiency comparison and is not used as a baseline.
- Interactive Desktop restart and terminal `/sortie` workflow evidence remains unavailable; SSH package
  installation and asset verification do not prove the GUI path.
- The deterministic fixture has a clean serial WSL result, but no matching parallel model run yet.

## Decision

Normal serial `/sortie` is ready for dogfooding with the packed 0.5.0 candidate. Parallel worktree execution
remains explicit opt-in because same-task parallel efficiency and interactive Desktop evidence are incomplete.
Revisit the parallel default only after the deterministic fixture passes the matching parallel WSL run and
the Windows Desktop acceptance path.
