import { logger } from "../platform.js";
import { chatStore } from "./chat-store.js";
import { configStore } from "./config-store.js";
import { displayImageArtifactStore } from "./display-image-artifact-store.js";
import { generativeUiArtifactStore } from "./generative-ui-artifact-store.js";
import { llmClient } from "./llm-client.js";
import { piCompactionSessionStore } from "./pi-compaction-session-store.js";
import { piRuntimeEffectStore } from "./pi-runtime-effect-store.js";
import { subagentRunStore } from "./subagents/subagent-run-store.js";
import { workspaceMutationGate } from "./workspace-mutation-gate.js";
import { workspaceOperationRegistry } from "./workspace-operation-registry.js";
import { createChatApplicationService } from "./chat-application-service.js";
import { memoryStore } from "./memory-store-main.js";

export const chatApplicationService = createChatApplicationService({
  chatStore,
  configStore,
  llmClient,
  displayImageArtifactStore,
  generativeUiArtifactStore,
  workspaceMutationGate,
  workspaceOperationRegistry,
  subagentRunStore,
  piRuntimeEffectStore,
  piCompactionSessionStore,
  memoryStore,
  logError: (area, message, error) => logger.error(area, message, error),
});
