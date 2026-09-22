# Root proposal revision maintenance — 2026-09-23

## Fixed candidate and boundaries

- Base: main `8d0b73b0e01b863d628022d825724baafa993f8b` (0.10.19 version update).
- Code/package candidate: `0b46027cd7d031fa3ee569a6a0477e6cc5d975bc`.
- Package SHA-256: `5b7295585aa7ecec6429fc15ee9967bf97d249161776aa7d7353d0e2f4d1a549`.
- Runtime marker suffix: `cold-turn1-return-report-v2-2-root-revision1`.
- Isolated installation matched all 178 distributed files. CLI: OpenCode 2.0.11;
  Node: 22.14.0, Windows. Package and source stayed fixed during the native scenario.
- Configuration/model routes/depth/compaction were copied unchanged. Observed
  models: root `anthropic/claude-opus-5-5`, proposal `openai/gpt-5.6-terra#xhigh`,
  worker `openai/gpt-5.6-sol#medium`. No fallback was selected.

The new operation is a bounded field revision, not a way to declare an
unrepresentable requirement covered. Root-owned publication/global application
and user-only acceptance still require their actual evidence; unrelated worker
tests cannot substitute for them. Existing real-case control files were not
edited to exercise this maintenance fix.

## Regression and platform gates

- Before implementation, four revision regressions failed because the root route
  was absent. After implementation, coverage includes an ended child, cold
  revision/approval, immutable intent/references/acceptance, scope/budget denial,
  finite malformed-input accounting, exact milestone remapping, provenance,
  independent-process competition and atomic recovery from a real rename failure.
- Approval preparation pins the identity before publishing execution controls.
  Both successful approval and a failed preparation close the revision lane, so
  a competing patch cannot detach an intermediate prepared run from its proposal.
- `npm run build`: PASS.
- Focused `operator-proposal`, `v010-runtime`, `v2-plugin`, and `runtime-assets`:
  166 tests PASS. Initial test-harness failures were corrected: storage failure is
  injected after the fresh durable read/reservation; cold plugin fixtures expose
  their real prior user history; guidance assertions follow the new revision route.
- `npm run test:full`: 69 files, exit 0. WSL source SHA-256:
  `effc43495585f3bfb6cf6bce02573cd368eb6a0ef4f957a4f5929e858e4dee9e`.
  Local logs: `_testenv/wsl-1790119883149-34912/`.
- Subsequent `npm run test:windows`: 6 tests PASS, no failures or skips.
- GitHub PR CI on the code candidate: PASS.

## Native V2 CLI result: PASS

The generated low-risk fixture starts with an input value of 41. The sole worker
may write only `output.json`; `node check.mjs` checks the protected input bytes
and output `{ "answer": 42 }`. The proposal seed deliberately leaves R1 uncovered
and omits the addition from the unit objective. The child reads the actual seed,
brief, input and oracle, submits that deficient packet and ends. Only the root's
new public revision tool corrects it.

Four successful standalone CLI processes reuse the same root and goal:

1. **Submit:** revision 1, R1 uncovered; reads 4, submissions 1, units 1.
2. **Cold root revision:** exactly one public revision call changes coverage,
   uncovered, observed surfaces and the unit objective. Revision 2; reads still 4,
   submissions 2, units still 1; no operator run or dispatch yet.
3. **Cold explicit approval:** root compares R1/R2/R3 and the exact new hash.
   Same revision 2, one prepared worker, zero implementation dispatches.
4. **Cold execution/acceptance:** one worker runs `node check.mjs`, native exit 0.
   Root checks the artifact and explicitly calls `complete_operator`. Goal and
   operator receipts both record `succeeded`; cumulative scenario units are 2,
   with zero outstanding reservations.

Identity and state checks:

- Root: `ses_f3489f519ffejWhF7EDSS9IXkK`.
- Goal: `sha256:003da04036e2caaca0be9fff01c586f3ad255de8e9652e12526144dfedd6cab0`.
- Run: `operator-5fed7db7-7a6e-44bf-8c32-49af918ebd04`.
- Old proposal hash: `cb7aa1363e1ba876108ba162f063557fdb835ec68b48047cb4ab3c2b2ee78cfe`.
- Revised hash: `9419a374e4c27b31912503147221f945b18756f279d4230c5eeb2bcbc6fb4533`.
- Root-patch digest: `d3d407ac49a57210326fe8194c9f70a7c15f99ec9f876968d8c457f942fec72f`.
- Frozen intent, proposal goal binding, ordered acceptance, source references,
  read paths, child identity and write union retained. Recomputed packet hashes
  matched at each stage. The final independent oracle also passed.
- Native database contains exactly root + proposal child + worker. Protected
  files are unchanged, only the worker mutates source, and there is no nested
  delegation, extra worker, tool error, synthetic message or synthetic inbox.
- The host's exact `return_report` is saved once in the existing final response.
  This fixture does not establish UI display/reopen behavior or complete report
  metering: the returned panel explicitly reports unavailable usage/history.

## Retained environmental failure and accounting

The first CLI process failed before any tool/dispatch because Meridian's resolved
Claude Code 2.1.278 was too old for the selected model. After explicit user
authorization, only `@anthropic-ai/claude-code` and its win32-x64 platform package
were updated to 2.1.280 at that existing cache installation. The unrelated PATH
Claude installation and all model settings were retained. The same root, goal,
fixture and package were then resumed; the failed turn remains in native history.

An initial audit assertion incorrectly used a nonexistent reducer property for
reserved units. It was corrected to `outstanding_reservations.length`; the actual
failed turn had consumed zero units. The retry prompt also states the already
intended two-unit ceiling on its own line for the host's explicit-budget parser.
No implementation had started before these harness corrections.

- CLI processes: 5 including the provider failure; per-turn timeout 900 seconds,
  scenario limit 8 turns.
- Campaign carry-in: 15/25 units.
- New spend: proposal 1 + worker 1 = 2 units. Revision/approval add no dispatch.
- Cumulative campaign spend: **17/25**, remaining **8**.
- Cost is `null` (unavailable), not zero.

Raw fixtures, prompts, native history, audits and snapshots remain outside Git at
`proposal-revision-cli-0b46027` under the approved OpenCode temporary directory.
Reproduction controllers are the local `_testenv/proposal-revision-cli.mjs`
(`setup`, then `turn` for each stage) and `_testenv/proposal-revision-audit.mjs`.
The controller freezes package/commit identity and checks protected files after
every turn; the audit compares durable snapshots with native SQLite history.

The original proposal-cancel-restart, draft-field-read-repair,
worker-failure-replacement and complete V2 report/UI revalidation remain pending.
This maintenance fixture is not evidence of MK2, hardware performance or Visual Go.
