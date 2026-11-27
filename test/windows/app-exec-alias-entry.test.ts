import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { canonicalManifestWriteScopes, createProjectPaths, createWriteGate, writeScopesOverlap } from "../../dist/plugin/gate.js";
import { declaredArtifacts } from "../../dist/plugin/declared-artifacts.js";
import { protectedSnapshot, refreshProtectedSnapshot } from "../../dist/plugin/protected-snapshot.js";
import { inspectAppExecLink } from "../../dist/plugin/windows-app-exec-link.js";

const exec = promisify(childProcess.execFile);

function fakePayload(value: string): Buffer {
  const strings = Buffer.from(["package", "app", value, "display"].map(part => `${part}\0`).join(""), "utf16le");
  const bytes = Buffer.alloc(12 + strings.length);
  bytes.writeUInt32LE(0x8000001b, 0); bytes.writeUInt16LE(bytes.length - 8, 4); bytes.writeUInt32LE(3, 8);
  strings.copy(bytes, 12);
  return bytes;
}

test("Windows AppExecLink exact-entry authorization and strict evidence", async t => {
  if (!process.env.LOCALAPPDATA || !process.env.SystemRoot) return t.skip("Windows alias fixture unavailable");
  const alias = join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps", "python.exe");
  try {
    const fsutil = join(process.env.SystemRoot, "System32", "fsutil.exe");
    const observed = await exec(fsutil, ["reparsepoint", "query", alias], { windowsHide: true });
    if (!/0x8000001b/iu.test(observed.stdout)) return t.skip("OS AppExecLink fixture unavailable");
  } catch { return t.skip("OS AppExecLink fixture unavailable"); }

  await fs.mkdir(resolve("_testenv"), { recursive: true });
  const root = await fs.mkdtemp(resolve("_testenv/app-exec-entry-"));
  try {
    const childObservation = { started: false, killed: false, spawnError: false };
    const originalSpawn = childProcess.spawn;
    const observedSpawn = t.mock.method(childProcess, "spawn", ((file: string, args: readonly string[], options: unknown) => {
      const child = Reflect.apply(originalSpawn, childProcess, [file, args, options]) as ReturnType<typeof childProcess.spawn>;
      if (file.toLowerCase().endsWith("powershell.exe")) {
        childObservation.started = true;
        child.once("error", () => { childObservation.spawnError = true; });
        const originalKill = child.kill;
        child.kill = function (...killArgs: Parameters<typeof child.kill>) {
          childObservation.killed = true;
          return Reflect.apply(originalKill, this, killArgs);
        };
      }
      return child;
    }) as typeof childProcess.spawn);
    syncBuiltinESMExports();
    let identity;
    try { identity = await inspectAppExecLink(alias); }
    finally { observedSpawn.mock.restore(); syncBuiltinESMExports(); }
    assert.ok(identity, `an independently identified OS fixture must be readable (${JSON.stringify(childObservation)})`);
    const manifest = { version: "0.1.0", task_id: "app-exec-entry", read: [], write: [alias], validation: [] };
    const project = await createProjectPaths(root), pins = new Map();
    const scopes = await canonicalManifestWriteScopes(project, manifest, pins);
    assert.deepEqual(scopes, [identity.canonicalEntry]);
    assert.equal(pins.size, 1);
    assert.equal(writeScopesOverlap(scopes, [(await fs.realpath(dirname(alias))).toLowerCase()]), true);
    await assert.rejects(canonicalManifestWriteScopes(project, { ...manifest, write: [alias + "/**"] }));
    const gate = await createWriteGate(project, manifest, root, undefined, pins);
    const posixPath = alias.replaceAll("\\", "/");
    assert.ok(!posixPath.includes("'"));
    const check = (command: string) => gate.check({ tool: "bash", sessionID: "fixture", callID: "entry" },
      { args: { command } }, { investigativeShell: true });
    // These are gate checks only. Neither command is executed.
    await check(`rm -- '${posixPath}'`);
    await assert.rejects(check(`rm -- '${posixPath}/'`));
    const checkWindowsShell = (command: string) => gate.check({ tool: "shell", sessionID: "fixture", callID: "entry" },
      { args: { command } }, { investigativeShell: true });
    await checkWindowsShell(`Remove-Item -LiteralPath '${alias}' -Force`);
    await checkWindowsShell(`rm '${alias}'`);
    await assert.rejects(checkWindowsShell(`Remove-Item -LiteralPath '${alias}' -Recurse`));
    await assert.rejects(checkWindowsShell(`Remove-Item -LiteralPath '${alias}\\child'`));
    await assert.rejects(checkWindowsShell(`Remove-Item -LiteralPath '${await fs.readlink(alias)}'`));
    await assert.rejects(gate.checkPath(alias));
    await assert.rejects(gate.checkPath(await fs.readlink(alias)));
    await assert.rejects(gate.checkPath(join(alias, "child")));

    const direct = await declaredArtifacts([alias], 1024);
    assert.equal(direct.entries.length, 1);
    assert.equal(direct.entries[0]![1], "app-execution-alias:entry");
    assert.match(direct.entries[0]![2]!, /^[a-f0-9]{64}$/u);
    assert.match(direct.excerpt, /entry metadata fingerprinted; target not followed/);

    await t.test("slow inspection may finish after 15 seconds but a hung child is stopped", async sub => {
      const originalSpawn = childProcess.spawn;
      let started!: () => void;
      let ready = new Promise<void>(resolveReady => { started = resolveReady; });
      let hang = false, killed = false;
      sub.mock.timers.enable({ apis: ["setTimeout"] });
      const fake = sub.mock.method(childProcess, "spawn", ((file: string, args: readonly string[], options: unknown) => {
        if (!file.toLowerCase().endsWith("powershell.exe")) return Reflect.apply(originalSpawn, childProcess, [file, args, options]);
        const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; kill: () => boolean };
        child.stdin = new PassThrough(); child.stdout = new PassThrough();
        child.kill = () => { killed = true; return true; };
        child.stdin.on("finish", () => {
          if (!hang) setTimeout(() => {
            child.stdout.end(JSON.stringify({ ok: true, volume: identity.entryDevice, file: identity.entryFile,
              data: fakePayload("slow-target").toString("base64") }));
            setImmediate(() => child.emit("close", 0));
          }, 16_000);
          started();
        });
        return child;
      }) as typeof childProcess.spawn);
      syncBuiltinESMExports();
      try {
        const slow = inspectAppExecLink(alias);
        await ready;
        sub.mock.timers.tick(16_000);
        assert.ok(await slow, "valid inspection is not rejected at the former 15-second limit");
        assert.equal(killed, false);

        hang = true;
        ready = new Promise<void>(resolveReady => { started = resolveReady; });
        const stalled = inspectAppExecLink(alias);
        await ready;
        sub.mock.timers.tick(30_000);
        assert.equal(await stalled, undefined);
        assert.equal(killed, true, "a stalled inspector remains bounded and fails closed");
      } finally {
        fake.mock.restore(); syncBuiltinESMExports(); sub.mock.timers.reset();
      }
    });

    const manifestPath = join(root, "manifest.json"), bytes = Buffer.from(JSON.stringify(manifest));
    await fs.writeFile(manifestPath, bytes);
    const pinned = await protectedSnapshot({ projectRoot: root, manifestPath,
      manifestHash: createHash("sha256").update(bytes).digest("hex") }, { captureFreshness: false });
    assert.ok(pinned);
    assert.deepEqual(await refreshProtectedSnapshot(root, pinned.binding), { source: pinned.source, candidate: pinned.candidate });

    await t.test("a leaf or parent identity change denies the entry operation", async () => {
      const originalLstat = fs.lstat;
      const leaf = t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
        const result = await Reflect.apply(originalLstat, fs, args);
        if (resolve(String(args[0])) === resolve(alias) && typeof result.ino === "bigint") {
          Object.defineProperty(result, "ino", { value: result.ino + 1n });
        }
        return result;
      });
      syncBuiltinESMExports();
      try {
        await assert.rejects(check(`rm -- '${posixPath}'`));
        await assert.rejects(canonicalManifestWriteScopes(project, manifest, new Map(pins)));
        await assert.rejects(createWriteGate(project, manifest, root, undefined, pins));
      }
      finally { leaf.mock.restore(); syncBuiltinESMExports(); }

      const originalStat = fs.stat, parent = await fs.realpath(dirname(alias));
      const parentMock = t.mock.method(fs, "stat", async (...args: Parameters<typeof fs.stat>) => {
        const result = await Reflect.apply(originalStat, fs, args);
        if (resolve(String(args[0])).toLowerCase() === parent.toLowerCase() && typeof result.ino === "bigint") {
          Object.defineProperty(result, "ino", { value: result.ino + 1n });
        }
        return result;
      });
      syncBuiltinESMExports();
      try { await assert.rejects(check(`rm -- '${posixPath}'`)); }
      finally { parentMock.mock.restore(); syncBuiltinESMExports(); }
    });

    await t.test("changed or incomplete reparse data cannot authorize or silently fingerprint the entry", async () => {
      const originalSpawn = childProcess.spawn;
      let responses: Buffer[] = [];
      const fake = t.mock.method(childProcess, "spawn", ((file: string, args: readonly string[], options: unknown) => {
        if (!file.toLowerCase().endsWith("powershell.exe")) return Reflect.apply(originalSpawn, childProcess, [file, args, options]);
        const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; kill: () => boolean };
        child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kill = () => true;
        child.stdin.on("finish", () => {
          const data = responses.shift() ?? Buffer.alloc(0);
          child.stdout.end(JSON.stringify({ ok: true, volume: identity.entryDevice, file: identity.entryFile, data: data.toString("base64") }));
          setImmediate(() => child.emit("close", 0));
        });
        return child;
      }) as typeof childProcess.spawn);
      syncBuiltinESMExports();
      try {
        responses = [fakePayload("different-target")];
        await assert.rejects(check(`rm -- '${posixPath}'`));
        responses = [fakePayload("different-target")];
        await assert.rejects(canonicalManifestWriteScopes(project, manifest, new Map(pins)));
        responses = [Buffer.alloc(7)];
        await assert.rejects(check(`rm -- '${posixPath}'`));
        responses = [fakePayload("first"), fakePayload("second")];
        await assert.rejects(declaredArtifacts([alias]), /declared-artifact-entry-changed/);
      } finally { fake.mock.restore(); syncBuiltinESMExports(); }
    });

    await t.test("an entry lost during capture fails; a later confirmed absence changes the snapshot", async () => {
      const originalLstat = fs.lstat;
      let count = 0;
      const disappearing = t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
        if (resolve(String(args[0])) === resolve(alias) && ++count === 3) throw Object.assign(new Error("fixture"), { code: "ENOENT" });
        return await Reflect.apply(originalLstat, fs, args);
      });
      syncBuiltinESMExports();
      try { await assert.rejects(declaredArtifacts([alias]), /declared-artifact-entry-changed/); }
      finally { disappearing.mock.restore(); syncBuiltinESMExports(); }

      const originalRealpath = fs.realpath;
      const missingRealpath = t.mock.method(fs, "realpath", async (...args: Parameters<typeof fs.realpath>) => {
        if (resolve(String(args[0])) === resolve(alias)) throw Object.assign(new Error("fixture"), { code: "ENOENT" });
        return await Reflect.apply(originalRealpath, fs, args);
      });
      const missingLstat = t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
        if (resolve(String(args[0])) === resolve(alias)) throw Object.assign(new Error("fixture"), { code: "ENOENT" });
        return await Reflect.apply(originalLstat, fs, args);
      });
      syncBuiltinESMExports();
      try {
        const missing = await declaredArtifacts([alias]);
        assert.equal(missing.entries[0]![1], "missing");
        assert.deepEqual(await canonicalManifestWriteScopes(project, manifest, new Map(pins)), scopes);
        const rebound = await createWriteGate(project, manifest, root, undefined, pins);
        await assert.rejects(rebound.checkPath(alias), "a missing former alias does not become a writable regular file");
        const changed = await refreshProtectedSnapshot(root, pinned.binding);
        assert.ok(changed);
        assert.notEqual(changed.source, pinned.source);
        assert.notEqual(changed.candidate, pinned.candidate);
      } finally { missingRealpath.mock.restore(); missingLstat.mock.restore(); syncBuiltinESMExports(); }
    });
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});
