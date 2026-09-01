/** Internal, provider-neutral contract for hosts embedding Sortie-dogs. */

export const HOST_CONFORMANCE_VERSION = "sortie-host-conformance/v1" as const;

export type SessionIdentity = Readonly<{
  sessionID: string;
  agent?: string;
  parentID?: string;
  parentPresent: boolean;
}>;
export type ToolIdentity = Readonly<{ sessionID: string; callID: string }>;
export type WorkerIdentity = Readonly<{
  parentSessionID: string;
  callID: string;
  childSessionID: string;
}>;
export type CompletionIdentity = Readonly<{
  sessionID: string;
  messageID: string;
  partID?: string;
}>;
export type ModelIdentity = Readonly<{ providerID: string; modelID: string }>;

export function sessionIdentity(
  sessionID: string,
  details: Readonly<{ agent?: string; parentID?: string; parentPresent: boolean }>,
): SessionIdentity {
  return Object.freeze({ sessionID, ...details });
}

export function toolIdentity(sessionID: string, callID: string): ToolIdentity {
  return Object.freeze({ sessionID, callID });
}

export function workerIdentity(parentSessionID: string, callID: string, childSessionID: string): WorkerIdentity {
  return Object.freeze({ parentSessionID, callID, childSessionID });
}

export function completionIdentity(sessionID: string, messageID: string, partID?: string): CompletionIdentity {
  return Object.freeze(partID === undefined ? { sessionID, messageID } : { sessionID, messageID, partID });
}

export function modelIdentity(providerID: string, modelID: string): ModelIdentity {
  return Object.freeze({ providerID, modelID });
}

export type ReplayDisposition = "first" | "exact-replay" | "conflict";
export type AllowDeny =
  | Readonly<{ decision: "allow" }>
  | Readonly<{ decision: "deny"; reason: string }>;
export type ModelAvailability = Readonly<{ available: boolean; identity: ModelIdentity }>;

export interface ToolPort {
  invoke(identity: ToolIdentity, payload: string): Promise<AllowDeny>;
}
export interface SessionPort {
  identity(sessionID: string): Promise<SessionIdentity | undefined>;
  complete(identity: CompletionIdentity, payload: string): Promise<ReplayDisposition>;
}
export interface WorkerPort {
  complete(identity: WorkerIdentity, payload: string): Promise<ReplayDisposition>;
}
export interface ContinuationPort {
  resume(sessionID: string, parentSessionID?: string): Promise<AllowDeny>;
}
export interface ModelPort {
  inspect(identity: ModelIdentity): Promise<ModelAvailability>;
}

export interface HostCapabilityDeclaration {
  readonly version: typeof HOST_CONFORMANCE_VERSION;
  readonly tools: readonly string[];
  readonly ports: Readonly<Record<"tool" | "session" | "worker" | "continuation" | "model", boolean>>;
  readonly identities: Readonly<Record<"session" | "tool" | "worker" | "completion" | "model", string>>;
  readonly replay: Readonly<Record<"exact" | "conflict", string>>;
  readonly continuation: Readonly<Record<"rootOnly" | "sameRoot", boolean>>;
}

export interface HostConformanceSubject {
  readonly capabilities: HostCapabilityDeclaration;
  readonly tool: ToolPort;
  readonly session: SessionPort;
  readonly worker: WorkerPort;
  readonly continuation: ContinuationPort;
  readonly model: ModelPort;
}

export type HostConformanceSubjectFactory = () => HostConformanceSubject | Promise<HostConformanceSubject>;

export const HOST_CAPABILITIES: HostCapabilityDeclaration = Object.freeze({
  version: HOST_CONFORMANCE_VERSION,
  tools: Object.freeze(["task", "sortie_compact_and_continue"]),
  ports: Object.freeze({ tool: true, session: true, worker: true, continuation: true, model: true }),
  identities: Object.freeze({
    session: "sessionID + optional agent + optional parentID + explicit parentPresent",
    tool: "sessionID + callID",
    worker: "parentSessionID + callID + childSessionID",
    completion: "sessionID + messageID + optional partID",
    model: "providerID + modelID",
  }),
  replay: Object.freeze({ exact: "idempotent", conflict: "denied" }),
  continuation: Object.freeze({ rootOnly: true, sameRoot: true }),
});

export const ALLOW_FIXTURE: Readonly<{ tool: ToolIdentity; payload: string; decision: "allow" }> = Object.freeze({
  tool: toolIdentity("ses_root", "call_allow"),
  payload: "bounded-tool-payload",
  decision: "allow",
});

export const DENY_FIXTURE: Readonly<{ tool: ToolIdentity; payload: string; decision: "deny"; reason: string }> = Object.freeze({
  tool: toolIdentity("ses_child", "call_deny"),
  payload: "unavailable-capability",
  decision: "deny",
  reason: "capability-unavailable",
});

export const COMPLETION_FIXTURE = Object.freeze({
  root: sessionIdentity("ses_root", { agent: "dog-coordinator", parentPresent: false }),
  child: sessionIdentity("ses_child", { agent: "dog-worker", parentID: "ses_root", parentPresent: true }),
  session: Object.freeze({ identity: completionIdentity("ses_root", "msg_1"), payload: "completed" }),
  part: Object.freeze({ identity: completionIdentity("ses_root", "msg_1", "part_1"), payload: "completed-part" }),
  worker: Object.freeze({ identity: workerIdentity("ses_root", "call_1", "ses_child"), payload: "worker-completed" }),
});

export function replayDisposition(previous: string | undefined, next: string): ReplayDisposition {
  if (previous === undefined) return "first";
  return previous === next ? "exact-replay" : "conflict";
}

export function allow(): AllowDeny { return Object.freeze({ decision: "allow" }); }
export function deny(reason: string): AllowDeny { return Object.freeze({ decision: "deny", reason }); }
