# v0.12.1 — V2 tool portability hotfix

v0.12.0 registered Sortie tool schemas with OpenCode V2 even for ordinary
Build sessions. A provider rejected a schema before the agent could respond,
including with no Sortie mission in progress. This is a critical portability
regression.

- Hide all Sortie tools from non-Sortie model requests, leaving native Build
  tools and explicit agent/model selections intact.
- Supply finite integer bounds recursively in native V2 string and array tool
  schemas. Missing limits could be emitted as invalid nulls by a provider.
- Keep mission tools visible only to their applicable Operator, Coordinator,
  and Worker roles; legacy proposal tools remain hidden.

The CLI gate stops immediately after the first actual Worker session is observed.
No real-task completion or 23-case benchmark result is claimed. Restart OpenCode
fully after installation to reload the updated plugin and runtime assets.

Runtime marker: `0.12.1-v2-tool-portability-v1`.
