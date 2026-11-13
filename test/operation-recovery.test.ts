import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import test from "node:test";
import { createProjectPaths, createWriteGate, canonicalManifestWriteScopes, extractWritePaths, isKnownReadOnlyTool, WriteDeniedError } from "../dist/plugin/gate.js";
import { protectedSnapshot, refreshProtectedSnapshot } from "../dist/plugin/protected-snapshot.js";
import { missionDeliveryObservation, missionReviewSource } from "../dist/plugin/mission-review.js";
import { missionOperationCommandMatch, OperatorMissionRuntime, missionPlan } from "../dist/core/operator-mission.js";
import { OperatorRuntime, operatorGitPathAuthorized } from "../dist/core/operator-runtime.js";
import { V010_RUNTIME_PROFILE } from "../dist/core/runtime-profile.js";

const exec = promisify(execFile);
test("delivery records actual native Git state, including a later dirty candidate", async () => fixture(async root => {
  await exec("git", ["init", "--quiet", "-b", "delivery-test"], { cwd: root });
  await writeFile(join(root, "result.txt"), "delivered\n");
  await exec("git", ["add", "result.txt"], { cwd: root });
  await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "Deliver"], { cwd: root });
  const observed = await missionDeliveryObservation(root, "run");
  assert.equal(observed?.head, (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim());
  assert.equal(observed?.branch, "delivery-test");
  assert.equal(observed?.clean, true);
  await writeFile(join(root, "result.txt"), "later edit\n");
  const changed = await missionDeliveryObservation(root, "run");
  assert.equal(changed?.head, observed?.head);
  assert.equal(changed?.clean, false, "same commit is not proof of clean source");
}));
async function fixture(run: (root: string) => Promise<void>) {
  await mkdir(resolve("_testenv"), { recursive: true });
  const root = await mkdtemp(resolve("_testenv/operation-recovery-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("saved v0.13.20 native commands match only the same operation across PowerShell and absolute Node paths", () => {
  const directory = "M:\\_work\\_Sortie-dogs-artifacts\\worktrees\\global-apply-v0.13.15-20261012";
  const pull = "git pull --ff-only origin main";
  const apply = "node '_testenv/global-apply-v0.13.16/apply.mjs' '../work-quantity-progress-20261013/_testenv/global-apply-v0.13.20/plan.json'";
  const nativePull = "$ErrorActionPreference='Stop'; git pull --ff-only origin main";
  const nativeApply = "& 'M:/@HyperV/node-v22.14.0-win-x64/node.exe' " +
    "'M:/_work/_Sortie-dogs-artifacts/worktrees/global-apply-v0.13.15-20261012/_testenv/global-apply-v0.13.16/apply.mjs' " +
    "'M:/_work/_Sortie-dogs-artifacts/worktrees/work-quantity-progress-20261013/_testenv/global-apply-v0.13.20/plan.json'";
  assert.equal(missionOperationCommandMatch(nativePull, [pull, apply], directory), pull);
  assert.equal(missionOperationCommandMatch(nativeApply, [pull, apply], directory), apply);
  assert.equal(missionOperationCommandMatch(nativeApply.replace("plan.json", "other-plan.json"), [pull, apply], directory), undefined,
    "a same-named helper with a different input is not the declared operation");
  assert.equal(missionOperationCommandMatch(`${nativePull}; Write-Output done`, [pull], directory), undefined,
    "an appended native command remains unmatched");
  assert.equal(missionOperationCommandMatch(nativeApply, [pull, apply, apply], directory), undefined,
    "conflicting declarations remain ambiguous");
  for (const [declared, actual] of [
    ["node apply.mjs https://example.test/Plan", "node apply.mjs https://example.test/plan"],
    ["node apply.mjs --mode=A/B", "node apply.mjs --mode=a/b"],
    ["node apply.mjs tenant/a/../b", "node apply.mjs tenant/b"],
    ["node apply.mjs /Route", "node apply.mjs /route"],
  ]) assert.equal(missionOperationCommandMatch(actual!, [declared!], directory), undefined,
    "URL and option values retain their literal identity, not Windows filesystem case rules");
});

test("Node operation spelling retains pinned executable and platform identity", () => {
  const posix = "/trusted/work";
  assert.equal(missionOperationCommandMatch("/other/node /trusted/work/apply.mjs plan.json",
    ["/trusted/node apply.mjs plan.json"], posix), undefined, "a different pinned executable is not an observed run of the declared binary");
  assert.equal(missionOperationCommandMatch("node.exe /trusted/work/apply.mjs plan.json",
    ["node apply.mjs plan.json"], posix), undefined, "node.exe is not a POSIX node alias");
  assert.equal(missionOperationCommandMatch("node /trusted/work/apply.mjs plan.json",
    ["/trusted/node apply.mjs plan.json"], posix), undefined, "a bare native binary does not prove the declared pinned executable");
  assert.equal(missionOperationCommandMatch("/trusted/node /trusted/work/apply.mjs plan.json",
    ["node apply.mjs plan.json"], posix), "node apply.mjs plan.json", "bare node still accepts its native resolved spelling");
  const windows = "M:\\Work\\Repo";
  assert.equal(missionOperationCommandMatch("& 'm:/Tools/Node.exe' 'm:/Work/Repo/apply.mjs' plan.json",
    ["'M:/Tools/node.exe' apply.mjs plan.json"], windows), "'M:/Tools/node.exe' apply.mjs plan.json");
  assert.equal(missionOperationCommandMatch("& 'm:/Other/Node.exe' 'm:/Work/Repo/apply.mjs' plan.json",
    ["'M:/Tools/node.exe' apply.mjs plan.json"], windows), undefined);
});

test("native mission directory scope survives creation, archive, protected validation and review", async () => fixture(async root => {
  const git = (...args: string[]) => exec("git", args, { cwd: root });
  await git("init", "-q");
  await writeFile(join(root, "input.txt"), "source bytes\n");
  await writeFile(join(root, ".gitignore"), "_testenv/\n.sortie-dogs-v010/\n");
  await git("add", "--", "input.txt", ".gitignore");
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  const missions = new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "request", text: "Prepare an isolated source archive and record evidence." });
  const mission = await missions.start("root", ["Prepare an isolated source archive and record evidence."]);
  const plan = missionPlan(mission, [{ title: "Prepare candidate", objective: "Archive input.txt and record evidence",
    read: ["input.txt"], write: ["_testenv/candidate/"], validation: ["node check.mjs"] }]);
  assert.deepEqual(plan.units[0]!.write, ["_testenv/candidate/**"]);
  const run = await new OperatorRuntime(root, V010_RUNTIME_PROFILE).prepareMission("root", plan);
  const manifestPath = run.units[0]!.manifestPath;
  const bytes = await readFile(manifestPath);
  const manifest = JSON.parse(bytes.toString());
  const project = await createProjectPaths(root), gate = await createWriteGate(project, manifest);
  assert.deepEqual(await canonicalManifestWriteScopes(project, manifest), [join(root, "_testenv/candidate")]);
  const shell = (command: string) => gate.check({ tool: "shell", sessionID: "worker", callID: command },
    { args: { command } }, { investigativeShell: true });
  await shell("mkdir -p _testenv/candidate/snapshot");
  await mkdir(join(root, "_testenv/candidate/snapshot"), { recursive: true });
  await shell("git archive --format=tar --output=_testenv/candidate/source.tar HEAD");
  await git("archive", "--format=tar", "--output=_testenv/candidate/source.tar", "HEAD");
  assert.ok((await readFile(join(root, "_testenv/candidate/source.tar"))).includes(Buffer.from("source bytes")));
  await gate.checkPath("_testenv/candidate/evidence.json");
  await writeFile(join(root, "_testenv/candidate/evidence.json"), '{"result":"PASS"}');
  assert.equal(operatorGitPathAuthorized("_testenv/candidate/evidence.json", manifest.write), true);
  await assert.rejects(gate.checkPath("_testenv/other/result.json"), /write scope/);
  const snapshot = await protectedSnapshot({ manifestPath, projectRoot: root,
    manifestHash: createHash("sha256").update(bytes).digest("hex") });
  assert.ok(snapshot);
  assert.deepEqual(snapshot.binding.candidate_paths, ["_testenv/candidate"]);
  const review = await missionReviewSource(root, run);
  assert.match(review.excerpt, /evidence.json/);
  await writeFile(join(root, "_testenv/candidate/evidence.json"), '{"result":"changed"}');
  assert.notEqual((await refreshProtectedSnapshot(root, snapshot.binding))?.candidate, snapshot.candidate);
  assert.notEqual((await missionReviewSource(root, run)).fingerprint, review.fingerprint);
}));

test("candidate preparation classifies real curl, local archive and tag observation commands", () => {
  const curl = extractWritePaths("shell", { command: "curl --fail --location --show-error --silent --output _testenv/candidate/source.tar.gz --write-out '%{http_code} %{url_effective} %{size_download}\\n' https://github.com/zufall-upon/Sortie-dogs/archive/refs/tags/v0.12.10.tar.gz" });
  assert.equal(curl.ambiguous, false);
  assert.deepEqual(curl.paths, ["_testenv/candidate/source.tar.gz"]);
  for (const command of ["git tag --points-at HEAD", "git tag --contains HEAD", "git archive HEAD"]) {
    const extracted = extractWritePaths("shell", { command });
    assert.equal(extracted.ambiguous, false, command);
    assert.equal(extracted.applies, false, command);
  }
  const redirected = extractWritePaths("shell", { command: "git archive HEAD > _testenv/candidate/source.tar" });
  assert.equal(redirected.ambiguous, false);
  assert.deepEqual(redirected.paths, ["_testenv/candidate/source.tar"]);
  for (const command of ["git tag -d v1", "git archive --remote=https://example.test HEAD", "curl -o result https://example.test -w '%output{other.txt}'"]) {
    assert.equal(extractWritePaths("shell", { command }).ambiguous, true, command);
  }
});

test("mission shell uses native execution policy while known destinations retain common scope checks", async () => fixture(async root => {
  const gate = await createWriteGate(await createProjectPaths(root), {
    version: "0.1.0", task_id: "format-repair", read: [], write: ["output/**"], validation: [],
  });
  const shell = (command: string) => gate.check({ tool: "shell", sessionID: "worker", callID: command }, { args: { command } }, { investigativeShell: true });
  await shell("curl --progress-bar -o output/result https://example.test/result");
  await shell("curl -fLsS -o output/result https://example.test/result");
  await assert.rejects(shell("curl -fLsS -o other/result https://example.test/result"), /Use expand_unit.*retry this command in the SAME active Task/);
  await shell("go test ./vm -run '^TestTypedBindings$' -count=1"); // Opaque program internals are native policy, not formal proof.
  await assert.rejects(gate.check({ tool: "write", sessionID: "worker", callID: "file-write" },
    { args: { filePath: "other/result", content: "result" } }, { investigativeShell: true }), /Use expand_unit.*retry this command in the SAME active Task/);
  await assert.rejects(gate.check({ tool: "shell", sessionID: "legacy", callID: "legacy" },
    { args: { command: "curl --progress-bar -o output/result https://example.test/result" } }), /retry=false/);
}));

test("declared variable-output checks bind without inferring unresolved directory authority", { skip: process.platform === "win32" }, async () => fixture(async root => {
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "check.txt"), "original");
  const command = 'OUT=check.txt; printf ok > "$OUT"';
  const gate = await createWriteGate(await createProjectPaths(root), {
    version: "0.1.0", task_id: "declared-variable-output-inference", read: [],
    write: ["allowed.txt", "unresolved", "declared"],
    validation: [command, 'mkdir -p unresolved; printf ok > "$OUT"', "mkdir -p declared"],
  });
  const check = (command: string, investigativeShell: boolean, workdir = root) => gate.check(
    { tool: "shell", sessionID: "worker", callID: command }, { args: { command, workdir } }, { investigativeShell });
  let adapterCalls = 0;
  for (const mode of [false, true]) {
    await check(command, mode);
    for (const [input, workdir] of [
      ['OUT=check.txt; printf changed > "$OUT"', root],
      [command, join(root, "nested")],
    ] as const) await assert.rejects((async () => {
      await check(input, mode, workdir);
      adapterCalls += 1;
    })(), (error: unknown) => error instanceof WriteDeniedError && error.reason === "manifest-scope");
  }
  assert.equal(adapterCalls, 0);
  assert.equal(await readFile(join(root, "check.txt"), "utf8"), "original");
  assert.equal(existsSync(join(root, "nested/check.txt")), false);
  await assert.rejects(gate.checkPath("unresolved/child.txt"),
    (error: unknown) => error instanceof WriteDeniedError && error.reason === "manifest-scope");
  await gate.checkPath("declared/child.txt");
  await exec("bash", ["-c", command], { cwd: root });
  assert.equal(await readFile(join(root, "check.txt"), "utf8"), "ok");
}));

test("PowerShell immutable cwd and Join-Path dataflow resolves the real destination without evaluating expressions", async () => fixture(async root => {
  const command = "$root=(Get-Location).Path; $d=Join-Path $root 'fixture-output'; New-Item -ItemType Directory -Path $d";
  const gate = await createWriteGate(await createProjectPaths(root), {
    version: "0.1.0", task_id: "static-paths", read: [], write: ["fixture-output/**"], validation: [],
  });
  const args = { command, workdir: root };
  assert.deepEqual(extractWritePaths("shell", args, root).paths, [join(root, "fixture-output")]);
  await gate.check({ tool: "shell", sessionID: "worker", callID: "allowed" }, { args }, { investigativeShell: true });
  for (const denied of [
    command.replace("'fixture-output'", "'other-output'"),
    command.replace("$root=(Get-Location).Path", "$root=Unknown-Expression"),
    command.replace("; New-Item", "; $d='other-output'; New-Item"),
    command.replace("$root=(Get-Location).Path", "$script:root=(Get-Location).Path"),
    command.replace("'fixture-output'", "'../outside'"),
    `& { ${command} }`,
    "Set-Location elsewhere; " + command,
    command.replace("; New-Item", "; echo ($d='other-output'); New-Item"),
    command.replace("-Path $d", "-Value ($d='other-output') -Path $d"),
    "$d=$unknown; New-Item -ItemType Directory -Path $d",
  ]) await assert.rejects(gate.check({ tool: "shell", sessionID: "worker", callID: denied },
    { args: { command: denied, workdir: root } }, { investigativeShell: true }), /Write denied/u, denied);
  const broad = await createWriteGate(await createProjectPaths(root), {
    version: "0.1.0", task_id: "unknown-paths", read: [], write: [root.replaceAll("\\", "/") + "/**"], validation: [],
  });
  await assert.rejects(broad.check({ tool: "shell", sessionID: "worker", callID: "unknown" },
    { args: { command: "$d=Unknown-Expression; New-Item -Path $d", workdir: root } }, { investigativeShell: true }), /Write denied/u);
  await assert.rejects(broad.check({ tool: "shell", sessionID: "worker", callID: "nested-unknown" },
    { args: { command: "pwsh -NoProfile -Command '$d=Unknown-Expression; New-Item -Path $d'", workdir: root } }, { investigativeShell: true }), /Write denied/u);
  assert.deepEqual(extractWritePaths("shell", { command: "$root='fixture-output'; $d=Join-Path $root 'child'; New-Item -Path $d" }, root).paths,
    [join(root, "fixture-output/child")]);
}));

test("PowerShell executable prefixes cannot restore immutable path authority after alias shadowing", async () => fixture(async root => {
  const gate = await createWriteGate(await createProjectPaths(root), {
    version: "0.1.0", task_id: "shadowed-path-command", read: [], write: ["src/scratch", "allowed.txt"], validation: [],
  });
  const check = (command: string) => gate.check({ tool: "shell", sessionID: "worker", callID: command },
    { args: { command, workdir: root } }, { investigativeShell: true });
  const definitions = "$r='src'; $d=Join-Path $r 'scratch'; Set-Content -Path $d -Value content";
  for (const prefix of [
    "Set-Alias Join-Path Move-Item",
    "Set-Alias -Name Join-Path -Value Move-Item",
    "Unknown-Setup",
    "$setup=Unknown-Setup",
    "Write-Output initialized",
  ]) {
    const command = `${prefix}; ${definitions}`;
    assert.throws(() => extractWritePaths("powershell", { command }, root), /Write denied/u, command);
    await assert.rejects(check(command), /Write denied/u, command);
  }
  await assert.rejects(check("Set-Alias Get-Location Remove-Item; $r=(Get-Location).Path; $d=Join-Path $r 'scratch'; Set-Content -Path $d -Value content"), /Write denied/u);
  // The restriction applies to inferred variable destinations, not opaque native
  // execution itself or a directly declared literal write after such a prefix.
  await check("Set-Alias Join-Path Move-Item; Set-Content -Path 'allowed.txt' -Value content");
  assert.deepEqual(extractWritePaths("powershell", { command: definitions }, root).paths, [join(root, "src/scratch")]);
  await check(definitions);
}));

test("PowerShell engine-owned variables cannot become immutable local path facts", async () => fixture(async root => {
  const gate = await createWriteGate(await createProjectPaths(root), {
    version: "0.1.0", task_id: "engine-owned-paths", read: [], write: ["allowed.txt", "fixture-output/**"], validation: [],
  });
  // Constants/read-only automatic variables and typed/validated preferences do not
  // share ordinary local-string assignment semantics. Errors can be nonterminating.
  for (const variable of ["true", "false", "PID", "IsWindows", "ConfirmPreference", "ErrorActionPreference", "MaximumHistoryCount", "OutputEncoding"]) {
    const command = `$ErrorActionPreference='Continue'; $${variable}='allowed.txt'; Set-Content -Path $${variable} -Value changed`;
    assert.throws(() => extractWritePaths("powershell", { command }, root), /Write denied/u, variable);
    await assert.rejects(gate.check({ tool: "shell", sessionID: "worker", callID: variable },
      { args: { command, workdir: root } }, { investigativeShell: true }), /Write denied/u, variable);
  }
  const command = "$ErrorActionPreference='Stop'; $root=(Get-Location).Path; $d=Join-Path $root 'fixture-output'; New-Item -ItemType Directory -Path $d";
  assert.deepEqual(extractWritePaths("powershell", { command }, root).paths, [join(root, "fixture-output")]);
  await gate.check({ tool: "shell", sessionID: "worker", callID: "ordinary-locals" },
    { args: { command, workdir: root } }, { investigativeShell: true });
}));

test("PowerShell pipeline and background assignment cannot publish a destination before the RHS runs", async () => fixture(async root => {
  const gate = await createWriteGate(await createProjectPaths(root), {
    version: "0.1.0", task_id: "pipeline-path", read: [], write: ["allowed.txt"], validation: [],
  });
  for (const operator of ["|", "&"]) {
    const command = `Set-Variable -Name d -Value 'forbidden.txt'; $d='allowed.txt' ${operator} Set-Content -Path $d`;
    assert.throws(() => extractWritePaths("powershell", { command }, root), /Write denied/u);
    await assert.rejects(gate.check({ tool: "shell", sessionID: "worker", callID: command },
      { args: { command: `$seed='unused'; ${command}`, workdir: root } }, { investigativeShell: true }), /Write denied/u);
  }
}));

test("PowerShell literal-dollar destinations keep quote provenance without granting variable expansion", async () => fixture(async root => {
  await mkdir(join(root, "archives/$id"), { recursive: true });
  const gate = await createWriteGate(await createProjectPaths(root), {
    version: "0.1.0", task_id: "literal-dollar", read: [], write: ["routes/$id.tsx", "archives/$id/**"], validation: [],
  });
  const shell = (command: string) => gate.check({ tool: "shell", sessionID: "worker", callID: command },
    { args: { command: `$seed='unused'; ${command}`, workdir: root } }, { investigativeShell: true });
  const strict = (command: string) => gate.check({ tool: "powershell", sessionID: "worker", callID: command },
    { args: { command, workdir: root } });
  for (const [command, target] of [
    ["Set-Content -LiteralPath 'routes/$id.tsx' -Value content", "routes/$id.tsx"],
    ["Add-Content -Path 'routes/$id.tsx' -Value $id", "routes/$id.tsx"],
    ["New-Item -Path 'routes/$id.tsx'", "routes/$id.tsx"],
    ["Remove-Item -LiteralPath 'routes/$id.tsx'", "routes/$id.tsx"],
    ["Out-File -FilePath 'routes/$id.tsx'", "routes/$id.tsx"],
    ["touch 'routes/$id.tsx'", "routes/$id.tsx"],
    ["echo content > 'routes/$id.tsx'", "routes/$id.tsx"],
    ["curl.exe -o 'routes/$id.tsx' https://example.test/result", "routes/$id.tsx"],
    ["& 'curl.exe' --output 'routes/$id.tsx' https://example.test/result", "routes/$id.tsx"],
    ["curl.exe --output='routes/$id.tsx' https://example.test/result", "routes/$id.tsx"],
    ["Invoke-WebRequest -Uri https://example.test/result -OutFile 'routes/$id.tsx'", "routes/$id.tsx"],
    ["iwr -OutFile 'routes/$id.tsx' -Uri https://example.test/result", "routes/$id.tsx"],
    ["tar -xf input.tar -C 'archives/$id'", "archives/$id"],
    ["tar -xf input.tar --directory='archives/$id'", "archives/$id"],
    ["git archive --format=tar --output 'routes/$id.tsx' HEAD", "routes/$id.tsx"],
    ["git archive --format=tar --output='routes/$id.tsx' HEAD", "routes/$id.tsx"],
    ["Copy-Item -LiteralPath 'source/$id.tsx' -Destination 'routes/$id.tsx'", "routes/$id.tsx"],
    ["Robocopy.exe 'source' 'routes' '$id.tsx'", "routes/$id.tsx"],
    ["Robocopy.exe source 'archives/$id' ok.tsx", "archives/$id/ok.tsx"],
    ["pwsh -NoProfile -Command 'Set-Content -LiteralPath ''routes/$id.tsx'' -Value content'", "routes/$id.tsx"],
    ["pwsh -NoProfile -Command 'curl.exe -o ''routes/$id.tsx'' https://example.test/result'", "routes/$id.tsx"],
  ] as const) {
    const extracted = extractWritePaths("powershell", { command }, root);
    assert.equal(extracted.ambiguous, false, command);
    assert.deepEqual(extracted.paths, [join(root, target)], command);
    await shell(command);
    await strict(command);
  }
  for (const command of [
    "curl.exe -o 'routes/$other.tsx' https://example.test/result",
    "Invoke-WebRequest -Uri https://example.test/result -OutFile 'routes/$other.tsx'",
    "tar -xf input.tar -C 'archives/$other'",
    "git archive --output 'routes/$other.tsx' HEAD",
    "Copy-Item -Path input.txt -Destination 'routes/$other.tsx'",
    "Robocopy.exe 'source' 'routes' '$other.tsx'",
  ]) {
    const scopeDenied = (error: unknown) => error instanceof WriteDeniedError && error.reason === "manifest-scope";
    await assert.rejects(shell(command), scopeDenied, command);
    await assert.rejects(strict(command), scopeDenied, command);
  }
  for (const command of [
    'Set-Content -LiteralPath "routes/$id.tsx" -Value content',
    "Set-Content -Path $id -Value 'routes/$id.tsx'",
    'Set-Content -Path "\'$id\'" -Value content',
    "echo content > $id",
    'curl.exe -o "routes/$id.tsx" https://example.test/result',
    "curl.exe -o $id https://example.test/result",
    'curl.exe --output="\'routes/$id.tsx\'" https://example.test/result',
    'Invoke-WebRequest -Uri https://example.test/result -OutFile "routes/$id.tsx"',
    'tar -xf input.tar -C "archives/$id"',
    'git archive --output "routes/$id.tsx" HEAD',
    'Copy-Item -Path input.txt -Destination "routes/$id.tsx"',
    'Robocopy.exe source routes "$id.tsx"',
    'Robocopy.exe source "archives/$id" ok.tsx',
    "curl.exe -o 'routes/$id.tsx' https://example.test/result; curl.exe -o $id https://example.test/result",
  ]) {
    await assert.rejects(shell(command), (error: unknown) => error instanceof WriteDeniedError && error.reason === "manifest-scope", command);
    await assert.rejects(strict(command), (error: unknown) => error instanceof WriteDeniedError &&
      ["manifest-scope", "unclassified-command"].includes(error.reason), command);
  }
  const reviewerGate = await createWriteGate(await createProjectPaths(root), {
    version: "0.1.0", task_id: "reviewer-literal-dollar", read: [], write: ["asset$id.json"], validation: [],
  });
  for (const command of [
    "$seed='unused'; curl.exe -o 'asset$id.json' https://example.test/result",
    "$seed='unused'; Invoke-WebRequest -Uri https://example.test/result -OutFile 'asset$id.json'",
  ]) {
    assert.deepEqual(extractWritePaths("shell", { command, workdir: root }, root).paths, [join(root, "asset$id.json")]);
    await reviewerGate.check({ tool: "shell", sessionID: "reviewer", callID: command },
      { args: { command, workdir: root } }, { investigativeShell: true });
  }
}));

test("inline output options retain literal quotes protected by whole-argument quoting", { skip: process.platform === "win32" }, async () => fixture(async root => {
  await mkdir(join(root, "archives"));
  await mkdir(join(root, '"archives"'));
  const manifest = { version: "0.1.0", task_id: "inline-quote-provenance", read: [], validation: [] };
  const narrow = await createWriteGate(await createProjectPaths(root), { ...manifest, write: ["allowed.json", "archives/**"] });
  const literal = await createWriteGate(await createProjectPaths(root), {
    ...manifest, write: ['"allowed.json"', "'allowed.json'", '"archives"/**'],
  });
  for (const [command, target] of [
    [`curl '--output="allowed.json"' https://example.test/result`, '"allowed.json"'],
    [`curl --output='"allowed.json"' https://example.test/result`, '"allowed.json"'],
    [`curl "--output='allowed.json'" https://example.test/result`, "'allowed.json'"],
    [`tar -xf input.tar '--directory="archives"'`, '"archives"'],
    [`git archive '--output="allowed.json"' HEAD`, '"allowed.json"'],
  ] as const) {
    assert.deepEqual(extractWritePaths("shell", { command, workdir: root }, root).paths, [join(root, target)], command);
    const request = { tool: "shell", sessionID: "worker", callID: command };
    const output = { args: { command, workdir: root } };
    await assert.rejects(narrow.check(request, output, { investigativeShell: true }),
      (error: unknown) => error instanceof WriteDeniedError && error.reason === "manifest-scope", command);
    await literal.check(request, output, { investigativeShell: true });
  }
  for (const command of [
    `curl --output="allowed.json" https://example.test/result`,
    `curl '--output=allowed.json' https://example.test/result`,
    `tar -xf input.tar --directory='archives'`,
    `git archive --output='allowed.json' HEAD`,
  ]) await narrow.check({ tool: "shell", sessionID: "worker", callID: command }, { args: { command, workdir: root } });
}));

test("POSIX dollar destinations preserve literal quoting without authorizing variable expansion", { skip: process.platform === "win32" }, async () => fixture(async root => {
  await mkdir(join(root, "archives/$id"), { recursive: true });
  const gate = await createWriteGate(await createProjectPaths(root), {
    version: "0.1.0", task_id: "posix-inline-dollar-provenance", read: [],
    write: ["routes/$id.tsx", "archives/$id/**"], validation: [],
  });
  const check = (command: string, investigativeShell: boolean) => gate.check({ tool: "shell", sessionID: "worker", callID: command },
    { args: { command, workdir: root } }, { investigativeShell });
  const native = await exec("bash", ["-c", 'id=outside; printf "%s" --output="routes/$id.tsx"']);
  assert.equal(native.stdout, "--output=routes/outside.tsx", "double quotes do not make a POSIX dollar path literal");
  for (const command of [
    'curl --output="routes/$id.tsx" https://example.test/result',
    'tar -xf input.tar --directory="archives/$id"',
    'git archive --output="routes/$id.tsx" HEAD',
    'curl "--output=routes/$id.tsx" https://example.test/result',
    'curl -o "routes/$id.tsx" https://example.test/result',
    'tar -xf input.tar -C "archives/$id"',
    'git archive --output "routes/$id.tsx" HEAD',
    'echo content > "routes/$id.tsx"',
    'mkdir -p "archives/$id/new"',
    'id=outside; curl --output="routes/$id.tsx" https://example.test/result',
  ]) {
    for (const investigativeShell of [false, true]) await assert.rejects(check(command, investigativeShell),
      (error: unknown) => error instanceof WriteDeniedError && error.reason === "manifest-scope", command);
  }
  for (const [command, target] of [
    ["curl --output='routes/$id.tsx' https://example.test/result", "routes/$id.tsx"],
    ["tar -xf input.tar --directory='archives/$id'", "archives/$id"],
    ["git archive --output='routes/$id.tsx' HEAD", "routes/$id.tsx"],
    ["curl '--output=routes/$id.tsx' https://example.test/result", "routes/$id.tsx"],
    ["curl -o 'routes/$id.tsx' https://example.test/result", "routes/$id.tsx"],
    ["tar -xf input.tar -C 'archives/$id'", "archives/$id"],
    ["git archive --output 'routes/$id.tsx' HEAD", "routes/$id.tsx"],
    ["echo content > 'routes/$id.tsx'", "routes/$id.tsx"],
    ["mkdir -p 'archives/$id/new'", "archives/$id/new"],
    ["touch 'routes/$id.tsx'", "routes/$id.tsx"],
  ] as const) {
    assert.deepEqual(extractWritePaths("shell", { command, workdir: root }, root).paths, [join(root, target)], command);
    await check(command, false);
    await check(command, true);
  }
  await assert.rejects(check("curl --output='routes/$other.tsx' https://example.test/result", true),
    (error: unknown) => error instanceof WriteDeniedError && error.reason === "manifest-scope");
}));

test("POSIX line continuations retain copy and move destinations before the adapter", { skip: process.platform === "win32" }, async () => fixture(async root => {
  await writeFile(join(root, "source"), "fixture source\n");
  await writeFile(join(root, "outside"), "outside original\n");
  const gate = await createWriteGate(await createProjectPaths(root), {
    version: "0.1.0", task_id: "line-continuation-destinations", read: [],
    write: ["source", "allowed", "installed", "moved"], validation: [],
  });
  const check = (command: string, investigativeShell: boolean) => gate.check(
    { tool: "shell", sessionID: "worker", callID: command },
    { args: { command, workdir: root } }, { investigativeShell });
  let adapterCalls = 0;
  for (const [command, expected] of [
    ["cp source\\\n outside", ["outside"]],
    ["env -u UNUSED cp source\\\n outside", ["outside"]],
    ["cp sou\\\nrce out\\\nside", ["outside"]],
    ['cp "so\\\nurce" outside', ["outside"]],
    ["install source\\\n outside", ["outside"]],
    ["mv source\\\n outside", ["source", "outside"]],
  ] as const) {
    assert.deepEqual(extractWritePaths("shell", { command, workdir: root }, root).paths,
      expected.map(path => join(root, path)), command);
    for (const mode of [false, true]) await assert.rejects((async () => {
      await check(command, mode);
      adapterCalls += 1;
    })(), (error: unknown) => error instanceof WriteDeniedError && error.reason === "manifest-scope", command);
  }
  assert.equal(adapterCalls, 0);
  assert.equal(await readFile(join(root, "source"), "utf8"), "fixture source\n");
  assert.equal(await readFile(join(root, "outside"), "utf8"), "outside original\n");

  for (const [command, target] of [
    ["cp source\\\n allowed", "allowed"],
    ["install source\\\n installed", "installed"],
    ["mv source\\\n moved", "moved"],
  ] as const) {
    for (const mode of [false, true]) await check(command, mode);
    await exec("bash", ["-c", command], { cwd: root });
    assert.equal(await readFile(join(root, target), "utf8"), "fixture source\n");
  }
  assert.equal(existsSync(join(root, "source")), false);
  assert.equal(await readFile(join(root, "outside"), "utf8"), "outside original\n");
}));

test("POSIX comments end at newline without hiding writes or changing literal hash words", { skip: process.platform === "win32" }, async () => fixture(async root => {
  await writeFile(join(root, "source"), "fixture source\n");
  await writeFile(join(root, "outside"), "outside original\n");
  const gate = await createWriteGate(await createProjectPaths(root), {
    version: "0.1.0", task_id: "posix-comment-boundaries", read: [],
    write: ["allowed#literal", "allowed#quoted", "allowed#patch"], validation: [],
  });
  const check = (command: string, investigativeShell: boolean) => gate.check(
    { tool: "shell", sessionID: "worker", callID: command },
    { args: { command, workdir: root } }, { investigativeShell });
  let adapterCalls = 0;
  for (const [command, target] of [
    ["echo ready # note \\\ncp source outside", "outside"],
    ["# note \\\ncp source absent", "absent"],
    ["echo ready;# note \\\ncp source outside", "outside"],
    ["echo ready # unterminated ' \" <<PATCH > ignored \\\ncp source outside", "outside"],
  ] as const) {
    const args = { command, workdir: root };
    const extracted = extractWritePaths("shell", args, root);
    assert.deepEqual(extracted.paths, [join(root, target)], command);
    assert.equal(isKnownReadOnlyTool("shell", args), false, command);
    for (const mode of [false, true]) await assert.rejects((async () => {
      await check(command, mode);
      adapterCalls += 1;
    })(), (error: unknown) => error instanceof WriteDeniedError && error.reason === "manifest-scope", command);
  }
  assert.equal(adapterCalls, 0);
  assert.equal(await readFile(join(root, "outside"), "utf8"), "outside original\n");
  assert.equal(existsSync(join(root, "absent")), false);

  for (const command of [
    "echo ready # fake > outside; cp source outside ' \" \\\nprintf safe",
    "echo foo\\ #not-comment\\\ncp source outside",
    "echo \\#not-comment\\\ncp source outside",
    "echo foo\\\n#not-comment",
  ]) {
    const args = { command, workdir: root };
    assert.equal(isKnownReadOnlyTool("shell", args), true, command);
    assert.deepEqual(extractWritePaths("shell", args, root).paths, [], command);
    for (const mode of [false, true]) await check(command, mode);
  }
  assert.equal((await exec("bash", ["-c", "echo foo\\ #not-comment\\\ncp source outside"], { cwd: root })).stdout,
    "foo #not-commentcp source outside\n");
  for (const [command, target] of [
    ["cp source allowed\\\n#literal", "allowed#literal"],
    ["cp source 'allowed#quoted'", "allowed#quoted"],
  ] as const) {
    assert.deepEqual(extractWritePaths("shell", { command, workdir: root }, root).paths, [join(root, target)]);
    for (const mode of [false, true]) await check(command, mode);
    await exec("bash", ["-c", command], { cwd: root });
    assert.equal(await readFile(join(root, target), "utf8"), "fixture source\n");
  }

  const body = "--- /dev/null\n+++ b/allowed#patch\n@@ -0,0 +1,2 @@\n+literal # \\\n+tail\n";
  const heredoc = `apply_patch <<'PATCH' # trailing \\\n${body}PATCH`;
  assert.deepEqual(extractWritePaths("shell", { command: heredoc, workdir: root }, root).paths, [join(root, "allowed#patch")]);
  const appended = `${heredoc}\ncp source outside`;
  assert.deepEqual(extractWritePaths("shell", { command: appended, workdir: root }, root).paths,
    [join(root, "allowed#patch"), join(root, "outside")]);
  assert.equal(isKnownReadOnlyTool("shell", { command: appended, workdir: root }), false);
  for (const mode of [false, true]) await assert.rejects((async () => {
    await check(appended, mode);
    adapterCalls += 1;
  })(), (error: unknown) => error instanceof WriteDeniedError && error.reason === "manifest-scope");
  assert.equal(adapterCalls, 0);
  assert.equal(existsSync(join(root, "allowed#patch")), false);
  for (const mode of [false, true]) await check(heredoc, mode);
  await exec("bash", ["-c", `apply_patch() { patch -p1 -s; }; ${heredoc}`], { cwd: root });
  assert.equal(await readFile(join(root, "allowed#patch"), "utf8"), "literal # \\\ntail\n");
  assert.equal(await readFile(join(root, "outside"), "utf8"), "outside original\n");
}));

test("literal heredoc stdin does not mask known header or following output destinations", { skip: process.platform === "win32" }, async () => fixture(async root => {
  await writeFile(join(root, "outside.txt"), "unchanged\n");
  const gate = await createWriteGate(await createProjectPaths(root), {
    version: "0.1.0", task_id: "literal-heredoc-known-outputs", read: [], write: ["allowed.txt"], validation: [],
  });
  const data = "<<'EXPECTED'\ntar -xzf archive.tar.gz\nEXPECTED";
  const check = (command: string, investigativeShell: boolean) => gate.check(
    { tool: "shell", sessionID: "worker", callID: command }, { args: { command, workdir: root } }, { investigativeShell });
  for (const command of [`cat > outside.txt ${data}`, `cat ${data}\nprintf changed > outside.txt`]) {
    for (const mode of [false, true]) await assert.rejects(check(command, mode),
      (error: unknown) => error instanceof WriteDeniedError && error.reason === "manifest-scope");
  }
  assert.equal(await readFile(join(root, "outside.txt"), "utf8"), "unchanged\n");
  const allowed = `cat > allowed.txt ${data}`;
  for (const mode of [false, true]) await check(allowed, mode);
  await exec("bash", ["-c", allowed], { cwd: root });
  assert.equal(await readFile(join(root, "allowed.txt"), "utf8"), "tar -xzf archive.tar.gz\n");
}));

test("shell patch bodies retain literal path provenance without trusting expansions", { skip: process.platform === "win32" }, async () => fixture(async root => {
  await mkdir(join(root, "routes"));
  await writeFile(join(root, "routes/outside.tsx"), "unchanged\n");
  await writeFile(join(root, "2file"), "numeric prefix unchanged\n");
  const gate = await createWriteGate(await createProjectPaths(root), {
    version: "0.1.0", task_id: "shell-patch-provenance", read: [],
    write: ["routes/$id.tsx", "routes/$heredoc.tsx", "routes/$moved.tsx", "routes/$redirected.tsx", "routes/static.tsx", "routes/log.txt", "2"], validation: [],
  });
  const patch = "*** Begin Patch\n*** Add File: routes/$id.tsx\n+literal\n*** End Patch";
  const command = `apply_patch '${patch}'`;
  const check = (command: string, investigativeShell: boolean) => gate.check(
    { tool: "shell", sessionID: "worker", callID: command },
    { args: { command, workdir: root } }, { investigativeShell });
  assert.deepEqual(extractWritePaths("shell", { command, workdir: root }, root).paths, [join(root, "routes/$id.tsx")]);
  for (const mode of [false, true]) await check(command, mode);
  const observed = await exec("bash", ["-c", `id=outside; apply_patch() { printf '%s' "$1"; }; ${command}`], { cwd: root });
  assert.equal(observed.stdout, patch, "the native shell passes the exact literal envelope");
  for (const redirected of [
    `${command} > /dev/null`,
    `env -u UNUSED ${command}>/dev/null`,
    `${command} > routes/log.txt`,
    `${command} > 2 > routes/log.txt`,
  ]) for (const mode of [false, true]) await check(redirected, mode);
  assert.deepEqual(extractWritePaths("shell", { command: `${command} > routes/log.txt`, workdir: root }, root).paths,
    [join(root, "routes/log.txt"), join(root, "routes/$id.tsx")]);
  assert.deepEqual(extractWritePaths("shell", { command: `${command} > 2file`, workdir: root }, root).paths,
    [join(root, "2file"), join(root, "routes/$id.tsx")]);

  // Use the native patch program as a local consumer of the shell argument; this
  // checks the real destination, not just the gate's extracted path or fake adapter.
  const unified = "--- /dev/null\n+++ b/routes/$id.tsx\n@@ -0,0 +1 @@\n+literal\n";
  const unifiedCommand = `apply_patch '${unified}'`;
  for (const mode of [false, true]) await check(unifiedCommand, mode);
  await exec("bash", ["-c", `apply_patch() { printf '%s' "$1" | patch -p1 -s; }; ${unifiedCommand}`], { cwd: root });
  assert.equal(await readFile(join(root, "routes/$id.tsx"), "utf8"), "literal\n");
  const redirectedUnified = "--- /dev/null\n+++ b/routes/$redirected.tsx\n@@ -0,0 +1,2 @@\n+line\\\n+tail\n";
  const redirectedCommand = `apply_patch '${redirectedUnified}' > /dev/null`;
  for (const mode of [false, true]) await check(redirectedCommand, mode);
  await exec("bash", ["-c", `apply_patch() { printf '%s' "$1" | patch -p1 -s; }; ${redirectedCommand}`], { cwd: root });
  assert.equal(await readFile(join(root, "routes/$redirected.tsx"), "utf8"), "line\\\ntail\n");

  const herePatch = "--- /dev/null\n+++ b/routes/$heredoc.tsx\n@@ -0,0 +1,2 @@\n+quoted ' $()\\\n+tail\n";
  const heredoc = `apply_patch <<'PATCH'\n${herePatch}PATCH`;
  assert.deepEqual(extractWritePaths("shell", { command: heredoc, workdir: root }, root).paths, [join(root, "routes/$heredoc.tsx")]);
  for (const mode of [false, true]) await check(heredoc, mode);
  await exec("bash", ["-c", `apply_patch() { patch -p1 -s; }; ${heredoc}`], { cwd: root });
  assert.equal(await readFile(join(root, "routes/$heredoc.tsx"), "utf8"), "quoted ' $()\\\ntail\n");
  for (const mode of [false, true]) {
    await check(`env -u UNUSED apply_patch<<"PATCH-END"\n${patch}\nPATCH-END`, mode);
    await check(`apply_patch <<-'PATCH'\n\t${patch.replaceAll("\n", "\n\t")}\n\tPATCH`, mode);
    await check(`apply_patch <<PATCH\n${patch.replace("routes/$id.tsx", "routes/static.tsx")}\nPATCH`, mode);
    await check(`apply_patch "${patch.replace("routes/$id.tsx", "routes/static.tsx")}"`, mode);
  }

  const move = "*** Begin Patch\n*** Update File: routes/$id.tsx\n*** Move to: routes/$moved.tsx\n@@\n-literal\n+moved\n*** End Patch";
  for (const mode of [false, true]) await check(`env -u UNUSED apply_patch '${move}'`, mode);
  await gate.check({ tool: "apply_patch", sessionID: "worker", callID: "native" }, { args: { patchText: move } });
  await assert.rejects(gate.check({ tool: "apply_patch", sessionID: "worker", callID: "native-outside" },
    { args: { patchText: patch.replace("routes/$id.tsx", "routes/outside.tsx") } }),
  (error: unknown) => error instanceof WriteDeniedError && error.reason === "manifest-scope");

  let adapterCalls = 0;
  for (const denied of [
    `apply_patch "${patch}"`,
    'apply_patch "$PATCH"',
    'apply_patch "$(printf %s "$PATCH")"',
    `apply_patch '${patch}'"$suffix"`,
    `apply_patch <<PATCH\n${patch}\nPATCH`,
    "apply_patch <<PATCH\n$PATCH\nPATCH",
    `apply_patch <<PATCH\n${patch.replace("routes/$id.tsx", "routes/static.tsx").replace("+literal", "+$PATCH")}\nPATCH`,
    `apply_patch<<'PATCH.1'\n${patch}\nPATCH.1`,
    `apply_patch <<'PATCH'\n${patch}`,
    `apply_patch "${patch}" > /dev/null`,
    'apply_patch "$PATCH" > /dev/null',
    `apply_patch '${patch}'"$suffix" > /dev/null`,
    `${command} > /dev/null unexpected`,
    `${command} > "$output"`,
  ]) for (const mode of [false, true]) {
    await assert.rejects((async () => { await check(denied, mode); adapterCalls += 1; })(),
      (error: unknown) => error instanceof WriteDeniedError && (mode ? error.reason === "manifest-scope" :
        ["manifest-scope", "unclassified-command", "path-required"].includes(error.reason)), denied);
  }
  for (const denied of [
    `apply_patch '${patch.replace("routes/$id.tsx", "routes/outside.tsx")}'`,
    `apply_patch <<'PATCH'\n${patch.replace("routes/$id.tsx", "routes/outside.tsx")}\nPATCH`,
    `apply_patch '${move.replace("routes/$moved.tsx", "routes/outside.tsx")}'`,
    `apply_patch '${patch.replace("routes/$id.tsx", "routes/outside.tsx")}' > /dev/null`,
    `${command} > routes/outside.tsx`,
    `${command} > 2file`,
    `printf changed > routes/outside.tsx; ${heredoc}`,
    `${heredoc}\nprintf changed > routes/outside.tsx`,
  ]) for (const mode of [false, true]) {
    await assert.rejects((async () => { await check(denied, mode); adapterCalls += 1; })(),
      (error: unknown) => error instanceof WriteDeniedError && error.reason === "manifest-scope", denied);
  }
  assert.equal(adapterCalls, 0);
  assert.equal(existsSync(join(root, "routes/log.txt")), false);
  assert.equal(await readFile(join(root, "routes/outside.tsx"), "utf8"), "unchanged\n");
  assert.equal(await readFile(join(root, "2file"), "utf8"), "numeric prefix unchanged\n");
  assert.equal(await readFile(join(root, "routes/$id.tsx"), "utf8"), "literal\n");
}));

test("quoted-prefix output regressions retain the original allowed and denied file layout", { skip: process.platform === "win32" }, async () => fixture(async root => {
  await writeFile(join(root, "allowed"), "allowed original");
  await writeFile(join(root, "allowed-denied"), "denied original");
  await writeFile(join(root, "input.txt"), "archive fixture\n");
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["add", "input.txt"], { cwd: root });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], { cwd: root });
  const gate = await createWriteGate(await createProjectPaths(root), {
    version: "0.1.0", task_id: "quoted-prefix-original-layout", read: [], write: ["allowed"], validation: [],
  });
  let adapterCalls = 0;
  for (const command of ["printf changed > 'allowed'$suffix", "git archive '--output=allowed'$suffix HEAD"]) {
    for (const investigativeShell of [false, true]) {
      await assert.rejects((async () => {
        await gate.check({ tool: "shell", sessionID: "worker", callID: command },
          { args: { command, workdir: root } }, { investigativeShell });
        adapterCalls += 1;
      })(), (error: unknown) => error instanceof WriteDeniedError && error.reason === "manifest-scope", command);
    }
  }
  assert.equal(adapterCalls, 0);
  assert.equal(await readFile(join(root, "allowed"), "utf8"), "allowed original");
  assert.equal(await readFile(join(root, "allowed-denied"), "utf8"), "denied original");
  await writeFile(join(root, "'allowed"), "allowed original");
  await writeFile(join(root, "allowed part-denied"), "denied original");
  const mixedGate = await createWriteGate(await createProjectPaths(root), {
    version: "0.1.0", task_id: "mixed-quote-original-layout", read: [], write: ["'allowed"], validation: [],
  });
  const mixed = "git archive --output='allowed part'$suffix HEAD";
  for (const investigativeShell of [false, true]) {
    await assert.rejects((async () => {
      await mixedGate.check({ tool: "shell", sessionID: "worker", callID: mixed },
        { args: { command: mixed, workdir: root } }, { investigativeShell });
      adapterCalls += 1;
    })(), (error: unknown) => error instanceof WriteDeniedError && error.reason === "manifest-scope");
  }
  assert.equal(adapterCalls, 0);
  assert.equal(await readFile(join(root, "'allowed"), "utf8"), "allowed original");
  assert.equal(await readFile(join(root, "allowed part-denied"), "utf8"), "denied original");
}));

test("POSIX output provenance blocks concatenated redirect and option destinations before the adapter", { skip: process.platform === "win32" }, async () => fixture(async root => {
  await mkdir(join(root, "allowed"));
  await mkdir(join(root, "denied"));
  await writeFile(join(root, "denied/keep.txt"), "unchanged\n");
  await writeFile(join(root, "input.txt"), "archive fixture\n");
  const run = (file: string, args: string[]) => exec(file, args, { cwd: root });
  await run("git", ["init", "-q"]);
  await run("git", ["add", "input.txt"]);
  await run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
  const gate = await createWriteGate(await createProjectPaths(root), {
    version: "0.1.0", task_id: "concatenated-output", read: [], write: ["allowed/**"], validation: [],
  });
  let adapterCalls = 0;
  const blocked = async (command: string, investigativeShell: boolean) => {
    await gate.check({ tool: "shell", sessionID: "worker", callID: command },
      { args: { command, workdir: root } }, { investigativeShell });
    adapterCalls += 1; // A fake adapter proves only that rejection happens before execution.
  };
  for (const command of [
    "printf changed > 'allowed'$suffix",
    "git archive '--output=allowed'$suffix HEAD",
    "env -u UNUSED git archive --output 'allowed'$suffix HEAD",
    "git archive --output=allowed/'prefix'foo HEAD",
    "curl -o 'allowed'$suffix https://example.test/result",
    "tar -xf input.tar -C 'allowed'$suffix",
    "printf changed > 'denied/keep.txt'",
    "printf changed > '/dev/null'$suffix",
  ]) {
    for (const investigativeShell of [false, true]) {
      await assert.rejects(blocked(command, investigativeShell), (error: unknown) => error instanceof WriteDeniedError &&
        (investigativeShell ? error.reason === "manifest-scope" : ["manifest-scope", "unclassified-command"].includes(error.reason)), command);
    }
  }
  assert.equal(adapterCalls, 0);
  assert.equal(await readFile(join(root, "denied/keep.txt"), "utf8"), "unchanged\n");
  assert.equal(existsSync(join(root, "denied/output.tar")), false);
  for (const investigativeShell of [false, true]) {
    await gate.check({ tool: "shell", sessionID: "worker", callID: "discard" },
      { args: { command: "printf ignored > /dev/null", workdir: root } }, { investigativeShell });
  }

  const allowed = async (command: string, target: string) => {
    const args = { command, workdir: root };
    assert.deepEqual(extractWritePaths("shell", args, root).paths, [join(root, target)], command);
    for (const investigativeShell of [false, true]) {
      await gate.check({ tool: "shell", sessionID: "worker", callID: command }, { args }, { investigativeShell });
    }
    await run("bash", ["-c", command]);
  };
  await allowed("env -u UNUSED git archive --format=tar --output='allowed/$id.tar' HEAD", "allowed/$id.tar");
  assert.equal((await run("tar", ["-xOf", "allowed/$id.tar", "input.txt"])).stdout, "archive fixture\n");
  await allowed("env -u UNUSED git archive --output 'allowed/$separate.tar' HEAD", "allowed/$separate.tar");
  assert.equal((await run("tar", ["-xOf", "allowed/$separate.tar", "input.txt"])).stdout, "archive fixture\n");
  await allowed("git archive '--output=allowed/\"quoted\".tar' HEAD", 'allowed/"quoted".tar');
  assert.equal((await run("tar", ["-xOf", 'allowed/"quoted".tar', "input.txt"])).stdout, "archive fixture\n");
  await mkdir(join(root, "allowed/$dir"));
  await allowed("env -u UNUSED tar -xf 'allowed/$id.tar' --directory='allowed/$dir'", "allowed/$dir");
  assert.equal(await readFile(join(root, "allowed/$dir/input.txt"), "utf8"), "archive fixture\n");
  await allowed("printf literal > 'allowed/$id.txt'", "allowed/$id.txt");
  assert.equal(await readFile(join(root, "allowed/$id.txt"), "utf8"), "literal");
  await allowed("printf literal > 'allowed/with space $id.txt'", "allowed/with space $id.txt");
  assert.equal(await readFile(join(root, "allowed/with space $id.txt"), "utf8"), "literal");
}));

test("POSIX backslash output words cannot authorize normalized directory aliases", { skip: process.platform === "win32" }, async () => fixture(async root => {
  await mkdir(join(root, "allowed"));
  await writeFile(join(root, "input.txt"), "archive fixture\n");
  await writeFile(join(root, "allowed/outside.tar"), "allowed original\n");
  await writeFile(join(root, "allowed\\outside.tar"), "outside original\n");
  const run = (file: string, args: string[]) => exec(file, args, { cwd: root });
  await run("git", ["init", "-q"]);
  await run("git", ["add", "input.txt"]);
  await run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
  // Native POSIX interpretation, independently of the gate: this is a filename
  // containing a backslash, not a child of the allowed directory.
  await run("bash", ["-c", String.raw`git archive --output="allowed\\native-oracle.tar" HEAD`]);
  assert.ok((await readFile(join(root, "allowed\\native-oracle.tar"))).includes(Buffer.from("archive fixture\n")));
  assert.equal(existsSync(join(root, "allowed/native-oracle.tar")), false);
  const gate = await createWriteGate(await createProjectPaths(root), {
    version: "0.1.0", task_id: "posix-backslash-output-provenance", read: [], write: ["allowed/**"], validation: [],
  });
  let adapterCalls = 0;
  for (const command of [
    String.raw`git archive --output="allowed\\outside.tar" HEAD`,
    String.raw`git archive --output='allowed\outside.tar' HEAD`,
    String.raw`git archive --output "allowed\\outside.tar" HEAD`,
    String.raw`git archive --output="allowed\".tar" HEAD`,
    String.raw`curl --output="allowed\\outside.tar" https://example.test/result`,
    String.raw`curl --progress-bar --output="allowed\\outside.tar" https://example.test/result`,
    String.raw`tar -xf input.tar --directory="allowed\\outside"`,
    String.raw`printf changed > "allowed\\outside.tar"`,
    String.raw`cp input.txt "allowed\\outside.tar"`,
  ]) for (const investigativeShell of [false, true]) {
    await assert.rejects((async () => {
      await gate.check({ tool: "shell", sessionID: "worker", callID: command },
        { args: { command, workdir: root } }, { investigativeShell });
      adapterCalls += 1;
    })(), (error: unknown) => error instanceof WriteDeniedError &&
      (investigativeShell ? error.reason === "manifest-scope" : ["manifest-scope", "unclassified-command"].includes(error.reason)), command);
  }
  assert.equal(adapterCalls, 0);
  assert.equal(await readFile(join(root, "allowed/outside.tar"), "utf8"), "allowed original\n");
  assert.equal(await readFile(join(root, "allowed\\outside.tar"), "utf8"), "outside original\n");
  const safe = 'git archive --output="allowed/safe.tar" HEAD';
  for (const investigativeShell of [false, true]) await gate.check({ tool: "shell", sessionID: "worker", callID: safe },
    { args: { command: safe, workdir: root } }, { investigativeShell });
  await run("bash", ["-c", safe]);
  assert.ok((await readFile(join(root, "allowed/safe.tar"))).includes(Buffer.from("archive fixture\n")));
  const windowsPath = String.raw`curl.exe --output="allowed\safe.tar" https://example.test/result`;
  assert.deepEqual(extractWritePaths("powershell", { command: windowsPath, workdir: root }, root).paths, [join(root, "allowed/safe.tar")]);
  await gate.check({ tool: "powershell", sessionID: "worker", callID: windowsPath }, { args: { command: windowsPath, workdir: root } });
}));

test("PowerShell call-operator output parts preserve literal and unresolved provenance", async () => fixture(async root => {
  const gate = await createWriteGate(await createProjectPaths(root), {
    version: "0.1.0", task_id: "powershell-output-parts", read: [], write: ["allowed/**"], validation: [],
  });
  const literal = "& 'Robocopy.exe' source 'allowed/$dir' '$id.txt'";
  const extracted = extractWritePaths("powershell", { command: literal, workdir: root }, root);
  assert.equal(extracted.ambiguous, false);
  assert.deepEqual(extracted.paths, [join(root, "allowed/$dir/$id.txt")]);
  for (const investigativeShell of [false, true]) {
    await gate.check({ tool: "shell", sessionID: "worker", callID: literal },
      { args: { command: literal, workdir: root } }, { investigativeShell });
  }
  let adapterCalls = 0;
  for (const [command, unresolved] of [
    ['& \'Robocopy.exe\' source "allowed/$dir" out.txt', "allowed/$dir"],
    ['& \'Copy-Item\' -Path input.txt -Destination "allowed/$id.txt"', "allowed/$id.txt"],
  ] as const) {
    const result = extractWritePaths("powershell", { command, workdir: root }, root);
    assert.equal(result.ambiguous, true);
    assert.deepEqual(result.unresolvedPaths, [unresolved]);
    for (const investigativeShell of [false, true]) {
      await assert.rejects((async () => {
        await gate.check({ tool: "shell", sessionID: "worker", callID: command },
          { args: { command, workdir: root } }, { investigativeShell });
        adapterCalls += 1;
      })(), (error: unknown) => error instanceof WriteDeniedError &&
        (investigativeShell ? error.reason === "manifest-scope" : ["manifest-scope", "unclassified-command"].includes(error.reason)), command);
    }
  }
  assert.equal(adapterCalls, 0);
  assert.equal(existsSync(join(root, "allowed")), false);
}));

test("PowerShell call-operator literal output reaches the native destination when available", async t => {
  try { await exec("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"]); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") { t.skip("pwsh is not installed"); return; }
    throw error;
  }
  await fixture(async root => {
    await mkdir(join(root, "allowed"));
    const command = "& 'Set-Content' -LiteralPath 'allowed/$id.txt' -Value payload -NoNewline";
    const gate = await createWriteGate(await createProjectPaths(root), {
      version: "0.1.0", task_id: "powershell-native-literal", read: [], write: ["allowed/**"], validation: [],
    });
    const args = { command, workdir: root };
    assert.deepEqual(extractWritePaths("powershell", args, root).paths, [join(root, "allowed/$id.txt")]);
    await gate.check({ tool: "shell", sessionID: "worker", callID: command }, { args }, { investigativeShell: true });
    await exec("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command], { cwd: root });
    assert.equal(await readFile(join(root, "allowed/$id.txt"), "utf8"), "payload");
  });
});

test("native formatter and exact Git delivery compose without reviving unrelated shell ambiguity", async () => fixture(async root => {
  await exec("git", ["init", "--quiet"], { cwd: root });
  await writeFile(join(root, "result.go"), "package result\n");
  const gate = await createWriteGate(await createProjectPaths(root), {
    version: "0.1.0", task_id: "formatter-git", read: [], write: ["result.go"], validation: [],
  });
  const shell = (command: string) => gate.check({ tool: "shell", sessionID: "worker", callID: command },
    { args: { command } }, { investigativeShell: true });
  await shell("gofmt -w result.go && git add -- result.go");
  await shell('gofmt -w result.go && git add -- result.go && git commit -m "Format result"');
  await assert.rejects(shell("gofmt -w result.go && git add ."), /write denied/iu);
  await assert.rejects(shell('gofmt -w result.go && git commit -am "Include unscoped files"'), /write denied/iu);
  await assert.rejects(shell('git add "$UNKNOWN" && git commit -m "Unknown paths"'), /write denied/iu);
  await assert.rejects(shell("gofmt -w result.go && git add -- outside.go"), /write scope/iu);
  await writeFile(join(root, "outside.go"), "package outside\n");
  await exec("git", ["add", "outside.go"], { cwd: root });
  await assert.rejects(shell('gofmt -w result.go && git add -- result.go && git commit -m "No unrelated index"'), /write scope/iu);
}));

test("global-style offline npm install is plannable, writable, snapshot-bound and reviewable", async () => fixture(async area => {
  const root = join(area, "project"), target = join(area, "external prefix"), source = join(area, "package");
  await mkdir(root);
  await mkdir(source);
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "sortie-fixture-install", version: "1.0.0",
    bin: { "fixture-command": "cli.js" } }));
  await writeFile(join(source, "cli.js"), '#!/usr/bin/env node\nconsole.log("installed fixture");\n');
  const npm = process.env.npm_execpath ?? resolve(process.execPath, "../node_modules/npm/bin/npm-cli.js");
  const npmCommand = existsSync(npm) ? { file: process.execPath, prefix: [npm] } : { file: "npm", prefix: [] };
  const runNpm = (args: string[], cwd: string) => exec(npmCommand.file,
    [...npmCommand.prefix, ...args, "--offline", "--no-audit", "--no-fund", "--cache", join(area, "cache")], { cwd });
  await runNpm(["pack", "--ignore-scripts", "--pack-destination", root], source);
  const tarball = join(root, "sortie-fixture-install-1.0.0.tgz");
  const missions = new OperatorMissionRuntime(root, V010_RUNTIME_PROFILE);
  await missions.capture("root", { id: "request", text: "Install the fixed package to an external prefix and verify it." });
  const mission = await missions.start("root", ["Install the fixed package at the requested prefix"]);
  const plan = missionPlan(mission, [{ title: "Install", objective: "Install and inspect external package",
    read: [tarball], write: [target + "/"], validation: ["node verify.mjs"] }]);
  const runtime = new OperatorRuntime(root, V010_RUNTIME_PROFILE);
  const run = await runtime.prepareMission("root", plan);
  const manifestPath = run.units[0]!.manifestPath, manifestBytes = await readFile(manifestPath);
  const gate = await createWriteGate(await createProjectPaths(root), JSON.parse(manifestBytes.toString()));
  await gate.checkPath(join(target, "node_modules/sortie-fixture-install/package.json"));
  await assert.rejects(gate.checkPath(join(area, "other/package.json")), /project-root-relative/);
  await runNpm(["install", "--prefix", target, "--ignore-scripts", tarball], root);
  const cli = join(target, "node_modules/sortie-fixture-install/cli.js");
  assert.equal((await exec(process.execPath, [cli])).stdout.trim(), "installed fixture");
  const snapshot = await protectedSnapshot({ projectRoot: root, manifestPath,
    manifestHash: createHash("sha256").update(manifestBytes).digest("hex") });
  assert.ok(snapshot);
  assert.equal(snapshot.binding.source_policy, "declared-paths-v1");
  const review = await missionReviewSource(root, run); // No Git repo at this operations-only root.
  assert.match(review.excerpt, /installed fixture/);
  assert.deepEqual(await refreshProtectedSnapshot(root, snapshot.binding), { source: snapshot.source, candidate: snapshot.candidate });
  await writeFile(cli, 'console.log("modified package");\n');
  assert.notEqual((await refreshProtectedSnapshot(root, snapshot.binding))?.candidate, snapshot.candidate);
  assert.notEqual((await missionReviewSource(root, run)).fingerprint, review.fingerprint);
  await assert.rejects(runtime.replanMission("root", run.runID, missionPlan(mission, [{
    title: "Invalid control write", objective: "Must remain runtime-owned", write: [join(root, ".sortie-dogs-v010/missions")],
    validation: ["node verify.mjs"],
  }])), /operator-control-write-forbidden/);
}));
