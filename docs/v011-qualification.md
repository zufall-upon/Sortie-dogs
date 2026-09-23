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
