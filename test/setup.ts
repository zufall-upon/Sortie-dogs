import { fileURLToPath } from "node:url";

// Production resolves the real OpenCode global root. Tests get one process-local empty root so a
// developer's installed sortie-dogs.version cannot change contract enforcement.
process.env.OPENCODE_CONFIG_DIR = fileURLToPath(
  new URL(`../_testenv/test-global-opencode-${process.pid}/`, import.meta.url),
);
