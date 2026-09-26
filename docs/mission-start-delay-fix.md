# Mission start-delay recovery (2026-09-26)

## Observed failure

The audited Desktop mission accepted its request at 20:13 JST. At 20:19 it launched four
inference slots, but all 23 instances exited before inference with `Model unavailable:
openai/gpt-6-sol`: zero provider requests and zero patch bytes. The next Worker spent
about 45 minutes repairing provider setup, then lost its handoff/manifest location after
two compactions and reported no edits despite successful earlier file changes.

The runner came from an old bench branch missing already integrated credential and route
fixes (#56, #76). Its package had the released version number but different bytes:

- Published v0.12.13: `137527971b4ca0bb6380751dd9d2f36601b0062571741016ba5045ac54a619ee`
- Selected development candidate: `02ee536fb4fd8234f41a2810789ad69e7034b996d588d541a6f1a41e0775d05c`

Mission state recorded the failed units, while the root's running native Task had empty
metadata. A separate real-V2 diagnostic proved that the progress callback can run but
native Task completion replaces its custom metadata. The exact cause of the original
running Task's empty metadata was not established by that diagnostic.

## Changes

- Reconstruct the running Worker's assignment from durable operator state in both normal
  model context and compaction context. Include its exact handoff, manifest, objective,
  scopes and validation. Require inspection of actual diffs/outputs before replay or an
  empty-work claim. The context grants no completion/acceptance proof.
- Expose control paths and validation in mission status, which Workers already can read.
- Retain progress when native Task completion replaces metadata. While the Coordinator
  Task is active, read local durable mission/unit state once per second and send only
  changed display snapshots. Each read uses a fresh operator snapshot, avoiding its
  write-owner cache. This covers progress from another/reloaded plugin instance; it
  does not enqueue synthetic prompts or model requests.
- Generate a published-release manifest from the exact release receipt and adjacent
  package, retaining public dataset rows. Record receipt/package hashes, release commit,
  runner checkout/commit and actual runner hashes in a sidecar. This prevents selecting
  a same-version development archive. The runbook starts runner work from current main
  and preserves a busy branch's changes in its existing worktree.

## Reproduction

```bash
npm run build
node --experimental-strip-types --import ./test/setup.ts --test \
  test/mission-operation-lifecycle.test.ts test/operator-mission.test.ts \
  test/v2-plugin.test.ts test/swebench-lite-runner.test.ts
npm run test:full
node scripts/mission-context-probe.mjs <fixed-candidate.tgz> <fresh-output-root>
```

The real-V2 probe dispatches Coordinator → Luna Fast/max Worker from an installed
package. Immediately after the first edit it admits a native HTTP compaction control
and supplies an intentionally minimal summary, then observes the same Worker's normal
context, validation and final receipt. It also records actual native Task progress and
completion metadata. This exercises loss of task details at a real compaction boundary;
it is not an assertion that a long campaign naturally reproduces the same summary.

Local raw evidence lives under `_testenv/audits/2026-09-26-start-delay/` and
`_testenv/mission-context-candidate/`. Fixed packages, hashes, observations, costs and
ledgers are retained; generated inactive plugin installations are removed after probes.
