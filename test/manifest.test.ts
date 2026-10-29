import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { normalizeManifestPath } from "../src/core/path.ts";
import { validateManifest } from "../src/core/validate-manifest.ts";
import type { Handoff, OperationManifest } from "../src/core/types.ts";
import { WriteDeniedError, createProjectPaths, createWriteGate } from "../dist/plugin/gate.js";

function makeHandoff(profile: Handoff["profile"] = "full"): Handoff {
  return {
    version: "0.1.0",
    profile,
    id: "manifest-gate-test",
    created_at: "2030-01-02T03:04:05Z",
    task: { title: "Manifest gate", objective: "Exercise manifest set rules." },
    scope: profile === "full" ? { paths: ["src/core.ts"], excludes: ["temp"] } : undefined,
    state: { done: [], next: ["Continue."], blocked: [] },
    sources: profile === "full" ? [{ path: "docs/spec.md", rev: "main" }] : undefined,
    risks: [],
    verification: [{ check: "npm test", status: "pass", exit_code: 0, summary: "Passed." }],
  };
}

function makeManifest(): OperationManifest {
  return {
    version: "0.1.0",
    task_id: "manifest-gate-test",
    read: ["docs/spec.md"],
    write: ["src/core.ts"],
    validation: ["npm test"],
  };
}

test("accepts all manifest set relations for a full handoff", () => {
  assert.deepEqual(validateManifest(makeHandoff(), makeManifest(), ["src\\core.ts"], true), []);
});

test("M002 and M003 compare normalized scope and source paths against read union write", () => {
  const handoff = makeHandoff();
  handoff.scope = { paths: ["private\\scope", "private/scope"], excludes: ["not-declared"] };
  handoff.sources = [
    { path: "private\\source", rev: "one" },
    { path: "private/source", rev: "two" },
  ];

  assert.deepEqual(
    validateManifest(handoff, makeManifest(), [], true).map(({ code, pointer }) => ({ code, pointer })),
    [
      { code: "M002_SCOPE_NOT_ALLOWED", pointer: "/scope/paths/0" },
      { code: "M003_SOURCE_NOT_DECLARED", pointer: "/sources/0/path" },
    ],
  );
});

test("M004 requires every verification check in manifest validation for every profile", () => {
  for (const profile of ["minimal", "full"] as const) {
    const handoff = makeHandoff(profile);
    handoff.verification = [
      { check: "private-check", status: "pass", exit_code: 0, summary: "Passed." },
      { check: "private-check", status: "pass", exit_code: 0, summary: "Repeated." },
    ];
    const manifest = makeManifest();
    manifest.validation = [];

    assert.deepEqual(
      validateManifest(handoff, manifest, [], true).map(({ code, pointer }) => ({ code, pointer })),
      [{ code: "M004_VERIFICATION_NOT_DECLARED", pointer: "/verification/0/check" }],
    );
  }
});

test("H011 requires every full manifest validation to have a passing verification", () => {
  const full = makeHandoff();
  full.verification[0] = {
    check: "npm test",
    status: "fail",
    exit_code: 1,
    summary: "Failed.",
  };
  assert.deepEqual(
    validateManifest(full, makeManifest(), [], true).map(({ code, severity, pointer }) => ({ code, severity, pointer })),
    [{ code: "H011_VALIDATION_MISSING", severity: "error", pointer: "/verification" }],
  );

  const minimal = makeHandoff("minimal");
  minimal.verification = [];
  assert.deepEqual(validateManifest(minimal, makeManifest(), [], true), []);
});

test("M005 requires provided changed paths to be a normalized write subset", () => {
  const diagnostics = validateManifest(
    makeHandoff(),
    makeManifest(),
    ["private\\output.ts", "private/output.ts", "docs\\spec.md"],
    true,
  );
  assert.deepEqual(
    diagnostics.map(({ code, pointer }) => ({ code, pointer })),
    [
      { code: "M005_CHANGED_PATH_NOT_WRITABLE", pointer: "/changedPaths/0" },
      { code: "M005_CHANGED_PATH_NOT_WRITABLE", pointer: "/changedPaths/2" },
    ],
  );
});

test("M007 distinguishes missing changed-path input from a provided empty set", () => {
  const missing = validateManifest(makeHandoff(), makeManifest(), undefined, false);
  assert.deepEqual(missing, [{
    code: "M007_CHANGED_PATHS_MISSING",
    severity: "warning",
    pointer: "/changedPaths",
    message: "Changed paths were not provided.",
  }]);
  assert.deepEqual(validateManifest(makeHandoff(), makeManifest(), [], true), []);
});

test("malformed handoff paths fail closed at their original indices", () => {
  const handoff = makeHandoff();
  handoff.scope = { paths: ["/absolute-scope", "safe/../scope"] };
  handoff.sources = [
    { path: "/absolute-source", rev: "one" },
    { path: "safe/../source", rev: "two" },
  ];

  assert.deepEqual(
    validateManifest(
      handoff,
      makeManifest(),
      ["/absolute-change", "safe/../change"],
      true,
    ).map(({ code, pointer }) => ({ code, pointer })),
    [
      { code: "M005_CHANGED_PATH_NOT_WRITABLE", pointer: "/changedPaths/0" },
      { code: "M005_CHANGED_PATH_NOT_WRITABLE", pointer: "/changedPaths/1" },
      { code: "M002_SCOPE_NOT_ALLOWED", pointer: "/scope/paths/0" },
      { code: "M002_SCOPE_NOT_ALLOWED", pointer: "/scope/paths/1" },
      { code: "M003_SOURCE_NOT_DECLARED", pointer: "/sources/0/path" },
      { code: "M003_SOURCE_NOT_DECLARED", pointer: "/sources/1/path" },
    ],
  );
});

test("absolute manifest paths are accepted while traversal produces deterministic diagnostics", () => {
  const manifest = makeManifest();
  manifest.read = ["/absolute-read", "safe/../read"];
  manifest.write = ["/absolute-write", "safe/../write"];

  const diagnostics = validateManifest(makeHandoff("minimal"), manifest, [], true);
  assert.deepEqual(
    diagnostics.map(({ code, pointer, message }) => ({ code, pointer, message })),
    [
      {
        code: "H001_PATH_RELATIVE",
        pointer: "/manifest/read/1",
        message: "Manifest path must be a valid repository-relative path.",
      },
      {
        code: "H001_PATH_RELATIVE",
        pointer: "/manifest/write/1",
        message: "Manifest path must be a valid repository-relative path.",
      },
    ],
  );
  assert.equal(JSON.stringify(diagnostics).includes("absolute"), false);
  assert.equal(JSON.stringify(diagnostics).includes("../"), false);
});

test("accepts normalized drive, UNC, and POSIX absolute manifest entries without adding them to repository sets", () => {
  assert.deepEqual(normalizeManifestPath("c:\\global\\.\\asset.txt"), { kind: "absolute", path: "C:/global/asset.txt" });
  assert.deepEqual(normalizeManifestPath("\\\\server\\share\\agent"), { kind: "absolute", path: "//server/share/agent" });
  assert.deepEqual(normalizeManifestPath("/opt/sortie/asset"), { kind: "absolute", path: "/opt/sortie/asset" });

  const manifest = makeManifest();
  manifest.read.push("/external/read-only.txt");
  manifest.write.push("/external/write.txt");
  assert.deepEqual(validateManifest(makeHandoff(), manifest, ["src/core.ts"], true), []);
});

test("rejects traversal in absolute manifest entries", () => {
  const manifest = makeManifest();
  manifest.write = ["/external/../escape.txt"];
  assert.deepEqual(
    validateManifest(makeHandoff("minimal"), manifest, [], true).map(({ code, pointer }) => ({ code, pointer })),
    [{ code: "H001_PATH_RELATIVE", pointer: "/manifest/write/0" }],
  );
});

test("external write scope allows exact files and directory descendants but denies unlisted targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "sortie-project-"));
  const external = await mkdtemp(join(tmpdir(), "sortie-external-"));
  try {
    const exact = join(external, "exact.txt");
    const directory = join(external, "directory");
    await writeFile(exact, "existing");
    await mkdir(directory);
    const gate = await createWriteGate(await createProjectPaths(root), {
      ...makeManifest(),
      write: [exact, directory],
    });

    await gate.checkPath(exact);
    await gate.checkPath(join(directory, "nested", "result.txt"));
    await assert.rejects(
      gate.checkPath(join(external, "unlisted.txt")),
      (error: unknown) => error instanceof WriteDeniedError && error.reason === "project-boundary",
    );
    await assert.rejects(
      gate.checkPath(join(directory, "..", "escape.txt")),
      (error: unknown) => error instanceof WriteDeniedError && error.reason === "project-boundary",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("external directory scope rejects symlink escape when the host permits symlink creation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "sortie-project-"));
  const external = await mkdtemp(join(tmpdir(), "sortie-external-"));
  try {
    const directory = join(external, "directory");
    const outside = join(external, "outside");
    await mkdir(directory);
    await mkdir(outside);
    try {
      await symlink(outside, join(directory, "link"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip("host does not permit symlink creation");
        return;
      }
      throw error;
    }
    const gate = await createWriteGate(await createProjectPaths(root), {
      ...makeManifest(),
      write: [directory],
    });
    await assert.rejects(
      gate.checkPath(join(directory, "link", "escaped.txt")),
      (error: unknown) => error instanceof WriteDeniedError && error.reason === "manifest-scope",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("explicit symlink entry permits native unlink/replacement but never target writes or changed parent escape", async t => {
  if (process.platform === "win32") return t.skip("POSIX unlink/mv entry semantics");
  const root = await mkdtemp(join(tmpdir(), "sortie-link-project-")), external = await mkdtemp(join(tmpdir(), "sortie-link-external-"));
  const exec = promisify(execFile);
  try {
    const target = join(external, "private.txt"), link = join(external, "bin", "entry"), source = join(external, "source");
    await mkdir(join(external, "bin")); await writeFile(target, "private"); await writeFile(source, "replacement"); await symlink(target, link);
    const gate = await createWriteGate(await createProjectPaths(root), { ...makeManifest(), write: [link, source] });
    const check = (command: string) => gate.check({ tool: "bash", sessionID: "worker", callID: command }, { args: { command } });
    await assert.rejects(gate.checkPath(link), /write scope/);
    await assert.rejects(check(`printf bad > '${link}'; unlink '${link}'`), /write scope/);
    await assert.rejects(check(`cp '${source}' '${link}'`), /write scope/);
    await assert.rejects(check(`mv '${source}' '${link}'`), /write scope/);
    await assert.rejects(check(`mv -t '${link}' '${source}'`), /write scope/);
    await check(`unlink '${link}'`); await exec("unlink", [link]);
    await symlink(target, link);
    await check(`mv -T '${source}' '${link}'`); await exec("mv", ["-T", source, link]);
    assert.equal(await readFile(link, "utf8"), "replacement"); assert.equal(await readFile(target, "utf8"), "private");
    await rm(link); await symlink(root, link);
    await assert.rejects(gate.checkPath(join(link, "escape")), /write scope|project-root/);
    await assert.rejects(check(`unlink '${link}/'`), /write scope|project-root/);
    // Same-project links must not turn exact entry permission into permission to follow.
    await writeFile(join(root, "private"), "private"); await symlink(join(root, "private"), join(root, "entry"));
    const relativeGate = await createWriteGate(await createProjectPaths(root), { ...makeManifest(), write: ["entry"] });
    await assert.rejects(relativeGate.checkPath("entry"), /write scope/);
    await mkdir(join(root, "holder")); await mkdir(join(root, "other"));
    await symlink(target, join(root, "holder", "link")); await writeFile(join(root, "other", "link"), "private");
    const nestedGate = await createWriteGate(await createProjectPaths(root), { ...makeManifest(), write: ["holder/link"] });
    await rm(join(root, "holder"), { recursive: true }); await symlink(join(root, "other"), join(root, "holder"));
    await assert.rejects(nestedGate.check({ tool: "bash", sessionID: "worker", callID: "changed-parent" },
      { args: { command: "unlink holder/link" } }), /write scope/);
    await rm(join(external, "bin"), { recursive: true }); await symlink(root, join(external, "bin"));
    await assert.rejects(check(`unlink '${link}'`), /write scope|project-root/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(external, { recursive: true, force: true }); }
});

test("native npm update replaces an existing explicitly scoped bin symlink without declaring its parent", async t => {
  if (process.platform === "win32") return t.skip("npm POSIX bin symlink");
  const directory = await mkdtemp(join(tmpdir(), "sortie-npm-link-")), exec = promisify(execFile);
  try {
    const project = join(directory, "project"), prefix = join(directory, "prefix"), cache = join(directory, "cache");
    await mkdir(project);
    const install = async (version: number, gate?: Awaited<ReturnType<typeof createWriteGate>>) => {
      const pkg = join(directory, `pkg-${version}`); await mkdir(pkg);
      await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "sortie-link-fixture", version: `${version}.0.0`, bin: { "sortie-link-fixture": `cli-${version}.js` } }));
      await writeFile(join(pkg, `cli-${version}.js`), `#!/usr/bin/env node\nconsole.log(${version});\n`);
      const args = ["install", "--prefix", prefix, "--cache", cache, "--install-links", "--ignore-scripts", "--no-audit", "--no-fund", "--no-save", "--package-lock=false", pkg];
      await gate?.check({ tool: "bash", sessionID: "worker", callID: "npm-update" },
        { args: { command: `npm ${args.map(arg => `'${arg}'`).join(" ")}` } }, { investigativeShell: true });
      await exec("npm", args, { timeout: 30_000 });
    };
    await install(1);
    const link = join(prefix, "node_modules/.bin/sortie-link-fixture");
    assert.match(await readlink(link), /cli-1.js$/);
    const gate = await createWriteGate(await createProjectPaths(project), { ...makeManifest(),
      write: [link, join(prefix, "node_modules/sortie-link-fixture"), join(prefix, "node_modules/.package-lock.json"), cache] });
    await install(2, gate);
    assert.match(await readlink(link), /cli-2.js$/);
    assert.equal((await exec(process.execPath, [link])).stdout.trim(), "2");
    await gate.checkPath(link); // This package directory is independently writable.
    await rm(link); await writeFile(join(directory, "private"), "private"); await symlink(join(directory, "private"), link);
    await assert.rejects(gate.checkPath(link), /write scope/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("missing ancestor plus child declaration scopes descendants without widening lone missing paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "sortie-project-"));
  try {
    const ancestor = "temp";
    const child = "temp/candidate";
    const gate = await createWriteGate(await createProjectPaths(root), {
      ...makeManifest(),
      write: [ancestor, child],
    });
    await gate.checkPath("temp/candidate/run.ps1");
    await assert.rejects(gate.checkPath("temp/other/run.ps1"),
      (error: unknown) => error instanceof WriteDeniedError && error.reason === "manifest-scope");
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const loneRoot = await mkdtemp(join(tmpdir(), "sortie-project-"));
  try {
    const gate = await createWriteGate(await createProjectPaths(loneRoot), {
      ...makeManifest(),
      write: ["missing-target"],
    });
    await gate.checkPath("missing-target");
    await assert.rejects(gate.checkPath("missing-target/child.txt"),
      (error: unknown) => error instanceof WriteDeniedError && error.reason === "manifest-scope");
  } finally {
    await rm(loneRoot, { recursive: true, force: true });
  }
});

test("explicit directory declarations compare descendants consistently with the execution gate", () => {
  const handoff = makeHandoff();
  handoff.scope = { paths: ["output/result.json"] };
  handoff.sources = [{ path: "input/nested/source.ts", rev: "main" }];
  const manifest = { ...makeManifest(), read: ["input/**"], write: ["output/**"] };
  assert.deepEqual(validateManifest(handoff, manifest, ["output/nested/result.json"], true), []);
  assert.deepEqual(validateManifest(handoff, manifest, ["output-other/result.json"], true).map(item => item.code),
    ["M005_CHANGED_PATH_NOT_WRITABLE"]);
});

test("sorts numeric JSON-pointer segments numerically beyond index 9", () => {
  const changedPaths = Array.from({ length: 11 }, (_, index) => `private/change-${index}`);
  assert.deepEqual(
    validateManifest(makeHandoff(), makeManifest(), changedPaths, true)
      .map(({ pointer }) => pointer),
    changedPaths.map((_, index) => `/changedPaths/${index}`),
  );
});

test("manifest diagnostics use fixed messages without input values", () => {
  const handoff = makeHandoff();
  handoff.scope = { paths: ["private-scope"] };
  handoff.sources = [{ path: "private-source", rev: "main" }];
  handoff.verification = [{
    check: "private-check",
    status: "fail",
    exit_code: 1,
    summary: "private-summary",
  }];
  const manifest = makeManifest();
  manifest.validation = ["private-required-check"];

  const serialized = JSON.stringify(validateManifest(handoff, manifest, ["private-change"], true));
  for (const value of [
    "private-scope",
    "private-source",
    "private-check",
    "private-summary",
    "private-required-check",
    "private-change",
  ]) {
    assert.equal(serialized.includes(value), false);
  }
});

test("synthetic valid full operation-manifest fixture accepts all changed paths and validations", async () => {
  const directory = new URL("./fixtures/valid/12-full-operation-manifest/", import.meta.url);
  const handoff = JSON.parse(await readFile(new URL("handoff.json", directory), "utf8")) as Handoff;
  const manifest = JSON.parse(
    await readFile(new URL("operation-manifest.json", directory), "utf8"),
  ) as OperationManifest;
  const expected = JSON.parse(await readFile(new URL("expected.json", directory), "utf8")) as {
    diagnostics: string[];
    exit: number;
  };
  const changedPaths = (await readFile(new URL("changed-paths.txt", directory), "utf8"))
    .split(/\r?\n/u)
    .filter((path) => path.length > 0);
  const diagnostics = validateManifest(handoff, manifest, changedPaths, true);

  assert.equal(manifest.task_id, handoff.id);
  assert.deepEqual(diagnostics.map(({ code }) => code), expected.diagnostics);
  assert.equal(diagnostics.some(({ severity }) => severity === "error") ? 1 : 0, expected.exit);
});
