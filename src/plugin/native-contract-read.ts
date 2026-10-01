import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { RUNTIME_PROFILES } from "../core/runtime-profile.js";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Native Read clips individual lines, even when its metadata says truncated=false.
 * Generated contracts are single-line JSON. Display their exact scalar values with
 * real line breaks, so the already-required read exposes the original requirements.
 * This is a read-result projection only: persisted JSON, identities and grants stay unchanged. */
export async function nativeContractReadView(directory: string, input: unknown): Promise<string | undefined> {
  return (await nativeContractReadSnapshot(directory, input))?.output;
}

export async function nativeContractReadSnapshot(directory: string, input: unknown): Promise<{ output: string; hash: string } | undefined> {
  if (!record(input) || typeof input.path !== "string") return undefined;
  // Preserve native partial-read semantics; only the full contract projection supplies
  // authoritative content for automatic activation.
  if (input.offset !== undefined || input.limit !== undefined) return undefined;
  const absolute = resolve(directory, input.path);
  const scoped = relative(directory, absolute).replaceAll("\\", "/");
  if (scoped === ".." || scoped.startsWith("../") || isAbsolute(scoped)) return undefined;
  const local = process.platform === "win32" ? scoped.toLowerCase() : scoped;
  const generated = Object.values(RUNTIME_PROFILES).some(profile => {
    const root = process.platform === "win32" ? profile.stateDirectory.toLowerCase() : profile.stateDirectory;
    const rest = local.startsWith(`${root}/`) ? local.slice(root.length + 1) : "";
    return /^contracts\/handoff\.[^/]+\.json$/u.test(rest) || /^missions\/[a-f0-9]{64}\.request\.json$/u.test(rest);
  });
  if (!generated) return undefined;
  const source = await readFile(absolute, "utf8").catch(() => undefined);
  if (source === undefined) return undefined;
  let value: unknown;
  try { value = JSON.parse(source); } catch { return undefined; }
  if (!record(value) || !(record(value.task) && typeof value.task.objective === "string" && record(value.ext)) &&
      !(typeof value.id === "string" && typeof value.text === "string")) return undefined;
  const fields: string[] = [];
  let referencedCriteria = false;
  const escape = (name: string) => name.replaceAll("~", "~0").replaceAll("/", "~1");
  // Only ledger criteria exactly equal to an already displayed requirement may use a
  // reference. Never deduplicate original requests, objectives or arbitrary strings.
  const requirementPointers = new Map<string, string>();
  const context = record(value.ext) ? value.ext["sortie-dogs/mission-context"] : undefined;
  if (record(context) && Array.isArray(context.requirements)) {
    context.requirements.forEach((requirement, index) => {
      if (record(requirement) && typeof requirement.text === "string" && !requirementPointers.has(requirement.text)) {
        requirementPointers.set(requirement.text, `/ext/sortie-dogs~1mission-context/requirements/${index}/text`);
      }
    });
  }
  const visit = (item: unknown, pointer: string): void => {
    if (record(item) && Object.keys(item).length) {
      for (const [name, child] of Object.entries(item)) visit(child, `${pointer}/${escape(name)}`);
    } else if (Array.isArray(item) && item.length) {
      item.forEach((child, index) => visit(child, `${pointer}/${index}`));
    } else {
      const duplicate = /^\/ext\/sortie-dogs~1acceptance-continuity\/criteria\/\d+$/u.test(pointer) &&
        typeof item === "string" ? requirementPointers.get(item) : undefined;
      const alias = duplicate ? `Same exact string as ${duplicate}` : undefined;
      // Object property order is not prescribed: reference only a value actually shown.
      // Short requirements cost less verbatim; allow for alias labels and the view notice.
      if (alias && typeof item === "string" && item.length > alias.length + 80 &&
          fields.some(field => field.startsWith(`--- ${duplicate} (string) ---\n`))) {
        referencedCriteria = true;
        fields.push(`--- ${pointer} (string, exact duplicate) ---\n${alias}`);
        return;
      }
      fields.push(`--- ${pointer || "/"} (${typeof item === "string" ? "string" : "JSON"}) ---\n` +
        (typeof item === "string" ? item : JSON.stringify(item)));
    }
  };
  visit(value, "");
  const output = `Read generated contract ${input.path}\n` +
    "SORTIE_EXACT_CONTRACT_VIEW: exact JSON values; strings use their original line breaks. " +
    (referencedCriteria ? "Duplicate criteria reference equal displayed requirement text. " : "") +
    "This is not a summary or a replacement contract. The source JSON and its registered identity are unchanged.\n\n" +
    fields.join("\n\n");
  return { output, hash: createHash("sha256").update(source).digest("hex") };
}
