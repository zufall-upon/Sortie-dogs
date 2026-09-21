import { V010_RUNTIME_ASSET_VERSION } from "../asset-version.js";
import { OperatorContractError, OperatorRuntime } from "../core/operator-runtime.js";
import { DEFAULT_OPERATOR_PROPOSAL_BUDGET, OPERATOR_APPROVAL_CONTRACT, OPERATOR_PROPOSAL_BUDGET_CAPS,
  OperatorProposalBudgetError, OperatorProposalRuntime } from "../core/operator-proposal.js";
import { CANONICAL_AGENT_ROLES, canonicalAgent, profileAgent, profileTool, V010_RUNTIME_PROFILE,
  type CanonicalAgentRole, type RuntimeProfile } from "../core/runtime-profile.js";
import { SortieDogsPlugin as canonicalPlugin, type OpenCodeHooks, type OpenCodePlugin, type OpenCodePluginInput } from "./index.js";
import { taskChildSessionID } from "./task-result-repair.js";
import type { RuntimeBridge } from "./runtime-bridge.js";
import { relative, resolve, sep } from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { BUILT_IN_MODEL_CATALOG, type CatalogModel } from "./model-routing.js";
import { goalFingerprint } from "../core/goal-bound.js";
import { decoratePreviewHeadings } from "./receipt-presentation.js";
import { sanitizeTerminalReport, terminalRunOutcome } from "./run-metrics.js";
import { normalizeCommand } from "./gate.js";
import { normalizeRelativePath } from "../core/path.js";

const SERIAL_CAPABILITIES = new Set([
  "sortie_bind_write_gate", "sortie_release_write_gate", "sortie_check_contract",
  "sortie_compact_and_continue", "sortie_enable_backlog_drain", "sortie_reflection",
]);
const SERIAL_OPTIONAL_ARGUMENTS = new Map<string, ReadonlySet<string>>([
  ["sortie_check_contract", new Set(["task_prompt"])],
  ["sortie_reflection", new Set([
    "scope", "trigger", "cause", "prevention", "evidence", "evidenceRef", "id", "promotedRef", "confirmation",
  ])],
]);
const PREVIEW_WORKER_ROUTE = Object.freeze({ model: "openai/gpt-5.6-luna-fast", variant: "max" });
const PREVIEW_SCOUT_ROUTE = Object.freeze({ model: "openai/gpt-5.6-luna-fast", variant: "xhigh" });
/**
 * Contract authorship, not throughput. Qualification observed a cheaper operations model emit
 * structurally valid but under-scoped contracts: a write union narrower than the remediation the
 * review it also schedules demands, which strands an otherwise complete run on NEED_DECISION.
 */
const PREVIEW_OPERATIONS_ROUTE = Object.freeze({ model: "openai/gpt-5.6-terra", variant: "xhigh" });
const PREVIEW_PRIMARY_ROUTE = Object.freeze({ model: "openai/gpt-5.6-luna-fast", variant: "max" });
/** Review must be able to reject the worker's output, so it never shares the worker's model family. */
const PREVIEW_REVIEW_ROUTE = Object.freeze({ model: "openai/gpt-5.6-terra", variant: "xhigh" });
/** Every preview route the profile can bind a role to. Catalog declaration reads this one list. */
const PREVIEW_ROUTES: readonly { readonly model: string; readonly variant: string }[] = Object.freeze([
  PREVIEW_PRIMARY_ROUTE, PREVIEW_WORKER_ROUTE, PREVIEW_SCOUT_ROUTE, PREVIEW_OPERATIONS_ROUTE,
  PREVIEW_REVIEW_ROUTE,
]);

export function processRemediationReplacementPacket(code: string, packet: unknown, cancelTool: string, prepareTool: string) {
  return { status: "operator-process-remediation-replacement-required", code, packet,
    next_action: `Call ${cancelTool} with reason=plain, then call ${prepareTool} with the exact same ordered acceptance, ` +
      "the same unit and write scope, and the remaining cumulative budget. Do not call resume_operator again, " +
      "claim evidence, reset spend, or widen scope." };
}

/**
 * Declare every preview route in the catalog, adding the variant to a listed model and the whole model
 * when the built-in catalog never listed it. Augmenting only pre-existing entries silently drops a
 * route whose model is absent, and role resolution then denies every child bound to that route with
 * `unresolved-role` instead of reporting the undeclared model.
 */
export function previewModelCatalog(
  routes: readonly { readonly model: string; readonly variant: string }[] = PREVIEW_ROUTES,
  base: readonly CatalogModel[] = BUILT_IN_MODEL_CATALOG.global ?? [],
): readonly CatalogModel[] {
  const variantsOf = (model: string): string[] =>
    [...new Set(routes.filter(route => route.model === model).map(route => route.variant))];
  const listed = new Set(base.map(entry => entry.model));
  return [
    ...base.map(entry => {
      const variants = variantsOf(entry.model);
      return variants.length === 0
        ? entry
        : { ...entry, variants: [...new Set([...(entry.variants ?? []), ...variants])] };
    }),
    ...[...new Set(routes.map(route => route.model))]
      .filter(model => !listed.has(model))
      .map(model => ({ model, variants: variantsOf(model) })),
  ];
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const payload = (value: unknown): unknown => record(value) && "data" in value ? value.data : value;
const RUNTIME_PROFILE_SESSION_INACTIVE = "runtime-profile-session-inactive: non-profile agents retain native read, edit, patch, shell, and task tools; continue directly without Sortie profile tools";
const fallbackOptionalSchema = (schema: unknown): unknown => record(schema) && schema.type === "string" && typeof schema.optional !== "function"
  ? { ...schema, "x-sortie-optional": true }
  : schema;
const OPERATOR_INTENT_CONTRACT = 'intent_json must encode exactly this JSON object (proposal_budget optional; all other fields required, no aliases or extra keys): '
  + '{"schema_version":"0.1","original_request":{"text":"the complete original user request, verbatim","source_ref":"user:message-id"},'
  + '"requirements":[{"id":"R1","text":"an exact ordered requirement","kind":"requirement"}],'
  + '"authoritative_refs":["user:message-id"],"allow_read":["src","test/check.mjs"]}. '
  + 'original_request.text must be nonblank, may contain newlines, and is limited to 128 KiB UTF-8 and 131072 characters; source_ref is a nonblank single line. '
  + 'Copy original_request.text byte-for-byte: preserve whitespace and the presence or absence of a final newline; do not append one or copy Read line numbers/wrappers. '
  + 'requirements must contain 1..64 entries with unique id matching [A-Za-z0-9][A-Za-z0-9._-]{0,127}, nonblank single-line text, '
  + 'and kind exactly "requirement" | "negative" | "quality" on every entry. Preserve the original ordered requirements, negative constraints, and quality thresholds here; do not invent separate fields. '
  + 'authoritative_refs is an array of nonblank single-line reference strings. allow_read is a nonempty array of normalized, concrete repository-relative FILE or DIRECTORY prefixes. '
  + 'Each allow_read entry must name an existing exact path observed in authoritative evidence or prior discovery; do not invent a top-level basename from a nested path. '
  + 'Every allow_read entry must already equal normalizeRelativePath(entry): use forward slashes; omit empty or "." segments and trailing slashes; do not use an empty string, ".", any ".." segment/traversal, a Unix/UNC absolute path, or a drive-qualified path. '
  + 'Wildcards are not expanded and do not authorize repository-root reads. For broad root investigation, list the existing top-level files and directories explicitly, for example ["package.json","src","test"]. '
  + `When proposal_budget is omitted, the host materializes the deterministic default ${JSON.stringify(DEFAULT_OPERATOR_PROPOSAL_BUDGET)}. `
  + `When supplied, proposal_budget.max_reads is an integer 1..${OPERATOR_PROPOSAL_BUDGET_CAPS.max_reads}; proposal_budget.max_submissions is an integer 1..${OPERATOR_PROPOSAL_BUDGET_CAPS.max_submissions}; explicit smaller budgets are preserved. `
  + 'Use only authoritative_refs, allow_read, and proposal_budget with these spellings; no alternate field names.';
type Tool = NonNullable<OpenCodeHooks["tool"]>[string];

function forwardTerminalText(text: string): string {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/u);
  const first = lines.findIndex(line => line.trim().length > 0);
  if (first >= 0 && /^DONE(?=[ \t]*(?:[—-]|$))/u.test(lines[first]!)) lines[first] = `status: ${lines[first]}`;
  return lines.join(newline);
}

/** One transport namespace around the existing MkII engine; no second write gate or acceptance engine. */
export function createProfiledPlugin(profile: RuntimeProfile, assetVersion: string): OpenCodePlugin {
  return async (input, options) => {
    const operators = new OperatorRuntime(input.directory, profile);
    const proposals = new OperatorProposalRuntime(input.directory, profile);
    const selected = new Map<string, string>();
    const operatorParents = new Map<string, string>();
    const taskOwners = new Map<string, { root: string; actor: string; operator: boolean; proposal?: boolean }>();
    const operatorTurnLifecycle = new Map<string, "historical" | "cancelled">();
    const historicalTurnMessages = new Map<string, string>();
    const dispatchTransitions = new Map<string, Promise<unknown>>();
    async function serializeDispatchTransition<T>(root: string, operation: () => Promise<T>): Promise<T> {
      const current = (dispatchTransitions.get(root) ?? Promise.resolve()).catch(() => undefined).then(operation);
      dispatchTransitions.set(root, current);
      try { return await current; }
      finally { if (dispatchTransitions.get(root) === current) dispatchTransitions.delete(root); }
    }
    const retired = new Set<string>();
    const renderedParts = new Map<string, string>();
    const renderingMessages = new Set<string>();
    const reportFailures = new Set<string>();
    let explicitWorkerSelection: { model?: string; variant?: string } | undefined;
    let control: Parameters<NonNullable<RuntimeBridge["connected"]>>[0] | undefined;
    const nativeSession = input.client?.session as unknown as Record<string, unknown> | undefined;
    async function session(method: string, request: unknown): Promise<unknown> {
      const operation = nativeSession?.[method];
      if (typeof operation !== "function") return undefined;
      return await operation.call(nativeSession, request);
    }
    async function messages(id: string): Promise<readonly Record<string, unknown>[]> {
      const result = payload(await session("messages", { path: { id }, query: { directory: input.directory } }));
      return Array.isArray(result) ? result.filter(record) : [];
    }
    async function identity(id: string): Promise<{ role?: CanonicalAgentRole; parent?: string }> {
      const info = payload(await session("get", { path: { id }, query: { directory: input.directory } }));
      const parent = record(info) && typeof info.parentID === "string" ? info.parentID : undefined;
      let agent = selected.get(id);
      if (agent === undefined) {
        const history = await messages(id);
        for (const message of [...history].reverse()) {
          const metadata = record(message.info) ? message.info : message;
          if (metadata.role === "user" && typeof metadata.agent === "string") { agent = metadata.agent; break; }
        }
        agent ??= record(info) && typeof info.agent === "string" ? info.agent : undefined;
      }
      return { role: canonicalAgent(profile, agent), ...(parent === undefined ? {} : { parent }) };
    }
    async function rootFor(id: string, depth = 0): Promise<string | undefined> {
      if (depth > 3 || retired.has(id)) return undefined;
      const who = await identity(id);
      if (who.role === "dog-coordinator" && who.parent === undefined) return id;
      if (!who.role || !who.parent) return undefined;
      const parentRoot = await rootFor(who.parent, depth + 1);
      if (!parentRoot) return undefined;
      if (who.role === "dog-worker" || who.role === "dog-luna-worker") {
        const state = await operators.read(parentRoot);
        if (state?.units.some(unit => unit.childSessionID === id) && ["cancelled", "completed"].includes(state.phase)) return undefined;
      }
      if (who.role === "dog-operator") {
        const proposal = await proposals.read(parentRoot);
        if (proposal && proposal.phase === "investigating") {
          if (proposal.proposal_session_id !== id) return undefined;
          operatorParents.set(id, parentRoot);
          return parentRoot;
        }
        const state = await operators.read(parentRoot);
        if (!state || state.phase === "cancelled" || state.phase === "completed") return undefined;
        if (state.operatorSessionID !== id) {
          const history = await messages(id);
          const first = history.find(message => (record(message.info) ? message.info.role : message.role) === "user");
          const prompt = Array.isArray(first?.parts) ? first.parts.filter(record)
            .filter(part => part.type === "text" && typeof part.text === "string").map(part => part.text).join("\n") : "";
          await operators.bindOperator(parentRoot, id, prompt);
        }
        operatorParents.set(id, parentRoot);
      }
      return parentRoot;
    }
    /**
     * Resolve the owning root of a proposal investigation child for prompt assembly only.
     *
      * `rootFor` stops resolving this child as soon as the proposal leaves `investigating`, which is the
     * correct authorization answer: the child must not run another tool. It is the wrong answer for the
     * system prefix, because losing the root also drops every profile element and changes the absolute
     * prompt prefix, so the child's post-submit turn re-sent its whole investigation uncached. This
     * resolver grants no tool authority and is never consulted on an execute path.
     */
    async function proposalPromptRoot(id: string): Promise<string | undefined> {
      if (retired.has(id)) return undefined;
      const who = await identity(id);
      if (who.role !== "dog-operator" || !who.parent) return undefined;
      const parentRoot = await rootFor(who.parent, 1);
      if (!parentRoot) return undefined;
      const proposal = await proposals.read(parentRoot);
      return proposal?.phase === "submitted" && proposal.proposal_session_id === id ? parentRoot : undefined;
    }
    function mapAgent(value: string, outward: boolean): string {
      if (outward) {
        if (value.startsWith("foreign/")) return value.slice("foreign/".length);
        return CANONICAL_AGENT_ROLES.includes(value as CanonicalAgentRole) ? profileAgent(profile, value as CanonicalAgentRole) : value;
      }
      const role = canonicalAgent(profile, value);
      if (role) return role;
      return CANONICAL_AGENT_ROLES.includes(value as CanonicalAgentRole) ? `foreign/${value}` : value;
    }
    function translate(value: unknown, outward: boolean): unknown {
      if (Array.isArray(value)) return value.map(item => translate(item, outward));
      if (!record(value)) return value;
      return Object.fromEntries(Object.entries(value).map(([key, item]) => {
        if ((key === "agent" || key === "subagent_type") && typeof item === "string") return [key, mapAgent(item, outward)];
        if (!outward && (key === "parentID" || key === "parentId") && typeof item === "string") {
          return [key, operatorParents.get(item) ?? item];
        }
        if (key === "tool" && typeof item === "string") {
          if (!outward && item.startsWith(profile.toolPrefix)) return [key, `sortie_${item.slice(profile.toolPrefix.length)}`];
          if (outward && SERIAL_CAPABILITIES.has(item)) return [key, profileTool(profile, item)];
        }
        return [key, translate(item, outward)];
      }));
    }
    const client = input.client === undefined ? undefined : new Proxy(input.client, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key !== "session" || !record(value)) return value;
        return new Proxy(value, {
          get(group, method) {
            const operation = Reflect.get(group, method, group);
            if (typeof operation !== "function") return operation;
            return async (...args: unknown[]) => {
              const request = args[0];
              if ((method === "prompt" || method === "promptAsync") && record(request) && record(request.path) &&
                  typeof request.path.id === "string" && retired.has(request.path.id)) throw new Error("runtime-profile-revoked");
              return translate(await operation.apply(group, args.map(argument => translate(argument, true))), false);
            };
          },
        });
      },
    });
    const runtimeBridge: RuntimeBridge = {
      profile, assetVersion,
      continuationCheckpoint: root => operators.continuationCheckpoint(root),
      ownsCanonicalValidation: async (root, taskID, child, command) => {
        const state = await operators.read(root);
        if (state === undefined || state.phase === "cancelled" || state.phase === "completed") return false;
        const unit = state.units.find(candidate => /^task_id: (.+)$/m.exec(candidate.task.prompt)?.[1] === taskID);
        const active = unit?.status === "running" || (unit?.status === "failed" && unit.repairValidation !== null);
        return active && unit.childSessionID === child &&
          unit.unit.validation.some(candidate => normalizeCommand(candidate) === command);
      },
      defaultModelCatalog: { global: previewModelCatalog() },
      transformConfiguration: value => {
        if (!record(value) || !record(value.modelRouting)) return value;
        const routes: Record<string, unknown> = {};
        for (const [external, route] of Object.entries(value.modelRouting)) {
          const canonical = canonicalAgent(profile, external) ?? external;
          if (Object.hasOwn(routes, canonical)) throw new Error(`preview-model-route-collision: ${external} -> ${canonical}`);
          routes[canonical] = route;
        }
        return { ...value, modelRouting: routes };
      },
      defaultModelRouting: {
        "dog-coordinator": { preferred: PREVIEW_PRIMARY_ROUTE },
        "dog-operator": { preferred: PREVIEW_OPERATIONS_ROUTE },
        "dog-reviewer": { preferred: PREVIEW_REVIEW_ROUTE },
        "dog-scout": { preferred: PREVIEW_SCOUT_ROUTE },
        "dog-worker": { preferred: PREVIEW_WORKER_ROUTE },
      },
      connected: value => { control = value; },
      onSerialSettlement: result => operators.settled(result),
      onRootTerminal: (root, receipt) => operators.terminal(root, receipt),
    };
    const core = await canonicalPlugin({ ...input, worktree: input.directory, client, runtimeBridge }, {
      operationManifestPath: `${profile.stateDirectory}/contracts/operation-manifest.json`,
      handoffPaths: [`${profile.stateDirectory}/contracts/handoff.json`],
      ...options,
    });
    const tools: Record<string, Tool> = {};
    async function requireRoot(id: string): Promise<void> {
      const root = await rootFor(id);
      if (!root) throw new Error(RUNTIME_PROFILE_SESSION_INACTIVE);
      if (root !== id || !await control?.isRoot(id)) throw new Error("profile-coordinator-root-required");
    }
    async function restorePriorAcceptance(root: string, state: import("../core/operator-runtime.js").OperatorState): Promise<void> {
      const succeeded = [...state.units].reverse().find(unit => unit.status === "succeeded");
      const current = succeeded === undefined ? undefined : {
        taskID: /^task_id: (.+)$/m.exec(succeeded.task.prompt)?.[1], handoffPath: succeeded.handoffPath, handoffHash: succeeded.hashes[0]!,
      };
      const prior = current?.taskID ? { ...current, taskID: current.taskID } : state.priorAcceptedUnits.at(-1);
      if (prior) {
        await control!.restoreAcceptedUnit(root, prior);
        return;
      }
      if (state.remediationParent !== null) {
        await control!.restoreAcceptanceRemediationBaseline(root, { failedTaskID: state.remediationParent.taskID,
          criteria: state.acceptance, fingerprint: state.acceptanceFingerprint,
          currentTaskIDs: state.units.flatMap(unit => /^task_id: (.+)$/m.exec(unit.task.prompt)?.[1] ?? []) });
        return;
      }
      if (state.parentRunID === null) return;
      // Compatibility recovery for a replacement run prepared by an older runtime: the
      // replacement's controls are hash-pinned, while the same-root goal ledger proves the
      // accepted predecessor. No historical contract directory is searched.
      await operators.verifyContinuityControls(state);
      const currentTaskIDs = state.units.map(unit => /^task_id: (.+)$/m.exec(unit.task.prompt)?.[1]);
      if (currentTaskIDs.some(id => !id)) throw new Error("operator-continuity-task-id-missing");
      await control!.restoreAcceptanceLineage(root, { criteria: state.acceptance,
        fingerprint: state.acceptanceFingerprint, currentTaskIDs: currentTaskIDs as string[] });
    }
    async function registerPreparedGoal(root: string, state: import("../core/operator-runtime.js").OperatorState): Promise<void> {
      await restorePriorAcceptance(root, state);
      await control!.registerGoalDeclaration(root, state.units[0]!.task.prompt);
    }
    async function relinkRegisteredGoal(root: string, state: import("../core/operator-runtime.js").OperatorState,
      expectedFingerprint: string): Promise<void> {
      await operators.verifyContinuityControls(state);
      await control!.relinkRegisteredGoal(root, { prompt: state.units[0]!.task.prompt,
        expectedFingerprint, registeredAt: state.createdAt });
    }
    for (const [name, definition] of Object.entries(core.tool ?? {})) {
      if (!SERIAL_CAPABILITIES.has(name)) continue;
      const optionalArguments = SERIAL_OPTIONAL_ARGUMENTS.get(name);
      const args = optionalArguments === undefined ? definition.args : Object.fromEntries(
        Object.entries(definition.args).map(([argument, schema]) => [
          argument, optionalArguments.has(argument) ? fallbackOptionalSchema(schema) : schema,
        ]),
      );
      tools[profileTool(profile, name)] = { ...definition, args,
        execute: async (args, context) => {
          const root = await rootFor(context.sessionID);
          if (!root) throw new Error(RUNTIME_PROFILE_SESSION_INACTIVE);
          if ((await identity(context.sessionID)).role === "dog-operator") throw new Error("operator-capability-denied");
          return definition.execute(args, { ...context, ...(context.agent === undefined ? {} : { agent: mapAgent(context.agent, false) }) });
        },
      };
    }
    const stringSchema = core.tool!.sortie_bind_write_gate!.args.project_root;
    const intentSchema = record(stringSchema) && typeof stringSchema.describe === "function"
      ? stringSchema.describe(OPERATOR_INTENT_CONTRACT)
      : { ...(record(stringSchema) ? stringSchema : { type: "string" }), description: OPERATOR_INTENT_CONTRACT };
    const proposalContract = "proposal_json must encode one JSON object with exactly these required fields and types: " +
      'schema_version string "0.1"; revision positive integer, for example "revision":1, never string "revision":"1"; ' +
      "coverage array of {requirement_id:string,approach:string,validation:string}; " +
      "existing_surface array of {requirement_id:string,path:string,form:string}, with at least one observed form per covered requirement and each path actually Read by this child; " +
      "uncovered array of {requirement_id:string,reason:string}; " +
      "negative_handling array of {requirement_id:string,handling:string}, containing only and all IDs whose intent kind is negative; " +
      "read_scope string array; write_scope string array; all scope and existing_surface paths must be normalized repository-relative paths with forward slashes, no trailing slash, dot segments, traversal, or absolute paths; " +
      "budget_estimate object with proposal_reads:integer and execution_units:integer; plan object with schema_version:string, " +
      "acceptance_proof:string[][], source_refs:string[], goal_declaration:object, units:object[], and optional git_lifecycle with exact shape " +
      "Each unit.validation is the complete ordered execution list, not a tests-only list: commands required by observed authoritative Makefiles, language generator directives, or repository scripts for generation, build, formatting, and exact cleanup precede post-commit or canonical criterion tests. Put every required input in unit.read and every persistent or transient generated output in unit.write. Cleanup may remove only declared unit.write outputs; never approve arbitrary ignore rules or removal of undeclared paths. Do not guess a tool-specific command or output, claim an unobserved capability, or add a preparatory or cleanup command as a goal criterion unless it independently proves acceptance. The host preserves declared order and authority but does not statically discover or inject every build dependency or generator output. " +
      '{branch_create:{branch:string,start_ref:string},commit:{message:string},post_commit_validation:string[],remediation_reserve?:string[]}. By the existing canonical command identity, post_commit_validation must match declared goal validations and be the same-order contiguous suffix of final unit.validation, exclusive to that unit. git_lifecycle authorizes only host fixed-argv branch creation before worker spend and one explicit-path commit of the approved unit.write union immediately before that suffix; fresh existing-executor evidence remains required. It never authorizes arbitrary Git, overwrite, force, amend, push, add -A, or commit -a. No aliases or extra packet keys. ' +
      "remediation_reserve is optional and declares normalized repository-relative paths no unit may write during implementation, pre-approved only for a later same-goal remediation replacement. Every entry must lie outside the unit.write union; a redundant entry is rejected. Declare the paths a review finding would most plausibly have to correct beyond the implementation surface, such as the source a changed test exercises, so a complete candidate is not stranded on a user decision by one unlisted file. Do not use it to smuggle implementation scope: units still cannot write there. " +
      "The host strictly rejects invalid types without coercion and returns a bounded field diagnostic with canonical budget counters.";
    const proposalSchema = record(stringSchema) && typeof stringSchema.describe === "function"
      ? stringSchema.describe(proposalContract)
      : { ...(record(stringSchema) ? stringSchema : { type: "string" }), description: proposalContract };
    const approvalSchema = record(stringSchema) && typeof stringSchema.describe === "function"
      ? stringSchema.describe(OPERATOR_APPROVAL_CONTRACT)
      : { ...(record(stringSchema) ? stringSchema : { type: "string" }), description: OPERATOR_APPROVAL_CONTRACT };
    const planContract = "plan_json must encode the exact operator plan object: schema_version, acceptance, acceptance_proof, source_refs, " +
      "goal_declaration, units, and optional git_lifecycle only. git_lifecycle exact shape is " +
      '{branch_create:{branch:string,start_ref:string},commit:{message:string},post_commit_validation:string[],remediation_reserve?:string[],remediation_scope_expansion?:string[]}. Its presence is root authorization for only a clean, non-overwriting ' +
      "fixed-argv branch create before dispatch and one explicit-path commit of the host-declared union of all unit.write paths immediately before the final unit's canonical same-order contiguous post-commit validation suffix. " +
      "Missing start refs, existing destinations, dirty roots, invalid refs, and extra lifecycle fields return typed diagnostics before worker spend. " +
      "remediation_reserve declares paths no unit may write during implementation, pre-approved only for a later same-goal remediation replacement; entries must lie outside the unit.write union. " +
      "remediation_scope_expansion is valid only on a remediation replacement and must name exactly the paths this host already refused and reported as replacement_constraints.blocked_write_paths. Send it only after returning those paths to the user and receiving explicit approval on a later real user turn carrying host approval authority; same-turn replay is rejected, and any path the host did not record is rejected, so it can never invent scope. " +
      "Omission preserves the existing no-Git-lifecycle behavior. Each unit.validation is an ordered execution list, not tests only: include observed required generator/build/format commands and exact cleanup after generation but before post-commit or canonical criterion tests, with required inputs in unit.read and every persistent or transient generated output in unit.write. Cleanup may remove only declared unit.write outputs; arbitrary ignore rules and removal of undeclared paths are forbidden. Missing commands, outputs, or cleanup require contract repair, not resume evidence. The root must review this semantic completeness; the host does not infer or inject missing build dependencies or generator outputs.";
    const planSchema = record(stringSchema) && typeof stringSchema.describe === "function"
      ? stringSchema.describe(planContract)
      : { ...(record(stringSchema) ? stringSchema : { type: "string" }), description: planContract };
    const optionalStringSchema = record(stringSchema) && typeof stringSchema.optional === "function"
      ? (stringSchema.optional as () => unknown).call(stringSchema)
      : fallbackOptionalSchema(stringSchema);
    const prepare = profileTool(profile, "sortie_prepare_operator");
    const repair = profileTool(profile, "sortie_repair_operator_plan");
    const next = profileTool(profile, "sortie_operator_next");
    const status = profileTool(profile, "sortie_operator_status");
    const cancel = profileTool(profile, "sortie_cancel_operator");
    const complete = profileTool(profile, "sortie_complete_operator");
    const resume = profileTool(profile, "sortie_resume_operator");
    const resolveContractRepair = profileTool(profile, "sortie_resolve_operator_contract_repair");
    const beginProposal = profileTool(profile, "sortie_begin_operator_proposal");
    const submitProposal = profileTool(profile, "sortie_submit_operator_proposal");
    const approveProposal = profileTool(profile, "sortie_approve_operator_proposal");
    async function stop(root: string, reason: string, retireRoot = true): Promise<void> {
      if (retireRoot) retired.add(root);
      if (retireRoot) await control?.stopAutomaticRecovery(root);
      const proposal = await proposals.read(root);
      if (proposal?.phase === "investigating" && proposal.proposal_call_id !== null) {
        // The admitted proposal Task already settles this reservation when its child returns. A terminal
        // settlement is final, so an explicit cancellation must release the grant instead of failing on it.
        try { await control?.settleProposalBudget(root, proposal.intent_id, proposal.proposal_call_id, "cancelled"); }
        catch (error) {
          if (!(error instanceof Error) || error.message !== "operator-proposal-budget-settlement-conflict") throw error;
        }
      }
      const children = await operators.interrupted(root, reason);
      for (const child of children) {
        retired.add(child);
        const result = await session("abort", { path: { id: child }, query: { directory: input.directory } });
        if (result === undefined || result === false || (record(result) && result.data === false)) throw new Error("operator-child-stop-unconfirmed");
      }
      await control?.cancelChildren(root);
      if (retireRoot) await control?.stopRoot(root);
    }
    function preparedTask(state: import("../core/operator-runtime.js").OperatorState): string {
      if (state.phase !== "prepared" || state.dispatched > 0) return JSON.stringify(operators.packet(state));
      control!.enableUnits(state.rootSessionID, state.units.length);
      return JSON.stringify({ profile: profile.id, run_id: state.runID, acceptance_fingerprint: state.acceptanceFingerprint,
        fast_path: state.units.length === 1, task: state.units.length === 1 ? operators.nextWorkerTask(state) : operators.dispatchTask(state) });
    }
    tools[prepare] = { description: `Freeze an approved serial operator plan. Invalid plans return bounded diagnostics and a draft_id for field-only repair; no worker is started. After operator-acceptance-remediation-required, cancel first and prepare only the same exact acceptance, a write scope within the prior approved union, and a Git lifecycle starting at the failed committed head; consumed goal budget is retained. Coordinator only. ${planContract}`,
      args: { plan_json: planSchema }, execute: async (args, context) => {
        await requireRoot(context.sessionID);
        let state;
        try {
          let plan: unknown;
          try { plan = JSON.parse(args.plan_json); }
          catch { return JSON.stringify({ status: "invalid-plan", diagnostics: [{ document: "plan", pointer: "/", code: "operator-plan-json-invalid", rule: "json", repair_kind: "repair-field" }] }); }
          const scopeApprovalTurnID = await control?.remediationScopeExpansionAuthority(context.sessionID);
          const proposal = await operators.propose(context.sessionID, plan, scopeApprovalTurnID);
          if (proposal.status === "invalid-plan") return JSON.stringify(proposal);
          state = proposal.state;
        } catch (error) {
          if (error instanceof OperatorContractError) return JSON.stringify({ status: "invalid-plan", diagnostics: error.diagnostics, diagnostics_truncated: error.diagnostics_truncated });
          // An immutable active contract is a local routing defect, not an external blocker. Return the
          // existing durable state and its next action so the root continues instead of retrying prepare.
          if (error instanceof Error && error.message === "operator-active-contract-immutable") {
            return JSON.stringify({ status: "active-contract-immutable", code: error.message,
              packet: await operatorPacket(await operators.required(context.sessionID)),
              next_action: `This root already owns an immutable active contract. Do not resend a plan or cancel an unchanged contract: ` +
                `read ${status} and continue the existing run's next_task_ref or next_action. Cancel only for an actual scope change or explicit stop.` });
          }
          throw error;
        }
        await registerPreparedGoal(context.sessionID, state);
        return preparedTask(state);
      } };
    tools[repair] = { description: "Repair a root-owned draft with named fields, git_lifecycle branch/start/message fields, or an already-declared criterion command. Empty patches revalidate the saved draft without resending it. Acceptance, unit count and write scope remain fixed.",
      args: { draft_id: stringSchema, patches_json: stringSchema }, execute: async (args, context) => {
        await requireRoot(context.sessionID);
        let patches: unknown;
        try { patches = JSON.parse(args.patches_json); } catch { throw new Error("operator-repair-json-invalid"); }
        const proposal = await operators.repair(context.sessionID, args.draft_id, patches);
        if (proposal.status !== "prepared") return JSON.stringify(proposal);
        await registerPreparedGoal(context.sessionID, proposal.state);
        return preparedTask(proposal.state);
      } };
    tools[next] = { description: "Return the next exact admitted worker Task or a bounded decision packet. Dispatch the returned short reference unchanged; canonical worker instructions stay host-internal. No acceptance or scope edits.",
      args: {}, execute: async (_args, context) => {
        const root = await rootFor(context.sessionID);
        if (!root) throw new Error("operator-grant-invalid");
        const result = await operators.next(root, context.sessionID);
        if (context.sessionID === root && record(result) && record(result.task)) {
          const state = await operators.required(root);
          if (state.units.length > 1) control!.enableUnits(root, state.units.filter(unit => unit.status === "pending").length);
        }
        return JSON.stringify(result);
      } };
    async function operatorPacket(state: import("../core/operator-runtime.js").OperatorState) {
      const packet = operators.packet(state) as Record<string, unknown>;
      const budget = await control!.currentBudget(state.rootSessionID);
      if (state.decision === "operator-acceptance-remediation-required" && typeof packet.next_action === "string") {
        const counters = budget === null ? "Host unit budget unavailable; do not infer remaining capacity from the plan."
          : `Host unit budget: max_units=${budget.max_units}, consumed_units=${budget.consumed_units}, reserved_units=${budget.reserved_units}, remaining_units=${budget.remaining_units}.`;
        const action = budget === null ? "Read operator_status again before deciding budget availability."
          : budget.remaining_units === 0
            ? "No unreserved implementation units remain. Do not dispatch a replacement; resolve outstanding reservations or request an explicit cumulative budget revision."
            : `Use these host counters, not the model-authored goal_budget_units estimate. Continue the same-goal remediation in this turn within unchanged acceptance and approved scope; normal time, cost, validation and dispatch gates still apply. ${packet.next_action}`;
        packet.next_action = `${counters} ${action}`;
      }
      return { ...packet, budget };
    }
    /**
     * Proposal accounting without the submitted packet body.
     *
     * The full proposal carries the plan, every unit, and the acceptance text a further time. Once the
     * root has compared it, approval froze it into the execution run, whose own packet already reports
     * acceptance, units, and scopes. Re-emitting it on approval and on every later status call appended
     * a redundant copy to the one session that re-reads its whole context on every turn. `content_hash`
     * stays, so the exact submitted revision is still identifiable.
     */
    function proposalIdentity(state: import("../core/operator-proposal.js").OperatorProposalState) {
      const { proposal: _packet, ...identity } = proposals.packet(state) as Record<string, unknown>;
      return identity;
    }
    tools[status] = { description: "Read the durable root-owned operator outcome and host budget counters (max_units, consumed_units, reserved_units, remaining_units) without claiming acceptance or retrying work. An investigating proposal returns its exact short Task reference only before a Task has been admitted; an existing admission never yields a redispatch Task.",
      args: {}, execute: async (_args, context) => {
        await requireRoot(context.sessionID);
        const state = await operators.read(context.sessionID);
        const draft = await operators.draftStatus(context.sessionID);
        const proposal = await proposals.read(context.sessionID);
        const proposalNextAction = proposal?.phase === "investigating"
          ? proposal.proposal_call_id !== null
            ? "proposal Task is already admitted; do not redispatch it or call operator_next. Continue submission repairs only in the same active claimed child. If that child terminated without submission, report the terminal proposal failure; remaining read or submission capacity does not authorize a new Task, budget reset, or replacement child. Only an explicit root decision to retry may call cancel_operator with reason=plain to release this grant, which discards the spent proposal accounting and never reuses the terminated child"
            : proposal.submission_count >= proposal.intent.proposal_budget.max_submissions
            ? "proposal submission budget exhausted; do not call operator_next; report the bounded proposal failure"
            : "proposal is not submitted; do not call operator_next; complete or repair the bounded proposal submission"
          : proposal?.phase === "submitted"
            ? "compare and approve the exact proposal; do not call operator_next before approval prepares a run"
            : "approved proposal has no operator run; do not call operator_next; reconcile the approval or preparation failure";
        return JSON.stringify(state ? { ...await operatorPacket(state), ...(draft ? { pending_draft: draft } : {}),
          ...(proposal ? { proposal: proposalIdentity(proposal) } : {}) }
          : draft ? { ...draft as object, ...(proposal ? { proposal: proposals.packet(proposal) } : {}) }
            : proposal ? { profile: profile.id, proposal: proposals.packet(proposal),
              ...(proposal.phase === "investigating" && proposal.proposal_call_id === null ? { task: proposals.referenceTask(proposal),
                dispatch_instruction: "Pass this short Task reference verbatim; the host expands it only inside the directly claimed proposal child." } : {}),
              next_action: proposalNextAction }
              : { status: "absent", profile: profile.id });
      } };
    tools[cancel] = { description: "Revoke this root's operator grant and stop only its owned children before releasing core state. Before approval it instead releases the bounded proposal grant, including one whose admitted child already terminated, so the root can begin a new investigation; it never reuses that child or restores spent proposal budget. reason is a required closed set: use reason=plain for a plain cancellation, including replanning, contract revision, and any pre-approval proposal release, and never send free text such as a written justification. Use reason=acceptance-remediation only for decision=operator-acceptance-remediation-required. At awaiting-acceptance, reason=review-blocking authorizes a same-goal review-remediation replacement only within the exact acceptance, committed head, approved write union, and retained remaining budget.",
      args: { reason: { type: "string", enum: ["plain", "review-blocking", "acceptance-remediation"] } as never }, execute: async (args, context) => {
        await requireRoot(context.sessionID);
        const rawReason = (args as { reason?: unknown }).reason;
        const requestedReason = rawReason === "plain" || rawReason === undefined ? undefined : rawReason;
        if (requestedReason !== undefined && requestedReason !== "review-blocking" && requestedReason !== "acceptance-remediation") throw new Error("operator-cancel-reason-invalid");
        const pending = await operators.read(context.sessionID);
        if (!pending) {
          // A pre-approval proposal owns no execution lane. Its admitted child can never be rebound, so without
          // this release the root can neither resume, redispatch, nor start any replacement investigation.
          const proposal = await proposals.read(context.sessionID);
          if (!proposal || proposal.phase === "approved") throw new Error("operator-run-missing");
          if (requestedReason !== undefined) throw new Error("operator-cancel-reason-invalid");
          await stop(context.sessionID, "explicit-cancellation", false);
          const discarded = await proposals.discardPreApproval(context.sessionID);
          operatorTurnLifecycle.set(context.sessionID, "cancelled");
          return JSON.stringify({ profile: profile.id, status: "cancelled", scope: "proposal",
            released_proposal: discarded ? proposals.packet(discarded) : null,
            next_action: "the bounded proposal grant is released and its spent reads/submissions are not restored; " +
              "begin a new proposal investigation only on an explicit root decision to retry, and never reuse the cancelled child" });
        }
        const current = pending;
        if (requestedReason === "acceptance-remediation" && current.decision !== "operator-acceptance-remediation-required") throw new Error("operator-cancel-reason-invalid");
        if (requestedReason === "review-blocking" && current.phase !== "awaiting-acceptance") throw new Error("operator-cancel-reason-invalid");
        await stop(context.sessionID, requestedReason === "review-blocking"
          ? "operator-review-remediation-required"
          : requestedReason === "acceptance-remediation"
            ? "operator-acceptance-remediation-required"
            : "explicit-cancellation", false);
        operatorTurnLifecycle.set(context.sessionID, "cancelled");
        return JSON.stringify(await operatorPacket(await operators.required(context.sessionID)));
      } };
    const pathsSchema = record(stringSchema) && typeof stringSchema.array === "function"
      ? (stringSchema.array as () => unknown).call(stringSchema)
      : { type: "array", items: { type: "string" } };
    tools[resolveContractRepair] = {
      description: "Root-only v0.10 active contract repair. The only decision is discard-transient: delete the exact diagnosed safe untracked files after every durable identity, Git, path, caller, generation, and validation-budget gate passes, then return one validation-only same-worker continuation for the frozen unit. It never broadens write scope, reruns generators, executes validation itself, or permits a second repair.",
      args: { run_id: stringSchema, unit_id: stringSchema, repair_fingerprint: stringSchema,
        decision: stringSchema, paths: pathsSchema as never },
      execute: async (args, context) => {
        await requireRoot(context.sessionID);
        const paths = (args as Record<string, unknown>).paths;
        if (!Array.isArray(paths) || !paths.every(path => typeof path === "string")) throw new Error("operator-contract-repair-paths-invalid");
        const before = await operators.required(context.sessionID);
        const unit = before.units.find(item => item.unit.id === args.unit_id);
        const taskID = unit === undefined ? undefined : /^task_id: (.+)$/m.exec(unit.task.prompt)?.[1];
        if (!unit || !taskID || unit.childSessionID === null) throw new Error("operator-contract-repair-unit-missing");
        const assertBudget = () => control!.assertOperatorContractRepairValidationAvailable(context.sessionID, taskID, unit.childSessionID!);
        let applied = await operators.applyContractRepair(context.sessionID, { run_id: args.run_id, unit_id: args.unit_id,
          repair_fingerprint: args.repair_fingerprint, decision: args.decision, paths: paths as string[] }, assertBudget);
        try {
          await control!.authorizeOperatorContractRepairValidation(context.sessionID, taskID, unit.childSessionID, args.repair_fingerprint);
        } catch (error) {
          // The repair is aborted and the run keeps a durable decision. Return that preserved state so an
          // unauthorized resume cannot leave the root without a recognizable terminal or next action.
          applied = await operators.abortAppliedContractRepair(context.sessionID, "operator-contract-repair-validation-resume-unavailable");
          return JSON.stringify({ status: "contract-repair-validation-unavailable",
            code: error instanceof Error ? error.message : "operator-contract-repair-validation-resume-unavailable",
            packet: await operatorPacket(applied),
            next_action: `The validation-only resume was not authorized and this repair is closed. Do not retry ${resolveContractRepair} or ` +
              `${resume} for the same fingerprint: read ${status}, then either continue the reported decision or return one terminal checkpoint naming this refusal.` });
        }
        return JSON.stringify({ status: "repair-applied", run_id: applied.runID, unit_id: unit.unit.id,
          repair_generation: applied.repairGeneration, task: operators.nextWorkerTask(applied) });
      },
    };
    tools[complete] = { description: "Root-only explicit acceptance request. Verifies current canonical evidence and closes this exact run without parsing final prose.",
      args: { run_id: stringSchema, acceptance_fingerprint: stringSchema }, execute: async (args, context) => {
        await requireRoot(context.sessionID);
        const state = await operators.required(context.sessionID);
        if (args.run_id !== state.runID || args.acceptance_fingerprint !== state.acceptanceFingerprint) throw new Error("operator-completion-identity-mismatch");
        if (!["awaiting-acceptance", "completed"].includes(state.phase) || state.units.some(unit => unit.status !== "succeeded")) {
          return JSON.stringify({ status: "not-ready", packet: operators.packet(state) });
        }
        const goalFingerprint = await operators.completionGoalFingerprint(state);
        if (state.phase === "awaiting-acceptance") {
          await relinkRegisteredGoal(context.sessionID, state, goalFingerprint);
          await control!.assertActiveGoal(context.sessionID, goalFingerprint);
        }
        const result = await control!.completeRoot(context.sessionID, goalFingerprint);
        if (result.receipt) await operators.terminal(context.sessionID, result.receipt);
        return JSON.stringify({ status: result.status, run_id: state.runID,
          acceptance_fingerprint: state.acceptanceFingerprint, receipt: result.receipt ?? null });
      } };
    tools[resume] = { description: "Reconcile a finished process-defect unit from native host validation records and unchanged source. For the exact first validation-only contract-repair continuation process defect, unchanged durable controls/candidate and available validation budget permit one same-worker validation-only retry; the result includes the exact Task to invoke. Never reimplements a unit or resets implementation/goal spend.",
      args: { run_id: stringSchema, acceptance_fingerprint: stringSchema }, execute: async (args, context) => {
        await requireRoot(context.sessionID);
        let state = await operators.required(context.sessionID);
        if (state.runID !== args.run_id || state.acceptanceFingerprint !== args.acceptance_fingerprint || state.phase !== "awaiting-decision") throw new Error("operator-resume-identity-mismatch");
        if (state.decision === "operator-acceptance-remediation-required") {
          throw new Error(state.repairGeneration === 1
            ? "operator-resume-unit-not-recoverable"
            : "operator-resume-acceptance-remediation-required");
        }
        async function finishedSession(id: string): Promise<void> {
          const statuses = payload(await session("status", { query: { directory: input.directory } }));
          const observed = record(statuses) ? statuses[id] : undefined;
          if (record(observed) && observed.type !== "idle") throw new Error("operator-resume-host-still-active");
          const history = await messages(id);
          const assistants = history.filter(message => (record(message.info) ? message.info.role : message.role) === "assistant");
          const last = assistants.at(-1), info = record(last?.info) ? last.info : last;
          const tail = history.at(-1), tailInfo = record(tail?.info) ? tail.info : tail;
          if (!info || tailInfo?.role !== "assistant" || (!isRecordTimeComplete(info) && info.finish !== "stop") || history.some(message => Array.isArray(message.parts) && message.parts.some(part =>
            record(part) && part.type === "tool" && record(part.state) && ["pending", "running"].includes(String(part.state.status))))) {
            throw new Error("operator-resume-host-still-active");
          }
        }
        function isRecordTimeComplete(info: Record<string, unknown>): boolean { return record(info.time) && typeof info.time.completed === "number"; }
        const delegate = state.operatorSessionID;
        if (state.units.length > 1) {
          const owner = delegate ? await identity(delegate) : undefined;
          if (!delegate || owner?.parent !== context.sessionID || owner.role !== "dog-operator") throw new Error("operator-resume-delegate-owner-mismatch");
          await finishedSession(delegate);
          operatorParents.set(delegate, context.sessionID);
        }
        const goalFingerprint = await operators.completionGoalFingerprint(state);
        await relinkRegisteredGoal(context.sessionID, state, goalFingerprint);
        await control!.assertActiveGoal(context.sessionID, goalFingerprint);
        await restorePriorAcceptance(context.sessionID, state);
        const recovered = new Map<string, readonly import("../core/goal-bound.js").GoalEvidence[]>();
        const unstarted = new Set<string>();
        for (const unit of state.units) {
          if (unit.status !== "failed") continue;
          const taskID = /^task_id: (.+)$/m.exec(unit.task.prompt)?.[1];
          if (!taskID) throw new Error("operator-resume-task-id-missing");
          if (unit.resultClass === "process-defect" && unit.childSessionID === null && unit.callID && state.decision === "dispatch-admission-rejected") {
            const history = await messages(state.units.length > 1 ? delegate! : context.sessionID);
            const matching = history.flatMap(message => Array.isArray(message.parts) ? message.parts : []).filter(part => record(part) &&
              part.type === "tool" && part.tool === "task" && part.callID === unit.callID && record(part.state) && part.state.status === "error" &&
               record(part.state.input) && operators.matchesRecordedWorkerTask(state, unit.unit.id, part.state.input) &&
              taskChildSessionID({ metadata: part.state.metadata, output: typeof part.state.output === "string" ? part.state.output : "" }) === undefined);
            if (matching.length !== 1 || !await control!.hasNoGoalReservation(context.sessionID, taskID, unit.callID)) throw new Error("operator-resume-unstarted-proof-missing");
            unstarted.add(unit.unit.id);
            continue;
          }
          const child = unit.childSessionID ? await identity(unit.childSessionID) : undefined;
          if (unit.resultClass !== "process-defect" || !unit.childSessionID || child?.role !== "dog-worker" ||
              child.parent !== (state.units.length > 1 ? delegate : context.sessionID)) throw new Error("operator-resume-unit-not-recoverable");
          await finishedSession(unit.childSessionID);
          try {
            recovered.set(unit.unit.id, await control!.recoverUnitEvidence(context.sessionID, { unitID: taskID,
              childSessionID: unit.childSessionID, manifestPath: unit.manifestPath, manifestHash: unit.hashes[1]!, goalFingerprint }));
          } catch (error) {
            if (!(error instanceof Error) || error.message.split(":", 1)[0] !== "operator-recovery-proof-unavailable-or-stale") throw error;
            if (!operators.canRetryRepairValidation(state)) {
              try {
                const remediation = await operators.requireAcceptanceRemediation(context.sessionID, state.runID);
                return JSON.stringify(await operatorPacket(remediation));
              } catch (remediationError) {
                if (!(remediationError instanceof Error) || remediationError.message !== "operator-process-remediation-not-ready") {
                  throw remediationError;
                }
                // A process defect without an authorized Git lifecycle has no committed remediation
                // baseline. Preserve the failed run and return an explicit replacement route instead
                // of turning this local routing limitation into a terminal tool exception.
                return JSON.stringify(processRemediationReplacementPacket(remediationError.message,
                  operators.packet(state), cancel, prepare));
              }
            }
            const retried = await operators.resumeRepairValidation(context.sessionID, state.runID,
              source => control!.authorizeOperatorContractRepairValidationRetry(context.sessionID,
                { ...source, declarationFingerprint: goalFingerprint }));
            await restorePriorAcceptance(context.sessionID, retried);
            return JSON.stringify({ run_id: retried.runID, acceptance_fingerprint: retried.acceptanceFingerprint,
              resumed: true, mode: "repair-validation-only", repair_validation_attempt: 2,
              task: retried.units.length === 1 ? operators.nextWorkerTask(retried) : operators.dispatchTask(retried) });
          }
        }
        await control!.assertActiveGoal(context.sessionID, goalFingerprint);
        const resumed = await operators.resume(context.sessionID, state.runID, recovered, unstarted);
        await restorePriorAcceptance(context.sessionID, resumed);
        if (resumed.phase === "awaiting-acceptance") return JSON.stringify(operators.packet(resumed));
        const remaining = resumed.units.filter(unit => unit.status === "pending").length;
        control!.enableUnits(context.sessionID, remaining);
        return JSON.stringify({ run_id: resumed.runID, acceptance_fingerprint: resumed.acceptanceFingerprint,
          resumed: true, remaining_units: remaining,
          task: resumed.units.length === 1 ? operators.nextWorkerTask(resumed) : operators.dispatchTask(resumed) });
      } };
    tools[beginProposal] = { description: `Root-only: freeze original ordered requirements and grant one bounded read-only proposal investigation to dogs-coordinator. The result contains one exact short Task reference; pass task.subagent_type, task.description, and task.prompt byte-for-byte without appending or paraphrasing. The native parent retains that reference; the host expands it only inside the directly claimed proposal child. ${OPERATOR_INTENT_CONTRACT}`,
      args: { intent_json: intentSchema }, execute: async (args, context) => {
        await requireRoot(context.sessionID);
        let state;
        try { state = await proposals.begin(context.sessionID, JSON.parse(args.intent_json)); }
        catch (error) {
          if (error instanceof OperatorProposalBudgetError) return JSON.stringify(error.diagnostic);
          throw error;
        }
        state = await proposals.bindGoal(context.sessionID, await control!.proposalGoalBinding(context.sessionID));
        return JSON.stringify({ ...proposals.packet(state) as object, task: proposals.referenceTask(state),
          dispatch_instruction: "Pass this short Task reference verbatim; do not append or paraphrase it." });
      } };
    tools[submitProposal] = { description: "Proposal-child-only: submit a requirement-mapped contract proposal without editing source or starting workers. " + proposalContract + " Omit plan.acceptance; the host derives its exact ordered text from durable intent.requirements. A legacy explicit plan.acceptance is accepted only when byte-exact in content and order; null, subsets, reorder, normalization, and acceptance_ids aliases are rejected.",
      args: { proposal_json: proposalSchema }, execute: async (args, context) => {
        const root = await rootFor(context.sessionID); if (!root) throw new Error("operator-proposal-session-inactive");
        try {
          const submitted = await proposals.submitJSON(root, context.sessionID, args.proposal_json);
          return JSON.stringify({ ...proposals.packet(submitted) as object,
            next_action: "Proposal submitted. This investigation child must now return to its parent without further tools. " +
              "Do not call operator_next, start a worker, or claim approval; the root must compare and approve the proposal." });
        }
        catch (error) {
          const contract = error instanceof OperatorContractError;
          if (!contract && (!(error instanceof Error) || !error.message.startsWith("operator-proposal-"))) throw error;
          const state = await proposals.required(root);
          return JSON.stringify({ status: "invalid-proposal", code: error.message, actual_reads: state.read_count,
            remaining_reads: state.intent.proposal_budget.max_reads - state.read_count,
            submissions: state.submission_count, remaining_submissions: state.intent.proposal_budget.max_submissions - state.submission_count,
            ...(contract ? { diagnostics: error.diagnostics, diagnostics_truncated: error.diagnostics_truncated } : {}) });
        }
      } };
    tools[approveProposal] = { description: "Root-only: record semantic comparison of the exact proposal revision/hash, then connect its immutable plan to the existing execution lane. " + OPERATOR_APPROVAL_CONTRACT,
      args: { approval_json: approvalSchema }, execute: async (args, context) => {
        await requireRoot(context.sessionID);
        return serializeDispatchTransition(context.sessionID, async () => {
          let approval: unknown;
          try { approval = JSON.parse(args.approval_json); }
          catch {
            return JSON.stringify({ status: "invalid-approval", code: "operator-proposal-approval-json-invalid", diagnostics: [{
              document: "approval", pointer: "/", code: "operator-proposal-approval-json-invalid", rule: "json",
              repair_kind: "repair-field", repair_paths: ["/"] }], diagnostics_truncated: false });
          }
          let approved;
          try { approved = await proposals.approve(context.sessionID, approval, false); }
          catch (error) {
            if (error instanceof OperatorContractError && error.diagnostics.every(item => item.document === "approval")) {
              return JSON.stringify({ status: "invalid-approval", code: error.message,
                diagnostics: error.diagnostics, diagnostics_truncated: error.diagnostics_truncated });
            }
            throw error;
          }
          const proposal = approved.proposal!;
          if (approved.goal_binding === null) throw new Error("operator-proposal-goal-binding-missing");
          await control!.assertProposalExecutionBudget(context.sessionID, approved.goal_binding, proposal.plan.units.length);
          const prepared = await operators.propose(context.sessionID, proposal.plan);
          if (prepared.status !== "prepared") throw new Error("operator-proposal-approved-plan-invalid");
          await registerPreparedGoal(context.sessionID, prepared.state);
          const committed = await proposals.approve(context.sessionID, approval);
          return JSON.stringify({ ...proposalIdentity(committed), execution: JSON.parse(preparedTask(prepared.state)) });
        });
      } };
    const ownTools = new Set([prepare, repair, next, status, cancel, complete, resume, resolveContractRepair,
      beginProposal, submitProposal, approveProposal]);
    const protocolMap = CANONICAL_AGENT_ROLES.map(role => `${role}=${profileAgent(profile, role)}`).join(", ");
    function rememberRendered(key: string, text: string): void {
      renderedParts.set(key, goalFingerprint(text));
      while (renderedParts.size > 256) renderedParts.delete(renderedParts.keys().next().value!);
    }
    async function renderCompletedReply(sessionID: string, info: Record<string, unknown>): Promise<void> {
      if (info.role !== "assistant" || canonicalAgent(profile, typeof info.agent === "string" ? info.agent : undefined) !== "dog-coordinator" ||
          info.finish !== "stop" || !record(info.time) || typeof info.time.completed !== "number" || typeof info.id !== "string" ||
          await rootFor(sessionID) !== sessionID) return;
      const messageKey = `${sessionID}:${info.id}`;
      if (renderingMessages.has(messageKey) || reportFailures.has(messageKey)) return;
      renderingMessages.add(messageKey);
      try {
        const receipt = await control!.currentReceipt(sessionID);
        if (receipt?.status !== "succeeded") return;
        if (info.time.completed < Date.parse(receipt.ended_at)) return;
        const single = payload(await session("message", { path: { id: sessionID, messageID: info.id }, query: { directory: input.directory } }));
        const message = record(single) ? single : (await messages(sessionID)).find(item => record(item.info) && item.info.id === info.id);
        if (!record(message) || !record(message.info) || message.info.id !== info.id || message.info.sessionID !== sessionID ||
            message.info.role !== "assistant" || canonicalAgent(profile, typeof message.info.agent === "string" ? message.info.agent : undefined) !== "dog-coordinator" ||
            !Array.isArray(message.parts)) return;
        const part = [...message.parts].reverse().find(value => record(value) && value.type === "text" && value.synthetic !== true &&
          typeof value.text === "string" && value.text.trim().length > 0);
        if (!record(part) || typeof part.id !== "string" || typeof part.text !== "string" || part.sessionID !== sessionID || part.messageID !== info.id) return;
        const key = `${messageKey}:${part.id}`;
        if (renderedParts.get(key) === goalFingerprint(part.text)) return;
        const text = await control!.renderReturnReport(sessionID, decoratePreviewHeadings(part.text), goalFingerprint(receipt));
        if (text === undefined) return;
        if (text === part.text) { rememberRendered(key, text); return; }
        const raw = input.client as unknown as Record<string, unknown> | undefined;
        const v2 = record(raw?.v2) ? raw.v2 : undefined;
        const parts = record(v2?.part) ? v2.part : record(raw?.part) ? raw.part : undefined;
        const updatedPart = { ...part, text };
        let result: unknown;
        if (typeof parts?.update === "function") {
          result = await parts.update.call(parts, { sessionID, messageID: info.id, partID: part.id, directory: input.directory, part: updatedPart }, { throwOnError: true });
        } else {
          // Authenticated host client; this is the documented Part.update endpoint.
          const transport = record(raw?._client) ? raw._client : record(raw?.client) ? raw.client : undefined;
          if (typeof transport?.patch !== "function") throw new Error("return-report-part-api-unavailable");
          result = await transport.patch.call(transport, { url: "/session/{sessionID}/message/{messageID}/part/{partID}",
            path: { sessionID, messageID: info.id, partID: part.id }, query: { directory: input.directory }, body: updatedPart,
            headers: { "Content-Type": "application/json" }, throwOnError: true });
        }
        if (record(result) && result.error !== undefined) throw new Error("return-report-part-update-failed");
        rememberRendered(key, text);
      } catch (error) {
        reportFailures.add(messageKey);
        while (reportFailures.size > 256) reportFailures.delete(reportFailures.values().next().value!);
        const log = input.client?.app?.log;
        if (log) await Promise.resolve(log.call(input.client!.app, { body: { service: `sortie-dogs-${profile.id}`, level: "warn",
          message: "return-report.render-unavailable", extra: { sessionID, error: error instanceof Error ? error.name : "unknown" } },
          query: { directory: input.directory } })).catch(() => undefined);
      } finally { renderingMessages.delete(messageKey); }
    }

    const hooks: OpenCodeHooks & { config(config: Record<string, unknown>): Promise<void> } = {
      config: async config => {
        const configuredPermission = config.permission;
        const permission = typeof configuredPermission === "string"
          ? { "*": configuredPermission }
          : record(configuredPermission) ? { ...configuredPermission } : {};
        config.permission = { ...permission, [`${profile.toolPrefix}*`]: "deny" };
        const agents = record(config.agent) ? config.agent : {};
        config.agent = agents;
        for (const name of ["build", "plan"]) agents[name] ??= {};
        for (const [name, value] of Object.entries(agents)) {
          if (canonicalAgent(profile, name) || !record(value)) continue;
          const configured = value.permission;
          const rules = typeof configured === "string"
            ? { "*": configured }
            : record(configured) ? { ...configured } : {};
          value.permission = { ...rules, [`${profile.toolPrefix}*`]: "deny" };
        }
        const workerName = profileAgent(profile, "dog-worker");
        const worker = record(agents[workerName]) ? agents[workerName] : undefined;
        if (worker !== undefined) {
          explicitWorkerSelection = {
            ...(typeof worker.model === "string" ? { model: worker.model } : {}),
            ...(typeof worker.variant === "string" ? { variant: worker.variant } : {}),
          };
          worker.model ??= PREVIEW_WORKER_ROUTE.model;
          if (worker.variant === undefined && worker.model === PREVIEW_WORKER_ROUTE.model) worker.variant = PREVIEW_WORKER_ROUTE.variant;
        }
        const operationsName = profileAgent(profile, "dog-operator");
        const operations = record(agents[operationsName]) ? agents[operationsName] : undefined;
        if (operations) {
          operations.model ??= PREVIEW_OPERATIONS_ROUTE.model;
          if (operations.variant === undefined && operations.model === PREVIEW_OPERATIONS_ROUTE.model) operations.variant = PREVIEW_OPERATIONS_ROUTE.variant;
        }
      },
      tool: tools,
      "chat.message": async (chat, output) => {
        const actual = chat.agent ?? output.message.agent;
        const previous = canonicalAgent(profile, selected.get(chat.sessionID));
        if (actual !== undefined) selected.set(chat.sessionID, actual);
        const role = canonicalAgent(profile, actual);
        if (previous === "dog-coordinator" && role !== "dog-coordinator") await stop(chat.sessionID, "agent-changed");
        if (!role && previous === undefined) return;
        if (role === "dog-coordinator") {
          const realTurn = !output.parts.some(part => record(part) && part.synthetic === true) &&
            output.parts.some(part => record(part) && part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0);
          if (realTurn) {
            const state = await operators.read(chat.sessionID);
            if ((state !== undefined && (state.phase === "cancelled" || state.phase === "completed")) ||
                operatorTurnLifecycle.get(chat.sessionID) === "cancelled") {
              operatorTurnLifecycle.set(chat.sessionID, "historical");
              const messageID = typeof chat.messageID === "string" && chat.messageID.length > 0
                ? chat.messageID
                : typeof output.message.id === "string" && output.message.id.length > 0 ? output.message.id : undefined;
              if (messageID !== undefined) historicalTurnMessages.set(chat.sessionID, messageID);
              await control?.retireHistoricalGoal(chat.sessionID);
            } else {
              operatorTurnLifecycle.delete(chat.sessionID);
              historicalTurnMessages.delete(chat.sessionID);
            }
          }
          if (retired.has(chat.sessionID) && output.parts.some(part => record(part) && part.synthetic === true)) throw new Error("runtime-profile-revoked");
          retired.delete(chat.sessionID);
        }
        if (role === "dog-operator") {
          // The host invokes this hook before persisting the first user message.
          // Bind the actual incoming prompt against the already-admitted parent grant.
          const textParts = output.parts.filter(record).filter(part => part.type === "text" && typeof part.text === "string");
          if (textParts.length !== 1) throw new Error("operator-child-task-prompt-invalid");
          const textPart = textParts[0]!;
          if (typeof textPart.text !== "string") throw new Error("operator-child-task-prompt-invalid");
          const who = await identity(chat.sessionID);
          const root = who.parent === undefined ? undefined : await rootFor(who.parent);
          if (!root || root !== who.parent) throw new Error("operator-grant-invalid");
          const prompt = textPart.text;
          const proposal = await proposals.read(root);
          if ((proposal?.phase === "investigating" && proposal.proposal_call_id !== null) || proposals.isProposalPrompt(prompt)) {
            textPart.text = await proposals.claimAdmittedPrompt(root, who.parent, chat.sessionID, prompt);
          } else {
            textPart.text = await operators.claimAdmittedOperatorPrompt(root, who.parent, chat.sessionID, prompt);
          }
          operatorParents.set(chat.sessionID, root);
          if (!await rootFor(chat.sessionID)) throw new Error("operator-grant-invalid");
        }
        if (role === "dog-worker") {
          const root = await rootFor(chat.sessionID);
          if (root) {
            const textParts = output.parts.filter(record).filter(part => part.type === "text" && typeof part.text === "string");
            if (textParts.length !== 1) throw new Error("operator-child-task-prompt-invalid");
            const prompt = textParts.map(part => part.text).join("\n");
            const native = await identity(chat.sessionID);
            if (!native.parent) throw new Error("operator-worker-parent-mismatch");
            const admitted = await operators.claimAdmittedWorkerPrompt(root, native.parent, chat.sessionID, prompt);
            if (admitted.repairValidationRetry !== undefined) {
              await control!.activateOperatorContractRepairValidationRetry(root, {
                taskID: admitted.repairValidationRetry.taskID, childSessionID: chat.sessionID,
                callID: admitted.callID, repairFingerprint: admitted.repairValidationRetry.repairFingerprint,
                binding: admitted.repairValidationRetry.binding,
              });
            }
            textParts[0]!.text = admitted.prompt;
          }
        }
        const mapped = translate(output, false) as typeof output;
        await core["chat.message"]?.(translate(chat, false) as typeof chat, mapped);
        Object.assign(output, translate(mapped, true));
        if (role === "dog-worker" && explicitWorkerSelection) {
          if (explicitWorkerSelection.model) {
            const split = explicitWorkerSelection.model.indexOf("/");
            if (split <= 0) throw new Error("invalid-explicit-worker-model");
            output.message.model = { providerID: explicitWorkerSelection.model.slice(0, split), modelID: explicitWorkerSelection.model.slice(split + 1),
              ...(explicitWorkerSelection.variant ? { variant: explicitWorkerSelection.variant } : {}) };
          } else if (explicitWorkerSelection.variant) output.message.model.variant = explicitWorkerSelection.variant;
        }
        if (actual !== undefined) output.message.agent = actual;
        if (role === "dog-coordinator" && previous !== role) {
          const packageVersion = await readFile(new URL("../../package.json", import.meta.url), "utf8")
            .then(source => String(JSON.parse(source).version)).catch(() => "unknown");
          const model = output.message.model;
          const log = input.client?.app?.log;
          if (log) void Promise.resolve(log.call(input.client!.app, { body: {
            service: `sortie-dogs-${profile.id}`, level: "info", message: "runtime.profile-selected",
            extra: { sessionID: chat.sessionID, profile: profile.id, packageVersion, runtimeMarker: assetVersion,
              agent: actual, model: `${model.providerID}/${model.modelID}` },
          }, query: { directory: input.directory } })).catch(() => undefined);
        }
      },
      "tool.execute.before": async (request, output) => {
        const who = await identity(request.sessionID);
        if (!who.role) {
          if (request.tool.startsWith(profile.toolPrefix)) throw new Error(RUNTIME_PROFILE_SESSION_INACTIVE);
          return;
        }
        const root = await rootFor(request.sessionID);
        if (!root) throw new Error(RUNTIME_PROFILE_SESSION_INACTIVE);
        if (request.tool.startsWith("sortie_") && !request.tool.startsWith(profile.toolPrefix)) throw new Error("runtime-profile-tool-mismatch");
        if (who.role === "dog-worker") {
          const state = await operators.read(root);
          if (!state?.units.some(unit => unit.status === "running" && unit.childSessionID === request.sessionID)) {
            throw new Error("operator-worker-owner-mismatch");
          }
        }
        const args = record(output.args) ? output.args : {};
        const repairAccess = who.role === "dog-worker" ? await operators.repairValidationAccess(root, request.sessionID) : null;
        if (repairAccess !== null) {
          const bind = profileTool(profile, "sortie_bind_write_gate"), release = profileTool(profile, "sortie_release_write_gate");
          const allowedRead = request.tool.toLowerCase() === "read" && typeof args.filePath === "string" &&
            resolve(args.filePath) === resolve(repairAccess.handoff_path);
          const allowedBind = request.tool === bind && args.project_root === input.directory &&
            resolve(String(args.manifest_path ?? "")) === resolve(repairAccess.manifest_path);
          const allowedRelease = request.tool === release;
          const allowedValidation = ["bash", "shell"].includes(request.tool.toLowerCase()) && typeof args.command === "string" &&
            repairAccess.expected_command !== null && normalizeCommand(args.command) === repairAccess.expected_command;
          if (!allowedRead && !allowedBind && !allowedRelease && !allowedValidation) {
            throw new Error("operator-contract-repair-validation-only");
          }
        }
        if (ownTools.has(request.tool)) return;
        const proposal = who.role === "dog-operator" ? await proposals.read(root) : undefined;
        const proposalChild = proposal?.phase === "investigating" && proposal.proposal_session_id === request.sessionID;
        if (proposalChild) {
          // OpenCode V2 exposes server plugin tools to Code Mode through its `execute`
          // conduit. The nested submit tool still performs the session/grant checks below;
          // denying the conduit makes an otherwise read-only proposal impossible to submit.
          if (request.tool === "execute") return;
          if (request.tool !== "read") throw new Error("operator-proposal-readonly-role");
          if (typeof args.filePath !== "string") throw new Error("operator-proposal-read-path-required");
          const requested = await realpath(resolve(input.directory, args.filePath)).catch(() => { throw new Error("operator-proposal-read-path-unavailable"); });
          const permitted = await Promise.all(proposal.intent.allow_read.map(scope => realpath(resolve(input.directory, scope)).catch(() => resolve(input.directory, scope))));
          if (!permitted.some(scope => {
            const rest = relative(scope, requested);
            return rest === "" || (!rest.startsWith(`..${sep}`) && rest !== ".." && !rest.startsWith(sep) && !/^[A-Za-z]:/u.test(rest));
          })) throw new Error("operator-proposal-read-scope-denied");
          await proposals.accountRead(root, request.sessionID, normalizeRelativePath(relative(input.directory, resolve(input.directory, args.filePath))));
          return;
        }
        if (who.role === "dog-operator" && request.tool === "read") {
          if (typeof args.filePath !== "string") throw new Error("operator-read-path-required");
          const path = resolve(input.directory, args.filePath);
          const state = await operators.required(root);
          const permitted = state.units.flatMap(unit => [...unit.unit.read, ...unit.unit.write, unit.handoffPath, unit.manifestPath]);
          if (!permitted.some(scope => {
            const rest = relative(resolve(input.directory, scope), path);
            return rest === "" || (!rest.startsWith(`..${sep}`) && rest !== ".." && !rest.startsWith(sep) && !/^[A-Za-z]:/.test(rest));
          })) throw new Error("operator-read-scope-denied");
          return;
        }
        if (who.role === "dog-operator" && !["task", "todowrite", "todoread"].includes(request.tool)) throw new Error("operator-readonly-control-role");
        if (request.tool === "task" && (args.subagent_type === profileAgent(profile, "dog-operator") || proposals.isReferenceTask(args))) {
          await requireRoot(request.sessionID);
          const pendingProposal = await proposals.read(root);
          if (pendingProposal?.phase === "investigating") {
            if (pendingProposal.goal_binding === null) throw new Error("operator-proposal-goal-binding-missing");
            const binding = pendingProposal.goal_binding;
            let reserved = false;
            try {
              await proposals.admit(root, request.callID, args, async () => {
                await control!.reserveProposalBudget(root, pendingProposal.intent_id, request.callID, binding);
                reserved = true;
              });
            } catch (error) {
              // The grant save can fail after durable reservation. No Task was
              // admitted, so settle here rather than relying on taskOwners/stop.
              if (reserved) await control!.settleProposalBudget(root, pendingProposal.intent_id, request.callID, "failed");
              throw error;
            }
            taskOwners.set(request.callID, { root, actor: request.sessionID, operator: false, proposal: true });
            return;
          }
          await proposals.assertExecutionApproved(root, (await operators.required(root)).planHash);
          // Admission resolves an internal canonical clone. Keep the native parent Task
          // as the opaque reference; the child receives canonical text only after claim.
          await operators.admitOperator(root, request.callID, args);
          taskOwners.set(request.callID, { root, actor: request.sessionID, operator: true });
          return;
        }
        const state = await operators.read(root);
        const delegated = request.tool === "task" && args.subagent_type === profileAgent(profile, "dog-worker") &&
          state !== undefined && ["prepared", "running"].includes(state.phase);
        if (who.role === "dog-operator" && request.tool === "task" && !delegated) throw new Error("operator-worker-task-required");
        let expandedWorker: import("../core/operator-runtime.js").OperatorTask | undefined;
        if (delegated) {
          await proposals.assertExecutionApproved(root, state!.planHash);
          await restorePriorAcceptance(root, state!);
          expandedWorker = await operators.admitWorker(root, request.sessionID, request.callID, args);
          taskOwners.set(request.callID, { root, actor: request.sessionID, operator: false });
        }
        const mapped = translate(expandedWorker === undefined ? output : { ...output, args: expandedWorker }, false) as typeof output;
        try {
          if (who.role === "dog-worker") {
            const checkedArgs = record(mapped.args) ? mapped.args : {};
            if (typeof checkedArgs.command === "string") {
              try { await operators.preflightPostCommitValidation(root, request.sessionID, checkedArgs.command); }
              catch (error) {
                if (error instanceof OperatorContractError && error.diagnostics.length > 0 &&
                    error.diagnostics.every(item => item.code === "operator-git-change-outside-write-union")) {
                  const repaired = await operators.recordContractRepair(root, request.sessionID, error, checkedArgs.command);
                  const unit = repaired.units.find(item => item.childSessionID === request.sessionID);
                  const taskID = unit === undefined ? undefined : /^task_id: (.+)$/m.exec(unit.task.prompt)?.[1];
                  if (taskID) await control!.retainOperatorContractRepairWorker(root, taskID, request.sessionID);
                }
                throw error;
              }
            }
          }
          await core["tool.execute.before"]?.({ ...translate(request, false) as typeof request,
            ...(delegated ? { sessionID: root, agent: "dog-coordinator" } : {}) }, mapped);
          if (who.role === "dog-worker") {
            const checkedArgs = record(mapped.args) ? mapped.args : {};
            if (typeof checkedArgs.command === "string") {
              try { await operators.beforePostCommitValidation(root, request.sessionID, checkedArgs.command); }
              catch (error) {
                if (error instanceof OperatorContractError && error.diagnostics.length > 0 &&
                    error.diagnostics.every(item => item.code === "operator-git-change-outside-write-union")) {
                  const repaired = await operators.recordContractRepair(root, request.sessionID, error, checkedArgs.command);
                  const unit = repaired.units.find(item => item.childSessionID === request.sessionID);
                  const taskID = unit === undefined ? undefined : /^task_id: (.+)$/m.exec(unit.task.prompt)?.[1];
                  if (taskID) await control!.retainOperatorContractRepairWorker(root, taskID, request.sessionID);
                }
                throw error;
              }
            } else if (await operators.postCommitLocked(root) && ["edit", "write", "apply_patch"].includes(request.tool.toLowerCase())) {
              throw new Error("operator-git-post-commit-write-denied");
            }
          }
          if (delegated && (await operators.required(root)).phase !== "running") throw new Error("operator-grant-revoked");
          const outward = translate(mapped, true) as typeof output;
          if (expandedWorker !== undefined) {
              const checked = record(outward.args) ? outward.args : undefined;
              if (checked?.subagent_type !== expandedWorker.subagent_type || checked.description !== expandedWorker.description ||
                checked.prompt !== expandedWorker.prompt || checked.task_id !== expandedWorker.task_id) {
                throw new Error("operator-canonical-task-mutated");
              }
            // Keep the caller-visible/native Task input as the opaque reference. The
            // worker chat hook above delivers this already-admitted canonical prompt.
          } else Object.assign(output, outward);
        } catch (error) {
          if (delegated) { taskOwners.delete(request.callID); await operators.rejectedAdmission(root, request.callID); }
          throw error;
        }
      },
      "tool.execute.after": async (request, output) => {
        const id = request.sessionID;
        if (!id) return;
        const ownership = request.callID === undefined ? undefined : taskOwners.get(request.callID);
        if (ownership?.proposal) {
          const proposal = await proposals.required(ownership.root);
          await control!.settleProposalBudget(ownership.root, proposal.intent_id, request.callID!,
            proposal.phase === "submitted" ? "succeeded" : "failed");
          output.output = JSON.stringify(proposals.packet(await proposals.required(ownership.root)));
          taskOwners.delete(request.callID!);
          return;
        }
        if (ownership?.operator) {
          const state = await operators.operatorReturned(ownership.root);
          output.output = JSON.stringify(await operatorPacket(state));
          taskOwners.delete(request.callID!);
          return;
        }
        if ((!ownership && !await rootFor(id)) || ownTools.has(request.tool)) return;
        const afterIdentity = !ownership ? await identity(id) : undefined;
        const repairAccess = !ownership && afterIdentity?.role === "dog-worker"
          ? await operators.repairValidationAccess((await rootFor(id))!, id) : null;
        const mapped = translate(output, false) as typeof output;
        await core["tool.execute.after"]?.({ ...translate(request, false) as typeof request,
          ...(ownership ? { sessionID: ownership.root } : {}) }, mapped);
        Object.assign(output, translate(mapped, true));
        if (repairAccess !== null && ["bash", "shell"].includes(request.tool.toLowerCase())) {
          const metadata = record(output.metadata) ? output.metadata : undefined;
          const exit = metadata?.exit;
          if (!Number.isSafeInteger(exit)) throw new Error("operator-contract-repair-validation-exit-missing");
          if (repairAccess.expected_command === null) throw new Error("operator-contract-repair-validation-command-missing");
          await operators.recordRepairValidationResult((await rootFor(id))!, id, repairAccess.expected_command, exit as number);
        }
        if (!ownership && request.tool.toLowerCase() === "read") {
          const proposal = await proposals.read((await rootFor(id))!);
          if (proposal?.phase === "investigating" && proposal.proposal_session_id === id) {
            output.output = `${output.output ?? ""}\n\nSORTIE_PROPOSAL_BUDGET actual_reads=${proposal.read_count}; ` +
              `remaining_reads=${proposal.intent.proposal_budget.max_reads - proposal.read_count}; ` +
              `submissions=${proposal.submission_count}; ` +
              `remaining_submissions=${proposal.intent.proposal_budget.max_submissions - proposal.submission_count}.`;
          }
        }
        if (ownership) {
          const child = taskChildSessionID(output);
          if (child) await operators.observeChild(ownership.root, request.callID!, child);
          const state = await operators.required(ownership.root);
          const repairUnit = state.units.find(unit => unit.callID === request.callID && unit.repairValidation !== null);
          if (repairUnit) {
            const taskID = /^task_id: (.+)$/m.exec(repairUnit.task.prompt)?.[1];
            try {
              if (!child || child !== repairUnit.repairValidation!.child_session_id || !taskID) {
                throw new Error("operator-contract-repair-validation-child-mismatch");
              }
              const goalFingerprint = await operators.completionGoalFingerprint(state);
              const evidence = await control!.recoverUnitEvidence(ownership.root, { unitID: taskID, childSessionID: child,
                manifestPath: repairUnit.manifestPath, manifestHash: repairUnit.hashes[1]!, goalFingerprint });
              await operators.completeRepairValidation(ownership.root, request.callID!, evidence);
            } catch (error) {
              const code = error instanceof Error ? error.message.split(":", 1)[0] : "unknown";
              await operators.failRepairValidation(ownership.root, request.callID!, `operator-contract-repair-validation-incomplete:${code}`);
            } finally {
              if (child) await control!.finishOperatorContractRepairValidation(ownership.root, child);
            }
          } else if (child && state.repairGeneration === 1 &&
              (state.decision?.startsWith("operator-contract-repair-validation-") ||
                state.decision === "operator-acceptance-remediation-required") &&
              state.units.some(unit => unit.callID === request.callID &&
                (unit.resultClass === "process-defect" || unit.resultClass === "acceptance"))) {
            await control!.finishOperatorContractRepairValidation(ownership.root, child);
          }
          output.output = JSON.stringify(await operatorPacket(await operators.required(ownership.root)));
          taskOwners.delete(request.callID!);
        }
      },
      "permission.ask": async (request, output) => {
        if (!request.sessionID || !await rootFor(request.sessionID)) return;
        if ((await identity(request.sessionID)).role === "dog-operator" && request.permission === "edit") { output.status = "deny"; return; }
        await core["permission.ask"]?.(request, output);
      },
      "experimental.chat.system.transform": async (request, output) => {
        const root = await rootFor(request.sessionID) ?? await proposalPromptRoot(request.sessionID);
        if (!root) return;
        await core["experimental.chat.system.transform"]?.(request, output);
        (output.system ??= []).push(`SORTIE_RUNTIME_PROFILE ${profile.id}; marker ${assetVersion}. ` +
          `Shared MkII protocol role names are logical: ${protocolMap}. Use only ${profile.toolPrefix} tools for this profile. ` +
          "Never rewrite user acceptance or evidence to rename protocol roles. Final acceptance belongs only to the root coordinator.");
        const proposal = await proposals.read(root);
        if (proposal?.phase !== "approved" && proposal?.proposal_session_id === request.sessionID) {
          // Only immutable identity and the frozen budget caps belong here. Consumed counters move with
          // every accounted read, and a system element is an absolute prompt prefix: restating them here
          // invalidated the whole cached prefix on every later request of the same investigation, so the
          // Task prompt and all accumulated reads were re-billed uncached. They are reported on the read
          // result instead, which is appended after the stable prefix.
          //
          // The phase is deliberately not part of this condition. Removing an element is the same absolute
          // prefix change as rewriting one: gating on `investigating` dropped this block the moment a
          // submission succeeded, so the child's final turn re-sent the entire accumulated investigation
          // uncached. The terminal submit result is appended after this prefix and is more recent.
          (output.system ??= []).push(`SORTIE_PROPOSAL_PHASE investigating; intent=${proposal.intent_id}; root=${root}; child=${request.sessionID}. ` +
            `This durable phase remains authoritative after compaction even when the latest message is a generic continuation. ` +
            `Continue the admitted read-only investigation and submit through ${submitProposal}. Do not call ${next} or dispatch workers: no execution run exists yet. ` +
            `max_reads=${proposal.intent.proposal_budget.max_reads}; max_submissions=${proposal.intent.proposal_budget.max_submissions}. ` +
            `Consumed budget is reported as SORTIE_PROPOSAL_BUDGET on each read result and by ${submitProposal}; never infer it from this element.`);
        }
      },
      "experimental.text.complete": async (request, output) => {
        const role = (await identity(request.sessionID)).role;
        if (role === "dog-operator" || !await rootFor(request.sessionID)) return;
        const mapped = { text: role === "dog-coordinator" ? forwardTerminalText(output.text) : output.text };
        const originalText = sanitizeTerminalReport(mapped.text);
        const hadTerminalHeading = terminalRunOutcome(mapped.text) !== undefined;
        await core["experimental.text.complete"]?.(request, mapped);
        if (role === "dog-coordinator" && terminalRunOutcome(originalText) === "DONE" &&
            operatorTurnLifecycle.get(request.sessionID) === "historical") {
          const state = await operators.read(request.sessionID);
          const proposal = await proposals.read(request.sessionID);
          const receipt = await control!.currentReceipt(request.sessionID);
          const userMessageID = historicalTurnMessages.get(request.sessionID);
          if (proposal === undefined &&
              (state === undefined || state.phase === "cancelled" || state.phase === "completed") && receipt === undefined &&
              userMessageID !== undefined && await control!.isUncontractedGoal(request.sessionID, userMessageID) &&
              terminalRunOutcome(mapped.text) === "INTERRUPTED") mapped.text = originalText;
        }
        output.text = role === "dog-coordinator" ? decoratePreviewHeadings(mapped.text) : mapped.text;
        if (role === "dog-coordinator") {
          const receipt = await control!.currentReceipt(request.sessionID);
          if (receipt?.status === "succeeded") {
            if (!hadTerminalHeading) output.text = await control!.renderReturnReport(request.sessionID, output.text, goalFingerprint(receipt)) ?? output.text;
            if (output.text.includes("<summary><strong>🐾 SORTIE DOGS — 帰還報告")) rememberRendered(`${request.sessionID}:${request.messageID}:${request.partID}`, output.text);
          }
        }
      },
      "experimental.session.compacting": async (request, output) => {
        const root = await rootFor(request.sessionID);
        if (!root) return;
        if ((await identity(request.sessionID)).role === "dog-operator") {
          const proposal = await proposals.read(root);
          if (proposal?.phase === "investigating" && proposal.proposal_session_id === request.sessionID) {
            (output.context ??= []).push(`Proposal continuation: ${JSON.stringify({
              root, child: request.sessionID, intent_id: proposal.intent_id, intent_hash: proposal.intent_hash,
              intent: proposal.intent, goal_binding: proposal.goal_binding, read_paths: proposal.read_paths,
              actual_reads: proposal.read_count, remaining_reads: proposal.intent.proposal_budget.max_reads - proposal.read_count,
              submissions: proposal.submission_count, remaining_submissions: proposal.intent.proposal_budget.max_submissions - proposal.submission_count,
            })}. Preserve the latest proposal draft and field diagnostics in the summary. Continue only in this same claimed read-only proposal child. ` +
              `Repair only diagnosed fields, then call ${submitProposal}; do not call ${next}, dispatch Tasks, execute work, or reset budgets. ` +
              "This is investigation, not an execution run. Compaction grants no new reads or submissions.");
            return;
          }
          const state = await operators.required(root);
          (output.context ??= []).push(`Operator continuation: root=${root}; run=${state.runID}; generation=${state.generation}; contract=${state.planHash}. ` +
            `Read ${next} for current authoritative state. Do not reconstruct acceptance or reset the queue.`);
          return;
        }
        await core["experimental.session.compacting"]?.(request, output);
      },
      "experimental.compaction.autocontinue": async (request, output) => {
        const root = await rootFor(request.sessionID);
        if (!root) return;
        if ((await identity(request.sessionID)).role === "dog-operator") {
          const proposal = await proposals.read(root);
          if (proposal?.phase === "investigating" && proposal.proposal_session_id === request.sessionID) return;
          output.enabled = false;
          return;
        }
        await core["experimental.compaction.autocontinue"]?.(request, output);
      },
      event: async ({ event }) => {
        const properties = event.properties ?? {};
        const info = record(properties.info) ? properties.info : undefined;
        const part = record(properties.part) ? properties.part : undefined;
        const id = typeof properties.sessionID === "string" ? properties.sessionID
          : typeof info?.sessionID === "string" ? info.sessionID
            : typeof part?.sessionID === "string" ? part.sessionID
              : event.type.startsWith("session.") && typeof info?.id === "string" ? info.id : undefined;
        if (!id) return;
        if (event.type === "session.deleted" && canonicalAgent(profile, selected.get(id)) === "dog-coordinator") {
          await stop(id, "session-deleted");
          return;
        }
        if (!await rootFor(id)) return;
        const mappedEvent = translate({ event }, false) as { event: typeof event };
        const mappedPart = record(mappedEvent.event.properties?.part) ? mappedEvent.event.properties.part : undefined;
        if ((await identity(id)).role === "dog-coordinator" && mappedPart?.type === "text" && typeof mappedPart.text === "string") {
          mappedPart.text = forwardTerminalText(mappedPart.text);
        }
        await core.event?.(mappedEvent);
        if (event.type === "message.updated" && info) await renderCompletedReply(id, info);
        if (event.type === "message.part.updated" && part?.type === "tool" && part.tool === "task" &&
          typeof part.callID === "string" && record(part.state) && part.state.status === "error") {
          const ownership = taskOwners.get(part.callID);
          if (ownership !== undefined && ownership.actor === id) {
            const settled = ownership.proposal
              ? (await control!.settleProposalBudget(ownership.root, (await proposals.required(ownership.root)).intent_id,
                part.callID, "failed"), true)
              : ownership.operator
              ? (await operators.operatorRejected(ownership.root), true)
              : await control?.settleRejectedDispatch(ownership.root, part.callID) ?? false;
            if (settled) taskOwners.delete(part.callID);
          }
        }
      },
    };
    const before = hooks["tool.execute.before"]!;
    hooks["tool.execute.before"] = async (request, output) => {
      if (request.tool !== "task") return before(request, output);
      const root = await rootFor(request.sessionID);
      // Cover the entire admission, including core goal reservation. A prepared
      // Task obtained via operator_next must not dispatch during proposal approval.
      return root === undefined ? before(request, output)
        : serializeDispatchTransition(root, () => before(request, output));
    };
    return hooks;
  };
}

export const SortieDogsV010Plugin: OpenCodePlugin = createProfiledPlugin(V010_RUNTIME_PROFILE, V010_RUNTIME_ASSET_VERSION);
