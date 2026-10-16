"""Retain FrontierHarness' official DeepSWE patch before Pier cleanup.

Wrap ``_OAuthDockerGateway._invoke_gateway`` from
``PierOAuthDockerAgent.run`` with ``run_with_artifact_recovery``. Pass the
validated ``metadata.base_commit_hash``, the trial's
``Path(self.logs_dir).parent / "artifacts" / "model.patch"``, and a callback
that returns true only when the native observation has
``cleanup_complete is True``. The helper then writes the same
``git diff --binary <base_commit> HEAD`` artifact and downloads it before
Pier's owner environment is cleaned up. It never runs on success, skips
cancellation and unconfirmed writers, annotates recovery outcomes, and
re-raises the original agent failure when recovery itself fails.

Adapter call shape::

    await run_with_artifact_recovery(
        lambda: self._invoke_gateway(instruction, environment, context),
        environment,
        base_commit=validated_base_commit,
        target_path=Path(self.logs_dir).parent / "artifacts" / "model.patch",
        writers_stopped=lambda: native_cleanup_complete(self.observation_path),
    )

``PierArtifactRecoveryMixin`` supplies this run method for the campaign's Pier
adapter. Its owner provides ``artifact_base_commit`` from validated task metadata
and the existing observation/log paths; it does not modify Pier or the verifier.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Awaitable, Callable


ARTIFACT_SOURCE = "/logs/artifacts/model.patch"
_BASE_COMMIT_RE = re.compile(r"[0-9a-f]{40}\Z")


class ArtifactRecoveryError(RuntimeError):
    """A stable, non-sensitive reason why official patch recovery failed."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def official_patch_command(base_commit: str) -> str:
    """Return the official hook command for a validated base commit."""
    if not isinstance(base_commit, str) or _BASE_COMMIT_RE.fullmatch(base_commit) is None:
        raise ArtifactRecoveryError("invalid-base-commit")
    return (
        "cd /app && mkdir -p /logs/artifacts && "
        "git config --global --add safe.directory /app && "
        f"git diff --binary {base_commit} HEAD > {ARTIFACT_SOURCE}"
    )


def native_cleanup_complete(observation_path: str | Path) -> bool:
    """Return true only for an explicit native cleanup-complete observation."""
    try:
        observation = json.loads(Path(observation_path).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError, TypeError):
        return False
    return isinstance(observation, dict) and observation.get("cleanup_complete") is True


async def _retain_official_patch(
    environment: Any,
    *,
    base_commit: str,
    target_path: str | Path,
) -> tuple[int, str]:
    command = official_patch_command(base_commit)
    try:
        result = await environment.exec(command=command, timeout_sec=300)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        raise ArtifactRecoveryError(f"official-hook-exec-{type(exc).__name__}") from exc

    if result.return_code != 0:
        raise ArtifactRecoveryError(f"official-hook-exit-{result.return_code}")

    target = Path(target_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{target.name}.", suffix=".recovery", dir=target.parent
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        try:
            await environment.download_file(
                source_path=ARTIFACT_SOURCE,
                target_path=temporary,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            raise ArtifactRecoveryError(f"artifact-download-{type(exc).__name__}") from exc

        if temporary.is_symlink() or not temporary.is_file():
            raise ArtifactRecoveryError("downloaded-artifact-missing")
        content = temporary.read_bytes()

        if target.is_symlink() or (target.exists() and not target.is_file()):
            raise ArtifactRecoveryError("existing-artifact-not-a-file")
        if target.exists():
            if target.read_bytes() != content:
                raise ArtifactRecoveryError("existing-artifact-content-conflict")
        else:
            os.replace(temporary, target)

        return len(content), hashlib.sha256(content).hexdigest()
    finally:
        temporary.unlink(missing_ok=True)


async def run_with_artifact_recovery(
    run: Callable[[], Awaitable[Any]],
    environment: Any,
    *,
    base_commit: str,
    target_path: str | Path,
    writers_stopped: Callable[[], bool],
) -> Any:
    """Run an adapter call; retain the official patch only after a run failure.

    ``writers_stopped`` must inspect positive lifecycle evidence rather than
    infer completion from a missing process or output file. Recovery failures
    are attached as exception notes and do not replace the original failure.
    """
    try:
        return await run()
    except BaseException as original:
        original_traceback = original.__traceback__
        if isinstance(original, asyncio.CancelledError):
            original.add_note(
                "Frontier model.patch recovery skipped: run cancelled; writer state not asserted."
            )
            raise

        try:
            stopped = writers_stopped() is True
        except asyncio.CancelledError as cancelled:
            original.add_note(
                "Frontier model.patch recovery interrupted while checking writer cleanup."
            )
            cancelled.add_note(f"Original agent failure retained: {type(original).__name__}.")
            raise cancelled from original
        except BaseException as state_error:
            original.add_note(
                "Frontier model.patch recovery skipped: writer-stop check failed "
                f"({type(state_error).__name__})."
            )
            raise original.with_traceback(original_traceback)

        if not stopped:
            original.add_note(
                "Frontier model.patch recovery skipped: writer stop not confirmed."
            )
            raise

        try:
            size, digest = await _retain_official_patch(
                environment,
                base_commit=base_commit,
                target_path=target_path,
            )
        except asyncio.CancelledError as cancelled:
            original.add_note(
                "Frontier model.patch recovery interrupted; original agent failure retained."
            )
            cancelled.add_note(f"Original agent failure retained: {type(original).__name__}.")
            raise cancelled from original
        except BaseException as recovery_error:
            code = (
                recovery_error.code
                if isinstance(recovery_error, ArtifactRecoveryError)
                else type(recovery_error).__name__
            )
            original.add_note(f"Frontier model.patch recovery failed: {code}.")
            raise original.with_traceback(original_traceback)

        original.add_note(
            f"Frontier model.patch recovery retained bytes={size}, sha256={digest}."
        )
        raise original.with_traceback(original_traceback)


class PierArtifactRecoveryMixin:
    """Adapter-side run boundary, before Pier can delete the owned environment."""

    async def run(self, instruction: str, environment: Any, context: Any) -> Any:
        return await run_with_artifact_recovery(
            lambda: self._invoke_gateway(instruction, environment, context),
            environment,
            base_commit=self.artifact_base_commit,
            target_path=Path(self.logs_dir).parent / "artifacts" / "model.patch",
            writers_stopped=lambda: native_cleanup_complete(self.observation_path),
        )
