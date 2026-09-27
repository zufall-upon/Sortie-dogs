# v0.12.16 Coordinator dispatch label regression

## Observed failure

The fixed v0.12.16 archive from release commit `9b05a348` has SHA-256
`c1be3bef739390f9ae93c51316a350584b0cc1e9e41c1a537101bce0288f85b9`.
In a real OpenCode V2 2.0.18 private-server session (`ses_f1ee9e677ffeOOSEqQ0zz5JhWy`),
the Operator sent the returned opaque `SORTIE_MISSION_REF` and the correct
`dogs-coordinator` route, but summarized its display-only `description` as
`normalizeTag の修正と採点`. `mission-dispatch-not-authorized` rejected this initial
Task solely because the description did not equal the first requirement verbatim.
The Operator then retrieved status and retried the same dispatch. No Worker
started before the diagnostic driver timed out at its former 30-second wait.

The dispatch reference already binds the original user request and requirements.
Keep its prompt and agent checks; accept an alternate presentation label. A
focused test also rejects a changed prompt and checks that the Coordinator receives
the unchanged original request and both requirements.

## Real V2 observations and limits

- The first isolated-DB attempt (`ses_f1eeb68b0ffeADgMfgzXV11qcT`) could not
  resolve `openai/gpt-6-sol`, before any model request. Subsequent attempts used
  the existing host model route and an isolated project/plugin installation.
- The interrupted release attempt above had one native dispatch denial and
  estimated priced usage $0.053626, plus two unfinished assistant messages
  without complete token pricing. Its driver timeout is **not** a mission result.
- A fresh release session (`ses_f1ee809b4ffe4EsUO82OfmuxDn`) completed one
  Coordinator, one Worker, one independent Reviewer and Operator acceptance in
  135.920 seconds, with `node grade.mjs` reward 1, no user continuation and
  estimated usage $0.199659. No quality rejection occurred in this run.
- The locally repacked fix has SHA-256
  `f834ac6d5ceb441163f3321f9def9d649b9c3d7a06527cc1ed4d984793a017ed`.
  A fresh session (`ses_f1ee43b09ffefApzm3JlF9E5Gr`) explicitly requested a
  short Coordinator description. The Operator sent `タグ正規化と採点` while retaining
  the opaque reference and agent; dispatch succeeded without a denial. The
  Coordinator handled an initial Reviewer evidence gap and a second review PASS;
  the Worker produced reward 1 and the Operator accepted. Elapsed 241.563 seconds,
  estimated usage $0.201285, zero user continuations.

The fixture is a small implementation task, so it can be Fast-lane-eligible even
though these particular runs used Coordinator. It did **not** produce an
Operator quality-failure rejection, run the Anko benchmark, or prove that the
same-Coordinator rejection/correction loop works. No Desktop-owned service was
available after global installation; these sessions used a private real V2 CLI
service, not Desktop. Usage across the four attempts is approximately $0.454570
in priced messages plus the two unfinished messages above, not a billing amount.
Native histories (a read-only DB extraction for the driver-interrupted attempt),
isolated fixture sources, package archives, hashes and generated-install cleanup
record remain under `_testenv/` outside Git.

`npm test` passed the WSL quick suite (384 tests) with the fix. The unit test
specifically covers the previously rejected presentation-only change.
