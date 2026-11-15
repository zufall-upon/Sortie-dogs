import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

test("snapshot inventory hides Git subprocesses without changing tracked inputs or failure fallback", async t => {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(resolve("_testenv/snapshot-process-"));
  const nested = join(root, "nested");
  const original = childProcess.execFile;
  const calls: Array<{ file: string; args: string[]; options: childProcess.ExecFileOptions }> = [];
  let failure: Error | null = null;
  childProcess.execFile = ((file: string, args: string[], options: childProcess.ExecFileOptions,
    callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    calls.push({ file, args: [...args], options });
    if (args.includes("--stage")) callback(null, "", "");
    else callback(failure, options.cwd === root ? "root source.txt\0" : "nested source.txt\0", "");
    return {} as childProcess.ChildProcess;
  }) as typeof childProcess.execFile;
  // execFile's custom promisifier returns both streams, unlike a generic callback wrapper.
  Object.defineProperty(childProcess.execFile, promisify.custom, {
    value: (file: string, args: string[], options: childProcess.ExecFileOptions) =>
      new Promise((resolve, reject) => childProcess.execFile(file, args, options, (error, stdout, stderr) =>
        error ? reject(error) : resolve({ stdout, stderr }))),
  });
  syncBuiltinESMExports();
  try {
    await mkdir(join(nested, ".git"), { recursive: true });
    await writeFile(join(root, "output.txt"), "synthetic output");
    const { currentSnapshotProtection } = await import("../../dist/plugin/protected-snapshot.js");
    const manifest = { read: ["nested/**"], write: ["output.txt", "missing.txt"] };
    const assertCalls = () => {
      const inventory = calls.filter(call => !call.args.includes("--stage"));
      const safety = calls.filter(call => call.args.includes("--stage"));
      assert.equal(inventory.length, 2, "query both the Location and its declared nested repository");
      assert.deepEqual(inventory.map(call => call.options.cwd).sort(), [root, nested].sort());
      assert.equal(safety.length, 1, "check whether the nested repository is a tracked submodule");
      for (const call of calls) {
        assert.equal(call.file, "git");
        assert.equal(call.options.windowsHide, true, "background inventory must not open a Windows console");
        assert.equal(call.options.maxBuffer, 16 * 1024 * 1024);
        assert.equal(call.options.shell, undefined, "keep direct execution rather than introducing a shell");
      }
      for (const call of inventory) assert.deepEqual(call.args, ["-c", "core.fsmonitor=false", "ls-files", "-z"]);
    };
    await t.test("successful queries retain tracked paths and materialized outputs", async () => {
      const result = await currentSnapshotProtection(root, manifest, "nested");
      assertCalls();
      assert.deepEqual(result.sort(), [
        nested, join(root, "root source.txt"), join(nested, "nested source.txt"), join(root, "output.txt"),
      ].sort());
    });
    await t.test("failed queries retain the existing declared-path fallback", async () => {
      calls.length = 0;
      failure = new Error("synthetic Git failure");
      const result = await currentSnapshotProtection(root, manifest, "nested");
      assertCalls();
      assert.deepEqual(result.sort(), [nested, join(root, "output.txt")].sort());
    });
  } finally {
    childProcess.execFile = original;
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});
