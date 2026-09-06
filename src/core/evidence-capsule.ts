import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const EVIDENCE_CAPSULE_SCHEMA_VERSION = "0.1" as const;
export const MAX_EVIDENCE_CAPSULE_BYTES = 32 * 1024;
export const MAX_EVIDENCE_CAPSULE_ITEMS = 64;
export const DEFAULT_MAX_EVIDENCE_CAPSULES = 256;

const MAX_SHORT = 256;
const MAX_TEXT = 1000;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export interface EvidenceSourceReference {
  readonly path: string;
  readonly blob_hash: string;
  readonly symbol?: string;
  readonly region?: { readonly start_line: number; readonly end_line: number };
}

export interface EvidenceAcceptanceLink {
  readonly acceptance_id: string;
}

export interface EvidenceRisk {
  readonly kind: "correctness" | "security" | "concurrency" | "compatibility" | "performance" | "operational";
  readonly severity: "low" | "medium" | "high" | "critical";
  readonly summary: string;
}

export interface EvidenceValidationReference {
  readonly command: string;
  readonly fingerprint: string;
}

export interface EvidenceCapsuleProvenance {
  readonly producer: string;
  readonly revision: string;
  readonly scope_fingerprint: string;
}

export interface EvidenceCapsule {
  readonly schema_version: "0.1";
  readonly extractor_version: string;
  readonly sources: readonly EvidenceSourceReference[];
  readonly acceptance_links: readonly EvidenceAcceptanceLink[];
  readonly risks: readonly EvidenceRisk[];
  readonly validations: readonly EvidenceValidationReference[];
  readonly provenance: EvidenceCapsuleProvenance;
}

export type EvidenceCapsuleErrorCode =
  | "invalid"
  | "oversize"
  | "capacity"
  | "undeclared"
  | "source_scope"
  | "stale"
  | "busy"
  | "missing"
  | "corrupt";

export class EvidenceCapsuleError extends Error {
  readonly code: EvidenceCapsuleErrorCode;

  constructor(code: EvidenceCapsuleErrorCode, message: string) {
    super(message);
    this.name = "EvidenceCapsuleError";
    this.code = code;
  }
}

export interface EvidenceCapsulePutResult {
  readonly capsule_id: string;
  readonly capsule: EvidenceCapsule;
  readonly status: "created" | "reused";
  readonly reuse: { readonly payload: boolean; readonly source_content: false };
}

export interface EvidenceCapsuleLookupRequest {
  readonly capsule_id: string;
  readonly declared_capsule_ids: readonly string[];
  readonly authorized_source_paths: readonly string[];
}

export interface EvidenceCapsuleLookupResult {
  readonly capsule_id: string;
  readonly capsule: EvidenceCapsule;
  readonly reuse: { readonly payload: true; readonly source_content: false };
}

export interface EvidenceCapsuleFreshness {
  readonly status: "fresh" | "stale";
  readonly changed_relevant_paths: readonly string[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown, max = MAX_TEXT): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const hasOnly = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));
const isList = (value: unknown, allowEmpty = false): value is unknown[] =>
  Array.isArray(value) && (allowEmpty || value.length > 0) && value.length <= MAX_EVIDENCE_CAPSULE_ITEMS;

function normalizeSourcePath(input: string): string {
  const unified = input.replaceAll("\\", "/");
  if (unified.startsWith("/") || /^[A-Za-z]:/u.test(unified) || unified.split("/").includes("..")) {
    throw new EvidenceCapsuleError("source_scope", "Source paths must be repository-relative without traversal.");
  }
  const normalized = unified.split("/").filter((segment) => segment !== "" && segment !== ".").join("/");
  if (normalized === "") throw new EvidenceCapsuleError("source_scope", "Source paths must not be empty.");
  return normalized;
}

function validSource(value: unknown): value is EvidenceSourceReference {
  if (!isObject(value) || !hasOnly(value, ["path", "blob_hash", "symbol", "region"]) ||
    !isText(value.path, 512) || !HASH_PATTERN.test(String(value.blob_hash))) return false;
  try { if (normalizeSourcePath(value.path) !== value.path.replaceAll("\\", "/")) return false; } catch { return false; }
  if ("symbol" in value && !isText(value.symbol, MAX_SHORT)) return false;
  if ("region" in value) {
    if (!isObject(value.region) || !hasOnly(value.region, ["start_line", "end_line"])) return false;
    const { start_line: start, end_line: end } = value.region;
    if (!Number.isInteger(start) || !Number.isInteger(end) || Number(start) < 1 || Number(end) < Number(start)) return false;
  }
  return true;
}

function validCapsule(value: unknown): value is EvidenceCapsule {
  if (!isObject(value) || !hasOnly(value, ["schema_version", "extractor_version", "sources", "acceptance_links", "risks", "validations", "provenance"]) ||
    value.schema_version !== EVIDENCE_CAPSULE_SCHEMA_VERSION || !isText(value.extractor_version, MAX_SHORT) ||
    !isList(value.sources) || !value.sources.every(validSource) ||
    new Set(value.sources.map((source) => isObject(source) ? source.path : undefined)).size !== value.sources.length ||
    !isList(value.acceptance_links) || !value.acceptance_links.every((link) => isObject(link) && hasOnly(link, ["acceptance_id"]) && isText(link.acceptance_id, MAX_SHORT)) ||
    !isList(value.risks, true) || !value.risks.every((risk) => isObject(risk) && hasOnly(risk, ["kind", "severity", "summary"]) &&
      ["correctness", "security", "concurrency", "compatibility", "performance", "operational"].includes(String(risk.kind)) &&
      ["low", "medium", "high", "critical"].includes(String(risk.severity)) && isText(risk.summary)) ||
    !isList(value.validations) || !value.validations.every((validation) => isObject(validation) && hasOnly(validation, ["command", "fingerprint"]) &&
      isText(validation.command) && isText(validation.fingerprint, MAX_SHORT)) ||
    !isObject(value.provenance) || !hasOnly(value.provenance, ["producer", "revision", "scope_fingerprint"]) ||
    !isText(value.provenance.producer, MAX_SHORT) || !isText(value.provenance.revision, MAX_SHORT) ||
    !isText(value.provenance.scope_fingerprint, MAX_SHORT)) return false;
  return true;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  return value;
}

export function canonicalizeEvidenceCapsule(value: unknown): string {
  if (!validCapsule(value)) throw new EvidenceCapsuleError("invalid", "Evidence capsule does not match the closed schema.");
  const canonical = JSON.stringify(canonicalValue(value));
  if (Buffer.byteLength(canonical) > MAX_EVIDENCE_CAPSULE_BYTES) {
    throw new EvidenceCapsuleError("oversize", "Evidence capsule exceeds its byte bound.");
  }
  return canonical;
}

export function evidenceCapsuleHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalizeEvidenceCapsule(value)).digest("hex")}`;
}

function cloneCapsule(canonical: string): EvidenceCapsule {
  return JSON.parse(canonical) as EvidenceCapsule;
}

function normalizedScope(paths: readonly string[]): Set<string> {
  const normalized = paths.map((entry) => {
    try { return normalizeSourcePath(entry); } catch { throw new EvidenceCapsuleError("source_scope", "Authorized source scope contains an invalid path."); }
  });
  return new Set(normalized);
}

function enforceSourceScope(capsule: EvidenceCapsule, paths: readonly string[]): void {
  const scope = normalizedScope(paths);
  if (capsule.sources.some((source) => !scope.has(source.path))) {
    throw new EvidenceCapsuleError("source_scope", "Evidence capsule references a source outside the authorized read scope.");
  }
}

export function evaluateEvidenceCapsuleFreshness(
  capsule: EvidenceCapsule,
  currentSources: readonly { readonly path: string; readonly blob_hash: string }[],
  authorizedSourcePaths: readonly string[],
): EvidenceCapsuleFreshness {
  canonicalizeEvidenceCapsule(capsule);
  enforceSourceScope(capsule, authorizedSourcePaths);
  const current = new Map<string, string>();
  for (const source of currentSources) {
    let normalized: string;
    try { normalized = normalizeSourcePath(source.path); } catch { throw new EvidenceCapsuleError("invalid", "Freshness input contains an invalid source path."); }
    if (!HASH_PATTERN.test(source.blob_hash)) throw new EvidenceCapsuleError("invalid", "Freshness input contains an invalid blob hash.");
    if (current.has(normalized)) throw new EvidenceCapsuleError("invalid", "Freshness input contains duplicate source paths.");
    current.set(normalized, source.blob_hash);
  }
  const changed = capsule.sources.filter((source) => current.get(source.path) !== source.blob_hash).map((source) => source.path);
  return { status: changed.length === 0 ? "fresh" : "stale", changed_relevant_paths: changed };
}

export class EvidenceCapsuleStore {
  readonly #directory: string;
  readonly #maxCapsules: number;
  readonly #inFlight = new Map<string, Promise<EvidenceCapsulePutResult>>();
  #writeTail: Promise<void> = Promise.resolve();

  constructor(directory: string, options: { readonly maxCapsules?: number } = {}) {
    const maxCapsules = options.maxCapsules ?? DEFAULT_MAX_EVIDENCE_CAPSULES;
    if (!Number.isSafeInteger(maxCapsules) || maxCapsules < 1) throw new EvidenceCapsuleError("capacity", "Capsule capacity must be a positive safe integer.");
    this.#directory = directory;
    this.#maxCapsules = maxCapsules;
  }

  async put(capsule: EvidenceCapsule, authorizedSourcePaths: readonly string[]): Promise<EvidenceCapsulePutResult> {
    const canonical = canonicalizeEvidenceCapsule(capsule);
    const immutable = cloneCapsule(canonical);
    enforceSourceScope(immutable, authorizedSourcePaths);
    const capsuleId = evidenceCapsuleHash(immutable);
    const active = this.#inFlight.get(capsuleId);
    if (active) {
      const result = await active;
      return { ...result, capsule: cloneCapsule(canonical), status: "reused", reuse: { payload: true, source_content: false } };
    }
    const operation = this.#serializedWrite(async () => this.#publish(capsuleId, canonical));
    this.#inFlight.set(capsuleId, operation);
    try { return await operation; } finally { this.#inFlight.delete(capsuleId); }
  }

  async lookup(request: EvidenceCapsuleLookupRequest): Promise<EvidenceCapsuleLookupResult> {
    if (!request.declared_capsule_ids.includes(request.capsule_id)) {
      throw new EvidenceCapsuleError("undeclared", "Evidence capsule identity was not declared by the caller.");
    }
    const canonical = await this.#readCanonical(request.capsule_id);
    const capsule = cloneCapsule(canonical);
    enforceSourceScope(capsule, request.authorized_source_paths);
    return { capsule_id: request.capsule_id, capsule, reuse: { payload: true, source_content: false } };
  }

  /** Live reuse requires fresh source evidence; historical ledger lookup remains content-addressed. */
  async lookupFresh(request: EvidenceCapsuleLookupRequest,
    currentSources: readonly Pick<EvidenceSourceReference, "path" | "blob_hash">[]): Promise<EvidenceCapsuleLookupResult> {
    const result = await this.lookup(request);
    if (evaluateEvidenceCapsuleFreshness(result.capsule, currentSources, request.authorized_source_paths).status !== "fresh") {
      throw new EvidenceCapsuleError("stale", "Relevant source evidence changed or is missing.");
    }
    return result;
  }

  #serializedWrite(operation: () => Promise<EvidenceCapsulePutResult>): Promise<EvidenceCapsulePutResult> {
    const result = this.#writeTail.then(operation, operation);
    this.#writeTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #publish(capsuleId: string, canonical: string): Promise<EvidenceCapsulePutResult> {
    await mkdir(this.#directory, { recursive: true });
    const lockPath = path.join(this.#directory, ".publish.lock");
    let lock;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { lock = await open(lockPath, "wx"); break; }
      catch (error) {
        if (!isObject(error) || error.code !== "EEXIST") throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    if (lock === undefined) throw new EvidenceCapsuleError("busy", "Evidence capsule publication remains locked.");
    try {
      return await this.#publishLocked(capsuleId, canonical);
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }

  async #publishLocked(capsuleId: string, canonical: string): Promise<EvidenceCapsulePutResult> {
    const target = this.#capsulePath(capsuleId);
    try {
      const existing = await this.#readCanonical(capsuleId);
      return { capsule_id: capsuleId, capsule: cloneCapsule(existing), status: "reused", reuse: { payload: true, source_content: false } };
    } catch (error) {
      if (!(error instanceof EvidenceCapsuleError) || error.code !== "missing") throw error;
    }
    const entries = (await readdir(this.#directory)).filter((entry) => /^sha256-[a-f0-9]{64}\.json$/u.test(entry));
    if (entries.length >= this.#maxCapsules) throw new EvidenceCapsuleError("capacity", "Evidence capsule store reached its bounded capacity.");
    const temporary = path.join(this.#directory, `.${capsuleId.slice(7)}.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temporary, canonical, { encoding: "utf8", flag: "wx" });
    try {
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      try {
        const existing = await this.#readCanonical(capsuleId);
        return { capsule_id: capsuleId, capsule: cloneCapsule(existing), status: "reused", reuse: { payload: true, source_content: false } };
      } catch {
        throw error;
      }
    }
    return { capsule_id: capsuleId, capsule: cloneCapsule(canonical), status: "created", reuse: { payload: false, source_content: false } };
  }

  async #readCanonical(capsuleId: string): Promise<string> {
    if (!HASH_PATTERN.test(capsuleId)) throw new EvidenceCapsuleError("invalid", "Evidence capsule identity is invalid.");
    let raw: string;
    try {
      const capsulePath = this.#capsulePath(capsuleId);
      if ((await stat(capsulePath)).size > MAX_EVIDENCE_CAPSULE_BYTES) {
        throw new EvidenceCapsuleError("oversize", "Stored evidence capsule exceeds its byte bound.");
      }
      raw = await readFile(capsulePath, "utf8");
    }
    catch (error) {
      if (isObject(error) && error.code === "ENOENT") throw new EvidenceCapsuleError("missing", "Evidence capsule was not found.");
      throw error;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new EvidenceCapsuleError("corrupt", "Stored evidence capsule is not valid JSON."); }
    try {
      const canonical = canonicalizeEvidenceCapsule(parsed);
      if (evidenceCapsuleHash(parsed) !== capsuleId) throw new EvidenceCapsuleError("corrupt", "Stored evidence capsule hash does not match its identity.");
      return canonical;
    } catch (error) {
      if (error instanceof EvidenceCapsuleError && error.code === "corrupt") throw error;
      throw new EvidenceCapsuleError("corrupt", "Stored evidence capsule does not match the closed schema.");
    }
  }

  #capsulePath(capsuleId: string): string {
    return path.join(this.#directory, `${capsuleId.replace(":", "-")}.json`);
  }
}
