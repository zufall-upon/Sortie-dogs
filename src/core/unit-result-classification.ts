export interface FailedValidationExecution {
  readonly command: readonly string[];
  readonly outcome: "fail";
  readonly exitCode: number | null;
}

export interface UnitResultClassification {
  readonly disposition: "succeeded" | "failed" | "cancelled";
  readonly resultClass: "acceptance" | "process-defect" | "interrupted";
  readonly failure?: FailedValidationExecution;
}

/** Classify only host-observed native results. Missing settlement remains a process defect. */
export function classifyUnitResult(input: {
  readonly validated: boolean;
  readonly interrupted: boolean;
  readonly failedValidation?: FailedValidationExecution;
}): UnitResultClassification {
  if (input.validated) return { disposition: "succeeded", resultClass: "acceptance" };
  if (input.interrupted) return { disposition: "cancelled", resultClass: "interrupted" };
  if (input.failedValidation !== undefined) {
    return { disposition: "failed", resultClass: "acceptance", failure: input.failedValidation };
  }
  return { disposition: "failed", resultClass: "process-defect" };
}
