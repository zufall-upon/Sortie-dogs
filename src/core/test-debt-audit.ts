import { createHash, randomUUID } from "node:crypto";
import type { Dir, Dirent } from "node:fs";
import { lstat, opendir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { OperatorUnit } from "./operator-runtime.js";
import { normalizeManifestScope } from "./path.js";
import { normalizeCommand } from "../plugin/gate.js";

/** A cheap signal, not a finding, deletion authority, or proof of an audit. */
export interface TestDebtSignal {
  path: string;
  sha256: string | null;
  lines: number | null;
  bytes: number;
  repeated_assertions: number[][];
  reasons: ("repeated-assertion" | "large-test-file")[];
}

export interface MissionTestDebtSignal extends TestDebtSignal {
  run_id: string;
  unit_id: string;
  trigger: "planning-milestone" | "observed-change";
}

export const TEST_DEBT_AUDIT_INSTRUCTION = `Test Debt Audit is scheduled by the host, not established as complete. Act only on signals for your own unit, not another Task. Before final validation, the existing author should inspect the indicated tests and relevant specification/regression history. Compare inputs, setup, boundaries, expected values, assertions and failure detection; similar lines or size alone do not establish redundancy. If a safe consolidation, shared setup or truly redundant check is supported by that comparison, make the actual change before the validation candidate is fixed and compare relevant detection before and after. Preserve distinct specifications, regressions, public APIs and security. Do not remove uncertain coverage. Respect existing write authority, pre-existing dirty files and other Tasks; do not modify unowned work. If no safe change is supported, retain the tests and explain the reason and a useful later re-evaluation trigger. Use the existing checks and Reviewer; no new Mission, agent, ledger, unconditional full test or repeated audit of the audit's own edits.`;

function inside(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
}

// Filenames identify files worth inspecting, never the value of the tests in them.
function testPath(path: string): boolean {
  const value = path.replaceAll("\\", "/");
  return /(?:^|\/)(?:tests?|specs?|__tests__)(?:\/|$)/iu.test(value) ||
    /(?:^|\/)(?:test[_-][^/]+|[^/]+[._-](?:test|spec))(?:\.[^/]+)?$/iu.test(value);
}

const MAX_TEST_FILES = 16, MAX_WALK_ENTRIES = 2048, MAX_WALK_DIRECTORIES = 128;
const ignoredTrees = new Set([".git", ".hg", ".svn", "node_modules", "dist", "coverage", "_testenv", ".cache", ".venv"]);
const unavailable = (error: unknown) => ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "");

type AuditUnit = Pick<OperatorUnit, "read" | "write" | "validation" | "validation_cwd">;
export interface TestDebtInventoryCursor {
  frames: { path: string; after: string | null }[];
  explicitAfter?: string;
}
export interface TestDebtInventoryPage { signals: TestDebtSignal[]; cursor: TestDebtInventoryCursor }

// A literal Godot --script URI is relative to its explicit project --path, not
// to the shell cwd. This discovers an audit candidate only; it does not classify
// the script as a full/focused suite or grant permission to edit it.
function godotScriptInput(command: string, cwd: string): { project: string; script: string } | undefined {
  const words = command.trim().split(/\s+/u);
  if (words.some(word => !/^[\w@%+=:,./\\-]+$/u.test(word))) return undefined;
  let index = words[0] === "env" ? 1 : 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=.+$/u.test(words[index] ?? "")) index++;
  const binary = words[index]?.split(/[\\/]/u).at(-1);
  if (!binary || !/^godot(?:[_.-][\w.-]+)?$/iu.test(binary)) return undefined;
  const separator = words.indexOf("--", index + 1);
  const options = words.slice(index + 1, separator < 0 ? undefined : separator);
  if (options.filter(word => word === "--path").length !== 1 || options.filter(word => word === "--script").length !== 1) return undefined;
  const project = options[options.indexOf("--path") + 1], uri = options[options.indexOf("--script") + 1];
  if (!project || project.startsWith("-") || !uri?.startsWith("res://")) return undefined;
  const script = uri.slice("res://".length);
  if (!/^[\w./-]+$/u.test(script) || script.split("/").some(part => !part || part === "." || part === "..")) return undefined;
  return { project: resolve(cwd, project), script };
}

function inventoryInputs(root: string, unit: AuditUnit, changed: readonly string[]) {
  const candidates: string[] = [];
  const directories: string[] = [];
  const add = (path: string, base = root) => {
    if (!path || /[*?{}\[\]]/u.test(path) || !testPath(path)) return;
    const absolute = resolve(base, path);
    if (inside(root, absolute) && !candidates.includes(absolute)) candidates.push(absolute);
  };
  // The host represents directory scopes with a trailing /** (or an existing directory),
  // not arbitrary shell globs. Reuse its normalization rather than inventing wider grants.
  const addDirectory = (path: string, base = root) => {
    try {
      const scope = normalizeManifestScope(path);
      if (/[*?{}\[\]]/u.test(scope.path)) return;
      const absolute = resolve(base, scope.path);
      const parts = relative(root, absolute).split(sep);
      if (!inside(root, absolute) || parts.some(part => part.startsWith(".") || ignoredTrees.has(part.toLowerCase()))) return;
      if (!directories.includes(absolute)) directories.push(absolute);
    } catch { /* Invalid declarations are not inventory paths. */ }
  };
  for (const path of changed) add(path);
  for (const path of [...unit.read, ...unit.write]) { add(path); addDirectory(path); }
  for (const command of unit.validation) {
    const cwd = unit.validation_cwd?.[normalizeCommand(command)] ?? root;
    const godot = godotScriptInput(command, cwd);
    if (godot) add(godot.script, godot.project);
    for (const word of command.match(/[^\s'"`|;&<>]+/gu) ?? []) {
      add(word, cwd);
      // Bare `test` is often a command or npm script name, not a directory argument.
      if (testPath(word) && word.replaceAll("\\", "/").endsWith("/**")) addDirectory(word, cwd);
    }
  }
  return { candidates, directories };
}

/** Directory traversal and explicit-file rotation share only the same ordered inputs. */
export function testDebtInventoryKey(root: string, unit: AuditUnit): string {
  root = resolve(root);
  const { candidates, directories } = inventoryInputs(root, unit, []);
  return createHash("sha256").update(JSON.stringify([root, directories, candidates])).digest("hex");
}

// Directory streams are an optimization, not durable state. After a host restart a stream
// is reconstructed in bounded chunks up to the saved name; the serialized cursor remains
// authoritative. The small LRU also bounds descriptors for abandoned Missions.
const streams = new Map<string, { dir: Dir; expected: string | null; seeking: boolean; recoveryLeft: number; suspended: boolean }>();
const MAX_OPEN_STREAMS = 64;
async function closeStream(key: string): Promise<void> {
  const entry = streams.get(key);
  if (!entry) return;
  streams.delete(key);
  await entry.dir.close().catch(() => undefined);
}
export async function closeTestDebtInventory(cacheKey: string): Promise<void> {
  for (const key of [...streams.keys()]) if (key.startsWith(`${cacheKey}\0`)) await closeStream(key);
}
async function inventoryStream(key: string, directory: string, after: string | null) {
  let stream = streams.get(key);
  if (stream && stream.expected !== after) { await closeStream(key); stream = undefined; }
  if (!stream) {
    while (streams.size >= MAX_OPEN_STREAMS) {
      // Prefer suspended ancestors, then streams not reconstructing a durable
      // checkpoint. Otherwise a busy cache can evict the same long resync on
      // every milestone before it has made any forward progress.
      const entries = [...streams.entries()];
      const victim = entries.find(([, value]) => value.suspended && !value.recoveryLeft) ??
        entries.find(([, value]) => !value.recoveryLeft) ?? entries.find(([, value]) => value.suspended) ?? entries[0]!;
      await closeStream(victim[0]);
    }
    stream = { dir: await opendir(directory), expected: after, seeking: after !== null,
      recoveryLeft: after === null ? 0 : MAX_WALK_ENTRIES, suspended: false };
  } else streams.delete(key);
  stream.suspended = false;
  streams.set(key, stream);
  return stream;
}

/** Inspect explicit inputs first, then one bounded page of declared directory scopes. */
export async function inspectTestDebtPage(root: string, unit: AuditUnit, changed: readonly string[] = [],
  options: { cursor?: TestDebtInventoryCursor; cacheKey?: string; maxFiles?: number; exclude?: ReadonlySet<string> } = {}): Promise<TestDebtInventoryPage> {
  root = resolve(root);
  const { candidates, directories } = inventoryInputs(root, unit, changed);
  const cursor: TestDebtInventoryCursor = options.cursor ? structuredClone(options.cursor) : { frames: [] };
  if (!cursor.frames.length) cursor.frames = directories.slice().reverse().map(path => ({ path: relative(root, path), after: null }));
  const cacheKey = options.cacheKey ?? `temporary-${randomUUID()}`;
  const scopeKey = testDebtInventoryKey(root, unit);
  const limit = Math.max(0, Math.min(MAX_TEST_FILES, options.maxFiles ?? MAX_TEST_FILES));
  const canonicalRoot = await realpath(root).catch(error => { if (unavailable(error)) return root; throw error; });
  // A scope with a linked ancestor must not enter that tree, even when its target is in-project.
  const noLinks = async (path: string): Promise<boolean> => {
    let current = root;
    try {
      for (const part of relative(root, path).split(sep).filter(Boolean)) {
        current = join(current, part);
        if ((await lstat(current)).isSymbolicLink()) return false;
      }
      return inside(canonicalRoot, await realpath(path));
    } catch (error) { if (unavailable(error)) return false; throw error; }
  };
  const result: TestDebtSignal[] = [];
  const inspected = new Set<string>();
  const inspect = async (path: string, discovered: boolean) => {
    inspected.add(path);
    try {
      const stat = await lstat(path);
      // Do not traverse links or special files as a side effect of an ordinary edit.
      if (!stat.isFile()) return;
      const canonical = await realpath(path);
      if (discovered ? !inside(canonicalRoot, canonical) || !await noLinks(path) : !inside(root, canonical)) return;
      if (stat.size > 512 * 1024) {
        // Size alone schedules investigation; it never licenses deletion or claims a full read.
        result.push({ path: relative(root, path).replaceAll("\\", "/"), sha256: null, lines: null,
          bytes: stat.size, repeated_assertions: [], reasons: ["large-test-file"] });
        return;
      }
      const content = await readFile(path, "utf8");
      const lines = content.split(/\r?\n/u), assertions = new Map<string, number[]>();
      for (const [index, raw] of lines.entries()) {
        const line = raw.trim();
        if (line.length > 512 || !/^(?:assert(?:\.|\s|\()|expect\(|(?:self|this)\.assert|Assert\.)/u.test(line)) continue;
        const positions = assertions.get(line) ?? [];
        positions.push(index + 1); assertions.set(line, positions);
      }
      const repeated = [...assertions.values()].filter(positions => positions.length > 1).slice(0, 8).map(positions => positions.slice(0, 8));
      const reasons: TestDebtSignal["reasons"] = [];
      if (repeated.length) reasons.push("repeated-assertion");
      if (lines.length >= 500) reasons.push("large-test-file");
      if (!reasons.length) return;
      result.push({ path: relative(root, path).replaceAll("\\", "/"), sha256: createHash("sha256").update(content).digest("hex"),
        lines: lines.length, bytes: stat.size, repeated_assertions: repeated, reasons });
    } catch (error) {
      // A missing/deleted/unreadable candidate is not a finding and never blocks the Mission.
      if (!unavailable(error)) throw error;
    }
  };
  const excluded = (path: string) => options.exclude?.has(relative(root, path).replaceAll("\\", "/")) === true;
  try {
    // When explicit files fill a whole page, reserve one slot for inventory and rotate
    // the explicit inputs. They still precede all automatic candidates in each page.
    const explicitLimit = directories.length && candidates.length >= limit && limit > 1 ? limit - 1 : limit;
    const after = cursor.explicitAfter ? candidates.indexOf(resolve(root, cursor.explicitAfter)) : -1;
    const start = candidates.length > explicitLimit && after >= 0 ? (after + 1) % candidates.length : 0;
    for (let index = 0; index < candidates.length && inspected.size < explicitLimit; index++) {
      const path = candidates[(start + index) % candidates.length]!;
      if (excluded(path)) continue;
      await inspect(path, false);
      cursor.explicitAfter = relative(root, path);
    }
    let entriesLeft = MAX_WALK_ENTRIES, directoriesLeft = MAX_WALK_DIRECTORIES;
    const visited = new Set<string>();
    while (cursor.frames.length && inspected.size < limit && entriesLeft > 0) {
      const frame = cursor.frames[cursor.frames.length - 1]!;
      const directory = resolve(root, frame.path);
      const streamKey = `${cacheKey}\0${scopeKey}\0${directory}`;
      try {
        if (!visited.has(directory)) {
          if (!directoriesLeft) break;
          directoriesLeft--; visited.add(directory);
          // Recheck persisted paths and every resumed directory against the current scope.
          if (!inside(root, directory) || !directories.some(scope => inside(scope, directory)) ||
              !await noLinks(directory) || !(await lstat(directory)).isDirectory()) {
            await closeStream(streamKey); cursor.frames.pop(); continue;
          }
        }
        const stream = await inventoryStream(streamKey, directory, frame.after);
        const entry: Dirent | null = await stream.dir.read();
        if (!entry) {
          await closeStream(streamKey);
          if (stream.seeking) {
            // The saved entry disappeared. Restart this directory on the next page so
            // insertion/deletion cannot strand the rest of the tree permanently.
            frame.after = null;
            break;
          }
          cursor.frames.pop();
          continue;
        }
        entriesLeft--;
        if (stream.seeking) {
          if (entry.name === frame.after) stream.seeking = false;
          continue;
        }
        frame.after = entry.name;
        stream.expected = entry.name;
        if (stream.recoveryLeft) stream.recoveryLeft--;
        const name = entry.name;
        if (entry.isSymbolicLink() || name.startsWith(".") || ignoredTrees.has(name.toLowerCase())) continue;
        const path = join(directory, name);
        if (entry.isDirectory()) { stream.suspended = true; cursor.frames.push({ path: relative(root, path), after: null }); }
        else if (entry.isFile() && testPath(path) && !inspected.has(path) && !excluded(path)) await inspect(path, true);
      } catch (error) {
        if (!unavailable(error)) throw error;
        await closeStream(streamKey); cursor.frames.pop();
      }
    }
    return { signals: result, cursor };
  } finally {
    if (!options.cacheKey) await closeTestDebtInventory(cacheKey);
  }
}

/** Stateless callers retain the existing single-page API. */
export async function inspectTestDebt(root: string, unit: AuditUnit, changed: readonly string[] = []): Promise<TestDebtSignal[]> {
  return (await inspectTestDebtPage(root, unit, changed)).signals;
}
