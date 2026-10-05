import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import { protectedSnapshot, refreshProtectedSnapshot } from "../dist/plugin/protected-snapshot.js";

test("validation snapshots recover from an unlistable junction alias through its readable physical target", async t => {
  await fs.mkdir(resolve("_testenv"), { recursive: true });
  const root = await fs.mkdtemp(resolve("_testenv/junction-validation-"));
  const original = fs.readdir;
  try {
    const target = join(root, "profile", "IE"), alias = join(root, "profile", "Content.IE5");
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(join(target, "cached.txt"), "original bytes");
    await fs.symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
    await fs.writeFile(join(root, "source.txt"), "source");
    const manifestPath = join(root, "manifest.json");
    const manifest = JSON.stringify({ version: "0.1.0", task_id: "unit", read: ["source.txt"],
      write: ["profile/**"], validation: ["node check.mjs"] });
    await fs.writeFile(manifestPath, manifest);
    // Model the actual Windows compatibility-junction failure: alias enumeration is
    // denied, while realpath, readlink, metadata and physical target reads succeed.
    t.mock.method(fs, "readdir", async (...args: Parameters<typeof fs.readdir>) => {
      if (resolve(String(args[0])) === alias) throw Object.assign(new Error("alias enumeration denied"), { code: "EPERM" });
      return Reflect.apply(original, fs, args);
    });
    syncBuiltinESMExports();
    const pinned = await protectedSnapshot({ projectRoot: root, manifestPath,
      manifestHash: createHash("sha256").update(manifest).digest("hex") });
    assert.ok(pinned, "native validation must acquire a binding without rerunning the command");
    assert.deepEqual(await refreshProtectedSnapshot(root, pinned.binding), { source: pinned.source, candidate: pinned.candidate });
    await fs.writeFile(join(target, "cached.txt"), "changed bytes");
    const changed = await refreshProtectedSnapshot(root, pinned.binding);
    assert.ok(changed);
    assert.notEqual(changed.source, pinned.source, "physical target bytes remain bound");
    assert.notEqual(changed.candidate, pinned.candidate);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});
