# Mission operation recovery — v0.12.11

## Observed cause

The September 26 v0.12.10 Desktop mission spent five Worker attempts preparing its
candidate before the sixth succeeded. Its generated manifest contained
`_testenv/swebench-v01210-dev23-night/**`, but the gate treated `**` as a literal
path. Missing directories also lacked explicit directory identity. Other attempts
stopped on local `git archive`, read-only `git tag --points-at`, or curl's
`--write-out` metadata. A blanket `retry=false` returned these format failures to
Coordinator even when the operation and destinations did not need to change.

The root and Workers were Luna Fast/max and Coordinator was Sol/xhigh. This
establishes concrete orchestration friction, not a model-quality comparison.

## Changes

- Directory declarations use `dir/**`; trailing slash input is canonicalized by
  mission planning. Gate, manifest comparison, protected snapshots, Git scope
  checks and review resolve the same directory, including before its creation.
  Exact file scopes retain their previous meaning.
- Local Git archives classify stdout or the explicit output file, while read-only
  tag queries classify as observation. Curl's stdout `--write-out` metadata is
  supported alongside one HTTPS URL and explicit output destination.
- A mission Worker receives a same-Task format-correction instruction for an
  unsupported download/archive form. It preserves operation and destinations;
  scope changes return the exact `expand_unit` remedy to Coordinator. Unchanged
  denied requests are still diagnosed as repeats.
- Packaged Coordinator and Worker guidance describes the same supported forms,
  directory notation and reuse of known setup/evidence. No additional approval
  step is introduced.
- Mission packets expose current completed/running/pending/failed unit counts
  separately from historical failed attempts and final acceptance. Budget packets
  label settled Worker-ledger cost, unknown usage and in-flight accounting;
  orchestration/review and external campaign costs are not claimed as included.
- Reflection remains opt-in. Existing restart-safe project injection is verified;
  Operator guidance carries relevant prevention into Coordinator feedback. The
  Japanese and Chinese configuration references now describe v0.10 support.

## Verification

`test/operation-recovery.test.ts` exercises production mission planning, generated
controls, a newly created directory, a real local Git archive, protected byte
fingerprints and ignored review artifacts. It also checks the observed curl/tag
forms, same-Worker format recovery and precise scope correction diagnostics.

Related tests cover legacy scope behavior, source freshness, mission continuity,
reflection persistence/injection, native profile hooks and package loading.

`scripts/operation-recovery-probe.mjs <fixed.tgz> <evidence-directory>` runs a real
isolated OpenCode V2 mission with Luna Fast/max as root and Worker. It requires one
Worker to create the candidate tree, archive local source, download a pinned
public input, write a receipt, execute the validator and reach mission completion.
Timeout is 600 seconds; priced usage cap is $1.50. Actual sessions/models, errors,
cost estimates and unresolved pricing are retained in the observation JSON.

Release-specific live results and fixed package hashes belong in
`_testenv/releases/0.12.11/`. A successful isolated mission is evidence for this
preparation path; it does not establish completion of an existing Desktop campaign
or a new SWE-bench score.
