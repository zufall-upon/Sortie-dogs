import { execFile } from "node:child_process";
import { appendFile, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_COMMAND_BYTES = 12_000;
const MAX_OUTPUT_BYTES = 96_000;
const EXEC_TIMEOUT_MS = 30 * 60 * 1000;
const REQUIRED_CANDIDATE_TOOLS = [
  "sortie_v010_start_mission", "sortie_v010_operator_next", "sortie_v010_plan_units",
  "sortie_v010_bind_write_gate", "sortie_v010_release_write_gate", "sortie_v010_operator_status",
  "sortie_v010_start_direct_unit", "sortie_v010_finish_direct_unit", "sortie_v010_repair_review",
];
const CORE_TOOL_IDS = new Set(["execute", "subagent", "read"]);
const CONTAINER_ID = /^[a-f0-9]{12,64}$/u;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};

function workspacePath(value) {
  return typeof value === "string" && value.length > 0 && posix.isAbsolute(value) &&
    posix.normalize(value) === value && !value.includes("\0");
}

export default {
  id: "sortie-dogs.frontierharness-native-docker-task",
  async setup(ctx) {
    const container = ctx.options?.container, instruction = ctx.options?.instruction, model = ctx.options?.model;
    if (typeof container !== "string" || !CONTAINER_ID.test(container)) {
      throw new Error("Docker task tool requires one validated main-service container ID");
    }
    if (typeof instruction !== "string" || !instruction || Buffer.byteLength(instruction, "utf8") > MAX_COMMAND_BYTES * 16) {
      throw new Error("Docker task tool requires the fixed official task instruction");
    }
    if (!Array.isArray(ctx.options?.allowedModels) || !new Set(ctx.options.allowedModels).has(model)) {
      throw new Error("Docker task gateway model is not allowlisted");
    }
    if (typeof ctx.tool?.transform !== "function" || typeof ctx.tool?.list !== "function") {
      throw new Error("Docker task native tool registry is unavailable");
    }
    const auditPath = join(ctx.directory, "docker-exec-audit.ndjson");
    await writeFile(auditPath, "", { mode: 0o600, flag: "wx" });

    await ctx.tool.transform(editor => {
      editor.namespace({ name: "fh", description: "FrontierHarness fixed task-container tool" });
      editor.add({
        name: "docker_exec",
        description: "For dog-worker-v010 only: run a bounded command in the fixed task container at the supplied absolute workspace CWD.",
        input: {
          type: "object",
          properties: {
            container_id: { type: "string", description: "The fixed main-service container ID from the task gateway." },
            cwd: { type: "string", description: "Absolute POSIX working directory inside the task container." },
            command: { type: "string", description: "Command executed only inside the fixed task container." },
          },
          required: ["container_id", "cwd", "command"],
          additionalProperties: false,
        },
        options: { namespace: "fh", codemode: false },
        execute: async ({ container_id: requestedContainer, cwd, command }, context) => {
          let agent = typeof context.agent === "string" ? context.agent : undefined;
          if (!agent && typeof context.sessionID === "string" && typeof ctx.session?.get === "function") {
            const response = await ctx.session.get({ sessionID: context.sessionID });
            const session = object(object(response).data).id ? object(response).data : object(response);
            agent = typeof session.agent === "string" ? session.agent : undefined;
          }
          if (agent !== "dog-worker-v010") throw new Error("fixed-task-container-tool-worker-only");
          if (requestedContainer !== container) throw new Error("fixed-task-container-id-mismatch");
          if (!workspacePath(cwd)) throw new Error("fixed-task-container-cwd-invalid");
          if (typeof command !== "string" || Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES) {
            throw new Error(`command must be a string no longer than ${MAX_COMMAND_BYTES} bytes`);
          }
          const started = Date.now(), sessionID = typeof context.sessionID === "string" ? context.sessionID : null;
          let exitCode = null, stdout = "", stderr = "";
          try {
            const result = await execFileAsync("docker", ["exec", "--workdir", cwd, container,
              "sh", "-lc", command], { encoding: "utf8", timeout: EXEC_TIMEOUT_MS,
              maxBuffer: MAX_OUTPUT_BYTES, signal: context.signal });
            exitCode = 0;
            stdout = result.stdout;
            stderr = result.stderr;
          } catch (error) {
            if (context.signal?.aborted) throw error;
            const code = error?.code;
            exitCode = typeof code === "number" && Number.isSafeInteger(code) ? code : null;
            stdout = typeof error?.stdout === "string" ? error.stdout : "";
            stderr = typeof error?.stderr === "string" ? error.stderr : String(error?.message ?? "docker-exec-failed");
          }
          await appendFile(auditPath, `${JSON.stringify({ type: "docker_exec", agent, session_id: sessionID,
            container_id: container, cwd, exit_code: exitCode, duration_ms: Date.now() - started,
            command_bytes: Buffer.byteLength(command, "utf8") })}\n`, "utf8");
          return { content: `exit_code=${exitCode ?? "unknown"}\n${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`
            .slice(0, MAX_OUTPUT_BYTES) };
        },
      });
    });

    const candidateTools = (await ctx.tool.list()).map(tool => tool.id)
      .filter(id => typeof id === "string" && id.startsWith("sortie_v010_")).sort();
    await ctx.tool.transform(editor => {
      for (const tool of editor.list()) {
        const id = tool.id;
        if (typeof id !== "string" || (!CORE_TOOL_IDS.has(id) && !id.startsWith("sortie_v010_") && id !== "fh_docker_exec")) {
          editor.remove(id);
        }
      }
    });
    const ids = (await ctx.tool.list()).map(tool => tool.id).filter(id => typeof id === "string").sort();
    await writeFile(join(ctx.directory, "docker-tool-registry.json"), `${JSON.stringify({
      candidate_plugin_tools_seen: REQUIRED_CANDIDATE_TOOLS.every(id => ids.includes(id)),
      candidate_plugin_tools: candidateTools,
      required_candidate_tools: REQUIRED_CANDIDATE_TOOLS,
      registered_tool_ids: ids,
      host_shell_and_filesystem_tools_removed: !ids.some(id => ["shell", "bash", "edit", "write", "patch", "apply_patch"].includes(id)),
      docker_execution: "direct-native-tool-with-container-cwd-and-exit-header-v1",
    }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    if (!ids.includes("fh_docker_exec") || !ids.includes("subagent") || !ids.includes("read") || ids.includes("task") ||
        REQUIRED_CANDIDATE_TOOLS.some(id => !ids.includes(id)) ||
        ids.some(id => !CORE_TOOL_IDS.has(id) && !id.startsWith("sortie_v010_") && id !== "fh_docker_exec")) {
      throw new Error("gateway tool registry missing a required tool or still includes host mutation tools");
    }
  },
};
