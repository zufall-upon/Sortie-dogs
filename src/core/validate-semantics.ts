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

export type HandoffRuleCode = "H002" | "H003" | "H004" | "H005";

export interface HandoffRuleIssue {
  code: HandoffRuleCode;
  path: string;
  message: string;
}

const INVALID_PATH_MESSAGE = "Path must be a valid repository-relative path.";
const DUPLICATE_PATH_MESSAGE = "Path duplicates another entry after normalization.";
const RULE_MESSAGES: Readonly<Record<HandoffRuleCode, string>> = {
  H002: "Scope path is excluded by the same scope.",
  H003: "Source path is outside the effective scope.",
  H004: "State has neither a next action nor completion evidence.",
  H005: "Blocker needed action is a placeholder.",
};

// H005 placeholder vocabulary is intentionally centralized here.
const BLOCKER_ACTION_PLACEHOLDERS = new Set([
  "?",
  "n/a",
  "none",
  "tbd",
  "todo",
  "unknown",
  "unspecified",
]);

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

function normalizePath(path: string): string | undefined {
  try {
    return pathUtils.normalizeRelativePath(path);
  } catch (error) {
    if (error instanceof pathUtils.RelativePathError) return undefined;
    throw error;
  }
}

function isWithin(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}

function lintHandoffRules(handoff: Handoff): HandoffRuleIssue[] {
  const issues: HandoffRuleIssue[] = [];
  const scopePaths = handoff.scope?.paths.map(normalizePath).filter((path): path is string => path !== undefined) ?? [];
  const excludes = handoff.scope?.excludes?.map(normalizePath).filter((path): path is string => path !== undefined) ?? [];

  handoff.scope?.paths.forEach((path, index) => {
    const normalized = normalizePath(path);
    if (normalized !== undefined && excludes.some((exclude) => isWithin(normalized, exclude))) {
      issues.push({ code: "H002", path: `/scope/paths/${index}`, message: RULE_MESSAGES.H002 });
    }
  });

  handoff.sources?.forEach((source, index) => {
    const normalized = normalizePath(source.path);
    if (normalized === undefined || handoff.scope === undefined) return;
    const included = scopePaths.some((scopePath) => isWithin(normalized, scopePath));
    const excluded = excludes.some((exclude) => isWithin(normalized, exclude));
    if (!included || excluded) {
      issues.push({ code: "H003", path: `/sources/${index}/path`, message: RULE_MESSAGES.H003 });
    }
  });

  const completed =
    handoff.state.done.length > 0 &&
    handoff.state.blocked.length === 0 &&
    handoff.verification.length > 0 &&
    handoff.verification.every(({ status }) => status === "pass");
  if (handoff.state.next.length === 0 && !completed) {
    issues.push({ code: "H004", path: "/state/next", message: RULE_MESSAGES.H004 });
  }

  handoff.state.blocked.forEach((blocker, index) => {
    if (BLOCKER_ACTION_PLACEHOLDERS.has(blocker.needed.trim().toLowerCase())) {
      issues.push({ code: "H005", path: `/state/blocked/${index}/needed`, message: RULE_MESSAGES.H005 });
    }
  });

  return issues;
}

export function lintHandoff(handoff: Handoff): Array<SemanticIssue | HandoffRuleIssue> {
  const issues: Array<SemanticIssue | HandoffRuleIssue> = lintHandoffRules(handoff);

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
