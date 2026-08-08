import type {
  Handoff,
  ManifestDiagnostic,
  ManifestDiagnosticCode,
  OperationManifest,
} from "./types.js";

const pathUtils: typeof import("./path.js") = await import(
  `./path.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`
);

const MESSAGES: Readonly<Record<ManifestDiagnosticCode, string>> = {
  H001_PATH_RELATIVE: "Manifest path must be a valid repository-relative path.",
  H011_VALIDATION_MISSING: "A required manifest validation has not passed.",
  M002_SCOPE_NOT_ALLOWED: "Scope path is not declared in the operation manifest.",
  M003_SOURCE_NOT_DECLARED: "Source path is not declared in the operation manifest.",
  M004_VERIFICATION_NOT_DECLARED: "Verification check is not declared in the operation manifest.",
  M005_CHANGED_PATH_NOT_WRITABLE: "Changed path is not writable according to the operation manifest.",
  M007_CHANGED_PATHS_MISSING: "Changed paths were not provided.",
};

function normalizePath(path: string): string | undefined {
  try {
    return pathUtils.normalizeRelativePath(path);
  } catch (error) {
    if (error instanceof pathUtils.RelativePathError) return undefined;
    throw error;
  }
}

function collectManifestPaths(
  paths: readonly string[],
  pointer: string,
  diagnostics: ManifestDiagnostic[],
): Set<string> {
  const normalizedPaths = new Set<string>();
  paths.forEach((path, index) => {
    let normalized: ReturnType<typeof pathUtils.normalizeManifestPath> | undefined;
    try {
      normalized = pathUtils.normalizeManifestPath(path);
    } catch (error) {
      if (!(error instanceof pathUtils.RelativePathError)) throw error;
    }
    if (normalized === undefined) {
      diagnostics.push({
        code: "H001_PATH_RELATIVE",
        severity: "error",
        pointer: `/manifest/${pointer}/${index}`,
        message: MESSAGES.H001_PATH_RELATIVE,
      });
    } else if (normalized.kind === "relative") {
      // Absolute manifest targets authorize tools only. Handoff scope/source and Git paths remain
      // repository-relative and therefore never compare equal to an external target.
      normalizedPaths.add(normalized.path);
    }
  });
  return normalizedPaths;
}

function comparePointers(left: string, right: string): number {
  const leftSegments = left.split("/");
  const rightSegments = right.split("/");
  const length = Math.min(leftSegments.length, rightSegments.length);
  for (let index = 0; index < length; index += 1) {
    const leftSegment = leftSegments[index];
    const rightSegment = rightSegments[index];
    if (leftSegment === rightSegment) continue;
    if (/^\d+$/.test(leftSegment) && /^\d+$/.test(rightSegment)) {
      return BigInt(leftSegment) < BigInt(rightSegment) ? -1 : 1;
    }
    return leftSegment < rightSegment ? -1 : 1;
  }
  return leftSegments.length - rightSegments.length;
}

function compareDiagnostics(left: ManifestDiagnostic, right: ManifestDiagnostic): number {
  const pointerOrder = comparePointers(left.pointer, right.pointer);
  if (pointerOrder !== 0) return pointerOrder;
  return left.code < right.code ? -1 : left.code > right.code ? 1 : 0;
}

function addPathDiagnostics(
  diagnostics: ManifestDiagnostic[],
  paths: readonly string[],
  allowed: ReadonlySet<string>,
  code: "M002_SCOPE_NOT_ALLOWED" | "M005_CHANGED_PATH_NOT_WRITABLE",
  pointer: (index: number) => string,
): void {
  const reported = new Set<string>();
  paths.forEach((path, index) => {
    const normalized = normalizePath(path);
    if (normalized !== undefined && (allowed.has(normalized) || reported.has(normalized))) return;
    if (normalized !== undefined) reported.add(normalized);
    diagnostics.push({
      code,
      severity: "error",
      pointer: pointer(index),
      message: MESSAGES[code],
    });
  });
}

/** Compare one schema-valid handoff with one schema-valid operation manifest. */
export function validateManifest(
  handoff: Handoff,
  manifest: OperationManifest,
  changedPaths: readonly string[] | undefined,
  changedPathsProvided: boolean,
  options: { readonly requirePassedValidation?: boolean } = {},
): ManifestDiagnostic[] {
  const diagnostics: ManifestDiagnostic[] = [];
  const readable = collectManifestPaths(manifest.read, "read", diagnostics);
  const writable = collectManifestPaths(manifest.write, "write", diagnostics);
  const readableOrWritable = new Set([...readable, ...writable]);
  const declaredValidation = new Set(manifest.validation);

  if (handoff.scope !== undefined) {
    addPathDiagnostics(
      diagnostics,
      handoff.scope.paths,
      readableOrWritable,
      "M002_SCOPE_NOT_ALLOWED",
      (index) => `/scope/paths/${index}`,
    );
  }

  const reportedSources = new Set<string>();
  handoff.sources?.forEach((source, index) => {
    const normalized = normalizePath(source.path);
    if (
      normalized !== undefined &&
      (readableOrWritable.has(normalized) || reportedSources.has(normalized))
    ) return;
    if (normalized !== undefined) reportedSources.add(normalized);
    diagnostics.push({
      code: "M003_SOURCE_NOT_DECLARED",
      severity: "error",
      pointer: `/sources/${index}/path`,
      message: MESSAGES.M003_SOURCE_NOT_DECLARED,
    });
  });

  const reportedChecks = new Set<string>();
  handoff.verification.forEach((verification, index) => {
    if (declaredValidation.has(verification.check) || reportedChecks.has(verification.check)) return;
    reportedChecks.add(verification.check);
    diagnostics.push({
      code: "M004_VERIFICATION_NOT_DECLARED",
      severity: "error",
      pointer: `/verification/${index}/check`,
      message: MESSAGES.M004_VERIFICATION_NOT_DECLARED,
    });
  });

  if (handoff.profile === "full" && options.requirePassedValidation !== false) {
    const passedChecks = new Set(
      handoff.verification
        .filter(({ status }) => status === "pass")
        .map(({ check }) => check),
    );
    if (manifest.validation.some((check) => !passedChecks.has(check))) {
      diagnostics.push({
        code: "H011_VALIDATION_MISSING",
        severity: "error",
        pointer: "/verification",
        message: MESSAGES.H011_VALIDATION_MISSING,
      });
    }
  }

  if (changedPathsProvided) {
    addPathDiagnostics(
      diagnostics,
      changedPaths ?? [],
      writable,
      "M005_CHANGED_PATH_NOT_WRITABLE",
      (index) => `/changedPaths/${index}`,
    );
  } else {
    diagnostics.push({
      code: "M007_CHANGED_PATHS_MISSING",
      severity: "warning",
      pointer: "/changedPaths",
      message: MESSAGES.M007_CHANGED_PATHS_MISSING,
    });
  }

  return diagnostics.sort(compareDiagnostics);
}
