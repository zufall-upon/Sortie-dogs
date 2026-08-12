/**
 * OpenCode builds a subagent's `task` result from the last text part of the child session's final
 * assistant message. A reasoning model that closes its turn with an extra reasoning step can emit a
 * trailing zero-length text part after the real answer, and that empty part becomes the whole
 * result. The coordinator then sees an empty handoff and re-dispatches work the worker already did.
 *
 * This repair is a read-only reconstruction of what the child actually said. It never invents text,
 * never touches a non-empty result, and leaves the output untouched whenever the child session
 * cannot be inspected.
 */

export const TASK_TOOL = "task";

const TASK_RESULT_PATTERN = /(<task_result>)([\s\S]*?)(<\/task_result>)/u;

export interface TaskToolExecuteInput {
  readonly tool: string;
  readonly sessionID?: string;
  readonly callID?: string;
}

export interface TaskToolExecuteOutput {
  output?: unknown;
  metadata?: unknown;
  [key: string]: unknown;
}

export interface SessionMessagePart {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly synthetic?: unknown;
}

export interface SessionMessage {
  readonly info?: { readonly role?: unknown; readonly agent?: unknown } | undefined;
  readonly role?: unknown;
  readonly agent?: unknown;
  readonly parts?: readonly SessionMessagePart[] | undefined;
}

/** The subset of the OpenCode SDK client this repair depends on. */
export interface SessionMessageReader {
  readonly session?: {
    readonly messages?: (
      request: { path: { id: string } },
    ) => Promise<{ data?: unknown } | unknown>;
  };
}

export type TaskResultRepairHook = (
  input: TaskToolExecuteInput,
  output: TaskToolExecuteOutput,
) => Promise<TaskResultRepairOutcome>;

export type TaskResultRepairOutcome =
  | { readonly kind: "unchanged" }
  | { readonly kind: "recovered"; readonly childSessionID: string }
  | { readonly kind: "unrecoverable-empty"; readonly childSessionID: string };

export const CONSULTATION_FALLBACK_RETRY_MARKER = "SORTIE_CONSULTATION_FALLBACK_RETRY";

function messageRole(message: SessionMessage): unknown {
  return message.info?.role ?? message.role;
}

/** Assistant text the child actually produced, ignoring the empty tail that caused the defect. */
export function lastAssistantText(messages: readonly SessionMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (messageRole(message) !== "assistant") continue;
    const parts = message.parts ?? [];
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex]!;
      if (part.type !== "text" || part.synthetic === true) continue;
      if (typeof part.text !== "string") continue;
      const text = part.text.trim();
      if (text.length > 0) return text;
    }
    // Only the final assistant turn answers the dispatch; earlier turns are not a substitute.
    return undefined;
  }
  return undefined;
}

export function taskChildSessionID(output: TaskToolExecuteOutput): string | undefined {
  const metadata = output.metadata;
  if (metadata === null || typeof metadata !== "object") return undefined;
  const id = (metadata as { sessionId?: unknown }).sessionId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function emptyResultMatch(output: TaskToolExecuteOutput): RegExpMatchArray | undefined {
  if (typeof output.output !== "string") return undefined;
  const match = TASK_RESULT_PATTERN.exec(output.output);
  if (match === null) return undefined;
  return match[2]!.trim().length === 0 ? match : undefined;
}

function toMessages(response: unknown): readonly SessionMessage[] | undefined {
  const payload = response !== null && typeof response === "object" && "data" in response
    ? (response as { data?: unknown }).data
    : response;
  return Array.isArray(payload) ? payload as readonly SessionMessage[] : undefined;
}

/**
 * Repair only the exact defect: a completed `task` call whose result body is empty while the child
 * session holds real assistant text. Everything else is left byte-identical.
 */
export function createTaskResultRepairHook(client: SessionMessageReader | undefined): TaskResultRepairHook {
  return async (input, output): Promise<TaskResultRepairOutcome> => {
    const unchanged = { kind: "unchanged" } as const;
    if (input.tool !== TASK_TOOL) return unchanged;
    const read = client?.session?.messages;
    if (read === undefined) return unchanged;
    const match = emptyResultMatch(output);
    if (match === undefined) return unchanged;
    const sessionID = taskChildSessionID(output);
    if (sessionID === undefined) return unchanged;

    let recovered: string | undefined;
    try {
      recovered = lastAssistantText(toMessages(await read.call(client!.session, { path: { id: sessionID } })) ?? []);
    } catch {
      // An unreadable child session is not a reason to damage an otherwise valid tool result.
      return unchanged;
    }
    if (recovered === undefined) return { kind: "unrecoverable-empty", childSessionID: sessionID };
    output.output = (output.output as string).replace(
      TASK_RESULT_PATTERN,
      () => `${match[1]!}\n${recovered}\n${match[3]!}`,
    );
    return { kind: "recovered", childSessionID: sessionID };
  };
}

/** Replace only a still-empty task result with one bounded protocol marker for a proven role. */
export function markConsultationFallbackRetry(
  output: TaskToolExecuteOutput,
  role: "dog-reviewer" | "dog-advisor",
): boolean {
  const match = emptyResultMatch(output);
  if (match === undefined) return false;
  output.output = (output.output as string).replace(
    TASK_RESULT_PATTERN,
    () => `${match[1]!}\n<!-- ${CONSULTATION_FALLBACK_RETRY_MARKER} role=${role} -->\n${match[3]!}`,
  );
  return true;
}
