# v0.11 native user-proxy qualification

## Execution model

`dog-operator` uses `openai/gpt-6-sol#xhigh` to represent the user and compare the
actual outcome with the original request. One `dogs-coordinator` child uses
`openai/gpt-6-luna-fast#max` for investigation, implementation, tests and corrections.
Revision resumes that same child. Native OpenCode owns execution and compaction;
plugin storage retains requests, feedback, attempts, source identities and check receipts.

The runtime replaces the default proposal/manifest workflow. Existing reviewer
and advisor configuration and historical Terra pricing are retained. v0.10 is
available through explicit compatibility exports and `init --profile v010`.

## Functional evidence, 2026-09-23

The fixed installed `0.11.0` candidate with SHA-256
`0fdd48a01fd9b0e48d22eb60fdc29ad431e37e9e5fc108095d27fda2ecb5f498`
completed two independent tasks in one OpenCode **2.0.14** root session.

- First task: initial test exit **1**, native child compaction, source correction,
  final test exit **0**, explicit operator acceptance.
- Second task: a new work ID and child, fresh request/budget state, documentation
  update, final test exit **0**, explicit acceptance.
- Root: `ses_f321ba4e5ffeuAiEUhy3cVZSa2`; elapsed **166,411 ms**.
- Every observed Luna request selected `gpt-6-luna-fast` and sent API model
  `gpt-6-luna` with `service_tier: priority`, including HTTP compaction/title and
  WebSocket implementation requests.
- Existing tests, project instructions, config, agent assets and plugin wrapper
  matched their initial hashes. The worker made no Git commit.
- Provider metadata reported `default`. This is recorded separately from the
  requested tier; the experiment does not measure a speed improvement.
- Acceptance-time cost snapshots were approximately **$0.0891** combined,
  excluding in-flight acceptance/final responses. They are estimates, not billing.

An earlier attempt exposed a qualification-wrapper bug: `model.list()` returns
`{ location, data }`, not an array. The wrapper was corrected. Two direct-registry
preflight experiments also showed that an unactivated location can report empty
registries; the final driver checks registration during setup and records the
active plugin after native execution. Failed attempts remain in ignored evidence.

The common full suite completed **1,156 tests across 70 files**, with no failures,
skips, missing files or duplicate scheduling. Core tests cover same-child semantic
revision, cold restart, interrupted dispatch recovery, cancellation, source/request
staleness, attachments, native permission denial and migration preservation.

## Single selected dev23 case: release condition not met

On 2026-09-23, **only `pydicom__pydicom-1139`** was selected from the pinned
23-case dev set. The earlier v0.10.23 attempt on that case had ended with an
empty patch after approximately 10.7 minutes.

Frozen v0.11 conditions:

- Runtime source: `dcc70566067a817649e35f829c55da9024f9121d`.
- Candidate `sortie-dogs-0.11.0.tgz` SHA-256:
  `2ddf56bf88210e4efc35cfa53e497c3fbb602d62457bd43cd3097d800d8e55e8`.
- Native driver: `30d793b7073668ae9214f77f31d52ed0c357f830`;
  script SHA-256 `b5ba9cf85fc664d1dcc14215d4806c093a28cd0b641e1946dfffe890f22b8570`.
- OpenCode 2.0.14; SOL6 operator, Luna6 Fast implementer and auxiliary agents.
- One model-bearing inference attempt, 30-minute/$1.50 request-boundary limits.
  A preceding instrumentation failure stopped before any provider request and
  produced no patch; it remains recorded separately.
- Native root: `ses_f320e7cc1ffeY1Ew5SgwmvnH7a`; elapsed **241,775 ms**.
- Operator accepted one child invocation after a current check passed the public
  reproduction, 16 focused/adjacent tests and diff whitespace validation.
- Completed root/child context usage: approximately **$0.1536**, including their
  final responses; transient title generation is excluded. This is an estimate.
- Frozen patch SHA-256:
  `a221b546eaecf76954bf7dd331c4aa90c0e100d78638c2d7797f11d124a50df9` (920 bytes).

### Official result: FAIL

The separate official SWE-bench 5.0.2 Docker run applied the patch successfully,
completed its one submitted instance, and returned **`resolved: false`**:

| Check group | Passed | Failed |
| --- | ---: | ---: |
| FAIL_TO_PASS | 2 | 1 |
| PASS_TO_PASS | 36 | 2 |

The unresolved target is `TestPersonName::test_next`: the patch added character
iteration and membership, but direct `next(PersonName)` raised `TypeError`.
No official test or gold patch was supplied to the inference agents.

The two PASS_TO_PASS failures were `TestBadValueRead` tests whose legacy
`setup()` did not populate `self.tag` under the scorer's pytest 8.3.5. Both also
failed on an untouched base-commit copy in the native pytest 9.1.1 environment.
The five broader charset failures reported during inference reproduced exactly
on that untouched base when run separately (5 failed / 49 passed). These baseline
observations do not turn the missing target behavior or the official FAIL into PASS.

Scoring used Python 3.8.20 in the existing official image, one worker, and the
previously pinned official dataset SHA-256
`3a545a8d8b5af93f80cc1af8e36df7838fc4b81bea7387571465ab367e4d6b6d`.
The official controller exited 0 and left no running containers. The source
patch was frozen before scoring and was not repaired using hidden-test feedback.

**At this stage, release, PR integration and global application were held:** the user's
condition for proceeding was not met. This result demonstrates native execution
completion, but not sufficient correctness for accepting this candidate as a release.
Evidence is retained under `_testenv/v011-dev23-single/` (inference `smoke-2`,
official scoring and untouched-base diagnostic logs).

## Three further dev23 samples: two passing, one unresolved

The user subsequently requested a few other cases and authorized release if the
selected cases had no unmet outcomes or timeouts. Before starting inference, the
three cases below were fixed from different repositories in the same public dev23
set. They used the **same `dcc7056` runtime and `2ddf56bf…e55e8` package** identified
above; the driver ran from `fa5ba11d4f4f121247910c2dfcbe0fadb316a0f9` with its unchanged
`b5ba9cf8…22b8570` script hash.

Conditions: OpenCode 2.0.14, SOL6 operator, Luna6 Fast implementation and auxiliary
requests, one inference attempt per case, three independent inference slots,
30 minutes and $1.50 per case. Each native environment started with Python 3.11.16,
pytest 7.4.4 and setuptools 80.9.0; repository dependencies remained the implementer's
responsibility. Official Docker scoring used SWE-bench 5.0.2, the same pinned official
dataset as above, and one scoring worker. All inference writers stopped before scoring.

| Instance | Native elapsed | Native result | Official result | Estimated cost |
| --- | ---: | --- | --- | ---: |
| `marshmallow-code__marshmallow-1359` | 216,584 ms | Accepted; 912 local tests passed | PASS: target 1/1, regression 76/76 | $0.132142 |
| `pvlib__pvlib-python-1854` | 194,714 ms | Accepted; reproduction and 3 focused/adjacent tests passed | Initial environment failure; PASS after NumPy correction: target 1/1, regression 281/281 | $0.113706 |
| `pylint-dev__astroid-1866` | 297,870 ms | Accepted with an explicit local dependency blocker, after one same-child revision | FAIL: one missing target behavior; pytest 15 passed / 1 failed | $0.209245 |

**Timeouts: 0. Empty patches: 0. Inference retries: 0.** All observed model requests
used SOL6 or Luna6 Fast. Luna selected `gpt-6-luna-fast` and sent API model `gpt-6-luna`
with `priority`; provider-reported tiers remain a separate measurement. Total completed
root/child context cost was approximately **$0.455092**, including final responses but
excluding transient title generation. The campaign ledger carries prior estimated spend
of $31.821748, leaving approximately $17.723159 of its $50 budget.

### Failure analysis and scoring-environment correction

- **Marshmallow:** `DateTime` now reads options from its root schema when nested in
  `List` or `Tuple`. The new regression covers schema-level formatting and round-tripping.
- **PVlib:** the single `Array` input is normalized to a one-item tuple. The initial
  scorer applied the model patch successfully, but test collection stopped because the
  official image's NumPy 2 removed `np.Inf`. Its report consequently marked patch
  application false despite the successful application in the container log. A separate
  diagnostic run added only `pip install numpy==1.26.4` before the existing install step.
  The model prediction, official test patch, assertions, image and grader were unchanged;
  all 282 required checks passed. The initial unadjusted result is retained as a failure,
  and the corrected result is explicitly environment-qualified.
- **Astroid:** the public `TypeError` scenario passes in the official environment, but
  the related invalid hexadecimal-format case raises an uncaught `ValueError`. The patch
  handles only `TypeError`, so this is a genuine missing behavior. Raw pytest output is
  15 passed / 1 failed; the grader groups parametrized IDs and reports target 0/1 and
  regression 10/10. During native work, this experiment's setuptools 80.9.0 constraint
  conflicted with the repository's `setuptools~=62.6` requirement, leaving `wrapt` and
  `lazy_object_proxy` unavailable. The operator noticed the unverified tests, resumed the
  same child for a bounded environment check, and disclosed the blocker on acceptance.
  That local setup issue does not explain away the official `ValueError` failure.

Frozen patch SHA-256 values, in the table's order:

- `d38f9663252f45f61537e377868e7d5dbc907fc9ffcdf59f478337f999cad535`
- `a7ccaa9e1d31be593b7a49916655d26f83cb9297486d7e2eb6632a41727b399a`
- `3245dc3b0502dc1f6e3d02bdf53caa37f505796a876abbf409f24af923530427`

At this stage, the revised release condition was **not met**: one selected case remained unresolved.
No candidate code or generated patch was changed using official-test feedback.
Release, PR integration and global application were held. Evidence is retained in
`_testenv/v011-dev23-sample3/`, including the predeclared selection, native histories,
original scoring, and the separately recorded `scoring-envfix/` diagnostic. These are
three selected cases, not a rerun or success-rate estimate for all 23.

## Acceptance-defect remediation

Investigation after the sampled failure reproduced three runtime defects against the
old candidate: acceptance could select a syntax-only success while a behavioral check
remained unresolved (even after an unrelated source edit and a cold restart); an operator
view did not become stale when check evidence changed without source edits; and a native
shell permission/launch error left no failed verification receipt. All three regression
tests failed before the fix and passed afterward.

Runtime marker **`0.11.0-user-proxy-native-v2-validation`** retains every formal check as
an obligation until it passes on final source. A corrected/combined command needs an
operator-recorded equivalent successful replacement, preserving the original failure.
The operator can read stored check output directly. Missing required verification has a
durable **blocked** state that resumes the same child, rather than a succeeded receipt.
The evidence view now includes check history, and execution errors retain a null exit.

The implementer and operator instructions now require checking neighboring valid/invalid
behavior through the actual changed library/API and diagnosing ordinary dependency setup
errors. No repository-specific exception list, benchmark answer, or hidden test is added
to runtime instructions. The benchmark prompt explicitly permits registry installation of
declared dependencies, and its environment receipt records actual Python/package versions
and pip constraints. The incompatible cross-repository setuptools pin is not reused.

Focused work-loop, native plugin, initialization and benchmark-runner tests passed
**89/89** after the runtime fix. The strengthened lifecycle also tests blocked/resumed
work and evidence-backed replacement of an incorrectly named check command.

The frozen v2-validation candidate at `8a0e27da3db0c9bff1db92494ea350136f0dd694`,
tarball SHA-256 `36b912118a72874dd47f23dcb39cd7808f831f7d22362360ab810770157f0214`,
passed the full **1,160/1,160** suite across 70 files and the native two-task qualification
(root `ses_f31e50232ffe50js2xrk6aFeAm`, 202,499 ms). Failure → native compaction → correction
→ acceptance and the following task all remained functional under the stricter check rules.

Its new Astroid inference completed in 179,441 ms (root `ses_f31e52082fferX9YFoY71xkVPA`).
Dependency installation and real library-level verification now worked: all five formal
checks were current and successful, including 17 tests in the focused file. Nevertheless,
the unchanged official scorer still returned FAIL on the additional invalid-format failure.
The worker and operator checked multiple variants of the same reported error mechanism,
but did not examine the other ordinary failures at the guarded operation. Thus fixing the
receipt defects alone did not establish semantic coverage. This failed experiment is retained
under `_testenv/v011-astroid-remediation/`; it is not counted as a solved case.

The subsequent **v3-failure-boundary** instructions specifically require identifying distinct
ordinary failure mechanisms at a changed fallback/exception boundary, verifying representative
classes through the actual API, and explaining intentional propagation. The operator must
challenge that coverage rather than count variations of one example. This is a general review
rule; it contains no benchmark instance ID, concrete hidden input, or prescribed exception list.

### Targeted Astroid remediation: PASS

The frozen v3 candidate at `7412c7cf28ecf662241aca21237d1cd5a36bf94b`, tarball SHA-256
`858359f3d4fa34a6022599f725330f073826220d54d8c71093ee97dd7ff42e2f`, completed the Astroid
case in **421,768 ms** (root `ses_f31de4140ffe7yf7UM50fQg1eX`, two invocations of the
same child). The operator returned it once to verify pre-edit reproduction and the
actual function-call inference path before accepting.

The implementer independently probed missing arguments, invalid content, incompatible
types, missing attributes and invalid indexing. Its final patch retained the established
`Uninferable` fallback for those ordinary formatting failures and preserved successful
formatting. Both formal checks passed on final source; the focused local test file had
**20 passing tests**. No unresolved checks or timeouts remained.

The **unmodified official** dataset, image, test patch and grader returned **PASS**:
target 1/1 and regression 10/10 grouped checks. No scoring-environment correction was
needed for Astroid. Frozen model patch SHA-256:
`ecc727ad91ca9e8fd0310a7238278954bef551e41fceddcedba0d5175d4a6feb` (1,954 bytes).
Estimated completed root/child context cost was **$0.218191**, excluding transient
title generation. This is targeted remediation after known failures, not a fresh
pass-at-one success-rate claim. The earlier failed attempts remain recorded.

An in-memory replay of the original sample's actual four check receipts and unchanged
source also confirmed that the new host rejects its formerly accepted syntax-only
assessment, identifying the two unresolved behavioral checks. No historical source or
native ledger was rewritten. Evidence is in `_testenv/v011-acceptance-historical-replay.json`.

The prompt-only v3 change also passed **55/55** work-loop, initialization and runtime-asset
tests. Raw native/official evidence is retained under `_testenv/v011-astroid-boundary/`.

### Matching-candidate regression: all three selected cases pass

The other two preselected cases were rerun on that exact v3 package, each with one
inference attempt and the same 30-minute/$1.50 limits. Both completed native acceptance
and separate official scoring successfully:

| Instance | Native elapsed | Local verification | Official result | Estimated cost |
| --- | ---: | --- | --- | ---: |
| `marshmallow-code__marshmallow-1359` | 242,414 ms | 912 tests passed | PASS: target 1/1, regression 76/76 | $0.147360 |
| `pvlib__pvlib-python-1854` | 442,716 ms | 282 relevant-module tests passed | PASS with predeclared NumPy 1.26.4: target 1/1, regression 281/281 | $0.353125 |

PVlib's first full-module check failed due to pandas 3 incompatibility. The implementer
installed a compatible dependency and reran the identical command successfully before
acceptance; the old failed receipt remains in the history. The operator also requested
a same-child clarification of pre-edit reproduction. This exercised the corrected
verification-obligation behavior in an actual repository.

The scoring setup was declared before inference. Only PVlib's environment adds the
already-diagnosed NumPy 1.26.4 preinstall; official test patches, assertions, images and
grader remain fixed. Neither generated prediction was edited after inference.
Frozen patch SHA-256 values:

- Marshmallow: `cf03628d0391f468f4bcbc7f8aac861ebe79994e02fdb07e2099747edd3a58de`
- PVlib: `96572f42f7a307562579472957b9d9f3ddd6f85ce861d2641e2b312da487c760`

Together with the Astroid remediation above, the **same candidate passes all three
selected cases, with zero unmet outcomes, timeouts or empty patches**. This satisfies
the user's selected-sample condition for proceeding to integration and final release
qualification. It remains a targeted remediation/regression set, not a fresh 23-case
success-rate measurement. Raw regression evidence is under
`_testenv/v011-boundary-regression/`. Estimated campaign budget remaining is $16.879999
of $50, excluding transient title generation and release smoke usage.

Final integrated-main commit/package identity, full verification and publication
receipts are recorded with the corresponding GitHub Release.

## Reproduction

For Python inference, prepare a repository-compatible interpreter and record its
versions before starting. Do not globally pin setuptools across unrelated repositories:
their isolated build requirements may intentionally require a different version.
The native driver now records Python/package versions, any inherited pip constraint
file digest, and the exact prompt digest. Registry installation of declared dependencies
is allowed; solution/source retrieval restrictions do not imply offline dependency setup.

```sh
node scripts/user-proxy-smoke.mjs <frozen-candidate.tgz> <unused-evidence-directory>
```

For one case selected from the pinned public 23-row dev manifest:

Keep a sibling `<frozen-candidate.tgz>.json` containing the full source `commit`
and tarball `sha256`. The driver verifies this receipt and separately records its
own commit and script hash.

```sh
node scripts/user-proxy-bench.mjs \
  <frozen-candidate.tgz> <public-manifest-dev-23.json> \
  <instance-id> <unused-evidence-directory> 1.5
```

This native v0.11 driver validates public inputs with the existing manifest lock,
checks out only the base commit, disables web/reference retrieval, keeps one
inference attempt with a 30-minute limit, and checks an estimated $1.50 budget at
model-request boundaries. It preserves native history, acceptance, routing and the
final patch after stopping writers. Official Docker scoring is a separate step
against that frozen prediction; model-reported DONE is not an official score.

The v0.10 supervisor is retained for historical campaigns. Use the native driver
above for v0.11; candidate preflight supports both profiles. Raw histories,
datasets, archives and patches belong in ignored `_testenv/` or `/tmp/opencode/`.
These small functional checks do not establish a general success rate or a
matched cost improvement over v0.10.
