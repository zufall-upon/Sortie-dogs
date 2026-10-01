import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createProjectPaths, createWriteGate, extractWritePaths } from "../dist/plugin/gate.js";

const exec = promisify(execFile);
const sink = process.platform === "win32" ? "NUL" : "/dev/null";

test("shell redirect sinks are platform-specific and do not exempt file mutations", () => {
  for (const command of [`printf x >${sink}`, `rg missing result.txt 2>${sink}`, `printf x >"${sink}" 2>>'${sink}'`]) {
    const extracted = extractWritePaths("shell", { command });
    assert.deepEqual(extracted.paths, [], command);
    assert.equal(extracted.applies, false, "discard-only read-only commands have no output artifact");
    assert.equal(extracted.ambiguous, false, command);
  }
  for (const target of [process.platform === "win32" ? "/dev/null" : "NUL", `${sink}-output`]) {
    assert.deepEqual(extractWritePaths("shell", { command: `printf x >${target}` }).paths, [target],
      "another platform's sink spelling and similar names are still ordinary known destinations");
  }
  assert.deepEqual(extractWritePaths("shell", { command: `rm ${sink}` }).paths, [sink], "mutation of a device is not output redirection");
  assert.deepEqual(extractWritePaths("write", { filePath: sink }).paths, [sink], "native file-tool authorization is unchanged");
  const opaque = extractWritePaths("shell", { command: `node unknown.mjs 2>${sink}` });
  assert.deepEqual(opaque.paths, []);
  assert.equal(opaque.ambiguous, true, "discarding stderr does not classify an opaque executable as read-only");
});

test("shell sink redirects keep real scoped, prohibited and outside destinations visible to the shared gate", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const area = await mkdtemp(resolve("_testenv/shell-sink-"));
  const directory = join(area, "project"), nested = join(directory, "nested"), outside = join(area, "outside.txt");
  try {
    await mkdir(nested, { recursive: true });
    await writeFile(outside, "outside preserved\n");
    const inherited = `node check.mjs > inherited.txt 2>${sink}`;
    const gate = await createWriteGate(await createProjectPaths(directory), {
      version: "0.1.0", task_id: "shell-sink", read: [], write: ["nested/result.txt"], validation: [inherited],
    });
    const request = { tool: "shell", sessionID: "worker", callID: "sink-call" };
    for (const workdir of [undefined, ".", "nested", nested]) {
      const args = { command: `rg missing result.txt 2>${sink}`, ...(workdir === undefined ? {} : { workdir }) };
      await gate.check(request, { args });
      await gate.check(request, { args }, { investigativeShell: true });
      const diagnostic = { ...args, command: `node diagnostic.mjs 2>${sink}` };
      await gate.check(request, { args: diagnostic }, { investigativeShell: true });
      await assert.rejects(gate.check(request, { args: diagnostic }), /unclassified-command|executable-not-allowlisted/);
    }
    for (const command of [`printf x > '${outside}' 2>${sink}`, `printf x 2>${sink} > '${outside}'`,
      `node diagnostic.mjs 2>${sink} > '${outside}'`, `printf x >${sink} && printf x > '${outside}'`]) {
      const extracted = extractWritePaths("shell", { command, workdir: "nested" }, directory);
      assert.deepEqual(extracted.paths, [outside], "only the sink disappears, never the real absolute output");
      await assert.rejects(gate.check(request, { args: { command, workdir: "nested" } }, { investigativeShell: true }),
        /project-root-relative path required|outside the manifest write scope/);
    }
    await assert.rejects(gate.check(request, { args: { command: `printf x > outside.txt 2>${sink}`, workdir: nested } }, { investigativeShell: true }), /manifest write scope/);
    await assert.rejects(gate.check(request, { args: { command: `printf x 2>${sink} > ../outside.txt`, workdir: nested } }, { investigativeShell: true }), /project-root-relative path required/);
    await assert.rejects(gate.check(request, { args: { command: inherited, workdir: nested } }, { investigativeShell: true }), /manifest write scope/,
      "an inherited command in another cwd still cannot bypass its real destination guard");
    const command = `printf ready > result.txt 2>${sink}`;
    await gate.check(request, { args: { command, workdir: nested } });
    if (process.platform !== "win32") {
      await exec("bash", ["-c", command], { cwd: nested });
      assert.equal(await readFile(join(nested, "result.txt"), "utf8"), "ready");
    }
    assert.equal(await readFile(outside, "utf8"), "outside preserved\n");
    await assert.rejects(gate.check(request, { args: { command: `rm ${sink}` } }), /project-root-relative path required|manifest write scope/);
  } finally { await rm(area, { recursive: true, force: true }); }
});
