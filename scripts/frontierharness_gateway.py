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
