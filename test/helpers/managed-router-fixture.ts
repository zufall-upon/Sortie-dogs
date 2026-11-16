import { cp, mkdir, readdir, symlink } from "node:fs/promises";
import { join } from "node:path";

/** Supply real, project-local tooling without using an external dependency symlink. */
export async function copyManagedRouterFixture(project: string, directory: string): Promise<void> {
  await mkdir(join(directory, "scripts"), { recursive: true });
  await mkdir(join(directory, "test/helpers"), { recursive: true });
  for (const path of ["scripts/test-router.mjs", "test/helpers/full-test-runner.ts", "test/setup.ts", "tsconfig.json"])
    await cp(join(project, path), join(directory, path));
  await mkdir(join(directory, "node_modules/typescript/bin"), { recursive: true });
  await mkdir(join(directory, "node_modules/typescript/lib"), { recursive: true });
  await mkdir(join(directory, "node_modules/.bin"), { recursive: true });
  for (const path of ["package.json", "bin/tsc", "lib/tsc.js", "lib/_tsc.js",
    ...(await readdir(join(project, "node_modules/typescript/lib"))).filter(name => /^lib\..*\.d\.ts$/u.test(name)).map(name => `lib/${name}`)])
    await cp(join(project, "node_modules/typescript", path), join(directory, "node_modules/typescript", path));
  await symlink("../typescript/bin/tsc", join(directory, "node_modules/.bin/tsc"));
}
