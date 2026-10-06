type JsonObject = Record<string, unknown>;
const record = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);

function plainSchema(value: unknown): JsonObject {
  // The V1 runtime uses Zod when @opencode-ai/plugin is installed. Its
  // enumerable `def` and `~standard` fields are not JSON Schema, and an
  // optional Zod string reports type="optional" rather than type="string".
  const source = record(value) && value.type === "optional" && record(value.def) && record(value.def.innerType)
    ? value.def.innerType : record(value) ? value : { type: "string" };
  const schema: JsonObject = Object.fromEntries(Object.entries(source).filter(([key, item]) =>
    !["x-sortie-optional", "optional", "~standard", "def", "_zod"].includes(key) &&
    item !== null && item !== undefined && typeof item !== "function"));
  // The native V2 provider serializes absent size limits as null for custom tools. Its
  // function-schema validator rejects those limits before even a non-Sortie agent can work.
  if (schema.type === "string") {
    schema.minLength ??= 0;
    schema.maxLength ??= 65535;
  } else if (schema.type === "array") {
    schema.minItems ??= 0;
    schema.maxItems ??= 4096;
    schema.items = plainSchema(schema.items);
  } else if (schema.type === "object" && record(schema.properties)) {
    schema.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, item]) => [key, plainSchema(item)]));
  }
  return schema;
}

function optionalArgument(value: unknown): boolean {
  return record(value) && (value["x-sortie-optional"] === true ||
    (value.type === "optional" && record(value.def) && record(value.def.innerType)));
}

export function toolSchema(args: Record<string, unknown>): JsonObject {
  const entries = Object.entries(args);
  return { type: "object", properties: Object.fromEntries(entries.map(([name, value]) => {
    const schema = plainSchema(value);
    if (optionalArgument(value)) {
      schema.description = `${typeof schema.description === "string" ? `${schema.description} ` : ""}Pass an empty string to omit this argument.`;
      // Object-typed optional arguments otherwise force a model to manufacture blank
      // required provenance fields. Admit the same omission sentinel we already decode.
      if (schema.type === "object") return [name, { anyOf: [schema, { type: "string", enum: [""], minLength: 0, maxLength: 0 }],
        description: schema.description }];
    }
    return [name, schema];
  })),
    // V2's model-schema lowering emits an unsupported `optional` annotation for
    // non-required custom-tool properties on some provider routes (including Luna).
    // Keep the wire shape strict and translate the sentinel back before V1 execution.
    required: entries.map(([name]) => name),
    additionalProperties: false };
}

export function legacyToolArgs(input: unknown, args: Record<string, unknown>): Record<string, string> {
  const value = record(input) ? { ...input } : {};
  for (const [name, schema] of Object.entries(args)) {
    if (optionalArgument(schema) && (value[name] === "" || record(value[name]) &&
        Object.values(value[name]).every(item => typeof item === "string" && !item.trim()))) delete value[name];
  }
  return value as Record<string, string>;
}

