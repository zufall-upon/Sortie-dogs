import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { OpenCodeTerminalRescueHost } from "../dist/plugin/terminal-rescue-host.js";
import type { TerminalRescueAttempt } from "../dist/core/terminal-rescue-runtime.js";

const exec = promisify(execFile);

test("terminal rescue host canonicalizes lifecycle scope without changing worker source paths", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "terminal-rescue-host-"));
  try {
    await writeFile(join(projectRoot, "AGENTS.md"), "# fixture\n");
    await writeFile(join(projectRoot, "package.json"), "{}\n");
    await writeFile(join(projectRoot, "validate.mjs"), "process.exit(0);\n");
    await writeFile(join(projectRoot, "result.mjs"), "export const value = null;\n");
    await writeFile(join(projectRoot, ".gitignore"), ".sortie-dogs/\n");
    await exec("git", ["init", "-q", "-b", "main"], { cwd: projectRoot });
    await exec("git", ["add", "AGENTS.md", "package.json", "validate.mjs", "result.mjs", ".gitignore"], { cwd: projectRoot });
    await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], { cwd: projectRoot });
    const candidate = (await exec("git", ["rev-parse", "HEAD"], { cwd: projectRoot })).stdout.trim();
    let created = 0;
    const host = new OpenCodeTerminalRescueHost({ runID: "run", projectRoot, ownerSessionID: "owner",
      ledgerPath: ".sortie-dogs/flight.json", scopeRead: ["AGENTS.md", "package.json", "validate.mjs"],
      validation: { executable: process.execPath, args: ["validate.mjs"] },
      client: { v2: { model: { list: async () => ({ data: [] }) } }, session: {
        create: async () => { created++; return { data: { id: "child" } }; },
        prompt: async (input) => {
          const text = input.body.parts[0]!.text;
          const handoff = /^handoff_path: (.+)$/mu.exec(text)?.[1];
          assert.ok(handoff);
          await writeFile(join(resolve(handoff, "../../.."), "result.mjs"), "export const value = 'ready';\n");
          return { data: { info: { role: "assistant", providerID: "openai", modelID: "gpt-6-astra", cost: 12.34 } } };
        },
        abort: async () => true,
      } }, createdChild: () => {}, finishedChild: () => {}, releaseWriter: async () => {}, writerReleased: async () => true });
    const attempt: TerminalRescueAttempt = { attempt_id: randomUUID(), unit_id: "unit", predecessor_attempt_id: "failed",
      candidate_id: candidate, route_id: "route", call_id: randomUUID(), at: new Date().toISOString(),
      selected_model: "openai/gpt-6-astra", selected_variant: null,
      terminal_rescue_contract: { candidate_id: candidate, contract_id: "contract", scope: ["result.mjs"],
        acceptance: ["result"], validation: [`${process.execPath.includes(" ") ? JSON.stringify(process.execPath) : process.execPath} validate.mjs`] } };
    const execution = await host.start(attempt, new AbortController().signal);
    assert.equal(created, 1, "noncanonical semantic source paths reached managed worktree creation");
    await execution.begin();
    const outcome = await execution.completion;
    assert.equal(outcome.disposition, "succeeded");
    assert.equal(outcome.observed_model, "openai/gpt-6-astra");
    assert.deepEqual(outcome.observation.estimated_cost, { usd: null, provenance: "unknown" });
    assert.ok(host.artifact);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
