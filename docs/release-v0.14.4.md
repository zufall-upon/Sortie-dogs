# v0.14.4 — Docker candidate reads and Worker dispatch

- Accept a different Worker display description when the exact Task reference, agent, owner and continuation identity still match. The child receives the retained canonical Task; special repair dispatch keeps exact matching (#289).
- Preserve declared Docker CWD aliases while binding their physical execution directory; retain discovered Git roots without HEAD and preserve actual root-path whitespace (#282, #287).
- Bind Git-only candidate proof to actual file bytes and metadata, including ignored inputs, executable modes, symlink referents and working bytes hidden by Git index flags. Observation failures cannot yield partial proof (#283, #284, #288, #292).
- Inspect the regular-file referents already captured through candidate-local links. Preserve entry association and the existing captured-input footprint (#290).
- Keep native read pages valid after JSON escaping and stream long logical lines with bounded excerpts and whole-file hashes. Git-only images use a fixed read transport when task Python is absent (#285, #286, #291).

## Review and retained work

PR bodies, ordinary comments, review bodies and inline comments for #282–#292 were collected. Automated Codex review was unavailable because of usage limits; no concrete external review body or inline finding was returned. Recorded same-PR self-review corrections and their final related checks remain retained. CI success and unavailable external review are not independent PASS.

The current all-PR release instruction authorizes #289 integration. Its [paused v0.14.3 campaign](frontier-clean30-v0143-20261017.md) remains historical: nine tasks started, six graded with two correct, three ungraded, zero completed Missions. Original findings, the consumed 38-unit Mission budget, unknown usage and holds remain intact. This release does not resume that campaign or claim an independent final Mission PASS.

## Release verification

Fix the integrated `main` commit and one tarball before candidate preflight and `npm run test:full`. Check fixed-commit Windows CI and real native Worker startup/model identity. Use the same tarball for both npm global prefixes, the OpenCode config-local package, GitHub Release and npm publication. Command/exit/timing receipts, review dispositions, hashes and inference costs remain under `_testenv/releases/0.14.4/`.

Mission marker: `0.14.4-docker-read-v1`. Codex skill marker: `0.13.11-codex-skill-v2`. Restart OpenCode after global apply and verify the loaded runtime. Worker startup is distinct from Mission completion and official scoring.
