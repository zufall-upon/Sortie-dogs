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

## Fixed-release Anko follow-up (Desktop)

This is a separate run of the **released** v0.12.16 archive, not the repacked
dispatch-label fix. The Desktop-owned OpenCode V2 2.0.18 service (PID 41012)
loaded runtime marker `0.12.16-operation-efficiency-v1` and ran one root prompt
(`ses_f1ed65149ffeycrcFhJ6JWYwWy`) against the Anko typed-variable-bindings
task. The initial observer lost its transport connection, but the same root
session and Worker continued; the read-only observer reconnected without a new
prompt. The original 60-minute/$5 estimated-usage bounds stayed in force.

- Native run: 2026-09-27 04:40:01–05:32:59 UTC (52m 58s); one Coordinator
  (`ses_f1ed60843ffeEDIjVcInZDvma9`), four Worker sessions, four independent
  Reviewer sessions, five plans and four units (first failed, next three
  succeeded). Estimated priced model usage: $1.63087728, with zero unpriced
  messages at the final observation and zero user continuation prompts.
- The first independent review found a concrete mismatch in required type-error
  text; the same Coordinator delegated a correction and the candidate gained
  commits `7d6725e`, `1cdd4f7`, `6a4363c`. Subsequent reviews produced three
  `EVIDENCE_GAPS` verdicts, largely requesting excerpts or specific public-test
  traces, not establishing another source defect. The Operator checked source
  and public tests and accepted with those gaps disclosed; no Reviewer PASS.
- The original Anko workspace ended clean at `6a4363c8a47d00a455123b2ea5e4cb6838eeb947`.
  After all ten native sessions stopped, a separate copy received **one** local
  scoring attempt using pinned official test bytes. Candidate patch SHA-256:
  `445e6a391056e0d50c417f2a0ca304d9eeee2eb432620b6a2bb30f8fa010f258`.
  The official test script exited 0: 9/9 fail-to-pass, 94/94 pass-to-pass,
  reward 1. This was a local path-adapted verifier without Docker/Runta, not a
  methodology-comparable hosted score.

The run establishes same-Coordinator correction following a **Reviewer**
finding, autonomous Operator acceptance, and a passing local Anko score. It
does **not** establish an Operator quality-rejection-and-return loop: the
Operator did not reject this candidate. Evidence-only review churn consumed
time, but did not justify further implementation changes after local reward 1.
The launch, native histories, terminal observation, frozen snapshot, patch,
grader logs and result remain under `_testenv/anko-desktop-v01216-1/` outside
Git. No hidden grader bytes were provided to the live agent workspace.
