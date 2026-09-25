import { createHash } from "node:crypto";
import { ACCEPTANCE_CONTINUITY_EXTENSION, acceptanceContinuityFingerprint, inspectAcceptanceContinuity,
  type AcceptanceContinuityLedger } from "./acceptance-continuity.js";
import { validateHandoffSchema } from "./validate-schema.js";

/** Recognize only the byte-for-byte serialization produced when dispatch fills an omitted serial parent. */
export function hostRewrittenAcceptanceContinuity(
  source: Buffer,
  originalHash: string,
  expectedParent?: string,
): AcceptanceContinuityLedger | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(source.toString("utf8")); }
  catch { return undefined; }
  const validated = validateHandoffSchema(parsed);
  if (!validated.ok) return undefined;
  const handoff = validated.value;
  const ledger = inspectAcceptanceContinuity(handoff).ledger;
  const parentIsProvedPrefix = ledger !== undefined && expectedParent !== undefined &&
    ledger.criteria.slice(1).some((_value, index) =>
      acceptanceContinuityFingerprint(ledger.criteria.slice(0, index + 1)) === expectedParent);
  if (ledger === undefined || ledger.parent_fingerprint === "none" ||
    (expectedParent !== undefined && ledger.parent_fingerprint !== expectedParent) ||
    (ledger.parent_fingerprint !== ledger.fingerprint && !parentIsProvedPrefix) ||
    !source.equals(Buffer.from(`${JSON.stringify(handoff, null, 2)}\n`, "utf8"))) return undefined;
  const prior = { ...handoff, ext: { ...handoff.ext,
    [ACCEPTANCE_CONTINUITY_EXTENSION]: {
      ...(handoff.ext![ACCEPTANCE_CONTINUITY_EXTENSION] as Record<string, unknown>), parent_fingerprint: "none",
    },
  } };
  return createHash("sha256").update(JSON.stringify(prior)).digest("hex") === originalHash ? ledger : undefined;
}
