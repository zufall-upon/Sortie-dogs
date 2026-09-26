# Diagnosing test-injection path collisions

This is an explicit **supplemental scoring condition**, not a replacement for an
official SWE-bench outcome. Use it only after inference has ended and the
prediction, original evaluator script, image identity, and original report have
been frozen. Keep every generated file outside Git and outside inference roots.

## Failure mechanism

Some generated evaluators reset test targets with:

```sh
git checkout <base-commit> tests/test_new.py
git apply -v - <<'OFFICIAL_TEST_PATCH'
...
OFFICIAL_TEST_PATCH
```

If the candidate and official test patch both add `tests/test_new.py`, that path
does not exist at the base commit. Checkout fails without removing the candidate
file, then official injection fails with `already exists in working directory`.
The evaluator can continue and run candidate tests instead of the expected tests.
A pytest exit code of zero then does not establish official correctness.

This was observed in the v0.12.8 `pydicom-901` improvement attempt and in
`sqlfluff-2419`. The original reports stay authoritative for their original
conditions, including their unresolved outcomes.

## Supplemental reset helper

`scripts/swebench-test-reset.py` accepts a frozen evaluator script and emits a new
script plus provenance. It replaces supported file-targeted checkouts with a
base verification followed by a per-path reset: checkout files present at the
base, remove only named files absent from that base. Reset failures terminate
the diagnostic script. Bare commit checkouts remain repository setup.

```bash
python3 scripts/swebench-test-reset.py \
  --input /path/to/frozen/official-eval.sh \
  --output /path/to/fresh/diagnostic-eval.sh \
  --metadata /path/to/fresh/reset-provenance.json
```

Requirements and boundaries:

- Run with Python 3 on the scoring host. Use only a trusted evaluator from the
  official scoring phase as input. The emitted script executes in a disposable
  scoring container, never against a development checkout.
- The helper is intentionally limited to line-oriented generated shell scripts,
  standalone `git checkout <40-character commit> [--] <paths...>` resets, and
  single heredocs whose delimiter ends the command line. Unsupported checkout
  shapes, multiline quoting, shell expansions, wildcard paths, path traversal,
  and unterminated/unsupported heredocs are rejected rather than guessed.
- Heredoc content, including injected test patches, is preserved byte-for-byte.
  Files outside the evaluator's reset target list are untouched by the reset.
- The helper reads no model predictions, reference fixes, or expected answers.
  It does not choose test names based on a candidate patch or alter test content.
- Outputs must be fresh. Metadata records original/normalized SHA-256, reset
  line numbers, commits and paths, and `official_score: false`.

Apply the exact frozen candidate patch in a fresh container of the same pinned
image, then run the generated script instead of the original evaluator script.
Retain the candidate patch hash, both evaluator hashes, logs and test identities.
Compare the production diff before and after evaluation. Record the supplemental
result separately, including assertion failures and missing test IDs. Do not
overwrite predictions, original reports, or the official campaign total.

## Recorded pydicom-901 validation

- Runtime archive SHA-256:
  `d1132b8d13a0bf8ef2b41ba7ec1f67812c8bfa1f26a9f3ac7cc2e2b656534906`.
- Frozen candidate patch SHA-256:
  `557ced404cc9ee4d6346f0378e6df277bbb571211db22a400f08bdca0ae7ea15`.
- Image ID:
  `sha256:9eefbfc3074839815a9f3a319a78980aa2d568b828087457df54e11caf849865`.
- Original evaluator SHA-256:
  `c7073e60f6a8629f3512ce57d57e21369519822277154677157619098e054988`.
- Normalized evaluator SHA-256:
  `598112d71bc695a116c9a7988c9b9b204a641273a626fbfaa3edc311e1c9a4cd`.
- Original run: injection collision, candidate's two tests passed; required five
  official test IDs absent; official outcome unresolved.
- Supplemental run: official injection succeeded, **five expected tests ran**,
  **five failed and five teardown errors**. Test exit code 1. The production
  diff was byte-identical before and after evaluation, and the newly injected
  test file was removed by the final reset. No inference requests were made.
- Conclusion: the collision hid genuine behavioral differences in this patch.
  Normalizing test restoration improves diagnosis; it does not turn this repair
  into a passing solution or establish a higher official score.

Local evidence: `/tmp/opencode/swebench-test-reset-diagnostic/`. Automated Git
fixture coverage is in `test/swebench-test-reset.test.ts` (tracked, deleted and
new test targets, unrelated production/test preservation, heredoc preservation,
invalid base/path handling and output immutability).

## Recorded sqlfluff-2419 validation

The same helper was then applied to the saved v0.12.8 continuation attempt:

- Frozen candidate patch SHA-256:
  `97eb43e759d77f544da117cf69f0323d7c81a14bcf5a01971e3ad07b56e23581`.
- Image ID:
  `sha256:881e3b830d8a68b52041b8ec79af813d12adf75d0c1838b17950e5a5b6238353`.
- Original evaluator SHA-256:
  `0f65d22a14fbfcd8fe35108a68c88c3ddd5b03e58eccd40b815bb3f4770d4236`.
- Normalized evaluator SHA-256:
  `178b7b440488ff7c7b5a5615a0146fbfcb176085cb9e2c3b75da14ca877a07ad`.
- Original run: injection collision at `test/rules/std_L060_test.py`, candidate
  test passed, required official test ID absent; official outcome unresolved.
- Supplemental run: official injection succeeded and the required test
  `test/rules/std_L060_test.py::test__rules__std_L060_raised` **passed**. Test exit
  code 0. The `src/` production diff remained byte-identical and the final reset
  removed the newly injected test file. No inference requests were made.
- This establishes a passing supplemental check for this saved patch, while
  retaining the original official outcome and original campaign total.

Local evidence: `/tmp/opencode/swebench-test-reset-diagnostic/sqlfluff-2419/`.
Both diagnostics used fresh containers with networking disabled and identical
candidate patches; no test-patch contents were changed. The main-integrated
`84ccdf1` dev23 campaign runs independently under its frozen original conditions.

Validation on 2026-09-26: related benchmark tests **67/67 PASS**; after adding the
helper tests to the quick-test route, `npm test` (including build) **379/379 PASS**.
