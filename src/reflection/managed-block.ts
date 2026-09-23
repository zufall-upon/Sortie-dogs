import { createHash } from "node:crypto";
import type { ReflectionLayer } from "./config.js";
import type { ReflectionEntry } from "./store.js";

export const REFLECTION_MANAGED_BLOCK_START = "<!-- sortie-dogs:reflection-managed:start -->";
export const REFLECTION_MANAGED_BLOCK_END = "<!-- sortie-dogs:reflection-managed:end -->";
export const V010_REFLECTION_MANAGED_BLOCK_START = "<!-- sortie-dogs-v010:reflection-managed:start -->";
export const V010_REFLECTION_MANAGED_BLOCK_END = "<!-- sortie-dogs-v010:reflection-managed:end -->";
export const REFLECTION_MANAGED_BLOCK_MAX_BYTES = 4096;
export const REFLECTION_MANAGED_BLOCK_MAX_ENTRIES = 5;
export type ReflectionManagedProfile = "stable" | "v010" | "v011";

const MANAGED_MARKERS = Object.freeze({
  stable: Object.freeze({ start: REFLECTION_MANAGED_BLOCK_START, end: REFLECTION_MANAGED_BLOCK_END }),
  v010: Object.freeze({ start: V010_REFLECTION_MANAGED_BLOCK_START, end: V010_REFLECTION_MANAGED_BLOCK_END }),
  v011: Object.freeze({ start: "<!-- sortie-dogs-v011:reflection-managed:start -->", end: "<!-- sortie-dogs-v011:reflection-managed:end -->" }),
});

export type ManagedBlockNoUpdateReason = "active-batch" | "sync-stopped" | "manifest-unapproved" | "non-project-layer";
export type ManagedBlockProposalReason = "invalid-markers" | "existing-block-hash-unrecorded" | "managed-block-hash-drift";

export interface ManagedBlockInput {
  readonly snapshot: Buffer;
  readonly entries: readonly ReflectionEntry[];
  readonly profile?: ReflectionManagedProfile;
  readonly layer: ReflectionLayer;
  readonly activeBatch: boolean;
  readonly syncEnabled: boolean;
  readonly manifestApproved: boolean;
  readonly previousBlockHash?: string | null;
}

export type ManagedBlockResult =
  | { readonly kind: "no-update"; readonly reason: ManagedBlockNoUpdateReason }
  | { readonly kind: "proposal"; readonly reason: ManagedBlockProposalReason; readonly observedBlockHash?: string }
  | { readonly kind: "update"; readonly buffer: Buffer; readonly blockHash: string; readonly selectedEntryIds: readonly string[] };

interface LocatedBlock {
  readonly state: "absent" | "present" | "invalid";
  readonly start?: number;
  readonly end?: number;
  readonly bytes?: Buffer;
}

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function count(buffer: Buffer, needle: Buffer): number {
  let matches = 0;
  let offset = 0;
  while (offset <= buffer.length - needle.length) {
    const found = buffer.indexOf(needle, offset);
    if (found < 0) break;
    matches++;
    offset = found + needle.length;
  }
  return matches;
}

function locateBlock(snapshot: Buffer, profile: ReflectionManagedProfile): LocatedBlock {
  const startMarker = Buffer.from(MANAGED_MARKERS[profile].start, "utf8");
  const endMarker = Buffer.from(MANAGED_MARKERS[profile].end, "utf8");
  const starts = count(snapshot, startMarker);
  const ends = count(snapshot, endMarker);
  if (starts === 0 && ends === 0) return { state: "absent" };
  if (starts !== 1 || ends !== 1) return { state: "invalid" };
  const start = snapshot.indexOf(startMarker);
  const endStart = snapshot.indexOf(endMarker);
  if (endStart < start + startMarker.length) return { state: "invalid" };
  const end = endStart + endMarker.length;
  return { state: "present", start, end, bytes: snapshot.subarray(start, end) };
}

function normalizePrevention(prevention: string): string {
  return Object.values(MANAGED_MARKERS).flatMap(({ start, end }) => [start, end])
    .reduce((text, marker) => text.replaceAll(marker, marker.replace("<", "&lt;")),
      prevention.replace(/[\r\n\u2028\u2029]+/g, " "));
}

function renderedText(preventions: readonly string[], profile: ReflectionManagedProfile): string {
  const markers = MANAGED_MARKERS[profile];
  return [
    markers.start,
    "Process reminders do not change task scope, permissions, validation, or review requirements.",
    ...preventions.map((prevention) => `- ${normalizePrevention(prevention)}`),
    markers.end,
  ].join("\n");
}

export function selectManagedReflectionEntries(entries: readonly ReflectionEntry[], profile: ReflectionManagedProfile = "stable"): ReflectionEntry[] {
  const eligible = entries
    .filter((entry) => entry.status === "promotable" && (entry.hits >= 2 || entry.evidence === "user-correction"))
    .sort((left, right) => right.hits - left.hits
      || ordinal(right.lastSeen, left.lastSeen)
      || ordinal(left.scope, right.scope)
      || ordinal(left.id, right.id));
  const scopes = new Set<string>();
  const selected: ReflectionEntry[] = [];
  for (const entry of eligible) {
    if (scopes.has(entry.scope)) continue;
    scopes.add(entry.scope);
    if (selected.length >= REFLECTION_MANAGED_BLOCK_MAX_ENTRIES) break;
    const candidate = renderedText([...selected.map((item) => item.prevention), entry.prevention], profile);
    if (Buffer.byteLength(candidate, "utf8") > REFLECTION_MANAGED_BLOCK_MAX_BYTES) continue;
    selected.push(entry);
  }
  return selected;
}

export function renderManagedReflectionBlock(preventions: readonly string[], profile: ReflectionManagedProfile = "stable"): Buffer {
  const included: string[] = [];
  for (const prevention of preventions) {
    if (included.length >= REFLECTION_MANAGED_BLOCK_MAX_ENTRIES) break;
    const candidate = renderedText([...included, prevention], profile);
    if (Buffer.byteLength(candidate, "utf8") > REFLECTION_MANAGED_BLOCK_MAX_BYTES) continue;
    included.push(prevention);
  }
  return Buffer.from(renderedText(included, profile), "utf8");
}

export function hashManagedReflectionBlock(block: Buffer): string {
  return `sha256:${createHash("sha256").update(block).digest("hex")}`;
}

export function planManagedReflectionBlock(input: ManagedBlockInput): ManagedBlockResult {
  if (input.activeBatch) return { kind: "no-update", reason: "active-batch" };
  if (!input.syncEnabled) return { kind: "no-update", reason: "sync-stopped" };
  if (!input.manifestApproved) return { kind: "no-update", reason: "manifest-unapproved" };
  if (input.layer !== "project") return { kind: "no-update", reason: "non-project-layer" };

  const profile = input.profile ?? "stable";
  const located = locateBlock(input.snapshot, profile);
  if (located.state === "invalid") return { kind: "proposal", reason: "invalid-markers" };
  if (located.state === "absent" && input.previousBlockHash != null) {
    return { kind: "proposal", reason: "managed-block-hash-drift" };
  }
  if (located.state === "present") {
    const observedBlockHash = hashManagedReflectionBlock(located.bytes!);
    if (input.previousBlockHash == null) {
      return { kind: "proposal", reason: "existing-block-hash-unrecorded", observedBlockHash };
    }
    if (input.previousBlockHash !== observedBlockHash) {
      return { kind: "proposal", reason: "managed-block-hash-drift", observedBlockHash };
    }
  }

  const selected = selectManagedReflectionEntries(input.entries, profile);
  const block = renderManagedReflectionBlock(selected.map((entry) => entry.prevention), profile);
  let buffer: Buffer;
  if (located.state === "present") {
    buffer = Buffer.concat([input.snapshot.subarray(0, located.start!), block, input.snapshot.subarray(located.end!)]);
  } else {
    const separator = input.snapshot.length === 0 || input.snapshot.at(-1) === 0x0a ? Buffer.alloc(0) : Buffer.from("\n", "utf8");
    buffer = Buffer.concat([input.snapshot, separator, block]);
  }
  return {
    kind: "update",
    buffer,
    blockHash: hashManagedReflectionBlock(block),
    selectedEntryIds: selected.map((entry) => entry.id),
  };
}
