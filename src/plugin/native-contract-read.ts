import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { RUNTIME_PROFILES } from "../core/runtime-profile.js";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Native Read clips individual lines, even when its metadata says truncated=false.
 * Generated contracts are single-line JSON. Display their exact scalar values with
 * real line breaks, so the already-required read exposes the original requirements.
 * This is a read-result projection only: persisted JSON, identities and grants stay unchanged. */
export async function nativeContractReadView(directory: string, input: unknown): Promise<string | undefined> {
  if (!record(input) || typeof input.path !== "string") return undefined;
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
  const escape = (name: string) => name.replaceAll("~", "~0").replaceAll("/", "~1");
  const visit = (item: unknown, pointer: string): void => {
    if (record(item) && Object.keys(item).length) {
      for (const [name, child] of Object.entries(item)) visit(child, `${pointer}/${escape(name)}`);
    } else if (Array.isArray(item) && item.length) {
      item.forEach((child, index) => visit(child, `${pointer}/${index}`));
    } else {
      fields.push(`--- ${pointer || "/"} (${typeof item === "string" ? "string" : "JSON"}) ---\n` +
        (typeof item === "string" ? item : JSON.stringify(item)));
    }
  };
  visit(value, "");
  return `Read generated contract ${input.path}\n` +
    "SORTIE_EXACT_CONTRACT_VIEW: exact JSON values; strings use their original line breaks. " +
    "This is not a summary or a replacement contract. The source JSON and its registered identity are unchanged.\n\n" +
    fields.join("\n\n");
}
