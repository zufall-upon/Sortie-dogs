# v0.13.9 — Codex Mission entrypoints and operation recovery

- Publish the previously unreleased Codex app-server integration and PRs #163–#166. Native saved threads, CLI `codex mission` / `codex run`, and public SDK entrypoints reuse the existing Mission, Operator, validation, correction and acceptance lifecycle; OpenCode configuration and authentication remain separate.
- Preserve explicit model, effort, native permissions and effective working-directory choices. Forward host approvals and explicitly authorized parent command execution without automatic permission widening. Keep unknown external execution unknown after interruption; resume only exact recoverable native bindings and outcomes.
- Ship the explicit-only `$sortie-dogs` Codex skill in the npm package. `sortie-dogs codex init [project-root]` installs it without modifying `.opencode`. POSIX uses the natural-language Mission route; Windows retains the documented bounded `codex run` observation boundary.
- Restore Reviewer correction for operations with an existing write scope, including same-author recovery after reload. Retain original execution observations: correction alone neither reruns an operation nor establishes its success. Author self-recheck is not independent PASS.
- Reconcile native and plugin-hook tool terminals, reject delayed starts of completed executions, and avoid applying an old idle observation to a new execution. Completion, continuation, settlement and offline cost summaries use the same latest-turn interpretation; known subtotals and unavailable totals remain distinct.
- Include reusable Anko benchmark observation/recovery helpers and regressions. Generated environments, native histories and raw benchmark data are not distributed in the npm package.

## Evidence and limits

- Release evidence is retained under `_testenv/releases/0.13.9/`: fixed commit/package hashes, candidate preflight, mandatory full Linux suite, fixed-commit Windows CI, native OpenCode Worker startup/model observation, installed bytes/assets and publication receipts.
- CLI qualification is actual Worker startup and actual model identity only. It does not claim a completed Mission, Reviewer PASS, or a new SWE-bench result. No additional SWE-bench campaign is part of this release.
- Earlier real Ubuntu Codex implementation → failed validation → correction → independent Review PASS → Operator acceptance is recorded in [the Codex acceptance record](codex-mission-acceptance-20261006.md). That small authorized mixed-executor scenario is not universal native sandbox compatibility or a general quality/performance benchmark. Native subprocess restrictions, unknown external work and Windows live/desktop qualification remain explicit boundaries.
- Native Codex subscription token usage is not a monetary charge or remaining allowance. Unpriced OpenCode requests are retained as unknown, not counted as zero.

The default runtime profile and compatibility names remain `v010`. Mission marker: `0.13.9-codex-operation-v1`; Codex skill marker: `0.13.9-codex-skill-v1`. Global application includes the config-local bridge dependency as well as npm-global installations. Completely restart OpenCode after application to confirm its loaded version; an installed marker alone is not reload proof.
