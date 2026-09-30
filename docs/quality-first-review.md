# Quality-first Mission review

## PR proposal and scope

Make Mission review judge the delivered behavior while removing proof-format round trips.
The active v0.13 Fast-lane and Coordinator route share this policy. Existing validation,
actual-operation completion and Operator acceptance still determine whether work is complete.

The historical v0.12.18 astroid-1866 V2 session requested bytecode/pytest-cache settings
under `EVIDENCE_GAPS`, then returned PASS. The two Reviewer sessions lasted 38.309s and
11.349s; these durations are not the total coordination overhead. Official evaluation
still found an uncaught `ValueError`. See the
[recorded behavior-review diagnosis](benchmarks/swebench-v01218-behavior-review-2026-09-27.md).
This is an observed failure mode, not proof that every review is waste or a measured
speedup for this change.

Before this PR, the active Reviewer inherited a tool-free legacy prompt requiring exact
acceptance-to-summary mappings, while the Mission prompt supplied clipped source excerpts.
The host also required two evidence-only reviews before permitting submission. Adding
instructions to ignore minor concerns did not remove those opposing incentives.

## Implemented policy

- `FINDINGS`: a concrete major/medium defect, requirement failure or known missing/failed
  required check. State the affected behavior/input/path, consequence and useful correction.
- `EVIDENCE_GAPS`: consequential uncertainty after available inspection. Advisory from
  the first response; no extra Reviewer or proof-writing Worker is required. It is not PASS.
- `PASS`: no material finding in the review, not an exhaustive proof of all possible paths.
- Original requirements, current source/check binding, actual operation outcomes and final
  Operator acceptance are retained. An advisory review does not turn failed validation or
  an unexecuted operation into success.
- Reviewer uses normal `read`, `glob`, `grep` and `list` tools to inspect relevant source,
  tests and existing outputs. It remains an independent observer rather than an editor.
- The host already supplies the diff, requirements, units and observed checks. Optional
  notes no longer require R-ID syntax, complete prose coverage or an indexed proof table.
  Unit-to-requirement scheduling is generated from the existing plan and is not a semantic
  proof claim. Worker reports changes, checks and actual limitations concisely.
- Clipped context is a signal to inspect source, not to rebuild an evidence packet.
  A completed review on the same run/source/risk is reused when only notes change.
  Verification prompts retain the previous finding and focus on the correction.
- Return reports show advisory notes separately from unfinished work. A note does not
  create a mandatory NEXT action or fabricate a passed independent review.
- Runtime marker changes to `0.13.0-quality-first-review-v1` so asset refresh replaces
  the older tool-free Mission Reviewer. This PR does not publish a new npm version.

## Autonomy / efficiency / visibility check

| Principle | Removed obstruction | Result |
| --- | --- | --- |
| Autonomy | Reviewer cannot inspect a missing line; caller must relay it | Reviewer directly reads/searches using existing host permissions |
| Autonomy | Model must write an exact R-ID coverage table to start review | Optional notes; original requirements remain in the generated prompt |
| Efficiency | Two evidence-gap passes required before acceptance | First advisory verdict permits normal final acceptance |
| Efficiency | Rewritten prose can buy another review of unchanged work | Reuse the completed review for unchanged run/source/risk |
| Efficiency | Clipped excerpt causes another preparation round | Reviewer reads the relevant file during the same review |
| Visibility | Evidence uncertainty appears as unfinished implementation and mandatory follow-up | A distinct advisory note and unchanged native verdict |

No new approval flow, per-read manifest, independent sandbox, security scan, source-read
allowlist, tool-count quota or LLM judge is introduced. Existing native permissions own
access; no special grant is needed to inspect a file outside the Worker's write list.
The legacy non-Mission Reviewer is not used as the active Mission policy template.

## Verification and limitations

Regression coverage exercises a real host-observed validation followed by the first
advisory review and successful completion without another Worker/Reviewer, both direct
and Coordinator completion paths. It also covers optional/malformed-label notes, reading
outside the unit's declared inputs, unchanged-note review reuse, clipped-context guidance,
durable reporting, blocking concrete findings, stale candidate/check results and NO_START
operations. Installed Reviewer assets expose read/search without editing authority.

This does not assert that a language model will always classify a finding correctly.
We deliberately do not add another model to approve or rewrite Reviewer verdicts. Compare
elapsed time, review-only round trips, real defect corrections and official outcomes on
fixed single-case runs before claiming a quality or speed improvement. Preserve the same
candidate package, conditions and campaign budget within each run.

### Recorded checks (2026-09-30)

- Linux `npm run test:full`: 87 files, 1,362 tests passed, zero failures/skips.
  After the final excerpt-guidance wording change, build and 140 related tests passed.
- Native OpenCode V2 `2.0.18`, runtime commit
  `a13be3b3d7d018cce2f15fe2e47ad79cbc0fe060`, package SHA-256
  `971776297339f0d99808b2457fabf76c8aa1606bd2baab110f17c4229b7758a2`.
- A fixed `formatCount` compatibility fixture required zero/positive success, RangeError
  for invalid numeric input and TypeError for non-numbers. The task requested independent
  review with a direct read of `reference.md`; it is a targeted runtime check, not a benchmark.
- One Worker and one Reviewer, no Coordinator or evidence-only retry. Worker actually
  used `openai/gpt-6-luna-fast#max` (first model message at 25.544s); Operator and Reviewer
  used `openai/gpt-6-sol#xhigh`. Reviewer completed five native reads and returned PASS;
  Mission completed with a succeeded receipt. Total elapsed: 136.093s.
- Estimated model cost: $0.209697, unpriced requests: 0. Campaign cap: $1; timeout: 240s.
  Two reads of an absent `AGENTS.md` returned file-not-found (one per child). Neither caused
  a review retry or completion failure; this run is not described as error-free.
- Root session: `ses_f103021eaffeRAZvTiegIBmebM`. Local ignored evidence:
  `_testenv/quality-first-review/` contains the launcher/prompt, fixed package and hash,
  test logs, budget, summary and `smoke-1/observation.json` plus CLI logs and candidate.
  The completed probe's generated plugin installation is removed after preserving records.

The first-advisory-verdict completion path is covered by regression tests. This native
run returned PASS, so it does not demonstrate an actual model's EVIDENCE_GAPS completion
or quantify saved time against a baseline.
