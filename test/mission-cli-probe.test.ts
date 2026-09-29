import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { observationDirectories, statusProbeStopReason, workerStartWithinProbeLimit } from "../scripts/mission-cli-probe.mjs";
import { nativeCLI } from "../scripts/release-cli.mjs";

const expected = "openai/gpt-6-sol#xhigh";
const root = { sessionID: "root", agent: "dog-operator", model: { providerID: "openai", id: "gpt-6-sol", variant: "xhigh" } };
const status = { agent: "dog-operator", tool: "sortie_v010_operator_status", status: "completed", model: root.model };

test("explicit status probe observes the requested model and returns on its first status result", () => {
  assert.equal(statusProbeStopReason({ root: "root", models: [], tools: [] }, expected), null);
  assert.equal(statusProbeStopReason({ root: "root", models: [root], tools: [] }, expected), null);
  assert.equal(statusProbeStopReason({ root: "root", models: [root], tools: [status] }, expected), "status-observed");
});

test("a wrong model ends only the explicit probe, even if it can call status", () => {
  const actual = { ...root, model: { providerID: "opencode", id: "space-bunny-free" } };
  assert.equal(statusProbeStopReason({ root: "root", models: [actual], tools: [status] }, expected), "model-mismatch");
  assert.equal(statusProbeStopReason({ root: "root", models: [root], tools: [{ ...status, model: actual.model }] }, expected), "model-mismatch",
    "the status tool's real model, not only the session's first turn, must match");
  assert.equal(statusProbeStopReason({ root: "root", models: [{ ...root, sessionID: "foreign" }], tools: [status] }, expected), null);
  assert.equal(statusProbeStopReason({ root: "root", models: [root], tools: [
    { ...status, status: "error" }, { ...status, agent: "dog-worker-v010" },
  ] }, expected), null);
});

test("CLI probes invoke native Windows npm and OpenCode binaries without a shell", () => {
  const entry = resolve("test/mission-cli-probe.test.ts");
  assert.deepEqual(nativeCLI("npm", ["install", "--force"], {
    platform: "win32", node: "node.exe", npmEntry: entry, openCodeEntry: entry,
  }), { executable: "node.exe", args: [entry, "install", "--force"] });
  assert.deepEqual(nativeCLI("opencode", ["run", "user prompt"], {
    platform: "win32", node: "node.exe", npmEntry: entry, openCodeEntry: entry,
  }), { executable: entry, args: ["run", "user prompt"] });
  assert.deepEqual(nativeCLI("npm", ["install"], { platform: "linux", npmEntry: entry }),
    { executable: "npm", args: ["install"] });
});

test("native V2 session directories use forward slashes even for Windows projects", () => {
  assert.deepEqual(observationDirectories("M:\\work\\fixture"), ["M:\\work\\fixture", "M:/work/fixture"]);
  assert.deepEqual(observationDirectories("/home/user/fixture"), ["/home/user/fixture", "/home/user/fixture"]);
});

test("the start-only Worker deadline does not invalidate a completed native receipt", () => {
  const worker = { started_ms: 75_895 };
  assert.equal(workerStartWithinProbeLimit("start", worker), false);
  assert.equal(workerStartWithinProbeLimit("start", worker, { repo: "example/repo" }), true);
  assert.equal(workerStartWithinProbeLimit("start", worker, undefined, 180_000), true,
    "a release startup probe has its own deadline, not the benchmark's 60-second target");
  assert.equal(workerStartWithinProbeLimit("start", { started_ms: -1 }, undefined, 180_000), false);
  assert.equal(workerStartWithinProbeLimit("complete", worker), true);
});
