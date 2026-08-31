# Recognition Integration Manifest - Local SBERT Routing

Status: local CPU model wired and review-first. Human-reviewed promotion is pending.

Owner: recognition follow-on on `feat/memory-consolidator`.

Related documents: `TODO-2.md`, `middlewaredoc/components/RECOGNITION.md`,
`manifest/MANIFEST_1.md`, `manifest/manifest_2.md`, and
`manifest/manifest_3.md`.

## Purpose

This is the merge handoff for the note-to-Agent recognition workstream. It
does not replace the governed-memory, planner, runtime, or UI manifests. Its
job is to make the recognition code, local runtime requirements, model
artifacts, review gate, and documentation changes explicit when combining
branches.

## Contribution

- Adds a local CPU `sbert` recognition provider alongside `fake`, `ark`, and
  `off` modes.
- Serves embeddings through `SbertEmbeddingClient`, which starts the tracked
  `scripts/embed-recognizer.py` bridge with a local model directory and JSON
  stdin/stdout. The bridge uses `local_files_only=True`; it makes no network
  requests.
- Adds validated configuration for the Python executable, model directory,
  bridge path, embedding timeout, and automatic-grant opt-in.
- Keeps the active recognition checkpoint at `data/recognition/model/` locally.
  Dataset, checkpoints, queues, and training scripts are intentionally ignored
  and must be provisioned outside Git.
- Adds balanced synthetic-data generation, duplicate/leakage audit, hard
  negative fine-tuning, false-positive-priority calibration, and a human review
  queue builder under `scripts_ignored/`.

## Tracked Runtime Files

| Path | Role |
| --- | --- |
| `apps/server/src/memory/recognizer.ts` | Embedding clients, including the local SBERT process adapter. |
| `apps/server/src/memory/pipeline.ts` | Chooses the configured recognizer and preserves recognizer-owned routing. |
| `apps/server/src/config.ts` | Validates and resolves SBERT configuration. |
| `apps/server/src/index.ts` | Loads local `.env` before config and forces SBERT review-first behavior by default. |
| `scripts/embed-recognizer.py` | Tracked inference bridge required after a branch merge. |
| `apps/server/requirements-sbert.txt` | Python runtime dependencies for the CPU bridge. |
| `middlewaredoc/components/RECOGNITION.md` | Technical operating and training guide. |

`scripts_ignored/embed-recognizer.py` may exist in a developer checkout from
earlier work, but it is not the runtime contract. Use the tracked
`scripts/embed-recognizer.py` path in new configuration and deployment files.

## Configuration Contract

```dotenv
MEMORY_RECOGNIZER=fake|ark|sbert|off
MEMORY_SBERT_PYTHON=python3
MEMORY_SBERT_MODEL_DIR=/absolute/path/to/data/recognition/model
MEMORY_SBERT_BRIDGE=/absolute/path/to/scripts/embed-recognizer.py
MEMORY_RECOGNITION_AGENT_THRESHOLD=0.72
MEMORY_EMBEDDING_TIMEOUT_MS=30000
MEMORY_AUTO_GRANT_ENABLED=false
```

- `MEMORY_RECOGNIZER` remains `fake` by default for offline checks.
- `MEMORY_EXTRACTOR` is separate and remains `ark` by default under the Person
  3 / Person 1 contract.
- `MEMORY_AUTO_GRANT_ENABLED` defaults to `false`. When `sbert` is selected,
  the server forces `reviewAllSkills` unless this explicit opt-in is `true`.
- `.env` is ignored. Merge these keys manually and do not commit local paths,
  API keys, or model artifacts.

## Calibration And Review Gate

The promoted v1 checkpoint was calibrated on synthetic data at threshold
`0.72` with the false-positive-priority policy. On its synthetic test split it
recorded an automatic false-grant rate of `2.67%` at `87.33%` automatic
coverage. This is iteration evidence only, not a release approval.

Before enabling automatic grants, a maintainer must:

1. Review and label an independent holdout queue, including out-of-scope and
   near-threshold notes.
2. Recalibrate against those human labels and meet the configured false-grant
   target.
3. Record the report path, threshold, data origin, and approver in the release
   documentation.
4. Set `MEMORY_AUTO_GRANT_ENABLED=true` only in the environment that has the
   approved local model and bridge dependencies installed.

Until then, fallback, severe, safety-affected, and new-skill decisions remain
in manual review, and SBERT threshold matches are also review-only.

## Merge Notes

### Shared Files

- `config.ts`: retain Person 1/3 memory extraction settings exactly, then add
  `sbert` to `MEMORY_RECOGNIZER` and the `MEMORY_SBERT_*` /
  `MEMORY_AUTO_GRANT_ENABLED` fields. Do not change the extractor default while
  resolving this overlap.
- `index.ts`: preserve lifecycle setup. `loadLocalEnvironment()` must run
  before `loadConfig()` for local development, and the review-first SBERT gate
  must remain in the memory-pipeline options.
- `memory/pipeline.ts`: preserve Person 3's required validated config.
  Recognition selects recipients from resolved active members; extraction never
  regains authority to choose the landing Agent.
- `memory/recognizer.ts`: retain the `EmbeddingClient` boundary and fake/Ark
  behavior. The SBERT bridge is an additional adapter, not a second routing
  implementation.

### Ordering

1. Merge Person 1 runtime/workspace lifecycle and Person 2 planner contracts.
2. Merge Person 3 governed-memory extraction and its required config pipeline.
3. Apply this recognition layer to the shared config, index, pipeline, and
   recognizer modules.
4. Merge Person 4 UI without changing server-side routing or creating a second
   recognition implementation.
5. Provision the ignored checkpoint and local Python environment, then verify
   the runtime with `MEMORY_RECOGNIZER=sbert` and automatic grants disabled.

## Documentation Reconciliation Checklist

- `README.md`: list the runtime dependency and how local `.env` selects SBERT.
- `middlewaredoc/README.md`: link the recognition component guide.
- `middlewaredoc/PLAN.md` and `TODO-2.md`: mark dataset generation, CPU
  training, calibration, and runtime wiring accurately; leave human-review
  promotion open.
- `middlewaredoc/SPEC.md`: ensure consolidator output has no recipient field
  and recognition remains the recipient authority.
- `middlewaredoc/DEMO.md`: add a review-first local-SBERT demo and explicitly
  avoid presenting synthetic calibration as production approval.
- `middlewaredoc/components/RECOGNITION.md`: keep the canonical configuration,
  runtime, training, calibration, and review procedure here.
- `manifest/MANIFEST_1.md`, `manifest/manifest_2.md`, and
  `manifest/manifest_3.md`: preserve their ownership statements and cross-link
  this manifest rather than duplicating their implementation narratives.

## Verification

Run after combining branches and provisioning the local checkpoint:

```bash
python -m pip install -r apps/server/requirements-sbert.txt
printf '{"texts":["The API must reject expired access tokens."]}' | \
  python scripts/embed-recognizer.py --model-path data/recognition/model
npm run check
```

The bridge must return a non-empty normalized vector and `npm run check` must
remain offline with the default `MEMORY_RECOGNIZER=fake`.
