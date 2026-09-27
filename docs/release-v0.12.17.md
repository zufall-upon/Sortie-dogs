# v0.12.17 — Focused review, cost shares, and Worker path recovery

- Accept display-only Coordinator Task labels when the opaque mission reference and agent are unchanged. Preserve autonomous correction within the original mission.
- Show per-model **estimated cost shares**, not token shares, in return reports. Keep token/cache context and distinguish priced portions from missing usage or unknown prices.
- Show committed as well as uncommitted changes within declared scopes to the independent Reviewer, with bounded per-file excerpts and explicit truncation.
- Use project-relative generated Worker control references in V2 prompts and recover their canonical paths after restart, without changing externally declared absolute outputs.
- Recover benchmark runner startup/timeout handling, bound stalled reads and no-progress instances at recorded checkpoints, and preserve unknown budget remainder. Include the read-only dev23 score diagnosis and recorded historical results.

The benchmark and score records describe earlier pinned v0.12.15/v0.12.16 candidates, not a v0.12.17 result. No 23-case inference, official scoring or comparison is part of this release; existing campaign packages and conditions remain unchanged.
