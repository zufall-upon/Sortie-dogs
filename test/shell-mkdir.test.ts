import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createProjectPaths, createWriteGate, extractWritePaths } from "../dist/plugin/gate.js";

const execFileAsync = promisify(execFile);

test("mkdir mode values are not write destinations", () => {
  for (const options of ["-m 700", "--mode 0700", "--mode=700", "-m700", "-m u=rwx,go=", "-m 'u=rwx,go='"]) {
    const result = extractWritePaths("shell", { command: `/usr/bin/mkdir ${options} 'private fixture' 700` });
    assert.deepEqual(result.paths, ["private fixture", "700"], options);
    assert.equal(result.ambiguous, false, options);
  }
  for (const options of ["-p -m 700", "-pm700", "-vpm 700", "--mode=700 --parents"]) {
    const result = extractWritePaths("shell", { command: `mkdir ${options} private/nested` });
    assert.deepEqual(result.paths, ["private/nested"], options);
    assert.deepEqual(result.createdDirectories, ["private/nested"], options);
  }
  const result = extractWritePaths("shell", { command: "mkdir -m 700 -- -m 700 -p --mode" });
  assert.deepEqual(result.paths, ["-m", "700", "-p", "--mode"]);
  assert.equal(result.createdDirectories, undefined, "-p after -- is a directory name");
  assert.deepEqual(extractWritePaths("shell", { command: "mkdir -m700 -" }).paths, ["-"]);
});

test("mkdir saved native failure extracts only the actual external destination", () => {
  // Native call_b957282b31e5429db98681d05a2e1373, previously denied at <workdir>/700.
  const destination = "/srv/work/mobmate/release-refresh-cb629b9f/source-sync-20261107";
  const result = extractWritePaths("shell", {
    command: `mkdir -m 700 ${destination} && MOBMATE_TEST_WORK_ROOT=${destination} PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 scripts/linux/test-package-input-preflight.py`,
    workdir: "/home/user/MobMateV2-release-preparation",
  });
  assert.deepEqual(result.paths, [destination]);
});

test("mkdir native gate permits mode options but checks every real directory and redirect", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/shell-mkdir-"));
  try {
    const project = join(directory, "project"), native = join(directory, "clone"), target = join(directory, "private");
    await mkdir(project);
    await mkdir(native);
    const gate = await createWriteGate(await createProjectPaths(project), {
      version: "0.1.0", task_id: "mkdir-mode", read: [], write: [`${target}/**`], validation: [],
    }, native);
    const request = { tool: "shell", sessionID: "author", callID: "mkdir-mode" };
    const check = (command: string) => gate.check(request, { args: { command, workdir: native } }, { investigativeShell: true });
    await check(`mkdir -m 700 '${target}'`);
    for (const command of [
      `mkdir -m 700 '${target}' 700`,
      `mkdir -m 700 '${target}' '${join(directory, "outside")}'`,
      `mkdir -m 700 '${target}' > '${join(directory, "outside.log")}'`,
      `mkdir -m 700 -- '${target}' -m`,
    ]) await assert.rejects(check(command), { name: "WriteDeniedError" }, command);
    if (process.platform !== "win32") {
      await execFileAsync("mkdir", ["-m", "700", target], { cwd: native });
      assert.equal((await stat(target)).mode & 0o777, 0o700);
      await assert.rejects(stat(join(native, "700")), { code: "ENOENT" });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
