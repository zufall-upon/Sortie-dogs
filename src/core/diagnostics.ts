import type {
  Diagnostic,
  Handoff,
  LintOptions,
  LintResult,
  SemanticIssue,
  SemanticIssueCode,
  Severity,
} from "./types.js";

const validateSemantics: typeof import("./validate-semantics.js") = await import(
  `./validate-semantics.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`
);

type DiagnosticIssue = ReturnType<typeof validateSemantics.lintHandoff>[number];
type DiagnosticIssueCode = DiagnosticIssue["code"];

const DEFAULT_SEVERITIES: Readonly<Record<DiagnosticIssueCode, Severity>> = {
  H001: "error",
  H002: "error",
  H003: "error",
  H004: "error",
  H005: "error",
  H006: "error",
  H007: "error",
  H008: "error",
  H009: "warning",
  H010: "error",
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePointer(left: string, right: string): number {
  const leftSegments = left.split("/");
  const rightSegments = right.split("/");
  const length = Math.min(leftSegments.length, rightSegments.length);

  for (let index = 0; index < length; index += 1) {
    const leftSegment = leftSegments[index];
    const rightSegment = rightSegments[index];
    if (leftSegment === rightSegment) continue;

    if (/^\d+$/.test(leftSegment) && /^\d+$/.test(rightSegment)) {
      const numericOrder = BigInt(leftSegment) < BigInt(rightSegment) ? -1 : BigInt(leftSegment) > BigInt(rightSegment) ? 1 : 0;
      if (numericOrder !== 0) return numericOrder;
    }

    return compareText(leftSegment, rightSegment);
  }

  return leftSegments.length - rightSegments.length;
}

function compareDiagnostics(left: Diagnostic, right: Diagnostic): number {
  return (
    comparePointer(left.pointer, right.pointer) ||
    compareText(left.code, right.code)
  );
}

function createLintResult(
  issues: readonly DiagnosticIssue[],
  profile: Handoff["profile"],
  options: LintOptions = {},
): LintResult {
  const enabledCodes = options.codes === undefined ? undefined : new Set<string>(options.codes);
  const severityOverrides = options.severity as Partial<Record<DiagnosticIssueCode, Severity>> | undefined;
  const diagnostics = issues
    .filter((issue) => enabledCodes === undefined || enabledCodes.has(issue.code))
    .map<Diagnostic>((issue) => ({
      code: issue.code as SemanticIssueCode,
      severity:
        severityOverrides?.[issue.code] ??
        (issue.code === "H006" && profile === "minimal"
          ? "warning"
          : DEFAULT_SEVERITIES[issue.code]),
      pointer: issue.path,
      message: issue.message,
    }))
    .sort(compareDiagnostics);

  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const diagnostic of diagnostics) counts[diagnostic.severity] += 1;

  return {
    diagnostics,
    counts,
    ok: counts.error === 0,
  };
}

export function lint(handoff: Handoff, options?: LintOptions): LintResult {
  return createLintResult(validateSemantics.lintHandoff(handoff), handoff.profile, options);
}
