from __future__ import annotations

import argparse
import json
from pathlib import Path

from laya import load
from laya.common import build_sequence

CASES = [
    {
        "state": "PRÓLOGO\n\nLa memoria del agua\n\nEn los pueblos de la sierra, cada invierno empezaba con la primera nevada.",
        "question": {
            "type": "choice",
            "instructions": "Clasifica la función estructural del bloque en un libro en español.",
            "criteria": {
                "title": "Título principal de la obra.",
                "heading": "Título de capítulo o sección principal.",
                "subheading": "Título de subsección.",
                "paragraph": "Párrafo normal del libro.",
                "list_item": "Elemento de lista o índice.",
                "caption": "Leyenda de imagen, tabla o figura.",
                "noise": "Ruido OCR o texto ilegible.",
                "other": "Otro contenido válido.",
            },
        },
    },
    {
        "state": {
            "block": "CAPÍTULO 3\nLa casa de la montaña",
            "previous": ["SEGUNDA PARTE", "Una historia para recordar"],
            "metadata": {"language": "es", "page": 12},
        },
        "question": {
            "type": "choice",
            "instructions": "¿Qué tipo de bloque de libro es este? [MASK] No traduzcas.",
            "criteria": ["title", "heading", "subheading", "paragraph", "list_item", "caption", "noise", "other"],
        },
    },
    {
        "state": "El índice termina aquí.\n\n\"Capítulo 2\"\n\nTexto con [MASK], tildes, emoji 😀 y símbolos.",
        "question": {
            "type": "choice",
            "instructions": "Clasifica este fragmento.",
            "criteria": {
                "heading": "Capítulo o sección",
                "paragraph": "Prosa continua",
                "other": "Contenido restante",
            },
        },
    },
]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[1] / "tests/sequence-fixtures.json")
    args = parser.parse_args()

    agent = load(str(args.model), device="cpu")
    config = agent.cfg
    fixtures = []
    for case in CASES:
        question = agent._to_internal(case["question"])
        ids, markers = build_sequence(
            agent.tok,
            case["state"],
            question,
            int(config.get("max_len", 1024)),
            int(config.get("head_max_len", 256)),
        )
        fixtures.append({**case, "ids": ids, "markers": markers})

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(fixtures, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {len(fixtures)} multilingual sequence fixtures to {args.out}")


if __name__ == "__main__":
    main()
