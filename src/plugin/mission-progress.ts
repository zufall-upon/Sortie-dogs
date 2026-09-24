/** Display-only native Task progress. Never prompts a model or changes execution ownership. */
type Sink = (value: Record<string, unknown>) => Promise<void>;
const sinks = new Map<string, Sink>();
export function bindMissionProgress(root: string, sink: Sink): () => void {
  sinks.set(root, sink);
  return () => { if (sinks.get(root) === sink) sinks.delete(root); };
}
export async function publishMissionProgress(root: string, value: Record<string, unknown>): Promise<void> {
  await sinks.get(root)?.(value).catch(() => undefined);
}
