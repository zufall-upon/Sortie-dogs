# Review source after a Worker commit

## Observed failure

In the fixed-release v0.12.16 Desktop Anko run
`ses_f1ed65149ffeycrcFhJ6JWYwWy`, the Worker committed its implementation
before independent review. `missionReviewSource` used `git diff HEAD`; that diff
was empty after each commit. The tool-free Reviewer instead received the first
alphabetically enumerated files in a 24 KB source excerpt. All four review
prompts reported truncation. The first review found a concrete error-text
defect, which the same Coordinator fixed. The next three reviews reported
`EVIDENCE_GAPS` for specific source/test excerpts, even though the Worker had
run the declared test suite. A subsequent Worker also fixed an actual
`TypedBindings` assignment route; those minutes cannot be classified as
evidence-only overhead. The final candidate scored reward 1 in a single
post-session local run using pinned official Anko test bytes. No earlier
candidate was scored, so its time-to-passing-result is unknown.

## Fix and limits

- Persist the Git HEAD observed before the first mission unit. Reuse it across
  plans and commits; capture it on the first plan if the mission began before
  Git was initialized. Older missions without an anchor retain their prior
  behavior.
- Review changed files inside declared write scopes against that anchor,
  including committed and uncommitted changes. Bound each changed-file excerpt
  separately so a large generated file cannot consume all source context;
  report omitted content and keep hashing the entire candidate for staleness.
- Keep explicit focused excerpts, declared ignored artifacts, review verdicts,
  independent-Reviewer checks and Operator acceptance rules unchanged. This is
  an evidence-delivery correction, not an automatic PASS or a bypass for a
  concrete `FINDINGS` verdict.

The change does not claim a SWE-Bench score improvement. That needs a fixed
candidate and comparable 23-case rerun. The Anko run took 52m 58s to native
Operator acceptance, with $1.63087728 estimated priced model usage and zero
additional user prompts; the score-only local verifier then ran for 36 seconds
on a separate copy. Native histories, prompts, candidate patch and grader
result remain under `_testenv/anko-desktop-v01216-1/` outside Git.

A read-only smoke check against that frozen Anko candidate and its original
base (`3f269a7`) produced a 15,639-byte review excerpt with headings for all
ten changed files, including `vm/typed_bindings_test.go` and `vm/vmLetExpr.go`.
Oversized file excerpts remained explicitly marked as truncated. This checks
evidence delivery, not a new Anko agent run or an earlier time-to-pass claim.
