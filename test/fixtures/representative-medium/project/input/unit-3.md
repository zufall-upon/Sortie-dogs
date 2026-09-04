# Unit 3: weighted batching

Create `output/unit-3.mjs` and export `weightedBatches(items, maxWeight)`.

Each item has a non-empty string `id` and a positive finite numeric `weight`.

Requirements:

- Preserve input order.
- Greedily append an item to the current batch when the total remains at or below `maxWeight`.
- Start a new batch when the next item would exceed `maxWeight`.
- Return arrays containing the original item objects, not clones.
- Return an empty array for empty input.
- Reject duplicate IDs, malformed items, invalid `maxWeight`, and any item heavier than `maxWeight`.
- Do not mutate the input array or its items.

Acceptance command: `node --test test/unit-3.test.mjs`.
