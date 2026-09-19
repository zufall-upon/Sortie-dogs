import assert from "node:assert/strict";
import test from "node:test";
import { previewModelCatalog } from "../dist/plugin/profiled.js";
import { BUILT_IN_MODEL_CATALOG } from "../dist/plugin/model-routing.js";

const declares = (catalog, model, variant) =>
  catalog.some(entry => entry.model === model && (entry.variants ?? []).includes(variant));

test("every shipped preview route is declared, so no role resolves against an absent catalog entry", () => {
  const catalog = previewModelCatalog();
  const routes = [
    { model: "openai/gpt-5.6-luna-fast", variant: "max" },
    { model: "openai/gpt-5.6-luna-fast", variant: "xhigh" },
    { model: "openai/gpt-5.6-terra", variant: "xhigh" },
  ];
  for (const route of routes) {
    assert.ok(declares(catalog, route.model, route.variant),
      `preview route ${route.model}/${route.variant} is undeclared`);
  }
  assert.equal(new Set(catalog.map(entry => entry.model)).size, catalog.length);
});

test("a route naming a model the built-in catalog never listed is declared instead of dropped", () => {
  const base = BUILT_IN_MODEL_CATALOG.global ?? [];
  const unlisted = { model: "openai/gpt-5.6-luna-fast", variant: "max" };
  assert.ok(!base.some(entry => entry.model === unlisted.model), "fixture model must start unlisted");
  const catalog = previewModelCatalog([...base.map(entry => ({ model: entry.model, variant: entry.variants[0] })), unlisted]);
  assert.ok(declares(catalog, unlisted.model, unlisted.variant));
  assert.equal(catalog.length, base.length + 1);
});

test("declaring preview variants preserves the built-in variants of a listed model", () => {
  const base = BUILT_IN_MODEL_CATALOG.global ?? [];
  const catalog = previewModelCatalog([{ model: base[0].model, variant: "invented-variant" }], base);
  const entry = catalog.find(item => item.model === base[0].model);
  for (const variant of base[0].variants ?? []) assert.ok(entry.variants.includes(variant));
  assert.ok(entry.variants.includes("invented-variant"));
  assert.equal(catalog.length, base.length);
});
