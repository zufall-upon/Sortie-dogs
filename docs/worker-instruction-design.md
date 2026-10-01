# Clear Worker instructions

Sortie-dogs should make the model's implementation task clear, then let it execute. The harness owns task identity, permissions, evidence recording, freshness and orchestration. Repeating that machinery as model instructions is not a substitute for implementing it in the host.

## Model-facing contract

The implementation Worker needs three things:

1. **Goal:** the assigned change or corrective delta, with the complete original user request available verbatim.
2. **Constraints:** applicable user/project restrictions and the behavioral properties the result must preserve. A planning estimate is not a new user prohibition.
3. **Done:** the actual deliverable, required checks and requested delivery action. The parent owns independent Review and whole-Mission acceptance.

Give the Worker a short route to those facts. Do not ask it to reconstruct identifiers, copy acceptance ledgers, create proof prose or repeatedly discover unchanged state. A task brief must not dilute the original request or silently add new obligations.

## Common instructions versus task-specific detail

Common Worker instructions cover implementation and the minimal host handshake. Operation-specific execution rules belong only with an operation assignment. Download recipes, archive examples, release procedures, branch-policy edge cases and repeated permission explanations do not belong in every implementation turn.

Local recovery should use existing tools and their actual diagnostics. Instructions should tell the Worker how to continue the same task, rather than enumerate every hypothetical denial or require another agent to transcribe state. Existing host permissions and explicit user constraints remain authoritative.

Checks should establish the requested behavior. Preserve required formal commands and source freshness; avoid repeated broad checks on unchanged source and speculative test matrices. A short instruction to inspect relevant callers and error/state behavior is preferable to a growing catalog of past benchmark failures.

## Preventing instruction accumulation

Measure the **fully rendered agent**, including appended policies, not only the authored objective. Keep the common implementation Worker around 2,000 characters of prose and the installed asset within approximately 3,000 characters. Use a source regression budget to catch accidental instruction growth; this is not a runtime limit on user requirements, an input rejection, or permission to truncate them.

Also measure the task brief, native handoff rendering, tool descriptions and accumulated history separately. A small objective does not imply a small model context. Keep original text available once where possible, distinguish exact requirements from procedural summaries, and preserve persisted contracts and legacy identities when changing only their model-facing presentation.

## Evidence of success

Instruction size and internal tests establish a design change, not model performance. Keep the model/effort fixed while evaluating instruction changes. Observe real dispatch, tool use, initial implementation quality, required validation, independent Review, delivery, elapsed time and cost. Report incomplete outcomes as incomplete.

The intended outcome is fast, autonomous and visible completion of the original task. Removing required quality checks, hiding defects, substituting an easier task or waiting longer is not instruction improvement.

## Host-owned Worker activation

The latest observed Mission Worker performed three control-document reads, a status call and a manual bind before repository work. The host already knows the admitted child, assignment and operation manifest. Asking the model to reconstruct that handshake adds bookkeeping without improving the implementation brief.

Activation of the existing assignment now occurs upon completion of the authoritative handoff read. The Worker receives the original task and a separate, concise activation result in the same response. This uses the existing binding operation and its diagnostics; a denial exposes its actual recovery action rather than pretending the assignment is ready. The manual binding path remains for compatibility and recovery.

This proposal serves the three product principles:

- **Autonomy:** a current admitted Worker can start its assignment without another parent turn or manual identifier transfer.
- **Efficiency:** replace redundant control-document reads and a bind-only model turn with host-owned state handling.
- **Visibility:** report the actual activation result alongside the assignment, retaining explicit blockers and original requirements.

The measured baseline has five startup calls and 12.68 seconds between the first handoff read and the first repository operation. The target is one handoff call; the entire interval is not assumed recoverable. This does not explain the remaining 57 model requests, implementation quality, or independent Review duration.

Native hook/binding regressions, independent SourceReview, full tests and Windows tests passed. The installed package completed a small public fixture in 3m05.173s with one startup handoff read, no explicit bind, formal check PASS, requested commit, independent Review PASS and successful receipt. That fixture establishes host integration only. Original Anko completion remains unproven until its original requirements, formal checks, independent Review and successful receipt all complete.
