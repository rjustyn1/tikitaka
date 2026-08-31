# Demo Guide

## Goal

Demonstrate that a team can collaborate on a coding task while reusable knowledge
crosses Agent boundaries only through governed, visible, and revocable memory
placement.

The strongest live story is not "the model remembered something." It is:

1. A planner creates a task-specific multi-Agent execution graph.
2. Agents work from private workspaces against one shared code tree.
3. The system captures evidence and creates a reviewable memory note.
4. An operator approves or rejects it.
5. The destination workspace and ledger prove who did and did not receive it.
6. Revocation removes the placement.

## Before The Demo

1. Run npm run check.
2. Start the application with the intended runtime configuration.
3. Use at least two ready Agents with distinct, meaningful descriptions. A useful
   pair is:
   - Backend Agent: API validation, storage, and error handling.
   - Frontend Agent: React interactions, forms, and user-visible states.
4. Create a team containing both Agents. The group UI requires 2-12 unique
   Agents.
5. For a predictable no-network demo, use MEMORY_EXTRACTOR=fake and either
   MEMORY_RECOGNIZER=fake or a provisioned local SBERT checkpoint. Keep
   MEMORY_AUTO_GRANT_ENABLED=false.
6. If showing local SBERT, run the bridge smoke test from
   [OPERATIONS.md](OPERATIONS.md) first.

## Main Walkthrough

### 1. Introduce The Team

Open Teams and show the two Agent descriptions. Explain that labels are for the
operator; the planner uses descriptions to choose work for each task. Point out
the separate private workspace concept and the shared ./code directory available
during group execution.

### 2. Start A Group Task

Use a task that produces a reusable engineering constraint:

```text
Build a small task API and React form. The API must reject expired access
tokens, validate request payloads, and return clear errors. Add tests for the
validation paths.
```

Start the task in the group conversation. Open the Plan view and show the
planner-created nodes, their instructions, dependencies, and expected output.
The graph may select a subset of the team or use parallel branches when their
dependencies and runtime locks permit it.

### 3. Show Execution Evidence

While the task runs, show the live terminal or trace panel. Then open:

- Context to inspect recorded context injections.
- The group timeline to show human and Agent messages.
- Plan-node outputs to show the durable material the segment buffer will use.

This establishes that memory comes from persisted task evidence rather than a
free-floating global chat history.

### 4. Close The Topic Segment

Memory consolidates when a topic segment closes, not immediately after every
task. For a live demo, submit a clearly unrelated follow-up prompt or wait for
the configured idle window, then refresh the group or task view so the idle
sweep can close the earlier segment.

Explain that this gives the consolidator the complete context of a coherent topic
while limiting memory growth.

### 5. Review A Candidate Note

Open Review. Select a pending or quarantined note and show:

- Durable declarative content and severity.
- Source provenance.
- Recognition match kind and scores.
- Selected recipients and skill assignments.
- Redaction or quarantine reasons when present.

For the first demo, choose an approval path rather than trying to force an
automatic grant. SBERT routing remains review-first by default.

### 6. Approve And Prove Placement

Approve the note with the operator reviewer name. Open Workspaces and show the
landed artifact in the intended recipient workspace:

- A severe note appears as a managed block in AGENTS.md; or
- A normal note appears in a private .agents/skills/skill-key/SKILL.md.

Then open Ledger or Proof. Show the grant for the recipient and withholding
entries for non-recipients. The important distinction is that the system records
both who received the note and who did not.

### 7. Revoke It

Use the revoke action and give a reason. Return to Workspaces to show that the
note's managed block or skill placement was removed, then show the revoked ledger
record. State the precise behavior: revocation changes future runs; content
already in a live model context cannot be erased retroactively.

## Optional Safety Moment

If a candidate contains a fake bearer token, database URL, or prompt-override
phrase, show that the system redacts or quarantines it and requires a reviewer.
Do not use real secrets in a demo. The right message is that the checks are
defense-in-depth and review-backed, not perfect detection.

## Demo Recovery

| Symptom | Recovery |
| --- | --- |
| Planner shows a simple sequential plan | This is the deterministic fallback; check Ark extractor configuration if a model-generated DAG is required. |
| No notes appear | The segment may still be open. Close it with an unrelated task, a size cap, or idle sweep. Fake extraction can be used for a predictable demo. |
| SBERT warning at startup | Provision the local checkpoint and Python bridge, or select MEMORY_RECOGNIZER=fake deliberately. |
| Note is pending | This is expected in review-first operation. Approve it to demonstrate landing. |
| No auto-grant occurs | Expected while MEMORY_AUTO_GRANT_ENABLED=false; this is the safe demo setting. |
| Task node fails | Show the trace and explain that partial execution can preserve completed branches and potentially produce partial-segment memory. |

## Closing Line

"The system does not make every Agent remember everything. It turns completed
team work into bounded, provenance-backed knowledge, puts it only where it is
approved to be available, and leaves an auditable trail for both grants and
denials."

