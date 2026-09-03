import Ajv2020Module, {
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

import type {
  Handoff,
  OperationManifest,
  SchemaDiagnostic,
  SchemaDiagnosticCode,
  SchemaKind,
  SchemaValidationResult,
  WorktreeParallelContract,
} from "./types.js";

type JsonSchema = Record<string, unknown>;

const Ajv2020 = Ajv2020Module as unknown as typeof import("ajv/dist/2020.js").default;
const addFormats = addFormatsModule as unknown as typeof import("ajv-formats").default;

// Kept in the runtime module because the package publishes only dist/.
const HANDOFF_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "profile", "id", "created_at", "task", "state", "risks", "verification"],
  properties: {
    version: { const: "0.1.0" },
    profile: { enum: ["minimal", "full"] },
    ext: { type: "object" },
    id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
    created_at: { type: "string", format: "date-time" },
    task: {
      type: "object",
      additionalProperties: false,
      required: ["title", "objective"],
      properties: {
        title: { type: "string", minLength: 1, maxLength: 160 },
        objective: { type: "string", minLength: 1, maxLength: 2000 },
      },
    },
    scope: {
      type: "object",
      additionalProperties: false,
      required: ["paths"],
      properties: {
        paths: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 512 },
        },
        excludes: {
          type: "array",
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 512 },
        },
      },
    },
    state: {
      type: "object",
      additionalProperties: false,
      required: ["done", "next", "blocked"],
      properties: {
        done: { $ref: "#/$defs/statements" },
        next: { $ref: "#/$defs/statements" },
        blocked: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["reason", "needed"],
            properties: {
              reason: { type: "string", minLength: 1, maxLength: 1000 },
              needed: { type: "string", minLength: 1, maxLength: 1000 },
            },
          },
        },
      },
    },
    sources: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "rev"],
        properties: {
          path: { type: "string", minLength: 1, maxLength: 512 },
          rev: { type: "string", minLength: 1, maxLength: 256 },
          hash: { type: "string", pattern: "^(sha256|sha512):[A-Fa-f0-9]+$" },
        },
      },
    },
    risks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "description"],
        properties: {
          severity: { enum: ["low", "medium", "high"] },
          description: { type: "string", minLength: 1, maxLength: 1000 },
          mitigation: { type: "string", minLength: 1, maxLength: 1000 },
        },
      },
    },
    verification: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["check", "status", "summary"],
        properties: {
          check: { type: "string", minLength: 1, maxLength: 256 },
          status: { enum: ["pass", "fail", "not_run"] },
          exit_code: { type: ["integer", "null"] },
          summary: { type: "string", minLength: 1, maxLength: 1000 },
        },
      },
    },
  },
  allOf: [{
    if: { properties: { profile: { const: "full" } }, required: ["profile"] },
    then: { required: ["scope", "sources"] },
  }],
  $defs: {
    statements: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 1000 },
    },
  },
};

const OPERATION_MANIFEST_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "task_id", "read", "write", "validation"],
  properties: {
    version: { const: "0.1.0" },
    task_id: { type: "string", minLength: 1, maxLength: 128 },
    read: {
      type: "array",
      uniqueItems: true,
      items: { $ref: "#/$defs/path" },
    },
    write: {
      type: "array",
      uniqueItems: true,
      items: { $ref: "#/$defs/path" },
    },
    validation: {
      type: "array",
      uniqueItems: true,
      items: { $ref: "#/$defs/validationCommand" },
    },
  },
  $defs: {
    path: { type: "string", minLength: 1, maxLength: 512 },
    validationCommand: { type: "string", minLength: 1, maxLength: 1000 },
  },
};

const WORKTREE_PARALLEL_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "mode", "max_workers", "tasks", "artifacts", "failure", "baseline_metrics"],
  properties: {
    version: { const: "0.1.0" },
    mode: { enum: ["parallel", "single-worker"] },
    max_workers: { type: "integer", minimum: 1, maximum: 5 },
    tasks: { type: "array", minItems: 1, maxItems: 64, items: { $ref: "#/$defs/task" } },
    artifacts: { type: "array", maxItems: 64, items: { $ref: "#/$defs/artifact" } },
    failure: { anyOf: [{ type: "null" }, { $ref: "#/$defs/failure" }] },
    baseline_metrics: { anyOf: [{ type: "null" }, { $ref: "#/$defs/metrics" }] },
  },
  $defs: {
    id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
    sha: { type: "string", pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" },
    path: { type: "string", minLength: 1, maxLength: 512, pattern: "^[^\\u0000-\\u001F\\u007F]+$" },
    task: {
      type: "object",
      additionalProperties: false,
      required: ["task_id", "worktree", "branch", "base_sha", "depends_on", "scope"],
      properties: {
        task_id: { $ref: "#/$defs/id" },
        worktree: { $ref: "#/$defs/id" },
        branch: { type: "string", minLength: 1, maxLength: 256 },
        base_sha: { $ref: "#/$defs/sha" },
        depends_on: { type: "array", uniqueItems: true, maxItems: 63, items: { $ref: "#/$defs/id" } },
        scope: {
          type: "object",
          additionalProperties: false,
          required: ["read", "write"],
          properties: {
            read: { type: "array", uniqueItems: true, maxItems: 256, items: { $ref: "#/$defs/path" } },
            write: { type: "array", uniqueItems: true, minItems: 1, maxItems: 256, items: { $ref: "#/$defs/path" } },
          },
        },
      },
    },
    artifact: {
      type: "object",
      additionalProperties: false,
      required: ["task_id", "base_sha", "commit_sha", "branch", "changed_paths", "change_fingerprint", "validation"],
      properties: {
        task_id: { $ref: "#/$defs/id" },
        base_sha: { $ref: "#/$defs/sha" },
        commit_sha: { $ref: "#/$defs/sha" },
        branch: { type: "string", minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001F\\u007F]+$" },
        changed_paths: { type: "array", uniqueItems: true, minItems: 1, maxItems: 256, items: { $ref: "#/$defs/path" } },
        change_fingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
        validation: {
          type: "object",
          additionalProperties: false,
          required: ["command", "exit_code", "validation_fingerprint"],
          properties: {
            command: {
              type: "array",
              minItems: 1,
              maxItems: 129,
              items: { type: "string", minLength: 1, maxLength: 1000, pattern: "^[^\\u0000-\\u001F\\u007F]+$" },
            },
            exit_code: { const: 0 },
            validation_fingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
        },
      },
    },
    failure: {
      type: "object",
      additionalProperties: false,
      required: ["code", "task_id", "fallback", "detail"],
      properties: {
        code: { enum: ["stale-base", "scope-overlap", "dirty-tree", "abandoned-worker", "merge-conflict"] },
        task_id: { $ref: "#/$defs/id" },
        fallback: { enum: ["stop", "single-worker"] },
        detail: { type: "string", minLength: 1, maxLength: 1000 },
      },
    },
    metrics: {
      type: "object",
      additionalProperties: false,
      required: ["wall_clock_ms", "total_tokens", "estimated_cost_usd", "conflict_count", "validation_count"],
      properties: {
        wall_clock_ms: { type: "number", minimum: 0 },
        total_tokens: { type: ["integer", "null"], minimum: 0 },
        estimated_cost_usd: { type: ["number", "null"], minimum: 0 },
        conflict_count: { type: "integer", minimum: 0 },
        validation_count: { type: "integer", minimum: 0 },
      },
    },
  },
};

const MESSAGES: Readonly<Record<string, string>> = {
  additionalProperties: "Unknown property is not allowed.",
  const: "Value is not allowed.",
  enum: "Value is not allowed.",
  format: "Value has an invalid format.",
  if: "Value does not satisfy a conditional schema rule.",
  maxItems: "Array length is outside the allowed range.",
  maxLength: "String length is outside the allowed range.",
  minItems: "Array length is outside the allowed range.",
  minLength: "String length is outside the allowed range.",
  pattern: "Value has an invalid format.",
  required: "Required property is missing.",
  type: "Value has an invalid type.",
  uniqueItems: "Array items must be unique.",
  anyOf: "Value does not match an allowed shape.",
  maximum: "Value is outside the allowed range.",
  minimum: "Value is outside the allowed range.",
};

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
});
addFormats(ajv);

const validators: Readonly<Record<SchemaKind, ValidateFunction>> = {
  handoff: ajv.compile(HANDOFF_SCHEMA),
  "operation-manifest": ajv.compile(OPERATION_MANIFEST_SCHEMA),
  "worktree-parallel": ajv.compile(WORKTREE_PARALLEL_SCHEMA),
};

function escapePointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function errorPointer(error: ErrorObject): string {
  if (error.keyword === "required") {
    return `${error.instancePath}/${escapePointerSegment(String(error.params.missingProperty))}`;
  }
  if (error.keyword === "additionalProperties") {
    return `${error.instancePath}/${escapePointerSegment(String(error.params.additionalProperty))}`;
  }
  return error.instancePath;
}

function compareDiagnostics(left: SchemaDiagnostic, right: SchemaDiagnostic): number {
  const pointerOrder = left.pointer < right.pointer ? -1 : left.pointer > right.pointer ? 1 : 0;
  if (pointerOrder !== 0) return pointerOrder;
  return left.code < right.code ? -1 : left.code > right.code ? 1 : 0;
}

function diagnosticsFor(errors: readonly ErrorObject[]): SchemaDiagnostic[] {
  return errors
    .map((error) => ({
      code: `schema_${error.keyword}` as SchemaDiagnosticCode,
      severity: "error" as const,
      pointer: errorPointer(error),
      message: MESSAGES[error.keyword] ?? "Value does not satisfy the schema.",
    }))
    .sort(compareDiagnostics);
}

/**
 * A pointer is safe to report because every segment is schema-derived, except the trailing segment
 * of an unknown-property diagnostic, which is authored input and is replaced instead of echoed.
 */
export function safeSchemaPointer(diagnostic: SchemaDiagnostic): string {
  if (diagnostic.code !== "schema_additionalProperties") return diagnostic.pointer;
  const slash = diagnostic.pointer.lastIndexOf("/");
  return `${diagnostic.pointer.slice(0, Math.max(0, slash))}/@unknown`;
}

/** Validate structure only. The input object is returned unchanged and is never mutated. */
export function validateSchema<T>(
  kind: SchemaKind,
  value: unknown,
): SchemaValidationResult<T> {
  const validate = validators[kind];
  if (validate(value)) {
    return { ok: true, value: value as T, diagnostics: [] };
  }

  return {
    ok: false,
    value,
    diagnostics: diagnosticsFor(validate.errors ?? []),
  };
}

export function validateHandoffSchema(value: unknown): SchemaValidationResult<Handoff> {
  return validateSchema<Handoff>("handoff", value);
}

export function validateOperationManifestSchema(
  value: unknown,
): SchemaValidationResult<OperationManifest> {
  return validateSchema<OperationManifest>("operation-manifest", value);
}

export function validateWorktreeParallelSchema(
  value: unknown,
): SchemaValidationResult<WorktreeParallelContract> {
  return validateSchema<WorktreeParallelContract>("worktree-parallel", value);
}
