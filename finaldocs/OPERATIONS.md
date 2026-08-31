# Operations Guide

## Requirements

| Requirement | Used for |
| --- | --- |
| Node.js 22+ and npm | Server, web application, tests, and builds. |
| Codex CLI or configured runtime image | Agent execution. |
| Docker, Colima, or Podman | Container execution and local POC mode. |
| Ark API key and model | Real model-backed planner and extraction. |
| Python 3 plus a virtual environment | Optional local SBERT inference. |

The application can still run offline when Ark credentials are unavailable:
startup selects the fake planner and extractor. The recognizer similarly falls
back to deterministic fake embeddings when a local SBERT checkpoint or bridge is
missing.

## JavaScript Dependencies And Verification

```bash
npm install
npm run check
```

npm run check runs workspace typechecks, both Vitest suites, and production
builds. It is the baseline verification before merging or demoing changes.

## Local Development

The server defaults to repository-local .data, workspaces, and codex-home when
no explicit values are set. For a deliberate bare-host development setup, use
absolute paths so root scripts and the server package read the same state:

```bash
APP_DATA_DIR="$PWD/.data" \
AGENT_WORKSPACE_ROOT="$PWD/workspaces" \
CODEX_HOME="$PWD/codex-home" \
npm run dev
```

- Web UI: http://localhost:5173
- API: http://localhost:3000

The server reads a repository .env in non-production environments via Node's
environment-file loader. Do not shell-source .env: it can contain values for a
different runtime profile. Keep credentials and machine-specific absolute paths
in .env, never in .env.example or Git history.

## Local POC And Container Runtime

The root POC helper builds the application and a runtime image, chooses the
available container engine, and retains local application state across restarts.

```bash
ARK_API_KEY=your-key \
ARK_MODEL=your-model-or-endpoint \
npm run poc
```

Use SEED_DEMO=1 with the same command to populate demo records when the seed
workflow is desired. Configure the container engine with CONTAINER_ENGINE, and
select RUNTIME_PROVIDER=container for containerized Agent execution.

The deployment material under docs/ is useful for a production-like host, but
this project remains a single-user POC. Do not put production secrets or
sensitive workloads into an unreviewed deployment.

## Local SBERT Runtime

The SBERT recognizer is a Python inference companion invoked by the Node server.
It is not a standalone HTTP microservice. Node starts a tracked bridge process,
sends JSON on standard input, and receives normalized embedding vectors on
standard output.

Create a local virtual environment and install the tracked runtime dependency
set:

```bash
python3 -m venv .venv-recognition
.venv-recognition/bin/python -m pip install -r apps/server/requirements-sbert.txt
```

Provision a compatible local SentenceTransformers checkpoint at
data/recognition/model/, or point MEMORY_SBERT_MODEL_DIR to one. Datasets,
training artifacts, calibration reports, and model directories are intentionally
ignored by Git and must be supplied to each environment separately.

Smoke-test the bridge before starting a demo:

```bash
printf '{"texts":["The API must reject expired access tokens."]}' | \
  .venv-recognition/bin/python scripts/embed-recognizer.py \
  --model-path data/recognition/model
```

The output must contain one non-empty vector. The current bridge forces
local_files_only=True, so it does not download model files or call the network.

## Configuration Reference

All configuration is validated in apps/server/src/config.ts.

### Platform And Runtime

| Variable | Default | Purpose |
| --- | --- | --- |
| HOST | 0.0.0.0 | Server bind host. |
| PORT | 3000 | Server port. |
| APP_DATA_DIR | repository .data | Location of launchpad.json. |
| AGENT_WORKSPACE_ROOT | repository workspaces | Private Agent and shared task workspace root. |
| CODEX_HOME | repository codex-home | Codex home used by the runtime. |
| CODEX_BIN | codex | Host Codex executable. |
| CODEX_SANDBOX_MODE | workspace-write | Codex sandbox setting. |
| RUNTIME_PROVIDER | local-process | local-process or container. |
| CONTAINER_ENGINE | docker | Container CLI when using the container provider. |
| CONTAINER_RUNTIME_IMAGE | volc-agent-runtime:local | Agent runtime image. |
| GROUP_MAX_PARALLEL_NODES | 4 | Maximum concurrent ready planner nodes, 1-8. |
| APP_AUTH_TOKEN | unset | Shared browser and API token. Required for non-loopback production exposure. |

### Extraction And Segmentation

| Variable | Default | Purpose |
| --- | --- | --- |
| MEMORY_ENABLED | true | Master switch for governed-memory processing. false disables segmentation, extraction, routing, review activation, landing, and group-turn injection; group tasks continue to run. Existing landed files are not deleted. |
| MEMORY_EXTRACTOR | ark | ark, fake, or off extractor choice. |
| MEMORY_EXTRACT_TIMEOUT_MS | 30000 | Planner and extractor request timeout. |
| MEMORY_TOPIC_DRIFT_THRESHOLD | 0.9 | Topic boundary threshold. |
| MEMORY_SEGMENT_MAX_TASKS | 8 | Force-close segment task cap. |
| MEMORY_SEGMENT_MAX_CHARS | 120000 | Force-close segment transcript cap. |
| MEMORY_SEGMENT_IDLE_MS | 1800000 | Idle close delay in milliseconds. |

### Recognition And Review

| Variable | Default | Purpose |
| --- | --- | --- |
| MEMORY_RECOGNIZER | sbert | sbert, ark, fake, or off. |
| MEMORY_EMBEDDING_MODEL | unset | Ark embedding model when recognizer is ark. |
| MEMORY_SBERT_PYTHON | python3 | Python executable for local SBERT bridge. |
| MEMORY_SBERT_MODEL_DIR | repository data/recognition/model | Local checkpoint directory. |
| MEMORY_SBERT_BRIDGE | repository scripts/embed-recognizer.py | Tracked inference bridge. |
| MEMORY_RECOGNITION_AGENT_THRESHOLD | 0.35 | Agent match threshold. Use the threshold approved for the deployed model. |
| MEMORY_RECOGNITION_SKILL_THRESHOLD | 0.45 | Existing-skill match threshold. |
| MEMORY_EMBEDDING_TIMEOUT_MS | 30000 | Bridge or embedding request timeout. |
| MEMORY_AUTO_GRANT_ENABLED | false | Explicit opt-in for automatic SBERT-routed grants. |
| REVIEW_ALL_SKILLS | false | Force all notes through review. |
| SKILLS_DIR | .agents/skills | Configured skill-root value; the private catalog currently uses this path. |

### Ark And Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| ARK_API_KEY | unset | Ark API credential. |
| ARK_MODEL | unset | Ark model or endpoint identifier used by Codex config. |
| ARK_BASE_URL | Ark Beijing v3 endpoint | Ark API base URL. |
| NODE_ENV | development | development, test, or production. |

## Recommended Local SBERT Profile

Use a machine-specific .env with absolute paths:

```dotenv
MEMORY_RECOGNIZER=sbert
MEMORY_SBERT_PYTHON=/absolute/path/to/.venv-recognition/bin/python
MEMORY_SBERT_MODEL_DIR=/absolute/path/to/data/recognition/model
MEMORY_SBERT_BRIDGE=/absolute/path/to/scripts/embed-recognizer.py
MEMORY_RECOGNITION_AGENT_THRESHOLD=0.72
MEMORY_AUTO_GRANT_ENABLED=false
REVIEW_ALL_SKILLS=true
```

The threshold must match the approved calibration of the checkpoint being used.
0.72 is an example from the current local synthetic-data calibration, not a
universal or production-approved threshold.

## Operational Checks

Run these before a live demo or environment promotion:

```bash
npm run check
printf '{"texts":["A note about API validation."]}' | \
  "$MEMORY_SBERT_PYTHON" scripts/embed-recognizer.py \
  --model-path "$MEMORY_SBERT_MODEL_DIR"
```

Then verify in the running application:

1. GET /api/health responds.
2. GET /api/auth reports the expected authentication requirement.
3. A group with two or more Agents can start a task.
4. Plan, timeline, and trace views populate while the task runs.
5. A closed topic segment produces notes in review-first mode.
6. Approval creates a landed memory record and file; revocation removes it.

## Python Dependency Management Direction

The tracked apps/server/requirements-sbert.txt is the current lightweight
runtime contract. For reproducible deployment, introduce a small Python project
with a lock file, such as pyproject.toml plus uv.lock, and install it into the
same image or host environment as the Node server. That change should keep the
Node-to-stdin/stdout boundary intact; it does not require a separate Python web
backend.
