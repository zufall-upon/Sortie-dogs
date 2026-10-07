import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { prepareCodexWrite } from "../../dist/codex/mission-write.js";

test("Windows write transports >74K literal characters without overflowing spawn argv", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex write 日本語 "));
  const content = "日本語\r\n'$literal' \"quotes\" \u0000\n".repeat(10000);
  const destination = join(directory, "literal file.txt");
  let payload: Awaited<ReturnType<typeof prepareCodexWrite>> | undefined;
  try {
    payload = await prepareCodexWrite(destination, content);
    assert(content.length > 74580);
    assert(payload.command.every(arg => arg.length < 1024));
    await assert.rejects(readFile(destination), { code: "ENOENT" }, "staging does not write the project file");
    await promisify(execFile)(payload.command[0], payload.command.slice(1), { cwd: directory, windowsHide: true });
    assert.equal(await readFile(destination, "utf8"), content);
  } finally {
    await payload?.dispose();
    if (payload) await assert.rejects(readFile(payload.command.at(-1)!), { code: "ENOENT" });
    await rm(directory, { recursive: true, force: true });
  }
});
