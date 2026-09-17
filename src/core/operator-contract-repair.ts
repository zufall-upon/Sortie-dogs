import { createHash } from "node:crypto";

export interface OperatorContractRepairFileIdentity {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  /** Host-private canonical identity; never included in a public operator packet. */
  readonly realpath: string;
  readonly baseline_absent: true;
  readonly head_absent: true;
  readonly index_absent: true;
  readonly patch_absent: true;
  readonly untracked: true;
  readonly regular_nonlink: true;
}

export function operatorContractRepairFingerprint(input: {
  readonly run_id: string;
  readonly unit_id: string;
  readonly repair_generation: number;
  readonly files: readonly Pick<OperatorContractRepairFileIdentity, "path" | "size" | "sha256">[];
}): string {
  const identities = [...input.files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(file => `${file.path}:${file.sha256}:${file.size}`);
  const canonical = [input.run_id, input.unit_id, String(input.repair_generation), ...identities].join("\0");
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}
