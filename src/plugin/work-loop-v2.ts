import { WorkLoop, WORK_LIMITS, isRecord, workChanged, workCheckCurrent, workUnresolvedChecks, type WorkState, type WorkStore } from "../core/work-loop.js";
import { estimateModelUsageCost } from "./model-cost.js";
import type { OpenCodeV2Context } from "./v2.js";
import { resolve } from "node:path";
import { WORK_PROGRESS_LIMITS, progressLimit, progressView, repairWorkToolHistory } from "../core/work-progress.js";
import { workReturnReport } from "./work-presentation.js";
import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { auxiliaryResponseUsage, observeAuxiliaryResponse } from "./work-usage.js";
import type { WorkAuxiliaryUsage } from "../core/work-loop.js";
import { randomUUID } from "node:crypto";
import { WORK_OVERVIEW_RPC, workOverview, pendingWorkOverview } from "../core/work-overview.js";

type ObjectValue = Record<string, any>;
export const V011_ROUTES = Object.freeze({
  operator: { providerID: "openai", id: "gpt-6-sol", variant: "xhigh" },
  worker: { providerID: "openai", id: "gpt-6-luna-fast", variant: "max" },
});
export interface NativeWorkContext extends OpenCodeV2Context {
  readonly storage: WorkStore;
  readonly agent: { transform(callback: (editor: { update(id: string, callback: (agent: ObjectValue) => void): void }) => void): Promise<unknown> };
  readonly rpc?: { register(definition: unknown, handlers: Record<string, (input: ObjectValue) => Promise<ObjectValue>>): Promise<unknown> };
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
      const option = (key: string, fallback: number, min: number, max: number) => {
        const value = context.options?.[key] ?? fallback;
        if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`work-${key}-invalid`);
        return Number(value);
      };
      const planningMs = option("maxPlanningMs", WORK_PROGRESS_LIMITS.idleMs, 50, 3_600_000);
      const operatorMs = option("maxOperatorPlanningMs", WORK_PROGRESS_LIMITS.operatorMs, 50, 3_600_000);
      const discoveryCalls = option("maxDiscoveryCalls", WORK_PROGRESS_LIMITS.inspections, 1, 128);
      const progressInterval = option("progressIntervalMs", WORK_PROGRESS_LIMITS.intervalMs, 10, 60_000);
      const controllers = new Map<string, Set<AbortController>>();
      const monitors = new Set<ReturnType<typeof setInterval>>();
      const stopping = new Map<string, Promise<void>>();
      const lifetime = new AbortController();
      const thinking = new Map<string, number>(), nudging = new Set<string>(), stoppedByUser = new Set<string>();
      const internalStops = new Set<string>();
      const controllerRoots = new Set<string>(); let observingControllers = false;
      const nativeCommands = new Map<string, { root: string; id: string; file: string }>();
      const childTurns = new Map<string, number>();
      const launchPermissions = new Map<string, ObjectValue[]>();
      await context.permission.hook("evaluate", async event => {
        // Observe the native permission decision without changing it. Keeping the
        // same draft also observes any later permission hook's final decision.
        if (event.action === "shell" && isRecord(event.source) && typeof event.source.id === "string") launchPermissions.get(`${event.sessionID}/${event.source.id}`)?.push(event);
      });
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
        if (work && ["running", "yielded"].includes(work.phase) && work.callID && work.settledCallID !== work.callID) {
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
        const receipts = { ...work.usageReceipts };
        for (const value of await loop.auxiliaryReceipts(work.root, work.startedAt, work.usageUntil)) {
          const id = `auxiliary:${value.id}`;
          if (!receipts[id] || receipts[id].pending) receipts[id] = value.receipt;
        }
        for (const { id, role } of [{ id: work.root, role: "operator" }, ...(work.child ? [{ id: work.child, role: "worker" }] : []), ...(work.supportSessions ?? [])]) {
          for (const message of await history(id)) {
            if (!["assistant", "compaction"].includes(message.type) || (message.time?.created ?? 0) < work.startedAt ||
                (message.time?.created ?? 0) >= (work.usageUntil ?? Infinity) || !message.time?.completed) continue;
            if (typeof message.id !== "string" || receipts[message.id]) continue;
            const model = message.model ?? {}, usage = message.tokens ?? {};
            // This exact native error comes from our pre-provider context hook. Keep
            // the local interruption in the ledger, but it is not a sent request.
            if (!message.tokens && message.error?.type === "unknown" && String(message.error.message).startsWith("work-pacing-yield-before-request:")) {
              receipts[message.id] = { session: id, model: `${model.providerID}/${model.id}`, tokens: 0, usd: 0, local: true };
              continue;
            }
            const estimate = estimateModelUsageCost({ providerID: model.providerID, modelID: model.id,
              uncachedInputTokens: usage.input, outputTokens: usage.output, reasoningTokens: usage.reasoning,
              cacheReadTokens: usage.cache?.read, cacheWriteTokens: usage.cache?.write,
              serviceTier: model.id === V011_ROUTES.worker.id || model.id === "gpt-6-luna" && ["worker", "operator"].includes(role)
                ? "priority" : message.providerState?.serviceTier ?? "standard" });
            receipts[message.id] = { session: id, model: `${model.providerID}/${model.id}`,
              tokens: typeof usage.input === "number" && typeof usage.output === "number"
                ? usage.input + usage.output + (usage.reasoning ?? 0) + (usage.cache?.read ?? 0) + (usage.cache?.write ?? 0) : null,
              usd: estimate.status === "priced" ? estimate.usd : null,
              ...(typeof message.providerState?.serviceTier === "string" ? { tier: message.providerState.serviceTier } : {}) };
          }
          let estimated = 0, priced = 0, unpriced = 0, requests = 0, tokens = 0, tokensKnown = true;
          const models = new Set<string>(), reportedTiers = new Set<string>();
          const modelUsage = new Map<string, { model: string; tokens: number; requests: number }>();
          for (const receipt of Object.values(receipts).filter(item => item.session === id)) {
            if (receipt.local) continue;
            requests++; models.add(receipt.model);
            if (receipt.tokens === null) tokensKnown = false; else tokens += receipt.tokens;
            if (receipt.usd === null) unpriced++; else { priced++; estimated += receipt.usd; }
            if (receipt.tier) reportedTiers.add(receipt.tier);
            const entry = modelUsage.get(receipt.model) ?? { model: receipt.model, tokens: 0, requests: 0 };
            entry.requests++; entry.tokens += receipt.tokens ?? 0; modelUsage.set(receipt.model, entry);
          }
          rows.push({ role, models: [...models], requests,
            tokens: tokensKnown ? tokens : null, model_usage: [...modelUsage.values()], estimated_usd: priced ? estimated : null, unpriced_requests: unpriced, provider_reported_tiers: [...reportedTiers] });
        }
        await loop.meter(work.root, work.id, receipts);
        return { rows, note: "Estimated pricing includes native compaction and observed title/generate requests; missing or pending usage remains unpriced. Luna uses requested Fast (2x) rates. Provider-reported tiers are shown separately; this is not billing or confirmation of Fast delivery. The in-flight acceptance/final response is not included." };
      }
      async function retainUsage(work: WorkState, usage: Awaited<ReturnType<typeof costs>>) {
        const tokens = usage.rows.every(row => row.tokens !== null) ? usage.rows.reduce((sum, row) => sum + (row.tokens ?? 0), 0) : null;
        await loop.usage(work.root, work.id, { tokens, usd: usage.rows.every(row => row.unpriced_requests === 0) ? usage.rows.reduce((sum, row) => sum + (row.estimated_usd ?? 0), 0) : null,
          estimatedUsd: usage.rows.reduce((sum, row) => sum + (row.estimated_usd ?? 0), 0),
          unpricedRequests: usage.rows.reduce((sum, row) => sum + row.unpriced_requests, 0),
          requests: usage.rows.reduce((sum, row) => sum + row.requests, 0), meteredAt: Date.now(),
          models: usage.rows.flatMap(row => row.model_usage.map(item => ({ model: item.model, tokens: item.tokens }))) });
      }
      const overviewMetering = new Map<string, Promise<void>>();
      async function refreshUsage(work: WorkState): Promise<WorkState> {
        if (Date.now() - (work.usage?.meteredAt ?? 0) < 10000) return work;
        const key = work.id;
        if (!overviewMetering.has(key)) {
          const observed = work;
          overviewMetering.set(key, costs(observed).then(usage => retainUsage(observed, usage))
            .catch(error => console.warn("[sortie-dogs-v011] overview usage", error))
            .finally(() => { overviewMetering.delete(key); }));
        }
        await overviewMetering.get(key);
        const current = await loop.current(work.root);
        return current?.id === work.id ? current : work;
      }
      if (context.rpc) await context.rpc.register(WORK_OVERVIEW_RPC, { read: async input => {
        const session = await info(String(input.sessionID));
        if (![primary, worker].includes(session.agent)) return { overview: null };
        const owner = await root(String(input.sessionID));
        let work = await loop.current(owner);
        if (!work || ["completed", "cancelled"].includes(work.phase)) {
          const progress = await loop.progress(owner);
          if (progress || !work) return { overview: progress ? pendingWorkOverview(progress) : null };
        }
        // UI refreshes do not prompt a model or hash the repository. Amortise usage
        // reads, while sharing the same durable receipts as acceptance and career.
        work = await refreshUsage(work);
        return { overview: workOverview(work) };
      } });
      async function packet(work: WorkState, actor: string = work.root, checkIDs: string[] = []) {
        const inspected = await loop.inspect(work.root, actor);
        work = await refreshUsage(inspected.work ?? work);
        const source = inspected.source;
        if (checkIDs.some(id => !work.checks.some(check => check.id === id))) throw new Error("work-check-not-found");
        const unresolved = workUnresolvedChecks(work, source.fingerprint);
        return { work_id: work.id, phase: work.phase, attempts: work.attempts, max_attempts: loop.attemptLimit(work),
          correction_window: loop.maxAttempts, attempt_extensions: work.attemptExtensions ?? [],
          original_requests: work.requests.map(request => ({ ...request, ...(request.files ? { files: request.files.map(file => ({ ...file,
            uri: file.uri.startsWith("data:") ? "[native attachment retained]" : file.uri })) } : {}) })),
          instructions: work.instructions, feedback: work.feedback,
          changed_paths: workChanged(work.baseline, source), source_fingerprint: source.fingerprint,
          checks: work.checks.map(check => ({ id: check.id, command: check.command, exit: check.exit,
            current: workCheckCurrent(work, check, source.fingerprint),
            timed_out: check.timedOut, interrupted: check.interrupted })), worker_report: work.report,
          unresolved_checks: unresolved.map(check => check.id),
          check_results: work.checks.filter(check => checkIDs.includes(check.id)).map(check => ({ ...check })),
          check_replacements: work.checkReplacements ?? [],
          child_session_id: work.child,
          progress: work.progress ? progressView(work.progress) : null,
          overview: workOverview(work),
          execution_results: work.commands ?? [],
          command_recovery: (work.commands ?? []).filter(command => !work.commands!.some(retry => retry.retryOf === command.id) && (command.status !== "completed" || command.exit === null))
            .map(command => ({ id: command.id, status: command.nativeStatus ?? command.status, next: ["rejected", "killed", "timeout"].includes(command.nativeStatus ?? "")
              ? "Confirmed terminal. Run a permitted equivalent corrected command with start_work(command=..., retry_command=this ID), then verify. Formal check replacements do not link native commands."
              : "Native execution is ambiguous/live. Inspect its retained shell ID and wait/reconcile; do not relaunch." })),
          controller: work.controller ?? null,
          ...(work.presentation ? { return_report: work.presentation.report, return_report_id: work.presentation.id } : {}),
          ...(work.phase === "completed" ? { accepted_source_current: work.acceptedSource === source.fingerprint } : {}),
          ...(work.phase === "ready" ? { task: loop.task(work), next: work.commands?.length
            ? "Reuse the execution results. Dispatch the same native child only if implementation/diagnosis remains; otherwise verify and review the result. Never blindly relaunch an existing command."
            : "Call the native subagent tool with this task unchanged, in the foreground." }
            : { next: work.phase === "review" ? "Compare all original requests with actual changes and check evidence, then call review_work. Revise on any omission."
              : work.phase === "yielded" ? "Internal course correction, not a user blocker. Inspect the observed evidence. If the returned child already completed all scope and checks, review_work can accept without another dispatch. Otherwise start_work with a concrete next command/instructions resumes the SAME child. Use progress_evidence for fresh relevant execution/check/diff IDs that you actually inspected; arbitrary activity does not clear the intervention."
              : work.phase === "waiting" ? "The existing controller owns the long job. Report 🐾 running with actual ledger counts, then yield this turn. The host will notify this SAME work when terminal. Do not poll, spawn a monitoring child, or accept a launch as completion."
              : work.phase === "interrupted" || work.phase === "blocked" ? "This job is incomplete. Report the blocker/interruption honestly; when it can be resolved, start_work resumes this same job and child with its original instructions and attempts."
                : work.phase === "running" ? "The native child call is outstanding. Let it return; use cancel_work for an explicit stop."
                  : work.phase === "completed" ? "Report the accepted result to the user." : "Work was explicitly cancelled." }) };
      }
      async function observeController(id: string) {
        const work = await loop.current(id);
        if (!work?.controller || ["completed", "cancelled"].includes(work.phase)) { controllerRoots.delete(id); return; }
        let snapshot: ObjectValue;
        try { snapshot = JSON.parse(await readFile(work.controller.path, "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
        await loop.controller(id, work.controller.path, snapshot);
        const current = (await loop.current(id))!;
        if (current.phase === "review" && !current.userStopped && !current.controller!.notified && !stoppedByUser.has(id) && !lifetime.signal.aborted) {
          const notice = `msg_${createHash("sha256").update(`${current.id}/controller/${current.controller!.runID}`).digest("hex").slice(0, 24)}`;
          await context.session.synthetic({ sessionID: id, id: notice, resume: true, delivery: "queue",
            description: "🐾 Controller returned — review the actual result",
            metadata: { "sortie-dogs/controller": current.id },
            text: `Owned controller ${current.controller!.runID} reached ${current.controller!.status}. This is host evidence for existing work ${current.id}, not a new user request. Read work_status, examine the actual ledger and required checks, and complete remaining scope or review. Terminal inference is not an official score or accepted completion.` });
          await loop.controllerNotified(id);
        }
      }
      const controllerTimer = setInterval(() => {
        if (observingControllers || lifetime.signal.aborted) return;
        observingControllers = true;
        void Promise.all([...controllerRoots].map(id => observeController(id).catch(error => console.warn("[sortie-dogs-v011] controller", error))))
          .finally(() => { observingControllers = false; });
      }, Math.max(progressInterval, 1000));
      monitors.add(controllerTimer);
      for (const work of await loop.retained()) {
        if (work.controller && !["completed", "cancelled"].includes(work.phase)) controllerRoots.add(work.root);
        for (const command of work.commands ?? []) if (command.nativeID && command.nativeFile && command.status !== "completed") {
          nativeCommands.set(command.nativeID, { root: work.root, id: command.id, file: command.nativeFile });
        }
      }
      async function stop(id: string, cancelled: boolean, execution?: ObjectValue) {
        stoppedByUser.add(id); thinking.delete(id);
        await stopping.get(id);
        const operation = (async () => {
          const work = await loop.current(id);
          if (cancelled && work?.controller && !["completed", "failed"].includes(work.controller.status)) {
            const shell = (await context.tool.list?.())?.find(tool => tool.id === "shell");
            if (!shell || !execution || !work.controller.stopCommand) throw new Error("work-controller-stop-unavailable");
            const result = await shell.execute({ command: work.controller.stopCommand, workdir: context.location.directory,
              timeout: 120000, background: false }, execution);
            const output = isRecord(result.output) ? result.output : isRecord(result.metadata) ? result.metadata : {};
            if (output.exit !== 0) throw new Error("work-controller-stop-failed: " + text(result.content));
          }
          await loop.interrupt(id, cancelled);
          for (const controller of controllers.get(id) ?? []) controller.abort();
          if (work?.child && !["completed", "cancelled"].includes(work.phase)) {
            await context.session.interrupt({ sessionID: work.child, resume: false });
          }
        })();
        stopping.set(id, operation);
        try { await operation; } finally { if (stopping.get(id) === operation) stopping.delete(id); }
      }
      // A clock before the first operator tool, not a hook that waits for the stalled model to act.
      const operatorTimer = setInterval(() => {
        for (const [id, since] of thinking) {
          if (Date.now() - since < operatorMs || nudging.has(id) || stoppedByUser.has(id)) continue;
          nudging.add(id);
          let deferred = false;
          void (async () => {
            const work = await loop.current(id), native = await info(id);
            // The short trigger is for reaching the first action. A substantive
            // post-result review has the ordinary planning interval, plus the same
            // fixed in-flight grace as the child, not a fresh 30s pretool cutoff.
            const limit = !work || ["completed", "cancelled"].includes(work.phase) ? operatorMs : planningMs;
            if (Date.now() - since < limit + Math.min(10000, limit / 4)) { deferred = true; return; }
            if (native.time?.idle >= since || work?.userStopped || work?.phase === "running" || work?.phase === "waiting" || work?.progress?.active.length || work?.phase === "cancelled") return;
            const progress = await loop.progress(id);
            if (!progress) return;
            const attempt = await loop.operatorNudge(id);
            if (attempt > loop.maxAttempts) return;
            const noticeID = `msg_${createHash("sha256").update(`${id}/${progress.startedAt}/${attempt}`).digest("hex").slice(0, 24)}`;
            try {
              await context.session.synthetic({ sessionID: id, id: noticeID, resume: false, delivery: "steer",
                description: "🐾 Sortie: execution pacing correction",
                metadata: { "sortie-dogs/pacing": true, receivedAt: progress.startedAt, attempt },
                text: "Host pacing intervention: the current operator response has not reached its next action. Preserve the original user request. For an action request use start_work now with any known command, or dispatch its existing task. At review, inspect the actual result and decide. Answer a question directly. This is host control, not a new user request. Do not repeat reconnaissance or ask the user to hurry routine work." });
              if (!stoppedByUser.has(id) && !lifetime.signal.aborted) {
                internalStops.add(id);
                const interrupted = await context.session.interrupt({ sessionID: id, resume: true });
                if (isRecord(interrupted) && interrupted.interrupted === false) internalStops.delete(id);
              }
            } catch (error) { internalStops.delete(id); throw error; }
          })().catch(error => console.warn("[sortie-dogs-v011] operator pacing", error)).finally(() => {
            if (!deferred && thinking.get(id) === since) thinking.delete(id);
            nudging.delete(id);
          });
        }
      }, progressInterval);
      monitors.add(operatorTimer);
      await context.agent.transform(editor => {
        // The v0.11 policy replaces legacy inverted defaults; reviewer/advisor definitions are untouched.
        editor.update(primary, agent => { agent.model = { ...V011_ROUTES.operator }; });
        editor.update(worker, agent => { agent.model = { ...V011_ROUTES.worker }; });
      });
      await context.tool.transform(editor => {
        // Keep the real native child card and executor. Publish host observations on that outstanding card,
        // without synthetic prompts, a second model loop, or a hidden shell implementation.
        editor.update?.("subagent", tool => {
          const execute = tool.execute;
          tool.execute = async (input, execution) => {
            if (!isRecord(input) || input.agent !== worker) return execute(input, execution);
            const id = String(execution.sessionID), session = await info(id);
            if (session.agent !== primary || session.parentID) return execute(input, execution);
            const work = await loop.current(id);
            if (!work || work.phase !== "running" || work.callID !== execution.id) throw new Error("work-dispatch-not-admitted");
            const report = typeof execution.progress === "function" ? execution.progress as (value: ObjectValue) => Promise<void> : async () => {};
            let metadata: ObjectValue = {}, ended = false, pending: Promise<void> | undefined;
            const publish = async () => {
              const current = await loop.current(id);
              if (!current || current.id !== work.id || current.callID !== work.callID || !current.progress) return;
              const progress = progressView(current.progress);
              await report({ ...metadata, ...(current.child ? { sessionID: current.child } : {}),
                description: `🐾 ${progress.phase} · ${Math.floor(progress.elapsed_ms / 1000)}s · ${progress.summary}`,
                sortie_progress: progress });
              const reason = current.phase === "running" ? progressLimit(current.progress, Date.now(), planningMs, discoveryCalls) : null;
              // Prefer the next native request boundary: cutting a recently submitted
              // response discards useful reasoning and can lose provider usage. This is
              // one fixed grace beyond the cumulative deadline, never a reset by activity.
              const turn = current.child ? childTurns.get(current.child) : undefined;
              const deadline = Math.max(current.progress.nextInterventionAt ?? 0,
                (current.progress.reviewedAt ?? current.progress.startedAt) + planningMs);
              const grace = Math.min(10_000, planningMs / 4);
              if (reason && (turn === undefined || Date.now() >= deadline + grace || Date.now() - turn >= planningMs) && await loop.stall(id, work.callID!, reason)) {
                // Yield is internal; the real foreground return wakes the operator after child settlement.
                if (current.child) await context.session.interrupt({ sessionID: current.child, resume: false });
                await report({ ...metadata, ...(current.child ? { sessionID: current.child } : {}),
                  description: `🐾 軌道修正 · ${reason}`, sortie_progress: progressView((await loop.current(id))!.progress!) });
              }
            };
            const tick = () => {
              if (ended || pending || lifetime.signal.aborted) return;
              pending = publish().catch(error => { console.warn("[sortie-dogs-v011] progress", error instanceof Error ? error.message : "unknown"); })
                .finally(() => { pending = undefined; });
            };
            const timer = setInterval(tick, progressInterval); monitors.add(timer);
            try {
              await publish();
              const result = await execute(input, { ...execution, progress: async (update: ObjectValue) => {
                metadata = { ...metadata, ...update }; await publish();
              } });
              return { ...result, metadata: { ...metadata, ...(isRecord(result.metadata) ? result.metadata : {}),
                sortie_progress: (await loop.current(id))?.progress ? progressView((await loop.current(id))!.progress!) : null } };
             } finally { ended = true; clearInterval(timer); monitors.delete(timer); const current = await loop.current(id); if (current?.child) childTurns.delete(current.child); await pending; }
          };
        });
        const add = (name: string, description: string, input: ObjectValue,
          execute: (args: ObjectValue, execution: ObjectValue) => Promise<unknown>) => editor.add({ name: `sortie_v011_${name}`, description, input, options: { codemode: false },
          execute: async (args, execution) => ({ content: JSON.stringify(await execute(isRecord(args) ? args : {}, execution)) }) });
        add("start_work", "Operator: start the user's actual work immediately. If its command is already known, supply command to run it NOW via native shell before any child planning. Otherwise delegate via the returned native task. Retains original requests, same child and attempts. progress_evidence optionally records your inspection of fresh relevant observed results when correcting a stall.",
          objectSchema({ instructions: { type: "string", maxLength: 8000 }, command: { type: "string", minLength: 1, maxLength: 8000 },
            timeout_ms: { type: "integer", minimum: 100, maximum: 1200000 }, controller_state: { type: "string", minLength: 1, maxLength: 4000 },
             retry_command: { type: "string", minLength: 1, maxLength: 200, description: "Link a retry or corrected command to its confirmed-terminal previous execution ID. Never retry an ambiguous or live launch." },
            stop_command: { type: "string", minLength: 1, maxLength: 8000 },
            progress_evidence: { type: "array", items: stringSchema, maxItems: 8 } }), async (args, execution) => {
            const id = String(execution.sessionID); await requireRoot(id);
            await stopping.get(id);
            await reconcile(id);
            const prior = await loop.current(id);
            if (prior && ["completed", "cancelled"].includes(prior.phase)) await retainUsage(prior, await costs(prior));
            const work = await loop.start(id, args.instructions ?? (args.command ? `Execute the known command: ${args.command}` : ""), args.progress_evidence ?? [], planningMs);
            if (args.controller_state) {
              if (!args.stop_command || (!args.command && !work.controller)) throw new Error("work-controller-launch-and-stop-commands-required");
              await loop.bindController(id, resolve(context.location.directory, args.controller_state), args.stop_command);
            }
            await execution.progress?.({ description: `🚀 出撃 · ${work.id}`, sortie_work: work.id });
            if (args.command) {
              const entry = await loop.beginCommand(id, String(execution.id), args.command, args.timeout_ms ?? 120000, args.retry_command);
              if (entry.launch) {
                const controller = new AbortController(), signal = execution.signal as AbortSignal | undefined;
                const abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true });
                if (signal?.aborted || lifetime.signal.aborted) controller.abort();
                const active = controllers.get(id) ?? new Set(); controllers.set(id, active); active.add(controller);
                await loop.activity(id, id, { id: entry.command.id, tool: "shell", detail: args.command, startedAt: Date.now() });
                 const permissionKey = `${id}/${execution.id}`, permissions: ObjectValue[] = []; launchPermissions.set(permissionKey, permissions);
                 let result = { exit: null as number | null, interrupted: false, output: "Native execution unavailable", rejected: false };
                try {
                  const shell = (await context.tool.list?.())?.find(tool => tool.id === "shell");
                  if (!shell) throw new Error("Native OpenCode shell tool is unavailable.");
                  const native = await shell.execute({ command: args.command, workdir: context.location.directory,
                    timeout: entry.command.timeout, background: false }, { ...execution, signal: controller.signal, progress: async (value: ObjectValue) => {
                      if (typeof value.shellID === "string") await loop.nativeCommand(id, entry.command.id, value.shellID);
                      await execution.progress?.(value);
                    } });
                  const output = isRecord(native.output) ? native.output : isRecord(native.metadata) ? native.metadata : {};
                   result = { exit: Number.isInteger(output?.exit) ? output.exit : null, interrupted: controller.signal.aborted || output?.timeout === true, output: text(native.content), rejected: false };
                 } catch (error) { result = { exit: null, interrupted: controller.signal.aborted, output: error instanceof Error ? error.message : String(error),
                   rejected: permissions.some(event => event.effect === "deny") || isRecord(error) && error._tag === "Tool.Error" &&
                      error.error?._tag === "Permission.BlockedError" && error.error.permission === "shell" }; }
                 finally {
                   if (launchPermissions.get(permissionKey) === permissions) launchPermissions.delete(permissionKey);
                  await loop.endCommand(id, entry.command.id, result);
                  await loop.activity(id, id, { id: entry.command.id, tool: "shell", detail: "", startedAt: 0 },
                    { status: result.interrupted ? "interrupted" : "completed", exit: result.exit });
                  active.delete(controller); signal?.removeEventListener("abort", abort);
                }
              }
            }
            if (args.controller_state) {
              await loop.controller(id, resolve(context.location.directory, args.controller_state));
              controllerRoots.add(id);
            }
            return { ...await packet((await loop.current(id))!), departure: `🚀 出撃 — ${work.id}` };
          });
        add("work_status", "Read original instructions, changed files, and all verification obligations, including unresolved failures. Supply check_ids to inspect their stored output before judging test coverage. It does not accept work.",
          objectSchema({ check_ids: { type: "array", items: stringSchema, maxItems: 8 } }), async (args, execution) => {
            const actor = String(execution.sessionID), id = await root(actor);
            const work = await reconcile(id); return work ? packet(work, actor, args.check_ids ?? []) : { phase: "idle" };
          });
        add("check", "Run required verification and retain its real result as an obligation until it passes on final source. Use shell for exploratory diagnostics. Repair setup/collection failures and rerun this check; compilation is not a replacement for behavior tests. No prewritten plan or manifest is required.",
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
              return await loop.check(id, actor, args.command, args.timeout_ms ?? 120000, controller.signal,
                async (directory, command, timeout, signal) => {
                  const nativeShell = (await context.tool.list?.())?.find(tool => tool.id === "shell");
                  if (!nativeShell) throw new Error("Native OpenCode shell tool is unavailable.");
                  // Invoke the actual V2 executor, including its shell permissions, external-directory checks,
                  // process ownership, cancellation and platform-selected shell. Never run a second hidden shell.
                  const native = await nativeShell.execute({ command, workdir: directory, timeout, background: false }, { ...execution, signal }).catch((error: unknown) => {
                    if (isRecord(error) && error._tag === "Tool.Error" && error.error?._tag === "Permission.BlockedError" && error.error.permission === "shell") {
                      throw new Error("native shell permission denied before launch. Use a permitted repository runner/command form; do not repeat the rejected form or bypass its policy. Required behavior remains unverified.");
                    }
                    throw error;
                  });
                  const output = isRecord(native.output) ? native.output : native.metadata;
                  if (!isRecord(output) || output.status === "running" || (!Number.isInteger(output.exit) && output.timeout !== true && !signal?.aborted)) throw new Error("Native validation did not return a foreground exit status.");
                  return { exit: Number.isInteger(output.exit) ? output.exit : null, timedOut: output.timeout === true, interrupted: signal?.aborted === true,
                    output: text(native.content).slice(-WORK_LIMITS.outputBytes) };
                });
            }
            finally { active.delete(controller); parent?.removeEventListener("abort", abort); if (!active.size) controllers.delete(id); }
          });
        add("review_work", "Operator only: inspect real source and check output against ALL user requirements. Accept only verified completion; revise ordinary defects through the SAME child, or report blocked for genuinely unavailable required verification. Every recorded check must pass on final source. If a command was corrected/combined, check_replacements links an obsolete receipt to a selected equivalent passing check and explains preserved coverage; it never waives unavailable tests or replaces behavior tests with syntax checks.",
          objectSchema({ decision: { type: "string", enum: ["accept", "revise", "blocked"] }, assessment: { type: "string", minLength: 1, maxLength: 8000 },
            checks: { type: "array", items: stringSchema, maxItems: WORK_LIMITS.checks },
            check_replacements: { type: "array", maxItems: WORK_LIMITS.checks, items: objectSchema({ check: stringSchema, replacement: stringSchema,
              reason: { type: "string", minLength: 1, maxLength: 2000 } }, ["check", "replacement", "reason"]) } }, ["decision", "assessment", "checks"]),
          async (args, execution) => {
            const id = String(execution.sessionID); await requireRoot(id); await reconcile(id);
            const work = await loop.review(id, args.decision, args.assessment, args.checks, args.check_replacements ?? [], planningMs);
            const usage = await costs(work).catch(() => undefined);
            if (usage && ["completed", "blocked"].includes(work.phase)) {
              await retainUsage(work, usage);
              work.usage = (await loop.current(id))!.usage;
            }
            const result = await packet(work);
            const panel = workReturnReport(work, result.changed_paths, usage, await loop.retained());
            const presentation = panel ? await loop.presentation(id, `${work.id}/${work.generation}/${work.phase}`, panel) : undefined;
            return { ...result, ...(presentation ? { return_report: presentation.report, return_report_id: presentation.id,
              return_report_instruction: "Append this host-authored return_report verbatim exactly once to the ordinary final response, outside any code fence. Do not recalculate or request another model call for presentation." } : {}), ...(work.phase === "completed" ? { receipt: { status: "succeeded", work_id: work.id,
              requests: work.requests.map(item => item.id), source_fingerprint: work.acceptedSource, check_ids: work.acceptedChecks,
              assessment: work.assessment, check_replacements: work.checkReplacements ?? [] }, cost: usage ?? { available: false } }
              : work.phase === "blocked" ? { receipt: { status: "blocked", work_id: work.id, assessment: work.assessment } } : {}) };
          });
        add("cancel_work", "Operator: explicitly stop this owned job and its child. Native interruption is awaited; files and existing evidence remain available.",
          objectSchema({}), async (_args, execution) => {
            const id = String(execution.sessionID); await requireRoot(id); await stop(id, true, execution);
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
          stoppedByUser.delete(id);
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
        if (id === owner) thinking.delete(id);
        if (session.agent === worker) {
          childTurns.delete(id);
          await loop.assertWorker(owner, id);
          if (event.tool === "subagent") throw new Error("work-worker-does-not-delegate");
          const input = isRecord(event.input) ? event.input : {};
          await loop.activity(owner, id, { id: String(event.id), tool: String(event.tool), startedAt: Date.now(),
            detail: String(input.command ?? input.path ?? input.pattern ?? event.tool).replace(/\s+/gu, " ").slice(0, 240) });
        } else {
          if (event.tool === "subagent" && isRecord(event.input)) {
            if (event.input.agent === worker) {
              await loop.activity(owner, id, { id: String(event.id), tool: "subagent", detail: "Native child dispatch", startedAt: Date.now() });
              await loop.admit(owner, String(event.id), event.input);
            }
            else if (!["dog-reviewer-v010", "dog-advisor-v010"].includes(event.input.agent)) throw new Error("work-operator-delegate-not-allowed");
          }
          if (event.tool !== "subagent") await loop.activity(owner, id, { id: String(event.id), tool: String(event.tool), detail: String(event.tool), startedAt: Date.now() });
        }
      });
      await context.tool.hook("execute.after", async event => {
        const id = String(event.sessionID), session = await info(id);
        if ([primary, worker].includes(session.agent) && event.tool !== "subagent") {
          const result = isRecord(event.result) ? event.result : {};
          const output = isRecord(result.output) ? result.output : result.metadata;
          await loop.activity(await root(id), id, { id: String(event.id), tool: String(event.tool), detail: "", startedAt: 0 },
            { status: output?.status === "running" ? "background-started" : String(event.status), exit: Number.isInteger(output?.exit) ? output.exit : null });
          return;
        }
        if (event.tool !== "subagent") return;
        if (session.agent !== primary || session.parentID) return;
        const result = isRecord(event.result) ? event.result : {};
        if (typeof result.metadata?.sessionID === "string") {
          const child = await info(result.metadata.sessionID);
          if (child.parentID === id && ["dog-reviewer-v010", "dog-advisor-v010"].includes(child.agent)) await loop.support(id, child.id, child.agent);
        }
        await loop.settled(id, String(event.id), event.status === "completed", text(result.content) || text(event.error));
      });
      const inject = async (event: ObjectValue) => {
        const session = await info(String(event.sessionID));
        if (![primary, worker].includes(session.agent)) return;
        if (event.model && (event.model.providerID !== "openai" || ![V011_ROUTES.operator.id, V011_ROUTES.worker.id, "gpt-6-luna"].includes(event.model.id))) {
          throw new Error("Sortie v0.11 requires SOL6 or Luna6. Set the selected session and auxiliary compaction/title agents to these models; reviewer/advisor settings are independent.");
        }
        const owner = await root(String(event.sessionID)), work = await loop.current(owner);
        if (session.agent === worker && event.kind !== "auxiliary" && work?.phase === "running" && work.callID && work.progress) {
          const reason = progressLimit(work.progress, Date.now(), planningMs, discoveryCalls);
          if (reason && await loop.stall(owner, work.callID, reason)) {
            // No provider request has been sent for this step. The native failed
            // return wakes the operator; it reconciles and continues the SAME child.
            childTurns.delete(String(event.sessionID));
            throw new Error(`work-pacing-yield-before-request: ${reason}`);
          }
          childTurns.set(String(event.sessionID), Date.now());
        }
        if (session.agent === primary && event.kind !== "auxiliary" && !stoppedByUser.has(owner)) {
          const progress = await loop.progress(owner);
          if (!thinking.has(owner)) thinking.set(owner, (!work || ["completed", "cancelled"].includes(work.phase)) && progress
            ? Math.max(progress.startedAt, progress.operatorNudgedAt ?? 0) : Date.now());
        }
        if (Array.isArray(event.messages)) event.messages = repairWorkToolHistory(event.messages).messages;
        if (([V011_ROUTES.worker.id, "gpt-6-luna"].includes(event.model?.id) || (!event.model && session.agent === worker)) && isRecord(event.options)) {
          // OpenAI documents priority as the backwards-compatible spelling of Fast mode.
          event.options.serviceTier = "priority";
        }
        if (Array.isArray(event.system) && work) event.system.push({ type: "text", text:
          `SORTIE v0.11 durable work ${work.id}; phase=${work.phase}. User intent survives compaction. ` +
          (session.agent === primary ? "Your role is the user's proxy: delegate routine work, compare results with every original instruction, and accept only with review_work. " : "You own all routine investigation, edits, testing and corrections. ") +
          "Use work_status after compaction for current evidence. Do not reconstruct a proposal or an execution manifest." });
        if (session.agent === worker && work?.progress && Array.isArray(event.system)) {
          event.system.push({ type: "text", text: `Execution pacing: ${work.progress.tools} cumulative parent/child calls; received ${Math.floor((Date.now() - work.startedAt) / 1000)}s ago. Unreviewed planning limit ${planningMs / 1000}s. ` +
            "Reuse supplied paths and documented commands. Run the relevant reproduction or existing controller early. For long work, use the native shell/controller and its existing ledger; do not repeatedly poll or invent a replacement runner. If blocked, return the exact blocker promptly." });
        }
        if (session.agent === worker && work && Array.isArray(event.system) && work.requests.length > (work.deliveredRequests ?? 0)) {
          event.system.push({ type: "text", text: "Additional original user instructions received during execution:\n" +
            work.requests.slice(work.deliveredRequests ?? 0).map(request => request.text).join("\n\n") });
        }
        if (session.agent === worker && isRecord(event.tools)) {
          delete event.tools.subagent;
          for (const name of Object.keys(event.tools)) if (name.startsWith("sortie_v011_") && !["sortie_v011_check", "sortie_v011_work_status", "sortie_v011_compact"].includes(name)) delete event.tools[name];
        }
      };
      await context.session.hook("context", inject);
      for (const hook of ["compaction", "title", "generate"] as const) await context.session.hook(hook, async event => {
        await inject(Object.assign(event, { kind: "auxiliary" }));
        if (hook === "compaction") {
          const session = await info(String(event.sessionID));
          if ([primary, worker].includes(session.agent)) {
            const work = await loop.current(await root(String(event.sessionID)));
            if (work) await costs(work);
          }
        }
      });
      const fastRequest = async (event: ObjectValue) => {
        // The native gpt-6-luna-fast catalog entry already overlays priority. Retain the
        // explicit tier only for older auxiliary-agent configurations selecting base Luna6.
        if (event.model?.providerID !== "openai" || event.model?.id !== "gpt-6-luna") return false;
        const session = await info(String(event.sessionID));
        return [primary, worker].includes(session.agent);
      };
      const auxiliary = new Map<string, Map<string, WorkAuxiliaryUsage>>();
      const auxiliaryResponses = new Map<string, WorkAuxiliaryUsage>();
      const auxiliaryRequests = new WeakMap<Request, WorkAuxiliaryUsage>();
      const boundAuxiliary = new Set<string>();
      const auxiliaryKey = (event: ObjectValue) => `${event.sessionID}/${event.kind}`;
      const unambiguousAuxiliary = (event: ObjectValue) => {
        const entries = [...(auxiliary.get(auxiliaryKey(event))?.values() ?? [])].filter(entry => !boundAuxiliary.has(entry.id));
        return entries.length === 1 ? entries[0] : undefined;
      };
      const beginAuxiliary = async (event: ObjectValue) => {
        if (!["title", "generate"].includes(event.kind)) return;
        const session = await info(String(event.sessionID));
        let owner: string;
        if (session.agent === primary && !session.parentID) owner = session.id;
        else if ([worker, "dog-reviewer-v010", "dog-advisor-v010"].includes(session.agent) && typeof session.parentID === "string") {
          const parent = await info(session.parentID);
          if (parent.agent !== primary || parent.parentID) return;
          owner = parent.id;
          if (session.agent !== worker) await loop.support(owner, session.id, session.agent);
        } else return;
        const value: WorkAuxiliaryUsage = { id: randomUUID(), root: owner, at: Date.now(), kind: event.kind,
          receipt: { session: session.id, model: `${event.model.providerID}/${event.model.id}`, tokens: null, usd: null, pending: true,
            ...(event.model.id === "gpt-6-luna-fast" || event.model.id === "gpt-6-luna" && [primary, worker].includes(session.agent) ? { requestedTier: "priority" } : {}) } };
        await loop.auxiliaryUsage(value);
        const key = auxiliaryKey(event), entries = auxiliary.get(key) ?? new Map<string, WorkAuxiliaryUsage>();
        entries.set(value.id, value); auxiliary.set(key, entries);
        return value;
      };
      const finishAuxiliary = async (event: ObjectValue, value: unknown, entry: WorkAuxiliaryUsage | undefined) => {
        if (!entry || !entry.receipt.pending) return;
        const receipt = auxiliaryResponseUsage(event.model, value, entry.receipt.requestedTier);
        if (!receipt) return;
        entry.receipt = { ...receipt, session: entry.receipt.session };
        await loop.auxiliaryUsage(entry);
        const key = auxiliaryKey(event), entries = auxiliary.get(key);
        entries?.delete(entry.id); if (!entries?.size) auxiliary.delete(key);
        boundAuxiliary.delete(entry.id);
        const works = (await loop.retained()).filter(work => work.root === entry.root && work.startedAt <= entry.at && entry.at < (work.usageUntil ?? Infinity));
        for (const work of works) await retainUsage(work, await costs(work));
      };
      await context.session.hook("http.request", async event => {
        const entry = event.request instanceof Request && event.request.method === "POST" ? await beginAuxiliary(event) : undefined;
        if (entry && event.request instanceof Request) auxiliaryRequests.set(event.request, entry);
        if (!await fastRequest(event) || !(event.request instanceof Request) || event.request.method !== "POST") return;
        const body = await event.request.clone().json();
        if (!isRecord(body) || body.model !== "gpt-6-luna") return;
        const headers = new Headers(event.request.headers); headers.delete("content-length");
        event.request = new Request(event.request, { headers, body: JSON.stringify({ ...body, service_tier: "priority" }) });
        if (entry && event.request instanceof Request) auxiliaryRequests.set(event.request, entry);
      });
      await context.session.hook("http.response", async event => {
        const entry = (event.request instanceof Request ? auxiliaryRequests.get(event.request) : undefined) ?? unambiguousAuxiliary(event);
        if (entry) boundAuxiliary.add(entry.id);
        if (entry && event.response instanceof Response) void observeAuxiliaryResponse(event.response.clone(), value => finishAuxiliary(event, value, entry))
          .catch(error => console.warn("[sortie-dogs-v011] auxiliary usage", error));
      });
      await context.session.hook("experimental.ws.send", async event => {
        if (typeof event.frame === "string" && JSON.parse(event.frame).type === "response.create") await beginAuxiliary(event);
        if (!await fastRequest(event) || typeof event.frame !== "string") return;
        const frame = JSON.parse(event.frame);
        if (frame.type !== "response.create") return;
        if (isRecord(frame.response)) frame.response.service_tier = "priority";
        else frame.service_tier = "priority";
        event.frame = JSON.stringify(frame);
      });
      await context.session.hook("experimental.ws.receive", async event => {
        if (typeof event.frame !== "string") return;
        const frame = JSON.parse(event.frame), key = typeof frame.response?.id === "string" ? `${event.sessionID}/${frame.response.id}` : undefined;
        if (frame.type === "response.created" && key) {
          const entry = unambiguousAuxiliary(event);
          if (entry) { auxiliaryResponses.set(key, entry); boundAuxiliary.add(entry.id); }
        }
        if (key && auxiliaryResponses.has(key)) {
          const entry = auxiliaryResponses.get(key)!; await finishAuxiliary(event, frame, entry);
          if (!entry.receipt.pending) auxiliaryResponses.delete(key);
        }
      });
      void (async () => {
        for await (const event of context.event.subscribe({ signal: lifetime.signal })) {
          // The plugin shell domain exposes hooks, not the HTTP client's get/output methods.
          // Retain native lifecycle receipts independently of the awaiting start_work call.
          if (event.type === "shell.created") {
            const native = isRecord(event.data) ? event.data.info : undefined;
            if (!isRecord(native) || typeof native.metadata?.sessionID !== "string" || typeof native.file !== "string" || native.cwd !== context.location.directory) continue;
            const owner = native.metadata.sessionID, work = await loop.current(owner);
            const command = work?.commands?.find(item => item.nativeID === native.id || item.status === "launching" && !item.nativeID && item.command === native.command);
            if (!command || command.command !== native.command) continue;
            nativeCommands.set(native.id, { root: owner, id: command.id, file: native.file });
            await loop.nativeCommand(owner, command.id, native.id, { status: native.status, exit: null, output: "", file: native.file });
            continue;
          }
          if (event.type === "shell.exited") {
            const native = isRecord(event.data) ? event.data : undefined;
            const command = native ? nativeCommands.get(native.id) : undefined;
            if (command) {
              const output = await (async () => {
                const file = await open(command.file, "r");
                try {
                  const size = (await file.stat()).size, buffer = Buffer.alloc(Math.min(size, WORK_LIMITS.outputBytes));
                  const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
                  return buffer.subarray(0, bytesRead).toString("utf8");
                } finally { await file.close(); }
              })().catch(() => "Native output unavailable; terminal status retained.");
              await loop.nativeCommand(command.root, command.id, native!.id, { status: native!.status,
                exit: Number.isInteger(native!.exit) ? native!.exit : null, output });
              nativeCommands.delete(native!.id);
            }
            continue;
          }
          const id = isRecord(event.data) ? event.data.sessionID : undefined;
          if (typeof id !== "string") continue;
          if (["session.execution.succeeded", "session.idle"].includes(String(event.type))) {
            thinking.delete(id);
            try {
              const session = await info(id);
              if (session.agent === primary && !session.parentID) {
                const work = await loop.current(id);
                if (work) await retainUsage(work, await costs(work));
              }
            } catch (error) { console.warn("[sortie-dogs-v011] final usage", error); }
            continue;
          }
          if (!["session.execution.interrupted", "session.execution.failed"].includes(String(event.type))) continue;
          if (internalStops.delete(id)) continue;
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
      return () => { lifetime.abort(); for (const timer of monitors) clearInterval(timer); monitors.clear();
        for (const active of controllers.values()) for (const controller of active) controller.abort(); };
    },
  };
}
