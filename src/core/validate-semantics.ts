import type { Handoff, SemanticIssue } from "./types.js";

const HASH_LENGTHS: Readonly<Record<string, number>> = {
  sha256: 64,
  sha512: 128,
};

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
