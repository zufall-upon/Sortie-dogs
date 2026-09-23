import { WorkLoop, WORK_LIMITS, isRecord, workChanged, type WorkState, type WorkStore } from "../core/work-loop.js";
import { estimateModelUsageCost } from "./model-cost.js";
import type { OpenCodeV2Context } from "./v2.js";
import { resolve } from "node:path";

type ObjectValue = Record<string, any>;
export const V011_ROUTES = Object.freeze({
  operator: { providerID: "openai", id: "gpt-6-sol", variant: "xhigh" },
  worker: { providerID: "openai", id: "gpt-6-luna-fast", variant: "max" },
});
export interface NativeWorkContext extends OpenCodeV2Context {
  readonly storage: WorkStore;
  readonly agent: { transform(callback: (editor: { update(id: string, callback: (agent: ObjectValue) => void): void }) => void): Promise<unknown> };
}
const text = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value)
  ? value.filter(isRecord).filter(part => part.type === "text").map(part => part.text ?? "").join("\n") : "";
const objectSchema = (properties: ObjectValue, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const stringSchema = { type: "string" };
const primary = "dog-operator", worker = "dogs-coordinator";

/** V2-native user proxy: native execution/compaction, cheap implementation, explicit semantic review. */
export function createUserProxyPlugin() {
  return {
    id: "sortie-dogs.v011",
    async setup(context: NativeWorkContext) {
      if (!context.storage || !context.agent) throw new Error("Sortie v0.11 requires the native OpenCode V2 plugin API.");
      const configured = context.options?.maxAttempts ?? WORK_LIMITS.attempts;
      if (!Number.isInteger(configured) || Number(configured) < 1 || Number(configured) > 32) throw new Error("work-max-attempts-invalid");
      const loop = new WorkLoop(context.location.directory, context.storage, Number(configured));
      const controllers = new Map<string, Set<AbortController>>();
      const stopping = new Map<string, Promise<void>>();
      const lifetime = new AbortController();
      const info = async (id: string): Promise<ObjectValue> => {
        const value = await context.session.get({ sessionID: id });
        if (!isRecord(value)) throw new Error("work-session-identity-unavailable");
        if (value.location?.directory && resolve(value.location.directory) !== resolve(context.location.directory)) throw new Error("work-session-location-mismatch");
        return value;
      };
      const root = async (id: string): Promise<string> => {
        const session = await info(id);
        if (session.agent === primary && !session.parentID) return id;
        if (session.agent === worker && typeof session.parentID === "string") {
          const parent = await info(session.parentID);
          if (parent.agent === primary && !parent.parentID) return session.parentID;
        }
        throw new Error("work-profile-session-inactive");
      };
      const requireRoot = async (id: string) => {
        if (await root(id) !== id) throw new Error("work-operator-only");
      };
      async function history(id: string): Promise<ObjectValue[]> {
        if (!context.message) return (await context.session.context({ sessionID: id }) as unknown[]).filter(isRecord);
        const result: ObjectValue[] = [];
        let cursor: string | undefined;
        const seen = new Set<string>();
        for (let page = 0; page < 100; page++) {
          const value = await context.message.list({ sessionID: id, limit: 100, ...(cursor ? { cursor } : { order: "asc" }) });
          if (!isRecord(value) || !Array.isArray(value.data)) throw new Error("work-history-unavailable");
          result.push(...value.data.filter(isRecord));
          cursor = value.cursor?.next;
          if (!cursor) return result;
          if (seen.has(cursor)) throw new Error("work-history-cursor-repeated");
          seen.add(cursor);
        }
        throw new Error("work-history-limit");
      }
      async function reconcile(id: string): Promise<WorkState | null> {
        const work = await loop.current(id);
        if (work?.phase === "running" && work.callID) {
          // Replay the exact native call, including after a plugin/server restart. Prose is not terminal authority.
          for (const message of await history(id)) for (const part of message.content ?? []) {
            if (part.type !== "tool" || part.id !== work.callID || part.name !== "subagent") continue;
            if (["completed", "error"].includes(part.state?.status)) {
              await loop.settled(id, work.callID, part.state.status === "completed", text(part.state.content) || text(part.state.error));
            }
          }
          if ((await loop.current(id))?.phase === "running") {
            const native = await info(id);
            if (["failed", "interrupted"].includes(native.outcome) && native.time?.idle >= work.updatedAt) {
              await loop.interrupt(id);
            }
          }
        }
        return loop.current(id);
      }
      async function costs(work: WorkState) {
        const rows = [];
        for (const id of [work.root, ...(work.child ? [work.child] : [])]) {
          let estimated = 0, priced = 0, unpriced = 0, requests = 0;
          const models = new Set<string>();
          const reportedTiers = new Set<string>();
          for (const message of await history(id)) {
            if (!["assistant", "compaction"].includes(message.type) || (message.time?.created ?? 0) < work.startedAt || !message.time?.completed) continue;
            requests++;
            const model = message.model ?? {}, usage = message.tokens ?? {};
            models.add(`${model.providerID}/${model.id}`);
            if (message.providerState?.serviceTier) reportedTiers.add(message.providerState.serviceTier);
            const estimate = estimateModelUsageCost({ providerID: model.providerID, modelID: model.id,
              uncachedInputTokens: usage.input, outputTokens: usage.output, reasoningTokens: usage.reasoning,
              cacheReadTokens: usage.cache?.read, cacheWriteTokens: usage.cache?.write,
              serviceTier: [V011_ROUTES.worker.id, "gpt-6-luna"].includes(model.id) ? "priority" : message.providerState?.serviceTier ?? "standard" });
            if (estimate.status === "priced") { priced++; estimated += estimate.usd; } else unpriced++;
          }
          rows.push({ role: id === work.root ? "operator" : "worker", models: [...models], requests,
            estimated_usd: priced ? estimated : null, unpriced_requests: unpriced, provider_reported_tiers: [...reportedTiers] });
        }
        return { rows, note: "Estimated pricing of completed requests including native compaction, using requested Fast (2x) rates for Luna. Provider-reported tiers are shown separately; this is not billing or confirmation of Fast delivery. The in-flight acceptance/final response is not included." };
      }
      async function packet(work: WorkState, actor: string = work.root) {
        const inspected = await loop.inspect(work.root, actor);
        work = inspected.work ?? work;
        const source = inspected.source;
        return { work_id: work.id, phase: work.phase, attempts: work.attempts, max_attempts: loop.maxAttempts,
          original_requests: work.requests.map(request => ({ ...request, ...(request.files ? { files: request.files.map(file => ({ ...file,
            uri: file.uri.startsWith("data:") ? "[native attachment retained]" : file.uri })) } : {}) })),
          instructions: work.instructions, feedback: work.feedback,
          changed_paths: workChanged(work.baseline, source), source_fingerprint: source.fingerprint,
          checks: work.checks.map(check => ({ id: check.id, command: check.command, exit: check.exit,
            current: check.before === source.fingerprint && check.after === source.fingerprint,
            timed_out: check.timedOut, interrupted: check.interrupted })), worker_report: work.report,
          ...(work.phase === "completed" ? { accepted_source_current: work.acceptedSource === source.fingerprint } : {}),
          ...(work.phase === "ready" ? { task: loop.task(work), next: "Call the native subagent tool with this task unchanged, in the foreground." }
            : { next: work.phase === "review" ? "Compare all original requests with actual changes and check evidence, then call review_work. Revise on any omission."
              : work.phase === "interrupted" ? "Call start_work to continue this same job and child; attempts and original instructions are retained."
                : work.phase === "running" ? "The native child call is outstanding. Let it return; use cancel_work for an explicit stop."
                  : work.phase === "completed" ? "Report the accepted result to the user." : "Work was explicitly cancelled." }) };
      }
      async function stop(id: string, cancelled: boolean) {
        await stopping.get(id);
        const operation = (async () => {
          const work = await loop.current(id);
          await loop.interrupt(id, cancelled);
          for (const controller of controllers.get(id) ?? []) controller.abort();
          if (work?.child && !["completed", "cancelled"].includes(work.phase)) {
            await context.session.interrupt({ sessionID: work.child, resume: false });
          }
        })();
        stopping.set(id, operation);
        try { await operation; } finally { if (stopping.get(id) === operation) stopping.delete(id); }
      }
      await context.agent.transform(editor => {
        // The v0.11 policy replaces legacy inverted defaults; reviewer/advisor definitions are untouched.
        editor.update(primary, agent => { agent.model = { ...V011_ROUTES.operator }; });
        editor.update(worker, agent => { agent.model = { ...V011_ROUTES.worker }; });
      });
      await context.tool.transform(editor => {
        const add = (name: string, description: string, input: ObjectValue,
          execute: (args: ObjectValue, execution: ObjectValue) => Promise<unknown>) => editor.add({ name: `sortie_v011_${name}`, description, input, options: { codemode: false },
          execute: async (args, execution) => ({ content: JSON.stringify(await execute(isRecord(args) ? args : {}, execution)) }) });
        add("start_work", "Operator: delegate the user's actual request to the low-cost implementer. The host retains original instructions; supply only concise extra guidance. Also resumes interrupted work without resetting attempts.",
          objectSchema({ instructions: { type: "string", maxLength: 8000 } }), async (args, execution) => {
            const id = String(execution.sessionID); await requireRoot(id);
            await stopping.get(id);
            await reconcile(id);
            return packet(await loop.start(id, args.instructions ?? ""));
          });
        add("work_status", "Read current original instructions, native execution state, changed files and real validation receipts. It does not accept work.",
          objectSchema({}), async (_args, execution) => {
            const actor = String(execution.sessionID), id = await root(actor);
            const work = await reconcile(id); return work ? packet(work, actor) : { phase: "idle" };
          });
        add("check", "Run one meaningful final verification command in the workspace and record its actual exit and source identity. Discover commands while working; fix failures and rerun after edits. No prewritten plan or manifest is required.",
          objectSchema({ command: { type: "string", minLength: 1, maxLength: 8000 }, timeout_ms: { type: "integer", minimum: 100, maximum: 1200000 } }, ["command"]),
          async (args, execution) => {
            const actor = String(execution.sessionID), id = await root(actor);
            const controller = new AbortController();
            const parent = execution.signal as AbortSignal | undefined;
            const abort = () => controller.abort();
            parent?.addEventListener("abort", abort, { once: true });
            if (parent?.aborted || lifetime.signal.aborted) controller.abort();
            const active = controllers.get(id) ?? new Set(); controllers.set(id, active); active.add(controller);
            try {
              const nativeShell = (await context.tool.list?.())?.find(tool => tool.id === "shell");
              if (!nativeShell) throw new Error("Native OpenCode shell tool is unavailable.");
              return await loop.check(id, actor, args.command, args.timeout_ms ?? 120000, controller.signal,
                async (directory, command, timeout, signal) => {
                  // Invoke the actual V2 executor, including its shell permissions, external-directory checks,
                  // process ownership, cancellation and platform-selected shell. Never run a second hidden shell.
                  const native = await nativeShell.execute({ command, workdir: directory, timeout, background: false }, { ...execution, signal });
                  const output = isRecord(native.output) ? native.output : native.metadata;
                  if (!isRecord(output) || output.status === "running" || (!Number.isInteger(output.exit) && output.timeout !== true && !signal?.aborted)) throw new Error("Native validation did not return a foreground exit status.");
                  return { exit: Number.isInteger(output.exit) ? output.exit : null, timedOut: output.timeout === true, interrupted: signal?.aborted === true,
                    output: text(native.content).slice(-WORK_LIMITS.outputBytes) };
                });
            }
            finally { active.delete(controller); parent?.removeEventListener("abort", abort); if (!active.size) controllers.delete(id); }
          });
        add("review_work", "Operator only: compare ALL original user instructions, negative constraints and quality requirements with actual changes. Accept with the relevant current successful check IDs and a substantive assessment, or revise with concrete missing requirements. Revision returns the SAME cheap child for corrections.",
          objectSchema({ decision: { type: "string", enum: ["accept", "revise"] }, assessment: { type: "string", minLength: 1, maxLength: 8000 },
            checks: { type: "array", items: stringSchema, maxItems: WORK_LIMITS.checks } }, ["decision", "assessment", "checks"]),
          async (args, execution) => {
            const id = String(execution.sessionID); await requireRoot(id); await reconcile(id);
            const work = await loop.review(id, args.decision, args.assessment, args.checks);
            return { ...await packet(work), ...(work.phase === "completed" ? { receipt: { status: "succeeded", work_id: work.id,
              requests: work.requests.map(item => item.id), source_fingerprint: work.acceptedSource, check_ids: work.acceptedChecks,
              assessment: work.assessment }, cost: await costs(work).catch(() => ({ available: false })) } : {}) };
          });
        add("cancel_work", "Operator: explicitly stop this owned job and its child. Native interruption is awaited; files and existing evidence remain available.",
          objectSchema({}), async (_args, execution) => {
            const id = String(execution.sessionID); await requireRoot(id); await stop(id, true);
            const work = await loop.current(id); return work ? packet(work) : { phase: "idle" };
          });
        if (context.session.compact) add("compact", "Compact this session with OpenCode V2's native durable compaction. Original work and receipts are retained by the host; no synthetic continuation prompt is queued.",
          objectSchema({}), async (_args, execution) => {
            const id = String(execution.sessionID); await root(id);
            if (!context.session.compact) throw new Error("Native session.compact is unavailable in this OpenCode version.");
            await context.session.compact({ sessionID: id }); return { status: "compaction-queued" };
          });
      });
      await context.session.hook("prompt", async event => {
        const id = String(event.sessionID), session = await info(id);
        if (session.agent === primary && !session.parentID) {
          if (isRecord(event.prompt) && (text(event.prompt.text).trim() || event.prompt.files?.length || event.prompt.skills?.length)) {
            await loop.observe(id, { id: String(event.messageID), text: text(event.prompt.text), at: Date.now(),
              ...(event.prompt.files?.length ? { files: event.prompt.files.map(({ mention, ...file }: ObjectValue) => file) } : {}),
              ...(event.prompt.skills?.length ? { skills: event.prompt.skills.map(({ id }: ObjectValue) => ({ id })) } : {}) });
          }
          if (session.model?.providerID !== "openai" || session.model?.id !== V011_ROUTES.operator.id) {
            await context.session.switchModel({ sessionID: id, model: V011_ROUTES.operator });
          }
        } else if (session.agent === worker && session.parentID && isRecord(event.prompt)) {
          const owner = await root(id);
          const prompt = text(event.prompt.text).replace(/^You are a subagent spawned by another session\.\n/u, "");
          event.prompt.text = await loop.claim(owner, id, prompt);
          const work = (await loop.current(owner))!;
          event.prompt.files = work.requests.flatMap(request => request.files ?? []);
          event.prompt.skills = work.requests.flatMap(request => request.skills ?? []);
          if (session.model?.providerID !== "openai" || session.model?.id !== V011_ROUTES.worker.id) {
            await context.session.switchModel({ sessionID: id, model: V011_ROUTES.worker });
          }
        }
      });
      await context.tool.hook("execute.before", async event => {
        const id = String(event.sessionID), session = await info(id);
        if (session.agent !== primary && session.agent !== worker) {
          if (String(event.tool).startsWith("sortie_v011_")) throw new Error("work-profile-session-inactive");
          return;
        }
        const owner = await root(id);
        if (session.agent === worker) {
          await loop.assertWorker(owner, id);
          if (event.tool === "subagent") throw new Error("work-worker-does-not-delegate");
        } else if (event.tool === "subagent" && isRecord(event.input)) {
          if (event.input.agent === worker) await loop.admit(owner, String(event.id), event.input);
          else if (!["dog-reviewer-v010", "dog-advisor-v010"].includes(event.input.agent)) throw new Error("work-operator-delegate-not-allowed");
        }
      });
      await context.tool.hook("execute.after", async event => {
        if (event.tool !== "subagent") return;
        const id = String(event.sessionID), session = await info(id);
        if (session.agent !== primary || session.parentID) return;
        const result = isRecord(event.result) ? event.result : {};
        await loop.settled(id, String(event.id), event.status === "completed", text(result.content) || text(event.error));
      });
      const inject = async (event: ObjectValue) => {
        const session = await info(String(event.sessionID));
        if (![primary, worker].includes(session.agent)) return;
        if (event.model && (event.model.providerID !== "openai" || ![V011_ROUTES.operator.id, V011_ROUTES.worker.id, "gpt-6-luna"].includes(event.model.id))) {
          throw new Error("Sortie v0.11 requires SOL6 or Luna6. Set the selected session and auxiliary compaction/title agents to these models; reviewer/advisor settings are independent.");
        }
        const owner = await root(String(event.sessionID)), work = await loop.current(owner);
        if (([V011_ROUTES.worker.id, "gpt-6-luna"].includes(event.model?.id) || (!event.model && session.agent === worker)) && isRecord(event.options)) {
          // OpenAI documents priority as the backwards-compatible spelling of Fast mode.
          event.options.serviceTier = "priority";
        }
        if (Array.isArray(event.system) && work) event.system.push({ type: "text", text:
          `SORTIE v0.11 durable work ${work.id}; phase=${work.phase}. User intent survives compaction. ` +
          (session.agent === primary ? "Your role is the user's proxy: delegate routine work, compare results with every original instruction, and accept only with review_work. " : "You own all routine investigation, edits, testing and corrections. ") +
          "Use work_status after compaction for current evidence. Do not reconstruct a proposal or an execution manifest." });
        if (session.agent === worker && work && Array.isArray(event.system) && work.requests.length > (work.deliveredRequests ?? 0)) {
          event.system.push({ type: "text", text: "Additional original user instructions received during execution:\n" +
            work.requests.slice(work.deliveredRequests ?? 0).map(request => request.text).join("\n\n") });
        }
        if (session.agent === worker && isRecord(event.tools)) {
          for (const name of Object.keys(event.tools)) if (name.startsWith("sortie_v011_") && !["sortie_v011_check", "sortie_v011_work_status", "sortie_v011_compact"].includes(name)) delete event.tools[name];
        }
      };
      await context.session.hook("context", inject);
      await context.session.hook("compaction", inject);
      await context.session.hook("title", inject);
      await context.session.hook("generate", inject);
      const fastRequest = async (event: ObjectValue) => {
        // The native gpt-6-luna-fast catalog entry already overlays priority. Retain the
        // explicit tier only for older auxiliary-agent configurations selecting base Luna6.
        if (event.model?.providerID !== "openai" || event.model?.id !== "gpt-6-luna") return false;
        const session = await info(String(event.sessionID));
        return [primary, worker].includes(session.agent);
      };
      await context.session.hook("http.request", async event => {
        if (!await fastRequest(event) || !(event.request instanceof Request) || event.request.method !== "POST") return;
        const body = await event.request.clone().json();
        if (!isRecord(body) || body.model !== "gpt-6-luna") return;
        const headers = new Headers(event.request.headers); headers.delete("content-length");
        event.request = new Request(event.request, { headers, body: JSON.stringify({ ...body, service_tier: "priority" }) });
      });
      await context.session.hook("experimental.ws.send", async event => {
        if (!await fastRequest(event) || typeof event.frame !== "string") return;
        const frame = JSON.parse(event.frame);
        if (frame.type !== "response.create") return;
        if (isRecord(frame.response)) frame.response.service_tier = "priority";
        else frame.service_tier = "priority";
        event.frame = JSON.stringify(frame);
      });
      void (async () => {
        for await (const event of context.event.subscribe({ signal: lifetime.signal })) {
          if (!["session.execution.interrupted", "session.execution.failed"].includes(String(event.type))) continue;
          const id = isRecord(event.data) ? event.data.sessionID : undefined;
          if (typeof id !== "string") continue;
          try {
            const session = await info(id);
            if (session.agent === primary && !session.parentID) await stop(id, false);
            else if (session.agent === worker) {
              const owner = await root(id), work = await loop.current(owner);
              if (work?.child === id && work.phase === "running") await loop.interrupt(owner);
            }
          } catch (error) { console.warn("[sortie-dogs-v011] interruption reconciliation", error instanceof Error ? error.message : "unknown"); }
        }
      })().catch(error => { if (!lifetime.signal.aborted) console.warn("[sortie-dogs-v011] event stream", error); });
      return () => { lifetime.abort(); for (const active of controllers.values()) for (const controller of active) controller.abort(); };
    },
  };
}
