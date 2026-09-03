import assert from "node:assert/strict";
import test from "node:test";

import { createLunaFabricScheduler } from "../dist/core/luna-fabric-scheduler.js";
import type { LunaFabricContract, LunaFabricUnit } from "../src/core/luna-fabric-contract.ts";

const base = "a".repeat(40);

function unit(id: string, depends_on: readonly string[] = [], extra: Partial<LunaFabricUnit> = {}): LunaFabricUnit {
  return {
    unit_id: id, acceptance_items: [id], scope_read: [], scope_write: [`${id}.txt`], depends_on,
    validation: { level: "targeted", command: ["node", "-e", "process.exit(0)"] },
    shared_path_keys: [], exclusive_resources: [], scheduler_order: 99, ...extra,
  };
}

function contract(units: readonly LunaFabricUnit[]): LunaFabricContract {
  return { version: "0.8.0", provenance: { source: "dog-coordinator", acceptance_fingerprint: "b".repeat(64),
    target_branch: "main", target_sha: base }, acceptance_items: units.map(({ unit_id }) => unit_id), effects: [],
    shared_paths: [], units };
}

test("schedules bounded barrier waves by remaining depth then unit id", () => {
  const units = [unit("a"), unit("b"), unit("c"), unit("d"), unit("e"), unit("f"), unit("g", ["a"]), unit("h", ["g"])]
    .map((entry, index) => ({ ...entry, scheduler_order: index }));
  const scheduler = createLunaFabricScheduler(contract(units), base);
  const first = scheduler.nextWave()!;
  assert.deepEqual(first.unit_ids, ["a", "b", "c", "d", "e"]);
  assert.equal(scheduler.nextWave()!.number, 1);
  scheduler.advance({ candidate_base: "c".repeat(40), completed_unit_ids: first.unit_ids });
  const second = scheduler.nextWave()!;
  assert.deepEqual(second.unit_ids, ["g", "f"]);
  assert.equal(new Set(second.unit_ids).size, second.unit_ids.length);
});

test("declared shared ownership keeps a stable lane across waves", () => {
  const units = [unit("a", [], { shared_path_keys: ["lane"] }), unit("b", [], { shared_path_keys: ["lane"] }), unit("c")];
  const value = { ...contract(units), shared_paths: [{ key: "lane", path: "a.txt" }] };
  const scheduler = createLunaFabricScheduler(value, base);
  const first = scheduler.nextWave()!;
  assert.deepEqual(first.unit_ids, ["a", "c"]);
  scheduler.advance({ candidate_base: "c".repeat(40), completed_unit_ids: first.unit_ids });
  const second = scheduler.nextWave()!;
  assert.equal(second.lanes.b, first.lanes.a);
});

test("restart preserves an active wave and rejects incomplete advancement", () => {
  const scheduler = createLunaFabricScheduler(contract([unit("a"), unit("b")]), base);
  const wave = scheduler.nextWave()!;
  const restarted = createLunaFabricScheduler(contract([unit("a"), unit("b")]), base, scheduler.snapshot());
  assert.deepEqual(restarted.nextWave(), wave);
  assert.throws(() => restarted.advance({ candidate_base: "c".repeat(40), completed_unit_ids: ["a"] }));
});

test("durable state rejects duplicate identities and out-of-range lanes", () => {
  const value = contract([unit("a"), unit("b")]);
  const scheduler = createLunaFabricScheduler(value, base);
  scheduler.nextWave();
  const snapshot = scheduler.snapshot();
  assert.throws(() => createLunaFabricScheduler(value, base, {
    ...snapshot,
    pending: [...snapshot.pending, "a"],
  }));
  assert.throws(() => createLunaFabricScheduler(value, base, {
    ...snapshot,
    active: { ...snapshot.active!, lanes: { ...snapshot.active!.lanes, a: 5 } },
  }));
});

test("logical lane affinity remains bounded while serial groups reuse idle lanes", () => {
  const units = Array.from({ length: 6 }, (_, index) => unit(`u${index}`, index === 0 ? [] : [`u${index - 1}`], {
    shared_path_keys: [`key${index}`],
  }));
  const value = {
    ...contract(units),
    shared_paths: units.map((_, index) => ({ key: `key${index}`, path: `u${index}.txt` })),
  };
  const scheduler = createLunaFabricScheduler(value, base);
  for (let index = 0; index < units.length; index += 1) {
    const wave = scheduler.nextWave()!;
    assert.deepEqual(wave.unit_ids, [`u${index}`]);
    assert.ok(Object.values(wave.lanes).every((lane) => lane >= 0 && lane < 5));
    scheduler.advance({ candidate_base: `${(index + 1).toString(16)}`.repeat(40), completed_unit_ids: wave.unit_ids });
  }
});
