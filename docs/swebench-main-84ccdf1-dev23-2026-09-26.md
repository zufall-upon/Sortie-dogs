# Main-integrated SWE-bench Lite dev23 evaluation

## Result

PR #65 was merged into `main` as
`84ccdf1bd8e2f127483cc0deb51f30252197fd2a`. A fresh evaluation from that commit
attempted all 23 instances once, with **zero retries**:

| Measure | Previous v0.12.8 two-batch campaign | Main-integrated run |
| --- | ---: | ---: |
| Inference succeeded / nonempty predictions | 14 | 21 |
| Official resolved | 5 / 23 (21.7%) | **6 / 23 (26.1%)** |
| Official unresolved with nonempty patch | 9 | 15 |
| Empty predictions | 9 | 2 |
| Official error IDs | 0 | 0 |

All five previously resolved instances remain resolved. The additional resolved
instance is **`pydicom__pydicom-1694`**, previously a timeout. The other five are
`marshmallow-code__marshmallow-1343`, `marshmallow-code__marshmallow-1359`,
`pydicom__pydicom-1256`, `pylint-dev__astroid-1196`, and
`sqlfluff__sqlfluff-1733`.

The comparison is observational: the prior campaign amended its budget between
two batches and included four cost-limit stops. This run gave all 23 instances
fresh USD 1.50 reservations. Budget conditions and stochastic executions differ,
so the one additional resolution cannot be attributed solely to the prompt fix.
The previous results and separate improvement experiment remain immutable.

## Fixed run identity

- Source/adapter commit: `84ccdf1bd8e2f127483cc0deb51f30252197fd2a`.
- Runtime: `sortie-dogs@0.12.8`, marker `0.12.8-mission-lineage-v1`, profile `v010`.
- Package regenerated from the main commit, SHA-256:
  `d1132b8d13a0bf8ef2b41ba7ec1f67812c8bfa1f26a9f3ac7cc2e2b656534906`.
  It is byte-identical to the public v0.12.8 archive; #65 changed the benchmark
  adapter rather than packaged runtime assets.
- Public inference dataset: `princeton-nlp/SWE-bench_Lite`, revision
  `6ec7bb89b9342f664a54a6e0a6ea6501d3437cc2`, split `dev`.
- Public manifest SHA-256:
  `4ac9cb78a997be2c728b58939cd024615e470e77a0136f39b60800f2b39f31b2`.
- Runner SHA-256:
  `38b5e3b7bb39cb911043c307b51fee6cef30f7ed4e4457b7e781be330713a358`.
- Supervisor SHA-256:
  `673e1df9309bbfe73c02c853042e99c83de993af2fd87868c005328e62d588bf`.
- Four inference slots, one attempt per instance, 1,800-second timeout,
  `official-image-testbed`, USD 19.50 run allocation, USD 1.50 per instance.
  All 23 actual reservations were USD 1.50; none was reduced.
- Preflight passed with OpenCode `2.0.14` and eight runtime assets verified.
- Native assistant-message history for `marshmallow-1343` verifies both Worker
  sessions used `openai/gpt-6-luna-fast#max`; Operator, Coordinator and Reviewers
  used `openai/gpt-6-sol#xhigh`. This is execution evidence, not just configuration.
- Official scoring: installed SWE-bench `5.0.2`,
  `swebench eval SWE-bench/SWE-bench_Lite --split dev --workers 1`, run ID
  `sortie-main-84ccdf1-dev23`. The scorer CLI uses its dataset alias; retained
  per-instance evaluator-script hashes and image IDs identify the scoring inputs.

Started 2026-09-26 **03:30:15 UTC**. Inference ended **05:01:45 UTC**
(91m 30s); official scoring and final summary ended **05:08:14 UTC**
(97m 59s total). The initial observer exited before the supervisor state file
was created; a replacement monitor attached to the already-running supervisor.
Inference was not restarted, and all attempt counters remain one.

## Remaining cases

The 17 non-resolved cases comprise six pre-test environment failures, one
test-injection collision, seven cases with remaining target-test failures, one
base-reproducible evaluation mismatch, and two empty predictions.

| Instances | Observed failure / interpretation |
| --- | --- |
| `pvlib-1072`, `1154`, `1606`, `1707`, `1854` | Old pvlib imports `np.Inf`, removed by installed NumPy 2. Tests stop during import, exit 4. Target behavior is untested. |
| `pyvista-4315` | VTK import fails because `libGL.so.1` is absent, exit 1. Target behavior is untested. |
| `pydicom-901` | Added `pydicom/tests/test_config.py` prevents official test injection. Three candidate tests pass; all five required official test IDs are absent. |
| `pydicom-1139` | 3 failed / 38 passed. Two of three required new tests pass. `next(PersonName)` raises `TypeError` rather than expected `AttributeError`; two additional fixture failures reproduce on base. |
| `pydicom-1413` | 4 failed / 300 passed. OL bytes assignment passes; OD and OV still fail. Two additional fixture failures reproduce on base. |
| `astroid-1268` | 1 failed / 91 passed / 5 skipped. Unknown string representation is `Unknown`, expected `Unknown.Unknown()`. |
| `astroid-1866` | 1 failed / 15 passed. Invalid string formatting propagates `ValueError` rather than returning uninferable. |
| `astroid-1978` | 1 failed / 12 passed. Required import-time output is absent. |
| `sqlfluff-1517` | 3 failed / 56 passed. Repeated-semicolon diagnostic text differs from expected text. |
| `sqlfluff-1763` | 3 failed / 66 passed. Safe-create/replace leaves a new file absent or existing contents unchanged. |
| `sqlfluff-1625` | 1 failed / 68 passed. Directed CLI output-prefix assertion also fails in the pinned-base control. |
| `astroid-1333` | Inference timeout at 1,800 seconds; empty prediction, incomplete usage hold retained. |
| `sqlfluff-2419` | `pricing-coverage-missing` / `missing-usage` stop; empty prediction, incomplete usage hold retained. |

The raw official report classifies the six environment cases as unresolved, with
`infra_failure: false` and `patch_successfully_applied: false`. Detailed logs show
patch application followed by import failure. Preserve those raw report fields;
the diagnostic classification above does not recalculate the official score.

### Pinned-base controls

After the campaign, three supplemental controls ran the frozen evaluator in fresh
network-disabled containers of the same recorded images, explicitly checking out
the dataset base and applying **no candidate patch**. No inference was performed.

- `pydicom-1139`: base **5 failed / 36 passed**, candidate **3 failed / 38 passed**.
  Both `TestBadValueRead` tests fail with missing `self.tag` on base and candidate.
  Those two failures are not evidence of candidate-introduced regressions. The
  candidate fixes iterator and containment tests but leaves the `next` test failing.
- `pydicom-1413`: base **5 failed / 299 passed**, candidate **4 failed / 300 passed**.
  The same two `self.tag` failures occur on both. The candidate fixes OL but not
  OD/OV assignment.
- `sqlfluff-1625`: base and candidate both have **1 failed / 68 passed**, with
  `test__cli__command_directed` as the sole failure. It is a base-reproducible
  evaluation mismatch; this control does not establish complete repair correctness.

All control test exit codes are 1 even though the evaluator shell exits zero
after its final checkout. Initial control setup stopped before tests because
image HEAD was a synthetic `SWE-bench` commit; its log and failure record remain
under `base-controls/`. Completed controls and their explicit base-checkout
conditions are separate under `base-controls-v2/`.

The earlier reset diagnostics described in
[test-reset diagnostics](swebench-test-reset-diagnostics.md) use different saved
patches. Their supplemental pydicom failure and sqlfluff pass do not replace any
outcome in this fresh main evaluation.

## Budget settlement

| Entry | USD |
| --- | ---: |
| Carried-forward usage and holds | 62.00397936 |
| Main run recorded usage | 12.73187724 |
| New incomplete-usage holds | 1.97928108 |
| **Cumulative usage plus holds** | **76.71513768** |
| **Remaining under approved 85 cap** | **8.28486232** |

New holds are USD 0.94412568 for `astroid-1333` and USD 1.03515540 for
`sqlfluff-2419`. These are budget-accounting uncertainty reserves, not finalized
provider bills. Both current and historical holds carry forward. Docker scoring
and the three base controls added zero inference requests.

After this settlement the user approved an additional **USD 50** and a
**40-minute inference timeout for future runs**. The cumulative cap is now
**USD 135**, carrying forward USD 76.71513768 in usage/holds and leaving
**USD 58.28486232**. The original 30-minute conditions and results above stay
fixed. Approval is recorded separately in
`/tmp/opencode/swebench-v0128-dev23/campaign-budget-135.json`; the next declared
single-instance experiment targets the timed-out `astroid-1333` under 2,400 seconds.

## Retained evidence and cleanup

Root: `/tmp/opencode/swebench-main-84ccdf1/` (outside Git).

- `conditions.json`, `manifest.json`, package/build/preflight logs and fixed `.tgz`.
- `run/supervisor-state.json`, all 23 child metadata files, 23 credential-free
  usage DBs and 23 replay artifacts.
- `first-completed-model-observation.json` and its native-history snapshot.
- `scoring/` raw reports, evaluator scripts, patches, test output and Docker logs.
- `budget-settlement.json`, `summary.json`, `post-run-analysis.json` with per-case
  patch/evaluator/log/report hashes, base-control results and cleanup audit.
- `base-controls/` initialization evidence and `base-controls-v2/` completed
  supplemental controls.

Integrity anchors:

- Predictions SHA-256:
  `745dbe5840d70c65a6d8aa50ec9dcf17619dfa7669443d5a7c96ca406839c3eb`.
- Final summary SHA-256:
  `6ce625784491a1f9502e821f04b219981d68bb912545c08d487de13c19f7ca08`.
- Official aggregate report SHA-256:
  `6afd50151d74cbd8c14a89d374d28f4b2e8990d0da300c5cd43610d0814c0b32`.

Post-run audit at 05:14 UTC: supervisor stopped, no running Docker containers,
no generated `.opencode/`, dependency/cache or candidate-runtime directories left
under the run root, and preflight environment removed. Runner/preflight cleanup
was automatic; retained DBs, datasets and evidence were not deleted.
