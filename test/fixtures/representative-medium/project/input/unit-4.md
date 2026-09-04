# Unit 4: event reduction

Create `output/unit-4.mjs` and export `reduceEvents(events)`.

Events have a non-empty string `id` and type `start`, `succeed`, or `fail`.

Requirements:

- Process events in order from an empty state.
- `start` adds an inactive ID and increments `started`.
- `succeed` or `fail` removes an active ID and increments the matching counter.
- Reject duplicate starts, terminal events without an active start, unknown event types, and malformed IDs.
- Return `{ started, succeeded, failed, active }`.
- Sort the final `active` ID array lexically.
- Do not mutate the event list.

Acceptance command: `node --test test/unit-4.test.mjs`.
