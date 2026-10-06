import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { CodexAppServerHost, createCodexAppServerTransport } from "../dist/codex/app-server.js";

const codex = process.env.SORTIE_CODEX_LIVE_EXECUTABLE;
const enabled = process.env.SORTIE_CODEX_LIVE_INTERRUPT_RESUME === "1";

test("live Codex interruption preserves exact thread resume and later isolated work",
  { skip: !enabled || !codex, timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "sortie-codex-interrupt-resume-"));
  await promisify(execFile)("git", ["-C", root, "init", "--quiet"]);
  const host = new CodexAppServerHost(createCodexAppServerTransport({ executable: codex! }));
  try {
    // Codex intentionally has no rollout to resume for ephemeral threads. Use a
    // new isolated persisted test thread to exercise the native resume path.
    const threadID = await host.startThread({ cwd: root, ephemeral: false });
    let requested = false;
    const interrupted = await host.runTurn(threadID,
      "Run this command once and wait for it to finish: node -e \"setTimeout(() => {}, 30000)\". Do not modify files.", {
        cwd: root, approvalPolicy: "never",
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [root], networkAccess: false },
        onEvent: event => {
          const item = event.params.item;
          if (!requested && event.method === "item/started" && item && typeof item === "object" &&
              "type" in item && item.type === "commandExecution") {
            requested = true;
            return host.interrupt();
          }
        },
      });
    assert.equal(requested, true);
    assert.equal(interrupted.status, "interrupted");
    await host.resumeThread(threadID);
    const resumed = await host.runTurn(threadID,
      "Create resumed.txt containing exactly: resumed ok followed by one newline. Do not modify any other file.", {
        cwd: root, approvalPolicy: "never",
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [root], networkAccess: false },
    });
    assert.equal(resumed.status, "completed");
    assert.notEqual(resumed.turnID, interrupted.turnID);
    assert.equal(await readFile(join(root, "resumed.txt"), "utf8"), "resumed ok\n");
    console.log(JSON.stringify({ marker: "codex-live-interrupt-resume", root, threadID,
      interruptedTurnID: interrupted.turnID, resumedTurnID: resumed.turnID, resumedStatus: resumed.status }));
  } finally { await host.close(); }
});
