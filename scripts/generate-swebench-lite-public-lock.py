import hashlib
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


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


dataset = load_dataset(DATASET_ID, revision=DATASET_REVISION)
splits = {}
for split in ("dev", "test"):
    rows = {}
    for source in dataset[split]:
        public = {field: source[field] for field in PUBLIC_FIELDS if source.get(field) is not None}
        rows[source["instance_id"]] = hashlib.sha256(canonical_json(public).encode()).hexdigest()
    splits[split] = {"row_count": len(rows), "rows": dict(sorted(rows.items()))}

lock = {
    "schema_version": 1,
    "dataset": {"id": DATASET_ID, "revision": DATASET_REVISION},
    "splits": splits,
}
output = Path(__file__).with_name("swebench-lite-public-lock.json")
output.write_text(json.dumps(lock, indent=2, sort_keys=True) + "\n", encoding="utf-8")
print(output)
