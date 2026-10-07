import { randomUUID } from "node:crypto";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Stage transport data only. The configured executor still performs the project write. */
export async function prepareCodexWrite(filePath: string, content: string): Promise<{
  command: readonly string[]; dispose: () => Promise<void>;
}> {
  const payload = join(tmpdir(), `sortie-codex-write-${randomUUID()}`);
  await writeFile(payload, content, { encoding: "utf8", flag: "wx" });
  return {
    command: [process.execPath, "-e", "const fs=require('node:fs');fs.writeFileSync(process.argv[1],fs.readFileSync(process.argv[2]))", filePath, payload],
    dispose: () => rm(payload, { force: true }),
  };
}
