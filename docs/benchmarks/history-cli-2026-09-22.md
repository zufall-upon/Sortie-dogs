# Historical V2 CLI continuity checks — 2026-09-22

## Fixed implementation candidate

- Baseline: `v0.10.18`, commit `79bb0a9e4c88c2d71c71628e1ed2d6b8d30df21a`.
- Baseline package SHA-256: `2559f4e52d4c02b1c64263ac625d5dbd55ff158ebe24729bd05ccb30e835097e`.
- Continuity candidate: `c2fa288800459acba89e48d044c83f0353168675`.
- Candidate package SHA-256: `168a7727467f15090a02b0f9fddcb598c16fa8616b0feeb80dd9b5289efc3213`.
- Native Windows CLI: OpenCode `2.0.11`, Node `22.14.0`.
- Each turn used `opencode run --standalone --format json --auto --agent dog-operator` and reused its scenario's session.
- Configuration was copied to an isolated directory; only the plugin package reference changed. Global C/O configuration hashes matched throughout the campaign.
- Observed routes: root `opencode/mimo-v2.6-flash-free`; proposal/operations `openai/gpt-5.6-terra#xhigh`; workers `openai/gpt-5.6-sol#medium`.

These are deterministic data fixtures, not measurements of MK2 completion, hardware performance, Visual Go, or SWE-Bench quality.

## Native outcomes

### Proposal cancellation and cold restart: PASS

Baseline lost the cancelled proposal's goal binding on the next real CLI turn. Its ledger changed goal ID, omitted the earlier proposal unit, and completed from final prose before explicit acceptance. A subsequent `complete_operator` was refused.

The fixed candidate retained one goal through three processes: cancellation, renewed investigation/implementation, and explicit acceptance. Cumulative units were **1 → 4 → 4**, reads **6 → 12**, and submissions **1 → 2**. Both workers passed their exact native validators. Before the third turn the run remained `awaiting-acceptance`; afterwards both durable receipts were `succeeded`.

### Saved draft field/read repair: PASS

Baseline repaired the same-resource junction alias but registered an immutable run while invalid `delivery_mode` and missing `expected_outcome` remained. Its draft was then unavailable for further repair.

The fixed candidate diagnosed and repaired only these pointers, in order:

1. `/units/0/read/2`: absolute source spelling → existing `asset-input/input.json` junction alias.
2. `/goal_declaration/delivery_mode`: `prototype-first` → `mvp-first`.
3. `/goal_declaration/defaults/expected_outcome`: add `pass`.

The first turn stopped at `prepared` with zero dispatches. A separate process completed the same run with two workers and explicit acceptance. Original goal, ordered acceptance, unit count, write scope and validators were retained.

### Native worker failure and formal replacement: PASS

The initial missing-read fixture did not produce a failure: its worker completed using values already available in the fixed brief. This attempt is **not** failure-path evidence, and its one unit remains in campaign spend.

The controlled failure fixture instead held Windows read-share locks on both output files. The native worker's patch failed with `EBUSY: resource busy or locked`; neither output changed and no validator ran. The host settled one `process-defect` unit.

After the external harness released the locks without changing bytes, a new CLI process called `resume_operator` once. The host returned `operator-process-remediation-replacement-required`; the root cancelled the failed run and prepared a byte-identical replacement plan. The replacement completed both native validators and explicit acceptance. Goal and acceptance fingerprints were unchanged, parent-run lineage was retained, and cumulative units were **1 → 2**.

## Evidence checks

All three successful scenarios were independently audited against native session/message history, durable goal/operator records, protected-file SHA-256 values, and a fresh `node check.mjs final` content oracle. Native validations were `node check.mjs` and `node check.mjs final`, both exit 0. No root/operations source mutation, repeated design question, or nested worker delegation was observed.

Campaign spend: **13 settled proposal/implementation units**, including all five baseline units. The initial cap was 12; the user explicitly raised the cumulative cap to 13. Cost metering was unavailable (`null`), not zero. No further implementation/proposal dispatch is authorized by this campaign.

Raw logs, fixtures, native database extracts and snapshots remain outside Git. Local evidence directories are `history-cli-0.10.18-v1` and `history-cli-c2fa288-v1` under the approved OpenCode temporary directory.

## Additional return-report findings

The continuity candidate exposed a separate report transport problem, so its successful implementation outcomes do not certify report display:

- Baseline report IDs beginning `sortie-report-` were rejected by the native API with HTTP 400; IDs require `msg_`.
- Correcting the ID admitted a durable inbox item. `resume: false` did not make it display-only: the old report was consumed on the next real turn, producing an extra model response. The native web UI showed no report card.
- The V2 adapter returned an empty child list and omitted legacy model/tool timing fields. Reports therefore undercounted usage and incorrectly displayed no dispatched children.

The follow-up correction returns the host-generated panel in the successful `complete_operator` result for verbatim inclusion in the existing final response, and does not enqueue synthetic input. Accounting traverses native paginated history/children and translates model IDs, task ownership, mutation evidence and tool times. Existing queued synthetic history remains marked synthetic during cold recovery.

A read-only native API replay of the accepted proposal receipt recovered **671,908 tokens** across the root and five actual child sessions, preserving the goal, all four consumed units and the receipt. This contrasted with the old root-only **424,004-token** report. Historical telemetry emitted by the defective candidate remains historical; replay does not rewrite its immutable acceptance or spend.
