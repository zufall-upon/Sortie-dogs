"""Small adapter-side boundaries for an isolated FrontierHarness CLI gateway."""
import json
from functools import lru_cache
from pathlib import Path
import subprocess
import re


@lru_cache(maxsize=1)
def _agent_registry():
    package = Path(__file__).resolve().parents[1]
    candidates = (package / "src/plugin/frontierharness-agent-tool-registry.json",
                  package / "dist/plugin/frontierharness-agent-tool-registry.json")
    for path in candidates:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            continue
        if not isinstance(value, dict) or value.get("schema_version") != 1 or not isinstance(value.get("roles"), dict):
            raise RuntimeError("frontierharness-agent-tool-registry-invalid")
        return value
    raise RuntimeError("frontierharness-agent-tool-registry-missing")


def _runtime_agent(role):
    try:
        return _agent_registry()["runtime_agents"][role]
    except KeyError as error:
        raise ValueError("unknown FrontierHarness agent role") from error


def _logical_role(role):
    if re.fullmatch(r"dog-reviewer-correction-v010-[a-f0-9]{16}", role):
        return "dog-reviewer"
    runtime_agents = _agent_registry()["runtime_agents"]
    runtime_role = next((logical for logical, runtime in runtime_agents.items() if runtime == role), None)
    if runtime_role is not None:
        return runtime_role
    return role if role in _agent_registry()["roles"] else None


# Keep the runtime profile's logical MkII roles and external V010 names distinct.
CHILD_ROUTES = {
    _runtime_agent(role): tuple(_runtime_agent(child) for child in policy["children"])
    for role, policy in _agent_registry()["roles"].items()
}


def product_worker_chain(sessions, mission_roots):
    """Collect every supported Worker parent in one native Mission family.

    A continued Mission can have multiple Coordinator sessions. Selecting only
    the first Coordinator loses later, equally valid Worker calls. Keep the
    first entries for the existing display contract, but validate all siblings.
    """
    operator_agent = _runtime_agent("dog-coordinator")
    coordinator_agent = _runtime_agent("dog-operator")
    worker_agent = _runtime_agent("dog-worker")
    operators = {row["session_id"]: row for row in sessions
                 if row["agent"] == operator_agent and row["parent_id"] is None}
    # Observed Operators are a fallback, not alternatives to a selected Mission.
    roots = set(mission_roots) or operators.keys()
    for root in sorted(roots):
        coordinators = [row for row in sessions if row["agent"] == coordinator_agent
                        and row["parent_id"] == root]
        coordinator_ids = {row["session_id"] for row in coordinators}
        workers = [row for row in sessions if row["agent"] == worker_agent
                   and row["parent_id"] in {root, *coordinator_ids}]
        if workers:
            return {operator_agent: operators.get(root),
                    coordinator_agent: coordinators[0] if coordinators else None,
                    worker_agent: workers[0], "workers": workers, "root": root,
                    "coordinator_session_ids": sorted(coordinator_ids)}
    return None


def _role_actions(role, *, correction=False):
    logical = _logical_role(role)
    if logical is None:
        raise ValueError("unknown FrontierHarness agent role")
    policy = _agent_registry()["roles"][logical]
    families = [policy.get("tool_families", {})]
    if correction:
        families.append(policy.get("correction_tool_families", {}))
    return {action for family in families for actions in family.values() for action in actions}


def _role_native_tools(role, *, correction=False):
    logical = _logical_role(role)
    if logical is None:
        raise ValueError("unknown FrontierHarness agent role")
    policy = _agent_registry()["roles"][logical]
    families = [policy.get("native_tool_families", {})]
    if correction:
        families.append(policy.get("correction_native_tool_families", {}))
    return {tool for family in families for tools in family.values() for tool in tools}


def product_agent_permissions(role, tools, *, allow_execute=False, correction=False):
    registry = _agent_registry()
    logical = _logical_role(role)
    if logical is None:
        raise ValueError("unknown FrontierHarness agent role")
    actions = _role_actions(role, correction=correction)
    native_tools = _role_native_tools(role, correction=correction)
    prefix = registry["tool_prefix"]
    # The caller's list is the public request; the shared role/tool-family schema
    # supplies missing members such as native direct start/finish and Reviewer.
    requested = {tool[len(prefix):] if tool.startswith(prefix) else tool for tool in tools if isinstance(tool, str)}
    unknown = requested - actions - native_tools
    if unknown:
        raise ValueError("caller requested a tool outside the registered role family")
    granted = actions
    permissions = [{"action": "*", "resource": "*", "effect": "deny"}]
    if allow_execute and "execute" in registry["roles"][logical].get("core_tools", []):
        permissions.append({"action": "execute", "resource": "*", "effect": "allow"})
    permissions.extend({"action": prefix + tool, "resource": "*", "effect": "allow"} for tool in sorted(granted))
    permissions.extend({"action": tool, "resource": "*", "effect": "allow"} for tool in sorted(native_tools))
    permissions.extend({"action": "subagent", "resource": _runtime_agent(child), "effect": "allow"}
                       for child in registry["roles"][logical]["children"])
    return permissions


def install_native_docker_plugin(directory):
    """Install the explicit native route in a NEW gateway, never a frozen run.

    Call from the existing runner's gateway preparation after runtime assets are
    copied. Keep the returned package entry in the ordinary V2 plugins list.
    """
    package = Path(__file__).resolve().parents[1]
    destination = Path(directory) / ".opencode/plugins/docker-task"
    (destination / "scripts").mkdir(parents=True, exist_ok=True)
    (destination / "dist/plugin").mkdir(parents=True, exist_ok=True)
    with (destination / "index.js").open("x", encoding="utf-8") as stream:
        stream.write('export { default } from "./scripts/frontierharness-docker-task.mjs";\n')
    with (destination / "scripts/frontierharness-docker-task.mjs").open("xb") as stream:
        stream.write(Path(__file__).with_name("frontierharness-docker-task.mjs").read_bytes())
    for name in ("docker-validation.js", "docker-workspace-read-fallback.js"):
        with (destination / "dist/plugin" / name).open("xb") as stream:
            stream.write((package / "dist/plugin" / name).read_bytes())
    return "./.opencode/plugins/docker-task"


def native_gateway_config(model, container_id, instruction, *, allowed_models,
                          runtime_plugin="./.opencode/plugins/00-sortie-runtime"):
    """Use the existing plugin-loading entrypoint and shared role permissions."""
    registry = _agent_registry()
    agents = {}
    for logical, policy in registry["roles"].items():
        runtime = _runtime_agent(logical)
        agents[runtime] = {
            "mode": "primary" if logical == "dog-coordinator" else "subagent",
            "permissions": product_agent_permissions(
                runtime, (), allow_execute="execute" in policy.get("core_tools", ()),
            ) + [{"action": "read", "resource": ".sortie-dogs-v010/*", "effect": "allow"}],
        }
    return {
        "$schema": "https://opencode.ai/config.json",
        "default_agent": _runtime_agent("dog-coordinator"),
        "experimental": {"subagent_depth": 2},
        "agents": agents,
        "plugins": [runtime_plugin, {
            "package": "./.opencode/plugins/docker-task",
            "options": {"container": container_id, "instruction": instruction,
                        "model": model, "allowedModels": sorted(allowed_models)},
        }],
    }


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
