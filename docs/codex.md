# Codex integration

[README](../README.md) · [OpenCode configuration](configuration.md)

Sortie-dogs supports natural-language Codex Missions on POSIX and Windows through the official
Codex app-server stdio protocol. The adapter reuses the existing Mission lifecycle, evidence,
corrections and final Operator acceptance; it does not create a second Mission ledger.
The integration is implemented and real Missions have reached acceptance. Host-specific sandbox
restrictions remain operating boundaries, not a claim that the adapter is unfinished.

## Installation and invocation

Requirements: Node.js 22.6+, npm, and an existing Codex CLI signed in with ChatGPT. Sortie does not
install Codex, start a login flow, copy credentials or use a metered API fallback. Mission execution
refuses non-ChatGPT authentication. Recorded trials used Codex 0.160.1 on Ubuntu and
0.162.0-alpha.2 on Windows; these are observed versions, not a guarantee for every Codex release.

Install in the target project:

```sh
npm install --save-dev sortie-dogs@0.13.11
npx --no-install sortie-dogs codex init .
npx --no-install sortie-dogs codex mission --help
```

`codex init` installs only `.agents/skills/sortie-dogs`, preserving recognized ownership. It does not
create or edit `.opencode`. Do not run the OpenCode `sortie-dogs init` command for this route.
For an unpublished development candidate, a maintainer with checkout dependencies already present
can produce a local tarball with `npm pack` (build included) and install that tarball instead. Keep
CLI and SDK versions aligned.

Restart Codex or open the project in a new chat, then explicitly invoke:

```text
$sortie-dogs Implement and verify the requested change
```

This is direct Skills syntax, not an exact `/sortie-dogs` custom slash command. `/skills` opens the
skill picker. The skill is explicit-only so child Mission turns do not recursively start another
Sortie Mission. It invokes the same natural-language route on both platforms:

```sh
npx --no-install sortie-dogs codex mission --prompt "Implement and review the requested change"
```

## Mission SDK

```ts
import { CodexMissionSession } from "sortie-dogs";

const mission = await CodexMissionSession.create({
  projectRoot: process.cwd(),
  // Leave model/effort unset to preserve packaged role defaults.
  // model: "gpt-6.1-sol", effort: "medium", // Explicit override for every role.
  // trustedPowerShellExecutable: "C:/Program Files/PowerShell/7/pwsh.exe", // Windows, optional.
  // resumeThreadID: "saved-root-thread-id", // Continue the same Mission.
});
try {
  const result = await mission.run("Implement and review the requested change");
  console.log(JSON.stringify(result));
  process.exitCode = result.accepted ? 0 : 1;
} finally {
  await mission.close();
}
```

The session uses the shared Operator → Worker fast lane or Coordinator decomposition when needed,
followed by the existing validation, Review/correction and root acceptance. It runs saved native
Codex threads with existing authentication; no OpenCode settings are imported.

### Models and shells

- Operator, Coordinator, Reviewer and Advisor retain native Sol 6.1/xhigh defaults.
- The shared Luna-fast/max alias maps **only in Codex** to native `gpt-6-luna`, effort `max`,
  with separate `serviceTier: "priority"` (Fast). OpenCode routing is unchanged. Fast consumes
  subscription limits faster than Standard; it does not switch to a metered API.
- CLI `--model` and `--effort` override all roles explicitly. SDK `roleModels` overrides individual
  roles. Unsupported native model names fail rather than silently selecting another model;
  availability depends on the signed-in account.
- Commands use `/bin/bash` on POSIX or existing PowerShell 7 with
  `pwsh.exe -NoProfile -NonInteractive -Command` on Windows. The compatibility tool is named
  `bash` on both platforms, but Windows input must be PowerShell syntax.
- Optional SDK `trustedPowerShellExecutable` / CLI `--trusted-pwsh` pins an absolute existing
  PowerShell 7 executable. Automatic resolution needs no extra shell preflight.
- `workdir` may be absolute or project-relative. Both executors, progress and receipts retain the
  actual cwd. A check passing elsewhere does not satisfy validation declared for the project root.

### Native permissions and approval

Omitted permission settings retain the native host's defaults, which may be read-only. Sortie does
not select full access, replace host policy with a fixed network-disabled policy, or edit Codex
configuration. Thread turns retain native thread permissions; standalone `command/exec` uses the
server's configured policy, not a thread's temporary grant. Approval in a parent application is not
automatically transferred to a separately launched app-server.

SDK `permissions` / CLI `--permissions <native-profile>` explicitly selects an existing native
profile for thread start/resume and standalone commands. Invalid or disallowed profiles fail through
the native server without fallback. Profile APIs require `experimentalApi: true` for low-level
`CodexAppServerHost` callers; Mission sessions negotiate that capability already. This protocol
capability does not grant filesystem or network access.

SDK hosts may forward native command/file approval through `approval` and permission-subset
requests through `permissionsApproval`. Without callbacks, approvals are declined and permission
subsets receive an empty grant. Grants are limited to the native request; unsupported
server-initiated requests fail closed. The CLI reports requests but has **no interactive native
approval bridge**. Standalone `command/exec` has no thread-scoped approval API.

Native sandbox startup errors must be resolved at the host, not by silently widening permissions
or stopping unrelated Codex processes. The recorded Windows host-executor success does not prove
the native Windows sandbox setup failure is repaired.

### Existing parent-host executor

An application with an existing approval-aware executor can provide SDK `executeCommand`.
It receives exact post-hook argv, cwd, timeout, thread/turn/call identity and an AbortSignal for
Mission bash/read/write operations. The parent owns approval, execution and timeout enforcement;
Sortie adds no separate approval deadline, inferred prompt grant or permission store.

- Return `completed` only after execution ends, with real integer exitCode, stdout and stderr.
  Approval alone is not execution evidence.
- `denied` / `not-started` mean nothing ran and create no validation exit.
- `interrupted`, `unknown`, exceptions and invalid results preserve unknown execution and stop resends.
- Closing the adapter signals cancellation. Late results cannot establish validation; the host must
  reconcile any still-running process. A connected executor never falls back to native execution
  after rejection or failure. The CLI does not attach a parent executor.

File writes use short argv referencing a temporary UTF-8 payload, avoiding Windows command-line
limits for large files and literal quotes/newlines/NUL characters. Staging does not write the project
file; the configured executor performs the write and the payload is removed afterward. Read-only
`operator_status` observations can return while a child Task is active. Condition registration and
other modifying tools remain serialized; status is not Task completion.

## Progress, results and recovery

The CLI writes bounded progress to stderr: tool start/completion, command/cwd/exit, replan reasons,
next actions, child identity, native model/effort/service tier, effective permissions, selected executor
and public model commentary. Final JSON remains on stdout.

- Exit 0: Operator acceptance. Exit 1: incomplete work or execution error. Exit 2: invalid arguments.
  A completed native turn alone is not acceptance.
- For a run-once/result-collection request, a validated terminal failure may be the requested result.
  Mission acceptance preserves its native `execution-failed` outcome and nonzero operation exit;
  it does not make a failed benchmark successful. Success-required formal checks still apply.
- Usage is native thread cumulative usage, including earlier turns, not a Mission total. The Mission
  report uses observed per-turn deltas and execution times; cache/reasoning subtotals count once.
  Its pre-terminal snapshot excludes final-answer generation, while final JSON retains thread totals.
  Terminal accounting survives cold reload; missing baselines remain unavailable. Model-request
  counts, USD costs and remaining subscription allowance cannot be inferred from turn aggregates;
  monetary cost is `null`, not zero.

Use `--resume <root-thread-id>` for a saved Mission. Without it, a single unfinished root in the
repository is selected automatically; multiple unfinished roots require explicit selection. Resume
restores native messages and tool evidence, including children, without replaying completed commands.

Exact terminal parent thread/turn/call/input can recover a new Task stopped before child binding if
the old adapter closed cleanly or its Linux identity proves it is gone. Recovery retains the proof in
the existing Mission, serializes claims and reconciles the reservation before another model prompt.
For ordinary bound leaf Workers, the exact saved dispatch can match a single fully loaded completed
child turn. Later turns, nested Tasks, untracked children, missing bindings and ambiguous execution
remain unknown. Missing validation is a process defect, never an invented PASS; continue only the
work still needed for normal acceptance.

Windows may reclaim a stale adapter lock only when its recorded Windows PID is absent. Live/reused
PIDs, access denial, legacy owners without platform identity and unresolved execution remain unknown.
Linux process-start identity remains supported. SIGINT/SIGTERM closes the adapter and exits 130/143;
app-server exit or an interrupt acknowledgement does not prove an external command stopped.
Inspect the original executor before recovery. Do not delete Mission state to force a retry.

## Low-level app-server SDK

This is separate from selecting an OpenAI model through OpenCode. OpenCode model routing uses its
own host; `CodexAppServerHost` starts and observes native Codex threads and turns.

```ts
import { CodexAppServerHost, createCodexAppServerTransport } from "sortie-dogs";

const transport = createCodexAppServerTransport({ executable: "codex" });
const host = new CodexAppServerHost(transport);
try {
  const threadID = await host.startThread({ cwd: process.cwd(), ephemeral: true });
  const result = await host.runTurn(threadID, "Implement the admitted unit.", {
    cwd: process.cwd(),
    approvalPolicy: "unlessTrusted",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [process.cwd()],
      networkAccess: false,
    },
  });
  console.log(result);
} finally {
  await host.close();
}
```

The example explicitly requests a bounded native policy; it is not an adapter-imposed default.
The host observes completed Codex items and supports interruption and exact persisted-thread resume.
Ephemeral threads have no resumable rollout.

## Explicit manifest-bound route

For a caller-selected single-task workflow, use SDK `runCodexMission(...)` or:

```sh
sortie-dogs codex run --manifest operation-manifest.json --prompt "Implement the requested change"
```

An operation manifest is required. This route reuses the existing goal ledger, protected evidence,
settlement and repository-wide scope leases. It does not emulate OpenCode hooks, install Codex
assets, implicitly switch models or import host settings. Command/file events are post-execution
observations, not a pre-execution write guard. It is **not** the full natural-language Mission route.
Stdio is supported; experimental WebSocket transport is out of scope.

CLI SIGINT/SIGTERM requests interruption and app-server cleanup (exit 130/143); SDK callers may
pass `signal`. Cancellation before dispatch settles the reservation and releases the lease. After
dispatch, transport loss or app-server exit preserves unknown execution and stops lease heartbeats
without claiming external-process quiescence. SIGKILL can leave the same state. Lease expiry alone
does not authorize retry: subsequent manifest runs refuse with
`codex-mission-outcome-unknown:no-resend` and the ledger path, including across stable/v010 profiles.
Inspect the original worker and ledger; do not delete them or resend automatically.

## Completed Mission evidence

- [Ubuntu acceptance](codex-mission-acceptance-20261006.md): implementation repair, formal validation,
  independent Review PASS and final acceptance; the root subprocess check used an explicitly approved
  parent-host executor. Native subprocess restrictions remain documented.
- [Windows Mission/model routing](codex-windows-luna-fast-20261007.md): native Sol/Luna Fast threads,
  shared correction lifecycle and accepted completion with an authorized parent-host executor.
- [Windows large-write/status Anko run](codex-write-status-anko-20261007.md): accepted Mission,
  190/190 terminal command receipts, local official-test replay reward **1**, F2P **9/9**, P2P **94/94**,
  30m08.739s including cleanup. Corrections were followed by author self-recheck, not a second
  independent Reviewer PASS. The fixed development package preceded v0.13.11, which includes its
  changes; this is not a rerun of the published release, a Docker/leaderboard result or a general
  performance guarantee. Subscription monetary cost remains unavailable.
