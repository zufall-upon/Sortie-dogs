import type { GoalTerminalReceipt } from "../core/goal-bound.js";
import { terminalRunOutcome } from "./run-metrics.js";

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
