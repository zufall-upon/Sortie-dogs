import assert from "node:assert/strict";
import test from "node:test";

import { lint } from "../src/core/diagnostics.ts";
import { lintHandoff } from "../src/core/validate-semantics.ts";
import type { Handoff } from "../src/core/types.ts";

function handoffWithInvalidSemantics(): Handoff {
  return {
    version: "0.1.0",
    profile: "full",
    id: "diagnostic-test",
    created_at: "2030-01-02T03:04:05Z",
    task: { title: "Diagnostics", objective: "Exercise deterministic diagnostics." },
    scope: { paths: ["src"] },
    state: { done: [], next: [], blocked: [] },
    sources: [
      { path: "secret-source", rev: "main", hash: "sha256:private-value" },
      { path: "source-1", rev: "main", hash: "sha256:short" },
      { path: "source-2", rev: "main", hash: "sha256:tiny" },
      { path: "source-3", rev: "main", hash: "sha256:x" },
      { path: "source-4", rev: "main", hash: "sha256:y" },
      { path: "source-5", rev: "main", hash: "sha256:z" },
      { path: "source-6", rev: "main", hash: "sha256:a" },
      { path: "source-7", rev: "main", hash: "sha256:b" },
      { path: "source-8", rev: "main", hash: "sha256:c" },
      { path: "source-9", rev: "main", hash: "sha256:d" },
      { path: "source-10", rev: "main", hash: "sha256:e" },
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
