#!/usr/bin/env python3
"""Add bounded-memory SHA-256 checksums for every packaged model chunk."""

import hashlib
import json
import sys
from pathlib import Path


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: add_model_part_hashes.py MODEL_DIRECTORY")
    model_dir = Path(sys.argv[1])
    manifest_path = model_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    for variant in manifest.get("variants", {}).values():
        data = variant["data"]
        data["partSha256"] = []
        for part_name in data["parts"]:
            digest = hashlib.sha256()
            with (model_dir / part_name).open("rb") as source:
                while chunk := source.read(1024 * 1024):
                    digest.update(chunk)
            data["partSha256"].append(digest.hexdigest())
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
