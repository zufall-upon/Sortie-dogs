export type RelativePathErrorReason = "empty" | "absolute" | "traversal";

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
