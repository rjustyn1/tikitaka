import { describe, expect, it } from "vitest";
import { jsDivergence, scoreDrift, termDistribution } from "./topic-drift.js";

describe("termDistribution", () => {
  it("normalizes counts into a probability distribution", () => {
    const dist = termDistribution("upload upload storage");
    const total = [...dist.values()].reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it("drops stopwords and short tokens so only content terms remain", () => {
    const dist = termDistribution("we will do the upload to a storage");
    expect([...dist.keys()].sort()).toEqual(["storag", "upload"]);
  });

  it("folds inflections onto one term so plural and singular agree", () => {
    const dist = termDistribution("uploads uploading upload");
    expect(dist.size).toBe(1);
    expect(dist.get("upload")).toBeCloseTo(1, 10);
  });

  it("returns an empty distribution for text with no content terms", () => {
    expect(termDistribution("to be or not to be").size).toBe(0);
  });
});

describe("jsDivergence", () => {
  it("is zero for a distribution against itself", () => {
    const dist = termDistribution("define the upload endpoint and storage flow");
    expect(jsDivergence(dist, dist)).toBeCloseTo(0, 10);
  });

  it("is one for distributions that share no terms", () => {
    const left = termDistribution("upload storage endpoint");
    const right = termDistribution("kubernetes cluster scheduler");
    expect(jsDivergence(left, right)).toBeCloseTo(1, 10);
  });

  it("is symmetric", () => {
    const left = termDistribution("upload storage endpoint contract");
    const right = termDistribution("upload validation auth boundary");
    expect(jsDivergence(left, right)).toBeCloseTo(jsDivergence(right, left), 10);
  });

  it("stays within [0, 1] when one side has terms the other lacks", () => {
    const left = termDistribution("upload storage");
    const right = termDistribution("upload storage retry backoff queue");
    const score = jsDivergence(left, right);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it("treats two empty distributions as identical rather than dividing by zero", () => {
    expect(jsDivergence(new Map(), new Map())).toBe(0);
  });
});

describe("scoreDrift", () => {
  // The pooled segment below carries well over MIN_EVIDENCE_TERMS content
  // terms (8), so these cases exercise scoring, not the evidence guard.
  const segment = [
    "Plan and implement an upload feature with storage and a public contract.",
    "Add resumable upload support to the storage endpoint we defined.",
  ];

  it("scores a continuation of the same subject below a shifted one", () => {
    const sameTopic = scoreDrift(segment, "Harden the upload storage contract.");
    const newTopic = scoreDrift(segment, "Configure Kubernetes cluster autoscaling.");
    expect(sameTopic).toBeLessThan(newTopic);
  });

  it("returns 0 before the segment carries enough evidence to judge", () => {
    expect(scoreDrift(["Fix it."], "Configure Kubernetes autoscaling.")).toBe(0);
  });

  it("returns 0 for an empty segment", () => {
    expect(scoreDrift([], "Configure Kubernetes autoscaling.")).toBe(0);
  });

  it("returns 0 when the incoming prompt has no content terms", () => {
    expect(scoreDrift(segment, "do it")).toBe(0);
  });
});

describe("role vocabulary regression", () => {
  // The failure this whole design exists to avoid. In GROUP-CHAT-DESIGN.md the
  // Backend and Security agents describe ONE topic in disjoint vocabulary, so a
  // scorer fed agent turns ranks that same-topic handoff as more divergent than
  // a genuine subject change. scoreDrift is fed human prompts only, which is
  // what keeps the ordering below correct.
  const backendTurn = "I will define POST /uploads and the storage flow.";
  const securityTurn = "I will review validation, auth, and secret boundaries.";

  it("confirms raw agent turns invert the ranking", () => {
    const sameTopicHandoff = jsDivergence(
      termDistribution(backendTurn),
      termDistribution(securityTurn),
    );
    const realTopicChange = jsDivergence(
      termDistribution(securityTurn),
      termDistribution("Now add rate limiting to the auth endpoints."),
    );
    expect(sameTopicHandoff).toBeGreaterThan(realTopicChange);
  });

  it("ranks correctly once scoring is restricted to human prompts", () => {
    const humanSegment = [
      "Plan and implement an upload feature with storage and a public contract.",
      "Add resumable upload support to the storage endpoint we defined.",
    ];
    const followUp = scoreDrift(humanSegment, "Review the upload validation and auth boundaries.");
    const shift = scoreDrift(humanSegment, "Now set up CI pipelines for the repository.");
    expect(followUp).toBeLessThan(shift);
  });
});
