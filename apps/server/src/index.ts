import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { createMemoryPipeline } from "./memory/pipeline.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
// A2 - the runtime decides how shared group code is exposed as ./code.
const workspaces = new WorkspaceManager(
  config.workspaceRoot,
  config.runtimeProvider,
);
const runner = createRunner(config);
// W1 + W2 - the real governed-memory pipeline, with Person 1 config.
// MEMORY_EXTRACTOR defaults to "fake", so nothing here reaches the network.
const memoryPipeline = createMemoryPipeline(store, config, {
  reviewAllSkills: config.reviewAllSkills,
});
const service = new AgentService(
  config,
  store,
  workspaces,
  runner,
  memoryPipeline,
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
