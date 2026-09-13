# Release recovery fixture

Tracked, deterministic contract fixture for release preflight. `driver.mjs` validates its three
positional inputs and emits a typed receipt; it does not run OpenCode, use a real session ledger, or
claim model-driven continuation proof. A recovery-related release must provide a reviewed driver
that supplies that runtime proof separately.
