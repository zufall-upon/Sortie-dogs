import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SOURCE_ROOT = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SOURCE_ROOT, "../../..");
const PROJECT_SOURCE = join(SOURCE_ROOT, "project");
const TESTENV_ROOT = join(REPOSITORY_ROOT, "_testenv");
const CONFIG_NAME = "representative-config.json";
const CONTRACT_NAME = "luna-fabric.json";
const OPENCODE_CONFIG_DIRECTORY = "opencode-config";
const XDG_CONFIG_DIRECTORY = "xdg-config";
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const RESULT_KEYS = [
  "accepted_candidate_sha", "accepted_cas_violations", "cleanup", "expected_outputs", "fixture_id",
  "fixture_source_sha256", "implementation_child_count", "package_sha256", "route", "scope_corruption",
  "sol_demotion_count", "target_integrity", "target_sha_after", "target_sha_before",
  "validation_candidate_sha",
].sort();

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function boundedRuntimeRoot(runtimeRoot) {
  const root = resolve(runtimeRoot);
  invariant(isInside(TESTENV_ROOT, root), "Runtime root must be a child of the repository _testenv directory.");
  return root;
}

async function execute(executable, args, cwd, environment = {}) {
  return await new Promise((resolvePromise, reject) => {
    execFile(executable, args, {
      cwd,
      env: { ...process.env, ...environment },
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      shell: false,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error === null) resolvePromise(stdout.trim());
      else reject(new Error(`${executable} failed with exit ${error.code ?? "unknown"}: ${stderr.trim()}`));
    });
  });
}

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function sourceFiles(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(root, path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export async function fixtureSourceSha256() {
  const hash = createHash("sha256");
  for (const path of await sourceFiles(SOURCE_ROOT)) {
    hash.update(relative(SOURCE_ROOT, path).split(sep).join("/"));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function cleanRepresentativeRuntime(runtimeRoot) {
  await rm(boundedRuntimeRoot(runtimeRoot), { recursive: true, force: true });
}

function validateTemplate(template) {
  invariant(isRecord(template) && template.schema_version === "0.1.0" &&
    template.fixture_id === "representative-medium-v1", "Invalid representative config template.");
  invariant(template.target_branch === "benchmark-medium", "Invalid benchmark target branch.");
  invariant(isRecord(template.timeouts_ms) && template.timeouts_ms.route === 300000 &&
    template.timeouts_ms.host_margin === 60000 && template.timeouts_ms.host_task_cap === 360000,
  "Invalid representative timeout contract.");
  invariant(isRecord(template.routes) && isRecord(template.routes["sol-serial"]) &&
    isRecord(template.routes["luna-fabric"]) && template.routes["sol-serial"].implementation_child_count === 1 &&
    template.routes["luna-fabric"].implementation_child_count === 5 &&
    template.routes["luna-fabric"].width === 5, "Invalid representative route contract.");
}

function validateConfig(config) {
  validateTemplate(config);
  invariant(typeof config.runtime_root === "string" && typeof config.project_root === "string" &&
    typeof config.opencode_config_dir === "string" && typeof config.xdg_config_home === "string",
    "Runtime paths are absent.");
  invariant(SHA.test(config.target_sha), "Target SHA must be exact.");
  invariant(isRecord(config.package) && typeof config.package.path === "string" &&
    config.package.version === "0.8.2" && SHA256.test(config.package.sha256), "Package provenance is invalid.");
  invariant(SHA256.test(config.fixture_source_sha256), "Fixture source identity is invalid.");
  invariant(Array.isArray(config.units) && config.units.length === 5, "Exactly five units are required.");
  invariant(Array.isArray(config.expected_writes) && config.expected_writes.length === 5 &&
    new Set(config.expected_writes).size === 5, "Expected writes must be five disjoint paths.");
  invariant(isRecord(config.result_contract) &&
    exactKeys(config.result_contract, ["cleanup", "exact_keys", "expected_outputs", "required_values"]) &&
    JSON.stringify(config.result_contract.exact_keys) === JSON.stringify(RESULT_KEYS) &&
    isRecord(config.result_contract.required_values) &&
    exactKeys(config.result_contract.required_values,
      ["accepted_cas_violations", "scope_corruption", "target_integrity"]) &&
    config.result_contract.required_values.accepted_cas_violations === 0 &&
    config.result_contract.required_values.scope_corruption === false &&
    config.result_contract.required_values.target_integrity === true &&
    isRecord(config.result_contract.cleanup) && config.result_contract.cleanup.status === "complete" &&
    Array.isArray(config.result_contract.cleanup.remaining_paths) &&
    config.result_contract.cleanup.remaining_paths.length === 0 &&
    Array.isArray(config.result_contract.expected_outputs) &&
    JSON.stringify(config.result_contract.expected_outputs) === JSON.stringify(
      config.expected_writes.map((path) => ({ path, exists: true })),
    ), "Representative result contract is invalid.");
  for (const unit of config.units) {
    invariant(isRecord(unit) && typeof unit.unit_id === "string" && typeof unit.input === "string" &&
      typeof unit.test === "string" && typeof unit.output === "string" &&
      Array.isArray(unit.acceptance_items) && unit.acceptance_items.length > 0, "Unit identity is invalid.");
  }
  return config;
}

export async function prepareRepresentativeRuntime({ runtimeRoot, packagePath }) {
  const root = boundedRuntimeRoot(runtimeRoot);
  const packageFile = resolve(packagePath);
  invariant((await stat(packageFile)).isFile(), "Package provenance path must identify a file.");
  const repositoryPackage = await json(join(REPOSITORY_ROOT, "package.json"));
  invariant(repositoryPackage.version === "0.8.2", "Representative fixture requires package version 0.8.2.");
  const template = await json(join(SOURCE_ROOT, "representative-config.template.json"));
  validateTemplate(template);
  const contractTemplate = await json(join(PROJECT_SOURCE, "luna-fabric.template.json"));

  await cleanRepresentativeRuntime(root);
  await mkdir(root, { recursive: true });
  const projectRoot = join(root, "project");
  await cp(PROJECT_SOURCE, projectRoot, { recursive: true });
  await execute("git", ["init", "-q", "-b", template.target_branch], projectRoot);
  await execute("git", ["config", "user.name", "Sortie Benchmark"], projectRoot);
  await execute("git", ["config", "user.email", "benchmark@example.invalid"], projectRoot);
  await execute("git", ["config", "core.autocrlf", "false"], projectRoot);
  await execute("git", ["config", "commit.gpgsign", "false"], projectRoot);
  await execute("git", ["add", "--all"], projectRoot);
  const fixedGitEnvironment = {
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };
  await execute("git", ["commit", "-q", "-m", "representative medium baseline"], projectRoot, fixedGitEnvironment);
  const targetSha = await execute("git", ["rev-parse", "HEAD"], projectRoot);
  invariant(SHA.test(targetSha), "Nested baseline did not produce an exact target SHA.");
  await execute("git", ["checkout", "-q", "--detach", targetSha], projectRoot);

  const acceptanceFingerprint = createHash("sha256")
    .update(JSON.stringify(contractTemplate.acceptance_items)).digest("hex");
  const contract = structuredClone(contractTemplate);
  contract.provenance.acceptance_fingerprint = acceptanceFingerprint;
  contract.provenance.target_branch = template.target_branch;
  contract.provenance.target_sha = targetSha;
  await writeFile(join(root, CONTRACT_NAME), `${JSON.stringify(contract, null, 2)}\n`);
  const controlDirectory = join(projectRoot, ".opencode");
  await mkdir(controlDirectory, { recursive: true });
  await writeFile(join(controlDirectory, "sortie-dogs-luna-fabric.json"), `${JSON.stringify(contract, null, 2)}\n`);
  const runtimePackage = join(root, basename(packageFile));
  await cp(packageFile, runtimePackage);
  const packageReference = relative(controlDirectory, runtimePackage).split(sep).join("/");
  await writeFile(join(controlDirectory, "package.json"), `${JSON.stringify({
    private: true,
    type: "module",
    dependencies: {
      "@opencode-ai/plugin": "1.18.11",
      "sortie-dogs": `file:${packageReference}`,
    },
  }, null, 2)}\n`);
  const pluginDirectory = join(controlDirectory, "plugins");
  await mkdir(pluginDirectory, { recursive: true });
  await writeFile(join(pluginDirectory, "sortie-dogs.ts"),
    'export { SortieDogsPlugin } from "sortie-dogs/plugin";\n');
  const opencodeConfigDirectory = join(root, OPENCODE_CONFIG_DIRECTORY);
  await mkdir(opencodeConfigDirectory, { recursive: true });
  await writeFile(join(opencodeConfigDirectory, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    mcp: {},
    compaction: { auto: true, prune: true },
  }, null, 2)}\n`);
  const xdgConfigHome = join(root, XDG_CONFIG_DIRECTORY);
  const xdgOpenCodeDirectory = join(xdgConfigHome, "opencode");
  await mkdir(xdgOpenCodeDirectory, { recursive: true });
  await writeFile(join(xdgOpenCodeDirectory, "package.json"), `${JSON.stringify({
    dependencies: { "@opencode-ai/plugin": "1.18.11" },
  }, null, 2)}\n`);

  const units = contract.units.map((unit) => ({
    unit_id: unit.unit_id,
    input: unit.scope_read.find((path) => path.startsWith("input/")),
    test: unit.validation.command.at(-1),
    output: unit.scope_write[0],
    acceptance_items: unit.acceptance_items,
  }));
  const config = {
    ...template,
    runtime_root: root,
    project_root: projectRoot,
    opencode_config_dir: opencodeConfigDirectory,
    xdg_config_home: xdgConfigHome,
    target_sha: targetSha,
    fixture_source_sha256: await fixtureSourceSha256(),
    package: { path: packageFile, version: repositoryPackage.version, sha256: await sha256File(packageFile) },
    expected_writes: units.map(({ output }) => output),
    result_contract: {
      exact_keys: RESULT_KEYS,
      required_values: { target_integrity: true, accepted_cas_violations: 0, scope_corruption: false },
      cleanup: { status: "complete", remaining_paths: [] },
      expected_outputs: units.map(({ output: path }) => ({ path, exists: true })),
    },
    final_validation: ["node", "validate.mjs"],
    units,
  };
  validateConfig(config);
  await writeFile(join(root, CONFIG_NAME), `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

export function validateRepresentativeResult(configValue, result) {
  const config = validateConfig(configValue);
  invariant(isRecord(result) && exactKeys(result, RESULT_KEYS), "Representative result shape is invalid.");
  invariant(result.fixture_id === config.fixture_id &&
    result.fixture_source_sha256 === config.fixture_source_sha256 &&
    result.package_sha256 === config.package.sha256, "Representative result identity is invalid.");
  invariant(result.route === "sol-serial" || result.route === "luna-fabric", "Representative route is invalid.");
  invariant(result.implementation_child_count === config.routes[result.route].implementation_child_count,
    "Implementation child count does not match the route.");
  invariant(SHA.test(result.accepted_candidate_sha) &&
    result.validation_candidate_sha === result.accepted_candidate_sha, "Candidate validation identity is invalid.");
  invariant(result.target_sha_before === config.target_sha && result.target_sha_after === result.accepted_candidate_sha &&
    result.target_integrity === config.result_contract.required_values.target_integrity, "Target integrity failed.");
  invariant(result.accepted_cas_violations === config.result_contract.required_values.accepted_cas_violations,
    "Accepted CAS violation detected.");
  invariant(result.scope_corruption === config.result_contract.required_values.scope_corruption,
    "Scope corruption detected.");
  invariant(Number.isInteger(result.sol_demotion_count) && result.sol_demotion_count >= 0 &&
    result.sol_demotion_count <= config.units.length &&
    (result.route === "luna-fabric" || result.sol_demotion_count === 0), "Sol demotion evidence is invalid.");
  invariant(Array.isArray(result.expected_outputs) && result.expected_outputs.length === config.expected_writes.length,
    "Expected output evidence is incomplete.");
  const output = new Map(result.expected_outputs.map((entry) => [entry?.path, entry?.exists]));
  invariant(output.size === config.expected_writes.length &&
    config.expected_writes.every((path) => output.get(path) === true), "Expected output is absent or duplicated.");
  invariant(isRecord(result.cleanup) && exactKeys(result.cleanup, ["remaining_paths", "status"]) &&
    result.cleanup.status === "complete" && Array.isArray(result.cleanup.remaining_paths) &&
    result.cleanup.remaining_paths.length === 0, "Bounded cleanup is incomplete.");
  return Object.freeze(structuredClone(result));
}

function syntheticResult(config, route) {
  return {
    fixture_id: config.fixture_id,
    fixture_source_sha256: config.fixture_source_sha256,
    package_sha256: config.package.sha256,
    route,
    implementation_child_count: config.routes[route].implementation_child_count,
    accepted_candidate_sha: "f".repeat(40),
    validation_candidate_sha: "f".repeat(40),
    target_sha_before: config.target_sha,
    target_sha_after: "f".repeat(40),
    target_integrity: true,
    accepted_cas_violations: 0,
    scope_corruption: false,
    sol_demotion_count: route === "luna-fabric" ? 1 : 0,
    expected_outputs: config.expected_writes.map((path) => ({ path, exists: true })),
    cleanup: { status: "complete", remaining_paths: [] },
  };
}

export async function selfTestResultIdentity(configPath) {
  const config = validateConfig(await json(resolve(configPath)));
  const contract = await json(join(config.runtime_root, CONTRACT_NAME));
  invariant(exactKeys(contract, ["acceptance_items", "effects", "provenance", "shared_paths", "units", "version"]) &&
    contract.version === "0.8.0" && contract.provenance.source === "dog-coordinator" &&
    contract.provenance.target_sha === config.target_sha && contract.provenance.target_branch === config.target_branch &&
    contract.units.length === 5, "Generated Luna contract identity is invalid.");
  validateRepresentativeResult(config, syntheticResult(config, "sol-serial"));
  validateRepresentativeResult(config, syntheticResult(config, "luna-fabric"));
  for (const mutate of [
    (value) => { value.implementation_child_count += 1; },
    (value) => { value.validation_candidate_sha = "e".repeat(40); },
    (value) => { value.target_sha_after = "e".repeat(40); },
    (value) => { value.accepted_cas_violations = 1; },
    (value) => { value.scope_corruption = true; },
    (value) => { value.expected_outputs.pop(); },
    (value) => { value.cleanup.remaining_paths.push("owned-worktree"); },
  ]) {
    const invalid = syntheticResult(config, "luna-fabric");
    mutate(invalid);
    let rejected = false;
    try { validateRepresentativeResult(config, invalid); } catch { rejected = true; }
    invariant(rejected, "Invalid representative result was accepted.");
  }
}

export async function selfTestCleanWorkspace(configPath) {
  const config = validateConfig(await json(resolve(configPath)));
  const outputRoot = join(config.project_root, "output");
  invariant((await readdir(outputRoot)).every((name) => name === ".gitkeep"),
    "Prepared benchmark output is not clean.");
  const workspace = join(config.runtime_root, "self-test-workspace");
  invariant(isInside(config.runtime_root, workspace), "Self-test workspace escaped the runtime root.");
  await rm(workspace, { recursive: true, force: true });
  for (const path of config.expected_writes) {
    const destination = join(workspace, path);
    invariant(isInside(workspace, destination), "Expected output escaped the self-test workspace.");
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, "export const representativeSelfTest = true;\n");
  }
  for (const path of config.expected_writes) invariant((await stat(join(workspace, path))).isFile(),
    "Self-test expected output is absent.");
  await rm(workspace, { recursive: true, force: true });
  let workspaceExists = true;
  try { await stat(workspace); } catch { workspaceExists = false; }
  invariant(!workspaceExists && (await stat(config.project_root)).isDirectory(), "Bounded cleanup failed.");
}

function argumentsFrom(argv) {
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    invariant(key.startsWith("--"), `Unexpected argument: ${key}`);
    if (["--prepare", "--self-test-result-identity", "--self-test-clean-workspace"].includes(key)) flags.set(key, true);
    else {
      const value = argv[index + 1];
      invariant(value !== undefined && !value.startsWith("--"), `Missing value for ${key}`);
      flags.set(key, value);
      index += 1;
    }
  }
  return flags;
}

async function main() {
  const flags = argumentsFrom(process.argv.slice(2));
  const commands = ["--prepare", "--self-test-result-identity", "--self-test-clean-workspace"]
    .filter((command) => flags.has(command));
  invariant(commands.length === 1, "Select exactly one representative runner command.");
  if (commands[0] === "--prepare") {
    invariant(typeof flags.get("--runtime-root") === "string" && typeof flags.get("--package") === "string",
      "Preparation requires --runtime-root and --package.");
    const config = await prepareRepresentativeRuntime({
      runtimeRoot: flags.get("--runtime-root"),
      packagePath: flags.get("--package"),
    });
    process.stdout.write(`${JSON.stringify({ status: "prepared", config: join(config.runtime_root, CONFIG_NAME),
      target_sha: config.target_sha, package_sha256: config.package.sha256 })}\n`);
    return;
  }
  invariant(typeof flags.get("--config") === "string", "Self-test requires --config.");
  if (commands[0] === "--self-test-result-identity") await selfTestResultIdentity(flags.get("--config"));
  else await selfTestCleanWorkspace(flags.get("--config"));
  process.stdout.write(`${JSON.stringify({ status: "pass", self_test: commands[0].slice(2) })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
