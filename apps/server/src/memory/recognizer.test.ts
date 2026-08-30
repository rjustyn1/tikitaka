import { describe, expect, it } from "vitest";
import {
  cosineSimilarity,
  Recognizer,
  SbertEmbeddingClient,
  type EmbeddingClient,
  type RecognizerAgent,
  type SkillProfile,
} from "./recognizer.js";

const AGENTS: RecognizerAgent[] = [
  { id: "backend", name: "Backend", description: "API server", instructions: "Owns APIs" },
  { id: "qa", name: "QA", description: "Tests", instructions: "Owns verification" },
  { id: "frontend", name: "Frontend", description: "Browser UI", instructions: "Owns screens" },
];

class TableEmbeddingClient implements EmbeddingClient {
  calls = 0;

  async embed(text: string): Promise<number[]> {
    this.calls += 1;
    if (text === "API note") return [1, 0];
    if (text === "weak note") return [1, 0];
    if (text === "skill note") return [1, 0];
    if (text === "new topic") return [1, 1];
    if (text.startsWith("Backend")) return [1, 0];
    if (text.startsWith("QA")) return [0.8, 0.6];
    if (text.startsWith("Frontend")) return [0, 1];
    if (text.startsWith("API skill")) return [1, 0];
    if (text.startsWith("UI skill")) return [0, 1];
    return [0, 1];
  }
}

describe("cosineSimilarity", () => {
  it("returns zero for empty, incompatible, or invalid vectors", () => {
    expect(cosineSimilarity([], [1])).toBe(0);
    expect(cosineSimilarity([1], [1, 2])).toBe(0);
    expect(cosineSimilarity([Number.NaN], [1])).toBe(0);
  });
});

describe("Recognizer", () => {
  it("delegates local SBERT embedding through the injected runner", async () => {
    const client = new SbertEmbeddingClient(
      {
        pythonPath: "/tmp/python",
        bridgePath: "/tmp/embed.py",
        modelPath: "/tmp/model",
      },
      async (config, text) => {
        expect(config.modelPath).toBe("/tmp/model");
        expect(text).toBe("API note");
        return [0.25, 0.75];
      },
    );

    await expect(client.embed("API note")).resolves.toEqual([0.25, 0.75]);
  });

  it("keeps every Agent above the threshold", async () => {
    const recognizer = new Recognizer(new TableEmbeddingClient(), {
      agentThreshold: 0.75,
    });

    const result = await recognizer.recognizeAgents("API note", AGENTS);

    expect(result.matches.map((match) => match.agentId)).toEqual(["backend", "qa"]);
    expect(result.matches.every((match) => match.matchKind === "threshold")).toBe(true);
  });

  it("uses exactly one best-guess fallback when nothing clears the threshold", async () => {
    const recognizer = new Recognizer(new TableEmbeddingClient(), {
      agentThreshold: 1.01,
    });

    const result = await recognizer.recognizeAgents("weak note", AGENTS);

    expect(result.matches).toEqual([
      { agentId: "backend", score: 1, matchKind: "fallback" },
    ]);
  });

  it("caches profile embeddings and refreshes them when profile text changes", async () => {
    const client = new TableEmbeddingClient();
    const recognizer = new Recognizer(client);

    await recognizer.recognizeAgents("API note", [AGENTS[0]!]);
    await recognizer.recognizeAgents("API note", [AGENTS[0]!]);
    expect(client.calls).toBe(3);

    await recognizer.recognizeAgents("API note", [
      { ...AGENTS[0]!, description: "Changed API server" },
    ]);
    expect(client.calls).toBe(5);
  });

  it("selects one skill for one Agent or proposes a new skill", async () => {
    const recognizer = new Recognizer(new TableEmbeddingClient(), {
      skillThreshold: 0.8,
    });
    const skills: SkillProfile[] = [
      { skillKey: "api", name: "API skill", description: "Server endpoints" },
      { skillKey: "ui", name: "UI skill", description: "Browser screens" },
    ];

    const existing = await recognizer.recognizeSkill("skill note", skills);
    expect(existing).toMatchObject({ kind: "existing", skill: skills[0], matchKind: "threshold" });

    const proposed = await recognizer.recognizeSkill("new topic", skills);
    expect(proposed.kind).toBe("new-skill");
    expect(proposed).toMatchObject({ suggestedDescription: "new topic" });
  });
});
