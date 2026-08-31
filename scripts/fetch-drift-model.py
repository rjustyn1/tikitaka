#!/usr/bin/env python
# Download the GENERAL topic-drift embedder to a local dir so the local-only
# bridge (embed-recognizer.py) can load it. Run once, with the SBERT venv.
#   .venv-recognition/bin/python scripts/fetch-drift-model.py
from sentence_transformers import SentenceTransformer

SentenceTransformer("all-MiniLM-L6-v2").save("data/drift-model")
print("Saved drift model to data/drift-model")
