# Python cache isolation for benchmark validation

## Observed problem

In the main-integrated `84ccdf1` dev23 campaign, `astroid-1333` reached the
1,800-second timeout after multiple Worker/validation handoffs:

- The first Worker asked for scope expansion before its declared pytest command
  because Python bytecode and `.pytest_cache/` could be written outside the
  declared source-file paths.
- The next Worker found an independently invalid test selector
  (`AstroidBuilderTest` instead of the repository's `BuilderTest`).
- A third Worker ran the corrected exact command, reported **12 passed**, and
  returned without further source edits. The host settled that unit as
  `process-defect` with no accepted evidence.
- A fourth, validation-only Worker repeated the same command and obtained
  accepted host evidence. Reviewer dispatch began around minute 29.74 and was
  interrupted by the 30-minute timeout.

The native history is retained at
`/tmp/opencode/swebench-main-84ccdf1/astroid1333-timeout-analysis.json` and in that
run's credential-free usage DB/replay. The third Worker's full before/after file
snapshots were not retained, so the exact file responsible for its missing
evidence is not established from that history alone.

There is a reproducible cache-related failure mechanism: `protectedSnapshot()`
hashes every declared source/write path, including directory contents.
`recordHostGoalEnd()` requires that source digest to match its pre-command value.
A cold pytest invocation can pass while writing `__pycache__` files and
`.pytest_cache/v/cache/nodeids`, invalidating this freshness check. A second warm
invocation can pass with no content changes and therefore acquire evidence.

## Adapter correction

The isolated candidate environment now supplies:

```text
PYTHONDONTWRITEBYTECODE=1
PYTEST_ADDOPTS=-o 'cache_dir=<isolated runtime cache>/pytest'
```

The cache directory is under the generated candidate runtime, outside the target
repository. The runner quotes the complete `cache_dir=...` argument for pytest's
shlex parser, including paths containing whitespace or single quotes. The existing
pytest cache provider remains active, with its storage relocated. The prompt
explains the host cache settings so Workers preserve them instead of requesting
repository write-scope expansion for incidental caches.

Candidate metadata records
`python_cache_policy: no-bytecode-isolated-pytest-cache-v1`; the environment and
candidate-evidence hashes include the new settings. Normal candidate-runtime
cleanup removes the cache. Explicit pytest CLI overrides still follow pytest's
normal precedence and may require task-specific handling.

This changes the inference adapter environment. Protected-source freshness rules
continue to detect actual source mutations, and the official Docker scorer keeps
its original evaluator conditions. The runtime archive remains identified by its
fixed package hash; a future evaluation must also pin the new adapter commit.

## No-model verification

A minimal fixture in the recorded `astroid-1333` image ran the same passing pytest
command twice from cold state. Its protected scope consisted of a Python package,
test directory, and `.pytest_cache` path:

| Environment | First invocation | Second invocation |
| --- | --- | --- |
| Previous default | pytest exit 0; protected digest **changed** | pytest exit 0; digest stable |
| Corrected cache settings | pytest exit 0; protected digest **stable** | pytest exit 0; digest stable |

The corrected run created no repository cache files. The isolated pytest cache
contained the expected test node ID, proving that the cache provider was active.
Both fixture variants used identical source/test bytes, a network-disabled
container, and image ID
`sha256:4014d41119b96aa182d1c2b1299c3ec32a6b36ea9ef03e8e90f053b4a535b2b4`.

Automated regression coverage runs a real cold Python import before/after the
cache policy and checks pytest option parsing with a quoted cache path.
`npm test` including build: **378/378 PASS**. `git diff --check`: PASS.

Evidence: `/tmp/opencode/swebench-cache-evidence-fix/`, including the fixture,
baseline/fixed logs, cache-policy JSON, source hashes and `summary.json`.
These checks made **zero model requests**. They establish the cache/freshness
mechanism and correction, not a resolved-score improvement or completion of the
previous timed-out mission.

## Execution order and budget

The user approved an additional USD 50 (cumulative cap **USD 135**) and up to
**2,400 seconds per future inference attempt**. A new unchanged-candidate
`astroid-1333` experiment was started prematurely, then stopped after the user
directed that a fix PR must come before retesting. It was not scored.

That cancellation recorded USD **0.117558** usage and retains USD **1.382442**
for incomplete usage coverage. Together with prior usage/holds, the cumulative
amount is **USD 78.21513768**, leaving **USD 56.78486232**. This reserve is not
finalized provider billing and must carry forward.

The raw runner classified the stopped attempt as `pricing-coverage-missing`;
the separate cancellation record identifies the user-directed stop and leaves
the original metadata intact. All of its CLI/server processes stopped and the
generated candidate runtime was cleaned up. Latest settlement:
`/tmp/opencode/swebench-astroid1333-40m-20260926/budget-settlement.json`.

Proceed with the fix PR and its review/integration before a separately declared
benchmark experiment under the approved 40-minute limit.
