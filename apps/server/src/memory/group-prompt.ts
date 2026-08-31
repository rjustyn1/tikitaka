/**
 * Context packets and turn prompts -- `middlewaredoc/GROUP-CHAT-DESIGN.md`.
 *
 * Pure functions, so what each Agent was shown is unit-testable without a
 * runner. Nothing here calls Codex or touches the store.
 */

import type { GroupMessage, GroupPlanNode, MemoryNote } from "../types.js";
import type { ChainNodeTemplate } from "./group-chain.js";

export interface ContextPacket {
  fromSeqExclusive: number;
  toSeqInclusive: number;
  injectedMessageIds: string[];
  injectedDependencyNodeIds: string[];
  /**
   * IMPORTANT -- in the v1 sequential chain this means ALREADY SEEN BY THIS
   * AGENT (transcript dedupe), NOT denied by policy. Governance withholding
   * lives in the grant ledger, where a `withheld` decision carries a named
   * reason. Conflating the two would misrepresent the system (A4, `DEMO.md`).
   */
  withheldMessageIds: string[];
}

export interface ContextPacketInput {
  node: GroupPlanNode;
  /** Every message in the group, any order. */
  messages: readonly GroupMessage[];
  lastSeenSeq: number;
  /** Transcript upper bound, captured when this node became runnable. */
  contextSnapshotSeq: number;
}

export function buildContextPacket(input: ContextPacketInput): ContextPacket {
  const ordered = [...input.messages].sort((left, right) => left.seq - right.seq);
  const injected = ordered.filter(
    (message) =>
      message.seq > input.lastSeenSeq &&
      message.seq <= input.contextSnapshotSeq,
  );
  const withheld = ordered.filter(
    (message) =>
      message.seq <= input.lastSeenSeq ||
      message.seq > input.contextSnapshotSeq,
  );
  return {
    fromSeqExclusive: input.lastSeenSeq,
    toSeqInclusive: input.contextSnapshotSeq,
    injectedMessageIds: injected.map((message) => message.id),
    injectedDependencyNodeIds: [...input.node.dependsOn],
    withheldMessageIds: withheld.map((message) => message.id),
  };
}

export interface TurnPromptInput {
  taskPrompt: string;
  node: GroupPlanNode;
  /**
   * @deprecated The node carries its own planner-written instruction now. Only
   * consulted when `node.instruction` is empty, which is true for plan rows
   * persisted before the planner landed.
   */
  template?: ChainNodeTemplate | undefined;
  agentName: string;
  agentDescription: string;
  /** Messages selected by the context packet, in seq order. */
  injectedMessages: readonly GroupMessage[];
  /** Completed dependency outputs, in chain order. */
  dependencyOutputs: ReadonlyArray<{ nodeRole: string; output: string }>;
  agentNames: ReadonlyMap<string, string>;
  /** Active notes already landed in this Agent's private workspace. */
  governedMemory: readonly Pick<
    MemoryNote,
    "content" | "description" | "severity"
  >[];
}

function speakerLabel(
  message: GroupMessage,
  agentNames: ReadonlyMap<string, string>,
): string {
  if (message.speakerType === "human") return "User";
  if (!message.speakerAgentId) return "Agent";
  return agentNames.get(message.speakerAgentId) ?? "Agent";
}

/**
 * The per-turn prompt.
 *
 * The active node role is injected here, not into `AGENTS.md`: a resumed Codex
 * thread may not re-read a changed instructions file, so identity for THIS turn
 * has to travel with the prompt. The stable Agent identity is never
 * overwritten -- an Agent is given a node role, it does not become a different
 * Agent.
 */
export function buildTurnPrompt(input: TurnPromptInput): string {
  const sections: string[] = [
    "[Group task]",
    input.taskPrompt,
    "",
    "[Plan node]",
    "Node: " + input.node.nodeRole,
    "Depends on: " +
      (input.dependencyOutputs.length > 0
        ? input.dependencyOutputs.map((item) => item.nodeRole).join(", ")
        : "nothing - this is the first node"),
    "File ownership: " +
      (input.node.readOnly
        ? "read-only for this turn"
        : input.node.fileOwnershipHints.join(", ") || "none declared"),
    "Runtime locks: " +
      (input.node.runtimeLocks.join(", ") || "none"),
    "Expected output: " +
      (input.node.expectedOutput || "a written result for this step"),
    "",
  ];

  if (input.injectedMessages.length > 0) {
    sections.push("[New group messages since your last turn]");
    for (const message of input.injectedMessages) {
      sections.push(
        speakerLabel(message, input.agentNames) + ":",
        message.content,
        "",
      );
    }
  }

  if (input.dependencyOutputs.length > 0) {
    sections.push("[Relevant dependency outputs]");
    for (const dependency of input.dependencyOutputs) {
      sections.push(dependency.nodeRole + ":", dependency.output, "");
    }
  }

  if (input.governedMemory.length > 0) {
    sections.push("[Your governed memory]");
    for (const note of input.governedMemory) {
      sections.push(
        note.severity === "severe"
          ? "- (always apply) " + note.content
          : "- (apply when: " + note.description + ") " + note.content,
      );
    }
    sections.push("");
  }

  sections.push(
    "[Your identity for this turn]",
    "You are " + input.agentName + ".",
    "What you do: " + (input.agentDescription || "general engineering work") + ".",
    "Node role: " + input.node.nodeRole + ".",
    "",
    "[Shared code]",
    "The group's shared codebase is at ./code inside this workspace. Edit the",
    "project there. Everything outside ./code is your own private workspace.",
    "",
    "[Your turn]",
    // The planner wrote this per node, so it is the authority. The template is
    // only a fallback for rows persisted before instructions were stored.
    input.node.instruction.trim() ||
      input.template?.instruction ||
      "Complete this plan node using what you do best.",
    "Respect the file ownership above and preserve other Agents' work. Stay",
    "within your own Agent identity; do not answer as another Agent.",
    "",
  );

  return sections.join("\n").trimEnd() + "\n";
}

/** The planner-written group-task charter for one member's private AGENTS.md. */
export function buildGroupTaskCharter(input: {
  groupName: string;
  taskPrompt: string;
  roster: ReadonlyArray<{ name: string; description: string }>;
}): string {
  return [
    "This Agent is participating in the " + input.groupName + " group task.",
    "",
    "Task: " + input.taskPrompt,
    "",
    "Shared code lives under ./code. Governed memory and skills stay in this",
    "private workspace root and are never written into shared code.",
    "",
    "Members:",
    ...input.roster.map(
      (member) =>
        "  " + member.name + " - " + (member.description || "general engineering work"),
    ),
    "",
    "Rules:",
    "  Follow the active Agent identity supplied in the turn prompt.",
    "  Respect the plan node's file ownership hints.",
    "  Preserve other Agents' work.",
    "  Do not expose secrets across Agent boundaries.",
  ].join("\n");
}
