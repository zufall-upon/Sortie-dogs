import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/**
 * An App Execution Alias is a reparse entry, not permission to traverse its target.
 * The payload and file IDs are used only as an identity fingerprint. They do not
 * prove package ownership or make a later path-based operation atomic.
 */
export interface AppExecLinkIdentity {
  readonly canonicalEntry: string;
  readonly parentDevice: string;
  readonly parentFile: string;
  readonly entryDevice: string;
  readonly entryFile: string;
  readonly entryMode: string;
  readonly entrySize: string;
  readonly entryChange: string;
  readonly entryModified: string;
  readonly linkHash: string;
  readonly reparseHash: string;
  readonly reparseLength: number;
}

// The path arrives over stdin, never in a command line. The complete reparse
// buffer stays inside the native child/host process and is never logged.
const INSPECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class SortieAppExecEntry {
    [StructLayout(LayoutKind.Sequential)]
    public struct FileTime { public uint Low; public uint High; }
    [StructLayout(LayoutKind.Sequential)]
    public struct Info {
        public uint Attributes;
        public FileTime Creation;
        public FileTime Access;
        public FileTime Write;
        public uint Volume;
        public uint SizeHigh;
        public uint SizeLow;
        public uint Links;
        public uint IndexHigh;
        public uint IndexLow;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security,
        uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DeviceIoControl(SafeFileHandle handle, uint code, IntPtr input, uint inputSize,
        byte[] output, uint outputSize, out uint returned, IntPtr overlapped);
    public sealed class Result {
        public bool ok;
        public string volume;
        public string file;
        public string data;
    }
    static bool Same(Info a, Info b) {
        return a.Volume == b.Volume && a.IndexHigh == b.IndexHigh && a.IndexLow == b.IndexLow
            && a.Attributes == b.Attributes && a.SizeHigh == b.SizeHigh && a.SizeLow == b.SizeLow
            && a.Creation.High == b.Creation.High && a.Creation.Low == b.Creation.Low
            && a.Write.High == b.Write.High && a.Write.Low == b.Write.Low;
    }
    public static Result Inspect(string path) {
        var result = new Result();
        using (var handle = CreateFileW(path, 0, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
            if (handle.IsInvalid) return result;
            Info before, after;
            if (!GetFileInformationByHandle(handle, out before) ||
                (before.IndexHigh == 0 && before.IndexLow == 0)) return result;
            byte[] a = new byte[16384], b = new byte[16384];
            uint n, m;
            if (!DeviceIoControl(handle, 0x000900A8, IntPtr.Zero, 0, a, (uint)a.Length, out n, IntPtr.Zero) ||
                !DeviceIoControl(handle, 0x000900A8, IntPtr.Zero, 0, b, (uint)b.Length, out m, IntPtr.Zero) ||
                !GetFileInformationByHandle(handle, out after) || !Same(before, after) || n != m ||
                n < 8 || n > a.Length) return result;
            for (uint i = 0; i < n; i++) if (a[i] != b[i]) return result;
            result.volume = before.Volume.ToString();
            result.file = (((ulong)before.IndexHigh << 32) | before.IndexLow).ToString();
            result.data = Convert.ToBase64String(a, 0, (int)n);
            result.ok = true;
            return result;
        }
    }
}
'@
    $path = [Console]::In.ReadToEnd()
    $result = [SortieAppExecEntry]::Inspect($path)
    [Console]::Out.Write(($result | ConvertTo-Json -Compress))
} catch {
    [Console]::Out.Write('{"ok":false}')
}
`;

type NativeIdentity = { ok: true; volume: string; file: string; reparseHash: string; reparseLength: number };

/** Validate the complete supported AppExecLink buffer without exposing its strings. */
export function appExecLinkBufferDigest(input: Uint8Array): { hash: string; length: number } | undefined {
  const bytes = Buffer.from(input);
  if (bytes.length < 14 || bytes.length > 16384 || bytes.readUInt32LE(0) !== 0x8000001b ||
      bytes.readUInt16LE(4) + 8 !== bytes.length || bytes.readUInt32LE(8) !== 3 ||
      (bytes.length - 12) % 2 !== 0) return undefined;
  let fields = 0, fieldLength = 0;
  for (let offset = 12; offset < bytes.length; offset += 2) {
    const char = bytes.readUInt16LE(offset);
    if (char === 0) {
      if (fieldLength === 0) return undefined;
      fields++;
      fieldLength = 0;
      continue;
    }
    if (char >= 0xd800 && char <= 0xdbff) {
      if (offset + 3 >= bytes.length) return undefined;
      const low = bytes.readUInt16LE(offset + 2);
      if (low < 0xdc00 || low > 0xdfff) return undefined;
      offset += 2;
    } else if (char >= 0xdc00 && char <= 0xdfff) return undefined;
    fieldLength++;
  }
  if (fields !== 4 || fieldLength !== 0) return undefined;
  return { hash: createHash("sha256").update(bytes).digest("hex"), length: bytes.length };
}

async function nativeIdentity(path: string): Promise<NativeIdentity | undefined> {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) return undefined;
  const executable = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const encoded = Buffer.from(INSPECT_SCRIPT, "utf16le").toString("base64");
  return await new Promise(resolveResult => {
    const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "", settled = false;
    const finish = (value?: NativeIdentity) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveResult(value);
    };
    // PowerShell startup and Add-Type compilation can be slow on loaded Windows hosts.
    const timeout = setTimeout(() => { child.kill(); finish(); }, 30_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (part: string) => {
      output += part;
      if (output.length > 32768) { child.kill(); finish(); }
    });
    child.on("error", () => finish());
    child.stdin.on("error", () => { child.kill(); finish(); });
    child.on("close", code => {
      if (code !== 0) return finish();
      try {
        const value = JSON.parse(output) as { ok?: unknown; volume?: unknown; file?: unknown; data?: unknown };
        if (value.ok !== true || typeof value.volume !== "string" || !/^\d+$/u.test(value.volume) ||
            typeof value.file !== "string" || !/^[1-9]\d*$/u.test(value.file) ||
            typeof value.data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.data)) return finish();
        const buffer = Buffer.from(value.data, "base64"), parsed = appExecLinkBufferDigest(buffer);
        if (!parsed || buffer.toString("base64") !== value.data) return finish();
        finish({ ok: true, volume: value.volume, file: value.file, reparseHash: parsed.hash, reparseLength: parsed.length });
      } catch { finish(); }
    });
    child.stdin.end(path, "utf8");
  });
}

/** Inspect only an exact, currently existing AppExecLink; never follow its target. */
export async function inspectAppExecLink(path: string): Promise<AppExecLinkIdentity | undefined> {
  if (process.platform !== "win32" || !isAbsolute(path)) return undefined;
  try {
    const absolute = resolve(path), parentBefore = await realpath(dirname(absolute));
    const parentStatBefore = await stat(parentBefore, { bigint: true });
    const before = await lstat(absolute, { bigint: true });
    if (!before.isSymbolicLink() || before.ino === 0n || parentStatBefore.ino === 0n) return undefined;
    const linkBefore = await readlink(absolute), native = await nativeIdentity(absolute);
    if (!native || native.volume !== String(before.dev) || native.file !== String(before.ino)) return undefined;
    const after = await lstat(absolute, { bigint: true }), linkAfter = await readlink(absolute);
    const parentAfter = await realpath(dirname(absolute)), parentStatAfter = await stat(parentAfter, { bigint: true });
    if (!after.isSymbolicLink() || parentBefore.toLowerCase() !== parentAfter.toLowerCase() ||
        parentStatBefore.dev !== parentStatAfter.dev || parentStatBefore.ino !== parentStatAfter.ino ||
        before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode ||
        before.size !== after.size || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs ||
        linkBefore !== linkAfter) return undefined;
    return Object.freeze({
      canonicalEntry: resolve(parentBefore, basename(absolute)).toLowerCase(),
      parentDevice: String(parentStatBefore.dev), parentFile: String(parentStatBefore.ino),
      entryDevice: String(before.dev), entryFile: String(before.ino), entryMode: String(before.mode),
      entrySize: String(before.size), entryChange: String(before.ctimeNs), entryModified: String(before.mtimeNs),
      linkHash: createHash("sha256").update(linkBefore).digest("hex"),
      reparseHash: native.reparseHash, reparseLength: native.reparseLength,
    });
  } catch { return undefined; }
}

export function sameAppExecLink(left: AppExecLinkIdentity, right: AppExecLinkIdentity): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** A prior entry pin remains restrictive after removal, but not after replacement. */
export async function pinnedAppExecLinkMatchesOrIsMissing(path: string, pinned: AppExecLinkIdentity): Promise<boolean> {
  try {
    try { await lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      const parent = await realpath(dirname(path)), info = await stat(parent, { bigint: true });
      return resolve(parent, basename(path)).toLowerCase() === pinned.canonicalEntry &&
        String(info.dev) === pinned.parentDevice && String(info.ino) === pinned.parentFile;
    }
    const current = await inspectAppExecLink(path);
    return current !== undefined && sameAppExecLink(pinned, current);
  } catch { return false; }
}
