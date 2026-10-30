import type { GoalTerminalReceipt } from "../core/goal-bound.js";
import { terminalRunOutcome } from "./run-metrics.js";

/** Extract only the host card, excluding the terminal prose that follows it. */
export function returnReportPanel(rendered: string): string | undefined {
  const summary = /<summary><strong>🐾 SORTIE DOGS — (?:帰還報告|Return Report)(?=｜|<\/strong>)/u.exec(rendered)?.index;
  if (summary === undefined) return undefined;
  const start = rendered.lastIndexOf("<details", summary);
  const end = rendered.indexOf("\n</details>", summary);
  return start < 0 || end < 0 ? undefined : rendered.slice(start, end + "\n</details>".length).trim();
}

type ModelObject = Record<string, unknown>;
const modelObject = (value: unknown): value is ModelObject => value !== null && typeof value === "object" && !Array.isArray(value);

/** Compaction-only projection: normal final delivery still needs the original host card. */
export function completionReportModelMessages(messages: readonly unknown[]): unknown[] {
  // A summary may run between completion and the final reply. Never discard the
  // current turn's card there: it is still the only supported V2 delivery path.
  let lastUser = -1;
  messages.forEach((message, index) => { if (modelObject(message) && message.role === "user") lastUser = index; });
  const packet = (value: unknown): unknown => {
    if (!modelObject(value) || value.status !== "succeeded" || !modelObject(value.receipt) ||
        value.receipt.status !== "succeeded" || typeof value.return_report !== "string" ||
        returnReportPanel(value.return_report) === undefined) return value;
    const { return_report: _card, ...rest } = value;
    return { ...rest,
      return_report_instruction: "Historical host card retained in native tool history. Do not regenerate or repeat it from this summary; presentation is not unfinished Mission work.",
      return_report_retained: "Full host card saved in this tool result; not reproduced in the compaction summary." };
  };
  const text = (value: unknown): unknown => {
    if (typeof value !== "string") return value;
    try {
      const original: unknown = JSON.parse(value), compact = packet(original);
      return compact === original ? value : JSON.stringify(compact);
    } catch { return value; }
  };
  return messages.map((message, index) => {
    if (index > lastUser) return message;
    if (!modelObject(message) || message.role !== "tool" || !Array.isArray(message.content)) return message;
    let changed = false;
    const content = message.content.map(part => {
      if (!modelObject(part) || part.type !== "tool-result" || part.name !== "sortie_v010_complete_mission" ||
          !modelObject(part.result)) return part;
      const result = part.result;
      const value = result.type === "json" ? packet(result.value) : result.type === "text" ? text(result.value)
        : result.type === "content" && Array.isArray(result.value) ? result.value.map(item => {
          if (!modelObject(item) || item.type !== "text") return item;
          const compact = text(item.text);
          return compact === item.text ? item : { ...item, text: compact };
        }) : result.value;
      if (value === result.value || (Array.isArray(value) && Array.isArray(result.value) &&
          value.every((item, index) => item === (result.value as unknown[])[index]))) return part;
      changed = true;
      return { ...part, result: { ...result, value } };
    });
    // Preserve the host Message prototype, IDs, metadata and unrelated content without mutating history.
    return changed ? Object.assign(Object.create(Object.getPrototypeOf(message)), message, { content }) : message;
  });
}

/** Cosmetic headings only; no acceptance or execution state is inferred. */
export function decoratePreviewHeadings(text: string): string {
  const icons: Record<string, string> = { "変更点": "🔧", "確認結果": "🔍", "次": "➡️", changes: "🔧", validation: "🔍", next: "➡️" };
  // Only the first heading: never touch code blocks, quoted artifacts or internal keys.
  return text.replace(/^((?:[ \t]*\r?\n)*[ ]{0,3}#{1,6}[ \t]+)(変更点|確認結果|次|Changes|Validation|Next)([ \t]*)(?=\r?\n|$)/u,
    (_match, prefix: string, title: string, trailing: string) => `${prefix}${icons[title.toLowerCase()] ?? icons[title]} ${title}${trailing}`);
}

/** Only a host-verified current receipt may supply a missing success heading. */
export function receiptBoundTerminalText(text: string, receipt: GoalTerminalReceipt | undefined): string {
  if (receipt?.status !== "succeeded" || terminalRunOutcome(text) !== undefined) return text;
  return `✅ **DONE**\n\n${text}`;
}
