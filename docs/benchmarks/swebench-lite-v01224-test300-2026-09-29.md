# Sortie-dogs v0.12.24 on SWE-bench Lite: 170/300 (56.67%)

**Official local result:** 170 of 300 resolved (56.67%) on the SWE-bench **Lite test** split, with 9 empty patches and zero evaluation errors or infrastructure failures. This is not a Verified or full SWE-bench result. A leaderboard submission/PR is distinct from local scoring, and an open PR is not a leaderboard placement.

The value of this experiment is a full, single-candidate pass@1 run with its unsuccessful cases and original evidence intact. It does **not** isolate the benefit of one model or show that this system is better than another agent on different conditions.

## System and release

Sortie-dogs is an [open-source agent harness](https://github.com/zufall-upon/Sortie-dogs), not a foundation model. This experiment fixes the publicly released [v0.12.24](https://github.com/zufall-upon/Sortie-dogs/releases/tag/v0.12.24) package at commit `b44420e923aa178d9aa5bd9e6819f4d436ba7bf7`, npm archive SHA-256 `3e4968ae8c72768347d8d37411eb7ad2e9213110e126b835de57a7a4e5b27823`. It runs on OpenCode V2 (`2.0.18` in the recorded candidate metadata). The operator/coordinator/reviewer use `openai/gpt-6-sol#xhigh`; the task Workers use `openai/gpt-6-luna-fast#max`. The 300 inference-time session snapshots confirm these were the only model routes (511 Worker sessions, 300 operator, 299 coordinator, 415 reviewer and 3 advisor sessions). These are sessions, not 1,528 independent task attempts. The leaderboard **agent** is Sortie-dogs; the models are listed separately rather than implying Sortie-dogs is a model.

The harness delegates implementation to Workers, coordinates the work, and checks candidate patches. Each instance starts from its specified base commit in an isolated testbed copied from its official Docker image. The resulting working-tree diff is frozen as a prediction before the official SWE-bench Docker harness scores it. Our inference runner and official scorer are distinct processes. Neither a patch nor a successful local test is counted as a resolution without the official per-instance report.

## Evaluation protocol

- Dataset: `princeton-nlp/SWE-bench_Lite`, revision `6ec7bb89b9342f664a54a6ea6501d3437cc2`, split `test`, 300 distinct IDs. The public input contains only the issue and repository/base-commit metadata. The input schema rejects `patch`, `test_patch`, `hints_text`, `FAIL_TO_PASS`, and `PASS_TO_PASS` fields.
- Pass@1: exactly one inference attempt and one frozen prediction per ID. The first smoke case and four pilot cases are **part of** the same 300, not extra scored tries. The remaining 295 IDs use the same package. Controller handoffs and re-scoring of a frozen prediction do not constitute additional inference attempts. Any exceptional infrastructure interruptions must be disclosed from their original records, not erased.
- Budget: $2 maximum reservation per instance and $600 campaign exposure ceiling. Known usage ($162.99 including the first five) and unknown/unpriced usage held against the original reservations ($34.60) are reported separately. A held amount is **not** a measured expense.
- Maximum inference time: 2,400 seconds per case, with a progress check after 20 minutes, read-stall checks and an early stop when there is no qualifying progress. Four possible inference slots were used for lighter repositories; heavy-image tasks were initially limited to one and later to two simultaneous instances because disk was constrained. Official scoring runs with one worker under a single run ID. Neither concurrency change modifies the candidate, predictions already produced, or the cost cap.
- Official evaluation: SWE-bench CLI `5.0.2`, official instance images, `test` split, sequential evaluation, run ID `sortie-v01224-test300-rolling-20260928`. Individual reports and test output are retained; **the single official 300-instance report** determines the final score. CLI 5.0.2 does not expose `swebench submit`, so packaging used a separate upstream checkout without changing the evaluation environment.

## Test-data integrity and web access

The runner builds prompts only from the public issue and repository/base-commit fields. It denies OpenCode `webfetch` and `websearch` tools and known remote-fetch shell patterns (including `curl`, `wget`, `gh`, `git fetch/clone/pull`, and `ssh`); the prompt forbids issue/PR pages, mirrors, hidden tests, hints, and solution metadata. Installing repository-declared dependencies from package registries remains allowed. These rules are **not** a claim of complete network isolation. An audit of all 300 exported trajectories (21,162 records) found no browser/web-search tool use or executed external solution lookup; the GitHub URLs detected in tool inputs were comments in repository test patches. This is an audit of recorded activity, not proof of inaccessible network or absence of model pretraining exposure. The 300-case grading results were never fed back into inference.

## Results

| Metric | Official local result |
| --- | ---: |
| Submitted / dataset instances | 300 / 300 |
| Resolved | 170 / 300 (56.67%) |
| Nonempty patches evaluated | 291 |
| Empty predictions | 9 |
| Evaluation errors / infrastructure failures | 0 / 0 |
| Confirmed inference expense, including first five (USD) | $162.99268980 |
| Unknown-usage reservation (USD, **not** spent) | $34.59890596 |
| Conservative known-plus-held exposure (USD) | $197.59159576 (below $600 cap) |

| Repository | Resolved / total | Empty patches |
| --- | ---: | ---: |
| Django | 74 / 114 | 7 |
| Sympy | 40 / 77 | 1 |
| Matplotlib | 12 / 23 | 0 |
| scikit-learn | 14 / 23 | 0 |
| pytest | 8 / 17 | 0 |
| Sphinx | 8 / 16 | 1 |
| Astropy | 3 / 6 | 0 |
| Requests | 5 / 6 | 0 |
| Pylint | 2 / 6 | 0 |
| xarray | 2 / 5 | 0 |
| Seaborn | 1 / 4 | 0 |
| Flask | 1 / 3 | 0 |

The remaining 130 instances were not resolved: 121 nonempty evaluated patches and 9 empty predictions. We did not drop or retry them to improve the score. The official SWE-bench submit packager independently re-derived **170 resolved, 9 without a patch, 0 missing logs, 300 trajectories** from the saved outputs; its local `submit verify` re-graded 291 instances and passed. An empty patch does not have a test output to re-grade and is counted against the 300-instance denominator.

Limits: one candidate and one inference attempt per issue, a heterogeneous 12-repository workload, capacity-related handoffs, unpriced usage, possible public-data/model contamination, and local official scoring rather than an independent rerun by the maintainers. There is no controlled ablation of Sortie-dogs, the Luna Worker route, or the newer v0.13 Fast-lane; this result establishes an end-to-end baseline, not a causal speed/quality advantage.

## Reproducibility and artifacts

The [public artifact repository](https://github.com/zufall-upon/sortie-dogs-swebench-lite-20260929) holds `all_preds.jsonl`, per-instance `logs/<instance_id>/patch.diff`, `report.json`, compressed `test_output.txt.gz` where the harness produced them, and `trajs/<instance_id>.jsonl` from the original inference-time OpenCode sessions. An empty patch has no official test output; we did not fabricate one. The original inference-time session databases and replay JSON remain separately preserved. The public trajectories expose the visible text and tool events, not provider-encrypted hidden reasoning or credential tables. A heuristic scan of all 1,174 staged artifact files, including decompressed test output, found no OpenAI/GitHub/Hugging Face/AWS token, private key header or credential-bearing authorization header; this is not a guarantee that all possible sensitive text is absent.

The frozen 300 predictions have SHA-256 `3fc0aac92c029ce519a269941221301090e5240c6f4199c885d237a9be5cff06`; the single official 300-case report has SHA-256 `031d2cbc26599297108e17349153fbea589394c2022a1f465325203fb8e67a6d`. The dataset manifest has SHA-256 `1c4d9da704ecb7f6596090741d5350350e99a487ef05d6a9d024844cb04952a7`. The run ID is `sortie-v01224-test300-rolling-20260928`.

`python scripts/swebench-lite-submission-audit.py` validates the fixed package, 300 single-attempt inference states, per-batch prediction/report hashes, original replay/session snapshots and final report without any new inference or Docker scoring. The submission was packaged and independently re-graded with upstream SWE-bench `02e7a74ffd0b707aab73d203fe87bdc7c76afc8e` using the existing logs, frozen predictions and original trajectories. The evaluator used for the run remained the separate SWE-bench CLI `5.0.2`; packaging did not alter its results. Anyone can re-grade the public logs with `swebench submit verify` (without Docker) once the official entry is registered.

The [SWE-bench/experiments](https://github.com/SWE-bench/experiments) entry separates the **Sortie-dogs agent** from its OpenAI model routes, identifies the author as [zufall-upon](https://github.com/zufall-upon), includes the committed Sortie-dogs logo and derived `results/` files, and links to this report and the artifact repository. It should not claim a leaderboard rank unless and until the maintainers accept and list it.

## Official submission references

- [SWE-bench experiments: Lite submission and original reasoning-trace requirements](https://github.com/SWE-bench/experiments#-leaderboard-participation)
- [Submission checklist, metadata fields and technical-report requirement](https://github.com/SWE-bench/experiments/blob/main/checklist.md)
- [SWE-bench submission packaging/verification source](https://github.com/SWE-bench/SWE-bench/tree/main/swebench/submit)
