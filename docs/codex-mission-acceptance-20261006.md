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

**Accepted on Ubuntu:** the same practical Mission completed implementation repair, formal validation,
independent Review PASS and Operator acceptance. Its final root check used the user's explicitly
approved parent-host executor; other operations retained native `:workspace` with network disabled.
This does not claim the native subprocess EPERM was fixed. Final evidence is `acceptance-summary.json`
under `_testenv/codex-practical/`, linked to implementation commit `753ea0a`.

| Requirement | Implemented path and evidence | Remaining boundary |
| --- | --- | --- |
| Natural-language input and common ownership | `codex mission --prompt`, shared Sortie V010 plugin hooks, Mission/Operator state, native saved threads; no second execution ledger. Prior native direct Mission accepted; the practical repair Mission is now accepted through the explicitly approved mixed execution path. | The native environment still rejects this Node subprocess capture; the specifically authorized parent check provides the actual validation result. |
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
the saved practical root (exact ID retained in local evidence), ran one package check and remained unaccepted.
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
  the saved practical root (exact ID retained in local evidence); implementation writes, package validation and direct CLI
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

The user subsequently authorized **only the unchanged root `node check.mjs`** through the existing
parent-host executor in the same isolated repository. This exact command ran once, returned
`INTEGRATION PASS`, exit 0, in 43 ms. No test, implementation or AGENTS.md bytes changed during this
continuation. All five Reviewer reads used the separate native `:workspace` route; no other command
used the parent execution exception. No network use, installs or settings changes occurred.

Final evidence (`parent-result.json`, `parent-boundaries.jsonl`, `parent-events.jsonl`,
`parent-hashes.json`, `acceptance-summary.json`):

- Same Mission: the original practical Mission (exact ID retained locally).
- Same root: the saved practical root (exact ID retained in local evidence).
- Corrected run: the corrected direct run (exact ID retained locally).
- Independent Reviewer: the native Reviewer child (exact ID retained locally), actual terminal PASS.
- `complete_mission`: succeeded; SDK `accepted: true`; Mission and Operator run both completed.
- Original shared goal retained two consumed units, zero outstanding reservations, and a succeeded
  receipt covering both attempt IDs. The adapter owner is closed; no scope lease file remains.
- Subscription-native usage remains actual cumulative thread usage; final root 990,269 tokens,
  Reviewer 47,311 tokens. Monetary cost is unavailable and is not fabricated. These are not counts
  of unique prompt text or model requests.

The original failed probe records remain available. No extra model run or full regression was added
merely to reconfirm acceptance: the continuation changed no runtime source. Independent coverage
review found no further concrete implementation defect required by the current completion standard.
Native subprocess restrictions and conservative unknown-execution recovery remain explicit operating
boundaries, not unresolved requirements of this accepted, authorized Mission.

Final Linux regression: `replan-full-final.log`, 113 files passed, exit 0, 222.360 s.
No push, release or global configuration change was performed.


## Distribution entrypoints and original product scope

The practical Mission above is one end-to-end scenario, not a claim that the original product vision
is completely qualified on every host. This audit also compared the current README thesis with
`docs/v0.8-evidence-runtime-roadmap.md` and `docs/v010-preview.md`. Those documents describe their
historical checkpoints; this branch does not relabel their old performance, Desktop, compaction or
platform evidence as current Codex results.

| Explicit product contract | Current evidence | Qualification limit |
| --- | --- | --- |
| Natural-language goal survives implementation, failed checks, review correction and acceptance | Same native practical Mission accepted; earlier controlled Operator rejection returned to the same Coordinator for correction and acceptance; common requirement/budget ledger retained. | Small real tasks and controlled failure scenarios, not a general autonomous-quality or cost-optimality benchmark. |
| Additional roles and stronger models only as needed | Existing shared Mission/routing core, direct-unit path, Coordinator/Worker/Reviewer native roles, explicit SDK/CLI model precedence, packaged role assets and common-core regression. | No new claim of five-way native Codex throughput, fastest routing, or performance superiority. |
| Existing OpenCode and Codex coexist without duplicate setup | Packed imports include existing OpenCode plugin/server/assets and Codex SDK; standalone Codex uses existing CLI/auth. A consumer's OpenCode config remained byte-identical and no Codex config was created. | The consumer reused locally present dependency packages; fresh registry resolution was not tested. |
| Installation and use reach the same public contract | Tarball extraction outside the checkout; real executable bin; all public entry imports; public TypeScript SDK references; three help paths. | Local artifact only, version still 0.13.8; these new Mission additions are not published under npm latest. |
| Refusal, interruption, resume and visibility stay explicit | Packed synthetic protocol checks prove auth refusal before thread creation, missing approval bridge explanation, incomplete stdout JSON, stderr progress and SIGTERM 143. Earlier Ubuntu native saved-thread resume and unknown-execution evidence remain applicable to the unchanged adapter. | Synthetic distribution checks are not new model runs. Unknown external work, nested/untracked recovery, and native subprocess EPERM remain explicit limitations. |
| Existing OpenCode behavior remains intact | Related CLI/V2/plugin-loader/progress regression passes, including packed OpenCode initialization and assets. Full Linux suite includes the common OpenCode lifecycle paths. | Windows-native Mission, Windows Desktop and all-host parity were not validated for this candidate; the Mission shell route is Linux-first. |

Distribution evidence is local under `_testenv/codex-distribution/`:

- `pack.json` and `sortie-dogs-0.13.8.tgz`; artifact SHA-256
  `569915c6eb943f6e203fb858e5774094921cd3f9f2690f2d7fc661cbb12ae787`.
- `consumer-summary.json`: 227 archive entries, executable bin, 9 successful checks, no live model or
  registry access. Package extraction used a generated directory under `/tmp`; dependencies
  were symlinks to already installed local packages. No package install or global environment edit was
  needed for this isolated smoke.
- `related.log`: 81 tests passed, exit 0. The existing packed-loader regression now covers Codex root
  exports and all three help entrypoints in addition to OpenCode assets and initialization.

The concrete defects found in this audit were a usage/help mismatch (`codex run --help` returned 2)
and onboarding ambiguity. Help now returns 0 on stdout. README separates Codex from OpenCode `init`,
identifies the unpublished local-tarball route and existing-auth prerequisites, adds the public Mission
SDK lifecycle, and corrects permission-handler and completion/exit descriptions. No new orchestration
feature, permission store or model execution was introduced.

## Local change summary for eventual publication review

Relative to upstream `0dac848`, this branch connects the existing Mission core to native Codex saved
sessions and public CLI/SDK entrypoints; preserves model overrides, cwd, permissions and real exits;
reconciles exact recoverable native receipts while refusing unknown external work; exposes native usage
and bounded progress; supports explicit authorized parent executors; and repairs same-author direct
replanning without resetting spend. OpenCode continues using the shared core and its existing plugin
entrypoints. New tests cover those contracts, and this document retains real Ubuntu evidence and limits.

No merge, push, tag, npm publish, global installation or release-version change was performed. The local
0.13.8 tarball is an audit artifact, not a replacement for the already published 0.13.8 package. Actual
publication still needs a separately authorized release/version decision and the repository's fixed
commit/package release procedure. This audit does not assert universal platform qualification or that
historical benchmark goals have been newly measured.

Distribution follow-up final validation: full Linux regression passed 113 files, exit 0, 221.810 s
(`_testenv/codex-distribution/full.log`). Two independent reviews found no High/Medium issue. All 224
packed `dist` files match the verified build. The generated consumer dependency tree was removed after
the smoke; the tarball, protocol records, summaries and reproduction script were retained.


## Prepared Windows CI coverage

The existing `windows-latest` job already runs `npm ci`, a native TypeScript build and the Windows
platform/process/WSL-ownership suite through `npm run test:windows`. A following direct Node step
adds synthetic Codex app-server protocol, progress, telemetry and packed-consumer contracts. Direct
Node execution is intentional: `test:targeted` routes Windows to WSL and would not prove native Windows
package loading. The existing Linux job is unchanged; no additional runner job or paid model service
is introduced.

The new step requires no Codex installation, OAuth, repository secrets or live model calls. Its
package consumer extracts the locally produced tarball using the standard runner tar utility and links
already installed dependencies; it does not resolve packages from registry metadata or fetch packages.
Windows OAuth sessions, GUI/Desktop behavior, real Codex process integration and Linux-style Mission
shell execution are outside that step. Windows results remain pending until the authorized branch/PR
workflow runs; Linux fixtures are not relabeled as Windows proof. GitHub runner billing follows the
repository's existing Actions plan; no model/API charge is incurred by these selected tests.

Before publication, local machine paths and real native thread/run IDs were removed from this public
narrative; exact values remain in ignored local evidence. The committed test dialogues are synthetic
contract fixtures. Raw live conversations, authentication files, consumer trees and build logs are not
part of the tracked change or npm tarball.

The exact new Windows-step selection passed 25 tests on Linux (exit 0); workflow YAML parsed with
the two existing jobs retained. Independent review found no High/Medium issue. These are preparation
checks, not native Windows results. The runtime source is unchanged from the prior full Linux run.


The first authorized Windows CI run passed the existing Windows suite but exposed an `ENOTCACHED`
assumption in the added packed-consumer fixture: `npm ci` had cached package tarballs without the
registry metadata needed by a fresh offline install. The fixture now extracts the real local tarball
and links already installed dependencies (junctions on Windows). No product runtime behavior, test
assertion, credentials or registry access was added. The original failure is retained in CI history.

## Ubuntu continuity follow-up from main f109bf0

This follow-up uses an isolated worktree based on main
`f109bf0c0d64de3be552288088dec965604f0d1c`, preserving the earlier checkout and the
parallel Windows verification. Two concrete common-core defects were reproduced:

- After a direct execution or Reviewer correction stops, the acceptance summary used
  the actor's active admission to recover `validation_cwd`. That admission no longer
  exists after settlement. A failed check in the declared package directory could
  disappear while an unrelated same-text check in the project directory appeared as
  successful. The summary now receives the selected persisted unit's cwd registration,
  including direct-registration overrides. The regression reproduces package exit 7
  versus unrelated root exit 0 and retains the actual failure after settlement.
  This remains observational provenance, not new formal acceptance evidence.
- Two units with identical commands and cwd mappings failed with
  `operator-unit-needs-new-goal-milestone` when only JSON key order differed. The
  coalescing comparison now compares command/directory pairs without changing the
  stored map representation. This preserves existing plan hashes and Reviewer
  correction contracts. Different cwd values still do not share one combined proof.

Both fixes received independent review with no High/Medium finding. Related regressions
passed 215 tests for the summary path and 54 for planning/direct execution. Local
reproduction and full-run evidence are retained under `_testenv/continuity/`; no raw
native conversation, auth material or live IDs are included in this follow-up.

No model call, dependency install, permission expansion, global setting change, push,
merge or release was needed. Existing Ubuntu Node 22.22.1, npm 10.9.4 and Codex 0.160.1
with ChatGPT authentication were reused. These synthetic regressions address two
specific continuity/visibility defects; they do not establish all-workload autonomous
quality, cost optimality, Windows Desktop operation, or removal of the native
subprocess restriction described above.

Final Linux `npm run test:full`: 113 files completed, 1773 tests passed, 2 existing live tests skipped,
zero failures, exit 0, 222.944 s (test phase). No extra live model turn was used to
reconfirm these deterministic defects.

## Cold-resume, correction and progress cross-check

The follow-up on `02b4b73` reused isolated copies of the existing scripted Codex and
Reviewer fixtures. Passing cross-checks remain ignored local probes rather than new
permanent copies of already covered happy paths. Evidence is under
`_testenv/continuity-next/`.

- `cold-cwd-probe.ts` / `cold-cwd.log`: a registered package check returns exit 7;
  closing and recreating the Codex adapter retains that cwd and failure in progress.
  The same command returning exit 0 at the project root still cannot finish the unit.
  Repair and validation in the registered package then reach acceptance with the
  same Mission and run IDs. Command progress reports the actual package directory.
- `reviewer-cwd-probe.ts` / `reviewer-cwd-background.log`: a correction inherits the
  package cwd, records exit 7, reloads the plugin with an existing background Task
  receipt, and uses the established handoff rebinding path. The subsequent successful
  check, saved correction check directory, progress formal proof and native author
  self-recheck agree; the same Mission reaches completion.
- The unsuccessful probe logs were retained: omitting cold rebinding leaves no live
  write-gate binding, and omitting the parent Task receipt does not establish the
  correction terminal. These are not relabeled as accepted runs. The successful
  case uses the existing recovery protocol; it introduces no permission expansion,
  new Task or invented terminal receipt.

The one additional mismatch was in new Codex thread instructions: they still directed
all formal validation to the project root despite `validation_cwd` support. The text
now explains the root default, exact command-to-directory registration and matching
`bash workdir`. Existing workdir tests reproduce the old contradiction and check the
updated guidance. No runtime acceptance, settlement or authorization logic changed.

Remaining qualification boundaries are concrete:

- Scripted transport and plugin reload prove shared state/receipt handling, not an
  actual OpenCode application restart. The already pending manual restart must report
  the loaded runtime and exercise the same saved Task; no independent code change is
  justified by these passing fixtures alone.
- Codex recovery of a lost parent Task response is currently supported for the exact
  proven leaf Worker case, not arbitrary Reviewer/nested work. An unobserved Reviewer
  receipt must first be reconciled from its actual native history; automatic resend
  would not prove that the old work stopped. This audit does not broaden recovery.
- Existing saved native threads retain their original developer instructions. The
  guidance change affects new threads; it does not claim to rewrite old rollouts.
- Native subprocess capture restrictions remain as previously recorded. This audit
  made no live model call or native-permission change and did not bypass them.

Within the audited cwd/receipt/progress paths, no additional runtime inconsistency was
reproduced after the previous two fixes. Broader quality and efficiency claims still
require measured real workloads; adding more normal-path fixtures would not supply
that evidence.

Guidance follow-up validation: related 46/46 passed; final Linux full suite completed
113 files, 1773 passed, 2 existing live skips, zero failures, exit 0, 222.608 s
(test phase). Independent review found no High/Medium issue.
