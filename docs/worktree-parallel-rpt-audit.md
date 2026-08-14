# Worktree parallel RPT audit

Observed 2026-08-14 for the unshipped 0.5.0 development line.

## Completed evidence

- `npm test`: 429 tests passed in the final full Card 07 run.
- Windows focused integration queue: 18 tests passed after the final durable failure-state fixes.
- `npm pack --pack-destination .\_testenv`: `sortie-dogs-0.5.0.tgz` created.
- Package SHA-256: `E1C9251D31B61C88E501EB8873F627C2BAFE1AEFE6038180841C6577B61D0374`.
- WSL OpenCode CLI: version `1.18.11` resolved from the approved CLI path.
- Fresh `_testenv/card08-wsl` install and packed CLI initialization completed with runtime asset marker
  `0.3.17-parallel-conflict-remediation-v1`.
- Fresh-project `opencode debug config` resolved `/sortie` to `dog-coordinator` and loaded the installed
  dog agent set.

## Missing evidence

- No same-task serial and parallel model-run fixture exists, so duration, tokens, cost, steps, children,
  cache ratio, validation errors, and reviewer errors cannot be compared under identical conditions.
- The workflow audit script selected a zero-token session outside the candidate run. Its output is invalid
  for efficiency comparison and is not used as a baseline.
- The approved Windows Desktop VM was unreachable on its configured SSH address. Desktop installation,
  restart, conflict, and terminal workflow evidence remains unavailable.
- No clean model E2E was run because the required deterministic task/model/validation fixture is absent.

## Decision

Parallel worktree execution remains explicit opt-in. The current evidence proves unit/integration behavior,
package loading, and WSL configuration resolution, but does not justify enabling parallel execution by
default. Revisit the decision only after one deterministic fixture passes serial and parallel WSL runs plus
the Windows Desktop acceptance path.
