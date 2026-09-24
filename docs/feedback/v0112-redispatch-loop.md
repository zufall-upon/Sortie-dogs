# v0.11.2 dogfooding: repeated interruption during real preparation

Reported 2026-09-24 against release `e36ad2797bd514b68cd1c8273e04400371ee5d12`.

## User-observed problem

A normal request to run the released version on the existing 23-case benchmark
and continue improvements became repeated `planning-timeout`, `discovery-limit`
and cancelled native child calls. The user had to supervise the supervisor.
Internal component tests and small qualified tasks had not established this
ordinary preparation-to-execution workflow.

## Observed evidence

- The same child reached eleven dispatches while the operator repeatedly
  inspected configuration, returned corrections and requested the next dispatch.
- The child produced commands, edits and formal failed preflight checks.
- The default review clock was 60 seconds / 12 unreviewed tool calls. The timer
  could interrupt an already submitted model response after a further 10 seconds,
  discarding its unfinished reasoning before it could emit the planned action.
- The source checkout used an older V1/v010 benchmark adapter while the installed
  package was v0.11.2. The current main already contained the V2 preparation path.
  Runtime package identity alone did not establish that the checkout was current.
- The operator eventually obtained a campaign budget, but that did not resolve
  the interruption loop. Budget approval is not evidence of useful progress.

Native histories are retained locally under `_testenv/v0112-dogfood-stall/`.
Their prompts, reasoning state and detailed provider records are not published.

## Correction

Protect a real primary provider request, on HTTP and WebSocket transports, until
it returns to a tool or the next native request boundary. Keep the native
provider timeout and explicit user cancellation. A stalled pre-provider handoff
still has a watchdog. Return a locally generated, unsent-request checkpoint as
a checkpoint rather than presenting it as a failed child execution. Preserve
genuine failures and every required verification obligation.

Keep elapsed-from-request, last observed activity and operator-reviewed progress
as separate clocks. Activity never certifies relevance or accepted completion.

Two regressions first failed against v0.11.2, reproducing the discarded response
and failed control return, then passed with the correction. The work-loop suite
also passed. Installed real-task verification and its exact coverage are recorded
in the release evidence; component tests alone do not close this incident.

## Feedback contract

Corrections in the same conversation are retained and delivered to the active
work. This is not cross-job automatic learning: the v0.10 reflection machinery
is not connected to the v0.11 native work loop. Future fixes must use the actual
reported workflow as acceptance evidence, with partial completion explicitly
distinguished from the user's whole request.
