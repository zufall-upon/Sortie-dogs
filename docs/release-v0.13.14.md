# v0.13.14 — Mission recovery, exact task input and reproduction planning

Includes PRs #190–#207 since v0.13.13, including the two remaining open fixes #196 and #200.

## Runtime and delivery

- Settle completed Reviewer native terminals even when correction validation is stale, missing or failed, so subsequent prompts can continue instead of repeatedly failing with HTTP 500. Invalid self-rechecks do not become accepted verdicts. Explicit acceptance remains strict; recovery refreshes affected checks in the same author/context while retaining completed work and historical receipts (#192, #200).
- Make the existing approved cumulative Mission budget-extension tool visible to the root V2 Operator, including Code Mode search. Preserve root-only ownership, consumed/reserved units and the same Mission; no automatic increase, reset or new approval mechanism (#196).
- Preserve raw heredoc input, escaped quotes and the original task text passed through stdin rather than positional CLI formatting (#193–#195).
- Keep direct-unit completion and submitted Mission evidence readable. Settle incomplete direct delivery without granting acceptance, and retain final parent delivery after background child idle (#197, #198, #201, #202).
- Guide source-backed failure-path investigation without rechecking already covered fallback behavior (#199).

## Planning and maintainer work

- Preserve task-specific dependency setup limits, resolve direct reproduction recipes before registration, and retain public entrypoints, standalone fixture roots and Coordinator regression-test placement (#203–#207).
- Observe native recovery rather than latching obsolete campaign pauses; move the Hermes autodev control plane out of the product repository. Existing sessions, accounting and campaign state are not recreated by this release (#190, #191).
- Silence Ubuntu's interactive-shell sudo banner only inside the benchmark fake-HOME test fixture with `.hushlogin`. This addresses the already diagnosed PR #200 integration-suite failure without changing host shell configuration or product task handling.

## Evidence and limits

The source PRs' native budget-extension and stale-terminal recovery observations belong to their own fixed development candidates. They are not v0.13.14 end-to-end completion or benchmark scores. The PR #200 local integration full-suite failure remains recorded; it is not erased by passing targeted checks or CI. The fixture fix is verified before the integrated release gate.

Bind one integrated `main` commit and one tarball, then run candidate preflight, mandatory full Linux tests, fixed-commit Windows CI and one native CLI Worker startup/model qualification. Use that same tarball for both existing npm-global prefixes, OpenCode's config-local dependency, GitHub Release and one npm publication. Receipts: `_testenv/releases/0.13.14/`. No additional SWE-bench, Anko or historical product-task probe is launched; active campaign candidates and ledgers remain unchanged.

Compatibility names remain `v010`. Mission marker: `0.13.14-mission-recovery-v1`. The unchanged Codex skill retains `0.13.11-codex-skill-v2`. Completely restart OpenCode after global application to verify its loaded plugin. Installed bytes and isolated Worker startup do not prove active-user-session reload, Mission completion or final acceptance.
