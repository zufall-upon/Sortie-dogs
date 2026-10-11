import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export interface PublicMissionContext {
  id: string;
  role: "user" | "assistant";
  text: string;
  tools: { call_id?: string; tool: string; status?: string; input?: unknown; output?: string; error?: string;
    exit?: number; time?: unknown }[];
}
export interface MissionContextSource {
  session_id: string;
  path: string;
  sha256: string;
  entries: number;
  observed_at: string;
  history_available: boolean;
}
export interface MissionContinuity {
  sources: MissionContextSource[];
  notes?: { text: string; session_id: string; recorded_at: string }[];
}

/** Public task data only. Keep exact text/results in a lazy snapshot, not private reasoning. */
export function publicMissionContext(messages: readonly Record<string, unknown>[]): PublicMissionContext[] {
  return messages.flatMap(message => {
    const info = record(message.info) ? message.info : message;
    if ((info.role !== "user" && info.role !== "assistant") || typeof info.id !== "string" || !Array.isArray(message.parts)) return [];
    const parts = message.parts.filter(record);
    const text = parts.filter(part => part.type === "text" && part.synthetic !== true && typeof part.text === "string")
      .map(part => part.text as string).join("\n");
    const tools = parts.flatMap(part => {
      if (part.type !== "tool" || typeof part.tool !== "string" || !record(part.state)) return [];
      const state = part.state, metadata = record(state.metadata) ? state.metadata : {};
      return [{ tool: part.tool, ...(typeof part.callID === "string" ? { call_id: part.callID } : {}),
        ...(typeof state.status === "string" ? { status: state.status } : {}),
        ...(state.input !== undefined ? { input: state.input } : {}),
        ...(typeof state.output === "string" ? { output: state.output } : {}),
        ...(typeof state.error === "string" ? { error: state.error } : {}),
        ...(typeof metadata.exit === "number" ? { exit: metadata.exit } : {}),
        ...(part.time !== undefined ? { time: part.time } : {}) }];
    });
    return text.trim() || tools.length ? [{ id: info.id, role: info.role as "user" | "assistant", text, tools }] : [];
  });
}

/** Preserve earlier available entries when the host later returns a compacted/partial history. */
export async function retainMissionContext(directory: string, sessionID: string, messages: readonly Record<string, unknown>[],
  previous?: MissionContextSource): Promise<{ source: MissionContextSource; entries: PublicMissionContext[] }> {
  const current = publicMissionContext(messages);
  const retained: PublicMissionContext[] | undefined = previous ? await readFile(previous.path, "utf8")
    .then(content => JSON.parse(content).entries).catch(() => undefined) : undefined;
  const merged = new Map((retained ?? []).map(entry => [entry.id, entry]));
  for (const entry of current) merged.set(entry.id, entry);
  const entries = [...merged.values()];
  const content = JSON.stringify({ session_id: sessionID, entries }, null, 2) + "\n";
  const sha256 = createHash("sha256").update(content).digest("hex");
  const path = join(directory, `context-${sha256}.json`);
  if (!retained || previous?.sha256 !== sha256) {
    await mkdir(directory, { recursive: true });
    await writeFile(path, content);
  }
  return { source: { session_id: sessionID, path, sha256, entries: entries.length,
    observed_at: new Date().toISOString(), history_available: current.length > 0 }, entries };
}

/** Small inline view, with explicit pointers to every omitted byte in the exact snapshot. */
export function missionContextView(source: MissionContextSource, entries: readonly PublicMissionContext[], suppliedRequestIDs: readonly string[] = []) {
  const textEntries = entries.filter(entry => entry.text.trim() && !suppliedRequestIDs.includes(entry.id));
  const selected = textEntries.slice(-8);
  const tools = entries.flatMap(entry => entry.tools.map(tool => ({ message_id: entry.id, ...tool })));
  const recentTools = tools.filter(tool => !tool.tool.startsWith("sortie_") && ["completed", "error"].includes(tool.status ?? "")).slice(-8);
  return { ...source, omitted_text_entries: textEntries.length - selected.length,
    conversation: selected.map(entry => ({ id: entry.id, role: entry.role, text: entry.text.slice(0, 4000),
      ...(entry.text.length > 4000 ? { truncated: true, original_characters: entry.text.length } : {}) })),
    omitted_tool_entries: tools.length - recentTools.length,
    recent_tools: recentTools
      .map(tool => {
        const input = tool.input === undefined ? undefined : JSON.stringify(tool.input);
        return { ...tool, input: input?.slice(0, 1000), output: tool.output?.slice(0, 1000), error: tool.error?.slice(0, 1000),
          truncated: [input, tool.output, tool.error].some(value => value !== undefined && value.length > 1000),
          detail_ref: { path: source.path, message_id: tool.message_id, call_id: tool.call_id } };
      }),
  };
}
