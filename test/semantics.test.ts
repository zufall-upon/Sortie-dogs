import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { lint } from "../src/core/diagnostics.ts";
import { normalizeRelativePath, RelativePathError } from "../src/core/path.ts";
import { lintHandoff, lintHandoffPaths } from "../src/core/validate-semantics.ts";
import type { Handoff } from "../src/core/types.ts";

async function readSemanticFixture(name: string): Promise<Handoff> {
  const url = new URL(`./fixtures/invalid-semantic/${name}.json`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as Handoff;
}

function handoffWithInvalidSemantics(): Handoff {
  return {
    version: "0.1.0",
    profile: "full",
    id: "diagnostic-test",
    created_at: "2030-01-02T03:04:05Z",
    task: { title: "Diagnostics", objective: "Exercise deterministic diagnostics." },
    scope: { paths: ["src"] },
    state: { done: [], next: ["Continue semantic validation."], blocked: [] },
    sources: [
      { path: "src/secret-source", rev: "main", hash: "sha256:private-value" },
      { path: "src/source-1", rev: "main", hash: "sha256:short" },
      { path: "src/source-2", rev: "main", hash: "sha256:tiny" },
      { path: "src/source-3", rev: "main", hash: "sha256:x" },
      { path: "src/source-4", rev: "main", hash: "sha256:y" },
      { path: "src/source-5", rev: "main", hash: "sha256:z" },
      { path: "src/source-6", rev: "main", hash: "sha256:a" },
      { path: "src/source-7", rev: "main", hash: "sha256:b" },
      { path: "src/source-8", rev: "main", hash: "sha256:c" },
      { path: "src/source-9", rev: "main", hash: "sha256:d" },
      { path: "src/source-10", rev: "main", hash: "sha256:e" },
    ],
    risks: [],
    verification: [
      { check: "secret-check", status: "pass", exit_code: 17, summary: "private-summary" },
    ],
  };
}

test("adapts existing semantic issues to fixed codes and messages without input values", () => {
  const handoff = handoffWithInvalidSemantics();
  const rawIssues = lintHandoff(handoff);
  const result = lint(handoff);

  assert.equal(rawIssues.length, result.diagnostics.length);
  assert.deepEqual(
    new Set(result.diagnostics.map(({ code }) => code)),
    new Set(["verification_exit_code_mismatch", "source_hash_length_mismatch"]),
  );
  assert.deepEqual(
    new Set(result.diagnostics.map(({ message }) => message)),
    new Set([
      "Verification exit code does not match its status.",
      "Source hash digest has an invalid length.",
    ]),
  );

  const serializedMessages = result.diagnostics.map(({ message }) => message).join(" ");
  for (const inputValue of ["secret-source", "private-value", "secret-check", "private-summary", "sha256", "64", "pass", "17"]) {
    assert.equal(serializedMessages.includes(inputValue), false);
  }
});

test("sorts by severity, numeric JSON-pointer segments, then code", () => {
  const result = lint(handoffWithInvalidSemantics(), {
    severity: { source_hash_length_mismatch: "warning" },
  });

  assert.deepEqual(result.diagnostics[0], {
    code: "verification_exit_code_mismatch",
    severity: "error",
    pointer: "/verification/0/exit_code",
    message: "Verification exit code does not match its status.",
  });
  assert.deepEqual(
    result.diagnostics.slice(1).map(({ pointer }) => pointer),
    Array.from({ length: 11 }, (_, index) => `/sources/${index}/hash`),
  );
});

test("applies code filtering, severity overrides, counts, and error-only ok status", () => {
  const handoff = handoffWithInvalidSemantics();
  const filtered = lint(handoff, {
    codes: ["source_hash_length_mismatch"],
    severity: { source_hash_length_mismatch: "warning" },
  });

  assert.equal(filtered.diagnostics.length, 11);
  assert.ok(filtered.diagnostics.every(({ code, severity }) => code === "source_hash_length_mismatch" && severity === "warning"));
  assert.deepEqual(filtered.counts, { error: 0, warning: 11, info: 0 });
  assert.equal(filtered.ok, true);

  const errors = lint(handoff, { codes: ["verification_exit_code_mismatch"] });
  assert.deepEqual(errors.counts, { error: 1, warning: 0, info: 0 });
  assert.equal(errors.ok, false);

  const empty = lint(handoff, { codes: [] });
  assert.deepEqual(empty, {
    diagnostics: [],
    counts: { error: 0, warning: 0, info: 0 },
    ok: true,
  });
});

test("H001 normalizes separators and empty or dot segments while preserving case", () => {
  assert.equal(normalizeRelativePath("Src\\Core//./Path.ts/"), "Src/Core/Path.ts");
  assert.equal(normalizeRelativePath("a.../b.."), "a.../b..");
});

test("H001 rejects empty, traversal, absolute, drive, and UNC paths without exposing inputs", () => {
  const invalidPaths = [
    "",
    ".",
    "..",
    "safe/../private-value",
    "/absolute/private-value",
    "\\absolute\\private-value",
    "C:private-value",
    "C:\\private-value",
    "\\\\server\\private-value",
  ];

  for (const invalidPath of invalidPaths) {
    assert.throws(
      () => normalizeRelativePath(invalidPath),
      (error: unknown) => {
        assert.ok(error instanceof RelativePathError);
        assert.equal(error.message.includes("private-value"), false);
        assert.equal(error.message.includes("server"), false);
        return true;
      },
    );
  }
});

test("H001 detects duplicates after normalization without exposing path values", () => {
  const handoff = handoffWithInvalidSemantics();
  handoff.scope = {
    paths: ["Secret\\Source", "Secret//./Source"],
    excludes: ["Private/Output", "Private\\Output/"],
  };
  handoff.sources = [
    { path: "Internal\\Reference", rev: "one" },
    { path: "Internal/./Reference", rev: "two" },
  ];

  const issues = lintHandoffPaths(handoff);
  assert.deepEqual(
    issues.map(({ code, path }) => ({ code, path })),
    [
      { code: "H001", path: "/scope/paths/1" },
      { code: "H001", path: "/scope/excludes/1" },
      { code: "H001", path: "/sources/1/path" },
    ],
  );
  const serializedMessages = issues.map(({ message }) => message).join(" ");
  for (const inputValue of ["Secret", "Source", "Private", "Output", "Internal", "Reference"]) {
    assert.equal(serializedMessages.includes(inputValue), false);
  }
});

test("H002-H005 valid fixture produces no semantic rule diagnostics", async () => {
  const result = lint(await readSemanticFixture("valid-h002-h005"));
  assert.deepEqual(result.diagnostics, []);
});

for (const code of ["H002", "H003", "H004", "H005"] as const) {
  test(`${code} invalid fixture produces only ${code}`, async () => {
    const result = lint(await readSemanticFixture(`invalid-${code.toLowerCase()}`));
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), [code]);
    assert.equal(result.diagnostics[0]?.message.includes("TBD"), false);
  });
}

test("H004 accepts a completed state without a next action", () => {
  const handoff = handoffWithInvalidSemantics();
  handoff.state.done = ["Completed the scoped task."];
  handoff.state.next = [];
  handoff.sources = undefined;
  handoff.verification = [{ check: "complete", status: "pass", exit_code: 0, summary: "Complete." }];

  assert.equal(lintHandoff(handoff).some(({ code }) => code === "H004"), false);
});
