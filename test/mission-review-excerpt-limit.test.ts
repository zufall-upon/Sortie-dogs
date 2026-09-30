import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import test from "node:test";
import { missionReviewSource } from "../dist/plugin/mission-review.js";

test("oversized Review excerpt requests are displayed with a notice, not another model retry", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/review-display-limit-"));
  try {
    const run = { units: [{ unit: { read: [], write: [] }, hashes: [] }] } as never;
    const path = join(directory, "vmStmt.go");
    const lines = Array.from({ length: 230 }, (_, i) => `source line ${i + 1}`);
    await writeFile(path, lines.join("\n"));
    const evidence = [{ path: "vmStmt.go", offset: 1, limit: 220 }];
    const packet = await missionReviewSource(directory, run, evidence);
    assert.match(packet.excerpt, /200: source line 200\n/);
    assert.doesNotMatch(packet.excerpt, /201: source line 201/);
    assert.match(packet.excerpt, /FOCUSED EXCERPT TRUNCATED: vmStmt.go:1; Reviewer can read the remaining lines directly/);
    assert.deepEqual(packet.truncatedEvidence, ["vmStmt.go:1"]);
    lines[225] = "changed outside the display";
    await writeFile(path, lines.join("\n"));
    assert.notEqual((await missionReviewSource(directory, run, evidence)).fingerprint, packet.fingerprint,
      "all source bytes remain pinned, including the undisplayed tail");
    assert.equal(evidence[0]!.limit, 220, "the request and unit contract are not rewritten");
    await writeFile(path, "complete short source\n");
    assert.deepEqual((await missionReviewSource(directory, run, evidence)).truncatedEvidence, [],
      "a large request against a short file creates no phantom evidence gap");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
