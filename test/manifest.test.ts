import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
