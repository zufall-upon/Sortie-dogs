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
  repository test gates passed. Actual native Worker execution had not yet been
  checked at this stage; the later authorized host-executor trial is recorded below.

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

At initial PR opening, the earlier Anko clone remained clean on its fixed base,
with prior failed-arm evidence preserved. That preflight had no new model turns
or Mission arms and no benchmark score. Native command execution is still blocked.
The subsequent explicitly authorized parent-host executor trial below does not
repair or prove the native Windows sandbox.

## PR #169: actual Anko Mission with authorized parent execution

The user explicitly approved the existing SDK's parent-host command executor
after model-free native preflights continued to fail and no WSL Codex executable
was available. Models, threads and turns remained native Codex with existing
ChatGPT authentication. Exact post-hook commands used the parent host's current
permissions; no native profile, global configuration or installed Skill changed.

- Source: PR #169 commit
  `4ac8fd5f58ebbc160b86fd1d4ea580639164ea37`.
- Fixed package SHA-256:
  `cf43d9664c7da46adb76eeecdcecd3b43d51ff0c280676fd5fc841647baf6ba3`.
- Fresh isolated Anko base:
  `3f269a72ff69398b1250c584171f32d12c0d8085`.
  Original 1,825-byte task SHA-256:
  `96c0c7ad98237d6176034c8893d8bff164ec5fda45889e51780a65cf599ffcfe`.
- Skill v2's normal full Mission route was followed. No user-derived single-task
  manifest, OpenCode initialization or second ledger was introduced.
- Root: `01a11519-58cc-7142-b7c3-e800a7aee0b3`.
  Worker: `01a11519-d8e4-7a50-a539-89620ad0ea23`, observed native
  `gpt-6-luna`, turn effort `max`, service tier `priority`.
  Operator and independent Reviewer used `gpt-6.1-sol` / `xhigh`.
- Result: native turn `completed`, shared Mission `completed`,
  `sortie_v010_complete_mission` returned `succeeded`, SDK `accepted: true`.
  Elapsed 1,646,173 ms (27m26s); three native turns across three threads;
  189/189 host commands terminal, adapter owner closed, commands drained.
- Worker committed `46cdc237246ffb1f6e7556c0f1279e38905914b8`.
  Reviewer reproduced and corrected five Medium defects, reran focused and exact
  formal validation, committed
  `369e870ca6ec0d88397b8ad3652ec8aa19d6b821`, and completed an actual native
  `SELF_RECHECKED` terminal. Both commits remain local to the isolated Anko clone.
- Formal root check was exactly `& ".benchmark/validate.ps1"` using the reused
  offline WSL Go 1.27.1 toolchain. No dependency or tool was installed.
  Baseline initially needed its fixture-local GOPATH/bin directory; it passed
  after that setup correction, before model execution.
- Native cumulative usage: 12,311,739 total tokens, including 11,686,912 cached
  input tokens, 512,205 uncached input tokens and 112,622 output tokens.
  These are usage observations, not metered API charges. USD cost is unknown/null.
  No official hidden grading was configured; acceptance is not an official score
  or a directly comparable performance claim against earlier execution routes.

Before the successful run, an audit-wrapper startup mistake produced zero model
turns and zero Mission arms; its record is preserved separately. The old failed
Anko trial was neither overwritten nor resumed as this new clone.

Raw conditions, native routes/events, real command results, result, usage and
terminal shared state are retained outside Git at:
`M:/_work/_Sortie-dogs-artifacts/records/anko-codex/pr169-20261007/`.

## Observed efficiency fix and verification

The real run exposed two avoidable transport problems:

- The Codex read tool supported files but not directory discovery. The Reviewer
  made 25 unsuccessful filename guesses. Existing read now lists sorted direct
  directory entries, marking subdirectories with a trailing slash; file reads
  retain their exact UTF-8 bytes. No new tool, gate, approval or ledger is added.
- Native apply_patch still used the broken native sandbox even when Mission
  commands used the parent executor. The Worker recovered using Mission write.
  Host-executor instructions now explain that distinction, and tool descriptions
  accurately say configured executor instead of claiming native sandbox execution.

The Anko package was not changed while running. This follow-up was built and
verified as a separate fixed candidate:

- WSL related tests: 49/49 passed, exit 0. Snapshot
  `6edcd33ab53a652f900cc9ae100788b072e8ba5b76ac7912facbb6e8ace62038`.
- WSL full tests: 115/115 files completed, exit 0, scheduler coverage valid with
  no missing or duplicate transitions. Total 286,090 ms; build 10,028 ms,
  test phase 270,505 ms. Snapshot
  `71f4e980eb43ed5f6151f945af7d9895e0eaf36a00cc7ce32461d80e279e6bba`.
  Logs: `_testenv/wsl-1791356620895-27820/`.
- Native Windows-only tests: 17/17 passed, exit 0; build 11,155 ms,
  test phase 8,031 ms.
- Separate actual Codex read-only probe:
  `01a11536-064f-7e50-8a9a-becb60df7f82`, Sol 6.1/xhigh, 24,632 ms.
  Two real host read operations discovered the directory and read the exact
  marker contents; no filename guesses, shell commands, writes or Mission arm.
  Probe verified true; SDK acceptance deliberately false for read-only inspection.
  This is not a second Anko benchmark.
- Follow-up package SHA-256:
  `964a6a8a9799f5218aa60d126cfae438d847e9d3e0a28f7198dd2f783ec542d8`.
  The post-test source snapshot excluding only this evidence summary is
  `cbe9fcf374b12f45700406e6b41cb728bd61240cd7926ae6d511f519730a1ad0`.

Autonomy improves through an existing read capability rather than new permission
steps. Efficiency avoids blind filename retries and explains the correct editing
route without extra model calls or preflights on the runtime path. Visibility
retains actual model/tier, command exits, review repair and final receipt. Existing
scope, protected evidence and host authorization are unchanged. Native sandbox
repair, global installation, merge, publication and release remain out of scope.
