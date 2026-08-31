# Recognition

## Purpose

Recognition decides which completed-task memory note is relevant to which
active group Agents. Extraction never chooses recipients. The recognizer also
searches skills only within each selected Agent's private `.agents/skills`
directory.

## Flow

1. `Consolidator` extracts content, severity, `skillKey`, description, and
   provenance with no recipient field.
2. `Recognizer.recognizeAgents()` embeds the note and each active Agent
   profile. Every score at or above the Agent threshold is selected; otherwise
   exactly one top score is returned as a `fallback`.
3. For each selected Agent, `loadAgentSkillProfiles()` reads only that Agent's
   private skills. `Recognizer.recognizeSkill()` selects the best skill above
   the skill threshold or returns a `new-skill` decision.
4. `ReviewService` always parks severe, safety-affected, fallback, and
   new-skill notes. Clean threshold matches to existing skills may land.
5. `LandingService` projects each normal note into `SKILL.md` as a
   `memory:<noteId>` managed block. Revocation removes that block only and
   deletes the skill directory only when it contains no governed-memory blocks.

## Runtime clients

`EmbeddingClient` is the serving boundary. `FakeEmbeddingClient` is
deterministic and network-free. `ArkEmbeddingClient` uses an
OpenAI-compatible `/embeddings` endpoint. `SbertEmbeddingClient` invokes the
tracked `scripts/embed-recognizer.py` bridge over stdin/stdout and loads the
active CPU checkpoint at `data/recognition/model/`; it makes no network call.
The previous base checkpoint is retained at `data/recognition/model-base/`.

For a deployable local-SBERT runtime, install the tracked
`apps/server/requirements-sbert.txt` into the Python environment selected by
`MEMORY_SBERT_PYTHON`. Dataset generation and training utilities remain under
ignored `scripts_ignored/` because they are developer tooling rather than a
server runtime dependency.

## CPU Training Workflow

The ignored scripts read and write only `data/recognition/`. They do not call
the OpenAI API; that API is only used by the separate dataset generator.

Before training, verify generated data has no duplicate text within or across
splits. This command is offline; `--repair` deterministically removes
duplicates and rebuilds the split files using the manifest seed:

```bash
python scripts_ignored/generate-recognition-dataset.py audit
python scripts_ignored/generate-recognition-dataset.py audit --repair
```

The API-backed generator uses a deterministic balanced schedule with compact
few-shot scope examples: 70% single-Agent notes, 20% multi-Agent notes, and
10% OOS notes. Across a 1,000-record run each of the seven demo capabilities
receives approximately 150 positive labels. Labels are still marked
`synthetic`; they are training material, not gold evaluation evidence.

```bash
python scripts_ignored/generate-recognition-dataset.py generate \
  --count 1000 --seed 7 --batch-size 10 --resume
```

1. Train the shared SBERT note/profile encoder from the canonical
   `train.jsonl`, `validation.jsonl`, and `test.jsonl` splits:
   ```bash
   source .venv-recognition/bin/activate
   python scripts_ignored/train-recognizer.py \
     --epochs 3 --batch-size 16 --seed 7 --checkpoint-every-epoch
   ```
2. Mine realistic incorrect Agent matches from the resulting checkpoint:
   ```bash
   python scripts_ignored/train-recognizer.py \
     --mine-hard-negatives --model-path data/recognition/model --top-k 5
   ```
3. Fine-tune that checkpoint on the mined negatives. The base model remains
   intact; the result is written to `model-finetuned`:
   ```bash
   python scripts_ignored/finetune-recognizer.py \
     --model-path data/recognition/model \
     --output-dir data/recognition/model-finetuned \
     --epochs 1 --batch-size 16 --checkpoint-every-epoch
   ```
4. Evaluate either checkpoint without training:
   ```bash
   python scripts_ignored/train-recognizer.py \
     --evaluate --model-path data/recognition/model-finetuned
   ```

Calibration evaluates set precision, recall, F1, Jaccard, exact match,
per-Agent recall, fallback rate, false-grant rate, OOS review recall, OOS
automatic-grant rate, and review rate. It records the selected threshold and
whether the configured false-grant target was met. A synthetic-only report is
useful for iteration, but is not authorization for automatic grants; that
requires a manually reviewed holdout set.

### False-Positive Priority

Fallbacks are always held for review, so they are not automatic grants. The
default calibration policy therefore measures false grants only among
threshold matches. It chooses the largest automatic-grant coverage that stays
within the configured false-grant target; when no threshold can do that, it
selects a review-all threshold instead of an F1-optimal unsafe threshold.

```bash
python scripts_ignored/train-recognizer.py --evaluate \
  --model-path data/recognition/model-finetuned \
  --false-grant-target 0.05 \
  --calibration-policy false-positive-priority \
  --report-path data/recognition/precision-calibration-v1.json
```

The resulting threshold may be assigned to `MEMORY_RECOGNITION_AGENT_THRESHOLD`
only when the report is based on a reviewed holdout and says
`automatic_grants_allowed: true`. Otherwise, keep all routed notes in review.

To build a human-labeling queue without modifying any dataset split:

```bash
python scripts_ignored/build-recognition-review-queue.py \
  --model-path data/recognition/model-finetuned \
  --threshold 0.90 --split validation --limit 75
```

The queue prioritizes OOS auto-grants, incorrect threshold matches,
near-threshold cases, and fallbacks. A reviewer fills its `reviewed_*` fields;
synthetic labels remain proposals rather than gold truth.

Configuration:

- `MEMORY_RECOGNIZER=fake|ark|sbert|off` defaults to `fake`.
- `MEMORY_EMBEDDING_MODEL` is required for `ark`.
- `MEMORY_SBERT_PYTHON`, `MEMORY_SBERT_MODEL_DIR`, and
  `MEMORY_SBERT_BRIDGE` select the local Python environment, checkpoint, and
  bridge for `sbert`.
- `MEMORY_RECOGNITION_AGENT_THRESHOLD` defaults to `0.35`.
- `MEMORY_RECOGNITION_SKILL_THRESHOLD` defaults to `0.45`.
- `MEMORY_EMBEDDING_TIMEOUT_MS` defaults to `30000`.
- `MEMORY_AUTO_GRANT_ENABLED` defaults to `false`. With `sbert`, startup
  forces review-only behavior unless this is explicitly enabled after a
  reviewed calibration passes its false-grant target.

## Audit fields

`MemoryNote` records recipient scores, match kind, generated skill key, and
per-Agent skill assignments. `GrantRecord` carries the recipient score and
match kind. A skill file is a projection, not the decision source of truth.

## Tests

- `recognizer.test.ts`: threshold/fallback routing, caching, and skill choice.
- `pipeline.test.ts`: recognition overrides extractor routing and fallback
  decisions require review.
- `landing.test.ts`: managed skill blocks merge and revoke independently.
- `group-prompt.test.ts`: active governed memory is included in group turns.
