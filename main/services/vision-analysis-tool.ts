import { createVisionAnalysisTool as createCore, type VisionAnalysisToolDependencies } from "./vision-analysis-tool-core.js";
export { INSPECT_IMAGE_TOOL_NAME } from "./vision-analysis-tool-core.js";
export type { VisionAnalysisAuthority } from "./vision-analysis-tool-core.js";

export function createVisionAnalysisTool(input: Parameters<typeof createCore>[0], dependencies: Partial<VisionAnalysisToolDependencies> = {}) {
  return createCore(input, {
    resolveRuntime: dependencies.resolveRuntime ?? (async (providerId, modelId, signal) => {
      const { resolveBotModelRuntime } = await import("./model-runtime.js");
      return resolveBotModelRuntime(providerId, modelId, signal);
    }),
    recordUsage: dependencies.recordUsage ?? (async (record) => {
      const { usageStore } = await import("./usage-store.js");
      await usageStore.record(record);
    }),
  });
}
