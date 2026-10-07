# Codex Windows Mission / native Luna Fast follow-up (2026-10-07)

This is an unreleased PR fix on `fix/codex-windows-luna-fast`, based on
`19dea05` / published Sortie-dogs 0.13.9. It is not a new Anko score or proof that
the installed 0.13.9 package already contains these changes.

## Changes

- Natural-language Windows Missions use existing PowerShell 7, with optional
  `--trusted-pwsh` / SDK `trustedPowerShellExecutable`. The compatibility tool
  remains named `bash`. Source is passed literally in argv, followed by a fixed
  host-owned failure-exit trailer; POSIX retains `/bin/bash -c`.
- Only the Codex adapter translates `openai/gpt-6-luna-fast#max` to native
  `gpt-6-luna`, effort `max`, service tier `priority` (Fast). Shared OpenCode role
  assets are unchanged. Operator, Coordinator and Reviewer retain Sol 6.1/xhigh.
- Native start/resume responses retain model, effort and separate service tier.
  Null/default observations clear stale settings. Shared Task routing is
  normalized before every native turn. Model/effort overrides do not implicitly
  change the independent speed setting. CLI progress exposes the routed values.
- Windows recovery records platform identity. An absent recorded Windows PID
  can release its stale metadata lock; live/reused PIDs, access denial, legacy
  unidentified owners and unresolved native execution remain non-replayable.
  Linux process-start identity and legacy Linux lock markers remain supported.
- Manifest settlement recognizes the observed Codex 0.162 `-NoProfile -Command`
  envelope only for the exact trusted PowerShell path. Failure exits, raw
  command identity and protected-evidence requirements remain unchanged.
- Packaged Skill marker is `0.13.9-codex-skill-v2`. Windows natural-language
  requests now select full Mission orchestration; `codex run` is an explicit
  single-task option, not a substitute for multi-role execution.

No second ledger, OpenCode initialization, global package/Skill update, native
permission widening, unrelated-process termination or package publication.
Only the fix branch is pushed for the user-requested PR; no merge or release.
Manifest settlement remains post-execution observation, not a pre-execution guard.

## Autonomy / efficiency / visibility review

The user requested an explicit check for unnecessary security mechanisms before
opening the PR. The changed runtime paths, packaged Skill and inherited approval/
recovery behavior were inspected together.

- Autonomy: Windows natural-language requests now enter the same Mission as
  POSIX without first deriving a single-task manifest. PowerShell resolves
  automatically. A mandatory Skill-side shell lookup/pinning step duplicated
  that resolution, so it was removed; exact pinning remains optional. No new
  approval callback, permission profile, scope ledger or host policy is added.
- Efficiency: model alias translation and model-route progress are local, with
  no extra model call, catalog query or preflight on the execution path. Windows
  owner recovery removes a dead adapter's metadata lock instead of adding a new
  lease/retry controller. Existing Linux lock identity remains compatible.
- Visibility: progress separates the requested native model, reasoning effort
  and Fast tier. A review found that a native resume default could fall back to
  stale `thread/read` speed/effort; null observations now remain distinguishable
  from absent fields, and a regression test covers the same-root continuation.
  Native shell failures and real acceptance evidence remain separate outcomes.

Exact executable selection is an optional shell contract, not a new permission
gate. Existing scope/evidence checks and unresolved-execution reconciliation are
retained to avoid false completion or duplicate work; no new security framework
is introduced. The inherited CLI lacks an interactive native approval bridge;
SDK host callbacks remain available. The independent native sandbox startup
error is still an environment blocker, not a new Sortie restriction.

## Verification

Common npm tests are WSL-only. Windows common tests are not a fallback when WSL
is unavailable. The user restored the standard Linux Node 22.14.0 / npm 10.9.2
runtime; the invocation-local auxiliary runtime shim is no longer used.

- Earlier auxiliary-WSL related tests: 99/99 passed. Its full run failed at the
  Linux snapshot-helper meta-test's 30-second timeout; this was not counted as success.
- Restored-WSL related tests: 105/106 passed. The remaining failure was the
  Node 22.14 type-stripping feature banner in the Skill CLI fixture's stderr.
  That fixture now suppresses only `ExperimentalWarning` for its child CLI.
- Pre-review normal-WSL `npm run test:full`: exit 0, all 115 files completed, valid
  scheduler coverage with no missing/duplicate file transitions. Total 308,237 ms.
  Snapshot SHA-256:
  `58eb5dbbadaaf70b4d159f20c0f24b23a2e51cde9f98740d259423d9eccb0bab`.
  Logs: `_testenv/wsl-1791352099318-13640/`.
- Before the WSL-only instruction, the supplementary native Mission/shell/
  recovery run passed 30 tests, including real PowerShell literal/Unicode/path
  handling, failure exits, shared Mission acceptance and killed-owner recovery.
  It was already finished when its stop check ran. It is not the WSL npm gate.
- Skill validation: `Skill is valid!`. `git diff --check`: passed.
- Pre-review native Windows-only `npm run test:windows`: exit 0, 17/17 tests
  passed; build 12,009 ms and test phase 4,165 ms. The user confirmed common
  tests run in WSL, with only Windows-specific tests as native supplements.
- Post-review final candidate `npm run test:full`: normal WSL, exit 0, all
  115/115 files completed, coverage valid, no missing/duplicate transitions.
  Total 307,301 ms; build 10,340 ms, test phase 291,894 ms. Snapshot SHA-256:
  `d8818a8f8e1a874db5615d6e2b1099982b3220255e42c4c1e5c6b518e525e365`.
  Logs: `_testenv/wsl-1791353472150-40408/`.
- Post-review final candidate `npm run test:windows`: native Windows-only,
  exit 0, 17/17 passed; build 12,076 ms, test phase 7,194 ms. Both final
  repository test gates passed. Actual native Worker execution remains
  unverified; this is not a release or successful Anko benchmark claim.

The final snapshot hash predates only the final evidence update to this summary;
no executable source changed after verification. The same snapshot excluding
this summary has SHA-256
`2765ce34787d9f39e19e09d654ff281ffedf72ae5780e12470b3800abec5aec8`,
checked against the worktree before commit. Raw logs and native probes are retained outside
Git in `M:/_work/_Sortie-dogs-artifacts/records/codex-windows-luna-fast/20261007/`.

## Native / Anko boundary

Existing Codex 0.162.0-alpha.2 with ChatGPT/Pro authentication accepted an
ephemeral model-free thread route `gpt-6-luna` + `priority`. The generated local
protocol schema supports separate thread/turn service-tier fields. This proves
native route acceptance, not execution of an actual Luna Worker turn.

The patched PowerShell command was then preflighted at the preserved Anko clone
without any permission override, model turn or Mission arm. It still failed:

```text
windows sandbox: helper_unknown_error: setup refresh had errors
```

The existing native sandbox log identifies runtime ACL setup failing on an
in-use `node_repl.exe`. No unrelated Codex processes were stopped. Only the
same Codex executable is currently available; the older alternate path is absent.

The Anko clone remains clean on its fixed base, with prior failed-arm evidence
preserved. New model turns: 0; new Mission arms: 0; new benchmark score: unavailable.
Actual Worker execution, completed Anko implementation and performance comparison
remain unverified until the independent native sandbox startup blocker is resolved.
