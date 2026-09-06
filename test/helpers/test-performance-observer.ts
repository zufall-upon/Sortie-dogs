import childProcess from "node:child_process";
import fs from "node:fs";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";

type Metric = { count: number; bytes: number; ms: number; samples_ms?: number[] };
type Summary = {
  schema: 1;
  pid: number;
  phase: string;
  wall_ms: number;
  git_processes: number;
  writes: Metric;
  state_writes: Metric;
  temp_writes: Metric;
  observer_writes: number;
  methods: Record<string, Metric>;
  fixture_roots: string[];
};

const outputDirectory = process.env.SORTIE_PERF_OUTPUT_DIR;
const started = performance.now();
const originalWriteFileSync = fs.writeFileSync.bind(fs);
const summary: Summary = {
  schema: 1,
  pid: process.pid,
  phase: classifyPhase(),
  wall_ms: 0,
  git_processes: 0,
  writes: metric(),
  state_writes: metric(),
  temp_writes: metric(),
  observer_writes: 0,
  methods: {},
  fixture_roots: [],
};

function metric(): Metric {
  return { count: 0, bytes: 0, ms: 0 };
}

function classifyTestPhase(argv: readonly string[]): string {
  const joined = argv.join(" ");
  if (joined.includes("heavy-case-profile.ts")) return "unit6";
  if (joined.includes("plugin.test.ts")) return "plugin";
  if (joined.includes("continuation.test.ts")) return "continuation";
  if (joined.includes("fast-lane.test.ts")) return "fast-lane";
  return "node";
}

function classifyPhase(): string {
  const testPhase = classifyTestPhase(process.argv);
  if (testPhase !== "node") return testPhase;
  return process.env.npm_lifecycle_event ?? "node";
}

function byteLength(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value);
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return value.byteLength;
  return 0;
}

function recordWrite(pathValue: unknown, data: unknown): void {
  const bytes = byteLength(data);
  summary.writes.count += 1;
  summary.writes.bytes += bytes;
  const path = typeof pathValue === "string" ? pathValue.replaceAll("\\", "/") : "";
  const target = path.endsWith("/state.json") || path.includes("/parallel-dispatch-v5/") ? summary.state_writes
    : path.includes("/_testenv/") || path.includes("/Temp/") ? summary.temp_writes
    : undefined;
  if (target !== undefined) {
    target.count += 1;
    target.bytes += bytes;
  }
}

function copyFunctionProperties(source: Function, target: Function): void {
  for (const key of Reflect.ownKeys(source)) {
    if (["length", "name", "prototype"].includes(String(key))) continue;
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor !== undefined) Object.defineProperty(target, key, descriptor);
  }
}

function patchCallbackWrite(name: "writeFile" | "appendFile"): void {
  const original = fs[name];
  const wrapped = function (...args: unknown[]) {
    recordWrite(args[0], args[1]);
    return Reflect.apply(original, fs, args);
  };
  copyFunctionProperties(original, wrapped);
  Object.defineProperty(fs, name, { configurable: true, value: wrapped });
}

function patchPromiseWrite(name: "writeFile" | "appendFile"): void {
  const original = fs.promises[name].bind(fs.promises);
  Object.defineProperty(fs.promises, name, {
    configurable: true,
    value: async (...args: unknown[]) => {
      recordWrite(args[0], args[1]);
      return await Reflect.apply(original, fs.promises, args);
    },
  });
}

function patchSyncWrite(name: "writeFileSync" | "appendFileSync"): void {
  const original = fs[name];
  Object.defineProperty(fs, name, {
    configurable: true,
    value: (...args: unknown[]) => {
      recordWrite(args[0], args[1]);
      return Reflect.apply(original, fs, args);
    },
  });
}

function patchOpen(): void {
  const originalOpen = fs.promises.open.bind(fs.promises);
  Object.defineProperty(fs.promises, "open", {
    configurable: true,
    value: async (...args: unknown[]) => {
      const handle = await Reflect.apply(originalOpen, fs.promises, args);
      const path = args[0];
      for (const name of ["write", "writeFile", "appendFile"] as const) {
        const original = handle[name].bind(handle);
        handle[name] = async (...writeArgs: unknown[]) => {
          recordWrite(path, writeArgs[0]);
          return await Reflect.apply(original, handle, writeArgs);
        };
      }
      return handle;
    },
  });
}

function patchDescriptorWrites(): void {
  const originalWrite = fs.write;
  Object.defineProperty(fs, "write", {
    configurable: true,
    value: (...args: unknown[]) => {
      recordWrite("", args[1]);
      return Reflect.apply(originalWrite, fs, args);
    },
  });
  const originalWriteSync = fs.writeSync;
  Object.defineProperty(fs, "writeSync", {
    configurable: true,
    value: (...args: unknown[]) => {
      recordWrite("", args[1]);
      return Reflect.apply(originalWriteSync, fs, args);
    },
  });
}

function install(): void {
  if (outputDirectory === undefined) return;
  patchCallbackWrite("writeFile");
  patchCallbackWrite("appendFile");
  patchPromiseWrite("writeFile");
  patchPromiseWrite("appendFile");
  patchSyncWrite("writeFileSync");
  patchSyncWrite("appendFileSync");
  patchOpen();
  patchDescriptorWrites();

  const originalSpawn = childProcess.ChildProcess.prototype.spawn;
  childProcess.ChildProcess.prototype.spawn = function (options: { file?: string }) {
    if (basename(options.file ?? "").toLowerCase().replace(/\.exe$/u, "") === "git") summary.git_processes += 1;
    return originalSpawn.call(this, options);
  };

  const checkpoint = setInterval(() => persist(), 3_000);
  checkpoint.unref();
  process.once("exit", () => persist());
}

function persist(): void {
  if (outputDirectory === undefined) return;
  summary.wall_ms = Math.round(performance.now() - started);
  summary.observer_writes += 1;
  originalWriteFileSync(join(outputDirectory, `${process.pid}.json`), JSON.stringify(summary));
}

export async function observeMethod<T>(name: string, operation: () => Promise<T> | T): Promise<T> {
  const entry = summary.methods[name] ??= { ...metric(), samples_ms: [] };
  const methodStarted = performance.now();
  entry.count += 1;
  try {
    return await operation();
  } finally {
    const elapsed = Math.round(performance.now() - methodStarted);
    entry.ms += elapsed;
    entry.samples_ms!.push(elapsed);
  }
}

export function registerFixtureRoot(path: string): void {
  if (outputDirectory !== undefined && !summary.fixture_roots.includes(path)) summary.fixture_roots.push(path);
}

install();
