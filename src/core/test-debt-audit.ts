import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { OperatorUnit } from "./operator-runtime.js";
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

/** Inspect only explicit files from this unit and its exact validation arguments, never a repository walk. */
export async function inspectTestDebt(root: string, unit: Pick<OperatorUnit, "read" | "write" | "validation" | "validation_cwd">,
  changed: readonly string[] = []): Promise<TestDebtSignal[]> {
  const candidates: string[] = [];
  const add = (path: string, base = root) => {
    if (!path || /[*?{}\[\]]/u.test(path) || !testPath(path)) return;
    const absolute = resolve(base, path);
    if (inside(root, absolute) && !candidates.includes(absolute)) candidates.push(absolute);
  };
  for (const path of [...changed, ...unit.read, ...unit.write]) add(path);
  for (const command of unit.validation) {
    const cwd = unit.validation_cwd?.[normalizeCommand(command)] ?? root;
    for (const word of command.match(/[^\s'"`|;&<>]+/gu) ?? []) add(word, cwd);
  }
  const result: TestDebtSignal[] = [];
  for (const path of candidates.slice(0, 16)) {
    try {
      const stat = await lstat(path);
      // Do not traverse links or special files as a side effect of an ordinary edit.
      if (!stat.isFile() || !inside(root, await realpath(path))) continue;
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
      if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return result;
}
