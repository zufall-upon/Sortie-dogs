import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { requestJson, sanitizedHttpFailure } from "./fixtures/evidence-runtime/http-json.mjs";

async function loopback(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function close(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("evidence runtime driver freezes a new five-lane live-deadline scenario", () => {
  const result = spawnSync(process.execPath, ["test/fixtures/evidence-runtime/run-evidence-runtime-rpt.mjs", "--self-test"], {
    cwd: process.cwd(), encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout.trim());
  assert.deepEqual(evidence, {
    schemaVersion: "evidence-runtime-rpt-self-test-v1",
    status: "pass",
    laneCount: 5,
    deadlineMs: 180000,
    intentionalHoldMs: 420000,
    expectedTrigger: "live_deadline_exceeded",
    controlPaths: [
      ".sortie-dogs/contracts/handoff.critical.json",
      ".sortie-dogs/contracts/critical.operation-manifest.json",
    ],
    branchIdentity: { lunaCritical: false, solCritical: true },
    cliResolution: { default: "opencode", override: "/fixture/opencode" },
    expectedTakeovers: 1,
    phases: ["prepare", "waves-through-review", "pre-cas-check", "single-cas", "replay-and-cleanup"],
  });
  assert.equal(result.stdout.includes("critical-takeover-rpt"), false);
});

test("evidence runtime HTTP transport waits for delayed headers and posts exactly once", async () => {
  let requests = 0;
  const fixture = await loopback((request, response) => {
    requests += 1;
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => setTimeout(() => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ received: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    }, 150));
  });
  try {
    assert.deepEqual(await requestJson(fixture.url, "/delayed", {
      method: "POST", body: { task: "once" }, timeoutMs: 2_000,
    }), { received: { task: "once" } });
    assert.equal(requests, 1);
  } finally {
    await close(fixture.server);
  }
});

test("evidence runtime HTTP transport enforces one wall-clock timeout", async () => {
  let requests = 0;
  const fixture = await loopback((_request, response) => {
    requests += 1;
    setTimeout(() => response.end('{"late":true}'), 600);
  });
  try {
    await assert.rejects(requestJson(fixture.url, "/timeout", { timeoutMs: 100 }), (error) => {
      const metadata = sanitizedHttpFailure(error);
      assert.equal(metadata.code, "REQUEST_WALL_TIMEOUT");
      assert.equal(metadata.phase, "headers");
      assert.ok(metadata.elapsedMs >= 80 && metadata.elapsedMs < 500, JSON.stringify(metadata));
      return true;
    });
    assert.equal(requests, 1);
  } finally {
    await close(fixture.server);
  }
});

test("evidence runtime HTTP transport types status and malformed body failures", async () => {
  const fixture = await loopback((request, response) => {
    if (request.url === "/status") {
      response.writeHead(503).end('{"error":"redacted"}');
    } else {
      response.end("not-json");
    }
  });
  try {
    await assert.rejects(requestJson(fixture.url, "/status", { timeoutMs: 2_000 }), (error) => {
      assert.deepEqual(sanitizedHttpFailure(error), {
        code: "HTTP_STATUS", causeCode: null, errno: null, syscall: null,
        phase: "body", elapsedMs: sanitizedHttpFailure(error).elapsedMs, statusCode: 503,
      });
      return true;
    });
    await assert.rejects(requestJson(fixture.url, "/body", { timeoutMs: 2_000 }), (error) => {
      const metadata = sanitizedHttpFailure(error);
      assert.equal(metadata.code, "INVALID_JSON");
      assert.equal(metadata.phase, "body");
      return true;
    });
  } finally {
    await close(fixture.server);
  }
});
