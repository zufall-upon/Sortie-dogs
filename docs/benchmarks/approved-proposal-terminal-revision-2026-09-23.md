# Approved proposal after terminal operator: recovery regression

## Defect and change

An approved proposal remained bound to its cancelled operator run, while `begin_operator_proposal` rejected every changed intent with `operator-proposal-new-intent-requires-explicit-root-revision`. No corresponding root transition existed. The original report concerned `MK2-02` after an `agent-changed` cancellation.

The new root-only `revise_approved_operator_intent` takes the exact approved proposal identity, terminal run ID, rationale and complete new intent. It requires a current active goal with a changed binding, rejects active/prepared or mismatched runs, archives the approved order and terminal disposition, and carries the cumulative proposal reads/submissions into the new investigation. A continuation of the same goal must keep all prior ordered requirements as an exact prefix. It grants no implementation, acceptance or budget reset.

## Fixed candidate and checks

- Source commit: `156528e04efe17ae16da9c4fb455d7b02f56cfca`.
- Isolated `sortie-dogs-0.10.20.tgz` SHA-256: `dc2161ab0d833472a26378e84b0eb7b712cd0115a51700dbb51e6c3985c3310c`. This is a private test candidate, not the previously released 0.10.20 asset.
- `npm run build`, all 58 tests in `test/operator-proposal.test.ts`, `npm run test:full`, and `npm run test:windows` (6 tests): PASS on the final source.
- [PR #14](https://github.com/zufall-upon/Sortie-dogs/pull/14) CI `npm test`: PASS for the source commit.

## Isolated native CLI replay

- OpenCode CLI `v2.0.11`, installed candidate verified against all 178 local `dist` files and the runtime marker. The original C-side global config hashes and fixture protected-file hashes were checked before and after. Model routes came from the existing config.
- Same native root session `ses_f3418cd54ffexrG9MbrbK3QIo1`, same goal `sha256:cdae26591539d8f2215f2f2fa4c6bcc5082da837a36da0717c73f621a73ea036`, five separate CLI turns: submitted → root-revised → approved → explicitly cancelled before worker dispatch → new intent granted. Every turn exited 0 within 900 seconds; the fixture limit was eight turns and four units.
- Approved old proposal `proposal-abcb234ff78af8630d2d9efe` revision 2; cancelled run `operator-5e601ecf-5c56-4012-9e00-3942119dcccf`. Its receipt is `stopped`, not succeeded; the worker was never dispatched and no native validator result was invented.
- New intent `intent-1fcc0b1540cc79aba76421ed` is `investigating` with no admitted child. The prior three requirements remain byte-identical and ordered before the added fourth. Reads remain 5/10, submissions 2/6, goal units consumed 1/4, reservations 0, and metered cost `null` (not zero).
- Immutable old-contract archive SHA-256 `a4eedd1f11fa00ecf6fdc456736561cfde6e30062233d44669c7f39ebb575d02` matches `approved_history`; the archive contains the old acceptance and cancelled run, while the current operator state still records that run as cancelled.

Native evidence and audit: `C:/Users/rozen/AppData/Local/Temp/opencode/mk2-approved-cli-156528e-v1/` (`identity.json`, `control.json`, turn JSONL/stderr, per-turn snapshots and `audit.json`). The bounded controller and independent audit scripts are `C:/Users/rozen/AppData/Local/Temp/opencode/mk2-approved-revision-cli.mjs` (SHA-256 `faaa37e69d2babb341d3af301e553be1edd23b01c5abcc2666935ac61b70884f`) and `mk2-approved-revision-audit.mjs` (SHA-256 `e87d533155ad03b651382387e1d6c16505c7b5aea1dbf28c65ffc430c37fee13`).

This proves the terminal approved-proposal recovery boundary. It does not prove the separate `MK2-02` display/Visual Go/independent-review acceptance on the reported Backend 2.0.13, nor complete the paused history campaign. The newly granted proposal Task remains unadmitted and the old goal remains unaccepted.
