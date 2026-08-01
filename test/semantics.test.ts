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

const validFixtureNames = [
  "01-source-change-test-success",
  "02-docs-only-change",
  "03-blocker",
  "04-completed-no-next",
  "05-multiple-source-revisions",
  "06-minimal-validation-not-run",
  "07-cross-platform-separators",
  "08-risks-mitigation",
  "09-multiple-scope-paths",
  "10-minimal-investigation-start",
  "11-minimal-interrupted",
  "12-full-operation-manifest",
  "13-host-wrapper-minimal",
] as const;

interface ValidFixtureExpectation {
  diagnostics: string[];
  exit: number;
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
  const handoff = handoffWithInvalidSemantics();
  handoff.profile = "minimal";
  const result = lint(handoff);

  assert.deepEqual(result.diagnostics.at(-1), {
    code: "verification_exit_code_mismatch",
    severity: "warning",
    pointer: "/verification/0/exit_code",
    message: "Verification exit code does not match its status.",
  });
  assert.deepEqual(result.diagnostics[0], {
    code: "source_hash_length_mismatch",
    severity: "error",
    pointer: "/sources/0/hash",
    message: "Source hash digest has an invalid length.",
  });
  assert.deepEqual(
    result.diagnostics.slice(0, -1).map(({ pointer }) => pointer),
    Array.from({ length: 11 }, (_, index) => `/sources/${index}/hash`),
  );
});

test("H006 applies profile-aware severity, counts, and error-only ok status", () => {
  const handoff = handoffWithInvalidSemantics();
  handoff.sources = undefined;
  const full = lint(handoff);
  assert.deepEqual(full.counts, { error: 1, warning: 0, info: 0 });
  assert.equal(full.ok, false);

  handoff.profile = "minimal";
  const minimal = lint(handoff);
  assert.deepEqual(minimal.counts, { error: 0, warning: 1, info: 0 });
  assert.equal(minimal.ok, true);

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

test("H006-H008 and H010 valid fixture produces no semantic rule diagnostics", async () => {
  const result = lint(await readSemanticFixture("valid-h006-h008-h010"));
  assert.deepEqual(result.diagnostics, []);
});

for (const [fixture, code] of [
  ["invalid-h006", "verification_exit_code_mismatch"],
  ["invalid-h007", "source_hash_length_mismatch"],
  ["invalid-h008-date", "H008"],
  ["invalid-h008-offset", "H008"],
  ["invalid-h010", "H010"],
] as const) {
  test(`${fixture} fixture produces only ${code}`, async () => {
    const result = lint(await readSemanticFixture(fixture));
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), [code]);
  });
}

test("H010 checks every human-authored claim field", async () => {
  const mutations: Array<(handoff: Handoff) => void> = [
    (handoff) => { handoff.task.title = "   "; },
    (handoff) => { handoff.task.objective = "\t"; },
    (handoff) => { handoff.state.done = ["\n"]; },
    (handoff) => { handoff.state.next = ["   "]; },
    (handoff) => { handoff.state.blocked = [{ reason: " ", needed: "Act." }]; },
    (handoff) => { handoff.state.blocked = [{ reason: "Blocked.", needed: "\t" }]; },
    (handoff) => { handoff.risks = [{ severity: "low", description: " " }]; },
    (handoff) => { handoff.risks = [{ severity: "low", description: "Risk.", mitigation: "\n" }]; },
    (handoff) => { handoff.verification[0].check = " "; },
    (handoff) => { handoff.verification[0].summary = "\t"; },
  ];

  for (const mutate of mutations) {
    const handoff = await readSemanticFixture("valid-h006-h008-h010");
    mutate(handoff);
    assert.deepEqual(lint(handoff).diagnostics.map(({ code }) => code), ["H010"]);
  }
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

test("all 13 synthetic valid fixtures match expected diagnostics and exit", async () => {
  for (const name of validFixtureNames) {
    const directory = `./fixtures/valid/${name}`;
    const handoff = JSON.parse(await readFile(new URL(`${directory}/handoff.json`, import.meta.url), "utf8")) as Handoff;
    const expected = JSON.parse(
      await readFile(new URL(`${directory}/expected.json`, import.meta.url), "utf8"),
    ) as ValidFixtureExpectation;
    const pathDiagnostics = lintHandoffPaths(handoff);
    const semanticResult = lint(handoff);
    const diagnosticCodes = [
      ...pathDiagnostics.map(({ code }) => code),
      ...semanticResult.diagnostics.map(({ code }) => code),
    ];

    assert.deepEqual(diagnosticCodes, expected.diagnostics, name);
    assert.equal(pathDiagnostics.length === 0 && semanticResult.ok ? 0 : 1, expected.exit, name);
  }
});
