import argparse
import json
from pathlib import Path

from datasets import load_dataset


DATASET_ID = "princeton-nlp/SWE-bench_Lite"
DATASET_REVISION = "6ec7bb89b9342f664a54a6e0a6ea6501d3437cc2"
PUBLIC_FIELDS = (
    "instance_id",
    "repo",
    "base_commit",
    "problem_statement",
    "version",
    "environment_setup_commit",
)


parser = argparse.ArgumentParser()
parser.add_argument("--split", required=True, choices=("dev", "test"))
parser.add_argument("--package-tgz", required=True)
parser.add_argument("--sha256", required=True)
parser.add_argument("--version", required=True)
parser.add_argument("--runtime-marker", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--instance-id", action="append", default=[])
args = parser.parse_args()

dataset = load_dataset(DATASET_ID, revision=DATASET_REVISION, split=args.split)
selected = set(args.instance_id)
rows = []
for source in dataset:
    if selected and source["instance_id"] not in selected:
        continue
    rows.append({field: source[field] for field in PUBLIC_FIELDS if source.get(field) is not None})

found = {row["instance_id"] for row in rows}
missing = selected - found
if missing:
    raise SystemExit(f"unknown instance IDs: {', '.join(sorted(missing))}")
if not rows:
    raise SystemExit("manifest must contain at least one instance")

manifest = {
    "schema_version": 1,
    "dataset": {"id": DATASET_ID, "revision": DATASET_REVISION, "split": args.split},
    "candidate": {
        "package_tgz": args.package_tgz,
        "sha256": args.sha256,
        "version": args.version,
        "runtime_marker": args.runtime_marker,
        "profile": "v010",
        "agent": "dog-operator",
    },
    "instances": sorted(rows, key=lambda row: row["instance_id"]),
}
output = Path(args.output)
output.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(output)
