# v0.14.0 — advisory routing, autonomous execution

[Product vision and acceptance](v0.14.0-execution-vision.md): Operator recommends an initial executor from the original instruction and known context; Coordinator starts useful work and may implement substantially or delegate remaining work. Capability, requirements, meaningful validation, applicable review and final acceptance remain the completion standard.

- Optional `start_mission.preferred_executor` (`coordinator` / `worker`) persists an advisory recommendation. Coordinator receives supplied unit facts without accidentally pre-starting a Worker. Calls without the new field retain the direct Worker route when unit facts are supplied.
- Align the Operator/Coordinator instructions and host next actions: classification does not require a repository/environment investigation. Explicit user choices govern; an advisory recommendation can change during actual execution without another approval or mandatory reassessment.
- `plan_units(executor: "worker")` with no `units` yields an unfinished direct unit. `handoff_context` carries remaining action and useful observations. The same Mission/run/unit, original requirements, edits, actual authors, check records and budget reservation continue. The original controls remain immutable; continuation context and Task identity switch in one durable run save.
- Wait for existing native commands to settle before transferring writer ownership. A handoff is neither successful validation nor a failed implementation. Replaying the response after reload returns the existing pending Task.
- Reuse current complete direct validation at Worker settlement, with retained native exits and source bindings. Changed source or a later failed check cannot become success through an actor change. Cumulative unit accounting settles once; actual author usage windows remain separately priced, and unavailable usage stays unknown.

Runtime marker: `0.14.0-autonomous-routing-v1`. Codex skill marker remains `0.13.11-codex-skill-v2`. Model route configuration remains separate from executor advice.

## Verification boundaries

Public harness regressions exercise direct completion, a changed advisory choice, partial-work delegation, current-check reuse, actual commit and acceptance. Native hook tests cover cold continuation, cancellation, interrupted state persistence, stale proof, later validation failure and cumulative cost. These scripted transports are deterministic lifecycle evidence, not a live-model task result or benchmark score.

Release receipts retain the fixed commit/package hash, candidate preflight, mandatory full suite, native Windows CI and actual CLI execution/model observations. Existing PR review bodies, ordinary comments and inline comments are collected and dispositioned before integration. Live CLI results, elapsed time, cost and any incomplete outcome are reported separately from startup or test success.
