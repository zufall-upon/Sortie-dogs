import type { OpenCodeClient, SessionListInput, MessageListInput } from "@opencode/client";

/** V2's plugin context can omit session.list even though the public client exposes it. */
function owningServiceClient(): () => Promise<OpenCodeClient> {
  let pending: Promise<OpenCodeClient> | undefined;
  return async () => {
    const current = pending ??= (async () => {
      const [{ Service }, { OpenCode }] = await Promise.all([import("@opencode/client/service"), import("@opencode/client")]);
      // Discovery is read-only: never start, stop, or replace the user's server. A private server
      // must not silently read the shared server's database, even if both contain the same IDs.
      const endpoint = await Service.discover();
      if (!endpoint) throw new Error("v2-history-owning-service-unavailable");
      const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
      const info = await client.server.info({ signal: AbortSignal.timeout(10_000) });
      if (info.pid !== process.pid) throw new Error("v2-history-owning-service-unavailable");
      return client;
    })();
    return current.catch(error => { if (pending === current) pending = undefined; throw error; });
  };
}

export function owningServiceSessionList(): (input: SessionListInput) => Promise<unknown> {
  const connect = owningServiceClient();
  return async input => {
    const client = await connect();
    return client.session.list(input, { signal: AbortSignal.timeout(10_000) });
  };
}

/** Read-only paginated history for reviews older than V2's bounded session.context window. */
export function owningServiceMessageList(): (input: MessageListInput) => Promise<unknown> {
  const connect = owningServiceClient();
  return async input => (await connect()).message.list(input, { signal: AbortSignal.timeout(10_000) });
}
