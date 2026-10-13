# Cycle050: native validation command text bounds

## Change and retained regression

Native validation-budget admission now uses the existing shared 8192-character
command text bound instead of the unrelated 4096-character identifier bound.
Identifiers, execution ownership, evidence identity, deduplication, marginal-value
checks, budgets, acceptance and stop conditions are unchanged.

The retained Cycle049 command is 4073 characters before canonical quoting and
4510 afterward. Its unchanged request previously returned `DENY: invalid-contract`
and now returns `ALLOW`. Its evidence identity is unchanged; passed duplicates
still skip, unsettled duplicates deny, exhausted budgets deny and wrong owners deny.
This is an admission regression check, not a replay of the old practical task.

- Initial targeted validation/command/goal/ledger/retry checks: 65 passed, exit 0.
- Added long-command native host/setup-repair check: 1 passed, exit 0. The original
  Worker, command identity and budget survive the real failed-process/setup-repair path.
- Source CLI follow-up: 49 passed, exit 0. The first full run exposed a `.js`
  import that Node could not resolve when executing the TypeScript CLI directly.
  Using the existing `.ts` source import convention preserves compiled `.js` output.
- Corrected integration candidate, `npm run test:full`: exit 0, 1961 passed,
  2 skipped, 0 failed; 122 files, no duplicate or missing executions, 308.037 seconds.
  The failed initial full run is retained; only its diagnosed import failure prompted
  this rerun. Frozen runner/compiled module hashes and package bytes remain identical.
- Candidate source: `df6fa3b`, based on main `d11efff`; the import correction is
  an integration follow-up, not another inference attempt.
- Frozen development package: version `0.13.17`, marker
  `0.13.17-handoff-continuity-v1`, SHA-256
  `43df42e923eb8737c4a610ebe0556a17e66337179c046a90adc64a96056146c9`.
  This is not the published archive with the same version/name.

## Independent outcomes

- `sqlfluff__sqlfluff-1763`: pass@1, one slot, $2 reservation,
  `official-image-testbed`, 2400-second hard maximum with native staged stopping.
  Inference exited 0 after 575.327 seconds, with a frozen 4268-byte patch;
  API-equivalent priced usage $0.97595, complete usage reported by the supervisor.
- One official dev scoring execution, one worker, zero retries: **0/1 resolved**,
  resolved IDs `[]`. Patch applied, three new-behavior failures, 66 passing tests,
  no reported infrastructure failure. This is not a score improvement over Cycle049.
- Actual initial single-case Operator and Coordinator observations used
  `openai/gpt-6.1-sol#xhigh`. The runner cleaned its isolated database on normal
  termination; retain its immutable replay and initial actual observations rather
  than inventing complete descendant-model coverage. No matching actual
  `dog-worker-v010`/`openai/gpt-6-luna-fast#max` observation is available for this candidate.
  Execution/model differences qualify comparisons, not the official result.
- The separately reserved complete-mode practical task used the same frozen archive
  and real repository/base `a10057635e5b2559293a676486f0b730981f037a`.
  Coordinator-direct implementation and Reviewer used `openai/gpt-6.1-sol#xhigh`.
  Original task hash, source patch, native shell checks, Mission and receipt are retained.
- The actual dbt/PostgreSQL-templater public fix command accepted proposed fixes,
  produced the expected encoding failure notice and preserved all 523 original bytes.
  Final native validation exited 0: 137 passed; Black and `git diff --check` passed.
  The live reproduction command was 3719 characters, below the old identifier bound;
  it does not independently demonstrate the saved 4510-character regression.
- Native Mission completed and receipt succeeded. Original CLI exit is 0, but
  the probe stopped at its cost cap after 1423.706 seconds; priced API-equivalent
  usage $2.01070880 and one unpriced request were recorded.
  `accepted=false`, `native_completed=false`, `worker_model_observed=false` remain
  unchanged. Native Mission completion is not strict probe acceptance.

## Integration and next measurement

Integrate the verified command-bound usability correction, not a claimed successful
benchmark candidate. Keep the retained full23 score of 9/23. Do not replay either
consumed task, expand to full23, claim completed-main-cycle verification, or release,
tag, publish or globally apply this development archive.

The practical history also retains a validation-binding detour after passing checks:
`mission-review-correction-validation-binding-unavailable` caused another same-session
validation pass before native acceptance. Diagnose that retained event and its recorded
freshness/inputs before another separately reserved changed-candidate attempt; do not
weaken acceptance or add a validation-only Worker solely to avoid it.

Raw artifacts remain outside Git under
`/home/user/Sortie-dogs/_testenv/autodev/sortie-dogs-dev23/cycle-050/`:
`frozen-candidate.json`, `retained-command-comparison.json`, targeted/full-validation
logs, `single-case/supervisor-state.json`, its native replay,
`single-official-scoring/scoring-state.json`, `official-stage-diagnosis.json`,
`practical/smoke-1/observation.json`, `practical/task-evidence.json`,
`practical/native-history.json`, `practical/native-terminal/`, and
`native-terminal-evidence.json`.
