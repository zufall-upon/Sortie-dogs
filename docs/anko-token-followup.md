# PR #146: prompt duplication and non-regression follow-up

Baseline: `cb8ec24933ec162ce5caba97f45c45a5a9b1a360`.
This is a source/test correction, not an Anko completion, release or global apply.

## Investigation

- The generated Mission Worker instructions contained 9,389 characters before
  inherited project instructions, tool schemas and dynamic system context.
- The Worker Task repeated objective, acceptance, formal checks and common role
  instructions already available in the required handoff/system. The handoff
  read was already mandatory; moving these copies there adds no ordinary read,
  model summary, contract authoring or approval round trip.
- Saved original Anko history, not the later Ubuntu PR probes, records 33 Worker
  assistant requests: input 155,911, cache read 3,031,040, output 13,178 and
  reasoning 37,403 tokens. These totals include source reads, tool results and
  conversation history. They do not isolate the cost of duplicated instructions.
  Its first Worker prompt was 3,894 characters.
- The latest Ubuntu probe's raw history was unavailable in this Windows lane.
  Neither actual API-token savings nor Anko completion speed was measured here.

## Changes without weakening the requested work

- New Mission Tasks reference their existing host-generated handoff. Opaque
  identities, source manifest, assigned indices and conditional post-commit Git
  boundary remain. Objective, original requests, complete acceptance, negative
  constraints, formal checks and fixed launch conditions remain verbatim in the
  existing handoff format. No truncation or model-authored replacement.
- The shared engine uses this reference only after its existing exact Mission
  dispatch admission. It still inspects registered handoff/manifest identities,
  ledger, task and goal. A prompt marker alone is not authority. Generic/legacy
  dispatch keeps its inline acceptance validation and original Task text.
- Worker instructions use a Worker-only validation projection. Same-Task scope
  repair, setup, exact validation, public reproduction, source-backed adjacent
  failures, return/error/post-failure state, independent Review and failure
  reporting remain. Coordinator/Operator workflow and the separate Luna fabric
  asset are unchanged. No model default, budget or review policy changed.
- Path projection supports new reference headers and saved absolute/legacy
  headers, stopping at the first header boundary rather than rewriting user data.
- WSL `/mnt/<drive>/...` scratch paths resolve to native Windows project paths
  in both preparation and freshness. External drives, control directories and
  unresolved variables are not inferred as local scratch.
- Current materialized exact outputs and Git-tracked source override old scratch
  exclusions in both validation freshness and Review. The saved proof is never
  rewritten. True cache generation/cleanup and absent scope-only grants preserve
  proof; a newly delivered file makes old PASS insufficient for completion.

Full `operator_status`, durable `workerContext`, dynamic launch-condition context,
handoff storage and recovery information are deliberately retained. Those are
remaining payload-reduction opportunities, not silently removed capabilities.

## Reproducible payload measurement

Fixed synthetic contract: 2,337-character objective, exact public entrypoint/input,
two criteria, and 1 attempt / 3,600 seconds / $5 / no grading conditions. Both
production generators were executed with the same inputs; this was not a model run.

- Worker instruction body: **9,389 → 7,413** characters / UTF-8 bytes, about 21% less.
- Expanded Task: **4,991 → 1,301**, about 74% less.
- Required handoff: **4,432 → 4,432**, unchanged.
- These three payloads combined: **18,812 → 13,146**, about 30% less.
- Non-Mission Task comparison: byte-identical after normalizing only generated
  project/run identities. Objective, criteria, checks and conditions preservation
  assertions passed.

Raw script, before/after prompts, handoffs, input/source hashes and JSON:
`_testenv/pr146-token-followup/`. They are generated local evidence, excluded from
Git. Counts exclude inherited instructions, tool schemas, retained dynamic context
and subsequent tool results; **30% is not an API-token or cost-saving claim**.

## Validation and consultations

- Before implementation, targeted reproduction: **51/56 PASS, exit 1**; the new
  Task-duplication and four validation/Review promotion regressions failed as
  expected. Windows reproduction: **7/8 PASS, exit 1**, WSL paths incorrectly `[]`.
- An intermediate Task reference failed shared-engine admission. It was repaired
  using the existing host-owned Mission admission, not by bypassing identity or
  accepting arbitrary references. Existing dispatch/ownership regressions pass.
- First integrated `npm run test:full`: **exit 1**, 132.173 seconds including
  preparation. It stopped on four obsolete prompt-wording/duplication assertions.
  Tests now verify the same reproduction, complete acceptance, coverage and
  post-validation Review requirements in the mandatory handoff plus Worker system.
- `npm run test:targeted -- test/operator-mission.test.ts test/anko-recovery.test.ts`:
  **51/51 PASS, exit 0**, test phase 3.415 seconds after those corrections.
- Integrated `npm run test:full`: **1402/1402 PASS, exit 0**, 90/90 files,
  valid scheduler, no skips or cancellations. Test phase 162.970 seconds;
  snapshot/setup/build/test total 178.152 seconds. Source SHA-256:
  `f0abef051d6d6bd6a3b644f11d645d976254b4f01ff94deef90dceb53e1d3da3`.
- Subsequent `npm run test:windows`: **8/8 PASS, exit 0**, build 8.570 seconds,
  test phase 3.762 seconds, including WSL normalization/preparation and owned
  process cleanup.
- The final first-boundary path-selector correction was made after the full
  snapshot. The complete `test/v2-plugin.test.ts` was then targeted: **39/39 PASS,
  exit 0**, test phase 2.502 seconds. The Windows npm invocation stripped its
  requested name filter, so all 39 tests ran, not just the two intended projection
  cases. The full result above describes its pinned snapshot, not a fabricated
  fresh full run after that selector change or this documentation.
- Two requested `openai/gpt-6-astra` consultations: design and read-only final
  diff audit. The latter found no concrete major/medium regression in the inspected
  changes. Neither consultation is independent Anko Review or a Mission PASS.
  Consultation cost/usage was not collected; no additional Worker/benchmark/model
  comparison campaign was launched, and the entire lane is not claimed to cost $0.

Full and targeted commands, source SHA-256, stdout/stderr and terminal exits remain
under `_testenv/wsl-*/`. Windows output remains in the host command log. No repeated
full suite solely for the final projection check or documentation update.

## Still unresolved / not demonstrated

- Unregistered private/standalone V2 servers can still lack descendant history.
  Dispatch alone does not prove no descendants. Returning `[]` on observation
  failure or dropping terminal reconciliation would weaken correctness; neither
  was done. A host-owned history capability is still needed, not a routine demand
  that the user register or restart their environment.
- Canonical Windows Anko `run-once.mjs`, exact inputs/flags persistence, real
  completion speed, independent Anko quality and actual usage comparison remain
  unestablished. Small fixture success is not substituted for these outcomes.
- No merge, package publication, tag, release, global installation or active
  benchmark candidate change in this lane.
