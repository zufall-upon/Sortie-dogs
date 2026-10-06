import type { CodexTurnEvent } from "../codex/app-server.js";
import { CodexMissionSession } from "../codex/mission-session.js";

export const CODEX_MISSION_USAGE = `Usage: sortie-dogs codex mission --prompt <text>
  [--resume <root-thread-id>] [--project-root <path>] [--executable <codex>] [--model <model>] [--effort <effort>]

Runs the existing Mission Operator, Coordinator, Worker and Reviewer through Codex.
--model and --effort explicitly override all roles; otherwise packaged role defaults apply.
Uses existing ChatGPT authentication and native Codex permissions.`;

export async function runCodexMissionCommand(argv: readonly string[]): Promise<number> {
  if (argv.length === 1 && argv[0] === "--help") { process.stdout.write(`${CODEX_MISSION_USAGE}\n`); return 0; }
  const values = new Map<string, string>();
  const allowed = new Set(["--prompt", "--resume", "--project-root", "--executable", "--model", "--effort"]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!key || !allowed.has(key) || !value || value.startsWith("--") || values.has(key)) {
      process.stderr.write(`${CODEX_MISSION_USAGE}\n`); return 2;
    }
    values.set(key, value);
  }
  const prompt = values.get("--prompt");
  if (!prompt) { process.stderr.write(`${CODEX_MISSION_USAGE}\n`); return 2; }
  let adapter: CodexMissionSession | undefined;
  let signalExit: number | undefined;
  const stop = (exit: number) => { signalExit ??= exit; void adapter?.close().catch(() => undefined); };
  const onTerm = () => stop(143), onInt = () => stop(130);
  process.on("SIGTERM", onTerm); process.on("SIGINT", onInt);
  try {
    adapter = await CodexMissionSession.create({ projectRoot: values.get("--project-root") ?? process.cwd(),
      resumeThreadID: values.get("--resume"), executable: values.get("--executable"), model: values.get("--model"), effort: values.get("--effort"), onEvent: event => {
        const progress = codexMissionProgress(event);
        if (progress) process.stderr.write(`${JSON.stringify(progress)}\n`);
      } });
    if (signalExit) return signalExit;
    const result = await adapter.run(prompt);
    process.stdout.write(`${JSON.stringify({ status: result.accepted ? "succeeded" : "incomplete", root_session_id: result.rootSessionID,
      thread_id: result.turn.threadID, turn_id: result.turn.turnID, native_status: result.turn.status,
      response: result.turn.finalResponse, sessions: result.sessions, cost: null })}\n`);
    return signalExit ?? (result.accepted ? 0 : 1);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "codex-mission-failed"}\n`);
    return signalExit ?? 1;
  } finally {
    try { await adapter?.close(); }
    finally { process.off("SIGTERM", onTerm); process.off("SIGINT", onInt); }
  }
}

/** Bounded user-facing progress; do not dump control packets or hidden reasoning. */
export function codexMissionProgress(event: CodexTurnEvent & { threadId: string }): Record<string, unknown> | undefined {
  if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"].includes(event.method))
    return { thread_id: event.threadId, turn_id: event.params.turnId, phase: "approval-required", method: event.method,
      reason: typeof event.params.reason === "string" ? event.params.reason.slice(0, 1600) : undefined,
      command: typeof event.params.command === "string" ? event.params.command.slice(0, 1600) : undefined,
      item_id: event.params.itemId, host_approval_available: event.params.hostApprovalAvailable === true,
      next_action: event.params.hostApprovalAvailable === true ? "Await the host approval decision." :
        "No host approval callback is connected; this request receives no grant. Use a host-integrated SDK client for approval." };
  if (!["item/started", "item/completed"].includes(event.method)) return;
  const item = event.params.item as Record<string, unknown> | undefined;
  if (event.method === "item/completed" && item?.type === "agentMessage" && item.phase === "commentary" && typeof item.text === "string")
    return { thread_id: event.threadId, turn_id: event.params.turnId, phase: "commentary", text: item.text.slice(0, 1600) };
  if (item?.type !== "dynamicToolCall") return;
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  const bounded = (value: unknown) => typeof value === "string" ? value.slice(0, 1600) : undefined;
  const args = record(item.arguments) ? item.arguments : {};
  let receipt: Record<string, unknown> = {};
  const contents = Array.isArray(item.contentItems) ? item.contentItems : [];
  const text = contents.find(part => record(part) && part.type === "inputText")?.text;
  try { const parsed: unknown = JSON.parse(String(text)); if (record(parsed)) receipt = parsed; } catch { /* Plain native failure. */ }
  if (typeof receipt.output === "string") {
    try { const nested: unknown = JSON.parse(receipt.output); if (record(nested)) receipt = { ...nested, ...receipt }; } catch { /* Ordinary command output. */ }
  }
  const metadata = record(receipt.metadata) ? receipt.metadata : {};
  return { thread_id: event.threadId, turn_id: event.params.turnId, tool: item.tool,
    phase: event.method === "item/started" ? "started" : "completed", status: item.status, success: item.success,
    command: bounded(args.command), reason: bounded(args.reason),
    agent: bounded(args.subagent_type), description: bounded(args.description), child_session_id: bounded(metadata.sessionId),
    outcome: bounded(receipt.status), exit: metadata.exit,
    next_action: bounded(receipt.next_action),
    summary: bounded(args.summary ?? receipt.summary),
    detail: bounded(receipt.reason ?? receipt.error ?? (item.success === false ? text : undefined)) };
}
