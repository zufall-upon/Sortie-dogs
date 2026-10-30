/** Product display locale, independent of the language used to instruct the model.
 * Resolve on each delivery, not at plugin creation. Omitted settings preserve the
 * existing Japanese UI; unsupported explicit locales fall back to English.
 */
export type ReportLocale = "ja" | "en";
export function resolveReportLocale(value = process.env.SORTIE_REPORT_LOCALE): ReportLocale {
  if (value === undefined || value.trim() === "") return "ja";
  return /^ja(?:[-_]|$)/iu.test(value.trim()) ? "ja" : "en";
}
export const reportText = (locale: ReportLocale) => (ja: string, en: string): string => locale === "ja" ? ja : en;
