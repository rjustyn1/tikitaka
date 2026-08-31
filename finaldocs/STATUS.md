# Implementation Status And Boundaries

## Integrated Capabilities

| Area | Current state |
| --- | --- |
| Agent lifecycle | Implemented: create, edit, start, stop, delete, message, run, trace, and persistent private workspaces. |
| Group membership | Implemented: 2-8 unique Agents with free-form display roles. |
| Group planning | Implemented: model-assisted planner, full validation, deterministic fallback, persisted node instructions and dependencies. |
| DAG execution | Implemented: dependency-aware scheduling, bounded parallelism, Agent leases, runtime locks, context injection, cancellation, and resume. |
| Shared code | Implemented: per-group shared code exposed as ./code, persisting across tasks, while Agent memory remains private. |
| Topic segmentation | Implemented: topic drift, task and character cap, idle closure, segment-scoped buffering and consolidation. |
| Extraction | Implemented: Ark, fake, and off modes; provenance indices resolve to persisted runs and spans. |
| Recognition | Implemented: local SBERT, Ark, fake, and off modes; Agent and private-skill matching. |
| Safety | Implemented: secret-pattern redaction, quarantine heuristics, review escalation. |
| Review and landing | Implemented: approve, edit, reject, revoke, managed workspace placement, and preservation of memory blocks. |
| Ledger and proof | Implemented: grants, withholdings, rejections, revocations, landed-file records, and UI views. |
| Web UI | Implemented: Agent workspace plus Teams conversation, plan, context, review, ledger, workspace, proof, and history surfaces. |

## Deliberately Gated

### Automatic SBERT Grants

The local SBERT path is integrated, but automatic granting remains disabled by
default with MEMORY_AUTO_GRANT_ENABLED=false. When SBERT is selected, startup
forces review-first behavior unless that flag is explicitly enabled.

The current model calibration is synthetic-data iteration evidence. It is not
authorization for automatic production grants. Promotion requires an independent
human-reviewed holdout, recalibration against it, a documented false-grant target
result, and a named approver.

### Real Model-Backed Planning And Extraction

MEMORY_EXTRACTOR=ark is the default. If Ark configuration is unusable at startup,
the system intentionally chooses the offline fake planner and extractor. That
means a group task remains demonstrable, but plans and notes are deterministic
fixtures rather than model-derived output.

## Known Operating Limits

- Single-user proof of concept: reviewer names are recorded but are not an
  identity or authorization system.
- JSON persistence: suitable for local demos and a single writer, not a
  production multi-instance database.
- Safety heuristics: pattern-based and review-backed, not complete secret or
  prompt-injection detection.
- Model use: the filesystem and ledger prove availability, not that an Agent
  actually invoked or followed a skill.
- Runtime isolation: the middleware controls its own placement behavior. A
  hostile or compromised runtime still requires container or host sandboxing and
  deployment hardening outside this application.
- Local SBERT: model artifacts and Python environment are machine or deployment
  dependencies; they are not created or downloaded automatically at runtime.

## Recommended Production Steps

1. Replace JsonStore with transactional database persistence and a durable queue
   for long-running task execution.
2. Add authenticated users, reviewer identity, role-based authorization, and
   immutable audit storage.
3. Package the local SBERT environment with a lockfile and an explicit image
   build step; pin and attest the model artifact.
4. Establish a human-labeled evaluation set and model-promotion policy before
   enabling automatic grants.
5. Expand redaction and quarantine into a tested policy service with telemetry,
   review sampling, and incident workflows.
6. Add production observability, rate limits, retention controls, backup, and
   multi-tenant workspace isolation if the architecture evolves beyond a
   single-user deployment.

## Documentation Provenance

Historical documents under middlewaredoc/, manifest/, and TODO_Instructions/
explain how the integrated system was assembled. They may retain superseded task
assignments, interim defaults, or implementation handoffs. Use finaldocs/ for
the final architecture and operations story; use source code and tests as the
executable contract.
