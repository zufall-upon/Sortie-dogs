# v0.12.0 — Coordinator-owned missions

v0.12.0 restores the v0.10.23 execution foundation and moves routine investigation,
unit planning, dispatch and corrections into Coordinator. The `v010` profile and
tool namespace remain compatible; the v0.11 execution-first runtime is not used.

## Changes

- Operator saves concise requirements and retains user decisions and final acceptance.
  The host preserves the original request automatically.
- Coordinator investigates, dispatches Worker/Scout/Advisor/independent Reviewer,
  extends in-request write scopes and replans without per-unit Operator approval.
- Simple low-risk work keeps the Operator → Worker Fast-lane.
- Host-generated unit contracts and short Worker/Reviewer references remove manual
  copying of manifests, proof hashes and lengthy evidence packets.
- Workers can investigate without registering each diagnostic command; formal
  validation retains observed execution evidence. Unit progress appears on Task.
- Defaults: Operator/Coordinator/Reviewer use Sol/xhigh; Worker/Scout use Luna Fast/max.
  OpenCode V2 explicit model selections remain authoritative.
- Review accepts grouped requirement traces and checks candidate freshness before
  final acceptance. Existing measured 🐾 return reports remain.
- Includes the independent grader-launch correction, V2 usage accounting, and
  cumulative budget/resume protection for optional benchmark campaigns. Unknown
  usage keeps its reservation and is not counted as free.

## Verification scope

The isolated simple-task candidate check reached actual content validation and a
succeeded Operator receipt. Worker started in 20.132 seconds on Luna Fast/max.
This is a single observation, not a matched speed comparison or a general timing guarantee.

Real-task probes located and drove fixes to command normalization, proof labels,
review trace mapping and Reviewer packet handoff. They did not establish complete
real-task success. Further real-task testing is assigned to maintainer dogfooding;
no 23-task campaign or official scoring result is claimed for this release.

Release gates are the fixed-commit package, candidate preflight and full repository
test run, followed by global apply and installed-code/assets verification. Exact
package SHA-256 and release commit are attached to the GitHub Release.

Runtime marker: `0.12.0-coordinator-mission-v1`.
Restart OpenCode completely after installation to load the new runtime.
Registry publication remains a separate manual maintainer step.
