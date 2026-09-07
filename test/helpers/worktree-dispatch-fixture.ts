import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";

import {
  ParallelDispatchCoordinator,
  ParallelDispatchError,
} from "../../dist/core/worktree-parallel-dispatch.js";
import {
  produceWorktreeCommitArtifact,
  resolveValidationExecutable,
} from "../../dist/core/worktree-commit-artifact.js";
import type {
  ParallelDispatchDescriptor,
  WorktreeParallelContract,
} from "../../src/core/types.ts";
import { observeMethod, registerFixtureRoot } from "./test-performance-observer.ts";

export const gitExecutable = await resolveValidationExecutable("git");
if (gitExecutable === null) throw new Error("Git executable is required by the worktree integration fixtures");
export const gitDiffCheck = { executable: gitExecutable, args: ["diff", "--check"] } as const;

export function run(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(gitExecutable, args, { cwd, shell: false, windowsHide: true, timeout: 30_000, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error === null) resolvePromise(stdout);
      else reject(new Error(`git failed: ${stderr}`));
    });
  });
}

export function openParallelCoordinator(repositoryRoot: string): Promise<ParallelDispatchCoordinator> {
  return ParallelDispatchCoordinator.open({ repositoryRoot, gitPath: gitExecutable });
}

export function commit(cwd: string, ...args: string[]): Promise<string> {
  return run(cwd, "-c", "user.name=Sortie Test", "-c", "user.email=sortie@example.invalid", "commit", ...args);
}

export async function fixture(name: string): Promise<{ root: string; repository: string; sha: string }> {
  const root = await mkdtemp(join(process.cwd(), "_testenv", `sortie-dispatch-${name}-`));
  registerFixtureRoot(root);
  const repository = join(root, "repository");
  await mkdir(repository);
  await Promise.all([
    writeFile(join(repository, "base.txt"), "base\n"),
    writeFile(join(repository, "a.txt"), "base-a\n"),
    writeFile(join(repository, "b.txt"), "base-b\n"),
    writeFile(join(repository, "c.txt"), "base-c\n"),
    writeFile(join(repository, "d.txt"), "base-d\n"),
    writeFile(join(repository, "e.txt"), "base-e\n"),
  ]);
  await run(repository, "init", "-q", "-b", "main");
  await run(repository, "add", "base.txt", "a.txt", "b.txt", "c.txt", "d.txt", "e.txt");
  await commit(repository, "-q", "-m", "base");
  return { root, repository, sha: (await run(repository, "rev-parse", "HEAD")).trim() };
}

export function contract(sha: string, dependencies: readonly (readonly string[])[] = [[], ["a"], []]): WorktreeParallelContract {
  const ids = ["a", "b", "c", "d", "e"].slice(0, dependencies.length);
  return {
    version: "0.1.0",
    mode: "parallel",
    max_workers: Math.min(5, ids.length),
    tasks: ids.map((id, index) => ({
      task_id: id,
      worktree: `dispatch-${id}`,
      branch: `sortie/dispatch-${id}`,
      base_sha: sha,
      depends_on: [...dependencies[index]!],
      scope: { read: ["base.txt"], write: [`${id}.txt`] },
    })),
    artifacts: [],
    failure: null,
    baseline_metrics: null,
  };
}

export function fabricUnit(id: string, order: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    unit_id: id,
    acceptance_items: [`own ${id}`],
    scope_read: ["base.txt"],
    scope_write: [`${id}.txt`],
    depends_on: [],
    validation: { level: "targeted", command: [gitExecutable, "diff", "--check"] },
    shared_path_keys: [],
    exclusive_resources: [],
    scheduler_order: order,
    ...overrides,
  };
}

export function fabricContract(sha: string, units: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    version: "0.8.0",
    provenance: {
      source: "dog-coordinator",
      acceptance_fingerprint: "b".repeat(64),
      target_branch: "main",
      target_sha: sha,
    },
    acceptance_items: units.flatMap((unit) => unit.acceptance_items as string[]),
    effects: [],
    shared_paths: [],
    units,
  };
}

export async function errorCode(operation: Promise<unknown>, code: ParallelDispatchError["code"]): Promise<void> {
  const error = await operation.then(() => undefined, (candidate: unknown) => candidate);
  if (!(error instanceof ParallelDispatchError) || error.code !== code) {
    throw error ?? new Error(`Expected ParallelDispatchError ${code}`);
  }
}

export async function acceptAndComplete(
  coordinator: ParallelDispatchCoordinator,
  descriptor: ParallelDispatchDescriptor,
  callID: string,
  childSessionID: string,
) {
  await writeFile(join(descriptor.managed_path, `${descriptor.task_id}.txt`), `${descriptor.task_id}\n`);
  const artifact = await produceWorktreeCommitArtifact({
    descriptor,
    managed_path: descriptor.managed_path,
    validation: gitDiffCheck,
  });
  await coordinator.acceptArtifact("root", callID, childSessionID, descriptor, artifact);
  return {
    artifact,
    snapshot: await coordinator.completeCall("root", callID, childSessionID, "completed", {
      run_id: descriptor.run_id,
      dispatch_id: descriptor.dispatch_id,
    }),
  };
}

const maxParallelArtifactProducers = 4;

export async function acceptAndCompleteMany(
  coordinator: ParallelDispatchCoordinator,
  entries: readonly {
    descriptor: ParallelDispatchDescriptor;
    callID: string;
    childSessionID: string;
  }[],
) {
  await Promise.all(entries.map(async ({ descriptor }) =>
    await writeFile(join(descriptor.managed_path, `${descriptor.task_id}.txt`), `${descriptor.task_id}\n`)));

  type Artifact = Awaited<ReturnType<typeof produceWorktreeCommitArtifact>>;
  const artifacts = new Array<Artifact>(entries.length);
  let nextIndex = 0;
  let producerFailed = false;
  let producerError: unknown;
  const producerCount = Math.min(maxParallelArtifactProducers, availableParallelism(), entries.length);
  await Promise.all(Array.from({ length: producerCount }, async () => {
    while (!producerFailed) {
      const index = nextIndex++;
      if (index >= entries.length) return;
      const { descriptor, callID, childSessionID } = entries[index]!;
      try {
        artifacts[index] = await observeMethod("produceWorktreeCommitArtifact", () => produceWorktreeCommitArtifact({
          descriptor,
          managed_path: descriptor.managed_path,
          validation: gitDiffCheck,
        }));
        await observeMethod("fixture.acceptArtifact", () =>
          coordinator.acceptArtifact("root", callID, childSessionID, descriptor, artifacts[index]!));
      } catch (error) {
        if (!producerFailed) producerError = error;
        producerFailed = true;
      }
    }
  }));
  if (producerFailed) throw producerError;

  return Promise.all(entries.map(async ({ descriptor, callID, childSessionID }, index) => ({
      artifact: artifacts[index]!,
      snapshot: await observeMethod("fixture.completeCall", () => coordinator.completeCall("root", callID, childSessionID, "completed", {
        run_id: descriptor.run_id,
        dispatch_id: descriptor.dispatch_id,
      })),
    })));
}
