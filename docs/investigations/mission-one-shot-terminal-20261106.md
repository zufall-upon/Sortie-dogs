# Active Mission and the one-shot terminal instruction

## Saved observations and limits

The reported conversation was loaded with `0.16.8-queued-goal-registration-v1`. Its saved diagnostic output showed `FastLaneController.terminalInstructionRequired` changing from false to true after admitting an Advisor request, with zero Worker dispatches. The archived long-running Mission retained the user's continue-until-morning instruction and an Advisor admission; the Advisor's native reuse attempt then failed because the requested session was not a child of that Coordinator. That parent/child rejection is a separate, valid host constraint and is not bypassed by this correction.

The report and saved consultation context retain 102 remaining units, rather than an exhausted implementation allowance. Later requests and Missions have different state; their latest counters must not be retroactively substituted for this older incident. The exact model request that received the old terminal instruction was not captured. Therefore this work establishes a reproducible incorrect instruction path, not proof that it was the sole cause of the historical pause. No original source, model settings, session, artifact, ledger, budget or native parent relation was changed or resumed.

## Reproduction

The shared core's `SORTIE_FAST_LANE_TERMINAL` instruction is intentionally armed by a Worker, Scout, Advisor or review admission in a normal one-shot lane. It tells the model to dispatch at most one Worker, finish review/finalization and report and stop. Before a Mission has planned a unit, no serial-unit grant has yet enabled backlog mode. Consequently a consultation can arm that default during an otherwise active Mission, including before any Worker exists. The profiled system transform previously forwarded the conflicting instruction unchanged.

Public-hook fixtures reproduce the incorrect output in open, running and submitted Mission phases without executing a child/model/Worker. They also retain genuine one-shot behavior outside an active Mission. Merely changing the pure counter helper would not establish correct model-visible output, so tests exercise the profiled system hook and the existing V2 live-state projection.

## Minimal correction

- The profiled system transform reads its existing durable Mission state and removes only the generated `SORTIE_FAST_LANE_TERMINAL` element while that Mission is neither completed nor cancelled. It also removes a stale supplied copy of that same generated block.
- Existing `modelLiveState` classification already knows this block. Its normal withdrawal projection retires a previously sent one-shot instruction without editing native history, adding an artificial user message or adding another state protocol.
- A genuine one-shot terminal instruction remains in force outside the active Mission. Its text now clarifies that this plugin default is not evidence that the user requested a one-unit limit. User limits must come from the original request; remaining budget, actual stop reason, native failure and required acceptance continue to come from existing host records.
- No Worker/consultation counter, budget, validation, formal acceptance, compaction permission, dispatch grant, parent/child rule or automatic recovery mechanism is loosened. No extra approval, monitoring role, persistent schema, user configuration or forced restart is introduced.

## Verification boundary

Regression fixtures cover active open/running/submitted state, completed/cancelled history, root and nested-Coordinator consultation admission before a unit exists, cold plugin recreation, unchanged Mission/Goal/budget/receipt records, and withdrawal of an old generated live-state block. Related Fast-lane, Fast-first, live-state, shared-core and V2 tests retain normal one-shot accounting and controls.

The release procedure separately fixes a main commit and archive, performs packed preflight and one mandatory full suite, verifies actual Worker/model startup, and applies/publishes the same archive. Startup, fixture success and installed package identity do not prove that the original overnight request has resumed or completed. No official benchmark score is claimed. Command/exit/timing, review dispositions and release evidence remain in ignored `_testenv/investigations/20261106-mission-terminal-instruction/` and `_testenv/releases/0.16.9/`.
