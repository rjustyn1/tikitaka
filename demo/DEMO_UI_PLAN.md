# Middleware Demo UI Plan

## Purpose

The demo should prove that the middleware governs durable knowledge without
interrupting multi-Agent coding. The story is not that an Agent "remembers";
it is that completed work becomes a proposed, scoped, auditable, persistent
change only after a human approves it.

## Current Demo Surfaces

- **Conversation and Plan** show one team solving one task with a validated
  multi-Agent execution graph.
- **Workspace explorer** replaces the former top-right live terminal. Its
  **Shared code** tab shows the group-shared `./code` tree that all members can
  edit. Its **Agent skills** tab lets the presenter select a group member and
  inspect only that member's `AGENTS.md` and `.agents/skills/` artefacts. It is
  read-only and never exposes arbitrary private files, credentials, or another
  Agent's workspace outside the selected team member.
- **Review** shows proposed notes, safety state, routing, and approval controls.
- **Workspaces, Ledger, and Proof** show the landed file, grant/withholding
  evidence, and fresh-thread behaviour after approval.

## Primary Video Flow

1. **Set the scene — 0:00–0:15**
   - Introduce a team with distinct Backend, Frontend, and Security roles.
   - Point to the Shared code tab: all Agents collaborate on this tree.
   - Switch to Agent skills, select one member, and show that durable
     `AGENTS.md` instructions and approved skills are attached to that Agent,
     not copied into shared code or another member's workspace.

2. **Show real collaboration — 0:15–0:35**
   - Start a task that produces a reusable constraint, for example expired
     token rejection and request validation.
   - Open Plan to show ownership and dependencies.
   - Refresh the shared-code explorer to show the source files created by the
     team. Do not use a terminal as the visual proof of work.

3. **Show non-blocking middleware — 0:35–0:45**
   - Submit a clearly unrelated prompt or wait for the idle closure.
   - Explain that the prior segment is consolidated in the background while
     Agents can continue the new task. A landed note can affect later fresh
     turns; it does not alter a turn already running.

4. **Review a governed change — 0:45–1:05**
   - Open Review and show the candidate's evidence, safety state, rationale,
     recipient routing, and withheld members.
   - Edit if useful, then approve. Keep auto-grants disabled for the demo.

5. **Prove placement and denial — 1:05–1:25**
   - Open Workspaces to show the target Agent has a landed artifact while the
     withheld Agent does not.
   - Open Ledger to show both the grant and withholding records.
   - Use Proof to run the same fresh-thread prompt for a holder and a withheld
     Agent. The contrast is filesystem-backed, not an instruction asking an
     Agent to pretend it does not know something.

6. **Close the loop — 1:25–1:35**
   - Revoke the note.
   - Show the removed artifact and revoked ledger entry.
   - State that revocation governs future runs; it cannot erase context already
     loaded into a running model.

## Next UI Improvement: Governed Memory Diff

The highest-value missing visual is a review-time diff for persistent memory.
For a severe note, Review should offer **Preview persistent change**:

```text
AGENTS.md · Backend Agent · governed memory section only

Current                              Proposed after approval
────────────────────────             ─────────────────────────────────
No matching managed block            + API authentication constraint
                                     + Reject expired access tokens
                                     + Validate request payloads

Withheld: Frontend Agent             [Reject] [Edit] [Approve change]
```

Requirements for this feature:

- Render a GitHub-like red/green diff, with the exact destination and recipient.
- Preview only the note's managed memory block. Do **not** expose an entire
  private `AGENTS.md` through the UI API; the app records reviewer attribution,
  not authenticated administrator identity.
- Reuse the same component for normal `SKILL.md` memory and for revoke, where
  the managed block is removed.
- After approval, replace the proposal state with **Applied**, the landed file
  path, its ledger decision, and a link to the relevant proof view.

## Demo Guardrails

- `MEMORY_AUTO_GRANT_ENABLED=false` throughout the video.
- Use fake, clearly labelled tokens only when demonstrating redaction or
  quarantine; never place a real credential in the demo.
- Keep the shared-code explorer read-only and scoped to the group code tree.
- Show a fresh thread for proof, because an already-running/resumed Codex
  thread is not guaranteed to reread changed `AGENTS.md` or skill files.
