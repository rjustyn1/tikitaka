#!/usr/bin/env python3
"""One-shot local SBERT embedding bridge for the TypeScript memory server.

Input:  {"texts": ["..."]}
Output: {"embeddings": [[...]]}

The model path must be a local SentenceTransformers checkpoint. No network
request is made by this bridge.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-path", type=Path, required=True)
    args = parser.parse_args()
    if not args.model_path.is_dir():
        raise RuntimeError(f"local SBERT model directory does not exist: {args.model_path}")
    try:
        request: Any = json.loads(sys.stdin.read())
    except json.JSONDecodeError as error:
        raise RuntimeError("SBERT bridge expected JSON on stdin") from error
    texts = request.get("texts") if isinstance(request, dict) else None
    if (
        not isinstance(texts, list)
        or not texts
        or not all(isinstance(text, str) and text.strip() for text in texts)
    ):
        raise RuntimeError("SBERT bridge requires a non-empty texts array")

    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer(str(args.model_path), device="cpu", local_files_only=True)
    vectors = model.encode(
        texts,
        batch_size=16,
        convert_to_numpy=True,
        normalize_embeddings=True,
        show_progress_bar=False,
    )
    print(json.dumps({"embeddings": vectors.tolist()}, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
