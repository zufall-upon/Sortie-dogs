# Windows test commands

- `npm test` and `npm run test:full` send the current tracked and nonignored untracked working-tree bytes to WSL Ubuntu, including unstaged edits and deletions. Build and common tests run in a new directory under `~/.cache/sortie-dogs-tests`, never under `/mnt`.
- WSL login Bash needs Node >=22.6, npm and git. Set `SORTIE_WSL_DISTRO` to select another distribution.
- `npm ci` then `npm run test:windows` builds locally and runs the small Windows-only suite. The common full runner excludes `test/windows/`.
- Complete Windows validation requires both `npm run test:full` and `npm run test:windows`, run sequentially against the same source. Finish edits before starting; changes made during a run require a new snapshot.
- Each WSL run has independent source, generated output and dependencies. A Linux-only dependency cache is keyed by package-lock bytes and Node/npm versions. The host `.git`, `node_modules`, `dist` and `_testenv` are not transferred. A fresh empty Git repository supports tests that discover their enclosing checkout.
- `_testenv/wsl-*/source.json`, `stdout.log`, `stderr.log` and `result.json` retain source SHA-256 and exit evidence. Ctrl+C closes the ownership pipe; Linux cleanup terminates only that run's descendants. Abrupt host termination is also detected by pipe EOF or heartbeat expiry.
- The durable PowerShell controller allows 2400 seconds including setup (the full runner retains its 1790-second budget). Cancellation first requests Linux cleanup, then uses bounded Windows process-tree cleanup if needed. It never shuts down WSL globally.
- Native Ubuntu test, build and release commands remain native.
