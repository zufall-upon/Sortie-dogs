import nodeTest from "node:test";

import { ParallelDispatchCoordinator } from "../../dist/core/worktree-parallel-dispatch.js";
import { WorktreeLifecycle } from "../../dist/core/worktree-lifecycle.js";
import { observeMethod } from "./test-performance-observer.ts";
import { worktreeDispatchCases } from "../integration/worktree-parallel-dispatch.test.ts?normal";

const caseName = "a six-unit fabric advances only at the barrier into a fresh exact-base worktree";

function instrument(prototype: object, names: readonly string[]): void {
  for (const name of names) {
    const record = prototype as Record<string, (...args: unknown[]) => unknown>;
    const original = record[name];
    if (typeof original !== "function") continue;
    record[name] = function (...args: unknown[]) {
      return observeMethod(name, () => original.apply(this, args));
    };
  }
}

instrument(ParallelDispatchCoordinator.prototype, [
  "prepareFabric", "acceptArtifact", "completeCall", "integrateFabricWave",
  "integrateFabricWaveAndValidate", "validateFabricCandidate", "acceptFabricCandidate",
  "buildFabricCandidate", "assertFabricCandidate", "recoverFabricTransition",
]);
instrument(WorktreeLifecycle.prototype, ["createManyAtBase", "cleanup"]);

const selected = worktreeDispatchCases("integration").find(({ name }) => name === caseName);
if (selected === undefined) throw new Error(`Missing actual integration case: ${caseName}`);
nodeTest(selected.name, selected.options ?? {}, async (context) => {
  const observedContext = new Proxy(context, {
    get(target, property, receiver) {
      if (property !== "test") return Reflect.get(target, property, receiver);
      return (...args: unknown[]) => {
        const callbackIndex = args.length - 1;
        const callback = args[callbackIndex];
        if (typeof callback === "function") {
          const subtestName = String(args[0]);
          args[callbackIndex] = (...callbackArgs: unknown[]) =>
            observeMethod(`subtest:${subtestName}`, () => callback(...callbackArgs));
        }
        return Reflect.apply(target.test, target, args);
      };
    },
  });
  await observeMethod(`case:${caseName}`, () => selected.run(observedContext));
});
