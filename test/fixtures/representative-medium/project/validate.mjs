import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const tests = readdirSync(join(root, "test"))
  .filter((name) => /^unit-[1-5]\.test\.mjs$/u.test(name))
  .sort()
  .map((name) => join("test", name));

if (tests.length !== 5) throw new Error("Representative validation requires exactly five unit tests.");
const result = spawnSync(process.execPath, ["--test", ...tests], {
  cwd: root,
  encoding: "utf8",
  shell: false,
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
