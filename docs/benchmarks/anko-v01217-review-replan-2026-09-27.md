# Anko v0.12.17: single-run result and review-scope repair

## Fixed run

- Sortie-dogs v0.12.17 / source `a70298ecd34993c729ea2e0fffc6752167705d36`.
- Package SHA-256: `a6ede8e42bcc5a633fea199c5651fa06b823433c44211cf7cc242c8029e5f0b5`.
- Runtime marker: `0.12.17-review-cost-paths-v1`.
- Task: Anko typed-variable-bindings, base `3f269a72ff69398b1250c584171f32d12c0d8085`.
- Public instruction SHA-256: `96c0c7ad98237d6176034c8893d8bff164ec5fda45889e51780a65cf599ffcfe`.
- Root: `ses_f1e5f3963ffeJEEXbN2Y6A39sm`, isolated Windows OpenCode V2.0.18 CLI server.
- Actual native models: Operator, Coordinator, Reviewer `openai/gpt-6-sol#xhigh`;
  Worker `openai/gpt-6-luna-fast#max`. Same routes as the prior Desktop run.
- Bound: 60 minutes / $5 priced model usage. One attempt, no extra user prompts.
- Native receipt: 06:50:06.860Z–07:43:54.830Z (53m48s); final observer: 54m08s.
- Estimated priced model usage: $2.07063584; no unpriced messages at termination.
- One Coordinator, six Workers, four Reviewers, six plans. Work units: two failed,
  four succeeded. All four reviews: `EVIDENCE_GAPS`; Operator disclosed gaps and
  accepted. This did not demonstrate independent Operator quality rejection.
- Final Anko candidate: `626e76983fd41127cbccf16582caa41fd08718b0`, clean tree.
- Frozen patch SHA-256: `f3eabb3cd1a8ebf9af348da25fd88d8c1807a6392f468c999a69892fec91c5e3`.

After every native session stopped, the pinned official test bytes were applied
to a separate copy once: reward **0**, added tests **5/9**, existing tests **94/94**.
Docker/Runta were not used; localized WSL verification is not hosted official
scoring. The grader was not supplied to a live candidate or rerun after analysis.

The prior v0.12.16 Desktop run had reward 1 (9/9 + 94/94), 52m58s, $1.63087728,
four Workers, four Reviewers and five plans. This trial took about 50 seconds
longer and $0.43975856 more. Different host/configuration shapes and one sample
per version prevent attributing that difference to the package alone.

## Observed defects

1. All four failed test groups reported the same public error-return mismatch.
   In the v0.12.17 candidate's `vm/vmLetExpr.go`, identifier reassignment set the
   error but retained the invalid RHS in `runInfo.rv`; `RunContext` returned that
   value. The passing v0.12.16 candidate cleared it. The new local test helper
   returned after checking error fragments, without checking the returned value.
   No corrected candidate was graded; this diagnosis is not a measured 9/9 fix.
2. The mission baseline correctly retained `3f269a7`, but automatic diff scopes
   came only from the latest plan. The two initial reviews followed a read-only
   validation unit and contained no baseline diff. Later reviews included two
   paths, then only `vm/typedBindings_test.go`. Earlier production changes were
   therefore absent from the automatic diff despite PR #90 being included.
   Large focused excerpts also exhausted their shared budget, leaving subsequent
   requested source headings empty.
3. Setup failure required a Go log directory. After setup repair, the same
   validation was refused as `SORTIE_VALIDATION_BUDGET_DENIED: duplicate-evidence`.
   A separate plan was needed. This is independent of review delivery.

## Repair and verification

Persist the union of declared review inputs/outputs across plans in the same
mission, including failed units that already wrote source. Use it for review
excerpts and freshness checks. New missions start fresh; current Worker grants
remain the current plan's scopes. Allocate focused excerpts per entry and mark
truncation rather than silently dropping later requested branches. Worker and
Reviewer guidance calls out public return/error/post-failure state compatibility.

- WSL `npm test`: 395 passed.
- Windows `npm run test:windows`: 6 passed.
- Related review/completion/mission tests: 40 passed, including a failed,
  committed implementation → read-only validation → test-only replan → cold
  review, and stale earlier-source rejection at submission.
- Read-only replay against the frozen Anko candidate, reconstructing scope from
  its six recorded contracts: automatic changed headings **1 → 9**, including
  `vm/vmLetExpr.go`, total excerpt **19,630 bytes**. This checks source delivery,
  not Reviewer quality, runtime improvement, or benchmark recovery.

Local evidence (outside Git): the original workspace's
`_testenv/anko-cli-v01217-1/{launch.json,native-history.json,observation.json,score/}`;
repair workspace `_testenv/anko-review-replay.json`. No live probe or extra model
spend was needed for this repair's deterministic verification.
