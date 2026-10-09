import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { cliCloseStopReason, observationDirectories, probeStopReason, statusProbeStopReason, workerStartWithinProbeLimit, probeTaskIdentity } from "../scripts/mission-cli-probe.mjs";
import { nativeCLI } from "../scripts/release-cli.mjs";

const expected = "openai/gpt-6.1-sol#xhigh";
const root = { sessionID: "root", agent: "dog-operator", model: { providerID: "openai", id: "gpt-6.1-sol", variant: "xhigh" } };
const status = { agent: "dog-operator", tool: "sortie_v010_operator_status", status: "completed", model: root.model };

test("practical observation binds the exact original prompt and observed checkout, not the declared base", () => {
  const request = "Original task\r\nKeep exact bytes.\n";
  assert.deepEqual(probeTaskIdentity(request, { instance_id: "case", repo: "owner/repo", base_commit: "declared" }, "observed"), {
    task_sha256: createHash("sha256").update(request).digest("hex"),
    instance: { instance_id: "case", repo: "owner/repo", base_commit: "observed" },
  });
  assert.notEqual(probeTaskIdentity(request, undefined, "base").task_sha256,
    probeTaskIdentity(request.trim(), undefined, "base").task_sha256);
  assert.equal(probeTaskIdentity(request, undefined, "base").instance, null);
});

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

test("normal CLI close observes an already-started Worker before teardown, not just the next interval", () => {
  const observed = { models: [root, { agent: "dog-worker-v010", started_ms: 14_082,
    model: { providerID: "openai", id: "gpt-6-luna-fast", variant: "max" } }],
    responses: [], tools: [], errors: [], priced_usd: 0.0523404 };
  const options = { mode: "start", rootModel: expected, capUSD: 1, elapsedMs: 14_100, timeoutMs: 180_000 };
  assert.equal(probeStopReason(observed, options), "worker-started");
  assert.equal(cliCloseStopReason(0, false, observed, options), "worker-started");
  assert.equal(cliCloseStopReason(1, false, observed, options), null, "a failed CLI exit is not silently accepted");
  for (const prior of ["budget", "timeout", "model-mismatch"]) {
    assert.equal(cliCloseStopReason(0, prior, observed, options), null, "an earlier stop remains authoritative");
  }
  assert.equal(cliCloseStopReason(0, false, { ...observed, models: [root] }, options), null,
    "parent success alone is not native Worker startup");
  assert.equal(cliCloseStopReason(0, false, { ...observed, priced_usd: 1 }, options), "budget");
  assert.equal(cliCloseStopReason(0, false, observed, { ...options, mode: "complete" }), null,
    "startup does not qualify a completion-mode probe");
});
