# v0.12.18: behavioral review and avoidable control work

## Frozen observations

The audit used the completed public v0.12.18 dev23 run `swebench-1790498139971`
(runner `27c96ca64ada6c52e0bc00f42155d82ca85fe3fe`, package SHA-256
`e08d104abca51cd2f21ff2412cc8fac64abbbab908b9049daa3a521ad89aa297`).
Official result: 7/23 resolved. These observations do not revise that score.

For each of the 23 retained `usage/opencode.db` snapshots, inspect `session_v2`
joined to `session_message`, in session creation/sequence order. Examine tool
inputs, errors and returned content as well as Reviewer text; configuration alone
does not show what actually ran. Raw databases, manifests and scoring logs remain
under `_testenv/swebench-v01218-dev23-20260927/` in the benchmark checkout.

### Lost and gained resolutions

- **astroid-1866:** v0.12.7's first Worker already handled both `TypeError` and
  `ValueError` from the same formatting call. v0.12.18 handled only `TypeError`;
  its reproduction and 14 focused tests passed, but official evaluation reached
  an uncaught `ValueError`. The newer Reviewer requested bytecode/cache evidence
  before passing the candidate, without identifying that behavioral hole.
  The new attempt finished normally in 299,253 ms for $0.33764228, below its $2
  limit. Both versions actually used Luna Fast/max Workers and Sol/xhigh reviewers.
  Neither budget exhaustion nor a different model explains this observation.
- **sqlfluff-2419:** the two versions' product changes were equivalent. The old
  attempt added `test/rules/std_L060_test.py`, colliding with the official test
  patch. The new test used another path. The score difference alone is therefore
  not evidence of improved model capability.

### Friction across the 23 V2 histories

| Observed case | Avoidable work | Change |
| --- | --- | --- |
| astroid-1866 | Settings-evidence review round while an uncaught sibling failure remained | Review the underlying operation and supported failure inputs; distinguish behavioral evidence from incidental workflow attestation |
| astroid-1333 | A sole unit was refused for omitted `requirement_ids` | A sole unit inherits the existing requirements; explicit partial/multi-unit mappings still expose omissions |
| sqlfluff-1763 | `[focused, adjacent, focused]` was refused as `schema_uniqueItems` | Keep the last occurrence of each exact normalized check, preserving the final proof command |
| astroid-1268, astroid-1333 | Explicit later `R4/R5:` or `R4:` labels within an existing trace were treated as missing | Recognize requirement labels at sentence/line boundaries as well as at the start of an item |
| pydicom-1256 | Three long reproduction declarations returned only `schema_maxLength`; the Coordinator shortened the wrong text and retried | Permit 8,192-character commands consistently in handoff/manifest/goal evidence; return existing field/length/limit diagnostics with the local recovery action |

The Reviewer histories contain 24 PASS responses, 3 EVIDENCE_GAPS responses and
1 FINDINGS response (responses, not distinct instances). Recorded `plan_units`
tool errors were three length errors, two coverage errors, one duplicate-command
error and one transport error. There were two review-trace parsing errors.

## Implementation principles

- **Autonomy:** the host handles unambiguous scheduling and formatting details.
  The original requirements stay in the Worker handoff and Operator comparison;
  generated coverage is not a claim that a command proves the whole request.
- **Efficiency:** formal checks are deduplicated without moving the final proof;
  incidental settings do not require another dump/review in the absence of a
  contradiction. Source/API-backed failure inputs take priority over exhaustive
  route inventories. Existing successful evidence is reused where applicable.
- **Visibility:** rejected plans expose the existing structured diagnostics and
  next action. Prior state and cumulative spend survive a rejected replan.
  Review distinguishes a demonstrated defect from missing evidence.

The installed Reviewer and host-generated mission review share the same guidance.
It asks for concrete failures supported by public source/tests/API behavior, not
benchmark-specific exceptions or catch-all handlers. Corrections use the existing
Operator → same Coordinator → Worker path.

## Adjacent paths examined

The active mission route already permits native read-only investigation, setup
inside the Worker, local write-scope expansion through Coordinator, and
evidence-only review references without another Worker. Native permission handling,
validation retry/reuse, replan preservation and review lineage were also inspected.
The scanned histories did not show a returned `PROCESS_DEFECT` report or a
`SORTIE_*DENIED/BLOCKED/REJECTED/REUSED` marker in tool result content; this is not
a claim that all possible permission paths are friction-free.

`astroid-1978` stopped on missing usage coverage and `sqlfluff-1763` hit the hard
timeout. Those remain separate accounting/runtime investigations. In particular,
the timeout includes a public-route reproduction gap and generated dbt files;
the duplicate-command repair alone cannot be credited with recovering it.

The separate focused-excerpt allocation issue is already addressed by
[PR #105](https://github.com/zufall-upon/Sortie-dogs/pull/105): short references
release unused excerpt space to longer branches. That is complementary to this
change in what the Reviewer assesses; its source allocation implementation lives
in `src/plugin/mission-review.ts`.

## Verification

`npm run test:full` passed on Ubuntu: 81 files, 1,309 tests passed, zero failures
or skips. `git diff --check` passed. Log: `_testenv/behavior-review-full-test-2.log`.

Regression coverage checks actual generated handoffs/manifests, retained final
proof commands, multi-requirement coverage, long-command dispatch/execution,
inline trace mapping, and old-run/budget preservation after rejected replans.
The installed/dispatched review guidance is checked for consistency. Those tests
establish runtime behavior, not an LLM's ability to discover the missing failure.

Any additional single-instance inference/evaluation is an improvement experiment,
separate from the already completed one-attempt dev23 campaign. Freeze its commit,
package hash, public input, model, environment and budget before inference.
