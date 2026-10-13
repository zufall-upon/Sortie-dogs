# Cycle054: preserve interrupted CLI probe evidence

## Retained task and failure path

- Work identity: `sqlfluff__sqlfluff-1763/controller-interruption`.
- Base: released v0.13.18, main `08fc0cc9164300597d4f3eb85d8424b1785a2379`.
- Cycle053's SQLfluff task completed natively after its controller disappeared:
  Mission completed, succeeded receipt, 136 local tests passing, original 523 bytes
  preserved. Its original controller exit/signal remains unknown.
- The candidate runtime was not qualified: the shared global plugin was active,
  while the candidate reported `Duplicate plugin ID: sortie-dogs.v010`.
  Neither historical task completion nor the compact-packet projection proves
  candidate runtime improvement. The existing Cycle053 change and staged diagnosis
  remain preserved in their original worktree.

The smallest reproducible controller failure is a SIGINT/SIGTERM during the
existing practical probe monitor, including after root CLI exit while native
descendants are still pending. Before the fix, the controller died without
persisting observation/logs and left its detached owned server running. Two
real-signal regression tests reproduced this failure (exit 1, 11.382 seconds
including build); this does not establish Cycle053's exact original signal.

## Minimal correction

`scripts/mission-cli-probe.mjs` retains its existing monitor as a testable function.
SIGINT/SIGTERM now stop the owned CLI/server, preserve the original CLI exit and
its signal separately, record `controller-interrupted` and `controller_signal`,
then persist final usage, logs and observations before removing handlers.
Repeated signals during persistence cannot truncate evidence. Existing budget,
timeout and acceptance conditions remain authoritative; no new Mission, prompt,
Worker, review or acceptance is manufactured. Interval read failures also clean
up the owned processes before propagating the observation error.

## Evidence and limits

- Targeted monitor/settlement tests: 22 passing, exit 0, 1.190 seconds, reusing the
  unchanged build. The added cases cover active execution, root-close/native wait,
  repeated signals during persistence, exact owned-process cleanup, final cost,
  no invented Worker coverage and removal of signal handlers.
- Service-only confirmation: actual OpenCode v2.0.26 `serve --service`, controller
  SIGTERM during native-wait replay, owned server/CLI stopped, interrupted
  observation saved; 0.680 seconds. The CLI is a Node process surrogate, and
  models/cost are retained Cycle053 projections, not a new inference result.
- No model requests, no paid SQLfluff replay, no official score change, no shared
  host restart, no global installation, tag, release or publication.
- Raw receipts/logs/source hashes: canonical `_testenv/autodev/sortie-dogs-dev23/cycle-054/`
  (`signal-baseline.json`, `signal-final-targeted-validation.json`,
  `native-service-signal-check.json`). Raw evidence is not committed.
- Full integration validation: `npm run test:full`, exit 0, 315.911 seconds;
  2,005 passed, 2 skipped, 0 failed across 122 files. Recorded in
  `signal-full-validation.json`. This is regression validation, not task success.

This establishes controlled interruption handling, not completion of a new
development task or improved benchmark correctness. SIGKILL/host loss cannot run
cleanup handlers; restart recovery and duplicate-plugin/runtime isolation remain
separate next work. First reuse retained histories and a no-model location fixture;
reserve an immutable new task only if a paid runtime comparison is necessary.
