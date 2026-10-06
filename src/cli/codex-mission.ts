import { CodexMissionSession } from "../codex/mission-session.js";

export const CODEX_MISSION_USAGE = `Usage: sortie-dogs codex mission --prompt <text>
  [--resume <root-thread-id>] [--project-root <path>] [--executable <codex>] [--model <model>] [--effort <effort>]

Runs the existing Mission Operator, Coordinator, Worker and Reviewer through Codex.
--model and --effort explicitly override all roles; otherwise packaged role defaults apply.
Uses existing ChatGPT authentication and a repository-local, network-disabled sandbox.`;

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
        if (event.method !== "item/completed") return;
        const item = event.params.item as Record<string, unknown> | undefined;
        if (item?.type === "dynamicToolCall") process.stderr.write(`${JSON.stringify({ thread_id: event.threadId,
          tool: item.tool, status: item.status, success: item.success })}\n`);
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
