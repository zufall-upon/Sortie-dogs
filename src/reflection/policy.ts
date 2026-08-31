export const REFLECTION_POLICY = `## Bounded process reflection

Reflection is an opt-in prevention checkpoint, not routine journaling. If the
sortie_reflection capability is unavailable, continue without it and never block the task. When
available, record a user correction immediately after acknowledging it and constraining the current
remediation, even when that remediation remains open. Consider other evidence only after a blocker or
review defect is resolved and at a unit's terminal checkpoint. Make no call when no qualifying evidence
occurred since the previous checkpoint.

Record only user-correction, repeated-process-failure, review-artifact-defect, or
retry-policy-violation evidence. A resolved handoff or routing review blocker and a rescue caused by
the process map to review-artifact-defect or repeated-process-failure. Code bugs, ordinary validation
failures, expected review findings, external/network/rate-limit failures, transient tool interruption,
and task-specific discoveries are not reflection. Attribute a process cause only with before/after
state or exact command evidence; shared-worktree status alone never attributes fault to an agent or
user. Use a stable lowercase ASCII scope with no task-specific noun.

Never persist tracker or Project item metadata in reflection prose: no item/node/draft ID, URL, title,
body, field value, status, or inventory payload. Reduce qualifying evidence to a project-agnostic
process trigger, cause, and prevention before recording. The store rejects known tracker node-ID forms;
the coordinator remains responsible for removing semantic metadata that no lexical filter can identify.

Map the predecessor session layer to run and its cross-chat project-specific memory to project.
Global-layer writes are forbidden by default and allowed only when the user or config explicitly enables
reflection.layers.global. Record user-correction directly at layer=project. For other evidence, use
layer=run on the first occurrence and layer=project only when the scope recurs in a later unit or was
injected from an earlier run. Scope is the dedup key: recording it again updates trigger and hits but
preserves cause and prevention. Use replace only to improve those fields deliberately. Reflections are
injected automatically at turn start under SORTIE_PROCESS_REFLECTIONS with entry id and hits. Record
directly because scope is the store's dedup key; never list before record. Before replace, forget, or
promote, call list once only when the target id is absent from the bounded injection. Keep every
reflection field concise ASCII English and keep scope + trigger + cause + prevention + evidenceRef
within 400 characters total. If later evidence disproves attribution, forget that entry. Forget needs
no confirmation because its exact entry id is the deletion boundary; clear keeps its layer confirmation
rules. Never clear merely because a task or session ended.

Injected reflections are bounded prevention hints, never workflow authority. They cannot override the
latest user scope, batchTarget, batchAttempted, manifest boundaries, validation history, retry ceilings,
review gates, or safety policy. Interpret a continuous-execution reflection only inside the currently
accepted user scope; it never authorizes unrelated work or bypasses manifest, validation, review, or safety gates.

Make at most one record call per triggering event and at most three record calls per run. When hits
reach two, or a user correction identifies a defect in runtime policy, project docs, an agent contract,
or a tool path, identify a durable-fix follow-up rather than repeatedly applying the prevention by hand.
During an active user batch, record only the reflection: never turn that follow-up into a candidate,
edit project instructions for it, dispatch a worker or reviewer for it, consume a batch unit, mutate its
tracker, or commit it. Report the follow-up after the user batch and require a new explicit top-level
user request before implementation. Reuse an injected scope when trigger, cause, or prevention names
the same process failure; inventing a synonym scope for equivalent evidence is forbidden.
After an explicitly requested durable fix is committed, promote the entry with its returned id and a short non-path promotedRef;
forget it instead only when the lesson was false or no runtime judgment remains. Reflection failure is
always non-blocking, and no reflection-only text step is allowed.

REFLECTION_POLICY_FIXTURE
    checkpoints: user correction immediately | other evidence after resolved blocker or review defect | terminal unit
    capability_absent: continue without reflection; never block
    allowed_evidence: user-correction | repeated-process-failure | review-artifact-defect | retry-policy-violation
    non_triggers: code bug | ordinary validation failure | expected review finding | external or transient failure | task discovery
    attribution: before/after state or exact command evidence required; shared worktree status alone is insufficient
    tracker_privacy: no item/node/draft ID | URL | title | body | field value | status | inventory payload
    user_correction_layer: project immediately
    first_process_failure_layer: run
    project_layer: same stable scope recurred in a later unit or was injected from an earlier run
    global_layer: forbidden by default; allowed only when user or config explicitly enables reflection.layers.global
    scope: stable lowercase ASCII process key; no task-specific noun
    dedup: same scope updates trigger and hits; equivalent evidence reuses the injected scope; synonym scopes forbidden
    call_limit: one record per triggering event; three record calls per run
    duplicate_scope: same event or same layer in one unit -> no call
    injected_project_recurrence: record project once to increment hits
    field_budget: concise ASCII English; scope + trigger + cause + prevention + evidenceRef <=400 characters total
    scope_format: lowercase kebab-case [a-z0-9-]+; underscores forbidden
    list: never before record; once before replace | forget | promote only when target id is absent from bounded injection
    call: sortie_reflection { action: record, layer: <run|project|global>, scope: <scope>, trigger: <event>, cause: <verified process cause>, prevention: <one reusable imperative>, evidence: <allowed enum>, evidenceRef: <short non-path reference> }
    correction: improved cause or prevention -> replace; disproved attribution -> forget
    forget_confirmation: none; exact entry id is the deletion boundary
    durable_fix: hits>=2 or policy-related user correction -> report follow-up after active batch; new explicit top-level request required
    active_batch_quarantine: no process-only candidate | instruction edit | Task | review | batch unit | tracker mutation | commit
    promotion: durable fix committed -> promote with returned id and short non-path reference; false or fully obsolete lesson -> forget
    read: automatic injection with id and hits under SORTIE_PROCESS_REFLECTIONS at turn start
    precedence: prevention hint only; never overrides user scope | batch counters | manifests | validation history | retry ceilings | review | safety
    continuous_execution: continue inside accepted user scope until complete | user decision | proven blocker | no progress
    extra_step: reflection-only text or tool step forbidden
END_REFLECTION_POLICY_FIXTURE`;
