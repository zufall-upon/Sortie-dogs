import { ScopeLeaseError, ScopeLeaseRegistry } from "../../dist/core/scope-lease-registry.js";

const [root, ownerId, path, ttlValue] = process.argv.slice(2);
const registry = new ScopeLeaseRegistry(root, { ttlMs: Number(ttlValue) });

try {
  const lease = await registry.acquire({ ownerId, scope: { read: [], write: [path] } });
  process.send?.({ status: "held", id: lease.id });
  process.on("message", async (message) => {
    if (message !== "release") return;
    await lease.release();
    process.send?.({ status: "released" });
    process.exit(0);
  });
} catch (error) {
  process.send?.({
    status: "denied",
    code: error instanceof ScopeLeaseError ? error.code : "unexpected",
  });
  process.exit(0);
}
