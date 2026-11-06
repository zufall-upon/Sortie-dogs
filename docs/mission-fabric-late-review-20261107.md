# Mission Fabric late-review corrections

Base: `11e90b6b923af0de95d82a09d63d27c768ad7196` (PR #340).

## Existing review disposition

The PR body, both submitted reviews, its ordinary comment and all four inline
findings were retrieved. All four findings are valid against the integrated base:

- `4493233600` (P1): combined checks directly spawned a shell, bypassing native
  permission handling. `review_mission` now prepares the candidate and returns
  exact ordinary native `shell` input. The Coordinator executes that input and
  returns to Review. Existing Goal validation reservation/settlement binds the
  actor, call, command, directory and candidate. Only successful native evidence
  can authorize integration; lost after-hooks are reconciled from native history.
- The P1 regression also exposed a V2 adapter issue: legacy hooks could promote a
  native ask/deny to allow. Permission effects now compose as `deny > ask > allow`.
  Saved approvals and interactive decisions remain native host responsibilities.
- `4493244000` (P2): opening the shared inventory could orphan another Mission's
  dirty worktree. Exact inventory identities retain ownership despite dirt;
  cleanup still requires the existing exact identity and clean/scope checks.
- `4493244007` (P2): a settled failed sibling blocked an explicitly prepared
  same-scope retry. Such retries can now dispatch while retaining cancellation
  checks and all earlier dispatch accounting.
- `4493244017` (P2): `diff.noprefix=true` broke integration patches. Patch generation
  now explicitly selects `a/` and `b/` prefixes.

No finding was classified as a false positive. CI success on #340 did not resolve
these findings; the corrections and their specific evidence do.

## Follow-up review on #341

Both already-triggered reviews completed before integration. Two P2 findings were
valid against `dbb9533a715e21529e154535ef2ba612b1fb7b02`:

- `4494426638`: an interrupted combined check could not be retried after native
  permission rejection. The existing one-time interrupted-validation reopen now
  accepts a Fabric-specific host binding (Goal/run, native actor and exact evidence
  key), without fabricating an Operator repair unit. Review returns the original
  shell input with the interrupted call reference; a requested retry still passes
  native permissions. Earlier consumption/settlement remains, and the new attempt
  receives a separate reservation. In-flight, cancelled, changed-candidate and
  second-reopen cases remain rejected; successful evidence is reused.
- `4494426654`: the retained V1 named factory's after-hook lacks V2's `status`.
  A normal V1 after-hook with a numeric exit now supplies completion evidence.
  Missing exit and explicit error/cancellation still cannot produce PASS.

The designated architecture consultation supported both fixes and specifically
required a real Fabric authorization branch instead of a fictitious repair unit.
The additional recovery paths are exercised with model-free regressions.

## Validation

- `npm run test:targeted -- test/mission-fabric.test.ts test/worktree-lifecycle.test.ts test/v2-plugin.test.ts test/fast-lane.test.ts`:
  exit 0, 19.764 seconds including build.
- Coverage includes native allow/deny/ask/cancel, all native/legacy effect pairs,
  changed-candidate rejection, cold reload and lost after-hook recovery, concurrent
  inventory ownership, sequential retries after two failures, and diff prefixes.
- Original correction tree: `npm run test:full`, exit 0, 425.032 seconds including build.
- Follow-up regressions cover deny/ask → interrupted settlement → cold retry →
  native allow → successful Review, refusal on retry, exhausted budget, stale
  authority, in-flight duplication and the existing one-reopen limit. The raw V1
  positive/missing-exit/cancellation selection passed in 4.368 seconds after fixing
  the fixture's shell-name mapping. The final integrated-candidate full-suite result
  is retained in `late-review-followup-full.json` and PR #341.

## Installed-package native CLI

- This native smoke covers the original correction tree `dbb9533a715e21529e154535ef2ba612b1fb7b02`;
  the subsequent interrupted-retry/V1 fixes use the related and full-suite evidence
  above rather than another paid repetition of the unchanged native allow path.
- Command: `node _testenv/investigations/20261106-vision-v2/fabric-pilot.mjs --mission --native-checks --attempt=late-review-mission --candidate=late-review-candidate.json`.
- Fixed package SHA-256:
  `313a7a6280f458b21dba8445fae2cfade7756a785a6543cd989f00b20aa15a22`.
- Actual Workers: two `openai/gpt-6-luna-fast#max` sessions, separate managed
  worktrees, same foreground round, 50.739 seconds overlap. Operator, Coordinator
  and independent Reviewer used `openai/gpt-6.1-sol#xhigh`.
- Both combined-candidate checks ran exactly once through ordinary native
  `shell`, each with exit 0 and an actor/call-bound Goal settlement. Four total
  checks (two Worker, two combined), zero remaining validation reservations.
- Mission completed; independent Review PASS; succeeded receipt; no native
  errors; three generated worktrees cleaned up with no retained conflicts.
- CLI elapsed: 269.268 seconds; wrapper including installation: 280.692 seconds.
  This is an explicit parallel Mission smoke, not a formal benchmark score or a
  claim of speed/cost improvement. Generic probe `accepted=false` remains recorded
  because its default-Worker predicate expects another model; the dedicated
  receipt verifies the explicitly requested Luna pair and native validations.
- Native usage estimate: $0.37528512, zero new unpriced requests. Existing
  cumulative ledger: $4.02745904 accounted, $97.47254096 remaining of $101.50,
  retaining the earlier uncertain-root hold. Parent chat/web billing is excluded.
- After owned processes stopped, generated plugin dependencies/cache were removed;
  package/hash, database, source, Mission/Goal state, logs and costs remain retained.

Local raw evidence is retained under
`_testenv/investigations/20261106-vision-v2/late-review-*`.
