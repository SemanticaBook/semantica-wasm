from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from huggingface_hub import snapshot_download


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Prepare the official multilingual Laya checkpoint for ONNX export."
    )
    parser.add_argument("--out", type=Path, default=Path("build-multilingual"))
    args = parser.parse_args()

    destination = args.out.resolve() / "en"
    source_root = args.out.resolve() / "checkpoint"
    source_root.mkdir(parents=True, exist_ok=True)
    source = source_root / "multilingual"
    snapshot_download(
        repo_id="convaiinnovations/laya",
        allow_patterns=[
            "multilingual/model.safetensors",
            "multilingual/rl_agent_config.json",
            "multilingual/tokenizer/**",
            "multilingual/encoder/**",
        ],
        local_dir=str(source_root),
    )
    if not (source / "model.safetensors").is_file():
        raise FileNotFoundError(
            "The multilingual model.safetensors file was not downloaded."
        )
    if not (source / "rl_agent_config.json").is_file():
        raise FileNotFoundError("The multilingual Laya config is missing.")

    shutil.rmtree(destination, ignore_errors=True)
    shutil.copytree(
        source,
        destination,
        ignore=shutil.ignore_patterns(".cache", "*.lock"),
    )
    config_path = destination / "rl_agent_config.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    config["model_name"] = "rl-agent"
    config_path.write_text(
        json.dumps(config, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"Prepared multilingual checkpoint at {destination}")


if __name__ == "__main__":
    main()
