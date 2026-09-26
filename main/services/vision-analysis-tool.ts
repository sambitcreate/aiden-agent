import { randomUUID } from "node:crypto";
import { createVisionAnalysisTool as createCore, type VisionAnalysisToolDependencies } from "./vision-analysis-tool-core.js";
export { INSPECT_IMAGE_TOOL_NAME } from "./vision-analysis-tool-core.js";
export type { VisionAnalysisAuthority } from "./vision-analysis-tool-core.js";

export function createVisionAnalysisTool(input: Parameters<typeof createCore>[0], dependencies: Partial<VisionAnalysisToolDependencies> = {}) {
  return createCore(input, {
    resolveRuntime: dependencies.resolveRuntime ?? (async (providerId, modelId, signal) => {
      const { resolveBotModelRuntime } = await import("./model-runtime.js");
      // One-shot tool call; a fresh id still satisfies gateway per-request
      // attribution.
      return resolveBotModelRuntime(providerId, modelId, signal, randomUUID());
    }),
    recordUsage: dependencies.recordUsage ?? (async (record) => {
      const { usageStore } = await import("./usage-store.js");
      await usageStore.record(record);
    }),
  });
}
