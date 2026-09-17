/**
 * This runtime answers an unsupported caller request with a stable typed code instead of prose, so the
 * caller can correct the request and continue. Unexpected host failures keep their native message shape.
 * Callers that measure operation health use this distinction: a typed refusal is recorded and recoverable,
 * anything else is an unexplained defect. The test is structural, so new codes never need registration here.
 */
const TYPED_CODE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/u;
const TYPED_NAMESPACE = /^SORTIE_[A-Z0-9]+(?:_[A-Z0-9]+)*(?::|$)/u;
const CODE_LIMIT = 120;

/** Whether a thrown message is one of this runtime's typed, caller-correctable refusals. */
export function isTypedRefusalMessage(message: unknown): boolean {
  if (typeof message !== "string") return false;
  const first = (message.trim().split("\n")[0] ?? "").trim();
  if (first.length === 0 || first.length > CODE_LIMIT) return TYPED_NAMESPACE.test(first);
  return TYPED_NAMESPACE.test(first) || TYPED_CODE.test(first);
}

/** The bounded identity of a typed refusal, used for counting repeated refusals. */
export function typedRefusalCode(message: unknown): string | null {
  if (!isTypedRefusalMessage(message)) return null;
  const first = (String(message).trim().split("\n")[0] ?? "").trim();
  const namespaced = TYPED_NAMESPACE.exec(first);
  return namespaced === null ? first : first.slice(0, namespaced[0].length).replace(/:$/u, "");
}
