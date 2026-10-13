# Cycle051: retained validation-input freshness diagnosis

## Finding

The Cycle050 same-session validation detour was necessary, not a false freshness
rejection. No production code, acceptance rule, owner, evidence identity, budget
or stop condition changes are justified by this retained event.

The first pytest command exited 0 with 137 passed but created
`test/fixtures/cli/fail_many_fix.sql` inside the declared
`test/fixtures/cli/**` read scope. That file was also an exact declared output.
Its Git-ignore entry does not make it an irrelevant validation input.

A read-only inventory reconstruction reproduces all three saved fingerprints:

- Pre-command inputs: `f05574a8edfe8a4ef4f4bb546714ac8d086e556ae816035e6f6cfeee12988507`.
- Post-command source: `f94acbfe23dbe1deb1971557715ac82e1cf31606a177928184ab28cd2b6f23a0`.
- Post-command candidate: `a679825f82e63f19a45ddd87371e3c516ade64233378cd4d0fa4c0895517aa9c`.

Removing only that file from the *in-memory inventory* reproduces the pre-command
input fingerprint exactly. The retained repository was not changed, and neither
the original task nor any test command in that repository was rerun.

The preceding public reproduction also bound the output's absent state. Its saved
source fingerprint differs from the current source after the file appeared.
Consequently, the later pytest/Black/diff-check suffix could not borrow that old
prefix. Replaying only the saved host records reproduces the original denial;
the final complete ordered sequence is ready and still passes current byte
freshness. No historical PASS was rebound or relabelled.

## Regression coverage and validation

- `test/protected-snapshot.test.ts` now covers an ignored exact generated output
  under a read directory, immutable original bindings and stable-byte reuse.
- `test/mission-review.test.ts` covers the successful-but-input-changing check,
  stale preceding proof, rejected suffix-only retry, accepted new ordered
  sequence and refusal after a later real source edit.
- `npm run test:targeted -- test/protected-snapshot.test.ts test/mission-review.test.ts`:
  exit 0, **74 passed**, 0 failed, 0 skipped; build and tests took 15.003 seconds.
  These synthetic native records are regression tests, not actual CLI completion.
- Only tests and this report change. The Cycle050 full-suite result remains
  historical evidence: 1961 passed, 2 skipped, exit 0. It is not a new Cycle051
  full-suite run. Unchanged production code does not warrant another paid
  inference, CLI replay, package build or full23 evaluation for this diagnosis.

## Independent outcomes and next work

No new official prediction or practical task was launched. Cycle050 remains
**0/1 officially resolved**, IDs `[]`, with three new-behavior failures and no
reported infrastructure failure. Retained full23 remains 9/23.

The original Coordinator-direct practical task used `openai/gpt-6.1-sol#xhigh`.
Its public reproduction preserved 523 bytes; final pytest had 137 passes, native
Mission completed and its receipt succeeded. Strict probe `accepted=false`,
`native_completed=false`, and missing matching actual Worker coverage remain
unchanged. This diagnostic does not qualify a benchmark candidate.

Next, diagnose the already-scored single-case behavior failures against its
retained native history and frozen patch. Do not weaken validation-input
freshness, automatically exclude ignored outputs, reorder an immutable task's
checks, force a validation-only Worker or rerun the completed task.

Raw diagnosis, reproduction script, inventory hashes, command/exit/time/log and
campaign accounting remain outside Git under
`/home/user/Sortie-dogs/_testenv/autodev/sortie-dogs-dev23/cycle-051/`.
Release, tag, npm publish and global apply remain outside this development work.
