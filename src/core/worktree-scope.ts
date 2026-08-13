import { normalizeRelativePath } from "./path.js";

export type WorktreeScope = { readonly read: readonly string[]; readonly write: readonly string[] };

/** Canonical, case-folded repository-relative scope identity. */
export function normalizeWorktreeScopePath(path: string): string {
  if (typeof path !== "string" || /[\u0000-\u001F\u007F]/u.test(path)) {
    throw new TypeError("Scope path is invalid.");
  }
  const normalized = normalizeRelativePath(path);
  if (normalized !== path) throw new TypeError("Scope path must already be normalized.");
  return normalized.toLowerCase();
}

export function normalizeWorktreeScope(scope: WorktreeScope): WorktreeScope {
  const read = [...new Set(scope.read.map(normalizeWorktreeScopePath))].sort();
  const write = [...new Set(scope.write.map(normalizeWorktreeScopePath))].sort();
  return { read, write };
}

export function worktreeScopesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function worktreeScopesConflict(left: WorktreeScope, right: WorktreeScope): boolean {
  return left.write.some((path) => [...right.write, ...right.read].some((other) => worktreeScopesOverlap(path, other))) ||
    right.write.some((path) => left.read.some((other) => worktreeScopesOverlap(path, other)));
}
