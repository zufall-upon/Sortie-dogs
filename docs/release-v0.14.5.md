# v0.14.5 — Reviewer test organization and unborn Git proof

- Organize Reviewer correction coverage by lifecycle/self-recheck, continuation, scope, validation and permissions (#295). Retain all 209 original cases and all 81 byte-identical registration blocks; add one fixture-isolation regression. Share only plain committed Git inputs, not Mission state, native history, ledgers or plugin instances.
- Serial local observation: 209 cases in 107.027 s before; 210 cases in 101.358 s after (5.669 s / 5.3% lower). This is one before/after observation, not a statistical or full-suite speed claim. The main benefit is focused execution and smaller, purpose-specific files; no test deletion or production cache.
- Observe fresh Git-only Docker workspaces before their first commit (#294). Only an absent symbolic HEAD target permits the repository-format empty-tree comparison. Existing/broken refs and failed observations remain unavailable. No initial commit, Git identity, task dependency installation or object write is required.

## Review and retained work

Collect PR bodies, ordinary comments, review bodies and inline comments before integration. PR #294 returned no concrete external code finding; automated review was unavailable because of usage limits. PR #295 returned no existing review body, inline finding or ordinary comment at integration. CI success and unavailable review are not independent PASS.

The current all-PR release instruction authorizes integrating the retained, previously paused #294 change. It does not resume the prior benchmark campaign, replay trials/grades, alter holds or increase its budget. Existing findings, measured spend and unknown usage remain retained.

## Release verification

Fix the integrated `main` commit and one tarball before candidate preflight and `npm run test:full`. Check fixed-commit Windows CI and real native Worker startup/model identity. Use the same tarball for both npm global prefixes, the OpenCode config-local package, GitHub Release and npm publication. Command/exit/timing receipts, original and final test logs, review dispositions, hashes and inference costs remain under `_testenv/releases/0.14.5/`.

Mission marker: `0.14.5-unborn-proof-v1`. Codex skill marker: `0.13.11-codex-skill-v2`. Restart OpenCode after global apply and verify the loaded runtime. Worker startup is distinct from Mission completion and official scoring.
