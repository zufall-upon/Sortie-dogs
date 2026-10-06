# Codex Mission acceptance and remaining work — Ubuntu 2026-10-06

## Completion standard

The target is a usable natural-language Mission: Operator retains the original requirements,
Coordinator decomposes work when needed, implementation and validation stay in the existing
Mission lifecycle, and quality failures return for correction before Operator acceptance.
Direct execution remains appropriate for a small task. Passing transport tests alone does not
establish this product outcome. This document records evidence and next work; it is not another
runtime ledger, permission policy, or release gate.

Development is on `fix/codex-linux-settlement`, based on upstream `0dac848`.
No push, release, global installation, new authentication, paid API, or OS security change is part
of this work. Original and unrelated project checkouts are untouched.

## Acceptance status

| Requirement | Implemented path and evidence | Remaining boundary |
| --- | --- | --- |
| Natural-language input and common ownership | `codex mission --prompt`, shared Sortie V010 plugin hooks, Mission/Operator state, native saved threads; no second execution ledger. Prior native direct Mission accepted. | A native execution environment must permit the requested work, or a parent host must supply its authorized executor. |
| Coordinator/Worker/Reviewer and root quality acceptance | Native roles use the same task hooks, reservations, corrections, protected validation and final Operator acceptance. `_testenv/codex-operator-return/summary.json` records controlled quality rejection and return to the same Coordinator, followed by correction and acceptance. | This is a controlled defect scenario, not a general autonomous-quality benchmark. |
| Recovery without duplicate work | Exact unstarted Task recovery and bound, completed leaf Worker recovery feed existing settlement. `_testenv/codex-bound-child/summary.json` and `continued-result.json`: implementation count remained one, then normal corrective validation/review completed. | Missing bindings, nested/untracked children and unknown external execution cannot be inferred complete. |
| Stop/resume | Linux signal handling, owner identity and shared recovery serialization; unknown external writers remain unknown. Same-thread cold resume confirmed again in `_testenv/codex-practical/summary.json`. | Adapter shutdown does not prove an external process stopped. Parent executor must reconcile its processes. |
| Host permissions and execution | Fixed sandbox override removed in `2804d7b`; optional authorized parent `executeCommand` added in `ce8b1f5`. Explicit native profile selection was completed in `5582de2`. | Parent application grants do not automatically transfer to a separately launched app-server. No implicit widening or automatic fallback. |
| Directory and result identity | `6d2e066`: bash workdir reaches both native and parent executors after the common before-hook; effective cwd appears in progress and results. Fixtures prove another directory's PASS cannot satisfy root validation and failed root validation can be corrected and accepted. | Formal validation entries are executable root-relative shell commands, not command strings with prose directory annotations. |
| Visibility and efficiency | Tool/command events, cwd, real exits, correction reasons, child identities, native token deltas; subscription cost remains unavailable. Effective native profile is now exposed at thread start/resume. | Native turn totals are not model-request counts or remaining subscription allowance. |
| Regression | At `5582de2`: Linux full 113 files, exit 0, 221.767 s; independent reviews had no remaining High/Medium finding. Direct-replan follow-up results are recorded below. | Test totals do not substitute for a real write/repair/acceptance session. |

## EROFS diagnosis

Read-only diagnostic: `_testenv/codex-permission-diagnosis/result.json`.
The native Codex 0.160.1 app-server was queried without changing configuration or starting a model turn.
Both the practical isolated repository and the development repository produced:

- No configured value/origin for `sandbox_mode`, `sandbox_workspace_write`, `approval_policy`,
  `approvals_reviewer` or `default_permissions`.
- Effective profile `:read-only`, sandbox `readOnly`, network disabled, approval `on-request`,
  reviewer `user`.
- Runtime workspace root correctly matched the requested cwd in each case.
- Native profile listing allowed `:workspace`, but availability is not user authorization to select it.

The current adapter omitted permission overrides. Therefore the observed EROFS came from the native
built-in default, not a wrong project directory or a remaining adapter-imposed read-only policy.
The integration gap was that the Mission SDK/CLI could not explicitly select the existing native
profile consistently for thread start/resume and standalone command execution. Merely setting a turn
policy would not repair the separate `command/exec` path.

The practical run attempted library and CLI repairs, preserved both test files, reported real exit 1
for EROFS, and did not claim acceptance. A deliberate read-only cold resume used the same root
`01a10fc8-df29-7eb0-979a-ae6f73e754e9`, ran one package check and remained unaccepted.
This proves refusal/result fidelity and resume, not successful implementation delivery.

## Current follow-up and next actions

1. Implemented: explicit `permissions` SDK / `--permissions` CLI selection. Forward it to native thread start,
   resume and `command/exec.permissionProfile`; retain defaults when omitted. Do not edit native config,
   silently choose full access, or create a permission ledger. Publish effective native permissions as
   ordinary progress, separately identifying a parent-host executor when present.
2. Verified: exact propagation, default omission, native rejection without fallback, resumed sessions
   and shared validation behavior using protocol fixtures and read-only native probes. Two independent
   reviews found no remaining High/Medium issue.
3. User explicitly approved the bounded native `:workspace` continuation, with networking disabled,
   the existing isolated repository and standard temporary areas, and only `lib package/slug.mjs`
   and `app/cli.mjs` as implementation outputs. No persistent settings were changed.
4. The same saved Mission resumed with that profile. Both implementation repairs succeeded, the
   package check passed, and the direct CLI produced the expected JSON. Both test files and AGENTS.md
   retained their SHA-256 hashes. Root validation failed inside Node child-process capture with EPERM,
   not an assertion failure. No acceptance was claimed.
5. The live continuation also exposed a common-core deadlock: the original annotated validation
   declaration could neither pass `finish_direct_unit` nor be corrected while its direct unit was
   running. The follow-up below repairs this path using existing settlement and cumulative budget.

## Profile follow-up verification

- Related regression: `profile-targeted-final.log`, 57 passed, exit 0.
- Real native 0.160.1 API compatibility, without a model turn or broader permission:
  `read-only-profile-result.json` records explicit `:read-only` start, saved-thread resume and
  `command/exec` exit 0. Both thread responses retained network-disabled read-only permissions.
- A nonexistent profile through the actual Mission CLI failed during native configuration loading
  (exit 1); no fallback was attempted. Ephemeral thread resume still returns the known `no rollout
  found` error; compatibility verification used the existing saved thread instead.
- Profile APIs require native experimental capability. Mission dynamic-tool sessions already enable
  it; low-level host callers can now set `experimentalApi: true` explicitly. This negotiates API
  availability, not filesystem or network permission.
- Two independent read-only reviews found no remaining High/Medium issue. Final full regression passed 113 files, exit 0, 221.767 s
  (`profile-full-final.log`). Writable-profile selection was subsequently approved and exercised;
  the remaining actual execution failure is described below.

## Approved native continuation and direct-replan correction

Evidence is local under `_testenv/codex-practical/`:

- `workspace-preflight.json`: effective `workspaceWrite`, implicit cwd workspace, network disabled,
  native `:workspace`, and `on-request` approval. The root is the isolated `repo` in that directory.
- `approved-result.json`, `approved-events.jsonl`, `approved-hashes.json`: same saved root
  `01a10fc8-df29-7eb0-979a-ae6f73e754e9`; implementation writes, package validation and direct CLI
  succeeded; all protected hashes unchanged; `accepted: false`.
- `subprocess-diagnosis.json`: trivial Node child with piped stdio reports `EPERM`; `inherit` and
  `ignore` complete without that error. `ipc-diagnosis.json`: Python pipe and socketpair succeed.
  `trace-diagnosis.json`: native sandbox also refuses ptrace, so the exact failing syscall remains
  unproven. These observations do not justify enabling network, weakening OS security or silently
  switching to an unsandboxed executor.

The common-core correction permits a reasoned replan by the same direct author only after actual
native history proves no unfinished tool execution. It ends the old admission **without validation
evidence**, using the existing `finishDirectUnit` settlement; the old spend remains consumed. Normal
replan, validation, independent review and Operator acceptance remain required. Reviewer corrections,
other owners and active/unknown/background work retain their existing restrictions. Missing or
malformed history is not treated as an empty execution history.

Native tool call identity is forwarded by both V2 and Codex so only the exact current planning call
can be pending during this transition. Every ordinary tool admission now shares the existing root
dispatch lane with settlement/replanning; a shell cannot enter between quiescence and writer release.
No additional runtime ledger or permission policy was introduced.

- Related regression: `replan-related-final.log`, 89 passed, exit 0. Existing direct-execution tests now
  cover root/Coordinator live and cold replanning through correction, validation, review and acceptance;
  rejected malformed plans, unavailable/malformed/foreign history, background work, exact planning
  identity, retained spend, and concurrent ordinary admission.
- Two independent read-only reviews found no remaining High/Medium finding after the history and
  admission-race corrections.

The updated native continuation is recorded in `replan-result.json`, `replan-events.jsonl`,
`replan-hashes.json` and `replan-summary.json`. The same root and Mission corrected their declaration
through `plan_units` (`direct-unit-running`) without rewriting implementation. One root `node check.mjs`
then returned exit 1 from `execFileSync`/`spawnSync ... EPERM` in 75 ms. `finish_direct_unit` preserved
that failure and returned `direct-unit-awaits-validation`; no review or final acceptance was fabricated.
All protected hashes remained unchanged. The adapter's completed turn is not Mission completion.

The next external decision is whether to authorize **only the unchanged root `node check.mjs`** through
the existing parent-host executor in this same isolated repository, with no network use, installs,
settings changes or test edits. All other commands can retain the native approved `:workspace` path.
That different execution boundary has not been selected or executed. After an authoritative PASS,
the same Mission can continue normal quality review and Operator acceptance without another replan.

Final Linux regression: `replan-full-final.log`, 113 files passed, exit 0, 222.360 s.
No push, release or global configuration change was performed.
