import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createProjectPaths } from "./gate.js";
import { normalizeRelativePath } from "../core/path.js";
import { MAX_RUN_FLIGHT_LEDGER_BYTES, reconstructRunFlightLedger, RUN_FLIGHT_LEDGER_SCHEMA_VERSION,
  type RunFlightEventRecord } from "../core/run-flight-ledger.js";
import type { ModelTarget } from "./model-routing.js";

export interface TerminalRescueBinding {
  readonly ledger_path: string;
  readonly attempt_id: string;
}

export async function terminalRescueModel(input: {
  readonly owner_root: string;
  readonly session_id: string;
  readonly binding: unknown;
  readonly scope_write: readonly string[];
  readonly acceptance: readonly string[];
  readonly validation: readonly string[];
}): Promise<ModelTarget> {
  const binding = input.binding as TerminalRescueBinding;
  if (binding === null || typeof binding !== "object" || Object.keys(binding).sort().join(",") !== "attempt_id,ledger_path" ||
    typeof binding.attempt_id !== "string" || typeof binding.ledger_path !== "string") throw new Error("rescue-binding-invalid");
  const relative = normalizeRelativePath(binding.ledger_path);
  if (!relative.startsWith(".sortie-dogs/") || !relative.endsWith(".json")) throw new Error("rescue-ledger-scope-invalid");
  const project = await createProjectPaths(input.owner_root);
  const path = resolve(project.root, relative);
  if (!(await project.contains(path))) throw new Error("rescue-ledger-scope-invalid");
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text) > MAX_RUN_FLIGHT_LEDGER_BYTES) throw new Error("rescue-ledger-oversize");
  const document = JSON.parse(text);
  if (document.schema_version !== RUN_FLIGHT_LEDGER_SCHEMA_VERSION || !Array.isArray(document.events)) throw new Error("rescue-ledger-invalid");
  const records = document.events as RunFlightEventRecord[];
  const state = reconstructRunFlightLedger(records);
  const attempt = records.map(({ event }) => event).find((event) => event.kind === "attempt.started" && event.attempt_id === binding.attempt_id);
  const child = state.children.find((entry) => entry.identity.attempt_id === binding.attempt_id);
  if (attempt?.kind !== "attempt.started" || attempt.role !== "rescue" || attempt.terminal_rescue_contract === undefined ||
    child?.identity.child_id !== input.session_id || child.terminal !== null || child.deadline_ms <= Date.now() ||
    state.current_candidate_id !== attempt.candidate_id || state.terminal_disposition !== null ||
    records.some(({ event }) => event.kind === "attempt.finished" && event.attempt_id === binding.attempt_id)) {
    throw new Error("rescue-attempt-inactive");
  }
  const contract = attempt.terminal_rescue_contract;
  const equal = (left: readonly string[], right: readonly string[]) => JSON.stringify(left) === JSON.stringify(right);
  if (!equal([...contract.scope].sort(), [...input.scope_write].sort()) || !equal(contract.acceptance, input.acceptance) ||
    !equal(contract.validation, input.validation)) throw new Error("rescue-contract-drift");
  return { model: attempt.selected_model, ...(attempt.selected_variant === null ? {} : { variant: attempt.selected_variant }) };
}
