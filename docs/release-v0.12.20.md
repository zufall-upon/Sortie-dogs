# v0.12.20 — Mission recovery, optional consultation and bounded rescue

- Block Coordinator dispatch when a cancelled predecessor's source lineage remains unproven. Allow explicit in-place reconciliation of an already-blocked mission against its saved requirements without reviving superseded acceptance.
- Add optional Advisor/Scout consultation and a bounded Astra Rescue after ordinary validation remediation fails. Existing scope, budget, validation, review and final acceptance obligations remain separate.
- Reconcile interrupted V2 Coordinator Task ownership against native terminal history so the same child can be resumed instead of remaining stuck behind a stale in-memory owner.
- Add an opt-in status-only V2 CLI probe that records the observed root/status-call models without claiming Mission completion. Surface run creation and last settled-transition times in Task progress.

The merged unit and CI checks do not establish an end-to-end Astra Rescue or completion of a real Mission. SWE-bench inference and official grading are separate from this release gate.

Runtime marker: `0.12.20-mission-recovery-rescue-v1`.
