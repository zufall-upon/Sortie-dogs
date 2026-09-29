#!/usr/bin/env python3
"""Audit the frozen Lite-300 evidence; stage original session traces only after completion.

No benchmark runs, Docker operations, network requests, or public uploads are made.
The staged traces omit encrypted provider reasoning and credential tables; review
tool inputs/outputs for sensitive material before publishing them.
"""

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
import sqlite3
from pathlib import Path


REPO = Path(__file__).resolve().parent.parent
ROOT = REPO / "_testenv/swebench-test300-v01224-20260928"
CAMPAIGN = ROOT / "campaign"
RUN_ID = "sortie-v01224-test300-rolling-20260928"
MODEL = "sortie-dogs@0.12.24+3e4968ae8c72"
OFFICIAL = CAMPAIGN / "official/logs/run_evaluation" / RUN_ID / MODEL
EXPECTED_PACKAGE = "3e4968ae8c72768347d8d37411eb7ad2e9213110e126b835de57a7a4e5b27823"


def require(ok, message):
    if not ok:
        raise ValueError(message)


def read(path):
    return json.loads(path.read_text())


def sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def report(path, expected_ids, expected_hash):
    require(path.is_file() and sha(path) == expected_hash, f"report hash mismatch: {path}")
    data = read(path)
    require(data["total_instances"] == len(expected_ids) and
            data["submitted_instances"] == len(expected_ids) and
            set(data["submitted_ids"]) == set(expected_ids) and
            data["error_instances"] == data["infra_failure_instances"] == 0,
            f"official report incomplete: {path}")
    return data


def single_attempts(path, expected_ids):
    state = read(path)
    require(state["status"] == "completed" and
            [entry["instance_id"] for entry in state["instances"]] == expected_ids and
            all(entry["attempt"] == 1 and entry["status"] not in ("running", "pending")
                for entry in state["instances"]) and
            state["policy"]["attempts_per_instance"] == 1 and state["policy"]["retry_count"] == 0,
            f"not a terminal single-attempt run: {path}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage-trajs", action="store_true", help="stage traces only after the final 300-case report")
    args = parser.parse_args()

    manifest = read(ROOT / "manifest-test-300.json")
    plan = read(ROOT / "full300-plan.json")
    ids = [row["instance_id"] for row in manifest["instances"]]
    require(len(ids) == len(set(ids)) == 300, "manifest is not 300 unique instances")
    require(sha(REPO / "_testenv/releases/0.12.24/sortie-dogs-0.12.24.tgz") == EXPECTED_PACKAGE,
            "fixed candidate archive changed")
    state = read(CAMPAIGN / "campaign-state.json")
    require(state["package_sha256"] == EXPECTED_PACKAGE and
            state["plan_sha256"] == sha(ROOT / "full300-plan.json") and
            plan["manifest_sha256"] == sha(ROOT / "manifest-test-300.json"),
            "campaign inputs changed")

    smoke = read(ROOT / "smoke-result.json")
    pilot = read(ROOT / "pilot4-scoring/scoring-summary.json")
    smoke_id = smoke["instance_id"]
    pilot_ids = [entry["instance_id"] for entry in pilot["inference_statuses"]]
    require(smoke_id == plan["prior_smoke"]["instance_id"] and
            pilot_ids == plan["prior_pilot"]["instance_ids"] and
            sha(ROOT / "smoke-run/predictions.jsonl") == plan["prior_smoke"]["prediction_sha256"] and
            sha(ROOT / "pilot4-scoring/predictions.jsonl") == plan["prior_pilot"]["predictions_sha256"],
            "prior five predictions changed")
    single_attempts(ROOT / "smoke-run/supervisor-state.json", [smoke_id])
    single_attempts(ROOT / "pilot4-run/supervisor-state.json", pilot_ids)
    report(ROOT / smoke["official_report"], [smoke_id], smoke["official_report_sha256"])
    report(ROOT / "pilot4-scoring" / pilot["report"], pilot_ids, pilot["report_sha256"])
    sources = {smoke_id: ROOT / "smoke-run/children"}
    sources.update({iid: ROOT / "pilot4-run/children" for iid in pilot_ids})
    predictions = {smoke_id: ROOT / "smoke-run/predictions.jsonl"}
    predictions.update({iid: ROOT / "pilot4-scoring/predictions.jsonl" for iid in pilot_ids})
    resolved = set(read(ROOT / smoke["official_report"])["resolved_ids"])
    resolved.update(read(ROOT / "pilot4-scoring" / pilot["report"])["resolved_ids"])
    empty = set()

    for batch_dir in sorted((CAMPAIGN / "batches").iterdir()):
        receipt_path = batch_dir / "receipt.json"
        if not receipt_path.is_file():
            continue
        receipt = read(receipt_path)
        batch_ids = receipt["ids"]
        single_attempts(batch_dir / "inference/supervisor-state.json", batch_ids)
        path = batch_dir / "scoring" / f"{MODEL}.{RUN_ID}.json"
        result = report(path, batch_ids, receipt["report_sha256"])
        prediction = batch_dir / "inference/predictions.jsonl"
        require(sha(prediction) == receipt["predictions_sha256"], f"prediction hash mismatch: {batch_dir}")
        require(result["resolved_instances"] == receipt["resolved"] and
                result["completed_instances"] == receipt["completed"], f"receipt mismatch: {batch_dir}")
        for iid in batch_ids:
            require(iid not in sources, f"duplicate inference receipt: {iid}")
            sources[iid] = batch_dir / "inference/children"
            predictions[iid] = prediction
        resolved.update(result["resolved_ids"])
        empty.update(result["empty_patch_ids"])

    require(set(sources) <= set(ids) and resolved <= set(sources), "coverage or resolved IDs inconsistent")
    replay_paths = {}
    databases = {}
    observed_models = Counter()
    no_logs = []
    for iid, children in sorted(sources.items()):
        matches = [entry for entry in children.iterdir() if entry.is_dir() and entry.name.endswith("-" + iid)]
        require(len(matches) == 1, f"missing or duplicate inference child: {iid}")
        child = matches[0]
        replay_dir = child / "replay/instances"
        replays = list(replay_dir.glob(f"*-{iid}.json"))
        require(len(replays) == 1, f"missing or duplicate inference-time replay: {iid}")
        replay = read(replays[0])
        require(replay["public_input"]["instance"]["instance_id"] == iid and
                replay["candidate_sha256"] == EXPECTED_PACKAGE, f"replay identity mismatch: {iid}")
        require((child / "usage/opencode.db").is_file(), f"original session snapshot missing: {iid}")
        replay_paths[iid] = replays[0]
        databases[iid] = child / "usage/opencode.db"
        uri = f"file:{databases[iid].resolve()}?mode=ro&immutable=1"
        with sqlite3.connect(uri, uri=True) as conn:
            for agent, model in conn.execute("SELECT agent, model FROM session_v2 WHERE model IS NOT NULL"):
                route = json.loads(model)
                observed_models[f"{agent}: {route['providerID']}/{route['id']}#{route['variant']}"] += 1
        inst_logs = OFFICIAL / iid
        if iid in empty:
            require(not (inst_logs / "test_output.txt").exists(), f"empty patch unexpectedly has test output: {iid}")
        else:
            for name in ("patch.diff", "test_output.txt", "report.json"):
                require((inst_logs / name).is_file(), f"official evidence missing: {iid}/{name}")
        if not (inst_logs / "test_output.txt").is_file():
            no_logs.append(iid)

    final_path = CAMPAIGN / "final-summary.json"
    complete = final_path.is_file()
    if complete:
        summary = read(final_path)
        require(state["status"] == "completed" and set(sources) == set(ids) and
                summary["total"] == summary["submitted"] == 300 and
                summary["resolved"] == len(resolved) and summary["empty_patch"] == len(empty),
                "final report disagrees with instance-level receipts")
        require(sha(CAMPAIGN / "predictions-300.jsonl") == summary["predictions_sha256"] and
                sha(CAMPAIGN / f"{MODEL}.{RUN_ID}.json") == summary["report_sha256"],
                "frozen final prediction/report hash mismatch")
        frozen = [json.loads(line)["instance_id"] for line in
                  (CAMPAIGN / "predictions-300.jsonl").read_text().splitlines() if line.strip()]
        require(frozen == ids, "final predictions do not match ordered 300-case manifest")

    result = {"at": datetime.now(timezone.utc).isoformat(),
              "candidate_sha256": EXPECTED_PACKAGE, "run_id": RUN_ID,
              "scored": len(sources), "resolved": len(resolved), "empty_patch": len(empty),
              "original_replays": len(replay_paths), "original_session_snapshots": len(databases),
              "without_test_output": len(no_logs), "observed_session_models": dict(sorted(observed_models.items())),
              "complete": complete,
              "final_summary_sha256": sha(final_path) if complete else None}
    if args.stage_trajs:
        require(complete, "do not stage a partial submission; wait for the final official report")
        staged = CAMPAIGN / "submission-prep"
        tmp = staged / f"trajs.tmp.{os.getpid()}"
        dest = staged / "trajs"
        require(not tmp.exists() and not dest.exists(), "trace staging already exists; inspect rather than overwrite")
        tmp.mkdir(parents=True)
        for iid in ids:
            db = databases[iid]
            uri = f"file:{db.resolve()}?mode=ro&immutable=1"
            with sqlite3.connect(uri, uri=True) as conn:
                sessions = conn.execute("SELECT id, parent_id, agent, model, time_created FROM session_v2 ORDER BY time_created, id").fetchall()
                require(sessions, f"session snapshot has no sessions: {iid}")
                with (tmp / f"{iid}.jsonl").open("x", encoding="utf-8") as out:
                    header = {"type": "source", "instance_id": iid, "origin": "inference-time OpenCode session snapshot",
                              "snapshot_sha256": sha(db), "replay_sha256": sha(replay_paths[iid]),
                              "note": "Visible text and tool events only; provider-encrypted reasoning is not disclosed."}
                    out.write(json.dumps(header, ensure_ascii=False) + "\n")
                    visible = 0
                    for sid, parent, agent, model, created in sessions:
                        out.write(json.dumps({"type": "session", "session_id": sid, "parent_id": parent,
                                              "agent": agent, "model": json.loads(model) if model else None,
                                              "created_at": created}, ensure_ascii=False) + "\n")
                        for kind, seq, data in conn.execute(
                            "SELECT type, seq, data FROM session_message WHERE session_id=? ORDER BY seq", (sid,)
                        ):
                            parsed = json.loads(data)
                            if kind == "user":
                                event = {"type": "message", "session_id": sid, "seq": seq, "role": kind,
                                         "text": parsed.get("text", "")}
                            elif kind == "assistant":
                                parts = []
                                for part in parsed.get("content", []):
                                    if part.get("type") == "text" and part.get("text"):
                                        parts.append({"type": "text", "text": part["text"]})
                                    elif part.get("type") == "tool":
                                        parts.append({"type": "tool", "name": part.get("name"),
                                                      "state": {k: part.get("state", {}).get(k) for k in
                                                                ("status", "input", "content")}})
                                if not parts:
                                    continue
                                event = {"type": "message", "session_id": sid, "seq": seq, "role": kind,
                                         "parts": parts}
                            else:
                                continue
                            visible += 1
                            out.write(json.dumps(event, ensure_ascii=False) + "\n")
                    require(visible > 0, f"session snapshot has no visible steps: {iid}")
        tmp.rename(dest)
        result["staged_trajs"] = len(ids)
        result["staged_dir"] = str(dest)
        (staged / "audit.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
