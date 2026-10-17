import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { posix } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const CONTAINER_ID = /^[a-f0-9]{12,64}$/u;
const SNAPSHOT_MARKER = "SORTIE_DOCKER_WORKSPACE_V1";
const SNAPSHOT_COMMAND = [
  "set -eu",
  "actual_cwd=$(pwd -P)",
  "root=$(git rev-parse --show-toplevel)",
  "cd \"$root\"",
  "tree=$(git rev-parse --verify 'HEAD^{tree}')",
  "tracked=$(git diff --binary HEAD -- | sha256sum | cut -d' ' -f1)",
  "untracked=$(git ls-files -z --others --exclude-standard | sort -z | xargs -0 -r sha256sum -- | sha256sum | cut -d' ' -f1)",
  "printf '%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n' 'SORTIE_DOCKER_WORKSPACE_V1' \"$actual_cwd\" \"$root\" \"$tree\" \"$tracked\" \"$untracked\"",
].join("\n");

export interface DockerWorkspaceSnapshot {
  readonly container_id: string;
  readonly cwd: string;
  readonly repository_root: string;
  readonly source: string;
  readonly candidate: string;
}

/** Hash the fixed container's Git source tree and actual tracked/untracked candidate bytes. */
export async function captureDockerWorkspaceSnapshot(containerID: string, cwd: string): Promise<DockerWorkspaceSnapshot | undefined> {
  if (!CONTAINER_ID.test(containerID) || !posix.isAbsolute(cwd) || posix.normalize(cwd) !== cwd || cwd.includes("\0")) return undefined;
  try {
    const result = await exec("docker", ["exec", "--workdir", cwd, containerID, "sh", "-lc", SNAPSHOT_COMMAND], {
      encoding: "buffer", timeout: 30_000, maxBuffer: 64 * 1024 * 1024,
    });
    const output = result.stdout as Buffer;
    let offset = 0;
    const line = (): string | undefined => {
      const end = output.indexOf(0x0a, offset);
      if (end < 0) return undefined;
      const value = output.subarray(offset, end).toString("utf8");
      offset = end + 1;
      return value;
    };
    if (line() !== SNAPSHOT_MARKER) return undefined;
    const actualCwd = line(), repositoryRoot = line(), tree = line(), tracked = line(), untracked = line();
    if (actualCwd !== cwd || !repositoryRoot || !posix.isAbsolute(repositoryRoot) || !tree || !/^[a-f0-9]{40,64}$/u.test(tree) ||
        !tracked || !/^[a-f0-9]{64}$/u.test(tracked) || !untracked || !/^[a-f0-9]{64}$/u.test(untracked) || offset !== output.length) return undefined;
    const source = `sha256:${createHash("sha256").update(`git-tree\0${repositoryRoot}\0${tree}`).digest("hex")}`;
    const candidate = `sha256:${createHash("sha256").update(JSON.stringify([containerID, cwd, repositoryRoot, tree, tracked, untracked])).digest("hex")}`;
    return { container_id: containerID, cwd, repository_root: repositoryRoot, source, candidate };
  } catch {
    return undefined;
  }
}

export function isDockerContainerID(value: unknown): value is string {
  return typeof value === "string" && CONTAINER_ID.test(value);
}

export function isDockerWorkspacePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && posix.isAbsolute(value) &&
    posix.normalize(value) === value && !value.includes("\0");
}
