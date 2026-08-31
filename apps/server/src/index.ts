import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import {
  isArkConfigured,
  loadConfig,
  loadLocalEnvironment,
  writeCodexConfig,
} from "./config.js";
import { createExtractorClient } from "./memory/extractor-client.js";
import { createMemoryPipeline } from "./memory/pipeline.js";
import { FakePlannerClient, TaskPlanner } from "./memory/planner.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import {
  assertNoGovernedMemoryInCodexHome,
  WorkspaceManager,
} from "./workspace.js";

loadLocalEnvironment();
const config = loadConfig();
await writeCodexConfig(config);
await assertNoGovernedMemoryInCodexHome(config.codexHome);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
// A2 - the runtime decides how shared group code is exposed as ./code.
const workspaces = new WorkspaceManager(
  config.workspaceRoot,
  config.runtimeProvider,
);
const runner = createRunner(config);

/**
 * MEMORY_EXTRACTOR defaults to "ark", which means both the planner and memory
 * extraction make a real model call. Without a usable key those calls fail on
 * EVERY task -- and both components fail soft, so the symptom is not an error:
 * the planner quietly returns its fallback (a plain sequential chain, no
 * branching) and extraction quietly returns zero notes. That reads exactly like
 * "the DAG does not work" while nothing is actually broken.
 *
 * So decide it ONCE, here, out loud, instead of rediscovering it per task.
 */
const arkReady = isArkConfigured(config);
const effectiveExtractor =
  config.memoryExtractor === "ark" && !arkReady ? "fake" : config.memoryExtractor;

if (config.nodeEnv !== "test" && effectiveExtractor !== config.memoryExtractor) {
  console.warn(
    [
      "",
      "  MEMORY_EXTRACTOR=ark, but ARK_API_KEY/ARK_MODEL are not usable.",
      "  Falling back to the OFFLINE planner and extractor so the app still runs.",
      "",
      "  What this changes:",
      "    - plans come from FakePlannerClient (deterministic, ignores the task text)",
      "    - governed memory notes are the canned demo notes, not real extraction",
      "",
      "  Set ARK_API_KEY and ARK_MODEL for the real thing, or set",
      "  MEMORY_EXTRACTOR=fake to select this offline mode deliberately.",
      "",
    ].join("\n"),
  );
}

// W1 + W2 - the real governed-memory pipeline.
const memoryPipeline = createMemoryPipeline(
  store,
  { ...config, memoryExtractor: effectiveExtractor },
  {
    // Model-backed routing may propose recipients, but it cannot auto-grant
    // until a reviewed holdout explicitly authorizes it. That applies to any
    // real recognizer, not just the local checkpoint: MEMORY_AUTO_GRANT_ENABLED
    // reads as "nothing auto-grants", so scoping it to sbert alone would leave
    // ark silently auto-granting with the flag off.
    //
    // "fake" is exempt on purpose -- it is the deterministic offline stub used
    // by tests and unprovisioned checkouts, and forcing review there would park
    // every seeded demo note behind a human.
    reviewAllSkills:
      config.reviewAllSkills ||
      ((config.memoryRecognizer === "sbert" || config.memoryRecognizer === "ark") &&
        !config.memoryAutoGrantEnabled),
  },
);
const planner = new TaskPlanner(
  effectiveExtractor === "ark"
    ? createExtractorClient(config)
    : new FakePlannerClient(),
  config.memoryExtractTimeoutMs,
  (reason) => {
    if (config.nodeEnv !== "test") {
      console.warn("[planner] rejected a plan; using fallback: " + reason);
    }
  },
);
const service = new AgentService(
  config,
  store,
  workspaces,
  runner,
  memoryPipeline,
  planner,
);
await service.initialize();

const app = await createApp(config, service);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
