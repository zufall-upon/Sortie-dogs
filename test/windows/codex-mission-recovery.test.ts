import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codexProcessOwner, codexOwnerGone, OperatorMissionRuntime } from "../../dist/core/operator-mission.js";
import { V010_RUNTIME_PROFILE } from "../../dist/core/runtime-profile.js";

test("Windows recovery retains live, legacy and foreign owners and reclaims an absent killed lock owner", { skip: process.platform !== "win32", timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex windows recovery "));
  try {
    const owner = await codexProcessOwner();
    assert.equal(owner.platform, "win32");
    assert.equal(await codexOwnerGone(owner), false);
    assert.equal(await codexOwnerGone({ ...owner, platform: undefined }), false);
    assert.equal(await codexOwnerGone({ ...owner, platform: "linux" }), false);
    assert.equal(await codexOwnerGone({ ...owner, pid: -1 }), false);
    const missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
    await missions.capture("root", { id: "request", text: "Keep same Mission" });
    await missions.start("root", ["Keep same Mission"]);
    const missionURL = new URL("../../dist/core/operator-mission.js", import.meta.url).href;
    const profileURL = new URL("../../dist/core/runtime-profile.js", import.meta.url).href;
    const script = `import {OperatorMissionRuntime} from ${JSON.stringify(missionURL)}; import {V010_RUNTIME_PROFILE} from ${JSON.stringify(profileURL)};` +
      `await new OperatorMissionRuntime(${JSON.stringify(directory)}, V010_RUNTIME_PROFILE).codexRecovery('root', async () => { process.kill(process.pid, 'SIGKILL'); await new Promise(() => {}); });`;
    await assert.rejects(promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { windowsHide: true }));
    assert.equal(await missions.codexRecovery("root", async () => "reclaimed"), "reclaimed");
    assert.equal((await missions.required("root")).root, "root");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
