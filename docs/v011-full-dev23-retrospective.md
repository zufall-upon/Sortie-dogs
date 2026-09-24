# v0.11.0 full dev23: what the tests established and missed

This records the completed campaign brought to this development lane by the user.
It does not alter its predictions, official receipts, costs or other lane's PR.

## Frozen evidence

- Current candidate: `29eb086ac07e41b4e8016838362d195efc525a6c`, package SHA-256
  `d34ce78546cf4aa259f4ceaf97fd045041d16ebf96d0c7a415140b93a12a5408`.
- Same pinned Lite dev23 input: dataset revision
  `6ec7bb89b9342f664a54a6e0a6ea6501d3437cc2`.
- Official receipts: **23/23**, resolved **8/23**. The recorded v0.10.22 comparison
  is **3/23**, five newly resolved and no resolved-to-unresolved transitions in
  that comparison. This is not the separately recorded v0.10.14 **6/23** result.
- Four inference rows failed: three lost their controller after priced requests,
  and one timed out. Their saved predictions were scored without a retry. One of
  those four (`astroid-1333`) resolved officially despite not reaching native
  acceptance. Official patch success and an autonomous completed workflow are
  demonstrably different observations.
- Six nonempty predictions reached patch application but not usable test output:
  five PVlib imports encounter NumPy 2's removal of `np.Inf`; PyVista cannot load
  `libGL.so.1`. The official reports still say `infra_failure=false` and unresolved.
  Preserve **8/23**; do not remove those cases from the denominator or impute passes.
- Fresh recorded spend: **$5.02000088** of the independent $50 budget. Historical
  campaign spend is separate. This does not establish a matched total-cost win.

Raw records remain under
`/home/user/.cache/swebench-v0110-dev23/full-v0110-dev23/`:
`ledger.json`, `score-comparison-v01022.json`, `setup-failure-reconciliation.json`,
and the official `report.json` / `test_output.txt` for each instance.

## Why the three selected passes do not contradict this result

The [selected three-case record](v011-qualification.md#matching-candidate-regression-all-three-selected-cases-pass)
was real: Marshmallow-1359, PVlib-1854 and Astroid-1866 passed on candidate
`7412c7cf28ecf662241aca21237d1cd5a36bf94b` (SHA-256
`858359f3d4fa34a6022599f725330f073826220d54d8c71093ee97dd7ff42e2f`).
It was a targeted remediation/regression set following observed failures, not an
untouched holdout. PVlib used a predeclared NumPy 1.26.4 scoring preinstall.

In the full campaign, Marshmallow-1359 and Astroid-1866 resolved. PVlib-1854 was
unresolved after the known NumPy import failure recurred. Both the candidate
identity and scoring-environment conditions differ. Passing the selected fixes
did not certify full-campaign execution, portability, or a 23-case success rate.
The failure to carry a diagnosed environment condition into a reproducible full
evaluation is itself a verification-system defect, not a reason to excuse it.

## The tests are useful, but the inference from them was too broad

Unit tests can prove that a failed check remains an obligation, a native child
identity survives a restart, or a stale source cannot be accepted. They cannot
prove that an agent selected adequate behavior tests, understood every requested
interface, or autonomously completed a realistic multi-stage task.

For a concrete semantic gap, `pydicom-1139` was accepted natively. Its official
FAIL_TO_PASS report passes iterator/containment behavior but fails `test_next`
with `TypeError: 'PersonName' object is not an iterator`. This is stronger evidence
than counting local passing checks: related public operations need separate
coverage. The other unresolved rows require their own log analysis; even executed
tests can fail because of environment compatibility, so do not label every
non-import failure an implementation defect without diagnosis.

PR [#34](https://github.com/zufall-upon/Sortie-dogs/pull/34) addresses the actual
grader child argv/cwd boundary and places its behavior suite in the quick lane.
The prior mocked/request-shape checks missed that boundary. Its CI pass validates
that repair; it does not change the frozen 8/23 result or finish the user's larger
benchmark → analysis → improvement → verification task. The reported 6/6 work
limit stopping that continuation is a product failure, even if scoring finished.

## Consequences for execution-first qualification

1. Keep the cheap unit regression suite, but tie each claim to what it exercises.
   A full-suite count is not an end-to-end quality or pain-resolution claim.
2. Use selected known failures as regression cases. Label any tuning/repeated
   feedback. Require separately frozen, representative, untuned ordinary-work
   scenarios before generalizing from them.
3. Exercise the actual installed launcher/controller and child argv/cwd, native
   restart and terminal delivery. An adapter mock remains an adapter test.
4. Probe required imports/test collection once at the real execution boundary,
   using pinned compatible conditions. Carry diagnosed constraints as artifacts;
   do not make the user or each model rediscover them or launch broad preflight.
5. Review distinct relevant behavior mechanisms and adjacent interfaces through
   the changed API. Never encode benchmark IDs or hidden answers into runtime
   policy. Preserve failed checks and environment-qualified results separately.
6. Qualify the entire requested chain, including diagnosis and improvement after
   a run, under one retained work/child and accounting record. A return caused by
   six unproductive dispatches is not completion. Raising/resetting that counter
   or requiring another user prompt is not the remedy.
7. Keep receipt-to-useful-action, result-to-next-action, final accepted scope,
   quality, cost coverage and real presentation as independent requirements.
   The three small pacing fixtures are useful diagnostics, not sufficient evidence
   of general repository performance. Retain and correct their own driver failures.

No new 23-case campaign or score is claimed by this retrospective.
