# Read-Only Failure Swarm

Failure Swarm is selective diagnosis, not a mandatory recovery chain. It requires
an accepted compiled plan and flight-ledger evidence of a normal-remediation
attempt followed by failed canonical validation. Known causes can use an eligible
direct rescue instead. Confidence scores and voting do not activate a swarm.

The coordinator writes `.opencode/sortie-dogs-failure-swarm.json`, using actual
recorded identities and configured budget values:

```json
{
  "run_id": "run-identity",
  "unit_id": "unit-identity",
  "attempt_id": "failed-normal-remediation-identity",
  "cause": "unknown",
  "source_capsule_id": "sha256:<actual-capsule-hash>",
  "causal_classes": ["configuration", "dependency"],
  "max_lanes": 2,
  "per_lane_budget_charge": {
    "kind": "read_only_diagnosis",
    "recovery_actions": 1,
    "probe_iterations": 0,
    "model_attempts": 1
  },
  "timeout_ms": 60000,
  "ledger_path": ".sortie-dogs/flight.json"
}
```

These example values are not an instruction to invent a run or its evidence.
Use the existing `RunFlightLedger` API to record observed execution. The standard
compiled plan and Luna DAG files must match the recorded plan. Capsules default
to `.sortie-dogs/evidence-capsules`; a different `capsule_directory` must remain
inside project `.sortie-dogs`. An optional `source_root` must be the project root
or an owned worktree for the same run/unit. Source references are exact files
inside the unit's declared read/write scope. Finite time/cost limits also require
`per_lane_resource_budget` with `time_ms` and `cost_usd`.

`sortie_prepare_failure_swarm` returns immutable ready descriptors. Dispatch each
through the existing Task tool as `dog-luna-worker`, with one JSON
`failure_swarm_descriptor` line. The plugin supplies the read-only handoff and
capsule input. Only exact source-manifest Read calls are permitted. Shell, writes,
other agents, network tools, write-gate binding, and repair selection are denied
to these children. No diagnostic worktree or writer lease is allocated.

Each lane returns only `causal_class`, `verdict` (`supported`, `excluded`, or
`unknown`), and `validation_fingerprints` from the input capsule. The coordinator
validates references and freshness, constructs a bounded evidence capsule, and
records it after the shared child lifecycle confirms termination. Raw output,
confidence scores, and arbitrary metadata are not stored as findings.

Repeat prepare to inspect accepted findings; dispatched diagnoses are not
reissued. `sortie_select_failure_diagnosis` is coordinator-only and accepts one
`selection_json` with `diagnosis_id`, `capsule_id`, `recovery_kind`, `proposal`, and
`budget_request`. Its returned immutable contract retains the original unit's
scope, acceptance, validation, candidate, and plan binding. Selection does not
spend the repair budget twice: normal dispatch records `attempt.started` with the
returned `remediation_contract_id` and rechecks the shared budget. That contract
can start only one repair. Writer, validation, review, and CAS gates remain
mandatory; selection is not execution or promotion.

All diagnostic lanes consume the same cumulative count and time/cost budget used
by normal remediation, probes, and rescue. Concurrent selection is single-winner.
After all lanes close without a supported finding, there is no swarm-authorized
repair; an independently eligible model rescue remains possible under its own
policy and the same budget. No recursive swarm is required or permitted for the
same failed attempt.

Fault fixtures compare direct repair with selective diagnosis on matching
source/validator inputs. They verify operations and accounting, not real-model
quality or billed-token savings. Actual model usage remains unknown when the host
does not supply it. Full validation and release remain separate final gates.
