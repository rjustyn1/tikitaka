# Volc Agent Launchpad — Governed Cross-Agent Memory

An Agent platform with a **governed memory middleware** on top. Agents run in
isolated Codex sessions, so whatever one works out normally dies with its run.
This platform captures that knowledge from a shared task, decides which other
Agents may receive it, writes it into their workspaces as native Codex memory,
and records every grant **and every denial** with a named reason.

The base platform gives you Agent CRUD, a browser Playground, persistent
workspaces, and Codex CLI backed by the Volcengine Ark Responses API. The
middleware adds Teams, planned multi-Agent tasks, and the memory pipeline.

Run it locally with Docker, Colima, or rootless Podman, or deploy it to
Volcengine ECS.

> [!WARNING]
> This is a single-user proof of concept. It intentionally has no identity,
> tracing, audit, or hardened sandbox middleware. Do not use production data or
> credentials. See [SECURITY.md](SECURITY.md).

## Screenshots

### Agent Playground

![Agent Playground showing lifecycle controls, starter prompts, and the Codex Runtime](docs/assets/playground.jpg)

### Create an Agent

![Create Agent form with name, description, and workspace instructions](docs/assets/create-agent.jpg)

## Features

**Base platform**

- React and TypeScript Web UI
- Agent create, edit, start, stop, delete, and multi-turn chat
- Fastify control plane with asynchronous Run state
- Persistent Agent workspaces and Codex sessions
- Disposable Docker, Colima, or Podman container for each local turn
- Docker and Terraform deployment paths for Volcengine ECS

**Governed memory middleware**

- **Teams** — put several Agents on one goal, over one shared `./code` tree
- **Planner** — reads the task and each Agent's description, then builds the
  execution DAG; independent branches run in parallel
- **Topic segmentation** — memory is consolidated per *topic segment* (a run of
  consecutive tasks on one subject), detected with Jensen–Shannon divergence,
  not per individual task
- **Recognition** — decides *which* Agents receive each note, by embedding
  similarity rather than by asking the extractor to guess
- **Safety + human review** — secret redaction and a quarantine heuristic run
  before anything is written; severe, redacted, quarantined, and low-confidence
  notes go to a human
- **Landing by placement** — a note reaches an Agent **iff** a file was written
  into that Agent's workspace. That is the whole security boundary.
- **Grant ledger** — append-only record of who received what, and who was
  denied and why

## Requirements

- Node.js 22+
- npm 10+
- Docker, Colima, or Podman
- A Volcengine Ark API key and endpoint that supports the Responses API

Codex CLI is included in the Runtime image and is not required on the host.
Git LFS and Python are needed only to run note routing on the real
[local SBERT checkpoint](#note-routing-the-sbert-checkpoint); without them the
app still runs and falls back to deterministic offline routing.

---

# Setup

## Quick start — this is the whole thing

```bash
git clone <repository-url> volc-agent-launchpad
cd volc-agent-launchpad

ARK_API_KEY=your-ark-api-key \
ARK_MODEL=ep-your-endpoint-id \
npm run poc
```

That is the complete setup. `npm run poc` runs `npm ci` on first use, builds
the Runtime image and the app, picks Docker / Colima / Podman, sets
`RUNTIME_PROVIDER=container`, and points the data, workspace, and Codex-home
paths at your local state directory. Nothing else to install or configure.

Add demo data in the same command — idempotent, safe to leave on:

```bash
SEED_DEMO=1 ARK_API_KEY=... ARK_MODEL=... npm run poc
```

Both model-backed features default to the real thing and degrade on their own
when a prerequisite is missing, so a fresh clone always starts:

| Default | Degrades to | When |
| --- | --- | --- |
| `MEMORY_EXTRACTOR=ark` | `fake` | `ARK_API_KEY` / `ARK_MODEL` unusable |
| `MEMORY_RECOGNIZER=sbert` | `fake` | checkpoint or Python bridge not provisioned |

Each prints one warning saying which prerequisite is missing and what to run.
To get real model-driven note routing, provision the checkpoint below.

> `npm run poc` does **not** read `.env` — only `docker compose` does. Pass
> `ARK_*` on the command line as above. See [Development](#development) for why
> exporting all of `.env` breaks a bare host run.

## Open the browser

Visit <http://localhost:3000>, or from the terminal:

```bash
open http://localhost:3000       # macOS
xdg-open http://localhost:3000   # Linux desktop
```

**Solo Agent:**

1. Select **Create Agent**, give it a name, description, and instructions.
2. Enter a task in the Playground, for example:

   ```text
   Create a TypeScript hello-world CLI, add a test, and run it.
   ```

**Team with governed memory:**

1. Create at least **two** Agents with distinct descriptions — the planner and
   the recognizer both read `description`, so make them meaningful
   (e.g. "Backend API and storage work", "Auth, validation, secret boundaries").
2. Switch to **Teams**, create a team, and give it one goal.
3. Watch the plan execute, then open **Review**, **Ledger**, and **Workspaces**
   to see which Agent received which note, and who was denied.

## Note routing: the SBERT checkpoint

`MEMORY_RECOGNIZER` defaults to `sbert`, the trained local checkpoint. Until
you provision it the app falls back to deterministic offline routing and says
so — nothing breaks, but note routing is not model-driven. This section is the
**only** reason this project needs Git LFS or Python.

The checkpoint (87 MB) ships via LFS, so fetch it and confirm you got real
weights rather than a pointer stub:

```bash
git lfs install
git lfs pull
ls -lh data/recognition/model/model.safetensors   # expect ~87M, not ~133 bytes
```

Then the Python bridge:

```bash
python3 -m venv .venv-recognition
source .venv-recognition/bin/activate
pip install -r apps/server/requirements-sbert.txt
```

Smoke-test the bridge — it must return a non-empty vector:

```bash
printf '{"texts":["The API must reject expired access tokens."]}' | \
  python scripts/embed-recognizer.py --model-path data/recognition/model
```

No env change is needed — `sbert` is already the default. Set the calibrated
threshold that belongs with this checkpoint:

```dotenv
MEMORY_RECOGNITION_AGENT_THRESHOLD=0.72
```

> The Python environment is **per machine** and is never committed — torch
> alone is 322 MB, past GitHub's file limit. Only the checkpoint ships, via LFS.

> [!IMPORTANT]
> **Automatic grants stay off.** While `MEMORY_AUTO_GRANT_ENABLED=false`, the
> server forces every note routed by a real recognizer — `sbert` or `ark` —
> through human review, whatever its confidence. (`fake`, the offline stub, is
> exempt so seeded demo data is not parked behind a human.) The checkpoint
> was calibrated on *synthetic* data; a maintainer must review an independent
> holdout and recalibrate against human labels before enabling auto-grant. See
> [MANIFEST_RECOGNITION.md](manifest/MANIFEST_RECOGNITION.md).

## Stop and resume

Press `Ctrl+C` in the startup terminal. The script removes temporary Runtime
containers but keeps Agent workspaces and conversations.

- macOS state: `~/.volc-agent-launchpad/`
- Linux state: `.local/`
- Custom location: set `LOCAL_POC_DATA_ROOT`

### Select a specific container engine

```bash
CONTAINER_ENGINE=podman \
ARK_API_KEY=your-ark-api-key \
ARK_MODEL=ep-your-endpoint-id \
npm run poc
```

Colima uses `CONTAINER_ENGINE=docker` because it exposes the Docker CLI. For a
clean Linux host, follow the
[rootless Podman setup](docs/LOCAL_POC.md#rootless-podman-on-linux).

---

## Docker Compose

```bash
./scripts/bootstrap-local.sh
```

Required values in `.env`:

```dotenv
ARK_API_KEY=your-ark-api-key
ARK_MODEL=ep-your-endpoint-id
APP_AUTH_TOKEN=replace-with-at-least-24-random-characters
```

```bash
docker compose up --build     # then open http://localhost:3000
docker compose down           # stops without deleting Agent data
```

## Development

```bash
npm install
npm install --global @openai/codex@0.111.0
APP_DATA_DIR="$PWD/.data" \
AGENT_WORKSPACE_ROOT="$PWD/workspaces" \
CODEX_HOME="$PWD/codex-home" \
npm run dev
```

- Web UI: <http://localhost:5173>
- API: <http://localhost:3000>

> [!WARNING]
> **Do not `source .env` for a bare host run.** The committed `.env` is the
> *container* profile: it sets `APP_DATA_DIR=/app/data` and friends, which do
> not exist on a host, and the server exits with
> `ENOENT: no such file or directory, mkdir '/app'`. Export only the `ARK_*`
> keys, and pass the three absolute paths above.

Those same three paths matter when seeding, or the seed writes to a different
store than the server reads:

```bash
APP_DATA_DIR="$PWD/.data" \
AGENT_WORKSPACE_ROOT="$PWD/workspaces" \
CODEX_HOME="$PWD/codex-home" \
npm run seed
```

## Deployment

- [Existing Linux ECS with Docker](docs/DEPLOYMENT.md#existing-linux-ecs)
- [Complete Volcengine environment with Terraform](docs/DEPLOYMENT.md#terraform-deployment)
- [Local Docker, Colima, and Podman details](docs/LOCAL_POC.md)

```bash
cp .env.example .env.production
./scripts/deploy-existing-ecs.sh .env.production
```

The Terraform path provisions VPC, subnet, security group, ECS, and EIP:

```bash
cp deploy/volcengine/terraform.tfvars.example \
  deploy/volcengine/terraform.tfvars
./scripts/deploy-volcengine.sh
```

## Configuration

**Base platform**

| Variable | Default | Purpose |
| --- | --- | --- |
| `ARK_API_KEY` | Required | Ark model API key. |
| `ARK_MODEL` | Required | Responses-capable endpoint or model ID. |
| `ARK_BASE_URL` | Beijing v3 endpoint | Ark OpenAI-compatible API URL. |
| `APP_AUTH_TOKEN` | Empty on loopback | Shared demo token; use 24+ random characters remotely. |
| `RUNTIME_PROVIDER` | `local-process` | `container` for disposable local Runtime containers. |
| `CODEX_SANDBOX_MODE` | `workspace-write` | Codex inner sandbox mode. |
| `CODEX_TIMEOUT_MS` | `600000` | Maximum duration of one turn. |
| `GROUP_MAX_PARALLEL_NODES` | `4` | How many plan nodes of one task may run at once. |
| `LOCAL_POC_DATA_ROOT` | Platform-specific | Local metadata, workspace, and session directory. |

**Memory extraction**

| Variable | Default | Purpose |
| --- | --- | --- |
| `MEMORY_ENABLED` | `true` | Master switch; `false` restores the exact baseline. |
| `MEMORY_EXTRACTOR` | `ark` | `ark` \| `fake` \| `off`. Falls back to `fake` automatically when `ARK_*` is unusable. |
| `MEMORY_EXTRACT_TIMEOUT_MS` | `30000` | Consolidator model-call timeout. The code default is low for real runs; `.env.example` raises it to `120000`. |
| `REVIEW_ALL_SKILLS` | `false` | Force every note through human review. |
| `SKILLS_DIR` | `.agents/skills` | Where landed skills go inside each workspace. |

**Topic segmentation**

| Variable | Default | Purpose |
| --- | --- | --- |
| `MEMORY_TOPIC_DRIFT_THRESHOLD` | `0.90` | JS-divergence score above which the subject counts as changed. |
| `MEMORY_SEGMENT_MAX_TASKS` | `8` | Hard cap: close a segment after this many tasks. |
| `MEMORY_SEGMENT_MAX_CHARS` | `120000` | Hard cap on transcript size. |
| `MEMORY_SEGMENT_IDLE_MS` | `1800000` | Close an untouched segment on the next group read. |

**Recognition (routing)**

| Variable | Default | Purpose |
| --- | --- | --- |
| `MEMORY_RECOGNIZER` | `sbert` | `sbert` \| `ark` \| `fake` \| `off`. Falls back to `fake` automatically when the checkpoint or bridge is missing. |
| `MEMORY_RECOGNITION_AGENT_THRESHOLD` | see note | Similarity floor for routing to an Agent. Use `0.72` with the shipped checkpoint. |
| `MEMORY_RECOGNITION_SKILL_THRESHOLD` | `0.45` | Similarity floor for matching an existing skill. |
| `MEMORY_AUTO_GRANT_ENABLED` | `false` | Must stay `false` until a reviewed holdout authorizes auto-grant. |
| `MEMORY_SBERT_PYTHON` | `python3` | Interpreter for the bridge. |
| `MEMORY_SBERT_MODEL_DIR` | `data/recognition/model` | Checkpoint directory. |
| `MEMORY_SBERT_BRIDGE` | `scripts/embed-recognizer.py` | Inference bridge path. |
| `MEMORY_EMBEDDING_TIMEOUT_MS` | `30000` | Embedding call timeout. |

See [.env.example](.env.example) for the annotated full list.

## How it works

```mermaid
flowchart TD
    UI["React Web UI — Agents · Teams"] --> API["Fastify control plane"]
    API --> Planner["Planner — task + Agent descriptions to a DAG"]
    Planner --> Runner["Group runner — parallel branches, one shared ./code"]
    Runner --> Codex["Codex CLI per turn"]
    Codex --> Ark["Volcengine Ark Responses API"]
    Runner --> Seg{"Topic segment closed?<br/>Jensen–Shannon drift"}
    Seg -->|no, keep accumulating| Runner
    Seg -->|yes| Cons["Consolidator — segment to notes"]
    Cons --> Recog["Recognition — which Agents need this?"]
    Recog --> Safety["Safety — redact + quarantine"]
    Safety --> Gate{"Severe, risky,<br/>or low confidence?"}
    Gate -->|yes| Human["Human review"]
    Gate -->|no| Land["Land by file placement"]
    Human -->|approved| Land
    Land --> WS[("Target Agent workspace<br/>AGENTS.md · .agents/skills")]
    Land --> Ledger[("Grant ledger — granted + withheld")]
```

Security is **file placement**: deterministic, and ours. Relevance is Codex's
own skill matcher: model-driven, and theirs. We did not reinvent retrieval — we
drew a hard line around who may receive what.

The first turn uses `codex exec`; later turns resume the stored Codex thread.
Deleting an Agent archives its workspace under `workspaces/.deleted/`.

## Validation

```bash
npm run check                                   # typecheck + tests + build
terraform fmt -check -recursive deploy/volcengine
docker compose config
```

`npm run check` stays fully offline. Neither default reaches the network under
test: the extractor falls back without a key, and the tests that build a
pipeline pin `MEMORY_RECOGNIZER=fake` explicitly rather than depending on
whether a checkpoint happens to be present on the machine.

After a real end-to-end run, diagnose it with:

```bash
LOCAL_POC_DATA_ROOT=$HOME/.volc-agent-launchpad npm run verify:live
```

This checks the things that otherwise fail **silently** — an empty shared
`./code`, real Codex spans that the consolidator filters out to zero notes, and
governed memory escaping into `$CODEX_HOME` or shared code.

## Documentation

**The middleware** — start with `MIDDLEWARE.md`, then `ARCHITECTURE.md`:

- [Problem, trust boundary, enforcement point](middlewaredoc/MIDDLEWARE.md)
- [Architecture and honest limits](middlewaredoc/ARCHITECTURE.md)
- [Contracts: types, store, routes](middlewaredoc/SPEC.md)
- [Group chat and thread model](middlewaredoc/GROUP-CHAT-DESIGN.md)
- [Component designs](middlewaredoc/components/) — planner, consolidator,
  recognition, safety, landing, ledger, review
- [Demo script](middlewaredoc/DEMO.md)
- [Build status: what is proven, what is not](middlewaredoc/BUILD-REVIEW.md)

**Integration manifests** — read before merging branches:

- [Topic segmentation](manifest/manifest_KL.md)
- [Recognition](manifest/MANIFEST_RECOGNITION.md)

**Base platform**

- [Architecture](docs/ARCHITECTURE.md)
- [Local POC](docs/LOCAL_POC.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Hackathon extension guide](docs/HACKATHON_EXTENSION_GUIDE.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## License

[MIT](LICENSE)
