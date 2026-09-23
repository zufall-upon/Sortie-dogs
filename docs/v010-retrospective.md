# v0.10 retrospective and the v0.11 direction

The v0.10.x line did not demonstrate its intended combination of reliable general
end-to-end execution and lower total model cost. Later releases retained live-session
recovery and acceptance failures despite passing unit tests and isolated CLI fixtures.

The frozen v0.10.14 dev23 evaluation passed **6/23** official cases. Its published
tarball SHA-256 is `f2caf67268a5f69b67a252a0d84bfc5ad09db82684aa8c1e0f5c49f8d2986993`.
It was identified as a temporary, explicitly pinned fallback during v0.11 development;
that did not certify it as generally stable or establish the last fully working release.
See the [historical evaluation](benchmark-v0.10.14-dev23.md).

The proposal workflow made a subordinate author a large execution contract and the
user-facing agent review it. Coordination and contract repair displaced useful work.
The original direction is preserved in v0.11:

- A capable user-facing operator protects the complete request and compares actual
  results with user intent, prohibitions and quality requirements.
- A cheaper implementer investigates, edits, prepares dependencies, tests and corrects
  ordinary failures continuously, resuming the same child when the operator revises.
- Native OpenCode owns execution, compaction, permissions and process cancellation;
  the plugin retains requests and actual validation evidence.
- Scope and quality cannot be reduced to obtain a cheaper outcome. Cost comparisons
  must include investigation, delegation, rework and review.

v0.11 qualification and its retained failures are recorded in the
[qualification record](v011-qualification.md). Selected-case improvements do not
establish a representative success rate or a matched total-cost improvement.

## Historical consultation routing

For the v0.10 compatibility runtime, host-declared
`anthropic/claude-opus-5-5` is the preferred consultation route; absent that model,
the shipped fallback is `openai/gpt-6-sol#xhigh`. Historical Opus 5 and Terra-compatible
pricing remains available for existing records. v0.11 preserves existing reviewer
and advisor definitions during migration.

The published v0.10.14 package predates the Sol 6 / Luna 6 defaults. Its operator,
worker and scout used `openai/gpt-5.6-luna-fast`; coordinator and reviewer used
`openai/gpt-5.6-terra`. Current compatibility-source defaults do not retroactively
describe that older package.
