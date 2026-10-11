# v0.13.13 — working context continuity across Worker handoffs

- Integrate PR #188. Retain public parent history at Mission start and refresh root/Coordinator history when preparing Worker handoffs. Supply recent useful tool observations, current Mission progress, attempts and execution observations alongside the original request and requirements.
- Optional `handoff_context` records current intent, rationale, known environment and paths, completed setup/checks, failed approaches and remaining work. No mandatory memo, new approval, permission restriction, controller or model call.
- Preserve exact public text and tool inputs/text outputs in content-addressed snapshots. The bounded inline view exposes omitted/truncated entries, snapshot references and message/call IDs. Partial or unavailable history and missing optional snapshots fall back to retained context without adding a planning gate; private reasoning and synthetic instructions are excluded.
- Stage proposed context with the plan and publish it only after successful preparation. Failed replans retain the current context, execution and cumulative budget. Existing direct execution and formal validation/review/acceptance requirements remain intact; historical success is not fresh evidence.
- Keep Worker instructions concise: assign the remaining useful action and reuse established facts, rather than turning references into a mandatory reread checklist or assigning unchanged discovery again.

## Evidence and limits

See [Mission context continuity](mission-context-continuity.md) for the original PR's two real V2 probes, fixed candidates, actual models, timing, repeated reads and cumulative estimated usage of $0.16259144 with zero unpriced requests. Both original probes completed their task and formal check. They are historical PR-candidate observations, not v0.13.13 benchmark scores or a controlled single-agent speed comparison. This release does not repeat them.

The release binds one integrated `main` commit and one tarball before candidate preflight, mandatory full Linux tests, fixed-commit Windows CI and native CLI Worker startup/model qualification. Reuse that same tarball for both existing npm-global prefixes, OpenCode's config-local dependency, GitHub Release and one npm publication. Receipts: `_testenv/releases/0.13.13/`. No additional SWE-bench or Anko evaluation is launched; active campaign candidates and ledgers remain unchanged.

Compatibility names remain `v010`. Mission marker: `0.13.13-mission-context-v1`. The unchanged Codex skill retains `0.13.11-codex-skill-v2`. Completely restart OpenCode after global application to verify its loaded plugin. Installed bytes and release CLI Worker startup do not establish active-user-session reload, Mission completion or final acceptance.
