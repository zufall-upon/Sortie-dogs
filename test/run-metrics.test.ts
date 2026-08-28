import assert from "node:assert/strict";
import test from "node:test";
import { collectRunMetrics, formatRunMetrics, insertRunMetrics, isDoneTerminalText } from "../src/plugin/run-metrics.ts";

test("collects bounded recursive assistant metrics and deduplicates messages", async () => {
  const metrics = await collectRunMetrics({ session: {
    get: async () => ({ data: { time: { created: 1_000 } } }),
    children: async ({ path }) => ({ data: path.id === "root" ? [{ id: "child" }] : [] }),
    messages: async () => ({ data: [{ info: { id: "same", role: "assistant", cost: 0.25, tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 5, write: 1 } } }, time: { created: 2_000, completed: 3_000 } }] }),
  } }, "root", "test", 5_000);
  assert.deepEqual(metrics, { durationMilliseconds: 4_000, tokens: 19, cost: 0.25, steps: 1, sessions: 2, cacheRatio: 5 / 19 });
  assert.match(formatRunMetrics(metrics!), /pre-terminal host snapshot[\s\S]*\$0\.2500/u);
  const original = "✅ **DONE** x\n\n**Validation:** keep\n\n<details>";
  const inserted = insertRunMetrics(original, metrics!);
  assert.match(inserted, /^✅ \*\*DONE\*\* x\n\n\*\*Run:\*\*/u);
  assert.match(inserted, /\*\*Run:\*\*[\s\S]*\n\n\*\*Validation:\*\* keep\n\n<details>$/u);
  assert.equal(insertRunMetrics(inserted, metrics!), inserted);
});

test("marks cost unavailable when an assistant has no finite host cost", async () => {
  const metrics = await collectRunMetrics({ session: { messages: async () => ({ data: [{ info: { id: "m", role: "assistant", tokens: { input: 1 } } }] }) } }, "root", undefined, 1);
  assert.equal(metrics?.cost, undefined);
  assert.match(formatRunMetrics(metrics!), /cost unavailable/);
});

test("recognizes only an accepted first terminal status line", () => {
  assert.equal(isDoneTerminalText("✅ **DONE** — complete\n\nbody **DONE**"), true);
  assert.equal(isDoneTerminalText("status: DONE — complete\n\nbody"), true);
  assert.equal(isDoneTerminalText("progress\n✅ **DONE** — body mention"), false);
  assert.equal(isDoneTerminalText("✅ **BLOCKED** — body **DONE**"), false);
  assert.equal(isDoneTerminalText("NEED_DECISION: DONE"), false);
  assert.equal(isDoneTerminalText("  ✅ **DONE** — indented"), false);
});

test("reports unavailable tokens and survives host failures", async () => {
  const missing = await collectRunMetrics({ session: {
    children: async () => ({ data: [] }),
    messages: async () => ({ data: [{ info: { id: "m", role: "assistant", tokens: { input: 1 } } }] }),
  } }, "root", undefined, 1);
  assert.equal(missing?.tokens, undefined);
  assert.equal(missing?.cacheRatio, undefined);
  assert.equal(missing?.durationMilliseconds, undefined);
  assert.match(formatRunMetrics(missing!), /tokens unavailable/);
  assert.match(formatRunMetrics(missing!), /duration unavailable/);
  assert.equal(await collectRunMetrics({ session: { messages: async () => { throw new Error("host"); } } }, "root"), undefined);
});

test("reports a zero pre-terminal snapshot for a single-turn DONE", async () => {
  const metrics = await collectRunMetrics({ session: {
    get: async () => ({ data: { time: { created: 1_000 } } }),
    children: async () => ({ data: [] }),
    messages: async () => ({ data: [] }),
  } }, "root", undefined, 2_000);
  assert.deepEqual(metrics, {
    durationMilliseconds: 1_000,
    tokens: 0,
    cost: 0,
    steps: 0,
    sessions: 1,
    cacheRatio: undefined,
  });
  assert.match(formatRunMetrics(metrics!), /1s wall-clock · 0 tokens · \$0\.0000 · 0 completed assistant model steps · 1 session/u);
});

test("marks totals unavailable when child discovery is incomplete", async () => {
  const metrics = await collectRunMetrics({ session: {
    children: async () => { throw new Error("children unavailable"); },
    messages: async () => ({ data: [{ info: {
      id: "root", role: "assistant", cost: 0.1,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    } }] }),
  } }, "root", undefined, 1);
  assert.equal(metrics?.tokens, undefined);
  assert.equal(metrics?.cost, undefined);
  assert.equal(metrics?.steps, undefined);
  assert.equal(metrics?.sessions, undefined);
  assert.match(formatRunMetrics(metrics!), /steps unavailable · sessions unavailable/u);
});

test("excludes the terminal assistant message until host accounting completes", async () => {
  const metrics = await collectRunMetrics({ session: {
    children: async () => ({ data: [] }),
    messages: async () => ({ data: [{ info: {
      id: "completed", role: "assistant", time: { completed: 2 }, cost: 0.1,
      tokens: { input: 2, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    } }, { info: {
      id: "terminal", role: "assistant", time: { created: 3 }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } }] }),
  } }, "root", undefined, 4);
  assert.equal(metrics?.tokens, 3);
  assert.equal(metrics?.steps, 1);
});

test("marks totals unavailable when an assistant message has no identity", async () => {
  const metrics = await collectRunMetrics({ session: {
    children: async () => ({ data: [] }),
    messages: async () => ({ data: [{ info: {
      role: "assistant", cost: 0.1,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    } }, { info: {
      id: "known", role: "assistant", cost: 0.2,
      tokens: { input: 2, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    } }] }),
  } }, "root", undefined, 1);
  assert.equal(metrics?.tokens, undefined);
  assert.equal(metrics?.cost, undefined);
  assert.equal(metrics?.steps, undefined);
  assert.equal(metrics?.sessions, 1);
});
