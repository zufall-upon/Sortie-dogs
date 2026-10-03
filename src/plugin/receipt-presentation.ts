import type { GoalTerminalReceipt } from "../core/goal-bound.js";
import { terminalRunOutcome } from "./run-metrics.js";

/** Extract only the host card, excluding the terminal prose that follows it. */
export function returnReportPanel(rendered: string): string | undefined {
  const summary = rendered.indexOf("<summary><strong>🐾 SORTIE DOGS — 帰還報告");
  if (summary < 0) return undefined;
  const start = rendered.lastIndexOf("<details", summary);
  const end = rendered.indexOf("\n</details>", summary);
  return start < 0 || end < 0 ? undefined : rendered.slice(start, end + "\n</details>".length).trim();
}

type ModelObject = Record<string, unknown>;
const modelObject = (value: unknown): value is ModelObject => value !== null && typeof value === "object" && !Array.isArray(value);

/** Request-only projection: the full host card remains in persisted native tool history. */
export function completionReportModelMessages(messages: readonly unknown[]): unknown[] {
  const packet = (value: unknown): unknown => {
    if (!modelObject(value) || value.status !== "succeeded" || !modelObject(value.receipt) ||
        value.receipt.status !== "succeeded" || typeof value.return_report !== "string" ||
        returnReportPanel(value.return_report) === undefined) return value;
    const { return_report: _card, ...rest } = value;
    return { ...rest, return_report_retained: "Full host card saved in this tool result; reply with concise outcome and key checks, without regenerating it." };
  };
  const text = (value: unknown): unknown => {
    if (typeof value !== "string") return value;
    try {
      const original: unknown = JSON.parse(value), compact = packet(original);
      return compact === original ? value : JSON.stringify(compact);
    } catch { return value; }
  };
  return messages.map(message => {
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
