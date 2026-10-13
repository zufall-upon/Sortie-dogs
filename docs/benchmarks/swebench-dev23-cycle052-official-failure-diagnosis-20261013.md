# Cycle052: retained official failure and public behavior boundaries

## Finding

The three Cycle050 `sqlfluff__sqlfluff-1763` official failures share an
implementation-coupled private API mismatch. They do not demonstrate another
failure of the exercised public CLI persistence path. The official result remains
**0/1 resolved**, IDs `[]`; this diagnosis does not replace the official oracle or
declare the entire public issue solved.

The immutable prediction is a 4268-byte patch, SHA-256
`9ad32c90b39e2ca00af656cebe1acf44e05170a393d1b424338c3805051b30eb`.
It encodes the complete output through `io.TextIOWrapper` before opening the
destination for writing in `LintedFile.persist_tree()`.

The original single-case workspace is no longer present. Instead of recreating
it or rerunning a consumed task, the retained V2 database supplies the
Reviewer's complete 507-line source read. Stripping only native line prefixes
reconstructs Git blob `1fbfe8e24a3e3939d8863ceea53b2a9dfd55b53e`, matching the
frozen patch's new-blob prefix. Its SHA-256 is
`7296a1f6f61b4aecb4c0ff6aa8c02582dc353adb86dec0bc04e08567a1b53691`.
AST inspection finds `persist_tree`, but no `_safe_create_replace_file` method or
reference in that complete source. This inspection does not import or run it.

The retained official tests call the absent private helper, not `persist_tree`
or the public fix command, and catch every exception before checking the file:

- `utf8_create`: no file was created; the later read raises `FileNotFoundError`.
- `utf8_update`: existing `abc` stays unchanged instead of becoming `def`.
- `utf8_special_char`: existing `abc` stays unchanged instead of becoming `→`.

An `AttributeError` at the helper lookup is inferred from the complete source and
test call, not visible in the official traceback: the test's catch-all suppresses
it. The `incorrect_encoding` case also uses that catch-all and expects unchanged
`abc`; its PASS cannot prove that the absent helper performed a safe failing write.

The patch applied successfully. The official harness completed one dev execution,
one scoring worker, zero retries: three FAIL_TO_PASS failures and no PASS_TO_PASS
failures. The report lists 63 required PASS_TO_PASS successes; pytest collected 69
tests and reported 66 passed, three failed in 1.70 seconds. This is a scored failure,
not a patch collision, missing prediction, image ceiling or infrastructure failure.

## Separate retained public and practical outcomes

The single-case native history records the same corrected minimal public CLI
reproduction before and after editing: the reported charmap error initially wipes
the file, then preserves its bytes with the patch. Its focused/adjacent encoding
and CLI-fix suite had 21 passes, exit 0, in 1.61 seconds. This single-case check
simulated the output encoding because dbt was unavailable; full dbt/PostgreSQL
integration is not claimed for it.

Actual single-case Operator, Coordinator-direct author and Reviewer messages in
the retained V2 usage database all show `openai/gpt-6.1-sol#xhigh`. This adds the
previously uncited Reviewer observation, not a matching Luna Worker observation.

The separate Cycle050 practical task did exercise the dbt/PostgreSQL-templater
command: 523 original bytes retained, final native validation 137 passed, Mission
completed, receipt succeeded. Strict probe `accepted=false`,
`native_completed=false` and missing matching actual Worker coverage remain
unchanged. These are distinct patches and tasks; neither outcome transfers to the
other. Retained full23 remains 9/23, not a score for current main.

## Decision and next work

No product change is justified by these three failures alone. Do not supply the
hidden helper name, evaluator tests or implementation to a runtime/benchmark
prompt, invent a compatibility stub, change the grader, relabel the official FAIL,
weaken freshness/acceptance or replay either consumed task merely to fit this API.
Only this repository report changes; no new inference, practical task, package,
full23 evaluation, release, tag, publish or global apply occurs.

PR #219's retained GitHub checks are now terminal: both Linux and both Windows
jobs succeeded. The Cycle051 regression evidence and prior full-suite evidence
remain historical; no new unit/full-suite run is claimed for this documentation.

Next, diagnose the retained practical probe's budget-cutoff terminal observation
against its completed native Mission, final session states and recorded usage.
Identify a genuine CLI bottleneck before any changed-candidate paid operation;
reserve that operation first. Do not relax acceptance or force a validation-only
Worker. Full23 expansion remains unwarranted while practical qualification and an
intended official comparison are unmet.

The read-only diagnosis script, immutable input hashes, native command/exit/output
records, prior terminal CI and cumulative campaign accounting remain outside Git
under `/home/user/Sortie-dogs/_testenv/autodev/sortie-dogs-dev23/cycle-052/`.
