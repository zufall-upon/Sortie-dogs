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
also passed.

## Installed real-task verification

The qualified candidate at `77c13dc4a0237f48391c9835a347f9ef51f021af` has
SHA-256 `c2d37de400f327de67dd8c27c011d242e153aee41ab0f51d3056521fcf6ec9c1`.
Using OpenCode 2.0.14 and the default SOL6/Luna6 Fast routes, a Japanese
natural-language request exercised the released repository's actual V2 candidate
preflight with the stale campaign profile observed in the incident.

- The first installed trial reached preparation acceptance but failed qualification:
  checkpoint returns lacked the native subagent's structured output. The corrected
  return preserves `sessionID`, native control status and explicit `accepted: false`.
- The corrected trial completed in 208,081 ms, including independent preflight
  re-execution. Two dispatches used the same child, with two internal checkpoints,
  zero failed native child calls and no user approval question.
- Only `candidate.json` changed. The actual preflight verified the published
  v0.11.2 archive, version, v011 profile, runtime marker and hash. All 23 benchmark
  inputs were retained, and the operator inspected the passing formal check.
- The request covered preparation only. The trial did not execute 23 inferences,
  produce a new score, resume the reported session, or establish overnight-loop
  reliability. It used current released source, not the reported older checkout.

Reproduction driver: `_testenv/v0112-dogfood-stall/native-preparation.mjs` with
the candidate archive as its argument. Passing evidence:
`real-preparation/smoke-3/qualification.json` under the same directory. The setup
failure, rejected first candidate and original histories remain retained there.

## Feedback contract

Corrections in the same conversation are retained and delivered to the active
work. This is not cross-job automatic learning: the v0.10 reflection machinery
is not connected to the v0.11 native work loop. Future fixes must use the actual
reported workflow as acceptance evidence, with partial completion explicitly
distinguished from the user's whole request.
