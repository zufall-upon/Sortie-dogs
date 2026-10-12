# v0.13.15 — native session identity across restart and completion

Integrates PR #210.

- Resolve a resumed session from its current native agent before consulting historical messages. A native child completion's `metadata.agent` names the author, not a selection of the parent session's agent.
- Exclude purely synthetic inbox messages from the legacy history fallback. An empty process-local selected-agent map after restart no longer causes an Operator to be treated as a parentless Reviewer.
- Project the existing native Reviewer correction alias to its logical Reviewer role. Preserve the actual native alias, model, permissions and correction-ownership checks; do not switch agents to recover identity.
- Keep a current Build selection authoritative over old Sortie history. Known native identity does not require full transcript retrieval solely to determine its role.
- No extra approval, redispatch, new Mission, budget reset, blanket tool grant, conversation deletion or duplicated recovery layer. Existing validation, ordinary Reviewer read-only behavior and final acceptance remain intact.

## Evidence and limits

The source PR compared baseline `96c73a4` and candidate `231c687` in isolated OpenCode V2 **2.0.26** using **openai/gpt-6.1-sol#xhigh**, with actual process restarts. The baseline rejected `operator_status/read/shell/execute`; the candidate executed all four on the same imported diagnostic parent session/Mission, and the same imported Reviewer read after another restart. Loaded adapter/implementation hashes were verified and original product state remained byte-identical. Native comparison: **99.490 seconds**, estimated **$0.0986148**, **0 unpriced requests**. This is source-PR diagnostic recovery evidence, not shared-user-session recovery, product Task completion, released-version benchmark performance or a repeated probe in this release.

Bind one integrated `main` commit and one tarball, then run candidate preflight, mandatory full Linux tests, fixed-commit Windows CI and one native CLI Worker startup/model qualification. Use that same tarball for both existing npm-global prefixes, OpenCode's config-local dependency, GitHub Release and one npm publication. Receipts: `_testenv/releases/0.13.15/`. No additional SWE-bench or Anko run, source-PR recovery comparison, active campaign change or product-state repair is launched.

Compatibility names remain `v010`. Mission marker: `0.13.15-native-identity-v1`. The unchanged Codex skill retains `0.13.11-codex-skill-v2`. Completely restart OpenCode after global application to verify its loaded plugin. Installed bytes and isolated Worker startup do not prove active-user-session reload, Mission completion or final acceptance.
