import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { posix } from "node:path";

// Fixed read-only transport for images with Git/coreutils but no Python. Paths
// are argv, never shell source. Node frames names and streams file bytes so long
// logical lines cannot become unbounded shell variables or buffered stdout.
const READ = String.raw`
set -eu
root=$1; requested=$2; lexical=$3; parent=$4; name=$5
fail() { printf '%s\n' "$1" >&2; exit 1; }
physical() {
  resolved=$(readlink -fn -- "$1" && printf .) || fail file-outside-candidate-workspace
  resolved=${"$"}{resolved%.}
}
inside() {
  [ "$root" = / ] && return 0
  case "$1" in "$root"|"$root"/*) return 0 ;; esac
  return 1
}
physical "$requested"; path=$resolved
if ! inside "$path"; then
  physical "$parent"; entry="${"$"}{resolved%/}/$name"
  inside "$lexical" && inside "$entry" || fail file-outside-candidate-workspace
  case "$entry" in "$root/.git"|"$root/.git/"*) fail file-outside-candidate-workspace ;; esac
  [ -L "$entry" ] && [ -L "$requested" ] && [ -f "$entry" ] || fail file-outside-candidate-workspace
  physical "$entry"
  [ "$resolved" = "$path" ] || fail file-outside-candidate-workspace
fi
if [ -d "$path" ]; then kind=d
elif [ -f "$path" ]; then kind=f
else fail candidate-file-not-readable
fi
printf 'SORTIE_READ_V1\0%s\0%s\0' "$path" "$kind"
if [ "$kind" = f ]; then cat -- "$path"
else find "$path" -mindepth 1 -maxdepth 1 -print0
fi
`;

/** Same result as the Python reader, without mutating/installing in the task. */
export function readDockerWorkspaceWithoutPython(containerID: string, cwd: string, root: string,
  requested: string, offset: number, limit: number): Promise<Record<string, unknown>> {
  // Keep the raw path for real filesystem resolution; a normalized canceled
  // directory hop must not select a different entry outside the candidate.
  const raw = posix.isAbsolute(requested) ? requested : `${root}/${requested}`;
  const lexical = posix.resolve(root, requested);
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", "--workdir", cwd, containerID, "sh", "-c", READ,
      "sortie-read", root, raw, lexical, posix.dirname(lexical), posix.basename(lexical)],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
    let failure: Error | undefined, stderr = Buffer.alloc(0), field = Buffer.alloc(0);
    const header: string[] = [], lines: [number, string][] = [];
    const hash = createHash("sha256");
    let total = 0, size = 0, pending = false, excerpt: Buffer[] = [];
    // Keep only the first offset+limit directory names in a max-heap, rather
    // than retaining an entire large directory in the gateway process.
    const names: Buffer[] = [], count = Math.min(Number.MAX_SAFE_INTEGER, offset - 1 + limit);
    const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const fail = (error: unknown) => {
      if (!failure) { failure = error instanceof Error ? error : new Error(String(error)); child.kill(); }
    };
    const keepName = (value: Buffer) => {
      if (!value.length) throw new Error("docker-candidate-directory-frame-invalid");
      // find emits actual paths using its existing -print0 capability. Keep
      // filenames only, without requiring image-side GNU -printf or JSON tools.
      value = Buffer.from(posix.basename(utf8.decode(value)));
      total++;
      if (names.length < count) {
        names.push(Buffer.from(value));
        for (let i = names.length - 1; i > 0;) {
          const parent = (i - 1) >>> 1;
          if (Buffer.compare(names[parent]!, names[i]!) >= 0) break;
          [names[parent], names[i]] = [names[i]!, names[parent]!]; i = parent;
        }
      } else if (Buffer.compare(value, names[0]!) < 0) {
        names[0] = Buffer.from(value);
        for (let i = 0;;) {
          const left = i * 2 + 1, right = left + 1;
          if (left >= names.length) break;
          const next = right < names.length && Buffer.compare(names[right]!, names[left]!) > 0 ? right : left;
          if (Buffer.compare(names[i]!, names[next]!) >= 0) break;
          [names[i], names[next]] = [names[next]!, names[i]!]; i = next;
        }
      }
    };
    const finishLine = () => {
      total++;
      if (excerpt.length) { lines.push([total, Buffer.concat(excerpt).toString("utf8")]); excerpt = []; }
      pending = false;
    };
    const fileBytes = (chunk: Buffer) => {
      hash.update(chunk);
      for (let start = 0; start < chunk.length;) {
        const newline = chunk.indexOf(10, start), end = newline < 0 ? chunk.length : newline + 1;
        pending = true;
        if (total >= offset - 1 && total < offset - 1 + limit && size < 64000) {
          const kept = chunk.subarray(start, Math.min(end, start + 64000 - size));
          excerpt.push(Buffer.from(kept)); size += kept.length;
        }
        if (newline >= 0) finishLine();
        start = end;
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      try {
        let start = 0;
        while (start < chunk.length && header.length < 3) {
          const end = chunk.indexOf(0, start);
          const part = chunk.subarray(start, end < 0 ? chunk.length : end);
          if (field.length + part.length > 65536) throw new Error("docker-candidate-read-header-invalid");
          field = Buffer.concat([field, part]);
          if (end < 0) return;
          header.push(utf8.decode(field)); field = Buffer.alloc(0); start = end + 1;
          if (header.length === 3 && (header[0] !== "SORTIE_READ_V1" || !posix.isAbsolute(header[1]!) || !["f", "d"].includes(header[2]!))) {
            throw new Error("docker-candidate-read-header-invalid");
          }
        }
        if (header.length < 3) return;
        if (header[2] === "f") fileBytes(chunk.subarray(start));
        else while (start < chunk.length) {
          const end = chunk.indexOf(0, start), part = chunk.subarray(start, end < 0 ? chunk.length : end);
          if (field.length + part.length > 65536) throw new Error("docker-candidate-directory-frame-invalid");
          field = Buffer.concat([field, part]);
          if (end < 0) return;
          keepName(field); field = Buffer.alloc(0); start = end + 1;
        }
      } catch (error) { fail(error); }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 64000) stderr = Buffer.concat([stderr, chunk.subarray(0, 64000 - stderr.length)]);
    });
    child.once("error", error => { fail(error); reject(error); });
    child.once("close", (code, signal) => {
      if (failure) { reject(failure); return; }
      if (code !== 0 || signal) { reject(new Error(`docker-candidate-read-failed:${signal ?? code}:${stderr.toString("utf8")}`)); return; }
      if (header.length !== 3 || field.length) { reject(new Error("docker-candidate-read-frame-incomplete")); return; }
      if (header[2] === "f") {
        if (pending) finishLine();
        resolve({ path: header[1], kind: "file", lines, total_lines: total, sha256: hash.digest("hex") });
      } else {
        names.sort(Buffer.compare);
        resolve({ path: header[1], kind: "directory", entries: names.slice(offset - 1, offset - 1 + limit).map(name => utf8.decode(name)), total });
      }
    });
  });
}
