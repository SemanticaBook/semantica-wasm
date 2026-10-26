from __future__ import annotations

import argparse
import re
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("model_dir", type=Path)
    args = parser.parse_args()

    notice_path = args.model_dir / "NOTICE.md"
    notice = notice_path.read_text(encoding="utf-8")
    notice = re.sub(
        r"\n## Semantica multilingual browser build\n.*\Z",
        "",
        notice,
        flags=re.DOTALL,
    )
    notice = notice.replace(
        "- Source: https://huggingface.co/convaiinnovations/laya and https://github.com/NandhaKishorM/laya (PyPI: `laya`)",
        "- Source: [Hugging Face](https://huggingface.co/convaiinnovations/laya), [GitHub](https://github.com/NandhaKishorM/laya), PyPI (`laya`)",
    )
    notice = notice.replace(
        "unofficial browser port of the English Laya checkpoint",
        "unofficial browser port of the multilingual Laya checkpoint",
    )
    notice = notice.replace(
        "The English checkpoint was exported to ONNX.",
        "The multilingual mmBERT-base checkpoint was exported to ONNX.",
    )
    notice = re.sub(
        r"(?ms)^## ModernBERT\s+.*?(?=^## Third-party software shipped with the demo page)",
        "## mmBERT\n\nThis package uses the multilingual Laya checkpoint built on mmBERT-base. "
        "The model and tokenizer are distributed by ConvAI Innovations under Apache-2.0; "
        "see [the multilingual model card](https://huggingface.co/convaiinnovations/laya/tree/main/multilingual).\n\n",
        notice,
    )
    notice = notice.replace(
        "see the model card at https://huggingface.co/convaiinnovations/laya/tree/main/multilingual.",
        "see [the multilingual model card](https://huggingface.co/convaiinnovations/laya/tree/main/multilingual).",
    )
    if "## ModernBERT" in notice:
        raise RuntimeError("Could not replace the inherited English ModernBERT notice")
    notice += (
        "\n## Semantica multilingual browser build\n\n"
        "This package was built from the multilingual subdirectory of "
        "`convaiinnovations/laya` (mmBERT-base, 100+ languages). It is not "
        "the English checkpoint described in the original layaForWeb notice. "
        "Its weights were exported and quantized for ONNX Runtime Web. The "
        "JavaScript integration in Semantica is an independent adaptation; "
        "the original layaForWeb code, license, notices, model license and "
        "third-party notices are retained in this package.\n"
    )
    notice = re.sub(r"\n{3,}", "\n\n", notice)
    notice_path.write_text(notice, encoding="utf-8")

    readme_path = args.model_dir / "README.md"
    readme = readme_path.read_text(encoding="utf-8")
    readme = re.sub(r"\nThis is a quantized browser artifact, not the original checkpoint\..*\Z", "", readme, flags=re.DOTALL)
    readme = readme.replace(
        "# laya converted for the browser",
        "# Laya multilingual converted for the browser",
    )
    readme = readme.replace(
        "This checkpoint is a general-purpose checkpoint.",
        "This is the multilingual mmBERT-base checkpoint from the `multilingual/` subdirectory, prepared for book structure classification in Semantica.",
    )
    readme = readme.replace(
        "Laya itself is built on ModernBERT-large by Answer.AI and LightOn",
        "The upstream multilingual model is based on mmBERT-base",
    )
    readme += (
        "\nThis is a quantized browser artifact, not the original checkpoint. "
        "It was built for local ONNX Runtime WebAssembly inference in the "
        "Semantica book converter. Refer to `NOTICE.md` and `LICENSE` for "
        "attribution and terms.\n"
    )
    readme = re.sub(r"\n{3,}", "\n\n", readme)
    readme_path.write_text(readme, encoding="utf-8")


if __name__ == "__main__":
    main()
