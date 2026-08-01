import type { Handoff, SemanticIssue } from "./types.js";

const pathUtils: typeof import("./path.js") = await import(
  `./path.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`
);

const HASH_LENGTHS: Readonly<Record<string, number>> = {
  sha256: 64,
  sha512: 128,
};

export interface H001Issue {
  code: "H001";
  path: string;
  message: string;
}

const INVALID_PATH_MESSAGE = "Path must be a valid repository-relative path.";
const DUPLICATE_PATH_MESSAGE = "Path duplicates another entry after normalization.";

function lintPathList(paths: readonly string[], pointer: string): H001Issue[] {
  const issues: H001Issue[] = [];
  const seen = new Set<string>();

  paths.forEach((path, index) => {
    try {
      const normalized = pathUtils.normalizeRelativePath(path);
      if (seen.has(normalized)) {
        issues.push({
          code: "H001",
          path: `${pointer}/${index}`,
          message: DUPLICATE_PATH_MESSAGE,
        });
      } else {
        seen.add(normalized);
      }
    } catch (error) {
      if (!(error instanceof pathUtils.RelativePathError)) throw error;
      issues.push({
        code: "H001",
        path: `${pointer}/${index}`,
        message: INVALID_PATH_MESSAGE,
      });
    }
  });

  return issues;
}

/** H001 repository-relative path and normalized-duplicate checks. */
export function lintHandoffPaths(handoff: Handoff): H001Issue[] {
  const issues: H001Issue[] = [];

  if (handoff.scope !== undefined) {
    issues.push(...lintPathList(handoff.scope.paths, "/scope/paths"));
    if (handoff.scope.excludes !== undefined) {
      issues.push(...lintPathList(handoff.scope.excludes, "/scope/excludes"));
    }
  }

  if (handoff.sources !== undefined) {
    issues.push(...lintPathList(handoff.sources.map(({ path }) => path), "/sources"));
    for (const issue of issues) {
      if (issue.path.startsWith("/sources/")) issue.path += "/path";
    }
  }

  return issues;
}

export function lintHandoff(handoff: Handoff): SemanticIssue[] {
  const issues: SemanticIssue[] = [];

  handoff.verification.forEach((verification, index) => {
    const exitCode = verification.exit_code;
    const mismatch =
      (verification.status === "pass" && exitCode !== 0) ||
      (verification.status === "fail" && (typeof exitCode !== "number" || exitCode === 0)) ||
      (verification.status === "not_run" && exitCode !== null);

    if (mismatch) {
      issues.push({
        code: "verification_exit_code_mismatch",
        path: `/verification/${index}/exit_code`,
        message: `exit_code is inconsistent with verification status ${verification.status}`,
      });
    }
  });

  handoff.sources?.forEach((source, index) => {
    if (source.hash === undefined) return;

    const separator = source.hash.indexOf(":");
    const algorithm = source.hash.slice(0, separator);
    const digest = source.hash.slice(separator + 1);
    const expectedLength = HASH_LENGTHS[algorithm];

    if (expectedLength !== undefined && digest.length !== expectedLength) {
      issues.push({
        code: "source_hash_length_mismatch",
        path: `/sources/${index}/hash`,
        message: `${algorithm} digest must contain ${expectedLength} hexadecimal characters`,
      });
    }
  });

  return issues;
}
