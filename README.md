# Tiki-Taka — Governed Cross-Agent Memory

> Agents pass what they learn. Nothing passes unwatched.

A multi-Agent coding platform with a **governed memory middleware** on top.
Agents run in isolated Codex sessions, so whatever one works out normally dies
with its run. This platform captures that knowledge from shared team work,
decides which *other* Agents may receive it, writes it into their workspaces as
native Codex memory, and records every grant **and every denial** with a named
reason.

> [!WARNING]
> Single-user proof of concept. No identity system, no hardened multi-tenant
> sandbox. Do not use production data or credentials. See [SECURITY.md](SECURITY.md).

---

## Contents

- [The problem](#the-problem) · [What we built](#what-we-built) · [The trust boundary](#the-trust-boundary)
- [Architecture](#architecture) · [Repository layout](#repository-layout)
- [Requirements](#requirements) · [Quick start](#quick-start) · [The SBERT checkpoint](#the-sbert-checkpoint)
- [Running it](#running-it) · [Configuration](#configuration)
- [How the memory pipeline works](#how-the-memory-pipeline-works)
- [Validation](#validation) · [Documentation map](#documentation-map)
- [What we do not claim](#what-we-do-not-claim)

---

## The problem

Every Agent on this platform runs in its own isolated Codex session. Anything an
Agent works out — a decision, a constraint, a hard-won fact — dies with the run
that produced it. It never reaches the next Agent that needs it.

Carryover *within* one Agent is already free: each Agent owns a private thread
that resumes every turn. Carryover *across* Agents is impossible, because there
is no shared path between them.

The naive fix is to dump the whole group transcript into every Agent. That leaks
scope, drifts roles, and grows the prompt without limit. It also answers the
wrong question. The gap is not "memory". It is **governed** memory:

- **capture** with provenance — which run, which spans
- **decide** who may receive what
- **land** it where the Agent will actually use it
- **prove** both the grant and the denial

Observability tools answer *what did the agent do?* Memory products share one
user's context across their chats — every chat sees everything, with no way to
grant a memory to one agent while withholding it from another. We answer a
question nothing else does:

> **What did this Agent know, what was it denied knowing, and why?**

## What we built

Put 2–8 Agents on one goal over one shared `./code` tree. From there:

| | |
|---|---|
| **Teams** | several Agents on one goal, one shared code tree that persists across tasks |
| **Planner** | reads the task and each Agent's description, emits a validated execution DAG |
| **Runner** | independent branches run in parallel under Agent leases and directory locks |
| **Context hook** | each node gets only what it has not seen; the window is persisted before Codex starts |
| **Capture hook** | trace spans stream to the store live; each retry is its own run row |
| **Topic segmentation** | memory is consolidated per *topic segment*, detected with Jensen–Shannon divergence — not per task |
| **Recognition** | which Agents receive each note, decided by embedding similarity, not by asking the extractor to guess |
| **Safety + review** | secret redaction and a quarantine heuristic run before anything is written; risky notes go to a human |
| **Landing by placement** | a note reaches an Agent **iff** a file was written into that Agent's workspace |
| **Grant ledger** | append-only record of who received what, and who was denied and why |

## The trust boundary

What makes this governance rather than an LLM guessing at access control is a
clean split between two different kinds of question:

| | Enforced by | When | Nature |
|---|---|---|---|
| **Security** — *who may receive a memory* | **file placement** | write time | deterministic, hard, **ours** |
| **Relevance** — *when a memory applies* | **Codex-native skill matching** on the skill's `description` | read time | model-driven, soft, **Codex's** |

Exactly one module writes governed memory into a workspace — the landing
service:

```
severe note  ->  <workspace>/AGENTS.md                     always in context
normal note  ->  <workspace>/.agents/skills/…/SKILL.md     loaded when relevant
```

Because there is one choke point, the live grant state is not a database claim —
it is the set of files on disk, inspectable at any moment. Revoking a memory
means deleting the file.

**This is verified, not assumed.** Against the pinned runtime
`@openai/codex@0.111.0`: a skill written to `<workspace>/.agents/skills/` is
discovered with `scope: "repo"`; discovery does **not** walk up to parent
directories; and a workspace with no skill files sees **none**.

```bash
./scripts/verify-codex-skills.sh     # reproduces all three · no API key needed
```

## Architecture

```
Operator      User ──▶ Web UI                                    given
─────────────────────────────────────────────────────────────────────────
Orchestration Teams ──▶ Planner ──▶ Runner ──▶ Settle ──▶ Done    we built
─────────────────────────────────────────────────────────────────────────
Memory        Inject context   Capture   ──▶  Memory pipeline    THE TRACK
middleware          │             ▲                   │
─────────────────── │ ─────────── │ ─────────────────  │ ───────────────
Agent runtime  Codex CLI + Docker ┘         Workspaces ◀┘          given
              (isolated session per Agent)   ✓ granted · ✕ withheld
─────────────────────────────────────────────────────────────────────────
Evidence      JsonStore — runs · spans · plan nodes · injections   given
              · notes · landed files · grants
```

The middleware **brackets** the Agent runtime; it does not contain it. Two
arrows reach the runtime and they are deliberately different: the context packet
is in-band and lasts one turn, while a landed note is a *file on disk* that
Codex loads on a later run and that survives until revoked.

Full diagrams, editable in draw.io:

- [`middlewaredoc/diagram1-architecture.drawio`](middlewaredoc/diagram1-architecture.drawio) — where the middleware sits
- [`middlewaredoc/diagram2-pipeline.drawio`](middlewaredoc/diagram2-pipeline.drawio) — inside the memory pipeline
- [`middlewaredoc/DIAGRAM_SPEC.md`](middlewaredoc/DIAGRAM_SPEC.md) — what each figure claims, and why

## Repository layout

```
apps/server/          Fastify control plane, execution, planning, memory
  src/memory/         planner · group-runner · consolidator · recognizer
                      safety · review · landing · ledger · topic-segment
apps/web/             React + Vite operator UI
scripts/              start-local-poc · seed-demo · verify-codex-skills
                      embed-recognizer.py (SBERT bridge) · deploy-*
deploy/volcengine/    Terraform for VPC, subnet, ECS, EIP
docs/                 deployment, local POC, hackathon extension guide
finaldocs/            architecture · operations · memory pipeline · status
middlewaredoc/        design decisions, milestones, diagrams
manifest/             recognition calibration and KL/JS divergence notes
```

## Requirements

- Node.js 22+ and npm 10+
- Docker, Colima, or Podman
- A Volcengine Ark API key and an endpoint supporting the Responses API
- **Git LFS** — `MEMORY_RECOGNIZER` defaults to `sbert` and never falls back
- Python 3 — only for the SBERT bridge

Codex CLI ships inside the Runtime image and is not required on the host.

## Quick start

```bash
git clone <repository-url> tiki-taka
cd tiki-taka
git lfs pull            # the recognition checkpoint; startup fails without it

ARK_API_KEY=your-ark-api-key \
ARK_MODEL=ep-your-endpoint-id \
npm run poc
```

`npm run poc` runs `npm ci` on first use, builds the Runtime image and the app,
picks Docker / Colima / Podman, sets `RUNTIME_PROVIDER=container`, and points
data, workspace and Codex-home paths at your local state directory.

Add demo data in the same command — idempotent, safe to leave on:

```bash
SEED_DEMO=1 ARK_API_KEY=... ARK_MODEL=... npm run poc
```

> `npm run poc` does **not** read `.env` — only `docker compose` does. Pass
> `ARK_*` on the command line. See [Development](#development) for why exporting
> all of `.env` breaks a bare host run.

The extractor degrades to `fake` when Ark is unconfigured, and says so. SBERT
does **not** degrade — if the checkpoint is missing, startup fails with a clear
error rather than silently changing routing behaviour.

## The SBERT checkpoint

This section is the **only** reason this project needs Git LFS or Python.

The checkpoint (87 MB) ships via LFS. Fetch it and confirm you got real weights
rather than a pointer stub:

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

Smoke-test it — this must return a non-empty vector:

```bash
printf '{"texts":["The API must reject expired access tokens."]}' | \
  python scripts/embed-recognizer.py --model-path data/recognition/model
```

Set the threshold calibrated for this checkpoint:

```dotenv
MEMORY_RECOGNITION_AGENT_THRESHOLD=0.72
```

> The Python environment is **per machine** and never committed — torch alone is
> 322 MB, past GitHub's file limit. Only the checkpoint ships, via LFS.
> Set `MEMORY_RECOGNIZER=fake` for a deliberately offline run.

> [!IMPORTANT]
> **Automatic grants stay off.** While `MEMORY_AUTO_GRANT_ENABLED=false`, the
> server forces every note routed by a real recognizer — `sbert` or `ark` —
> through human review, whatever its confidence. (`fake` is exempt so seeded
> demo data is not parked behind a human.) The checkpoint was calibrated on
> *synthetic* data; a maintainer must review an independent holdout and
> recalibrate against human labels before enabling auto-grant. See
> [`manifest/MANIFEST_RECOGNITION.md`](manifest/MANIFEST_RECOGNITION.md).

## Running it

### Stop and resume

`Ctrl+C` in the startup terminal. Temporary Runtime containers are removed;
Agent workspaces and conversations are kept.

- macOS state: `~/.volc-agent-launchpad/` · Linux: `.local/`
- Custom location: `LOCAL_POC_DATA_ROOT`

### Choose a container engine

```bash
CONTAINER_ENGINE=podman ARK_API_KEY=… ARK_MODEL=… npm run poc
```

Colima uses `CONTAINER_ENGINE=docker` because it exposes the Docker CLI. For a
clean Linux host see [rootless Podman](docs/LOCAL_POC.md#rootless-podman-on-linux).

### Docker Compose

```bash
./scripts/bootstrap-local.sh
```

Required in `.env`:

```dotenv
ARK_API_KEY=your-ark-api-key
ARK_MODEL=ep-your-endpoint-id
APP_AUTH_TOKEN=replace-with-at-least-24-random-characters
```

```bash
docker compose up --build     # http://localhost:3000
docker compose down           # stops without deleting Agent data
```

### Development

```bash
npm install
npm install --global @openai/codex@0.111.0
APP_DATA_DIR="$PWD/.data" \
AGENT_WORKSPACE_ROOT="$PWD/workspaces" \
CODEX_HOME="$PWD/codex-home" \
npm run dev
```

Web UI <http://localhost:5173> · API <http://localhost:3000>

> [!WARNING]
> **Do not `source .env` for a bare host run.** The committed `.env` is the
> *container* profile — it sets `APP_DATA_DIR=/app/data` and friends, which do
> not exist on a host, and the server exits with
> `ENOENT: … mkdir '/app'`. Export only the `ARK_*` keys and pass the three
> absolute paths above. Those same paths matter when seeding, or the seed writes
> to a different store than the server reads.

### npm scripts

| Script | Does |
|---|---|
| `npm run poc` | one-command local POC with a container Runtime |
| `npm run dev` | server + web in watch mode |
| `npm run check` | typecheck, then tests, then builds both workspaces |
| `npm run seed` | seed demo data through the production planner |
| `npm run verify:live` | verify a running deployment |

### Deployment

```bash
cp .env.example .env.production
./scripts/deploy-existing-ecs.sh .env.production
```

Terraform provisions VPC, subnet, security group, ECS and EIP:

```bash
cp deploy/volcengine/terraform.tfvars.example deploy/volcengine/terraform.tfvars
./scripts/deploy-volcengine.sh
```

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Configuration

**Base platform**

| Variable | Default | Purpose |
|---|---|---|
| `ARK_API_KEY` | required | Ark model API key |
| `ARK_MODEL` | required | Responses-capable endpoint or model ID |
| `ARK_BASE_URL` | Beijing v3 | Ark OpenAI-compatible API URL |
| `APP_AUTH_TOKEN` | empty on loopback | shared demo token; 24+ random chars remotely |
| `RUNTIME_PROVIDER` | `local-process` | `container` for disposable Runtime containers |
| `CODEX_SANDBOX_MODE` | `workspace-write` | Codex inner sandbox mode |
| `CODEX_TIMEOUT_MS` | `600000` | maximum duration of one turn |
| `GROUP_MAX_PARALLEL_NODES` | `4` | plan nodes of one task that may run at once; `1` = sequential |
| `LOCAL_POC_DATA_ROOT` | per-platform | local metadata, workspace and session directory |

**Memory — extraction**

| Variable | Default | Purpose |
|---|---|---|
| `MEMORY_ENABLED` | `true` | master switch; existing landed files are retained |
| `MEMORY_EXTRACTOR` | `ark` | `ark` \| `fake` \| `off`; falls back to `fake` when `ARK_*` is unusable |
| `MEMORY_EXTRACT_TIMEOUT_MS` | `30000` | consolidator model-call timeout (`.env.example` raises it to `120000`) |
| `REVIEW_ALL_SKILLS` | `false` | force every note through human review |

**Memory — segmentation**

| Variable | Default | Purpose |
|---|---|---|
| `MEMORY_TOPIC_DRIFT_THRESHOLD` | `0.90` | JS-divergence above which the subject counts as changed |
| `MEMORY_SEGMENT_MAX_TASKS` | `8` | close a segment after this many tasks |
| `MEMORY_SEGMENT_MAX_CHARS` | `120000` | hard cap on transcript size |
| `MEMORY_SEGMENT_IDLE_MS` | `1800000` | close an untouched segment on the next group read |
| `MEMORY_NODE_DRIFT_THRESHOLD` | `0.55` | cosine drift above which the node buffer consolidates mid-DAG |
| `MEMORY_DRIFT_MODEL_DIR` | `data/drift-model` | GENERAL embedder for node drift; ships via LFS |

**Memory — recognition (routing)**

| Variable | Default | Purpose |
|---|---|---|
| `MEMORY_RECOGNIZER` | `sbert` | `sbert` \| `ark` \| `fake` \| `off`; sbert has **no** automatic fallback |
| `MEMORY_RECOGNITION_AGENT_THRESHOLD` | schema `0.35` — **use `0.72`** | similarity floor for routing to an Agent. `.env.example` sets `0.72`, the calibrated value for the shipped checkpoint |
| `MEMORY_RECOGNITION_SKILL_THRESHOLD` | `0.45` | similarity floor for matching an existing skill |
| `MEMORY_AUTO_GRANT_ENABLED` | `false` | must stay `false` until a reviewed holdout authorises auto-grant |
| `MEMORY_SBERT_PYTHON` | `python3` | interpreter for the bridge |
| `MEMORY_SBERT_MODEL_DIR` | `data/recognition/model` | checkpoint directory |
| `MEMORY_SBERT_BRIDGE` | `scripts/embed-recognizer.py` | inference bridge path |
| `MEMORY_EMBEDDING_TIMEOUT_MS` | `30000` | embedding call timeout |

## How the memory pipeline works

A note starts as extracted text with **no recipient**. Nine stages decide
whether it ever becomes memory in one Agent's workspace.

**1 · Segment closes.** The unit of consolidation is a *topic segment* — a run
of consecutive tasks on one subject. It closes on a topic shift, a size cap, an
idle sweep, or mid-DAG node drift. Only a closed, unflushed segment whose tasks
have all settled is processed.

**2 · Replay.** `SegmentBufferBuilder` reconstructs prompts, group messages,
node outputs, run ids, trace spans and context-injection metadata *from
persisted state*. There is no second live transcript store.

**3 · Extract.** One Ark call per segment, at most eight declarative notes. The
model emits **1-based short indices** for citations, never UUIDs; the server
resolves them to real run and span ids and drops bad or duplicate ones. If the
extractor times out or returns nothing durable, the segment produces no memory —
and the task outcome is untouched.

**4 · Choose recipients.** Recognition is the sole routing authority. It embeds
the note and every segment participant's profile, and takes everyone at or above
the agent threshold. If nobody clears it, it takes exactly one top scorer and
flags it as a **fallback**, which forces human review. A recognizer error means
the note is withheld — never guessed.

**5 · Choose the file.** Per recipient, it reads **only that Agent's own** skill
directory. At or above the skill threshold the note joins an existing
`SKILL.md`; otherwise it proposes a new skill, which also forces review. A key
that collides with an unrelated skill is withheld rather than implicitly merged.

**6 · Redact and quarantine.** Before review, and before any filesystem write.
Redaction covers bearer tokens, private keys, database URLs and env assignments.
Quarantine flags instruction override, hidden-prompt and exfiltration shapes. If
safety itself errors, the note is quarantined — it never fails open.

**7 · Human decides.** Review is required when the note is severe, redaction
fired, quarantine fired, routing used a fallback, any recipient needs a new
skill, or `REVIEW_ALL_SKILLS=true`. Actions: approve · edit · reject · revoke.
An edit may narrow or move recipients within the group; it can never widen
outside it, and that is enforced twice — when the edit is persisted, and again
at activation.

**8 · Land.** Severe notes become a managed block in `AGENTS.md`; normal notes a
managed block in a private `SKILL.md`. Placement **is** the grant.

**9 · Ledger.** Append-only, one record per note: granted to, withheld from with
a named reason, and the human decision.

### Execution details worth knowing

- **Ordering** is Kahn's algorithm tie-broken on the planner's own order — not a
  `createdAt` sort, which was correct only by accident because the planner
  stamps every node of a task with the same timestamp.
- **Locks are globs**, so string equality is not enough: `code/**` contains
  `code/apps/server/**`. Both reduce to a directory prefix and are compared for
  containment either way.
- **A failure blocks only its transitive descendants.** Sibling branches keep
  running, and a skipped node records *which* node blocked it.
- **Retries default to not retrying.** Timeouts, connection resets and non-zero
  exits are retried, capped at 2. A run that merely answered badly is not.
- **Every attempt is its own run row**, persisted before dispatch, so a restart
  resumes the count and two attempts read as two real runs in the audit.

## Validation

```bash
npm run check
```

```
server   22 files / 235 tests
web      12 files /  75 tests
build    both workspaces
```

```bash
./scripts/verify-codex-skills.sh   # Codex skill-discovery boundary · no API key
node scripts/node-drift-stats.mjs  # calibrate MEMORY_NODE_DRIFT_THRESHOLD
npm run verify:live                # verify a running deployment
```

Parallelism is tested with a probe that records **peak in-flight runs** —
counting cumulative requests cannot tell "ran together" from "ran one after the
other", and produced three false passes before the probe replaced it.

## Documentation map

| Read this | For |
|---|---|
| [`finaldocs/ARCHITECTURE.md`](finaldocs/ARCHITECTURE.md) | the full design and its reasoning |
| [`finaldocs/MEMORY_PIPELINE.md`](finaldocs/MEMORY_PIPELINE.md) | the pipeline contract, stage by stage |
| [`finaldocs/OPERATIONS.md`](finaldocs/OPERATIONS.md) | setup, configuration, verification |
| [`finaldocs/STATUS.md`](finaldocs/STATUS.md) | what is done and what is not |
| [`middlewaredoc/`](middlewaredoc/) | design decisions, milestones, diagram sources |
| [`manifest/MANIFEST_RECOGNITION.md`](manifest/MANIFEST_RECOGNITION.md) | recognizer calibration and the auto-grant policy |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) · [`docs/LOCAL_POC.md`](docs/LOCAL_POC.md) | deployment and local runtime |
| [`DEVPOST.md`](DEVPOST.md) | the submission write-up |
| [`README-ORIGINAL.md`](README-ORIGINAL.md) | the previous README, kept for reference |

## What we do not claim

- **We cannot prove a memory *fired* on a given run.** Codex emits no
  skill-invocation event, so the audit proves a memory was *available* to one
  Agent and *withheld* from another — not that the model used it.
- **Revocation takes effect on the next run.** Content already absorbed into a
  live resumed thread lingers until that thread resets.
- **Relevance is model-driven**, so it is not deterministically testable the way
  a lexical rule would be.
- **Redaction is pattern-based** and cannot catch every shape of secret. The
  quarantine heuristic is tuned for recall and backed by a human gate, not for
  precision.
- **Review records attribution, not authentication.** The platform is
  single-user with no identity system. The ledger records *who claims* to have
  approved.
- **OS-level isolation between Agents comes from the container, not from Codex.**
  On Docker Desktop for Mac the Linux Landlock sandbox is unavailable, so a
  prompt-injected Agent could in principle write into a sibling's directory.
  That does not weaken the governance claim — which is about which memory files
  *we* place — but we do not claim OS-enforced Agent sandboxing.
- **The JSON store is not a transaction database** for concurrent instances.

## License

See [LICENSE](LICENSE). Contributions: [CONTRIBUTING.md](CONTRIBUTING.md).
Security policy: [SECURITY.md](SECURITY.md).
