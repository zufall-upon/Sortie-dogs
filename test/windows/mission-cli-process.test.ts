import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { stopProcessGroup } from "../../scripts/release-cli.mjs";

test("Windows CLI probe stops its owned native process after a bounded run", { skip: process.platform !== "win32" }, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true, stdio: "ignore", windowsHide: true,
  });
  await once(child, "spawn");
  try {
    await stopProcessGroup(child);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});
