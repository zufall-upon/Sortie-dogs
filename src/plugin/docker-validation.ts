import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { posix } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const CONTAINER_ID = /^[a-f0-9]{12,64}$/u;
const SNAPSHOT_MARKER = "SORTIE_DOCKER_WORKSPACE_V1";
// Terminal tasks need not contain Git at all. Capture actual bytes and file
// identity, including ignored inputs; timestamps alone are not candidate edits.
const FILE_SNAPSHOT = String.raw`
import hashlib, json, os, stat, subprocess
cwd = os.path.realpath(os.getcwd())
try:
    root = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], stderr=subprocess.DEVNULL, text=True).strip()
    head = subprocess.check_output(["git", "rev-parse", "--verify", "HEAD^{tree}"], stderr=subprocess.DEVNULL, text=True).strip()
except (OSError, subprocess.CalledProcessError):
    root, head = cwd, "no-git"
root = os.path.realpath(root)
rows = []
def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()
for directory, dirs, files in os.walk(root, followlinks=False, onerror=lambda error: (_ for _ in ()).throw(error)):
    if directory == root:
        dirs[:] = [name for name in dirs if name != ".git"]
        files = [name for name in files if name != ".git"]
    for name in [".", *dirs, *files]:
        path = directory if name == "." else os.path.join(directory, name)
        relative = os.path.relpath(path, root)
        info = os.lstat(path)
        mode = stat.S_IMODE(info.st_mode)
        if stat.S_ISREG(info.st_mode):
            value = [relative, "file", mode, digest(path)]
        elif stat.S_ISLNK(info.st_mode):
            target = os.path.realpath(path)
            # Internal directory targets are captured at their own lexical path.
            # External directory trees are not silently omitted from a proof.
            if os.path.isdir(path) and os.path.commonpath([root, target]) != root:
                raise RuntimeError("external-directory-link-snapshot-unavailable")
            value = [relative, "link", mode, os.readlink(path), digest(path) if os.path.isfile(path) else None]
        elif stat.S_ISDIR(info.st_mode):
            value = [relative, "directory", mode]
        else:
            raise RuntimeError("unsupported-workspace-file-type")
        rows.append(value)
tree = hashlib.sha256(json.dumps(sorted(rows), ensure_ascii=True, separators=(",", ":")).encode()).hexdigest()
print("SORTIE_DOCKER_WORKSPACE_V1")
print(cwd)
print(root)
print(tree)
print(hashlib.sha256(head.encode()).hexdigest())
print("0" * 64)
`;
const SNAPSHOT_COMMAND = [
  "set -eu",
  "if command -v python3 >/dev/null 2>&1; then",
  "python3 -I -S - <<'SORTIE_WORKSPACE_PY'",
  FILE_SNAPSHOT,
  "SORTIE_WORKSPACE_PY",
  "else",
  "actual_cwd=$(pwd -P)",
  "root=$(git rev-parse --show-toplevel)",
  "cd \"$root\"",
  "tree=$(git rev-parse --verify 'HEAD^{tree}')",
  "tracked=$(git diff --binary HEAD -- | sha256sum | cut -d' ' -f1)",
  "untracked=$(git ls-files -z --others | sort -z | xargs -0 -r sha256sum -- | sha256sum | cut -d' ' -f1)",
  "printf '%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n' 'SORTIE_DOCKER_WORKSPACE_V1' \"$actual_cwd\" \"$root\" \"$tree\" \"$tracked\" \"$untracked\"",
  "fi",
].join("\n");

export interface DockerWorkspaceSnapshot {
  readonly container_id: string;
  /** Declared Docker --workdir; keep its logical alias for validation matching. */
  readonly cwd: string;
  /** Physical CWD when Docker resolves the declared path through an alias. */
  readonly actual_cwd?: string;
  readonly repository_root: string;
  readonly source: string;
  readonly candidate: string;
}

/** Hash the fixed container's actual workspace, including non-Git and ignored inputs. */
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
    if (!actualCwd || !isDockerWorkspacePath(actualCwd) || !repositoryRoot || !posix.isAbsolute(repositoryRoot) || !tree || !/^[a-f0-9]{40,64}$/u.test(tree) ||
        !tracked || !/^[a-f0-9]{64}$/u.test(tracked) || !untracked || !/^[a-f0-9]{64}$/u.test(untracked) || offset !== output.length) return undefined;
    const source = `sha256:${createHash("sha256").update(`git-tree\0${repositoryRoot}\0${tree}`).digest("hex")}`;
    // Preserve existing non-alias identities. For aliases bind the real execution
    // directory too: retargeting within the same repository must stale the proof.
    const physicalCwd = actualCwd === cwd ? [] : [actualCwd];
    const candidate = `sha256:${createHash("sha256").update(JSON.stringify([containerID, cwd, repositoryRoot, tree, tracked, untracked, ...physicalCwd])).digest("hex")}`;
    return { container_id: containerID, cwd, ...(actualCwd === cwd ? {} : { actual_cwd: actualCwd }),
      repository_root: repositoryRoot, source, candidate };
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

const READ_WORKSPACE = String.raw`
import hashlib, json, os, stat, sys
root, requested, offset, limit = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
path = os.path.realpath(os.path.join(root, requested))
if os.path.commonpath([root, path]) != root:
    raise ValueError("file-outside-candidate-workspace")
if os.path.isdir(path):
    entries = sorted(os.listdir(path))
    result = {"kind": "directory", "entries": entries[offset - 1:offset - 1 + limit], "total": len(entries)}
elif stat.S_ISREG(os.stat(path).st_mode):
    h = hashlib.sha256()
    lines, total, size = [], 0, 0
    with open(path, "rb") as stream:
        for line in stream:
            h.update(line)
            total += 1
            if offset <= total < offset + limit and size < 64000:
                text = line[:64000-size].decode("utf-8", errors="replace")
                lines.append([total, text])
                size += len(line[:64000-size])
    result = {"kind": "file", "lines": lines, "total_lines": total, "sha256": h.hexdigest()}
else:
    raise ValueError("candidate-file-not-readable")
print(json.dumps({"path": path, **result}, ensure_ascii=True))
`;

/** Inspect bytes, never execute caller-supplied code. The Review envelope's
 * immutable Docker candidate must match both before and after the read. */
export async function readDockerWorkspaceFile(containerID: string, cwd: string, candidate: string, path: string,
  offset = 1, limit = 200): Promise<Record<string, unknown>> {
  if (!/^sha256:[a-f0-9]{64}$/u.test(candidate) || typeof path !== "string" || path.includes("\0") ||
      !Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 2000) {
    throw new Error("docker-candidate-read-invalid");
  }
  const before = await captureDockerWorkspaceSnapshot(containerID, cwd);
  if (!before || before.candidate !== candidate) throw new Error("docker-review-candidate-stale-or-unavailable");
  const { stdout } = await exec("docker", ["exec", "--workdir", cwd, containerID, "python3", "-I", "-S", "-c", READ_WORKSPACE,
    before.repository_root, path, String(offset), String(limit)], { encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024 });
  const after = await captureDockerWorkspaceSnapshot(containerID, cwd);
  if (!after || after.candidate !== candidate) throw new Error("docker-review-candidate-changed-during-read");
  return { workspace: before, ...JSON.parse(stdout) };
}
