# FrontierHarness Codex subscription case study

## Native Docker gateway development (2026-10-17)

This support route does not authorize another benchmark attempt or change any
frozen campaign. The original v0.14.1 single-pass results remain unchanged.

For a **new, authorized** gateway, after the existing runner copies the pinned
runtime assets and creates its isolated Git root, use the reusable preparation
functions in `scripts/frontierharness_gateway.py`:

```python
install_native_docker_plugin(gateway_dir)
config = native_gateway_config(model, container_id, instruction,
                               allowed_models=ALLOWED_MODELS)
```

The returned config retains the ordinary `.opencode/plugins/docker-task` loading
entrypoint. It is not a new controller. The native tool takes `container_id`,
absolute `cwd`, and `command`; register that same container directory in each
unit's `validation_cwd`. Role/tool families come from the shared runtime registry,
including root-owned independent Review. Host shell and mutation tools remain
outside this isolated gateway. `fh_docker_exec` is available to the Worker and
the existing native-admitted Reviewer correction role, not initial Review.

Independent Review uses `fh_docker_read`, copying `container_id`, `cwd`, and
`candidate` from the Review envelope's `protected_binding_ref.docker_workspace`.
Read `path: "."` to list the candidate directory or a source/test file path to
inspect its numbered contents and SHA-256. Directory pages admit up to 2000 names;
file excerpts remain capped at 64 KB. File content is read in bounded pieces even
when a generated file has a very long logical line; line numbers/counts, UTF-8
excerpts and whole-file SHA-256 retain their existing meaning. The fixed reader reserves enough subprocess
output for JSON escaping of those existing bounds, so a valid long-name page or
escaped excerpt is not mistaken for an unavailable candidate. The tool checks the exact candidate
before and after the read, uses a fixed reader rather than caller-supplied shell,
and does not mint validation evidence. Stale/unavailable candidates are reported
as such, not replaced by a new snapshot. Reviewer context, native permissions,
and route/usage audits include this read-only path. Actual correction still uses
the existing `repair_review` admission, scope, formal checks, and self-recheck.
When that correction activates, only the exact generated gateway permission block
is projected to the registry's correction tool families. Other configured agent
rules and session rules retain their native order; the ordinary Reviewer stays
read-only. The projection also survives a cold reload and is removed on settlement.

The host captures the actual container workspace before and after a declared
check. Python-enabled task images support non-Git workspaces and include ignored
inputs, file modes, and link identity/content. Snapshot and reader Python processes
use `-I -S`, so candidate-local startup hooks and import paths are not executed as
part of read-only observation. Git-only images retain a Git-based
fallback that also binds actual workspace modes and symlink targets, including
ignored files and tracked executable bits when `core.filemode=false`. It also hashes
regular-file bytes reached through tracked symlinks, rather than treating their
unchanged link text as unchanged input. Both snapshot paths also bind each
regular-file or supported internal-directory link to its resolved final target
and referent mode. Execution-bit
changes or intermediate-link retargeting cannot reuse an old proof just because
the reached bytes stay equal; target identity stays paired with its lexical link.
Tracked and untracked internal directory
links reuse the captured workspace rather than hashing a directory as a file;
external directory trees that cannot be captured remain unavailable.
Candidates without symlinks retain their existing fallback hash recipe. Failed
Git/filesystem enumeration, diff, or file/metadata reads return unavailable, not a successful
hash of empty/partial data. Referent classification distinguishes known
missing/cyclic targets (the existing literal-link identity) from permission or
I/O errors: explicit stat in Python and the existing GNU find target-type
observation in Git-only images. Failed observations and unsupported special-file
referents are not serialized as absent input. Its older mode-blind identities are not reused as fresh
proof. Python snapshots retain a discovered repository root even before the first
commit, so validation from a nested directory still covers root and sibling inputs.
Root-path whitespace is retained as path data rather than stripped or normalized
as a text newline. Apart from the strengthened symlink referent identity,
ordinary committed and truly non-Git workspaces keep their existing identity recipe.
A declared symlink CWD keeps its logical Docker `cwd` for the registered
check and records the resolved `actual_cwd`. The candidate binds that physical
execution directory too: retargeting the alias, even within the same unchanged
repository, makes the old proof stale. Workspaces without symlinks
retain their existing non-alias identity recipes. Unsupported snapshots, failed/unknown exits, a different CWD, or changed
candidate bytes do not become proof. The container is not represented by the
unrelated gateway filesystem. Snapshot capture is conservative: a check that
changes workspace files needs a stable candidate before it can supply proof.

The regression fixture installs and loads the plugin through these preparation
functions with the public V2 `ctx.location.directory` shape. It checks native
evidence attachment, Worker settlement, independent candidate inspection, and
the final Mission receipt with a fake-Docker shim. The same regression can use
an immutable local Docker image by setting `SORTIE_NATIVE_DOCKER_IMAGE`. A separate
opt-in `native Docker smoke` test uses only a local immutable image and synthetic
files, with no model request, task replay, or official grading. It checks actual
Docker execution, non-Git snapshots, successful/failed exits, and stale inputs;
it is not an end-to-end model CLI/Mission or benchmark completion claim.

Historical `campaign_runner.py` and its Code Mode plugin remain frozen. Selecting
the native route for a future campaign requires its own pre-run artifact receipt;
these development checks do not retroactively repair earlier results. Route,
model-request, and usage audits remain enabled; missing cost stays unknown.

PR #280 release review follow-up classified both retained native Reviewer Medium
findings as valid: generated gateway correction permissions and Python startup
side effects. Both are corrected above. The five-file targeted run passed 424
tests with two live-Docker skips and one fixture failure: the shim discovered the
host parent repository for its non-Git task. After matching the container's Git
discovery boundary, both affected regressions passed (one live-Docker skip).
The original Mission's 32-unit budget, findings and accounting remain retained;
this release follow-up does not assert an independent final Mission PASS.

## Purpose

Measure whether Sortie-dogs' normal planning, delegation, validation, review, and remediation improve an accepted software-engineering result enough to justify their latency and token overhead. Compare the product configuration against bare OpenCode on the same public FrontierHarness Eval task.

This is a resource-bounded matched case study, not a FrontierHarness leaderboard submission. It starts with one task and may expand to at most three tasks only after explicit user approval.

## Methodology status

Use the official `frontier-harness-eval/eval` repository, task definitions, runtime workflow, verifier, evidence, and report tooling without replacing them with local equivalents.

The run intentionally differs from the frozen FrontierHarness v1.0 methodology:

- Models available through the user's Codex subscription replace Kimi K3 through Fireworks.
- The sample is one task initially and at most three tasks, rather than all 30 tasks.
- The Sortie arm uses its declared normal model routing instead of one model for every role.

Every report and public claim must therefore state `methodology_comparable: false`. Do not request a leaderboard rank or compare the pass count statistically with the published 30-task results. The defensible comparison is the matched bare OpenCode control run under the same modified conditions.

Preferred public description:

> FrontierHarness Eval protocol-derived matched case study using public FrontierHarness tasks and official verifiers. The model and sample size differ from the Kimi K3 30-task leaderboard, so these results are not leaderboard-comparable.

## Frozen scope

### Initial task

- Task: `datacurve/anko-typed-variable-bindings`
- Suite: DeepSWE
- Public difficulty: medium
- Selection rule: shortest published median duration among the DeepSWE tasks while retaining an official pass rate close to 50%.
- Published selection metadata at design time: official pass rate `0.496`, median duration `741` seconds, median agent steps `57.5`.

The selection rule optimizes the limited execution budget and may bias latency results toward shorter DeepSWE tasks. Preserve that disclosure in the report.

### Optional extension

Do not choose follow-up tasks after inspecting quality results. If the user explicitly approves expansion, use the following pre-registered order, selected by ascending published DeepSWE median duration:

1. `datacurve/httpx-multipart-response-parsing`: `835` seconds, official pass rate `0.593`.
2. `datacurve/fastapi-deprecation-response-headers`: `986` seconds, official pass rate `0.484`.

Expansion means two arms per added task. One task is two trials; three tasks are six trials. A failed arm remains part of the result.

## Arms

### Control: Bare OpenCode

- Use the same pinned OpenCode version as the Sortie arm.
- Use the same Codex subscription-backed reference model as the Sortie coordinator.
- Do not load the Sortie-dogs plugin, agents, skills, injected prompts, controller state, or global Sortie assets.
- Retain only the task prompt, repository instructions, neutral runtime setup, and verifier requirements shared by both arms.
- Prove isolation from the effective OpenCode configuration and startup log before the task begins.

### Treatment: Sortie-dogs

- Use the same pinned OpenCode version, task checkout, and starting checkpoint.
- Install a package built from a pinned Sortie-dogs commit and record package version and runtime asset marker separately.
- Invoke the documented explicit Sortie entry point. Do not trigger the workflow implicitly.
- Freeze and report every role's provider, model, and variant before execution.
- Use the normal intended Luna, Terra, and Sol routing available under the Codex subscription. Do not change routing after observing a result.

This comparison measures the complete Sortie product configuration, including model routing. It does not isolate the orchestration algorithm from model choice.

## Resource budget

- Initial authorization: one task, two trials.
- Trial execution: sequential by default.
- Hard wall limit: 30 minutes per arm, excluding golden-checkpoint provisioning and report generation.
- Pair limit: 60 minutes of agent execution for the initial task.
- Retries: zero for agent or verifier failures.
- Infrastructure-invalid attempt: stop, preserve sanitized evidence, fix only the infrastructure defect, and request approval before a replacement attempt. Never relabel an agent failure as infrastructure failure.
- Optional tasks: prohibited until the initial pair is complete and the user explicitly approves each expansion stage.

The published `741` seconds is a historical median for the task, not a timeout guarantee. Report timeout as an outcome; do not extend one arm after seeing the other arm's result.

## Phase 0: Authentication feasibility gate

Complete this gate before provisioning a benchmark trial.

1. Confirm the Codex subscription terms and installed clients permit the selected model to run non-interactively inside the Runta runtime for both arms.
2. Confirm both arms resolve to the frozen provider/model/variant configuration.
3. Confirm authentication can be established without placing reusable credentials in the repository, task image, golden checkpoint, trajectory, command line, report, or raw log.
4. Confirm the required authentication and model hosts can be added to one recorded Runta egress allowlist used by both arms.
5. Confirm OpenCode emits enough usage metadata to attribute coordinator and child usage without storing raw conversations.

If any condition fails, record a no-go and stop. Do not silently substitute an API key, Kimi K3, another provider, or a local execution environment. Any alternative requires a revised protocol and explicit approval.

## Phase 1: Reproduction workspace

1. Clone `https://github.com/frontier-harness-eval/eval` into `_testenv` and pin its commit SHA.
2. Use the repository's installed `frontierharness-eval` skill and scripts as the workflow authority.
3. Record `benchmark.json`, task metadata, verifier image, Harbor/Pier versions, Runta CLI version, Node version, and `jq` version.
4. Record the OpenCode and Sortie-dogs commit SHAs and package versions.
5. Keep generated packages, reports, trajectories, and temporary credentials under `_testenv`; do not add them to Git.

## Phase 2: Golden checkpoint

Use the official provisioning workflow and its default benchmark resources unless Runta changes the documented requirements:

- Clean Runta runtime with no agent preset.
- 4 vCPU, 8192 MiB memory, and 50 GiB disk.
- Official DeepSWE/Pier stack for the selected task.
- One frozen golden checkpoint before either arm runs.
- One recorded runtime-wide egress allowlist shared by both arms.

Install both arm dependencies in the build runtime, but keep arm activation separate. Verify bare mode cannot discover Sortie configuration. Remove the build runtime only after the checkpoint and recovery checks pass.

Secrets must remain in Runta's secret mechanism or an approved interactive authentication channel. Before checkpoint creation, verify no reusable access token, browser session export, auth database, or private credential file would be frozen. If safe checkpointing conflicts with Codex subscription authentication, fail Phase 0 rather than weakening credential handling.

## Phase 3: Trial protocol

For each task, restore two independent runtimes from the same golden checkpoint.

Pre-registered arm order:

- Initial task: Bare, then Sortie.
- First optional task: Sortie, then Bare.
- Second optional task: Bare, then Sortie.

The alternating order reduces systematic ordering bias across three tasks. With one task, provider-side cache and time-order effects remain uncontrolled and must be disclosed. A fresh restore controls runtime disk and memory state but does not prove a cold provider cache.

For each arm:

1. Verify commit, task, environment, egress, auth, model resolution, and arm isolation.
2. Start the official FrontierHarness trial runner with the exact public instruction.
3. Enforce the 30-minute wall limit and normal process-tree cancellation.
4. Save the official trajectory and run metadata, including unsuccessful attempts.
5. Apply the expected-operation gate before starting another arm or verifier.
6. Run the official verifier once against a candidate that passed the expected-operation gate.
7. Recover evidence locally, verify checksums and required fields, then remove the trial runtime.

The expected-operation gate is a fail-fast product gate, not an acceptance score. Stop the benchmark immediately
when an arm violates a behavior required for the measurement to be meaningful. For a task that requires source
changes, violations include an empty delivered patch, a Sortie coordinator that dispatches no implementation
worker, a successful terminal claim while required delivery remains incomplete, or missing parent/child session
identity needed for attribution. Preserve sanitized diagnosis evidence, stop all remaining measured phases, and
do not run the other arm, either verifier, or a performance comparison. Diagnose and fix the product separately;
start a new matched pair from clean runtimes only after a focused reproduction passes.

Do not provide hints, manually repair output, promote a candidate into the user's working tree, or rerun after seeing a failure.

## Measurements

### Primary outcomes

- Official verifier result: pass, fail, timeout, or infrastructure-invalid.
- Wall-clock seconds from agent start through final agent termination.
- End-to-end seconds including official verifier execution.
- Total input, output, reasoning, and cache tokens when the host exposes them.
- Model-, role-, coordinator-, and child-attributed tokens when available.
- Number of child dispatches, validations, reviews, remediations, and model steps.

Unknown metrics remain `unknown`; never convert them to zero.

### Quality evidence

For Sortie, record from sanitized typed evidence:

- Whether review found an actionable defect.
- Whether remediation changed the candidate.
- Whether the pre-remediation validation failed and the final verifier passed.
- Whether work remained incomplete despite review.

FrontierHarness verifier success is the quality outcome. Maintainability, readability, or security improvements not exercised by the verifier may be described only as observations, not as benchmark wins.

### Cost reporting

Codex subscription usage has no reliable per-trial billed dollar cost. Report:

- Actual incremental charge as `not attributable` unless the provider exposes a trial-specific charge.
- Token and quota consumption as observed.
- Optional API-equivalent estimate by model using a frozen public price source and date.

Label any estimate `estimated API-equivalent cost`, list the formula and missing token categories, and keep it separate from actual subscription cost. Do not apply FrontierHarness's frozen Kimi K3 prices to Codex models.

## Analysis

Produce a task-level paired table with no aggregate success-rate claim for one to three tasks:

```text
Task | Arm | Verifier | Agent time | End-to-end time | Tokens | Child agents | Review | Remediation
```

For a task where both arms pass, report Sortie/Bare time and token ratios. If only one arm passes, report the outcome difference and absolute resource use; do not present a speed ratio as the deciding result. If both fail, state that the case study did not demonstrate a quality advantage.

With fewer than 30 tasks, do not report a population pass-rate estimate, confidence interval, statistical significance, or ranking. Counts such as `2/3` are allowed only with all selected tasks named and the sample-size limitation adjacent.

## Publication gate

README use requires all of the following:

- Both arms completed under the frozen protocol, or every incomplete arm is visibly reported.
- Official verifier evidence and sanitized trajectories exist for every reported trial.
- Exact task IDs, commits, versions, model routes, limits, selection rule, and deviations are published.
- `methodology_comparable: false` and the non-leaderboard status appear next to the result, not only in a footnote.
- No task, arm, failed attempt, timeout, or token category is selectively omitted.
- No claim attributes a difference solely to orchestration when the Sortie arm used different routed models.
- No raw credential, authentication URL, private log, internal Project metadata, or raw conversation is published.

Allowed claim pattern:

> On the preselected FrontierHarness task `<task>`, under a modified Codex-subscription configuration, bare OpenCode `<outcome>` and Sortie-dogs `<outcome>`. Sortie used `<tokens/time>` versus `<tokens/time>`. This one-task matched case study is not comparable with the official Kimi K3 leaderboard.

Prohibited claims include `FrontierHarness score`, leaderboard placement, generalized pass-rate superiority, independent evaluation, and lower actual dollar cost without attributable billing data.

## Stop conditions

Stop without expanding scope when:

- Codex subscription authentication cannot satisfy the credential gate.
- The two arms cannot be pinned to the declared model configurations.
- Bare isolation from Sortie cannot be demonstrated.
- Official task or verifier reproduction fails.
- An arm fails the expected-operation gate required by the benchmark objective.
- Evidence or usage attribution is missing enough to make the intended claim unverifiable.
- Runtime quota, provider quota, or the approved wall budget is exhausted.

Record the blocker and preserve only sanitized artifacts. Do not replace the official verifier, loosen acceptance, add retries, extend the timeout, or select a different task after observing an outcome.

## Execution checklist

- [ ] User explicitly approves the initial two-trial spend.
- [ ] Phase 0 authentication feasibility passes.
- [ ] Benchmark, OpenCode, and Sortie commits are pinned.
- [ ] Initial task and optional extension order remain unchanged.
- [ ] Bare isolation and Sortie routing are recorded.
- [ ] Golden checkpoint contains no reusable credentials.
- [ ] Both initial runtimes restore from the same checkpoint.
- [ ] Bare trial and official verifier complete once.
- [ ] Sortie trial and official verifier complete once.
- [ ] Evidence is recovered and runtimes are cleaned up.
- [ ] Report states every methodology deviation and failed outcome.
- [ ] User separately approves any expansion to task two or three.
- [ ] README publication gate passes before promotional use.

## Sources

- https://frontierharness.org/
- https://github.com/frontier-harness-eval/eval
- https://github.com/frontier-harness-eval/eval/blob/main/skills/frontierharness-eval/SKILL.md
- https://github.com/frontier-harness-eval/eval/blob/main/skills/frontierharness-eval/reference.md
- https://runta.com/blog/introducing-frontierharness-eval/
