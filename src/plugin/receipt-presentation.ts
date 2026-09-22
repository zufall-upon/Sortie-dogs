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
