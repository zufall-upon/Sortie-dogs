import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join, resolve, sep } from "node:path";
import type {
  ParallelDispatchDescriptor,
  ContainedValidationRequest,
  ContainedValidationResult,
  WorktreeCommitArtifact,
  WorktreeCommitProduceRequest,
  WorktreeCommitValidationEvidence,
  WorktreeCommitVerifyRequest,
} from "./types.js";
import { normalizeWorktreeScopePath } from "./worktree-scope.js";

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_PATH = 4096;
const MAX_ARGUMENTS = 128;
const MAX_COMMAND_TEXT = 1000;
const MAX_OUTPUT = 1024 * 1024;
const MAX_TIMEOUT = 10 * 60_000;
const GIT_TIMEOUT = 30_000;
const EXIT_GRACE = 500;
const KILL_WAIT = 2_000;
const WINDOWS_WRAPPER_GRACE = 15_000;
const LINUX_WRAPPER_GRACE = 10_000;
const MAX_WRAPPER_PAYLOAD = 512 * 1024;
const WINDOWS_JOB_WRAPPER = String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class SortieJobRunner {
  const uint CREATE_SUSPENDED = 0x00000004;
  const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
  const uint STARTF_USESTDHANDLES = 0x00000100;
  const uint STARTF_USESHOWWINDOW = 0x00000001;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  const uint PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
  const uint DUPLICATE_SAME_ACCESS = 0x00000002;
  const uint GENERIC_READ = 0x80000000;
  const uint FILE_SHARE_READ = 1;
  const uint FILE_SHARE_WRITE = 2;
  const uint OPEN_EXISTING = 3;
  const uint WAIT_OBJECT_0 = 0;
  const uint WAIT_TIMEOUT = 258;
  const int VALIDATION_TIMEOUT = 238;
  const int SETUP_FAILURE = 240;
  const int DESCENDANTS_FOUND = 241;

  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES {
    public int nLength; public IntPtr lpSecurityDescriptor; [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
  }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
    public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
    public int cb; public string lpReserved, lpDesktop, lpTitle; public uint dwX, dwY, dwXSize, dwYSize;
    public uint dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION {
    public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId;
  }

  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION i, uint l);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr j, int c, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION i, uint l, IntPtr r);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr j, uint c);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sp, IntPtr sh, IntPtr tp, out IntPtr th, uint a, bool inherit, uint o);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateFile(string n, uint a, uint s, ref SECURITY_ATTRIBUTES sa, uint d, uint f, IntPtr t);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr l, int c, int f, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr l, uint f, UIntPtr a, IntPtr v, IntPtr s, IntPtr p, IntPtr r);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr l);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcess(
    string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd,
    ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr p, out uint c);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr p, uint c);

  static void Check(bool ok) { if (!ok) throw new InvalidOperationException(); }
  static bool Invalid(IntPtr h) { return h == IntPtr.Zero || h == new IntPtr(-1); }
  static string Quote(string value) {
    if (value.Length == 0) return "\"\"";
    bool quote = false;
    foreach (char ch in value) if (ch == ' ' || ch == '\t' || ch == '"') { quote = true; break; }
    if (!quote) return value;
    StringBuilder result = new StringBuilder("\"");
    int slashes = 0;
    foreach (char ch in value) {
      if (ch == '\\') { slashes++; continue; }
      if (ch == '"') { result.Append('\\', slashes * 2 + 1); result.Append(ch); slashes = 0; continue; }
      result.Append('\\', slashes); slashes = 0; result.Append(ch);
    }
    result.Append('\\', slashes * 2); result.Append('"');
    return result.ToString();
  }
  static IntPtr EnvironmentBlock(string[] entries) {
    Array.Sort(entries, StringComparer.OrdinalIgnoreCase);
    HashSet<string> names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    int length = 1;
    foreach (string entry in entries) {
      int equals = entry.IndexOf('=');
      if (equals < 1 || entry.IndexOf('\0') >= 0 || !names.Add(entry.Substring(0, equals))) throw new InvalidOperationException();
      length += entry.Length + 1;
    }
    if (length > 32767) throw new InvalidOperationException();
    return Marshal.StringToHGlobalUni(String.Join("\0", entries) + "\0\0");
  }
  static IntPtr DuplicateStandard(int id) {
    IntPtr source = GetStdHandle(id), copy;
    if (Invalid(source)) throw new InvalidOperationException();
    Check(DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), out copy, 0, true, DUPLICATE_SAME_ACCESS));
    return copy;
  }
  static JOBOBJECT_BASIC_ACCOUNTING_INFORMATION Accounting(IntPtr job) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION value;
    Check(QueryInformationJobObject(job, 1, out value, (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero));
    return value;
  }

  public static int Run(string executable, string[] args, string cwd, string[] environment, int timeout) {
    IntPtr job = IntPtr.Zero, attributes = IntPtr.Zero, handleList = IntPtr.Zero, environmentBlock = IntPtr.Zero;
    IntPtr stdin = IntPtr.Zero, stdout = IntPtr.Zero, stderr = IntPtr.Zero;
    PROCESS_INFORMATION process = new PROCESS_INFORMATION();
    try {
      if (String.IsNullOrEmpty(executable) || String.IsNullOrEmpty(cwd) || args == null || environment == null || timeout < 1 || timeout > 600000) throw new InvalidOperationException();
      job = CreateJobObject(IntPtr.Zero, null);
      if (Invalid(job)) throw new InvalidOperationException();
      JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))));

      SECURITY_ATTRIBUTES security = new SECURITY_ATTRIBUTES();
      security.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)); security.bInheritHandle = true;
      stdin = CreateFile("NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, ref security, OPEN_EXISTING, 0, IntPtr.Zero);
      if (Invalid(stdin)) throw new InvalidOperationException();
      stdout = DuplicateStandard(-11); stderr = DuplicateStandard(-12);

      IntPtr attributeSize = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
      if (attributeSize == IntPtr.Zero) throw new InvalidOperationException();
      attributes = Marshal.AllocHGlobal(attributeSize);
      Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref attributeSize));
      handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
      Marshal.WriteIntPtr(handleList, 0, stdin); Marshal.WriteIntPtr(handleList, IntPtr.Size, stdout); Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, stderr);
      Check(UpdateProcThreadAttribute(attributes, 0, new UIntPtr(PROC_THREAD_ATTRIBUTE_HANDLE_LIST), handleList,
        new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero));

      STARTUPINFOEX startup = new STARTUPINFOEX();
      startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
      startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
      startup.StartupInfo.hStdInput = stdin; startup.StartupInfo.hStdOutput = stdout; startup.StartupInfo.hStdError = stderr;
      environmentBlock = EnvironmentBlock(environment);
      StringBuilder command = new StringBuilder(Quote(executable));
      foreach (string arg in args) { if (arg == null) throw new InvalidOperationException(); command.Append(' ').Append(Quote(arg)); }
      Check(CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true,
        CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
        environmentBlock, cwd, ref startup, out process));
      Check(AssignProcessToJobObject(job, process.hProcess));
      if (ResumeThread(process.hThread) == UInt32.MaxValue) throw new InvalidOperationException();
      CloseHandle(process.hThread); process.hThread = IntPtr.Zero;
      uint wait = WaitForSingleObject(process.hProcess, (uint)timeout);
      if (wait == WAIT_TIMEOUT) {
        Check(TerminateJobObject(job, VALIDATION_TIMEOUT));
        if (WaitForSingleObject(process.hProcess, 2000) != WAIT_OBJECT_0) throw new InvalidOperationException();
        return VALIDATION_TIMEOUT;
      }
      if (wait != WAIT_OBJECT_0) throw new InvalidOperationException();
      uint exitCode; Check(GetExitCodeProcess(process.hProcess, out exitCode));
      CloseHandle(process.hProcess); process.hProcess = IntPtr.Zero;
      if (Accounting(job).ActiveProcesses != 0) {
        Check(TerminateJobObject(job, DESCENDANTS_FOUND));
        Stopwatch descendantWait = Stopwatch.StartNew();
        while (Accounting(job).ActiveProcesses != 0 && descendantWait.ElapsedMilliseconds < 2000) Thread.Sleep(10);
        if (Accounting(job).ActiveProcesses != 0) throw new InvalidOperationException();
        return DESCENDANTS_FOUND;
      }
      return exitCode == 0 ? 0 : 239;
    } catch {
      if (!Invalid(job)) TerminateJobObject(job, SETUP_FAILURE);
      if (!Invalid(process.hProcess)) TerminateProcess(process.hProcess, SETUP_FAILURE);
      return SETUP_FAILURE;
    } finally {
      if (!Invalid(process.hThread)) CloseHandle(process.hThread);
      if (!Invalid(process.hProcess)) CloseHandle(process.hProcess);
      if (attributes != IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
      if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
      if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
      if (!Invalid(stdin)) CloseHandle(stdin); if (!Invalid(stdout)) CloseHandle(stdout); if (!Invalid(stderr)) CloseHandle(stderr);
      if (!Invalid(job)) CloseHandle(job);
    }
  }
}
'@
try {
  Add-Type -TypeDefinition $source
  $encoded = [Console]::In.ReadToEnd()
  if ($encoded.Length -eq 0 -or $encoded.Length -gt 524288 -or $encoded -notmatch '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$') { throw 'payload' }
  $bytes = [Convert]::FromBase64String($encoded)
  $json = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
  $payload = $json | ConvertFrom-Json
  $names = @($payload.PSObject.Properties.Name)
  if ($names.Count -ne 5 -or @($names | Where-Object { $_ -notin @('executable','args','cwd','environment','timeout') }).Count -ne 0) { throw 'payload' }
  if (-not ($payload.executable -is [string]) -or -not ($payload.cwd -is [string]) -or -not ($payload.args -is [array]) -or -not ($payload.environment -is [pscustomobject])) { throw 'payload' }
  $arguments = @($payload.args)
  if (@($arguments | Where-Object { -not ($_ -is [string]) }).Count -ne 0) { throw 'payload' }
  $environment = @()
  foreach ($property in $payload.environment.PSObject.Properties) {
    if (-not ($property.Value -is [string])) { throw 'payload' }
    $environment += ($property.Name + '=' + $property.Value)
  }
  exit [SortieJobRunner]::Run($payload.executable, [string[]]$arguments, $payload.cwd, [string[]]$environment, [int]$payload.timeout)
} catch { exit 240 }
`;
const LINUX_NAMESPACE_WRAPPER = String.raw`
"use strict";
const { spawn } = require("node:child_process");
const { readdirSync } = require("node:fs");
const { isAbsolute } = require("node:path");
const MAX_PAYLOAD = 524288;
const MAX_PATH = 4096;
const MAX_ARGUMENTS = 128;
const MAX_ARGUMENT = 1000;
const MAX_TIMEOUT = 600000;
const ENVIRONMENT_KEYS = new Set([
  "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "TMP", "TEMP", "TMPDIR",
  "GIT_TERMINAL_PROMPT", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_OPTIONAL_LOCKS", "GIT_PAGER", "LC_ALL",
]);
const REQUIRED_ENVIRONMENT = {
  GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", LC_ALL: "C",
};
let inputBytes = 0;
const input = [];
let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  process.exit(code);
}
function validText(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
}
function parsePayload() {
  const source = Buffer.concat(input, inputBytes);
  const encoded = source.toString("ascii");
  if (source.length === 0 || source.some((byte) => byte > 0x7f) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) throw new Error();
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new Error();
  const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (payload === null || typeof payload !== "object" || Array.isArray(payload) ||
    Object.getPrototypeOf(payload) !== Object.prototype) throw new Error();
  const keys = Object.keys(payload).sort();
  if (keys.length !== 6 || keys.join("\0") !== "args\0cwd\0environment\0executable\0timeout\0unshare") throw new Error();
  if (!validText(payload.executable, MAX_ARGUMENT) || !isAbsolute(payload.executable) ||
    !validText(payload.unshare, MAX_ARGUMENT) || !isAbsolute(payload.unshare) ||
    !validText(payload.cwd, MAX_PATH) || !isAbsolute(payload.cwd) || !Array.isArray(payload.args) ||
    payload.args.length > MAX_ARGUMENTS || !payload.args.every((value) => validText(value, MAX_ARGUMENT)) ||
    !Number.isInteger(payload.timeout) || payload.timeout < 1 || payload.timeout > MAX_TIMEOUT) throw new Error();
  const suppliedEnvironment = payload.environment;
  if (suppliedEnvironment === null || typeof suppliedEnvironment !== "object" || Array.isArray(suppliedEnvironment) ||
    Object.getPrototypeOf(suppliedEnvironment) !== Object.prototype) throw new Error();
  const environment = Object.create(null);
  let environmentBytes = 0;
  const environmentKeys = Object.keys(suppliedEnvironment);
  if (environmentKeys.length > ENVIRONMENT_KEYS.size) throw new Error();
  for (const key of environmentKeys) {
    const value = suppliedEnvironment[key];
    if (!ENVIRONMENT_KEYS.has(key) || typeof value !== "string" || value.includes("\0")) throw new Error();
    environmentBytes += Buffer.byteLength(key) + Buffer.byteLength(value) + 2;
    if (environmentBytes > 65536) throw new Error();
    environment[key] = value;
  }
  for (const [key, value] of Object.entries(REQUIRED_ENVIRONMENT)) {
    if (environment[key] !== value) throw new Error();
  }
  return { executable: payload.executable, unshare: payload.unshare, args: payload.args,
    cwd: payload.cwd, environment, timeout: payload.timeout };
}
function inspectNamespace() {
  try {
    const entries = readdirSync("/proc", { withFileTypes: true });
    if (entries.length > 65536) return 241;
    for (const entry of entries) {
      if (!/^[1-9][0-9]*$/u.test(entry.name) || entry.name === "1") continue;
      if (!entry.isDirectory()) return 241;
      return 241;
    }
    return 0;
  } catch {
    return 241;
  }
}
function run(payload) {
  if (process.pid !== 1) return finish(240);
  let child;
  try {
    // A nested user namespace removes authority over PID1's mount namespace.
    child = spawn(payload.unshare, ["--user", "--map-current-user", "--", payload.executable, ...payload.args], {
      cwd: payload.cwd, env: payload.environment, shell: false, detached: false, stdio: ["ignore", "inherit", "inherit"],
    });
  } catch {
    return finish(240);
  }
  const timer = setTimeout(() => finish(238), payload.timeout);
  child.once("error", () => { clearTimeout(timer); finish(240); });
  child.once("exit", (code) => {
    clearTimeout(timer);
    const containment = inspectNamespace();
    finish(containment === 0 ? (code === 0 ? 0 : 239) : containment);
  });
}
process.stdin.on("data", (chunk) => {
  inputBytes += chunk.length;
  if (inputBytes > MAX_PAYLOAD) {
    process.stdin.destroy();
    finish(240);
    return;
  }
  input.push(chunk);
});
process.stdin.once("error", () => finish(240));
process.stdin.once("end", () => {
  try { run(parsePayload()); } catch { finish(240); }
});
`;
const DESCRIPTOR_KEYS = [
  "attempt", "base_sha", "branch", "contract_fingerprint", "depends_on", "dispatch_id", "managed_path",
  "parallel_group", "parallel_unit", "parallel_units", "run_id", "scope_read", "scope_write", "task_id",
] as const;

export type WorktreeCommitArtifactErrorCode =
  | "invalid-request"
  | "invalid-state"
  | "validation-failed"
  | "git-failed"
  | "verification-failed";

export class WorktreeCommitArtifactError extends Error {
  readonly code: WorktreeCommitArtifactErrorCode;

  constructor(code: WorktreeCommitArtifactErrorCode, message: string) {
    super(message);
    this.name = "WorktreeCommitArtifactError";
    this.code = code;
  }
}

type StatusEntry = { readonly code: "A" | "M" | "D"; readonly path: string };
type GitObjectEntry = { readonly mode: string; readonly oid: string };
type CommandResult = { readonly code: number; readonly stdout: Buffer };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validText(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}

export async function resolveValidationExecutable(executable: string): Promise<string | undefined> {
  if (isAbsolute(executable)) return realpath(executable).catch(() => undefined);
  if (!validText(executable, MAX_COMMAND_TEXT) || executable.startsWith("-") || /[\\/]/u.test(executable)) return undefined;
  const path = process.env.PATH ?? process.env.Path;
  if (path === undefined) return undefined;
  const extensions = process.platform === "win32" && extname(executable).length === 0
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((value) => value.length > 0)
    : [""];
  for (const directory of path.split(delimiter)) {
    for (const extension of extensions) {
      const candidate = await realpath(resolve(directory || ".", `${executable}${extension}`)).catch(() => undefined);
      if (candidate !== undefined && isAbsolute(candidate)) return candidate;
    }
  }
  return undefined;
}

function pathIdentity(value: string): string {
  const normalized = resolve(value).split(sep).join("/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const names = new Set<string>();
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "TMP", "TEMP", "TMPDIR"]) {
    const identity = process.platform === "win32" ? key.toLowerCase() : key;
    if (process.env[key] !== undefined && !names.has(identity)) {
      env[key] = process.env[key];
      names.add(identity);
    }
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_PAGER = "cat";
  env.LC_ALL = "C";
  return env;
}

async function waitForClose(closed: Promise<unknown>, timeout: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      closed.then(() => true, () => true),
      new Promise<boolean>((done) => { timer = setTimeout(() => done(false), timeout); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function linuxUnshare(): Promise<string> {
  for (const candidate of ["/usr/bin/unshare", "/bin/unshare"]) {
    const canonical = await realpath(candidate).catch(() => undefined);
    if (canonical === undefined || !canonical.startsWith("/usr/bin/") && !canonical.startsWith("/bin/")) continue;
    const info = await lstat(canonical).catch(() => undefined);
    if (info !== undefined && info.isFile() && !info.isSymbolicLink() && info.uid === 0 && (info.mode & 0o111) !== 0) return canonical;
  }
  throw new WorktreeCommitArtifactError("validation-failed", "Validation containment setup failed.");
}

async function terminateTree(child: ChildProcess, closed: Promise<unknown>): Promise<void> {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    const taskkill = join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "taskkill.exe");
    const killer = spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
      env: cleanEnvironment(), shell: false, windowsHide: true, stdio: "ignore",
    });
    const killed = new Promise<boolean>((done) => {
      killer.once("error", () => done(false));
      killer.once("close", (code) => done(code === 0));
    });
    if (!(await waitForClose(killed, KILL_WAIT))) {
      killer.kill();
      throw new WorktreeCommitArtifactError("validation-failed", "Process-tree termination could not be confirmed.");
    }
    if (!(await killed)) throw new WorktreeCommitArtifactError("validation-failed", "Process-tree termination failed.");
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already closed. */ }
    if (!(await waitForClose(closed, EXIT_GRACE))) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already closed. */ }
    }
  }
  if (!(await waitForClose(closed, KILL_WAIT))) {
    throw new WorktreeCommitArtifactError("validation-failed", "Process-tree termination could not be confirmed.");
  }
  if (process.platform !== "win32") {
    const groupGone = async (): Promise<boolean> => {
      const deadline = Date.now() + KILL_WAIT;
      while (Date.now() < deadline) {
        try { process.kill(-child.pid!, 0); } catch { return true; }
        await new Promise((done) => setTimeout(done, 10));
      }
      return false;
    };
    if (!(await groupGone())) {
      throw new WorktreeCommitArtifactError("validation-failed", "Process-tree termination could not be confirmed.");
    }
  }
}

async function runBounded(
  executable: string,
  args: readonly string[],
  cwd: string,
  timeout: number,
  kind: "git" | "validation",
): Promise<CommandResult> {
  const windowsWrapper = kind === "validation" && process.platform === "win32";
  const linuxWrapper = kind === "validation" && process.platform === "linux";
  if (kind === "validation" && !windowsWrapper && !linuxWrapper) {
    throw new WorktreeCommitArtifactError("validation-failed", "Validation containment is unsupported on this platform.");
  }
  const childEnvironment = cleanEnvironment();
  const spawnExecutable = windowsWrapper
    ? join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows",
      "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : linuxWrapper ? await linuxUnshare() : executable;
  const spawnArgs = windowsWrapper
    ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_JOB_WRAPPER]
    : linuxWrapper
      ? ["--user", "--map-current-user", "--pid", "--fork", "--kill-child=KILL", "--mount", "--mount-proc", "--",
        process.execPath, "-e", LINUX_NAMESPACE_WRAPPER]
      : args;
  const wrapperPayload = windowsWrapper || linuxWrapper
    ? Buffer.from(JSON.stringify({ executable, args, cwd, environment: childEnvironment, timeout,
      ...(linuxWrapper ? { unshare: spawnExecutable } : {}) }), "utf8").toString("base64")
    : undefined;
  if (linuxWrapper && wrapperPayload!.length > MAX_WRAPPER_PAYLOAD) {
    throw new WorktreeCommitArtifactError("validation-failed", "Validation containment setup failed.");
  }
  const child = spawn(spawnExecutable, spawnArgs, {
    cwd, env: childEnvironment, shell: false, windowsHide: true,
    detached: process.platform !== "win32", stdio: [windowsWrapper || linuxWrapper ? "pipe" : "ignore", "pipe", "pipe"],
  });
  if (wrapperPayload !== undefined) {
    child.stdin?.once("error", () => undefined);
    child.stdin?.end(wrapperPayload);
  }
  const chunks: Buffer[] = [];
  let outputBytes = 0;
  let overflow = false;
  let timedOut = false;
  const collect = (chunk: Buffer): void => {
    outputBytes += chunk.byteLength;
    if (outputBytes <= MAX_OUTPUT) chunks.push(chunk);
    else overflow = true;
  };
  child.stdout!.on("data", collect);
  child.stderr!.on("data", (chunk: Buffer) => {
    outputBytes += chunk.byteLength;
    if (outputBytes > MAX_OUTPUT) overflow = true;
  });
  const closed = new Promise<{ code: number | null }>((done, reject) => {
    child.once("error", reject);
    child.once("close", (code) => done({ code }));
  });
  let settled = false;
  void closed.then(() => { settled = true; }, () => { settled = true; });
  const outerTimeout = windowsWrapper ? timeout + WINDOWS_WRAPPER_GRACE : linuxWrapper ? timeout + LINUX_WRAPPER_GRACE : timeout;
  const timer = setTimeout(() => { timedOut = true; }, outerTimeout);
  timer.unref();
  try {
    while (!settled && !timedOut && !overflow) {
      await Promise.race([closed, new Promise((done) => setTimeout(done, 10))]);
    }
    if (timedOut || overflow) {
      await terminateTree(child, closed);
    }
    const result = await closed;
    if (timedOut || overflow) {
      throw new WorktreeCommitArtifactError(kind === "git" ? "git-failed" : "validation-failed",
        `${kind === "git" ? "Git" : "Validation"} exceeded its resource bound.`);
    }
    const code = linuxWrapper && result.code !== 0 && ![238, 239, 240, 241].includes(result.code ?? -1)
      ? 240 : result.code ?? -1;
    return { code, stdout: Buffer.concat(chunks) };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) await terminateTree(child, closed).catch(() => undefined);
    if (error instanceof WorktreeCommitArtifactError) throw error;
    throw new WorktreeCommitArtifactError(kind === "git" ? "git-failed" : "validation-failed",
      `${kind === "git" ? "Git" : "Validation"} executable failed.`);
  } finally {
    clearTimeout(timer);
  }
}

function boundedCommandKind(executable: string, args: readonly string[]): "git" | "validation" {
  return /(?:^|[\\/])git(?:\.exe)?$/iu.test(executable) && args.length === 2 &&
    args[0] === "diff" && args[1] === "--check" ? "git" : "validation";
}

/** Runs one bounded command without exposing output or performing Git mutations. */
export async function runContainedValidation(request: ContainedValidationRequest): Promise<ContainedValidationResult> {
  const suppliedArgs = isRecord(request) && Array.isArray(request.args) ? request.args : [];
  const fallbackCommand = Object.freeze([
    isRecord(request) && typeof request.executable === "string" ? request.executable : "invalid",
    ...suppliedArgs.filter((value): value is string => typeof value === "string"),
  ]);
  const failed = (command: readonly string[], exitCode: number | null, error: "invalid-request" | "execution-failed") =>
    Object.freeze({ ok: false as const, command, exit_code: exitCode,
      fingerprint: createHash("sha256").update(JSON.stringify([command, exitCode, error])).digest("hex"), error });
  if (!isRecord(request) || !exactKeys(request, ["cwd", "executable", "timeout_ms", ...(request.args === undefined ? [] : ["args"])]) ||
    !validText(request.executable, MAX_COMMAND_TEXT) ||
    (!isAbsolute(request.executable) && (request.executable.startsWith("-") || /[\\/]/u.test(request.executable))) ||
    !validText(request.cwd, MAX_PATH) || !isAbsolute(request.cwd) ||
    !Number.isInteger(request.timeout_ms) || request.timeout_ms < 1 || request.timeout_ms > MAX_TIMEOUT ||
    !Array.isArray(suppliedArgs) || suppliedArgs.length > MAX_ARGUMENTS ||
    !suppliedArgs.every((arg) => validText(arg, MAX_COMMAND_TEXT))) return failed(fallbackCommand, null, "invalid-request");
  const [executable, cwd] = await Promise.all([
    resolveValidationExecutable(request.executable),
    realpath(request.cwd).catch(() => undefined),
  ]);
  if (executable === undefined || cwd === undefined || !isAbsolute(cwd)) {
    return failed(fallbackCommand, null, "invalid-request");
  }
  const command = Object.freeze([executable, ...suppliedArgs]);
  try {
    const result = await runBounded(executable, suppliedArgs, cwd, request.timeout_ms,
      boundedCommandKind(executable, suppliedArgs));
    const fingerprint = createHash("sha256").update(JSON.stringify([command, result.code])).digest("hex");
    return result.code === 0
      ? Object.freeze({ ok: true as const, command, exit_code: 0 as const, fingerprint, error: null })
      : Object.freeze({ ok: false as const, command, exit_code: result.code, fingerprint, error: "execution-failed" as const });
  } catch {
    return failed(command, null, "execution-failed");
  }
}

class Context {
  constructor(
    readonly descriptor: ParallelDispatchDescriptor,
    readonly managedPath: string,
    readonly gitPath: string,
  ) {}

  async git(args: readonly string[]): Promise<Buffer> {
    const result = await runBounded(this.gitPath, args, this.managedPath, GIT_TIMEOUT, "git");
    if (result.code !== 0) throw new WorktreeCommitArtifactError("git-failed", "Git command failed.");
    return result.stdout;
  }

  async assertPath(): Promise<void> {
    const [actual, info] = await Promise.all([
      realpath(this.managedPath).catch(() => undefined),
      lstat(this.managedPath).catch(() => undefined),
    ]);
    if (actual === undefined || info === undefined || !info.isDirectory() || info.isSymbolicLink() ||
      pathIdentity(actual) !== pathIdentity(this.managedPath)) {
      throw new WorktreeCommitArtifactError("invalid-state", "Managed worktree path identity is invalid.");
    }
  }

  async branchAndHead(): Promise<{ branch: string; head: string }> {
    const [branch, head] = await Promise.all([
      this.git(["symbolic-ref", "--quiet", "--short", "HEAD"]),
      this.git(["rev-parse", "--verify", "HEAD^{commit}"]),
    ]);
    return { branch: branch.toString("utf8").trim(), head: head.toString("utf8").trim() };
  }
}

function validateDescriptor(value: unknown): asserts value is ParallelDispatchDescriptor {
  if (!isRecord(value) || !exactKeys(value, DESCRIPTOR_KEYS) || !validText(value.task_id) ||
    !validText(value.branch) || !validText(value.managed_path, MAX_PATH) || !isAbsolute(value.managed_path) ||
    typeof value.run_id !== "string" || !UUID.test(value.run_id) || typeof value.dispatch_id !== "string" ||
    !UUID.test(value.dispatch_id) || typeof value.base_sha !== "string" || !SHA.test(value.base_sha) ||
    typeof value.contract_fingerprint !== "string" || !HASH.test(value.contract_fingerprint) || value.attempt !== 1 ||
    value.parallel_group !== value.run_id || value.parallel_unit !== value.task_id ||
    !Number.isInteger(value.parallel_units) || (value.parallel_units as number) < 2 || (value.parallel_units as number) > 64 ||
    !Array.isArray(value.depends_on) || value.depends_on.length > 64 || !value.depends_on.every((item) => validText(item)) ||
    !Array.isArray(value.scope_read) || value.scope_read.length > 256 || !value.scope_read.every((path) => validText(path, MAX_PATH)) ||
    !Array.isArray(value.scope_write) || value.scope_write.length === 0 || value.scope_write.length > 256 ||
    !value.scope_write.every((path) => validText(path, MAX_PATH))) {
    throw new WorktreeCommitArtifactError("invalid-request", "Parallel dispatch descriptor is invalid.");
  }
  try {
    const scopeRead = value.scope_read as string[];
    const scopeWrite = value.scope_write as string[];
    const normalizedRead = scopeRead.map((path) => normalizeWorktreeScopePath(path));
    const normalized = scopeWrite.map((path) => normalizeWorktreeScopePath(path));
    if (!normalizedRead.every((path, index) => path === scopeRead[index]) ||
      !normalized.every((path, index) => path === scopeWrite[index])) throw new Error();
  } catch {
    throw new WorktreeCommitArtifactError("invalid-request", "Parallel dispatch write scope is not canonical.");
  }
}

async function makeContext(request: { descriptor: ParallelDispatchDescriptor; managed_path: string; git_path?: string }): Promise<Context> {
  validateDescriptor(request.descriptor);
  if (!validText(request.managed_path, MAX_PATH) || !isAbsolute(request.managed_path) ||
    pathIdentity(request.managed_path) !== pathIdentity(request.descriptor.managed_path) ||
    (request.git_path !== undefined && (!validText(request.git_path, MAX_PATH) || request.git_path.startsWith("-")))) {
    throw new WorktreeCommitArtifactError("invalid-request", "Managed path or Git executable is invalid.");
  }
  const descriptor = Object.freeze({
    ...request.descriptor,
    depends_on: Object.freeze([...request.descriptor.depends_on]),
    scope_read: Object.freeze([...request.descriptor.scope_read]),
    scope_write: Object.freeze([...request.descriptor.scope_write]),
  });
  const context = new Context(descriptor, resolve(request.managed_path), request.git_path ?? "git");
  await context.assertPath();
  return context;
}

function parseStatus(source: Buffer, staged: "forbid" | "require" | "either"): StatusEntry[] {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(source); } catch {
    throw new WorktreeCommitArtifactError("invalid-state", "Git status path encoding is invalid.");
  }
  const fields = text.split("\0");
  if (fields.at(-1) !== "") throw new WorktreeCommitArtifactError("invalid-state", "Git status is ambiguous.");
  fields.pop();
  const entries: StatusEntry[] = [];
  for (const field of fields) {
    if (field.length < 4 || field[2] !== " ") throw new WorktreeCommitArtifactError("invalid-state", "Git status is ambiguous.");
    const x = field[0]!;
    const y = field[1]!;
    const untracked = x === "?" && y === "?";
    if (!untracked && (x === "?" || y === "?" || x === "!" || y === "!" || "RCUT".includes(x) || "RCUT".includes(y))) {
      throw new WorktreeCommitArtifactError("invalid-state", "Untracked, renamed, copied, or unsupported changes are forbidden.");
    }
    const unstagedEdit = x === " " && (y === "M" || y === "D");
    const stagedEdit = (x === "A" || x === "M" || x === "D") && y === " ";
    if ((!untracked && staged === "forbid" && !unstagedEdit) ||
      (!untracked && staged === "require" && !stagedEdit) ||
      (!untracked && staged === "either" && !unstagedEdit && !stagedEdit)) {
      throw new WorktreeCommitArtifactError("invalid-state", "Index or worktree status is not an accepted implementation edit.");
    }
    const path = field.slice(3);
    let folded: string;
    try {
      folded = normalizeWorktreeScopePath(path);
    } catch {
      throw new WorktreeCommitArtifactError("invalid-state", "Changed path is not canonical.");
    }
    entries.push({ code: untracked ? "A" : stagedEdit ? x as "A" | "M" | "D" : y as "M" | "D", path });
    if (folded.length === 0) throw new WorktreeCommitArtifactError("invalid-state", "Changed path is invalid.");
  }
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (new Set(entries.map(({ path }) => path.toLowerCase())).size !== entries.length) {
    throw new WorktreeCommitArtifactError("invalid-state", "Changed path identities are ambiguous.");
  }
  return entries;
}

function assertScope(entries: readonly StatusEntry[], scope: readonly string[]): void {
  for (const entry of entries) {
    const path = normalizeWorktreeScopePath(entry.path);
    if (!scope.some((allowed) => allowed === path || path.startsWith(`${allowed}/`))) {
      throw new WorktreeCommitArtifactError("invalid-state", "A changed path is outside the dispatch write scope.");
    }
  }
}

async function status(context: Context, staged: "forbid" | "require" | "either"): Promise<StatusEntry[]> {
  const entries = parseStatus(await context.git([
    "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none",
  ]), staged);
  const controls = new Set([
    `handoff.${context.descriptor.task_id}.json`,
    `${context.descriptor.task_id}.operation-manifest.json`,
    `.sortie-dogs/contracts/handoff.${context.descriptor.task_id}.json`,
    `.sortie-dogs/contracts/${context.descriptor.task_id}.operation-manifest.json`,
  ]);
  return entries.filter(({ code, path }) => code !== "A" || !controls.has(path));
}

async function stagedPaths(context: Context): Promise<ReadonlySet<string>> {
  if ((await context.git(["ls-files", "-u", "-z"])).length !== 0) {
    throw new WorktreeCommitArtifactError("invalid-state", "An unmerged index is forbidden.");
  }
  const fields = decodeGitOutput(await context.git([
    "diff", "--cached", "--name-only", "--no-renames", "-z", "--",
  ]), "Staged path encoding is invalid.").split("\0");
  if (fields.at(-1) !== "") throw new WorktreeCommitArtifactError("invalid-state", "Staged paths are ambiguous.");
  fields.pop();
  for (const path of fields) {
    if (normalizeWorktreeScopePath(path) !== path) {
      throw new WorktreeCommitArtifactError("invalid-state", "A staged path is not canonical.");
    }
  }
  if (new Set(fields.map((path) => path.toLowerCase())).size !== fields.length) {
    throw new WorktreeCommitArtifactError("invalid-state", "Staged path identities are ambiguous.");
  }
  return new Set(fields);
}

async function assertNoSubmodules(context: Context, entries: readonly StatusEntry[]): Promise<void> {
  for (const entry of entries) {
    const index = await context.git(["ls-files", "--stage", "-z", "--", entry.path]);
    if (index.toString("utf8").startsWith("160000 ")) {
      throw new WorktreeCommitArtifactError("invalid-state", "Submodule changes are forbidden.");
    }
  }
}

function decodeGitOutput(source: Buffer, message: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    throw new WorktreeCommitArtifactError("invalid-state", message);
  }
}

function parseObjectRecords(source: Buffer, kind: "tree" | "index"): Map<string, GitObjectEntry> {
  const fields = decodeGitOutput(source, "Git object path encoding is invalid.").split("\0");
  if (fields.at(-1) !== "") throw new WorktreeCommitArtifactError("invalid-state", "Git object data is ambiguous.");
  fields.pop();
  const objects = new Map<string, GitObjectEntry>();
  for (const field of fields) {
    const tab = field.indexOf("\t");
    if (tab < 0) throw new WorktreeCommitArtifactError("invalid-state", "Git object data is ambiguous.");
    const metadata = field.slice(0, tab);
    const path = field.slice(tab + 1);
    const match = kind === "tree"
      ? /^(100644|100755|120000) blob ([0-9a-f]{40}(?:[0-9a-f]{24})?)$/u.exec(metadata)
      : /^(100644|100755|120000) ([0-9a-f]{40}(?:[0-9a-f]{24})?) 0$/u.exec(metadata);
    if (match === null || path.length === 0 || objects.has(path)) {
      throw new WorktreeCommitArtifactError("invalid-state", "Git object data contains an unsupported or ambiguous entry.");
    }
    objects.set(path, { mode: match[1]!, oid: match[2]! });
  }
  return objects;
}

async function treeObjects(context: Context, revision: string, paths: readonly string[]): Promise<Map<string, GitObjectEntry>> {
  return parseObjectRecords(await context.git(["ls-tree", "-rz", "--full-tree", revision, "--", ...paths]), "tree");
}

async function targetObjects(
  context: Context,
  entries: readonly StatusEntry[],
  source: "worktree" | "index" | "commit",
  commit?: string,
): Promise<Map<string, GitObjectEntry>> {
  const present = entries.filter(({ code }) => code !== "D");
  if (source === "index") {
    return parseObjectRecords(await context.git(["ls-files", "--stage", "-z", "--", ...entries.map(({ path }) => path)]), "index");
  }
  if (source === "commit") {
    return treeObjects(context, commit!, entries.map(({ path }) => path));
  }
  const fileMode = decodeGitOutput(
    await context.git(["config", "--type=bool", "--default=false", "core.filemode"]),
    "Git file mode configuration is invalid.",
  ).trim();
  if (fileMode !== "true" && fileMode !== "false") {
    throw new WorktreeCommitArtifactError("invalid-state", "Git file mode configuration is invalid.");
  }
  const base = await treeObjects(context, context.descriptor.base_sha, entries.map(({ path }) => path));
  const objects = new Map<string, GitObjectEntry>();
  for (const entry of present) {
    const info = await lstat(join(context.managedPath, entry.path)).catch(() => undefined);
    if (info === undefined || (!info.isFile() && !info.isSymbolicLink())) {
      throw new WorktreeCommitArtifactError("invalid-state", "Changed path has an unsupported filesystem type.");
    }
    const mode = info.isSymbolicLink() ? "120000" : fileMode === "true" && (info.mode & 0o111) !== 0
      ? "100755" : entry.code === "M" && fileMode === "false" ? base.get(entry.path)?.mode ?? "" : "100644";
    if (mode.length === 0) throw new WorktreeCommitArtifactError("invalid-state", "Tracked path has no base object.");
    const oid = decodeGitOutput(
      await context.git(["hash-object", `--path=${entry.path}`, "--", entry.path]),
      "Git object identity is invalid.",
    ).trim();
    if (!SHA.test(oid)) throw new WorktreeCommitArtifactError("invalid-state", "Git object identity is invalid.");
    objects.set(entry.path, { mode, oid });
  }
  return objects;
}

async function changeFingerprint(
  context: Context,
  entries: readonly StatusEntry[],
  source: "worktree" | "index" | "commit",
  commit?: string,
): Promise<string> {
  const paths = entries.map(({ path }) => path);
  const [base, target] = await Promise.all([
    treeObjects(context, context.descriptor.base_sha, paths),
    targetObjects(context, entries, source, commit),
  ]);
  const hash = createHash("sha256").update("sortie-change-v2\0");
  for (const entry of entries) {
    const object = entry.code === "D" ? base.get(entry.path) : target.get(entry.path);
    if (object === undefined || (entry.code === "A") === base.has(entry.path) ||
      entry.code !== "A" && !base.has(entry.path) || entry.code === "D" && target.has(entry.path)) {
      throw new WorktreeCommitArtifactError("invalid-state", "Git objects do not match the declared change status.");
    }
    hash.update(entry.code).update("\0").update(entry.path).update("\0")
      .update(object.mode).update("\0").update(object.oid).update("\0");
  }
  if (target.size !== entries.filter(({ code }) => code !== "D").length) {
    throw new WorktreeCommitArtifactError("invalid-state", "Git object paths do not match the declared changes.");
  }
  return hash.digest("hex");
}

function validationFingerprint(
  descriptor: ParallelDispatchDescriptor,
  command: readonly string[],
  change: string,
): string {
  return createHash("sha256").update(JSON.stringify({
    version: 1, command, exit_code: 0, task_id: descriptor.task_id, base_sha: descriptor.base_sha,
    change_fingerprint: change,
  })).digest("hex");
}

function validationCommandToken(command: readonly string[]): string {
  return createHash("sha256").update("sortie-validation-command-v1\0")
    .update(JSON.stringify(command)).digest("hex").slice(0, 24);
}

function producerCommitMessage(descriptor: ParallelDispatchDescriptor, command: readonly string[]): string {
  const task = descriptor.task_id.replace(/\s+/gu, " ").slice(0, 200);
  return `sortie: ${task} [validation:${validationCommandToken(command)}]`;
}

function freezeArtifact(value: WorktreeCommitArtifact): WorktreeCommitArtifact {
  Object.freeze(value.changed_paths);
  Object.freeze(value.validation.command);
  Object.freeze(value.validation);
  return Object.freeze(value);
}

async function assertBaseState(context: Context, expectedHead: string): Promise<void> {
  await context.assertPath();
  const state = await context.branchAndHead();
  if (state.branch !== context.descriptor.branch || state.head !== expectedHead) {
    throw new WorktreeCommitArtifactError("invalid-state", "Managed branch or HEAD does not match the dispatch contract.");
  }
}

async function assertValidatedIndex(
  context: Context,
  expected: readonly StatusEntry[],
  expectedFingerprint: string,
): Promise<void> {
  await assertBaseState(context, context.descriptor.base_sha);
  const indexed = await status(context, "require");
  await assertNoSubmodules(context, indexed);
  if (JSON.stringify(indexed) !== JSON.stringify(expected) ||
    await changeFingerprint(context, indexed, "index") !== expectedFingerprint) {
    throw new WorktreeCommitArtifactError("invalid-state", "Staged content does not match the validated change.");
  }
}

async function committedEntries(context: Context, base: string, commit: string): Promise<StatusEntry[]> {
  let nameText: string;
  try {
    nameText = new TextDecoder("utf-8", { fatal: true }).decode(await context.git([
      "diff", "--name-status", "-z", "--find-renames", "--find-copies", base, commit, "--",
    ]));
  } catch {
    throw new WorktreeCommitArtifactError("verification-failed", "Commit path encoding is invalid.");
  }
  const names = nameText.split("\0");
  if (names.at(-1) !== "") throw new WorktreeCommitArtifactError("verification-failed", "Commit path data is ambiguous.");
  names.pop();
  if (names.length % 2 !== 0) throw new WorktreeCommitArtifactError("verification-failed", "Commit path data is ambiguous.");
  const entries: StatusEntry[] = [];
  for (let index = 0; index < names.length; index += 2) {
    const code = names[index]!;
    const path = names[index + 1]!;
    try {
      if ((code !== "A" && code !== "M" && code !== "D") || path.length === 0 ||
        normalizeWorktreeScopePath(path).length === 0) throw new Error();
    } catch {
      throw new WorktreeCommitArtifactError("verification-failed", "Commit contains an unsupported change.");
    }
    entries.push({ code, path });
  }
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (new Set(entries.map(({ path }) => path.toLowerCase())).size !== entries.length) {
    throw new WorktreeCommitArtifactError("verification-failed", "Commit path identities are ambiguous.");
  }
  return entries;
}

async function validateCommit(
  context: Context,
  artifact: WorktreeCommitArtifact,
): Promise<void> {
  await assertBaseState(context, artifact.commit_sha);
  if ((await status(context, "forbid")).length !== 0) {
    throw new WorktreeCommitArtifactError("verification-failed", "Committed checkout is not clean.");
  }
  const parentLine = (await context.git(["rev-list", "--parents", "-n", "1", artifact.commit_sha])).toString("utf8").trim().split(" ");
  if (parentLine.length !== 2 || parentLine[0] !== artifact.commit_sha || parentLine[1] !== artifact.base_sha) {
    throw new WorktreeCommitArtifactError("verification-failed", "Commit is not a direct single-parent child of the dispatch base.");
  }
  const entries = await committedEntries(context, artifact.base_sha, artifact.commit_sha);
  assertScope(entries, context.descriptor.scope_write);
  if (entries.length === 0 || entries.length !== artifact.changed_paths.length ||
    !entries.every((entry, index) => entry.path === artifact.changed_paths[index])) {
    throw new WorktreeCommitArtifactError("verification-failed", "Commit paths do not match the artifact.");
  }
  const fingerprint = await changeFingerprint(context, entries, "commit", artifact.commit_sha);
  if (fingerprint !== artifact.change_fingerprint) {
    throw new WorktreeCommitArtifactError("verification-failed", "Commit content does not match the artifact fingerprint.");
  }
}

function validateArtifactShape(value: unknown, descriptor: ParallelDispatchDescriptor): asserts value is WorktreeCommitArtifact {
  if (!isRecord(value) || !exactKeys(value, [
    "base_sha", "branch", "change_fingerprint", "changed_paths", "commit_sha", "task_id", "validation",
  ]) || value.task_id !== descriptor.task_id || value.base_sha !== descriptor.base_sha || value.branch !== descriptor.branch ||
    typeof value.commit_sha !== "string" || !SHA.test(value.commit_sha) || typeof value.change_fingerprint !== "string" ||
    !HASH.test(value.change_fingerprint) || !Array.isArray(value.changed_paths) || value.changed_paths.length === 0 ||
    value.changed_paths.length > 256 || !value.changed_paths.every((path) => validText(path, MAX_PATH)) ||
    !isRecord(value.validation) || !exactKeys(value.validation, ["command", "exit_code", "validation_fingerprint"]) ||
    value.validation.exit_code !== 0 || typeof value.validation.validation_fingerprint !== "string" ||
    !HASH.test(value.validation.validation_fingerprint) || !Array.isArray(value.validation.command) ||
    value.validation.command.length === 0 || value.validation.command.length > MAX_ARGUMENTS + 1 ||
    !value.validation.command.every((part) => validText(part, MAX_COMMAND_TEXT))) {
    throw new WorktreeCommitArtifactError("verification-failed", "Commit artifact shape or identity is invalid.");
  }
  try {
    for (const path of value.changed_paths) normalizeWorktreeScopePath(path as string);
  } catch {
    throw new WorktreeCommitArtifactError("verification-failed", "Commit artifact paths are not canonical.");
  }
  const evidence = value.validation as unknown as WorktreeCommitValidationEvidence;
  if (!isAbsolute(evidence.command[0]!) || validationFingerprint(descriptor, evidence.command, value.change_fingerprint) !== evidence.validation_fingerprint) {
    throw new WorktreeCommitArtifactError("verification-failed", "Validation evidence is inconsistent.");
  }
}

export async function produceWorktreeCommitArtifact(request: WorktreeCommitProduceRequest): Promise<WorktreeCommitArtifact> {
  if (!isRecord(request) || !exactKeys(request, ["descriptor", "managed_path", "validation", ...(request.git_path === undefined ? [] : ["git_path"])]) ||
    !isRecord(request.validation) || !exactKeys(request.validation, ["executable", ...(request.validation.args === undefined ? [] : ["args"]),
      ...(request.validation.timeout_ms === undefined ? [] : ["timeout_ms"])]) ||
    !validText(request.validation.executable, MAX_COMMAND_TEXT) ||
    (!isAbsolute(request.validation.executable) &&
      (request.validation.executable.startsWith("-") || /[\\/]/u.test(request.validation.executable))) ||
    (request.validation.args !== undefined && (!Array.isArray(request.validation.args) || request.validation.args.length > MAX_ARGUMENTS ||
      !request.validation.args.every((arg) => validText(arg, MAX_COMMAND_TEXT)))) ||
    (request.validation.timeout_ms !== undefined && (!Number.isInteger(request.validation.timeout_ms) ||
      request.validation.timeout_ms < 1 || request.validation.timeout_ms > MAX_TIMEOUT))) {
    throw new WorktreeCommitArtifactError("invalid-request", "Commit producer request is invalid.");
  }
  const context = await makeContext(request);
  const executable = await resolveValidationExecutable(request.validation.executable);
  if (executable === undefined || !isAbsolute(executable)) {
    throw new WorktreeCommitArtifactError("invalid-request", "Validation executable does not exist.");
  }
  const command = Object.freeze([executable, ...(request.validation.args ?? [])]);
  await assertBaseState(context, context.descriptor.base_sha);
  const before = await status(context, "either");
  if (before.length === 0) throw new WorktreeCommitArtifactError("invalid-state", "No implementation changes exist.");
  assertScope(before, context.descriptor.scope_write);
  await assertNoSubmodules(context, before);
  const staged = await stagedPaths(context);
  const hostStaged = staged.size > 0;
  if (hostStaged && (boundedCommandKind(executable, request.validation.args ?? []) !== "git" ||
    staged.size !== before.length || !before.every(({ path }) => staged.has(path)))) {
    throw new WorktreeCommitArtifactError("invalid-state", "Staged changes are not an exact host snapshot of the implementation.");
  }
  const beforeFingerprint = await changeFingerprint(context, before, "worktree");

  const validation = await runBounded(executable, request.validation.args ?? [], context.managedPath,
    request.validation.timeout_ms ?? GIT_TIMEOUT, boundedCommandKind(executable, request.validation.args ?? []));
  if (validation.code !== 0) throw new WorktreeCommitArtifactError("validation-failed",
    validation.code === 240 ? "Validation containment setup failed."
      : validation.code === 241 ? "Validation left a descendant process."
      : validation.code === 238 ? "Validation exceeded its resource bound."
          : "Validation exited unsuccessfully.");
  if (hostStaged) {
    const stagedValidation = await runBounded(executable, ["diff", "--cached", "--check"], context.managedPath,
      request.validation.timeout_ms ?? GIT_TIMEOUT, "git");
    if (stagedValidation.code !== 0) {
      throw new WorktreeCommitArtifactError("validation-failed", "Staged implementation validation exited unsuccessfully.");
    }
  }
  await assertBaseState(context, context.descriptor.base_sha);
  const after = await status(context, "either");
  assertScope(after, context.descriptor.scope_write);
  await assertNoSubmodules(context, after);
  if (JSON.stringify(after) !== JSON.stringify(before) || await changeFingerprint(context, after, "worktree") !== beforeFingerprint) {
    throw new WorktreeCommitArtifactError("validation-failed", "Validation changed implementation content or status.");
  }

  await context.git(["add", "--", ...before.map(({ path }) => path)]);
  await assertValidatedIndex(context, before, beforeFingerprint);
  await assertValidatedIndex(context, before, beforeFingerprint);
  await context.git(["commit", "--no-verify", "--no-gpg-sign", "-m", producerCommitMessage(context.descriptor, command)]);
  const commit = (await context.git(["rev-parse", "--verify", "HEAD^{commit}"])).toString("utf8").trim();
  if (!SHA.test(commit) || commit === context.descriptor.base_sha) {
    throw new WorktreeCommitArtifactError("verification-failed", "Git did not create one new commit.");
  }
  const evidence: WorktreeCommitValidationEvidence = {
    command,
    exit_code: 0,
    validation_fingerprint: validationFingerprint(context.descriptor, command, beforeFingerprint),
  };
  const artifact: WorktreeCommitArtifact = {
    task_id: context.descriptor.task_id,
    base_sha: context.descriptor.base_sha,
    commit_sha: commit,
    branch: context.descriptor.branch,
    changed_paths: before.map(({ path }) => path),
    change_fingerprint: beforeFingerprint,
    validation: evidence,
  };
  await validateCommit(context, artifact);
  return freezeArtifact(artifact);
}

/**
 * Managed workers cannot perform arbitrary Git mutations. Under that project threat model, the exact
 * generated commit proves that its producer crossed the validation-and-commit boundary.
 */
export async function recoverWorktreeCommitArtifact(
  request: WorktreeCommitProduceRequest,
): Promise<WorktreeCommitArtifact | undefined> {
  if (!isRecord(request) || !exactKeys(request, ["descriptor", "managed_path", "validation", ...(request.git_path === undefined ? [] : ["git_path"])]) ||
    !isRecord(request.validation) || !exactKeys(request.validation, ["executable", ...(request.validation.args === undefined ? [] : ["args"]),
      ...(request.validation.timeout_ms === undefined ? [] : ["timeout_ms"])]) ||
    !validText(request.validation.executable, MAX_COMMAND_TEXT) ||
    (!isAbsolute(request.validation.executable) &&
      (request.validation.executable.startsWith("-") || /[\\/]/u.test(request.validation.executable))) ||
    (request.validation.args !== undefined && (!Array.isArray(request.validation.args) || request.validation.args.length > MAX_ARGUMENTS ||
      !request.validation.args.every((arg) => validText(arg, MAX_COMMAND_TEXT)))) ||
    (request.validation.timeout_ms !== undefined && (!Number.isInteger(request.validation.timeout_ms) ||
      request.validation.timeout_ms < 1 || request.validation.timeout_ms > MAX_TIMEOUT))) {
    throw new WorktreeCommitArtifactError("invalid-request", "Commit recovery request is invalid.");
  }
  const context = await makeContext(request);
  const executable = await resolveValidationExecutable(request.validation.executable);
  if (executable === undefined || !isAbsolute(executable)) {
    throw new WorktreeCommitArtifactError("invalid-request", "Validation executable does not exist.");
  }
  const command = Object.freeze([executable, ...(request.validation.args ?? [])]);
  const state = await context.branchAndHead();
  if (state.branch !== context.descriptor.branch) {
    throw new WorktreeCommitArtifactError("invalid-state", "Managed branch does not match the dispatch contract.");
  }
  if (state.head === context.descriptor.base_sha) return undefined;
  if ((await status(context, "forbid")).length !== 0) {
    throw new WorktreeCommitArtifactError("invalid-state", "Managed checkout is not clean.");
  }
  const parentLine = (await context.git(["rev-list", "--parents", "-n", "1", state.head])).toString("utf8").trim().split(" ");
  if (parentLine.length !== 2 || parentLine[0] !== state.head || parentLine[1] !== context.descriptor.base_sha) {
    throw new WorktreeCommitArtifactError("verification-failed", "Commit is not a direct single-parent child of the dispatch base.");
  }
  const commitObject = decodeGitOutput(await context.git(["cat-file", "commit", state.head]), "Commit object encoding is invalid.");
  const messageOffset = commitObject.indexOf("\n\n");
  if (messageOffset < 0 || commitObject.slice(messageOffset + 2) !== `${producerCommitMessage(context.descriptor, command)}\n`) {
    throw new WorktreeCommitArtifactError("verification-failed", "Commit message does not match the producer request.");
  }
  const entries = await committedEntries(context, context.descriptor.base_sha, state.head);
  if (entries.length === 0) throw new WorktreeCommitArtifactError("verification-failed", "Generated commit has no changes.");
  assertScope(entries, context.descriptor.scope_write);
  const change = await changeFingerprint(context, entries, "commit", state.head);
  const artifact = freezeArtifact({
    task_id: context.descriptor.task_id,
    base_sha: context.descriptor.base_sha,
    commit_sha: state.head,
    branch: context.descriptor.branch,
    changed_paths: entries.map(({ path }) => path),
    change_fingerprint: change,
    validation: {
      command,
      exit_code: 0,
      validation_fingerprint: validationFingerprint(context.descriptor, command, change),
    },
  });
  return await verifyWorktreeCommitArtifact({
    descriptor: context.descriptor,
    managed_path: context.managedPath,
    artifact,
    ...(request.git_path === undefined ? {} : { git_path: request.git_path }),
  });
}

export async function verifyWorktreeCommitArtifact(request: WorktreeCommitVerifyRequest): Promise<WorktreeCommitArtifact> {
  if (!isRecord(request) || !exactKeys(request, ["artifact", "descriptor", "managed_path", ...(request.git_path === undefined ? [] : ["git_path"])])) {
    throw new WorktreeCommitArtifactError("invalid-request", "Commit verifier request is invalid.");
  }
  const context = await makeContext(request);
  validateArtifactShape(request.artifact, context.descriptor);
  try {
    await validateCommit(context, request.artifact);
  } catch (error) {
    if (error instanceof WorktreeCommitArtifactError && error.code === "verification-failed") throw error;
    throw new WorktreeCommitArtifactError("verification-failed", "Managed checkout does not verify against the commit artifact.");
  }
  return freezeArtifact(structuredClone(request.artifact));
}
