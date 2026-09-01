# Claude Code host capability spike

Observed 2026-09-01 against the installed Windows Claude Code CLI 2.1.224. The WSL CLI was absent.
The documentation review used current official Claude Code documentation and excluded features whose
changelog entry postdates 2.1.224.

## Decision

- CLI and plugin hooks alone: no-go for the enforcement MVP.
- TypeScript Agent SDK: conditional go for the reduced enforcement MVP after the remaining SDK smoke gates.
- Do not depend on hook ordering, hook replay, Agent teams, PostToolBatch, model-switch hooks, or checkpoints.
- Keep continuation, reflection, model-routing parity, and OpenCode result repair outside the MVP.

## Capability matrix

- Pre-tool interception: available. PreToolUse receives session_id, tool_name, tool_input, and tool_use_id.
- Deterministic pre-execution denial: partial. A deny decision blocks the call, but CLI command, HTTP, and MCP
  hook timeout falls through to normal permission evaluation. Agent SDK callback timeout is documented as
  fail-closed.
- Post-tool result handling: partial. PostToolUse exposes structured output and can replace model-visible output.
  PostToolUseFailure exposes an error and correlation ID, but excludes pre-execution denial and some cancellation
  paths. A post hook cannot undo side effects.
- Custom tools: available through MCP. The Agent SDK also supports in-process MCP tools.
- Stable root session identity: available through session_id and explicit resume/session CLI options.
- Stable child identity: available through agent_id and agent_type on SubagentStart and SubagentStop.
- Stable tool-call identity: available through tool_use_id. Child stream messages identify the parent Agent call.
- Message history: partial. Hooks expose transcript_path and the SDK exposes session messages, but hook-time
  transcript content can lag in-memory state.
- Child result access: available through SubagentStop, Agent tool output, and headless child streams.
- Context and system injection: available through system prompt options and additionalContext hook output.
- Final text, turn stop, idle, and session end: available as distinct MessageDisplay, Stop or StopFailure,
  Notification, and SessionEnd events.
- Compaction and same-session resume: available through PreCompact, PostCompact, SessionStart source=compact,
  session_id, and resume options.
- File and session lifecycle: available through SessionStart, SessionEnd, FileChanged, CwdChanged,
  WorktreeCreate, and WorktreeRemove. FileChanged is observational and cannot block a completed change.
- Model selection and switch control: partial. Initial and per-agent models are selectable. PreModelSwitch and
  PostModelSwitch were added after 2.1.224 and are unavailable in the observed CLI.
- Worker selection: partial. Agent definitions are host-controlled, but native subagent invocation is model-mediated.
- Parallel execution, cancellation, and join: partial. Foreground and background subagents exist; the TypeScript
  SDK exposes stopTask and interrupt. Agent teams are experimental and unavailable in print or SDK mode.
- Deterministic hook ordering and replay: unsupported. Matching hooks run concurrently. There is no general event
  sequence, replay marker, exactly-once delivery, or idempotency contract. Host-side deduplication must use stable IDs.

## Local no-write smoke

All runs used `--no-session-persistence`, explicit tool allowlists, one retry, bounded budget, stream-json, and hook
events. Prompts prohibited workspace mutation. No repository file changed.

- PreToolUse deny: pass. The hook returned `SORTIE_SPIKE_DENY`; the Bash call reported
  `non_execution_kind=permission-rule`; no post-tool event fired. Cost: $0.0447975.
- Post success and failure: pass. PostToolUse and PostToolUseFailure fired for two read-only shell calls with
  distinct tool_use_id values, one shared session_id, structured success output, and `Exit code 7`. Cost: $0.0201536.
- Subagent identity and result: pass with budget caveat. SubagentStart and SubagentStop exposed the same agent_id
  and agent_type, the child stream used the parent Agent tool_use_id, and the result contained the child output and
  usage. The task completed, but the final result exceeded the $0.10 budget at $0.1045751 and terminated with
  `error_max_budget_usd`; the CLI budget is not a strict pre-spawn ceiling.
- `--no-session-persistence` prevents durable session reuse but does not promise zero writes to global auth,
  telemetry, cache, or temporary state.

## Reduced MVP boundary

Feasible only through the TypeScript Agent SDK after the remaining gates:

1. Verify local SDK PreToolUse callback timeout denies rather than executes the tool.
2. Verify callback propagation into subagents with stable agent_id and tool_use_id.
3. Verify stopTask cancellation and final result ordering.
4. Add a host-side hard worker budget before dispatch; do not treat the CLI budget as an exact ceiling.

The reduced MVP may include operation manifests, pre-tool write and command enforcement, immutable handoffs,
validation evidence, bounded workers, and a host-side completion gate. Stop hooks may request remediation but cannot
be the sole completion authority.

## Unsupported list

- Sequential deterministic hook composition.
- General hook replay or idempotency metadata.
- Headless or Agent SDK Agent teams.
- Resuming in-process teammates.
- Direct SDK spawning of a named native subagent.
- Complete model-switch interception on 2.1.224.
- Checkpoint restoration for shell changes and most subagent edits.

## Official sources

- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/hooks-guide
- https://code.claude.com/docs/en/sub-agents
- https://code.claude.com/docs/en/mcp
- https://code.claude.com/docs/en/cli-reference
- https://code.claude.com/docs/en/headless
- https://code.claude.com/docs/en/checkpointing
- https://code.claude.com/docs/en/agent-sdk/hooks
- https://code.claude.com/docs/en/agent-sdk/subagents
- https://code.claude.com/docs/en/agent-sdk/custom-tools
- https://code.claude.com/docs/en/agent-sdk/typescript
- https://code.claude.com/docs/en/agent-teams
- https://code.claude.com/docs/en/model-config
- https://code.claude.com/docs/en/changelog
