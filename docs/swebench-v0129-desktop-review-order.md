# Native V2 mission review-order correction — 2026-09-26

## Observed failure

The `astroid-1333` desktop-service experiment used release v0.12.9:

- Release commit: `3c2efc47100c41987df10b84a8ca7512a8c48edc`.
- Package SHA-256: `e9c0636499176d0d438fe5846de1dd44ffab2bbaa28f64ba30b5095b78dc578e`.
- Runtime marker: `0.12.9-mission-resume-v1`.
- OpenCode V2 shared service: `2.0.14`.
- Root: `ses_f23ac00c0ffeUkiG14qQOQQ7rs`.
- Worker: `ses_f23ab008effeVZrdyDNJkTL8J9`.

The Worker bound its write gate, then returned without editing or testing because
the mission's independent Reviewer result was absent from its handoff. The native
report explicitly treated that result as a prerequisite while also observing the
prohibition on nested delegation. The Coordinator had to explain the order again
and dispatch another Worker.

`OperatorRuntime.prepareOnce()` unconditionally told Workers that required
consultations belong to the root **before dispatch**, including the mission route.
The mission Coordinator instructions instead place `review_mission` **after
formal validation**. A mission retaining an independent-review requirement thus
exposed contradictory instructions to its implementation Worker.

## Correction

The generated mission Worker prompt now distinguishes prior technical/user
decisions from subsequent independent SourceReview. It tells the Worker to produce
its implementation and formal evidence, return to the Coordinator for independent
review, and apply supplied prior FINDINGS during a correction unit. Missing
post-validation review alone must not block implementation.

The mission still retains its original acceptance and coverage, independent
review, and prohibition on nested Worker delegation. The non-mission branch keeps
its existing consultation instructions.

Regression tests exercise actual mission preparation, Worker admission and opaque
reference expansion for a single unit and **both** units of a multi-unit plan.
They check retained acceptance/proof/handoff coverage, absence of the conflicting
mission instructions, and the legacy `OperatorRuntime.prepare()` contract.

## Native repair and Dog-Reviewer consultation

The repair ran against source base
`54dc4f20edbd9be347e7bde4bd0ded2388d1bbae` in native root session
`ses_f23a0e0d8ffeoQyR9B98uJ0Gra`. Assistant history verified:

- Operator/Coordinator/Reviewer: `openai/gpt-6-sol#xhigh`.
- Workers: `openai/gpt-6-luna-fast#max`.

The initial Reviewer identified missing coverage of the second unit's expanded
prompt. A Worker corrected that test. Subsequent review/Operator feedback also
led to explicit retained-review requirements, negative checks for the old wording,
and a legacy-plan regression.

Five Reviewer sessions ran: one **FINDINGS**, followed by four **EVIDENCE_GAPS**.
The final verdict was **not PASS**. The native mission accepted the candidate
under its bounded evidence-gap policy and disclosed the gaps. In particular,
later test-only unit review artifacts did not show the earlier production-source
change, and delegates could not see the controller's complete cost record.
These review-artifact/visibility issues remain follow-up observations.

The parent subsequently recovered the original failing command and assertion
from the saved native history. It also ran the final regression tests against an
isolated unchanged base: both mission cases failed and the legacy case passed.
The same three tests passed against the corrected source. These additional
checks are parent evidence, not a retrospective change to the Reviewer verdict.

## Validation and accounting

- Native final `test/operator-mission.test.ts`: **20/20 PASS**.
- Native related `test/v010-runtime.test.ts` and `test/runtime-assets.test.ts`:
  **109/109 PASS**.
- Parent `npm test`, including build: **380/380 PASS**.
- Final targeted regression pair: base **2 failed / 1 passed**, fixed **3 passed**.
- `git diff --check`: PASS.
- Repair elapsed time: **2,200.368 seconds** of the 2,400-second limit.
- Repair usage estimate: **USD 1.488628** of the USD 1.50 allocation; complete
  recorded usage, no new uncertainty hold for this repair.
- Campaign spent plus historical holds: **USD 82.70376568 / 135**.
- Remaining campaign budget: **USD 52.29623432**.

Evidence is retained outside Git under
`/tmp/opencode/swebench-v0129-desktop-night/sortie-review-order-fix-01/`, including
native session histories, `validation-evidence.json`, base/fixed regression logs,
`npm-test-final.log`, `result.json` and `budget-settlement.json`.

The preceding astroid attempt stopped when CLI-mediated history observation
returned incomplete JSON. Its unfinished patch and original result remain saved;
it has no official score or completed independent review. The controller now uses
documented shared-service discovery/authentication and complete HTTP body reads.
Native child shells also lacked the root's Python cache environment variables;
future Python diagnostic commands explicitly carry the cache settings.

This correction has not yet been evaluated as a newly packaged runtime on
`astroid-1333`. The frozen prior main dev23 score remains **6/23**.
