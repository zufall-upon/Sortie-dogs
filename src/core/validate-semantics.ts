import type { Handoff, SemanticIssue } from "./types.js";

const pathUtils: typeof import("./path.js") = await import(
  `./path.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`
);

const HASH_LENGTHS = {
  sha256: 64,
  sha512: 128,
} as const;

const HEX_DIGEST = /^[0-9a-f]+$/i;
const INVALID_HASH_MESSAGE = "Source hash must use a supported algorithm and hexadecimal digest.";

export interface H001Issue {
  code: "H001";
  path: string;
  message: string;
}

export type HandoffRuleCode = "H002" | "H003" | "H004" | "H005" | "H008" | "H009" | "H010";

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
  H008: "Creation timestamp is not a real RFC 3339 date-time with an offset.",
  H009: "Value resembles a credential or high-entropy token.",
  H010: "Claim must contain a non-whitespace character.",
};

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /(?:^|[^A-Z0-9])AKIA[0-9A-Z]{16}(?=$|[^A-Z0-9])/,
  /(?:^|[^A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})(?=$|[^A-Za-z0-9_])/,
  /(?:^|[^A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{10,}/,
  /(?:^|[^A-Za-z0-9_-])AIza[A-Za-z0-9_-]{35}/,
  /(?:^|[^A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{20,}/,
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
  /(?:^|\s)eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}(?=$|\s)/,
];

const TOKEN_CANDIDATES = /[A-Za-z0-9_+/=-]{16,256}/g;
const COMMON_DIGEST = /^(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64}|[0-9a-f]{96}|[0-9a-f]{128})$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCAN_WINDOW_LENGTH = 4096;
const SCAN_WINDOW_OVERLAP = 256;

function shannonEntropy(value: string): number {
  const frequencies = new Map<string, number>();
  for (const character of value) frequencies.set(character, (frequencies.get(character) ?? 0) + 1);

  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function isHighEntropyToken(candidate: string): boolean {
  if (COMMON_DIGEST.test(candidate) || UUID.test(candidate)) return false;
  const hasLower = /[a-z]/.test(candidate);
  const hasUpper = /[A-Z]/.test(candidate);
  const hasDigit = /\d/.test(candidate);
  const hasEncodingSymbol = /[_+/=]/.test(candidate);
  const tokenShape =
    (hasLower && hasUpper && (hasDigit || hasEncodingSymbol)) ||
    (hasLower && hasDigit && hasEncodingSymbol);
  return tokenShape && shannonEntropy(candidate) >= 3.5;
}

function isSecretLike(value: string): boolean {
  const step = SCAN_WINDOW_LENGTH - SCAN_WINDOW_OVERLAP;
  for (let offset = 0; offset < value.length; offset += step) {
    const window = value.slice(offset, offset + SCAN_WINDOW_LENGTH);
    if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(window))) return true;
    if ([...window.matchAll(TOKEN_CANDIDATES)].some(([candidate]) => isHighEntropyToken(candidate))) return true;
  }
  return false;
}

function escapePointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function lintSecretLikeValues(handoff: Handoff): HandoffRuleIssue[] {
  const issues: HandoffRuleIssue[] = [];
  const ancestors = new WeakSet<object>();

  function visit(value: unknown, path: string): void {
    if (typeof value === "string") {
      if (isSecretLike(value)) issues.push({ code: "H009", path, message: RULE_MESSAGES.H009 });
      return;
    }
    if (value === null || typeof value !== "object" || ancestors.has(value)) return;

    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => visit(entry, `${path}/${index}`));
        return;
      }
      Object.entries(value).forEach(([key, entry], index) => {
        if (isSecretLike(key)) {
          const position = `${path}/@${index}`;
          issues.push({ code: "H009", path: `${position}/key`, message: RULE_MESSAGES.H009 });
          visit(entry, `${position}/value`);
        } else {
          visit(entry, `${path}/${escapePointerSegment(key)}`);
        }
      });
    } finally {
      ancestors.delete(value);
    }
  }

  visit(handoff, "");
  return issues;
}

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

function isValidTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (match === null) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);

  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 60 || offsetHour > 23 || offsetMinute > 59) {
    return false;
  }

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1];
}

function addBlankClaimIssue(issues: Array<HandoffRuleIssue | SemanticIssue>, value: string, path: string): void {
  if (value.trim().length === 0) {
    issues.push({ code: "H010", path, message: RULE_MESSAGES.H010 });
  }
}

function lintHandoffRules(handoff: Handoff): Array<HandoffRuleIssue | SemanticIssue> {
  const issues: Array<HandoffRuleIssue | SemanticIssue> = [...lintSecretLikeValues(handoff)];
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

  handoff.verification.forEach((verification, index) => {
    const exitCode = verification.exit_code;
    const mismatch =
      (verification.status === "pass" && exitCode !== 0) ||
      (verification.status === "fail" && (typeof exitCode !== "number" || exitCode === 0)) ||
      (verification.status === "not_run" && exitCode !== null);

    if (mismatch) {
      issues.push({
        code: "H006",
        path: `/verification/${index}/exit_code`,
        message: `exit_code is inconsistent with verification status ${verification.status}`,
      });
    }
  });

  handoff.sources?.forEach((source, index) => {
    if (source.hash === undefined) return;
    const separator = source.hash.indexOf(":");
    if (separator < 1) {
      issues.push({
        code: "H007",
        path: `/sources/${index}/hash`,
        message: INVALID_HASH_MESSAGE,
      });
      return;
    }
    const algorithm = source.hash.slice(0, separator);
    const digest = source.hash.slice(separator + 1);
    const expectedLength = Object.hasOwn(HASH_LENGTHS, algorithm)
      ? HASH_LENGTHS[algorithm as keyof typeof HASH_LENGTHS]
      : undefined;
    if (expectedLength === undefined || digest.length !== expectedLength || !HEX_DIGEST.test(digest)) {
      issues.push({
        code: "H007",
        path: `/sources/${index}/hash`,
        message: expectedLength === undefined
          ? INVALID_HASH_MESSAGE
          : `${algorithm} digest must contain ${expectedLength} hexadecimal characters.`,
      });
    }
  });

  if (!isValidTimestamp(handoff.created_at)) {
    issues.push({ code: "H008", path: "/created_at", message: RULE_MESSAGES.H008 });
  }

  addBlankClaimIssue(issues, handoff.task.title, "/task/title");
  addBlankClaimIssue(issues, handoff.task.objective, "/task/objective");
  handoff.state.done.forEach((claim, index) => addBlankClaimIssue(issues, claim, `/state/done/${index}`));
  handoff.state.next.forEach((claim, index) => addBlankClaimIssue(issues, claim, `/state/next/${index}`));
  handoff.state.blocked.forEach((blocker, index) => {
    addBlankClaimIssue(issues, blocker.reason, `/state/blocked/${index}/reason`);
    addBlankClaimIssue(issues, blocker.needed, `/state/blocked/${index}/needed`);
  });
  handoff.risks.forEach((risk, index) => {
    addBlankClaimIssue(issues, risk.description, `/risks/${index}/description`);
    if (risk.mitigation !== undefined) addBlankClaimIssue(issues, risk.mitigation, `/risks/${index}/mitigation`);
  });
  handoff.verification.forEach((verification, index) => {
    addBlankClaimIssue(issues, verification.check, `/verification/${index}/check`);
    addBlankClaimIssue(issues, verification.summary, `/verification/${index}/summary`);
  });

  return issues;
}

export function lintHandoff(handoff: Handoff): Array<H001Issue | HandoffRuleIssue | SemanticIssue> {
  return [...lintHandoffPaths(handoff), ...lintHandoffRules(handoff)];
}
