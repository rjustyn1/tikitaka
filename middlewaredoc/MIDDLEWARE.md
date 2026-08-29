# Governed Cross-Agent Memory

*What the problem is, where the trust boundary sits, and what enforces it.*

---

## The problem

Every agent on this platform runs in its own isolated Codex session. Anything an
agent works out — a decision, a constraint, a hard-won fact — dies with the run
that produced it. It never reaches the next agent that needs it.

Carryover *within* one agent is already free: each agent owns a private thread
that resumes every turn. Carryover *across* agents is impossible, because there
is no shared path between them.

The naive fix is to dump the whole group transcript into every agent. That leaks
scope, drifts roles, and grows the prompt without limit. It also answers the
wrong question. The gap is not "memory." It is **governed** memory:

- **capture** with provenance — which run, which spans,
- **decide** who may receive what,
- **land** it where the agent will actually use it,
- **prove** both the grant and the denial.

## What we built

A middleware layer that sits above a shared task — a group of agents working
toward one goal. When the task finishes, it captures what each agent produced,
distills it into targeted notes, decides which other agents should receive each
note, and writes those notes into the recipients' workspaces as memory the agent
loads on future runs. A human gates anything high-impact.

## The contribution

Observability tools answer *what did the agent do?* Memory products share one
user's context across their chats — every chat sees everything, with no way to
grant a memory to one agent while withholding it from another.

We answer a question nothing else does:

> **What did this agent know, what was it denied knowing, and why?**

## The trust boundary

What makes this governance rather than an LLM guessing at access control is a
clean split between two different kinds of question:

| | Enforced by | When | Nature |
|---|---|---|---|
| **Security** — *who may receive a memory* | **file placement** — we write the note into an agent's workspace, or we do not | write time | deterministic, hard, ours |
| **Relevance** — *when a memory applies* | **Codex-native skill matching** on the skill's `description` | read time | model-driven, soft, Codex's |

Security is a hard boundary we own. If a note was never written into an agent's
workspace, Codex **cannot** load it — the file is not there. Relevance is the
soft part, and we hand it to Codex's own matcher rather than reinventing it.

**This is verified, not assumed.** Against the pinned runtime
(`@openai/codex@0.111.0`): a skill written to `<workspace>/.agents/skills/` is
discovered with `scope: "repo"`; discovery does not walk up to parent
directories; and a workspace with no skill files sees **none**. Reproduce it
yourself with `scripts/verify-codex-skills.sh` — it needs no API key.

## The enforcement point

Exactly one module writes governed memory into a workspace: the landing service.
A note reaches an agent **if and only if** landing wrote a file there.

```
severe note  ->  <workspace>/AGENTS.md              always in context
normal note  ->  <workspace>/.agents/skills/…/SKILL.md   loaded when relevant
```

Because there is one choke point, the live grant state is not a database claim —
it is the set of files on disk, inspectable at any moment. Revoking a memory
means deleting the file.

## The audit

A write-time ledger records, per note: who it was granted to, **who it was
withheld from and why**, and the human decision. The withheld list with a named
reason is the part nothing else shows.

## What we do not claim

- **We cannot prove a memory *fired* on a given run.** Codex emits no
  skill-invocation event, so the audit proves a memory was *available* to one
  agent and *withheld* from another — not that the model used it.
- **Revocation takes effect on the next run.** Content already absorbed into a
  live resumed thread lingers until that thread resets.
- **Relevance is model-driven**, so it is not deterministically testable the way
  a lexical rule would be.
- **Redaction is pattern-based** and cannot catch every shape of secret. The
  quarantine heuristic is tuned for recall and backed by a human gate, not for
  precision.
- **Review records attribution, not authentication.** The platform is
  single-user with no identity system. The ledger records *who claims* to have
  approved. Claiming otherwise would be a false security claim.
- **OS-level isolation between agents comes from the container, not from Codex.**
  On Docker Desktop for Mac the Linux Landlock sandbox is unavailable, so a
  prompt-injected agent could in principle write into a sibling's directory. This
  does not weaken the governance claim — that is about which memory files *we*
  place — but we do not claim OS-enforced agent sandboxing.

## Where to read more

`ARCHITECTURE.md` for the full design and the reasoning. `SPEC.md` for the
contracts. `DECISIONS.md` for what was decided and the evidence behind it.
