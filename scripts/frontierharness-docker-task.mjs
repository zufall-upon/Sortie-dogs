import { execFile } from "node:child_process";
import { appendFile, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readDockerWorkspaceFile } from "../dist/plugin/docker-validation.js";

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
const correctionAgent = agent => typeof agent === "string" && /^dog-reviewer-correction-v010-[a-f0-9]{16}$/u.test(agent);
const productAgent = agent => ["dog-operator", "dogs-coordinator", "dog-worker-v010", "dog-reviewer-v010"].includes(agent) || correctionAgent(agent);

function workspacePath(value) {
  return typeof value === "string" && value.length > 0 && posix.isAbsolute(value) &&
    posix.normalize(value) === value && !value.includes("\0");
}

export default {
  id: "sortie-dogs.frontierharness-native-docker-task",
  async setup(ctx) {
    const directory = ctx.location?.directory;
    if (typeof directory !== "string" || !directory) throw new Error("Docker task gateway location is unavailable");
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
    const auditPath = join(directory, "docker-exec-audit.ndjson");
    await writeFile(auditPath, "", { mode: 0o600, flag: "wx" });
    const sessionAgent = async context => {
      if (typeof context.sessionID === "string" && typeof ctx.session?.get === "function") {
        const response = await ctx.session.get({ sessionID: context.sessionID });
        const session = object(response?.data ?? response);
        if (typeof session.agent === "string") return session.agent;
      }
      return context.agent;
    };

    await ctx.tool.transform(editor => {
      editor.namespace({ name: "fh", description: "FrontierHarness fixed task-container tool" });
      editor.add({
        name: "docker_exec",
         description: "For the admitted Worker or native Reviewer correction only: run a bounded command in the fixed task container at the supplied absolute workspace CWD. Initial Review uses docker_read, not this execution tool.",
        input: {
          type: "object",
          properties: {
            container_id: { type: "string", enum: [container], description: "The fixed main-service container ID from the task gateway." },
            cwd: { type: "string", description: "Absolute POSIX working directory inside the task container." },
            command: { type: "string", description: "Command executed only inside the fixed task container." },
          },
          required: ["container_id", "cwd", "command"],
          additionalProperties: false,
        },
        options: { namespace: "fh", codemode: false },
        execute: async ({ container_id: requestedContainer, cwd, command }, context) => {
          const agent = await sessionAgent(context);
          // The correction role is registered/switched by the existing native
          // repair_review admission. Read-only Reviewer gets no exec grant.
          if (agent !== "dog-worker-v010" && !correctionAgent(agent)) throw new Error("fixed-task-container-tool-author-only");
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
      editor.add({
        name: "docker_read",
        description: "Read a file or directory from the exact Docker candidate in the native Review envelope. No shell or mutation. Copy container_id, cwd and candidate from protected_binding_ref.docker_workspace; path is repository-relative or an absolute candidate path.",
        input: { type: "object", properties: {
          container_id: { type: "string", enum: [container] }, cwd: { type: "string" },
          candidate: { type: "string", description: "Exact sha256 candidate from the formal validation/Review envelope." },
          path: { type: "string" }, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 2000 },
        }, required: ["container_id", "cwd", "candidate", "path"], additionalProperties: false },
        options: { namespace: "fh", codemode: false },
        execute: async ({ container_id: requestedContainer, cwd, candidate, path, offset, limit }, context) => {
          const agent = await sessionAgent(context);
          if (!productAgent(agent)) throw new Error("fixed-task-container-read-role-unavailable");
          if (requestedContainer !== container) throw new Error("fixed-task-container-id-mismatch");
          const result = await readDockerWorkspaceFile(container, cwd, candidate, path, offset, limit);
          await appendFile(auditPath, `${JSON.stringify({ type: "docker_read", agent, session_id: context.sessionID ?? null,
            container_id: container, cwd, candidate, path: result.path, file_sha256: result.sha256 ?? null })}\n`);
          return { content: JSON.stringify(result) };
        },
      });
    });

    const candidateTools = (await ctx.tool.list()).map(tool => tool.id)
      .filter(id => typeof id === "string" && id.startsWith("sortie_v010_")).sort();
    await ctx.tool.transform(editor => {
      for (const tool of editor.list()) {
        const id = tool.id;
        if (typeof id !== "string" || (!CORE_TOOL_IDS.has(id) && !id.startsWith("sortie_v010_") && !["fh_docker_exec", "fh_docker_read"].includes(id))) {
          editor.remove(id);
        }
      }
    });
    const ids = (await ctx.tool.list()).map(tool => tool.id).filter(id => typeof id === "string").sort();
    await writeFile(join(directory, "docker-tool-registry.json"), `${JSON.stringify({
      candidate_plugin_tools_seen: REQUIRED_CANDIDATE_TOOLS.every(id => ids.includes(id)),
      candidate_plugin_tools: candidateTools,
      required_candidate_tools: REQUIRED_CANDIDATE_TOOLS,
      registered_tool_ids: ids,
      host_shell_and_filesystem_tools_removed: !ids.some(id => ["shell", "bash", "edit", "write", "patch", "apply_patch"].includes(id)),
      docker_execution: "direct-native-tool-with-container-cwd-and-exit-header-v1",
    }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    if (!ids.includes("fh_docker_exec") || !ids.includes("fh_docker_read") || !ids.includes("subagent") || !ids.includes("read") || ids.includes("task") ||
        REQUIRED_CANDIDATE_TOOLS.some(id => !ids.includes(id)) ||
        ids.some(id => !CORE_TOOL_IDS.has(id) && !id.startsWith("sortie_v010_") && !["fh_docker_exec", "fh_docker_read"].includes(id))) {
      throw new Error("gateway tool registry missing a required tool or still includes host mutation tools");
    }
    // Keep the existing gateway's route/usage receipts when selecting the native
    // tool. A proof-capable tool must not silently remove campaign accounting.
    const routePath = join(directory, "sortie-agent-route-audit.ndjson");
    const requestPath = join(directory, "model-request-audit.ndjson");
    const usagePath = join(directory, "model-usage-audit.ndjson");
    for (const path of [routePath, requestPath, usagePath]) await writeFile(path, "", { mode: 0o600, flag: "wx" });
    const sessions = new Set(), seenUsage = new Map(), seenRoutes = new Set();
    let pending = Promise.resolve();
    const finite = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
    const recordUsage = async sessionID => {
      const history = await ctx.session.context({ sessionID });
      for (const info of Array.isArray(history) ? history : []) {
        const model = object(info.model), tokens = object(info.tokens), cache = object(tokens.cache);
        if (info.type !== "assistant" || typeof info.id !== "string" || !Number.isFinite(info.time?.completed) ||
            typeof model.providerID !== "string" || typeof model.id !== "string") continue;
        const row = { type: "model_usage", session_id: sessionID, message_id: info.id, agent: info.agent ?? null,
          model_route: `${model.providerID}/${model.id}`, completed_at: info.time.completed,
          tokens: { input: finite(tokens.input), output: finite(tokens.output), reasoning: finite(tokens.reasoning),
            cache_read: finite(cache.read), cache_write: finite(cache.write) }, cost: finite(info.cost) };
        const signature = createHash("sha256").update(JSON.stringify(row)).digest("hex"), key = `${sessionID}\0${info.id}`;
        if (seenUsage.get(key) === signature) continue;
        await appendFile(usagePath, `${JSON.stringify(row)}\n`);
        seenUsage.set(key, signature);
      }
    };
    const requestHook = await ctx.session.hook("model.request", event => {
      if (event.kind !== "primary") return;
      sessions.add(event.sessionID);
      pending = pending.then(() => appendFile(requestPath, `${JSON.stringify({ type: "model_request",
        session_id: event.sessionID, agent: event.agent, model_route: `${event.model.providerID}/${event.model.id}` })}\n`));
    });
    const contextHook = await ctx.session.hook("context", event => {
      if (!productAgent(event.agent)) return;
      event.system.push({ type: "text", text: `FrontierHarness: task source is inside fixed container ${container}, ordinarily /app, not the host gateway. Use native fh_docker_exec with container_id=${container} and explicit absolute cwd. Register that same container CWD in validation_cwd for each check; gateway CWD is not a substitute. Source read/write paths describe the task workspace. The existing native Mission tools handle validation, finish, review and acceptance; a Docker PASS message alone is not formal proof.` });
      if (event.agent === "dog-reviewer-v010" || correctionAgent(event.agent)) event.system.push({ type: "text", text:
        "Inspect the actual candidate with fh_docker_read, copying container_id/cwd/candidate from formal_validation[].evidence[].protected_binding_ref.docker_workspace in your Review envelope. Read path='.' to list files, then read affected files and assertions. This tool checks the same bytes before and after each read. Host gateway read is only for contracts, not task source. Initial Review is read-only; repair_review admits the native correction role before any Docker exec/mutation, using the existing scoped correction contract." });
    });
    const controller = new AbortController();
    const events = (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (!["session.created", "session.idle", "session.updated"].includes(event.type)) continue;
        const sessionID = event.data?.sessionID;
        if (typeof sessionID !== "string") continue;
        pending = pending.then(async () => {
          const response = await ctx.session.get({ sessionID }), session = object(response?.data ?? response);
          if (productAgent(session.agent)) {
            const row = { type: "agent_session", session_id: sessionID, agent: session.agent, parent_id: session.parentID ?? null };
            const key = JSON.stringify(row);
            if (!seenRoutes.has(key)) { await appendFile(routePath, `${key}\n`); seenRoutes.add(key); }
          }
          if (event.type === "session.idle" && sessions.has(sessionID)) await recordUsage(sessionID);
        });
        await pending;
      }
    })();
    // Observe rejection now as well as during cleanup; no unhandled stream task.
    void events.catch(() => undefined);
    return async () => {
      controller.abort();
      await events.catch(error => { if (!controller.signal.aborted) throw error; });
      await pending;
      for (const sessionID of sessions) await recordUsage(sessionID);
      await requestHook.dispose();
      await contextHook.dispose();
    };
  },
};
