"""Small adapter-side boundaries for an isolated FrontierHarness CLI gateway."""
from pathlib import Path
import subprocess


# Both are ordinary candidate routes: a single-unit Operator can dispatch the
# Worker directly; a multi-unit Mission delegates through its Coordinator.
CHILD_ROUTES = {
    "dog-operator": ("dogs-coordinator", "dog-worker-v010"),
    "dogs-coordinator": ("dog-worker-v010",),
    "dog-worker-v010": (),
}


def product_worker_chain(sessions, mission_roots):
    """Collect every supported Worker parent in one native Mission family.

    A continued Mission can have multiple Coordinator sessions. Selecting only
    the first Coordinator loses later, equally valid Worker calls. Keep the
    first entries for the existing display contract, but validate all siblings.
    """
    operators = {row["session_id"]: row for row in sessions
                 if row["agent"] == "dog-operator" and row["parent_id"] is None}
    # Observed Operators are a fallback, not alternatives to a selected Mission.
    roots = set(mission_roots) or operators.keys()
    for root in sorted(roots):
        coordinators = [row for row in sessions if row["agent"] == "dogs-coordinator"
                        and row["parent_id"] == root]
        coordinator_ids = {row["session_id"] for row in coordinators}
        workers = [row for row in sessions if row["agent"] == "dog-worker-v010"
                   and row["parent_id"] in {root, *coordinator_ids}]
        if workers:
            return {"dog-operator": operators.get(root),
                    "dogs-coordinator": coordinators[0] if coordinators else None,
                    "dog-worker-v010": workers[0], "workers": workers, "root": root,
                    "coordinator_session_ids": sorted(coordinator_ids)}
    return None


def product_agent_permissions(role, tools, *, allow_execute=False):
    permissions = [{"action": "*", "resource": "*", "effect": "deny"}]
    if allow_execute:
        permissions.append({"action": "execute", "resource": "*", "effect": "allow"})
    permissions.extend({"action": tool, "resource": "*", "effect": "allow"} for tool in tools)
    permissions.extend({"action": "subagent", "resource": agent, "effect": "allow"}
                       for agent in CHILD_ROUTES[role])
    return permissions


def initialize_gateway_git_root(directory):
    """Keep native snapshots inside this gateway rather than its parent repo.

    Call immediately after creating the new, empty gateway, before installing
    runtime assets, links or evidence. The Docker task's /app is unaffected.
    """
    root = Path(directory)
    (root / ".gitignore").write_text("*\n!.gitignore\n", encoding="utf-8")
    for arguments in (["init", "-q"], ["add", "--", ".gitignore"],
                      ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                       "-c", "commit.gpgsign=false", "commit", "-qm", "isolated gateway"]):
        subprocess.run(["git", "-C", str(root), *arguments], capture_output=True,
                       timeout=30, check=True)
