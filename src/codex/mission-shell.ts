import { basename, isAbsolute } from "node:path";
import { stat } from "node:fs/promises";
import { resolveValidationExecutable } from "../core/worktree-commit-artifact.js";

export interface CodexMissionShell {
  readonly description: string;
  command(source: string): readonly string[];
}

/** Keep the source literal; only the host-owned exit trailer is appended. */
export function codexPowerShellCommand(executable: string, source: string): readonly string[] {
  return [executable, "-NoProfile", "-NonInteractive", "-Command", source +
    "\nif (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 }"];
}

/** Resolve the existing host shell, without installation or permission changes. */
export async function resolveCodexMissionShell(trustedPowerShellExecutable?: string): Promise<CodexMissionShell> {
  if (process.platform !== "win32") {
    if (trustedPowerShellExecutable) throw new Error("--trusted-pwsh is only supported on Windows.");
    return { description: "POSIX bash", command: source => ["/bin/bash", "-c", source] };
  }
  if (trustedPowerShellExecutable && (!isAbsolute(trustedPowerShellExecutable) || basename(trustedPowerShellExecutable).toLowerCase() !== "pwsh.exe"))
    throw new Error("Codex Mission requires an absolute existing pwsh.exe path.");
  const executable = await resolveValidationExecutable(trustedPowerShellExecutable ?? "pwsh.exe");
  if (!executable || !(await stat(executable)).isFile())
    throw new Error("Codex Mission requires existing PowerShell 7 (pwsh.exe). Select it with --trusted-pwsh; no shell is installed automatically.");
  return { description: "Windows PowerShell 7 (not POSIX bash)", command: source => codexPowerShellCommand(executable, source) };
}
