import assert from "node:assert/strict";
import test from "node:test";

import { lint } from "../src/core/diagnostics.ts";

const SECRET = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
const SHORT_SECRET = "aB3dE5fG7hJ9kL2m";

function handoff(profile: string = "minimal"): Parameters<typeof lint>[0] {
  return {
    profile,
    created_at: "2026-08-01T00:00:00Z",
    task: { title: "Security test", objective: "Verify secret diagnostics" },
    state: { done: [], next: ["Continue"], blocked: [] },
    risks: [],
    verification: [],
    ext: {
      nested: [{ "token/with~escaped-pointer": SECRET }],
      ignoredByOtherRules: { title: "   ", path: "../not-a-scope-path" },
    },
  } as Parameters<typeof lint>[0];
}

test("H009 reports only the pointer and defaults to warning", () => {
  const result = lint(handoff());
  const diagnostic = result.diagnostics.find(({ code }) => code === "H009");

  assert.deepEqual(diagnostic, {
    code: "H009",
    severity: "warning",
    pointer: "/ext/nested/0/token~1with~0escaped-pointer",
    message: "Value resembles a credential or high-entropy token.",
  });
  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.length, 1, "ext values must not be processed by other semantic rules");
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(JSON.stringify(result).includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ"), false);
});

test("H009 is an error through the supported severity option", () => {
  const result = lint(handoff(), { severity: { H009: "error" } });

  assert.equal(result.diagnostics.find(({ code }) => code === "H009")?.severity, "error");
  assert.equal(result.ok, false);
  assert.equal(result.counts.error, 1);
});

test("H009 detects short, embedded, and late secret-like tokens", () => {
  const input = handoff();
  input.ext = {
    short: SHORT_SECRET,
    embedded: `prefix:${SHORT_SECRET}:suffix`,
    late: `${"ordinary text ".repeat(400)}${SHORT_SECRET}`,
  };

  const result = lint(input);
  const pointers = result.diagnostics.filter(({ code }) => code === "H009").map(({ pointer }) => pointer);
  assert.deepEqual(pointers, ["/ext/embedded", "/ext/late", "/ext/short"]);
});

test("H009 positionalizes secret-like object keys", () => {
  const input = handoff();
  input.ext = { container: { [SECRET]: SHORT_SECRET } };

  const result = lint(input);
  const serialized = JSON.stringify(result);
  assert.equal(result.diagnostics.find(({ code }) => code === "H009")?.pointer, "/ext/container/@0");
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ"), false);
});
