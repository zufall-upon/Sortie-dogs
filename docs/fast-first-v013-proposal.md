# v0.13.x PR proposal: Fast-first Mission

## User problem and target

Sortie-dogs produces useful results but takes too long to return them. For a request that fits one useful Worker unit, the normal path should be Operator → Worker investigation/edit/validation → independent Reviewer **when warranted by the actual change** → Operator acceptance. Coordinator joins only when a real correction or coordination need is known. The measure of success is time to a validated answer, not the share of requests labeled Fast or the time to a Task launch.

This PR starts from v0.12.25 `main`. PR #126 (review excerpt omissions) and PR #127 (aborted orphan settlement) are separate and not treated as integrated speed improvements here.

## Smallest operational change

- Make the existing single-unit `plan_units` route the first choice. A source change, multiple files, an API label, duration or an independent review need do not by themselves require Coordinator. The root must still supply a truthful scope and an exact meaningful formal validation command. If those are not yet available, use Coordinator for targeted discovery; do not invent a dummy validator or dispatch a sacrificial Worker.
- Allow the root to dispatch exactly the host-generated independent Reviewer after its direct Worker succeeds. Use actual `risk_tags`, retain the existing freshness/validation/independence requirements, and keep root final acceptance. Empty tags are for genuinely low-risk work, not a property of Fast-lane.
- Show the current Fast action in `operator_status`: plan an unplanned single unit; review a validated one; wait for a pending Reviewer; accept a reviewed candidate; or start the **same mission's** Coordinator after failure or concrete FINDINGS. Keep completed work and cumulative budget. Never duplicate an active Worker.
- Do not add a router model, security layer, user approval, forced Reviewer for low-risk work, another state machine, or a blanket requirement to retry a failed check. Model assignments stay unchanged.

## Autonomy, efficiency, visibility audit

- **Autonomy:** Worker investigates and validates within its contract; Operator does not approve each unit. On FINDINGS/failed validation/out-of-scope correction, existing Coordinator handles the problem within the same original request. A user-only decision or actual budget expansion still belongs to the user.
- **Efficiency:** routine requests omit the initial Coordinator inference and task round trip. Independent review, when needed, does not add a Coordinator merely to dispatch it. Do not repeat an unchanged check or Review to manufacture proof. The existing contract still requires exact validation before Worker dispatch; relaxing that into Worker-selected late binding is a separate change only if observed wait times justify it.
- **Visibility:** `operator_status` distinguishes Fast planning, validation, pending review, reviewed acceptance and escalation. A Reviewer FINDINGS result is not PASS; EVIDENCE_GAPS at its bounded limit is not a quality score. No extra model call for progress.

## Verification and limits

- Production-hook regression: direct Worker → recorded native validator → host-generated independent Reviewer → succeeded receipt, without a Coordinator. A separate FINDINGS branch asserts the same mission/candidate survives promotion to Coordinator. Mutating the generated Reviewer Task is rejected.
- Full WSL and Windows suites run before PR. A short real-V2 CLI probe, if available, must identify the installed candidate package and actual Worker/Reviewer models; a model-free fixture does not establish real-model elapsed-time savings.
- Follow-up evaluation: matched routine requests on old/new fixed packages, with original requirements, acceptance and models held constant. Record request→first useful edit/check and request→validated completion, p50/p90, Worker/Reviewer/Coordinator count, retries, unresolved gaps, missed defects and estimated cost. Do not infer speed or quality gains from a single heavy Anko run or from a lower inference bill alone. A measured regression sends the route back for repair, not a new per-request gate.
