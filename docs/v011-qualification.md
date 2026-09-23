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

**Release, PR integration and global application remain pending:** the user's
condition for proceeding was not met. This result demonstrates native execution
completion, but not sufficient correctness for accepting this candidate as a release.
Evidence is retained under `_testenv/v011-dev23-single/` (inference `smoke-2`,
official scoring and untouched-base diagnostic logs).

## Reproduction

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
