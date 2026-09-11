import assert from "node:assert/strict";
import test from "node:test";
import { expandGoalDeclaration } from "../dist/core/goal-declaration-format.js";

test("shared defaults preserve per-criterion overrides across prefixed and compact keys", () => {
  const result = expandGoalDeclaration({ delivery_intent: "repair", defaults: {
    goal_target: "shared", validation_command: "node test.mjs", source: "fixed source" },
    criteria: [{ target: "first", criterion_id: "a" }, { goal_target: "second", criterion_id: "b" }] });
  assert.match(result, /goal_target: first/u);
  assert.match(result, /goal_target: second/u);
  assert.doesNotMatch(result, /goal_target: shared/u);
  assert.equal((result.match(/goal_validation_command: node test.mjs/gu) ?? []).length, 2);
});

test("goal identity excludes budget and is independent of JSON property order", () => {
  const first = expandGoalDeclaration({ delivery_intent: "implementation", goal_budget_units: 2,
    defaults: { source: "s", candidate: "c" }, criteria: [{ target: "required" }] });
  const revised = expandGoalDeclaration({ criteria: [{ target: "required" }], defaults: { candidate: "c", source: "s" },
    goal_budget_units: 8, delivery_intent: "implementation" });
  assert.equal(first.split("\n")[0], revised.split("\n")[0]);
  assert.equal(first.match(/goal_criterion_id: (.+)/u)?.[1], revised.match(/goal_criterion_id: (.+)/u)?.[1]);
  assert.doesNotMatch(first, /goal_oracle_coverage|goal_proof_scope/u, "missing semantic evidence is not guessed");
});
