export type RelativePathErrorReason = "empty" | "absolute" | "traversal";

export type ManifestPath =
  | { readonly kind: "relative"; readonly path: string }
  | { readonly kind: "absolute"; readonly path: string };

export class RelativePathError extends Error {
  readonly reason: RelativePathErrorReason;

  constructor(reason: RelativePathErrorReason) {
    super("Path must be a non-empty repository-relative path without traversal.");
    this.name = "RelativePathError";
    this.reason = reason;
  }
}

/**
 * Produces a platform-independent repository-relative path without resolving
 * filesystem links. Input values are intentionally omitted from errors.
 */
export function normalizeRelativePath(input: string): string {
  const unified = input.replaceAll("\\", "/");

  if (unified.startsWith("/") || /^[A-Za-z]:/.test(unified)) {
    throw new RelativePathError("absolute");
  }

  const segments = unified.split("/");
  if (segments.includes("..")) {
    throw new RelativePathError("traversal");
  }

  const normalized = segments.filter((segment) => segment !== "" && segment !== ".").join("/");
  if (normalized === "") {
    throw new RelativePathError("empty");
  }

  return normalized;
}

/**
 * Normalizes one manifest path without weakening repository-relative path handling elsewhere.
 * Absolute entries use forward slashes for stable identity on every host; traversal remains an
 * error instead of being resolved away.
 */
export function normalizeManifestPath(input: string): ManifestPath {
  const unified = input.replaceAll("\\", "/");
  const segments = unified.split("/");
  if (segments.includes("..")) throw new RelativePathError("traversal");

  const drive = /^([A-Za-z]):\/(.*)$/u.exec(unified);
  if (drive !== null) {
    const tail = drive[2].split("/").filter((segment) => segment !== "" && segment !== ".");
    return { kind: "absolute", path: `${drive[1].toUpperCase()}:/${tail.join("/")}` };
  }

  if (unified.startsWith("//")) {
    const tail = unified.slice(2).split("/").filter((segment) => segment !== "" && segment !== ".");
    if (tail.length < 2) throw new RelativePathError("absolute");
    return { kind: "absolute", path: `//${tail.join("/")}` };
  }

  if (unified.startsWith("/")) {
    const tail = segments.filter((segment) => segment !== "" && segment !== ".");
    return { kind: "absolute", path: `/${tail.join("/")}` };
  }

  return { kind: "relative", path: normalizeRelativePath(input) };
}
