import { createHash } from "node:crypto";
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

/** Inspect explicit inputs first, then a bounded inventory of declared directory scopes. */
export async function inspectTestDebt(root: string, unit: Pick<OperatorUnit, "read" | "write" | "validation" | "validation_cwd">,
  changed: readonly string[] = []): Promise<TestDebtSignal[]> {
  root = resolve(root);
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
    for (const word of command.match(/[^\s'"`|;&<>]+/gu) ?? []) {
      add(word, cwd);
      // Bare `test` is often a command or npm script name, not a directory argument.
      if (testPath(word) && word.replaceAll("\\", "/").endsWith("/**")) addDirectory(word, cwd);
    }
  }
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
  const discovered = new Set<string>();
  const queue = [...directories], visited = new Set<string>();
  let entriesLeft = MAX_WALK_ENTRIES, directoriesLeft = MAX_WALK_DIRECTORIES;
  while (queue.length && candidates.length < MAX_TEST_FILES && entriesLeft > 0 && directoriesLeft > 0) {
    const directory = queue.shift()!;
    if (visited.has(directory)) continue;
    visited.add(directory); directoriesLeft--;
    try {
      if (!await noLinks(directory) || !(await lstat(directory)).isDirectory()) continue;
      const names: { name: string; directory: boolean; file: boolean }[] = [];
      for await (const entry of await opendir(directory)) {
        entriesLeft--;
        const name = entry.name, lower = name.toLowerCase();
        // Hidden entries are opt-in explicit inputs, never automatic inventory targets.
        if (!entry.isSymbolicLink() && !name.startsWith(".") && !ignoredTrees.has(lower)) {
          names.push({ name, directory: entry.isDirectory(), file: entry.isFile() });
        }
        if (!entriesLeft) break;
      }
      names.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of names) {
        const path = join(directory, entry.name);
        if (entry.directory) queue.push(path);
        else if (entry.file && testPath(path) && !candidates.includes(path) && candidates.length < MAX_TEST_FILES) {
          candidates.push(path); discovered.add(path);
        }
      }
    } catch (error) { if (!unavailable(error)) throw error; }
  }
  const result: TestDebtSignal[] = [];
  for (const path of candidates.slice(0, MAX_TEST_FILES)) {
    try {
      const stat = await lstat(path);
      // Do not traverse links or special files as a side effect of an ordinary edit.
      if (!stat.isFile()) continue;
      const canonical = await realpath(path);
      if (discovered.has(path) ? !inside(canonicalRoot, canonical) || !await noLinks(path) : !inside(root, canonical)) continue;
      if (stat.size > 512 * 1024) {
        // Size alone schedules investigation; it never licenses deletion or claims a full read.
        result.push({ path: relative(root, path).replaceAll("\\", "/"), sha256: null, lines: null,
          bytes: stat.size, repeated_assertions: [], reasons: ["large-test-file"] });
        continue;
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
      if (!reasons.length) continue;
      result.push({ path: relative(root, path).replaceAll("\\", "/"), sha256: createHash("sha256").update(content).digest("hex"),
        lines: lines.length, bytes: stat.size, repeated_assertions: repeated, reasons });
    } catch (error) {
      // A missing/deleted/unreadable candidate is not a finding and never blocks the Mission.
      if (!unavailable(error)) throw error;
    }
  }
  return result;
}
