# v0.12.14 — durable Worker context and mission progress

- Restore the running Worker's handoff, manifest, scope and validation in normal model context
  and at compaction boundaries. Saved assignments are not acceptance evidence.
- Expose control paths in mission status, retain native Task progress at completion, and refresh
  running progress from durable state across plugin instances without additional model requests.
- Select published benchmark archives from their release receipt rather than matching version
  numbers. Record package and runner provenance separately and reuse current-main runner fixes.

See [the observed start-delay failure and reproduction](mission-start-delay-fix.md).
This release does not claim completion or official scoring of the existing 23-instance campaign.
