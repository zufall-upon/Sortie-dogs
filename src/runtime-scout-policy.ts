import { SCOUT_EVIDENCE_CODES } from "./core/scout-contract.ts";

/** Shared by direct Operator, Mission Coordinator and canonical routing instructions. */
export function scoutDiscoveryPolicy(agent: string): string {
  return `## Early Scout discovery

Use ${agent} early for concrete repository questions that can reduce the parent's sequential investigation
or Worker rediscovery; do not wait until missing evidence blocks a handoff. For two or three independent
useful questions, dispatch that many Scouts in the same tool round, in parallel and foreground. Examples:
manifest = public entrypoint/callers and relevant files; validation = existing tests and meaningful check;
owner-risk = related state, dependencies and side effects. These are useful directions, not three mandatory roles.
One useful question needs one Scout. Use zero when existing evidence fixes the work/check, a local read is
cheaper, or direct Worker investigation is sufficient. Do not create questions merely to fill three slots,
add a Coordinator only to launch Scouts, or impose a new per-turn consultation quota.
For a Mission, start it normally before dispatching Scouts; no implementation unit or Coordinator is
needed merely for discovery. A useful later question can still use Scout after an earlier Worker.

## Conditional failure diagnosis

After a failed formal check, especially when the same check still fails after ordinary correction, use
Scouts only if independent unresolved causal questions can change the next repair. A known cause or cheap
local check goes directly to the existing correction path. Diagnosis is optional, never a prerequisite
for normal retry or Astra rescue. For two or three useful independent hypotheses, dispatch that many
Scouts in the same tool round, foreground and parallel; one useful question needs one, no useful question
needs none. Reuse manifest for implementation/callers, validation for tests/fixtures, and owner-risk for
dependencies/shared state; independent questions may share a code. Do not invent questions to fill slots.
Supply the actual failed command, expected/observed behavior, attempted correction and relevant source
pointers. Distinguish a check failure from a check that never ran. Ask each Scout for evidence supporting
or contradicting its hypothesis and remaining unknowns, not a vote or permission to repair. The parent
selects one evidence-backed correction and carries its rationale, references and uncertainty into the
existing Worker objective/handoff. Reuse retained findings; do not redispatch the same question against
unchanged failure evidence. If needed evidence is outside repository reads, use the parent/Worker's
existing diagnostics. Keep the same Mission, cumulative accounting and retry/rescue/Review boundaries.

Each prompt includes one concrete question, an exact project_root and exactly one standalone line:
missing_evidence_code: <${SCOUT_EVIDENCE_CODES.join(" | ")}>
The code classifies discovery as well as a known gap; proof of a blocking deficit is not required.
Supply useful known_paths or repository search areas as starting points, not an exhaustive read allowlist.
Scouts use Read/Glob/Grep to follow relevant callers and tests under that project with native host permissions.
External resources, session history and arbitrary artifacts stay with the parent/Worker's existing diagnostics;
Scout does not edit, execute validation, browse the web, dispatch children or perform SourceReview.

Merge useful source path/line references, facts and unresolved risks into the next Worker objective and
handoff context, rather than asking the Worker or Advisor to repeat unchanged discovery. Preserve uncertainty
and contradictions; an incomplete sibling does not invalidate useful results or require an automatic retry.
Read referenced source when needed for authorship, a real contradiction or evidence freshness, not a fresh
whole-repository survey. Discovery is advice, never formal validation, independent Review or acceptance.
`;
}
