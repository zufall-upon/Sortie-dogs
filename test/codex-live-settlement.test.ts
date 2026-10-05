import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { promisify } from "node:util";
import { CodexAppServerHost, createCodexAppServerTransport } from "../dist/codex/app-server.js";
import { CodexMissionSettlementBridge } from "../dist/codex/mission-settlement.js";
import { CodexProtectedEvidenceCapture } from "../dist/codex/protected-evidence.js";
import type { GoalFlightState } from "../dist/core/goal-bound.js";
import type { SerialDispatchSettlement } from "../dist/plugin/runtime-bridge.js";
import type { CodexValidationObservation } from "../dist/codex/mission-settlement.js";

const codex = process.env.SORTIE_CODEX_LIVE_EXECUTABLE;
const windowsTemp = process.env.SORTIE_CODEX_LIVE_WINDOWS_TEMP;
const linuxTemp = process.env.SORTIE_CODEX_LIVE_LINUX_TEMP;
const enabled = process.env.SORTIE_CODEX_LIVE === "1";

test("live Codex turn enters the existing protected evidence and settlement boundary",
  { skip: !enabled || !codex || !windowsTemp || !linuxTemp, timeout: 180_000 }, async () => {
  const root = await mkdtemp(`${linuxTemp}/sortie-codex-settlement-`);
  const name = root.slice(root.lastIndexOf("/") + 1);
  const cwd = `${windowsTemp}\\${name}`;
  await promisify(execFile)("git", ["-C", root, "init", "--quiet"]);
  const validationCommand = "node verify.mjs";
  await writeFile(`${root}/verify.mjs`, "import assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nassert.equal(readFileSync('hello.txt', 'utf8'), 'sortie codex settlement ok\\n');\n");
  const host = new CodexAppServerHost(createCodexAppServerTransport({ executable: codex! }));
  try {
    const threadID = await host.startThread({ cwd, ephemeral: true });
    const implementation = await host.runTurn(threadID,
      "Create hello.txt containing exactly: sortie codex settlement ok followed by one newline. Do not modify any other file. Do not run validation. Briefly report completion.", {
        cwd, approvalPolicy: "never",
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false },
      });
    assert.equal(implementation.status, "completed");
    assert.equal(await readFile(`${root}/hello.txt`, "utf8"), "sortie codex settlement ok\n");
    const manifest = JSON.stringify({ version: "0.1.0", task_id: "codex-live-settlement",
      read: ["hello.txt", "verify.mjs"], write: ["hello.txt"], validation: [validationCommand] });
    const manifestPath = `${root}/operation-manifest.json`;
    await writeFile(manifestPath, manifest);
    const criterion = { criterion_id: "criterion-1", target: "hello.txt", entrypoint: "git", workload: "diff validation",
      oracle_coverage: ["working-tree"], build_boundary: "not-applicable" as const, source: "source-1", candidate: "candidate-1",
      validation_command: "git diff --check", fixture: "fixture-1", proof_scope: "requested-full" as const, expected_outcome: "pass" as const };
    const goalState: Pick<GoalFlightState, "goal_id" | "revision" | "scope_epoch" | "acceptance_fingerprint" | "acceptance_contract"> = {
      goal_id: "goal-live", revision: 1, scope_epoch: 1, acceptance_fingerprint: "fingerprint-live",
      acceptance_contract: { criteria: [{ ...criterion, entrypoint: "node", workload: "exact content validation",
        oracle_coverage: ["hello.txt-content"], validation_command: validationCommand }] },
    };
    const capture = await CodexProtectedEvidenceCapture.admit({ manifestPath,
      manifestHash: createHash("sha256").update(manifest).digest("hex"), projectRoot: root, goalState,
      unitID: "unit-live", declaredValidation: [validationCommand], owner: "coordinator" });
    assert.ok(capture);
    const turn = await host.runTurn(threadID, `Run exactly \`${validationCommand}\`. Do not modify any file. Briefly report the result.`, {
      cwd, approvalPolicy: "never",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false },
    });
    const settlements: SerialDispatchSettlement[] = [];
    const observations: CodexValidationObservation[] = [];
    const bridge = new CodexMissionSettlementBridge({
      observedValidation: async value => { observations.push(...value); },
      settled: async value => { settlements.push(value); },
    });
    const settlement = await bridge.settle({ rootSessionID: "root-live", callID: "call-live", unitID: "unit-live", turn,
      declaredValidation: [validationCommand], trustedPowerShellExecutable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      goalState, captureEvidence: capture.capture });
    console.log(JSON.stringify({ marker: "codex-live-settlement-diagnostic", turnStatus: turn.status,
      commands: turn.items.filter(item => item.type === "commandExecution").map(item => ({
        command: item.command, status: item.status, exitCode: item.exitCode,
      })), settlement }));
    assert.equal(turn.status, "completed");
    assert.equal(settlement.disposition, "succeeded");
    assert.equal(settlements.length, 1);
    assert.equal(observations.length, 1);
    assert.equal(observations[0]!.rawCommand, turn.items.find(item => item.type === "commandExecution")!.command);
    console.log(JSON.stringify({ marker: "codex-live-settlement", root, threadID, turnID: turn.turnID,
      itemTypes: turn.items.map(item => item.type), disposition: settlement.disposition, evidence: settlement.evidence.length }));
  } finally { await host.close(); }
});
