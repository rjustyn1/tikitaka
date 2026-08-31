# Volc Agent Launchpad

## Final Technical Documentation

Volc Agent Launchpad is a multi-Agent coding workspace with governed,
cross-Agent memory. Agents retain private Codex sessions and workspaces. Teams
can collaborate on a shared code directory, while reusable knowledge crosses
Agent boundaries only through a traceable review and landing pipeline.

This directory is the curated documentation set for the integrated system. It
supersedes the historical planning notes, per-person manifests, and component
technical designs as the preferred reading path. Historical documents remain in
the repository as implementation provenance.

## Read This First

| Document | Use it for |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Canonical design, component boundaries, data flow, trust model, and deployment topology. |
| [MEMORY_PIPELINE.md](MEMORY_PIPELINE.md) | Governed-memory contracts, note lifecycle, routing, safety, review, and landing semantics. |
| [OPERATIONS.md](OPERATIONS.md) | Local setup, Python SBERT runtime, configuration, deployment prerequisites, and verification. |
| [DEMO.md](DEMO.md) | A repeatable product demonstration, including review and revocation. |
| [STATUS.md](STATUS.md) | Implemented behavior, deliberate review gates, and operating limits. |

## Product In One Paragraph

The platform runs solo Agents and multi-Agent group tasks. A planner turns a
group task into a validated dependency graph, and the runtime executes its nodes
against a shared `./code` directory while preserving private Agent workspaces
and group-specific threads. When a topic segment closes, the memory pipeline
extracts durable notes with provenance, routes them using a recognizer, redacts
or quarantines unsafe content, records grants and withholdings, and lands only
approved knowledge inside recipient workspaces. A note is available to an
Agent only when the corresponding governed file exists in that Agent's private
workspace.

## Source Layout

```text
apps/
  server/                 Fastify API, runner, planner, memory pipeline
  web/                    React operator interface
scripts/                  Tracked operational utilities and SBERT bridge
scripts_ignored/          Local dataset generation and training tools
data/recognition/         Ignored local datasets, checkpoints, calibration, review queues
workspaces/               Ignored per-Agent private workspaces and shared task code
finaldocs/                This final documentation set
```

## Core Claims

- Group membership is explicit: a team has 2-12 unique Agents; display roles
  are labels, not access-control permissions.
- The planner owns task decomposition. It receives Agent descriptions and
  returns a validated DAG; invalid model output falls back to a deterministic
  sequential plan.
- The consolidator extracts reusable knowledge but does not select recipients.
  Recognition owns note-to-Agent routing.
- Safety and review run before landing. Automatic grants are disabled for local
  SBERT routing unless a human-approved calibration explicitly enables them.
- File placement is the memory availability boundary. The ledger proves what
  was granted, withheld, rejected, or revoked; it does not claim to prove that
  a model actually used a memory.

## Verification Baseline

The repository-wide verification command is:

```bash
npm run check
```

It runs TypeScript typechecks, server and web test suites, and production
builds. See [OPERATIONS.md](OPERATIONS.md) for the local SBERT bridge smoke
test.
