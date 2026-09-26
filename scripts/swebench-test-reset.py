"""Normalize test-file resets in a frozen evaluator script for diagnostics only.

This runs after inference. It does not read predictions or change test patches.
The generated script is a new scoring condition, not an official score override.
"""

import argparse
import hashlib
import json
import re
import shlex
from pathlib import Path


def normalize_test_resets(script):
    lines = script.splitlines(keepends=True)
    result = []
    resets = []
    heredoc = None
    for number, line in enumerate(lines, 1):
        text = line.rstrip("\r\n")
        if heredoc is not None:
            delimiter, strip_tabs = heredoc
            if (text.lstrip("\t") if strip_tabs else text) == delimiter:
                heredoc = None
            result.append(line)
            continue
        if "<<" in text:
            match = re.search(r"<<(-?)\s*(?:'([^']+)'|\"([^\"]+)\"|([A-Za-z_][A-Za-z0-9_]*))\s*$", text)
            if match is None or "<<" in text[:match.start()]:
                raise ValueError(f"unsupported heredoc at line {number}")
            heredoc = (next(x for x in match.groups()[1:] if x is not None), bool(match.group(1)))
            result.append(line)
            continue
        # Do not mistake a line inside a multiline quoted string or continued
        # command for an executable reset. This helper supports generated,
        # line-oriented evaluators, not arbitrary shell programs.
        words = shlex.split(text, comments=True)
        if not re.match(r"^\s*git\s+checkout(?:\s|$)", text):
            result.append(line)
            continue
        # A bare commit checkout is repository setup, not a test-file reset.
        if len(words) == 3 and re.fullmatch(r"[0-9a-f]{40}", words[2]):
            result.append(line)
            continue
        if len(words) < 4 or not re.fullmatch(r"[0-9a-f]{40}", words[2]):
            raise ValueError(f"unsupported checkout at line {number}")
        base = words[2]
        paths = words[3:]
        if paths[0] == "--":
            paths = paths[1:]
        if not paths:
            raise ValueError(f"missing reset paths at line {number}")
        for path in paths:
            if (path.startswith(("/", "-")) or
                    any(p in ("", ".", "..", ".git") for p in path.split("/")) or
                    re.search(r"[\x00-\x1f\x7f$`;&|<>*?\[\]\\]", path)):
                raise ValueError(f"unsupported reset path at line {number}")
        # Verify the base first so an invalid revision cannot be treated as an
        # absent file and lead to a destructive fallback.
        result.append(f"git rev-parse --verify '{base}^{{commit}}' >/dev/null || exit 1\n")
        for path in paths:
            quoted = shlex.quote(path)
            result.extend([
                f"if git cat-file -e {shlex.quote(base + ':' + path)} 2>/dev/null; then\n",
                f"  git checkout {base} -- {quoted} || exit 1\n",
                "else\n",
                f"  rm -f -- {quoted} || exit 1\n",
                "fi\n",
            ])
        resets.append({"line": number, "base_commit": base, "paths": paths})
    if heredoc is not None:
        raise ValueError("unterminated heredoc")
    if not resets:
        raise ValueError("no supported test-file resets")
    normalized = "".join(result)
    return normalized, {
        "kind": "supplemental-swebench-test-reset",
        "official_score": False,
        "input_sha256": hashlib.sha256(script.encode()).hexdigest(),
        "output_sha256": hashlib.sha256(normalized.encode()).hexdigest(),
        "resets": resets,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    args = parser.parse_args()
    if args.output.resolve() == args.metadata.resolve():
        parser.error("output and metadata must differ")
    if args.output.exists() or args.metadata.exists():
        parser.error("output already exists; use fresh diagnostic paths")
    script, metadata = normalize_test_resets(args.input.read_bytes().decode("utf-8"))
    with args.output.open("x", encoding="utf-8", newline="") as output:
        output.write(script)
    with args.metadata.open("x", encoding="utf-8") as output:
        json.dump(metadata, output, indent=2)
        output.write("\n")
    print(json.dumps(metadata))


if __name__ == "__main__":
    main()
