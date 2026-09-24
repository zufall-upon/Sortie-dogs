/** Shared read-only native contract; usable by source-mode asset generation and the installed UI. */
export const WORK_OVERVIEW_RPC = {
  id: "sortie-work-overview", events: {}, methods: {
    read: { input: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"], additionalProperties: false },
      output: { type: "object" }, errors: {} },
  },
} as const;
