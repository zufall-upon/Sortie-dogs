import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import test from "node:test";
import { createProjectPaths, createWriteGate } from "../dist/plugin/gate.js";

test("known shell output gate resolves explicit workdir against native Location", async () => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const directory = await mkdtemp(resolve("_testenv/shell-workdir-"));
  try {
    await mkdir(join(directory, "nested"));
    const gate = await createWriteGate(await createProjectPaths(directory), {
      version: "0.1.0", task_id: "shell-workdir", read: [], write: ["nested/result.txt"], validation: ["node check.mjs > outside.txt"],
    });
    const request = { tool: "shell", sessionID: "author", callID: "workdir-call" };
    for (const workdir of ["nested", join(directory, "nested")]) {
      await gate.check(request, { args: { command: "printf x > result.txt", workdir } }, { investigativeShell: true });
      await gate.check(request, { args: { command: "cp input.txt result.txt", workdir } });
      await assert.rejects(gate.check(request, { args: { command: "printf x > outside.txt", workdir } }, { investigativeShell: true }), /manifest write scope/);
      await assert.rejects(gate.check(request, { args: { command: "node check.mjs > outside.txt", workdir } }, { investigativeShell: true }), /manifest write scope/,
        "declared text in another cwd has no formal-check path bypass");
      await assert.rejects(gate.check(request, { args: { command: "printf x > ../result.txt", workdir } }, { investigativeShell: true }), /project-root-relative path required/);
    }
    // An absolute target remains absolute, independent of the cwd.
    await gate.check(request, { args: { command: `printf x > '${join(directory, "nested/result.txt")}'`, workdir: directory } });
    await assert.rejects(gate.check(request, { args: { command: "printf x > result.txt" } }, { investigativeShell: true }), /manifest write scope/);
    const nestedProjectGate = await createWriteGate(await createProjectPaths(join(directory, "nested")), {
      version: "0.1.0", task_id: "nested-project-workdir", read: [], write: ["result.txt"], validation: [],
    }, directory);
    await nestedProjectGate.check(request, { args: { command: "printf x > result.txt", workdir: "nested" } });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
